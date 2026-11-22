//! `$!` in subshells, as Bash 5.3 runs a script (Bash 5.2.21 agrees on
//! every row): every subshell copies it, while the child it names stays
//! its parent's, not the subshell's. `$!` of a job whose output or loop
//! waits for the shell, or runs without end, is there at once; a job that
//! `exec`s its program after work that waited for nothing is known by the
//! program's pid.
#![cfg(unix)]

mod obash_support;

use std::os::unix::process::CommandExt;

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

use crate::obash_support::{obash, output};

/// Runs each script in a fresh shell and asserts Bash's output and exit
/// status 0, reporting every row that differs.
async fn assert_bash_outputs(rows: &[(&str, &str)]) {
	assert_outputs(rows, "bash").await;
}

/// Runs each script in a fresh shell and asserts `expected` output (`what`
/// names where it comes from) and exit status 0, reporting every row that
/// differs.
async fn assert_outputs(rows: &[(&str, &str)], what: &str) {
	let mut mismatches = Vec::new();
	for &(script, expected) in rows {
		let (tx, rx) = flume::unbounded::<String>();
		let result = Shell::new(None)
			.run(
				ShellRunOptions { command: script.to_owned(), ..Default::default() },
				Some(tx),
				CancelToken::new(Some(20_000)),
			)
			.await
			.expect("run");
		let output: String = rx.drain().collect();
		if (result.exit_code, output.as_str()) != (Some(0), expected) {
			mismatches.push(format!(
				"`{script}`\n  {what}: Some(0) {expected:?}\n  omp:  {:?} {output:?}",
				result.exit_code
			));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ from {what}:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

/// Runs each script with obash as `zsh -f -c` and asserts zsh 5.9's output
/// and exit status 0, reporting every row that differs; a shell that does
/// not end is killed at the obash tests' bound.
fn assert_zsh_outputs(rows: &[(&str, &str)]) {
	assert_zsh_rows(rows, "zsh");
}

/// [`assert_zsh_outputs`] with `expected` output that `what` names.
fn assert_zsh_rows(rows: &[(&str, &str)], what: &str) {
	let mut mismatches = Vec::new();
	for &(script, expected) in rows {
		let out = output(obash().arg0("zsh").args(["-f", "-c", script]));
		let stdout = String::from_utf8_lossy(&out.stdout);
		if (out.status.code(), stdout.as_ref()) != (Some(0), expected) {
			mismatches.push(format!(
				"`{script}`\n  {what}: Some(0) {expected:?}\n  omp:  {:?} {stdout:?} (stderr {:?})",
				out.status.code(),
				String::from_utf8_lossy(&out.stderr)
			));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ from {what}:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

/// The pid probe, the oracle for which process `$!` names. `start` starts
/// the job with `PROG` where its program goes; `$c` holds the same command
/// line as text, for `eval` and a sourced file. The program (a `/bin/sh`
/// that writes its own pid to `$T`, then `exec`s `/bin/sleep`) tells its
/// pid; the row prints `program` when `$!` is that pid, else `other`, then
/// `st=` of `kill` and `wait` of `$!`, and kills the program by its pid.
/// `kill -0 "$!"` cannot tell the two apart: bash's `$!` may name a live
/// subshell whose child is the program, and the check succeeds for either.
fn pid_row(start: &str) -> String {
	pid_row_as(start, "echo other")
}

/// [`pid_row`], with `other` told apart: `virtual` for a virtual pid
/// (2^30 or more), else `os-other` (an OS process that is not the
/// program, such as one that already ended).
fn pid_kind_row(start: &str) -> String {
	pid_row_as(start, KIND)
}

/// `other` told apart ([`pid_kind_row`]).
const KIND: &str = r#"{ [ "$p" -ge 1073741824 ] && echo virtual || echo os-other; }"#;

fn pid_row_as(start: &str, other: &str) -> String {
	probe_row(
		start,
		"p=$!; ",
		"",
		&format!(r#"[ "$p" = "$(cat "$T")" ] && echo program || {other}"#),
	)
}

/// [`pid_row`] with `$!` read only once the program runs, so whatever the
/// job ran before its `exec` has ended unseen.
fn late_pid_row(start: &str) -> String {
	late_pid_row_as(start, "echo other")
}

/// [`late_pid_row`] with `other` told apart ([`pid_kind_row`]).
fn late_pid_kind_row(start: &str) -> String {
	late_pid_row_as(start, KIND)
}

fn late_pid_row_as(start: &str, other: &str) -> String {
	probe_row(
		start,
		"",
		"p=$!; ",
		&format!(r#"[ "$p" = "$(cat "$T")" ] && echo program || {other}"#),
	)
}

/// The check a pid file or `ps -p "$!"` makes, by [`pid_row`]'s job:
/// `/bin/kill -0 "$!"` prints `alive` when `$!` names a live process
/// (bash's subshell, or the program), else `not-found`.
fn alive_row(start: &str) -> String {
	probe_row(
		start,
		"p=$!; ",
		"",
		r#"/bin/kill -0 "$p" 2>/dev/null && echo alive || echo not-found"#,
	)
}

/// The probes' row: `start` as the job; `early` runs before the row waits
/// for the program to write its pid, `late` after (one of them reads `$!`
/// into `p`); then `verdict`, then `st=` of `kill` and `wait` of `$!`.
fn probe_row(start: &str, early: &str, late: &str, verdict: &str) -> String {
	let start = start.replace("PROG", r#"/bin/sh -c 'echo $$ > "$1"; exec /bin/sleep 30' sh "$T""#);
	format!(
		r#"D=$(mktemp -d); T=$D/pid; c='/bin/sh -c '\''echo $$ > "$1"; exec /bin/sleep 30'\'' sh "$T"'; {start} & {early}until [ -s "$T" ]; do :; done; {late}{verdict}; kill "$p"; wait "$p"; echo "st=$?"; kill "$(cat "$T")" 2>/dev/null; rm -r "$D""#
	)
}

/// A command substitution, a `( )` subshell and a pipeline stage expand
/// `$!` to the parent's: a command substitution saw none.
#[tokio::test(flavor = "multi_thread")]
async fn every_subshell_sees_the_parents_bang() {
	assert_bash_outputs(&[
		(r#"/bin/sleep 0.1 & [ "$!" = "$(echo $!)" ] && echo same || echo differ; wait"#, "same\n"),
		(r#"f(){ :; }; f & [ "$!" = "$(echo $!)" ] && echo same || echo differ; wait"#, "same\n"),
		(r#"f(){ :; }; f & p=$!; ( [ "$!" = "$p" ] && echo same ); wait"#, "same\n"),
		(
			r#"f(){ :; }; f & p=$!; echo x | { read -r _; [ "$!" = "$p" ] && echo same; }; wait"#,
			"same\n",
		),
	])
	.await;
}

/// The child `$!` names is not the subshell's to wait for: `wait PID`,
/// `wait` and `wait -n PID` in the subshell leave it alone.
#[tokio::test(flavor = "multi_thread")]
async fn a_subshell_does_not_wait_for_its_parents_child() {
	assert_bash_outputs(&[
		(
			r#"f(){ sleep 0.2; }; f & p=$!; ( wait "$p" 2>/dev/null; echo "s=$?" ); wait "$!"; echo "t=$?""#,
			"s=127\nt=0\n",
		),
		(r"f(){ sleep 0.2; }; f & ( wait 2>&1 ); echo done; wait", "done\n"),
		(
			r#"f(){ sleep 0.2; }; f & p=$!; ( wait -n "$p" 2>/dev/null; echo "n=$?" ); wait"#,
			"n=127\n",
		),
	])
	.await;
}

/// `$!` of a background pipeline is its last process's pid, as the process
/// reports `$$` itself (it was the shell's virtual pid).
#[tokio::test(flavor = "multi_thread")]
async fn a_background_pipelines_bang_is_its_last_process() {
	assert_bash_outputs(&[(
		r#"T=$(mktemp); /bin/sleep 0.1 | /bin/sh -c 'echo $$ >"$1"; exec /bin/sleep 0.1' sh "$T" & p=$!; wait; [ "$p" = "$(cat "$T")" ] && echo last; rm -f "$T""#,
		"last\n",
	)])
	.await;
}

/// fd 3: a FIFO open for reading and writing (a write to it waits once it
/// holds 16 pages, and none fails for want of a reader), which the row
/// reads or writes only after it used `$!`.
const FIFO: &str = r#"d=$(mktemp -d); mkfifo "$d/p"; exec 3<>"$d/p"; rm -r "$d";"#;

/// A background builtin (`printf`, as the job's command, a function's, or a
/// pipeline's last stage) writes 2 MiB to fd 3 (its stdout), more than the
/// FIFO holds with pages of up to 64 KiB, and only one row reads it, after
/// `$!`. The rows use `$!` (`kill`, `wait`, `jobs -p`, an assignment):
/// `$!` names the job at once, as bash's forked child is known by its pid
/// from the start. It waited for the job to end, which waited for a read
/// that came after `$!`, or never: every row hung to the run's bound.
#[tokio::test(flavor = "multi_thread")]
async fn bang_of_a_builtin_job_does_not_wait_for_its_output() {
	let job = |start: &str, then: &str| {
		format!(
			"{FIFO} big=x; for _ in {{1..21}}; do big=$big$big; done; exec 4>&1 1>&3; {start} & exec \
			 1>&4 4>&-; {then}"
		)
	};
	let kill = r#"kill "$!"; wait "$!"; echo "st=$?""#;
	let rows = [
		(job(r#"printf %s "$big""#, kill), "st=143\n"),
		(
			job(
				r#"printf %s "$big""#,
				r#"p=$!; [ -n "$p" ] && echo bang; head -c 2097152 <&3 >/dev/null; echo "drained=$?"; wait "$p"; echo "st=$?""#,
			),
			"bang\ndrained=0\nst=0\n",
		),
		(
			job(r#"printf %s "$big""#, "jobs -p >/dev/null; echo listed; kill %1; wait; echo done"),
			"listed\ndone\n",
		),
		(format!(r#"f() {{ printf %s "$big"; }}; {}"#, job("f", kill)), "st=143\n"),
		(job(r#": | printf %s "$big""#, kill), "st=143\n"),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// A function run as a job's command, or `eval`, whose body starts with a
/// loop: `$!` names the job at once, so `kill` ends a loop that never ends,
/// and `select` reads the choice the row writes after `$!`. The job waited
/// for an `exec` its body might run after the loop: every row hung to the
/// run's bound. The `select` row is the one only `for`'s decision passes;
/// in the `for … in` row the inner `while` would decide too.
#[tokio::test(flavor = "multi_thread")]
async fn bang_of_a_function_job_does_not_wait_for_its_loop() {
	let killed = |body: &str| format!(r#"f() {{ {body} }}; f & kill "$!"; wait "$!"; echo "st=$?""#);
	let rows = [
		(killed("while (( 1 )); do (( i++ )); done;"), "st=143\n"),
		(killed("for (( ;; )); do (( i++ )); done;"), "st=143\n"),
		(killed("for x in a; do while (( 1 )); do (( i++ )); done; done;"), "st=143\n"),
		(
			format!(
				r#"{FIFO} f() {{ select x in a; do break; done; }}; f 2>/dev/null <&3 & p=$!; echo 1 >&3; wait "$p"; echo "st=$?""#
			),
			"st=0\n",
		),
		(
			r#"eval 'while (( 1 )); do (( i++ )); done' & kill "$!"; wait "$!"; echo "st=$?""#
				.to_owned(),
			"st=143\n",
		),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// A job whose command substitution reads what the row writes after `$!`
/// (in a function: an assignment value, `local`'s, a `[[ ]]` word, a
/// function's argument; a lone command's here-document): `$!` names the job
/// at once. The job waited for the substitution, a child that waited for
/// the row: every row hung to the run's bound.
#[tokio::test(flavor = "multi_thread")]
async fn bang_of_a_function_job_does_not_wait_for_a_command_substitution() {
	let read = r#"$(read -r l <&3; echo "$l")"#;
	let fed = |def: &str| format!(r#"{FIFO} {def}; f & p=$!; echo go >&3; wait "$p"; echo "st=$?""#);
	let rows = [
		(fed(&format!("f() {{ local x={read}; }}")), "st=0\n"),
		(fed(&format!("f() {{ x={read}; }}")), "st=0\n"),
		(fed(&format!("f() {{ [[ -n {read} ]]; }}")), "st=0\n"),
		(fed(&format!(r#"g() {{ :; }}; f() {{ g "{read}"; }}"#)), "st=0\n"),
		(
			format!(
				"{FIFO} /bin/cat <<EOF >/dev/null & p=$!; echo go >&3; wait \"$p\"; echo \
				 \"st=$?\"\n{read}\nEOF"
			),
			"st=0\n",
		),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// A `.` or `source` job whose file is a FIFO, or a pipe as `/dev/stdin`,
/// that the row writes only after `$!`: `$!` names the job at once. `.`
/// and `source` read the whole file before they run it: the read of a
/// file that is not regular, which may wait for the row, decides the
/// job's own pid before it starts.
#[tokio::test(flavor = "multi_thread")]
async fn bang_of_a_source_job_does_not_wait_for_its_file() {
	let fifo = |start: &str| {
		format!(
			r#"d=$(mktemp -d); mkfifo "$d/f"; {start} & p=$!; echo 'echo hi' > "$d/f"; wait "$p"; echo "st=$?"; rm -r "$d""#
		)
	};
	let rows = [
		(fifo(r#". "$d/f""#), "hi\nst=0\n"),
		(fifo(r#"source "$d/f""#), "hi\nst=0\n"),
		(fifo(r#"eval '. "$d/f"'"#), "hi\nst=0\n"),
		(
			format!(
				r#"{FIFO} {{ read -r l <&3; echo "echo $l"; }} | . /dev/stdin & p=$!; echo hi >&3; wait "$p"; echo "st=$?""#
			),
			"hi\nst=0\n",
		),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// A function run as a job's command, under a `set -T` DEBUG trap whose
/// action, run in the job before the body's `/bin/true`, waits for what
/// the row writes after `$!`: a builtin with a redirection (which the
/// staged path runs), a program, or a command substitution. Bash's child
/// runs a function body's traps; here the job keeps its virtual pid once
/// its action waits, so `$!` names the job at once. The substitution row
/// hung to the run's bound.
///
/// The lone-job rows: bash runs a lone command's trap (and a pipeline
/// stage's) in the shell before it forks, where `(( BASH_SUBSHELL ))` is
/// false and the action does nothing; this engine runs it in the job. An
/// action there that waits on the FIFO, or loops without end (as a lone
/// function call's trap does in bash's child too), leaves `$!` waiting
/// for nothing: the loop rows hung to the run's bound.
#[tokio::test(flavor = "multi_thread")]
async fn bang_of_a_job_does_not_wait_for_its_debug_trap() {
	let in_function = |action: &str| {
		format!(
			r#"{FIFO} f() {{ /bin/true; }}; set -T; trap '[[ $BASH_COMMAND == /bin/true ]] && {{ {action}; }}' DEBUG; f & p=$!; echo go >&3; wait "$p"; echo "st=$?""#
		)
	};
	let looped = |guard: &str, job: &str| {
		format!(
			r#"set -T; trap '{guard} {{ while (( 1 )); do (( i++ )); done; }}' DEBUG; {job} & kill "$!"; wait "$!"; echo "st=$?""#
		)
	};
	let rows = [
		(in_function("read -r l <&3"), "st=0\n"),
		(in_function("/usr/bin/head -n 1 <&3 >/dev/null"), "st=0\n"),
		(in_function(r#"x=$(read -r l <&3; echo "$l")"#), "st=0\n"),
		(
			format!(
				r#"{FIFO} set -T; trap '(( BASH_SUBSHELL )) && /usr/bin/head -n 1 <&3 >/dev/null' DEBUG; /bin/true & p=$!; echo go >&3; wait "$p"; echo "st=$?""#
			),
			"st=0\n",
		),
		(looped("(( BASH_SUBSHELL )) &&", "/bin/sleep 30"), "st=143\n"),
		(looped("(( BASH_SUBSHELL )) &&", ": | /bin/sleep 30"), "st=143\n"),
		(
			format!(
				"f() {{ /bin/sleep 30; }}; {}",
				looped("[[ $BASH_COMMAND == f ]] && (( BASH_SUBSHELL )) &&", "f")
			),
			"st=143\n",
		),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// A function run as a job's command whose body opens a FIFO with no
/// reader yet through a compound command's redirection (a group's, the
/// body's own, a loop's) before it `exec`s a program: `$!` does not wait
/// for that open, whose reader the row opens next. These rows pass before
/// and after the loop change; they pin it.
#[tokio::test(flavor = "multi_thread")]
async fn bang_of_a_function_job_does_not_wait_for_a_compound_redirection() {
	let opened = |def: &str| {
		format!(
			r#"d=$(mktemp -d); mkfifo "$d/q"; {def}; f & p=$!; exec 5<"$d/q"; wait "$p"; echo "st=$?"; rm -r "$d""#
		)
	};
	let rows = [
		(opened(r#"f() { { exec /bin/sh -c 'exit 7'; } > "$d/q"; }"#), "st=7\n"),
		(opened(r#"f() { exec /bin/sh -c 'exit 7'; } > "$d/q""#), "st=7\n"),
		(
			opened(r#"f() { while (( 0 )); do :; done > "$d/q"; exec /bin/sh -c 'exit 7'; }"#),
			"st=7\n",
		),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// A background job whose redirection opens a FIFO with no reader yet,
/// which the row opens only after `$!`: `$!` does not wait for that open.
/// The job's lone program opens it itself, so `$!` is its pid; a builtin's
/// job keeps its own pid. Bash rows that pass before and after this change;
/// [`bang_of_a_zsh_job_does_not_wait_for_its_fifo_open`] is zsh's.
#[tokio::test(flavor = "multi_thread")]
async fn bang_of_a_job_does_not_wait_for_its_fifo_open() {
	let opened = |job: &str| {
		format!(
			r#"d=$(mktemp -d); mkfifo "$d/q"; {job} > "$d/q" & p=$!; exec 5<"$d/q"; wait "$p"; echo "st=$?"; rm -r "$d""#
		)
	};
	let rows = [(opened("printf x"), "st=0\n"), (opened("/bin/echo x"), "st=0\n")];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// A job whose text runs `eval`, `.` or `source` again without end (bash
/// recurses until the row's `kill` ends it): `$!` names the job at once.
/// Nothing the job ran decided its pid, and a reader of `$!` waited for
/// it: every row hung to the run's bound.
#[tokio::test(flavor = "multi_thread")]
async fn bang_of_a_job_that_reenters_eval_or_source_is_there_at_once() {
	let killed =
		|start: &str| format!(r#"{start} & p=$!; echo got; kill "$p"; wait "$p"; echo "st=$?""#);
	let own = |builtin: &str| {
		killed(&format!(
			r#"D=$(mktemp -d); printf '{builtin} "%s"\n' "$D/s" > "$D/s"; {builtin} "$D/s" 2>/dev/null"#
		)) + r#"; rm -r "$D""#
	};
	let rows = [
		(killed(r#"x='eval "$x"'; eval "$x" 2>/dev/null"#), "got\nst=143\n"),
		(killed(r#"x='eval "$x"'; eval "$x""#), "got\nst=143\n"),
		(killed(r#"x='eval "$x"'; f() { eval "$x"; }; f"#), "got\nst=143\n"),
		(killed("f() { eval f 2>/dev/null; }; f"), "got\nst=143\n"),
		(own("."), "got\nst=143\n"),
		(own("source"), "got\nst=143\n"),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// The process `$!` names for a job a wrapper runs, by the pid probe
/// ([`pid_row`]), as bash names it: a program `eval`, `.` or `source`
/// `exec`s is `$!`; `command` and `exec` run the program as the job;
/// `time` keeps the job's own pid. In a lone job's DEBUG trap under
/// `set -T`, which bash runs in the shell before it forks, a builtin, a
/// loop or a command substitution decides nothing. With nothing to run,
/// `eval` answers at once, and a `builtin` whose output waits leaves the
/// job its own pid.
#[tokio::test(flavor = "multi_thread")]
async fn a_wrapped_jobs_bang_names_what_bash_names() {
	let rows = [
		(pid_row(r#"eval "exec $c""#), "program\nst=143\n"),
		(pid_row(r#"printf 'exec %s\n' "$c" > "$T.src"; . "$T.src""#), "program\nst=143\n"),
		(pid_row(r#"printf 'exec %s\n' "$c" > "$T.src"; source "$T.src""#), "program\nst=143\n"),
		(pid_row("command PROG"), "program\nst=143\n"),
		(pid_row("exec PROG"), "program\nst=143\n"),
		(pid_row("time PROG"), "other\nst=143\n"),
		(pid_row("set -T; trap ': dbg' DEBUG; PROG"), "program\nst=143\n"),
		(pid_row("set -T; trap 'while false; do :; done' DEBUG; PROG"), "program\nst=143\n"),
		(
			pid_row("set -T; trap '[[ -z $once ]] && { once=1; x=$(echo y); }' DEBUG; PROG"),
			"program\nst=143\n",
		),
		(
			pid_row(r#"set -T; trap 'echo "+ $BASH_COMMAND" >/dev/null' DEBUG; PROG"#),
			"program\nst=143\n",
		),
		(
			r#"eval '' & p=$!; [ -n "$p" ] && echo p-set; wait "$p"; echo "st=$?""#.to_owned(),
			"p-set\nst=0\n",
		),
		(
			r#"eval 'if' 2>/dev/null & p=$!; [ -n "$p" ] && echo p-set; wait "$p"; echo "st=$?""#
				.to_owned(),
			"p-set\nst=2\n",
		),
		(
			format!(
				r#"{FIFO} big=x; for _ in {{1..21}}; do big=$big$big; done; exec 4>&1 1>&3; builtin printf %s "$big" & exec 1>&4 4>&-; kill "$!"; wait "$!"; echo "st=$?""#
			),
			"st=143\n",
		),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// `$!` names a live process, as bash's does, by the check a pid file or
/// `ps -p` makes ([`alive_row`]): a job whose `eval`, `.` or `source` text
/// runs the program (bash names its subshell, which lives as long; this
/// engine names the program), a function job that loops before it `exec`s
/// the program, and a lone program. The first four named the job's own
/// pid, which no OS process has.
#[tokio::test(flavor = "multi_thread")]
async fn a_jobs_bang_is_a_live_process() {
	let rows = [
		(alive_row(r#"eval "$c""#), "alive\nst=143\n"),
		(alive_row(r#"eval "$c" 2>/dev/null"#), "alive\nst=143\n"),
		(alive_row(r#"printf '%s\n' "$c" > "$T.src"; . "$T.src""#), "alive\nst=143\n"),
		(alive_row("f() { for x in a b; do :; done; exec PROG; }; f"), "alive\nst=143\n"),
		(alive_row("PROG"), "alive\nst=143\n"),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// A function, group or `eval` job that runs a builtin, a loop, a command
/// substitution, a subshell, a pipeline of builtins, a job of its own or a
/// DEBUG trap action before it `exec`s its program, and a lone program
/// whose here-document runs a command substitution: `$!` is the program's
/// pid, as bash's forked child `exec`s it. Nothing the job ran waited, so
/// nothing decided its pid before the `exec`. The last row reads `$!` only
/// once the program runs ([`late_pid_row`]): its 5000-pass loop has ended
/// unseen. Every row named the job's own pid before this change.
#[tokio::test(flavor = "multi_thread")]
async fn a_job_that_runs_something_before_exec_is_known_by_its_program() {
	let rows = [
		pid_row("f() { local y=2; exec PROG; }; f"),
		pid_row("f() { cd /; exec PROG; }; f"),
		pid_row(r#"eval "printf ''; exec $c""#),
		pid_row("f() { while (( 0 )); do :; done; exec PROG; }; f"),
		pid_row("f() { for x in a b; do :; done; exec PROG; }; f"),
		pid_row("f() { for (( i = 0; i < 100; i++ )); do :; done; exec PROG; }; f"),
		pid_row(r#"f() { exec PROG "$(echo x)"; }; f"#),
		pid_row("f() { local v=$(echo x); exec PROG; }; f"),
		pid_row("f() { ( : ); exec PROG; }; f"),
		pid_row("f() { : | :; exec PROG; }; f"),
		pid_row("f() { : & exec PROG; }; f"),
		pid_row("PROG <<EOF") + "\n$(echo x)\nEOF",
		pid_row("set -T; trap ': dbg' DEBUG; { exec PROG; }"),
		pid_row(r#"set -T; trap ': dbg' DEBUG; eval "exec $c""#),
		pid_row("f() { exec PROG; }; set -T; trap ': dbg' DEBUG; f"),
		late_pid_row("f() { for (( i = 0; i < 5000; i++ )); do :; done; exec PROG; }; f"),
	];
	let rows: Vec<(&str, &str)> = rows
		.iter()
		.map(|s| (s.as_str(), "program\nst=143\n"))
		.collect();
	assert_bash_outputs(&rows).await;
}

/// Differences from bash, kept on purpose; bash names the program in each.
/// A function or group job that runs a program before its `exec` (also in
/// a command substitution, a subshell or a pipeline stage), or reads a
/// pipe (`.` of `/dev/stdin`), keeps its own (virtual) pid however late
/// `$!` is read: the program may wait for what the shell does after it
/// reads `$!`. So does one that runs a scheduler slice (1024 operations)
/// of work while a reader of `$!` waits, here a 5000-pass loop before its
/// `exec`: the reader waits no longer, as the job may never end (read
/// after the loop, `$!` is the program's:
/// [`a_job_that_runs_something_before_exec_is_known_by_its_program`]).
/// A job that stops before its `exec` (`kill -STOP $BASHPID`) while a
/// reader of `$!` waits keeps its own pid too: a stopped job makes no
/// progress, so the reader would wait until something continues it, which
/// here is the reader's own next command. Older than this change and kept:
/// an `eval` whose text runs another program first names that program,
/// which has ended (`not-found`; bash names its subshell, alive). `kill`
/// and `wait` of `$!` still reach the program.
#[tokio::test(flavor = "multi_thread")]
async fn a_job_that_waits_before_exec_keeps_its_own_pid() {
	let rows = [
		(pid_kind_row("f() { /bin/true; exec PROG; }; f"), "virtual\nst=143\n"),
		(late_pid_kind_row("f() { /bin/true; exec PROG; }; f"), "virtual\nst=143\n"),
		(pid_kind_row("f() { x=$(/bin/true); exec PROG; }; f"), "virtual\nst=143\n"),
		(late_pid_kind_row("f() { x=$(/bin/true); exec PROG; }; f"), "virtual\nst=143\n"),
		(pid_kind_row(r#"printf 'exec %s\n' "$c" | . /dev/stdin"#), "virtual\nst=143\n"),
		(
			pid_kind_row("f() { for (( i = 0; i < 5000; i++ )); do :; done; exec PROG; }; f"),
			"virtual\nst=143\n",
		),
		(alive_row(r#"eval "/bin/true; $c""#), "not-found\nst=143\n"),
		(
			probe_row(
				"f() { kill -STOP $BASHPID; exec PROG; }; f",
				r#"p=$!; sleep 0.5; kill -CONT "$p"; "#,
				"",
				&format!(r#"[ "$p" = "$(cat "$T")" ] && echo program || {KIND}"#),
			),
			"virtual\nst=143\n",
		),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_outputs(&rows, "the stated difference").await;
}

/// zsh: a function run as a job's command whose body is a `repeat` that
/// does not end soon, or runs a command substitution that reads what the
/// row writes after `$!`: `$!` names the job at once (zsh 5.9: `st=143`,
/// `st=0`). It waited for the loop or the substitution: the shell was
/// killed at the obash tests' bound.
#[test]
fn bang_of_a_zsh_function_job_does_not_wait_for_repeat() {
	assert_zsh_outputs(&[(
		r#"f() { repeat 2000000000 (( i++ )) }; f & kill "$!"; wait "$!"; echo "st=$?""#,
		"st=143\n",
	)]);
}

/// zsh: see [`bang_of_a_zsh_function_job_does_not_wait_for_repeat`]; also a
/// lone command whose words run the substitution.
#[test]
fn bang_of_a_zsh_function_job_does_not_wait_for_a_command_substitution() {
	let read = r#"$(read -r l <&3; echo "$l")"#;
	let rows = [
		format!(r#"{FIFO} f() {{ : {read} }}; f & p=$!; echo go >&3; wait "$p"; echo "st=$?""#),
		format!(r#"{FIFO} /bin/echo {read} >/dev/null & p=$!; echo go >&3; wait "$p"; echo "st=$?""#),
	];
	assert_zsh_outputs(&[(&rows[0], "st=0\n"), (&rows[1], "st=0\n")]);
}

/// zsh: a lone program whose words or here-string run a command
/// substitution is `$!`, and a live process ([`alive_row`]'s check), as in
/// zsh 5.9: the substitution waited for nothing. They named the job's own
/// pid.
#[test]
fn a_zsh_job_whose_words_run_a_substitution_is_known_by_its_program() {
	let words = pid_row("PROG $(echo x)");
	let here_string = pid_row(r#"PROG <<< "$(echo x)""#);
	let alive = alive_row(r#"PROG "$(echo x)""#);
	assert_zsh_outputs(&[
		(&words, "program\nst=143\n"),
		(&here_string, "program\nst=143\n"),
		(&alive, "alive\nst=143\n"),
	]);
}

/// zsh: see [`bang_of_a_job_that_reenters_eval_or_source_is_there_at_once`].
#[test]
fn bang_of_a_zsh_job_that_reenters_eval_or_source_is_there_at_once() {
	assert_zsh_outputs(&[
		(
			r#"x='eval "$x"'; eval "$x" 2>/dev/null & p=$!; echo got; kill "$p"; wait "$p"; echo "st=$?""#,
			"got\nst=143\n",
		),
		(
			r#"D=$(mktemp -d); printf '. "%s"\n' "$D/s" > "$D/s"; . "$D/s" & p=$!; echo got; kill "$p"; wait "$p"; echo "st=$?"; rm -r "$D""#,
			"got\nst=143\n",
		),
	]);
}

/// zsh: a background job whose redirection opens a FIFO with no reader yet
/// (the job's command's, or one in a function job's body), which the row
/// opens only after `$!`: `$!` names the job at once (zsh 5.9: `st=0`, and
/// the line the job wrote). It waited for the open, which waited for the
/// row: the shell was killed at the obash tests' bound. The same rows
/// without `$!` passed. A lone program's job keeps its own pid here, where
/// zsh names its child: [`bang_of_a_job_does_not_wait_for_its_fifo_open`]'s
/// bash leaves the open to the program.
#[test]
fn bang_of_a_zsh_job_does_not_wait_for_its_fifo_open() {
	let opened = |job: &str, then: &str| {
		format!(
			r#"d=$(mktemp -d); mkfifo "$d/q"; {job} & p=$!; exec 5<"$d/q"; {then}wait "$p"; echo "st=$?"; rm -r "$d""#
		)
	};
	let rows = [
		opened(r#"printf x > "$d/q""#, ""),
		opened(r#"/bin/echo x > "$d/q""#, ""),
		opened(r#"f() { printf x > "$d/q" }; f"#, ""),
		opened(r#"printf x > "$d/q""#, r#"read -r -u 5 l; echo "l=$l"; "#),
	];
	assert_zsh_outputs(&[
		(&rows[0], "st=0\n"),
		(&rows[1], "st=0\n"),
		(&rows[2], "st=0\n"),
		(&rows[3], "l=x\nst=0\n"),
	]);
}

/// zsh: see [`bang_of_a_source_job_does_not_wait_for_its_file`].
#[test]
fn bang_of_a_zsh_source_job_does_not_wait_for_its_file() {
	assert_zsh_outputs(&[(
		r#"d=$(mktemp -d); mkfifo "$d/f"; . "$d/f" & p=$!; echo 'echo hi' > "$d/f"; wait "$p"; echo "st=$?"; rm -r "$d""#,
		"hi\nst=0\n",
	)]);
}

/// A function job whose command substitution, subshell, pipeline stage or
/// job of its own opens a FIFO the row writes only after `$!`: `$!` names
/// the job at once (bash 5.2.21 and 5.3.20: `st=0`). A child's filesystem
/// wait is a wait; at 2f8e0b78 it counted as the job's progress, and every
/// row hung to the run's bound (at 31f4f5a0 each passed). The last three
/// rows open the FIFO in the job's own vproc (`read`, a `while read` loop,
/// `mapfile`): that open decides where it is made, as before, and stays
/// the job's progress.
#[tokio::test(flavor = "multi_thread")]
async fn bang_of_a_job_whose_child_opens_a_fifo_is_there_at_once() {
	let opened = |body: &str| {
		format!(
			r#"d=$(mktemp -d); mkfifo "$d/q"; f() {{ {body}; exec /bin/true; }}; f & p=$!; echo l=1 > "$d/q"; wait "$p"; echo "st=$?"; rm -r "$d""#
		)
	};
	let rows = [
		opened(r#"x=$(< "$d/q")"#),
		opened(r#"x=$(read -r l < "$d/q"; echo "$l")"#),
		opened(r#"( read -r l < "$d/q" )"#),
		opened(r#"read -r l < "$d/q" | :"#),
		opened(r#"x=$(. "$d/q")"#),
		opened(r#"{ read -r l < "$d/q"; } & wait"#),
		opened(r#"read -r l < "$d/q""#),
		opened(r#"while read -r l; do :; done < "$d/q""#),
		opened(r#"mapfile -t a < "$d/q""#),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|s| (s.as_str(), "st=0\n")).collect();
	assert_bash_outputs(&rows).await;
}

/// zsh: see [`bang_of_a_job_whose_child_opens_a_fifo_is_there_at_once`]
/// (zsh 5.9: `st=0`).
#[test]
fn bang_of_a_zsh_job_whose_substitution_opens_a_fifo_is_there_at_once() {
	assert_zsh_outputs(&[(
		r#"d=$(mktemp -d); mkfifo "$d/q"; f() { x=$(< "$d/q"); exec /bin/true }; f & p=$!; echo l=1 > "$d/q"; wait "$p"; echo "st=$?"; rm -r "$d""#,
		"st=0\n",
	)]);
}

/// Under obash's pending-fs test mode (`PI_SHELL_FS=pending`: every fs op
/// answers pending first), a function job's own stat of a file
/// (`[ -e file ]`) before its `exec` is progress, not a wait: `$!` is the
/// program's pid, as in bash (the pid probe, [`pid_row`]). (An open there
/// decides the job's own pid where it is made, as a FIFO open does:
/// `redir::defer` cannot tell a pending open from a FIFO's.)
#[test]
fn the_jobs_own_filesystem_answer_is_progress() {
	let row = pid_row(r#"echo in > "$D/in"; f() { [ -e "$D/in" ]; exec PROG; }; f"#);
	let out = output(
		obash()
			.env("PI_SHELL_FS", "pending")
			.args(["-c", row.as_str()]),
	);
	let stdout = String::from_utf8_lossy(&out.stdout);
	assert_eq!(
		(out.status.code(), stdout.as_ref()),
		(Some(0), "program\nst=143\n"),
		"`{row}` under PI_SHELL_FS=pending\n  bash: Some(0) \"program\\nst=143\\n\""
	);
}
