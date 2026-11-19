//! The real zsh the differential tests compare obash with, and the report
//! of a test that did not compare.
//!
//! The oracle is `/bin/zsh`; `PI_TEST_REAL_ZSH` names another path (a
//! missing one shows which tests compare nothing without it). Where it is
//! missing, or is not zsh 5.9 for a test that needs that, or zsh 5.9's
//! completion functions are not installed, or a corpus walk found no file,
//! a test keeps upstream's choice and checks nothing against zsh, but it
//! says so: [`uncompared`] prints `UNCOMPARED: <test>: <reason>` on
//! stderr, once per test and reason. The repository's nextest config
//! (`.config/nextest.toml`) shows the output of these tests when they
//! pass, so the line reaches the output of `cargo nextest run` and of
//! `bun run test:rs`.

#![allow(dead_code, reason = "each test crate uses a subset")]

use std::{
	collections::HashSet,
	path::PathBuf,
	process::Command,
	sync::{Mutex, PoisonError},
};

/// The real zsh: `$PI_TEST_REAL_ZSH`, or `/bin/zsh`. (`PI_TEST_*` reaches
/// the tests through `bun run test:rs`, which drops other `PI_*` names.)
#[must_use]
pub fn path() -> PathBuf {
	std::env::var_os("PI_TEST_REAL_ZSH")
		.filter(|p| !p.is_empty())
		.map_or_else(|| PathBuf::from("/bin/zsh"), PathBuf::from)
}

/// Whether the real zsh exists; when it does not, the calling test is
/// reported [`uncompared`].
#[must_use]
pub fn exists() -> bool {
	let zsh = path();
	let found = zsh.exists();
	if !found {
		uncompared(&format!("{} does not exist", zsh.display()));
	}
	found
}

/// Whether the real zsh is zsh 5.9 (its `--version`); when it is not, the
/// calling test is reported [`uncompared`].
#[must_use]
pub fn is_zsh_5_9() -> bool {
	let zsh = path();
	let version = Command::new(&zsh).arg("--version").output().ok();
	let found = version
		.as_ref()
		.is_some_and(|out| out.stdout.starts_with(b"zsh 5.9 "));
	if !found {
		uncompared(&format!("{} is not zsh 5.9", zsh.display()));
	}
	found
}

/// Report that the calling test did not compare something against zsh,
/// and what and why: `UNCOMPARED: <test>: <reason>` on stderr, the first
/// time a test gives that reason. The test is the current thread's name,
/// which libtest gives each test's thread.
pub fn uncompared(reason: &str) {
	static SAID: Mutex<Option<HashSet<(String, String)>>> = Mutex::new(None);
	let test = std::thread::current()
		.name()
		.unwrap_or("<a thread without a test name>")
		.to_owned();
	let mut said = SAID.lock().unwrap_or_else(PoisonError::into_inner);
	if said
		.get_or_insert_with(HashSet::new)
		.insert((test.clone(), reason.to_owned()))
	{
		eprintln!("UNCOMPARED: {test}: {reason}");
	}
}
