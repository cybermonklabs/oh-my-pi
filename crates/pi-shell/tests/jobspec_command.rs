//! A command whose word is a jobspec (`%1`, `%%`, `%sleep`) is bash's `fg`
//! (`execute_simple_command`), run before the command's redirections are
//! expanded or applied: none is. A lone `%job &` is `bg`, in this shell.
//! Where bash forked for the command (a pipeline stage; a lone background
//! command whose first word does not start with `%`), the jobspec is a name
//! not found.
//!
//! Goldens: bash 5.3.20, measured in a cluster Job (bash 5.2.21 agrees);
//! where the measured row ended with `; ls`, the test drops it. Each row runs
//! as `-c` and as a script file, in a directory of its own: in the expected
//! stderr `PFX` is the messages' prefix (the shell's name under `-c`, `D/s.sh`
//! from the script).
#![cfg(unix)]

mod obash_support;

use std::fs;

use crate::obash_support::{obash, output};

/// A row: the script, its stdout, its stderr (`PFX` as above) and status.
type Row = (&'static str, &'static str, &'static str, i32);

/// Each row as `-c` and as a script: one line per mismatch.
fn mismatches(rows: &[Row]) -> Vec<String> {
	let sh = env!("CARGO_BIN_EXE_obash");
	let mut out = Vec::new();
	for &(code, want_out, want_err, want_status) in rows {
		for script in [false, true] {
			let tmp = tempfile::tempdir().unwrap();
			let dir = fs::canonicalize(tmp.path()).unwrap();
			let d = dir.to_str().unwrap().to_owned();
			let mut cmd = obash();
			cmd.current_dir(&dir)
				.env("PATH", "/usr/bin:/bin")
				.env("LC_ALL", "C");
			let prefix = if script {
				let file = dir.join("s.sh");
				fs::write(&file, code).unwrap();
				cmd.arg(&file);
				"D/s.sh"
			} else {
				cmd.args(["-c", code]);
				"SH"
			};
			let o = output(&mut cmd);
			let norm = |b: &[u8]| {
				String::from_utf8_lossy(b)
					.replace(sh, "SH")
					.replace(&d, "D")
			};
			let got = (norm(&o.stdout), norm(&o.stderr), o.status.code());
			let want = (want_out.to_owned(), want_err.replace("PFX", prefix), Some(want_status));
			if got != want {
				let how = if script { "script" } else { "-c" };
				out.push(format!("{code:?} ({how}): got {got:?}, want {want:?}"));
			}
		}
	}
	out
}

fn check(rows: &[Row]) {
	let wrong = mismatches(rows);
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

const FG: &str = "PFX: line 1: fg: no job control\n";
const BG: &str = "PFX: line 1: bg: no job control\n";
const NOT_FOUND: &str = "PFX: line 1: %1: command not found\n";

#[test]
fn a_jobspec_runs_fg_before_its_redirections() {
	check(&[
		(r#"%1 > ${f:=x}; echo "[$f] $?""#, "[] 1\n", FG, 0),
		(r#"sleep 0.2 & %1 > ${f:=out}; echo "[$f]""#, "[]\n", FG, 0),
		(r#"sleep 0.2 & %1 2> /dev/null$((x=3)); echo "[$x]""#, "[]\n", FG, 0),
		(r#"sleep 0.2 & %1 > /nonexistent/x; echo "st=$?""#, "st=1\n", FG, 0),
		(r#"sleep 0.2 & A=$((y=2)) %1 > ${f:=out}; echo "[$f] [$y] [$A]""#, "[] [2] []\n", FG, 0),
		(r#"sleep 0.2 & %1 a b > ${f:=out}; echo "[$f] $?""#, "[] 1\n", FG, 0),
		(r#"sleep 0.2 & %1 2>/dev/null; echo "st=$?""#, "st=1\n", FG, 0),
		(r#"sleep 0.2 & %1 {fd}>/dev/null; echo "[$fd]""#, "[]\n", FG, 0),
		("sleep 0.2 & %1 <<E\n${x:=5}\nE\necho \"[$x]\"", "[]\n", FG, 0),
		(r#"sleep 0.2 & %1; echo "st=$?""#, "st=1\n", FG, 0),
	]);
}

#[test]
fn a_jobspec_wins_over_a_function_and_command() {
	check(&[
		(r#"%1() { echo fn; }; sleep 0.2 & %1 > out; echo "st=$?""#, "st=1\n", FG, 0),
		(r#"sleep 0.2 & command %1 > out; echo "st=$?""#, "st=1\n", FG, 0),
		(r#"sleep 0.2 & command -p %1 > out; echo "st=$?""#, "st=1\n", FG, 0),
		// The redirection after a `command` prefix is not expanded either.
		(r#"sleep 0.2 & command %1 > ${f:=x}; echo "[$f] $?""#, "[] 1\n", FG, 0),
		(r#"sleep 0.2 & "%1" > out; echo "st=$?""#, "st=1\n", FG, 0),
		(r#"j=%1; sleep 0.2 & $j > out; echo "st=$?""#, "st=1\n", FG, 0),
		(r#"f() { %1 > out; }; sleep 0.2 & f; echo "st=$?""#, "st=1\n", FG, 0),
		(r#"sleep 0.2 & eval "%1 > out"; echo "st=$?""#, "st=1\n", FG, 0),
		(r#"trap "echo E" ERR; sleep 0.2 & %1 > out; echo "st=$?""#, "E\nst=1\n", FG, 0),
	]);
}

#[test]
fn a_lone_jobspec_in_the_background_is_bg_here() {
	check(&[
		(r#"sleep 0.2 & %1 & echo "st=$?""#, "st=1\n", BG, 0),
		(r#"sleep 0.2 & %1 > ${f:=out} & echo "[$f]"; wait"#, "[]\n", BG, 0),
		// No redirection is made, also with no job.
		("%1 > out & wait; [ -e out ] && echo made || echo none", "none\n", BG, 0),
		("sleep 0.2 & %1 >> out & wait; [ -e out ] && echo made || echo none", "none\n", BG, 0),
		(r#"sleep 0.2 & %1 &>/dev/null & echo "st=$?""#, "st=1\n", BG, 0),
		(r#"sleep 0.2 & ! %1 & echo "st=$?""#, "st=0\n", BG, 0),
		(r#"set -e; sleep 0.2 & %1 & echo "st=$?""#, "", BG, 1),
		(
			r#"sleep 0.2 & %1 & jobs; echo "n=$(jobs | wc -l)""#,
			"[1]+  Running                    sleep 0.2 &\nn=1\n",
			BG,
			0,
		),
	]);
}

#[test]
fn a_jobspec_bash_forks_for_is_not_found() {
	check(&[
		(r#"sleep 0.2 & %1 | cat; echo "${PIPESTATUS[*]}""#, "127 0\n", NOT_FOUND, 0),
		(
			r#"sleep 0.2 & cat < /dev/null | %1 > out; echo "${PIPESTATUS[*]}""#,
			"0 127\n",
			NOT_FOUND,
			0,
		),
		(r#"j=%1; sleep 0.2 & $j & wait $!; echo "st=$?""#, "st=127\n", NOT_FOUND, 0),
		(r#"sleep 0.2 & "%1" & wait $!; echo "st=$?""#, "st=127\n", NOT_FOUND, 0),
		(r#"sleep 0.2 & A=1 %1 & wait $!; echo "st=$?""#, "st=127\n", NOT_FOUND, 0),
		// A quoted `%` makes no jobspec: the command is forked.
		(r#"sleep 0.2 & \%1 & wait $!; echo "st=$?""#, "st=127\n", NOT_FOUND, 0),
		(r#"sleep 0.2 & '%1' & wait $!; echo "st=$?""#, "st=127\n", NOT_FOUND, 0),
	]);
}

#[test]
fn a_jobspec_in_a_subshell_or_group_is_fg_there() {
	check(&[
		(r#"sleep 0.2 & ( %1 > ${f:=out} ); echo "[$f] $?""#, "[] 1\n", FG, 0),
		(r#"sleep 0.2 & { %1 > out; } & wait $!; echo "st=$?""#, "st=1\n", FG, 0),
		(r#"sleep 0.2 & { %1 > out; } | cat; echo "${PIPESTATUS[*]}""#, "1 0\n", FG, 0),
		(r#"sleep 0.2 & x=$(%1 > out 2>&1); echo "[$x] $?""#, "[] 1\n", FG, 0),
	]);
}

/// `lastpipe` with job control off runs a pipeline's last stage in the
/// shell (bash `execute_pipeline`): no fork, so a jobspec there is `fg`. Not
/// for a pipeline that is the whole `&` item: bash runs it asynchronously,
/// every stage forked; `&&`, `time` and a compound command fork a subshell
/// first, where `lastpipe` holds again.
#[test]
fn a_jobspec_in_a_lastpipe_stage_is_fg() {
	check(&[
		(r#"shopt -s lastpipe; sleep 0.2 & true | %1; echo "${PIPESTATUS[*]}""#, "0 1\n", FG, 0),
		(
			r#"shopt -s lastpipe; sleep 0.2 & true | command %1; echo "${PIPESTATUS[*]}""#,
			"0 1\n",
			FG,
			0,
		),
		(
			r#"shopt -s lastpipe; sleep 0.2 & true | %1 > ${f:=x}; echo "[$f] ${PIPESTATUS[*]}""#,
			"[] 0 1\n",
			FG,
			0,
		),
		// Job control on: no `lastpipe`, the stage is forked.
		(r#"shopt -s lastpipe; set -m; true | %1; echo "${PIPESTATUS[*]}""#, "0 127\n", NOT_FOUND, 0),
		// The whole `&` item: every stage forked.
		(
			r#"shopt -s lastpipe; sleep 0.2 & true | %1 & wait $!; echo "st=$?""#,
			"st=127\n",
			NOT_FOUND,
			0,
		),
		("shopt -s lastpipe; sleep 0.2 & ! true | %1 & wait; echo done", "done\n", NOT_FOUND, 0),
		(
			r#"shopt -s lastpipe; sleep 0.2 & true | %1 > ${f:=x} & wait $!; echo "[$f] st=$?""#,
			"[] st=127\n",
			NOT_FOUND,
			0,
		),
		// A subshell first: `lastpipe` holds there.
		(r#"shopt -s lastpipe; sleep 0.2 & { true | %1; } & wait $!; echo "st=$?""#, "st=1\n", FG, 0),
		(
			r#"shopt -s lastpipe; sleep 0.2 & true | %1 && echo yes & wait $!; echo "st=$?""#,
			"st=1\n",
			FG,
			0,
		),
		(
			r#"shopt -s lastpipe; TIMEFORMAT=; sleep 0.2 & time true | %1 & wait $!; echo "st=$?""#,
			"st=1\n",
			FG,
			0,
		),
	]);
}

/// The `command` builtin runs its words as a command of its own, where a
/// jobspec is `fg`, also in a child bash forked: any form other than the
/// `command [-p] [--]` prefix bash drops first, and one `builtin` runs.
#[test]
fn a_jobspec_the_command_builtin_runs_is_fg() {
	check(&[
		(r#"sleep 0.2 & command -p -p %1; echo "st=$?""#, "st=1\n", FG, 0),
		(r#"sleep 0.2 & builtin command %1; echo "st=$?""#, "st=1\n", FG, 0),
		(r#"sleep 0.2 & builtin command %1 | cat; echo "${PIPESTATUS[*]}""#, "1 0\n", FG, 0),
		(r#"sleep 0.2 & command -p -p %1 | cat; echo "${PIPESTATUS[*]}""#, "1 0\n", FG, 0),
		(r#"sleep 0.2 & command -p -p %1 > ${f:=x}; echo "[$f] $?""#, "[x] 1\n", FG, 0),
		// The prefix bash drops: `fg` unforked, a name not found forked.
		(r#"sleep 0.2 & command %1; echo "st=$?""#, "st=1\n", FG, 0),
		(r#"sleep 0.2 & command -p -- %1; echo "st=$?""#, "st=1\n", FG, 0),
		(r#"sleep 0.2 & command command %1; echo "st=$?""#, "st=1\n", FG, 0),
		(r#"sleep 0.2 & command %1 | cat; echo "${PIPESTATUS[*]}""#, "127 0\n", NOT_FOUND, 0),
		// `builtin` runs a builtin by name: a jobspec is none.
		(
			r#"sleep 0.2 & command builtin %1; echo "st=$?""#,
			"st=1\n",
			"PFX: line 1: builtin: %1: not a shell builtin\n",
			0,
		),
	]);
}

/// bash tests the parsed first word, after alias substitution: an alias
/// for a jobspec makes `j &` a jobspec run in the shell (`bg`).
#[test]
fn an_alias_for_a_jobspec_is_one() {
	const BG2: &str = "PFX: line 2: bg: no job control\n";
	check(&[
		(
			"shopt -s expand_aliases; alias j=%1\nsleep 0.2 & j & echo \"st=$?\"; wait",
			"st=1\n",
			BG2,
			0,
		),
		(
			"shopt -s expand_aliases; alias j='%1 > ${f:=x}'\nsleep 0.2 & j & echo \"[$f] $?\"; wait",
			"[] 1\n",
			BG2,
			0,
		),
		(
			"shopt -s expand_aliases; alias j=%1\nsleep 0.2 & j > ${f:=x}; echo \"[$f] $?\"",
			"[] 1\n",
			"PFX: line 2: fg: no job control\n",
			0,
		),
		(
			"shopt -s expand_aliases; alias j='\"%1\"'\nsleep 0.2 & j & wait $!; echo \"st=$?\"",
			"st=127\n",
			"PFX: line 2: %1: command not found\n",
			0,
		),
	]);
}
