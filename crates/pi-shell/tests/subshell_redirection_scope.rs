//! Literal stdout, stderr presence and statuses recorded from GNU Bash 5.3
//! with `--noprofile --norc -c`. Entry redirections run in child state and
//! display the child's counter, while their fatal errors retain the caller's
//! invocation status. The no-fork syntax in the second test is new in 5.3.

#![cfg(unix)]

use bytes::Bytes;
use pi_shell::{
	ShellExecuteOptions,
	cancel::CancelToken,
	shell::{StreamSinks, execute_shell_streams},
};

async fn assert_script(script: &str, stdout: &str, diagnostic: bool, status: i32) {
	let dir = tempfile::tempdir().expect("working directory");
	let (out_tx, out_rx) = flume::unbounded::<Bytes>();
	let (err_tx, err_rx) = flume::unbounded::<Bytes>();
	let result = execute_shell_streams(
		ShellExecuteOptions {
			command: script.to_owned(),
			cwd: Some(dir.path().to_string_lossy().into_owned()),
			..Default::default()
		},
		StreamSinks { stdout: Some(out_tx), stderr: Some(err_tx) },
		CancelToken::new(Some(3000)),
	)
	.await
	.expect("shell execution");
	let out: Vec<u8> = out_rx.drain().flat_map(|chunk| chunk.to_vec()).collect();
	let err: Vec<u8> = err_rx.drain().flat_map(|chunk| chunk.to_vec()).collect();
	assert_eq!(
		(String::from_utf8(out).expect("UTF-8 stdout"), !err.is_empty(), result.exit_code),
		(stdout.to_owned(), diagnostic, Some(status)),
		"{script}: stderr={:?}",
		String::from_utf8_lossy(&err),
	);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn entry_redirections_use_child_state_and_depth() {
	for (script, stdout, diagnostic) in [
		(
			"unset x; ( : ) >\"${x:=made}${missing:?}\"; printf 'x=%s rc=%s\\n' \"${x-unset}\" \"$?\"",
			"x=unset rc=127\n",
			true,
		),
		(
			"unset x; ( printf '%s\\n' \"$BASH_SUBSHELL\" ) >\"${x:=out}-$BASH_SUBSHELL\"; printf \
			 'x=%s file=%s\\n' \"${x-unset}\" \"$(cat out-1)\"",
			"x=unset file=1\n",
			false,
		),
		(
			"( unset x; ( printf '%s\\n' \"$BASH_SUBSHELL\" ) >\"${x:=out}-$BASH_SUBSHELL\"; printf \
			 'x=%s file=%s\\n' \"${x-unset}\" \"$(cat out-2)\" )",
			"x=unset file=2\n",
			false,
		),
		(
			"unset x; ( cat ) <<<\"${x:=child}:$BASH_SUBSHELL\"; printf 'x=%s\\n' \"${x-unset}\"",
			"child:1\nx=unset\n",
			false,
		),
		(
			"unset x; ( cat ) <<EOF\n${x:=child}:$BASH_SUBSHELL\nEOF\nprintf 'x=%s\\n' \"${x-unset}\"",
			"child:1\nx=unset\n",
			false,
		),
	] {
		assert_script(script, stdout, diagnostic, 0).await;
	}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn entry_redirection_retains_depth_during_no_fork_substitution() {
	// Bash 5.2 rejects this syntax and cannot create out-1. Bash 5.3 runs
	// the substitution in the redirection's child context, with depth 1.
	assert_script(
		"unset x; ( printf BODY ) >\"${ x=child; printf 'out-%s' \"$BASH_SUBSHELL\"; }\"; printf \
		 'x=%s file=%s\\n' \"${x-unset}\" \"$(cat out-1)\"",
		"x=unset file=BODY\n",
		false,
		0,
	)
	.await;
}
