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
use pi_vfs::normalize_lexically;
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

/// Whether making the backup `backup` would replace the source `source`
/// (followed when `follow_source`): the rename that makes it replaces the
/// entry at `backup`, and that entry is the source's, as a long name's `~`
/// fallback can be. Decided as [`source_is_destination_backup`] decides,
/// with `backup` not followed.
#[cfg(any(feature = "util.ln", feature = "util.mv"))]
pub(crate) fn backup_is_source(filesystem: &BlockingFs, source: &Path, follow_source: bool, backup: &Path) -> bool {
	same_file(filesystem, source, follow_source, backup, false)
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
pub(crate) mod tests {
	use std::{
		fs, io,
		os::unix::fs::symlink,
		path::{Path, PathBuf},
		sync::Arc,
	};

	use uucore::backup_control::BackupMode;

	use super::{BackupExists, backup_path};

	/// A provider over host files that reports no file identities, as a
	/// provider whose metadata carries no device and inode does (the shell's
	/// own may omit them). With `cut_listings`, every listing ends with an
	/// error before its first entry, as std's `ReadDir` stops at its first
	/// error.
	#[derive(Debug, Default)]
	pub(crate) struct HostWithoutIds {
		cut_listings: bool,
	}

	impl HostWithoutIds {
		/// A filesystem over this provider.
		pub(crate) fn fs(cut_listings: bool) -> pi_vfs::Fs {
			pi_vfs::Fs::new(Arc::new(Self { cut_listings }))
		}
	}

	/// `metadata` without its identity: the kind, length, permissions and
	/// modification time only.
	fn without_id(metadata: pi_vfs::Metadata) -> pi_vfs::Metadata {
		let plain = pi_vfs::Metadata::new(metadata.file_type(), metadata.len(), metadata.permissions());
		match metadata.modified() {
			Ok(time) => plain.with_modified(time),
			Err(_) => plain,
		}
	}

	#[async_trait::async_trait]
	impl pi_vfs::FileSystem for HostWithoutIds {
		async fn open(&self, path: &Path, options: &pi_vfs::OpenOptions) -> io::Result<pi_vfs::File> {
			pi_vfs::Fs::default().open_with(path, options).await
		}

		async fn metadata(&self, path: &Path) -> io::Result<pi_vfs::Metadata> {
			pi_vfs::Fs::default().metadata(path).await.map(without_id)
		}

		async fn symlink_metadata(&self, path: &Path) -> io::Result<pi_vfs::Metadata> {
			pi_vfs::Fs::default().symlink_metadata(path).await.map(without_id)
		}

		async fn read_dir(&self, path: &Path) -> io::Result<pi_vfs::ReadDir> {
			let listing = pi_vfs::Fs::default().read_dir(path).await?;
			if self.cut_listings {
				return Ok(pi_vfs::ReadDir::from_entries(vec![Err(io::Error::other(
					"the listing was cut short",
				))]));
			}
			Ok(listing)
		}

		async fn read_link(&self, path: &Path) -> io::Result<PathBuf> {
			pi_vfs::Fs::default().read_link(path).await
		}

		async fn create_dir(&self, path: &Path, _mode: Option<u32>) -> io::Result<()> {
			pi_vfs::Fs::default().create_dir(path).await
		}

		async fn remove_file(&self, path: &Path) -> io::Result<()> {
			pi_vfs::Fs::default().remove_file(path).await
		}

		async fn remove_dir(&self, path: &Path) -> io::Result<()> {
			pi_vfs::Fs::default().remove_dir(path).await
		}

		async fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
			pi_vfs::Fs::default().rename(from, to).await
		}

		async fn set_permissions(&self, path: &Path, permissions: pi_vfs::Permissions) -> io::Result<()> {
			pi_vfs::Fs::default().set_permissions(path, permissions).await
		}
	}

	/// One directory of [`check_numbered_backups`]: what is at `dest.~N~`
	/// before the backup (`None` for a symlink to nothing), the
	/// `--backup` CONTROL word, and the backup name GNU coreutils picks.
	type Case = (&'static str, &'static str, &'static [(&'static str, Option<&'static str>)], &'static str);

	/// The cases each caller of [`backup_path`] is checked against; GNU
	/// coreutils 9.4 and 9.7 pick these backup names. A numbered backup goes
	/// after the highest `dest.~N~` the directory holds, whatever kind of
	/// entry that is, a symlink that points nowhere included; `existing`
	/// numbers when any numbered backup is there.
	const CASES: [Case; 4] = [
		("dangling", "numbered", &[("dest.~1~", None)], "dest.~2~"),
		("dangling-existing", "existing", &[("dest.~1~", None)], "dest.~2~"),
		("gap", "numbered", &[("dest.~1~", Some("one")), ("dest.~3~", Some("three"))], "dest.~4~"),
		("only-third-existing", "existing", &[("dest.~3~", Some("three"))], "dest.~4~"),
	];

	/// Checks a caller of [`backup_path`]: in a directory per case holding
	/// `src` ("new"), `dest` ("old") and the case's backups, `run(dir,
	/// control)` must replace `dest` with `src`'s content, backing `dest` up
	/// as `--backup=control`, and return the exit status and standard error.
	/// The backup must be the name GNU picks, and every entry that was at a
	/// backup name must stay as it was.
	pub(crate) fn check_numbered_backups(run: impl Fn(&Path, &str) -> (i32, String)) {
		let root = tempfile::tempdir().unwrap();
		for (case, control, before, backup) in CASES {
			let dir = root.path().join(case);
			fs::create_dir(&dir).unwrap();
			fs::write(dir.join("src"), "new").unwrap();
			fs::write(dir.join("dest"), "old").unwrap();
			for &(name, content) in before {
				match content {
					Some(content) => fs::write(dir.join(name), content).unwrap(),
					None => symlink("missing", dir.join(name)).unwrap(),
				}
			}
			assert_eq!(run(&dir, control), (0, String::new()), "{case}");
			assert_eq!(
				fs::read_to_string(dir.join(backup)).ok().as_deref(),
				Some("old"),
				"{case}: dest was not backed up as {backup}"
			);
			assert_eq!(fs::read_to_string(dir.join("dest")).unwrap(), "new", "{case}");
			for &(name, content) in before {
				match content {
					Some(content) => {
						assert_eq!(fs::read_to_string(dir.join(name)).unwrap(), content, "{case}: {name} changed");
					},
					None => assert_eq!(
						fs::read_link(dir.join(name)).ok().as_deref(),
						Some(Path::new("missing")),
						"{case}: the link at {name} was replaced"
					),
				}
			}
		}
	}

	/// The version after the highest is counted as GNU counts it: a version
	/// is digits with no leading zero followed by `~`, compared as a string,
	/// so `dest.~9~` gives `dest.~10~` and a very long version is no
	/// overflow; other names that start alike do not count.
	#[test]
	fn numbered_backups_follow_the_highest_version_as_gnu_reads_it() {
		let vfs = pi_vfs::BlockingFs::native();
		let cases: [(&[&str], &str); 4] = [
			(&["dest.~9~"], "dest.~10~"),
			(&["dest.~99999999999999999999999~"], "dest.~100000000000000000000000~"),
			(&["dest.~07~", "dest.~2x~", "dest.~3", "dest.~4~~", "dest~", "dest.~5~.bak", "other.~8~"], "dest.~1~"),
			(&["dest.~2~", "dest.~10~", "dest.~9~"], "dest.~11~"),
		];
		for (entries, expected) in cases {
			let dir = tempfile::tempdir().unwrap();
			fs::write(dir.path().join("dest"), "old").unwrap();
			for entry in entries {
				symlink("missing", dir.path().join(entry)).unwrap();
			}
			assert_eq!(
				backup_path(&vfs, BackupMode::Numbered, &dir.path().join("dest"), "~", true),
				Ok(Some(dir.path().join(expected))),
				"{entries:?}"
			);
		}
	}

	/// A directory that cannot be listed (search permission only) shows no
	/// numbered backup. `existing` then uses the simple name, as GNU 9.4 and
	/// 9.7 do in mv, cp and ln. `numbered` takes the first name no entry
	/// holds by `lstat`, a symlink to nothing included, from `name.~1~` up.
	/// That is not GNU's: there GNU 9.4 and 9.7's mv and cp retry `name.~1~`
	/// without end (gnulib fe173e9544 makes them fail), and their ln replaces
	/// it.
	#[test]
	fn a_directory_that_cannot_be_listed_is_probed_for_a_free_backup_name() {
		use std::os::unix::fs::PermissionsExt as _;
		let vfs = pi_vfs::BlockingFs::native();
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("dest"), "old").unwrap();
		symlink("missing", dir.path().join("dest.~1~")).unwrap();
		fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o311)).unwrap();
		let listable = fs::read_dir(dir.path()).is_ok();
		let numbered = backup_path(&vfs, BackupMode::Numbered, &dir.path().join("dest"), "~", true);
		let existing = backup_path(&vfs, BackupMode::Existing, &dir.path().join("dest"), "~", true);
		fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
		if listable {
			eprintln!("skipped: this process lists a directory without read permission");
			return;
		}
		assert_eq!(numbered, Ok(Some(dir.path().join("dest.~2~"))));
		assert_eq!(existing, Ok(Some(dir.path().join("dest~"))));
	}

	/// A listing that ends early, with an error, is not taken as complete:
	/// the name is confirmed free by `lstat`, past an entry the listing never
	/// showed, so a numbered backup does not replace one. GNU reads a cut
	/// listing too, but renames without replacing and lists again. With no
	/// numbered backup seen, `existing` uses the simple name, as GNU does.
	#[test]
	fn a_listing_cut_short_never_picks_an_occupied_name() {
		let vfs = HostWithoutIds::fs(true).blocking();
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("dest"), "old").unwrap();
		fs::write(dir.path().join("dest.~1~"), "keep").unwrap();
		let dest = dir.path().join("dest");
		assert_eq!(backup_path(&vfs, BackupMode::Numbered, &dest, "~", true), Ok(Some(dir.path().join("dest.~2~"))));
		assert_eq!(backup_path(&vfs, BackupMode::Existing, &dest, "~", true), Ok(Some(dir.path().join("dest~"))));
	}

	/// A numbered name too long for its directory gives way to the name with
	/// `~`, cut to fit if need be, as gnulib's `check_extension` does, with
	/// the limit one under `NAME_MAX` (255 here, so 254). GNU 9.4 gives each
	/// of these:
	/// - a 250-byte `A`: `A.~1~` (254 bytes, fits);
	/// - a 251-byte `B` beside `B.~9~`: `B.~10~` would be 256 bytes, so `B~`;
	/// - a 251-byte `C` beside `C.~8~`: `C.~9~` (255 bytes), as long as the
	///   name listed, which is not checked;
	/// - a 255-byte `D`: `D.~1~` would be 259 bytes, so its first 253 bytes
	///   and `~` (254);
	/// - a 254-byte `E` under `existing` with no numbered backup: the simple
	///   name `E~` (255 bytes) is checked too, so its first 253 bytes and `~`.
	#[test]
	fn a_numbered_name_past_the_name_limit_falls_back_to_a_tilde() {
		let vfs = pi_vfs::BlockingFs::native();
		let dir = tempfile::tempdir().unwrap();
		if !fits_255_byte_names(dir.path()) {
			return;
		}
		let name = |byte: char, length: usize| byte.to_string().repeat(length);
		let cases = [
			(name('a', 250), None, BackupMode::Numbered, format!("{}.~1~", name('a', 250))),
			(name('b', 251), Some("9"), BackupMode::Numbered, format!("{}~", name('b', 251))),
			(name('c', 251), Some("8"), BackupMode::Numbered, format!("{}.~9~", name('c', 251))),
			(name('d', 255), None, BackupMode::Numbered, format!("{}~", name('d', 253))),
			(name('e', 254), None, BackupMode::Existing, format!("{}~", name('e', 253))),
		];
		for (file, listed, mode, expected) in cases {
			fs::write(dir.path().join(&file), "old").unwrap();
			if let Some(version) = listed {
				fs::write(dir.path().join(format!("{file}.~{version}~")), "listed").unwrap();
			}
			assert_eq!(
				backup_path(&vfs, mode, &dir.path().join(&file), "~", true),
				Ok(Some(dir.path().join(&expected))),
				"{} bytes, listed {listed:?}, {mode:?}",
				file.len()
			);
		}
	}

	/// The `~` name a long name gives way to is refused where it must not be
	/// taken: when it is the file itself, always; when an entry holds it, in a
	/// numbered mode, for callers that rename without replacing (`exclusive`,
	/// GNU's mv and cp), not for one that replaces (GNU's ln). A simple
	/// backup's `~` name (`existing` with no numbered backup) replaces an
	/// entry, as GNU's does in all three.
	#[test]
	fn a_held_fallback_name_is_refused_where_gnu_refuses_it() {
		let vfs = pi_vfs::BlockingFs::native();
		let dir = tempfile::tempdir().unwrap();
		if !fits_255_byte_names(dir.path()) {
			return;
		}
		let held = |file: &str, entries: &[&str]| {
			let case = dir.path().join(format!("{}-{}", file.len(), entries.len()));
			fs::create_dir(&case).unwrap();
			fs::write(case.join(file), "old").unwrap();
			for entry in entries {
				fs::write(case.join(entry), "held").unwrap();
			}
			case.join(file)
		};
		let d = "d".repeat(251);
		let (d_tilde, d_nine) = (format!("{d}~"), format!("{d}.~9~"));
		let e = format!("{}~", "e".repeat(253));
		let f = "f".repeat(254);
		let f_cut = format!("{}~", "f".repeat(253));
		// An entry holds the numbered backup's `~` name.
		let path = held(&d, &[&d_nine, &d_tilde]);
		for mode in [BackupMode::Numbered, BackupMode::Existing] {
			assert_eq!(backup_path(&vfs, mode, &path, "~", true), Err(BackupExists), "{mode:?}");
			assert_eq!(backup_path(&vfs, mode, &path, "~", false), Ok(Some(path.with_file_name(&d_tilde))), "{mode:?}");
		}
		// The `~` name is the file itself.
		let path = held(&e, &[]);
		for mode in [BackupMode::Numbered, BackupMode::Existing] {
			for exclusive in [true, false] {
				assert_eq!(backup_path(&vfs, mode, &path, "~", exclusive), Err(BackupExists), "{mode:?} {exclusive}");
			}
		}
		// A simple backup's `~` name replaces the entry there.
		let path = held(&f, &[&f_cut]);
		for exclusive in [true, false] {
			assert_eq!(
				backup_path(&vfs, BackupMode::Existing, &path, "~", exclusive),
				Ok(Some(path.with_file_name(&f_cut))),
				"{exclusive}"
			);
		}
	}

	/// `NAME_MAX` of the directory `dir`, as pathconf reports it.
	fn pathconf_name_max(dir: &Path) -> Option<i64> {
		use std::os::unix::ffi::OsStrExt as _;
		let dir = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
		// SAFETY: `dir` is a NUL-terminated path that outlives the call.
		let max = unsafe { libc::pathconf(dir.as_ptr(), libc::_PC_NAME_MAX) };
		(max != -1).then_some(i64::from(max))
	}

	/// Whether the directory `dir` takes the 251- to 255-byte names the
	/// long-name tests make (`NAME_MAX` is 255); prints a skip line saying
	/// why when it does not, as on eCryptfs (143).
	pub(crate) fn fits_255_byte_names(dir: &Path) -> bool {
		match pathconf_name_max(dir) {
			Some(255) => true,
			other => {
				eprintln!("skipped: NAME_MAX here is {other:?}, not 255");
				false
			},
		}
	}

	/// Checks a caller of [`backup_path`] against an empty suffix: in a
	/// directory holding `src` ("new") and `dest` ("old"), `run(dir)` must
	/// move or copy `src` to `dest` with `-b -S ''` and return the exit
	/// status and standard error. GNU takes an empty suffix as `~`: `dest~`
	/// keeps the old `dest`, where an empty one would name the backup `dest`
	/// and lose it.
	pub(crate) fn check_empty_suffix(run: impl Fn(&Path) -> (i32, String)) {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("src"), "new").unwrap();
		fs::write(dir.path().join("dest"), "old").unwrap();
		assert_eq!(run(dir.path()), (0, String::new()));
		assert_eq!(fs::read_to_string(dir.path().join("dest~")).ok().as_deref(), Some("old"));
	}

	/// Checks a caller of [`backup_path`] against the name limit: in a
	/// directory holding `src` ("new"), a 251-byte `D` ("old") and `D.~9~`
	/// ("nine"), `run(dir, D)` must back `D` up numbered, as `src D` does,
	/// and return the exit status and standard error. GNU 9.4 and 9.7 succeed
	/// and back `D` up as `D~`, keeping `D.~9~`.
	pub(crate) fn check_name_limit(run: impl Fn(&Path, &str) -> (i32, String)) {
		let dir = tempfile::tempdir().unwrap();
		if !fits_255_byte_names(dir.path()) {
			return;
		}
		let long = "a".repeat(251);
		fs::write(dir.path().join("src"), "new").unwrap();
		fs::write(dir.path().join(&long), "old").unwrap();
		fs::write(dir.path().join(format!("{long}.~9~")), "nine").unwrap();
		assert_eq!(run(dir.path(), &long), (0, String::new()));
		assert_eq!(fs::read_to_string(dir.path().join(format!("{long}~"))).ok().as_deref(), Some("old"));
		assert_eq!(fs::read_to_string(dir.path().join(&long)).unwrap(), "new");
		assert_eq!(fs::read_to_string(dir.path().join(format!("{long}.~9~"))).unwrap(), "nine");
	}

	/// Checks a caller of [`backup_path`] (`util` is `mv`, `cp` or `ln`)
	/// where a long name makes the backup give way to a `~` name that is the
	/// source, the destination itself, another hard link of the source, or
	/// another entry. `run(dir, args)` runs the utility in `dir` and returns
	/// its exit status and standard error. Names: `D` is 251 bytes (beside
	/// `D.~9~`, so `D.~10~` is too long and the backup is `D~`); `L` is 255
	/// bytes of `a`, whose `~` name is `A~`, 253 bytes of `a` and `~`, which
	/// is also the destination `E` of the destination cases.
	///
	/// GNU coreutils 9.4 and 9.7, run on each case:
	/// - mv and cp refuse every numbered backup whose `~` name an entry
	///   holds, with these "cannot backup" messages (they rename it without
	///   replacing); ln replaces that entry, and all three replace a simple
	///   backup's `~` name.
	/// - Where that entry is the source, mv and ln exit 0 with the source's
	///   contents lost (cp fails, but after the loss).
	/// - Where it is the destination itself, mv's `-b` and ln exit 0 with the
	///   old contents lost; cp fails with "cannot create regular file 'E':
	///   File exists" and keeps `E`.
	/// - Where it is another hard link of the source, ln replaces it and
	///   keeps the source.
	///
	/// Here the losses are refused: a backup that is the source's own entry
	/// with GNU's "might destroy source", one that is the destination itself
	/// with "cannot backup" (cp's message is not GNU's there). ln replaces an
	/// unrelated entry, and another link of its source, as GNU ln does.
	pub(crate) fn check_long_name_backups(util: &str, run: impl Fn(&Path, &[&str]) -> (i32, String)) {
		let root = tempfile::tempdir().unwrap();
		if !fits_255_byte_names(root.path()) {
			return;
		}
		let d = "d".repeat(251);
		let (d_tilde, d_nine) = (format!("{d}~"), format!("{d}.~9~"));
		let (l, cut) = ("a".repeat(255), format!("{}~", "a".repeat(253)));
		let verb = match util {
			"mv" => "moved",
			"cp" => "copied",
			_ => "linked",
		};
		let cannot_backup = |dest: &str| (1, format!("{util}: cannot backup '{dest}': File exists\n"));
		let destroys = |dest: &str, source: &str| {
			(1, format!("{util}: backing up '{dest}' might destroy source;  '{source}' not {verb}\n"))
		};
		let check = |case: &str, before: &[(&str, &str)], args: &[&str], expected: (i32, String), after: &[(&str, &str)]| {
			let dir = root.path().join(case);
			fs::create_dir(&dir).unwrap();
			for (name, content) in before {
				fs::write(dir.join(name), content).unwrap();
			}
			assert_eq!(run(&dir, args), expected, "{util} {case}");
			for (name, content) in after {
				assert_eq!(
					fs::read_to_string(dir.join(name)).ok().as_deref(),
					Some(*content),
					"{util} {case}: {} bytes",
					name.len()
				);
			}
		};
		let source_d = [(d.as_str(), "old"), (d_nine.as_str(), "nine"), (d_tilde.as_str(), "payload")];
		check(
			"source-numbered",
			&source_d,
			&["--backup=numbered", &d_tilde, &d],
			if util == "ln" { destroys(&d, &d_tilde) } else { cannot_backup(&d) },
			&source_d,
		);
		let source_cut = [(cut.as_str(), "payload"), (l.as_str(), "old")];
		check(
			"source-cut-numbered",
			&source_cut,
			&["--backup=numbered", &cut, &l],
			if util == "ln" { destroys(&l, &cut) } else { cannot_backup(&l) },
			&source_cut,
		);
		check("source-cut-simple", &source_cut, &["-b", &cut, &l], destroys(&l, &cut), &source_cut);
		let destination = [(cut.as_str(), "old"), ("src", "new")];
		for control in ["--backup=numbered", "-b", "--backup=existing"] {
			let case = format!("destination{control}");
			check(&case, &destination, &[control, "src", &cut], cannot_backup(&cut), &destination);
		}
		let unrelated = [(d.as_str(), "old"), (d_nine.as_str(), "nine"), (d_tilde.as_str(), "other"), ("src", "new")];
		for control in ["--backup=numbered", "--backup=existing"] {
			let case = format!("unrelated{control}");
			if util == "ln" {
				let replaced = [(d.as_str(), "new"), (d_nine.as_str(), "nine"), (d_tilde.as_str(), "old")];
				check(&case, &unrelated, &[control, "src", &d], (0, String::new()), &replaced);
			} else {
				check(&case, &unrelated, &[control, "src", &d], cannot_backup(&d), &unrelated);
			}
		}
		// Another hard link of the source holds the `~` name: replacing it
		// removes only that link, and GNU ln does; GNU's mv and cp refuse it
		// as any held name.
		let dir = root.path().join("hardlink-numbered");
		fs::create_dir(&dir).unwrap();
		for (name, content) in [("s", "S"), (d.as_str(), "old"), (d_nine.as_str(), "nine")] {
			fs::write(dir.join(name), content).unwrap();
		}
		fs::hard_link(dir.join("s"), dir.join(&d_tilde)).unwrap();
		let args = ["--backup=numbered", "s", d.as_str()];
		let (expected, after) = if util == "ln" {
			((0, String::new()), [("s", "S"), (d.as_str(), "S"), (d_tilde.as_str(), "old"), (d_nine.as_str(), "nine")])
		} else {
			(cannot_backup(&d), [("s", "S"), (d.as_str(), "old"), (d_tilde.as_str(), "S"), (d_nine.as_str(), "nine")])
		};
		assert_eq!(run(&dir, &args), expected, "{util} hardlink-numbered");
		for (name, content) in after {
			assert_eq!(
				fs::read_to_string(dir.join(name)).ok().as_deref(),
				Some(content),
				"{util} hardlink-numbered: {} bytes",
				name.len()
			);
		}
	}

	/// Checks a caller of [`backup_path`] (`util` is `mv`, `cp` or `ln`, and
	/// `symbolic` for `ln -s`) where the backup name `dest~` is another hard
	/// link of the source `a`: renaming `dest` over it removes only that link
	/// and leaves `a`, so the backup is made, as GNU 9.4 and 9.7 make it in
	/// every backup mode. In each mode, in a directory holding `a` ("A"),
	/// `dest` ("old") and `dest~` (a hard link of `a`), `run(dir, control)`
	/// must run `<util> CONTROL a dest` and succeed: `dest` is `a`'s file (a
	/// symbolic link to `a` for `ln -s`), the backup holds "old", and `a` is
	/// gone after mv and kept otherwise.
	pub(crate) fn check_hard_link_backups(util: &str, symbolic: bool, run: impl Fn(&Path, &str) -> (i32, String)) {
		let root = tempfile::tempdir().unwrap();
		for control in ["-b", "--backup=simple", "--backup=existing", "--backup=numbered"] {
			let case = format!("{util}{}{control}", if symbolic { " -s" } else { "" });
			let dir = root.path().join(control.trim_start_matches('-'));
			fs::create_dir(&dir).unwrap();
			fs::write(dir.join("a"), "A").unwrap();
			fs::write(dir.join("dest"), "old").unwrap();
			fs::hard_link(dir.join("a"), dir.join("dest~")).unwrap();
			assert_eq!(run(&dir, control), (0, String::new()), "{case}");
			let backup = if control == "--backup=numbered" { "dest.~1~" } else { "dest~" };
			assert_eq!(fs::read_to_string(dir.join(backup)).ok().as_deref(), Some("old"), "{case}: no backup at {backup}");
			if symbolic {
				assert_eq!(fs::read_link(dir.join("dest")).ok().as_deref(), Some(Path::new("a")), "{case}: dest");
			} else {
				assert_eq!(fs::read_to_string(dir.join("dest")).ok().as_deref(), Some("A"), "{case}: dest");
			}
			let source = (util != "mv").then_some("A");
			assert_eq!(fs::read_to_string(dir.join("a")).ok().as_deref(), source, "{case}: the source");
			if control == "--backup=numbered" {
				assert_eq!(fs::read_to_string(dir.join("dest~")).ok().as_deref(), Some("A"), "{case}: dest~ replaced");
			}
		}
	}
}
