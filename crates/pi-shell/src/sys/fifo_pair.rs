//! macOS: a pipe with private open file descriptions, made as a FIFO.
//!
//! On macOS `/dev/fd/N` duplicates the descriptor and shares its
//! description, so a second description of an anonymous pipe's end cannot be
//! opened. A FIFO can be opened as often as one likes: [`fifo_descriptions`]
//! makes one in a private directory, opens it four times and removes it, so
//! the pipe lives on only in those four open file descriptions.

use std::{
	ffi::{CString, OsString},
	fs, io,
	os::{
		fd::AsRawFd,
		unix::{
			ffi::{OsStrExt, OsStringExt},
			fs::OpenOptionsExt,
		},
	},
	path::{Path, PathBuf},
};

/// Four open file descriptions of a new FIFO: the shell's non-blocking
/// read and write ones, then the externals' blocking read and write ones.
/// The FIFO and its directory (mode 0700, under `tmp`) are removed before
/// this returns, whatever the outcome; the pipe lives on in its open
/// descriptions, all close-on-exec.
pub(crate) fn fifo_descriptions(tmp: &Path) -> io::Result<[fs::File; 4]> {
	let template = CString::new(tmp.join("obash-pipe.XXXXXX").as_os_str().as_bytes())?;
	let mut name = template.into_bytes_with_nul();
	// SAFETY: `name` is a NUL-terminated template that `mkdtemp` fills in
	// place.
	if unsafe { libc::mkdtemp(name.as_mut_ptr().cast()) }.is_null() {
		return Err(io::Error::last_os_error());
	}
	name.pop();
	let dir = PathBuf::from(OsString::from_vec(name));
	let fifo = dir.join("pipe");
	let opened = (|| {
		let path = CString::new(fifo.as_os_str().as_bytes())?;
		// SAFETY: a NUL-terminated path.
		if unsafe { libc::mkfifo(path.as_ptr(), 0o600) } < 0 {
			return Err(io::Error::last_os_error());
		}
		let open = |write: bool| {
			fs::OpenOptions::new()
				.read(!write)
				.write(write)
				.custom_flags(libc::O_NONBLOCK)
				.open(&fifo)
		};
		// The shell's read end first: a FIFO's non-blocking read open
		// needs no writer, and every write open after it finds a reader
		// (one with none fails with `ENXIO`).
		let ours_read = open(false)?;
		let ours_write = open(true)?;
		let theirs_read = blocking(open(false)?)?;
		let theirs_write = blocking(open(true)?)?;
		Ok([ours_read, ours_write, theirs_read, theirs_write])
	})();
	let _ = fs::remove_file(&fifo);
	let _ = fs::remove_dir(&dir);
	opened
}

/// `file` with `O_NONBLOCK` cleared on its description.
fn blocking(file: fs::File) -> io::Result<fs::File> {
	let fd = file.as_raw_fd();
	// SAFETY: fcntl on a descriptor we own, of a description only it has.
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
	// SAFETY: as above.
	if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) } < 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(file)
}

#[cfg(test)]
mod tests {
	use std::io::{Read, Write};

	use super::*;

	fn status(file: &fs::File) -> i32 {
		// SAFETY: F_GETFL only reads the flags of a descriptor the file owns.
		unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) }
	}

	fn cloexec(file: &fs::File) -> bool {
		// SAFETY: F_GETFD only reads the flags of a descriptor the file owns.
		unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) & libc::FD_CLOEXEC != 0 }
	}

	// Failure mode: an end with the wrong blocking mode (the shell's would
	// block the engine, an external's would see `EAGAIN`), or one a child
	// inherits.
	#[test]
	fn the_shells_descriptions_are_nonblocking_the_externals_blocking_all_close_on_exec() {
		let tmp = tempfile::tempdir().unwrap();
		let ends = fifo_descriptions(tmp.path()).unwrap();
		let nonblocking: Vec<bool> = ends
			.iter()
			.map(|f| status(f) & libc::O_NONBLOCK != 0)
			.collect();
		assert_eq!(nonblocking, [true, true, false, false]);
		assert!(ends.iter().all(cloexec), "every description is close-on-exec");
		let access: Vec<i32> = ends.iter().map(|f| status(f) & libc::O_ACCMODE).collect();
		assert_eq!(access, [libc::O_RDONLY, libc::O_WRONLY, libc::O_RDONLY, libc::O_WRONLY]);
	}

	// Failure mode: the four descriptions are not one pipe. Each side's bytes
	// are counted in the other side's read description (`FIONREAD`) before
	// they are read, so descriptions of another pipe fail here at once, not in
	// a blocking read that no byte reaches.
	#[test]
	fn the_four_descriptions_are_one_pipe() {
		let tmp = tempfile::tempdir().unwrap();
		let [mut ours_read, mut ours_write, mut theirs_read, mut theirs_write] =
			fifo_descriptions(tmp.path()).unwrap();
		// The bytes waiting in the pipe of `file`, a read description.
		let waiting = |file: &fs::File| {
			let mut n: libc::c_int = 0;
			// SAFETY: FIONREAD stores one int through the pointer.
			let r = unsafe { libc::ioctl(file.as_raw_fd(), libc::FIONREAD, &raw mut n) };
			assert_eq!(r, 0, "FIONREAD: {}", io::Error::last_os_error());
			usize::try_from(n).unwrap()
		};
		ours_write.write_all(b"to the externals").unwrap();
		let n = waiting(&theirs_read);
		assert_eq!(n, 16, "the shell's bytes wait in the externals' read description");
		let mut got = vec![0u8; n];
		theirs_read.read_exact(&mut got).unwrap();
		assert_eq!(got, b"to the externals");
		theirs_write.write_all(b"to the shell").unwrap();
		let n = waiting(&ours_read);
		assert_eq!(n, 12, "the externals' bytes wait in the shell's read description");
		let mut got = vec![0u8; n];
		ours_read.read_exact(&mut got).unwrap();
		assert_eq!(got, b"to the shell");
	}

	// Failure mode: the FIFO or its directory stays behind, after a success
	// or a failure.
	#[test]
	fn nothing_stays_behind() {
		let tmp = tempfile::tempdir().unwrap();
		let left = || fs::read_dir(tmp.path()).unwrap().count();
		let ends = fifo_descriptions(tmp.path()).unwrap();
		assert_eq!(left(), 0, "the FIFO and its directory are removed at once");
		drop(ends);
		assert!(fifo_descriptions(&tmp.path().join("missing")).is_err());
		assert_eq!(left(), 0, "a failure leaves nothing either");
	}
}
