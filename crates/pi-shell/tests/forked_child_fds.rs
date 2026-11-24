//! A child the shell forks to apply its own redirections (the lone external
//! of a background job whose open waits, here on a FIFO with no other end)
//! holds no other job's pipe while that open waits, as bash's child holds
//! none, and its redirections still read every descriptor they name.

#![cfg(unix)]

mod pty_support;
mod real_bash;

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
	let mut shells = vec![("obash", pty_support::obash().to_owned())];
	if let Some(bash) = real_bash::real_bash() {
		shells.push(("bash", bash));
	}
	shells
}

/// The shell leads a process group of its own, which the test owns
/// ([`Owned`]).
fn start(shell: &str, script: &str, dir: &Path) -> Owned {
	use std::os::unix::process::CommandExt;

	let child = Command::new(shell)
		.args(["-c", script])
		.env("D", dir)
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.process_group(0)
		.spawn()
		.expect("start the shell");
	let group = libc::pid_t::try_from(child.id()).unwrap();
	Owned { child: Some(child), group }
}

/// A shell the test started ([`start`]) and its process group: everything
/// the shell starts that stays in it. However the test leaves it (the shell
/// ended, the test failed or timed out), the group is killed while the shell
/// is not reaped yet, so no process of it outlives the test, and the group's
/// number cannot name another group meanwhile.
struct Owned {
	child: Option<Child>,
	group: libc::pid_t,
}

impl Owned {
	/// Once the shell has ended (still unreaped), kill its group, reap it,
	/// and return what it wrote to whichever of its pipes the test did not
	/// take.
	fn end(mut self) -> std::process::Output {
		let mut child = self.child.take().expect("the shell is still the test's");
		let stdout = drain(child.stdout.take());
		let stderr = drain(child.stderr.take());
		let pid = libc::id_t::try_from(child.id()).unwrap();
		// SAFETY: siginfo_t is plain data; waitid with WNOWAIT waits for the
		// child's end and leaves it unreaped.
		unsafe {
			let mut info = std::mem::zeroed::<libc::siginfo_t>();
			libc::waitid(libc::P_PID, pid, &raw mut info, libc::WEXITED | libc::WNOWAIT);
		}
		kill_group(self.group);
		let status = child.wait().expect("reap the shell");
		std::process::Output {
			status,
			stdout: stdout.join().unwrap(),
			stderr: stderr.join().unwrap(),
		}
	}
}

impl Drop for Owned {
	fn drop(&mut self) {
		if let Some(mut child) = self.child.take() {
			kill_group(self.group);
			let _ = child.wait();
		}
	}
}

/// SIGKILL to every process of `group`, a shell's own group ([`Owned`]).
fn kill_group(group: libc::pid_t) {
	// SAFETY: a signal to a process group the test owns; its leader is not
	// reaped yet, so the number names no other group.
	unsafe { libc::killpg(group, libc::SIGKILL) };
}

/// Everything `pipe` yields up to end of file, read on a thread of its own
/// (nothing for a pipe the test took).
fn drain<R: std::io::Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
	std::thread::spawn(move || {
		let mut bytes = Vec::new();
		if let Some(mut pipe) = pipe {
			let _ = pipe.read_to_end(&mut bytes);
		}
		bytes
	})
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
///
/// A starts only once B's reader has read B's first line, so B's pipe and
/// reader exist when A forks (else A could fork first and hold nothing).
const HOLD: &str = r#"
{ echo up; read -r _ < "$D/gate"; echo hi; } | /bin/sh -c 'IFS= read -r l; echo "$l" > "$D/up"; exec cat' > "$D/b.out" &
b=$!
until [ -s "$D/up" ]; do sleep 0.01; done
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
		let mut shell = start(&shell, HOLD, dir.path());
		let (tx, lines) = mpsc::channel();
		let out = shell.child.as_mut().unwrap().stdout.take().unwrap();
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
		let status = shell.end().status;
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
/// defect with its own fix. The `>&-` row asks whether fd 1 is closed with
/// a dup of it (`exec 3>&1`), which fails on a closed fd under every
/// `/bin/sh`: a write there would not do, since a failed `echo` keeps its
/// bytes in the stdio buffer of macOS's `/bin/sh` (bash 3.2), and its next
/// write to fd 1 sends them out.
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
		"fd 3 opened after the FIFO open",
		r#"/bin/sh -c 'cat <&3' > "$D/fifo" 3< "$D/in" & cat "$D/fifo"; wait"#,
		"in-text\n",
	),
	(
		">&-",
		r#"/bin/sh -c 'if (exec 3>&1) 2>&-; then echo open >&2; else echo closed >&2; fi' >&- 2> "$D/err" < "$D/fifo" & exec 6> "$D/fifo"; wait; exec 6>&-; cat "$D/err""#,
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

/// One run of `script` under `shell`, in a directory `$D` holding a FIFO
/// `fifo` and a file `in`. A run that does not end within [`HANG`] is
/// killed with its process group ([`Owned`]); its `Err` lists those
/// processes and their fds first ([`processes`]), so the hang can be traced.
fn run(shell: &str, script: &str) -> Result<std::process::Output, String> {
	let dir = tempfile::tempdir().unwrap();
	mkfifo(&dir.path().join("fifo"));
	std::fs::write(dir.path().join("in"), "in-text\n").unwrap();
	let owned = start(shell, script, dir.path());
	let group = owned.group;
	let (tx, done) = mpsc::channel();
	std::thread::spawn(move || tx.send(owned.end()));
	let Ok(out) = done.recv_timeout(HANG) else {
		let held = processes(group);
		eprintln!("{shell}: no end within {HANG:?}; its processes:\n{held}");
		// The shell is not reaped yet: `end` waits for it.
		kill_group(group);
		let _ = done.recv_timeout(HANG);
		return Err(format!("no end within {HANG:?}; its processes:\n{held}"));
	};
	Ok(out)
}

/// The processes of process group `group`, each with its state, kernel
/// wait channel, command line and fds (from `/proc`). `UNKNOWN` where they
/// cannot be read, never an empty list.
#[cfg(target_os = "linux")]
fn processes(group: libc::pid_t) -> String {
	use std::fmt::Write as _;

	let Ok(dir) = std::fs::read_dir("/proc") else {
		return "UNKNOWN: /proc cannot be read".to_owned();
	};
	let mut out = String::new();
	for entry in dir.flatten() {
		let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
			continue;
		};
		let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
			continue;
		};
		// After the command name's `)`: state, parent, group.
		let Some(rest) = stat.rfind(')').map(|i| &stat[i + 2..]) else {
			continue;
		};
		let fields: Vec<&str> = rest.split(' ').collect();
		if fields.get(2).and_then(|g| g.parse::<libc::pid_t>().ok()) != Some(group) {
			continue;
		}
		let read = |what: &str| {
			std::fs::read(format!("/proc/{pid}/{what}")).map_or_else(
				|e| format!("UNKNOWN ({e})"),
				|b| {
					String::from_utf8_lossy(&b)
						.replace('\0', " ")
						.trim()
						.to_owned()
				},
			)
		};
		let _ = writeln!(
			out,
			"  pid {pid} state {} ppid {} wchan {} cmd {}",
			fields[0],
			fields.get(1).unwrap_or(&"?"),
			read("wchan"),
			read("cmdline")
		);
		match std::fs::read_dir(format!("/proc/{pid}/fd")) {
			Ok(fds) => {
				let mut fds: Vec<(u32, String)> = fds
					.flatten()
					.filter_map(|fd| {
						let n = fd.file_name().to_string_lossy().parse().ok()?;
						let to = std::fs::read_link(fd.path())
							.map_or_else(|e| format!("UNKNOWN ({e})"), |p| p.display().to_string());
						Some((n, to))
					})
					.collect();
				fds.sort();
				for (n, to) in fds {
					let _ = writeln!(out, "    fd {n} -> {to}");
				}
			},
			Err(e) => {
				let _ = writeln!(out, "    fds UNKNOWN ({e})");
			},
		}
	}
	if out.is_empty() {
		format!("UNKNOWN: no process of group {group} in /proc")
	} else {
		out
	}
}

/// Elsewhere: no `/proc` to read.
#[cfg(not(target_os = "linux"))]
fn processes(group: libc::pid_t) -> String {
	format!("UNKNOWN: no /proc here to list group {group}")
}

/// One run of `script` under `shell` ([`run`]): `Err` names what differs
/// from `want`, or the hang.
fn run_row(shell: &str, script: &str, want: &str) -> Result<(), String> {
	let out = run(shell, script)?;
	let got = String::from_utf8_lossy(&out.stdout);
	if got != want || !out.status.success() {
		return Err(format!(
			"{got:?} {}, want {want:?}; stderr {:?}",
			out.status,
			String::from_utf8_lossy(&out.stderr)
		));
	}
	Ok(())
}

/// [`run_row`] once under obash, so an obash run that does not end fails
/// the test. Under bash, the reference, a row that fails runs again, up to
/// three times: bash now and then never ends on a row whose shell or child
/// waits in a FIFO open (each test's note gives the counts). Each retry is
/// printed, so a run's output shows how often the reference needed one.
fn run_row_as(name: &str, shell: &str, script: &str, want: &str) -> Result<(), String> {
	let tries = if name == "bash" { 3 } else { 1 };
	let mut last = Ok(());
	for n in 1..=tries {
		last = run_row(shell, script, want);
		match &last {
			Ok(()) => break,
			Err(e) if n < tries => eprintln!("bash retry: try {n} of {tries} failed: {e}"),
			Err(_) => {},
		}
	}
	last
}

/// Each row runs once under obash and up to three times under bash
/// ([`run_row_as`]): under gVisor bash now and then never ends on the process
/// substitution row (bash 5.2.21 run alone, not through this test: 6 of 600
/// runs; the same row with no FIFO open: none of 600; on runc: none of 300).
/// obash has hung on that row too, more rarely (on gVisor as uid 1000, once
/// in 1,200 runs), which this test reports as a failure. A run that does not
/// end prints its processes and their fds before they are killed ([`run`]).
#[test]
fn deferred_redirections_read_the_descriptors_bash_gives_them() {
	let mut wrong = Vec::new();
	for (name, shell) in shells() {
		for (row, script, want) in ROWS {
			if let Err(e) = run_row_as(name, &shell, script, want) {
				wrong.push(format!("{name} {row}: {e}"));
			}
		}
	}
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// A redirection the child fails after its FIFO open (`> fifo` comes
/// first): a dup of a closed fd (`3<&900`, `/dev/fd/900`, `3<&- 4<&3`) or a
/// target that is no single word. bash's child opens the FIFO and then
/// fails, so the FIFO's reader (`cat`, or the shell's own `exec 5<`) gets
/// end of file, and the job's status is 1; it stops there, so no word of a
/// redirection after it is expanded. The engine knows these are bad before
/// the child exists; refused in the shell, the FIFO's open never happens,
/// and its reader waits for ever. The message after `line N: ` is bash's
/// (bash 3.2, macOS's `/bin/bash`, names no line, so `$0: ` goes too),
/// but for `/dev/fd/900`: bash opens the path (`No such file or
/// directory`), and the engine reads it as a dup of fd 900 (`Bad file
/// descriptor`), as in the foreground.
const FAILS: &[(&str, &str, &str)] = &[
	(
		"3<&900",
		r#"/bin/sh -c 'echo ran' > "$D/fifo" 2> "$D/err" 3<&900 & cat "$D/fifo"; wait $!; echo "status $?"; sed -e 's/^.*line [0-9]*: //' -e "s#^$0: ##" "$D/err""#,
		"status 1\n900: Bad file descriptor\n",
	),
	(
		"3<&- 4<&3",
		r#"/bin/sh -c 'echo ran' > "$D/fifo" 2> "$D/err" 3<&- 4<&3 & cat "$D/fifo"; wait $!; echo "status $?"; sed -e 's/^.*line [0-9]*: //' -e "s#^$0: ##" "$D/err""#,
		"status 1\n3: Bad file descriptor\n",
	),
	(
		"/dev/fd/900",
		r#"/bin/sh -c 'echo ran' > "$D/fifo" 2> "$D/err" 3< /dev/fd/900 & cat "$D/fifo"; wait $!; echo "status $?"; [ -s "$D/err" ] && echo said"#,
		"status 1\nsaid\n",
	),
	(
		"/dev/fd/900, the shell reads the FIFO",
		r#"/bin/sh -c 'echo ran' > "$D/fifo" 2> "$D/err" 3< /dev/fd/900 & exec 5< "$D/fifo"; cat <&5; exec 5<&-; wait $!; echo "status $?""#,
		"status 1\n",
	),
	(
		"a target of two words",
		r#"two='a b'; /bin/sh -c 'echo ran' > "$D/fifo" 2> "$D/err" 3> $two & cat "$D/fifo"; wait $!; echo "status $?"; sed -e 's/^.*line [0-9]*: //' -e "s#^$0: ##" "$D/err""#,
		"status 1\n$two: ambiguous redirect\n",
	),
	(
		"a word after it, not expanded",
		r#"unset x; /bin/sh -c 'echo ran' > "$D/fifo" 2> "$D/err" 3<&900 4> "$D/${x:?a later word was expanded}" & cat "$D/fifo"; wait $!; echo "status $?""#,
		"status 1\n",
	),
	(
		"a missing file (control)",
		r#"/bin/sh -c 'echo ran' > "$D/fifo" 2> "$D/err" 3< "$D/missing" & cat "$D/fifo"; wait $!; echo "status $?"; sed -e 's/^.*line [0-9]*: //' -e "s#^$0: ##" -e "s#$D/##" "$D/err""#,
		"status 1\nmissing: No such file or directory\n",
	),
];

/// Each row runs once under obash and up to three times under bash
/// ([`run_row_as`]): on macOS, bash 5.3.20 now and then never ends on the row
/// where the shell reads the FIFO itself (run alone, 8 at once: 265 of 4,000
/// runs; obash and bash 3.2: none of 4,000; the same row with the child
/// ending 1 s later: none of 400). bash 4.2 and later restarts an `open`
/// that `SIGCHLD` interrupts, and macOS's FIFO open, though its writer woke
/// it, returns to be restarted when a signal is pending: when the child has
/// already ended, the open waits again for a writer that is gone.
#[test]
fn a_redirection_the_child_fails_after_its_fifo_open_lets_the_reader_end() {
	let mut wrong = Vec::new();
	for (name, shell) in shells() {
		for (row, script, want) in FAILS {
			if let Err(e) = run_row_as(name, &shell, script, want) {
				wrong.push(format!("{name} {row}: {e}"));
			}
		}
	}
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// `/dev/fd/N` names the shell's fd N, which the engine reads as a dup of
/// N. When N is one of the host's own descriptors and no fd of the shell,
/// a deferred spawn's redirection fails with `EBADF`, as for a closed fd:
/// the process fails it after its FIFO open, so it never takes the host's
/// object, and the FIFO's reader still gets end of file. obash only: bash
/// has no host descriptors besides its own fds. Linux only: the script finds
/// a host descriptor in `/proc/$$/fd`, which macOS lacks, and its
/// `/dev/fd/N` names the shell's own fd N, not the host's.
#[cfg(target_os = "linux")]
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
/bin/sh -c 'cat <&3 > "$D/host.out"' > "$D/fifo" 2> "$D/host.err" 3< "/dev/fd/$n" &
cat "$D/fifo"
wait $!
echo "host $?"
/bin/sh -c 'cat <&3 > "$D/closed.out"' > "$D/fifo" 2> "$D/closed.err" 3< /dev/fd/900 &
cat "$D/fifo"
wait $!
echo "closed $?"
for f in host.out closed.out; do [ -e "$D/$f" ] && echo "$f ran" || echo "$f none"; done
sed -e "s#/dev/fd/$n#/dev/fd/N#" -e "s/line [0-9]*:/line L:/" "$D/host.err"
sed -e "s#/dev/fd/900#/dev/fd/N#" -e "s/line [0-9]*:/line L:/" "$D/closed.err"
"#;

#[cfg(target_os = "linux")]
#[test]
fn a_dev_fd_redirection_naming_a_host_descriptor_fails_as_a_closed_fd() {
	let out = run(pty_support::obash(), DEV_FD)
		.unwrap_or_else(|e| panic!("the redirection of a host descriptor: {e}"));
	let got = String::from_utf8_lossy(&out.stdout);
	let lines: Vec<&str> = got.lines().collect();
	assert!(out.status.success(), "{got:?} {:?}", String::from_utf8_lossy(&out.stderr));
	assert_eq!(
		lines.get(..4),
		Some(&["host 1", "closed 1", "host.out none", "closed.out none"][..]),
		"a process ran, or its status is not the failed redirection's: {got:?}"
	);
	assert_eq!(lines.len(), 6, "{got:?}");
	assert_eq!(lines[4], lines[5], "the same failure as a closed fd: {got:?}");
	assert!(lines[4].ends_with("Bad file descriptor"), "{got:?}");
}
