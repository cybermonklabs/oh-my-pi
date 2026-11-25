//! How obash takes signals as a process, compared with the real zsh
//! ([`zsh_oracle`]) and the real bash ([`process_support::real_bash`]), or
//! with goldens measured with bash 5.3.20 ([`process_support::BASH_GOLDEN`]):
//! trap functions, a signal that kills the shell or the command it waits
//! for, `INT` and `HUP` held or acted on, a program the shell runs in place
//! of itself, and what outlives the shell.

#![cfg(unix)]

mod process_support;
mod pty_support;
mod zsh_oracle;

use std::{
	ffi::{CStr, CString, OsStr, OsString},
	fmt::Write as _,
	fs,
	io::{self, Write as _},
	os::unix::{
		ffi::{OsStrExt as _, OsStringExt},
		fs::OpenOptionsExt as _,
		process::ExitStatusExt,
	},
	path::{Path, PathBuf},
	time::{Duration, Instant},
};

use process_support::{
	End::{self, Exit, Signal},
	Outcome, Run, have_zsh, real, real_bash, real_bash_golden,
};
use pty_support::{Spawn, TIMEOUT};

/// A `TRAPNAL` function is the signal's trap (zsh `settrap` with
/// `ZSIG_FUNC`): a real `SIGUSR1` sent to the shell calls `TRAPUSR1` with
/// the signal's number, and the shell goes on.
#[test]
fn a_trapnal_function_catches_a_real_signal() {
	let args = ["-f", "-c", "TRAPUSR1() { print got $1 }; kill -USR1 $$; print after"];
	let ours = Run::obash("zsh", &args).go();
	assert_eq!(
		(String::from_utf8_lossy(&ours.stdout).into_owned(), ours.code),
		(format!("got {}\nafter\n", libc::SIGUSR1), Some(0)),
		"{}",
		String::from_utf8_lossy(&ours.stderr)
	);
	if have_zsh() {
		assert_eq!(ours, Run::new(zsh_oracle::path(), "zsh", &args).go());
	}
}

/// A signal has one trap function at a time, under any of its zsh names
/// (`TRAPPOLL` and `TRAPIO` for 29 on Linux, `TRAPZERR` and `TRAPERR`):
/// defining one removes the other, as zsh's `settrap` does, so the newest
/// runs; and `unfunction` of either name removes the trap function there
/// is, so a real signal gets its default action back.
#[cfg(target_os = "linux")]
#[test]
fn a_signals_trap_function_is_one_under_any_of_its_names() {
	let newest = [
		"-f",
		"-c",
		"TRAPPOLL() { print poll $1 }; TRAPIO() { print io $1 }; kill -POLL $$; whence -w TRAPPOLL \
		 TRAPIO; print w=$?; TRAPERR() { print err }; false; TRAPZERR() { print zerr }; whence -w \
		 TRAPERR TRAPZERR; print w=$?",
	];
	let ours = Run::obash("zsh", &newest).go();
	assert_eq!(
		(String::from_utf8_lossy(&ours.stdout).into_owned(), ours.code),
		(
			"io 29\nTRAPPOLL: none\nTRAPIO: function\nw=1\nerr\nTRAPERR: none\nTRAPZERR: \
			 function\nzerr\nw=1\n"
				.to_owned(),
			Some(0)
		),
		"{}",
		String::from_utf8_lossy(&ours.stderr)
	);
	let removed = [
		"-f",
		"-c",
		"TRAPPOLL() { print poll $1 }; TRAPIO() { print io $1 }; unfunction TRAPPOLL; print unf=$?; \
		 whence -w TRAPPOLL TRAPIO; kill -POLL $$; print after",
	];
	let ours_removed = Run::obash("zsh", &removed).go();
	assert_eq!(
		(ours_removed.stdout.as_slice(), ours_removed.stderr.as_slice(), ours_removed.signal),
		(&b"unf=0\nTRAPPOLL: none\nTRAPIO: none\n"[..], &b""[..], Some(libc::SIGPOLL))
	);
	if have_zsh() {
		assert_eq!(ours, Run::new(zsh_oracle::path(), "zsh", &newest).go());
		assert_eq!(ours_removed, Run::new(zsh_oracle::path(), "zsh", &removed).go());
	}
}

/// A signal without a trap whose default action ends the shell ends the
/// shell's process by that signal, as zsh's does: its parent sees
/// `WIFSIGNALED` with the signal, not an exit with 128 + its number.
#[test]
fn an_untrapped_signal_kills_the_shell_process() {
	let args = ["-f", "-c", "print before; kill -TERM $$; print after"];
	let ours = Run::obash("zsh", &args).go();
	assert_eq!(
		(ours.stdout.as_slice(), ours.stderr.as_slice(), ours.signal),
		(&b"before\n"[..], &b""[..], Some(libc::SIGTERM))
	);
	if have_zsh() {
		assert_eq!(ours, Run::new(zsh_oracle::path(), "zsh", &args).go());
	}
}

/// A script and what the shell does with it: its standard output and how
/// it ends.
struct SignalCase<'a> {
	script: &'a str,
	stdout: &'a [u8],
	end:    End,
}

/// `err` with the pid after each `NAME: line N: ` (bash's notice of a
/// killed command or job) replaced by `PID`: each shell prints its own
/// child's. The pid's field is checked to be bash's `%5ld`: at least five
/// columns, padded with spaces on the left only up to five. A line whose
/// text there starts with no digit is another diagnostic, kept as it is.
fn mask_pids(err: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(err.len());
	for line in err.split_inclusive(|&b| b == b'\n') {
		let at = line.windows(7).position(|w| w == b": line ").and_then(|i| {
			line[i + 7..]
				.windows(2)
				.position(|w| w == b": ")
				.map(|j| i + 7 + j + 2)
		});
		let Some(at) = at else {
			out.extend_from_slice(line);
			continue;
		};
		let spaces = line[at..].iter().take_while(|&&b| b == b' ').count();
		let digits = line[at + spaces..]
			.iter()
			.take_while(|b| b.is_ascii_digit())
			.count();
		if digits == 0 {
			out.extend_from_slice(line);
			continue;
		}
		assert!(
			spaces + digits >= 5 && (spaces == 0 || spaces + digits == 5),
			"the pid is printed as `%5ld`: {:?}",
			String::from_utf8_lossy(line)
		);
		out.extend_from_slice(&line[..at]);
		out.extend_from_slice(b"PID");
		out.extend_from_slice(&line[at + spaces + digits..]);
	}
	out
}

/// `err` with each line's shell name before `: line ` replaced by `NAME`
/// (bash names a function's line `environment`, a sourced file's by the
/// file, which obash does not: a difference of every diagnostic).
fn mask_names(err: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(err.len());
	for line in err.split_inclusive(|&b| b == b'\n') {
		match line.windows(7).position(|w| w == b": line ") {
			Some(i) => {
				out.extend_from_slice(b"NAME");
				out.extend_from_slice(&line[i..]);
			},
			None => out.extend_from_slice(line),
		}
	}
	out
}

/// The C library's `strsignal` text for `sig`: the description bash prints
/// in a job notice (bash 5.3 `j_strsignal`), and obash on that platform
/// (glibc's `Killed`, Darwin's `Killed: 9`).
fn desc(sig: libc::c_int) -> String {
	static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
	let _held = LOCK
		.lock()
		.unwrap_or_else(std::sync::PoisonError::into_inner);
	// SAFETY: strsignal returns null or a NUL-terminated string, which the
	// next call may overwrite (Darwin formats into a buffer): it is copied
	// out under the lock, and nothing else in this process calls it.
	let text = unsafe { libc::strsignal(sig) };
	assert!(!text.is_null(), "strsignal({sig}) returned null");
	// SAFETY: a NUL-terminated string, read before the lock is released.
	unsafe { CStr::from_ptr(text) }
		.to_string_lossy()
		.into_owned()
}

/// bash 5.3's long notice: `bash: line N: PID `, the description of `sig`
/// ([`desc`]) padded to 27 columns (`LONGEST_SIGNAL_DESC`), the command.
fn long_notice(line: u32, sig: libc::c_int, text: &[u8]) -> Vec<u8> {
	let mut out = format!("bash: line {line}: PID {:<27}", desc(sig)).into_bytes();
	out.extend_from_slice(text);
	out.push(b'\n');
	out
}

/// bash 5.3's short notice (`print_pipeline`): the description of `sig`
/// ([`desc`]) padded to 27 columns, the command.
fn short_notice(sig: libc::c_int, text: &[u8]) -> Vec<u8> {
	let mut out = format!("{:<27}", desc(sig)).into_bytes();
	out.extend_from_slice(text);
	out.push(b'\n');
	out
}

/// A notice case: `shell` runs `script` with `-c`; its standard error is
/// `stderr` as obash must print it (pids as `PID`), and it ends by `end`.
struct NoticeCase {
	shell:  &'static str,
	script: Vec<u8>,
	stderr: Vec<u8>,
	end:    End,
}

/// A non-interactive bash reports a foreground command a signal killed
/// (`notify_of_job_status`), on its own standard error, as bash 5.3.20
/// prints it (checked-in goldens; compared live only with a bash 5.3 or
/// later, [`real_bash_golden`]): `TERM`, or a signal the shell traps
/// (`trap ''` too), prints its description (the C library's, [`desc`])
/// padded to 27 columns and the command (`print_pipeline`); `INT`, `PIPE`,
/// a command substitution and a posix shell print nothing; any other
/// signal prints `NAME: line N: `, the pid, the description padded to 27
/// columns and the command as bash prints it, here-documents and its bytes
/// as they are. `N` is bash's line when it waits: the end of the complete
/// command, a `for` header, a function body's first line. The last command
/// of the `-c` string bash runs with `exec` and no fork, so it prints
/// nothing and the shell's process dies of the signal; zsh does the same
/// (`last1`, which it passes on into the body of an `if`, a `{ }`, a `;;`
/// arm of a `case`, a `try`'s always-list and a `for` body on its last
/// word, and which a trap with an action or a trap function takes away, an
/// empty trap not), and prints no notice anywhere.
#[test]
fn bash_reports_a_foreground_command_killed_by_a_signal() {
	const K: &[u8] = b"/bin/sh -c 'kill -KILL $$'";
	const T: &[u8] = b"/bin/sh -c 'kill -TERM $$'";
	const KILLED: End = Signal(libc::SIGKILL);
	let cat = |parts: &[&[u8]]| parts.concat();
	let killed = |line| long_notice(line, libc::SIGKILL, K);
	let case =
		|shell, script: Vec<u8>, stderr: Vec<u8>, end| NoticeCase { shell, script, stderr, end };
	let bash = |script, stderr, end| case("bash", script, stderr, end);
	let zsh = |script, end| case("zsh", script, Vec::new(), end);
	let cases: Vec<NoticeCase> = vec![
		bash(cat(&[T, b"; echo st=$?"]), short_notice(libc::SIGTERM, T), Exit(0)),
		bash(
			cat(&[T, b" 2>/dev/null; echo st=$?"]),
			short_notice(libc::SIGTERM, &cat(&[T, b" 2> /dev/null"])),
			Exit(0),
		),
		bash(
			b"/bin/sh -c 'kill -USR1 $$'; echo st=$?".to_vec(),
			long_notice(1, libc::SIGUSR1, b"/bin/sh -c 'kill -USR1 $$'"),
			Exit(0),
		),
		bash(
			b"/bin/sh -c 'kill -INT $$'; /bin/sh -c 'kill -PIPE $$'; echo st=$?".to_vec(),
			Vec::new(),
			Exit(0),
		),
		bash(
			b"trap 'echo t' USR1; /bin/sh -c 'kill -USR1 $$'; echo st=$?".to_vec(),
			short_notice(libc::SIGUSR1, b"/bin/sh -c 'kill -USR1 $$'"),
			Exit(0),
		),
		bash(cat(&[b"trap '' KILL; ", K, b"; echo st=$?"]), short_notice(libc::SIGKILL, K), Exit(0)),
		bash(cat(&[b"x=$(", K, b"); echo st=$?"]), Vec::new(), Exit(0)),
		bash(
			b"true\n/bin/sh   -c 'kill -HUP $$'   ; echo st=$?".to_vec(),
			long_notice(2, libc::SIGHUP, b"/bin/sh -c 'kill -HUP $$'"),
			Exit(0),
		),
		bash(b"exec 2>&1; /bin/sh -c 'kill -ALRM $$'; echo st=$?".to_vec(), Vec::new(), Exit(0)),
		// The last command: no fork, no notice, the shell dies of it.
		bash(K.to_vec(), Vec::new(), KILLED),
		bash(cat(&[b"true && ", K]), Vec::new(), KILLED),
		bash(cat(&[b"true; ", K]), Vec::new(), KILLED),
		bash(cat(&[b"true &&\n", K]), Vec::new(), KILLED),
		bash(cat(&[b"trap '' USR1; ", K]), Vec::new(), KILLED),
		bash(cat(&[b"trap 'echo t' USR1; ", K]), killed(1), Exit(137)),
		bash(cat(&[b"! ", K]), killed(1), Exit(0)),
		// Through the shell's own standard error, not the command's.
		bash(
			cat(&[K, b" 2>/dev/null; echo st=$?"]),
			long_notice(1, libc::SIGKILL, &cat(&[K, b" 2> /dev/null"])),
			Exit(0),
		),
		bash(
			cat(&[K, b" 2>/dev/null"]),
			long_notice(1, libc::SIGKILL, &cat(&[K, b" 2> /dev/null"])),
			Exit(137),
		),
		bash(cat(&[b"set -o posix; ", K, b"; echo st=$?"]), Vec::new(), Exit(0)),
		// bash's line when it waits.
		bash(cat(&[b"{\n", K, b"\n}; echo st=$?"]), killed(3), Exit(0)),
		bash(cat(&[b"if true; then\n", K, b"\nfi; echo st=$?"]), killed(3), Exit(0)),
		bash(cat(&[b"for x in 1\ndo\n", K, b"\ndone; echo st=$?"]), killed(1), Exit(0)),
		bash(cat(&[b"f()\n{\n", K, b"\n}\nf; echo st=$?"]), killed(2), Exit(0)),
		bash(b"/bin/sh -c \\\n'kill -KILL $$'; echo st=$?".to_vec(), killed(2), Exit(0)),
		bash(
			cat(&[K, b" <<EOF\nx\nEOF\necho st=$?"]),
			long_notice(3, libc::SIGKILL, &cat(&[K, b" <<EOF\nx\nEOF\n"])),
			Exit(0),
		),
		bash(
			cat(&[K, b" \xe9x; echo st=$?"]),
			long_notice(1, libc::SIGKILL, &cat(&[K, b" \xe9x"])),
			Exit(0),
		),
		// bash forks the last command of an `if` or a `{ }`.
		bash(cat(&[b"if true; then ", K, b"; fi"]), killed(1), Exit(137)),
		bash(cat(&[b"{ ", K, b"; }"]), killed(1), Exit(137)),
		zsh(cat(&[K, b"; print st=$?"]), Exit(0)),
		zsh(b"/bin/sh -c 'kill -TERM $$'; print st=$?".to_vec(), Exit(0)),
		zsh(cat(&[b"true && ", K]), KILLED),
		zsh(cat(&[b"true; true && ", K]), KILLED),
		zsh(cat(&[b"true & ", K]), KILLED),
		// zsh's traps that take `last1` away: an action or a function.
		zsh(cat(&[b"trap 'print x' EXIT; ", K]), Exit(137)),
		zsh(cat(&[b"TRAPEXIT() { print x }; ", K]), Exit(137)),
		zsh(cat(&[b"TRAPUSR1() { print u }; ", K]), Exit(137)),
		zsh(cat(&[b"trap '' EXIT; ", K]), KILLED),
		zsh(cat(&[b"trap '' USR1; ", K]), KILLED),
		// zsh's `last1` in an `if` body, a `{ }` and a `;;` arm.
		zsh(cat(&[b"if true; then ", K, b"; fi"]), KILLED),
		zsh(cat(&[b"if true; then true; ", K, b"; fi; "]), KILLED),
		zsh(cat(&[b"if false; then true; else ", K, b"; fi"]), KILLED),
		zsh(cat(&[b"if false; then true; elif true; then ", K, b"; fi"]), KILLED),
		zsh(cat(&[b"if ", K, b"; then true; fi; print after"]), Exit(0)),
		zsh(cat(&[b"{ ", K, b" }"]), KILLED),
		zsh(cat(&[b"{ true; ", K, b"; }"]), KILLED),
		zsh(cat(&[b"{ ", K, b"; true; }"]), Exit(0)),
		zsh(cat(&[b"{ ", K, b" } > /dev/null"]), KILLED),
		zsh(cat(&[b"true && { ", K, b" }"]), KILLED),
		zsh(cat(&[b"if true; then { ", K, b" }; fi"]), KILLED),
		zsh(cat(&[b"case a in a) ", K, b";; esac"]), KILLED),
		zsh(cat(&[b"case a in (a) true; ", K, b"; esac"]), KILLED),
		zsh(cat(&[b"case a in a) ", K, b";& b) true;; esac"]), Exit(0)),
		zsh(cat(&[b"case a in a) ", K, b";| b) true;; esac"]), Exit(137)),
		// …in a `try`'s always-list (its status is the try-list's), and in a
		// `for` body on the last word (`for ((…))` never).
		zsh(cat(&[b"{ true } always { ", K, b" }"]), KILLED),
		zsh(cat(&[b"{ ", K, b" } always { true }"]), Exit(137)),
		zsh(cat(&[b"for i in 1; do ", K, b"; done"]), KILLED),
		zsh(cat(&[b"for i in 1 2; do ", K, b"; done"]), KILLED),
		zsh(cat(&[b"for a b in 1 2 3; do ", K, b"; done"]), KILLED),
		zsh(cat(&[b"for ((i = 0; i < 1; i++)); do ", K, b"; done"]), Exit(137)),
		// A here-document in the body, from the parse tree (its body follows
		// the line).
		zsh(cat(&[K, b" <<EOF\nx\nEOF"]), KILLED),
		zsh(cat(&[b"if true; then ", K, b" <<EOF\nx\nEOF\nfi"]), KILLED),
		zsh(cat(&[b"{ ", K, b" <<EOF\nx\nEOF\n}"]), KILLED),
		zsh(cat(&[b"case a in a) ", K, b" <<EOF\nx\nEOF\n;; esac"]), KILLED),
		// zsh runs a last `( … )` in place, and its last command too.
		zsh(cat(&[b"( ", K, b" )"]), KILLED),
		zsh(cat(&[b"true; ( ", K, b" )"]), KILLED),
		zsh(cat(&[b"( true; ", K, b" )"]), KILLED),
		zsh(cat(&[b"( ", K, b"; true )"]), Exit(0)),
		zsh(cat(&[b"( ( ", K, b" ) )"]), KILLED),
		zsh(cat(&[b"if true; then ( ", K, b" ); fi"]), KILLED),
		zsh(cat(&[b"( ", K, b" ) > /dev/null"]), KILLED),
		zsh(cat(&[b"{ ( ", K, b" ) }"]), KILLED),
		zsh(cat(&[b"x=1; ( ", K, b" ); print after"]), Exit(0)),
		zsh(cat(&[b"( trap 'print x' EXIT; ", K, b" )"]), Exit(137)),
	];
	let mut wrong = Vec::new();
	for NoticeCase { shell, script, stderr, end } in cases {
		let script = OsString::from_vec(script);
		let ours = Run::script(env!("CARGO_BIN_EXE_obash"), shell, &script).go();
		let shown = format!("{shell}: {script:?}");
		let got = (String::from_utf8_lossy(&mask_pids(&ours.stderr)).into_owned(), ours.end());
		let want = (String::from_utf8_lossy(&stderr).into_owned(), Some(end));
		if got != want {
			wrong.push(format!("{shown}\n  got:  {got:?}\n  want: {want:?}"));
		}
		let real = if shell == "zsh" {
			real(shell)
		} else {
			real_bash_golden()
		};
		if let Some(real) = real {
			assert_eq!(masked(&ours), masked(&Run::script(real, shell, &script).go()), "{shown}");
		}
	}
	assert!(wrong.is_empty(), "{} of the cases differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// `o` with the pids and shell names of both streams masked ([`mask_pids`],
/// [`mask_names`]).
fn masked(o: &Outcome) -> Outcome {
	let mask = |b: &[u8]| mask_names(&mask_pids(b));
	Outcome { stdout: mask(&o.stdout), stderr: mask(&o.stderr), ..o.clone() }
}

/// bash 5.3's notice of a background job a signal killed, in a
/// non-interactive shell (`notify_of_job_status`), as checked-in goldens
/// measured with bash 5.3.20 (compared live only with a bash 5.3 or later,
/// [`real_bash_golden`]): `NAME: line N: `, the pid, the description
/// ([`desc`]) padded to 27 columns and the job's command, with
/// `  (wd: DIR)` when the shell's directory is no longer the one the job
/// started in. bash prints it when it waits for that job (`wait`,
/// `wait ID`, `wait -n`; through `wait`'s own redirections), or before it
/// reads its next line of input (`shell_getc`), naming that line: of a
/// `-c` string, an `eval`'s or a trap's text (not at its end), a script
/// file or standard input (at its end too). It also reads through
/// `shell_getc` each `$( )`, `${ ;}` and `<( )` it expands (`xparse_dolparen`;
/// backquotes not), also each `$( )`, `<( )` and `>( )` of an operand it does
/// not expand (`${x:-$( )}` with `x` set, one in its `$(( ))` text too),
/// naming the line where the command's first word ends (for `[[ ]]` and
/// `(( ))` the line the construct ends on) plus one, before the command's
/// redirections; each compound
/// array assignment (`a=( … )`, `a+=( … )`, `declare -a a=( … )`), naming
/// the command's line; and `jobs` reports at its end, through its own
/// redirections, but not `jobs -r`, `-s` or `-x`. Nothing reports while a
/// trap runs that bash runs with the job list frozen (`jobs_list_frozen`):
/// a `CHLD` trap `wait` runs, an `INT` trap run as the foreground command
/// it waited for ends; `wait` reports after it
/// ([`bash_keeps_finished_jobs_while_the_job_list_is_frozen`]). A
/// `wait` without operands drops a job that had ended unreported, `jobs`
/// reports it instead, and `INT`, `TERM`, `PIPE`, a signal the shell
/// traps, an exit (137 too), a posix `-c` shell, a command substitution
/// and a subshell print nothing. Each script starts with `exec 2>&1`:
/// where a notice comes in the output shows. A job is known to have ended
/// once `kill -0` fails on it ([`GONE`]): the shell has reaped it then.
/// When the shell reaps a job a signal killed is a race (bash's `SIGCHLD`,
/// obash's poll of the program), and a line read or a `wait` without
/// operands after the reap reports or drops the job there: each row kills
/// its job on the line that waits for it, after the last line read before
/// the point the row checks. [`KILLER`]'s job dies once the shell blocks,
/// in `wait`.
#[test]
fn bash_reports_a_background_job_killed_by_a_signal() {
	/// Wait for the shell to reap job `$!`, with builtins only: a foreground
	/// program there would end with a report point (bash's `wait_for`).
	const GONE: &str = "while kill -0 $! 2>/dev/null; do :; done";
	const S: &str = "/bin/sleep 30 & kill -KILL $!";
	/// A substitution's text of one and of three newlines.
	const N1: &str = "echo a\necho b";
	const N3: &str = "echo a\n\n\necho b";
	let w = format!("{S}; {GONE}");
	let notice = |line, sig, text: &str| {
		String::from_utf8(long_notice(line, sig, text.as_bytes())).expect("ASCII")
	};
	let killed = |line| notice(line, libc::SIGKILL, "/bin/sleep 30");
	// A job that dies once the shell waits for it ([`KILLER`]).
	let ks = format!("/bin/sh -c '{KILLER}'");
	let by_ks = |line| notice(line, libc::SIGKILL, &ks);
	let cases: Vec<(String, String)> = vec![
		// When `wait` waits for it.
		(format!("{S}; wait $!; echo st=$?"), format!("{}st=137\n", killed(1))),
		(format!("{ks} & wait; echo st=$?"), format!("{}st=0\n", by_ks(1))),
		(
			"/bin/sh -c 'sleep 0.2; kill -KILL $$' & wait; echo st=$?".into(),
			format!("{}st=0\n", notice(1, libc::SIGKILL, "/bin/sh -c 'sleep 0.2; kill -KILL $$'")),
		),
		(format!("{w}; wait; echo st=$?"), "st=0\n".into()),
		(format!("{w}; wait $!; echo st=$?"), format!("{}st=137\n", killed(1))),
		(format!("{w}; wait %1; echo st=$?"), format!("{}st=137\n", killed(1))),
		(format!("{w}; wait -n; echo st=$?"), format!("{}st=137\n", killed(1))),
		(format!("{S}; wait $! 2>/dev/null; echo st=$?"), "st=137\n".into()),
		// Before the next line is read, naming it.
		(
			format!("/bin/sleep 30 &\nkill -KILL $!; {GONE}\necho next"),
			format!("{}next\n", killed(3)),
		),
		(format!("{w}; echo same\necho next"), format!("same\n{}next\n", killed(2))),
		(format!("{w}\n\n# comment\necho next"), format!("{}next\n", killed(2))),
		(format!("{w}; cat <<EOF\nbody\nEOF\necho next"), format!("body\n{}next\n", killed(4))),
		(format!("{w}\nfor i in 1 2\ndo echo $i\ndone"), format!("{}1\n2\n", killed(2))),
		(format!("{w}; eval 'echo a'\necho b"), format!("{}a\nb\n", killed(1))),
		(
			format!("trap 'echo t' USR1; {w}; kill -USR1 $$; echo after"),
			format!("{}t\nafter\n", killed(1)),
		),
		(format!("{w}\nwait $!; echo st=$?"), format!("{}st=137\n", killed(2))),
		(
			format!("{w}\nwait %1; echo st=$?"),
			format!("{}bash: line 2: wait: %1: no such job\nst=127\n", killed(2)),
		),
		// No line left to read in the `-c` string.
		(format!("{w}; echo x\n"), "x\n".into()),
		(format!("{w}; echo a &&\necho b"), "a\nb\n".into()),
		(format!("{w}; exit\necho no"), String::new()),
		// `jobs` reports it instead.
		(
			format!("{w}; jobs\necho next"),
			format!("[1]+  {:<27}/bin/sleep 30\nnext\n", desc(libc::SIGKILL)),
		),
		// The job, its text and its directory.
		(
			format!("/bin/sh -c 'kill -KILL $$' & {GONE}\necho next"),
			format!("{}next\n", notice(2, libc::SIGKILL, "/bin/sh -c 'kill -KILL $$'")),
		),
		(
			format!("/bin/sleep 30 & kill -HUP $!; {GONE}\necho next"),
			format!("{}next\n", notice(2, libc::SIGHUP, "/bin/sleep 30")),
		),
		(
			"/bin/sleep 30 & a=$!; /bin/sleep 31 & kill -KILL $a $!; while kill -0 $a 2>/dev/null || \
			 kill -0 $! 2>/dev/null; do :; done\necho next"
				.into(),
			format!(
				"{}{}next\n",
				notice(2, libc::SIGKILL, "/bin/sleep 30"),
				notice(2, libc::SIGKILL, "/bin/sleep 31")
			),
		),
		(
			"{ /bin/sleep 30; } & kill -KILL $!; wait $!; echo st=$?".into(),
			format!("{}st=137\n", notice(1, libc::SIGKILL, "{ /bin/sleep 30; }")),
		),
		(
			"/bin/sleep 30 2>/dev/null & kill -KILL $!; wait $!; echo st=$?".into(),
			format!("{}st=137\n", notice(1, libc::SIGKILL, "/bin/sleep 30 2> /dev/null")),
		),
		(
			format!("cd /; {S}; cd /tmp; {GONE}\necho next"),
			format!("{}next\n", notice(2, libc::SIGKILL, "/bin/sleep 30  (wd: /)")),
		),
		(format!("( {S}; wait $!; echo st=$? )"), format!("{}st=137\n", killed(1))),
		(format!("f() {{\n{S}\nwait $!\n}}\nf; echo st=$?"), format!("{}st=137\n", killed(3))),
		// Nothing to report.
		(format!("/bin/sh -c 'exit 137' & {GONE}\necho next"), "next\n".into()),
		(
			format!("/bin/sleep 30 & kill -TERM $!; {GONE}\njobs\necho next"),
			format!("[1]+  {:<27}/bin/sleep 30\nnext\n", desc(libc::SIGTERM)),
		),
		(
			format!("trap 'echo t' USR1; /bin/sleep 30 & kill -USR1 $!; {GONE}\necho next"),
			"next\n".into(),
		),
		(format!("set -o posix; {w}\necho next"), "next\n".into()),
		(format!("x=$({S}; wait $!; echo st=$?); echo \"$x\""), "st=137\n".into()),
		// A `CHLD` trap `wait` runs reports nothing; `wait` does after it,
		// naming its own line. So does the line after an `INT` trap run as
		// the foreground command ends (dead of `INT`, or exited).
		(
			format!("trap 'echo chld' CHLD; {ks} & wait $!; echo st=$?"),
			format!("chld\n{}st=137\n", by_ks(1)),
		),
		(
			format!("trap 'echo chld' CHLD; {ks} & wait; echo st=$?"),
			format!("chld\n{}st=0\n", by_ks(1)),
		),
		(
			format!("trap 'echo chld' CHLD; {ks} & wait -n; echo st=$?"),
			format!("chld\n{}st=137\n", by_ks(1)),
		),
		(
			format!("trap 'echo chld' CHLD\n{ks} &\nwait $!; echo st=$?"),
			format!("chld\n{}st=137\n", by_ks(3)),
		),
		(
			format!("trap 'echo int' INT; {w}; /bin/sh -c 'kill -INT $PPID; kill -INT $$'\necho next"),
			format!("int\n{}next\n", killed(2)),
		),
		(
			format!(
				"trap 'echo int' INT; {w}; /bin/sh -c 'kill -INT $PPID; exit 0'; echo same\necho next"
			),
			format!("int\nsame\n{}next\n", killed(2)),
		),
		// A substitution the shell expands: the command's line, plus one,
		// plus the newlines in its source; before its redirections.
		(
			format!("/bin/sleep 30 &\ntrue\nkill -KILL $!; {GONE}; x=$(echo in); echo \"$x\""),
			format!("{}in\n", killed(4)),
		),
		(format!("f() {{ {w}; x=$(echo in); echo \"$x\"; }}\nf"), format!("{}in\n", killed(2))),
		(format!("f() {{\n{w}\nx=$(echo in); echo \"$x\"\n}}\nf"), format!("{}in\n", killed(4))),
		(format!("{w}; cat <(echo in)"), format!("{}in\n", killed(2))),
		(format!("{w}; cat < <(echo in)"), format!("{}in\n", killed(2))),
		(format!("{w}; x=${{ echo in; }}; echo \"$x\""), format!("{}in\n", killed(2))),
		(format!("{w}; x=$(echo in); echo \"$x\"\necho next"), format!("{}in\nnext\n", killed(2))),
		(format!("{w}; x=$(echo in\necho two); echo \"$x\""), format!("{}in\ntwo\n", killed(3))),
		(
			format!("{w}; x=$(echo in\n# comment\n\necho two); echo \"$x\""),
			format!("{}in\ntwo\n", killed(5)),
		),
		(format!("{w}; x=$(\necho in); echo \"$x\""), format!("{}in\n", killed(3))),
		(format!("{w}; echo a \\\n$(echo in)"), format!("{}a in\n", killed(2))),
		(format!("{w}; x=$(y=$(echo in); echo $y); echo \"$x\""), format!("{}in\n", killed(2))),
		(format!("{w}; echo $(echo in) 2>/dev/null"), format!("{}in\n", killed(2))),
		(format!("{w}; {{ x=$(echo in); }} 2>/dev/null; echo \"$x\""), "in\n".into()),
		(format!("{w}; echo hi 2>/dev/null >$(echo /dev/stdout)"), "hi\n".into()),
		(format!("{w}; x=`echo in`; echo \"$x\""), "in\n".into()),
		(format!("{w}; (x=$(echo in); echo \"$x\")"), "in\n".into()),
		(format!("set -o posix; {w}; x=$(echo in); echo \"$x\""), "in\n".into()),
		// `jobs`, at its end, through its redirections.
		(format!("{w}; jobs -p >/dev/null; echo next"), format!("{}next\n", killed(1))),
		(format!("{w}; jobs -p 2>/dev/null >/dev/null; echo next"), "next\n".into()),
		(
			format!("{w}; /bin/sleep 30 & jobs %2; kill $!; echo next"),
			format!("[2]+  {:<27}/bin/sleep 30 &\n{}next\n", "Running", killed(1)),
		),
		// bash names the line where the simple command's first word (an
		// assignment, a word or a redirection) ends, plus one; for `[[ ]]`
		// and `(( ))` the line the construct ends on, plus one; for `for` and
		// `case` their own line plus one.
		(format!("{w}; x+=$({N1}); echo \"$x\""), format!("{}a\nb\n", killed(3))),
		(format!("{w}; a[0]=$({N1}); echo \"${{a[0]}}\""), format!("{}a\nb\n", killed(3))),
		(format!("{w}; x=$({N1}) true; echo next"), format!("{}next\n", killed(3))),
		(format!("{w}; x=${{y:-$({N1})}}; echo \"$x\""), format!("{}a\nb\n", killed(3))),
		(format!("{w}; [[ -n $({N1}) ]] && echo yes"), format!("{}yes\n", killed(3))),
		(format!("{w}; x=$({N3}); echo \"$x\""), format!("{}a\nb\n", killed(5))),
		(format!("{w}; echo $({N1})"), format!("{}a b\n", killed(2))),
		(format!("{w}; echo \"$({N1})\""), format!("{}a\nb\n", killed(2))),
		(format!("{w}; cat <({N1})"), format!("{}a\nb\n", killed(2))),
		(format!("{w}; echo ${{ {N1}; }}"), format!("{}a b\n", killed(2))),
		(format!("{w}; declare x=$({N1}); echo \"$x\""), format!("{}a\nb\n", killed(2))),
		(format!("{w}; export x=$({N1}); echo \"$x\""), format!("{}a\nb\n", killed(2))),
		(format!("{w}; f() {{ local x=$({N1}); echo \"$x\"; }}; f"), format!("{}a\nb\n", killed(2))),
		(format!("{w}; echo hi >$(echo /dev/stdout\n)"), format!("{}hi\n", killed(2))),
		(format!("{w}; cat <<< $({N1})"), format!("{}a\nb\n", killed(2))),
		(format!("{w}; for i in $({N1}); do echo $i; done"), format!("{}a\nb\n", killed(2))),
		(format!("{w}; case $({N1}) in *) echo c;; esac"), format!("{}c\n", killed(2))),
		(format!("{w}; echo $(( $(echo 1\necho) + 1 ))"), format!("{}2\n", killed(2))),
		(format!("{w}; echo ${{y:-$({N1})}}"), format!("{}a b\n", killed(2))),
		(format!("{w}; echo $({N3})"), format!("{}a b\n", killed(2))),
		(format!("{w}; x=1 y=$({N1}); echo n"), format!("{}n\n", killed(2))),
		(format!("{w}; x=$(echo 1)$({N1}); echo n"), format!("{}n\n", killed(3))),
		(format!("{w}; x=$({N1})$({N1}); echo n"), format!("{}n\n", killed(4))),
		(format!("{w}; $(echo echo\n) hi"), format!("{}hi\n", killed(3))),
		(format!("{w}; a[$(echo 1\necho)]=v; echo ${{a[1]}}"), format!("{}v\n", killed(3))),
		(format!("{w}; (( $(echo 1\necho) + 1 )); echo n"), format!("{}n\n", killed(3))),
		(format!("{w}; x=$(( $(echo 1\necho) + 1 )); echo $x"), format!("{}2\n", killed(3))),
		(format!("{w}; [[ $({N1}) == x\n|| y ]]; echo n"), format!("{}n\n", killed(4))),
		(format!("{w}; <$(echo /dev/null\n) cat; echo n"), format!("{}n\n", killed(3))),
		(format!("{w}; echo \\\n$({N1})"), format!("{}a b\n", killed(2))),
		(format!("{w}; x=1 \\\ny=$({N1}); echo n"), format!("{}n\n", killed(2))),
		(format!("{w}; f() {{\nx=$({N1})\n}}; f; echo n"), format!("{}n\n", killed(4))),
		(
			format!("{w}; for (( i=$(echo 1\necho); i<2; i++ )); do :; done; echo n"),
			format!("{}n\n", killed(2)),
		),
		(
			format!("{w}; y=$(echo 1\necho) x=$(( $(echo 1\necho) + 1 )); echo n"),
			format!("{}n\n", killed(3)),
		),
		// A compound array assignment re-parses its list: the command's line.
		(format!("{w}; a=( x y ); echo ${{a[1]}}"), format!("{}y\n", killed(1))),
		(format!("{w}\na=( x y ); echo ${{a[1]}}"), format!("{}y\n", killed(2))),
		(format!("{w}; a=( x\ny ); echo ${{a[1]}}"), format!("{}y\n", killed(1))),
		(format!("{w}; a=( $(echo in) ); echo ${{a[0]}}"), format!("{}in\n", killed(1))),
		(format!("{w}; a+=( x ); echo ${{a[0]}}"), format!("{}x\n", killed(1))),
		(format!("{w}; declare -a a=( x y ); echo ${{a[1]}}"), format!("{}y\n", killed(1))),
		(format!("{w}; declare -A a=( [k]=v ); echo ${{a[k]}}"), format!("{}v\n", killed(1))),
		// A `$( )` in an operand bash does not expand: it parses it anyway.
		(
			format!("{w}; x=set; echo ${{x:-$(echo in)}}\necho next"),
			format!("{}set\nnext\n", killed(2)),
		),
		(
			format!("{w}; x=set; echo ${{x:+$(echo in)}}\necho next"),
			format!("{}in\nnext\n", killed(2)),
		),
		(format!("{w}; x=set; echo ${{x:-$({N1})}}\necho next"), format!("{}set\nnext\n", killed(2))),
		(
			format!("{w}; x=set; echo ${{x:-`echo in`}}\necho next"),
			format!("set\n{}next\n", killed(2)),
		),
		// bash parses each `$( )`, `<( )` and `>( )` of the operand, also one
		// in a nested operand or in `$(( ))` text, but not `$(( ))` text
		// alone nor quoted text.
		(
			format!("{w}; x=set; echo ${{x:-<(echo in)}}\necho next"),
			format!("{}set\nnext\n", killed(2)),
		),
		(
			format!("{w}; x=set; echo ${{x:-$((1+$(echo 1)))}}\necho next"),
			format!("{}set\nnext\n", killed(2)),
		),
		(format!("{w}; x=set; echo ${{x:->(cat)}}\necho next"), format!("{}set\nnext\n", killed(2))),
		(
			format!("{w}; x=set; echo ${{x:-${{y:-<(echo in)}}}}\necho next"),
			format!("{}set\nnext\n", killed(2)),
		),
		(
			format!("{w}; x=set; echo ${{x:-$(( ${{y:-$(echo 1)}} ))}}\necho next"),
			format!("{}set\nnext\n", killed(2)),
		),
		(
			format!("{w}; x=set; echo ${{x:-\"$(echo in)\"}}\necho next"),
			format!("{}set\nnext\n", killed(2)),
		),
		(
			format!("{w}; x=set; echo ${{x:-$((1+1))}}\necho next"),
			format!("set\n{}next\n", killed(2)),
		),
		(
			format!("{w}; x=set; echo ${{x:-'$(echo in)'}}\necho next"),
			format!("set\n{}next\n", killed(2)),
		),
		// No report at the end of `jobs -r`, `-s` or `-x`; one at `jobs -l`'s
		// listing of the job.
		(format!("{w}; jobs -r; echo next\necho after"), format!("next\n{}after\n", killed(2))),
		(format!("{w}; jobs -s; echo next\necho after"), format!("next\n{}after\n", killed(2))),
		(
			format!("{w}; jobs -x echo hi; echo next\necho after"),
			format!("hi\nnext\n{}after\n", killed(2)),
		),
		(format!("{w}; jobs -l >/dev/null; echo next\necho after"), "next\nafter\n".into()),
	];
	let mut wrong = Vec::new();
	for (script, out) in cases {
		let script = format!("exec 2>&1; {script}");
		let ours = Run::script(env!("CARGO_BIN_EXE_obash"), "bash", &script).go();
		let got = (String::from_utf8_lossy(&mask_pids(&ours.stdout)).into_owned(), ours.end());
		if got != (out.clone(), Some(Exit(0))) {
			wrong.push(format!("{script:?}\n  got:  {got:?}\n  want: {out:?}"));
		}
		if let Some(bash) = real_bash_golden() {
			assert_eq!(masked(&ours), masked(&Run::script(bash, "bash", &script).go()), "{script:?}");
		}
	}
	// A script file and standard input: before their next line, and before
	// the read that finds their end too; each line 2 here.
	let dir = tempfile::tempdir().expect("a directory for the script");
	let path = dir.path().join("s.sh");
	let file = path.display().to_string();
	let obash = || Run::new(env!("CARGO_BIN_EXE_obash"), "bash", &[&path]);
	let obash_in = || Run::new(env!("CARGO_BIN_EXE_obash"), "bash", &[] as &[&str]).input(&path);
	for (script, before, after) in [
		(w.clone(), "", ""),
		(format!("{w}; echo x"), "x\n", ""),
		(format!("{w}\necho next"), "", "next\n"),
	] {
		fs::write(&path, format!("exec 2>&1; {script}\n")).expect("write the script");
		for (ours, name) in [(obash().go(), file.as_str()), (obash_in().go(), "bash")] {
			let out = format!(
				"{before}{name}: line 2: PID {:<27}/bin/sleep 30\n{after}",
				desc(libc::SIGKILL)
			);
			let got = (String::from_utf8_lossy(&mask_pids(&ours.stdout)).into_owned(), ours.end());
			if got != (out.clone(), Some(Exit(0))) {
				wrong.push(format!("{name} reads {script:?}\n  got:  {got:?}\n  want: {out:?}"));
			}
		}
		if let Some(bash) = real_bash_golden() {
			let theirs = Run::new(&bash, "bash", &[&path]).go();
			assert_eq!(masked(&obash().go()), masked(&theirs), "file: {script:?}");
			let theirs = Run::new(&bash, "bash", &[] as &[&str]).input(&path).go();
			assert_eq!(masked(&obash_in().go()), masked(&theirs), "stdin: {script:?}");
		}
	}
	// A substitution and `jobs` in a script file.
	for (script, line, out) in [
		(format!("{w}; x=$(echo in); echo \"$x\""), 2, "in\n"),
		(format!("{w}; x=$(echo in\necho two); echo \"$x\""), 3, "in\ntwo\n"),
		(format!("{w}; jobs -p >/dev/null; echo next"), 1, "next\n"),
	] {
		fs::write(&path, format!("exec 2>&1; {script}\n")).expect("write the script");
		let ours = obash().go();
		let want =
			format!("{file}: line {line}: PID {:<27}/bin/sleep 30\n{out}", desc(libc::SIGKILL));
		let got = (String::from_utf8_lossy(&mask_pids(&ours.stdout)).into_owned(), ours.end());
		if got != (want.clone(), Some(Exit(0))) {
			wrong.push(format!("file {script:?}\n  got:  {got:?}\n  want: {want:?}"));
		}
		if let Some(bash) = real_bash_golden() {
			let theirs = Run::new(&bash, "bash", &[&path]).go();
			assert_eq!(masked(&ours), masked(&theirs), "file: {script:?}");
		}
	}
	assert!(wrong.is_empty(), "{} of the cases differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// `out` with the pid of each line after the first of bash's notice of a
/// job of several processes (`print_pipeline` with `JLIST_LONG`: five
/// spaces, the pid as `%5ld`) replaced by `PID`, as [`mask_pids`] does for
/// the first. The pid's field is checked to be `%5ld`.
fn mask_stage_pids(out: &[u8]) -> Vec<u8> {
	let mut masked = Vec::with_capacity(out.len());
	for line in out.split_inclusive(|&b| b == b'\n') {
		let Some(rest) = line.strip_prefix(b"     ") else {
			masked.extend_from_slice(line);
			continue;
		};
		let spaces = rest.iter().take_while(|&&b| b == b' ').count();
		let digits = rest[spaces..]
			.iter()
			.take_while(|b| b.is_ascii_digit())
			.count();
		if digits == 0 {
			masked.extend_from_slice(line);
			continue;
		}
		assert!(
			spaces + digits >= 5 && (spaces == 0 || spaces + digits == 5),
			"the pid is printed as `%5ld`: {:?}",
			String::from_utf8_lossy(line)
		);
		masked.extend_from_slice(b"     PID");
		masked.extend_from_slice(&rest[spaces + digits..]);
	}
	masked
}

/// Stages of the pipelines of
/// [`bash_reports_a_pipeline_job_killed_by_a_signal`]
/// and [`bash_reports_a_foreground_pipeline_killed_by_a_signal`]: a program
/// that kills itself (`K`, `T`, `H`: with `KILL`, `TERM`, `HUP`) or exits
/// (`E0`, `E3`), one that reads its input to its end, so that the stage
/// before it has ended, then exits (`R0`, `R5`) or kills itself (`RK`, `RT`,
/// `RH`), and a group that kills its own process (`G`).
mod stage {
	pub const K: &str = "/bin/sh -c 'kill -KILL $$'";
	pub const T: &str = "/bin/sh -c 'kill -TERM $$'";
	pub const H: &str = "/bin/sh -c 'kill -HUP $$'";
	pub const E0: &str = "/bin/sh -c 'exit 0'";
	pub const E3: &str = "/bin/sh -c 'exit 3'";
	pub const R0: &str = "/bin/sh -c 'read x; exit 0'";
	pub const R5: &str = "/bin/sh -c 'read x; exit 5'";
	pub const RK: &str = "/bin/sh -c 'read x; kill -KILL $$'";
	pub const RT: &str = "/bin/sh -c 'read x; kill -TERM $$'";
	pub const RH: &str = "/bin/sh -c 'read x; kill -HUP $$'";
	pub const G: &str = "{ kill -KILL $BASHPID; }";
	pub const PF: &str = "set -o pipefail; ";
}

/// bash 5.3's long notice of a job of the processes `procs` (how each ended,
/// its command; `pretty_print_job` with `JLIST_NONINTERACTIVE`), at line
/// `line` of `name`, `tail` after the last command: the first process after
/// `NAME: line N: `, its pid, how it ended padded to 27 columns
/// (`LONGEST_SIGNAL_DESC`) and its command; each other one after five
/// spaces, its pid, how it ended padded so (nothing where the first ended
/// so), `| ` and its command. Pids as `PID` ([`mask_pids`],
/// [`mask_stage_pids`]).
fn job_notice(name: &str, line: u32, procs: &[(&str, &str)], tail: &str) -> String {
	let mut out = format!("{name}: line {line}: ");
	for (i, &(end, cmd)) in procs.iter().enumerate() {
		let _ = if i == 0 {
			write!(out, "PID {end:<27}{cmd}")
		} else if end == procs[0].0 {
			write!(out, "     PID {:<25}| {cmd}", "")
		} else {
			write!(out, "     PID {end:<27}| {cmd}")
		};
		if i + 1 == procs.len() {
			out.push_str(tail);
		}
		out.push('\n');
	}
	out
}

/// `o` with the pids of both streams masked, those of a job's other
/// processes too ([`mask_stage_pids`]), and the shell names ([`masked`]).
fn masked_stages(o: &Outcome) -> Outcome {
	let mask = |b: &[u8]| mask_names(&mask_stage_pids(&mask_pids(b)));
	Outcome { stdout: mask(&o.stdout), stderr: mask(&o.stderr), ..o.clone() }
}

/// bash 5.3's notice of a background pipeline job a signal killed, in a
/// non-interactive shell (`notify_of_job_status`), as checked-in goldens
/// measured with bash 5.3.20 (compared live only with a bash 5.3 or later,
/// [`real_bash_golden`]; bash 5.2.21 prints the same lines with the
/// descriptions padded to 24 columns, and no notice at the end of `jobs
/// -p`). The job's status is its last process's, or under `pipefail` that
/// of the last of its processes that did not succeed (`raw_job_exit_status`,
/// with the `pipefail` the job started under): a signal bash reports that
/// ended that process gets the notice, at the points
/// [`bash_reports_a_background_job_killed_by_a_signal`] lists; one that
/// ended another process, `TERM`, a trapped signal, an exit and a posix
/// `-c` shell get none. The notice lists each process on its own line
/// (`pretty_print_job`, `JLIST_NONINTERACTIVE`): the first after
/// `NAME: line N: `, with its pid as `%5ld`, how it ended (the signal's
/// description, `Done`, `Exit N`, in posix mode `Done(N)`) padded to 27
/// columns and its command; each other one after five spaces, with its pid,
/// how it ended padded so (nothing when it ended as the first did), `| `
/// and its command; `  (wd: DIR)` after the last. `jobs` lists the job
/// instead. Each script starts with `exec 2>&1`. Each stage after the first
/// reads its input to its end before it ends: the stage before it has ended
/// then. A job is known to have ended once the shell's table lists no
/// running job (`jobs -r` into `$F`, `DONE`: builtins only, as a
/// foreground program would end with a report point). A job this shell's
/// `kill` just ended is still running for bash until bash reaps it: a
/// plain `wait` with no other job running waits for it and prints its
/// notice (`wait_for_background_pids`, `jobs.c:2809-2836`), as `wait %1`
/// and `wait $!` do; with another job running bash waits for that one and
/// keeps the killed `$!` job for the next line's notice
/// (`mark_dead_jobs_as_notified`, `jobs.c:5196`; bash 5.2.21 prints that
/// one at the `wait`). Once bash reaped it before the `wait` (as it waited
/// for a foreground command, or as a `kill -0` loop ran), the `wait`
/// reports nothing and keeps the job `$!` names for the next line's notice
/// and `jobs`. obash takes a job's end in as its host reaps the program's
/// OS status, as bash does; a job its `kill` ends before each of its
/// processes is a program obash spawned (`kill %1` right after `&`, a group
/// job) has no OS status to reap, and counts as unreaped until the shell
/// waits for a foreground command, a `kill` finds the job gone or `jobs`
/// finds it done (`store::Job::unreaped`).
#[test]
fn bash_reports_a_pipeline_job_killed_by_a_signal() {
	use stage::{E0, E3, G, K, PF, R0, R5, RH, RK, RT, T};
	const DONE: &str = "while jobs -r >\"$F\"; [ -s \"$F\" ]; do :; done";
	// `DONE` with a bound: a shell that never lists the job done exits 97.
	const BOUNDED_DONE: &str = "n=0; while jobs -r >\"$F\"; [ -s \"$F\" ]; do n=$((n+1)); [ $n -le \
	                            100000 ] || exit 97; done";
	// The review's row: two processes this shell's `kill` ended.
	const PIPE: &str = "/bin/sleep 5 | /bin/sleep 6 & kill -KILL %1";
	// Until the shell reaped job `$!`, with builtins only.
	const GONE: &str = "while kill -0 $! 2>/dev/null; do :; done";
	let killed = desc(libc::SIGKILL);
	let killed = killed.as_str();
	let hangup = desc(libc::SIGHUP);
	let notice = job_notice;
	// A stage that dies once the shell waits ([`KILLER`]).
	let ks = format!("/bin/sh -c '{KILLER}'");
	let at = |line, procs: &[(&str, &str)]| notice("bash", line, procs, "");
	let cases: Vec<(String, String)> = vec![
		// `pipefail`: the last process that did not succeed decides, where
		// it is.
		(
			format!("{PF}{K} | {R0} & wait %1; echo st=$?"),
			format!("{}st=137\n", at(1, &[(killed, K), ("Done", R0)])),
		),
		(
			format!("{PF}{E0} | {RK} | {R0} & wait %1; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Done", E0), (killed, RK), ("Done", R0)])),
		),
		(
			format!("{PF}{E0} | {RK} & wait %1; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Done", E0), (killed, RK)])),
		),
		(
			format!("{PF}{G} | {R0} & wait %1; echo st=$?"),
			format!("{}st=137\n", at(1, &[(killed, G), ("Done", R0)])),
		),
		(format!("{PF}{K} | {R5} & wait %1; echo st=$?"), "st=5\n".into()),
		(format!("{PF}{K} | {RT} & wait %1; echo st=$?"), "st=143\n".into()),
		(format!("{PF}{T} | {R0} & wait %1; echo st=$?"), "st=143\n".into()),
		// Without it the last process decides.
		(
			format!("{E0} | {RK} & wait %1; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Done", E0), (killed, RK)])),
		),
		(
			format!("{E3} | {RK} & wait %1; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Exit 3", E3), (killed, RK)])),
		),
		(
			format!("{E0} | {R0} | {RK} & wait %1; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Done", E0), ("Done", R0), (killed, RK)])),
		),
		(format!("{K} | {R0} & wait %1; echo st=$?"), "st=0\n".into()),
		(format!("{E0} | {RK} | {R0} & wait %1; echo st=$?"), "st=0\n".into()),
		(format!("{G} | {R0} & wait %1; echo st=$?"), "st=0\n".into()),
		(format!("{K} | {RT} & wait %1; echo st=$?"), "st=143\n".into()),
		// Two processes killed: the second line shows how it ended only
		// where that differs from the first's.
		(
			format!("{K} | {RK} & wait %1; echo st=$?"),
			format!("{}st=137\n", at(1, &[(killed, K), (killed, RK)])),
		),
		(
			format!("{PF}{K} | {RK} & wait %1; echo st=$?"),
			format!("{}st=137\n", at(1, &[(killed, K), (killed, RK)])),
		),
		(
			format!("{K} | {RH} & wait %1; echo st=$?"),
			format!("{}st=129\n", at(1, &[(killed, K), (&hangup, RH)])),
		),
		(format!("trap 'echo t' HUP; {K} | {RH} & wait %1; echo st=$?"), "st=129\n".into()),
		// `kill %1` reaches each process (those of a job whose vproc has
		// not started them too), `kill $!` the last one.
		(
			"/bin/sleep 30 | /bin/sleep 31 & kill -KILL %1; wait %1; echo st=$?".into(),
			format!("{}st=137\n", at(1, &[(killed, "/bin/sleep 30"), (killed, "/bin/sleep 31")])),
		),
		(
			format!("{E0} | /bin/sleep 30 & kill -KILL $!; wait %1; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Done", E0), (killed, "/bin/sleep 30")])),
		),
		// A job this shell's `kill` ended: a plain `wait` reports it, as
		// `wait %1` and `wait $!` do; `jobs` lists it once it is done.
		(
			format!("{PIPE}; wait; echo st=$?"),
			format!("{}st=0\n", at(1, &[(killed, "/bin/sleep 5"), (killed, "/bin/sleep 6")])),
		),
		(
			format!("{PIPE}; wait %1; echo st=$?"),
			format!("{}st=137\n", at(1, &[(killed, "/bin/sleep 5"), (killed, "/bin/sleep 6")])),
		),
		(
			format!("{PIPE}; wait $!; echo st=$?"),
			format!("{}st=137\n", at(1, &[(killed, "/bin/sleep 5"), (killed, "/bin/sleep 6")])),
		),
		(
			format!("{PIPE}; {BOUNDED_DONE}; jobs; echo st=$?"),
			format!("[1]+  {killed:<27}/bin/sleep 5 | /bin/sleep 6\nst=0\n"),
		),
		(
			"/bin/sleep 5 & kill -KILL %1; wait; echo st=$?".into(),
			format!("{}st=0\n", at(1, &[(killed, "/bin/sleep 5")])),
		),
		(
			"/bin/sleep 2 & /bin/sleep 5 | /bin/sleep 6 & kill -KILL %2; wait; echo st=$?\necho next"
				.into(),
			format!("st=0\n{}next\n", at(2, &[(killed, "/bin/sleep 5"), (killed, "/bin/sleep 6")])),
		),
		(
			"{ /bin/sleep 30; } & kill -KILL %1; wait; echo st=$?".into(),
			format!("{}st=0\n", at(1, &[(killed, "{ /bin/sleep 30; }")])),
		),
		// Once the shell reaped the job before the `wait` (`kill -0` finds it
		// gone, `jobs -r` lists it no more), `wait` has nothing to report:
		// [`bash_reports_a_background_job_killed_by_a_signal`]'s row for a
		// program, here for a job without one and for the review's job.
		(format!("/bin/sleep 30 & kill -KILL $!; {GONE}; wait; echo st=$?"), "st=0\n".into()),
		(format!("{{ /bin/sleep 30; }} & kill -KILL %1; {GONE}; wait; echo st=$?"), "st=0\n".into()),
		(format!("{PIPE}; {BOUNDED_DONE}; wait; echo st=$?"), "st=0\n".into()),
		// bash reaps the killed job as it waits for a foreground program or
		// child (`waitchld` takes in every child that ended): `wait` reports
		// nothing and keeps the job `$!` names for the next line's notice
		// (bash 5.2.21 reports it at the `wait`).
		(
			"{ /bin/sleep 30; } & kill -KILL %1; /bin/sleep 1; wait; echo st=$?".into(),
			"st=0\n".into(),
		),
		(
			"{ /bin/sleep 30; } & kill -KILL %1; /bin/sleep 1; wait; echo st=$?\necho next".into(),
			format!("st=0\n{}next\n", at(2, &[(killed, "{ /bin/sleep 30; }")])),
		),
		(format!("{PIPE}; /bin/sleep 1; wait; echo st=$?"), "st=0\n".into()),
		(
			format!("{PIPE}; /bin/sleep 1; wait; echo st=$?\necho next"),
			format!("st=0\n{}next\n", at(2, &[(killed, "/bin/sleep 5"), (killed, "/bin/sleep 6")])),
		),
		(
			"{ /bin/sleep 30; } & kill -KILL %1; ( /bin/sleep 0.3 ); wait; echo st=$?".into(),
			"st=0\n".into(),
		),
		// The job `$!` names that bash reaped before the `wait` stays for the
		// next line and for `jobs` (`mark_dead_jobs_as_notified`); the one
		// the `wait` waited for goes (`wait_for_single_pid` marks it
		// reported), one a `TERM` ended, with no notice, too.
		(
			format!("/bin/sleep 30 & kill -KILL $!; {GONE}; wait; echo st=$?\necho next"),
			format!("st=0\n{}next\n", at(2, &[(killed, "/bin/sleep 30")])),
		),
		(
			format!("/bin/sleep 30 & kill -KILL $!; {GONE}; wait; jobs; echo end"),
			format!("[1]+  {killed:<27}/bin/sleep 30\nend\n"),
		),
		("/bin/sleep 30 & kill -TERM $!; wait; jobs; echo end".into(), "end\n".into()),
		// The job the `wait` waited for is reported once: not again at the
		// next line, and `jobs` lists it no more (bash 5.3.20 and 5.2.21).
		(
			"/bin/sleep 5 | /bin/sleep 6 & kill -KILL %1; wait; echo st=$?\necho next\njobs; echo end"
				.into(),
			format!(
				"{}st=0\nnext\nend\n",
				at(1, &[(killed, "/bin/sleep 5"), (killed, "/bin/sleep 6")])
			),
		),
		// `wait`, `wait $!`, `wait -n`; the next line read; `jobs`. A `wait`
		// without operands drops a job that ended before it (bash
		// `wait_for_background_pids`): this one's last process dies once the
		// shell waits ([`KILLER`]).
		(
			format!("{E0} | {ks} & wait; echo st=$?"),
			format!("{}st=0\n", at(1, &[("Done", E0), (killed, &ks)])),
		),
		(
			format!("{E0} | {RK} & wait $!; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Done", E0), (killed, RK)])),
		),
		(
			format!("{E0} | {RK} & wait -n; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Done", E0), (killed, RK)])),
		),
		(
			format!("{E0} | {RK} & {DONE}\necho next"),
			format!("{}next\n", at(2, &[("Done", E0), (killed, RK)])),
		),
		(
			format!("{PF}{K} | {R0} & {DONE}\necho next"),
			format!("{}next\n", at(2, &[(killed, K), ("Done", R0)])),
		),
		(
			format!("{E0} | {RK} & {DONE}; jobs -p >/dev/null; echo next"),
			format!("{}next\n", at(1, &[("Done", E0), (killed, RK)])),
		),
		(
			format!("{E0} | {RK} & {DONE}; jobs; echo next"),
			format!("[1]+  {killed:<27}{E0} | {RK}\nnext\n"),
		),
		(format!("{E0} | {RK} & {DONE}; jobs -l >/dev/null; echo next\necho after"), {
			"next\nafter\n".into()
		}),
		// The directory after the last command; a subshell's job; posix.
		(
			format!("cd /; {E0} | {RK} & cd /tmp; wait %1; echo st=$?"),
			format!("{}st=137\n", notice("bash", 1, &[("Done", E0), (killed, RK)], "  (wd: /)")),
		),
		(
			format!("( {E0} | {RK} & wait %1; echo st=$? )"),
			format!("{}st=137\n", at(1, &[("Done", E0), (killed, RK)])),
		),
		(format!("set -o posix; {E3} | {RK} & wait %1; echo st=$?"), "st=137\n".into()),
		// `|&` adds `2>&1` to the command of the process before it.
		(
			format!("{E0} |& {RK} & wait %1; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Done", &format!("{E0} 2>&1")), (killed, RK)])),
		),
		// `lastpipe` is for a pipeline bash waits for: a job's every stage
		// is a process of the job.
		(
			format!("shopt -s lastpipe; {E0} | {RK} & wait %1; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Done", E0), (killed, RK)])),
		),
	];
	// The rows whose bash output depends on bash's own timing, each with
	// bash's other output: bash reaps a job this shell's `kill` ended in its
	// `SIGCHLD` handler before the `wait` or inside it, as the job's
	// processes die before bash reaches the `wait` or after. Reaped before,
	// the `wait` reports nothing, and the job stays for the next line's
	// notice and for `jobs` (a job `TERM` ended too). bash 5.3.20 and
	// 5.2.21 print the other output when a loop before the `wait` holds
	// until bash reaped the job (as the `{GONE}` rows do). obash's output is
	// the golden; the live bash may give either.
	let raced = [
		(format!("{PIPE}; wait; echo st=$?"), "st=0\n".to_owned()),
		("/bin/sleep 5 & kill -KILL %1; wait; echo st=$?".to_owned(), "st=0\n".to_owned()),
		("{ /bin/sleep 30; } & kill -KILL %1; wait; echo st=$?".to_owned(), "st=0\n".to_owned()),
		(
			"/bin/sleep 30 & kill -TERM $!; wait; jobs; echo end".to_owned(),
			format!("[1]+  {:<27}/bin/sleep 30\nend\n", desc(libc::SIGTERM)),
		),
		(
			"/bin/sleep 5 | /bin/sleep 6 & kill -KILL %1; wait; echo st=$?\necho next\njobs; echo end"
				.to_owned(),
			format!(
				"st=0\n{}next\nend\n",
				at(2, &[(killed, "/bin/sleep 5"), (killed, "/bin/sleep 6")])
			),
		),
	];
	assert!(
		raced
			.iter()
			.all(|(row, _)| cases.iter().any(|(script, _)| script == row)),
		"each raced row is a row of the table"
	);
	let dir = tempfile::tempdir().expect("a directory for `jobs -r`");
	let file = dir.path().join("running");
	let masked = masked_stages;
	let mut wrong = Vec::new();
	for (script, out) in cases {
		let other = raced
			.iter()
			.find(|(row, _)| *row == script)
			.map(|(_, other)| other);
		let script = format!("exec 2>&1; {script}");
		let run = |shell: &OsStr| Run::script(shell, "bash", &script).env("F", &file).go();
		let ours = run(OsStr::new(env!("CARGO_BIN_EXE_obash")));
		let got = (
			String::from_utf8_lossy(&mask_stage_pids(&mask_pids(&ours.stdout))).into_owned(),
			ours.end(),
		);
		if got != (out.clone(), Some(Exit(0))) {
			wrong.push(format!("{script:?}\n  got:  {got:?}\n  want: {out:?}"));
		}
		if let Some(bash) = real_bash_golden() {
			let (ours, theirs) = (masked(&ours), masked(&run(bash.as_os_str())));
			let other = other.map(|o| Outcome { stdout: mask_names(o.as_bytes()), ..ours.clone() });
			if other.as_ref() != Some(&theirs) {
				assert_eq!(ours, theirs, "{script:?}");
			}
		}
	}
	// A script file in posix mode: an exit shows as `Done(N)`.
	let path = dir.path().join("s.sh");
	let name = path.display().to_string();
	fs::write(&path, format!("exec 2>&1; set -o posix; {E3} | {RK} & wait %1; echo st=$?\n"))
		.expect("write the script");
	let run = |shell: &OsStr| Run::new(shell, "bash", &[&path]).go();
	let ours = run(OsStr::new(env!("CARGO_BIN_EXE_obash")));
	let want = format!("{}st=137\n", notice(&name, 1, &[("Done(3)", E3), (killed, RK)], ""));
	let got = (
		String::from_utf8_lossy(&mask_stage_pids(&mask_pids(&ours.stdout))).into_owned(),
		ours.end(),
	);
	if got != (want.clone(), Some(Exit(0))) {
		wrong.push(format!("posix file\n  got:  {got:?}\n  want: {want:?}"));
	}
	if let Some(bash) = real_bash_golden() {
		assert_eq!(masked(&ours), masked(&run(bash.as_os_str())), "posix file");
	}
	// Each line names its process by the pid its program has (`$$`).
	let pids = "/bin/sh -c 'echo $$ >\"$F.1\"; exit 0' | /bin/sh -c 'echo $$ >\"$F.2\"; read x; \
	            kill -KILL $$' & wait %1";
	check_notice_pids(pids, &mut wrong);
	assert!(wrong.is_empty(), "{} of the cases differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// Pinned difference, not bash's behavior: a job that is no program obash
/// spawned (a group or subshell job), which this shell's `kill` just ended,
/// is reported at the next line read. bash 5.3.20 and 5.2.21 have not reaped
/// it then (it ends only as its `SIGCHLD` comes): for
/// `{ /bin/sleep 30; } & kill -KILL %1` and then the lines `echo next` and
/// `echo after`, both print only `next` and `after`. obash ends the job at
/// once in its kernel and prints a line-2 `Killed` notice first. Left as it
/// is: holding the notice until a foreground wait, a `kill` or `jobs` shows
/// the job reaped would delay it in an interactive shell, where bash's
/// asynchronous `SIGCHLD` has usually reaped the job by the next prompt.
/// The row asserts obash's current output, so that a change shows up here;
/// it is no bash golden.
#[test]
fn obash_reports_a_job_its_kill_ended_at_the_next_line_where_bash_reaps_later() {
	let script = "exec 2>&1; { /bin/sleep 30; } & kill -KILL %1\necho next\necho after";
	let ours = match Run::script(OsStr::new(env!("CARGO_BIN_EXE_obash")), "bash", script)
		.spawn()
		.ended_within(EVENT_LIMIT)
	{
		Ok(ours) => ours,
		Err(killed) => panic!("still running after {EVENT_LIMIT:?}: {killed:?}"),
	};
	let mut want = long_notice(2, libc::SIGKILL, b"{ /bin/sleep 30; }");
	want.extend_from_slice(b"next\nafter\n");
	assert_eq!(
		(String::from_utf8_lossy(&mask_pids(&ours.stdout)).into_owned(), ours.end()),
		(String::from_utf8_lossy(&want).into_owned(), Some(Exit(0))),
		"{script:?}"
	);
}

/// A subshell's notice names it by the pid the shell shows for it
/// everywhere else: `$BASHPID` inside it, `$!` for its job (bash 5.3.20 and
/// 5.2.21: its process's pid, compared live only with a bash 5.3 or later,
/// [`real_bash_golden`]). obash runs a subshell as a virtual process of the
/// shell's own, with no OS process: that pid is its virtual pid (2^30 and
/// up, apart from every OS pid), the one `$BASHPID`, `$!`, `jobs -l`, `kill`
/// and `wait` show and take. No row waits for anything.
#[test]
fn a_subshells_notice_names_the_pid_the_shell_shows_for_it() {
	let dir = tempfile::tempdir().expect("a directory for the pid");
	let file = dir.path().join("pid");
	let rows = [
		"( echo $BASHPID >\"$F\"; kill -QUIT $BASHPID ); read -r p <\"$F\"; echo \"pid=$p\"",
		"( /bin/sleep 5 ) & p=$!; kill -KILL %1; wait %1; echo \"pid=$p\"",
		"{ /bin/sleep 5; } & p=$!; kill -KILL $p; wait $p; echo \"pid=$p\"",
	];
	let obash = OsStr::new(env!("CARGO_BIN_EXE_obash"));
	let mut wrong = Vec::new();
	for row in rows {
		let script = format!("exec 2>&1; {row}");
		for shell in std::iter::once(obash.to_owned()).chain(real_bash_golden().map(Into::into)) {
			let _ = fs::remove_file(&file);
			let out = match Run::script(&shell, "bash", &script)
				.env("F", &file)
				.spawn()
				.ended_within(EVENT_LIMIT)
			{
				Ok(out) => out,
				Err(killed) => {
					wrong.push(format!(
						"{shell:?} {row:?}: still running after {EVENT_LIMIT:?}: {killed:?}"
					));
					continue;
				},
			};
			let text = String::from_utf8_lossy(&out.stdout).into_owned();
			let named = text.lines().find_map(|line| {
				let (_, rest) = line.split_once(": line ")?;
				let (_, rest) = rest.split_once(": ")?;
				rest.split_whitespace().next().map(str::to_owned)
			});
			let shown = text
				.lines()
				.find_map(|line| line.strip_prefix("pid="))
				.map(str::to_owned);
			if named.is_none() || named != shown {
				wrong.push(format!(
					"{shell:?} {row:?}: the notice names {named:?}, the shell shows {shown:?}\n{text}"
				));
			}
		}
	}
	assert!(wrong.is_empty(), "{} of the cases differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// bash runs the `CHLD` trap once for each process it reaps (`waitchld`
/// counts them for `run_sigchld_trap`): for each process of a pipeline job,
/// not once for the job. Checked-in goldens: bash 5.2.21 and 5.3.20 print
/// the same lines here, the notice padded to 24 and 27 columns (compared
/// live only with a bash 5.3 or later, [`real_bash_golden`]). A process
/// that ends while the trap runs is not counted (`run_pending_traps` warns
/// `bad value in trap_list[17]`), so each stage after the first ends only
/// once the trap has run for the one before it (`W1`, `W2`: the trap's
/// lines in `$F`; or once the shell is gone or a zombie, so that a shell
/// killed at the limit leaves no process holding its output). Each first
/// stage ends only once the shell sleeps, in `wait` ([`KILLER`]'s test):
/// bash runs the trap in `wait` for a child it reaps there, while one that
/// ended before `wait` may get its trap only once `wait` returns (bash on
/// macOS hung on such a row, its stage `echo x`). A foreground
/// pipeline's trap runs once the pipeline has ended (its stages read their
/// input to its end instead), and `kill %1` ends every process at once: bash
/// reaps them together. That kill is `TERM`, which gets no notice: after
/// `kill -KILL %1` the point of the notice is a race in bash (its trap run,
/// `wait`), where obash reaps the job at once.
#[test]
fn bash_runs_the_chld_trap_for_each_process_of_a_pipeline_job() {
	use stage::{E0, PF, R0};
	const TRAP: &str = "trap 'echo chld; echo >>\"$F\"' CHLD; ";
	// The shell has gone, or is a zombie its runner has not reaped yet.
	const GONE: &str =
		"case $(ps -o stat= -p $PPID 2>/dev/null | tr -d \" \") in Z*|\"\") true;; *) false;; esac";
	// Until the shell `pid` names sleeps, is a zombie or is gone.
	let sleeps = |pid: &str| {
		format!(
			"until case $(ps -o stat= -p {pid} 2>/dev/null | tr -d \" \") in S*|Z*|\"\") true;; *) \
			 false;; esac; do sleep 0.01; done"
		)
	};
	// A first stage: a program that ends so once the shell sleeps, and a
	// group (the shell's own fork, whose `$$` is the shell's).
	let first = |end: &str| format!("/bin/sh -c '{}; {end}'", sleeps("$PPID"));
	let group = |cmd: &str| format!("{{ {}; {cmd}; }}", sleeps("$$"));
	let e0 = first("exit 0");
	let k = first("kill -KILL $$");
	let echo = group("echo x");
	let ext = group(E0);
	let w1 = format!("/bin/sh -c 'until [ -s \"$F\" ] || {GONE}; do sleep 0.01; done'");
	let w2 = format!(
		"/bin/sh -c 'until [ -s \"$F\" ] && [ \"$(wc -l <\"$F\")\" -ge 2 ] || {GONE}; do sleep \
		 0.01; done'"
	);
	let w1k =
		format!("/bin/sh -c 'until [ -s \"$F\" ] || {GONE}; do sleep 0.01; done; kill -KILL $$'");
	let killed = desc(libc::SIGKILL);
	let killed = killed.as_str();
	let at = |procs: &[(&str, &str)]| job_notice("bash", 1, procs, "");
	let cases: Vec<(String, String)> = vec![
		(format!("{TRAP}{e0} | {w1} & wait %1; echo st=$?"), "chld\nchld\nst=0\n".into()),
		(
			format!("{PF}{TRAP}{e0} | {w1} | {w2} & wait %1; echo st=$?"),
			"chld\nchld\nchld\nst=0\n".into(),
		),
		(format!("{TRAP}{echo} | {w1} & wait %1; echo st=$?"), "chld\nchld\nst=0\n".into()),
		(format!("{TRAP}{ext} | {w1} & wait %1; echo st=$?"), "chld\nchld\nst=0\n".into()),
		(format!("{TRAP}{k} | {w1} & wait %1; echo st=$?"), "chld\nchld\nst=0\n".into()),
		(
			format!("{TRAP}{e0} | {w1k} & wait %1; echo st=$?"),
			format!("chld\nchld\n{}st=137\n", at(&[("Done", &e0), (killed, &w1k)])),
		),
		(format!("{TRAP}{e0} | {w1} & wait; echo done"), "chld\nchld\ndone\n".into()),
		(
			format!("shopt -s lastpipe; {TRAP}{e0} | {w1} & wait %1; echo st=$?"),
			"chld\nchld\nst=0\n".into(),
		),
		(
			"trap 'echo chld' CHLD; /bin/sleep 30 | /bin/sleep 31 & kill -TERM %1; wait; echo st=$?"
				.into(),
			"chld\nchld\nst=0\n".into(),
		),
		(
			"trap 'echo chld' CHLD; /bin/sleep 30 | /bin/sleep 31 | /bin/sleep 32 & kill -TERM %1; \
			 wait; echo st=$?"
				.into(),
			"chld\nchld\nchld\nst=0\n".into(),
		),
		// One process, one run; a foreground pipeline's processes.
		(format!("{TRAP}{E0} & wait %1; echo st=$?"), "chld\nst=0\n".into()),
		(format!("trap 'echo chld' CHLD; {E0} | {R0}; echo st=$?"), "chld\nchld\nst=0\n".into()),
	];
	let dir = tempfile::tempdir().expect("a directory for the trap's lines");
	let mut wrong = Vec::new();
	for (n, (script, out)) in cases.into_iter().enumerate() {
		let script = format!("exec 2>&1; {script}");
		let run = |shell: &OsStr, who: &str| {
			let file = dir.path().join(format!("{n}.{who}"));
			Run::script(shell, "bash", &script)
				.env("F", file)
				.spawn()
				.ended_within(EVENT_LIMIT)
		};
		let ours = match run(OsStr::new(env!("CARGO_BIN_EXE_obash")), "obash") {
			Ok(ours) => ours,
			Err(killed) => {
				wrong.push(format!("{script:?}\n  still running after {EVENT_LIMIT:?}: {killed:?}"));
				continue;
			},
		};
		let got = (
			String::from_utf8_lossy(&mask_stage_pids(&mask_pids(&ours.stdout))).into_owned(),
			ours.end(),
		);
		if got != (out.clone(), Some(Exit(0))) {
			wrong.push(format!("{script:?}\n  got:  {got:?}\n  want: {out:?}"));
		}
		if let Some(bash) = real_bash_golden() {
			let theirs = run(bash.as_os_str(), "bash").unwrap_or_else(|out| {
				panic!("{script:?}: bash still ran after {EVENT_LIMIT:?}: {out:?}")
			});
			assert_eq!(masked_stages(&ours), masked_stages(&theirs), "{script:?}");
		}
	}
	assert!(wrong.is_empty(), "{} of the cases differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// The pids a notice of `script` (two processes that write their own pids
/// to `$F.1` and `$F.2`) names on its lines are those of the processes, as
/// bash's are (checked live with a bash 5.3 or later, [`real_bash_golden`]):
/// a difference goes to `wrong`.
fn check_notice_pids(script: &str, wrong: &mut Vec<String>) {
	let dir = tempfile::tempdir().expect("a directory for the pids");
	let file = dir.path().join("pid");
	let script = format!("exec 2>&1; {script}");
	let obash = OsStr::new(env!("CARGO_BIN_EXE_obash"));
	for shell in std::iter::once(obash.to_owned()).chain(real_bash_golden().map(Into::into)) {
		let out = Run::script(&shell, "bash", &script).env("F", &file).go();
		let text = String::from_utf8_lossy(&out.stdout).into_owned();
		let shown: Vec<String> = text
			.lines()
			.filter_map(|line| match line.split_once(": line ") {
				Some((_, rest)) => rest.split_once(": ").map(|(_, rest)| rest),
				None => line.strip_prefix("     "),
			})
			.filter_map(|rest| rest.split_whitespace().next().map(str::to_owned))
			.collect();
		let written: Vec<String> = [".1", ".2"]
			.iter()
			.map(|end| {
				let mut path = file.clone().into_os_string();
				path.push(end);
				fs::read_to_string(path)
					.unwrap_or_default()
					.trim()
					.to_owned()
			})
			.collect();
		if shown != written {
			let shell = Path::new(&shell).display();
			wrong.push(format!("{shell} {script:?}\n  pids shown: {shown:?}\n  written: {written:?}"));
		}
	}
}

/// bash 5.3's notice of a foreground pipeline a signal killed, in a
/// non-interactive shell (`notify_of_job_status` for the foreground job), as
/// checked-in goldens measured with bash 5.3.20 (compared live only with a
/// bash 5.3 or later, [`real_bash_golden`]; bash 5.2.21 prints the same long
/// notices with the descriptions padded to 24 columns, and only the
/// signal's description for a short one). The pipeline's status is its
/// last process's, or under `pipefail` that of the last of its processes
/// that did not succeed (`raw_job_exit_status`): a signal that ended that
/// process gets the notice a command gets
/// ([`bash_reports_a_foreground_command_killed_by_a_signal`]), on the
/// shell's own standard error, at the line bash waits on. The long one
/// lists each process on its own line, as for a background job
/// ([`bash_reports_a_pipeline_job_killed_by_a_signal`]); the short one
/// (`TERM`, a signal the shell traps) names how the last process ended,
/// padded to 27 columns, and the pipeline (`print_pipeline`,
/// `JLIST_STANDARD`). `INT`, a command substitution, a posix `-c` shell and
/// a pipeline whose last stage the shell runs itself (`lastpipe`) print
/// nothing. Each script starts with `exec 2>&1`.
#[test]
fn bash_reports_a_foreground_pipeline_killed_by_a_signal() {
	use stage::{E0, E3, G, H, K, PF, R0, R5, RH, RK, RT, T};
	let killed = desc(libc::SIGKILL);
	let killed = killed.as_str();
	let hangup = desc(libc::SIGHUP);
	let terminated = desc(libc::SIGTERM);
	let at = |line, procs: &[(&str, &str)]| job_notice("bash", line, procs, "");
	let short = |end: &str, text: &str| format!("{end:<27}{text}\n");
	let cases: Vec<(String, String, End)> = vec![
		// The last process decides; under `pipefail` the last one that did
		// not succeed: the first, a middle or the last one.
		(
			format!("{E0} | {RK}; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Done", E0), (killed, RK)])),
			Exit(0),
		),
		(
			format!("{E0} | {R0} | {RK}; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Done", E0), ("Done", R0), (killed, RK)])),
			Exit(0),
		),
		(
			format!("{E3} | {RK}; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Exit 3", E3), (killed, RK)])),
			Exit(0),
		),
		(format!("{K} | {R0}; echo st=$?"), "st=0\n".into(), Exit(0)),
		(format!("{E0} | {RK} | {R0}; echo st=$?"), "st=0\n".into(), Exit(0)),
		(
			format!("{PF}{K} | {R0}; echo st=$?"),
			format!("{}st=137\n", at(1, &[(killed, K), ("Done", R0)])),
			Exit(0),
		),
		(
			format!("{PF}{E0} | {RK} | {R0}; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Done", E0), (killed, RK), ("Done", R0)])),
			Exit(0),
		),
		(
			format!("{PF}{E0} | {RK}; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Done", E0), (killed, RK)])),
			Exit(0),
		),
		(
			format!("{PF}{G} | {R0}; echo st=$?"),
			format!("{}st=137\n", at(1, &[(killed, G), ("Done", R0)])),
			Exit(0),
		),
		(format!("{PF}{K} | {R5}; echo st=$?"), "st=5\n".into(), Exit(0)),
		// Two processes killed.
		(
			format!("{K} | {RK}; echo st=$?"),
			format!("{}st=137\n", at(1, &[(killed, K), (killed, RK)])),
			Exit(0),
		),
		(
			format!("{K} | {RH}; echo st=$?"),
			format!("{}st=129\n", at(1, &[(killed, K), (&hangup, RH)])),
			Exit(0),
		),
		// The short notice: how the last process ended, the pipeline.
		(
			format!("{E0} | {RT}; echo st=$?"),
			format!("{}st=143\n", short(&terminated, &format!("{E0} | {RT}"))),
			Exit(0),
		),
		(
			format!("{K} | {RT}; echo st=$?"),
			format!("{}st=143\n", short(&terminated, &format!("{K} | {RT}"))),
			Exit(0),
		),
		(
			format!("{PF}{T} | {R0}; echo st=$?"),
			format!("{}st=143\n", short("Done", &format!("{T} | {R0}"))),
			Exit(0),
		),
		(
			format!("trap 'echo t' HUP; {E0} | {RH}; echo st=$?"),
			format!("{}st=129\n", short(&hangup, &format!("{E0} | {RH}"))),
			Exit(0),
		),
		(
			format!("trap 'echo t' HUP; {PF}{H} | {R0}; echo st=$?"),
			format!("{}st=129\n", short("Done", &format!("{H} | {R0}"))),
			Exit(0),
		),
		// Where it runs, its line and its text.
		(format!("{E0} | {RK}"), at(1, &[("Done", E0), (killed, RK)]), Exit(137)),
		(
			format!("( {E0} | {RK}; echo st=$? )"),
			format!("{}st=137\n", at(1, &[("Done", E0), (killed, RK)])),
			Exit(0),
		),
		(
			format!("if true; then {E0} | {RK}; fi; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Done", E0), (killed, RK)])),
			Exit(0),
		),
		(
			format!("true\n{E0} | {RK}; echo st=$?"),
			format!("{}st=137\n", at(2, &[("Done", E0), (killed, RK)])),
			Exit(0),
		),
		(
			format!("{E0} |\n{RK}; echo st=$?"),
			format!("{}st=137\n", at(2, &[("Done", E0), (killed, RK)])),
			Exit(0),
		),
		(
			format!("! {E0} | {RK}; echo st=$?"),
			format!("{}st=0\n", at(1, &[("Done", E0), (killed, RK)])),
			Exit(0),
		),
		(
			format!("{E0} | {RK} 2>/dev/null; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Done", E0), (killed, &format!("{RK} 2> /dev/null"))])),
			Exit(0),
		),
		(format!("{{ {E0} | {RK}; }} 2>/dev/null; echo st=$?"), "st=137\n".into(), Exit(0)),
		(
			format!("{E0} |& {RK}; echo st=$?"),
			format!("{}st=137\n", at(1, &[("Done", &format!("{E0} 2>&1")), (killed, RK)])),
			Exit(0),
		),
		// No notice.
		(format!("x=$({E0} | {RK}); echo st=$?"), "st=137\n".into(), Exit(0)),
		(format!("set -o posix; {E0} | {RK}; echo st=$?"), "st=137\n".into(), Exit(0)),
		(format!("shopt -s lastpipe; {PF}{K} | {R0}; echo st=$?"), "st=137\n".into(), Exit(0)),
		(format!("shopt -s lastpipe; {E0} | {RK}; echo st=$?"), "st=137\n".into(), Exit(0)),
	];
	let mut wrong = Vec::new();
	for (script, out, end) in cases {
		let script = format!("exec 2>&1; {script}");
		let run = |shell: &OsStr| Run::script(shell, "bash", &script).go();
		let ours = run(OsStr::new(env!("CARGO_BIN_EXE_obash")));
		let got = (
			String::from_utf8_lossy(&mask_stage_pids(&mask_pids(&ours.stdout))).into_owned(),
			ours.end(),
		);
		if got != (out.clone(), Some(end)) {
			wrong.push(format!("{script:?}\n  got:  {got:?}\n  want: {:?}", (out, end)));
		}
		if let Some(bash) = real_bash_golden() {
			assert_eq!(masked_stages(&ours), masked_stages(&run(bash.as_os_str())), "{script:?}");
		}
	}
	let pids = "/bin/sh -c 'echo $$ >\"$F.1\"; exit 0' | /bin/sh -c 'echo $$ >\"$F.2\"; read x; \
	            kill -KILL $$'; echo st=$?";
	check_notice_pids(pids, &mut wrong);
	assert!(wrong.is_empty(), "{} of the cases differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// bash 5.3.20 keeps a finished job in the table while the job list is
/// frozen (`cleanup_dead_jobs` and `delete_job` return at once,
/// `jobs.c:1470`, `1492`): a `CHLD` trap that runs `wait` while `wait $!`,
/// `wait`, `wait -n` or `wait %1` waits for a job that ends (of `KILL`, of
/// `TERM`, with `exit 200`) leaves it, and the `wait` it interrupted still
/// ends, with the job's status and notice; the trap's own `wait $!` or
/// `wait %1` collects it and marks it reported (no notice then), its
/// `wait -n` returns 127 at once (`wait_for_any_job`, `jobs.c:3465`); an
/// `INT` trap's `wait` leaves a killed job to the next line's notice. bash
/// freezes only there:
/// not for an `INT` trap that comes while it reads a command substitution
/// (no job; the trap's first line reports), nor for a `CHLD` trap in posix
/// mode, which ends the `wait` with 128 + `SIGCHLD` and runs after it.
/// Checked-in goldens measured with bash 5.3.20 (compared live only with a
/// bash 5.3 or later, [`real_bash_golden`]); each script starts with `exec
/// 2>&1`; a row whose shell is still running after [`EVENT_LIMIT`] fails.
/// The job of [`KILLER`]'s form ends once the shell blocks, in `wait`.
#[test]
fn bash_keeps_finished_jobs_while_the_job_list_is_frozen() {
	const W: &str = "/bin/sleep 30 & kill -KILL $!; while kill -0 $! 2>/dev/null; do :; done";
	const REAP: &str = "kill -KILL $p; while ps -p $p >/dev/null 2>&1; do /bin/sleep 0.01; done; \
	                    kill -INT $$; /bin/sleep 0.3";
	let killer = |end: &str| format!("/bin/sh -c '{}'", KILLER.replace("kill -KILL $$", end));
	let notice = |line, text: &str| {
		String::from_utf8(long_notice(line, libc::SIGKILL, text.as_bytes())).expect("ASCII")
	};
	let mut rows: Vec<(String, String)> = Vec::new();
	for (end, status, reported) in
		[("kill -KILL $$", 137, true), ("kill -TERM $$", 143, false), ("exit 200", 200, false)]
	{
		let job = killer(end);
		let shown = if reported {
			notice(1, &job)
		} else {
			String::new()
		};
		for (wait, st) in [("wait $!", status), ("wait", 0), ("wait -n", status), ("wait %1", status)]
		{
			rows.push((
				format!("trap 'echo chld; wait' CHLD; {job} & {wait}; echo st=$?\necho next"),
				format!("chld\n{shown}st={st}\nnext\n"),
			));
		}
	}
	// The trap's own `wait $!` or `wait %1` collects the job and marks it
	// reported (`in=137`, no notice); its `wait -n` returns at once while
	// the list is frozen (`in=127`), and the outer `wait` reports the job.
	let job = killer("kill -KILL $$");
	for (inner, got_in, shown) in [
		("wait $!", 137, String::new()),
		("wait %1", 137, String::new()),
		("wait -n", 127, notice(1, &job)),
	] {
		for (outer, st) in [("wait $!", 137), ("wait", 0), ("wait -n", 137)] {
			rows.push((
				format!(
					"trap 'echo chld; {inner}; echo in=$?' CHLD; {job} & {outer}; echo st=$?\necho next"
				),
				format!("chld\nin={got_in}\n{shown}st={st}\nnext\n"),
			));
		}
	}
	let sleep = |line| notice(line, "/bin/sleep 30");
	rows.push((
		format!(
			"trap 'echo int; wait' INT; {W}; /bin/sh -c 'kill -INT $PPID; kill -INT $$'\necho next"
		),
		format!("int\n{}next\n", sleep(2)),
	));
	for sub in [format!("$({REAP})"), format!("`{REAP}`")] {
		rows.push((
			format!("trap 'echo int' INT; /bin/sleep 30 & p=$!; x={sub}\necho next"),
			format!("{}int\nnext\n", sleep(1)),
		));
	}
	let posix = |end: &str| {
		format!(
			"set -o posix; trap 'echo chld' CHLD\n{} &\nwait $!; echo st=$?\necho next",
			killer(end)
		)
	};
	// 128 + `SIGCHLD`: 145 on Linux, 148 on macOS.
	let chld_status = 128 + libc::SIGCHLD;
	rows.push((posix("kill -KILL $$"), format!("chld\nst={chld_status}\nnext\n")));
	let mut wrong = Vec::new();
	for (script, out) in rows {
		let script = format!("exec 2>&1; {script}");
		let start = |program: &OsStr| Run::script(program, "bash", &script).spawn();
		let ours = match start(OsStr::new(env!("CARGO_BIN_EXE_obash"))).ended_within(EVENT_LIMIT) {
			Ok(ours) => ours,
			Err(killed) => {
				wrong.push(format!("{script:?}\n  still running after {EVENT_LIMIT:?}: {killed:?}"));
				continue;
			},
		};
		let got = (String::from_utf8_lossy(&mask_pids(&ours.stdout)).into_owned(), ours.end());
		if got != (out.clone(), Some(Exit(0))) {
			wrong.push(format!("{script:?}\n  got:  {got:?}\n  want: {out:?}"));
		}
		if let Some(bash) = real_bash_golden() {
			let theirs = start(bash.as_os_str()).end_within(EVENT_LIMIT, &script);
			assert_eq!(masked(&ours), masked(&theirs), "{script:?}");
		}
	}
	// Posix mode in a script file, which reports: at the trap's first line.
	let dir = tempfile::tempdir().expect("a directory for the script");
	let path = dir.path().join("s.sh");
	let file = path.display().to_string();
	let job = killer("kill -KILL $$");
	let killed = format!("{file}: line 1: PID {:<27}{job}\n", desc(libc::SIGKILL));
	for (script, out) in [
		(posix("kill -KILL $$"), format!("{killed}chld\nst={chld_status}\nnext\n")),
		(posix("exit 200"), format!("chld\nst={chld_status}\nnext\n")),
	] {
		fs::write(&path, format!("exec 2>&1; {script}\n")).expect("write the script");
		let start = |program: &OsStr| Run::new(program, "bash", &[&path]).spawn();
		let ours = match start(OsStr::new(env!("CARGO_BIN_EXE_obash"))).ended_within(EVENT_LIMIT) {
			Ok(ours) => ours,
			Err(killed) => {
				wrong
					.push(format!("file {script:?}\n  still running after {EVENT_LIMIT:?}: {killed:?}"));
				continue;
			},
		};
		let got = (String::from_utf8_lossy(&mask_pids(&ours.stdout)).into_owned(), ours.end());
		if got != (out.clone(), Some(Exit(0))) {
			wrong.push(format!("file {script:?}\n  got:  {got:?}\n  want: {out:?}"));
		}
		if let Some(bash) = real_bash_golden() {
			let theirs = start(bash.as_os_str()).end_within(EVENT_LIMIT, &script);
			assert_eq!(masked(&ours), masked(&theirs), "file: {script:?}");
		}
	}
	assert!(wrong.is_empty(), "{} of the cases differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// Each `(script, stdout)` of `rows` as a bash `-c` string after `exec
/// 2>&1`: what obash printed (pids masked) and how it ended, against the
/// checked-in golden and a clean exit; a wrong row goes into `wrong`, and so
/// does a shell still running after [`EVENT_LIMIT`]. With a live bash 5.3
/// or later ([`real_bash_golden`]) its output must equal obash's.
fn bounded_bash_rows(rows: Vec<(String, String)>, wrong: &mut Vec<String>) {
	for (script, out) in rows {
		let script = format!("exec 2>&1; {script}");
		let start = |program: &OsStr| Run::script(program, "bash", &script).spawn();
		let ours = match start(OsStr::new(env!("CARGO_BIN_EXE_obash"))).ended_within(EVENT_LIMIT) {
			Ok(ours) => ours,
			Err(killed) => {
				wrong.push(format!("{script:?}\n  still running after {EVENT_LIMIT:?}: {killed:?}"));
				continue;
			},
		};
		let got = (String::from_utf8_lossy(&mask_pids(&ours.stdout)).into_owned(), ours.end());
		if got != (out.clone(), Some(Exit(0))) {
			wrong.push(format!("{script:?}\n  got:  {got:?}\n  want: {out:?}"));
		}
		if let Some(bash) = real_bash_golden() {
			let theirs = start(bash.as_os_str()).end_within(EVENT_LIMIT, &script);
			assert_eq!(masked(&ours), masked(&theirs), "{script:?}");
		}
	}
}

/// bash 5.3.20 keeps the status a `wait` collected (its bgp list,
/// `bgp_add`/`bgp_search` in `jobs.c`), and deletes no job while the job
/// list is frozen (`cleanup_dead_jobs`, `delete_job`: `jobs.c:1310`,
/// `1492`): a `CHLD` trap whose `wait` collects the job, then runs `jobs`
/// (which lists it) or `disown`, leaves the `wait` it interrupted to end with
/// the job's status (`wait $!`, `wait`, `wait -n`, `wait %1`), as an `INT`
/// trap's `jobs` lists the job its `wait` collected. A `wait PID` after the
/// job left the table (listed by `jobs`, `disown`ed, waited for by `wait
/// -n` or by an earlier `wait PID`) returns that status too, but not after a
/// plain `wait` (`bgp_clear`) nor in posix mode once waited for
/// (`bgp_delete`). Once the freeze is over, the next cleanup (before the
/// next line, or at the end of the `wait` for a foreground command) deletes
/// the finished job the trap's `wait` marked reported: `jobs %1`, `wait %1`
/// and `disown %1` find no job, and a new `wait -n` skips a reported job
/// (`jobs.c:3471-3474`). Checked-in goldens measured with bash 5.3.20
/// ([`bounded_bash_rows`]); the job of [`KILLER`]'s form ends once the shell
/// blocks, in `wait`.
#[test]
fn bash_keeps_a_waited_status_and_deletes_a_reported_job_after_the_freeze() {
	// The reaps waited for with builtins only: a foreground program would end
	// with a report point (bash's `wait_for`).
	const W: &str = "/bin/sleep 30 & kill -KILL $!; while kill -0 $! 2>/dev/null; do :; done";
	const GONE: &str = "while kill -0 $! 2>/dev/null; do :; done";
	const INT: &str = "/bin/sh -c 'kill -INT $PPID; kill -INT $$'";
	let killer = |end: &str| format!("/bin/sh -c '{}'", KILLER.replace("kill -KILL $$", end));
	let (k, e) = (killer("kill -KILL $$"), killer("exit 3"));
	let listed = |state: &str, text: &str| format!("[1]+  {state:<27}{text}\n");
	let killed = desc(libc::SIGKILL);
	let mut rows: Vec<(String, String)> = vec![
		(
			format!(
				"trap 'echo chld; wait $!; jobs; echo in=$?' CHLD; {k} & wait $!; echo st=$?\necho \
				 next"
			),
			format!("chld\n{}in=0\nst=137\nnext\n", listed(&killed, &k)),
		),
		(
			format!("trap 'echo chld; wait $!; jobs' CHLD; {e} & wait $!; echo st=$?\necho next"),
			format!("chld\n{}st=3\nnext\n", listed("Exit 3", &e)),
		),
		(
			format!("trap 'wait $!; jobs; echo in' INT; {W}; {INT}\necho next"),
			format!("{}in\nnext\n", listed(&killed, "/bin/sleep 30")),
		),
	];
	for (job, status) in [(&e, 3), (&k, 137)] {
		for (wait, st) in [("wait", 0), ("wait -n", status), ("wait %1", status)] {
			rows.push((
				format!(
					"trap 'echo chld; wait $!; jobs >/dev/null' CHLD; {job} & {wait}; echo st=$?\necho \
					 next"
				),
				format!("chld\nst={st}\nnext\n"),
			));
		}
		rows.push((
			format!(
				"trap 'echo chld; wait %1; disown %1; echo d=$?' CHLD; {job} & wait $!; echo \
				 st=$?\necho next"
			),
			format!("chld\nd=0\nst={status}\nnext\n"),
		));
	}
	// `disown` deletes no job while the list is frozen: `jobs` still lists
	// it, and a second `disown` finds it.
	rows.push((
		format!(
			"trap 'echo chld; wait %1; disown %1; echo d=$?; jobs; disown %1; echo e=$?' CHLD; {e} & \
			 wait $!; echo st=$?\necho next"
		),
		format!("chld\nd=0\n{}e=0\nst=3\nnext\n", listed("Exit 3", &e)),
	));
	// The status outlives the job's entry.
	let notice = String::from_utf8(long_notice(1, libc::SIGKILL, k.as_bytes())).expect("ASCII");
	rows.extend([
		(
			format!("{k} & p=$!; wait $p; echo a=$?; wait $p; echo b=$?\necho next"),
			format!("{notice}a=137\nb=137\nnext\n"),
		),
		(format!("{e} & p=$!; wait $p; echo a=$?\nwait $p; echo b=$?"), "a=3\nb=3\n".to_owned()),
		// The job is alive when bash makes it a job (else it is not the current
		// one) and ends once the shell blocks in the foreground `/bin/sleep`.
		(
			format!(
				"{e} & p=$!; while kill -0 $p 2>/dev/null; do /bin/sleep 0.01; done; jobs; wait $p; \
				 echo w=$?"
			),
			format!("{}w=3\n", listed("Exit 3", &e)),
		),
		(
			format!("/bin/sh -c 'exit 3' & p=$!; {GONE}; disown; wait $p; echo w=$?"),
			"w=3\n".to_owned(),
		),
		(
			format!("{e} & p=$!; wait; echo a=$?; wait $p 2>/dev/null; echo w=$?"),
			"a=0\nw=127\n".to_owned(),
		),
		(format!("{e} & p=$!; wait -n; echo a=$?; wait $p; echo w=$?"), "a=3\nw=3\n".to_owned()),
		(
			format!("set -o posix; {e} & p=$!; wait $p; echo a=$?; wait $p 2>/dev/null; echo b=$?"),
			"a=3\nb=127\n".to_owned(),
		),
	]);
	// The job the trap's `wait` marked reported goes once the freeze is over.
	let int_trap = format!("trap 'wait $!; echo in=$?' INT; {W}; {INT}");
	for (tail, out) in [
		("jobs %1", "bash: line 2: jobs: %1: no such job\n"),
		("wait %1; echo w=$?", "bash: line 2: wait: %1: no such job\nw=127\n"),
		("disown %1; echo d=$?", "bash: line 2: disown: %1: no such job\nd=1\n"),
		("/bin/sleep 0.1 & wait -n; echo n=$?", "n=0\n"),
		("jobs; echo j", "j\n"),
	] {
		rows.push((format!("{int_trap}\n{tail}\necho next"), format!("in=137\n{out}next\n")));
	}
	let exited = "trap 'wait $!; echo in=$?' INT; /bin/sh -c 'exit 3' & /bin/sh -c 'while kill -0 \
	              \"$0\" 2>/dev/null; do sleep 0.01; done; kill -INT $PPID; kill -INT $$' $!";
	for (tail, out) in [("/bin/sleep 0.1 & wait -n; echo n=$?", "n=0\n"), ("jobs; echo j", "j\n")] {
		rows.push((format!("{exited}\n{tail}\necho next"), format!("in=3\n{out}next\n")));
	}
	rows.extend([
		(
			format!(
				"trap 'wait $a; echo in=$?' CHLD; {k} & a=$!; /bin/sh -c 'while ps -p \"$0\" \
				 >/dev/null 2>&1; do sleep 0.01; done' $a & wait $!; trap - CHLD; /bin/sleep 0.1 & \
				 wait -n; echo n=$?\necho next"
			),
			"in=137\nin=137\nn=0\nnext\n".to_owned(),
		),
		(
			format!("{int_trap}; /bin/sleep 0.1 & wait -n; echo n=$?\necho next"),
			"in=137\nn=0\nnext\n".to_owned(),
		),
		// `wait_for` cleans up once the `INT` trap it ran is over.
		(
			format!("{int_trap}; jobs %1; echo next"),
			"in=137\nbash: line 1: jobs: %1: no such job\nnext\n".to_owned(),
		),
		// A `CHLD` trap outside `wait` (no freeze): the second run's `wait $!`
		// finds the status the first collected.
		(
			"trap 'echo chld; wait $!' CHLD; /bin/sh -c 'exit 3' & /bin/sh -c 'while kill -0 \"$0\" \
			 2>/dev/null; do sleep 0.01; done' $!; jobs %1; echo next"
				.to_owned(),
			"chld\nchld\nbash: line 1: jobs: %1: no such job\nnext\n".to_owned(),
		),
	]);
	let mut wrong = Vec::new();
	bounded_bash_rows(rows, &mut wrong);
	assert!(wrong.is_empty(), "{} of the cases differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// bash 5.3.20 deletes no job in a function substitution (`${ …; }`,
/// `function_substitute`'s `freeze_jobs_list (-1)`) nor in the last stage
/// of a pipeline it runs in the shell (`lastpipe`, `freeze_jobs_list (1)`):
/// a finished job that `jobs`, `wait` or `wait -n` reports there stays,
/// marked reported, until the next cleanup point outside deletes it: a fork
/// (a program, a `( … )`, a pipeline, a job: `stop_pipeline`), a loop's
/// iteration (`REAP`), a report point (the next line, a substitution,
/// `eval`), `jobs` (before it lists every job, after it lists one), the end
/// of a `wait`. `wait -n` passes over such a job (`jobs.c:3470-3474`), and
/// once it waited for a child takes the first finished job in job order,
/// the reported one too (`jobs.c:3614-3619`). In a `lastpipe` stage `wait
/// -n` returns 127 at once and nothing is reported (a killed job's `wait
/// PID` prints no notice); in a function substitution `wait -n` prints no
/// notice, `wait PID` does. Checked-in goldens measured with bash 5.3.20
/// ([`bounded_bash_rows`]); the job of [`KILLER`]'s form ends once the shell
/// blocks: the exit-3 job too, so that it is alive when bash makes it a job
/// (a job dead by then is not the current one, `reset_current`), and the
/// shell blocks in a foreground `/bin/sleep` while it waits for its reap.
#[test]
fn bash_keeps_a_job_a_function_substitution_or_lastpipe_marked_reported() {
	let killer = |end: &str| format!("/bin/sh -c '{}'", KILLER.replace("kill -KILL $$", end));
	let (k, e7, x3c) = (killer("kill -KILL $$"), killer("exit 7"), killer("exit 3"));
	let gone = "while kill -0 $! 2>/dev/null; do /bin/sleep 0.01; done";
	let listed =
		|n: u32, mark: char, state: &str, text: &str| format!("[{n}]{mark}  {state:<27}{text}\n");
	let x3 = |mark| listed(1, mark, "Exit 3", &x3c);
	let none = |spec: &str| format!("bash: line 1: jobs: {spec}: no such job\n");
	let killed = desc(libc::SIGKILL);
	let notice = String::from_utf8(long_notice(1, libc::SIGKILL, k.as_bytes())).expect("ASCII");
	// A finished job reported in `${ …; }` and a running one.
	let p = format!("{x3c} & {gone}; {e7} & x=${{ jobs; }}");
	// A finished job reported in `${ …; }`.
	let q = format!("{x3c} & {gone}; x=${{ jobs; }}");
	let mut rows: Vec<(String, String)> = vec![
		(
			format!("{p}; wait -n; echo n=$?; jobs; echo j"),
			format!("n=3\n{}j\n", listed(2, '+', "Exit 7", &e7)),
		),
		(
			format!("{p}; wait -n; echo n=$?; wait -n; echo m=$?; wait -n; echo o=$?"),
			"n=3\nm=7\no=127\n".to_owned(),
		),
		(
			format!(
				"{x3c} & {gone}; {e7} & x=${{ wait -n; echo s=$?; }}; echo \"$x\"; wait -n; echo \
				 n=$?; wait -n; echo m=$?"
			),
			"s=3\nn=3\nm=7\n".to_owned(),
		),
		(format!("{p}; jobs %1; echo j=$?; wait -n; echo n=$?"), format!("{}j=0\nn=7\n", x3(' '))),
		(
			format!("{x3c} & {gone}; {k} & x=${{ jobs; }}; wait -n; echo n=$?; jobs; echo j"),
			format!("n=3\n{}j\n", listed(2, '+', &killed, &k)),
		),
		(format!("{p}; wait; echo w=$?"), "w=0\n".to_owned()),
		(format!("{p}; wait %1; echo w=$?; wait -n; echo n=$?"), "w=3\nn=7\n".to_owned()),
		(
			format!("{p}; wait -n %1 %2; echo n=$?; jobs; echo j"),
			format!("n=3\n{}j\n", listed(2, '+', "Exit 7", &e7)),
		),
		(format!("{p}; wait -n %2; echo n=$?; jobs; echo j"), "n=7\nj\n".to_owned()),
		(
			format!(
				"{x3c} & a=$!; {gone}; {e7} & x=${{ jobs; }}; wait -n -p v; echo n=$? v=$((v==a))"
			),
			"n=3 v=1\n".to_owned(),
		),
		(format!("{q}; echo \"$x\"; wait -n; echo n=$?"), format!("{}n=127\n", x3('+'))),
		(format!("{q}; echo \"$x\"; jobs; echo j; jobs; echo k"), format!("{}j\nk\n", x3('+'))),
		(format!("{q}; disown %1; echo d=$?"), "d=0\n".to_owned()),
		(format!("{q}; wait $!; echo w=$?; jobs %1; echo j=$?"), format!("w=3\n{}j=1\n", none("%1"))),
		(
			format!("{x3c} & {gone}; x=${{ wait $!; echo s=$?; }}; echo \"$x\"; jobs %1; echo j=$?"),
			format!("s=3\n{}j=0\n", x3('+')),
		),
		(
			format!("{x3c} & {gone}; x=${{ disown %1; echo d=$?; }}; echo \"$x\"; jobs %1; echo j=$?"),
			format!("d=0\n{}j=0\n", x3('+')),
		),
		(
			format!("{k} & x=${{ wait -n; echo s=$?; }}; echo \"$x\"; jobs; echo j"),
			"s=137\nj\n".to_owned(),
		),
		(
			format!("{k} & x=${{ wait $!; echo s=$?; }}; echo \"$x\"; jobs; echo j"),
			format!("{notice}s=137\nj\n"),
		),
		// `lastpipe`.
		(
			format!("shopt -s lastpipe; {x3c} & {gone}; echo | {{ jobs; }}; jobs %1; echo j=$?"),
			format!("{}{}j=0\n", x3('+'), x3('+')),
		),
		(
			format!(
				"shopt -s lastpipe; {x3c} & {gone}; echo | {{ wait -n; echo s=$?; }}; jobs %1; echo \
				 j=$?"
			),
			format!("s=127\n{}j=0\n", x3('+')),
		),
		(
			format!(
				"shopt -s lastpipe; {x3c} & {gone}; echo | {{ wait $!; echo s=$?; }}; jobs %1; echo \
				 j=$?"
			),
			format!("s=3\n{}j=0\n", x3('+')),
		),
		(
			format!(
				"shopt -s lastpipe; {x3c} & {gone}; echo | {{ disown %1; echo d=$?; }}; jobs %1; echo \
				 j=$?"
			),
			format!("d=0\n{}j=0\n", x3('+')),
		),
		(
			format!("shopt -s lastpipe; {k} & echo | {{ wait $!; echo s=$?; }}; jobs; echo j"),
			"s=137\nj\n".to_owned(),
		),
		(
			format!(
				"{x3c} & {gone}; shopt -s lastpipe; {e7} & echo | {{ jobs; }}; wait -n; echo n=$?; \
				 jobs; echo j"
			),
			format!(
				"{}[2]+  {:<27}{e7} &\nn=3\n{}j\n",
				x3(' '),
				"Running",
				listed(2, '+', "Exit 7", &e7)
			),
		),
		(
			format!("{q}; shopt -s lastpipe; echo | {{ jobs %1; echo j=$?; }}; jobs %1; echo k=$?"),
			format!("{}j=0\n{}k=0\n", x3('+'), x3('+')),
		),
		(format!("{q}; shopt -s lastpipe; : | jobs %1; echo j=$?"), format!("{}j=0\n", x3('+'))),
		// The cleanup points: a fork, a loop's iteration, a report point.
		(format!("{q}; {k} & jobs %2; echo j=$?"), format!("{}j=1\n", none("%2"))),
		(
			format!("{q}; for i in 1 2; do jobs %1; echo j$i=$?; done"),
			format!("{}j1=0\n{}j2=1\n", x3('+'), none("%1")),
		),
		(
			format!("{q}; jobs %1; echo j=$?; jobs %1; echo k=$?"),
			format!("{}j=0\n{}k=1\n", x3('+'), none("%1")),
		),
	];
	for (command, deletes) in [
		("for i in 1; do :; done", true),
		("for i in; do :; done", false),
		("i=0; while (( i++ < 1 )); do :; done", true),
		("while false; do :; done", false),
		("until true; do :; done", false),
		("for (( i=0; i<1; i++ )); do :; done", true),
		("for (( i=0; i<0; i++ )); do :; done", true),
		("if true; then :; fi", false),
		("{ :; }", false),
		("case a in a) :;; esac", false),
		("f() { :; }; f", false),
		("( : )", true),
		("/bin/sh -c :", true),
		(": | :", true),
		("cat /dev/null | :", true),
		("eval :", true),
		("x=1", false),
		// `break` and `continue` end a loop body as it ends by itself (`REAP`
		// before bash looks at `breaking`), but for an `until` loop's
		// condition, which ends the loop at once; `return` does not.
		("for i in 1; do break; done", true),
		("for i in 1 2; do continue; done", true),
		("for i in 1; do continue; done", true),
		("while :; do break; done", true),
		("until false; do break; done", true),
		("while break; do :; done", true),
		("until break; do :; done", false),
		("for i in 1; do for j in 1; do break 2; done; done", true),
		("for i in 1; do for j in 1; do continue 2; done; done", true),
		("for (( ;; )); do break; done", true),
		("f() { for i in 1; do return; done; }; f", false),
		("f() { while :; do return 3; done; }; f", false),
		("f() { for i in 1; do x=1; done; }; f", true),
		("for i in 1; do if :; then break; fi; done", true),
		("for i in 1; do { break; }; done", true),
		("for i in 1; do eval break; done", true),
	] {
		let out = if deletes {
			format!("{}j=1\n", none("%1"))
		} else {
			format!("{}j=0\n", x3('+'))
		};
		rows.push((format!("{q}; {command}; jobs %1; echo j=$?"), out));
	}
	rows.push((format!("{q}; echo $(:); jobs %1; echo j=$?"), format!("\n{}j=1\n", none("%1"))));
	// The end of a DEBUG trap is a report point (`run_debug_trap`'s
	// `notify_and_cleanup`); no other trap's end is.
	let x3_only = format!("{x3c} & {gone}");
	for (trap, deletes) in [
		("trap 'x=${ jobs; }' DEBUG", true),
		("trap 'x=${ jobs; }; trap - DEBUG' DEBUG", true),
		("trap 'x=${ jobs; }' USR1; kill -USR1 $$", false),
		("trap 'x=${ jobs; }' ERR; false", false),
		("f() { :; }; trap 'x=${ jobs; }' RETURN; f", false),
		("trap 'x=${ jobs; }' EXIT", false),
	] {
		let out = if deletes {
			format!("{}j=1\n", none("%1"))
		} else {
			format!("{}j=0\n", x3('+'))
		};
		rows.push((format!("{x3_only}; {trap}; jobs %1; echo j=$?"), out));
	}
	rows.extend([
		(
			format!("{x3_only}; trap 'x=${{ jobs; }}' USR1; kill -USR1 $$; wait -n; echo n=$?"),
			"n=127\n".to_owned(),
		),
		(
			format!("{x3_only}; {e7} & trap 'x=${{ jobs; }}' DEBUG; wait -n; echo n=$?"),
			"n=7\n".to_owned(),
		),
		(
			format!("{x3_only}; trap 'x=${{ jobs; }}' USR1; kill -USR1 $$; eval 'jobs %1'; echo j=$?"),
			format!("{}j=1\n", none("%1")),
		),
		// A job killed while the DEBUG trap ran: its notice at the trap's end,
		// naming the line of the command the trap ran for.
		(
			format!(
				"{k} & p=$!; trap 'while kill -0 $p 2>/dev/null; do /bin/sleep 0.01; done' DEBUG; \
				 echo a; echo b"
			),
			format!("{notice}a\nb\n"),
		),
	]);
	let mut wrong = Vec::new();
	bounded_bash_rows(rows, &mut wrong);
	assert!(wrong.is_empty(), "{} of the cases differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// zsh 5.9 runs a `CHLD` trap with no frozen job list, and the job whose
/// end runs it is no child of the shell while it runs (`wait $!` says `not
/// a child`, 127; `wait %1` `no such job`): its status reaches zsh's list
/// of background statuses only once the trap is over, and the `wait` the
/// trap interrupted still ends with it. Another finished job is a child
/// (`wait PID` takes its status, which a second `wait` no longer finds); a
/// job spec names no finished job there; `jobs` lists none. A job that ends
/// while the trap runs, waited for by the trap or not, runs the trap no
/// more. A `TRAPCHLD` function alike. Checked-in goldens measured with zsh
/// 5.9 (compared live only with a zsh 5.9, `zsh_oracle::version_is_5_9`);
/// pids masked; a row whose shell is still running after [`EVENT_LIMIT`]
/// fails. The job of [`KILLER`]'s form ends once the shell blocks, in
/// `wait`; the one waiting for `FLAG` once the trap made it.
#[test]
fn zsh_runs_its_chld_trap_with_its_own_job_out_of_the_table() {
	const X3: &str = "/bin/sh -c 'exit 3'";
	const GONE: &str = "while kill -0 $! 2>/dev/null; do :; done";
	let killer = |end: &str| format!("/bin/sh -c '{}'", KILLER.replace("kill -KILL $$", end));
	let (k, e) = (killer("kill -KILL $$"), killer("exit 3"));
	let gone = "zsh:wait:1: pid PID is not a child of this shell\n";
	let dir = tempfile::tempdir().expect("a directory for the flag file");
	let flag = dir.path().join("flag");
	let flag = flag.display();
	let f5 = format!("/bin/sh -c 'while [ ! -e {flag} ]; do sleep 0.01; done; exit 5'");
	let two = "trap 'print chld; wait $a; print a=$?; wait $b; print b=$?' CHLD";
	let mut rows: Vec<(String, String)> = vec![
		(
			format!(
				"trap 'print chld; wait $!; print in=$?' CHLD; {k} & wait $!; print st=$?\nprint next"
			),
			format!("chld\n{gone}in=127\nst=137\nnext\n"),
		),
		(
			format!(
				"trap 'print chld; wait $!; print in=$?' CHLD; {e} & wait $!; print st=$?\nprint next"
			),
			format!("chld\n{gone}in=127\nst=3\nnext\n"),
		),
		(
			format!(
				"trap 'print chld; wait $!; print in=$?' CHLD; {k} & wait; print st=$?\nprint next"
			),
			format!("chld\n{gone}in=127\nst=0\nnext\n"),
		),
		(
			format!(
				"TRAPCHLD() {{ print chld; wait $!; print in=$?; }}; {k} & wait $!; print \
				 st=$?\nprint next"
			),
			"chld\nTRAPCHLD:wait: pid PID is not a child of this shell\nin=127\nst=137\nnext\n"
				.to_owned(),
		),
		(
			format!(
				"trap 'print chld; wait %1; print in=$?' CHLD; {k} & wait $!; print st=$?\nprint next"
			),
			"chld\nzsh:wait:1: %1: no such job\nin=127\nst=137\nnext\n".to_owned(),
		),
		(
			"trap 'print chld; wait $p; print in=$?' CHLD; /bin/sh -c 'exit 3' & p=$!; while kill -0 \
			 $! 2>/dev/null; do :; done; print mid; wait $p; print st=$?"
				.to_owned(),
			format!("chld\n{gone}in=127\nmid\nst=3\n"),
		),
	];
	rows.extend([
		(
			format!("{X3} & a=$!; {GONE}; {two}; {e} & b=$!; wait $b; print st=$?\nprint next"),
			format!("chld\na=3\n{gone}b=127\nst=3\nnext\n"),
		),
		(
			format!("{two}; {X3} & a=$!; {GONE}; {e} & b=$!; wait $b; print st=$?\nprint next"),
			format!("chld\n{gone}a=127\nb=0\nchld\na=3\n{gone}b=127\nst=3\nnext\n"),
		),
		(
			format!(
				"trap 'print chld; wait %1; print a=$?; wait %2; print b=$?' CHLD; {X3} & a=$!; \
				 {GONE}; {e} & b=$!; wait $b; print st=$?\nprint next"
			),
			"chld\nzsh:wait:1: %1: no such job\na=127\nzsh:wait:1: %2: no such \
			 job\nb=127\nchld\nzsh:wait:1: %1: no such job\na=127\nzsh:wait:1: %2: no such \
			 job\nb=127\nst=3\nnext\n"
				.to_owned(),
		),
		(
			format!(
				"trap 'print chld; jobs; print j' CHLD; {X3} & a=$!; {GONE}; {e} & b=$!; wait $b; \
				 print st=$?\nprint next"
			),
			"chld\nj\nchld\nj\nst=3\nnext\n".to_owned(),
		),
		(
			format!(
				"trap 'print chld' CHLD; {X3} & a=$!; {GONE}; trap 'print chld2; wait $a; print a=$?; \
				 wait $b; print b=$?' CHLD; {e} & b=$!; wait $b; print st=$?\nprint next"
			),
			format!("chld\nchld2\na=3\n{gone}b=127\nst=3\nnext\n"),
		),
		(
			format!(
				"{X3} & a=$!; {GONE}; {f5} & c=$!; trap 'print chld; wait $a; print a=$?; : > {flag}; \
				 wait $c; print c=$?' CHLD; {e} & b=$!; wait $b; print st=$?; wait $c; print c2=$?; \
				 wait $a; print a2=$?\nprint next"
			),
			format!("chld\na=3\nc=5\nst=3\n{gone}c2=127\n{gone}a2=127\nnext\n"),
		),
		(
			format!(
				"{X3} & a=$!; {GONE}; trap 'print chld; wait $a; print a=$?' CHLD; {e} & b=$!; wait \
				 $b; print st=$?; wait $a; print a2=$?; wait $b; print b2=$?"
			),
			format!("chld\na=3\nst=3\n{gone}a2=127\n{gone}b2=127\n"),
		),
		(
			format!(
				"{X3} & a=$!; {GONE}; trap 'print chld; print $(( $(jobs -l | wc -l) )); wait $a; \
				 print a=$?; wait $a; print a3=$?' CHLD; {e} & b=$!; wait $b; print st=$?"
			),
			format!("chld\n0\na=3\n{gone}a3=127\nst=3\n"),
		),
		(
			format!(
				"{X3} & a=$!; {GONE}; {X3} & a2=$!; {GONE}; trap 'print chld; wait $a; print a=$?; \
				 wait $a2; print a2=$?' CHLD; {e} & b=$!; wait $b; print st=$?"
			),
			"chld\na=3\na2=3\nst=3\n".to_owned(),
		),
		(
			format!(
				"{f5} & d=$!; trap 'print chld; : > {flag}; while kill -0 $d 2>/dev/null; do \
				 /bin/sleep 0.01; done; print end' CHLD; {e} & b=$!; wait $b; print st=$?; wait $d; \
				 print d=$?"
			),
			"chld\nend\nst=3\nd=5\n".to_owned(),
		),
		(
			format!(
				"{f5} & d=$!; TRAPCHLD() {{ print chld; : > {flag}; wait $d; print d=$?; }}; {e} & \
				 b=$!; wait $b; print st=$?"
			),
			"chld\nd=5\nst=3\n".to_owned(),
		),
	]);
	// `pid N is not a child`: the pid masked.
	let mask = |b: &[u8]| -> String {
		let text = String::from_utf8_lossy(b);
		let mut out = String::with_capacity(text.len());
		for line in text.split_inclusive('\n') {
			match line.split_once(": pid ").and_then(|(head, rest)| {
				let (pid, tail) = rest.split_once(' ')?;
				pid.bytes()
					.all(|c| c.is_ascii_digit())
					.then_some((head, tail))
			}) {
				Some((head, tail)) => {
					out.push_str(head);
					out.push_str(": pid PID ");
					out.push_str(tail);
				},
				None => out.push_str(line),
			}
		}
		out
	};
	let zsh_5_9 = zsh_oracle::version_is_5_9();
	let mut wrong = Vec::new();
	for (script, out) in rows {
		let script = format!("exec 2>&1; {script}");
		// The flag file is each run's own.
		let start = |program: &OsStr| {
			let _ = std::fs::remove_file(dir.path().join("flag"));
			Run::script(program, "zsh", &script).spawn()
		};
		let ours = match start(OsStr::new(env!("CARGO_BIN_EXE_obash"))).ended_within(EVENT_LIMIT) {
			Ok(ours) => ours,
			Err(killed) => {
				wrong
					.push(format!("zsh: {script:?}\n  still running after {EVENT_LIMIT:?}: {killed:?}"));
				continue;
			},
		};
		let got = (mask(&ours.stdout), ours.end());
		if got != (out.clone(), Some(Exit(0))) {
			wrong.push(format!("zsh: {script:?}\n  got:  {got:?}\n  want: {out:?}"));
		}
		if zsh_5_9 {
			let real = start(zsh_oracle::path().as_os_str()).end_within(EVENT_LIMIT, &script);
			assert_eq!(
				(mask(&ours.stdout), mask(&ours.stderr), ours.end()),
				(mask(&real.stdout), mask(&real.stderr), real.end()),
				"zsh: {script:?}"
			);
		}
	}
	assert!(wrong.is_empty(), "{} of the cases differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// Three older defects, against bash 5.3.20 (checked-in goldens, compared
/// live only with a bash 5.3 or later, [`real_bash_golden`]; each script
/// starts with `exec 2>&1`; a row whose shell is still running after
/// [`EVENT_LIMIT`] fails):
/// - a `CHLD` trap that starts children of its own (a `$( )`, a `<( )`, a
///   program) runs once: bash queues the trap for a child reaped while the trap
///   runs and drops it, warning `run_pending_traps: bad value in trap_list[17]:
///   0x…`, a bash defect obash does not copy (the live comparison drops that
///   line); outside the trap a substitution's child runs it as any child does;
/// - a plain `wait` keeps the job `$!` names when it ended while `wait` waited
///   for another (`mark_dead_jobs_as_notified`, `jobs.c:5196`), and the next
///   line reports it: the other job ends only once the shell has reaped `$!`,
///   which ends once the shell blocks in `wait`;
/// - a subshell's own process ignores `QUIT` again after its `trap - QUIT`
///   (`restore_default_signal`), in the foreground and with `&`;
/// - a foreground subshell a signal killed gets the notice a foreground command
///   gets, naming the subshell; bash runs a subshell's last simple command with
///   `exec`, so one that dies takes the subshell with it. A pipeline's stage
///   and a command substitution say nothing;
/// - an external a signal killed inside a subshell, not its last command: the
///   subshell reports it, as bash 5.3.20 does from any of its processes but a
///   substitution's own process and a posix `startup_state` 2 one (a posix `-c`
///   shell, or a fork of a substitution); a posix script file's subshell
///   reports.
#[test]
fn bash_runs_chld_traps_for_jobs_keeps_bang_and_ignores_quit_after_trap_reset() {
	/// Externals that kill themselves.
	const Q: &str = "/bin/sh -c 'kill -QUIT $$'";
	const KK: &str = "/bin/sh -c 'kill -KILL $$'";
	const T: &str = "/bin/sh -c 'kill -TERM $$'";
	let until = KILLER.trim_end_matches("; kill -KILL $$");
	let last = format!("/bin/sh -c '{until}; echo $$ > \"$1\"; kill -KILL $$' sh \"$f\"");
	let first = "/bin/sh -c 'until [ -s \"$1\" ] && ! ps -p \"$(cat \"$1\")\" >/dev/null 2>&1; do \
	             sleep 0.01; done' sh \"$f\"";
	let notice = String::from_utf8(long_notice(2, libc::SIGKILL, last.as_bytes())).expect("ASCII");
	let sub =
		|sig, text: &str| String::from_utf8(long_notice(1, sig, text.as_bytes())).expect("ASCII");
	let rows: Vec<(String, String)> = vec![
		(
			"trap 'echo chld; x=$(echo in)' CHLD; /bin/sh -c : & wait; echo done".into(),
			"chld\ndone\n".into(),
		),
		(
			"trap 'echo chld; cat <(echo in) >/dev/null' CHLD; /bin/sh -c : & wait; echo done".into(),
			"chld\ndone\n".into(),
		),
		(
			"trap 'echo chld; /bin/sh -c :' CHLD; /bin/sh -c : & wait; echo done".into(),
			"chld\ndone\n".into(),
		),
		("trap 'echo chld' CHLD; x=$(echo in); echo done".into(), "chld\ndone\n".into()),
		(
			"trap 'echo chld' CHLD; cat <(echo in) >/dev/null; echo done".into(),
			"chld\nchld\ndone\n".into(),
		),
		(
			format!("f=$(mktemp); {first} & {last} & wait; echo st=$?\necho next; rm -f \"$f\""),
			format!("st=0\n{notice}next\n"),
		),
		(
			"( trap - QUIT; kill -QUIT $BASHPID; echo alive ); echo st=$?".into(),
			"alive\nst=0\n".into(),
		),
		(
			"( trap - QUIT; kill -QUIT $BASHPID; echo alive ) & wait; echo st=$?".into(),
			"alive\nst=0\n".into(),
		),
		(
			"( trap '' QUIT; trap - QUIT; kill -QUIT $BASHPID; echo alive ); echo st=$?".into(),
			"alive\nst=0\n".into(),
		),
		// The notice of a foreground subshell a signal killed: its own
		// process, or its last command, which bash runs with `exec`.
		(
			"( kill -QUIT $BASHPID; echo alive ); echo st=$?".into(),
			format!("{}st=131\n", sub(libc::SIGQUIT, "( kill -QUIT $BASHPID; echo alive )")),
		),
		(
			"( trap - QUIT; /bin/sh -c 'kill -QUIT $$' ); echo st=$?".into(),
			format!("{}st=131\n", sub(libc::SIGQUIT, "( trap - QUIT; /bin/sh -c 'kill -QUIT $$' )")),
		),
		(
			"( /bin/sh -c 'kill -QUIT $$' ); echo st=$?".into(),
			format!("{}st=131\n", sub(libc::SIGQUIT, "( /bin/sh -c 'kill -QUIT $$' )")),
		),
		(
			"( kill -KILL $BASHPID; echo alive ); echo st=$?".into(),
			format!("{}st=137\n", sub(libc::SIGKILL, "( kill -KILL $BASHPID; echo alive )")),
		),
		(
			"( kill -TERM $BASHPID; echo alive ); echo st=$?".into(),
			format!("{:<27}( kill -TERM $BASHPID; echo alive )\nst=143\n", desc(libc::SIGTERM)),
		),
		(
			"( ( kill -QUIT $BASHPID ); echo inner=$? ); echo st=$?".into(),
			format!("{}inner=131\nst=0\n", sub(libc::SIGQUIT, "( kill -QUIT $BASHPID )")),
		),
		("( kill -QUIT $BASHPID ) | cat; echo st=$?".into(), "st=0\n".into()),
		("x=$( kill -QUIT $BASHPID ); echo st=$?".into(), "st=131\n".into()),
		// An external a signal killed inside a subshell, not its last
		// command: the subshell reports it, from a pipeline's stage and an
		// asynchronous subshell too; a substitution's own process and a
		// posix `-c` shell's subshell say nothing.
		(
			format!("( {Q}; echo after ); echo st=$?"),
			format!("{}after\nst=0\n", sub(libc::SIGQUIT, Q)),
		),
		(
			format!("( {KK}; echo after ); echo st=$?"),
			format!("{}after\nst=0\n", sub(libc::SIGKILL, KK)),
		),
		(
			format!("( {T}; echo after ); echo st=$?"),
			format!("{:<27}{T}\nafter\nst=0\n", desc(libc::SIGTERM)),
		),
		(
			"( trap 'echo t' USR1; /bin/sh -c 'kill -USR1 $$'; echo after ); echo st=$?".into(),
			format!("{:<27}/bin/sh -c 'kill -USR1 $$'\nafter\nst=0\n", desc(libc::SIGUSR1)),
		),
		(
			format!("( ( {Q}; echo after ) ); echo st=$?"),
			format!("{}after\nst=0\n", sub(libc::SIGQUIT, Q)),
		),
		(
			format!("( {Q}; echo after ) | cat; echo st=$?"),
			format!("{}after\nst=0\n", sub(libc::SIGQUIT, Q)),
		),
		(
			format!("{{ {KK}; echo after; }} & wait; echo st=$?"),
			format!("{}after\nst=0\n", sub(libc::SIGKILL, KK)),
		),
		(
			format!("( {KK}; echo after ) & wait; echo st=$?"),
			format!("{}after\nst=0\n", sub(libc::SIGKILL, KK)),
		),
		(format!("x=$( {KK}; echo after ); echo \"x=$x\""), "x=after\n".into()),
		(
			format!("x=$( ( {KK}; echo after ) ); echo \"x=$x\""),
			format!("{}x=after\n", sub(libc::SIGKILL, KK)),
		),
		(format!("cat <( {KK}; echo after )"), "after\n".into()),
		(format!("set -o posix; ( {KK}; echo after ); echo st=$?"), "after\nst=0\n".into()),
		(format!("set -o posix; x=$( ( {KK}; echo after ) ); echo \"x=$x\""), "x=after\n".into()),
		(
			format!("f() {{ {Q}; echo after; }}; ( f ); echo st=$?"),
			format!("{}after\nst=0\n", sub(libc::SIGQUIT, Q)),
		),
		(
			format!("( {Q}\necho after ); echo st=$?"),
			format!(
				"{}after\nst=0\n",
				String::from_utf8(long_notice(2, libc::SIGQUIT, Q.as_bytes())).expect("ASCII")
			),
		),
	];
	let without_warning = |o: Outcome| {
		const WARNING: &[u8] = b"run_pending_traps: bad value in trap_list";
		let keep = |b: &[u8]| -> Vec<u8> {
			b.split_inclusive(|&c| c == b'\n')
				.filter(|l| !l.windows(WARNING.len()).any(|w| w == WARNING))
				.flatten()
				.copied()
				.collect()
		};
		let (stdout, stderr) = (keep(&o.stdout), keep(&o.stderr));
		Outcome { stdout, stderr, ..o }
	};
	let mut wrong = Vec::new();
	for (script, out) in rows {
		let script = format!("exec 2>&1; {script}");
		let start = |program: &OsStr| Run::script(program, "bash", &script).spawn();
		let ours = match start(OsStr::new(env!("CARGO_BIN_EXE_obash"))).ended_within(EVENT_LIMIT) {
			Ok(ours) => ours,
			Err(killed) => {
				wrong.push(format!("{script:?}\n  still running after {EVENT_LIMIT:?}: {killed:?}"));
				continue;
			},
		};
		let got = (String::from_utf8_lossy(&mask_pids(&ours.stdout)).into_owned(), ours.end());
		if got != (out.clone(), Some(Exit(0))) {
			wrong.push(format!("{script:?}\n  got:  {got:?}\n  want: {out:?}"));
		}
		if let Some(bash) = real_bash_golden() {
			let theirs = start(bash.as_os_str()).end_within(EVENT_LIMIT, &script);
			assert_eq!(masked(&ours), masked(&without_warning(theirs)), "{script:?}");
		}
	}
	// Posix mode in a script file (`startup_state` 0): its subshell reports,
	// its fork of a substitution does not.
	let dir = tempfile::tempdir().expect("a directory for the script");
	let path = dir.path().join("s.sh");
	let file = path.display().to_string();
	for (script, out) in [
		(
			format!("set -o posix; ( {KK}; echo after ); echo st=$?"),
			format!("{file}: line 1: PID {:<27}{KK}\nafter\nst=0\n", desc(libc::SIGKILL)),
		),
		(format!("set -o posix; x=$( ( {KK}; echo after ) ); echo \"x=$x\""), "x=after\n".to_owned()),
	] {
		fs::write(&path, format!("exec 2>&1; {script}\n")).expect("write the script");
		let ours = Run::new(env!("CARGO_BIN_EXE_obash"), "bash", &[&path]).go();
		let got = (String::from_utf8_lossy(&mask_pids(&ours.stdout)).into_owned(), ours.end());
		if got != (out.clone(), Some(Exit(0))) {
			wrong.push(format!("file {script:?}\n  got:  {got:?}\n  want: {out:?}"));
		}
		if let Some(bash) = real_bash_golden() {
			assert_eq!(
				masked(&ours),
				masked(&Run::new(&bash, "bash", &[&path]).go()),
				"file: {script:?}"
			);
		}
	}
	assert!(wrong.is_empty(), "{} of the cases differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// bash 5.3.20's notices of a subshell's command a signal killed, as the
/// processes bash forks decide them (checked-in goldens,
/// [`bounded_bash_rows`]):
/// - a `( … )` whose only command is another `( … )` runs it in its own process
///   (`execute_in_subshell`'s `CMD_NO_FORK`), and so does a background job or a
///   pipeline stage whose whole command is a `( … )`: the process dies of the
///   signal, and its parent reports it as a job (`[1]+ Killed`, the next line's
///   notice) or a foreground command (`! ( … )` with its `!`, `( … )
///   2>/dev/null` on the shell's standard error), or not at all (a pipeline's
///   first stage);
/// - bash runs a `( … )`'s last simple command with `exec` when it is the `( …
///   )`'s only command (redirections allowed), or ends a `;`, `&&` or `||` list
///   without a redirection of its own while no signal trap with an action, no
///   EXIT trap of the subshell's own and no inherited ERR (`errtrace`) or, in a
///   function, RETURN (`functrace`) trap is set (`optimize_subshell_command`,
///   `should_optimize_fork`); a `!`, `time` or `&` before it, or a job's or a
///   stage's list (`a && cmd &`), forks it, and the subshell reports it;
/// - the line is the forked `( … )`'s own (its last line, bash's
///   `Subshell->line`), and for a `{ }` group or a stage the line the parent
///   had reached when it forked;
/// - a simple command with prefix assignments (`x=1 cmd`) is one as any other:
///   a job's or a stage's whole command is its process, `x=1 cmd` ends a `( …
///   )`'s list as `cmd` would.
#[test]
fn bash_reports_a_subshell_as_the_processes_bash_forks() {
	const Q: &str = "/bin/sh -c 'kill -QUIT $$'";
	const KK: &str = "/bin/sh -c 'kill -KILL $$'";
	const GONE: &str = "while kill -0 $! 2>/dev/null; do :; done";
	let notice = |line, sig, text: &str| {
		String::from_utf8(long_notice(line, sig, text.as_bytes())).expect("ASCII")
	};
	let quit = |text: &str| notice(1, libc::SIGQUIT, text);
	let kill = |text: &str| notice(1, libc::SIGKILL, text);
	// A job whose own process dies of the signal (bash runs the program in
	// it with `exec`) and is waited for: it dies only once the shell blocks
	// in `wait` ([`KILLER`]), as bash reports none for a job that died before
	// `wait` began. A job listed as the current one is alive when bash makes
	// it a job (a job dead by then is not the current one): the shell kills
	// it after.
	let kw = format!("/bin/sh -c '{KILLER}'");
	let mut rows: Vec<(String, String)> = vec![
		(
			format!("( /bin/sleep 30 ) & kill -KILL $!; {GONE}; jobs; echo next"),
			format!("[1]+  {:<27}( /bin/sleep 30 )\nnext\n", desc(libc::SIGKILL)),
		),
		(
			format!("( {KK} ) & {GONE}; echo st=$?\necho next"),
			format!("st=0\n{}next\n", notice(2, libc::SIGKILL, &format!("( {KK} )"))),
		),
		(format!("{{ ( {Q} ); echo a; }} | cat"), format!("{}a\n", quit(&format!("( {Q} )")))),
		(format!("echo x | {{ ( {KK} ); echo a; }}"), format!("{}a\n", kill(&format!("( {KK} )")))),
		(format!("( ( {Q} ) ) | cat; echo st=$?"), "st=0\n".to_owned()),
		(
			format!("( ( {kw} ) ) & wait; echo st=$?"),
			format!("{}st=0\n", kill(&format!("( ( {kw} ) )"))),
		),
		(format!(": && {KK} & wait; echo st=$?"), format!("{}st=0\n", kill(KK))),
		(format!("false || {KK} & wait; echo st=$?"), format!("{}st=0\n", kill(KK))),
		(
			format!("( : && {kw} ) & wait; echo st=$?"),
			format!("{}st=0\n", kill(&format!("( : && {kw} )"))),
		),
		(
			format!(": && ( {KK} ) & wait; echo st=$?"),
			format!("{}st=0\n", kill(&format!("( {KK} )"))),
		),
		(
			format!("set -T; f() {{ trap 'echo r' RETURN; ( : ; {Q} ); echo st=$?; }}; f"),
			format!("{}st=131\nr\n", quit(Q)),
		),
		(
			format!("f() {{ ( :; {Q} ); echo st=$?; }}; trap 'echo r' RETURN; f"),
			format!("{}st=131\n", quit(&format!("( :; {Q} )"))),
		),
		// The line bash had when it forked the process that reports.
		(format!("( ( {Q}; echo a )\necho b\n)"), format!("{}a\nb\n", quit(Q))),
		(format!("( ( {Q}; echo a ); echo b\n)"), format!("{}a\nb\n", quit(Q))),
		(format!("(\n: ; ( {Q}; echo a )\n:\n)"), format!("{}a\n", notice(2, libc::SIGQUIT, Q))),
		(format!("( ( {KK}; echo a ) & wait\necho b\n)"), format!("{}a\nb\n", kill(KK))),
		(format!("{{ {KK}; echo a\n}} & wait"), format!("{}a\n", notice(2, libc::SIGKILL, KK))),
		(format!("{{ {KK}; echo a\n}} | cat"), format!("{}a\n", notice(2, libc::SIGKILL, KK))),
		(
			format!("for i in 1\ndo ( {Q}; echo a\n); done"),
			format!("{}a\n", notice(3, libc::SIGQUIT, Q)),
		),
		(format!("( {Q}; echo a\n) | cat"), format!("{}a\n", notice(2, libc::SIGQUIT, Q))),
		(format!("f() {{\n( {Q}; echo a\n)\n}}; f"), format!("{}a\n", notice(3, libc::SIGQUIT, Q))),
	];
	// `SCRIPT; echo st=$?`: who reports (the command bash names) and the
	// status, then what the script printed after the notice.
	for (script, named, status, after) in [
		(format!("( {Q} ) 2>/dev/null"), format!("( {Q} ) 2> /dev/null"), 131, ""),
		(format!("( :; {Q} ) 2>/dev/null"), format!("( :; {Q} ) 2> /dev/null"), 131, ""),
		(format!("( ( {Q} ) )"), format!("( ( {Q} ) )"), 131, ""),
		(format!("! ( {Q} )"), format!("! ( {Q} )"), 0, ""),
		(format!("! ( ( {Q} ) )"), format!("! ( ( {Q} ) )"), 0, ""),
		(format!("( ( {Q} ) ) 2>/dev/null"), format!("( ( {Q} ) ) 2> /dev/null"), 131, ""),
		(format!("( ( {Q} ) 2>/dev/null )"), format!("( ( {Q} ) 2> /dev/null )"), 131, ""),
		(format!("( :; ( {Q} ) )"), format!("( {Q} )"), 131, ""),
		(format!("( ! ( {Q} ) )"), format!("( {Q} )"), 0, ""),
		(format!("( : ; {Q} >/dev/null )"), format!("{Q} > /dev/null"), 131, ""),
		(format!("( {Q} >/dev/null )"), format!("( {Q} > /dev/null )"), 131, ""),
		(format!("( trap 'echo t' USR1; {Q} )"), Q.to_owned(), 131, ""),
		(format!("( trap 'echo e' ERR; : ; {Q} )"), Q.to_owned(), 131, "e\n"),
		(format!("( : && {Q} )"), format!("( : && {Q} )"), 131, ""),
		(format!("( false || {Q} )"), format!("( false || {Q} )"), 131, ""),
		(format!("( trap '' USR1; : ; {Q} )"), format!("( trap '' USR1; :; {Q} )"), 131, ""),
		(format!("( trap 'echo x' EXIT; : ; {Q} )"), Q.to_owned(), 131, "x\n"),
		(format!("( : ; {Q} 2>&1 )"), format!("{Q} 2>&1"), 131, ""),
		(format!("( : | : ; {Q} )"), format!("( : | :; {Q} )"), 131, ""),
		(format!("( : & {Q} )"), Q.to_owned(), 131, ""),
		(format!("trap 'echo t' USR1; ( :; {Q} )"), format!("( :; {Q} )"), 131, ""),
		(format!("trap 'echo e' ERR; ( :; {Q} )"), format!("( :; {Q} )"), 131, "e\n"),
		(format!("set -E; trap 'echo e' ERR; ( :; {Q} )"), Q.to_owned(), 131, "e\ne\n"),
		(format!("( trap 'echo x' EXIT; {Q} )"), Q.to_owned(), 131, "x\n"),
		(format!("set -T; trap 'echo r' RETURN; ( :; {Q} )"), format!("( :; {Q} )"), 131, ""),
		(format!("( :; ! {Q} )"), Q.to_owned(), 0, ""),
	] {
		rows.push((format!("{script}; echo st=$?"), format!("{}{after}st={status}\n", quit(&named))));
	}
	rows.extend([
		(
			format!("trap 'echo x' EXIT; ( :; {Q} ); echo st=$?"),
			format!("{}st=131\nx\n", quit(&format!("( :; {Q} )"))),
		),
		(
			format!("( :\n{Q} ); echo st=$?"),
			format!("{}st=131\n", notice(2, libc::SIGQUIT, &format!("( :; {Q} )"))),
		),
	]);
	// Prefix assignments (`x=1 cmd`): no difference from `cmd`.
	let killed_x = format!("x=1 {KK}");
	rows.extend([
		(format!("x=1 {kw} & wait; echo st=$?"), format!("{}st=0\n", kill(&format!("x=1 {kw}")))),
		(format!("x=1 {KK} | cat & wait; echo st=$?"), "st=0\n".to_owned()),
		(format!("x=1 {KK}; echo st=$?"), format!("{}st=137\n", kill(&killed_x))),
		(format!("x=1 {KK} | cat; echo st=$?"), "st=0\n".to_owned()),
		(format!("( x=1 {Q} ); echo st=$?"), format!("{}st=131\n", quit(&format!("( x=1 {Q} )")))),
		(
			format!("( :; x=1 {Q} ); echo st=$?"),
			format!("{}st=131\n", quit(&format!("( :; x=1 {Q} )"))),
		),
		(format!("x=1 {Q} 2>/dev/null & wait; echo st=$?"), "st=0\n".to_owned()),
		(
			format!("x=1 y=2 {kw} & wait; echo st=$?"),
			format!("{}st=0\n", kill(&format!("x=1 y=2 {kw}"))),
		),
		(format!("{{ x=1 {KK}; }} & wait; echo st=$?"), format!("{}st=0\n", kill(&killed_x))),
		(format!("x=1 {KK} | x=2 cat & wait; echo st=$?"), "st=0\n".to_owned()),
		(
			format!("x=1 /bin/sleep 30 & kill -KILL $!; {GONE}; jobs; echo next"),
			format!("[1]+  {:<27}x=1 /bin/sleep 30\nnext\n", desc(libc::SIGKILL)),
		),
		// `$!` is the last stage, which ends after the first: the shell blocks
		// in a foreground program (the first stage ends then), which also lets
		// obash end the job before `kill -0` fails (with builtins only it
		// fails before obash's `jobs` shows the job done).
		(
			format!(
				"x=1 {kw} | cat & while kill -0 $! 2>/dev/null; do /bin/sleep 0.01; done; jobs; echo \
				 next"
			),
			format!("[1]+  {:<27}x=1 {kw} | cat\nnext\n", "Done"),
		),
		(
			format!("( x=1 {kw} ) & wait; echo st=$?"),
			format!("{}st=0\n", kill(&format!("( x=1 {kw} )"))),
		),
		(
			format!("f() {{ x=1 {Q}; }}; ( :; f ); echo st=$?"),
			format!("{}st=131\n", quit(&format!("x=1 {Q}"))),
		),
		(format!("x=1 {KK}\necho st=$?"), format!("{}st=137\n", kill(&killed_x))),
	]);
	let mut wrong = Vec::new();
	bounded_bash_rows(rows, &mut wrong);
	assert!(wrong.is_empty(), "{} of the cases differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// What job `a` of
/// [`bash_writes_a_waited_jobs_notice_before_it_waits_for_the_next`]
/// runs (`/bin/sh -c "$KILLER"`): it kills itself with `SIGKILL` once its
/// parent, the shell, has blocked (its state, `ps -o stat`, starts with
/// `S`) or is gone. The shell then waits for it already: a plain `wait`
/// skips a job that ended before it looked.
const KILLER: &str = "until case $(ps -o stat= -p $PPID 2>/dev/null | tr -d \" \") in S*|\"\") \
                      true;; *) false;; esac; do sleep 0.01; done; kill -KILL $$";

/// How long a row of
/// [`bash_writes_a_waited_jobs_notice_before_it_waits_for_the_next`]
/// waits for each event it needs (the notice, the FIFO's reader, the
/// shell's end) before it fails.
const EVENT_LIMIT: Duration = Duration::from_secs(30);

/// bash 5.3 writes a job's notice as soon as `wait` has reaped the job
/// (`wait_for`'s `notify_and_cleanup`), through `wait`'s own redirections,
/// then waits for its next job: with `wait $a $b`, and with a plain `wait`,
/// which waits for the first job still running, again and again
/// (checked-in goldens measured with bash 5.3.20; compared live only with a
/// bash 5.3 or later, [`real_bash_golden`]). Job `a` dies of `SIGKILL` once
/// the shell waits ([`KILLER`]); job `b` reads a FIFO whose write end the
/// test opens only once the notice is in the file it goes to (`$F.out`,
/// which the shell's standard output and error write, or `wait`'s own
/// `2>"$F.err"`), and writes `released` into it. Without the notice there
/// after [`EVENT_LIMIT`] it writes `no-notice`, which fails the row: a
/// shell that holds the notice until `b` has ended.
#[test]
fn bash_writes_a_waited_jobs_notice_before_it_waits_for_the_next() {
	let notice =
		String::from_utf8(long_notice(1, libc::SIGKILL, b"/bin/sh -c \"$KILLER\"")).expect("ASCII");
	let jobs = "exec >\"$F.out\" 2>&1; /bin/sh -c \"$KILLER\" & a=$!; { read -r x < \"$F.fifo\"; \
	            echo \"second $x\"; } & b=$!";
	let rest = "second released\nafter\n";
	let rows = [
		(format!("{jobs}; wait $a $b; echo after"), "out", format!("{notice}{rest}"), String::new()),
		(format!("{jobs}; wait; echo after"), "out", format!("{notice}{rest}"), String::new()),
		(format!("{jobs}; wait $a $b 2>\"$F.err\"; echo after"), "err", rest.to_owned(), notice),
	];
	let mut wrong = Vec::new();
	for (script, watched, out, err) in rows {
		let want = (out, err, Some(Exit(0)));
		let obash = OsStr::new(env!("CARGO_BIN_EXE_obash"));
		let mut shells = vec![("obash", obash.to_owned())];
		if let Some(bash) = real_bash_golden() {
			shells.push(("bash", bash.into_os_string()));
		}
		for (name, program) in shells {
			let got = released_after_notice(&program, &script, watched);
			if got != want {
				wrong.push(format!("{name}: {script}\n  got:  {got:?}\n  want: {want:?}"));
			}
		}
	}
	assert!(wrong.is_empty(), "{} of the runs differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// One row of
/// [`bash_writes_a_waited_jobs_notice_before_it_waits_for_the_next`]: `program`
/// as bash runs `script` with `F` and [`KILLER`] set and the FIFO
/// `$F.fifo` made. Once `$F.<watched>` holds the notice ([`desc`] of
/// `SIGKILL`) the FIFO gets `released`, or after [`EVENT_LIMIT`]
/// `no-notice`. What `$F.out` and `$F.err` hold at the shell's end (pids
/// masked, [`mask_pids`]), and how it ended.
fn released_after_notice(
	program: &OsStr,
	script: &str,
	watched: &str,
) -> (String, String, Option<End>) {
	let dir = tempfile::tempdir().expect("a directory for the shell's files");
	let f = dir.path().join("f");
	let fifo = f.with_extension("fifo");
	let fifo_c = CString::new(fifo.as_os_str().as_bytes()).expect("a path without NUL");
	// SAFETY: a NUL-terminated path, alive for the call.
	let made = unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) };
	assert_eq!(made, 0, "mkfifo: {}", io::Error::last_os_error());
	let shell = Run::script(program, "bash", script)
		.env("F", &f)
		.env("KILLER", KILLER)
		.own_group()
		.spawn();
	let read = |ext: &str| fs::read(f.with_extension(ext)).unwrap_or_default();
	let killed = desc(libc::SIGKILL);
	let noticed = || String::from_utf8_lossy(&read(watched)).contains(&killed);
	let deadline = Instant::now() + EVENT_LIMIT;
	while !noticed() && Instant::now() < deadline {
		std::thread::sleep(Duration::from_millis(5));
	}
	let word: &[u8] = if noticed() {
		b"released\n"
	} else {
		b"no-notice\n"
	};
	// Job `b` holds the FIFO open for reading by now or soon; until it does,
	// an open of the write end that does not block fails with `ENXIO`.
	let deadline = Instant::now() + EVENT_LIMIT;
	let mut writer = loop {
		match fs::OpenOptions::new()
			.write(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(&fifo)
		{
			Ok(writer) => break writer,
			Err(e) if e.raw_os_error() == Some(libc::ENXIO) && Instant::now() < deadline => {
				std::thread::sleep(Duration::from_millis(5));
			},
			Err(e) => {
				let why = format!("{script}: no reader opened the FIFO ({e})");
				let ended = shell.end_within(Duration::ZERO, &why);
				panic!("{why}; the shell had ended: {ended:?}");
			},
		}
	};
	writer.write_all(word).expect("write to the FIFO");
	drop(writer);
	let ended = shell.end_within(EVENT_LIMIT, script);
	assert!(
		ended.stdout.is_empty() && ended.stderr.is_empty(),
		"{script}: output outside its files: {ended:?}"
	);
	let masked = |ext: &str| String::from_utf8_lossy(&mask_pids(&read(ext))).into_owned();
	(masked("out"), masked("err"), ended.end())
}

/// A command or process substitution reports no background job a signal
/// killed, as bash 5.3's does not (`command_substitute` and
/// `process_substitute` set `SUBSHELL_COMSUB`), nor does what runs in it
/// without a fork (a function, `eval`); each fork of it does
/// (`execute_in_subshell` and `execute_simple_command`'s child start a new
/// `subshell_environment`): a `( … )`, a `&` job, a pipeline stage. Both
/// also set `startup_state` to 2, as a `-c` shell's, which a fork keeps:
/// in posix mode a fork of a substitution reports nothing, in a script file
/// too, whose own `( … )` does. Checked-in goldens measured with bash
/// 5.3.20 (compared live only with a bash 5.3 or later,
/// [`real_bash_golden`]); each script starts with `exec 2>&1`.
#[test]
fn bash_reports_a_job_killed_in_a_fork_of_a_substitution() {
	const K: &str = "/bin/sleep 30 & kill -KILL $!; wait $!; echo st=$?";
	let out = |name: &str, reports: bool| {
		let notice = format!("{name}: line 1: PID {:<27}/bin/sleep 30\n", desc(libc::SIGKILL));
		format!("{}st=137\n", if reports { notice.as_str() } else { "" })
	};
	let mut wrong = Vec::new();
	let mut check = |shown: String, ours: &Outcome, want: String| {
		let got = (String::from_utf8_lossy(&mask_pids(&ours.stdout)).into_owned(), ours.end());
		if got != (want.clone(), Some(Exit(0))) {
			wrong.push(format!("{shown}\n  got:  {got:?}\n  want: {want:?}"));
		}
	};
	let c_rows = [
		(format!("x=$( ( {K} ) ); echo \"$x\""), true),
		(format!("x=$( {{ {K}; }} & wait $! ); echo \"$x\""), true),
		(format!("x=$( {K} ); echo \"$x\""), false),
		(format!("x=$( {{ {K}; }} | cat ); echo \"$x\""), true),
		(format!("x=$( true | {{ {K}; }} ); echo \"$x\""), true),
		(format!("f() {{ {K}; }}; x=$(f); echo \"$x\""), false),
		(format!("f() {{ {K}; }}; x=$( f & wait $! ); echo \"$x\""), true),
		(format!("f() {{ {K}; }}; x=$( f | cat ); echo \"$x\""), true),
		(format!("x=$( eval '{K}' ); echo \"$x\""), false),
		(format!("x=$( cat <( {K} ) ); echo \"$x\""), false),
		(format!("cat <( {K} )"), false),
		(format!("cat <( ( {K} ) )"), true),
		(format!("x=$( y=$( ( {K} ) ); echo \"$y\" ); echo \"$x\""), true),
		(format!("x=` ( {K} ) `; echo \"$x\""), true),
		(format!("( x=$( ( {K} ) ); echo \"$x\" )"), true),
		(format!("set -o posix; x=$( ( {K} ) ); echo \"$x\""), false),
	];
	for (script, reports) in c_rows {
		let script = format!("exec 2>&1; {script}");
		let ours = Run::script(env!("CARGO_BIN_EXE_obash"), "bash", &script).go();
		check(format!("{script:?}"), &ours, out("bash", reports));
		if let Some(bash) = real_bash_golden() {
			assert_eq!(masked(&ours), masked(&Run::script(bash, "bash", &script).go()), "{script:?}");
		}
	}
	// A script file: `startup_state` 0 but in the substitutions.
	let dir = tempfile::tempdir().expect("a directory for the script");
	let path = dir.path().join("s.sh");
	let file = path.display().to_string();
	let file_rows = [
		(format!("x=$( {K} ); echo \"$x\""), false),
		(format!("x=$( ( {K} ) ); echo \"$x\""), true),
		(format!("cat <( {K} )"), false),
		(format!("cat <( ( {K} ) )"), true),
		(format!("set -o posix; x=$( ( {K} ) ); echo \"$x\""), false),
		(format!("set -o posix; cat <( ( {K} ) )"), false),
		(format!("set -o posix; ( {K} )"), true),
	];
	for (script, reports) in file_rows {
		fs::write(&path, format!("exec 2>&1; {script}\n")).expect("write the script");
		let ours = Run::new(env!("CARGO_BIN_EXE_obash"), "bash", &[&path]).go();
		check(format!("file {script:?}"), &ours, out(&file, reports));
		if let Some(bash) = real_bash_golden() {
			let theirs = Run::new(&bash, "bash", &[&path]).go();
			assert_eq!(masked(&ours), masked(&theirs), "file: {script:?}");
		}
	}
	assert!(wrong.is_empty(), "{} of the cases differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// An asynchronous command without job control starts with `INT` and
/// `QUIT` ignored, as bash 5.3's does (`setup_async_signals`, which sets
/// them `SIG_IGN` with `set_signal_async_ignored`): its programs inherit
/// the ignore (`SigIgn` 6 in `/proc/PID/status`), and so do its forks; a
/// signal sent to the subshell itself does nothing; `trap` lists neither.
/// Such a job's `INT` is ignored when it starts, yet bash 5.3.20 does
/// reset it with `trap - INT` (Posix interpretation 751, `trap.c`'s
/// `restore_default_signal`), unlike a signal ignored when a shell starts,
/// which a non-interactive bash cannot reset: a `trap - INT` before any
/// trap for it gives the subshell and what it starts `INT` at its default
/// (`SigIgn` 4). After a `trap '' INT` or `trap CMD INT`, `trap - INT`
/// puts the ignore back for what it starts, while the subshell itself acts
/// on `INT`, and so does a fork of it (a `( … )`, a pipeline stage), which
/// keeps its parent's own disposition; the fork's programs still ignore
/// `INT`, and a process substitution, asynchronous itself, ignores it
/// again. After `trap - QUIT` a fork still ignores `QUIT`. A trap with an
/// action replaces the ignore while it is set, and a `( … )` forked under
/// it starts with `INT` at its default. A trap the parent shell set is no
/// trap in the job. Under `set -m` (job control) nothing is ignored.
/// Checked-in goldens measured with bash 5.3.20
/// (compared live only with a bash 5.3 or later, [`real_bash_golden`]);
/// each script starts with `exec 2>&1`. `SigIgn` is read where the
/// system's `/proc/PID/status` shows it (Linux does; gVisor's has no
/// `SigIgn` line, so its rows run on runc and on hosts, not under gVisor);
/// each run starts with every signal at its default, whatever the machine
/// ignored (`pty_support::every_signal_at_its_default`), and the
/// comparisons leave out glibc's own signals 32 and 33
/// ([`without_glibc_signals`]).
#[test]
fn an_asynchronous_command_ignores_int_and_quit() {
	const G: &str = "/bin/grep -E '^SigIgn' /proc/self/status";
	let sig_ign_shown = fs::read_to_string("/proc/self/status")
		.is_ok_and(|s| s.lines().any(|l| l.starts_with("SigIgn:")));
	let mut rows: Vec<(String, String)> = [
		("/bin/sh -c 'kill -QUIT $$; echo alive' & wait $!; echo st=$?", "alive\nst=0\n"),
		("/bin/sh -c 'kill -INT $$; echo alive' & wait $!; echo st=$?", "alive\nst=0\n"),
		("( kill -INT $BASHPID; echo alive ) & wait; echo st=$?", "alive\nst=0\n"),
		("( kill -QUIT $BASHPID; echo alive ) & wait; echo st=$?", "alive\nst=0\n"),
		("( trap 'echo got' INT; kill -INT $BASHPID; echo after ) & wait", "got\nafter\n"),
		("( trap; trap -p INT ) & wait; echo done", "done\n"),
		("( trap '' INT; trap ) & wait", "trap -- '' SIGINT\n"),
		("( trap - INT; kill -INT $BASHPID; echo alive ) & wait; echo st=$?", "st=0\n"),
		("( trap - INT; ( kill -INT $BASHPID; echo no ); echo st=$? ) & wait", "st=130\n"),
		("( trap '' INT; trap - INT; kill -INT $BASHPID; echo alive ) & wait; echo st=$?", "st=0\n"),
		(
			"( trap '' INT; trap - INT; ( kill -INT $BASHPID; echo alive ); echo st=$? ) & wait",
			"st=130\n",
		),
		(
			"( trap 'echo x' INT; trap - INT; ( kill -INT $BASHPID; echo alive ); echo st=$? ) & wait",
			"st=130\n",
		),
		(
			"( trap 'echo x' INT; trap - INT; ( ( kill -INT $BASHPID; echo alive ); echo st=$? ) ) & \
			 wait",
			"st=130\n",
		),
		(
			"( trap 'echo x' INT; trap - INT; { kill -INT $BASHPID; echo alive; } | cat; echo st=$? \
			 ) & wait",
			"st=0\n",
		),
		(
			"( trap 'echo x' INT; trap - INT; cat <( kill -INT $BASHPID; echo alive ); echo st=$? ) \
			 & wait",
			"alive\nst=0\n",
		),
		(
			"( trap '' QUIT; trap - QUIT; ( kill -QUIT $BASHPID; echo alive ); echo st=$? ) & wait",
			"alive\nst=0\n",
		),
		(
			"( trap 'echo x' QUIT; trap - QUIT; ( kill -QUIT $BASHPID; echo alive ); echo st=$? ) & \
			 wait",
			"alive\nst=0\n",
		),
	]
	.into_iter()
	.map(|(script, out)| (script.to_owned(), out.to_owned()))
	.collect();
	if sig_ign_shown {
		for (script, mask) in [
			(G.to_owned(), 0u8),
			(format!("{G} & wait"), 6),
			(format!("( {G} ) & wait"), 6),
			(format!("{{ {G}; }} & wait"), 6),
			(format!("{G} | cat & wait"), 6),
			(format!("cat <({G})"), 6),
			(format!("( ( {G} ) ) & wait"), 6),
			(format!("set -m; {G} & wait"), 0),
			(format!("( trap - INT; {G} ) & wait"), 4),
			(format!("( trap - QUIT; {G} ) & wait"), 2),
			(format!("( trap - INT QUIT; {G} ) & wait"), 0),
			(format!("( trap '' INT; {G} ) & wait"), 6),
			(format!("( trap '' INT; trap - INT; {G} ) & wait"), 6),
			(format!("( trap 'echo x' INT; {G} ) & wait"), 4),
			(format!("( trap 'echo x' INT; trap - INT; {G} ) & wait"), 6),
			(format!("( trap 'echo x' INT; ( {G} ) ) & wait"), 4),
			(format!("( trap 'echo x' INT; trap - INT; ( {G} ) ) & wait"), 6),
			(format!("( trap 'echo x' INT; trap - INT; ( ( {G} ) ) ) & wait"), 6),
			(format!("trap 'echo t' INT; ( {G} ) & wait"), 6),
			(format!("trap '' INT; ( trap - INT; {G} ) & wait"), 6),
		] {
			rows.push((script, format!("SigIgn:\t{mask:016x}\n")));
		}
	}
	let mut wrong = Vec::new();
	for (script, out) in rows {
		let script = format!("exec 2>&1; {script}");
		let ours =
			without_glibc_signals(&Run::script(env!("CARGO_BIN_EXE_obash"), "bash", &script).go());
		let got = (String::from_utf8_lossy(&ours.stdout).into_owned(), ours.end());
		if got != (out.clone(), Some(Exit(0))) {
			wrong.push(format!("{script:?}\n  got:  {got:?}\n  want: {out:?}"));
		}
		if let Some(bash) = real_bash_golden() {
			let real = without_glibc_signals(&Run::script(bash, "bash", &script).go());
			assert_eq!(masked(&ours), masked(&real), "{script:?}");
		}
	}
	// zsh 5.9 (`entersubsh` with `ESUB_ASYNC`), on every platform: `''`
	// traps it lists, which `trap -` removes (`SigIgn` 4 after `trap ''
	// INT; trap - INT` too); a `( … )` inside the job starts with them
	// unset (`SigIgn` 0). Checked-in goldens measured with zsh 5.9, compared
	// live only with a zsh 5.9 (as `zsh_oracle::version_is_5_9`, which
	// reports nothing).
	let mut zsh_rows: Vec<(String, String)> = [
		("/bin/sh -c 'kill -QUIT $$; echo alive' & wait $!; echo st=$?", "alive\nst=0\n"),
		("/bin/sh -c 'kill -INT $$; echo alive' & wait $!; echo st=$?", "alive\nst=0\n"),
		("( trap; trap -p INT ) & wait; echo done", "trap -- '' INT\ntrap -- '' QUIT\ndone\n"),
		// `settrap` removes the parent's trap function too.
		(
			"TRAPINT() { print fn }; ( trap ) & wait; print done",
			"trap -- '' INT\ntrap -- '' QUIT\ndone\n",
		),
	]
	.into_iter()
	.map(|(script, out)| (script.to_owned(), out.to_owned()))
	.collect();
	if sig_ign_shown {
		for (script, mask) in [
			(format!("{G} & wait"), 6u8),
			(format!("( {G} ) & wait"), 6),
			(format!("{{ {G}; }} & wait"), 6),
			(format!("{G} | cat & wait"), 6),
			(format!("cat <({G})"), 6),
			(format!("( trap - INT; {G} ) & wait"), 4),
			(format!("( trap - INT QUIT; {G} ) & wait"), 0),
			(format!("( ( {G} ) ) & wait"), 0),
			(format!("( trap '' INT; trap - INT; {G} ) & wait"), 4),
		] {
			zsh_rows.push((script, format!("SigIgn:\t{mask:016x}\n")));
		}
	}
	let zsh_5_9 = zsh_oracle::version_is_5_9();
	for (script, out) in zsh_rows {
		let script = format!("exec 2>&1; {script}");
		let ours =
			without_glibc_signals(&Run::script(env!("CARGO_BIN_EXE_obash"), "zsh", &script).go());
		let got = (String::from_utf8_lossy(&ours.stdout).into_owned(), ours.end());
		if got != (out.clone(), Some(Exit(0))) {
			wrong.push(format!("zsh: {script:?}\n  got:  {got:?}\n  want: {out:?}"));
		}
		if zsh_5_9 {
			let real = without_glibc_signals(&Run::script(zsh_oracle::path(), "zsh", &script).go());
			assert_eq!(ours, real, "zsh: {script:?}");
		}
	}
	assert!(wrong.is_empty(), "{} of the cases differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// `o` with signals 32 and 33 cleared from each `SigIgn:\t<hex>` line of
/// its stdout. glibc keeps them for itself (`SIGCANCEL`, `SIGSETXID`; its
/// `sigaction` refuses them), and its `posix_spawn` child, which is how
/// obash starts a program, sets them by its own rules: in builds pods
/// obash's programs had them ignored though obash started with every signal
/// at its default, while zsh's and bash's programs, started by `fork`, had
/// neither. A shell script cannot name them, so they are no part of what a
/// shell decides.
fn without_glibc_signals(o: &Outcome) -> Outcome {
	let keep = !((1u64 << 31) | (1u64 << 32));
	let text = String::from_utf8_lossy(&o.stdout);
	let mut out = String::with_capacity(text.len());
	for line in text.split_inclusive('\n') {
		let bits = line
			.strip_prefix("SigIgn:\t")
			.and_then(|rest| u64::from_str_radix(rest.trim_end_matches('\n'), 16).ok());
		match bits {
			Some(bits) => {
				std::fmt::Write::write_fmt(&mut out, format_args!("SigIgn:\t{:016x}", bits & keep))
					.expect("a String takes any text");
				if line.ends_with('\n') {
					out.push('\n');
				}
			},
			None => out.push_str(line),
		}
	}
	Outcome { stdout: out.into_bytes(), ..o.clone() }
}

/// A `/bin/sh` script, run as `sh -c SHELL_ONLY sh SIG PID [FILE]`: it
/// makes `FILE` (when given), sends `SIG` to the shell `PID` from outside
/// (`0`: none) and waits for that shell to end (to be gone or a zombie),
/// printing `shell-gone`, or `shell-waited` if it still runs after 500
/// looks: a shell that waits for this command before it acts on the
/// signal. It ignores `TERM` and `HUP`: obash ends the externals a
/// standalone shell leaves running when it exits
/// (`process_shell`'s `a_standalone_exit_ends_running_background_externals`),
/// where bash and zsh leave them. It has no single quote, so a script can quote
/// it so.
///
/// With `WAIT_FOR` set, it sends the signal only once the shell's state
/// (`ps -o stat`) starts with `WAIT_FOR`, or the shell is gone: the real
/// bash runs with `WAIT_FOR=S`, which after its fork it reaches when it
/// blocks in `waitpid` for this command. bash 5.2.21 acts on a terminating
/// signal that comes before it blocks there only once the command has
/// ended: on a loaded machine the signal came that early, and bash waited
/// 500 looks.
const SHELL_ONLY: &str = "trap \"\" TERM HUP; [ -n \"$3\" ] && : > \"$3\"; [ -n \"$WAIT_FOR\" ] \
                          && until case $(ps -o stat= -p $2 2>/dev/null | tr -d \" \") in \
                          \"$WAIT_FOR\"*|\"\") true;; *) false;; esac; do sleep 0.01; done; kill \
                          -$1 $2; i=0; while [ $i -lt 500 ]; do case $(ps -o stat= -p $2 \
                          2>/dev/null | tr -d \" \") in \"\"|Z*) echo shell-gone; exit;; esac; \
                          sleep 0.01; i=$((i+1)); done; echo shell-waited";

/// bash catches its fatal signals once an EXIT trap is set (`set_signal` →
/// `initialize_terminating_signals`): the trap runs (with `$?` as it was),
/// then the shell dies of the signal, whether the signal comes from the
/// shell (`kill`) or from another process (`/bin/kill`, or a command still
/// running, which the shell does not wait for); a subshell with a trap of
/// its own does the same. A signal bash does not catch (`PROF`) and a
/// trapped one behave as without the EXIT trap.
#[test]
fn bash_runs_its_exit_trap_before_dying_of_a_fatal_signal() {
	let from_outside =
		format!("trap 'echo x $?' EXIT; /bin/sh -c '{SHELL_ONLY}' sh TERM $$; echo not-reached");
	let cases = [
		SignalCase {
			script: "trap 'echo x $?' EXIT; kill -TERM $$; echo not-reached",
			stdout: b"x 0\n",
			end:    Signal(libc::SIGTERM),
		},
		SignalCase {
			script: "trap 'echo x $?' EXIT; kill -HUP $$; echo not-reached",
			stdout: b"x 0\n",
			end:    Signal(libc::SIGHUP),
		},
		SignalCase {
			script: "trap 'echo x $?' EXIT; /bin/kill -TERM $$; echo not-reached",
			stdout: b"x 0\n",
			end:    Signal(libc::SIGTERM),
		},
		SignalCase {
			script: "trap 'echo x $?' EXIT; /bin/kill -HUP $$; echo not-reached",
			stdout: b"x 0\n",
			end:    Signal(libc::SIGHUP),
		},
		SignalCase {
			script: &from_outside,
			stdout: b"x 0\nshell-gone\n",
			end:    Signal(libc::SIGTERM),
		},
		SignalCase {
			script: "f() { kill -TERM $$; echo not-reached; }; trap 'echo x $?' EXIT; f",
			stdout: b"x 0\n",
			end:    Signal(libc::SIGTERM),
		},
		SignalCase {
			script: "( trap 'echo sub-x $?' EXIT; kill -TERM $BASHPID; echo not-reached ); echo st=$?",
			stdout: b"sub-x 0\nst=143\n",
			end:    Exit(0),
		},
		SignalCase {
			script: "trap 'echo x' EXIT; kill -PROF $$; echo not-reached",
			stdout: b"",
			end:    Signal(libc::SIGPROF),
		},
		SignalCase {
			script: "trap 'echo x' EXIT; trap 'echo t' TERM; kill -TERM $$; echo after",
			stdout: b"t\nafter\nx\n",
			end:    Exit(0),
		},
	];
	for SignalCase { script, stdout, end } in cases {
		let ours = Run::script(env!("CARGO_BIN_EXE_obash"), "bash", script).go();
		// bash also prints a notice of the subshell that died (on stderr),
		// which obash does not: stdout and the end are compared.
		assert_eq!((ours.stdout.as_slice(), ours.end()), (stdout, Some(end)), "{script}");
		if let Some(bash) = real_bash() {
			// bash waits for the command in `waitpid` ([`SHELL_ONLY`]).
			let theirs = Run::script(bash, "bash", script).env("WAIT_FOR", "S").go();
			assert_eq!((&ours.stdout, ours.end()), (&theirs.stdout, theirs.end()), "{script}");
		}
	}
}

/// zsh's `entersubsh`: a `( … )`, `&` or `$( )` subshell unsets the traps
/// it inherits, ignored (`''`) ones too unless `posixtraps` is set, so a
/// signal sent to it has its default action; a pipeline stage keeps every
/// trap and runs a caught one itself. (bash keeps `''` traps in every
/// subshell and resets the others in every one.) The caught trap is
/// `USR1`'s (10 on Linux, 30 on macOS), never signal 31's, whose trap zsh
/// 5.9 keeps
/// ([`a_zsh_subshell_unsets_signal_31s_trap_which_zsh_5_9_keeps`]).
#[test]
fn a_zsh_subshell_unsets_its_traps_and_a_pipeline_stage_keeps_them() {
	let script = "zmodload zsh/system; trap '' TERM; trap 'print caught-usr1' USR1
( kill -TERM $sysparams[pid]; print not-reached ); print paren=$?
{ kill -USR1 $sysparams[pid]; print stage-alive } | cat; print stage=$pipestatus
{ kill -TERM $sysparams[pid]; print not-reached } & wait $!; print bg=$?
x=$(kill -TERM $sysparams[pid]; print not-reached); print \"subst=$? $x\"
setopt posixtraps; ( kill -TERM $sysparams[pid]; print posix-alive ); print posix=$?
( trap ); print listed";
	let ours = Run::script(env!("CARGO_BIN_EXE_obash"), "zsh", script).go();
	assert_eq!(
		(
			String::from_utf8_lossy(&ours.stdout).into_owned(),
			String::from_utf8_lossy(&ours.stderr).into_owned(),
			ours.code
		),
		(
			"paren=143\ncaught-usr1\nstage-alive\nstage=0 0\nbg=143\nsubst=143 \
			 \nposix-alive\nposix=0\ntrap -- '' TERM\nlisted\n"
				.to_owned(),
			String::new(),
			Some(0)
		)
	);
	if have_zsh() {
		assert_eq!(ours, Run::script(zsh_oracle::path(), "zsh", script).go());
	}
}

/// zsh 5.9's `entersubsh` stops one signal short: it unsets a subshell's
/// traps for each `sig < SIGCOUNT` (`Src/exec.c:1037`), and `SIGCOUNT` is
/// the highest signal number of the C library zsh was built with
/// (`Src/signames2.awk:63`): 31 on Linux (`SYS`) and on macOS (`USR2`). So a
/// `( … )`, `&` or `$( )` subshell of zsh 5.9 keeps that signal's trap,
/// lists it and runs it. obash unsets it with the others, as zsh after 5.9
/// does (zsh-users/zsh@4616ea398a, "off-by-one error when resetting signals
/// on subshell entrance", loops `sig <= SIGCOUNT`): a difference from zsh
/// 5.9 kept on purpose and pinned on both sides here, so that this fails
/// when either side changes. A real zsh other than 5.9 (a later one, or 5.9
/// with that fix) must do as obash does.
#[test]
fn a_zsh_subshell_unsets_signal_31s_trap_which_zsh_5_9_keeps() {
	// zsh's `SIGCOUNT` signal, by the C library's numbers.
	let (name, number) = if cfg!(target_os = "macos") {
		("USR2", libc::SIGUSR2)
	} else {
		("SYS", libc::SIGSYS)
	};
	assert_eq!(number, 31, "zsh's SIGCOUNT: {name} is {number} here, not 31");
	let script = format!(
		"zmodload zsh/system; trap 'print caught' {name}; ( trap ); print listed
( kill -{name} $sysparams[pid]; print paren-alive ); print paren=$?
{{ kill -{name} $sysparams[pid]; print bg-alive }} & wait $!; print bg=$?
x=$(kill -{name} $sysparams[pid]; print subst-alive); print \"subst=$? $x\""
	);
	let text = |o: &Outcome| {
		(
			String::from_utf8_lossy(&o.stdout).into_owned(),
			String::from_utf8_lossy(&o.stderr).into_owned(),
			o.code,
		)
	};
	let ours = Run::script(env!("CARGO_BIN_EXE_obash"), "zsh", &script).go();
	let died = 128 + number;
	assert_eq!(
		text(&ours),
		(format!("listed\nparen={died}\nbg={died}\nsubst={died} \n"), String::new(), Some(0)),
		"obash unsets the {name} trap in each subshell"
	);
	if have_zsh() {
		let real = Run::script(zsh_oracle::path(), "zsh", &script).go();
		if zsh_oracle::version_is_5_9() {
			assert_eq!(
				text(&real),
				(
					format!(
						"trap -- 'print caught' \
						 {name}\nlisted\ncaught\nparen-alive\nparen=0\ncaught\nbg-alive\nbg=0\nsubst=0 \
						 caught\nsubst-alive\n"
					),
					String::new(),
					Some(0)
				),
				"zsh 5.9 keeps the {name} trap in each subshell (exec.c:1037)"
			);
		} else {
			// A zsh with the fix (after 5.9, or 5.9 with 4616ea398a) does as
			// obash.
			assert_eq!(
				text(&real),
				text(&ours),
				"a zsh other than 5.9 unsets the {name} trap as obash does"
			);
		}
	}
}

/// bash (which ignores `QUIT` "in all cases") and a non-interactive zsh
/// (`init_signals`) ignore `QUIT` in the shell's own process: one sent by
/// another process (`/bin/kill`) or by the shell itself does nothing, and
/// the commands the shell runs get it at its default (the `sh` below dies
/// of it, and bash prints its notice, as bash 5.3.20 does: a golden,
/// compared live only with a bash 5.3 or later, [`real_bash_golden`]). A
/// zsh trap removed for it gives it its default (`removetrap`); bash keeps
/// ignoring it.
#[test]
fn the_shell_ignores_quit_and_its_commands_get_it_at_its_default() {
	let quit = long_notice(1, libc::SIGQUIT, b"/bin/sh -c 'kill -QUIT $$; echo child-alive'");
	let cases = [
		("zsh", Vec::new(), SignalCase {
			script: "/bin/kill -QUIT $$; kill -QUIT $$; print alive; /bin/sh -c 'kill -QUIT $$; echo \
			         child-alive'; print st=$?",
			stdout: b"alive\nst=131\n",
			end:    Exit(0),
		}),
		("zsh", Vec::new(), SignalCase {
			script: "trap - QUIT; /bin/kill -QUIT $$; print not-reached",
			stdout: b"",
			end:    Signal(libc::SIGQUIT),
		}),
		("bash", quit, SignalCase {
			script: "/bin/kill -QUIT $$; kill -QUIT $$; echo alive; /bin/sh -c 'kill -QUIT $$; echo \
			         child-alive'; echo st=$?; trap - QUIT; /bin/kill -QUIT $$; echo after-reset",
			stdout: b"alive\nst=131\nafter-reset\n",
			end:    Exit(0),
		}),
	];
	for (name, stderr, SignalCase { script, stdout, end }) in cases {
		let ours = Run::script(env!("CARGO_BIN_EXE_obash"), name, script).go();
		assert_eq!(
			(ours.stdout.as_slice(), mask_pids(&ours.stderr), ours.end()),
			(stdout, stderr, Some(end)),
			"{name}: {script}"
		);
		let real = if name == "zsh" {
			real(name)
		} else {
			real_bash_golden()
		};
		if let Some(real) = real {
			assert_eq!(
				masked(&ours),
				masked(&Run::script(real, name, script).go()),
				"{name}: {script}"
			);
		}
	}
}

/// A non-interactive zsh ignores `QUIT` (`init_signals`) and leaves the
/// signals ignored when it started ignored: such a signal sent to the
/// shell while it has no trap for it does nothing. A trap set or removed
/// for one gives it its own disposition (`settrap`, `removetrap`), so the
/// signal then ends the shell.
#[test]
fn zsh_ignores_quit_and_the_signals_ignored_on_entry_while_untrapped() {
	let held = "kill -QUIT $$; kill -USR1 $$; kill -HUP $$; print alive; trap - USR1; kill -USR1 \
	            $$; print not-reached";
	let released = "trap : QUIT; trap - QUIT; kill -QUIT $$; print not-reached";
	let run = |program: &OsStr, script: &str| {
		Run::script(program, "zsh", script)
			.ignoring(&[libc::SIGUSR1, libc::SIGHUP])
			.go()
	};
	let obash = OsStr::new(env!("CARGO_BIN_EXE_obash"));
	let ours_held = run(obash, held);
	assert_eq!(
		(ours_held.stdout.as_slice(), ours_held.stderr.as_slice(), ours_held.signal),
		(&b"alive\n"[..], &b""[..], Some(libc::SIGUSR1))
	);
	let ours_released = run(obash, released);
	assert_eq!(
		(ours_released.stdout.as_slice(), ours_released.stderr.as_slice(), ours_released.signal),
		(&b""[..], &b""[..], Some(libc::SIGQUIT))
	);
	if have_zsh() {
		assert_eq!(ours_held, run(zsh_oracle::path().as_os_str(), held));
		assert_eq!(ours_released, run(zsh_oracle::path().as_os_str(), released));
	}
}

/// zsh handles a `HUP` it has no trap for (`zhandler`): `zexit(SIGHUP)`,
/// an exit with status 1, not a death by the signal (its exit status is
/// `Some`), at once, whether the signal comes from the shell (`kill`) or
/// from another process (`/bin/kill`, or a command still running, which
/// the shell does not wait for). The EXIT trap in effect runs first, and
/// no other: inside a function the function's own (zsh keeps the shell's
/// away while a function runs); in a subshell the subshell's, and the
/// shell goes on. `trap - HUP` gives it back zsh's handler (`removetrap`).
#[test]
fn an_untrapped_hup_makes_zsh_exit_with_status_1_after_the_exit_trap_in_effect() {
	let from_outside =
		format!("trap 'print x $?' EXIT; /bin/sh -c '{SHELL_ONLY}' sh HUP $$; print not-reached");
	// The shell's own `kill` from a background job, once the command runs.
	let from_a_job = format!(
		"f=$(mktemp -u); trap 'print x $?; /bin/rm -f $f' EXIT; {{ while [[ ! -e $f ]]; do sleep \
		 0.01; done; kill -HUP $$ }} & /bin/sh -c '{SHELL_ONLY}' sh 0 $$ $f; print not-reached"
	);
	let cases: [(&str, &[u8], i32); 8] = [
		("trap 'print root-exit $?' EXIT; kill -HUP $$; print not-reached", b"root-exit 1\n", 1),
		("trap 'print root-exit $?' EXIT; /bin/kill -HUP $$; print not-reached", b"root-exit 1\n", 1),
		(&from_outside, b"x 1\nshell-gone\n", 1),
		(&from_a_job, b"x 1\nshell-gone\n", 1),
		(
			"trap 'print t' HUP; trap - HUP; trap 'print x $?' EXIT; /bin/kill -HUP $$; print \
			 not-reached",
			b"x 1\n",
			1,
		),
		(
			"f() { trap 'print f-exit $?' EXIT; kill -HUP $$; print not-reached }; trap 'print \
			 root-exit $?' EXIT; f; print not-reached",
			b"f-exit 1\n",
			1,
		),
		(
			"f() { kill -HUP $$; print not-reached }; trap 'print root-exit $?' EXIT; f; print \
			 not-reached",
			b"",
			1,
		),
		(
			"zmodload zsh/system; ( trap 'print sub-exit $?' EXIT; kill -HUP $sysparams[pid]; print \
			 not-reached ); print st=$?; exit 3",
			b"sub-exit 1\nst=1\n",
			3,
		),
	];
	for (script, out, status) in cases {
		let ours = Run::script(env!("CARGO_BIN_EXE_obash"), "zsh", script).go();
		assert_eq!(
			(ours.stdout.as_slice(), ours.stderr.as_slice(), ours.code),
			(out, &b""[..], Some(status)),
			"{script}"
		);
		if have_zsh() {
			assert_eq!(ours, Run::script(zsh_oracle::path(), "zsh", script).go(), "{script}");
		}
	}
}

/// The parent shell of a shell that died of a signal: `$?` is 128 + the
/// signal's number, and a non-interactive parent prints no job notice.
#[test]
fn a_parent_shell_reports_its_child_shells_signal_death() {
	let dir = tempfile::tempdir().expect("a directory for a `zsh` link");
	let zsh = dir.path().join("zsh");
	let obash = process_support::absolute(env!("CARGO_BIN_EXE_obash").as_ref());
	std::os::unix::fs::symlink(obash, &zsh).expect("link obash as zsh");
	let line = |shell: &std::path::Path| {
		format!("{} -f -c 'kill -TERM $$'; print -r -- st=$?", shell.display())
	};
	let ours = Run::script(&zsh, "zsh", line(&zsh)).go();
	assert_eq!(
		(ours.stdout.as_slice(), ours.stderr.as_slice(), ours.code),
		(&b"st=143\n"[..], &b""[..], Some(0))
	);
	if have_zsh() {
		let real = zsh_oracle::path();
		assert_eq!(ours, Run::script(&real, "zsh", line(&real)).go());
	}
}

/// The `core*` files in `dir`.
fn cores(dir: &Path) -> Vec<String> {
	fs::read_dir(dir)
		.expect("read the directory")
		.flatten()
		.map(|e| e.file_name().to_string_lossy().into_owned())
		.filter(|name| name.starts_with("core"))
		.collect()
}

/// An `exec`ed program that dies of a core-dumping signal ends the shell's
/// process by that signal with no core of the shell's own: zsh `exec`s the
/// program, so one process dies and at most its own core exists. The
/// program here sets its core size limit to 0, so neither shell leaves a
/// core. The control: `/bin/sh` killed by `SIGQUIT` with the limit raised
/// dumps a core here; where it does not (no core dump can be seen, as
/// under gVisor), the test says so.
#[test]
fn an_exec_d_programs_core_dump_signal_leaves_no_core_of_the_shell() {
	let args = ["-f", "-c", "exec /bin/sh -c 'ulimit -c 0; kill -QUIT $$'"];
	let control_dir = tempfile::tempdir().expect("a directory for the control's core");
	let control = Run::new("/bin/sh", "sh", &["-c", "kill -QUIT $$"])
		.dumping_in(control_dir.path())
		.go();
	if !control.core {
		zsh_oracle::uncompared(&format!(
			"no core dump can be seen here: /bin/sh killed by SIGQUIT with its core size limit \
			 raised dumped no core (it died of {:?})",
			control.signal
		));
	}
	let dir = tempfile::tempdir().expect("a directory for the shell's core");
	let ours = Run::obash("zsh", &args).dumping_in(dir.path()).go();
	assert_eq!(
		(ours.signal, ours.core, cores(dir.path())),
		(Some(libc::SIGQUIT), false, Vec::new()),
		"{}",
		String::from_utf8_lossy(&ours.stderr)
	);
	if have_zsh() {
		let zsh_dir = tempfile::tempdir().expect("a directory for zsh's core");
		let real = Run::new(zsh_oracle::path(), "zsh", &args)
			.dumping_in(zsh_dir.path())
			.go();
		assert_eq!((ours.signal, ours.core), (real.signal, real.core));
	}
}

/// Shell code of a command's `/bin/sh -c` script that waits until the run
/// has sent its signal ([`Run::go_signalled`] makes `$F.sent` then), so the
/// signal comes while the command runs, however late the run sends it, and
/// not in a time the command allows.
const SENT: &str = "until [ -e \"$F.sent\" ]; do /bin/sleep 0.01; done";

/// A signal case: `shell` runs `script` with `-c` and gets `sig` from
/// outside (`group`: sent to its process group, else to the shell alone)
/// once the command it waits for has made `$F`; it prints `stdout` and ends
/// by `end`. With `waits`, each shell gets it only once it and all it runs
/// have blocked ([`Run::when_blocked`]): the case tests a signal that comes
/// while the shell waits, and a shell, or a process it forked, that has
/// not reached its wait yet takes the signal otherwise (bash `wait_for`,
/// `make_child`; obash `wait_starts`). Without, the command runs shell
/// code that never blocks, and each shell gets it once it waits for the
/// copies of itself it forked ([`Run::when_it_waits`]): bash that has
/// forked a subshell and not yet reached `wait_for` takes an `INT` as one
/// that came while it ran shell code, and dies of it at once.
struct SentCase {
	shell:  &'static str,
	script: String,
	sig:    libc::c_int,
	group:  bool,
	stdout: &'static [u8],
	end:    End,
	waits:  bool,
}

/// One run of `script` as `shell` by `program`, which gets `sig` (to its
/// process group with `group`) once the command it waits for has made
/// `$F`; with `blocked`, only once the shell has also blocked
/// ([`Run::when_blocked`]), else once it waits for the copies of itself it
/// forked ([`Run::when_it_waits`]).
fn sent(
	program: &OsStr,
	shell: &'static str,
	script: &str,
	sig: libc::c_int,
	group: bool,
	blocked: bool,
) -> Outcome {
	let dir = tempfile::tempdir().expect("a directory for the start file");
	let started = dir.path().join("started");
	let run = Run::script(program, shell, script).env("F", &started);
	let run = if group { run.own_group() } else { run };
	let run = if blocked {
		run.when_blocked()
	} else {
		run.when_it_waits()
	};
	run.go_signalled(&started, sig, group)
}

/// Run each case under obash and, where it exists, the real shell: both
/// print the same and end the same.
fn run_sent(cases: Vec<SentCase>) {
	run_sent_with(cases, real, &[]);
}

/// [`run_sent`] for bash cases whose `stdout` and `end` are checked-in
/// goldens measured with bash 5.3.20: compared live only with a bash 5.3
/// or later ([`real_bash_golden`]), so nothing goes uncompared without one.
/// The real bash may also print and end as `raced` says for the case of
/// that script ([`run_sent_with`]).
fn run_sent_golden(cases: Vec<SentCase>, raced: &[(String, &[u8], End)]) {
	run_sent_with(
		cases,
		|shell| {
			assert_eq!(shell, "bash", "a golden case is bash's");
			real_bash_golden()
		},
		raced,
	);
}

/// Run each case under obash, then under the real shell `real` names, if
/// any: both print the same and end the same, where the real shell may
/// also print and end as `raced` says for the case of that script (its own
/// timing picks one); obash prints and ends as the case says.
fn run_sent_with(
	cases: Vec<SentCase>,
	real: impl Fn(&str) -> Option<PathBuf>,
	raced: &[(String, &[u8], End)],
) {
	assert!(
		raced
			.iter()
			.all(|(row, ..)| cases.iter().any(|c| c.script == *row)),
		"each raced row is a case"
	);
	for SentCase { shell, script, sig, group, stdout, end, waits } in cases {
		let ours = sent(OsStr::new(env!("CARGO_BIN_EXE_obash")), shell, &script, sig, group, waits);
		let shown = format!(
			"{shell}: {script}, signal {sig} to the {}",
			if group { "group" } else { "shell" }
		);
		assert_eq!(
			(String::from_utf8_lossy(&ours.stdout), ours.end()),
			(String::from_utf8_lossy(stdout), Some(end)),
			"{shown}: {ours:?}"
		);
		if let Some(real) = real(shell) {
			let theirs = sent(real.as_os_str(), shell, &script, sig, group, waits);
			let other = raced
				.iter()
				.find(|(row, ..)| *row == script)
				.map(|&(_, out, end)| (out.to_vec(), Some(end)));
			if other != Some((theirs.stdout.clone(), theirs.end())) {
				assert_eq!(
					(&ours.stdout, ours.end()),
					(&theirs.stdout, theirs.end()),
					"{shown}: {theirs:?}"
				);
			}
		}
	}
}

/// A program the shell runs in place of itself (`exec`, or the last command
/// of a `-c` string run without a fork:
/// [`bash_reports_a_foreground_command_killed_by_a_signal`]) is the shell's
/// process: a signal sent to the shell is the program's, even one the
/// shell traps (the program has no trap) and one the shell has no catch of
/// its own for (`TERM`) or holds ignored for itself (`QUIT`), and the shell
/// ends as the program does. zsh's `HUP` handler and bash's EXIT trap went
/// with the shell: a server the program runs goes on after a `HUP` it
/// handles. zsh runs a last `( … )` in place too, and a trap set in it is
/// the process's: it runs, and the shell goes on. The program makes `$F`
/// once it has started, and goes on only once the run has sent the signal
/// ([`SENT`]).
#[test]
fn a_signal_to_the_shell_reaches_the_program_it_runs_in_place() {
	let program = format!("/bin/sh -c ': > \"$F\"; {SENT}; exec /bin/sleep 5 >/dev/null 2>&1'");
	let server =
		format!("/bin/sh -c 'trap \"echo reload\" HUP; : > \"$F\"; {SENT}; /bin/sleep 1; echo done'");
	let counter = format!(
		"/bin/sh -c 'trap \"echo got\" HUP TERM QUIT; : > \"$F\"; {SENT}; /bin/sleep 1; echo done'"
	);
	let waits = format!("/bin/sh -c ': > \"$F\"; {SENT}; /bin/sleep 1'");
	let case = |shell, script: String, sig, stdout, end| SentCase {
		shell,
		script,
		sig,
		group: false,
		stdout,
		end,
		waits: true,
	};
	run_sent(vec![
		case("zsh", program.clone(), libc::SIGHUP, b"", Signal(libc::SIGHUP)),
		case("zsh", format!("exec {program}"), libc::SIGHUP, b"", Signal(libc::SIGHUP)),
		case("zsh", format!("true; {program}"), libc::SIGHUP, b"", Signal(libc::SIGHUP)),
		case("zsh", server, libc::SIGHUP, b"reload\ndone\n", Exit(0)),
		case("zsh", format!("( {program} )"), libc::SIGHUP, b"", Signal(libc::SIGHUP)),
		case(
			"zsh",
			format!("( trap 'print got' TERM; {waits}; print after )"),
			libc::SIGTERM,
			b"got\nafter\n",
			Exit(0),
		),
		case(
			"zsh",
			format!("( trap 'print h' HUP; {waits}; print after )"),
			libc::SIGHUP,
			b"h\nafter\n",
			Exit(0),
		),
		case("zsh", counter.clone(), libc::SIGTERM, b"got\ndone\n", Exit(0)),
		case("zsh", counter.clone(), libc::SIGQUIT, b"got\ndone\n", Exit(0)),
		case("bash", counter.clone(), libc::SIGTERM, b"got\ndone\n", Exit(0)),
		case("bash", format!("exec {counter}"), libc::SIGQUIT, b"got\ndone\n", Exit(0)),
		case(
			"bash",
			format!("trap 'echo x' EXIT; exec {program}"),
			libc::SIGTERM,
			b"",
			Signal(libc::SIGTERM),
		),
		case(
			"bash",
			format!("trap 'echo t' TERM; exec {program}"),
			libc::SIGTERM,
			b"",
			Signal(libc::SIGTERM),
		),
		case(
			"bash",
			format!("trap 'echo x' EXIT; {program}"),
			libc::SIGTERM,
			b"x\n",
			Signal(libc::SIGTERM),
		),
	]);
}

/// A signal ignored on entry: zsh holds it ignored until a trap for it is
/// set or removed, and `trap - TERM` resets it, so a program it then runs
/// in place of itself gets the `TERM` sent to the shell, as one never
/// ignored; before, the program inherits it ignored. bash cannot reset one
/// (`trap - TERM` leaves it ignored), and the program inherits it ignored.
/// `handles` traps `TERM` and exits 42 on it, which it can only where it did
/// not inherit it ignored (POSIX sh); it makes `$F` once it has started,
/// and goes on once the run has sent the signal ([`SENT`]).
#[test]
fn a_signal_ignored_on_entry_reaches_the_program_run_in_place_once_zsh_resets_it() {
	let handles = format!(
		"/bin/sh -c 'trap \"echo got; exit 42\" TERM; : > \"$F\"; {SENT}; /bin/sleep 1; echo done'"
	);
	let dies = format!("/bin/sh -c ': > \"$F\"; {SENT}; exec /bin/sleep 1'");
	for (shell, script, stdout, end) in [
		("zsh", format!("trap - TERM; exec {handles}"), "got\n", Exit(42)),
		("zsh", format!("trap - TERM; {handles}"), "got\n", Exit(42)),
		("zsh", format!("trap - TERM; exec {dies}"), "", Signal(libc::SIGTERM)),
		("zsh", format!("exec {handles}"), "done\n", Exit(0)),
		("bash", format!("trap - TERM; exec {handles}"), "done\n", Exit(0)),
	] {
		let run = |program: &OsStr| {
			let dir = tempfile::tempdir().expect("a directory for the start file");
			let started = dir.path().join("started");
			Run::script(program, shell, &script)
				.env("F", &started)
				.ignoring(&[libc::SIGTERM])
				.when_blocked()
				.go_signalled(&started, libc::SIGTERM, false)
		};
		let ours = run(OsStr::new(env!("CARGO_BIN_EXE_obash")));
		assert_eq!(
			(String::from_utf8_lossy(&ours.stdout), ours.end()),
			(stdout.into(), Some(end)),
			"{shell}: {script}: {ours:?}"
		);
		if let Some(real) = real(shell) {
			let theirs = run(real.as_os_str());
			assert_eq!(
				(&ours.stdout, ours.end()),
				(&theirs.stdout, theirs.end()),
				"{shell}: {script}: {theirs:?}"
			);
		}
	}
}

/// A terminal's `^C` is the kernel's `INT` to its foreground process group,
/// which the program the shell runs in place of itself gets from the kernel
/// too: the shell gives it no second time, and does not die of it while the
/// program handles it. The program prints `ready`, then `got` for each `INT`
/// and `done` a second later.
#[test]
fn a_terminal_interrupt_reaches_the_program_the_shell_runs_in_place_once() -> io::Result<()> {
	let program = "/bin/sh -c 'trap \"echo got\" INT; echo ready; /bin/sleep 1; echo done'";
	for (name, script) in [("zsh", program.to_owned()), ("bash", format!("exec {program}"))] {
		let flags: &[&str] = if name == "zsh" {
			&["-f", "-c"]
		} else {
			&["-c"]
		};
		let ours = Spawn::obash_as(name);
		let real = if name == "zsh" {
			have_zsh().then(Spawn::real_zsh)
		} else {
			real_bash().map(|bash| Spawn::new(bash).argv0("bash"))
		};
		let shells =
			std::iter::once(("obash", ours)).chain(real.map(|spawn| ("the real shell", spawn)));
		for (who, spawn) in shells {
			let mut shell = spawn
				.args(flags.iter().copied().chain([script.as_str()]))
				.spawn()?;
			shell.read_until("ready\r\n", TIMEOUT)?;
			shell.write("\x03")?;
			let status = shell.wait(TIMEOUT)?;
			let out = shell.output();
			assert_eq!(
				(status.code(), out.matches("got").count(), out.contains("done")),
				(Some(0), 1, true),
				"{who}: {name} -c {script}: {status:?} {out:?}"
			);
		}
	}
	Ok(())
}

/// A program the shell `exec`s replaces it, so no EXIT trap of the shell's
/// runs after the program (bash 5.2.21, zsh 5.9), in a subshell either.
/// The program is `/bin/sh`, which every Unix has there (macOS has no
/// `/bin/true`).
#[test]
fn an_execd_program_leaves_no_exit_trap_to_run() {
	for (shell, script, stdout) in [
		("bash", "trap 'echo x' EXIT; exec /bin/sh -c :", ""),
		("bash", "( trap 'echo sub' EXIT; exec /bin/sh -c : ); echo st=$?", "st=0\n"),
		("zsh", "trap 'print x' EXIT; exec /bin/sh -c :", ""),
	] {
		let ours = Run::script(env!("CARGO_BIN_EXE_obash"), shell, script).go();
		assert_eq!(
			(String::from_utf8_lossy(&ours.stdout), ours.end()),
			(stdout.into(), Some(Exit(0))),
			"{shell}: {script}: {ours:?}"
		);
		if let Some(real) = real(shell) {
			assert_eq!(ours, Run::script(real, shell, script).go(), "{shell}: {script}");
		}
	}
}

/// bash catches `INT` for each wait without job control (`wait_for`'s
/// `wait_sigint_handler`), EXIT trap or not: while it waits for a
/// foreground command it only notes one, and once the command has ended it
/// acts on it (runs the EXIT trap, then dies of `SIGINT`) only if the last
/// process of it to end died of `SIGINT`; else the command caught it and
/// the script goes on. Each stage, subshell and command substitution is a
/// bash process of its own in the group: one that runs shell code dies of
/// the `INT` the group gets at once (after an EXIT trap of its own, which
/// its parent takes as a death by it), one that waits for a command holds
/// it by the same rule, and a trap of its own ends a `wait` it is in with
/// 130. Each bash process that reads a command substitution's output holds
/// it until the read ends, with job control too (`command_substitute`
/// blocks `SIGINT` around `read_comsub`), then acts, whatever its command
/// did. Under `set -m` bash holds nothing for a job, which runs in a
/// process group of its own: neither a `kill` of the shell's pid nor of its
/// group reaches the job's processes, while its substitutions are in the
/// shell's group. The command makes `$F` once it has started, and goes on
/// only once the run has sent the signal ([`SENT`]). Each case's output and
/// end are checked-in goldens measured with bash 5.3.20 (compared live only
/// with a bash 5.3 or later, [`run_sent_golden`]); bash 5.2.21 gives the
/// same, but now and then for the pipeline row `raced` names. The `set -m`
/// pipeline row runs as a script file too.
#[test]
fn bash_acts_on_int_only_once_its_foreground_command_died_of_it() {
	// A command that catches `INT` and outlives it by a second: it prints
	// `child-int` on the signal and `child-done` at its end; `quiet` prints
	// only the latter.
	let child = format!(
		"/bin/sh -c 'trap \"echo child-int\" INT; : > \"$F\"; {SENT}; /bin/sleep 1; echo child-done'"
	);
	let hold = &child;
	let quiet =
		format!("/bin/sh -c 'trap : INT; : > \"$F\"; {SENT}; /bin/sleep 1; echo child-done'");
	// One that dies of `INT` (`sleep` takes it at its default).
	let dies = format!("/bin/sh -c '{SENT}; exec /bin/sleep 3'");
	let script = format!("trap 'echo x' EXIT; {child}; echo after");
	let case = |script, group, stdout, end| SentCase {
		shell: "bash",
		script,
		sig: libc::SIGINT,
		group,
		stdout,
		end,
		waits: true,
	};
	let died = Signal(libc::SIGINT);
	// A pipeline's last stage: it makes `$F` once the first has made `$F.a`,
	// which it removes for the next run.
	let last = "/bin/sh -c 'until [ -e \"$F.a\" ]; do /bin/sleep 0.01; done; rm -f \"$F.a\"; : > \
	            \"$F\"; exec /bin/cat'";
	// Shell code that makes `$F`, then runs on, never blocking, until the run
	// has sent the signal.
	let busy = ": > \"$F\"; until [ -e \"$F.sent\" ]; do :; done";
	// The pipeline whose every stage dies of the `INT`: bash 5.2.21 goes on
	// now and then (`after`), its stages' statuses `130 0` (the last stage's
	// `/bin/sh` took no `INT`, and what it ran read its input to the end) or
	// `130 130`: bash alone on gVisor under load, signalled as here once each
	// process was blocked, 4 runs in 12,600 of this row, 5 in 10,000 with the
	// last stage reading its input itself and the first waiting on a FIFO.
	// bash's timing, not the run's; obash prints the golden.
	let pipeline = format!(
		"trap 'echo x' EXIT; /bin/sh -c ': > \"$F.a\"; {SENT}; exec /bin/sleep 3' | {last}; echo \
		 after"
	);
	let raced = [(pipeline.clone(), &b"after\nx\n"[..], Exit(0))];
	// The `set -m` pipeline's last stage makes `$F` once it runs, so that
	// the `INT` comes while it is there: under `set -m` it is in the job's
	// group, which the group's `INT` does not reach.
	let set_m_pipeline = [
		"set -m; trap 'echo i' INT; ",
		"{ until [ -e \"$F.sent\" ]; do :; done; echo more; } | ",
		"/bin/sh -c ': > \"$F\"; exec cat'; echo after",
	]
	.concat();
	let cases = vec![
		case(script.clone(), false, b"child-done\nafter\nx\n", Exit(0)),
		case(script, true, b"child-int\nchild-done\nafter\nx\n", Exit(0)),
		case(
			format!(
				"trap 'echo x' EXIT; /bin/sh -c ': > \"$F\"; {SENT}; exec /bin/sleep 3'; echo after"
			),
			true,
			b"x\n",
			died,
		),
		case(
			format!("trap 'echo x' EXIT; ( : > \"$F\"; {dies}; echo after-sleep ); echo after"),
			true,
			b"x\n",
			died,
		),
		case(
			format!(
				"trap 'echo x' EXIT; printf 'a\\nb\\n' | while read -r l; do : > \"$F\"; {dies}; echo \
				 $l; done; echo after"
			),
			true,
			b"x\n",
			died,
		),
		// Shell code that never blocks: each shell is signalled once `$F`
		// exists (the subshell makes it itself, once it has set up) and it
		// waits for the subshell ([`Run::when_it_waits`]).
		SentCase {
			waits: false,
			..case(
				"trap 'echo x' EXIT; ( : > \"$F\"; while :; do :; done ); echo after".into(),
				true,
				b"x\n",
				died,
			)
		},
		// A pipeline of externals: the last of its processes to end decides
		// (bash's `waitchld` sets `child_caught_sigint` again for each child
		// it reaps). A stage that catches `INT` and exits 130 half a second
		// after `cat` died of it did not die of it, so the script goes on;
		// when every stage dies of it, the shell acts. The last stage makes
		// `$F` once the first has made `$F.a`: both have started (a stage bash
		// has forked but not yet `exec`ed runs the EXIT trap itself).
		case(
			format!(
				"trap 'echo x' EXIT; /bin/sh -c 'trap \"/bin/sleep 0.5; exit 130\" INT; : > \"$F.a\"; \
				 {SENT}; /bin/sleep 3' | {last}; echo after"
			),
			true,
			b"after\nx\n",
			Exit(0),
		),
		case(pipeline, true, b"x\n", died),
		// A stage of shell code dies of the `INT` at once (`… | while read`,
		// `while …; done | …`), and the command that caught it ends last; a
		// stage or a subshell that waits for that command goes on.
		case(
			format!("trap 'echo x' EXIT; {quiet} | while read l; do echo got $l; done; echo after"),
			true,
			b"after\nx\n",
			Exit(0),
		),
		// Busy shell code that never blocks (a loop that forked `sleep` lost
		// the signal when it came in bash's `make_child`, and ran on): no
		// gate. The stage makes `$F.b` once it has set up, and the command
		// makes `$F` once that exists.
		SentCase {
			waits: false,
			..case(
				format!(
					"trap 'echo x' EXIT; {{ : > \"$F.b\"; while :; do :; done; }} | /bin/sh -c 'trap \
					 \"echo child-int\" INT; until [ -e \"$F.b\" ]; do /bin/sleep 0.01; done; rm -f \
					 \"$F.b\"; : > \"$F\"; {SENT}; /bin/sleep 1; echo child-done'; echo after"
				),
				true,
				b"child-int\nchild-done\nafter\nx\n",
				Exit(0),
			)
		},
		case(
			format!("trap 'echo x' EXIT; {{ {quiet}; }} | cat; echo after"),
			true,
			b"after\nx\n",
			Exit(0),
		),
		case(
			format!("trap 'echo x' EXIT; ( {hold}; echo more ); echo after"),
			true,
			b"child-int\nchild-done\nmore\nafter\nx\n",
			Exit(0),
		),
		// The command of a substitution writes to fd 3, the run's output.
		case(
			format!("trap 'echo x' EXIT; exec 3>&1; v=$({hold} >&3); echo after $v"),
			true,
			b"child-int\nchild-done\nx\n",
			died,
		),
		// No EXIT trap: the same holds.
		case(format!("{hold}; echo after"), true, b"child-int\nchild-done\nafter\n", Exit(0)),
		case(format!("{hold}; echo after"), false, b"child-done\nafter\n", Exit(0)),
		case(
			format!("{quiet} | while read l; do echo got $l; done; echo after"),
			true,
			b"after\n",
			Exit(0),
		),
		case(
			format!("( {hold}; echo more ); echo after"),
			true,
			b"child-int\nchild-done\nmore\nafter\n",
			Exit(0),
		),
		case(
			format!("/bin/sh -c ': > \"$F\"; {SENT}; exec /bin/sleep 3'; echo after"),
			true,
			b"",
			died,
		),
		case(
			format!("exec 3>&1; v=$({hold} >&3); echo after $v"),
			true,
			b"child-int\nchild-done\n",
			died,
		),
		// Under `set -m` bash holds nothing (its child, in a group of its own,
		// gets nothing either).
		case(
			format!(
				"set -m; trap 'echo x' EXIT; /bin/sh -c ': > \"$F\"; {SENT}; exec /bin/sleep 3 \
				 >/dev/null 2>&1'; echo after"
			),
			false,
			b"x\n",
			died,
		),
		// A trap of a subshell's own ends its `wait` with 130, as the root's
		// does.
		case(
			format!(
				"( trap 'echo t' INT; /bin/sh -c ': > \"$F\"; {SENT}; exec /bin/sleep 3' >/dev/null \
				 2>&1 & wait; echo w=$? ); echo after"
			),
			true,
			b"t\nw=130\nafter\n",
			Exit(0),
		),
		case(
			format!(
				"trap 'echo t' INT; /bin/sh -c ': > \"$F\"; {SENT}; exec /bin/sleep 3' >/dev/null \
				 2>&1 & wait; echo w=$?"
			),
			true,
			b"t\nw=130\n",
			Exit(0),
		),
		// A subshell that dies of it through its own EXIT trap: its parent
		// reads a death by `SIGINT`, also where the trap runs a program.
		case(
			format!(
				"( trap 'echo sub' EXIT; /bin/sh -c ': > \"$F\"; {SENT}; exec /bin/sleep 3'; echo \
				 more ); echo after"
			),
			true,
			b"sub\n",
			died,
		),
		SentCase {
			waits: false,
			..case(
				"( trap '/bin/rm -f \"$F.nx\"' EXIT; : > \"$F\"; while :; do :; done ); echo after"
					.into(),
				true,
				b"",
				died,
			)
		},
		SentCase {
			waits: false,
			..case(
				"( trap 'echo sub' EXIT; : > \"$F\"; while :; do :; done ); echo after".into(),
				true,
				b"sub\n",
				died,
			)
		},
		// The read of a substitution holds it without an EXIT trap, with job
		// control, and in a subshell; the substitution's code goes on.
		case(
			format!(
				"exec 3>&1; v=$(/bin/sh -c 'trap \"\" INT; : > \"$F\"; {SENT}'; echo more >&3); echo \
				 after"
			),
			true,
			b"more\n",
			died,
		),
		case(
			format!(
				"set -m; exec 3>&1; v=$(/bin/sh -c 'trap \"\" INT; : > \"$F\"; {SENT}'; echo more \
				 >&3); echo after"
			),
			true,
			b"more\n",
			died,
		),
		case(
			format!(
				"( exec 3>&1; v=$(/bin/sh -c 'trap \"\" INT; : > \"$F\"; {SENT}'; echo more >&3); \
				 echo sub-after ); echo after"
			),
			true,
			b"more\n",
			died,
		),
		// Under `set -m` a substitution's shell code is in the shell's group:
		// it dies of the group's `INT`.
		SentCase {
			waits: false,
			..case("set -m; v=$(: > \"$F\"; while :; do :; done); echo after".into(), true, b"", died)
		},
		// Under `set -m` the job is in a group of its own: a `kill` of the
		// shell's pid or group reaches only the shell, whose trap runs once
		// the job has ended. The job's code never blocks.
		SentCase {
			waits: false,
			..case(
				format!("set -m; trap 'echo i' INT; ( {busy}; echo more ); echo after"),
				false,
				b"more\ni\nafter\n",
				Exit(0),
			)
		},
		SentCase {
			waits: false,
			..case(
				format!("set -m; trap 'echo i' INT; ( {busy}; echo more ); echo after"),
				true,
				b"more\ni\nafter\n",
				Exit(0),
			)
		},
		SentCase {
			waits: false,
			..case(
				format!("set -m; trap 'echo i' INT; {{ {busy}; echo more; }} | cat; echo after"),
				false,
				b"more\ni\nafter\n",
				Exit(0),
			)
		},
		SentCase { waits: false, ..case(set_m_pipeline.clone(), true, b"more\ni\nafter\n", Exit(0)) },
		// The root that dies of it under `set -m` runs its EXIT trap first,
		// while the job, in its own group, goes on: the trap waits for what
		// the job makes once the signal was sent.
		SentCase {
			waits: false,
			..case(
				format!(
					"set -m; trap 'until [ -e \"$F.done\" ]; do :; done; echo root-exit' EXIT; ( \
					 {busy}; : > \"$F.done\" ); echo after"
				),
				true,
				b"root-exit\n",
				died,
			)
		},
		// A subshell whose EXIT trap the `INT` began, and whose process
		// another signal then ends (the trap `exec`s a program that dies of
		// `TERM`, or kills it with `KILL`), dies of that signal: its parent
		// goes on, as it waits for the subshell ([`Run::when_it_waits`];
		// signalled before its `wait_for`, bash 5.2.21 died of the `INT` at
		// once under load). (A `kill -TERM $BASHPID` in the trap gives bash
		// 5.2.21 either end under load.)
		SentCase {
			waits: false,
			..case(
				"( trap 'trap - EXIT; exec /bin/sh -c \"kill -TERM \\$\\$\"' EXIT; : > \"$F\"; while \
				 :; do :; done ); echo after"
					.into(),
				true,
				b"after\n",
				Exit(0),
			)
		},
		SentCase {
			waits: false,
			..case(
				"( trap 'kill -KILL $BASHPID' EXIT; : > \"$F\"; while :; do :; done ); echo after"
					.into(),
				true,
				b"after\n",
				Exit(0),
			)
		},
	];
	run_sent_golden(cases, &raced);
	// The `set -m` pipeline row as a script file (`bash FILE`): the same
	// golden.
	let file_run = |program: &OsStr| {
		let dir = tempfile::tempdir().expect("a directory for the script");
		let path = dir.path().join("s.sh");
		fs::write(&path, format!("{set_m_pipeline}\n")).expect("write the script");
		let started = dir.path().join("started");
		Run::new(program, "bash", &[&path])
			.env("F", &started)
			.own_group()
			.go_signalled(&started, libc::SIGINT, true)
	};
	let expected = ("more\ni\nafter\n".to_owned(), Some(Exit(0)));
	let ours = file_run(OsStr::new(env!("CARGO_BIN_EXE_obash")));
	assert_eq!(
		(String::from_utf8_lossy(&ours.stdout).into_owned(), ours.end()),
		expected,
		"file: {set_m_pipeline}: {ours:?}"
	);
	if let Some(real) = real_bash_golden() {
		let theirs = file_run(real.as_os_str());
		assert_eq!(
			(String::from_utf8_lossy(&theirs.stdout).into_owned(), theirs.end()),
			expected,
			"bash file: {set_m_pipeline}: {theirs:?}"
		);
	}
}

/// bash `termsig_sighandler`: a terminating signal that comes while the EXIT
/// trap a first one began runs ends the shell at once, by the new signal, in
/// a subshell and in the root (the trap's own `kill`, so no timing).
#[test]
fn a_second_terminating_signal_ends_the_exit_trap_at_once() {
	for (script, stdout, end) in [
		(
			"( trap \"echo trap; kill -TERM \\$BASHPID; echo still\" EXIT; kill -INT $BASHPID; echo \
			 no ); echo after s=$?",
			"trap\nafter s=143\n",
			Exit(0),
		),
		(
			"( trap \"echo trap; kill -KILL \\$BASHPID; echo still\" EXIT; kill -TERM $BASHPID; echo \
			 no ); echo after s=$?",
			"trap\nafter s=137\n",
			Exit(0),
		),
		(
			"trap \"echo trap; kill -TERM \\$\\$; echo still\" EXIT; kill -INT $$; echo no",
			"trap\n",
			Signal(libc::SIGTERM),
		),
	] {
		let ours = Run::script(OsStr::new(env!("CARGO_BIN_EXE_obash")), "bash", script).go();
		assert_eq!(
			(String::from_utf8_lossy(&ours.stdout).into_owned(), ours.end()),
			(stdout.to_owned(), Some(end)),
			"{script}: {ours:?}"
		);
		if let Some(real) = real("bash") {
			let theirs = Run::script(real.as_os_str(), "bash", script).go();
			assert_eq!((&ours.stdout, ours.end()), (&theirs.stdout, theirs.end()), "bash: {script}");
		}
	}
}

/// bash reads a command substitution's output with `SIGINT` blocked until
/// the read ends: once nothing writes the output any more, it acts on an
/// `INT` that came meanwhile, before it waits for the substitution's
/// process, which may run on; an `INT` that comes during that wait it holds
/// as for a job (`wait_for`), and goes on where the process caught it. The
/// substitution ignores `INT` and makes `$F`. In the first row it closes its
/// output once the run has sent the signal ([`SENT`]), then waits for
/// `$F.checked`, which the test makes once the shell has ended: a shell that
/// waited for the substitution's process would never end. In the second it
/// closes its output first, then waits for the signal, and ends.
#[test]
fn bash_acts_on_a_held_int_once_the_substitutions_output_ends() {
	let rows = [
		(
			format!(
				"v=$(trap '' INT; : > \"$F\"; {SENT}; exec >/dev/null 2>&1; until [ -e \"$F.checked\" \
				 ]; do /bin/sleep 0.01; done); echo after"
			),
			(String::new(), Some(Signal(libc::SIGINT))),
		),
		(
			format!("v=$(trap '' INT; exec >/dev/null; : > \"$F\"; {SENT}); echo after"),
			("after\n".to_owned(), Some(Exit(0))),
		),
	];
	for (script, ended) in rows {
		let run = |program: &OsStr| {
			let dir = tempfile::tempdir().expect("a directory for the start file");
			let started = dir.path().join("started");
			let out = Run::script(program, "bash", &script)
				.env("F", &started)
				.when_blocked()
				.go_signalled(&started, libc::SIGINT, false);
			fs::File::create(started.with_extension("checked")).expect("let the substitution end");
			(String::from_utf8_lossy(&out.stdout).into_owned(), out.end())
		};
		assert_eq!(run(OsStr::new(env!("CARGO_BIN_EXE_obash"))), ended, "{script}");
		if let Some(real) = real("bash") {
			assert_eq!(run(real.as_os_str()), ended, "bash: {script}");
		}
	}
}

/// A trapped signal that comes while the shell runs shell code that never
/// blocks (a loop of builtins) runs its trap before the next command, as
/// bash's does, and before the shell ends where the script ends there. The
/// loop makes `$F`, then runs until the run has sent the signal.
#[test]
fn a_trapped_signal_runs_its_trap_while_the_shell_runs_builtins() {
	let busy = ": > \"$F\"; until [ -e \"$F.sent\" ]; do :; done";
	let case = |name: &str, sig, then: &str, stdout: &'static [u8]| SentCase {
		shell: "bash",
		script: format!("trap 'echo {name}' {name}; {busy}{then}"),
		sig,
		group: false,
		stdout,
		end: Exit(0),
		waits: false,
	};
	run_sent(vec![
		case("USR1", libc::SIGUSR1, "; echo after", b"USR1\nafter\n"),
		case("INT", libc::SIGINT, "; echo after", b"INT\nafter\n"),
		case("TERM", libc::SIGTERM, "; echo after", b"TERM\nafter\n"),
		case("HUP", libc::SIGHUP, "; echo after", b"HUP\nafter\n"),
		case("USR1", libc::SIGUSR1, "", b"USR1\n"),
	]);
}

/// The variable that makes this test binary, run again, the embedded shell
/// of [`an_embedded_bash_dies_of_the_int_it_acts_on`], on its script.
const EMBEDDED_SCRIPT: &str = "PI_SHELL_EMBEDDED_SCRIPT";

/// One run of `run` (the real bash's `-c` string, or the embedded shell's)
/// with `F` set, in a process group of its own, which gets `INT` once the
/// command has made `$F` (with `waits`, once the shell has also blocked):
/// what it wrote to `$F.out`, and how it ended.
fn int_to_the_group(run: Run, waits: bool) -> (String, Option<End>) {
	let dir = tempfile::tempdir().expect("a directory for the start file");
	let started = dir.path().join("started");
	let run = run.env("F", &started).own_group();
	let run = if waits { run.when_blocked() } else { run };
	let end = run.go_signalled(&started, libc::SIGINT, true).end();
	let out = fs::read_to_string(started.with_extension("out")).unwrap_or_default();
	(out, end)
}

/// The process shell embedded in a runtime, as `omp bash` runs it
/// (`pi_shell::process::main` with `embedded`, then `Exit::end`, as
/// pi-natives' `runShellMain` does), ends as bash does on an `INT` to its
/// process group that it acts on: it dies of `SIGINT`, so that its parent
/// sees the death (a calling bash takes an exit of 130 for a child that
/// caught the signal, `child_caught_sigint`, and its loop goes on): in shell
/// code, and after its EXIT trap. The shell runs in this test binary again,
/// on a thread of libtest's, which the kernel does not give the group's
/// signal first; a runtime runs it on its main thread, which it does. A
/// command that dies of the signal is pi-natives' test of `runShellMain`
/// (`native.test.ts`), on Bun's main thread: here the main thread could
/// take the signal after the engine has seen the command's end. The
/// shell's output goes to `$F.out`, past the test harness's own lines.
#[test]
fn an_embedded_bash_dies_of_the_int_it_acts_on() {
	const NAME: &str = "an_embedded_bash_dies_of_the_int_it_acts_on";
	if let Some(script) = std::env::var_os(EMBEDDED_SCRIPT) {
		let argv = [b"bash".to_vec(), b"-c".to_vec(), script.into_vec()];
		let opts = pi_shell::process::ProcessOptions { embedded: true };
		std::process::exit(pi_shell::process::main(argv, opts).end());
	}
	let this = std::env::current_exe().expect("this test binary");
	for (script, out) in [
		("exec >\"$F.out\"; : > \"$F\"; while :; do :; done", ""),
		("exec >\"$F.out\"; trap 'echo x' EXIT; : > \"$F\"; while :; do :; done", "x\n"),
	] {
		let waits = false;
		let embedded = Run::new(&this, "process_signals", &["--exact", NAME, "--nocapture"])
			.env(EMBEDDED_SCRIPT, script);
		assert_eq!(
			int_to_the_group(embedded, waits),
			(out.to_owned(), Some(Signal(libc::SIGINT))),
			"embedded: {script}"
		);
		if let Some(real) = real_bash() {
			assert_eq!(
				int_to_the_group(Run::script(real, "bash", script), waits),
				(out.to_owned(), Some(Signal(libc::SIGINT))),
				"bash: {script}"
			);
		}
	}
}

/// A signal the shell catches ends it (bash's EXIT trap, zsh's `HUP`
/// handler) while it waits for a foreground command: the command outlives
/// the shell, as bash's `termsig_handler` and zsh's `zexit` leave it, and so
/// does the command of a `( … )`. The command, a child of the shell's own
/// process in each row, makes `$F`, and prints `child-done` once the shell
/// has ended (it has a new parent then), which the run reads to the end of
/// its output: no time the shell is given to act. One the shell does not
/// catch ends it at its default action, and the command goes on too: an
/// `INT` the root acts on at once (under `set -m`, which holds none) too.
///
/// A known difference, until `fix/shell-external-stages-share-a-kernel-pipe`
/// (INFRA-1484's architect ruled so on 2026-11-21 at 03:22Z): obash joins
/// two external stages with a pipe its own process pumps (`mem::pipe`,
/// `vm/exec.rs`), so the output a stage writes after the shell died is
/// lost, where bash's and zsh's stages share a kernel pipe. The rows of
/// `child | cat` assert both outputs; the fix makes obash's fail.
#[test]
fn a_caught_signal_that_ends_the_shell_leaves_its_foreground_command_running() {
	// Its parent: from `/proc` (no fork), or `ps`, which reads all of `/proc`
	// where there is one (0.6 s on a busy machine) and is the way elsewhere.
	let child = "/bin/sh -c 'trap \"echo child-int\" INT; : > \"$F\"; while if [ -r /proc/$$/stat \
	             ]; then read -r _ _ _ p _ < /proc/$$/stat; else p=$(ps -o ppid= -p $$); fi; [ \
	             $((p)) -eq $PPID ]; do /bin/sleep 0.01; done; echo child-done'";
	let case = |shell, script: String, sig, stdout, end| SentCase {
		shell,
		script,
		sig,
		group: false,
		stdout,
		end,
		waits: true,
	};
	run_sent(vec![
		case(
			"bash",
			format!("trap 'echo x' EXIT; {child}; echo after"),
			libc::SIGTERM,
			b"x\nchild-done\n",
			Signal(libc::SIGTERM),
		),
		case(
			"bash",
			format!("trap 'echo x' EXIT; ( {child} ); echo after"),
			libc::SIGTERM,
			b"x\nchild-done\n",
			Signal(libc::SIGTERM),
		),
		case(
			"bash",
			format!("set -m; trap 'echo x' EXIT; {child}; echo after"),
			libc::SIGINT,
			b"x\nchild-done\n",
			Signal(libc::SIGINT),
		),
		case(
			"bash",
			format!("{child}; echo after"),
			libc::SIGTERM,
			b"child-done\n",
			Signal(libc::SIGTERM),
		),
		case(
			"bash",
			format!("set -m; {child}; echo after"),
			libc::SIGINT,
			b"child-done\n",
			Signal(libc::SIGINT),
		),
		case(
			"zsh",
			format!("trap 'print x' EXIT; {child}; print after"),
			libc::SIGHUP,
			b"x\nchild-done\n",
			Exit(1),
		),
		case(
			"zsh",
			format!("TRAPEXIT() {{ print x }}; {child}; print after"),
			libc::SIGHUP,
			b"x\nchild-done\n",
			Exit(1),
		),
		case("zsh", format!("{child}; print after"), libc::SIGHUP, b"child-done\n", Exit(1)),
		case(
			"zsh",
			format!("trap 'print x' EXIT; {child}; print after"),
			libc::SIGTERM,
			b"child-done\n",
			Signal(libc::SIGTERM),
		),
	]);
	// The known difference (above): the real shell's output and obash's.
	for (shell, script, sig, theirs, ours, end) in [
		(
			"bash",
			format!("trap 'echo x' EXIT; {child} | cat; echo after"),
			libc::SIGTERM,
			"x\nchild-done\n",
			"x\n",
			Signal(libc::SIGTERM),
		),
		(
			"zsh",
			format!("trap 'print x' EXIT; {child} | cat; print after"),
			libc::SIGHUP,
			"x\nchild-done\n",
			"x\n",
			Exit(1),
		),
		("zsh", format!("{child} | cat; print after"), libc::SIGHUP, "child-done\n", "", Exit(1)),
	] {
		let shown = format!("{shell}: {script}, signal {sig} to the shell");
		let lost = sent(OsStr::new(env!("CARGO_BIN_EXE_obash")), shell, &script, sig, false, false);
		assert_eq!(
			(String::from_utf8_lossy(&lost.stdout), lost.end()),
			(ours.into(), Some(end)),
			"{shown}"
		);
		if let Some(real) = real(shell) {
			let kept = sent(real.as_os_str(), shell, &script, sig, false, true);
			assert_eq!(
				(String::from_utf8_lossy(&kept.stdout), kept.end()),
				(theirs.into(), Some(end)),
				"{shown}"
			);
		}
	}
}

/// An interactive shell's `HUP` from outside, with an EXIT trap that
/// writes `$F`: bash runs the trap, then dies of the signal (its
/// `terminating_signals` are caught interactive or not); zsh's handler
/// exits with status 1 after the trap, also once a `HUP` trap was set and
/// removed, by `trap -` or by `unfunction TRAPHUP` (`removetrap` puts the
/// handler back).
#[test]
fn an_interactive_shell_runs_its_exit_trap_on_a_hup() -> io::Result<()> {
	struct Case {
		zsh:   bool,
		setup: &'static str,
		end:   End,
	}
	let cases = [
		Case { zsh: false, setup: "true", end: Signal(libc::SIGHUP) },
		Case { zsh: true, setup: "true", end: Exit(1) },
		Case { zsh: true, setup: "trap 'print t' HUP; trap - HUP", end: Exit(1) },
		Case { zsh: true, setup: "TRAPHUP() { print t }; unfunction TRAPHUP", end: Exit(1) },
	];
	for Case { zsh, setup, end } in cases {
		let ours = if zsh {
			Spawn::zsh()
		} else {
			Spawn::obash_as("bash")
		};
		let real = if zsh {
			have_zsh().then(Spawn::real_zsh)
		} else {
			real_bash().map(|bash| Spawn::new(bash).argv0("bash"))
		};
		let shells =
			std::iter::once(("obash", ours)).chain(real.map(|spawn| ("the real shell", spawn)));
		for (who, spawn) in shells {
			let dir = tempfile::tempdir()?;
			let file = dir.path().join("F");
			let args: &[&str] = if zsh {
				&["-f", "-i"]
			} else {
				&["--norc", "--noprofile", "-i"]
			};
			let mut shell = spawn.args(args).env("F", &file).spawn()?;
			shell.write(format!("{setup}; trap 'echo x > \"$F\"' EXIT; echo $((40 + 2))\r"))?;
			// `42` then a newline: bash's bracketed paste puts `\e[?2004l\r`
			// before it.
			shell.read_until("42\r\n", TIMEOUT)?;
			// Then the next prompt: the command is over and its output out.
			// Sent before it, the real shells race (under load, zsh 5.9 once
			// wrote `42` into the EXIT trap's file too, and bash 5.2.21 once
			// did not exit).
			shell.wait_screen(TIMEOUT, |screen| screen.contents().ends_with(['$', '#', '%']))?;
			// And the real shell blocked reading its terminal: bash 5.2.21 shows
			// the prompt before readline blocks, and acts on a `HUP` that comes
			// in between only at its next input (seen under load).
			if who != "obash" {
				pty_support::wait_blocked(shell.pid());
			}
			shell.signal(libc::SIGHUP)?;
			let status = shell.wait(TIMEOUT)?;
			let ended = status
				.code()
				.map_or_else(|| status.signal().map(Signal), |code| Some(Exit(code)));
			assert_eq!(
				(ended, fs::read_to_string(&file).ok()),
				(Some(end), Some("x\n".to_owned())),
				"{who}: {setup}: {:?}",
				shell.output()
			);
		}
	}
	Ok(())
}

/// How a row's text runs ([`Form::run`]): as a `-c` string, `bash [OPTION…]
/// -c TEXT`, or as a script file that holds the text and a newline, `bash
/// [OPTION…] FILE`. bash's diagnostics name the shell (`bash: line 1:`) for
/// the first and the script's path for the second ([`Form::golden`],
/// [`Form::shown`]).
#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Form {
	/// `bash -c TEXT`.
	Inline,
	/// `bash FILE`.
	File,
}

#[cfg(target_os = "linux")]
impl Form {
	/// Both forms, the `-c` string first.
	const BOTH: [Self; 2] = [Self::Inline, Self::File];

	/// A run of `text` in this form by `program` as `bash`, with `options`
	/// before it; the script file is [`SCRIPT_FILE`] in `dir`, written now.
	fn run(self, program: &OsStr, options: &[&str], text: &str, dir: &Path) -> Run {
		let mut args: Vec<OsString> = options.iter().map(OsString::from).collect();
		match self {
			Self::Inline => args.extend([OsString::from("-c"), OsString::from(text)]),
			Self::File => {
				let path = dir.join(SCRIPT_FILE);
				fs::write(&path, format!("{text}\n")).expect("write the script");
				args.push(path.into_os_string());
			},
		}
		Run::new(program, "bash", &args)
	}

	/// `golden`, bash's output of the `-c` string, as this form gives it: a
	/// script file names itself, written `SCRIPT` ([`Self::shown`]), where a
	/// `-c` string names the shell (`bash: line 1:`).
	fn golden(self, golden: &str) -> String {
		match self {
			Self::Inline => golden.to_owned(),
			Self::File => golden.replace("bash: line ", "SCRIPT: line "),
		}
	}

	/// `text` with the path of the script file in `dir` written `SCRIPT`.
	fn shown(self, text: &str, dir: &Path) -> String {
		match self {
			Self::Inline => text.to_owned(),
			Self::File => text.replace(&dir.join(SCRIPT_FILE).display().to_string(), "SCRIPT"),
		}
	}
}

/// The name of a [`Form::File`] run's script in its directory.
#[cfg(target_os = "linux")]
const SCRIPT_FILE: &str = "s.sh";

/// Shell code for an external `sh` (`$$` is its pid): `own` when it leads a
/// process group of its own, else `shared`.
#[cfg(target_os = "linux")]
const OWN: &str =
	r#"read -r _ _ _ _ pg _ < /proc/$$/stat; [ "$pg" = "$$" ] && echo own || echo shared"#;

/// Under `set -m` bash runs each job in a process group of its own, with a
/// terminal or without one (`jobs.c` `make_child`, `setpgid` when
/// `job_control` is set): a background job leads its own group, and the
/// processes of a pipeline join the group its first process leads, while a
/// command substitution's stay in the shell's. So a kill of the shell's
/// process group (a supervisor's `INT`, `timeout`) does not reach a job.
/// A known difference: bash forks every stage of a pipeline before it
/// reaps any of its processes, so the group of the first one is there for
/// each later stage. obash reaps a stage's program as soon as the stage
/// sees it end (`await_` drops its `ExtProc`, `src/bash/vm/command.rs:4745`,
/// whose drop reaps it, `src/sys/spawn/unix.rs:1701`), so a later stage
/// whose program starts after that finds the group empty, and its program
/// leads a group of its own (`retry_join`, `src/sys/spawn/unix.rs:739`;
/// `src/bash/host.rs:644`). The two rows that read a stage's group keep
/// the first process running until the next one has read it (`$F.read`).
/// The same holds, every time and with no race, for a job whose programs
/// run one after another, none alive while the next starts (`printf … |
/// while read i; do PROG; done`, its first stage a builtin): each program
/// leads a group of its own, where bash's stages, subshells it forked,
/// keep the job's group. That row pins both, obash `own` and bash
/// `joined` each time: for it, the engine would have to keep one process
/// of a job's group unreaped for the job's whole life. Without `set -m`,
/// or for a job started after `set +m`, the job stays in the shell's group
/// (a pipeline's later process says `shell`); a job started under `set -m`
/// keeps its own group after `set +m`, and `kill -- -PID` of its leader or
/// of `$!` reaches it. Each job's process reads its own process group from
/// `/proc` (`$$` of the external `sh`). The shell runs in a process group
/// of its own, with no terminal. The outputs and ends are checked-in
/// goldens measured with bash 5.3.20 (compared live only with a bash 5.3
/// or later, [`real_bash_golden`]); bash 5.2.21 gives the same. The shell's
/// own `TSTP`, `TTIN` and `TTOU` are read by what they do, from outside
/// ([`stopped_by`]): bash with `set -m` and no terminal leaves them at their
/// defaults, so each one stops the shell, also once a `trap -` puts them
/// back to what the shell's own rule gives; under `trap ''` none stops it
/// (the control). Every row runs on every Linux, gVisor included, as a `-c`
/// string and as a script file ([`Form`]), with the same goldens.
#[cfg(target_os = "linux")]
#[test]
fn set_m_jobs_run_in_a_process_group_of_their_own_without_a_terminal() {
	let own = OWN;
	// A pipeline's first process: prints its pid, then runs until the next
	// stage's process has read its group (`joined` makes `$F.read` then).
	let first_waits = r#"echo $$; i=0; until [ -e "$0.read" ]; do i=$((i+1)); [ $i -lt 1200 ] || exit 97; sleep 0.05; done"#;
	let joined = r#"read lead; read -r _ _ _ _ pg _ < /proc/$$/stat; : > "$0.read"; [ "$pg" = "$lead" ] && echo joined || echo other"#;
	// The same, naming the group: the shell's (`$1`, the shell's pid, which
	// leads its group), one of its own, or the first process's.
	let whose = r#"read lead; read -r _ _ _ _ pg _ < /proc/$$/stat; : > "$0.read"; if [ "$pg" = "$1" ]; then echo shell; elif [ "$pg" = "$$" ]; then echo own; elif [ "$pg" = "$lead" ]; then echo joined; else echo other; fi"#;
	// Of a lone program: the shell's group (`$1`), one of its own, or
	// another.
	let placed = r#"read -r _ _ _ _ pg _ < /proc/$$/stat; if [ "$pg" = "$$" ]; then echo own; elif [ "$pg" = "$1" ]; then echo shell; else echo joined; fi"#;
	// Where row 14 writes the pid of its pipeline's first process.
	let dir = tempfile::tempdir().expect("a directory for the script");
	let first = dir.path().join("f.first");
	let leader_kill = [
		"set -m; /bin/sh -c 'echo $$ >\"$0\"; exec /bin/sleep 5' \"$F.first\" | /bin/sleep 5 & ",
		"set +m; until [ -s \"$F.first\" ]; do [ \"$SECONDS\" -lt 60 ] || exit 97; done; ",
		"read f < \"$F.first\"; kill -- -$f; echo kill=$?; wait $!; echo st=$?",
	]
	.concat();
	let rows: [(String, &str); 14] = [
		(format!("set -m; /bin/sh -c '{own}' & wait"), "own\n"),
		(format!("set -o monitor; /bin/sh -c '{own}' & wait"), "own\n"),
		(format!("shopt -so monitor; /bin/sh -c '{own}' & wait"), "own\n"),
		(
			format!("set -m; /bin/sh -c '{first_waits}' \"$F\" | /bin/sh -c '{joined}' \"$F\""),
			"joined\n",
		),
		(format!("set -m; /bin/sh -c '{own}' | cat"), "own\n"),
		(format!("set -m; echo $(/bin/sh -c '{own}')"), "shared\n"),
		(format!("/bin/sh -c '{own}' & wait"), "shared\n"),
		(format!("/bin/sh -c '{first_waits}' \"$F\" | /bin/sh -c '{whose}' \"$F\" $$"), "shell\n"),
		(format!("set -m; set +m; /bin/sh -c '{own}' & wait"), "shared\n"),
		// A script kills a job's whole tree through its group: bash's `kill
		// -- -PID` of a pipeline's last process (`$!`) signals the group its
		// first process leads.
		(
			"set -m; /bin/sleep 5 & kill -- -$!; echo kill=$?; wait $!; echo st=$?".into(),
			"kill=0\nst=143\n",
		),
		(
			"set -m; /bin/sleep 5 | /bin/sleep 5 & kill -- -$!; echo kill=$?; wait $!; echo st=$?"
				.into(),
			"kill=0\nst=143\n",
		),
		// So it does after `set +m` for a job started under `set -m` (bash
		// `kill_pid` signals the job's own group whether job control is on).
		(
			"set -m; /bin/sleep 5 | /bin/sleep 5 & set +m; kill -- -$!; echo kill=$?; wait $!; echo \
			 st=$?"
				.into(),
			"kill=0\nst=143\n",
		),
		(
			"set -m; /bin/sleep 5 & set +m; kill -- -$!; echo kill=$?; wait $!; echo st=$?".into(),
			"kill=0\nst=143\n",
		),
		// The first process's pid names the group (it leads it).
		(leader_kill, "kill=0\nst=143\n"),
	];
	// The known difference, obash's output then bash's: programs that run
	// one after another, none alive while the next starts.
	let sequential =
		format!("set -m; printf '1\\n2\\n3\\n' | while read i; do /bin/sh -c '{placed}' sh $$; done");
	let differs = [(sequential, "own\nown\nown\n", "joined\njoined\njoined\n")];
	let compared: Vec<(&String, &str, &str)> = rows
		.iter()
		.map(|(script, stdout)| (script, *stdout, *stdout))
		.chain(
			differs
				.iter()
				.map(|(script, ours, bash)| (script, *ours, *bash)),
		)
		.collect();
	// The shell's own disposition of the terminal stop signals, by what it
	// does: each is sent from outside, to the shell's pid alone, while the
	// shell runs shell code that never blocks ([`stopped_by`]).
	let all = [libc::SIGTSTP, libc::SIGTTIN, libc::SIGTTOU];
	let stop_rows = [
		(format!("set -m; {STOP_STEPS}; echo alive"), &all[..]),
		(format!("set -m; trap - TSTP TTIN TTOU; {STOP_STEPS}; echo alive"), &all[..]),
		(format!("set -m; trap '' TSTP TTIN TTOU; {STOP_STEPS}; echo alive"), &[][..]),
	];
	for form in Form::BOTH {
		for &(script, stdout, bash_stdout) in &compared {
			let run = |program: &OsStr| {
				let _ = fs::remove_file(&first);
				let _ = fs::remove_file(dir.path().join("f.read"));
				let f = dir.path().join("f");
				form
					.run(program, &[], script, dir.path())
					.env("F", &f)
					.own_group()
					.go()
			};
			let ours = run(OsStr::new(env!("CARGO_BIN_EXE_obash")));
			assert_eq!(
				(String::from_utf8_lossy(&ours.stdout), ours.end()),
				(stdout.into(), Some(Exit(0))),
				"{form:?}: {script}: {ours:?}"
			);
			if let Some(real) = real_bash_golden() {
				let theirs = run(real.as_os_str());
				assert_eq!(
					(String::from_utf8_lossy(&theirs.stdout), theirs.end()),
					(bash_stdout.into(), Some(Exit(0))),
					"bash {form:?}: {script}: {theirs:?}"
				);
			}
		}
		for (script, want) in &stop_rows {
			let run = |program: &OsStr| {
				let (stops, out) = stopped_by(program, form, script);
				(stops, String::from_utf8_lossy(&out.stdout).into_owned(), out.end())
			};
			let expected = (want.to_vec(), "alive\n".to_owned(), Some(Exit(0)));
			let obash = OsStr::new(env!("CARGO_BIN_EXE_obash"));
			assert_eq!(run(obash), expected, "{form:?}: {script}");
			if let Some(real) = real_bash_golden() {
				assert_eq!(run(real.as_os_str()), expected, "bash {form:?}: {script}");
			}
		}
	}
}

/// `kill -- -PID` of a process of a job under `set -m`, and `kill %1`,
/// signal the job's whole process group (bash `kill_pid`'s `killpg`),
/// which holds the job's shell code too: bash runs it in subshells in that
/// group, obash in its own process, and both end it. A background loop
/// ends (`gone`; the row's own `kill -KILL %1` of the ended job then fails
/// in both, bash 5.3.20 with `kill: (PID) - No such process`, and its
/// stderr is dropped), and a `{ …; }` job, alone or as a pipeline's last
/// stage, ends of it before its next command (`st=143`), by `$!` and by
/// the pid of the pipeline's first process; `kill %1` of that job is the
/// control, and a `-PID` of a group that is no job's (the shell's own,
/// probed with signal 0) stays a plain group signal. The one group signal
/// also reaches a program the job left in its group while the job runs
/// only shell code (`left-gone`), and a group with no process left (the
/// job's one program ended) is no error: the shell code ends of it. A
/// stopped job is continued only by `TERM` or `HUP` (`st=129`, its program
/// too; `KILL` ends it): another signal, `USR1` here, waits in its stopped
/// processes, its shell code too, until `kill -CONT %1` (`stopped`, then
/// `st=138`), by `-PID` and by `%1`. The rule, as for a stopped bash
/// subshell: of the ends a stopped job of shell code has pending it dies
/// of the lowest-numbered one once continued; a terminating signal that
/// does not continue it waits among them, and one that does (`TERM`,
/// `HUP`) joins them rather than bypassing them. So `USR2` then `USR1`,
/// then `kill -CONT %1`, ends it of `USR1` (`st=138`), as does `USR1` then
/// `TERM` (`st=138`, by `%1` and by `-PID`), and `USR2` then `HUP` ends it
/// of `HUP` (`st=129`). Only `kill` of the job (`%1`, `-PID`) continues
/// it after `TERM` or `HUP` (bash `kill_pid` sends `CONT` to the group, so
/// a stopped program the job left in its group dies of it too),
/// whatever the job does with the signal: a trapped `TERM` runs its trap
/// once the job runs again, and a held `USR1` still comes first, before a
/// trapped `HUP`'s trap. `kill -TERM PID` of the job's program sends no
/// `CONT`: the job stays stopped with `TERM` pending until `kill -CONT
/// %1`; sent so to a job of shell code, it waits among the ends the job
/// holds (a held `USR1` still wins, `st=138`). `KILL` ends a stopped job
/// at once whatever it holds (137 after a held `HUP`). The shell has no
/// terminal. The
/// goldens are bash 5.3.20's (compared live only with a bash 5.3 or later,
/// [`real_bash_golden`]); bash 5.2.21 gives the same output, and prints
/// its `[1]+  Terminated` notices besides. The rows of a job a `USR1`,
/// `USR2` or `HUP` ends compare no stderr: bash prints its notice of such
/// a job, with its pid, for each of the three. Each row waits for what it
/// needs (a file the job makes; a stopped job: its lone program's state `T` and
/// `jobs` saying `Stopped`, as bash continues a job it sends `TERM` only
/// once it has learned of the stop; the job's process gone or a zombie
/// before `wait`, as bash learns of a continue only from its wait status),
/// bounded by `$SECONDS` within the run's own bound, so that a wait that
/// never ends shows where: `exit 97`, and `exit 98` for the waits for a
/// stop. bash 5.3.20 on gVisor now and then never shows a stop there (1
/// test run in 3 of a live gVisor cell, in two gates): its run then ends
/// with `exit 98` before any output, is not compared, and says so on
/// stderr (`UNCOMPARED:`). obash is compared in every run. Each row ends
/// its job, writes its output to files and is bounded
/// ([`bounded_to_files`]); every row runs as a `-c` string and as a script
/// file ([`Form`]).
#[cfg(target_os = "linux")]
#[test]
fn set_m_kill_of_a_jobs_group_reaches_its_shell_code() {
	/// Sends the row's output to files ([`bounded_to_files`]).
	const OUT: &str = "exec >\"$F.out\" 2>\"$F.err\"; ";
	let bound = "[ \"$SECONDS\" -lt 20 ] || exit 97";
	// A `{ …; }` job whose program has started (`$F.run`) and runs 2 s.
	let stage = "{ /bin/sh -c ': > \"$0.run\"; exec /bin/sleep 2' \"$F\"; echo after; }";
	let started = format!("until [ -e \"$F.run\" ]; do {bound}; done");
	let compound = format!("/bin/rm -f \"$F.run\"; set -m; {stage} & {started}");
	let waited = "echo kill=$?; wait $!; echo st=$?";
	// Process `pid` stopped (its state `T`).
	let stop_bound = "[ \"$SECONDS\" -lt 20 ] || exit 98";
	let stopped = |pid: &str| {
		format!("until read -r _ _ s _ < /proc/{pid}/stat && [ \"$s\" = T ]; do {stop_bound}; done")
	};
	// What `jobs` says of the job.
	let listed = "jobs >\"$F.j\"; read -r j <\"$F.j\"; [ \"${j#*Stopped}\" != \"$j\" ] && echo \
	              stopped || echo \"not stopped: $j\"";
	// Until `jobs` says the job stopped.
	let job_stopped = format!(
		"until jobs >\"$F.j\"; read -r j <\"$F.j\"; [ \"${{j#*Stopped}}\" != \"$j\" ]; do \
		 {stop_bound}; /bin/sleep 0.05; done"
	);
	// The job's process gone or a zombie, then waited for.
	let gone = format!(
		"until ! {{ read -r _ _ s _ < /proc/$!/stat; }} 2>/dev/null || [ \"$s\" = Z ]; do {bound}; \
		 done; wait $!; echo st=$?"
	);
	// A lone program, stopped and known to be.
	let held = format!("set -m; /bin/sleep 30 & kill -STOP %1; {}; {job_stopped}", stopped("$!"));
	let usr1 = |how: &str| {
		format!(
			"{held}; kill -USR1 {how}; echo kill=$?; /bin/sleep 0.3; {listed}; kill -CONT %1; {gone}"
		)
	};
	let rows: Vec<(String, &str, bool)> = vec![
		(
			"set -m; ( while :; do /bin/sleep 0.2; done ) & /bin/sleep 1; kill -TERM -- -$!; echo \
			 kill=$?; /bin/sleep 1; kill -0 $! 2>/dev/null && echo alive || echo gone; kill -KILL %1 \
			 2>/dev/null; wait; echo end"
				.to_owned(),
			"kill=0\ngone\nend\n",
			true,
		),
		(format!("{compound}; kill -TERM -- -$!; {waited}"), "kill=0\nst=143\n", true),
		(
			format!(
				"/bin/rm -f \"$F.run\"; set -m; /bin/sh -c 'exec /bin/sleep 4' | {stage} & {started}; \
				 kill -TERM -- -$!; {waited}"
			),
			"kill=0\nst=143\n",
			true,
		),
		// The pid of the pipeline's first process, which leads the group.
		(
			format!(
				"/bin/rm -f \"$F.run\" \"$F.first\"; set -m; /bin/sh -c 'echo $$ > \"$0.first\"; exec \
				 /bin/sleep 4' \"$F\" | {stage} & until [ -s \"$F.first\" ] && [ -e \"$F.run\" ]; do \
				 {bound}; done; read f < \"$F.first\"; kill -TERM -- -$f; {waited}"
			),
			"kill=0\nst=143\n",
			true,
		),
		(format!("{compound}; kill -TERM %1; {waited}"), "kill=0\nst=143\n", true),
		("set -m; kill -0 -- -$$; echo kill=$?".to_owned(), "kill=0\n", true),
		// A program the job left in its group, the job's own code a loop.
		(
			format!(
				"/bin/rm -f \"$F.left\"; set -m; {{ /bin/sh -c '/bin/sleep 30 >/dev/null 2>&1 & echo \
				 $! > \"$0.left\"' \"$F\"; while :; do {bound}; done; }} & until [ -s \"$F.left\" ]; \
				 do {bound}; done; read l < \"$F.left\"; /bin/sleep 0.3; kill -TERM -- -$!; {waited}; \
				 i=0; while kill -0 $l 2>/dev/null && [ $i -lt 100 ]; do i=$((i+1)); /bin/sleep 0.05; \
				 done; kill -0 $l 2>/dev/null && echo left-alive || echo left-gone; kill -KILL $l \
				 2>/dev/null; :"
			),
			"kill=0\nst=143\nleft-gone\n",
			true,
		),
		(usr1("-- -$!"), "kill=0\nstopped\nst=138\n", false),
		(usr1("%1"), "kill=0\nstopped\nst=138\n", false),
		(format!("{held}; kill -TERM -- -$!; echo kill=$?; {gone}"), "kill=0\nst=143\n", true),
		// The same `USR1` to a stopped job whose own code is shell code, once
		// `jobs` says it stopped: its program, a child of bash's subshell,
		// shows state `S` on gVisor while stopped, so `T` is no wait for it.
		(
			format!(
				"/bin/rm -f \"$F.run\"; set -m; {{ /bin/sh -c 'echo $$ > \"$0.run\"; exec /bin/sleep \
				 30' \"$F\"; echo after; }} & until [ -s \"$F.run\" ]; do {bound}; done; kill -STOP \
				 %1; {job_stopped}; kill -USR1 -- -$!; echo kill=$?; /bin/sleep 0.3; {listed}; kill \
				 -CONT %1; {gone}"
			),
			"kill=0\nstopped\nst=138\n",
			false,
		),
		// `TERM` to that stopped job ends it, its program too: bash continues
		// its group after the signal.
		(
			format!(
				"/bin/rm -f \"$F.run\"; set -m; {{ /bin/sh -c 'echo $$ > \"$0.run\"; exec /bin/sleep \
				 30' \"$F\"; echo after; }} & until [ -s \"$F.run\" ]; do {bound}; done; read p < \
				 \"$F.run\"; kill -STOP %1; {job_stopped}; kill -TERM -- -$!; echo kill=$?; {gone}; \
				 i=0; while kill -0 $p 2>/dev/null && [ $i -lt 100 ]; do i=$((i+1)); /bin/sleep 0.05; \
				 done; kill -0 $p 2>/dev/null && echo program-alive || echo program-gone; kill -KILL \
				 $p 2>/dev/null; :"
			),
			"kill=0\nst=143\nprogram-gone\n",
			true,
		),
		// `HUP` continues a stopped job as `TERM` does, by `%1` and by
		// `-PID`, and the job dies of it (`st=129`), its program too.
		(format!("{held}; kill -HUP %1; echo kill=$?; {gone}"), "kill=0\nst=129\n", false),
		(format!("{held}; kill -HUP -- -$!; echo kill=$?; {gone}"), "kill=0\nst=129\n", false),
		(
			format!(
				"/bin/rm -f \"$F.run\"; set -m; {{ /bin/sh -c 'echo $$ > \"$0.run\"; exec /bin/sleep \
				 30' \"$F\"; echo after; }} & until [ -s \"$F.run\" ]; do {bound}; done; read p < \
				 \"$F.run\"; kill -STOP %1; {job_stopped}; kill -HUP %1; echo kill=$?; {gone}; i=0; \
				 while kill -0 $p 2>/dev/null && [ $i -lt 100 ]; do i=$((i+1)); /bin/sleep 0.05; \
				 done; kill -0 $p 2>/dev/null && echo program-alive || echo program-gone; kill -KILL \
				 $p 2>/dev/null; :"
			),
			"kill=0\nst=129\nprogram-gone\n",
			false,
		),
		// A job whose group has no process left, as its one program ended
		// and it runs only shell code: the kill is no error, and the shell
		// code ends of it.
		(
			format!(
				"set -m; {{ /bin/true; while :; do {bound}; done; }} & /bin/sleep 0.3; kill %1; echo \
				 kill=$?; wait $!; echo st=$?"
			),
			"kill=0\nst=143\n",
			true,
		),
		(
			format!(
				"set -m; {{ /bin/true; while :; do {bound}; done; }} & /bin/sleep 0.3; kill -TERM -- \
				 -$!; echo kill=$?; wait $!; echo st=$?"
			),
			"kill=0\nst=143\n",
			true,
		),
		// The ends a stopped job of shell code holds: once continued it dies
		// of the lowest-numbered one (`USR1`, `st=138`), whatever the order
		// they were sent in.
		(
			format!(
				"set -m; ( while :; do /bin/sleep 0.2; done ) & /bin/sleep 0.5; kill -STOP %1; \
				 {job_stopped}; kill -USR2 %1; kill -USR1 %1; /bin/sleep 0.3; kill -CONT %1; {gone}"
			),
			"st=138\n",
			false,
		),
		(
			format!(
				"set -m; ( while :; do /bin/sleep 0.2; done ) & /bin/sleep 0.5; kill -STOP %1; \
				 {job_stopped}; kill -USR1 %1; kill -USR2 %1; /bin/sleep 0.3; kill -CONT %1; {gone}"
			),
			"st=138\n",
			false,
		),
		// A signal that continues the job (`TERM`, `HUP`) joins the ends it
		// holds: `USR1` then `TERM` ends it of `USR1` (`st=138`), by `%1`,
		// by `-PID` and for a job whose own command runs a program; `USR2`
		// then `HUP` ends it of `HUP` (`st=129`).
		(
			format!(
				"set -m; ( while :; do /bin/sleep 0.2; done ) & /bin/sleep 0.5; kill -STOP %1; \
				 {job_stopped}; kill -USR1 %1; kill -TERM %1; {gone}"
			),
			"st=138\n",
			false,
		),
		(
			format!(
				"set -m; ( while :; do /bin/sleep 0.2; done ) & /bin/sleep 0.5; kill -STOP %1; \
				 {job_stopped}; kill -USR1 -- -$!; kill -TERM -- -$!; {gone}"
			),
			"st=138\n",
			false,
		),
		(
			format!(
				"/bin/rm -f \"$F.run\"; set -m; {{ /bin/sh -c 'echo $$ > \"$0.run\"; exec /bin/sleep \
				 30' \"$F\"; echo after; }} & until [ -s \"$F.run\" ]; do {bound}; done; kill -STOP \
				 %1; {job_stopped}; kill -USR1 %1; kill -TERM %1; {gone}"
			),
			"st=138\n",
			false,
		),
		(
			format!(
				"set -m; ( while :; do /bin/sleep 0.2; done ) & /bin/sleep 0.5; kill -STOP %1; \
				 {job_stopped}; kill -USR2 %1; kill -HUP %1; {gone}"
			),
			"st=129\n",
			false,
		),
		// bash's `kill %1` continues a stopped job after `TERM` or `HUP`
		// whatever the job does with it: a trapped `TERM` runs its trap once
		// the job runs again (`term`), and a trapped `HUP` after a held
		// `USR1` ends the job of `USR1` before the trap runs (`st=138`).
		(
			format!(
				"set -m; ( trap 'echo term' TERM; while :; do /bin/sleep 0.2; done ) & /bin/sleep \
				 0.5; kill -STOP %1; {job_stopped}; kill -TERM %1; /bin/sleep 0.5; kill -KILL %1 \
				 2>/dev/null; wait; echo end"
			),
			"term\nend\n",
			false,
		),
		(
			format!(
				"set -m; ( trap 'echo hup' HUP; while :; do /bin/sleep 0.2; done ) & /bin/sleep 0.5; \
				 kill -STOP %1; {job_stopped}; kill -USR1 %1; kill -HUP %1; {gone}"
			),
			"st=138\n",
			false,
		),
		// `kill -TERM PID` of a stopped job's program sends no `CONT` (bash
		// `kill_pid` of a pid): the job stays stopped with `TERM` pending
		// until `kill -CONT %1`.
		(
			format!(
				"{held}; kill -TERM $!; echo kill=$?; /bin/sleep 0.3; {listed}; kill -CONT %1; {gone}"
			),
			"kill=0\nstopped\nst=143\n",
			true,
		),
		// bash's `CONT` after `TERM` goes to the whole group: a stopped
		// program the stopped job left in its group dies of the `TERM` too
		// (`left-gone`), not only the job's own processes. The job is
		// stopped once its `/bin/sh` has ended (`$F.loop`, made by the job's
		// own code after it), so that only that `CONT` can reach the
		// leftover: while the job still waits for a program, continuing that
		// program continues its group as well.
		(
			format!(
				"/bin/rm -f \"$F.left\" \"$F.loop\"; set -m; {{ /bin/sh -c '/bin/sleep 30 >/dev/null \
				 2>&1 & echo $! > \"$0.left\"' \"$F\"; : > \"$F.loop\"; while :; do {bound}; done; }} \
				 & until [ -e \"$F.loop\" ]; do {bound}; done; read l < \"$F.left\"; kill -STOP %1; \
				 {job_stopped}; kill -TERM %1; echo kill=$?; {gone}; i=0; while kill -0 $l \
				 2>/dev/null && [ $i -lt 100 ]; do i=$((i+1)); /bin/sleep 0.05; done; kill -0 $l \
				 2>/dev/null && echo left-alive || echo left-gone; kill -KILL $l 2>/dev/null; :"
			),
			"kill=0\nst=143\nleft-gone\n",
			true,
		),
		// `TERM` by `kill PID` of a stopped job of shell code (`$!` names the
		// job) waits among the ends the job holds: a held `USR1` still
		// comes first once the job is continued (`st=138`). And `KILL` is
		// never ordered behind them: after a held `HUP` it ends the job
		// with 137, by `%1` and by its pid (a `KILL` let in among the held
		// ends leaves the job stopped, `st=147`).
		(
			format!(
				"set -m; ( while :; do /bin/sleep 0.2; done ) & /bin/sleep 0.5; kill -STOP %1; \
				 {job_stopped}; kill -USR1 %1; kill -TERM $!; echo kill=$?; /bin/sleep 0.3; {listed}; \
				 kill -CONT %1; {gone}"
			),
			"kill=0\nstopped\nst=138\n",
			false,
		),
		(
			format!(
				"set -m; ( while :; do /bin/sleep 0.2; done ) & /bin/sleep 0.5; kill -STOP %1; \
				 {job_stopped}; kill -HUP $!; echo kill=$?; /bin/sleep 0.3; kill -KILL %1; {gone}"
			),
			"kill=0\nst=137\n",
			false,
		),
		(
			format!(
				"set -m; ( while :; do /bin/sleep 0.2; done ) & /bin/sleep 0.5; kill -STOP %1; \
				 {job_stopped}; kill -HUP $!; echo kill=$?; /bin/sleep 0.3; kill -KILL $!; {gone}"
			),
			"kill=0\nst=137\n",
			false,
		),
		// The same `KILL` after a `HUP` by pid, on a stopped pipeline job:
		// the `HUP` is held in every stage, and `kill -KILL %1` still ends
		// the job with 137 (without the `KILL` step a continued stage took
		// its held `HUP` first: 129). The row waits until every process of
		// the job's group is gone (`kill -0 -- -PGID` fails, the group from
		// `jobs -p %1`), as bash, before it has reaped the first stage, can
		// still list the job stopped (`st=147`, 1 to 4 runs in 16 per cell
		// with a wait on `$!` alone; 0 of 64 with this wait).
		(
			format!(
				"set -m; ( while :; do /bin/sleep 0.2; done ) | ( while :; do /bin/sleep 0.2; done ) \
				 & /bin/sleep 0.5; jobs -p %1 >\"$F.pg\"; read pg <\"$F.pg\"; kill -STOP %1; \
				 {job_stopped}; kill -HUP $!; echo kill=$?; /bin/sleep 0.3; kill -KILL %1; until ! \
				 kill -0 -- -$pg 2>/dev/null; do {bound}; done; wait $!; echo st=$?"
			),
			"kill=0\nst=137\n",
			false,
		),
	];
	let dir = tempfile::tempdir().expect("a directory for the script and the output");
	for form in Form::BOTH {
		for (script, stdout, stderr) in &rows {
			let script = format!("{OUT}{script}");
			let run = |program: &OsStr| {
				let (out, err, end) = bounded_to_files(program, form, &script, dir.path());
				(out, stderr.then_some(err), end)
			};
			let want = ((*stdout).to_owned(), stderr.then(String::new), Some(Exit(0)));
			let obash = OsStr::new(env!("CARGO_BIN_EXE_obash"));
			assert_eq!(run(obash), want, "{form:?}: {script}");
			if let Some(real) = real_bash_golden() {
				let theirs = run(real.as_os_str());
				// A bash that never showed the stop (`exit 98` before any
				// output): no reading of it, and said so.
				if script.contains("|| exit 98") && theirs.0.is_empty() && theirs.2 == Some(Exit(98)) {
					zsh_oracle::uncompared(&format!(
						"bash {form:?} never showed a stop in 20 s: {script}"
					));
				} else {
					assert_eq!(theirs, want, "bash {form:?}: {script}");
				}
			}
		}
	}
}

/// One `kill` of a `set -m` job's process group is one signal to each of
/// its programs (bash `kill_pid`'s `killpg`), by `-PID` and by `%1`: each
/// stage of `P count … | P count …` blocks `SIGRTMIN`, which the kernel
/// queues once for each one sent, and prints how many came once the shell
/// has sent it (the count mode of [`sigign_probe`]). The goldens are bash
/// 5.3.20's (compared live only with a bash 5.3 or later,
/// [`real_bash_golden`]; bash 5.2.21 counts the same). Each row runs as a
/// `-c` string and as a script file ([`Form`]), bounded
/// ([`bounded_to_files`]).
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
fn set_m_kill_of_a_jobs_group_signals_each_program_once() {
	let dir = tempfile::tempdir().expect("a directory for the probe, the script and the output");
	let probe = sigign_probe(dir.path());
	let p = probe.display();
	for how in ["-- -$!", "%1"] {
		let script = format!(
			"exec >\"$F.out\" 2>\"$F.err\"; /bin/rm -f \"$F.r1\" \"$F.r2\" \"$F.sent\"; set -m; \
			 \"{p}\" count \"$F.r1\" \"$F.sent\" | \"{p}\" count \"$F.r2\" \"$F.sent\" & until [ -e \
			 \"$F.r1\" ] && [ -e \"$F.r2\" ]; do [ \"$SECONDS\" -lt 60 ] || exit 97; done; kill \
			 -RTMIN {how}; echo kill=$?; : > \"$F.sent\"; wait $!; echo st=$?"
		);
		let want = ("kill=0\nst=0\n".to_owned(), "count=1\ncount=1\n".to_owned(), Some(Exit(0)));
		for form in Form::BOTH {
			let obash = OsStr::new(env!("CARGO_BIN_EXE_obash"));
			assert_eq!(bounded_to_files(obash, form, &script, dir.path()), want, "{form:?}: {script}");
			if let Some(real) = real_bash_golden() {
				let theirs = bounded_to_files(real.as_os_str(), form, &script, dir.path());
				assert_eq!(theirs, want, "bash {form:?}: {script}");
			}
		}
	}
}

/// Shell code that, for each of `TSTP`, `TTIN` and `TTOU` in turn, makes
/// `$F.NAME` and then runs on, never blocking, until `$F.NAME.sent` exists:
/// [`stopped_by`] sends the signal in between. Its own bound ends a shell
/// its harness lost: 60 seconds by `$SECONDS`, past [`EVENT_LIMIT`], then
/// `exit 97`.
#[cfg(target_os = "linux")]
const STOP_STEPS: &str = r#"for s in TSTP TTIN TTOU; do : > "$F.$s"; until [ -e "$F.$s.sent" ]; do [ "$SECONDS" -lt 60 ] || exit 97; done; done"#;

/// The stop signals of [`STOP_STEPS`], in its order, with their names.
#[cfg(target_os = "linux")]
const STOP_SIGNALS: [(libc::c_int, &str); 3] =
	[(libc::SIGTSTP, "TSTP"), (libc::SIGTTIN, "TTIN"), (libc::SIGTTOU, "TTOU")];

/// The signals that stopped `script` (which holds [`STOP_STEPS`]), run by
/// `program` in `form` as `bash` in a process group of its own, and its
/// outcome. Once the shell has made `$F.NAME` it gets that stop signal from
/// outside, at its pid alone, and then `$F.NAME.sent` is made. Each stop the
/// shell takes is recorded and continued with `SIGCONT` ([`watch_stops`]).
/// The signal reaches the shell's process, so its OS disposition decides: a
/// shell that ignores it is not stopped. The shell's group is not a session
/// of its own: the kernel drops these signals for a process of an orphaned
/// group. A shell still running after [`EVENT_LIMIT`] fails the test; on
/// every way out its whole group is killed first ([`RowShell`]).
#[cfg(target_os = "linux")]
fn stopped_by(program: &OsStr, form: Form, script: &str) -> (Vec<libc::c_int>, Outcome) {
	let dir = tempfile::tempdir().expect("a directory for the step files");
	let f = dir.path().join("f");
	let started = form
		.run(program, &[], script, dir.path())
		.env("F", &f)
		.own_group()
		.spawn();
	let id = started.child.id();
	let pid = libc::pid_t::try_from(id).expect("a pid");
	let row = RowShell { started: Some(started), pid };
	let deadline = Instant::now() + EVENT_LIMIT;
	let mut stops = Vec::new();
	for (sig, name) in STOP_SIGNALS {
		let step = f.with_extension(name);
		if watch_stops(id, &mut stops, deadline, &|| step.exists()) != Watched::Ready {
			break;
		}
		// SAFETY: kill takes integer ids; the shell is not reaped yet.
		let sent = unsafe { libc::kill(pid, sig) };
		assert_eq!(sent, 0, "send {name} to the shell: {}", io::Error::last_os_error());
		fs::File::create(f.with_extension(format!("{name}.sent"))).expect("mark the signal sent");
	}
	let ended = watch_stops(id, &mut stops, deadline, &|| false);
	let out = row.finish();
	assert_eq!(
		ended,
		Watched::Ended,
		"{script}: the shell still ran after {EVENT_LIMIT:?} (stops {stops:?}), killed: {out:?}"
	);
	(stops, out)
}

/// The shell of a [`stopped_by`] row and its process group (the shell's
/// pid, [`Run::own_group`]). [`Self::finish`] kills the group, then reaps
/// the shell; a row that ends any other way (a failed check, a panic) does
/// the same on drop. The shell is reaped only there, so its pid, the
/// group's id, names no other process when the group is killed.
#[cfg(target_os = "linux")]
struct RowShell {
	started: Option<process_support::Started>,
	pid:     libc::pid_t,
}

#[cfg(target_os = "linux")]
impl RowShell {
	/// Kill the group with `SIGKILL` (a shell still running dies of it),
	/// then reap the shell: its outcome.
	fn finish(mut self) -> Outcome {
		let started = self.started.take().expect("the row's shell");
		// SAFETY: kill takes integer ids; the shell is not reaped yet.
		unsafe { libc::kill(-self.pid, libc::SIGKILL) };
		match started.ended_within(EVENT_LIMIT) {
			Ok(out) | Err(out) => out,
		}
	}
}

#[cfg(target_os = "linux")]
impl Drop for RowShell {
	fn drop(&mut self) {
		if let Some(mut started) = self.started.take() {
			// SAFETY: kill takes integer ids; the shell is not reaped yet.
			unsafe { libc::kill(-self.pid, libc::SIGKILL) };
			let _ = started.child.wait();
		}
	}
}

/// What ended a [`watch_stops`].
#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
enum Watched {
	/// The awaited fact holds.
	Ready,
	/// The shell ended (left unreaped).
	Ended,
	/// The deadline passed.
	Late,
}

/// Watch the child of pid `id` until `ready` holds, it ends, or `deadline`
/// passes: each stop it reports goes to `stops` by its signal, and the
/// child is continued with `SIGCONT`. Its end is seen with `WNOWAIT`, which
/// leaves it unreaped ([`RowShell`]).
#[cfg(target_os = "linux")]
fn watch_stops(
	id: u32,
	stops: &mut Vec<libc::c_int>,
	deadline: Instant,
	ready: &dyn Fn() -> bool,
) -> Watched {
	let pid = libc::pid_t::try_from(id).expect("a pid");
	loop {
		// SAFETY: plain data, which waitid fills.
		let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
		// SAFETY: a writable siginfo_t; `WNOWAIT` takes no report.
		let rc = unsafe {
			libc::waitid(
				libc::P_PID,
				id,
				&raw mut info,
				libc::WSTOPPED | libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
			)
		};
		assert_eq!(rc, 0, "look at the shell: {}", io::Error::last_os_error());
		// SAFETY: waitid filled `info`; `si_pid` 0 is nothing to report.
		if unsafe { info.si_pid() } != 0 {
			if info.si_code != libc::CLD_STOPPED {
				return Watched::Ended;
			}
			// SAFETY: as above; `WSTOPPED` alone takes the stop report only.
			unsafe { libc::waitid(libc::P_PID, id, &raw mut info, libc::WSTOPPED | libc::WNOHANG) };
			// SAFETY: a stop report, whose `si_status` is its signal.
			stops.push(unsafe { info.si_status() });
			// SAFETY: kill takes integer ids; the child is not reaped yet.
			unsafe { libc::kill(pid, libc::SIGCONT) };
			continue;
		}
		if ready() {
			return Watched::Ready;
		}
		if Instant::now() >= deadline {
			return Watched::Late;
		}
		std::thread::sleep(Duration::from_millis(2));
	}
}

/// Under `set -m` bash starts a job's programs with `INT` and `QUIT` at
/// their defaults, with no terminal too, where without job control an
/// asynchronous command's programs start with them ignored (bash
/// `setup_async_signals`): so after `set +m`, and after `bash -m`, which
/// turns `m` off without a terminal. Each program is the signal probe
/// ([`sigign_probe`]), which prints the signals it started with ignored,
/// read with the raw `rt_sigaction` system call: it reads them under gVisor
/// too, whose `/proc/PID/status` has no `SigIgn` line. Signals 32 and 33,
/// glibc's own, are left out ([`without_glibc_ign`]). The shell runs in a
/// process group of its own, with no terminal. The outputs and ends are
/// checked-in goldens measured with bash 5.3.20 (compared live only with a
/// bash 5.3 or later, [`real_bash_golden`]); bash 5.2.21 gives the same, but
/// for `( P ) & wait`, whose program it starts with neither ignored. The
/// probe is x86_64 code. Every row runs as a `-c` string and as a script
/// file ([`Form`]), with the same goldens.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
fn set_m_jobs_start_with_int_and_quit_at_their_defaults_without_a_terminal() {
	let dir = tempfile::tempdir().expect("a directory for the probe and the script");
	let probe = sigign_probe(dir.path());
	let (plain, m): (&[&str], &[&str]) = (&[], &["-m"]);
	let rows = [
		(plain, r#"set -m; "$P" job & wait"#, "SIGIGN job ign=none\n"),
		(plain, r#""$P" job & wait"#, "SIGIGN job ign=2,3\n"),
		(plain, r#"set -m; ( "$P" sub ) & wait"#, "SIGIGN sub ign=none\n"),
		(plain, r#"( "$P" sub ) & wait"#, "SIGIGN sub ign=2,3\n"),
		(plain, r#"set -m; set +m; "$P" job & wait"#, "SIGIGN job ign=2,3\n"),
		(m, r#""$P" job & wait"#, "SIGIGN job ign=2,3\n"),
	];
	for form in Form::BOTH {
		for (options, script, stdout) in rows {
			let run = |program: &OsStr| {
				let out = form
					.run(program, options, script, dir.path())
					.env("P", &probe)
					.own_group()
					.go();
				(without_glibc_ign(&String::from_utf8_lossy(&out.stdout)), out.end())
			};
			let expected = (stdout.to_owned(), Some(Exit(0)));
			let obash = OsStr::new(env!("CARGO_BIN_EXE_obash"));
			assert_eq!(run(obash), expected, "{form:?} {options:?} {script}");
			if let Some(real) = real_bash_golden() {
				assert_eq!(run(real.as_os_str()), expected, "bash {form:?} {options:?} {script}");
			}
		}
	}
}

/// The signal probe, `tests/fixtures/sigign.c` built: the program
/// `$PI_TEST_SIGIGN` names (an absolute path), else one built from that
/// source into `dir` with `cc -O2 -static -nostdlib -ffreestanding
/// -fno-stack-protector`. Neither: the test fails, naming the missing probe;
/// it never passes or skips without one.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn sigign_probe(dir: &Path) -> PathBuf {
	if let Some(path) = std::env::var_os("PI_TEST_SIGIGN").filter(|p| !p.is_empty()) {
		let path = PathBuf::from(path);
		assert!(
			path.is_absolute() && path.is_file(),
			"the signal probe is missing: PI_TEST_SIGIGN={} is not an absolute path to a built sigign",
			path.display()
		);
		return path;
	}
	let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sigign.c");
	let probe = dir.join("sigign");
	let built = std::process::Command::new("cc")
		.args(["-O2", "-static", "-nostdlib", "-ffreestanding", "-fno-stack-protector", "-o"])
		.arg(&probe)
		.arg(&source)
		.output();
	match built {
		Ok(out) if out.status.success() => probe,
		Ok(out) => panic!(
			"the signal probe is missing: PI_TEST_SIGIGN is unset and cc could not build {} ({}): {}",
			source.display(),
			out.status,
			String::from_utf8_lossy(&out.stderr)
		),
		Err(err) => panic!(
			"the signal probe is missing: PI_TEST_SIGIGN is unset and there is no cc to build {} \
			 ({err})",
			source.display()
		),
	}
}

/// `text` with signals 32 and 33 left out of each `SIGIGN LABEL ign=LIST`
/// line of the signal probe ([`without_glibc_signals`] says why), `none`
/// when nothing is left.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn without_glibc_ign(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	for line in text.split_inclusive('\n') {
		let Some((head, list)) = line.split_once(" ign=") else {
			out.push_str(line);
			continue;
		};
		let kept: Vec<&str> = list
			.trim_end_matches('\n')
			.split(',')
			.filter(|n| !matches!(*n, "32" | "33" | "none"))
			.collect();
		let kept = if kept.is_empty() {
			"none".to_owned()
		} else {
			kept.join(",")
		};
		out.push_str(head);
		out.push_str(" ign=");
		out.push_str(&kept);
		if list.ends_with('\n') {
			out.push('\n');
		}
	}
	out
}

/// The stdout, the stderr with `job 1[N]` written `job 1[PID]`, the pid of
/// bash's notice of a killed command `PID` ([`mask_pids`]) and the script's
/// path `SCRIPT` ([`Form::shown`]), and the end of `script` run by `program`
/// in `form` as `bash` in a process group of its own, with `$F` a file in
/// `dir`; a script file goes in `dir`.
#[cfg(target_os = "linux")]
fn without_pid(
	program: &OsStr,
	form: Form,
	script: &str,
	dir: &Path,
) -> (String, String, Option<End>) {
	let out = form
		.run(program, &[], script, dir)
		.env("F", dir.join("f"))
		.own_group()
		.go();
	let stderr = form.shown(&String::from_utf8_lossy(&out.stderr), dir);
	let stderr = match (stderr.find("job 1["), stderr.find("] stopped")) {
		(Some(at), Some(end)) if at < end => format!("{}PID{}", &stderr[..at + 6], &stderr[end..]),
		_ => stderr,
	};
	let stderr = String::from_utf8_lossy(&mask_pids(stderr.as_bytes())).into_owned();
	(String::from_utf8_lossy(&out.stdout).into_owned(), stderr, out.end())
}

/// Whether bash's run `theirs` agrees with `want`: the same, or the same
/// without `wait`'s warning of a stopped job. bash learns of a `kill -CONT
/// PID` from `SIGCHLD` (`waitchld`), which now and then comes before `wait`
/// looks at its jobs; it then waits for the job instead (measured: bash
/// 5.3.20 warned in 17 of 20 runs, bash 5.2.21 in 20 of 20 and missed once
/// in another run). obash learns of it only once it waits: it always warns.
#[cfg(target_os = "linux")]
fn bash_agrees(
	theirs: &(String, String, Option<End>),
	want: &(String, String, Option<End>),
) -> bool {
	let unwarned: String = want
		.1
		.split_inclusive('\n')
		.filter(|l| !l.contains("wait: warning: job"))
		.collect();
	theirs.0 == want.0 && theirs.2 == want.2 && (theirs.1 == want.1 || theirs.1 == unwarned)
}

/// Under `set -m` a `-c` string of bash 5.3 prints no notice of a background
/// job that ended or stopped without a signal ending it (`jobs.c`
/// `notify_of_job_status`: it holds the status for `jobs` and `wait`);
/// `jobs` lists the stopped job in bash 5.3's columns (`LONGEST_SIGNAL_DESC`
/// 27). The shell has no terminal. The goldens are bash 5.3.20's
/// (`GNU bash, version 5.3.20(1)-release (x86_64-pc-linux-gnu)`, built from
/// savannah bash.git 9c46586, "Bash-5.3 patch 20"); a live bash 5.3 or later
/// is compared too ([`real_bash_golden`]). bash 5.2.21 differs, a version
/// difference: it prints `[1]+  Done                    /bin/sleep 0.2` for
/// the first, and `\n[1]+  Stopped                 /bin/sleep 2` before
/// `wait`'s warning for the second, whose `jobs` pads to 24 columns. `set
/// -b` asks for a notice at once, which a shell without a terminal does not
/// give either: of a job that ended, nor of one that stopped itself. The
/// job that stops itself is listed once the shell knows of the stop: the
/// row waits until `jobs` says `Stopped` (bounded by `$SECONDS`), as a
/// shell may learn of it after the process stopped (obash then still said
/// `Running` in each of 12 runs per form, runc and gVisor; bash 5.3.20
/// `Stopped`). A foreground command a signal killed gets bash's own notice
/// ([`long_notice`]) and no other. Each row runs as a `-c` string and as a
/// script file ([`Form`]): the script's diagnostics name the script where
/// the `-c` string's name the shell.
#[cfg(target_os = "linux")]
#[test]
fn set_m_holds_a_scripts_job_notices() {
	/// A foreground command a signal kills.
	const K: &str = "/bin/sh -c 'kill -KILL $$'";
	let killed = String::from_utf8(long_notice(1, libc::SIGKILL, K.as_bytes())).expect("ASCII");
	// The job that stops itself, listed once the shell says it stopped.
	let self_stop = "set -m; set -b; /bin/sh -c 'kill -STOP $$' & until jobs >\"$F.j\"; read -r j \
	                 <\"$F.j\"; [ \"${j#*Stopped}\" != \"$j\" ]; do [ \"$SECONDS\" -lt 60 ] || \
	                 exit 97; /bin/sleep 0.05; done; jobs";
	let rows: Vec<(String, &str, String)> = vec![
		("set -m; /bin/sleep 0.2 & wait; echo end".into(), "end\n", String::new()),
		(
			"set -m; /bin/sleep 2 & kill -STOP $!; /bin/sleep 0.3; jobs; kill -CONT $!; wait; echo \
			 st=$?"
				.into(),
			"[1]+  Stopped                    /bin/sleep 2\nst=0\n",
			"bash: line 1: wait: warning: job 1[PID] stopped\n".into(),
		),
		("set -m; set -b; /bin/sleep 0.2 & wait; echo end".into(), "end\n", String::new()),
		(
			format!("{self_stop}; kill -CONT %1; wait; echo st=$?"),
			"[1]+  Stopped                    /bin/sh -c 'kill -STOP $$'\nst=0\n",
			String::new(),
		),
		(format!("set -m; {K}; echo st=$?"), "st=137\n", killed),
	];
	let dir = tempfile::tempdir().expect("a directory for the script");
	for form in Form::BOTH {
		for (script, stdout, stderr) in &rows {
			let expected = ((*stdout).to_owned(), form.golden(stderr), Some(Exit(0)));
			let obash = OsStr::new(env!("CARGO_BIN_EXE_obash"));
			assert_eq!(without_pid(obash, form, script, dir.path()), expected, "{form:?}: {script}");
			if let Some(real) = real_bash_golden() {
				let theirs = without_pid(real.as_os_str(), form, script, dir.path());
				assert!(bash_agrees(&theirs, &expected), "bash {form:?}: {script}: {theirs:?}");
			}
		}
	}
}

/// Under `set -m` bash learns that a job it did not continue itself (`kill
/// -CONT PID`, not `%1`) runs again only from the wait status: a `wait`
/// right after still finds it stopped, warns of it (`jobs.c`
/// `wait_for_background_pids`) and returns ([`bash_agrees`]: bash now and
/// then learns of it first). The golden is bash 5.3.20's (compared live
/// only with a bash 5.3 or later, [`real_bash_golden`]); bash 5.2.21 also
/// prints a notice of the stop, which bash 5.3 holds: only `wait`'s line is
/// compared, and it is the same. It runs as a `-c` string and as a script
/// file ([`Form`]), whose warning names the script.
#[cfg(target_os = "linux")]
#[test]
fn set_m_wait_warns_of_a_job_continued_by_pid() {
	let script =
		"set -m; /bin/sleep 2 & kill -STOP $!; /bin/sleep 0.3; kill -CONT $!; wait; echo st=$?";
	let dir = tempfile::tempdir().expect("a directory for the script");
	for form in Form::BOTH {
		let run = |program: &OsStr| {
			let (stdout, stderr, end) = without_pid(program, form, script, dir.path());
			let waits: String = stderr
				.split_inclusive('\n')
				.filter(|l| l.contains("wait:"))
				.collect();
			(stdout, waits, end)
		};
		let expected = (
			"st=0\n".to_owned(),
			form.golden("bash: line 1: wait: warning: job 1[PID] stopped\n"),
			Some(Exit(0)),
		);
		assert_eq!(run(OsStr::new(env!("CARGO_BIN_EXE_obash"))), expected, "{form:?}: {script}");
		if let Some(real) = real_bash_golden() {
			let theirs = run(real.as_os_str());
			assert!(bash_agrees(&theirs, &expected), "bash {form:?}: {script}: {theirs:?}");
		}
	}
}

/// Under `set -m` without a terminal, a foreground command of the shell
/// that stops is a stopped job, as in bash (`jobctl::bash_suspend`): `$?`
/// is 147, the shell runs on, also inside a loop, and `jobs` lists each
/// stopped command; nothing is printed at the stop. Before the stop path
/// took bash's way, obash took zsh's (`jobctl::suspend`): it printed
/// `zsh: suspended (signal)  CMD`, and a stop inside a loop made the whole
/// loop the job and ended the rest of the line. bash's output is compared
/// live only with a bash 5.3 or later ([`real_bash_golden`]). Each stopped
/// program writes its pid to `$F.pids`, and the test ends each one after
/// the run, so a shell that leaves one stopped leaves nothing behind. The
/// rows run as a `-c` string and as a script file ([`Form`]), bounded
/// ([`bounded_to_files`]).
#[cfg(target_os = "linux")]
#[test]
fn set_m_foreground_stop_without_a_terminal_takes_bashs_way() {
	const OUT: &str = "exec >\"$F.out\" 2>\"$F.err\"; /bin/rm -f \"$F.pids\"; ";
	let cmd = r#"/bin/sh -c 'echo $$ >> "$0.pids"; kill -STOP $$' "$F""#;
	let one = format!("[1]+  Stopped                    {cmd}\n");
	let two =
		format!("[1]-  Stopped                    {cmd}\n[2]+  Stopped                    {cmd}\n");
	// (script, bash's output and end: obash's too)
	let rows = [
		(
			format!("set -m; {cmd}; echo st=$?; jobs; kill -CONT %1; wait; echo end"),
			(format!("st=147\n{one}end\n"), Exit(0)),
		),
		(
			format!(
				"set -m; for i in 1 2; do {cmd}; echo st=$?; done; jobs; kill -CONT %1 %2; wait; echo \
				 end"
			),
			(format!("st=147\nst=147\n{two}end\n"), Exit(0)),
		),
	];
	let dir = tempfile::tempdir().expect("a directory for the script and the output");
	// The programs that stopped, ended after the run.
	let end_stopped = || {
		let pids = fs::read_to_string(dir.path().join("f.pids")).unwrap_or_default();
		for pid in pids
			.lines()
			.filter_map(|p| p.trim().parse::<libc::pid_t>().ok())
		{
			// SAFETY: a plain signal to a pid the row wrote; one gone is ESRCH.
			unsafe { libc::kill(pid, libc::SIGKILL) };
		}
	};
	for form in Form::BOTH {
		for (script, (want, end)) in &rows {
			let script = format!("{OUT}{script}");
			let want = (want.clone(), String::new(), Some(*end));
			let obash = OsStr::new(env!("CARGO_BIN_EXE_obash"));
			let got = bounded_to_files(obash, form, &script, dir.path());
			end_stopped();
			assert_eq!(got, want, "{form:?}: {script}");
			if let Some(real) = real_bash_golden() {
				let got = bounded_to_files(real.as_os_str(), form, &script, dir.path());
				end_stopped();
				assert_eq!(got, want, "bash {form:?}: {script}");
			}
		}
	}
}

/// A non-interactive bash started with `-m` (`-o monitor`) and no terminal
/// on its standard error cannot take one over (`jobs.c`
/// `initialize_job_control`): it says so, naming -1 when it leads its own
/// process group and else the group it stays in, and runs without job
/// control. The goldens are bash 5.3.20's (compared live only with a bash
/// 5.3 or later, [`real_bash_golden`]); bash 5.2.21 gives the same. Each row
/// runs as a `-c` string and as a script file ([`Form`]): `$-` has `c` only
/// in the first, and the two lines name the shell in both. An imported
/// `SHELLOPTS` naming `monitor` turns job control on (bash
/// `set_job_control`, which needs no terminal) with neither line: a job
/// leads its own group.
#[cfg(target_os = "linux")]
#[test]
fn bash_m_without_a_terminal_runs_without_job_control() {
	// SAFETY: getpgrp has no preconditions.
	let ours_group = unsafe { libc::getpgrp() };
	let rows = [
		(&["-m"][..], true, -1),
		(&["-o", "monitor"][..], true, -1),
		(&["-m"][..], false, ours_group),
	];
	let dir = tempfile::tempdir().expect("a directory for the script");
	for form in Form::BOTH {
		let flags = if form == Form::Inline {
			"hBc\n"
		} else {
			"hB\n"
		};
		for (options, own_group, shown) in rows {
			let run = |program: &OsStr| {
				let run = form.run(program, options, "echo $-", dir.path());
				let out = if own_group { run.own_group() } else { run }.go();
				(
					String::from_utf8_lossy(&out.stdout).into_owned(),
					String::from_utf8_lossy(&out.stderr).into_owned(),
					out.end(),
				)
			};
			let expected = (
				flags.to_owned(),
				format!(
					"bash: cannot set terminal process group ({shown}): Inappropriate ioctl for \
					 device\nbash: no job control in this shell\n"
				),
				Some(Exit(0)),
			);
			let obash = OsStr::new(env!("CARGO_BIN_EXE_obash"));
			assert_eq!(run(obash), expected, "{form:?} {options:?}");
			if let Some(real) = real_bash_golden() {
				assert_eq!(run(real.as_os_str()), expected, "bash {form:?} {options:?}");
			}
		}
	}
	let script = format!("/bin/sh -c '{OWN}' & wait");
	for form in Form::BOTH {
		let run = |program: &OsStr| {
			let out = form
				.run(program, &[], &script, dir.path())
				.env("SHELLOPTS", "monitor")
				.own_group()
				.go();
			(
				String::from_utf8_lossy(&out.stdout).into_owned(),
				String::from_utf8_lossy(&out.stderr).into_owned(),
				out.end(),
			)
		};
		let expected = ("own\n".to_owned(), String::new(), Some(Exit(0)));
		let obash = OsStr::new(env!("CARGO_BIN_EXE_obash"));
		assert_eq!(run(obash), expected, "{form:?} SHELLOPTS=monitor: {script}");
		if let Some(real) = real_bash_golden() {
			assert_eq!(run(real.as_os_str()), expected, "bash {form:?} SHELLOPTS=monitor: {script}");
		}
	}
}

/// A job that `kill -STOP %1` stops before its program has started still
/// has its pid: bash's job has it from its fork, so `jobs -l` and `jobs -p`
/// print it, and `$!` expands to it, at once. obash knows a lone command's
/// pid only once the job spawns its program, and a job stopped before that
/// never did: each of those readers waited for it forever. A job stopped
/// that early now runs on to its program, and the stop reaches the program
/// then: a program stopped so runs on only once continued. Under `set -m`
/// bash learns of the stop (`jobs -l` says `Stopped (signal)`; the row
/// waits until `jobs` says so, 3 s at most), `wait -p` of the job names
/// its pid, with `wait_for_job`'s warning of a job stopped before the
/// wait, and `disown` of it warns with its pid; a bash that has not learned
/// of the stop yet does none of these (the rows' alternatives). Without job
/// control bash never learns of it (`Running`). Each row ends the job (a
/// `kill` of it, or its own end) and writes its output to files, so nothing
/// that outlives the shell holds a pipe of the run ([`bounded_to_files`]).
/// Every row runs as a `-c` string and as a script file ([`Form`]); pids
/// are masked ([`mask_job_pids`]). The goldens are bash 5.3.20's: its
/// `jobs -l` lines and ends were measured on rows that stop the job at
/// once, list it and end it; each row is compared live with a bash 5.3 or
/// later ([`real_bash_golden`]).
#[cfg(target_os = "linux")]
#[test]
fn a_job_stopped_before_its_program_starts_shows_its_pid() {
	/// Sends the row's output to files ([`bounded_to_files`]).
	const OUT: &str = "exec >\"$F.out\" 2>\"$F.err\"; ";
	/// The end of each row: the job continued, ended and waited for.
	const END: &str = "kill -CONT %1; kill %1; wait; echo st=$?";
	/// A row: its text, the output and error it gives, and those of a bash
	/// that has not learned of the stop yet, where they differ.
	type Row = (String, String, &'static str, Option<(String, &'static str)>);
	let mut rows: Vec<Row> = Vec::new();
	for (m, listed) in [
		("set -m; ", "[1]+ PID Stopped (signal)           /bin/sleep 30\n"),
		("", "[1]+ PID Running                    /bin/sleep 30 &\n"),
	] {
		let job = format!("{OUT}{m}/bin/sleep 30 & kill -STOP %1");
		let readers = "jobs -l; jobs -p; [ -n \"$!\" ] && echo bang";
		// Under `set -m`, until the shell has learned of the stop, for 3 s
		// at most; without job control bash never does. A bash that has not
		// learned of it by then (bash 5.3.20 on gVisor as root, now and then
		// for the whole 20 s it was given) lists the job `Running` (the
		// row's alternative); obash has learned of it every time.
		let (learned, unlearned) = if m.is_empty() {
			("/bin/sleep 0.3", None)
		} else {
			(
				"i=0; until jobs >\"$F.j\"; read -r j <\"$F.j\"; [ \"${j#*Stopped}\" != \"$j\" ] || [ \
				 $i -ge 60 ]; do i=$((i+1)); /bin/sleep 0.05; done",
				Some((
					"[1]+ PID Running                    /bin/sleep 30 &\nPID\nbang\nst=0\n".to_owned(),
					"",
				)),
			)
		};
		rows.push((
			format!("{job}; {learned}; {readers}; {END}"),
			format!("{listed}PID\nbang\nst=0\n"),
			"",
			unlearned,
		));
		rows.push((format!("{job}; jobs -p; {END}"), "PID\nst=0\n".to_owned(), "", None));
		rows.push((
			format!("{job}; [ -n \"$!\" ] && echo bang; {END}"),
			"bang\nst=0\n".to_owned(),
			"",
			None,
		));
	}
	// The program stops once it started, and runs on only once continued.
	// It sleeps 0.2 s, so that obash's held stop reaches it first (obash
	// sends the stop once it has spawned the program: without the sleep the
	// program said `ran` before it in some runs), and then says `ran` only
	// once the shell has made `$F.go`, which the shell does after its `kill
	// -STOP %1` (the program waits 30 s at most): so the stop comes before
	// the program can end, however late the shell sends it (bash 5.3.20 on
	// gVisor sent it more than 0.2 s after its fork, 1 run in 320, when the
	// program only slept 0.2 s). Only without `set -m`: the `set -m` form
	// gave the same with round 1's plant `l` (the held stop never released)
	// in 40 of 40 runs, so it could not fail for what it was there to show,
	// and it is not a row.
	let ran = r#"/bin/sh -c 'sleep 0.2; i=0; until [ -e "$0.go" ]; do i=$((i+1)); [ $i -lt 600 ] || exit 97; sleep 0.05; done; echo ran' "$F""#;
	rows.push((
		format!(
			"{OUT}/bin/rm -f \"$F.go\"; {ran} & kill -STOP %1; : > \"$F.go\"; /bin/sleep 0.5; jobs \
			 -l; kill -CONT %1; wait; echo st=$?"
		),
		format!("[1]+ PID Running                    {ran} &\nran\nst=0\n"),
		"",
		None,
	));
	// A stop that comes while a command substitution runs below the vproc
	// that settles the job's pid (the `exec` of a function that is the
	// job's command): the substitution's program runs on, and the job's
	// program stops once it has started. That program waits for `$F.go`,
	// which the shell makes after the stop; `$F.in` says it runs.
	let sub = r#"/bin/sh -c ': > "$0.in"; i=0; until [ -e "$0.go" ]; do i=$((i+1)); [ $i -lt 1200 ] || exit 97; sleep 0.05; done; echo 0.1' "$F""#;
	for m in ["set -m; ", ""] {
		let job = format!(
			"{OUT}{m}/bin/rm -f \"$F.in\" \"$F.go\"; f() {{ exec /bin/sleep \"$({sub})\"; }}; f & \
			 until [ -e \"$F.in\" ]; do [ \"$SECONDS\" -lt 60 ] || exit 97; /bin/sleep 0.05; done"
		);
		let rest = "kill -STOP %1; : > \"$F.go\"; jobs -p >/dev/null; echo listed; kill -CONT %1; \
		            wait; echo st=$?";
		rows.push((format!("{job}; {rest}"), "listed\nst=0\n".to_owned(), "", None));
	}
	// Under `set -m`, the same stop of a job whose own command has the
	// substitution in its words (`/bin/sleep "$(…)" &`): nothing of the job
	// runs while it is stopped (`held`), as in bash, where the stop reaches
	// the substitution's process in the job's group. Its program makes
	// `$F.saw` once it has seen `$F.go`.
	let saw = sub.replace("echo 0.1", ": > \"$0.saw\"; echo 0.1");
	rows.push((
		format!(
			"{OUT}set -m; /bin/rm -f \"$F.in\" \"$F.go\" \"$F.saw\"; /bin/sleep \"$({saw})\" & until \
			 [ -e \"$F.in\" ]; do [ \"$SECONDS\" -lt 60 ] || exit 97; /bin/sleep 0.05; done; kill \
			 -STOP %1; : > \"$F.go\"; /bin/sleep 0.5; [ -e \"$F.saw\" ] && echo ran-while-stopped || \
			 echo held; jobs -p >/dev/null; echo listed; kill -CONT %1; wait; echo st=$?"
		),
		"held\nlisted\nst=0\n".to_owned(),
		"",
		None,
	));
	// `wait -p` once the shell has learned of the stop, bounded: bash 5.3.20
	// on gVisor now and then never learns of it, and its `wait` then never
	// returns (1 run in 60 as root, the reviewer's measurement); such a run
	// ends with `exit 98` and is not compared (below).
	let learned = "until jobs >\"$F.j\"; read -r j <\"$F.j\"; [ \"${j#*Stopped}\" != \"$j\" ]; do \
	               [ \"$SECONDS\" -lt 20 ] || exit 98; /bin/sleep 0.05; done";
	let wait_p = "wait -p v %1; echo st=$?; [ \"$v\" = \"$!\" ] && echo same";
	rows.push((
		format!("{OUT}set -m; /bin/sleep 30 & kill -STOP %1; {learned}; {wait_p}; {END}"),
		format!("st={}\nsame\nst=0\n", 128 + libc::SIGSTOP),
		"bash: line 1: warning: wait_for_job: job 1 is stopped\n",
		None,
	));
	// `disown`'s warning goes to `$F.d`: its last word is the job's pid.
	let disown = "disown %1 2>\"$F.d\"; echo st=$?; read -r w < \"$F.d\"; [ \"${w##* }\" = \"$!\" \
	              ] && echo same";
	rows.push((
		format!("{OUT}set -m; /bin/sleep 30 & kill -STOP %1; {disown}; kill -CONT $!; kill $!"),
		"st=0\nsame\n".to_owned(),
		"",
		Some(("st=0\n".to_owned(), "")),
	));
	let dir = tempfile::tempdir().expect("a directory for the script and the output");
	let run = |program: &OsStr, form: Form, script: &str| {
		let (stdout, stderr, end) = bounded_to_files(program, form, script, dir.path());
		(mask_job_pids(&stdout), stderr, end)
	};
	for form in Form::BOTH {
		for (script, stdout, stderr, unlearned) in &rows {
			let want = (stdout.clone(), form.golden(stderr), Some(Exit(0)));
			let obash = OsStr::new(env!("CARGO_BIN_EXE_obash"));
			assert_eq!(run(obash, form, script), want, "{form:?}: {script}");
			if let Some(real) = real_bash_golden() {
				let theirs = run(real.as_os_str(), form, script);
				let alternative = unlearned
					.as_ref()
					.map(|(stdout, stderr)| (stdout.clone(), form.golden(stderr), want.2));
				// A row with a bounded wait for the stop, and a bash that never
				// learned of it (`exit 98` before any output): no reading of
				// it, and said so.
				if script.contains("|| exit 98") && theirs.0.is_empty() && theirs.2 == Some(Exit(98)) {
					zsh_oracle::uncompared(&format!(
						"bash {form:?} never learned of the stop in 20 s: {script}"
					));
					continue;
				}
				assert!(
					theirs == want || alternative.is_some_and(|alt| theirs == alt),
					"bash {form:?}: {script}: {theirs:?}"
				);
			}
		}
	}
}

/// What `text` gave, run by `program` in `form` as `bash` in a process group
/// of its own, with `$F` a file in `dir`: what it wrote to `$F.out` and
/// `$F.err` (the script's path written `SCRIPT`, [`Form::shown`]), and its
/// end. The text sends its output there, so that a job it leaves behind
/// holds no pipe of the run. A shell still running after [`EVENT_LIMIT`],
/// or one that stops, fails the test; on every way out its group is killed
/// before it is reaped ([`RowShell`]).
#[cfg(target_os = "linux")]
fn bounded_to_files(
	program: &OsStr,
	form: Form,
	text: &str,
	dir: &Path,
) -> (String, String, Option<End>) {
	let f = dir.join("f");
	let (out, err) = (f.with_extension("out"), f.with_extension("err"));
	for file in [&out, &err] {
		let _ = fs::remove_file(file);
	}
	let started = form
		.run(program, &[], text, dir)
		.env("F", &f)
		.own_group()
		.spawn();
	let id = started.child.id();
	let pid = libc::pid_t::try_from(id).expect("a pid");
	let row = RowShell { started: Some(started), pid };
	let mut stops = Vec::new();
	let ended = watch_stops(id, &mut stops, Instant::now() + EVENT_LIMIT, &|| false);
	let shell = row.finish();
	assert_eq!(
		(ended, stops),
		(Watched::Ended, Vec::new()),
		"{} {form:?}: {text}: the shell still ran after {EVENT_LIMIT:?}, or stopped: {shell:?}",
		Path::new(program).display()
	);
	let read = |path: &PathBuf| form.shown(&fs::read_to_string(path).unwrap_or_default(), dir);
	(read(&out), read(&err), shell.end())
}

/// `text` with the pid written `PID` on each line of `jobs -l` and of
/// `jobs -p`. bash prints a `jobs -l` pid as `%5d` after `[N]+ `: the mask
/// takes its padding too (`[N]+ PID STATE COMMAND`), so a pid of any width
/// gives the same line. A `jobs -p` line is a pid alone.
#[cfg(target_os = "linux")]
fn mask_job_pids(text: &str) -> String {
	let digits = |s: &str| s.bytes().take_while(u8::is_ascii_digit).count();
	let mut out = String::with_capacity(text.len());
	for line in text.split_inclusive('\n') {
		// `[N]`, an optional `+` or `-` and one space: the pid's field follows.
		let field = line
			.strip_prefix('[')
			.and_then(|rest| {
				let n = digits(rest);
				let rest = rest[n..].strip_prefix(']').filter(|_| n > 0)?;
				let rest = rest.strip_prefix(['+', '-']).unwrap_or(rest);
				rest.strip_prefix(' ')
			})
			.map(|rest| line.len() - rest.len());
		let at = match field {
			Some(at) => at,
			None if digits(line) == line.trim_end_matches('\n').len() => 0,
			None => {
				out.push_str(line);
				continue;
			},
		};
		let pad = line[at..].bytes().take_while(|&b| b == b' ').count();
		let n = digits(&line[at + pad..]);
		if n == 0 {
			out.push_str(line);
			continue;
		}
		out.push_str(&line[..at]);
		out.push_str("PID");
		out.push_str(&line[at + pad + n..]);
	}
	out
}
