//! `pi_shell::process` command-line behavior and interactive prompts,
//! with zsh parity checked against the real zsh ([`zsh_oracle`]) and bash
//! parity against the real bash ([`process_support::real_bash`]).

#![cfg(unix)]

mod process_support;
mod pty_support;
mod zsh_oracle;

use std::{
	ffi::{OsStr, OsString},
	fs, io,
	os::unix::{
		ffi::OsStringExt,
		process::{CommandExt, ExitStatusExt},
	},
	path::Path,
	process::Command,
};

use process_support::{
	End::{self, Exit, Signal},
	Outcome, Run, have_zsh, real, real_bash,
};
use pty_support::{Spawn, TIMEOUT};

#[test]
fn interactive_bash_and_sh_show_a_prompt_before_and_after_commands() -> io::Result<()> {
	let prompted = |screen: &pty_support::Screen| {
		let text = screen.contents();
		text.ends_with('$') || text.ends_with('#')
	};
	for name in ["bash", "sh"] {
		let mut shell = Spawn::obash_as(name)
			.args(["--noprofile", "--norc"])
			.spawn()?;
		shell.wait_screen(TIMEOUT, prompted)?;
		shell.write("echo $((6 * 7))\r")?;
		shell.read_until("\r\n42\r\n", TIMEOUT)?;
		shell.wait_screen(TIMEOUT, prompted)?;
		shell.write("exit\r")?;
		assert_eq!(shell.wait(TIMEOUT)?.code(), Some(0));
	}
	Ok(())
}

#[test]
fn interactive_prompt_defaults_preserve_imported_values_and_stay_out_of_scripts() {
	for (interactive, prompt, expected) in [
		(true, Some("custom> "), "<custom> >\n"),
		(true, Some(""), "<>\n"),
		(false, None, "<unset>\n"),
	] {
		let mut command = Command::new(env!("CARGO_BIN_EXE_obash"));
		command
			.arg0("bash")
			.args(["--noprofile", "--norc"])
			.env_remove("ENV")
			.env_remove("BASH_ENV")
			.env_remove("PS1");
		if interactive {
			command.arg("-i");
		}
		if let Some(prompt) = prompt {
			command.env("PS1", prompt);
		}
		let out = command
			.args(["-c", "printf '<%s>\\n' \"${PS1-unset}\""])
			.output()
			.expect("start the shell");
		assert_eq!(out.status.code(), Some(0));
		assert_eq!(String::from_utf8_lossy(&out.stdout), expected);
	}
}

#[test]
fn help_is_zshs_in_each_emulation() {
	if !have_zsh() {
		return;
	}
	for args in [
		&["--help"][..],
		&["-f", "--help"],
		&["--emulate", "sh", "--help"],
		&["--emulate", "ksh", "--help"],
		&["-o", "shoptionletters", "--help"],
	] {
		let ours = Run::obash("zsh", args).go();
		assert_eq!(
			String::from_utf8_lossy(&ours.stdout),
			String::from_utf8_lossy(&Run::new(zsh_oracle::path(), "zsh", args).go().stdout),
			"{args:?}"
		);
		assert!(ours.stderr.is_empty(), "{args:?}: {}", String::from_utf8_lossy(&ours.stderr));
		assert_eq!(ours.code, Some(0));
	}
}

#[test]
fn version_names_zsh_59() {
	let ours = Run::obash("zsh", &["--version"]).go();
	let text = String::from_utf8_lossy(&ours.stdout);
	assert!(text.starts_with("zsh 5.9 (") && text.ends_with(")\n"), "{text}");
	assert_eq!(ours.code, Some(0));
}

#[test]
fn command_strings_and_exit_statuses_match_zsh() {
	if !have_zsh() {
		return;
	}
	for args in [
		&["-f", "-c", "echo $ZSH_NAME $0; print -l a b"][..],
		&["-f", "-c", "exit 3"],
		&["-f", "-c", "print -r -- $ZSH_EXECUTION_STRING"],
		&["-f", "-c", "exit 300"],
		&["-f", "-c", "yes | head -1"],
		&["-f", "--no-such-option"],
	] {
		assert_eq!(
			Run::obash("zsh", args).go(),
			Run::new(zsh_oracle::path(), "zsh", args).go(),
			"{args:?}"
		);
	}
}

/// The name and home directory of the user running the tests: their
/// password database entry, if they have one.
fn passwd_entry() -> Option<(String, String)> {
	// SAFETY: getpwuid returns a pointer into static storage (or null),
	// read before any other call can replace it.
	unsafe {
		let pw = libc::getpwuid(libc::getuid());
		if pw.is_null() {
			return None;
		}
		let text =
			|p: *const libc::c_char| std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned();
		Some((text((*pw).pw_name), text((*pw).pw_dir)))
	}
}

/// `script` run as `name` by `program` under `wrap` (a command and its
/// arguments, or none), with `USER=nobody-by-env` and neither `HOME` nor
/// `LOGNAME` set.
fn without_home(
	wrap: &[&'static str],
	program: impl AsRef<OsStr>,
	name: &'static str,
	script: &str,
) -> Outcome {
	Run::script(program, name, script)
		.under(wrap)
		.env("USER", "nobody-by-env")
		.env_remove("HOME")
		.env_remove("LOGNAME")
		.go()
}

const ZSH_USER: &str = "print -r -- \"[$USERNAME] [$HOME] [$(print ~)] [${(%):-%n}] [$LOGNAME]\"";
const BASH_USER: &str = "PS1='\\u'; echo \"[${PS1@P}] [${HOME-unset}] [$(echo ~)]\"";

/// zsh names the user (`USERNAME`, `%n`, `LOGNAME`) and sets the default
/// `HOME` from the password database, and bash names the user (`\u`) and
/// expands `~` from it without setting `HOME`; neither reads `USER`. Where
/// the uid running the tests has no entry, the case is reported
/// `UNCOMPARED:` (the next test checks that case under a user namespace).
#[test]
fn the_user_name_and_home_come_from_the_password_database() {
	let Some((name, home)) = passwd_entry() else {
		zsh_oracle::uncompared("the uid running the tests has no password database entry");
		return;
	};
	for (shell, script, want) in [
		("zsh", ZSH_USER, format!("[{name}] [{home}] [{home}] [{name}] [{name}]\n")),
		("bash", BASH_USER, format!("[{name}] [unset] [{home}]\n")),
	] {
		let ours = without_home(&[], env!("CARGO_BIN_EXE_obash"), shell, script);
		assert_eq!(
			(String::from_utf8_lossy(&ours.stdout).into_owned(), ours.code),
			(want, Some(0)),
			"{shell}: {}",
			String::from_utf8_lossy(&ours.stderr)
		);
		if let Some(real) = real(shell) {
			assert_eq!(ours, without_home(&[], real, shell, script));
		}
	}
}

/// A uid without a password database entry, under a user namespace that
/// maps one (`unshare --map-user`): zsh has an empty `USERNAME`, `%n` and
/// `LOGNAME` and `HOME=/`, bash says `I have no name!` for `\u` and `/` for
/// `~`, and neither takes `USER`. Where no such namespace can be made (no
/// `unshare`, or user namespaces refused), the test says so.
#[test]
fn a_uid_without_a_password_entry_has_each_shells_defaults() {
	let wrap = ["unshare", "--user", "--map-user=54321", "--map-group=54321"];
	let probe = Command::new(wrap[0]).args(&wrap[1..]).arg("true").output();
	if !probe.as_ref().is_ok_and(|out| out.status.success()) {
		zsh_oracle::uncompared(&format!(
			"no user namespace to map a uid without an entry: {probe:?}"
		));
		return;
	}
	for (shell, script, want) in [
		("zsh", ZSH_USER, "[] [/] [/] [] []\n"),
		("bash", BASH_USER, "[I have no name!] [unset] [/]\n"),
	] {
		let ours = without_home(&wrap, env!("CARGO_BIN_EXE_obash"), shell, script);
		assert_eq!(
			(String::from_utf8_lossy(&ours.stdout).into_owned(), ours.code),
			(want.to_owned(), Some(0)),
			"{shell}: {}",
			String::from_utf8_lossy(&ours.stderr)
		);
		if let Some(real) = real(shell) {
			assert_eq!(ours, without_home(&wrap, real, shell, script));
		}
	}
}

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
/// killed command) replaced by `PID`: each shell prints its own child's.
/// The pid's field is checked to be bash's `%5ld`: at least five columns,
/// padded with spaces on the left only up to five.
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
		assert!(
			digits > 0 && spaces + digits >= 5 && (spaces == 0 || spaces + digits == 5),
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

/// bash's long notice: `bash: line N: PID `, the description padded to 24
/// columns, the command.
fn long_notice(line: u32, desc: &str, text: &[u8]) -> Vec<u8> {
	let mut out = format!("bash: line {line}: PID {desc:<24}").into_bytes();
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
/// (`notify_of_job_status`), on its own standard error: `TERM`, or a signal
/// the shell traps (`trap ''` too), prints its description; `INT`, `PIPE`,
/// a command substitution and a posix shell print nothing; any other
/// signal prints `NAME: line N: `, the pid, the description padded to 24
/// columns and the command as bash prints it, here-documents and its bytes
/// as they are. `N` is bash's line when it waits: the end of the complete
/// command, a `for` header, a function body's first line. The last command
/// of the `-c` string bash runs with `exec` and no fork, so it prints
/// nothing and the shell's process dies of the signal; zsh does the same
/// (`last1`, which it passes on into the body of an `if`, a `{ }` and a
/// `;;` arm of a `case`, and which a trap with an action or a trap function
/// takes away, an empty trap not), and prints no notice anywhere.
#[test]
fn bash_reports_a_foreground_command_killed_by_a_signal() {
	const K: &[u8] = b"/bin/sh -c 'kill -KILL $$'";
	const KILLED: End = Signal(libc::SIGKILL);
	let cat = |parts: &[&[u8]]| parts.concat();
	let killed = |line| long_notice(line, "Killed", K);
	let case =
		|shell, script: Vec<u8>, stderr: Vec<u8>, end| NoticeCase { shell, script, stderr, end };
	let bash = |script, stderr, end| case("bash", script, stderr, end);
	let zsh = |script, end| case("zsh", script, Vec::new(), end);
	let cases: Vec<NoticeCase> = vec![
		bash(b"/bin/sh -c 'kill -TERM $$'; echo st=$?".to_vec(), b"Terminated\n".to_vec(), Exit(0)),
		bash(cat(&[K, b"; echo st=$?"]), killed(1), Exit(0)),
		bash(
			b"/bin/sh -c 'kill -QUIT $$'; echo st=$?".to_vec(),
			long_notice(1, "Quit", b"/bin/sh -c 'kill -QUIT $$'"),
			Exit(0),
		),
		bash(
			b"/bin/sh -c 'kill -USR1 $$'; echo st=$?".to_vec(),
			long_notice(1, "User defined signal 1", b"/bin/sh -c 'kill -USR1 $$'"),
			Exit(0),
		),
		bash(
			b"/bin/sh -c 'kill -INT $$'; /bin/sh -c 'kill -PIPE $$'; echo st=$?".to_vec(),
			Vec::new(),
			Exit(0),
		),
		bash(
			b"trap 'echo t' USR1; /bin/sh -c 'kill -USR1 $$'; echo st=$?".to_vec(),
			b"User defined signal 1\n".to_vec(),
			Exit(0),
		),
		bash(cat(&[b"trap '' KILL; ", K, b"; echo st=$?"]), b"Killed\n".to_vec(), Exit(0)),
		bash(cat(&[b"x=$(", K, b"); echo st=$?"]), Vec::new(), Exit(0)),
		bash(
			b"true\n/bin/sh   -c 'kill -HUP $$'   ; echo st=$?".to_vec(),
			long_notice(2, "Hangup", b"/bin/sh -c 'kill -HUP $$'"),
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
			long_notice(1, "Killed", &cat(&[K, b" 2> /dev/null"])),
			Exit(0),
		),
		bash(
			cat(&[K, b" 2>/dev/null"]),
			long_notice(1, "Killed", &cat(&[K, b" 2> /dev/null"])),
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
			long_notice(3, "Killed", &cat(&[K, b" <<EOF\nx\nEOF\n"])),
			Exit(0),
		),
		bash(
			cat(&[K, b" \xe9x; echo st=$?"]),
			long_notice(1, "Killed", &cat(&[K, b" \xe9x"])),
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
	];
	for NoticeCase { shell, script, stderr, end } in cases {
		let script = OsString::from_vec(script);
		let ours = Run::script(env!("CARGO_BIN_EXE_obash"), shell, &script).go();
		let shown = format!("{shell}: {script:?}");
		assert_eq!(
			(String::from_utf8_lossy(&mask_pids(&ours.stderr)), ours.end()),
			(String::from_utf8_lossy(&stderr), Some(end)),
			"{shown}"
		);
		if let Some(real) = real(shell) {
			assert_eq!(masked(&ours), masked(&Run::script(real, shell, &script).go()), "{shown}");
		}
	}
}

/// `o` with the pids and shell names of both streams masked ([`mask_pids`],
/// [`mask_names`]).
fn masked(o: &Outcome) -> Outcome {
	let mask = |b: &[u8]| mask_names(&mask_pids(b));
	Outcome { stdout: mask(&o.stdout), stderr: mask(&o.stderr), ..o.clone() }
}

/// A `/bin/sh` script, run as `sh -c SHELL_ONLY sh SIG PID [FILE]`: it
/// makes `FILE` (when given), sends `SIG` to the shell `PID` from outside
/// (`0`: none) and waits for that shell to end (to be gone or a zombie),
/// printing `shell-gone`, or `shell-waited` if it still runs after 500
/// looks: a shell that waits for this command before it acts on the
/// signal. It ignores `TERM` and `HUP`: obash ends the externals a
/// standalone shell leaves running when it exits
/// ([`a_standalone_exit_ends_running_background_externals`]), where bash
/// and zsh leave them. It has no single quote, so a script can quote it so.
const SHELL_ONLY: &str = "trap \"\" TERM HUP; [ -n \"$3\" ] && : > \"$3\"; kill -$1 $2; i=0; \
                          while [ $i -lt 500 ]; do case $(ps -o stat= -p $2 2>/dev/null | tr -d \
                          \" \") in \"\"|Z*) echo shell-gone; exit;; esac; sleep 0.01; \
                          i=$((i+1)); done; echo shell-waited";

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
			let theirs = Run::script(bash, "bash", script).go();
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
/// of it). A zsh trap removed for it gives it its default
/// (`removetrap`); bash keeps ignoring it.
#[test]
fn the_shell_ignores_quit_and_its_commands_get_it_at_its_default() {
	let cases = [
		("zsh", SignalCase {
			script: "/bin/kill -QUIT $$; kill -QUIT $$; print alive; /bin/sh -c 'kill -QUIT $$; echo \
			         child-alive'; print st=$?",
			stdout: b"alive\nst=131\n",
			end:    Exit(0),
		}),
		("zsh", SignalCase {
			script: "trap - QUIT; /bin/kill -QUIT $$; print not-reached",
			stdout: b"",
			end:    Signal(libc::SIGQUIT),
		}),
		("bash", SignalCase {
			script: "/bin/kill -QUIT $$; kill -QUIT $$; echo alive; /bin/sh -c 'kill -QUIT $$; echo \
			         child-alive'; echo st=$?; trap - QUIT; /bin/kill -QUIT $$; echo after-reset",
			stdout: b"alive\nst=131\nafter-reset\n",
			end:    Exit(0),
		}),
	];
	for (name, SignalCase { script, stdout, end }) in cases {
		let ours = Run::script(env!("CARGO_BIN_EXE_obash"), name, script).go();
		assert_eq!((ours.stdout.as_slice(), ours.end()), (stdout, Some(end)), "{name}: {script}");
		// bash also prints its notice of the `sh` that died of `QUIT`
		// ([`bash_reports_a_foreground_command_killed_by_a_signal`]).
		if let Some(real) = real(name) {
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
		"f=$(/bin/mktemp -u); trap 'print x $?; /bin/rm -f $f' EXIT; {{ while [[ ! -e $f ]]; do \
		 sleep 0.01; done; kill -HUP $$ }} & /bin/sh -c '{SHELL_ONLY}' sh 0 $$ $f; print not-reached"
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
	std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_obash"), &zsh).expect("link obash as zsh");
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

/// A standalone shell abandons the externals still running when it exits:
/// a background job without `nohup` gets `TERM` and is gone shortly after.
#[test]
fn a_standalone_exit_ends_running_background_externals() {
	let out = Command::new(env!("CARGO_BIN_EXE_obash"))
		.args(["-c", "/bin/sleep 31 >/dev/null 2>&1 </dev/null & echo $!"])
		.output()
		.expect("start obash");
	assert_eq!(out.status.code(), Some(0));
	let pid: libc::pid_t = String::from_utf8(out.stdout)
		.expect("utf-8 pid")
		.trim()
		.parse()
		.expect("the job's pid");
	let deadline = std::time::Instant::now() + TIMEOUT;
	// SAFETY: signal 0 only checks that the process exists.
	while unsafe { libc::kill(pid, 0) } == 0 {
		assert!(std::time::Instant::now() < deadline, "sleep {pid} still runs after obash exited");
		std::thread::sleep(std::time::Duration::from_millis(20));
	}
}

/// `$!` of a background pipeline is its last process's pid (zsh runs that
/// stage in the job's shell), as the process reports `$$` itself; it was
/// the shell's virtual pid, unknown to the system.
#[test]
fn a_background_pipelines_bang_is_its_last_process() {
	let script = "T=$(/bin/mktemp); /bin/sleep 0.1 | /bin/sh -c 'echo $$ >\"$1\"; exec /bin/sleep \
	              0.1' sh $T & p=$!; wait; [[ $p == $(<$T) ]] && print last; /bin/rm -f $T";
	let ours = Run::script(env!("CARGO_BIN_EXE_obash"), "zsh", script).go();
	assert_eq!(
		(ours.stdout.as_slice(), ours.stderr.as_slice(), ours.code),
		(&b"last\n"[..], &b""[..], Some(0))
	);
	if have_zsh() {
		assert_eq!(ours, Run::script(zsh_oracle::path(), "zsh", script).go());
	}
}

/// A signal case: `shell` runs `script` with `-c` and gets `sig` from
/// outside (`group`: sent to its process group, else to the shell alone)
/// once the command it waits for has made `$F`; it prints `stdout` and ends
/// by `end`.
struct SentCase {
	shell:  &'static str,
	script: String,
	sig:    libc::c_int,
	group:  bool,
	stdout: &'static [u8],
	end:    End,
}

/// Run each case under obash and, where it exists, the real shell: both
/// print the same and end the same.
fn run_sent(cases: Vec<SentCase>) {
	let dir = tempfile::tempdir().expect("a directory for the start file");
	let started = dir.path().join("started");
	for SentCase { shell, script, sig, group, stdout, end } in cases {
		let run = |program: &OsStr| {
			let _ = fs::remove_file(&started);
			let run = Run::script(program, shell, &script).env("F", &started);
			let run = if group { run.own_group() } else { run };
			run.go_signalled(&started, sig, group)
		};
		let ours = run(OsStr::new(env!("CARGO_BIN_EXE_obash")));
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
			let theirs = run(real.as_os_str());
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
/// shell traps (the program has no trap), and the shell ends as the program
/// does. zsh's `HUP` handler and bash's EXIT trap went with the shell: a
/// server the program runs goes on after a `HUP` it handles. The program
/// makes `$F` once it has started.
#[test]
fn a_signal_to_the_shell_reaches_the_program_it_runs_in_place() {
	let program = "/bin/sh -c ': > \"$F\"; exec /bin/sleep 5 >/dev/null 2>&1'";
	let server = "/bin/sh -c 'trap \"echo reload\" HUP; : > \"$F\"; /bin/sleep 1; echo done'";
	let case = |shell, script: String, sig, stdout, end| SentCase {
		shell,
		script,
		sig,
		group: false,
		stdout,
		end,
	};
	run_sent(vec![
		case("zsh", program.into(), libc::SIGHUP, b"", Signal(libc::SIGHUP)),
		case("zsh", format!("exec {program}"), libc::SIGHUP, b"", Signal(libc::SIGHUP)),
		case("zsh", format!("true; {program}"), libc::SIGHUP, b"", Signal(libc::SIGHUP)),
		case("zsh", server.into(), libc::SIGHUP, b"reload\ndone\n", Exit(0)),
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

/// A program the shell `exec`s replaces it, so no EXIT trap of the shell's
/// runs after the program (bash 5.2.21, zsh 5.9), in a subshell either.
#[test]
fn an_execd_program_leaves_no_exit_trap_to_run() {
	for (shell, script, stdout) in [
		("bash", "trap 'echo x' EXIT; exec /bin/true", ""),
		("bash", "( trap 'echo sub' EXIT; exec /bin/true ); echo st=$?", "st=0\n"),
		("zsh", "trap 'print x' EXIT; exec /bin/true", ""),
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

/// bash with an EXIT trap catches `INT` (`terminating_signals`), but while
/// it waits for a foreground command it only notes one
/// (`wait_sigint_handler`): once the command has ended it acts on it (runs
/// the trap, then dies of `SIGINT`) only if the command died of `SIGINT`
/// too; else the command caught it and the script goes on. The command
/// makes `$F` once it has started, notes an `INT` and goes on.
#[test]
fn bash_acts_on_int_only_once_its_foreground_command_died_of_it() {
	let child =
		"/bin/sh -c 'trap \"echo child-int\" INT; : > \"$F\"; /bin/sleep 1; echo child-done'";
	let script = format!("trap 'echo x' EXIT; {child}; echo after");
	let case = |script, group, stdout, end| SentCase {
		shell: "bash",
		script,
		sig: libc::SIGINT,
		group,
		stdout,
		end,
	};
	run_sent(vec![
		case(script.clone(), false, b"child-done\nafter\nx\n", Exit(0)),
		case(script, true, b"child-int\nchild-done\nafter\nx\n", Exit(0)),
		case(
			"trap 'echo x' EXIT; /bin/sh -c ': > \"$F\"; exec /bin/sleep 3'; echo after".into(),
			true,
			b"x\n",
			Signal(libc::SIGINT),
		),
	]);
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

/// A login-HOME case: obash runs as `argv0` with `args` (and `env` set),
/// without `HOME`, and prints `stdout`.
struct LoginCase {
	argv0:  &'static str,
	args:   Vec<OsString>,
	env:    Option<&'static str>,
	stdout: String,
}

/// bash sets `HOME` from the password database when the environment has
/// none only as a login shell by `argv[0]` (`-bash`, `-sh`), not with `-l`
/// (`-bash -l` sets none) and not in posix mode at startup (`-o posix`,
/// `--posix`, `POSIXLY_CORRECT`, `POSIX_PEDANTIC`; an `sh`'s posix mode
/// starts after). `$0` does not decide: it is the name after `-c string`,
/// or the script.
#[test]
fn bash_sets_home_only_as_a_login_shell_by_argv0() {
	const SHOW: &str = "echo \"[${HOME-unset}] [$0]\"";
	let Some((_, home)) = passwd_entry() else {
		zsh_oracle::uncompared("the uid running the tests has no password database entry");
		return;
	};
	let dir = tempfile::tempdir().expect("a directory for the script");
	let script = dir.path().join("s.sh");
	fs::write(&script, format!("{SHOW}\n")).expect("write the script");
	let show = OsString::from(SHOW);
	let case = |argv0, args: &[&OsStr], env, stdout: String| LoginCase {
		argv0,
		args: args.iter().map(|&a| a.to_owned()).collect(),
		env,
		stdout,
	};
	let os = |s: &'static str| OsStr::new(s);
	let cases = [
		case("bash", &[os("-c"), &show, os("-x")], None, "[unset] [-x]\n".into()),
		case("-bash", &[script.as_os_str()], None, format!("[{home}] [{}]\n", script.display())),
		case("-sh", &[os("-c"), &show], None, format!("[{home}] [-sh]\n")),
		case("-bash", &[os("-l"), os("-c"), &show], None, "[unset] [-bash]\n".into()),
		case("-bash", &[os("-c"), &show], None, format!("[{home}] [-bash]\n")),
		case("bash", &[os("-l"), os("-c"), &show], None, "[unset] [bash]\n".into()),
		case("-bash", &[os("-o"), os("posix"), os("-c"), &show], None, "[unset] [-bash]\n".into()),
		case("-bash", &[os("+o"), os("posix"), os("-c"), &show], None, format!("[{home}] [-bash]\n")),
		case("-bash", &[os("--posix"), os("-c"), &show], None, "[unset] [-bash]\n".into()),
		case("-bash", &[os("-c"), &show], Some("POSIXLY_CORRECT"), "[unset] [-bash]\n".into()),
		case("-bash", &[os("-c"), &show], Some("POSIX_PEDANTIC"), "[unset] [-bash]\n".into()),
	];
	for LoginCase { argv0, args, env, stdout } in cases {
		let run = |program: &OsStr| {
			let run = Run::new(program, argv0, &args).env_remove("HOME");
			match env {
				Some(name) => run.env(name, "1"),
				None => run,
			}
			.go()
		};
		let ours = run(OsStr::new(env!("CARGO_BIN_EXE_obash")));
		let shown = format!("{argv0} {args:?} with {env:?}");
		assert_eq!(String::from_utf8_lossy(&ours.stdout), stdout, "{shown}: {ours:?}");
		if let Some(bash) = real_bash() {
			assert_eq!(ours, run(bash.as_os_str()), "{shown}");
		}
	}
}

/// The bash cases need bash 5.2 or later
/// ([`process_support::BASH_OLDEST`]): an older bash is refused, with a
/// reason naming the version it found, which [`real_bash`] prints on an
/// `UNCOMPARED:` line. Here a stand-in reports the bash of Ubuntu 22.04,
/// 5.1.16; this test prints nothing.
#[test]
fn the_real_bash_must_be_5_2_or_later() {
	use std::os::unix::fs::PermissionsExt;
	for (line, new_enough) in [
		("GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)", true),
		("GNU bash, version 5.3.0(1)-release (aarch64-apple-darwin24)", true),
		("GNU bash, version 5.10.0(1)-release", true),
		("GNU bash, version 6.0.0(1)-release", true),
		("GNU bash, version 5.1.16(1)-release (x86_64-pc-linux-gnu)", false),
		("GNU bash, version 5.0.17(1)-release (x86_64-pc-linux-gnu)", false),
		("GNU bash, version 3.2.57(1)-release (arm64-apple-darwin23)", false),
		("zsh 5.9 (x86_64-ubuntu-linux-gnu)", false),
	] {
		assert_eq!(
			process_support::bash_version(line).is_some_and(|v| v >= process_support::BASH_OLDEST),
			new_enough,
			"{line}"
		);
	}
	let dir = tempfile::tempdir().expect("a directory for a stand-in bash");
	let fake = dir.path().join("bash");
	for (version, accepted) in [("5.1.16", false), ("5.2.21", true)] {
		fs::write(
			&fake,
			format!(
				"#!/bin/sh\necho 'GNU bash, version {version}(1)-release (x86_64-pc-linux-gnu)'\n"
			),
		)
		.expect("write the stand-in");
		fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).expect("make it runnable");
		match process_support::bash_at(fake.clone()) {
			Ok(_) => assert!(accepted, "bash {version} was taken"),
			Err(refusal) => {
				assert!(!accepted, "bash {version} was refused: {refusal}");
				assert!(refusal.contains(&format!("version {version}(1)")), "{refusal}");
			},
		}
	}
}

/// A run starts with a core size limit of 1 byte ([`Run`]): a pipe
/// `core_pattern` refuses a dump at 1 and takes any other limit as none,
/// and a file dump needs more than 1 byte. (A hard limit of 0 allows only
/// 0.)
#[cfg(target_os = "linux")]
#[test]
fn a_run_starts_with_a_core_size_limit_of_one_byte() {
	let out = Run::new("/bin/cat", "cat", &["/proc/self/limits"]).go();
	let text = String::from_utf8_lossy(&out.stdout);
	let fields: Vec<&str> = text
		.lines()
		.find(|l| l.starts_with("Max core file size"))
		.unwrap_or_else(|| panic!("no core limit in /proc/self/limits: {out:?}"))
		.split_whitespace()
		.collect();
	let (soft, hard) = (fields[4], fields[5]);
	assert_eq!(soft, if hard == "0" { "0" } else { "1" }, "{fields:?}");
}
