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

use super::check_relative;

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
	/// symlink; a file it creates gets the requested mode less the umask, or
	/// exactly less the facade's creation mask.
	#[test]
	fn open_at_opens_no_symlink_and_creates_with_the_mode_asked() {
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
				create.write(true).create_new(true).mode(0o640);
				open(&created, &create).unwrap().write_all(b"made").unwrap();
				assert_eq!(std::fs::read(tree.at(&created)).unwrap(), b"made", "{label} {flavor}");
				let err = open(&created, &create).unwrap_err();
				assert_eq!(err.kind(), io::ErrorKind::AlreadyExists, "{label} {flavor}");
				std::fs::remove_file(tree.at(&created)).unwrap();
			}
			let err = root.open_at(n("f"), &OpenOptions::new()).unwrap_err();
			assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{label}: no access mode: {err:?}");
		}
		// The host's creation mask: exactly 0o666 less 0o007, which a process
		// umask of 0o022 alone would not give.
		let masked = Fs::native().with_creation_mask(Some(0o007)).blocking();
		let root = masked.open_dir(tree.at(""), true).unwrap();
		let mut create = OpenOptions::new();
		create.write(true).create_new(true).mode(0o666);
		drop(root.open_at(n("masked"), &create).unwrap());
		let mode = std::fs::metadata(tree.at("masked")).unwrap().mode() & 0o777;
		assert_eq!(mode, 0o660, "creation mask: {mode:o}");
		assert!(
			tree.provider.take().contains(&"open mem://t/f".to_owned()),
			"the provider opened the joined path"
		);
	}

	/// `create_dir_at` makes the directory with the mode asked, refuses an
	/// existing entry, and gives exactly the mode less a facade's creation
	/// mask.
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
				assert_eq!(meta.mode() & 0o777, 0o750, "{label}: {made}");
				std::fs::remove_dir(tree.at(made)).unwrap();
			}
			let err = root.create_dir_at(n("f"), None).unwrap_err();
			assert_eq!(err.kind(), io::ErrorKind::AlreadyExists, "{label}");
		}
		let masked = Fs::native().with_creation_mask(Some(0o077)).blocking();
		let root = masked.open_dir(tree.at(""), true).unwrap();
		root.create_dir_at(n("masked"), None).unwrap();
		let mode = std::fs::metadata(tree.at("masked")).unwrap().mode() & 0o777;
		assert_eq!(mode, 0o700, "creation mask: {mode:o}");
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
	/// only with `follow`; without, a symlink is refused and its target keeps
	/// its mode.
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
			let err = root
				.set_permissions_at(n("l"), Permissions::from_mode(0o604), false)
				.unwrap_err();
			assert_eq!(mode(), 0o640, "{label}: l followed without follow ({err:?})");
			let err = rt
				.block_on(root.set_permissions_at_async(n("l"), Permissions::from_mode(0o604), false))
				.unwrap_err();
			assert_eq!(mode(), 0o640, "{label}: l followed without follow ({err:?})");
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
	/// `openat2` get, reaches regular files and directories but no symlink on
	/// the way, inside the root or out of it.
	#[test]
	fn the_component_walk_follows_no_symlink() {
		let tree = Tree::new("walk");
		std::os::unix::fs::symlink(tree.outside(), tree.at("esc")).unwrap();
		let root = BlockingFs::native().open_dir(tree.at(""), true).unwrap();
		let super::super::DirRepr::Host { handle, .. } = &root.repr else {
			panic!("a host root");
		};
		let mut scratch = super::super::native::Scratch::default();
		let walk = super::super::native::open_beneath_walking;
		assert!(walk(&mut scratch, handle, b"d/inner", false).is_ok());
		assert!(walk(&mut scratch, handle, b"d", true).is_ok());
		for (rel, dir) in
			[("l", false), ("ld/inner", false), ("esc/secret", false), ("ld", true), ("esc", true)]
		{
			let err = walk(&mut scratch, handle, rel.as_bytes(), dir).unwrap_err();
			assert!(matches!(err.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)), "{rel}: {err:?}");
		}
	}
}
