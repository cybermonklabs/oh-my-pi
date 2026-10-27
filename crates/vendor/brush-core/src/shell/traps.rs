//! Trap handling for the shell.

use crate::{
	ExecutionControlFlow, ExecutionExitCode, ExecutionParameters, ExecutionResult,
	ProcessGroupPolicy, error, traps::TrapSignal,
};

impl<SE: crate::extensions::ShellExtensions> crate::Shell<SE> {
	/// Runs any exit steps for the shell.
	///
	/// This currently includes invoking the `EXIT` trap handler, if any.
	pub async fn on_exit(&mut self) -> Result<(), error::Error> {
		if self.traps.has_own_exit_handler() {
			self
				.invoke_trap_handler(TrapSignal::Exit, &self.default_exec_params())
				.await?;
		}

		Ok(())
	}

	/// Ends a child context (subshell, command substitution, pipeline stage,
	/// background job, coprocess or process substitution) that ran in a shell
	/// from [`Shell::clone_for_subshell`], and returns the result the parent sees.
	///
	/// The context's own `EXIT` trap runs with the execution parameters of that
	/// context, so it writes where the context's own commands write, and sees the
	/// status the context ended with in `$?`. An `EXIT` trap inherited from the
	/// parent shell does not run; the parent runs it when the parent ends. As in
	/// bash, a trap that itself calls `exit` replaces the context's status.
	///
	/// Only the context's exit code reaches the parent: its own `exit`, `return`,
	/// `break` or `continue` ends just that context, and a fatal error in it is
	/// displayed and becomes its exit code instead of ending the parent.
	pub(crate) async fn end_child_context(
		&mut self,
		params: &ExecutionParameters,
		result: Result<ExecutionResult, error::Error>,
	) -> ExecutionResult {
		// A cancelled run is already being torn down: report its status without
		// printing the interruption again or starting a trap.
		if params.is_cancelled() {
			return ExecutionResult::from(match result {
				Ok(result) => result.exit_code,
				Err(error) => ExecutionExitCode::from(&error),
			});
		}
		let result = match result {
			Ok(result) => ExecutionResult::from(result.exit_code),
			Err(error) => {
				let mut stderr = params.stderr(self);
				let _ = self.display_error(&mut stderr, &error).await;
				ExecutionResult::from(error.into_result(self).exit_code)
			},
		};
		if !self.traps.has_own_exit_handler() {
			return result;
		}

		self.set_last_exit_status(result.exit_code.into());

		match self.invoke_trap_handler(TrapSignal::Exit, params).await {
			Ok(trap_result)
				if matches!(trap_result.next_control_flow, ExecutionControlFlow::ExitShell) =>
			{
				ExecutionResult::from(trap_result.exit_code)
			},
			_ => result,
		}
	}

	/// Invokes the handler registered for `signal`, if any.
	///
	/// Behavior varies by signal type:
	///
	/// * **Per-signal recursion guard** — each trap guards against its own
	///   self-recursion, but different traps *can* fire from within each other's
	///   handlers (matching bash semantics).
	///
	/// * **Inheritance** — in functions and subshells, some traps are only
	///   inherited when the corresponding shell option is enabled (e.g.
	///   `errtrace` / `set -E` for `ERR`, `functrace` / `set -T` for
	///   `DEBUG`/`RETURN`).
	///
	/// * **`$?` preservation** — `last_exit_status` is saved before and restored
	///   after the handler runs so the trap does not clobber the status that
	///   triggered it.
	///
	/// # Arguments
	///
	/// * `signal`: Signal to run handler for.
	///
	/// * `params`: Execution parameters to use for handler.
	pub(crate) async fn invoke_trap_handler(
		&mut self,
		signal: TrapSignal,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		// Per-signal self-recursion guard: don't re-enter a trap that is
		// already being handled. Different traps *can* fire from each
		// other's handlers (e.g. ERR inside EXIT, EXIT inside ERR).
		if self.call_stack().is_trap_signal_active(signal) {
			return Ok(ExecutionResult::success());
		}

		// Don't fire traps that have been explicitly suppressed (e.g. DEBUG
		// during programmable completion).
		if self.call_stack().is_trap_delivery_suppressed() {
			return Ok(ExecutionResult::success());
		}

		// In functions and subshells, some traps are only inherited when the
		// corresponding option is enabled.
		if (self.in_function() || self.is_subshell())
			&& !self.is_trap_inherited_in_current_scope(signal)
		{
			return Ok(ExecutionResult::success());
		}

		let Some(handler) = self.traps.get_handler(signal).cloned() else {
			return Ok(ExecutionResult::success());
		};

		let mut params = params.clone();
		params.process_group_policy = ProcessGroupPolicy::SameProcessGroup;

		// Preserve $? across trap handler execution so the handler doesn't
		// clobber the status that triggered it.
		let orig_last_exit_status = self.last_exit_status;

		// N.B. We use manual enter/leave rather than an RAII guard because a guard
		// would need to hold `&mut Shell`, preventing the mutable borrow required by
		// `run_string()`. This is safe because `result` is captured into a variable
		// (never early-returned with `?`), so `leave_trap_handler()` always runs.
		self.enter_trap_handler(signal, Some(&handler));

		let result = self
			.run_string(&handler.command, &handler.source_info, &params)
			.await;

		self.leave_trap_handler();
		self.last_exit_status = orig_last_exit_status;

		result
	}

	/// Returns whether the given trap signal is inherited in the current
	/// function or subshell scope.
	fn is_trap_inherited_in_current_scope(&self, signal: TrapSignal) -> bool {
		match signal {
			TrapSignal::Err => self.options().shell_functions_inherit_err_trap,
			TrapSignal::Debug | TrapSignal::Return => {
				self
					.options()
					.shell_functions_inherit_debug_and_return_traps
			},
			// EXIT and system signals are always inherited — i.e. their visibility is
			// not gated by errtrace/functrace options. (The actual trap *state* for
			// subshells is managed separately via `Shell::clone_for_subshell`.)
			TrapSignal::Exit | TrapSignal::Signal(_) => true,
		}
	}
}

/// Regression tests: a child context (subshell, command substitution, pipeline
/// stage, background job, coprocess, process substitution) runs the EXIT trap it
/// set itself when it ends, and never the one it inherited from its parent.
///
/// brush-core ships no builtins, so the tests register three of their own:
/// `settrap CMD` (sets this shell's EXIT trap, as `trap CMD EXIT`), `say ARGS`
/// (as `echo`), and `exitnow` (as `exit 3`).
#[cfg(all(test, unix))]
mod tests {
	use std::{io::Write as _, path::Path};

	use clap::Parser;

	use crate::{
		ExecutionControlFlow, ExecutionResult, Shell, SourceInfo, ShellValue, ShellVariable,
		builtins, extensions::DefaultShellExtensions, traps::{TrapHandlerConfig, TrapSignal},
	};

	type Se = DefaultShellExtensions;

	#[derive(Parser)]
	struct SetTrap {
		handler: String,
	}

	impl builtins::Command for SetTrap {
		type Error = crate::Error;

		async fn execute<SE: crate::ShellExtensions>(
			&self,
			context: crate::ExecutionContext<'_, SE>,
		) -> Result<ExecutionResult, Self::Error> {
			context.shell.traps_mut().register_handler(
				TrapSignal::Exit,
				self.handler.clone(),
				SourceInfo::default(),
			);
			Ok(ExecutionResult::success())
		}
	}

	#[derive(Parser)]
	struct Say {
		words: Vec<String>,
	}

	impl builtins::Command for Say {
		type Error = crate::Error;

		async fn execute<SE: crate::ShellExtensions>(
			&self,
			context: crate::ExecutionContext<'_, SE>,
		) -> Result<ExecutionResult, Self::Error> {
			let _ = writeln!(context.stdout(), "{}", self.words.join(" "));
			Ok(ExecutionResult::success())
		}
	}

	#[derive(Parser)]
	struct ExitNow {}

	impl builtins::Command for ExitNow {
		type Error = crate::Error;

		async fn execute<SE: crate::ShellExtensions>(
			&self,
			_context: crate::ExecutionContext<'_, SE>,
		) -> Result<ExecutionResult, Self::Error> {
			Ok(ExecutionResult {
				next_control_flow: ExecutionControlFlow::ExitShell,
				..ExecutionResult::new(3)
			})
		}
	}

	async fn new_shell(log: &Path, errexit: bool) -> Shell<Se> {
		let mut shell = Shell::builder()
			.builtin("settrap", builtins::builtin::<SetTrap, Se>())
			.builtin("say", builtins::builtin::<Say, Se>())
			.builtin("exitnow", builtins::builtin::<ExitNow, Se>())
			.build()
			.await
			.expect("shell");
		shell
			.env_mut()
			.set_global("LOG", ShellVariable::new(ShellValue::String(log.display().to_string())))
			.expect("LOG");
		shell.options_mut().exit_on_nonzero_command_exit = errexit;
		shell
	}

	/// Runs `script`, waits for its background jobs, then ends the top-level shell
	/// the way `bash -c` would, and returns the lines the script appended to the
	/// log.
	async fn run(script: &str, errexit: bool) -> String {
		let dir = tempfile::tempdir().expect("tempdir");
		let log = dir.path().join("log");
		let mut shell = new_shell(&log, errexit).await;
		let params = shell.default_exec_params();
		shell
			.run_string(script, &SourceInfo::default(), &params)
			.await
			.expect("script");
		// Joining only lets background jobs finish; the log is what is asserted.
		let _ = shell.jobs_mut().wait_all().await;
		let _ = shell.on_exit().await;
		std::fs::read_to_string(&log).unwrap_or_default()
	}

	#[tokio::test]
	async fn subshell_runs_its_own_exit_trap_at_normal_end() {
		let log = run(
			r#"( settrap 'say sub-exit >> "$LOG"'; say body >> "$LOG" ); say after >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "body\nsub-exit\nafter\n");
	}

	#[tokio::test]
	async fn subshell_runs_its_own_exit_trap_after_exit() {
		let log = run(
			r#"( settrap 'say sub-exit >> "$LOG"'; exitnow; say unreachable >> "$LOG" ); say after >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "sub-exit\nafter\n");
	}

	#[tokio::test]
	async fn subshell_runs_its_own_exit_trap_after_errexit() {
		let log = run(
			r#"( settrap 'say sub-exit >> "$LOG"'; false; say unreachable >> "$LOG" ); say after >> "$LOG""#,
			true,
		)
		.await;
		// The failed subshell also stops the errexit parent, as in bash.
		assert_eq!(log, "sub-exit\n");
	}

	#[tokio::test]
	async fn subshell_exit_trap_writes_where_the_subshell_writes() {
		let log = run(
			r#"( settrap 'say sub-exit'; say body ) >> "$LOG"; say after >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "body\nsub-exit\nafter\n");
	}

	#[tokio::test]
	async fn subshell_does_not_run_the_exit_trap_it_inherited() {
		let log = run(
			r#"settrap 'say parent-exit >> "$LOG"'; ( say sub >> "$LOG" ); say after >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "sub\nafter\nparent-exit\n");
	}

	#[tokio::test]
	async fn subshell_runs_its_own_exit_trap_not_the_inherited_one() {
		let log = run(
			r#"settrap 'say parent-exit >> "$LOG"'; ( settrap 'say sub-exit >> "$LOG"'; say sub >> "$LOG" ); say after >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "sub\nsub-exit\nafter\nparent-exit\n");
	}

	#[tokio::test]
	async fn nested_subshell_runs_each_exit_trap_once() {
		let log = run(
			r#"( settrap 'say outer-exit >> "$LOG"'; ( settrap 'say inner-exit >> "$LOG"'; say inner >> "$LOG" ); say outer >> "$LOG" ); say after >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "inner\ninner-exit\nouter\nouter-exit\nafter\n");
	}

	#[tokio::test]
	async fn command_substitution_runs_its_own_exit_trap() {
		let log = run(
			r#"x=$(settrap 'say sub-exit'; say inside); say "$x" >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "inside\nsub-exit\n");
	}

	#[tokio::test]
	async fn command_substitution_does_not_run_the_exit_trap_it_inherited() {
		let log = run(
			r#"settrap 'say parent-exit >> "$LOG"'; x=$(say inside); say "$x" >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "inside\nparent-exit\n");
	}

	#[tokio::test]
	async fn pipeline_group_stage_runs_its_own_exit_trap() {
		let log = run(
			r#"{ settrap 'say stage-exit >> "$LOG"'; say stage >> "$LOG"; } | /bin/cat; say after >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "stage\nstage-exit\nafter\n");
	}

	#[tokio::test]
	async fn pipeline_function_stage_runs_its_own_exit_trap() {
		let log = run(
			r#"f() { settrap 'say fn-exit >> "$LOG"'; say fn >> "$LOG"; }; f | /bin/cat; say after >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "fn\nfn-exit\nafter\n");
	}

	#[tokio::test]
	async fn pipeline_builtin_stage_runs_its_own_exit_trap() {
		let log = run(
			r#"settrap 'say builtin-exit >> "$LOG"' | /bin/cat; say after >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "builtin-exit\nafter\n");
	}

	#[tokio::test]
	async fn pipeline_stage_does_not_run_the_exit_trap_it_inherited() {
		let log = run(
			r#"settrap 'say parent-exit >> "$LOG"'; { say stage; } | /bin/cat >> "$LOG"; say after >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "stage\nafter\nparent-exit\n");
	}

	#[tokio::test]
	async fn background_job_runs_its_own_exit_trap() {
		let log = run(r#"{ settrap 'say bg-exit >> "$LOG"'; say bg >> "$LOG"; } &"#, false).await;
		assert_eq!(log, "bg\nbg-exit\n");
	}

	#[tokio::test]
	async fn background_subshell_runs_its_own_exit_trap_once() {
		let log = run(r#"( settrap 'say bg-exit >> "$LOG"'; say bg >> "$LOG" ) &"#, false).await;
		assert_eq!(log, "bg\nbg-exit\n");
	}

	#[tokio::test]
	async fn background_job_does_not_run_the_exit_trap_it_inherited() {
		let log = run(
			r#"settrap 'say parent-exit >> "$LOG"'; { say bg >> "$LOG"; } &"#,
			false,
		)
		.await;
		assert_eq!(log, "bg\nparent-exit\n");
	}

	#[tokio::test]
	async fn process_substitution_runs_its_own_exit_trap() {
		let log = run(
			r#"/bin/cat <(settrap 'say ps-exit'; say inside) >> "$LOG"; say after >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "inside\nps-exit\nafter\n");
	}

	#[tokio::test]
	async fn coprocess_runs_its_own_exit_trap() {
		let log = run(
			r#"coproc CP { settrap 'say co-exit'; say co; }; /bin/cat <&"${CP[0]}" >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "co\nco-exit\n");
	}

	#[tokio::test]
	async fn exit_in_a_last_stage_exit_trap_does_not_end_the_parent() {
		let log = run(r#"say a | { settrap 'exitnow'; }; say "after st=$?" >> "$LOG""#, false).await;
		assert_eq!(log, "after st=3\n");
	}

	#[tokio::test]
	async fn exit_in_a_last_stage_function_exit_trap_does_not_end_the_parent() {
		let log = run(
			r#"f() { settrap 'exitnow'; }; say a | f; say "after st=$?" >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "after st=3\n");
	}

	#[tokio::test]
	async fn exit_in_a_last_stage_builtin_exit_trap_does_not_end_the_parent() {
		let log = run(r#"say a | settrap 'exitnow'; say "after st=$?" >> "$LOG""#, false).await;
		assert_eq!(log, "after st=3\n");
	}

	#[tokio::test]
	async fn exit_in_a_last_stage_body_does_not_end_the_parent() {
		let log = run(r#"say a | { exitnow; }; say "after st=$?" >> "$LOG""#, false).await;
		assert_eq!(log, "after st=3\n");
	}

	#[tokio::test]
	async fn exit_trap_sees_the_status_a_pipeline_stage_failed_with() {
		let log = run(
			r#"{ settrap 'say in-trap=$? >> "$LOG"'; : ${unset_var?unset}; } 2>/dev/null | /bin/cat; say after >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "in-trap=1\nafter\n");
	}

	#[tokio::test]
	async fn fatal_error_in_a_pipeline_stage_does_not_end_the_parent() {
		let log = run(
			r#"{ : ${unset_var?unset}; } 2>/dev/null | /bin/cat; say after >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "after\n");
	}

	#[tokio::test]
	async fn failed_redirect_on_a_pipeline_stage_does_not_end_the_parent() {
		let log = run(
			r#"{ say hi; } > /nonexistent/x 2>/dev/null | /bin/cat; say "after st=$?" >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "after st=0\n");
	}

	#[tokio::test]
	async fn failed_redirect_on_a_compound_stage_with_redirect_does_not_end_the_parent() {
		let log = run(
			r#"say hi | { /bin/cat; } < /nonexistent 2>/dev/null; say after >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "after\n");
	}

	#[tokio::test]
	async fn failed_input_substitution_does_not_end_the_parent() {
		let log = run(r#"x=$(< /nonexistent) 2>/dev/null; say "after [$x]" >> "$LOG""#, false).await;
		assert_eq!(log, "after []\n");
	}

	#[tokio::test]
	async fn failed_expansion_in_a_simple_command_stage_does_not_end_the_parent() {
		let log = run(
			r#"say hi | say ${unset_var?unset} 2>/dev/null; say after >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "after\n");
	}

	#[tokio::test]
	async fn exit_trap_sees_the_status_a_background_job_failed_with() {
		let log = run(
			r#"{ settrap 'say in-trap=$? >> "$LOG"'; : ${unset_var?unset}; } 2>/dev/null &"#,
			false,
		)
		.await;
		assert_eq!(log, "in-trap=1\n");
	}

	#[tokio::test]
	async fn exit_in_a_subshell_exit_trap_sets_the_subshell_status() {
		let log = run(r#"( settrap 'exitnow'; true ); say "st=$?" >> "$LOG""#, false).await;
		assert_eq!(log, "st=3\n");
	}

	#[tokio::test]
	async fn exit_in_a_command_substitution_exit_trap_sets_its_status() {
		let log = run(r#"x=$(settrap 'exitnow'; say hi); say "st=$?" >> "$LOG""#, false).await;
		assert_eq!(log, "st=3\n");
	}

	#[tokio::test]
	async fn fatal_error_in_a_subshell_exit_trap_keeps_the_subshell_status() {
		let log = run(
			r#"( settrap ': ${nope?boom}'; exitnow ) 2>/dev/null; say "st=$?" >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "st=3\n");
	}

	#[tokio::test]
	async fn fatal_error_in_a_command_substitution_exit_trap_keeps_its_status() {
		let log = run(
			r#"x=$(settrap ': ${nope?boom}'; exitnow) 2>/dev/null; say "st=$?" >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "st=3\n");
	}

	#[tokio::test]
	async fn fatal_error_in_an_exit_trap_ends_only_that_trap() {
		let log = run(
			r#"( settrap ': ${nope?boom}; say after-fatal >> "$LOG"'; exitnow ) 2>/dev/null; say "st=$?" >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "st=3\n");
	}

	#[tokio::test]
	async fn exit_in_an_exit_trap_ends_the_trap_with_that_status() {
		let log = run(
			r#"( settrap 'say first >> "$LOG"; exitnow; say unreachable >> "$LOG"'; /bin/false ); say "st=$?" >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "first\nst=3\n");
	}

	#[tokio::test]
	async fn fatal_error_in_a_function_run_by_an_exit_trap_keeps_the_status() {
		let log = run(
			r#"g() { : ${nope?boom}; say in-g >> "$LOG"; }; ( settrap g; exitnow ) 2>/dev/null; say "st=$?" >> "$LOG""#,
			false,
		)
		.await;
		assert_eq!(log, "st=3\n");
	}

	#[tokio::test]
	async fn exit_trap_sees_the_status_the_subshell_failed_with() {
		let log = run(
			r#"( settrap 'say in-trap=$? >> "$LOG"'; : ${unset_var?unset} ) 2>/dev/null"#,
			false,
		)
		.await;
		assert_eq!(log, "in-trap=1\n");
	}

	#[tokio::test]
	async fn pipeline_builtin_stage_exit_trap_sees_the_stage_status() {
		let log = run(
			r#"/bin/false; settrap 'say in-trap=$? >> "$LOG"' | /bin/cat"#,
			false,
		)
		.await;
		assert_eq!(log, "in-trap=0\n");
	}

	/// `Clone` and `lease` copy a shell faithfully: only a child context's clone marks
	/// the `EXIT` trap inherited, so a leased shell settled back keeps its own trap.
	#[tokio::test]
	async fn clone_and_lease_keep_the_shells_own_exit_trap() {
		let dir = tempfile::tempdir().expect("tempdir");
		let mut shell = new_shell(&dir.path().join("log"), false).await;
		shell
			.traps_mut()
			.register_handler(TrapSignal::Exit, "say x".to_owned(), SourceInfo::default());

		assert!(shell.clone().traps().has_own_exit_handler());
		assert!(shell.lease().traps().has_own_exit_handler());

		let subshell = shell.clone_for_subshell();
		assert!(subshell.traps().handles(TrapSignal::Exit), "`trap -p EXIT` must still show it");
		assert!(!subshell.traps().has_own_exit_handler());
		assert!(shell.traps().has_own_exit_handler(), "the parent keeps its own handler");
	}

	#[test]
	fn registering_or_removing_an_exit_handler_in_a_subshell_config() {
		let mut parent = TrapHandlerConfig::default();
		parent.register_handler(TrapSignal::Exit, "echo x".to_owned(), SourceInfo::default());

		let mut child = parent.clone();
		child.mark_exit_inherited();
		assert!(!child.has_own_exit_handler());

		child.register_handler(TrapSignal::Exit, "echo y".to_owned(), SourceInfo::default());
		assert!(child.has_own_exit_handler(), "a handler the subshell registers is its own");

		let mut cleared = parent.clone();
		cleared.mark_exit_inherited();
		cleared.remove_handlers(TrapSignal::Exit);
		assert!(!cleared.has_own_exit_handler());
		cleared.register_handler(TrapSignal::Exit, "echo z".to_owned(), SourceInfo::default());
		assert!(cleared.has_own_exit_handler());
	}
}
