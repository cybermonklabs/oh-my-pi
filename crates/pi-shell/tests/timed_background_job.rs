//! `time a | b &`, as bash 5.2.21, 5.3.20 and zsh 5.9 run it (`obash -c`,
//! `-f -c` as `zsh`): bash runs an asynchronous timed command as a subshell
//! of its own (`CMD_FORCE_SUBSHELL`), and zsh times the job's own process.
//! `$!` names that process, not `b`, and `kill $!` ends the job (status
//! 143) though `b` has already ended. The first stage writes R once `b`'s
//! pid is gone from `/proc`, so the answer does not depend on timing.
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

/// `b` writes its pid to L and exits 0; `a` writes R once `b` is gone,
/// waits for G, and exits 7. Then `wait WAIT`: zsh mode waits by pid,
/// since whether `%1` still names a killed job before zsh reaps it is the
/// job table's question, not this one's.
const TIMED: &str = "time /bin/sh -c 'until [ -s L ]; do :; done; read p < L; while [ -e /proc/$p \
                     ]; do :; done; : > R; until [ -e G ]; do :; done; exit 7' | /bin/sh -c 'echo \
                     $$ > L; exit 0' & q=$!; until [ -e R ]; do :; done; [ \"$q\" = \"$(cat L)\" \
                     ] && echo last=yes || echo last=no; kill $q 2>/dev/null; echo k=$?; : > G; \
                     wait WAIT; echo w=$?";

#[test]
fn a_timed_background_job_is_known_by_its_own_pid() {
	let timed = |wait: &str| TIMED.replace("WAIT", wait);
	let rows = [
		("bash", format!("exec 2>/dev/null; TIMEFORMAT=; {}", timed("%1")), false),
		(
			"bash lastpipe",
			format!("exec 2>/dev/null; TIMEFORMAT=; shopt -s lastpipe; {}", timed("%1")),
			false,
		),
		("zsh", format!("exec 2>/dev/null; TIMEFMT=; {}", timed("$q")), true),
	];
	let want = (String::from("last=no\nk=0\nw=143\n"), String::new(), Some(0));
	let mismatches: Vec<String> = rows
		.iter()
		.filter_map(|(name, script, zsh)| {
			let got = run(script, *zsh);
			(got != want).then(|| format!("{name}: {got:?}, want {want:?}"))
		})
		.collect();
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
