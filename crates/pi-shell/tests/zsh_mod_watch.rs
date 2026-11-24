//! zsh/watch on a login database (utmpx) of the test's own, through the
//! obash binary run as `zsh -f -c SCRIPT`, compared with the real zsh 5.9
//! ([`zsh_oracle`]) run the same way.
//!
//! Both shells read the database with glibc's `getutxent`, whose file is
//! `_PATH_UTMPX` (`/var/run/utmp`) and no other. So each runs in a user and
//! mount namespace of its own (`unshare`), where a tmpfs on `/var/run` holds
//! the test's file: the sessions are the same on every machine, a runner
//! without any (a container) too. Where the namespace cannot be made, or
//! there is no real zsh, nothing is compared, and the test says so.

#![cfg(unix)]

mod obash_support;
mod zsh_oracle;

#[cfg(all(target_os = "linux", target_env = "gnu"))]
use std::{path::Path, process::Command};

#[cfg(all(target_os = "linux", target_env = "gnu"))]
use crate::obash_support::{command, output};

/// The sessions of the fixture: user, terminal line, host (empty: local),
/// login time (2023-11-14 22:13:20 UTC, and a minute later).
#[cfg(all(target_os = "linux", target_env = "gnu"))]
const SESSIONS: [(&str, &str, &str, i32); 2] =
	[("alice", "pts/7", "host.example", 1_700_000_000), ("bob", "tty2", "", 1_700_000_060)];

/// Write the fixture database to `path`: the [`SESSIONS`] as
/// `USER_PROCESS` entries, between a `LOGIN_PROCESS` (a getty) and a
/// `DEAD_PROCESS` (a session that ended), which zsh/watch leaves out.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn write_fixture(path: &Path) {
	fn set(field: &mut [libc::c_char], text: &str) {
		for (slot, &byte) in field.iter_mut().zip(text.as_bytes()) {
			*slot = byte as libc::c_char;
		}
	}
	#[allow(
		clippy::useless_conversion,
		reason = "`ut_tv.tv_sec` is `i32` on x86-64 glibc and `time_t` on aarch64 (libc's `utmpx`)"
	)]
	let entry = |kind: libc::c_short, user: &str, line: &str, host: &str, time: i32| {
		// SAFETY: `utmpx` is plain data; all zeros is a valid entry.
		let mut u: libc::utmpx = unsafe { std::mem::zeroed() };
		u.ut_type = kind;
		u.ut_pid = 4242;
		set(&mut u.ut_user, user);
		set(&mut u.ut_line, line);
		set(&mut u.ut_id, &line[line.len().saturating_sub(4)..]);
		set(&mut u.ut_host, host);
		u.ut_tv.tv_sec = time.into();
		u
	};
	let mut entries = vec![entry(libc::LOGIN_PROCESS, "LOGIN", "tty1", "", 1_699_999_000)];
	for (user, line, host, time) in SESSIONS {
		entries.push(entry(libc::USER_PROCESS, user, line, host, time));
	}
	entries.push(entry(libc::DEAD_PROCESS, "carol", "pts/8", "gone.example", 1_699_999_500));
	let mut bytes = Vec::new();
	for u in &entries {
		// SAFETY: `u` is a live `utmpx`; its bytes are what glibc reads back.
		bytes.extend_from_slice(unsafe {
			std::slice::from_raw_parts(std::ptr::from_ref(u).cast::<u8>(), size_of::<libc::utmpx>())
		});
	}
	std::fs::write(path, bytes).expect("write the login database");
}

/// The shell at `shell` started as zsh (`--emulate zsh`, which obash and
/// zsh 5.9 both take first) with the fixture `db` as the login database,
/// in a user and mount namespace of its own. The fixture is opened before
/// the tmpfs hides what was under `/var/run`.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn in_namespace(shell: &Path, db: &Path) -> Command {
	let shell = std::path::absolute(shell).expect("the current directory");
	let mut cmd = command("unshare");
	cmd.args(["--user", "--map-root-user", "--mount", "/bin/sh", "-c"])
		.arg(
			"exec 3<\"$0\" && mount -t tmpfs tmpfs /var/run && cat <&3 > /var/run/utmp && exec 3<&- \
			 && exec \"$@\"",
		)
		.arg(db)
		.arg(shell)
		.args(["--emulate", "zsh"])
		.env("TZ", "UTC");
	cmd
}

/// Run `script` as `zsh -f -c script` with `cmd`: stdout, stderr, status.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn run(mut cmd: Command, script: &str) -> (String, String, i32) {
	let out = output(cmd.args(["-f", "-c", script]));
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status.code().unwrap_or(-1),
	)
}

/// Whether a user and mount namespace with a tmpfs on `/var/run` can be
/// made here; `Err` with why not.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn namespace_works() -> Result<(), String> {
	let probe = command("unshare")
		.args([
			"--user",
			"--map-root-user",
			"--mount",
			"/bin/sh",
			"-c",
			"mount -t tmpfs tmpfs /var/run",
		])
		.output();
	match probe {
		Ok(out) if out.status.success() => Ok(()),
		Ok(out) => Err(format!(
			"`unshare --user --map-root-user --mount` with a tmpfs on /var/run failed here ({}: {})",
			out.status,
			String::from_utf8_lossy(&out.stderr).trim()
		)),
		Err(err) => Err(format!("`unshare` could not start here ({err})")),
	}
}

/// `script` under obash and under the real zsh, each with the fixture
/// login database, gives the same output and status; obash's output has
/// what `sees` names (the fixture was read: an empty database would compare
/// equal too).
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn same_as_zsh(db: &Path, script: &str, sees: &str) {
	let ours = run(in_namespace(Path::new(env!("CARGO_BIN_EXE_obash")), db), script);
	assert!(ours.0.contains(sees), "{script}: no {sees:?} in {ours:?}");
	let want = run(in_namespace(&zsh_oracle::path(), db), script);
	assert_eq!(ours, want, "{script}");
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn zsh_mod_watch_log_matches_zsh() {
	if !zsh_oracle::exists() {
		return;
	}
	if let Err(why) = namespace_works() {
		zsh_oracle::uncompared(&format!("{why}, so no `log` of a login database was compared"));
		return;
	}
	let dir = tempfile::tempdir().expect("a directory for the fixture");
	let db = dir.path().join("utmp");
	write_fixture(&db);
	same_as_zsh(
		&db,
		"zmodload zsh/watch; log; echo $?; watch=(all); log; echo $?",
		"alice has logged on pts/7 from host.",
	);
	same_as_zsh(
		&db,
		"zmodload zsh/watch; watch=(all); WATCHFMT='%n|%a|%l|%m|%M|%T|%t|%W|%D|%w|%D{%Y \
		 %H:%M:%S}|%(m.remote.local)|%F{red}%f'; log",
		"alice|logged on|pts/7|host|host.example|",
	);
	same_as_zsh(
		&db,
		"zmodload zsh/watch; watch=(notme); log; watch=(alice); log; watch=(nosuchuser); log; print \
		 end",
		"end",
	);
}

/// The fixture is glibc's utmpx layout on Linux; elsewhere nothing is
/// compared, and the test says so.
#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
#[test]
fn zsh_mod_watch_log_matches_zsh() {
	zsh_oracle::uncompared(
		"the login-database fixture is glibc's utmpx on Linux, so no `log` was compared here",
	);
}
