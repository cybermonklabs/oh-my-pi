//! The processes of a background pipeline as bash 5.3.20 and zsh 5.9 see
//! them (`obash -c`, `-f -c` as `zsh`; bash 5.2.21 prints the same). Both
//! fork every stage of an asynchronous pipeline, the last one too (bash's
//! `lastpipe` only applies to a synchronous one), and `$!` names the last
//! process: a last stage that runs no lone program has `$!` as its own pid
//! (`$BASHPID`). Once the shell reaped the last process, `kill(2)` of `$!`
//! gets `ESRCH`: `kill -0 $!` fails and `kill $!` signals nothing, though
//! the first stage runs on (it waits until the last program's pid is gone
//! from `/proc`, then writes R, so the answer does not depend on timing).
#![cfg(target_os = "linux")]

mod obash_support;

/// The first stage: once the last program's pid (in L) is gone from
/// `/proc`, it writes R, then waits for G and exits 7. The last program
/// writes its pid to L and exits 0.
const PIPELINE: &str = "/bin/sh -c 'until [ -s L ]; do :; done; read p < L; while [ -e /proc/$p \
                        ]; do :; done; : > R; until [ -e G ]; do :; done; exit 7' | /bin/sh -c \
                        'echo $$ > L; exit 0' & until [ -e R ]; do :; done; ";

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

/// Each row of `rows` (`name`, `script`, `zsh`) gives `out` on standard
/// output, nothing on standard error and status 0; every row that does not
/// is listed.
fn assert_rows(rows: &[(&str, String, bool)], out: &str) {
	let want = (out.to_owned(), String::new(), Some(0));
	let mismatches: Vec<String> = rows
		.iter()
		.filter_map(|(name, script, zsh)| {
			let got = run(script, *zsh);
			(got != want).then(|| format!("{name}: {got:?}, want {want:?}"))
		})
		.collect();
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

#[test]
fn the_last_stage_is_named_by_bang() {
	let script =
		"{ :; } | { echo $BASHPID > B; } & p=$!; wait; [ \"$(cat B)\" = \"$p\" ] && echo same";
	assert_rows(
		&[
			("bash", script.to_owned(), false),
			("bash lastpipe", format!("shopt -s lastpipe; {script}"), false),
		],
		"same\n",
	);
}

/// The modes whose pipeline's last stage ran in the job's own vproc, and
/// bash's own (a control that passed before).
const MODES: [(&str, &str, bool); 3] =
	[("zsh", "", true), ("bash lastpipe", "shopt -s lastpipe; ", false), ("bash", "", false)];

#[test]
fn kill_0_finds_no_process_once_the_last_program_ended() {
	let rows: Vec<(&str, String, bool)> = MODES
		.iter()
		.map(|&(name, pre, zsh)| {
			(
				name,
				format!(
					"{pre}{PIPELINE}kill -0 $! 2>/dev/null; echo \"alive=$?\"; : > G; wait; echo end"
				),
				zsh,
			)
		})
		.collect();
	assert_rows(&rows, "alive=1\nend\n");
}

#[test]
fn kill_signals_no_process_once_the_last_program_ended() {
	let rows: Vec<(&str, String, bool)> = MODES
		.iter()
		.map(|&(name, pre, zsh)| {
			(
				name,
				format!(
					"{pre}{PIPELINE}kill $! 2>/dev/null; echo \"k=$?\"; : > G; wait %1; echo \"w=$?\""
				),
				zsh,
			)
		})
		.collect();
	assert_rows(&rows, "k=1\nw=0\n");
}

/// Control: bash runs `time P &` in a subshell of its own, which `$!`
/// names and where the pipeline is synchronous, so `kill $!` ends that
/// subshell (status 143) whatever the stages do. Under `lastpipe` obash
/// runs a timed job's last stage in the job's own vproc, which `kill $!`
/// signals: the same answer, which a background pipeline's own rule must
/// not take from it.
#[test]
fn a_timed_job_under_lastpipe_is_killed_by_bang() {
	assert_rows(
		&[(
			"bash lastpipe",
			format!(
				"TIMEFORMAT=; shopt -s lastpipe; time {PIPELINE}kill $! 2>/dev/null; echo \"k=$?\"; : \
				 > G; wait %1; echo \"w=$?\""
			),
			false,
		)],
		"k=0\nw=143\n",
	);
}
