//! A `&` job's fork keeps the redirections of the command it was made for,
//! and leaves at once when one of them fails, as Bash 5.3.20 runs these rows
//! (Bash 5.2.21 agrees on every one). bash forks such a job as a subshell
//! whose `execute_in_subshell` makes those redirections before it times the
//! command and without an undo, so the `time` report, a diagnostic of the
//! report's own format and the fork's EXIT trap all go through them; when
//! one fails it exits there (`exit (invert ? EXECUTION_SUCCESS :
//! EXECUTION_FAILURE)`), with no report.
//!
//! Every row below was measured against both bashes in a builds-namespace
//! Job (`timefork-rows1-runc`, `timefork-rows1-gvisor`, and the head's
//! `timefork-rows2-*`), as `-c` text and as a script.
#![cfg(unix)]

mod obash_support;

use std::{fs, os::unix::process::CommandExt as _};

use crate::obash_support::{obash, output};

/// A row: its name, whether it runs as a script (else as `-c` text), the
/// shell code, and bash's exit status, stdout and stderr.
type Row = (&'static str, bool, &'static str, i32, &'static str, &'static str);

/// Runs each row in a directory of its own holding the file `in`, as the
/// rows were measured (stdin `/dev/null`, `LC_ALL=C`, argv[0] `bash`, so a
/// diagnostic names `bash` or `./s.sh` as it does there), and reports every
/// row that differs from bash.
fn assert_rows(rows: &[Row]) {
	let mut mismatches = Vec::new();
	for &(name, file, script, status, want_out, want_err) in rows {
		let dir = tempfile::tempdir().expect("temp dir");
		fs::write(dir.path().join("in"), "hello\n").expect("write in");
		let mut cmd = obash();
		cmd.arg0("bash")
			.current_dir(dir.path())
			.env("PATH", "/usr/local/bin:/usr/bin:/bin")
			.env("HOME", dir.path())
			.env("LC_ALL", "C");
		if file {
			fs::write(dir.path().join("s.sh"), format!("{script}\n")).expect("write s.sh");
			cmd.arg("./s.sh");
		} else {
			cmd.args(["-c", script]);
		}
		let got = output(&mut cmd);
		let out = String::from_utf8_lossy(&got.stdout);
		let err = String::from_utf8_lossy(&got.stderr);
		if (got.status.code(), out.as_ref(), err.as_ref()) != (Some(status), want_out, want_err) {
			mismatches.push(format!(
				"{name} ({how})\n  `{script}`\n  bash:  Some({status}) {want_out:?} {want_err:?}\n  \
				 obash: {:?} {out:?} {err:?}",
				got.status.code(),
				how = if file { "script" } else { "-c" },
			));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ from bash:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

/// The time report of a timed `&` job goes where the job's own
/// redirections send stderr: to the file, to the appended file, to the
/// descriptor another redirection duplicated, or nowhere. The diagnostic of
/// an invalid `TIMEFORMAT` and the fork's EXIT trap follow it there, while a
/// redirection inside the job keeps its undo.
#[test]
fn the_report_of_a_timed_job_goes_through_its_own_redirections() {
	assert_rows(&[
		(
			"a-bg-group-null",
			false,
			"TIMEFORMAT=T; time { :; } 2>/dev/null & wait $!; echo \"st=$?\"",
			0,
			"st=0\n",
			"",
		),
		(
			"a-bg-group-null",
			true,
			"TIMEFORMAT=T; time { :; } 2>/dev/null & wait $!; echo \"st=$?\"",
			0,
			"st=0\n",
			"",
		),
		(
			"a-bg-group-file",
			false,
			"TIMEFORMAT=T; time { :; } 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-bg-group-file",
			true,
			"TIMEFORMAT=T; time { :; } 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-bg-group-dup",
			false,
			"TIMEFORMAT=T; time { echo in; } 2>&1 >out & wait $!; echo \"st=$?\"; cat out",
			0,
			"T\nst=0\nin\n",
			"",
		),
		(
			"a-bg-group-dup",
			true,
			"TIMEFORMAT=T; time { echo in; } 2>&1 >out & wait $!; echo \"st=$?\"; cat out",
			0,
			"T\nst=0\nin\n",
			"",
		),
		(
			"a-bg-group-out-dup",
			false,
			"TIMEFORMAT=T; time { echo in; } > out 2>&1 & wait $!; echo \"st=$?\"; cat out",
			0,
			"st=0\nin\nT\n",
			"",
		),
		(
			"a-bg-group-out-dup",
			true,
			"TIMEFORMAT=T; time { echo in; } > out 2>&1 & wait $!; echo \"st=$?\"; cat out",
			0,
			"st=0\nin\nT\n",
			"",
		),
		(
			"a-bg-group-append",
			false,
			"TIMEFORMAT=T; time { :; } 2>>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-bg-group-append",
			true,
			"TIMEFORMAT=T; time { :; } 2>>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-bg-subshell-null",
			false,
			"TIMEFORMAT=T; time ( : ) 2>/dev/null & wait $!; echo \"st=$?\"",
			0,
			"st=0\n",
			"",
		),
		(
			"a-bg-subshell-null",
			true,
			"TIMEFORMAT=T; time ( : ) 2>/dev/null & wait $!; echo \"st=$?\"",
			0,
			"st=0\n",
			"",
		),
		(
			"a-bg-subshell-file",
			false,
			"TIMEFORMAT=T; time ( : ) 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-bg-subshell-file",
			true,
			"TIMEFORMAT=T; time ( : ) 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-bg-while-file",
			false,
			"TIMEFORMAT=T; time while :; do break; done 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-bg-while-file",
			true,
			"TIMEFORMAT=T; time while :; do break; done 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-bg-if-file",
			false,
			"TIMEFORMAT=T; time if :; then :; fi 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-bg-if-file",
			true,
			"TIMEFORMAT=T; time if :; then :; fi 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-bg-for-file",
			false,
			"TIMEFORMAT=T; time for i in 1; do :; done 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-bg-for-file",
			true,
			"TIMEFORMAT=T; time for i in 1; do :; done 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-bg-case-file",
			false,
			"TIMEFORMAT=T; time case x in x) :;; esac 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-bg-case-file",
			true,
			"TIMEFORMAT=T; time case x in x) :;; esac 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		// `time -p`'s own format, read by name so no digit of a measured
		// duration is asserted.
		(
			"a-bg-group-posix-p-keys",
			false,
			"time -p { :; } 2>err & wait $!; echo \"st=$?\"; while read -r k _; do echo \"k=$k\"; \
			 done < err",
			0,
			"st=0\nk=real\nk=user\nk=sys\n",
			"",
		),
		(
			"a-bg-group-posix-p-keys",
			true,
			"time -p { :; } 2>err & wait $!; echo \"st=$?\"; while read -r k _; do echo \"k=$k\"; \
			 done < err",
			0,
			"st=0\nk=real\nk=user\nk=sys\n",
			"",
		),
		(
			"a-bg-group-bad-format",
			false,
			"TIMEFORMAT=%q; time { :; } 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nbash: line 1: TIMEFORMAT: `q': invalid format character\n",
			"",
		),
		(
			"a-bg-group-bad-format",
			true,
			"TIMEFORMAT=%q; time { :; } 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\n./s.sh: line 1: TIMEFORMAT: `q': invalid format character\n",
			"",
		),
		(
			"a-bg-group-exit-trap",
			false,
			"TIMEFORMAT=T; time { trap \"echo bye >&2\" EXIT; :; } 2>err & wait $!; echo \"st=$?\"; \
			 cat err",
			0,
			"st=0\nT\nbye\n",
			"",
		),
		(
			"a-bg-group-exit-trap",
			true,
			"TIMEFORMAT=T; time { trap \"echo bye >&2\" EXIT; :; } 2>err & wait $!; echo \"st=$?\"; \
			 cat err",
			0,
			"st=0\nT\nbye\n",
			"",
		),
		(
			"a-bg-group-nested-redir",
			false,
			"TIMEFORMAT=T; time { { :; } 2>err; } 2>err2 & wait $!; echo \"st=$?\"; echo \"1:\"; cat \
			 err; echo \"2:\"; cat err2",
			0,
			"st=0\n1:\n2:\nT\n",
			"",
		),
		(
			"a-bg-group-nested-redir",
			true,
			"TIMEFORMAT=T; time { { :; } 2>err; } 2>err2 & wait $!; echo \"st=$?\"; echo \"1:\"; cat \
			 err; echo \"2:\"; cat err2",
			0,
			"st=0\n1:\n2:\nT\n",
			"",
		),
		// The job's fork is read the same way whatever started it: a
		// function, a function in a function, `eval`, a trap action, a
		// subshell, and job control (`set -m`, whose `-c` row bash 5.2.21
		// answers differently).
		(
			"a-func-bg-group-file",
			false,
			"f() { TIMEFORMAT=T; time { :; } 2>err & wait $!; }; f; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-func-bg-group-file",
			true,
			"f() { TIMEFORMAT=T; time { :; } 2>err & wait $!; }; f; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-func-bg-group-null",
			false,
			"f() { TIMEFORMAT=T; time { :; } 2>/dev/null & wait $!; }; f; echo \"st=$?\"",
			0,
			"st=0\n",
			"",
		),
		(
			"a-func-bg-group-null",
			true,
			"f() { TIMEFORMAT=T; time { :; } 2>/dev/null & wait $!; }; f; echo \"st=$?\"",
			0,
			"st=0\n",
			"",
		),
		(
			"a-nested-func-bg-group-file",
			false,
			"g() { TIMEFORMAT=T; time { :; } 2>err & wait $!; }; f() { g; }; f; echo \"st=$?\"; cat \
			 err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-nested-func-bg-group-file",
			true,
			"g() { TIMEFORMAT=T; time { :; } 2>err & wait $!; }; f() { g; }; f; echo \"st=$?\"; cat \
			 err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-eval-bg-group-file",
			false,
			"TIMEFORMAT=T; eval 'time { :; } 2>err &'; wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-eval-bg-group-file",
			true,
			"TIMEFORMAT=T; eval 'time { :; } 2>err &'; wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-trap-bg-group-file",
			false,
			"TIMEFORMAT=T; trap 'time { :; } 2>err &' USR1; kill -USR1 $$; wait; echo \"st=$?\"; cat \
			 err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-trap-bg-group-file",
			true,
			"TIMEFORMAT=T; trap 'time { :; } 2>err &' USR1; kill -USR1 $$; wait; echo \"st=$?\"; cat \
			 err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-subshell-bg-group-file",
			false,
			"( TIMEFORMAT=T; time { :; } 2>err & wait $! ); echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-subshell-bg-group-file",
			true,
			"( TIMEFORMAT=T; time { :; } 2>err & wait $! ); echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
		(
			"a-monitor-bg-group-file",
			true,
			"set -m; TIMEFORMAT=T; time { :; } 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\nT\n",
			"",
		),
	]);
}

/// A timed `&` job whose own redirection fails prints no report: bash's
/// fork leaves there, with 1, or with 0 under `!`.
#[test]
fn a_failed_own_redirection_leaves_a_timed_job_without_a_report() {
	assert_rows(&[
		(
			"b-bg-group-missing",
			false,
			"TIMEFORMAT=T; time { :; } < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"bash: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-bg-group-missing",
			true,
			"TIMEFORMAT=T; time { :; } < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"./s.sh: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-not-bg-group-missing",
			false,
			"TIMEFORMAT=T; time ! { :; } < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=0\n",
			"bash: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-not-bg-group-missing",
			true,
			"TIMEFORMAT=T; time ! { :; } < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=0\n",
			"./s.sh: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-bg-group-missing-null",
			false,
			"TIMEFORMAT=T; time { :; } 2>/dev/null < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"",
		),
		(
			"b-bg-group-missing-null",
			true,
			"TIMEFORMAT=T; time { :; } 2>/dev/null < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"",
		),
		(
			"b-bg-group-missing-file",
			false,
			"TIMEFORMAT=T; time { :; } 2>err < nonexist & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=1\nbash: line 1: nonexist: No such file or directory\n",
			"",
		),
		(
			"b-bg-group-missing-file",
			true,
			"TIMEFORMAT=T; time { :; } 2>err < nonexist & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=1\n./s.sh: line 1: nonexist: No such file or directory\n",
			"",
		),
		(
			"b-bg-group-missing-after",
			false,
			"TIMEFORMAT=T; time { :; } < nonexist & wait $!; echo \"st=$?\"; echo after",
			0,
			"st=1\nafter\n",
			"bash: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-bg-group-missing-after",
			true,
			"TIMEFORMAT=T; time { :; } < nonexist & wait $!; echo \"st=$?\"; echo after",
			0,
			"st=1\nafter\n",
			"./s.sh: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-bg-subshell-missing",
			false,
			"TIMEFORMAT=T; time ( : ) < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"bash: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-bg-subshell-missing",
			true,
			"TIMEFORMAT=T; time ( : ) < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"./s.sh: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-bg-while-missing",
			false,
			"TIMEFORMAT=T; time while :; do break; done < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"bash: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-bg-while-missing",
			true,
			"TIMEFORMAT=T; time while :; do break; done < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"./s.sh: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-bg-group-nodir",
			false,
			"TIMEFORMAT=T; time { :; } > nodir/f & wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"bash: line 1: nodir/f: No such file or directory\n",
		),
		(
			"b-bg-group-nodir",
			true,
			"TIMEFORMAT=T; time { :; } > nodir/f & wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"./s.sh: line 1: nodir/f: No such file or directory\n",
		),
		(
			"b-not-bg-group-nodir",
			false,
			"TIMEFORMAT=T; time ! { :; } > nodir/f & wait $!; echo \"st=$?\"",
			0,
			"st=0\n",
			"bash: line 1: nodir/f: No such file or directory\n",
		),
		(
			"b-not-bg-group-nodir",
			true,
			"TIMEFORMAT=T; time ! { :; } > nodir/f & wait $!; echo \"st=$?\"",
			0,
			"st=0\n",
			"./s.sh: line 1: nodir/f: No such file or directory\n",
		),
		// The same rule where a function, `eval` or job control started the
		// job (rows the two bashes agree on; from `-c` text bash 5.2.21
		// names the shell differently in three of them).
		(
			"b-func-bg-group-missing",
			true,
			"f() { TIMEFORMAT=T; time { :; } < nonexist & wait $!; }; f; echo \"st=$?\"",
			0,
			"st=1\n",
			"./s.sh: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-eval-bg-group-missing",
			false,
			"TIMEFORMAT=T; eval 'time { :; } < nonexist &'; wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"bash: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-eval-bg-group-missing",
			true,
			"TIMEFORMAT=T; eval 'time { :; } < nonexist &'; wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"./s.sh: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-not-func-bg-group-missing",
			true,
			"f() { TIMEFORMAT=T; time ! { :; } < nonexist & wait $!; }; f; echo \"st=$?\"",
			0,
			"st=0\n",
			"./s.sh: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-monitor-bg-group-missing",
			true,
			"set -m; TIMEFORMAT=T; time { :; } < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"./s.sh: line 1: nonexist: No such file or directory\n",
		),
	]);
}

/// What the change leaves as it is: a redirection inside the job, a timed
/// command that is not the whole job (an and-or list, a pipeline, a
/// pipeline stage), a timed simple command, the `( … )` of a subshell, a
/// foreground timed compound, an untimed job whose own redirection fails,
/// `time` with no pipeline, an empty format, and a job whose own
/// redirection leaves stderr alone.
#[test]
fn a_timed_command_that_is_not_the_whole_job_keeps_the_undo() {
	assert_rows(&[
		(
			"a-bg-group-inner-time",
			false,
			"TIMEFORMAT=T; time { time { :; } 2>err; } & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\nT\n",
		),
		(
			"a-bg-group-inner-time",
			true,
			"TIMEFORMAT=T; time { time { :; } 2>err; } & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\nT\n",
		),
		(
			"b-bg-untimed-missing",
			false,
			"{ :; } < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"bash: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-bg-untimed-missing",
			true,
			"{ :; } < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"./s.sh: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-not-bg-untimed-missing",
			false,
			"! { :; } < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=0\n",
			"bash: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-not-bg-untimed-missing",
			true,
			"! { :; } < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=0\n",
			"./s.sh: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-bg-group-missing-empty-format",
			false,
			"TIMEFORMAT=; time { :; } < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"bash: line 1: nonexist: No such file or directory\n",
		),
		(
			"b-bg-group-missing-empty-format",
			true,
			"TIMEFORMAT=; time { :; } < nonexist & wait $!; echo \"st=$?\"",
			0,
			"st=1\n",
			"./s.sh: line 1: nonexist: No such file or directory\n",
		),
		(
			"x-shell-group-ok",
			false,
			"TIMEFORMAT=T; time { echo in; }; echo \"st=$?\"",
			0,
			"in\nst=0\n",
			"T\n",
		),
		(
			"x-shell-group-ok",
			true,
			"TIMEFORMAT=T; time { echo in; }; echo \"st=$?\"",
			0,
			"in\nst=0\n",
			"T\n",
		),
		(
			"x-bg-group-ok",
			false,
			"TIMEFORMAT=T; time { echo in; } & wait $!; echo \"st=$?\"",
			0,
			"in\nst=0\n",
			"T\n",
		),
		(
			"x-bg-group-ok",
			true,
			"TIMEFORMAT=T; time { echo in; } & wait $!; echo \"st=$?\"",
			0,
			"in\nst=0\n",
			"T\n",
		),
		(
			"x-bg-simple-null",
			false,
			"TIMEFORMAT=T; time : 2>/dev/null & wait $!; echo \"st=$?\"",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-bg-simple-null",
			true,
			"TIMEFORMAT=T; time : 2>/dev/null & wait $!; echo \"st=$?\"",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-bg-simple-file",
			false,
			"TIMEFORMAT=T; time : 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-bg-simple-file",
			true,
			"TIMEFORMAT=T; time : 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-bg-external-file",
			false,
			"TIMEFORMAT=T; time /bin/true 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-bg-external-file",
			true,
			"TIMEFORMAT=T; time /bin/true 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-bg-timed-pipeline-redir",
			false,
			"TIMEFORMAT=T; time { :; } 2>err | cat & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-bg-timed-pipeline-redir",
			true,
			"TIMEFORMAT=T; time { :; } 2>err | cat & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-pipe-timed-group-ok",
			false,
			"TIMEFORMAT=T; { time { :; } 2>err; } | cat; echo \"ps=${PIPESTATUS[*]}\"; cat err",
			0,
			"ps=0 0\n",
			"T\n",
		),
		(
			"x-pipe-timed-group-ok",
			true,
			"TIMEFORMAT=T; { time { :; } 2>err; } | cat; echo \"ps=${PIPESTATUS[*]}\"; cat err",
			0,
			"ps=0 0\n",
			"T\n",
		),
		("x-shell-time-null", false, "TIMEFORMAT=T; time; echo \"st=$?\"", 0, "st=0\n", "T\n"),
		("x-shell-time-null", true, "TIMEFORMAT=T; time; echo \"st=$?\"", 0, "st=0\n", "T\n"),
		("x-shell-time-not-null", false, "TIMEFORMAT=T; time !; echo \"st=$?\"", 0, "st=1\n", "T\n"),
		("x-shell-time-not-null", true, "TIMEFORMAT=T; time !; echo \"st=$?\"", 0, "st=1\n", "T\n"),
		(
			"x-bg-group-empty-format",
			false,
			"TIMEFORMAT=; time { :; } 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"",
		),
		(
			"x-bg-group-empty-format",
			true,
			"TIMEFORMAT=; time { :; } 2>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"",
		),
		(
			"x-shell-group-redir-ok",
			false,
			"TIMEFORMAT=T; time { :; } 2>err; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-shell-group-redir-ok",
			true,
			"TIMEFORMAT=T; time { :; } 2>err; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-bg-group-and-list-ok",
			false,
			"TIMEFORMAT=T; time { :; } 2>err && : & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-bg-group-and-list-ok",
			true,
			"TIMEFORMAT=T; time { :; } 2>err && : & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-subshell-group-null",
			false,
			"( TIMEFORMAT=T; time { :; } 2>/dev/null ); echo \"st=$?\"",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-subshell-group-null",
			true,
			"( TIMEFORMAT=T; time { :; } 2>/dev/null ); echo \"st=$?\"",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-fg-group-two-redirs",
			false,
			"TIMEFORMAT=T; time { :; } 2>err >out; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-fg-group-two-redirs",
			true,
			"TIMEFORMAT=T; time { :; } 2>err >out; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-bg-group-fd3",
			false,
			"TIMEFORMAT=T; time { :; } 3>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-bg-group-fd3",
			true,
			"TIMEFORMAT=T; time { :; } 3>err & wait $!; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-bg-group-stdin",
			false,
			"TIMEFORMAT=T; time { /bin/cat; } < in & wait $!; echo \"st=$?\"",
			0,
			"hello\nst=0\n",
			"T\n",
		),
		(
			"x-bg-group-stdin",
			true,
			"TIMEFORMAT=T; time { /bin/cat; } < in & wait $!; echo \"st=$?\"",
			0,
			"hello\nst=0\n",
			"T\n",
		),
		(
			"x-shell-group-exit-trap",
			false,
			"TIMEFORMAT=T; trap \"echo bye >&2\" EXIT; time { :; } 2>err; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\nbye\n",
		),
		(
			"x-shell-group-exit-trap",
			true,
			"TIMEFORMAT=T; trap \"echo bye >&2\" EXIT; time { :; } 2>err; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\nbye\n",
		),
		// Started from a function, from `eval` and in a job of its own: a
		// timed command that is not the whole job keeps the undo there too.
		(
			"x-func-shell-group-file",
			false,
			"f() { TIMEFORMAT=T; time { :; } 2>err; }; f; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-func-shell-group-file",
			true,
			"f() { TIMEFORMAT=T; time { :; } 2>err; }; f; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-func-bg-group-and-list",
			false,
			"f() { TIMEFORMAT=T; time { :; } 2>err && : & wait $!; }; f; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-func-bg-group-and-list",
			true,
			"f() { TIMEFORMAT=T; time { :; } 2>err && : & wait $!; }; f; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-func-bg-simple-file",
			false,
			"f() { TIMEFORMAT=T; time : 2>err & wait $!; }; f; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-func-bg-simple-file",
			true,
			"f() { TIMEFORMAT=T; time : 2>err & wait $!; }; f; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-eval-shell-group-file",
			false,
			"TIMEFORMAT=T; eval 'time { :; } 2>err'; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
		(
			"x-eval-shell-group-file",
			true,
			"TIMEFORMAT=T; eval 'time { :; } 2>err'; echo \"st=$?\"; cat err",
			0,
			"st=0\n",
			"T\n",
		),
	]);
}
