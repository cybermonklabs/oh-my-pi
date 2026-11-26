//! What the EXIT trap sees of a function's variables after `set -e` leaves
//! it. bash's `set -e` jump (`ERREXIT`) frees every function's local
//! variables before the EXIT trap (`reset_local_contexts`, variables.c:5395)
//! where its catcher does: a script's `reader_loop` outside posix mode
//! (eval.c:102) and every `parse_and_execute` level (`eval`, `.`, a trap
//! action, a `-c` string, a substitution's text: evalstring.c:388). A
//! subshell's `execute_in_subshell` frees nothing; the fork of a simple
//! command takes the catcher its shell had. No unwind-protect runs, so
//! `FUNCNAME` and the positional parameters stay.
//!
//! Each row runs as `-c` text and from a script file, and every answer is
//! bash 5.3.20's, measured both ways under runc and gVisor, as uid 1000 and
//! as root (the four cells agree on every row). A row leaves out a mode
//! where bash answers outside this rule (a named difference).

#![cfg(unix)]

mod obash_support;

use std::{collections::HashMap, fs, path::Path};

/// How a row runs: as the text of `-c`, or from the script file `s.sh`.
#[derive(Clone, Copy, Debug)]
enum Mode {
	C,
	Script,
}

/// bash's answer: stdout, stderr (each `NAME: line N: ` prefix written
/// `SH: `), status.
type Want<'a> = Option<(&'a str, &'a str, i32)>;

/// A row: its name, its script, and bash's answer under `-c` and from a
/// file (`None`: not asserted in that mode).
type Row<'a> = (&'a str, &'a str, Want<'a>, Want<'a>);

/// Runs `script` in a private directory with `args` before it: stdout,
/// stderr with each `NAME: line N: ` prefix written `SH: `, and status.
fn run(
	script: &str,
	mode: Mode,
	args: &[&str],
	env: &[(&str, &str)],
) -> (String, String, Option<i32>) {
	let dir = tempfile::tempdir().expect("a row directory");
	let mut cmd = obash_support::obash();
	cmd.current_dir(dir.path())
		.args(args)
		.envs(env.iter().copied());
	match mode {
		Mode::C => cmd.args(["-c", script]),
		Mode::Script => {
			fs::write(dir.path().join("s.sh"), format!("{script}\n")).expect("the script file");
			cmd.arg("s.sh")
		},
	};
	let out = obash_support::output(&mut cmd);
	let err = String::from_utf8_lossy(&out.stderr)
		.lines()
		.map(|l| match l.find(": line ") {
			Some(i) => l[i + 7..]
				.find(": ")
				.map_or_else(|| l.to_owned(), |j| format!("SH: {}", &l[i + 7 + j + 2..])),
			None => l.to_owned(),
		})
		.map(|l| l + "\n")
		.collect();
	(String::from_utf8_lossy(&out.stdout).into_owned(), err, out.status.code())
}

/// Every row whose answer differs, in either asserted mode, is listed.
fn assert_rows(rows: &[Row<'_>]) {
	let mut wrong = Vec::new();
	for &(name, script, c, s) in rows {
		for (mode, want) in [(Mode::C, c), (Mode::Script, s)] {
			let Some((out, err, status)) = want else {
				continue;
			};
			let got = run(script, mode, &[], &[]);
			if got != (out.to_owned(), err.to_owned(), Some(status)) {
				wrong.push(format!("{name} ({mode:?}): {got:?}, bash ({out:?}, {err:?}, {status})"));
			}
		}
	}
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// The defect: after `set -e` leaves a function the EXIT trap saw its
/// locals; bash's `reader_loop` and `-c` level free them
/// (`reset_local_contexts`), keeping `FUNCNAME` and the positional parameters;
/// `local` is refused, `declare` makes globals.
#[test]
fn set_e_frees_the_locals_before_the_exit_trap() {
	assert_rows(&[
		(
			"m57",
			"f() { local l=1; set -e; false; }; trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset}\"' \
			 EXIT; f",
			Some(("T f l=unset\n", "", 1)),
			Some(("T f main l=unset\n", "", 1)),
		),
		(
			"m57-args",
			"f() { local l=1; set -e; false; echo no; }; trap 'echo \"T ${FUNCNAME[*]-none} \
			 l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; f a b",
			Some(("T f l=unset 1=a n=2 st=1\n", "", 1)),
			Some(("T f main l=unset 1=a n=2 st=1\n", "", 1)),
		),
		(
			"m57-global",
			"l=g; f() { local l=1; set -e; false; echo no; }; trap 'echo \"T ${FUNCNAME[*]-none} \
			 l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; f a",
			Some(("T f l=g 1=a n=1 st=1\n", "", 1)),
			Some(("T f main l=g 1=a n=1 st=1\n", "", 1)),
		),
		(
			"m57-nested",
			"g() { local m=2; f in; }; f() { local l=1; set -e; false; echo no; }; trap 'echo \"T \
			 ${FUNCNAME[*]} l=${l-unset} m=${m-unset} 1=$1\"' EXIT; g out",
			Some(("T f g l=unset m=unset 1=in\n", "", 1)),
			Some(("T f g main l=unset m=unset 1=in\n", "", 1)),
		),
		(
			"m57-declare",
			"f() { declare l=1; set -e; false; }; trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} \
			 1=${1-none} n=$# st=$?\"' EXIT; f",
			Some(("T f l=unset 1=none n=0 st=1\n", "", 1)),
			Some(("T f main l=unset 1=none n=0 st=1\n", "", 1)),
		),
		(
			"m57-declare-g",
			"f() { declare -g l=1; local m=2; set -e; false; }; trap 'echo \"T l=${l-unset} \
			 m=${m-unset}\"' EXIT; f",
			Some(("T l=1 m=unset\n", "", 1)),
			Some(("T l=1 m=unset\n", "", 1)),
		),
		(
			"m57-array",
			"f() { local -a a=(1 2); local -A h=([k]=v); set -e; false; }; trap 'echo \"T \
			 a=${a[*]-unset} h=${h[k]-unset}\"' EXIT; f",
			Some(("T a=unset h=unset\n", "", 1)),
			Some(("T a=unset h=unset\n", "", 1)),
		),
		(
			"m57-unset-local",
			"l=g; f() { local l; unset l; set -e; false; }; trap 'echo \"T ${FUNCNAME[*]-none} \
			 l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; f",
			Some(("T f l=g 1=none n=0 st=1\n", "", 1)),
			Some(("T f main l=g 1=none n=0 st=1\n", "", 1)),
		),
		(
			"m57-tempenv",
			"f() { set -e; false; }; trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} \
			 n=$# st=$?\"' EXIT; l=t f",
			Some(("T f l=unset 1=none n=0 st=1\n", "", 1)),
			Some(("T f main l=unset 1=none n=0 st=1\n", "", 1)),
		),
		(
			"m57-tempenv-global",
			"l=g; f() { set -e; false; }; trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} \
			 1=${1-none} n=$# st=$?\"' EXIT; l=t f",
			Some(("T f l=g 1=none n=0 st=1\n", "", 1)),
			Some(("T f main l=g 1=none n=0 st=1\n", "", 1)),
		),
		(
			"m57-local-in-trap",
			"f() { local l=1; set -e; false; echo no; }; trap 'local x=1 && echo \"local ok $x\" || \
			 echo \"local refused\"; echo \"l=${l-unset}\"' EXIT; f",
			Some(("local refused\nl=unset\n", "SH: local: can only be used in a function\n", 1)),
			Some(("local refused\nl=unset\n", "SH: local: can only be used in a function\n", 1)),
		),
		(
			"m57-err-trap",
			"f() { local l=1; set -e; false; echo no; }; trap 'echo \"E ${FUNCNAME[*]-none} \
			 l=${l-unset}\"' ERR; trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# \
			 st=$?\"' EXIT; f a",
			Some(("T f l=unset 1=a n=1 st=1\n", "", 1)),
			Some(("T f main l=unset 1=a n=1 st=1\n", "", 1)),
		),
		(
			"m57-notfound",
			"f() { local l=1; set -e; nosuchcmd; }; trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} \
			 1=${1-none} n=$# st=$?\"' EXIT; f a",
			Some(("T f l=unset 1=a n=1 st=127\n", "SH: nosuchcmd: command not found\n", 127)),
			Some(("T f main l=unset 1=a n=1 st=127\n", "SH: nosuchcmd: command not found\n", 127)),
		),
		(
			"m57-after-return",
			"f() { local l=1; set -e; false; echo no; }; trap 'echo \"T ${FUNCNAME[*]-none} \
			 l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; f a || :; g() { local l=2; set -e; false; \
			 }; g b",
			Some(("no\nT g l=unset 1=b n=1 st=1\n", "", 1)),
			Some(("no\nT g main l=unset 1=b n=1 st=1\n", "", 1)),
		),
		(
			"b-local-p-in-trap",
			"f() { local l=1; set -e; false; }; trap 'local -p; echo \"rc=$?\"' EXIT; f a",
			Some(("", "SH: local: can only be used in a function\n", 1)),
			Some(("", "SH: local: can only be used in a function\n", 1)),
		),
	]);
}

/// The ERR trap's end is `set -e`'s exit, which frees them (an ERR trap the
/// function inherits with `set -E`, or sets itself); a trap that turns `set -e`
/// off is no exit: bash reads the option again after the trap
/// (`execute_cmd.c:1006`).
#[test]
fn an_err_trap_ends_set_es_exit() {
	assert_rows(&[
		(
			"g-errtrace",
			"set -E; f() { local l=1; set -e; false; }; trap 'echo \"E l=${l-unset}\"' ERR; trap \
			 'echo \"T ${FUNCNAME[*]-none} l=${l-unset}\"' EXIT; f a",
			Some(("E l=1\nT f l=unset\n", "", 1)),
			Some(("E l=1\nT f main l=unset\n", "", 1)),
		),
		(
			"g-err-in-f",
			"f() { local l=1; trap 'echo \"E l=${l-unset}\"' ERR; set -e; false; }; trap 'echo \"T \
			 ${FUNCNAME[*]-none} l=${l-unset}\"' EXIT; f a",
			Some(("E l=1\nT f l=unset\n", "", 1)),
			Some(("E l=1\nT f main l=unset\n", "", 1)),
		),
		(
			"g-err-sets-plus-e",
			"set -E; f() { local l=1; set -e; false; echo after; }; trap 'set +e' ERR; trap 'echo \
			 \"T ${FUNCNAME[*]-none} l=${l-unset}\"' EXIT; f a",
			Some(("after\nT none l=unset\n", "", 0)),
			Some(("after\nT none l=unset\n", "", 0)),
		),
	]);
}

/// `exit` is no jump that frees them, nor is a posix script's `reader_loop`
/// (eval.c:102); a posix `-c` string's level does free them.
#[test]
fn exit_and_a_posix_script_keep_them() {
	assert_rows(&[
		(
			"m57-exit",
			"f() { local l=1; set -e; exit 3; }; trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} \
			 1=${1-none} n=$# st=$?\"' EXIT; f a",
			Some(("T f l=1 1=a n=1 st=3\n", "", 3)),
			Some(("T f main l=1 1=a n=1 st=3\n", "", 3)),
		),
		(
			"m57-exit-no-e",
			"f() { local l=1; exit 3; }; trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} \
			 n=$# st=$?\"' EXIT; f a",
			Some(("T f l=1 1=a n=1 st=3\n", "", 3)),
			Some(("T f main l=1 1=a n=1 st=3\n", "", 3)),
		),
		(
			"m57-posix",
			"set -o posix; f() { local l=1; set -e; false; echo no; }; trap 'echo \"T \
			 ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; f a",
			Some(("T f l=unset 1=a n=1 st=1\n", "", 1)),
			Some(("T f main l=1 1=a n=1 st=1\n", "", 1)),
		),
		(
			"m57-top",
			"l=1; set -e; trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' \
			 EXIT; false; echo no",
			Some(("T none l=1 1=none n=0 st=1\n", "", 1)),
			Some(("T none l=1 1=none n=0 st=1\n", "", 1)),
		),
		(
			"m57-declare-in-trap",
			"f() { local l=1; set -e; false; echo no; }; trap 'declare d=1; l=2; g() { echo \"g \
			 d=${d-unset} l=${l-unset}\"; }; g; declare -p l' EXIT; f",
			Some(("g d=1 l=2\ndeclare -- l=\"2\"\n", "", 1)),
			Some(("g d=1 l=2\ndeclare -- l=\"2\"\n", "", 1)),
		),
	]);
}

/// Each `parse_and_execute` level frees them (evalstring.c:388), also in a fork
/// that runs one.
#[test]
fn an_eval_dot_or_trap_action_frees_them() {
	assert_rows(&[
		(
			"m57-eval-outer",
			"trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; eval \
			 'f() { local l=1; set -e; false; }; f a'",
			Some(("T f l=unset 1=a n=1 st=1\n", "", 1)),
			Some(("T f main l=unset 1=a n=1 st=1\n", "", 1)),
		),
		(
			"m57-eval-call",
			"f() { local l=1; set -e; false; echo no; }; trap 'echo \"T ${FUNCNAME[*]-none} \
			 l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; eval f a",
			Some(("T f l=unset 1=a n=1 st=1\n", "", 1)),
			Some(("T f main l=unset 1=a n=1 st=1\n", "", 1)),
		),
		(
			"m57-trap-action",
			"f() { local l=1; set -e; false; echo no; }; trap 'f a' USR1; trap 'echo \"T \
			 ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; kill -USR1 $$; echo \
			 after",
			Some(("T f l=unset 1=a n=1 st=1\n", "", 1)),
			Some(("T f main l=unset 1=a n=1 st=1\n", "", 1)),
		),
		(
			"b-pipe-in-eval",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; eval 'f a | cat'; echo \"s=${PIPESTATUS[0]}\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=0\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\ns=0\n", "", 0)),
		),
		(
			"c-eval-stage",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; eval 'f a' | cat; echo \"s=${PIPESTATUS[0]}\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"c-source-stage",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; printf 'f a\\n' > s2; . ./s2 | cat; echo \
			 \"s=${PIPESTATUS[0]}\"",
			Some(("T f source l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f source main l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"c-stage-in-trap",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; trap 'f a | cat' USR1; kill -USR1 $$; echo \
			 \"after\"",
			Some(("T f l=unset 1=a n=1 st=1\nafter\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\nafter\n", "", 0)),
		),
		(
			"b-paren-eval",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; ( eval 'f a' ); echo \"s=$?\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"b-posix-eval-pipe",
			"set -o posix; f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# \
			 st=$?\"' EXIT; local l=1; set -e; false; echo no; }; eval 'f a | cat'; echo \
			 \"s=${PIPESTATUS[0]}\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=0\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\ns=0\n", "", 0)),
		),
		(
			"c-stage-in-posix-eval",
			"set -o posix; f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# \
			 st=$?\"' EXIT; local l=1; set -e; false; echo no; }; eval 'f a & wait $!'; echo \"s=$?\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"e-eval-bg",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; eval 'f a &'; wait $!; echo \"s=$?\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"e-trap-bg",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; trap 'f a & wait $!' USR1; kill -USR1 $$; echo \
			 after",
			Some(("T f l=unset 1=a n=1 st=1\nafter\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\nafter\n", "", 0)),
		),
	]);
}

/// An `eval` inside the function: from a script (the `-c` form is a named
/// difference).
#[test]
fn an_eval_in_the_function_frees_them() {
	assert_rows(&[
		(
			"m57-eval",
			"f() { local l=1; set -e; eval false; echo no; }; trap 'echo \"T ${FUNCNAME[*]-none} \
			 l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; f a",
			None,
			Some(("T f main l=unset 1=a n=1 st=1\n", "", 1)),
		),
		(
			"b-posix-eval",
			"set -o posix; f() { local l=1; set -e; eval false; }; trap 'echo \"T \
			 ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; f a",
			None,
			Some(("T f main l=unset 1=a n=1 st=1\n", "", 1)),
		),
	]);
}

/// A background job run from a `.` file: from a script (the `-c` form is a
/// named difference).
#[test]
fn a_dot_files_job_frees_them() {
	assert_rows(&[(
		"e-source-bg",
		"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
		 local l=1; set -e; false; echo no; }; printf 'f a & wait $!\\n' > s2; . ./s2; echo \"s=$?\"",
		None,
		Some(("T f source main l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
	)]);
}

/// A `( … )`, a compound command's fork and a coprocess catch the jump in
/// `execute_in_subshell` (`execute_cmd.c:1811`), which frees nothing.
#[test]
fn a_subshells_fork_keeps_them() {
	assert_rows(&[
		(
			"m57-subshell",
			"( f() { local l=1; set -e; false; echo no; }; trap 'echo \"T ${FUNCNAME[*]-none} \
			 l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; f a ); echo \"s=$?\"",
			Some(("T f l=1 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"m57-subshell-call",
			"f() { local l=1; set -e; false; echo no; }; ( trap 'echo \"T ${FUNCNAME[*]-none} \
			 l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; f a ); echo \"s=$?\"",
			Some(("T f l=1 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"m57-subshell-in-f",
			"f() { local l=1; ( trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# \
			 st=$?\"' EXIT; set -e; false; echo no ); echo \"s=$? l=$l\"; }; f a",
			Some(("T f l=1 1=a n=1 st=1\ns=1 l=1\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\ns=1 l=1\n", "", 0)),
		),
		(
			"b-group-pipe",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; { f a; } | cat; echo \"s=${PIPESTATUS[0]}\"",
			Some(("T f l=1 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"b-group-bg",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; { f a; } & wait $!; echo \"s=$?\"",
			Some(("T f l=1 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"b-paren-pipe",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; ( f a ) | cat; echo \"s=${PIPESTATUS[0]}\"",
			Some(("T f l=1 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"b-pipe-in-paren",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; ( f a | cat; echo \"s=${PIPESTATUS[0]}\" ); echo \
			 \"p=$?\"",
			Some(("T f l=1 1=a n=1 st=1\ns=1\np=0\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\ns=1\np=0\n", "", 0)),
		),
		(
			"b-bg-in-paren",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; ( f a & wait $!; echo \"s=$?\" )",
			Some(("T f l=1 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"b-pipe-in-group-pipe",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; { f a | cat; echo \"s=${PIPESTATUS[0]}\"; } | cat",
			Some(("T f l=1 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"b-comsub-paren",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; x=$( ( f a ) ); echo \"x=[$x]\"",
			Some(("x=[T f l=1 1=a n=1 st=1]\n", "", 0)),
			Some(("x=[T f main l=1 1=a n=1 st=1]\n", "", 0)),
		),
		(
			"c-stage-in-bg-group",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; { f a | cat; } & wait $!; echo \"s=$?\"",
			Some(("T f l=1 1=a n=1 st=1\ns=0\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\ns=0\n", "", 0)),
		),
		(
			"c-bg-of-bg",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; { f a & wait $!; } & wait $!; echo \"s=$?\"",
			Some(("T f l=1 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"e-group-redir-stage",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; { f a; } 2>/dev/null | cat; echo \
			 \"s=${PIPESTATUS[0]}\"",
			Some(("T f l=1 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"e-group-redir-bg",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; { f a; } 2>/dev/null & wait $!; echo \"s=$?\"",
			Some(("T f l=1 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"e-coproc",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} st=$?\" >&2' EXIT; local l=1; set \
			 -e; false; echo no; }; coproc f a; wait $!; echo \"s=$?\"",
			Some(("s=1\n", "T f l=1 st=1\n", 0)),
			Some(("s=1\n", "T f main l=1 st=1\n", 0)),
		),
		(
			"e-coproc-group",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} st=$?\" >&2' EXIT; local l=1; set \
			 -e; false; echo no; }; coproc { f a; }; wait $!; echo \"s=$?\"",
			Some(("s=1\n", "T f l=1 st=1\n", 0)),
			Some(("s=1\n", "T f main l=1 st=1\n", 0)),
		),
		(
			"e-bg-in-bg",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; { f a & wait $!; echo \"in=$?\"; } & wait $!; \
			 echo \"s=$?\"",
			Some(("T f l=1 1=a n=1 st=1\nin=1\ns=0\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\nin=1\ns=0\n", "", 0)),
		),
	]);
}

/// A simple command's fork (`f | cat`, `echo | f`, `f &`) has no `top_level` of
/// its own: its jump reaches the one its shell had, a posix script's
/// `reader_loop` included (which keeps them).
#[test]
fn a_simple_commands_fork_takes_its_shells_catcher() {
	assert_rows(&[
		(
			"m57-pipeline",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; }; f a | cat; echo \"s=${PIPESTATUS[0]}\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"m57-bg",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; }; f a & wait $!; echo \"s=$?\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"b-pipe-last",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; echo | f a; echo \"s=$?\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"b-pipe-in-func",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; g() { f a | cat; echo \"s=${PIPESTATUS[0]}\"; }; g",
			Some(("T f g l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f g main l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"c-stage-of-stage",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; f a | cat | cat; echo \"s=${PIPESTATUS[0]}\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"b-lastpipe",
			"shopt -s lastpipe; f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} \
			 n=$# st=$?\"' EXIT; local l=1; set -e; false; echo no; }; echo | f a; echo \"s=$?\"",
			Some(("T f l=unset 1=a n=1 st=1\n", "", 1)),
			Some(("T f main l=unset 1=a n=1 st=1\n", "", 1)),
		),
		(
			"b-posix-pipe",
			"set -o posix; f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# \
			 st=$?\"' EXIT; local l=1; set -e; false; echo no; }; f a | cat; echo \
			 \"s=${PIPESTATUS[0]}\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"b-posix-bg",
			"set -o posix; f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# \
			 st=$?\"' EXIT; local l=1; set -e; false; echo no; }; f a & wait $!; echo \"s=$?\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"e-async-pipe",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; f a | cat & wait $!; echo \"s=$?\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=0\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\ns=0\n", "", 0)),
		),
		(
			"e-redir-stage",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; f a 2>/dev/null | cat; echo \"s=${PIPESTATUS[0]}\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"e-assign-stage",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; x=1 f a | cat; echo \"s=${PIPESTATUS[0]}\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"e-notfound-hook",
			"command_not_found_handle() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} \
			 1=${1-none} n=$# st=$?\"' EXIT; local l=1; set -e; false; echo no; }; nosuch a; echo \
			 \"s=$?\"",
			Some(("T command_not_found_handle l=unset 1=nosuch n=2 st=1\ns=1\n", "", 0)),
			Some(("T command_not_found_handle main l=unset 1=nosuch n=2 st=1\ns=1\n", "", 0)),
		),
		(
			"e-notfound-hook-pipe",
			"command_not_found_handle() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} \
			 1=${1-none} n=$# st=$?\"' EXIT; local l=1; set -e; false; echo no; }; nosuch a | cat; \
			 echo \"s=${PIPESTATUS[0]}\"",
			Some(("T command_not_found_handle l=unset 1=nosuch n=2 st=1\ns=1\n", "", 0)),
			Some(("T command_not_found_handle main l=unset 1=nosuch n=2 st=1\ns=1\n", "", 0)),
		),
	]);
}

/// A command or process substitution's text is a `parse_and_execute` level.
#[test]
fn a_substitution_frees_them() {
	assert_rows(&[
		(
			"m57-comsub",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; }; x=$(f a); echo \"x=[$x] s=$?\"",
			Some(("x=[T f l=unset 1=a n=1 st=1] s=1\n", "", 0)),
			Some(("x=[T f main l=unset 1=a n=1 st=1] s=1\n", "", 0)),
		),
		(
			"m57-procsub",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; }; cat <(f a); wait $!; echo \"s=$?\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"b-posix-comsub",
			"set -o posix; f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# \
			 st=$?\"' EXIT; local l=1; set -e; false; echo no; }; x=$(f a); echo \"x=[$x]\"",
			Some(("x=[T f l=unset 1=a n=1 st=1]\n", "", 0)),
			Some(("x=[T f main l=unset 1=a n=1 st=1]\n", "", 0)),
		),
		(
			"b-comsub-in-paren",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; ( x=$(f a); echo \"x=[$x]\" )",
			Some(("x=[T f l=unset 1=a n=1 st=1]\n", "", 0)),
			Some(("x=[T f main l=unset 1=a n=1 st=1]\n", "", 0)),
		),
		(
			"b-comsub-group",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; x=$( { f a; } ); echo \"x=[$x]\"",
			Some(("x=[T f l=unset 1=a n=1 st=1]\n", "", 0)),
			Some(("x=[T f main l=unset 1=a n=1 st=1]\n", "", 0)),
		),
		(
			"b-procsub-group",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; cat <( { f a; } ); wait $!; echo \"s=$?\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"c-stage-in-comsub",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; x=$(f a | cat); echo \"x=[$x]\"",
			Some(("x=[T f l=unset 1=a n=1 st=1]\n", "", 0)),
			Some(("x=[T f main l=unset 1=a n=1 st=1]\n", "", 0)),
		),
	]);
}

/// bash's split cache keeps naming a freed `local IFS` until its next refresh:
/// the `$*` join uses its first character, and a word split by it gives what
/// the local gave (the rows where bash 5.3.20 splits on nothing read freed
/// memory, a named difference).
#[test]
fn a_freed_local_ifs_still_splits() {
	assert_rows(&[
		(
			"b-ifs-local",
			"f() { local IFS=:; set -e; false; }; trap 'x=\"a b\"; set -- $x; echo \"T $#\"' EXIT; f \
			 a",
			Some(("T 1\n", "", 1)),
			Some(("T 1\n", "", 1)),
		),
		(
			"d-star",
			"f() { local IFS=:; set -e; false; }; trap 'set -- a b; echo \"T [$*]\"' EXIT; f a",
			Some(("T [a:b]\n", "", 1)),
			Some(("T [a:b]\n", "", 1)),
		),
	]);
}

/// `$IFS`, `declare -p IFS` and `read` read the visible variable: the global.
#[test]
fn ifs_itself_is_the_global() {
	assert_rows(&[
		(
			"c-ifs-read",
			"f() { local IFS=:; set -e; false; }; trap 'printf \"[%s]\\n\" \"$IFS\"' EXIT; f a",
			Some(("[ \t\n]\n", "", 1)),
			Some(("[ \t\n]\n", "", 1)),
		),
		(
			"d-read",
			"f() { local IFS=:; set -e; false; }; trap 'read -r a b <<< \"x:y z\"; echo \"T [$a] \
			 [$b]\"' EXIT; f a",
			Some(("T [x:y] [z]\n", "", 1)),
			Some(("T [x:y] [z]\n", "", 1)),
		),
		(
			"d-declare-p",
			"f() { local IFS=:; set -e; false; }; trap 'declare -p IFS' EXIT; f a",
			Some(("declare -- IFS=$' \\t\\n'\n", "", 1)),
			Some(("declare -- IFS=$' \\t\\n'\n", "", 1)),
		),
	]);
}

/// An assignment (the same value too), `unset`, a function's return, a
/// function's own `local IFS` and a temporary `IFS` refresh the split; a
/// subshell's and `exit`'s keep the local.
#[test]
fn ifs_written_or_a_return_refreshes_the_split() {
	assert_rows(&[
		(
			"d-assign-same",
			"f() { local IFS=:; set -e; false; }; trap 'IFS=$(printf \" \\t\\n_\"); IFS=${IFS%_}; \
			 x=\"a:b:c d\"; set -- $x; echo \"T $#\"' EXIT; f a",
			Some(("T 2\n", "", 1)),
			Some(("T 2\n", "", 1)),
		),
		(
			"d-assign-comma",
			"f() { local IFS=:; set -e; false; }; trap 'IFS=,; x=\"a:b,c\"; set -- $x; echo \"T \
			 $#\"' EXIT; f a",
			Some(("T 2\n", "", 1)),
			Some(("T 2\n", "", 1)),
		),
		(
			"d-unset",
			"f() { local IFS=:; set -e; false; }; trap 'unset IFS; x=\"a:b:c d\"; set -- $x; echo \
			 \"T $#\"' EXIT; f a",
			Some(("T 2\n", "", 1)),
			Some(("T 2\n", "", 1)),
		),
		(
			"d-func-return",
			"f() { local IFS=:; set -e; false; }; trap 'g() { :; }; g; x=\"a:b:c d\"; set -- $x; \
			 echo \"T $#\"' EXIT; f a",
			Some(("T 2\n", "", 1)),
			Some(("T 2\n", "", 1)),
		),
		(
			"d-local-in-func",
			"f() { local IFS=:; set -e; false; }; trap 'h() { local IFS=,; :; }; h; x=\"a:b:c d\"; \
			 set -- $x; echo \"T $#\"' EXIT; f a",
			Some(("T 2\n", "", 1)),
			Some(("T 2\n", "", 1)),
		),
		(
			"d-tempenv",
			"f() { local IFS=:; set -e; false; }; trap 'IFS=, read -r a b <<< \"p,q\"; x=\"a:b:c \
			 d\"; set -- $x; echo \"T $# $a\"' EXIT; f a",
			Some(("T 2 p\n", "", 1)),
			Some(("T 2 p\n", "", 1)),
		),
		(
			"c-ifs-assign",
			"f() { local IFS=:; set -e; false; }; trap 'IFS=\" \"; x=\"a:b c\"; set -- $x; echo \"T \
			 $#\"' EXIT; f a",
			Some(("T 2\n", "", 1)),
			Some(("T 2\n", "", 1)),
		),
		(
			"d-no-local",
			"f() { local l=1; set -e; false; }; trap 'x=\"a:b:c d\"; set -- $x; echo \"T $#\"' EXIT; \
			 f a",
			Some(("T 2\n", "", 1)),
			Some(("T 2\n", "", 1)),
		),
		(
			"d-subshell-keep",
			"( f() { local IFS=:; set -e; false; }; trap 'x=\"a:b:c d\"; set -- $x; echo \"T $#\"' \
			 EXIT; f a ); echo \"s=$?\"",
			Some(("T 3\ns=1\n", "", 0)),
			Some(("T 3\ns=1\n", "", 0)),
		),
		(
			"d-exit-keep",
			"f() { local IFS=:; exit 3; }; trap 'x=\"a:b:c d\"; set -- $x; echo \"T $#\"' EXIT; f a",
			Some(("T 3\n", "", 3)),
			Some(("T 3\n", "", 3)),
		),
		(
			"g-tempenv-func",
			"f() { local IFS=:; set -e; false; }; trap 'g() { x=\"a:b:c,d\"; set -- $x; echo \"G \
			 $#\"; }; IFS=, g' EXIT; f a",
			Some(("G 2\n", "", 1)),
			Some(("G 2\n", "", 1)),
		),
		(
			"g-tempenv-func-after",
			"f() { local IFS=:; set -e; false; }; trap 'g() { :; }; IFS=, g; x=\"a:b:c d\"; set -- \
			 $x; echo \"T $#\"' EXIT; f a",
			Some(("T 2\n", "", 1)),
			Some(("T 2\n", "", 1)),
		),
	]);
}

/// The `key=value` fields of every line of the fault injector's stats file.
fn stats(path: &Path) -> Vec<HashMap<String, String>> {
	fs::read_to_string(path)
		.unwrap_or_default()
		.lines()
		.map(|line| {
			line
				.split(' ')
				.filter_map(|kv| kv.split_once('='))
				.map(|(k, v)| (k.to_owned(), v.to_owned()))
				.collect()
		})
		.collect()
}

/// A fork's catcher and a freed `local IFS`'s split value are part of the
/// shell's image: each row runs under `--fault=1:1 --fault-mode=exec` (a
/// snapshot restored in a new process every op) and still gives bash's
/// answer. The injector's own count shows the restores happened.
#[test]
fn a_restored_shell_keeps_the_catcher_and_the_held_split() {
	let rows: &[Row<'_>] = &[
		(
			"b-group-bg",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; echo no; }; { f a; } & wait $!; echo \"s=$?\"",
			Some(("T f l=1 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=1 1=a n=1 st=1\ns=1\n", "", 0)),
		),
		(
			"d-star",
			"f() { local IFS=:; set -e; false; }; trap 'set -- a b; echo \"T [$*]\"' EXIT; f a",
			Some(("T [a:b]\n", "", 1)),
			Some(("T [a:b]\n", "", 1)),
		),
		(
			"m57-bg",
			"f() { trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset} 1=${1-none} n=$# st=$?\"' EXIT; \
			 local l=1; set -e; false; }; f a & wait $!; echo \"s=$?\"",
			Some(("T f l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
			Some(("T f main l=unset 1=a n=1 st=1\ns=1\n", "", 0)),
		),
	];
	let mut wrong = Vec::new();
	for &(name, script, c, s) in rows {
		for (mode, want) in [(Mode::C, c), (Mode::Script, s)] {
			let Some((out, err, status)) = want else {
				continue;
			};
			let dir = tempfile::tempdir().expect("a stats directory");
			let path = dir.path().join("stats");
			let stats_env = path.to_str().expect("a UTF-8 path");
			let got = run(script, mode, &["--fault=1:1", "--fault-mode=exec"], &[(
				"PI_SHELL_FAULT_STATS",
				stats_env,
			)]);
			if got != (out.to_owned(), err.to_owned(), Some(status)) {
				wrong.push(format!("{name} ({mode:?}): {got:?}, bash ({out:?}, {err:?}, {status})"));
			}
			let restored: u64 = stats(&path)
				.iter()
				.map(|l| {
					l.get("restored")
						.and_then(|n| n.parse::<u64>().ok())
						.unwrap_or(0)
				})
				.sum();
			if restored == 0 {
				wrong.push(format!("{name} ({mode:?}): no snapshot was restored: {:?}", stats(&path)));
			}
		}
	}
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
