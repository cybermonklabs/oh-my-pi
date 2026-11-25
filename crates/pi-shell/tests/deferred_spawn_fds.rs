//! A spawn that applies its own redirections (the lone external of a
//! background job whose open waits) is handed no fd its redirections close
//! or replace before its exec: it never holds that fd's engine object, whose
//! bytes the shell then reads as bash's shell does.

#![cfg(unix)]

mod pty_support;
mod real_bash;
mod zsh_oracle;

use std::{
	path::Path,
	process::{Command, Stdio},
	sync::mpsc,
	time::Duration,
};

/// A wait that only names a hang.
const HANG: Duration = Duration::from_secs(30);

fn shells() -> Vec<(&'static str, String)> {
	let mut shells = vec![("obash", pty_support::obash().to_owned())];
	if let Some(bash) = real_bash::real_bash() {
		shells.push(("bash", bash));
	}
	shells
}

fn mkfifo(path: &Path) {
	let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
	// SAFETY: a valid C path.
	assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo {}", path.display());
}

/// Open the FIFO `path` for writing and close it again, if a reader has it
/// open or waits in its open; else nothing.
fn poke(path: &Path) {
	use std::os::unix::fs::OpenOptionsExt;
	let _ = std::fs::OpenOptions::new()
		.write(true)
		.custom_flags(libc::O_NONBLOCK)
		.open(path);
}

/// A process substitution on fd 4 whose producer stays until the test opens
/// `gate`; B, a background external holding fd 4, ends after 1 s without
/// reading it; meanwhile A, a background external whose `< fifo` open waits,
/// is spawned with `@FD4@`. Once B is done, the shell's own `read` of fd 4
/// must find `x`, which B never read, while the producer still runs, as in
/// bash, whose shell and B share one kernel pipe.
///
/// `@OPEN@` either has the shell open the FIFO's other end, so A execs and
/// runs on, or leaves A waiting in its open until the test opens it. In the
/// second shape B's feed is given back while A's forked child still waits:
/// the child must hold no copy of the feed's pipe then (it keeps only its
/// placed fds, `sys::spawn::unix`), or the give-back waits for its exec.
const SCRIPT: &str = r#"
exec 4< <(echo x; read -r _ < "$D/gate")
/bin/sleep 1 <&4 &
b=$!
/bin/cat < "$D/fifo" > /dev/null @FD4@ &
@OPEN@
wait $b
read -r v <&4
echo "v=$v"
exec 6>&-
"#;

/// Each row's name, A's own redirection of fd 4 (`@FD4@`) and whether the
/// shell opens the FIFO's other end before B ends.
const ROWS: &[(&str, &str, bool)] = &[
	("closed", "4<&-", true),
	("replaced by a file", "4< \"$D/other\"", true),
	("replaced by a dup", "4>&1", true),
	("closed, its open still waiting", "4<&-", false),
];

fn run(shell: &str, script: &str) -> Result<String, String> {
	let dir = tempfile::tempdir().unwrap();
	mkfifo(&dir.path().join("fifo"));
	mkfifo(&dir.path().join("gate"));
	std::fs::write(dir.path().join("other"), "other\n").unwrap();
	let mut child = Command::new(shell)
		.args(["-c", script])
		.env("D", dir.path())
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
		.unwrap();
	let out = child.stdout.take().unwrap();
	let (tx, line) = mpsc::channel();
	std::thread::spawn(move || {
		use std::io::BufRead;
		let first = std::io::BufReader::new(out).lines().next();
		let _ = tx.send(first);
	});
	let got = line.recv_timeout(HANG);
	// Let the producer and A go in any case: open each FIFO's other end if
	// something waits on it. A blocking open would wait forever where nothing
	// does any more (obash's process substitution ends with the shell).
	poke(&dir.path().join("gate"));
	poke(&dir.path().join("fifo"));
	let status = child.wait().unwrap();
	match got {
		Ok(Some(Ok(line))) if status.success() => Ok(line),
		other => Err(format!("{other:?} {status}")),
	}
}

#[test]
fn a_deferred_spawn_holds_no_fd_its_redirections_close_or_replace() {
	let mut wrong = Vec::new();
	for (name, shell) in shells() {
		for (row, fd4, open) in ROWS {
			let open = if *open { "exec 6> \"$D/fifo\"" } else { ":" };
			match run(&shell, &SCRIPT.replace("@FD4@", fd4).replace("@OPEN@", open)) {
				Ok(line) if line == "v=x" => {},
				got => wrong.push(format!(
					"{name} {row}: {got:?}, want v=x before the producer ended (A held fd 4's engine \
					 object)"
				)),
			}
		}
	}
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// An fd the child reads, or keeps, is still handed over. Each redirection
/// that reads fd 4 or 5 comes after the waiting `> fifo`, so the child
/// applies it itself: fd 4 kept as it is; `3<&5 5<&-`, where fd 5 is read
/// before it is closed; and `&>/dev/fd/4 4>&-`, an open of two fds whose
/// path names fd 4, read before fd 4 is closed.
#[test]
fn a_deferred_spawn_still_gets_the_fds_it_keeps() {
	let script = r#"
exec 4< <(echo x)
/bin/sh -c 'cat <&4' > "$D/fifo" &
cat "$D/fifo"
wait
exec 5< <(echo y)
/bin/sh -c 'cat <&3' > "$D/fifo" 3<&5 5<&- &
cat "$D/fifo"
wait
exec 4> "$D/out"
/bin/sh -c 'echo z' < "$D/fifo" &>/dev/fd/4 4>&- &
exec 6> "$D/fifo"
wait
exec 6>&- 4>&-
cat "$D/out"
"#;
	for (name, shell) in shells() {
		let dir = tempfile::tempdir().unwrap();
		mkfifo(&dir.path().join("fifo"));
		let child = Command::new(&shell)
			.args(["-c", script])
			.env("D", dir.path())
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.spawn()
			.unwrap();
		let (tx, done) = mpsc::channel();
		std::thread::spawn(move || tx.send(child.wait_with_output()));
		let out = done
			.recv_timeout(HANG)
			.unwrap_or_else(|_| panic!("{name}: no end"))
			.unwrap();
		assert_eq!(
			String::from_utf8_lossy(&out.stdout),
			"x\ny\nz\n",
			"{name}: {:?}",
			String::from_utf8_lossy(&out.stderr)
		);
	}
}
