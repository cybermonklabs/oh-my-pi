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
/// foreground pipeline's. A `time`d job forks first: under `set -T` it runs
/// its stages' traps itself.
#[tokio::test(flavor = "multi_thread")]
async fn a_debug_trap_runs_in_the_shell_before_it_forks() {
	let trap = |functrace: &str, body: &str| {
		format!(
			r#"f() {{ : body; }}; {functrace} trap 'case $BASH_COMMAND in *mark*|f|*body*) echo "$BASH_SUBSHELL:$BASH_COMMAND"; v=set$BASH_SUBSHELL;; esac' DEBUG; {body}
wait; trap - DEBUG; echo "v=${{v-unset}}""#
		)
	};
	let rows = [
		(trap("", "/bin/true mark &"), "0:/bin/true mark\nv=set0\n"),
		(trap("", ": mark &"), "0:: mark\nv=set0\n"),
		(trap("", "x=mark &"), "0:x=mark\nv=set0\n"),
		(trap("", "x=mark /bin/true &"), "0:x=mark /bin/true\nv=set0\n"),
		(trap("", "f &"), "0:f\nv=set0\n"),
		(trap("", "eval ': mark' &"), "0:eval ': mark'\nv=set0\n"),
		(
			trap("", "/bin/true mark | /bin/true mark2 &"),
			"0:/bin/true mark\n0:/bin/true mark2\nv=set0\n",
		),
		(
			trap("", "/bin/true mark | /bin/true mark2"),
			"0:/bin/true mark\n0:/bin/true mark2\nv=set0\n",
		),
		(trap("", "{ : mark; } &"), "v=unset\n"),
		(trap("set -T;", "/bin/true mark &"), "0:/bin/true mark\nv=set0\n"),
		(trap("set -T;", "f &"), "0:f\n1:f\n1:: body\nv=set0\n"),
		(trap("set -T;", "eval ': mark' &"), "0:eval ': mark'\n1:: mark\nv=set0\n"),
		(trap("set -T;", "{ : mark; } &"), "1:: mark\nv=unset\n"),
		(
			trap("set -T;", "/bin/true mark | /bin/true mark2 &"),
			"0:/bin/true mark\n0:/bin/true mark2\nv=set0\n",
		),
		(
			trap("shopt -s lastpipe; set +m;", "/bin/true mark | : mark2"),
			"0:/bin/true mark\n0:: mark2\nv=set0\n",
		),
		(
			trap("set -T; shopt -s lastpipe; set +m;", "/bin/true mark | : mark2"),
			"0:/bin/true mark\n0:: mark2\nv=set0\n",
		),
		(trap("", "! : mark &"), "0:: mark\nv=set0\n"),
		(trap("set -T;", "! : mark &"), "0:: mark\nv=set0\n"),
		(trap("", "TIMEFORMAT=; time : mark1 | : mark2 &"), "v=unset\n"),
		(trap("", "TIMEFORMAT=; time ! : mark1 | : mark2 &"), "v=unset\n"),
		(
			trap("set -T;", "TIMEFORMAT=; time ! : mark1 | : mark2 &"),
			"1:: mark1\n1:: mark2\nv=unset\n",
		),
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
			 BASHPID == top )) sub=$BASH_SUBSHELL line=$LINENO\"' DEBUG\n/bin/true mark & wait"
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
				r#"{FIFO} set -T; trap '(( BASH_SUBSHELL )) && x=$(read -r l <&3; echo "$l")' DEBUG; /bin/true & p=$!; echo go >&3; wait "$p"; echo "st=$?""#
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
/// again: these rows recursed without end (bash goes on). A subshell runs
/// the trap again in bash too, so none of these rows has one. Each row is
/// [`bounded`].
#[tokio::test(flavor = "multi_thread")]
async fn a_debug_trap_does_not_run_itself_again() {
	let rows = [
		(bounded("x=$(echo y)", "/bin/true"), "done\n"),
		(bounded("x=`echo y`", "/bin/true"), "done\n"),
		(bounded("true | true", "/bin/true"), "done\n"),
		(bounded("x=$(f() { :; }; f)", "/bin/true"), "done\n"),
		(bounded("cat <(echo y) >/dev/null", "/bin/true"), "done\n"),
		(bounded("echo y > >(cat >/dev/null)", "/bin/true"), "done\n"),
		(
			r#"set -T; trap '[[ $BASH_COMMAND == ": mark" ]] && x=$(echo "$BASH_SUBSHELL:$BASH_COMMAND"; : inner)' DEBUG; : mark; echo "x=$x""#
				.to_owned(),
			"x=1:: mark\n",
		),
	];
	let rows: Vec<(&str, &str)> = rows.iter().map(|(s, o)| (s.as_str(), *o)).collect();
	assert_bash_outputs(&rows).await;
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
		("set -T; trap 'echo dbg' DEBUG; nohup /bin/true; echo done".to_owned(), "dbg\ndbg\ndone\n"),
		(
			"set -T; trap 'echo dbg' DEBUG; timeout 5 /bin/true; echo done".to_owned(),
			"dbg\ndbg\ndone\n",
		),
		(bounded("nohup /bin/true >/dev/null 2>&1", "/bin/true"), "done\n"),
		(bounded("timeout 5 /bin/true", "/bin/true & wait"), "done\n"),
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
		(lifetime("/bin/true & wait"), "second\n"),
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
		(pid_row("set -T; trap '/bin/true' DEBUG; PROG"), "program\nst=143\n"),
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
				"set -T; trap '(( ++d > 4 )) && exit 9; nohup /bin/true >/dev/null 2>&1; : $(( d-- \
				 ))' DEBUG; PROG",
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
/// The shell exited 1 after any failing trap function.
#[test]
fn a_zsh_trap_function_ends_the_code_only_on_return() {
	let rows: [(&str, &str, i32); 4] = [
		("TRAPDEBUG() { false; }; echo a; echo b", "a\nb\n", 0),
		("TRAPDEBUG() { return 1; }; echo a; echo b", "", 1),
		("TRAPZERR() { false; }; false; echo after", "after\n", 0),
		("TRAPZERR() { return 1; }; false; echo after", "", 1),
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
		"{} of 4 rows differ from zsh:\n{}",
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
			"D=$(mktemp -d); {set}; /bin/true; trap - DEBUG; unfunction TRAPDEBUG 2>/dev/null; [[ -e \
			 $D/deep ]] && print deep; rm -r $D; print done"
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
