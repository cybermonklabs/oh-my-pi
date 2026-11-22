//! A child the shell forks to apply its own redirections (the lone external
//! of a background job whose open waits, here on a FIFO with no other end)
//! holds no other job's pipe while that open waits, as bash's child holds
//! none, and its redirections still read every descriptor they name.

#![cfg(unix)]

use std::{
	io::{BufRead, BufReader, Write},
	path::Path,
	process::{Child, Command, Stdio},
	sync::mpsc,
	time::Duration,
};

/// A wait that only names a hang: every event here comes within
/// milliseconds when it comes at all.
const HANG: Duration = Duration::from_secs(30);

fn shells() -> Vec<(&'static str, String)> {
	let mut shells = vec![("obash", env!("CARGO_BIN_EXE_obash").to_owned())];
	if Path::new("/bin/bash").exists() {
		shells.push(("bash", "/bin/bash".to_owned()));
	}
	shells
}

fn start(shell: &str, script: &str, dir: &Path) -> Child {
	Command::new(shell)
		.args(["-c", script])
		.env("D", dir)
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
		.expect("start the shell")
}

fn mkfifo(path: &Path) {
	let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
	// SAFETY: a valid C path.
	assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo {}", path.display());
}

/// B reads a pipe to end of file in the background; then A starts, a lone
/// background external whose `< fifo` open waits: nothing opens the FIFO's
/// other end until the test does. B's writer ends when the test opens the
/// gate. B must then end while A's open still waits: B's end of file must
/// not wait for A's child, which forked while B's pipe was open in the
/// shell. bash's parent keeps no end of B's pipe, so its child holds none.
const HOLD: &str = r#"
{ read -r _ < "$D/gate"; echo hi; } | /bin/cat > "$D/b.out" &
b=$!
/bin/cat < "$D/fifo" > /dev/null &
echo started
wait $b
echo "b done $(cat "$D/b.out")"
wait
echo all done
"#;

#[test]
fn a_child_waiting_in_a_fifo_open_holds_no_other_jobs_pipe() {
	for (name, shell) in shells() {
		let dir = tempfile::tempdir().unwrap();
		mkfifo(&dir.path().join("fifo"));
		mkfifo(&dir.path().join("gate"));
		let mut child = start(&shell, HOLD, dir.path());
		let (tx, lines) = mpsc::channel();
		let out = child.stdout.take().unwrap();
		std::thread::spawn(move || {
			for line in BufReader::new(out).lines() {
				if tx.send(line.unwrap()).is_err() {
					break;
				}
			}
		});
		let next = |what: &str| {
			lines
				.recv_timeout(HANG)
				.unwrap_or_else(|_| panic!("{name}: no `{what}` within {HANG:?}"))
		};
		assert_eq!(next("started"), "started", "{name}");
		// B's writer ends: the read of the gate returns once the test's
		// write end is open and closed again.
		drop(
			std::fs::OpenOptions::new()
				.write(true)
				.open(dir.path().join("gate"))
				.unwrap(),
		);
		let b = lines.recv_timeout(HANG);
		// Let A go in any case, so the shell ends.
		{
			let mut fifo = std::fs::OpenOptions::new()
				.write(true)
				.open(dir.path().join("fifo"))
				.unwrap();
			let _ = fifo.write_all(b"");
		}
		assert_eq!(
			b.as_deref(),
			Ok("b done hi"),
			"{name}: B ended only once A's FIFO open was given its other end (A's child held B's \
			 pipe)"
		);
		assert_eq!(next("all done"), "all done", "{name}");
		let status = child.wait().unwrap();
		assert!(status.success(), "{name}: {status}");
	}
}

/// Each redirection of a deferred spawn reads the descriptor bash gives it,
/// whatever the child closes before them: dups (`3<&4`, `2>&1`, `>&5`, from
/// an fd an earlier redirection opened), `<&-` and `>&-`, a here-document,
/// a here-string, a process substitution, and a function's redirections.
/// Every background command waits in a FIFO open (so the child applies its
/// redirections itself) until the foreground opens the other end. The
/// function rows name their programs through `PATH`: an absolute path in a
/// background function whose open waits is reported not found, a separate
/// defect with its own fix.
const ROWS: &[(&str, &str, &str)] = &[
	(
		"dup 3<&4",
		r#"exec 4< "$D/in"; /bin/sh -c 'cat <&3' 3<&4 > "$D/fifo" & cat "$D/fifo"; wait"#,
		"in-text\n",
	),
	(
		"dup 2>&1",
		r#"/bin/sh -c 'echo out; echo err >&2' > "$D/fifo" 2>&1 & cat "$D/fifo"; wait"#,
		"out\nerr\n",
	),
	(
		"dup >&5",
		r#"exec 5> "$D/five"; /bin/sh -c 'echo five' >&5 < "$D/fifo" & exec 6> "$D/fifo"; wait; exec 6>&-; cat "$D/five""#,
		"five\n",
	),
	(
		"dup from an earlier redirection",
		r#"/bin/sh -c 'cat <&4' 3< "$D/in" 4<&3 > "$D/fifo" & cat "$D/fifo"; wait"#,
		"in-text\n",
	),
	(
		"<&-",
		r#"/bin/sh -c 'if read -r v 2>/dev/null; then echo read; else echo closed; fi' <&- > "$D/fifo" & cat "$D/fifo"; wait"#,
		"closed\n",
	),
	(
		">&-",
		r#"/bin/sh -c 'echo x 2>/dev/null || echo closed >&2' >&- 2> "$D/err" < "$D/fifo" & exec 6> "$D/fifo"; wait; exec 6>&-; cat "$D/err""#,
		"closed\n",
	),
	(
		"here-document",
		"/bin/cat <<'EOF' > \"$D/fifo\" &\nheredoc\nEOF\ncat \"$D/fifo\"; wait",
		"heredoc\n",
	),
	("here-string", r#"/bin/cat <<< herestring > "$D/fifo" & cat "$D/fifo"; wait"#, "herestring\n"),
	(
		"process substitution",
		r#"/bin/sh -c 'cat <&3' 3< <(echo procsub) > "$D/fifo" & cat "$D/fifo"; wait"#,
		"procsub\n",
	),
	(
		"a function's redirections",
		r#"g() { sh -c 'cat <&3'; } 3< "$D/in"; g > "$D/fifo" & cat "$D/fifo"; wait"#,
		"in-text\n",
	),
	(
		"a function call's redirections",
		r#"f() { cat; }; f < "$D/in" > "$D/fifo" & cat "$D/fifo"; wait"#,
		"in-text\n",
	),
];

#[test]
fn deferred_redirections_read_the_descriptors_bash_gives_them() {
	let mut wrong = Vec::new();
	for (name, shell) in shells() {
		for (row, script, want) in ROWS {
			let dir = tempfile::tempdir().unwrap();
			mkfifo(&dir.path().join("fifo"));
			std::fs::write(dir.path().join("in"), "in-text\n").unwrap();
			let child = start(&shell, script, dir.path());
			let (tx, done) = mpsc::channel();
			std::thread::spawn(move || tx.send(child.wait_with_output()));
			let Ok(out) = done.recv_timeout(HANG) else {
				wrong.push(format!("{name} {row}: no end within {HANG:?}"));
				continue;
			};
			let out = out.unwrap();
			let got = String::from_utf8_lossy(&out.stdout);
			if got != *want || !out.status.success() {
				wrong.push(format!(
					"{name} {row}: {got:?} {}, want {want:?}; stderr {:?}",
					out.status,
					String::from_utf8_lossy(&out.stderr)
				));
			}
		}
	}
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// `/dev/fd/N` names the shell's fd N, which the engine reads as a dup of
/// N. When N is one of the host's own descriptors and no fd of the shell, a
/// deferred spawn's dup of it fails with `EBADF`, as for a closed fd: the
/// child keeps only its placed fds, so it never takes the host's object.
/// obash only: bash has no host descriptors besides its own fds.
const DEV_FD: &str = r#"
n=
for f in /proc/$$/fd/*; do
	f=${f##*/}
	[ "$f" -gt 2 ] || continue
	{ : <&"$f"; } 2>/dev/null && continue
	{ : >&"$f"; } 2>/dev/null && continue
	[ -e "/proc/$$/fd/$f" ] || continue
	n=$f
	break
done
[ -n "$n" ] || { echo "no host fd"; exit 1; }
/bin/sh -c 'cat <&3' > "$D/fifo" 2> "$D/host.err" 3< "/dev/fd/$n" &
cat "$D/fifo"
wait $!
echo "host $?"
/bin/sh -c 'cat <&3' > "$D/fifo" 2> "$D/closed.err" 3< /dev/fd/900 &
cat "$D/fifo"
wait $!
echo "closed $?"
sed -e "s#/dev/fd/$n#/dev/fd/N#" -e "s/line [0-9]*:/line L:/" "$D/host.err"
sed -e "s#/dev/fd/900#/dev/fd/N#" -e "s/line [0-9]*:/line L:/" "$D/closed.err"
"#;

#[test]
fn a_dev_fd_redirection_naming_a_host_descriptor_fails_as_a_closed_fd() {
	let dir = tempfile::tempdir().unwrap();
	mkfifo(&dir.path().join("fifo"));
	let child = start(env!("CARGO_BIN_EXE_obash"), DEV_FD, dir.path());
	let (tx, done) = mpsc::channel();
	std::thread::spawn(move || tx.send(child.wait_with_output()));
	let out = done
		.recv_timeout(HANG)
		.expect("the dup of a host descriptor took the host's object (no end)")
		.unwrap();
	let got = String::from_utf8_lossy(&out.stdout);
	let lines: Vec<&str> = got.lines().collect();
	assert!(out.status.success(), "{got:?} {:?}", String::from_utf8_lossy(&out.stderr));
	assert_eq!(&lines[..2], ["host 1", "closed 1"], "{got:?}");
	assert_eq!(lines.len(), 4, "{got:?}");
	assert_eq!(lines[2], lines[3], "the same failure as a closed fd: {got:?}");
	assert!(lines[2].ends_with("Bad file descriptor"), "{got:?}");
}
