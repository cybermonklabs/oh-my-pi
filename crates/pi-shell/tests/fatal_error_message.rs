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
use pi_shell::testkit::{FakeHost, Fault, run_script};
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

/// A message whose stream is a full pipe is written once the reader drains
/// it, still before the jump undoes the redirection that chose the pipe,
/// also when the shell is imaged and restored at every op while the jump
/// waits: the reader (held by a native task until the writer has filled
/// the pipe) gets the message, and stderr nothing.
#[test]
fn a_message_waits_for_a_full_pipe_before_the_jump() {
	const SRC: &str = concat!(
		"{ printf '%065536d' 0; : 2>&1 3>\"${zz?u}\"; } | ",
		"{ hold; while IFS= read -r l; do printf '%s\\n' \"${l//0/}\"; done; }; ",
		"echo \"ps=${PIPESTATUS[*]}\"",
	);
	let host = || {
		let mut host = FakeHost::new();
		host.countdown("hold", 20, 0);
		host
	};
	for (what, fault) in [("plain", Fault::None), ("imaged", Fault::Snapshot { every: 1 })] {
		let got = run_script(host(), SRC.as_bytes(), &[], fault);
		let (out, err) = (String::from_utf8_lossy(&got.stdout), String::from_utf8_lossy(&got.stderr));
		assert!(
			out.contains("zz: u\n") && out.ends_with("ps=1 0\n") && err.is_empty(),
			"{what}: status {} stdout {out:?} stderr {err:?}",
			got.status
		);
	}
}
