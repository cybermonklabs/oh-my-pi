//! What one `worktree add` does to the registrations and trees of adds that
//! died, once someone has worked in those trees: an add of an unrelated path
//! leaves them all, and an add of one of their paths refuses a registration it
//! cannot prove is still what the dead add left. Built from a reviewer's probe
//! of a sweep that every add ran.

use std::{fs, path::Path, process::Command};

use pi_vcs::{
	git::GitRepo,
	types::{WorktreeAddOptions, WorktreeClone},
};

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

/// A registration as a killed add leaves it, with an add-in-progress marker
/// that records nothing, a tree linked to it or not, and a file written into
/// the tree afterwards.
fn abandoned(common: &Path, name: &str, tree: &Path, head: &str, link: bool) {
	let admin = common.join("worktrees").join(name);
	fs::create_dir_all(&admin).unwrap();
	fs::write(admin.join("locked"), "initializing\n").unwrap();
	fs::write(admin.join("gitdir"), format!("{}\n", tree.join(".git").display())).unwrap();
	fs::write(admin.join("commondir"), "../..\n").unwrap();
	fs::write(admin.join("HEAD"), format!("{head}\n")).unwrap();
	fs::write(admin.join("omp-add-in-progress"), "").unwrap();
	fs::create_dir_all(tree).unwrap();
	if link {
		fs::write(tree.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
	}
	fs::write(tree.join("my-work.txt"), "written after the add was killed\n").unwrap();
}

const fn options() -> WorktreeAddOptions {
	WorktreeAddOptions {
		detach:       true,
		clone:        WorktreeClone::Off,
		keep_changes: false,
		lock:         None,
	}
}

#[test]
fn an_add_leaves_the_trees_of_dead_adds_someone_works_in() {
	let temp = tempfile::tempdir().unwrap();
	let source = temp.path().join("source");
	fs::create_dir(&source).unwrap();
	git(&source, &["init", "-q", "-b", "main"]);
	for (key, value) in
		[("user.name", "T"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")]
	{
		git(&source, &["config", key, value]);
	}
	fs::write(source.join("a.txt"), "tracked\n").unwrap();
	git(&source, &["add", "."]);
	git(&source, &["commit", "-qm", "A"]);
	let head = git(&source, &["rev-parse", "HEAD"]);
	let common = source.join(".git");
	let linked = temp.path().join("linked-tree");
	let unlinked = temp.path().join("unlinked-tree");
	abandoned(&common, "linked-tree", &linked, &head, true);
	abandoned(&common, "unlinked-tree", &unlinked, &head, false);
	let repo = GitRepo::require(&source).unwrap();

	// An add of an unrelated path.
	repo
		.worktree_add(&temp.path().join("elsewhere"), "HEAD", options())
		.unwrap();
	for tree in [&linked, &unlinked] {
		assert!(tree.join("my-work.txt").is_file(), "an unrelated add deleted {}", tree.display());
	}
	let listed = git(&source, &["worktree", "list", "--porcelain"]);
	for name in ["linked-tree", "unlinked-tree"] {
		assert!(
			common.join("worktrees").join(name).is_dir(),
			"an unrelated add removed {name}:\n{listed}"
		);
	}

	// An add of their own paths: a marker that records nothing proves
	// nothing, so each is refused and kept.
	for tree in [&linked, &unlinked] {
		let refused = repo
			.worktree_add(tree, "HEAD", options())
			.unwrap_err()
			.to_string();
		assert!(refused.contains("interrupted worktree add"), "{refused}");
		assert!(tree.join("my-work.txt").is_file(), "an add of {} deleted it", tree.display());
	}
}
