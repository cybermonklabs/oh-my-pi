//! pi's extra commands for an embedding shell.
//!
//! The extras are the in-process utilities (`cat`, `sort`, `grep`, `sed`, …)
//! and the process builtins (`ps`, `top`, `sleep`, `pgrep`, `pkill`,
//! `pidwait`, `lsof`). A host fills an [`Invocation`] and awaits [`run`]; one table,
//! [`extras`], names every extra this build compiled.
//!
//! [`run`] must be awaited on a tokio runtime: synchronous utilities run on its
//! blocking pool, and process builtins use its timers.

use std::sync::LazyLock;

use futures::future::BoxFuture;

#[allow(unused_imports, reason = "the table names whichever modules the enabled features compile")]
use super::*;
pub use crate::{
	host::{CommandRunner, CommandStatus, EnvChange, Invocation, ShellCommand, SourceSnapshot},
	openfile::Fd,
	speech::{SpeechAudio, SpeechHost, SpeechOutcome, SpeechRequest, SpeechVoice},
};
#[allow(unused_imports, reason = "used by whichever table entries the enabled features compile")]
use crate::host::{AsyncUtility, Process, Utility, run_async_utility, run_process, run_utility};

/// Invokes `$callback!` with one line per extra:
/// `kind [cfg predicate] "name" type;`.
///
/// Kinds:
/// - `utility` / `async_utility`: a [`Utility`] / [`AsyncUtility`].
/// - `process`: a [`Process`] builtin.
///
/// The predicate is the cargo feature (and platform) gate the module itself
/// is compiled under.
macro_rules! for_each_extra {
	($callback:ident) => {
		$callback! {
			async_utility [feature = "util.ast-grep"] "ast-grep" ast_grep::AstGrep;
			async_utility [feature = "util.ast-grep"] "sg" ast_grep::AstGrep;
			utility [feature = "util.awk"] "awk" awk::Awk;
			utility [feature = "util.b2sum"] "b2sum" b2sum::B2sum;
			utility [feature = "util.base32"] "base32" base32::Base32;
			utility [feature = "util.base64"] "base64" base64::Base64;
			utility [feature = "util.basename"] "basename" basename::Basename;
			utility [feature = "util.cat"] "cat" cat::Cat;
			utility [all(feature = "util.chmod", unix)] "chmod" chmod::Chmod;
			utility [feature = "util.cksum"] "cksum" cksum::Cksum;
			utility [feature = "util.cmp"] "cmp" cmp::Cmp;
			utility [feature = "util.column"] "column" column::Column;
			utility [feature = "util.comm"] "comm" comm::Comm;
			utility [feature = "util.cp"] "cp" cp::Cp;
			utility [feature = "util.combine"] "combine" combine::Combine;
			utility [feature = "util.cut"] "cut" cut::Cut;
			utility [feature = "util.date"] "date" date::Date;
			utility [feature = "util.dd"] "dd" dd::Dd;
			utility [feature = "util.df"] "df" df::Df;
			utility [feature = "util.diff"] "diff" diff::Diff;
			utility [feature = "util.direnv"] "direnv" direnv::Direnv;
			utility [feature = "util.dirname"] "dirname" dirname::Dirname;
			utility [feature = "util.du"] "du" du::Du;
			async_utility [all(feature = "util.entr", any(unix, windows))] "entr" entr::Entr;
			utility [feature = "util.env"] "env" env::Env;
			utility [all(feature = "util.errno", unix)] "errno" errno::Errno;
			async_utility [feature = "util.fd"] "fd" fd::FdCli;
			utility [all(feature = "util.file", any(unix, windows))] "file" file::FileCli;
			async_utility [feature = "util.find"] "find" find::Find;
			async_utility [all(feature = "util.flock", any(unix, windows))] "flock" flock::Flock;
			utility [feature = "util.fold"] "fold" fold::Fold;
			async_utility [all(feature = "util.fswatch", any(unix, windows))] "fswatch" fswatch::Fswatch;
			async_utility [feature = "util.grep"] "grep" grep::Grep;
			async_utility [feature = "util.rg"] "rg" rg::Rg;
			utility [feature = "util.head"] "head" head::Head;
			utility [feature = "util.hostname"] "hostname" hostname::Hostname;
			utility [all(feature = "util.id", unix)] "id" id::Id;
			utility [feature = "util.ifne"] "ifne" ifne::Ifne;
			utility [feature = "util.isutf8"] "isutf8" isutf8::Isutf8;
			utility [feature = "util.jq"] "jq" jq::Jq;
			utility [feature = "util.ln"] "ln" ln::Ln;
			utility [feature = "util.ls"] "ls" ls::Ls;
			utility [feature = "util.md5"] "md5" md5::Md5;
			utility [feature = "util.md5sum"] "md5sum" md5sum::Md5sum;
			utility [feature = "util.mkdir"] "mkdir" mkdir::Mkdir;
			utility [feature = "util.mktemp"] "mktemp" mktemp::Mktemp;
			utility [feature = "util.mv"] "mv" mv::Mv;
			utility [feature = "util.nl"] "nl" nl::Nl;
			utility [feature = "util.nproc"] "nproc" nproc::Nproc;
			utility [feature = "util.od"] "od" od::Od;
			utility [all(
				feature = "util.open",
				any(target_os = "macos", target_os = "linux", windows)
			)] "open" open::Open;
			utility [all(
				feature = "util.open",
				any(target_os = "macos", target_os = "linux", windows)
			)] "xdg-open" open::Open;
			utility [all(feature = "util.open", windows)] "start" open::windows::Start;
			utility [feature = "util.paste"] "paste" paste::Paste;
			utility [feature = "util.perl"] "perl" perl::Perl;
			utility [feature = "util.printenv"] "printenv" printenv::Printenv;
			utility [feature = "util.readlink"] "readlink" readlink::Readlink;
			utility [feature = "util.realpath"] "realpath" realpath::Realpath;
			utility [feature = "util.rm"] "rm" rm::Rm;
			utility [feature = "util.rmdir"] "rmdir" rmdir::Rmdir;
			utility [all(feature = "util.rsync", any(unix, windows))] "rsync" rsync::Rsync;
			async_utility [feature = "util.say"] "say" say::Say;
			utility [feature = "util.sd"] "sd" sd::Sd;
			utility [feature = "util.sed"] "sed" sed::Sed;
			utility [feature = "util.seq"] "seq" seq::Seq;
			utility [feature = "util.sha1sum"] "sha1sum" sha1sum::Sha1sum;
			utility [feature = "util.sha224sum"] "sha224sum" sha224sum::Sha224sum;
			utility [feature = "util.sha256sum"] "sha256sum" sha256sum::Sha256sum;
			utility [feature = "util.sha384sum"] "sha384sum" sha384sum::Sha384sum;
			utility [feature = "util.sha512sum"] "sha512sum" sha512sum::Sha512sum;
			utility [feature = "util.shasum"] "shasum" shasum::Shasum;
			utility [feature = "util.sort"] "sort" sort::Sort;
			utility [feature = "util.sponge"] "sponge" sponge::Sponge;
			utility [feature = "util.stat"] "stat" stat::Stat;
			utility [feature = "util.strings"] "strings" strings::Strings;
			utility [feature = "util.tac"] "tac" tac::Tac;
			utility [feature = "util.tail"] "tail" tail::Tail;
			utility [all(feature = "util.tar", any(unix, windows))] "tar" tar::Tar;
			utility [feature = "util.tee"] "tee" tee::Tee;
			utility [feature = "util.touch"] "touch" touch::Touch;
			utility [feature = "util.tr"] "tr" tr::Tr;
			utility [feature = "util.truncate"] "truncate" truncate::Truncate;
			utility [feature = "util.ts"] "ts" ts::Ts;
			utility [feature = "util.uname"] "uname" uname::Uname;
			utility [feature = "util.uniq"] "uniq" uniq::Uniq;
			utility [feature = "util.uptime"] "uptime" uptime::Uptime;
			async_utility [all(feature = "util.watchexec", any(unix, windows))] "watchexec" watchexec::Watchexec;
			utility [feature = "util.wc"] "wc" wc::Wc;
			utility [feature = "util.which"] "which" which::WhichCli;
			utility [feature = "util.whoami"] "whoami" whoami::Whoami;
			utility [feature = "util.xargs"] "xargs" xargs::Xargs;
			utility [feature = "util.yes"] "yes" yes::Yes;
			process [feature = "util.pgrep"] "pgrep" pgrep::PgrepCommand;
			process [feature = "util.pidwait"] "pidwait" pidwait::PidwaitCommand;
			process [feature = "util.pkill"] "pkill" pkill::PkillCommand;
			process [all(
				feature = "util.lsof",
				any(target_os = "linux", target_os = "macos", target_os = "windows")
			)] "lsof" lsof::LsofCommand;
			process [feature = "util.ps"] "ps" ps::PsCommand;
			process [feature = "util.sleep"] "sleep" sleep::SleepCommand;
			process [feature = "util.top"] "top" top::TopCommand;
		}
	};
}

/// How a host runs an extra, and what it must supply.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtraKind {
	/// An in-process utility (`cat`, `sort`, `grep`, …), run by [`run`].
	Utility {
		/// The utility runs command lines (`env`, `ifne`, `xargs`, `find
		/// -exec`): give its [`Invocation::commands`] a [`CommandRunner`], or
		/// it reports that it cannot run commands.
		runs_commands: bool,
	},
	/// A process builtin (`ps`, `top`, `sleep`, `pgrep`, `pkill`,
	/// `pidwait`, `lsof`), run by [`run`].
	Process,
}

type RunFn = fn(Invocation) -> BoxFuture<'static, i32>;

type LacksFn = fn(Vec<String>) -> bool;

/// One row of the table.
struct Extra {
	name:  &'static str,
	kind:  ExtraKind,
	run:   RunFn,
	lacks: LacksFn,
}

fn utility<U: Utility>(invocation: Invocation) -> BoxFuture<'static, i32> {
	Box::pin(run_utility::<U>(invocation))
}

fn async_utility<U: AsyncUtility>(invocation: Invocation) -> BoxFuture<'static, i32> {
	Box::pin(run_async_utility::<U>(invocation))
}

fn process<P: Process>(invocation: Invocation) -> BoxFuture<'static, i32> {
	Box::pin(run_process::<P>(invocation))
}

/// clap's verdict on `argv`: an option the parser does not know.
fn unknown_argument<T: clap::Parser>(argv: &[std::ffi::OsString]) -> bool {
	matches!(T::try_parse_from(argv), Err(err) if err.kind() == clap::error::ErrorKind::UnknownArgument)
}

fn utility_lacks<U: Utility>(argv: Vec<String>) -> bool {
	utility_lacks_with::<U>(argv, |_| false)
}

fn utility_lacks_with<U: Utility>(argv: Vec<String>, unsupported: impl FnOnce(&U) -> bool) -> bool {
	U::DEFERS_TO_PATH
		&& U::rewrite_argv(argv.into_iter().map(Into::into).collect()).is_ok_and(|argv| {
			match U::try_parse_from(argv) {
				Ok(parsed) => unsupported(&parsed),
				Err(err) => err.kind() == clap::error::ErrorKind::UnknownArgument,
			}
		})
}

fn async_utility_lacks<U: AsyncUtility>(argv: Vec<String>) -> bool {
	U::rewrite_argv(argv.into_iter().map(Into::into).collect())
		.is_ok_and(|argv| unknown_argument::<U>(&argv))
}

fn process_lacks<P: Process>(argv: Vec<String>) -> bool {
	match P::try_parse_from(P::rewrite_argv(argv)) {
		Ok(parsed) => parsed.lacks_option(),
		Err(err) => err.kind() == clap::error::ErrorKind::UnknownArgument,
	}
}

macro_rules! extra_row {
	(utility, $name:literal, $ty:path) => {
		Extra {
			name: $name,
			kind:  ExtraKind::Utility { runs_commands: <$ty as Utility>::RUNS_COMMANDS },
			run:   utility::<$ty>,
			lacks: utility_lacks::<$ty>,
		}
	};
	(async_utility, $name:literal, $ty:path) => {
		Extra {
			name: $name,
			kind:  ExtraKind::Utility { runs_commands: <$ty as AsyncUtility>::RUNS_COMMANDS },
			run:   async_utility::<$ty>,
			lacks: async_utility_lacks::<$ty>,
		}
	};
	(process, $name:literal, $ty:path) => {
		Extra { name: $name, kind: ExtraKind::Process, run: process::<$ty>, lacks: process_lacks::<$ty> }
	};
}

macro_rules! extra_table {
	($($kind:ident [$cfg:meta] $name:literal $ty:path;)*) => {{
		#[allow(unused_mut, reason = "empty when no extra features are enabled")]
		let mut table = Vec::new();
		$(
			#[cfg($cfg)]
			table.push(extra_row!($kind, $name, $ty));
		)*
		table
	}};
}

/// Every extra compiled into this build.
static EXTRAS: LazyLock<Vec<Extra>> = LazyLock::new(|| for_each_extra!(extra_table));

fn find(name: &str) -> Option<&'static Extra> {
	EXTRAS.iter().find(|extra| extra.name == name)
}

/// Every extra a host must expose for pi's command set, by name, under the
/// cargo features this build enabled.
pub fn extras() -> impl Iterator<Item = (&'static str, ExtraKind)> {
	EXTRAS.iter().map(|extra| (extra.name, extra.kind))
}

/// The kind of the extra named `name`, or `None` when no extra has that name.
#[must_use]
pub fn kind(name: &str) -> Option<ExtraKind> {
	find(name).map(|extra| extra.kind)
}

/// Whether `argv` (command name first) asks the extra named `name` for an
/// option it does not implement, which a host program of that name may: the
/// shell then runs `PATH`'s program instead. `false` for any other name.
#[must_use]
pub fn lacks_option(name: &str, argv: Vec<String>) -> bool {
	#[cfg(all(feature = "util.chmod", target_os = "macos"))]
	if name == chmod::Chmod::NAME {
		return utility_lacks_with(argv, chmod::Chmod::has_acl_mode);
	}
	find(name).is_some_and(|extra| (extra.lacks)(argv))
}

/// Runs the extra named [`Invocation::name`] to completion, returning its
/// exit status: 130 once [`Invocation::cancel`] fires (unless the utility
/// reports its own end, as `rsync` does).
///
/// An unknown name reports `<name>: not a pi extra` on stderr with status
/// 127.
pub async fn run(invocation: Invocation) -> i32 {
	if let Some(extra) = find(&invocation.name) {
		return (extra.run)(invocation).await;
	}
	let Invocation { name, stdio: [_, _, stderr], .. } = invocation;
	crate::host::report_async(
		crate::openfile::OpenFile::from_fd(stderr),
		format!("{name}: not a pi extra\n"),
	)
	.await;
	127
}

#[cfg(test)]
mod tests {
	use std::{
		io::{PipeReader, PipeWriter, Read as _, Write as _},
		time::Duration,
	};

	use tokio_util::sync::CancellationToken;

	use super::{ExtraKind, Fd, Invocation, extras, kind, lacks_option, run};

	/// An invocation of `argv` with pipes on fds 0, 1, and 2 and no shell.
	/// Returns it with the write end of stdin and the read ends of stdout
	/// and stderr.
	fn piped(argv: &[&str]) -> (Invocation, PipeWriter, PipeReader, PipeReader) {
		with_pipes(Invocation::new(
			argv.iter().map(ToString::to_string).collect(),
			std::env::current_dir().expect("current dir"),
			omp_vfs::Fs::native(),
		))
	}

	/// `invocation` with pipes on fds 0, 1, and 2, returned with the write
	/// end of stdin and the read ends of stdout and stderr.
	fn with_pipes(mut invocation: Invocation) -> (Invocation, PipeWriter, PipeReader, PipeReader) {
		let (stdin_reader, stdin_writer) = std::io::pipe().expect("stdin pipe");
		let (stdout_reader, stdout_writer) = std::io::pipe().expect("stdout pipe");
		let (stderr_reader, stderr_writer) = std::io::pipe().expect("stderr pipe");
		invocation.stdio = [Fd::from(stdin_reader), Fd::from(stdout_writer), Fd::from(stderr_writer)];
		(invocation, stdin_writer, stdout_reader, stderr_reader)
	}

	fn read_all(mut reader: PipeReader) -> String {
		let mut text = String::new();
		reader.read_to_string(&mut text).expect("read pipe");
		text
	}

	/// Runs `argv` with `input` on stdin, returning status, stdout, stderr.
	async fn run_piped(argv: &[&str], input: &str) -> (i32, String, String) {
		let (invocation, mut stdin, stdout, stderr) = piped(argv);
		stdin.write_all(input.as_bytes()).expect("write stdin");
		drop(stdin);
		let code = run(invocation).await;
		(code, read_all(stdout), read_all(stderr))
	}

	fn argv(args: &[&str]) -> Vec<String> {
		args.iter().map(ToString::to_string).collect()
	}

	/// Runs `argv`, each argument the bytes the shell holds, from `cwd` with
	/// `input` on stdin, returning status, stdout, stderr as bytes.
	#[cfg(unix)]
	async fn run_os(argv: &[&[u8]], input: &[u8], cwd: &std::path::Path) -> (i32, Vec<u8>, Vec<u8>) {
		use std::{ffi::OsString, os::unix::ffi::OsStringExt as _};

		let argv = argv.iter().map(|arg| OsString::from_vec(arg.to_vec())).collect();
		let (invocation, mut stdin, mut stdout, mut stderr) =
			with_pipes(Invocation::with_os_args(argv, cwd.to_path_buf(), omp_vfs::Fs::native()));
		stdin.write_all(input).expect("write stdin");
		drop(stdin);
		let code = run(invocation).await;
		let (mut out, mut err) = (Vec::new(), Vec::new());
		stdout.read_to_end(&mut out).expect("read stdout");
		stderr.read_to_end(&mut err).expect("read stderr");
		(code, out, err)
	}

	/// [`run_os`] with nothing on stdin and the output read as text.
	#[cfg(unix)]
	async fn run_bytes(argv: &[&[u8]], cwd: &std::path::Path) -> (i32, String, String) {
		let (code, out, err) = run_os(argv, b"", cwd).await;
		(code, String::from_utf8_lossy_owned(out), String::from_utf8_lossy_owned(err))
	}

	/// Failure mode: an option only the host program has (`ps --forest`)
	/// must send the command to it, while options the extra implements, and
	/// names that are no extra, keep running in-process.
	#[cfg(all(feature = "util.cat", feature = "util.ps"))]
	#[test]
	fn lacks_option_flags_only_options_the_extra_does_not_implement() {
		assert!(lacks_option("ps", argv(&["ps", "-eo", "pid,args", "--forest"])));
		assert!(!lacks_option("ps", argv(&["ps", "-ef"])));
		assert!(lacks_option("cat", argv(&["cat", "--no-such-option", "file"])));
		assert!(!lacks_option("cat", argv(&["cat", "-n", "file"])));
		assert!(!lacks_option("cat", argv(&["cat", "--help"])));
		assert!(!lacks_option("git", argv(&["git", "--no-such-option"])));
	}

	/// Failure mode: on macOS, `basename --foo` deferred to BSD `basename`,
	/// which printed `illegal option -- -` plus its own usage. `basename` implements
	/// GNU's full option set, so unknown options must stay in-process.
	#[cfg(feature = "util.basename")]
	#[test]
	fn basename_reports_unknown_options_itself() {
		assert!(!lacks_option("basename", argv(&["basename", "--foo"])));
		assert!(!lacks_option("basename", argv(&["basename", "-x", "a"])));
	}

	#[cfg(feature = "util.sort")]
	#[tokio::test]
	async fn sort_runs_from_stdin_pipe_to_stdout_pipe() {
		let (code, out, err) = run_piped(&["sort"], "pear\napple\nfig\n").await;
		assert_eq!((code, out.as_str(), err.as_str()), (0, "apple\nfig\npear\n", ""));
	}

	#[cfg(feature = "util.head")]
	#[tokio::test]
	async fn head_takes_its_arguments() {
		let (code, out, _) = run_piped(&["head", "-n", "1"], "first\nsecond\n").await;
		assert_eq!((code, out.as_str()), (0, "first\n"));
	}

	#[cfg(feature = "util.cat")]
	#[tokio::test]
	async fn cat_reports_a_missing_file_with_its_own_status() {
		let (code, out, err) = run_piped(&["cat", "/definitely/not/here"], "").await;
		assert_eq!((code, out.as_str()), (1, ""));
		assert!(err.starts_with("cat: /definitely/not/here:"), "stderr: {err:?}");
	}

	/// Failure mode: the shell handed `cat $'\xff'` the name U+FFFD, so `cat`
	/// reported no such file where GNU's prints the file whose name is that
	/// byte. Linux only: macOS file systems refuse a name that is not UTF-8.
	#[cfg(all(target_os = "linux", feature = "util.cat"))]
	#[tokio::test]
	async fn cat_opens_a_file_whose_name_is_not_utf8() {
		use std::{ffi::OsStr, os::unix::ffi::OsStrExt as _};

		let dir = tempfile::tempdir().expect("temp dir");
		std::fs::write(dir.path().join(OsStr::from_bytes(b"\xff")), "x\n").expect("write file");
		let ran = run_bytes(&[b"cat", b"\xff"], dir.path()).await;
		assert_eq!(ran, (0, "x\n".to_owned(), String::new()));
	}

	/// Failure mode: `rm $'\xff'` aimed at a file named U+FFFD, so it failed
	/// and left the file whose name is that byte, which GNU's removes.
	#[cfg(all(target_os = "linux", feature = "util.rm"))]
	#[tokio::test]
	async fn rm_removes_a_file_whose_name_is_not_utf8() {
		use std::{ffi::OsStr, os::unix::ffi::OsStrExt as _};

		let dir = tempfile::tempdir().expect("temp dir");
		let file = dir.path().join(OsStr::from_bytes(b"\xff"));
		std::fs::write(&file, "x\n").expect("write file");
		assert_eq!(run_bytes(&[b"rm", b"\xff"], dir.path()).await, (0, String::new(), String::new()));
		assert!(std::fs::symlink_metadata(&file).is_err(), "rm left {file:?}");
	}

	/// Failure mode: a parser that reads its arguments as text, handed
	/// `$'\xff'`, answers with clap's own refusal of the bytes, which names
	/// neither the builtin nor the argument. It reads the argument as text
	/// instead, as it always has, and fails as for any argument it cannot
	/// take: a nonzero status and a message naming the builtin, for the
	/// utility `seq` and the process builtin `sleep` alike.
	#[cfg(all(unix, feature = "util.seq", feature = "util.sleep"))]
	#[tokio::test]
	async fn a_text_parser_refuses_an_argument_that_is_not_utf8() {
		let cwd = std::env::current_dir().expect("current dir");
		for name in ["seq", "sleep"] {
			let (code, out, err) = run_bytes(&[name.as_bytes(), b"\xff"], &cwd).await;
			let named = err.starts_with(&format!("{name}: "));
			assert!(code != 0 && out.is_empty() && named, "{name}: {code} {out:?} {err:?}");
		}
	}

	/// Failure mode: `ln -s $'\xff' dir` reported `cannot stat '\377'` once
	/// the name arrived as its bytes, where GNU's links `dir/\377` to it.
	#[cfg(all(target_os = "linux", feature = "util.ln"))]
	#[tokio::test]
	async fn ln_links_a_name_that_is_not_utf8_into_a_directory() {
		use std::{ffi::OsStr, os::unix::ffi::OsStrExt as _};

		let dir = tempfile::tempdir().expect("temp dir");
		std::fs::create_dir(dir.path().join("dir")).expect("make dir");
		let ran = run_bytes(&[b"ln", b"-s", b"\xff", b"dir"], dir.path()).await;
		assert_eq!(ran, (0, String::new(), String::new()));
		let link = std::fs::read_link(dir.path().join("dir").join(OsStr::from_bytes(b"\xff")));
		assert_eq!(link.expect("dir/\\377 is a link").as_os_str().as_bytes(), b"\xff");
	}

	/// Failure mode: `mktemp $'\xff'XXX` refused a template that is not
	/// UTF-8, where GNU's keeps its bytes: it creates and prints `\377` and
	/// three random characters.
	#[cfg(all(target_os = "linux", feature = "util.mktemp"))]
	#[tokio::test]
	async fn mktemp_keeps_the_bytes_of_its_template() {
		use std::{ffi::OsStr, os::unix::ffi::OsStrExt as _};

		let dir = tempfile::tempdir().expect("temp dir");
		let (code, out, err) = run_os(&[b"mktemp", b"\xffXXX"], b"", dir.path()).await;
		assert_eq!((code, err.as_slice()), (0, &b""[..]));
		let name = out.strip_suffix(b"\n").expect("one line");
		let random = name.strip_prefix(b"\xff").filter(|rest| rest.len() == 3);
		assert!(random.is_some_and(|r| r.iter().all(u8::is_ascii_alphanumeric)), "{out:?}");
		assert!(dir.path().join(OsStr::from_bytes(name)).is_file());
	}

	/// Failure mode: awk read its arguments as a lossy copy, so `caf\xb0`
	/// held U+FFFD, which `.` matches (`match(s, /f./)` 3); given their
	/// bytes, it counted the stray byte as no character (`length` 3). GNU
	/// awk 5.3.2 in C.UTF-8 counts each byte that is not part of a character
	/// as one character, and `.` does not match it.
	#[cfg(all(unix, feature = "util.awk"))]
	#[tokio::test]
	async fn awk_counts_a_byte_that_is_not_utf8_as_one_character() {
		let cwd = std::env::current_dir().expect("current dir");
		let program = b"BEGIN{print length(s), index(s, \"f\"), match(s, /f./), RLENGTH; print split(s, a, \"\"), a[4] == \"\\260\"}";
		let ran = run_bytes(&[b"awk", b"-v", b"s=caf\xb0", program], &cwd).await;
		assert_eq!(ran, (0, "4 3 0 -1\n4 1\n".to_owned(), String::new()));
	}

	/// Failure mode: given its program's bytes, awk read `\xff` in `[\xff]`
	/// as the character U+00FF, so `[\xff]` matched `ÿ` and `[^\xff]` did
	/// not. GNU awk 5.3.2 in C.UTF-8 leaves such a byte out of a bracket:
	/// `[\xff]` matches nothing and `[^\xff]` any character, neither the
	/// byte. Escapes that spell a character, `\303\251`, are that character.
	#[cfg(all(unix, feature = "util.awk"))]
	#[tokio::test]
	async fn awk_leaves_a_byte_outside_utf8_out_of_a_bracket() {
		let cwd = std::env::current_dir().expect("current dir");
		let rows: [(&[u8], &[u8], &[u8]); 7] = [
			(b"/[\xff]/", "\u{ff}\n".as_bytes(), b""),
			(b"/[\xff]/", b"\xff\n", b""),
			(b"/[\\377]/", "\u{ff}\n".as_bytes(), b""),
			(b"/[^\xff]/", "\u{ff}\n".as_bytes(), "\u{ff}\n".as_bytes()),
			(b"/[^\xff]/", b"\xff\n", b""),
			(b"/[^\xff]/", b"\xfe\n", b""),
			(b"/[\\303\\251]/", "\u{e9}\n".as_bytes(), "\u{e9}\n".as_bytes()),
		];
		for (program, input, out) in rows {
			let ran = run_os(&[b"awk", program], input, &cwd).await;
			assert_eq!(ran, (0, out.to_vec(), Vec::new()), "{program:?} {input:?}");
		}
	}

	/// Failure mode: awk named files by the lossy copy of its arguments and
	/// of its program's strings, so it did not read the file `tee`, `sort -o`
	/// or `sed w` had written for `$'t\xff'`, nor through `getline <
	/// ARGV[1]` or `-f`, and `print > "\xff"` wrote a file `cat $'\xff'` does
	/// not open. GNU awk 5.3.2 names each by its bytes.
	#[cfg(all(
		target_os = "linux",
		feature = "util.awk",
		feature = "util.tee",
		feature = "util.sort",
		feature = "util.sed"
	))]
	#[tokio::test]
	async fn awk_names_files_by_their_bytes() {
		use std::{ffi::OsStr, os::unix::ffi::OsStrExt as _};

		let dir = tempfile::tempdir().expect("temp dir");
		let path = |name: &[u8]| dir.path().join(OsStr::from_bytes(name));
		std::fs::write(dir.path().join("f"), "b\na\n").expect("write input");
		std::fs::write(path(b"p\xff"), "{print \"p\" $0}\n").expect("write program");
		let writers: [(&[&[u8]], &[u8]); 3] = [
			(&[b"tee", b"t\xff"], b"t\xff"),
			(&[b"sort", b"-o", b"s\xff", b"f"], b"s\xff"),
			(&[b"sed", b"-n", b"w w\xff", b"f"], b"w\xff"),
		];
		for (writer, name) in writers {
			assert_eq!(run_os(writer, b"q\n", dir.path()).await.0, 0, "{writer:?}");
			assert!(path(name).is_file(), "{writer:?} wrote no file {name:?}");
			let ran = run_bytes(&[b"awk", b"1", name], dir.path()).await;
			assert_eq!(ran.0, 0, "awk 1 {name:?}: {ran:?}");
		}
		let rows: [(&[&[u8]], &str); 3] = [
			(&[b"awk", b"1", b"s\xff"], "a\nb\n"),
			(&[b"awk", b"BEGIN{while ((getline l < ARGV[1]) > 0) print l}", b"t\xff"], "q\n"),
			(&[b"awk", b"-f", b"p\xff", b"f"], "pb\npa\n"),
		];
		for (argv, out) in rows {
			let ran = run_bytes(argv, dir.path()).await;
			assert_eq!(ran, (0, out.to_owned(), String::new()), "{argv:?}");
		}
		let ran = run_bytes(&[b"awk", b"{print > \"\xff\"}", b"f"], dir.path()).await;
		assert_eq!(ran, (0, String::new(), String::new()));
		assert_eq!(std::fs::read(path(b"\xff")).expect("file \\377"), b"b\na\n");
	}

	/// Failure mode: `find`, `xargs -a` and `truncate -r` read the name of
	/// their file as its lossy copy, so they did not find the directory or
	/// open the file that `mkdir` or `tee` had made for `$'\xff'`, where GNU's
	/// do.
	#[cfg(all(target_os = "linux", feature = "util.find", feature = "util.xargs", feature = "util.truncate"))]
	#[tokio::test]
	async fn find_xargs_and_truncate_name_their_files_by_their_bytes() {
		use std::{ffi::OsStr, os::unix::ffi::OsStrExt as _};

		let dir = tempfile::tempdir().expect("temp dir");
		std::fs::create_dir(dir.path().join(OsStr::from_bytes(b"e\xff"))).expect("make dir");
		std::fs::write(dir.path().join(OsStr::from_bytes(b"t\xff")), "q\n").expect("write file");
		let ran = run_bytes(&[b"find", b"e\xff", b"-type", b"d", b"-printf", b"d\\n"], dir.path()).await;
		assert_eq!(ran, (0, "d\n".to_owned(), String::new()), "find");
		let argv = [OsStr::new("xargs"), OsStr::new("-a"), OsStr::from_bytes(b"t\xff"), OsStr::new("echo")];
		let (code, out, err) = crate::host::run_extra_bytes(&argv, b"", dir.path(), &[]).await;
		assert_eq!((code, out.as_slice(), err.as_slice()), (0, &b"q\n"[..], &b""[..]), "xargs");
		let ran = run_bytes(&[b"truncate", b"-r", b"t\xff", b"x"], dir.path()).await;
		assert_eq!(ran, (0, String::new(), String::new()), "truncate");
		assert_eq!(std::fs::metadata(dir.path().join("x")).expect("file x").len(), 2);
	}

	/// Failure mode: `strings -T$'\xff'` passed the option word whole to
	/// clap, which refused it, where GNU's (binutils 2.44) reads the option
	/// and prints the file's strings.
	#[cfg(all(unix, feature = "util.strings"))]
	#[tokio::test]
	async fn strings_reads_an_option_word_that_is_not_utf8() {
		let dir = tempfile::tempdir().expect("temp dir");
		std::fs::write(dir.path().join("f"), "hello world\n").expect("write file");
		let ran = run_bytes(&[b"strings", b"-T\xff", b"f"], dir.path()).await;
		assert_eq!(ran, (0, "hello world\n".to_owned(), String::new()));
	}

	/// Failure mode: a word that is not UTF-8 after `--group` did not end
	/// that option, so `uniq` refused the `-1` after it, where GNU's skips
	/// one field and writes the groups to the output file `\377`.
	#[cfg(all(target_os = "linux", feature = "util.uniq"))]
	#[tokio::test]
	async fn uniq_takes_an_operand_that_is_not_utf8_after_an_option() {
		use std::{ffi::OsStr, os::unix::ffi::OsStrExt as _};

		let dir = tempfile::tempdir().expect("temp dir");
		std::fs::write(dir.path().join("in"), "a x\nb x\nc y\n").expect("write input");
		let ran = run_bytes(&[b"uniq", b"in", b"--group", b"\xff", b"-1"], dir.path()).await;
		assert_eq!(ran, (0, String::new(), String::new()));
		let written = std::fs::read(dir.path().join(OsStr::from_bytes(b"\xff")));
		assert_eq!(written.expect("output file \\377"), b"a x\nb x\n\nc y\n");
	}

	/// Failure mode: sed read its script as a lossy copy, so `w $'\xff'`
	/// wrote the file named U+FFFD, not the one `cat $'\xff'` opens; GNU's
	/// names the file by the byte. `W`, `s///w`, `r` and `R` take their file
	/// names the same way, from the script operand or from `-e`.
	#[cfg(all(target_os = "linux", feature = "util.sed"))]
	#[tokio::test]
	async fn sed_names_the_files_of_its_script_by_their_bytes() {
		use std::{ffi::OsStr, os::unix::ffi::OsStrExt as _};

		let dir = tempfile::tempdir().expect("temp dir");
		let named = dir.path().join(OsStr::from_bytes(b"\xff"));
		std::fs::write(dir.path().join("f"), "a\nb\n").expect("write input");
		for (script, written) in [(&b"w \xff"[..], "a\nb\n"), (b"W \xff", "a\nb\n"), (b"s/a/c/w \xff", "c\n")] {
			let _ = std::fs::remove_file(&named);
			let ran = run_bytes(&[b"sed", b"-n", script, b"f"], dir.path()).await;
			assert_eq!(ran, (0, String::new(), String::new()), "{script:?}");
			let file = std::fs::read_to_string(&named);
			assert_eq!(file.expect("file \\377").as_str(), written, "{script:?}");
		}
		std::fs::write(&named, "x\n").expect("write file");
		for (script, out) in [(&b"r \xff"[..], "a\nx\nb\nx\n"), (b"R \xff", "a\nx\nb\n")] {
			let ran = run_bytes(&[b"sed", b"-e", script, b"f"], dir.path()).await;
			assert_eq!(ran, (0, out.to_owned(), String::new()), "{script:?}");
		}
	}

	#[cfg(feature = "util.cat")]
	#[tokio::test]
	async fn cancelling_a_blocked_read_returns_130() {
		let (mut invocation, stdin, _stdout, _stderr) = piped(&["cat"]);
		let cancel = CancellationToken::new();
		invocation.cancel = Some(cancel.clone());
		let running = tokio::spawn(run(invocation));
		tokio::time::sleep(Duration::from_millis(100)).await;
		assert!(!running.is_finished(), "cat must block on its open stdin pipe");
		cancel.cancel();
		let code = tokio::time::timeout(Duration::from_secs(10), running)
			.await
			.expect("cancelled cat should end promptly")
			.expect("cat task");
		assert_eq!(code, 130);
		drop(stdin);
	}

	#[cfg(feature = "util.sleep")]
	#[tokio::test]
	async fn sleep_runs_as_a_process_builtin() {
		let (code, out, err) = run_piped(&["sleep", "0"], "").await;
		assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));
		let (code, _, err) = run_piped(&["sleep", "soon"], "").await;
		assert_eq!((code, err.as_str()), (1, "sleep: invalid time interval 'soon'\n"));
	}

	#[cfg(feature = "util.sleep")]
	#[tokio::test]
	async fn cancelling_sleep_returns_130() {
		let (mut invocation, _stdin, _stdout, _stderr) = piped(&["sleep", "100"]);
		let cancel = CancellationToken::new();
		invocation.cancel = Some(cancel.clone());
		let running = tokio::spawn(run(invocation));
		tokio::time::sleep(Duration::from_millis(50)).await;
		cancel.cancel();
		let code = tokio::time::timeout(Duration::from_secs(10), running)
			.await
			.expect("cancelled sleep should end promptly")
			.expect("sleep task");
		assert_eq!(code, 130);
	}

	#[cfg(feature = "util.env")]
	#[tokio::test]
	async fn command_running_utility_without_a_runner_says_so() {
		let (code, _, err) = run_piped(&["env", "true"], "").await;
		assert_eq!(code, 126);
		assert!(err.contains("cannot run commands"), "stderr: {err:?}");
	}

	#[cfg(feature = "util.env")]
	#[tokio::test]
	async fn command_running_utility_uses_the_injected_runner() {
		use std::ffi::OsString;

		use futures::future::BoxFuture;
		use parking_lot::Mutex;

		use super::{CommandRunner, CommandStatus, EnvChange, ShellCommand};

		type Seen = std::sync::Arc<Mutex<Vec<(Vec<OsString>, Vec<EnvChange>)>>>;
		struct Recorder(Seen);
		impl CommandRunner for Recorder {
			fn start(&mut self, command: ShellCommand) -> BoxFuture<'static, std::io::Result<CommandStatus>> {
				self.0.lock().push((command.args().to_vec(), command.env_changes().to_vec()));
				Box::pin(async { Ok(CommandStatus::Exited(3)) })
			}
		}

		let seen = Seen::default();
		let (mut invocation, stdin, stdout, stderr) = piped(&["env", "A=1", "prog", "arg"]);
		invocation.commands = Some(Box::new(Recorder(std::sync::Arc::clone(&seen))));
		drop(stdin);
		let code = run(invocation).await;
		assert_eq!((code, read_all(stdout), read_all(stderr)), (3, String::new(), String::new()));
		let seen = seen.lock();
		assert_eq!(seen.len(), 1);
		assert_eq!(seen[0].0, vec![OsString::from("prog"), OsString::from("arg")]);
		assert!(seen[0].1.contains(&EnvChange::Set("A".into(), "1".into())), "env: {:?}", seen[0].1);
	}

	#[tokio::test]
	async fn unknown_names_are_refused() {
		let (code, _, err) = run_piped(&["no-such-extra"], "").await;
		assert_eq!((code, err.as_str()), (127, "no-such-extra: not a pi extra\n"));
	}

	/// Contract: closed descriptors read as end of input and swallow output.
	#[cfg(feature = "util.cat")]
	#[tokio::test]
	async fn closed_stdio_reads_empty_and_discards() {
		let invocation = Invocation::new(
			vec!["cat".into()],
			std::env::current_dir().expect("current dir"),
			omp_vfs::Fs::native(),
		);
		assert_eq!(run(invocation).await, 0);
	}

	#[test]
	fn table_kinds() {
		let names: Vec<_> = extras().map(|(name, _)| name).collect();
		let mut unique = names.clone();
		unique.sort_unstable();
		unique.dedup();
		assert_eq!(unique.len(), names.len(), "duplicate extra names");
		assert_eq!(kind("no-such-extra"), None);

		#[cfg(feature = "util.xargs")]
		assert_eq!(kind("xargs"), Some(ExtraKind::Utility { runs_commands: true }));
		#[cfg(feature = "util.cat")]
		assert_eq!(kind("cat"), Some(ExtraKind::Utility { runs_commands: false }));
		#[cfg(feature = "util.ps")]
		assert_eq!(kind("ps"), Some(ExtraKind::Process));
		for removed in ["kill", "timeout", "nohup", "echo", "cd"] {
			assert_eq!(kind(removed), None, "{removed}");
		}
	}
}
