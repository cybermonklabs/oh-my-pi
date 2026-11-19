//! `pi_shell::process` command-line behavior and interactive prompts,
//! with zsh parity checked against the real zsh ([`zsh_oracle`]).

#![cfg(unix)]

mod pty_support;
mod zsh_oracle;

use std::{
	ffi::OsStr,
	fs, io,
	os::unix::process::{CommandExt, ExitStatusExt},
	path::Path,
	process::Command,
};

use pty_support::{Spawn, TIMEOUT};

fn run(program: impl AsRef<OsStr>, args: &[&str]) -> (Vec<u8>, Vec<u8>, Option<i32>) {
	let out = Command::new(program)
		.arg0("zsh")
		.args(args)
		.env_remove("ZDOTDIR")
		.output()
		.expect("start the shell");
	(out.stdout, out.stderr, out.status.code())
}

fn obash(args: &[&str]) -> (Vec<u8>, Vec<u8>, Option<i32>) {
	run(env!("CARGO_BIN_EXE_obash"), args)
}

/// Whether the real zsh exists (it reports the test uncompared when not).
fn have_zsh() -> bool {
	zsh_oracle::exists()
}

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
		let (out, err, status) = obash(args);
		assert_eq!(
			String::from_utf8_lossy(&out),
			String::from_utf8_lossy(&run(zsh_oracle::path(), args).0),
			"{args:?}"
		);
		assert!(err.is_empty(), "{args:?}: {}", String::from_utf8_lossy(&err));
		assert_eq!(status, Some(0));
	}
}

#[test]
fn version_names_zsh_59() {
	let (out, _, status) = obash(&["--version"]);
	let text = String::from_utf8(out).unwrap();
	assert!(text.starts_with("zsh 5.9 (") && text.ends_with(")\n"), "{text}");
	assert_eq!(status, Some(0));
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
		assert_eq!(obash(args), run(zsh_oracle::path(), args), "{args:?}");
	}
}

/// The name and home directory of the user running the tests: their
/// password database entry.
fn passwd_entry() -> (String, String) {
	// SAFETY: getpwuid returns a pointer into static storage (or null),
	// read before any other call can replace it.
	unsafe {
		let pw = libc::getpwuid(libc::getuid());
		assert!(!pw.is_null(), "the user running the tests has a password database entry");
		let text =
			|p: *const libc::c_char| std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned();
		(text((*pw).pw_name), text((*pw).pw_dir))
	}
}

/// zsh names the user (`USERNAME`, `%n`) and sets the default `HOME` from
/// the password database, not from `USER` and `HOME`: with both unset the
/// shell still knows who runs it, and `~` is that user's home.
#[test]
fn the_user_name_and_home_come_from_the_password_database() {
	let (name, home) = passwd_entry();
	let args = ["-f", "-c", "print -r -- $USERNAME $HOME ~ ${(%):-%n}"];
	let run_without_user = |program: &std::ffi::OsStr| {
		let out = Command::new(program)
			.arg0("zsh")
			.args(args)
			.env_remove("USER")
			.env_remove("HOME")
			.env_remove("ZDOTDIR")
			.output()
			.expect("start the shell");
		(out.stdout, out.stderr, out.status.code())
	};
	let ours = run_without_user(env!("CARGO_BIN_EXE_obash").as_ref());
	assert_eq!(
		(String::from_utf8_lossy(&ours.0).into_owned(), ours.2),
		(format!("{name} {home} {home} {name}\n"), Some(0))
	);
	if have_zsh() {
		assert_eq!(ours, run_without_user(zsh_oracle::path().as_os_str()));
	}
}

/// A `TRAPNAL` function is the signal's trap (zsh `settrap` with
/// `ZSIG_FUNC`): a real `SIGUSR1` sent to the shell calls `TRAPUSR1` with
/// the signal's number, and the shell goes on.
#[test]
fn a_trapnal_function_catches_a_real_signal() {
	let args = ["-f", "-c", "TRAPUSR1() { print got $1 }; kill -USR1 $$; print after"];
	let ours = obash(&args);
	assert_eq!(
		(String::from_utf8_lossy(&ours.0).into_owned(), ours.2),
		(format!("got {}\nafter\n", libc::SIGUSR1), Some(0)),
		"{}",
		String::from_utf8_lossy(&ours.1)
	);
	if have_zsh() {
		assert_eq!(ours, run(zsh_oracle::path(), &args));
	}
}

/// `args` run as `zsh` by `program`: stdout, stderr, and the signal the
/// process died of (`None`: it exited).
fn run_signal(program: impl AsRef<OsStr>, args: &[&str]) -> (Vec<u8>, Vec<u8>, Option<i32>) {
	let out = Command::new(program)
		.arg0("zsh")
		.args(args)
		.env_remove("ZDOTDIR")
		.output()
		.expect("start the shell");
	(out.stdout, out.stderr, out.status.signal())
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
	let ours = obash(&newest);
	assert_eq!(
		(String::from_utf8_lossy(&ours.0).into_owned(), ours.2),
		(
			"io 29\nTRAPPOLL: none\nTRAPIO: function\nw=1\nerr\nTRAPERR: none\nTRAPZERR: \
			 function\nzerr\nw=1\n"
				.to_owned(),
			Some(0)
		),
		"{}",
		String::from_utf8_lossy(&ours.1)
	);
	let removed = [
		"-f",
		"-c",
		"TRAPPOLL() { print poll $1 }; TRAPIO() { print io $1 }; unfunction TRAPPOLL; print unf=$?; \
		 whence -w TRAPPOLL TRAPIO; kill -POLL $$; print after",
	];
	let ours_removed = run_signal(env!("CARGO_BIN_EXE_obash"), &removed);
	assert_eq!(
		ours_removed,
		(b"unf=0\nTRAPPOLL: none\nTRAPIO: none\n".to_vec(), Vec::new(), Some(libc::SIGPOLL))
	);
	if have_zsh() {
		assert_eq!(ours, run(zsh_oracle::path(), &newest));
		assert_eq!(ours_removed, run_signal(zsh_oracle::path(), &removed));
	}
}

/// A signal without a trap whose default action ends the shell ends the
/// shell's process by that signal, as zsh's does: its parent sees
/// `WIFSIGNALED` with the signal, not an exit with 128 + its number.
#[test]
fn an_untrapped_signal_kills_the_shell_process() {
	let args = ["-f", "-c", "print before; kill -TERM $$; print after"];
	let ours = run_signal(env!("CARGO_BIN_EXE_obash"), &args);
	assert_eq!(ours, (b"before\n".to_vec(), Vec::new(), Some(libc::SIGTERM)));
	if have_zsh() {
		assert_eq!(ours, run_signal(zsh_oracle::path(), &args));
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
	let ours = run(&zsh, &["-f", "-c", &line(&zsh)]);
	assert_eq!(ours, (b"st=143\n".to_vec(), Vec::new(), Some(0)));
	if have_zsh() {
		let real = zsh_oracle::path();
		assert_eq!(ours, run(&real, &["-f", "-c", &line(&real)]));
	}
}

/// `args` run as `zsh` by `program` in `dir`, with the core size limit
/// raised to its hard limit: stdout, stderr, the signal the process died
/// of, and whether it dumped a core.
fn run_dumping(
	program: impl AsRef<OsStr>,
	args: &[&str],
	dir: &Path,
) -> (Vec<u8>, Vec<u8>, Option<i32>, bool) {
	let mut cmd = Command::new(program);
	cmd.arg0("zsh")
		.args(args)
		.env_remove("ZDOTDIR")
		.current_dir(dir);
	// SAFETY: getrlimit and setrlimit are async-signal-safe and change only
	// the child.
	unsafe {
		cmd.pre_exec(|| {
			let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
			if libc::getrlimit(libc::RLIMIT_CORE, &raw mut limit) == 0 {
				limit.rlim_cur = limit.rlim_max;
				libc::setrlimit(libc::RLIMIT_CORE, &raw const limit);
			}
			Ok(())
		});
	}
	let out = cmd.output().expect("start the shell");
	(out.stdout, out.stderr, out.status.signal(), out.status.core_dumped())
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
	let control = run_dumping("/bin/sh", &["-c", "kill -QUIT $$"], control_dir.path());
	if !control.3 {
		zsh_oracle::uncompared(&format!(
			"no core dump can be seen here: /bin/sh killed by SIGQUIT with its core size limit \
			 raised dumped no core (it died of {:?})",
			control.2
		));
	}
	let dir = tempfile::tempdir().expect("a directory for the shell's core");
	let ours = run_dumping(env!("CARGO_BIN_EXE_obash"), &args, dir.path());
	assert_eq!(
		(ours.2, ours.3, cores(dir.path())),
		(Some(libc::SIGQUIT), false, Vec::new()),
		"{}",
		String::from_utf8_lossy(&ours.1)
	);
	if have_zsh() {
		let zsh_dir = tempfile::tempdir().expect("a directory for zsh's core");
		let real = run_dumping(zsh_oracle::path(), &args, zsh_dir.path());
		assert_eq!((ours.2, ours.3), (real.2, real.3));
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
	let args = ["-f", "-c", script];
	let ours = obash(&args);
	assert_eq!(ours, (b"last\n".to_vec(), Vec::new(), Some(0)));
	if have_zsh() {
		assert_eq!(ours, run(zsh_oracle::path(), &args));
	}
}
