//! The tree of an interrupted worktree add, opened once and walked through
//! descriptors: each entry is read with `statx` before it is touched, a
//! directory is opened only if the open reaches that same directory, and a
//! directory that is the root of another mount is never entered or emptied.

use std::{
	ffi::{CStr, CString, OsStr},
	fmt, fs,
	io::{self, Read as _},
	mem::MaybeUninit,
	os::{
		fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
		unix::ffi::OsStrExt,
	},
	path::{Path, PathBuf},
};

use super::{TreeMark, resolve_leaf, tree_mark};

/// An open directory: `O_RDONLY | O_DIRECTORY | O_NOFOLLOW`.
pub struct TreeDir(fs::File);

/// The deepest a walk goes below the tree's root, in directories. Each level
/// holds one descriptor, so a deeper tree is refused rather than run out of
/// them.
pub const MAX_DEPTH: usize = 256;

/// The most of a `.git` file that is read: a gitfile is one short line.
const GITFILE_MAX: u64 = 4096;

fn c_name(name: &OsStr) -> io::Result<CString> {
	CString::new(name.as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

/// Runs `call` again while it fails with `EINTR`.
fn retry(mut call: impl FnMut() -> libc::c_int) -> libc::c_int {
	loop {
		let rc = call();
		if rc >= 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
			return rc;
		}
	}
}

/// `openat(dir, name, flags | O_CLOEXEC | O_NOFOLLOW)`.
fn open_at(dir: RawFd, name: &CStr, flags: libc::c_int) -> io::Result<OwnedFd> {
	// SAFETY: `name` is a live NUL-terminated string; the flags take no mode
	// argument.
	let fd = retry(|| unsafe {
		libc::openat(dir, name.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOFOLLOW)
	});
	if fd < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `fd` was just opened and nothing else owns it.
	Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// `unlinkat(dir, name, flags)`; a name already gone is fine.
fn unlink_at(dir: RawFd, name: &CStr, flags: libc::c_int) -> io::Result<()> {
	// SAFETY: `name` is a live NUL-terminated string.
	if retry(|| unsafe { libc::unlinkat(dir, name.as_ptr(), flags) }) == 0 {
		return Ok(());
	}
	let err = io::Error::last_os_error();
	if err.kind() == io::ErrorKind::NotFound {
		Ok(())
	} else {
		Err(err)
	}
}

/// What `statx` tells of an entry, as the walks need it.
#[derive(Clone, Copy, Debug)]
struct Entry {
	/// The file type bits of the mode (`S_IFMT`).
	kind:       libc::mode_t,
	dev:        libc::dev_t,
	ino:        u64,
	/// The mount the entry is on, where `statx` reports it (Linux 5.8 and
	/// later).
	mount:      Option<u64>,
	/// Whether the entry is the root of a mount, where `statx` reports it
	/// (Linux 5.8 and later).
	mount_root: bool,
}

impl Entry {
	const fn is_dir(&self) -> bool {
		self.kind == libc::S_IFDIR
	}

	const fn is_file(&self) -> bool {
		self.kind == libc::S_IFREG
	}

	const fn id(&self) -> (libc::dev_t, u64) {
		(self.dev, self.ino)
	}

	/// Whether this entry, below the tree's root `root`, is a mount point: the
	/// root of a mount or on another mount than the root, whatever its type (a
	/// file can be bind-mounted too), or a directory on another device than
	/// the root (a filesystem that gives its subvolumes devices of their own,
	/// such as btrfs, counts too). Devices are compared between directories
	/// only: an overlay whose layers lie on two filesystems gives its files
	/// another device than its directories, on one mount. Where `statx` gives
	/// no mount id (before Linux 5.8), the walks read a directory's from the
	/// opened directory ([`mount_id`]); a mounted file there is met by the
	/// emptying, whose `unlinkat` fails with `EBUSY`.
	const fn mounted_below(&self, root: &Self) -> bool {
		self.mount_root
			|| matches!((self.mount, root.mount), (Some(mine), Some(theirs)) if mine != theirs)
			|| (self.is_dir() && self.dev != root.dev)
	}
}

/// `statx` of `name` in `dir` (`flags` adds `AT_EMPTY_PATH` for `dir`
/// itself), never following a symlink or triggering an automount. `None` when
/// the entry is gone.
fn statx_at(dir: RawFd, name: &CStr, flags: libc::c_int) -> io::Result<Option<Entry>> {
	let mut buf = MaybeUninit::<libc::statx>::zeroed();
	// SAFETY: `name` is a live NUL-terminated string, and `buf` is writable
	// memory of the size `statx` fills.
	let rc = retry(|| unsafe {
		libc::statx(
			dir,
			name.as_ptr(),
			flags | libc::AT_SYMLINK_NOFOLLOW | libc::AT_NO_AUTOMOUNT,
			libc::STATX_TYPE | libc::STATX_INO | libc::STATX_MNT_ID,
			buf.as_mut_ptr(),
		)
	});
	if rc != 0 {
		let err = io::Error::last_os_error();
		return if err.kind() == io::ErrorKind::NotFound {
			Ok(None)
		} else {
			Err(err)
		};
	}
	// SAFETY: `statx` succeeded, so it filled `buf` (zeroed where it did not).
	let stat = unsafe { buf.assume_init() };
	let mount_root = u64::from(libc::STATX_ATTR_MOUNT_ROOT.cast_unsigned());
	let reported = statx_reports_mounts();
	Ok(Some(Entry {
		kind:       libc::mode_t::from(stat.stx_mode) & libc::S_IFMT,
		dev:        libc::makedev(stat.stx_dev_major, stat.stx_dev_minor),
		ino:        stat.stx_ino,
		mount:      (reported && stat.stx_mask & libc::STATX_MNT_ID != 0).then_some(stat.stx_mnt_id),
		mount_root: reported
			&& stat.stx_attributes_mask & mount_root != 0
			&& stat.stx_attributes & mount_root != 0,
	}))
}

/// Whether to take `statx`'s mount id and mount-root attribute.
#[cfg(not(test))]
const fn statx_reports_mounts() -> bool {
	true
}

/// Whether to take `statx`'s mount id and mount-root attribute; tests hide
/// them to stand for a kernel before 5.8.
#[cfg(test)]
fn statx_reports_mounts() -> bool {
	super::test_hooks::mount_ids() == super::test_hooks::MountIds::Statx
}

/// The entry `name` in the directory `dir`.
fn entry_at(dir: RawFd, name: &CStr) -> io::Result<Option<Entry>> {
	statx_at(dir, name, 0)
}

/// The open file `fd` itself.
fn entry_of(fd: RawFd) -> io::Result<Entry> {
	statx_at(fd, c"", libc::AT_EMPTY_PATH)?.ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
}

/// The mount id of the open file `fd`: what `statx` gave (`reported`), else
/// the `mnt_id:` line of `/proc/self/fdinfo/<fd>` (Linux 3.15 and later).
/// `None` when fdinfo has no such line; the error of the read when it cannot
/// be read.
fn mount_id(fd: RawFd, reported: Option<u64>) -> io::Result<Option<u64>> {
	if reported.is_some() {
		return Ok(reported);
	}
	#[cfg(test)]
	if super::test_hooks::mount_ids() == super::test_hooks::MountIds::None {
		return Ok(None);
	}
	let text = fs::read_to_string(format!("/proc/self/fdinfo/{fd}"))?;
	Ok(parse_mnt_id(&text))
}

/// The mount id of the open file `fd`, as [`mount_id`] gives it, or the stop
/// that says why there is none.
fn mount_id_or_stop(fd: RawFd, reported: Option<u64>) -> io::Result<u64> {
	match mount_id(fd, reported) {
		Ok(Some(id)) => Ok(id),
		Ok(None) => Err(stop(Stop::NoMountIds)),
		Err(err) => Err(stop(Stop::MountIdUnread(err))),
	}
}

/// The `mnt_id:` value of a `/proc/<pid>/fdinfo/<fd>` text.
fn parse_mnt_id(text: &str) -> Option<u64> {
	text
		.lines()
		.find_map(|line| line.strip_prefix("mnt_id:"))
		.and_then(|value| value.trim().parse().ok())
}

/// Why a walk stopped before it was done, by the path relative to the tree's
/// root where it stopped.
#[derive(Debug)]
pub enum Stop {
	/// An entry changed between its `statx` and its open: a directory swapped
	/// for a symlink, or another directory renamed into its place.
	Changed(PathBuf),
	/// A directory that is one of its own ancestors.
	Cycle(PathBuf),
	/// A directory more than [`MAX_DEPTH`] levels below the root.
	TooDeep(PathBuf),
	/// A directory that is a mount point, met by the emptying (one mounted
	/// after the checks).
	Mounted(PathBuf),
	/// The system reports no mount ids, so a mount point cannot be told from
	/// a directory of the tree's own filesystem.
	NoMountIds,
	/// `statx` gave no mount id and reading `/proc/self/fdinfo` failed, with
	/// this error.
	MountIdUnread(io::Error),
}

impl Stop {
	/// What the stop says of the tree at `tree`, as a predicate of the tree:
	/// it reads after "it" and after "and".
	pub fn reason(&self, tree: &Path) -> String {
		match self {
			Self::Changed(at) => format!(
				"has an entry that changed while the reclaim walked it ({})",
				tree.join(at).display()
			),
			Self::Cycle(at) => format!(
				"has a directory that is one of its own ancestors ({})",
				tree.join(at).display()
			),
			Self::TooDeep(at) => format!(
				"is more than {MAX_DEPTH} directories deep at {}, deeper than the reclaim walks",
				tree.join(at).display()
			),
			Self::Mounted(at) => {
				format!("holds a filesystem mounted below its root ({})", tree.join(at).display())
			},
			Self::NoMountIds => "is on a system that reports no mount ids (neither `statx` nor \
			                     `/proc/self/fdinfo`), so a filesystem mounted in it cannot be told \
			                     apart"
				.to_owned(),
			Self::MountIdUnread(err) => format!(
				"is on a system where `statx` gives no mount ids and reading them from \
				 `/proc/self/fdinfo` failed ({err}), so a filesystem mounted in it cannot be told \
				 apart"
			),
		}
	}
}

impl fmt::Display for Stop {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(&self.reason(Path::new("")))
	}
}

impl std::error::Error for Stop {}

/// The [`Stop`] an error of a walk carries, if it is one.
pub fn stop_of(err: &io::Error) -> Option<&Stop> {
	err.get_ref()?.downcast_ref()
}

fn stop(why: Stop) -> io::Error {
	io::Error::other(why)
}

/// The tree's root, as the walks compare every directory with it.
struct Root {
	entry: Entry,
	/// The root's mount id, from `statx` or `/proc/self/fdinfo`.
	mount: u64,
}

impl Root {
	fn of(fd: RawFd) -> io::Result<Self> {
		let entry = entry_of(fd)?;
		let mount = mount_id_or_stop(fd, entry.mount)?;
		Ok(Self { entry, mount })
	}

	/// Whether the directory `child`, opened as `fd`, is on another mount
	/// than the root.
	fn other_mount(&self, fd: RawFd, child: &Entry) -> io::Result<bool> {
		Ok(mount_id_or_stop(fd, child.mount)? != self.mount)
	}
}

/// Opens the directory `name` in `dir` (at `path`), which `entry_at` said is
/// the directory `entry`, and checks that the open reached that very
/// directory: some kernels (gVisor) follow a symlink for `O_DIRECTORY` even
/// with `O_NOFOLLOW`, and another directory can be renamed into the name, so
/// the opened file's type, device and inode must match. Returns the
/// descriptor and what `statx` says of it; `None` when the entry is gone.
fn open_dir(
	dir: RawFd,
	name: &CStr,
	entry: &Entry,
	path: &Path,
) -> io::Result<Option<(OwnedFd, Entry)>> {
	#[cfg(test)]
	super::test_hooks::before_entry_open(OsStr::from_bytes(name.to_bytes()));
	let fd = match open_at(dir, name, libc::O_RDONLY | libc::O_DIRECTORY) {
		Ok(fd) => fd,
		Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
		Err(err) if matches!(err.raw_os_error(), Some(libc::ENOTDIR | libc::ELOOP)) => {
			return Err(stop(Stop::Changed(path.to_path_buf())));
		},
		Err(err) => return Err(err),
	};
	let opened = entry_of(fd.as_raw_fd())?;
	if !opened.is_dir() || opened.id() != entry.id() {
		return Err(stop(Stop::Changed(path.to_path_buf())));
	}
	Ok(Some((fd, opened)))
}

/// Checks that the directory `entry` (at `path`) can be walked into below
/// `ancestors`: not one of them (a cycle), and not deeper than
/// [`MAX_DEPTH`].
fn may_enter(ancestors: &[(libc::dev_t, u64)], entry: &Entry, path: &Path) -> io::Result<()> {
	if ancestors.contains(&entry.id()) {
		return Err(stop(Stop::Cycle(path.to_path_buf())));
	}
	if ancestors.len() > MAX_DEPTH {
		return Err(stop(Stop::TooDeep(path.to_path_buf())));
	}
	Ok(())
}

/// The names in the directory `dir`, without `.` and `..`.
fn names(dir: RawFd) -> io::Result<Vec<CString>> {
	// `fdopendir` takes the descriptor over, so it gets a duplicate.
	// SAFETY: `dir` is an open descriptor.
	let dup = unsafe { libc::fcntl(dir, libc::F_DUPFD_CLOEXEC, 0) };
	if dup < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `dup` is an open directory descriptor this function owns.
	let stream = unsafe { libc::fdopendir(dup) };
	if stream.is_null() {
		let err = io::Error::last_os_error();
		// SAFETY: `fdopendir` failed, so `dup` is still ours to close.
		unsafe { libc::close(dup) };
		return Err(err);
	}
	// The duplicate shares the original's offset, which an earlier listing of
	// the same descriptor moved: start from the beginning.
	// SAFETY: `stream` is the open stream just made.
	unsafe { libc::rewinddir(stream) };
	let mut names = Vec::new();
	loop {
		// SAFETY: as above. A null result is the end or an error, told apart by
		// `errno`, which is cleared first.
		let entry = unsafe {
			*libc::__errno_location() = 0;
			libc::readdir(stream)
		};
		if entry.is_null() {
			// SAFETY: reading the thread's `errno`.
			let errno = unsafe { *libc::__errno_location() };
			// SAFETY: `stream` is open; closing it closes `dup`.
			unsafe { libc::closedir(stream) };
			if errno != 0 {
				return Err(io::Error::from_raw_os_error(errno));
			}
			return Ok(names);
		}
		// SAFETY: a non-null entry's `d_name` is a NUL-terminated string that
		// stays valid until the next `readdir`.
		let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
		if name != c"." && name != c".." {
			names.push(name.to_owned());
		}
	}
}

/// Removes everything in the directory `dir` (at `at`, relative to the root),
/// deciding each entry by its `statx` before touching it: anything that is
/// not a directory is unlinked without being opened, and a directory is
/// opened only if the open reaches that same directory (`open_dir`). A
/// directory that is a mount point stops it before anything on that mount is
/// touched. `ancestors` holds the directories open above, the root's first.
fn remove_all_in(
	dir: RawFd,
	at: &Path,
	root: &Root,
	ancestors: &mut Vec<(libc::dev_t, u64)>,
) -> io::Result<()> {
	for name in names(dir)? {
		let path = at.join(OsStr::from_bytes(name.as_bytes()));
		let Some(entry) = entry_at(dir, &name)? else {
			continue;
		};
		if entry.mounted_below(&root.entry) {
			return Err(stop(Stop::Mounted(path)));
		}
		if !entry.is_dir() {
			unlink_at(dir, &name, 0).map_err(|err| busy_is_mounted(err, &path))?;
			continue;
		}
		may_enter(ancestors, &entry, &path)?;
		let Some((child, opened)) = open_dir(dir, &name, &entry, &path)? else {
			continue;
		};
		if root.other_mount(child.as_raw_fd(), &opened)? {
			return Err(stop(Stop::Mounted(path)));
		}
		ancestors.push(entry.id());
		remove_all_in(child.as_raw_fd(), &path, root, ancestors)?;
		ancestors.pop();
		drop(child);
		unlink_at(dir, &name, libc::AT_REMOVEDIR).map_err(|err| busy_is_mounted(err, &path))?;
	}
	Ok(())
}

/// An `EBUSY` from removing the entry at `path` is a mount there (a file
/// bind-mounted where `statx` gives no mount id to show it): the stop says
/// so, where the bare error would name neither the path nor the cause.
fn busy_is_mounted(err: io::Error, path: &Path) -> io::Error {
	if err.raw_os_error() == Some(libc::EBUSY) {
		stop(Stop::Mounted(path.to_path_buf()))
	} else {
		err
	}
}

/// What below a tree's root is not the interrupted add's to remove, by its
/// path relative to the root.
pub enum Foreign {
	/// A repository: an entry named `.git` below the root, or a directory (the
	/// root too) holding `HEAD`, `objects` and `refs` whose `HEAD` the add's
	/// commit does not track (a bare repository).
	Repository(PathBuf),
	/// A directory that is a mount point.
	MountPoint(PathBuf),
}

/// Looks in the directory `dir` (at `at` below the tree's root, with the
/// directories open above it in `ancestors`, the root's first) for what is
/// not the add's, deciding each entry by its `statx`: a mount point, an entry
/// named `.git` (the root's own is checked apart), or `dir` itself holding
/// `HEAD`, `objects` and `refs` where `tracked` says the add's commit does not
/// track that `HEAD`. Walks depth first, holding only the descriptors of the
/// directories above.
fn foreign_entry_in(
	dir: RawFd,
	at: &Path,
	root: &Root,
	ancestors: &mut Vec<(libc::dev_t, u64)>,
	tracked: &dyn Fn(&Path) -> bool,
) -> io::Result<Option<Foreign>> {
	let names = names(dir)?;
	if [&b"HEAD"[..], b"objects", b"refs"]
		.iter()
		.all(|wanted| names.iter().any(|name| name.as_bytes() == *wanted))
		&& !tracked(&at.join("HEAD"))
	{
		return Ok(Some(Foreign::Repository(at.to_path_buf())));
	}
	for name in names {
		let relative = at.join(OsStr::from_bytes(name.as_bytes()));
		let Some(entry) = entry_at(dir, &name)? else {
			continue;
		};
		if entry.mounted_below(&root.entry) {
			return Ok(Some(Foreign::MountPoint(relative)));
		}
		if name.as_bytes() == b".git" {
			if ancestors.len() == 1 {
				continue;
			}
			return Ok(Some(Foreign::Repository(relative)));
		}
		if !entry.is_dir() {
			continue;
		}
		may_enter(ancestors, &entry, &relative)?;
		let Some((child, opened)) = open_dir(dir, &name, &entry, &relative)? else {
			continue;
		};
		if root.other_mount(child.as_raw_fd(), &opened)? {
			return Ok(Some(Foreign::MountPoint(relative)));
		}
		ancestors.push(entry.id());
		let found = foreign_entry_in(child.as_raw_fd(), &relative, root, ancestors, tracked)?;
		ancestors.pop();
		if found.is_some() {
			return Ok(found);
		}
	}
	Ok(None)
}

impl TreeDir {
	/// Opens the directory at `path` without following a symlink there:
	/// `statx` first, then the open, which must reach that same directory
	/// (under gVisor `O_NOFOLLOW` with `O_DIRECTORY` follows a symlink).
	/// `None` when nothing is there; an error (`ENOTDIR`, `ELOOP`) when it is
	/// not a directory or changed meanwhile.
	pub fn open(path: &Path) -> io::Result<Option<Self>> {
		let path = c_name(path.as_os_str())?;
		let Some(entry) = statx_at(libc::AT_FDCWD, &path, 0)? else {
			return Ok(None);
		};
		if !entry.is_dir() {
			return Err(io::Error::from_raw_os_error(libc::ENOTDIR));
		}
		let fd = match open_at(libc::AT_FDCWD, &path, libc::O_RDONLY | libc::O_DIRECTORY) {
			Ok(fd) => fd,
			Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
			Err(err) => return Err(err),
		};
		let opened = entry_of(fd.as_raw_fd())?;
		if !opened.is_dir() || opened.id() != entry.id() {
			return Err(io::Error::from_raw_os_error(libc::ELOOP));
		}
		Ok(Some(Self(fs::File::from(fd))))
	}

	/// Whether this is the directory `mark` was set on: the same device and
	/// inode, carrying the same token.
	pub fn is(&self, mark: &TreeMark) -> io::Result<bool> {
		let meta = self.0.metadata()?;
		let token = tree_mark::get_fd(self.0.as_raw_fd())?;
		Ok(mark.is(&meta, token.as_deref()))
	}

	/// Whether this directory holds no `.git`, or a `.git` file naming the
	/// registration `admin` (a relative name taken from `tree`, the path it
	/// was opened at): anything else (a repository of its own, a `.git`
	/// naming another registration, a FIFO or other special file) is not the
	/// interrupted add's to remove. The entry's type is read before it is
	/// opened, and the open does not block.
	pub fn git_entry_is_ours(&self, tree: &Path, admin: &Path) -> bool {
		let fd = self.0.as_raw_fd();
		let entry = match entry_at(fd, c".git") {
			Ok(None) => return true,
			Ok(Some(entry)) if entry.is_file() => entry,
			_ => return false,
		};
		let Ok(opened) = open_at(fd, c".git", libc::O_RDONLY | libc::O_NONBLOCK) else {
			return false;
		};
		if !entry_of(opened.as_raw_fd()).is_ok_and(|now| now.is_file() && now.id() == entry.id()) {
			return false;
		}
		let mut text = String::new();
		if fs::File::from(opened)
			.take(GITFILE_MAX)
			.read_to_string(&mut text)
			.is_err()
		{
			return false;
		}
		text
			.trim()
			.strip_prefix("gitdir:")
			.map(|raw| tree.join(raw.trim()))
			.is_some_and(|named| resolve_leaf(&named) == resolve_leaf(admin))
	}

	/// The first entry of this directory's tree that is not the add's: a
	/// mount point below the root, an entry named `.git` below the root (the
	/// root's own is not looked at), or a directory, the root included,
	/// holding `HEAD`, `objects` and `refs` whose `HEAD` `tracked` (a path
	/// relative to the root) says the add's commit does not track. Walks every
	/// subdirectory without following a symlink or descending onto another
	/// mount. An error carrying a [`Stop`] is a walk that stopped before
	/// anything was removed.
	pub fn foreign_entry(&self, tracked: &dyn Fn(&Path) -> bool) -> io::Result<Option<Foreign>> {
		let root = Root::of(self.0.as_raw_fd())?;
		let mut ancestors = vec![root.entry.id()];
		foreign_entry_in(self.0.as_raw_fd(), Path::new(""), &root, &mut ancestors, tracked)
	}

	/// Adds the owner's read, write and search bits to this directory's mode,
	/// so its entries can be removed and new ones written.
	pub fn make_owner_writable(&self) -> io::Result<()> {
		use std::os::unix::fs::PermissionsExt;
		let mut mode = self.0.metadata()?.permissions();
		if mode.mode() & 0o700 != 0o700 {
			mode.set_mode(mode.mode() | 0o700);
			self.0.set_permissions(mode)?;
		}
		Ok(())
	}

	/// Removes everything in this directory, keeping the directory. It stops
	/// at a mount point, before touching anything on that mount; an error
	/// carrying a [`Stop`] names where, relative to this directory.
	pub fn empty(&self) -> io::Result<()> {
		let root = Root::of(self.0.as_raw_fd())?;
		let mut ancestors = vec![root.entry.id()];
		remove_all_in(self.0.as_raw_fd(), Path::new(""), &root, &mut ancestors)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const fn entry(kind: libc::mode_t, dev: libc::dev_t, mount: Option<u64>) -> Entry {
		Entry { kind, dev, ino: 7, mount, mount_root: false }
	}

	/// An entry of any type is a mount point when it is on another mount than
	/// the root or is a mount's root; a device of its own makes a mount point
	/// of a directory only (an overlay whose layers lie on two filesystems
	/// gives its files another device than its directories, on one mount).
	#[test]
	fn mounted_below_compares_devices_for_directories_only() {
		let root = entry(libc::S_IFDIR, 421, Some(3880));
		let cases = [
			("directory, same mount", entry(libc::S_IFDIR, 421, Some(3880)), false),
			("directory, other mount", entry(libc::S_IFDIR, 421, Some(3881)), true),
			("directory, other device", entry(libc::S_IFDIR, 2304, Some(3880)), true),
			("directory, no mount id, same device", entry(libc::S_IFDIR, 421, None), false),
			("file, other device", entry(libc::S_IFREG, 422, Some(3880)), false),
			("symlink, other device", entry(libc::S_IFLNK, 422, Some(3880)), false),
			("file, other mount", entry(libc::S_IFREG, 421, Some(3881)), true),
			("file, no mount id, other device", entry(libc::S_IFREG, 422, None), false),
		];
		for (what, case, mounted) in cases {
			assert_eq!(case.mounted_below(&root), mounted, "{what}");
		}
		for kind in [libc::S_IFDIR, libc::S_IFREG] {
			let mut mount_root = entry(kind, 421, Some(3880));
			mount_root.mount_root = true;
			assert!(mount_root.mounted_below(&root), "a mount's root of type {kind:o}");
		}
	}

	#[test]
	fn parse_mnt_id_reads_the_fdinfo_line() {
		assert_eq!(parse_mnt_id("pos:\t0\nflags:\t02100000\nmnt_id:\t3880\nino:\t43\n"), Some(3880));
		assert_eq!(parse_mnt_id("pos:\t0\nflags:\t02100000\n"), None);
	}

	/// An open directory's mount id comes from `statx` or, without it (a
	/// kernel before 5.8), from `/proc/self/fdinfo`; one of them is there.
	#[test]
	fn an_open_directory_has_a_mount_id() {
		let dir = tempfile::tempdir().unwrap();
		let fd = fs::File::open(dir.path()).unwrap();
		let statx = entry_of(fd.as_raw_fd()).unwrap().mount;
		let fdinfo = mount_id(fd.as_raw_fd(), None).unwrap();
		assert!(statx.is_some() || fdinfo.is_some(), "neither statx nor fdinfo gives a mount id");
		assert!(mount_id(fd.as_raw_fd(), statx).unwrap().is_some());
	}

	/// A failed read of `/proc/self/fdinfo` is given as that error, in a stop
	/// that names it, not as a system without mount ids.
	#[test]
	fn an_unreadable_fdinfo_gives_its_error() {
		// No process has a descriptor this high: Linux caps them far below.
		let closed = libc::c_int::MAX;
		let err = mount_id(closed, None).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::NotFound, "{err}");
		let err = mount_id_or_stop(closed, None).unwrap_err();
		let reason = stop_of(&err)
			.expect("not a stop")
			.reason(Path::new("/t/wt"));
		assert!(
			reason.contains("reading them from `/proc/self/fdinfo` failed")
				&& reason.contains("os error 2"),
			"{reason}"
		);
	}

	/// `Root::other_mount` tells a directory on another mount from one on the
	/// root's, with the mount ids `statx` gives and, as before Linux 5.8, with
	/// those of `/proc/self/fdinfo` alone: `/proc` is always a mount of its
	/// own, and a subdirectory of the root is on the root's mount. Before 5.8
	/// this comparison is all that refuses a bind mount from the tree's own
	/// filesystem, which has the root's device.
	#[test]
	fn other_mount_tells_a_mount_from_a_subdirectory() {
		use super::super::test_hooks::{self, MountIds};
		let dir = tempfile::tempdir().unwrap();
		fs::create_dir(dir.path().join("sub")).unwrap();
		for ids in [MountIds::Statx, MountIds::FdinfoOnly] {
			test_hooks::set_mount_ids(ids);
			let root_fd = fs::File::open(dir.path()).unwrap();
			let root = Root::of(root_fd.as_raw_fd()).unwrap();
			for (path, other) in [(Path::new("/proc"), true), (&dir.path().join("sub"), false)] {
				let fd = fs::File::open(path).unwrap();
				let child = entry_of(fd.as_raw_fd()).unwrap();
				if ids == MountIds::FdinfoOnly {
					assert_eq!(child.mount, None, "statx's mount id was not hidden");
				}
				assert_eq!(
					root.other_mount(fd.as_raw_fd(), &child).unwrap(),
					other,
					"{} with mount ids from {ids:?}",
					path.display()
				);
			}
			test_hooks::clear();
		}
	}

	/// A symlink to a directory is not opened as the tree's root (under gVisor
	/// the open itself would follow it).
	#[test]
	fn the_root_is_not_opened_through_a_symlink() {
		let dir = tempfile::tempdir().unwrap();
		let target = dir.path().join("target");
		fs::create_dir(&target).unwrap();
		let link = dir.path().join("link");
		std::os::unix::fs::symlink(&target, &link).unwrap();
		let err = TreeDir::open(&link)
			.err()
			.expect("a symlink was opened as the root");
		assert!(matches!(err.raw_os_error(), Some(libc::ENOTDIR | libc::ELOOP)), "{err}");
		assert!(TreeDir::open(&target).unwrap().is_some());
	}
}
