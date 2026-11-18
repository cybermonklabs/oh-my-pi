//! `xargs` builtin: build and execute command lines from standard input.
//!
//! Ported from uutils findutils 0.8.0.

use std::{
	collections::HashMap,
	error::Error,
	ffi::{OsStr, OsString},
	fmt::Display,
	io::{self, Read, Write},
	path::Path,
};

use clap::{Arg, ArgAction, ArgMatches};

use crate::host::{
	CommandStatus, Host, RunningCommand, ShellCommand, Utility, command_line_too_long, line_bytes,
	matches_parser,
};

mod options {
	pub const COMMAND: &str = "COMMAND";

	pub const ARG_FILE: &str = "arg-file";
	pub const DELIMITER: &str = "delimiter";
	pub const EXIT: &str = "exit";
	pub const MAX_ARGS: &str = "max-args";
	pub const MAX_CHARS: &str = "max-chars";
	pub const MAX_LINES: &str = "max-lines";
	pub const MAX_PROCS: &str = "max-procs";
	pub const INTERACTIVE: &str = "interactive";
	pub const NO_RUN_IF_EMPTY: &str = "no-run-if-empty";
	pub const NULL: &str = "null";
	pub const REPLACE: &str = "replace";
	pub const REPLACE_I: &str = "replace-I";
	pub const VERBOSE: &str = "verbose";
}

struct Options {
	arg_file:                Option<String>,
	delimiter:               Option<u8>,
	interactive:            bool,
	exit_if_pass_char_limit: bool,
	max_args:                Option<usize>,
	max_chars:               Option<usize>,
	max_lines:               Option<usize>,
	max_procs:               usize,
	no_run_if_empty:         bool,
	null:                    bool,
	replace:                 Option<String>,
	verbose:                 bool,
}

/// Parsed `xargs` invocation.
pub(crate) struct Xargs {
	matches: ArgMatches,
}

matches_parser!(Xargs, app);

#[derive(Debug, PartialEq, Eq)]
enum ArgumentKind {
	/// An argument provided as part of the initial command line.
	Initial,
	/// An argument that was terminated by a newline or custom delimiter.
	HardTerminated,
	/// An argument that was terminated by non-newline whitespace.
	SoftTerminated,
}

#[derive(Debug, PartialEq, Eq)]
struct Argument {
	arg:  OsString,
	kind: ArgumentKind,
}

struct ExhaustedCommandSpace {
	arg:          Argument,
	out_of_chars: bool,
}

/// A "limiter" to constrain the size of a single command line. Given a cursor
/// pointing to the next limiter that should be tried.
trait CommandSizeLimiter {
	fn try_arg(
		&mut self,
		arg: Argument,
		cursor: LimiterCursor<'_>,
	) -> Result<Argument, ExhaustedCommandSpace>;
	fn dyn_clone(&self) -> Box<dyn CommandSizeLimiter>;
}

/// A pointer to the next limiter. A limiter should *always* call the cursor's
/// `try_next` *before* updating its own state, to ensure that all other
/// limiters are okay with the argument first.
struct LimiterCursor<'collection> {
	limiters: &'collection mut [Box<dyn CommandSizeLimiter>],
}

impl LimiterCursor<'_> {
	fn try_next(self, arg: Argument) -> Result<Argument, ExhaustedCommandSpace> {
		match self.limiters.split_first_mut() {
			None => Ok(arg),
			Some((current, remaining)) => current.try_arg(arg, LimiterCursor { limiters: remaining }),
		}
	}
}

struct LimiterCollection {
	limiters: Vec<Box<dyn CommandSizeLimiter>>,
}

impl LimiterCollection {
	fn new() -> Self {
		Self { limiters: vec![] }
	}

	fn add(&mut self, limiter: impl CommandSizeLimiter + 'static) {
		self.limiters.push(Box::new(limiter));
	}

	fn try_arg(&mut self, arg: Argument) -> Result<Argument, ExhaustedCommandSpace> {
		let cursor = LimiterCursor { limiters: &mut self.limiters[..] };
		cursor.try_next(arg)
	}
}

impl Clone for LimiterCollection {
	fn clone(&self) -> Self {
		Self {
			limiters: self
				.limiters
				.iter()
				.map(|limiter| limiter.dyn_clone())
				.collect(),
		}
	}
}

#[cfg(windows)]
fn count_osstr_chars_for_exec(s: &OsStr) -> usize {
	use std::os::windows::ffi::OsStrExt;
	// Include +1 for either the null terminator or trailing space.
	s.encode_wide().count() + 1
}

#[cfg(unix)]
fn count_osstr_chars_for_exec(s: &OsStr) -> usize {
	use std::os::unix::ffi::OsStrExt;
	// Include +1 for the null terminator.
	s.as_bytes().len() + 1
}

#[derive(Clone)]
struct MaxCharsCommandSizeLimiter {
	current_size: usize,
	max_chars:    usize,
	per_arg_overhead: usize,
}

impl MaxCharsCommandSizeLimiter {
	fn new(max_chars: usize) -> Self {
		Self { current_size: 0, max_chars, per_arg_overhead: 0 }
	}

	#[cfg(windows)]
	fn new_system(_env: &HashMap<OsString, OsString>) -> MaxCharsCommandSizeLimiter {
		// Taken from the CreateProcess docs.
		const MAX_CMDLINE: usize = 32767;
		MaxCharsCommandSizeLimiter::new(MAX_CMDLINE)
	}

	#[cfg(unix)]
	fn new_system(env: &HashMap<OsString, OsString>) -> Self {
		// POSIX requires that we leave 2048 bytes of space so that the child processes
		// can have room to set their own environment variables.
		const ARG_HEADROOM: usize = 2048;
		let arg_max = unsafe { libc::sysconf(libc::_SC_ARG_MAX) } as usize;
		let pointer_size = std::mem::size_of::<*const libc::c_char>();

		let env_size: usize = env
			.iter()
			// The two string terminators account for '=' and '\0'; envp has one pointer.
			.map(|(var, value)| {
				count_osstr_chars_for_exec(var) + count_osstr_chars_for_exec(value) + pointer_size
			})
			.sum();

		let mut limiter = Self::new(arg_max.saturating_sub(ARG_HEADROOM).saturating_sub(env_size).max(1));
		// ARG_MAX covers argv pointers as well as strings. Keep -s string-only.
		limiter.per_arg_overhead = pointer_size;
		limiter
	}
}

impl CommandSizeLimiter for MaxCharsCommandSizeLimiter {
	fn try_arg(
		&mut self,
		arg: Argument,
		cursor: LimiterCursor<'_>,
	) -> Result<Argument, ExhaustedCommandSpace> {
		let chars = count_osstr_chars_for_exec(&arg.arg) + self.per_arg_overhead;
		if self.current_size + chars <= self.max_chars {
			let arg = cursor.try_next(arg)?;
			self.current_size += chars;
			Ok(arg)
		} else {
			Err(ExhaustedCommandSpace { arg, out_of_chars: true })
		}
	}

	fn dyn_clone(&self) -> Box<dyn CommandSizeLimiter> {
		Box::new(self.clone())
	}
}

#[derive(Clone)]
struct MaxArgsCommandSizeLimiter {
	current_args: usize,
	max_args:     usize,
}

impl MaxArgsCommandSizeLimiter {
	fn new(max_args: usize) -> Self {
		Self { current_args: 0, max_args }
	}
}

impl CommandSizeLimiter for MaxArgsCommandSizeLimiter {
	fn try_arg(
		&mut self,
		arg: Argument,
		cursor: LimiterCursor<'_>,
	) -> Result<Argument, ExhaustedCommandSpace> {
		if self.current_args < self.max_args {
			let arg = cursor.try_next(arg)?;
			if arg.kind != ArgumentKind::Initial {
				self.current_args += 1;
			}
			Ok(arg)
		} else {
			Err(ExhaustedCommandSpace { arg, out_of_chars: false })
		}
	}

	fn dyn_clone(&self) -> Box<dyn CommandSizeLimiter> {
		Box::new(self.clone())
	}
}

#[derive(Clone)]
struct MaxLinesCommandSizeLimiter {
	current_line: usize,
	max_lines:    usize,
}

impl MaxLinesCommandSizeLimiter {
	fn new(max_lines: usize) -> Self {
		Self { current_line: 1, max_lines }
	}
}

impl CommandSizeLimiter for MaxLinesCommandSizeLimiter {
	fn try_arg(
		&mut self,
		arg: Argument,
		cursor: LimiterCursor<'_>,
	) -> Result<Argument, ExhaustedCommandSpace> {
		if self.current_line <= self.max_lines {
			let arg = cursor.try_next(arg)?;
			// The name of this limiter is a bit of a lie: although this limits
			// by max "lines", if a custom delimiter is used, xargs uses that
			// instead. So, this actually limits based on the max amount of hard
			// terminations.
			if arg.kind == ArgumentKind::HardTerminated {
				self.current_line += 1;
			}
			Ok(arg)
		} else {
			Err(ExhaustedCommandSpace { arg, out_of_chars: false })
		}
	}

	fn dyn_clone(&self) -> Box<dyn CommandSizeLimiter> {
		Box::new(self.clone())
	}
}

enum CommandResult {
	Success,
	Failure,
}

impl CommandResult {
	fn combine(&mut self, other: Self) {
		if matches!(*self, Self::Success) {
			*self = other;
		}
	}
}

#[derive(Debug)]
enum CommandExecutionError {
	// exit code 255
	UrgentlyFailed,
	Killed { name: OsString, signal: i32 },
	/// The command could not be started: nothing executable has its name
	/// (`PermissionDenied`), or the host could not start it. Status 126, and
	/// xargs stops, with `xargs: Command could not be run: ERROR`. A refusal of
	/// its `exec` by the system (`EACCES`, a `#!` interpreter's error, a
	/// working directory past `PATH_MAX`) is no error here: the shell reports
	/// it and the command's status is 126.
	CannotRun(io::Error),
	/// Nothing runs under this command name (status 127).
	NotFound(OsString),
	/// The system refuses a command line as too long even with one input
	/// argument (GNU: status 1), or a whole `-I` line (also status 1 here;
	/// GNU findutils 4.9.0 exits 127 for it, with `ARG: No such file or
	/// directory`).
	ArgumentSize,
}

impl Display for CommandExecutionError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::UrgentlyFailed => write!(f, "Command exited with code 255"),
			Self::Killed { name, signal } => {
				write!(f, "{}: terminated by signal {signal}", name.to_string_lossy())
			},
			Self::CannotRun(err) => write!(f, "Command could not be run: {err}"),
			Self::NotFound(name) => write!(f, "{}: No such file or directory", name.to_string_lossy()),
			Self::ArgumentSize => write!(f, "can't call exec() due to argument size restrictions"),
		}
	}
}

impl Error for CommandExecutionError {}

/// Maps how a command named `name` ended onto xargs' verdict for it.
fn command_outcome(
	status: io::Result<CommandStatus>,
	name: &OsStr,
) -> Result<CommandResult, CommandExecutionError> {
	match status {
		Ok(CommandStatus::Exited(0)) => Ok(CommandResult::Success),
		Ok(CommandStatus::Exited(255)) => Err(CommandExecutionError::UrgentlyFailed),
		Ok(CommandStatus::Exited(_)) => Ok(CommandResult::Failure),
		Ok(CommandStatus::Signaled(signal)) => {
			Err(CommandExecutionError::Killed { name: name.to_owned(), signal })
		},
		Err(e) => Err(cannot_run(e, name)),
	}
}

/// Why the command named `name` did not run.
fn cannot_run(error: io::Error, name: &OsStr) -> CommandExecutionError {
	if error.kind() == io::ErrorKind::NotFound {
		CommandExecutionError::NotFound(name.to_owned())
	} else {
		CommandExecutionError::CannotRun(error)
	}
}

/// A command line xargs runs: `argv`, of which the first `fixed` words (the
/// command and its initial arguments; the whole line with `-I`) stay in
/// both halves when a line the system refuses as too long is split.
struct Batch {
	argv:  Vec<OsString>,
	fixed: usize,
}

impl Batch {
	/// The two lines GNU xargs retries a refused one as, each with half of
	/// its input arguments; `None` when one argument (or none) is left.
	fn split(mut self) -> Option<(Self, Self)> {
		let fixed = self.fixed;
		let args = self.argv.len() - fixed;
		if args < 2 {
			return None;
		}
		let mut second = Vec::with_capacity(fixed + args - args / 2);
		second.extend_from_slice(&self.argv[..fixed]);
		second.extend(self.argv.drain(fixed + args / 2..));
		Some((self, Self { argv: second, fixed }))
	}
}

/// Commands launched and not yet reaped, at most `limit` at once (`-P`).
struct Jobs {
	limit:       usize,
	running:     Vec<RunningCommand>,
	/// The command line of each of `running`, at the same index, kept until
	/// it ends so a line the system refuses as too long can be split.
	batches:     Vec<Batch>,
	/// Lines waiting to start, the next one last. The halves of a refused
	/// line wait here: starting them from the reaping that found the refusal
	/// would nest a start inside a reap for every refusal in flight.
	queued:      Vec<Batch>,
	result:      CommandResult,
	/// The command name every command line runs (`argv[0]`), for diagnostics.
	command:     OsString,
	/// `-t`: each command line goes to stderr before it runs.
	verbose:     bool,
	/// `-p`: each command line runs only once the user confirms it.
	interactive: bool,
	/// A fatal outcome was seen: nothing more starts, a refused line's
	/// halves included.
	stopped:     bool,
}

impl Jobs {
	fn new(limit: usize, verbose: bool, interactive: bool) -> Self {
		Self {
			limit,
			running: Vec::new(),
			batches: Vec::new(),
			queued: Vec::new(),
			result: CommandResult::Success,
			command: OsString::new(),
			verbose,
			interactive,
			stopped: false,
		}
	}

	/// Echoes `argv` for `-t`, or asks about it for `-p`; whether it runs.
	fn confirm(&self, host: &mut Host, argv: &[OsString]) -> bool {
		if !self.interactive && !self.verbose {
			return true;
		}
		let line = argv
			.iter()
			.map(|arg| arg.to_string_lossy())
			.collect::<Vec<_>>()
			.join(" ");
		if !self.interactive {
			// GNU-style `-t`: echo the command line about to run on stderr.
			let _ = writeln!(host.stderr, "{line}");
			return true;
		}
		let _ = write!(host.stderr, "{line} ?...");
		let _ = host.stderr.flush();
		let mut response = Vec::new();
		let mut byte = [0_u8; 1];
		while host.stdin.read(&mut byte).unwrap_or(0) == 1 {
			if byte[0] == b'\n' {
				break;
			}
			response.push(byte[0]);
		}
		matches!(response.first(), Some(b'y' | b'Y'))
	}

	/// Starts `batch`, then the halves of any refused line, waiting until
	/// fewer than `limit` commands run: `-P 1` runs each command, and the
	/// halves it is retried as, to completion before reading more input.
	fn spawn(&mut self, host: &mut Host, batch: Batch) -> Result<(), CommandExecutionError> {
		self.queued.push(batch);
		self.start_queued(host)
	}

	/// Starts the queued lines one after another until none is left; the
	/// reaping in between may queue more. Nothing starts once a fatal outcome
	/// was seen or the host cancelled the command.
	fn start_queued(&mut self, host: &mut Host) -> Result<(), CommandExecutionError> {
		while let Some(batch) = self.queued.pop() {
			if self.stopped || host.is_cancelled() {
				self.queued.clear();
				break;
			}
			if !self.confirm(host, &batch.argv) {
				continue;
			}
			// A child may have finished while there was still a free slot (in
			// particular with -P 0). Observe fatal outcomes before launching more.
			while let Some((index, status)) = RunningCommand::try_wait_any(&mut self.running) {
				let done = self.batches.swap_remove(index);
				self.settle(host, done, status)?;
			}
			if let Some(name) = batch.argv.first() {
				self.command.clone_from(name);
			}
			// The line is kept until the command ends: a refusal of it as too
			// long comes back from the shell then, and the halves are cut from
			// it. Any other refusal is the shell's diagnostic and status 126.
			let command = ShellCommand::new(batch.argv.clone()).too_long_as_error();
			let command = host
				.spawn_command(command)
				.map_err(|error| cannot_run(error, &self.command))?;
			self.running.push(command);
			self.batches.push(batch);
			while self.running.len() >= self.limit {
				self.reap(host)?;
			}
		}
		Ok(())
	}

	/// Waits for one running command and folds its status into the result.
	fn reap(&mut self, host: &Host) -> Result<(), CommandExecutionError> {
		if let Some((index, status)) = RunningCommand::wait_any(&mut self.running) {
			let batch = self.batches.swap_remove(index);
			self.settle(host, batch, status)?;
		}
		Ok(())
	}

	/// Folds how `batch` ended into the result. A line the system refused as
	/// too long is queued again as two halves, the first to start first, as
	/// GNU xargs retries it; one input argument too long on its own (or a
	/// whole `-I` line) is the error GNU's gives one argument, status 1.
	fn settle(
		&mut self,
		host: &Host,
		batch: Batch,
		status: io::Result<CommandStatus>,
	) -> Result<(), CommandExecutionError> {
		let too_long = status.as_ref().is_err_and(|error| {
			let program = batch.argv.first().map_or(Path::new(""), Path::new);
			command_line_too_long(error, program, line_bytes(&batch.argv), host.cwd())
		});
		if !too_long {
			self.result.combine(command_outcome(status, &self.command)?);
			return Ok(());
		}
		if self.stopped || host.is_cancelled() {
			return Err(CommandExecutionError::ArgumentSize);
		}
		let (first, second) = batch.split().ok_or(CommandExecutionError::ArgumentSize)?;
		self.queued.push(second);
		self.queued.push(first);
		Ok(())
	}

	/// Waits for every running command, so none outlives xargs, starting the
	/// halves of the lines refused meanwhile; the first fatal error is
	/// reported only once all have finished, and stops new commands, so a
	/// refused line is not split after one.
	fn finish(mut self, host: &mut Host) -> Result<CommandResult, CommandExecutionError> {
		let mut outcome = Ok(());
		loop {
			let started = self.start_queued(host);
			if outcome.is_ok() && started.is_err() {
				self.stopped = true;
				outcome = started;
			}
			if self.running.is_empty() {
				break;
			}
			let reaped = self.reap(host);
			if outcome.is_ok() && reaped.is_err() {
				self.stopped = true;
				outcome = reaped;
			}
		}
		outcome.map(|()| self.result)
	}
}

enum ExecAction {
	Command(Vec<OsString>),
	Echo,
}

struct CommandBuilderOptions {
	action:      ExecAction,
	interactive: bool,
	limiters:    LimiterCollection,
	verbose:     bool,
	replace:     Option<String>,
}
impl CommandBuilderOptions {
	fn new(
		action: ExecAction,
		mut limiters: LimiterCollection,
		replace: Option<String>,
	) -> Result<Self, ExhaustedCommandSpace> {
		let initial_args = match &action {
			ExecAction::Command(args) => args.iter().map(std::convert::AsRef::as_ref).collect(),
			ExecAction::Echo => vec![OsStr::new("echo")],
		};

		for arg in initial_args {
			limiters.try_arg(Argument { arg: arg.to_owned(), kind: ArgumentKind::Initial })?;
		}

		Ok(Self { action, interactive: false, limiters, verbose: false, replace })
	}
}

struct CommandBuilder<'options> {
	options:    &'options CommandBuilderOptions,
	extra_args: Vec<OsString>,
	limiters:   LimiterCollection,
}

impl CommandBuilder<'_> {
	fn new(options: &CommandBuilderOptions) -> CommandBuilder<'_> {
		CommandBuilder { options, extra_args: vec![], limiters: options.limiters.clone() }
	}

	fn add_arg(&mut self, arg: Argument) -> Result<(), ExhaustedCommandSpace> {
		let arg = self.limiters.try_arg(arg)?;
		self.extra_args.push(arg.arg);
		Ok(())
	}

	fn execute(mut self, host: &mut Host, jobs: &mut Jobs) -> Result<(), CommandExecutionError> {
		let (entry_point, initial_args): (&OsStr, &[OsString]) = match &self.options.action {
			ExecAction::Command(args) => (&args[0], &args[1..]),
			ExecAction::Echo => (OsStr::new("echo"), &[]),
		};

		let mut argv = Vec::with_capacity(1 + initial_args.len() + self.extra_args.len());
		argv.push(entry_point.to_owned());
		let fixed = if let Some(replace_str) = &self.options.replace {
			// Replace all occurrences in initial args with the extra arg,
			// Thanks to `MaxArgsCommandSizeLimiter`, we only process a single extra arg
			// here.
			let replacement = self.extra_args[0].to_string_lossy();
			argv.extend(initial_args.iter().map(|arg| {
				let arg_str = arg.to_string_lossy();
				OsString::from(arg_str.replace(replace_str, &replacement))
			}));
			// The whole line comes of one input argument: it is not split.
			argv.len()
		} else {
			// don't do any replacement
			argv.extend(initial_args.iter().cloned());
			let fixed = argv.len();
			argv.append(&mut self.extra_args);
			fixed
		};

		match &self.options.action {
			ExecAction::Command(_) => jobs.spawn(host, Batch { argv, fixed }),
			ExecAction::Echo => {
				if jobs.confirm(host, &argv) {
					// With `-I` the line is just `echo`; the input argument is printed.
					let words =
						if self.options.replace.is_some() { &self.extra_args[..] } else { &argv[1..] };
					let _ = writeln!(
						host.stdout,
						"{}",
						words
							.iter()
							.map(|arg| arg.to_string_lossy())
							.collect::<Vec<_>>()
							.join(" ")
					);
				}
				Ok(())
			},
		}
	}
}

enum InputSource {
	Stdin,
	Reader(Box<dyn Read + Send>),
}

impl InputSource {
	fn read(&mut self, host: &mut Host, buf: &mut [u8]) -> io::Result<usize> {
		match self {
			Self::Stdin => host.stdin.read(buf),
			Self::Reader(reader) => reader.read(buf),
		}
	}
}

trait ArgumentReader {
	fn next(&mut self, host: &mut Host) -> io::Result<Option<Argument>>;
}

struct WhitespaceDelimitedArgumentReader {
	rd:      InputSource,
	pending: Vec<u8>,
}

impl WhitespaceDelimitedArgumentReader {
	fn new(rd: impl Read + Send + 'static) -> Self {
		Self { rd: InputSource::Reader(Box::new(rd)), pending: vec![] }
	}

	fn stdin() -> Self {
		Self { rd: InputSource::Stdin, pending: vec![] }
	}
}

impl ArgumentReader for WhitespaceDelimitedArgumentReader {
	fn next(&mut self, host: &mut Host) -> io::Result<Option<Argument>> {
		let mut result = vec![];
		let mut terminated_by_newline = false;

		let mut pending = vec![];
		std::mem::swap(&mut pending, &mut self.pending);

		enum Escape {
			Slash,
			Quote(u8),
		}

		let mut escape: Option<Escape> = None;
		let mut i = 0;
		loop {
			if i == pending.len() {
				pending.resize(4096, 0);
				// Already hit the end of our buffer, so read in some more data.
				let bytes_read = loop {
					match self.rd.read(host, &mut pending[..]) {
						Ok(bytes_read) => break bytes_read,
						Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
						Err(e) => return Err(e),
					}
				};

				if bytes_read == 0 {
					if let Some(Escape::Quote(q)) = &escape {
						return Err(io::Error::new(
							io::ErrorKind::InvalidInput,
							format!("Unterminated quote: {q}"),
						));
					}
					if i == 0 {
						return Ok(None);
					}
					pending.clear();
					break;
				}

				pending.resize(bytes_read, 0);
				i = 0;
			}

			match (&escape, pending[i]) {
				(Some(Escape::Quote(quote)), c) if c == *quote => escape = None,
				(Some(Escape::Quote(_)), c) => result.push(c),
				(Some(Escape::Slash), c) => {
					result.push(c);
					escape = None;
				},
				(None, c @ (b'"' | b'\'')) => escape = Some(Escape::Quote(c)),
				(None, b'\\') => escape = Some(Escape::Slash),
				(None, c) if c.is_ascii_whitespace() => {
					if !result.is_empty() {
						terminated_by_newline = c == b'\n';
						break;
					}
				},
				(None, c) => result.push(c),
			}

			i += 1;
		}

		if i < pending.len() {
			self.pending = pending.split_off(i + 1);
		}

		Ok(Some(Argument {
			arg:  String::from_utf8_lossy_owned(result).into(),
			kind: if terminated_by_newline {
				ArgumentKind::HardTerminated
			} else {
				ArgumentKind::SoftTerminated
			},
		}))
	}
}

struct ByteDelimitedArgumentReader {
	rd:        InputSource,
	delimiter: u8,
	pending:   Vec<u8>,
}

impl ByteDelimitedArgumentReader {
	fn new(rd: impl Read + Send + 'static, delimiter: u8) -> Self {
		Self { rd: InputSource::Reader(Box::new(rd)), delimiter, pending: vec![] }
	}

	fn stdin(delimiter: u8) -> Self {
		Self { rd: InputSource::Stdin, delimiter, pending: vec![] }
	}
}

impl ArgumentReader for ByteDelimitedArgumentReader {
	fn next(&mut self, host: &mut Host) -> io::Result<Option<Argument>> {
		loop {
			let mut result = Vec::new();
			loop {
				if let Some(index) = self.pending.iter().position(|byte| *byte == self.delimiter) {
					result.extend_from_slice(&self.pending[..index]);
					self.pending.drain(..=index);
					break;
				}
				result.append(&mut self.pending);
				let mut buf = [0_u8; 4096];
				let bytes_read = match self.rd.read(host, &mut buf) {
					Ok(bytes_read) => bytes_read,
					Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
					Err(err) => return Err(err),
				};
				if bytes_read == 0 {
					if result.is_empty() {
						return Ok(None);
					}
					break;
				}
				self.pending.extend_from_slice(&buf[..bytes_read]);
			}
			if result.is_empty() {
				continue;
			}
			return Ok(Some(Argument {
				arg:  String::from_utf8_lossy_owned(result).into(),
				kind: ArgumentKind::HardTerminated,
			}));
		}
	}
}

#[derive(Debug)]
enum XargsError {
	ArgumentTooLarge,
	CommandExecution(CommandExecutionError),
	Io(io::Error),
	Untyped(String),
}

impl Display for XargsError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::ArgumentTooLarge => write!(f, "Argument too large"),
			Self::CommandExecution(e) => write!(f, "{e}"),
			Self::Io(e) => write!(f, "{e}"),
			Self::Untyped(s) => write!(f, "{s}"),
		}
	}
}

impl Error for XargsError {}

impl From<String> for XargsError {
	fn from(s: String) -> Self {
		Self::Untyped(s)
	}
}

impl From<&'_ str> for XargsError {
	fn from(s: &'_ str) -> Self {
		s.to_owned().into()
	}
}

impl From<CommandExecutionError> for XargsError {
	fn from(e: CommandExecutionError) -> Self {
		Self::CommandExecution(e)
	}
}

impl From<io::Error> for XargsError {
	fn from(e: io::Error) -> Self {
		Self::Io(e)
	}
}

struct InputProcessOptions {
	exit_if_pass_char_limit: bool,
	max_args:                Option<usize>,
	max_lines:               Option<usize>,
	max_procs:               usize,
	no_run_if_empty:         bool,
}

impl InputProcessOptions {
	fn new(
		exit_if_pass_char_limit: bool,
		max_args: Option<usize>,
		max_lines: Option<usize>,
		max_procs: usize,
		no_run_if_empty: bool,
	) -> Self {
		Self { exit_if_pass_char_limit, max_args, max_lines, max_procs, no_run_if_empty }
	}
}

/// Runs command lines built from `args`, up to `options.max_procs` at once,
/// and waits for all of them.
fn process_input(
	host: &mut Host,
	builder_options: &CommandBuilderOptions,
	args: Box<dyn ArgumentReader>,
	options: &InputProcessOptions,
) -> Result<CommandResult, XargsError> {
	let mut jobs = Jobs::new(options.max_procs, builder_options.verbose, builder_options.interactive);
	let launched = launch_commands(host, builder_options, args, options, &mut jobs);
	// After a fatal error nothing more starts, a refused line's halves included.
	jobs.stopped = launched.is_err();
	let finished = jobs.finish(host);
	launched?;
	Ok(finished?)
}

/// Builds command lines from `args` and hands each to `jobs`.
fn launch_commands(
	host: &mut Host,
	builder_options: &CommandBuilderOptions,
	mut args: Box<dyn ArgumentReader>,
	options: &InputProcessOptions,
	jobs: &mut Jobs,
) -> Result<(), XargsError> {
	let mut current_builder = CommandBuilder::new(builder_options);
	let mut have_pending_command = false;

	while let Some(arg) = args.next(host)? {
		// Stop launching new children once the host has cancelled the command.
		if host.is_cancelled() {
			return Ok(());
		}
		if let Err(ExhaustedCommandSpace { arg, out_of_chars }) = current_builder.add_arg(arg) {
			if out_of_chars
				&& options.exit_if_pass_char_limit
				&& (options.max_args.is_some() || options.max_lines.is_some())
			{
				return Err(XargsError::ArgumentTooLarge);
			}
			if have_pending_command {
				current_builder.execute(host, jobs)?;
			}

			current_builder = CommandBuilder::new(builder_options);
			if let Err(ExhaustedCommandSpace { .. }) = current_builder.add_arg(arg) {
				return Err(XargsError::ArgumentTooLarge);
			}
		}

		have_pending_command = true;
	}

	if host.is_cancelled() {
		return Ok(());
	}

	if have_pending_command || (!options.no_run_if_empty && builder_options.replace.is_none()) {
		current_builder.execute(host, jobs)?;
	}

	Ok(())
}

fn parse_delimiter(s: &str) -> Result<u8, String> {
	match s.strip_prefix('\\') {
		Some(hex) if hex.starts_with('x') => {
			u8::from_str_radix(&hex[1..], 16).map_err(|e| format!("Invalid hex sequence: {e}"))
		},
		Some(oct) if oct.starts_with('0') => {
			u8::from_str_radix(&oct[1..], 8).map_err(|e| format!("Invalid octal sequence: {e}"))
		},
		Some(special) => match special {
			"a" => Ok(b'\x07'),
			"b" => Ok(b'\x08'),
			"f" => Ok(b'\x0C'),
			"n" => Ok(b'\n'),
			"r" => Ok(b'\r'),
			"t" => Ok(b'\t'),
			"v" => Ok(b'\x0B'),
			"\\" => Ok(b'\\'),
			"0" => Ok(b'\0'),
			_ => Err(format!("Invalid escape sequence: \\{special}")),
		},
		None if s.len() == 1 => Ok(s.as_bytes()[0]),
		None => Err("Delimiter must be one byte".to_owned()),
	}
}

fn validate_positive_usize(s: &str) -> Result<usize, String> {
	match s.parse::<usize>() {
		Ok(v) if v > 0 => Ok(v),
		Ok(v) => Err(format!("Value must be > 0, not: {v}")),
		Err(e) => Err(e.to_string()),
	}
}

fn normalize_options<'a>(
	host: &mut Host,
	options: &'a Options,
	matches: &'a ArgMatches,
) -> (Option<usize>, Option<usize>, &'a Option<String>, Option<u8>) {
	let (max_args, max_lines, replace) =
		match (options.max_args, options.max_lines, &options.replace) {
			// These 3 options are mutually exclusive.
			// But `max_args=1` and `replace` do not actually conflict, so no warning.
			(None | Some(1), None, Some(_)) => {
				// If `replace`, all matches in initial args should be replaced with extra args
				// read from stdin. It is possible to have multiple matches and multiple
				// extra args, and the Cartesian product is desired. To be specific, we
				// process extra args one by one, and replace all matches with the same extra
				// arg in each time.
				(Some(1), None, &options.replace)
			},
			(Some(_), None, None) | (None, Some(_), None) | (None, None, None) => {
				(options.max_args, options.max_lines, &None)
			},
			_ => {
				let _ = writeln!(
					host.stderr,
					"WARNING: -L, -n and -I/-i are mutually exclusive, but more than one were given; \
					 only the last option will be used"
				);
				let lines_index = matches
					.indices_of(options::MAX_LINES)
					.and_then(|mut v| v.next_back());
				let args_index = matches
					.indices_of(options::MAX_ARGS)
					.and_then(|mut v| v.next_back());
				let replace_index = [options::REPLACE, options::REPLACE_I]
					.iter()
					.flat_map(|o| matches.indices_of(o).and_then(|mut v| v.next_back()))
					.max();
				if lines_index > args_index && lines_index > replace_index {
					(None, options.max_lines, &None)
				} else if args_index > lines_index && args_index > replace_index {
					(options.max_args, None, &None)
				} else {
					(Some(1), None, &options.replace)
				}
			},
		};

	let delimiter = match (options.delimiter, options.null) {
		(Some(delimiter), true) => {
			if matches.indices_of(options::NULL).unwrap().next_back()
				> matches.indices_of(options::DELIMITER).unwrap().next_back()
			{
				Some(b'\0')
			} else {
				Some(delimiter)
			}
		},
		(Some(delimiter), false) => Some(delimiter),
		(None, true) => Some(b'\0'),
		// If `replace` and no delimiter specified, each line of stdin turns into a line of stdout,
		// so the input should be split at newlines only.
		(None, false) => replace.as_ref().map(|_| b'\n'),
	};

	(max_args, max_lines, replace, delimiter)
}

fn app() -> clap::Command {
	clap::Command::new("xargs")
		.version("0.8.0")
		.about("Run commands using arguments derived from standard input")
		.arg(
			Arg::new(options::COMMAND)
				.help("The command to run")
				.trailing_var_arg(true)
				.num_args(0..)
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(options::ARG_FILE)
				.short('a')
				.long(options::ARG_FILE)
				.help("Read arguments from the given file instead of stdin"),
		)
		.arg(
			Arg::new(options::DELIMITER)
				.short('d')
				.long(options::DELIMITER)
				.help("Use the given delimiter to split the input")
				.value_parser(parse_delimiter),
		)
		.arg(
			Arg::new(options::EXIT)
				.short('x')
				.long(options::EXIT)
				.help(
					"Exit if the number of arguments allowed by -L or -n do not fit into the number of \
					 allowed characters",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::MAX_ARGS)
				.short('n')
				.long(options::MAX_ARGS)
				.help(
					"Set the max number of arguments read from stdin to be passed to each command \
					 invocation (mutually exclusive with -L and -I/-i)",
				)
				.value_parser(validate_positive_usize),
		)
		.arg(
			Arg::new(options::MAX_LINES)
				.short('L')
				.long(options::MAX_LINES)
				.help(
					"Set the max number of lines from stdin to be passed to each command invocation \
					 (mutually exclusive with -n and -I/-i)",
				)
				.value_parser(validate_positive_usize),
		)
		.arg(
			Arg::new(options::MAX_PROCS)
				.short('P')
				.long(options::MAX_PROCS)
				.help("Run up to this many commands in parallel; 0 runs as many as possible")
				.value_parser(clap::value_parser!(usize)),
		)
		.arg(
			Arg::new(options::INTERACTIVE)
				.short('p')
				.long(options::INTERACTIVE)
				.help("Prompt before running each command")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_RUN_IF_EMPTY)
				.short('r')
				.long(options::NO_RUN_IF_EMPTY)
				.help("If there are no input arguments, do not run the command at all")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NULL)
				.short('0')
				.long(options::NULL)
				.help("Split the input by null terminators rather than whitespace")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::MAX_CHARS)
				.short('s')
				.long(options::MAX_CHARS)
				.help("Set the max number of characters to be passed to each invocation")
				.value_parser(validate_positive_usize),
		)
		.arg(
			Arg::new(options::VERBOSE)
				.short('t')
				.long(options::VERBOSE)
				.help("Be verbose")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::REPLACE)
				.long(options::REPLACE)
				.short('i')
				.num_args(0..=1)
				.require_equals(true)
				.value_parser(clap::value_parser!(String))
				.value_name("R")
				.help("If R is specified, the same as -I R; otherwise, the same as -I {}"),
		)
		.arg(
			Arg::new(options::REPLACE_I)
				.short('I')
				.num_args(1)
				.value_name("R")
				.help(
					"Replace R in initial arguments with names read from standard input; also, the \
					 input is split at newlines only
                    (mutually exclusive with -L and -n)",
				)
				.overrides_with(options::REPLACE)
				.value_parser(clap::value_parser!(String)),
		)
}

fn do_xargs(matches: &ArgMatches, host: &mut Host) -> Result<CommandResult, XargsError> {

	let options = Options {
		arg_file:                matches
			.get_one::<String>(options::ARG_FILE)
			.map(std::borrow::ToOwned::to_owned),
		delimiter:               matches.get_one::<u8>(options::DELIMITER).copied(),
		interactive:             matches.get_flag(options::INTERACTIVE),
		exit_if_pass_char_limit: matches.get_flag(options::EXIT),
		max_args:                matches.get_one::<usize>(options::MAX_ARGS).copied(),
		max_chars:               matches.get_one::<usize>(options::MAX_CHARS).copied(),
		max_lines:               matches.get_one::<usize>(options::MAX_LINES).copied(),
		max_procs:               match matches.get_one::<usize>(options::MAX_PROCS) {
			None => 1,
			Some(0) => usize::MAX,
			Some(&max_procs) => max_procs,
		},
		no_run_if_empty:         matches.get_flag(options::NO_RUN_IF_EMPTY),
		null:                    matches.get_flag(options::NULL),
		replace:                 [options::REPLACE_I, options::REPLACE]
			.iter()
			.find_map(|&option| {
				matches.contains_id(option).then(|| {
					matches
						.get_one::<String>(option)
						.map_or_else(|| "{}".to_string(), std::borrow::ToOwned::to_owned)
				})
			}),
		verbose:                 matches.get_flag(options::VERBOSE),
	};

	let (max_args, max_lines, replace, delimiter) = normalize_options(host, &options, matches);

	let action = match matches.get_many::<OsString>(options::COMMAND) {
		Some(args) if args.len() > 0 => {
			ExecAction::Command(args.map(std::borrow::ToOwned::to_owned).collect())
		},
		_ => ExecAction::Echo,
	};
	let env: HashMap<OsString, OsString> = host
		.env()
		.map(|(key, value)| (OsString::from(key), OsString::from(value)))
		.collect();

	let mut limiters = LimiterCollection::new();
	if let Some(max_args) = max_args {
		limiters.add(MaxArgsCommandSizeLimiter::new(max_args));
	}
	if let Some(max_lines) = max_lines {
		limiters.add(MaxLinesCommandSizeLimiter::new(max_lines));
	}
	if let Some(max_chars) = options.max_chars {
		limiters.add(MaxCharsCommandSizeLimiter::new(max_chars));
	}
	limiters.add(MaxCharsCommandSizeLimiter::new_system(&env));

	let mut builder_options =
		CommandBuilderOptions::new(action, limiters, replace.clone()).map_err(|_| {
			"Base command and environment are too large to fit into one command execution"
		})?;

	builder_options.interactive = options.interactive;
	builder_options.verbose = options.verbose;

	let args: Box<dyn ArgumentReader> = match (&options.arg_file, delimiter) {
		(Some(path), Some(delimiter)) => {
			let file = host.fs().open(host.resolve(path))
				.map_err(|e| format!("Failed to open {path}: {e}"))?;
			Box::new(ByteDelimitedArgumentReader::new(file, delimiter))
		},
		(Some(path), None) => {
			let file = host.fs().open(host.resolve(path))
				.map_err(|e| format!("Failed to open {path}: {e}"))?;
			Box::new(WhitespaceDelimitedArgumentReader::new(file))
		},
		(None, Some(delimiter)) => Box::new(ByteDelimitedArgumentReader::stdin(delimiter)),
		(None, None) => Box::new(WhitespaceDelimitedArgumentReader::stdin()),
	};

	let result = process_input(
		host,
		&builder_options,
		args,
		&InputProcessOptions::new(
			options.exit_if_pass_char_limit,
			max_args,
			max_lines,
			options.max_procs,
			options.no_run_if_empty,
		),
	)?;
	Ok(result)
}

impl Utility for Xargs {
	const NAME: &'static str = "xargs";
	const RUNS_COMMANDS: bool = true;

	fn run(self, host: &mut Host) -> i32 {
		match do_xargs(&self.matches, host) {
			Ok(CommandResult::Success) => 0,
			Ok(CommandResult::Failure) => 123,
			Err(error) => {
				let _ = writeln!(host.stderr, "xargs: {error}");
				if let XargsError::CommandExecution(command_error) = error {
					match command_error {
						CommandExecutionError::UrgentlyFailed => 124,
						CommandExecutionError::Killed { .. } => 125,
						CommandExecutionError::CannotRun(_) => 126,
						CommandExecutionError::NotFound(_) => 127,
						CommandExecutionError::ArgumentSize => 1,
					}
				} else {
					1
				}
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn make_arg_init(s: &str) -> Argument {
		Argument { arg: s.to_owned().into(), kind: ArgumentKind::Initial }
	}

	fn make_arg_hard(s: &str) -> Argument {
		Argument { arg: s.to_owned().into(), kind: ArgumentKind::HardTerminated }
	}

	fn make_arg_soft(s: &str) -> Argument {
		Argument { arg: s.to_owned().into(), kind: ArgumentKind::SoftTerminated }
	}

	#[derive(Clone)]
	struct AlwaysRejectLimiter;

	impl CommandSizeLimiter for AlwaysRejectLimiter {
		fn try_arg(
			&mut self,
			arg: Argument,
			_cursor: LimiterCursor<'_>,
		) -> Result<Argument, ExhaustedCommandSpace> {
			Err(ExhaustedCommandSpace { arg, out_of_chars: false })
		}

		fn dyn_clone(&self) -> Box<dyn CommandSizeLimiter> {
			Box::new(self.clone())
		}
	}

	fn empty_cursor() -> LimiterCursor<'static> {
		LimiterCursor { limiters: &mut [] }
	}

	enum Chunk {
		Data(&'static [u8]),
		Error(io::ErrorKind),
	}

	struct ChunkReader {
		chunks:  Vec<Chunk>,
		current: usize,
	}

	impl ChunkReader {
		fn new(chunks: Vec<Chunk>) -> Self {
			Self { chunks, current: 0 }
		}
	}

	impl Read for ChunkReader {
		fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
			if self.current >= self.chunks.len() {
				return Ok(0);
			}

			match &mut self.chunks[self.current] {
				Chunk::Data(data) => {
					let byte_count = std::cmp::min(data.len(), buf.len());
					buf[..byte_count].copy_from_slice(&(*data)[..byte_count]);
					if byte_count == data.len() {
						self.current += 1;
					} else {
						*data = &(*data)[byte_count..];
					}

					Ok(byte_count)
				},
				Chunk::Error(kind) => {
					self.current += 1;
					Err(io::Error::new(*kind, "Synthesized error"))
				},
			}
		}
	}

	#[test]
	fn test_chars_limiter() {
		let mut limiter = MaxCharsCommandSizeLimiter::new(6);
		assert!(
			limiter
				.try_arg(make_arg_hard("abc"), empty_cursor())
				.is_ok()
		);
		assert!(
			limiter
				.try_arg(make_arg_hard("abcd"), empty_cursor())
				.is_err()
		);
		assert!(limiter.try_arg(make_arg_hard("a"), empty_cursor()).is_ok());
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn large_input_is_split_into_successful_external_commands() {
		let arg_max = unsafe { libc::sysconf(libc::_SC_ARG_MAX) } as usize;
		// String bytes alone fit, but the argv pointers force multiple batches.
		// Use a real external executable so an oversized batch surfaces E2BIG.
		let count = arg_max / 256;
		let input = format!("{}\n", "x".repeat(255)).repeat(count);
		let (code, stdout, stderr) = xargs_in(
			&std::env::current_dir().unwrap(),
			&["/bin/sh", "-c", "printf \"%s\\n\" \"$#\"", "sh"],
			&input,
		)
		.await;
		assert_eq!(code, 0, "{stderr}");
		assert!(stderr.is_empty(), "{stderr}");
		let batches: Vec<usize> = stdout.lines().map(|line| line.parse().unwrap()).collect();
		assert!(batches.len() > 1, "input was not split into multiple commands");
		assert_eq!(batches.iter().sum::<usize>(), count);
		assert!(batches.iter().all(|&count| count > 0));
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn oversized_environment_rejects_command_without_panicking() {
		let arg_max = unsafe { libc::sysconf(libc::_SC_ARG_MAX) } as usize;
		// These short strings fit on their own, but their envp pointers do not.
		let names: Vec<String> = (0..arg_max / 20).map(|i| format!("XARGS_{i:08}")).collect();
		let exports: Vec<(&str, &str)> = names.iter().map(|name| (name.as_str(), "")).collect();
		let (code, stdout, stderr) =
			xargs_with_env(&std::env::temp_dir(), &["/bin/echo"], "x\n", &exports).await;
		assert_eq!(code, 1, "{stderr}");
		assert_eq!(stdout, "");
		assert!(
			stderr.contains("Base command and environment are too large"),
			"an environment that exhausts ARG_MAX must reject the base command: {stderr}"
		);
	}

	/// The command the size tests run: it prints how many input arguments
	/// its line had.
	#[cfg(target_os = "linux")]
	const COUNT_ARGS: &str = "printf \"%s\\n\" \"$#\"";

	/// The input arguments of the line `-t` traced in `trace`, all of them
	/// `WORD`s of 255 bytes.
	#[cfg(target_os = "linux")]
	fn traced_words(trace: &str) -> usize {
		trace.split(' ').filter(|word| word.len() == 255).count()
	}

	/// Asserts that `ran` holds every one of `words` once, in order.
	#[cfg(target_os = "linux")]
	fn assert_ran_once_in_order(ran: &[Vec<&str>], words: &[String]) {
		let ran: Vec<&str> = ran.concat();
		let misplaced = ran.iter().zip(words).position(|(ran, word)| *ran != word.as_str());
		assert!(
			ran.len() == words.len() && misplaced.is_none(),
			"{} arguments ran of {}; the first out of place is at {misplaced:?}",
			ran.len(),
			words.len()
		);
	}

	/// `sh` behind a symlink at a path of about 3500 bytes (the directory goes
	/// with the guard). `execve` copies the program's path onto the new stack
	/// with the command line, while xargs counts only the command line and
	/// the environment against `sysconf(_SC_ARG_MAX)`, with 2048 bytes to
	/// spare: the kernel refuses a line xargs filled, as a sandbox whose limit
	/// is below `sysconf` (gVisor) refuses every full line.
	#[cfg(target_os = "linux")]
	fn sh_at_a_long_path() -> (tempfile::TempDir, String) {
		let dir = tempfile::tempdir().expect("tempdir");
		let mut path = dir.path().to_path_buf();
		while path.as_os_str().len() < 3300 {
			path.push("d".repeat(250));
		}
		std::fs::create_dir_all(&path).expect("long directory");
		path.push("sh");
		std::os::unix::fs::symlink("/bin/sh", &path).expect("sh symlink");
		let path = path.into_os_string().into_string().expect("utf-8 path");
		assert!(path.len() < 4000, "{} bytes is too close to PATH_MAX", path.len());
		(dir, path)
	}

	/// A full line the kernel refuses as too long runs again as two halves,
	/// first half first, as GNU xargs retries it: every input argument still
	/// runs once, in order. Lines that fit (a short last one) are left whole.
	#[cfg(target_os = "linux")]
	#[tokio::test]
	async fn a_line_the_kernel_refuses_as_too_long_runs_as_halves() {
		let arg_max = unsafe { libc::sysconf(libc::_SC_ARG_MAX) } as usize;
		// More input than one line holds, so the first line is a full one.
		let words: Vec<String> = (0..arg_max / 256).map(|i| format!("{i:07}{}", "x".repeat(248))).collect();
		let input = words.join("\n") + "\n";
		let (_dir, sh) = sh_at_a_long_path();
		let (code, stdout, stderr) =
			xargs_in(&std::env::temp_dir(), &["-t", &sh, "-c", crate::host::SHOW_ARGS, "sh"], &input).await;
		// `-t` traces each line before it is tried.
		let (traces, reported): (Vec<&str>, Vec<&str>) = stderr.lines().partition(|line| line.starts_with(&sh));
		assert_eq!((code, reported), (0, vec![]), "every line runs, and nothing else is reported");
		let ran = crate::host::lines_run(&stdout);
		assert_ran_once_in_order(&ran, &words);
		let tried: Vec<usize> = traces.iter().map(|trace| traced_words(trace)).collect();
		let full = tried[0];
		assert!(
			ran[0].len() < full && tried.get(1) == Some(&(full / 2)),
			"the first, full line of {full} arguments was not refused and halved: {} ran first, and the \
			 next line tried had {:?}",
			ran[0].len(),
			tried.get(1)
		);
		let mut pieces = 0;
		assert!(
			ran.iter().any(|line| {
				pieces += line.len();
				pieces == full
			}),
			"the first lines run are not the pieces of the refused one"
		);
	}

	/// One input argument the kernel refuses even on its own is GNU's error,
	/// status 1, reported once, and nothing runs. The message names no
	/// errno: GKE Sandbox (gVisor) says `ENAMETOOLONG` where Linux says
	/// `E2BIG`.
	#[cfg(target_os = "linux")]
	#[tokio::test]
	async fn one_argument_too_long_on_its_own_is_an_error() {
		let arg_max = unsafe { libc::sysconf(libc::_SC_ARG_MAX) } as usize;
		let (_dir, sh) = sh_at_a_long_path();
		let command = [sh.as_str(), "-c", COUNT_ARGS, "sh"];
		// The longest argument xargs fits after this command, as it counts:
		// each word with its NUL and argv pointer, the environment likewise,
		// and 2048 bytes to spare. Less a margin, the kernel still refuses it,
		// for the program's path it copies besides, and on Linux for one string
		// past MAX_ARG_STRLEN (128 KiB) at the usual stack sizes.
		let word = |text: &str| text.len() + 1 + size_of::<*const u8>();
		let env: usize = std::env::vars().map(|(name, value)| word(&name) + value.len() + 1).sum();
		let room = arg_max - 2048 - env - command.iter().map(|text| word(text)).sum::<usize>();
		let input = format!("{}\n", "x".repeat(room - word("") - 64));
		let (code, stdout, stderr) = xargs_in(&std::env::temp_dir(), &command, &input).await;
		assert_eq!((code, stdout.as_str()), (1, ""), "{stderr}");
		assert_eq!(stderr, ARGUMENT_SIZE);
	}

	/// Runs `xargs ARGS true` over `input` against a system that refuses
	/// lines of more than `most` input arguments with `errno`, answering none
	/// of the first `held` lines before the last of them is asked for
	/// ([`crate::host::Refusing`]): status, stderr, and what the system was
	/// asked.
	#[cfg(unix)]
	async fn refusing(
		args: &[&str],
		input: &str,
		most: usize,
		errno: i32,
		held: usize,
	) -> (i32, String, crate::host::Refused) {
		let (runner, seen) = crate::host::Refusing::new(1, most, errno);
		let runner = runner.holding_replies_until(held);
		let argv: Vec<&str> = std::iter::once("xargs").chain(args.iter().copied()).chain(["true"]).collect();
		let (code, _, stderr) =
			crate::host::run_extra_with(&argv, input, &std::env::temp_dir(), &[], |_, _, _, _| {
				Box::new(runner)
			})
			.await;
		let seen = std::mem::take(&mut *seen.lock());
		(code, stderr, seen)
	}

	/// [`refusing`]: status, stderr, the input argument counts of the lines
	/// tried, and the arguments that ran.
	#[cfg(unix)]
	async fn refused_with(
		args: &[&str],
		input: &str,
		most: usize,
		errno: i32,
		held: usize,
	) -> (i32, String, Vec<usize>, Vec<String>) {
		let (code, stderr, seen) = refusing(args, input, most, errno, held).await;
		(code, stderr, seen.tried, seen.ran)
	}

	/// [`refused_with`] for the words `1` to `10`, one line at a time.
	#[cfg(unix)]
	async fn refused_above(most: usize, errno: i32) -> (i32, String, Vec<usize>, Vec<String>) {
		refused_with(&[], "1 2 3 4 5 6 7 8 9 10\n", most, errno, 0).await
	}

	/// What xargs prints when a single argument is refused as too long.
	#[cfg(unix)]
	const ARGUMENT_SIZE: &str = "xargs: can't call exec() due to argument size restrictions\n";

	/// A line refused down to one argument is the error: the retries stop
	/// there, and the other half never starts.
	#[cfg(unix)]
	#[tokio::test]
	async fn retries_stop_at_a_single_argument_the_system_refuses() {
		let (code, stderr, tried, ran) = refused_above(0, libc::E2BIG).await;
		assert_eq!((code, stderr.as_str()), (1, ARGUMENT_SIZE));
		assert_eq!(tried, [10, 5, 2, 1]);
		assert!(ran.is_empty(), "{ran:?}");
	}

	/// The words `0` to `count - 1`, one per input line.
	#[cfg(unix)]
	fn numbered(count: usize) -> (Vec<String>, String) {
		let words: Vec<String> = (0..count).map(|n| n.to_string()).collect();
		let input = words.join("\n") + "\n";
		(words, input)
	}

	/// Thousands of refused lines that end together (`-P 0`) are retried
	/// from one loop. Starting each retry from the reaping that found its
	/// refusal nested once per refusal ended meanwhile, and overflowed the
	/// stack.
	#[cfg(unix)]
	#[tokio::test]
	async fn thousands_of_refused_lines_ending_together_are_all_retried() {
		let (words, input) = numbered(16_384);
		let lines = words.len() / 2;
		let (code, stderr, tried, mut ran) =
			refused_with(&["-P0", "-n2"], &input, 1, libc::E2BIG, lines).await;
		assert_eq!((code, stderr.as_str()), (0, ""));
		// Each line of two is refused, and its two halves run.
		assert_eq!(tried.len(), 3 * lines);
		ran.sort_by_key(|word| word.parse::<usize>().unwrap());
		assert_eq!(ran, words);
	}

	/// The same when every retry is refused too: the first single argument
	/// refused ends xargs with its error. Whether nothing more starts once
	/// xargs has read that refusal is not checked here: thousands of replies
	/// are in flight, and xargs may rightly start a line before the refusal
	/// reaches it (see
	/// `a_lone_refusal_found_while_finishing_stops_what_is_left`).
	#[cfg(unix)]
	#[tokio::test]
	async fn thousands_of_lines_refused_down_to_one_argument_end_in_one_error() {
		let (words, input) = numbered(16_384);
		let lines = words.len() / 2;
		let (code, stderr, _, ran) = refused_with(&["-P0", "-n2"], &input, 0, libc::E2BIG, lines).await;
		assert_eq!((code, stderr.as_str()), (1, ARGUMENT_SIZE));
		assert!(ran.is_empty(), "{} arguments ran", ran.len());
	}

	/// A single argument refused while xargs waits for its last commands
	/// stops it too: a line refused after it is not split, and nothing more
	/// starts. Both lines start together (`-P 0`) and are answered together
	/// once the second is asked for, the lone `1` first.
	#[cfg(unix)]
	#[tokio::test]
	async fn a_lone_refusal_found_while_finishing_stops_what_is_left() {
		let (code, stderr, seen) = refusing(&["-P0", "-L1"], "1\n2 3 4 5\n", 0, libc::E2BIG, 2).await;
		assert_eq!((code, stderr.as_str()), (1, ARGUMENT_SIZE));
		let after = &seen.after_lone_refusal;
		assert!(after.is_empty(), "lines of {after:?} arguments started after the lone refusal");
		assert_eq!(seen.tried, [1, 4]);
		assert!(seen.ran.is_empty(), "{:?}", seen.ran);
	}

	/// `E2BIG`, and `ENAMETOOLONG` as GKE Sandbox (gVisor) says it for a
	/// line longer than `_POSIX_ARG_MAX` (4,096 bytes), split a line in
	/// halves, first half first, until each half runs. A shorter line's
	/// `ENAMETOOLONG` is a path's (a `#!` interpreter's): the shell reports
	/// it (status 126), xargs goes on (123), and the line is not split.
	#[cfg(unix)]
	#[tokio::test]
	async fn a_refused_line_is_halved_in_order_for_e2big_and_enametoolong() {
		let short: Vec<String> = (1..=10).map(|n| n.to_string()).collect();
		let long: Vec<String> = (1..=10).map(|n| format!("{n:0>1000}")).collect();
		let cases = [(libc::E2BIG, &short), (libc::E2BIG, &long), (libc::ENAMETOOLONG, &long)];
		for (errno, words) in cases {
			let input = words.join(" ") + "\n";
			let (code, stderr, tried, ran) = refused_with(&[], &input, 3, errno, 0).await;
			assert_eq!((code, stderr.as_str()), (0, ""), "errno {errno}, {} bytes", words[0].len());
			assert_eq!(tried, [10, 5, 2, 3, 5, 2, 3], "errno {errno}, {} bytes", words[0].len());
			assert_eq!(&ran, words, "errno {errno}, {} bytes", words[0].len());
		}
		let (code, stderr, tried, ran) = refused_above(3, libc::ENAMETOOLONG).await;
		assert_eq!((code, tried.as_slice()), (123, &[10][..]), "a short line's ENAMETOOLONG: {stderr}");
		assert!(ran.is_empty(), "{ran:?}");
	}

	/// Any other refusal is the shell's diagnostic and status 126, as for a
	/// command that failed: xargs goes on (status 123), and the line is not
	/// split.
	#[cfg(unix)]
	#[tokio::test]
	async fn other_refusals_are_not_split() {
		for errno in [libc::EACCES, libc::ENOEXEC, libc::ENOMEM, libc::ETXTBSY] {
			let (code, stderr, tried, ran) = refused_above(0, errno).await;
			assert_eq!((code, stderr.as_str()), (123, ""), "errno {errno}");
			assert_eq!(tried, [10], "errno {errno}");
			assert!(ran.is_empty(), "errno {errno}: {ran:?}");
		}
	}

	/// A directory inside `root` whose path is longer than `PATH_MAX`, made
	/// one level at a time through the descriptor of the one before: nothing
	/// starts in it, since the system refuses its path with `ENAMETOOLONG`.
	#[cfg(target_os = "linux")]
	fn deeper_than_path_max(root: &std::path::Path) -> std::path::PathBuf {
		use std::os::fd::{AsRawFd as _, FromRawFd as _};
		let name = "d".repeat(200);
		let levels = libc::PATH_MAX as usize / (name.len() + 1) + 1;
		let c_name = std::ffi::CString::new(name.as_str()).expect("a name");
		let mut dir = std::fs::File::open(root).expect("root");
		for _ in 0..levels {
			// SAFETY: `dir` is an open directory and `c_name` NUL-terminated.
			let made = unsafe { libc::mkdirat(dir.as_raw_fd(), c_name.as_ptr(), 0o755) };
			assert_eq!(made, 0, "mkdirat: {}", std::io::Error::last_os_error());
			// SAFETY: as above; the new descriptor is owned by the `File`.
			let fd = unsafe {
				libc::openat(dir.as_raw_fd(), c_name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)
			};
			assert!(fd >= 0, "openat: {}", std::io::Error::last_os_error());
			// SAFETY: `fd` is a descriptor just opened and owned by nothing else.
			dir = unsafe { std::fs::File::from_raw_fd(fd) };
		}
		let mut path = root.to_path_buf();
		for _ in 0..levels {
			path.push(&name);
		}
		assert!(path.as_os_str().len() >= libc::PATH_MAX as usize);
		path
	}

	/// `ENAMETOOLONG` from a working directory longer than `PATH_MAX` is not
	/// a command line too long: the line fails once, as for any other
	/// refusal, and is not split (fewer arguments cannot help).
	#[cfg(target_os = "linux")]
	#[tokio::test]
	async fn a_working_directory_past_path_max_does_not_split_a_line() {
		let dir = tempfile::tempdir().expect("tempdir");
		let deep = deeper_than_path_max(dir.path());
		let (code, stdout, stderr) = xargs_in(&deep, &["-t", "/bin/echo"], "1 2 3 4 5 6 7 8 9 10\n").await;
		let tried = stderr.lines().filter(|line| line.starts_with("/bin/echo")).count();
		assert_eq!((code, stdout.as_str(), tried), (126, "", 1), "{stderr}");
		assert_eq!(stderr.matches("File name too long").count(), 1, "{stderr}");
	}

	#[test]
	fn test_chars_limiter_asks_cursor() {
		let mut rejects: [Box<dyn CommandSizeLimiter>; 1] = [Box::new(AlwaysRejectLimiter)];
		let reject_cursor = LimiterCursor { limiters: &mut rejects };

		let mut limiter = MaxCharsCommandSizeLimiter::new(5);
		assert!(
			limiter
				.try_arg(make_arg_hard("abc"), reject_cursor)
				.is_err()
		);
		// Ensure the limiter didn't update before trying the cursor.
		assert!(
			limiter
				.try_arg(make_arg_hard("abc"), empty_cursor())
				.is_ok()
		);
	}

	#[test]
	fn test_args_limiter() {
		let mut limiter = MaxArgsCommandSizeLimiter::new(2);
		// Should not count initial arguments.
		for _ in 1..3 {
			assert!(
				limiter
					.try_arg(make_arg_init("abc"), empty_cursor())
					.is_ok()
			);
		}
		assert!(
			limiter
				.try_arg(make_arg_hard("abc"), empty_cursor())
				.is_ok()
		);
		assert!(
			limiter
				.try_arg(make_arg_hard("abc"), empty_cursor())
				.is_ok()
		);
		assert!(
			limiter
				.try_arg(make_arg_hard("abc"), empty_cursor())
				.is_err()
		);
	}

	#[test]
	fn test_args_limiter_asks_cursor() {
		let mut rejects: [Box<dyn CommandSizeLimiter>; 1] = [Box::new(AlwaysRejectLimiter)];
		let reject_cursor = LimiterCursor { limiters: &mut rejects };

		let mut limiter = MaxArgsCommandSizeLimiter::new(1);
		assert!(
			limiter
				.try_arg(make_arg_hard("abc"), reject_cursor)
				.is_err()
		);
		// Ensure the limiter didn't update before trying the cursor.
		assert!(
			limiter
				.try_arg(make_arg_hard("abc"), empty_cursor())
				.is_ok()
		);
	}

	#[test]
	fn test_lines_limiter() {
		let mut limiter = MaxLinesCommandSizeLimiter::new(2);
		assert!(
			limiter
				.try_arg(make_arg_soft("abc"), empty_cursor())
				.is_ok()
		);
		assert!(
			limiter
				.try_arg(make_arg_soft("abc"), empty_cursor())
				.is_ok()
		);
		assert!(
			limiter
				.try_arg(make_arg_soft("abc"), empty_cursor())
				.is_ok()
		);
		assert!(
			limiter
				.try_arg(make_arg_hard("abc"), empty_cursor())
				.is_ok()
		);
		assert!(
			limiter
				.try_arg(make_arg_soft("abc"), empty_cursor())
				.is_ok()
		);
		assert!(
			limiter
				.try_arg(make_arg_hard("abc"), empty_cursor())
				.is_ok()
		);
		assert!(
			limiter
				.try_arg(make_arg_soft("abc"), empty_cursor())
				.is_err()
		);
		assert!(
			limiter
				.try_arg(make_arg_hard("abc"), empty_cursor())
				.is_err()
		);
	}

	#[test]
	fn test_lines_limiter_asks_cursor() {
		let mut rejects: [Box<dyn CommandSizeLimiter>; 1] = [Box::new(AlwaysRejectLimiter)];
		let reject_cursor = LimiterCursor { limiters: &mut rejects };

		let mut limiter = MaxLinesCommandSizeLimiter::new(1);
		assert!(
			limiter
				.try_arg(make_arg_hard("abc"), reject_cursor)
				.is_err()
		);
		// Ensure the limiter didn't update before trying the cursor.
		assert!(
			limiter
				.try_arg(make_arg_hard("abc"), empty_cursor())
				.is_ok()
		);
	}

	#[test]
	fn test_whitespace_delimited_reader() {
		let mut reader = WhitespaceDelimitedArgumentReader::new(ChunkReader::new(vec![
			Chunk::Data(b"abc "),
			Chunk::Data(b" def"),
			Chunk::Data(b"\nghi\t\tj"),
			Chunk::Data(b"kl\n"),
			Chunk::Data(b"mn"),
			Chunk::Error(io::ErrorKind::Interrupted),
			Chunk::Data(b"\\\t\\ o 'ab"),
			Chunk::Data(b" \"' \"xy' z\""),
		]));
		let (mut host, _) = Host::for_test("xargs", "", ".");

		assert_eq!(reader.next(&mut host).unwrap().unwrap(), make_arg_soft("abc"));
		assert_eq!(reader.next(&mut host).unwrap().unwrap(), make_arg_hard("def"));
		assert_eq!(reader.next(&mut host).unwrap().unwrap(), make_arg_soft("ghi"));
		assert_eq!(reader.next(&mut host).unwrap().unwrap(), make_arg_hard("jkl"));
		assert_eq!(reader.next(&mut host).unwrap().unwrap(), make_arg_soft("mn\t o"));
		assert_eq!(reader.next(&mut host).unwrap().unwrap(), make_arg_soft("ab \""));
		assert_eq!(reader.next(&mut host).unwrap().unwrap(), make_arg_soft("xy' z"));
		assert_eq!(reader.next(&mut host).unwrap(), None);
	}

	#[test]
	fn test_byte_delimited_reader() {
		let mut reader = ByteDelimitedArgumentReader::new(
			ChunkReader::new(vec![
				Chunk::Data(b"ab"),
				Chunk::Error(io::ErrorKind::Interrupted),
				Chunk::Data(b"c!de!"),
				Chunk::Data(b"!ef!!gh"),
				Chunk::Data(b"!ij"),
			]),
			b'!',
		);
		let (mut host, _) = Host::for_test("xargs", "", ".");

		assert_eq!(reader.next(&mut host).unwrap().unwrap(), make_arg_hard("abc"));
		assert_eq!(reader.next(&mut host).unwrap().unwrap(), make_arg_hard("de"));
		assert_eq!(reader.next(&mut host).unwrap().unwrap(), make_arg_hard("ef"));
		assert_eq!(reader.next(&mut host).unwrap().unwrap(), make_arg_hard("gh"));
		assert_eq!(reader.next(&mut host).unwrap().unwrap(), make_arg_hard("ij"));
		assert_eq!(reader.next(&mut host).unwrap(), None);
	}

	#[test]
	fn test_delimiter_parsing() {
		assert_eq!(parse_delimiter("a").unwrap(), b'a');
		assert_eq!(parse_delimiter("\\x61").unwrap(), b'a');
		assert_eq!(parse_delimiter("\\x00061").unwrap(), b'a');
		assert_eq!(parse_delimiter("\\0141").unwrap(), b'a');
		assert_eq!(parse_delimiter("\\0000141").unwrap(), b'a');
		assert_eq!(parse_delimiter("\\n").unwrap(), b'\n');

		assert!(parse_delimiter("\\0").is_err());
		assert!(parse_delimiter("\\x").is_err());
		assert!(parse_delimiter("\\").is_err());
		assert!(parse_delimiter("abc").is_err());
	}

	/// Runs `xargs ARGV` from `cwd`, its commands served by the test runner
	/// (extras first, then programs on `PATH`).
	async fn xargs_in(cwd: &std::path::Path, argv: &[&str], stdin: &str) -> (i32, String, String) {
		xargs_with_env(cwd, argv, stdin, &[]).await
	}

	async fn xargs_with_env(
		cwd: &std::path::Path,
		argv: &[&str],
		stdin: &str,
		env: &[(&str, &str)],
	) -> (i32, String, String) {
		let argv: Vec<&str> = std::iter::once("xargs").chain(argv.iter().copied()).collect();
		crate::host::run_extra(&argv, stdin, cwd, env).await
	}

	async fn run_simple(argv: &[&str], stdin: &str) -> (i32, String, String) {
		xargs_in(&std::env::temp_dir(), argv, stdin).await
	}

	#[tokio::test]
	async fn child_stdout_is_captured_through_host() {
		let (code, out, err) = run_simple(&["echo"], "a b c\n").await;
		assert_eq!(code, 0);
		assert_eq!(out, "a b c\n");
		assert_eq!(err, "");
	}

	#[tokio::test]
	async fn max_args_batches_into_two_invocations() {
		let (code, out, _) = run_simple(&["-n", "2", "echo"], "a b c\n").await;
		assert_eq!(code, 0);
		assert_eq!(out, "a b\nc\n");
	}

	#[tokio::test]
	async fn default_mode_honors_quotes() {
		let (code, out, _) = run_simple(&["sh", "-c", "echo $#", "_"], "\"a b\" c\n").await;
		assert_eq!(code, 0);
		assert_eq!(out, "2\n");
	}

	#[tokio::test]
	async fn null_mode_preserves_spaces_and_newlines() {
		let (code, out, _) = run_simple(&["-0", "echo"], "a b\0c\nd\0").await;
		assert_eq!(code, 0);
		assert_eq!(out, "a b c\nd\n");
	}

	#[tokio::test]
	async fn replace_places_item_mid_command() {
		let (code, out, _) =
			run_simple(&["-I", "{}", "echo", "hello", "{}", "!"], "world\n").await;
		assert_eq!(code, 0);
		assert_eq!(out, "hello world !\n");
	}

	#[tokio::test]
	async fn failing_child_yields_123() {
		let (code, out, _) = run_simple(&["false"], "x\n").await;
		assert_eq!(code, 123);
		assert_eq!(out, "");
	}

	/// Contract: a builtin that runs and fails is a failed command (123) with
	/// the shell's own diagnostic, not a command that could not be run (126).
	#[tokio::test]
	async fn failing_builtin_yields_123() {
		let (code, _, err) = run_simple(&["cd"], "definitely-missing-dir\n").await;
		assert_eq!(code, 123);
		assert!(err.contains("cd:"), "got: {err:?}");
		assert!(!err.contains("could not be run"), "got: {err:?}");
	}

	#[tokio::test]
	async fn missing_command_yields_127() {
		let (code, _, err) = run_simple(&["definitely-not-a-real-command-xyz"], "x\n").await;
		assert_eq!(code, 127);
		assert_eq!(err, "xargs: definitely-not-a-real-command-xyz: No such file or directory\n");
	}

	/// A file that cannot be executed: 126 and `xargs: Command could not be
	/// run: ERROR`, as at 9058ab9d (not `xargs: NAME: strerror`).
	#[cfg(unix)]
	#[tokio::test]
	async fn unexecutable_command_yields_126() {
		let file = tempfile::NamedTempFile::new().expect("temporary command");
		let command = file.path().to_str().expect("utf8 temporary path");
		let (code, _, err) = run_simple(&[command], "x\n").await;
		let denied = io::Error::from_raw_os_error(libc::EACCES);
		assert_eq!((code, err), (126, format!("xargs: Command could not be run: {denied}\n")));
	}

	#[tokio::test]
	async fn exit_255_child_yields_124() {
		let (code, _, err) = run_simple(&["sh", "-c", "exit 255", "_"], "x\n").await;
		assert_eq!(code, 124);
		assert!(err.contains("255"), "got: {err:?}");
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn signalled_child_yields_125() {
		let (code, _, err) = run_simple(&["sh", "-c", "kill -9 $$", "_"], "x\n").await;
		assert_eq!(code, 125);
		assert_eq!(err, "xargs: sh: terminated by signal 9\n");
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn exit_137_child_yields_123_not_signal() {
		let (code, _, err) = run_simple(&["sh", "-c", "exit 137", "_"], "x\n").await;
		assert_eq!(code, 123);
		assert!(!err.contains("signal"), "got: {err:?}");
	}

	/// Contract: `-P N` runs up to N commands at once. Each command waits (up
	/// to 5s) until all three have started, which only succeeds concurrently.
	#[cfg(unix)]
	#[tokio::test]
	async fn max_procs_runs_commands_concurrently() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		let script = "touch \"$1\"; i=0; while [ \"$(ls | wc -l)\" -lt 3 ]; do i=$((i+1)); [ $i -gt \
		              500 ] && exit 1; sleep 0.01; done";
		let (code, _, err) =
			xargs_in(dir.path(), &["-n", "1", "-P", "3", "sh", "-c", script, "_"], "a b c\n").await;
		assert_eq!(code, 0, "stderr: {err:?}");
	}

	#[tokio::test]
	async fn no_run_if_empty_skips_command() {
		let (code, out, err) = run_simple(&["-r", "echo"], "").await;
		assert_eq!(code, 0);
		assert_eq!(out, "");
		assert_eq!(err, "");
	}

	#[tokio::test]
	async fn empty_input_without_r_runs_default_echo_once() {
		let (code, out, _) = run_simple(&[], "").await;
		assert_eq!(code, 0);
		assert_eq!(out, "\n");
	}

	#[tokio::test]
	async fn replace_mode_skips_empty_input_without_r() {
		let result = run_simple(&["-I", "{}", "echo", "{}"], "").await;
		assert_eq!(result, (0, String::new(), String::new()));
	}

	#[tokio::test]
	async fn verbose_echoes_command_line_to_stderr() {
		let (code, out, err) = run_simple(&["-t", "echo", "a"], "b\n").await;
		assert_eq!(code, 0);
		assert_eq!(out, "a b\n");
		assert_eq!(err, "echo a b\n");
	}

	#[tokio::test]
	async fn children_run_in_host_cwd() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		let (code, _, err) =
			xargs_in(dir.path(), &["sh", "-c", "touch \"$1\"", "_"], "made.txt\n").await;
		assert_eq!(code, 0, "stderr: {err:?}");
		assert!(dir.path().join("made.txt").exists());
	}

	#[tokio::test]
	async fn children_see_host_environment() {
		let (code, out, _) = xargs_with_env(
			&std::env::temp_dir(),
			&["sh", "-c", "echo \"$XVAR\"", "_"],
			"x\n",
			&[("XVAR", "hello")],
		)
		.await;
		assert_eq!(code, 0);
		assert_eq!(out, "hello\n");
	}

	#[tokio::test]
	async fn arg_file_resolves_against_host_cwd() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		std::fs::write(dir.path().join("items.txt"), "a b\n").expect("write items");
		let (code, out, _) = xargs_in(dir.path(), &["-a", "items.txt", "echo"], "").await;
		assert_eq!(code, 0);
		assert_eq!(out, "a b\n");
	}

	#[tokio::test]
	async fn interactive_confirmation_reads_stdin_and_prompts_stderr() {
		let dir = tempfile::TempDir::new().expect("tempdir");
		std::fs::write(dir.path().join("items.txt"), "a\n").expect("write items");
		let (code, out, err) =
			xargs_in(dir.path(), &["-a", "items.txt", "-p", "echo"], "y\n").await;
		assert_eq!(code, 0);
		assert_eq!(out, "a\n");
		assert_eq!(err, "echo a ?...");
	}
}
