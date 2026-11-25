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

/// A [`ModeRow`] built at run time: its name, script and wanted outputs
/// owned.
type OwnedModeRow = (String, String, (String, i32), (String, i32));

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

/// A `SIGPIPE` ends a shell whose builtin writes to a pipe with no reader:
/// no jump, so its `time` gives no report. The shell starts with the
/// signal's default disposition (the test process ignores it).
#[test]
fn a_builtin_that_a_sigpipe_ends_does_not_report() {
	use std::os::unix::process::CommandExt as _;

	let script = "exec 2>&1; TIMEFORMAT=report; { sleep 1; time { echo x; } 2>e1; echo after >&2; \
	              } | true; echo w=$?; echo e1:; cat e1";
	for mode in [Mode::C, Mode::Script] {
		let dir = tempfile::tempdir().expect("a row directory");
		let mut cmd = obash_support::obash();
		cmd.current_dir(dir.path());
		match mode {
			Mode::C => cmd.args(["-c", script]),
			Mode::Script => {
				std::fs::write(dir.path().join("s.sh"), format!("{script}\n"))
					.expect("the script file");
				cmd.arg("s.sh")
			},
		};
		// SAFETY: `signal` is async-signal-safe; the child sets the default
		// disposition before exec.
		unsafe {
			cmd.pre_exec(|| {
				if libc::signal(libc::SIGPIPE, libc::SIG_DFL) == libc::SIG_ERR {
					Err(std::io::Error::last_os_error())
				} else {
					Ok(())
				}
			});
		}
		let out = obash_support::output(&mut cmd);
		let got = (String::from_utf8_lossy(&out.stdout).into_owned(), out.status.code());
		assert_eq!(got, (String::from("w=0\ne1:\n"), Some(0)), "{mode:?}");
	}
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

/// An arithmetic subscript error leaves the whole line, also through
/// `eval`, `.`, `[[ ]]` and a `{var}>` redirection: under `-c` the string
/// ends and every `time` in it is dropped unreported; in a script each of
/// the script's own `time`s reports, counting from its own start (the shell
/// slept 2.2 s before it), and the rest of the line is dropped.
#[test]
fn a_scripts_own_time_left_by_a_subscript_error_counts_from_its_start() {
	const ERR: &str = "SH: 1/0: division by 0 (error token is \"0\")\n";
	let once = format!("{ERR}[short]\n");
	let twice = format!("{ERR}[short]\n[short]\n");
	assert_rows_by_mode(&[
		(
			"eval let",
			"sleep 2.2; TIMEFORMAT='[T%0R]'; time eval 'let \"a[1/0]=1\"'; echo next",
			(ERR, 1),
			(once.as_str(), 1),
		),
		(
			"eval expansion",
			"sleep 2.2; TIMEFORMAT='[T%0R]'; time eval 'echo ${a[1/0]}'; echo next",
			(ERR, 1),
			(once.as_str(), 1),
		),
		(
			"[[ ]]",
			"sleep 2.2; TIMEFORMAT='[T%0R]'; time [[ a[1/0] -eq 1 ]]; echo next",
			(ERR, 1),
			(once.as_str(), 1),
		),
		(
			"fd variable",
			"sleep 2.2; TIMEFORMAT='[T%0R]'; time : {a[1/0]}>/dev/null; echo next",
			(ERR, 1),
			(once.as_str(), 1),
		),
		(
			".",
			"printf 'let \"a[1/0]=1\"\\n' > f; sleep 2.2; TIMEFORMAT='[T%0R]'; time . ./f; echo next",
			(ERR, 1),
			(once.as_str(), 1),
		),
		(
			"group",
			"sleep 2.2; TIMEFORMAT='[T%0R]'; time { eval 'a[1/0]=v'; echo in; }; echo next",
			(ERR, 1),
			(once.as_str(), 1),
		),
		(
			"nested",
			"sleep 2.2; TIMEFORMAT='[T%0R]'; time { time eval 'let \"a[1/0]=1\"'; echo in; }; echo \
			 next",
			(ERR, 1),
			(twice.as_str(), 1),
		),
	]);
	assert_rows(&[(
		"no error",
		"sleep 2.2; TIMEFORMAT='[T%0R]'; time { echo in; }; echo next",
		"in\n[short]\nnext\n",
		0,
	)]);
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

/// bash's `run_exit_trap` clears the EXIT trap before its action runs, in a
/// subshell and a command substitution as in the shell itself: an `exit` in
/// the action (here in a function it calls) passes each `eval` or `.`,
/// which undoes its redirections, so the report goes out of them. A trap
/// the action sets again, also one that ignores, counts again.
#[test]
fn a_running_exit_trap_counts_as_none() {
	assert_rows(&[
		(
			"subshell",
			"( trap 'f' EXIT; f() { time eval '{ exit 4; } 2>e1'; }; exit 3 ); echo w=$?; echo e1:; \
			 cat e1",
			"report\nw=4\ne1:\n",
			0,
		),
		(
			"subshell, at its end",
			"( trap 'f' EXIT; f() { time eval '{ exit 4; } 2>e1'; }; true ); echo w=$?; echo e1:; \
			 cat e1",
			"report\nw=4\ne1:\n",
			0,
		),
		(
			"subshell, two evals",
			"( trap 'f' EXIT; f() { time eval '{ eval \"{ exit 4; } 2>e2\"; } 2>e1'; }; exit 3 ); \
			 echo w=$?; echo e1:; cat e1; echo e2:; cat e2",
			"report\nw=4\ne1:\ne2:\n",
			0,
		),
		(
			"subshell, .",
			"( trap 'f' EXIT; f() { time . ./g; }; printf '{ exit 4; } 2>e1\\n' > g; exit 3 ); echo \
			 w=$?; echo e1:; cat e1",
			"report\nw=4\ne1:\n",
			0,
		),
		(
			"command substitution",
			"f() { x=$( trap 'g' EXIT; g() { time eval '{ exit 4; } 2>/dev/null'; }; exit 3 ); echo \
			 \"x=[$x] s=$?\"; }; f 2>&1; echo w=$?",
			"report\nx=[] s=4\nw=0\n",
			0,
		),
		(
			"command substitution, no function",
			"x=$( trap 'f' EXIT; f() { time eval '{ exit 4; } 2>/dev/null'; }; exit 3 2>&1 ) 2>&1; \
			 echo \"x=[$x] s=$?\"",
			"report\nx=[] s=4\n",
			0,
		),
		(
			"the shell",
			"trap 'f' EXIT; f() { time eval '{ exit 4; } 2>/dev/null'; }; exit 3",
			"report\n",
			4,
		),
		(
			"set again",
			"( trap 'trap \"echo X >&2\" EXIT; f' EXIT; f() { time eval '{ exit 4; } 2>e1'; }; exit \
			 3 ); echo w=$?; echo e1:; cat e1",
			"w=4\ne1:\nreport\n",
			0,
		),
		(
			"set again, the shell",
			"trap 'trap \"echo X >&2\" EXIT; f' EXIT; f() { time eval '{ exit 4; } 2>/dev/null'; }; \
			 exit 3",
			"",
			4,
		),
		(
			"set again to ignore",
			"( trap 'trap \"\" EXIT; f' EXIT; f() { time eval '{ exit 4; } 2>e1'; }; exit 3 ); echo \
			 w=$?; echo e1:; cat e1",
			"w=4\ne1:\nreport\n",
			0,
		),
	]);
}

/// When `set -e` leaves a function, bash resets the function context before
/// the EXIT trap at the first `eval`, `.` or `-c` string the jump passes, or
/// in a script's `reader_loop` outside posix mode: `set -e` in the trap's
/// `eval` then undoes its redirections, so the report goes out of them. An
/// `exit` keeps the context, a function the trap calls has its own, and a
/// subshell's own catch resets nothing. Under `-c` the `-c` string undoes
/// after an inner `eval` reset it, which runs the function's `pop_context`
/// and leaves the context set again.
#[test]
fn errexit_out_of_a_function_resets_its_context_before_the_exit_trap() {
	assert_rows(&[
		(
			"set -e",
			"set -e; trap 'time eval \"{ false; } 2>/dev/null\"' EXIT; f() { false; }; f",
			"report\n",
			1,
		),
		(
			"ERR trap",
			"set -eE; trap 'echo E >&2' ERR; trap 'time eval \"{ false; } 2>/dev/null\"' EXIT; f() { \
			 false; }; f",
			"E\nreport\n",
			1,
		),
		(
			"an eval in a subshell",
			"( set -e; trap 'time eval \"{ false; } 2>/dev/null\"' EXIT; f() { eval false; }; f ); \
			 echo w=$?",
			"report\nw=1\n",
			0,
		),
		(
			"exit",
			"trap 'set -e; time eval \"{ false; } 2>/dev/null\"' EXIT; f() { exit 3; }; f",
			"",
			1,
		),
		(
			"the trap calls a function",
			"set -e; trap 'g' EXIT; g() { time eval '{ false; } 2>/dev/null'; }; f() { false; }; f",
			"",
			1,
		),
		(
			"subshell",
			"( set -e; trap 'time eval \"{ false; } 2>e1\"' EXIT; f() { false; }; f ); echo w=$?; \
			 echo e1:; cat e1",
			"w=1\ne1:\nreport\n",
			0,
		),
		(
			"no function",
			"set -e; trap 'time eval \"{ false; } 2>/dev/null\"' EXIT; false",
			"report\n",
			1,
		),
	]);
	assert_rows_by_mode(&[
		(
			"posix",
			"set -o posix; set -e; trap 'time eval \"{ false; } 2>/dev/null\"' EXIT; f() { false; }; \
			 f",
			("report\n", 1),
			("", 1),
		),
		(
			"an eval, the shell",
			"set -e; trap 'time eval \"{ false; } 2>/dev/null\"' EXIT; f() { eval false; }; f",
			("", 1),
			("report\n", 1),
		),
	]);
}

/// Other jumps out of a function change the function context before the
/// EXIT trap too. bash's `top_level_cleanup` sets it to 0 (`break` with a
/// bad count; an arithmetic subscript error; an expansion error or a
/// discarded command in a script's own commands), and each `eval`, `.`,
/// `-c` string or command substitution a jump passes undoes, which pops
/// the functions called inside it (an expansion error under `-c`; a posix
/// special builtin's error without `set -e`). A command substitution's
/// text is such a level for `set -e` too. A discarded command that ends a
/// subshell or a command substitution counts as well. `set -e` in the
/// trap's `eval` then undoes its redirections, so the report goes out of
/// them. A function called outside every level keeps the context, and so
/// does `report_error`'s exit, which is no jump.
#[test]
fn a_jump_out_of_a_function_changes_its_context_before_the_exit_trap() {
	const TRAP: &str = "trap 'set -e; time eval \"{ false; } 2>/dev/null\"' EXIT; ";
	const BREAK: &str = "SH: break: x: numeric argument required\n";
	const MISSING: &str = "SH: missing: No such file or directory\n";
	const DIV: &str = "SH: 1/0: division by 0 (error token is \"0\")\n";
	let in_sub = |f: &str| {
		format!(
			"{f}x=$( set -e; trap 'time eval \"{{ false; }} 2>/dev/null\"' EXIT; g() {{ false; }}; g \
			 ); echo \"x=[$x] s=$?\"{}",
			if f.is_empty() { "" } else { "; }; f" }
		)
	};
	let rows = [
		(
			"an expansion error",
			format!("{TRAP}f() {{ echo ${{x:?u}}; }}; f"),
			"SH: x: u\nreport\n".to_owned(),
			1,
		),
		(
			"break",
			format!("{TRAP}f() {{ for i in 1; do break x; done; }}; f"),
			format!("{BREAK}report\n"),
			1,
		),
		(
			"break, a subshell",
			format!("( {TRAP}f() {{ for i in 1; do break x; done; }}; f ); echo w=$?"),
			format!("{BREAK}report\nw=1\n"),
			0,
		),
		(
			"a posix special builtin",
			format!("( set -o posix; {TRAP}f() {{ : <missing; }}; eval f ); echo w=$?"),
			format!("{MISSING}report\nw=1\n"),
			0,
		),
		("set -e in a command substitution", in_sub("f() { "), "report\nx=[] s=1\n".to_owned(), 0),
		(
			"set -e in a command substitution, the shell",
			in_sub(""),
			"report\nx=[] s=1\n".to_owned(),
			0,
		),
		(
			"a posix special builtin in an inner eval",
			format!("( set -o posix; {TRAP}f() {{ eval ': <missing'; }}; f ); echo w=$?"),
			format!("{MISSING}w=1\n"),
			0,
		),
		(
			"report_error",
			format!("( set -e; {TRAP}readonly r=1; f() {{ r=2; }}; f ); echo w=$?"),
			"SH: r: readonly variable\nw=1\n".to_owned(),
			0,
		),
		(
			"an expansion error in a command substitution",
			format!("x=$( {TRAP}g() {{ echo ${{x:?u}}; }}; g ); echo \"x=[$x] s=$?\""),
			"SH: x: u\nreport\nx=[] s=1\n".to_owned(),
			0,
		),
		(
			"a function of the shell it forked from",
			format!("f() {{ x=$( {TRAP}g() {{ echo ${{x:?u}}; }}; g ); echo \"x=[$x] s=$?\"; }}; f"),
			"SH: x: u\nx=[] s=1\n".to_owned(),
			0,
		),
		(
			"an expansion error in an eval",
			format!("( {TRAP}f() {{ echo ${{x:?u}}; }}; eval f ); echo w=$?"),
			"SH: x: u\nreport\nw=1\n".to_owned(),
			0,
		),
		(
			"break in an eval",
			format!("( {TRAP}f() {{ eval 'for i in 1; do break x; done'; }}; f ); echo w=$?"),
			format!("{BREAK}report\nw=1\n"),
			0,
		),
		(
			"an arithmetic subscript error",
			format!("( set -o posix; {TRAP}f() {{ a[1/0]=x; }}; eval f ); echo w=$?"),
			"SH: 1/0: division by 0 (error token is \"0\")\nreport\nw=1\n".to_owned(),
			0,
		),
		(
			"a subshell forked inside an eval",
			"f() { eval '( set -e; trap \"time eval \\\"{ false; } 2>/dev/null\\\"\" EXIT; g() { \
			 false; }; g )'; }; f; echo w=$?"
				.to_owned(),
			"w=1\n".to_owned(),
			0,
		),
		(
			"an arithmetic subscript error ends a subshell",
			format!("( {TRAP}f() {{ a[1/0]=v; }}; f ); echo w=$?"),
			format!("{DIV}report\nw=1\n"),
			0,
		),
		(
			"an arithmetic subscript error ends a command substitution",
			format!("x=$( {TRAP}f() {{ a[1/0]=v; }}; f ); echo \"x=[$x] s=$?\""),
			format!("{DIV}report\nx=[] s=1\n"),
			0,
		),
		(
			"an arithmetic subscript error ends a subshell, no function",
			format!("( {TRAP}a[1/0]=v ); echo w=$?"),
			format!("{DIV}report\nw=1\n"),
			0,
		),
	];
	let rows: Vec<_> = rows
		.iter()
		.map(|(n, s, w, st)| (*n, s.as_str(), w.as_str(), *st))
		.collect();
	assert_rows(&rows);
	let subshell = format!("( {TRAP}f() {{ echo ${{x:?u}}; }}; f ); echo w=$?");
	let in_eval = format!("{TRAP}f() {{ eval 'echo ${{x:?u}}'; }}; f");
	let readonly = format!("( {TRAP}readonly r=1; f() {{ r=2; }}; f; echo after ); echo w=$?");
	let failglob =
		format!("( shopt -s failglob; {TRAP}f() {{ : /nonexistent*; }}; f; echo after ); echo w=$?");
	assert_rows_by_mode(&[
		(
			"an expansion error, a subshell",
			&subshell,
			("SH: x: u\nw=1\n", 0),
			("SH: x: u\nreport\nw=1\n", 0),
		),
		("an expansion error, an eval", &in_eval, ("SH: x: u\nreport\n", 1), ("SH: x: u\n", 1)),
		(
			"a failed assignment ends a subshell",
			&readonly,
			("SH: r: readonly variable\nw=1\n", 0),
			("SH: r: readonly variable\nreport\nw=1\n", 0),
		),
		(
			"a failglob miss ends a subshell",
			&failglob,
			("SH: no match: /nonexistent*\nw=1\n", 0),
			("SH: no match: /nonexistent*\nreport\nw=1\n", 0),
		),
	]);
}

/// A discarded command (a failed assignment, an arithmetic subscript error)
/// that leaves a subshell or a command substitution ends it through its
/// own top, which runs its EXIT trap as at its end (bash's
/// `execute_in_subshell`, `command_substitute`), with the status 1.
#[test]
fn a_discarded_command_that_ends_a_subshell_runs_its_exit_trap() {
	assert_rows(&[
		(
			"a failed assignment",
			"( trap 'echo T $?' EXIT; readonly r=1; r=2; echo after ); echo w=$?",
			"SH: r: readonly variable\nT 1\nw=1\n",
			0,
		),
		(
			"a command substitution",
			"x=$( trap 'echo T $? >&2' EXIT; readonly r=1; r=2; echo in ); echo \"x=[$x] s=$?\"",
			"SH: r: readonly variable\nT 1\nx=[] s=1\n",
			0,
		),
		(
			"an arithmetic subscript error",
			"( trap 'echo T $?' EXIT; a[1/0]=v; echo after ); echo w=$?",
			"SH: 1/0: division by 0 (error token is \"0\")\nT 1\nw=1\n",
			0,
		),
	]);
}

/// The EXIT trap after a jump sees the functions bash leaves running, by
/// `FUNCNAME`, a local and `$#`. Each `eval`, `.`, trap action, command or
/// process substitution or `-c` string the jump leaves pops the functions
/// called inside it (its `pe_dispose`); the `.` command itself stays, with
/// its `source`. After `top_level_cleanup` (an arithmetic subscript error,
/// an integer variable's bad value, `break` with a bad count, a script's
/// own command) or `run_unwind_protects` (a function past `FUNCNEST`) none
/// runs, not even one the shell a subshell forked from was running. `exit`
/// keeps them all. bash's script mode adds `main`.
#[test]
fn the_exit_trap_sees_the_functions_a_jump_leaves() {
	const T1: &str = "trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} n=$#\"' EXIT; ";
	const T2: &str = "trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} n=$#\" >&2' EXIT; ";
	const DIV: &str = "SH: 1/0: division by 0 (error token is \"0\")\n";
	const RO: &str = "SH: r: readonly variable\n";
	const SUB: &str = "; echo \"x=[$x] s=$?\"";
	const NONE: &str = "T none l=unset n=0\n";
	let rows = [
		(
			"an integer variable's bad value",
			format!(
				"( {T1}f() {{ local l=1; local -i n; n=1/0; echo in; }}; f x y; echo after ); echo \
				 w=$?"
			),
			format!("{DIV}{NONE}w=1\n"),
			0,
		),
		(
			"an integer variable's bad value, a command substitution",
			format!("x=$( {T2}f() {{ local l=1; local -i n; n=1/0; }}; f x y ){SUB}"),
			format!("{DIV}{NONE}x=[] s=1\n"),
			0,
		),
		(
			"an integer variable's bad value, a function's subshell",
			format!("f() {{ local l=0; ( {T1}local -i n; n=1/0; echo in ); echo w=$?; }}; f x y"),
			format!("{DIV}{NONE}w=1\n"),
			0,
		),
		(
			"an integer variable's bad value in posix mode",
			"set -o posix; declare -i n; n=1/0; echo after; echo s=$?".to_owned(),
			DIV.to_owned(),
			1,
		),
		(
			"an arithmetic subscript error, a function's subshell",
			format!("f() {{ local l=0; ( {T1}a[1/0]=v ); echo w=$?; }}; f x y"),
			format!("{DIV}{NONE}w=1\n"),
			0,
		),
		(
			"an arithmetic subscript error, a function's command substitution",
			format!("f() {{ local l=0; x=$( {T2}a[1/0]=v ){SUB}; }}; f x y"),
			format!("{DIV}{NONE}x=[] s=1\n"),
			0,
		),
		(
			"break, a subshell",
			format!("( {T1}f() {{ local l=1; for i in 1; do break x; done; }}; f x y ); echo w=$?"),
			format!("SH: break: x: numeric argument required\n{NONE}w=2\n"),
			0,
		),
		(
			"FUNCNEST, a subshell",
			format!("( {T1}FUNCNEST=3; f() {{ local l=1; f; }}; f x y; echo after ); echo w=$?"),
			format!("SH: f: maximum function nesting level exceeded (3)\n{NONE}w=1\n"),
			0,
		),
		(
			"FUNCNEST, a function's subshell",
			format!(
				"f() {{ local l=0; ( {T1}FUNCNEST=5; g() {{ local l=1; g; }}; g p ); echo w=$?; }}; f \
				 x y"
			),
			format!("SH: g: maximum function nesting level exceeded (5)\n{NONE}w=1\n"),
			0,
		),
	];
	let rows: Vec<_> = rows
		.iter()
		.map(|(n, s, w, st)| (*n, s.as_str(), w.as_str(), *st))
		.collect();
	assert_rows(&rows);
	// Rows whose `FUNCNAME` bash's script mode ends with `main`, or that it
	// runs differently: (name, script, -c output and status, script's).
	let in_sub = |body: &str| {
		format!(
			"readonly r=1; shopt -s failglob; f() {{ local l=0; x=$( {T2}g() {{ local l=1; {body}; \
			 }}; g p ){SUB}; }}; f x y"
		)
	};
	let by_mode = [
		("a readonly variable in a command substitution", in_sub("r=2"), RO.to_owned()),
		(
			"failglob in a command substitution",
			in_sub(": /nonexistent*"),
			"SH: no match: /nonexistent*\n".to_owned(),
		),
		("arithmetic in a command substitution", in_sub(": $((1/0))"), DIV.to_owned()),
		("an eval in a command substitution", in_sub("eval 'r=2'"), RO.to_owned()),
		(
			"an expansion error in a command substitution",
			in_sub("echo ${x:?u}"),
			"SH: x: u\n".to_owned(),
		),
	];
	let mut mode_rows: Vec<OwnedModeRow> = by_mode
		.into_iter()
		.map(|(n, s, msg)| {
			(
				n.to_owned(),
				s,
				(format!("{msg}T f l=0 n=2\nx=[] s=1\n"), 0),
				(format!("{msg}T f main l=0 n=2\nx=[] s=1\n"), 0),
			)
		})
		.collect();
	let both =
		|c: &str, s: &str, tail: &str, st: i32| (format!("{c}{tail}"), st, format!("{s}{tail}"), st);
	for (name, script, (c, cs, s, ss)) in [
		(
			"a process substitution",
			format!(
				"readonly r=1; f() {{ local l=0; cat <( {T1}g() {{ local l=1; r=2; }}; g p ); echo \
				 done; }}; f x y"
			),
			both(&format!("{RO}T f l=0 n=2\n"), &format!("{RO}T f main l=0 n=2\n"), "done\n", 0),
		),
		(
			"an eval in a subshell",
			format!(
				"readonly r=1; ( {T1}f() {{ local l=1; eval 'g() {{ local l=2; r=2; }}; g p'; }}; f x \
				 y; echo after ); echo w=$?"
			),
			both(&format!("{RO}T f l=1 n=2\n"), &format!("{RO}T f main l=1 n=2\n"), "w=1\n", 0),
		),
		(
			"a . file in a subshell",
			format!(
				"readonly r=1; printf 'g() {{ local l=2; r=2; }}; g p\\n' > d.sh; ( {T1}f() {{ local \
				 l=1; . ./d.sh; }}; f x y; echo after ); echo w=$?"
			),
			both(
				&format!("{RO}T source f l=1 n=2\n"),
				&format!("{RO}T source f main l=1 n=2\n"),
				"w=1\n",
				0,
			),
		),
		(
			"a trap action in a subshell",
			format!(
				"readonly r=1; ( {T1}trap 'g p' USR1; f() {{ local l=1; kill -USR1 $BASHPID; echo in; \
				 }}; g() {{ local l=3; r=2; }}; f x y; echo after ); echo w=$?"
			),
			both(&format!("{RO}T f l=1 n=2\n"), &format!("{RO}T f main l=1 n=2\n"), "w=1\n", 0),
		),
		(
			"a readonly variable in a subshell",
			format!("readonly r=1; ( {T1}f() {{ local l=1; r=2; }}; f x y; echo after ); echo w=$?"),
			both(&format!("{RO}T f l=1 n=2\n"), &format!("{RO}{NONE}"), "w=1\n", 0),
		),
		(
			"a readonly variable, a function's subshell",
			format!("readonly r=1; f() {{ local l=0; ( {T1}r=2 ); echo w=$?; }}; f x y"),
			both(&format!("{RO}T f l=0 n=2\n"), &format!("{RO}{NONE}"), "w=1\n", 0),
		),
		(
			"an expansion error",
			format!("{T1}f() {{ local l=1; echo ${{x:?u}}; }}; f x y"),
			(format!("SH: x: u\n{NONE}"), 127, format!("SH: x: u\n{NONE}"), 1),
		),
		(
			"an expansion error in an eval",
			format!("{T1}f() {{ local l=1; eval 'echo ${{x:?u}}'; }}; f x y"),
			(format!("SH: x: u\n{NONE}"), 127, "SH: x: u\nT f main l=1 n=2\n".to_owned(), 1),
		),
		(
			"exit",
			format!("( {T1}f() {{ local l=1; exit 3; }}; f x y ); echo w=$?"),
			both("T f l=1 n=2\n", "T f main l=1 n=2\n", "w=3\n", 0),
		),
	] {
		mode_rows.push((name.to_owned(), script, (c, cs), (s, ss)));
	}
	let mode_rows: Vec<_> = mode_rows
		.iter()
		.map(|(n, s, (c, cs), (w, ws))| {
			(n.as_str(), s.as_str(), (c.as_str(), *cs), (w.as_str(), *ws))
		})
		.collect();
	assert_rows_by_mode(&mode_rows);
}

/// An associative array's compound value with an empty key reports it and
/// assigns none of the words after it (bash's `break`); `declare` shows the
/// word quoted. bash 5.3 also discards the rest of a `declare` line, so the
/// array is read on the next one.
#[test]
fn an_empty_key_stops_a_compound_value() {
	assert_rows(&[
		(
			"declare",
			"declare -A A=([k]=v []=x [j]=w)\ndeclare -p A",
			"SH: ['']='x': bad array subscript\ndeclare -A A=([k]=\"v\" )\n",
			0,
		),
		(
			"an assignment",
			"declare -A A; A=([k]=v []=x [j]=w)\ndeclare -p A",
			"SH: []=x: bad array subscript\ndeclare -A A=([k]=\"v\" )\n",
			0,
		),
	]);
}

/// In posix mode an integer variable's bad value discards the command:
/// bash's `make_variable_value` jumps before the assignment can fail and
/// exit (variables.c:2944). A script's next line runs; under `-c` the
/// whole string ends after the `top_level_cleanup`, with status 1.
#[test]
fn an_integer_value_error_in_posix_mode_discards_the_line() {
	const ERR: &str = "SH: 1/0: division by 0 (error token is \"0\")\n";
	let script = "set -o posix; declare -i n; n=1/0\necho after";
	let got = run(script, Mode::Script);
	assert_eq!(got, (format!("{ERR}after\n"), Some(0)), "script mode");
	let got = run(script, Mode::C);
	assert_eq!(got, (ERR.to_owned(), Some(1)), "-c mode");
}

/// `break` or `continue` with a count that is not a number runs bash's
/// `top_level_cleanup` before it leaves the shell: every redirection is
/// undone, and a `time` started inside the `-c` string or an `eval` loses
/// its catch, so only a script's own `time`s report, on the shell's stderr.
#[test]
fn break_with_a_bad_count_cleans_up_first() {
	const MSG: &str = "SH: break: x: numeric argument required\n";
	assert_rows(&[(
		"in eval",
		"( for i in 1; do eval 'time { break x; } 2>e1'; done ); echo w=$?; echo e1:; cat e1",
		"w=2\ne1:\nSH: break: x: numeric argument required\n",
		0,
	)]);
	let c = format!("w=2\ne1:\n{MSG}");
	let s = format!("report\nw=2\ne1:\n{MSG}");
	assert_rows_by_mode(&[
		(
			"group",
			"( for i in 1; do time { break x; } 2>e1; done ); echo w=$?; echo e1:; cat e1",
			(&c, 0),
			(&s, 0),
		),
		(
			"time eval, in a function",
			"( f() { for i in 1; do time eval '{ break x; } 2>e1'; done; }; f ); echo w=$?; echo \
			 e1:; cat e1",
			(&c, 0),
			(&s, 0),
		),
		("the shell", "for i in 1; do time { break x; } 2>e1; done", ("", 2), ("report\n", 2)),
		(
			"continue",
			"( for i in 1; do time eval '{ continue x; } 2>e1'; done ); echo w=$?; echo e1:; cat e1",
			("w=2\ne1:\nSH: continue: x: numeric argument required\n", 0),
			("report\nw=2\ne1:\nSH: continue: x: numeric argument required\n", 0),
		),
	]);
}

/// A posix shell leaves on a special builtin's error by bash's `ERREXIT`
/// (`execute_cmd.c`, lines 1005 and 4872): under `set -e` in a function the
/// innermost `eval` keeps its redirections, so the report and the EXIT trap
/// go into them; without `set -e` every level undoes.
#[test]
fn a_posix_special_builtins_error_is_errexit() {
	const MISSING: &str = "SH: missing: No such file or directory\n";
	let kept = format!("w=1\ne1:\n{MISSING}report\n");
	let undone = format!("report\nw=1\ne1:\n{MISSING}");
	let trapped = format!("w=1\ne1:\n{MISSING}report\nT\n");
	assert_rows(&[
		(
			"set -e",
			"( set -o posix; set -e; f() { time eval '{ : <missing; } 2>e1'; }; f ); echo w=$?; echo \
			 e1:; cat e1",
			&kept,
			0,
		),
		(
			"set -e, EXIT trap",
			"( set -o posix; set -e; trap 'echo T >&2' EXIT; f() { time eval '{ : <missing; } 2>e1'; \
			 }; f ); echo w=$?; echo e1:; cat e1",
			&trapped,
			0,
		),
		(
			"set -e, a usage error",
			"( set -o posix; set -e; f() { time eval '{ shift 9; } 2>e1'; }; f ); echo w=$?; echo \
			 e1:; cat e1",
			"w=1\ne1:\nSH: shift: 9: shift count out of range\nreport\n",
			0,
		),
		(
			"no set -e",
			"( set -o posix; f() { time eval '{ : <missing; } 2>e1'; }; f ); echo w=$?; echo e1:; \
			 cat e1",
			&undone,
			0,
		),
		(
			"no set -e, a usage error",
			"( set -o posix; f() { time eval '{ shift 9; } 2>e1'; }; f ); echo w=$?; echo e1:; cat e1",
			"report\nw=1\ne1:\nSH: shift: 9: shift count out of range\n",
			0,
		),
		(
			"set -e, an inner eval",
			"( set -o posix; set -e; f() { time eval '{ eval \": <missing\"; } 2>e1'; }; f ); echo \
			 w=$?; echo e1:; cat e1",
			&undone,
			0,
		),
		(
			"set -e, no function",
			"( set -o posix; set -e; time eval '{ : <missing; } 2>e1' ); echo w=$?; echo e1:; cat e1",
			&undone,
			0,
		),
	]);
}

/// Under `set -e` bash's `report_error` (a readonly variable assigned, an
/// unbound one, `${x:?}`, a bad array subscript, a list assigned to an array
/// element, an associative array's element without a key, an invalid
/// variable name, a `failglob` miss, a file `.` cannot read) exits the shell
/// itself: no jump, so no `time` reports. In an assignment, a posix special
/// builtin's assignment, `let`, `(( ))`, `read`, `printf -v`, `export`,
/// `declare`, `local`, `.`, an expansion, in a condition and in a function
/// called there; the status is `$?`, or 1. Not without `set -e`, and not
/// inside an `eval`, `.` or a builtin run through `command` that a
/// condition runs (bash turns the flag off there; `builtin` does not), nor
/// for `declare`'s own message.
#[test]
fn report_error_under_set_e_leaves_without_a_report() {
	const RO: &str = "w=1\ne1:\nSH: r: readonly variable\n";
	const TAIL: &str = "; } 2>e1; echo after ); echo w=$?; echo e1:; cat e1";
	let ro = |body: &str| format!("( set -e; readonly r=1; time {{ {body}{TAIL}");
	let rows = [
		("assignment", ro("r=2"), RO),
		("let", ro("let r=2"), RO),
		("(( ))", ro("(( r=2 ))"), RO),
		("read", ro("read r <<< x"), RO),
		("printf -v", ro("printf -v r x"), RO),
		("export", ro("export r=2"), RO),
		("in a condition", ro("r=2 || echo no"), RO),
		(
			"in a function in a condition",
			format!("( set -e; readonly r=1; f() {{ r=2; }}; time {{ f || echo no{TAIL}"),
			RO,
		),
		(
			"parameter error",
			format!("( set -e; time {{ echo ${{x:?u}}{TAIL}"),
			"w=1\ne1:\nSH: x: u\n",
		),
		(
			"unbound",
			format!("( set -eu; time {{ echo $u{TAIL}"),
			"w=1\ne1:\nSH: u: unbound variable\n",
		),
		(
			"bad subscript",
			format!("( set -e; time {{ b[]=x{TAIL}"),
			"w=1\ne1:\nSH: b[]: bad array subscript\n",
		),
		(
			"invalid variable name",
			format!("( set -e; x=; time {{ echo ${{!x}}{TAIL}"),
			"w=1\ne1:\nSH: : invalid variable name\n",
		),
		(
			"failglob",
			format!("( set -e; shopt -s failglob; time {{ echo /nonexist*{TAIL}"),
			"w=1\ne1:\nSH: no match: /nonexist*\n",
		),
		(
			"eval in a condition",
			format!("( set -eu; time {{ eval 'echo $u' || echo no{TAIL}"),
			"w=1\ne1:\nSH: u: unbound variable\nreport\n",
		),
		("declare", ro("declare r=2"), "w=1\ne1:\nSH: declare: r: readonly variable\nreport\n"),
		(
			"command in a condition",
			ro("command export r=2 || echo no"),
			"no\nreport\nafter\nw=0\ne1:\nSH: r: readonly variable\n",
		),
		(
			"command in a function in a condition",
			format!(
				"( set -e; readonly r=1; f() {{ command export r=2; }}; time {{ f || echo no{TAIL}"
			),
			"no\nreport\nafter\nw=0\ne1:\nSH: r: readonly variable\n",
		),
		("command", ro("command export r=2"), RO),
		("builtin in a condition", ro("builtin export r=2 || echo no"), RO),
		(
			"command builtin in a condition",
			ro("command builtin export r=2 || echo no"),
			"no\nreport\nafter\nw=0\ne1:\nSH: r: readonly variable\n",
		),
		(
			"builtin . in a condition",
			format!("( set -e; time {{ builtin . ./missing || echo no{TAIL}"),
			"w=1\ne1:\nSH: ./missing: No such file or directory\n",
		),
		("builtin command in a condition", ro("builtin command export r=2 || echo no"), RO),
		("builtin eval in a condition", ro("builtin eval 'r=2' || echo no"), RO),
		(
			"command in an && list",
			ro("command export r=2 && echo yes"),
			"report\nafter\nw=0\ne1:\nSH: r: readonly variable\n",
		),
		(
			". in a condition",
			format!("( set -e; time {{ . ./missing || echo no{TAIL}"),
			"no\nreport\nafter\nw=0\ne1:\nSH: ./missing: No such file or directory\n",
		),
		(
			"command . in a condition",
			format!("( set -e; time {{ command . ./missing || echo no{TAIL}"),
			"no\nreport\nafter\nw=0\ne1:\nSH: ./missing: No such file or directory\n",
		),
		("declare, a compound value", ro("declare r=(1)"), RO),
		(
			"local, a compound value",
			format!("( set -e; readonly r=1; f() {{ local r=(1); }}; time {{ f{TAIL}"),
			"w=1\ne1:\nSH: f: r: readonly variable\nSH: local: r: readonly variable\nreport\n",
		),
		(
			"declare -a, a compound value",
			format!("( set -e; readonly r=1; f() {{ declare -a r=(1); }}; time {{ f{TAIL}"),
			"w=1\ne1:\nSH: f: r: readonly variable\nSH: declare: r: readonly variable\nreport\n",
		),
		(
			"declare, a bad subscript",
			format!("( set -e; time {{ declare -a a=([-9]=x){TAIL}"),
			"w=1\ne1:\nSH: [-9]=x: bad array subscript\n",
		),
		(
			"local, a bad subscript",
			format!("( set -e; f() {{ local -a a=([-9]=x); }}; time {{ f{TAIL}"),
			"w=1\ne1:\nSH: [-9]=x: bad array subscript\n",
		),
		(
			"declare, a bad element",
			format!("( set -e; time {{ declare a[-9]=x{TAIL}"),
			"w=1\ne1:\nSH: a[-9]: bad array subscript\n",
		),
		(
			". of a missing file",
			format!("( set -e; time {{ . ./missing{TAIL}"),
			"w=1\ne1:\nSH: ./missing: No such file or directory\n",
		),
		(
			". in posix mode",
			format!("( set -o posix; set -e; time {{ . ./missing{TAIL}"),
			"w=1\ne1:\nSH: ./missing: No such file or directory\n",
		),
		(
			"a list to an element",
			format!("( set -e; time {{ a[0]=(1){TAIL}"),
			"w=1\ne1:\nSH: a[0]: cannot assign list to array member\n",
		),
		(
			"an element without a key",
			format!("( set -e; declare -A A; time {{ A=([k]=v x){TAIL}"),
			"w=1\ne1:\nSH: A: x: must use subscript when assigning associative array\n",
		),
		(
			"declare, an element without a key",
			format!("( set -e; time {{ declare -A A=([k]=v x){TAIL}"),
			"w=1\ne1:\nSH: A: 'x': must use subscript when assigning associative array\n",
		),
		(
			"an empty subscript",
			format!("( set -e; time {{ a=([]=x){TAIL}"),
			"w=1\ne1:\nSH: []=x: bad array subscript\n",
		),
		(
			"a non-numeric index",
			format!("( set -e; time {{ a=([@]=x){TAIL}"),
			"w=1\ne1:\nSH: [@]=x: cannot assign to non-numeric index\n",
		),
		(
			"let, unbound",
			format!("( set -eu; time {{ let u{TAIL}"),
			"w=1\ne1:\nSH: u: unbound variable\n",
		),
		(
			"an empty key",
			format!("( set -e; declare -A A; time {{ A=([]=x){TAIL}"),
			"w=1\ne1:\nSH: []=x: bad array subscript\n",
		),
		(
			"declare, a list to an element",
			format!("( set -e; time {{ declare a[0]=(1){TAIL}"),
			"w=1\ne1:\nSH: a[0]: cannot assign list to array member\n",
		),
	];
	let rows: Vec<_> = rows
		.iter()
		.map(|(n, s, w)| (*n, s.as_str(), *w, 0))
		.collect();
	assert_rows(&rows);
	assert_rows(&[
		(
			"posix special builtin",
			"( set -o posix; set -e; f() { time eval '{ readonly r=1; r=2 :; } 2>e1'; }; f ); echo \
			 w=$?; echo e1:; cat e1",
			RO,
			0,
		),
		(
			"EXIT trap",
			"( set -e; trap 'echo T >&2' EXIT; f() { time eval '{ readonly r=1; r=2; } 2>/dev/null'; \
			 }; f ); echo w=$?",
			"w=1\n",
			0,
		),
		("the shell", "set -e; readonly r=1; time { r=2; } 2>/dev/null; echo after", "", 1),
		(
			"status",
			"( set -e; false || readonly r=1; (exit 5) || r=2; echo after ); echo w=$?",
			"SH: r: readonly variable\nw=5\n",
			0,
		),
		(
			"command in an if",
			"( set -e; readonly r=1; if command export r=2; then :; else echo no; fi; echo after ); \
			 echo w=$?",
			"SH: r: readonly variable\nno\nafter\nw=0\n",
			0,
		),
		(
			"command in a ! pipeline",
			"( set -e; readonly r=1; ! command export r=2; echo after ); echo w=$?",
			"SH: r: readonly variable\nafter\nw=0\n",
			0,
		),
		(
			"status, .",
			"( set -e; (exit 5) || . ./missing; echo after ); echo w=$?",
			"SH: ./missing: No such file or directory\nw=5\n",
			0,
		),
		(
			"status, a list to an element",
			"( set -e; (exit 5) || a[0]=(1); echo after ); echo w=$?",
			"SH: a[0]: cannot assign list to array member\nw=5\n",
			0,
		),
		(
			"status, let",
			"( set -eu; (exit 5) || let u; echo after ); echo w=$?",
			"SH: u: unbound variable\nw=1\n",
			0,
		),
	]);
	assert_rows_by_mode(&[(
		"no set -e",
		"( readonly r=1; time { r=2; } 2>e1; echo after ); echo w=$?; echo e1:; cat e1",
		("w=1\ne1:\nSH: r: readonly variable\nreport\n", 0),
		("report\nw=1\ne1:\nSH: r: readonly variable\n", 0),
	)]);
}

/// A subshell forked inside a function runs in the function's context (the
/// scope, not the subshell's own frames), and counts only its own EXIT trap,
/// not its parent's, set or ignored.
#[test]
fn a_subshell_of_a_function_and_its_own_exit_trap() {
	assert_rows(&[
		(
			"set -e",
			"f() { ( set -e; time eval '{ false; } 2>/dev/null' ); }; f; echo w=$?",
			"w=1\n",
			0,
		),
		(
			"set -e, two evals",
			"f() { ( set -e; time eval 'eval \"{ false; } 2>e2\"' ); }; f; echo w=$?; echo e2:; cat \
			 e2",
			"w=1\ne2:\nreport\n",
			0,
		),
		(
			"the parent's EXIT trap",
			"trap 'echo T >&2' EXIT; f() { ( time eval '{ exit 3; } 2>/dev/null' ); }; f; echo w=$?; \
			 trap - EXIT",
			"report\nw=3\n",
			0,
		),
		(
			"the parent's EXIT trap, ignored",
			"trap '' EXIT; f() { ( time eval '{ exit 3; } 2>e1' ); }; f; echo w=$?; trap - EXIT; \
			 echo e1:; cat e1",
			"report\nw=3\ne1:\n",
			0,
		),
	]);
}
