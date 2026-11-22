//! `kill` of the pid `$!` names once `wait` collected that job, as bash
//! 5.2.21, 5.3.20 and zsh 5.9 answer (`obash -c`, `-f -c` as `zsh`): they
//! reaped the process, so `kill(2)` gets `ESRCH`: `kill -0 $p` fails and
//! `kill $p` signals nothing. A job still running is found (the control).
#![cfg(target_os = "linux")]

mod obash_support;

/// `script` through obash in a fresh directory (`zsh`: as `zsh -f -c`):
/// standard output, then standard error, then the exit status.
fn run(script: &str, zsh: bool) -> (String, String, Option<i32>) {
	let dir = tempfile::tempdir().unwrap();
	let mut cmd = obash_support::obash();
	cmd.current_dir(dir.path());
	if zsh {
		std::os::unix::process::CommandExt::arg0(&mut cmd, "zsh");
		cmd.arg("-f");
	}
	let out = obash_support::output(cmd.args(["-c", script]));
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status.code(),
	)
}

/// A lone program, a group, a subshell and a pipeline job, each collected
/// by `wait` or `wait $p`, then a running job (the control).
const SCRIPT: &str = "/bin/sh -c 'exit 0' & p=$!; wait $p; kill -0 $p 2>/dev/null; echo a=$?; { \
                      /bin/sh -c 'exit 0'; } & p=$!; wait; kill -0 $p 2>/dev/null; echo b=$?; ( : \
                      ) & p=$!; wait %1; kill -0 $p 2>/dev/null; echo c=$?; /bin/sh -c 'exit 0' | \
                      /bin/sh -c 'exit 0' & p=$!; wait; kill $p 2>/dev/null; echo d=$?; /bin/sh \
                      -c 'until [ -e G ]; do sleep 0.01; done' & p=$!; kill -0 $p; echo live=$?; \
                      : > G; wait";

#[test]
fn kill_finds_no_process_for_a_collected_job() {
	let want = (String::from("a=1\nb=1\nc=1\nd=1\nlive=0\n"), String::new(), Some(0));
	let mismatches: Vec<String> = [("bash", false), ("zsh", true)]
		.into_iter()
		.filter_map(|(name, zsh)| {
			let got = run(SCRIPT, zsh);
			(got != want).then(|| format!("{name}: {got:?}, want {want:?}"))
		})
		.collect();
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// bash: a process substitution's `$!` collected by `wait $p`, and a job
/// collected by `wait -n` (zsh has no `wait -n`).
#[test]
fn kill_finds_no_process_for_a_collected_procsub_or_wait_n_job() {
	let script = ": <(/bin/sh -c 'exit 4'); p=$!; sleep 0.3; wait $p; kill -0 $p 2>/dev/null; echo \
	              e=$?; /bin/sh -c 'exit 0' & p=$!; wait -n; kill -0 $p 2>/dev/null; echo f=$?";
	assert_eq!(run(script, false), (String::from("e=1\nf=1\n"), String::new(), Some(0)));
}
