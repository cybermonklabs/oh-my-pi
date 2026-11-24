//! An error's message goes where bash writes it: at once, to the stderr the
//! redirections in force set. `: 2>/dev/null 3>"${zz?u}"` and
//! `{ x=${y:?u}; } 2>/dev/null` print nothing (`bash -c` exits 127); with
//! `2>&1` the message is on stdout, with `2>file` in the file. obash wrote a
//! fatal error's message after the shell had undone the redirections, on the
//! stderr before them.
//!
//! The rows ([`ROWS`]) are bash's own output: each script as `bash -c` and
//! as `bash ./s.sh`, run by bash 5.3.20 and 5.2.21 (alike on every row) in a
//! fresh directory holding `in` ("hello") and a FIFO `fifo`, the directory
//! written `DIR`. Each script's EXIT trap prints `exit` and the file `err`,
//! so a message sent to `2>err` is seen. They cover a builtin, `echo`, a
//! function, a `{ }`, a loop, a null command and `exec`, each after
//! `2>/dev/null`, `2>&1` and `2>err`, with a fatal expansion error (and, as
//! controls, an open that fails, a bad fd, an ambiguous word), errors in a
//! body under its compound's redirection, and messages whose stream is a pipe
//! already full (the reader waits two seconds before it reads).
#![cfg(unix)]

mod obash_support;

use std::{fs, os::unix::process::CommandExt as _, path::Path};

use obash_support::{obash, output};
use pi_shell::{
	bash::{Budget, EngineConfig, Script, SigTarget, Signal, Vpid},
	testkit::{
		FakeHost, Fault, Rig,
		fault::skeleton_init,
		run::{Stop, advance_or_blocked, wait_runnable},
	},
};
use serde_json::Value;

/// The rows, as bash 5.3.20 and 5.2.21 ran them: `{id, file, script,
/// bash53: [status, stdout, stderr], bash52: [...]}`.
const ROWS: &str = include_str!("fixtures/fatal_error_message/rows.json");

/// One row of [`ROWS`]: id, run from a script file (else `-c`), script, and
/// bash 5.3.20's (status, stdout, stderr); `same52`: bash 5.2.21 ran it
/// alike.
struct Row {
	id:     String,
	file:   bool,
	script: String,
	want:   (i32, String, String),
	same52: bool,
}

fn rows() -> Vec<Row> {
	let all: Vec<Value> = serde_json::from_str(ROWS).unwrap();
	all.iter()
		.map(|r| {
			let got = |which: &str| {
				let v = &r[which];
				(
					i32::try_from(v[0].as_i64().unwrap()).unwrap(),
					v[1].as_str().unwrap().to_owned(),
					v[2].as_str().unwrap().to_owned(),
				)
			};
			let want = got("bash53");
			Row {
				id: r["id"].as_str().unwrap().to_owned(),
				file: r["file"].as_bool().unwrap(),
				script: r["script"].as_str().unwrap().to_owned(),
				same52: got("bash52") == want,
				want,
			}
		})
		.collect()
}

/// The directory a row runs in: `in` and the FIFO `fifo`.
fn files(dir: &Path) {
	fs::write(dir.join("in"), "hello\n").unwrap();
	let fifo =
		std::ffi::CString::new(dir.join("fifo").into_os_string().into_encoded_bytes()).unwrap();
	// SAFETY: `fifo` is a NUL-terminated path that outlives the call.
	assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0, "mkfifo");
}

/// How `row` differs from bash, if it does.
fn differs(row: &Row) -> Option<String> {
	let dir = tempfile::tempdir().unwrap();
	files(dir.path());
	let mut cmd = obash();
	cmd.arg0("bash").current_dir(dir.path());
	if row.file {
		fs::write(dir.path().join("s.sh"), format!("{}\n", row.script)).unwrap();
		cmd.arg("./s.sh");
	} else {
		cmd.arg("-c").arg(&row.script);
	}
	let how = if row.file { "./s.sh" } else { "-c" };
	let (id, script, want) = (&row.id, &row.script, &row.want);
	// `output` panics on a process past the obash tests' bound: the row hung,
	// and is reported with the others.
	let Ok(got) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| output(&mut cmd))) else {
		return Some(format!("{id} ({how}): `{script}`: no end within the bound"));
	};
	let real = dir.path().canonicalize().unwrap();
	let clean = |b: &[u8]| {
		String::from_utf8_lossy(b)
			.replace(&*real.to_string_lossy(), "DIR")
			.replace(&*dir.path().to_string_lossy(), "DIR")
	};
	let got = (got.status.code().unwrap_or(-1), clean(&got.stdout), clean(&got.stderr));
	if got == *want {
		return None;
	}
	Some(format!("{id} ({how}): `{script}`\n  bash: {want:?}\n  got:  {got:?}"))
}

/// Runs `rows` a few at once (each in its own directory) and asserts each
/// is bash's, reporting every row that is not.
fn check(rows: &[Row]) {
	let threads = std::thread::available_parallelism().map_or(1, |n| n.get().min(8));
	let failures = std::thread::scope(|scope| {
		let mut workers = Vec::with_capacity(threads);
		for chunk in rows.chunks(rows.len().div_ceil(threads).max(1)) {
			workers.push(scope.spawn(move || chunk.iter().filter_map(differs).collect::<Vec<_>>()));
		}
		let mut failures = Vec::new();
		for worker in workers {
			failures.extend(worker.join().unwrap());
		}
		failures
	});
	assert!(
		failures.is_empty(),
		"{} of {} rows differ from bash:\n{}",
		failures.len(),
		rows.len(),
		failures.join("\n")
	);
}

/// Each row as bash 5.3.20 runs it (5.2.21 runs every one alike).
#[test]
fn an_errors_message_goes_to_the_stderr_the_redirections_set() {
	let rows = rows();
	assert!(rows.iter().all(|r| r.same52), "a row bash 5.2.21 runs otherwise");
	assert!(rows.len() > 150, "{} rows", rows.len());
	check(&rows);
}

/// A reader that waits 400 polls of the native task `wait400` (time for
/// the writer to fill the 64 KiB pipe), then prints each line without its
/// zeros.
const READER: &str = "{ wait400; while IFS= read -r l; do printf '%s\\n' \"${l//0/}\"; done; }";

/// A host with the native tasks the tests below hold on: `wait400` (400
/// polls), `delay` (4 polls) and `hold` (never ends by itself).
fn host() -> FakeHost {
	let mut host = FakeHost::new();
	host.countdown("wait400", 400, 0);
	host.countdown("delay", 4, 0);
	host.countdown("hold", u32::MAX, 0);
	host
}

fn text(b: &[u8]) -> String {
	String::from_utf8_lossy(b).into_owned()
}

/// Run `src` as a `-c` script; with `image`, imaged and restored at every
/// other stop of the shell (a small budget makes them often: while the
/// jump is held, a native task polls, so the shell yields there rather than
/// blocks), not only between ops. Its status, stdout and stderr.
fn run(src: &str, image: bool) -> (i32, String, String) {
	let mut rig = Rig::new(host(), skeleton_init(&[]));
	let id = rig.shell().submit(Script::command(src.as_bytes().to_vec()));
	let budget = Budget { max_ops: 64, max_ns: u64::MAX };
	let mut fresh = true;
	let status = loop {
		let (shell, host, store) = rig.parts();
		match advance_or_blocked(shell, host, store, id, budget) {
			Stop::Done(status) => break status,
			Stop::Yield | Stop::Blocked if image && fresh => {
				rig.snapshot();
				fresh = false;
			},
			Stop::Blocked => {
				let (shell, host, _) = rig.parts();
				if !host.fire_next_timer() {
					wait_runnable(&shell.control());
				}
				fresh = true;
			},
			Stop::Paused => rig.shell().control().resume(),
			Stop::Yield => fresh = true,
		}
	};
	assert!(!image || rig.snapshots > 0, "`{src}`: no image was taken");
	(status, text(&rig.host.stdout.bytes()), text(&rig.host.stderr.bytes()))
}

/// A message whose stream is a full pipe is written once the reader drains
/// it, still before the jump undoes the redirection that chose the pipe,
/// and exactly once, also when the shell is imaged and restored while the
/// jump is held: the reader gets the message, and stderr nothing.
#[test]
fn a_message_waits_for_a_full_pipe_before_the_jump() {
	let src = format!(
		"{{ printf '%065536d' 0; : 2>&1 3>\"${{zz?u}}\"; echo never; }} | {READER}; echo \
		 \"ps=${{PIPESTATUS[*]}}\""
	);
	for image in [false, true] {
		let (status, out, err) = run(&src, image);
		let lines: Vec<&str> = out.lines().collect();
		assert!(
			lines.len() == 2 && lines[0].ends_with("zz: u") && lines[1] == "ps=1 0" && err.is_empty(),
			"imaged {image}: status {status} stdout {out:?} stderr {err:?}"
		);
	}
}

/// A held jump that discards the rest of the line (an arithmetic error at
/// the top level) discards it once its message is out, and the next line
/// runs (`exec 4>&2` keeps the shell's stderr for it).
#[test]
fn a_held_discard_goes_on_with_the_next_line() {
	let src = "exec 4>&2; { printf '%065536d' 0; : 2>&1 3>/dev/null$((1/0)); echo same; } > \
	           >(wait400; while IFS= read -r l; do :; done)\necho \"next s=$?\" >&4";
	for image in [false, true] {
		let (status, out, err) = run(src, image);
		assert!(
			!out.contains("same") && err.lines().last().is_some_and(|l| l.starts_with("next s=")),
			"imaged {image}: status {status} stdout {out:?} stderr {err:?}"
		);
	}
}

/// A trap that runs while a jump is held runs in a frame of its own: it
/// does not take the jump, which is made once the trap returns (obash
/// writes the whole message first, where bash loses it to the signal's
/// interruption of its write). Nor does the trap's op drop the hold: the
/// held op does not run again, so its message is written once.
#[test]
fn a_trap_while_a_jump_is_held_runs_and_the_jump_follows() {
	let src = format!(
		"{{ trap 'echo T-usr1' USR1; printf '%065536d' 0; p=$BASHPID; ( delay; kill -USR1 $p ) & : \
		 2>&1 3>\"${{zz?u}}\"; echo never; }} | {READER}; echo \"ps=${{PIPESTATUS[*]}}\""
	);
	let (status, out, err) = run(&src, false);
	let messages = out.matches("zz: u").count();
	assert!(
		messages == 1
			&& out.contains("T-usr1\n")
			&& !out.contains("never")
			&& out.ends_with("ps=1 0\n"),
		"messages {messages} status {status} stdout {out:?} stderr {err:?}"
	);
}

/// A trap that returns from the function whose op holds a jump takes the
/// hold with the function's frame, at the first op of the frame below: the
/// function called next at that frame's index runs, and so does the same
/// function, called again, at the held op's own frame index and op (`&&`
/// shows its status 0, which [`READER`] would print without its `0`).
#[test]
fn a_trap_that_returns_drops_the_held_jump() {
	let src = format!(
		"{{ f() {{ trap 'return 7' USR1; p=$BASHPID; [ -n \"$1\" ] || {{ ( delay; kill -USR1 $p ) & \
		 }}; : 2>&1 3>&\"${{1:?u}}\"; echo \"in-f $1\"; }}; g() {{ echo in-g; }}; printf '%065536d' \
		 0; f; echo \"after-f s=$?\"; g; echo after-g; f 1 && echo after-f2; }} | {READER}; echo \
		 \"ps=${{PIPESTATUS[*]}}\""
	);
	let (status, out, err) = run(&src, false);
	assert!(
		out.contains("after-f s=7\nin-g\nafter-g\nin-f 1\nafter-f2\n") && out.ends_with("ps=0 0\n"),
		"held jump taken after the trap's return: status {status} stdout {out:?} stderr {err:?}"
	);
}

/// A trap that exits while a jump is held: the frames go, the held jump
/// with them, and the EXIT trap runs whole with the trap's status.
#[test]
fn a_trap_that_exits_runs_the_exit_trap_whole() {
	let src = format!(
		"{{ trap 'echo X-exit; echo X-end' EXIT; trap 'exit 5' USR1; printf '%065536d' 0; \
		 p=$BASHPID; ( delay; kill -USR1 $p ) & : 2>&1 3>\"${{zz?u}}\"; echo never; }} | {READER}; \
		 echo \"ps=${{PIPESTATUS[*]}}\""
	);
	let (status, out, err) = run(&src, false);
	assert!(
		out.contains("X-exit\nX-end\n") && out.ends_with("ps=5 0\n"),
		"status {status} stdout {out:?} stderr {err:?}"
	);
}

/// `src` run alone, with one USR1 sent to the root vproc at stop `at` (if
/// the run lasts that long): its status and stdout.
fn usr1_at(src: &str, at: u32) -> (i32, String) {
	let root = Vpid(EngineConfig::default().vpid_base);
	let mut rig = Rig::new(host(), skeleton_init(&[]));
	let id = rig.shell().submit(Script::command(src.as_bytes().to_vec()));
	let budget = Budget { max_ops: 64, max_ns: u64::MAX };
	let mut steps = 0u32;
	let status = loop {
		let (shell, host, store) = rig.parts();
		match advance_or_blocked(shell, host, store, id, budget) {
			Stop::Done(status) => break status,
			Stop::Blocked => {
				let (shell, host, _) = rig.parts();
				if !host.fire_next_timer() {
					wait_runnable(&shell.control());
				}
			},
			Stop::Paused => rig.shell().control().resume(),
			Stop::Yield => {},
		}
		steps += 1;
		if steps == at {
			rig.shell()
				.control()
				.signal(SigTarget::Vpid(root), Signal::Usr1);
		}
		assert!(steps < 1_000_000, "`{src}`: never ended");
	};
	(status, text(&rig.host.stdout.bytes()))
}

/// A trap that exits while the op at the start of a line holds its jump
/// (frame 0, pc 0): the frames go, the held jump with them, so the EXIT
/// trap, which runs from the start of frame 0, runs whole. USR1 comes at
/// each stop from 3 to 120 (the first ones while the jump is held).
#[test]
fn a_trap_that_exits_while_a_line_start_op_holds_runs_the_exit_trap_whole() {
	let src = format!(
		"trap 'echo X-exit; echo X-end' EXIT; trap 'exit 5' USR1\nexec 2> >({READER})\nprintf \
		 '%065536d' 0 >&2\nx=${{y:?u}}\necho never"
	);
	let mut bad = Vec::new();
	let mut fives = 0usize;
	for at in 3..=120 {
		let (status, out) = usr1_at(&src, at);
		fives += usize::from(status == 5);
		if !out.contains("X-exit\n") || !out.contains("X-end\n") || out.contains("never") {
			bad.push(format!("at {at}: status {status} stdout {out:?}"));
		}
	}
	assert!(
		bad.is_empty() && fives > 0,
		"{fives} runs with status 5; {} bad, the first:\n{}",
		bad.len(),
		bad.iter().take(4).cloned().collect::<Vec<_>>().join("\n")
	);
}

/// A run cancelled while its jump is held leaves nothing behind on the
/// shell, which lives on for the next run: `echo second` runs whole after
/// each signal, for each way to fill a stream and fail (and a control whose
/// message fits).
#[test]
fn a_cancelled_runs_held_jump_is_not_taken_by_the_next_run() {
	const FIRSTS: &[(&str, &str)] = &[
		("group-assign", "{ printf '%065536d' 0; { x=${y:?u}; } 2>&1; echo never; } > >(hold)"),
		("redir-word", "{ printf '%065536d' 0; : 2>&1 3>\"${zz?u}\"; echo never; } > >(hold)"),
		("arith-command", "{ printf '%065536d' 0; (( 1/0 )) 2>&1; echo never; } > >(hold)"),
		("arith-assign", "{ printf '%065536d' 0; x=$((1/0)); echo never; } > >(hold) 2>&1"),
		("exec-stderr", "exec 2> >(hold); printf '%065536d' 0 >&2; x=${y:?u}; echo never"),
		("control-no-fill", "{ { x=${y:?u}; } 2>&1; echo never; } > >(hold)"),
	];
	let mut bad = Vec::new();
	for sig in [Signal::Kill, Signal::Term, Signal::Int] {
		for (name, first) in FIRSTS {
			let mut rig = Rig::new(host(), skeleton_init(&[]));
			let id = rig
				.shell()
				.submit(Script::command(first.as_bytes().to_vec()));
			let budget = Budget { max_ops: 64, max_ns: u64::MAX };
			let mut steps = 0u32;
			loop {
				let (shell, host, store) = rig.parts();
				match advance_or_blocked(shell, host, store, id, budget) {
					Stop::Done(_) => break,
					Stop::Paused => shell.control().resume(),
					Stop::Yield | Stop::Blocked => {},
				}
				steps += 1;
				if steps == 200 {
					rig.shell().control().cancel(sig);
				}
				assert!(steps < 1_000_000, "{name} {sig:?}: run 1 never ended");
			}
			let status = rig.run(Script::command(b"echo second; echo \"s=$?\"".to_vec()), Fault::None);
			let out = text(&rig.host.stdout.bytes());
			if status != 0 || !out.ends_with("second\ns=0\n") {
				bad.push(format!("{name} {sig:?}: run 2 status {status} stdout {out:?}"));
			}
		}
	}
	assert!(bad.is_empty(), "run 2 did not run whole after:\n{}", bad.join("\n"));
}

/// Run 1 of the cancel tests below, its jump held on a reader that never
/// reads: by the op at the start of its line (frame 0, pc 0, where the next
/// run and the EXIT trap start) or by one later on it, with and without an
/// EXIT trap.
const HELD_FIRSTS: &[(&str, &str)] = &[
	("line-start", "exec 2> >(hold)\nprintf '%065536d' 0 >&2\nx=${y:?u}\necho never"),
	(
		"line-start-exit-trap",
		"trap 'echo X-exit; echo X-end' EXIT\nexec 2> >(hold)\nprintf '%065536d' 0 \
		 >&2\nx=${y:?u}\necho never",
	),
	("mid-line", "exec 2> >(hold)\nprintf '%065536d' 0 >&2; x=${y:?u}\necho never"),
	(
		"mid-line-exit-trap",
		"trap 'echo X-exit; echo X-end' EXIT\nexec 2> >(hold)\nprintf '%065536d' 0 >&2; \
		 x=${y:?u}\necho never",
	),
];

/// `first` on a fresh shell, cancelled with `sig` at its 2000th stop, then
/// `echo second; echo "s=$?"` on the same shell: run 1's status and
/// stdout, run 2's.
fn cancel_then_run(first: &str, sig: Signal) -> (i32, String, i32, String) {
	let mut rig = Rig::new(host(), skeleton_init(&[]));
	let id = rig
		.shell()
		.submit(Script::command(first.as_bytes().to_vec()));
	let budget = Budget { max_ops: 64, max_ns: u64::MAX };
	let mut steps = 0u32;
	let status1 = loop {
		let (shell, host, store) = rig.parts();
		match advance_or_blocked(shell, host, store, id, budget) {
			Stop::Done(status) => break status,
			Stop::Paused => shell.control().resume(),
			Stop::Yield | Stop::Blocked => {},
		}
		steps += 1;
		if steps == 2000 {
			rig.shell().control().cancel(sig);
		}
		assert!(steps < 1_000_000, "{first:?} {sig:?}: run 1 never ended");
	};
	let n1 = rig.host.stdout.bytes().len();
	let out1 = text(&rig.host.stdout.bytes()[..n1]);
	let status2 = rig.run(Script::command(b"echo second; echo \"s=$?\"".to_vec()), Fault::None);
	let out2 = text(&rig.host.stdout.bytes()[n1..]);
	(status1, out1, status2, out2)
}

/// Each run of [`HELD_FIRSTS`] cancelled with `sig`: the cancel drops the
/// held jump with the frames, so the EXIT trap (TERM and INT run it, KILL
/// does not) and the next run, both from the start of frame 0, run whole.
fn a_cancel_drops_the_held_jump(sig: Signal) {
	let mut bad = Vec::new();
	for (name, first) in HELD_FIRSTS {
		let want1 = if first.starts_with("trap") && sig != Signal::Kill {
			"X-exit\nX-end\n"
		} else {
			""
		};
		let (status1, out1, status2, out2) = cancel_then_run(first, sig);
		if out1 != want1
			|| status2 != 0
			|| !out2.starts_with("second\ns=0\n")
			|| out2.contains("never")
		{
			bad.push(format!(
				"{name}: run 1 status {status1} stdout {out1:?}; run 2 status {status2} stdout \
				 {out2:?}"
			));
		}
	}
	assert!(bad.is_empty(), "{sig:?} cancel, a held jump left behind:\n{}", bad.join("\n"));
}

/// A KILL cancel unwinds the run without its EXIT trap: the next run's
/// first op does not take the held jump.
#[test]
fn a_kill_cancel_drops_the_held_jump() {
	a_cancel_drops_the_held_jump(Signal::Kill);
}

/// A TERM cancel: the EXIT trap and the next run do not take the held jump.
#[test]
fn a_term_cancel_drops_the_held_jump() {
	a_cancel_drops_the_held_jump(Signal::Term);
}

/// An INT cancel: the EXIT trap and the next run do not take the held jump.
#[test]
fn an_int_cancel_drops_the_held_jump() {
	a_cancel_drops_the_held_jump(Signal::Int);
}
