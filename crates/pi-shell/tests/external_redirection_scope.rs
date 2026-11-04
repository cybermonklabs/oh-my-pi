//! External-command redirections expand after Bash forks: their assignments,
//! arithmetic and fatal errors do not change or abandon the caller. Builtins,
//! functions, brace groups and `exec` expand redirections in the current shell.
//! Literal goldens were recorded with GNU Bash 5.3 using
//! `bash --noprofile --norc -c`, not a script file (fatal parameter expansion
//! under `-c` exits 127, not the script-file status 1). Tests use a fresh
//! directory.
#![cfg(unix)]

use bytes::Bytes;
use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, StreamSinks, execute_shell_streams},
};

async fn run(script: &str) -> (String, String, Option<i32>) {
	let dir = tempfile::tempdir().expect("working directory");
	let (stdout_tx, stdout_rx) = flume::unbounded::<Bytes>();
	let (stderr_tx, stderr_rx) = flume::unbounded::<Bytes>();
	let result = execute_shell_streams(
		ShellExecuteOptions {
			command: script.to_owned(),
			cwd: Some(dir.path().to_string_lossy().into_owned()),
			timeout_ms: Some(30_000),
			..Default::default()
		},
		StreamSinks { stdout: Some(stdout_tx), stderr: Some(stderr_tx) },
		CancelToken::new(Some(30_000)),
	)
	.await
	.unwrap_or_else(|error| panic!("{script}: {error}"));
	let collect = |rx: flume::Receiver<Bytes>| {
		let bytes: Vec<u8> = rx.drain().flat_map(|chunk| chunk.to_vec()).collect();
		String::from_utf8(bytes).expect("UTF-8 output")
	};
	(collect(stdout_rx), collect(stderr_rx), result.exit_code)
}

async fn assert_bash(rows: &[(&str, &str, bool, i32)]) {
	let mut differing = Vec::new();
	for &(script, stdout, diagnostic, status) in rows {
		let expected = (stdout.to_owned(), diagnostic, Some(status));
		let (out, err, code) = run(script).await;
		let observed = (out, !err.is_empty(), code);
		if observed != expected {
			differing.push(format!("{script}\n  Bash:     {expected:?}\n  observed: {observed:?}"));
		}
	}
	assert!(differing.is_empty(), "Bash 5.3 -c differences:\n{}", differing.join("\n"));
}

#[tokio::test]
async fn external_redirection_assignments_do_not_escape_to_the_caller() {
	assert_bash(&[
		(
			"unset x; /bin/true >\"${x:=/dev/null}\"; printf \"x=[%s] rc=%s\\n\" \"${x-unset}\" \
			 \"$?\"",
			"x=[unset] rc=0\n",
			false,
			0,
		),
		(
			"unset x; /bin/true >\"${x:=f}${missing:?boom}\"; printf \"x=[%s] rc=%s\\n\" \
			 \"${x-unset}\" \"$?\"",
			"x=[unset] rc=127\n",
			true,
			0,
		),
		(
			"unset x; /bin/true 2>/dev/null >\"${x:=f}${missing:?boom}\"; printf \"x=[%s] rc=%s\\n\" \
			 \"${x-unset}\" \"$?\"",
			"x=[unset] rc=127\n",
			false,
			0,
		),
		(
			"unset x y; /bin/true \"${x:=argument}\" <<<\"${y:=redirect}\"; printf \"x=[%s] y=[%s] \
			 rc=%s\\n\" \"${x-unset}\" \"${y-unset}\" \"$?\"",
			"x=[argument] y=[unset] rc=0\n",
			false,
			0,
		),
		(
			"unset x; i=0; command /bin/true <<<\"${x:=child}:$((i++))\"; printf \"x=[%s] i=%s \
			 rc=%s\\n\" \"${x-unset}\" \"$i\" \"$?\"",
			"x=[unset] i=0 rc=0\n",
			false,
			0,
		),
		(
			"unset fd; /bin/true {fd}>/dev/null; printf \"fd=[%s]\\n\" \"${fd-unset}\"",
			"fd=[unset]\n",
			false,
			0,
		),
		(
			"unset x; cat <<<\"${x:=child}\"; printf \"x=[%s] rc=%s\\n\" \"${x-unset}\" \"$?\"",
			"child\nx=[unset] rc=0\n",
			false,
			0,
		),
		(
			"unset x; bash -c 'read -r value; printf \"got=%s\\n\" \"$value\"' <<<\"${x:=child}\"; \
			 printf \"x=[%s] rc=%s\\n\" \"${x-unset}\" \"$?\"",
			"got=child\nx=[unset] rc=0\n",
			false,
			0,
		),
	])
	.await;
	parent_redirections_keep_builtin_function_group_and_exec_side_effects().await;
}

#[tokio::test]
async fn here_strings_and_documents_expand_in_the_external_child() {
	assert_bash(&[
		(
			"unset x; i=0; /bin/cat <<<\"${x:=child}:$((i++))\"; printf \"x=[%s] i=%s rc=%s\\n\" \
			 \"${x-unset}\" \"$i\" \"$?\"",
			"child:0\nx=[unset] i=0 rc=0\n",
			false,
			0,
		),
		(
			"unset x; i=0; /bin/cat <<EOF\n${x:=child}:$((i++))\nEOF\nprintf \"x=[%s] i=%s \
			 rc=%s\\n\" \"${x-unset}\" \"$i\" \"$?\"",
			"child:0\nx=[unset] i=0 rc=0\n",
			false,
			0,
		),
		(
			"unset x; /bin/cat <<<\"${x:=child}${missing:?boom}\"; printf \"x=[%s] rc=%s\\n\" \
			 \"${x-unset}\" \"$?\"",
			"x=[unset] rc=127\n",
			true,
			0,
		),
		(
			"unset x; /bin/cat <<EOF\n${x:=child}${missing:?boom}\nEOF\nprintf \"x=[%s] rc=%s\\n\" \
			 \"${x-unset}\" \"$?\"",
			"x=[unset] rc=127\n",
			true,
			0,
		),
	])
	.await;
}

#[tokio::test]
async fn external_redirection_failures_preserve_pipeline_and_background_status() {
	assert_bash(&[
		(
			"shopt -s lastpipe; unset x; : | /bin/true <<<\"${x:=child}${missing:?boom}\"; printf \
			 \"x=[%s] rc=%s ps=%s\\n\" \"${x-unset}\" \"$?\" \"${PIPESTATUS[*]}\"",
			"x=[unset] rc=127 ps=0 127\n",
			true,
			0,
		),
		(
			"unset x; i=0; /bin/true <<<\"${x:=child}:$((i++))\" | /bin/cat; printf \"x=[%s] i=%s \
			 ps=%s\\n\" \"${x-unset}\" \"$i\" \"${PIPESTATUS[*]}\"",
			"x=[unset] i=0 ps=0 0\n",
			false,
			0,
		),
		(
			"unset x; /bin/true >\"${x:=f}${missing:?boom}\" & wait \"$!\"; printf \"x=[%s] \
			 rc=%s\\n\" \"${x-unset}\" \"$?\"",
			"x=[unset] rc=127\n",
			true,
			0,
		),
		(
			"/bin/cat <<<\"depth=$BASH_SUBSHELL\" & wait \"$!\"; printf \"wait=%s\\n\" \"$?\"",
			"depth=1\nwait=0\n",
			false,
			0,
		),
		(
			": <<<\"${missing:?boom}\" & wait \"$!\"; printf \"wait=%s\\n\" \"$?\"",
			"wait=127\n",
			true,
			0,
		),
		(
			"command /bin/true <<<\"${missing:?boom}\" & wait \"$!\"; printf \"wait=%s\\n\" \"$?\"",
			"wait=127\n",
			true,
			0,
		),
		(
			"f() { /bin/cat <<<\"depth=$BASH_SUBSHELL\"; /bin/true <<<\"${missing:?boom}\"; printf \
			 \"function rc=%s\\n\" \"$?\"; }; f & wait \"$!\"; printf \"wait=%s\\n\" \"$?\"",
			"depth=1\nfunction rc=127\nwait=0\n",
			true,
			0,
		),
		(
			"{ /bin/cat <<<\"depth=$BASH_SUBSHELL\"; /bin/true <<<\"${missing:?boom}\"; printf \
			 \"group rc=%s\\n\" \"$?\"; } & wait \"$!\"; printf \"wait=%s\\n\" \"$?\"",
			"depth=1\ngroup rc=1\nwait=0\n",
			true,
			0,
		),
		(
			"( /bin/cat <<<\"depth=$BASH_SUBSHELL\"; /bin/true <<<\"${missing:?boom}\"; printf \"sub \
			 rc=%s\\n\" \"$?\"; ) & wait \"$!\"; printf \"wait=%s\\n\" \"$?\"",
			"depth=1\nsub rc=1\nwait=0\n",
			true,
			0,
		),
		(
			"( /bin/cat <<<\"depth=$BASH_SUBSHELL\" & wait \"$!\"; /bin/true <<<\"${missing:?boom}\" \
			 & wait \"$!\"; printf \"inside wait=%s\\n\" \"$?\" ); printf \"outer=%s\\n\" \"$?\"",
			"depth=2\ninside wait=1\nouter=0\n",
			true,
			0,
		),
		(
			"TIMEFORMAT=timed; time /bin/true <<<\"${missing:?boom}\" & wait \"$!\"; printf \
			 \"wait=%s\\n\" \"$?\"",
			"wait=1\n",
			true,
			0,
		),
		(
			"__port17714_missing_cmd__ <<<\"${missing:?boom}\" & wait \"$!\"; printf \"wait=%s\\n\" \
			 \"$?\"",
			"wait=127\n",
			true,
			0,
		),
		(
			"exec /bin/true <<<\"${missing:?boom}\" & wait \"$!\"; printf \"wait=%s\\n\" \"$?\"",
			"wait=127\n",
			true,
			0,
		),
		(
			"/bin/cat <<<\"$(printf \"depth=%s\" \"$BASH_SUBSHELL\")\" & wait \"$!\"; printf \
			 \"wait=%s\\n\" \"$?\"",
			"depth=2\nwait=0\n",
			false,
			0,
		),
		(
			"/bin/true <<<\"${ : \"${missing:?boom}\"; }\" & wait \"$!\"; printf \"wait=%s\\n\" \
			 \"$?\"",
			"wait=127\n",
			true,
			0,
		),
	])
	.await;
}

async fn parent_redirections_keep_builtin_function_group_and_exec_side_effects() {
	assert_bash(&[
		(
			"unset x; i=0; : <<<\"${x:=shell}:$((i++))\"; printf \"x=[%s] i=%s rc=%s\\n\" \
			 \"${x-unset}\" \"$i\" \"$?\"",
			"x=[shell] i=1 rc=0\n",
			false,
			0,
		),
		(
			"unset x; i=0; f() { :; }; f <<<\"${x:=shell}:$((i++))\"; printf \"x=[%s] i=%s \
			 rc=%s\\n\" \"${x-unset}\" \"$i\" \"$?\"",
			"x=[shell] i=1 rc=0\n",
			false,
			0,
		),
		(
			"unset x; i=0; { :; } <<<\"${x:=shell}:$((i++))\"; printf \"x=[%s] i=%s rc=%s\\n\" \
			 \"${x-unset}\" \"$i\" \"$?\"",
			"x=[shell] i=1 rc=0\n",
			false,
			0,
		),
		(
			"unset x; trap 'printf \"exit x=[%s] rc=%s\\n\" \"${x-unset}\" \"$?\"' EXIT; exec \
			 /bin/true >\"${x:=f}${missing:?boom}\"; printf \"continued\\n\"",
			"exit x=[f] rc=127\n",
			true,
			127,
		),
		("unset x; : <<<\"${x:=shell}${missing:?boom}\"; printf \"continued\\n\"", "", true, 127),
		(
			"unset x; shopt -s execfail; exec __port17714_missing_cmd__ <<<\"${x:=shell}\"; printf \
			 \"x=[%s] rc=%s\\n\" \"${x-unset}\" \"$?\"",
			"x=[shell] rc=127\n",
			true,
			0,
		),
		(
			"unset x; builtin __port17714_missing_cmd__ >\"${x:=/dev/null}\"; printf \"x=[%s] \
			 rc=%s\\n\" \"${x-unset}\" \"$?\"",
			"x=[/dev/null] rc=1\n",
			true,
			0,
		),
		(
			"unset x; builtin -q >\"${x:=/dev/null}\"; printf \"x=[%s] rc=%s\\n\" \"${x-unset}\" \
			 \"$?\"",
			"x=[/dev/null] rc=2\n",
			true,
			0,
		),
		(
			"set -o posix; command exec 9<missing; printf \"continued rc=%s\\n\" \"$?\"",
			"continued rc=1\n",
			true,
			0,
		),
		(
			"set -o posix; builtin exec 9<missing; printf \"continued rc=%s\\n\" \"$?\"",
			"continued rc=1\n",
			true,
			0,
		),
	])
	.await;
	let (stdout, stderr, status) = run(
		"unset x; builtin __port17714_missing_cmd__ >\"${x:=f}${missing:?boom}\"; printf \
		 \"continued\\n\"",
	)
	.await;
	assert_eq!((stdout.as_str(), status), ("", Some(127)));
	assert!(stderr.contains("boom"), "{stderr}");
	assert!(!stderr.contains("not a shell builtin"), "{stderr}");
}

#[tokio::test]
async fn external_children_preserve_prefix_scope_and_subshell_depth() {
	assert_bash(&[
		(
			"unset x; x=prefix /bin/cat <<<\"${x:=child}\"; printf \"x=[%s]\\n\" \"${x-unset}\"",
			"child\nx=[unset]\n",
			false,
			0,
		),
		// Bash 5.3's no-fork substitution must not regain the hidden
		// prefix environment while its body runs in the redirection child.
		(
			"unset x; x=prefix /bin/cat <<<\"${ printf '%s' \"${x-unset}\"; }\"; printf 'outer=[%s]\\n' \"${x-unset}\"",
			"unset\nouter=[unset]\n",
			false,
			0,
		),
		(
			"f(){ local x=local; x=prefix /bin/cat <<<\"${ printf '%s' \"$x\"; }\"; printf 'local=[%s]\\n' \"$x\"; }; f",
			"local\nlocal=[local]\n",
			false,
			0,
		),
		(
			"unset x; x=prefix read -r got <<<\"${ printf '%s' \"${x-unset}\"; }\"; printf '%s:%s\\n' \"$got\" \"${x-unset}\"",
			"unset:unset\n",
			false,
			0,
		),
		(
			"f() { local x=local i=0; x=prefix /bin/cat <<<\"${x}:$((i++))\"; printf \"x=[%s] i=%s \
			 rc=%s\\n\" \"$x\" \"$i\" \"$?\"; }; f",
			"local:0\nx=[local] i=0 rc=0\n",
			false,
			0,
		),
	])
	.await;
	let (stdout, stderr, status) = run(
		"/bin/cat <<<\"$BASH_SUBSHELL\"; /bin/true >\"$(printf \"sub=%s\\n\" \"$BASH_SUBSHELL\" \
		 >&2; printf /dev/null)\"",
	)
	.await;
	assert_eq!((stdout.as_str(), stderr.as_str(), status), ("0\n", "sub=1\n", Some(0)));
}

#[tokio::test]
async fn not_found_redirections_are_isolated_and_precede_the_lookup_diagnostic() {
	assert_bash(&[
		(
			"unset x; i=0; __port17714_missing_cmd__ <<<\"${x:=child}:$((i++))\"; printf \"x=[%s] \
			 i=%s rc=%s\\n\" \"${x-unset}\" \"$i\" \"$?\"",
			"x=[unset] i=0 rc=127\n",
			true,
			0,
		),
		(
			"unset x; /bin/true <missing >\"${x:=/dev/null}\"; printf \"x=[%s] rc=%s\\n\" \
			 \"${x-unset}\" \"$?\"",
			"x=[unset] rc=1\n",
			true,
			0,
		),
	])
	.await;
	let (stdout, stderr, status) = run(
		"unset x; __port17714_missing_cmd__ >\"${x:=f}${missing:?boom}\"; printf \"x=[%s] \
		 rc=%s\\n\" \"${x-unset}\" \"$?\"",
	)
	.await;
	assert_eq!((stdout.as_str(), status), ("x=[unset] rc=127\n", Some(0)));
	assert!(stderr.contains("boom"), "{stderr}");
	assert!(!stderr.contains("command not found"), "{stderr}");
}

#[tokio::test]
async fn external_redirect_failure_leaves_time_cleanup_in_the_parent() {
	let (stdout, stderr, status) = run(
		"unset x; TIMEFORMAT=timed; time /bin/true >\"${x:=f}${missing:?boom}\"; printf \"x=[%s] \
		 rc=%s\\n\" \"${x-unset}\" \"$?\"",
	)
	.await;
	assert_eq!((stdout.as_str(), status), ("x=[unset] rc=127\n", Some(0)));
	assert!(stderr.contains("boom"), "{stderr}");
	assert!(stderr.ends_with("timed\n"), "{stderr}");
	redirected_substitution_output_precedes_the_next_command().await;
}

async fn redirected_substitution_output_precedes_the_next_command() {
	let (stdout, stderr, status) = run(
		"/bin/true 2>&1 >\"$(printf \"redir\\n\" >&2; printf /dev/null)\"; printf \"after \
		 rc=%s\\n\" \"$?\"",
	)
	.await;
	assert_eq!((stdout.as_str(), stderr.as_str(), status), ("redir\nafter rc=0\n", "", Some(0)));
}
