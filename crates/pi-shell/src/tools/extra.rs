//! pi's extras that run command lines (`env`, `ifne`, `xargs`, `find
//! -exec`): the utility runs on the session's runtime like any extra
//! ([`crate::extras`]), and its [`CommandRunner`] hands each command to the
//! driver, which runs it in a subshell of the caller.
//!
//! As in pi, a command is looked up before it runs, so the utility reports
//! a missing or unexecutable command in its own words (`xargs: nope: No such
//! file or directory`, status 127): a builtin (an engine intrinsic, a tool or
//! an extra) runs through `command`, so shell functions never run, as in
//! pi's earlier shell; any other name is searched on the
//! command's own `PATH` (with environment changes applied; the C library's
//! default path without one) and runs by absolute path through `builtin
//! exec -a`, so the program sees the name it was asked for and no function
//! named `exec` runs instead. `command PROG` and `exec PROG` run PROG the
//! same way: those builtins run nothing before they `exec` it. Environment
//! changes (`env -i`, `-u`, `NAME=VALUE`) apply in the subshell before the
//! command, in order. The subshell starts with none of the caller's shell
//! functions, aliases or DEBUG, ERR and RETURN traps, with `xtrace` off and
//! every builtin enabled, as a program's children see none of the caller's
//! shell state ([`Script::as_program`]); what its command defines is its own.
//!
//! The subshell's stdin is what the utility asks for (the null device by
//! default; `env`'s own stdin is the caller's fd 0); stdout and stderr are the
//! caller's, which the utility writes to as well, so their output interleaves
//! in order. Each subshell carries the call's lineage label, so a signal to
//! the utility's job reaches its commands too. Externals replace their
//! subshell through `exec`, so their actual signal deaths reach the utility
//! as [`CommandStatus::Signaled`], distinct from an ordinary exit of `128+n`.
//! In-engine commands report [`CommandStatus::Exited`].
//!
//! An external the system refuses to `exec` because its command line is too
//! long (`E2BIG`, or `ENAMETOOLONG` for a line past `_POSIX_ARG_MAX` whose
//! paths fit) is the shell's diagnostic and status 126, unless the command
//! asked to hear of it ([`ShellCommand::too_long_as_error`]) and is a program
//! this callout `exec`s itself: then, on Unix, the shell prints nothing and
//! the utility gets the error, so `xargs` can retry with fewer arguments.
//! The same goes for the command of a wrapper the callout runs (`env`,
//! `ifne`, `nohup`, `timeout`: [`WRAPPERS`]), which has done nothing a retry
//! would repeat when it runs it and hands the refusal up
//! ([`CallOutcome::TooLong`]), as GNU's utilities retry a line whose wrapper
//! program the system refused (`env --env0-from` keeps it: it read a file).
//! Another builtin's own `exec` (`xargs eval '…; exec prog'`) stays the
//! shell's, since retrying would run what the builtin did before it again.
//! A command that asked to hear of every refusal
//! ([`ShellCommand::refusal_as_error`]: `env`, which reports a command it
//! cannot run in coreutils' words) gets any other refusal of its program's
//! `exec` the same way (`EACCES`, `ENOENT` of a `#!` interpreter,
//! `ENAMETOOLONG` of a path); `ENOEXEC` runs the file as a script, as
//! `execvp` does. xargs and find ask only for a line too long: any other
//! refusal is the shell's diagnostic and status 126.

use std::{
	ffi::OsStr,
	future::Future,
	io,
	path::{Path, PathBuf},
	pin::Pin,
	sync::{
		Arc,
		atomic::{AtomicI32, Ordering},
	},
	task::{Context, Poll, Waker},
};

use bstr::{BString, ByteSlice};
use pi_builtins::extras::{CommandRunner, CommandStatus, EnvChange, Fd, ShellCommand};
use tokio_util::sync::CancellationToken;

use super::{Child, ToolConfig, Turn};
use crate::{
	bash::{
		CallOutcome, ExecRefusal, IntrinsicId, Lineage, ModeId, RunId, RunStdio, Script, ShellApi,
		ToolCall, VprocSel,
	},
	extras::Done,
	sys::StdFile,
};

/// `execvp`'s search path when a command's environment has no `PATH`.
const DEFAULT_PATH: &str = if cfg!(any(target_os = "linux", target_os = "android")) {
	"/bin:/usr/bin"
} else {
	"/usr/bin:/bin"
};

/// How a command a utility asked for ended, back to the utility.
type Reply = flume::Sender<io::Result<CommandStatus>>;

/// A command the utility asked the driver to run.
struct Request {
	command: ShellCommand,
	program: Program,
	reply:   Reply,
}

/// What a requested command is, decided by the lookup before it is sent.
pub(super) enum Program {
	/// A builtin: runs through `command`.
	Builtin,
	/// A program at `path`: runs through `builtin exec -a`, in place of the
	/// first `skip` words of the command line. Those words are a builtin that
	/// runs nothing before it `exec`s the program ([`Lookup::wrapped`]), so a
	/// line the system refuses as too long reaches the utility as for the
	/// program alone.
	Path { path: PathBuf, skip: usize },
}

/// The builtins that have done nothing a retry would repeat when they run
/// their command, and hand a refusal of it as too long up to a caller that
/// asked ([`ToolCall::too_long_to_caller`], [`CallOutcome::TooLong`]): the
/// tools `nohup` and `timeout`, and the extras `env` (unless it read
/// `--env0-from`) and `ifne` (whose input is the null device in a callout).
/// GNU's utilities run them as programs, whose own `exec` the system
/// refuses, so the line is split there too.
const WRAPPERS: [&[u8]; 4] = [b"env", b"ifne", b"nohup", b"timeout"];

impl Program {
	/// Whether a refusal of the command `name` as too long can reach the
	/// one who asked: the generated `exec` of a program, or a wrapper's own
	/// command ([`WRAPPERS`]).
	pub(super) fn hands_up_too_long(&self, name: &[u8]) -> bool {
		match self {
			Self::Path { .. } => true,
			Self::Builtin => WRAPPERS.contains(&name),
		}
	}
}

/// The utility, once started.
struct Running {
	done:      Arc<Done>,
	cancel:    CancellationToken,
	requests:  flume::Receiver<Request>,
	env_names: Vec<BString>,
	/// The error of a refusal as too long the utility hands up
	/// (`pi_builtins`' `Invocation::too_long_to_caller`); zero until then.
	too_long:  Option<Arc<AtomicI32>>,
}

/// A call of an extra that runs command lines.
pub(super) struct Extra {
	/// Only the label: the lineage of every command's subshell.
	pub(super) child: Child,
	/// The call, until the utility starts.
	call:             Option<ToolCall>,
	running:          Option<Running>,
	/// The commands' subshells still running, with their replies.
	runs:             Vec<(RunId, Reply)>,
}

impl Extra {
	pub(super) fn new(call: ToolCall) -> Self {
		Self { child: Child::default(), call: Some(call), running: None, runs: Vec::new() }
	}

	pub(super) fn advance(
		&mut self,
		api: &mut ShellApi<'_, '_>,
		turn: &mut Turn<'_>,
	) -> Option<CallOutcome> {
		if let Some(call) = self.call.take() {
			let Some(runtime) = turn.config.runtime.clone() else {
				return Some(CallOutcome::Error("pi's extras need a runtime".into()));
			};
			self.child.label = turn.labels.fresh(api.lineage().label);
			let (requests, received) = flume::unbounded();
			let cancel = CancellationToken::new();
			let mut invocation = crate::extras::invocation(
				&call.argv,
				&call.env,
				call.cwd.as_bstr(),
				&call.stdio,
				&call.extra_fds,
				call.umask,
				turn.config,
			);
			invocation.cancel = Some(cancel.clone());
			let too_long = call.too_long_to_caller.then(|| Arc::new(AtomicI32::new(0)));
			invocation.too_long_to_caller.clone_from(&too_long);
			let lookup = Lookup {
				path:   invocation.env.get("PATH").cloned(),
				cwd:    invocation.cwd.clone(),
				config: turn.config.clone(),
			};
			invocation.commands =
				Some(Box::new(Runner { requests, waker: turn.waker.clone(), lookup }));
			let done = crate::extras::spawn(&runtime, invocation);
			let env_names = call
				.env
				.iter()
				.map(|(name, _)| BString::from(name))
				.collect();
			self.running = Some(Running { done, cancel, requests: received, env_names, too_long });
		}
		let running = self.running.as_ref()?;
		while let Ok(Request { command, program, reply }) = running.requests.try_recv() {
			let lineage = Lineage { label: self.child.label, detached: false };
			let run = api.run_subshell_in(script(command, &program, &running.env_names), lineage);
			self.runs.push((run, reply));
		}
		match running.done.poll(&Context::from_waker(turn.waker)) {
			// The utility waits for every command it started; one whose
			// reply nobody awaits any more still ends before the call does.
			Poll::Ready(code) if self.runs.is_empty() => {
				let refused = running
					.too_long
					.as_ref()
					.map_or(0, |slot| slot.load(Ordering::Relaxed));
				Some(if refused == 0 {
					CallOutcome::Exit(code)
				} else {
					CallOutcome::TooLong(refused)
				})
			},
			_ => None,
		}
	}

	/// `run` ended with `status`; `false` when it is not one of this call's
	/// commands. `refusal` is an `exec` the system refused, for a command
	/// that asked to hear of it ([`ShellCommand::too_long_as_error`],
	/// [`ShellCommand::refusal_as_error`]). A line too long reaches the
	/// utility as its `errno`, so it retries the line; any other refusal
	/// with the error's kind and text but no `errno`, so a utility that
	/// cannot see the program the shell found (a name on `PATH`) never
	/// takes a path's `ENAMETOOLONG` for a line too long.
	pub(super) fn on_done(
		&mut self,
		run: RunId,
		status: i32,
		signal: Option<i32>,
		refusal: Option<ExecRefusal>,
	) -> bool {
		let Some(at) = self.runs.iter().position(|(r, _)| *r == run) else {
			return false;
		};
		let (_, reply) = self.runs.swap_remove(at);
		let code = u8::try_from(status.rem_euclid(256)).unwrap_or(u8::MAX);
		let outcome = match refusal {
			Some(refusal) if refusal.too_long => Err(io::Error::from_raw_os_error(refusal.errno)),
			Some(refusal) => {
				let error = io::Error::from_raw_os_error(refusal.errno);
				Err(io::Error::new(error.kind(), crate::bash::diag::strerror(&error).into_owned()))
			},
			None => Ok(signal.map_or(CommandStatus::Exited(code), CommandStatus::Signaled)),
		};
		// The utility may have stopped waiting (cancelled).
		let _ = reply.send(outcome);
		true
	}

	/// The commands' subshells still running.
	pub(super) fn pending(&self) -> Vec<RunId> {
		self.runs.iter().map(|(run, _)| *run).collect()
	}
}

impl Drop for Extra {
	/// An abandoned call (its caller was cancelled or killed) cancels the
	/// utility, which unwinds on the runtime; the replies of its commands
	/// are dropped, so it stops waiting for them.
	fn drop(&mut self) {
		if let Some(running) = &self.running {
			running.cancel.cancel();
		}
	}
}

/// The script of one command: its environment changes, then the command,
/// with the command line as the positional parameters.
fn script(mut command: ShellCommand, program: &Program, env_names: &[BString]) -> Script {
	let stdin = child_stdin(command.take_stdin());
	let mut source = Vec::new();
	let mut foreign_env = Vec::new();
	let mut unexport_env = Vec::new();
	for change in command.env_changes() {
		match change {
			// Every variable goes (a readonly one stops being exported), and
			// every function, so no `BASH_FUNC_` export is left either.
			EnvChange::Clear => {
				foreign_env.push((None, None));
				// Unsetting a command-prefix or local binding would uncover
				// an exported outer one, so every name in the call's
				// environment is masked too ([`Script::unexport_env`]).
				for name in env_names {
					if let Ok(name) = std::str::from_utf8(name)
						&& is_name(name)
					{
						unexport_env.push(BString::from(name));
						source.extend_from_slice(b"unset -v ");
						source.extend_from_slice(name.as_bytes());
						source.extend_from_slice(b" 2>/dev/null || export -n ");
						source.extend_from_slice(name.as_bytes());
						source.extend_from_slice(b" 2>/dev/null; ");
					}
				}
				// The tool profile has no `compgen`: every variable name comes
				// from `${!X@}` over each possible first character, and every
				// function from `declare -F` (`declare -f[x…] name` lines).
				source.extend_from_slice(b"for __pi_var in");
				for first in (b'A'..=b'Z').chain(b'a'..=b'z').chain(*b"_") {
					source.extend_from_slice(b" ${!");
					source.push(first);
					source.extend_from_slice(b"@}");
				}
				source.extend_from_slice(
					b"; do unset -v \"$__pi_var\" 2>/dev/null \
					  || export -n \"$__pi_var\" 2>/dev/null; done; unset -v __pi_var; \
					  while read -r _ _ __pi_fn; do [ -n \"$__pi_fn\" ] && unset -f \"$__pi_fn\"; \
					  done <<< \"$(declare -F)\"; unset -v __pi_fn; ",
				);
			},
			EnvChange::Remove(name) if is_name(name) => {
				unexport_env.push(BString::from(name.as_bytes()));
				source.extend_from_slice(b"unset -v ");
				source.extend_from_slice(name.as_bytes());
				source.extend_from_slice(b" 2>/dev/null || export -n ");
				source.extend_from_slice(name.as_bytes());
				source.extend_from_slice(b" 2>/dev/null; ");
			},
			EnvChange::Set(name, value) if is_name(name) => {
				source.extend_from_slice(b"export ");
				source.extend_from_slice(name.as_bytes());
				source.push(b'=');
				quote(&mut source, value.as_bytes());
				source.extend_from_slice(b"; ");
			},
			EnvChange::Remove(name) => foreign_env.push((Some(BString::from(name.as_bytes())), None)),
			EnvChange::Set(name, value) => foreign_env
				.push((Some(BString::from(name.as_bytes())), Some(BString::from(value.as_bytes())))),
		}
	}
	let mut args: Vec<BString> = command.args().iter().map(|arg| os_bytes(arg)).collect();
	// Whether a refusal of the command as too long can reach the utility.
	let hands_up = command.too_long_is_error() && program.hands_up_too_long(&args[0]);
	match program {
		// Quoted, so no alias applies (the caller's are hidden; see
		// `exec_source`).
		Program::Builtin => source.extend_from_slice(b"\\command -- \"$@\""),
		Program::Path { path, skip } => {
			exec_source(&mut source, &mut args, path, *skip, command.presented_argv0().map(os_bytes));
		},
	}
	let mut script = Script::command(source);
	script.foreign_env = foreign_env;
	script.unexport_env = unexport_env;
	script.args = Some(args);
	// The utility stands for a program the caller started, whose children
	// see none of the caller's functions, aliases, DEBUG, ERR or RETURN
	// traps, `set -x` or `enable -n`: none can change the words above, nor
	// run again with each retry of a refused line.
	script.as_program = true;
	// Only the generated `exec` of a program, or a wrapper's own command:
	// another builtin may have done work before an `exec` of its own, which
	// a retry would repeat.
	script.too_long_to_host = hands_up;
	// Every other refusal of the generated `exec` of a program too, for a
	// utility that reports a command it cannot run in its own words (`env`).
	script.refusals_to_host =
		hands_up && matches!(program, Program::Path { .. }) && command.refusal_is_error();
	// The working directory is logical, as after `cd`: `-execdir` hands over
	// `<root>/./sub`, and the command's `$PWD` is `<root>/sub`.
	script.cwd = command
		.dir()
		.map(|dir| os_bytes(pi_vfs::normalize_lexically(dir).as_os_str()));
	script.vproc = VprocSel::NewSubshellWithStdio([stdin, RunStdio::Inherit, RunStdio::Inherit]);
	script
}

/// Appends to `source` the `exec` of the program at `path` in place of the
/// first `skip` words of `args` (its positional parameters, rewritten to
/// match), presented as `argv0` or else as the name it was asked for. The
/// program runs by the path it was found at (for a name with a separator,
/// joined to the working directory it was looked up in), as at 9058ab9d:
/// the shell names that path in its diagnostics, and a script without `#!`
/// gets it as its `$0`.
fn exec_source(
	source: &mut Vec<u8>,
	args: &mut Vec<BString>,
	path: &Path,
	skip: usize,
	argv0: Option<BString>,
) {
	args.drain(..skip);
	let argv0 = argv0.unwrap_or_else(|| args[0].clone());
	// `builtin`, as `command` for a builtin: a shell function named `exec`
	// never runs (it would run again with each retry of a refused line).
	// Quoted, so no alias applies: an alias the callout's own command
	// defined before a tool's subshell (the caller's are hidden).
	source.extend_from_slice(b"\\builtin exec -a ");
	quote(source, &argv0);
	source.extend_from_slice(b" -- \"$@\"");
	args[0] = os_bytes(path.as_os_str());
}

/// fd 0 of a command: the null device unless the utility gave one. A host
/// descriptor goes in as it is; a provider file (an engine object the
/// utility got as one, which only `env` passes on: its own stdin) is the
/// caller's fd 0.
fn child_stdin(stdin: Option<Fd>) -> RunStdio {
	let file = match stdin {
		None => std::fs::File::open(if cfg!(windows) { "NUL" } else { "/dev/null" }),
		Some(Fd::File(file)) => Ok(file),
		Some(Fd::Vfs(_)) => return RunStdio::Inherit,
		Some(Fd::Closed) => return RunStdio::Closed,
	};
	file.map_or(RunStdio::Closed, |file| RunStdio::File(Box::new(StdFile::new(file))))
}

fn os_bytes(s: &OsStr) -> BString {
	BString::from(s.as_encoded_bytes())
}

/// A shell variable name.
fn is_name(name: &str) -> bool {
	let mut bytes = name.bytes();
	bytes
		.next()
		.is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
		&& bytes.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// Append `word` single-quoted.
fn quote(out: &mut Vec<u8>, word: &[u8]) {
	out.push(b'\'');
	for &c in word {
		if c == b'\'' {
			out.extend_from_slice(b"'\\''");
		} else {
			out.push(c);
		}
	}
	out.push(b'\'');
}

/// The utility's [`CommandRunner`]: looks each command up, then sends it to
/// the driver and waits for its reply.
struct Runner {
	requests: flume::Sender<Request>,
	/// Wakes the driver.
	waker:    Waker,
	lookup:   Lookup,
}

impl CommandRunner for Runner {
	fn start(
		&mut self,
		command: ShellCommand,
	) -> Pin<Box<dyn Future<Output = io::Result<CommandStatus>> + Send + 'static>> {
		let response = self.lookup.program(&command).map(|program| {
			let (reply, response) = flume::bounded(1);
			let sent = self
				.requests
				.send(Request { command, program, reply })
				.is_ok();
			self.waker.wake_by_ref();
			sent.then_some(response)
		});
		Box::pin(async move {
			let response = response?.ok_or_else(cancelled)?;
			response.recv_async().await.map_err(|_| cancelled())?
		})
	}
}

/// The error a utility sees once the driver dropped its command unanswered:
/// the call was abandoned.
fn cancelled() -> io::Error {
	io::Error::new(io::ErrorKind::Interrupted, "command cancelled")
}

/// What a command name runs, as of the utility's start.
pub(super) struct Lookup {
	/// The utility's `PATH`.
	path:   Option<String>,
	/// The utility's working directory.
	cwd:    PathBuf,
	config: ToolConfig,
}

impl Lookup {
	/// The lookup a tool's own command gets: `call`'s `PATH` and working
	/// directory.
	pub(super) fn for_call(call: &ToolCall, config: &ToolConfig) -> Self {
		Self {
			path:   call
				.env
				.get(b"PATH")
				.map(|path| path.to_str_lossy().into_owned()),
			cwd:    call.cwd.to_path_lossy().into_owned(),
			config: config.clone(),
		}
	}

	/// How `command` runs; `NotFound` when nothing has its name,
	/// `PermissionDenied` when only files that cannot be executed have it.
	fn program(&self, command: &ShellCommand) -> io::Result<Program> {
		let name = command
			.args()
			.first()
			.ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
		let cwd = command.dir().unwrap_or(&self.cwd);
		if self.builtin(name) && !has_separator(name) {
			return Ok(self.wrapped(command, cwd).unwrap_or(Program::Builtin));
		}
		let path = self.find(command.env_changes(), name, cwd)?;
		Ok(Program::Path { path, skip: 0 })
	}

	/// The program `name` names, with the environment changes `changes`
	/// applied to the utility's `PATH`.
	fn find(&self, changes: &[EnvChange], name: &OsStr, cwd: &Path) -> io::Result<PathBuf> {
		if has_separator(name) {
			return match executable(&cwd.join(name)) {
				Some(true) => Ok(cwd.join(name)),
				Some(false) => Err(io::ErrorKind::PermissionDenied.into()),
				None => Err(io::ErrorKind::NotFound.into()),
			};
		}
		let path = changes
			.iter()
			.fold(self.path.as_deref(), |path, change| match change {
				EnvChange::Clear => None,
				EnvChange::Remove(var) if var == "PATH" => None,
				EnvChange::Set(var, value) if var == "PATH" => Some(value.as_str()),
				_ => path,
			})
			.unwrap_or(DEFAULT_PATH);
		let mut denied = false;
		for dir in std::env::split_paths(OsStr::new(path)) {
			let candidate = cwd.join(dir).join(name);
			match executable(&candidate) {
				Some(true) => return Ok(candidate),
				Some(false) => denied = true,
				None => {},
			}
		}
		let kind = if denied {
			io::ErrorKind::PermissionDenied
		} else {
			io::ErrorKind::NotFound
		};
		Err(kind.into())
	}

	/// The program a builtin that runs nothing before it `exec`s one runs,
	/// as if the utility had named it: `command PROG` and `exec PROG`
	/// (optionally after `builtin`, or with `--`). `None` for anything else
	/// (an option, a builtin or a missing program after the words, a
	/// presented `argv[0]`), which runs as the builtin, reporting its own
	/// errors. `env`, `ifne`, `nohup` and `timeout` run their command
	/// themselves and hand a refusal of it up ([`WRAPPERS`]).
	fn wrapped(&self, command: &ShellCommand, cwd: &Path) -> Option<Program> {
		if command.presented_argv0().is_some() {
			return None;
		}
		let args = command.args();
		let word = |at: usize| args.get(at).and_then(|arg| arg.to_str());
		let mut skip = usize::from(word(0) == Some("builtin"));
		match word(skip)? {
			"command" | "exec" => {
				skip += 1;
				if word(skip) == Some("--") {
					skip += 1;
				}
			},
			_ => return None,
		}
		let name = args.get(skip)?;
		if name.as_encoded_bytes().first() == Some(&b'-') || self.builtin(name) {
			return None;
		}
		let path = self.find(command.env_changes(), name, cwd).ok()?;
		Some(Program::Path { path, skip })
	}

	/// Whether `name` runs in-process: an engine intrinsic, a tool or an
	/// extra this shell offers.
	pub(super) fn builtin(&self, name: &OsStr) -> bool {
		let name = os_bytes(name);
		IntrinsicId::lookup(&name, ModeId::Bash).is_some()
			|| self.config.lookup(name.as_bstr()).is_some()
			|| self.config.native_extra(name.as_bstr()).is_some()
	}
}

fn has_separator(name: &OsStr) -> bool {
	let bytes = name.as_encoded_bytes();
	bytes.contains(&b'/') || (cfg!(windows) && bytes.contains(&b'\\'))
}

/// `Some(true)` for an executable file at `path`, `Some(false)` for a file
/// that is not executable, `None` for nothing (or a directory).
#[cfg(unix)]
fn executable(path: &Path) -> Option<bool> {
	use std::os::unix::fs::PermissionsExt as _;
	let meta = std::fs::metadata(path)
		.ok()
		.filter(std::fs::Metadata::is_file)?;
	Some(meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn executable(path: &Path) -> Option<bool> {
	(path.is_file() || path.with_extension("exe").is_file()).then_some(true)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn quoting_survives_single_quotes() {
		let mut out = Vec::new();
		quote(&mut out, b"it's");
		assert_eq!(out, b"'it'\\''s'");
	}

	#[test]
	fn only_shell_names_are_variables() {
		assert!(is_name("PATH"));
		assert!(is_name("_x1"));
		assert!(!is_name("1x"));
		assert!(!is_name("a-b"));
		assert!(!is_name(""));
	}
}
