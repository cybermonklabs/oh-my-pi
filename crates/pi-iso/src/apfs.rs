//! macOS APFS clonefile-based isolation.
//!
//! `clonefile(2)` recursively reflinks an entire directory tree in a single
//! syscall. Both paths share the same on-disk blocks until either side is
//! modified; the kernel handles per-block copy-on-write. The destination is
//! a fully independent directory tree from the caller's perspective — there
//! is no mount to undo, so [`stop`](IsolationBackend::stop) is a recursive
//! remove.

use std::path::{Path, PathBuf};

use async_trait::async_trait;

#[cfg(not(target_os = "macos"))]
use crate::IsoError;
use crate::{BackendKind, CloneExclusions, IsoResult, IsolationBackend, ProbeResult};

pub struct ApfsBackend;

pub fn backend() -> &'static dyn IsolationBackend {
	&ApfsBackend
}

#[async_trait]
impl IsolationBackend for ApfsBackend {
	fn kind(&self) -> BackendKind {
		BackendKind::Apfs
	}

	fn probe(&self) -> ProbeResult {
		#[cfg(target_os = "macos")]
		{
			ProbeResult::available()
		}
		#[cfg(not(target_os = "macos"))]
		{
			ProbeResult::unavailable("APFS clonefile isolation is only available on macOS")
		}
	}

	fn start(&self, lower: &Path, merged: &Path) -> IsoResult<()> {
		#[cfg(target_os = "macos")]
		{
			imp::start(lower, merged)
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = (lower, merged);
			Err(IsoError::unavailable("APFS clonefile isolation is only available on macOS"))
		}
	}

	fn clone_tree(
		&self,
		lower: &Path,
		merged: &Path,
		exclusions: &CloneExclusions,
	) -> IsoResult<Vec<PathBuf>> {
		#[cfg(target_os = "macos")]
		{
			imp::clone_tree(lower, merged, exclusions)
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = (lower, merged, exclusions);
			Err(IsoError::unavailable("APFS clonefile isolation is only available on macOS"))
		}
	}

	fn stop(&self, merged: &Path) -> IsoResult<()> {
		#[cfg(target_os = "macos")]
		{
			imp::stop(merged)
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = merged;
			Ok(())
		}
	}
}

#[cfg(target_os = "macos")]
mod imp {
	use std::{
		fs,
		path::{Path, PathBuf},
	};

	use crate::{
		CloneExclusions, IsoError, IsoResult,
		cow::{self, CLONE_NOFOLLOW},
		tree,
	};

	/// Classifies a failed `clonefile` of `src` to `dst`.
	fn clone_error(src: &Path, dst: &Path, err: &std::io::Error) -> IsoError {
		if cow::is_unsupported(err) {
			return IsoError::unavailable(format!(
				"APFS clonefile unsupported on this volume ({err}); {} -> {}",
				src.display(),
				dst.display()
			));
		}
		IsoError::other(format!("clonefile {} -> {}: {err}", src.display(), dst.display()))
	}

	pub fn start(lower: &Path, merged: &Path) -> IsoResult<()> {
		let lower = tree::canonical_existing_dir(lower, "clone source", IsoError::other)?;
		if let Some(parent) = merged.parent() {
			fs::create_dir_all(parent).map_err(|err| {
				IsoError::other(format!("unable to create parent of {}: {err}", merged.display()))
			})?;
		}
		// `clonefile` refuses to overwrite. Drop any stale tree first.
		if merged.exists() {
			fs::remove_dir_all(merged).map_err(|err| {
				IsoError::other(format!("unable to clear {} before clone: {err}", merged.display()))
			})?;
		}

		// A directory source clones the whole tree in one call.
		cow::clonefile(&lower, merged, 0).map_err(|err| clone_error(&lower, merged, &err))
	}

	pub fn clone_tree(
		lower: &Path,
		merged: &Path,
		exclusions: &CloneExclusions,
	) -> IsoResult<Vec<PathBuf>> {
		let lower = tree::canonical_existing_dir(lower, "clone source", IsoError::other)?;
		if let Some(parent) = merged.parent() {
			fs::create_dir_all(parent).map_err(|err| {
				IsoError::other(format!("unable to create parent of {}: {err}", merged.display()))
			})?;
		}
		if merged.exists() {
			if fs::read_dir(merged)
				.map_err(|err| IsoError::other(format!("read_dir {}: {err}", merged.display())))?
				.next()
				.is_some()
			{
				return Err(IsoError::other(format!(
					"clone destination {} is not empty",
					merged.display()
				)));
			}
		} else {
			fs::create_dir(merged)
				.map_err(|err| IsoError::other(format!("create {}: {err}", merged.display())))?;
		}

		let result = (|| {
			// `clonefile` copies a directory whole, so what lies below one and
			// must be left out is found first: the marked directories, and the
			// destination when it lies inside the source.
			let destination = fs::canonicalize(merged).ok();
			let marked = tree::marked_dirs(&lower, exclusions, destination.as_deref())?;
			let mut skipped = exclusions.clone();
			for dir in &marked {
				skipped.path(dir.clone());
			}
			if let Some(inside) = destination
				.as_deref()
				.and_then(|destination| destination.strip_prefix(&lower).ok())
			{
				skipped.path(inside.to_path_buf());
			}
			clone_dir(&lower, merged, &mut PathBuf::new(), &skipped)?;
			Ok(marked)
		})();
		if result.is_err() {
			let _ = fs::remove_dir_all(merged);
		}
		result
	}

	/// Clones the entries of `src` into the existing directory `dst`, each in
	/// one `clonefile` call, except a directory with something below it to
	/// leave out, which is made and cloned entry by entry. `relative` names
	/// `src` below the clone's root. Returns `false` when `src` had entries
	/// and every one was left out.
	fn clone_dir(
		src: &Path,
		dst: &Path,
		relative: &mut PathBuf,
		skipped: &CloneExclusions,
	) -> IsoResult<bool> {
		let (mut seen, mut cloned) = (false, false);
		for entry in fs::read_dir(src)
			.map_err(|err| IsoError::other(format!("read_dir {}: {err}", src.display())))?
		{
			let entry = entry
				.map_err(|err| IsoError::other(format!("dir entry in {}: {err}", src.display())))?;
			let name = entry.file_name();
			relative.push(&name);
			let entry_cloned = clone_entry(&entry, &dst.join(&name), relative, skipped);
			relative.pop();
			seen = true;
			cloned |= entry_cloned?;
		}
		Ok(cloned || !seen)
	}

	/// Clones `entry`, which `relative` names, to `dst`. Returns whether
	/// anything of it was cloned.
	fn clone_entry(
		entry: &fs::DirEntry,
		dst: &Path,
		relative: &mut PathBuf,
		skipped: &CloneExclusions,
	) -> IsoResult<bool> {
		if skipped.excludes(relative) {
			return Ok(false);
		}
		// `clonefile` only accepts regular files, directories, and symlinks
		// as a source (EINVAL otherwise). Sockets, fifos, and devices are
		// process-owned ephemera — skip them, as the recursive walkers on other
		// platforms do.
		let src = entry.path();
		let file_type = entry
			.file_type()
			.map_err(|err| IsoError::other(format!("file_type {}: {err}", src.display())))?;
		if !(file_type.is_file() || file_type.is_dir() || file_type.is_symlink()) {
			return Ok(false);
		}
		if file_type.is_dir() && skipped.excludes_below(relative) {
			fs::create_dir(dst)
				.map_err(|err| IsoError::other(format!("create {}: {err}", dst.display())))?;
			if !clone_dir(&src, dst, relative, skipped)? {
				// Everything in it was left out, so the directory is too.
				fs::remove_dir(dst)
					.map_err(|err| IsoError::other(format!("remove {}: {err}", dst.display())))?;
				return Ok(false);
			}
			let permissions = fs::symlink_metadata(&src)
				.map_err(|err| IsoError::other(format!("symlink_metadata {}: {err}", src.display())))?
				.permissions();
			fs::set_permissions(dst, permissions).map_err(|err| {
				IsoError::other(format!("set permissions on {}: {err}", dst.display()))
			})?;
			return Ok(true);
		}
		cow::clonefile(&src, dst, CLONE_NOFOLLOW).map_err(|err| clone_error(&src, dst, &err))?;
		Ok(true)
	}

	pub fn stop(merged: &Path) -> IsoResult<()> {
		match fs::remove_dir_all(merged) {
			Ok(()) => Ok(()),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
			Err(err) => Err(IsoError::other(format!(
				"unable to remove cloned tree {}: {err}",
				merged.display()
			))),
		}
	}
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
	use std::{
		fs,
		os::unix::{ffi::OsStrExt, fs::symlink},
		path::PathBuf,
	};

	use super::*;

	fn scratch() -> PathBuf {
		let nonce = format!(
			"pi-iso-clone-tree-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		);
		std::env::temp_dir().join(nonce)
	}

	#[test]
	fn clone_tree_skips_top_level_entry_and_preserves_symlink() {
		let root = scratch();
		let lower = root.join("lower");
		let merged = root.join("merged");
		fs::create_dir_all(lower.join("nested")).unwrap();
		fs::create_dir_all(lower.join(".git")).unwrap();
		fs::write(lower.join("file"), "file").unwrap();
		fs::write(lower.join("nested/child"), "child").unwrap();
		fs::write(lower.join(".git/config"), "skip").unwrap();
		symlink("file", lower.join("link")).unwrap();
		// Special files at the checkout root (debug sockets, fifos) are
		// rejected by `clonefile` with EINVAL and must be skipped, not fatal.
		let fifo = std::ffi::CString::new(lower.join("debug.fifo").as_os_str().as_bytes()).unwrap();
		// SAFETY: `fifo` is a valid NUL-terminated path that outlives the call.
		assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);

		let mut exclusions = CloneExclusions::default();
		exclusions.path(".git");
		let result = backend().clone_tree(&lower, &merged, &exclusions);
		if matches!(result, Err(crate::IsoError::Unavailable(_))) {
			let _ = fs::remove_dir_all(root);
			return;
		}
		result.unwrap();
		assert!(!merged.join(".git").exists());
		assert!(fs::symlink_metadata(merged.join("debug.fifo")).is_err());
		assert_eq!(fs::read_to_string(merged.join("file")).unwrap(), "file");
		assert_eq!(fs::read_to_string(merged.join("nested/child")).unwrap(), "child");
		assert_eq!(fs::read_link(merged.join("link")).unwrap(), std::path::Path::new("file"));
		assert!(
			fs::symlink_metadata(merged.join("link"))
				.unwrap()
				.file_type()
				.is_symlink()
		);
		fs::remove_dir_all(root).unwrap();
	}

	/// Directories that hold something to leave out are cloned entry by
	/// entry; the rest stay whole.
	#[test]
	fn clone_tree_leaves_out_paths_and_marked_directories_at_depth() {
		let root = scratch();
		let lower = root.join("lower");
		for relative in [
			"deep/a/left-out.txt",
			"deep/a/kept.txt",
			"cache/pkg/.git",
			"cache/pkg/index.js",
			"cache/other/index.js",
			"whole/file",
		] {
			let path = lower.join(relative);
			fs::create_dir_all(path.parent().unwrap()).unwrap();
			fs::write(path, relative).unwrap();
		}
		let merged = lower.join("deep/inner");
		let mut exclusions = CloneExclusions::default();
		exclusions.path("deep/a/left-out.txt").marker(".git");
		let result = backend().clone_tree(&lower, &merged, &exclusions);
		if matches!(result, Err(crate::IsoError::Unavailable(_))) {
			let _ = fs::remove_dir_all(root);
			return;
		}
		assert_eq!(result.unwrap(), [PathBuf::from("cache/pkg")]);
		assert!(fs::symlink_metadata(merged.join("deep/a/left-out.txt")).is_err());
		assert!(fs::symlink_metadata(merged.join("deep/inner")).is_err(), "cloned into itself");
		assert!(fs::symlink_metadata(merged.join("cache/pkg")).is_err());
		for kept in ["deep/a/kept.txt", "cache/other/index.js", "whole/file"] {
			assert_eq!(fs::read_to_string(merged.join(kept)).unwrap(), kept);
		}
		fs::remove_dir_all(root).unwrap();
	}
}
