//! Process-wide directory-listing cache for [`super::Options::cache`] walks.
//!
//! A directory that has not changed costs one metadata call instead of open +
//! list + close. Validity rests on the kernel's own change tracking: adding,
//! removing, or renaming an entry moves the directory's mtime and ctime, and
//! replacing it changes its inode. A cached listing is reused only while the
//! directory's [`crate::fs::Stamp`] is unchanged, and its ignore files are
//! revalidated the same way. To rule out a change landing in the same
//! timestamp tick as the listing, a listing is cached only once its stamp is
//! older than a racy window (git's "racily clean" rule); younger directories
//! are listed again.
//!
//! Only filesystems whose sessions report [`crate::fs::Session::stable_stamps`]
//! take part; providers, network, FUSE, and overlay mounts are always listed.
//! Only [`crate::Detail::Minimal`] walks use the cache: file sizes and mtimes
//! change without touching their directory's stamp. The cache holds at most
//! about 64 MiB of listings, dropping whole shards when full. It needs no
//! invalidation: a change to a directory changes its stamp.

use std::{
	collections::HashMap,
	hash::{BuildHasher, RandomState},
	path::Path,
	sync::{
		Arc, LazyLock,
		atomic::{AtomicI64, Ordering},
	},
	time::{SystemTime, UNIX_EPOCH},
};

use parking_lot::RwLock;

use super::is_separator;
use crate::{
	fs::{Dir, FileType, Listing, Session, Stamp},
	ignore::{DirIgnores, Names},
};

/// Listing budget of the process-wide cache.
const MAX_BYTES: i64 = 64 << 20;

const SHARDS: usize = 64;

/// How old a stamp must be before its listing is trusted. It covers the
/// coarsest timestamp clock among the allowed filesystems (Linux's
/// tick-granular coarse clock, Windows' 15.6 ms timer).
const RACY_WINDOW_NS: i64 = 50_000_000;

/// Fixed per-listing overhead charged against the budget.
const ENTRY_OVERHEAD: i64 = 128;

/// The cache every [`super::Options::cache`] walk shares.
pub(crate) fn global() -> &'static Cache {
	static CACHE: LazyLock<Cache> = LazyLock::new(|| Cache::new(MAX_BYTES));
	&CACHE
}

/// An immutable listing snapshot; updates replace it.
#[derive(Debug)]
pub(crate) struct CachedDir {
	stamp:              Stamp,
	/// Records carry no sizes, mtimes, or child counts: those change without
	/// touching the directory's stamp.
	pub(crate) listing: Listing,
	pub(crate) names:   Names,
	/// Set when the filling walk honoured ignore files.
	pub(crate) ignores: Option<DirIgnores>,
	size:               i64,
}

type Shard = RwLock<HashMap<Box<[u8]>, Arc<CachedDir>>>;

/// Sharded map from absolute directory path to its listing.
pub(crate) struct Cache {
	hasher:    RandomState,
	shards:    Box<[Shard]>,
	bytes:     AtomicI64,
	max_bytes: i64,
}

impl Cache {
	/// A cache holding at most about `max_bytes` of listings.
	pub(crate) fn new(max_bytes: i64) -> Self {
		Self {
			hasher: RandomState::new(),
			shards: (0..SHARDS).map(|_| RwLock::new(HashMap::new())).collect(),
			bytes: AtomicI64::new(0),
			max_bytes,
		}
	}

	#[expect(clippy::cast_possible_truncation, reason = "the remainder is below SHARDS")]
	fn shard_index(&self, key: &[u8]) -> usize {
		(self.hasher.hash_one(key) % SHARDS as u64) as usize
	}

	fn get(&self, key: &[u8]) -> Option<Arc<CachedDir>> {
		self.shards[self.shard_index(key)].read().get(key).cloned()
	}

	fn put(&self, key: &[u8], dir: CachedDir) {
		let index = self.shard_index(key);
		let size = dir.size;
		let old = self.shards[index].write().insert(key.into(), Arc::new(dir));
		let delta = size - old.map_or(0, |old| old.size);
		if self.bytes.fetch_add(delta, Ordering::Relaxed) + delta > self.max_bytes {
			self.evict(index);
		}
	}

	fn drop_key(&self, key: &[u8]) {
		let old = self.shards[self.shard_index(key)].write().remove(key);
		if let Some(old) = old {
			self.bytes.fetch_sub(old.size, Ordering::Relaxed);
		}
	}

	/// Empties shards, starting after the one just written, until the cache
	/// fits its budget again.
	fn evict(&self, written: usize) {
		for offset in 1..=SHARDS {
			if self.bytes.load(Ordering::Relaxed) <= self.max_bytes {
				return;
			}
			let freed: i64 = {
				let mut shard = self.shards[(written + offset) % SHARDS].write();
				shard.drain().map(|(_, dir)| dir.size).sum()
			};
			self.bytes.fetch_sub(freed, Ordering::Relaxed);
		}
	}

	/// The cached listing of the directory at `abs` if it is still current,
	/// revalidating its ignore sources when `with_ignores` is set. `follow`
	/// is the walk's symlink policy. `abs` is stated through a final symlink
	/// when `follow`, or when it is the walk's `root`, which is always
	/// resolved through symlinks: a walk that does not follow symlinks gets
	/// no listing for a directory below the root that is now a symlink. The
	/// sources are stamped as [`DirIgnores::load`] reads them under `follow`
	/// ([`source_stamp`]), the root's included. `scratch` is per-worker path
	/// scratch.
	pub(crate) async fn lookup(
		&self,
		session: &mut Session,
		abs: &Path,
		with_ignores: bool,
		follow: bool,
		root: bool,
		scratch: &mut Vec<u8>,
	) -> Option<Arc<CachedDir>> {
		let key = abs.as_os_str().as_encoded_bytes();
		let dir = self.get(key)?;
		let ignores = match (&dir.ignores, with_ignores) {
			(None, true) => return None,
			(ignores, true) => ignores.as_ref(),
			(_, false) => None,
		};
		// A directory reached through a followed link is stored under the
		// link's path with the target's stamp.
		match session.stat(abs, follow || root).await {
			Ok(info) if info.stamp == dir.stamp => {},
			_ => {
				self.drop_key(key);
				return None;
			},
		}
		if let Some(ignores) = ignores {
			for (index, name) in DirIgnores::source_names(dir.names) {
				scratch.clear();
				scratch.extend_from_slice(key);
				if !scratch.last().is_some_and(|&b| is_separator(b)) {
					scratch.push(super::SEP);
				}
				let start = scratch.len();
				scratch.extend_from_slice(name.as_bytes());
				for byte in &mut scratch[start..] {
					if *byte == b'/' {
						*byte = super::SEP;
					}
				}
				if source_stamp(session, scratch, start, follow).await != ignores.stamps[index] {
					return None;
				}
			}
		}
		Some(dir)
	}

	/// Caches `listing`, just read from `dir` (stamped `stamp` before the
	/// read), once its stamps have settled.
	#[expect(clippy::too_many_arguments, reason = "everything one listing read produced")]
	pub(crate) fn store(
		&self,
		session: &mut Session,
		abs: &Path,
		dir: &Dir,
		stamp: Stamp,
		listing: &Listing,
		names: Names,
		ignores: Option<&DirIgnores>,
	) {
		let now = now_nanos();
		let settled = |stamp: &Stamp| stamp.latest() < now - RACY_WINDOW_NS;
		if !settled(&stamp)
			|| ignores.is_some_and(|ignores| !ignores.stamps.iter().all(settled))
			|| !session.stable_stamps(dir, &stamp)
		{
			return;
		}
		let mut listing = listing.clone();
		for record in &mut listing.records {
			record.size = None;
			record.mtime = None;
			record.children = 0;
		}
		let key = abs.as_os_str().as_encoded_bytes();
		let size = i64::try_from(key.len() + listing.heap_size())
			.unwrap_or(i64::MAX - ENTRY_OVERHEAD)
			+ ENTRY_OVERHEAD;
		self.put(key, CachedDir { stamp, listing, names, ignores: ignores.cloned(), size });
	}
}

fn now_nanos() -> i64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |elapsed| i64::try_from(elapsed.as_nanos()).unwrap_or(i64::MAX))
}

/// The stamp [`DirIgnores::load`] records for the ignore source at `path`
/// (the directory's path, then from `start` the source's): the source's own
/// when it is a regular file the load opens, following a final symlink only
/// when `follow`, and the default the load records for a source it does not
/// read otherwise. A directory on the way (`.git`, `info`) must be a
/// directory and no symlink, since the load opens it as a child directory
/// whatever `follow` says.
async fn source_stamp(session: &mut Session, path: &[u8], start: usize, follow: bool) -> Stamp {
	for at in start..path.len() {
		if is_separator(path[at])
			&& !matches!(
				session.stat(as_path(&path[..at]), false).await,
				Ok(info) if info.file_type == Some(FileType::Dir)
			) {
			return Stamp::default();
		}
	}
	match session.stat(as_path(path), follow).await {
		Ok(info) if info.file_type == Some(FileType::File) => info.stamp,
		_ => Stamp::default(),
	}
}

/// `bytes` as a path.
fn as_path(bytes: &[u8]) -> &Path {
	// SAFETY: callers pass the source path `lookup` joins (an encoded path,
	// ASCII separators, and an ASCII name), whole or cut before one of its
	// ASCII separators, which is valid encoded `OsStr` data.
	Path::new(unsafe { std::ffi::OsStr::from_encoded_bytes_unchecked(bytes) })
}
