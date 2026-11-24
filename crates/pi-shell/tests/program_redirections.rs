//! A program's redirections are its fork's: bash looks the name up in the
//! shell, forks, and expands and makes the redirections of an external, a
//! name not found, `command X` and `A=1 X` in the child
//! (`execute_disk_command`), those of a null command that redirects fd 0 or
//! a `{var}` too (`execute_null_command`'s `forcefork`), and a `( … )`'s own
//! in the subshell's fork (`execute_in_subshell`). So what the words do
//! (`${f:=x}`, `$((x++))`, `${| x=5; }`, a `{var}`, a process substitution's
//! `$!`) never reaches the shell, `exit` in a `${ ;}` there ends only the
//! child, `break` ends the `${ ;}` only where a loop of the shell's encloses
//! the command (a fork keeps the shell's loop level; a subshell's starts at
//! 0), and `{PATH}</dev/null cat </dev/null` still runs `cat`. A fatal error
//! in a word the shell expanded itself (`${a[08]}`, which can change
//! nothing) still fails only the command, as in bash's fork.
//!
//! The rows ([`ROWS`]) are bash's own output: each script as `bash -c` and as
//! `bash ./s.sh`, run by bash 5.3.20 and 5.2.21 in a fresh directory holding
//! `in` ("hello") and a FIFO `fifo` (the directory written `DIR`); a row both
//! run alike is checked as both run it, one they run otherwise as 5.3.20
//! does (its `bash52` field differs). `$RANDOM` in such a word is left out:
//! obash draws it from one generator for every vproc, a defect of its own
//! (the `$RANDOM` member, "every bash-mode path"), so the shell's sequence
//! still moves.
//!
//! [`FORKS`] is the rule's other half, one row per kind of word that can
//! change the shell and controls that cannot: the number of `Subshell`
//! events obash reports for each, so a fork that is never made, or made for
//! a word that changes nothing, fails by its kind.
#![cfg(unix)]

mod obash_support;

use std::{fs, os::unix::process::CommandExt as _, path::Path};

use obash_support::{obash, output};
use pi_shell::testkit::{FakeHost, Fault, MemFs, golden, run_script};
use serde_json::Value;

/// The rows, as bash 5.3.20 and 5.2.21 ran them: `{id, file, script,
/// bash53: [status, stdout, stderr], bash52: [...]}`.
const ROWS: &str = include_str!("fixtures/program_redirections/rows.json");

/// Each row: id, script (run with `-c`), the `Subshell` events it starts
/// with this change (the fork made for a program's or a `( … )`'s
/// redirections, and the children its words start: `$( )`, `<( )`).
const FORKS: &[(&str, &str, usize)] = &[
	("k-assign-colon", "/bin/true > ${f:=x}", 1),
	("k-assign", "/bin/true > ${f=x}", 1),
	("k-error", "/bin/true 2> ${u?m}", 1),
	("k-arith", "/bin/true > nul$((x++))", 1),
	("k-subscript", "a=(x y); /bin/true > nul${a[i++]}", 1),
	("k-subscript-var", "a=(x y); i=0; /bin/true > nul${a[i]}", 1),
	("k-assoc-key", "declare -A A; /bin/true > nul${A[$((i++))]}", 1),
	("k-substr", "s=abc; /bin/true > nul${s:1:0}", 1),
	("k-funsub", "/bin/true > nul${ :; }", 1),
	("k-valsub", "/bin/true > nul${| :; }", 1),
	("k-prompt", "p=x; /bin/true > nul${p@P}", 1),
	("k-procsub-in", "/bin/true < <(:)", 2),
	("k-procsub-out", "/bin/true > >(:)", 2),
	("k-var", "/bin/true {fd}>/dev/null", 1),
	("k-random", "/bin/true > nul$RANDOM", 1),
	("k-bashpid", "/bin/true > nul$BASHPID", 1),
	("k-nameref", "x=; declare -n r=x; /bin/true > nul$r", 1),
	("k-indirect", "n=x; x=; /bin/true > nul${!n}", 1),
	("k-badsubst", "/bin/true > nul${a b}", 1),
	("k-comsub-syntax", "/bin/true > \"/dev/null${a-'$('\\'}\"", 1),
	("k-nounset", "set -u; x=; /bin/true > nul$x", 1),
	("k-failglob", "shopt -s failglob; /bin/true > /dev/nul[l]", 1),
	("k-heredoc", "/bin/cat <<E\n$((x++))\nE", 1),
	("k-cat-body", "/bin/true > nul$(< /dev/null${f:=x})", 2),
	("k-default-word", "/bin/true > ${x:-nul$((y++))}", 1),
	("k-replace-word", "x=a; /bin/true > nul${x/b/$((y++))}", 1),
	("k-not-found", "nosuch 2>/dev/null > ${f:=x}", 1),
	("k-command", "command /bin/true > ${f:=x}", 1),
	("k-assign-prefix", "A=1 /bin/true > ${f:=x}", 1),
	("k-subshell", "( : ) > ${f:=x}", 2),
	("k-subshell-null-in", "( : ) < /dev/null${x:+$((x++))}", 2),
	("c-subshell", "( : ) > /dev/null", 1),
	("c-group", "{ :; } > ${f:=x}", 0),
	("k-null-in", "< /dev/null${f:=x}", 1),
	("k-null-var", "{v}< /dev/null", 1),
	("c-plain", "/bin/true > /dev/null", 0),
	("c-param", "x=/dev/null; /bin/true > $x", 0),
	("c-default-plain", "/bin/true > ${x:-/dev/null}", 0),
	("c-subscript-number", "a=(/dev/null); /bin/true > ${a[0]}", 0),
	("c-assoc-literal", "declare -A A=([k]=/dev/null); /bin/true > ${A[k]}", 0),
	("c-comsub", "/bin/true > $(echo /dev/null)", 1),
	("c-cat-plain", "/bin/true > nul$(< /dev/null)", 1),
	("c-heredoc-quoted", "/bin/cat <<'E'\n$((x++))\nE", 0),
	("c-heredoc-plain", "/bin/cat <<E\nx $HOME\nE", 0),
	("c-herestring", "/bin/cat <<< x", 0),
	("c-failglob-plain", "shopt -s failglob; /bin/true > /dev/null", 0),
	("c-builtin", "true > ${f:=x}", 0),
	("c-builtin-var", ": {v}>/dev/null", 0),
	("c-function", "g() { :; }; g > ${f:=x}", 0),
	("c-exec", "exec 3> ${f:=x}", 0),
	("c-null-out", "> ${f:=x}", 0),
	("c-null-in-plain", "< /dev/null", 0),
	("c-cat-subst", "x=$(< /dev/null${f:=x})", 1),
	("c-async", "/bin/true > ${f:=x} & wait", 0),
	("c-pipeline", "/bin/true > ${f:=x} | /bin/cat", 0),
];

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
fn a_programs_redirections_are_expanded_in_its_fork() {
	let rows: Vec<Row> = rows().into_iter().filter(|r| r.same52).collect();
	assert!(rows.len() > 150, "{} rows", rows.len());
	check(&rows);
}

/// The rows bash 5.2.21 runs otherwise (`${ ;}` and `${| ;}`, which it
/// does not have; a null command's here-string, which it does not fork
/// for), as bash 5.3.20 runs them.
#[test]
fn rows_bash_5_2_runs_otherwise_are_as_bash_5_3_runs_them() {
	let rows: Vec<Row> = rows().into_iter().filter(|r| !r.same52).collect();
	assert!(rows.len() > 20, "{} rows", rows.len());
	check(&rows);
}

/// The events of `script` run with `-c`.
fn events(script: &str) -> Vec<Value> {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("events.jsonl");
	let out = output(obash().current_dir(dir.path()).args([
		"--events=jsonl",
		&format!("--events-out={}", path.display()),
		"-c",
		script,
	]));
	let events = golden::parse_jsonl(&fs::read_to_string(&path).unwrap()).unwrap();
	assert!(
		events.first().is_some_and(|e| e["kind"] == "RunStart"),
		"`{script}`: no event stream (stderr {})",
		String::from_utf8_lossy(&out.stderr)
	);
	events
}

fn count(events: &[Value], kind: &str) -> usize {
	events.iter().filter(|e| e["kind"] == kind).count()
}

/// A fork for every kind of word that can change the shell, and for no
/// word that cannot.
#[test]
fn the_fork_is_made_when_and_only_when_a_word_can_change_the_shell() {
	let wrong: Vec<String> = FORKS
		.iter()
		.filter_map(|&(id, script, want)| {
			let got = count(&events(script), "Subshell");
			(got != want).then(|| format!("{id}: `{script}`: {got} Subshell events, want {want}"))
		})
		.collect();
	assert!(wrong.is_empty(), "{} of {} rows:\n{}", wrong.len(), FORKS.len(), wrong.join("\n"));
}

/// The shell reports a forked command once: one `CmdStart` and one `CmdEnd`
/// for each command, the fork's included, with the program's status.
#[test]
fn a_forked_command_is_reported_once() {
	for (script, want) in [
		("/bin/false > ${f:=x}", 1),
		("nosuch 2>/dev/null > nul$((x++))", 127),
		("< /dev/null${f:=}", 0),
		("( false ) > ${f:=x}", 1),
	] {
		let events = events(script);
		let (starts, ends) = (count(&events, "CmdStart"), count(&events, "CmdEnd"));
		assert_eq!(starts, ends, "`{script}`: {starts} CmdStart, {ends} CmdEnd");
		let last = events
			.iter()
			.rev()
			.find(|e| e["kind"] == "CmdEnd")
			.map(|e| e["data"]["status"].clone());
		assert_eq!(last, Some(want.into()), "`{script}`: the last CmdEnd's status");
	}
}

/// The forks made for a program's, a null command's and a `( … )`'s
/// redirections are imaged and restored like any vproc: at every op the
/// shell's variables stay as bash leaves them and the command's status is
/// the fork's. The shell runs again only once the fork ends: imaged at
/// every op it is imaged about as often as when it made the redirections
/// itself (10 to 17 times for each script at #156's a6a2639b), not again at
/// each wake of the fork's own opens, which a restore drops and the fork
/// asks again (thousands of times, and on gVisor past a 300 s bound).
#[test]
fn a_programs_fork_holds_across_a_restore() {
	const SCRIPTS: &[(&str, &str, u32)] = &[
		(
			concat!(
				"nosuch 2>/err > /in${f:=x}; echo \"st=$? f=[$f]\"; x=0; ",
				"nosuch 2>/err < /in${| x=5; }; echo \"x=$x\"; ",
				"nosuch 2>/err < /in${| exit 7; }; echo \"st=$?\"",
			),
			"st=127 f=[]\nx=0\nst=7\n",
			10,
		),
		("( : ) 2>/err > /in${f:=x}; echo \"st=$? f=[$f]\"", "st=0 f=[]\n", 0),
		("< /in${f:=}; echo \"st=$? f=[${f-unset}]\"", "st=0 f=[unset]\n", 0),
	];
	let host = || {
		let fs = MemFs::with_latency(5, 1.0, 1);
		fs.add_file("/in", b"x\n", 0o644);
		FakeHost::new().with_fs(fs)
	};
	for &(src, want, fewest) in SCRIPTS {
		let plain = run_script(host(), src.as_bytes(), &[], Fault::None);
		let imaged = run_script(host(), src.as_bytes(), &[], Fault::Snapshot { every: 1 });
		assert!(
			(fewest + 1..100).contains(&imaged.snapshots),
			"`{src}`: {} snapshots",
			imaged.snapshots
		);
		let want = (0, want.to_owned());
		for (what, got) in [("plain", &plain), ("imaged", &imaged)] {
			let out = (got.status, String::from_utf8_lossy(&got.stdout).into_owned());
			assert_eq!(out, want, "`{src}` {what}: stderr {}", String::from_utf8_lossy(&got.stderr));
		}
	}
}

/// A fatal expansion error in a program's redirections that the shell made
/// itself (no word could change it) fails only the command, as in bash's
/// fork: here obash's own failure of `${#A[$k]}` with an empty key (bash
/// expands it to 0 and fails to open `/dev/null0`; either way the command
/// fails with 1 and the shell goes on).
#[test]
fn a_fatal_error_the_shell_made_fails_only_the_program() {
	const SRC: &str = "declare -A A; k=; /bin/true < /dev/null${#A[$k]}; echo \"after $?\"";
	let dir = tempfile::tempdir().unwrap();
	let mut cmd = obash();
	cmd.arg0("bash").current_dir(dir.path()).arg("-c").arg(SRC);
	let got = output(&mut cmd);
	assert_eq!(
		(got.status.code(), String::from_utf8_lossy(&got.stdout).into_owned()),
		(Some(0), "after 1\n".to_owned()),
		"stderr {}",
		String::from_utf8_lossy(&got.stderr)
	);
}
