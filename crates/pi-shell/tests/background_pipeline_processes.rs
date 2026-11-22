//! The processes of a background pipeline as bash 5.3.20 and zsh 5.9 see
//! them (`obash -c`, `-f -c` as `zsh`; bash 5.2.21 prints the same). Both
//! fork every stage of an asynchronous pipeline, and `$!` names the last
//! process: a last stage that runs no lone program has `$!` as its own pid
//! (`$BASHPID`).
#![cfg(target_os = "linux")]

mod obash_support;

/// `script` through obash in a fresh directory (`zsh`: as `zsh -f -c`):
/// standard output, then standard error, then the exit status.
fn run(script: &str, zsh: bool) -> (String, String, Option<i32>) {
	let dir = tempfile::tempdir().unwrap();
	let mut cmd = obash_support::obash();
	cmd.current_dir(dir.path());
	if zsh {
		std::os::unix::process::CommandExt::arg0(&mut cmd, "zsh");
		cmd.arg("-f");
	}
	let out = obash_support::output(cmd.args(["-c", script]));
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status.code(),
	)
}

/// Each row of `rows` (`name`, `script`, `zsh`) gives `out` on standard
/// output, nothing on standard error and status 0; every row that does not
/// is listed.
fn assert_rows(rows: &[(&str, String, bool)], out: &str) {
	let want = (out.to_owned(), String::new(), Some(0));
	let mismatches: Vec<String> = rows
		.iter()
		.filter_map(|(name, script, zsh)| {
			let got = run(script, *zsh);
			(got != want).then(|| format!("{name}: {got:?}, want {want:?}"))
		})
		.collect();
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

#[test]
fn the_last_stage_is_named_by_bang() {
	let script =
		"{ :; } | { echo $BASHPID > B; } & p=$!; wait; [ \"$(cat B)\" = \"$p\" ] && echo same";
	assert_rows(
		&[
			("bash", script.to_owned(), false),
			("bash lastpipe", format!("shopt -s lastpipe; {script}"), false),
		],
		"same\n",
	);
}
