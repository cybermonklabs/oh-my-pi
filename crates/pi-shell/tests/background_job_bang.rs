//! `$!` in subshells, as Bash 5.3 runs a script (Bash 5.2.21 agrees on
//! every row): every subshell copies it, while the child it names stays
//! its parent's, not the subshell's. `$!` of a job whose output or loop
//! waits for the shell, or runs without end, is there at once.
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
	let start = start.replace("PROG", r#"/bin/sh -c 'echo $$ > "$1"; exec /bin/sleep 30' sh "$T""#);
	format!(
		r#"D=$(mktemp -d); T=$D/pid; c='/bin/sh -c '\''echo $$ > "$1"; exec /bin/sleep 30'\'' sh "$T"'; {start} & p=$!; until [ -s "$T" ]; do :; done; [ "$p" = "$(cat "$T")" ] && echo program || echo other; kill "$p"; wait "$p"; echo "st=$?"; kill "$(cat "$T")" 2>/dev/null; rm -r "$D""#
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
/// and `source` leave the pid to an `exec` their file runs, and they read
/// the whole file first: the read of a file that is not regular, which
/// may wait for the row, decides the job's own pid before it starts.
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
/// runs a function body's traps, and in a function job a trap action
/// decides as any command before `exec` does, so `$!` names the job at
/// once. The substitution row hung to the run's bound.
///
/// The last row is a lone job, whose trap runs in the shell before it
/// forks, as bash runs it: there `(( BASH_SUBSHELL ))` is false and the
/// action does nothing.
#[tokio::test(flavor = "multi_thread")]
async fn bang_of_a_job_does_not_wait_for_its_debug_trap() {
	let in_function = |action: &str| {
		format!(
			r#"{FIFO} f() {{ /bin/true; }}; set -T; trap '[[ $BASH_COMMAND == /bin/true ]] && {{ {action}; }}' DEBUG; f & p=$!; echo go >&3; wait "$p"; echo "st=$?""#
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

/// The process `$!` names for a job a wrapper runs, by the pid probe
/// ([`pid_row`]), as bash names it: `eval`, `.` and `source` run their
/// text like a function body (only an `exec`'d program is `$!`; anything
/// else leaves the job's own pid, bash's subshell), `command` and `exec`
/// run the program as the job, `time` keeps the job's own pid. A lone
/// job's DEBUG trap runs in the shell before it forks, as bash runs it, so
/// nothing it runs decides. With nothing to run, `eval` answers at once,
/// and `builtin` decides before it runs.
#[tokio::test(flavor = "multi_thread")]
async fn a_wrapped_jobs_bang_names_what_bash_names() {
	let rows = [
		(pid_row(r#"eval "$c""#), "other\nst=143\n"),
		(pid_row(r#"eval "exec $c""#), "program\nst=143\n"),
		(pid_row(r#"eval "/bin/true; $c""#), "other\nst=143\n"),
		(pid_row(r#"printf '%s\n' "$c" > "$T.src"; . "$T.src""#), "other\nst=143\n"),
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

/// Differences from bash, kept on purpose, all with the job's own
/// (virtual) pid in `$!` where bash names the program:
/// - a function, group, `eval`, `.` or `source` job that runs a builtin, a loop
///   or a command substitution before it `exec`s a program, a DEBUG trap action
///   in such a job among them, and a lone command whose here-document runs a
///   command substitution: bash's forked child runs them, then `exec`s the
///   program; waiting for the `exec` would wait on what runs first, which may
///   wait for the shell itself, or never end;
/// - a `.` job whose file is not regular (here a pipe as `/dev/stdin`): its
///   read may wait for the shell, so it decides first;
///
/// `kill` and `wait` of `$!` still reach the program.
#[tokio::test(flavor = "multi_thread")]
async fn a_job_that_runs_something_before_exec_keeps_its_own_pid() {
	let rows = [
		(pid_row("f() { local y=2; exec PROG; }; f"), "other\nst=143\n"),
		(pid_row(r#"eval "printf ''; exec $c""#), "other\nst=143\n"),
		(pid_row("f() { while (( 0 )); do :; done; exec PROG; }; f"), "other\nst=143\n"),
		(pid_row(r#"f() { exec PROG "$(echo x)"; }; f"#), "other\nst=143\n"),
		(pid_row("PROG <<EOF") + "\n$(echo x)\nEOF", "other\nst=143\n"),
		(pid_row("set -T; trap ': dbg' DEBUG; { exec PROG; }"), "other\nst=143\n"),
		(pid_row(r#"set -T; trap ': dbg' DEBUG; eval "exec $c""#), "other\nst=143\n"),
		(pid_row("f() { exec PROG; }; set -T; trap ': dbg' DEBUG; f"), "other\nst=143\n"),
		(pid_row(r#"printf 'exec %s\n' "$c" | . /dev/stdin"#), "other\nst=143\n"),
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

/// zsh: a lone command whose words or here-string run a command
/// substitution keeps the job's own pid in `$!`, a difference from zsh 5.9
/// (which prints `program`), for the reason
/// [`a_job_that_runs_something_before_exec_keeps_its_own_pid`] gives; `kill`
/// and `wait` still reach the program.
#[test]
fn a_zsh_job_whose_words_run_a_substitution_keeps_its_own_pid() {
	let words = pid_row("PROG $(echo x)");
	let here_string = pid_row(r#"PROG <<< "$(echo x)""#);
	assert_zsh_rows(
		&[(&words, "other\nst=143\n"), (&here_string, "other\nst=143\n")],
		"the stated difference",
	);
}

/// zsh: see [`bang_of_a_source_job_does_not_wait_for_its_file`].
#[test]
fn bang_of_a_zsh_source_job_does_not_wait_for_its_file() {
	assert_zsh_outputs(&[(
		r#"d=$(mktemp -d); mkfifo "$d/f"; . "$d/f" & p=$!; echo 'echo hi' > "$d/f"; wait "$p"; echo "st=$?"; rm -r "$d""#,
		"hi\nst=0\n",
	)]);
}
