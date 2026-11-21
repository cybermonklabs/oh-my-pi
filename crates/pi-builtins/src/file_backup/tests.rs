//! Tests of the backup naming, and the test support that the `mv`, `cp` and
//! `ln` tests share: providers over host files (one without file identities,
//! one whose names fold), and the checks each caller runs against GNU's
//! answers.

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

/// A provider over host files whose names fold, as on a case-insensitive
/// filesystem (APFS and NTFS by default, a casefold ext4 or tmpfs
/// directory): a path whose last name is no entry of its directory, but
/// matches one but for ASCII case, names that entry. Identities and link
/// counts are the host's.
#[derive(Debug, Default)]
pub(crate) struct FoldingHost;

impl FoldingHost {
	/// A filesystem over this provider.
	pub(crate) fn fs() -> pi_vfs::Fs {
		pi_vfs::Fs::new(Arc::new(Self))
	}

	/// The host path `path` names.
	fn fold(path: &Path) -> PathBuf {
		let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
			return path.to_path_buf();
		};
		if fs::symlink_metadata(path).is_ok() {
			return path.to_path_buf();
		}
		let Ok(entries) = fs::read_dir(dir) else {
			return path.to_path_buf();
		};
		entries
			.filter_map(Result::ok)
			.map(|entry| entry.file_name())
			.find(|entry| entry.eq_ignore_ascii_case(name))
			.map_or_else(|| path.to_path_buf(), |entry| dir.join(entry))
	}
}

#[async_trait::async_trait]
impl pi_vfs::FileSystem for FoldingHost {
	async fn open(&self, path: &Path, options: &pi_vfs::OpenOptions) -> io::Result<pi_vfs::File> {
		pi_vfs::Fs::default().open_with(Self::fold(path), options).await
	}

	async fn metadata(&self, path: &Path) -> io::Result<pi_vfs::Metadata> {
		pi_vfs::Fs::default().metadata(Self::fold(path)).await
	}

	async fn symlink_metadata(&self, path: &Path) -> io::Result<pi_vfs::Metadata> {
		pi_vfs::Fs::default().symlink_metadata(Self::fold(path)).await
	}

	async fn read_dir(&self, path: &Path) -> io::Result<pi_vfs::ReadDir> {
		pi_vfs::Fs::default().read_dir(Self::fold(path)).await
	}

	async fn read_link(&self, path: &Path) -> io::Result<PathBuf> {
		pi_vfs::Fs::default().read_link(Self::fold(path)).await
	}

	async fn create_dir(&self, path: &Path, _mode: Option<u32>) -> io::Result<()> {
		pi_vfs::Fs::default().create_dir(Self::fold(path)).await
	}

	async fn remove_file(&self, path: &Path) -> io::Result<()> {
		pi_vfs::Fs::default().remove_file(Self::fold(path)).await
	}

	async fn remove_dir(&self, path: &Path) -> io::Result<()> {
		pi_vfs::Fs::default().remove_dir(Self::fold(path)).await
	}

	async fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
		pi_vfs::Fs::default().rename(Self::fold(from), Self::fold(to)).await
	}

	async fn copy(&self, from: &Path, to: &Path) -> io::Result<u64> {
		pi_vfs::Fs::default().copy(Self::fold(from), Self::fold(to)).await
	}

	async fn hard_link(&self, original: &Path, link: &Path) -> io::Result<()> {
		pi_vfs::Fs::default().hard_link(Self::fold(original), Self::fold(link)).await
	}

	async fn symlink(&self, target: &Path, link: &Path, kind: pi_vfs::SymlinkKind) -> io::Result<()> {
		pi_vfs::Fs::default().symlink_with(target, Self::fold(link), kind).await
	}

	async fn set_permissions(&self, path: &Path, permissions: pi_vfs::Permissions) -> io::Result<()> {
		pi_vfs::Fs::default().set_permissions(Self::fold(path), permissions).await
	}
}

/// Whether names fold in `dir`: a file made as `fold-probe` is found as
/// `FOLD-PROBE`.
pub(crate) fn folds_names(dir: &Path) -> bool {
	let probe = dir.join("fold-probe");
	fs::write(&probe, "").unwrap();
	let folds = dir.join("FOLD-PROBE").exists();
	fs::remove_file(&probe).unwrap();
	folds
}

/// The entries of `dir` in name order, as the GNU comparison script
/// prints them: a regular file as ` name=contents#links`, a symbolic
/// link as ` name=link:target`.
pub(crate) fn listing(dir: &Path) -> String {
	use std::os::unix::fs::MetadataExt as _;
	let mut names = fs::read_dir(dir)
		.unwrap()
		.map(|entry| entry.unwrap().file_name().into_string().unwrap())
		.collect::<Vec<_>>();
	names.sort();
	names
		.iter()
		.map(|name| {
			let path = dir.join(name);
			let metadata = fs::symlink_metadata(&path).unwrap();
			if metadata.is_symlink() {
				format!(" {name}=link:{}", fs::read_link(&path).unwrap().display())
			} else {
				format!(" {name}={}#{}", fs::read_to_string(&path).unwrap(), metadata.nlink())
			}
		})
		.collect()
}

/// Checks `util` (`mv`, `cp`, `ln` or `ln -s`) where names fold and the
/// source `DEST~` ("P") is the backup's entry: `<util> -b DEST~ dest`,
/// with `dest` ("old"), backs `dest` up as `dest~`, which names `DEST~`.
/// `run(fs, dir, args)` runs it over `fs` in `dir` and returns the exit
/// status and standard error. It runs over the host where a temporary
/// directory folds names (a casefold tmpfs or ext4 directory, APFS), and
/// says the host half was skipped elsewhere; then over [`FoldingHost`].
///
/// - `DEST~` with one link is one entry with `dest~`, by its identity:
///   refused with "might destroy source", nothing changed. GNU 9.4 and
///   9.7, in a casefold tmpfs directory, lose P: mv and ln exit 0, and cp
///   exits 1 ("skipping file 'DEST~', as it was replaced while being
///   copied").
/// - With a second link, `other`, no name or identity tells the entries
///   apart. The backup replaces the entry `DEST~` and P stays in
///   `other`, as with GNU; mv moves and ln links the old contents, as
///   GNU's do; cp finds its source replaced when it opens it and fails as
///   GNU cp fails, leaving the old contents at the backup name, where GNU
///   renames them back to `dest`.
pub(crate) fn check_folded_sources(util: &str, run: impl Fn(&pi_vfs::Fs, &Path, &[&str]) -> (i32, String)) {
	let root = tempfile::tempdir().unwrap();
	if folds_names(root.path()) {
		let host = pi_vfs::Fs::default();
		check_folded_source("host", util, &root.path().join("host"), |dir, args| run(&host, dir, args));
	} else {
		eprintln!("{util}: the host half is skipped: names do not fold in {}", root.path().display());
	}
	let folding = FoldingHost::fs();
	check_folded_source("provider", util, &root.path().join("provider"), |dir, args| {
		run(&folding, dir, args)
	});
}

fn check_folded_source(half: &str, util: &str, root: &Path, run: impl Fn(&Path, &[&str]) -> (i32, String)) {
	let symbolic = util == "ln -s";
	let (name, verb) = match util {
		"mv" => ("mv", "moved"),
		"cp" => ("cp", "copied"),
		_ => ("ln", "linked"),
	};
	let args: &[&str] = if symbolic { &["-s", "-b", "DEST~", "dest"] } else { &["-b", "DEST~", "dest"] };
	for links in [1, 2] {
		let case = format!("{half}: {util} links={links}");
		let dir = root.join(format!("{}{links}", util.replace(' ', "")));
		fs::create_dir_all(&dir).unwrap();
		fs::write(dir.join("DEST~"), "P").unwrap();
		fs::write(dir.join("dest"), "old").unwrap();
		if links == 2 {
			fs::hard_link(dir.join("DEST~"), dir.join("other")).unwrap();
		}
		let got = run(&dir, args);
		let read = |entry: &str| fs::read_to_string(dir.join(entry)).ok();
		if links == 1 {
			let refused = format!("{name}: backing up 'dest' might destroy source;  'DEST~' not {verb}\n");
			assert_eq!(got, (1, refused), "{case}");
			assert_eq!(read("DEST~").as_deref(), Some("P"), "{case}: the source was lost");
			assert_eq!(read("dest").as_deref(), Some("old"), "{case}: dest changed");
			continue;
		}
		assert_eq!(read("other").as_deref(), Some("P"), "{case}: the second link was lost");
		match util {
			"cp" => {
				let skipped = "cp: skipping file 'DEST~', as it was replaced while being copied\n";
				assert_eq!(got, (1, skipped.to_owned()), "{case}");
				assert_eq!(read("DEST~").as_deref(), Some("old"), "{case}: no backup");
				assert_eq!(read("dest"), None, "{case}: the replaced source was copied");
			},
			"mv" => {
				assert_eq!(got, (0, String::new()), "{case}");
				assert_eq!(read("dest").as_deref(), Some("old"), "{case}");
			},
			_ => {
				assert_eq!(got, (0, String::new()), "{case}");
				assert_eq!(read("dest").as_deref(), Some("old"), "{case}");
				assert_eq!(read("DEST~").as_deref(), Some("old"), "{case}: no backup");
			},
		}
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
