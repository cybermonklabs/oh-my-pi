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

/// obash, and `/bin/bash` as the control where it is bash 4 or later (macOS's
/// `/bin/bash` is 3.2, which has no `coproc`).
fn shells() -> Vec<(&'static str, String)> {
	let mut shells = vec![("obash", env!("CARGO_BIN_EXE_obash").to_owned())];
	let major = Command::new("/bin/bash")
		.args(["-c", "echo ${BASH_VERSINFO[0]}"])
		.output()
		.ok()
		.and_then(|o| String::from_utf8(o.stdout).ok())
		.and_then(|v| v.trim().parse::<u32>().ok());
	match major {
		Some(major) if major >= 4 => shells.push(("bash", "/bin/bash".to_owned())),
		other => eprintln!("no bash control: /bin/bash major version {other:?}"),
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

/// A row's shell, the leader of a process group of its own: everything it
/// starts is in that group. Ending the row kills the whole group, then reaps
/// the shell, on every path (a panic too), so no row leaves a process behind.
struct Row(Option<std::process::Child>);

impl Row {
	/// Whether the shell has ended, without reaping it: until it is reaped
	/// its pid, the group's id, cannot be reused.
	fn ended(&self) -> bool {
		let child = self.0.as_ref().expect("a live row");
		let pid = libc::id_t::from(child.id());
		// SAFETY: a zeroed siginfo_t is a valid value for waitid to fill.
		let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
		// SAFETY: waitid only reads our child's state; WNOWAIT leaves it
		// unreaped.
		let r = unsafe {
			libc::waitid(
				libc::P_PID,
				pid,
				&raw mut info,
				libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
			)
		};
		// SAFETY: waitid filled `info`; si_pid is 0 while no child changed state.
		r == 0 && unsafe { info.si_pid() } != 0
	}

	/// Kill the row's whole group, then reap the shell: its exit status.
	fn end(&mut self) -> std::process::ExitStatus {
		let mut child = self.0.take().expect("a live row");
		let pgid = libc::pid_t::try_from(child.id()).unwrap();
		// SAFETY: a signal to the group the row's shell leads, which is not
		// reaped yet.
		unsafe { libc::killpg(pgid, libc::SIGKILL) };
		child.wait().unwrap()
	}
}

impl Drop for Row {
	fn drop(&mut self) {
		if self.0.is_some() {
			self.end();
		}
	}
}

/// The first line `script` prints, under `shell`, while its producer (which
/// reads `$D/gate` before it ends) still runs; then the test opens `gate`
/// and `fifo` so everything ends. `(line, end)` bound the wait for the line
/// and then for the shell's end ([`bounds`]).
fn first_line(
	shell: &str,
	script: &str,
	(line_bound, end_bound): (Duration, Duration),
) -> Result<String, String> {
	use std::os::unix::process::CommandExt;
	// Declared first, so removed after the row's group is gone.
	let dir = tempfile::tempdir().unwrap();
	mkfifo(&dir.path().join("gate"));
	mkfifo(&dir.path().join("fifo"));
	mkfifo(&dir.path().join("took"));
	let mut row = Row(Some(
		Command::new(shell)
			.args(["-c", script])
			.env("D", dir.path())
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.process_group(0)
			.spawn()
			.unwrap(),
	));
	let out = row.0.as_mut().unwrap().stdout.take().unwrap();
	let (tx, line) = mpsc::channel();
	std::thread::spawn(move || {
		let first = std::io::BufReader::new(out).lines().next();
		let _ = tx.send(first);
	});
	let got = line.recv_timeout(line_bound);
	poke(&dir.path().join("gate"));
	poke(&dir.path().join("fifo"));
	// A shell that does not end once its producer and FIFO are let go fails
	// its row instead of hanging the run: within its end bound after its line,
	// or within 3 s when no line came (it hangs already).
	let grace = if got.is_ok() {
		end_bound
	} else {
		Duration::from_secs(3)
	};
	let deadline = std::time::Instant::now() + grace;
	while !row.ended() {
		if std::time::Instant::now() >= deadline {
			let status = row.end();
			return Err(format!("{got:?}; still running {grace:?} later, killed ({status})"));
		}
		std::thread::sleep(Duration::from_millis(20));
	}
	let status = row.end();
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
/bin/sleep 1000 <&4 &
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

/// Each row's bounds: how long the test waits for the row's first line, and
/// then for its shell to end once the line came. Each is at least twice the
/// longest correct run of the row, obash's or bash's, measured on gVisor at
/// 1952m CPU beside 64 busy loops (builds Jobs, tag `fb-20261124T1057`, 38
/// runs as uid 1000 and as root), and at least [`HANG`]. A shell that does not
/// end within its bound fails its row, so a hang still fails.
const BOUNDS: &[(&str, Duration, Duration)] = &[
	// Longest correct run: line 2.20 s, end 0.44 s.
	("a holder that never reads", HANG, HANG),
	// Longest correct run: line 2.06 s, end 0.50 s.
	("a deferred spawn holding the pipe while its FIFO open waits", HANG, HANG),
	// Longest correct run: line 2.41 s, end 0.39 s.
	("reads that interleave with a live holder's", HANG, HANG),
	// Longest correct run: line 2.41 s, end 0.47 s.
	("end of file with a live holder", HANG, HANG),
	// Longest correct run: line 2.19 s, end 0.59 s.
	("a coprocess", HANG, HANG),
	// Longest correct run: line 2.14 s, end 0.31 s.
	("stdin a deferral's own redirection replaces", HANG, HANG),
	// Longest correct run: line 2.39 s, end 0.60 s.
	("readiness after a read through the feed", HANG, HANG),
	// Longest correct run: line 437.4 s (bash; obash 165.6 s), end 0.65 s.
	("every line once and in order past a full pipe", Duration::from_mins(15), HANG),
];

/// The bounds of `row` ([`BOUNDS`]): its line's, then its end's.
fn bounds(row: &str) -> (Duration, Duration) {
	BOUNDS
		.iter()
		.find(|(name, ..)| *name == row)
		.map_or_else(|| panic!("row {row:?} has no measured bound"), |&(_, line, end)| (line, end))
}

#[test]
fn the_shell_reads_the_bytes_an_externals_feed_holds() {
	let mut wrong = Vec::new();
	for (name, shell) in shells() {
		for (row, script, want) in ROWS {
			match first_line(&shell, script, bounds(row)) {
				Ok(line) if line == *want => {},
				got => wrong.push(format!("{name} {row}: {got:?}, want {want:?}")),
			}
		}
	}
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
