//! A dynamic PS4 is expanded and written before evaluation reports an error.
//! Expected trace prefixes and exit statuses were recorded with GNU Bash 5.3
//! under `bash --noprofile --norc -c`, not a script file.

#![cfg(unix)]

use bytes::Bytes;
use pi_shell::{
	ShellExecuteOptions,
	cancel::CancelToken,
	shell::{StreamSinks, execute_shell_streams},
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dynamic_trace_prefix_precedes_arithmetic_diagnostics() {
	for (body, prefix, status) in [
		("((1/0)); set +x", "P+ (( 1/0 ))\n", 0),
		("[[ 1/0 -eq 0 ]]; set +x", "P+ [[ 1/0 -eq 0 ]]\n", 0),
		("set -e; f(){ ((1/0)); }; f; printf BAD", "P+ (( 1/0 ))\n", 1),
	] {
		let script = format!("PS4='$(printf P)+ '; set -x; {body}");
		let (out_tx, out_rx) = flume::unbounded::<Bytes>();
		let (err_tx, err_rx) = flume::unbounded::<Bytes>();
		let result = execute_shell_streams(
			ShellExecuteOptions { command: script.clone(), ..Default::default() },
			StreamSinks { stdout: Some(out_tx), stderr: Some(err_tx) },
			CancelToken::new(Some(3000)),
		)
		.await
		.expect("shell execution");
		let stderr: Vec<u8> = err_rx.drain().flat_map(|chunk| chunk.to_vec()).collect();
		let stderr = String::from_utf8(stderr).expect("UTF-8 stderr");
		let trace = stderr
			.find(prefix)
			.unwrap_or_else(|| panic!("{script}: missing trace in {stderr:?}"));
		let diagnostic = stderr
			.find("division by 0")
			.unwrap_or_else(|| panic!("{script}: missing diagnostic in {stderr:?}"));
		assert!(trace < diagnostic, "{script}: diagnostic preceded its trace: {stderr:?}");
		assert_eq!(stderr.matches(prefix).count(), 1, "{script}: trace was replayed: {stderr:?}");
		assert_eq!(result.exit_code, Some(status), "{script}: {result:?}");
		assert!(
			out_rx.drain().all(|chunk| chunk.is_empty()),
			"{script}: command continued after fatal error"
		);
	}
}
