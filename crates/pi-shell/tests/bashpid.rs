//! `$BASHPID`, as Bash 5.3 shows it (Bash 5.2.21 agrees on every row): the
//! shell's own process, `$$`, at the top level, in a function, `eval`, a
//! group and a `lastpipe` stage; a child's own pid, unlike `$$` and unlike
//! each other's, in a subshell, a command substitution, a pipeline stage
//! and a background job.
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

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

/// `$BASHPID` is `$$` in the shell itself, wherever its code runs; it was
/// the shell's first virtual pid there, which no process has.
#[tokio::test(flavor = "multi_thread")]
async fn bashpid_is_the_shells_pid_in_the_shell() {
	let rows = [
		(r#"echo "same=$(( BASHPID == $$ ))""#, "same=1\n"),
		(r#"f() { echo "same=$(( BASHPID == $$ ))"; }; f"#, "same=1\n"),
		(r#"eval 'echo "same=$(( BASHPID == $$ ))"'"#, "same=1\n"),
		(r#"{ echo "same=$(( BASHPID == $$ ))"; }"#, "same=1\n"),
		(r#"shopt -s lastpipe; set +m; true | echo "same=$(( BASHPID == $$ ))""#, "same=1\n"),
		(r"trap 'echo got' USR1; kill -USR1 $BASHPID; echo after", "got\nafter\n"),
	];
	assert_bash_outputs(&rows).await;
}

/// A child's `$BASHPID` is its own: unlike `$$` and unlike another
/// child's.
#[tokio::test(flavor = "multi_thread")]
async fn a_childs_bashpid_is_its_own() {
	let rows = [
		(r#"( echo "same=$(( BASHPID == $$ ))" )"#, "same=0\n"),
		(r#"x=$(echo "same=$(( BASHPID == $$ ))"); echo "$x""#, "same=0\n"),
		(r#"echo "same=$(( BASHPID == $$ ))" | cat"#, "same=0\n"),
		(r#"true | echo "same=$(( BASHPID == $$ ))""#, "same=0\n"),
		(r#"{ echo "same=$(( BASHPID == $$ ))"; } & wait"#, "same=0\n"),
		(r#"a=$(echo $BASHPID); b=$(echo $BASHPID); echo "differ=$(( a != b ))""#, "differ=1\n"),
		(r#"( a=$BASHPID; b=$(echo $BASHPID); echo "differ=$(( a != b ))" )"#, "differ=1\n"),
		(r"( trap 'echo got' USR1; kill -USR1 $BASHPID; echo after )", "got\nafter\n"),
	];
	assert_bash_outputs(&rows).await;
}
