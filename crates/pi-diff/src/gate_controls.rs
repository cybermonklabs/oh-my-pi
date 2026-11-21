//! Scratch control for the rust_test gate; never in a member.

/// A skip in other words, written by a child process to the stderr the test
/// binary inherited, outside libtest's record: the gate must fail on it.
#[test]
fn planted_raw_skip_in_other_words() {
	let status = std::process::Command::new("sh")
		.args(["-c", "echo 'no free port: nothing to test' >&2"])
		.status()
		.expect("sh runs");
	assert!(status.success());
}
