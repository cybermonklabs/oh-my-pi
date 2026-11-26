//! Which forked child runs its own EXIT trap. bash runs it for a `( … )`
//! subshell (`execute_in_subshell`, `execute_cmd.c:1841`), a coprocess, a
//! simple command's own fork (`execute_simple_command`), a substitution, and
//! a `{ …; }` group that is either async with no pipe or in a pipe and not
//! async (`execute_cmd.c:719-729`). Every other forked compound ends with
//! `sh_exit` and runs no trap, however its body ends: an `exit`, a `set -e`
//! failure and a fatal expansion error are measured here, and an `exec`
//! replaces the child's process, so it runs no trap either. A fork turns
//! `asynchronous` off, so a pipeline one level inside a job runs its stages
//! as a pipe that is not async; a backgrounded and-or list is such a fork.
//!
//! Each row runs as `-c` text and from a script file, and every answer is
//! bash 5.3.20's, measured both ways under runc and gVisor, as uid 1000 and
//! as root (the four cells agree on every row); bash 5.2.21 agrees on every
//! row here. A row leaves out a mode where bash answers outside this rule (a
//! named difference, listed in the pull request).

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
		// A `time` report's digits (`real\t0m0.010s`) become 0, so the report's
		// presence and shape are compared, not the times a loaded machine gives.
		.map(|l| {
			if ["real", "user", "sys"]
				.iter()
				.any(|k| l.starts_with(k) && l[k.len()..].starts_with([' ', '\t']))
			{
				l.chars()
					.map(|c| if c.is_ascii_digit() { '0' } else { c })
					.collect()
			} else {
				l
			}
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

/// bash forks `if`, `case`, `while`, `until`, `for` and arithmetic `for` for a
/// pipe or a `&` and ends that child with `sh_exit`, which runs no EXIT trap;
/// so does a connection (`a && b &`) and a group that is both in a pipe and
/// async. The trap a child never runs is its own: it was set inside the forked
/// body.
#[test]
fn a_forked_compound_runs_no_exit_trap() {
	assert_rows(&[
		(
			"c-if-pipe",
			"if :; then trap 'echo T end' EXIT; :; fi | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("s=0 0\n", "", 0)),
			Some(("s=0 0\n", "", 0)),
		),
		(
			"c-if-bg",
			"if :; then trap 'echo T end' EXIT; :; fi & wait $!; echo \"s=$?\"",
			Some(("s=0\n", "", 0)),
			Some(("s=0\n", "", 0)),
		),
		(
			"c-if-pipe-bg",
			"if :; then trap 'echo T end' EXIT; :; fi | cat & wait $!; echo \"s=$?\"",
			Some(("s=0\n", "", 0)),
			Some(("s=0\n", "", 0)),
		),
		(
			"c-case-pipe",
			"case x in x) trap 'echo T end' EXIT; :;; esac | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("s=0 0\n", "", 0)),
			Some(("s=0 0\n", "", 0)),
		),
		(
			"c-case-bg",
			"case x in x) trap 'echo T end' EXIT; :;; esac & wait $!; echo \"s=$?\"",
			Some(("s=0\n", "", 0)),
			Some(("s=0\n", "", 0)),
		),
		(
			"c-while-pipe",
			"i=0; while [ $i = 0 ]; do trap 'echo T end' EXIT; i=1; done | cat; echo \
			 \"s=${PIPESTATUS[*]}\"",
			Some(("s=0 0\n", "", 0)),
			Some(("s=0 0\n", "", 0)),
		),
		(
			"c-while-bg",
			"i=0; while [ $i = 0 ]; do trap 'echo T end' EXIT; i=1; done & wait $!; echo \"s=$?\"",
			Some(("s=0\n", "", 0)),
			Some(("s=0\n", "", 0)),
		),
		(
			"c-until-pipe",
			"i=0; until [ $i = 1 ]; do trap 'echo T end' EXIT; i=1; done | cat; echo \
			 \"s=${PIPESTATUS[*]}\"",
			Some(("s=0 0\n", "", 0)),
			Some(("s=0 0\n", "", 0)),
		),
		(
			"c-for-pipe",
			"for i in 1; do trap 'echo T end' EXIT; :; done | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("s=0 0\n", "", 0)),
			Some(("s=0 0\n", "", 0)),
		),
		(
			"c-for-bg",
			"for i in 1; do trap 'echo T end' EXIT; :; done & wait $!; echo \"s=$?\"",
			Some(("s=0\n", "", 0)),
			Some(("s=0\n", "", 0)),
		),
		(
			"c-for-pipe-mid",
			": | for i in 1; do trap 'echo T end' EXIT; cat; done | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("s=0 0 0\n", "", 0)),
			Some(("s=0 0 0\n", "", 0)),
		),
		(
			"c-arithfor-pipe",
			"for ((i = 0; i < 1; i++)); do trap 'echo T end' EXIT; :; done | cat; echo \
			 \"s=${PIPESTATUS[*]}\"",
			Some(("s=0 0\n", "", 0)),
			Some(("s=0 0\n", "", 0)),
		),
		(
			"c-arithfor-bg",
			"for ((i = 0; i < 1; i++)); do trap 'echo T end' EXIT; :; done & wait $!; echo \"s=$?\"",
			Some(("s=0\n", "", 0)),
			Some(("s=0\n", "", 0)),
		),
		(
			"a-until-bg",
			"i=0; until [ $i = 1 ]; do trap 'echo T end' EXIT; i=1; done & wait $!; echo \"s=$?\"",
			Some(("s=0\n", "", 0)),
			Some(("s=0\n", "", 0)),
		),
		(
			"g-pipe-bg",
			"{ trap 'echo T end' EXIT; :; } | cat & wait $!; echo \"s=$?\"",
			Some(("s=0\n", "", 0)),
			Some(("s=0\n", "", 0)),
		),
		(
			"g-and-bg",
			"{ trap 'echo T end' EXIT; :; } && : & wait $!; echo \"s=$?\"",
			Some(("s=0\n", "", 0)),
			Some(("s=0\n", "", 0)),
		),
		(
			"g-or-bg",
			"{ trap 'echo T end' EXIT; false; } || : & wait $!; echo \"s=$?\"",
			Some(("s=0\n", "", 0)),
			Some(("s=0\n", "", 0)),
		),
		(
			"a-and-group-bg",
			": && { trap 'echo T end' EXIT; :; } & wait $!; echo \"s=$?\"",
			Some(("s=0\n", "", 0)),
			Some(("s=0\n", "", 0)),
		),
		(
			"a-func-bg-for",
			"g() { for i in 1; do trap 'echo T end' EXIT; :; done & wait $!; }; g; echo \"s=$?\"",
			Some(("s=0\n", "", 0)),
			Some(("s=0\n", "", 0)),
		),
		(
			"n-group-in-for-pipe",
			"for i in 1; do { trap 'echo T end' EXIT; :; }; done | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("s=0 0\n", "", 0)),
			Some(("s=0 0\n", "", 0)),
		),
		(
			"n-group-in-if-pipe",
			"if :; then { trap 'echo T end' EXIT; :; }; fi | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("s=0 0\n", "", 0)),
			Some(("s=0 0\n", "", 0)),
		),
	]);
}

/// `execute_in_subshell` runs a `( … )` child's EXIT trap whatever its pipes
/// and `&` are, a coprocess runs it, and a `{ …; }` group runs it when it is
/// async with no pipe or in a pipe and not async. A compound nested in the
/// forked body does not fork again, so the group's own fork is the one that
/// decides.
#[test]
fn a_subshell_a_coprocess_and_a_group_run_it() {
	assert_rows(&[
		(
			"p-paren",
			"( trap 'echo T end' EXIT; : ); echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"p-paren-pipe",
			"( trap 'echo T end' EXIT; : ) | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=0 0\n", "", 0)),
			Some(("T end\ns=0 0\n", "", 0)),
		),
		(
			"p-paren-bg",
			"( trap 'echo T end' EXIT; : ) & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"p-paren-pipe-bg",
			"( trap 'echo T end' EXIT; : ) | cat & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"p-paren-time",
			"time ( trap 'echo T end' EXIT; : ); echo \"s=$?\"",
			Some(("T end\ns=0\n", "\nreal\t0m0.000s\nuser\t0m0.000s\nsys\t0m0.000s\n", 0)),
			Some(("T end\ns=0\n", "\nreal\t0m0.000s\nuser\t0m0.000s\nsys\t0m0.000s\n", 0)),
		),
		(
			"p-paren-bang",
			"! ( trap 'echo T end' EXIT; : ); echo \"s=$?\"",
			Some(("T end\ns=1\n", "", 0)),
			Some(("T end\ns=1\n", "", 0)),
		),
		(
			"p-paren-nested",
			"( ( trap 'echo T end' EXIT; : ) ); echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"p-coproc",
			"coproc { trap 'echo T end' EXIT; :; }; cat <&\"${COPROC[0]}\"; wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"g-bg",
			"{ trap 'echo T end' EXIT; :; } & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"g-pipe",
			"{ trap 'echo T end' EXIT; :; } | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=0 0\n", "", 0)),
			Some(("T end\ns=0 0\n", "", 0)),
		),
		(
			"g-pipe-in",
			": | { trap 'echo T end' EXIT; cat; }; echo \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=0 0\n", "", 0)),
			Some(("T end\ns=0 0\n", "", 0)),
		),
		(
			"g-pipe-mid",
			": | { trap 'echo T end' EXIT; cat; } | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=0 0 0\n", "", 0)),
			Some(("T end\ns=0 0 0\n", "", 0)),
		),
		(
			"g-time-bg",
			"time { trap 'echo T end' EXIT; :; } & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "\nreal\t0m0.000s\nuser\t0m0.000s\nsys\t0m0.000s\n", 0)),
			Some(("T end\ns=0\n", "\nreal\t0m0.000s\nuser\t0m0.000s\nsys\t0m0.000s\n", 0)),
		),
		(
			"g-bg-in-func",
			"f() { { trap 'echo T end' EXIT; :; } & wait $!; }; f; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"g-list-bg",
			"{ { trap 'echo T end' EXIT; :; }; :; } & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"n-for-in-group-bg",
			"{ for i in 1; do trap 'echo T end' EXIT; :; done; } & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"n-if-in-group-pipe",
			"{ if :; then trap 'echo T end' EXIT; :; fi; } | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=0 0\n", "", 0)),
			Some(("T end\ns=0 0\n", "", 0)),
		),
		(
			"a-group-of-group-bg",
			"{ { trap 'echo T end' EXIT; :; }; } & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"a-paren-of-group-bg",
			"( { trap 'echo T end' EXIT; :; } ) & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"a-group-of-paren-bg",
			"{ ( trap 'echo T end' EXIT; : ); } & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"a-group-bg-two",
			"{ trap 'echo T end' EXIT; :; } & { trap 'echo T end' EXIT; :; } & wait; echo \"s=$?\"",
			Some(("T end\nT end\ns=0\n", "", 0)),
			Some(("T end\nT end\ns=0\n", "", 0)),
		),
		(
			"a-func-bg-group",
			"g() { { trap 'echo T end' EXIT; :; } & wait $!; }; g; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"a-semi-group-bg",
			"{ :; { trap 'echo T end' EXIT; :; }; } & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"a-group-of-if-pipe",
			"{ if :; then trap 'echo T end' EXIT; :; fi; } | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=0 0\n", "", 0)),
			Some(("T end\ns=0 0\n", "", 0)),
		),
		(
			"a-two-stages",
			"{ trap 'echo T end' EXIT; :; } | { trap 'echo T two' EXIT; cat; }; echo \
			 \"s=${PIPESTATUS[*]}\"",
			Some(("T end\nT two\ns=0 0\n", "", 0)),
			Some(("T end\nT two\ns=0 0\n", "", 0)),
		),
		(
			"o-group-bg-ext",
			"{ trap 'echo T end' EXIT; /bin/echo x; } & wait $!; echo \"s=$?\"",
			Some(("x\nT end\ns=0\n", "", 0)),
			Some(("x\nT end\ns=0\n", "", 0)),
		),
	]);
}

/// bash turns `asynchronous` off in a forked child, so a pipeline one level
/// inside a job runs its stages as a pipe that is not async, and a group stage
/// there runs its EXIT trap. Only the job's own pipeline (`{ …; } | cat &`) is
/// both piped and async. A backgrounded and-or list is forked whole, so a
/// pipeline in it is one level inside the job too.
#[test]
fn the_async_of_a_job_stops_at_its_fork() {
	assert_rows(&[
		(
			"a-group-of-pipe-bg",
			"{ { trap 'echo T end' EXIT; :; } | cat; } & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"a-paren-of-pipe-bg",
			"( { trap 'echo T end' EXIT; :; } | cat ) & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"a-if-of-pipe-bg",
			"if :; then { trap 'echo T end' EXIT; :; } | cat; fi & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"a-for-of-pipe-bg",
			"for i in 1; do { trap 'echo T end' EXIT; :; } | cat; done & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"a-func-of-pipe-bg",
			"g() { { trap 'echo T end' EXIT; :; } | cat; }; g & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"a-eval-of-pipe-bg",
			"eval '{ trap \"echo T end\" EXIT; :; } | cat' & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"a-time-group-of-pipe-bg",
			"time { { trap 'echo T end' EXIT; :; } | cat; } & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "\nreal\t0m0.000s\nuser\t0m0.000s\nsys\t0m0.000s\n", 0)),
			Some(("T end\ns=0\n", "\nreal\t0m0.000s\nuser\t0m0.000s\nsys\t0m0.000s\n", 0)),
		),
		(
			"a-group-of-pipe",
			"{ { trap 'echo T end' EXIT; :; } | cat; }; echo \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=0 0\n", "", 0)),
			Some(("T end\ns=0 0\n", "", 0)),
		),
		(
			"a-paren-of-pipe",
			"( { trap 'echo T end' EXIT; :; } | cat ); echo \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"a-for-of-pipe",
			"for i in 1; do { trap 'echo T end' EXIT; :; } | cat; done; echo \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=0 0\n", "", 0)),
			Some(("T end\ns=0 0\n", "", 0)),
		),
		(
			"a-group-of-pipe-pipe",
			"{ { trap 'echo T end' EXIT; :; } | cat; } | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=0 0\n", "", 0)),
			Some(("T end\ns=0 0\n", "", 0)),
		),
		(
			"a-subshell-in-for-bg",
			"for i in 1; do ( trap 'echo T end' EXIT; : ); done & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"a-two-stages-bg",
			"{ trap 'echo T end' EXIT; :; } | { trap 'echo T two' EXIT; cat; } & wait $!; echo \
			 \"s=$?\"",
			Some(("s=0\n", "", 0)),
			Some(("s=0\n", "", 0)),
		),
		(
			"y-andor-pipe-bg",
			"{ trap 'echo T end' EXIT; :; } | cat && : & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"y-oror-pipe-bg",
			"{ trap 'echo T end' EXIT; false; } | cat || : & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"y-andor-second-pipe-bg",
			": && { trap 'echo T end' EXIT; :; } | cat & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"y-andor-pipe-fg",
			"{ trap 'echo T end' EXIT; :; } | cat && :; echo \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
	]);
}

/// The fork's kind alone decides: a forked `if` or `for` runs no EXIT trap
/// after an `exit`, a `set -e` failure, a fatal expansion error or an external
/// last command, and a forked group runs one after an `exit` or a `set -e`
/// failure. An `exec` is no such end: it replaces the child's process, so no
/// trap runs after it (here in a forked `if`).
#[test]
fn how_the_forked_body_ends_does_not_decide() {
	assert_rows(&[
		(
			"e-if-pipe-exit",
			"if :; then trap 'echo T end' EXIT; exit 7; fi | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("s=7 0\n", "", 0)),
			Some(("s=7 0\n", "", 0)),
		),
		(
			"e-for-bg-exit",
			"for i in 1; do trap 'echo T end' EXIT; exit 7; done & wait $!; echo \"s=$?\"",
			Some(("s=7\n", "", 0)),
			Some(("s=7\n", "", 0)),
		),
		(
			"e-if-pipe-sete",
			"set -e; if :; then trap 'echo T end' EXIT; false; :; fi | cat; echo \
			 \"s=${PIPESTATUS[*]}\"",
			Some(("s=1 0\n", "", 0)),
			Some(("s=1 0\n", "", 0)),
		),
		(
			"e-for-bg-sete",
			"set -e; for i in 1; do trap 'echo T end' EXIT; false; :; done & wait $!; echo \"s=$?\"",
			Some(("", "", 1)),
			Some(("", "", 1)),
		),
		(
			"e-if-pipe-fatal",
			"if :; then trap 'echo T end' EXIT; : \"${zz?u}\"; fi | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("s=1 0\n", "SH: zz: u\n", 0)),
			Some(("s=1 0\n", "SH: zz: u\n", 0)),
		),
		(
			"e-if-pipe-exec",
			"if :; then trap 'echo T end' EXIT; exec /bin/echo x; fi | cat; echo \
			 \"s=${PIPESTATUS[*]}\"",
			Some(("x\ns=0 0\n", "", 0)),
			Some(("x\ns=0 0\n", "", 0)),
		),
		(
			"e-group-pipe-exit",
			"{ trap 'echo T end' EXIT; exit 7; } | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=7 0\n", "", 0)),
			Some(("T end\ns=7 0\n", "", 0)),
		),
		(
			"e-group-bg-sete",
			"set -e; { trap 'echo T end' EXIT; false; :; } & wait $!; echo \"s=$?\"",
			Some(("T end\n", "", 1)),
			Some(("T end\n", "", 1)),
		),
		(
			"o-if-pipe-ext",
			"if :; then trap 'echo T end' EXIT; /bin/echo x; fi | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("x\ns=0 0\n", "", 0)),
			Some(("x\ns=0 0\n", "", 0)),
		),
		(
			"o-for-bg-ext",
			"for i in 1; do trap 'echo T end' EXIT; /bin/echo x; done & wait $!; echo \"s=$?\"",
			Some(("x\ns=0\n", "", 0)),
			Some(("x\ns=0\n", "", 0)),
		),
	]);
}

/// A simple command forks in `execute_simple_command`, not in the compound
/// path, so a function, an `eval`, a `.` and a builtin run their EXIT trap in a
/// pipeline or a job; a substitution's child runs it too. A `lastpipe` stage is
/// not forked at all: its trap is the shell's own.
#[test]
fn a_simple_commands_fork_and_a_substitution_run_it() {
	assert_rows(&[
		(
			"s-func-pipe",
			"f() { trap 'echo T end' EXIT; :; }; f | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=0 0\n", "", 0)),
			Some(("T end\ns=0 0\n", "", 0)),
		),
		(
			"s-func-bg",
			"f() { trap 'echo T end' EXIT; :; }; f & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"s-func-pipe-bg",
			"f() { trap 'echo T end' EXIT; :; }; f | cat & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"s-eval-pipe",
			"eval 'trap \"echo T end\" EXIT; :' | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=0 0\n", "", 0)),
			Some(("T end\ns=0 0\n", "", 0)),
		),
		(
			"s-eval-bg",
			"eval 'trap \"echo T end\" EXIT; :' & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"s-source-pipe",
			"printf '%s\\n' \"trap 'echo T end' EXIT\" : > s2.sh; . ./s2.sh | cat; echo \
			 \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=0 0\n", "", 0)),
			Some(("T end\ns=0 0\n", "", 0)),
		),
		(
			"s-builtin-pipe",
			"{ trap 'echo T end' EXIT; printf x; } | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("xT end\ns=0 0\n", "", 0)),
			Some(("xT end\ns=0 0\n", "", 0)),
		),
		(
			"b-comsub",
			"x=$( trap 'echo T end' EXIT; echo v ); echo \"x=[$x]\"; echo \"s=$?\"",
			Some(("x=[v\nT end]\ns=0\n", "", 0)),
			Some(("x=[v\nT end]\ns=0\n", "", 0)),
		),
		(
			"b-backtick",
			"x=`trap 'echo T end' EXIT; echo v`; echo \"x=[$x]\"; echo \"s=$?\"",
			Some(("x=[v\nT end]\ns=0\n", "", 0)),
			Some(("x=[v\nT end]\ns=0\n", "", 0)),
		),
		(
			"b-comsub-for",
			"x=$( for i in 1; do trap 'echo T end' EXIT; echo v; done ); echo \"x=[$x]\"; echo \
			 \"s=$?\"",
			Some(("x=[v\nT end]\ns=0\n", "", 0)),
			Some(("x=[v\nT end]\ns=0\n", "", 0)),
		),
		(
			"b-procsub",
			"cat <( trap 'echo T end' EXIT; echo v ); echo \"s=$?\"",
			Some(("v\nT end\ns=0\n", "", 0)),
			Some(("v\nT end\ns=0\n", "", 0)),
		),
		(
			"l-lastpipe",
			"shopt -s lastpipe; set +m; : | { trap 'echo T end' EXIT; cat; }; echo \
			 \"s=${PIPESTATUS[*]}\"",
			Some(("s=0 0\nT end\n", "", 0)),
			Some(("s=0 0\nT end\n", "", 0)),
		),
		(
			"p-paren-in-for-pipe",
			"for i in 1; do ( trap 'echo T end' EXIT; : ); done | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=0 0\n", "", 0)),
			Some(("T end\ns=0 0\n", "", 0)),
		),
		(
			"p-paren-in-if-pipe",
			"if :; then ( trap 'echo T end' EXIT; : ); fi | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("T end\ns=0 0\n", "", 0)),
			Some(("T end\ns=0 0\n", "", 0)),
		),
	]);
}

/// A forked child lists the trap its parent set but never runs it, and the
/// parent runs its own at the end of the shell. A trap the child sets replaces
/// its own copy only.
#[test]
fn a_child_runs_only_the_trap_it_set_itself() {
	assert_rows(&[
		(
			"t-parent-for-pipe",
			"trap 'echo T parent' EXIT; for i in 1; do :; done | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("s=0 0\nT parent\n", "", 0)),
			Some(("s=0 0\nT parent\n", "", 0)),
		),
		(
			"t-parent-paren",
			"trap 'echo T parent' EXIT; ( : ); echo \"s=$?\"",
			Some(("s=0\nT parent\n", "", 0)),
			Some(("s=0\nT parent\n", "", 0)),
		),
		(
			"t-parent-child-sets",
			"trap 'echo T parent' EXIT; if :; then trap 'echo T child' EXIT; :; fi | cat; echo \
			 \"s=${PIPESTATUS[*]}\"",
			Some(("s=0 0\nT parent\n", "", 0)),
			Some(("s=0 0\nT parent\n", "", 0)),
		),
		(
			"t-parent-child-clears",
			"trap 'echo T parent' EXIT; ( trap - EXIT; : ); echo \"s=$?\"",
			Some(("s=0\nT parent\n", "", 0)),
			Some(("s=0\nT parent\n", "", 0)),
		),
	]);
}

/// An `exec` replaces the forked child's process, so a fork that would run its
/// EXIT trap at its end runs none after an `exec`: a `( … )`, and a group that
/// is async or piped.
#[test]
fn an_exec_in_a_fork_runs_no_trap() {
	assert_rows(&[
		(
			"x-group-bg-exec",
			"{ trap 'echo T end' EXIT; exec true; } & wait $!; echo \"s=$?\"",
			Some(("s=0\n", "", 0)),
			Some(("s=0\n", "", 0)),
		),
		(
			"x-group-pipe-exec",
			"{ trap 'echo T end' EXIT; exec true; } | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("s=0 0\n", "", 0)),
			Some(("s=0 0\n", "", 0)),
		),
		(
			"x-paren-bg-exec",
			"( trap 'echo T end' EXIT; exec true ) & wait $!; echo \"s=$?\"",
			Some(("s=0\n", "", 0)),
			Some(("s=0\n", "", 0)),
		),
		(
			"x-group-bg-exec-echo",
			"{ trap 'echo T end' EXIT; exec /bin/echo x; } & wait $!; echo \"s=$?\"",
			Some(("x\ns=0\n", "", 0)),
			Some(("x\ns=0\n", "", 0)),
		),
		(
			"x-paren-exec",
			"( trap 'echo T end' EXIT; exec true ); echo \"s=$?\"",
			Some(("s=0\n", "", 0)),
			Some(("s=0\n", "", 0)),
		),
		(
			"x-paren-pipe-exec",
			"( trap 'echo T end' EXIT; exec true ) | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("s=0 0\n", "", 0)),
			Some(("s=0 0\n", "", 0)),
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

/// Whether a fork runs its own EXIT trap is part of the shell's image: each
/// row runs under `--fault=1:1 --fault-mode=exec` (a snapshot restored in a
/// new process every op) and still gives bash's answer. The injector's own
/// count shows the restores happened.
#[test]
fn a_restored_shell_keeps_the_forks_answer() {
	let rows: &[Row<'_>] = &[
		(
			"c-if-pipe",
			"if :; then trap 'echo T end' EXIT; :; fi | cat; echo \"s=${PIPESTATUS[*]}\"",
			Some(("s=0 0\n", "", 0)),
			Some(("s=0 0\n", "", 0)),
		),
		(
			"g-bg",
			"{ trap 'echo T end' EXIT; :; } & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
		),
		(
			"a-group-of-pipe-bg",
			"{ { trap 'echo T end' EXIT; :; } | cat; } & wait $!; echo \"s=$?\"",
			Some(("T end\ns=0\n", "", 0)),
			Some(("T end\ns=0\n", "", 0)),
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
