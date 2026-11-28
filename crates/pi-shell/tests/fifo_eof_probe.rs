//! Diagnostic only (scratch/caught-signal-hang-probe, INFRA-5336): does a
//! `cat` blocked in `read(2)` on a FIFO wake with end of file when the
//! FIFO's last write description closes? One test per way of opening the
//! FIFO's descriptions; each passes when `cat` ends within 5 s of the last
//! writer's close, and fails (after killing it) when it does not.
#![cfg(unix)]

use std::{
	ffi::CString,
	fs,
	os::{fd::AsRawFd, unix::ffi::OsStrExt},
	path::Path,
	process::{Child, Command, Stdio},
	time::{Duration, Instant},
};

fn mkfifo(path: &Path) {
	let c = CString::new(path.as_os_str().as_bytes()).unwrap();
	// SAFETY: a NUL-terminated path.
	assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo");
}

fn open(path: &Path, flags: libc::c_int) -> fs::File {
	use std::os::fd::FromRawFd;
	let c = CString::new(path.as_os_str().as_bytes()).unwrap();
	// SAFETY: a NUL-terminated path; the descriptor is owned below.
	let fd = unsafe { libc::open(c.as_ptr(), flags | libc::O_CLOEXEC) };
	assert!(fd >= 0, "open {flags:#x}: {}", std::io::Error::last_os_error());
	// SAFETY: a new descriptor nothing else owns.
	unsafe { fs::File::from_raw_fd(fd) }
}

/// `file` with `O_NONBLOCK` cleared, as obash's `fifo_pair::blocking` does.
fn blocking(file: fs::File) -> fs::File {
	let fd = file.as_raw_fd();
	// SAFETY: fcntl on a descriptor we own.
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
	// SAFETY: as above.
	assert!(unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) } == 0);
	file
}

fn cat_reading(stdin: fs::File) -> Child {
	let child = Command::new("/bin/cat")
		.stdin(Stdio::from(stdin))
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.expect("cat");
	// Long enough for cat to be in read(2) (diagnostic only).
	std::thread::sleep(Duration::from_millis(500));
	child
}

/// Whether `child` ends within 5 s; killed and reaped if not.
fn ends(mut child: Child) -> bool {
	let deadline = Instant::now() + Duration::from_secs(5);
	while Instant::now() < deadline {
		if child.try_wait().unwrap().is_some() {
			return true;
		}
		std::thread::sleep(Duration::from_millis(10));
	}
	let _ = child.kill();
	let _ = child.wait();
	false
}

/// Control: an anonymous pipe. cat must see end of file.
#[test]
fn p0_anonymous_pipe_control() {
	let (r, w) = std::io::pipe().unwrap();
	let cat = cat_reading(fs::File::from(std::os::fd::OwnedFd::from(r)));
	drop(w);
	assert!(ends(cat), "cat not woken at the pipe's last writer close");
}

/// obash's feed on macOS (fifo_descriptions): ours_read and ours_write
/// non-blocking, theirs_read and theirs_write opened non-blocking then made
/// blocking, theirs_write closed, cat reads theirs_read, then ours_write and
/// ours_read close (the shell's end).
#[test]
fn p1_obash_feed_pattern() {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("pipe");
	mkfifo(&path);
	let ours_read = open(&path, libc::O_RDONLY | libc::O_NONBLOCK);
	let ours_write = open(&path, libc::O_WRONLY | libc::O_NONBLOCK);
	let theirs_read = blocking(open(&path, libc::O_RDONLY | libc::O_NONBLOCK));
	let theirs_write = blocking(open(&path, libc::O_WRONLY | libc::O_NONBLOCK));
	drop(theirs_write);
	fs::remove_file(&path).unwrap();
	let cat = cat_reading(theirs_read);
	drop(ours_write);
	drop(ours_read);
	assert!(ends(cat), "cat not woken at the FIFO's last writer close");
}

/// p1 with the drain (ours_read) still open after the writer closes.
#[test]
fn p2_obash_feed_pattern_drain_kept() {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("pipe");
	mkfifo(&path);
	let ours_read = open(&path, libc::O_RDONLY | libc::O_NONBLOCK);
	let ours_write = open(&path, libc::O_WRONLY | libc::O_NONBLOCK);
	let theirs_read = blocking(open(&path, libc::O_RDONLY | libc::O_NONBLOCK));
	let theirs_write = blocking(open(&path, libc::O_WRONLY | libc::O_NONBLOCK));
	drop(theirs_write);
	fs::remove_file(&path).unwrap();
	let cat = cat_reading(theirs_read);
	drop(ours_write);
	let woke = ends(cat);
	drop(ours_read);
	assert!(woke, "cat not woken at the FIFO's last writer close");
}

/// p1 without the second write description (theirs_write never opened).
#[test]
fn p3_one_write_description() {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("pipe");
	mkfifo(&path);
	let ours_read = open(&path, libc::O_RDONLY | libc::O_NONBLOCK);
	let ours_write = open(&path, libc::O_WRONLY | libc::O_NONBLOCK);
	let theirs_read = blocking(open(&path, libc::O_RDONLY | libc::O_NONBLOCK));
	let cat = cat_reading(theirs_read);
	drop(ours_write);
	drop(ours_read);
	assert!(ends(cat), "cat not woken at the FIFO's last writer close");
}

/// p1 with cat's read description opened blocking (a writer is open, so
/// the open does not wait), never non-blocking.
#[test]
fn p4_reader_opened_blocking() {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("pipe");
	mkfifo(&path);
	let ours_read = open(&path, libc::O_RDONLY | libc::O_NONBLOCK);
	let ours_write = open(&path, libc::O_WRONLY | libc::O_NONBLOCK);
	let theirs_read = open(&path, libc::O_RDONLY);
	let cat = cat_reading(theirs_read);
	drop(ours_write);
	drop(ours_read);
	assert!(ends(cat), "cat not woken at the FIFO's last writer close");
}

/// The plainest FIFO: one blocking-mode reader after one writer, no drain.
#[test]
fn p5_plain_fifo() {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("pipe");
	mkfifo(&path);
	let keep = open(&path, libc::O_RDONLY | libc::O_NONBLOCK);
	let writer = open(&path, libc::O_WRONLY | libc::O_NONBLOCK);
	let reader = open(&path, libc::O_RDONLY);
	drop(keep);
	let cat = cat_reading(reader);
	drop(writer);
	assert!(ends(cat), "cat not woken at the FIFO's last writer close");
}

/// p1, but the last writer closes before cat reads: the control that a
/// read starting with no writer sees end of file.
#[test]
fn p6_writer_gone_before_the_read() {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("pipe");
	mkfifo(&path);
	let ours_read = open(&path, libc::O_RDONLY | libc::O_NONBLOCK);
	let ours_write = open(&path, libc::O_WRONLY | libc::O_NONBLOCK);
	let theirs_read = blocking(open(&path, libc::O_RDONLY | libc::O_NONBLOCK));
	drop(ours_write);
	drop(ours_read);
	let cat = cat_reading(theirs_read);
	assert!(ends(cat), "cat not woken although no writer was open");
}

/// p1, with the writer held by a child process that exits (obash's write
/// end closes at its own exit).
#[test]
fn p7_writer_closed_by_its_process_exit() {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join("pipe");
	mkfifo(&path);
	let ours_read = open(&path, libc::O_RDONLY | libc::O_NONBLOCK);
	let ours_write = open(&path, libc::O_WRONLY | libc::O_NONBLOCK);
	let theirs_read = blocking(open(&path, libc::O_RDONLY | libc::O_NONBLOCK));
	let cat = cat_reading(theirs_read);
	let mut holder = Command::new("/bin/sleep")
		.arg("1")
		.stdin(Stdio::null())
		.stdout(Stdio::from(ours_write))
		.stderr(Stdio::null())
		.spawn()
		.expect("sleep");
	drop(ours_read);
	let _ = holder.wait();
	assert!(ends(cat), "cat not woken at the exit of the writer's last holder");
}
