//! A command whose own redirections fail, negated or not: `$?` and
//! `PIPESTATUS`. bash returns a compound command's redirection failure
//! before the command's `!` applies, so `! { …; } < /no/such` ends with 1;
//! a `( … )`'s redirections are made in its fork, which exits with the
//! failure inverted (`exit (invert ? EXECUTION_SUCCESS : EXECUTION_FAILURE)`,
//! `execute_cmd.c:1762`), and the shell inverts that again.
//!
//! Each row runs as `-c` text and from a script file, and every answer is
//! bash 5.3.20's, measured both ways under runc and gVisor, as uid 1000 and
//! as root (the four cells agree on every row).

#![cfg(unix)]

mod obash_support;

use std::fs;

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

/// The defect: obash made the failure 1 and the `!` made that 0. bash returns a
/// compound command's own redirection failure before its `!` applies; a
/// subshell's fork exits with it inverted (`execute_cmd.c:1762`), which the
/// shell inverts back.
#[test]
fn a_negated_compound_whose_redirection_fails_ends_with_one() {
	assert_rows(&[
		(
			"n-bang",
			"! ( echo in ) < /no/such; echo \"s=$?\"",
			Some(("s=1\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"n-bang-cond",
			"if ! ( echo in ) < /no/such; then echo y; else echo n; fi",
			Some(("n\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("n\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-bang-group",
			"! { echo in; } < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-bang-while",
			"! while false; do :; done < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-bang-until",
			"! until true; do :; done < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-bang-if",
			"! if true; then echo in; fi < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-bang-for",
			"! for i in 1; do echo in; done < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-bang-afor",
			"! for ((i=0; i<1; i++)); do echo in; done < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-bang-case",
			"! case x in x) echo in;; esac < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-bang-cond-for",
			"if ! for i in 1; do :; done < /no/such; then echo y; else echo n; fi",
			Some(("n\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("n\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-bang-cond-case",
			"if ! case x in x) :;; esac < /no/such; then echo y; else echo n; fi",
			Some(("n\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("n\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-bang-set-e-if",
			"set -e; ! if true; then :; fi < /no/such; echo \"after $?\"",
			Some(("after 1\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("after 1\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"n-bang-set-e",
			"set -e; ! ( echo in ) < /no/such; echo \"after $?\"",
			Some(("after 1\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("after 1\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"n-bang-until",
			"until ! ( echo in ) < /no/such; do echo loop; break; done; echo \"s=$?\"",
			Some(("loop\ns=0\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("loop\ns=0\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"n-bang-quiet",
			"! ( echo in ) 2>/dev/null < /no/such; echo \"s=$?\"",
			Some(("s=1\n", "", 0)),
			Some(("s=1\n", "", 0)),
		),
		(
			"n-bang-errtrap",
			"trap 'echo E $?' ERR; ! ( echo in ) < /no/such; echo \"s=$?\"",
			Some(("s=1\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"n-bang-and",
			"! ( echo in ) < /no/such && echo yes; echo \"s=$?\"",
			Some(("s=1\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"n-bang-in-func",
			"f() { ! ( echo in ) < /no/such; }; f; echo \"s=$?\"",
			Some(("s=1\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1\n", "SH: /no/such: No such file or directory\n", 0)),
		),
	]);
}

/// The `( … )`'s fork is the pipeline bash waited for: `PIPESTATUS` holds its
/// exit status (1, or 0 when negated); a compound command's own redirections
/// fail in the shell, which sets none.
#[test]
fn a_subshells_failed_redirection_sets_pipestatus() {
	assert_rows(&[
		(
			"p-sub",
			"( echo in ) < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=1\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=1\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-bang-sub",
			"! ( echo in ) < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=0\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=0\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"n-bang-pipestatus",
			"! ( echo in ) < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=0\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=0\n", "SH: /no/such: No such file or directory\n", 0)),
		),
	]);
}

/// Guards: a negated command that runs, a `!` of a simple command or a function
/// (one inversion of the command's own failure), a negated group around a
/// subshell, pipelines, and the un-negated compounds.
#[test]
fn other_failures_and_negations_keep_their_status() {
	assert_rows(&[
		(
			"n-bang-ok",
			"! ( echo in ) < /dev/null; echo \"s=$?\"",
			Some(("in\ns=1\n", "", 0)),
			Some(("in\ns=1\n", "", 0)),
		),
		(
			"n-bang-group-inner",
			"! { ( echo in ) < /no/such; }; echo \"s=$?\"",
			Some(("s=0\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=0\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"n-bang-pipe",
			"! ( echo in ) < /no/such | cat; echo \"s=$?\"",
			Some(("s=1\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"n-plain",
			"( echo in ) < /no/such; echo \"s=$?\"",
			Some(("s=1\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"n-bang-simple",
			"! echo in < /no/such; echo \"s=$?\"",
			Some(("s=0\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=0\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-group",
			"{ echo in; } < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-while",
			"while false; do :; done < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-until",
			"until true; do :; done < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-if",
			"if true; then echo in; fi < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-for",
			"for i in 1; do echo in; done < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-afor",
			"for ((i=0; i<1; i++)); do echo in; done < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-case",
			"case x in x) echo in;; esac < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-simple",
			"echo in < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=1\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=1\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-bang-simple",
			"! echo in < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=0 p=1\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=0 p=1\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-func",
			"f() { echo in; } < /no/such; f; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=1\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=1\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-bang-func",
			"f() { echo in; } < /no/such; ! f; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=0 p=1\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=0 p=1\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-sub-ok",
			"( echo in ) < /dev/null; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("in\ns=0 p=0\n", "", 0)),
			Some(("in\ns=0 p=0\n", "", 0)),
		),
		(
			"p-bang-sub-ok",
			"! ( echo in ) < /dev/null; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("in\ns=1 p=0\n", "", 0)),
			Some(("in\ns=1 p=0\n", "", 0)),
		),
		(
			"p-group-ok",
			"{ echo in; } < /dev/null; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("in\ns=0 p=0\n", "", 0)),
			Some(("in\ns=0 p=0\n", "", 0)),
		),
		(
			"p-bang-group-ok",
			"! { echo in; } < /dev/null; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("in\ns=1 p=0\n", "", 0)),
			Some(("in\ns=1 p=0\n", "", 0)),
		),
		(
			"p-bang-pipe-last",
			"! echo x | ( cat ) < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=0 p=0 1\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=0 p=0 1\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-pipe-last",
			"echo x | ( cat ) < /no/such; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=0 1\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=0 1\n", "SH: /no/such: No such file or directory\n", 0)),
		),
		(
			"p-bang-pipe-first",
			"! ( echo in ) < /no/such | cat; echo \"s=$? p=${PIPESTATUS[*]}\"",
			Some(("s=1 p=1 0\n", "SH: /no/such: No such file or directory\n", 0)),
			Some(("s=1 p=1 0\n", "SH: /no/such: No such file or directory\n", 0)),
		),
	]);
}
