//! A `worktree add` that fails leaves what `git worktree add` leaves when it
//! fails: no tree, no registration and no lock.

use std::{
	fs,
	path::{Path, PathBuf},
	process::Command,
};

use pi_vcs::{
	git::GitRepo,
	types::{WorktreeAddOptions, WorktreeClone},
};
use tempfile::TempDir;

fn git_output(dir: &Path, args: &[&str]) -> std::process::Output {
	Command::new("git")
		.arg("-C")
		.arg(dir)
		.args(args)
		.output()
		.unwrap()
}

fn git(dir: &Path, args: &[&str]) -> String {
	let output = git_output(dir, args);
	assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
	String::from_utf8(output.stdout)
		.unwrap()
		.trim_end()
		.to_owned()
}

/// A repository at `B` whose parent commit `A` holds `blob.txt` = `v1`, with
/// that blob's object deleted: checking out `A` fails, as it does in a partial
/// clone whose blobs were never fetched. Returns the temp dir, the source, the
/// repository and `A`.
fn fixture() -> (TempDir, PathBuf, GitRepo, String) {
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
	fs::write(source.join("blob.txt"), "v1\n").unwrap();
	git(&source, &["add", "."]);
	git(&source, &["commit", "-qm", "A"]);
	let first = git(&source, &["rev-parse", "HEAD"]);
	let blob = git(&source, &["rev-parse", "HEAD:blob.txt"]);
	fs::write(source.join("blob.txt"), "v2\n").unwrap();
	git(&source, &["commit", "-qam", "B"]);
	let object = source
		.join(".git/objects")
		.join(&blob[..2])
		.join(&blob[2..]);
	fs::remove_file(&object)
		.unwrap_or_else(|err| panic!("the v1 blob is not loose at {}: {err}", object.display()));
	let repo = GitRepo::require(&source).unwrap();
	(temp, source, repo, first)
}

/// The registrations under `.git/worktrees`, by name.
fn registrations(source: &Path) -> Vec<String> {
	let Ok(entries) = fs::read_dir(source.join(".git/worktrees")) else {
		return Vec::new();
	};
	let mut names: Vec<String> = entries
		.map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
		.collect();
	names.sort();
	names
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

/// Control: git's own add of the same commit fails and leaves nothing, with a
/// lock asked for or not.
#[test]
fn git_leaves_nothing_when_the_same_add_fails() {
	let locks: [&[&str]; 2] = [&["--lock", "--reason", "in use"], &[]];
	for lock in locks {
		let (temp, source, _repo, first) = fixture();
		let target = temp.path().join("by-git");
		let mut args = vec!["worktree", "add", "-q", "--detach"];
		args.extend_from_slice(lock);
		args.extend([target.to_str().unwrap(), first.as_str()]);
		let output = git_output(&source, &args);
		assert!(
			!output.status.success(),
			"{lock:?}: git's add of the commit with a missing blob succeeded"
		);
		assert!(!target.exists(), "{lock:?}: git left {}", target.display());
		assert_eq!(registrations(&source), Vec::<String>::new(), "{lock:?}: git left a registration");
	}
}

/// A failed checkout, on the ordinary path and after a failed clone attempt,
/// leaves no tree, no registration and no lock, with a lock asked for or not.
#[test]
fn a_failed_add_leaves_no_tree_and_no_registration() {
	for clone in [WorktreeClone::Off, WorktreeClone::Auto] {
		for lock in [Some("in use"), None] {
			let (temp, source, repo, first) = fixture();
			if clone != WorktreeClone::Off && !clone_works_on(temp.path()) {
				eprintln!("SKIP: no working clone backend on this filesystem ({clone:?} case)");
				continue;
			}
			let target = temp.path().join("target");
			let result = repo.worktree_add(&target, &first, WorktreeAddOptions {
				detach: true,
				clone,
				keep_changes: false,
				lock: lock.map(str::to_owned),
			});
			assert!(
				result.is_err(),
				"{clone:?} {lock:?}: the add of a commit with a missing blob succeeded"
			);
			assert!(!target.exists(), "{clone:?} {lock:?}: the failed add left {}", target.display());
			assert_eq!(
				registrations(&source),
				Vec::<String>::new(),
				"{clone:?} {lock:?}: the failed add left a registration:\n{}",
				git(&source, &["worktree", "list", "--porcelain"])
			);
		}
	}
}

/// A failed add into an empty directory that was already there leaves the
/// directory, empty, as it found it.
#[test]
fn a_failed_add_into_an_existing_empty_directory_leaves_it_empty() {
	let (temp, source, repo, first) = fixture();
	let target = temp.path().join("target");
	fs::create_dir(&target).unwrap();
	let result = repo.worktree_add(&target, &first, WorktreeAddOptions {
		detach:       true,
		clone:        WorktreeClone::Off,
		keep_changes: false,
		lock:         Some("in use".to_owned()),
	});
	assert!(result.is_err());
	assert_eq!(fs::read_dir(&target).map(|entries| entries.count()).ok(), Some(0));
	assert_eq!(registrations(&source), Vec::<String>::new());
}

/// A clone copies the source root's mode onto the tree. From a source whose
/// root is 0500 and holds nothing but `.git`, the clone leaves the tree
/// unwritable and its add fails; the plain checkout that follows still gets
/// a tree it can write.
#[cfg(unix)]
#[test]
fn a_failed_clone_leaves_the_checkout_a_writable_tree() {
	use std::os::unix::fs::PermissionsExt;
	let temp = tempfile::tempdir().unwrap();
	if !clone_works_on(temp.path()) {
		eprintln!("SKIP: no working clone backend on this filesystem");
		return;
	}
	let source = temp.path().join("source");
	fs::create_dir(&source).unwrap();
	git(&source, &["init", "-q", "-b", "main"]);
	for (key, value) in
		[("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")]
	{
		git(&source, &["config", key, value]);
	}
	git(&source, &["commit", "-q", "--allow-empty", "-m", "empty"]);
	git(&source, &["read-tree", "HEAD"]);
	let repo = GitRepo::require(&source).unwrap();
	fs::set_permissions(&source, fs::Permissions::from_mode(0o500)).unwrap();
	if fs::write(source.join("probe"), "").is_ok() {
		fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();
		eprintln!("SKIP: running as root, where a 0500 directory is still writable");
		return;
	}
	let target = temp.path().join("target");
	let result = repo.worktree_add(&target, "HEAD", WorktreeAddOptions {
		detach:       true,
		clone:        WorktreeClone::Auto,
		keep_changes: false,
		lock:         None,
	});
	fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();
	let result = result.unwrap_or_else(|err| panic!("the add failed: {err}"));
	assert!(target.join(".git").is_file(), "{result:?}");
	assert_eq!(git(&target, &["rev-parse", "HEAD"]), git(&source, &["rev-parse", "HEAD"]));
}

/// An add into an empty directory the user can write but does not own (a
/// mount point, or one in a directory owned by root) succeeds, as git's does:
/// where a clone attempt fails, the directory keeps its mode, and only its
/// owner may change a mode, even to the same value.
///
/// It needs such a directory, which a test run as an unprivileged user cannot
/// make: the builds Job makes one as root and names it in
/// `PI_VCS_TEST_FOREIGN_EMPTY_DIR`. Run with `--ignored`.
#[cfg(unix)]
#[test]
#[ignore = "needs an empty directory owned by another user: PI_VCS_TEST_FOREIGN_EMPTY_DIR"]
fn an_add_into_an_empty_directory_someone_else_owns_succeeds() {
	use std::os::unix::fs::MetadataExt;
	let target = PathBuf::from(
		std::env::var("PI_VCS_TEST_FOREIGN_EMPTY_DIR")
			.expect("PI_VCS_TEST_FOREIGN_EMPTY_DIR names an empty directory owned by another user"),
	);
	// SAFETY: `geteuid` takes nothing and cannot fail.
	let me = unsafe { libc::geteuid() };
	let meta = fs::metadata(&target).unwrap();
	assert_ne!(meta.uid(), me, "{} is owned by this user", target.display());
	assert_eq!(fs::read_dir(&target).unwrap().count(), 0, "{} is not empty", target.display());
	let mode = meta.mode() & 0o7777;
	let temp = tempfile::tempdir().unwrap();
	let source = temp.path().join("source");
	fs::create_dir(&source).unwrap();
	git(&source, &["init", "-q", "-b", "main"]);
	for (key, value) in
		[("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")]
	{
		git(&source, &["config", key, value]);
	}
	fs::write(source.join("a.txt"), "tracked\n").unwrap();
	git(&source, &["add", "."]);
	git(&source, &["commit", "-qm", "A"]);
	let repo = GitRepo::require(&source).unwrap();
	let result = repo
		.worktree_add(&target, "HEAD", WorktreeAddOptions {
			detach:       true,
			clone:        WorktreeClone::Auto,
			keep_changes: false,
			lock:         None,
		})
		.unwrap_or_else(|err| panic!("the add into {} failed: {err}", target.display()));
	eprintln!("cloned_with={:?} clone_error={:?}", result.cloned_with, result.clone_error);
	assert_eq!(fs::read_to_string(target.join("a.txt")).unwrap(), "tracked\n");
	let after = fs::metadata(&target).unwrap();
	assert_eq!((after.ino(), after.mode() & 0o7777), (meta.ino(), mode), "the directory changed");
}
