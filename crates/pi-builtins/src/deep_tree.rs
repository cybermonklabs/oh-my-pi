//! A test's deep directory trees: built, checked and removed level by level
//! through descriptors, never by path.
//!
//! `tempfile::TempDir`'s drop calls `std::fs::remove_dir_all`, which keeps one
//! descriptor open per level. For the chains of about 2,000 levels that find's
//! and du's deep-walk tests build, that was about 2,000 descriptors at once: in
//! libtest's one shared process other tests then failed with "Too many open
//! files", and under a lower limit the drop failed, silently, and left the
//! chain behind. The tests remove their chains through the host filesystem's
//! `remove_dir_all`, which keeps at most three open (pi-vfs's `remove_tree`).
//!
//! Building or checking a chain by path looks every component up again at
//! every level, so the cost grows with the square of the depth, and gVisor
//! (GKE Sandbox) makes each lookup slow: creating 2,000 levels took about
//! 9 seconds there, and checking 1,500 about 5. A [`Level`] opens each
//! level relative to the one above.

use std::path::PathBuf;

/// Where a deep test makes its trees: Bazel's per-test `TEST_TMPDIR` when it
/// is set, else the system's temporary directory. `TEST_TMPDIR` lies below
/// the test's sandbox directory, which Bazel removes, also after it kills the
/// test; under the process-wrapper sandbox `/tmp` is the host's, where a
/// killed test's tree would stay. A Bazel 9.2.0 server that removed a chain
/// of 1,215 levels left in its sandbox died (exit 37; it survived 1,205), so
/// every chain a test builds stays far shorter.
pub(crate) fn temp_root() -> PathBuf {
	std::env::var_os("TEST_TMPDIR")
		.map(PathBuf::from)
		.filter(|dir| dir.is_dir())
		.unwrap_or_else(std::env::temp_dir)
}

/// A temporary directory under [`temp_root`], removed on drop.
pub(crate) fn tempdir() -> tempfile::TempDir {
	tempfile::tempdir_in(temp_root()).unwrap()
}

/// Removes the directory `0` and everything below it when dropped, through the
/// native filesystem's `remove_dir_all`. Declare it after the `TempDir` that
/// holds the directory, so it drops first, also when the test fails.
pub(crate) struct RemoveTree(pub(crate) PathBuf);

impl Drop for RemoveTree {
	fn drop(&mut self) {
		let removed = pi_vfs::BlockingFs::native().remove_dir_all(&self.0);
		if !std::thread::panicking() {
			match removed {
				Ok(()) => {},
				Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
				Err(error) => panic!("removing {}: {error}", self.0.display()),
			}
		}
	}
}

/// A directory open by descriptor, one level of a chain.
#[cfg(unix)]
pub(crate) struct Level(std::os::fd::OwnedFd);

#[cfg(unix)]
impl Level {
	/// Opens the directory at `path`.
	pub(crate) fn open(path: &std::path::Path) -> Self {
		use std::os::unix::ffi::OsStrExt as _;
		Self(open_at(libc::AT_FDCWD, path.as_os_str().as_bytes(), libc::O_RDONLY | libc::O_DIRECTORY))
	}

	/// Makes the subdirectory `name` and opens it.
	pub(crate) fn make_dir(&self, name: &str) -> Self {
		use std::os::fd::AsRawFd as _;
		let c_name = std::ffi::CString::new(name).unwrap();
		// SAFETY: `c_name` is NUL-terminated and outlives the call.
		let made = unsafe { libc::mkdirat(self.0.as_raw_fd(), c_name.as_ptr(), 0o755) };
		assert_eq!(made, 0, "mkdirat {name}: {}", std::io::Error::last_os_error());
		self.dir(name)
	}

	/// Opens the subdirectory `name`, refusing a symbolic link.
	pub(crate) fn dir(&self, name: &str) -> Self {
		use std::os::fd::AsRawFd as _;
		Self(open_at(self.0.as_raw_fd(), name.as_bytes(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW))
	}

	/// Writes the new file `name`.
	pub(crate) fn write(&self, name: &str, contents: &[u8]) {
		use std::{io::Write as _, os::fd::AsRawFd as _};
		let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW;
		std::fs::File::from(open_at(self.0.as_raw_fd(), name.as_bytes(), flags)).write_all(contents).unwrap();
	}

	/// The contents of the file `name`.
	pub(crate) fn read(&self, name: &str) -> Vec<u8> {
		use std::{io::Read as _, os::fd::AsRawFd as _};
		let mut contents = Vec::new();
		let flags = libc::O_RDONLY | libc::O_NOFOLLOW;
		std::fs::File::from(open_at(self.0.as_raw_fd(), name.as_bytes(), flags))
			.read_to_end(&mut contents)
			.unwrap();
		contents
	}
}

/// `openat(at, name, flags)`, with a mode of 0644 for a created file.
#[cfg(unix)]
fn open_at(at: libc::c_int, name: &[u8], flags: libc::c_int) -> std::os::fd::OwnedFd {
	use std::os::fd::FromRawFd as _;
	let c_name = std::ffi::CString::new(name).unwrap();
	let mode: libc::c_uint = 0o644;
	// SAFETY: `c_name` is NUL-terminated and outlives the call; `mode` only
	// counts when `flags` create the file.
	let fd = unsafe { libc::openat(at, c_name.as_ptr(), flags | libc::O_CLOEXEC, mode) };
	assert!(fd >= 0, "openat {}: {}", String::from_utf8_lossy(name), std::io::Error::last_os_error());
	// SAFETY: `openat` returned a fresh descriptor owned from here.
	unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) }
}

/// Makes the directory `top` and a chain of `depth` directories `d` below
/// it, with a file `f` at each level that holds the level's number.
#[cfg(unix)]
pub(crate) fn file_chain(top: &std::path::Path, depth: usize) {
	std::fs::create_dir(top).unwrap();
	let mut level = Level::open(top);
	for number in 0..depth {
		level.write("f", number.to_string().as_bytes());
		level = level.make_dir("d");
	}
}

/// Asserts that `copy` holds what [`file_chain`] made: each level's file,
/// and nothing below the last level.
#[cfg(unix)]
pub(crate) fn assert_file_chain(copy: &std::path::Path, depth: usize) {
	let mut level = Level::open(copy);
	for number in 0..depth {
		assert_eq!(level.read("f"), number.to_string().as_bytes(), "level {number}");
		level = level.dir("d");
	}
	let last: PathBuf = (0..depth).fold(copy.to_path_buf(), |path, _| path.join("d"));
	assert_eq!(std::fs::read_dir(last).unwrap().count(), 0, "the last level is empty");
}

/// Makes the directory `top` and a chain of `depth` directories `d` below
/// it, nothing else. Through descriptors on Unix, by path elsewhere.
pub(crate) fn dir_chain(top: &std::path::Path, depth: usize) {
	#[cfg(unix)]
	{
		std::fs::create_dir(top).unwrap();
		let mut level = Level::open(top);
		for _ in 0..depth {
			level = level.make_dir("d");
		}
	}
	#[cfg(not(unix))]
	std::fs::create_dir_all((0..depth).fold(top.to_path_buf(), |path, _| path.join("d"))).unwrap();
}

/// Lowers the open-file limit of this process to `limit`. The limit belongs
/// to the whole process, so the caller runs in a process of its own.
#[cfg(unix)]
pub(crate) fn limit_descriptors(limit: libc::rlim_t) {
	let mut old = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
	// SAFETY: a plain getrlimit and setrlimit of this process, which no other
	// test shares.
	assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut old) }, 0);
	let new = libc::rlimit { rlim_cur: limit, rlim_max: old.rlim_max };
	assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raw const new) }, 0);
}

#[cfg(unix)]
mod tests {
	use std::{fs, path::Path};

	/// A chain of `depth` directories `d` below `root/deep`, a file at each
	/// level.
	fn chain(root: &Path, depth: usize) {
		super::file_chain(&root.join("deep"), depth);
	}

	/// Under an open-file limit of 32 the host filesystem removes a chain of
	/// 100 levels, where `std::fs::remove_dir_all` runs out of descriptors
	/// and leaves the chain behind. It runs in a process of its own, since the
	/// limit belongs to the whole process.
	#[test]
	fn removes_a_chain_deeper_than_the_descriptor_limit() {
		if !crate::own_process::own_process() {
			return;
		}
		let ours = super::tempdir();
		chain(ours.path(), 100);
		let stds = super::tempdir();
		chain(stds.path(), 100);
		let limit = libc::rlimit { rlim_cur: 32, rlim_max: 32 };
		// SAFETY: a plain setrlimit of this process, which no other test shares.
		assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raw const limit) }, 0);

		let std_removal = fs::remove_dir_all(stds.path().join("deep"));
		assert_eq!(std_removal.map_err(|e| e.raw_os_error()), Err(Some(libc::EMFILE)), "the premise");
		assert!(stds.path().join("deep").exists());

		let host = pi_vfs::BlockingFs::native();
		host.remove_dir_all(ours.path().join("deep")).unwrap();
		assert!(!ours.path().join("deep").exists());
		host.remove_dir_all(stds.path().join("deep")).unwrap();
		assert!(!stds.path().join("deep").exists());
	}
}
