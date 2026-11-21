//! A `worktree add` stopped by a signal before it finishes leaves a
//! registration git reports as locked (`locked initializing`, what git's own
//! add holds while it fills a tree), and the next add removes the partial tree
//! and that registration. While the stopped add's process lives, other adds
//! leave it alone.
//!
//! The add runs in a child process: this test binary run again with
//! [`CHILD_SOURCE`] set, on the test [`interrupted_add_child`] alone.
#![cfg(unix)]

use std::{
	env, fs,
	os::unix::process::ExitStatusExt,
	path::{Path, PathBuf},
	process::{Child, Command, Stdio},
};

use pi_vcs::{
	git::GitRepo,
	types::{WorktreeAddOptions, WorktreeClone},
};
use tempfile::TempDir;

const CHILD_SOURCE: &str = "PI_VCS_TEST_INTERRUPT_SOURCE";
const CHILD_TARGET: &str = "PI_VCS_TEST_INTERRUPT_TARGET";
const CHILD_CLONE: &str = "PI_VCS_TEST_INTERRUPT_CLONE";

fn git(dir: &Path, args: &[&str]) -> String {
	let output = Command::new("git")
		.arg("-C")
		.arg(dir)
		.args(args)
		.output()
		.unwrap();
	assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
	String::from_utf8(output.stdout)
		.unwrap()
		.trim_end()
		.to_owned()
}

const fn options(clone: WorktreeClone) -> WorktreeAddOptions {
	WorktreeAddOptions { detach: true, clone, keep_changes: false, lock: None }
}

/// The child process's add. Without [`CHILD_SOURCE`] (the test run itself) it
/// does nothing.
#[test]
fn interrupted_add_child() {
	let (Ok(source), Ok(target), Ok(clone)) =
		(env::var(CHILD_SOURCE), env::var(CHILD_TARGET), env::var(CHILD_CLONE))
	else {
		return;
	};
	let clone = if clone == "off" {
		WorktreeClone::Off
	} else {
		WorktreeClone::Auto
	};
	GitRepo::require(Path::new(&source))
		.unwrap()
		.worktree_add(Path::new(&target), "HEAD", options(clone))
		.unwrap();
}

/// A source whose add takes long enough to stop midway: `count` files, tracked
/// (`tracked`) or in the ignored `node_modules` cache the clone carries.
fn fixture(count: usize, tracked: bool) -> (TempDir, PathBuf, GitRepo) {
	let temp = tempfile::tempdir().unwrap();
	let source = temp.path().join("source");
	fs::create_dir(&source).unwrap();
	git(&source, &["init", "-q", "-b", "main"]);
	for (key, value) in [
		("user.name", "Test"),
		("user.email", "test@example.com"),
		("commit.gpgsign", "false"),
		("core.excludesFile", ".git/no-global-excludes"),
		("core.hooksPath", ".git/hooks"),
	] {
		git(&source, &["config", key, value]);
	}
	fs::write(source.join("a.txt"), "tracked\n").unwrap();
	fs::write(source.join(".gitignore"), "node_modules/\n").unwrap();
	let root = if tracked { "files" } else { "node_modules" };
	for dir in 0..count / 10 {
		let dir_path = source.join(root).join(format!("d{dir:04}"));
		fs::create_dir_all(&dir_path).unwrap();
		for file in 0..10 {
			fs::write(dir_path.join(format!("f{file}")), format!("{dir} {file}\n")).unwrap();
		}
	}
	git(&source, &["add", "."]);
	git(&source, &["commit", "-qm", "base"]);
	let repo = GitRepo::require(&source).unwrap();
	(temp, source, repo)
}

/// Whether a clone backend works on the filesystem holding `root`.
fn clone_works_on(root: &Path) -> bool {
	let source = root.join("clone-probe-source");
	let target = root.join("clone-probe-target");
	fs::create_dir_all(&source).unwrap();
	fs::write(source.join("file"), "probe\n").unwrap();
	let works = pi_iso::clone_candidates(None).into_iter().any(|kind| {
		let _ = fs::remove_dir_all(&target);
		pi_iso::backend(kind)
			.clone_tree(&source, &target, &pi_iso::CloneExclusions::default())
			.is_ok()
	});
	fs::remove_dir_all(source).unwrap();
	let _ = fs::remove_dir_all(target);
	works
}

fn spawn_add(source: &Path, target: &Path, clone: &str) -> Child {
	Command::new(env::current_exe().unwrap())
		.args(["interrupted_add_child", "--exact", "--nocapture", "--test-threads=1"])
		.env(CHILD_SOURCE, source)
		.env(CHILD_TARGET, target)
		.env(CHILD_CLONE, clone)
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.unwrap()
}

/// Entries below `dir`, 0 when it is missing.
fn count_entries(dir: &Path) -> usize {
	let Ok(entries) = fs::read_dir(dir) else {
		return 0;
	};
	entries
		.filter_map(Result::ok)
		.map(|entry| {
			1 + match entry.file_type() {
				Ok(kind) if kind.is_dir() => count_entries(&entry.path()),
				_ => 0,
			}
		})
		.sum()
}

fn signal(child: &Child, signal: libc::c_int) {
	let pid = libc::pid_t::try_from(child.id()).unwrap();
	// SAFETY: `kill` takes plain integers; `pid` is our own child, not yet
	// reaped.
	assert_eq!(unsafe { libc::kill(pid, signal) }, 0, "kill({pid}, {signal})");
}

/// Waits until the child has written `min` entries below `target`, then stops
/// it, and checks that it stopped rather than exited. An add that finishes
/// first fails the test: the fixture is too small to stop it midway.
fn stop_mid_add(child: &Child, target: &Path, min: usize) {
	let pid = libc::pid_t::try_from(child.id()).unwrap();
	while count_entries(target) < min {
		let mut status = 0;
		// SAFETY: `status` is a live `c_int` the call writes; `pid` is our own
		// child.
		let waited = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
		assert_eq!(
			waited, 0,
			"the add ended (status {status:#x}) before it was stopped: enlarge the fixture"
		);
	}
	signal(child, libc::SIGSTOP);
	let mut status = 0;
	// SAFETY: as above; WUNTRACED reports the stop without reaping the child.
	assert_eq!(unsafe { libc::waitpid(pid, &mut status, libc::WUNTRACED) }, pid);
	assert!(
		libc::WIFSTOPPED(status),
		"the add ended (status {status:#x}) before the stop took: enlarge the fixture"
	);
}

/// Ends the stopped child with `kill`: SIGKILL directly, SIGTERM once it runs
/// again. Checks it died of that signal.
fn end_stopped(mut child: Child, kill: libc::c_int) {
	signal(&child, kill);
	if kill != libc::SIGKILL {
		signal(&child, libc::SIGCONT);
	}
	let status = child.wait().unwrap();
	assert_eq!(status.signal(), Some(kill), "the add did not die of signal {kill}: {status}");
}

/// The `git worktree list --porcelain` block of `worktree`, if listed.
fn listed_block(source: &Path, worktree: &Path) -> Option<String> {
	let listed = git(source, &["worktree", "list", "--porcelain"]);
	let canonical = fs::canonicalize(worktree.parent().unwrap())
		.unwrap()
		.join(worktree.file_name().unwrap());
	listed
		.split("\n\n")
		.find(|block| {
			let first = block.lines().next().unwrap_or_default();
			first == format!("worktree {}", worktree.display())
				|| first == format!("worktree {}", canonical.display())
		})
		.map(str::to_owned)
}

fn registrations(source: &Path) -> usize {
	fs::read_dir(source.join(".git/worktrees")).map_or(0, |entries| entries.count())
}

/// Stops an add midway, checks what git and another add see while it lives,
/// ends it with `kill`, and checks that the next add removes what it left.
fn interrupt_and_recover(clone: &str, tracked: bool, kill: libc::c_int) {
	let (temp, source, repo) = fixture(10_000, tracked);
	if clone != "off" && !clone_works_on(temp.path()) {
		eprintln!("SKIP: no working clone backend on this filesystem");
		return;
	}
	let target = temp.path().join("interrupted");
	let child = spawn_add(&source, &target, clone);
	stop_mid_add(&child, &target, 50);
	let listed_while_adding = listed_block(&source, &target);

	// While the add lives, another add leaves it alone.
	let beside = temp.path().join("beside");
	repo
		.worktree_add(&beside, "HEAD", options(WorktreeClone::Off))
		.unwrap();
	assert!(count_entries(&target) >= 50, "an add removed the tree of an add that is still running");

	end_stopped(child, kill);
	let partial = count_entries(&target);
	let after_kill = listed_block(&source, &target);

	// The next add removes the partial tree and its registration.
	let next = temp.path().join("next");
	repo
		.worktree_add(&next, "HEAD", options(WorktreeClone::Off))
		.unwrap();
	assert!(
		!target.exists(),
		"the next add left the stopped add's partial tree ({partial} entries at {})",
		target.display()
	);
	assert_eq!(listed_block(&source, &target), None, "the next add left the stopped add registered");
	assert_eq!(registrations(&source), 2, "registrations other than `beside` and `next` remain");
	assert_eq!(fs::read_to_string(next.join("a.txt")).unwrap(), "tracked\n");

	// While it ran, git saw the add's registration locked as its own add
	// locks one, and after the kill it still did, so `git worktree prune`
	// could not take it from under the cleanup.
	for (when, block) in
		[("while the add ran", &listed_while_adding), ("after the kill", &after_kill)]
	{
		let block = block
			.as_deref()
			.unwrap_or_else(|| panic!("{when}, git listed no registration for {}", target.display()));
		assert!(
			block.lines().any(|line| line == "locked initializing"),
			"{when}, git listed the add's registration without `locked initializing`:\n{block}"
		);
	}
}

#[test]
fn a_clone_killed_midway_is_removed_by_the_next_add() {
	interrupt_and_recover("auto", false, libc::SIGKILL);
}

#[test]
fn a_clone_terminated_midway_is_removed_by_the_next_add() {
	interrupt_and_recover("auto", false, libc::SIGTERM);
}

#[test]
fn a_checkout_killed_midway_is_removed_by_the_next_add() {
	interrupt_and_recover("off", true, libc::SIGKILL);
}

#[test]
fn a_checkout_terminated_midway_is_removed_by_the_next_add() {
	interrupt_and_recover("off", true, libc::SIGTERM);
}
