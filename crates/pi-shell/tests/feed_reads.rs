//! The shell's own reads of a process substitution or coprocess pipe that
//! an external also holds take the next bytes, as bash's shell and its
//! children read one kernel pipe: the host's feed moves the pipe's bytes into
//! an OS pipe for the externals, and the shell reads through it first.

#![cfg(unix)]

use std::{
	io::BufRead,
	path::Path,
	process::{Command, Stdio},
	sync::mpsc,
	time::Duration,
};

/// A wait that only names a hang.
const HANG: Duration = Duration::from_secs(30);

fn shells() -> Vec<(&'static str, String)> {
	let mut shells = vec![("obash", env!("CARGO_BIN_EXE_obash").to_owned())];
	if Path::new("/bin/bash").exists() {
		shells.push(("bash", "/bin/bash".to_owned()));
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

/// The first line `script` prints, under `shell`, while its producer (which
/// reads `$D/gate` before it ends) still runs; then the test opens `gate`
/// and `fifo` so everything ends.
fn first_line(shell: &str, script: &str) -> Result<String, String> {
	let dir = tempfile::tempdir().unwrap();
	mkfifo(&dir.path().join("gate"));
	mkfifo(&dir.path().join("fifo"));
	mkfifo(&dir.path().join("took"));
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
		let first = std::io::BufReader::new(out).lines().next();
		let _ = tx.send(first);
	});
	let got = line.recv_timeout(HANG);
	poke(&dir.path().join("gate"));
	poke(&dir.path().join("fifo"));
	let status = child.wait().unwrap();
	match got {
		Ok(Some(Ok(line))) if status.success() => Ok(line),
		other => Err(format!("{other:?} {status}")),
	}
}

/// Each row: its name, the script, and the first line bash prints. Each
/// row pauses a second before the shell's first read of the pipe, so the
/// external's feed has taken the bytes by then (a race without it). In
/// every row an external holds the pipe while the shell reads and leaves the
/// bytes the shell wants unread, so the line must come from bytes the
/// external's feed holds; where the producer stays until the test lets it go,
/// the line cannot come from the producer's end either.
const ROWS: &[(&str, &str, &str)] = &[
	(
		"a holder that never reads",
		r#"exec 4< <(printf 'abc\n'; read -r _ < "$D/gate")
/bin/sleep 30 <&4 &
h=$!
sleep 1
read -r v <&4
echo "v=$v"
kill $h 2>/dev/null
:"#,
		"v=abc",
	),
	(
		"a deferred spawn holding the pipe while its FIFO open waits",
		r#"exec 4< <(echo x; read -r _ < "$D/gate")
/bin/sleep 1 <&4 &
b=$!
/bin/cat < "$D/fifo" > /dev/null &
wait $b
read -r v <&4
echo "v=$v""#,
		"v=x",
	),
	(
		"reads that interleave with a live holder's",
		r#"exec 4< <(printf 'a\nb\n'; read -r _ < "$D/gate")
/bin/sh -c 'dd bs=1 count=2 2>/dev/null > "$D/took"; sleep 30' <&4 &
h=$!
read -r t < "$D/took"
sleep 1
read -r v <&4
echo "t=$t v=$v"
kill $h 2>/dev/null
:"#,
		"t=a v=b",
	),
	(
		"end of file with a live holder",
		r#"exec 4< <(printf x)
/bin/sleep 30 <&4 &
h=$!
sleep 1
read -r v <&4
echo "v=$v s=$?"
kill $h 2>/dev/null
:"#,
		"v=x s=1",
	),
	(
		"a coprocess",
		r#"coproc { printf 'c\n'; read -r _ < "$D/gate"; }
/bin/sleep 30 <&"${COPROC[0]}" &
h=$!
sleep 1
read -r v <&"${COPROC[0]}"
echo "v=$v"
kill $h 2>/dev/null
:"#,
		"v=c",
	),
	(
		"stdin a deferral's own redirection replaces",
		r#"{
	/bin/cat < "$D/fifo" > /dev/null &
	sleep 1
	read -r v
	echo "v=$v"
	exec 6> "$D/fifo"
} < <(printf 'z\n'; read -r _ < "$D/gate")"#,
		"v=z",
	),
	(
		"readiness after a read through the feed",
		r#"exec 4< <(printf 'p\nq\n'; read -r _ < "$D/gate")
/bin/sleep 30 <&4 &
h=$!
sleep 1
read -r v <&4
if read -t 0 <&4; then r=ready; else r=empty; fi
echo "v=$v r=$r"
kill $h 2>/dev/null
:"#,
		"v=p r=ready",
	),
	(
		"every line once and in order past a full pipe",
		r#"exec 4< <(seq 1 100000; read -r _ < "$D/gate")
/bin/sleep 60 <&4 &
h=$!
sleep 1
i=0
while [ $i -lt 100000 ] && read -r l <&4; do
	i=$((i + 1))
	[ "$l" = "$i" ] || break
done
echo "n=$i"
kill $h 2>/dev/null
:"#,
		"n=100000",
	),
];

#[test]
fn the_shell_reads_the_bytes_an_externals_feed_holds() {
	let mut wrong = Vec::new();
	for (name, shell) in shells() {
		for (row, script, want) in ROWS {
			match first_line(&shell, script) {
				Ok(line) if line == *want => {},
				got => wrong.push(format!("{name} {row}: {got:?}, want {want:?}")),
			}
		}
	}
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
