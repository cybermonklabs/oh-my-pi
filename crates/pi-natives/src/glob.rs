//! Filesystem discovery with glob patterns, ignore semantics, and shared
//! directory-listing reuse.
//!
//! # Overview
//! Resolves a search root, runs `pi_walker::glob`, and optionally streams each
//! returned match through a callback. `readFileBeneath` then reads a match
//! below the same root without following a symlink the walk did not list, so
//! a directory or file swapped for a symlink after the listing is refused.
//!
//! `pi_walker::glob` never yields `.git`, and skips `node_modules` unless the
//! pattern or options request it.
//!
//! # Example
//! ```ignore
//! // JS: await native.glob({ pattern: "*.rs", path: "." })
//! // JS: await native.readFileBeneath({ root: ".", path: m.path, followSymlink: m.symlink })
//! ```

use std::{io, path::Path};

use napi::{
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

use crate::{shell::vfs::ShellFilesystem, task};

/// Resolved filesystem entry kind for glob filters and match metadata.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi]
pub enum FileType {
	/// Regular file.
	File    = 1,
	/// Directory.
	Dir     = 2,
	/// Symbolic link.
	Symlink = 3,
}

/// A single filesystem entry from a directory scan.
#[derive(Clone)]
#[napi(object)]
pub struct GlobMatch {
	/// Relative path from the search root, using forward slashes.
	pub path:      String,
	/// Resolved filesystem type for the match.
	pub file_type: FileType,
	/// Modification time in milliseconds since Unix epoch.
	pub mtime:     Option<f64>,
	/// File size in bytes for regular files.
	pub size:      Option<f64>,
	/// `true` when the listing shows a symbolic link at `path`, reported as
	/// `Symlink` or, under a `File` or `Dir` filter, as its target (absent
	/// otherwise). Pass it as `readFileBeneath`'s `followSymlink` to read
	/// what the walk listed.
	pub symlink:   Option<bool>,
}

impl From<pi_walker::FileType> for FileType {
	fn from(file_type: pi_walker::FileType) -> Self {
		match file_type {
			pi_walker::FileType::File => Self::File,
			pi_walker::FileType::Dir => Self::Dir,
			pi_walker::FileType::Symlink => Self::Symlink,
		}
	}
}

impl From<FileType> for pi_walker::FileType {
	fn from(file_type: FileType) -> Self {
		match file_type {
			FileType::File => Self::File,
			FileType::Dir => Self::Dir,
			FileType::Symlink => Self::Symlink,
		}
	}
}

/// Input options for `glob`, including traversal, filtering, and cancellation.
#[napi(object, object_to_js = false)]
pub struct GlobOptions<'env> {
	/// Glob pattern to match (e.g., "*.ts").
	pub pattern:              String,
	/// Directory to search: a host path or an absolute `scheme://` URL.
	pub path:                 String,
	/// Filter by file type: "file", "dir", or "symlink". Symlinks are
	/// matched for file/dir filters based on their target type.
	pub file_type:            Option<FileType>,
	/// Match simple patterns recursively by default (`*.ts` -> recursive).
	pub recursive:            Option<bool>,
	/// Follow descendant symbolic links with cycle detection (default: false).
	/// The filesystem provider is responsible for enforcing mount containment.
	pub follow_links:         Option<bool>,
	/// Include hidden files (default: false).
	pub hidden:               Option<bool>,
	/// Maximum number of results to return.
	pub max_results:          Option<u32>,
	/// Respect .gitignore files (default: true).
	pub gitignore:            Option<bool>,
	/// Reuse unchanged directory listings across calls (default: false).
	pub cache:                Option<bool>,
	/// Sort results by mtime (most recent first) before applying limit.
	pub sort_by_mtime:        Option<bool>,
	/// Include `node_modules` entries when the pattern does not explicitly
	/// mention them.
	pub include_node_modules: Option<bool>,
	/// Abort signal for cancelling the operation.
	pub signal:               Option<Unknown<'env>>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms:           Option<u32>,
	/// Filesystem the search root is resolved and walked through (native when
	/// absent).
	pub filesystem:           Option<ShellFilesystem>,
}

/// Result payload returned by a glob operation.
#[napi(object)]
pub struct GlobResult {
	/// Matched filesystem entries.
	pub matches:       Vec<GlobMatch>,
	/// Number of returned matches (`matches.len()`), clamped to `u32::MAX`.
	pub total_matches: u32,
}

impl From<pi_walker::glob::GlobMatch> for GlobMatch {
	fn from(entry: pi_walker::glob::GlobMatch) -> Self {
		Self {
			path:      entry.path,
			file_type: entry.file_type.into(),
			mtime:     entry.mtime.map(Self::millis),
			size:      entry.size.map(|size| size as f64),
			symlink:   entry.symlink.then_some(true),
		}
	}
}

impl GlobMatch {
	/// Unix nanoseconds to the milliseconds JavaScript dates use.
	pub(crate) const fn millis(nanos: i64) -> f64 {
		nanos.div_euclid(1_000_000) as f64
	}
}

/// Find filesystem entries matching a glob pattern.
///
/// Resolves the search root, runs the glob search, and optionally streams each
/// returned match through `on_match`.
///
/// # Errors
/// Returns an error when the search path cannot be resolved, the path is not a
/// directory, the glob pattern is invalid, or cancellation/timeout is
/// triggered.
#[napi]
pub fn glob<'env>(
	env: &'env Env,
	options: GlobOptions<'_>,
	#[napi(ts_arg_type = "((error: Error | null, match: GlobMatch) => void) | undefined | null")]
	on_match: Option<ThreadsafeFunction<GlobMatch>>,
) -> Result<PromiseRaw<'env, GlobResult>> {
	let GlobOptions {
		pattern,
		path,
		file_type,
		recursive,
		follow_links,
		hidden,
		max_results,
		gitignore,
		sort_by_mtime,
		cache,
		include_node_modules,
		timeout_ms,
		signal,
		filesystem,
	} = options;

	let filesystem = ShellFilesystem::resolve(filesystem);
	let opts = pi_walker::glob::GlobOptions {
		pattern,
		recursive: recursive.unwrap_or(true),
		file_type: file_type.map(Into::into),
		max_results: max_results.map(|value| value as usize),
		sort_by_mtime: sort_by_mtime.unwrap_or(false),
		include_node_modules,
		walk: pi_walker::walk::Options {
			hidden: hidden.unwrap_or(false),
			gitignore: gitignore.unwrap_or(true),
			follow_links: follow_links.unwrap_or(false),
			cache: cache.unwrap_or(false),
			..Default::default()
		},
	};

	let ct = task::CancelToken::new(timeout_ms, signal);
	task::filesystem_future(env, "glob", ct, filesystem, move |filesystem| async move {
		let root = pi_walker::fs::resolve_dir(&filesystem, std::path::Path::new(&path))
			.await
			.map_err(task::walk_failure)?;
		let fs = pi_walker::Fs::new(&filesystem, &root);
		let matches: Vec<GlobMatch> = pi_walker::glob::glob(&fs, &root, &opts)
			.await
			.map_err(|err| match err {
				pi_walker::glob::GlobError::Walk(err) => task::walk_failure(err),
				err @ pi_walker::glob::GlobError::Pattern(_) => Error::from_reason(err.to_string()),
			})?
			.into_iter()
			.map(GlobMatch::from)
			.collect();
		if let Some(callback) = &on_match {
			for matched in &matches {
				callback.call(Ok(matched.clone()), ThreadsafeFunctionCallMode::NonBlocking);
			}
		}
		let total_matches = crate::utils::clamp_u32(matches.len() as u64);
		Ok(GlobResult { matches, total_matches })
	})
}

/// Why `readFileBeneath` left a file unread.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum ReadSkip {
	/// The file is larger than `maxBytes`.
	#[napi(value = "large")]
	Large,
	/// The first `binaryProbeBytes` bytes hold a NUL byte.
	#[napi(value = "binary")]
	Binary,
}

/// Input options for `readFileBeneath`.
#[napi(object, object_to_js = false)]
pub struct ReadFileBeneathOptions {
	/// Directory the file is below: the `path` a `glob` walked. It is
	/// resolved as the walk resolves it, so a symlink there is followed.
	pub root:               String,
	/// The file's walk-relative path below `root` (`GlobMatch.path`):
	/// `/`-separated, no part empty, `.`, or `..`.
	pub path:               String,
	/// Follow a symlink at the final name, as the walk listed it (pass
	/// `GlobMatch.symlink`). A symlink on the way to it is always refused;
	/// without this, one at the final name is refused too.
	pub follow_symlink:     Option<bool>,
	/// Leave a file larger than this many bytes unread (`skip: "large"`); a
	/// file that reports size 0, such as a pseudo file, is read up to this
	/// many bytes instead. 0 or absent: no limit.
	pub max_bytes:          Option<f64>,
	/// Leave a file unread (`skip: "binary"`) when a NUL byte is in its
	/// first this many bytes; a file that reports size 0 is not probed. 0 or
	/// absent: no probe.
	pub binary_probe_bytes: Option<u32>,
	/// Read only the file's first this many bytes (the probe looks no
	/// further); a file larger than `maxBytes` is still left unread. 0 or
	/// absent: the whole file.
	pub prefix_bytes:       Option<f64>,
}

/// Result of `readFileBeneath`.
#[napi(object)]
pub struct ReadFileBeneathResult {
	/// Size of the opened file in bytes.
	pub size:    f64,
	/// Why the file was left unread; absent when `content` holds it.
	pub skip:    Option<ReadSkip>,
	/// The file's bytes; absent when `skip` is set.
	pub content: Option<Uint8Array>,
}

/// Read a file a `glob` listed, below the root the glob walked, without
/// following a symlink the walk did not follow.
///
/// Opens `root` by path as the walk opened it, then the file below that
/// handle: no symlink on the way is followed (a directory swapped for a
/// symlink since the listing is refused), and a symlink at the final name
/// is followed only with `followSymlink`. One open serves the whole read:
/// the size check against `maxBytes`, the binary probe, then the rest of the
/// bytes, each byte read once. The read stops at the size the file had when
/// it was opened (growth after the open is not read); a file that reports
/// size 0, such as a pseudo file, is read to its end or to `maxBytes`,
/// without the binary probe.
///
/// # Errors
/// Rejects when `root` is not a directory, `path` is not walk-relative, a
/// symlink is refused (`ELOOP` or `ENOTDIR` on Unix,
/// `ERROR_STOPPED_ON_SYMLINK` on Windows), the file is a directory or a
/// special file, or the open or a read fails.
#[napi]
pub fn read_file_beneath(
	env: &Env,
	options: ReadFileBeneathOptions,
) -> Result<PromiseRaw<'_, ReadFileBeneathResult>> {
	let ReadFileBeneathOptions {
		root,
		path,
		follow_symlink,
		max_bytes,
		binary_probe_bytes,
		prefix_bytes,
	} = options;
	let positive = |bytes: Option<f64>| bytes.filter(|&bytes| bytes > 0.0).map(|bytes| bytes as u64);
	let limits = ReadLimits {
		max_bytes: positive(max_bytes),
		probe:     binary_probe_bytes.map_or(0, u64::from),
		prefix:    positive(prefix_bytes),
	};
	let ct = task::CancelToken::new(None, None);
	task::filesystem_future(env, "readFileBeneath", ct, pi_vfs::Fs::native(), move |fs| async move {
		let read = read_beneath(
			&fs,
			Path::new(&root),
			path.as_bytes(),
			follow_symlink.unwrap_or(false),
			limits,
		)
		.await
		.map_err(|err| Error::from_reason(format!("Failed to read {path} below {root}: {err}")))?;
		Ok(match read {
			Beneath::Read { size, bytes } => ReadFileBeneathResult {
				size:    size as f64,
				skip:    None,
				content: Some(bytes.into()),
			},
			Beneath::Skipped { size, skip } => {
				ReadFileBeneathResult { size: size as f64, skip: Some(skip), content: None }
			},
		})
	})
}

/// Limits of a [`read_beneath`].
#[derive(Clone, Copy, Debug, Default)]
struct ReadLimits {
	/// Skip a file larger than this.
	max_bytes: Option<u64>,
	/// Leading bytes checked for a NUL; 0 checks none.
	probe:     u64,
	/// Read at most this many leading bytes.
	prefix:    Option<u64>,
}

/// What [`read_beneath`] found.
#[derive(Debug, PartialEq, Eq)]
enum Beneath {
	/// The file's size at open and its bytes.
	Read { size: u64, bytes: Vec<u8> },
	/// The file's size at open and why it was left unread.
	Skipped { size: u64, skip: ReadSkip },
}

/// Opens `root` as a walk opens its root (following symlinks), then the
/// file at the walk-relative `rel` below it following no symlink on the
/// way; a symlink at the final name is followed only with `follow_symlink`.
/// Then checks the size against `limits.max_bytes`, probes the first
/// `limits.probe` bytes for a NUL, and reads on from the probe's end, up to
/// `limits.prefix` bytes, `limits.max_bytes` (which bounds a file reporting
/// size 0), and the size at open.
async fn read_beneath(
	fs: &pi_vfs::Fs,
	root: &Path,
	rel: &[u8],
	follow_symlink: bool,
	limits: ReadLimits,
) -> io::Result<Beneath> {
	let root = pi_walker::fs::resolve_dir(fs, root)
		.await
		.map_err(|pi_walker::walk::WalkError::Root { error, .. }| error)?;
	let mut session = pi_walker::Fs::new(fs, &root).session();
	let dir = session.open_dir(&root).await?;
	let (mut file, _) = if follow_symlink {
		let (parent, name) = split_final(rel)?;
		match parent {
			Some(parent) => {
				let parent = session.open_dir_beneath(&dir, parent).await?;
				session.open_file_at(&parent, name, true).await?
			},
			None => session.open_file_at(&dir, name, true).await?,
		}
	} else {
		session.open_file_beneath(&dir, rel).await?
	};
	let size = file.size();
	if limits.max_bytes.is_some_and(|max| size > max) {
		return Ok(Beneath::Skipped { size, skip: ReadSkip::Large });
	}
	let limit = limits
		.prefix
		.unwrap_or(u64::MAX)
		.min(limits.max_bytes.unwrap_or(u64::MAX));
	let mut bytes = Vec::new();
	let probe = limits.probe.min(size).min(limit);
	if probe > 0 {
		file.read_into(&mut bytes, probe).await?;
		if bytes.contains(&0) {
			return Ok(Beneath::Skipped { size, skip: ReadSkip::Binary });
		}
	}
	file.read_more(&mut bytes, limit).await?;
	Ok(Beneath::Read { size, bytes })
}

/// Splits the walk-relative `rel` into its directory part (`None` for a name
/// directly below the root) and its final name, refusing an empty, `.`, or
/// `..` final name; the directory part is checked when it is opened.
fn split_final(rel: &[u8]) -> io::Result<(Option<&[u8]>, &[u8])> {
	let separator = |&byte: &u8| pi_walker::fs::is_rel_separator(byte);
	let (parent, name) = match rel.iter().rposition(separator) {
		Some(at) => (Some(&rel[..at]), &rel[at + 1..]),
		None => (None, rel),
	};
	if matches!(name, b"" | b"." | b"..") {
		return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a walk-relative path"));
	}
	Ok((parent, name))
}

#[cfg(all(test, unix))]
mod tests {
	use std::{
		fs,
		os::unix::fs::symlink,
		path::PathBuf,
		sync::atomic::{AtomicU64, Ordering},
	};

	use super::*;

	/// A tree for the read tests, removed on drop:
	/// `root/a/b/file.txt` (`inside`), `outside/secret.txt` (`outside`), and
	/// below `root` the symlinks `a/link.txt -> ../../outside/secret.txt` and
	/// `swapped -> ../outside`.
	struct Tree(PathBuf);

	impl Tree {
		fn new() -> Self {
			static COUNTER: AtomicU64 = AtomicU64::new(0);
			let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
			let base = std::env::temp_dir()
				.join(format!("pi-natives-read-beneath-{}-{seq}", std::process::id()));
			let _ = fs::remove_dir_all(&base);
			fs::create_dir_all(base.join("root/a/b")).expect("create root");
			fs::create_dir_all(base.join("outside")).expect("create outside");
			fs::write(base.join("root/a/b/file.txt"), "inside").expect("write inside");
			fs::write(base.join("outside/secret.txt"), "outside").expect("write outside");
			symlink("../../outside/secret.txt", base.join("root/a/link.txt")).expect("file link");
			symlink("../outside", base.join("root/swapped")).expect("dir link");
			Self(base)
		}

		fn root(&self) -> PathBuf {
			self.0.join("root")
		}

		fn write(&self, rel: &str, contents: &[u8]) {
			fs::write(self.0.join("root").join(rel), contents).expect("write file");
		}
	}

	impl Drop for Tree {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	async fn read(root: &Path, rel: &str, follow: bool, limits: ReadLimits) -> io::Result<Beneath> {
		read_beneath(&pi_vfs::Fs::native(), root, rel.as_bytes(), follow, limits).await
	}

	fn bytes(read: io::Result<Beneath>) -> Vec<u8> {
		match read.expect("read") {
			Beneath::Read { bytes, .. } => bytes,
			skipped @ Beneath::Skipped { .. } => panic!("{skipped:?}"),
		}
	}

	/// The walker's refusal of a symlink: `ELOOP` (`openat2`, `O_NOFOLLOW`)
	/// or `ENOTDIR` (a directory open with `O_NOFOLLOW` on a link).
	fn refused_link(err: &io::Error) -> bool {
		matches!(err.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR))
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn reads_a_regular_file_below_the_root() {
		let tree = Tree::new();
		for follow in [false, true] {
			let got = read(&tree.root(), "a/b/file.txt", follow, ReadLimits::default()).await;
			assert_eq!(got.expect("read"), Beneath::Read { size: 6, bytes: b"inside".to_vec() });
		}
		// The root is resolved as a walk resolves it: a symlink there is
		// followed.
		let root_link = tree.0.join("root-link");
		symlink(tree.root(), &root_link).expect("root link");
		let got = read(&root_link, "a/b/file.txt", false, ReadLimits::default()).await;
		assert_eq!(bytes(got), b"inside");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn a_symlink_at_the_file_is_followed_only_when_listed_as_one() {
		let tree = Tree::new();
		let err = read(&tree.root(), "a/link.txt", false, ReadLimits::default())
			.await
			.unwrap_err();
		assert!(refused_link(&err), "{err:?}");
		let got = read(&tree.root(), "a/link.txt", true, ReadLimits::default()).await;
		assert_eq!(bytes(got), b"outside");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn a_symlinked_directory_on_the_way_is_refused() {
		let tree = Tree::new();
		for follow in [false, true] {
			let err = read(&tree.root(), "swapped/secret.txt", follow, ReadLimits::default())
				.await
				.unwrap_err();
			assert!(refused_link(&err), "follow {follow}: {err:?}");
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn refuses_paths_that_are_not_walk_relative() {
		let tree = Tree::new();
		for rel in ["", "..", ".", "a/..", "a/b/", "../outside/secret.txt", "a//b/file.txt"] {
			for follow in [false, true] {
				let err = read(&tree.root(), rel, follow, ReadLimits::default())
					.await
					.unwrap_err();
				assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{rel:?} follow {follow}: {err:?}");
			}
		}
		let err = read(&tree.root(), "a/b", false, ReadLimits::default())
			.await
			.unwrap_err();
		assert!(pi_walker::fs::is_not_regular(&err), "{err:?}");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn the_size_limit_and_the_binary_probe_skip_before_reading() {
		let tree = Tree::new();
		let limits = |max_bytes, probe| ReadLimits { max_bytes, probe, prefix: None };
		let root = tree.root();
		let skipped = |size, skip| Beneath::Skipped { size, skip };
		assert_eq!(
			read(&root, "a/b/file.txt", false, limits(Some(5), 0))
				.await
				.unwrap(),
			skipped(6, ReadSkip::Large)
		);
		assert_eq!(bytes(read(&root, "a/b/file.txt", false, limits(Some(6), 0)).await), b"inside");
		// A NUL inside the probe skips the file; one past it does not, and the
		// rest of the file is still read.
		let mut late_nul = vec![b'x'; 30];
		late_nul[20] = 0;
		tree.write("late.bin", &late_nul);
		tree.write("early.bin", b"ab\0cd");
		assert_eq!(
			read(&root, "early.bin", false, limits(None, 8))
				.await
				.unwrap(),
			skipped(5, ReadSkip::Binary)
		);
		assert_eq!(bytes(read(&root, "late.bin", false, limits(None, 8)).await), late_nul);
		// A probe as long as the file reads it whole.
		assert_eq!(bytes(read(&root, "a/b/file.txt", false, limits(Some(6), 64)).await), b"inside");
		assert_eq!(
			read(&root, "late.bin", false, limits(None, 64))
				.await
				.unwrap(),
			skipped(30, ReadSkip::Binary)
		);
		tree.write("empty.txt", b"");
		assert_eq!(bytes(read(&root, "empty.txt", false, limits(Some(1), 8)).await), b"");
		// A file listed as a symlink is measured and probed at its target.
		assert_eq!(
			read(&root, "a/link.txt", true, limits(Some(3), 0))
				.await
				.unwrap(),
			skipped(7, ReadSkip::Large)
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn a_prefix_read_takes_the_leading_bytes_whatever_the_size() {
		let tree = Tree::new();
		let root = tree.root();
		let mut late_nul = vec![b'x'; 30];
		late_nul[20] = 0;
		tree.write("late.bin", &late_nul);
		let prefix = |prefix, probe| ReadLimits { max_bytes: None, probe, prefix: Some(prefix) };
		assert_eq!(bytes(read(&root, "late.bin", false, prefix(10, 0)).await), &late_nul[..10]);
		// The probe looks no further than the prefix.
		assert_eq!(bytes(read(&root, "late.bin", false, prefix(10, 64)).await), &late_nul[..10]);
		assert_eq!(
			read(&root, "late.bin", false, prefix(21, 64))
				.await
				.unwrap(),
			Beneath::Skipped { size: 30, skip: ReadSkip::Binary }
		);
		// A prefix past the end reads the whole file, probed or not.
		assert_eq!(bytes(read(&root, "a/b/file.txt", false, prefix(100, 0)).await), b"inside");
		assert_eq!(bytes(read(&root, "a/b/file.txt", false, prefix(100, 4)).await), b"inside");
	}
}
