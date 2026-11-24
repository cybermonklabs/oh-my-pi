//! `set -x` traces as bash 5.3 does: the shell's EXIT trap at the top level
//! (also after `exit` in a function, an `eval` or a `.` file, which bash
//! has unwound before it runs the trap); a `${ ;}` or `${| ;}` body one
//! level down (bash runs it with `parse_and_execute`); a declaration
//! builtin's compound assignment traced as the assignment it makes, when
//! its word expands and before the words after it (`+ a=('1' '<TAB>')`,
//! every element in plain single quotes, then `+ declare -a a`), each
//! substitution in the command run once when a `${ ;}` turns `set -x`,
//! `failglob` or `set -f` on or off; `export`'s and `readonly`'s
//! `name=value` operands traced as each is assigned, through the
//! builtin's own (redirected) descriptors (`+ export X=1`, then `+ X=1`;
//! none for `-f`, `-a` or `-A`), a failed write of that line not failing
//! the builtin; and `PS4`'s first character repeated whole when it is
//! multibyte.
//!
//! The rows ([`ROWS`]) are bash's own output: each script as `bash -c` and
//! as `bash ./s.sh`, run by bash 5.3.20 and 5.2.21 in a fresh directory
//! holding `in` ("hello") and a FIFO `fifo`, the directory written `DIR`; a
//! row both run alike is checked as both run it, one they run otherwise as
//! 5.3.20 does. Left out: `PS4` with a substitution in it (`$(…)`, a
//! backquote, `${ ;}`) and a command substitution's own EXIT trap level,
//! which obash does not trace as bash yet; a pipeline's trace order (it
//! depends on which stage runs first, in bash too); a row that prints a
//! pid; a `PS4` whose first byte is no character in a UTF-8 locale (bash
//! 5.3.20 aborts on it); and the rows about when a declaration's compound
//! assignment is made rather than traced (bash makes it as it expands the
//! word, so a later word sees it, a `failglob` error stops the words after
//! it, and under `failglob` it is traced before a later `${ ;}` runs;
//! obash makes it in the builtin).
#![cfg(unix)]

mod obash_support;

use std::{fs, os::unix::process::CommandExt as _, path::Path};

use obash_support::{obash, output};
use serde_json::Value;

/// The rows, as bash 5.3.20 and 5.2.21 ran them: `{id, file, script,
/// bash53: [status, stdout, stderr], bash52: [...]}`.
const ROWS: &str = include_str!("fixtures/xtrace_as_bash/rows.json");

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

/// The rows bash 5.2.21 and 5.3.20 run alike.
#[test]
fn set_x_traces_as_bash_does() {
	let rows: Vec<Row> = rows().into_iter().filter(|r| r.same52).collect();
	assert!(rows.len() > 100, "{} rows", rows.len());
	check(&rows);
}

/// The rows bash 5.2.21 runs otherwise (`${ ;}` and `${| ;}`, which it
/// does not have), as bash 5.3.20 runs them.
#[test]
fn rows_bash_5_2_runs_otherwise_are_as_bash_5_3_runs_them() {
	let rows: Vec<Row> = rows().into_iter().filter(|r| !r.same52).collect();
	assert!(rows.len() > 10, "{} rows", rows.len());
	check(&rows);
}
