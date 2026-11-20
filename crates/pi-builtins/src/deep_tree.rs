//! Removing a test's deep directory tree without one descriptor per level.
//!
//! `tempfile::TempDir`'s drop calls `std::fs::remove_dir_all`, which keeps one
//! descriptor open per level. For the chains of about 2,000 levels that find's
//! and du's deep-walk tests build, that was about 2,000 descriptors at once: in
//! libtest's one shared process other tests then failed with "Too many open
//! files", and under a lower limit the drop failed, silently, and left the
//! chain behind. The tests remove their chains through the host filesystem's
//! `remove_dir_all`, which keeps at most three open (pi-vfs's `remove_tree`).

use std::path::PathBuf;

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

/// Makes the directory `top` and a chain of `depth` directories `d` below
/// it, with a file `f` at each level that holds the level's number.
pub(crate) fn file_chain(top: &std::path::Path, depth: usize) {
	let mut path = top.to_path_buf();
	std::fs::create_dir(&path).unwrap();
	for level in 0..depth {
		std::fs::write(path.join("f"), level.to_string()).unwrap();
		path.push("d");
		std::fs::create_dir(&path).unwrap();
	}
}

/// Asserts that `copy` holds what [`file_chain`] made: each level's file,
/// and nothing below the last level.
pub(crate) fn assert_file_chain(copy: &std::path::Path, depth: usize) {
	let mut path = copy.to_path_buf();
	for level in 0..depth {
		assert_eq!(std::fs::read_to_string(path.join("f")).unwrap(), level.to_string(), "level {level}");
		path.push("d");
	}
	assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0, "the last level is empty");
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
		let mut path = root.join("deep");
		fs::create_dir(&path).unwrap();
		for _ in 0..depth {
			fs::write(path.join("f"), b"x").unwrap();
			path.push("d");
			fs::create_dir(&path).unwrap();
		}
	}

	/// Under an open-file limit of 32 the host filesystem removes a chain of
	/// 1,000 levels, where `std::fs::remove_dir_all` runs out of descriptors
	/// and leaves the chain behind. It runs in a process of its own, since the
	/// limit belongs to the whole process.
	#[test]
	fn removes_a_chain_deeper_than_the_descriptor_limit() {
		if !crate::own_process::own_process() {
			return;
		}
		let ours = tempfile::tempdir().unwrap();
		chain(ours.path(), 1_000);
		let stds = tempfile::tempdir().unwrap();
		chain(stds.path(), 1_000);
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
