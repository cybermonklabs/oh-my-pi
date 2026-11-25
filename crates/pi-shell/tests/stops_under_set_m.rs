//! A command that stops under `set -m`, against Bash 5.3.20's answers
//! (`bash -c` and `bash row.sh`, measured as uid 1000 and as root, under
//! runc and gVisor). Bash takes the stop whenever job control is on, with a
//! terminal or without one (jobs.c `waitchld` waits with `WUNTRACED` under
//! `job_control`): `$?` is 128 + the signal, a failure for `set -e` and the
//! `ERR` trap; the pipeline becomes a stopped job that `jobs` lists, and the
//! shell goes on right after it, in a loop or a function too. A job, in the
//! foreground or not, stops once none of its processes runs, and `SIGTSTP`
//! breaks the loops that are running. A shell that is not interactive
//! prints nothing about the stop.
//!
//! Each row runs with no terminal (stdin `/dev/null`, stdout and stderr
//! pipes: how agents run the shell) and as the session of a pty (the
//! terminal is the shell's controlling terminal and its stdio, so stdout and
//! stderr arrive merged, each newline as `\r\n`). Bash's answers are the
//! same both ways but where a row says otherwise. A run, and the end of its
//! output after it, waits at most the support modules' bound
//! ([`obash_support::LIMIT`]), which only turns a hang into a failure that
//! names its row: Bash answers each row in well under a second. Each row
//! continues its jobs and waits for them, so no stopped process is left
//! holding the row's output.
#![cfg(target_os = "linux")]

mod obash_support;
mod pty_support;
mod zsh_oracle;

use std::{
	io::Read,
	os::unix::process::CommandExt,
	process::Command,
	sync::mpsc,
	thread,
	time::{Duration, Instant},
};

/// The bound of a run and of the end of its output ([`obash_support::LIMIT`]).
const BOUND: Duration = obash_support::LIMIT;

/// How a row's script reaches the shell: `-c script`, or a file `row.sh`.
#[derive(Clone, Copy, Debug)]
enum Via {
	Command,
	File,
}

/// What a run gave: the exit status (`None`: it did not end within
/// [`BOUND`]), stdout and stderr, and whether its output pipes were still
/// held [`BOUND`] after it ended.
#[derive(Debug)]
struct Ran {
	status: Option<i32>,
	out:    String,
	err:    String,
	held:   bool,
}

/// `text` with each line's `NAME: line 1: ` prefix dropped (the shell's
/// name, or the script's path).
fn normalised(text: &str) -> String {
	let mut out = String::new();
	for line in text.split_inclusive('\n') {
		out.push_str(line.split_once(": line 1: ").map_or(line, |(_, rest)| rest));
	}
	out
}

/// Read `pipe` to its end on a thread; its bytes go to `tx` as `(i, bytes)`.
fn reader(mut pipe: impl Read + Send + 'static, i: usize, tx: mpsc::Sender<(usize, Vec<u8>)>) {
	thread::spawn(move || {
		let mut bytes = Vec::new();
		let _ = pipe.read_to_end(&mut bytes);
		let _ = tx.send((i, bytes));
	});
}

/// `script` through obash with no terminal, as [`obash_support::obash`]
/// starts it, in a directory of its own.
fn run_without_a_terminal(script: &str, via: Via) -> Ran {
	run_obash(None, &[], script, via)
}

/// [`run_without_a_terminal`] with obash invoked as `name` (`argv[0]`, the
/// shell it runs as) when given, and its own options `opts` first.
fn run_obash(name: Option<&str>, opts: &[&str], script: &str, via: Via) -> Ran {
	let dir = tempfile::tempdir().unwrap();
	let mut cmd: Command = obash_support::obash();
	if let Some(name) = name {
		cmd.arg0(name);
	}
	cmd.args(opts);
	match via {
		Via::Command => cmd.args(["-c", script]),
		Via::File => {
			std::fs::write(dir.path().join("row.sh"), script).unwrap();
			cmd.arg("row.sh")
		},
	};
	cmd.current_dir(dir.path());
	let mut child = cmd.spawn().unwrap();
	let (tx, rx) = mpsc::channel();
	reader(child.stdout.take().unwrap(), 0, tx.clone());
	reader(child.stderr.take().unwrap(), 1, tx);
	let deadline = Instant::now() + BOUND;
	let status = loop {
		if let Some(status) = child.try_wait().unwrap() {
			break Some(status);
		}
		if Instant::now() >= deadline {
			obash_support::kill_all(&mut child);
			let _ = child.wait();
			break None;
		}
		thread::sleep(Duration::from_millis(5));
	};
	let mut got: [Option<Vec<u8>>; 2] = [None, None];
	let drained = Instant::now() + BOUND;
	while got.iter().any(Option::is_none) {
		match rx.recv_timeout(drained.saturating_duration_since(Instant::now())) {
			Ok((i, bytes)) => got[i] = Some(bytes),
			Err(_) => break,
		}
	}
	obash_support::kill_all(&mut child);
	let held = got.iter().any(Option::is_none);
	let [out, err] = got.map(|b| String::from_utf8_lossy(&b.unwrap_or_default()).into_owned());
	Ran { status: status.and_then(|s| s.code()), out, err: normalised(&err), held }
}

/// `script` through obash invoked as `bash` on a fresh pty, as the leader
/// of the pty's session, in its home directory: its merged output. Once
/// the shell has exited, the output is read until it holds Bash's answer
/// `want` or [`BOUND`] passes: [`pty_support::Pty::wait`] reads for at
/// most 500 ms after the exit, and under load on gVisor a whole row's
/// output once arrived later than that (3 of 10 runs beside 64 busy loops,
/// each an exit status 0 with no output read). A wrong answer still fails,
/// with all the output read by then.
fn run_on_a_terminal(want: &str) -> impl Fn(&str, Via) -> Ran + '_ {
	move |script, via| {
		let spawn = pty_support::Spawn::obash_as("bash");
		let home = spawn.home().to_owned();
		let spawn = match via {
			Via::Command => spawn.args(["-c", script]),
			Via::File => spawn.rc_file("row.sh", script).arg(home.join("row.sh")),
		};
		let mut pty = spawn.cwd(home).spawn().unwrap();
		let status = pty.wait(BOUND).ok().and_then(|s| s.code());
		if status.is_some() && !want.is_empty() && normalised(&pty.output()) != want {
			let _ = pty.read_until(want.lines().next_back().unwrap_or(want), BOUND);
		}
		Ran { status, out: normalised(&pty.output()), err: String::new(), held: false }
	}
}

/// Run `script` both ways (`-c` and from a file) with `run`, and fail with
/// every way whose answer is not Bash's: exit status `status`, stdout
/// `out`, nothing on stderr, and the output pipes closed.
fn check(name: &str, script: &str, status: i32, out: &str, run: impl Fn(&str, Via) -> Ran) {
	let mut wrong = Vec::new();
	for via in [Via::Command, Via::File] {
		let ran = run(script, via);
		if ran.status.is_none() {
			wrong.push(format!("{name} ({via:?}): HANG: no exit within {BOUND:?}; so far {ran:?}"));
		} else if (ran.status, ran.out.as_str(), ran.err.as_str(), ran.held)
			!= (Some(status), out, "", false)
		{
			wrong.push(format!(
				"{name} ({via:?}):\n  bash: Some({status}) {out:?} \"\" held=false\n  omp:  {ran:?}"
			));
		}
	}
	assert!(wrong.is_empty(), "`{script}`\n{}", wrong.join("\n"));
}

/// Each row's test twice: `without_a_terminal::NAME` and
/// `on_a_terminal::NAME` (Bash's stdout with `\r\n`); `=> out` for a row
/// whose shell exits 0, `=> (status, out)` otherwise.
macro_rules! rows {
	($($(#[$doc:meta])* $name:ident: $script:expr => $want:expr;)*) => {
		mod without_a_terminal {
			$($(#[$doc])* #[test] fn $name() {
				let (status, out) = super::Want::from($want).0;
				super::check(stringify!($name), $script, status, out, super::run_without_a_terminal);
			})*
		}
		mod on_a_terminal {
			$($(#[$doc])* #[test] fn $name() {
				let (status, out) = super::Want::from($want).0;
				let out = out.replace('\n', "\r\n");
				super::check(stringify!($name), $script, status, &out, super::run_on_a_terminal(&out));
			})*
		}
	};
}

/// A row's answer: the exit status and stdout.
struct Want(pub (i32, &'static str));

impl From<&'static str> for Want {
	fn from(out: &'static str) -> Self {
		Self((0, out))
	}
}

impl From<(i32, &'static str)> for Want {
	fn from(want: (i32, &'static str)) -> Self {
		Self(want)
	}
}

/// Waits (at most 500 tries) for `jobs -s` to name a job: `seen` or
/// `unseen`.
macro_rules! seen {
	() => {
		"n=0; while [ -z \"$(jobs -s)\" ] && [ $n -lt 500 ]; do n=$((n+1)); done; [ $n -lt 500 ] && \
		 echo seen || echo unseen"
	};
}

/// A pipeline whose first process writes its pid to `p` and stops, and
/// whose second waits (bounded) until that process is stopped, then ends.
macro_rules! pipeline {
	() => {
		"/bin/sh -c 'echo $$ > p; kill -STOP $$' | /bin/sh -c 'n=0; until [ -s p ] && read q < p && \
		 read -r _ _ s _ < /proc/$q/stat && [ \"$s\" = T ]; do n=$((n+1)); [ $n -lt 2000000 ] || \
		 exit 97; done'"
	};
}

/// `pipeline!` whose second process, once it sees the first stopped, runs
/// 1 s more (so the shell sees the stop while it still runs: a job with a
/// process running) and writes `d` just before it ends.
macro_rules! marked {
	() => {
		"/bin/sh -c 'echo $$ > p; kill -STOP $$' | /bin/sh -c 'n=0; until [ -s p ] && read q < p && \
		 read -r _ _ s _ < /proc/$q/stat && [ \"$s\" = T ]; do n=$((n+1)); [ $n -lt 2000000 ] || \
		 exit 97; done; /bin/sleep 1; : > d'"
	};
}

rows! {
	/// The stopped command is job 1, `$?` is 147 (128 + `SIGSTOP`), and
	/// `kill -CONT %1` lets `wait` see it end.
	a_stopped_command_is_a_job_and_the_shell_goes_on:
		"set -m; /bin/sh -c 'kill -STOP $$'; echo \"s=$?\"; jobs; kill -CONT %1; wait; echo \"w=$?\"; echo end"
		=> "s=147\n[1]+  Stopped                    /bin/sh -c 'kill -STOP $$'\nw=0\nend\n";
	/// `fg` continues the job and waits for it to end (its own line goes to
	/// `/dev/null`, the job writes to a file: the row does not depend on
	/// which of the two writes first).
	fg_brings_the_stopped_command_back:
		"set -m; /bin/sh -c 'kill -STOP $$; echo resumed > out'; echo \"s=$?\"; fg %1 > /dev/null; echo \"f=$?\"; cat out; jobs; echo end"
		=> "s=147\nf=0\nresumed\nend\n";
	/// `bg` prints the job as running in the background and continues it.
	bg_runs_the_stopped_command_on:
		"set -m; /bin/sh -c 'kill -STOP $$; echo resumed > out'; echo \"s=$?\"; bg %1; wait %1; echo \"w=$?\"; cat out; echo end"
		=> "s=147\n[1]+ /bin/sh -c 'kill -STOP $$; echo resumed > out' &\nw=0\nresumed\nend\n";
	/// A loop goes on with its next command and its next iteration: the job
	/// is only the command that stopped.
	a_loop_goes_on_after_a_stop:
		"set -m; for i in 1 2; do /bin/sh -c 'kill -STOP $$'; echo \"i=$i s=$?\"; done; jobs; kill -CONT %1 %2; wait; echo end"
		=> "i=1 s=147\ni=2 s=147\n[1]-  Stopped                    /bin/sh -c 'kill -STOP $$'\n[2]+  Stopped                    /bin/sh -c 'kill -STOP $$'\nend\n";
	/// So does a function, and its caller after it.
	a_function_goes_on_after_a_stop:
		"set -m; f() { /bin/sh -c 'kill -STOP $$'; echo \"in f s=$?\"; }; f; echo \"after f\"; jobs; kill -CONT %1; wait; echo end"
		=> "in f s=147\nafter f\n[1]+  Stopped                    /bin/sh -c 'kill -STOP $$'\nend\n";
	/// A pipeline whose processes both stop is one stopped job.
	a_pipeline_stops_as_one_job:
		"set -m; /bin/sh -c 'kill -STOP $$' | /bin/sh -c 'kill -STOP $$'; echo \"s=$?\"; jobs; kill -CONT %1; wait; echo end"
		=> "s=147\n[1]+  Stopped                    /bin/sh -c 'kill -STOP $$' | /bin/sh -c 'kill -STOP $$'\nend\n";
	/// A pipeline with one process stopped and one running is not stopped:
	/// the shell waits until the running one ends (`two` comes first).
	a_pipeline_stops_once_each_process_has:
		"set -m; /bin/sh -c 'echo $$; kill -STOP $$' | { read p; until grep -qE '^State:[[:space:]]+T' /proc/$p/status; do :; done; echo two; }; echo \"s=$?\"; jobs; kill -CONT %1; wait; echo end"
		=> "two\ns=147\n[1]+  Stopped                    /bin/sh -c 'echo $$; kill -STOP $$' | { read p; until grep -qE '^State:[[:space:]]+T' /proc/$p/status; do\n    :;\ndone; echo two; }\nend\n";
	/// A `( … )` whose program stopped is the stopped job.
	a_stopped_subshell_is_a_job:
		"set -m; ( /bin/sh -c 'kill -STOP $$' ); echo \"s=$?\"; jobs; kill -CONT %1; wait; echo end"
		=> "s=147\n[1]+  Stopped                    ( /bin/sh -c 'kill -STOP $$' )\nend\n";
	/// A `SIGTSTP` stop breaks the loop: the rest of its body and its other
	/// iterations do not run.
	a_tstp_stop_breaks_the_loop:
		"set -m; for i in 1 2; do /bin/sh -c 'kill -TSTP $$'; echo \"i=$i s=$?\"; done; echo after; jobs; kill -CONT %1; wait; echo end"
		=> "after\n[1]+  Stopped                    /bin/sh -c 'kill -TSTP $$'\nend\n";
	/// A stop is a failure: `set -e` exits with its status.
	a_stop_ends_a_set_e_script:
		"set -e; set -m; /bin/sh -c 'kill -STOP $$'; echo \"after $?\""
		=> (147, "");
	/// The `ERR` trap runs for a stop.
	a_stop_runs_the_err_trap:
		"set -m; trap 'echo \"err $?\"' ERR; /bin/sh -c 'kill -STOP $$'; echo after; kill -CONT %1; wait; echo end"
		=> "err 147\nafter\nend\n";
	/// Each job leads a process group of its own.
	a_job_leads_its_own_group:
		"set -m; /bin/sh -c 'read a b c d e r < /proc/$$/stat; read A B C D E R < /proc/$PPID/stat; [ \"$e\" = \"$E\" ] && echo same || echo own'"
		=> "own\n";
	/// A program the shell `exec`s is the shell: its stop is no job, and the
	/// shell is stopped with it until the row's background job continues it
	/// (the program writes its pid to `p`), then ends with it. The continue
	/// comes 1 s after the stop, so a shell that would take the stop has the
	/// time to; at once, a build that makes a job of it passed 2 of 3 runs.
	an_execd_program_that_stops_is_no_job:
		"set -m; { until [ -s p ]; do :; done; read q < p; until read -r _ _ s _ < /proc/$q/stat && \
		 [ \"$s\" = T ]; do :; done; /bin/sleep 1; kill -CONT $q; } & exec /bin/sh -c 'echo $$ > p; \
		 kill -STOP $$; echo resumed'"
		=> "resumed\n";
	/// A background job stops only once none of its processes runs (bash
	/// `set_job_status_and_cleanup`): with one process stopped and `cat`
	/// still running, `jobs -s` never names it and `jobs` says Running.
	a_job_with_a_process_running_is_not_stopped:
		concat!("set -m; /bin/sh -c 'kill -STOP $$' | cat & ", seen!(), "; jobs; kill -KILL %1; echo end")
		=> "unseen\n[1]+  Running                    /bin/sh -c 'kill -STOP $$' | cat &\nend\n";
	/// It stops once the process that ran ends (`marked!`): the shell waits
	/// for `d`, then for `jobs -s` to name the job. The row claims only that
	/// the job stops, so its only bound is the runner's (`BOUND`). A count of
	/// tries would race the shell's speed: obash's `$(jobs -s)` forks
	/// nothing, and 500 of them ended before the other process did under
	/// gVisor at whole-set load.
	a_job_stops_once_its_running_process_ends:
		concat!(
			"set -m; ",
			marked!(),
			" & until [ -e d ]; do :; done; until [ \"$(jobs -s)\" ]; do :; done; jobs; kill -CONT \
			 %1; wait; echo \"w=$?\"; echo end"
		)
		=> concat!("[1]+  Stopped                    ", marked!(), "\nw=0\nend\n");
	/// `wait %1` waits on while a process of the job runs, and returns 147
	/// once the job is stopped.
	wait_returns_once_the_job_has_stopped:
		concat!("set -m; ", pipeline!(), " & wait %1; echo \"w=$?\"; jobs; kill -CONT %1; wait; echo end")
		=> concat!("w=147\n[1]+  Stopped                    ", pipeline!(), "\nend\n");
}

/// A job gets the terminal its shell's standard error is on: `stty` works
/// in it on a pty, and fails with no terminal. Under gVisor `stty` works in
/// a job the terminal is not lent to as well (a build that never lends it
/// passed this test there 3 of 3 times), so only a Linux kernel shows the
/// loan here.
#[test]
fn a_job_gets_the_terminal() {
	let script = "set -m; /bin/sh -c 'stty echo 2>/dev/null; echo \"st=$?\"'; echo \"s=$?\"; jobs; \
	              kill -CONT %1 2>/dev/null; wait; echo end";
	let tty = "st=0\r\ns=0\r\nend\r\n";
	check("a_job_gets_the_terminal", script, 0, tty, run_on_a_terminal(tty));
	check("a_job_gets_the_terminal", script, 0, "st=1\ns=0\nend\n", run_without_a_terminal);
}

/// With the terminal lent, `kill %1` of a stopped job reaches its whole
/// process group, as bash's `killpg` does: a program the job left in its
/// group (a `/bin/sleep 30` started by its `/bin/sh`, its pid in `left`)
/// dies of the `TERM` too, once the job is stopped and runs only shell code
/// (`loop` made by the job after the `/bin/sh`). This is the `left-gone`
/// row of `process_signals.rs`'s
/// `set_m_kill_of_a_jobs_group_reaches_its_shell_code` on a pty, with bash
/// 5.3.20's answer there; a build that signals only the job's own processes
/// leaves the program alive (`left-alive`). The 5 s the row gives the program
/// to die is the one wait it bounds itself.
#[test]
fn kill_of_a_stopped_job_reaches_a_program_left_in_its_group() {
	let script = "set -m; { /bin/sh -c '/bin/sleep 30 >/dev/null 2>&1 & echo $! > left'; : > loop; \
	              while :; do :; done; } & until [ -e loop ]; do :; done; read l < left; kill \
	              -STOP %1; until jobs >j; read -r j <j; [ \"${j#*Stopped}\" != \"$j\" ]; do \
	              /bin/sleep 0.05; done; kill -TERM %1; echo kill=$?; until ! { read -r _ _ s _ < \
	              /proc/$!/stat; } 2>/dev/null || [ \"$s\" = Z ]; do :; done; wait $!; echo st=$?; \
	              i=0; while kill -0 $l 2>/dev/null && [ $i -lt 100 ]; do i=$((i+1)); /bin/sleep \
	              0.05; done; kill -0 $l 2>/dev/null && echo left-alive || echo left-gone; kill \
	              -KILL $l 2>/dev/null; :";
	let tty = "kill=0\r\nst=143\r\nleft-gone\r\n";
	check(
		"kill_of_a_stopped_job_reaches_a_program_left_in_its_group",
		script,
		0,
		tty,
		run_on_a_terminal(tty),
	);
}

/// `set -m` holds across a restore: under obash's exec fault mode (every 3
/// ops the shell is snapshotted and restored in a new process) the loop's
/// ops after `set -m` restore it several times, and the stop that comes
/// after is still taken. Bash's answer is the one of the same script
/// without faults (its loop prints nothing).
#[test]
fn a_restored_shell_keeps_set_m() {
	let script = "set -m; i=0; while [ $i -lt 20 ]; do i=$((i + 1)); done; /bin/sh -c 'kill -STOP \
	              $$'; echo \"s=$?\"; jobs; kill -CONT %1; wait; echo end";
	let out = "s=147\n[1]+  Stopped                    /bin/sh -c 'kill -STOP $$'\nend\n";
	check("a_restored_shell_keeps_set_m", script, 0, out, |script, via| {
		run_obash(None, &["--fault=1:3", "--fault-mode=exec"], script, via)
	});
}

/// A restore starts bash's `set -m` job control in a bash script only:
/// zsh's `MONITOR` is the same option, and a restored zsh shell comes back
/// without job control (the `JobCtl` state is not imaged), as the docs of
/// `JobCtl` and `set_monitor` say. obash as `zsh` on a pty, after `setopt
/// monitor`, runs a program in a process group of its own (`own`: zsh's
/// job control, the control that the row can see a group of its own);
/// with a restore every 3 ops before the program it runs the program in
/// the shell's group (`same`). A restore that started bash's job control
/// there gave the program a group of its own again, and took bash's stop
/// path in a zsh shell. The answers are obash's own, not zsh 5.9's.
#[test]
fn a_restored_zsh_shell_has_no_bash_job_control() {
	let script = "setopt monitor; i=0; while (( i < 20 )); do (( i++ )); done; /bin/sh -c 'read a \
	              b c d e r < /proc/$$/stat; read A B C D E R < /proc/$PPID/stat; [ \"$e\" = \
	              \"$E\" ] && echo same || echo own'";
	let run = |opts: &[&str], via: Via, want: &str| {
		let spawn = pty_support::Spawn::obash_as("zsh").args(opts.iter().copied());
		let home = spawn.home().to_owned();
		let spawn = match via {
			Via::Command => spawn.args(["-c", script]),
			Via::File => spawn.rc_file("row.sh", script).arg(home.join("row.sh")),
		};
		let mut pty = spawn.cwd(home).spawn().unwrap();
		let status = pty.wait(BOUND).ok().and_then(|s| s.code());
		if status.is_some() && normalised(&pty.output()) != want {
			let _ = pty.read_until(want.trim_end(), BOUND);
		}
		(status, normalised(&pty.output()))
	};
	let rows: [(&[&str], &str); 2] =
		[(&[], "own\r\n"), (&["--fault=1:3", "--fault-mode=exec"], "same\r\n")];
	let mut wrong = Vec::new();
	for via in [Via::Command, Via::File] {
		for (opts, want) in rows {
			let got = run(opts, via, want);
			if got != (Some(0), want.to_owned()) {
				wrong.push(format!("{via:?} {opts:?}:\n  want: Some(0) {want:?}\n  omp:  {got:?}"));
			}
		}
	}
	assert!(wrong.is_empty(), "`{script}`\n{}", wrong.join("\n"));
}
