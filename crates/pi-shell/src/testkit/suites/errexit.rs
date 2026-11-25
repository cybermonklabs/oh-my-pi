//! `set -e`: where a failure exits the shell and where bash ignores it
//! (goldens from bash 5.3.20).

use crate::testkit::{FakeHost, Fault, run_script};

fn run(src: &str) -> (String, i32) {
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	(String::from_utf8_lossy(&out.stdout).into_owned(), out.status)
}

#[test]
fn conditions_lists_and_negation_do_not_exit() {
	let (out, status) = run(
		"set -e; if false; then :; fi; false && true; ! true; while false; do :; done; f() { false; \
		 echo in f; }; f || echo no; echo reached; false; echo not",
	);
	assert_eq!(out, "in f\nreached\n");
	assert_eq!(status, 1);
}

#[test]
fn subshells_inherit_the_context_of_their_command() {
	let (out, status) = run("set -e; (false; echo A $?) && echo B; echo C; (false; echo D); echo E");
	assert_eq!(out, "A 1\nB\nC\n");
	assert_eq!(status, 1);
}

#[test]
fn err_trap_runs_before_the_exit() {
	let (out, status) = run("set -e; trap 'echo err $?' ERR; false; echo no");
	assert_eq!(out, "err 1\n");
	assert_eq!(status, 1);
}

#[test]
fn command_substitution_resets_errexit_unless_inherit_errexit() {
	let (out, status) = run("set -e; echo $(false; echo ok); x=$(false); echo no");
	assert_eq!(out, "ok\n");
	assert_eq!(status, 1);
	let (out, status) = run("shopt -s inherit_errexit; set -e; echo \"[$(false; echo bad)]\"");
	assert_eq!(out, "[]\n");
	assert_eq!(status, 0);
}

#[test]
fn compound_status_alone_does_not_exit_but_a_function_call_does() {
	let (out, status) =
		run("set -e; { false && true; }; for ((i=0; i<2; i++)); do :; done; echo ok");
	assert_eq!(out, "ok\n");
	assert_eq!(status, 0);
	let (out, status) = run("set -e; f() { ! true; }; f; echo no");
	assert_eq!(out, "");
	assert_eq!(status, 1);
}

#[test]
fn functions_and_sourced_text_called_from_a_condition_ignore_it() {
	let (out, status) =
		run("set -e; g() { false; echo in g; }; g && echo t; eval 'false; echo ev' && echo t2");
	assert_eq!(out, "in g\nt\nev\nt2\n");
	assert_eq!(status, 0);
}

// Failure mode: the `!` of a background job inverted the job's status, so
// `wait $!` of `! false &` returned 0 and `set -e` let the shell run on.
// bash 5.3.20 (and 5.2.21, zsh 5.9) do not invert it: the asynchronous
// child clears `CMD_INVERT_RETURN`, and errexit stays off in the job's
// pipeline. Controls: a `!` inside the job, a timed one (bash: not
// inverted) and an and-or list keep their meaning.
#[test]
fn a_background_jobs_negation_does_not_invert_its_status() {
	let (out, status) = run(
		"! false & wait $!; echo a=$?; ! true & wait $!; echo b=$?; ! ( exit 3 ) & wait $!; echo \
		 c=$?; f() { return 2; }; ! f & wait $!; echo d=$?; ! false & echo q=$?; wait",
	);
	assert_eq!(out, "a=1\nb=0\nc=3\nd=2\nq=0\n");
	assert_eq!(status, 0);
	let (out, status) = run("set -e; ! { false; echo after; } & wait $!; echo st=$?");
	assert_eq!(out, "after\nst=0\n", "errexit is off in the job");
	assert_eq!(status, 0);
	let (out, status) = run("set -e; ! false & wait $!; echo no");
	assert_eq!(out, "", "wait returns 1, and set -e exits");
	assert_eq!(status, 1);
	let (out, status) = run(
		"{ ! false; } & wait $!; echo e=$?; ! false && true & wait $!; echo f=$?; TIMEFORMAT=; time \
		 ! false & wait $!; echo g=$?",
	);
	assert_eq!(out, "e=0\nf=0\ng=1\n", "controls");
	assert_eq!(status, 0);
}
