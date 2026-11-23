//! Where the DEBUG trap runs, as Bash 5.3 runs it (Bash 5.2.21 agrees on
//! every row): a background simple command's, and each simple stage's of a
//! pipeline (in the foreground too), run in the shell before it forks, with
//! or without `set -T`, and the command does not run it again; with
//! `set -T` the child of a function or `eval` job runs the traps of what
//! it runs. A DEBUG trap action's command substitution runs no DEBUG trap.
//! zsh (5.9): a trap function's non-zero status ends the interrupted code
//! only after an explicit `return`.
#![cfg(unix)]

mod obash_support;

use std::os::unix::process::CommandExt;

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

use crate::obash_support::{obash, output};

/// Runs each script in a fresh shell and asserts Bash's output and exit
/// status 0, reporting every row that differs.
async fn assert_bash_outputs(rows: &[(&str, &str)]) {
	let mut mismatches = Vec::new();
	for &(script, bash_output) in rows {
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
		if (result.exit_code, output.as_str()) != (Some(0), bash_output) {
			mismatches.push(format!(
				"`{script}`\n  bash: Some(0) {bash_output:?}\n  omp:  {:?} {output:?}",
				result.exit_code
			));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ from bash:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

/// The pid probe (as in `background_job_bang.rs`): the job's program writes
/// its own pid; the row prints `program` when `$!` is that pid, else
/// `other`, then `st=` of `kill` and `wait` of `$!`.
fn pid_row(start: &str) -> String {
	let start = start.replace("PROG", r#"/bin/sh -c 'echo $$ > "$1"; exec /bin/sleep 30' sh "$T""#);
	format!(
		r#"D=$(mktemp -d); T=$D/pid; {start} & p=$!; until [ -s "$T" ]; do :; done; [ "$p" = "$(cat "$T")" ] && echo program || echo other; kill "$p"; wait "$p"; echo "st=$?"; kill "$(cat "$T")" 2>/dev/null; rm -r "$D""#
	)
}

/// fd 3: a FIFO open for reading and writing, which the row writes only
/// after it used `$!`.
const FIFO: &str = r#"d=$(mktemp -d); mkfifo "$d/p"; exec 3<>"$d/p"; rm -r "$d";"#;

/// Each trap run prints `$BASH_SUBSHELL:$BASH_COMMAND` (0 is the shell
/// itself), and a variable it sets is read in the shell after `wait`.
/// Without `set -T` a job runs no DEBUG trap of its own; the shell ran its
/// lone command's (also a negated one), its pipeline stages', and a
/// foreground pipeline's: only a simple stage's, not a `{ … }` or `( … )`
/// stage's (bash forks for those first). A `time`d job forks first: under
/// `set -T` it runs its stages' traps itself.
#[tokio::test(flavor = "multi_thread")]
async fn a_debug_trap_runs_in_the_shell_before_it_forks() {
	let trap = |functrace: &str, body: &str| {
		format!(
			r#"f() {{ : body; }}; {functrace} trap 'case $BASH_COMMAND in *mark*|f|*body*) echo "$BASH_SUBSHELL:$BASH_COMMAND"; v=set$BASH_SUBSHELL;; esac' DEBUG; {body}
wait; trap - DEBUG; echo "v=${{v-unset}}""#
		)
	};
	let rows = [
		(trap("", "/usr/bin/true mark &"), "0:/usr/bin/true mark\nv=set0\n"),
		(trap("", ": mark &"), "0:: mark\nv=set0\n"),
		(trap("", "x=mark &"), "0:x=mark\nv=set0\n"),
		(trap("", "x=mark /usr/bin/true &"), "0:x=mark /usr/bin/true\nv=set0\n"),
		(trap("", "f &"), "0:f\nv=set0\n"),
		(trap("", "eval ': mark' &"), "0:eval ': mark'\nv=set0\n"),
		(
			trap("", "/usr/bin/true mark | /usr/bin/true mark2 &"),
			"0:/usr/bin/true mark\n0:/usr/bin/true mark2\nv=set0\n",
		),
		(
			trap("", "/usr/bin/true mark | /usr/bin/true mark2"),
			"0:/usr/bin/true mark\n0:/usr/bin/true mark2\nv=set0\n",
		),
		(trap("", "{ : mark; } &"), "v=unset\n"),
		(trap("set -T;", "/usr/bin/true mark &"), "0:/usr/bin/true mark\nv=set0\n"),
		(trap("set -T;", "f &"), "0:f\n1:f\n1:: body\nv=set0\n"),
		(trap("set -T;", "eval ': mark' &"), "0:eval ': mark'\n1:: mark\nv=set0\n"),
		(trap("set -T;", "{ : mark; } &"), "1:: mark\nv=unset\n"),
		(
			trap("set -T;", "/usr/bin/true mark | /usr/bin/true mark2 &"),
			"0:/usr/bin/true mark\n0:/usr/bin/true mark2\nv=set0\n",
		),
		(
			trap("shopt -s lastpipe; set +m;", "/usr/bin/true mark | : mark2"),
			"0:/usr/bin/true mark\n0:: mark2\nv=set0\n",
		),
		(
			trap("set -T; shopt -s lastpipe; set +m;", "/usr/bin/true mark | : mark2"),
			"0:/usr/bin/true mark\n0:: mark2\nv=set0\n",
		),
		(trap("", "! : mark &"), "0:: mark\nv=set0\n"),
		(trap("set -T;", "! : mark &"), "0:: mark\nv=set0\n"),
		(trap("", "TIMEFORMAT=; time : mark1 | : mark2 &"), "v=unset\n"),
		(trap("", "TIMEFORMAT=; time ! : mark1 | : mark2 &"), "v=unset\n"),
		(
			trap("set -T;", "TIMEFORMAT=; time ! : mark1 | : mark2 &"),
			"1:: mark1\n1:: mark2\nv=unset\n",
		),
		(trap("", "{ : mark; } | : mark2 &"), "0:: mark2\nv=set0\n"),
		(trap("", "( : mark ) | : mark2 &"), "0:: mark2\nv=set0\n"),
		(trap("", "{ : mark; } | : mark2"), "0:: mark2\nv=set0\n"),
		(trap("", "( : mark ) | : mark2"), "0:: mark2\nv=set0\n"),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// In a background job's DEBUG trap the shell's own `$BASHPID` and
/// `$BASH_SUBSHELL` (0) show, and `$LINENO` is the command's line, with
/// and without `set -T`; `trap -p` lists the trap inside a job.
#[tokio::test(flavor = "multi_thread")]
async fn a_background_jobs_debug_trap_sees_the_shell() {
	let seen = |functrace: &str| {
		format!(
			"top=$BASHPID; {functrace} trap '[[ $BASH_COMMAND == *mark* ]] && echo \"same=$(( \
			 BASHPID == top )) sub=$BASH_SUBSHELL line=$LINENO\"' DEBUG\n/usr/bin/true mark & wait"
		)
	};
	let rows = [
		(seen(""), "same=1 sub=0 line=2\n"),
		(seen("set -T;"), "same=1 sub=0 line=2\n"),
		(
			r#"trap ": dbg" DEBUG; f() { trap -p DEBUG; }; f & wait"#.to_owned(),
			"trap -- ': dbg' DEBUG\n",
		),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// A lone job's or a function call's DEBUG trap action that waits for what
/// the row writes after `$!` (a command substitution, a loop): bash runs
/// it in the shell, where `(( BASH_SUBSHELL ))` is false and it does
/// nothing, so `$!` never waits. It ran in the job and `$!` waited for it:
/// every row hung to the run's bound.
#[tokio::test(flavor = "multi_thread")]
async fn bang_does_not_wait_for_a_lone_jobs_debug_trap() {
	let rows = [
		(
			format!(
				r#"{FIFO} set -T; trap '(( BASH_SUBSHELL )) && x=$(read -r l <&3; echo "$l")' DEBUG; /usr/bin/true & p=$!; echo go >&3; wait "$p"; echo "st=$?""#
			),
			"st=0\n",
		),
		(
			r#"set -T; trap '(( BASH_SUBSHELL )) && while :; do :; done' DEBUG; /bin/sleep 30 & kill "$!"; wait "$!"; echo "st=$?""#
				.to_owned(),
			"st=143\n",
		),
		(
			format!(
				r#"{FIFO} f() {{ :; }}; set -T; trap '(( BASH_SUBSHELL )) && [[ $BASH_COMMAND == f && -z $once ]] && {{ once=1; x=$(read -r l <&3; echo "$l"); }}' DEBUG; f & p=$!; echo go >&3; wait "$p"; echo "st=$?""#
			),
			"st=0\n",
		),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// A row that sets a DEBUG trap running `action`, runs `body`, and prints
/// `deep` if the trap nested past 4, then `done`. `d` counts trap runs: 2 in
/// the shell here, and each run nested inside an action adds one (a
/// substitution, stage or subshell copies it); past 4 the action marks a
/// file and leaves, so a recursion fails its row in milliseconds, with
/// `deep` in its output, instead of running until memory runs out.
fn bounded(action: &str, body: &str) -> String {
	format!(
		r#"D=$(mktemp -d); set -T; trap '(( ++d > 4 )) && {{ : > "$D/deep"; exit 9; }}; {action}' DEBUG; {body}; trap - DEBUG; [ -e "$D/deep" ] && echo deep; rm -r "$D"; echo done"#
	)
}

/// A DEBUG trap action's command or process substitution runs no DEBUG
/// trap and keeps `BASH_COMMAND`, as bash's does, so a trap that
/// substitutes, or runs a pipeline of simple commands, does not run itself
/// again: these rows recursed without end (bash goes on). A substitution
/// inside that substitution runs none either. A subshell runs the trap
/// again in bash too, so none of these rows has one. Each row is
/// [`bounded`].
#[tokio::test(flavor = "multi_thread")]
async fn a_debug_trap_does_not_run_itself_again() {
	let rows = [
		(bounded("x=$(echo y)", "/usr/bin/true"), "done\n"),
		(bounded("x=`echo y`", "/usr/bin/true"), "done\n"),
		(bounded("true | true", "/usr/bin/true"), "done\n"),
		(bounded("x=$(f() { :; }; f)", "/usr/bin/true"), "done\n"),
		(bounded("cat <(echo y) >/dev/null", "/usr/bin/true"), "done\n"),
		(bounded("echo y > >(cat >/dev/null)", "/usr/bin/true"), "done\n"),
		(bounded("x=$(y=$(: a; : b); : c)", "/usr/bin/true"), "done\n"),
		(
			r#"set -T; trap '[[ $BASH_COMMAND == ": mark" ]] && x=$(echo "$BASH_SUBSHELL:$BASH_COMMAND"; : inner)' DEBUG; : mark; echo "x=$x""#
				.to_owned(),
			"x=1:: mark\n",
		),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// A function a DEBUG trap action calls runs no RETURN trap, as in bash
/// (`execute_function`: a DEBUG trap loses the RETURN trap), also under
/// `set -T`, which gives functions the RETURN trap. Control: the same
/// function called by the script runs it.
#[tokio::test(flavor = "multi_thread")]
async fn a_debug_trap_action_runs_no_return_trap() {
	let rows = [
		(
			r#"g() { :; }; set -T; trap "echo ret" RETURN; trap '[[ $BASH_COMMAND == ": mark" ]] && g' DEBUG; : mark; trap - DEBUG RETURN; echo done"#,
			"done\n",
		),
		(r#"g() { :; }; set -T; trap "echo ret" RETURN; g; trap - RETURN; echo done"#, "ret\ndone\n"),
	];
	assert_bash_outputs(&rows).await;
}

/// The process `$!` names for a negated background pipeline, by the pid
/// probe ([`pid_row`]), as bash names it: `! a | PROG &` is known by its
/// last program. `kill` of `$!` ends the job. The row prints no `wait`
/// status: `wait` of that `$!` gives the job's negated status here (0)
/// where bash gives the program's (143), an older difference.
#[tokio::test(flavor = "multi_thread")]
async fn a_negated_pipelines_bang_names_what_bash_names() {
	let row = pid_row("! : | PROG").replace(r#"echo "st=$?"; "#, "");
	assert_bash_outputs(&[(row.as_str(), "program\n")]).await;
}

/// A `time`d background pipeline (`time a | PROG &`, `time ! a | PROG &`)
/// is known by its last program (`body_pipeline` unwraps `time`), as before
/// this change and as #171 names it: `program`, then the status of `wait`
/// after `kill` of `$!`. Kept differences from bash 5.2.21 and 5.3.20,
/// whose `$!` is the timed job's own subshell (`CMD_FORCE_SUBSHELL`): they
/// print `other`; and under `!`, `wait` gives the job's negated status here
/// (0) where bash gives its subshell's (143), as for `! a | PROG &`.
#[test]
fn a_timed_pipelines_bang_is_its_last_program() {
	let rows = [
		("TIMEFORMAT=; time : | PROG", "program\nst=143\n", "other\nst=143\n"),
		("TIMEFORMAT=; time ! : | PROG", "program\nst=0\n", "other\nst=143\n"),
	];
	let mut mismatches = Vec::new();
	for (start, want, bash) in rows {
		let row = pid_row(start);
		let out = output(obash().args(["-c", row.as_str()]));
		let stdout = String::from_utf8_lossy(&out.stdout);
		if (out.status.code(), stdout.as_ref()) != (Some(0), want) {
			mismatches.push(format!(
				"`{start}`\n  want: Some(0) {want:?} (bash 5.2.21 and 5.3.20: {bash:?})\n  omp:  {:?} \
				 {stdout:?}",
				out.status.code()
			));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ from the stated difference:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

/// `nohup` and `timeout` run their command in a subshell standing for the
/// external program bash would run, which runs no DEBUG trap: the trap
/// runs once for the `nohup` or `timeout` command, in the shell, as in
/// bash, and a trap action that runs one does not run itself again. At
/// 31f4f5a0 the tool's subshell ran the trap for its command (a third
/// `dbg`), and such an action ran itself again without end; those rows are
/// [`bounded`].
#[tokio::test(flavor = "multi_thread")]
async fn a_tools_command_runs_no_debug_trap() {
	let rows = [
		(
			"set -T; trap 'echo dbg' DEBUG; nohup /usr/bin/true; echo done".to_owned(),
			"dbg\ndbg\ndone\n",
		),
		(
			"set -T; trap 'echo dbg' DEBUG; timeout 5 /usr/bin/true; echo done".to_owned(),
			"dbg\ndbg\ndone\n",
		),
		(bounded("nohup /usr/bin/true >/dev/null 2>&1", "/usr/bin/true"), "done\n"),
		(bounded("timeout 5 /usr/bin/true", "/usr/bin/true & wait"), "done\n"),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// `extdebug`: a failing DEBUG trap, which the shell runs before it forks,
/// skips a background simple command (no job: `$!` stays unset; status 0, 1
/// for `! cmd &`; `PIPESTATUS` as it was) and a function job; in a pipeline
/// (foreground, background, `lastpipe`, `time`d) it skips that stage alone,
/// as bash forks no process for it: the next stage reads end of input, and
/// `PIPESTATUS` has no entry for it. A background pipeline whose stages are
/// all skipped starts no job. A skip waits for its own pipeline: a pipeline
/// or job a later stage's trap action runs does not take it, and a skip
/// whose pipeline never started (the trap `return`ed) is not used by the
/// next call. No row writes into a skipped reader: whether that write meets
/// a closed pipe is a race in bash too.
#[tokio::test(flavor = "multi_thread")]
async fn extdebug_skips_a_job_or_a_stage_before_it_forks() {
	let skip = |body: &str| {
		format!(
			r"shopt -s extdebug; f() {{ echo body; }}; trap '! [[ $BASH_COMMAND == *mark* || $BASH_COMMAND == f ]]' DEBUG; {body}"
		)
	};
	// Stage 1 fails its trap; stage 2's trap runs `action`; `ran` shows
	// whether stage 1 ran.
	let lifetime = |action: &str| {
		format!(
			r#"D=$(mktemp -d); shopt -s extdebug; trap 'case $BASH_COMMAND in *mark*) false;; "echo second") {action};; esac' DEBUG; : mark > "$D/ran" | echo second; trap - DEBUG; [ -e "$D/ran" ] && echo ran; rm -r "$D""#
		)
	};
	let rows = [
		(
			skip(r#"false; /bin/echo mark & echo "st=$? bang=${!:+set}"; wait; echo after"#),
			"st=0 bang=\nafter\n",
		),
		(skip("f & wait; echo after"), "after\n"),
		(skip(r#": mark | echo second; echo "ps=${PIPESTATUS[*]}""#), "second\nps=0\n"),
		(
			skip(r#"echo mark | (read -r x; echo "got=$x"); echo "ps=${PIPESTATUS[*]}""#),
			"got=\nps=0\n",
		),
		(skip(": mark | echo second & wait"), "second\n"),
		(skip(r#"echo mark | (read -r x; echo "got=$x") & wait"#), "got=\n"),
		(skip(r#"shopt -s lastpipe; set +m; : mark | read -r x; echo "x=${x-unset}""#), "x=\n"),
		// The `lastpipe` stage itself skipped: the `read` the shell would run
		// does not run.
		(skip(r#"shopt -s lastpipe; set +m; echo x | read -r x mark; echo "x=${x-unset}""#), "x=unset\n"),
		(
			skip(r#"TIMEFORMAT=; time : mark | echo second; echo "ps=${PIPESTATUS[*]}""#),
			"second\nps=0\n",
		),
		// Every stage skipped: status 0, `PIPESTATUS` as it was.
		(skip(r#"(exit 3); : mark | : mark2; echo "st=$? ps=${PIPESTATUS[*]}""#), "st=0 ps=3\n"),
		(
			skip(r#"(exit 3); : mark | : mark2 & echo "st=$? bang=${!:+set} ps=${PIPESTATUS[*]}""#),
			"st=0 bang= ps=3\n",
		),
		(skip(r#"(exit 3); ! : mark & echo "st=$? bang=${!:+set} ps=${PIPESTATUS[*]}""#), "st=1 bang= ps=3\n"),
		(skip(r#"(exit 3); : mark & echo "st=$? bang=${!:+set} ps=${PIPESTATUS[*]}""#), "st=0 bang= ps=3\n"),
		(lifetime(": | :"), "second\n"),
		(lifetime("/usr/bin/true & wait"), "second\n"),
		(lifetime("( : )"), "second\n"),
		(
			r#"D=$(mktemp -d); shopt -s extdebug; n=0; g() { : mark > "$D/ran" | echo second; }; trap 'case $BASH_COMMAND in *mark*) if (( n++ == 0 )); then false; fi;; "echo second") if (( n == 1 )); then n=2; return; fi;; esac' DEBUG; g; echo "call1 $([ -e "$D/ran" ] && echo ran)"; g; trap - DEBUG; echo "call2 $([ -e "$D/ran" ] && echo ran)"; rm -r "$D""#
				.to_owned(),
			"call1 \nsecond\ncall2 ran\n",
		),
		// The same, the second call made with no trap: it skips nothing.
		(
			r#"D=$(mktemp -d); shopt -s extdebug; n=0; g() { : mark > "$D/ran" | echo second; }; trap 'case $BASH_COMMAND in *mark*) if (( n++ == 0 )); then false; fi;; "echo second") if (( n == 1 )); then n=2; return; fi;; esac' DEBUG; g; trap - DEBUG; echo "call1 $([ -e "$D/ran" ] && echo ran)"; g; echo "call2 $([ -e "$D/ran" ] && echo ran)"; rm -r "$D""#
				.to_owned(),
			"call1 \nsecond\ncall2 ran\n",
		),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// The process `$!` names for a lone job whose DEBUG trap runs a program,
/// calls a function, or runs a builtin the staged path runs: the program,
/// as bash names it, since the shell ran the trap before it forked. The
/// job kept its own pid while the trap ran in it.
#[tokio::test(flavor = "multi_thread")]
async fn a_lone_jobs_debug_trap_does_not_change_its_bang() {
	let rows = [
		(pid_row("set -T; trap '/usr/bin/true' DEBUG; PROG"), "program\nst=143\n"),
		(pid_row("g() { :; }; set -T; trap g DEBUG; PROG"), "program\nst=143\n"),
		(
			pid_row(r#"set -T; trap 'echo "+ $BASH_COMMAND" >/dev/null' DEBUG; PROG"#),
			"program\nst=143\n",
		),
		// The trap's nesting depth bounds this row (the action adds one and
		// takes it back; the shell runs the trap often here): at 31f4f5a0 the
		// action ran itself again in `nohup`'s subshell without end.
		(
			pid_row(
				"set -T; trap '(( ++d > 4 )) && exit 9; nohup /usr/bin/true >/dev/null 2>&1; : $(( \
				 d-- ))' DEBUG; PROG",
			),
			"program\nst=143\n",
		),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
}

/// zsh: a trap function (any `TRAPNAL`; these rows use `TRAPDEBUG` and
/// `TRAPZERR`) whose last command fails lets the code go on (zsh 5.9 prints
/// the rest); only an explicit `return N` with N non-zero ends it (exit N).
/// The shell exited 1 after any failing trap function. `ERR_RETURN` in the
/// trap function returns from it but is no explicit `return`: the code goes
/// on (it ended at 8f6ae14d, which marked that return as explicit).
#[test]
fn a_zsh_trap_function_ends_the_code_only_on_return() {
	let rows: [(&str, &str, i32); 7] = [
		("TRAPDEBUG() { false; }; echo a; echo b", "a\nb\n", 0),
		("TRAPDEBUG() { return 1; }; echo a; echo b", "", 1),
		("TRAPZERR() { false; }; false; echo after", "after\n", 0),
		("TRAPZERR() { return 1; }; false; echo after", "", 1),
		(
			"TRAPDEBUG() { setopt localoptions errreturn; if [[ $ZSH_DEBUG_CMD == *mark* ]]; then \
			 false; fi }; print a; : mark; print b",
			"a\nb\n",
			0,
		),
		(
			"TRAPZERR() { setopt localoptions errreturn; false; print in-trap }; false; print after",
			"after\n",
			0,
		),
		(
			"TRAPDEBUG() { setopt localoptions errreturn; if [[ $ZSH_DEBUG_CMD == *mark* ]]; then \
			 return 3; fi }; print a; : mark; print b",
			"a\n",
			3,
		),
	];
	let mut mismatches = Vec::new();
	for (script, zsh_output, zsh_status) in rows {
		let out = output(obash().arg0("zsh").args(["-f", "-c", script]));
		let stdout = String::from_utf8_lossy(&out.stdout);
		if (out.status.code(), stdout.as_ref()) != (Some(zsh_status), zsh_output) {
			mismatches.push(format!(
				"`{script}`\n  zsh:  Some({zsh_status}) {zsh_output:?}\n  omp:  {:?} {stdout:?}",
				out.status.code()
			));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of 7 rows differ from zsh:\n{}",
		mismatches.len(),
		mismatches.join("\n")
	);
}

/// zsh: a command or process substitution in a DEBUG trap's action (`trap …
/// DEBUG` or `TRAPDEBUG`) runs no DEBUG trap, as zsh 5.9 runs none inside a
/// trap; these rows recursed without end. Each counts the trap's depth as
/// [`bounded`] does and prints `deep` past 4.
#[test]
fn a_zsh_trap_substitution_does_not_run_the_trap_again() {
	let row = |set: &str| {
		format!(
			"D=$(mktemp -d); {set}; /usr/bin/true; trap - DEBUG; unfunction TRAPDEBUG 2>/dev/null; \
			 [[ -e $D/deep ]] && print deep; rm -r $D; print done"
		)
	};
	let guard = "(( ++d > 4 )) && { : > $D/deep; exit 9 }";
	let rows = [
		row(&format!("trap '{guard}; x=$(print y)' DEBUG")),
		row(&format!("trap '{guard}; x=`print y`' DEBUG")),
		row(&format!("trap '{guard}; cat <(print y) >/dev/null' DEBUG")),
		row(&format!("TRAPDEBUG() {{ {guard}; x=$(print y) }}")),
		row(&format!("TRAPDEBUG() {{ {guard}; cat <(print y) >/dev/null }}")),
	];
	let mut mismatches = Vec::new();
	for script in &rows {
		let out = output(obash().arg0("zsh").args(["-f", "-c", script]));
		let stdout = String::from_utf8_lossy(&out.stdout);
		if (out.status.code(), stdout.as_ref()) != (Some(0), "done\n") {
			mismatches.push(format!(
				"`{script}`\n  zsh:  Some(0) \"done\\n\"\n  omp:  {:?} {stdout:?}",
				out.status.code()
			));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ from zsh:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

/// zsh: a background job's or a pipeline's DEBUG trap runs once, for the
/// whole command, as zsh 5.9 runs it (`trap … DEBUG` and `TRAPDEBUG`); the
/// shell-side trap run bash gives each simple stage is bash's alone.
#[test]
fn a_zsh_debug_trap_runs_once_for_a_job_or_a_pipeline() {
	let trap = r#"trap 'echo "dbg:$ZSH_DEBUG_CMD"' DEBUG;"#;
	let func = r#"TRAPDEBUG() { echo "dbg:$ZSH_DEBUG_CMD" };"#;
	let rows = [
		(format!("{trap} : mark & wait; echo done"), "dbg:: mark\ndbg:wait\ndbg:echo done\ndone\n"),
		(format!("{func} : mark & wait; echo done"), "dbg:: mark\ndbg:wait\ndbg:echo done\ndone\n"),
		(
			format!("{trap} : mark | : mark2; echo done"),
			"dbg:: mark | : mark2\ndbg:echo done\ndone\n",
		),
		(
			format!("{trap} : mark | : mark2 & wait; echo done"),
			"dbg:: mark | : mark2\ndbg:wait\ndbg:echo done\ndone\n",
		),
	];
	let mut mismatches = Vec::new();
	for (script, zsh_output) in &rows {
		let out = output(obash().arg0("zsh").args(["-f", "-c", script]));
		let stdout = String::from_utf8_lossy(&out.stdout);
		if (out.status.code(), stdout.as_ref()) != (Some(0), *zsh_output) {
			mismatches.push(format!(
				"`{script}`\n  zsh:  Some(0) {zsh_output:?}\n  omp:  {:?} {stdout:?}",
				out.status.code()
			));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ from zsh:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

/// The DEBUG trap state a snapshot must carry, run under obash's step fault
/// mode (`--fault=SEED:K --fault-mode=step`: every K ops a seeded coin
/// pauses and resumes, or restores a snapshot in the process), for seeds 1
/// to 6 and K of 1 to 3. Each row prints what bash 5.2.21 and 5.3.20 print
/// without faults:
/// - a substitution in a DEBUG trap's action runs no trap
///   (`Frame::no_debug_trap`, restored with the frame); [`bounded`], so a
///   recursion fails in milliseconds. The substitution runs a loop of 8 passes
///   so that a fault restores a snapshot while it runs: with `x=$(echo y)` the
///   plant that loses the flag on a restore failed only 1 or 2 of the 18
///   faulted runs, and in one runc Job none;
/// - an `extdebug` stage skip set before the fork (`Kernel::debug_skips`, saved
///   in the image): the skipped stage does not run (no `ran`).
#[test]
fn debug_trap_state_survives_a_restored_snapshot() {
	let rows = [
		(bounded("x=$(for i in 1 2 3 4 5 6 7 8; do :; done; echo y)", "/usr/bin/true; : two"), "done\n"),
		(
			r#"D=$(mktemp -d); shopt -s extdebug; trap 'case $BASH_COMMAND in *mark*) false;; esac' DEBUG; : mark > "$D/ran" | echo second; trap - DEBUG; [ -e "$D/ran" ] && echo ran; rm -r "$D"; echo done"#
				.to_owned(),
			"second\ndone\n",
		),
	];
	let mut mismatches = Vec::new();
	let mut runs = 0;
	for (script, bash_output) in &rows {
		for seed in 1..=6 {
			for k in 1..=3 {
				runs += 1;
				let fault = format!("--fault={seed}:{k}");
				let out = output(obash().args([fault.as_str(), "--fault-mode=step", "-c", script]));
				let stdout = String::from_utf8_lossy(&out.stdout);
				if (out.status.code(), stdout.as_ref()) != (Some(0), *bash_output) {
					mismatches.push(format!(
						"{fault} `{script}`\n  bash: Some(0) {bash_output:?}\n  omp:  {:?} {stdout:?}",
						out.status.code()
					));
				}
			}
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {runs} faulted runs differ from bash:\n{}",
		mismatches.len(),
		mismatches.join("\n")
	);
}

/// A DEBUG trap set inside a `lastpipe` stage (which bash runs in the shell
/// itself) runs for the commands after it there and in the shell, as in
/// bash 5.2.21 and 5.3.20; the shell does not run the pipeline's stage
/// traps again when the stage ends (the `Spawn` is under way then).
#[tokio::test(flavor = "multi_thread")]
async fn a_debug_trap_set_in_a_lastpipe_stage_runs_from_then_on() {
	let row = r#"shopt -s lastpipe; set +m; echo x | { trap 'echo "dbg:$BASH_COMMAND"' DEBUG; read -r v; }; trap - DEBUG; echo "v=$v""#;
	assert_bash_outputs(&[(row, "dbg:read -r v\ndbg:trap - DEBUG\nv=x\n")]).await;
}

/// A background pipeline whose first stage `extdebug` skips is named by its
/// last stage as without the skip: here a `{ … }` stage with two commands,
/// which keeps the job's own pid at once (`virtual`, with `kill` and `wait`
/// of `$!`: `st=143`). Kept difference: bash 5.2.21 and 5.3.20 print
/// `program`, as their `$!` is that stage's subshell, which `exec`s it.
/// The stages that ran are paired with their own entries, not with every
/// stage's.
#[test]
fn a_skipped_stage_does_not_change_which_stage_names_the_job() {
	let kind = |start: &str| {
		format!(
			r#"D=$(mktemp -d); T=$D/pid; {start} & p=$!; trap - DEBUG; until [ -s "$T" ]; do :; done; [ "$p" = "$(cat "$T")" ] && echo program || {{ [ "$p" -ge 1073741824 ] && echo virtual || echo os-other; }}; kill "$p"; wait "$p"; echo "st=$?"; kill "$(cat "$T")" 2>/dev/null; rm -r "$D""#
		)
	};
	let last = r#"{ /usr/bin/true; exec /bin/sh -c 'echo $$ > "$1"; exec /bin/sleep 30' sh "$T"; }"#;
	let rows = [
		kind(&format!(": | {last}")),
		kind(&format!(
			"shopt -s extdebug; trap '! [[ $BASH_COMMAND == *mark* ]]' DEBUG; : mark | {last}"
		)),
	];
	let mut mismatches = Vec::new();
	for row in &rows {
		let out = output(obash().args(["-c", row.as_str()]));
		let stdout = String::from_utf8_lossy(&out.stdout);
		if (out.status.code(), stdout.as_ref()) != (Some(0), "virtual\nst=143\n") {
			mismatches.push(format!(
				"`{row}`\n  want: Some(0) \"virtual\\nst=143\\n\" (bash 5.3.20: \
				 \"program\\nst=143\\n\")\n  omp:  {:?} {stdout:?}",
				out.status.code()
			));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of 2 rows differ from the stated difference:\n{}",
		mismatches.len(),
		mismatches.join("\n")
	);
}
