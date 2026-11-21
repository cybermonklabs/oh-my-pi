//! Cross-process advisory locks backed by platform ownership primitives.
//!
//! Windows uses named mutexes, so it leaves no filesystem artifact. Unix
//! platforms lock a persistent sidecar: Linux takes an open-file-description
//! record lock, other Unix platforms `flock(2)`. Linux also treats a path as
//! held while an older build still binds its abstract-socket name.

use std::{io, path::Path};

use napi::JsString;
use napi_derive::napi;

use crate::js;

#[cfg(target_os = "linux")]
mod legacy_abstract;
#[cfg(unix)]
mod unix;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(unix)]
use unix as platform;
#[cfg(target_os = "windows")]
use windows as platform;

#[cfg(not(any(unix, target_os = "windows")))]
compile_error!("omp-natives file locks require Unix or Windows");

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn memory_lock_name(path: &str) -> String {
	const HIGH_SEED: u64 = 0x4f4d_502d_4c4f_434b;
	const LOW_SEED: u64 = 0x5049_2d46_494c_454c;
	let bytes = path.as_bytes();
	let high = xxhash_rust::xxh64::xxh64(bytes, HIGH_SEED);
	let low = xxhash_rust::xxh64::xxh64(bytes, LOW_SEED);
	format!("omp-file-lock-{high:016x}{low:016x}")
}

/// Process-owned cross-platform advisory lock.
///
/// `tryAcquire()` is non-blocking; its returned handle reports whether it won
/// through `acquired`. Ownership ends on `release()`, garbage collection, or
/// process exit; `release()` is idempotent.
#[napi(js_name = "FileLock")]
pub struct FileLock {
	inner: Option<platform::PlatformFileLock>,
}

#[napi]
impl FileLock {
	/// Try to acquire a lock directly from native Rust code.
	///
	/// This is crate-only so native subsystems share the same kernel-backed
	/// ownership primitive without exposing another JavaScript API.
	pub(crate) fn try_acquire_path(path: &Path) -> io::Result<Self> {
		let path = path.to_str().ok_or_else(|| {
			io::Error::new(io::ErrorKind::InvalidInput, "lock path is not valid UTF-8")
		})?;
		let inner = platform::try_acquire(path)?;
		#[cfg(target_os = "linux")]
		let inner = if inner.is_some() && legacy_abstract::is_bound(path)? {
			None
		} else {
			inner
		};
		Ok(Self { inner })
	}

	pub(crate) fn is_held_path(path: &str) -> io::Result<bool> {
		let held = platform::is_held(path)?;
		#[cfg(target_os = "linux")]
		let held = held || legacy_abstract::is_bound(path)?;
		Ok(held)
	}

	/// Try to acquire `path` without blocking.
	#[napi(factory)]
	pub fn try_acquire(path: JsString) -> napi::Result<Self> {
		let path = js::utf8(path)?;
		Self::try_acquire_path(Path::new(&*path)).map_err(|error| {
			napi::Error::from_reason(format!(
				"Failed to acquire native file lock for {}: {error}",
				&*path
			))
		})
	}

	/// Whether any handle, in any process including this one, holds `path`.
	///
	/// Observes without taking the lock: an `F_OFD_GETLK` query plus a
	/// `connect(2)` probe of the older abstract-socket name on Linux, an
	/// `F_GETLK` query on other Unix platforms, a `\BaseNamedObjects` directory
	/// listing on Windows. A concurrent `tryAcquire()` never meets it.
	#[napi]
	pub fn is_held(path: JsString) -> napi::Result<bool> {
		let path = js::utf8(path)?;
		Self::is_held_path(&path).map_err(|error| {
			napi::Error::from_reason(format!(
				"Failed to probe native file lock for {}: {error}",
				&*path
			))
		})
	}

	/// Whether this handle owns the requested lock.
	#[napi(getter)]
	#[allow(clippy::missing_const_for_fn, reason = "napi method signature")]
	pub fn acquired(&self) -> bool {
		self.is_acquired()
	}

	/// Whether this native handle owns the requested lock.
	pub(crate) const fn is_acquired(&self) -> bool {
		self.inner.is_some()
	}

	/// Release this handle's ownership without affecting a successor.
	#[napi]
	pub fn release(&mut self) -> napi::Result<()> {
		self.release_native().map_err(|error| {
			napi::Error::from_reason(format!("Failed to release native file lock: {error}"))
		})
	}

	/// Release native ownership while preserving the handle on failure.
	pub(crate) fn release_native(&mut self) -> io::Result<()> {
		let Some(mut inner) = self.inner.take() else {
			return Ok(());
		};
		if let Err(error) = inner.release() {
			self.inner = Some(inner);
			return Err(error);
		}
		Ok(())
	}
}

impl Drop for FileLock {
	fn drop(&mut self) {
		if let Some(inner) = self.inner.as_mut() {
			let _ = inner.release();
		}
	}
}

// Android has no probe (`unix::is_held` reports Unsupported).
#[cfg(all(test, not(target_os = "android")))]
mod tests {
	use std::time::{SystemTime, UNIX_EPOCH};

	use super::platform::{is_held, try_acquire};

	fn unique_lock_path(label: &str) -> String {
		let nonce = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system clock")
			.as_nanos();
		let path =
			std::env::temp_dir().join(format!("omp-file-lock-{label}-{}-{nonce}", std::process::id()));
		path.to_str().expect("utf-8 temp path").to_owned()
	}

	#[test]
	fn probe_sees_holder_without_taking_the_lock() {
		let path = unique_lock_path("probe");
		let path = path.as_str();
		assert!(!is_held(path).expect("probe unlocked path"));
		let mut lease = try_acquire(path).expect("acquire").expect("free lease");
		assert!(is_held(path).expect("probe held path"));
		lease.release().expect("release");
		assert!(!is_held(path).expect("probe released path"));
		// A probe never leaves the path held for the next acquirer.
		let mut successor = try_acquire(path)
			.expect("reacquire")
			.expect("probe left the lease free");
		successor.release().expect("release successor");
		let _ = std::fs::remove_file(path);
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn lock_held_by_an_older_build_is_respected() {
		use std::{
			os::{
				linux::net::SocketAddrExt,
				unix::net::{SocketAddr, UnixDatagram},
			},
			path::Path,
		};

		use super::FileLock;

		let path = unique_lock_path("legacy");
		let name = super::memory_lock_name(&path);
		let address = SocketAddr::from_abstract_name(name.as_bytes()).expect("abstract name");
		let older_build = UnixDatagram::bind_addr(&address).expect("bind the older build's name");

		let refused = FileLock::try_acquire_path(Path::new(&path)).expect("acquire attempt");
		assert!(!refused.is_acquired());
		assert!(FileLock::is_held_path(&path).expect("probe while the older build holds it"));

		drop(older_build);
		assert!(!FileLock::is_held_path(&path).expect("probe after the older build exits"));
		let mut lock = FileLock::try_acquire_path(Path::new(&path)).expect("acquire");
		assert!(lock.is_acquired());
		lock.release_native().expect("release");
		let _ = std::fs::remove_file(&path);
	}

	/// Keep the calling thread, and only it, from creating Unix sockets, as a
	/// sandbox's seccomp policy does: `socket(AF_UNIX, ..)` fails with `EPERM`.
	/// A filter installed without `SECCOMP_FILTER_FLAG_TSYNC` binds this thread
	/// alone and ends with it, so other tests are unaffected.
	#[cfg(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))]
	fn refuse_unix_sockets_on_this_thread() {
		#[repr(C)]
		struct SockFilter {
			code: u16,
			jt:   u8,
			jf:   u8,
			k:    u32,
		}
		#[repr(C)]
		struct SockFprog {
			len:    libc::c_ushort,
			filter: *const SockFilter,
		}
		#[cfg(target_arch = "x86_64")]
		const AUDIT_ARCH: u32 = 0xc000_003e;
		#[cfg(target_arch = "aarch64")]
		const AUDIT_ARCH: u32 = 0xc000_00b7;
		const LOAD_WORD: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS
		const JUMP_IF_EQUAL: u16 = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
		const RETURN: u16 = 0x06; // BPF_RET | BPF_K
		const ALLOW: u32 = 0x7fff_0000; // SECCOMP_RET_ALLOW
		const FAIL_WITH: u32 = 0x0005_0000; // SECCOMP_RET_ERRNO
		// struct seccomp_data: nr at 0, arch at 4, args[0] at 16 (its low word on
		// little-endian).
		let load = |offset: u32| SockFilter { code: LOAD_WORD, jt: 0, jf: 0, k: offset };
		let jump = |value: u32, jt: u8, jf: u8| SockFilter { code: JUMP_IF_EQUAL, jt, jf, k: value };
		let ret = |value: u32| SockFilter { code: RETURN, jt: 0, jf: 0, k: value };
		let filter = [
			load(4),
			jump(AUDIT_ARCH, 1, 0),
			ret(ALLOW),
			load(0),
			jump(libc::SYS_socket as u32, 1, 0),
			ret(ALLOW),
			load(16),
			jump(libc::AF_UNIX as u32, 0, 1),
			ret(FAIL_WITH | libc::EPERM as u32),
			ret(ALLOW),
		];
		let program = SockFprog { len: filter.len() as libc::c_ushort, filter: filter.as_ptr() };
		// SAFETY: both calls change only this thread's syscall filter, and the
		// kernel copies `program` before `prctl` returns.
		unsafe {
			assert_eq!(
				libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0),
				0,
				"no_new_privs: {}",
				std::io::Error::last_os_error()
			);
			assert_eq!(
				libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &raw const program),
				0,
				"seccomp filter: {}",
				std::io::Error::last_os_error()
			);
		}
	}

	/// A sandbox that refuses Unix sockets must not break locking: the probe of
	/// the older build's name then reads it as not bound.
	#[cfg(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))]
	#[test]
	fn a_process_kept_from_unix_sockets_still_takes_locks() {
		use std::{os::unix::net::UnixDatagram, path::Path};

		use super::FileLock;

		let path = unique_lock_path("no-unix-sockets");
		let thread_path = path.clone();
		let outcome = std::thread::spawn(move || {
			refuse_unix_sockets_on_this_thread();
			// The filter is in force on this thread.
			let refused = UnixDatagram::unbound().expect_err("the filter refuses Unix sockets");
			assert_eq!(refused.raw_os_error(), Some(libc::EPERM));

			let mut lock = FileLock::try_acquire_path(Path::new(&thread_path))
				.expect("acquire without Unix sockets");
			assert!(lock.is_acquired());
			assert!(FileLock::is_held_path(&thread_path).expect("probe while held"));
			lock.release_native().expect("release");
			assert!(!FileLock::is_held_path(&thread_path).expect("probe after release"));
		})
		.join();
		let _ = std::fs::remove_file(&path);
		if let Err(panic) = outcome {
			std::panic::resume_unwind(panic);
		}
	}
}
