//! Linux directory reads:
//!
//! - Directory and file opens request `O_NOATIME` so walking does not dirty
//!   inode atimes. The kernel only allows it for the file owner (or
//!   `CAP_FOWNER`): an open refused with `EPERM` is retried once without it,
//!   and only when that retry opens is it disabled for the rest of the process
//!   ([`with_noatime`]).
//! - Opens below a walk root ([`open_beneath`]) are one `openat2` with
//!   `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`, which refuses any symlink on the
//!   way and any escape from the root; kernels and sandboxes without `openat2`
//!   get the portable one-component-at-a-time walk.
//! - Listings use raw `getdents64` into a large reusable buffer, parsed in
//!   place; `d_type` supplies entry types without per-entry stat calls.
//! - Full detail and `DT_UNKNOWN` entries use `statx` with only the needed
//!   fields (type, size, mtime) and `AT_STATX_DONT_SYNC`, so network
//!   filesystems answer from cached attributes. Kernels or seccomp policies
//!   without `statx` fall back to `fstatat`.
//!
//! `getdents64` has no end-of-directory flag, and a short read is not proof of
//! EOF (the kernel also stops filling early when a signal is pending). The end
//! is recognised from the position cookie instead (see [`list`]); on
//! filesystems without such a cookie (XFS, older tmpfs) a listing ends with one
//! empty call.

use std::{
	ffi::{c_char, c_int, c_long, c_uint},
	io,
	mem::MaybeUninit,
	os::fd::{FromRawFd, OwnedFd, RawFd},
	sync::atomic::{AtomicBool, AtomicI32, Ordering},
};

use super::{
	aligned_buf, is_dot_or_dot_dot, le16, le64,
	unix::{Scratch, nanos, type_of_dt, type_of_mode, walk_beneath},
};
use crate::fs::{Detail, FileInfo, FileType, Listing, Stamp};

/// On a 16-vCPU arm64 VM, 8 workers walked faster and steadier than 16
/// (kernel contention on fd-table and dcache locks grows with thread count).
pub(super) const WORKERS: usize = 8;

const LIST_BUF: usize = 128 << 10;

// struct linux_dirent64 field offsets.
const DIRENT_INO: usize = 0;
const DIRENT_OFF: usize = 8;
const DIRENT_RECLEN: usize = 16;
const DIRENT_TYPE: usize = 18;
const DIRENT_NAME: usize = 19;

const STATX_TYPE: c_uint = 0x1;
const STATX_MTIME: c_uint = 0x40;
const STATX_CTIME: c_uint = 0x80;
const STATX_INO: c_uint = 0x100;
const STATX_SIZE: c_uint = 0x200;
const AT_NO_AUTOMOUNT: c_int = 0x800;
const AT_STATX_DONT_SYNC: c_int = 0x4000;

const ENTRY_MASK: c_uint = STATX_TYPE | STATX_SIZE | STATX_MTIME;
const ENTRY_FLAGS: c_int = libc::AT_SYMLINK_NOFOLLOW | AT_NO_AUTOMOUNT | AT_STATX_DONT_SYNC;
const STAMP_MASK: c_uint = STATX_TYPE | STATX_INO | STATX_SIZE | STATX_MTIME | STATX_CTIME;

/// `O_NOATIME` until an open refused with `EPERM` opens without it.
static NOATIME: AtomicI32 = AtomicI32::new(libc::O_NOATIME);

/// Set once `statx` reports `ENOSYS` or `EPERM` (seccomp).
static NO_STATX: AtomicBool = AtomicBool::new(false);

/// Set once `openat2` turns out to be missing (`ENOSYS`, or `E2BIG` from a
/// kernel that does not know its argument's size), or refused where the walk
/// then opens the same path: `EINVAL` from a kernel or sandbox that does not
/// know its arguments, `EPERM` from a policy that allows `openat`. The same
/// errors from the file's own open fail the walk too and leave it unset.
static NO_OPENAT2: AtomicBool = AtomicBool::new(false);

/// `struct open_how` of `openat2(2)`.
#[repr(C)]
struct OpenHow {
	flags:   u64,
	mode:    u64,
	resolve: u64,
}

/// No symlink anywhere on the way (the last component and magic links
/// included), and nothing outside the directory the path starts from.
const RESOLVE: u64 = libc::RESOLVE_BENEATH | libc::RESOLVE_NO_SYMLINKS;

/// `struct statx_timestamp`.
#[repr(C)]
#[allow(dead_code, reason = "mirrors the kernel ABI")]
#[derive(Clone, Copy)]
struct StatxTimestamp {
	sec:       i64,
	nsec:      u32,
	_reserved: i32,
}

/// `struct statx` (256 bytes).
#[repr(C)]
#[allow(dead_code, reason = "mirrors the kernel ABI; only some fields are read")]
#[derive(Clone, Copy)]
struct Statx {
	mask:            u32,
	blksize:         u32,
	attributes:      u64,
	nlink:           u32,
	uid:             u32,
	gid:             u32,
	mode:            u16,
	_spare0:         u16,
	ino:             u64,
	size:            u64,
	blocks:          u64,
	attributes_mask: u64,
	atime:           StatxTimestamp,
	btime:           StatxTimestamp,
	ctime:           StatxTimestamp,
	mtime:           StatxTimestamp,
	rdev_major:      u32,
	rdev_minor:      u32,
	dev_major:       u32,
	dev_minor:       u32,
	_spare:          [u64; 14],
}

const _: () = assert!(size_of::<Statx>() == 256);

/// Runs `open` with the process's `O_NOATIME` flag (or 0), retrying `EINTR`.
/// An `EPERM` with the flag is retried once without it, and the flag is
/// disabled for the process only when that retry opens: then the flag was
/// the cause (not the file's owner). An `EPERM` the retry repeats has
/// another cause, such as a sandbox policy or the file's own refusal, and is
/// returned with the flag left on.
fn with_noatime(mut open: impl FnMut(c_int) -> io::Result<RawFd>) -> io::Result<OwnedFd> {
	let noatime = NOATIME.load(Ordering::Relaxed);
	let mut extra = noatime;
	loop {
		match open(extra) {
			Ok(fd) => {
				if extra != noatime {
					NOATIME.store(0, Ordering::Relaxed);
				}
				// SAFETY: the open returned a fresh descriptor this call owns.
				return Ok(unsafe { OwnedFd::from_raw_fd(fd) });
			},
			Err(err) => match err.raw_os_error() {
				Some(libc::EINTR) => {},
				Some(libc::EPERM) if extra != 0 => extra = 0,
				_ => return Err(err),
			},
		}
	}
}

/// The descriptor an open syscall returned in `ret`, or the error `errno`
/// holds.
fn opened(ret: c_long) -> io::Result<RawFd> {
	match RawFd::try_from(ret) {
		Ok(fd) if fd >= 0 => Ok(fd),
		_ => Err(io::Error::last_os_error()),
	}
}

pub(super) fn openat(dir: RawFd, path: *const c_char, flags: c_int) -> io::Result<OwnedFd> {
	with_noatime(|extra| {
		#[cfg(test)]
		if let Some(err) = seam::failed(seam::Call::Openat, flags | extra) {
			return Err(err);
		}
		// SAFETY: `path` is a NUL-terminated string the caller keeps alive; the
		// flags never include `O_CREAT`, so no mode argument is read.
		opened(c_long::from(unsafe { libc::openat(dir, path, flags | extra) }))
	})
}

/// Opens the relative `rel` (`/`-separated names, none empty, `.` or `..`)
/// below `dir` with `flags` (which carry `O_NOFOLLOW`), following no symlink
/// on the way: one `openat2` that resolves only below `dir` and refuses every
/// symlink (`ELOOP`), else [`walk_beneath`]. A rename racing the resolution
/// (`EAGAIN`) is answered by the walk too.
pub(super) fn open_beneath(
	s: &mut Scratch,
	dir: RawFd,
	rel: &[u8],
	flags: c_int,
) -> io::Result<OwnedFd> {
	if NO_OPENAT2.load(Ordering::Relaxed) {
		return walk_beneath(s, dir, rel, flags);
	}
	let path = s.cstr(rel)?;
	let openat2 = with_noatime(|extra| {
		#[cfg(test)]
		if let Some(err) = seam::failed(seam::Call::Openat2, flags | extra) {
			return Err(err);
		}
		let how = OpenHow {
			flags:   u64::from((flags | extra).cast_unsigned()),
			mode:    0,
			resolve: RESOLVE,
		};
		// SAFETY: `path` is a NUL-terminated string the scratch keeps alive,
		// and `how` is an `open_how` of the size passed.
		opened(unsafe {
			libc::syscall(libc::SYS_openat2, dir, path, &raw const how, size_of::<OpenHow>())
		})
	});
	let err = match openat2 {
		Ok(fd) => return Ok(fd),
		Err(err) => err,
	};
	match err.raw_os_error() {
		Some(libc::ENOSYS | libc::E2BIG) => {
			NO_OPENAT2.store(true, Ordering::Relaxed);
			walk_beneath(s, dir, rel, flags)
		},
		Some(libc::EAGAIN) => walk_beneath(s, dir, rel, flags),
		// `openat2` refused (arguments the kernel or sandbox does not know, a
		// policy refusing the call), or the file's own refusal: the walk opens
		// what `openat` may open, and only its success shows it was the call.
		Some(libc::EINVAL | libc::EPERM) => {
			let walked = walk_beneath(s, dir, rel, flags);
			if walked.is_ok() {
				NO_OPENAT2.store(true, Ordering::Relaxed);
			}
			walked
		},
		_ => Err(err),
	}
}

/// Reads every entry of `dir` into `out`.
pub(super) fn list(
	s: &mut Scratch,
	dir: RawFd,
	detail: Detail,
	_children: u32,
	out: &mut Listing,
) -> io::Result<()> {
	let buf = aligned_buf(&mut s.buf, LIST_BUF);
	loop {
		// SAFETY: `buf` is writable for its whole length.
		let n = unsafe {
			libc::syscall(libc::SYS_getdents64, c_long::from(dir), buf.as_mut_ptr(), buf.len())
		};
		if n < 0 {
			let err = io::Error::last_os_error();
			if err.kind() == io::ErrorKind::Interrupted {
				continue;
			}
			return Err(err);
		}
		let n = n as usize;
		if n == 0 {
			return Ok(());
		}
		let mut next = 0i64;
		let mut off = 0;
		while off + DIRENT_NAME <= n {
			let rec = &buf[off..n];
			let reclen = le16(rec, DIRENT_RECLEN) as usize;
			if reclen < DIRENT_NAME || reclen > rec.len() {
				return Err(io::Error::from_raw_os_error(libc::EIO));
			}
			let rec = &rec[..reclen];
			off += reclen;
			next = le64(rec, DIRENT_OFF) as i64;
			if le64(rec, DIRENT_INO) == 0 {
				continue;
			}
			let raw = &rec[DIRENT_NAME..];
			let Some(nul) = memchr::memchr(0, raw) else {
				continue;
			};
			let name = &raw[..nul];
			if name.is_empty() || is_dot_or_dot_dot(name) {
				continue;
			}
			let dt = rec[DIRENT_TYPE];
			let listed = type_of_dt(dt);
			if listed.is_none() && dt != libc::DT_UNKNOWN {
				continue;
			}
			match listed {
				Some(file_type) if detail == Detail::Minimal => {
					out.push(name, file_type, None, None, 0);
				},
				_ => {
					// The name is NUL-terminated in place.
					let Some((file_type, size, mtime)) = stat_entry(dir, raw.as_ptr().cast()) else {
						continue;
					};
					out.push(name, file_type, size, Some(mtime), 0);
				},
			}
		}
		// The kernel stores the directory position after the batch in the last
		// entry's d_off. ext4 (htree), Btrfs, tmpfs, and overlayfs move it to
		// their end-of-directory cookie (INT32_MAX/INT64_MAX) once everything
		// was returned, so the confirming empty call can be skipped. A batch cut
		// short (buffer full, signal pending) carries the next real position.
		if next == i64::from(i32::MAX) || next == i64::MAX {
			return Ok(());
		}
	}
}

/// `statx`, or `None` once the kernel or a seccomp policy has rejected it.
fn statx(dir: RawFd, path: *const c_char, flags: c_int, mask: c_uint) -> Option<io::Result<Statx>> {
	if NO_STATX.load(Ordering::Relaxed) {
		return None;
	}
	let mut stx = MaybeUninit::<Statx>::zeroed();
	loop {
		// SAFETY: `path` is NUL-terminated and `stx` is a valid out-pointer of
		// the kernel's `struct statx` size.
		let r = unsafe {
			libc::syscall(
				libc::SYS_statx,
				c_long::from(dir),
				path,
				c_long::from(flags),
				c_long::from(mask),
				stx.as_mut_ptr(),
			)
		};
		if r == 0 {
			// SAFETY: zero-initialized plain data the kernel filled.
			return Some(Ok(unsafe { stx.assume_init() }));
		}
		let err = io::Error::last_os_error();
		match err.raw_os_error() {
			Some(libc::EINTR) => {},
			// Pre-4.11 kernels lack statx; older container seccomp profiles
			// reject it with EPERM. fstatat answers the same.
			Some(libc::ENOSYS | libc::EPERM) => {
				NO_STATX.store(true, Ordering::Relaxed);
				return None;
			},
			_ => return Some(Err(err)),
		}
	}
}

/// `fstatat`, retrying `EINTR`.
fn fstatat(dir: RawFd, path: *const c_char, flags: c_int) -> io::Result<libc::stat> {
	let mut st = MaybeUninit::<libc::stat>::uninit();
	loop {
		// SAFETY: `path` is NUL-terminated and `st` is a valid out-pointer.
		if unsafe { libc::fstatat(dir, path, st.as_mut_ptr(), flags) } == 0 {
			// SAFETY: `fstatat` succeeded and filled `st`.
			return Ok(unsafe { st.assume_init() });
		}
		let err = io::Error::last_os_error();
		if err.kind() != io::ErrorKind::Interrupted {
			return Err(err);
		}
	}
}

/// Type, regular-file size, and mtime of `name` in `dir`, not following
/// symlinks; `None` for special files and entries that vanished.
fn stat_entry(dir: RawFd, name: *const c_char) -> Option<(FileType, Option<u64>, i64)> {
	if let Some(result) = statx(dir, name, ENTRY_FLAGS, ENTRY_MASK) {
		let stx = result.ok()?;
		let file_type = type_of_mode(libc::mode_t::from(stx.mode))?;
		let size = (file_type == FileType::File).then_some(stx.size);
		return Some((file_type, size, nanos(stx.mtime.sec, i64::from(stx.mtime.nsec))));
	}
	let st = fstatat(dir, name, libc::AT_SYMLINK_NOFOLLOW).ok()?;
	let file_type = type_of_mode(st.st_mode)?;
	let size = (file_type == FileType::File).then_some(st.st_size as u64);
	Some((file_type, size, nanos(st.st_mtime, st.st_mtime_nsec)))
}

pub(super) fn stat_path(path: *const c_char, follow: bool) -> io::Result<FileInfo> {
	let flags = if follow { 0 } else { libc::AT_SYMLINK_NOFOLLOW };
	stamp_at(libc::AT_FDCWD, path, flags)
}

pub(super) fn stat_fd(fd: RawFd) -> io::Result<FileInfo> {
	stamp_at(fd, c"".as_ptr(), libc::AT_EMPTY_PATH)
}

fn stamp_at(dir: RawFd, path: *const c_char, flags: c_int) -> io::Result<FileInfo> {
	if let Some(result) = statx(dir, path, flags | AT_NO_AUTOMOUNT, STAMP_MASK) {
		let stx = result?;
		return Ok(FileInfo {
			file_type: type_of_mode(libc::mode_t::from(stx.mode)),
			size:      stx.size,
			stamp:     Stamp {
				dev:   libc::makedev(stx.dev_major, stx.dev_minor),
				ino:   stx.ino,
				mtime: nanos(stx.mtime.sec, i64::from(stx.mtime.nsec)),
				ctime: nanos(stx.ctime.sec, i64::from(stx.ctime.nsec)),
			},
		});
	}
	let st = fstatat(dir, path, flags)?;
	Ok(FileInfo {
		file_type: type_of_mode(st.st_mode),
		size:      st.st_size as u64,
		stamp:     Stamp {
			dev:   st.st_dev as u64,
			ino:   st.st_ino as u64,
			mtime: nanos(st.st_mtime, st.st_mtime_nsec),
			ctime: nanos(st.st_ctime, st.st_ctime_nsec),
		},
	})
}

/// Admits local filesystems that keep sub-second timestamps from the local
/// clock. NFS, CIFS, FUSE, and overlayfs (whose merged directories need not
/// change when a lower layer does) are listed every time.
pub(super) fn fine_timestamps(fd: RawFd) -> bool {
	const EXT4: u32 = 0xef53;
	const XFS: u32 = 0x5846_5342;
	const BTRFS: u32 = 0x9123_683e;
	const TMPFS: u32 = 0x0102_1994;
	const F2FS: u32 = 0xf2f5_2010;
	const BCACHEFS: u32 = 0xca45_1a4e;
	const ZFS: u32 = 0x2fc1_2fc1;
	let mut fs = MaybeUninit::<libc::statfs>::uninit();
	// SAFETY: `fs` is a valid out-pointer.
	if unsafe { libc::fstatfs(fd, fs.as_mut_ptr()) } != 0 {
		return false;
	}
	// SAFETY: `fstatfs` succeeded and filled `fs`.
	let magic = unsafe { fs.assume_init_ref() }.f_type as u32;
	matches!(magic, EXT4 | XFS | BTRFS | TMPFS | F2FS | BCACHEFS | ZFS)
}

/// Test seam for the open syscalls' error paths: a test names, per call and
/// its flags, the `errno` the call fails with on the test's own thread,
/// instead of running it.
#[cfg(test)]
mod seam {
	use std::{cell::RefCell, ffi::c_int, io};

	/// The open syscall a [`fail_opens`] closure is asked about.
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub(super) enum Call {
		/// `openat`, by path or for one component of a walk below a root.
		Openat,
		/// `openat2` below a root.
		Openat2,
	}

	type Fail = Box<dyn FnMut(Call, c_int) -> Option<c_int>>;

	thread_local! {
		static FAIL: RefCell<Option<Fail>> = const { RefCell::new(None) };
	}

	/// Fails this thread's open syscalls for which `fail` returns an `errno`,
	/// until the returned guard drops.
	pub(super) fn fail_opens(fail: impl FnMut(Call, c_int) -> Option<c_int> + 'static) -> Failing {
		FAIL.with_borrow_mut(|slot| *slot = Some(Box::new(fail)));
		Failing
	}

	/// Runs this thread's open syscalls again when dropped.
	pub(super) struct Failing;

	impl Drop for Failing {
		fn drop(&mut self) {
			FAIL.with_borrow_mut(|slot| *slot = None);
		}
	}

	/// The error `call` with `flags` fails with on this thread, if any.
	pub(super) fn failed(call: Call, flags: c_int) -> Option<io::Error> {
		FAIL
			.with_borrow_mut(|slot| slot.as_mut()?(call, flags))
			.map(io::Error::from_raw_os_error)
	}
}

#[cfg(test)]
mod tests {
	use std::{
		ffi::{CString, c_int},
		fs,
		os::{fd::AsRawFd, unix::ffi::OsStrExt},
		path::PathBuf,
		sync::atomic::Ordering,
	};

	use parking_lot::Mutex;

	use super::{
		NO_OPENAT2, NOATIME, OpenHow, RESOLVE, Scratch, open_beneath, openat,
		seam::{Call, fail_opens},
	};

	/// A file open below a root.
	const FLAGS: c_int = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW;

	/// Serializes the tests that switch the process's fallbacks.
	static SWITCHES: Mutex<()> = Mutex::new(());

	/// A directory holding `a/f`, removed on drop.
	struct Tree(PathBuf);

	impl Tree {
		fn new(tag: &str) -> Self {
			let base =
				std::env::temp_dir().join(format!("pi-walker-linux-{tag}-{}", std::process::id()));
			let _ = fs::remove_dir_all(&base);
			fs::create_dir_all(base.join("a")).expect("create a");
			fs::write(base.join("a/f"), "f").expect("write a/f");
			Self(base)
		}

		/// `a/f` as a NUL-terminated absolute path.
		fn file(&self) -> CString {
			CString::new(self.0.join("a/f").as_os_str().as_bytes()).expect("no NUL")
		}
	}

	impl Drop for Tree {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	/// Puts the process's fallbacks back in their starting state.
	fn reset() {
		NOATIME.store(libc::O_NOATIME, Ordering::SeqCst);
		NO_OPENAT2.store(false, Ordering::SeqCst);
	}

	/// Whether the kernel opens `a/f` below `root` with `openat2`.
	fn openat2_works(root: c_int) -> bool {
		let how = OpenHow { flags: u64::from(FLAGS.cast_unsigned()), mode: 0, resolve: RESOLVE };
		// SAFETY: the path is a NUL-terminated literal, and `how` is an
		// `open_how` of the size passed.
		let fd = unsafe {
			libc::syscall(
				libc::SYS_openat2,
				root,
				c"a/f".as_ptr(),
				&raw const how,
				size_of::<OpenHow>(),
			)
		};
		if fd >= 0 {
			// SAFETY: `fd` is a descriptor this call opened.
			unsafe { libc::close(fd as c_int) };
		}
		fd >= 0
	}

	/// An `EPERM` turns `O_NOATIME` off only when the same open without it
	/// opens: a policy refusing the call keeps it on, for `openat2` (which the
	/// walk then replaces) and for `openat`.
	#[test]
	fn an_eperm_turns_o_noatime_off_only_when_the_open_without_it_opens() {
		let _serial = SWITCHES.lock();
		let tree = Tree::new("noatime");
		let root = fs::File::open(&tree.0).expect("open the root");
		let mut s = Scratch::default();

		reset();
		let failing = fail_opens(|call, _| (call == Call::Openat2).then_some(libc::EPERM));
		let opened = open_beneath(&mut s, root.as_raw_fd(), b"a/f", FLAGS);
		drop(failing);
		opened.expect("the walk opens the file");
		assert_eq!(
			NOATIME.load(Ordering::SeqCst),
			libc::O_NOATIME,
			"a refused openat2 turned O_NOATIME off"
		);
		assert!(NO_OPENAT2.load(Ordering::SeqCst), "the refused openat2 is set aside");

		reset();
		let failing = fail_opens(|call, _| (call == Call::Openat).then_some(libc::EPERM));
		let err = openat(libc::AT_FDCWD, tree.file().as_ptr(), FLAGS).unwrap_err();
		drop(failing);
		assert_eq!(err.raw_os_error(), Some(libc::EPERM));
		assert_eq!(
			NOATIME.load(Ordering::SeqCst),
			libc::O_NOATIME,
			"a refused openat turned O_NOATIME off"
		);

		// The kernel refusing `O_NOATIME` itself (not the file's owner).
		let noatime_refused = |at: Call| {
			move |call, flags: c_int| {
				(call == at && flags & libc::O_NOATIME != 0).then_some(libc::EPERM)
			}
		};
		reset();
		let failing = fail_opens(noatime_refused(Call::Openat));
		let opened = openat(libc::AT_FDCWD, tree.file().as_ptr(), FLAGS);
		drop(failing);
		opened.expect("opens without O_NOATIME");
		assert_eq!(
			NOATIME.load(Ordering::SeqCst),
			0,
			"O_NOATIME stays on after the kernel refused it"
		);
		if openat2_works(root.as_raw_fd()) {
			reset();
			let failing = fail_opens(noatime_refused(Call::Openat2));
			let opened = open_beneath(&mut s, root.as_raw_fd(), b"a/f", FLAGS);
			drop(failing);
			opened.expect("opens without O_NOATIME");
			assert_eq!(
				NOATIME.load(Ordering::SeqCst),
				0,
				"O_NOATIME stays on after the kernel refused it"
			);
			assert!(!NO_OPENAT2.load(Ordering::SeqCst), "openat2 was set aside");
		} else {
			eprintln!("UNKNOWN: this kernel has no openat2; its O_NOATIME refusal was not checked");
		}
		reset();
	}

	/// An `EINVAL` sets `openat2` aside only when the walk then opens the
	/// path: one from the file's own open fails the walk too.
	#[test]
	fn an_einval_sets_openat2_aside_only_when_the_walk_opens() {
		let _serial = SWITCHES.lock();
		let tree = Tree::new("einval");
		let root = fs::File::open(&tree.0).expect("open the root");
		let mut s = Scratch::default();

		reset();
		let failing = fail_opens(|_, flags| (flags & libc::O_DIRECTORY == 0).then_some(libc::EINVAL));
		let err = open_beneath(&mut s, root.as_raw_fd(), b"a/f", FLAGS).unwrap_err();
		drop(failing);
		assert_eq!(err.raw_os_error(), Some(libc::EINVAL));
		assert!(!NO_OPENAT2.load(Ordering::SeqCst), "the file's own EINVAL set openat2 aside");

		reset();
		let failing = fail_opens(|call, _| (call == Call::Openat2).then_some(libc::EINVAL));
		let opened = open_beneath(&mut s, root.as_raw_fd(), b"a/f", FLAGS);
		drop(failing);
		opened.expect("the walk opens the file");
		assert!(
			NO_OPENAT2.load(Ordering::SeqCst),
			"an openat2 the kernel does not know stays in use"
		);
		reset();
	}
}
