//! Where an external command's standard streams go under redirections,
//! measured against Bash 5.2.21 and 5.3.0 running each script with `bash -c`
//! (the bash tool runs a command string). Each script runs through
//! [`Shell::run`] in a fresh directory.

#![cfg(unix)]

use std::fmt::Write as _;

use super::*;

/// One script and what Bash leaves behind.
struct Row {
	script: &'static str,
	/// FIFOs to create before the run.
	fifos:  &'static [&'static str],
	/// Everything the run writes, with each `NAME: line N: ` prefix removed.
	output: &'static str,
	status: i32,
	/// Files and their contents (prefixes removed); `None`: must not exist.
	files:  &'static [(&'static str, Option<&'static str>)],
}

/// Removes the `NAME: line N: ` prefix Bash and the shell put on their own
/// diagnostics, whose `NAME` differs between them.
fn strip_prefixes(text: &str) -> String {
	text
		.split_inclusive('\n')
		.map(|line| {
			let Some(at) = line.find(": line ") else {
				return line;
			};
			let rest = &line[at + ": line ".len()..];
			let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
			match rest[digits..].strip_prefix(": ") {
				Some(body) if digits > 0 && !line[..at].contains(' ') => body,
				_ => line,
			}
		})
		.collect()
}

async fn check(rows: &[Row]) {
	let mut failures = Vec::new();
	for row in rows {
		let dir = tempfile::tempdir().expect("temp dir");
		for fifo in row.fifos {
			let path =
				std::ffi::CString::new(dir.path().join(fifo).into_os_string().into_encoded_bytes())
					.expect("path");
			// SAFETY: `path` is a NUL-terminated string that outlives the call.
			assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0, "mkfifo {fifo}");
		}
		let (tx, rx) = flume::unbounded::<String>();
		let result = Shell::new(None)
			.run(
				ShellRunOptions {
					command: row.script.to_owned(),
					cwd: Some(dir.path().to_string_lossy().into_owned()),
					..Default::default()
				},
				Some(tx),
				CancelToken::new(Some(10_000)),
			)
			.await
			.expect("run");
		let output = strip_prefixes(&rx.drain().collect::<String>());
		let mut got =
			format!("status {:?} timed_out {}\n{output}", result.exit_code, result.timed_out);
		let mut want = format!("status {:?} timed_out false\n{}", Some(row.status), row.output);
		for (name, contents) in row.files {
			let read = std::fs::read_to_string(dir.path().join(name)).ok();
			let _ = writeln!(got, "-- {name}: {:?}", read.as_deref().map(strip_prefixes));
			let _ = writeln!(want, "-- {name}: {:?}", contents.map(str::to_owned));
		}
		if got != want {
			failures.push(format!("`{}`\n  want: {want:?}\n  got:  {got:?}", row.script));
		}
	}
	assert!(
		failures.is_empty(),
		"{} of {} rows differ from Bash:\n{}",
		failures.len(),
		rows.len(),
		failures.join("\n")
	);
}

/// An external command gets a standard descriptor the script closed, or any
/// other descriptor it closed, closed, as in Bash, not the null device: a
/// write to it fails.
///
/// Each row turns the command's status into a word of its own, because the
/// message and the status of a failed write belong to whichever shell
/// `/bin/sh` is (dash gives 2 for a closed stderr, Bash gives 1); what the
/// rows pin is the contract both report: the write fails, the command says
/// so, and the text never reaches the host's own stream or a file.
#[tokio::test(flavor = "multi_thread")]
async fn a_closed_descriptor_stays_closed_in_an_external_command() {
	check(&[
		Row {
			script: "/bin/sh -c 'echo LEAKED >&2' 2>&-; if [ $? -ne 0 ]; then echo closed; fi",
			fifos:  &[],
			output: "closed\n",
			status: 0,
			files:  &[],
		},
		Row {
			script: "/bin/sh -c 'echo LEAKED' >&- 2>e; if [ $? -ne 0 ]; then echo closed; fi; if [ \
			         -s e ]; then echo diagnosed; fi; if grep -q LEAKED e; then echo leaked; fi",
			fifos:  &[],
			output: "closed\ndiagnosed\n",
			status: 0,
			files:  &[],
		},
		Row {
			script: "{ /bin/sh -c 'echo X >&5' 5>&- 2>e; if [ $? -ne 0 ]; then echo closed; fi; } 5>f",
			fifos:  &[],
			output: "closed\n",
			status: 0,
			files:  &[("f", Some(""))],
		},
		// A background command whose FIFO open its own process makes.
		Row {
			script: "/bin/sh -c 'echo LEAKED >&2; if [ $? -ne 0 ]; then echo closed; fi' 2>&- >f & \
			         /bin/cat f; wait $!; echo s=$?",
			fifos:  &["f"],
			output: "closed\ns=0\n",
			status: 0,
			files:  &[],
		},
	])
	.await;
}

/// A text file the kernel refuses with `ENOEXEC` runs as a script, and its
/// commands still find the descriptor the caller closed closed.
///
/// This is where the shell leaves Bash on purpose. Bash 5.2.21 and 5.3.0
/// both recover by starting a shell on the file, and the `open` of the file
/// lands on the lowest free descriptor — descriptor 2 when the caller wrote
/// `2>&-`. Bash leaves it there, so the script's own commands are handed a
/// readable descriptor onto the script's text (`readlink /proc/self/fd/2`
/// in the child names the script). The shell reads the file through the
/// host instead and has no such descriptor, so the slot stays closed, which
/// is what the caller asked for and what every other closed-descriptor row
/// gets. The visible difference is small and in the caller's favour: a
/// failing write to descriptor 2 inside such a script ends the command with
/// the status its shell gives a failed `dup` (2 in dash) instead of the
/// status it gives a failed `write` (1).
#[tokio::test(flavor = "multi_thread")]
async fn a_closed_descriptor_stays_closed_in_a_script_the_kernel_refused() {
	check(&[Row {
		script: "printf '%s\\n' \"/bin/sh -c 'exec 9>&2'\" 'if [ $? -ne 0 ]; then echo fd2-closed; \
		         else echo fd2-open; fi' > sc; chmod +x sc; ./sc 2>&- > out",
		fifos:  &[],
		output: "",
		status: 0,
		files:  &[("out", Some("fd2-closed\n"))],
	}])
	.await;
}

/// A command whose redirection open waits (a FIFO: the process applies its
/// redirections itself) gets the host process's descriptors that have no
/// close-on-exec, as bash's children and this shell's other spawns do: a
/// make jobserver's pipe the host inherited reaches `make > out 9> fifo &`
/// as it reaches `make`. And `/dev/fd/N` naming such a host descriptor, which
/// is no descriptor of the script, fails as `3<&N` does: the process never
/// takes the host's object through it.
#[tokio::test(flavor = "multi_thread")]
async fn a_deferred_command_keeps_the_hosts_inherited_fds_but_takes_none_by_dev_fd() {
	use std::{
		io::Write as _,
		os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd},
	};

	let dir = tempfile::tempdir().expect("temp dir");
	let fifo = std::ffi::CString::new(
		dir.path()
			.join("fifo")
			.into_os_string()
			.into_encoded_bytes(),
	)
	.expect("path");
	// SAFETY: `fifo` is a NUL-terminated string that outlives the call.
	assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0, "mkfifo");
	// The host's descriptor: a pipe's read end without close-on-exec, at 50
	// or above, holding a line; its write end is closed, so a read ends.
	let (read, mut write) = std::io::pipe().expect("pipe");
	write.write_all(b"HOST-ONLY\n").expect("write");
	drop(write);
	// SAFETY: F_DUPFD makes a new descriptor of `read`'s pipe without
	// close-on-exec.
	let n = unsafe { libc::fcntl(read.as_raw_fd(), libc::F_DUPFD, 50) };
	assert!(n >= 50, "F_DUPFD: {}", std::io::Error::last_os_error());
	// SAFETY: `n` is a new descriptor nothing else owns.
	let host = unsafe { OwnedFd::from_raw_fd(n) };
	drop(read);
	let script = format!(
		"exec 7<> fifo
/bin/sh -c 'if [ -e /dev/fd/{n} ]; then echo has; else echo none; fi > kept' > fifo &
wait
/bin/sh -c 'cat <&3 > took' > fifo 3< /dev/fd/{n} &
wait
cat kept; if [ -e took ]; then echo took; cat took; else echo refused; fi"
	);
	let (tx, rx) = flume::unbounded::<String>();
	let result = Shell::new(None)
		.run(
			ShellRunOptions {
				command: script,
				cwd: Some(dir.path().to_string_lossy().into_owned()),
				..Default::default()
			},
			Some(tx),
			CancelToken::new(Some(10_000)),
		)
		.await
		.expect("run");
	drop(host);
	let output = strip_prefixes(&rx.drain().collect::<String>());
	assert!(!result.timed_out, "{output}");
	let lines: Vec<&str> = output
		.lines()
		.filter(|l| !l.ends_with("Bad file descriptor"))
		.collect();
	assert_eq!(
		lines,
		["has", "refused"],
		"an inherited fd did not reach the process, or /dev/fd/{n} took the host's object: \
		 {output:?}"
	);
	assert!(
		output
			.lines()
			.any(|l| l.ends_with(&format!("/dev/fd/{n}: Bad file descriptor"))),
		"/dev/fd/{n} was not refused as a closed fd: {output:?}"
	);
}
