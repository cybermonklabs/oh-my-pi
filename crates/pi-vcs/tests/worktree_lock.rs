//! A linked worktree pi-vcs creates can be locked as
//! `git worktree add --lock --reason <reason>` locks one, on the clone path and
//! the ordinary-checkout path alike.

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

fn fixture() -> (TempDir, PathBuf, GitRepo) {
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
	git(&source, &["add", "."]);
	git(&source, &["commit", "-qm", "base"]);
	let repo = GitRepo::require(&source).unwrap();
	(temp, source, repo)
}

/// The administrative directory a linked worktree's `.git` file names.
fn admin(worktree: &Path) -> PathBuf {
	let pointer = fs::read_to_string(worktree.join(".git")).unwrap();
	PathBuf::from(pointer.strip_prefix("gitdir: ").unwrap().trim_end())
}

fn options(clone: WorktreeClone, lock: Option<&str>) -> WorktreeAddOptions {
	WorktreeAddOptions { detach: true, clone, keep_changes: false, lock: lock.map(str::to_owned) }
}

/// The `locked` file holds exactly the bytes git writes for the same reason,
/// including an empty reason, and `git worktree list` reports it.
#[test]
fn worktree_add_writes_the_lock_git_writes() {
	for clone in [WorktreeClone::Off, WorktreeClone::Auto] {
		for reason in ["agent session: locked on add (AGENTC-431)", ""] {
			let (temp, source, repo) = fixture();
			let by_git = temp.path().join("by-git");
			git(&source, &[
				"worktree",
				"add",
				"-q",
				"--detach",
				"--lock",
				"--reason",
				reason,
				by_git.to_str().unwrap(),
				"HEAD",
			]);
			let target = temp.path().join("target");
			repo
				.worktree_add(&target, "HEAD", options(clone, Some(reason)))
				.unwrap();
			assert_eq!(
				fs::read(admin(&target).join("locked")).unwrap(),
				fs::read(admin(&by_git).join("locked")).unwrap(),
				"{clone:?} {reason:?}"
			);
			let listed = git(&source, &["worktree", "list", "--porcelain"]);
			let block = listed
				.split("\n\n")
				.find(|block| {
					block.starts_with(&format!("worktree {}\n", target.display()))
						|| block.starts_with(&format!(
							"worktree {}\n",
							fs::canonicalize(&target).unwrap().display()
						))
				})
				.unwrap_or_else(|| panic!("{} is not listed:\n{listed}", target.display()));
			let expected = if reason.is_empty() {
				"locked".to_owned()
			} else {
				format!("locked {reason}")
			};
			assert!(block.lines().any(|line| line == expected), "{clone:?} {reason:?}:\n{block}");
		}
	}
}

/// Without a lock, nothing is written: the registration is git's default one.
#[test]
fn worktree_add_without_a_lock_leaves_the_registration_unlocked() {
	for clone in [WorktreeClone::Off, WorktreeClone::Auto] {
		let (temp, _source, repo) = fixture();
		let target = temp.path().join("target");
		repo
			.worktree_add(&target, "HEAD", options(clone, None))
			.unwrap();
		assert!(
			fs::symlink_metadata(admin(&target).join("locked")).is_err(),
			"{clone:?}: an unlocked add wrote a lock"
		);
	}
}

/// The lock does what it is for: `git worktree prune` keeps a locked
/// registration whose tree is out of reach, and removes an unlocked one.
#[test]
fn a_locked_registration_survives_prune_while_its_tree_is_away() {
	let (temp, source, repo) = fixture();
	let mut admins = Vec::new();
	for (name, lock) in [("locked", Some("checked out on another machine")), ("unlocked", None)] {
		let target = temp.path().join(name);
		repo
			.worktree_add(&target, "HEAD", options(WorktreeClone::Off, lock))
			.unwrap();
		admins.push(admin(&target));
		fs::rename(&target, temp.path().join(format!("{name}-away"))).unwrap();
	}
	git(&source, &["worktree", "prune"]);
	assert!(admins[0].is_dir(), "prune removed a locked registration");
	assert!(!admins[1].exists(), "control: prune kept an unlocked registration whose tree is gone");
}
