//! pi's extras through a [`Session`]: utilities and process builtins as engine
//! tasks, the command-running extras as tool calls, pi's gates, and the
//! withheld `suspend`, with real processes.

#![cfg(unix)]

use std::{
	io::{self, Read as _, Seek as _},
	os::unix::ffi::OsStrExt as _,
	path::Path,
	sync::Arc,
	time::{Duration, Instant},
};

use async_trait::async_trait;
use bstr::BString;
use parking_lot::Mutex;
use pi_vfs::{FileHandle, FileSystem, FileType, Metadata, OpenOptions, Permissions, ReadDir};
use tokio_util::sync::CancellationToken;

use crate::{
	session::{RunStdio, Session, SessionConfig},
	vfs::VfsFs,
};

/// The process environment without pi's switches, plus `extra`.
fn env_with(extra: &[(&str, &str)]) -> Vec<(BString, BString)> {
	std::env::vars_os()
		.filter(|(name, _)| !name.as_bytes().starts_with(b"PI_"))
		.map(|(k, v)| (BString::from(k.as_bytes()), BString::from(v.as_bytes())))
		.chain(
			extra
				.iter()
				.map(|&(k, v)| (BString::from(k), BString::from(v))),
		)
		.collect()
}

fn session_in(dir: &Path, extra: &[(&str, &str)]) -> Session {
	session_with(dir, env_with(extra))
}

/// A session in `dir` whose environment is `env` alone.
fn session_with(dir: &Path, env: Vec<(BString, BString)>) -> Session {
	Session::new(SessionConfig {
		env,
		cwd: BString::from(dir.as_os_str().as_bytes()),
		fs: Box::new(crate::sys::StdFs::default()),
		vfs: None,
		runtime: tokio::runtime::Handle::current(),
		output_decoding: None,
	})
	.unwrap()
}

fn session() -> Session {
	session_in(&std::env::current_dir().unwrap(), &[])
}

struct Ran {
	status:    i32,
	cancelled: bool,
	stdout:    String,
	stderr:    String,
	elapsed:   Duration,
}

fn read_back(mut file: std::fs::File) -> String {
	file.rewind().unwrap();
	let mut text = String::new();
	file.read_to_string(&mut text).unwrap();
	text
}

async fn run_with(s: &mut Session, command: &str, cancel: CancellationToken) -> Ran {
	let (out, err) = (tempfile::tempfile().unwrap(), tempfile::tempfile().unwrap());
	let stdio = RunStdio {
		stdin:  Some(std::fs::File::open("/dev/null").unwrap()),
		stdout: Some(out.try_clone().unwrap()),
		stderr: Some(err.try_clone().unwrap()),
	};
	let started = Instant::now();
	let outcome = s.run(command, stdio, cancel).await.unwrap();
	Ran {
		status:    outcome.status,
		cancelled: outcome.cancelled,
		stdout:    read_back(out),
		stderr:    read_back(err),
		elapsed:   started.elapsed(),
	}
}

async fn run(s: &mut Session, command: &str) -> Ran {
	run_with(s, command, CancellationToken::new()).await
}

/// stdout of `command`, which must succeed.
async fn out(s: &mut Session, command: &str) -> String {
	let ran = run(s, command).await;
	assert_eq!(ran.status, 0, "{command}: stderr {:?}", ran.stderr);
	ran.stdout
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sort_is_pis_extra() {
	let mut s = session();
	assert_eq!(out(&mut s, "printf 'b\\na\\n' | sort").await, "a\nb\n");
	assert_eq!(out(&mut s, "type sort").await, "sort is a shell builtin\n");
	assert_eq!(out(&mut s, "command -v sort").await, "sort\n");
	// No PATH needed: the extra is not a program.
	assert_eq!(out(&mut s, "(PATH=/nonexistent; printf 'b\\na\\n' | sort)").await, "a\nb\n");
	// Process builtins are extras too.
	assert_eq!(out(&mut s, "type -t sleep ps").await, "builtin\nbuiltin\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn extras_compose_with_builtins_and_each_other() {
	let mut s = session();
	assert_eq!(out(&mut s, "echo x | cat | head -n1").await, "x\n");
	assert_eq!(out(&mut s, "printf '1\\n2\\n3\\n' | cat | head -n1").await, "1\n");
	assert_eq!(
		out(&mut s, "printf 'b\\na\\n' | sort | while read -r l; do echo \"<$l>\"; done").await,
		"<a>\n<b>\n"
	);
	assert_eq!(out(&mut s, "x=$(printf 'b\\na\\n' | sort); echo \"[$x]\"").await, "[a\nb]\n");
	assert_eq!(out(&mut s, "printf 'b\\na\\n' | sort | tr a-z A-Z").await, "A\nB\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_extra_reads_no_input_it_does_not_use() {
	let mut s = session();
	// `basename` never reads fd 0: the loop keeps every line.
	assert_eq!(
		out(&mut s, "printf 'a\\nb\\nc\\n' | while read -r l; do basename \"/x/$l\"; done").await,
		"a\nb\nc\n"
	);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failures_keep_their_status() {
	let mut s = session();
	let ran = run(&mut s, "sort < /definitely/missing").await;
	assert_eq!(ran.status, 1, "stderr: {:?}", ran.stderr);
	assert!(ran.stderr.contains("/definitely/missing"), "stderr: {:?}", ran.stderr);
	let ran = run(&mut s, "sort /definitely/missing").await;
	assert_ne!(ran.status, 0);
	assert!(ran.stderr.starts_with("sort: "), "stderr: {:?}", ran.stderr);
	assert!(ran.stderr.contains("No such file or directory"), "stderr: {:?}", ran.stderr);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn background_extras_are_jobs() {
	let dir = tempfile::tempdir().unwrap();
	let mut s = session_in(dir.path(), &[]);
	let ran = run(
		&mut s,
		"printf 'b\\na\\n' > in.txt; sort < in.txt > out.txt & wait $!; echo \"status $?\"; cat \
		 out.txt",
	)
	.await;
	assert_eq!(
		(ran.status, ran.stdout.as_str()),
		(0, "status 0\na\nb\n"),
		"stderr: {:?}",
		ran.stderr
	);
	assert_eq!(out(&mut s, "sleep 0.1 & sleep 0.1 & wait; echo done").await, "done\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_ends_an_extra_promptly() {
	let mut s = session();
	let cancel = CancellationToken::new();
	let trigger = cancel.clone();
	tokio::spawn(async move {
		tokio::time::sleep(Duration::from_millis(200)).await;
		trigger.cancel();
	});
	let ran = run_with(&mut s, "sleep 30", cancel).await;
	assert!(ran.cancelled);
	assert!(ran.elapsed < Duration::from_secs(5), "took {:?}", ran.elapsed);
	// The session stays usable.
	assert_eq!(out(&mut s, "echo alive").await, "alive\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pis_switches_hand_utilities_to_path() {
	let dir = std::env::current_dir().unwrap();
	let mut off = session_in(&dir, &[("PI_DISABLE_UUTILS_BUILTINS", "1")]);
	assert_eq!(out(&mut off, "type -t sort").await, "file\n");
	assert_eq!(out(&mut off, "printf 'b\\na\\n' | sort").await, "a\nb\n");
	assert_eq!(out(&mut off, "type -t sleep").await, "builtin\n", "process builtins stay");
	let mut rm_off = session_in(&dir, &[("PI_DISABLE_RM_BUILTIN", "1")]);
	assert_eq!(out(&mut rm_off, "type -t rm mv").await, "file\nbuiltin\n");
	let mut destructive = session_in(&dir, &[("PI_DISABLE_UUTILS_DESTRUCTIVE", "true")]);
	assert_eq!(out(&mut destructive, "type -t cp cat").await, "file\nbuiltin\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn env_runs_its_command_through_the_shell() {
	let mut s = session();
	assert_eq!(out(&mut s, "type -t env xargs find").await, "builtin\nbuiltin\nbuiltin\n");
	assert_eq!(out(&mut s, "env FOO=1 sh -c 'echo $FOO'").await, "1\n");
	assert_eq!(out(&mut s, "HOME=/h; env -u HOME sh -c 'echo ${HOME-unset}'").await, "unset\n");
	assert_eq!(out(&mut s, "env -i FOO=2 sh -c 'echo \"$FOO-${HOME-none}\"'").await, "2-none\n");
	assert_eq!(out(&mut s, "env -i FOO=2 printenv FOO").await, "2\n");
	// The change stays in the command's subshell.
	assert_eq!(out(&mut s, "export BAR=x; env BAR=y true; echo $BAR").await, "x\n");
	// Its stdin is the caller's.
	assert_eq!(out(&mut s, "echo piped | env cat").await, "piped\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn env_clear_and_unset_remove_inherited_non_shell_entries() {
	// What a program spawned with an empty environment sees anyway: a test
	// runner may add variables to every process this one spawns (cango's
	// tracer adds `CANGO_TRACE`).
	let injected = std::process::Command::new("/usr/bin/env")
		.env_clear()
		.output()
		.unwrap()
		.stdout;
	let injected: Vec<&[u8]> = injected
		.split(|&b| b == b'\n')
		.filter_map(|line| line.split(|&b| b == b'=').next())
		.filter(|name| !name.is_empty())
		.collect();
	let own = |out: String| -> String {
		let mut kept = String::new();
		for line in out.lines() {
			if !injected.contains(&line.split('=').next().unwrap_or_default().as_bytes()) {
				kept.push_str(line);
				kept.push('\n');
			}
		}
		kept
	};
	let mut s = session_in(&std::env::current_dir().unwrap(), &[
		("PI_PROBE-DASH", "1"),
		("PI_PROBE_PLAIN", "1"),
	]);
	let plain = out(&mut s, "/usr/bin/env").await;
	assert!(plain.lines().any(|line| line == "PI_PROBE-DASH=1"));
	assert!(plain.lines().any(|line| line == "PI_PROBE_PLAIN=1"));
	assert_eq!(own(out(&mut s, "env -i /usr/bin/env").await), "");
	assert_eq!(own(out(&mut s, "env -i A=1 /usr/bin/env").await), "A=1\n");
	assert_eq!(own(out(&mut s, "env -i 'PI_PROBE-DASH=2' /usr/bin/env").await), "PI_PROBE-DASH=2\n");
	// A command-prefix assignment shadows the exported global: clearing or
	// removing the binding must not uncover the global's value.
	assert_eq!(own(out(&mut s, "PI_PROBE_PLAIN=temp env -i /usr/bin/env").await), "");
	let shadowed = out(&mut s, "PI_PROBE_PLAIN=temp env -u PI_PROBE_PLAIN /usr/bin/env").await;
	assert!(
		!shadowed
			.lines()
			.any(|line| line.starts_with("PI_PROBE_PLAIN="))
	);
	assert_eq!(
		own(out(&mut s, "f() { local -x PI_PROBE_PLAIN=local; env -i /usr/bin/env; }; f").await),
		""
	);
	let unset = out(&mut s, "env -u 'PI_PROBE-DASH' /usr/bin/env").await;
	assert!(!unset.lines().any(|line| line.starts_with("PI_PROBE-DASH=")));
	assert!(unset.lines().any(|line| line == "PI_PROBE_PLAIN=1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn xargs_runs_builtins_and_programs() {
	let mut s = session();
	assert_eq!(out(&mut s, "printf '1\\n2\\n' | xargs -n1 echo").await, "1\n2\n");
	assert_eq!(out(&mut s, "echo hi | xargs sh -c 'echo \"[$1]\"' sh").await, "[hi]\n");
	assert_eq!(out(&mut s, "echo hi | xargs /bin/echo").await, "hi\n");
	assert_eq!(out(&mut s, "printf 'b\\na\\n' | xargs -n1 echo | sort").await, "a\nb\n");
}

/// `sh` behind a symlink at a path of about 3500 bytes (the directory goes
/// with the guard). `execve` copies the program's path onto the new stack
/// with the command line, while xargs counts only the command line and the
/// environment against `sysconf(_SC_ARG_MAX)`, with 2048 bytes to spare: the
/// kernel refuses a line xargs filled, as a sandbox whose limit is below
/// `sysconf` (gVisor) refuses every full line.
#[cfg(target_os = "linux")]
fn sh_at_a_long_path() -> (tempfile::TempDir, String) {
	let dir = tempfile::tempdir().unwrap();
	let mut path = dir.path().to_path_buf();
	while path.as_os_str().len() < 3300 {
		path.push("d".repeat(250));
	}
	std::fs::create_dir_all(&path).unwrap();
	path.push("sh");
	std::os::unix::fs::symlink("/bin/sh", &path).unwrap();
	let path = path.into_os_string().into_string().unwrap();
	assert!(path.len() < 4000, "{} bytes is too close to PATH_MAX", path.len());
	(dir, path)
}

/// A command that prints an `@ N` line for its N arguments, then each of
/// them on a line of its own: `sh -c` and its script, as shell words.
#[cfg(target_os = "linux")]
const SHOW_ARGS: &str = r#"-c 'echo "@ $#"; printf "%s\n" "$@"' sh"#;

/// The arguments of each line [`SHOW_ARGS`] ran, in order.
#[cfg(target_os = "linux")]
fn lines_run(stdout: &str) -> Vec<Vec<&str>> {
	let mut lines: Vec<(usize, Vec<&str>)> = Vec::new();
	for row in stdout.lines() {
		match row.strip_prefix("@ ") {
			Some(count) => lines.push((count.parse().unwrap(), Vec::new())),
			None => lines
				.last_mut()
				.expect("an argument before any line")
				.1
				.push(row),
		}
	}
	for (count, args) in &lines {
		assert_eq!(*count, args.len(), "a line printed its arguments whole");
	}
	lines.into_iter().map(|(_, args)| args).collect()
}

/// Words of 255 bytes, more than one line holds, written one per line to
/// `words` in `dir`: run by [`sh_at_a_long_path`], the first, full line
/// xargs builds of them is one the kernel refuses.
#[cfg(target_os = "linux")]
fn words_past_a_full_line(dir: &Path) -> Vec<String> {
	// SAFETY: plain call without pointer arguments.
	let arg_max = unsafe { libc::sysconf(libc::_SC_ARG_MAX) } as usize;
	let words: Vec<String> = (0..arg_max / 256)
		.map(|i| format!("{i:07}{}", "x".repeat(248)))
		.collect();
	std::fs::write(dir.join("words"), words.join("\n") + "\n").unwrap();
	words
}

/// How often `stderr` reports a command line the system refused as too
/// long: in `E2BIG`'s words, or in `ENAMETOOLONG`'s, which GKE Sandbox
/// (gVisor) says instead.
#[cfg(target_os = "linux")]
fn too_long_reports(stderr: &str) -> usize {
	stderr.matches("Argument list too long").count() + stderr.matches("File name too long").count()
}

/// xargs in the shell: a full line the kernel refuses as too long runs
/// again as two halves, with nothing printed for the refusal, and every
/// argument still runs once, in order; one argument too long on its own is
/// xargs' error, GNU's, printed once.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn xargs_splits_a_line_the_kernel_refuses_as_too_long() {
	let dir = tempfile::tempdir().unwrap();
	let words = words_past_a_full_line(dir.path());
	let mut s = session_in(dir.path(), &[]);
	let (_long, sh) = sh_at_a_long_path();
	let ran = run(&mut s, &format!("xargs -t -a words {sh} {SHOW_ARGS}")).await;
	// `-t` traces each line before it is tried.
	let (traces, reported): (Vec<&str>, Vec<&str>) =
		ran.stderr.lines().partition(|line| line.starts_with(&sh));
	assert_eq!((ran.status, reported), (0, vec![]), "every line runs, and nothing else is reported");
	let lines = lines_run(&ran.stdout);
	assert!(lines.concat() == words, "the arguments did not each run once, in order");
	let tried: Vec<usize> = traces
		.iter()
		.map(|trace| trace.split(' ').filter(|word| word.len() == 255).count())
		.collect();
	let full = tried[0];
	assert!(
		lines[0].len() < full && tried.get(1) == Some(&(full / 2)),
		"the first, full line of {full} arguments was not refused and halved: {} ran first, and the \
		 next line tried had {:?}",
		lines[0].len(),
		tried.get(1)
	);

	// One argument that fits xargs' count after the long path (a full
	// line's arguments, 256 bytes and an argv pointer each, less a margin),
	// which the kernel refuses.
	let big = "x".repeat(full * (256 + size_of::<*const u8>()) - 128);
	std::fs::write(dir.path().join("big"), format!("{big}\n")).unwrap();
	let ran = run(&mut s, &format!("xargs -a big {sh} {SHOW_ARGS}")).await;
	assert_eq!((ran.status, ran.stdout.as_str()), (1, ""), "{}", ran.stderr);
	assert_eq!(ran.stderr, "xargs: can't call exec() due to argument size restrictions\n");
}

/// `find -exec ... {} +` in the shell: it sizes its batches against the
/// process's environment, but its commands get the shell's, so a large
/// exported variable the process lacks makes the kernel refuse a full batch,
/// which runs again as two halves with nothing printed for the refusal, and
/// every file still runs once, in find's order. A line of one file the
/// kernel refuses is find's error, printed once.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn find_exec_plus_splits_a_batch_the_kernel_refuses_as_too_long() {
	let show_files = format!("find many -type f -exec /bin/sh {SHOW_ARGS} {{}} +");
	let dir = tempfile::tempdir().unwrap();
	std::fs::create_dir(dir.path().join("many")).unwrap();
	// SAFETY: plain call without pointer arguments.
	let arg_max = unsafe { libc::sysconf(libc::_SC_ARG_MAX) } as usize;
	// More file arguments, of about 260 bytes each, than one line holds.
	let count = arg_max / 250;
	for i in 0..count {
		std::fs::write(
			dir.path()
				.join("many")
				.join(format!("{i:06}{}", "f".repeat(240))),
			b"",
		)
		.unwrap();
	}
	// The lines find builds, from the builtin `echo`: no exec limit refuses
	// it (gVisor refuses even a `/bin/sh` line here).
	let ran = run(&mut session_in(dir.path(), &[]), "find many -type f -exec echo {} +").await;
	assert_eq!((ran.status, ran.stderr.as_str()), (0, ""));
	let echoed: Vec<Vec<&str>> = ran
		.stdout
		.lines()
		.map(|line| line.split(' ').collect())
		.collect();
	// A full line for the `sh` command holds as many files, or one fewer:
	// its words take less room than one more file.
	let full = echoed[0].len();

	let pad = "x".repeat(16 * 1024);
	let ran = run(&mut session_in(dir.path(), &[("FIND_TEST_PAD", &pad)]), &show_files).await;
	assert_eq!(
		(ran.status, ran.stderr.as_str()),
		(0, ""),
		"every line runs, and nothing is reported"
	);
	let lines = lines_run(&ran.stdout);
	assert!(lines.concat() == echoed.concat(), "the files did not each run once, in find's order");
	assert!(
		lines[0].len() + 1 < full,
		"the first, full line was not refused and split: {} of about {full} files ran first",
		lines[0].len()
	);

	// An environment as large as the whole limit leaves no room for any line.
	let one = tempfile::tempdir().unwrap();
	std::fs::create_dir(one.path().join("many")).unwrap();
	std::fs::write(one.path().join("many/only"), b"").unwrap();
	let pad = "x".repeat(arg_max);
	let ran = run(&mut session_in(one.path(), &[("FIND_TEST_PAD", &pad)]), &show_files).await;
	assert_eq!((ran.status, ran.stdout.as_str()), (1, ""), "{}", ran.stderr);
	assert_eq!(too_long_reports(&ran.stderr), 1, "{}", ran.stderr);
}

/// A builtin's own `exec` that the system refuses as too long is the
/// shell's: its diagnostic and status 126 (`xargs` 123, `find` 1), and the
/// builtin runs once. Retrying it in halves, as for a program `xargs` or
/// `find` runs, would repeat what the builtin did before the `exec`.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_builtins_refused_exec_is_not_retried() {
	let dir = tempfile::tempdir().unwrap();
	// SAFETY: plain call without pointer arguments.
	let arg_max = unsafe { libc::sysconf(libc::_SC_ARG_MAX) } as usize;
	// An environment string longer than the whole limit: the `exec` is
	// refused with `E2BIG` whatever its arguments.
	std::fs::write(dir.path().join("pad"), "x".repeat(arg_max + 1)).unwrap();
	std::fs::create_dir(dir.path().join("many")).unwrap();
	for n in 1..=10 {
		std::fs::write(dir.path().join("many").join(n.to_string()), b"").unwrap();
	}
	let side_then_exec = r#"'echo SIDE; PAD=$(cat pad) exec /bin/sh -c "echo ran" sh'"#;
	let mut s = session_in(dir.path(), &[]);
	for (command, status) in [
		(format!("printf '%s\\n' 1 2 3 4 5 6 7 8 9 10 | xargs eval {side_then_exec}"), 123),
		(format!("find many -type f -exec eval {side_then_exec} {{}} +"), 1),
	] {
		let ran = run(&mut s, &command).await;
		assert_eq!(
			(ran.status, ran.stdout.as_str()),
			(status, "SIDE\n"),
			"{command}: {}",
			ran.stderr
		);
		assert_eq!(too_long_reports(&ran.stderr), 1, "{command}: {}", ran.stderr);
		assert!(!ran.stderr.contains("could not be run"), "{command}: {}", ran.stderr);
	}
}

/// The number of lines `-t` traced for `program` in `stderr`: the lines
/// xargs tried.
#[cfg(target_os = "linux")]
fn lines_tried(stderr: &str, program: &str) -> usize {
	stderr
		.lines()
		.filter(|line| line.starts_with(program))
		.count()
}

/// No shell function runs in the commands xargs runs, as no function runs
/// in a real xargs' children: not one named `exec`, `builtin` or `command`
/// in place of the words a callout generates (`builtin exec` for a program,
/// `command` for a builtin), which a retry of a refused line would run
/// again each time.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_shell_function_runs_in_the_commands_xargs_runs() {
	let dir = tempfile::tempdir().unwrap();
	let words = words_past_a_full_line(dir.path());
	std::fs::write(dir.path().join("two"), "1\n2\n").unwrap();
	let (_long, sh) = sh_at_a_long_path();
	for function in [
		r#"exec() { echo SIDE >&2; builtin exec "$@"; }"#,
		r#"builtin() { echo SIDE >&2; command builtin "$@"; }"#,
		r#"command() { echo SIDE >&2; builtin command "$@"; }"#,
	] {
		let mut s = session_in(dir.path(), &[]);
		let ran = run(&mut s, &format!("{function}; xargs -t -a words {sh} {SHOW_ARGS}")).await;
		let tried = lines_tried(&ran.stderr, &sh);
		assert!(tried > 2, "{function}: no line was refused and split: {tried} tried");
		let side = ran.stderr.matches("SIDE").count();
		assert_eq!((ran.status, side), (0, 0), "{function}: the function ran: {}", ran.stderr);
		assert!(
			lines_run(&ran.stdout).concat() == words,
			"{function}: the arguments did not each run once"
		);
		let ran = run(&mut s, "xargs -n1 -a two echo").await;
		let side = ran.stderr.matches("SIDE").count();
		assert_eq!(
			(ran.status, ran.stdout.as_str(), side),
			(0, "1\n2\n", 0),
			"{function}: {}",
			ran.stderr
		);
	}
}

/// `xargs env NAME=VALUE PROG`, `xargs command PROG` and `xargs exec PROG`
/// run PROG as `xargs PROG` does, since those builtins run nothing before
/// they `exec` it: a line the system refuses as too long is split, as GNU's
/// xargs splits it for the program `env`, and `env`'s variables reach PROG.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_line_is_split_through_env_command_and_exec() {
	let dir = tempfile::tempdir().unwrap();
	let words = words_past_a_full_line(dir.path());
	let (_long, sh) = sh_at_a_long_path();
	let mut s = session_in(dir.path(), &[]);
	for wrapper in ["env PI_TEST_VAR=set", "command", "command --", "exec", "builtin exec"] {
		let ran = run(&mut s, &format!("xargs -t -a words {wrapper} {sh} {SHOW_ARGS}")).await;
		let (traces, reported): (Vec<&str>, Vec<&str>) = ran
			.stderr
			.lines()
			.partition(|line| line.starts_with(wrapper));
		assert_eq!(
			(ran.status, reported),
			(0, vec![]),
			"{wrapper}: every line runs, and nothing else is reported"
		);
		assert!(traces.len() > 2, "{wrapper}: no line was refused and split: {} tried", traces.len());
		assert!(
			lines_run(&ran.stdout).concat() == words,
			"{wrapper}: the arguments did not each run once, in order"
		);
	}
	let ran =
		run(&mut s, r#"echo x | xargs env PI_TEST_VAR=set /bin/sh -c 'echo "$PI_TEST_VAR $1"' sh"#)
			.await;
	assert_eq!((ran.status, ran.stdout.as_str()), (0, "set x\n"), "{}", ran.stderr);
}

/// What a wrapper prints itself for each attempt, on stderr: `env`'s
/// `--debug` trace and `--list-signal-handling` list (GNU's `env` prints
/// them only for the pieces that run, as the system refuses its own exec
/// before it starts; pi's `env` prints them before the command, so for
/// every attempt).
#[cfg(target_os = "linux")]
fn wrapper_output(line: &str) -> bool {
	line.starts_with("executing: ") || line.starts_with("   arg[") || line.ends_with("): IGNORE")
}

/// Runs `xargs -t -a words COMMAND` in `s`, where `COMMAND` (shell words)
/// runs [`SHOW_ARGS`] over `words` ([`words_past_a_full_line`]) through a
/// wrapper and `-t` traces each line with `trace` first: the line splits as
/// GNU's xargs splits a line whose wrapper program the system refused, and
/// as the program alone splits. Every word runs once, in order; the first,
/// full line is refused and halved; nothing is printed for a refusal but
/// the wrapper's own output ([`wrapper_output`]), once for each attempt.
/// Returns the arguments of the full line.
#[cfg(target_os = "linux")]
async fn assert_split_through(
	s: &mut Session,
	command: &str,
	trace: &str,
	words: &[String],
) -> usize {
	let ran = run(s, &format!("xargs -t -a words {command}")).await;
	let (traces, reported): (Vec<&str>, Vec<&str>) =
		ran.stderr.lines().partition(|line| line.starts_with(trace));
	let (own, reported): (Vec<&str>, Vec<&str>) =
		reported.into_iter().partition(|line| wrapper_output(line));
	assert_eq!(
		(ran.status, reported),
		(0, vec![]),
		"{command}: every line runs, and nothing else is reported"
	);
	let executing = own
		.iter()
		.filter(|line| line.starts_with("executing: "))
		.count();
	assert!(
		executing == 0 || executing == traces.len(),
		"{command}: {executing} traces for {} attempts",
		traces.len()
	);
	assert!(
		lines_run(&ran.stdout).concat() == words,
		"{command}: the arguments did not each run once, in order"
	);
	let tried: Vec<usize> = traces
		.iter()
		.map(|trace| trace.split(' ').filter(|word| word.len() == 255).count())
		.collect();
	let full = tried[0];
	let first = lines_run(&ran.stdout)[0].len();
	assert!(
		first < full && tried.get(1) == Some(&(full / 2)),
		"{command}: the first, full line of {full} arguments was not refused and halved: {first} \
		 ran first, and the next line tried had {:?}",
		tried.get(1)
	);
	full
}

/// Runs `xargs -a big COMMAND` in `s`, `big` holding one argument the
/// system refuses even alone: GNU's error and status 1, as GNU's xargs ends
/// when the system refuses a wrapper program with one argument, and nothing
/// runs.
#[cfg(target_os = "linux")]
async fn assert_refused_alone_through(s: &mut Session, command: &str) {
	let ran = run(s, &format!("xargs -a big {command}")).await;
	let reported: Vec<&str> = ran
		.stderr
		.lines()
		.filter(|line| !wrapper_output(line))
		.collect();
	assert_eq!(
		(ran.status, ran.stdout.as_str(), reported),
		(1, "", vec!["xargs: can't call exec() due to argument size restrictions"]),
		"{command}"
	);
}

/// Writes `big` in `dir`: one argument of about the room a line of `full`
/// words has (256 bytes and an argv pointer each), less room for the widest
/// wrapper, which xargs fits and the kernel refuses: one string past
/// `MAX_ARG_STRLEN` (128 KiB), and past the whole limit with the long path.
#[cfg(target_os = "linux")]
fn big_argument(dir: &Path, full: usize) {
	let big = "x".repeat(full * (256 + size_of::<*const u8>()) - 8192);
	std::fs::write(dir.join("big"), format!("{big}\n")).unwrap();
}

/// `xargs env OPTIONS PROG`: `env` applies its options as it does anywhere,
/// then hands a refusal of PROG's line as too long up to xargs, which
/// splits the line as GNU's xargs splits it for the program `env`; one
/// argument refused alone is xargs' error. Measured against GNU findutils
/// 4.9.0 and coreutils 9.4 (`-a` is pi's only).
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_line_is_split_through_env_and_its_options() {
	let dir = tempfile::tempdir().unwrap();
	let words = words_past_a_full_line(dir.path());
	let (_long, sh) = sh_at_a_long_path();
	let mut s = session_in(dir.path(), &[]);
	let full = assert_split_through(&mut s, &format!("{sh} {SHOW_ARGS}"), &sh, &words).await;
	big_argument(dir.path(), full);
	for (options, trace) in [
		("-u HOME".to_owned(), "env -u HOME".to_owned()),
		("-C /".to_owned(), "env -C /".to_owned()),
		("-S '-u HOME'".to_owned(), "env -S -u HOME".to_owned()),
		("-v".to_owned(), "env -v".to_owned()),
		("--default-signal=USR1".to_owned(), "env --default-signal=USR1".to_owned()),
		("--list-signal-handling".to_owned(), "env --list-signal-handling".to_owned()),
	] {
		let command = format!("env {options} {sh} {SHOW_ARGS}");
		assert_split_through(&mut s, &command, &trace, &words).await;
		assert_refused_alone_through(&mut s, &command).await;
	}
	// `-i` leaves the program less than xargs counted, and with `-a` the
	// long path xargs counted is no longer in `argv`: the line is refused
	// only when the uncounted path the kernel copies outweighs xargs' own
	// environment, in a session that has little more than a `PATH`.
	let mut small =
		session_with(dir.path(), vec![(BString::from("PATH"), BString::from("/usr/bin:/bin"))]);
	let long_dir = Path::new(&sh).parent().unwrap().display().to_string();
	for (command, trace) in [
		(format!("env -i {sh} {SHOW_ARGS}"), "env -i".to_owned()),
		(format!("env -a sh PATH={long_dir} sh {SHOW_ARGS}"), "env -a sh PATH=".to_owned()),
	] {
		assert_split_through(&mut small, &command, &trace, &words).await;
		assert_refused_alone_through(&mut small, &command).await;
	}
	// The options still apply to every piece.
	let ran =
		run(&mut s, r#"echo x | xargs env -i -C / /bin/sh -c 'echo "$(pwd) ${HOME-unset} $1"' sh"#)
			.await;
	assert_eq!((ran.status, ran.stdout.as_str()), (0, "/ unset x\n"), "{}", ran.stderr);
}

/// `xargs nohup PROG`: pi's `nohup` does nothing visible before PROG starts
/// (no `nohup.out`, no notice), so it hands a refusal of PROG's line as too
/// long up to xargs, which splits the line as GNU's xargs splits it for the
/// program `nohup`, each piece with a `nohup` of its own; one argument
/// refused alone is xargs' error.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_line_is_split_through_nohup() {
	let dir = tempfile::tempdir().unwrap();
	let words = words_past_a_full_line(dir.path());
	let (_long, sh) = sh_at_a_long_path();
	let mut s = session_in(dir.path(), &[]);
	let full = assert_split_through(&mut s, &format!("{sh} {SHOW_ARGS}"), &sh, &words).await;
	big_argument(dir.path(), full);
	for wrapper in ["nohup", "nohup --"] {
		let command = format!("{wrapper} {sh} {SHOW_ARGS}");
		assert_split_through(&mut s, &command, wrapper, &words).await;
		assert_refused_alone_through(&mut s, &command).await;
	}
	let ran = run(&mut s, "printf '1\\n2\\n' | xargs nohup /bin/echo").await;
	assert_eq!((ran.status, ran.stdout.as_str(), ran.stderr.as_str()), (0, "1 2\n", ""));
}

/// `xargs ifne -n PROG`: the commands xargs runs read the null device, so
/// `ifne -n` has read nothing a retry would miss when it starts PROG; it
/// hands a refusal of PROG's line as too long up to xargs, which splits the
/// line as for the program alone; one argument refused alone is xargs'
/// error. Without `-n`, empty input runs nothing.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_line_is_split_through_ifne() {
	let dir = tempfile::tempdir().unwrap();
	let words = words_past_a_full_line(dir.path());
	let (_long, sh) = sh_at_a_long_path();
	let mut s = session_in(dir.path(), &[]);
	let full = assert_split_through(&mut s, &format!("{sh} {SHOW_ARGS}"), &sh, &words).await;
	big_argument(dir.path(), full);
	let command = format!("ifne -n {sh} {SHOW_ARGS}");
	assert_split_through(&mut s, &command, "ifne -n", &words).await;
	assert_refused_alone_through(&mut s, &command).await;
	let ran = run(&mut s, &format!("xargs -a words ifne {sh} {SHOW_ARGS}")).await;
	assert_eq!((ran.status, ran.stdout.as_str(), ran.stderr.as_str()), (0, "", ""));
}

/// `xargs timeout DURATION PROG`: `timeout` starts PROG and supervises it;
/// a refusal of PROG's line as too long comes before any signal, so
/// `timeout` hands it up to xargs, which splits the line as GNU's xargs
/// splits it for the program `timeout`, each piece under a `timeout` of its
/// own, through a nested wrapper too; one argument refused alone is xargs'
/// error. Outside a callout the refusal stays `timeout`'s: the shell's
/// diagnostic, status 126.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_line_is_split_through_timeout() {
	let dir = tempfile::tempdir().unwrap();
	let words = words_past_a_full_line(dir.path());
	let (_long, sh) = sh_at_a_long_path();
	let mut s = session_in(dir.path(), &[]);
	let full = assert_split_through(&mut s, &format!("{sh} {SHOW_ARGS}"), &sh, &words).await;
	big_argument(dir.path(), full);
	for wrapper in
		["timeout 5s", "timeout -k 1s 5s", "timeout 5s env PI_TEST_VAR=set", "timeout 5s nohup"]
	{
		let command = format!("{wrapper} {sh} {SHOW_ARGS}");
		assert_split_through(&mut s, &command, wrapper, &words).await;
		assert_refused_alone_through(&mut s, &command).await;
	}
	let ran = run(&mut s, "printf '1\\n2\\n' | xargs timeout 5s /bin/echo").await;
	assert_eq!((ran.status, ran.stdout.as_str(), ran.stderr.as_str()), (0, "1 2\n", ""));
	let ran = run(&mut s, "printf '1\\n' | xargs timeout 5s false").await;
	assert_eq!((ran.status, ran.stderr.as_str()), (123, ""));
	// SAFETY: plain call without pointer arguments.
	let arg_max = unsafe { libc::sysconf(libc::_SC_ARG_MAX) } as usize;
	std::fs::write(dir.path().join("pad"), "x".repeat(arg_max + 1)).unwrap();
	let ran = run(&mut s, "PAD=$(cat pad) timeout 5s /bin/sh -c 'echo ran'").await;
	assert_eq!((ran.status, ran.stdout.as_str()), (126, ""), "{}", ran.stderr);
	assert_eq!(too_long_reports(&ran.stderr), 1, "{}", ran.stderr);
	// `timeout`'s own subshell stands for the program too: no function runs.
	let ran = run(&mut s, "f() { echo SIDE; }; echo x | xargs timeout 5s f").await;
	assert_eq!((ran.status, ran.stdout.as_str()), (123, ""), "{}", ran.stderr);

	// `find -exec … +` runs its lines through the same callouts: a batch
	// refused under `timeout` splits too (the batches are sized against the
	// process's environment, which lacks the session's pad).
	std::fs::create_dir(dir.path().join("many")).unwrap();
	let mut files: Vec<String> = (0..arg_max / 250)
		.map(|i| format!("many/{i:06}{}", "f".repeat(240)))
		.collect();
	for file in &files {
		std::fs::write(dir.path().join(file), b"").unwrap();
	}
	let batches = run(&mut s, "find many -type f -exec echo {} +")
		.await
		.stdout
		.lines()
		.count();
	let pad = "x".repeat(16 * 1024);
	let mut padded = session_in(dir.path(), &[("FIND_TEST_PAD", &pad)]);
	let command = format!("find many -type f -exec timeout 5s /bin/sh {SHOW_ARGS} {{}} +");
	let ran = run(&mut padded, &command).await;
	assert_eq!(
		(ran.status, ran.stderr.as_str()),
		(0, ""),
		"every batch runs, and nothing is reported"
	);
	let lines = lines_run(&ran.stdout);
	assert!(
		lines.len() > batches,
		"no batch was refused and split: {} lines for {batches} batches",
		lines.len()
	);
	let mut ran_files: Vec<&str> = lines.concat();
	ran_files.sort_unstable();
	files.sort_unstable();
	assert!(ran_files == files, "the files did not each run once");
}

/// The commands xargs runs run none of the caller's DEBUG or ERR traps,
/// even under `set -T` and `set -E`, as a program's children run none:
/// each trap runs in the caller, once, for xargs, however many lines xargs
/// starts or retries.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_callers_debug_and_err_traps_do_not_run_in_xargs_commands() {
	let dir = tempfile::tempdir().unwrap();
	let words = words_past_a_full_line(dir.path());
	std::fs::write(dir.path().join("two"), "1\n2\n").unwrap();
	let (_long, sh) = sh_at_a_long_path();
	let debug = "set -T; trap 'echo DBG >&2' DEBUG";

	let ran =
		run(&mut session_in(dir.path(), &[]), &format!("{debug}; xargs -a two /bin/echo")).await;
	assert_eq!((ran.status, ran.stdout.as_str(), ran.stderr.as_str()), (0, "1 2\n", "DBG\n"));

	let refused = format!("{debug}; xargs -t -a words {sh} {SHOW_ARGS}");
	let ran = run(&mut session_in(dir.path(), &[]), &refused).await;
	let tried = lines_tried(&ran.stderr, &sh);
	assert!(tried > 2, "no line was refused and split: {tried} tried");
	assert_eq!((ran.status, ran.stderr.matches("DBG").count()), (0, 1), "{}", ran.stderr);
	assert!(
		lines_run(&ran.stdout).concat() == words,
		"the arguments did not each run once, in order"
	);

	let err = "set -E; trap 'echo ERR >&2' ERR; xargs -n1 -a two false";
	let ran = run(&mut session_in(dir.path(), &[]), err).await;
	assert_eq!((ran.status, ran.stderr.as_str()), (123, "ERR\n"));
}

/// A directory inside `root` whose path is longer than `PATH_MAX`, made
/// one level at a time through the descriptor of the one before: nothing
/// starts in it, since the system refuses its path with `ENAMETOOLONG`.
#[cfg(target_os = "linux")]
fn deeper_than_path_max(root: &Path) -> std::path::PathBuf {
	use std::os::fd::{AsRawFd as _, FromRawFd as _};
	let name = "d".repeat(200);
	let levels = crate::sys::PATH_MAX / (name.len() + 1) + 1;
	let c_name = std::ffi::CString::new(name.as_str()).unwrap();
	let mut dir = std::fs::File::open(root).unwrap();
	for _ in 0..levels {
		// SAFETY: `dir` is an open directory and `c_name` NUL-terminated.
		let made = unsafe { libc::mkdirat(dir.as_raw_fd(), c_name.as_ptr(), 0o755) };
		assert_eq!(made, 0, "mkdirat: {}", io::Error::last_os_error());
		// SAFETY: as above; the new descriptor is owned by the `File`.
		let fd = unsafe {
			libc::openat(
				dir.as_raw_fd(),
				c_name.as_ptr(),
				libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
			)
		};
		assert!(fd >= 0, "openat: {}", io::Error::last_os_error());
		// SAFETY: `fd` is a descriptor just opened and owned by nothing else.
		dir = unsafe { std::fs::File::from_raw_fd(fd) };
	}
	let mut path = root.to_path_buf();
	for _ in 0..levels {
		path.push(&name);
	}
	assert!(path.as_os_str().len() >= crate::sys::PATH_MAX);
	path
}

/// `ENAMETOOLONG` from a working directory longer than `PATH_MAX` is no
/// command line too long: the shell reports the program it could not start,
/// as for any other refusal (status 126, xargs 123), and xargs does not
/// split the line, since fewer arguments cannot help.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_working_directory_past_path_max_is_no_line_too_long() {
	let dir = tempfile::tempdir().unwrap();
	let ten = dir.path().join("ten");
	std::fs::write(&ten, "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n").unwrap();
	let deep = deeper_than_path_max(dir.path());
	let command = format!("xargs -t -a {} /usr/bin/printf '%s\\n'", ten.display());
	let ran = run(&mut session_in(&deep, &[]), &command).await;
	let tried = lines_tried(&ran.stderr, "/usr/bin/printf");
	assert_eq!((ran.status, ran.stdout.as_str(), tried), (123, "", 1), "{}", ran.stderr);
	assert_eq!(
		ran.stderr
			.matches("/usr/bin/printf: File name too long")
			.count(),
		1,
		"{}",
		ran.stderr
	);
}

/// `tail -f` writing into an engine pipe (no native handle) notices while
/// idle that the extra reading it exited, as it does on a native pipe.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tail_follow_stops_once_the_extra_reading_it_exits() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("log"), "first\nsecond\n").unwrap();
	let mut s = session_in(dir.path(), &[]);
	let ran = tokio::time::timeout(Duration::from_secs(20), run(&mut s, "tail -f log | head -n1"))
		.await
		.expect("tail -f kept following after head exited");
	assert_eq!(ran.stdout, "first\n", "stderr: {:?}", ran.stderr);
}

/// Files an extra creates get the shell's `umask`, whether it runs as a task
/// (`touch`, `mkdir`) or a tool call (`find -fprint`), looser or stricter
/// than the process's.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn extras_create_files_under_the_shell_umask() {
	use std::os::unix::fs::PermissionsExt as _;

	let dir = tempfile::tempdir().unwrap();
	let mut s = session_in(dir.path(), &[]);
	let mode = |name: &str| {
		std::fs::metadata(dir.path().join(name))
			.unwrap()
			.permissions()
			.mode()
			& 0o777
	};
	out(&mut s, "umask 077; touch strict; mkdir strict-dir; find . -maxdepth 0 -fprint strict-find")
		.await;
	assert_eq!(mode("strict"), 0o600);
	assert_eq!(mode("strict-dir"), 0o700);
	assert_eq!(mode("strict-find"), 0o600);
	out(&mut s, "umask 000; touch loose; mkdir loose-dir; find . -maxdepth 0 -fprint loose-find")
		.await;
	assert_eq!(mode("loose"), 0o666);
	assert_eq!(mode("loose-dir"), 0o777);
	assert_eq!(mode("loose-find"), 0o666);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn xargs_does_not_run_functions_and_reports_missing_commands() {
	let mut s = session();
	// pi's runner never ran shell functions: `f` is looked up as a program.
	let ran = run(&mut s, "f(){ echo fn; }; echo a | xargs f; echo \"status $?\"").await;
	assert_eq!(ran.stdout, "status 127\n", "stderr: {:?}", ran.stderr);
	assert!(ran.stderr.contains("xargs: f"), "stderr: {:?}", ran.stderr);
	let ran = run(&mut s, "echo a | xargs no-such-command-here; echo \"status $?\"").await;
	assert_eq!(ran.stdout, "status 127\n", "stderr: {:?}", ran.stderr);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn find_exec_runs_commands() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("x"), "hello\n").unwrap();
	let mut s = session_in(dir.path(), &[]);
	assert_eq!(out(&mut s, "find . -name x -exec echo {} \\;").await, "./x\n");
	assert_eq!(out(&mut s, "find . -name x -exec cat {} +").await, "hello\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ifne_runs_its_command_on_input() {
	let mut s = session();
	assert_eq!(out(&mut s, "printf 'x\\n' | ifne cat").await, "x\n");
	assert_eq!(out(&mut s, "printf '' | ifne echo nonempty; echo \"s $?\"").await, "s 0\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn suspend_is_withheld_and_exec_spares_pi() {
	let mut s = session();
	let ran = run(&mut s, "suspend -f; echo \"status $?\"").await;
	assert_eq!(ran.stdout, "status 1\n");
	assert_eq!(ran.stderr, "suspend: not available in this shell\n");
	assert_eq!(out(&mut s, "(exec /bin/echo hi); echo after").await, "hi\nafter\n");
	// `exec` of a program ends the run, not pi; the session goes on.
	assert_eq!(out(&mut s, "exec /bin/echo bye; echo unreachable").await, "bye\n");
	assert_eq!(out(&mut s, "echo alive").await, "alive\n");
}

// ---------------------------------------------------------------------------
// A provider filesystem.

const NOTES: &[u8] = b"pear\napple\n";

/// One read-only provider file, `mem://notes`; every other path is the host's.
#[derive(Debug)]
struct Notes;

#[async_trait]
impl FileSystem for Notes {
	fn is_native_local(&self, path: &Path) -> bool {
		!pi_vfs::is_virtual_path(path)
	}

	async fn open(&self, path: &Path, _options: &OpenOptions) -> io::Result<pi_vfs::File> {
		if path != Path::new("mem://notes") {
			return Err(io::ErrorKind::NotFound.into());
		}
		Ok(pi_vfs::File::from_handle(NotesHandle { pos: Mutex::new(0) }))
	}

	async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
		if path != Path::new("mem://notes") {
			return Err(io::ErrorKind::NotFound.into());
		}
		Ok(notes_meta())
	}

	async fn read_dir(&self, _path: &Path) -> io::Result<ReadDir> {
		Err(io::ErrorKind::NotFound.into())
	}
}

fn notes_meta() -> Metadata {
	Metadata::new(
		FileType::from_kind(pi_vfs::FileKind::File),
		NOTES.len() as u64,
		Permissions::from_mode(0o644),
	)
}

#[derive(Debug)]
struct NotesHandle {
	pos: Mutex<usize>,
}

#[async_trait]
impl FileHandle for NotesHandle {
	async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		let mut pos = self.pos.lock();
		let n = (NOTES.len() - *pos).min(buf.len());
		buf[..n].copy_from_slice(&NOTES[*pos..*pos + n]);
		*pos += n;
		Ok(n)
	}

	async fn write(&self, _buf: &[u8]) -> io::Result<usize> {
		Err(io::ErrorKind::PermissionDenied.into())
	}

	async fn seek(&self, pos: io::SeekFrom) -> io::Result<u64> {
		let mut at = self.pos.lock();
		*at = match pos {
			io::SeekFrom::Start(to) => usize::try_from(to).unwrap_or(usize::MAX).min(NOTES.len()),
			_ => return Err(io::ErrorKind::Unsupported.into()),
		};
		Ok(*at as u64)
	}

	async fn metadata(&self) -> io::Result<Metadata> {
		Ok(notes_meta())
	}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn utilities_read_provider_files() {
	let vfs = VfsFs::new(pi_vfs::Fs::new(Arc::new(Notes)), tokio::runtime::Handle::current());
	let cwd = std::env::current_dir().unwrap();
	let mut s = Session::new(SessionConfig {
		env:             env_with(&[]),
		cwd:             BString::from(cwd.as_os_str().as_bytes()),
		fs:              Box::new(vfs.clone()),
		vfs:             Some(vfs),
		runtime:         tokio::runtime::Handle::current(),
		output_decoding: None,
	})
	.unwrap();
	assert_eq!(out(&mut s, "sort mem://notes").await, "apple\npear\n");
	assert_eq!(out(&mut s, "head -n1 mem://notes").await, "pear\n");
	assert_eq!(out(&mut s, "cat mem://notes | sort | head -n1").await, "apple\n");
	assert_eq!(out(&mut s, "x=$(sort mem://notes); echo \"[$x]\"").await, "[apple\npear]\n");
}
