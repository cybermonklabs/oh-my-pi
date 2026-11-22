//! A background pipeline's status under `pipefail`, as zsh 5.9 and bash
//! 5.2.21/5.3.20 give it (`obash -f -c` as `zsh`, `obash -c`). zsh gives
//! the job the last process's own status whatever `pipefail` says, as it
//! applies `PIPEFAIL` only to a job waited for in the foreground; a
//! pipeline inside the job, a timed one and a foreground one keep it. bash
//! applies `pipefail` to the job.
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

/// Each row (`name`, `script`, `zsh`, `stdout`) prints its stdout, nothing
/// on stderr, and exits 0; every row that does not is listed.
fn assert_rows(rows: &[(&str, &str, bool, &str)]) {
	let mismatches: Vec<String> = rows
		.iter()
		.filter_map(|&(name, script, zsh, out)| {
			let got = run(script, zsh);
			let want = (out.to_owned(), String::new(), Some(0));
			(got != want).then(|| format!("{name}: {got:?}, want {want:?}"))
		})
		.collect();
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

const JOBS: &str = "/bin/false | /bin/true & wait $!; echo a=$?; /bin/sh -c 'exit 3' | /bin/true \
                    & wait %1; echo b=$?; /bin/false | /bin/true | /bin/true & wait $!; echo \
                    c=$?; /bin/true | /bin/false & wait $!; echo d=$?";

#[test]
fn zsh_leaves_pipefail_out_of_a_background_pipelines_status() {
	assert_rows(&[
		("zsh pipefail", &format!("set -o pipefail; {JOBS}"), true, "a=0\nb=0\nc=0\nd=1\n"),
		("zsh", JOBS, true, "a=0\nb=0\nc=0\nd=1\n"),
		("bash pipefail", &format!("set -o pipefail; {JOBS}"), false, "a=1\nb=3\nc=1\nd=1\n"),
		("bash", JOBS, false, "a=0\nb=0\nc=0\nd=1\n"),
	]);
}

#[test]
fn zsh_keeps_pipefail_inside_a_job_and_in_the_foreground() {
	assert_rows(&[
		(
			"zsh",
			"set -o pipefail; { /bin/false | /bin/true; } & wait $!; echo e=$?; f() { /bin/false | \
			 /bin/true; }; f & wait $!; echo f=$?; /bin/false | /bin/true; echo g=$?",
			true,
			"e=1\nf=1\ng=1\n",
		),
		(
			"zsh timed",
			"exec 2>/dev/null; TIMEFMT=; set -o pipefail; time /bin/false | /bin/true & wait $!; \
			 echo h=$?",
			true,
			"h=1\n",
		),
	]);
}
