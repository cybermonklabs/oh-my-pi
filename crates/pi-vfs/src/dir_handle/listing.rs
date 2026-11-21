//! What a directory handle's listing and walk opens report: entry kinds,
//! change stamps, and the reusable listing arena.

use crate::metadata::Metadata;

/// Kind of a listed entry.
///
/// Special files (devices, FIFOs, sockets) are never reported by listings; on
/// Windows every reparse point is a [`Self::Symlink`]. Unlike
/// [`crate::FileType`], it has no kind for special files.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FileType {
	/// A regular file.
	File,
	/// A directory.
	Dir,
	/// A symbolic link (never followed by a listing).
	Symlink,
}

/// How much metadata listings collect.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Detail {
	/// Names and entry types only: one bulk listing call per directory and no
	/// per-entry metadata syscalls.
	#[default]
	Minimal,
	/// Also modification times for every entry and sizes for regular files.
	/// macOS and Windows return these from the bulk listing; Linux and
	/// providers pay one metadata call per entry.
	Full,
}

/// One version of a file or directory.
///
/// Adding, removing, or renaming a directory's entries moves its mtime and
/// ctime, and replacing it changes its inode. Listing caches compare stamps to
/// decide whether a listing is still current.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Stamp {
	/// Device or volume serial number.
	pub dev:   u64,
	/// Inode or file index (Windows path queries: creation time).
	pub ino:   u64,
	/// Modification time, Unix nanoseconds.
	pub mtime: i64,
	/// Status-change time, Unix nanoseconds.
	pub ctime: i64,
}

impl Stamp {
	/// The newer of the two timestamps.
	pub const fn latest(&self) -> i64 {
		if self.mtime > self.ctime {
			self.mtime
		} else {
			self.ctime
		}
	}
}

/// Metadata of a file a walk opened or stated: its kind, size and stamp.
#[derive(Clone, Copy, Debug)]
pub struct FileInfo {
	/// `None` for special files (devices, FIFOs, sockets).
	pub file_type: Option<FileType>,
	/// Byte size.
	pub size:      u64,
	/// Change stamp (also carries the modification time).
	pub stamp:     Stamp,
}

impl FileInfo {
	/// The description of an object from its facade metadata, as a provider
	/// walk takes it: the provider's identity (0 where it has none) and
	/// times, the modification time standing in for a missing status-change
	/// time.
	pub fn of(meta: &Metadata) -> Self {
		super::provider::info_of(meta)
	}
}

/// One listing entry; its name lives in the owning [`Listing`].
#[derive(Clone, Copy, Debug)]
pub struct Record {
	pub(crate) name_off: u32,
	pub(crate) name_len: u32,
	/// A subdirectory's entry count when the listing reports it (macOS full
	/// listings), else 0. Passed back to a listing of the child, it lets the
	/// child's listing stop without a final empty read.
	pub children:        u32,
	/// Entry kind as listed (symlinks unresolved).
	pub file_type:       FileType,
	/// Regular-file size, when the listing carries it.
	pub size:            Option<u64>,
	/// Modification time in Unix nanoseconds, when the listing carries it.
	pub mtime:           Option<i64>,
}

impl Record {
	/// The name of this record in `names`, the names of the [`Listing`] it
	/// came from ([`Listing::parts_mut`]).
	pub fn name_in<'n>(&self, names: &'n [u8]) -> &'n [u8] {
		let start = self.name_off as usize;
		&names[start..start + self.name_len as usize]
	}
}

/// One directory's entries, without `.` and `..` and without special files.
/// Names are raw bytes (`OsStr` encoded bytes: exact on Unix, WTF-8 on
/// Windows and for provider names).
#[derive(Clone, Debug, Default)]
pub struct Listing {
	pub(crate) records: Vec<Record>,
	pub(crate) names:   Vec<u8>,
}

impl Listing {
	/// Entries in listing order.
	pub fn records(&self) -> &[Record] {
		&self.records
	}

	/// The entries, to reorder or edit, and the names they index
	/// ([`Record::name_in`]).
	pub fn parts_mut(&mut self) -> (&mut [Record], &[u8]) {
		(&mut self.records, &self.names)
	}

	/// The name of `record`, which must come from this listing.
	pub fn name(&self, record: &Record) -> &[u8] {
		record.name_in(&self.names)
	}

	/// Number of entries.
	pub const fn len(&self) -> usize {
		self.records.len()
	}

	/// The directory has no listed entries.
	pub const fn is_empty(&self) -> bool {
		self.records.is_empty()
	}

	/// Approximate heap footprint in bytes, for cache budgets.
	pub const fn heap_size(&self) -> usize {
		self.names.len() + self.records.len() * size_of::<Record>()
	}

	pub(crate) fn clear(&mut self) {
		self.records.clear();
		self.names.clear();
	}

	pub(crate) fn push(
		&mut self,
		name: &[u8],
		file_type: FileType,
		size: Option<u64>,
		mtime: Option<i64>,
		children: u32,
	) {
		self.push_with(|names| names.extend_from_slice(name), file_type, size, mtime, children);
	}

	/// [`Self::push`] with the name appended to the arena by `write_name`.
	pub(crate) fn push_with(
		&mut self,
		write_name: impl FnOnce(&mut Vec<u8>),
		file_type: FileType,
		size: Option<u64>,
		mtime: Option<i64>,
		children: u32,
	) {
		let name_off = self.names.len();
		write_name(&mut self.names);
		self.records.push(Record {
			name_off: name_off as u32,
			name_len: (self.names.len() - name_off) as u32,
			children,
			file_type,
			size,
			mtime,
		});
	}
}
