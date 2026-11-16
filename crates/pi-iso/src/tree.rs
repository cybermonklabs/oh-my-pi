//! Helpers shared by the backends that materialize `merged` as a real
//! directory tree (rcopy, Linux reflink, Windows block clone) and by the
//! backends that validate a `lower` source directory.

use std::{
	collections::BTreeSet,
	ffi::{OsStr, OsString},
	fs::{self, DirEntry, FileType},
	io,
	path::{Path, PathBuf},
};

use crate::{IsoError, IsoResult};

/// Resolves `path` against the current directory, checks that it is a
/// directory, and canonicalizes it when possible. `what` names the source in
/// error messages; `make_err` picks the error class, since some backends
/// report a bad source as unavailable so the caller falls back.
pub fn canonical_existing_dir(
	path: &Path,
	what: &str,
	make_err: fn(String) -> IsoError,
) -> IsoResult<PathBuf> {
	let resolved = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
	let meta = fs::metadata(&resolved)
		.map_err(|err| make_err(format!("invalid {what} {}: {err}", resolved.display())))?;
	if !meta.is_dir() {
		return Err(make_err(format!("{what} {} is not a directory", resolved.display())));
	}
	Ok(fs::canonicalize(&resolved).unwrap_or(resolved))
}

/// Creates `merged`'s parent and clears whatever is at `merged` with `remove`,
/// so the walk starts from a fresh destination. `what` names the backend in
/// the error message.
pub fn prepare_destination(
	merged: &Path,
	what: &str,
	remove: impl FnOnce(&Path) -> io::Result<()>,
) -> IsoResult<()> {
	if let Some(parent) = merged.parent() {
		fs::create_dir_all(parent)
			.map_err(|err| IsoError::other(format!("create parent of {}: {err}", merged.display())))?;
	}
	remove(merged).map_err(|err| {
		IsoError::other(format!("unable to clear {} before {what}: {err}", merged.display()))
	})
}

/// Removes the directory tree, file, or symlink at `path`; a missing path is
/// not an error.
pub fn remove_existing(path: &Path) -> io::Result<()> {
	let result = match fs::symlink_metadata(path) {
		Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
		Ok(_) => fs::remove_file(path),
		Err(err) => Err(err),
	};
	match result {
		Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
		other => other,
	}
}

/// Recreates the symlink `src` at `dst` with the same target. `file_type` is
/// `src`'s own (unfollowed) type; Windows needs it to pick a directory or
/// file link.
pub fn copy_symlink(src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()> {
	let target = fs::read_link(src)
		.map_err(|err| IsoError::other(format!("read_link {}: {err}", src.display())))?;
	#[cfg(unix)]
	let res = {
		let _ = file_type;
		std::os::unix::fs::symlink(target, dst)
	};
	#[cfg(windows)]
	let res = if std::os::windows::fs::FileTypeExt::is_symlink_dir(&file_type) {
		std::os::windows::fs::symlink_dir(target, dst)
	} else {
		std::os::windows::fs::symlink_file(target, dst)
	};
	#[cfg(not(any(unix, windows)))]
	let res: io::Result<()> = {
		let _ = (target, file_type);
		Err(io::Error::new(io::ErrorKind::Unsupported, "symlink copy unsupported on this platform"))
	};
	res.map_err(|err| IsoError::other(format!("symlink {}: {err}", dst.display())))
}

/// What a tree clone leaves out of its copy.
///
/// A path, relative to the clone's root, leaves out that entry and everything
/// below it, at any depth. A marker name leaves out each directory below the
/// root that holds an entry of that name, of any type, with everything below
/// it. A directory whose every entry is left out is left out too. Whatever
/// this holds, a clone whose destination lies inside its source never copies
/// the destination into itself.
#[derive(Debug, Clone, Default)]
pub struct CloneExclusions {
	paths:   BTreeSet<PathBuf>,
	markers: Vec<OsString>,
}

impl CloneExclusions {
	/// Leaves out `relative`, a path below the clone's root, with everything
	/// below it.
	pub fn path(&mut self, relative: impl Into<PathBuf>) -> &mut Self {
		self.paths.insert(relative.into());
		self
	}

	/// Leaves out each directory below the clone's root that holds an entry
	/// named `name`.
	pub fn marker(&mut self, name: impl Into<OsString>) -> &mut Self {
		self.markers.push(name.into());
		self
	}

	/// Whether `relative` is left out by its path.
	pub(crate) fn excludes(&self, relative: &Path) -> bool {
		self.paths.contains(relative)
	}

	/// Whether a path strictly below `relative` is left out. A path's
	/// descendants sort directly after it, component by component.
	pub(crate) fn excludes_below(&self, relative: &Path) -> bool {
		use std::ops::Bound;
		self
			.paths
			.range::<Path, _>((Bound::Excluded(relative), Bound::Unbounded))
			.next()
			.is_some_and(|path| path.starts_with(relative))
	}

	/// Whether the directory `dir` holds an entry named by a marker.
	pub(crate) fn marks(&self, dir: &Path) -> bool {
		self
			.markers
			.iter()
			.any(|marker| fs::symlink_metadata(dir.join(marker)).is_ok())
	}
}

/// Per-entry actions of [`copy_dir_contents`].
pub trait TreeCopy {
	/// Recreates the symlink `src` at `dst`.
	fn symlink(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()>;
	/// Copies any entry that is neither a directory nor a symlink.
	fn file(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()>;
	/// Runs after the directory `dst` has been filled from `src`.
	fn finish_dir(&self, src: &Path, dst: &Path) -> IsoResult<()>;
	/// Whether [`whole_dir`](Self::whole_dir) copies a directory with
	/// everything below it in one step (APFS `clonefile`). The walk then
	/// calls it for each directory with nothing below to leave out, and
	/// enters only the others.
	fn copies_whole_dirs(&self) -> bool {
		false
	}
	/// Copies the directory `src`, with everything below it, to `dst`.
	fn whole_dir(&self, src: &Path, dst: &Path) -> IsoResult<()> {
		let _ = dst;
		Err(IsoError::other(format!("{} cannot be copied whole by this backend", src.display())))
	}
}

/// Copies the entries of the directory `src` into the existing directory
/// `dst`, recursing into subdirectories and leaving out what `exclusions`
/// names, its paths taken relative to `src`. When `dst` lies inside `src` it
/// is not copied into itself. The dispatch uses the directory listing's file
/// types, so symlinks are never followed. Returns the directories, relative to
/// `src`, that a marker left out.
pub fn copy_dir_contents(
	src: &Path,
	dst: &Path,
	exclusions: &CloneExclusions,
	copy: &impl TreeCopy,
) -> IsoResult<Vec<PathBuf>> {
	// Both sides resolved, so a destination inside the source is recognized
	// however either path was spelled.
	let src = fs::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());
	let destination = fs::canonicalize(dst).ok();
	let mut marked = Vec::new();
	let named;
	let exclusions = if copy.copies_whole_dirs() {
		// A whole-directory copy cannot leave out what lies below it, so the
		// marked directories and the destination are found first and named
		// by path, which `excludes_below` sees.
		marked = marked_dirs(&src, exclusions, destination.as_deref())?;
		let mut all = exclusions.clone();
		for dir in &marked {
			all.path(dir.clone());
		}
		if let Some(inside) = destination
			.as_deref()
			.and_then(|destination| destination.strip_prefix(&src).ok())
		{
			all.path(inside.to_path_buf());
		}
		named = all;
		&named
	} else {
		exclusions
	};
	let mut walk = Walk { exclusions, copy, destination, relative: PathBuf::new(), marked };
	walk.dir(&src, dst)?;
	Ok(walk.marked)
}

/// One [`copy_dir_contents`] walk.
struct Walk<'a, C> {
	exclusions:  &'a CloneExclusions,
	copy:        &'a C,
	/// `dst` resolved, compared with each source directory.
	destination: Option<PathBuf>,
	/// The entry being copied, relative to the walk's root.
	relative:    PathBuf,
	marked:      Vec<PathBuf>,
}

impl<C: TreeCopy> Walk<'_, C> {
	/// Copies the entries of `src` into `dst`. Returns `false` when `src` had
	/// entries and every one was left out, so nothing of it is in `dst`.
	fn dir(&mut self, src: &Path, dst: &Path) -> IsoResult<bool> {
		let entries = fs::read_dir(src)
			.map_err(|err| IsoError::other(format!("read_dir {}: {err}", src.display())))?;
		let (mut seen, mut copied) = (false, false);
		for entry in entries {
			let entry = entry
				.map_err(|err| IsoError::other(format!("dir entry in {}: {err}", src.display())))?;
			let name = entry.file_name();
			self.relative.push(&name);
			let entry_copied = self.entry(&entry, &name, dst);
			self.relative.pop();
			seen = true;
			copied |= entry_copied?;
		}
		Ok(copied || !seen)
	}

	/// Copies `entry`, which `self.relative` names, into `dst` as `name`.
	/// Returns whether anything of it was copied.
	fn entry(&mut self, entry: &DirEntry, name: &OsStr, dst: &Path) -> IsoResult<bool> {
		if self.exclusions.excludes(&self.relative) {
			return Ok(false);
		}
		let src_path = entry.path();
		let file_type = entry
			.file_type()
			.map_err(|err| IsoError::other(format!("file_type {}: {err}", src_path.display())))?;
		let dst_path = dst.join(name);
		if file_type.is_symlink() {
			self.copy.symlink(&src_path, &dst_path, file_type)?;
		} else if file_type.is_dir() {
			if self.destination.as_deref() == Some(src_path.as_path()) {
				return Ok(false);
			}
			if self.exclusions.marks(&src_path) {
				self.marked.push(self.relative.clone());
				return Ok(false);
			}
			if self.copy.copies_whole_dirs() && !self.exclusions.excludes_below(&self.relative) {
				self.copy.whole_dir(&src_path, &dst_path)?;
				return Ok(true);
			}
			fs::create_dir_all(&dst_path)
				.map_err(|err| IsoError::other(format!("create {}: {err}", dst_path.display())))?;
			if !self.dir(&src_path, &dst_path)? {
				// Everything in it was left out, so the directory is too.
				fs::remove_dir(&dst_path)
					.map_err(|err| IsoError::other(format!("remove {}: {err}", dst_path.display())))?;
				return Ok(false);
			}
			self.copy.finish_dir(&src_path, &dst_path)?;
		} else {
			self.copy.file(&src_path, &dst_path, file_type)?;
		}
		Ok(true)
	}
}

/// The directories below `src`, relative to it, that a marker of
/// `exclusions` leaves out. Only directory listings are read; nothing below a
/// path `exclusions` leaves out, a marked directory, `destination` or a
/// symlink is entered. A walk whose backend copies whole directories needs
/// them before it starts, to know which subtrees hold something to leave out.
fn marked_dirs(
	src: &Path,
	exclusions: &CloneExclusions,
	destination: Option<&Path>,
) -> IsoResult<Vec<PathBuf>> {
	let mut marked = Vec::new();
	if exclusions.markers.is_empty() {
		return Ok(marked);
	}
	let mut pending = vec![(src.to_path_buf(), PathBuf::new())];
	while let Some((dir, relative)) = pending.pop() {
		let entries = fs::read_dir(&dir)
			.map_err(|err| IsoError::other(format!("read_dir {}: {err}", dir.display())))?;
		for entry in entries {
			let entry = entry
				.map_err(|err| IsoError::other(format!("dir entry in {}: {err}", dir.display())))?;
			let entry_relative = relative.join(entry.file_name());
			let path = entry.path();
			let is_dir = entry
				.file_type()
				.map_err(|err| IsoError::other(format!("file_type {}: {err}", path.display())))?
				.is_dir();
			if !is_dir || exclusions.excludes(&entry_relative) || destination == Some(path.as_path()) {
				continue;
			}
			if exclusions.marks(&path) {
				marked.push(entry_relative);
			} else {
				pending.push((path, entry_relative));
			}
		}
	}
	Ok(marked)
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Plain copies, so the walk is tested on any filesystem.
	struct PlainCopy;

	impl TreeCopy for PlainCopy {
		fn symlink(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()> {
			copy_symlink(src, dst, file_type)
		}

		fn file(&self, src: &Path, dst: &Path, _file_type: FileType) -> IsoResult<()> {
			fs::copy(src, dst)
				.map(drop)
				.map_err(|err| IsoError::other(format!("copy {}: {err}", src.display())))
		}

		fn finish_dir(&self, _src: &Path, _dst: &Path) -> IsoResult<()> {
			Ok(())
		}
	}

	fn write(root: &Path, relative: &str) {
		let path = root.join(relative);
		fs::create_dir_all(path.parent().unwrap()).unwrap();
		fs::write(path, relative).unwrap();
	}

	/// Every file below `root`, relative to it, sorted.
	fn files(root: &Path) -> Vec<String> {
		fn visit(root: &Path, dir: &Path, out: &mut Vec<String>) {
			for entry in fs::read_dir(dir).unwrap() {
				let entry = entry.unwrap();
				if entry.file_type().unwrap().is_dir() {
					visit(root, &entry.path(), out);
				} else {
					let relative = entry.path().strip_prefix(root).unwrap().to_path_buf();
					out.push(relative.to_string_lossy().replace('\\', "/"));
				}
			}
		}
		let mut out = Vec::new();
		visit(root, root, &mut out);
		out.sort();
		out
	}

	/// A directory of its own under the system temporary directory, removed
	/// when dropped.
	struct Scratch(PathBuf);

	impl Scratch {
		fn path(&self) -> &Path {
			&self.0
		}
	}

	impl Drop for Scratch {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	fn source() -> Scratch {
		static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
		let scratch = Scratch(std::env::temp_dir().join(format!(
			"pi-iso-tree-{}-{}",
			std::process::id(),
			NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
		)));
		let _ = fs::remove_dir_all(scratch.path());
		let src = scratch.path().join("src");
		for relative in [
			".git/HEAD",
			"kept.txt",
			"deep/a/left-out.txt",
			"deep/a/kept.txt",
			"deep/b/left-out-dir/file",
			"cache/pkg/.git",
			"cache/pkg/index.js",
			"cache/other/index.js",
			"checkout/.git/HEAD",
			"checkout/file",
		] {
			write(&src, relative);
		}
		scratch
	}

	fn exclusions() -> CloneExclusions {
		let mut exclusions = CloneExclusions::default();
		exclusions
			.path(".git")
			.path(Path::new("deep/a/left-out.txt"))
			.path(Path::new("deep/b/left-out-dir"))
			.marker(".git");
		exclusions
	}

	#[test]
	fn copy_leaves_out_paths_at_any_depth_and_marked_directories() {
		let temp = source();
		let (src, dst) = (temp.path().join("src"), temp.path().join("dst"));
		fs::create_dir(&dst).unwrap();
		let mut marked = copy_dir_contents(&src, &dst, &exclusions(), &PlainCopy).unwrap();
		marked.sort();
		assert_eq!(files(&dst), ["cache/other/index.js", "deep/a/kept.txt", "kept.txt"]);
		assert!(
			fs::symlink_metadata(dst.join("deep/b")).is_err(),
			"a directory whose every entry was left out was copied"
		);
		assert_eq!(marked, [PathBuf::from("cache/pkg"), PathBuf::from("checkout")]);
		let mut found = marked_dirs(&src, &exclusions(), None).unwrap();
		found.sort();
		assert_eq!(found, marked, "the pre-scan finds what the copy left out");
	}

	#[test]
	fn copy_into_a_directory_inside_the_source_leaves_the_destination_out() {
		let temp = source();
		let src = temp.path().join("src");
		let dst = src.join("deep/inner");
		fs::create_dir(&dst).unwrap();
		copy_dir_contents(&src, &dst, &CloneExclusions::default(), &PlainCopy).unwrap();
		assert!(fs::symlink_metadata(dst.join("deep/inner")).is_err(), "copied into itself");
		assert!(dst.join("deep/a/left-out.txt").is_file());
	}

	/// Copies a whole directory at once where allowed, recording each one.
	struct WholeCopy(std::cell::RefCell<Vec<PathBuf>>);

	impl TreeCopy for WholeCopy {
		fn symlink(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()> {
			PlainCopy.symlink(src, dst, file_type)
		}

		fn file(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()> {
			PlainCopy.file(src, dst, file_type)
		}

		fn finish_dir(&self, _src: &Path, _dst: &Path) -> IsoResult<()> {
			Ok(())
		}

		fn copies_whole_dirs(&self) -> bool {
			true
		}

		fn whole_dir(&self, src: &Path, dst: &Path) -> IsoResult<()> {
			self.0.borrow_mut().push(src.file_name().unwrap().into());
			fs::create_dir(dst).unwrap();
			copy_dir_contents(src, dst, &CloneExclusions::default(), &PlainCopy).map(drop)
		}
	}

	/// A backend that copies whole directories gets the same result: it is
	/// asked to copy only directories with nothing below them to leave out.
	#[test]
	fn whole_directory_copies_leave_out_the_same_entries() {
		let scratch = source();
		let src = scratch.path().join("src");
		let dst = src.join("deep/inner");
		fs::create_dir(&dst).unwrap();
		let copy = WholeCopy(std::cell::RefCell::new(Vec::new()));
		let mut marked = copy_dir_contents(&src, &dst, &exclusions(), &copy).unwrap();
		marked.sort();
		assert_eq!(files(&dst), ["cache/other/index.js", "deep/a/kept.txt", "kept.txt"]);
		assert_eq!(marked, [PathBuf::from("cache/pkg"), PathBuf::from("checkout")]);
		let mut whole = copy.0.into_inner();
		whole.sort();
		assert_eq!(whole, [PathBuf::from("other")], "copied whole: {whole:?}");
	}

	#[test]
	fn excludes_below_finds_only_descendants() {
		let mut exclusions = CloneExclusions::default();
		exclusions.path(Path::new("a/b/c")).path("a.txt");
		assert!(exclusions.excludes_below(Path::new("")));
		assert!(exclusions.excludes_below(Path::new("a")));
		assert!(exclusions.excludes_below(Path::new("a/b")));
		assert!(!exclusions.excludes_below(Path::new("a/b/c")));
		assert!(!exclusions.excludes_below(Path::new("a/bc")));
		assert!(!exclusions.excludes_below(Path::new("a.txt")));
		assert!(!exclusions.excludes_below(Path::new("b")));
	}
}
