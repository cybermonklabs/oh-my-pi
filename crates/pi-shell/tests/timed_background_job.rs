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

// Every wait in these rows has its own bound: a loop that counts and exits
// 97, so a row whose signal never comes fails (a status 97, or `w=97`)
// instead of leaving a program running after the test.

/// `b` writes its pid to L and exits 0; `a` writes R once `b` is gone,
/// waits for G, and exits 7. Then `kill $!`, `wait $!`: the job, not `b`,
/// ends with 143.
const LAST_ENDED: &str = "time /bin/sh -c 'n=0; until [ -s L ]; do n=$((n+1)); [ $n -le 2000 ] || \
                          exit 97; sleep 0.01; done; read p < L; while [ -e /proc/$p ]; do \
                          n=$((n+1)); [ $n -le 4000 ] || exit 97; sleep 0.01; done; : > R; until \
                          [ -e G ]; do n=$((n+1)); [ $n -le 6000 ] || exit 97; sleep 0.01; done; \
                          exit 7' | /bin/sh -c 'echo $$ > L; exit 0' & q=$!; n=0; until [ -e R ]; \
                          do n=$((n+1)); [ $n -le 2000 ] || exit 97; sleep 0.01; done; kill $q \
                          2>/dev/null; echo k=$?; : > G; wait $q; echo w=$?";

/// The first program writes its pid to S and runs until G. `kill -0 $!`
/// finds the job, `kill $!` ends it (143), and the first program runs on,
/// as in bash 5.2.21, 5.3.20 and zsh 5.9 (bash's subshell dies; its child
/// does not get the signal).
const FIRST_RUNS: &str = "time /bin/sh -c 'echo $$ > S; n=0; until [ -e G ]; do n=$((n+1)); [ $n \
                          -le 2000 ] || exit 97; sleep 0.01; done' | /bin/true & p=$!; n=0; until \
                          [ -s S ]; do n=$((n+1)); [ $n -le 2000 ] || exit 97; sleep 0.01; done; \
                          kill -0 $p; echo k0=$?; kill $p; echo k=$?; wait $p; echo w=$?; \
                          /bin/kill -0 $(cat S) && echo first=alive || echo first=gone; : > G";

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
/// subshell can be killed while it runs on); it gives up after 10 s (97),
/// before the harness's 30 s bound.
const RUNS: &str = "/bin/sh -c 'n=0; until [ -e G ]; do n=$((n+1)); [ $n -le 1000 ] || exit 97; \
                    sleep 0.01; done' >/dev/null 2>&1";

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
			"negated prog",
			format!("TIMEFORMAT=; time ! {RUNS} & {probe}; kill $!; wait $!; echo w=$?; : > G"),
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

/// `/bin/kill -0` of `$!`, then the builtin `kill` and `wait`.
const PROBE: &str = "p=$!; /bin/kill -0 \"$p\" && echo alive=yes || echo alive=no; kill $p; echo \
                     k=$?; wait $p; echo w=$?; : > G";

/// A timed group, subshell or function whose only command runs a program
/// is known by that program, the job's whole life, which stands for the job
/// (`kill $!` ends it, 143). A body with a second command keeps the virtual
/// pid at once (no other program finds it), so an outside `kill` cannot end
/// its first program while the body runs on; the builtin `kill` still ends
/// the whole job. A body that loops in the shell keeps it too, so `$!` does
/// not wait for it.
#[test]
fn a_timed_body_is_known_by_its_program_only_when_that_program_is_its_whole_life() {
	let row = |name: &'static str, body: String, want: &'static str| {
		(name, format!("exec 2>/dev/null; TIMEFORMAT=; {body} & {PROBE}"), false, want)
	};
	let real = "alive=yes\nk=0\nw=143\n";
	let not = "alive=no\nk=0\nw=143\n";
	assert_rows(&[
		row("group", format!("time {{ {RUNS}; }}"), real),
		row("subshell", format!("time ( {RUNS} )"), real),
		row("function", format!("f() {{ {RUNS}; }}; time f"), real),
		row("function calling a function", format!("g() {{ {RUNS}; }}; f() {{ g; }}; time f"), real),
		row("two-command group", format!("time {{ {RUNS}; /bin/echo rest; }}"), not),
		row("two-command subshell", format!("time ( {RUNS}; /bin/echo rest )"), not),
		row("two-command function", format!("f() {{ {RUNS}; /bin/echo rest; }}; time f"), not),
		row("builtin first in a function", format!("f() {{ :; {RUNS}; }}; time f"), not),
		row("negated group", format!("time {{ ! {RUNS}; }}"), real),
		row(
			"a group, then a command, in a subshell",
			format!("time ( {{ {RUNS}; }}; /bin/echo rest )"),
			not,
		),
		row("a timed first pipeline of a list", format!("time {RUNS} && /bin/echo rest"), not),
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

/// An outside `kill` of a two-command body's `$!` finds no process (the
/// limit): the body runs on to its end. bash 5.2.21 and 5.3.20 name their
/// subshell, so there the kill ends the job (`kill=0`, `w=143`, no `rest`).
#[test]
fn an_outside_kill_of_a_two_command_body_finds_no_process() {
	assert_rows(&[(
		"group",
		format!(
			"exec 2>/dev/null; TIMEFORMAT=; time {{ {RUNS}; /bin/echo rest; }} & p=$!; /bin/kill \
			 \"$p\"; echo kill=$?; : > G; wait $p; echo w=$?"
		),
		false,
		"kill=1\nrest\nw=0\n",
	)]);
}

/// The `TIMEFORMAT` report after an outside `kill` of the program `$!`
/// names is still printed (the limit): obash cannot tell that kill from the
/// program's own death by a signal, after which bash prints it too. bash
/// 5.2.21 and 5.3.20 print none here: the kill ended their subshell.
#[test]
fn the_report_after_an_outside_kill_of_the_named_program_is_printed() {
	assert_rows(&[(
		"prog",
		format!(
			"exec 2>&1; TIMEFORMAT=report; time {RUNS} & p=$!; /bin/kill \"$p\"; wait $p; echo w=$?; \
			 : > G"
		),
		false,
		"report\nw=143\n",
	)]);
}

/// A timed builtin keeps the virtual pid at once, so the job has not run
/// when `kill $!` ends it (143), as bash's subshell has not either.
#[test]
fn a_timed_builtin_keeps_the_virtual_pid() {
	assert_rows(&[(
		"builtin",
		String::from(
			"exec 2>/dev/null; TIMEFORMAT=; time : & p=$!; kill $p; echo k=$?; wait $p; echo w=$?",
		),
		false,
		"k=0\nw=143\n",
	)]);
}

/// When the program a timed job's `$!` names dies by a signal, the job's
/// status is that signal's, whatever a `!` in the body does with the
/// program's status: `/bin/kill $!` and the builtin `kill $!` both give
/// 143, as bash 5.2.21 and 5.3.20 do (their `$!` is the job's forced
/// subshell, which the signal kills). It gave 0 for `/bin/kill`.
#[test]
fn a_signal_death_of_the_named_program_is_the_jobs_status() {
	let row = |name: &'static str, body: String, kill: &str| {
		(
			name,
			format!(
				"exec 2>/dev/null; TIMEFORMAT=; {body} & p=$!; {kill} \"$p\"; wait $p; echo w=$?; : > \
				 G"
			),
			false,
			"w=143\n",
		)
	};
	assert_rows(&[
		row("negated prog, /bin/kill", format!("time ! {RUNS}"), "/bin/kill"),
		row("negated prog, kill", format!("time ! {RUNS}"), "kill"),
		row("negated group, /bin/kill", format!("time {{ ! {RUNS}; }}"), "/bin/kill"),
		row("negated group, kill", format!("time {{ ! {RUNS}; }}"), "kill"),
		row("negated subshell, /bin/kill", format!("time ( ! {RUNS} )"), "/bin/kill"),
		row("negated function, /bin/kill", format!("f() {{ ! {RUNS}; }}; time f"), "/bin/kill"),
	]);
}

/// The limit: obash cannot tell an outside kill of the named program from
/// its own death by a signal, so a `!` inside a group does not invert that
/// death either (`w=143`); bash 5.2.21 and 5.3.20 give 0 here, their
/// subshell being alive. An exit status is still inverted, as in bash.
#[test]
fn a_programs_own_signal_death_under_a_bang_in_a_group_is_the_jobs_status() {
	assert_rows(&[
		(
			"signal",
			String::from(
				"exec 2>/dev/null; TIMEFORMAT=; time { ! /bin/sh -c 'kill -TERM $$'; } & wait $!; \
				 echo w=$?",
			),
			false,
			"w=143\n",
		),
		(
			"exit",
			String::from(
				"exec 2>/dev/null; TIMEFORMAT=; time { ! /bin/sh -c 'exit 3'; } & wait $!; echo w=$?",
			),
			false,
			"w=0\n",
		),
	]);
}
