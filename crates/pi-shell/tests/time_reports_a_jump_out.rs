//! `time` reports its times when its command leaves by a jump, as bash's
//! `time_command` does: it catches the jump (`exit`, `set -e`, a fatal
//! expansion error, a discarded command, `break`, `continue`), prints the
//! report, then jumps on. `return` passes it, and `exec` replaces the
//! shell: no report then.
//!
//! Each row runs twice, as `-c` text and from a script file. Every row was
//! measured against bash 5.2.21 and 5.3.20 both ways; the bashes agree on
//! each, except the error message of a function run in a background
//! subshell, which bash 5.2.21 names `environment: line 1:` under `-c`
//! (5.3.20 the shell's name). The rows print errors as `SH: …` either way.

#![cfg(unix)]

mod obash_support;

/// How a row runs: as the text of `-c`, or from the script file `s.sh`.
#[derive(Clone, Copy, Debug)]
enum Mode {
	C,
	Script,
}

/// Row shells that run at once in this test process: with the libtest
/// threads all running rows, more would pass an unprivileged user's limit
/// of 1,024 open files (each shell holds its pipes).
const SHELLS_AT_ONCE: usize = 16;

/// The number of row shells running ([`SHELLS_AT_ONCE`] at most).
static RUNNING: (std::sync::Mutex<usize>, std::sync::Condvar) =
	(std::sync::Mutex::new(0), std::sync::Condvar::new());

/// A row shell's place among the [`SHELLS_AT_ONCE`]: taken before it
/// starts, given back when it has ended.
struct Place;

impl Place {
	fn take() -> Self {
		let (count, freed) = &RUNNING;
		let mut n = freed
			.wait_while(count.lock().expect("row count"), |n| *n >= SHELLS_AT_ONCE)
			.expect("row count");
		*n += 1;
		Self
	}
}

impl Drop for Place {
	fn drop(&mut self) {
		let (count, freed) = &RUNNING;
		*count.lock().expect("row count") -= 1;
		freed.notify_one();
	}
}

/// Runs `script` with stderr on stdout and `TIMEFORMAT=report` in a private
/// directory (a row may write files there); each error line's
/// `NAME: line N: ` prefix becomes `SH: `, a `time -p` line's digits
/// become 0, and a `[T<seconds>]` report (`TIMEFORMAT='[T%0R]'`) becomes
/// `[short]` under 2 s or `[long]` from 2 s. Returns the output and the
/// exit status.
fn run(script: &str, mode: Mode) -> (String, Option<i32>) {
	let _place = Place::take();
	let dir = tempfile::tempdir().expect("a row directory");
	let script = format!("exec 2>&1; TIMEFORMAT=report; {script}");
	let mut cmd = obash_support::obash();
	cmd.current_dir(dir.path());
	match mode {
		Mode::C => cmd.args(["-c", &script]),
		Mode::Script => {
			std::fs::write(dir.path().join("s.sh"), format!("{script}\n")).expect("the script file");
			cmd.arg("s.sh")
		},
	};
	let out = obash_support::output(&mut cmd);
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
			} else if let Some(secs) = l
				.strip_prefix("[T")
				.and_then(|r| r.strip_suffix(']'))
				.and_then(|n| n.parse::<u64>().ok())
			{
				String::from(if secs < 2 { "[short]" } else { "[long]" })
			} else {
				l
			}
		})
		.map(|l| l + "\n")
		.collect();
	(text, out.status.code())
}

/// A row whose output and status bash gives in both modes.
type Row<'a> = (&'a str, &'a str, &'a str, i32);

/// A row bash runs differently as `-c` text and from a script: its output
/// and status under `-c`, then from the script file.
type ModeRow<'a> = (&'a str, &'a str, (&'a str, i32), (&'a str, i32));

/// Every row whose output or status differs, in either mode, is listed.
fn assert_rows(rows: &[Row<'_>]) {
	let rows: Vec<ModeRow<'_>> = rows
		.iter()
		.map(|&(name, script, want, status)| (name, script, (want, status), (want, status)))
		.collect();
	assert_rows_by_mode(&rows);
}

/// [`assert_rows`] for rows whose output depends on the mode. The runs go
/// side by side (each is its own shell; some sleep), [`SHELLS_AT_ONCE`] at a
/// time.
fn assert_rows_by_mode(rows: &[ModeRow<'_>]) {
	let runs: Vec<_> = rows
		.iter()
		.flat_map(|&(name, script, c, s)| {
			[(name, script, Mode::C, c), (name, script, Mode::Script, s)]
		})
		.collect();
	let got: Vec<_> = std::thread::scope(|scope| {
		let mut handles = Vec::with_capacity(runs.len());
		for &(_, script, mode, _) in &runs {
			handles.push(scope.spawn(move || run(script, mode)));
		}
		handles
			.into_iter()
			.map(|h| h.join().expect("row thread"))
			.collect()
	});
	let mismatches: Vec<String> = runs
		.iter()
		.zip(got)
		.filter_map(|(&(name, _, mode, (want, status)), got)| {
			(got != (String::from(want), Some(status)))
				.then(|| format!("{name} ({mode:?}): {got:?}, want ({want:?}, {status})"))
		})
		.collect();
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// A fatal expansion error in the timed command ends the (sub)shell, and
/// the report comes before it ends: in a subshell, a background job of a
/// builtin, a group or a program, at the top level, and through `eval`.
/// The report is read at that moment: `TIMEFORMAT` as it is then.
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
	// bash exits 127 from a `-c` string, 1 from a script.
	assert_rows_by_mode(&[(
		"top level",
		"time echo ${x:?u}; echo after",
		("SH: x: u\nreport\n", 127),
		("SH: x: u\nreport\n", 1),
	)]);
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

/// `set -e` with an ERR trap: the trap runs, then the shell exits through
/// `time`, which reports first (also before the EXIT trap).
#[test]
fn errexit_after_an_err_trap_reports_the_times() {
	assert_rows(&[
		(
			"ERR trap",
			"( set -e; trap 'echo err' ERR; time false; echo after ); echo w=$?",
			"err\nreport\nw=1\n",
			0,
		),
		(
			"ERR trap, group",
			"( set -e; trap 'echo err' ERR; time { false; echo x; }; echo after ); echo w=$?",
			"err\nreport\nw=1\n",
			0,
		),
		(
			"ERR and EXIT traps",
			"( set -e; trap 'echo trap' EXIT; trap 'echo err' ERR; time false ); echo w=$?",
			"err\nreport\ntrap\nw=1\n",
			0,
		),
		(
			"ERR trap, redirected",
			"( set -e; trap 'echo err >&2' ERR; time { false; } 2>err ); echo w=$?; echo err:; cat \
			 err",
			"w=1\nerr:\nerr\nreport\n",
			0,
		),
		(
			"in a function",
			"( set -e; trap 'echo err' ERR; f() { time false; }; f; echo after ); echo w=$?",
			"report\nw=1\n",
			0,
		),
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

/// The report goes through the redirections in effect at the jump, also
/// those of the command that jumps (`exit 3 2>/dev/null`); a jump that
/// passes an `eval` or `.` undoes the redirections inside it first. The
/// error message before the report goes the same way.
#[test]
fn a_report_goes_through_the_redirections_at_the_jump() {
	assert_rows(&[
		("exit, its own redirection", "( time exit 3 2>/dev/null ); echo w=$?", "w=3\n", 0),
		(
			"exit, the group's",
			"( time { exit 3; } 2>err ); echo w=$?; echo err:; cat err",
			"w=3\nerr:\nreport\n",
			0,
		),
		("exit, nested", "( time { time { exit 3; } 2>/dev/null; } ); echo w=$?", "w=3\n", 0),
		("exit in a function", "f() { exit 3; }; ( time f 2>/dev/null ); echo w=$?", "w=3\n", 0),
		("exit, top level", "time { exit 3; } 2>err; echo never", "", 3),
		("set -e", "( set -e; time { false; } 2>/dev/null ); echo w=$?", "w=1\n", 0),
		(
			"set -e, the group's",
			"( set -e; time { false; } 2>err ); echo w=$?; echo err:; cat err",
			"w=1\nerr:\nreport\n",
			0,
		),
		(
			"exit through eval",
			"( time eval '{ exit 3; } 2>err' ); echo w=$?; echo err:; cat err",
			"report\nw=3\nerr:\n",
			0,
		),
		(
			"exit through .",
			"printf '{ exit 3; } 2>err\\n' > g; ( time . ./g ); echo w=$?; echo err:; cat err",
			"report\nw=3\nerr:\n",
			0,
		),
		(
			"exit's own redirection in eval",
			"( time eval 'exit 3 2>err' ); echo w=$?; echo err:; cat err",
			"report\nw=3\nerr:\n",
			0,
		),
		(
			"exit through eval, the group's",
			"( time { eval '{ exit 3; } 2>/dev/null'; } 2>err ); echo w=$?; echo err:; cat err",
			"w=3\nerr:\nreport\n",
			0,
		),
		(
			"exit in eval's time",
			"( time eval 'time { exit 3; } 2>err' ); echo w=$?; echo err:; cat err",
			"report\nw=3\nerr:\nreport\n",
			0,
		),
		(
			"set -e through eval",
			"( set -e; time eval '{ false; } 2>err' ); echo w=$?; echo err:; cat err",
			"report\nw=1\nerr:\n",
			0,
		),
		(
			"fatal error through eval",
			"( time eval '{ echo ${x:?u}; } 2>err' ); echo w=$?; echo err:; cat err",
			"report\nw=1\nerr:\nSH: x: u\n",
			0,
		),
		(
			"discard in eval",
			"eval 'time { echo $(( 1/0 )); echo in; } 2>err; echo after'; echo next; echo err:; cat \
			 err",
			"next\nerr:\nSH: 1/0 : division by 0 (error token is \"0 \")\nreport\n",
			0,
		),
		("message only", "( { echo ${x:?u}; } 2>/dev/null ); echo w=$?", "w=1\n", 0),
		(
			"break is no jump",
			"for i in 1 2; do time { echo $i; break; } 2>/dev/null; done; echo after",
			"1\nreport\nafter\n",
			0,
		),
		("exit, untimed", "( { exit 3; } 2>err ); echo w=$?; echo err:; cat err", "w=3\nerr:\n", 0),
	]);
	// bash exits 127 from a `-c` string, 1 from a script.
	assert_rows_by_mode(&[(
		"message only, eval",
		"eval '{ echo ${x:?u}; } 2>/dev/null; echo in'; echo after",
		("", 127),
		("", 1),
	)]);
}

/// While a function runs (also one called inside the `eval`), bash's
/// `parse_and_execute` keeps the redirections inside an `eval` or `.` for
/// two jumps: `set -e`'s exit at the innermost `eval` or `.` (the levels
/// outside it undo theirs), and `exit` at every level when an EXIT trap is
/// set. The report and the EXIT trap go through them, as with no `time`.
/// Every other case undoes them first.
#[test]
fn in_a_function_errexit_and_exit_keep_the_redirections_of_eval() {
	assert_rows(&[
		(
			"set -e",
			"( set -e; f() { time eval '{ false; } 2>/dev/null'; }; f ); echo w=$?",
			"w=1\n",
			0,
		),
		(
			"set -e, .",
			"printf '{ false; } 2>/dev/null\\n' > g; ( set -e; f() { time . ./g; }; f ); echo w=$?",
			"w=1\n",
			0,
		),
		(
			"set -e, a function called in eval",
			"( set -e; time eval 'f() { { false; } 2>/dev/null; }; f' ); echo w=$?",
			"w=1\n",
			0,
		),
		(
			"set -e, EXIT trap",
			"( set -e; trap 'echo T >&2' EXIT; f() { time eval '{ false; } 2>/dev/null'; }; f ); \
			 echo w=$?",
			"w=1\n",
			0,
		),
		(
			"set -e, ERR trap",
			"( set -e; trap 'echo E >&2' ERR; f() { time eval '{ false; } 2>/dev/null'; }; f ); echo \
			 w=$?",
			"w=1\n",
			0,
		),
		(
			"set -e, into a file",
			"( set -e; f() { time eval '{ false; } 2>err'; }; f ); echo w=$?; echo err:; cat err",
			"w=1\nerr:\nreport\n",
			0,
		),
		(
			"set -e, the outer eval undoes its own",
			"( set -e; f() { time eval '{ eval false; } 2>/dev/null'; }; f ); echo w=$?",
			"report\nw=1\n",
			0,
		),
		(
			"set -e, the inner eval keeps",
			"( set -e; f() { time eval 'eval \"{ false; } 2>/dev/null\"'; }; f ); echo w=$?",
			"w=1\n",
			0,
		),
		(
			"exit, EXIT trap",
			"( trap 'echo T >&2' EXIT; f() { time eval '{ exit 3; } 2>/dev/null'; }; f ); echo w=$?",
			"w=3\n",
			0,
		),
		(
			"exit, EXIT trap, nested eval",
			"( trap 'echo T >&2' EXIT; f() { time eval '{ eval \"exit 3\"; } 2>/dev/null'; }; f ); \
			 echo w=$?",
			"w=3\n",
			0,
		),
		(
			"exit, ignored EXIT trap",
			"( trap '' EXIT; f() { time eval '{ exit 3; } 2>/dev/null'; }; f ); echo w=$?",
			"w=3\n",
			0,
		),
		(
			"exit, EXIT trap reset",
			"( trap 'echo T >&2' EXIT; trap - EXIT; f() { time eval '{ exit 3; } 2>/dev/null'; }; f \
			 ); echo w=$?",
			"report\nw=3\n",
			0,
		),
		(
			"exit, no EXIT trap",
			"( f() { time eval '{ exit 3; } 2>/dev/null'; }; f ); echo w=$?",
			"report\nw=3\n",
			0,
		),
		(
			"exit, no function",
			"( trap 'echo T >&2' EXIT; time eval '{ exit 3; } 2>/dev/null' ); echo w=$?",
			"report\nT\nw=3\n",
			0,
		),
		(
			"set -e, no time",
			"( set -e; trap 'echo T >&2' EXIT; f() { eval '{ false; } 2>/dev/null'; }; f ); echo w=$?",
			"w=1\n",
			0,
		),
		(
			"exit, no time",
			"( trap 'echo T >&2' EXIT; f() { eval '{ exit 3; } 2>/dev/null'; }; f ); echo w=$?",
			"w=3\n",
			0,
		),
	]);
}

/// In a script's own commands (outside every `eval`, `.`, trap action and
/// command or process substitution, and every child forked inside one), an
/// expansion error or a failed assignment undoes every redirection before
/// `time` reports (bash's `exp_jump_to_top_level` runs `top_level_cleanup`
/// there), so the report goes to the shell's own stderr; under `-c` it goes
/// through them. The error message goes through them both ways.
#[test]
fn in_a_script_an_expansion_error_undoes_the_redirections_first() {
	assert_rows_by_mode(&[
		(
			"fatal error, /dev/null",
			"( time { echo ${x:?u}; } 2>/dev/null ); echo w=$?",
			("w=1\n", 0),
			("report\nw=1\n", 0),
		),
		(
			"fatal error, a file",
			"( time { echo ${x:?u}; } 2>err ); echo w=$?; echo err:; cat err",
			("w=1\nerr:\nSH: x: u\nreport\n", 0),
			("report\nw=1\nerr:\nSH: x: u\n", 0),
		),
		(
			"arithmetic",
			"( time { echo $(( 1/0 )); echo in; } 2>err; echo after ); echo w=$?; echo err:; cat err",
			("w=1\nerr:\nSH: 1/0 : division by 0 (error token is \"0 \")\nreport\n", 0),
			("report\nw=1\nerr:\nSH: 1/0 : division by 0 (error token is \"0 \")\n", 0),
		),
		(
			"set -u",
			"( time { set -u; echo $y; } 2>err ); echo w=$?; echo err:; cat err",
			("w=1\nerr:\nSH: y: unbound variable\nreport\n", 0),
			("report\nw=1\nerr:\nSH: y: unbound variable\n", 0),
		),
		(
			"readonly",
			"readonly r=1; ( time { r=2; echo x; } 2>err ); echo w=$?; echo err:; cat err",
			("w=1\nerr:\nSH: r: readonly variable\nreport\n", 0),
			("report\nw=1\nerr:\nSH: r: readonly variable\n", 0),
		),
		(
			"failglob",
			"shopt -s failglob; ( time { echo /nonexistent*; } 2>err ); echo w=$?; echo err:; cat err",
			("w=1\nerr:\nSH: no match: /nonexistent*\nreport\n", 0),
			("report\nw=1\nerr:\nSH: no match: /nonexistent*\n", 0),
		),
		(
			"a function's redirection",
			"f() { echo ${x:?u}; }; ( time f 2>err ); echo w=$?; echo err:; cat err",
			("w=1\nerr:\nSH: x: u\nreport\n", 0),
			("report\nw=1\nerr:\nSH: x: u\n", 0),
		),
		(
			"nested",
			"( time { time { echo ${x:?u}; } 2>/dev/null; } 2>err ); echo w=$?; echo err:; cat err",
			("w=1\nerr:\n", 0),
			("report\nreport\nw=1\nerr:\n", 0),
		),
		(
			"a function's own time",
			"f() { time { echo ${x:?u}; } 2>err; }; ( f ); echo w=$?; echo err:; cat err",
			("w=1\nerr:\nSH: x: u\nreport\n", 0),
			("report\nw=1\nerr:\nSH: x: u\n", 0),
		),
	]);
	// Inside `eval` bash runs no `top_level_cleanup`: the report goes
	// through the redirection in both modes.
	assert_rows(&[(
		"in eval",
		"( eval 'time { echo ${x:?u}; } 2>err' ); echo w=$?; echo err:; cat err",
		"w=1\nerr:\nSH: x: u\nreport\n",
		0,
	)]);
}

/// `break` and `continue` leave the timed command and report it, also
/// from inside `eval`, whose `time`s report as well: each command they
/// leave ends as it would at its end (bash's `break` is no jump), so its
/// redirections are undone in turn and each report goes where that
/// `time`'s stderr is. Outside every loop, `eval`'s `break` is an error
/// and the command after it runs.
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
		(
			"break in eval",
			"for i in 1 2; do eval \"time { echo \\$i; break; }\"; done; echo after",
			"1\nreport\nafter\n",
			0,
		),
		(
			"continue in eval",
			"for i in 1 2; do eval \"time { echo \\$i; continue; }\"; done; echo after",
			"1\nreport\n2\nreport\nafter\n",
			0,
		),
		(
			"break in nested eval",
			"for i in 1 2; do time eval \"eval 'time { echo \\$i; break; }'\"; done; echo after",
			"1\nreport\nreport\nafter\n",
			0,
		),
		(
			"break 2 in eval",
			"for i in 1 2; do for j in a b; do eval 'time { echo $i$j; break 2; }'; done; done; echo \
			 after",
			"1a\nreport\nafter\n",
			0,
		),
		(
			"break in a subshell's eval",
			"for i in 1 2; do ( eval 'time { echo $i; break; }' ); done; echo after",
			"1\nSH: break: only meaningful in a `for', `while', or `until' loop\nreport\n2\nSH: \
			 break: only meaningful in a `for', `while', or `until' loop\nreport\nafter\n",
			0,
		),
		(
			"no loop",
			"eval 'time { break; echo x; }'; echo y",
			"SH: break: only meaningful in a `for', `while', or `until' loop\nx\nreport\ny\n",
			0,
		),
		(
			"nested redirections",
			"for i in 1; do time { time { echo $i; break; } 2>/dev/null; } 2>err; done; echo err:; \
			 cat err",
			"1\nreport\nerr:\nreport\n",
			0,
		),
		(
			"nested redirections, eval",
			"for i in 1; do time { eval 'time { echo $i; break; } 2>/dev/null'; } 2>err; done; echo \
			 err:; cat err",
			"1\nreport\nerr:\nreport\n",
			0,
		),
		(
			"redirected break in eval",
			"for i in 1 2; do time { eval 'break 2>/dev/null'; } 2>/dev/null; done; echo after",
			"report\nafter\n",
			0,
		),
		(
			"return in eval",
			"f() { for i in 1 2; do eval 'time { echo $i; return 3; }'; done; }; f; echo r=$?",
			"1\nr=3\n",
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

/// An arithmetic subscript error's jump comes after bash's
/// `top_level_cleanup` (`array_expand_index`): every `time` started inside
/// a `-c` string, an `eval`, a `.`, a trap action or a command or process
/// substitution (or a child forked inside one) is dropped without a report,
/// and a script's own `time`s report on the shell's own stderr.
/// In an assignment, an expansion, an arithmetic expansion, `[[ -v ]]`,
/// `test -v` and `let`.
#[test]
fn an_arithmetic_subscript_error_reports_only_a_scripts_own_times() {
	const C: &str = "SH: 1/0: division by 0 (error token is \"0\")\nw=1\n";
	const S: &str = "SH: 1/0: division by 0 (error token is \"0\")\nreport\nw=1\n";
	const IN_ERR: &str = "w=1\nerr:\nSH: 1/0: division by 0 (error token is \"0\")\n";
	const OUT_ERR: &str = "report\nw=1\nerr:\nSH: 1/0: division by 0 (error token is \"0\")\n";
	assert_rows_by_mode(&[
		("assignment", "( time { a[1/0]=v; echo in; }; echo after ); echo w=$?", (C, 0), (S, 0)),
		("expansion", "( time echo ${a[1/0]}; echo after ); echo w=$?", (C, 0), (S, 0)),
		("arithmetic", "( time echo $(( a[1/0] )); echo after ); echo w=$?", (C, 0), (S, 0)),
		("[[ -v ]]", "( time [[ -v a[1/0] ]]; echo after ); echo w=$?", (C, 0), (S, 0)),
		("test -v", "( time test -v 'a[1/0]'; echo after ); echo w=$?", (C, 0), (S, 0)),
		("let", "( time let 'a[1/0]=1'; echo after ); echo w=$?", (C, 0), (S, 0)),
		(
			"assignment, redirected",
			"( time { a[1/0]=v; echo in; } 2>err ); echo w=$?; echo err:; cat err",
			(IN_ERR, 0),
			(OUT_ERR, 0),
		),
		(
			"let, redirected",
			"( time { let 'a[1/0]=1'; echo in; } 2>err ); echo w=$?; echo err:; cat err",
			(IN_ERR, 0),
			(OUT_ERR, 0),
		),
	]);
}

/// A child forked inside an `eval`, `.` or trap action keeps bash's
/// `parse_and_execute` level (the fork copies `parse_and_execute_level`),
/// and a command or process substitution runs its text with
/// `parse_and_execute`: from a script too, their commands count as inside
/// one, as under `-c`. An arithmetic subscript error drops their `time`s
/// without a report, and an expansion error's report goes through the
/// redirections. A script's own background job and pipeline stage count as
/// outside every one.
#[test]
fn a_child_of_an_eval_or_a_substitution_counts_as_inside_it() {
	const ERR: &str = "SH: 1/0: division by 0 (error token is \"0\")\n";
	let w1 = format!("{ERR}w=1\n");
	let w0 = format!("{ERR}w=0\n");
	assert_rows(&[
		("subshell in eval", "eval '( time { a[1/0]=v; echo in; }; echo after )'; echo w=$?", &w1, 0),
		(
			"subshell in eval, fatal error",
			"eval '( time { echo ${x:?u}; } 2>err )'; echo w=$?; echo err:; cat err",
			"w=1\nerr:\nSH: x: u\nreport\n",
			0,
		),
		(
			"subshell in eval, readonly",
			"readonly r=1; eval '( time { r=2; echo x; } 2>err; echo after )'; echo w=$?; echo err:; \
			 cat err",
			"w=1\nerr:\nSH: r: readonly variable\nreport\n",
			0,
		),
		(
			"background job in eval",
			"eval '{ time { a[1/0]=v; echo in; }; echo after; } & wait $!'; echo w=$?",
			&w1,
			0,
		),
		(
			"pipeline stage in eval",
			"eval '{ time { a[1/0]=v; echo in; }; echo after; } | cat'; echo w=$?",
			&w0,
			0,
		),
		(
			"pipeline stage in eval, fatal error",
			"eval '{ time { echo ${x:?u}; } 2>err; } | cat'; echo w=$?; echo err:; cat err",
			"w=0\nerr:\nSH: x: u\nreport\n",
			0,
		),
		(
			"subshell in .",
			"printf '( time { a[1/0]=v; echo in; }; echo after )\\n' > g; . ./g; echo w=$?",
			&w1,
			0,
		),
		(
			"subshell in a trap action",
			"trap '( time { a[1/0]=v; echo in; }; echo after )' USR1; kill -USR1 $$; echo w=$?",
			&w0,
			0,
		),
		(
			"subshell of a subshell in eval",
			"eval '( ( time { a[1/0]=v; echo in; }; echo after ) )'; echo w=$?",
			&w1,
			0,
		),
		(
			"subshell of a function eval calls",
			"f() { ( time { a[1/0]=v; echo in; }; echo after ); }; eval f; echo w=$?",
			&w1,
			0,
		),
		(
			"command substitution",
			"x=$( { time { a[1/0]=v; echo in; }; echo after; } 2>&1 ); w=$?; echo \"$x\"; echo w=$w",
			&w1,
			0,
		),
		(
			"command substitution, fatal error",
			"x=$( { time { echo ${y:?u}; } 2>err; } 2>&1 ); w=$?; echo \"x=[$x] w=$w\"; echo err:; \
			 cat err",
			"x=[] w=1\nerr:\nSH: y: u\nreport\n",
			0,
		),
		(
			"command substitution, readonly",
			"readonly r=1; x=$( { time { r=2; echo x; } 2>err; echo after; } 2>&1 ); echo \
			 \"x=[$x]\"; echo err:; cat err",
			"x=[]\nerr:\nSH: r: readonly variable\nreport\n",
			0,
		),
		(
			"subshell in a command substitution",
			"x=$( ( time { a[1/0]=v; echo in; }; echo after ) 2>&1 ); echo \"$x\"",
			ERR,
			0,
		),
		("backquotes", "x=`{ time { a[1/0]=v; echo in; }; echo after; } 2>&1`; echo \"$x\"", ERR, 0),
		(
			"command substitution read again with an alias",
			"alias e=echo; x=$( { time { a[1/0]=v; e in; }; e after; } 2>&1 ); echo \"$x\"",
			ERR,
			0,
		),
		(
			"process substitution",
			"cat <( { time { a[1/0]=v; echo in; }; echo after; } 2>&1 ); echo w=$?",
			&w0,
			0,
		),
		(
			"process substitution, fatal error",
			"cat <( { time { echo ${y:?u}; } 2>err; } 2>&1 ); echo w=$?; echo err:; cat err",
			"w=0\nerr:\nSH: y: u\nreport\n",
			0,
		),
	]);
	let w1_report = format!("{ERR}report\nw=1\n");
	let w0_report = format!("{ERR}report\nw=0\n");
	assert_rows_by_mode(&[
		(
			"a script's own background job",
			"{ time { a[1/0]=v; echo in; }; echo after; } & wait $!; echo w=$?",
			(&w1, 0),
			(&w1_report, 0),
		),
		(
			"a script's own pipeline stage",
			"{ time { a[1/0]=v; echo in; }; echo after; } | cat; echo w=$?",
			(&w0, 0),
			(&w0_report, 0),
		),
		(
			"a script's own pipeline stage, fatal error",
			"{ time { echo ${x:?u}; } 2>err; } | cat; echo w=$?; echo err:; cat err",
			("w=0\nerr:\nSH: x: u\nreport\n", 0),
			("report\nw=0\nerr:\nSH: x: u\n", 0),
		),
	]);
}

/// pi-shell goes on after an arithmetic subscript error in `eval`, `.`,
/// `[[ ]]` and a `{var}>` redirection, where bash leaves the whole line (it
/// ends a `-c` string, and in a script drops the rest of the line). Where a
/// `time` goes on that way, its report counts from its own start.
#[test]
fn a_time_that_goes_on_counts_from_its_own_start() {
	const ERR: &str = "SH: 1/0: division by 0 (error token is \"0\")\n";
	let after = format!("{ERR}[short]\nnext\n");
	let fd = format!("{ERR}SH: a[1/0]: cannot assign fd to variable\n[short]\nnext\n");
	let group = format!("{ERR}in\n[short]\nnext\n");
	let nested = format!("{ERR}[short]\nin\n[short]\nnext\n");
	assert_rows(&[
		(
			"eval let",
			"sleep 2.2; TIMEFORMAT='[T%0R]'; time eval 'let \"a[1/0]=1\"'; echo next",
			&after,
			0,
		),
		(
			"eval expansion",
			"sleep 2.2; TIMEFORMAT='[T%0R]'; time eval 'echo ${a[1/0]}'; echo next",
			&after,
			0,
		),
		("[[ ]]", "sleep 2.2; TIMEFORMAT='[T%0R]'; time [[ a[1/0] -eq 1 ]]; echo next", &after, 0),
		(
			"fd variable",
			"sleep 2.2; TIMEFORMAT='[T%0R]'; time : {a[1/0]}>/dev/null; echo next",
			&fd,
			0,
		),
		(
			".",
			"printf 'let \"a[1/0]=1\"\\n' > f; sleep 2.2; TIMEFORMAT='[T%0R]'; time . ./f; echo next",
			&after,
			0,
		),
		(
			"group",
			"sleep 2.2; TIMEFORMAT='[T%0R]'; time { eval 'a[1/0]=v'; echo in; }; echo next",
			&group,
			0,
		),
		(
			"nested",
			"sleep 2.2; TIMEFORMAT='[T%0R]'; time { time eval 'let \"a[1/0]=1\"'; echo in; }; echo \
			 next",
			&nested,
			0,
		),
		(
			"no error",
			"sleep 2.2; TIMEFORMAT='[T%0R]'; time { echo in; }; echo next",
			"in\n[short]\nnext\n",
			0,
		),
	]);
}

/// An error of an array subscript's own text (a `$(( ))` in it) is not a
/// subscript error: the jump reports. Through a quoted subscript, a
/// backslash, `${!r}` and a nameref.
#[test]
fn an_error_in_a_subscripts_text_reports_the_times() {
	const REPORT: &str = "SH: 1/0: division by 0 (error token is \"0\")\nreport\nw=1\n";
	assert_rows(&[
		("quoted", "( time echo ${a['1'+$((1/0))]}; echo after ); echo w=$?", REPORT, 0),
		("backslash", "( time echo ${a[\\1+$((1/0))]}; echo after ); echo w=$?", REPORT, 0),
		("indirect", "r='a[$((1/0))]'; ( time echo ${!r}; echo after ); echo w=$?", REPORT, 0),
		("nameref", "declare -n r='a[$((1/0))]'; ( time echo $r; echo after ); echo w=$?", REPORT, 0),
		("plain", "( time echo ${a[$((1/0))]}; echo after ); echo w=$?", REPORT, 0),
	]);
}

/// Each report pairs a `time` with its own start and its own format, in
/// the order the `time`s end: the innermost first, a `time -p` in the
/// POSIX format whatever `time` comes later in its command, and a `break`
/// leaves the `time`s around its loop to their own end. A `break` or
/// `continue` ends each `time` it leaves the same way: `time -p` in the
/// POSIX format, and a `time` that starts after it neither reports nor
/// takes another's place.
#[test]
fn each_report_has_its_own_start_and_format() {
	assert_rows(&[
		(
			"order, time -p",
			"TIMEFORMAT='[T%0R]'; time -p { sleep 2.2; time { exit 3; }; }",
			"[short]\nreal 0.00\nuser 0.00\nsys 0.00\n",
			3,
		),
		(
			"order",
			"TIMEFORMAT='[T%0R]'; time { sleep 2.2; time { exit 3; }; }",
			"[short]\n[long]\n",
			3,
		),
		(
			"time -p before a later time",
			"TIMEFORMAT=inner; time -p { exit 0; time true; }",
			"real 0.00\nuser 0.00\nsys 0.00\n",
			0,
		),
		(
			"break in a timed loop",
			"time { for i in 1; do break; done; echo after; }",
			"after\nreport\n",
			0,
		),
		(
			"continue in a timed loop",
			"time { for i in 1 2; do continue; done; echo after; }",
			"after\nreport\n",
			0,
		),
		(
			"break, time -p",
			"for i in 1 2; do time -p { echo $i; break; }; done; echo after",
			"1\nreal 0.00\nuser 0.00\nsys 0.00\nafter\n",
			0,
		),
		(
			"continue, time -p",
			"for i in 1 2; do time -p { echo $i; continue; }; done; echo after",
			"1\nreal 0.00\nuser 0.00\nsys 0.00\n2\nreal 0.00\nuser 0.00\nsys 0.00\nafter\n",
			0,
		),
		(
			"break, nested time -p",
			"for i in 1; do time { time -p { break; }; }; done; echo after",
			"real 0.00\nuser 0.00\nsys 0.00\nreport\nafter\n",
			0,
		),
		(
			"continue, nested time -p",
			"for i in 1; do time { time -p { continue; }; }; done; echo after",
			"real 0.00\nuser 0.00\nsys 0.00\nreport\nafter\n",
			0,
		),
		(
			"break, a later time",
			"for i in 1; do time -p { break; time true; }; done; echo after",
			"real 0.00\nuser 0.00\nsys 0.00\nafter\n",
			0,
		),
		(
			"continue, a later time -p",
			"for i in 1; do time { continue; time -p true; }; done; echo after",
			"report\nafter\n",
			0,
		),
		(
			"break, two later times",
			"for i in 1; do time { break; time -p true; time true; }; done; echo after",
			"report\nafter\n",
			0,
		),
		(
			"break in eval, a later time",
			"for i in 1; do eval 'time -p { break; time true; }'; done; echo after",
			"real 0.00\nuser 0.00\nsys 0.00\nafter\n",
			0,
		),
	]);
}
