//! A shell that keeps its job list frozen (bash's `jobs_list_frozen`: the
//! last stage of a `lastpipe` pipeline and a trap run with the list frozen
//! set 1, a function substitution `${ …; }` sets -1) passes that freeze to
//! every fork it starts: a command or process substitution, a `( … )`, a
//! `{ …; } &` group, a pipeline's stage. Nothing in the fork ends it, so for
//! the fork's whole life bash deletes no job: not after `wait`, `wait PID`,
//! `wait %N`, `disown`, `kill` and `wait`, a `CHLD` trap or `set -m`. Under 1
//! `wait -n` returns 127 at once; under -1 it takes a finished job and marks
//! it, and a later `wait -n` can take the same one again. The innermost
//! freeze counts: a function substitution inside a `lastpipe` stage, or one
//! started there, only marks. While no job may be deleted each foreground
//! command bash forks (an external, a `( … )`, a pipeline, and the forked
//! stages of a `lastpipe` pipeline, made a job once the list is frozen)
//! stays a job: `%N` names it (`jobs`, `wait` with its status, `kill`,
//! `disown`), `jobs` lists it only once a signal bash reports killed it,
//! `wait` and `wait -n` pass it by, the next job is numbered after it, and a
//! command substitution copies it with the list. A function substitution
//! marks the finished jobs it reports, and the first clean-up outside it
//! deletes them; a foreground job a signal killed in a `lastpipe` stage is
//! reported at the next report point outside, and a `lastpipe` pipeline's
//! job ends with the shell's own stage, named by the last command it ran.
//! Each row's output is bash 5.3.20's for `bash -c` and from a script file;
//! a finished job's end is waited for with `kill -0` or `wait`, and a job
//! listed as running is a `sleep 30` the row then ends with `kill` (a
//! SIGTERM bash does not report), so the rows need no timing. bash 5.2.21
//! has no function substitution, and its `lastpipe` substitution lists the
//! pipeline's job.
#![cfg(target_os = "linux")]

mod obash_support;

/// A row whose standard output bash 5.3.20 gives through `-c` (`out`) and
/// from a script file (`file`); its standard error is `err` both ways, with
/// each line's shell-name prefix `…: line 1: ` and each `(PID)` taken out;
/// its status is 0.
struct Both {
	name:   &'static str,
	script: &'static str,
	out:    &'static str,
	file:   &'static str,
	err:    &'static str,
}

/// How a row's script reaches obash: as `obash -c script`, or as a file
/// (`row.sh` in the row's directory) that `obash row.sh` reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Via {
	Command,
	File,
}

/// `text` with each line's shell-name prefix (`…: line 1: `) dropped and
/// every parenthesised number read as `(PID)`.
fn normalised(text: &str) -> String {
	let mut out = String::new();
	for line in text.lines() {
		let line = line.split_once(": line 1: ").map_or(line, |(_, rest)| rest);
		let mut rest = line;
		while let Some(open) = rest.find('(') {
			out.push_str(&rest[..=open]);
			rest = &rest[open + 1..];
			let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
			if digits > 0 && rest[digits..].starts_with(')') {
				out.push_str("PID");
				rest = &rest[digits..];
			}
		}
		out.push_str(rest);
		out.push('\n');
	}
	out
}

/// `script` through obash as `via` says, in a directory of its own: its
/// status, its output and its error text ([`normalised`]).
fn run(script: &str, via: Via) -> (Option<i32>, String, String) {
	let dir = tempfile::tempdir().unwrap();
	let mut cmd = obash_support::obash();
	match via {
		Via::Command => cmd.args(["-c", script]),
		Via::File => {
			std::fs::write(dir.path().join("row.sh"), script).unwrap();
			cmd.arg("row.sh")
		},
	};
	let result = obash_support::output(cmd.current_dir(dir.path()));
	let out = String::from_utf8_lossy(&result.stdout).into_owned();
	(result.status.code(), out, normalised(&String::from_utf8_lossy(&result.stderr)))
}

/// Runs each row through `obash -c` and from a script file, and fails with
/// every run whose status (0), output or error text differs from bash's,
/// each as a line `NAME: `, or `NAME (file): `, and the script. A run that
/// does not end within `obash_support`'s bound (its panic) is a difference
/// of its row too, and the rows before and after it keep theirs; after
/// [`HUNG`] such runs the test runs no more of them (each costs the bound)
/// and names each it did not run.
fn assert_both(rows: &[Both]) {
	let mut found = Vec::new();
	let mut hung = 0;
	for via in [Via::Command, Via::File] {
		for row in rows {
			let want = if via == Via::File { row.file } else { row.out };
			let how = if via == Via::File { " (file)" } else { "" };
			if hung >= HUNG {
				found.push(format!(
					"{}{how}: `{}`\n  not run: {HUNG} runs did not end",
					row.name, row.script
				));
				continue;
			}
			let (status, got, got_err) = match std::panic::catch_unwind(|| run(row.script, via)) {
				Ok(ran) => ran,
				Err(panic) => {
					hung += 1;
					let why = panic
						.downcast_ref::<String>()
						.map(String::as_str)
						.or_else(|| panic.downcast_ref::<&str>().copied())
						.unwrap_or("panicked");
					found.push(format!(
						"{}{how}: `{}`\n  bash: Some(0) {want:?} {:?}\n  omp:  {why}",
						row.name, row.script, row.err
					));
					continue;
				},
			};
			if (status, got.as_str(), got_err.as_str()) != (Some(0), want, row.err) {
				found.push(format!(
					"{}{how}: `{}`\n  bash: Some(0) {want:?} {:?}\n  omp:  {status:?} {got:?} \
					 {got_err:?}",
					row.name, row.script, row.err
				));
			}
		}
	}
	assert!(
		found.is_empty(),
		"{} of {} runs differ from bash:\n{}",
		found.len(),
		2 * rows.len(),
		found.join("\n")
	);
}

/// The runs that may hit `obash_support`'s bound before [`assert_both`]
/// stops running rows: a test that hangs on every row would otherwise take
/// the bound once per row.
const HUNG: usize = 2;

/// A command substitution started in a function substitution keeps every
/// job it starts: a finished one stays listed after `wait`, `wait PID`,
/// `wait %1`, a second `wait PID`, `kill %1` and `wait`, a `CHLD` trap,
/// `set -m` or `set +m`, and a disowned one stays as it runs. `wait -n`
/// works there and marks the job it takes: three `wait -n` for two jobs
/// all return 0. A plain `wait` marks the finished jobs it forgets there,
/// in the function substitution itself too, but not `$!`'s if it ended
/// before the `wait`: `jobs -n` lists that one alone. A substitution nested
/// in it, a process substitution, a `${| …; }`, a backquote and a
/// posix-mode shell keep them too.
#[test]
fn a_substitution_of_a_function_substitution_keeps_every_job() {
	assert_both(&[
		Both {
			name:   "wait-then-jobs",
			script: r#"y=${ x=$({ /bin/true & wait; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[1]+  Done                       /bin/true\ne]\nend\n",
			file:   "[[1]+  Done                       /bin/true\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-n",
			script: r#"y=${ x=$({ sleep 0.2 & wait -n; echo "rc=$?"; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[rc=0\n[1]+  Done                       sleep 0.2\ne]\nend\n",
			file:   "[rc=0\n[1]+  Done                       sleep 0.2\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "disown",
			script: r#"y=${ x=$({ sleep 30 & disown; jobs; kill $!; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &\ne]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-pid",
			script: r#"y=${ x=$({ sleep 0.1 & wait $!; echo "w=$?"; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[w=0\n[1]+  Done                       sleep 0.1\ne]\nend\n",
			file:   "[w=0\n[1]+  Done                       sleep 0.1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "foreground-numbers",
			script: r#"y=${ x=$({ /bin/true; /bin/true; sleep 30 & jobs; kill $!; wait; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[3]+  Running                    sleep 30 &\ne]\nend\n",
			file:   "[[3]+  Running                    sleep 30 &\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "chld-trap",
			script: r#"y=${ x=$({ trap 'echo chld' CHLD; /bin/true & wait; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[chld\n[1]+  Done                       /bin/true\ne]\nend\n",
			file:   "[chld\n[1]+  Done                       /bin/true\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "set-m",
			script: r#"y=${ x=$({ set -m; /bin/true & wait; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[1]+  Done                       /bin/true\ne]\nend\n",
			file:   "[[1]+  Done                       /bin/true\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "set-plus-m",
			script: r#"y=${ x=$({ set +m; /bin/true & wait; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[1]+  Done                       /bin/true\ne]\nend\n",
			file:   "[[1]+  Done                       /bin/true\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "kill-jobspec",
			script: r#"y=${ x=$({ sleep 30 & kill %1; wait; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[1]+  Terminated                 sleep 30\ne]\nend\n",
			file:   "[[1]+  Terminated                 sleep 30\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-jobspec",
			script: r#"y=${ x=$({ sleep 0.1 & wait %1; echo "w=$?"; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[w=0\n[1]+  Done                       sleep 0.1\ne]\nend\n",
			file:   "[w=0\n[1]+  Done                       sleep 0.1\ne]\nend\n",
			err:    "",
		},
		// The second job blocks on a fifo the shell opens only after the first
		// `wait -n`, so it still runs then (with both ended first, bash's third
		// `wait -n` is 127: the next row).
		Both {
			name:   "wait-n-three-times",
			script: r#"F=$(mktemp -u); mkfifo "$F"; y=${ x=$({ sleep 0.1 & { read -r _ < "$F"; } & wait -n; echo "rc=$?"; echo > "$F"; wait -n; echo "rc=$?"; wait -n; echo "rc=$?"; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; rm -f "$F"; echo end"#,
			out:    "[rc=0\nrc=0\nrc=0\n[1]-  Done                       sleep 0.1\n[2]+  Done                       { read -r _ < \"$F\"; }\ne]\nend\n",
			file:   "[rc=0\nrc=0\nrc=0\n[1]-  Done                       sleep 0.1\n[2]+  Done                       { read -r _ < \"$F\"; }\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-n-three-times-both-ended-first",
			script: r#"y=${ x=$({ sleep 0.1 & p1=$!; sleep 0.2 & p2=$!; while kill -0 $p1 2>/dev/null || kill -0 $p2 2>/dev/null; do :; done; wait -n; echo "rc=$?"; wait -n; echo "rc=$?"; wait -n; echo "rc=$?"; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[rc=0\nrc=0\nrc=127\n[1]-  Done                       sleep 0.1\n[2]+  Done                       sleep 0.2\ne]\nend\n",
			file:   "[rc=0\nrc=0\nrc=127\n[1]-  Done                       sleep 0.1\n[2]+  Done                       sleep 0.2\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-pid-twice",
			script: r#"y=${ x=$({ /bin/sh -c 'exit 3' & p=$!; wait $p; echo "w=$?"; wait $p; echo "w2=$?"; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[w=3\nw2=3\n[1]+  Exit 3                     /bin/sh -c 'exit 3'\ne]\nend\n",
			file:   "[w=3\nw2=3\n[1]+  Exit 3                     /bin/sh -c 'exit 3'\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "jobs-n",
			script: r#"y=${ x=$({ /bin/true & p=$!; while kill -0 $p 2>/dev/null; do :; done; /bin/sh -c 'exit 3' & q=$!; while kill -0 $q 2>/dev/null; do :; done; wait; jobs -n; echo n; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[2]+  Exit 3                     /bin/sh -c 'exit 3'\nn\n[1]   Done                       /bin/true\n[2]+  Exit 3                     /bin/sh -c 'exit 3'\ne]\nend\n",
			file:   "[[2]+  Exit 3                     /bin/sh -c 'exit 3'\nn\n[1]   Done                       /bin/true\n[2]+  Exit 3                     /bin/sh -c 'exit 3'\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "jobs-n-in-the-function-substitution",
			script: r#"y=${ /bin/true & p=$!; while kill -0 $p 2>/dev/null; do :; done; /bin/sh -c 'exit 3' & q=$!; while kill -0 $q 2>/dev/null; do :; done; wait; jobs -n; echo n; jobs; }; echo "$y"; echo end"#,
			out:    "[2]+  Exit 3                     /bin/sh -c 'exit 3'\nn\n[1]   Done                       /bin/true\n[2]+  Exit 3                     /bin/sh -c 'exit 3'\nend\n",
			file:   "[2]+  Exit 3                     /bin/sh -c 'exit 3'\nn\n[1]   Done                       /bin/true\n[2]+  Exit 3                     /bin/sh -c 'exit 3'\nend\n",
			err:    "",
		},
		Both {
			name:   "nested-substitution",
			script: r#"y=${ x=$({ /bin/true & wait; z=$(jobs); echo "<$z>"; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[<[1]+  Done                       /bin/true>\n[1]+  Done                       /bin/true\ne]\nend\n",
			file:   "[<[1]+  Done                       /bin/true>\n[1]+  Done                       /bin/true\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "kill-pid-wait",
			script: r#"y=${ x=$({ sleep 30 & kill $!; wait $!; echo "w=$?"; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[w=143\n[1]+  Terminated                 sleep 30\ne]\nend\n",
			file:   "[w=143\n[1]+  Terminated                 sleep 30\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "procsub",
			script: r#"y=${ cat <({ /bin/true & wait; jobs; echo e; } 2>&1); }; echo "$y"; echo end"#,
			out:    "[1]+  Done                       /bin/true\ne\nend\n",
			file:   "[1]+  Done                       /bin/true\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "valuesub",
			script: r#"y=${| x=$({ sleep 0.1 & wait -n; echo "rc=$?"; jobs; echo e; } 2>&1); REPLY="[$x]"; }; echo "$y"; echo end"#,
			out:    "[rc=0\n[1]+  Done                       sleep 0.1\ne]\nend\n",
			file:   "[rc=0\n[1]+  Done                       sleep 0.1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "backquote",
			script: r#"y=${ x=`{ /bin/true & wait; jobs; echo e; } 2>&1`; echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[1]+  Done                       /bin/true\ne]\nend\n",
			file:   "[[1]+  Done                       /bin/true\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "posix",
			script: r#"set -o posix; y=${ x=$({ /bin/true & wait; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[1]+  Done                       /bin/true\ne]\nend\n",
			file:   "[[1]+  Done                       /bin/true\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "nested-in-a-substitution",
			script: r#"y=${ x=$(z=$({ /bin/true & wait; jobs; echo e; } 2>&1); echo "<$z>"); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[<[1]+  Done                       /bin/true\ne>]\nend\n",
			file:   "[<[1]+  Done                       /bin/true\ne>]\nend\n",
			err:    "",
		},
	]);
}

/// The same in the last stage of a `lastpipe` pipeline, where the freeze
/// also makes `wait -n` return 127 at once, with the job still running:
/// the substitution counts the jobs it keeps.
#[test]
fn a_substitution_of_a_lastpipe_stage_keeps_every_job() {
	assert_both(&[
		Both {
			name:   "wait",
			script: r#"shopt -s lastpipe; echo | { x=$({ /bin/true & wait; jobs -p | wc -l; echo e; } 2>&1); echo "[$x]"; }; echo end"#,
			out:    "[1\ne]\nend\n",
			file:   "[1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-n",
			script: r#"shopt -s lastpipe; echo | { x=$({ sleep 0.1 & wait -n; echo "rc=$?"; jobs -p | wc -l; wait; echo e; } 2>&1); echo "[$x]"; }; echo end"#,
			out:    "[rc=127\n1\ne]\nend\n",
			file:   "[rc=127\n1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "disown",
			script: r#"shopt -s lastpipe; echo | { x=$({ sleep 0.3 & disown; jobs -p | wc -l; echo e; } 2>&1); echo "[$x]"; }; echo end"#,
			out:    "[1\ne]\nend\n",
			file:   "[1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "kill-pid-wait",
			script: r#"shopt -s lastpipe; echo | { x=$({ sleep 30 & kill $!; wait $!; echo "w=$?"; jobs -p | wc -l; echo e; } 2>&1); echo "[$x]"; }; echo end"#,
			out:    "[w=143\n1\ne]\nend\n",
			file:   "[w=143\n1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-n-twice",
			script: r#"shopt -s lastpipe; echo | { x=$({ sleep 0.1 & sleep 0.2 & wait -n; echo "rc=$?"; wait -n; echo "rc=$?"; jobs -p | wc -l; wait; echo e; } 2>&1); echo "[$x]"; }; echo end"#,
			out:    "[rc=127\nrc=127\n2\ne]\nend\n",
			file:   "[rc=127\nrc=127\n2\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "chld-trap",
			script: r#"shopt -s lastpipe; echo | { x=$({ trap 'echo chld' CHLD; /bin/true & wait; jobs -p | wc -l; echo e; } 2>&1); echo "[$x]"; }; echo end"#,
			out:    "[chld\n1\nchld\nchld\ne]\nend\n",
			file:   "[chld\n1\nchld\nchld\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "process-substitution",
			script: r"shopt -s lastpipe; echo | { cat <({ /bin/true & wait; jobs -p | wc -l; echo e; } 2>&1); }; echo end",
			out:    "1\ne\nend\n",
			file:   "1\ne\nend\n",
			err:    "",
		},
	]);
}

/// A `( … )`, a `{ …; } &` group and a pipeline's stage of a frozen shell
/// start with no jobs of their own (bash `without_job_control`) but keep
/// the freeze: a job each starts stays listed after `wait`, `kill %1` and
/// `wait`, and `wait %1`; `wait -n` returns 127 at once in a `lastpipe`
/// stage's fork and takes the job in a function substitution's.
#[test]
fn every_fork_of_a_frozen_shell_keeps_every_job() {
	assert_both(&[
		Both {
			name:   "subshell-wait-lastpipe",
			script: r"shopt -s lastpipe; echo | { ( /bin/true & wait; jobs; echo e ) 2>&1; }; echo end",
			out:    "[1]+  Done                       /bin/true\ne\nend\n",
			file:   "[1]+  Done                       /bin/true\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-wait",
			script: r#"y=${ ( /bin/true & wait; jobs; echo e ) 2>&1; }; echo "$y"; echo end"#,
			out:    "[1]+  Done                       /bin/true\ne\nend\n",
			file:   "[1]+  Done                       /bin/true\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-wait-n-lastpipe",
			script: r#"shopt -s lastpipe; echo | { ( sleep 30 & wait -n; echo "rc=$?"; jobs; kill $!; wait; echo e ) 2>&1; }; echo end"#,
			out:    "rc=127\n[1]+  Running                    sleep 30 &\ne\nend\n",
			file:   "rc=127\n[1]+  Running                    sleep 30 &\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-wait-n",
			script: r#"y=${ ( sleep 0.1 & wait -n; echo "rc=$?"; jobs; echo e ) 2>&1; }; echo "$y"; echo end"#,
			out:    "rc=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "rc=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-kill-lastpipe",
			script: r"shopt -s lastpipe; echo | { ( sleep 30 & kill %1; wait; jobs; echo e ) 2>&1; }; echo end",
			out:    "[1]+  Terminated                 sleep 30\ne\nend\n",
			file:   "[1]+  Terminated                 sleep 30\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-kill",
			script: r#"y=${ ( sleep 30 & kill %1; wait; jobs; echo e ) 2>&1; }; echo "$y"; echo end"#,
			out:    "[1]+  Terminated                 sleep 30\ne\nend\n",
			file:   "[1]+  Terminated                 sleep 30\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-wait-jobspec-lastpipe",
			script: r#"shopt -s lastpipe; echo | { ( sleep 0.1 & wait %1; echo "w=$?"; jobs; echo e ) 2>&1; }; echo end"#,
			out:    "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-wait-jobspec",
			script: r#"y=${ ( sleep 0.1 & wait %1; echo "w=$?"; jobs; echo e ) 2>&1; }; echo "$y"; echo end"#,
			out:    "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "group-wait-lastpipe",
			script: r"shopt -s lastpipe; echo | { { /bin/true & wait; jobs; echo e; } & wait 2>&1; }; echo end",
			out:    "[1]+  Done                       /bin/true\ne\nend\n",
			file:   "[1]+  Done                       /bin/true\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "group-wait",
			script: r#"y=${ { /bin/true & wait; jobs; echo e; } & wait 2>&1; }; echo "$y"; echo end"#,
			out:    "[1]+  Done                       /bin/true\ne\nend\n",
			file:   "[1]+  Done                       /bin/true\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "group-wait-n-lastpipe",
			script: r#"shopt -s lastpipe; echo | { { sleep 30 & wait -n; echo "rc=$?"; jobs; kill $!; wait; echo e; } & wait 2>&1; }; echo end"#,
			out:    "rc=127\n[1]+  Running                    sleep 30 &\ne\nend\n",
			file:   "rc=127\n[1]+  Running                    sleep 30 &\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "group-wait-n",
			script: r#"y=${ { sleep 0.1 & wait -n; echo "rc=$?"; jobs; echo e; } & wait 2>&1; }; echo "$y"; echo end"#,
			out:    "rc=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "rc=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "group-kill-lastpipe",
			script: r"shopt -s lastpipe; echo | { { sleep 30 & kill %1; wait; jobs; echo e; } & wait 2>&1; }; echo end",
			out:    "[1]+  Terminated                 sleep 30\ne\nend\n",
			file:   "[1]+  Terminated                 sleep 30\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "group-kill",
			script: r#"y=${ { sleep 30 & kill %1; wait; jobs; echo e; } & wait 2>&1; }; echo "$y"; echo end"#,
			out:    "[1]+  Terminated                 sleep 30\ne\nend\n",
			file:   "[1]+  Terminated                 sleep 30\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "group-wait-jobspec-lastpipe",
			script: r#"shopt -s lastpipe; echo | { { sleep 0.1 & wait %1; echo "w=$?"; jobs; echo e; } & wait 2>&1; }; echo end"#,
			out:    "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "group-wait-jobspec",
			script: r#"y=${ { sleep 0.1 & wait %1; echo "w=$?"; jobs; echo e; } & wait 2>&1; }; echo "$y"; echo end"#,
			out:    "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "stage-wait-lastpipe",
			script: r"shopt -s lastpipe; echo | { { /bin/true & wait; jobs; echo e; } | cat 2>&1; }; echo end",
			out:    "[1]+  Done                       /bin/true\ne\nend\n",
			file:   "[1]+  Done                       /bin/true\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "stage-wait",
			script: r#"y=${ { /bin/true & wait; jobs; echo e; } | cat 2>&1; }; echo "$y"; echo end"#,
			out:    "[1]+  Done                       /bin/true\ne\nend\n",
			file:   "[1]+  Done                       /bin/true\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "stage-wait-n-lastpipe",
			script: r#"shopt -s lastpipe; echo | { { sleep 30 & wait -n; echo "rc=$?"; jobs; kill $!; wait; echo e; } | cat 2>&1; }; echo end"#,
			out:    "rc=127\n[1]+  Running                    sleep 30 &\ne\nend\n",
			file:   "rc=127\n[1]+  Running                    sleep 30 &\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "stage-wait-n",
			script: r#"y=${ { sleep 0.1 & wait -n; echo "rc=$?"; jobs; echo e; } | cat 2>&1; }; echo "$y"; echo end"#,
			out:    "rc=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "rc=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "stage-kill-lastpipe",
			script: r"shopt -s lastpipe; echo | { { sleep 30 & kill %1; wait; jobs; echo e; } | cat 2>&1; }; echo end",
			out:    "[1]+  Terminated                 sleep 30\ne\nend\n",
			file:   "[1]+  Terminated                 sleep 30\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "stage-kill",
			script: r#"y=${ { sleep 30 & kill %1; wait; jobs; echo e; } | cat 2>&1; }; echo "$y"; echo end"#,
			out:    "[1]+  Terminated                 sleep 30\ne\nend\n",
			file:   "[1]+  Terminated                 sleep 30\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "stage-wait-jobspec-lastpipe",
			script: r#"shopt -s lastpipe; echo | { { sleep 0.1 & wait %1; echo "w=$?"; jobs; echo e; } | cat 2>&1; }; echo end"#,
			out:    "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "stage-wait-jobspec",
			script: r#"y=${ { sleep 0.1 & wait %1; echo "w=$?"; jobs; echo e; } | cat 2>&1; }; echo "$y"; echo end"#,
			out:    "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
	]);
}

/// The innermost freeze counts: a function substitution inside a
/// `lastpipe` stage only marks (`wait -n` takes the job, in the shell and
/// in its command substitution), and a `lastpipe` stage inside a function
/// substitution freezes (`wait -n` returns 127 at once).
#[test]
fn the_innermost_freeze_counts() {
	assert_both(&[
		Both {
			name:   "a-function-substitution-in-a-lastpipe-stage-marks",
			script: r#"shopt -s lastpipe; echo | { y=${ x=$({ sleep 0.1 & wait -n; echo "rc=$?"; jobs -p | wc -l; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; }; echo end"#,
			out:    "[rc=0\n1\ne]\nend\n",
			file:   "[rc=0\n1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "a-lastpipe-stage-in-a-function-substitution-freezes",
			script: r#"shopt -s lastpipe; y=${ echo | { x=$({ sleep 0.1 & wait -n; echo "rc=$?"; jobs -p | wc -l; wait; echo e; } 2>&1); echo "[$x]"; }; }; echo "$y"; echo end"#,
			out:    "[rc=127\n1\ne]\nend\n",
			file:   "[rc=127\n1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "the-shell-marks-in-a-function-substitution-in-a-lastpipe-stage",
			script: r#"shopt -s lastpipe; echo | { y=${ sleep 0.1 & wait -n; echo "rc=$?"; }; echo "$y"; }; echo end"#,
			out:    "rc=0\nend\n",
			file:   "rc=0\nend\n",
			err:    "",
		},
		Both {
			name:   "the-shell-freezes-in-a-lastpipe-stage-in-a-function-substitution",
			script: r#"shopt -s lastpipe; y=${ echo | { sleep 0.1 & wait -n; echo "rc=$?"; wait; }; }; echo "$y"; echo end"#,
			out:    "rc=127\nend\n",
			file:   "rc=127\nend\n",
			err:    "",
		},
	]);
}

/// While no job may be deleted, each foreground command bash forks (an
/// external, a `( … )`, a pipeline) is a job, and the next job takes the
/// number after it; a builtin, a command substitution and a background job
/// add none. A command substitution copies the foreground jobs with the
/// list; a `( … )` starts with none. Numbers freed before the freeze stay
/// free, and a loop's commands keep theirs. After the function substitution
/// the next fork deletes them, and numbers start at 1 again.
#[test]
fn a_foreground_command_is_a_job_while_no_job_is_deleted() {
	assert_both(&[
		Both {
			name:   "externals",
			script: r#"y=${ /bin/true; /bin/true; sleep 30 & jobs; kill $!; wait; }; echo "$y"; echo end"#,
			out:    "[3]+  Running                    sleep 30 &\nend\n",
			file:   "[3]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell",
			script: r#"y=${ ( : ); sleep 30 & jobs; kill $!; wait; }; echo "$y"; echo end"#,
			out:    "[2]+  Running                    sleep 30 &\nend\n",
			file:   "[2]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "pipeline",
			script: r#"y=${ : | :; sleep 30 & jobs; kill $!; wait; }; echo "$y"; echo end"#,
			out:    "[2]+  Running                    sleep 30 &\nend\n",
			file:   "[2]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "builtin-and-substitution-hold-none",
			script: r#"y=${ :; z=$(:); sleep 30 & jobs; kill $!; wait; }; echo "$y"; echo end"#,
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "background-jobs",
			script: r#"y=${ sleep 30 & sleep 30 & jobs; kill %1 %2; wait; }; echo "$y"; echo end"#,
			out:    "[1]-  Running                    sleep 30 &\n[2]+  Running                    \
			         sleep 30 &\nend\n",
			file:   "[1]-  Running                    sleep 30 &\n[2]+  Running                    \
			         sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "copied-by-a-substitution",
			script: r#"y=${ /bin/true; x=$(sleep 30 & jobs; kill $!; wait); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[2]+  Running                    sleep 30 &]\nend\n",
			file:   "[[2]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "not-by-a-subshell",
			script: r#"y=${ /bin/true; ( sleep 30 & jobs; kill $!; wait ); }; echo "$y"; echo end"#,
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "gone-after",
			script: r"y=${ /bin/true; }; sleep 30 & jobs; kill $!; wait; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "after-a-background-job",
			script: r#"sleep 30 & y=${ /bin/true; jobs %2; echo "rc=$?"; }; echo "$y"; kill %1; echo end"#,
			out:    "rc=0\nend\n",
			file:   "rc=0\nend\n",
			err:    "",
		},
		Both {
			name:   "numbers-freed-before-stay-free",
			script: r#"sleep 30 & sleep 30 & kill %1; wait %1; y=${ /bin/true; jobs %1; echo "r1=$?"; jobs %3; echo "r3=$?"; }; echo "$y"; kill %2; echo end"#,
			out:    "r1=1\nr3=0\nend\n",
			file:   "r1=1\nr3=0\nend\n",
			err:    "jobs: %1: no such job\n",
		},
		Both {
			name:   "a-loop-keeps-them",
			script: r#"y=${ for i in 1 2; do /bin/true; done; jobs %2; echo "rc=$?"; jobs %3 2>/dev/null; echo "r=$?"; }; echo "$y"; echo end"#,
			out:    "rc=0\nr=1\nend\n",
			file:   "rc=0\nr=1\nend\n",
			err:    "",
		},
		Both {
			name:   "a-killed-one-gone-after",
			script: r"y=${ /bin/sh -c 'kill -TERM $$'; }; sleep 30 & jobs; kill $!; wait; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "Terminated                 /bin/sh -c 'kill -TERM $$'\n",
		},
	]);
}

/// A foreground job made while no job may be deleted is one `%N` names, as
/// bash 5.3.20 answers for it: `jobs %N` and `disown %N` succeed (it stays),
/// `kill %N` and `kill -0 %N` succeed on the finished job, and `wait %N`
/// returns its status (a `( … )`'s, a pipeline's, under `pipefail` too) and
/// marks it; a command name names it too, and a command substitution and a
/// `jobs` pipeline stage copy it. `wait` and `wait -n` pass it by, the
/// current job stays the background one, `fg` has no job control there, and
/// `disown -a` deletes every job even then (bash `delete_all_jobs`).
#[test]
fn a_job_spec_names_a_frozen_foreground_job() {
	assert_both(&[
		Both {
			name:   "jobs-n",
			script: r#"y=${ /bin/true; jobs %1; echo "st=$?"; }; echo "$y""#,
			out:    "st=0\n",
			file:   "st=0\n",
			err:    "",
		},
		Both {
			name:   "wait-n-status",
			script: r#"y=${ /bin/false; wait %1; echo "w=$?"; }; echo "$y""#,
			out:    "w=1\n",
			file:   "w=1\n",
			err:    "",
		},
		Both {
			name:   "disown-then-kill-0",
			script: r#"y=${ /bin/true; disown %1; echo "d=$?"; kill -0 %1; echo "k=$?"; }; echo "$y""#,
			out:    "d=0\nk=0\n",
			file:   "d=0\nk=0\n",
			err:    "",
		},
		Both {
			name:   "kill",
			script: r#"y=${ /bin/true; kill %1; echo "k=$?"; }; echo "$y""#,
			out:    "k=0\n",
			file:   "k=0\n",
			err:    "",
		},
		Both {
			name:   "beside-a-background-job",
			script: r#"y=${ /bin/true; sleep 30 & kill %2; wait %2; echo "w=$?"; wait %1; echo "w1=$?"; }; echo "$y""#,
			out:    "w=143\nw1=0\n",
			file:   "w=143\nw1=0\n",
			err:    "",
		},
		Both {
			name:   "copied-by-a-substitution",
			script: r#"y=${ ( : ); x=$(jobs %1; echo "s=$?"); echo "[$x]"; }; echo "$y""#,
			out:    "[s=0]\n",
			file:   "[s=0]\n",
			err:    "",
		},
		Both {
			name:   "copied-by-a-jobs-stage",
			script: r#"y=${ /bin/true; jobs %1 | cat; echo "rc=${PIPESTATUS[0]}"; }; echo "$y"; echo end"#,
			out:    "rc=0\nend\n",
			file:   "rc=0\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-status",
			script: r#"y=${ ( exit 3 ); wait %1; echo "rc=$?"; jobs %1; echo "r=$?"; }; echo "$y"; echo end"#,
			out:    "rc=3\nr=0\nend\n",
			file:   "rc=3\nr=0\nend\n",
			err:    "",
		},
		Both {
			name:   "pipeline-status",
			script: r#"y=${ /bin/true | /bin/sh -c 'exit 4'; wait %1; echo "rc=$?"; }; echo "$y"; echo end"#,
			out:    "rc=4\nend\n",
			file:   "rc=4\nend\n",
			err:    "",
		},
		Both {
			name:   "pipefail-status",
			script: r#"set -o pipefail; y=${ /bin/sh -c 'exit 5' | /bin/true; wait %1; echo "rc=$?"; }; echo "$y"; echo end"#,
			out:    "rc=5\nend\n",
			file:   "rc=5\nend\n",
			err:    "",
		},
		Both {
			name:   "by-name",
			script: r#"y=${ /bin/sh -c 'exit 3'; jobs %/bin/sh; echo "rc=$?"; wait %/bin; echo "w=$?"; }; echo "$y"; echo end"#,
			out:    "rc=0\nw=3\nend\n",
			file:   "rc=0\nw=3\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-passes-it-by",
			script: r#"y=${ /bin/true; wait; echo "rc=$?"; wait -n; echo "n=$?"; }; echo "$y"; echo end"#,
			out:    "rc=0\nn=127\nend\n",
			file:   "rc=0\nn=127\nend\n",
			err:    "",
		},
		Both {
			name:   "current-stays",
			script: r#"y=${ sleep 30 & /bin/true; jobs %+; echo "rc=$?"; jobs %-; kill %1; wait; }; echo "$y"; echo end"#,
			out:
				"[1]+  Running                    sleep 30 &\nrc=0\n[1]+  Running                    \
				 sleep 30 &\nend\n",
			file:
				"[1]+  Running                    sleep 30 &\nrc=0\n[1]+  Running                    \
				 sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "fg",
			script: r#"y=${ /bin/true; fg %1; echo "rc=$?"; }; echo "$y"; echo end"#,
			out:    "rc=1\nend\n",
			file:   "rc=1\nend\n",
			err:    "fg: no job control\n",
		},
		Both {
			name:   "disown-a-deletes-all",
			script: r#"y=${ /bin/true; sleep 30 & p=$!; disown -a; jobs %1; echo "r1=$?"; jobs; kill $p; }; echo "$y"; echo end"#,
			out:    "r1=1\nend\n",
			file:   "r1=1\nend\n",
			err:    "jobs: %1: no such job\n",
		},
	]);
}

/// While the list is frozen `jobs` lists a foreground job only once a signal
/// bash reports killed it (bash `should_notify`): one `TERM` or `KILL`
/// killed, through `jobs`, `jobs -p` and a command substitution's `jobs`,
/// after `wait %N` too; a finished one stays unlisted. In a function
/// substitution its notice marks it reported, so `jobs -n` lists none.
#[test]
fn jobs_lists_a_frozen_foreground_job_a_signal_killed() {
	assert_both(&[
		Both {
			name:   "finished-unlisted",
			script: r#"y=${ /bin/true; ( : ); : | :; jobs; echo "st=$?"; }; echo "$y""#,
			out:    "st=0\n",
			file:   "st=0\n",
			err:    "",
		},
		Both {
			name:   "term",
			script: r#"y=${ /bin/sh -c 'kill -TERM $$'; jobs; echo "rc=$?"; }; echo "$y"; echo end"#,
			out:    "[1]   Terminated                 /bin/sh -c 'kill -TERM $$'\nrc=0\nend\n",
			file:   "[1]   Terminated                 /bin/sh -c 'kill -TERM $$'\nrc=0\nend\n",
			err:    "Terminated                 /bin/sh -c 'kill -TERM $$'\n",
		},
		Both {
			name:   "kill",
			script: r#"{ y=${ /bin/sh -c 'kill -KILL $$'; jobs; echo "rc=$?"; }; } 2>/dev/null; echo "$y"; echo end"#,
			out:    "[1]   Killed                     /bin/sh -c 'kill -KILL $$'\nrc=0\nend\n",
			file:   "[1]   Killed                     /bin/sh -c 'kill -KILL $$'\nrc=0\nend\n",
			err:    "",
		},
		Both {
			name:   "after-wait",
			script: r#"{ y=${ /bin/sh -c 'kill -KILL $$'; wait %1; echo "rc=$?"; jobs; echo "r=$?"; }; } 2>/dev/null; echo "$y"; echo end"#,
			out:    "rc=137\n[1]   Killed                     /bin/sh -c 'kill -KILL $$'\nr=0\nend\n",
			file:   "rc=137\n[1]   Killed                     /bin/sh -c 'kill -KILL $$'\nr=0\nend\n",
			err:    "",
		},
		Both {
			name:   "pids",
			script: r#"{ y=${ /bin/sh -c 'kill -KILL $$'; jobs -p | wc -l; /bin/true; jobs -p | wc -l; }; } 2>/dev/null; echo "$y"; echo end"#,
			out:    "1\n1\nend\n",
			file:   "1\n1\nend\n",
			err:    "",
		},
		Both {
			name:   "changed-only",
			script: r#"{ y=${ /bin/sh -c 'kill -KILL $$'; jobs -n; echo "rc=$?"; }; } 2>/dev/null; echo "$y"; echo end"#,
			out:    "rc=0\nend\n",
			file:   "rc=0\nend\n",
			err:    "",
		},
		Both {
			name:   "copied-by-a-substitution",
			script: r#"{ y=${ /bin/sh -c 'kill -KILL $$'; x=$(jobs); echo "[$x]"; }; } 2>/dev/null; echo "$y"; echo end"#,
			out:    "[[1]   Killed                     /bin/sh -c 'kill -KILL $$']\nend\n",
			file:   "[[1]   Killed                     /bin/sh -c 'kill -KILL $$']\nend\n",
			err:    "",
		},
	]);
}

/// The forked stages of a `lastpipe` pipeline are a job while its last stage
/// runs (bash freezes the list, then makes the job): `%1` names it (`jobs
/// %1` lists nothing, `kill %1` signals every stage, `wait %1` returns the
/// stages' status, under `pipefail` too, and `disown %1` succeeds), no job
/// is current, and the stage's jobs are numbered after it. A command the
/// stage forks is a job of its own, listed once a signal killed it, by
/// `jobs -n` too: the frozen list marks nothing.
#[test]
fn a_lastpipe_pipeline_is_a_job_while_its_last_stage_runs() {
	assert_both(
		&[
			Both {
				name:   "jobs-1",
				script: r#"shopt -s lastpipe; echo | { jobs %1; echo "rc=$?"; }; echo end"#,
				out:    "rc=0\nend\n",
				file:   "rc=0\nend\n",
				err:    "",
			},
			Both {
				name:   "kill-1",
				script: r#"shopt -s lastpipe; echo | { kill %1; echo "rc=$?"; }; echo end"#,
				out:    "rc=0\nend\n",
				file:   "rc=0\nend\n",
				err:    "",
			},
			Both {
				name:   "wait-1",
				script: r#"shopt -s lastpipe; echo | { wait %1; echo "rc=$?"; }; echo end"#,
				out:    "rc=0\nend\n",
				file:   "rc=0\nend\n",
				err:    "",
			},
			Both {
				name:   "disown-1",
				script: r#"shopt -s lastpipe; echo | { disown %1; echo "rc=$?"; }; echo end"#,
				out:    "rc=0\nend\n",
				file:   "rc=0\nend\n",
				err:    "",
			},
			Both {
				name:   "running-stage",
				script: r#"shopt -s lastpipe; sleep 30 | { jobs %1; echo "rc=$?"; kill %1; echo "k=$?"; wait %1; echo "w=$?"; }; echo "s=$?"; echo end"#,
				out:    "rc=0\nk=0\nw=143\ns=0\nend\n",
				file:   "rc=0\nk=0\nw=143\ns=0\nend\n",
				err:    "",
			},
			Both {
				name:   "running-stage-unlisted",
				script: r#"shopt -s lastpipe; sleep 30 | { jobs; echo "rc=$?"; jobs -p | wc -l; kill %1; }; echo end"#,
				out:    "rc=0\n0\nend\n",
				file:   "rc=0\n0\nend\n",
				err:    "",
			},
			Both {
				name:   "two-stages-killed",
				script: r#"shopt -s lastpipe; sleep 30 | sleep 30 | { kill %1; wait %1; echo "w=$?"; }; echo end"#,
				out:    "w=143\nend\n",
				file:   "w=143\nend\n",
				err:    "",
			},
			Both {
				name:   "killed-stage-listed",
				script: r#"shopt -s lastpipe; sleep 30 | { kill -KILL %1; wait %1; echo "w=$?"; jobs; echo "rc=$?"; }; echo end"#,
				out:    "w=137\n[1]   Killed                     sleep 30\nrc=0\nend\n",
				file:   "w=137\n[1]   Killed                     sleep 30\nrc=0\nend\n",
				err:    "",
			},
			Both {
				name:   "status",
				script: r#"shopt -s lastpipe; /bin/sh -c 'exit 3' | { wait %1; echo "w=$?"; }; echo "s=$?"; echo end"#,
				out:    "w=3\ns=0\nend\n",
				file:   "w=3\ns=0\nend\n",
				err:    "",
			},
			Both {
				name:   "pipefail-status",
				script: r#"set -o pipefail; shopt -s lastpipe; /bin/sh -c 'exit 3' | /bin/true | { wait %1; echo "w=$?"; }; echo end"#,
				out:    "w=3\nend\n",
				file:   "w=3\nend\n",
				err:    "",
			},
			Both {
				name:   "no-current-job",
				script: r#"shopt -s lastpipe; sleep 30 | { jobs %+; echo "rc=$?"; jobs %-; echo "r=$?"; kill %1; }; echo end"#,
				out:    "rc=1\nr=1\nend\n",
				file:   "rc=1\nr=1\nend\n",
				err:    "jobs: %+: no such job\njobs: %-: no such job\n",
			},
			Both {
				name:   "background-job-numbered-after",
				script: "shopt -s lastpipe; echo | { sleep 30 & jobs; kill %2; wait; }; echo end",
				out:    "[2]+  Running                    sleep 30 &\nend\n",
				file:   "[2]+  Running                    sleep 30 &\nend\n",
				err:    "",
			},
			Both {
				name:   "two-stages-one-job",
				script: "shopt -s lastpipe; echo | cat | { sleep 30 & jobs; kill $!; wait; }; echo end",
				out:    "[2]+  Running                    sleep 30 &\nend\n",
				file:   "[2]+  Running                    sleep 30 &\nend\n",
				err:    "",
			},
			Both {
				name:   "a-loop-stage",
				script: "shopt -s lastpipe; printf '%s\\n' a b | while read i; do sleep 30 & done; \
				         jobs; kill $(jobs -p); wait; echo end",
				out:
					"[2]-  Running                    sleep 30 &\n[3]+  Running                    \
					 sleep 30 &\nend\n",
				file:
					"[2]-  Running                    sleep 30 &\n[3]+  Running                    \
					 sleep 30 &\nend\n",
				err:    "",
			},
			Both {
				name:   "function-substitution-in-the-stage",
				script: r#"shopt -s lastpipe; echo | { y=${ sleep 30 & jobs; kill $!; wait; }; echo "$y"; }; echo end"#,
				out:    "[2]+  Running                    sleep 30 &\nend\n",
				file:   "[2]+  Running                    sleep 30 &\nend\n",
				err:    "",
			},
			Both {
				name:   "command-substitution-in-the-stage",
				script: r#"shopt -s lastpipe; echo | { x=$(sleep 30 & jobs; kill $!; wait); echo "[$x]"; }; echo end"#,
				out:    "[[2]+  Running                    sleep 30 &]\nend\n",
				file:   "[[2]+  Running                    sleep 30 &]\nend\n",
				err:    "",
			},
			Both {
				name:   "foreground-command-in-the-stage",
				script: "shopt -s lastpipe; echo | { /bin/true; sleep 30 & jobs; kill $!; wait; }; \
				         echo end",
				out:    "[3]+  Running                    sleep 30 &\nend\n",
				file:   "[3]+  Running                    sleep 30 &\nend\n",
				err:    "",
			},
			Both {
				name:   "foreground-command-by-number",
				script: r#"shopt -s lastpipe; set +m; : | { /bin/true; jobs %1; echo "st=$?"; jobs %2; echo "s2=$?"; }"#,
				out:    "st=0\ns2=0\n",
				file:   "st=0\ns2=0\n",
				err:    "",
			},
			Both {
				name:   "foreground-commands-numbered",
				script: r#"shopt -s lastpipe; set +m; : | { /bin/true; ( : ); sleep 30 & jobs; kill %3; echo "k=$?"; kill $!; }"#,
				out:    "[4]+  Running                    sleep 30 &\nk=0\n",
				file:   "[4]+  Running                    sleep 30 &\nk=0\n",
				err:    "",
			},
			Both {
				name:   "killed-command-listed",
				script: r#"shopt -s lastpipe; echo | { /bin/sh -c 'kill -KILL $$'; jobs -n; echo "rc=$?"; jobs; }; echo end"#,
				out:    "[2]   Killed                     /bin/sh -c 'kill -KILL $$'\nrc=0\n[2]   \
				         Killed                     /bin/sh -c 'kill -KILL $$'\nend\n",
				file:   "[2]   Killed                     /bin/sh -c 'kill -KILL $$'\nrc=0\n[2]   \
				         Killed                     /bin/sh -c 'kill -KILL $$'\nend\n",
				err:    "",
			},
		],
	);
}

/// As a `lastpipe` pipeline's last stage ends, bash adds it to the
/// pipeline's job as a process of the shell (`execute_pipeline`'s
/// `append_process`), named by the last command the stage ran
/// (`$BASH_COMMAND`) and ended as the stage did: `jobs %1` shows the job's
/// text ending with it and how the stage ended, and `wait %1` returns the
/// pipeline's status, under `pipefail` too, also when the forked stages
/// ended first (the stage waited for them: in it `wait %1` returned theirs).
/// A signal that ended a forked stage is then not the job's: nothing
/// reports it, and the clean-up a plain `jobs` starts with deletes the job.
#[test]
fn a_lastpipe_pipelines_job_ends_with_its_last_stage() {
	assert_both(&[
		Both {
			name:   "text",
			script: "shopt -s lastpipe; echo | { :; true; }; jobs %1; echo end",
			out:    "[1]   Done                       echo | true\nend\n",
			file:   "[1]   Done                       echo | true\nend\n",
			err:    "",
		},
		Both {
			name:   "how-the-stage-ended",
			script: "shopt -s lastpipe; echo | { false; }; jobs %1; echo end",
			out:    "[1]   Exit 1                     echo | false\nend\n",
			file:   "[1]   Exit 1                     echo | false\nend\n",
			err:    "",
		},
		Both {
			name:   "a-loop-stage-s-last-command",
			script: r"shopt -s lastpipe; printf '%s\n' a b | while read i; do :; done; jobs %1; echo end",
			out:    "[1]   Done                       printf '%s\\n' a b | read i\nend\n",
			file:   "[1]   Done                       printf '%s\\n' a b | read i\nend\n",
			err:    "",
		},
		Both {
			name:   "a-plain-jobs-deletes-it",
			script: "shopt -s lastpipe; echo | { :; }; jobs; echo end",
			out:    "end\n",
			file:   "end\n",
			err:    "",
		},
		Both {
			name:   "status",
			script: r#"shopt -s lastpipe; /bin/sh -c 'exit 3' | { :; }; wait %1; echo "w=$?"; echo end"#,
			out:    "w=0\nend\n",
			file:   "w=0\nend\n",
			err:    "",
		},
		Both {
			name:   "pipefail-status",
			script: r#"set -o pipefail; shopt -s lastpipe; /bin/sh -c 'exit 3' | { :; }; wait %1; echo "w=$?"; echo end"#,
			out:    "w=3\nend\n",
			file:   "w=3\nend\n",
			err:    "",
		},
		Both {
			name:   "status-once-the-stage-waited",
			script: r#"shopt -s lastpipe; /bin/sh -c 'exit 3' | { wait %1; echo "in=$?"; }; wait %1; echo "w=$?"; echo end"#,
			out:    "in=3\nw=0\nend\n",
			file:   "in=3\nw=0\nend\n",
			err:    "",
		},
		Both {
			name:   "pipefail-status-once-the-stage-waited",
			script: r#"set -o pipefail; shopt -s lastpipe; /bin/sh -c 'exit 3' | { wait %1; echo "in=$?"; }; wait %1; echo "w=$?"; echo end"#,
			out:    "in=3\nw=3\nend\n",
			file:   "in=3\nw=3\nend\n",
			err:    "",
		},
		Both {
			name:   "how-the-stage-ended-once-it-waited",
			script: "shopt -s lastpipe; echo | { wait %1; false; }; jobs %1; echo end",
			out:    "[1]   Exit 1                     echo | false\nend\n",
			file:   "[1]   Exit 1                     echo | false\nend\n",
			err:    "",
		},
		Both {
			name:   "a-killed-stage-is-not-the-job-s",
			script: r#"shopt -s lastpipe; sleep 30 | { kill -KILL %1; wait %1; }; jobs; echo "rc=$?"; echo end"#,
			out:    "rc=0\nend\n",
			file:   "rc=0\nend\n",
			err:    "",
		},
		Both {
			name:   "a-terminated-stage-unreported",
			script: "shopt -s lastpipe; sleep 30 | { kill %1; wait %1; }; echo out; /bin/true; echo \
			         end",
			out:    "out\nend\n",
			file:   "out\nend\n",
			err:    "",
		},
		Both {
			name:   "a-terminated-stage-unreported-under-pipefail",
			script: "set -o pipefail; shopt -s lastpipe; sleep 30 | { kill %1; wait %1; }; echo out; \
			         /bin/true; echo end",
			out:    "out\nend\n",
			file:   "out\nend\n",
			err:    "",
		},
	]);
}

/// After the freeze the next clean-up deletes the foreground jobs: until
/// then `wait %1` still finds one; `jobs` deletes them first (`wait %1` after
/// it finds none), and so does the next fork, whose job takes number 1
/// again, but a `lastpipe` pipeline's job stays for the next one, which
/// freezes the list first. One a signal killed in a `lastpipe` stage, which
/// the frozen list did not report, stays too: the next fork numbers after
/// it, `jobs` lists it, and the next report point (a command substitution's
/// expansion) gives its notice.
#[test]
fn after_the_freeze_a_clean_up_deletes_the_foreground_jobs() {
	assert_both(&[
		Both {
			name:   "wait-finds-it",
			script: r#"y=${ /bin/sh -c 'exit 3'; }; wait %1; echo "rc=$?"; echo end"#,
			out:    "rc=3\nend\n",
			file:   "rc=3\nend\n",
			err:    "",
		},
		Both {
			name:   "jobs-deletes-it",
			script: r#"y=${ /bin/sh -c 'exit 3'; }; jobs; wait %1; echo "w=$?"; echo end"#,
			out:    "w=127\nend\n",
			file:   "w=127\nend\n",
			err:    "wait: %1: no such job\n",
		},
		Both {
			name:   "jobs-deletes-a-killed-one",
			script: r#"y=${ /bin/sh -c 'kill -TERM $$'; }; jobs; echo "rc=$?"; echo end"#,
			out:    "rc=0\nend\n",
			file:   "rc=0\nend\n",
			err:    "Terminated                 /bin/sh -c 'kill -TERM $$'\n",
		},
		Both {
			name:   "a-fork-deletes-them",
			script: "y=${ /bin/true; /bin/true; }; sleep 30 & jobs; kill $!; wait; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "a-lastpipe-job-stays-for-the-next",
			script: "shopt -s lastpipe; echo | { :; }; echo | { sleep 30 & jobs; kill $!; wait; }; echo end",
			out:    "[3]+  Running                    sleep 30 &\nend\n",
			file:   "[3]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "a-killed-one-stays",
			script: "shopt -s lastpipe; echo | { /bin/sh -c 'kill -KILL $$'; }; sleep 30 & jobs; kill $!; wait; echo end",
			out:    "[2]   Killed                     /bin/sh -c 'kill -KILL $$'\n[3]+  Running                    \
			         sleep 30 &\nend\n",
			file:   "[2]   Killed                     /bin/sh -c 'kill -KILL $$'\n[3]+  Running                    \
			         sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "its-notice-comes-next",
			script: "shopt -s lastpipe; echo | { /bin/sh -c 'kill -TERM $$'; echo in; }; x=$(:); echo out",
			out:    "in\nout\n",
			file:   "in\nout\n",
			err:    "Terminated                 /bin/sh -c 'kill -TERM $$'\n",
		},
	]);
}

/// A function substitution run in a fork of a `-c` shell marks the finished
/// jobs it reports there (bash's `notify_and_cleanup` under -1 marks but
/// deletes nothing), and the first clean-up outside it, at a foreground
/// command, a `wait`, the fork's `jobs` or its next substitution, deletes
/// them; jobs that ended before it went as it was expanded. A job a SIGTERM
/// killed, and `$!`'s in posix mode, stay; `wait PID` still finds a deleted
/// job's status. From a script file the fork marks none (bash's
/// `startup_state` 0), and its substitution drops all but `$!`'s.
#[test]
fn a_function_substitution_s_marks_go_at_the_next_clean_up() {
	assert_both(&[
		Both {
			name:   "foreground-after",
			script: r"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); }; /bin/true; jobs; echo e )",
			out:    "e\n",
			file:   "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "wait-after",
			script: r"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); }; wait; jobs; echo e )",
			out:    "e\n",
			file:   "[2]   Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "jobs-twice-after",
			script: r"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); }; jobs; echo m; jobs; echo e )",
			out:    "m\ne\n",
			file:   "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\nm\ne\n",
			err:    "",
		},
		Both {
			name:   "builtin-after",
			script: r"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); }; :; jobs; echo e )",
			out:    "e\n",
			file:   "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "substitution-process",
			script: r#"x=$( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ z=$(jobs); }; /bin/true; jobs; echo e ); echo "[$x]"; echo end"#,
			out:    "[[2]   Done                       /bin/true\ne]\nend\n",
			file:   "[[2]   Done                       /bin/true\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-pid-after",
			script: r#"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); }; /bin/true; wait $p; echo "w=$?"; jobs; echo e )"#,
			out:    "w=3\ne\n",
			file:   "w=3\n[2]   Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "inside-then-foreground",
			script: r#"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); /bin/true; jobs; }; echo "$y"; echo e )"#,
			out:    "\ne\n",
			file:   "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "posix-foreground-after",
			script: r"set -o posix; ( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); }; /bin/true; jobs; echo e )",
			out:    "[2]   Done                       /bin/true\ne\n",
			file:   "[1]-  Done(3)                    /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "ended-inside",
			script: r#"( sleep 0.1 & p=$!; /bin/true & q=$!; y=${ while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; }; echo "$y"; z=$(jobs); echo "<$z>"; jobs; echo e )"#,
			out:    "[[1]-  Done                       sleep 0.1\n[2]+  Done                       /bin/true]\n<>\ne\n",
			file:   "[[1]-  Done                       sleep 0.1\n[2]+  Done                       /bin/true]\n<[2]   Done                       /bin/true>\n[1]-  Done                       sleep 0.1\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "ended-before",
			script: r#"( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); echo "[$x]"; }; echo "$y"; z=$(jobs); echo "<$z>"; jobs; echo e )"#,
			out:    "[]\n<>\ne\n",
			file:   "[[1]-  Done                       /bin/true\n[2]+  Done                       /bin/true]\n<[2]   Done                       /bin/true>\n[1]-  Done                       /bin/true\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "jobs-after",
			script: r#"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); echo "[$x]"; }; echo "$y"; jobs; echo e )"#,
			out:    "[]\ne\n",
			file:   "[[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true]\n[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "wait-inside",
			script: r#"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ wait $p; echo "w=$?"; }; echo "$y"; z=$(jobs); echo "<$z>"; wait $p; echo "w2=$?" )"#,
			out:    "w=3\n<>\nw2=3\n",
			file:   "w=3\n<[2]   Done                       /bin/true>\nw2=3\n",
			err:    "",
		},
		Both {
			name:   "term-foreground-after",
			script: r"( sleep 20 & p=$!; /bin/true & q=$!; kill -TERM $p; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); }; /bin/true; jobs; echo e )",
			out:    "[1]   Terminated                 sleep 20\ne\n",
			file:   "[1]-  Terminated                 sleep 20\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "jobs-n-after-a-mark",
			script: r#"( sleep 0.1 & p=$!; /bin/true & q=$!; y=${ while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; z=$(:); jobs -n; echo m; jobs; }; echo "$y" )"#,
			out:    "m\n[1]-  Done                       sleep 0.1\n[2]+  Done                       /bin/true\n",
			file:   "[1]-  Done                       sleep 0.1\n[2]+  Done                       /bin/true\nm\n[1]-  Done                       sleep 0.1\n[2]+  Done                       /bin/true\n",
			err:    "",
		},
		Both {
			name:   "jobs-n-in-a-lastpipe-stage-marks-none",
			script: r"shopt -s lastpipe; ( sleep 0.1 & p=$!; /bin/true & q=$!; echo | { while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; z=$(:); jobs -n | wc -l; echo m; } )",
			out:    "2\nm\n",
			file:   "2\nm\n",
			err:    "",
		},
	]);
}

/// A command substitution's copy of its shell's job (`Job::inherited`) is
/// no child of it. `wait %N` of a finished foreground copy returns its
/// status at once (and again: the copy stays), and of one still running,
/// foreground or not, bash's -1 at once; a plain `wait` waits for no copy
/// and leaves each in the table, frozen or not, so `jobs %N` still finds it.
/// bash 5.3.20's output, measured: the -1 too.
#[test]
fn a_copied_job_answers_wait_and_stays() {
	assert_both(&[
		Both {
			name:   "wait-a-finished-foreground-copy",
			script: r#"x=${ /bin/sh -c "exit 7"; y=$(wait %1; printf "w=%s" "$?"); printf "%s" "$y"; }; printf "%s\n" "$x""#,
			out:    "w=7\n",
			file:   "w=7\n",
			err:    "",
		},
		Both {
			name:   "wait-it-twice",
			script: r#"x=${ /bin/sh -c "exit 7"; y=$(wait %1; echo "w=$?"; wait %1; echo "v=$?"; jobs %1 >/dev/null 2>&1; echo "j=$?"); echo "$y"; }; echo "$x""#,
			out:    "w=7\nv=7\nj=0\n",
			file:   "w=7\nv=7\nj=0\n",
			err:    "",
		},
		Both {
			name:   "wait-a-running-foreground-copy",
			script: r#"shopt -s lastpipe; sleep 1 | { x=$(wait %1; echo "w=$?"); echo "[$x]"; }; echo end"#,
			out:    "[w=-1]\nend\n",
			file:   "[w=-1]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-a-running-background-copy",
			script: r#"sleep 1 & x=$(wait %1; echo "w=$?"); echo "[$x]"; wait; echo end"#,
			out:    "[w=-1]\nend\n",
			file:   "[w=-1]\nend\n",
			err:    "",
		},
		Both {
			name:   "a-plain-wait-keeps-a-foreground-copy",
			script: r#"x=${ /bin/true; y=$(wait; jobs %1 2>/dev/null; printf "found=%s" "$?"); printf "%s" "$y"; }; printf "%s\n" "$x""#,
			out:    "found=0\n",
			file:   "found=0\n",
			err:    "",
		},
		Both {
			name:   "in-a-lastpipe-stage",
			script: r#"shopt -s lastpipe; echo | { /bin/true; x=$(wait; jobs %2 >/dev/null 2>&1; echo "found=$?"); echo "$x"; }"#,
			out:    "found=0\n",
			file:   "found=0\n",
			err:    "",
		},
		Both {
			name:   "a-plain-wait-keeps-a-background-copy",
			script: r#"/bin/sh -c 'exit 3' & p=$!; while kill -0 $p 2>/dev/null; do :; done; x=$(wait; jobs %1 2>/dev/null; echo "found=$?"); echo "$x""#,
			out:    "[1]+  Exit 3                     /bin/sh -c 'exit 3'\nfound=0\n",
			file:   "[1]+  Exit 3                     /bin/sh -c 'exit 3'\nfound=0\n",
			err:    "",
		},
	]);
}

/// `break` or `continue` out of the last stage of a `lastpipe` pipeline:
/// bash still appends the stage to the pipeline's job as it ends, with the
/// builtin's status, so `wait %1` returns 0, not the forked stage's 7.
/// bash 5.3.20's output, measured. Not covered: bash also waits for the
/// forked stages there (`sleep 2 | break` takes 2 s), obash goes on at once.
#[test]
fn break_out_of_a_lastpipe_stage_ends_its_job() {
	assert_both(&[
		Both {
			name:   "break",
			script: r#"shopt -s lastpipe; x=${ for i in 1; do /bin/sh -c "exit 7" | break; done; wait %1; printf "w=%s" "$?"; }; printf "%s\n" "$x""#,
			out:    "w=0\n",
			file:   "w=0\n",
			err:    "",
		},
		Both {
			name:   "continue",
			script: r#"shopt -s lastpipe; x=${ for i in 1; do /bin/sh -c "exit 7" | continue; done; wait %1; printf "w=%s" "$?"; }; printf "%s\n" "$x""#,
			out:    "w=0\n",
			file:   "w=0\n",
			err:    "",
		},
		Both {
			name:   "its-job-unlisted",
			script: r#"shopt -s lastpipe; x=${ for i in 1; do echo | break; done; jobs %1; }; echo "$x""#,
			out:    "\n",
			file:   "\n",
			err:    "",
		},
	]);
}

/// A job this shell's `kill` ended right after `&` is reaped for bash by the
/// next foreground command, also when one ran before the `kill` (obash
/// takes that only from a flag it sets again at the kill): the plain `wait`
/// then finds no job running, and `jobs` reports the job killed, `$!`'s
/// only (`two-jobs`); `jobs` and `kill -0 $!` right after the foreground
/// command find it ended too. `kill %1` ends a `( … )` job's vproc at once;
/// it holds the signal for a job whose pid is still to be decided (a
/// program, a pipeline), which spawns its program and has the signal end
/// it there, later than bash's child: `wait`, `jobs` and `kill` wait for
/// that end first. Rows for `KILL`, `TERM` and `HUP`, and for a `TERM` the
/// shell traps (`trapped-term`: the job resets the trap); each is bash
/// 5.3.20's output, measured.
#[test]
fn a_kill_after_a_foreground_command_is_reaped_by_the_next() {
	assert_both(&[
		Both {
			name:   "subshell",
			script: r#"/bin/true; ( sleep 30 ) & kill -KILL %1; /bin/true; wait; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\n[1]+  Killed                     ( sleep 30 )\nend\n",
			file:   "w=0\n[1]+  Killed                     ( sleep 30 )\nend\n",
			err:    "",
		},
		Both {
			name:   "pipeline",
			script: r#"/bin/true; sleep 30 | cat & kill -KILL %1; /bin/true; wait; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\n[1]+  Killed                     sleep 30 | cat\nend\n",
			file:   "w=0\n[1]+  Killed                     sleep 30 | cat\nend\n",
			err:    "",
		},
		Both {
			name:   "program",
			script: r#"/bin/true; sleep 30 & kill -KILL %1; /bin/true; wait; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\n[1]+  Killed                     sleep 30\nend\n",
			file:   "w=0\n[1]+  Killed                     sleep 30\nend\n",
			err:    "",
		},
		Both {
			name:   "pipeline-first",
			script: r#"sleep 30 | cat & kill -KILL %1; /bin/true; wait; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\n[1]+  Killed                     sleep 30 | cat\nend\n",
			file:   "w=0\n[1]+  Killed                     sleep 30 | cat\nend\n",
			err:    "",
		},
		Both {
			name:   "pipeline-term",
			script: r#"/bin/true; sleep 30 | cat & kill %1; /bin/true; wait; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\n[1]+  Terminated                 sleep 30 | cat\nend\n",
			file:   "w=0\n[1]+  Terminated                 sleep 30 | cat\nend\n",
			err:    "",
		},
		Both {
			name:   "program-term",
			script: r#"/bin/true; sleep 30 & kill %1; /bin/true; wait; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\n[1]+  Terminated                 sleep 30\nend\n",
			file:   "w=0\n[1]+  Terminated                 sleep 30\nend\n",
			err:    "",
		},
		Both {
			name:   "pipeline-hup",
			script: r#"/bin/true; sleep 30 | cat & kill -HUP %1; /bin/true; wait; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\n[1]+  Hangup                     sleep 30 | cat\nend\n",
			file:   "w=0\n[1]+  Hangup                     sleep 30 | cat\nend\n",
			err:    "",
		},
		Both {
			name:   "trapped-term",
			script: r#"trap 'echo t' TERM; /bin/true; sleep 30 | cat & kill %1; /bin/true; wait; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\n[1]+  Terminated                 sleep 30 | cat\nend\n",
			file:   "w=0\n[1]+  Terminated                 sleep 30 | cat\nend\n",
			err:    "",
		},
		Both {
			name:   "two-jobs",
			script: r#"/bin/true; sleep 30 | cat & sleep 30 & kill -KILL %1 %2; /bin/true; wait; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\n[2]   Killed                     sleep 30\nend\n",
			file:   "w=0\n[2]   Killed                     sleep 30\nend\n",
			err:    "",
		},
		Both {
			name:   "jobs",
			script: r"/bin/true; sleep 30 | cat & kill -KILL %1; /bin/true; jobs; echo end",
			out:    "[1]+  Killed                     sleep 30 | cat\nend\n",
			file:   "[1]+  Killed                     sleep 30 | cat\nend\n",
			err:    "",
		},
		Both {
			name:   "program-jobs",
			script: r"/bin/true; sleep 30 & kill -KILL %1; /bin/true; jobs; echo end",
			out:    "[1]+  Killed                     sleep 30\nend\n",
			file:   "[1]+  Killed                     sleep 30\nend\n",
			err:    "",
		},
		Both {
			name:   "kill-pid",
			script: r#"/bin/true; sleep 30 & kill -KILL %1; /bin/true; kill -0 $! 2>/dev/null; echo "k=$?"; jobs; echo end"#,
			out:    "k=1\n[1]+  Killed                     sleep 30\nend\n",
			file:   "k=1\n[1]+  Killed                     sleep 30\nend\n",
			err:    "",
		},
		Both {
			name:   "pipeline-kill-pid",
			script: r#"/bin/true; sleep 30 | cat & kill -KILL %1; /bin/true; kill -0 $! 2>/dev/null; echo "k=$?"; jobs; echo end"#,
			out:    "k=1\n[1]+  Killed                     sleep 30 | cat\nend\n",
			file:   "k=1\n[1]+  Killed                     sleep 30 | cat\nend\n",
			err:    "",
		},
	]);
}

/// With no foreground command between the `kill` and the `wait`, bash has
/// not reaped the job: the plain `wait` waits for it and reports it (its
/// notice goes to `/dev/null` here), and `jobs` then lists nothing. Reading
/// `$!` makes obash decide the job's pid, and so spawn its program and end
/// it, before the `wait`. Nor does a `kill -0 %1` reap it, which succeeds
/// on bash's unreaped job without job control: three of them let obash
/// find the job ended (a pipeline's program, a `( … )` at once), and still
/// the `wait` reports it. bash 5.3.20's output, measured.
#[test]
fn a_kill_with_no_foreground_command_after_it_is_waited_for() {
	assert_both(&[
		Both {
			name:   "pipeline",
			script: r#"sleep 30 | cat & kill -KILL %1; p=$!; wait 2>/dev/null; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\nend\n",
			file:   "w=0\nend\n",
			err:    "",
		},
		Both {
			name:   "program",
			script: r#"sleep 30 & kill -KILL %1; p=$!; wait 2>/dev/null; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\nend\n",
			file:   "w=0\nend\n",
			err:    "",
		},
		Both {
			name:   "three-kill-0",
			script: r#"sleep 30 | cat & kill -KILL %1; kill -0 %1; kill -0 %1; kill -0 %1; wait 2>/dev/null; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\nend\n",
			file:   "w=0\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-three-kill-0",
			script: r#"( sleep 30 ) & kill -KILL %1; kill -0 %1; kill -0 %1; kill -0 %1; wait 2>/dev/null; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\nend\n",
			file:   "w=0\nend\n",
			err:    "",
		},
	]);
}

/// [`a_kill_after_a_foreground_command_is_reaped_by_the_next`] under `set
/// -m`: a job started with job control does not ignore `INT`, so `kill
/// -INT %1` ends it as `KILL` and `TERM` do. bash 5.3.20's output, measured.
/// Not a row: `QUIT`, which bash's job outlives with job control too, and
/// `INT` without `set -m`, which bash's child dies of before it sets the
/// ignore on some hosts and not on others.
#[test]
fn a_kill_under_job_control_is_reaped_by_the_next() {
	assert_both(&[
		Both {
			name:   "kill",
			script: r#"set -m; /bin/true; sleep 30 | cat & kill -KILL %1; /bin/true; wait; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\n[1]+  Killed                     sleep 30 | cat\nend\n",
			file:   "w=0\n[1]+  Killed                     sleep 30 | cat\nend\n",
			err:    "",
		},
		Both {
			name:   "term",
			script: r#"set -m; /bin/true; sleep 30 | cat & kill %1; /bin/true; wait; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\n[1]+  Terminated                 sleep 30 | cat\nend\n",
			file:   "w=0\n[1]+  Terminated                 sleep 30 | cat\nend\n",
			err:    "",
		},
		Both {
			name:   "int",
			script: r#"set -m; /bin/true; sleep 30 | cat & kill -INT %1; /bin/true; wait; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\n[1]+  Interrupt                  sleep 30 | cat\nend\n",
			file:   "w=0\n[1]+  Interrupt                  sleep 30 | cat\nend\n",
			err:    "",
		},
		Both {
			name:   "program-int",
			script: r#"set -m; /bin/true; sleep 30 & kill -INT %1; /bin/true; wait; echo "w=$?"; jobs; echo end"#,
			out:    "w=0\n[1]+  Interrupt                  sleep 30\nend\n",
			file:   "w=0\n[1]+  Interrupt                  sleep 30\nend\n",
			err:    "",
		},
	]);
}

/// A signal the job inherits ignored (`trap '' TERM`) does not end it: at
/// `jobs` it is still running, held on a FIFO that nothing writes until
/// after `jobs`, and the plain `wait` then waits for its end. bash 5.3.20's
/// output, measured.
#[test]
fn a_kill_the_job_ignores_leaves_it_running() {
	assert_both(&[Both {
		name:   "ignored-term",
		script: r#"trap '' TERM; mkfifo f; /bin/true; cat f | cat & kill %1; /bin/true; jobs; echo x > f; wait; echo "w=$?"; echo end"#,
		out:    "[1]+  Running                    cat f | cat &\nx\nw=0\nend\n",
		file:   "[1]+  Running                    cat f | cat &\nx\nw=0\nend\n",
		err:    "",
	}]);
}
