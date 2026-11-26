//! Regression tests for URL path handling, provider handle semantics, close
//! tracking, cancellation, and uucore canonicalization parity.

use std::{
	collections::BTreeMap,
	ffi::OsStr,
	io::{self, Read, Seek, SeekFrom, Write},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::Duration,
};

use async_trait::async_trait;
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use crate::*;

#[derive(Debug, Clone)]
enum Node {
	File(Arc<Mutex<Vec<u8>>>),
	Dir,
}

/// In-memory provider for `mem://`; every handle operation yields to the
/// runtime timer so synchronous callers must really drive the reactor.
#[derive(Debug)]
struct MemFs {
	nodes:  Mutex<BTreeMap<PathBuf, Node>>,
	closes: Arc<AtomicUsize>,
}

impl MemFs {
	fn new() -> Arc<Self> {
		let mut nodes = BTreeMap::new();
		nodes.insert(PathBuf::from("mem://"), Node::Dir);
		Arc::new(Self { nodes: Mutex::new(nodes), closes: Arc::default() })
	}
}

#[derive(Debug)]
struct MemHandle {
	data:   Arc<Mutex<Vec<u8>>>,
	pos:    Mutex<u64>,
	append: bool,
	closes: Arc<AtomicUsize>,
}

async fn tick() {
	tokio::time::sleep(Duration::from_millis(1)).await;
}

#[async_trait]
impl FileHandle for MemHandle {
	async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		tick().await;
		let data = self.data.lock();
		let mut pos = self.pos.lock();
		let start = (*pos as usize).min(data.len());
		let n = buf.len().min(data.len() - start);
		buf[..n].copy_from_slice(&data[start..start + n]);
		*pos += n as u64;
		Ok(n)
	}

	async fn write(&self, buf: &[u8]) -> io::Result<usize> {
		tick().await;
		let mut data = self.data.lock();
		let mut pos = self.pos.lock();
		if self.append {
			*pos = data.len() as u64;
		}
		let start = *pos as usize;
		if data.len() < start + buf.len() {
			data.resize(start + buf.len(), 0);
		}
		data[start..start + buf.len()].copy_from_slice(buf);
		*pos += buf.len() as u64;
		Ok(buf.len())
	}

	async fn seek(&self, seek: SeekFrom) -> io::Result<u64> {
		let len = self.data.lock().len() as i64;
		let mut pos = self.pos.lock();
		let next = match seek {
			SeekFrom::Start(n) => n as i64,
			SeekFrom::End(n) => len + n,
			SeekFrom::Current(n) => *pos as i64 + n,
		};
		*pos = u64::try_from(next).map_err(|_| invalid_argument())?;
		Ok(*pos)
	}

	async fn metadata(&self) -> io::Result<Metadata> {
		let len = self.data.lock().len() as u64;
		Ok(Metadata::new(FileType::from_kind(FileKind::File), len, Permissions::from_mode(0o644)))
	}

	async fn close(&self) -> io::Result<()> {
		tick().await;
		self.closes.fetch_add(1, Ordering::SeqCst);
		Ok(())
	}
}

fn not_found() -> io::Error {
	io::Error::from(io::ErrorKind::NotFound)
}

#[async_trait]
impl FileSystem for MemFs {
	async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<File> {
		let mut nodes = self.nodes.lock();
		let data = match nodes.get(path) {
			Some(_) if options.is_create_new() => {
				return Err(io::Error::from(io::ErrorKind::AlreadyExists));
			},
			Some(Node::Dir) => return Err(is_a_directory()),
			Some(Node::File(data)) => Arc::clone(data),
			None if options.is_create() || options.is_create_new() => {
				let parent = parent_path(path).ok_or_else(not_found)?;
				if !matches!(nodes.get(parent), Some(Node::Dir)) {
					return Err(not_found());
				}
				let data = Arc::new(Mutex::new(Vec::new()));
				nodes.insert(path.to_path_buf(), Node::File(Arc::clone(&data)));
				data
			},
			None => return Err(not_found()),
		};
		if options.is_truncate() {
			data.lock().clear();
		}
		Ok(File::from_handle(MemHandle {
			data,
			pos: Mutex::new(0),
			append: options.is_append(),
			closes: Arc::clone(&self.closes),
		}))
	}

	async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
		match self.nodes.lock().get(path).ok_or_else(not_found)? {
			Node::Dir => {
				Ok(Metadata::new(FileType::from_kind(FileKind::Dir), 0, Permissions::from_mode(0o755)))
			},
			Node::File(data) => Ok(Metadata::new(
				FileType::from_kind(FileKind::File),
				data.lock().len() as u64,
				Permissions::from_mode(0o644),
			)),
		}
	}

	async fn read_dir(&self, path: &Path) -> io::Result<ReadDir> {
		let nodes = self.nodes.lock();
		let entries: Vec<_> = nodes
			.iter()
			.filter(|(child, _)| child.as_path() != path && parent_path(child) == Some(path))
			.map(|(child, node)| {
				let kind = if matches!(node, Node::Dir) {
					FileKind::Dir
				} else {
					FileKind::File
				};
				let name = file_name(child).unwrap().to_os_string();
				Ok(DirEntry::new(child.clone(), name, Some(FileType::from_kind(kind))))
			})
			.collect();
		Ok(ReadDir::from_entries(entries))
	}

	async fn create_dir(&self, path: &Path, _mode: Option<u32>) -> io::Result<()> {
		let mut nodes = self.nodes.lock();
		if nodes.contains_key(path) {
			return Err(io::Error::from(io::ErrorKind::AlreadyExists));
		}
		if !matches!(parent_path(path).and_then(|parent| nodes.get(parent)), Some(Node::Dir)) {
			return Err(not_found());
		}
		nodes.insert(path.to_path_buf(), Node::Dir);
		Ok(())
	}

	async fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
		if url_scheme(to) != Some("mem") {
			return Err(crosses_devices());
		}
		let mut nodes = self.nodes.lock();
		let node = nodes.remove(from).ok_or_else(not_found)?;
		nodes.insert(to.to_path_buf(), node);
		Ok(())
	}
}

#[test]
fn url_lexical_helpers_keep_the_scheme_root() {
	let p = Path::new;
	assert_eq!(parent_path(p("local://out")), Some(p("local://")));
	assert_eq!(parent_path(p("skill://name/SKILL.md")), Some(p("skill://name")));
	assert_eq!(parent_path(p("skill://name/")), Some(p("skill://")));
	assert_eq!(parent_path(p("local://")), None);
	assert_eq!(parent_path(p("x")), Some(p("")));
	assert_eq!(file_name(p("local://out")).as_deref(), Some(OsStr::new("out")));
	assert_eq!(file_name(p("local://")), None);
	assert_eq!(with_file_name(p("local://a/b.txt"), "b.bak"), p("local://a/b.bak"));
	assert_eq!(with_file_name(p("local://b.txt"), "b.bak"), p("local://b.bak"));
	assert_eq!(join_path(p("local://"), p("a")), p("local://a"));
	assert_eq!(join_path(p("local://a"), p("b/c/")).as_os_str(), "local://a/b/c/");
	assert_eq!(join_path(p(""), p("x")), p("x"));
	assert_eq!(join_path(p("local://tmp"), p("")).as_os_str(), "local://tmp/");
	assert_eq!(absolute_path(p("/work"), p("local://a")), p("local://a"));
	assert_eq!(absolute_path(p("skill://s"), p("../t")), p("skill://s/../t"));
	assert_eq!(normalize_lexically(p("skill://s/../../t/./u/")), p("skill://t/u"));
	assert_eq!(normalize_lexically(p("local://..")), p("local://"));
	assert_eq!(relative_path(p("local://a/b/c"), p("local://a/d")), Some(PathBuf::from("../b/c")));
	assert_eq!(relative_path(p("local://a"), p("skill://a")), None);
	assert_eq!(relative_path(p("/x/y"), p("local://x")), None);
	assert_eq!(relative_path(p("/x/y"), p("/x/y")), Some(PathBuf::from(".")));
}

#[test]
fn raw_names_round_trip_through_url_segments() {
	let p = Path::new;
	let raw = OsStr::new("a?b#c% d\\e");
	let child = child_path(p("local://d"), raw);
	assert_eq!(child, p("local://d/a%3Fb%23c%25%20d%5Ce"));
	assert_eq!(file_name(&child).as_deref(), Some(raw));
	assert_eq!(join_path(p("local://d"), p("x y/z?")), p("local://d/x%20y/z%3F"));
	assert_eq!(with_file_name(&child, "n#1"), p("local://d/n%231"));
	// Typed absolute URLs are already spelled; nothing is re-encoded.
	assert_eq!(join_path(p("local://d"), p("local://a%3Fb")), p("local://a%3Fb"));
	assert_eq!(decode_segment(OsStr::new("100%")), OsStr::new("100%"));
	assert_eq!(child_path(p("/host"), raw), p("/host").join(raw));
	// Drive letters and single-letter schemes stay host paths.
	assert!(!is_virtual_path(p("C://x")));
	assert!(is_virtual_path(p("git+ssh://h/r")));
}

#[cfg(windows)]
#[test]
fn drive_relative_paths_resolve_against_the_shell_cwd_not_the_process_cwd() {
	let p = Path::new;
	let cwd = p(r"C:\Temp\probe");
	// Same drive: the remainder joins onto the shell cwd; `C:` is the cwd
	// itself.
	assert_eq!(absolute_path(cwd, p("C:")), cwd);
	assert_eq!(absolute_path(cwd, p("c:sub")), p(r"C:\Temp\probe\sub"));
	assert_eq!(join_path(p(r"\\?\C:\Temp\probe"), p("C:a")), p(r"\\?\C:\Temp\probe\a"));
	// Another drive (or a URL cwd) has no shell cwd: the drive root stands in.
	assert_eq!(absolute_path(cwd, p("D:sub")), p(r"D:\sub"));
	assert_eq!(absolute_path(p("local://d"), p("C:a")), p(r"C:\a"));
	// Rooted operands are unchanged.
	assert_eq!(absolute_path(cwd, p(r"D:\x")), p(r"D:\x"));
}

#[test]
fn native_backend_never_resolves_urls_against_the_process_cwd() {
	let fs = BlockingFs::native();
	let err = fs.create("vfs-kernel-test://x").unwrap_err();
	assert_eq!(err.kind(), io::ErrorKind::NotFound);
	assert!(!Path::new("vfs-kernel-test:").exists());
	assert!(!fs.exists("vfs-kernel-test://x"));
	assert!(!fs.is_native_local("vfs-kernel-test://x"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_handles_share_offsets_and_honour_open_flags() {
	let mem = MemFs::new();
	let fs = Fs::new(mem.clone()).blocking();
	tokio::task::spawn_blocking(move || {
		fs.write("mem://f", b"hello").unwrap();

		let err = fs
			.open_with("mem://f", OpenOptions::new().write(true).create_new(true))
			.unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);

		let a = fs.open("mem://f").unwrap();
		let b = a.try_clone().unwrap();
		let mut two = [0; 2];
		(&a).read_exact(&mut two).unwrap();
		let mut rest = String::new();
		(&b).read_to_string(&mut rest).unwrap();
		assert_eq!((&two, rest.as_str()), (b"he", "llo"));
		assert_eq!((&a).stream_position().unwrap(), 5);

		let mut appender = fs
			.open_with("mem://f", OpenOptions::new().append(true))
			.unwrap();
		appender.write_all(b"!").unwrap();
		appender.close().unwrap();
		assert_eq!(fs.read_to_string("mem://f").unwrap(), "hello!");

		fs.create("mem://f").unwrap().close().unwrap();
		assert_eq!(fs.metadata("mem://f").unwrap().len(), 0);

		let err = fs.rename("mem://f", "/tmp/elsewhere").unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::CrossesDevices);
	})
	.await
	.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_provider_files_close_in_background_and_drain() {
	let mem = MemFs::new();
	let fs = Fs::new(mem.clone());
	let file = fs.create("mem://log").await.unwrap();
	file.write_all_async(b"x").await.unwrap();
	let clone = file.try_clone().unwrap();
	drop(file);
	assert_eq!(mem.closes.load(Ordering::SeqCst), 0, "a live clone keeps the handle open");
	drop(clone);
	fs.drain_closes().await.unwrap();
	assert_eq!(mem.closes.load(Ordering::SeqCst), 1);

	let blocking = fs.blocking();
	let closes = Arc::clone(&mem.closes);
	tokio::task::spawn_blocking(move || {
		drop(blocking.open("mem://log").unwrap());
		blocking.drain_closes().unwrap();
		assert_eq!(closes.load(Ordering::SeqCst), 2);
	})
	.await
	.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_is_not_a_retryable_interrupt_and_close_still_runs() {
	let mem = MemFs::new();
	let token = CancellationToken::new();
	let fs = Fs::new(mem.clone()).with_cancellation(token.clone());
	let file = fs.create("mem://c").await.unwrap();
	token.cancel();

	let err = file.write_all_async(b"late").await.unwrap_err();
	assert!(is_cancelled(&err));
	assert_ne!(err.kind(), io::ErrorKind::Interrupted);
	assert!(is_cancelled(&fs.metadata("mem://c").await.unwrap_err()));

	file.close_async().await.unwrap();
	assert_eq!(mem.closes.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_canonicalize_stays_inside_the_url_root() {
	let fs = Fs::new(MemFs::new());
	fs.create_dir_all("mem://a/b").await.unwrap();
	let missing = CanonicalizeOptions::new(MissingHandling::Missing, ResolveMode::Physical);
	assert_eq!(
		fs.canonicalize_with("mem://a/./b/../../../x", &missing)
			.await
			.unwrap(),
		Path::new("mem://x")
	);
	assert_eq!(fs.canonicalize("mem://a/b/").await.unwrap(), Path::new("mem://a/b"));
	let err = fs.canonicalize("mem://a/nope/c").await.unwrap_err();
	assert_eq!(err.kind(), io::ErrorKind::NotFound);
}

struct TempDir(PathBuf);

impl TempDir {
	fn new(tag: &str) -> Self {
		let fs = BlockingFs::native();
		let path = fs
			.create_temp_dir(
				std::env::temp_dir(),
				&TempOptions::new().prefix(format!("pi-vfs-{tag}-")),
			)
			.unwrap();
		Self(std::fs::canonicalize(path).unwrap())
	}
}

impl Drop for TempDir {
	fn drop(&mut self) {
		let _ = std::fs::remove_dir_all(&self.0);
	}
}

#[cfg(windows)]
#[test]
fn native_path_metadata_matches_the_open_file_identity() {
	let dir = TempDir::new("identity");
	let path = dir.0.join("file");
	std::fs::write(&path, "content").unwrap();
	let fs = BlockingFs::native();
	let path_meta = fs.metadata(&path).unwrap();
	let file_meta = fs.open(&path).unwrap().metadata().unwrap();
	assert!(path_meta.same_file(&file_meta));
	assert_eq!(path_meta.len(), file_meta.len());
	let missing_identity =
		Metadata::native_with_handle(std::fs::metadata(&path).unwrap(), crate::native::HandleInfo {
			volume_serial: 1,
			file_index:    0,
			nlink:         1,
		});
	assert!(missing_identity.file_id().is_none());
	assert!(!missing_identity.same_file(&path_meta));
	let link = dir.0.join("link");
	if std::os::windows::fs::symlink_file("file", &link).is_ok() {
		assert!(fs.symlink_metadata(&link).unwrap().is_symlink());
		assert!(fs.metadata(&link).unwrap().same_file(&path_meta));
	}
}

#[cfg(unix)]
#[test]
fn native_canonicalize_matches_uucore_modes() {
	let dir = TempDir::new("canon");
	let fs = BlockingFs::native();
	let file = dir.0.join("file");
	std::fs::write(&file, "x").unwrap();
	std::os::unix::fs::symlink("loop-b", dir.0.join("loop-a")).unwrap();
	std::os::unix::fs::symlink("loop-a", dir.0.join("loop-b")).unwrap();
	std::os::unix::fs::symlink("file", dir.0.join("link")).unwrap();

	let opts = |missing| CanonicalizeOptions::new(missing, ResolveMode::Physical);
	assert_eq!(
		fs.canonicalize_with(dir.0.join("link"), &opts(MissingHandling::Existing))
			.unwrap(),
		file
	);
	// Normal: only the last component may be missing, and its parent must be a
	// directory.
	assert_eq!(
		fs.canonicalize_with(dir.0.join("new"), &opts(MissingHandling::Normal))
			.unwrap(),
		dir.0.join("new")
	);
	let err = fs
		.canonicalize_with(dir.0.join("file/new"), &opts(MissingHandling::Normal))
		.unwrap_err();
	assert_eq!(err.raw_os_error(), Some(libc::ENOTDIR));
	// A trailing slash demands a directory.
	let mut slashed = file.clone().into_os_string();
	slashed.push("/");
	let err = fs
		.canonicalize_with(&slashed, &opts(MissingHandling::Existing))
		.unwrap_err();
	assert_eq!(err.raw_os_error(), Some(libc::ENOTDIR));
	let err = fs
		.canonicalize_with(dir.0.join("loop-a"), &opts(MissingHandling::Missing))
		.unwrap_err();
	assert_eq!(err.to_string(), "Too many levels of symbolic links");
	assert_eq!(
		fs.canonicalize_with(
			dir.0.join("link/../file"),
			&CanonicalizeOptions::new(MissingHandling::Existing, ResolveMode::Logical)
		)
		.unwrap(),
		file
	);
}

/// A creation mask stands in for the process umask on host files,
/// directories, and temp files created through the facade, without touching
/// the process umask.
#[cfg(unix)]
#[test]
fn creation_mask_clears_bits_from_host_creations() {
	use std::os::unix::fs::PermissionsExt;

	let dir = TempDir::new("mask");
	let fs = Fs::native().with_creation_mask(Some(0o077)).blocking();
	let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;

	fs.create(dir.0.join("file")).unwrap();
	fs.create_dir(dir.0.join("dir")).unwrap();
	let (temp, _file) = fs
		.create_temp(&dir.0, &TempOptions::new().prefix("t").mode(0o644))
		.unwrap();
	assert_eq!(mode(&dir.0.join("file")), 0o600);
	assert_eq!(mode(&dir.0.join("dir")), 0o700);
	assert_eq!(mode(&temp), 0o600);

	// Opening an existing file never re-applies the mask.
	std::fs::set_permissions(dir.0.join("file"), std::fs::Permissions::from_mode(0o644)).unwrap();
	fs.open_with(dir.0.join("file"), OpenOptions::new().write(true).create(true))
		.unwrap();
	assert_eq!(mode(&dir.0.join("file")), 0o644);

	// A mask looser than the process umask keeps the bits the umask clears,
	// for every kind of entry, and for each directory a recursive create
	// makes.
	let loose = Fs::native().with_creation_mask(Some(0)).blocking();
	loose.create(dir.0.join("open")).unwrap();
	loose.create_dir(dir.0.join("loose")).unwrap();
	loose.create_dir_all(dir.0.join("deep/er")).unwrap();
	loose
		.make_node(dir.0.join("fifo"), crate::NodeKind::Fifo, 0o666)
		.unwrap();
	assert_eq!(mode(&dir.0.join("open")), 0o666);
	assert_eq!(mode(&dir.0.join("loose")), 0o777);
	assert_eq!(mode(&dir.0.join("deep")), 0o777);
	assert_eq!(mode(&dir.0.join("deep/er")), 0o777);
	assert_eq!(mode(&dir.0.join("fifo")), 0o666);
}

/// A creation mask applies as well to an open that creates through `O_CREAT`
/// among its custom flags (with `O_EXCL`, only a new file), whether it writes
/// or only reads: the new file gets exactly its mode less the mask, whatever
/// the process umask, and an existing file keeps its mode. One mask looser
/// than any process umask and one stricter, so the process umask cannot pass
/// for both.
#[cfg(unix)]
#[test]
fn creation_mask_applies_to_a_custom_o_creat() {
	use std::os::unix::fs::PermissionsExt;

	let dir = TempDir::new("mask-custom");
	let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
	let mut creat = OpenOptions::new();
	creat.write(true).custom_flags(libc::O_CREAT);
	let mut excl = OpenOptions::new();
	excl.write(true).custom_flags(libc::O_CREAT | libc::O_EXCL);
	let mut read_creat = OpenOptions::new();
	read_creat.read(true).custom_flags(libc::O_CREAT);
	let mut read_excl = OpenOptions::new();
	read_excl
		.read(true)
		.custom_flags(libc::O_CREAT | libc::O_EXCL);
	let cases = [
		("write, O_CREAT", &creat),
		("write, O_CREAT | O_EXCL", &excl),
		("read, O_CREAT", &read_creat),
		("read, O_CREAT | O_EXCL", &read_excl),
	];
	let mut wrong = Vec::new();
	for (mask, want) in [(0, 0o666), (0o077, 0o600)] {
		let fs = Fs::native().with_creation_mask(Some(mask)).blocking();
		for (index, (label, options)) in cases.into_iter().enumerate() {
			let path = dir.0.join(format!("new-{mask:o}-{index}"));
			match fs.open_with(&path, options) {
				Ok(_) => {
					let got = mode(&path);
					if got != want {
						wrong.push(format!("{label}, mask {mask:o}: mode {got:o}, not {want:o}"));
					}
				},
				Err(err) => wrong.push(format!("{label}, mask {mask:o}: {err} ({:?})", err.kind())),
			}
		}
	}
	// An existing file: `O_CREAT` opens it and keeps its mode, `O_EXCL`
	// refuses it.
	let fs = Fs::native().with_creation_mask(Some(0o077)).blocking();
	let existing = dir.0.join("existing");
	std::fs::write(&existing, "").unwrap();
	std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o644)).unwrap();
	fs.open_with(&existing, &creat).unwrap();
	assert_eq!(mode(&existing), 0o644, "O_CREAT on an existing file changed its mode");
	assert_eq!(
		fs.open_with(&existing, &excl)
			.map(drop)
			.map_err(|err| err.kind()),
		Err(io::ErrorKind::AlreadyExists),
		"O_CREAT | O_EXCL on an existing file"
	);
	assert!(wrong.is_empty(), "{wrong:#?}");
}

#[test]
fn descriptor_overlay_shares_the_pinned_file() {
	let dir = TempDir::new("mount");
	let path = dir.0.join("backing");
	std::fs::write(&path, "abcdef").unwrap();
	let pinned = File::from(std::fs::File::open(&path).unwrap());
	let fs = BlockingFs::native().mount_file("/dev/fd/77", pinned);

	let mut first = [0; 3];
	fs.open("/dev/fd/77")
		.unwrap()
		.read_exact(&mut first)
		.unwrap();
	let mut rest = String::new();
	fs.open("/dev/fd/77")
		.unwrap()
		.read_to_string(&mut rest)
		.unwrap();
	assert_eq!((&first, rest.as_str()), (b"abc", "def"));
	assert_eq!(fs.metadata("/dev/fd/77").unwrap().len(), 6);
	assert!(!fs.is_native_local("/dev/fd/77"));
	assert!(fs.remove_file("/dev/fd/77").is_err());
	assert!(path.exists());
}

/// A host file opened through a cancelled view fails its reads with the
/// cancellation error, never `Interrupted` (which std read loops retry
/// forever); so does a whole-file `read`. The same file through a view
/// without a token reads as before, and a whole-file read through a
/// cancellable view is still one allocation of the file's size.
#[test]
fn host_reads_through_a_cancelled_view_fail_with_the_cancellation_error() {
	let dir = TempDir::new("host-cancel");
	let path = dir.0.join("data");
	std::fs::write(&path, vec![b'x'; 300_000]).unwrap();
	let token = CancellationToken::new();
	let plain = BlockingFs::native();
	let scoped = plain.with_cancellation(token.clone());

	let mut contents = Vec::new();
	scoped
		.open(&path)
		.unwrap()
		.read_to_end(&mut contents)
		.unwrap();
	assert_eq!(contents.len(), 300_000);
	assert_eq!(contents.capacity(), 300_000, "sized from the file, not grown by doubling");
	assert_eq!(scoped.read(&path).unwrap().len(), 300_000);

	let mut opened_before = scoped.open(&path).unwrap();
	token.cancel();
	let errors = [
		opened_before.read(&mut [0; 8]).unwrap_err(),
		scoped
			.open(&path)
			.unwrap()
			.read_to_end(&mut Vec::new())
			.unwrap_err(),
		scoped.read(&path).unwrap_err(),
	];
	for err in errors {
		assert!(is_cancelled(&err), "{err}");
		assert_ne!(err.kind(), io::ErrorKind::Interrupted);
	}

	assert_eq!(plain.read(&path).unwrap().len(), 300_000);
	let mut text = String::new();
	plain
		.open(&path)
		.unwrap()
		.read_to_string(&mut text)
		.unwrap();
	assert_eq!(text.len(), 300_000);
}

/// A FIFO open about to start on this thread, for another thread to act on
/// (connect the other end, cancel the open) once the open waits.
///
/// On Linux the open runs through [`OpenMark::run`] on one CPU fewer than
/// this thread has, one such open at a time ([`MARKED_OPENS`]). A new thread
/// starts on the CPUs of the thread that starts it, and only the helpers of
/// such opens run on exactly those; the helpers of earlier ones (left in
/// `open` by a cancel nothing could release) started before [`Self::new`].
/// So the open's helper is the one thread started since that does, whatever
/// its name. Without CPUs to mark it by (one CPU, or a CPU change that is
/// refused or does not hold), the wait is the time it was.
#[cfg(unix)]
struct FifoOpenWait {
	/// The opening thread.
	#[cfg(target_os = "linux")]
	opener: libc::pid_t,
	/// The threads alive before the open: its helper is not among them.
	#[cfg(target_os = "linux")]
	before: Vec<libc::pid_t>,
	/// The CPUs the open runs on; `None` when this thread has one CPU or may
	/// not change its CPUs.
	#[cfg(target_os = "linux")]
	marked: Option<libc::cpu_set_t>,
}

/// Lets one marked FIFO open run at a time: opens of tests that run at once
/// would get the same CPUs.
#[cfg(target_os = "linux")]
static MARKED_OPENS: Mutex<()> = Mutex::new(());

/// Runs the open of a [`FifoOpenWait`] on the CPUs that mark its helper.
#[cfg(unix)]
struct OpenMark {
	/// The opening thread's CPUs, and the open's.
	#[cfg(target_os = "linux")]
	cpus:           Option<(libc::cpu_set_t, libc::cpu_set_t)>,
	/// Held from [`FifoOpenWait::new`] until the opening thread has its own
	/// CPUs back.
	#[cfg(target_os = "linux")]
	_one_at_a_time: parking_lot::MutexGuard<'static, ()>,
}

#[cfg(target_os = "linux")]
impl FifoOpenWait {
	/// Taken on the thread that is about to open the FIFO.
	fn new() -> (Self, OpenMark) {
		let one_at_a_time = MARKED_OPENS.lock();
		let cpus = cpus_of(0).and_then(|all| {
			let marked = less_one_cpu(&all)?;
			// The change must hold: it is undone at once, and made again for
			// the open.
			let holds = set_cpus(&marked) && cpus_of(0).is_some_and(|now| same_cpus(&now, &marked));
			// A thread this one starts next must not inherit the marked CPUs.
			assert!(set_cpus(&all), "could not give this thread its CPUs back");
			holds.then_some((all, marked))
		});
		let wait = Self {
			opener: current_thread_id(),
			before: thread_ids(),
			marked: cpus.map(|(_, marked)| marked),
		};
		(wait, OpenMark { cpus, _one_at_a_time: one_at_a_time })
	}

	/// Whether thread `tid` may be the open's helper: started since
	/// [`Self::new`], on the open's CPUs, `marked`.
	fn is_helper(&self, tid: libc::pid_t, marked: &libc::cpu_set_t) -> bool {
		!self.before.contains(&tid) && cpus_of(tid).is_some_and(|cpus| same_cpus(&cpus, marked))
	}
}

#[cfg(all(unix, not(target_os = "linux")))]
impl FifoOpenWait {
	/// Taken on the thread that is about to open the FIFO.
	const fn new() -> (Self, OpenMark) {
		(Self {}, OpenMark {})
	}
}

#[cfg(unix)]
#[cfg_attr(
	not(target_os = "linux"),
	allow(clippy::unused_self, reason = "without /proc the waits are fixed times")
)]
impl FifoOpenWait {
	/// Returns once the open waits for the other end: the opener sleeps, and
	/// so does the open's helper (in its `open`). Without `/proc`, or without
	/// CPUs to mark the helper by, after 150 ms instead.
	fn wait(&self) {
		#[cfg(target_os = "linux")]
		if let Some(marked) = &self.marked {
			wait_for("the FIFO open waiting for the other end", || {
				asleep(self.opener)
					&& thread_ids()
						.into_iter()
						.any(|tid| self.is_helper(tid, marked) && asleep(tid))
			});
			return;
		}
		#[cfg(target_os = "linux")]
		eprintln!("no CPUs to mark the FIFO open's helper by: waiting 150 ms instead");
		std::thread::sleep(Duration::from_millis(150));
	}

	/// Returns once the opener has read every byte written to `fifo` (this
	/// thread's end) and sleeps, waiting for more. Without `/proc`, after
	/// 200 ms instead.
	fn wait_until_drained(&self, fifo: &std::fs::File) {
		#[cfg(target_os = "linux")]
		wait_for("the reader waiting for more after reading everything", || {
			unread(fifo) == 0 && asleep(self.opener)
		});
		#[cfg(not(target_os = "linux"))]
		{
			let _ = fifo;
			std::thread::sleep(Duration::from_millis(200));
		}
	}
}

#[cfg(unix)]
#[cfg_attr(
	not(target_os = "linux"),
	allow(clippy::unused_self, reason = "without /proc no CPUs mark the helper")
)]
impl OpenMark {
	/// Runs `open`, the FIFO open, on the CPUs that mark its helper; the
	/// opening thread gets its own back once `open` returns.
	fn run<T>(self, open: impl FnOnce() -> T) -> T {
		#[cfg(target_os = "linux")]
		if let Some((_, marked)) = &self.cpus {
			assert!(set_cpus(marked), "sched_setaffinity: {}", io::Error::last_os_error());
		}
		open()
	}
}

#[cfg(target_os = "linux")]
impl Drop for OpenMark {
	/// Gives the opening thread its own CPUs back, before the next marked
	/// open may start.
	fn drop(&mut self) {
		if let Some((all, _)) = &self.cpus
			&& !set_cpus(all)
			&& !std::thread::panicking()
		{
			panic!("could not give the opening thread its CPUs back: {}", io::Error::last_os_error());
		}
	}
}

/// Whether a thread named `name` sleeps within three seconds, polled with
/// pauses from 1 ms up to 20 ms on the runtime's timer. Without `/proc`,
/// `true` after 200 ms instead.
#[cfg(unix)]
async fn named_thread_sleeps(name: &str) -> bool {
	#[cfg(target_os = "linux")]
	{
		let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
		let named_asleep = |tid: libc::pid_t| thread_name(tid) == name && asleep(tid);
		let mut backoff = Backoff::new();
		while !thread_ids().into_iter().any(named_asleep) {
			if tokio::time::Instant::now() >= deadline {
				return false;
			}
			tokio::time::sleep(backoff.pause()).await;
		}
		true
	}
	#[cfg(not(target_os = "linux"))]
	{
		let _ = name;
		tokio::time::sleep(Duration::from_millis(200)).await;
		true
	}
}

/// The id of the calling thread.
#[cfg(target_os = "linux")]
fn current_thread_id() -> libc::pid_t {
	// SAFETY: `gettid` has no preconditions.
	unsafe { libc::gettid() }
}

/// The ids of this process's threads.
#[cfg(target_os = "linux")]
fn thread_ids() -> Vec<libc::pid_t> {
	std::fs::read_dir("/proc/self/task")
		.unwrap()
		.filter_map(|entry| entry.unwrap().file_name().to_str()?.parse().ok())
		.collect()
}

/// The name of this process's thread `tid`; empty once it has exited.
#[cfg(target_os = "linux")]
fn thread_name(tid: libc::pid_t) -> String {
	let comm = std::fs::read_to_string(format!("/proc/self/task/{tid}/comm")).unwrap_or_default();
	comm.trim_end().to_owned()
}

/// Whether this process's thread `tid` sleeps (state `S`), as a thread that
/// waits in a call or is parked does.
#[cfg(target_os = "linux")]
fn asleep(tid: libc::pid_t) -> bool {
	let stat = std::fs::read_to_string(format!("/proc/self/task/{tid}/stat")).unwrap_or_default();
	// The name, in parentheses, may hold anything: the state follows the last
	// `)`.
	stat
		.rsplit_once(')')
		.is_some_and(|(_, rest)| rest.trim_start().starts_with('S'))
}

/// The CPUs this process's thread `tid` may run on (`0`: the calling
/// thread); `None` when they cannot be read.
#[cfg(target_os = "linux")]
fn cpus_of(tid: libc::pid_t) -> Option<libc::cpu_set_t> {
	// SAFETY: a `cpu_set_t` is plain bits; all zeros is the empty set.
	let mut cpus: libc::cpu_set_t = unsafe { std::mem::zeroed() };
	// SAFETY: `cpus` is valid for writes of one `cpu_set_t` for the call.
	let read = unsafe { libc::sched_getaffinity(tid, size_of::<libc::cpu_set_t>(), &raw mut cpus) };
	(read == 0).then_some(cpus)
}

/// Lets the calling thread run on `cpus` only; `false` when it may not.
#[cfg(target_os = "linux")]
fn set_cpus(cpus: &libc::cpu_set_t) -> bool {
	// SAFETY: `cpus` is valid for reads of one `cpu_set_t` for the call.
	unsafe { libc::sched_setaffinity(0, size_of::<libc::cpu_set_t>(), cpus) == 0 }
}

/// Whether `a` and `b` hold the same CPUs.
#[cfg(target_os = "linux")]
fn same_cpus(a: &libc::cpu_set_t, b: &libc::cpu_set_t) -> bool {
	// SAFETY: `CPU_EQUAL` only reads both sets.
	unsafe { libc::CPU_EQUAL(a, b) }
}

/// `all` without its lowest CPU; `None` when that leaves none.
#[cfg(target_os = "linux")]
fn less_one_cpu(all: &libc::cpu_set_t) -> Option<libc::cpu_set_t> {
	let bits = 8 * size_of::<libc::cpu_set_t>();
	// SAFETY: `CPU_ISSET` only reads `all`, at a bit within it.
	let lowest = (0..bits).find(|&cpu| unsafe { libc::CPU_ISSET(cpu, all) })?;
	let mut less = *all;
	// SAFETY: `lowest` is a bit within `less`.
	unsafe { libc::CPU_CLR(lowest, &mut less) };
	// SAFETY: `CPU_COUNT` only reads `less`.
	(unsafe { libc::CPU_COUNT(&less) } > 0).then_some(less)
}

/// Bytes written to the pipe or FIFO of `file` and not read yet.
#[cfg(target_os = "linux")]
fn unread(file: &std::fs::File) -> libc::c_int {
	use std::os::fd::AsRawFd;
	let mut bytes: libc::c_int = 0;
	// SAFETY: `FIONREAD` stores one `int` through the pointer, valid for the
	// call; the descriptor is borrowed from `file` for the call.
	let done = unsafe { libc::ioctl(file.as_raw_fd(), libc::FIONREAD, &raw mut bytes) };
	assert_eq!(done, 0, "FIONREAD: {}", io::Error::last_os_error());
	bytes
}

/// Polls `ready` until it holds, with pauses from 1 ms up to 20 ms; fails
/// after 20 seconds, naming `what` it never saw.
#[cfg(target_os = "linux")]
fn wait_for(what: &str, mut ready: impl FnMut() -> bool) {
	let deadline = std::time::Instant::now() + Duration::from_secs(20);
	let mut backoff = Backoff::new();
	while !ready() {
		assert!(std::time::Instant::now() < deadline, "never saw {what}");
		std::thread::sleep(backoff.pause());
	}
}

/// The pauses between the checks of a wait only polling can see: 1 ms at
/// first, twice as long after each failed check, and at most 20 ms, so a
/// long wait costs almost no CPU.
#[cfg(target_os = "linux")]
struct Backoff(Duration);

#[cfg(target_os = "linux")]
impl Backoff {
	const fn new() -> Self {
		Self(Duration::from_millis(1))
	}

	/// The pause before the next check; it doubles the one after, up to
	/// 20 ms.
	fn pause(&mut self) -> Duration {
		let pause = self.0;
		self.0 = (pause * 2).min(Duration::from_millis(20));
		pause
	}
}

/// Through a cancellable view, opening a FIFO waits for a writer as a
/// blocking open does, so even a reader of the bare descriptor (an external
/// child, `$(< f)`) gets a late writer's data. When no writer comes, the open
/// fails once the token fires and leaves no reader behind for a later writer.
#[cfg(unix)]
#[test]
fn fifo_opens_through_a_cancellable_view_wait_for_a_writer_and_observe_the_token() {
	use std::os::unix::fs::OpenOptionsExt;
	let dir = TempDir::new("fifo-cancel");
	let fifo = dir.0.join("fifo");
	BlockingFs::native()
		.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
		.unwrap();
	let token = CancellationToken::new();
	let scoped = BlockingFs::native().with_cancellation(token.clone());

	let writer_path = fifo.clone();
	let (open, mark) = FifoOpenWait::new();
	let writer = std::thread::spawn(move || {
		// A late writer: it comes once the open waits for it.
		open.wait();
		std::fs::write(writer_path, "hi").unwrap();
	});
	let opened = mark.run(|| scoped.open(&fifo)).unwrap();
	let mut descriptor = opened.native().unwrap();
	let mut text = String::new();
	descriptor.read_to_string(&mut text).unwrap();
	writer.join().unwrap();
	assert_eq!(text, "hi");
	drop(opened);

	let (open, mark) = FifoOpenWait::new();
	let canceller = std::thread::spawn(move || {
		// The cancel comes once the open waits for a writer.
		open.wait();
		token.cancel();
	});
	let started = std::time::Instant::now();
	let err = mark.run(|| scoped.open(&fifo)).unwrap_err();
	canceller.join().unwrap();
	assert!(is_cancelled(&err), "{err}");
	assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
	let late_writer = std::fs::OpenOptions::new()
		.write(true)
		.custom_flags(libc::O_NONBLOCK)
		.open(&fifo)
		.unwrap_err();
	assert_eq!(late_writer.raw_os_error(), Some(libc::ENXIO), "a reader was left open");
}

/// A cancel releases a waiting FIFO open by opening the FIFO for writing,
/// which this process may not do to a FIFO it can only read. Such an open
/// must still return as a blocking open does: as soon as a writer connects,
/// before it writes (a producer may wait for the consumer to act first). It
/// hands back a blocking descriptor that reads all of the writer's data, and
/// a cancel still ends the open.
#[cfg(unix)]
#[test]
fn fifo_this_process_cannot_write_still_opens_on_connect_and_observes_the_token() {
	use std::{
		io::Write,
		os::unix::{ffi::OsStrExt, fs::PermissionsExt},
		sync::mpsc,
	};
	let set_mode = |path: &std::path::Path, mode: u32| {
		std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
	};
	let dir = TempDir::new("fifo-read-only");
	let fifo = dir.0.join("fifo");
	BlockingFs::native()
		.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
		.unwrap();
	set_mode(&fifo, 0o400);
	let c_path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
	// SAFETY: `c_path` is a NUL-terminated string alive for the call.
	if unsafe { libc::faccessat(libc::AT_FDCWD, c_path.as_ptr(), libc::W_OK, libc::AT_EACCESS) } == 0
	{
		eprintln!(
			"skipped: this process may write a mode 0400 FIFO (root), so the case cannot arise"
		);
		return;
	}
	let token = CancellationToken::new();
	let scoped = BlockingFs::native().with_cancellation(token.clone());

	// The writer connects once the open waits for it, writes only once the
	// reader's open has returned, and holds its second write until the reader
	// has read the first and waits for more, so a descriptor left
	// non-blocking fails that read with `WouldBlock`.
	let (opened_tx, opened_rx) = mpsc::channel::<()>();
	let writer_path = fifo.clone();
	let (open, mark) = FifoOpenWait::new();
	let writer = std::thread::spawn(move || {
		open.wait();
		set_mode(&writer_path, 0o600);
		let mut file = std::fs::OpenOptions::new()
			.write(true)
			.open(&writer_path)
			.unwrap();
		set_mode(&writer_path, 0o400);
		let waited = opened_rx.recv_timeout(Duration::from_secs(2));
		file.write_all(b"h").unwrap();
		open.wait_until_drained(&file);
		file.write_all(b"i").unwrap();
		waited
	});
	let opened = mark.run(|| scoped.open(&fifo)).unwrap();
	let _ = opened_tx.send(());
	let mut descriptor = opened.native().unwrap();
	let mut text = String::new();
	descriptor.read_to_string(&mut text).unwrap();
	let waited = writer.join().unwrap();
	assert!(waited.is_ok(), "the open waited for the writer's first byte, not its connection");
	assert_eq!(text, "hi");
	drop(opened);

	let (open, mark) = FifoOpenWait::new();
	let canceller = std::thread::spawn(move || {
		// The cancel comes once the open waits for a writer.
		open.wait();
		token.cancel();
	});
	let started = std::time::Instant::now();
	let err = mark.run(|| scoped.open(&fifo)).unwrap_err();
	canceller.join().unwrap();
	assert!(is_cancelled(&err), "{err}");
	assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
}

/// An async whole-file read of a host file under a token can wait without
/// yielding: `Fs::read` for a FIFO's writer that never comes,
/// `File::read_to_end_async` for data from a writer that connected and never
/// writes. On a current-thread runtime the task that cancels the token then
/// never ran, so the read never ended. Both end at the token now.
#[cfg(unix)]
#[test]
fn async_whole_file_reads_end_at_the_token_on_a_current_thread_runtime() {
	use std::sync::mpsc;
	let dir = TempDir::new("fifo-current-thread");
	let fifo = dir.0.join("fifo");
	BlockingFs::native()
		.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
		.unwrap();

	for idle_writer in [false, true] {
		let token = CancellationToken::new();
		let writer = idle_writer.then(|| {
			let path = fifo.clone();
			std::thread::spawn(move || std::fs::OpenOptions::new().write(true).open(path).unwrap())
		});
		let (done_tx, done_rx) = mpsc::channel();
		let (path, task_token) = (fifo.clone(), token.clone());
		// The runtime's blocking pool, where the read waits, by a name of its
		// own.
		let pool = format!("fifo-read-{}", u8::from(idle_writer));
		std::thread::spawn(move || {
			let runtime = tokio::runtime::Builder::new_current_thread()
				.enable_all()
				.thread_name(pool.clone())
				.build()
				.unwrap();
			let result = runtime.block_on(async move {
				let fs = Fs::native().with_cancellation(task_token.clone());
				let canceller = tokio::spawn(async move {
					// The cancel comes once the read waits on the blocking pool,
					// for the writer or for its data.
					let waited = named_thread_sleeps(&pool).await;
					task_token.cancel();
					waited
				});
				let read = async {
					if idle_writer {
						fs.open(&path)
							.await?
							.read_to_end_async(&mut Vec::new())
							.await
					} else {
						fs.read(&path).await.map(|contents| contents.len())
					}
				}
				.await;
				(read, canceller.await.unwrap())
			});
			let _ = done_tx.send(result);
		});
		let result = done_rx.recv_timeout(Duration::from_secs(5));
		// Ends a read that ignored the runtime's cancellation.
		token.cancel();
		if let Some(writer) = writer {
			drop(writer.join().unwrap());
		}
		let (read, waited) =
			result.unwrap_or_else(|_| panic!("idle_writer={idle_writer}: the read ignored its token"));
		assert!(waited, "idle_writer={idle_writer}: the read was never seen waiting");
		let err = read.unwrap_err();
		assert!(is_cancelled(&err), "idle_writer={idle_writer}: {err}");
	}
}

/// `Fs::write` to a host FIFO waits for room while the reader drains it.
/// On a current-thread runtime that reader is a task on the same thread, so
/// a write inline in the async fn holds the only thread and the reader never
/// runs: the write must run off the runtime worker.
#[cfg(unix)]
#[test]
fn async_write_to_a_fifo_lets_a_reader_on_the_same_runtime_drain_it() {
	use std::{io::Read as _, os::unix::fs::OpenOptionsExt as _, sync::mpsc};

	const TOTAL: usize = 1 << 20;
	let dir = TempDir::new("fifo-async-write");
	let fifo = dir.0.join("fifo");
	BlockingFs::native()
		.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
		.unwrap();
	let reader = std::fs::OpenOptions::new()
		.read(true)
		.custom_flags(libc::O_NONBLOCK)
		.open(&fifo)
		.unwrap();
	let (done_tx, done_rx) = mpsc::channel();
	let path = fifo;
	std::thread::spawn(move || {
		let runtime = tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()
			.unwrap();
		let result = runtime.block_on(async move {
			let drain = async {
				let mut reader = reader;
				let mut got = 0;
				let mut buf = vec![0; 64 << 10];
				// A non-blocking FIFO read gives 0 until a writer opens, and
				// would-block once one has: both mean "not yet" until all of
				// it arrived. The reader stays open throughout, so the write's
				// open finds it.
				while got < TOTAL {
					match reader.read(&mut buf) {
						Ok(n) if n > 0 => got += n,
						Ok(_) => tokio::time::sleep(Duration::from_millis(1)).await,
						Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
							tokio::time::sleep(Duration::from_millis(1)).await;
						},
						Err(e) => panic!("{e}"),
					}
				}
				got
			};
			let fs = Fs::native();
			let (written, got) = tokio::join!(fs.write(&path, vec![b'x'; TOTAL]), drain);
			written.map(|()| got)
		});
		let _ = done_tx.send(result);
	});
	let got = done_rx
		.recv_timeout(Duration::from_secs(10))
		.expect("DEADLINE fired: the FIFO write held the runtime's only thread")
		.unwrap();
	assert_eq!(got, TOTAL);
}

/// A FIFO opened non-blocking (`dd iflag=nonblock`) must read without
/// waiting. On Linux such a FIFO with no writer reports no readiness, so a
/// read that first waited for readiness blocked until the token fired
/// instead of returning EOF at once.
#[cfg(unix)]
#[test]
fn fifo_opened_non_blocking_reads_without_waiting() {
	let dir = TempDir::new("fifo-nonblock");
	let fifo = dir.0.join("fifo");
	BlockingFs::native()
		.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
		.unwrap();
	let token = CancellationToken::new();
	let scoped = BlockingFs::native().with_cancellation(token.clone());
	let mut options = OpenOptions::new();
	options.read(true).custom_flags(libc::O_NONBLOCK);
	let mut file = scoped.open_with(&fifo, &options).unwrap();

	// Ends a read that waits for readiness, two seconds in; a read that has
	// returned ends this wait at once.
	let (returned_tx, returned_rx) = std::sync::mpsc::channel::<()>();
	let canceller = std::thread::spawn(move || {
		let _ = returned_rx.recv_timeout(Duration::from_secs(2));
		token.cancel();
	});
	let started = std::time::Instant::now();
	let read = file.read(&mut [0; 8]);
	let elapsed = started.elapsed();
	drop(returned_tx);
	assert_eq!(read.ok(), Some(0), "EOF at once");
	assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
	canceller.join().unwrap();
}

/// A write-only open of a FIFO (`echo hi > f`) waits for a reader. Through a
/// cancellable view it still hands the reader its data, and with no reader it
/// fails once the token fires. With mode 0600 a non-blocking read open
/// releases the wait, so no writer is left behind: a later reader reads EOF at
/// once instead of waiting. Mode 0200, which this process may not read,
/// cannot be released, and the open still ends.
#[cfg(unix)]
#[test]
fn fifo_write_opens_through_a_cancellable_view_wait_for_a_reader_and_observe_the_token() {
	use std::os::unix::{
		ffi::OsStrExt,
		fs::{OpenOptionsExt, PermissionsExt},
	};
	for mode in [0o600, 0o200] {
		let dir = TempDir::new("fifo-write");
		let fifo = dir.0.join("fifo");
		BlockingFs::native()
			.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
			.unwrap();
		std::fs::set_permissions(&fifo, std::fs::Permissions::from_mode(mode)).unwrap();
		let c_path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
		// SAFETY: `c_path` is a NUL-terminated string alive for the call.
		let readable =
			unsafe { libc::faccessat(libc::AT_FDCWD, c_path.as_ptr(), libc::R_OK, libc::AT_EACCESS) }
				== 0;
		if mode == 0o200 && readable {
			eprintln!("skipped mode 0200: this process may read it (root), so the case cannot arise");
			continue;
		}
		let token = CancellationToken::new();
		let scoped = BlockingFs::native().with_cancellation(token.clone());
		let mut redirect = OpenOptions::new();
		redirect.write(true).create(true).truncate(true);

		let reader_path = fifo.clone();
		let (open, mark) = FifoOpenWait::new();
		let reader = std::thread::spawn(move || {
			// The reader comes once the write open waits for it.
			open.wait();
			let set = |mode| {
				std::fs::set_permissions(&reader_path, std::fs::Permissions::from_mode(mode)).unwrap();
			};
			set(0o600);
			let mut file = std::fs::File::open(&reader_path).unwrap();
			set(mode);
			let mut text = String::new();
			file.read_to_string(&mut text).unwrap();
			text
		});
		let mut writer = mark.run(|| scoped.open_with(&fifo, &redirect)).unwrap();
		writer.write_all(b"hi").unwrap();
		drop(writer);
		assert_eq!(reader.join().unwrap(), "hi", "mode {mode:o}");

		let (open, mark) = FifoOpenWait::new();
		let canceller = std::thread::spawn(move || {
			// The cancel comes once the open waits for a reader.
			open.wait();
			token.cancel();
		});
		let started = std::time::Instant::now();
		let err = mark.run(|| scoped.open_with(&fifo, &redirect)).unwrap_err();
		canceller.join().unwrap();
		assert!(is_cancelled(&err), "mode {mode:o}: {err}");
		assert!(started.elapsed() < Duration::from_secs(2), "mode {mode:o}: {:?}", started.elapsed());
		if mode == 0o600 {
			let mut late_reader = std::fs::OpenOptions::new()
				.read(true)
				.custom_flags(libc::O_NONBLOCK)
				.open(&fifo)
				.unwrap();
			let read = late_reader.read(&mut [0; 8]);
			assert_eq!(read.ok(), Some(0), "a writer was left open");
		}
	}
}

/// Held for writing while a test of this binary spawns a process
/// (`dir_handle::alone`), and for reading while a test looks for ends of its
/// FIFOs: the spawned process holds a copy of every descriptor of this one
/// from its fork until its `exec` has closed them (every descriptor here is
/// close-on-exec), ends this process has closed since included, so a look
/// meanwhile could see an end this process no longer holds. `Command::spawn`
/// can return before that close (a vfork-ed parent goes on once the child's
/// `exec` has replaced its memory), so the spawner holds this until the
/// child's first output, which the new program writes.
#[cfg(unix)]
pub(crate) static SPAWNS: parking_lot::RwLock<()> = parking_lot::RwLock::new(());

/// Whether the FIFO at `path` has a reader: a write-only open that does not
/// wait fails with ENXIO when it has none. No process spawn is under way
/// meanwhile ([`SPAWNS`]).
#[cfg(unix)]
fn fifo_has_reader(path: &Path) -> bool {
	use std::os::unix::fs::OpenOptionsExt;
	let _no_spawn = SPAWNS.read();
	match std::fs::OpenOptions::new()
		.write(true)
		.custom_flags(libc::O_NONBLOCK)
		.open(path)
	{
		Ok(_) => true,
		Err(e) if e.raw_os_error() == Some(libc::ENXIO) => false,
		Err(e) => panic!("{e}"),
	}
}

/// Whether the FIFO at `path` has a writer: a reader that does not wait reads
/// end of file when it has none, and would block when it has one. No process
/// spawn is under way meanwhile, as for [`fifo_has_reader`].
#[cfg(unix)]
fn fifo_has_writer(path: &Path) -> bool {
	use std::os::unix::fs::OpenOptionsExt;
	let _no_spawn = SPAWNS.read();
	let mut reader = std::fs::OpenOptions::new()
		.read(true)
		.custom_flags(libc::O_NONBLOCK)
		.open(path)
		.unwrap();
	match reader.read(&mut [0; 1]) {
		Ok(0) => false,
		Err(e) if e.kind() == io::ErrorKind::WouldBlock => true,
		other => panic!("{other:?}"),
	}
}

/// Dropped FIFO opens through a cancellable view (a job aborted while its
/// redirection waits) leave no end of the FIFO behind once the drop returns:
/// each round starts a read and a write and drops each as soon as it starts,
/// in most rounds before its helper runs, and a helper any round leaves
/// behind fails a later check. A helper the drop came before used to enter
/// `open(2)` after the drop's release had given up, and stay on the FIFO.
#[cfg(unix)]
#[test]
fn dropped_fifo_opens_through_a_cancellable_view_leave_no_end_behind() {
	use std::{
		future::Future,
		task::{Context, Waker},
	};
	let dir = TempDir::new("fifo-drop");
	let fifo = dir.0.join("fifo");
	BlockingFs::native()
		.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
		.unwrap();
	let scoped = Fs::native().with_cancellation(CancellationToken::new());
	let (mut read, mut write) = (OpenOptions::new(), OpenOptions::new());
	read.read(true);
	write.write(true);
	for round in 0..200 {
		for (options, end) in [(&read, "read"), (&write, "write")] {
			let mut open = std::pin::pin!(scoped.open_with(&fifo, options));
			let started = open.as_mut().poll(&mut Context::from_waker(Waker::noop()));
			assert!(started.is_pending(), "round {round}: the {end} open did not wait");
		}
		assert!(!fifo_has_reader(&fifo), "round {round}: a reader is left on the FIFO");
		assert!(!fifo_has_writer(&fifo), "round {round}: a writer is left on the FIFO");
	}
}

/// With `O_NOFOLLOW`, a FIFO opens through a cancellable view (on Linux its
/// pin is checked not to be a symbolic link, and the pin's `/proc/self/fd/N`,
/// which is one, is opened without the flag), and a symbolic link to a FIFO
/// is refused with ELOOP, as `open(2)` refuses it.
#[cfg(unix)]
#[test]
fn fifo_opens_through_a_cancellable_view_keep_nofollow() {
	use std::io::Write;
	let dir = TempDir::new("fifo-nofollow");
	let fifo = dir.0.join("fifo");
	BlockingFs::native()
		.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
		.unwrap();
	let scoped = BlockingFs::native().with_cancellation(CancellationToken::new());
	let mut options = OpenOptions::new();
	options.read(true).custom_flags(libc::O_NOFOLLOW);

	// The writer's open waits for the reader the helper's open is.
	let writer_path = fifo.clone();
	let writer = std::thread::spawn(move || {
		let mut file = std::fs::OpenOptions::new()
			.write(true)
			.open(writer_path)
			.unwrap();
		file.write_all(b"hi").unwrap();
	});
	let mut text = String::new();
	scoped
		.open_with(&fifo, &options)
		.unwrap()
		.read_to_string(&mut text)
		.unwrap();
	writer.join().unwrap();
	assert_eq!(text, "hi");

	let link = dir.0.join("link");
	std::os::unix::fs::symlink(&fifo, &link).unwrap();
	let err = scoped.open_with(&link, &options).unwrap_err();
	assert_eq!(err.raw_os_error(), Some(libc::ELOOP), "{err}");
}

/// FIFO opens that create, by label: the shell's `>` and `>>`, and a write
/// with a custom `O_CREAT`.
#[cfg(target_os = "linux")]
fn creating_fifo_opens() -> [(&'static str, OpenOptions); 3] {
	let (mut redirect, mut append, mut custom) =
		(OpenOptions::new(), OpenOptions::new(), OpenOptions::new());
	redirect.write(true).create(true).truncate(true);
	append.append(true).create(true);
	custom.write(true).custom_flags(libc::O_CREAT);
	[
		("> (write, create, truncate)", redirect),
		(">> (append, create)", append),
		("write, custom O_CREAT", custom),
	]
}

/// Through a cancellable view, the helper of a FIFO open that creates opens
/// the path, so the kernel checks `O_CREAT` against the path's directory as
/// for the plain open (`fs.protected_fifos`); the helper of one that creates
/// nothing opens the pin's `/proc/self/fd/N` where procfs reaches it. Each
/// of `>`, `>>`, a write with a custom `O_CREAT`, a plain write and a plain
/// read, through the view's blocking open and its async open. The FIFO's
/// two ends are held, so each open completes at once. In a process of its
/// own, as the record of the helpers is the process's.
#[cfg(target_os = "linux")]
#[test]
fn fifo_opens_through_a_cancellable_view_that_create_open_the_path() {
	use crate::fs::fifo_seam::{Helper, take_helpers};
	if crate::dir_handle::alone(
		"tests::fifo_opens_through_a_cancellable_view_that_create_open_the_path",
	) {
		return;
	}
	let dir = TempDir::new("fifo-route");
	let fifo = dir.0.join("fifo");
	BlockingFs::native()
		.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
		.unwrap();
	let _both = std::fs::OpenOptions::new()
		.read(true)
		.write(true)
		.open(&fifo)
		.unwrap();
	let token = CancellationToken::new();
	let scoped = BlockingFs::native().with_cancellation(token.clone());
	let fs = Fs::native().with_cancellation(token);
	let runtime = tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()
		.unwrap();
	let (mut write, mut read) = (OpenOptions::new(), OpenOptions::new());
	write.write(true);
	read.read(true);
	let mut cases: Vec<_> = creating_fifo_opens()
		.into_iter()
		.map(|(label, options)| (label, options, true))
		.collect();
	cases.extend([("write", write, false), ("read", read, false)]);
	let reopen = if Path::new("/proc/self/fd").is_dir() {
		Helper::Reopen
	} else {
		Helper::ByName
	};
	let mut wrong = Vec::new();
	take_helpers();
	for (label, options, creates) in &cases {
		let want = vec![if *creates { Helper::ByName } else { reopen }];
		for route in ["blocking", "async"] {
			let opened = if route == "blocking" {
				scoped.open_with(&fifo, options)
			} else {
				runtime.block_on(fs.open_with(&fifo, options))
			};
			let helpers = take_helpers();
			if opened.is_err() || helpers != want {
				wrong.push(format!(
					"{label}, {route}: {:?}, helpers {helpers:?} where {want:?} are due",
					opened.map(drop)
				));
			}
		}
	}
	assert!(wrong.is_empty(), "FIFO opens under a token: {wrong:#?}");
}

/// This thread's id, for [`waits_in_open`].
#[cfg(target_os = "linux")]
pub(crate) fn thread_id() -> libc::c_long {
	// SAFETY: `gettid` has no preconditions.
	unsafe { libc::syscall(libc::SYS_gettid) }
}

/// Whether the thread `tid` of this process waits in an `open`: its
/// `/proc/self/task/<tid>/syscall` names `openat` (or, on x86_64, `open`,
/// which musl's `open()` issues there). Where that file is not there
/// (gVisor), its state is sleeping, which a thread waiting on a lock also
/// shows, so there this does not prove the thread is in `open`. `None`
/// when neither can be read.
#[cfg(target_os = "linux")]
pub(crate) fn waits_in_open(tid: libc::c_long) -> Option<bool> {
	if let Ok(syscall) = std::fs::read_to_string(format!("/proc/self/task/{tid}/syscall")) {
		let number = syscall.split_whitespace().next()?;
		return Some(number.parse::<libc::c_long>().is_ok_and(is_open_call));
	}
	let stat = std::fs::read_to_string(format!("/proc/self/task/{tid}/stat")).ok()?;
	Some(stat.rsplit_once(')')?.1.trim_start().starts_with('S'))
}

/// Whether the system call `number` opens a file by path: `openat`, and
/// on x86_64 also `open`.
#[cfg(target_os = "linux")]
fn is_open_call(number: libc::c_long) -> bool {
	#[cfg(target_arch = "x86_64")]
	if number == libc::SYS_open {
		return true;
	}
	number == libc::SYS_openat
}

/// The FIFO the sticky-directory tests open (this file's and
/// `dir_handle/tests.rs`'s): a FIFO of another user, which any user may read
/// and write, in a world-writable sticky directory that user does not own.
/// `PI_TEST_STICKY_FIFO` names one when set (root makes it before a run as
/// another user; a wrong one fails the test); else, as root, one is made in
/// `dir`. `Err` says why there is none.
#[cfg(target_os = "linux")]
pub(crate) fn sticky_fifo(dir: &Path) -> Result<PathBuf, String> {
	use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
	// SAFETY: `geteuid` has no preconditions.
	let me = unsafe { libc::geteuid() };
	if let Some(given) = std::env::var_os("PI_TEST_STICKY_FIFO") {
		let fifo = PathBuf::from(given);
		let meta = std::fs::metadata(&fifo)
			.unwrap_or_else(|err| panic!("PI_TEST_STICKY_FIFO {fifo:?}: {err}"));
		let parent = std::fs::metadata(fifo.parent().unwrap()).unwrap();
		assert!(meta.file_type().is_fifo(), "PI_TEST_STICKY_FIFO {fifo:?} is no FIFO");
		assert_eq!(
			parent.mode() & 0o1002,
			0o1002,
			"PI_TEST_STICKY_FIFO {fifo:?}: its directory is not sticky and world-writable"
		);
		assert!(
			meta.uid() != me && meta.uid() != parent.uid(),
			"PI_TEST_STICKY_FIFO {fifo:?}: owned by this user or by its directory's owner"
		);
		assert_eq!(meta.mode() & 0o666, 0o666, "PI_TEST_STICKY_FIFO {fifo:?}: not 0666");
		return Ok(fifo);
	}
	if me != 0 {
		return Err("not root and no PI_TEST_STICKY_FIFO, so no FIFO of another user".to_owned());
	}
	let sticky = dir.join("sticky");
	std::fs::create_dir(&sticky).unwrap();
	std::fs::set_permissions(&sticky, std::fs::Permissions::from_mode(0o1777)).unwrap();
	let fifo = sticky.join("report.txt");
	BlockingFs::native()
		.make_node(&fifo, crate::NodeKind::Fifo, 0o666)
		.unwrap();
	std::fs::set_permissions(&fifo, std::fs::Permissions::from_mode(0o666)).unwrap();
	std::os::unix::fs::chown(&fifo, Some(65534), Some(65534)).unwrap();
	Ok(fifo)
}

/// With `fs.protected_fifos` at 1 or more, an open that creates of a FIFO
/// another user owns in a world-writable sticky directory that user does
/// not own is refused (`EACCES`), so a command that means to create a file
/// never writes into such a FIFO. Through a cancellable view, blocking and
/// async, such an open is refused as the plain open is: `>`, `>>` and a
/// write with a custom `O_CREAT`. The FIFO's read end is held, so an open
/// that goes ahead ends at once and its write reaches that reader. As root,
/// which can give the FIFO to another user, or as any user given such a FIFO
/// (`sticky_fifo`), where `fs.protected_fifos` is 1 or more and the plain
/// open is refused; elsewhere it checks nothing and says so.
#[cfg(target_os = "linux")]
#[test]
fn fifo_opens_through_a_cancellable_view_that_create_are_refused_in_a_sticky_directory() {
	use std::os::unix::fs::OpenOptionsExt;
	let protected = std::fs::read_to_string("/proc/sys/fs/protected_fifos")
		.ok()
		.and_then(|value| value.trim().parse::<u32>().ok());
	if protected.is_none_or(|value| value < 1) {
		eprintln!("UNKNOWN: fs.protected_fifos is {protected:?}, not 1 or more; nothing was checked");
		return;
	}
	let dir = TempDir::new("fifo-sticky");
	let fifo = match sticky_fifo(&dir.0) {
		Ok(fifo) => fifo,
		Err(why) => {
			eprintln!("UNKNOWN: {why}; nothing was checked");
			return;
		},
	};
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
	let token = CancellationToken::new();
	let scoped = BlockingFs::native().with_cancellation(token.clone());
	let fs = Fs::native().with_cancellation(token);
	let runtime = tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()
		.unwrap();
	let mut wrong = Vec::new();
	for (label, options) in creating_fifo_opens() {
		let want = error(plain.open_with(&fifo, &options));
		if want.is_ok() {
			eprintln!(
				"UNKNOWN: {label}: the plain open gave {want:?}, so fs.protected_fifos does not hold \
				 here; nothing was checked"
			);
			return;
		}
		let got = [
			("blocking", error(scoped.open_with(&fifo, &options))),
			("async", error(runtime.block_on(fs.open_with(&fifo, &options)))),
		];
		for (route, result) in got {
			if result != want {
				wrong.push(format!("{label}, {route}: {result:?} where the plain open gives {want:?}"));
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

/// A `>` (write, create, truncate) through a cancellable view.
#[cfg(target_os = "linux")]
fn redirect() -> OpenOptions {
	let mut options = OpenOptions::new();
	options.write(true).create(true).truncate(true);
	options
}

/// A helper the drop has left changes no file. A `>` through a cancellable
/// view whose helper is held up between its last check and its open for
/// longer than the drop waits for it, as a loaded node can hold a thread:
/// the token fires while the helper is held, the open fails, and the drop
/// leaves the helper at its bound. The helper then opens the path:
/// - a regular file put there keeps its bytes: the helper's open does not
///   truncate, and it closes what it opened at once;
/// - where the path names nothing, it leaves at most an empty regular file (its
///   `O_CREAT` creates one, which it closes at once; what is left, see
///   [`FifoOpen`]), and nothing else: no bytes, no other kind of file;
/// - where the path still names the FIFO, the helper waits there as a writer
///   until a reader comes, which then reads end of file (what is left).
///
/// Every wait is bounded, so a regression fails rather than hangs.
#[cfg(target_os = "linux")]
#[test]
fn a_fifo_open_whose_helper_the_drop_left_changes_no_file() {
	use std::{os::unix::fs::OpenOptionsExt, sync::mpsc, time::Instant};
	const LIMIT: Duration = Duration::from_secs(10);
	let held_for = crate::fifo::LEAVE_AFTER + Duration::from_secs(1);
	let wait = |done: &dyn Fn() -> bool| {
		let start = Instant::now();
		while !done() && start.elapsed() < LIMIT {
			std::thread::sleep(Duration::from_millis(5));
		}
		done()
	};
	let mut wrong = Vec::new();
	for late in ["a regular file", "nothing", "the FIFO"] {
		let dir = TempDir::new("fifo-left");
		let fifo = dir.0.join("fifo");
		BlockingFs::native()
			.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
			.unwrap();
		let (reached_tx, reached) = mpsc::channel();
		let (moved_tx, moved) = mpsc::channel();
		let at = fifo.clone();
		crate::fifo::hooks::before_open(&fifo, move || {
			let _ = reached_tx.send(());
			std::thread::sleep(held_for);
			match late {
				"a regular file" => {
					std::fs::rename(&at, at.with_extension("old")).unwrap();
					std::fs::write(&at, "kept").unwrap();
				},
				"nothing" => std::fs::rename(&at, at.with_extension("old")).unwrap(),
				_ => {},
			}
			let _ = moved_tx.send(());
		});
		let token = CancellationToken::new();
		let scoped = BlockingFs::native().with_cancellation(token.clone());
		let path = fifo.clone();
		let opener = std::thread::spawn(move || scoped.open_with(&path, &redirect()).map(drop));
		if reached.recv_timeout(LIMIT).is_err() {
			wrong.push(format!("{late}: the helper had not reached its open after {LIMIT:?}"));
		}
		token.cancel();
		if !wait(&|| opener.is_finished()) {
			wrong.push(format!("{late}: the open had not returned {LIMIT:?} after the token fired"));
		}
		if moved.recv_timeout(LIMIT).is_err() {
			wrong.push(format!("{late}: the helper's hold had not ended after {LIMIT:?}"));
		}
		let reader = (late == "the FIFO").then(|| {
			std::thread::sleep(Duration::from_millis(200));
			if crate::fifo::hooks::ended(&fifo) {
				wrong.push(format!("{late}: the helper ended with no reader"));
			}
			std::fs::OpenOptions::new()
				.read(true)
				.custom_flags(libc::O_NONBLOCK)
				.open(&fifo)
				.unwrap()
		});
		if !wait(&|| crate::fifo::hooks::ended(&fifo)) {
			wrong.push(format!("{late}: the helper had not ended after {LIMIT:?}"));
		}
		match (late, reader) {
			("a regular file", _) => {
				let got = std::fs::read_to_string(&fifo).unwrap();
				if got != "kept" {
					wrong.push(format!("{late}: the file holds {got:?}, not \"kept\""));
				}
			},
			("nothing", _) => match std::fs::symlink_metadata(&fifo) {
				Err(err) if err.kind() == io::ErrorKind::NotFound => {},
				Ok(m) if m.is_file() && m.len() == 0 => {},
				other => wrong.push(format!(
					"{late}: the path names {other:?}, not nothing or an empty regular file"
				)),
			},
			(_, Some(mut reader)) => {
				let mut got = Vec::new();
				if !matches!(reader.read_to_end(&mut got), Ok(0)) {
					wrong.push(format!("{late}: the reader got {got:?}, not end of file"));
				}
			},
			_ => unreachable!(),
		}
		if opener.is_finished() && opener.join().unwrap().is_ok() {
			wrong.push(format!("{late}: the open succeeded though its token fired"));
		}
	}
	assert!(wrong.is_empty(), "{wrong:#?}");
}

/// A `>` through a cancellable view whose FIFO is replaced by a regular file
/// just before its helper's open, while the call still waits for it, opens
/// that file and truncates it, as `open(2)` of the path with `O_TRUNC` does.
/// An open that waits instead (its helper on the FIFO the path no longer
/// names) fails the test within its bound: the token then ends the open.
#[cfg(target_os = "linux")]
#[test]
fn a_fifo_open_whose_path_names_a_regular_file_by_its_open_truncates_it() {
	const LIMIT: Duration = Duration::from_secs(10);
	let dir = TempDir::new("fifo-live");
	let fifo = dir.0.join("fifo");
	BlockingFs::native()
		.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
		.unwrap();
	let at = fifo.clone();
	crate::fifo::hooks::before_open(&fifo, move || {
		std::fs::rename(&at, at.with_extension("old")).unwrap();
		std::fs::write(&at, "replaced").unwrap();
	});
	let token = CancellationToken::new();
	let scoped = BlockingFs::native().with_cancellation(token.clone());
	let path = fifo.clone();
	let opener = std::thread::spawn(move || {
		let mut file = scoped.open_with(&path, &redirect())?;
		file.write_all(b"new")
	});
	let start = std::time::Instant::now();
	while !opener.is_finished() && start.elapsed() < LIMIT {
		std::thread::sleep(Duration::from_millis(5));
	}
	let returned = opener.is_finished();
	if !returned {
		token.cancel();
	}
	let written = opener.join().unwrap();
	assert!(
		returned,
		"the open had not returned after {LIMIT:?}: its helper waits on a FIFO, not the regular \
		 file at the path"
	);
	written.unwrap();
	assert_eq!(std::fs::read_to_string(&fifo).unwrap(), "new", "the regular file was not truncated");
}

/// A read-only FIFO open that asks for `O_TRUNC` keeps it when its helper
/// opens the path (an open that creates), so the kernel asks the write
/// permission `O_TRUNC` asks, as of the plain open: a FIFO this process may
/// only read is refused (`EACCES`). Root may write it, so as root both open.
/// Both of the FIFO's ends are held, so each open ends at once.
#[cfg(target_os = "linux")]
#[test]
fn a_read_only_fifo_open_that_truncates_asks_the_write_permission_of_the_plain_open() {
	use std::os::unix::fs::PermissionsExt;
	let dir = TempDir::new("fifo-read-trunc");
	let fifo = dir.0.join("fifo");
	BlockingFs::native()
		.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
		.unwrap();
	let _both = std::fs::OpenOptions::new()
		.read(true)
		.write(true)
		.open(&fifo)
		.unwrap();
	std::fs::set_permissions(&fifo, std::fs::Permissions::from_mode(0o444)).unwrap();
	let mut options = OpenOptions::new();
	options
		.read(true)
		.custom_flags(libc::O_CREAT | libc::O_TRUNC);
	let outcome = |opened: io::Result<File>| opened.map(drop).map_err(|err| err.raw_os_error());
	let plain = outcome(BlockingFs::native().open_with(&fifo, &options));
	let scoped = BlockingFs::native().with_cancellation(CancellationToken::new());
	assert_eq!(outcome(scoped.open_with(&fifo, &options)), plain, "through a cancellable view");
	// SAFETY: `geteuid` has no preconditions.
	if unsafe { libc::geteuid() } != 0 {
		assert_eq!(plain, Err(Some(libc::EACCES)), "the plain open");
	}
}

/// The helper thread of a FIFO open runs with every signal blocked but
/// those a fault raises in the faulting thread, so a signal sent to the
/// process goes to a thread of the caller's, never to the helper (pi-shell
/// starts each of its helper threads so, and its signal handlers count on
/// it). The mask is read on the helper itself, inside the open it runs; the
/// open then waits for a writer that never comes, and the drop releases it.
#[cfg(unix)]
#[test]
fn a_fifo_opens_helper_thread_runs_with_the_callers_signals_blocked() {
	use std::sync::mpsc;
	let dir = TempDir::new("fifo-mask");
	let fifo = dir.0.join("fifo");
	BlockingFs::native()
		.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
		.unwrap();
	let meta = std::fs::metadata(&fifo).unwrap();
	let (tx, rx) = mpsc::channel();
	let open = FifoOpen::start(&fifo, &meta, false, false, false, move |path, _| {
		// SAFETY: plain data, filled by pthread_sigmask.
		let mut mask: libc::sigset_t = unsafe { std::mem::zeroed() };
		// SAFETY: a null new set only reads this thread's mask into `mask`.
		unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, std::ptr::null(), &raw mut mask) };
		// SAFETY: `mask` is a valid set and each number a valid signal.
		let blocked = |sig| unsafe { libc::sigismember(&raw const mask, sig) } == 1;
		let open_ones: Vec<libc::c_int> = [
			libc::SIGINT,
			libc::SIGQUIT,
			libc::SIGTERM,
			libc::SIGHUP,
			libc::SIGWINCH,
			libc::SIGCHLD,
			libc::SIGUSR1,
		]
		.into_iter()
		.filter(|&s| !blocked(s))
		.collect();
		let blocked_faults: Vec<libc::c_int> =
			[libc::SIGSEGV, libc::SIGBUS, libc::SIGILL, libc::SIGFPE, libc::SIGTRAP, libc::SIGSYS]
				.into_iter()
				.filter(|&s| blocked(s))
				.collect();
		tx.send((open_ones, blocked_faults)).unwrap();
		std::fs::File::open(path)
	});
	let (open_ones, blocked_faults) = rx
		.recv_timeout(Duration::from_secs(30))
		.expect("the helper ran the open within 30 s");
	drop(open);
	assert!(open_ones.is_empty(), "signals open on the helper: {open_ones:?}");
	assert!(blocked_faults.is_empty(), "fault signals blocked on the helper: {blocked_faults:?}");
}
