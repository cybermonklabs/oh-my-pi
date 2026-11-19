//! zsh/watch on the real host's login database (utmpx), through the obash
//! binary run as `zsh -f -c SCRIPT`. The sessions depend on the machine,
//! so each script is compared with the real zsh 5.9 (`zsh -f -c SCRIPT`,
//! [`zsh_oracle`]) run the same way; nothing is compared, and the test
//! says so, where there is none.
//!
//! Both shells read the same database, but one after the other, and other
//! programs log sessions on and off meanwhile (every terminal a test or a
//! tmux pane opens is one). So the outputs are compared over the sessions
//! that stayed the same while both shells ran: the test reads the
//! database itself before and after, drops from both outputs the lines of
//! any other session, and names each session it dropped in an
//! `UNCOMPARED:` line, as it does when no session stayed the same.

#![cfg(unix)]

mod obash_support;
mod zsh_oracle;

use std::{collections::BTreeSet, os::unix::process::CommandExt, process::Command};

use crate::obash_support::{command, obash, output};

/// Run `script` as `zsh -f -c script` with `shell`: stdout, stderr,
/// status.
fn run(mut shell: Command, script: &str) -> (String, String, i32) {
	let out = output(shell.args(["-f", "-c", script]));
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status.code().unwrap_or(-1),
	)
}

/// The login sessions in the utmpx database now (`USER_PROCESS` entries):
/// user, terminal line, host, login time.
fn sessions() -> BTreeSet<(String, String, String, i64)> {
	let text = |f: &[libc::c_char]| {
		let bytes: Vec<u8> = f
			.iter()
			.take_while(|&&c| c != 0)
			.map(|&c| c as u8)
			.collect();
		String::from_utf8_lossy(&bytes).into_owned()
	};
	let mut out = BTreeSet::new();
	// SAFETY: one thread walks the database (each test runs in a process
	// of its own); each entry is read before the next call replaces it.
	unsafe {
		libc::setutxent();
		loop {
			let u = libc::getutxent();
			if u.is_null() {
				break;
			}
			if (*u).ut_type == libc::USER_PROCESS {
				let u = &*u;
				out.insert((
					text(&u.ut_user),
					text(&u.ut_line),
					text(&u.ut_host),
					i64::from(u.ut_tv.tv_sec),
				));
			}
		}
		libc::endutxent();
	}
	out
}

/// `out` without the lines of sessions on terminal lines other than
/// `stable` (a session line is one that says `logged on`/`logged off`;
/// its terminal line stands between blanks or `|`s).
fn keep_stable(out: &str, stable: &BTreeSet<String>) -> String {
	let mut kept = String::new();
	for line in out.lines().filter(|l| {
		!(l.contains("logged on") || l.contains("logged off"))
			|| l.split([' ', '|']).any(|w| stable.contains(w))
	}) {
		kept.push_str(line);
		kept.push('\n');
	}
	kept
}

/// `script` under obash and under the real zsh give the same output, over
/// the sessions that did not change while they ran, and the same status.
/// What it could not compare it reports [`zsh_oracle::uncompared`]: each
/// session that logged on or off meanwhile, and the whole of the session
/// lines when no session stayed the same (none at all included).
fn same_as_zsh(script: &str) {
	if !zsh_oracle::exists() {
		return;
	}
	let before = sessions();
	let want = run(command(zsh_oracle::path()), script);
	let mut cmd = obash();
	cmd.arg0("zsh");
	let ours = run(cmd, script);
	let after = sessions();
	let stable: BTreeSet<String> = before.intersection(&after).map(|s| s.1.clone()).collect();
	if stable.is_empty() {
		zsh_oracle::uncompared(
			"no login session stayed in the login database while both shells ran, so no session line \
			 of `log` was compared",
		);
	}
	for (user, line, host, _) in before.symmetric_difference(&after) {
		zsh_oracle::uncompared(&format!(
			"the session of {user} on {line} from {host:?} logged on or off while the shells ran; \
			 its `log` lines were not compared"
		));
	}
	let view = |r: &(String, String, i32)| (keep_stable(&r.0, &stable), r.1.clone(), r.2);
	assert_eq!(view(&ours), view(&want), "{script}");
}

#[test]
fn zsh_mod_watch_log_matches_zsh() {
	same_as_zsh("zmodload zsh/watch; log; echo $?; watch=(all); log; echo $?");
	same_as_zsh(
		"zmodload zsh/watch; watch=(all); WATCHFMT='%n|%a|%l|%m|%M|%T|%t|%W|%D|%w|%D{%Y \
		 %H:%M:%S}|%(m.remote.local)|%F{red}%f'; log",
	);
	same_as_zsh(
		"zmodload zsh/watch; watch=(notme); log; watch=(\"$USERNAME\"); log; watch=(nosuchuser); log",
	);
}
