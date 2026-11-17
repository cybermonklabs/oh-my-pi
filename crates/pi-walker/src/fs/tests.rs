use std::{
	io,
	path::{Path, PathBuf},
	sync::atomic::{AtomicUsize, Ordering},
	time::UNIX_EPOCH,
};

use super::*;
use crate::testing::MemFs;

/// A unique temporary directory removed on drop.
struct TempDir(PathBuf);

impl TempDir {
	fn new(tag: &str) -> Self {
		static NEXT: AtomicUsize = AtomicUsize::new(0);
		let n = NEXT.fetch_add(1, Ordering::Relaxed);
		let path = std::env::temp_dir()
			.canonicalize()
			.unwrap()
			.join(format!("pg-fs-{tag}-{}-{n}", std::process::id()));
		let _ = std::fs::remove_dir_all(&path);
		std::fs::create_dir_all(&path).unwrap();
		Self(path)
	}

	fn write(&self, rel: &str, contents: &[u8]) -> PathBuf {
		let path = self.0.join(rel);
		std::fs::create_dir_all(path.parent().unwrap()).unwrap();
		std::fs::write(&path, contents).unwrap();
		path
	}
}

impl Drop for TempDir {
	fn drop(&mut self) {
		let _ = std::fs::remove_dir_all(&self.0);
	}
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

async fn read_all(session: &mut Session, dir: &Dir, name: &str, limit: u64) -> (Vec<u8>, FileInfo) {
	let (mut file, info) = session
		.open_file_at(dir, name.as_bytes(), false)
		.await
		.unwrap();
	let mut buf = Vec::new();
	file.read_into(&mut buf, limit).await.unwrap();
	(buf, info)
}

fn mtime_nanos(path: &Path) -> i64 {
	let modified = std::fs::symlink_metadata(path).unwrap().modified().unwrap();
	modified.duration_since(UNIX_EPOCH).unwrap().as_nanos() as i64
}

#[cfg(unix)]
fn mkfifo(path: &Path) {
	use std::os::unix::ffi::OsStrExt;
	let cpath = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
	// SAFETY: `cpath` is a valid NUL-terminated path.
	assert_eq!(unsafe { libc::mkfifo(cpath.as_ptr(), 0o644) }, 0, "mkfifo {}", path.display());
}

/// Listings omit `.`/`..` and special files and report symlinks unresolved,
/// in both detail levels.
#[tokio::test(flavor = "multi_thread")]
async fn native_listing_reports_names_and_types() {
	let tmp = TempDir::new("list");
	tmp.write("a.txt", b"hello");
	tmp.write("dir/b.txt", b"0123456789");
	#[cfg(unix)]
	{
		std::os::unix::fs::symlink("a.txt", tmp.0.join("link")).unwrap();
		mkfifo(&tmp.0.join("fifo"));
		let _socket = std::os::unix::net::UnixListener::bind(tmp.0.join("sock")).unwrap();
	}
	let fs = Fs::native();
	let mut s = fs.session();
	let mut want = vec![("a.txt".to_owned(), FileType::File), ("dir".to_owned(), FileType::Dir)];
	#[cfg(unix)]
	want.push(("link".to_owned(), FileType::Symlink));
	want.sort_by(|a, b| a.0.cmp(&b.0));
	for detail in [Detail::Minimal, Detail::Full] {
		let dir = s.open_dir(&tmp.0).await.unwrap();
		assert_eq!(names(s.list(&dir, detail, 0).await.unwrap()), want, "{detail:?}");
	}
	let dir = s.open_dir(&tmp.0).await.unwrap();
	let child = s.open_child(&dir, b"dir").await.unwrap();
	assert_eq!(names(s.list(&child, Detail::Minimal, 0).await.unwrap()), [(
		"b.txt".to_owned(),
		FileType::File
	)]);
}

/// Full listings carry regular-file sizes and every entry's mtime.
#[tokio::test(flavor = "multi_thread")]
async fn native_full_listing_has_sizes_and_mtimes() {
	let tmp = TempDir::new("full");
	let file = tmp.write("a.txt", b"hello");
	tmp.write("sub/x", b"");
	tmp.write("sub/y", b"");
	let fs = Fs::native();
	let mut s = fs.session();
	let dir = s.open_dir(&tmp.0).await.unwrap();
	let listing = s.list(&dir, Detail::Full, 0).await.unwrap().clone();
	let record = |name: &str| {
		*listing
			.records()
			.iter()
			.find(|r| listing.name(r) == name.as_bytes())
			.unwrap()
	};
	let a = record("a.txt");
	assert_eq!(a.size, Some(5));
	assert_eq!(a.mtime, Some(mtime_nanos(&file)));
	let sub = record("sub");
	assert_eq!(sub.size, None);
	// NTFS refreshes a directory's entry in its parent's index lazily, so a
	// listing can trail the directory's own mtime there.
	if !cfg!(windows) {
		assert_eq!(sub.mtime, Some(mtime_nanos(&tmp.0.join("sub"))));
	}
	if cfg!(target_os = "macos") {
		assert_eq!(sub.children, 2);
	}
	// The parent's entry count lets the child stop early without losing entries.
	let child = s.open_child(&dir, b"sub").await.unwrap();
	let got = names(s.list(&child, Detail::Full, sub.children).await.unwrap());
	assert_eq!(got, [("x".to_owned(), FileType::File), ("y".to_owned(), FileType::File)]);
}

/// Directories larger than one listing buffer need several listing calls;
/// none may lose or repeat entries.
#[tokio::test(flavor = "multi_thread")]
async fn native_listing_spans_several_buffers() {
	let tmp = TempDir::new("big");
	let pad = "n".repeat(100);
	for i in 0..2500 {
		std::fs::write(tmp.0.join(format!("{pad}{i:05}")), b"").unwrap();
	}
	let fs = Fs::native();
	let mut s = fs.session();
	for detail in [Detail::Minimal, Detail::Full] {
		let dir = s.open_dir(&tmp.0).await.unwrap();
		let got = names(s.list(&dir, detail, 0).await.unwrap());
		assert_eq!(got.len(), 2500, "{detail:?}");
		assert!(got.is_sorted_by(|a, b| a.0 < b.0), "{detail:?}: duplicates");
		let dir = s.open_dir(&tmp.0).await.unwrap();
		let mut out = Listing::default();
		s.list_into(&dir, detail, 0, &mut out).await.unwrap();
		assert_eq!(out.len(), 2500);
	}
}

/// A symlink that replaced a listed directory is not followed by
/// `open_child`, while `open_dir` follows symlinks.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn open_child_refuses_symlink_that_replaced_dir() {
	let tmp = TempDir::new("swap");
	tmp.write("d/inner", b"");
	tmp.write("elsewhere/secret", b"");
	let fs = Fs::native();
	let mut s = fs.session();
	let dir = s.open_dir(&tmp.0).await.unwrap();
	assert!(
		s.list(&dir, Detail::Minimal, 0)
			.await
			.unwrap()
			.records()
			.iter()
			.any(|r| r.file_type == FileType::Dir)
	);
	std::fs::rename(tmp.0.join("d"), tmp.0.join("d-old")).unwrap();
	std::os::unix::fs::symlink(tmp.0.join("elsewhere"), tmp.0.join("d")).unwrap();
	assert!(s.open_child(&dir, b"d").await.is_err());
	assert!(s.open_dir(&tmp.0.join("d")).await.is_ok());
}

/// A tree for the confined-open tests: `root/a/b/file.txt` (`ok`), and next
/// to it a file link `root/a/b/flink` and a directory link `root/a/link`, both
/// inside the root, and a directory link `root/esc` to `outside/` (`secret`).
#[cfg(unix)]
fn linked_tree(tag: &str) -> TempDir {
	let tmp = TempDir::new(tag);
	tmp.write("root/a/b/file.txt", b"ok");
	tmp.write("outside/secret", b"secret");
	std::os::unix::fs::symlink("file.txt", tmp.0.join("root/a/b/flink")).unwrap();
	std::os::unix::fs::symlink("b", tmp.0.join("root/a/link")).unwrap();
	std::os::unix::fs::symlink(tmp.0.join("outside"), tmp.0.join("root/esc")).unwrap();
	tmp
}

/// Whether `err` refused a symlink on the way.
#[cfg(unix)]
fn refused_link(err: &io::Error) -> bool {
	matches!(err.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR))
}

/// Opens below a root reach regular files and directories but no symlink on
/// the way, inside the root or out of it, whether the kernel's confined open
/// or the portable component walk serves them; paths that are not
/// walk-relative are refused.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn opens_beneath_a_root_follow_no_symlink() {
	let tmp = linked_tree("beneath");
	let mut s = Fs::native().session();
	let root = s.open_dir(&tmp.0.join("root")).await.unwrap();
	let (mut file, info) = s.open_file_beneath(&root, b"a/b/file.txt").await.unwrap();
	assert_eq!(info.size, 2);
	let mut buf = Vec::new();
	file.read_into(&mut buf, 16).await.unwrap();
	assert_eq!(buf, b"ok");
	let dir = s.open_dir_beneath(&root, b"a/b").await.unwrap();
	assert_eq!(names(s.list(&dir, Detail::Minimal, 0).await.unwrap()), [
		("file.txt".to_owned(), FileType::File),
		("flink".to_owned(), FileType::Symlink),
	]);
	for rel in ["a/b/flink", "a/link/file.txt", "esc/secret"] {
		let err = s
			.open_file_beneath(&root, rel.as_bytes())
			.await
			.unwrap_err();
		assert!(refused_link(&err), "{rel}: {err:?}");
	}
	for rel in ["a/link", "esc"] {
		let err = s.open_dir_beneath(&root, rel.as_bytes()).await.unwrap_err();
		assert!(refused_link(&err), "{rel}: {err:?}");
	}
	assert!(is_not_regular(&s.open_file_beneath(&root, b"a/b").await.unwrap_err()));
	// A refused final symlink is a symlink refusal; a missing file is not.
	assert!(is_symlink_refusal(&s.open_file_beneath(&root, b"a/b/flink").await.unwrap_err()));
	assert!(!is_symlink_refusal(&s.open_file_beneath(&root, b"a/b/none").await.unwrap_err()));
	for rel in NOT_WALK_RELATIVE {
		let err = s
			.open_file_beneath(&root, rel.as_bytes())
			.await
			.unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{rel:?}");
	}

	// The component walk, which kernels without `openat2` get.
	let DirRepr::Native(handle) = &root.repr else {
		panic!("a native root");
	};
	let mut scratch = native::Scratch::default();
	assert!(native::open_beneath_walking(&mut scratch, handle, b"a/b/file.txt", false).is_ok());
	assert!(native::open_beneath_walking(&mut scratch, handle, b"a/b", true).is_ok());
	for (rel, dir) in [
		("a/b/flink", false),
		("a/link/file.txt", false),
		("esc/secret", false),
		("a/link", true),
		("esc", true),
	] {
		let err =
			native::open_beneath_walking(&mut scratch, handle, rel.as_bytes(), dir).unwrap_err();
		assert!(refused_link(&err), "{rel}: {err:?}");
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

/// Paths a confined call refuses as not walk-relative.
const NOT_WALK_RELATIVE: [&str; 6] =
	["", "/a/b/file.txt", "a//b/file.txt", "./a/b/file.txt", "a/../a/b/file.txt", "a/b/"];

/// Writes below a root rewrite a regular file in place, or create one, but
/// reach no symlink on the way or at the file, inside the root or out of it,
/// and change no link's target; special files are left alone without
/// blocking, and paths that are not walk-relative are refused.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn writes_beneath_a_root_follow_no_symlink() {
	use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
	let tmp = linked_tree("write-beneath");
	let mut s = Fs::native().session();
	let root = s.open_dir(&tmp.0.join("root")).await.unwrap();
	let file = tmp.0.join("root/a/b/file.txt");
	let ino = std::fs::metadata(&file).unwrap().ino();
	s.write_file_beneath(&root, b"a/b/file.txt", b"rewritten")
		.await
		.unwrap();
	assert_eq!(std::fs::read(&file).unwrap(), b"rewritten");
	assert_eq!(std::fs::metadata(&file).unwrap().ino(), ino, "rewritten in place");
	s.write_file_beneath(&root, b"a/b/file.txt", b"ok")
		.await
		.unwrap();
	assert_eq!(std::fs::read(&file).unwrap(), b"ok", "truncated before the write");
	s.write_file_beneath(&root, b"a/b/new.txt", b"new")
		.await
		.unwrap();
	s.write_file_beneath(&root, b"top.txt", b"top")
		.await
		.unwrap();
	assert_eq!(std::fs::read(tmp.0.join("root/a/b/new.txt")).unwrap(), b"new");
	assert_eq!(std::fs::read(tmp.0.join("root/top.txt")).unwrap(), b"top");

	std::os::unix::fs::symlink(tmp.0.join("outside/dangling"), tmp.0.join("root/a/b/dlink"))
		.unwrap();
	for rel in ["a/b/flink", "a/b/dlink", "a/link/file.txt", "esc/secret", "esc/planted"] {
		let err = s
			.write_file_beneath(&root, rel.as_bytes(), b"x")
			.await
			.unwrap_err();
		assert!(refused_link(&err), "{rel}: {err:?}");
	}
	assert_eq!(std::fs::read(&file).unwrap(), b"ok", "a link's target is untouched");
	assert_eq!(std::fs::read(tmp.0.join("outside/secret")).unwrap(), b"secret");
	assert!(!tmp.0.join("outside/planted").exists());
	assert!(!tmp.0.join("outside/dangling").exists());

	mkfifo(&tmp.0.join("root/a/fifo"));
	let err = s
		.write_file_beneath(&root, b"a/fifo", b"x")
		.await
		.unwrap_err();
	assert_eq!(err.raw_os_error(), Some(libc::ENXIO), "no reader: {err:?}");
	let _reader = std::fs::OpenOptions::new()
		.read(true)
		.custom_flags(libc::O_NONBLOCK)
		.open(tmp.0.join("root/a/fifo"))
		.unwrap();
	let err = s
		.write_file_beneath(&root, b"a/fifo", b"x")
		.await
		.unwrap_err();
	assert!(is_not_regular(&err), "with a reader: {err:?}");
	assert!(s.write_file_beneath(&root, b"a/b", b"x").await.is_err());
	assert!(tmp.0.join("root/a/b").is_dir());
	for rel in NOT_WALK_RELATIVE {
		let err = s
			.write_file_beneath(&root, rel.as_bytes(), b"x")
			.await
			.unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{rel:?}");
	}
}

/// Removals below a root remove the entry the path names, a symlink there
/// itself and never its target, but go through no symlink on the way,
/// inside the root or out of it; paths that are not walk-relative are
/// refused.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn removals_beneath_a_root_follow_no_symlink() {
	let tmp = linked_tree("remove-beneath");
	let mut s = Fs::native().session();
	let root = s.open_dir(&tmp.0.join("root")).await.unwrap();
	for rel in ["a/link/file.txt", "esc/secret"] {
		let err = s
			.remove_file_beneath(&root, rel.as_bytes())
			.await
			.unwrap_err();
		assert!(refused_link(&err), "{rel}: {err:?}");
	}
	for rel in ["a/link", "esc"] {
		let err = s
			.remove_dir_beneath(&root, rel.as_bytes())
			.await
			.unwrap_err();
		assert_eq!(err.raw_os_error(), Some(libc::ENOTDIR), "{rel}: {err:?}");
	}
	assert!(tmp.0.join("root/a/b/file.txt").exists());
	assert!(tmp.0.join("outside/secret").exists());

	for rel in ["a/b/flink", "a/link", "esc"] {
		s.remove_file_beneath(&root, rel.as_bytes()).await.unwrap();
		assert!(std::fs::symlink_metadata(tmp.0.join("root").join(rel)).is_err(), "{rel}");
	}
	assert!(tmp.0.join("root/a/b/file.txt").exists(), "a link's target stays");
	assert!(tmp.0.join("outside/secret").exists());

	assert!(s.remove_file_beneath(&root, b"a/b").await.is_err());
	let err = s.remove_dir_beneath(&root, b"a/b").await.unwrap_err();
	assert_eq!(err.kind(), io::ErrorKind::DirectoryNotEmpty, "{err:?}");
	s.remove_file_beneath(&root, b"a/b/file.txt").await.unwrap();
	s.remove_dir_beneath(&root, b"a/b").await.unwrap();
	s.remove_dir_beneath(&root, b"a").await.unwrap();
	assert!(!tmp.0.join("root/a").exists());
	for rel in NOT_WALK_RELATIVE {
		for dir in [false, true] {
			let err = s
				.remove_beneath(&root, rel.as_bytes(), dir)
				.await
				.unwrap_err();
			assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{rel:?}");
		}
	}
}

/// On Windows a directory symlink is a directory: `remove_file_beneath`
/// refuses it, as `std::fs::remove_file` does there, and `remove_dir_beneath`
/// removes the link itself, not its target, as `std::fs::remove_dir` does.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn windows_directory_links_are_removed_as_directories() {
	let tmp = TempDir::new("win-dir-link");
	tmp.write("root/target/keep.txt", b"keep");
	let link = tmp.0.join("root/link");
	if let Err(err) = std::os::windows::fs::symlink_dir(tmp.0.join("root/target"), &link) {
		eprintln!("UNKNOWN: no directory symlink could be made ({err}); the removal was not checked");
		return;
	}
	assert!(
		std::fs::remove_file(&link).is_err(),
		"std::fs::remove_file removed a directory symlink"
	);
	let mut s = Fs::native().session();
	let root = s.open_dir(&tmp.0.join("root")).await.unwrap();
	assert!(s.remove_file_beneath(&root, b"link").await.is_err());
	assert!(std::fs::symlink_metadata(&link).is_ok(), "the link was removed as a file");
	s.remove_dir_beneath(&root, b"link").await.unwrap();
	assert!(std::fs::symlink_metadata(&link).is_err(), "the link stays");
	assert!(tmp.0.join("root/target/keep.txt").exists(), "the link's target was removed");
}

/// On Windows a read-only file is removed, as `std::fs::remove_file` removes
/// one there.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn windows_read_only_files_are_removed() {
	let tmp = TempDir::new("win-read-only");
	for name in ["root/ours", "root/std"] {
		let path = tmp.write(name, b"x");
		let mut perms = std::fs::metadata(&path).unwrap().permissions();
		perms.set_readonly(true);
		std::fs::set_permissions(&path, perms).unwrap();
	}
	std::fs::remove_file(tmp.0.join("root/std")).expect("std removes a read-only file");
	let mut s = Fs::native().session();
	let root = s.open_dir(&tmp.0.join("root")).await.unwrap();
	s.remove_file_beneath(&root, b"ours").await.unwrap();
	assert!(std::fs::symlink_metadata(tmp.0.join("root/ours")).is_err(), "the file stays");
}

/// A listed file's open follows a symlink there only when asked to.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn open_file_at_follows_a_symlink_only_when_asked() {
	let tmp = linked_tree("file-at");
	let mut s = Fs::native().session();
	let dir = s.open_dir(&tmp.0.join("root/a/b")).await.unwrap();
	let err = s.open_file_at(&dir, b"flink", false).await.unwrap_err();
	assert_eq!(err.raw_os_error(), Some(libc::ELOOP), "{err:?}");
	let (_, info) = s.open_file_at(&dir, b"flink", true).await.unwrap();
	assert_eq!(info.size, 2);
}

/// Provider opens below a root, and of a listed name, refuse a final symlink
/// unless asked to follow it, and join raw names as URL segments.
#[tokio::test(flavor = "multi_thread")]
async fn provider_opens_refuse_a_final_symlink() {
	let (mem, vfs) = MemFs::with_files(&[("mem://root/dir/c%20d.txt", "hello")]);
	mem.add_symlink("mem://root/dir/flink", "mem://root/dir/c%20d.txt");
	mem.add_symlink("mem://root/link", "mem://root/dir");
	let root_path = Path::new("mem://root");
	let mut s = Fs::new(&vfs, root_path).session();
	let root = s.open_dir(root_path).await.unwrap();
	assert_eq!(
		s.open_file_beneath(&root, b"dir/c d.txt")
			.await
			.unwrap()
			.1
			.size,
		5
	);
	assert!(is_symlink_refusal(&s.open_file_beneath(&root, b"dir/flink").await.unwrap_err()));
	assert!(!is_symlink_refusal(&s.open_file_beneath(&root, b"dir/none").await.unwrap_err()));
	assert!(s.open_dir_beneath(&root, b"dir").await.is_ok());
	assert!(s.open_dir_beneath(&root, b"link").await.is_err());
	let err = s
		.open_file_beneath(&root, b"dir/../dir/c d.txt")
		.await
		.unwrap_err();
	assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
	let dir = s.open_child(&root, b"dir").await.unwrap();
	assert!(s.open_file_at(&dir, b"flink", false).await.is_err());
	assert_eq!(s.open_file_at(&dir, b"flink", true).await.unwrap().1.size, 5);
}

/// Provider writes below a root rewrite or create regular files and refuse a
/// final symlink and special files; removals remove the entry by path, a
/// symlink itself; paths that are not walk-relative are refused.
#[tokio::test(flavor = "multi_thread")]
async fn provider_writes_refuse_a_final_symlink() {
	let (mem, vfs) = MemFs::with_files(&[("mem://root/dir/c%20d.txt", "hello")]);
	mem.add_symlink("mem://root/dir/flink", "mem://root/dir/c%20d.txt");
	mem.add_fifo("mem://root/dir/fifo");
	let root_path = Path::new("mem://root");
	let mut s = Fs::new(&vfs, root_path).session();
	let root = s.open_dir(root_path).await.unwrap();
	s.write_file_beneath(&root, b"dir/c d.txt", b"rewritten")
		.await
		.unwrap();
	s.write_file_beneath(&root, b"dir/new", b"new")
		.await
		.unwrap();
	assert_eq!(vfs.read("mem://root/dir/c%20d.txt").await.unwrap(), b"rewritten");
	assert_eq!(vfs.read("mem://root/dir/new").await.unwrap(), b"new");
	let err = s
		.write_file_beneath(&root, b"dir/flink", b"x")
		.await
		.unwrap_err();
	assert!(err.to_string().contains("symbolic link"), "{err:?}");
	for rel in ["dir/fifo", "dir"] {
		let err = s
			.write_file_beneath(&root, rel.as_bytes(), b"x")
			.await
			.unwrap_err();
		assert!(is_not_regular(&err), "{rel}: {err:?}");
	}
	assert_eq!(vfs.read("mem://root/dir/c%20d.txt").await.unwrap(), b"rewritten");

	s.remove_file_beneath(&root, b"dir/flink").await.unwrap();
	assert!(vfs.symlink_metadata("mem://root/dir/flink").await.is_err());
	assert!(vfs.metadata("mem://root/dir/c%20d.txt").await.is_ok(), "the target stays");
	for rel in ["dir/c d.txt", "dir/new", "dir/fifo"] {
		s.remove_file_beneath(&root, rel.as_bytes()).await.unwrap();
	}
	s.remove_dir_beneath(&root, b"dir").await.unwrap();
	assert!(vfs.symlink_metadata("mem://root/dir").await.is_err());
	for rel in NOT_WALK_RELATIVE {
		let err = s
			.write_file_beneath(&root, rel.as_bytes(), b"x")
			.await
			.unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{rel:?}");
		let err = s
			.remove_file_beneath(&root, rel.as_bytes())
			.await
			.unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{rel:?}");
	}
}

/// Directories and FIFOs are rejected as not regular, and opening a FIFO
/// does not wait for a writer.
#[tokio::test(flavor = "multi_thread")]
async fn open_file_rejects_dirs_and_special_files() {
	let tmp = TempDir::new("special");
	tmp.write("dir/x", b"");
	let fs = Fs::native();
	let mut s = fs.session();
	let dir = s.open_dir(&tmp.0).await.unwrap();
	let err = s.open_file_at(&dir, b"dir", false).await.unwrap_err();
	assert!(is_not_regular(&err), "{err:?}");
	assert!(is_not_regular(&s.open_file(&tmp.0.join("dir")).await.unwrap_err()));
	let missing = s.open_file_at(&dir, b"missing", false).await.unwrap_err();
	assert_eq!(missing.kind(), io::ErrorKind::NotFound);
	assert!(!is_not_regular(&missing));
	#[cfg(unix)]
	{
		mkfifo(&tmp.0.join("fifo"));
		assert!(is_not_regular(&s.open_file_at(&dir, b"fifo", false).await.unwrap_err()));
		assert!(is_not_regular(&s.open_file(&tmp.0.join("fifo")).await.unwrap_err()));
	}
}

/// `read_into` honours the limit, stops at the open-time size, and reads
/// size-0 files to end of file; `File::read` streams the same bytes.
#[tokio::test(flavor = "multi_thread")]
async fn read_into_honours_limit_and_open_time_size() {
	let tmp = TempDir::new("read");
	let path = tmp.write("f", b"0123456789");
	tmp.write("empty", b"");
	let fs = Fs::native();
	let mut s = fs.session();
	let dir = s.open_dir(&tmp.0).await.unwrap();
	assert_eq!(read_all(&mut s, &dir, "f", 4).await.0, b"0123");
	let (data, info) = read_all(&mut s, &dir, "f", 1 << 20).await;
	assert_eq!((data.as_slice(), info.size), (&b"0123456789"[..], 10));

	// Growth after open is not read; a file empty at open is read to EOF.
	let (mut grown, _) = s.open_file_at(&dir, b"f", false).await.unwrap();
	let (mut was_empty, info) = s.open_file_at(&dir, b"empty", false).await.unwrap();
	assert_eq!(info.size, 0);
	std::fs::write(&path, b"0123456789abcdef").unwrap();
	std::fs::write(tmp.0.join("empty"), b"late").unwrap();
	let mut buf = b"stale".to_vec();
	grown.read_into(&mut buf, u64::MAX).await.unwrap();
	assert_eq!(buf, b"0123456789");
	was_empty.read_into(&mut buf, u64::MAX).await.unwrap();
	assert_eq!(buf, b"late");

	let (mut file, _) = s.open_file(&path).await.unwrap();
	let mut streamed = Vec::new();
	let mut chunk = [0u8; 4];
	loop {
		let n = file.read(&mut chunk).await.unwrap();
		if n == 0 {
			break;
		}
		streamed.extend_from_slice(&chunk[..n]);
	}
	assert_eq!(streamed, b"0123456789abcdef");
	assert_eq!(read_all(&mut s, &dir, "f", 0).await.0, b"");
}

/// `read_more` continues from the bytes already read without reading them
/// again, honours the limit in all, and stops at the open-time size, for
/// native and provider files.
#[tokio::test(flavor = "multi_thread")]
async fn read_more_continues_at_the_end_of_what_was_read() {
	let tmp = TempDir::new("read-more");
	let path = tmp.write("f", b"0123456789");
	let mut s = Fs::native().session();
	let dir = s.open_dir(&tmp.0).await.unwrap();
	let (mut file, _) = s.open_file_at(&dir, b"f", false).await.unwrap();
	let mut buf = Vec::new();
	file.read_into(&mut buf, 4).await.unwrap();
	assert_eq!(buf, b"0123");
	// Rewrite the file in place: the first four bytes are not read again, and
	// the growth past the open-time size is not read.
	std::fs::write(&path, b"abcdefghijklmnop").unwrap();
	file.read_more(&mut buf, 6).await.unwrap();
	assert_eq!(buf, b"0123ef");
	file.read_more(&mut buf, u64::MAX).await.unwrap();
	assert_eq!(buf, b"0123efghij");
	file.read_more(&mut buf, u64::MAX).await.unwrap();
	assert_eq!(buf, b"0123efghij");

	let (_mem, vfs) = MemFs::with_files(&[("mem://root/f", "0123456789")]);
	let mut s = Fs::Provider(vfs).session();
	let dir = s.open_dir(Path::new("mem://root")).await.unwrap();
	let (mut file, _) = s.open_file_at(&dir, b"f", false).await.unwrap();
	file.read_into(&mut buf, 3).await.unwrap();
	assert_eq!(buf, b"012");
	file.read_more(&mut buf, 7).await.unwrap();
	assert_eq!(buf, b"0123456");
	// A stream read moves the provider's position; `read_more` still
	// continues at `buf.len()`.
	let mut chunk = [0u8; 2];
	assert_eq!(file.read(&mut chunk).await.unwrap(), 2);
	file.read_more(&mut buf, u64::MAX).await.unwrap();
	assert_eq!(buf, b"0123456789");
}

/// Short reads continue until the open-time size, without a confirming
/// zero-length read once it is reached; size 0 reads until a zero-length
/// read.
#[test]
fn read_into_short_reads() {
	let source = b"abcdefghij";
	for (size, want_calls) in [(10, 4), (0, 5)] {
		let mut calls = 0;
		let mut buf = Vec::new();
		fill(&mut buf, size, u64::MAX, |buf, end| {
			calls += 1;
			let start = buf.len();
			let n = (end - start).min(3).min(source.len() - start);
			buf.extend_from_slice(&source[start..start + n]);
			Ok(n)
		})
		.unwrap();
		assert_eq!(buf, source, "size {size}");
		assert_eq!(calls, want_calls, "size {size}");
	}
	let mut buf = Vec::new();
	let mut interrupted = false;
	fill(&mut buf, 10, 6, |buf, end| {
		if !interrupted {
			interrupted = true;
			return Err(io::ErrorKind::Interrupted.into());
		}
		let start = buf.len();
		buf.extend_from_slice(&source[start..end]);
		Ok(end - start)
	})
	.unwrap();
	assert_eq!(buf, b"abcdef");
}

/// A size the allocator refuses fails the read with `OutOfMemory`, as
/// `std::fs::read` fails, instead of aborting the process; nothing is read.
#[test]
fn a_size_the_allocator_refuses_fails_with_out_of_memory() {
	let mut buf = Vec::new();
	let err =
		fill(&mut buf, 1 << 62, u64::MAX, |_, _| panic!("read before the reservation")).unwrap_err();
	assert_eq!(err.kind(), io::ErrorKind::OutOfMemory, "{err:?}");
	assert!(buf.is_empty());
}

/// A sparse file larger than memory fails `read_into` with `OutOfMemory`,
/// and the session reads the next file as before.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn reading_a_sparse_file_larger_than_memory_fails_with_out_of_memory() {
	let tmp = TempDir::new("huge");
	tmp.write("small", b"small");
	let huge = std::fs::File::create(tmp.0.join("huge")).unwrap();
	if let Err(err) = huge.set_len(1 << 50) {
		eprintln!(
			"UNKNOWN: no 1 PiB sparse file on this filesystem ({err}); the read was not checked"
		);
		return;
	}
	drop(huge);
	let mut s = Fs::native().session();
	let dir = s.open_dir(&tmp.0).await.unwrap();
	let (mut file, info) = s.open_file_at(&dir, b"huge", false).await.unwrap();
	assert_eq!(info.size, 1 << 50);
	let mut buf = Vec::new();
	let err = file.read_into(&mut buf, u64::MAX).await.unwrap_err();
	assert_eq!(err.kind(), io::ErrorKind::OutOfMemory, "{err:?}");
	assert_eq!(read_all(&mut s, &dir, "small", u64::MAX).await.0, b"small");
}

/// Pseudo files report size 0 yet have contents.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn read_into_reads_proc_pseudo_files() {
	let mut s = Fs::native().session();
	let (mut file, info) = s.open_file(Path::new("/proc/self/status")).await.unwrap();
	assert_eq!(info.size, 0);
	let mut buf = Vec::new();
	file.read_into(&mut buf, 1 << 20).await.unwrap();
	assert!(buf.starts_with(b"Name:"), "{}", String::from_utf8_lossy(&buf));
}

/// Stats follow symlinks only when asked; identities agree between path and
/// handle and across a symlink.
#[tokio::test(flavor = "multi_thread")]
async fn stat_and_identify() {
	let tmp = TempDir::new("stat");
	tmp.write("d/f", b"abc");
	let fs = Fs::native();
	let mut s = fs.session();
	let info = s.stat(&tmp.0.join("d/f"), true).await.unwrap();
	assert_eq!((info.file_type, info.size), (Some(FileType::File), 3));
	let dir = s.open_dir(&tmp.0.join("d")).await.unwrap();
	let id = s.identify(&tmp.0.join("d")).await.unwrap();
	assert!(id.native);
	assert_eq!(s.identify_dir(&dir).await.unwrap(), id);
	assert_eq!(
		s.stat_dir(&dir).await.unwrap().ino,
		s.stat(&tmp.0.join("d"), true).await.unwrap().stamp.ino
	);
	// A `.` component (fd's default `CWD/.` root) names the directory itself.
	assert_eq!(
		s.stat(&tmp.0.join("d").join("."), true)
			.await
			.unwrap()
			.file_type,
		Some(FileType::Dir)
	);
	#[cfg(unix)]
	{
		std::os::unix::fs::symlink(tmp.0.join("d"), tmp.0.join("l")).unwrap();
		assert_eq!(s.stat(&tmp.0.join("l"), false).await.unwrap().file_type, Some(FileType::Symlink));
		assert_eq!(s.stat(&tmp.0.join("l"), true).await.unwrap().file_type, Some(FileType::Dir));
		assert_eq!(s.identify(&tmp.0.join("l")).await.unwrap(), id);
	}
	assert_eq!(
		s.stat(&tmp.0.join("missing"), true)
			.await
			.unwrap_err()
			.kind(),
		io::ErrorKind::NotFound
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn join_host_paths() {
	let root = Path::new("/r");
	assert_eq!(Fs::native().join(root, b""), root);
	assert_eq!(Fs::native().join(root, b"a b/c"), root.join("a b").join("c"));
}

/// Provider listings and reads mirror native ones; raw names round-trip
/// through `Fs::join` as percent-encoded URL segments.
#[tokio::test(flavor = "multi_thread")]
async fn provider_lists_and_reads_url_trees() {
	let (mem, vfs) = MemFs::with_files(&[
		("mem://root/a%20b.txt", "hello"),
		("mem://root/dir/c.txt", "0123456789"),
	]);
	mem.add_symlink("mem://root/link", "mem://root/dir");
	mem.add_fifo("mem://root/fifo");
	let root = Path::new("mem://root");
	let fs = Fs::new(&vfs, root);
	assert!(!fs.is_native());
	let mut s = fs.session();
	let dir = s.open_dir(root).await.unwrap();
	let want = [
		("a b.txt".to_owned(), FileType::File),
		("dir".to_owned(), FileType::Dir),
		("link".to_owned(), FileType::Symlink),
	];
	assert_eq!(names(s.list(&dir, Detail::Minimal, 0).await.unwrap()), want);
	let listing = s.list(&dir, Detail::Full, 0).await.unwrap();
	let a = listing
		.records()
		.iter()
		.find(|r| listing.name(r) == b"a b.txt")
		.unwrap();
	assert_eq!(a.size, Some(5));
	assert!(a.mtime.is_some());

	let joined = fs.join(root, b"a b.txt");
	assert_eq!(joined, Path::new("mem://root/a%20b.txt"));
	assert_eq!(fs.join(root, b"dir/c.txt"), Path::new("mem://root/dir/c.txt"));
	let (mut file, info) = s.open_file(&joined).await.unwrap();
	assert_eq!(info.size, 5);
	let mut buf = Vec::new();
	file.read_into(&mut buf, 1 << 20).await.unwrap();
	assert_eq!(buf, b"hello");
	file.read_into(&mut buf, 3).await.unwrap();
	assert_eq!(buf, b"hel");
	assert_eq!(read_all(&mut s, &dir, "a b.txt", 2).await.0, b"he");

	assert!(is_not_regular(&s.open_file_at(&dir, b"dir", false).await.unwrap_err()));
	assert!(is_not_regular(&s.open_file_at(&dir, b"fifo", false).await.unwrap_err()));
	assert!(s.open_child(&dir, b"link").await.is_err());
	let child = s.open_child(&dir, b"dir").await.unwrap();
	let (data, _) = read_all(&mut s, &child, "c.txt", 4).await;
	assert_eq!(data, b"0123");
	let stamp = s.stat_dir(&child).await.unwrap();
	assert!(!s.stable_stamps(&child, &stamp));
	assert_eq!(
		s.stat(Path::new("mem://root/link"), false)
			.await
			.unwrap()
			.file_type,
		Some(FileType::Symlink)
	);
	let id = s.identify(Path::new("mem://root/link")).await.unwrap();
	assert!(!id.native);
	assert_eq!(s.identify_dir(&child).await.unwrap(), id);
}

/// Provider names that are not one path component fail the listing.
#[tokio::test(flavor = "multi_thread")]
async fn provider_rejects_invalid_entry_names() {
	let (_mem, vfs) = MemFs::with_files(&[("mem://bad/x%2Fy", "")]);
	let fs = Fs::Provider(vfs);
	let mut s = fs.session();
	let dir = s.open_dir(Path::new("mem://bad")).await.unwrap();
	let err = s.list(&dir, Detail::Minimal, 0).await.unwrap_err();
	assert_eq!(err.kind(), io::ErrorKind::InvalidData);
}

/// A directory from one filesystem kind is refused by another's session.
#[tokio::test(flavor = "multi_thread")]
async fn sessions_refuse_foreign_dirs() {
	let tmp = TempDir::new("foreign");
	let (_mem, vfs) = MemFs::with_files(&[("mem://r/a", "")]);
	let mut native = Fs::native().session();
	let mut provider = Fs::Provider(vfs).session();
	let host_dir = native.open_dir(&tmp.0).await.unwrap();
	let mem_dir = provider.open_dir(Path::new("mem://r")).await.unwrap();
	assert!(native.list(&mem_dir, Detail::Minimal, 0).await.is_err());
	assert!(provider.open_file_at(&host_dir, b"a", false).await.is_err());
}
