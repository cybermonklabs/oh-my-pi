//! `time ( … )` times the subshell inside its fork, as bash does: bash
//! forks before any `time_command` runs, and the fork makes the subshell's
//! own redirections, then gives the `time` to the command inside it
//! (`execute_in_subshell`). So the report goes through those redirections
//! (`time ( … ) 2> e` reports into `e`; one that fails leaves no report),
//! reads the fork's `TIMEFORMAT` and comes before the fork's EXIT trap; a
//! body that is one `( … )` alone passes the time on, and a `time` inside it
//! merges into one report. `exec`, a killed fork and a closed stderr leave no
//! report. bash's `time_command` gives no report for a jump once the
//! subshell environment changed under it, which a fork's first `trap` call
//! with arguments does (it clears `SUBSHELL_RESETTRAP`): after that, a jump
//! out of a `time` the fork started before reports nothing. A posix special
//! builtin's error that ends the shell or the fork undoes the builtin's own
//! redirections before that jump, so its report goes outside them.
//!
//! Each row runs twice, as `-c` text and from a script file. Every row was
//! measured against bash 5.3.20 and 5.2.21 both ways, as uid 1000 and as
//! root, under runc and gVisor; the bashes agree on each once an error
//! line's `NAME: line N: ` prefix reads `SH: ` and `trap`'s usage line is
//! set aside.

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

/// A row's output with each error line's `NAME: line N: ` prefix as `SH: `,
/// a `time -p` line's digits as 0, and `trap`'s usage line as
/// `trap: usage: ...` (bash 5.3 and 5.2 word it differently).
fn normalize_output(bytes: &[u8]) -> String {
	String::from_utf8_lossy(bytes)
		.lines()
		.map(|l| {
			let l = match l.find(": line ") {
				Some(i) => l[i + 7..]
					.find(": ")
					.map_or_else(|| l.to_owned(), |j| format!("SH: {}", &l[i + 7 + j + 2..])),
				None => l.to_owned(),
			};
			if ["real ", "user ", "sys "].iter().any(|p| l.starts_with(p)) {
				l.replace(|c: char| c.is_ascii_digit(), "0") + "\n"
			} else if l.starts_with("trap: usage: ") {
				"trap: usage: ...\n".to_owned()
			} else {
				l + "\n"
			}
		})
		.collect()
}

/// Runs `script` with stderr on stdout and `TIMEFORMAT=report` in a private
/// directory (a row may write files there); the output is normalized
/// ([`normalize_output`]). `with_file` appends `f=[…]`, the normalized
/// contents of the file `f` the row wrote: a row whose shell exits can still
/// show where its messages went. Returns the output and the exit status.
fn run(script: &str, mode: Mode, with_file: bool) -> (String, Option<i32>) {
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
	let mut text = normalize_output(&out.stdout);
	if with_file {
		let file = std::fs::read(dir.path().join("f")).unwrap_or_default();
		text.push_str("f=[");
		text.push_str(normalize_output(&file).trim_end());
		text.push_str("]\n");
	}
	(text, out.status.code())
}

/// A row: its name, script, output (stderr on stdout) and status, the same
/// in both modes.
type Row<'a> = (&'a str, &'a str, &'a str, i32);

/// Every row whose output or status differs, in either mode, is listed. The
/// runs go side by side (each is its own shell), [`SHELLS_AT_ONCE`] at a
/// time. `with_file`: as [`run`]'s.
fn check_rows(rows: &[Row<'_>], with_file: bool) {
	let runs: Vec<_> = rows
		.iter()
		.flat_map(|&(name, script, want, status)| {
			[(name, script, Mode::C, want, status), (name, script, Mode::Script, want, status)]
		})
		.collect();
	let got: Vec<_> = std::thread::scope(|scope| {
		let mut handles = Vec::with_capacity(runs.len());
		for &(_, script, mode, ..) in &runs {
			handles.push(scope.spawn(move || run(script, mode, with_file)));
		}
		handles
			.into_iter()
			.map(|h| h.join().expect("row thread"))
			.collect()
	});
	let mismatches: Vec<String> = runs
		.iter()
		.zip(got)
		.filter_map(|(&(name, _, mode, want, status), got)| {
			(got != (String::from(want), Some(status)))
				.then(|| format!("{name} ({mode:?}): {got:?}, want ({want:?}, {status})"))
		})
		.collect();
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// [`check_rows`] of the output alone.
fn assert_rows(rows: &[Row<'_>]) {
	check_rows(rows, false);
}

/// [`check_rows`] of the output and the file `f`.
fn assert_rows_with_file(rows: &[Row<'_>]) {
	check_rows(rows, true);
}

/// A posix special builtin's error that ends the shell (its usage error, or
/// a redirection of its that fails) undoes the builtin's own redirections
/// first, as bash's `execute_builtin_or_function` does before the `ERREXIT`
/// jump: the `time` around it reports through the redirections outside the
/// builtin, in a timed `( … )` (the fork exits) and in a timed group (the
/// shell exits). The error message still goes through them.
#[test]
fn a_posix_special_builtins_error_reports_outside_its_redirections() {
	assert_rows(&[
		(
			"trap usage, subshell",
			"set -o posix; time ( trap INT 2> /dev/null ); echo \"s=$?\"",
			"report\ns=2\n",
			0,
		),
		(
			"unset usage, subshell",
			"set -o posix; time ( unset -x 2> /dev/null ); echo \"s=$?\"",
			"report\ns=2\n",
			0,
		),
		("trap usage, group", "set -o posix; time { trap INT 2> /dev/null; }", "report\n", 2),
		("unset usage, group", "set -o posix; time { unset -x 2> /dev/null; }", "report\n", 2),
		(
			"failed redirection, subshell",
			"set -o posix; time ( : 2> /dev/null >&9 ); echo \"s=$?\"",
			"report\ns=1\n",
			0,
		),
		("failed redirection, group", "set -o posix; time { : 2> /dev/null >&9; }", "report\n", 1),
	]);
	let unset = "SH: unset: -x: invalid option\nunset: usage: unset [-f] [-v] [-n] [name ...]";
	assert_rows_with_file(&[
		(
			"trap usage to a file, subshell",
			"set -o posix; time ( trap INT 2> f ); echo \"s=$?\"",
			"report\ns=2\nf=[trap: usage: ...]\n",
			0,
		),
		(
			"unset usage to a file, subshell",
			"set -o posix; time ( unset -x 2> f ); echo \"s=$?\"",
			&format!("report\ns=2\nf=[{unset}]\n"),
			0,
		),
		(
			"trap usage to a file, group",
			"set -o posix; time { trap INT 2> f; }",
			"report\nf=[trap: usage: ...]\n",
			2,
		),
		(
			"unset usage to a file, group",
			"set -o posix; time { unset -x 2> f; }",
			&format!("report\nf=[{unset}]\n"),
			2,
		),
		(
			"failed redirection to a file, subshell",
			"set -o posix; time ( : 2> f >&9 ); echo \"s=$?\"",
			"report\ns=1\nf=[SH: 9: Bad file descriptor]\n",
			0,
		),
		(
			"failed redirection to a file, group",
			"set -o posix; time { : 2> f >&9; }",
			"report\nf=[SH: 9: Bad file descriptor]\n",
			1,
		),
	]);
}

/// The guards of that rule: `exit` jumps from inside the builtin, with its
/// redirections in effect (no report through `2> /dev/null`), and `set -e`
/// keeps its own order (the builtin's redirections are undone, a group's
/// are not).
#[test]
fn exit_and_set_e_keep_their_order() {
	assert_rows(&[
		("exit", "time ( exit 3 2> /dev/null ); echo \"s=$?\"", "s=3\n", 0),
		("set -e, builtin", "set -e; time ( false 2> /dev/null; echo no )", "report\n", 1),
		("set -e, group", "set -e; time ( { false; } 2> /dev/null )", "", 1),
	]);
}

/// The report goes through the subshell's own redirections, which bash
/// makes in the fork before it times the body: also after `exit` or
/// `set -e`, under `!`, in `time -p`'s format, as a job, in a function, a
/// condition, a loop and posix mode, through `exec`'s own redirection, and
/// from the innermost of nested `( … )`s that are each a body alone.
#[test]
fn the_report_goes_through_the_subshells_own_redirections() {
	let e = "; echo \"s=$?\"; echo \"e=[$(cat e)]\"";
	assert_rows(&[
		("exit", &format!("time ( exit 3 ) 2> e{e}"), "s=3\ne=[report]\n", 0),
		("set -e", &format!("time ( set -e; false ) 2> e{e}"), "s=1\ne=[report]\n", 0),
		("nested", &format!("time ( ( echo in ) 2> e ){e}"), "in\ns=0\ne=[report]\n", 0),
		("three deep", &format!("time ( ( ( echo in ) 2> e ) ){e}"), "in\ns=0\ne=[report]\n", 0),
		("bang", &format!("time ! ( echo in ) 2> e{e}"), "in\ns=1\ne=[report]\n", 0),
		("bang inside", &format!("time ( ! ( echo in ) 2> e ){e}"), "in\ns=1\ne=[report]\n", 0),
		(
			"posix format",
			"time -p ( echo in ) 2> e; echo \"s=$?\"; cat e",
			"in\ns=0\nreal 0.00\nuser 0.00\nsys 0.00\n",
			0,
		),
		("job", &format!("time ( echo in ) 2> e & wait $!{e}"), "in\ns=0\ne=[report]\n", 0),
		("function", &format!("f() {{ time ( echo in ) 2> e; }}; f{e}"), "in\ns=0\ne=[report]\n", 0),
		(
			"condition",
			"if time ( false ) 2> e; then echo y; else echo n; fi; echo \"e=[$(cat e)]\"",
			"n\ne=[report]\n",
			0,
		),
		(
			"loop body",
			&format!("for i in 1; do time ( echo $i ) 2> e; done{e}"),
			"1\ns=0\ne=[report]\n",
			0,
		),
		(
			"posix mode",
			&format!("set -o posix; time ( echo in ) 2> e{e}"),
			"in\ns=0\ne=[report]\n",
			0,
		),
		("exec redirects", &format!("time ( exec 2> e; echo in ){e}"), "in\ns=0\ne=[report]\n", 0),
	]);
}

/// The report reads the fork's state: the `TIMEFORMAT` the body set, and
/// the fork's `$BASH_SUBSHELL` is 1 also as a job (one fork, not two).
#[test]
fn the_report_reads_the_forks_state() {
	assert_rows(&[
		(
			"format set inside",
			"time ( TIMEFORMAT=inner; echo in ); echo \"s=$?\"",
			"in\ninner\ns=0\n",
			0,
		),
		("depth", "time ( echo \"d=$BASH_SUBSHELL\" ) 2> /dev/null; echo \"s=$?\"", "d=1\ns=0\n", 0),
		(
			"depth of a job",
			"time ( echo \"d=$BASH_SUBSHELL\" ) 2> /dev/null & wait $!; echo \"s=$?\"",
			"d=1\ns=0\n",
			0,
		),
	]);
}

/// A `time` inside a `( … )` that is the timed body alone merges into the
/// outer one: one report, in `time -p`'s format if either asks for it.
#[test]
fn an_inner_time_makes_no_second_report() {
	assert_rows(&[
		("plain", "time ( time ( echo in ) ); echo \"s=$?\"", "in\nreport\ns=0\n", 0),
		(
			"-p outside",
			"time -p ( time ( echo in ) ); echo \"s=$?\"",
			"in\nreal 0.00\nuser 0.00\nsys 0.00\ns=0\n",
			0,
		),
		(
			"-p inside",
			"time ( time -p ( echo in ) ); echo \"s=$?\"",
			"in\nreal 0.00\nuser 0.00\nsys 0.00\ns=0\n",
			0,
		),
	]);
}

/// At the body's normal end the report comes before the fork's EXIT trap.
#[test]
fn the_report_comes_before_the_forks_exit_trap() {
	assert_rows(&[
		("empty body", "time ( trap 'echo T >&2' EXIT; : ); echo \"s=$?\"", "report\nT\ns=0\n", 0),
		(
			"body with output",
			"time ( trap 'echo T >&2' EXIT; echo in ); echo \"s=$?\"",
			"in\nreport\nT\ns=0\n",
			0,
		),
	]);
}

/// Once the fork has run `trap` with arguments (setting, ignoring or
/// resetting a trap, even with a bad signal name), a jump out of a `time`
/// it started before reports nothing: `exit` (also in a function), `set -e`
/// (also after an ERR trap), a fatal expansion error, nested `( … )`s, a
/// `time` inside the timed one, and a timed group in a subshell, a command
/// substitution, a job, a pipeline stage, and a process substitution or the
/// not-found hook run from a subshell (each keeps the subshell's flag). A
/// `time` the fork starts after that `trap` call reports.
#[test]
fn a_jump_after_the_fork_runs_trap_reports_nothing() {
	let t = "trap 'echo T >&2' EXIT";
	assert_rows(&[
		("exit", &format!("time ( {t}; exit 3 ); echo \"s=$?\""), "T\ns=3\n", 0),
		("set -e", &format!("time ( {t}; set -e; false; echo no ); echo \"s=$?\""), "T\ns=1\n", 0),
		(
			"fatal error",
			&format!("time ( {t}; : ${{zz?u}}; echo no ); echo \"s=$?\""),
			"SH: zz: u\nT\ns=1\n",
			0,
		),
		(
			"exit in a function",
			&format!("f() {{ exit 4; }}; time ( {t}; f ); echo \"s=$?\""),
			"T\ns=4\n",
			0,
		),
		(
			"trap in a function",
			&format!("f() {{ {t}; exit 4; }}; time ( f ); echo \"s=$?\""),
			"T\ns=4\n",
			0,
		),
		(
			"trap in eval",
			"time ( eval \"trap 'echo T >&2' EXIT\"; exit 3 ); echo \"s=$?\"",
			"T\ns=3\n",
			0,
		),
		("nested", &format!("time ( ( {t}; exit 3 ) ); echo \"s=$?\""), "T\ns=3\n", 0),
		("ignore", "time ( trap '' INT; exit 3 ); echo \"s=$?\"", "s=3\n", 0),
		("reset", "time ( trap - INT; exit 3 ); echo \"s=$?\"", "s=3\n", 0),
		("lone name", "time ( trap INT; exit 3 ); echo \"s=$?\"", "s=3\n", 0),
		("bad signal", "time ( trap '' BADSIG 2> /dev/null; exit 3 ); echo \"s=$?\"", "s=3\n", 0),
		(
			"ERR trap, set -e",
			"time ( trap 'echo E >&2' ERR; set -e; false; echo no ); echo \"s=$?\"",
			"E\ns=1\n",
			0,
		),
		("two times", &format!("time ( time {{ {t}; exit 3; }} ); echo \"s=$?\""), "T\ns=3\n", 0),
		(
			"a time after the trap",
			"time ( trap 'echo A' INT; time { exit 3; } ); echo \"s=$?\"",
			"report\ns=3\n",
			0,
		),
		(
			"group in a subshell",
			&format!("( time {{ {t}; exit 3; }} ); echo \"s=$?\""),
			"T\ns=3\n",
			0,
		),
		(
			"command substitution",
			&format!("x=$( time {{ {t}; exit 3; }} ); echo \"s=$? x=$x\""),
			"T\ns=3 x=\n",
			0,
		),
		("job", &format!("time {{ {t}; exit 3; }} & wait $!; echo \"s=$?\""), "T\ns=3\n", 0),
		(
			"pipeline stage",
			&format!("{{ time {{ {t}; exit 3; }}; }} | cat; echo \"s=$?\""),
			"T\ns=0\n",
			0,
		),
		(
			"process substitution in a subshell",
			&format!("( cat <( time {{ {t}; exit 3; }} ); wait $! ); echo \"s=$?\""),
			"T\ns=3\n",
			0,
		),
		(
			"not-found hook in a subshell",
			"( command_not_found_handle() { time { trap '' INT; exit 3; }; }; nosuch ); echo \"s=$?\"",
			"s=3\n",
			0,
		),
	]);
}

/// The `case` pattern of bash's notice of a fork's death, by the name the
/// shell writes it under: by `KILL`, `NAME: line N: PID Killed …`, where
/// `NAME` is `$0` (a `-c` string's, or the script's); by `TERM`,
/// `Terminated`, alone in bash 5.2 and with the command after it in bash
/// 5.3.
const DEATH_NOTICE: &str = "\"$0: line \"*\" Killed \"* | Terminated | \"Terminated \"*";

/// A row that times `( body )` and prints each line of its stderr but the
/// shell's notice of the fork's death ([`DEATH_NOTICE`]), then `end`: a
/// report that is left fails the row however it is spelled, also one joined
/// to the notice. The notice is found by the name it starts with, not by a
/// word it holds: `$0` is a path, which may hold any word (a Bazel test's
/// runfiles path holds this file's name).
fn left_by(body: &str) -> String {
	format!(
		"{{ time ( {body} ); }} 2>&1 | while IFS= read -r l || [ -n \"$l\" ]; do case $l in \
		 {DEATH_NOTICE}) ;; *) printf '%s\\n' \"$l\" ;; esac; done; echo end"
	)
}

/// `exec` and a killed fork leave no report, nor does a closed stderr; a
/// failed `exec` ends the fork with no report, and `return` passes the
/// fork's `time` (bash's `return_catch` sits outside `time_command`). A
/// killed fork leaves nothing but the notice of its death ([`left_by`]);
/// a report and the fork's own words are left.
#[test]
fn exec_a_killed_fork_and_a_closed_stderr_report_nothing() {
	assert_rows(&[
		("exec", "time ( exec /bin/true ); echo \"s=$?\"", "s=0\n", 0),
		("exec later", "time ( : ; exec /bin/true ); echo \"s=$?\"", "s=0\n", 0),
		(
			"exec fails",
			"time ( exec /no/such/cmd ); echo \"s=$?\"",
			"SH: /no/such/cmd: No such file or directory\ns=127\n",
			0,
		),
		("killed", &left_by("kill -9 $BASHPID"), "end\n", 0),
		("terminated", &left_by("kill -TERM $BASHPID"), "end\n", 0),
		(
			"a word holding report is left",
			&left_by("echo noreport >&2; kill -9 $BASHPID"),
			"noreport\nend\n",
			0,
		),
		("a report is left", &left_by(":"), "report\nend\n", 0),
		("stderr closed", "time ( echo in ) 2>&-; echo \"s=$?\"", "in\ns=0\n", 0),
		("stderr closed, exit", "time ( exit 3 ) 2>&-; echo \"s=$?\"", "s=3\n", 0),
		("stderr closed inside", "time ( exec 2>&-; echo in ); echo \"s=$?\"", "in\ns=0\n", 0),
		("return", "f() { time ( return 3 ); echo \"r=$?\"; }; f", "r=3\n", 0),
	]);
}

/// A redirection of the timed `( … )` that fails ends the fork before its
/// `time` starts: no report, in every format, for every kind of failure,
/// through `eval`, a function, a job, a nested `( … )`, a condition, an
/// and-or list, a loop, posix mode and `set -e`.
#[test]
fn a_failed_redirection_of_the_subshell_reports_nothing() {
	let no = "SH: /no/such: No such file or directory\n";
	let s1 = format!("{no}s=1\n");
	assert_rows(&[
		("missing file", "time ( echo in ) < /no/such; echo \"s=$?\"", &s1, 0),
		("posix format", "time -p ( echo in ) < /no/such; echo \"s=$?\"", &s1, 0),
		("default format", "unset TIMEFORMAT; time ( echo in ) < /no/such; echo \"s=$?\"", &s1, 0),
		("fd 3", "time ( echo in ) 3< /no/such; echo \"s=$?\"", &s1, 0),
		("bad fd", "time ( echo in ) >&9; echo \"s=$?\"", "SH: 9: Bad file descriptor\ns=1\n", 0),
		(
			"ambiguous",
			"x='a b'; time ( echo in ) > $x; echo \"s=$?\"",
			"SH: $x: ambiguous redirect\ns=1\n",
			0,
		),
		(
			"noclobber",
			"set -C; : > f; time ( echo in ) > f; echo \"s=$?\"",
			"SH: f: cannot overwrite existing file\ns=1\n",
			0,
		),
		("two", "time ( echo in ) > o < /no/such; echo \"s=$?\"; cat o", &s1, 0),
		("eval", "eval 'time ( echo in ) < /no/such'; echo \"s=$?\"", &s1, 0),
		("function", "f() { time ( echo in ) < /no/such; }; f; echo \"s=$?\"", &s1, 0),
		("job", "time ( echo in ) < /no/such & wait $!; echo \"s=$?\"", &s1, 0),
		("nested", "time ( ( echo in ) < /no/such ); echo \"s=$?\"", &s1, 0),
		("nested, fatal", "time ( ( echo in ) < ${zz?u} ); echo \"s=$?\"", "SH: zz: u\ns=1\n", 0),
		(
			"EXIT trap inside",
			"time ( trap 'echo T' EXIT; echo in ) < /no/such; echo \"s=$?\"",
			&s1,
			0,
		),
		(
			"ERR trap",
			"trap 'echo E $?' ERR; time ( echo in ) < /no/such; echo \"s=$?\"",
			&format!("{no}E 1\ns=1\n"),
			0,
		),
		("stderr to null", "time ( echo in ) 2> /dev/null < /no/such; echo \"s=$?\"", "s=1\n", 0),
		("and list", "time ( echo in ) < /no/such && echo ok; echo \"s=$?\"", &s1, 0),
		(
			"condition",
			"if time ( echo in ) < /no/such; then echo y; else echo n; fi",
			&format!("{no}n\n"),
			0,
		),
		(
			"then another",
			"time ( echo in ) < /no/such; time ( echo ok ); echo \"s=$?\"",
			&format!("{no}ok\nreport\ns=0\n"),
			0,
		),
		(
			"in a timed group",
			"time { time ( echo in ) < /no/such; echo mid; }; echo \"s=$?\"",
			&format!("{no}mid\nreport\ns=0\n"),
			0,
		),
		("posix mode", "set -o posix; time ( echo in ) < /no/such; echo \"s=$?\"", &s1, 0),
		(
			"set -e, or",
			"set -e; time ( echo in ) < /no/such || echo caught; echo \"s=$?\"",
			&format!("{no}caught\ns=0\n"),
			0,
		),
		(
			"loop",
			"for i in 1 2; do time ( echo $i ) < /no/such; done; echo \"s=$?\"",
			&format!("{no}{no}s=1\n"),
			0,
		),
		("set -e", "set -e; time ( echo in ) < /no/such; echo \"s=$?\"", no, 1),
	]);
}

/// The guards: these pass before the move and after it. A `time` of a
/// pipeline, a group or a simple command times in the shell; a `( … )`
/// body that is not one `( … )` alone keeps the time in the outer fork; a
/// redirection that succeeds or a failure inside the body still reports;
/// `time -p` keeps its format whatever `TIMEFORMAT` the body sets; an ERR
/// trap's line comes before the report; and without a `trap` call, or with
/// one that only lists, or one made before the `time` started, or at the
/// shell's own top level, or in a process substitution or the not-found
/// hook run outside every fork (each keeps the shell's flag), a jump still
/// reports.
#[test]
fn the_guards_around_the_move_hold() {
	let e = "; echo \"s=$?\"; echo \"e=[$(cat e)]\"";
	let no = "SH: /no/such: No such file or directory\n";
	let t = "trap 'echo T >&2' EXIT";
	assert_rows(&[
		("pipeline", &format!("time ( echo in ) 2> e | cat{e}"), "in\nreport\ns=0\ne=[]\n", 0),
		("group", &format!("time {{ echo in; }} 2> e{e}"), "in\nreport\ns=0\ne=[]\n", 0),
		("group inside", &format!("time ( {{ echo in; }} 2> e ){e}"), "in\nreport\ns=0\ne=[]\n", 0),
		("simple inside", &format!("time ( echo in 2> e ){e}"), "in\nreport\ns=0\ne=[]\n", 0),
		(
			"job inside",
			&format!("time ( ( echo in ) 2> e & wait $! ){e}"),
			"in\nreport\ns=0\ne=[]\n",
			0,
		),
		("list inside", &format!("time ( ( echo in ) 2> e; : ){e}"), "in\nreport\ns=0\ne=[]\n", 0),
		("and inside", &format!("time ( ( echo in ) 2> e && : ){e}"), "in\nreport\ns=0\ne=[]\n", 0),
		(
			"pipeline inside",
			&format!("time ( ( echo in ) 2> e | cat ){e}"),
			"in\nreport\ns=0\ne=[]\n",
			0,
		),
		(
			"set -e around",
			"( set -e; time ( false ) 2> e; echo no ); echo \"s=$? e=[$(cat e)]\"",
			"s=1 e=[report]\n",
			0,
		),
		(
			"full device",
			"time ( echo in ) > /dev/full; echo \"s=$?\"",
			"SH: echo: write error: No space left on device\nreport\ns=1\n",
			0,
		),
		("dev null", "time ( echo in ) < /dev/null; echo \"s=$?\"", "in\nreport\ns=0\n", 0),
		(
			"group, missing file",
			"time { echo in; } < /no/such; echo \"s=$?\"",
			&format!("{no}report\ns=1\n"),
			0,
		),
		(
			"simple, missing file",
			"time echo in < /no/such; echo \"s=$?\"",
			&format!("{no}report\ns=1\n"),
			0,
		),
		(
			"while, missing file",
			"time while false; do :; done < /no/such; echo \"s=$?\"",
			&format!("{no}report\ns=1\n"),
			0,
		),
		(
			"function body",
			"f() ( echo in ); time f < /no/such; echo \"s=$?\"",
			&format!("{no}report\ns=1\n"),
			0,
		),
		(
			"first stage",
			"time ( echo in ) < /no/such | cat; echo \"s=$?\"",
			&format!("{no}report\ns=0\n"),
			0,
		),
		(
			"last stage",
			"time echo x | ( cat ) < /no/such; echo \"s=$?\"",
			&format!("{no}report\ns=1\n"),
			0,
		),
		(
			"failure in the body",
			"time ( echo a; ( exit 2 ) < /no/such ); echo \"s=$?\"",
			&format!("a\n{no}report\ns=1\n"),
			0,
		),
		(
			"group around",
			"time { ( echo in ) < /no/such; }; echo \"s=$?\"",
			&format!("{no}report\ns=1\n"),
			0,
		),
		(
			"empty format",
			"TIMEFORMAT=; time ( echo in ) < /no/such; echo \"s=$?\"",
			&format!("{no}s=1\n"),
			0,
		),
		(
			"-p keeps its format",
			"time -p ( TIMEFORMAT=x; echo in ); echo \"s=$?\"",
			"in\nreal 0.00\nuser 0.00\nsys 0.00\ns=0\n",
			0,
		),
		(
			"ERR trap inside",
			"time ( trap 'echo E >&2' ERR; false; : ); echo \"s=$?\"",
			"E\nreport\ns=0\n",
			0,
		),
		("no trap: exit", "time ( exit 3 ); echo \"s=$?\"", "report\ns=3\n", 0),
		("no trap: set -e", "time ( set -e; false; echo no ); echo \"s=$?\"", "report\ns=1\n", 0),
		(
			"no trap: fatal error",
			"time ( : ${zz?u}; echo no ); echo \"s=$?\"",
			"SH: zz: u\nreport\ns=1\n",
			0,
		),
		("trap -p", "time ( trap -p; exit 3 ); echo \"s=$?\"", "report\ns=3\n", 0),
		("trap alone", "time ( trap; exit 3 ); echo \"s=$?\"", "report\ns=3\n", 0),
		("trap -l", "time ( trap -l > /dev/null; exit 3 ); echo \"s=$?\"", "report\ns=3\n", 0),
		("trap usage", "time ( trap x 2> /dev/null; exit 3 ); echo \"s=$?\"", "report\ns=3\n", 0),
		(
			"trap before the time",
			&format!("( trap 'echo A' INT; time {{ {t}; exit 3; }} ); echo \"s=$?\""),
			"report\nT\ns=3\n",
			0,
		),
		("the shell itself", &format!("time {{ {t}; exit 3; }}"), "report\nT\n", 3),
		(
			"process substitution",
			&format!("cat <( time {{ {t}; exit 3; }} ); wait $!; echo \"s=$?\""),
			"report\nT\ns=3\n",
			0,
		),
		(
			"process substitution after a trap",
			&format!(
				"( trap 'echo A' INT; cat <( time {{ {t}; exit 3; }} ); wait $! ); echo \"s=$?\""
			),
			"report\nT\ns=3\n",
			0,
		),
		(
			"not-found hook",
			"command_not_found_handle() { time { trap '' INT; exit 3; }; }; nosuch; echo \"s=$?\"",
			"report\ns=3\n",
			0,
		),
	]);
}
