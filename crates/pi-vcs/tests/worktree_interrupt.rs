//! A `worktree add` stopped by a signal before it finishes leaves a
//! registration git reports as locked (`locked initializing`, what git's own
//! add holds while it fills a tree). An add of another path leaves it alone; an
//! add of the same path empties the partial tree (the directory stays) and
//! removes that registration, while both are still what the stopped add left,
//! and refuses otherwise. While the stopped add's process lives, an add of its
//! path is refused.
//!
//! The add runs in a child process: this test binary run again with
//! [`CHILD_SOURCE`] set, on the test [`interrupted_add_child`] alone.
#![cfg(target_os = "linux")]

use std::{
	env, fs,
	os::unix::process::{CommandExt, ExitStatusExt},
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
		// 10,000 loose objects pass `gc.auto`'s threshold, and a background
		// `git gc --auto` would pack and delete them under a running add.
		("gc.auto", "0"),
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

/// Starts the add in a child process, in a process group of its own: the
/// tests stop it with `SIGSTOP`, and a stopped member makes some kernels
/// (gVisor) send `SIGHUP` to its whole group, the test runner's too, when
/// another member exits while that group has no parent outside it.
fn spawn_add(source: &Path, target: &Path, clone: &str) -> Child {
	Command::new(env::current_exe().unwrap())
		.process_group(0)
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

/// Stops an add midway, checks what git and other adds see while it lives,
/// ends it with `kill`, checks that an add of another path leaves what it
/// left, and that an add of its path removes it and says so.
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

	// While the add lives, an add of another path leaves it alone, and an
	// add of its path is refused.
	let beside = temp.path().join("beside");
	repo
		.worktree_add(&beside, "HEAD", options(WorktreeClone::Off))
		.unwrap();
	let refused = repo
		.worktree_add(&target, "HEAD", options(WorktreeClone::Off))
		.unwrap_err()
		.to_string();
	assert!(refused.contains("another worktree add that is still running"), "{refused}");
	assert!(count_entries(&target) >= 50, "an add removed the tree of an add that is still running");

	end_stopped(child, kill);
	let partial = count_entries(&target);
	let after_kill = listed_block(&source, &target);

	// An add of another path leaves what the stopped add left.
	let next = temp.path().join("next");
	repo
		.worktree_add(&next, "HEAD", options(WorktreeClone::Off))
		.unwrap();
	assert_eq!(
		count_entries(&target),
		partial,
		"an add of another path changed the stopped add's tree"
	);
	assert!(
		listed_block(&source, &target).is_some(),
		"an add of another path removed the registration"
	);

	// An add of the same path empties the partial tree and removes its
	// registration.
	let again = repo
		.worktree_add(&target, "HEAD", options(WorktreeClone::Off))
		.unwrap_or_else(|err| {
			panic!("adding {} again ({partial} entries left): {err}", target.display())
		});
	assert!(
		again
			.notes
			.iter()
			.any(|note| note.contains("emptied the partial tree")),
		"{:?}",
		again.notes
	);
	assert_eq!(fs::read_to_string(target.join("a.txt")).unwrap(), "tracked\n");
	assert_eq!(
		registrations(&source),
		3,
		"registrations other than `beside`, `next` and the new add remain"
	);
	let block = listed_block(&source, &target).unwrap();
	assert!(!block.contains("locked"), "the new add is locked:\n{block}");

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
fn a_clone_killed_midway_is_emptied_by_an_add_of_its_path() {
	interrupt_and_recover("auto", false, libc::SIGKILL);
}

#[test]
fn a_clone_terminated_midway_is_emptied_by_an_add_of_its_path() {
	interrupt_and_recover("auto", false, libc::SIGTERM);
}

#[test]
fn a_checkout_killed_midway_is_emptied_by_an_add_of_its_path() {
	interrupt_and_recover("off", true, libc::SIGKILL);
}

#[test]
fn a_checkout_terminated_midway_is_emptied_by_an_add_of_its_path() {
	interrupt_and_recover("off", true, libc::SIGTERM);
}

/// A checkout killed midway: the temp dir, the source, the repository and the
/// partial tree.
fn abandoned() -> (TempDir, PathBuf, GitRepo, PathBuf) {
	let (temp, source, repo) = fixture(10_000, true);
	let target = temp.path().join("interrupted");
	let child = spawn_add(&source, &target, "off");
	stop_mid_add(&child, &target, 50);
	end_stopped(child, libc::SIGKILL);
	(temp, source, repo, target)
}

/// The administrative directory of the registration that names `tree`.
fn admin_of(source: &Path, tree: &Path) -> PathBuf {
	let wanted = format!("{}\n", tree.join(".git").display());
	fs::read_dir(source.join(".git/worktrees"))
		.unwrap()
		.map(|entry| entry.unwrap().path())
		.find(|admin| fs::read_to_string(admin.join("gitdir")).is_ok_and(|back| back == wanted))
		.unwrap_or_else(|| panic!("no registration names {}", tree.display()))
}

/// Someone unlocked the killed add's worktree and works in it: an add of the
/// path refuses, naming the registration, and removes nothing.
#[test]
fn an_add_refuses_a_killed_adds_tree_someone_unlocked() {
	let (_temp, source, repo, target) = abandoned();
	git(&source, &["worktree", "unlock", target.to_str().unwrap()]);
	fs::write(target.join("my-work.txt"), "written after the add was killed\n").unwrap();
	let refused = repo
		.worktree_add(&target, "HEAD", options(WorktreeClone::Off))
		.unwrap_err()
		.to_string();
	assert!(refused.contains("lock was changed or removed"), "{refused}");
	assert!(refused.contains(&admin_of(&source, &target).display().to_string()), "{refused}");
	assert!(target.join("my-work.txt").is_file(), "the unlocked tree was removed");
	assert!(listed_block(&source, &target).is_some(), "the unlocked registration was removed");
}

/// Someone removed the killed add's tree and made the directory again with
/// work of their own: an add of the path refuses and removes nothing.
#[test]
fn an_add_refuses_a_directory_made_again_in_a_killed_adds_place() {
	let (_temp, source, repo, target) = abandoned();
	let before = std::os::unix::fs::MetadataExt::ino(&fs::metadata(&target).unwrap());
	fs::remove_dir_all(&target).unwrap();
	fs::create_dir(&target).unwrap();
	let after = std::os::unix::fs::MetadataExt::ino(&fs::metadata(&target).unwrap());
	eprintln!("made again with the same inode: {}", before == after);
	fs::write(target.join("my-work.txt"), "a directory of someone else's\n").unwrap();
	let refused = repo
		.worktree_add(&target, "HEAD", options(WorktreeClone::Off))
		.unwrap_err()
		.to_string();
	assert!(refused.contains("cannot be told apart"), "{refused}");
	assert!(target.join("my-work.txt").is_file(), "the directory made again was removed");
	assert!(listed_block(&source, &target).is_some(), "the registration was removed");
}

/// Someone replaced the killed add's `.git` with a repository of their own
/// and committed there: an add of the path refuses, as git refuses a path
/// that exists, and the repository stays.
#[test]
fn an_add_refuses_a_killed_adds_tree_holding_a_repository_of_its_own() {
	let (_temp, source, repo, target) = abandoned();
	fs::remove_file(target.join(".git")).unwrap();
	git(&target, &["init", "-q", "-b", "main"]);
	fs::write(target.join("my-work.txt"), "committed after the add was killed\n").unwrap();
	git(&target, &["add", "my-work.txt"]);
	git(&target, &[
		"-c",
		"user.name=T",
		"-c",
		"user.email=t@example.com",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"mine",
	]);
	let refused = repo
		.worktree_add(&target, "HEAD", options(WorktreeClone::Off))
		.unwrap_err()
		.to_string();
	assert!(refused.contains("`.git` that is not this registration's"), "{refused}");
	assert_eq!(git(&target, &["log", "-1", "--format=%s"]), "mine", "the repository was removed");
	assert!(listed_block(&source, &target).is_some(), "the registration was removed");
}

/// Someone cloned a repository below the root of the killed add's tree and
/// committed there: an add of the path refuses, as git refuses a path that
/// exists, and the clone and its commit stay.
#[test]
fn an_add_refuses_a_killed_adds_tree_with_a_repository_cloned_below_its_root() {
	let (_temp, source, repo, target) = abandoned();
	let dep = target.join("vendor/dep");
	fs::create_dir_all(target.join("vendor")).unwrap();
	git(&target.join("vendor"), &["clone", "-q", source.to_str().unwrap(), "dep"]);
	fs::write(dep.join("my-work.txt"), "committed after the add was killed\n").unwrap();
	git(&dep, &["add", "my-work.txt"]);
	git(&dep, &[
		"-c",
		"user.name=T",
		"-c",
		"user.email=t@example.com",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"unpushed",
	]);
	let refused = repo
		.worktree_add(&target, "HEAD", options(WorktreeClone::Off))
		.unwrap_err()
		.to_string();
	assert!(refused.contains("holds a repository ("), "{refused}");
	assert_eq!(git(&dep, &["log", "-1", "--format=%s"]), "unpushed", "the clone was removed");
	assert!(listed_block(&source, &target).is_some(), "the registration was removed");
}

/// The agent kept working in the killed add's tree and committed on its
/// detached HEAD: git records that commit only in the registration
/// (`HEAD`, `logs/HEAD`). An add of the path refuses, as git refuses a path
/// that exists, and the commit stays reachable.
#[test]
fn an_add_refuses_a_killed_adds_tree_with_a_commit_on_its_head() {
	let (_temp, source, repo, target) = abandoned();
	git(&target, &[
		"-c",
		"user.name=T",
		"-c",
		"user.email=t@example.com",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"fix",
	]);
	let commit = git(&target, &["rev-parse", "HEAD"]);
	let refused = repo
		.worktree_add(&target, "HEAD", options(WorktreeClone::Off))
		.unwrap_err()
		.to_string();
	assert!(refused.contains("HEAD moved"), "{refused}");
	assert_eq!(git(&target, &["rev-parse", "HEAD"]), commit, "the commit is gone");
	assert_eq!(git(&target, &["log", "-1", "--format=%s"]), "fix");
	assert!(listed_block(&source, &target).is_some(), "the registration was removed");
}

/// A killed add whose registration names its tree by a relative `gitdir`,
/// as `git worktree repair` writes it under `worktree.useRelativePaths`, is
/// resolved against the registration, not the working directory.
#[test]
fn an_add_reclaims_a_killed_add_whose_gitdir_is_relative() {
	let (_temp, source, repo, target) = abandoned();
	let admin = admin_of(&source, &target);
	// `<temp>/source/.git/worktrees/<id>` to `<temp>/interrupted/.git`.
	fs::write(admin.join("gitdir"), "../../../../interrupted/.git\n").unwrap();
	let again = repo
		.worktree_add(&target, "HEAD", options(WorktreeClone::Off))
		.unwrap_or_else(|err| panic!("adding {} again: {err}", target.display()));
	assert!(!admin.join("omp-add-in-progress").exists());
	assert_eq!(fs::read_to_string(target.join("a.txt")).unwrap(), "tracked\n");
	assert!(
		again
			.notes
			.iter()
			.any(|note| note.contains("emptied the partial tree")),
		"{:?}",
		again.notes
	);
}
