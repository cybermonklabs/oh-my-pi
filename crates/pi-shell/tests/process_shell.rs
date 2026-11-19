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

/// `args` run as `name` by `program` with `SIGQUIT` at its default, the
/// signals `ignored` ignored and the core size limit 0 on entry (the test
/// runner's own dispositions, which a terminal or a CI runner set, do not
/// reach the shell): stdout, stderr, the exit status, and the signal the
/// process died of.
fn run_entry(
	program: impl AsRef<OsStr>,
	name: &str,
	args: &[&str],
	ignored: &'static [libc::c_int],
) -> (Vec<u8>, Vec<u8>, Option<i32>, Option<i32>) {
	let mut cmd = Command::new(program);
	cmd.arg0(name).args(args).env_remove("ZDOTDIR");
	// SAFETY: signal and setrlimit are async-signal-safe and change only
	// the child.
	unsafe {
		cmd.pre_exec(move || {
			libc::signal(libc::SIGQUIT, libc::SIG_DFL);
			for &sig in ignored {
				libc::signal(sig, libc::SIG_IGN);
			}
			libc::setrlimit(libc::RLIMIT_CORE, &libc::rlimit { rlim_cur: 0, rlim_max: 0 });
			Ok(())
		});
	}
	let out = cmd.output().expect("start the shell");
	(out.stdout, out.stderr, out.status.code(), out.status.signal())
}

/// [`run_entry`] as `zsh` with `SIGUSR1` and `SIGHUP` ignored on entry.
fn run_ignoring(
	program: impl AsRef<OsStr>,
	args: &[&str],
) -> (Vec<u8>, Vec<u8>, Option<i32>, Option<i32>) {
	run_entry(program, "zsh", args, &[libc::SIGUSR1, libc::SIGHUP])
}

/// bash catches its fatal signals once an EXIT trap is set: the trap runs
/// (with `$?` as it was), then the shell dies of the signal; a subshell
/// with a trap of its own does the same. A signal bash does not catch
/// (`PROF`) and a trapped one behave as without the EXIT trap.
#[test]
fn bash_runs_its_exit_trap_before_dying_of_a_fatal_signal() {
	let cases: [(&str, &[u8], Option<i32>, Option<i32>); 6] = [
		(
			"trap 'echo x $?' EXIT; kill -TERM $$; echo not-reached",
			b"x 0\n",
			None,
			Some(libc::SIGTERM),
		),
		("trap 'echo x $?' EXIT; kill -HUP $$; echo not-reached", b"x 0\n", None, Some(libc::SIGHUP)),
		(
			"f() { kill -TERM $$; echo not-reached; }; trap 'echo x $?' EXIT; f",
			b"x 0\n",
			None,
			Some(libc::SIGTERM),
		),
		(
			"( trap 'echo sub-x $?' EXIT; kill -TERM $BASHPID; echo not-reached ); echo st=$?",
			b"sub-x 0\nst=143\n",
			Some(0),
			None,
		),
		("trap 'echo x' EXIT; kill -PROF $$; echo not-reached", b"", None, Some(libc::SIGPROF)),
		(
			"trap 'echo x' EXIT; trap 'echo t' TERM; kill -TERM $$; echo after",
			b"t\nafter\nx\n",
			Some(0),
			None,
		),
	];
	for (script, out, code, signal) in cases {
		let args = ["-c", script];
		let ours = run_entry(env!("CARGO_BIN_EXE_obash"), "bash", &args, &[]);
		// bash also prints a notice of the subshell that died (on stderr),
		// which obash does not: stdout and the status are compared.
		assert_eq!((ours.0.as_slice(), ours.2, ours.3), (out, code, signal), "{script}");
		if Path::new("/bin/bash").is_file() {
			let bash = run_entry("/bin/bash", "bash", &args, &[]);
			assert_eq!((ours.0, ours.2, ours.3), (bash.0, bash.2, bash.3), "{script}");
		} else {
			zsh_oracle::uncompared("no /bin/bash to compare the EXIT trap cases with");
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
	let args = ["-f", "-c", script];
	let ours = obash(&args);
	assert_eq!(
		(
			String::from_utf8_lossy(&ours.0).into_owned(),
			String::from_utf8_lossy(&ours.1).into_owned(),
			ours.2
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
		assert_eq!(ours, run(zsh_oracle::path(), &args));
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
	let cases: [(&str, &str, &[u8], Option<i32>, Option<i32>); 3] = [
		(
			"zsh",
			"/bin/kill -QUIT $$; kill -QUIT $$; print alive; /bin/sh -c 'kill -QUIT $$; echo \
			 child-alive'; print st=$?",
			b"alive\nst=131\n",
			Some(0),
			None,
		),
		("zsh", "trap - QUIT; /bin/kill -QUIT $$; print not-reached", b"", None, Some(libc::SIGQUIT)),
		(
			"bash",
			"/bin/kill -QUIT $$; kill -QUIT $$; echo alive; /bin/sh -c 'kill -QUIT $$; echo \
			 child-alive'; echo st=$?; trap - QUIT; /bin/kill -QUIT $$; echo after-reset",
			b"alive\nst=131\nafter-reset\n",
			Some(0),
			None,
		),
	];
	for (name, script, out, code, signal) in cases {
		let args = if name == "zsh" {
			vec!["-f", "-c", script]
		} else {
			vec!["-c", script]
		};
		let ours = run_entry(env!("CARGO_BIN_EXE_obash"), name, &args, &[]);
		// bash also prints a notice of the `sh` that died of `QUIT` (on
		// stderr), which obash does not: stdout and the status are compared.
		assert_eq!((ours.0.as_slice(), ours.2, ours.3), (out, code, signal), "{name}: {script}");
		let real = if name == "zsh" {
			have_zsh().then(zsh_oracle::path)
		} else {
			Some(std::path::PathBuf::from("/bin/bash")).filter(|p| p.is_file())
		};
		if let Some(real) = real {
			let theirs = run_entry(&real, name, &args, &[]);
			assert_eq!((ours.0, ours.2, ours.3), (theirs.0, theirs.2, theirs.3), "{name}: {script}");
		} else {
			zsh_oracle::uncompared(&format!("no {name} to compare the QUIT case with"));
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
	let held = [
		"-f",
		"-c",
		"kill -QUIT $$; kill -USR1 $$; kill -HUP $$; print alive; trap - USR1; kill -USR1 $$; print \
		 not-reached",
	];
	let released = ["-f", "-c", "trap : QUIT; trap - QUIT; kill -QUIT $$; print not-reached"];
	let obash = env!("CARGO_BIN_EXE_obash");
	let ours_held = run_ignoring(obash, &held);
	assert_eq!(ours_held, (b"alive\n".to_vec(), Vec::new(), None, Some(libc::SIGUSR1)));
	let ours_released = run_ignoring(obash, &released);
	assert_eq!(ours_released, (Vec::new(), Vec::new(), None, Some(libc::SIGQUIT)));
	if have_zsh() {
		assert_eq!(ours_held, run_ignoring(zsh_oracle::path(), &held));
		assert_eq!(ours_released, run_ignoring(zsh_oracle::path(), &released));
	}
}

/// zsh handles a `HUP` it has no trap for (`zhandler`): `zexit(SIGHUP)`,
/// an exit with status 1, not a death by the signal (its exit status is
/// `Some`). The EXIT trap in effect runs first, and no other: inside a
/// function the function's own (zsh keeps the shell's away while a
/// function runs); in a subshell the subshell's, and the shell goes on.
#[test]
fn an_untrapped_hup_makes_zsh_exit_with_status_1_after_the_exit_trap_in_effect() {
	let cases: [(&str, &[u8], i32); 4] = [
		("trap 'print root-exit $?' EXIT; kill -HUP $$; print not-reached", b"root-exit 1\n", 1),
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
		let args = ["-f", "-c", script];
		let ours = obash(&args);
		assert_eq!(ours, (out.to_vec(), Vec::new(), Some(status)), "{script}");
		if have_zsh() {
			assert_eq!(ours, run(zsh_oracle::path(), &args), "{script}");
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
	let ours = run(&zsh, &["-f", "-c", &line(&zsh)]);
	assert_eq!(ours, (b"st=143\n".to_vec(), Vec::new(), Some(0)));
	if have_zsh() {
		let real = zsh_oracle::path();
		assert_eq!(ours, run(&real, &["-f", "-c", &line(&real)]));
	}
}

/// `args` run as `zsh` by `program` in `dir`, with `SIGQUIT` at its default
/// (whatever the test runner's is) and the core size limit raised to its
/// hard limit: stdout, stderr, the signal the process died of, and whether
/// it dumped a core.
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
	// SAFETY: signal, getrlimit and setrlimit are async-signal-safe and
	// change only the child.
	unsafe {
		cmd.pre_exec(|| {
			libc::signal(libc::SIGQUIT, libc::SIG_DFL);
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
