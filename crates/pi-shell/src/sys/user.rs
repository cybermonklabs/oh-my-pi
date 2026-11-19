//! The current user as the shell reports it (`UID`, `EUID`, `GID`,
//! `GROUPS`, the user name and home directory).
//!
//! Windows has no numeric ids: the user's and primary group's ids are the
//! relative ids (RIDs, the last sub-authority) of their SIDs, as MSYS2 and
//! Cygwin derive theirs, so an ordinary user is not uid 0. An elevated
//! (administrator) process has effective uid 0, so `%#` shows `#` there
//! as for root.

use bstr::BString;

use crate::bash::UserInfo;

/// The current user: ids, groups, and the name and home directory.
///
/// On Unix the name and home are the real uid's password database entry,
/// as zsh (`USERNAME`, the default `HOME`) and bash (`\u`, `~` without
/// `HOME`) take them, whatever `USER` and `HOME` the environment holds; a
/// uid without an entry falls back to `USER` and `HOME`. On Windows,
/// `USERNAME` and `USERPROFILE`.
pub fn read_user() -> UserInfo {
	let var = |k: &str| {
		std::env::var_os(k).map_or_else(BString::default, |v| BString::from(v.as_encoded_bytes()))
	};
	#[cfg(unix)]
	// SAFETY: getuid/geteuid/getgid have no preconditions.
	let (uid, euid, gid) = unsafe { (libc::getuid(), libc::geteuid(), libc::getgid()) };
	#[cfg(windows)]
	let (uid, euid, gid) = windows::ids();
	#[cfg(unix)]
	let (name, home) = passwd_entry(uid).unwrap_or_else(|| (var("USER"), var("HOME")));
	#[cfg(windows)]
	let (name, home) = (var("USERNAME"), var("USERPROFILE"));
	UserInfo { uid, euid, gid, groups: groups(), name, home }
}

/// The name and home directory of `uid`'s password database entry
/// (`getpwuid_r`); `None` without one.
#[cfg(unix)]
fn passwd_entry(uid: libc::uid_t) -> Option<(BString, BString)> {
	use std::ffi::CStr;
	let mut buf = vec![0u8; 4096];
	loop {
		let mut pw = std::mem::MaybeUninit::<libc::passwd>::zeroed();
		let mut found: *mut libc::passwd = std::ptr::null_mut();
		// SAFETY: `pw` and `buf` are valid for writes of their sizes;
		// getpwuid_r fills them and sets `found`.
		let rc = unsafe {
			libc::getpwuid_r(uid, pw.as_mut_ptr(), buf.as_mut_ptr().cast(), buf.len(), &raw mut found)
		};
		if rc == libc::ERANGE && buf.len() < 1 << 20 {
			buf.resize(buf.len() * 2, 0);
			continue;
		}
		if rc != 0 || found.is_null() {
			return None;
		}
		// SAFETY: getpwuid_r succeeded, so `pw` is initialized and its
		// strings are null or NUL-terminated inside `buf`.
		let pw = unsafe { pw.assume_init() };
		let text = |p: *const libc::c_char| {
			if p.is_null() {
				BString::default()
			} else {
				// SAFETY: as above.
				BString::from(unsafe { CStr::from_ptr(p) }.to_bytes())
			}
		};
		return Some((text(pw.pw_name), text(pw.pw_dir)));
	}
}

/// The effective uid and gid files read as owned by. Windows reports no
/// numeric owners: a file reads as this process's own, so `[[ -O f ]]`
/// holds for the user's files as on Unix.
pub fn owner() -> (u32, u32) {
	#[cfg(unix)]
	// SAFETY: `geteuid` and `getegid` always succeed and touch no memory.
	unsafe {
		(libc::geteuid(), libc::getegid())
	}
	#[cfg(windows)]
	{
		static IDS: std::sync::LazyLock<(u32, u32)> = std::sync::LazyLock::new(|| {
			let (_, euid, gid) = windows::ids();
			(euid, gid)
		});
		*IDS
	}
}

/// The process's supplementary group ids (`GROUPS`); empty where the
/// platform has none or `getgroups` fails.
#[cfg_attr(
	not(unix),
	expect(clippy::missing_const_for_fn, reason = "the Unix body calls getgroups")
)]
fn groups() -> Vec<u32> {
	#[cfg(unix)]
	{
		// SAFETY: a zero count with a null pointer only asks for the count.
		let n = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
		let Ok(len) = usize::try_from(n) else {
			return Vec::new();
		};
		let mut ids: Vec<libc::gid_t> = vec![0; len];
		// SAFETY: `ids` has room for `n` entries; getgroups writes at most
		// that many and returns how many it wrote.
		let got = unsafe { libc::getgroups(n, ids.as_mut_ptr()) };
		ids.truncate(usize::try_from(got).unwrap_or(0));
		ids
	}
	#[cfg(not(unix))]
	Vec::new()
}

#[cfg(windows)]
mod windows {
	use windows_sys::Win32::{
		Foundation::{CloseHandle, HANDLE},
		Security::{
			GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, PSID, TOKEN_ELEVATION,
			TOKEN_PRIMARY_GROUP, TOKEN_QUERY, TOKEN_USER, TokenElevation, TokenPrimaryGroup,
			TokenUser,
		},
		System::Threading::{GetCurrentProcess, OpenProcessToken},
	};

	/// `(uid, euid, gid)` of this process's token; uid 1000 (the first
	/// ordinary user's id elsewhere) when the token cannot be read.
	pub(super) fn ids() -> (u32, u32, u32) {
		let mut token: HANDLE = std::ptr::null_mut();
		// SAFETY: the pseudo-handle of the current process needs no closing;
		// `token` receives a handle closed below.
		if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw mut token) } == 0 {
			return (1000, 1000, 1000);
		}
		let user = info(token, TokenUser).map(|b| {
			// SAFETY: a `TokenUser` answer starts with a `TOKEN_USER`.
			rid(unsafe { (*b.as_ptr().cast::<TOKEN_USER>()).User.Sid })
		});
		let group = info(token, TokenPrimaryGroup).map(|b| {
			// SAFETY: a `TokenPrimaryGroup` answer starts with a
			// `TOKEN_PRIMARY_GROUP`.
			rid(unsafe { (*b.as_ptr().cast::<TOKEN_PRIMARY_GROUP>()).PrimaryGroup })
		});
		let elevated = info(token, TokenElevation).is_some_and(|b| {
			// SAFETY: a `TokenElevation` answer is a `TOKEN_ELEVATION`.
			unsafe { (*b.as_ptr().cast::<TOKEN_ELEVATION>()).TokenIsElevated != 0 }
		});
		// SAFETY: `token` is the open handle from above.
		unsafe { CloseHandle(token) };
		let uid = user.flatten().unwrap_or(1000);
		let gid = group.flatten().unwrap_or(uid);
		(uid, if elevated { 0 } else { uid }, gid)
	}

	/// The token information of `class`, in a buffer aligned for the
	/// structure it starts with.
	fn info(token: HANDLE, class: i32) -> Option<Vec<u64>> {
		let mut len = 0u32;
		// SAFETY: a null buffer of size 0 only asks for the size.
		unsafe { GetTokenInformation(token, class, std::ptr::null_mut(), 0, &raw mut len) };
		if len == 0 {
			return None;
		}
		let mut buf = vec![0u64; (len as usize).div_ceil(8)];
		// SAFETY: `buf` holds at least `len` bytes.
		let ok =
			unsafe { GetTokenInformation(token, class, buf.as_mut_ptr().cast(), len, &raw mut len) };
		(ok != 0).then_some(buf)
	}

	/// The relative id (last sub-authority) of `sid`.
	fn rid(sid: PSID) -> Option<u32> {
		if sid.is_null() {
			return None;
		}
		// SAFETY: `sid` is a valid SID inside the token buffer still alive.
		let count = unsafe { *GetSidSubAuthorityCount(sid) };
		let last = u32::from(count.checked_sub(1)?);
		// SAFETY: `last` is below the SID's sub-authority count.
		Some(unsafe { *GetSidSubAuthority(sid, last) })
	}
}

#[cfg(all(test, windows))]
mod tests {
	/// An ordinary Windows user read as uid 0 got zsh's root prompt `#`.
	#[test]
	fn a_windows_user_is_not_uid_zero() {
		let user = super::read_user();
		assert_ne!(user.uid, 0);
		assert_ne!(user.gid, 0);
	}
}
