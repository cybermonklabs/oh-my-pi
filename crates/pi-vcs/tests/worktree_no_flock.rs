//! A `worktree add` where the filesystem refuses `flock` (`ENOLCK`, as on an
//! NFS mount without a lock daemon) succeeds as git's does. Its registration
//! then has no add-in-progress marker, so no later add takes it for an
//! abandoned one.
//!
//! The add runs in a child process under `strace`, which makes every `flock`
//! call fail with `ENOLCK`: this test binary run again with [`CHILD_SOURCE`]
//! set, on the test [`no_flock_child`] alone. Without `strace` the test says
//! so and skips.
#![cfg(target_os = "linux")]

use std::{
	env, fs,
	path::Path,
	process::{Command, Stdio},
};

use pi_vcs::{
	git::GitRepo,
	types::{WorktreeAddOptions, WorktreeClone},
};

const CHILD_SOURCE: &str = "PI_VCS_TEST_NO_FLOCK_SOURCE";
const CHILD_TARGET: &str = "PI_VCS_TEST_NO_FLOCK_TARGET";
const CHILD_CLONE: &str = "PI_VCS_TEST_NO_FLOCK_CLONE";

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

/// The child's add, under `strace`. It first checks that `flock` really fails
/// here, so a run where the injection did not take cannot pass.
#[test]
fn no_flock_child() {
	let (Ok(source), Ok(target), Ok(clone)) =
		(env::var(CHILD_SOURCE), env::var(CHILD_TARGET), env::var(CHILD_CLONE))
	else {
		return;
	};
	let probe = tempfile::tempfile().unwrap();
	match probe.try_lock() {
		Err(fs::TryLockError::Error(err)) => eprintln!("CONTROL flock refused: {err}"),
		other => panic!("CONTROL flock was not refused ({other:?}): the injection did not take"),
	}
	let clone = if clone == "off" {
		WorktreeClone::Off
	} else {
		WorktreeClone::Auto
	};
	let result = GitRepo::require(Path::new(&source))
		.unwrap()
		.worktree_add(Path::new(&target), "HEAD", WorktreeAddOptions {
			detach: true,
			clone,
			keep_changes: false,
			lock: None,
		})
		.unwrap_or_else(|err| panic!("ADD FAILED: {err}"));
	eprintln!("ADD OK cloned_with={:?} clone_error={:?}", result.cloned_with, result.clone_error);
}

fn strace() -> Option<&'static str> {
	Command::new("strace")
		.arg("-V")
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.status()
		.is_ok_and(|status| status.success())
		.then_some("strace")
}

#[test]
fn an_add_succeeds_where_the_filesystem_refuses_flock() {
	let Some(strace) = strace() else {
		eprintln!("SKIP: strace is not installed, so nothing can make flock fail here");
		return;
	};
	for clone in ["off", "auto"] {
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
		let target = temp.path().join("target");
		let output = Command::new(strace)
			.args([
				"-f",
				"-qq",
				"-o",
				"/dev/null",
				"-e",
				"trace=flock",
				"-e",
				"inject=flock:error=ENOLCK",
			])
			.arg(env::current_exe().unwrap())
			.args(["no_flock_child", "--exact", "--nocapture", "--test-threads=1"])
			.env(CHILD_SOURCE, &source)
			.env(CHILD_TARGET, &target)
			.env(CHILD_CLONE, clone)
			.output()
			.unwrap();
		let stderr = String::from_utf8_lossy(&output.stderr);
		assert!(
			stderr.contains("CONTROL flock refused"),
			"{clone}: the flock injection did not run:\n{stderr}"
		);
		assert!(
			output.status.success() && stderr.contains("ADD OK"),
			"{clone}: the add failed without flock:\n{stderr}"
		);
		assert_eq!(fs::read_to_string(target.join("a.txt")).unwrap(), "tracked\n", "{clone}");
		let admin = fs::read_dir(source.join(".git/worktrees"))
			.unwrap()
			.map(|entry| entry.unwrap().path())
			.next()
			.unwrap();
		assert!(
			!admin.join("omp-add-in-progress").exists(),
			"{clone}: a marker nobody could lock was left"
		);
		assert!(!admin.join("locked").exists(), "{clone}: the finished add stayed locked");
		let listed = git(&source, &["worktree", "list", "--porcelain"]);
		assert!(!listed.contains("locked"), "{clone}:\n{listed}");
	}
}
