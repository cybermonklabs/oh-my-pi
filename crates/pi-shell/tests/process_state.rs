//! What the shell answers about its children, derived from the processes
//! themselves when it is asked, through `pi_shell::Shell::run`: the status
//! `wait` returns for its operands, which job or stage a published pid
//! (`$!`, `jobs -p`, `jobs -l`) names for `wait`, `kill` and `disown`,
//! whether that process still lives, its signal disposition, and that a
//! line is read without waiting for an exited program's output to drain.
//!
//! Each row's expected output is Bash 5.3.20 running the script as
//! `bash -c` (`bash_oracle` has the oracle rule and
//! `PI_SHELL_BASH_ORACLE`); the rows are in `fixtures/process_state.json`.
//! Real processes are observed through `/proc` state (an exited process is
//! a zombie, `Z`, or gone), never through the existence of the pid alone.
#![cfg(target_os = "linux")]

mod bash_oracle;

use bash_oracle::{assert_rows, rows};

const FIXTURE: &str = "process_state.json";

/// `wait a b …` with every mix of a live job, a job that ended and is
/// still listed, a forgotten job (its kept status) and a pid that is no
/// child, in every order: the status is the last operand's, whichever of
/// the earlier ones ends last. Fails if a deferred wait for an earlier
/// operand overwrites it.
#[tokio::test(flavor = "multi_thread")]
async fn wait_returns_the_last_operands_status() {
	assert_rows(rows(FIXTURE, "wait_operands"), 16).await;
}

/// The pid of each stage of a background pipeline (`jobs -p` the first,
/// `$!` the last) and of a lone job, running, exited (a zombie or reaped)
/// and forgotten, for `wait`, `kill -TERM`, `kill -0`, `disown` then
/// `kill`, `disown` then `wait`, and `jobs -l` after `kill -KILL`, with
/// and without `pipefail`: `wait` of a stage waits for its job, `kill`
/// reaches the real process even after `disown`, and an exited process is
/// gone for `kill`. Fails if a published pid resolves to nothing, to a
/// virtual stand-in, or to a process that has exited.
#[tokio::test(flavor = "multi_thread")]
async fn published_pids_resolve_to_their_processes() {
	assert_rows(rows(FIXTURE, "published_pids"), 16).await;
}

/// `SIGINT` and `SIGQUIT` to a background job without job control: a
/// program starts with both ignored and may restore them (`perl`
/// resetting a handler), and both the `kill` builtin and `/bin/kill` reach
/// it, alone or as a pipeline's last stage, with and without `set -m`; the
/// shell code of a job ignores them until its own `trap` resets or
/// catches `SIGINT` (`SIGQUIT` stays ignored for shell code). Fails if the
/// shell swallows a signal a program restored, or ignores one a reset
/// re-enabled.
#[tokio::test(flavor = "multi_thread")]
async fn async_jobs_hold_their_own_signal_disposition() {
	assert_rows(rows(FIXTURE, "async_signal_disposition"), 16).await;
}

/// A program that exits (or is killed) while a descendant still holds its
/// output, as a pipeline's first or last stage or a lone job, with the
/// next command on the same line or the next one: the line is read, `kill
/// -0` finds the program gone, `jobs -l` lists the job, and a second
/// stage that exits while the first one's output is still held changes
/// nothing. Fails if a line read or a builtin waits for the output to
/// drain (the run then times out).
#[tokio::test(flavor = "multi_thread")]
async fn an_exited_program_whose_output_is_held_does_not_hold_the_shell() {
	assert_rows(rows(FIXTURE, "relay_holders"), 16).await;
}
