//! In a subshell, an error that drops a command (a readonly variable, a bad
//! substitution) ends the subshell with status 1 and runs its EXIT trap,
//! also from inside an `eval`, `.` or trap action: bash's
//! `parse_and_execute` passes the jump on in a subshell
//! (`subshell_environment`), and the subshell's top level exits
//! (`execute_in_subshell`, `command_substitute`). A running EXIT trap's
//! action ends there instead (`run_exit_trap`). Outside a subshell the
//! `eval` or `.` goes on with its next line, as before.
//!
//! Each row runs twice, as `-c` text and from a script file. Every row was
//! measured against bash 5.3.20 and 5.2.21 both ways, which agree on all of
//! them; the rows print every error as `SH: …`.

#![cfg(unix)]

mod obash_support;

/// How a row runs: as the text of `-c`, or from the script file `s.sh`.
#[derive(Clone, Copy, Debug)]
enum Mode {
	C,
	Script,
}

/// Runs `script` with stderr on stdout in a private directory (a row may
/// write files there); each error line's `NAME: line N: ` prefix becomes
/// `SH: `. Returns the output and the exit status.
fn run(script: &str, mode: Mode) -> (String, Option<i32>) {
	let dir = tempfile::tempdir().expect("a row directory");
	let script = format!("exec 2>&1; {script}");
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
		.map(|l| match l.find(": line ") {
			Some(i) => l[i + 7..]
				.find(": ")
				.map_or_else(|| format!("{l}\n"), |j| format!("SH: {}\n", &l[i + 7 + j + 2..])),
			None => format!("{l}\n"),
		})
		.collect();
	(text, out.status.code())
}

/// A row: its name, its script, and the output and status bash gives under
/// `-c`, then from the script file.
type Row = (String, String, (String, i32), (String, i32));

/// Every row whose output or status differs, in either mode, is listed.
fn assert_rows(rows: &[Row]) {
	let mut mismatches = Vec::new();
	for (name, script, c, s) in rows {
		for (mode, (want, status)) in [(Mode::C, c), (Mode::Script, s)] {
			let got = run(script, mode);
			if got != (want.clone(), Some(*status)) {
				mismatches.push(format!("{name} ({mode:?}): {got:?}, want ({want:?}, {status})"));
			}
		}
	}
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// A row whose script prints the same in both modes.
fn same(name: &str, script: &str, out: &str) -> Row {
	(name.into(), script.into(), (out.into(), 0), (out.into(), 0))
}

#[test]
fn in_a_subshell_another_error_in_an_eval_ends_the_subshell() {
	const RO: &str = "SH: r: readonly variable\n";
	let w1 = format!("{RO}w=1\n");
	let rows: Vec<Row> = vec![
		same("eval", "readonly r=1; ( eval 'r=2; echo b'; echo after ); echo w=$?", &w1),
		same(
			"eval in a condition",
			"readonly r=1; ( eval 'r=2' || echo no; echo after ); echo w=$?",
			&w1,
		),
		same(
			"set -e, eval in a condition",
			"readonly r=1; ( set -e; eval 'r=2' || echo no; echo after ); echo w=$?",
			&w1,
		),
		same(
			"bad substitution",
			"( eval 'echo ${x!}; echo b'; echo after ); echo w=$?",
			"SH: ${x!}: bad substitution\nw=1\n",
		),
		same(
			"command substitution",
			"readonly r=1; x=$(eval 'r=2'; echo in); echo w=$? x=$x",
			&format!("{RO}w=1 x=\n"),
		),
		same(
			"function",
			"readonly r=1; f() { eval 'r=2'; echo in-f; }; ( f; echo after ); echo w=$?",
			&w1,
		),
		same(
			"eval in eval",
			"readonly r=1; ( eval 'eval \"r=2\"; echo inner'; echo after ); echo w=$?",
			&w1,
		),
		same("background", "readonly r=1; { eval 'r=2'; echo in; } & wait $!; echo w=$?", &w1),
		same(
			"signal trap",
			"readonly r=1; ( trap 'r=2; echo t1' USR1; kill -USR1 $BASHPID; echo after ); echo w=$?",
			&w1,
		),
		same(
			"the EXIT trap runs",
			"readonly r=1; ( trap 'echo T' EXIT; eval 'r=2'; echo after ); echo w=$?",
			&format!("{RO}T\nw=1\n"),
		),
		same(
			"the EXIT trap runs at the subshell's top level",
			"readonly r=1; ( trap 'echo T' EXIT; r=2; echo after ); echo w=$?",
			&format!("{RO}T\nw=1\n"),
		),
		same(
			"in the EXIT trap",
			"readonly r=1; ( trap 'eval \"r=2\"; echo t1\necho t2' EXIT; exit 3 ); echo w=$?",
			&format!("{RO}w=3\n"),
		),
		same(
			"in the EXIT trap, after the body",
			"readonly r=1; ( trap 'eval \"r=2\"; echo t1' EXIT; echo body ); echo w=$?",
			&format!("body\n{RO}w=0\n"),
		),
		same(
			"time",
			"TIMEFORMAT='[R]'; ( set -e; readonly r=1; time { eval 'r=2' || echo no; } 2>e1; echo \
			 after ); echo w=$?; echo \"e1=[$(tr '\\n' '|' <e1)]\"",
			"w=1\nSH: r: readonly variable|[R]|]\n",
		),
		// Controls.
		same(
			"outside a subshell",
			"readonly r=1; eval 'r=2; echo b\necho c'; echo after",
			&format!("{RO}c\nafter\n"),
		),
		same("a subshell inside eval", "readonly r=1; eval '( r=2; echo in )'; echo w=$?", &w1),
		same(
			"a substitution's EXIT trap",
			"readonly r=1; x=$( trap 'r=2; echo t1' EXIT; echo body ); echo w=$? x=[$x]",
			&format!("{RO}w=0 x=[body]\n"),
		),
		same(
			"a pipeline element",
			"readonly r=1; eval 'r=2; echo b' | cat; echo w=${PIPESTATUS[*]}",
			&format!("{RO}w=1 0\n"),
		),
	];
	assert_rows(&rows);
}
