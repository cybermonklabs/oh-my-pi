//! A write of the shell's own to a pipe whose readers are gone ends the
//! shell as bash's `SIGPIPE` does, on whichever fd it writes: a `set -x`
//! trace line on standard error or on `BASH_XTRACEFD`, a builtin's own
//! diagnostic, the shell's diagnostics (a failed redirection, an expansion
//! error, `time`'s report, `select`'s menu), and a write error's report. A
//! message bash writes in the child it forked for a command (a name not
//! found, a program the OS refused, the redirection of a program, of a null
//! command it forks for or of a `( … )`) ends only that child: the command
//! fails with 141 and the shell goes on. `trap '' PIPE` keeps the shell
//! going, a `PIPE` trap runs after the command, and a failed write to
//! standard error is no error of the command.
//!
//! Each row runs a pipeline stage whose standard error is a pipe whose
//! reader (`:`) has gone after `sleep 0.3`, and prints the stage's status,
//! whether it reached its end and, where it goes on, the command's own
//! status; the controls write to a file, `/dev/full`, a closed fd and a
//! pipe with a reader.
//!
//! The rows ([`fixture`]) are bash's own output: each script as `bash -c`
//! and as `bash ./s.sh`, run by bash 5.3.20 and 5.2.21 in a fresh directory
//! holding `in` ("hello") and a FIFO `fifo`, the directory written `DIR`;
//! both run every row alike. Left out: a `PIPE` trap under `set -x` with
//! the trace on the broken pipe (the trap's own trace raises the signal
//! again, and bash recurses until it dies of `SIGSEGV`), and a foreground
//! child killed by a signal, whose notice obash does not write.
#![cfg(unix)]

mod obash_support;

use std::{
	fs,
	os::unix::process::CommandExt as _,
	path::{Path, PathBuf},
};

use obash_support::{obash, output};
use serde_json::Value;

/// A fixture file: `rows.json`, the rows as bash 5.3.20 and 5.2.21 ran them
/// (`{id, file, script, bash53: [status, stdout, stderr], bash52: [...]}`),
/// or `zsh.json`, zsh's rows as zsh 5.9 ran them (`zsh59`). Cargo runs the
/// test in the crate directory; Bazel, at the runfiles root (the fixture
/// rides along as `data`).
fn fixture(name: &str) -> PathBuf {
	let manifest =
		PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stderr_broken_pipe_as_bash");
	let root = if manifest.is_dir() {
		manifest
	} else {
		PathBuf::from("crates/pi-shell/tests/fixtures/stderr_broken_pipe_as_bash")
	};
	root.join(name)
}

/// One row of a fixture: id, run from a script file (else `-c`), script,
/// the argv0 obash runs it under (its dialect), and the oracle's (status,
/// stdout, stderr); `agreed`: the second oracle (bash 5.2.21) ran it alike,
/// or there is none.
struct Row {
	id:     String,
	file:   bool,
	script: String,
	argv0:  &'static str,
	want:   (i32, String, String),
	agreed: bool,
}

/// The rows of fixture `name`, checked against oracle `want` (and `second`,
/// when given), run by obash as `argv0`.
fn rows(name: &str, argv0: &'static str, want: &str, second: Option<&str>) -> Vec<Row> {
	let all: Vec<Value> = serde_json::from_str(&fs::read_to_string(fixture(name)).unwrap()).unwrap();
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
			let want = got(want);
			Row {
				id: r["id"].as_str().unwrap().to_owned(),
				file: r["file"].as_bool().unwrap(),
				script: r["script"].as_str().unwrap().to_owned(),
				argv0,
				agreed: second.is_none_or(|s| got(s) == want),
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

/// How `row` differs from its oracle, if it does.
fn differs(row: &Row) -> Option<String> {
	let dir = tempfile::tempdir().unwrap();
	files(dir.path());
	let mut cmd = obash();
	cmd.arg0(row.argv0).current_dir(dir.path());
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
	Some(format!("{id} ({how}): `{script}`\n  {}: {want:?}\n  got:  {got:?}", row.argv0))
}

/// Runs `rows` a few at once (each in its own directory) and asserts each
/// is its oracle's, reporting every row that is not.
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
		"{} of {} rows differ from the oracle:\n{}",
		failures.len(),
		rows.len(),
		failures.join("\n")
	);
}

/// The rows bash 5.2.21 and 5.3.20 run alike.
#[test]
fn a_write_to_a_pipe_without_readers_ends_the_shell_as_bash_does() {
	let rows: Vec<Row> = rows("rows.json", "bash", "bash53", Some("bash52"))
		.into_iter()
		.filter(|r| r.agreed)
		.collect();
	assert!(rows.len() >= 120, "{} rows", rows.len());
	check(&rows);
}

/// zsh's rows as zsh 5.9 runs them: obash as `zsh`.
#[test]
fn a_write_to_a_pipe_without_readers_ends_the_shell_as_zsh_does() {
	let rows = rows("zsh.json", "zsh", "zsh59", None);
	assert!(rows.len() >= 30, "{} rows", rows.len());
	check(&rows);
}
