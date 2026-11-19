//! Signal parsing and `kill` behavior at the virtual-process boundary.

use crate::{
	bash::{EngineConfig, ModeId, Platform, Script, ShellInit, SigSet, Signal},
	testkit::{FakeHost, Fault, Rig, run_script},
};

/// Run `src` as `zsh -c src` on a `platform` engine: stdout, stderr.
fn zsh_on(platform: Platform, src: &str) -> (String, String) {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..ShellInit::default() };
	let cfg = EngineConfig { platform, ..EngineConfig::default() };
	let mut rig = Rig::with_config(FakeHost::new(), init, cfg);
	rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
	)
}

/// zsh 5.9's signal names on Linux, as its build makes them from glibc's
/// headers (`Src/signames1.awk`, `Src/signames2.awk`): glibc 2.32 and later
/// define `SIGIOT` before `SIGABRT` (`bits/signum-arch.h`), so 6 is `IOT`,
/// and zsh prefers `POLL` to `IO` for 29. The Debian/Ubuntu zsh 5.9 on
/// glibc 2.39 prints exactly these.
const LINUX_SIGNALS: &str = "EXIT HUP INT QUIT ILL TRAP IOT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM \
                             TERM STKFLT CHLD CONT STOP TSTP TTIN TTOU URG XCPU XFSZ VTALRM PROF \
                             WINCH POLL PWR SYS ZERR DEBUG";

/// zsh 5.9's signal names on macOS: Darwin's `sys/signal.h` defines
/// `SIGABRT` 6 before `SIGIOT` (`SIGABRT`), `SIGEMT` 7, `SIGIO` 23 and
/// `SIGPOLL` only for strict POSIX, so the same build steps give these.
const MACOS_SIGNALS: &str = "EXIT HUP INT QUIT ILL TRAP ABRT EMT FPE KILL BUS SEGV SYS PIPE ALRM \
                             TERM URG STOP TSTP CONT CHLD TTIN TTOU IO XCPU XFSZ VTALRM PROF \
                             WINCH INFO USR1 USR2 ZERR DEBUG";

/// `$signals`, `kill -l` and `trap` name the signals as zsh 5.9 does on
/// Linux; zsh's alternate names (`CLD`, `IO`) are taken as input, and
/// `ABRT` is not a signal of zsh's there.
#[test]
fn zsh_names_the_signals_as_its_linux_build() {
	let (out, err) = zsh_on(
		Platform::Linux,
		"print -r -- $signals; kill -l; kill -l 6 29 17; kill -l IOT POLL IO CLD iot; kill -l ABRT; \
		 print st=$?; trap 'print x' IOT; trap 'print y' POLL; trap; trap '' ABRT; print st=$?; \
		 trap - IOT POLL; kill -ABRT $$; print st=$?",
	);
	let kill_l = LINUX_SIGNALS
		.strip_prefix("EXIT ")
		.and_then(|s| s.strip_suffix(" ZERR DEBUG"))
		.unwrap();
	assert_eq!(
		out,
		format!(
			"{LINUX_SIGNALS}\n{kill_l}\nIOT\nPOLL\nCHLD\n6\n29\n29\n17\n6\nst=1\ntrap -- 'print x' \
			 IOT\ntrap -- 'print y' POLL\nst=1\nst=1\n"
		)
	);
	assert_eq!(
		err,
		"zsh:kill:1: unknown signal: SIGABRT\nzsh:trap:1: undefined signal: ABRT\nzsh:kill:1: \
		 unknown signal: SIGABRT\nzsh:kill:1: type kill -l for a list of signals\n"
	);
}

/// On macOS zsh's names are the signals' own: 6 is `ABRT`, 23 `IO`, and
/// `IOT` names nothing.
#[test]
fn zsh_names_the_signals_as_its_macos_build() {
	let (out, err) =
		zsh_on(Platform::MacOs, "print -r -- $signals; kill -l 6 23 ABRT IO; kill -l IOT");
	assert_eq!(out, format!("{MACOS_SIGNALS}\nABRT\nIO\n6\n23\n"));
	assert_eq!(err, "zsh:kill:1: unknown signal: SIGIOT\n");
}

#[test]
fn signal_specs_follow_the_configured_platform() {
	assert_eq!(Signal::parse_spec(b"SIGUSR1", Platform::Linux), Some(Signal::Usr1));
	assert_eq!(Signal::parse_spec(b"10", Platform::Linux), Some(Signal::Usr1));
	assert_eq!(Signal::parse_spec(b"30", Platform::MacOs), Some(Signal::Usr1));
	assert_eq!(Signal::parse_spec(b"10", Platform::MacOs), Some(Signal::Bus));
	assert_eq!(Signal::parse_spec(b"sigusr1", Platform::MacOs), Some(Signal::Usr1));
	assert_eq!(Signal::parse_spec(b"EMT", Platform::MacOs), Some(Signal::Emt));
	assert_eq!(Signal::parse_spec(b"EMT", Platform::Linux), None);
	assert_eq!(Signal::parse_spec(b"STKFLT", Platform::Linux), Some(Signal::Stkflt));
	assert_eq!(Signal::parse_spec(b"STKFLT", Platform::MacOs), None);
	assert_eq!(Signal::parse_spec(b"0", Platform::Linux), None);
	assert_eq!(Signal::parse_spec(b"BOGUS", Platform::Linux), None);
}

#[test]
fn realtime_names_numbers_and_sets_are_platform_specific() {
	for n in 34..=64 {
		let signal = Signal::from_number(n, Platform::Linux).unwrap();
		assert_eq!(signal.number(Platform::Linux), n);
		assert_eq!(
			Signal::parse_spec(format!("RTMIN+{}", n - 34).as_bytes(), Platform::Linux),
			Some(signal)
		);
		assert_eq!(
			Signal::parse_spec(format!("SIGRTMAX-{}", 64 - n).as_bytes(), Platform::Linux),
			Some(signal)
		);
		assert_eq!(Signal::from_number(n, Platform::MacOs), None);
	}
	assert_eq!(Signal::parse_spec(b"RTMIN+31", Platform::Linux), None);
	assert_eq!(Signal::parse_spec(b"RTMAX-31", Platform::Linux), None);
	assert_eq!(Signal::parse_spec(b"RTMAX", Platform::MacOs), None);
	assert_eq!(Signal::parse_spec(b"RTMIN", Platform::Windows), None);
	let set = SigSet::EMPTY.with(Signal::Rtmin).with(Signal::Rtmax);
	assert!(set.contains(Signal::Rtmin));
	assert!(set.contains(Signal::Rtmax));
	assert!(!set.without(Signal::Rtmax).contains(Signal::Rtmax));
}

#[cfg(target_os = "linux")]
#[test]
fn realtime_kill_lists_and_delivers_on_virtual_bus() {
	let result = run_script(
		FakeHost::new(),
		b"trap 'echo trapped' RTMAX; kill -s RTMIN+30 $$; kill -l 64; kill -l RTMAX-30",
		&[],
		Fault::None,
	);
	assert_eq!(result.stdout, b"trapped\nRTMAX\n34\n");
	assert_eq!(result.status, 0);
}

#[test]
fn kill_checks_self_and_rejects_bad_targets_and_signals() {
	let result = run_script(
		FakeHost::new(),
		b"kill -0 $$; echo $?; kill -BOGUS $$; echo $?; kill -0 not-a-pid; echo $?",
		&[],
		Fault::None,
	);
	assert_eq!(result.stdout, b"0\n1\n1\n");
	assert_eq!(result.status, 0);
}

#[test]
fn kill_accepts_attached_signal_options() {
	let result = run_script(FakeHost::new(), b"trap 'echo term' TERM; kill -sTERM $$; kill -n15 $$; kill -nBAD $$; echo $?; kill -sBAD $$; echo $?", &[], Fault::None);
	assert_eq!(result.stdout, b"term\nterm\n1\n1\n");
	assert_eq!(result.status, 0);
}

#[test]
fn kill_lists_signal_names_and_exit_statuses() {
	let result =
		run_script(FakeHost::new(), b"kill -l TERM; kill -l 15; kill -l 143", &[], Fault::None);
	assert_eq!(result.stdout, b"15\nTERM\nTERM\n");
	assert_eq!(result.status, 0);
}

#[test]
fn kill_numbered_job_terminates_its_pipeline_after_snapshot() {
	for fault in [Fault::None, Fault::Snapshot { every: 17 }] {
		let mut host = FakeHost::new();
		host.countdown("hold", 10_000, 0);
		host.countdown("delay", 4, 0);
		let result = run_script(
			host,
			b"hold | hold & p=$!; delay; kill -KILL %1; wait \"$p\"; echo status=$?",
			&[],
			fault,
		);
		assert_eq!(result.stdout, b"status=137\n", "{fault:?}");
		assert_eq!(result.status, 0, "{fault:?}");
	}
}

#[test]
fn kill_signals_root_from_a_background_vproc() {
	let result = run_script(
		FakeHost::new(),
		b"trap 'echo trapped' USR1; (kill -s USR1 $$) & wait; echo done",
		&[],
		Fault::None,
	);
	assert_eq!(result.stdout, b"trapped\ndone\n");
	assert_eq!(result.status, 0);
}
