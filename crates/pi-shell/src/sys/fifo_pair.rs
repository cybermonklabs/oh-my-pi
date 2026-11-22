//! macOS: a pipe with private open file descriptions, made as a FIFO.
//!
//! On macOS `/dev/fd/N` duplicates the descriptor and shares its
//! description, so a second description of an anonymous pipe's end cannot be
//! opened. A FIFO can be opened as often as one likes: [`fifo_descriptions`]
//! makes one in a private directory, opens it four times and removes it, so
//! the pipe lives on only in those four open file descriptions.
//!
//! After `mkdtemp`, the directory is opened without following a symbolic
//! link and checked to be ours with no access for anyone else, and each end
//! is opened through that descriptor, without following a symbolic link, and
//! checked to be the FIFO made there. Where another user can rename entries
//! of the temporary directory, a directory or a `pipe` they put in place of
//! ours is refused, not opened.

use std::{
	ffi::{CStr, CString, OsString},
	fs, io,
	mem::MaybeUninit,
	os::{
		fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
		unix::ffi::{OsStrExt, OsStringExt},
	},
	path::{Path, PathBuf},
};

/// The FIFO's name in its directory.
const NAME: &CStr = c"pipe";

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
	let dir_path = PathBuf::from(OsString::from_vec(name));
	let opened = private_dir(&dir_path).and_then(|dir| {
		let ends = fifo_ends(&dir, &dir_path.join("pipe"));
		// SAFETY: a descriptor we own and a NUL-terminated name.
		unsafe { libc::unlinkat(dir.as_raw_fd(), NAME.as_ptr(), 0) };
		ends
	});
	let _ = fs::remove_dir(&dir_path);
	opened
}

/// The directory at `path`, opened without following a symbolic link and
/// checked to be a directory of ours that no one else can enter.
fn private_dir(path: &Path) -> io::Result<OwnedFd> {
	let c = CString::new(path.as_os_str().as_bytes())?;
	// SAFETY: a NUL-terminated path; the new descriptor is owned below.
	let fd = unsafe {
		libc::open(
			c.as_ptr(),
			libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
		)
	};
	if fd < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `open` returned a new descriptor that nothing else owns.
	let dir = unsafe { OwnedFd::from_raw_fd(fd) };
	let st = fstat(dir.as_raw_fd())?;
	// SAFETY: geteuid cannot fail.
	let me = unsafe { libc::geteuid() };
	if st.st_mode & libc::S_IFMT != libc::S_IFDIR || st.st_uid != me || st.st_mode & 0o077 != 0 {
		return Err(io::Error::new(
			io::ErrorKind::PermissionDenied,
			format!("{}: not a private directory of ours", path.display()),
		));
	}
	Ok(dir)
}

/// The four ends of a FIFO made at `path`, whose directory is `dir`: each
/// opened through `dir` and checked to be that FIFO ([`open_end`]).
fn fifo_ends(dir: &OwnedFd, path: &Path) -> io::Result<[fs::File; 4]> {
	let c = CString::new(path.as_os_str().as_bytes())?;
	// SAFETY: a NUL-terminated path.
	if unsafe { libc::mkfifo(c.as_ptr(), 0o600) } < 0 {
		return Err(io::Error::last_os_error());
	}
	let mut made = MaybeUninit::<libc::stat>::uninit();
	// SAFETY: fstatat fills `made` for a name in a directory we hold open.
	if unsafe {
		libc::fstatat(dir.as_raw_fd(), NAME.as_ptr(), made.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW)
	} < 0
	{
		return Err(io::Error::last_os_error());
	}
	// SAFETY: filled by the successful call.
	let made = unsafe { made.assume_init() };
	// The shell's read end first: a FIFO's non-blocking read open needs no
	// writer, and every write open after it finds a reader (one with none
	// fails with `ENXIO`).
	let ours_read = open_end(dir, &made, libc::O_RDONLY)?;
	let ours_write = open_end(dir, &made, libc::O_WRONLY)?;
	let theirs_read = blocking(open_end(dir, &made, libc::O_RDONLY)?)?;
	let theirs_write = blocking(open_end(dir, &made, libc::O_WRONLY)?)?;
	Ok([ours_read, ours_write, theirs_read, theirs_write])
}

/// `pipe` in `dir`, opened non-blocking with `access`, without following a
/// symbolic link, and checked to be the FIFO `made` describes (same device
/// and inode).
fn open_end(dir: &OwnedFd, made: &libc::stat, access: libc::c_int) -> io::Result<fs::File> {
	let flags = access | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC;
	// SAFETY: a descriptor we own and a NUL-terminated name; the new
	// descriptor is owned below.
	let fd = unsafe { libc::openat(dir.as_raw_fd(), NAME.as_ptr(), flags) };
	if fd < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `openat` returned a new descriptor that nothing else owns.
	let file = unsafe { fs::File::from_raw_fd(fd) };
	let st = fstat(file.as_raw_fd())?;
	if st.st_mode & libc::S_IFMT != libc::S_IFIFO
		|| st.st_dev != made.st_dev
		|| st.st_ino != made.st_ino
	{
		return Err(io::Error::new(
			io::ErrorKind::PermissionDenied,
			"pipe: not the FIFO made for the pipe",
		));
	}
	Ok(file)
}

/// The status of the open descriptor `fd`.
fn fstat(fd: RawFd) -> io::Result<libc::stat> {
	let mut st = MaybeUninit::<libc::stat>::uninit();
	// SAFETY: fstat fills `st` for an open descriptor.
	if unsafe { libc::fstat(fd, st.as_mut_ptr()) } < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: filled by the successful call.
	Ok(unsafe { st.assume_init() })
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
	use std::{
		io::{Read, Write},
		os::unix::fs::{OpenOptionsExt, PermissionsExt},
	};

	use super::*;

	fn status(file: &fs::File) -> i32 {
		// SAFETY: F_GETFL only reads the flags of a descriptor the file owns.
		unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) }
	}

	fn cloexec(file: &fs::File) -> bool {
		// SAFETY: F_GETFD only reads the flags of a descriptor the file owns.
		unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) & libc::FD_CLOEXEC != 0 }
	}

	fn mkfifo(path: &Path) {
		let c = CString::new(path.as_os_str().as_bytes()).unwrap();
		// SAFETY: a NUL-terminated path.
		assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo {}", path.display());
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

	// Failure mode: the directory is opened through a symbolic link put in
	// its place, or is one that someone else can enter, so another user's
	// `pipe` could be opened in it.
	#[test]
	fn only_a_private_directory_of_ours_is_taken() {
		let tmp = tempfile::tempdir().unwrap();
		let dir = tmp.path().join("d");
		fs::create_dir(&dir).unwrap();
		fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
		assert!(private_dir(&dir).is_ok(), "ours, mode 0700");
		let link = tmp.path().join("link");
		std::os::unix::fs::symlink(&dir, &link).unwrap();
		assert!(private_dir(&link).is_err(), "a symbolic link to it is refused");
		fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
		let err = private_dir(&dir).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "others can enter: {err}");
	}

	// Failure mode: an end is opened through a symbolic link, or is a file
	// other than the FIFO made (put in its place), so the pump writes into,
	// or the shell reads from, what another user chose.
	#[test]
	fn an_end_that_is_not_the_fifo_made_is_refused() {
		let tmp = tempfile::tempdir().unwrap();
		let dir_path = tmp.path().join("d");
		fs::create_dir(&dir_path).unwrap();
		fs::set_permissions(&dir_path, fs::Permissions::from_mode(0o700)).unwrap();
		let dir = private_dir(&dir_path).unwrap();
		let other = tmp.path().join("other");
		mkfifo(&other);
		let stat_of = |path: &Path| {
			let file = fs::OpenOptions::new()
				.read(true)
				.custom_flags(libc::O_NONBLOCK)
				.open(path)
				.unwrap();
			fstat(file.as_raw_fd()).unwrap()
		};
		let made = stat_of(&other);
		let pipe = dir_path.join("pipe");
		// A symbolic link to the very FIFO `made` describes.
		std::os::unix::fs::symlink(&other, &pipe).unwrap();
		assert!(open_end(&dir, &made, libc::O_RDONLY).is_err(), "a symbolic link is not followed");
		fs::remove_file(&pipe).unwrap();
		// Another FIFO in its place.
		mkfifo(&pipe);
		let err = open_end(&dir, &made, libc::O_RDONLY).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "another FIFO: {err}");
		fs::remove_file(&pipe).unwrap();
		// A regular file in its place.
		fs::write(&pipe, b"x").unwrap();
		let err = open_end(&dir, &made, libc::O_RDONLY).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "a regular file: {err}");
		fs::remove_file(&pipe).unwrap();
		// The FIFO itself, put back under its name, opens.
		fs::rename(&other, &pipe).unwrap();
		assert!(open_end(&dir, &made, libc::O_RDONLY).is_ok(), "the FIFO made opens");
	}
}
