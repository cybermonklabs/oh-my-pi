//! Public shell nesting contracts. Bash-compatible stdout, stderr presence and
//! status goldens were recorded with Bash 5.3.0 `--noprofile --norc -c` (not a
//! script file). Unbounded eval/source/substitution cases instead require a
//! reported depth refusal or cancellation: Bash itself can segfault on them.
#![cfg(unix)]

use std::{os::unix::process::CommandExt as _, process::Stdio, sync::Arc, time::Duration};

use bytes::Bytes;
use pi_shell::{
	Shell, ShellExecuteOptions, ShellRunOptions, StreamSinks,
	cancel::{AbortReason, CancelToken},
	execute_shell_streams,
};

async fn capture(script: &str) -> (String, bool, i32) {
	let dir = tempfile::tempdir().unwrap();
	let (out_tx, out_rx) = flume::unbounded::<Bytes>();
	let (err_tx, err_rx) = flume::unbounded::<Bytes>();
	let result = execute_shell_streams(
		ShellExecuteOptions {
			command: format!("{script}\n"),
			cwd: Some(dir.path().to_string_lossy().into_owned()),
			..Default::default()
		},
		StreamSinks { stdout: Some(out_tx), stderr: Some(err_tx) },
		CancelToken::new(Some(20_000)),
	)
	.await
	.unwrap();
	assert!(!result.timed_out, "depth refusal did not stop {script}");
	let output: Vec<u8> = out_rx.drain().flat_map(|b| b.to_vec()).collect();
	(
		String::from_utf8(output).unwrap(),
		err_rx.drain().any(|b| !b.is_empty()),
		result.exit_code.unwrap(),
	)
}

// A regression must not take down the test runner or exhaust the machine.
// The exact-test child owns its resources and is killed and waited on at the
// outer deadline, including when its in-engine timeout has regressed.
async fn isolated(name: &str) -> bool {
	if std::env::var("PI_NESTING_CHILD").as_deref() == Ok(name) {
		return false;
	}
	let mut command = std::process::Command::new(std::env::current_exe().unwrap());
	command
		.args(["--exact", name, "--nocapture"])
		.env("PI_NESTING_CHILD", name);
	command
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	// SAFETY: only async-signal-safe setrlimit runs between fork and exec.
	unsafe {
		command.pre_exec(|| {
			for (resource, value) in [(libc::RLIMIT_AS, 2 << 30), (libc::RLIMIT_NOFILE, 512)] {
				let limit = libc::rlimit { rlim_cur: value, rlim_max: value };
				if libc::setrlimit(resource, &limit) != 0 {
					return Err(std::io::Error::last_os_error());
				}
			}
			Ok(())
		});
	}
	let mut command = tokio::process::Command::from(command);
	command.kill_on_drop(true);
	let mut child = command.spawn().unwrap();
	let status = match tokio::time::timeout(Duration::from_secs(90), child.wait()).await {
		Ok(status) => status.unwrap(),
		Err(_) => {
			child.kill().await.unwrap();
			panic!("{name} outlived its timeout");
		},
	};
	let output = child.wait_with_output().await.unwrap();
	assert!(
		status.success(),
		"{name}: {}{}",
		String::from_utf8_lossy(&output.stdout),
		String::from_utf8_lossy(&output.stderr)
	);
	true
}

macro_rules! golden {
	($name:ident, $script:expr, $out:expr, $err:expr, $status:expr) => {
		#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
		async fn $name() {
			assert_eq!(capture($script).await, ($out.into(), $err, $status));
		}
	};
}

golden!(
	funcnest_wraps_to_one,
	"FUNCNEST=4294967297; n=0; f(){ n=$((n+1)); (( n < 11 )) && f; }; f; printf WRONG",
	"",
	true,
	1
);
golden!(
	funcnest_wraps_to_three,
	"FUNCNEST=4294967299; n=0; f(){ n=$((n+1)); (( n < 11 )) && f; }; f; printf WRONG",
	"",
	true,
	1
);
golden!(
	negative_funcnest_wraps_to_positive,
	"FUNCNEST=-4294967295; n=0; f(){ n=$((n+1)); (( n < 11 )) && f; }; f; printf WRONG",
	"",
	true,
	1
);
golden!(
	wrapped_zero_funcnest_is_unlimited,
	"FUNCNEST=4294967296; n=0; f(){ n=$((n+1)); (( n < 11 )) && f; }; f; printf 'n=%s rc=%s\n' \
	 \"$n\" \"$?\"",
	"n=11 rc=1\n",
	false,
	0
);
golden!(
	wrapped_negative_funcnest_is_unlimited,
	"FUNCNEST=2147483648; n=0; f(){ n=$((n+1)); (( n < 11 )) && f; }; f; printf 'n=%s rc=%s\n' \
	 \"$n\" \"$?\"",
	"n=11 rc=1\n",
	false,
	0
);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn funcnest_rejects_decimal_overflow_before_narrowing() {
	for (value, out, err, status) in [
		("9223372036854775809", "BOTTOMAFTER", false, 0),
		("9223372036854775807", "BOTTOMAFTER", false, 0),
		("9223372036854775808", "BOTTOMAFTER", false, 0),
		("9223372036854775810", "BOTTOMAFTER", false, 0),
		("-9223372036854775808", "BOTTOMAFTER", false, 0),
		("-9223372036854775809", "BOTTOMAFTER", false, 0),
		("-9223372036854775807", "", true, 1),
		("18446744073709551617", "BOTTOMAFTER", false, 0),
		("18446744073709551615", "BOTTOMAFTER", false, 0),
		("18446744073709551616", "BOTTOMAFTER", false, 0),
		("-18446744073709551615", "BOTTOMAFTER", false, 0),
		("-18446744073709551616", "BOTTOMAFTER", false, 0),
		("-18446744073709551617", "BOTTOMAFTER", false, 0),
		(
			"100000000000000000000000000000000000000000000000000000000000000000000000000000001",
			"BOTTOMAFTER",
			false,
			0,
		),
		(
			"100000000000000000000000000000000000000000000000000000000000000000000000000000000",
			"BOTTOMAFTER",
			false,
			0,
		),
		(
			"99999999999999999999999999999999999999999999999999999999999999999999999999999999",
			"BOTTOMAFTER",
			false,
			0,
		),
		("4294967297", "", true, 1),
		("4294967295", "BOTTOMAFTER", false, 0),
		("4294967296", "BOTTOMAFTER", false, 0),
		("4294967306", "BOTTOMAFTER", false, 0),
		("-4294967295", "", true, 1),
	] {
		let script = format!(
			"FUNCNEST='{value}'; f(){{ if (( $1 )); then f $(($1-1)); else printf BOTTOM; fi; }}; f \
			 8; printf AFTER"
		);
		assert_eq!(capture(&script).await, (out.into(), err, status), "FUNCNEST={value:?}");
	}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn funcnest_decimal_syntax_matches_bash53() {
	for (value, out, err, status) in [
		("+1", "", true, 1),
		("-1", "BOTTOMAFTER", false, 0),
		(" 1", "", true, 1),
		("1 ", "", true, 1),
		("\t+1\t", "", true, 1),
		("\n+1\n", "", true, 1),
		("\r+1\r", "", true, 1),
		("\x0b+1\x0b", "", true, 1),
		("\x0c+1\x0c", "", true, 1),
		(" +9223372036854775809 ", "BOTTOMAFTER", false, 0),
		(" -9223372036854775809 ", "BOTTOMAFTER", false, 0),
		("+9223372036854775807", "BOTTOMAFTER", false, 0),
		("-0", "BOTTOMAFTER", false, 0),
		("+0", "BOTTOMAFTER", false, 0),
		("010", "BOTTOMAFTER", false, 0),
		("08", "", true, 1),
		("01", "", true, 1),
		("0x1", "BOTTOMAFTER", false, 0),
		("0X1", "BOTTOMAFTER", false, 0),
		("-0x1", "BOTTOMAFTER", false, 0),
		("2#1", "BOTTOMAFTER", false, 0),
		("10#1", "BOTTOMAFTER", false, 0),
		("16#1", "BOTTOMAFTER", false, 0),
		("", "BOTTOMAFTER", false, 0),
		(" ", "BOTTOMAFTER", false, 0),
		("+", "BOTTOMAFTER", false, 0),
		("-", "BOTTOMAFTER", false, 0),
		("++1", "BOTTOMAFTER", false, 0),
		("+-1", "BOTTOMAFTER", false, 0),
		("1 0", "BOTTOMAFTER", false, 0),
		("1x", "BOTTOMAFTER", false, 0),
		("1.0", "BOTTOMAFTER", false, 0),
		("1e0", "BOTTOMAFTER", false, 0),
		(
			"000000000000000000000000000000000000000000000000000000000000000000000000000000001",
			"",
			true,
			1,
		),
	] {
		let script = format!(
			"FUNCNEST='{value}'; f(){{ if (( $1 )); then f $(($1-1)); else printf BOTTOM; fi; }}; f \
			 8; printf AFTER"
		);
		assert_eq!(capture(&script).await, (out.into(), err, status), "FUNCNEST={value:?}");
	}
}

// The arm's 56 forms. Bash's `sv_funcnest` parses the variable's string
// value; an indexed or associative array has none, so it sets no limit.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn funcnest_variable_forms_match_bash53() {
	for (prefix, out, err, status) in [
		("FUNCNEST='1'", "", true, 1),
		("FUNCNEST='4294967297'", "", true, 1),
		("FUNCNEST='-4294967295'", "", true, 1),
		("FUNCNEST='9223372036854775809'", "BOTTOMAFTER", false, 0),
		("FUNCNEST='9223372036854775807'", "BOTTOMAFTER", false, 0),
		("FUNCNEST=' 1 '", "", true, 1),
		("FUNCNEST='junk'", "BOTTOMAFTER", false, 0),
		("FUNCNEST=''", "BOTTOMAFTER", false, 0),
		("export FUNCNEST='1'", "", true, 1),
		("export FUNCNEST='4294967297'", "", true, 1),
		("export FUNCNEST='-4294967295'", "", true, 1),
		("export FUNCNEST='9223372036854775809'", "BOTTOMAFTER", false, 0),
		("export FUNCNEST='9223372036854775807'", "BOTTOMAFTER", false, 0),
		("export FUNCNEST=' 1 '", "", true, 1),
		("export FUNCNEST='junk'", "BOTTOMAFTER", false, 0),
		("export FUNCNEST=''", "BOTTOMAFTER", false, 0),
		("declare -r FUNCNEST='1'", "", true, 1),
		("declare -r FUNCNEST='4294967297'", "", true, 1),
		("declare -r FUNCNEST='-4294967295'", "", true, 1),
		("declare -r FUNCNEST='9223372036854775809'", "BOTTOMAFTER", false, 0),
		("declare -r FUNCNEST='9223372036854775807'", "BOTTOMAFTER", false, 0),
		("declare -r FUNCNEST=' 1 '", "", true, 1),
		("declare -r FUNCNEST='junk'", "BOTTOMAFTER", false, 0),
		("declare -r FUNCNEST=''", "BOTTOMAFTER", false, 0),
		("declare -a FUNCNEST=('1')", "BOTTOMAFTER", false, 0),
		("declare -a FUNCNEST=('4294967297')", "BOTTOMAFTER", false, 0),
		("declare -a FUNCNEST=('-4294967295')", "BOTTOMAFTER", false, 0),
		("declare -a FUNCNEST=('9223372036854775809')", "BOTTOMAFTER", false, 0),
		("declare -a FUNCNEST=('9223372036854775807')", "BOTTOMAFTER", false, 0),
		("declare -a FUNCNEST=(' 1 ')", "BOTTOMAFTER", false, 0),
		("declare -a FUNCNEST=('junk')", "BOTTOMAFTER", false, 0),
		("declare -a FUNCNEST=('')", "BOTTOMAFTER", false, 0),
		("declare -A FUNCNEST=([0]='1')", "BOTTOMAFTER", false, 0),
		("declare -A FUNCNEST=([0]='4294967297')", "BOTTOMAFTER", false, 0),
		("declare -A FUNCNEST=([0]='-4294967295')", "BOTTOMAFTER", false, 0),
		("declare -A FUNCNEST=([0]='9223372036854775809')", "BOTTOMAFTER", false, 0),
		("declare -A FUNCNEST=([0]='9223372036854775807')", "BOTTOMAFTER", false, 0),
		("declare -A FUNCNEST=([0]=' 1 ')", "BOTTOMAFTER", false, 0),
		("declare -A FUNCNEST=([0]='junk')", "BOTTOMAFTER", false, 0),
		("declare -A FUNCNEST=([0]='')", "BOTTOMAFTER", false, 0),
		("lim='1'; declare -n FUNCNEST=lim", "", true, 1),
		("lim='4294967297'; declare -n FUNCNEST=lim", "", true, 1),
		("lim='-4294967295'; declare -n FUNCNEST=lim", "", true, 1),
		("lim='9223372036854775809'; declare -n FUNCNEST=lim", "BOTTOMAFTER", false, 0),
		("lim='9223372036854775807'; declare -n FUNCNEST=lim", "BOTTOMAFTER", false, 0),
		("lim=' 1 '; declare -n FUNCNEST=lim", "", true, 1),
		("lim='junk'; declare -n FUNCNEST=lim", "BOTTOMAFTER", false, 0),
		("lim=''; declare -n FUNCNEST=lim", "BOTTOMAFTER", false, 0),
		("declare -i FUNCNEST='1'", "", true, 1),
		("declare -i FUNCNEST='4294967297'", "", true, 1),
		("declare -i FUNCNEST='-4294967295'", "", true, 1),
		("declare -i FUNCNEST='9223372036854775809'", "", true, 1),
		("declare -i FUNCNEST='9223372036854775807'", "BOTTOMAFTER", false, 0),
		("declare -i FUNCNEST=' 1 '", "", true, 1),
		("declare -i FUNCNEST='junk'", "BOTTOMAFTER", false, 0),
		("declare -i FUNCNEST=''", "BOTTOMAFTER", false, 0),
	] {
		let script = format!(
			"{prefix}; f(){{ if (( $1 )); then f $(($1-1)); else printf BOTTOM; fi; }}; f 8; printf \
			 AFTER"
		);
		assert_eq!(capture(&script).await, (out.into(), err, status), "{prefix}");
	}
}

// An array FUNCNEST, however it became one, sets no limit; a scalar again
// (after `unset`, or outside a function's local array) sets it again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn funcnest_array_sets_no_limit() {
	let f = "f(){ if (( $1 )); then f $(($1-1)); else printf BOTTOM; fi; }";
	for (prefix, out, err, status) in [
		("FUNCNEST=(1)", "BOTTOMAFTER", false, 0),
		("declare -a FUNCNEST=(1); FUNCNEST=1", "BOTTOMAFTER", false, 0),
		("FUNCNEST=1; declare -a FUNCNEST", "BOTTOMAFTER", false, 0),
		("FUNCNEST=1; declare -A FUNCNEST", "BOTTOMAFTER", false, 0),
		("FUNCNEST=1; FUNCNEST+=(2)", "BOTTOMAFTER", false, 0),
		("declare -a FUNCNEST=([1]=1)", "BOTTOMAFTER", false, 0),
		("a=(1); declare -n FUNCNEST=a", "BOTTOMAFTER", false, 0),
		("declare -A a=([0]=1); declare -n FUNCNEST=a", "BOTTOMAFTER", false, 0),
		("declare -a FUNCNEST=(1); unset FUNCNEST; FUNCNEST=1", "", true, 1),
		(
			"FUNCNEST=1; g(){ local -a FUNCNEST=(1); f 8; }; f(){ if (( $1 )); then f $(($1-1)); \
			 else printf BOTTOM; fi; }; g; printf MID",
			"BOTTOMMID",
			true,
			1,
		),
		("declare -a FUNCNEST=(1); (f 8); printf SUB", "BOTTOMSUBBOTTOMAFTER", false, 0),
	] {
		let script = if prefix.contains("(f 8)") {
			format!("{f}; {prefix}; f 8; printf AFTER")
		} else {
			format!("{prefix}; {f}; f 8; printf AFTER")
		};
		assert_eq!(capture(&script).await, (out.into(), err, status), "{prefix}");
	}
}
golden!(
	source_refusal_ends_pipeline_stage,
	"set -o pipefail; printf 'FUNCNEST=1; f(){ f; }; f\nprintf WRONG_FILE\n' > leaf.sh; { . \
	 ./leaf.sh; printf WRONG > marker; } | cat; printf 'AFTER=%s M=%s\n' \"$?\" \"$([ -e marker ] \
	 && echo yes || echo no)\"",
	"AFTER=1 M=no\n",
	true,
	0
);
golden!(
	eval_refusal_ends_pipeline_stage,
	"set -o pipefail; { eval 'FUNCNEST=1; f(){ f; }; f\nprintf WRONG_EVAL'; printf WRONG > marker; \
	 } | cat; printf 'AFTER=%s M=%s\n' \"$?\" \"$([ -e marker ] && echo yes || echo no)\"",
	"AFTER=1 M=no\n",
	true,
	0
);

// Bash 5.2 continues these root eval/source contexts; Bash 5.3 exits.
golden!(
	root_eval_refusal_exits_in_bash53,
	"eval 'FUNCNEST=1; f(){ f; }; f\nprintf WRONG_EVAL'; printf AFTER",
	"",
	true,
	1
);
golden!(
	root_source_refusal_exits_in_bash53,
	"printf 'FUNCNEST=1; f(){ f; }; f\\nprintf WRONG_FILE\\n' > leaf.sh; . ./leaf.sh; printf AFTER",
	"",
	true,
	1
);
golden!(
	lastpipe_eval_refusal_exits_in_bash53,
	"set -o pipefail; shopt -s lastpipe; true | { eval 'FUNCNEST=1; f(){ f; }; f\nprintf \
	 WRONG_EVAL'; printf WRONG_STAGE; }; printf AFTER",
	"",
	true,
	1
);
golden!(
	lastpipe_source_refusal_exits_in_bash53,
	"set -o pipefail; shopt -s lastpipe; printf 'FUNCNEST=1; f(){ f; }; f\\nprintf WRONG_FILE\\n' \
	 > leaf.sh; true | { . ./leaf.sh; printf WRONG_STAGE; }; printf AFTER",
	"",
	true,
	1
);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trap_refusals_obey_bash53_exit_status() {
	for action in ["f", "eval 'f; printf INNER'", ". ./leaf.sh"] {
		for (key, trigger, out, status) in [
			("EXIT", ":; printf AFTER", "AFTER", 0),
			("ERR", "false; printf AFTER", "", 1),
			("DEBUG", ":; printf AFTER", "", 1),
			("RETURN", "g(){ :; }; g; printf AFTER", "", 1),
			("USR1", "kill -USR1 $$; printf AFTER", "", 1),
		] {
			let action = action.replace('\'', "'\\''");
			let script = format!(
				"set -T; FUNCNEST=1; f(){{ f; }}; printf 'f; printf INNER' > leaf.sh; trap '{action}; \
				 printf WRONG' {key}; {trigger}"
			);
			assert_eq!(capture(&script).await, (out.into(), true, status), "{key}: {action}");
		}
	}
}
golden!(
	exit_trap_refusal_preserves_failure,
	"FUNCNEST=1; f(){ f; }; trap 'f; printf WRONG' EXIT; exit 7",
	"",
	true,
	7
);
golden!(
	exit_trap_eval_refusal_preserves_status,
	"FUNCNEST=1; f(){ f; }; trap \"eval 'f; printf INNER'; printf WRONG\" EXIT; exit 7",
	"",
	true,
	7
);
golden!(
	exit_trap_source_refusal_preserves_status,
	"FUNCNEST=1; f(){ f; }; printf 'f; printf INNER' > leaf.sh; trap '. ./leaf.sh; printf WRONG' \
	 EXIT; exit 7",
	"",
	true,
	7
);
// Bash 5.3 keeps one saved status for all traps (`trap_saved_exit_value`):
// each trap that starts, of any kind, replaces it with the `$?` it
// interrupted, and a refusal under an EXIT trap exits with it. Bash 5.2 lets
// the EXIT trap go on after a refusal in a nested trap.
golden!(
	err_trap_refusal_inside_exit_trap_exits_with_err_status,
	"FUNCNEST=1; f(){ f; }; trap 'trap f ERR; false' EXIT; exit 0",
	"",
	true,
	1
);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exit_trap_refusal_takes_status_of_latest_trap() {
	for (functrace, script, out, status) in [
		(false, r"trap 'trap '\''f'\'' DEBUG; :; printf WRONG' EXIT; exit 7", "", 0),
		(true, r"trap 'trap '\''f'\'' RETURN; g; printf WRONG' EXIT; exit 7", "", 0),
		(false, r"trap 'trap '\''f'\'' USR1; kill -USR1 $$; printf WRONG' EXIT; exit 7", "", 0),
		// A nested trap that already ended still set the status.
		(
			false,
			r"trap 'trap '\'':'\'' ERR; (exit 5); false; trap - ERR; true; f; printf WRONG' EXIT; exit 7",
			"",
			1,
		),
		(
			false,
			r"trap 'trap '\'':'\'' DEBUG; (exit 5); :; trap - DEBUG; true; f; printf WRONG' EXIT; exit 7",
			"",
			0,
		),
		(false, r"h(){ trap 'f' ERR; (exit 4); false; }; trap 'h; printf WRONG' EXIT; exit 7", "", 4),
		(false, r"trap 'eval '\''trap f ERR; false'\''; printf WRONG' EXIT; exit 7", "", 1),
		(
			false,
			r"printf %s 'trap f ERR; (exit 2); false' > nest.sh; trap '. ./nest.sh; printf WRONG' EXIT; exit 7",
			"",
			2,
		),
		(
			false,
			r"trap 'trap '\''trap f ERR; (exit 3); false'\'' USR1; kill -USR1 $$; printf WRONG' EXIT; exit 7",
			"",
			3,
		),
		// An EXIT trap started by `exit` inside another trap.
		(
			false,
			r"trap 'f; printf WRONG' EXIT; trap '(exit 3); exit' ERR; (exit 6); false; printf AFTER",
			"",
			6,
		),
		(
			false,
			r"trap 'f; printf WRONG' EXIT; trap '(exit 3); exit' USR1; (exit 6); kill -USR1 $$; printf AFTER",
			"",
			0,
		),
		// A subshell's refusal ends only the subshell.
		(false, r#"trap '(trap f ERR; false); printf "S=$?"' EXIT; exit 7"#, "S=1", 7),
	] {
		let set = if functrace { "set -T; " } else { "" };
		let script = format!("{set}FUNCNEST=1; f(){{ f; }}; g(){{ :; }}; {script}");
		assert_eq!(capture(&script).await, (out.into(), true, status), "{script}");
	}
}

// The same saved status: `exit` or `return` without an argument at the top
// of a trap action other than DEBUG (and `exit` anywhere in the EXIT trap)
// uses the status the latest trap saved, not `$?`. Wrong at main.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exit_and_return_without_argument_use_latest_trap_status() {
	for (script, out, err, status) in [
		("trap '(exit 4); exit' EXIT; exit 7", "", false, 7),
		("h(){ (exit 4); exit; }; trap h EXIT; exit 7", "", false, 7),
		("trap 'trap : ERR; false; true; exit' EXIT; exit 7", "", false, 1),
		("trap 'trap \"(exit 3)\" DEBUG; (exit 5); trap - DEBUG; exit' EXIT; exit 7", "", false, 5),
		(
			"g(){ :; }; trap 'trap : ERR; (exit 5); false; trap - ERR; true; exit' ERR; (exit 6); \
			 false; printf AFTER",
			"",
			false,
			6,
		),
		(
			"g(){ :; }; trap 'h' EXIT; h(){ (exit 4); exit; }; trap '(exit 3); exit' ERR; (exit 6); \
			 false; printf AFTER",
			"",
			false,
			6,
		),
		// A function called from the trap: its `exit` takes `$?`.
		(
			"g(){ :; }; h(){ (exit 4); exit; }; trap 'h' ERR; (exit 6); false; printf AFTER",
			"",
			false,
			4,
		),
		// DEBUG keeps `$?`.
		(
			"g(){ :; }; f(){ trap '(exit 4); return' DEBUG; (exit 6); :; printf IN=$?; }; f; printf \
			 R=$?",
			"R=4",
			true,
			0,
		),
		(
			"g(){ :; }; f(){ trap 'trap : ERR; (exit 5); false; trap - ERR; true; return' USR1; \
			 (exit 6); kill -USR1 $$; printf IN=$?; }; f; printf R=$?",
			"R=1",
			false,
			0,
		),
		(
			"set -T; g(){ :; }; trap 'trap : ERR; (exit 5); false; trap - ERR; true; exit' RETURN; \
			 (exit 6); g; printf AFTER",
			"",
			false,
			1,
		),
		(
			"set -T; g(){ :; }; trap 'h' EXIT; h(){ (exit 4); exit; }; trap '(exit 3); exit' RETURN; \
			 (exit 6); g; printf AFTER",
			"",
			false,
			0,
		),
		(
			"g(){ :; }; trap 'h' EXIT; h(){ (exit 4); exit; }; trap '(exit 3); exit' USR1; (exit 6); \
			 kill -USR1 $$; printf AFTER",
			"",
			false,
			0,
		),
	] {
		assert_eq!(capture(script).await, (out.into(), err, status), "{script}");
	}
}
golden!(
	funcnest_is_inherited_by_command_substitution,
	"FUNCNEST=1; f(){ if (( $1 > 0 )); then printf '[%s]' \"$(f $(( $1 - 1 )))\"; else printf \
	 BOTTOM; fi; }; f 2; printf AFTER",
	"[]AFTER",
	true,
	0
);
golden!(
	funcnest_is_inherited_by_subshell,
	"FUNCNEST=1; f(){ if (( $1 > 0 )); then ( f $(( $1 - 1 )) ); printf OUT; else printf BOTTOM; \
	 fi; }; f 2; printf AFTER",
	"OUTAFTER",
	true,
	0
);
golden!(
	funcnest_is_inherited_by_pipeline,
	"FUNCNEST=1; f(){ if (( $1 > 0 )); then f $(( $1 - 1 )) | cat; printf OUT; else printf BOTTOM; \
	 fi; }; f 2; printf AFTER",
	"OUTAFTER",
	true,
	0
);
golden!(
	funcnest_is_inherited_by_process_substitution,
	"FUNCNEST=1; f(){ if (( $1 > 0 )); then cat <(f $(( $1 - 1 ))); wait; printf OUT; else printf \
	 BOTTOM; fi; }; f 2; printf AFTER",
	"OUTAFTER",
	true,
	0
);
golden!(
	funcnest_is_inherited_by_coproc,
	"FUNCNEST=1; f(){ if (( $1 > 0 )); then coproc C { f $(( $1 - 1 )); }; wait \"$C_PID\"; printf \
	 OUT; else printf BOTTOM; fi; }; f 2; printf AFTER",
	"OUTAFTER",
	true,
	0
);
golden!(
	funcnest_is_inherited_by_background,
	"FUNCNEST=1; f(){ if (( $1 > 0 )); then f $(( $1 - 1 )) & wait; printf OUT; else printf \
	 BOTTOM; fi; }; f 2; printf AFTER",
	"OUTAFTER",
	true,
	0
);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_callout_children_cannot_reset_nesting_bounds() {
	if isolated("host_callout_children_cannot_reset_nesting_bounds").await {
		return;
	}
	for child in [
		"timeout 0 eval \"$x\"",
		"nohup eval \"$x\"",
		"env eval \"$x\"",
		"command timeout 0 eval \"$x\"",
		"command eval \"$x\"",
		"builtin eval \"$x\"",
		"find . -maxdepth 0 -exec eval \"$x\" \\;",
		"xargs -I % eval \"$x\" < seed",
	] {
		for limit in [2, 100, 700] {
			let script = format!(
				"printf 'go\\n' > seed; n=0; x='if ((++n<{limit})); then {child}; else printf BOTTOM; \
				 fi'; {child}"
			);
			let result = capture(&script).await;
			if limit == 2
				|| (matches!(child, "builtin eval \"$x\"" | "command eval \"$x\"") && limit == 100)
			{
				assert_eq!(result, ("BOTTOM".into(), false, 0), "{child}");
			} else {
				assert_eq!(result.0, "", "{child} at {limit}");
				assert!(result.1, "{child} at {limit}: no diagnostic");
			}
		}
	}
	for child in [
		"timeout 0 f 0",
		"nohup f 0",
		"env eval \"f 0\"",
		"find . -maxdepth 0 -exec eval \"f 0\" \\;",
		"xargs -I % eval \"f 0\" < seed",
	] {
		let script = format!(
			"printf 'go\\n' > seed; FUNCNEST=1; f(){{ if (( $1 )); then {child}; else printf BOTTOM; \
			 fi; }}; f 1; printf AFTER"
		);
		assert_eq!(capture(&script).await, ("AFTER".into(), true, 0), "{child}");
	}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn script_depth_survives_children_without_resetting() {
	if isolated("script_depth_survives_children_without_resetting").await {
		return;
	}
	for (run, child, status) in [
		("eval \"$x\"", "timeout 0 eval \"$x\"", 1),
		("eval \"$x\"", "( eval \"$x\" )", 1),
		("eval \"$x\"", ": \"$(eval \"$x\")\"", 0),
		(". ./self.sh", "timeout 0 . ./self.sh", 1),
		(". ./self.sh", "( . ./self.sh )", 1),
		(". ./self.sh", ": \"$(. ./self.sh)\"", 0),
	] {
		let script = format!(
			"n=0; x='if ((++n==300)); then {child}; elif ((n<600)); then {run}; else printf BOTTOM; \
			 fi'; printf '%s' \"$x\" > self.sh; {run}"
		);
		assert_eq!(capture(&script).await, (String::new(), true, status), "{child}");
	}
	// A new shell resets Bash state, not the engine's retained-frame bound.
	let script = br#"export n x; n=0; x='if ((++n==300)); then bash -c '\''eval "$x"'\''; elif ((n<600)); then eval "$x"; else printf BOTTOM; fi'; eval "$x""#;
	for fault in [pi_shell::testkit::Fault::None, pi_shell::testkit::Fault::Snapshot { every: 100 }]
	{
		let result =
			pi_shell::testkit::run_script(pi_shell::testkit::FakeHost::new(), script, &[], fault);
		assert_eq!(result.stdout, b"");
		assert!(!result.stderr.is_empty());
		assert_eq!(result.status, 1);
		if matches!(fault, pi_shell::testkit::Fault::Snapshot { .. }) {
			assert!(result.snapshots > 0, "depth must survive an actual restore");
		}
	}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trap_script_caps_preserve_exit_status() {
	if isolated("trap_script_caps_preserve_exit_status").await {
		return;
	}
	for action in ["eval \"$x\"", ". ./self.sh"] {
		for (key, trigger, status) in [
			("EXIT", ":", 0),
			("ERR", "false", 1),
			("DEBUG", ":", 1),
			("RETURN", "g(){ :; }; g", 1),
			("USR1", "kill -USR1 $$", 1),
		] {
			let script = format!(
				"set -T; x='eval \"$x\"'; printf '. ./self.sh' > self.sh; trap '{action}; printf \
				 WRONG' {key}; {trigger}"
			);
			assert_eq!(capture(&script).await, (String::new(), true, status), "{key}: {action}");
		}
	}
	// A child refusal does not abort its caller's trap action.
	for (key, trigger, out) in [
		("EXIT", ":; printf AFTER", "AFTEREND"),
		("ERR", "false; printf AFTER", "ENDAFTER"),
		("DEBUG", ":; printf AFTER", "ENDENDAFTER"),
		("RETURN", "g(){ :; }; g; printf AFTER", "ENDAFTER"),
		("USR1", "kill -USR1 $$; printf AFTER", "ENDAFTER"),
	] {
		let trace = if key == "RETURN" { "set -T;" } else { "" };
		let script = format!(
			"{trace} x=': \"$(eval \"$x\")\"'; trap 'eval \"$x\"; printf END' {key}; {trigger}"
		);
		assert_eq!(capture(&script).await, (out.into(), true, 0), "{key}");
	}
}

macro_rules! bounded {
	($name:ident, $script:expr) => {
		#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
		async fn $name() {
			if isolated(stringify!($name)).await {
				return;
			}
			assert_eq!(capture($script).await, (String::new(), true, 1));
		}
	};
}

bounded!(recursive_eval_is_refused, "x='eval \"$x\"'; eval \"$x\"");
bounded!(alias_eval_recursion_is_refused, "shopt -s expand_aliases; alias t='eval t'\nt");
bounded!(recursive_source_is_refused, "printf '. ./self.sh\n' > self.sh; . ./self.sh");
bounded!(recursive_substitution_is_refused, "f(){ x=$(f); }; f");

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_timeout_stops_recursive_scripts_and_substitutions() {
	if isolated("run_timeout_stops_recursive_scripts_and_substitutions").await {
		return;
	}
	for script in [
		"x='sleep 1; eval \"$x\"'; eval \"$x\"",
		"printf 'sleep 1; . ./self.sh\n' > self.sh; . ./self.sh",
		"f(){ sleep 1; x=$(f); }; f",
	] {
		let dir = tempfile::tempdir().unwrap();
		for api in 0..3 {
			let options = ShellExecuteOptions {
				command: script.into(),
				cwd: Some(dir.path().to_string_lossy().into_owned()),
				timeout_ms: Some(100),
				..Default::default()
			};
			let result = match api {
				0 => {
					execute_shell_streams(options, StreamSinks::default(), CancelToken::default()).await
				},
				1 => pi_shell::execute_shell(options, None, CancelToken::default()).await,
				_ => {
					Shell::new(None)
						.run(
							ShellRunOptions {
								command: options.command,
								cwd: options.cwd,
								timeout_ms: options.timeout_ms,
								..Default::default()
							},
							None,
							CancelToken::default(),
						)
						.await
				},
			}
			.unwrap();
			assert!(result.timed_out, "API {api} not timed out: {script}");
		}
	}
}

async fn run(shell: &Shell, script: &str) -> (String, i32) {
	let (tx, rx) = flume::unbounded();
	let result = shell
		.run(
			ShellRunOptions { command: script.into(), ..Default::default() },
			Some(tx),
			CancelToken::new(Some(60_000)),
		)
		.await
		.unwrap();
	assert!(!result.timed_out);
	(rx.drain().collect(), result.exit_code.unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_nested_function_preserves_globals_but_unwinds_locals_and_assignments() {
	if isolated("cancelling_nested_function_preserves_globals_but_unwinds_locals_and_assignments")
		.await
	{
		return;
	}
	for body in [
		"printf READY; while :; do :; done",
		"eval 'printf READY; while :; do :; done'",
		". ./leaf.sh",
	] {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("leaf.sh"), "printf READY; while :; do :; done\n").unwrap();
		let shell = Arc::new(Shell::new(None));
		assert_eq!(run(&shell, "global=kept; temp=outer; f(){ :; }").await.1, 0);
		let (tx, rx) = flume::unbounded();
		let mut cancel = CancelToken::default();
		let abort = cancel.emplace_abort_token();
		let task = tokio::spawn({
			let shell = Arc::clone(&shell);
			let command =
				format!("f(){{ local hidden=secret; local temp=local; {body}; }}; temp=prefix f");
			let cwd = Some(dir.path().to_string_lossy().into_owned());
			async move {
				shell
					.run(
						ShellRunOptions { command, cwd, timeout_ms: Some(60_000), ..Default::default() },
						Some(tx),
						cancel,
					)
					.await
					.unwrap()
			}
		});
		let mut seen = String::new();
		while !seen.contains("READY") {
			seen.push_str(
				&tokio::time::timeout(Duration::from_secs(10), rx.recv_async())
					.await
					.unwrap()
					.unwrap(),
			);
		}
		abort.abort(AbortReason::Signal);
		assert!(task.await.unwrap().cancelled);
		assert_eq!(
			run(
				&shell,
				"declare -p global temp; printf 'H=%s F=%s\n' \"${hidden-unset}\" \"${FUNCNAME[*]}\"; \
				 FUNCNEST=1; g(){ :; }; g; eval ':'; . /dev/null; printf CLEAN"
			)
			.await,
			("declare -- global=\"kept\"\ndeclare -- temp=\"outer\"\nH=unset F=\nCLEAN".into(), 0)
		);
	}
}

#[test]
fn function_recursion_runs_on_two_megabyte_tokio_workers() {
	let rt = tokio::runtime::Builder::new_multi_thread()
		.worker_threads(2)
		.thread_stack_size(2 << 20)
		.enable_all()
		.build()
		.unwrap();
	rt.block_on(async {
		if isolated("function_recursion_runs_on_two_megabyte_tokio_workers").await {
			return;
		}
		tokio::spawn(async {
			let shell = Shell::new(None);
			for depth in [100, 150, 500, 1_000, 4_000] {
				let script = format!(
					"FUNCNEST=5000; f(){{ (( $1 > 0 )) && f $(( $1 - 1 )); }}; f {depth}; printf \
					 'rc=%s\n' \"$?\""
				);
				assert_eq!(run(&shell, &script).await, ("rc=1\n".into(), 0));
			}
			assert_eq!(
				run(&shell, "unset FUNCNEST; f(){ f; }; f; printf WRONG")
					.await
					.1,
				1
			);
		})
		.await
		.unwrap();
	});
}
