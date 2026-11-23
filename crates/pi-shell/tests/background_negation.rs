//! The `!` of a background job, as bash 5.2.21, 5.3.20 and zsh 5.9 treat
//! it (`obash -c`, `-f -c` as `zsh`): the job's status is not inverted, so
//! `wait $!` returns the pipeline's own status, and `set -e` acts on it;
//! errexit stays off inside the job's pipeline. A `!` inside the job and an
//! and-or list invert as before. zsh 5.9 inverts a timed job's `!`; bash
//! does not.
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

/// Each row (`name`, `script`, `zsh`, `stdout`, `status`) prints its
/// stdout, nothing on stderr, and exits with its status; every row that
/// does not is listed.
fn assert_rows(rows: &[(&str, &str, bool, &str, i32)]) {
	let mismatches: Vec<String> = rows
		.iter()
		.filter_map(|&(name, script, zsh, out, status)| {
			let got = run(script, zsh);
			let want = (out.to_owned(), String::new(), Some(status));
			(got != want).then(|| format!("{name}: {got:?}, want {want:?}"))
		})
		.collect();
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// The statuses of four `!` jobs; the last is waited for by `wait`'s
/// operand `w` (zsh 5.9's `wait %1` may find the job gone already: `%1:
/// no such job`, 127, in some runs; `wait $!` always finds it).
fn statuses(w: &str) -> String {
	format!(
		"! /bin/false & wait $!; echo a=$?; ! /bin/true & wait $!; echo b=$?; ! /bin/true | \
		 /bin/false & wait $!; echo c=$?; ! /bin/sh -c 'exit 3' & wait {w}; echo d=$?"
	)
}

#[test]
fn a_background_jobs_negation_does_not_invert_its_status() {
	assert_rows(&[
		("bash", &statuses("%1"), false, "a=1\nb=0\nc=1\nd=3\n", 0),
		("zsh", &statuses("$!"), true, "a=1\nb=0\nc=1\nd=3\n", 0),
		("bash set -e", "set -e; ! /bin/false & wait $!; echo no", false, "", 1),
		("zsh set -e", "set -e; ! /bin/false & wait $!; echo no", true, "", 1),
		(
			"bash errexit off in the job",
			"set -e; ! { /bin/false; echo after; } & wait $!; echo st=$?",
			false,
			"after\nst=0\n",
			0,
		),
		(
			"bash pipefail",
			"set -o pipefail; ! /bin/false | /bin/true & wait $!; echo st=$?",
			false,
			"st=1\n",
			0,
		),
	]);
}

#[test]
fn a_negation_inside_the_job_still_inverts() {
	let script =
		"{ ! /bin/false; } & wait $!; echo e=$?; ! /bin/false && /bin/true & wait $!; echo f=$?";
	assert_rows(&[
		("bash", script, false, "e=0\nf=0\n", 0),
		("zsh", script, true, "e=0\nf=0\n", 0),
		("bash timed", "TIMEFORMAT=; time ! /bin/false & wait $!; echo g=$?", false, "g=1\n", 0),
		// zsh prints an empty timing line for an empty `TIMEFMT`.
		(
			"zsh timed",
			"exec 2>/dev/null; TIMEFMT=; time ! /bin/false & wait $!; echo g=$?",
			true,
			"g=0\n",
			0,
		),
	]);
}

/// `!` before and after `time`: bash keeps one flag per pipeline (`! time
/// ! P` is `P`) and drops a background job's `!` either way; zsh nests `!
/// time P` as a negated pipeline around the timed one, drops the outer `!`
/// of a background job and keeps the inner. In the foreground every order
/// inverts as written, in both shells (unchanged).
#[test]
fn negation_before_and_after_time() {
	let bg = "! time /bin/false & wait $!; echo h=$?; ! time ! /bin/false & wait $!; echo i=$?; \
	          time ! /bin/false & wait $!; echo g=$?";
	let fg = "! time /bin/false; echo a=$?; time ! /bin/false; echo b=$?; ! time ! /bin/false; \
	          echo c=$?; ! time /bin/true; echo d=$?";
	assert_rows(&[
		("bash &", &format!("exec 2>/dev/null; TIMEFORMAT=; {bg}"), false, "h=1\ni=1\ng=1\n", 0),
		("zsh &", &format!("exec 2>/dev/null; TIMEFMT=; {bg}"), true, "h=1\ni=0\ng=0\n", 0),
		("bash", &format!("exec 2>/dev/null; TIMEFORMAT=; {fg}"), false, "a=0\nb=0\nc=1\nd=1\n", 0),
		("zsh", &format!("exec 2>/dev/null; TIMEFMT=; {fg}"), true, "a=0\nb=0\nc=1\nd=1\n", 0),
	]);
}

/// `jobs` shows a job's own `!` pipeline as bash 5.2.21 and 5.3.20 do:
/// without the `!` for simple commands and a pipeline of several (it is a
/// flag of the commands there), with it for a lone compound command, in an
/// and-or list and in a timed pipeline (`time ! cmd`). The job waits on a
/// FIFO written after `jobs`.
#[test]
fn jobs_shows_a_jobs_own_bang_as_bash_does() {
	let row = |job: &str| format!("mkfifo ff; {job} & jobs; echo > ff; wait");
	let running = |text: &str| format!("[1]+  Running                    {text} &\n");
	assert_rows(&[
		("simple", &row("! read x < ff"), false, &running("read x < ff"), 0),
		("pipeline", &row("! read x < ff | true"), false, &running("read x < ff | true"), 0),
		("brace", &row("! { read x; } < ff"), false, &running("! { read x; } < ff"), 0),
		("subshell", &row("! ( read x ) < ff"), false, &running("! ( read x ) < ff"), 0),
		("and-or", &row("true && ! read x < ff"), false, &running("true && ! read x < ff"), 0),
		("timed", &row("TIMEFORMAT=; time ! read x < ff"), false, &running("time ! read x < ff"), 0),
	]);
}
