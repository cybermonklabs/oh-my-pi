//! `pi_shell::process` command-line behavior and interactive prompts,
//! with zsh parity checked against `/bin/zsh`.

#![cfg(unix)]

mod pty_support;

use std::{io, os::unix::process::CommandExt, path::Path, process::Command};

use pty_support::{Spawn, TIMEOUT};

fn run(program: &str, args: &[&str]) -> (Vec<u8>, Vec<u8>, Option<i32>) {
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

fn have_zsh() -> bool {
	Path::new("/bin/zsh").exists()
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
			String::from_utf8_lossy(&run("/bin/zsh", args).0),
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
		assert_eq!(obash(args), run("/bin/zsh", args), "{args:?}");
	}
}

/// A standalone shell leaves a background job that is just its program
/// running when it exits, as bash and zsh do (it used to end it with
/// `TERM`). The job is killed here once seen running.
#[test]
fn a_standalone_exit_leaves_a_background_program_running() {
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
	// Longer than the grace an abandoned external gets before `KILL`.
	std::thread::sleep(std::time::Duration::from_secs(2));
	// SAFETY: signal 0 only checks that the process exists.
	let alive = unsafe { libc::kill(pid, 0) } == 0;
	// SAFETY: the pid is the job's `sleep`, which nothing else reaps.
	unsafe { libc::kill(pid, libc::SIGKILL) };
	assert!(alive, "sleep {pid} was ended when obash exited");
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
		assert_eq!(ours, run("/bin/zsh", &args));
	}
}
