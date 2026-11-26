use std::{
	future::Future,
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::Duration,
};

use futures::StreamExt;

use super::*;
use crate::testing::{MemFs, settle};
#[cfg(unix)]
use crate::{
	fs::seam::Open,
	testing::{Outside, SwapTree, escaped},
};

/// A unique, canonical temporary directory removed on drop.
struct TempDir(PathBuf);

impl TempDir {
	fn new(name: &str) -> Self {
		static NEXT: AtomicUsize = AtomicUsize::new(0);
		let n = NEXT.fetch_add(1, Ordering::Relaxed);
		let base = crate::testing::temp_root()
			.canonicalize()
			.expect("temp dir canonicalizes");
		let path = base.join(format!("pi-walker-walk-{}-{n}-{name}", std::process::id()));
		let _ = std::fs::remove_dir_all(&path);
		std::fs::create_dir_all(&path).expect("temp dir is created");
		Self(path)
	}

	fn path(&self) -> &Path {
		&self.0
	}
}

impl Drop for TempDir {
	fn drop(&mut self) {
		#[cfg(unix)]
		restore_permissions(&self.0);
		let _ = std::fs::remove_dir_all(&self.0);
	}
}

/// Makes every directory below `path` accessible again so it can be removed.
#[cfg(unix)]
fn restore_permissions(path: &Path) {
	use std::os::unix::fs::PermissionsExt;
	let Ok(meta) = std::fs::symlink_metadata(path) else {
		return;
	};
	if !meta.is_dir() {
		return;
	}
	let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
	if let Ok(entries) = std::fs::read_dir(path) {
		for entry in entries.flatten() {
			restore_permissions(&entry.path());
		}
	}
}

/// A chain of directories named `d` from `parent/d` down, as deep as paths
/// may go, made for a test; dropping it removes the chain deepest first, by
/// path, with the files in each level. Left to [`TempDir`]'s drop, the chain
/// would be walked by [`restore_permissions`] and then
/// `std::fs::remove_dir_all`, which each keep a descriptor open for every
/// level they are inside: about 2,000 for this chain. Past the descriptor
/// limit (1,024 by default on Linux) both stop with `EMFILE` and leave the
/// chain behind, and while they hold their descriptors a test beside it in
/// this process that opens a file can get `EMFILE` too.
#[cfg(unix)]
struct DeepChain {
	/// The first level.
	top:     PathBuf,
	deepest: PathBuf,
}

#[cfg(unix)]
impl DeepChain {
	/// Makes the chain below `parent`, calling `fill` on each level once it is
	/// made. Each level is removed by its path, which must stay under
	/// `PATH_MAX`: the depth keeps `leaf` in the deepest level 96 bytes under
	/// it, and the names `fill` and the test write must fit in that.
	fn create(parent: &Path, mut fill: impl FnMut(&Path)) -> Self {
		let path_max = usize::try_from(libc::PATH_MAX).expect("PATH_MAX is positive");
		// Every level adds "/d".
		let depth = (path_max - 96 - parent.join("leaf").as_os_str().len()) / 2;
		let mut deepest = parent.to_path_buf();
		for _ in 0..depth {
			deepest.push("d");
			std::fs::create_dir(&deepest).expect("level");
			fill(&deepest);
		}
		Self { top: parent.join("d"), deepest }
	}

	fn deepest(&self) -> &Path {
		&self.deepest
	}
}

#[cfg(unix)]
impl Drop for DeepChain {
	fn drop(&mut self) {
		let mut level = self.deepest.clone();
		while level.starts_with(&self.top) {
			for entry in std::fs::read_dir(&level).into_iter().flatten().flatten() {
				let _ = std::fs::remove_file(entry.path());
			}
			if std::fs::remove_dir(&level).is_err() {
				break;
			}
			level.pop();
		}
		if !std::thread::panicking() {
			assert!(
				std::fs::symlink_metadata(&self.top).is_err(),
				"DeepChain left {} behind",
				self.top.display()
			);
		}
	}
}

/// A temporary tree of files (contents after `=`) and directories (trailing
/// `/`).
fn make_tree(name: &str, specs: &[&str]) -> TempDir {
	let dir = TempDir::new(name);
	for spec in specs {
		let (name, contents) = spec.split_once('=').unwrap_or((spec, ""));
		let path = dir.path().join(name);
		if name.ends_with('/') {
			std::fs::create_dir_all(&path).expect("directory is created");
			continue;
		}
		std::fs::create_dir_all(path.parent().expect("file has a parent"))
			.expect("parent is created");
		std::fs::write(&path, contents).expect("file is written");
	}
	dir
}

#[cfg(unix)]
fn symlink(target: &str, link: &Path) {
	std::os::unix::fs::symlink(target, link).expect("symlink is created");
}

fn lossy(entry: &Entry<'_>) -> String {
	entry.path_lossy().into_owned()
}

/// Runs a walk to its end: every output and the directory errors.
async fn drain<T, V>(
	fs: &Fs,
	root: &Path,
	opts: &Options,
	visit: V,
) -> Result<(Vec<T>, Vec<DirError>), WalkError>
where
	T: Send + 'static,
	V: Fn(&mut Worker<'_>, &Entry<'_>, &mut Vec<T>) -> Action + Send + Sync + 'static,
{
	let mut walked = walk(fs, root, opts, visit).await?;
	let mut out = Vec::new();
	while let Some(batch) = walked.next().await {
		assert!(!batch.items.is_empty(), "empty batches are never sent");
		out.extend(batch.items);
	}
	Ok((out, walked.into_errors()))
}

/// Walks `root` and reads every file through the directory handle its batch
/// carries: (path, absolute path, contents).
async fn read_through_batches(
	fs: &Fs,
	root: &Path,
	opts: &Options,
) -> Vec<(String, PathBuf, Vec<u8>)> {
	let mut walked =
		walk(fs, root, opts, |worker, entry, out: &mut Vec<(String, Vec<u8>, PathBuf)>| {
			if entry.file_type == FileType::File {
				out.push((lossy(entry), entry.name().to_vec(), worker.abs(entry).to_path_buf()));
			}
			Action::Continue
		})
		.await
		.expect("walk");
	let mut session = fs.session();
	let mut seen = Vec::new();
	while let Some(batch) = walked.next().await {
		let dir = batch
			.dir
			.expect("an uncached walk keeps its directories open");
		for (path, name, abs) in batch.items {
			let (mut file, info) = session
				.open_file_at(&dir, &name, false)
				.await
				.expect("open");
			assert_eq!(info.size, file.size());
			let mut buf = Vec::new();
			file.read_into(&mut buf, 1 << 20).await.expect("read");
			seen.push((path, abs, buf));
		}
	}
	seen.sort();
	seen
}

/// Runs `fut` on a runtime whose threads have small stacks, so a traversal
/// that recursed (or held a deep ignore chain's drop on the stack) would
/// overflow.
async fn on_small_stack<F>(fut: F) -> F::Output
where
	F: Future + Send + 'static,
	F::Output: Send + 'static,
{
	let runtime = tokio::runtime::Builder::new_multi_thread()
		.worker_threads(1)
		.thread_stack_size(256 * 1024)
		.enable_all()
		.build()
		.expect("runtime");
	let out = runtime.spawn(fut).await.expect("no stack overflow");
	runtime.shutdown_background();
	out
}

/// A listing cache that lives as long as the process, as walks require.
fn leaked_cache(max_bytes: i64) -> &'static cache::Cache {
	Box::leak(Box::new(cache::Cache::new(max_bytes)))
}

/// Collects the paths `opts` admits below `root`, checking that sorted
/// collect is in byte order and that unsorted collect and walk agree with it.
async fn paths_in(fs: &Fs, root: &Path, opts: &Options) -> Vec<String> {
	let sorted = collect(fs, root, opts, true, |_, _| Action::Continue)
		.await
		.expect("collect");
	let got: Vec<String> = sorted.iter().map(|entry| lossy(&entry)).collect();
	assert!(got.is_sorted(), "sorted collect out of order: {got:?}");
	let unordered = collect(fs, root, opts, false, |_, _| Action::Continue)
		.await
		.expect("collect");
	let mut unordered: Vec<String> = unordered.iter().map(|entry| lossy(&entry)).collect();
	unordered.sort();
	assert_eq!(unordered, got, "unsorted collect disagrees");
	let (mut streamed, _) = drain(fs, root, opts, |_, entry, out: &mut Vec<String>| {
		out.push(lossy(entry));
		Action::Continue
	})
	.await
	.expect("walk");
	streamed.sort();
	assert_eq!(streamed, got, "walk disagrees");
	got
}

async fn paths(root: &Path, opts: &Options) -> Vec<String> {
	paths_in(&Fs::native(), root, opts).await
}

fn sorted(mut want: Vec<&str>) -> Vec<String> {
	want.sort_unstable();
	want.into_iter().map(str::to_owned).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn pruning_options() {
	let tmp = make_tree("pruning", &[
		"a.txt",
		".env",
		".hidden/x.txt",
		".git/config",
		"node_modules/m/i.js",
		"src/main.go",
		"src/node_modules",
		"src/.git",
	]);
	assert_eq!(
		paths(tmp.path(), &Options::default()).await,
		sorted(vec![
			"a.txt",
			"node_modules",
			"node_modules/m",
			"node_modules/m/i.js",
			"src",
			"src/main.go",
			"src/node_modules",
		])
	);
	let opts =
		Options { hidden: true, skip_git: true, skip_node_modules: true, ..Default::default() };
	assert_eq!(
		paths(tmp.path(), &opts).await,
		sorted(vec![".env", ".hidden", ".hidden/x.txt", "a.txt", "src", "src/main.go"])
	);
	let opts = Options { hidden: true, max_depth: Some(1), ..Default::default() };
	assert_eq!(
		paths(tmp.path(), &opts).await,
		sorted(vec![".env", ".git", ".hidden", "a.txt", "node_modules", "src"])
	);
	let opts = Options { hidden: true, max_depth: Some(0), ..Default::default() };
	assert!(paths(tmp.path(), &opts).await.is_empty());
	// One filesystem throughout: staying on it prunes nothing.
	let all = paths(tmp.path(), &Options { hidden: true, ..Default::default() }).await;
	let opts = Options { hidden: true, same_file_system: true, ..Default::default() };
	assert_eq!(paths(tmp.path(), &opts).await, all);
	let tree_opts = TreeOptions { same_file_system: true, ..Default::default() };
	assert_eq!(tree_paths(tmp.path(), &tree_opts).await, all);
}

#[tokio::test(flavor = "multi_thread")]
async fn ignore_precedence() {
	let tmp = make_tree("precedence", &[
		".git/info/exclude=excluded.txt\n",
		".gitignore=*.log\n!keep.log\nbuild/\n",
		".ignore=!forced.log\n",
		"keep.log",
		"drop.log",
		"forced.log",
		"excluded.txt",
		"build/out.txt",
		"plain/build",
		"sub/.gitignore=!drop.log\n",
		"sub/drop.log",
		"sub/x.log",
	]);
	let opts = Options { gitignore: true, ..Default::default() };
	assert_eq!(
		paths(tmp.path(), &opts).await,
		sorted(vec!["forced.log", "keep.log", "plain", "plain/build", "sub", "sub/drop.log"])
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn ancestor_rules_covering_the_root_are_dropped() {
	let repo = make_tree("ancestors", &[
		".git/",
		".gitignore=target/\n*.o\n",
		"target/sub/a.o",
		"target/sub/b.txt",
	]);
	let opts = Options { gitignore: true, ..Default::default() };
	assert_eq!(paths(&repo.path().join("target/sub"), &opts).await, sorted(vec!["b.txt"]));
	assert_eq!(paths(&repo.path().join("target"), &opts).await, sorted(vec!["sub", "sub/b.txt"]));
	assert!(paths(repo.path(), &opts).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn sorted_collect_matches_full_path_order() {
	let tmp = make_tree("order", &["a/x", "a-b", "a.c", "B", "_", "a/y/z", "a0", "é"]);
	let opts = Options { workers: Some(3), ..Default::default() };
	let got = collect(&Fs::native(), tmp.path(), &opts, true, |_, _| Action::Continue)
		.await
		.expect("collect");
	let got: Vec<String> = got.iter().map(|entry| lossy(&entry)).collect();
	assert_eq!(got, ["B", "_", "a", "a-b", "a.c", "a/x", "a/y", "a/y/z", "a0", "é"]);
}

/// Enough directories and long names that work is shared between workers
/// and paths span several arena chunks.
#[tokio::test(flavor = "multi_thread")]
async fn wide_trees_agree_on_every_worker_count() {
	let tmp = TempDir::new("wide");
	let long = "n".repeat(120);
	for d in 0..60 {
		for s in 0..3 {
			let dir = tmp.path().join(format!("d{d:02}/s{s}"));
			std::fs::create_dir_all(&dir).expect("dir");
			for f in 0..6 {
				std::fs::write(dir.join(format!("{long}-{f}")), "").expect("file");
			}
		}
	}
	let baseline = paths(tmp.path(), &Options { workers: Some(1), ..Default::default() }).await;
	assert_eq!(baseline.len(), 60 + 60 * 3 + 60 * 3 * 6);
	for workers in [2, 4, 8] {
		let opts = Options { workers: Some(workers), ..Default::default() };
		assert_eq!(paths(tmp.path(), &opts).await, baseline, "workers={workers}");
	}
}

/// Every walk ends, also when a waiting worker's wakeup is lost: flume
/// 0.12's `recv_async` misses a message sent while it re-registers after
/// another worker took the message it was woken for (zesterer/flume#177).
/// Ending the walk with one stop message per worker left such a worker
/// waiting forever, and its walk with it. The machine's CPU count caps the
/// walk's workers and the runtime's threads, and with them the test's power:
/// against the old stop it hung on 8 and 16 CPUs, and was not seen in 5 runs
/// on 4. `stopping_a_walk_closes_its_job_queue` checks the same fix on any
/// number of CPUs.
#[tokio::test(flavor = "multi_thread")]
async fn walks_end_when_a_waiting_worker_misses_a_wakeup() {
	let tmp = make_tree("ends", &["a.txt", "d1/x", "d2/y", "d3/z", "d4/w", "d5/v/u"]);
	let fs = Fs::native();
	let opts = Options { workers: Some(8), ..Default::default() };
	let (mut complete, mut root_failed, mut dir_failed) = (0, 0, 0);
	for round in 0..20_000 {
		let walked = drain(&fs, tmp.path(), &opts, |_, _, out: &mut Vec<()>| {
			out.push(());
			Action::Continue
		});
		let walked = tokio::time::timeout(Duration::from_secs(30), walked)
			.await
			.unwrap_or_else(|_| panic!("walk {round} did not end"));
		// A walk that cannot open its root or a directory, as past the
		// open-file limit while other tests in the process hold files, has
		// still ended: it is counted and skipped.
		let Ok((visited, errors)) = walked else {
			root_failed += 1;
			continue;
		};
		if !errors.is_empty() {
			dir_failed += 1;
			continue;
		}
		assert_eq!(visited.len(), 12, "walk {round}");
		complete += 1;
	}
	// The 30 s limit catches the hang on every walk that runs; the floor
	// fails a run in which more than 1,000 of the 20,000 walks could not open
	// their root or a directory.
	assert!(
		complete >= 19_000,
		"{complete} of 20,000 walks complete, fewer than 19,000; {root_failed} could not open the \
		 root and {dir_failed} could not open a directory"
	);
}

/// A visitor panic ends the walk on every worker: the panicking job never
/// counts itself done, so only the queue's close (`Owned`'s drop) ends the
/// other workers' waits.
#[tokio::test(flavor = "multi_thread")]
async fn a_panicking_visitor_ends_the_walk_on_every_worker() {
	let paths: Vec<String> = (0..24)
		.flat_map(|d| (0..4).map(move |s| format!("mem://visitor-panics/dir/d{d:02}/s{s}/f")))
		.collect();
	let files: Vec<(&str, &str)> = paths.iter().map(|path| (path.as_str(), "")).collect();
	let (_mem, blocking) = MemFs::with_files(&files);
	let fs = Fs::Provider(blocking);
	let opts = Options { workers: Some(8), ..Default::default() };
	let run = tokio::spawn(async move {
		drain(&fs, Path::new("mem://visitor-panics/dir"), &opts, |_, entry, out: &mut Vec<()>| {
			assert_ne!(entry.path, b"d11/s2", "visitor boom");
			out.push(());
			Action::Continue
		})
		.await
	});
	let joined = tokio::time::timeout(Duration::from_secs(30), run)
		.await
		.expect("the walk did not end after a visitor panic");
	let error = joined.expect_err("the visitor panic did not resume in the consumer");
	assert!(error.is_panic(), "the walk task ended without the visitor's panic: {error:?}");
}

/// Stopping a walk closes its job queue, so every worker still waiting on it
/// leaves, also one whose wakeup flume lost: flume 0.12's `recv_async` checks
/// again for a closed queue after it re-registers to wait (`src/async.rs`,
/// lines 432-446). One stop message per worker left the queue open, and such
/// a worker waiting forever. Unlike the stress test, this needs no lost
/// wakeup, so it fails against the old stop on any number of CPUs.
#[tokio::test(flavor = "multi_thread")]
async fn stopping_a_walk_closes_its_job_queue() {
	let (_mem, blocking) = MemFs::with_files(&[
		("mem://stop-closes/dir/a.txt", ""),
		("mem://stop-closes/dir/sub/b.txt", ""),
	]);
	let fs = Fs::Provider(blocking);
	let keep = parallel::CollectSink::new(|_: &mut Worker<'_>, _: &mut Entry<'_>| Action::Continue);
	let started = parallel::start(
		&fs,
		Path::new("mem://stop-closes/dir"),
		&Options::default(),
		keep,
		false,
		None,
		None,
	)
	.await
	.expect("walk");
	tokio::time::timeout(Duration::from_secs(30), started.finished())
		.await
		.expect("the walk ends");
	assert!(
		started.queue_closed(),
		"the job queue was still open after the walk stopped; an open queue leaves a worker still \
		 waiting on it waiting forever"
	);
}

/// A walk dropped before its seed worker's first poll frees no path another
/// worker is reading. The seed's arena holds the root's children, which the
/// queued jobs name; when the seed's scratch went with its never-polled task,
/// a worker listing one of those jobs read freed memory.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_walk_dropped_before_its_seed_runs_keeps_job_paths_alive() {
	let fs = Fs::native();
	let opts = Options { workers: Some(2), ..Default::default() };
	// With one worker there is only the seed, and no other worker to read.
	if opts.parallelism(&fs) < 2 {
		return;
	}
	let tmp = make_tree("seed-held", &["seed-held-probe/x", "other/y"]);
	let seed_dropped = parallel::seam::hold_seed(tmp.path());
	let (paused, reached) = tokio::sync::oneshot::channel();
	let (verdict, checked) = tokio::sync::oneshot::channel();
	parallel::seam::before_listing("seed-held-probe", move |rel| {
		let chunk = arena::seam::chunk_of(rel).expect("a job's path lives in an arena chunk");
		let _ = paused.send(());
		// Disconnects once the dropped walk's seed task is gone.
		let _ = seed_dropped.recv();
		let _ = verdict.send(arena::seam::is_live(chunk));
	});
	// Items for the root's entries make the seed settle the root, so every
	// subdirectory job goes to the queue, for the other worker.
	let walked = walk(&fs, tmp.path(), &opts, |_, _, out: &mut Vec<()>| {
		out.push(());
		Action::Continue
	})
	.await
	.expect("walk");
	tokio::time::timeout(Duration::from_secs(30), reached)
		.await
		.expect("a worker lists the probe directory")
		.expect("the probe pauses");
	drop(walked);
	let live = tokio::time::timeout(Duration::from_secs(30), checked)
		.await
		.expect("the seed task is dropped")
		.expect("the probe reports");
	assert!(live, "a worker's job path was freed with the seed worker's task");
}

#[tokio::test(flavor = "multi_thread")]
async fn visitor_actions() {
	let tmp = make_tree("actions", &["keep/a", "skip/b", "skip/c/d"]);
	let opts = Options { workers: Some(1), ..Default::default() };
	let (mut seen, _) =
		drain(&Fs::native(), tmp.path(), &opts, |_, entry, out: &mut Vec<String>| {
			out.push(lossy(entry));
			if entry.path == b"skip" {
				Action::SkipDir
			} else {
				Action::Continue
			}
		})
		.await
		.expect("walk");
	seen.sort();
	assert_eq!(seen, ["keep", "keep/a", "skip"]);

	let (visits, _) = drain(&Fs::native(), tmp.path(), &opts, |_, _, out: &mut Vec<()>| {
		out.push(());
		Action::Stop
	})
	.await
	.expect("a visitor stop is not an error");
	assert_eq!(visits.len(), 1);

	// Skip leaves a directory out of a collection but keeps its contents.
	let kept = collect(&Fs::native(), tmp.path(), &opts, true, |_, entry| {
		if entry.file_type == FileType::Dir {
			Action::Skip
		} else {
			Action::Continue
		}
	})
	.await
	.expect("collect");
	let kept: Vec<String> = kept.iter().map(|entry| lossy(&entry)).collect();
	assert_eq!(kept, ["keep/a", "skip/b", "skip/c/d"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn collect_filter_rewrites_kept_entries() {
	let tmp = make_tree("rewrite", &["a", "b"]);
	let got = collect(&Fs::native(), tmp.path(), &Options::default(), true, |_, entry| {
		entry.size = Some(42);
		entry.file_type = FileType::Symlink;
		Action::Continue
	})
	.await
	.expect("collect");
	assert!(
		got.iter()
			.all(|entry| entry.size == Some(42) && entry.file_type == FileType::Symlink)
	);
	assert_eq!(got.len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn full_detail_reports_sizes_and_mtimes() {
	let tmp = make_tree("full", &["dir/five=12345", "empty="]);
	let opts = Options { detail: Detail::Full, ..Default::default() };
	let got = collect(&Fs::native(), tmp.path(), &opts, true, |_, _| Action::Continue)
		.await
		.expect("collect");
	for entry in got.iter() {
		let want_size = match entry.path {
			b"dir" => None,
			b"dir/five" => Some(5),
			_ => Some(0),
		};
		assert_eq!(entry.size, want_size, "{}", lossy(&entry));
		let meta = std::fs::symlink_metadata(tmp.path().join(lossy(&entry))).expect("stat");
		let nanos = meta
			.modified()
			.expect("mtime")
			.duration_since(std::time::UNIX_EPOCH)
			.expect("after epoch")
			.as_nanos();
		// NTFS refreshes a directory's entry in its parent's index lazily, so a
		// listing can trail the directory's own mtime there.
		if !(cfg!(windows) && meta.is_dir()) {
			assert_eq!(entry.mtime, Some(i64::try_from(nanos).expect("fits")), "{}", lossy(&entry));
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn batches_carry_the_directory_their_files_open_from() {
	let tmp = make_tree("open", &["x/one=1", "two=22"]);
	let seen = read_through_batches(&Fs::native(), tmp.path(), &Options::default()).await;
	assert_eq!(seen, [
		("two".to_owned(), tmp.path().join("two"), b"22".to_vec()),
		("x/one".to_owned(), tmp.path().join("x").join("one"), b"1".to_vec()),
	]);
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_root_is_a_root_error() {
	let tmp = TempDir::new("missing");
	let root = tmp.path().join("nope");
	let err = collect(&Fs::native(), &root, &Options::default(), true, |_, _| Action::Continue)
		.await
		.expect_err("missing root");
	assert!(matches!(err, WalkError::Root { ref path, .. } if *path == root), "{err:?}");
	let file = make_tree("file-root", &["f"]);
	let err =
		drain(&Fs::native(), &file.path().join("f"), &Options::default(), |_, _, _: &mut Vec<()>| {
			Action::Continue
		})
		.await
		.expect_err("file root");
	assert!(matches!(err, WalkError::Root { .. }));
}

/// Dropping a walk before it ends cancels the tasks still listing: the
/// visitor stops being called.
#[tokio::test(flavor = "multi_thread")]
async fn dropping_a_walk_cancels_it() {
	let tmp = TempDir::new("drop");
	for d in 0..200 {
		let dir = tmp.path().join(format!("d{d:03}"));
		std::fs::create_dir_all(&dir).expect("dir");
		std::fs::write(dir.join("f"), "").expect("file");
	}
	let visits = Arc::new(AtomicUsize::new(0));
	let counted = Arc::clone(&visits);
	let opts = Options { workers: Some(1), ..Default::default() };
	let mut walked = walk(&Fs::native(), tmp.path(), &opts, move |_, _, out: &mut Vec<()>| {
		counted.fetch_add(1, Ordering::Relaxed);
		out.push(());
		Action::Continue
	})
	.await
	.expect("walk");
	assert!(walked.next().await.is_some());
	drop(walked);
	// The workers hold the walk's visitor and with it `counted`: once the
	// aborted workers are gone, nothing can visit any more.
	// Only polling sees the count fall: checks 1 ms apart at first, at most
	// 20 ms apart later. A hang here means the dropped walk kept its workers:
	// the test's bound in `.config/nextest.toml` fails it by name (nextest, or
	// the gate's one-process runner).
	let mut pause = Duration::from_millis(1);
	while Arc::strong_count(&visits) > 1 {
		tokio::time::sleep(pause).await;
		pause = (pause * 2).min(Duration::from_millis(20));
	}
	let settled = visits.load(Ordering::Relaxed);
	assert!(settled < 300, "walk kept visiting after it was dropped: {settled}");
}

/// Signals when dropped.
struct DropSignal(Option<tokio::sync::oneshot::Sender<()>>);

impl Drop for DropSignal {
	fn drop(&mut self) {
		if let Some(signal) = self.0.take() {
			let _ = signal.send(());
		}
	}
}

/// A provider whose first directory listing signals `entered` and then waits
/// on a gate that is never opened, signalling `dropped` if that listing is
/// dropped.
#[derive(Debug)]
struct GatedListing {
	mem:     Arc<MemFs>,
	entered: parking_lot::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
	dropped: parking_lot::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

#[async_trait::async_trait]
impl pi_vfs::FileSystem for GatedListing {
	async fn open(
		&self,
		path: &Path,
		options: &pi_vfs::OpenOptions,
	) -> std::io::Result<pi_vfs::File> {
		pi_vfs::FileSystem::open(&*self.mem, path, options).await
	}

	async fn metadata(&self, path: &Path) -> std::io::Result<pi_vfs::Metadata> {
		pi_vfs::FileSystem::metadata(&*self.mem, path).await
	}

	async fn read_dir(&self, _path: &Path) -> std::io::Result<pi_vfs::ReadDir> {
		let _dropped = DropSignal(self.dropped.lock().take());
		let entered = self.entered.lock().take();
		if let Some(entered) = entered {
			let _ = entered.send(());
		}
		match std::future::pending::<std::convert::Infallible>().await {}
	}
}

/// Dropping a [`walk`] or [`collect`] future while the root listing is still
/// awaiting the provider cancels that listing, and no visitor ever runs.
#[tokio::test(flavor = "multi_thread")]
async fn dropping_a_starting_walk_cancels_the_root_listing() {
	for streaming in [true, false] {
		let (mem, _) = MemFs::with_files(&[("mem://h/dir/a.txt", "")]);
		let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
		let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel();
		let provider = GatedListing {
			mem,
			entered: parking_lot::Mutex::new(Some(entered_tx)),
			dropped: parking_lot::Mutex::new(Some(dropped_tx)),
		};
		let vfs = pi_vfs::Fs::new(Arc::new(provider));
		let root = Path::new("mem://h/dir");
		let fs = Fs::new(&vfs, root);
		let visits = Arc::new(AtomicUsize::new(0));
		let counted = Arc::clone(&visits);
		let starting = async move {
			let opts = Options::default();
			if streaming {
				let _ = walk(&fs, root, &opts, move |_, _, out: &mut Vec<()>| {
					counted.fetch_add(1, Ordering::Relaxed);
					out.push(());
					Action::Continue
				})
				.await;
			} else {
				let _ = collect(&fs, root, &opts, false, move |_, _| {
					counted.fetch_add(1, Ordering::Relaxed);
					Action::Continue
				})
				.await;
			}
		};
		let mut starting = Box::pin(starting);
		tokio::select! {
			() = &mut starting => panic!("a walk over a gated listing cannot finish"),
			entered = entered_rx => entered.expect("the listing is entered"),
		}
		drop(starting);
		tokio::time::timeout(Duration::from_secs(10), dropped_rx)
			.await
			.expect("the dropped walk cancels its pending root listing")
			.expect("the listing signals when dropped");
		assert_eq!(visits.load(Ordering::Relaxed), 0, "streaming {streaming}");
	}
}

#[cfg(unix)]
fn unreadable_dir(path: &Path) -> bool {
	use std::os::unix::fs::PermissionsExt;
	std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o000)).expect("chmod");
	// Privileged runs can read anyway; their tests have nothing to check.
	std::fs::read_dir(path).is_err()
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn unreadable_directories_are_reported() {
	let tmp = make_tree("unreadable", &["locked/x", "open/y"]);
	let locked = tmp.path().join("locked");
	if !unreadable_dir(&locked) {
		return;
	}
	let got = collect(&Fs::native(), tmp.path(), &Options::default(), true, |_, _| Action::Continue)
		.await
		.expect("collect");
	let paths: Vec<String> = got.iter().map(|entry| lossy(&entry)).collect();
	assert_eq!(paths, ["locked", "open", "open/y"]);
	let errors: Vec<&Path> = got
		.errors()
		.iter()
		.map(|error| error.path.as_path())
		.collect();
	assert_eq!(errors, [locked.as_path()]);
	let (_, errors) =
		drain(&Fs::native(), tmp.path(), &Options::default(), |_, _, _: &mut Vec<()>| {
			Action::Continue
		})
		.await
		.expect("walk");
	assert_eq!(errors.len(), 1);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn symlinks_are_reported_not_followed() {
	let tmp = make_tree("links", &["real/f"]);
	symlink("real", &tmp.path().join("link"));
	let got = collect(&Fs::native(), tmp.path(), &Options::default(), true, |_, _| Action::Continue)
		.await
		.expect("collect");
	let got: Vec<(String, FileType)> = got
		.iter()
		.map(|entry| (lossy(&entry), entry.file_type))
		.collect();
	assert_eq!(got, [
		("link".to_owned(), FileType::Symlink),
		("real".to_owned(), FileType::Dir),
		("real/f".to_owned(), FileType::File),
	]);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn follow_links_resolves_targets_and_drops_cycles() {
	let tmp = make_tree("follow", &["real/f=12345", "a/b/g", ".gitignore=ignored\n", "ignored/x"]);
	let root = tmp.path();
	for (name, target) in [
		("link", "real"),
		("file", "real/f"),
		("dangling", "missing"),
		("a/b/up", ".."),
		("a/b/top", "../.."),
		("a/sibling", "../real"),
		("ignoredlnk", "ignored"),
	] {
		symlink(target, &root.join(name));
	}
	let opts =
		Options { gitignore: true, follow_links: true, detail: Detail::Full, ..Default::default() };
	let got = collect(&Fs::native(), root, &opts, true, |_, _| Action::Continue)
		.await
		.expect("collect");
	let typed: Vec<(String, FileType)> = got
		.iter()
		.map(|entry| (lossy(&entry), entry.file_type))
		.collect();
	let dir = FileType::Dir;
	let file = FileType::File;
	let want = [
		("a", dir),
		("a/b", dir),
		("a/b/g", file),
		("a/sibling", dir),
		("a/sibling/f", file),
		("file", file),
		("ignoredlnk", dir),
		("ignoredlnk/x", file),
		("link", dir),
		("link/f", file),
		("real", dir),
		("real/f", file),
	];
	let want: Vec<(String, FileType)> = want
		.iter()
		.map(|&(path, kind)| (path.to_owned(), kind))
		.collect();
	assert_eq!(typed, want);
	let linked = got
		.iter()
		.find(|entry| entry.path == b"file")
		.expect("file link");
	assert_eq!(linked.size, Some(5), "a followed file reports its target's size");
	assert_eq!(
		paths(root, &opts).await,
		want
			.iter()
			.map(|(path, _)| path.clone())
			.collect::<Vec<_>>()
	);

	// Cached listings re-resolve links: retargeting one shows the new tree.
	let cache = leaked_cache(1 << 20);
	let opts = Options { follow_links: true, ..Default::default() };
	let filter = |_: &mut Worker<'_>, _: &mut Entry<'_>| Action::Continue;
	collect_in(&Fs::native(), root, &opts, true, filter, Some(cache))
		.await
		.expect("fill");
	std::fs::remove_file(root.join("link")).expect("unlink");
	symlink("a", &root.join("link"));
	settle();
	let got = collect_in(&Fs::native(), root, &opts, true, filter, Some(cache))
		.await
		.expect("cached");
	let below: Vec<String> = got
		.iter()
		.map(|entry| lossy(&entry))
		.filter(|path| path.starts_with("link/"))
		.collect();
	assert_eq!(below, ["link/b", "link/b/g", "link/sibling", "link/sibling/f"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn provider_walks_use_raw_relative_names_and_url_spellings() {
	let (_mem, blocking) = MemFs::with_files(&[
		("mem://root/dir/a%20b.rs", "alpha"),
		("mem://root/dir/sub/c.rs", "gamma"),
		("mem://root/dir/.gitignore", "*.log\n"),
		("mem://root/dir/x.log", ""),
	]);
	let fs = Fs::Provider(blocking);
	let root = Path::new("mem://root/dir");
	let opts = Options { gitignore: true, ..Default::default() };
	assert_eq!(paths_in(&fs, root, &opts).await, ["a b.rs", "sub", "sub/c.rs"]);
	let seen = read_through_batches(&fs, root, &opts).await;
	assert_eq!(seen, [
		("a b.rs".to_owned(), PathBuf::from("mem://root/dir/a%20b.rs"), b"alpha".to_vec()),
		("sub/c.rs".to_owned(), PathBuf::from("mem://root/dir/sub/c.rs"), b"gamma".to_vec()),
	]);
}

/// Walks `root` with and without `cache`, requiring identical results.
async fn cached_matches_fresh(
	root: &Path,
	cache: &'static cache::Cache,
	opts: &Options,
) -> Vec<String> {
	let fresh = paths(root, opts).await;
	let cached = collect_in(&Fs::native(), root, opts, true, |_, _| Action::Continue, Some(cache))
		.await
		.expect("cached collect");
	let cached: Vec<String> = cached.iter().map(|entry| lossy(&entry)).collect();
	assert_eq!(cached, fresh);
	fresh
}

#[tokio::test(flavor = "multi_thread")]
async fn cache_follows_tree_changes() {
	let tmp = make_tree("cache-changes", &[
		".git/info/",
		".gitignore=*.log\n",
		"a/b/c/keep.txt",
		"a/b/c/drop.log",
		"a/x.txt",
		"gone.txt",
		"swap",
		"moved/inner.txt",
	]);
	let root = tmp.path();
	let cache = leaked_cache(1 << 20);
	let opts = Options { gitignore: true, workers: Some(2), ..Default::default() };
	let steps: [(&str, &dyn Fn()); 6] = [
		("add deep file", &|| std::fs::write(root.join("a/b/c/new.txt"), "").expect("write")),
		("remove file", &|| std::fs::remove_file(root.join("gone.txt")).expect("remove")),
		("rename dir", &|| {
			std::fs::rename(root.join("moved"), root.join("renamed")).expect("rename");
		}),
		("replace file with dir", &|| {
			std::fs::remove_file(root.join("swap")).expect("remove");
			std::fs::create_dir_all(root.join("swap/child")).expect("mkdir");
		}),
		// Editing an ignore file leaves its directory's stamp alone.
		("edit .gitignore", &|| std::fs::write(root.join(".gitignore"), "*.txt\n").expect("write")),
		// So does creating the exclude file inside .git/info.
		("create exclude", &|| {
			std::fs::write(root.join(".git/info/exclude"), "a/\n").expect("write");
		}),
	];
	for (name, mutate) in steps {
		// Age the tree, then fill the cache, so the mutation is checked
		// against trusted cached listings.
		settle();
		cached_matches_fresh(root, cache, &opts).await;
		mutate();
		let got = cached_matches_fresh(root, cache, &opts).await;
		if name == "add deep file" {
			assert!(got.contains(&"a/b/c/new.txt".to_owned()), "{name}: {got:?}");
		}
	}
}

/// A change in the same timestamp tick as a listing leaves the directory's
/// stamp unchanged, so a just-modified directory must not be served from
/// the cache.
#[tokio::test(flavor = "multi_thread")]
async fn cache_never_serves_fresh_listings() {
	let tmp = make_tree("cache-fresh", &["d/a"]);
	let cache = leaked_cache(1 << 20);
	let opts = Options::default();
	let filter = |_: &mut Worker<'_>, _: &mut Entry<'_>| Action::Continue;
	for i in 0..20 {
		collect_in(&Fs::native(), tmp.path(), &opts, true, filter, Some(cache))
			.await
			.expect("fill");
		let name = format!("d/f{i:02}");
		std::fs::write(tmp.path().join(&name), "").expect("write");
		let got = collect_in(&Fs::native(), tmp.path(), &opts, true, filter, Some(cache))
			.await
			.expect("cached");
		assert!(got.iter().any(|entry| entry.path == name.as_bytes()), "iteration {i}");
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn cache_eviction_keeps_results_correct() {
	let tmp = make_tree("cache-evict", &["a/1", "b/2", "c/3", "d/e/4"]);
	settle();
	// Every store overflows the budget and evicts.
	let cache = leaked_cache(1);
	for _ in 0..3 {
		cached_matches_fresh(tmp.path(), cache, &Options::default()).await;
	}
}

/// Paths (`""` for the root) and errors a tree traversal reports.
async fn tree_events(
	fs: &Fs,
	root: &Path,
	opts: &TreeOptions,
) -> (Vec<String>, Vec<(PathBuf, String)>) {
	let mut seen = Vec::new();
	let mut errors = Vec::new();
	let mut cursor = Tree::new(fs, root, opts).await.expect("tree");
	while let Some(event) = cursor.next().await {
		match event {
			Event::Entry(entry) => seen.push(String::from_utf8_lossy(entry.path).into_owned()),
			Event::Error(error) => errors.push((error.path.clone(), error.error.to_string())),
		}
	}
	(seen, errors)
}

async fn tree_paths(root: &Path, opts: &TreeOptions) -> Vec<String> {
	let (seen, errors) = tree_events(&Fs::native(), root, opts).await;
	assert!(errors.is_empty(), "{errors:?}");
	seen
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_visits_each_directory_in_name_order_pre_and_post() {
	let tmp = make_tree("tree-order", &["c", "B", "a/x", "a/y/z", "_", "é", "a-b"]);
	let pre = tree_paths(tmp.path(), &TreeOptions::default()).await;
	assert_eq!(pre, ["B", "_", "a", "a/x", "a/y", "a/y/z", "a-b", "c", "é"]);
	let opts =
		TreeOptions { contents_first: true, emit_root: true, min_depth: 0, ..Default::default() };
	let post = tree_paths(tmp.path(), &opts).await;
	assert_eq!(post, ["B", "_", "a/x", "a/y/z", "a/y", "a", "a-b", "c", "é", ""]);
}

/// `Order::Paths` visits files in the byte order of their full paths, which
/// differs from name order where a directory name prefixes a sibling's
/// (`a/x` sorts after `a-b` and `a.txt`); it matches a sorted collect.
#[tokio::test(flavor = "multi_thread")]
async fn tree_path_order_matches_sorted_collect_for_files() {
	let tmp = make_tree("tree-path-order", &["a/x", "a/y/z", "a-b", "a.txt", "ab/q", "b"]);
	let opts = TreeOptions { order: Order::Paths, ..Default::default() };
	let (seen, errors) = tree_events(&Fs::native(), tmp.path(), &opts).await;
	assert!(errors.is_empty(), "{errors:?}");
	let files: Vec<String> = seen
		.into_iter()
		.filter(|path| tmp.path().join(path).is_file())
		.collect();
	assert_eq!(files, ["a-b", "a.txt", "a/x", "a/y/z", "ab/q", "b"]);
	let collected = collect(&Fs::native(), tmp.path(), &Options::default(), true, |_, e| {
		if e.file_type == FileType::File {
			Action::Continue
		} else {
			Action::Skip
		}
	})
	.await
	.expect("collect");
	let sorted: Vec<String> = collected
		.iter()
		.map(|e| e.path_lossy().into_owned())
		.collect();
	assert_eq!(files, sorted);
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_depth_bounds_and_root_emission() {
	let tmp = make_tree("tree-depth", &["a/b/c/d"]);
	let opts = TreeOptions { emit_root: true, min_depth: 0, ..Default::default() };
	assert_eq!(tree_paths(tmp.path(), &opts).await, ["", "a", "a/b", "a/b/c", "a/b/c/d"]);
	let opts =
		TreeOptions { emit_root: true, min_depth: 2, max_depth: Some(3), ..Default::default() };
	assert_eq!(tree_paths(tmp.path(), &opts).await, ["a/b", "a/b/c"]);
	let opts = TreeOptions { min_depth: 3, max_depth: Some(2), ..Default::default() };
	assert!(tree_paths(tmp.path(), &opts).await.is_empty());
	let opts = TreeOptions { emit_root: true, ..Default::default() };
	assert_eq!(tree_paths(tmp.path(), &opts).await[0], "a", "min_depth 1 never reports the root");
	let opts =
		TreeOptions { emit_root: true, min_depth: 0, max_depth: Some(0), ..Default::default() };
	assert_eq!(tree_paths(tmp.path(), &opts).await, [""]);
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_skip_descends_and_skip_dir_prunes() {
	let tmp = make_tree("tree-skip", &["keep/file.txt", "skip/file.txt"]);
	let mut seen = Vec::new();
	let mut cursor = Tree::new(&Fs::native(), tmp.path(), &TreeOptions::default())
		.await
		.expect("tree");
	while let Some(event) = cursor.next().await {
		let Event::Entry(entry) = event else {
			continue;
		};
		seen.push(String::from_utf8_lossy(entry.path).into_owned());
		if entry.path == b"skip" {
			cursor.skip_dir();
		}
	}
	assert_eq!(seen, ["keep", "keep/file.txt", "skip"]);

	// Dropping the cursor stops the traversal; `skip_dir` on a file or under
	// `contents_first` has no effect.
	let mut cursor = Tree::new(&Fs::native(), tmp.path(), &TreeOptions::default())
		.await
		.expect("tree");
	assert!(cursor.next().await.is_some());
	drop(cursor);
	let opts = TreeOptions { contents_first: true, ..Default::default() };
	let mut cursor = Tree::new(&Fs::native(), tmp.path(), &opts)
		.await
		.expect("tree");
	let mut seen = Vec::new();
	while let Some(event) = cursor.next().await {
		if let Event::Entry(entry) = event {
			seen.push(String::from_utf8_lossy(entry.path).into_owned());
		}
		cursor.skip_dir();
	}
	assert_eq!(seen, ["keep/file.txt", "keep", "skip/file.txt", "skip"]);
}

/// Nesting depth must not consume the call stack, and deep trees must not
/// run out of directory handles.
#[tokio::test(flavor = "multi_thread")]
async fn tree_walks_trees_deeper_than_the_thread_stack() {
	const DEPTH: usize = 300;
	let tmp = TempDir::new("tree-deep");
	let mut deepest = tmp.path().to_path_buf();
	for _ in 0..DEPTH {
		deepest.push("d");
	}
	std::fs::create_dir_all(&deepest).expect("deep tree");
	std::fs::write(deepest.join("leaf.txt"), "ok").expect("leaf");
	let leaf = format!("{}leaf.txt", "d/".repeat(DEPTH));
	for contents_first in [false, true] {
		// Deep Windows paths exceed MAX_PATH without the verbatim prefix, which
		// the canonical temp dir already carries there.
		let root = tmp.path().to_path_buf();
		let seen = on_small_stack(async move {
			let opts = TreeOptions { contents_first, ..Default::default() };
			tree_paths(&root, &opts).await
		})
		.await;
		assert_eq!(seen.len(), DEPTH + 1);
		let (first, last) = if contents_first {
			(leaf.as_str(), "d")
		} else {
			("d", leaf.as_str())
		};
		assert_eq!(seen.first().map(String::as_str), Some(first));
		assert_eq!(seen.last().map(String::as_str), Some(last));
	}
}

/// A walk returns to every directory past the window of open directories
/// and walks its remaining subdirectories, on every platform: each of 100
/// levels holds a sibling `z` that the walk reaches only after the whole
/// chain below it. On Windows a parent opens again below the root, as a
/// relative open there cannot name `..`; elsewhere through its child's
/// `..`. A parent lost on the way back reports its sibling as moved or
/// replaced, or, with no subdirectory left, reports nothing.
#[tokio::test(flavor = "multi_thread")]
async fn deep_trees_walk_every_sibling_on_the_way_back_up() {
	const DEPTH: usize = 100;
	let tmp = TempDir::new("tree-deep-siblings");
	let mut dir = tmp.path().to_path_buf();
	let (mut want, mut rel) = (Vec::new(), String::new());
	for _ in 0..DEPTH {
		std::fs::create_dir(dir.join("z")).expect("sibling");
		dir.push("d");
		std::fs::create_dir(&dir).expect("level");
		want.push(format!("{rel}d"));
		want.push(format!("{rel}z"));
		rel.push_str("d/");
	}
	want.sort_unstable();
	for contents_first in [false, true] {
		let opts = TreeOptions { contents_first, ..Default::default() };
		let mut seen = tree_paths(tmp.path(), &opts).await;
		seen.sort_unstable();
		assert_eq!(seen, want, "contents_first: {contents_first}");
	}
}

/// Builds `depth` levels of `name` below `top`, each one opened relative to
/// the one above (so building costs no path lookups however deep), each
/// with an empty sibling directory `z` when `siblings` is set, and an empty
/// file `leaf` at the bottom. [`remove_chain`] takes it down the same way.
#[cfg(unix)]
fn chain_by_descriptor(top: &Path, depth: usize, name: &str, siblings: bool) {
	let mut dir = open_at(
		libc::AT_FDCWD,
		top.as_os_str().as_encoded_bytes(),
		libc::O_RDONLY | libc::O_DIRECTORY,
	);
	for _ in 0..depth {
		at(&dir, name, At::MakeDir);
		if siblings {
			at(&dir, "z", At::MakeDir);
		}
		dir = open_at(
			dir_fd(&dir),
			name.as_bytes(),
			libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
		);
	}
	drop(open_at(dir_fd(&dir), b"leaf", libc::O_WRONLY | libc::O_CREAT));
}

/// Removes what [`chain_by_descriptor`] built below `top`, deepest first,
/// with two descriptors at most: `std::fs::remove_dir_all` keeps one open
/// per level.
#[cfg(unix)]
fn remove_chain(top: &Path, depth: usize, name: &str, siblings: bool) {
	let mut dir = open_at(
		libc::AT_FDCWD,
		top.as_os_str().as_encoded_bytes(),
		libc::O_RDONLY | libc::O_DIRECTORY,
	);
	for _ in 0..depth {
		dir = open_at(
			dir_fd(&dir),
			name.as_bytes(),
			libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
		);
	}
	at(&dir, "leaf", At::Unlink);
	for _ in 0..depth {
		dir = open_at(dir_fd(&dir), b"..", libc::O_RDONLY | libc::O_DIRECTORY);
		at(&dir, name, At::RemoveDir);
		if siblings {
			at(&dir, "z", At::RemoveDir);
		}
	}
}

/// `openat(at, name, flags)`, creating a file with mode 0644.
#[cfg(unix)]
fn open_at(at: libc::c_int, name: &[u8], flags: libc::c_int) -> std::os::fd::OwnedFd {
	use std::os::fd::FromRawFd as _;
	let c_name = std::ffi::CString::new(name).unwrap();
	let mode: libc::c_uint = 0o644;
	// SAFETY: `c_name` is NUL-terminated and outlives the call; `mode` only
	// counts when `flags` create the file.
	let fd = unsafe { libc::openat(at, c_name.as_ptr(), flags | libc::O_CLOEXEC, mode) };
	assert!(
		fd >= 0,
		"openat {}: {}",
		String::from_utf8_lossy(name),
		std::io::Error::last_os_error()
	);
	// SAFETY: `openat` returned a fresh descriptor owned from here.
	unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) }
}

#[cfg(unix)]
fn dir_fd(dir: &std::os::fd::OwnedFd) -> libc::c_int {
	use std::os::fd::AsRawFd as _;
	dir.as_raw_fd()
}

/// A `*at` call [`at`] makes.
#[cfg(unix)]
#[derive(Clone, Copy)]
enum At {
	MakeDir,
	Unlink,
	RemoveDir,
}

/// Runs `call` on `name` in `dir`; it must succeed.
#[cfg(unix)]
fn at(dir: &std::os::fd::OwnedFd, name: &str, call: At) {
	let c_name = std::ffi::CString::new(name).unwrap();
	let (fd, path) = (dir_fd(dir), c_name.as_ptr());
	// SAFETY: `path` is NUL-terminated and outlives the call, and `fd` is
	// the open directory `dir` owns.
	let done = unsafe {
		match call {
			At::MakeDir => libc::mkdirat(fd, path, 0o755),
			At::Unlink => libc::unlinkat(fd, path, 0),
			At::RemoveDir => libc::unlinkat(fd, path, libc::AT_REMOVEDIR),
		}
	};
	assert_eq!(done, 0, "{name}: {}", std::io::Error::last_os_error());
}

/// Every subdirectory opens relative to its parent's handle however deep
/// the walk goes, and so does a parent the walk returns to: 100 and 300
/// levels, each with a second subdirectory the walk opens on its way back
/// up, cost one open that looks every component up, the root's. Opening the
/// directories below the 64 whose handles stay open by looking every
/// component up again, below the root's handle, made a walk quadratic in
/// its depth: 97 seconds for find's 2,000 levels under gVisor (GKE
/// Sandbox), where each lookup is slow.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn deep_walks_open_every_directory_relative_to_its_parent() {
	for depth in [100, 300] {
		let tmp = TempDir::new("tree-relative");
		chain_by_descriptor(tmp.path(), depth, "d", true);
		let mut cursor = Tree::new(&Fs::native(), tmp.path(), &TreeOptions::default())
			.await
			.expect("tree");
		let (mut entries, mut errors) = (0, Vec::new());
		while let Some(event) = cursor.next().await {
			match event {
				Event::Entry(_) => entries += 1,
				Event::Error(error) => errors.push(error.error.to_string()),
			}
		}
		let opens = cursor.opens();
		drop(cursor);
		remove_chain(tmp.path(), depth, "d", true);
		assert!(errors.is_empty(), "{depth} levels: {errors:?}");
		assert_eq!(entries, 2 * depth + 1, "{depth} levels: every d, every z, and the leaf");
		assert_eq!(opens.walked, 1, "{depth} levels: {opens:?}");
		assert!(opens.parent > 0, "{depth} levels: no parent was reopened: {opens:?}");
	}
}

/// A directory the walk gave its handle up for, and returns to through its
/// child's `..`, is taken back only with the identity it recorded (device
/// and inode). Here the child is moved elsewhere while the walk is below it:
/// its `..` is then another directory, whose entries must not be walked as
/// the parent's, so the parent is opened again below the root, and checked
/// the same way. When that path also names another directory, the parent's
/// remaining subdirectories are reported, not entered. An identity can be
/// reused: a directory made after the parent was removed can get its inode
/// number, and is then taken in its place.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_parent_the_walk_returns_to_is_taken_back_only_with_its_recorded_identity() {
	for replace_parent in [false, true] {
		let tmp = make_tree("tree-moved", &["p/z/kept", "o/z/secret"]);
		std::fs::create_dir(tmp.path().join("p/a")).unwrap();
		// Far enough below `p` for `p` to give its handle up.
		chain_by_descriptor(&tmp.path().join("p/a"), 70, "d", false);
		let mut cursor = Tree::new(&Fs::native(), tmp.path(), &TreeOptions::default())
			.await
			.expect("tree");
		let (mut seen, mut errors) = (Vec::new(), Vec::new());
		while let Some(event) = cursor.next().await {
			match event {
				Event::Entry(entry) => {
					let path = String::from_utf8_lossy(entry.path).into_owned();
					if path.ends_with("/leaf") {
						// While the walk is at the bottom of `p/a`.
						std::fs::rename(tmp.path().join("p/a"), tmp.path().join("o/a")).unwrap();
						if replace_parent {
							std::fs::rename(tmp.path().join("p"), tmp.path().join("p-old")).unwrap();
							std::fs::create_dir_all(tmp.path().join("p/z/impostor")).unwrap();
						}
					}
					if !path.starts_with("p/a/") {
						seen.push(path);
					}
				},
				Event::Error(error) => {
					let path = error
						.path
						.strip_prefix(tmp.path())
						.unwrap()
						.to_string_lossy()
						.into_owned();
					errors.push((path, error.error.to_string()));
				},
			}
		}
		drop(cursor);
		if replace_parent {
			assert_eq!(seen, ["o", "o/z", "o/z/secret", "p", "p/a", "p/z"]);
			assert_eq!(errors, [(
				"p/z".to_owned(),
				"the directory was moved or replaced during the walk".to_owned()
			)]);
		} else {
			assert_eq!(seen, ["o", "o/z", "o/z/secret", "p", "p/a", "p/z", "p/z/kept"]);
			assert!(errors.is_empty(), "{errors:?}");
		}
	}
}

/// A parent the walk gave its handle up for, and cannot open again when it
/// returns to it, keeps its place: its subdirectories that the walk cannot
/// open are reported with the open's error, which names the parent, and
/// those it can open once the failure ends are walked. Here every directory
/// open on this thread fails with `EMFILE` from the report of `p/a/d`, the
/// last before the walk leaves `p/a` for `p`, until the walk reports an
/// error. Losing `p` instead reported `p/y` and `p/z` as moved or replaced,
/// and walked neither.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_parent_the_walk_cannot_open_again_keeps_its_place() {
	let tmp = make_tree("tree-reopen-fails", &["p/y/missed", "p/z/kept"]);
	std::fs::create_dir(tmp.path().join("p/a")).unwrap();
	// Far enough below `p` for `p` to give its handle up.
	chain_by_descriptor(&tmp.path().join("p/a"), 70, "d", false);
	let opts = TreeOptions { contents_first: true, ..Default::default() };
	let mut cursor = Tree::new(&Fs::native(), tmp.path(), &opts)
		.await
		.expect("tree");
	let emfile = || std::io::Error::from_raw_os_error(libc::EMFILE);
	let mut failing = None;
	let (mut seen, mut errors) = (Vec::new(), Vec::new());
	while let Some(event) = cursor.next().await {
		match event {
			Event::Entry(entry) => {
				let path = String::from_utf8_lossy(entry.path).into_owned();
				if path == "p/a/d" {
					failing = Some(crate::fs::seam::fail_opens(move |_| Some(emfile())));
				}
				if !path.starts_with("p/a/") {
					seen.push(path);
				}
			},
			Event::Error(error) => {
				failing = None;
				let path = error
					.path
					.strip_prefix(tmp.path())
					.unwrap()
					.to_string_lossy()
					.into_owned();
				errors.push((path, error.error.to_string()));
			},
		}
	}
	drop(cursor);
	assert!(failing.is_none(), "the walk reported no error while its opens failed");
	assert_eq!(errors, [(
		"p/y".to_owned(),
		format!(
			"cannot open the parent directory {} again: {}",
			tmp.path().join("p").display(),
			emfile()
		)
	)]);
	assert_eq!(seen, ["p/a", "p/y", "p/z/kept", "p/z", "p"]);
}

/// Under [`Follow::Always`] too, a lost parent enters none of its
/// subdirectories, a followed link included: the link opens by path, so it
/// resolves through whatever now stands at the parent's path. Here `p`'s
/// child is moved out and `p` replaced while the walk is below it, and the
/// new `p` holds a link `l` to `u`, where the old one linked to `t`.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_lost_parent_follows_no_link() {
	let tmp = make_tree("tree-lost-link", &["o/z/secret", "t/listed", "u/other"]);
	std::fs::create_dir_all(tmp.path().join("p/z")).unwrap();
	symlink("../t", &tmp.path().join("p/l"));
	std::fs::create_dir(tmp.path().join("p/a")).unwrap();
	// Far enough below `p` for `p` to give its handle up.
	chain_by_descriptor(&tmp.path().join("p/a"), 70, "d", false);
	let opts = TreeOptions { follow: Follow::Always, ..Default::default() };
	let mut cursor = Tree::new(&Fs::native(), tmp.path(), &opts)
		.await
		.expect("tree");
	let (mut seen, mut errors) = (Vec::new(), Vec::new());
	while let Some(event) = cursor.next().await {
		match event {
			Event::Entry(entry) => {
				let path = String::from_utf8_lossy(entry.path).into_owned();
				if path.ends_with("/leaf") {
					// While the walk is at the bottom of `p/a`.
					std::fs::rename(tmp.path().join("p/a"), tmp.path().join("o/a")).unwrap();
					std::fs::rename(tmp.path().join("p"), tmp.path().join("p-old")).unwrap();
					std::fs::create_dir_all(tmp.path().join("p/z/impostor")).unwrap();
					symlink("../u", &tmp.path().join("p/l"));
				}
				if path.starts_with("p/") && !path.starts_with("p/a/") {
					seen.push(path);
				}
			},
			Event::Error(error) => {
				let path = error
					.path
					.strip_prefix(tmp.path())
					.unwrap()
					.to_string_lossy()
					.into_owned();
				errors.push((path, error.error.to_string()));
			},
		}
	}
	drop(cursor);
	let moved = "the directory was moved or replaced during the walk".to_owned();
	assert_eq!(seen, ["p/a", "p/l", "p/z"]);
	assert_eq!(errors, [("p/l".to_owned(), moved.clone()), ("p/z".to_owned(), moved)]);
}

/// A parent the walk gave its handle up for, and whose read permission is
/// taken away while the walk is below it, still has its remaining
/// subdirectories walked on Linux: entering them needs only its search
/// permission, as it did through the handle it gave up. The walk takes the
/// parent back through its child's `..`, and, with the child moved away,
/// below the root or by path; each open is search-only (`O_PATH`). Opening
/// it for reading reported `p/y` and `p/z` as `Permission denied` and walked
/// neither. Where no search-only open exists, each is reported with an error
/// that names the parent, whose open failed.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_parent_that_cannot_be_read_again_is_still_walked() {
	use std::os::unix::fs::PermissionsExt as _;
	for follow in [Follow::Roots, Follow::Always] {
		for move_child in [false, true] {
			let case = format!("{follow:?}, child moved: {move_child}");
			let tmp = make_tree("tree-unreadable-parent", &["o/kept", "p/y/kept", "p/z/kept"]);
			std::fs::create_dir(tmp.path().join("p/a")).unwrap();
			// Far enough below `p` for `p` to give its handle up.
			chain_by_descriptor(&tmp.path().join("p/a"), 70, "d", false);
			let opts = TreeOptions { follow, ..Default::default() };
			let mut cursor = Tree::new(&Fs::native(), tmp.path(), &opts)
				.await
				.expect("tree");
			let (mut seen, mut errors, mut privileged) = (Vec::new(), Vec::new(), None);
			while let Some(event) = cursor.next().await {
				match event {
					Event::Entry(entry) => {
						let path = String::from_utf8_lossy(entry.path).into_owned();
						if path.ends_with("/leaf") {
							// While the walk is at the bottom of `p/a`.
							let p = tmp.path().join("p");
							if move_child {
								std::fs::rename(p.join("a"), tmp.path().join("o/a")).unwrap();
							}
							std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o311)).unwrap();
							privileged = Some(std::fs::read_dir(&p).is_ok());
						}
						if path.starts_with('p') && !path.starts_with("p/a/") {
							seen.push(path);
						}
					},
					Event::Error(error) => {
						let path = error
							.path
							.strip_prefix(tmp.path())
							.unwrap()
							.to_string_lossy()
							.into_owned();
						errors.push((path, error.error.to_string()));
					},
				}
			}
			let opens = cursor.opens();
			drop(cursor);
			std::fs::set_permissions(tmp.path().join("p"), std::fs::Permissions::from_mode(0o755))
				.unwrap();
			match privileged {
				None => panic!("{case}: the walk never reached the leaf"),
				Some(true) => {
					eprintln!("skipped: {case}: this process reads a directory without read permission");
					continue;
				},
				Some(false) => {},
			}
			if cfg!(target_os = "linux") {
				assert!(errors.is_empty(), "{case}: {errors:?}");
				assert_eq!(seen, ["p", "p/a", "p/y", "p/y/kept", "p/z", "p/z/kept"], "{case}");
				// With the child in place every parent comes back through its
				// child's `..`, `p` included, as a search-only open of `..`:
				// the root's open is the only one that looks a path up.
				if !move_child {
					assert_eq!(
						opens.walked, 1,
						"{case}: a parent was opened again by its path: {opens:?}"
					);
				}
			} else {
				let denied = format!(
					"cannot open the parent directory {} again: {}",
					tmp.path().join("p").display(),
					std::io::Error::from_raw_os_error(libc::EACCES)
				);
				assert_eq!(
					errors,
					[("p/y".to_owned(), denied.clone()), ("p/z".to_owned(), denied)],
					"{case}"
				);
				assert_eq!(seen, ["p", "p/a", "p/y", "p/z"], "{case}");
			}
		}
	}
}

/// Stopping at the leaf of an ignore chain as deep as path syscalls reach
/// must return rather than overflow the stack while each level's ignore
/// frame is released.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn stopping_at_the_leaf_of_a_deep_ignore_chain_returns() {
	let tmp = TempDir::new("deep-ignore");
	// Dropped before `tmp`, so its removal does not hold a descriptor for
	// each level of the chain (`DeepChain`).
	let chain = DeepChain::create(tmp.path(), |level| {
		std::fs::write(level.join(".ignore"), "*.log\n").expect("ignore file");
	});
	std::fs::write(chain.deepest().join("leaf"), "x").expect("leaf");
	let root = tmp.path().to_path_buf();
	let found = on_small_stack(async move {
		let opts = TreeOptions { gitignore: true, ..Default::default() };
		let mut found = false;
		let mut cursor = Tree::new(&Fs::native(), &root, &opts).await.expect("tree");
		while let Some(event) = cursor.next().await {
			if matches!(event, Event::Entry(entry) if entry.name() == b"leaf") {
				found = true;
				break;
			}
		}
		found
	})
	.await;
	assert!(found);
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_honours_ignores_and_the_unignored_name() {
	let tmp = make_tree("tree-ignore", &[
		".gitignore=*.md\nbuild/\n",
		"AGENTS.md",
		"README.md",
		"build/AGENTS.md",
		"src/AGENTS.md",
		"src/x.rs",
		".git/HEAD",
	]);
	let opts = TreeOptions {
		gitignore: true,
		skip_git: true,
		unignored_name: Some("AGENTS.md"),
		..Default::default()
	};
	assert_eq!(tree_paths(tmp.path(), &opts).await, [
		".gitignore",
		"AGENTS.md",
		"src",
		"src/AGENTS.md",
		"src/x.rs"
	]);
	let opts = TreeOptions { gitignore: true, skip_git: true, hidden: false, ..Default::default() };
	assert_eq!(tree_paths(tmp.path(), &opts).await, ["src", "src/x.rs"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_missing_root_and_drop_cancellation() {
	let tmp = make_tree("tree-stop", &[]);
	let missing = tmp.path().join("nope");
	let err = Tree::new(&Fs::native(), &missing, &TreeOptions::default())
		.await
		.err()
		.expect("missing");
	assert!(matches!(err, WalkError::Root { ref path, .. } if *path == missing));
	for i in 0..300 {
		std::fs::write(tmp.path().join(format!("f{i:03}")), "").expect("write");
	}
	let mut seen = 0;
	let (fs, opts) = (Fs::native(), TreeOptions::default());
	let mut cursor = Tree::new(&fs, tmp.path(), &opts).await.expect("tree");
	let mut traversal = Box::pin(async {
		while cursor.next().await.is_some() {
			seen += 1;
		}
	});
	assert!(futures::poll!(traversal.as_mut()).is_pending(), "the traversal yields between entries");
	drop(traversal);
	assert!((1..300).contains(&seen), "{seen}");
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_a_file_root_is_reported_alone() {
	let tmp = make_tree("tree-file", &["f=abc"]);
	let opts =
		TreeOptions { emit_root: true, min_depth: 0, detail: Detail::Full, ..Default::default() };
	let mut seen = Vec::new();
	let mut cursor = Tree::new(&Fs::native(), &tmp.path().join("f"), &opts)
		.await
		.expect("tree");
	while let Some(event) = cursor.next().await {
		if let Event::Entry(entry) = event {
			seen.push((entry.path.to_vec(), entry.file_type, entry.size, entry.depth));
		}
	}
	assert_eq!(seen, [(Vec::new(), FileType::File, Some(3), 0)]);
}

#[cfg(not(windows))]
#[tokio::test(flavor = "multi_thread")]
async fn tree_detail_max_depth_limits_full_listings() {
	let tmp = make_tree("tree-detail", &["top=12345", "d/deep=1234"]);
	let opts = TreeOptions { detail: Detail::Full, detail_max_depth: Some(1), ..Default::default() };
	let mut sizes = Vec::new();
	let mut cursor = Tree::new(&Fs::native(), tmp.path(), &opts)
		.await
		.expect("tree");
	while let Some(event) = cursor.next().await {
		if let Event::Entry(entry) = event {
			sizes.push((String::from_utf8_lossy(entry.path).into_owned(), entry.size));
		}
	}
	assert_eq!(sizes, [
		("d".to_owned(), None),
		("d/deep".to_owned(), None),
		("top".to_owned(), Some(5))
	]);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn tree_reports_an_unreadable_root_as_an_error() {
	let tmp = make_tree("tree-unreadable", &["locked/x"]);
	let locked = tmp.path().join("locked");
	if !unreadable_dir(&locked) {
		return;
	}
	let opts = TreeOptions { emit_root: true, min_depth: 0, ..Default::default() };
	let (seen, errors) = tree_events(&Fs::native(), &locked, &opts).await;
	assert_eq!(seen, [""]);
	assert_eq!(errors.len(), 1);
	assert_eq!(errors[0].0, locked);
	let (seen, errors) = tree_events(&Fs::native(), tmp.path(), &TreeOptions::default()).await;
	assert_eq!(seen, ["locked"]);
	assert_eq!(
		errors
			.iter()
			.map(|(path, _)| path.clone())
			.collect::<Vec<_>>(),
		[locked]
	);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn tree_follow_roots_traverses_a_root_link_only() {
	let target = make_tree("tree-roots-target", &["child.txt"]);
	let linked = make_tree("tree-roots-linked", &["linked-child.txt"]);
	symlink(linked.path().to_str().expect("utf-8"), &target.path().join("descendant-link"));
	let parent = TempDir::new("tree-roots-parent");
	let root_link = parent.path().join("root-link");
	symlink(target.path().to_str().expect("utf-8"), &root_link);

	let roots = TreeOptions { follow: Follow::Roots, ..Default::default() };
	assert_eq!(tree_paths(&root_link, &roots).await, ["child.txt", "descendant-link"]);

	let never =
		TreeOptions { follow: Follow::Never, emit_root: true, min_depth: 0, ..Default::default() };
	let mut seen = Vec::new();
	let mut cursor = Tree::new(&Fs::native(), &root_link, &never)
		.await
		.expect("tree");
	while let Some(event) = cursor.next().await {
		if let Event::Entry(entry) = event {
			seen.push((entry.path.to_vec(), entry.file_type));
		}
	}
	assert_eq!(seen, [(Vec::new(), FileType::Symlink)]);

	let always = TreeOptions { follow: Follow::Always, ..Default::default() };
	assert_eq!(tree_paths(&root_link, &always).await, [
		"child.txt",
		"descendant-link",
		"descendant-link/linked-child.txt"
	]);
}

/// Under [`Follow::Never`] the traversal checks its root with `lstat`, so a
/// root swapped for a symlink to a directory outside it between that check
/// and the root's open is refused, not walked: this is `find -P`'s root,
/// below which `find -delete` removes. The control: the swap ran, at the
/// root's open by path.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn tree_follow_never_refuses_a_root_swapped_for_a_symlink_after_its_check() {
	let base = TempDir::new("tree-never-root-swap");
	let name = format!("never-root-{}", std::process::id());
	let (root, outside) = (base.path().join(&name), base.path().join("outside"));
	std::fs::create_dir_all(&root).expect("root is created");
	std::fs::write(root.join("inside.txt"), "").expect("inside is written");
	std::fs::create_dir_all(&outside).expect("outside is created");
	std::fs::write(outside.join("secret.txt"), "").expect("secret is written");
	let never =
		TreeOptions { follow: Follow::Never, emit_root: true, min_depth: 0, ..Default::default() };
	let mut cursor = Tree::new(&Fs::native(), &root, &never).await.expect("tree");
	let opened = Arc::new(parking_lot::Mutex::new(None));
	let (link, target, parked, seen_open) =
		(root.clone(), outside.clone(), base.path().join("parked"), Arc::clone(&opened));
	crate::fs::seam::before_open(&name, move |open| {
		std::fs::rename(&link, &parked).expect("root is parked");
		std::os::unix::fs::symlink(&target, &link).expect("root becomes a link");
		*seen_open.lock() = Some(open);
	});
	let (mut seen, mut errors) = (Vec::new(), Vec::new());
	while let Some(event) = cursor.next().await {
		match event {
			Event::Entry(entry) => seen.push(String::from_utf8_lossy(entry.path).into_owned()),
			Event::Error(error) => errors.push(error.error.raw_os_error()),
		}
	}
	assert_eq!(*opened.lock(), Some(Open::Path), "the root was not opened by path after its check");
	assert!(!seen.iter().any(|path| path.contains("secret")), "walked the swapped root: {seen:?}");
	assert_eq!(errors, [Some(libc::ENOTDIR)], "the swapped root was not refused: {seen:?}");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn tree_always_reports_symlink_cycles_to_ancestors() {
	let tmp = make_tree("tree-cycle", &["a/file.txt", "target/child.txt"]);
	let a = tmp.path().join("a");
	symlink("..", &a.join("to_root"));
	symlink(".", &a.join("to_parent"));
	symlink("target", &tmp.path().join("link"));
	let opts = TreeOptions { follow: Follow::Always, ..Default::default() };
	let (seen, mut errors) = tree_events(&Fs::native(), tmp.path(), &opts).await;
	assert_eq!(seen, ["a", "a/file.txt", "link", "link/child.txt", "target", "target/child.txt"]);
	errors.sort();
	assert_eq!(errors, [
		(a.join("to_parent"), "filesystem loop detected".to_owned()),
		(a.join("to_root"), "filesystem loop detected".to_owned()),
	]);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn tree_unignored_name_does_not_exempt_followed_directory_links() {
	let tmp = make_tree("tree-unignored-link", &[
		".gitignore=AGENTS.md\n",
		"real/inner.txt",
		"sub/AGENTS.md=rules",
	]);
	symlink("real", &tmp.path().join("AGENTS.md"));
	let opts = TreeOptions {
		follow: Follow::Always,
		gitignore: true,
		unignored_name: Some("AGENTS.md"),
		..Default::default()
	};
	assert_eq!(tree_paths(tmp.path(), &opts).await, [
		".gitignore",
		"real",
		"real/inner.txt",
		"sub",
		"sub/AGENTS.md"
	]);
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_over_a_provider_spells_urls_and_raw_names() {
	let (_mem, blocking) = MemFs::with_files(&[
		("mem://root/dir/a%20b.rs", "alpha"),
		("mem://root/dir/sub/c.rs", "gamma"),
	]);
	let fs = Fs::Provider(blocking);
	let mut seen = Vec::new();
	let mut cursor = Tree::new(&fs, Path::new("mem://root/dir"), &TreeOptions::default())
		.await
		.expect("tree");
	while let Some(event) = cursor.next().await {
		if let Event::Entry(entry) = event {
			seen.push((String::from_utf8_lossy(entry.path).into_owned(), entry.abs.to_path_buf()));
		}
	}
	assert_eq!(seen, [
		("a b.rs".to_owned(), PathBuf::from("mem://root/dir/a%20b.rs")),
		("sub".to_owned(), PathBuf::from("mem://root/dir/sub")),
		("sub/c.rs".to_owned(), PathBuf::from("mem://root/dir/sub/c.rs")),
	]);
}

/// A walk ends on the flag its caller holds, not only on one of its own.
///
/// The record loop reads [`Stop`] where it reads the walk's own halt — before
/// the prune and ignore filters and before the visitor — so a stop set from
/// outside lands at the next record whatever that record is. Without it, a
/// caller can only abort the task driving the walk, and that abort waits for
/// a worker to poll the task again.
#[tokio::test(flavor = "multi_thread")]
async fn a_caller_held_stop_ends_the_record_loop() {
	let names: Vec<String> = (0..512).map(|index| format!("f{index}")).collect();
	let specs: Vec<&str> = names.iter().map(String::as_str).collect();
	let tmp = make_tree("caller-stop", &specs);

	// Set partway through the one directory, by something that is not the
	// walk: the visitor never returns `Action::Stop`, so the walk's own halt
	// has no reason to be set.
	let stop = Stop::new();
	let seen = Arc::new(AtomicUsize::new(0));
	let counted = Arc::clone(&seen);
	let flag = stop.clone();
	let opts = Options { stop: Some(stop.clone()), ..Options::default() };
	collect(&Fs::native(), tmp.path(), &opts, false, move |_, _| {
		if counted.fetch_add(1, Ordering::AcqRel) == 0 {
			flag.stop();
		}
		Action::Skip
	})
	.await
	.expect("collect");
	assert_eq!(
		seen.load(Ordering::Acquire),
		1,
		"the walk examined further entries after its caller's flag was set, so a caller cannot stop \
		 a walk it does not drive"
	);
	assert!(stop.stopped(), "the caller's handle no longer reads the walk it was given to");

	// A flag already set is a walk that never examines an entry.
	let before = Stop::new();
	before.stop();
	let opts = Options { stop: Some(before), ..Options::default() };
	let seen = Arc::new(AtomicUsize::new(0));
	let counted = Arc::clone(&seen);
	collect(&Fs::native(), tmp.path(), &opts, false, move |_, _| {
		counted.fetch_add(1, Ordering::AcqRel);
		Action::Continue
	})
	.await
	.expect("collect");
	assert_eq!(seen.load(Ordering::Acquire), 0, "a walk started stopped still examined entries");
}

/// A walk consumer opens a listed file through the directory handle its
/// batch carries without following a symlink that replaced the file after
/// the listing.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_batch_file_open_refuses_a_file_swapped_for_a_symlink() {
	let tree = SwapTree::new("walk-batch-file", 0, Outside::SameName);
	tree.swap_file_before_open();
	let opts = Options { hidden: true, ..Options::default() };
	let mut walked = walk(&Fs::native(), &tree.root, &opts, |_, entry, out: &mut Vec<Vec<u8>>| {
		if entry.file_type == FileType::File {
			out.push(entry.name().to_vec());
		}
		Action::Continue
	})
	.await
	.expect("walk");
	let mut session = Fs::native().session();
	let mut read = Vec::new();
	while let Some(batch) = walked.next().await {
		let dir = batch
			.dir
			.expect("an uncached walk keeps its directories open");
		for name in batch.items {
			if let Ok((mut file, _)) = session.open_file_at(&dir, &name, false).await {
				let mut buf = Vec::new();
				file.read_into(&mut buf, 1 << 20).await.expect("read");
				read.push(String::from_utf8(buf).expect("utf-8"));
			}
		}
	}
	assert_eq!(tree.swapped(), Some(Open::At), "the file opened relative to its directory");
	assert!(!escaped(read.iter().map(String::as_str)), "read through the swapped link: {read:?}");
}

/// Case A for a walk whose root listing comes from the cache: `sub` (changed
/// since, so listed afresh) opens without its parent's handle after it is
/// swapped for a symlink to a directory outside the root. The walk does not
/// descend into the link.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_walk_below_a_cached_listing_refuses_a_swapped_directory() {
	let tree = SwapTree::new("walk-cached-a", 0, Outside::OtherName);
	let cache = leaked_cache(1 << 20);
	let opts = Options { hidden: true, ..Options::default() };
	let filter = |_: &mut Worker<'_>, _: &mut Entry<'_>| Action::Continue;
	settle();
	let filled = collect_in(&Fs::native(), &tree.root, &opts, true, filter, Some(cache))
		.await
		.expect("fill");
	assert_eq!(filled.len(), 2, "sub and its file");
	std::fs::write(tree.sub.join("changed.txt"), "").expect("sub changes");
	tree.swap_dir_before_open(&tree.sub_name);
	let got = collect_in(&Fs::native(), &tree.root, &opts, true, filter, Some(cache))
		.await
		.expect("cached");
	let paths: Vec<String> = got.iter().map(|entry| lossy(&entry)).collect();
	let swapped = tree.swapped();
	assert!(swapped.is_some_and(|open| open != Open::At), "the root was not cached: {swapped:?}");
	assert!(
		!paths.iter().any(|path| path.contains("secret")),
		"descended into the swapped link: {paths:?}"
	);
}

/// Case A for the ordered traversal deeper than the window of directory
/// handles it keeps ([`tree::MAX_OPEN_DIRS`]): `sub` is swapped for a symlink
/// to a directory outside the root between its parent's listing and its own
/// open. The traversal refuses `sub` and reports nothing beneath it. The
/// control: the swap ran, before `sub`'s open.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn tree_past_the_open_directory_limit_refuses_a_swapped_directory() {
	let tree = SwapTree::new("tree-deep-a", tree::MAX_OPEN_DIRS, Outside::OtherName);
	tree.swap_dir_before_open(&tree.sub_name);
	let (seen, errors) = tree_events(&Fs::native(), &tree.root, &TreeOptions::default()).await;
	assert!(tree.swapped().is_some(), "the swap did not run");
	let sub = format!("{}{}", "d/".repeat(tree::MAX_OPEN_DIRS), tree.sub_name);
	let beneath = format!("{sub}/");
	assert!(
		!seen.iter().any(|path| path.starts_with(&beneath)),
		"reported what the swapped link holds: {:?}",
		seen
			.iter()
			.filter(|path| path.starts_with(&sub))
			.collect::<Vec<_>>()
	);
	assert!(
		errors.iter().any(|(path, _)| path.ends_with(&sub)),
		"the swapped directory was not refused: {errors:?}"
	);
}

/// A `.gitignore` that is a symlink is not read by a walk that does not
/// follow symlinks, as git 2.32 and later reads no symlinked `.gitignore` in
/// the working tree, and is read by a walk that follows them.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_symlinked_gitignore_is_read_only_by_a_walk_that_follows_links() {
	let tmp = make_tree("linked-gitignore", &["rules=*.log\n", "a.log", "b.txt"]);
	symlink("rules", &tmp.path().join(".gitignore"));
	let plain = Options { hidden: true, gitignore: true, ..Options::default() };
	assert_eq!(paths(tmp.path(), &plain).await, [".gitignore", "a.log", "b.txt", "rules"]);
	let following = Options { follow_links: true, ..plain };
	assert_eq!(paths(tmp.path(), &following).await, [".gitignore", "b.txt", "rules"]);
	let roots = TreeOptions { gitignore: true, ..TreeOptions::default() };
	assert_eq!(tree_paths(tmp.path(), &roots).await, [".gitignore", "a.log", "b.txt", "rules"]);
	let always = TreeOptions { follow: Follow::Always, ..roots };
	assert_eq!(tree_paths(tmp.path(), &always).await, [".gitignore", "b.txt", "rules"]);
}

/// Listings whose `.gitignore` is a symlink, the root's included, are served
/// from the cache to a walk that does not follow symlinks: the cache stamps
/// that source as such a walk reads it (not at all). A walk that follows
/// symlinks reads the link's target, so those listings, cached with other
/// rules, are listed afresh for it.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn listings_with_a_symlinked_gitignore_are_served_from_the_cache() {
	/// The paths a walk reports, sorted, and how many of its listings came
	/// from the cache (a batch with no directory, in a tree this small).
	async fn walk_counting_cached(root: &Path, opts: &Options) -> (Vec<String>, usize) {
		let mut walked = walk(&Fs::native(), root, opts, |_, entry, out: &mut Vec<String>| {
			out.push(lossy(entry));
			Action::Continue
		})
		.await
		.expect("walk");
		let (mut paths, mut cached) = (Vec::new(), 0);
		while let Some(batch) = walked.next().await {
			cached += usize::from(batch.dir.is_none());
			paths.extend(batch.items);
		}
		paths.sort();
		(paths, cached)
	}

	let tmp = make_tree("cached-linked-gitignore", &[
		"rules=*.log\n",
		"a.log",
		"sub/rules=*.log\n",
		"sub/b.log",
	]);
	symlink("rules", &tmp.path().join(".gitignore"));
	symlink("rules", &tmp.path().join("sub/.gitignore"));
	let plain = Options { hidden: true, gitignore: true, cache: true, ..Options::default() };
	settle();
	let (filled, _) = walk_counting_cached(tmp.path(), &plain).await;
	let (served, cached) = walk_counting_cached(tmp.path(), &plain).await;
	assert_eq!(served, filled);
	assert!(served.contains(&"sub/b.log".to_owned()), "a symlinked .gitignore was read: {served:?}");
	assert_eq!(cached, 2, "a listing with a symlinked .gitignore was listed again");

	let following = Options { follow_links: true, ..plain };
	let (paths, cached) = walk_counting_cached(tmp.path(), &following).await;
	assert_eq!(cached, 0, "a following walk was served a listing cached with other rules");
	assert_eq!(paths, [".gitignore", "rules", "sub", "sub/.gitignore", "sub/rules"]);
}

/// A walk that follows links caches the listing of a linked directory under
/// the link's path. A walk that does not follow links is not served that
/// listing when its own (real) directory of that name is swapped for the
/// link again between its parent's listing and the cache lookup.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_walk_that_does_not_follow_links_gets_no_cached_listing_through_a_symlink() {
	let tree = SwapTree::new("walk-cached-link", 0, Outside::OtherName);
	let cache = leaked_cache(1 << 20);
	let filter = |_: &mut Worker<'_>, _: &mut Entry<'_>| Action::Continue;
	tree.swap_dir();
	settle();
	let following = Options { hidden: true, follow_links: true, ..Options::default() };
	let linked = collect_in(&Fs::native(), &tree.root, &following, true, filter, Some(cache))
		.await
		.expect("walk through the link");
	assert!(
		linked.iter().any(|entry| lossy(&entry).contains("secret")),
		"the link's target is listed"
	);
	tree.unswap_dir();
	tree.swap_dir_before_stat(&tree.sub_name);
	let plain = Options { hidden: true, ..Options::default() };
	let got = collect_in(&Fs::native(), &tree.root, &plain, true, filter, Some(cache))
		.await
		.expect("walk");
	let paths: Vec<String> = got.iter().map(|entry| lossy(&entry)).collect();
	assert_eq!(tree.swapped(), Some(Open::Stat), "the swap ran at the cache lookup");
	assert!(
		!paths.iter().any(|path| path.contains("secret")),
		"served the link's cached listing: {paths:?}"
	);
}

/// A batch served from the cache carries no directory; its consumer opens the
/// files below the walk's root handle, which refuses a directory swapped for
/// a symlink since the listing.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_cached_batch_opens_its_files_below_the_walk_root() {
	let tree = SwapTree::new("walk-cached-batch", 0, Outside::SameName);
	let opts = Options { hidden: true, cache: true, ..Options::default() };
	let files = |_: &mut Worker<'_>, entry: &Entry<'_>, out: &mut Vec<Vec<u8>>| {
		if entry.file_type == FileType::File {
			out.push(entry.path.to_vec());
		}
		Action::Continue
	};
	settle();
	drain(&Fs::native(), &tree.root, &opts, files)
		.await
		.expect("fill");
	tree.swap_dir_before_open(&tree.decoy_name);
	let mut walked = walk(&Fs::native(), &tree.root, &opts, files)
		.await
		.expect("walk");
	let mut session = Fs::native().session();
	let mut read = Vec::new();
	while let Some(batch) = walked.next().await {
		assert!(batch.dir.is_none(), "the listing was not cached");
		let root = walked
			.root_dir()
			.expect("a walk that does not follow links keeps its root");
		for rel in batch.items {
			if let Ok((mut file, _)) = session.open_file_beneath(root, &rel).await {
				let mut buf = Vec::new();
				file.read_into(&mut buf, 1 << 20).await.expect("read");
				read.push(String::from_utf8(buf).expect("utf-8"));
			}
		}
	}
	assert_eq!(tree.swapped(), Some(Open::Beneath));
	assert!(!escaped(read.iter().map(String::as_str)), "read through the swapped link: {read:?}");
}
