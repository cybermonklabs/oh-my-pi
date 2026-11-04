//! Every Bash-oracle script #17712's tests carry, run through the session API
//! (`Shell::run`, which the bash tool calls once per tool call) and held to
//! Bash 5.3.20's `bash --noprofile --norc -c`. Each test is one group of rows,
//! named for the test that first carried them, and reads
//! `fixtures/bash_rows/<group>.jsonl`, which `fixtures/bash_rows/generate.py`
//! writes from real Bash: per row the script, Bash 5.3.20's exit status and
//! output (stdout and stderr merged), and Bash 5.2.21's where it differs.
//! Regenerate with `python3
//! crates/pi-shell/tests/fixtures/bash_rows/generate.py` after changing
//! `scripts.jsonl`; the generator's header says how it runs Bash.
//!
//! A background job that runs inside the shell process (a function, a
//! subshell, a brace group, an `&&`/`||` list, a builtin, a pipeline with
//! such a stage, a coprocess) takes part in job control the way the process
//! Bash forks for it does: `$!` names it, and `wait`, `kill`, `jobs` and
//! `disown` reach it by that process id. Many rows define `$o`, a file a
//! `jobs` listing is written to, and `kind`, which prints what the listing
//! was: `full` (a `[N]` line), `pid` (a bare pid) or `none`; and start a job
//! that has ended before the observation (`/bin/sh -c 'exit 1' &`, then a
//! foreground process that waits for its exit, or `f(){ return 1; }; f &`,
//! then a loop until `kill -0` fails).
#![cfg(target_os = "linux")]

use std::collections::HashMap;

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// The scripts that run at once in one test process. Nextest runs each test
/// in its own process; eight scripts each kept 57 tests run in one process
/// under the default limit of 1024 open files.
static SCRIPT_RUNS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);

/// The bound on one row. Bash ends every row in a few seconds; a row the
/// shell does not end (a job it waits for that never ends) gets this result
/// instead, so a group of such rows still ends before nextest's 240 s.
const ROW_BUDGET_MS: u32 = 20_000;

/// One fixture row: Bash 5.3.20's normalized exit status and output.
struct Row {
	id:     String,
	script: String,
	exit:   Option<i32>,
	output: String,
}

fn parse_rows(fixture: &str) -> Vec<Row> {
	fixture
		.lines()
		.map(|line| {
			let row: serde_json::Value = serde_json::from_str(line).expect("fixture row");
			let text = |name: &str| row[name].as_str().expect("fixture field").to_owned();
			Row {
				id:     text("id"),
				script: text("script"),
				exit:   row["exit"]
					.as_i64()
					.map(|exit| i32::try_from(exit).expect("exit status")),
				output: text("output"),
			}
		})
		.collect()
}

/// What `generate.py`'s `normalize` does, and nothing else: the row's
/// directory becomes `<TMP>`, a `mktemp` name in it `<TMP>/tmp.X`, and a run
/// of 4 or more ASCII digits with no ASCII letter, digit, `_` or `.` on
/// either side (a pid) `<N>`.
fn normalize(output: &str, dir: &str) -> String {
	const MKTEMP: &str = "<TMP>/tmp.";
	let output = output.replace(dir, "<TMP>");
	let mut named = String::with_capacity(output.len());
	let mut rest = output.as_str();
	while let Some(at) = rest.find(MKTEMP) {
		let after = &rest[at + MKTEMP.len()..];
		named.push_str(&rest[..at + MKTEMP.len()]);
		if after.len() >= 10 && after.as_bytes()[..10].iter().all(u8::is_ascii_alphanumeric) {
			named.push('X');
			rest = &after[10..];
		} else {
			rest = after;
		}
	}
	named.push_str(rest);
	let bytes = named.as_bytes();
	let joins = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.';
	let mut out = String::with_capacity(named.len());
	let mut copied = 0;
	let mut index = 0;
	while index < bytes.len() {
		if !bytes[index].is_ascii_digit() {
			index += 1;
			continue;
		}
		let start = index;
		while index < bytes.len() && bytes[index].is_ascii_digit() {
			index += 1;
		}
		let alone =
			(start == 0 || !joins(bytes[start - 1])) && (index == bytes.len() || !joins(bytes[index]));
		if index - start >= 4 && alone {
			out.push_str(&named[copied..start]);
			out.push_str("<N>");
			copied = index;
		}
	}
	out.push_str(&named[copied..]);
	out
}

/// Runs `script` in a fresh shell, in a fresh directory that is also its
/// `TMPDIR`, and returns its exit status (`None` when it ran past
/// [`ROW_BUDGET_MS`]) and normalized output.
async fn run_row(script: String) -> (Option<i32>, String) {
	let dir = tempfile::Builder::new()
		.prefix("bash-row-")
		.tempdir()
		.expect("row directory");
	let path = dir.path().canonicalize().expect("row directory path");
	let path = path.to_str().expect("utf8 row directory").to_owned();
	let (tx, rx) = flume::unbounded::<String>();
	let result = Shell::new(None)
		.run(
			ShellRunOptions {
				command: script,
				cwd: Some(path.clone()),
				env: Some(HashMap::from([("TMPDIR".to_owned(), path.clone())])),
				..Default::default()
			},
			Some(tx),
			CancelToken::new(Some(ROW_BUDGET_MS)),
		)
		.await
		.expect("run");
	let output: String = rx.drain().collect();
	(result.exit_code.filter(|_| !result.timed_out), normalize(&output, &path))
}

/// Runs every row of `fixture`, eight at a time (see [`SCRIPT_RUNS`]), and
/// asserts Bash 5.3.20's exit status and output, reporting every row that
/// differs.
async fn assert_rows(group: &str, fixture: &str) {
	let rows = parse_rows(fixture);
	assert!(!rows.is_empty(), "{group}: empty fixture");
	let mut runs = tokio::task::JoinSet::new();
	for (index, row) in rows.iter().enumerate() {
		let script = row.script.clone();
		runs.spawn(async move {
			let _permit = SCRIPT_RUNS.acquire().await.expect("run limit");
			(index, run_row(script).await)
		});
	}
	let mut results = runs.join_all().await;
	results.sort_unstable_by_key(|&(index, _)| index);
	let mismatches: Vec<String> = results
		.into_iter()
		.filter_map(|(index, (exit, output))| {
			let row = &rows[index];
			((exit, output.as_str()) != (row.exit, row.output.as_str())).then(|| {
				format!(
					"{}: `{}`\n  bash: {:?} {:?}\n  omp:  {exit:?} {output:?}",
					row.id, row.script, row.exit, row.output
				)
			})
		})
		.collect();
	assert!(
		mismatches.is_empty(),
		"{group}: {} of {} rows differ from bash:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

/// One test per group: `name;` reads `fixtures/bash_rows/name.jsonl`.
macro_rules! bash_rows {
	($($(#[$attr:meta])* $group:ident;)*) => {$(
		$(#[$attr])*
		#[tokio::test(flavor = "multi_thread")]
		async fn $group() {
			assert_rows(
				stringify!($group),
				include_str!(concat!("fixtures/bash_rows/", stringify!($group), ".jsonl")),
			)
			.await;
		}
	)*};
}

bash_rows! {
	/// `$!` was empty after an in-process job, so `wait "$!"` failed with
	/// `no such job` and the script went on before the job had finished.
	wait_on_the_pid_of_a_background_function_waits_for_it;

	/// Each row backgrounds a different kind of in-process job; the job's own
	/// exit status must reach `wait "$!"`.
	every_in_process_job_kind_reports_its_status_through_its_pid;

	/// `exit` in a background job ends the job, not the shell that waits for it:
	/// only the job's status reaches `wait`. `wait %1` and `wait -n` handed the
	/// job's `exit` to the waiting shell, which then exited too.
	exit_in_a_background_job_ends_only_the_job;

	/// A pid whose job left the job table keeps its status: `wait` on it again,
	/// or after `wait -n` reported it, returns the same status. An external job
	/// answered `not a child of this shell` (127) the second time.
	a_reported_pid_keeps_its_status;

	/// A job that `wait` reported stays in the job table until the next cleanup
	/// point, which the next `wait` on it is, so a second `wait` on its job spec
	/// returns its status again and a third is `no such job` (127). It used to
	/// report 0, a status the job never returned, and later 127 at once.
	a_reported_job_spec_is_forgotten;

	/// `wait` with no operand also forgets the statuses it reported.
	wait_without_operands_forgets_reported_pids;

	/// When a job leaves the table, `%%` moves to the previous job and the next
	/// job takes the number after the highest one in use. A job number was the
	/// table's length plus one, so two jobs could share it. A job `wait` reported
	/// leaves the table at the next input line.
	job_specs_follow_jobs_that_leave_the_table;

	/// `wait` refuses an operand with Bash's message and status: a job spec
	/// that names no job is 127, not 1, and an operand that is neither a pid nor
	/// a job spec says so.
	wait_refuses_bad_operands_as_bash_does;

	/// A signal that ends a process ends an in-process job, and `wait` reports
	/// it as Bash reports a process the signal killed: 128 plus the signal
	/// number. `kill %1` used to leave `wait %1` reporting 0, and `kill "$!"` had
	/// no pid to name. A job that already finished keeps its own status.
	kill_ends_an_in_process_job_with_the_signal_status;

	/// `kill` reaches an in-process job by its pid from another shell in the
	/// process: a subshell, or a background watchdog that ends the job it was
	/// started beside.
	kill_reaches_an_in_process_job_from_a_subshell;

	/// `jobs -p`, `jobs -l` and `wait -p` name an in-process job by the pid in
	/// `$!`; `jobs -p` printed nothing, `jobs -l` printed `<pid unknown>` and
	/// `wait -p` the job number.
	job_listings_name_an_in_process_job_by_its_pid;

	/// `NAME_PID` held the coprocess's job number, so `wait "$C_PID"` asked
	/// for pid 1, and `$!` was left unset.
	coproc_pid_names_a_waitable_coprocess;

	/// `disown` was not implemented: it failed with status 99, `-h` printed a
	/// usage text, and the job stayed in the job table. A disowned job leaves
	/// job control but keeps running, and its pid keeps the status it had so far.
	disown_takes_a_job_out_of_job_control_and_leaves_it_running;

	/// `disown -a` and `disown -r` keep no status for the pids they remove, and
	/// `disown -a` forgets the statuses `wait` kept; each `disown` operand is
	/// resolved against the table the operands before it left. All of them
	/// removed jobs one by one, keeping each status, against the table as it was.
	disown_resolves_each_operand_and_keeps_bash_statuses;

	/// A signal the job trapped runs the job's trap once its foreground command
	/// returns, and the job goes on to its own status; `exit` in the trap sets
	/// it. A trap inherited from the shell that started the job does not count,
	/// as an asynchronous subshell resets traps. `kill` used to end a trapping
	/// job with 143 and never run the trap. The job's foreground command says
	/// when it runs (`ready`), after the trap is set, and runs until the shell
	/// has signalled the job (`go`) or removed the directory.
	kill_runs_a_trap_the_job_set;

	/// `jobs` showed a job that had ended during the same command as `Running`:
	/// it read the job states without first collecting the jobs that had ended.
	jobs_shows_a_job_that_ended_as_ended;

	/// Once `jobs` has listed an ended job, the next listing of every job leaves
	/// it out, `jobs -p` and `jobs -n` included. It was listed again on every
	/// call.
	jobs_lists_an_ended_job_once;

	/// `wait -n` passes over an ended job that `jobs`, `jobs -l`, `jobs %1` or
	/// `jobs -n` listed, so with no other job it returns 127; it returned the
	/// listed job again. `jobs -p` prints only pids, `jobs -r` leaves the job
	/// out and `jobs %99` names no job, so none of them reports a status and
	/// `wait -n` still returns the job.
	wait_n_passes_over_a_job_jobs_reported;

	/// A listing of every job (`jobs`, `jobs -n`) keeps the ended job it reports
	/// in the table, so `wait %1` still returns its status. Each job spec a
	/// listing resolves takes the reported jobs out after it, so `wait %1` gives
	/// 127 and a second `%1` operand names no job. A job spec that names no job
	/// takes nothing out. Either way the job's pid keeps its status, also after
	/// the next listing of every job. `jobs -n` took the job out at once and
	/// `jobs %1` left it in.
	a_reported_job_leaves_the_table_where_bash_takes_it_out;

	/// The next job to start leaves out an ended job `jobs` reported, so it takes
	/// that job's number. It took the next number, and `%1` still named the ended
	/// job.
	a_new_job_takes_the_number_of_a_reported_job;

	/// A job-spec listing takes out every job a listing reported, not only the
	/// job it names: after `jobs` reported both ended jobs, `jobs %2` also takes
	/// out `%1`, whose pid keeps its status.
	a_job_spec_listing_takes_out_every_reported_job;

	/// `jobs -n` lists a job whose state changed since a listing last showed it,
	/// and a job no listing has shown yet counts as changed, also while it runs.
	/// Once a listing has shown a running job, `jobs -n` leaves it out, and
	/// `wait -n` returns it when it ends: a running job is not reported. `jobs
	/// -n` listed only ended jobs.
	jobs_n_lists_a_job_whose_state_changed;

	/// Every arrangement of `-l`, `-n` and `-p` decides the listing by its last
	/// option, as in Bash: each option alone and in every order, repeated, and
	/// split over words. With `-p` last, `jobs` prints the ended job's pid and
	/// reports nothing: a later listing of every job still shows the job, `wait
	/// -n` still returns it and the next input line still finds it. With `-l`,
	/// `-n` or none last, `jobs` prints the job in full and reports it: a later
	/// listing leaves it out, `wait -n` passes over it, and the next input line
	/// no longer finds it; `wait` on its job spec in the same line, and on its pid
	/// at any time, still returns its status. A disowned job is in no listing.
	///
	/// A later `-l` lost to an earlier `-p` (`jobs -pl` printed only the pid and
	/// reported nothing), a repeated option was refused, and a reported job was
	/// still found on the next line of the same command.
	the_last_of_jobs_l_n_and_p_decides_the_listing;

	/// As Bash does before it reads each input line, the shell forgets a job a
	/// listing reported before it runs the next line of a command, of an `eval`
	/// string (a one-line `eval` too) or of a sourced file; the job's pid keeps
	/// its status. A command that spans lines (a brace group, an `if`, a function
	/// body) is read whole before it runs, so its later lines still find the job,
	/// as does a later command on the same line. The shell forgot a reported job
	/// only when a new run started, never between the lines of one.
	a_reported_job_is_forgotten_before_the_next_input_line;

	/// As Bash does when it starts a child, the shell forgets a job a listing
	/// reported when it starts an external command, a builtin that stands in for
	/// one (`cat`, `sleep`, `timeout`), a subshell, a pipeline, or a command or
	/// process substitution; `wait %1` then names no job, while the pid keeps
	/// its status. A builtin, brace group or function that runs in the shell
	/// starts no child, so `wait %1` still finds the job. The shell kept the job
	/// through every one of them.
	starting_a_child_forgets_a_reported_job;

	/// `wait` prints none of the jobs it collects, also with `set -m`, as in
	/// Bash; `jobs` is how a script learns their state. With `set -m`, `wait`
	/// printed every job that had ended, so a job `jobs` had just reported was
	/// reported a second time.
	wait_reports_no_job_under_set_m;

	/// A process of a job that ends, even one stage of a pipeline that runs on,
	/// is a change of state no listing has shown, so `jobs -n` lists the job
	/// again, as in Bash. `jobs -n` compared only the job's state, which stayed
	/// `Running`, and left the job out.
	jobs_n_lists_a_job_again_after_one_of_its_processes_ends;

	/// The last of `-r` and `-s` decides which jobs `jobs` lists, and either may
	/// repeat, as in Bash. Both together listed nothing, and a repeated one was
	/// refused.
	the_last_of_jobs_r_and_s_decides_the_state_listed;

	/// After `jobs` reported an ended job, each boundary of the fixture runs,
	/// then one observation: a listing of every job, `jobs -n`, `wait` on the
	/// job spec, `wait -n`, or `wait` on the pid. The shell forgets the job where
	/// Bash runs `cleanup_dead_jobs`: when it reads an input line, of the script,
	/// of an `eval` string or a sourced file that is not empty, or of the text
	/// of a `$(...)` or `<(...)` it expands; when it starts a child, an external
	/// command found or not, one whose redirection fails in the child, a
	/// subshell, a pipeline, a background job; after each test or pass of a
	/// loop; in `wait` and `jobs`. `kill` on the job spec makes the job one no
	/// listing has shown, so it is listed again and `wait -n` returns it. With
	/// `lastpipe` Bash freezes its job table for the pipeline. The shell kept the
	/// job through a command that is not found or fails its redirection, a
	/// loop, an `eval` string or a sourced file of blanks or a comment, and
	/// forgot it in a `lastpipe` pipeline.
	a_reported_job_is_forgotten_at_each_bash_cleanup_point;

	/// `wait` on a job reports it: the job stays in the table until the next
	/// cleanup point, so a second `wait` on it in the same line returns its
	/// status again, and the next line no longer finds it; its pid keeps the
	/// status. `wait` with no operand reports every ended job except the one
	/// whose pid is `$!` and that it did not wait for, then forgets every pid's
	/// status. In POSIX mode `wait` on a pid also forgets the job and the pid's
	/// status, unless only the status was left. `wait -n` with an operand that
	/// names no job refuses it and waits for the others; `wait` with no operand
	/// leaves its `-p` variable unset. `wait` took the job out of the table at
	/// once, `wait` with no operand forgot every ended job, and `wait -n` gave
	/// up at the first bad operand.
	wait_reports_the_job_it_waits_for_as_bash_does;

	/// `wait -n` returns the first ended job no listing reported, in table
	/// order. With none, it waits while any job runs, then returns the first
	/// ended job among those it selects, a reported one too. `wait` with no
	/// operand keeps the ended job whose pid is `$!` and forgets the others, and
	/// every pid's status. A job-spec listing forgets the job before `wait -n`
	/// resolves its operands.
	wait_n_and_wait_choose_among_jobs_as_bash_does;

	/// With `lastpipe` the last command of a pipeline runs in the shell, and
	/// Bash freezes its job table for the whole pipeline: nothing in it, an
	/// external command, a loop or an `eval` included, forgets the reported job,
	/// and `wait -n` returns at once. The next cleanup point after it forgets
	/// the job.
	a_lastpipe_pipeline_forgets_no_job;

	/// Bash reads one more line of an `eval` string or a sourced file when text
	/// follows the line its last command ends on, a blank line or a comment
	/// line, and that read forgets the reported job; a comment on the command's
	/// own line, a final newline and a here-document's lines are part of the
	/// command. The text of a `$(...)` is read when its word is expanded, also
	/// in a `${...}` operand that is not used, or in double quotes, but not
	/// when the word is not expanded; a backquoted command's text is not read.
	/// The shell read no such line and expanded no unused operand.
	reading_a_line_of_text_forgets_a_reported_job;

	/// `kill` on a job spec makes the job one no listing has shown, as Bash's
	/// `kill_pid` does, even with a signal that changes nothing: `jobs -n` lists
	/// it again, and an ended job is no longer reported. Without job control a
	/// job that has ended gets no signal and `kill` succeeds. A process-group
	/// operand counts the same; a pid does not. `kill %1` on an ended job failed
	/// and left it reported.
	kill_on_a_job_makes_it_unreported;

	/// With job control on (`set -m`), a process of a job that stops or
	/// continues is a change no listing has shown: `jobs -n` lists the job
	/// again, and `jobs -s` and `jobs -r` see its new state. Without job control
	/// Bash does not see stops or continues at all. `wait` on a stopped job
	/// returns 128 plus the stop signal at once. The shell saw neither.
	set_m_sees_a_job_stop_and_continue;

	/// The redirection of `command` applies to the command it wraps. Bash strips
	/// `command` and its `-p`/`--` options before it decides whether that command
	/// forks (`check_command_builtin`, which takes one `-p` and then one `--`):
	/// `command /bin/true`, an unknown name and a function it suppresses all
	/// fork, while `command -v`, `command -V`, a colon and `builtin command` do
	/// not. Any other option spelling, a second `-p` or `-pp` included, leaves
	/// the `command` builtin itself to run in the shell, and `command -- -p`
	/// runs a program named `-p`. A failed redirection before or after the
	/// command word has the same boundary. The classifier saw only `command`, so
	/// the 24 external wrapped rows kept the reported job.
	a_failed_redirect_of_command_uses_its_wrapped_command;

	/// Bash parses each `$(...)` it meets while it expands a word, and each
	/// `<(...)` or `>(...)` in a `${...}` operand: nested in an arithmetic
	/// expansion, in double quotes, and in an operand `${...}` does not select.
	/// Single quotes protect only outside double quotes; an escaped `$` and a
	/// backquoted command stay unread. The walk stopped at arithmetic
	/// expressions, did not see process substitutions, and let single quotes
	/// protect inside double quotes, leaving the reported job in 14 of the
	/// review's 56 rows. With `x` unset, `${x:-$((1+${y:+$(echo 0)}))}` is an
	/// arithmetic syntax error that stops the script in both shells, so that row
	/// is left out.
	nested_word_expansion_reads_every_bash_substitution;

	/// With job control, an all-external pipeline is stopped when no process
	/// runs and one is stopped: an exited stage does not run. Bash lists it
	/// through `jobs -s`, `jobs -n` leaves it out once `jobs` has shown it, and
	/// `wait %1` warns that the job is stopped and returns at once with 128 plus
	/// `WSTOPSIG` of the job's first process, here the exited `/bin/true`, so
	/// 128; continued, it ends with its last stage's 7. Counting the exited
	/// stage as running left the job `Running` and out of `jobs -s`, the listing
	/// drained the stop report, and `wait %1` blocked until cancelled. The rows
	/// are the review's; the warning's text differs between the shells, so only
	/// its presence is compared.
	a_stopped_pipeline_with_an_exited_stage_is_waitable;

	/// `bg` leaves a running job alone, reports that it is already in the
	/// background, and succeeds. `fg` unmarks a running job, waits for it as a
	/// foreground job and removes it without retaining its pid status. The shell
	/// kept the mark for `fg`, retained the pid and tried to take the controlling
	/// terminal in a noninteractive script, so external foregrounding failed.
	bg_and_fg_handle_a_running_job_as_bash_does;

	/// Bash reads text with its parser while it expands a word wherever its
	/// extraction of the word meets a `$(...)`, or a `<(...)`/`>(...)` outside
	/// double quotes, also in a part of the word it then does not use: the
	/// operand `${...}` does not select, a pattern, a `$((` that is a command
	/// substitution, the text brace expansion scans (where single quotes inside
	/// double quotes are literal), a `$'...'` once translated; a `$((` with
	/// balanced parentheses is arithmetic, and only its expansions are read. The
	/// fixture holds 852 words, generated over 16 payloads, 6 operators, 5 ways to
	/// expand a word and both variable states (rows that are an expansion error in Bash are left out, and `$'...'`
	/// offsets of a double-quoted `${x:offset:length}` that Bash's parser
	/// translates and this shell does not). A scan built on
	/// guessed rules missed `${x^'$(...)'}`-style operators, backquotes inside
	/// `${...}`, `$((` disambiguation and here-document quoting.
	bash_reads_command_text_where_its_extraction_does;

	/// The rows of the review that found the scan's gaps, and the other places
	/// Bash parses text at expansion: a compound array assignment, in an
	/// assignment statement or a declaration builtin's argument (but not before
	/// a command name, and not `a[0]=x`); `case`, `[[ ]]` and `(( ))` operands
	/// it evaluates; `for` words; a redirection target.
	bash_reads_command_text_at_these_expansions;

	/// Bash expands every word of a simple command, then its assignment values,
	/// before it performs a redirection, and an expansion error ends the
	/// command there: nothing after it is expanded, so no later `$(...)` or
	/// `${v:=...}` runs, while one before it has. A process substitution before
	/// it has run too. With no command name the assignments take effect and the
	/// failed redirection gives status 1; a word that holds a `$(...)` forgets
	/// the reported job. The redirection failed first, then every later word was
	/// expanded whatever failed, so `</missing : ${u:?oops} ${v:=$(echo touched >
	/// m)}` wrote `m`. Each command runs in a subshell, which the error ends.
	a_failed_redirect_expands_no_further_than_bash_does;

	/// A pipeline whose two stages each stopped, by SIGSTOP or SIGTSTP. `fg`,
	/// `bg` and `kill -CONT %1` continue every stage, as Bash's `killpg` does,
	/// so the job ends with its last stage's 7; `wait %1` returns at once with
	/// 128 plus the first stage's stop signal, and `jobs -s` lists the job.
	/// Only the stored leader was continued, so `fg` waited for ever on the
	/// other stage; and SIGTSTP stopped nothing, as each stage led an orphaned
	/// process group in a session of its own.
	fg_bg_and_kill_continue_every_stopped_stage;

	/// Without job control `fg` and `bg` refuse at once (`no job control`, status
	/// 1), and the job runs on with its status intact; a job started before
	/// `set -m` is refused too (`started without job control`). With job
	/// control they take no option: `-x` is an invalid option (status 2), `--`
	/// ends the options, `fg` uses only its first operand, `bg` resumes each
	/// operand and fails for one that names no job. `fg` and `bg` acted on the
	/// job without job control.
	fg_and_bg_follow_bash_job_control_rules;

	/// `wait` on a stopped job returns 128 plus the stop value of the status of
	/// its first process: the signal while it is stopped, its exit status once it
	/// exited, 0 when a signal killed it. On a pid, a value above 256 becomes 127
	/// (`wait.def`); on a job spec every builtin status above 256 maps as Bash's
	/// `builtin_status` does (257 and 258 to 2, the rest to 1), and 256 itself is
	/// `$?`. `wait -n` on a stopped job finds nothing to wait for (127). A
	/// stopped job's status saturated at 255, and SIGTSTP and SIGTTIN stopped
	/// nothing.
	wait_on_a_stopped_job_uses_bash_status_arithmetic;

	/// With job control, `kill -CONT %1` marks a stopped job running at once, and
	/// `kill %1` on a stopped job follows SIGTERM with SIGCONT, so the job's TERM
	/// trap runs (Bash's `kill_pid`). The job stayed stopped in the table until
	/// the next look, and a trapping stopped job never acted on the TERM.
	kill_continues_a_stopped_job_as_bash_does;

	/// A foreground pipeline that stops returns what Bash's `wait_for` returns
	/// for a stopped job: 128 plus the `WSTOPSIG` value of its first process's
	/// status, which is the signal that stopped it, or its exit status once it
	/// has exited, 0 when a signal killed it, and a builtin's status, which Bash
	/// runs in a child. It can pass 255 (`exit 200` gives 328), and `PIPESTATUS`
	/// keeps its value, since Bash sets it only for a job that ended. `return`
	/// passes the status through `builtin_status`, which keeps 256 and makes 328
	/// a 1, and a process exit keeps its low 8 bits. A script prints no
	/// `Stopped` line; `jobs` lists the job. The status was 128 plus the stop
	/// signal of the stage that stopped, `PIPESTATUS` held every stage, and the
	/// shell printed the job. (A first stage that still runs when a later one
	/// stops is left out: Bash waits for it to end, which hangs when it blocks
	/// on a stopped reader, so this shell gives such a stage only a short
	/// grace. Each row here stops after its first stage has ended.)
	a_stopped_foreground_job_returns_what_bash_wait_for_returns;

	/// `wait -p` names the pid Bash waits for: the last process of a pipeline
	/// (`find_last_pid`), as `$!` does, also for a job that stopped. It named
	/// the first.
	wait_p_names_the_last_process_of_a_pipeline;

	/// `fg`, `bg` and `kill -CONT %1` continue every process group the job's
	/// stages had when they started, as Bash's `killpg` on the job's group
	/// does, also the group of a stage that has exited, which still holds that
	/// stage's stopped child, and for a pipeline that stopped in the
	/// foreground as for one started in the background. Only `bg` and `fg` on
	/// a background job reached that group: a foreground pipeline became a job
	/// after its ended stage was reaped, so the job never knew the group, and
	/// `kill -CONT` signalled the groups of the stages still tracked.
	continuing_a_job_reaches_the_group_of_a_stage_that_exited;

	/// A foreground pipeline whose stage still runs when another stops counts
	/// as stopped here after a short grace (Bash waits for the stage instead),
	/// and the job then stays stopped, as a stopped Bash job does while one of
	/// its processes is stopped (`set_job_status_and_cleanup`), until `bg`,
	/// `fg` or `kill -CONT` continues it and the wait gets the last stage's
	/// status. The job ran again as soon as it was looked at, since a stage
	/// still ran, so `bg` reported it already in the background and `fg`
	/// returned the stopped status.
	a_pipeline_stopped_while_a_stage_ran_resumes_as_bash_does;

	/// In a double-quoted `${x:-word}` Bash's parser translates a `$'...'` of
	/// the word's own to its value as it is (`parse_matched_pair`), and the
	/// expansion reads that value; one inside a single-quoted or double-quoted
	/// string of the word stays as written, and its backslash goes with the
	/// double quotes. One inside a nested double-quoted string was translated,
	/// so `\x24(...)` became a command that ran, and one after a single quote
	/// was translated.
	a_double_quoted_operand_translates_only_its_own_ansi_c_strings;

	/// In a here-document Bash translates each `$'...'` of a `%`, `#`, `/`,
	/// `^`, `,` or `:` operand as it extracts it, single-quoted at the
	/// operand's own level and as it is in a nested `${...}`
	/// (`extract_heredoc_dolbrace_string`), and then expands the operand when
	/// the variable is set, reading a `$(...)` the translation produced even
	/// where the nested expansion does not use it. The scan saw only the text
	/// as written, so the reported job stayed.
	a_here_document_operand_is_read_as_bash_translates_it;

	/// Bash extracts a double-quoted `${x OP word}` again from the text its
	/// parser left, with each `$'...'` translated, whatever `x` holds: a value
	/// that leaves a quote open (`\"`, `\'`, `\\`) or holds a NUL, which ends
	/// the parser's text, leaves the expansion without its closing `}`, a `bad
	/// substitution` that ends the subshell with status 1. The value went in
	/// as text, and the command printed it.
	a_translation_that_leaves_the_expansion_open_is_a_bad_substitution;

	/// `kill` signals a job as Bash's `kill_pid` does (`jobs.c:3670-3741`),
	/// shown on a pipeline whose two stages both stopped. A job started with
	/// job control is signalled through its process group, whichever of its
	/// processes a negative pid names, and here that is every group its stages
	/// had; a stopped one gets SIGCONT after SIGTERM or SIGHUP, to the same
	/// targets, and SIGCONT makes it run. A pid gets the signal alone, with no
	/// SIGCONT and no change to the job. A job started without job control gets
	/// the signal in each live process by pid and is never continued. The
	/// SIGCONT after SIGTERM to one stage's group went to every group, so the
	/// other stage ran instead of ending.
	kill_signals_a_stopped_pipeline_as_bash_kill_pid_does;

	/// Without job control `kill %1` signals each live process of the job by
	/// pid, as Bash's `kill_pid` does for a job in the shell's own process
	/// group: a child of the job's process, in that process's group, gets
	/// nothing. With job control the job's group gets it, child included; a pid
	/// reaches that process alone either way. The child got the signal without
	/// job control too.
	kill_without_job_control_signals_each_process_by_pid;

	/// `fg` on a job that stops again returns the stopped status and, in a
	/// script, prints nothing for it, as Bash's `notify_of_job_status` prints a
	/// stopped job only in an interactive shell. `fg` printed the job's
	/// `Stopped` line.
	fg_prints_nothing_for_a_job_that_stops_again_in_a_script;

	/// Generated sequences of three jobs (a single process, one started through
	/// `env`, a two-stage pipeline) that start, stop, continue (by pid or `bg`)
	/// and end in random orders, with and without `set -m`: after each step the
	/// script prints which job each of `%%`, `%+`, `%-`, `%1` to `%3`, `%name`
	/// and `%?text` names (or `none`, or `amb` for an ambiguous one), and at the
	/// end it shows which job `kill -TERM %-` reaches.
	///
	/// The current and previous jobs follow Bash's `set_current_job` and
	/// `reset_current`: a job that starts in the background resets them, so a
	/// stopped job stays current; a job that stops becomes current; one that
	/// leaves the table, or that `bg` continues, has them chosen again; and
	/// `%-` is the current job when no other qualifies. `%name` and `%?text`
	/// match each process's own text, ignoring case for `%?`, and two matches
	/// are ambiguous. Before this round the newest job was always current and
	/// the one before it previous, `%-` named nothing for a single job, and a
	/// pipeline's later stages matched no `%name`; and a stopped process that
	/// had been continued and had exited kept its job stopped, so `wait PID`
	/// returned 147 at once.
	job_specs_name_the_jobs_bash_names;

	/// A stopped process that `kill -CONT PID` continued and that has since
	/// exited no longer holds its job stopped, as Bash's `waitchld` sees the exit
	/// at once: `wait` returns its status. The kernel reports no continue for a
	/// process that has exited, so its job stayed stopped and `wait` returned
	/// 147 at once.
	a_continued_stop_that_ended_lets_wait_return_the_exit_status;

	/// A generated differential net over simple commands: prefix assignments,
	/// command words (external, function, special builtin, a name made by a
	/// substitution, word arguments, declaration builtins, also through
	/// `command` and `builtin`), redirections that work and that fail, with
	/// and without an expansion in their target, one that reads the prefix
	/// variables, before and after the command word, process substitutions,
	/// `set -u`, expansion errors, readonly variables and POSIX mode; prefix
	/// assignments that build on the variable (`+=` on a string, an integer, an
	/// upper-case, an unset and a local variable, and on a value an earlier
	/// prefix assignment set); and a command name that expands to nothing.
	/// Every expansion appends a distinct tag to
	/// a file, so each row records what ran, how many times and in what order,
	/// with the final variable values, the exit status and the files made.
	///
	/// Bash expands the command words first, then each prefix assignment in
	/// turn, expanding and assigning it once, into the command's temporary
	/// environment or, with no command name, into the shell; only then does it
	/// perform the redirections, which do not see the temporary environment
	/// (`expand_word_list_internal`, `do_assignment_statements`). An assignment
	/// word is an assignment argument only after a declaration builtin named
	/// as written, past `command` words in POSIX mode (`fix_assignment_words`).
	/// In POSIX mode the assignments before a special builtin stay, and its
	/// failed redirection ends the shell; an assignment to a readonly variable
	/// there ends the shell before a special builtin and abandons the command
	/// before any other. A `+=` prefix assignment gives the command the
	/// variable's value with the word appended as an assignment to the variable
	/// appends it (`assign_in_env`, `make_variable_value`).
	simple_commands_expand_assign_and_redirect_in_bash_order;

	/// An assignment to a readonly variable through every entry point Bash has
	/// (a statement, `+=`, an element, a key, a list, a prefix before an
	/// external command, a function or a special builtin, `export`, `declare`,
	/// `readonly`, `local`, `read`, `printf -v`, `let`, `(( ))`, `for`,
	/// `${x:=v}`, `unset`), on a scalar, an indexed, an associative and an
	/// unset variable, at top level, after `||`, in a function, a nested
	/// function, a subshell, a subshell with `set -e`, `eval`, `if eval`,
	/// `command eval` and a command substitution, with and without `set -e`
	/// and POSIX mode; then `set -e` across functions, subshells, `eval`,
	/// `command` and an ERR trap, assignments in ERR and DEBUG trap handlers,
	/// and POSIX mode's fatal errors. `bash -c` exits 127 where POSIX mode or
	/// a failed expansion forces the shell's input to end.
	///
	/// As in Bash, a readonly variable is reported, which exits the shell at
	/// once under `set -e` (`report_error`), unless an `eval`, `source` or
	/// `command` run where a failure is tested turned errexit off; then the
	/// failure jumps as Bash's `do_assignment_statements`, `assign_in_env`,
	/// `parameter_brace_expand_rhs` and `execute_for_command` jump. An element
	/// of a readonly array is readonly too. Before this round `set -e` let the
	/// jump abandon the command instead of exiting, the element assignment
	/// succeeded, and an ERR or DEBUG handler's exit was dropped.
	readonly_assignments_fail_and_jump_as_bash_does;

	/// A failed assignment abandons the command being run, as Bash's
	/// `jump_to_top_level (DISCARD)` in `do_assignment_statements` does: every
	/// enclosing command ends, the callers of a function and the rest of its
	/// input line included, and the text it was read from goes on with its
	/// next line, status 1. That is so for a prefix assignment to a readonly
	/// variable in POSIX mode, before a command that is not a special builtin,
	/// and for an assignment statement to one in any mode. `eval`, `source` and
	/// a trap handler read text of their own, so their caller goes on; a
	/// subshell, a command substitution, a pipeline stage and a background job
	/// end with status 1. A POSIX-mode shell exits instead before a special
	/// builtin, and for an assignment statement unless it runs under `command`.
	/// Each script's first line runs with its standard error discarded. The
	/// error ended only the function it was in, and the caller ran on; and the
	/// trap rows passed without their handler running, since this shell refuses
	/// to signal itself.
	a_failed_assignment_abandons_the_command_as_bash_does;

	/// Each stage of a pipeline of two or more runs in a subshell, the last one
	/// too unless `lastpipe` runs it in the shell: `exit`, `return`, `break`,
	/// `continue` and an abandoned command there end that subshell alone. The
	/// last stage's request reached the shell.
	control_flow_in_a_pipeline_stage_ends_only_that_stage;

	/// The round-10 review's rows on a failed assignment's DISCARD: a prefix
	/// assignment to a readonly variable in POSIX mode, or an assignment
	/// statement to one, after `&&` and `||`, in `for`, `until` and `case`
	/// bodies, a brace group, nested functions, `eval` and `command eval`, a
	/// sourced file, a trap handler and a background job, before a function, and
	/// with a second assignment after it.
	adversarial_discard_propagation;

	/// The round-10 review's rows on control flow in a pipeline stage:
	/// `break`, `break 2`, `continue`, `return` and `exit` in the first and the
	/// last stage, with and without `lastpipe`, and a failed readonly
	/// assignment in a stage.
	adversarial_pipeline_control_flow;

	/// The round-10 review's rows on `kill` reaching a job started under one
	/// `set -m` setting and signalled under another: Bash's `IS_JOBCONTROL` is
	/// set from how the job was started, not the current `set -m`.
	kill_mixed_job_control_settings;

	/// An expansion error in a here-document (`${x:bad+}`, `${bad!}`,
	/// `${x:1/0}`, `${missing:?...}`, and `${missing}` under `set -u`) in a
	/// subshell, plain, with `set -e`, `set -u` or POSIX mode. Before a
	/// command Bash forks for (an external command, `command cat`, a name not
	/// found) it fails only that command, status 1, and the subshell goes on
	/// unless `set -e` ends it; before a builtin, a function or `exec` it ends
	/// the subshell with status 1, as Bash's `expand_string` jumps to the top
	/// level of the shell that expands it. Bash 5.3.20 also goes on after an
	/// assignment-only command (`v=1 <<E`), which Bash 5.2.21 ends. The rows
	/// are the ANSI slice's matrix of the #17712 port.
	an_expansion_error_in_a_here_document_ends_what_bash_ends;

	/// `builtin`, `command` and chains of them (`command builtin`, `builtin
	/// command`, `builtin builtin command`, ...) before `:`, `export`,
	/// `readonly`, `eval` and `printf -v`, in POSIX mode and under `set -e`.
	/// A prefix assignment before a wrapped `:` does not persist, while a
	/// wrapped `export` or `readonly` still exports or marks the variable the
	/// prefix assigned; a readonly error in a wrapped `export` is status 1.
	/// A readonly error in a wrapped `eval` exits the POSIX shell (127 under
	/// `bash -c`) only when no `command` wraps it; a `printf -v` to a readonly
	/// variable in an `if` test exits the `set -e` shell with 1 when `builtin`
	/// is the outermost wrapper and is a plain false when `command` is. The
	/// rows are the readonly slice's wrapper probe of the #17712 port.
	a_wrapped_special_builtin_is_no_special_builtin;

	/// An arithmetic error in an assignment (a subscript `a[1/0]`, an integer
	/// variable's `x=1/0`, a readonly variable in a subscript `a[x++]`) ends
	/// the `bash -c` shell with status 1, in POSIX mode too, also from inside
	/// `eval`, a sourced file, and a function tested by `if` under `set -e`
	/// whose earlier status was 7. In an EXIT trap it ends the trap and the
	/// shell keeps the status `exit` gave; the EXIT trap of a shell the error
	/// ended runs at top level, with no function and none of its locals. An
	/// invalid nameref target in `for` is no such error: the loop fails with
	/// status 1 and the function and its caller go on. The rows are the
	/// readonly slice's error-context probe of the #17712 port.
	an_arithmetic_error_in_an_assignment_ends_the_shell;
}
