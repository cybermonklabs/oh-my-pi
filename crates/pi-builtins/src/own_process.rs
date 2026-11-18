//! Runs one test in a process of its own, whatever runs the test binary.
//!
//! nextest gives every test a process of its own, but libtest (`cargo test`,
//! Bazel's `rust_test`) runs all of a binary's tests as threads of one
//! process, in parallel. A test that changes or asserts what belongs to the
//! whole process (signal dispositions, the process group, `RLIMIT_NOFILE`,
//! `LOCPATH`, the children and open descriptors of every task), or one that
//! times what its own threads do, is broken there by the other tests, and
//! breaks them.

use std::process::Command;

/// The variable that names the one test a process [`own_process`] started is
/// to run.
const OWN_PROCESS: &str = "PI_BUILTINS_TEST_OWN_PROCESS";

/// Whether the calling test is to run its body here: `true` in the process
/// this started for it. Otherwise this starts that process, this test binary
/// again for the test alone, waits for it, fails unless it ran that test and
/// the test passed, and returns `false`.
///
/// The test is named by its thread: libtest runs each test on a thread named
/// after the test's whole path (`locale::tests::name`). Call this first, on
/// that thread.
pub(crate) fn own_process() -> bool {
	let current = std::thread::current();
	let test = current
		.name()
		.filter(|name| name.contains("::"))
		.unwrap_or_else(|| panic!("own_process must be called on a test's own thread, not on {:?}", current.name()));
	if std::env::var_os(OWN_PROCESS).is_some_and(|name| name == test) {
		return true;
	}
	let ran = Command::new(std::env::current_exe().unwrap())
		.args(["--exact", test, "--test-threads=1", "--nocapture"])
		.env(OWN_PROCESS, test)
		.output()
		.unwrap();
	let out = String::from_utf8_lossy(&ran.stdout);
	let err = String::from_utf8_lossy(&ran.stderr);
	assert!(ran.status.success(), "{test} failed in its own process:\n{out}{err}");
	assert!(out.contains("1 passed"), "{test} did not run in its own process:\n{out}{err}");
	false
}

mod tests {
	use super::own_process;

	/// The test's thread names it, so `own_process` runs the body in a child
	/// whose own thread has the same name, and nowhere else: the parent's call
	/// returns `false` once the child has passed.
	#[test]
	fn the_body_runs_in_a_child_named_by_the_test_thread() {
		if !own_process() {
			return;
		}
		assert_eq!(
			std::thread::current().name(),
			Some("own_process::tests::the_body_runs_in_a_child_named_by_the_test_thread")
		);
		assert!(std::env::var_os(super::OWN_PROCESS).is_some());
	}

	/// A call off the test's thread names no test, and fails rather than run
	/// the body here.
	#[test]
	fn a_call_off_the_test_thread_fails() {
		let joined = std::thread::spawn(own_process).join();
		let message = joined.expect_err("own_process ran off the test thread");
		let message = message.downcast_ref::<String>().cloned().unwrap_or_default();
		assert!(message.contains("must be called on a test's own thread"), "{message}");
	}
}
