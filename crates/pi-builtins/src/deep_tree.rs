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
