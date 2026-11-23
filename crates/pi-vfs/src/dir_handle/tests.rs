//! Tests of [`super::DirHandle`]'s calls, each on the host and on a provider.
//!
//! The provider is [`Aliased`]: it serves `mem://t` from a host directory
//! through `std`, so its symlinks are real, and it records every path call,
//! so a test sees which path and which call the provider side made of an
//! entry name. Each test reads its outcome from the disk, never through the
//! call it tests.

#[cfg(unix)]
use std::{
	io,
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
};

use super::{check_relative, entry_name};

/// An entry name is exactly one component on every platform: an empty name,
/// `.`, `..` and a name with a separator are refused everywhere (on Windows
/// `\` is one too). A name holding `:` is one entry here; a Windows host
/// handle refuses it itself
/// (`windows::a_colon_name_is_refused_on_the_host_and_taken_by_a_provider`).
#[test]
fn entry_names_are_exactly_one_component() {
	use std::ffi::OsStr;
	for name in ["", ".", "..", "a/b", "/a", "a/"] {
		assert!(entry_name(OsStr::new(name)).is_err(), "{name:?}");
	}
	for name in ["a", "a b", ".a", "a.", "..a", "C:x", "ab:s", "x::$INDEX_ALLOCATION", "a:"] {
		assert!(entry_name(OsStr::new(name)).is_ok(), "{name:?}");
	}
	for name in ["a\\b", "\\\\?\\x", "\\a"] {
		assert_eq!(entry_name(OsStr::new(name)).is_err(), cfg!(windows), "{name:?}");
	}
}

/// A walk-relative path splits on `/`, and on Windows on `\` too, so a `..`
/// hidden behind `\` is refused there; elsewhere `\` is part of a name.
#[test]
fn walk_relative_paths_split_on_the_platform_separators() {
	assert!(check_relative(b"a/b").is_ok());
	assert!(check_relative(b"a/../b").is_err());
	for rel in [&b"a\\..\\b"[..], b"a\\.", b"a\\\\b", b"\\a"] {
		assert_eq!(check_relative(rel).is_err(), cfg!(windows), "{:?}", String::from_utf8_lossy(rel));
	}
}

/// A unique temporary directory below [`super::temp_root`], removed on drop.
#[cfg(unix)]
struct TempDir(PathBuf);

#[cfg(unix)]
impl TempDir {
	fn new(tag: &str) -> Self {
		static NEXT: AtomicUsize = AtomicUsize::new(0);
		let n = NEXT.fetch_add(1, Ordering::Relaxed);
		let path = super::temp_root()
			.canonicalize()
			.unwrap()
			.join(format!("pi-vfs-dh-{tag}-{}-{n}", std::process::id()));
		let _ = std::fs::remove_dir_all(&path);
		std::fs::create_dir_all(&path).unwrap();
		Self(path)
	}
}

#[cfg(unix)]
impl Drop for TempDir {
	fn drop(&mut self) {
		let _ = std::fs::remove_dir_all(&self.0);
	}
}

#[cfg(unix)]
mod unix {
	use std::{
		ffi::OsStr,
		io::{Read, Write},
		os::unix::fs::{MetadataExt, PermissionsExt},
		time::{Duration, UNIX_EPOCH},
	};

	use async_trait::async_trait;
	use parking_lot::Mutex;

	use super::*;
	use crate::{
		BlockingFs, DirEntry, DirHandle, File, FileSystem, FileTime, Fs, Metadata, OpenOptions,
		Permissions, ReadDir, SymlinkKind,
		dir_handle::{Detail, FileType, Listing, is_symlink_refusal},
	};

	/// A provider serving `mem://t` from the host directory `root` through
	/// `std`, recording each call as `"<call> <path>"`.
	#[derive(Debug)]
	struct Aliased {
		root:  PathBuf,
		calls: Mutex<Vec<String>>,
	}

	impl Aliased {
		fn host(&self, path: &Path) -> io::Result<PathBuf> {
			let rest = path
				.to_str()
				.and_then(|path| path.strip_prefix("mem://t"))
				.ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
			Ok(self.root.join(rest.trim_start_matches('/')))
		}

		fn record(&self, call: &str, path: &Path) -> io::Result<PathBuf> {
			self.calls.lock().push(format!("{call} {}", path.display()));
			self.host(path)
		}

		/// The calls recorded since the last take.
		fn take(&self) -> Vec<String> {
			std::mem::take(&mut *self.calls.lock())
		}
	}

	#[async_trait]
	impl FileSystem for Aliased {
		async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<File> {
			let host = self.record("open", path)?;
			options.to_std().open(host).map(File::from)
		}

		async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
			std::fs::metadata(self.record("metadata", path)?).map(Metadata::from)
		}

		async fn symlink_metadata(&self, path: &Path) -> io::Result<Metadata> {
			std::fs::symlink_metadata(self.record("symlink_metadata", path)?).map(Metadata::from)
		}

		async fn read_dir(&self, path: &Path) -> io::Result<ReadDir> {
			let host = self.record("read_dir", path)?;
			let mut entries = Vec::new();
			for entry in std::fs::read_dir(host)? {
				let entry = entry?;
				let name = entry.file_name();
				let child = crate::child_path(path, &name);
				entries.push(Ok(DirEntry::new(child, name, Some(entry.file_type()?.into()))));
			}
			Ok(ReadDir::from_entries(entries))
		}

		async fn create_dir(&self, path: &Path, mode: Option<u32>) -> io::Result<()> {
			use std::os::unix::fs::DirBuilderExt;
			let host = self.record("create_dir", path)?;
			std::fs::DirBuilder::new()
				.mode(mode.unwrap_or(0o777))
				.create(host)
		}

		async fn remove_file(&self, path: &Path) -> io::Result<()> {
			std::fs::remove_file(self.record("remove_file", path)?)
		}

		async fn remove_dir(&self, path: &Path) -> io::Result<()> {
			std::fs::remove_dir(self.record("remove_dir", path)?)
		}

		async fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
			let to_host = self.host(to)?;
			std::fs::rename(self.record("rename", from)?, to_host)
		}

		async fn symlink(&self, target: &Path, link: &Path, _kind: SymlinkKind) -> io::Result<()> {
			std::os::unix::fs::symlink(target, self.record("symlink", link)?)
		}

		async fn read_link(&self, path: &Path) -> io::Result<PathBuf> {
			std::fs::read_link(self.record("read_link", path)?)
		}

		async fn set_permissions(&self, path: &Path, permissions: Permissions) -> io::Result<()> {
			let host = self.record("set_permissions", path)?;
			std::fs::set_permissions(host, std::fs::Permissions::from_mode(permissions.mode()))
		}

		async fn set_times(
			&self,
			path: &Path,
			accessed: FileTime,
			modified: FileTime,
			follow: bool,
		) -> io::Result<()> {
			let host = self.record(
				if follow {
					"set_times"
				} else {
					"set_times_nofollow"
				},
				path,
			)?;
			crate::native::set_times(&host, accessed, modified, follow)
		}

		async fn chown(
			&self,
			path: &Path,
			uid: Option<u32>,
			gid: Option<u32>,
			follow: bool,
		) -> io::Result<()> {
			let host = self.record(if follow { "chown" } else { "chown_nofollow" }, path)?;
			crate::native::chown(&host, uid, gid, follow)
		}
	}

	/// The tree every test starts from, in `root/`:
	/// - `f`, a regular file holding `data`;
	/// - `d/`, a directory holding `d/inner`;
	/// - `l`, a symlink to `f`; `ld`, a symlink to `d`;
	///
	/// and next to it `outside/secret`, which no call below `root` reaches.
	struct Tree {
		tmp:      TempDir,
		provider: Arc<Aliased>,
	}

	impl Tree {
		fn new(tag: &str) -> Self {
			let tmp = TempDir::new(tag);
			let root = tmp.0.join("root");
			std::fs::create_dir_all(root.join("d")).unwrap();
			std::fs::create_dir_all(tmp.0.join("outside")).unwrap();
			std::fs::write(root.join("f"), "data").unwrap();
			std::fs::write(root.join("d/inner"), "inner").unwrap();
			std::fs::write(tmp.0.join("outside/secret"), "secret").unwrap();
			std::os::unix::fs::symlink("f", root.join("l")).unwrap();
			std::os::unix::fs::symlink("d", root.join("ld")).unwrap();
			let provider = Arc::new(Aliased { root, calls: Mutex::new(Vec::new()) });
			Self { tmp, provider }
		}

		/// `root/<rel>` on the host.
		fn at(&self, rel: &str) -> PathBuf {
			self.tmp.0.join("root").join(rel)
		}

		fn outside(&self) -> PathBuf {
			self.tmp.0.join("outside")
		}

		fn provider_fs(&self) -> BlockingFs {
			Fs::new(Arc::clone(&self.provider) as Arc<dyn FileSystem>).blocking()
		}

		/// The root opened on the host and on the provider, by label.
		fn roots(&self) -> [(&'static str, DirHandle); 2] {
			let host = BlockingFs::native().open_dir(self.at(""), true).unwrap();
			let provider = self.provider_fs().open_dir("mem://t", true).unwrap();
			assert!(host.is_native() && !provider.is_native());
			self.provider.take();
			[("host", host), ("provider", provider)]
		}
	}

	fn n(name: &str) -> &OsStr {
		OsStr::new(name)
	}

	/// A runtime for the `_async` twins.
	fn runtime() -> tokio::runtime::Runtime {
		tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()
			.unwrap()
	}

	fn names(listing: &Listing) -> Vec<(String, FileType)> {
		let mut names: Vec<_> = listing
			.records()
			.iter()
			.map(|r| (String::from_utf8_lossy(listing.name(r)).into_owned(), r.file_type))
			.collect();
		names.sort_by(|a, b| a.0.cmp(&b.0));
		names
	}

	/// Whether `err` is a refused symlink: `ELOOP`/`ENOTDIR` on the host, the
	/// provider's refusal or its not-a-directory on a provider.
	fn refused(err: &io::Error) -> bool {
		matches!(err.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR))
			|| is_symlink_refusal(err)
			|| err.kind() == io::ErrorKind::NotADirectory
	}

	const NOT_ONE_NAME: [&str; 5] = ["", ".", "..", "d/inner", "/f"];

	/// `open_dir_at` opens a subdirectory and never one through a symlink;
	/// a file, and a name that is not one entry, are refused.
	#[test]
	fn open_dir_at_opens_a_subdirectory_and_no_symlink() {
		let tree = Tree::new("open-dir-at");
		let rt = runtime();
		for (label, root) in tree.roots() {
			for (flavor, opened) in [
				("sync", root.open_dir_at(n("d"))),
				("async", rt.block_on(root.open_dir_at_async(n("d")))),
			] {
				let d = opened.unwrap_or_else(|err| panic!("{label} {flavor}: {err}"));
				let mut out = Listing::default();
				d.list_into(Detail::Minimal, 0, &mut out).unwrap();
				assert_eq!(names(&out), [("inner".to_owned(), FileType::File)], "{label} {flavor}");
				for refused_name in ["ld", "f", "missing"] {
					let sync = root.open_dir_at(n(refused_name));
					let asynchronous = rt.block_on(root.open_dir_at_async(n(refused_name)));
					for err in [sync, asynchronous].map(Result::unwrap_err) {
						if refused_name == "ld" {
							assert!(refused(&err), "{label} {flavor}: ld opened: {err:?}");
						}
					}
				}
			}
			for name in NOT_ONE_NAME {
				let err = root.open_dir_at(n(name)).unwrap_err();
				assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{label}: {name:?}");
			}
		}
		// Both flavors open `d` before the listing: the provider checked the
		// joined path without following it, then listed it.
		assert_eq!(tree.provider.take()[..3], [
			"symlink_metadata mem://t/d".to_owned(),
			"symlink_metadata mem://t/d".to_owned(),
			"read_dir mem://t/d".to_owned()
		]);
	}

	/// The control: a directory swapped for a symlink to `outside/` after its
	/// parent was listed is refused, and nothing below `outside/` is listed
	/// through it, as find and grep refuse it.
	#[test]
	fn open_dir_at_refuses_a_directory_swapped_for_a_symlink() {
		let tree = Tree::new("swap");
		for (label, root) in tree.roots() {
			let mut out = Listing::default();
			root.list_into(Detail::Minimal, 0, &mut out).unwrap();
			assert!(names(&out).contains(&("d".to_owned(), FileType::Dir)), "{label}");
			std::fs::rename(tree.at("d"), tree.at("d-parked")).unwrap();
			std::os::unix::fs::symlink(tree.outside(), tree.at("d")).unwrap();
			match root.open_dir_at(n("d")) {
				Err(err) => assert!(refused(&err), "{label}: {err:?}"),
				Ok(through) => {
					let mut out = Listing::default();
					let _ = through.list_into(Detail::Minimal, 0, &mut out);
					panic!("{label}: opened the swapped link, which lists {:?}", names(&out));
				},
			}
			std::fs::remove_file(tree.at("d")).unwrap();
			std::fs::rename(tree.at("d-parked"), tree.at("d")).unwrap();
		}
	}

	/// `stat_at` describes the entry, following a symlink only with `follow`,
	/// with the identity the path's own metadata has.
	#[test]
	fn stat_at_follows_a_symlink_only_when_asked() {
		let tree = Tree::new("stat-at");
		let rt = runtime();
		let f = std::fs::metadata(tree.at("f")).unwrap();
		let l = std::fs::symlink_metadata(tree.at("l")).unwrap();
		for (label, root) in tree.roots() {
			for flavor in ["sync", "async"] {
				let stat = |name: &str, follow: bool| match flavor {
					"sync" => root.stat_at(n(name), follow),
					_ => rt.block_on(root.stat_at_async(n(name), follow)),
				};
				let file = stat("f", false).unwrap();
				assert!(file.is_file() && file.len() == 4, "{label} {flavor}: {file:?}");
				assert_eq!(
					(file.dev(), file.ino()),
					(Some(f.dev()), Some(f.ino())),
					"{label} {flavor}"
				);
				let link = stat("l", false).unwrap();
				assert!(link.is_symlink(), "{label} {flavor}: l not followed: {link:?}");
				assert_eq!(link.ino(), Some(l.ino()), "{label} {flavor}");
				let target = stat("l", true).unwrap();
				assert!(target.is_file() && target.ino() == Some(f.ino()), "{label} {flavor}");
				assert_eq!(stat("missing", false).unwrap_err().kind(), io::ErrorKind::NotFound);
			}
		}
		let calls = tree.provider.take();
		assert_eq!(calls[..3], [
			"symlink_metadata mem://t/f".to_owned(),
			"symlink_metadata mem://t/l".to_owned(),
			"metadata mem://t/l".to_owned()
		]);
	}

	/// `open_at` opens the entry as the options say and never through a
	/// symlink, and creates a file only once (the modes it creates with are
	/// checked in
	/// `creations_get_the_mode_less_the_umask_or_exactly_less_the_mask`).
	#[test]
	fn open_at_opens_no_symlink_and_creates_once() {
		let tree = Tree::new("open-at");
		let rt = runtime();
		for (label, root) in tree.roots() {
			let mut read = OpenOptions::new();
			read.read(true);
			for flavor in ["sync", "async"] {
				let open = |name: &str, options: &OpenOptions| match flavor {
					"sync" => root.open_at(n(name), options),
					_ => rt.block_on(root.open_at_async(n(name), options)),
				};
				let file = open("f", &read).unwrap();
				let mut contents = Vec::new();
				(&file).read_to_end(&mut contents).unwrap();
				assert_eq!(contents, b"data", "{label} {flavor}");
				let err = open("l", &read).unwrap_err();
				assert!(refused(&err), "{label} {flavor}: opened through l: {err:?}");
				let created = format!("new-{flavor}");
				let mut create = OpenOptions::new();
				create.write(true).create_new(true);
				open(&created, &create).unwrap().write_all(b"made").unwrap();
				assert_eq!(std::fs::read(tree.at(&created)).unwrap(), b"made", "{label} {flavor}");
				let err = open(&created, &create).unwrap_err();
				assert_eq!(err.kind(), io::ErrorKind::AlreadyExists, "{label} {flavor}");
				std::fs::remove_file(tree.at(&created)).unwrap();
			}
			let err = root.open_at(n("f"), &OpenOptions::new()).unwrap_err();
			assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{label}: no access mode: {err:?}");
		}
		assert!(
			tree.provider.take().contains(&"open mem://t/f".to_owned()),
			"the provider opened the joined path"
		);
	}

	/// `create_dir_at` makes the directory named and refuses an existing
	/// entry (its modes: see
	/// `creations_get_the_mode_less_the_umask_or_exactly_less_the_mask`).
	#[test]
	fn create_dir_at_makes_the_directory_named() {
		let tree = Tree::new("create-dir-at");
		let rt = runtime();
		for (label, root) in tree.roots() {
			root.create_dir_at(n("made-sync"), Some(0o750)).unwrap();
			rt.block_on(root.create_dir_at_async(n("made-async"), Some(0o750)))
				.unwrap();
			for made in ["made-sync", "made-async"] {
				let meta = std::fs::symlink_metadata(tree.at(made)).unwrap();
				assert!(meta.is_dir(), "{label}: {made}");
				std::fs::remove_dir(tree.at(made)).unwrap();
			}
			let err = root.create_dir_at(n("f"), None).unwrap_err();
			assert_eq!(err.kind(), io::ErrorKind::AlreadyExists, "{label}");
		}
		assert!(
			tree
				.provider
				.take()
				.contains(&"create_dir mem://t/made-sync".to_owned())
		);
	}

	/// `remove_at` removes a file, a symlink itself and never its target, and
	/// an empty directory only as a directory.
	#[test]
	fn remove_at_removes_the_entry_named() {
		let tree = Tree::new("remove-at");
		let rt = runtime();
		for (label, root) in tree.roots() {
			root.remove_at(n("l"), false).unwrap();
			assert!(std::fs::symlink_metadata(tree.at("l")).is_err(), "{label}: l stays");
			assert_eq!(std::fs::read(tree.at("f")).unwrap(), b"data", "{label}: the target went");
			let err = root.remove_at(n("f"), true).unwrap_err();
			assert_eq!(err.raw_os_error(), Some(libc::ENOTDIR), "{label}: {err:?}");
			assert!(root.remove_at(n("d"), false).is_err(), "{label}: a directory as a file");
			let err = rt.block_on(root.remove_at_async(n("d"), true)).unwrap_err();
			assert_eq!(err.kind(), io::ErrorKind::DirectoryNotEmpty, "{label}: {err:?}");
			rt.block_on(root.remove_at_async(n("f"), false)).unwrap();
			assert!(!tree.at("f").exists(), "{label}");
			std::fs::remove_file(tree.at("d/inner")).unwrap();
			root.remove_at(n("d"), true).unwrap();
			assert!(!tree.at("d").exists(), "{label}");
			// The next route starts from the same tree.
			std::fs::create_dir(tree.at("d")).unwrap();
			std::fs::write(tree.at("d/inner"), "inner").unwrap();
			std::fs::write(tree.at("f"), "data").unwrap();
			std::os::unix::fs::symlink("f", tree.at("l")).unwrap();
		}
		assert!(
			tree
				.provider
				.take()
				.contains(&"remove_file mem://t/l".to_owned())
		);
	}

	/// `rename_at` moves an entry into another handle's directory; one host
	/// and one provider handle cross devices.
	#[test]
	fn rename_at_moves_the_entry_into_the_other_directory() {
		let tree = Tree::new("rename-at");
		let rt = runtime();
		let [(_, host), (_, provider)] = tree.roots();
		for (label, root) in [("host", &host), ("provider", &provider)] {
			let d = root.open_dir_at(n("d")).unwrap();
			root.rename_at(n("f"), &d, n("moved")).unwrap();
			assert!(!tree.at("f").exists(), "{label}");
			assert_eq!(std::fs::read(tree.at("d/moved")).unwrap(), b"data", "{label}");
			rt.block_on(d.rename_at_async(n("moved"), root, n("f")))
				.unwrap();
			assert_eq!(std::fs::read(tree.at("f")).unwrap(), b"data", "{label}");
		}
		let err = host.rename_at(n("f"), &provider, n("g")).unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::CrossesDevices, "{err:?}");
		assert!(tree.at("f").exists());
		assert!(
			tree
				.provider
				.take()
				.contains(&"rename mem://t/f".to_owned())
		);
	}

	/// `symlink_at` makes a symlink holding the target verbatim, and
	/// `read_link_at` reads it back; an entry that is no symlink has no
	/// target.
	#[test]
	fn symlink_at_and_read_link_at_keep_the_target_verbatim() {
		let tree = Tree::new("symlink-at");
		let rt = runtime();
		for (label, root) in tree.roots() {
			root
				.symlink_at(Path::new("nowhere/x"), n("s-sync"))
				.unwrap();
			rt.block_on(root.symlink_at_async(Path::new("../y"), n("s-async")))
				.unwrap();
			assert_eq!(std::fs::read_link(tree.at("s-sync")).unwrap(), Path::new("nowhere/x"));
			assert_eq!(std::fs::read_link(tree.at("s-async")).unwrap(), Path::new("../y"));
			assert_eq!(root.read_link_at(n("l")).unwrap(), Path::new("f"), "{label}");
			assert_eq!(rt.block_on(root.read_link_at_async(n("ld"))).unwrap(), Path::new("d"));
			let err = root.read_link_at(n("f")).unwrap_err();
			assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{label}: {err:?}");
			std::fs::remove_file(tree.at("s-sync")).unwrap();
			std::fs::remove_file(tree.at("s-async")).unwrap();
			// A target longer than the first read's room (256 bytes) is read
			// whole.
			let long = "x/".repeat(150);
			std::os::unix::fs::symlink(&long, tree.at("s-long")).unwrap();
			assert_eq!(root.read_link_at(n("s-long")).unwrap(), Path::new(&long), "{label}");
			std::fs::remove_file(tree.at("s-long")).unwrap();
		}
		let calls = tree.provider.take();
		assert!(calls.contains(&"symlink mem://t/s-sync".to_owned()), "{calls:?}");
		assert!(calls.contains(&"read_link mem://t/l".to_owned()), "{calls:?}");
	}

	/// `set_permissions_at` changes the mode of the entry, through a symlink
	/// only with `follow`; without, a regular file changes and a symlink's
	/// target keeps its mode: Linux and providers refuse the link, macOS
	/// changes the link itself.
	#[test]
	fn set_permissions_at_follows_a_symlink_only_when_asked() {
		let tree = Tree::new("chmod-at");
		let rt = runtime();
		let mode = || std::fs::metadata(tree.at("f")).unwrap().mode() & 0o777;
		for (label, root) in tree.roots() {
			root
				.set_permissions_at(n("f"), Permissions::from_mode(0o600), true)
				.unwrap();
			assert_eq!(mode(), 0o600, "{label}");
			rt.block_on(root.set_permissions_at_async(n("l"), Permissions::from_mode(0o640), true))
				.unwrap();
			assert_eq!(mode(), 0o640, "{label}: through l");
			root
				.set_permissions_at(n("f"), Permissions::from_mode(0o604), false)
				.unwrap();
			assert_eq!(mode(), 0o604, "{label}: a regular file without follow");
			rt.block_on(root.set_permissions_at_async(n("f"), Permissions::from_mode(0o640), false))
				.unwrap();
			assert_eq!(mode(), 0o640, "{label}: a regular file without follow");
			let changes_links = cfg!(target_os = "macos") && label == "host";
			let sync = root.set_permissions_at(n("l"), Permissions::from_mode(0o604), false);
			assert_eq!(mode(), 0o640, "{label}: l followed without follow ({sync:?})");
			let asynchronous = rt.block_on(root.set_permissions_at_async(
				n("l"),
				Permissions::from_mode(0o604),
				false,
			));
			assert_eq!(mode(), 0o640, "{label}: l followed without follow ({asynchronous:?})");
			for result in [sync, asynchronous] {
				assert_eq!(result.is_ok(), changes_links, "{label}: {result:?}");
			}
		}
		assert!(
			tree
				.provider
				.take()
				.contains(&"set_permissions mem://t/f".to_owned())
		);
	}

	/// `set_times_at` sets the times of the entry, of a symlink itself
	/// without `follow`; an omitted time stays.
	#[test]
	fn set_times_at_sets_the_link_itself_without_follow() {
		let tree = Tree::new("utimes-at");
		let rt = runtime();
		let at = |secs: u64| UNIX_EPOCH + Duration::from_secs(secs);
		let modified = |rel: &str| {
			std::fs::symlink_metadata(tree.at(rel))
				.unwrap()
				.modified()
				.unwrap()
		};
		for (label, root) in tree.roots() {
			let accessed = std::fs::metadata(tree.at("f")).unwrap().accessed().unwrap();
			root
				.set_times_at(n("f"), FileTime::Omit, FileTime::At(at(1_000_000)), true)
				.unwrap();
			assert_eq!(modified("f"), at(1_000_000), "{label}");
			assert_eq!(std::fs::metadata(tree.at("f")).unwrap().accessed().unwrap(), accessed);
			rt.block_on(root.set_times_at_async(
				n("l"),
				FileTime::Omit,
				FileTime::At(at(2_000_000)),
				false,
			))
			.unwrap();
			assert_eq!(modified("l"), at(2_000_000), "{label}: the link itself");
			assert_eq!(modified("f"), at(1_000_000), "{label}: the target moved");
			root
				.set_times_at(n("l"), FileTime::Omit, FileTime::At(at(3_000_000)), true)
				.unwrap();
			assert_eq!(modified("f"), at(3_000_000), "{label}: through l");
		}
		let calls = tree.provider.take();
		assert!(calls.contains(&"set_times_nofollow mem://t/l".to_owned()), "{calls:?}");
	}

	/// `chown_at` changes the owner of the entry: to the ids it has, for any
	/// user; as root to other ids, and of a symlink itself without `follow`.
	#[test]
	fn chown_at_changes_the_entry_named() {
		let tree = Tree::new("chown-at");
		let rt = runtime();
		let owner = |rel: &str| {
			let meta = std::fs::symlink_metadata(tree.at(rel)).unwrap();
			(meta.uid(), meta.gid())
		};
		let (uid, gid) = owner("f");
		// SAFETY: `geteuid` has no preconditions.
		let root_user = unsafe { libc::geteuid() } == 0;
		for (label, root) in tree.roots() {
			root.chown_at(n("f"), Some(uid), Some(gid), true).unwrap();
			rt.block_on(root.chown_at_async(n("l"), Some(uid), None, false))
				.unwrap();
			assert_eq!(
				root
					.chown_at(n("missing"), Some(uid), None, true)
					.unwrap_err()
					.kind(),
				io::ErrorKind::NotFound
			);
			if root_user {
				root
					.chown_at(n("l"), Some(4242), Some(4343), false)
					.unwrap();
				assert_eq!(owner("l"), (4242, 4343), "{label}: the link itself");
				assert_eq!(owner("f"), (uid, gid), "{label}: the target moved");
				rt.block_on(root.chown_at_async(n("l"), Some(4444), None, true))
					.unwrap();
				assert_eq!(owner("f"), (4444, gid), "{label}: through l");
				std::os::unix::fs::lchown(tree.at("l"), Some(uid), Some(gid)).unwrap();
				std::os::unix::fs::chown(tree.at("f"), Some(uid), Some(gid)).unwrap();
			}
		}
		if !root_user {
			eprintln!("UNKNOWN: not root, so chown_at to other ids and of a link was not checked");
		}
		assert!(
			tree
				.provider
				.take()
				.contains(&"chown_nofollow mem://t/l".to_owned())
		);
	}

	/// `identity` is the directory's device and inode, and `open_parent`
	/// climbs to the directory a child was opened from; a provider cannot
	/// climb.
	#[test]
	fn identity_and_open_parent_name_the_directories_reached() {
		let tree = Tree::new("identity");
		let rt = runtime();
		let root_meta = std::fs::metadata(tree.at("")).unwrap();
		let d_meta = std::fs::metadata(tree.at("d")).unwrap();
		for (label, root) in tree.roots() {
			let id = root.identity().unwrap();
			assert_eq!((id.dev(), id.ino()), (root_meta.dev(), root_meta.ino()), "{label}");
			let d = root.open_dir_at(n("d")).unwrap();
			let id = rt.block_on(d.identity_async()).unwrap();
			assert_eq!((id.dev(), id.ino()), (d_meta.dev(), d_meta.ino()), "{label}");
			match label {
				"host" => {
					let up = d.open_parent().unwrap();
					assert_eq!(up.identity().unwrap(), root.identity().unwrap(), "{label}");
				},
				_ => assert_eq!(d.open_parent().unwrap_err().kind(), io::ErrorKind::Unsupported),
			}
		}
	}

	/// `list_into` lists every entry with its type, symlinks unresolved, and
	/// with `Detail::Full` regular files' sizes.
	#[test]
	fn list_into_lists_every_entry() {
		let tree = Tree::new("list");
		let rt = runtime();
		for (label, root) in tree.roots() {
			let mut out = Listing::default();
			root.list_into(Detail::Full, 0, &mut out).unwrap();
			assert_eq!(
				names(&out),
				[
					("d".to_owned(), FileType::Dir),
					("f".to_owned(), FileType::File),
					("l".to_owned(), FileType::Symlink),
					("ld".to_owned(), FileType::Symlink),
				],
				"{label}"
			);
			let f = out.records().iter().find(|r| out.name(r) == b"f").unwrap();
			assert_eq!(f.size, Some(4), "{label}");
			let again = BlockingFs::native().open_dir(tree.at("d"), true).unwrap();
			again.list_into(Detail::Minimal, 0, &mut out).unwrap();
			assert_eq!(names(&out), [("inner".to_owned(), FileType::File)], "{label}: cleared first");
			root.list_into(Detail::Full, 0, &mut out).unwrap();
			let again = BlockingFs::native().open_dir(tree.at("d"), true).unwrap();
			rt.block_on(again.list_into_async(Detail::Minimal, 0, &mut out))
				.unwrap();
			assert_eq!(names(&out), [("inner".to_owned(), FileType::File)], "{label}: cleared first");
		}
	}

	/// The facades open a directory following a final symlink only with
	/// `follow`.
	#[test]
	fn open_dir_follows_a_final_symlink_only_when_asked() {
		let tree = Tree::new("open-dir");
		let rt = runtime();
		let host = BlockingFs::native();
		assert!(host.open_dir(tree.at("ld"), true).is_ok());
		assert!(refused(&host.open_dir(tree.at("ld"), false).unwrap_err()));
		assert!(
			rt.block_on(Fs::native().open_dir(tree.at("d"), false))
				.is_ok()
		);
		let provider = tree.provider_fs();
		assert!(provider.open_dir("mem://t/ld", true).is_ok());
		assert!(refused(&provider.open_dir("mem://t/ld", false).unwrap_err()));
		assert!(refused(&provider.open_dir("mem://t/f", true).unwrap_err()));
	}

	/// The portable component walk below a root, which kernels without
	/// `openat2` get, reaches regular files and directories two levels down,
	/// each opened relative to the one before it, but no symlink on the way,
	/// inside the root or out of it.
	#[test]
	fn the_component_walk_follows_no_symlink() {
		let tree = Tree::new("walk");
		std::fs::create_dir_all(tree.at("a/b")).unwrap();
		std::fs::write(tree.at("a/b/file.txt"), "deep").unwrap();
		std::os::unix::fs::symlink(tree.outside(), tree.at("esc")).unwrap();
		std::os::unix::fs::symlink(tree.outside(), tree.at("a/esc")).unwrap();
		std::fs::create_dir_all(tree.outside().join("b")).unwrap();
		std::fs::write(tree.outside().join("b/file.txt"), "outside").unwrap();
		let root = BlockingFs::native().open_dir(tree.at(""), true).unwrap();
		let super::super::DirRepr::Host { handle, .. } = &root.repr else {
			panic!("a host root");
		};
		let mut scratch = super::super::native::Scratch::default();
		let walk = super::super::native::open_beneath_walking;
		let file = walk(&mut scratch, handle, b"a/b/file.txt", false).unwrap();
		let mut contents = String::new();
		std::fs::File::from(file)
			.read_to_string(&mut contents)
			.unwrap();
		assert_eq!(contents, "deep");
		assert!(walk(&mut scratch, handle, b"a/b", true).is_ok());
		assert!(walk(&mut scratch, handle, b"d/inner", false).is_ok());
		for (rel, dir) in [
			("l", false),
			("ld/inner", false),
			("esc/secret", false),
			("a/esc/b/file.txt", false),
			("a/esc/b", true),
			("ld", true),
			("esc", true),
		] {
			let err = walk(&mut scratch, handle, rel.as_bytes(), dir).unwrap_err();
			assert!(matches!(err.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)), "{rel}: {err:?}");
		}
	}

	/// A thread's scratch goes back to its pool when the thread ends, and the
	/// next thread's first call takes it, warm: a walk on threads that did
	/// not exist before it does not pay for fresh listing buffers.
	#[test]
	fn a_new_thread_takes_the_scratch_an_ended_thread_gave_back() {
		use crate::dir_handle::{Pooled, ScratchPool};
		static KEPT: ScratchPool = ScratchPool::new();
		let on_a_new_thread = |words: Option<usize>| {
			std::thread::spawn(move || {
				let mut pooled = Pooled::from(&KEPT);
				let scratch = pooled.get();
				if let Some(words) = words {
					scratch.warm(words);
				}
				scratch.warmth()
			})
			.join()
			.unwrap()
		};
		assert!(on_a_new_thread(Some(4096)) >= 4096);
		assert!(
			on_a_new_thread(None) >= 4096,
			"the second thread got a fresh scratch, not the one the first gave back"
		);
		assert_eq!(KEPT.0.lock().len(), 1, "the second thread gave its scratch back too");
	}

	/// A pool keeps at most `MAX_POOLED` scratch, and an empty one gives a
	/// fresh scratch.
	#[test]
	fn a_scratch_pool_keeps_at_most_its_bound() {
		use crate::dir_handle::{MAX_POOLED, ScratchPool, native::Scratch};
		let pool = ScratchPool::new();
		assert_eq!(pool.take().warmth(), 0);
		for _ in 0..MAX_POOLED + 3 {
			let mut scratch = Scratch::default();
			scratch.warm(8);
			pool.give(scratch);
		}
		assert_eq!(pool.0.lock().len(), MAX_POOLED);
		assert!(pool.take().warmth() >= 8);
	}

	/// The calls' own scratch goes back to the pool when its thread ends, and
	/// the next thread's first call takes it: a walk on threads that did not
	/// exist before it pays for no fresh listing buffer. In a process of its
	/// own, so no other test's thread takes the scratch in between.
	#[test]
	fn with_scratch_gives_a_new_thread_the_scratch_an_ended_thread_left() {
		if crate::dir_handle::alone(
			"dir_handle::tests::unix::with_scratch_gives_a_new_thread_the_scratch_an_ended_thread_left",
		) {
			return;
		}
		const WORDS: usize = 1 << 15;
		std::thread::spawn(|| crate::dir_handle::with_scratch(|s| s.warm(WORDS)))
			.join()
			.unwrap();
		let warmth = std::thread::spawn(|| crate::dir_handle::with_scratch(|s| s.warmth()))
			.join()
			.unwrap();
		assert!(warmth >= WORDS, "the second thread's scratch is fresh: {warmth} words");
	}

	/// The process umask the creation test sets in its own process.
	const UMASK: libc::mode_t = 0o022;

	/// The ways a masked `create_dir_at` sets the mode again, each as `(id,
	/// label)`: on Linux through `/proc` and, by the test switch, as without
	/// it; elsewhere through a descriptor of the directory.
	fn mode_routes() -> &'static [(&'static str, &'static str)] {
		if cfg!(target_os = "linux") {
			&[("proc", "through /proc"), ("no-proc", "as without /proc")]
		} else {
			&[("fd", "through a descriptor")]
		}
	}

	/// Makes this process's masked `create_dir_at` calls take the way `id`
	/// of [`mode_routes`].
	fn use_mode_route(id: &str) {
		#[cfg(target_os = "linux")]
		super::super::native::set_mode_without_proc(id == "no-proc");
		#[cfg(not(target_os = "linux"))]
		let _ = id;
	}

	/// Whether `/proc/self/fd` is there, so that a masked mode can be set
	/// through it; in a run without `/proc` every way of [`mode_routes`] goes
	/// without it.
	fn proc_fd_is_there() -> bool {
		cfg!(target_os = "linux") && Path::new("/proc/self/fd").is_dir()
	}

	/// Creations get the mode asked less the process umask, and under a
	/// facade's creation mask exactly the mode less the mask: the kernel
	/// still applies the umask when it creates the entry, so the mode is set
	/// again after the create. In a process of its own, whose umask this test
	/// sets.
	#[test]
	fn creations_get_the_mode_less_the_umask_or_exactly_less_the_mask() {
		if crate::dir_handle::alone(
			"dir_handle::tests::unix::creations_get_the_mode_less_the_umask_or_exactly_less_the_mask",
		) {
			return;
		}
		// SAFETY: `umask` has no preconditions; nothing else runs in this
		// process.
		unsafe { libc::umask(UMASK) };
		let tree = Tree::new("modes");
		let rt = runtime();
		let mode = |rel: &str| std::fs::symlink_metadata(tree.at(rel)).unwrap().mode() & 0o777;
		let mut create = OpenOptions::new();
		create.write(true).create_new(true).mode(0o666);
		for (label, root) in tree.roots() {
			drop(root.open_at(n("file-sync"), &create).unwrap());
			drop(
				rt.block_on(root.open_at_async(n("file-async"), &create))
					.unwrap(),
			);
			root.create_dir_at(n("dir-sync"), Some(0o777)).unwrap();
			rt.block_on(root.create_dir_at_async(n("dir-async"), Some(0o777)))
				.unwrap();
			for (rel, want) in
				[("file-sync", 0o644), ("file-async", 0o644), ("dir-sync", 0o755), ("dir-async", 0o755)]
			{
				assert_eq!(mode(rel), want, "{label}: {rel}: {:o}", mode(rel));
			}
			for rel in ["file-sync", "file-async"] {
				std::fs::remove_file(tree.at(rel)).unwrap();
			}
			for rel in ["dir-sync", "dir-async"] {
				std::fs::remove_dir(tree.at(rel)).unwrap();
			}
		}
		// A mask of 0o007 keeps the group's write bit, which the umask
		// clears: only the mode set again after the create gives 0o660 and
		// 0o770.
		let masked = Fs::native().with_creation_mask(Some(0o007));
		let root = masked.blocking().open_dir(tree.at(""), true).unwrap();
		drop(root.open_at(n("file-sync"), &create).unwrap());
		drop(
			rt.block_on(root.open_at_async(n("file-async"), &create))
				.unwrap(),
		);
		root.create_dir_at(n("dir-sync"), Some(0o777)).unwrap();
		rt.block_on(root.create_dir_at_async(n("dir-async"), None))
			.unwrap();
		for (rel, want) in
			[("file-sync", 0o660), ("file-async", 0o660), ("dir-sync", 0o770), ("dir-async", 0o770)]
		{
			assert_eq!(mode(rel), want, "masked: {rel}: {:o}", mode(rel));
		}
		// A mode with no owner read: the directory cannot be opened to read
		// by a user other than root, so only a chmod that needs no open gives
		// 0o333 (the umask leaves 0o311).
		let unmasked = Fs::native().with_creation_mask(Some(0));
		let root = unmasked.blocking().open_dir(tree.at(""), true).unwrap();
		root.create_dir_at(n("dir-333"), Some(0o333)).unwrap();
		rt.block_on(root.create_dir_at_async(n("dir-333-async"), Some(0o333)))
			.unwrap();
		let modes: Vec<_> = ["dir-333", "dir-333-async"]
			.iter()
			.map(|rel| (*rel, mode(rel)))
			.collect();
		// The temporary tree's removal lists them, which needs owner read.
		for (rel, _) in &modes {
			std::fs::set_permissions(tree.at(rel), std::fs::Permissions::from_mode(0o755)).unwrap();
		}
		for (rel, got) in modes {
			assert_eq!(got, 0o333, "no owner read: {rel}: {got:o}");
		}
		// SAFETY: `geteuid` has no preconditions.
		if unsafe { libc::geteuid() } == 0 {
			eprintln!(
				"note: as root the open the old code needed succeeds, so the 0o333 case cannot fail \
				 here"
			);
		}
	}

	/// A masked `create_dir_at` whose mode has no owner read (0o333 under a
	/// mask of 0, which the umask makes 0o311 at the create) gives that mode
	/// by every way it sets it again ([`mode_routes`]). Without `/proc` the
	/// mode is set through a descriptor opened to read the directory, so the
	/// directory must be made with the owner's bits for that open. In a run
	/// without `/proc` mounted every way is that one. As root that open needs
	/// no owner bits, so this cannot fail there. In a process of its own,
	/// whose umask and way of setting the mode this test sets.
	#[test]
	fn a_masked_create_dir_at_gives_a_mode_without_owner_read_with_or_without_proc() {
		if crate::dir_handle::alone(
			"dir_handle::tests::unix::a_masked_create_dir_at_gives_a_mode_without_owner_read_with_or_without_proc",
		) {
			return;
		}
		// SAFETY: `umask` has no preconditions; nothing else runs in this
		// process.
		unsafe { libc::umask(UMASK) };
		let tree = Tree::new("mode-333");
		let rt = runtime();
		let unmasked = Fs::native().with_creation_mask(Some(0));
		let root = unmasked.blocking().open_dir(tree.at(""), true).unwrap();
		let mut made = Vec::new();
		for &(id, label) in mode_routes() {
			use_mode_route(id);
			let (sync, in_async) = (format!("made-{id}"), format!("made-{id}-async"));
			made.push((format!("{label}, sync"), root.create_dir_at(n(&sync), Some(0o333)), sync));
			let result = rt.block_on(root.create_dir_at_async(n(&in_async), Some(0o333)));
			made.push((format!("{label}, async"), result, in_async));
		}
		let mut wrong = Vec::new();
		for (case, result, rel) in &made {
			let got = std::fs::symlink_metadata(tree.at(rel)).map(|meta| meta.mode() & 0o777);
			if !matches!((result, &got), (Ok(()), Ok(0o333))) {
				let shown = got
					.as_ref()
					.map_or_else(|err| format!("unknown ({err})"), |mode| format!("{mode:o}"));
				wrong.push(format!("{case}: {result:?}, mode {shown}"));
			}
			// The tree's removal lists it, which needs the owner's read bit.
			if got.is_ok() {
				std::fs::set_permissions(tree.at(rel), std::fs::Permissions::from_mode(0o755)).unwrap();
			}
		}
		if !proc_fd_is_there() {
			eprintln!("note: /proc/self/fd is not there, so every way went without /proc");
		}
		// SAFETY: `geteuid` has no preconditions.
		if unsafe { libc::geteuid() } == 0 {
			eprintln!(
				"note: as root the read-only open needs no owner bits, so this cannot fail here"
			);
		}
		assert!(wrong.is_empty(), "a masked create_dir_at of 0o333 under a mask of 0: {wrong:?}");
	}

	/// Under a process umask that clears the owner's read bit (0400), a
	/// masked `create_dir_at` never reports success with a mode other than
	/// the one asked less the mask. On Linux with `/proc` it gives that mode:
	/// it is set again on the directory made without opening it to read.
	/// Elsewhere, and without `/proc`, it may fail instead. Root can open any
	/// directory, so as root the old way passes too. In a process of its own,
	/// whose umask this test sets.
	#[test]
	fn a_masked_create_dir_at_gives_the_mode_under_a_umask_without_owner_read() {
		if crate::dir_handle::alone(
			"dir_handle::tests::unix::a_masked_create_dir_at_gives_the_mode_under_a_umask_without_owner_read",
		) {
			return;
		}
		let tree = Tree::new("umask-0400");
		// After the tree is made, so its own directories keep the owner's
		// read bit. SAFETY: `umask` has no preconditions; nothing else runs
		// in this process.
		unsafe { libc::umask(0o400) };
		let rt = runtime();
		let mode = |rel: &str| std::fs::symlink_metadata(tree.at(rel)).unwrap().mode() & 0o777;
		let masked = Fs::native().with_creation_mask(Some(0o022));
		let root = masked.blocking().open_dir(tree.at(""), true).unwrap();
		let results = [
			("made", root.create_dir_at(n("made"), Some(0o755))),
			("made-async", rt.block_on(root.create_dir_at_async(n("made-async"), Some(0o755)))),
		];
		let modes: Vec<_> = results.iter().map(|(rel, _)| (*rel, mode(rel))).collect();
		// The tree's removal lists them, which needs the owner's read bit.
		for (rel, _) in &modes {
			std::fs::set_permissions(tree.at(rel), std::fs::Permissions::from_mode(0o755)).unwrap();
		}
		let through_proc = proc_fd_is_there();
		for ((rel, result), (_, got)) in results.iter().zip(modes) {
			match result {
				Ok(()) => assert_eq!(got, 0o755, "{rel}: reported made, with mode {got:o}"),
				Err(err) if through_proc => panic!("{rel}: {err:?} (mode {got:o})"),
				Err(_) => {},
			}
		}
		// SAFETY: `geteuid` has no preconditions.
		if unsafe { libc::geteuid() } == 0 {
			eprintln!(
				"note: as root a read-only open of the directory succeeds, so this cannot fail here"
			);
		}
	}

	/// A masked `create_dir_at` sets the mode on the directory it made, never
	/// on what was swapped in for it between `mkdirat` and the mode: a
	/// symlink to a file, a regular file renamed there, a hard link to a
	/// file, or a symlink to a directory (which gVisor's plain `O_RDONLY |
	/// O_DIRECTORY | O_NOFOLLOW` open follows). Each keeps its mode (a file
	/// 0600, the directory 0700), and the call returns the error of the open
	/// that found something else at the name. By every way the mode is set
	/// again ([`mode_routes`]). In a process of its own, whose way of setting
	/// the mode this test sets.
	#[test]
	fn a_masked_create_dir_at_sets_no_mode_on_what_was_swapped_in() {
		if crate::dir_handle::alone(
			"dir_handle::tests::unix::a_masked_create_dir_at_sets_no_mode_on_what_was_swapped_in",
		) {
			return;
		}
		let tree = Tree::new("mkdir-swap");
		let masked = Fs::native().with_creation_mask(Some(0o022)).blocking();
		let root = masked.open_dir(tree.at(""), true).unwrap();
		let mode = |rel: &str| std::fs::metadata(tree.at(rel)).unwrap().mode() & 0o777;
		let (mut changed, mut reported) = (Vec::new(), Vec::new());
		for &(id, label) in mode_routes() {
			use_mode_route(id);
			for swap in ["symlink", "file", "hardlink", "dirlink"] {
				let (name, victim) = (format!("raced-{swap}-{id}"), format!("victim-{swap}-{id}"));
				let kept = if swap == "dirlink" {
					std::fs::create_dir(tree.at(&victim)).unwrap();
					0o700
				} else {
					std::fs::write(tree.at(&victim), "key").unwrap();
					0o600
				};
				std::fs::set_permissions(tree.at(&victim), std::fs::Permissions::from_mode(kept))
					.unwrap();
				let (made, target) = (tree.at(&name), tree.at(&victim));
				super::super::native::after_create_dir(name.as_bytes(), move || {
					std::fs::remove_dir(&made).unwrap();
					match swap {
						"symlink" | "dirlink" => std::os::unix::fs::symlink(&target, &made),
						"file" => std::fs::rename(&target, &made),
						_ => std::fs::hard_link(&target, &made),
					}
					.unwrap();
				});
				let created = root.create_dir_at(n(&name), Some(0o777));
				let swapped = std::fs::symlink_metadata(tree.at(&name)).unwrap();
				assert!(!swapped.is_dir(), "{label}, {swap}: the swap did not run ({created:?})");
				// What the swap put there, or what the link names.
				let rel = if swap == "file" {
					name.as_str()
				} else {
					victim.as_str()
				};
				if mode(rel) != kept {
					changed.push(format!("{label}, {swap}: {rel} {:o} ({created:?})", mode(rel)));
				}
				if created.is_ok() {
					reported.push(format!("{label}, {swap}"));
				}
			}
		}
		assert!(changed.is_empty(), "the directory's mode went to what was swapped in: {changed:?}");
		assert!(reported.is_empty(), "create_dir_at reported made after these swaps: {reported:?}");
	}

	/// The user a test acts as where it needs one that is not root.
	const OTHER: libc::uid_t = 65534;

	/// While it lives, this process's effective user is `uid`; root again
	/// after. For a test in a process of its own that runs as root.
	struct ActAs;

	impl ActAs {
		fn user(uid: libc::uid_t) -> Self {
			// SAFETY: `seteuid` has no preconditions; the test runs alone.
			let set = unsafe { libc::seteuid(uid) };
			assert_eq!(set, 0, "seteuid({uid}): {}", io::Error::last_os_error());
			Self
		}
	}

	impl Drop for ActAs {
		fn drop(&mut self) {
			// SAFETY: as above; the saved user is root.
			unsafe { libc::seteuid(0) };
		}
	}

	/// A masked `create_dir_at` returns the error of the call that sets the
	/// mode again, by every way the mode is set ([`mode_routes`]), sync and
	/// async. First as any user: a test seam makes each mode change fail with
	/// `EPERM` after it ran, and the call must return that error. Then as
	/// root only: a directory root owns is renamed in at the name between
	/// `mkdirat` and the mode change while the process acts as another user,
	/// who may not set its mode (`EPERM`, or `EACCES` where `/proc/self/fd`
	/// is closed to a process whose effective user changed); the call must
	/// fail and the directory keep its mode. As another user that second half
	/// checks nothing and says so. In a process of its own, whose effective
	/// user, seam and way of setting the mode this test sets.
	#[test]
	fn a_masked_create_dir_at_returns_the_error_of_setting_the_mode() {
		if crate::dir_handle::alone(
			"dir_handle::tests::unix::a_masked_create_dir_at_returns_the_error_of_setting_the_mode",
		) {
			return;
		}
		let failing = Tree::new("mkdir-fail");
		let masked = Fs::native().with_creation_mask(Some(0o022));
		let root = masked.blocking().open_dir(failing.at(""), true).unwrap();
		let rt = runtime();
		let mut wrong = Vec::new();
		for &(id, label) in mode_routes() {
			use_mode_route(id);
			for call in ["sync", "async"] {
				let name = format!("failed-{id}-{call}");
				super::super::native::fail_mode_changes(Some(libc::EPERM));
				let created = if call == "sync" {
					root.create_dir_at(n(&name), Some(0o700))
				} else {
					rt.block_on(root.create_dir_at_async(n(&name), Some(0o700)))
				};
				super::super::native::fail_mode_changes(None);
				let made = std::fs::symlink_metadata(failing.at(&name)).is_ok_and(|meta| meta.is_dir());
				let returned = created
					.as_ref()
					.is_err_and(|err| err.raw_os_error() == Some(libc::EPERM));
				if !(made && returned) {
					wrong.push(format!("{label}, {call}: {created:?}, made {made}"));
				}
			}
		}
		assert!(
			wrong.is_empty(),
			"a masked create_dir_at whose mode change failed with EPERM (that error expected): \
			 {wrong:?}"
		);
		// SAFETY: `geteuid` has no preconditions.
		if unsafe { libc::geteuid() } != 0 {
			eprintln!(
				"UNKNOWN: not root, so no directory of another user can be put at the name; the \
				 second half checked nothing"
			);
			return;
		}
		let tree = Tree::new("mkdir-eperm");
		let top = tree.at("");
		let closed = top
			.ancestors()
			.skip(1)
			.find(|dir| std::fs::metadata(dir).is_ok_and(|meta| meta.mode() & 0o001 == 0));
		if let Some(closed) = closed {
			eprintln!(
				"UNKNOWN: {} is closed to other users, so they cannot reach the tree; nothing was \
				 checked",
				closed.display()
			);
			return;
		}
		std::os::unix::fs::chown(tree.at(""), Some(OTHER), Some(OTHER)).unwrap();
		let root = masked.blocking().open_dir(tree.at(""), true).unwrap();
		for &(id, label) in mode_routes() {
			use_mode_route(id);
			for call in ["sync", "async"] {
				let (name, victim) = (format!("raced-{id}-{call}"), format!("victim-{id}-{call}"));
				// Root's, and open to all, so that only setting its mode fails.
				std::fs::create_dir(tree.at(&victim)).unwrap();
				std::fs::set_permissions(tree.at(&victim), std::fs::Permissions::from_mode(0o755))
					.unwrap();
				let (made, target) = (tree.at(&name), tree.at(&victim));
				super::super::native::after_create_dir(name.as_bytes(), move || {
					std::fs::remove_dir(&made).unwrap();
					std::fs::rename(&target, &made).unwrap();
				});
				let created = {
					let _other = ActAs::user(OTHER);
					if call == "sync" {
						root.create_dir_at(n(&name), Some(0o700))
					} else {
						rt.block_on(root.create_dir_at_async(n(&name), Some(0o700)))
					}
				};
				let at_name = std::fs::symlink_metadata(tree.at(&name))
					.map(|meta| (meta.uid(), meta.mode() & 0o777));
				let refused = created
					.as_ref()
					.is_err_and(|err| err.kind() == io::ErrorKind::PermissionDenied);
				if !(refused && matches!(at_name, Ok((0, 0o755)))) {
					let shown = at_name.map(|(uid, mode)| format!("owner {uid}, mode {mode:o}"));
					wrong.push(format!("{label}, {call}: {created:?}; at the name: {shown:?}"));
				}
			}
		}
		assert!(
			wrong.is_empty(),
			"a masked create_dir_at over a directory another user owns (a permission error and \
			 root's 755 expected): {wrong:?}"
		);
	}

	/// A provider rename names its destination through the destination
	/// handle's facade: two handles from two facades cross devices, and
	/// neither tree changes, though both facades serve the same paths.
	#[test]
	fn a_rename_between_two_provider_facades_crosses_devices() {
		let (a, b) = (Tree::new("rename-a"), Tree::new("rename-b"));
		let rt = runtime();
		let a_root = a.provider_fs().open_dir("mem://t", true).unwrap();
		let b_d = b.provider_fs().open_dir("mem://t/d", true).unwrap();
		for flavor in ["sync", "async"] {
			let result = match flavor {
				"sync" => a_root.rename_at(n("f"), &b_d, n("moved")),
				_ => rt.block_on(a_root.rename_at_async(n("f"), &b_d, n("moved"))),
			};
			let err = result.unwrap_err();
			assert_eq!(err.kind(), io::ErrorKind::CrossesDevices, "{flavor}: {err:?}");
			assert!(a.at("f").exists() && b.at("f").exists(), "{flavor}: a source moved");
			assert!(!a.at("d/moved").exists() && !b.at("d/moved").exists(), "{flavor}: moved");
		}
	}

	/// `open_at` opens no directory: `O_DIRECTORY` in its custom flags is
	/// refused on every handle, for a directory and for a symlink to one, so
	/// a directory is opened only by `open_dir_at`, with its care for kernels
	/// that follow a symlink despite `O_NOFOLLOW`, and a path handle's facade
	/// opens no directory either.
	#[test]
	fn open_at_refuses_o_directory() {
		let tree = Tree::new("open-at-dir");
		let rt = runtime();
		let mut options = OpenOptions::new();
		options.read(true).custom_flags(libc::O_DIRECTORY);
		for (label, root) in tree.roots() {
			for name in ["d", "ld"] {
				let sync = root.open_at(n(name), &options).map(drop);
				let asynchronous = rt.block_on(root.open_at_async(n(name), &options)).map(drop);
				for result in [sync, asynchronous] {
					let err = result.unwrap_err();
					assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{label}: {name}: {err:?}");
				}
			}
		}
	}

	/// Without `follow`, `set_permissions_at` changes a regular file also on a
	/// glibc before 2.32, whose `fchmodat` refuses `AT_SYMLINK_NOFOLLOW` for
	/// every file with `EOPNOTSUPP` (emulated here for this thread); a
	/// symlink is still refused, and its target keeps its mode.
	#[cfg(target_os = "linux")]
	#[test]
	fn set_permissions_at_without_follow_changes_a_regular_file_on_an_old_glibc() {
		let tree = Tree::new("chmod-old-glibc");
		let mode = || std::fs::metadata(tree.at("f")).unwrap().mode() & 0o777;
		let root = BlockingFs::native().open_dir(tree.at(""), true).unwrap();
		let _old = super::super::native::emulate_old_glibc();
		root
			.set_permissions_at(n("f"), Permissions::from_mode(0o604), false)
			.unwrap();
		assert_eq!(mode(), 0o604);
		let err = root
			.set_permissions_at(n("l"), Permissions::from_mode(0o600), false)
			.unwrap_err();
		assert_eq!(err.raw_os_error(), Some(libc::EOPNOTSUPP), "{err:?}");
		assert_eq!(mode(), 0o604, "the link's target changed");
	}

	/// A facade's descriptor overlays apply below its directory handles: with
	/// an overlay at `root/m`, a handle on `root` names `m` through the
	/// facade, so `open_at` reads the overlay's file, not the host entry at
	/// that path.
	#[test]
	fn a_handle_above_a_descriptor_overlay_opens_the_overlay() {
		let tree = Tree::new("overlay");
		std::fs::write(tree.at("m"), "host").unwrap();
		std::fs::write(tree.outside().join("pinned"), "overlay").unwrap();
		let rt = runtime();
		let mut read = OpenOptions::new();
		read.read(true);
		for flavor in ["sync", "async"] {
			// A mounted file keeps one offset for every open of it, so each
			// flavor mounts its own.
			let pinned = File::from(std::fs::File::open(tree.outside().join("pinned")).unwrap());
			let fs = Fs::native().mount_file(tree.at("m"), pinned);
			let root = match flavor {
				"sync" => fs.blocking().open_dir(tree.at(""), true),
				_ => rt.block_on(fs.open_dir(tree.at(""), true)),
			}
			.unwrap();
			let file = root.open_at(n("m"), &read).unwrap();
			let mut contents = String::new();
			(&file).read_to_string(&mut contents).unwrap();
			assert_eq!(contents, "overlay", "{flavor}: the host entry was opened");
		}
	}

	/// Makes a FIFO at `path`.
	fn mkfifo(path: &Path) {
		use std::os::unix::ffi::OsStrExt;
		let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
		// SAFETY: `path` is NUL-terminated.
		assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0, "mkfifo");
	}

	/// Runs `body` on a thread of its own and fails when it has not ended
	/// within [`HANG`]. A correct run ends in milliseconds: the bound only
	/// turns a hang into a failure, after `release` frees the thread.
	fn ends(what: &str, body: impl FnOnce() + Send + 'static, release: impl FnOnce()) {
		const HANG: Duration = Duration::from_secs(60);
		let (done, ended) = std::sync::mpsc::channel();
		let thread = std::thread::spawn(move || {
			body();
			let _ = done.send(());
		});
		match ended.recv_timeout(HANG) {
			Ok(()) => thread.join().unwrap(),
			Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
				std::panic::resume_unwind(thread.join().unwrap_err());
			},
			Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
				release();
				panic!("{what}: still waiting after {HANG:?}");
			},
		}
	}

	/// Releases an open of `fifo`'s read end waiting for a writer.
	fn release_reader(fifo: &Path) {
		use std::os::unix::fs::OpenOptionsExt;
		let _ = std::fs::OpenOptions::new()
			.write(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(fifo);
	}

	/// `open_at_async` of a FIFO waits for its other end off the runtime's
	/// worker: on a current-thread runtime, the other end, opened by a task
	/// of the same runtime, connects.
	#[test]
	fn open_at_async_of_a_fifo_leaves_the_runtime_free_for_its_other_end() {
		let tree = Tree::new("fifo-open");
		mkfifo(&tree.at("p"));
		let reader = BlockingFs::native().open_dir(tree.at(""), true).unwrap();
		let writer = BlockingFs::native().open_dir(tree.at(""), true).unwrap();
		let fifo = tree.at("p");
		ends(
			"the FIFO's read end",
			move || {
				runtime().block_on(async move {
					let other = tokio::spawn(async move {
						let mut write = OpenOptions::new();
						write.write(true);
						writer.open_at_async(n("p"), &write).await.map(drop)
					});
					let mut read = OpenOptions::new();
					read.read(true);
					let file = reader.open_at_async(n("p"), &read).await.unwrap();
					other.await.unwrap().unwrap();
					drop(file);
				});
			},
			|| release_reader(&fifo),
		);
	}

	/// Under a cancellable facade, `open_at_async` of a FIFO with no other end
	/// ends at the token with the facade's cancellation error.
	#[test]
	fn open_at_async_of_a_fifo_ends_at_the_token() {
		let tree = Tree::new("fifo-token");
		mkfifo(&tree.at("p"));
		let token = tokio_util::sync::CancellationToken::new();
		let fs = Fs::native().with_cancellation(token.clone());
		let root = fs.blocking().open_dir(tree.at(""), true).unwrap();
		let fifo = tree.at("p");
		ends(
			"the FIFO's read end under a token",
			move || {
				runtime().block_on(async move {
					let mut read = OpenOptions::new();
					read.read(true);
					let cancel = async {
						tokio::task::yield_now().await;
						token.cancel();
					};
					let (opened, ()) = tokio::join!(root.open_at_async(n("p"), &read), cancel);
					let err = opened.map(drop).unwrap_err();
					assert!(crate::error::is_cancelled(&err), "{err:?}");
				});
			},
			|| release_reader(&fifo),
		);
	}

	/// A FIFO helper's hook (see `fifo_seam`): `started` is told when the
	/// helper reaches the hook; with `hold`, the helper then waits until
	/// `hold` is released before its `open`. Returns the channel the helper
	/// tells whether its open succeeded.
	fn hook_next_fifo_helper(
		started: std::sync::mpsc::Sender<()>,
		hold: Option<std::sync::mpsc::Receiver<()>>,
	) -> std::sync::mpsc::Receiver<bool> {
		let (opened, ended) = std::sync::mpsc::channel();
		crate::fs::fifo_seam::set(
			move || {
				let _ = started.send(());
				if let Some(hold) = hold {
					let _ = hold.recv();
				}
			},
			move |ok| {
				let _ = opened.send(ok);
			},
		);
		ended
	}

	/// Bound on a helper's open after its release, a hang guard only: a
	/// correct release connects it in milliseconds.
	const HELPER_BOUND: Duration = Duration::from_secs(30);

	/// A write-only open of a FIFO under a cancellable facade, dropped before
	/// its helper passes its check of the cancel, leaves no helper behind:
	/// the helper, let go right after the drop, finds the open cancelled and
	/// opens nothing, so a later reader and writer of the FIFO meet each
	/// other, the reader reading what the writer wrote. A helper that opened
	/// the FIFO after the drop would wait there as a writer and take the
	/// later reader's connection; this test then fails after
	/// [`HELPER_BOUND`]. In a process of its own, so the hook takes this
	/// test's helper.
	#[test]
	fn a_fifo_open_dropped_before_its_helper_opens_takes_no_later_connection() {
		if crate::dir_handle::alone(
			"dir_handle::tests::unix::a_fifo_open_dropped_before_its_helper_opens_takes_no_later_connection",
		) {
			return;
		}
		let tree = Tree::new("fifo-dropped");
		let fifo = tree.at("p");
		mkfifo(&fifo);
		let (started_tx, started) = std::sync::mpsc::channel();
		let (go, hold) = std::sync::mpsc::channel();
		let helper_opened = hook_next_fifo_helper(started_tx, Some(hold));
		let fs = Fs::native().with_cancellation(tokio_util::sync::CancellationToken::new());
		// A handle's `open_at_async` starts the helper in its first poll.
		let root = fs.blocking().open_dir(tree.at(""), true).unwrap();
		let mut write = OpenOptions::new();
		write.write(true);
		runtime().block_on(async {
			let open = root.open_at_async(n("p"), &write);
			tokio::pin!(open);
			// Polled once: the helper starts and waits at the hook; then the
			// open is dropped.
			tokio::select! {
				biased;
				_ = &mut open => panic!("a write-only FIFO open with no reader finished"),
				() = std::future::ready(()) => {},
			}
		});
		started
			.recv_timeout(HELPER_BOUND)
			.expect("the helper never started");
		go.send(()).unwrap();
		let opened = helper_opened.recv_timeout(HELPER_BOUND);
		if let Ok(opened) = opened {
			assert!(!opened, "the helper let go after the drop opened the FIFO");
		} else {
			// Free the helper, so this process can end, then fail.
			release_reader_end(&fifo);
			panic!("the helper's open was still waiting {HELPER_BOUND:?} after the drop");
		}
		// No writer is left that a later reader could meet and read EOF from.
		wait_until_no_writer(&fifo);
		let exchange_fifo = fifo.clone();
		ends(
			"a later reader and writer of the FIFO",
			move || {
				let reader_fifo = exchange_fifo.clone();
				let reader = std::thread::spawn(move || std::fs::read(reader_fifo).unwrap());
				std::fs::write(&exchange_fifo, b"data").unwrap();
				assert_eq!(reader.join().unwrap(), b"data", "the reader's connection was taken");
			},
			|| {
				release_reader(&fifo);
				release_reader_end(&fifo);
			},
		);
	}

	/// Returns once `fifo` has no writer: a non-blocking reader reads end of
	/// file (0), where a writer that is still open makes it `EAGAIN`. The
	/// verdict is the read's; [`HELPER_BOUND`] only turns a writer that never
	/// closes into a failure.
	fn wait_until_no_writer(fifo: &Path) {
		use std::os::unix::fs::OpenOptionsExt;
		let start = std::time::Instant::now();
		loop {
			let mut probe = std::fs::OpenOptions::new()
				.read(true)
				.custom_flags(libc::O_NONBLOCK)
				.open(fifo)
				.unwrap();
			match probe.read(&mut [0u8; 1]) {
				Ok(0) => return,
				Ok(_) => panic!("{} holds data no test wrote", fifo.display()),
				Err(err) if err.kind() == io::ErrorKind::WouldBlock => {},
				Err(err) => panic!("{}: {err:?}", fifo.display()),
			}
			drop(probe);
			assert!(start.elapsed() < HELPER_BOUND, "a writer of {} stayed open", fifo.display());
			std::thread::sleep(Duration::from_millis(10));
		}
	}

	/// Tries of each replaced-FIFO case: ext4 and overlayfs on it give a
	/// freed inode number to the next file made often but not always, so one
	/// try can miss the reuse a case is about.
	const REPLACE_TRIES: usize = 25;

	/// The inode number of the entry at `path`.
	fn ino(path: &Path) -> u64 {
		std::fs::symlink_metadata(path).unwrap().ino()
	}

	/// One drop's release, as [`record_releases`] saw it.
	#[derive(Clone, Debug)]
	#[allow(
		dead_code,
		reason = "`held` and `thread` are read through `Debug` in a failure's message"
	)]
	struct Release {
		/// Whether the release held an end of a FIFO.
		held:   bool,
		/// Whether a writer to the FIFO then at the recorded path met a
		/// reader.
		met:    bool,
		/// The thread the release ran on: the thread that dropped the open.
		thread: String,
	}

	/// Records each drop's release in this process from now on: whether it
	/// held an end, whether a writer to the FIFO now at the path in `fifo`
	/// then met a reader, and the thread it ran on.
	fn record_releases(fifo: Arc<Mutex<PathBuf>>) -> Arc<Mutex<Vec<Release>>> {
		let attempts: Arc<Mutex<Vec<Release>>> = Arc::default();
		let recorded = Arc::clone(&attempts);
		crate::fs::fifo_seam::on_release(move |held| {
			use std::os::unix::fs::OpenOptionsExt;
			let writer = std::fs::OpenOptions::new()
				.write(true)
				.custom_flags(libc::O_NONBLOCK)
				.open(&*fifo.lock());
			let thread = std::thread::current()
				.name()
				.unwrap_or("unnamed")
				.to_owned();
			recorded
				.lock()
				.push(Release { held, met: writer.is_ok(), thread });
		});
		attempts
	}

	/// The FIFO open of `fifo` (`name` in `root`) through a handle's
	/// `open_at_async` or the facade's own open, by `route`.
	fn fifo_open<'a>(
		route: &str,
		root: &'a DirHandle,
		fs: &'a Fs,
		name: &'a str,
		fifo: &'a Path,
		options: &'a OpenOptions,
	) -> std::pin::Pin<Box<dyn Future<Output = io::Result<File>> + 'a>> {
		match route {
			"handle" => Box::pin(root.open_at_async(n(name), options)),
			_ => Box::pin(fs.open_with(fifo, options)),
		}
	}

	/// A release never holds an end of a FIFO that replaced the one its open
	/// started on (`rm p; mkfifo p`), so a writer to the new FIFO meets no
	/// reader that is about to go away (and would lose what it wrote). With
	/// the helper and releases reaching the FIFO through `/proc`; by name in
	/// [`a_release_holds_no_end_of_a_fifo_that_replaced_the_one_its_open_started_on_by_name`].
	/// In a process of its own, so the hooks take this test's helpers and
	/// releases.
	#[test]
	fn a_release_holds_no_end_of_a_fifo_that_replaced_the_one_its_open_started_on() {
		if crate::dir_handle::alone(
			"dir_handle::tests::unix::a_release_holds_no_end_of_a_fifo_that_replaced_the_one_its_open_started_on",
		) {
			return;
		}
		release_holds_no_end_of_a_replacing_fifo(false);
	}

	/// As [`a_release_holds_no_end_of_a_fifo_that_replaced_the_one_its_open_started_on`],
	/// with the helper and releases reaching the FIFO by name, as without
	/// `/proc`. In a process of its own, apart from the `/proc` half, as the
	/// by-name switch is the process's.
	#[test]
	fn a_release_holds_no_end_of_a_fifo_that_replaced_the_one_its_open_started_on_by_name() {
		if crate::dir_handle::alone(
			"dir_handle::tests::unix::a_release_holds_no_end_of_a_fifo_that_replaced_the_one_its_open_started_on_by_name",
		) {
			return;
		}
		release_holds_no_end_of_a_replacing_fifo(true);
	}

	/// The body of the two tests above: the helper is held after its check of
	/// the cancel, before its `open`, until the drop joins it or leaves it,
	/// so only the open itself holds the old FIFO: on Linux its number then
	/// goes to no other file. The name is given to another FIFO and the open
	/// is dropped. Through a handle's `open_at_async` and the facade's own
	/// open, [`REPLACE_TRIES`] tries each; the release reaches the FIFO by
	/// name when `by_name`.
	fn release_holds_no_end_of_a_replacing_fifo(by_name: bool) {
		crate::fs::fifo_seam::open_by_name(by_name);
		let tree = Tree::new("fifo-replaced");
		let fs = Fs::native().with_cancellation(tokio_util::sync::CancellationToken::new());
		let root = fs.blocking().open_dir(tree.at(""), true).unwrap();
		let mut write = OpenOptions::new();
		write.write(true);
		let current: Arc<Mutex<PathBuf>> = Arc::default();
		let attempts = record_releases(Arc::clone(&current));
		let mut reused = Vec::new();
		for route in ["handle", "facade"] {
			for i in 0..REPLACE_TRIES {
				let case = format!("{route}, by name {by_name}, try {i}");
				let name = format!("p-{route}-{i}");
				let fifo = tree.at(&name);
				mkfifo(&fifo);
				current.lock().clone_from(&fifo);
				let first = attempts.lock().len();
				let (reached_tx, reached) = std::sync::mpsc::channel();
				crate::fs::fifo_seam::after_check(reached_tx, true);
				runtime().block_on(async {
					let mut open = fifo_open(route, &root, &fs, &name, &fifo, &write);
					tokio::select! {
						biased;
						_ = &mut open => panic!("{case}: a write-only FIFO open with no reader finished"),
						() = std::future::ready(()) => {},
					}
					reached
						.recv_timeout(HELPER_BOUND)
						.unwrap_or_else(|_| panic!("{case}: the helper never passed its check"));
					// The name now names another FIFO; then the open is
					// dropped.
					let old = ino(&fifo);
					std::fs::remove_file(&fifo).unwrap();
					mkfifo(&fifo);
					if ino(&fifo) == old {
						reused.push(case.clone());
					}
				});
				let these = attempts.lock()[first..].to_vec();
				assert!(!these.is_empty(), "{case}: no release ran");
				assert!(
					these.iter().all(|release| !release.met),
					"{case}: a writer to the new FIFO met a release's end; the releases since this \
					 open, each with the thread it ran on: {these:#?}"
				);
			}
		}
		eprintln!(
			"the new FIFO got the old one's number in {} of {} tries",
			reused.len(),
			2 * REPLACE_TRIES
		);
		if cfg!(target_os = "linux") {
			assert!(reused.is_empty(), "a pinned FIFO's number went to the new FIFO: {reused:?}");
		}
	}

	/// A release reaches the FIFO its open waits on after the FIFO's name was
	/// given to another FIFO: the helper's open ends, and a writer to the new
	/// FIFO meets no release's end. The helper runs into its `open` and is
	/// seen waiting there before the name is replaced and the open dropped.
	/// With a write-only open, whose helper reopens the pin, and with the
	/// shell's `>` options (write, create, truncate), whose helper opens the
	/// name before the name is replaced; through a handle and the facade,
	/// [`REPLACE_TRIES`] tries each. Linux only: elsewhere a release opens
	/// the name, and a helper waiting on a FIFO no name reaches stays there.
	/// In a process of its own, so the hooks take this test's helpers and
	/// releases.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_release_reaches_the_fifo_its_open_waits_on_after_the_name_was_replaced() {
		if crate::dir_handle::alone(
			"dir_handle::tests::unix::a_release_reaches_the_fifo_its_open_waits_on_after_the_name_was_replaced",
		) {
			return;
		}
		let tree = Tree::new("fifo-waiting");
		let fs = Fs::native().with_cancellation(tokio_util::sync::CancellationToken::new());
		let root = fs.blocking().open_dir(tree.at(""), true).unwrap();
		let (mut write, mut redirect) = (OpenOptions::new(), OpenOptions::new());
		write.write(true);
		redirect.write(true).create(true).truncate(true);
		let current: Arc<Mutex<PathBuf>> = Arc::default();
		let attempts = record_releases(Arc::clone(&current));
		for (opens, options) in [("write", &write), ("write, create, truncate", &redirect)] {
			for route in ["handle", "facade"] {
				for i in 0..REPLACE_TRIES {
					let case = format!("{opens}, {route}, try {i}");
					let name = format!("q-{}-{route}-{i}", opens.len());
					let fifo = tree.at(&name);
					mkfifo(&fifo);
					current.lock().clone_from(&fifo);
					let first = attempts.lock().len();
					let (tid_tx, tid) = std::sync::mpsc::channel();
					let (opened_tx, helper_opened) = std::sync::mpsc::channel();
					crate::fs::fifo_seam::set(
						move || {
							// SAFETY: `gettid` has no preconditions.
							let _ = tid_tx.send(unsafe { libc::syscall(libc::SYS_gettid) });
						},
						move |ok| {
							let _ = opened_tx.send(ok);
						},
					);
					runtime().block_on(async {
						let mut open = fifo_open(route, &root, &fs, &name, &fifo, options);
						tokio::select! {
							biased;
							_ = &mut open => panic!("{case}: a write-only FIFO open with no reader finished"),
							() = std::future::ready(()) => {},
						}
						let tid = tid
							.recv_timeout(HELPER_BOUND)
							.unwrap_or_else(|_| panic!("{case}: the helper never started"));
						let start = std::time::Instant::now();
						loop {
							match crate::tests::waits_in_open(tid) {
								Some(true) => break,
								Some(false) => {},
								None => panic!("{case}: /proc says nothing of the helper's thread"),
							}
							assert!(
								start.elapsed() < HELPER_BOUND,
								"{case}: the helper never waited in open"
							);
							std::thread::sleep(Duration::from_millis(1));
						}
						std::fs::remove_file(&fifo).unwrap();
						mkfifo(&fifo);
					});
					let opened = helper_opened
						.recv_timeout(HELPER_BOUND)
						.unwrap_or_else(|_| {
							panic!(
								"{case}: the helper's open still waited {HELPER_BOUND:?} after the drop"
							)
						});
					assert!(opened, "{case}: the helper's open failed");
					let these = attempts.lock()[first..].to_vec();
					assert!(!these.is_empty(), "{case}: no release ran");
					assert!(
						these.iter().all(|release| !release.met),
						"{case}: a writer to the new FIFO met a release's end; the releases since this \
						 open, each with the thread it ran on: {these:#?}"
					);
				}
			}
		}
	}

	/// The descriptors of this process that are of the file whose (device,
	/// inode) is `id`, by `fstat` of every descriptor number below the
	/// process's limit (at most 65536), so it needs no `/proc`.
	#[cfg(target_os = "linux")]
	#[allow(clippy::unnecessary_cast, reason = "stat field widths differ by platform")]
	fn descriptors_of(id: (u64, u64)) -> Vec<libc::c_int> {
		// SAFETY: `sysconf` has no preconditions.
		let limit = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
		let limit = libc::c_int::try_from(limit.clamp(0, 1 << 16)).unwrap_or(1 << 16);
		(0..limit)
			.filter(|&fd| {
				let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
				// SAFETY: `st` is a valid out-pointer; a number that is no
				// open descriptor fails with `EBADF`.
				if unsafe { libc::fstat(fd, st.as_mut_ptr()) } != 0 {
					return false;
				}
				// SAFETY: `fstat` succeeded and filled `st`.
				let st = unsafe { st.assume_init() };
				(st.st_dev as u64, st.st_ino as u64) == id
			})
			.collect()
	}

	/// A FIFO open whose FIFO is renamed just after its pin, before anything
	/// else of the open runs, is still released when it is dropped: the
	/// helper's open ends, and no descriptor of the FIFO stays in this
	/// process. With the helper and releases reaching the FIFO through
	/// `/proc`, where the helper waits on the renamed FIFO until a release
	/// reaches it, and by name, as without `/proc`, where the helper finds
	/// the name gone (so the open can fail with `NotFound` before its first
	/// poll returns). The control, taken in the hook while the pin is held:
	/// the scan of descriptors sees the pin. Through a handle's
	/// `open_at_async` and the facade's own open. Linux only: only there does
	/// a pin hold the FIFO. In a process of its own, so the hooks take this
	/// test's pins and helpers.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_fifo_renamed_just_after_its_pin_is_still_released() {
		if crate::dir_handle::alone(
			"dir_handle::tests::unix::a_fifo_renamed_just_after_its_pin_is_still_released",
		) {
			return;
		}
		let tree = Tree::new("fifo-renamed");
		let fs = Fs::native().with_cancellation(tokio_util::sync::CancellationToken::new());
		let root = fs.blocking().open_dir(tree.at(""), true).unwrap();
		let mut write = OpenOptions::new();
		write.write(true);
		for by_name in [false, true] {
			crate::fs::fifo_seam::open_by_name(by_name);
			for route in ["handle", "facade"] {
				let case = format!("{route}, by name {by_name}");
				let name = format!("r-{route}-{by_name}");
				let (fifo, parked) = (tree.at(&name), tree.at(&format!("parked-{route}-{by_name}")));
				mkfifo(&fifo);
				let (pinned_tx, pinned) = std::sync::mpsc::channel();
				{
					let (fifo, parked) = (fifo.clone(), parked.clone());
					crate::fs::fifo_seam::after_pin(move || {
						std::fs::rename(fifo, &parked).unwrap();
						let meta = std::fs::symlink_metadata(&parked).unwrap();
						let id = (meta.dev(), meta.ino());
						pinned_tx.send((id, descriptors_of(id).len())).unwrap();
					});
				}
				let (started_tx, started) = std::sync::mpsc::channel();
				let helper_opened = hook_next_fifo_helper(started_tx, None);
				let (reached_tx, reached) = std::sync::mpsc::channel();
				crate::fs::fifo_seam::after_check(reached_tx, false);
				let through_proc = !by_name && Path::new("/proc/self/fd").is_dir();
				runtime().block_on(async {
					let mut open = fifo_open(route, &root, &fs, &name, &fifo, &write);
					tokio::select! {
						biased;
						opened = &mut open => {
							// By name the helper may have found the name gone
							// already.
							let gone = opened
								.as_ref()
								.is_err_and(|err| err.kind() == io::ErrorKind::NotFound);
							assert!(
								!through_proc && gone,
								"{case}: a write-only FIFO open with no reader finished: {:?}",
								opened.map(drop)
							);
						},
						() = std::future::ready(()) => {},
					}
					started
						.recv_timeout(HELPER_BOUND)
						.unwrap_or_else(|_| panic!("{case}: the helper never started"));
					// The drop comes after the helper's check, so the helper
					// opens, and the drop releases it.
					reached
						.recv_timeout(HELPER_BOUND)
						.unwrap_or_else(|_| panic!("{case}: the helper never passed its check"));
				});
				let (id, seen) = pinned
					.recv_timeout(HELPER_BOUND)
					.unwrap_or_else(|_| panic!("{case}: the rename after the pin did not run"));
				// The control: the scan sees the pin while it is held.
				assert!(
					seen > 0,
					"{case}: no descriptor of the pinned FIFO is seen while it is pinned"
				);
				let Ok(opened) = helper_opened.recv_timeout(HELPER_BOUND) else {
					release_reader_end(&parked);
					panic!(
						"{case}: the helper still waited on the renamed FIFO {HELPER_BOUND:?} after the \
						 drop"
					);
				};
				// Through `/proc` a release connected the helper to the FIFO;
				// by name (also every way in a run without `/proc`) the helper
				// found the name gone.
				assert_eq!(opened, through_proc, "{case}: whether the helper's open succeeded");
				let start = std::time::Instant::now();
				loop {
					let held = descriptors_of(id);
					if held.is_empty() {
						break;
					}
					assert!(
						start.elapsed() < HELPER_BOUND,
						"{case}: descriptors {held:?} of the renamed FIFO stayed open"
					);
					std::thread::sleep(Duration::from_millis(1));
				}
			}
		}
	}

	/// A FIFO open under a cancellable facade refuses what the same open
	/// without a token refuses, with the same error: an exclusive create of
	/// the FIFO (`O_CREAT | O_EXCL` among the custom flags, or `create` with a
	/// custom `O_EXCL`: `EEXIST`), a read-only or append open that truncates
	/// (`EINVAL`), and a read-only open with a custom `O_TRUNC` of a FIFO this
	/// process may not write (`EACCES`: the kernel asks write permission for
	/// `O_TRUNC`; root may write it, so as root the plain open opens it, and
	/// so must the others). A handle's `open_at` and `open_at_async` are
	/// compared with a handle's `open_at` without a token, the facade's own
	/// blocking and async opens with the facade's open without one; on Linux
	/// with the helper reaching the FIFO through `/proc` and by name, as
	/// without `/proc`. Both ends of each FIFO are held open throughout, so an
	/// open that goes ahead where the plain one fails ends at once instead of
	/// waiting. In a process of its own, as the by-name switch is the
	/// process's.
	#[test]
	fn a_fifo_open_refuses_what_the_plain_open_refuses() {
		use std::os::unix::fs::OpenOptionsExt;
		if crate::dir_handle::alone(
			"dir_handle::tests::unix::a_fifo_open_refuses_what_the_plain_open_refuses",
		) {
			return;
		}
		let tree = Tree::new("fifo-refused");
		// `p` is open to its owner; `q` is read-only once both its ends are
		// open.
		let mut ends = Vec::new();
		for name in ["p", "q"] {
			let fifo = tree.at(name);
			mkfifo(&fifo);
			ends.push(
				std::fs::OpenOptions::new()
					.read(true)
					.custom_flags(libc::O_NONBLOCK)
					.open(&fifo)
					.unwrap(),
			);
			ends.push(std::fs::OpenOptions::new().write(true).open(&fifo).unwrap());
		}
		std::fs::set_permissions(tree.at("q"), std::fs::Permissions::from_mode(0o444)).unwrap();
		// SAFETY: `geteuid` has no preconditions.
		let root_user = unsafe { libc::geteuid() } == 0;
		let (mut exclusive, mut create_excl, mut read, mut append, mut read_otrunc) = (
			OpenOptions::new(),
			OpenOptions::new(),
			OpenOptions::new(),
			OpenOptions::new(),
			OpenOptions::new(),
		);
		exclusive
			.write(true)
			.custom_flags(libc::O_CREAT | libc::O_EXCL);
		create_excl
			.write(true)
			.create(true)
			.custom_flags(libc::O_EXCL);
		read.read(true).truncate(true);
		append.append(true).truncate(true);
		read_otrunc.read(true).custom_flags(libc::O_TRUNC);
		// Each case: its FIFO, its options, whether the plain open refuses it.
		let cases = [
			("an exclusive create", "p", exclusive, true),
			("a create with a custom O_EXCL", "p", create_excl, true),
			("a read that truncates", "p", read, true),
			("an append that truncates", "p", append, true),
			("a read with a custom O_TRUNC of a read-only FIFO", "q", read_otrunc, !root_user),
		];
		// An error as its kind and its OS error: the facade's open refuses an
		// invalid combination before any system call, a handle's `open_at`
		// with the system call's `EINVAL`.
		let error = |opened: io::Result<File>| {
			opened
				.map(drop)
				.map_err(|err| (err.kind(), err.raw_os_error()))
		};
		let plain = BlockingFs::native();
		let plain_root = plain.open_dir(tree.at(""), true).unwrap();
		let fs = Fs::native().with_cancellation(tokio_util::sync::CancellationToken::new());
		let root = fs.blocking().open_dir(tree.at(""), true).unwrap();
		let rt = runtime();
		let mut wrong = Vec::new();
		for by_name in [false, true] {
			crate::fs::fifo_seam::open_by_name(by_name);
			for (case, name, options, refused) in &cases {
				let fifo = tree.at(name);
				let by_facade = error(plain.open_with(&fifo, options));
				let by_handle = error(plain_root.open_at(n(name), options));
				// The control: both plain opens refuse it, with one kind (or,
				// where root may, both open it).
				let agree = match (&by_facade, &by_handle) {
					(Err((a, _)), Err((b, _))) => *refused && a == b,
					(Ok(()), Ok(())) => !refused,
					_ => false,
				};
				assert!(agree, "{case}: the plain opens gave {by_facade:?} and {by_handle:?}");
				let got = [
					("a handle's open_at", error(root.open_at(n(name), options)), &by_handle),
					(
						"a handle's open_at_async",
						error(rt.block_on(root.open_at_async(n(name), options))),
						&by_handle,
					),
					("the facade's open", error(fs.blocking().open_with(&fifo, options)), &by_facade),
					(
						"the facade's async open",
						error(rt.block_on(fs.open_with(&fifo, options))),
						&by_facade,
					),
				];
				for (route, result, want) in got {
					if result != *want {
						wrong.push(format!(
							"{case}, {route}, by name {by_name}: {result:?} where the plain open gives \
							 {want:?}"
						));
					}
				}
			}
		}
		drop(ends);
		if root_user {
			eprintln!(
				"note: as root the read-only FIFO can be written, so its O_TRUNC case cannot fail here"
			);
		}
		assert!(wrong.is_empty(), "FIFO opens under a token: {wrong:#?}");
	}

	/// Options of FIFO opens that create or truncate, each by label and
	/// whether it has `O_CREAT`: what the shell's `>` and `tee` open with, and
	/// each such flag alone.
	#[cfg(target_os = "linux")]
	fn creating_or_truncating_opens() -> Vec<(&'static str, OpenOptions, bool)> {
		let make = |label, creates, f: &dyn Fn(&mut OpenOptions)| {
			let mut options = OpenOptions::new();
			f(&mut options);
			(label, options, creates)
		};
		vec![
			make("write, create", true, &|o| {
				o.write(true).create(true);
			}),
			make("write, create, truncate", true, &|o| {
				o.write(true).create(true).truncate(true);
			}),
			make("write, custom O_CREAT", true, &|o| {
				o.write(true).custom_flags(libc::O_CREAT);
			}),
			make("write, truncate", false, &|o| {
				o.write(true).truncate(true);
			}),
			make("write, custom O_TRUNC", false, &|o| {
				o.write(true).custom_flags(libc::O_TRUNC);
			}),
			make("read, custom O_TRUNC", false, &|o| {
				o.read(true).custom_flags(libc::O_TRUNC);
			}),
			make("write, custom O_EXCL without O_CREAT", false, &|o| {
				o.write(true).custom_flags(libc::O_EXCL);
			}),
		]
	}

	/// A FIFO open under a cancellable facade whose options have `O_CREAT`
	/// (`create`, or a custom `O_CREAT`) opens the name with the caller's own
	/// options, so the kernel's check of such an open's name applies to it
	/// (`fs.protected_fifos` in a sticky directory): its helper takes the
	/// by-name way. Every other open reopens the pin through
	/// `/proc/self/fd/N`, a truncating one (`truncate`, a custom `O_TRUNC`)
	/// and a lone custom `O_EXCL` included: the kernel checks those flags
	/// through the magic link too (the write permission `O_TRUNC` asks).
	/// A plain write-only open is the control. An exclusive create (`create`
	/// or a custom `O_CREAT`, with a custom `O_EXCL`) starts no helper and
	/// fails with `EEXIST`, as the plain open does. Each through a handle's
	/// `open_at_async` and the facade's own open, with both ends of the FIFO
	/// held, so each open ends at once. Linux only (only there is there a
	/// reopen). In a process of its own, as the record of the helpers is the
	/// process's.
	#[cfg(target_os = "linux")]
	#[test]
	fn only_a_creating_fifo_open_opens_the_name_with_the_callers_options() {
		use std::os::unix::fs::OpenOptionsExt;

		use crate::fs::fifo_seam::{Helper, take_helpers};
		if crate::dir_handle::alone(
			"dir_handle::tests::unix::only_a_creating_fifo_open_opens_the_name_with_the_callers_options",
		) {
			return;
		}
		let tree = Tree::new("fifo-creating");
		let fifo = tree.at("p");
		mkfifo(&fifo);
		let reader = std::fs::OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(&fifo)
			.unwrap();
		let writer = std::fs::OpenOptions::new().write(true).open(&fifo).unwrap();
		let fs = Fs::native().with_cancellation(tokio_util::sync::CancellationToken::new());
		let root = fs.blocking().open_dir(tree.at(""), true).unwrap();
		let rt = runtime();
		let reopens = Path::new("/proc/self/fd").is_dir();
		let reopen = if reopens {
			Helper::Reopen
		} else {
			Helper::ByName
		};
		let mut plain_write = OpenOptions::new();
		plain_write.write(true);
		// Each case: its options, the helpers it starts, and whether it opens.
		let mut cases: Vec<_> = creating_or_truncating_opens()
			.into_iter()
			.map(|(label, options, creates)| {
				let helper = if creates { Helper::ByName } else { reopen };
				(label, options, vec![helper], true)
			})
			.collect();
		cases.push(("write only (the control)", plain_write, vec![reopen], true));
		// An exclusive create never waits on a FIFO: it takes the plain open,
		// which gives `EEXIST`, and starts no helper.
		let (mut create_excl, mut custom_excl) = (OpenOptions::new(), OpenOptions::new());
		create_excl
			.write(true)
			.create(true)
			.custom_flags(libc::O_EXCL);
		custom_excl
			.write(true)
			.custom_flags(libc::O_CREAT | libc::O_EXCL);
		cases.push(("write, create, custom O_EXCL", create_excl, vec![], false));
		cases.push(("write, custom O_CREAT | O_EXCL", custom_excl, vec![], false));
		let mut wrong = Vec::new();
		take_helpers();
		for (label, options, want, opens) in &cases {
			for route in ["handle", "facade"] {
				let opened = rt.block_on(fifo_open(route, &root, &fs, "p", &fifo, options));
				let helpers = take_helpers();
				let as_due = if *opens {
					opened.is_ok()
				} else {
					opened
						.as_ref()
						.is_err_and(|err| err.raw_os_error() == Some(libc::EEXIST))
				};
				if !as_due || helpers != *want {
					wrong.push(format!(
						"{label}, {route}: {:?}, helpers {helpers:?} where {want:?} are due",
						opened.map(drop)
					));
				}
			}
		}
		drop((reader, writer));
		if !reopens {
			eprintln!(
				"note: /proc/self/fd is not there, so every helper went by name; the control cannot \
				 tell the ways apart"
			);
		}
		assert!(wrong.is_empty(), "FIFO opens under a token: {wrong:#?}");
	}

	/// The window a creating open's by-name helper leaves (see
	/// [`crate::fifo::FifoOpen`]): with the shell's `>` options, the FIFO's
	/// name is given to another FIFO (`rm p; mkfifo p`) just after the pin,
	/// before the helper opens the name, so the helper waits on the new FIFO
	/// while the drop's release opens the pinned one through
	/// `/proc/self/fd/N`. The open is dropped once the helper passed its last
	/// check and is about to open the name (a drop before that check leaves a
	/// helper that opens nothing, and so no window): the release runs and
	/// does not reach the helper, and the drop returns without waiting for it
	/// (a watchdog fails the test, ending the process, if it waits), while
	/// the helper stays in its open, holding the pin (one descriptor of the
	/// old FIFO stays open). The new FIFO's next reader then completes the
	/// helper's open; the helper closes its end at once, so that reader reads
	/// end of file, and the pin's descriptor is closed. Through a handle's
	/// `open_at_async` and the facade's own open. Linux with `/proc` only
	/// (elsewhere the release opens the name only while it names the pinned
	/// FIFO, so the drop leaves the helper before any release); else it checks
	/// nothing and says so. In a process of its own, so the hooks take this
	/// test's pins, helpers and releases.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_creating_fifo_open_whose_fifo_is_replaced_before_its_helper_opens_is_not_released() {
		use std::os::unix::fs::OpenOptionsExt;
		if crate::dir_handle::alone(
			"dir_handle::tests::unix::a_creating_fifo_open_whose_fifo_is_replaced_before_its_helper_opens_is_not_released",
		) {
			return;
		}
		if !Path::new("/proc/self/fd").is_dir() {
			eprintln!(
				"UNKNOWN: /proc/self/fd is not there, so releases open the name; nothing was checked"
			);
			return;
		}
		let tree = Tree::new("fifo-window");
		let fs = Fs::native().with_cancellation(tokio_util::sync::CancellationToken::new());
		let root = fs.blocking().open_dir(tree.at(""), true).unwrap();
		let mut redirect = OpenOptions::new();
		redirect.write(true).create(true).truncate(true);
		let current: Arc<Mutex<PathBuf>> = Arc::default();
		let attempts = record_releases(Arc::clone(&current));
		for route in ["handle", "facade"] {
			let name = format!("w-{route}");
			let fifo = tree.at(&name);
			mkfifo(&fifo);
			current.lock().clone_from(&fifo);
			let (pinned_tx, pinned) = std::sync::mpsc::channel();
			{
				let fifo = fifo.clone();
				crate::fs::fifo_seam::after_pin(move || {
					let meta = std::fs::symlink_metadata(&fifo).unwrap();
					std::fs::remove_file(&fifo).unwrap();
					mkfifo(&fifo);
					pinned_tx.send((meta.dev(), meta.ino())).unwrap();
				});
			}
			let (started_tx, started) = std::sync::mpsc::channel();
			let helper_opened = hook_next_fifo_helper(started_tx, None);
			// The helper's last check is passed once its hook before the open
			// runs; the hook's key is what the helper opens by name: an
			// entry's name for a handle, the path for the facade.
			let (reached_tx, reached) = std::sync::mpsc::channel();
			let key = if route == "handle" {
				PathBuf::from(&name)
			} else {
				fifo.clone()
			};
			crate::fifo::hooks::before_open(&key, move || reached_tx.send(()).unwrap());
			let first = attempts.lock().len();
			let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
			{
				let (dropped, route) = (Arc::clone(&dropped), route.to_owned());
				std::thread::spawn(move || {
					std::thread::sleep(HELPER_BOUND);
					if !dropped.load(std::sync::atomic::Ordering::SeqCst) {
						eprintln!(
							"{route}: the drop still waited {HELPER_BOUND:?} for a helper no release \
							 reaches"
						);
						std::process::exit(101);
					}
				});
			}
			runtime().block_on(async {
				let mut open = fifo_open(route, &root, &fs, &name, &fifo, &redirect);
				tokio::select! {
					biased;
					_ = &mut open => panic!("{route}: a write-only FIFO open with no reader finished"),
					() = std::future::ready(()) => {},
				}
				started
					.recv_timeout(HELPER_BOUND)
					.unwrap_or_else(|_| panic!("{route}: the helper never started"));
				reached
					.recv_timeout(HELPER_BOUND)
					.unwrap_or_else(|_| panic!("{route}: the helper never passed its last check"));
			});
			dropped.store(true, std::sync::atomic::Ordering::SeqCst);
			let old = pinned
				.recv_timeout(HELPER_BOUND)
				.unwrap_or_else(|_| panic!("{route}: the replacement after the pin did not run"));
			// The drop's release ran, on the dropping thread; it held an end of
			// the pinned FIFO and none of the new one.
			let these = attempts.lock()[first..].to_vec();
			assert!(
				these.len() == 1 && these.iter().all(|release| release.held && !release.met),
				"{route}: one release, holding an end of the pinned FIFO and none of the new one: \
				 {these:#?}"
			);
			assert!(
				helper_opened.try_recv().is_err(),
				"{route}: the helper's open ended though no release reaches the new FIFO"
			);
			// The release's end is closed by the time the drop returns; then
			// the pin is the one descriptor of the old FIFO.
			let start = std::time::Instant::now();
			while descriptors_of(old).len() != 1 {
				assert!(
					start.elapsed() < HELPER_BOUND,
					"{route}: descriptors {:?} of the old FIFO, where the pin's one is due",
					descriptors_of(old)
				);
				std::thread::sleep(Duration::from_millis(1));
			}
			// The new FIFO's next reader completes the helper's open, which
			// closes its end at once.
			let mut reader = std::fs::OpenOptions::new()
				.read(true)
				.custom_flags(libc::O_NONBLOCK)
				.open(&fifo)
				.unwrap();
			let opened = helper_opened
				.recv_timeout(HELPER_BOUND)
				.unwrap_or_else(|_| {
					panic!("{route}: the new FIFO's reader did not complete the helper's open")
				});
			assert!(opened, "{route}: the helper's open of the new FIFO failed");
			let start = std::time::Instant::now();
			let read = loop {
				let mut byte = [0_u8; 1];
				match reader.read(&mut byte) {
					Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
						assert!(start.elapsed() < HELPER_BOUND, "{route}: the helper's end stayed open");
						std::thread::sleep(Duration::from_millis(1));
					},
					result => break result,
				}
			};
			assert_eq!(read.ok(), Some(0), "{route}: the new FIFO's reader read end of file");
			let start = std::time::Instant::now();
			while !descriptors_of(old).is_empty() {
				assert!(
					start.elapsed() < HELPER_BOUND,
					"{route}: the pin stayed open after the helper ended"
				);
				std::thread::sleep(Duration::from_millis(1));
			}
		}
	}

	/// With `fs.protected_fifos` at 1 or more, an open that asks to create of
	/// a FIFO another user owns in a world-writable sticky directory that
	/// user does not own is refused (`EACCES`), so a command that means to
	/// create a file never writes into such a FIFO. A FIFO open under a
	/// cancellable facade is refused as the plain open is: through a handle's
	/// `open_at` and `open_at_async` and the facade's blocking and async
	/// opens, with the shell's `>` and `tee`'s options and a custom `O_CREAT`.
	/// The FIFO's read end is held, so an open that goes ahead ends at once and
	/// its write reaches that reader. As root, which can give the FIFO to
	/// another user, or as any user given such a FIFO (`sticky_fifo`), where
	/// `fs.protected_fifos` is 1 or more and the plain open is refused;
	/// elsewhere it checks nothing and says so. Linux only.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_fifo_open_that_creates_is_refused_in_a_sticky_directory_as_the_plain_open_is() {
		use std::os::unix::fs::OpenOptionsExt;
		let protected = std::fs::read_to_string("/proc/sys/fs/protected_fifos")
			.ok()
			.and_then(|value| value.trim().parse::<u32>().ok());
		if protected.is_none_or(|value| value < 1) {
			eprintln!(
				"UNKNOWN: fs.protected_fifos is {protected:?}, not 1 or more; nothing was checked"
			);
			return;
		}
		let tree = Tree::new("fifo-sticky");
		let fifo = match crate::tests::sticky_fifo(&tree.at("")) {
			Ok(fifo) => fifo,
			Err(why) => {
				eprintln!("UNKNOWN: {why}; nothing was checked");
				return;
			},
		};
		let sticky = fifo.parent().unwrap().to_path_buf();
		let name = n(fifo.file_name().unwrap().to_str().unwrap());
		let mut reader = std::fs::OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(&fifo)
			.unwrap();
		let error = |opened: io::Result<File>| {
			opened
				.map(|mut file| {
					let _ = file.write_all(b"written");
				})
				.map_err(|err| (err.kind(), err.raw_os_error()))
		};
		let plain = BlockingFs::native();
		let plain_dir = plain.open_dir(&sticky, true).unwrap();
		let fs = Fs::native().with_cancellation(tokio_util::sync::CancellationToken::new());
		let dir = fs.blocking().open_dir(&sticky, true).unwrap();
		let rt = runtime();
		let mut wrong = Vec::new();
		for (label, options, _) in creating_or_truncating_opens()
			.into_iter()
			.filter(|(_, _, creates)| *creates)
		{
			let by_facade = error(plain.open_with(&fifo, &options));
			let by_handle = error(plain_dir.open_at(name, &options));
			if by_facade.is_ok() || by_handle.is_ok() {
				eprintln!(
					"UNKNOWN: {label}: the plain opens gave {by_facade:?} and {by_handle:?}, so \
					 fs.protected_fifos does not hold here; nothing was checked"
				);
				return;
			}
			let got = [
				("a handle's open_at", error(dir.open_at(name, &options)), &by_handle),
				(
					"a handle's open_at_async",
					error(rt.block_on(dir.open_at_async(name, &options))),
					&by_handle,
				),
				("the facade's open", error(fs.blocking().open_with(&fifo, &options)), &by_facade),
				(
					"the facade's async open",
					error(rt.block_on(fs.open_with(&fifo, &options))),
					&by_facade,
				),
			];
			for (route, result, want) in got {
				if result != *want {
					wrong.push(format!(
						"{label}, {route}: {result:?} where the plain open gives {want:?}"
					));
				}
			}
		}
		let mut leaked = Vec::new();
		let _ = reader.read_to_end(&mut leaked);
		assert!(
			wrong.is_empty(),
			"FIFO opens under a token in a sticky directory (another user's FIFO read {} bytes): \
			 {wrong:#?}",
			leaked.len()
		);
	}

	/// Opens `fifo`'s read end without blocking and closes it, which releases
	/// an open of its write end waiting for a reader.
	fn release_reader_end(fifo: &Path) {
		use std::os::unix::fs::OpenOptionsExt;
		let _ = std::fs::OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(fifo);
	}

	/// Under a cancellable facade, the blocking `open_at` of a FIFO with no
	/// other end ends at the token with the facade's cancellation error, and
	/// its helper's open is released. In a process of its own, so the hook
	/// takes this test's helper.
	#[test]
	fn open_at_of_a_fifo_ends_at_the_token() {
		if crate::dir_handle::alone("dir_handle::tests::unix::open_at_of_a_fifo_ends_at_the_token") {
			return;
		}
		let tree = Tree::new("fifo-token-sync");
		mkfifo(&tree.at("p"));
		let (started_tx, started) = std::sync::mpsc::channel();
		let helper_opened = hook_next_fifo_helper(started_tx, None);
		let token = tokio_util::sync::CancellationToken::new();
		let fs = Fs::native().with_cancellation(token.clone());
		let root = fs.blocking().open_dir(tree.at(""), true).unwrap();
		let canceller = std::thread::spawn(move || {
			started
				.recv_timeout(HELPER_BOUND)
				.expect("the helper never started");
			token.cancel();
		});
		let fifo = tree.at("p");
		ends(
			"the blocking FIFO open under a token",
			move || {
				let mut read = OpenOptions::new();
				read.read(true);
				let err = root.open_at(n("p"), &read).map(drop).unwrap_err();
				assert!(crate::error::is_cancelled(&err), "{err:?}");
			},
			|| release_reader(&fifo),
		);
		canceller.join().unwrap();
		let opened = helper_opened.recv_timeout(HELPER_BOUND);
		assert!(opened.is_ok(), "the helper's open was not released");
	}

	/// A directory opened only to reach what is below it needs only its
	/// search permission on Linux, where it is opened `O_PATH`: by path
	/// ([`crate::dir_handle::host::open_dir_to_search`]), as `..` of a child
	/// ([`DirHandle::open_parent`]), and below another
	/// ([`DirHandle::open_dir_beneath_to_search_async`]). Each opens the
	/// subdirectory below it and has its identity, where a listing open of
	/// the directory is refused. Elsewhere each is refused as the listing
	/// open is. As root, which needs no permission, the test says it
	/// is skipped.
	#[test]
	fn a_directory_opened_to_search_needs_only_its_search_permission() {
		// SAFETY: `geteuid` has no preconditions.
		if unsafe { libc::geteuid() } == 0 {
			eprintln!("skipped: root needs no permission to read a directory");
			return;
		}
		let tree = TempDir::new("search-only");
		let top = tree.0.join("top");
		std::fs::create_dir_all(top.join("mid/sub")).unwrap();
		let top_id = std::fs::metadata(&top).unwrap().ino();
		let mid_id = std::fs::metadata(top.join("mid")).unwrap().ino();
		let root = crate::dir_handle::host::open_dir(&tree.0, false).unwrap();
		let mid = crate::dir_handle::host::open_dir(&top.join("mid"), false).unwrap();
		// Search, no read.
		std::fs::set_permissions(&top, std::fs::Permissions::from_mode(0o311)).unwrap();
		std::fs::set_permissions(top.join("mid"), std::fs::Permissions::from_mode(0o311)).unwrap();
		let restore =
			|path: &Path| std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
		let rt = tokio::runtime::Builder::new_current_thread()
			.build()
			.unwrap();
		let listing = crate::dir_handle::host::open_dir(&top, true).map(drop);
		let by_path = crate::dir_handle::host::open_dir_to_search(&top);
		let parent = mid.open_parent();
		let beneath = rt.block_on(root.open_dir_beneath_to_search_async(b"top/mid"));
		restore(&top.join("mid")).unwrap();
		restore(&top).unwrap();
		assert_eq!(listing.unwrap_err().kind(), io::ErrorKind::PermissionDenied, "the listing open");
		if cfg!(target_os = "linux") {
			for (how, opened, id) in
				[("by path", by_path, top_id), ("as ..", parent, top_id), ("beneath", beneath, mid_id)]
			{
				let opened = opened.unwrap_or_else(|e| panic!("{how}: {e}"));
				assert_eq!(opened.identity().unwrap().ino(), id, "{how}: the identity");
				opened
					.open_dir_at(OsStr::new(if id == top_id { "mid" } else { "sub" }))
					.unwrap_or_else(|e| panic!("{how}: the child: {e}"));
			}
		} else {
			for (how, opened) in [("by path", by_path), ("as ..", parent), ("beneath", beneath)] {
				assert_eq!(
					opened.map(drop).unwrap_err().kind(),
					io::ErrorKind::PermissionDenied,
					"{how}"
				);
			}
		}
	}
}

#[cfg(windows)]
mod windows {
	use std::{
		ffi::OsStr,
		io,
		path::{Path, PathBuf},
		sync::Arc,
	};

	use crate::{BlockingFs, OpenOptions};

	/// A fresh directory below [`super::super::temp_root`], named for `tag`.
	fn temp(tag: &str) -> PathBuf {
		let path = super::super::temp_root().join(format!("pi-vfs-dh-{tag}-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&path);
		std::fs::create_dir_all(&path).unwrap();
		path
	}

	fn create() -> OpenOptions {
		let mut options = OpenOptions::new();
		options.write(true).create(true).truncate(true);
		options
	}

	/// A drive-relative name (`C:x`) is no entry name: every call refuses
	/// it, and nothing is made in that drive's current directory.
	#[test]
	fn a_drive_relative_name_is_refused() {
		let dir = temp("drive");
		let root = BlockingFs::native().open_dir(&dir, true).unwrap();
		// Unique per run: Wine reuses process ids, and a victim an earlier run
		// made (a red run of this test) must not read as this run's.
		let nanos = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap()
			.as_nanos();
		let victim = format!("pi-vfs-victim-{}-{nanos}", std::process::id());
		let names = [format!("C:{victim}"), format!("c:{victim}"), "C:".to_owned()];
		for name in &names {
			let name = OsStr::new(name);
			let opened = root.open_at(name, &create()).map(drop);
			let made = root.create_dir_at(name, None);
			let stat = root.stat_at(name, false).map(drop);
			for (call, result) in [("open_at", opened), ("create_dir_at", made), ("stat_at", stat)] {
				let err = result.unwrap_err();
				assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{call}({name:?}): {err:?}");
			}
		}
		let cwd = std::path::Path::new("C:")
			.canonicalize()
			.unwrap()
			.join(&victim);
		let leaked = cwd.exists();
		let _ = std::fs::remove_file(&cwd);
		let _ = std::fs::remove_dir(&cwd);
		assert!(!leaked, "{} was made in C:'s current directory", cwd.display());
	}

	/// A handle on a reparse point (a directory symlink opened by
	/// `open_dir_at`, which opens the link itself) makes no path-based call
	/// through it: a creation there is refused, and nothing appears in the
	/// link's target.
	#[test]
	fn a_handle_on_a_reparse_point_makes_nothing_through_it() {
		let (dir, outside) = (temp("reparse"), temp("reparse-outside"));
		if let Err(err) = std::os::windows::fs::symlink_dir(&outside, dir.join("d")) {
			eprintln!("UNKNOWN: no directory symlink could be made here ({err}); nothing was checked");
			return;
		}
		// Wine's CreateSymbolicLinkW is a stub that reports success and makes
		// nothing: an instrument that made no link checks nothing.
		if !std::fs::symlink_metadata(dir.join("d")).is_ok_and(|meta| meta.is_symlink()) {
			eprintln!(
				"UNKNOWN: the directory symlink was reported made but is not there; nothing was \
				 checked"
			);
			return;
		}
		let root = BlockingFs::native().open_dir(&dir, true).unwrap();
		let d = match root.open_dir_at(OsStr::new("d")) {
			Ok(d) => d,
			Err(err) => {
				eprintln!(
					"UNKNOWN: open_dir_at refused the link itself ({err:?}): nothing to call through"
				);
				return;
			},
		};
		let made = d.create_dir_at(OsStr::new("x"), None);
		let opened = d.open_at(OsStr::new("f"), &create()).map(drop);
		assert!(!outside.join("x").exists(), "create_dir_at made x in the link's target ({made:?})");
		assert!(!outside.join("f").exists(), "open_at made f in the link's target ({opened:?})");
		assert!(made.is_err() && opened.is_err(), "{made:?} {opened:?}");
	}

	/// A handle on a volume with no drive letter makes its path-based calls
	/// through the volume's GUID path (`\\?\Volume{...}\`), where the final
	/// path in drive-letter form does not exist: a directory made there is
	/// found where it was asked, and the handle stats it. A run that has such
	/// a volume names its root in `PI_VFS_TEST_DRIVELESS_DIR`.
	#[test]
	fn a_handle_on_a_volume_with_no_drive_letter_makes_its_calls_there() {
		let Some(root_path) = std::env::var_os("PI_VFS_TEST_DRIVELESS_DIR").map(PathBuf::from) else {
			eprintln!(
				"UNKNOWN: PI_VFS_TEST_DRIVELESS_DIR names no volume without a drive letter; nothing \
				 was checked"
			);
			return;
		};
		let name = format!("pi-vfs-guid-{}", std::process::id());
		let made = root_path.join(&name);
		let _ = std::fs::remove_dir_all(&made);
		let root = BlockingFs::native().open_dir(&root_path, true).unwrap();
		root.create_dir_at(OsStr::new(&name), None).unwrap();
		assert!(made.is_dir(), "{} was not made", made.display());
		assert!(root.stat_at(OsStr::new(&name), false).unwrap().is_dir());
		std::fs::remove_dir(&made).unwrap();
	}

	/// A provider that serves one directory at every path and records the
	/// directories it is asked to make.
	#[derive(Debug, Default)]
	struct Recorder {
		made: parking_lot::Mutex<Vec<PathBuf>>,
	}

	#[async_trait::async_trait]
	impl crate::FileSystem for Recorder {
		async fn open(&self, _path: &Path, _options: &OpenOptions) -> io::Result<crate::File> {
			Err(io::ErrorKind::Unsupported.into())
		}

		async fn metadata(&self, _path: &Path) -> io::Result<crate::Metadata> {
			Ok(crate::Metadata::new(
				crate::FileType::from_kind(crate::FileKind::Dir),
				0,
				crate::Permissions::from_mode(0o755),
			))
		}

		async fn read_dir(&self, _path: &Path) -> io::Result<crate::ReadDir> {
			Err(io::ErrorKind::Unsupported.into())
		}

		async fn create_dir(&self, path: &Path, _mode: Option<u32>) -> io::Result<()> {
			self.made.lock().push(path.to_path_buf());
			Ok(())
		}
	}

	/// A Windows host handle refuses an entry name holding `:` (a stream of
	/// another entry, or a drive) and makes nothing; a URL provider's handle
	/// takes it, since such a provider's names are its own.
	#[test]
	fn a_colon_name_is_refused_on_the_host_and_taken_by_a_provider() {
		let dir = temp("colon");
		let root = BlockingFs::native().open_dir(&dir, true).unwrap();
		for name in ["ab:s", "x::$INDEX_ALLOCATION", "a:"] {
			let err = root.create_dir_at(OsStr::new(name), None).unwrap_err();
			assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{name}: {err:?}");
		}
		assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "the host made an entry");
		let recorder = Arc::new(Recorder::default());
		let fs = crate::Fs::new(Arc::clone(&recorder) as Arc<dyn crate::FileSystem>);
		let rt = tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()
			.unwrap();
		rt.block_on(async {
			let provided = fs.open_dir("mem://t", true).await.unwrap();
			provided
				.create_dir_at_async(OsStr::new("ab:s"), None)
				.await
				.unwrap();
		});
		assert_eq!(recorder.made.lock().len(), 1, "the provider made no directory");
	}

	/// A path handle whose path is a host path (from `Fs::open_dir_by_path`,
	/// as pi-walker's provider sessions open one) refuses an entry name
	/// holding `:` as a host handle does: it makes neither a stream of an
	/// entry nor an entry in C:'s current directory.
	#[test]
	fn a_path_handle_over_a_host_path_refuses_a_colon_name() {
		let dir = temp("colon-path");
		let rt = tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()
			.unwrap();
		let handle = rt
			.block_on(crate::Fs::native().open_dir_by_path(&dir, true))
			.unwrap();
		assert!(!handle.is_native(), "not a path handle");
		let nanos = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap()
			.as_nanos();
		let victim = format!("pi-vfs-path-victim-{}-{nanos}", std::process::id());
		for name in [format!("C:{victim}"), "ab:s".to_owned(), "x::$INDEX_ALLOCATION".to_owned()] {
			let result = rt.block_on(handle.create_dir_at_async(OsStr::new(&name), None));
			let err = result.unwrap_err();
			assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{name}: {err:?}");
		}
		assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "the path handle made an entry");
		let cwd = std::path::Path::new("C:")
			.canonicalize()
			.unwrap()
			.join(&victim);
		let leaked = cwd.exists();
		let _ = std::fs::remove_dir(&cwd);
		assert!(!leaked, "{} was made in C:'s current directory", cwd.display());
	}

	/// `open_at` opens no directory on Windows either:
	/// `FILE_FLAG_BACKUP_SEMANTICS`, which lets `CreateFileW` open one, is
	/// refused.
	#[test]
	fn open_at_refuses_backup_semantics() {
		use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
		let dir = temp("backup");
		std::fs::create_dir(dir.join("d")).unwrap();
		let root = BlockingFs::native().open_dir(&dir, true).unwrap();
		let mut options = OpenOptions::new();
		options
			.read(true)
			.custom_flags(FILE_FLAG_BACKUP_SEMANTICS as i32);
		let err = root
			.open_at(OsStr::new("d"), &options)
			.map(drop)
			.unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{err:?}");
	}
}
