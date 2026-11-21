//! Backup control for `cp`, `ln`, and `mv` through the shell.
//!
//! `uucore::backup_control` reads `VERSION_CONTROL`/`SIMPLE_BACKUP_SUFFIX`
//! from the host process and probes numbered backups on the host filesystem;
//! these helpers read the shell's exported environment and probe the shell's
//! filesystem instead, keeping URL (`scheme://`) spellings intact.

use std::{
	ffi::OsStr,
	path::{Path, PathBuf},
};

#[cfg(any(feature = "util.cp", feature = "util.ln", feature = "util.mv"))]
use clap::ArgMatches;
#[cfg(any(feature = "util.cp", feature = "util.ln", feature = "util.mv"))]
use pi_vfs::{join_path, normalize_lexically};
use pi_vfs::{BlockingFs, child_path, file_name, parent_path, with_file_name};
use uucore::backup_control::BackupMode;
#[cfg(any(feature = "util.cp", feature = "util.ln", feature = "util.mv"))]
use uucore::{backup_control, display::Quotable};

#[cfg(any(feature = "util.cp", feature = "util.ln", feature = "util.mv"))]
use crate::host::Host;

/// Resolves a `--backup` CONTROL word (unique prefixes allowed); the error is
/// the GNU diagnostic naming `origin`.
#[cfg(any(feature = "util.cp", feature = "util.ln", feature = "util.mv"))]
fn match_backup_method(method: &str, origin: &str) -> Result<BackupMode, String> {
	let matches = backup_control::BACKUP_CONTROL_VALUES
		.iter()
		.filter(|value| value.starts_with(method))
		.collect::<Vec<_>>();
	if matches.len() == 1 {
		match *matches[0] {
			"simple" | "never" => Ok(BackupMode::Simple),
			"numbered" | "t" => Ok(BackupMode::Numbered),
			"existing" | "nil" => Ok(BackupMode::Existing),
			"none" | "off" => Ok(BackupMode::None),
			_ => unreachable!("matched value comes from BACKUP_CONTROL_VALUES"),
		}
	} else {
		let kind = if matches.is_empty() { "invalid" } else { "ambiguous" };
		Err(format!(
			"{kind} argument {} for '{origin}'\nValid arguments are:\n  - 'none', 'off'\n  - \
			 'simple', 'never'\n  - 'existing', 'nil'\n  - 'numbered', 't'",
			method.quote()
		))
	}
}

/// The backup mode selected by the `uucore::backup_control::arguments` flags,
/// falling back to the shell's `VERSION_CONTROL`.
#[cfg(any(feature = "util.cp", feature = "util.ln", feature = "util.mv"))]
pub(crate) fn determine_backup_mode(matches: &ArgMatches, host: &Host) -> Result<BackupMode, String> {
	let cli_method = matches
		.get_one::<String>(backup_control::arguments::OPT_BACKUP)
		.map(String::as_str);
	if matches.contains_id(backup_control::arguments::OPT_BACKUP) {
		if let Some(method) = cli_method {
			match_backup_method(method, "backup type")
		} else if let Some(method) = host.var("VERSION_CONTROL") {
			match_backup_method(method, "$VERSION_CONTROL")
		} else {
			Ok(BackupMode::Existing)
		}
	} else if matches.get_flag(backup_control::arguments::OPT_BACKUP_NO_ARG)
		|| matches.contains_id(backup_control::arguments::OPT_SUFFIX)
	{
		host.var("VERSION_CONTROL").map_or(Ok(BackupMode::Existing), |method| {
			match_backup_method(method, "$VERSION_CONTROL")
		})
	} else {
		Ok(BackupMode::None)
	}
}

/// The backup suffix from `-S`, else the shell's `SIMPLE_BACKUP_SUFFIX`, else
/// `~`. An empty suffix, or one holding `/`, is `~`, as GNU's
/// `set_simple_backup_suffix` decides: an empty one would name the backup
/// after the file itself, and the move would then replace it.
#[cfg(any(feature = "util.cp", feature = "util.ln", feature = "util.mv"))]
pub(crate) fn determine_backup_suffix(matches: &ArgMatches, host: &Host) -> String {
	let suffix = matches
		.get_one::<String>(backup_control::arguments::OPT_SUFFIX)
		.map(String::as_str)
		.or_else(|| host.var("SIMPLE_BACKUP_SUFFIX"))
		.unwrap_or(backup_control::DEFAULT_BACKUP_SUFFIX);
	if suffix.is_empty() || suffix.contains('/') {
		backup_control::DEFAULT_BACKUP_SUFFIX.to_string()
	} else {
		suffix.to_string()
	}
}

/// A backup that must not be made, as [`backup_path`] says. Its callers
/// report GNU's `cannot backup 'D': File exists`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BackupExists;

/// The backup name for `path` under `mode`, as gnulib's `backupfile.c`
/// chooses it. A numbered backup is `name.~N~` with N one past the highest
/// version among the entries of `path`'s directory: every entry `name.~N~`
/// counts, whatever it is, a symlink that points nowhere included, and N is
/// digits without a leading zero, compared and counted as a string so that
/// no version overflows. `existing` numbers when the listing shows a
/// numbered backup, and uses `suffix` otherwise, also when the directory
/// cannot be listed. A numbered name that is new, or longer than every one
/// listed, and the simple name `existing` falls back to, give way to a name
/// ending in `~` when too long for the directory ([`fallback_name`]).
///
/// `Err(BackupExists)` where that `~` name must not be taken:
/// - It is `path` itself (a name ending in `~`, cut to fit): the rename
///   would leave `path` in place and the caller then replace it, so no
///   backup is kept. GNU's mv and cp refuse it in a numbered mode; in a
///   simple one, and in ln, GNU 9.4 and 9.7 lose the old contents with
///   status 0 (cp fails, keeping them).
/// - `exclusive`, in a numbered mode, and an entry holds it: GNU's mv and cp
///   rename a numbered backup without replacing (`RENAME_NOREPLACE`) and fail
///   `EEXIST` on the `~` name. GNU's ln replaces it; its callers pass
///   `exclusive` false.
///
/// A listing that fails, or ends early with an error, may miss an entry at
/// the numbered name it gives, so that name is then confirmed free by
/// `lstat`, from its version upward. That check and the caller's rename are
/// two steps, and the rename replaces an entry made between them, as it does
/// after a complete listing; GNU closes that gap by renaming without
/// replacing and listing again. Where the directory cannot be listed, GNU
/// 9.4 and 9.7's mv and cp retry `name.~1~` without end (gnulib fe173e9544
/// makes them fail with `EEXIST`), and their ln replaces it.
pub(crate) fn backup_path(
	filesystem: &BlockingFs,
	mode: BackupMode,
	path: &Path,
	suffix: impl AsRef<OsStr>,
	exclusive: bool,
) -> Result<Option<PathBuf>, BackupExists> {
	let simple = |suffix: &OsStr| {
		let mut name = file_name(path).unwrap_or_default().into_owned();
		name.push(suffix);
		with_file_name(path, name)
	};
	let numbered = |version: &[u8]| {
		let version = std::str::from_utf8(version).expect("versions are ASCII digits");
		simple(OsStr::new(&format!(".~{version}~")))
	};
	match mode {
		BackupMode::None => return Ok(None),
		BackupMode::Simple => return Ok(Some(simple(suffix.as_ref()))),
		BackupMode::Existing | BackupMode::Numbered => {},
	}
	let listing = list_backups(filesystem, path);
	let mut version = match &listing.highest {
		Some(highest) => next_version(highest),
		// A simple backup is renamed with replacement, by GNU too.
		None if mode == BackupMode::Existing => return fit(filesystem, path, simple(suffix.as_ref()), false),
		None => b"1".to_vec(),
	};
	if !listing.complete {
		while filesystem.symlink_metadata(numbered(&version)).is_ok() {
			version = next_version(&version);
		}
	}
	let backup = numbered(&version);
	// A name as long as one the directory holds fits it (gnulib's
	// `BACKUP_IS_SAME_LENGTH`), whatever the limit reads.
	if listing
		.highest
		.is_some_and(|highest| highest.len() == version.len())
	{
		return Ok(Some(backup));
	}
	fit(filesystem, path, backup, exclusive)
}

/// `backup`, or the `~` name it gives way to when too long
/// ([`fallback_name`]), unless that name must not be taken: it is `path`
/// itself, or, for a backup renamed without replacing (`no_replace`), an
/// entry holds it ([`backup_path`]).
fn fit(
	filesystem: &BlockingFs,
	path: &Path,
	backup: PathBuf,
	no_replace: bool,
) -> Result<Option<PathBuf>, BackupExists> {
	let Some(fallback) = fallback_name(filesystem, path, &backup) else {
		return Ok(Some(backup));
	};
	if fallback == path || (no_replace && filesystem.symlink_metadata(&fallback).is_ok()) {
		return Err(BackupExists);
	}
	Ok(Some(fallback))
}

/// What a listing of a file's directory says about its numbered backups.
struct Listing {
	/// The highest version N, as its digits, among the entries `name.~N~`
	/// read; `None` when there was none.
	highest:  Option<Vec<u8>>,
	/// The listing read every entry: it neither failed nor ended early with
	/// an error.
	complete: bool,
}

/// The numbered backups among the entries of `path`'s directory.
fn list_backups(filesystem: &BlockingFs, path: &Path) -> Listing {
	let mut listing = Listing { highest: None, complete: false };
	let Some(name) = file_name(path) else {
		listing.complete = true;
		return listing;
	};
	let Ok(entries) = filesystem.read_dir(backup_dir(path)) else {
		return listing;
	};
	let mut prefix = name.into_owned();
	prefix.push(".~");
	let prefix = prefix.as_encoded_bytes();
	for entry in entries {
		let Ok(entry) = entry else {
			return listing;
		};
		let entry = entry.file_name();
		let Some(version) = entry
			.as_encoded_bytes()
			.strip_prefix(prefix)
			.and_then(|rest| rest.strip_suffix(b"~"))
		else {
			continue;
		};
		let counts = matches!(version.first(), Some(b'1'..=b'9')) && version.iter().all(u8::is_ascii_digit);
		if counts
			&& listing
				.highest
				.as_ref()
				.is_none_or(|top| (version.len(), version) > (top.len(), top.as_slice()))
		{
			listing.highest = Some(version.to_vec());
		}
	}
	listing.complete = true;
	listing
}

/// The directory `path` is in, `.` for a bare name.
fn backup_dir(path: &Path) -> &Path {
	parent_path(path)
		.filter(|dir| !dir.as_os_str().is_empty())
		.unwrap_or(Path::new("."))
}

/// `version` (ASCII digits) plus one, as digits.
fn next_version(version: &[u8]) -> Vec<u8> {
	let mut digits = version.to_vec();
	let carried = digits.iter_mut().rev().all(|digit| {
		if *digit == b'9' {
			*digit = b'0';
			true
		} else {
			*digit += 1;
			false
		}
	});
	if carried {
		digits.insert(0, b'1');
	}
	digits
}

/// The name `backup` gives way to when its name is too long for the
/// directory: `path`'s name cut to fit with `~` after it, as gnulib's
/// `check_extension` decides (it keeps every byte it can, at most one under
/// the limit, [`name_limit`]); `None` when it fits. A name of 14 bytes or
/// fewer (`NAME_MAX_MINIMUM`) always fits.
fn fallback_name(filesystem: &BlockingFs, path: &Path, backup: &Path) -> Option<PathBuf> {
	#[cfg(unix)]
	{
		use std::os::unix::ffi::{OsStrExt as _, OsStringExt as _};
		let length = file_name(backup).map_or(0, |name| name.len());
		if length <= NAME_MAX_MINIMUM {
			return None;
		}
		let limit = name_limit(filesystem, backup_dir(path))?;
		if length <= limit {
			return None;
		}
		let name = file_name(path).unwrap_or_default();
		let keep = if limit <= name.len() { limit.saturating_sub(1) } else { name.len() };
		let mut cut = name.as_bytes()[..keep].to_vec();
		cut.push(b'~');
		Some(with_file_name(path, std::ffi::OsString::from_vec(cut)))
	}
	#[cfg(not(unix))]
	{
		let _ = (filesystem, path, backup);
		None
	}
}

/// POSIX's least `NAME_MAX`: a name this long fits any directory.
#[cfg(unix)]
const NAME_MAX_MINIMUM: usize = 14;

/// The longest backup name the directory `dir` takes, as gnulib reads it:
/// one under pathconf's `NAME_MAX`, or `NAME_MAX_MINIMUM` where pathconf
/// reports no limit. `None` (no limit) where pathconf fails, and where `dir`
/// is not a host directory, whose provider then refuses a name too long.
#[cfg(unix)]
fn name_limit(filesystem: &BlockingFs, dir: &Path) -> Option<usize> {
	use std::os::unix::ffi::OsStrExt as _;
	if !filesystem.is_native_local(dir) {
		return None;
	}
	let dir = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
	nix::errno::Errno::clear();
	// SAFETY: `dir` is a NUL-terminated path that outlives the call.
	let max = unsafe { libc::pathconf(dir.as_ptr(), libc::_PC_NAME_MAX) };
	if max == -1 {
		return (nix::errno::Errno::last_raw() == 0).then_some(NAME_MAX_MINIMUM);
	}
	usize::try_from(max - 1).ok()
}

/// Whether `from` is `to`'s simple backup, so that backing `to` up would
/// destroy it, as GNU's `source_is_dst_backup` (copy.c) decides for cp and
/// mv alike: `from`'s name is `to`'s with `suffix` after it, and the entry of
/// that name beside `to`, followed, is the same file as `from` (followed when
/// `follow_from`). Without both identities (a provider may give none) the
/// same location decides: `./dest~` is the same file, a `dest~` in another
/// directory is not.
#[cfg(any(feature = "util.cp", feature = "util.mv"))]
pub(crate) fn source_is_destination_backup(
	filesystem: &BlockingFs,
	from: &Path,
	follow_from: bool,
	to: &Path,
	suffix: &str,
) -> bool {
	let (Some(from_name), Some(to_name)) = (file_name(from), file_name(to)) else {
		return false;
	};
	let mut backup_name = to_name.into_owned();
	backup_name.push(suffix);
	if *from_name != *backup_name {
		return false;
	}
	same_file(filesystem, from, follow_from, &with_file_name(to, &backup_name), true)
}

/// Whether making the backup `backup` would replace the source `source`:
/// the rename that makes the backup replaces the entry at `backup`, and the
/// source is lost only when that entry is the source's own (a long name's
/// `~` fallback, or `ln -b dest~ dest`, can be) or, when the source is
/// followed (`follow_source`), an entry the source leads to: a symbolic
/// link it passes through, or the file it resolves to. Another hard link
/// of the source is another entry: replacing it leaves the source, as GNU's
/// mv, cp and ln leave it. With nothing at `backup` the backup replaces no
/// entry (`ln -s -b dest~ dest`, before `dest~` exists).
#[cfg(any(feature = "util.cp", feature = "util.ln", feature = "util.mv"))]
pub(crate) fn backup_is_source(filesystem: &BlockingFs, source: &Path, follow_source: bool, backup: &Path) -> bool {
	if filesystem.symlink_metadata(backup).is_err() {
		return false;
	}
	if follow_source {
		followed_entries(filesystem, source)
			.iter()
			.any(|entry| same_entry(filesystem, entry, backup))
	} else {
		same_entry(filesystem, source, backup)
	}
}

/// The entries reading `path` passes through when it follows symbolic
/// links: `path`'s own, each link its last name leads to in turn (a
/// relative target read from the link's directory), and the file it
/// resolves to. At most 40 links are followed, Linux's limit for one
/// lookup.
#[cfg(any(feature = "util.cp", feature = "util.ln", feature = "util.mv"))]
fn followed_entries(filesystem: &BlockingFs, path: &Path) -> Vec<PathBuf> {
	let mut entries = vec![path.to_path_buf()];
	let mut current = path.to_path_buf();
	for _ in 0..40 {
		if !filesystem.symlink_metadata(&current).is_ok_and(|metadata| metadata.is_symlink()) {
			break;
		}
		let Ok(target) = filesystem.read_link(&current) else {
			break;
		};
		current = match parent_path(&current) {
			Some(parent) => join_path(parent, &target),
			None => target,
		};
		entries.push(current.clone());
	}
	if let Ok(resolved) = filesystem.canonicalize(path) {
		entries.push(resolved);
	}
	entries
}

/// Whether `a` and `b` name the same directory entry:
/// - the same name in the same directory, as gnulib's `same_nameat` decides
///   it, except that the directories are compared as [`same_file`] compares
///   files, following a symbolic link to a directory as the rename does,
///   where gnulib `lstat`s them;
/// - or, where names fold (a case-insensitive filesystem, on which `DEST~`
///   and `dest~` name one entry), one file with a single link, read with
///   `lstat` under both names: a file with one link has one entry. A file
///   with more links cannot be told apart this way; for cp, `copy_data`
///   finds such a source replaced when it opens it, as GNU cp does.
///
/// Directories cannot be hard links, so a directory is one entry.
#[cfg(any(feature = "util.cp", feature = "util.ln", feature = "util.mv"))]
pub(crate) fn same_entry(filesystem: &BlockingFs, a: &Path, b: &Path) -> bool {
	let (Some(a_name), Some(b_name)) = (file_name(a), file_name(b)) else {
		return false;
	};
	if a_name == b_name && same_file(filesystem, backup_dir(a), true, backup_dir(b), true) {
		return true;
	}
	let (Ok(a_metadata), Ok(b_metadata)) = (filesystem.symlink_metadata(a), filesystem.symlink_metadata(b)) else {
		return false;
	};
	a_metadata.nlink() == Some(1)
		&& matches!(
			(a_metadata.file_id(), b_metadata.file_id()),
			(Some(a_id), Some(b_id)) if a_id.is_native() == b_id.is_native() && a_id == b_id
		)
}

/// Whether `a` and `b`, each followed when its flag says so, are the same
/// file: by file identity when both have one on the same kind of
/// filesystem, else by location ([`location`]).
#[cfg(any(feature = "util.cp", feature = "util.ln", feature = "util.mv"))]
fn same_file(filesystem: &BlockingFs, a: &Path, follow_a: bool, b: &Path, follow_b: bool) -> bool {
	let metadata = |path: &Path, follow: bool| {
		if follow {
			filesystem.metadata(path)
		} else {
			filesystem.symlink_metadata(path)
		}
	};
	let (Ok(a_metadata), Ok(b_metadata)) = (metadata(a, follow_a), metadata(b, follow_b)) else {
		return false;
	};
	match (a_metadata.file_id(), b_metadata.file_id()) {
		(Some(a_id), Some(b_id)) if a_id.is_native() == b_id.is_native() => a_id == b_id,
		_ => location(filesystem, a, follow_a) == location(filesystem, b, follow_b),
	}
}

/// Where `path` is: with `follow`, the canonical file (the host file a
/// provider path aliases, if any); without, its entry in its canonical
/// directory. Lexical where neither can be read.
#[cfg(any(feature = "util.cp", feature = "util.ln", feature = "util.mv"))]
fn location(filesystem: &BlockingFs, path: &Path, follow: bool) -> PathBuf {
	let canonical = |path: &Path| match filesystem.backing_path(path).ok().flatten() {
		Some(backing) => filesystem.canonicalize(&backing).ok(),
		None => filesystem.canonicalize(path).ok(),
	};
	let found = if follow {
		canonical(path)
	} else {
		file_name(path).and_then(|name| canonical(backup_dir(path)).map(|dir| child_path(&dir, &name)))
	};
	found.unwrap_or_else(|| normalize_lexically(path))
}

/// Rebuilds the operand-relative display form of `backup`, created beside
/// `operand`.
pub(crate) fn backup_display(operand: &Path, backup: &Path) -> PathBuf {
	match (parent_path(operand), file_name(backup)) {
		(Some(parent), Some(name)) if !parent.is_empty() => child_path(parent, &name),
		(_, Some(name)) => PathBuf::from(name.into_owned()),
		_ => backup.to_path_buf(),
	}
}

#[cfg(all(test, unix))]
pub(crate) mod tests;
