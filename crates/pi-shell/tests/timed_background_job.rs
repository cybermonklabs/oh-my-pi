//! A timed background job (`time … &`), as bash 5.2.21 and 5.3.20 run it
//! (`obash -c`; zsh 5.9 where it agrees, `-f -c` as `zsh`). bash runs it as
//! a subshell of its own (`CMD_FORCE_SUBSHELL`), which `$!` and `jobs -p`
//! name: a real process (`/bin/kill -0`, `ps -p` find it) that lives as
//! long as the job, so `kill $!` and `wait $!` act on the whole job. obash
//! names the job's program as its untimed body would (the lone one, a
//! pipeline's last one), a real process, and that pid stands for the whole
//! job. Kept difference: bash's subshell is not that program (`$!` is not
//! the last program's pid there).
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
fn assert_rows(rows: &[(&str, String, bool, &str)]) {
	let mismatches: Vec<String> = rows
		.iter()
		.filter_map(|(name, script, zsh, out)| {
			let got = run(script, *zsh);
			let want = ((*out).to_owned(), String::new(), Some(0));
			(got != want).then(|| format!("{name}: {got:?}, want {want:?}"))
		})
		.collect();
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// `b` writes its pid to L and exits 0; `a` writes R once `b` is gone,
/// waits for G, and exits 7. Then `kill $!`, `wait $!`: the job, not `b`,
/// ends with 143.
const LAST_ENDED: &str = "time /bin/sh -c 'until [ -s L ]; do :; done; read p < L; while [ -e \
                          /proc/$p ]; do :; done; : > R; until [ -e G ]; do :; done; exit 7' | \
                          /bin/sh -c 'echo $$ > L; exit 0' & q=$!; until [ -e R ]; do :; done; \
                          kill $q 2>/dev/null; echo k=$?; : > G; wait $q; echo w=$?";

/// The first program writes its pid to S and runs until G. `kill -0 $!`
/// finds the job, `kill $!` ends it (143), and the first program runs on,
/// as in bash 5.2.21, 5.3.20 and zsh 5.9 (bash's subshell dies; its child
/// does not get the signal).
const FIRST_RUNS: &str = "time /bin/sh -c 'echo $$ > S; until [ -e G ]; do sleep 0.01; done' | \
                          /bin/true & p=$!; until [ -s S ]; do :; done; kill -0 $p; echo k0=$?; \
                          kill $p; echo k=$?; wait $p; echo w=$?; /bin/kill -0 $(cat S) && echo \
                          first=alive || echo first=gone; : > G";

#[test]
fn kill_and_wait_of_a_timed_jobs_pid_act_on_the_whole_job() {
	assert_rows(&[
		("bash", format!("exec 2>/dev/null; TIMEFORMAT=; {LAST_ENDED}"), false, "k=0\nw=143\n"),
		(
			"bash lastpipe",
			format!("exec 2>/dev/null; TIMEFORMAT=; shopt -s lastpipe; {LAST_ENDED}"),
			false,
			"k=0\nw=143\n",
		),
		("zsh", format!("exec 2>/dev/null; TIMEFMT=; {LAST_ENDED}"), true, "k=0\nw=143\n"),
		(
			"bash first runs",
			format!("exec 2>/dev/null; TIMEFORMAT=; {FIRST_RUNS}"),
			false,
			"k0=0\nk=0\nw=143\nfirst=alive\n",
		),
		(
			"zsh first runs",
			format!("exec 2>/dev/null; TIMEFMT=; {FIRST_RUNS}"),
			true,
			"k0=0\nk=0\nw=143\nfirst=alive\n",
		),
	]);
}

/// A program that runs until G or a signal, holding no output open (bash's
/// subshell can be killed while it runs on).
const RUNS: &str = "/bin/sh -c 'until [ -e G ]; do sleep 0.01; done' >/dev/null 2>&1";

#[test]
fn a_timed_jobs_pid_is_a_real_process() {
	let probe = "/bin/kill -0 \"$!\" 2>/dev/null && echo alive=yes || echo alive=no; ps -p \"$!\" \
	             >/dev/null 2>&1 && echo ps=yes || echo ps=no; [ \"$(jobs -p)\" = \"$!\" ] && echo \
	             jp=same || echo jp=differ";
	assert_rows(&[
		(
			"prog",
			format!(
				"TIMEFORMAT=; time {RUNS} & {probe}; /bin/kill \"$!\" 2>/dev/null; : > G; wait $!; \
				 echo w=$?"
			),
			false,
			"alive=yes\nps=yes\njp=same\nw=143\n",
		),
		(
			"pipe",
			format!("TIMEFORMAT=; time {RUNS} | {RUNS} & {probe}; : > G; wait $!; echo w=$?"),
			false,
			"alive=yes\nps=yes\njp=same\nw=0\n",
		),
	]);
}

/// A timed group or function whose first command runs a program is known
/// by that program, which stands for the job (`kill $!` ends it, 143); a
/// body that loops in the shell keeps the virtual pid at once, so `$!` does
/// not wait for it.
#[test]
fn a_timed_group_or_function_is_known_by_its_first_program() {
	let probe = "p=$!; /bin/kill -0 \"$p\" && echo alive=yes || echo alive=no; kill $p; echo k=$?; \
	             wait $p; echo w=$?; : > G";
	assert_rows(&[
		(
			"group",
			format!("exec 2>/dev/null; TIMEFORMAT=; time {{ {RUNS}; }} & {probe}"),
			false,
			"alive=yes\nk=0\nw=143\n",
		),
		(
			"function",
			format!("exec 2>/dev/null; TIMEFORMAT=; f() {{ {RUNS}; }}; time f & {probe}"),
			false,
			"alive=yes\nk=0\nw=143\n",
		),
		(
			"function calling a function",
			format!(
				"exec 2>/dev/null; TIMEFORMAT=; g() {{ {RUNS}; }}; f() {{ g; }}; time f & {probe}"
			),
			false,
			"alive=yes\nk=0\nw=143\n",
		),
		(
			"loop",
			String::from(
				"exec 2>/dev/null; TIMEFORMAT=; time { while :; do :; done; } & p=$!; echo got; kill \
				 $p; wait $p; echo w=$?",
			),
			false,
			"got\nw=143\n",
		),
	]);
}

/// A timed subshell whose first command runs a program is known by it too;
/// a timed builtin keeps the virtual pid at once, so the job has not run
/// when `kill $!` ends it (143), as bash's subshell has not either.
#[test]
fn a_timed_subshell_and_a_timed_builtin() {
	let probe = "p=$!; /bin/kill -0 \"$p\" && echo alive=yes || echo alive=no; kill $p; echo k=$?; \
	             wait $p; echo w=$?; : > G";
	assert_rows(&[
		(
			"subshell",
			format!("exec 2>/dev/null; TIMEFORMAT=; time ( {RUNS} ) & {probe}"),
			false,
			"alive=yes\nk=0\nw=143\n",
		),
		(
			"builtin",
			String::from(
				"exec 2>/dev/null; TIMEFORMAT=; time : & p=$!; kill $p; echo k=$?; wait $p; echo w=$?",
			),
			false,
			"k=0\nw=143\n",
		),
	]);
}
