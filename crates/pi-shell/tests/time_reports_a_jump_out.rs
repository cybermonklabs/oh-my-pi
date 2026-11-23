//! `time` reports its times when its command leaves by a jump, as bash's
//! `time_command` does: it catches the jump (`exit`, `set -e`, a fatal
//! expansion error, a discarded command, `break`, `continue`), prints the
//! report, then jumps on. `return` passes it, and `exec` replaces the
//! shell: no report then.
//!
//! Every row was measured against bash 5.2.21 and 5.3.20; they agree on
//! each, except the error message of a function run in a background
//! subshell, which bash 5.2.21 names `environment: line 1:` (5.3.20 the
//! shell's name). The rows print errors as `SH: …` either way.

#![cfg(unix)]

mod obash_support;

/// Runs `script` with stderr on stdout and `TIMEFORMAT=report`; each error
/// line's `NAME: line N: ` prefix becomes `SH: `, and a `time -p` line's
/// digits become 0. Returns the output and the exit status.
fn run(script: &str) -> (String, Option<i32>) {
	let script = format!("exec 2>&1; TIMEFORMAT=report; {script}");
	let out = obash_support::output(obash_support::obash().args(["-c", &script]));
	let text = String::from_utf8_lossy(&out.stdout)
		.lines()
		.map(|l| {
			let l = match l.find(": line ") {
				Some(i) => l[i + 7..]
					.find(": ")
					.map_or_else(|| l.to_owned(), |j| format!("SH: {}", &l[i + 7 + j + 2..])),
				None => l.to_owned(),
			};
			if ["real ", "user ", "sys "].iter().any(|p| l.starts_with(p)) {
				l.replace(|c: char| c.is_ascii_digit(), "0")
			} else {
				l
			}
		})
		.map(|l| l + "\n")
		.collect();
	(text, out.status.code())
}

/// Every row whose output or status differs is listed.
fn assert_rows(rows: &[(&str, &str, &str, i32)]) {
	let mismatches: Vec<String> = rows
		.iter()
		.filter_map(|&(name, script, want, status)| {
			let got = run(script);
			(got != (String::from(want), Some(status)))
				.then(|| format!("{name}: {got:?}, want ({want:?}, {status})"))
		})
		.collect();
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// A fatal expansion error in the timed command ends the (sub)shell, and
/// the report comes before it ends: in a subshell, a background job of a
/// builtin, a group or a program, at the top level of `-c`, and through
/// `eval`. The report is read at that moment: `TIMEFORMAT` as it is then.
#[test]
fn a_fatal_expansion_error_reports_the_times() {
	assert_rows(&[
		("subshell", "( time echo ${x:?u} ); echo w=$?", "SH: x: u\nreport\nw=1\n", 0),
		("background", "time echo ${x:?u} & wait $!; echo w=$?", "SH: x: u\nreport\nw=1\n", 0),
		(
			"background group",
			"time { echo ${x:?u}; } & wait $!; echo w=$?",
			"SH: x: u\nreport\nw=1\n",
			0,
		),
		(
			"background program",
			"time /bin/echo ${x:?u} & wait $!; echo w=$?",
			"SH: x: u\nreport\nw=1\n",
			0,
		),
		("top level", "time echo ${x:?u}; echo after", "SH: x: u\nreport\n", 127),
		(
			"after a complete one",
			"( time { time echo ok; echo ${x:?u}; } )",
			"ok\nreport\nSH: x: u\nreport\n",
			1,
		),
		("nested", "( time { time echo ${x:?u}; } )", "SH: x: u\nreport\nreport\n", 1),
		(
			"format read then",
			"( TIMEFORMAT=inner; time { TIMEFORMAT=outer; time echo ${x:?u}; } )",
			"SH: x: u\nouter\nouter\n",
			1,
		),
		("eval", "( time eval 'echo ${x:?u}' ); echo w=$?", "SH: x: u\nreport\nw=1\n", 0),
		(
			"in eval",
			"( eval 'time echo ${x:?u}; echo after'; echo next ); echo w=$?",
			"SH: x: u\nreport\nw=1\n",
			0,
		),
		(
			"set -u",
			"( set -u; time echo $y ); echo w=$?",
			"SH: y: unbound variable\nreport\nw=1\n",
			0,
		),
		(
			"arithmetic",
			"( time echo $(( 1 / 0 )) ); echo w=$?",
			"SH: 1 / 0 : division by 0 (error token is \"0 \")\nreport\nw=1\n",
			0,
		),
		("time -p", "( time -p echo ${x:?u} )", "SH: x: u\nreal 0.00\nuser 0.00\nsys 0.00\n", 1),
	]);
}

/// A function run in a background subshell: the report comes as well. Its
/// status is bash's 127 (an untimed `f &` gives the same), here 1: that
/// difference is the fatal error's, not `time`'s, so the row reads no
/// status.
#[test]
fn a_fatal_expansion_error_in_a_background_function_reports_the_times() {
	assert_rows(&[(
		"function",
		"f() { time echo ${x:?u}; }; f & wait $!; echo done",
		"SH: x: u\nreport\ndone\n",
		0,
	)]);
}

/// `exit` and `set -e` leave through `time` too; the report comes before
/// the EXIT trap runs, also when `exit` runs in a function.
#[test]
fn exit_and_errexit_report_the_times() {
	assert_rows(&[
		("exit", "( time exit 3 ); echo w=$?", "report\nw=3\n", 0),
		(
			"exit in a group",
			"( time { echo a; time { echo b; exit 2; }; echo c; } ); echo w=$?",
			"a\nb\nreport\nreport\nw=2\n",
			0,
		),
		(
			"before the EXIT trap",
			"( trap 'echo trap' EXIT; time exit 4 ); echo w=$?",
			"report\ntrap\nw=4\n",
			0,
		),
		(
			"in a function, before the EXIT trap",
			"( f() { time exit 5; }; trap 'echo trap' EXIT; f ); echo w=$?",
			"report\ntrap\nw=5\n",
			0,
		),
		("set -e", "( set -e; time { false; echo x; } ); echo w=$?", "report\nw=1\n", 0),
		("set -e, timed", "( set -e; time false; echo after ); echo w=$?", "report\nw=1\n", 0),
	]);
}

/// A discarded command (a failed assignment, a `failglob` miss) leaves
/// the timed command too: bash's `parse_and_execute` catches the jump after
/// `time_command` reported, so the rest of `eval`'s string or of the `-c`
/// string is dropped.
#[test]
fn a_discarded_command_reports_the_times() {
	assert_rows(&[
		(
			"readonly, subshell",
			"readonly r=1; ( time { r=2; echo x; }; echo after ); echo w=$?",
			"SH: r: readonly variable\nreport\nw=1\n",
			0,
		),
		(
			"readonly, eval",
			"readonly r=1; eval 'time { r=2; echo x; }; echo after'; echo next",
			"SH: r: readonly variable\nreport\nnext\n",
			0,
		),
		(
			"readonly, top level",
			"readonly r=1; time { r=2; echo x; }; echo after",
			"SH: r: readonly variable\nreport\n",
			1,
		),
		(
			"failglob, subshell",
			"shopt -s failglob; ( time echo /nonexistent*; echo after ); echo w=$?",
			"SH: no match: /nonexistent*\nreport\nw=1\n",
			0,
		),
		(
			"failglob, eval",
			"shopt -s failglob; eval 'time echo /nonexistent*; echo after'; echo next",
			"SH: no match: /nonexistent*\nreport\nnext\n",
			0,
		),
	]);
}

/// `break` and `continue` leave the timed command and report it.
#[test]
fn break_and_continue_report_the_times() {
	assert_rows(&[
		(
			"break",
			"for i in 1 2; do time { echo $i; break; }; done; echo after",
			"1\nreport\nafter\n",
			0,
		),
		(
			"continue",
			"for i in 1 2; do time { echo $i; continue; }; done; echo after",
			"1\nreport\n2\nreport\nafter\n",
			0,
		),
	]);
}

/// No report where bash gives none: `return` passes `time` (bash's
/// `return_catch`), and `exec` replaces the shell, also when it fails and
/// the shell exits.
#[test]
fn return_and_exec_do_not_report() {
	assert_rows(&[
		("return", "f() { time { echo in; return 3; }; }; f; echo r=$?", "in\nr=3\n", 0),
		(
			"return in a subshell, then exit in its EXIT trap",
			"f() { ( trap 'exit 7' EXIT; time { echo in; return 3; } ); echo r=$?; }; f",
			"in\nr=7\n",
			0,
		),
		("exec", "( time exec /bin/sh -c 'exit 3' ); echo w=$?", "w=3\n", 0),
		(
			"exec fails",
			"( time exec /nonexistent ); echo w=$?",
			"SH: /nonexistent: No such file or directory\nw=127\n",
			0,
		),
	]);
}

/// An arithmetic subscript error leaves no report: bash's
/// `array_expand_index` runs `top_level_cleanup` before it jumps, so
/// `time_command` never sees the jump. In an assignment, an expansion, an
/// arithmetic expansion, `[[ -v ]]`, `test -v` and `let`.
#[test]
fn an_arithmetic_subscript_error_does_not_report() {
	const ERR: &str = "SH: 1/0: division by 0 (error token is \"0\")\nw=1\n";
	assert_rows(&[
		("assignment", "( time { a[1/0]=v; echo in; }; echo after ); echo w=$?", ERR, 0),
		("expansion", "( time echo ${a[1/0]}; echo after ); echo w=$?", ERR, 0),
		("arithmetic", "( time echo $(( a[1/0] )); echo after ); echo w=$?", ERR, 0),
		("[[ -v ]]", "( time [[ -v a[1/0] ]]; echo after ); echo w=$?", ERR, 0),
		("test -v", "( time test -v 'a[1/0]'; echo after ); echo w=$?", ERR, 0),
		("let", "( time let 'a[1/0]=1'; echo after ); echo w=$?", ERR, 0),
	]);
}
