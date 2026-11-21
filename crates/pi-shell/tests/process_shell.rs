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
	os::unix::process::CommandExt,
	process::Command,
};

use process_support::{End::Exit, Outcome, Run, have_zsh, real, real_bash};
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
	let script = "T=$(mktemp); /bin/sleep 0.1 | /bin/sh -c 'echo $$ >\"$1\"; exec /bin/sleep 0.1' \
	              sh $T & p=$!; wait; [[ $p == $(<$T) ]] && print last; /bin/rm -f $T";
	let ours = Run::script(env!("CARGO_BIN_EXE_obash"), "zsh", script).go();
	assert_eq!(
		(ours.stdout.as_slice(), ours.stderr.as_slice(), ours.code),
		(&b"last\n"[..], &b""[..], Some(0))
	);
	if have_zsh() {
		assert_eq!(ours, Run::script(zsh_oracle::path(), "zsh", script).go());
	}
}

/// A login-HOME case: obash runs as `argv0` with `--noprofile` and `args`
/// (and `env` set), without `HOME`, and prints `stdout`.
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
/// or the script. Each shell runs with `--noprofile`: a login shell (`-l`)
/// reads the machine's `/etc/profile` and the user's `~/.profile`, whose
/// commands are the machine's (rustup's `. "$HOME/.cargo/env"` prints an
/// error where `HOME` is unset); `--noprofile` leaves `HOME` as it is.
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
		args: std::iter::once(OsStr::new("--noprofile"))
			.chain(args.iter().copied())
			.map(OsStr::to_owned)
			.collect(),
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

/// A login shell without `HOME` reads its profile in the home the password
/// database names: bash expands the startup files' `~` as any other
/// (`HOME`, else `sh_get_home_dir`). It runs in a user and mount namespace
/// (`unshare --user --map-root-user --mount`) where the test's own password
/// database, bind-mounted over `/etc/passwd`, names a home of the test's,
/// whose `.profile` prints a line, and `/etc/profile` is an empty file.
/// Where no such namespace can be made, the test says so.
#[test]
fn a_login_shell_without_home_reads_the_profile_in_its_password_database_home() {
	const MOUNT: &str = "mount --bind \"$PI_TEST_PASSWD\" /etc/passwd && mount --bind \
	                     \"$PI_TEST_PROFILE\" /etc/profile && exec \"$0\" \"$@\"";
	let dir = tempfile::tempdir().expect("a directory for the home and the files");
	let home = dir.path().join("home");
	fs::create_dir(&home).expect("make the home");
	fs::write(home.join(".profile"), "echo profile-read\n").expect("write the profile");
	let passwd = dir.path().join("passwd");
	fs::write(&passwd, format!("root:x:0:0:root:{}:/bin/sh\n", home.display()))
		.expect("write the password database");
	let profile = dir.path().join("profile");
	fs::write(&profile, "").expect("write /etc/profile's stand-in");
	let wrap = ["unshare", "--user", "--map-root-user", "--mount", "/bin/sh", "-c", MOUNT];
	let run = |program: &OsStr| {
		Run::new(program, "bash", &["-l", "-c", "echo body"])
			.under(&wrap)
			.env("PI_TEST_PASSWD", &passwd)
			.env("PI_TEST_PROFILE", &profile)
			.env_remove("HOME")
			.env_remove("BASH_ENV")
			.env_remove("ENV")
			.go()
	};
	let probe = Command::new(wrap[0])
		.args(&wrap[1..])
		.arg("true")
		.env("PI_TEST_PASSWD", &passwd)
		.env("PI_TEST_PROFILE", &profile)
		.output();
	if !probe.as_ref().is_ok_and(|out| out.status.success()) {
		zsh_oracle::uncompared(&format!(
			"no user and mount namespace to give the shell a password database: {probe:?}"
		));
		return;
	}
	let ours = run(OsStr::new(env!("CARGO_BIN_EXE_obash")));
	assert_eq!(
		(String::from_utf8_lossy(&ours.stdout), ours.end()),
		("profile-read\nbody\n".into(), Some(Exit(0))),
		"{ours:?}"
	);
	if let Some(bash) = real_bash() {
		assert_eq!(ours, run(bash.as_os_str()));
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

/// A run reaches its program by a relative path from any directory, as the
/// obash under test is named under Bazel (its runfiles path,
/// `crates/pi-shell/obash`): one in another directory ([`Run::dumping_in`])
/// and one through a link in a temporary one ([`Run::under`]). Here obash
/// is named by its path relative to the test's directory.
#[test]
fn a_run_reaches_its_program_by_a_relative_path_from_another_directory() {
	let here = std::env::current_dir().expect("the test's directory");
	let obash = fs::canonicalize(env!("CARGO_BIN_EXE_obash")).expect("the obash under test");
	let here = fs::canonicalize(here).expect("the test's directory");
	let common = here
		.components()
		.zip(obash.components())
		.take_while(|(a, b)| a == b)
		.count();
	let mut relative = std::path::PathBuf::new();
	for _ in here.components().skip(common) {
		relative.push("..");
	}
	relative.extend(obash.components().skip(common));
	assert!(relative.is_relative() && relative.components().count() > 1, "{relative:?}");
	let dir = tempfile::tempdir().expect("another directory");
	let elsewhere = Run::new(&relative, "bash", &["-c", "echo ok"])
		.dumping_in(dir.path())
		.go();
	assert_eq!((elsewhere.stdout.as_slice(), elsewhere.end()), (&b"ok\n"[..], Some(Exit(0))));
	let linked = Run::new(&relative, "bash", &["-c", "echo ok"])
		.under(&["env"])
		.go();
	assert_eq!((linked.stdout.as_slice(), linked.end()), (&b"ok\n"[..], Some(Exit(0))));
}
