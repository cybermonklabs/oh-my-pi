//! `VfsFs`: provider paths pend on the runtime and wake the engine's waker;
//! host paths answer at once through the native filesystem.

use std::{
	collections::HashMap,
	io::{self, SeekFrom},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
	task::{Context, Poll, Wake, Waker},
	thread::{self, Thread},
	time::{Duration, Instant, UNIX_EPOCH},
};

use async_trait::async_trait;
use bstr::{BStr, BString};
use parking_lot::Mutex;
use pi_vfs::{
	CanonicalizeOptions, DirEntry, FileHandle, FileSystem, FileType, Metadata, OpenOptions,
	Permissions, ReadDir,
};
use tokio::runtime::Runtime;

use crate::{
	bash::{
		DirIter, File, FileKind, Fs, FsPoll, OpenFlags,
		fs::{Access, StatKind},
	},
	vfs::VfsFs,
};

const HELLO: &[u8] = b"hello world\n";

/// Modification time of every provider file.
const MTIME_SECS: u64 = 1_000;

#[derive(Clone, Debug)]
enum Node {
	File(Arc<Mutex<Vec<u8>>>),
	Dir,
	Link(PathBuf),
}

/// In-memory provider for `mem://` paths that answers every call after a
/// timer, so no answer is available when the operation starts.
///
/// - `mem://stall` never answers; the future records that it started and that
///   it was dropped.
/// - Entries named `untyped…` are listed without a type.
/// - Files named `stream…` cannot seek.
/// - While `hold` is on, no write finishes ([`Hold`]).
/// - Reads of files named `gate…` wait until a write waits on `hold`.
#[derive(Debug, Default)]
struct MemFs {
	nodes:   Mutex<HashMap<PathBuf, Node>>,
	stalled: Arc<AtomicBool>,
	dropped: Arc<AtomicBool>,
	hold:    Arc<Hold>,
}

/// Holds the provider's writes, so a test can make two pollers meet while
/// a write is under way.
#[derive(Debug, Default)]
struct Hold {
	/// No write finishes while it is set.
	on:      AtomicBool,
	/// Writes that found it set (and waited).
	waiting: AtomicUsize,
}

impl MemFs {
	fn seeded() -> Arc<Self> {
		let fs = Self::default();
		{
			let mut nodes = fs.nodes.lock();
			let file = |bytes: &[u8]| Node::File(Arc::new(Mutex::new(bytes.to_vec())));
			nodes.insert("mem://d".into(), Node::Dir);
			nodes.insert("mem://d/sub".into(), Node::Dir);
			nodes.insert("mem://d/hello".into(), file(HELLO));
			nodes.insert("mem://d/untyped.txt".into(), file(b""));
			nodes.insert("mem://d/stream".into(), file(HELLO));
			nodes.insert("mem://d/link".into(), Node::Link("mem://d/hello".into()));
		}
		Arc::new(fs)
	}

	fn node(&self, path: &Path) -> io::Result<Node> {
		self
			.nodes
			.lock()
			.get(path)
			.cloned()
			.ok_or_else(|| io::ErrorKind::NotFound.into())
	}

	/// `path` and its node, through one symlink.
	fn resolve(&self, path: &Path) -> io::Result<(PathBuf, Node)> {
		match self.node(path)? {
			Node::Link(target) => {
				let node = self.node(&target)?;
				Ok((target, node))
			},
			node => Ok((path.to_path_buf(), node)),
		}
	}

	async fn stall_on(&self, path: &Path) {
		if path == Path::new("mem://stall") {
			let _released = SetOnDrop(Arc::clone(&self.dropped));
			self.stalled.store(true, Ordering::SeqCst);
			std::future::pending::<()>().await;
		}
	}
}

struct SetOnDrop(Arc<AtomicBool>);

impl Drop for SetOnDrop {
	fn drop(&mut self) {
		self.0.store(true, Ordering::SeqCst);
	}
}

async fn delay() {
	tokio::time::sleep(Duration::from_millis(5)).await;
}

fn meta_of(node: &Node) -> Metadata {
	let (kind, len, mode) = match node {
		Node::File(data) => (pi_vfs::FileKind::File, data.lock().len() as u64, 0o644),
		Node::Dir => (pi_vfs::FileKind::Dir, 0, 0o755),
		Node::Link(_) => (pi_vfs::FileKind::Symlink, 0, 0o777),
	};
	Metadata::new(FileType::from_kind(kind), len, Permissions::from_mode(mode))
		.with_modified(UNIX_EPOCH + Duration::from_secs(MTIME_SECS))
}

#[async_trait]
impl FileSystem for MemFs {
	fn is_native_local(&self, path: &Path) -> bool {
		!pi_vfs::is_virtual_path(path)
	}

	async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<pi_vfs::File> {
		delay().await;
		let data = {
			let mut nodes = self.nodes.lock();
			match nodes.get(path) {
				Some(_) if options.is_create_new() => return Err(io::ErrorKind::AlreadyExists.into()),
				Some(Node::File(data)) => Arc::clone(data),
				Some(Node::Dir) => return Err(io::ErrorKind::IsADirectory.into()),
				Some(Node::Link(_)) => return Err(io::ErrorKind::Unsupported.into()),
				None if options.is_create() || options.is_create_new() => {
					let data = Arc::new(Mutex::new(Vec::new()));
					nodes.insert(path.to_path_buf(), Node::File(Arc::clone(&data)));
					data
				},
				None => return Err(io::ErrorKind::NotFound.into()),
			}
		};
		if options.is_truncate() {
			data.lock().clear();
		}
		let name = pi_vfs::file_name(path).map(|n| n.to_string_lossy().into_owned());
		let named = |prefix: &str| name.as_deref().is_some_and(|n| n.starts_with(prefix));
		Ok(pi_vfs::File::from_handle(MemHandle {
			data,
			pos: Mutex::new(0),
			append: options.is_append(),
			seekable: !named("stream"),
			gate: named("gate"),
			hold: Arc::clone(&self.hold),
		}))
	}

	async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
		self.stall_on(path).await;
		delay().await;
		Ok(meta_of(&self.resolve(path)?.1))
	}

	async fn symlink_metadata(&self, path: &Path) -> io::Result<Metadata> {
		delay().await;
		Ok(meta_of(&self.node(path)?))
	}

	async fn read_dir(&self, path: &Path) -> io::Result<ReadDir> {
		delay().await;
		if !matches!(self.resolve(path)?.1, Node::Dir) {
			return Err(io::ErrorKind::NotADirectory.into());
		}
		let entries: Vec<io::Result<DirEntry>> = self
			.nodes
			.lock()
			.iter()
			.filter(|(child, _)| pi_vfs::parent_path(child) == Some(path))
			.map(|(child, node)| {
				let name = pi_vfs::file_name(child).unwrap_or_default().into_owned();
				let listed = !name.to_string_lossy().starts_with("untyped");
				let kind = listed.then(|| meta_of(node).file_type());
				Ok(DirEntry::new(child.clone(), name, kind))
			})
			.collect();
		Ok(ReadDir::from_entries(entries))
	}

	async fn read_link(&self, path: &Path) -> io::Result<PathBuf> {
		delay().await;
		match self.node(path)? {
			Node::Link(target) => Ok(target),
			_ => Err(io::ErrorKind::InvalidInput.into()),
		}
	}

	async fn canonicalize(
		&self,
		path: &Path,
		_options: &CanonicalizeOptions,
	) -> io::Result<PathBuf> {
		delay().await;
		Ok(self.resolve(path)?.0)
	}
}

/// An open `mem://` file; writes move at most four bytes per call.
#[derive(Debug)]
struct MemHandle {
	data:     Arc<Mutex<Vec<u8>>>,
	pos:      Mutex<u64>,
	append:   bool,
	seekable: bool,
	/// A `gate…` file: reads wait until a write waits on `hold`.
	gate:     bool,
	/// [`MemFs::hold`].
	hold:     Arc<Hold>,
}

#[async_trait]
impl FileHandle for MemHandle {
	async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		while self.gate && self.hold.waiting.load(Ordering::SeqCst) == 0 {
			tokio::time::sleep(Duration::from_millis(1)).await;
		}
		delay().await;
		let data = self.data.lock();
		let mut pos = self.pos.lock();
		let start = usize::try_from(*pos).unwrap().min(data.len());
		let n = (data.len() - start).min(buf.len());
		buf[..n].copy_from_slice(&data[start..start + n]);
		*pos += n as u64;
		Ok(n)
	}

	async fn write(&self, buf: &[u8]) -> io::Result<usize> {
		if self.hold.on.load(Ordering::SeqCst) {
			self.hold.waiting.fetch_add(1, Ordering::SeqCst);
			while self.hold.on.load(Ordering::SeqCst) {
				tokio::time::sleep(Duration::from_millis(1)).await;
			}
		}
		delay().await;
		let mut data = self.data.lock();
		let mut pos = self.pos.lock();
		if self.append {
			*pos = data.len() as u64;
		}
		let start = usize::try_from(*pos).unwrap();
		let n = buf.len().min(4);
		if data.len() < start + n {
			data.resize(start + n, 0);
		}
		data[start..start + n].copy_from_slice(&buf[..n]);
		*pos += n as u64;
		Ok(n)
	}

	async fn seek(&self, to: SeekFrom) -> io::Result<u64> {
		delay().await;
		if !self.seekable {
			return Err(io::ErrorKind::NotSeekable.into());
		}
		let len = self.data.lock().len() as u64;
		let mut pos = self.pos.lock();
		let next = match to {
			SeekFrom::Start(at) => Some(at),
			SeekFrom::Current(by) => pos.checked_add_signed(by),
			SeekFrom::End(by) => len.checked_add_signed(by),
		}
		.ok_or(io::ErrorKind::InvalidInput)?;
		*pos = next;
		Ok(next)
	}

	async fn metadata(&self) -> io::Result<Metadata> {
		delay().await;
		Ok(meta_of(&Node::File(Arc::clone(&self.data))))
	}
}

/// Wakes record themselves and unpark the polling thread.
struct Wakeup {
	woken:  AtomicBool,
	thread: Thread,
}

impl Wake for Wakeup {
	fn wake(self: Arc<Self>) {
		self.woken.store(true, Ordering::SeqCst);
		self.thread.unpark();
	}
}

/// Poll `poll` until ready, as the engine does: after `Pending` only a wake
/// of the waker it was polled with brings the next poll (none within ten
/// seconds fails the test).
fn drive<T>(mut poll: impl FnMut(&mut Context<'_>) -> Poll<T>) -> T {
	let wakeup = Arc::new(Wakeup { woken: AtomicBool::new(false), thread: thread::current() });
	let waker = Waker::from(Arc::clone(&wakeup));
	let mut cx = Context::from_waker(&waker);
	loop {
		if let Poll::Ready(value) = poll(&mut cx) {
			return value;
		}
		let deadline = Instant::now() + Duration::from_secs(10);
		while !wakeup.woken.swap(false, Ordering::SeqCst) {
			let left = deadline
				.checked_duration_since(Instant::now())
				.expect("a pending operation never woke its waker");
			thread::park_timeout(left);
		}
	}
}

/// The result of an operation that must pend first.
fn pending<T>(op: FsPoll<T>) -> io::Result<T> {
	match op {
		FsPoll::Ready(_) => panic!("a provider operation answered without waiting"),
		FsPoll::Pending(mut op) => drive(|cx| op.poll(cx)),
	}
}

/// The result of an operation that must answer at once.
fn ready<T>(op: FsPoll<T>) -> io::Result<T> {
	match op {
		FsPoll::Ready(result) => result,
		FsPoll::Pending(_) => panic!("a native-local operation pended"),
	}
}

fn runtime() -> Runtime {
	tokio::runtime::Builder::new_multi_thread()
		.worker_threads(2)
		.enable_all()
		.build()
		.unwrap()
}

fn vfs(rt: &Runtime, provider: Arc<MemFs>) -> VfsFs {
	VfsFs::new(pi_vfs::Fs::new(provider), rt.handle().clone())
}

fn p(path: &str) -> &BStr {
	BStr::new(path)
}

fn host(path: &Path) -> BString {
	BString::from(path.as_os_str().as_encoded_bytes())
}

fn read_to_end(file: &mut dyn File) -> Vec<u8> {
	let mut out = Vec::new();
	let mut buf = [0u8; 5];
	loop {
		let n = drive(|cx| file.poll_read(cx, &mut buf)).unwrap();
		if n == 0 {
			return out;
		}
		out.extend_from_slice(&buf[..n]);
	}
}

fn write_all(file: &mut dyn File, mut bytes: &[u8]) {
	while !bytes.is_empty() {
		let n = drive(|cx| file.poll_write(cx, bytes)).unwrap();
		assert!(n > 0 && n <= bytes.len(), "wrote {n} of {}", bytes.len());
		bytes = &bytes[n..];
	}
	drive(|cx| file.poll_flush(cx)).unwrap();
}

/// Names and kinds of a listing, sorted by name.
fn list(mut dir: Box<dyn DirIter>) -> Vec<(BString, Option<StatKind>)> {
	let mut entries = Vec::new();
	while let Some(entry) = drive(|cx| dir.poll_next(cx)) {
		let entry = entry.unwrap();
		entries.push((entry.name, entry.kind));
	}
	entries.sort_by(|a, b| a.0.cmp(&b.0));
	entries
}

#[test]
fn provider_operations_pend_then_answer() {
	let rt = runtime();
	let mut fs = vfs(&rt, MemFs::seeded());

	let hello = pending(fs.stat(p("mem://d/hello"), true)).unwrap();
	assert_eq!(hello.kind, StatKind::File);
	assert_eq!(hello.size, HELLO.len() as u64);
	assert_eq!(hello.mode, 0o644);
	assert_eq!(hello.nlink, 1);
	assert_eq!(hello.blocks, 1);
	let mtime_ns = i64::try_from(MTIME_SECS).unwrap() * 1_000_000_000;
	assert_eq!((hello.mtime_ns, hello.atime_ns, hello.ctime_ns), (mtime_ns, mtime_ns, mtime_ns));
	// Unidentified objects get a per-path identity: `-ef` holds only for the
	// same path.
	let again = pending(fs.stat(p("mem://d/hello"), true)).unwrap();
	let sub = pending(fs.stat(p("mem://d/sub"), true)).unwrap();
	assert_eq!((hello.dev, hello.ino), (again.dev, again.ino));
	assert_ne!((hello.dev, hello.ino), (sub.dev, sub.ino));
	assert_eq!(sub.kind, StatKind::Dir);
	assert_eq!(pending(fs.stat(p("mem://d/link"), false)).unwrap().kind, StatKind::Symlink);
	assert_eq!(pending(fs.stat(p("mem://d/link"), true)).unwrap().kind, StatKind::File);
	let missing = pending(fs.stat(p("mem://d/missing"), true)).unwrap_err();
	assert_eq!(missing.kind(), io::ErrorKind::NotFound);

	pending(fs.access(p("mem://d/hello"), Access::READ.with(Access::WRITE))).unwrap();
	let exec = pending(fs.access(p("mem://d/hello"), Access::EXEC)).unwrap_err();
	assert_eq!(exec.kind(), io::ErrorKind::PermissionDenied);
	let absent = pending(fs.access(p("mem://d/missing"), Access::EXISTS)).unwrap_err();
	assert_eq!(absent.kind(), io::ErrorKind::NotFound);

	let listing = list(pending(fs.read_dir(p("mem://d"))).unwrap());
	assert_eq!(listing, [
		(BString::from("hello"), Some(StatKind::File)),
		(BString::from("link"), Some(StatKind::Symlink)),
		(BString::from("stream"), Some(StatKind::File)),
		(BString::from("sub"), Some(StatKind::Dir)),
		// Listed without a type: left to the engine, not looked up.
		(BString::from("untyped.txt"), None),
	]);

	assert_eq!(pending(fs.readlink(p("mem://d/link"))).unwrap(), "mem://d/hello");
	assert_eq!(pending(fs.realpath(p("mem://d/link"))).unwrap(), "mem://d/hello");

	pending(fs.chdir_check(p("mem://d/sub"))).unwrap();
	let not_dir = pending(fs.chdir_check(p("mem://d/hello"))).unwrap_err();
	assert_eq!(not_dir.kind(), io::ErrorKind::NotADirectory);

	let mut file = pending(fs.open(p("mem://d/hello"), OpenFlags::READ, 0)).unwrap();
	assert_eq!(file.kind(), FileKind::Regular);
	assert!(file.os_handle().is_none());
	assert_eq!(read_to_end(file.as_mut()), HELLO);
}

#[test]
fn native_local_paths_answer_at_once() {
	let rt = runtime();
	let mut fs = vfs(&rt, MemFs::seeded());
	let dir = tempfile::tempdir().unwrap();
	let file_path = dir.path().join("f");
	std::fs::write(&file_path, b"abc").unwrap();
	std::fs::create_dir(dir.path().join("sub")).unwrap();
	let (dir_b, file_b) = (host(dir.path()), host(&file_path));

	let stat = ready(fs.stat(file_b.as_ref(), true)).unwrap();
	assert_eq!((stat.kind, stat.size), (StatKind::File, 3));
	ready(fs.access(file_b.as_ref(), Access::READ)).unwrap();
	ready(fs.chdir_check(dir_b.as_ref())).unwrap();
	// The resolved path a user writes: `canonicalize` without Windows'
	// verbatim `\\?\` prefix (`cd -P`, `pwd -P` and `$PWD` show it).
	let real = host(&std::fs::canonicalize(dir.path()).unwrap());
	let real = real
		.strip_prefix(br"\\?\")
		.map_or(real.clone(), BString::from);
	assert_eq!(ready(fs.realpath(dir_b.as_ref())).unwrap(), real);

	let mut listing = Vec::new();
	let mut entries = ready(fs.read_dir(dir_b.as_ref())).unwrap();
	while let Poll::Ready(Some(entry)) = entries.poll_next(&mut Context::from_waker(Waker::noop())) {
		let entry = entry.unwrap();
		listing.push((entry.name, entry.kind));
	}
	listing.sort_by(|a, b| a.0.cmp(&b.0));
	assert_eq!(listing, [
		(BString::from("f"), Some(StatKind::File)),
		(BString::from("sub"), Some(StatKind::Dir)),
	]);

	let mut file = ready(fs.open(file_b.as_ref(), OpenFlags::READ, 0)).unwrap();
	assert_eq!(file.kind(), FileKind::Regular);
	assert!(file.os_handle().is_some(), "host files keep their OS handle");
	assert_eq!(read_to_end(file.as_mut()), b"abc");

	#[cfg(unix)]
	{
		let link = dir.path().join("link");
		std::os::unix::fs::symlink(&file_path, &link).unwrap();
		assert_eq!(ready(fs.readlink(host(&link).as_ref())).unwrap(), file_b);
	}
}

#[test]
fn dropping_a_pending_operation_cancels_it() {
	let rt = runtime();
	let mem = MemFs::seeded();
	let mut fs = vfs(&rt, Arc::clone(&mem));

	let FsPoll::Pending(stalled) = fs.stat(p("mem://stall"), true) else {
		panic!("a provider operation answered without waiting");
	};
	let deadline = Instant::now() + Duration::from_secs(10);
	while !mem.stalled.load(Ordering::SeqCst) {
		assert!(Instant::now() < deadline, "the stalled operation never started");
		thread::sleep(Duration::from_millis(1));
	}
	drop(stalled);
	while !mem.dropped.load(Ordering::SeqCst) {
		assert!(Instant::now() < deadline, "dropping the operation left it running");
		thread::sleep(Duration::from_millis(1));
	}
	// The filesystem keeps serving.
	assert_eq!(pending(fs.stat(p("mem://d/hello"), true)).unwrap().kind, StatKind::File);
}

#[test]
fn provider_file_write_then_read_round_trips() {
	let rt = runtime();
	let mut fs = vfs(&rt, MemFs::seeded());
	let text = b"the quick brown fox jumps over the lazy dog";

	let create = OpenFlags::WRITE
		.with(OpenFlags::CREATE)
		.with(OpenFlags::TRUNC);
	let mut out = pending(fs.open(p("mem://d/new"), create, 0o644)).unwrap();
	assert_eq!(
		drive(|cx| out.poll_read(cx, &mut [])).unwrap_err().kind(),
		io::ErrorKind::Unsupported
	);
	assert_eq!(drive(|cx| out.poll_write(cx, &[])).unwrap(), 0);
	// The provider takes four bytes per write: only those are reported.
	assert_eq!(drive(|cx| out.poll_write(cx, text)).unwrap(), 4);
	write_all(out.as_mut(), &text[4..]);
	drop(out);

	let mut append = pending(fs.open(p("mem://d/new"), OpenFlags::APPEND, 0o644)).unwrap();
	write_all(append.as_mut(), b"!");
	drop(append);

	let mut back = pending(fs.open(p("mem://d/new"), OpenFlags::READ, 0)).unwrap();
	assert_eq!(drive(|cx| back.poll_read(cx, &mut [])).unwrap(), 0);
	assert_eq!(read_to_end(back.as_mut()), [&text[..], &b"!"[..]].concat());
}

#[test]
fn seeks_apply_to_the_next_read_of_every_duplicate() {
	let rt = runtime();
	let mut fs = vfs(&rt, MemFs::seeded());
	let mut file = pending(fs.open(p("mem://d/hello"), OpenFlags::READ, 0)).unwrap();

	let mut buf = [0u8; 8];
	assert_eq!(drive(|cx| file.poll_read(cx, &mut buf)).unwrap(), 8);
	assert_eq!(&buf, b"hello wo");
	// `read` gives back what followed the delimiter.
	assert_eq!(file.seek(SeekFrom::Current(-3)).unwrap(), 5);
	let mut dup = file.dup().unwrap();
	assert_eq!(read_to_end(dup.as_mut()), b" world\n");

	assert_eq!(file.seek(SeekFrom::Start(6)).unwrap(), 6);
	assert_eq!(read_to_end(file.as_mut()), b"world\n");
	assert_eq!(file.seek(SeekFrom::End(0)).unwrap_err().kind(), io::ErrorKind::NotSeekable);
	assert_eq!(file.seek(SeekFrom::Current(-100)).unwrap_err().kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn unseekable_provider_files_are_streams() {
	let rt = runtime();
	let mut fs = vfs(&rt, MemFs::seeded());
	let mut stream = pending(fs.open(p("mem://d/stream"), OpenFlags::READ, 0)).unwrap();
	assert_eq!(stream.kind(), FileKind::Device);
	assert_eq!(stream.seek(SeekFrom::Current(0)).unwrap_err().kind(), io::ErrorKind::NotSeekable);
	assert_eq!(read_to_end(stream.as_mut()), HELLO);
}

/// Several tasks on one open provider file (`VfsFile`): the engine's vprocs
/// share an fd's object, and a native extra writes the engine's object
/// through a handle of its own, with a key of its own.
mod two_pollers {
	use tokio_util::sync::CancellationToken;

	use super::*;
	use crate::{
		session::{RunOptions, RunStdio, Session, SessionConfig},
		sys::WaitKey,
	};

	/// A task writing a provider file with a waker of its own: the engine
	/// (keyless) or a task beside it (with a key, as a native extra writes).
	struct Writer {
		bytes: &'static [u8],
		off:   usize,
		woken: Arc<Woken>,
		waker: Waker,
		key:   Option<WaitKey>,
	}

	#[derive(Default)]
	struct Woken(AtomicBool);

	impl Wake for Woken {
		fn wake(self: Arc<Self>) {
			self.0.store(true, Ordering::SeqCst);
		}
	}

	impl Writer {
		fn new(bytes: &'static [u8], key: Option<WaitKey>) -> Self {
			let woken = Arc::new(Woken::default());
			Self { bytes, off: 0, waker: Waker::from(Arc::clone(&woken)), woken, key }
		}

		fn done(&self) -> bool {
			self.off == self.bytes.len()
		}

		fn woken(&self) -> bool {
			self.woken.0.load(Ordering::SeqCst)
		}

		/// One poll; `true` once it wrote something or is done.
		fn poll_once(&mut self, file: &mut dyn File) -> bool {
			self.woken.0.store(false, Ordering::SeqCst);
			let cx = &mut Context::from_waker(&self.waker);
			let bytes = &self.bytes[self.off..];
			let polled = match &mut self.key {
				Some(key) => file.poll_write_keyed(cx, bytes, None, key),
				None => file.poll_write(cx, bytes),
			};
			match polled {
				Poll::Ready(Ok(n)) => {
					self.off += n;
					true
				},
				Poll::Ready(Err(e)) => panic!("write: {e}"),
				Poll::Pending => false,
			}
		}

		/// Poll until done, without waiting for wakes. It waits for the end of
		/// the write; the test runner's bound fails a write that never ends.
		fn finish(&mut self, file: &mut dyn File) {
			while !self.done() {
				if !self.poll_once(file) {
					thread::sleep(Duration::from_millis(1));
				}
			}
		}
	}

	/// Wait for `done`; the test runner's bound fails a wait that never ends.
	fn until(done: impl Fn() -> bool) {
		while !done() {
			thread::sleep(Duration::from_millis(1));
		}
	}

	/// The bytes of provider file `path`.
	fn contents(mem: &MemFs, path: &str) -> Vec<u8> {
		match mem.node(Path::new(path)).unwrap() {
			Node::File(data) => data.lock().clone(),
			node => panic!("{path} is {node:?}"),
		}
	}

	/// How many `A`s and `B`s.
	#[expect(clippy::naive_bytecount, reason = "a few bytes; no bytecount dependency")]
	fn count(data: &[u8]) -> (usize, usize) {
		(data.iter().filter(|&&b| b == b'A').count(), data.iter().filter(|&&b| b == b'B').count())
	}

	/// `mem://d/two`, created.
	fn created() -> (Runtime, Arc<MemFs>, Box<dyn File>) {
		let rt = runtime();
		let mem = MemFs::seeded();
		let mut fs = vfs(&rt, Arc::clone(&mem));
		let create = OpenFlags::WRITE
			.with(OpenFlags::CREATE)
			.with(OpenFlags::TRUNC);
		let file = pending(fs.open(p("mem://d/two"), create, 0o644)).unwrap();
		(rt, mem, file)
	}

	/// `mem://d/two`, created, and two writers that each polled it once and
	/// wait: the engine (`a`) started the provider write, and a task with a
	/// key of its own (`b`) found it under way (the write is held until both
	/// polled).
	fn two_waiting() -> (Runtime, Arc<MemFs>, Box<dyn File>, Writer, Writer) {
		let (rt, mem, mut file) = created();
		let mut a = Writer::new(b"AAAAAAAAAAAAAAAA", None);
		let mut b = Writer::new(b"BBBBBBBBBBBBBBBB", Some(WaitKey::default()));
		mem.hold.on.store(true, Ordering::SeqCst);
		assert!(!a.poll_once(file.as_mut()), "a provider write waits");
		assert!(!b.poll_once(file.as_mut()), "a provider write waits");
		mem.hold.on.store(false, Ordering::SeqCst);
		(rt, mem, file, a, b)
	}

	// Failure mode: a provider file kept one operation in flight for whoever
	// polled it, and its task (one tokio `JoinHandle`) keeps one waker, the
	// last poller's: the first writer was never woken. A native extra waits
	// forever on its thread.
	#[test]
	fn two_writers_on_one_provider_file_are_both_woken() {
		let (_rt, mem, mut file, mut a, mut b) = two_waiting();
		until(|| a.woken() && b.woken());
		a.finish(file.as_mut());
		b.finish(file.as_mut());
		drop(file);
		let data = contents(&mem, "mem://d/two");
		assert_eq!(count(&data), (16, 16), "{}", String::from_utf8_lossy(&data));
	}

	// Failure mode: the second writer to poll took the first one's result as
	// its own: its first bytes were counted as written and never written, and
	// the first writer wrote its bytes again.
	#[test]
	fn two_writers_on_one_provider_file_each_write_their_bytes_once() {
		let (_rt, mem, mut file, mut a, mut b) = two_waiting();
		// The provider write `a` started is done once anyone is woken.
		until(|| a.woken() || b.woken());
		b.poll_once(file.as_mut());
		a.finish(file.as_mut());
		b.finish(file.as_mut());
		drop(file);
		let data = contents(&mem, "mem://d/two");
		assert_eq!(count(&data), (16, 16), "{}", String::from_utf8_lossy(&data));
	}

	// Failure mode (review of #132 at 8ad966d5): no test failed without the
	// position update after a write another task finished. A later relative
	// seek, or a read-ahead give-back, starts from that position.
	#[test]
	fn writes_move_the_position_whichever_task_finishes_them() {
		let (_rt, _mem, mut file, mut a, mut b) = two_waiting();
		until(|| a.woken() || b.woken());
		b.poll_once(file.as_mut());
		a.finish(file.as_mut());
		b.finish(file.as_mut());
		assert_eq!(file.seek(SeekFrom::Current(0)).unwrap(), 32);
	}

	// Failure mode: a write kept for a task that is gone (dropped while its
	// write ran, its key with it) would hold the file for good, or its count
	// would go to the next writer as its own.
	#[test]
	fn a_write_whose_task_is_gone_does_not_hold_the_file() {
		let (_rt, mem, mut file) = created();
		let mut gone = Writer::new(b"AAAAAAAAAAAAAAAA", Some(WaitKey::default()));
		assert!(!gone.poll_once(file.as_mut()), "a provider write waits");
		drop(gone);
		let mut next = Writer::new(b"BBBBBBBBBBBBBBBB", None);
		next.finish(file.as_mut());
		drop(file);
		let data = contents(&mem, "mem://d/two");
		// The gone task's first write ran: the provider writes 4 bytes a call.
		assert_eq!(count(&data), (4, 16), "{}", String::from_utf8_lossy(&data));
	}

	// Failure mode: a task that found a result kept for another task waited
	// until that task took it. The engine's key stays while the file is open,
	// so a result kept for an engine vproc killed while its write ran held the
	// file for good.
	#[test]
	fn a_write_does_not_wait_for_another_task_to_take_its_result() {
		let (_rt, mem, mut file) = created();
		let mut a = Writer::new(b"AAAAAAAAAAAAAAAA", None);
		let mut b = Writer::new(b"BBBBBBBBBBBBBBBB", Some(WaitKey::default()));
		assert!(!a.poll_once(file.as_mut()), "a provider write waits");
		until(|| a.woken());
		// `a` never polls again: `b` finds `a`'s result kept for it.
		b.finish(file.as_mut());
		drop(file);
		let data = contents(&mem, "mem://d/two");
		// `a`'s first write ran: the provider writes 4 bytes a call.
		assert_eq!(count(&data), (4, 16), "{}", String::from_utf8_lossy(&data));
	}

	// Failure mode: as above, the engine closing the file (a flush) waited
	// for its own write's result to be taken, by a vproc that never polls
	// again.
	#[test]
	fn a_flush_does_not_wait_for_a_write_result_kept_for_its_task() {
		let (_rt, mem, mut file) = created();
		let mut a = Writer::new(b"AAAAAAAAAAAAAAAA", None);
		assert!(!a.poll_once(file.as_mut()), "a provider write waits");
		until(|| a.woken());
		drive(|cx| file.poll_flush(cx)).unwrap();
		let mut key = WaitKey::default();
		drive(|cx| file.poll_flush_keyed(cx, &mut key)).unwrap();
		drop(file);
		assert_eq!(count(&contents(&mem, "mem://d/two")), (4, 0));
	}

	// Failure mode (beside 64 busy loops on gVisor, the extra and printf
	// test below hung in 2 runs of 10): a native extra closing its handle
	// flushed the file with no key, as the engine, and its thread's waker
	// replaced the engine's: the engine's write was never woken.
	#[test]
	fn a_flush_with_a_key_leaves_the_engine_its_wait() {
		let (_rt, mem, mut file) = created();
		let mut a = Writer::new(b"AAAAAAAAAAAAAAAA", None);
		let flushed = Arc::new(Woken::default());
		let fw = Waker::from(Arc::clone(&flushed));
		let mut key = WaitKey::default();
		mem.hold.on.store(true, Ordering::SeqCst);
		assert!(!a.poll_once(file.as_mut()), "a provider write waits");
		assert!(
			file
				.poll_flush_keyed(&mut Context::from_waker(&fw), &mut key)
				.is_pending(),
			"the write is under way"
		);
		mem.hold.on.store(false, Ordering::SeqCst);
		let flush_woken = || flushed.0.load(Ordering::SeqCst);
		until(|| a.woken() && flush_woken());
		a.finish(file.as_mut());
		drive(|cx| file.poll_flush_keyed(cx, &mut key)).unwrap();
		drop(file);
		assert_eq!(count(&contents(&mem, "mem://d/two")), (16, 0));
	}

	/// What a test does beside a run, from a thread of its own: it gets the
	/// provider's [`Hold`] (on from the start), the run's stdin and its
	/// stderr, and must turn the hold off.
	type Driver = Box<dyn FnOnce(Arc<Hold>, std::io::PipeWriter, std::io::PipeReader) + Send>;

	/// Run `command` in a shell over `mem://`, and return `mem://d/both`.
	/// Without a driver, stdin and stderr are `/dev/null` and nothing is held.
	fn shell_writes(command: &str, driver: Option<Driver>) -> Vec<u8> {
		use std::os::fd::OwnedFd;
		let rt = runtime();
		let mem = MemFs::seeded();
		let fs = vfs(&rt, Arc::clone(&mem));
		let null = |write: bool| {
			std::fs::OpenOptions::new()
				.read(!write)
				.write(write)
				.open("/dev/null")
				.unwrap()
		};
		let (stdin, stderr) = match driver {
			None => (null(false), null(true)),
			Some(driver) => {
				let (in_r, in_w) = std::io::pipe().unwrap();
				let (err_r, err_w) = std::io::pipe().unwrap();
				mem.hold.on.store(true, Ordering::SeqCst);
				let hold = Arc::clone(&mem.hold);
				thread::spawn(move || driver(hold, in_w, err_r));
				(std::fs::File::from(OwnedFd::from(in_r)), std::fs::File::from(OwnedFd::from(err_w)))
			},
		};
		let cwd = std::env::current_dir().unwrap();
		let env = std::env::vars_os()
			.filter(|(name, _)| !name.as_encoded_bytes().starts_with(b"PI_"))
			.map(|(k, v)| (BString::from(k.as_encoded_bytes()), BString::from(v.as_encoded_bytes())))
			.collect();
		let ended = rt.block_on(async {
			let mut s = Session::new(SessionConfig {
				env,
				cwd: BString::from(cwd.as_os_str().as_encoded_bytes()),
				fs: Box::new(fs.clone()),
				vfs: Some(fs),
				runtime: tokio::runtime::Handle::current(),
				output_decoding: None,
			})
			.unwrap();
			let stdio =
				RunStdio { stdin: Some(stdin), stdout: Some(null(true)), stderr: Some(stderr) };
			s.run_with(RunOptions::new(command), stdio, CancellationToken::new())
				.await
		});
		// Whatever the driver did, nothing stays held.
		mem.hold.on.store(false, Ordering::SeqCst);
		assert_eq!(ended.unwrap().status, 0, "{command}");
		contents(&mem, "mem://d/both")
	}

	/// How many NULs, `0`s and spaces.
	#[expect(clippy::naive_bytecount, reason = "a few bytes; no bytecount dependency")]
	fn kinds(data: &[u8]) -> (usize, usize, usize) {
		let n = |c: u8| data.iter().filter(|&&b| b == c).count();
		(n(0), n(b'0'), n(b' '))
	}

	// Failure mode: a native extra and `printf` wrote one provider fd: the
	// one that polled second took the other's write as its own (4 NULs
	// lost, 4 '0's written twice).
	#[test]
	fn an_extra_and_printf_on_one_provider_fd_each_write_once() {
		let data =
			shell_writes("{ head -c 256 /dev/zero & printf '%0256d' 0; wait; } > mem://d/both", None);
		assert_eq!(kinds(&data), (256, 256, 0));
	}

	// Failure mode: a native extra closed its stdout while the engine's
	// write to the same provider file was under way, and the close took that
	// write's result: `x` was written twice. The order is forced by events:
	// `printf`'s write is held; only then does `cat` read the end of its
	// input (a `gate` file) and close its stdout; the hold ends once the
	// close found the write under way. (This member's first version hung
	// here before #111's round 6, when the engine wrote with no key; since
	// each vproc writes with its own key, that hang cannot happen, and this
	// test passes at the first version.)
	#[test]
	fn an_extra_closing_during_the_engines_write_leaves_the_engine_its_wake() {
		let before = crate::vfs::FLUSH_WAITS.load(Ordering::SeqCst);
		let overlapped = Arc::new(AtomicBool::new(false));
		let seen = Arc::clone(&overlapped);
		let data = shell_writes(
			": > mem://d/gate; { cat < mem://d/gate & printf x; wait; } > mem://d/both",
			Some(Box::new(move |hold, _stdin, _stderr| {
				let flushed = || crate::vfs::FLUSH_WAITS.load(Ordering::SeqCst) > before;
				until(|| hold.waiting.load(Ordering::SeqCst) > 0);
				until(flushed);
				seen.store(true, Ordering::SeqCst);
				hold.on.store(false, Ordering::SeqCst);
			})),
		);
		assert!(overlapped.load(Ordering::SeqCst), "the extra's close never met the held write");
		assert_eq!(data, b"x");
	}

	// Failure mode (the fork peer's question on the engine's one key): a
	// vproc killed while its write ran left that write's result kept; the
	// next write to the file, by another vproc, took it as its own (a count
	// of 4 for `x`: `x` was never written). Each vproc writes with its own
	// key, and a killed vproc's key goes with it, so its result goes nowhere.
	// The order is forced by events: the background write is held; `go` is
	// sent only then; the job is killed and reaped (`waited` on stderr)
	// while the write is still held, and only then does the hold end. It
	// kills `%1`, not `$!`: reading `$!` of a background fast-path builtin
	// waits until that job ends, here for the held write.
	#[test]
	fn a_write_after_a_killed_vprocs_write_is_counted_as_its_own() {
		use std::io::{BufRead, Write};
		let steps = Arc::new(Mutex::new(Vec::<String>::new()));
		let seen = Arc::clone(&steps);
		let data = shell_writes(
			"{ printf %016d 0 & read -r go; echo read >&2; kill %1; echo sent >&2; wait; echo waited \
			 >&2; printf x; echo wrote >&2; } > mem://d/both",
			Some(Box::new(move |hold, mut stdin, stderr| {
				// Each step also goes to the test's output, which a hang's
				// report keeps.
				let note = |step: String| {
					eprintln!("step: {step}");
					seen.lock().push(step);
				};
				// The background `printf`'s first provider write is held.
				until(|| hold.waiting.load(Ordering::SeqCst) > 0);
				{
					note("held".into());
					stdin.write_all(b"go\n").unwrap();
					let (tx, rx) = std::sync::mpsc::channel();
					thread::spawn(move || {
						for line in std::io::BufReader::new(stderr).lines() {
							let Ok(line) = line else { break };
							if tx.send(line).is_err() {
								break;
							}
						}
					});
					// The hold ends once the killed job is reaped (`waited`).
					for line in &rx {
						let done = line == "waited";
						note(line);
						if done {
							break;
						}
					}
					hold.on.store(false, Ordering::SeqCst);
					// The rest of the run's steps, until its stderr closes.
					for line in rx {
						note(line);
					}
				}
				hold.on.store(false, Ordering::SeqCst);
			})),
		);
		// The killed vproc's one held write went out (4 bytes a call).
		assert_eq!(data, b"0000x", "{}; steps {:?}", String::from_utf8_lossy(&data), steps.lock());
	}

	/// Three runs of one session: `exec 3>mem://d/both`; `second`, whose
	/// first provider write is held, then cancelled (with `cancel`; else
	/// `second` ends the shell itself) and the hold ended; `printf x >&3`.
	/// The second run's status, and what the file holds.
	fn drop_a_held_write(second: &str, cancel: bool) -> (i32, Vec<u8>) {
		let rt = runtime();
		let mem = MemFs::seeded();
		let fs = vfs(&rt, Arc::clone(&mem));
		let null = |write: bool| {
			std::fs::OpenOptions::new()
				.read(!write)
				.write(write)
				.open("/dev/null")
				.unwrap()
		};
		let stdio = || RunStdio {
			stdin:  Some(null(false)),
			stdout: Some(null(true)),
			stderr: Some(null(true)),
		};
		let cwd = std::env::current_dir().unwrap();
		let env = std::env::vars_os()
			.filter(|(name, _)| !name.as_encoded_bytes().starts_with(b"PI_"))
			.map(|(k, v)| (BString::from(k.as_encoded_bytes()), BString::from(v.as_encoded_bytes())))
			.collect();
		let (opened, dropped, last) = rt.block_on(async {
			let mut s = Session::new(SessionConfig {
				env,
				cwd: BString::from(cwd.as_os_str().as_encoded_bytes()),
				fs: Box::new(fs.clone()),
				vfs: Some(fs),
				runtime: tokio::runtime::Handle::current(),
				output_decoding: None,
			})
			.unwrap();
			let mut run = async |command: &str, cancel: CancellationToken| {
				s.run_with(RunOptions::new(command), stdio(), cancel)
					.await
					.unwrap()
			};
			let opened = run("exec 3>mem://d/both", CancellationToken::new())
				.await
				.status;
			// The second run's first provider write is held; then the run is
			// cancelled, or ends the shell itself, and the hold ends.
			mem.hold.on.store(true, Ordering::SeqCst);
			let token = CancellationToken::new();
			let canceller = cancel.then(|| {
				let (token, hold) = (token.clone(), Arc::clone(&mem.hold));
				thread::spawn(move || {
					until(|| hold.waiting.load(Ordering::SeqCst) > 0);
					token.cancel();
				})
			});
			let dropped = run(second, token).await;
			if let Some(canceller) = canceller {
				canceller.join().unwrap();
			}
			mem.hold.on.store(false, Ordering::SeqCst);
			let last = run("printf x >&3", CancellationToken::new()).await.status;
			(opened, dropped, last)
		});
		assert_eq!(
			(opened, dropped.cancelled, last),
			(0, cancel, 0),
			"`{second}`: (the open's status, cancelled, the last run's status)"
		);
		(dropped.status, contents(&mem, "mem://d/both"))
	}

	// Failure mode (review of #132 at 8ad966d5): a run cancelled while its
	// write to a provider file was held dropped the write, but the session's
	// vproc kept its write key, so the result kept for that key went to its
	// next write: `printf x >&3` in the next run exited 0 and `x` was never
	// written (the file held `AAAA`). The dropped command takes the key with
	// it (#111's `forget_parked_write`): `AAAA`, then `x`.
	#[test]
	fn a_write_after_a_cancelled_runs_held_write_is_its_own() {
		let (_, data) = drop_a_held_write("printf AAAAAAAA >&3", true);
		// The cancelled run's one held write went out (4 bytes a call).
		assert_eq!(data, b"AAAAx", "{}", String::from_utf8_lossy(&data));
	}

	// Failure mode (review of #132 at 4b045c4d, item 1): a host tool's held
	// write, `nohup --version >&3` or `timeout --version >&3`, dropped by a
	// cancel or by `kill -TERM $$`, left its result kept under the vproc's
	// key, which the tool wrote with: the next run's `printf x >&3` took it,
	// exited 0 and was never written (the file held `nohu`). A host callout
	// writes with a key of the call's own, which goes with the call (#111's
	// round 9): the tool's held 4 bytes, then `x`. The kill waits for the
	// tool's write to be held: the job reads a `gate` file, whose reads wait
	// until a write waits on the hold.
	#[test]
	fn a_write_after_a_tools_dropped_held_write_is_its_own() {
		let mut wrong = Vec::new();
		let killed = ": >mem://d/gate; { read -r g <mem://d/gate; kill -TERM $$; } & ";
		for (how, ends, cancel) in [("cancelled", "", true), ("killed", killed, false)] {
			for (tool, held) in [("nohup", b"nohu"), ("timeout", b"time")] {
				let (status, data) = drop_a_held_write(&format!("{ends}{tool} --version >&3"), cancel);
				let mut want = held.to_vec();
				want.push(b'x');
				if data != want {
					wrong.push(format!(
						"{tool} {how} (status {status}): {:?}",
						String::from_utf8_lossy(&data)
					));
				}
			}
		}
		assert!(wrong.is_empty(), "{}", wrong.join("; "));
	}

	// Failure mode (review of #132 at 4b045c4d, item 3; older than #132):
	// `fc -s` started its echo's write to a provider file, left it part way
	// when the write pended, and queued all its bytes again; the command it
	// ran wrote next under the same key and took the echo's result: the file
	// held `prinprintf Z >&2\n`. `fc` now parks until its echo is written,
	// then runs the command: `printf Z >&2`, a newline, then `Z`, as bash
	// 5.2.21 and 5.3.20 write it.
	#[test]
	fn fc_writes_its_echo_whole_before_the_command_it_runs() {
		let data = shell_writes("{ history -s 'printf Z >&2'; fc -s; } 2>mem://d/both", None);
		assert_eq!(data, b"printf Z >&2\nZ", "{}", String::from_utf8_lossy(&data));
	}

	// Two vprocs write one provider fd as its one owner (a background job
	// shares its parent's fd objects, and the engine's polls are keyless).
	// This passed before the fix too; it stays as a guard on keyless writes
	// from two vprocs.
	#[test]
	fn two_printfs_on_one_provider_fd_each_write_once() {
		let data =
			shell_writes("{ printf '%0256d' 0 & printf '%256s' ''; wait; } > mem://d/both", None);
		assert_eq!(kinds(&data), (0, 256, 256));
	}
}
