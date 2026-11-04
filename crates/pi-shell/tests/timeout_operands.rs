//! A timeout signals what the command actually runs, not a pre-read guess
//! about an env split string or an in-process wrapper.
#![cfg(unix)]

use bytes::Bytes;
use pi_shell::{ShellExecuteOptions, StreamSinks, cancel::CancelToken, execute_shell_streams};

async fn output(command: &str) -> String {
	let dir = tempfile::tempdir().unwrap();
	let (stdout, chunks) = flume::unbounded::<Bytes>();
	execute_shell_streams(
		ShellExecuteOptions {
			command: command.to_owned(),
			cwd: Some(dir.path().to_str().unwrap().to_owned()),
			timeout_ms: Some(30_000),
			..Default::default()
		},
		StreamSinks { stdout: Some(stdout), stderr: None },
		CancelToken::default(),
	)
	.await
	.unwrap();
	let bytes: Vec<u8> = chunks.try_iter().flat_map(|chunk| chunk.to_vec()).collect();
	String::from_utf8(bytes).unwrap()
}

#[tokio::test]
async fn a_programs_handler_status_survives_runtime_wrappers() {
	let mut wrong = Vec::new();
	for prefix in [
		"",
		"command ",
		"command -p ",
		"command -- ",
		"command command ",
		"env ",
		"nohup ",
		"timeout 20 ",
	] {
		let script = format!(
			"timeout --preserve-status 1 {prefix}/bin/sh -c 'trap \"exit 3\" TERM; /bin/sleep 5'; \
			 echo status:$?"
		);
		let got = output(&script).await;
		if got != "status:3\n" {
			wrong.push((prefix, got));
		}
	}
	assert!(wrong.is_empty(), "{wrong:#?}");
}

#[tokio::test]
async fn streamed_env_runs_the_command_before_signal_classification() {
	let got = output(
		"printf 'P=/bin/sh\\0' | timeout --preserve-status 1 env -i --env0-from=- env -S '${P}' -c \
		 'trap \"exit 3\" TERM; /bin/sleep 5'; echo status:$?",
	)
	.await;
	assert_eq!(got, "status:3\n");
}

#[tokio::test]
async fn a_shell_operand_cannot_continue_after_a_terminating_signal() {
	for command in ["eval '/bin/sleep 5; echo late'", "f", "f/x"] {
		let script = format!(
			"f() {{ /bin/sleep 5; echo late; }}; f/x() {{ /bin/sleep 5; echo late; }}; trap '' TERM; \
			 timeout --preserve-status 1 {command}; echo status:$?"
		);
		assert_eq!(output(&script).await, "status:143\n", "{command}");
	}
}

#[tokio::test]
async fn builtin_command_keeps_the_shell_as_the_signal_recipient() {
	let script = "timeout --preserve-status 1 builtin command /bin/sh -c 'trap \"exit 3\" TERM; \
	              /bin/sleep 5'; echo status:$?";
	assert_eq!(output(script).await, "status:143\n");
}

#[tokio::test]
async fn resetting_operand_signals_does_not_call_a_user_trap_function() {
	let script = "trap '' TERM; trap() { echo wrong-trap-function; }; timeout --preserve-status 1 \
	              eval '/bin/sleep 5; echo late'; echo status:$?";
	assert_eq!(output(script).await, "status:143\n");
}

#[tokio::test]
async fn quit_and_group_stop_do_not_end_a_shell_operand() {
	for signal in ["QUIT", "TSTP", "STOP"] {
		let script = format!(
			"timeout --preserve-status -s {signal} 1 eval '/bin/sleep 2; echo next'; echo status:$?"
		);
		assert_eq!(output(&script).await, "next\nstatus:0\n", "{signal}");
	}
}

#[tokio::test]
async fn a_nested_timeout_handles_its_signal_and_kill_deadline() {
	for (command, expected) in [
		(
			"timeout --preserve-status -s CONT 1 timeout 20 /bin/sh -c 'trap \"exit 5\" CONT; \
			 /bin/sleep 2; echo next'",
			"next\nstatus:0\n",
		),
		(
			"timeout --preserve-status -s ALRM 1 timeout 20 /bin/sh -c 'trap \"exit 3\" TERM; \
			 /bin/sleep 5'",
			"status:124\n",
		),
		(
			"timeout --preserve-status -s CONT 1 timeout -s CONT -k 2 20 eval '/bin/sleep 10; echo \
			 late'",
			"status:137\n",
		),
		("timeout -s CONT 1 timeout --foreground -s CONT -k 2 20 /bin/sleep 10", "status:124\n"),
		("timeout -s CONT 1 env timeout -s KILL 2 /bin/sleep 10", "status:137\n"),
		("timeout -s CONT 1 env /bin/sh -c '/bin/sleep 2; exit 137'", "status:124\n"),
	] {
		assert_eq!(output(&format!("{command}; echo status:$?")).await, expected, "{command}");
	}
}

#[tokio::test]
async fn a_shell_waiting_for_timeout_is_still_the_signal_recipient() {
	for operand in
		["eval 'timeout 20 /bin/sleep 3; echo late'", "builtin command timeout 20 /bin/sleep 3"]
	{
		let source = format!("timeout --preserve-status -s ALRM 1 {operand}; echo status:$?");
		assert_eq!(output(&source).await, "status:142\n", "{operand}");
	}
}
