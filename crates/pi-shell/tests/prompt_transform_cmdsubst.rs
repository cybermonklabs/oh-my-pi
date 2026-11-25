//! `${x@P}` (bash's `@P` prompt transform) expands the value as a prompt,
//! running the command substitutions, backquotes and `${ ;}` bodies in it.
//! When the value holds one, the word must park on it like any other, not
//! reach `stop_flow` with an unhandled `Stop::Sub` and panic. The word is
//! not marked to park at compile time (the substitution is in the runtime
//! value), so the parks flag is set for every `@P` word.
#![cfg(unix)]

use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, execute_shell},
};

async fn run(command: &str, cwd: &std::path::Path) -> (Option<i32>, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = execute_shell(
		ShellExecuteOptions {
			command: command.to_string(),
			cwd: Some(cwd.to_string_lossy().into_owned()),
			timeout_ms: Some(30_000),
			..Default::default()
		},
		Some(tx),
		CancelToken::new(None),
	)
	.await
	.expect("shell execution");
	let output: String = rx.drain().collect();
	(result.exit_code, output)
}

/// `${x@P}` runs a `$( )` in the value and shows its output.
#[tokio::test]
async fn prompt_transform_runs_a_command_substitution_in_its_value() {
	let dir = tempfile::tempdir().expect("tempdir");
	let (code, output) = run("x='$(printf hi)'; echo \"[${x@P}]\"", dir.path()).await;
	assert_eq!(code, Some(0), "output: {output}");
	assert_eq!(output, "[hi]\n");
}

/// The crash case: the substitution exits nonzero and produces nothing;
/// the shell parks on it and the word expands to empty, rather than
/// panicking in `stop_flow` (`unreachable!("handled by the caller")`).
#[tokio::test]
async fn prompt_transform_substitution_that_exits_does_not_crash() {
	let dir = tempfile::tempdir().expect("tempdir");
	let (code, output) = run("x='$(exit 3)'; echo \"[${x@P}]done\"", dir.path()).await;
	assert_eq!(code, Some(0), "output: {output}");
	assert_eq!(output, "[]done\n");
}

/// A backquote substitution in the value runs too.
#[tokio::test]
async fn prompt_transform_runs_a_backquote_in_its_value() {
	let dir = tempfile::tempdir().expect("tempdir");
	let (code, output) = run("x='`printf bq`'; echo \"[${x@P}]\"", dir.path()).await;
	assert_eq!(code, Some(0), "output: {output}");
	assert_eq!(output, "[bq]\n");
}
