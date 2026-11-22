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
/// backquotes not), naming the command's line plus one plus the newlines
/// in the substitution's source, before the command's redirections; and
/// `jobs` reports at its end, through its own redirections. Nothing
/// reports while a trap runs that bash runs with the job list frozen
/// (`jobs_list_frozen`): a `CHLD` trap `wait` runs, an `INT` trap run as
/// the foreground command it waited for ends; `wait` reports after it. A
/// `wait` without operands drops a job that had ended unreported, `jobs`
/// reports it instead, and `INT`, `TERM`, `PIPE`, a signal the shell
/// traps, an exit (137 too), a posix `-c` shell, a command substitution
/// and a subshell print nothing. Each script starts with `exec 2>&1`:
/// where a notice comes in the output shows. A job is known to have ended
/// once `kill -0` fails on it ([`GONE`]): the shell has reaped it then.
/// [`KILLER`]'s job dies once the shell blocks, in `wait`.
#[test]
fn bash_reports_a_background_job_killed_by_a_signal() {
	/// Wait, in the foreground, for the shell to reap job `$!`.
	const GONE: &str = "while kill -0 $! 2>/dev/null; do /bin/sleep 0.01; done";
	const S: &str = "/bin/sleep 30 & kill -KILL $!";
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
		(format!("{S}; wait; echo st=$?"), format!("{}st=0\n", killed(1))),
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
		(format!("{S}\n{GONE}\necho next"), format!("{}next\n", killed(3))),
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
			 kill -0 $! 2>/dev/null; do /bin/sleep 0.01; done\necho next"
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
		(format!("{S}\ntrue\n{GONE}; x=$(echo in); echo \"$x\""), format!("{}in\n", killed(4))),
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
/// subshell and resets the others in every one.)
#[test]
fn a_zsh_subshell_unsets_its_traps_and_a_pipeline_stage_keeps_them() {
	let script = "zmodload zsh/system; trap '' TERM; trap 'print caught-usr2' USR2
( kill -TERM $sysparams[pid]; print not-reached ); print paren=$?
{ kill -USR2 $sysparams[pid]; print stage-alive } | cat; print stage=$pipestatus
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
			"paren=143\ncaught-usr2\nstage-alive\nstage=0 0\nbg=143\nsubst=143 \
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
/// `make_child`; obash `wait_starts`). Without, the shell runs shell code
/// that never blocks.
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
/// ([`Run::when_blocked`]).
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
	let run = if blocked { run.when_blocked() } else { run };
	run.go_signalled(&started, sig, group)
}

/// Run each case under obash and, where it exists, the real shell: both
/// print the same and end the same.
fn run_sent(cases: Vec<SentCase>) {
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
			assert_eq!(
				(&ours.stdout, ours.end()),
				(&theirs.stdout, theirs.end()),
				"{shown}: {theirs:?}"
			);
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
/// only once the run has sent the signal ([`SENT`]).
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
	run_sent(vec![
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
		// exists (the subshell makes it itself, once it has set up).
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
		case(
			format!(
				"trap 'echo x' EXIT; /bin/sh -c ': > \"$F.a\"; {SENT}; exec /bin/sleep 3' | {last}; \
				 echo after"
			),
			true,
			b"x\n",
			died,
		),
		// A stage of shell code dies of the `INT` at once (`… | while read`,
		// `while …; done | …`), and the command that caught it ends last; a
		// stage or a subshell that waits for that command goes on.
		case(
			format!("trap 'echo x' EXIT; {quiet} | while read l; do echo got $l; done; echo after"),
			true,
			b"after\nx\n",
			Exit(0),
		),
		// Busy shell code that never blocks (a loop that forked `sleep` lost the
		// signal when it came in bash's `make_child`, and ran on): no gate. The
		// stage makes `$F.b` once it has set up, and the command makes `$F`
		// once that exists.
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
		// A subshell whose EXIT trap the `INT` began, and whose process another
		// signal then ends (the trap `exec`s a program that dies of `TERM`, or
		// kills it with `KILL`), dies of that signal: its parent goes on. (A
		// `kill -TERM $BASHPID` in the trap gives bash 5.2.21 either end under
		// load.)
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
	]);
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
