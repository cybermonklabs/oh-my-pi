//! A trap runs inside another trap's action, and a DEBUG trap (under
//! `set -T`) runs in a substitution that another trap's action starts, as in
//! bash: only a trap's own action holds that trap back (`in_trap_action`).
//! Whether `$BASH_COMMAND` stays the trapped command asks another question,
//! whether any trap's action runs or this is a fork of one
//! (`in_trap_action_or_fork`); these rows fail when a trap's start asks that
//! one. Each row's stdout is bash 5.3.20's (bash 5.2.21 gives the same),
//! with status 0 and no stderr.

use std::process::Command;

/// `(id, script, bash's stdout)`.
const ROWS: &[(&str, &str, &str)] = &[
	("err-in-exit", "trap 'echo E' ERR; trap 'false; echo X' EXIT; :", "E\nX\n"),
	("debug-in-exit", "trap 'echo D' DEBUG; trap 'echo X' EXIT; :", "D\nD\nD\nX\n"),
	(
		"debug-in-usr1",
		"trap 'echo D' DEBUG; trap 'echo U' USR1; kill -USR1 $$; :",
		"D\nD\nD\nU\nD\n",
	),
	("err-in-usr1", "trap 'echo E' ERR; trap 'false; echo U' USR1; kill -USR1 $$; :", "E\nU\n"),
	(
		"t-debug-sub-in-exit",
		r#"set -T; trap 'echo D' DEBUG; trap 'x=$(echo in); echo "x=$x"' EXIT; :"#,
		"D\nD\nD\nD\nx=D\nin\n",
	),
	(
		"t-debug-sub-in-usr1",
		r#"set -T; trap 'echo D' DEBUG; trap 'x=$(echo in); echo "x=$x"' USR1; kill -USR1 $$; :"#,
		"D\nD\nD\nD\nx=D\nin\nD\n",
	),
	(
		"t-debug-sub-in-err",
		"set -T; trap 'echo D' DEBUG; trap 'echo $(echo in)' ERR; false; :",
		"D\nD\nD\nD in\nD\n",
	),
	(
		"t-err-sub-in-exit",
		r#"set -E; trap 'echo E' ERR; trap 'x=$(false; echo after); echo "x=$x"' EXIT; :"#,
		"x=E\nafter\n",
	),
	(
		"t-err-sub-in-usr1",
		r#"set -E; trap 'echo E' ERR; trap 'x=$(false; echo after); echo "x=$x"' USR1; kill -USR1 $$; :"#,
		"x=E\nafter\n",
	),
	(
		"t-debug-procsub-in-exit",
		"set -T; trap 'echo D' DEBUG; trap 'cat <(echo in)' EXIT; :",
		"D\nD\nD\nD\nin\n",
	),
	(
		"t-debug-fn-sub-in-exit",
		"set -T; trap 'echo D' DEBUG; f() { echo $(echo in); }; trap f EXIT; :",
		"D\nD\nD\nD\nD\nD in\n",
	),
	("debug-sub-in-debug", "set -T; trap 'echo D$(echo s)' DEBUG; :; trap - DEBUG", "Ds\nDs\n"),
];

#[test]
fn a_trap_runs_inside_another_traps_action_as_in_bash() {
	let mut differ = Vec::new();
	for &(id, script, want) in ROWS {
		let out = Command::new(env!("CARGO_BIN_EXE_obash"))
			.args(["-c", script])
			.output()
			.expect("obash runs");
		let got = String::from_utf8_lossy(&out.stdout);
		let err = String::from_utf8_lossy(&out.stderr);
		if got != want || !err.is_empty() || out.status.code() != Some(0) {
			differ.push(format!(
				"{id}: `{script}`: {got:?}, {err:?}, {:?}; bash: {want:?}, Some(0)",
				out.status.code()
			));
		}
	}
	assert!(
		differ.is_empty(),
		"{} of {} rows differ from bash:\n{}",
		differ.len(),
		ROWS.len(),
		differ.join("\n")
	);
}
