//! Backup control for `cp`, `ln`, and `mv` through the shell.
//!
//! `uucore::backup_control` reads `VERSION_CONTROL`/`SIMPLE_BACKUP_SUFFIX`
//! from the host process and probes numbered backups on the host filesystem;
//! these helpers read the shell's exported environment and probe the shell's
//! filesystem instead, keeping URL (`scheme://`) spellings intact.

use std::{
	ffi::OsStr,
	io,
	path::{Path, PathBuf},
};

#[cfg(any(feature = "util.cp", feature = "util.mv"))]
use clap::ArgMatches;
use pi_vfs::{BlockingFs, child_path, file_name, parent_path, with_file_name};
use uucore::backup_control::BackupMode;
#[cfg(any(feature = "util.cp", feature = "util.mv"))]
use uucore::{backup_control, display::Quotable};

#[cfg(any(feature = "util.cp", feature = "util.mv"))]
use crate::host::Host;

/// Resolves a `--backup` CONTROL word (unique prefixes allowed); the error is
/// the GNU diagnostic naming `origin`.
#[cfg(any(feature = "util.cp", feature = "util.mv"))]
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
#[cfg(any(feature = "util.cp", feature = "util.mv"))]
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
/// `~`; a suffix containing `/` falls back to `~`.
#[cfg(any(feature = "util.cp", feature = "util.mv"))]
pub(crate) fn determine_backup_suffix(matches: &ArgMatches, host: &Host) -> String {
	let suffix = matches
		.get_one::<String>(backup_control::arguments::OPT_SUFFIX)
		.map(String::as_str)
		.or_else(|| host.var("SIMPLE_BACKUP_SUFFIX"))
		.unwrap_or(backup_control::DEFAULT_BACKUP_SUFFIX);
	if suffix.contains('/') {
		backup_control::DEFAULT_BACKUP_SUFFIX.to_string()
	} else {
		suffix.to_string()
	}
}

/// The backup name for `path` under `mode`. A numbered backup is
/// `name.~N~` with N one past the highest version among the entries of
/// `path`'s directory, as GNU's `numbered_backup` (gnulib backupfile.c)
/// reads them: every entry `name.~N~` counts, whatever it is, a symlink
/// that points nowhere included, and N is digits without a leading zero,
/// compared as a string so that no version overflows. `existing` numbers
/// when any numbered backup is there, and uses `suffix` otherwise. A
/// directory that cannot be listed is probed instead, `name.~1~` upward,
/// for the first name no entry holds (`lstat`), so that the backup never
/// lands on an entry.
pub(crate) fn backup_path(
	filesystem: &BlockingFs,
	mode: BackupMode,
	path: &Path,
	suffix: impl AsRef<OsStr>,
) -> Option<PathBuf> {
	let simple = |suffix: &OsStr| {
		let mut name = file_name(path).unwrap_or_default().into_owned();
		name.push(suffix);
		with_file_name(path, name)
	};
	let numbered = |version: &str| simple(OsStr::new(&format!(".~{version}~")));
	if matches!(mode, BackupMode::None | BackupMode::Simple) {
		return (mode == BackupMode::Simple).then(|| simple(suffix.as_ref()));
	}
	match highest_backup(filesystem, path) {
		Ok(Some(highest)) => Some(numbered(&next_version(&highest))),
		Ok(None) if mode == BackupMode::Numbered => Some(numbered("1")),
		Ok(None) => Some(simple(suffix.as_ref())),
		Err(_) => {
			let taken = |version: u64| filesystem.symlink_metadata(numbered(&version.to_string())).is_ok();
			if mode == BackupMode::Existing && !taken(1) {
				return Some(simple(suffix.as_ref()));
			}
			let free = (1u64..).find(|&version| !taken(version)).expect("backup versions are unbounded");
			Some(numbered(&free.to_string()))
		},
	}
}

/// The highest version N, as its digits, among the entries `name.~N~` of
/// `path`'s directory; `None` when there is none. An entry the listing
/// cannot read is skipped, as GNU uses the highest version it read.
fn highest_backup(filesystem: &BlockingFs, path: &Path) -> io::Result<Option<Vec<u8>>> {
	let Some(name) = file_name(path) else {
		return Ok(None);
	};
	let dir = parent_path(path)
		.filter(|dir| !dir.as_os_str().is_empty())
		.unwrap_or(Path::new("."));
	let mut prefix = name.into_owned();
	prefix.push(".~");
	let prefix = prefix.as_encoded_bytes();
	let mut highest: Option<Vec<u8>> = None;
	for entry in filesystem.read_dir(dir)?.flatten() {
		let entry = entry.file_name();
		let Some(version) = entry
			.as_encoded_bytes()
			.strip_prefix(prefix)
			.and_then(|rest| rest.strip_suffix(b"~"))
		else {
			continue;
		};
		let counts = matches!(version.first(), Some(b'1'..=b'9')) && version.iter().all(u8::is_ascii_digit);
		if counts && highest.as_ref().is_none_or(|top| (version.len(), version) > (top.len(), top.as_slice())) {
			highest = Some(version.to_vec());
		}
	}
	Ok(highest)
}

/// `version` (ASCII digits) plus one, as digits.
fn next_version(version: &[u8]) -> String {
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
	String::from_utf8(digits).expect("ASCII digits")
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

	use super::backup_path;

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
				backup_path(&vfs, BackupMode::Numbered, &dir.path().join("dest"), "~"),
				Some(dir.path().join(expected)),
				"{entries:?}"
			);
		}
	}

	/// A directory that cannot be listed (search permission only) shows no
	/// numbered backup. `existing` then uses the simple name, as GNU 9.4 and
	/// 9.7 do in mv, cp and ln. `numbered` takes the first name no entry
	/// holds by `lstat`, a symlink to nothing included, from `name.~1~` up.
	/// That is not GNU's: there mv and cp retry `name.~1~` without end, and ln
	/// replaces it.
	#[test]
	fn a_directory_that_cannot_be_listed_is_probed_for_a_free_backup_name() {
		use std::os::unix::fs::PermissionsExt as _;
		let vfs = pi_vfs::BlockingFs::native();
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("dest"), "old").unwrap();
		symlink("missing", dir.path().join("dest.~1~")).unwrap();
		fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o311)).unwrap();
		let listable = fs::read_dir(dir.path()).is_ok();
		let numbered = backup_path(&vfs, BackupMode::Numbered, &dir.path().join("dest"), "~");
		let existing = backup_path(&vfs, BackupMode::Existing, &dir.path().join("dest"), "~");
		fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
		if listable {
			eprintln!("skipped: this process lists a directory without read permission");
			return;
		}
		assert_eq!(numbered, Some(dir.path().join("dest.~2~")));
		assert_eq!(existing, Some(dir.path().join("dest~")));
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
		assert_eq!(backup_path(&vfs, BackupMode::Numbered, &dest, "~"), Some(dir.path().join("dest.~2~")));
		assert_eq!(backup_path(&vfs, BackupMode::Existing, &dest, "~"), Some(dir.path().join("dest~")));
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
		match pathconf_name_max(dir.path()) {
			Some(255) => {},
			other => {
				eprintln!("skipped: NAME_MAX here is {other:?}, not 255");
				return;
			},
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
				backup_path(&vfs, mode, &dir.path().join(&file), "~"),
				Some(dir.path().join(&expected)),
				"{} bytes, listed {listed:?}, {mode:?}",
				file.len()
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
		let long = "a".repeat(251);
		fs::write(dir.path().join("src"), "new").unwrap();
		fs::write(dir.path().join(&long), "old").unwrap();
		fs::write(dir.path().join(format!("{long}.~9~")), "nine").unwrap();
		assert_eq!(run(dir.path(), &long), (0, String::new()));
		assert_eq!(fs::read_to_string(dir.path().join(format!("{long}~"))).ok().as_deref(), Some("old"));
		assert_eq!(fs::read_to_string(dir.path().join(&long)).unwrap(), "new");
		assert_eq!(fs::read_to_string(dir.path().join(format!("{long}.~9~"))).unwrap(), "nine");
	}
}
