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
	path::Path,
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
	// A job killed while it was stopped is reported as one killed while it
	// ran: bash reports a dead job a signal killed once it reaped it, at the
	// next report point, whatever state it died in (`notify_of_job_status`
	// looks at no earlier state). Here by `%job` and by pid, for `HUP` too
	// (which `kill` follows with `CONT`), with `set -m` and without it, and a
	// job killed by `%job` as it ran. A job `kill` names before obash spawned
	// its program (nothing read `$!` first) has the program spawned first, as
	// bash forked it at `&`: its notice names the program's pid
	// ([`names_a_program_pid`]), where it named the job's virtual pid. Each
	// row closes the reap race ([`GONE`]): with nothing between the kill and
	// the next line, bash prints the notice only when it reaped the job in
	// time. Each shell leads a process group of its own here, inside the
	// runner's session, as bash's jobs do: obash keeps a `set -m` job in the
	// shell's group, and a stop in an orphaned group hangs that group up.
	let stop = "/bin/sleep 30 & kill -STOP %1; /bin/sleep 0.3;";
	let by_kill = [
		(format!("set -m; {stop} kill -KILL %1; {GONE}"), killed(2), true),
		(
			format!(
				"set -m; /bin/sleep 30 & p=$!; kill -STOP %1; /bin/sleep 0.3; kill -KILL %1; {GONE}"
			),
			killed(2),
			false,
		),
		(
			format!(
				"set -m; /bin/sleep 30 & p=$!; kill -STOP $p; /bin/sleep 0.3; kill -KILL $p; {GONE}"
			),
			killed(2),
			false,
		),
		(
			format!("set -m; {stop} kill -HUP %1; {GONE}"),
			notice(2, libc::SIGHUP, "/bin/sleep 30"),
			true,
		),
		(format!("{stop} kill -KILL %1; {GONE}"), killed(2), true),
		(format!("/bin/sleep 30 & kill -KILL %1; {GONE}"), killed(2), true),
		(format!("/bin/sleep 30 & p=$!; kill -KILL %1; {GONE}"), killed(2), false),
	];
	for (script, notice_line, spawned_by_kill) in by_kill {
		let script = format!("exec 2>&1; {script}\necho next");
		let out = format!("{notice_line}next\n");
		let ours = Run::script(env!("CARGO_BIN_EXE_obash"), "bash", &script)
			.own_group()
			.go();
		let got = (String::from_utf8_lossy(&mask_pids(&ours.stdout)).into_owned(), ours.end());
		if got != (out.clone(), Some(Exit(0))) {
			wrong.push(format!("{script:?}\n  got:  {got:?}\n  want: {out:?}"));
		}
		if spawned_by_kill {
			names_a_program_pid(&mut wrong, &script, &ours.stdout);
		}
		if let Some(bash) = real_bash_golden() {
			let theirs = Run::script(bash, "bash", &script).own_group().go();
			assert_eq!(masked(&ours), masked(&theirs), "{script:?}");
		}
	}
	// The same at the end of a script file: at the read that finds the end.
	let ends = format!("exec 2>&1; set -m; {stop} kill -KILL %1; {GONE}\n");
	fs::write(&path, &ends).expect("write the script");
	let ours = obash().own_group().go();
	let out = format!("{file}: line 2: PID {:<27}/bin/sleep 30\n", desc(libc::SIGKILL));
	let got = (String::from_utf8_lossy(&mask_pids(&ours.stdout)).into_owned(), ours.end());
	if got != (out.clone(), Some(Exit(0))) {
		wrong.push(format!("file {ends:?}\n  got:  {got:?}\n  want: {out:?}"));
	}
	names_a_program_pid(&mut wrong, &ends, &ours.stdout);
	if let Some(bash) = real_bash_golden() {
		let theirs = Run::new(&bash, "bash", &[&path]).own_group().go();
		assert_eq!(masked(&ours), masked(&theirs), "file: {ends:?}");
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

/// Push to `wrong` unless the long killed-job notice in `out`
/// (`NAME: line N: PID Killed …`) names a program's pid: obash's virtual
/// pids start at 2^30 (`Vpid::BASE`), and a job killed before obash spawned
/// its program named its own there.
fn names_a_program_pid(wrong: &mut Vec<String>, script: &str, out: &[u8]) {
	let pid = notice_pid(out);
	if pid.is_none_or(|pid| pid >= 1 << 30) {
		let text = String::from_utf8_lossy(out);
		wrong.push(format!(
			"{script:?}\n  the notice names {pid:?}, not a program's pid\n  out: {text:?}"
		));
	}
}

/// The pid the first long job notice in `out` (`NAME: line N: PID …`)
/// names.
fn notice_pid(out: &[u8]) -> Option<u64> {
	String::from_utf8_lossy(out).lines().find_map(|line| {
		let (_, rest) = line.split_once(": line ")?;
		let (_, rest) = rest.split_once(": ")?;
		rest.split_whitespace().next()?.parse::<u64>().ok()
	})
}

/// A job `kill %N` names before obash decided its pid (`proc::Bang`: no
/// `$!` read yet) whose program never starts (a command not found, a file
/// that does not exist, one without execute permission) takes the signal
/// before it runs its command, as bash's child, forked at `&`, takes it
/// before its search or its `exec` fails: no error line, `kill` returns 0,
/// and `wait` reaps the job killed. So does a job that runs no program at
/// all: a builtin, an assignment, words that fail to expand, a redirection
/// that fails, and each stage of a pipeline; under `set -x` it traces
/// nothing, also when it calls a function whose body only does arithmetic, a
/// `case`, or another such function, or when it expands a command
/// substitution. A function's call is traced in an op before the one that
/// takes the signal. The signal waited for the job's decision, so it also
/// waits across the shell's own snapshot and restore at every op (the frames
/// image keeps it with the decision; the fault injector's settings as in
/// [`a_killed_jobs_notice_survives_a_restore`]). The notice names the pid
/// `$!` shows for the job afterwards, compared unmasked: bash's, its
/// child's; obash's, the job's virtual pid, as no process ever existed for
/// it. A job whose program would run with a redirection takes the signal
/// before it opens the file, as bash's child does: no file is left. And a
/// job stopped before it decided, then continued, runs its command then,
/// as bash's child does once continued: the error line, status 127. Each
/// form runs as a `-c` string and in a script file. The first form, the
/// function forms and the stopped ones are compared live with bash 5.3.20
/// (pids masked), bash's side of a row run until it shows none of bash's own
/// races ([`bash_without_its_races`]); the others with its goldens only. The
/// real bash sometimes loses the signal to its child (the error line and no
/// notice; measured over three runs of 10 on gVisor, up to 3 for
/// `nosuchcmd` and `/no/such/file`, 6 for `./f` and 8 for the pipeline; on
/// runc, once in 10 for the `set -x` form): bash's own race, made wider by
/// the gVisor defect of google/gvisor#17983 (a signal sent to a process in
/// `execve` is dropped; filed for `SIGSTOP`). Compare them live again once
/// gVisor fixes it.
#[test]
fn bash_reports_a_job_killed_before_its_program_fails_to_start() {
	let dir = tempfile::tempdir().expect("a directory for the scripts");
	let noexec = dir.path().join("f");
	fs::write(&noexec, "#!/bin/sh\necho ran\n").expect("write a file without execute permission");
	let noexec = noexec.display().to_string();
	let path = dir.path().join("s.sh");
	let file = path.display().to_string();
	let obash = env!("CARGO_BIN_EXE_obash");
	let bash = real_bash_golden();
	let mut wrong = Vec::new();
	let mut check = |script: &str, want: &dyn Fn(&str) -> String, group: bool, live: bool| {
		let script = format!("exec 2>&1; {script}");
		fs::write(&path, format!("{script}\n")).expect("write the script");
		let runs = [
			(
				"bash",
				Run::script(obash, "bash", &script),
				bash
					.as_ref()
					.filter(|_| live)
					.map(|b| Run::script(b, "bash", &script)),
			),
			(
				file.as_str(),
				Run::new(obash, "bash", &[&path]),
				bash
					.as_ref()
					.filter(|_| live)
					.map(|b| Run::new(b, "bash", &[&path])),
			),
		];
		for (name, ours, theirs) in runs {
			let (ours, theirs) = if group {
				(ours.own_group(), theirs.map(Run::own_group))
			} else {
				(ours, theirs)
			};
			let ours = ours.go();
			let got = (
				String::from_utf8_lossy(&mask_stage_pids(&mask_pids(&ours.stdout))).into_owned(),
				ours.end(),
			);
			let out = want(name);
			if got != (out.clone(), Some(Exit(0))) {
				wrong.push(format!("{name}: {script:?}\n  got:  {got:?}\n  want: {out:?}"));
			}
			if let Some(theirs) = theirs {
				let theirs = bash_without_its_races(&theirs, &out);
				assert_eq!(masked_stages(&ours), masked_stages(&theirs), "{name}: {script:?}");
			}
		}
	};
	let killed = |name: &str, cmd: &str| {
		format!("st=0\n{name}: line 1: PID {:<27}{cmd}\nw=0\n", desc(libc::SIGKILL))
	};
	let forms = [
		"nosuchcmd",
		"/no/such/file",
		noexec.as_str(),
		"echo hi",
		"x=1",
		": ${u?unset}",
		"/bin/true > /no/such/dir/f",
	];
	for (i, cmd) in forms.into_iter().enumerate() {
		let script = format!("{cmd} & kill -KILL %1; echo \"st=$?\"; wait; echo \"w=$?\"");
		check(&script, &|name| killed(name, cmd), false, i == 0);
	}
	let k = desc(libc::SIGKILL);
	let stages = [(k.as_str(), "nosuchcmd"), (k.as_str(), "nosuch2")];
	check(
		"nosuchcmd | nosuch2 & kill -KILL %1; echo \"st=$?\"; wait; echo \"w=$?\"",
		&|name| format!("st=0\n{}w=0\n", job_notice(name, 1, &stages, "")),
		false,
		false,
	);
	// A redirection the job's program would have opened: no file is left.
	let out = dir.path().join("out").display().to_string();
	check(
		&format!(
			"/bin/true > {out} & kill -KILL %1; echo \"st=$?\"; wait; echo \"w=$?\"; [ -e {out} ] && \
			 echo out=created || echo out=absent"
		),
		&|name| format!("{}out=absent\n", killed(name, &format!("/bin/true > {out}"))),
		false,
		false,
	);
	// Under `set -x` the job's trace line goes with it: it never traced.
	check(
		"set -x; nosuchcmd & kill -KILL %1; echo \"st=$?\"; wait; echo \"w=$?\"",
		&|name| {
			let notice = killed(name, "nosuchcmd");
			let notice = notice.lines().nth(1).expect("the notice line");
			format!("+ kill -KILL %1\n+ echo st=0\nst=0\n+ wait\n{notice}\n+ echo w=0\nw=0\n")
		},
		false,
		false,
	);
	// A function job traces its call in an op before the one that takes the
	// signal: the trace line waits there, and goes with the job.
	let killed_with_xtrace = |name: &str, cmd: &str| {
		let notice = killed(name, cmd);
		let notice = notice.lines().nth(1).expect("the notice line");
		format!("+ kill -KILL %1\n+ echo st=0\nst=0\n+ wait\n{notice}\n+ echo w=0\nw=0\n")
	};
	check(
		"f() { nosuchcmd; }; set -x; f & kill -KILL %1; echo \"st=$?\"; wait; echo \"w=$?\"",
		&|name| killed_with_xtrace(name, "f"),
		false,
		false,
	);
	for (before, body) in
		[("", "(( 1 ))"), ("", "case x in x) ;; esac"), ("g() { (( 1 )); }; ", "g")]
	{
		check(
			&format!(
				"{before}f() {{ {body}; }}; set -x; f & kill -KILL %1; echo \"st=$?\"; wait; echo \
				 \"w=$?\""
			),
			&|name| killed_with_xtrace(name, "f"),
			false,
			true,
		);
	}
	// A job's command substitution takes the signal before it traces.
	for cmd in [": $(:)", "x=$(:)"] {
		check(
			&format!("set -x; {cmd} & kill -KILL %1; echo \"st=$?\"; wait; echo \"w=$?\""),
			&|name| killed_with_xtrace(name, cmd),
			false,
			false,
		);
	}
	let not_found = |name: &str| format!("{name}: line 1: nosuchcmd: command not found\nw=127\n");
	check(
		"nosuchcmd & kill -STOP %1; kill -CONT %1; wait %1; echo \"w=$?\"",
		&not_found,
		false,
		true,
	);
	check(
		"set -m; nosuchcmd & kill -STOP %1; /bin/sleep 0.3; jobs; kill -CONT %1; wait %1; echo \
		 \"w=$?\"",
		&|name| format!("[1]+  {:<27}nosuchcmd\n{}", "Stopped", not_found(name)),
		true,
		true,
	);
	// Its notice names `$!`.
	let script = "exec 2>&1; nosuchcmd & kill -KILL %1; echo \"bang=$!\"; wait";
	let shells = std::iter::once(std::path::PathBuf::from(obash)).chain(bash.clone());
	for (i, shell) in shells.enumerate() {
		let run = Run::script(&shell, "bash", script);
		let outcome = if i == 0 {
			run.go()
		} else {
			bash_without_its_races(&run, &killed("bash", "nosuchcmd"))
		};
		let out = outcome.stdout;
		let text = String::from_utf8_lossy(&out);
		let bang = text
			.lines()
			.find_map(|l| l.strip_prefix("bang=")?.parse::<u64>().ok());
		if bang.is_none() || bang != notice_pid(&out) {
			wrong
				.push(format!("{shell:?}: {script:?}\n  the notice does not name $!\n  out: {text:?}"));
		}
	}
	// Across the shell's own snapshot and restore at every op.
	let script = "exec 2>&1; nosuchcmd & kill -KILL %1; echo \"st=$?\"; wait; echo \"w=$?\"";
	let want = (killed("bash", "nosuchcmd"), Some(Exit(0)));
	for seed in 1..=3 {
		for mode in ["step", "exec"] {
			let ours = Run::script(obash, "bash", script)
				.env("PI_SHELL_FAULT", format!("{seed}:1"))
				.env("PI_SHELL_FAULT_MODE", mode)
				.env("PI_SHELL_FAULT_LOST", "defer")
				.go();
			let got = (String::from_utf8_lossy(&mask_pids(&ours.stdout)).into_owned(), ours.end());
			if got != want {
				wrong
					.push(format!("{mode}, seed {seed}: {script:?}\n  got:  {got:?}\n  want: {want:?}"));
			}
		}
	}
	assert!(wrong.is_empty(), "{} of the cases differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// One of the real bash's own races that a live row's run of it can show,
/// known by its mark in bash's output where the row's golden has none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BashRace {
	/// The child reached its error before the parent's `kill`: no `Killed`
	/// notice.
	LostKill,
	/// The child reached its error before the parent's `kill` took it: its
	/// `command not found` line, where the golden has none, and then its
	/// `Killed` notice.
	LateKill,
	/// bash reaped the killed job only after `wait` returned: its `w=` line
	/// comes before its `Killed` notice.
	LateReap,
	/// The child reached its error before the parent's `kill -STOP`: its
	/// `command not found` line comes before its `Stopped` line, or no
	/// `Stopped` line comes.
	LostStop,
	/// The child traced under `set -x` before the parent's `kill` took it: a
	/// trace line the golden lacks, and then its `Killed` notice.
	LateTrace,
}

impl BashRace {
	/// The race `out`, a run of the real bash, shows where `want`, the row's
	/// golden, shows none; `None` when it shows none.
	fn in_run(want: &str, out: &[u8]) -> Option<Self> {
		fn first(text: &str, mark: fn(&str) -> bool) -> Option<usize> {
			text.lines().position(mark)
		}
		fn killed(line: &str) -> bool {
			line.contains("Killed")
		}
		fn waited(line: &str) -> bool {
			line.starts_with("w=")
		}
		fn stopped(line: &str) -> bool {
			line.contains("Stopped")
		}
		fn not_found(line: &str) -> bool {
			line.contains("command not found")
		}
		fn traced(line: &str) -> bool {
			line.starts_with('+')
		}
		let text = String::from_utf8_lossy(out);
		if let Some(notice) = first(want, killed) {
			let Some(theirs) = first(&text, killed) else {
				return Some(Self::LostKill);
			};
			if first(want, not_found).is_none() && first(&text, not_found).is_some() {
				return Some(Self::LateKill);
			}
			if text
				.lines()
				.any(|line| traced(line) && !want.lines().any(|wanted| wanted == line))
			{
				return Some(Self::LateTrace);
			}
			let after = first(want, waited).is_none_or(|w| w > notice);
			if after && first(&text, waited).is_some_and(|w| w < theirs) {
				return Some(Self::LateReap);
			}
		}
		if let Some(stop) = first(want, stopped) {
			let theirs = first(&text, stopped);
			let after = first(want, not_found).is_none_or(|e| e > stop);
			if after && first(&text, not_found).is_some_and(|e| theirs.is_none_or(|s| e < s)) {
				return Some(Self::LostStop);
			}
		}
		None
	}

	/// What bash's output showed.
	const fn what(self) -> &'static str {
		match self {
			Self::LostKill => "no `Killed` notice: its child reached its error before the kill",
			Self::LateKill => {
				"its `command not found` line came with its `Killed` notice: its child reached its \
				 error before the kill took it"
			},
			Self::LateTrace => {
				"a trace line its golden lacks came with its `Killed` notice: its child traced before \
				 the kill took it"
			},
			Self::LateReap => "its `w=` line came before its `Killed` notice: it reaped the job late",
			Self::LostStop => {
				"its `command not found` line came before `Stopped`: its child reached its error \
				 before the stop"
			},
		}
	}
}

/// Run bash's side of a live row `run` until a run shows none of bash's own
/// races ([`BashRace`]) where the row's golden `want` shows none, at most 5
/// times, and give that run. The real bash loses the signal or the stop to
/// its child in some runs (the child reaches its error before the parent's
/// `kill`; seen once in 10 runs on runc, and up to 8 in 10 for a pipeline on
/// gVisor, google/gvisor#17983), its child prints its error before the kill
/// takes it (seen on runc), its child traces under `set -x` before the kill
/// takes it (seen on runc and gVisor), and it reaps a killed job before or
/// after `wait` returns (its notice before or after the `w=` line; seen on
/// runc); a row compares what bash prints once none of that happened. A bash
/// that shows a race in all 5 runs fails the test, naming the race: a row
/// never passes without a run of bash it compared. obash's side runs once and
/// must equal its golden: its job takes a held signal before it acts, in
/// every run.
fn bash_without_its_races(run: &Run, want: &str) -> Outcome {
	let mut races = Vec::new();
	let mut last = String::new();
	for _ in 0..5 {
		let theirs = run.go();
		let Some(race) = BashRace::in_run(want, &theirs.stdout) else {
			return theirs;
		};
		races.push(format!("{race:?} ({})", race.what()));
		last = String::from_utf8_lossy(&theirs.stdout).into_owned();
	}
	panic!(
		"the real bash showed one of its own races in all 5 runs, so the row compared none: {}\n  \
		 want: {want:?}\n  bash's last run: {last:?}",
		races.join("; ")
	);
}

/// A job `kill` named before obash spawned its program keeps its notice, and
/// the program's pid in it, across the shell's own snapshot and restore: the
/// fault injector's `step` and `exec` modes externalize and restore the shell
/// as a host does, here at every op (`PI_SHELL_FAULT=SEED:1`), a snapshot
/// that would lose a program in flight retried until none is
/// (`PI_SHELL_FAULT_LOST=defer`). What the notice rests on is stored: the
/// job's end and signal (its facts), its program's pid (`Job::os_pid`) and
/// the pid decisions still pending (the frames image's bangs). The sleep
/// after the kill closes the reap race with few ops to restore.
#[test]
fn a_killed_jobs_notice_survives_a_restore() {
	let killed = String::from_utf8(long_notice(2, libc::SIGKILL, b"/bin/sleep 30")).expect("ASCII");
	let want = (format!("{killed}next\n"), Some(Exit(0)));
	let mut wrong = Vec::new();
	for body in [
		"set -m; /bin/sleep 30 & kill -STOP %1; /bin/sleep 0.3; kill -KILL %1; /bin/sleep 0.5",
		"/bin/sleep 30 & kill -KILL %1; /bin/sleep 0.5",
	] {
		let script = format!("exec 2>&1; {body}\necho next");
		for seed in 1..=3 {
			for mode in ["step", "exec"] {
				let ours = Run::script(env!("CARGO_BIN_EXE_obash"), "bash", &script)
					.own_group()
					.env("PI_SHELL_FAULT", format!("{seed}:1"))
					.env("PI_SHELL_FAULT_MODE", mode)
					.env("PI_SHELL_FAULT_LOST", "defer")
					.go();
				let run = format!("{mode}, seed {seed}: {script:?}");
				let got = (String::from_utf8_lossy(&mask_pids(&ours.stdout)).into_owned(), ours.end());
				if got != want {
					wrong.push(format!("{run}\n  got:  {got:?}\n  want: {want:?}"));
				}
				names_a_program_pid(&mut wrong, &run, &ours.stdout);
			}
		}
	}
	assert!(wrong.is_empty(), "{} of the runs differ:\n{}", wrong.len(), wrong.join("\n"));
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

/// `out` with the pid of each `jobs -l` line (`[N]±`, a space, then the pid
/// as `%5ld`, `pretty_print_job`) replaced by `PID`, as [`mask_pids`] does
/// for a notice's: `[1]+ PID Exit 137 …`. The pid's field is checked to be
/// `%5ld`. A line whose text there starts with no digit (`jobs` without
/// `-l`) is kept as it is.
fn mask_job_pids(out: &[u8]) -> Vec<u8> {
	let mut masked = Vec::with_capacity(out.len());
	for line in out.split_inclusive(|&b| b == b'\n') {
		// After `[N]`, its mark and a space.
		let at = line
			.strip_prefix(b"[")
			.and_then(|rest| rest.iter().position(|&b| b == b']'))
			.map(|i| i + 4)
			.filter(|&at| at <= line.len());
		let Some(at) = at else {
			masked.extend_from_slice(line);
			continue;
		};
		let spaces = line[at..].iter().take_while(|&&b| b == b' ').count();
		let digits = line[at + spaces..]
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
		masked.extend_from_slice(&line[..at]);
		masked.extend_from_slice(b"PID");
		masked.extend_from_slice(&line[at + spaces + digits..]);
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

/// How bash 5.3 shows a job's end in `jobs`, `jobs -l`, the notice at the
/// next line and `wait`: as each process of the job ended (`WIFEXITED` or
/// `WIFSIGNALED` of its status, `printable_job_status`), never a status
/// above 128 read as a signal: an exit with 137 is `Exit 137`, a `KILL`
/// `Killed`. `jobs` shows how the job's last process ended
/// (`print_pipeline`'s `last`, under `pipefail` too); `jobs -l` prints a
/// line for each process (`JLIST_LONG`: its pid, how it shows, nothing where
/// it is as the first one, `| ` and its command; `Running` for each process
/// of a running job, one `STOP` stopped too, as bash without job control
/// never learns of stops); `jobs -p` prints the first process's pid (the
/// job's `pipe->pid`); `wait` of the pid of any process of a job waits for
/// the job and returns its status (`find_pipeline`, `job_exit_status`).
/// Each row runs as a `-c` string and as a script file ([`job_end_rows`])
/// and waits for its job with builtins only (`W`: until `jobs -r` lists no
/// job, at most 2,000,000 passes, then exit 97; `GOT`: until the first
/// process wrote its pid). Checked-in goldens measured with bash 5.3.20 in
/// both forms, on runc and gVisor, as uid 1000 and root, all the same; the
/// stopped pipeline's row was measured without its `: "$!"` (which waits
/// for the job's pid before the `STOP`), `GOT` without its bound. bash
/// 5.2.21 pads each status to 24 columns; in a `-c` string it has forgotten
/// a job that exited by the line `wait %1` is on (`wait: %1: no such job`,
/// status 127: the rows of an exit with 137, with 1 and of a pipeline), and
/// in both forms one `TERM` ended. The rows of a job killed before its
/// stages started (`KILLED`) count the different pids of its notice and of
/// its `jobs -l` with `awk`; they were not measured as written: the notice
/// is the one measured for the same job in
/// [`bash_reports_a_pipeline_job_killed_by_a_signal`].
#[test]
fn bash_shows_how_each_job_ended() {
	use stage::{E0, E3, T};
	const W: &str = "n=0; while jobs -r >\"$F\"; [ -s \"$F\" ]; do n=$((n + 1)); [ $n -lt 2000000 \
	                 ] || exit 97; done";
	const GOT: &str = "n=0; until [ -s \"$F.first\" ]; do n=$((n + 1)); [ $n -lt 2000000 ] || exit \
	                   97; done; read f < \"$F.first\"";
	// A first stage that writes its pid into `$F.first`, then runs the rest.
	const FIRST: &str = "/bin/sh -c 'echo $$ > \"$F.first\"; ";
	const P: &str = "jobs -p >\"$F.p\"; read p < \"$F.p\"";
	const WHICH: &str =
		"[ \"$p\" = \"$f\" ] && echo first || { [ \"$p\" = \"$!\" ] && echo last || echo other; }";
	const STOP: &str = ": \"$!\"; kill -STOP %1; /bin/sleep 0.3";
	const E1: &str = "/bin/sh -c 'exit 1'";
	const E137: &str = "/bin/sh -c 'exit 137'";
	const K9: &str = "/bin/sh -c 'kill -9 $$'";
	const R137: &str = "/bin/sh -c 'read x; exit 137'";
	const PIPE: &str = "/bin/sleep 3 | /bin/sleep 3 &";
	// A pipeline job this shell's `kill` ended before its vproc started the
	// stages, and the number of different pids in the notice `wait` wrote
	// into `$F.e` (the first line's fourth field, each other line's first)
	// and in the `jobs -l` lines in `$F.l` (the first line's second field).
	const KILLED: &str = "/bin/sleep 5 | /bin/sleep 6 & kill -KILL %1";
	const PIDS_E: &str =
		"awk '{ p = NR == 1 ? $4 : $1; if (!(p in s)) n++; s[p] } END { print n + 0 }' \"$F.e\"";
	const PIDS_L: &str =
		"awk '{ p = NR == 1 ? $2 : $1; if (!(p in s)) n++; s[p] } END { print n + 0 }' \"$F.l\"";
	let killed = desc(libc::SIGKILL);
	let killed = killed.as_str();
	let terminated = desc(libc::SIGTERM);
	// `jobs`' line of job 1; `jobs -l`'s, its pid masked ([`mask_job_pids`]);
	// that of each further process with no status, where it is as the first
	// ([`mask_stage_pids`]).
	let line = |status: &str, text: &str| format!("[1]+  {status:<27}{text}\n");
	let long = |status: &str, text: &str| format!("[1]+ PID {status:<27}{text}\n");
	let next = |text: &str| format!("     PID {:<25}| {text}\n", "");
	let running =
		[long("Running", "/bin/sleep 3"), next("/bin/sleep 3 &"), line("Running", PIPE)].concat();
	// The first process writes its pid; the last ends with 5.
	let stages = format!("{FIRST}exit 3' | /bin/sh -c 'exit 5' & {GOT}");
	let none = String::new;
	let rows: Vec<(String, String, String)> = vec![
		// An external that exits with 137 or 1, or that `KILL` or `TERM` ends.
		(format!("{E137} & {W}; jobs; echo st=$?"), line("Exit 137", E137) + "st=0\n", none()),
		(format!("{E137} & {W}; jobs -l"), long("Exit 137", E137), none()),
		(format!("{E137} & {W}\n:\nwait %1; echo st=$?"), "st=137\n".into(), none()),
		(format!("{E1} & {W}; jobs; jobs -l"), line("Exit 1", E1), none()),
		(format!("{E1} & {W}\n:\nwait %1; echo st=$?"), "st=1\n".into(), none()),
		(format!("{K9} & {W}; jobs; jobs -l"), line(killed, K9), none()),
		(
			format!("{K9} & {W}\n:\nwait %1; echo st=$?"),
			"st=127\n".into(),
			format!("NAME: line 2: PID {killed:<27}{K9}\nNAME: line 3: wait: %1: no such job\n"),
		),
		(format!("{T} & {W}; jobs; jobs -l"), line(terminated.as_str(), T), none()),
		(format!("{T} & {W}\n:\nwait %1; echo st=$?"), "st=143\n".into(), none()),
		// A pipeline: how its last process ended, under `pipefail` too.
		(
			format!("echo a | {R137} & {W}; jobs; jobs -l"),
			line("Exit 137", &format!("echo a | {R137}")),
			none(),
		),
		(format!("echo a | {R137} & {W}\n:\nwait %1; echo st=$?"), "st=137\n".into(), none()),
		(format!("{K9} | {E0} & {W}; jobs; jobs -l"), line("Done", &format!("{K9} | {E0}")), none()),
		(
			format!("set -o pipefail; {K9} | {E0} & {W}; jobs; jobs -l\n:\nwait %1; echo st=$?"),
			line("Done", &format!("{K9} | {E0}")) + "st=127\n",
			"NAME: line 3: wait: %1: no such job\n".into(),
		),
		// Two processes that ended the same way; posix mode; the directory.
		(format!("{E3} | {E3} & {W}; jobs -l"), long("Exit 3", E3) + &next(E3), none()),
		(
			format!("set -o posix; {E3} & {W}; jobs; {E137} & {W}; jobs; jobs -l"),
			line("Done(3)", E3) + &line("Done(137)", E137),
			none(),
		),
		(
			format!("cd /; {E3} | {E137} & cd /tmp; {W}; jobs; jobs -l"),
			line("Exit 137", &format!("{E3} | {E137}  (wd: /)")),
			none(),
		),
		// A running pipeline, one `STOP` stopped, and one of groups.
		(format!("{PIPE} jobs -l; jobs; kill %1; wait"), running.clone(), none()),
		(format!("{PIPE} {STOP}; jobs -l; jobs; kill -CONT %1; kill %1; wait"), running, none()),
		(
			"{ /bin/sleep 3; } | { /bin/sleep 3; } & jobs -l; kill %1; wait".into(),
			long("Running", "{ /bin/sleep 3; }") + &next("{ /bin/sleep 3; } &"),
			none(),
		),
		// `wait` keeps the job `$!` names; a group's job.
		(
			format!("{E137} & {W}; wait; echo st=$?; jobs"),
			"st=0\n".to_owned() + &line("Exit 137", E137),
			none(),
		),
		(
			format!("{K9} & {W}; wait; echo st=$?; jobs"),
			"st=0\n".to_owned() + &line(killed, K9),
			none(),
		),
		(format!("{{ exit 137; }} & {W}; jobs; jobs -l"), line("Exit 137", "{ exit 137; }"), none()),
		(
			format!("{{ kill -9 $BASHPID; }} & {W}; jobs; jobs -l"),
			line(killed, "{ kill -9 $BASHPID; }"),
			none(),
		),
		// `jobs -p` names the first process; `wait` of its pid, the job.
		(
			format!("{FIRST}exec /bin/sleep 3' | /bin/sleep 3 & {GOT}; {P}; {WHICH}; kill %1; wait"),
			"first\n".into(),
			none(),
		),
		(
			format!("{stages}; wait $f; echo st=$?; wait $!; echo st2=$?"),
			"st=5\nst2=5\n".into(),
			none(),
		),
		(
			format!("{stages}; {W}; wait $f; echo st=$?; wait $!; echo st2=$?"),
			"st=5\nst2=5\n".into(),
			none(),
		),
		// Each process of a job killed before its stages started has a pid of
		// its own (bash forks each as it starts the job): in the notice and in
		// `jobs -l`. Standard error goes to a file or nowhere: bash writes the
		// notice from `wait`, or at the next line it reads when it reaped the
		// job before, and one `jobs -l` listed before bash reaped it later.
		(format!("exec 2>\"$F.e\"; {KILLED}; wait\n:\n{PIDS_E}"), "2\n".into(), none()),
		(
			format!("exec 2>/dev/null; {KILLED}; jobs -l >\"$F.l\"; {PIDS_L}; wait"),
			"2\n".into(),
			none(),
		),
	];
	let mut wrong = Vec::new();
	job_end_rows(&rows, &mut wrong);
	assert!(wrong.is_empty(), "{} of the cases differ:\n{}", wrong.len(), wrong.join("\n"));
}

/// Each `(script, stdout, stderr)` of `rows`, run by bash as a `-c` string
/// and as a script file (`bash FILE`), each run in a directory of its own
/// where `$F` names a scratch file and in a process group of its own (a
/// stopped process of a row is then never in an orphaned group: gVisor
/// sends `HUP` to such a group, the test's too, whenever one of its
/// processes ends): what obash printed on each stream, its pids masked
/// ([`mask_pids`], [`mask_job_pids`], [`mask_stage_pids`]) and each
/// diagnostic's name (`bash`, or the file) as `NAME` ([`mask_names`]), and
/// how it ended, against the checked-in golden and a clean exit. A wrong row
/// goes into `wrong`, and so does a shell still running after
/// [`EVENT_LIMIT`]. With a live bash 5.3 or later ([`real_bash_golden`]) its
/// output, masked so and with the current and previous job marks blanked
/// ([`unmark_jobs`]), must equal obash's, blanked so.
fn job_end_rows(rows: &[(String, String, String)], wrong: &mut Vec<String>) {
	let mask = |b: &[u8]| {
		let masked = mask_names(&mask_stage_pids(&mask_job_pids(&mask_pids(b))));
		String::from_utf8_lossy(&masked).into_owned()
	};
	let masked = |o: Outcome| (mask(&o.stdout), mask(&o.stderr), o.end());
	let run = |program: &OsStr, file: bool, script: &str| {
		let dir = tempfile::tempdir().expect("a directory for the row");
		let cmd = if file {
			let path = dir.path().join("s.sh");
			fs::write(&path, format!("{script}\n")).expect("write the script");
			Run::new(program, "bash", &[&path])
		} else {
			Run::script(program, "bash", script)
		};
		let spawned = cmd.env("F", dir.path().join("f")).own_group().spawn();
		let ended = spawned.ended_within(EVENT_LIMIT);
		ended.map(masked).map_err(masked)
	};
	let bash = real_bash_golden();
	for (script, stdout, stderr) in rows {
		for file in [false, true] {
			let form = if file { "file" } else { "-c" };
			let ours = match run(OsStr::new(env!("CARGO_BIN_EXE_obash")), file, script) {
				Ok(ours) => ours,
				Err(killed) => {
					wrong.push(format!(
						"{form} {script:?}\n  still running after {EVENT_LIMIT:?}: {killed:?}"
					));
					continue;
				},
			};
			if (&ours.0, &ours.1, ours.2) != (stdout, stderr, Some(Exit(0))) {
				let want = (stdout, stderr);
				wrong.push(format!("{form} {script:?}\n  got:  {ours:?}\n  want: {want:?}"));
			}
			if let Some(bash) = &bash {
				let theirs = run(bash.as_os_str(), file, script).unwrap_or_else(|killed| {
					panic!("{form} {script:?}: bash still ran after {EVENT_LIMIT:?}: {killed:?}")
				});
				let unmarked = |o: &(String, String, _)| (unmark_jobs(&o.0), unmark_jobs(&o.1), o.2);
				assert_eq!(unmarked(&ours), unmarked(&theirs), "{form} {script:?}");
			}
		}
	}
}

/// `out` with the current or previous job's mark of each job line (`[N]+`,
/// `[N]-`) as a blank (`[N] `). bash 5.3.20 on gVisor listed some finished
/// jobs without their `+` (`[1]   Exit 137`), in other rows on each run;
/// on runc, and in the goldens, they have it. Only for comparing obash with
/// a live bash.
fn unmark_jobs(out: &str) -> String {
	out.split_inclusive('\n')
		.map(|line| {
			let at = line.strip_prefix('[').and_then(|rest| {
				let close = rest.find(']')?;
				rest[..close]
					.bytes()
					.all(|b| b.is_ascii_digit())
					.then_some(close + 2)
			});
			match at {
				Some(at) if matches!(line.as_bytes().get(at), Some(b'+' | b'-')) => {
					format!("{} {}", &line[..at], &line[at + 1..])
				},
				_ => line.to_owned(),
			}
		})
		.collect()
}

/// An interactive bash reports its foreground job that a signal killed, a
/// command, a pipeline or the job `fg` resumed (`notify_of_job_status` for
/// a foreground job): after `INT` a newline before its next prompt; after
/// another signal but `PIPE`, `print_pipeline` with `JLIST_STANDARD`: how
/// its last process ended (`j_strsignal`) padded to 27 columns, then its
/// command (the job's, without ` &`; a pipeline's processes' joined by
/// ` | `), with `(core dumped) ` before it where the process dumped a core,
/// which no row here does. A job that exits with 130 died of no signal and
/// gets nothing (bash reads how the job ended, `WIFSIGNALED`, not its
/// status). The job `fg` resumes loops until the file `$F` exists, which
/// the test makes once the screen shows `fg`'s line of the job's command;
/// the rows from the command's line to the next prompt are compared, on a
/// screen wide enough that no row wraps. The `fg` rows of an exit with 130
/// and of `INT` were recorded by hand with bash 5.3.20 and 5.2.21, the
/// same, and the `fg` row of `KILL` with bash 5.3.20 in a builds Job; the
/// others follow bash 5.3's `jobs.c`. All are compared live with a bash 5.3
/// or later ([`real_bash_golden`]).
#[test]
fn an_interactive_bash_reports_a_foreground_job_a_signal_killed() -> io::Result<()> {
	let killed = desc(libc::SIGKILL);
	let terminated = desc(libc::SIGTERM);
	// How the job `fg` resumes ends, or a command run in the foreground
	// (`fg` false), and the row bash writes for it, if any: a pipeline's is
	// how its last process ended.
	let cases = [
		("exit 130", true, None),
		("kill -INT $$", true, Some("")),
		("kill -KILL $$", true, Some(killed.as_str())),
		("kill -TERM $$", true, Some(terminated.as_str())),
		("/bin/sh -c 'kill -KILL $$'", false, Some(killed.as_str())),
		("/bin/sh -c 'kill -TERM $$'", false, Some(terminated.as_str())),
		("/bin/sh -c 'exit 0' | /bin/sh -c 'kill -KILL $$'", false, Some(killed.as_str())),
	];
	for (end, fg, shown) in cases {
		let ours = Spawn::obash_as("bash");
		let real = real_bash_golden().map(|bash| Spawn::new(bash).argv0("bash"));
		let shells =
			std::iter::once(("obash", ours)).chain(real.map(|spawn| ("the real shell", spawn)));
		for (who, spawn) in shells {
			let dir = tempfile::tempdir()?;
			let file = dir.path().join("F");
			let mut shell = spawn
				.size(50, 200)
				.args(["--norc", "--noprofile", "-i"])
				.env("F", &file)
				.env("PS1", "P$ ")
				.spawn()?;
			// The rows a prompt starts.
			let prompts = |screen: &str| screen.lines().filter(|row| row.starts_with("P$")).count();
			shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 1)?;
			let (typed, job) = if fg {
				let job = format!("/bin/sh -c 'until [ -e \"$F\" ]; do /bin/sleep 0.01; done; {end}'");
				shell.write(format!("{job} &\r"))?;
				shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 2)?;
				shell.write("fg\r")?;
				shell.wait_screen(TIMEOUT, |s| s.contents().ends_with(&job))?;
				fs::write(&file, "")?;
				(String::from("P$ fg"), Some(job))
			} else {
				shell.write(format!("{end}\r"))?;
				(format!("P$ {end}"), None)
			};
			let after = if fg { 3 } else { 2 };
			shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == after)?;
			let screen = shell.screen().contents();
			let rows: Vec<&str> = screen
				.lines()
				.skip_while(|row| *row != typed)
				.skip(1)
				.collect();
			// No row, a blank row (`INT`), or the description and the command.
			let cmd = job.as_deref().unwrap_or(end);
			let line = shown.map(|desc| {
				if desc.is_empty() {
					String::new()
				} else {
					format!("{desc:<27}{cmd}")
				}
			});
			let want: Vec<&str> = job
				.as_deref()
				.into_iter()
				.chain(line.as_deref())
				.chain(["P$"])
				.collect();
			assert_eq!(rows, want, "{who}: {end}, fg {fg}: {:?}", shell.output());
		}
	}
	Ok(())
}

/// A command line that runs `cmd`, then `jobs -l` into `file` until the list
/// has `want.0` lines with `Running` and `want.1` with `stop` (a stop's
/// description), at most 100 times 50 ms apart: a shell learns of a stop or
/// a continue as it reaps the change, which can come after its next
/// command (bash 5.3.20 on gVisor under load, once in 10 runs, after half a
/// second).
fn settled_jobs_l(cmd: &str, file: &str, want: (u32, u32), stop: &str) -> String {
	let (running, stopped) = want;
	let state = format!("\"$(grep -c Running {file}) $(grep -c '{stop}' {file})\"");
	let until = format!("n=0; until jobs -l >{file}; [ {state} = '{running} {stopped}' ]");
	format!("{cmd}; {until} || [ $n -ge 100 ]; do n=$((n + 1)); /bin/sleep 0.05; done")
}

/// With job control (an interactive bash), `jobs -l` shows each process of
/// a pipeline job as it is (`print_pipeline` with `JLIST_LONG`; `waitchld`
/// waits with `WUNTRACED` and `WCONTINUED`): once `kill -STOP` stopped its
/// first process by its pid (`jobs -p`), the job still runs, and so does
/// each line (`Running`; the second line shows it, as its state is not the
/// first's); once its last process stopped too, no process runs and the job
/// is stopped (`set_job_status_and_cleanup`): the first line shows the
/// signal's description and the second, stopped by it too, nothing; `kill
/// -CONT %1` runs the job again (`set_job_running`) and `kill -STOP %1`
/// stops the whole of it. Each `jobs -l` goes into a file once it shows the
/// step's state ([`settled_jobs_l`]), its pids masked ([`mask_job_pids`],
/// [`mask_stage_pids`]). The goldens follow bash 5.3's `jobs.c`, not
/// measured; compared live with a bash 5.3 or later ([`real_bash_golden`]).
#[test]
fn an_interactive_jobs_l_shows_each_process_of_a_job_as_it_is() -> io::Result<()> {
	let stopped = desc(libc::SIGSTOP);
	let first = |status: &str| format!("[1]+ PID {status:<27}/bin/sleep 30\n");
	// No status where the process is as the first one.
	let second = |status: &str, tail: &str| {
		let w = if status.is_empty() { 25 } else { 27 };
		format!("     PID {status:<w$}| /bin/sleep 30{tail}\n")
	};
	// Each step's command, the lines of its list with `Running` and with the
	// stop, and the list.
	let steps = [
		("kill -STOP $f", (2, 0), first("Running") + &second("Running", " &")),
		("kill -STOP $!", (0, 1), first(stopped.as_str()) + &second("", "")),
		("kill -CONT %1", (1, 0), first("Running") + &second("", " &")),
		("kill -STOP %1", (0, 1), first(stopped.as_str()) + &second("", "")),
	];
	let ours = Spawn::obash_as("bash");
	let real = real_bash_golden().map(|bash| Spawn::new(bash).argv0("bash"));
	let shells = std::iter::once(("obash", ours)).chain(real.map(|spawn| ("the real shell", spawn)));
	for (who, spawn) in shells {
		let dir = tempfile::tempdir()?;
		let mut shell = spawn
			.size(50, 120)
			.args(["--norc", "--noprofile", "-i"])
			.env("F", dir.path().join("F"))
			.env("PS1", "P$ ")
			.spawn()?;
		let prompts = |screen: &str| screen.lines().filter(|row| row.starts_with("P$")).count();
		let mut at = 1;
		shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == at)?;
		let mut run = |shell: &mut pty_support::Pty, line: &str| -> io::Result<()> {
			at += 1;
			shell.write(format!("{line}\r"))?;
			shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == at)
		};
		run(&mut shell, "/bin/sleep 30 | /bin/sleep 30 &")?;
		run(&mut shell, "jobs -p >\"$F.p\"; read f <\"$F.p\"")?;
		let mut lists = Vec::new();
		for (i, (kill, counts, _)) in steps.iter().enumerate() {
			run(&mut shell, &settled_jobs_l(kill, &format!("\"$F.{i}\""), *counts, &stopped))?;
			let list = fs::read(dir.path().join(format!("F.{i}")))?;
			lists.push(String::from_utf8_lossy(&mask_stage_pids(&mask_job_pids(&list))).into_owned());
		}
		run(&mut shell, "kill -KILL %1")?;
		let want: Vec<&str> = steps.iter().map(|(.., want)| want.as_str()).collect();
		assert_eq!(lists, want, "{who}: {:?}", shell.output());
	}
	Ok(())
}

/// A stop the terminal sends (`TSTP` to the foreground job's process group,
/// as `^Z` does) stops each process of a pipeline job that `fg` resumed,
/// a stage obash runs itself (`read x`, a builtin) too, as bash's process
/// for it stops with the group; `bg` runs each of them again
/// (`set_job_running`): `jobs -l` then shows the job running and its second
/// process as its first (nothing), once it shows the job running
/// ([`settled_jobs_l`]). Its pids masked ([`mask_job_pids`],
/// [`mask_stage_pids`]). The golden follows bash 5.3's `jobs.c`; bash
/// 5.3.20 printed it on runc in a builds Job, and it is compared live with
/// a bash 5.3 or later ([`real_bash_golden`]). The `^Z` is typed once the
/// job runs in the terminal's foreground group, so it stops the job only if
/// `fg` gave the job the terminal ([`pty_support::Pty::wait_job_running`]).
/// Where that group cannot be read (gVisor answers `TIOCGPGRP` on the
/// master with `ENOTTY`), the test sends the `TSTP` to the job's group
/// itself ([`pty_support::Pty::signal_job`]), which does not check that.
#[test]
fn an_interactive_bg_runs_each_process_of_a_stopped_job_again() -> io::Result<()> {
	let want = format!("[1]+ PID {:<27}/bin/sleep 30\n     PID {:<25}| read x &\n", "Running", "");
	let stopped = desc(libc::SIGSTOP);
	let ours = Spawn::obash_as("bash");
	let real = real_bash_golden().map(|bash| Spawn::new(bash).argv0("bash"));
	let shells = std::iter::once(("obash", ours)).chain(real.map(|spawn| ("the real shell", spawn)));
	for (who, spawn) in shells {
		let dir = tempfile::tempdir()?;
		let mut shell = spawn
			.size(50, 120)
			.args(["--norc", "--noprofile", "-i"])
			.env("F", dir.path().join("F"))
			.env("PS1", "P$ ")
			.spawn()?;
		let prompts = |screen: &str| screen.lines().filter(|row| row.starts_with("P$")).count();
		shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 1)?;
		shell.write("/bin/sleep 30 | read x &\r")?;
		shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 2)?;
		shell.write("fg\r")?;
		shell.wait_screen(TIMEOUT, |s| s.contents().ends_with("/bin/sleep 30 | read x"))?;
		if shell.wait_job_running(&["sleep"], TIMEOUT)? {
			shell.write("\x1a")?;
		} else {
			shell.signal_job(&["sleep"], libc::SIGTSTP, TIMEOUT)?;
		}
		shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 3)?;
		shell.write("bg\r")?;
		shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 4)?;
		let list = settled_jobs_l(":", "\"$F\"", (1, 0), &stopped);
		shell.write(format!("{list}\r"))?;
		shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 5)?;
		let list = fs::read(dir.path().join("F"))?;
		let list = String::from_utf8_lossy(&mask_stage_pids(&mask_job_pids(&list))).into_owned();
		shell.write("kill -KILL %1\r")?;
		assert_eq!(list, want, "{who}: {:?}", shell.output());
	}
	Ok(())
}

/// A command-line `+m` leaves job control on in an interactive bash: it only
/// declines to force job control on, and an interactive shell takes the
/// terminal whatever the flag says (bash `initialize_job_control
/// (jobs_m_flag)`). So `$-` holds `m`, `fg` resumes a job, and the job `fg`
/// resumed that a `KILL` ended gets its row, as with `-i` alone
/// ([`an_interactive_bash_reports_a_foreground_job_a_signal_killed`]). bash
/// 5.3.20 and 5.2.21 do so on a pty; compared live with a bash 5.3 or later
/// ([`real_bash_golden`]).
#[test]
fn an_interactive_bash_with_plus_m_still_does_job_control() -> io::Result<()> {
	let killed = desc(libc::SIGKILL);
	let job = "/bin/sh -c 'until [ -e \"$F\" ]; do /bin/sleep 0.01; done; kill -KILL $$'";
	let ours = Spawn::obash_as("bash");
	let real = real_bash_golden().map(|bash| Spawn::new(bash).argv0("bash"));
	let shells = std::iter::once(("obash", ours)).chain(real.map(|spawn| ("the real shell", spawn)));
	for (who, spawn) in shells {
		let dir = tempfile::tempdir()?;
		let file = dir.path().join("F");
		let mut shell = spawn
			.size(50, 200)
			.args(["--norc", "--noprofile", "-i", "+m"])
			.env("F", &file)
			.env("PS1", "P$ ")
			.spawn()?;
		let prompts = |screen: &str| screen.lines().filter(|row| row.starts_with("P$")).count();
		shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 1)?;
		let check = "case $- in *m*) echo monitor on;; *) echo monitor off;; esac";
		shell.write(format!("{check}\r"))?;
		shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 2)?;
		shell.write(format!("{job} &\r"))?;
		shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 3)?;
		shell.write("fg\r")?;
		// Without job control `fg` fails at once, and the next prompt shows.
		shell.wait_screen(TIMEOUT, |s| {
			let screen = s.contents();
			screen.ends_with(job) || prompts(screen.as_str()) == 4
		})?;
		fs::write(&file, "")?;
		shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 4)?;
		let screen = shell.screen().contents();
		// The `n` rows after the row that shows `typed`.
		let after = |typed: &str, n: usize| {
			let rows = screen.lines().skip_while(|row| *row != typed).skip(1);
			rows.take(n).map(str::to_owned).collect::<Vec<_>>()
		};
		let got = (after(&format!("P$ {check}"), 1), after("P$ fg", 3));
		let fg_rows = vec![job.to_owned(), format!("{killed:<27}{job}"), String::from("P$")];
		let want = (vec![String::from("monitor on")], fg_rows);
		assert_eq!(got, want, "{who}: {:?}", shell.output());
	}
	Ok(())
}

/// A screen row as [`an_interactive_bash_announces_a_job_as_jobs_lists_it`]
/// compares it: a `^Z` the terminal echoed as a blank row, and a background
/// job's `[n] PID` line with its pid as `PID`.
fn job_row(row: &str) -> String {
	if row == "^Z" {
		return String::new();
	}
	match row.strip_prefix('[').and_then(|r| r.split_once("] ")) {
		Some((n, pid)) if !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()) => {
			format!("[{n}] PID")
		},
		_ => row.to_owned(),
	}
}

/// An interactive bash with job control announces a job that stopped, or
/// that ended in the background, before its next prompt as `jobs` lists it
/// (bash `notify_of_job_status`: `pretty_print_job` with `JLIST_STANDARD`,
/// a newline first for a stop): how the job ended, never read from its
/// status alone, so a job that exited with 137 is `Exit 137`, and only a
/// signal seen to end it is named (`Killed`). Five shells: `^Z` stops a
/// foreground program (typed once the job holds the terminal; where the
/// terminal's group cannot be read, the `TSTP` goes to the job's group,
/// [`pty_support::Pty::signal_job`]); a background program exits with 137
/// once the file `$F` exists; `kill -KILL` ends a background program; two
/// background programs end before the same prompt (each notice keeps the
/// job's mark, `[1]-` and `[2]+`); a job started in `$F.d` ends after
/// `cd ..` (`(wd: …)` after its command, then `(wd now: …)`). The next
/// command waits until `jobs -r` lists no job, so the notices come before
/// the prompt after it. The rows from the first command on are
/// compared ([`job_row`]) with the goldens, which follow bash 5.3's
/// `jobs.c`, and live with a bash 5.3 or later ([`real_bash_golden`]),
/// but for the two jobs' shell (its comment says why).
#[test]
fn an_interactive_bash_announces_a_job_as_jobs_lists_it() -> io::Result<()> {
	let wait = "while jobs -r >\"$F.r\"; [ -s \"$F.r\" ]; do /bin/sleep 0.01; done";
	let exits = "/bin/sh -c 'until [ -e \"$F\" ]; do /bin/sleep 0.01; done; exit 137'";
	let ends = "/bin/sh -c 'until [ -e \"$F\" ]; do /bin/sleep 0.01; done'";
	let exit3 = "/bin/sh -c 'until [ -e \"$F\" ]; do /bin/sleep 0.01; done; exit 3'";
	let line = |job: &str, status: &str, text: &str| format!("[{job}  {status:<27}{text}");
	let killed = desc(libc::SIGKILL);
	let stop = vec![String::new(), line("1]+", "Stopped", "/bin/sleep 30"), String::from("P$")];
	let exit = vec![
		String::from("[1] PID"),
		format!("P$ {wait}"),
		line("1]+", "Exit 137", exits),
		String::from("P$"),
	];
	let kill_next = format!("kill -KILL %1; {wait}");
	let kill = vec![
		String::from("[1] PID"),
		format!("P$ {kill_next}"),
		line("1]+", &killed, "/bin/sleep 30"),
		String::from("P$"),
	];
	let two = vec![
		String::from("[1] PID"),
		String::from("[2] PID"),
		format!("P$ {wait}"),
		line("1]-", "Done", ends),
		line("2]+", "Exit 3", exit3),
		String::from("P$"),
	];
	// `{D}`: the test's directory.
	let wd_next = format!("cd ..; {wait}");
	let wd = vec![
		String::from("[1] PID"),
		format!("P$ {wd_next}"),
		format!("{}  (wd: {{D}}/F.d)", line("1]+", "Done", ends)),
		String::from("(wd now: {D})"),
		String::from("P$"),
	];
	let exit_first = format!("{exits} &");
	let two_first = format!("{ends} & {exit3} &");
	let wd_first = format!("cd \"$F.d\"; {ends} &");
	// Each shell's first command, the next one (none after the stop), the
	// rows after the first command's, and whether a live bash is compared.
	let cases = [
		("/bin/sleep 30", None, stop, true),
		(exit_first.as_str(), Some(wait), exit, true),
		("/bin/sleep 30 &", Some(kill_next.as_str()), kill, true),
		// The two jobs end within milliseconds of each other, and bash reaps
		// each at a report point of its own, so it can report one before the
		// other has ended (`[2]+  Exit 3`, then `[1]+  Done` at the prompt).
		// Measured with bash 5.3.20: 2 of 6 runs on gVisor and 1 of 12 on
		// runc, as uid 1000 and root; a wait with builtins only does not avoid
		// it (4 of 6 on gVisor). So this shell is not compared live: obash
		// reports both at the prompt, as bash does once it reaped both (the
		// golden).
		(two_first.as_str(), Some(wait), two, false),
		(wd_first.as_str(), Some(wd_next.as_str()), wd, true),
	];
	for (first, next, want, live) in &cases {
		let ours = Spawn::obash_as("bash");
		let real = real_bash_golden()
			.filter(|_| *live)
			.map(|bash| Spawn::new(bash).argv0("bash"));
		let shells =
			std::iter::once(("obash", ours)).chain(real.map(|spawn| ("the real shell", spawn)));
		for (who, spawn) in shells {
			let dir = tempfile::tempdir()?;
			let file = dir.path().join("F");
			fs::create_dir(dir.path().join("F.d"))?;
			let d = dir.path().to_string_lossy().into_owned();
			let want: Vec<String> = want.iter().map(|row| row.replace("{D}", &d)).collect();
			let mut shell = spawn
				.size(50, 200)
				.args(["--norc", "--noprofile", "-i"])
				.env("F", &file)
				.env("PS1", "P$ ")
				.spawn()?;
			let prompts = |screen: &str| screen.lines().filter(|row| row.starts_with("P$")).count();
			shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 1)?;
			shell.write(format!("{first}\r"))?;
			let mut at = 2;
			if let Some(next) = next {
				shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 2)?;
				fs::write(&file, "")?;
				shell.write(format!("{next}\r"))?;
				at = 3;
			} else if shell.wait_job_running(&["sleep"], TIMEOUT)? {
				shell.write("\x1a")?;
			} else {
				shell.signal_job(&["sleep"], libc::SIGTSTP, TIMEOUT)?;
			}
			shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == at)?;
			let screen = shell.screen().contents();
			let typed = format!("P$ {first}");
			let rows: Vec<String> = screen
				.lines()
				.skip_while(|row| *row != typed)
				.skip(1)
				.map(job_row)
				.collect();
			shell.write("kill -KILL %1\r")?;
			assert_eq!(rows, want, "{who}: {first}: {:?}", shell.output());
		}
	}
	Ok(())
}

/// `^Z` for the foreground job running `/bin/sleep`: typed once the job holds
/// the terminal ([`pty_support::Pty::wait_job_running`]), else (where the
/// terminal's group cannot be read) `TSTP` to the job's group
/// ([`pty_support::Pty::signal_job`]).
fn ctrl_z(shell: &mut pty_support::Pty) -> io::Result<()> {
	if shell.wait_job_running(&["sleep"], TIMEOUT)? {
		shell.write("\x1a")
	} else {
		shell.signal_job(&["sleep"], libc::SIGTSTP, TIMEOUT)
	}
}

/// Two more notices of an interactive bash
/// ([`an_interactive_bash_announces_a_job_as_jobs_lists_it`]): the job `fg`
/// resumed, stopped again by `^Z` ([`ctrl_z`]), gets bash's stop line as
/// the first stop did (a blank row, then `[1]+  Stopped …`); under `set -b`
/// a background job's end is announced at once with bash's line (bash
/// writes it into the line being typed, obash on a row of its own, so only
/// the line is looked for). Compared with the goldens and live with a bash
/// 5.3 or later ([`real_bash_golden`]).
#[test]
fn an_interactive_bash_announces_a_stop_after_fg_and_an_end_under_set_b() -> io::Result<()> {
	let exits = "/bin/sh -c 'until [ -e \"$F\" ]; do /bin/sleep 0.01; done; exit 137'";
	let stopped = format!("[1]+  {:<27}/bin/sleep 30", "Stopped");
	let ended = format!("[1]+  {:<27}{exits}", "Exit 137");
	let spawns = || {
		let ours = Spawn::obash_as("bash");
		let real = real_bash_golden().map(|bash| Spawn::new(bash).argv0("bash"));
		std::iter::once(("obash", ours)).chain(real.map(|spawn| ("the real shell", spawn)))
	};
	for set_b in [false, true] {
		for (who, spawn) in spawns() {
			let dir = tempfile::tempdir()?;
			let file = dir.path().join("F");
			let mut shell = spawn
				.size(50, 200)
				.args(["--norc", "--noprofile", "-i"])
				.env("F", &file)
				.env("PS1", "P$ ")
				.spawn()?;
			let prompts = |screen: &str| screen.lines().filter(|row| row.starts_with("P$")).count();
			shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 1)?;
			if set_b {
				shell.write("set -b\r")?;
				shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 2)?;
				shell.write(format!("{exits} &\r"))?;
				shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 3)?;
				fs::write(&file, "")?;
				shell.wait_screen(TIMEOUT, |s| s.contents().contains(&ended))?;
				continue;
			}
			shell.write("/bin/sleep 30\r")?;
			ctrl_z(&mut shell)?;
			shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 2)?;
			shell.write("fg\r")?;
			ctrl_z(&mut shell)?;
			shell.wait_screen(TIMEOUT, |s| prompts(s.contents().as_str()) == 3)?;
			let screen = shell.screen().contents();
			let rows: Vec<String> = screen
				.lines()
				.skip_while(|row| *row != "P$ fg")
				.skip(1)
				.map(job_row)
				.collect();
			shell.write("kill -KILL %1\r")?;
			let want = ["/bin/sleep 30", "", stopped.as_str(), "P$"];
			assert_eq!(rows, want, "{who}: {:?}", shell.output());
		}
	}
	Ok(())
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
/// program here dumps no core either, so neither shell leaves one: on Linux
/// it runs with a core size limit of 1 byte (`prlimit`), as [`Run`] gives
/// what a run starts, since a pipe `core_pattern` (systemd-coredump,
/// apport) ignores a limit of 0; elsewhere no pipe `core_pattern` exists
/// and `ulimit -c 0` does. The control: `/bin/sh` killed by `SIGQUIT` with
/// the limit raised dumps a core here; where it does not (no core dump can
/// be seen, as under gVisor), the test says so.
#[test]
fn an_exec_d_programs_core_dump_signal_leaves_no_core_of_the_shell() {
	let program = if cfg!(target_os = "linux") {
		"exec prlimit --core=1 /bin/sh -c 'kill -QUIT $$'"
	} else {
		"exec /bin/sh -c 'ulimit -c 0; kill -QUIT $$'"
	};
	let args = ["-f", "-c", program];
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
///
/// Only for a command that traps an `INT`, or ignores it, or that the
/// signal does not reach: it is a loop around a forked `/bin/sleep`, so an
/// `INT` reaches the command's own `/bin/sh` while that `/bin/sh` waits
/// for a child of its own, and what it then does is that shell's
/// business. A bash there holds an `INT` that comes while it waits for
/// its foreground child and acts on it only if that child died of the
/// `INT` (`wait_sigint_handler` and `set_job_status_and_cleanup`, the
/// rule this file's bash cases are about): a polled `/bin/sleep 0.01`
/// that ends by itself in the moment the signal arrives leaves the whole
/// `INT` swallowed, and the command goes on and exits 0. Measured with
/// bash 5.2.21: a child that sends its parent an `INT` and exits 0 leaves
/// bash going on, and the same child killed by the `INT` leaves bash dead
/// of it. macOS's `/bin/sh` is a bash (Apple's 3.2); the ubuntu runners'
/// is dash, which takes an untrapped `INT` as the script's end whatever
/// the child it waits for did (`onsig`, then `onint`), so only the macOS
/// legs showed it: 10 of 40 runs at Cut18 (platform checks run
/// 46047970164), every failure a command that had to die of the signal.
/// The rule is `INT`'s alone: a `TERM` or `HUP` that the command's shell
/// does not trap ends it wherever it is.
const SENT: &str = "until [ -e \"$F.sent\" ]; do /bin/sleep 0.01; done";

/// A command that must die of the signal: it reads the FIFO
/// [`Run::go_signalled`] holds open until the signal is sent, so it
/// blocks at once, forks nothing, and can end by nothing but the signal
/// (an untrapped `INT` at its default kills it, wherever the signal finds
/// it: the `/bin/sh` before its `exec`, or this program after it). No
/// poll, so no child of its own whose end its shell could read as the
/// signal's answer ([`SENT`]), and no time bound to outlast the run.
const BLOCKS: &str = "/bin/cat \"$F.fifo\"";

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
	run_sent_raced(cases, &[]);
}

/// [`run_sent`], where the real shell may also print and end as `raced`
/// says for the case of that script (its own timing picks one); obash
/// prints and ends as the case says.
fn run_sent_raced(cases: Vec<SentCase>, raced: &[(String, &[u8], End)]) {
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
/// shell's group. The command makes `$F` once it has started, and each
/// shell is signalled only once it and all it runs have blocked
/// ([`Run::when_blocked`]); a command that must die of the `INT` blocks
/// on the run's FIFO and can end by nothing else ([`BLOCKS`]), and one
/// that catches or ignores it waits for the run to send it ([`SENT`]).
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
	// One that dies of `INT` (`cat` takes it at its default), with no shell
	// of its own between it and the signal and no end but the signal
	// ([`BLOCKS`]).
	let dies = BLOCKS;
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
	let pipeline =
		format!("trap 'echo x' EXIT; /bin/sh -c ': > \"$F.a\"; exec {BLOCKS}' | {last}; echo after");
	let raced = [(pipeline.clone(), &b"after\nx\n"[..], Exit(0))];
	let cases = vec![
		case(script.clone(), false, b"child-done\nafter\nx\n", Exit(0)),
		case(script, true, b"child-int\nchild-done\nafter\nx\n", Exit(0)),
		case(
			format!("trap 'echo x' EXIT; /bin/sh -c ': > \"$F\"; exec {BLOCKS}'; echo after"),
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
		case(format!("/bin/sh -c ': > \"$F\"; exec {BLOCKS}'; echo after"), true, b"", died),
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
				"( trap 'echo sub' EXIT; /bin/sh -c ': > \"$F\"; exec {BLOCKS}'; echo more ); echo \
				 after"
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
		// Under `set -m` the job's shell code is in a group of its own: a
		// `kill` of the shell's pid or group reaches only the shell, whose
		// trap runs once the job has ended. The job's code never blocks. (A
		// pipeline's external stage stays in obash's group, which a `kill` of
		// it reaches: obash makes a job's process group only with a terminal,
		// a known difference.)
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
	run_sent_raced(cases, &raced);
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
/// (the fork's architect ruled so on 2026-11-21): obash joins
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
