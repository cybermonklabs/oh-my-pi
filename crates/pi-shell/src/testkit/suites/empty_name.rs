//! An empty word names no file over the in-memory filesystem, whose answers
//! may all come later (`Pending`): a redirection target, `.`'s file and a
//! nested shell's script fail `ENOENT` as bash 5.3.20 says (`bash -c`, the
//! nested `bash` 5.3.20 too), and nothing makes a file named "". The engine
//! took the empty word for the working directory, `/`: `read` and `exec`
//! read it, `.` and `bash` ran it as an empty script.

use crate::testkit::{FakeHost, Fault, MemFs, run_script};

const SRC: &str = "read x < ''; echo r=$?; : > ''; echo w=$?; exec 3< ''; echo e=$?; . ''; echo \
                   d=$?; bash ''; echo b=$?";

#[test]
fn an_empty_word_names_no_file_whenever_the_filesystem_answers() {
	for p_pending in [0.0, 1.0] {
		let fs = MemFs::with_latency(11, p_pending, 2);
		let out = run_script(FakeHost::new().with_fs(fs.clone()), SRC.as_bytes(), &[], Fault::None);
		assert_eq!(String::from_utf8_lossy(&out.stdout), "r=1\nw=1\ne=1\nd=1\nb=127\n");
		assert_eq!(
			String::from_utf8_lossy(&out.stderr),
			"bash: line 1: : No such file or directory\n".repeat(4)
				+ "bash: : No such file or directory\n"
		);
		assert!(fs.read("").is_none(), "a file named \"\" was made");
	}
}
