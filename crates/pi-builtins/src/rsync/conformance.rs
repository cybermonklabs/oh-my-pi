//! Differential conformance suite: the builtin against the reference rsync
//! 3.5.1 on identical fixtures.
//!
//! Every scenario (see [`cases`]) builds the same fixture ([`fixture`]) twice,
//! in `<base>/ours` and `<base>/theirs`, runs the builtin
//! ([`run_util`]) in one and the reference binary in the other with the same
//! arguments, and requires equal:
//!
//! - exit codes (and both equal to the table's expected code);
//! - stdout and stderr after [`normalize`] (each rule is documented there);
//! - the work directory afterwards ([`snapshot`]): names, types, contents,
//!   permission bits, owners, mtimes (to the nanosecond when not set by the
//!   run itself), symlink targets, hard-link groups, empty directories.
//!
//! The reference itself is not deterministic run to run: its three local
//! processes (and a remote peer) report through one stream, so sender,
//! generator, and receiver lines interleave differently, and its byte totals
//! (`Total bytes sent/received`, the `sent … received …` summary) depend on
//! how many multiplexed frames each run happened to flush. Rather than mask
//! those values, the comparison stays exact and samples both clients: ours
//! races the same way (its sender, generator, and receiver are threads), so
//! when the outcomes differ in any way, each client is rerun on a fresh
//! fixture up to [`RETRIES`] times, and the scenario passes once some outcome
//! of ours exactly equals (exit code, normalized stdout and stderr, tree) some
//! reference outcome. A real bug still fails because no outcome of ours
//! matches; the failure report names how many distinct outcomes each client
//! produced and diffs the first of each.
//!
//! One of those races ours does not sample, because its generator takes one
//! side of it on purpose (see the `generator` module): whether a subdirectory's
//! file list reaches the generator before its output pass at the end of the
//! list before it (a `--delete` run's `*deleting   sub/…` before the top-level
//! items) or after it (that line after them, and 4 bytes more received). The
//! reference took the first side in 85 of 100 runs on a Linux host and the
//! second in most runs under gVisor, where its receiver process starts late.
//! So each attempt runs ours both in its own order and with its receiver
//! starting late, and [`check`] accepts the late side only where no reference
//! run shows the early side; wherever one does, ours' own order must match.
//!
//! The reference runs with an empty environment (plus `TZ` when set, so
//! local-time output uses one zone on both sides), matching the test host's
//! empty shell environment; the fake remote shell, the reference server, and
//! the password files are named by the same absolute paths on both sides.
//! The suite skips itself when no rsync 3.5.1 is installed. Set
//! `RSYNC_CONFORMANCE_FILTER=<substring>` to run only matching scenarios.
#![cfg(unix)]

mod cases;
mod daemon;
mod fixture;
mod late;
mod normalize;
mod snapshot;

use std::fmt::Write as _;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use self::daemon::Daemon;
use self::normalize::normalize;
use self::snapshot::Snapshot;
use crate::host::run_util;
use crate::rsync::{Rsync, generator};

/// How many extra runs of each client a mismatch gets.
const RETRIES: usize = 8;

/// One scenario: see [`cases`] for the field conventions.
struct Case {
	name: &'static str,
	exit: i32,
	tweaks: &'static str,
	args: &'static [&'static str],
	/// Compare stdout as a sorted multiset of lines.
	unordered: bool,
	/// Its output shows the list-arrival race (see [`check`]).
	list_race: bool,
}

/// A table row.
const fn c(name: &'static str, exit: i32, tweaks: &'static str, args: &'static [&'static str]) -> Case {
	Case { name, exit, tweaks, args, unordered: false, list_race: false }
}

/// A table row whose stdout order is racy in the reference.
const fn u(name: &'static str, exit: i32, tweaks: &'static str, args: &'static [&'static str]) -> Case {
	Case { name, exit, tweaks, args, unordered: true, list_race: false }
}

/// A table row whose output shows the list-arrival race: a message about
/// `sub/` or the byte totals differ with the side the reference takes.
const fn l(name: &'static str, exit: i32, tweaks: &'static str, args: &'static [&'static str]) -> Case {
	Case { name, exit, tweaks, args, unordered: false, list_race: true }
}

/// How the scenario reaches its peer.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
	Local,
	/// `-e {RSH} --rsync-path={REF}` prepended.
	Rsh,
	/// A reference daemon per side; `{PORT}` is its port.
	Daemon,
}

/// Which client runs.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Client {
	Ours,
	/// Ours with its receiver starting late (`generator::receiver_starting_late`).
	OursLate,
	Reference,
}

/// Everything compared about one run.
#[derive(PartialEq, Eq)]
struct Outcome {
	code: i32,
	out: Vec<u8>,
	err: Vec<u8>,
	tree: Snapshot,
}

/// The reference rsync 3.5.1 binary, when one is installed. Other versions
/// are skipped: the builtin's output is byte-for-byte 3.5.1's.
fn reference() -> Option<PathBuf> {
	let mut candidates = vec![PathBuf::from("/opt/homebrew/bin/rsync")];
	if let Some(path) = std::env::var_os("PATH") {
		candidates.extend(std::env::split_paths(&path).map(|d| d.join("rsync")));
	}
	candidates.into_iter().find(|p| {
		Command::new(p).arg("--version").env_clear().output().is_ok_and(|o| {
			String::from_utf8_lossy(&o.stdout).starts_with("rsync  version 3.5.1  protocol version 33\n")
		})
	})
}

fn now_ns() -> i128 {
	SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as i128
}

/// Shared per-scenario state: the base directory holding both sides plus the
/// helpers both clients use by the same absolute path.
struct Bench {
	base: PathBuf,
	reference: PathBuf,
	mode: Mode,
}

impl Bench {
	fn new(base: &Path, reference: &Path, mode: Mode) -> Self {
		let bin = base.join("bin");
		fs::create_dir_all(&bin).unwrap();
		// Like ssh, the fake remote shell drops the host name and hands the
		// rest to a shell as one command line (so `--old-args` word splitting
		// happens remotely). The remote command runs in the client's cwd.
		let rsh = bin.join("fakersh");
		fs::write(&rsh, "#!/bin/sh\nshift\nexec /bin/sh -c \"$*\"\n").unwrap();
		fs::set_permissions(&rsh, fs::Permissions::from_mode(0o755)).unwrap();
		for (name, password) in [("pw", "sekrit\n"), ("badpw", "wrong\n")] {
			let file = bin.join(name);
			fs::write(&file, password).unwrap();
			fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
		}
		Self { base: base.to_path_buf(), reference: reference.to_path_buf(), mode }
	}

	/// The scenario's argv for a daemon on `port`.
	fn argv(&self, case: &Case, port: u16) -> Vec<String> {
		let bin = self.base.join("bin");
		let rsh = bin.join("fakersh");
		let subst = |arg: &str| {
			arg.replace("{RSH}", &rsh.display().to_string())
				.replace("{REF}", &self.reference.display().to_string())
				.replace("{BIN}", &bin.display().to_string())
				.replace("{PORT}", &port.to_string())
		};
		let mut argv = Vec::new();
		if self.mode == Mode::Rsh {
			argv.extend(["-e".to_owned(), subst("{RSH}"), subst("--rsync-path={REF}")]);
		}
		argv.extend(case.args.iter().map(|a| subst(a)));
		argv
	}

	/// Builds the fixture in `<base>/<side>` and runs `client` there.
	fn run(&self, case: &Case, side: &str, client: Client) -> Outcome {
		let w = self.base.join(side);
		fs::create_dir_all(&w).unwrap();
		fixture::build(&w, case.tweaks);
		let daemon = (self.mode == Mode::Daemon).then(|| {
			fixture::module_root(&w);
			Daemon::start(&self.reference, &self.base.join(format!("daemon-{side}")), &w)
		});
		let argv = self.argv(case, daemon.as_ref().map_or(0, |d| d.port));
		let start = now_ns();
		let (code, out, err) = match client {
			Client::Ours | Client::OursLate => {
				let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
				let late = client == Client::OursLate;
				let (code, cap) = generator::receiver_starting_late(late, || run_util::<Rsync>(&refs, "", &w));
				(code, cap.stdout(), cap.stderr())
			}
			Client::Reference => {
				let mut cmd = Command::new(&self.reference);
				cmd.args(&argv).current_dir(&w).env_clear();
				if let Some(tz) = std::env::var_os("TZ") {
					cmd.env("TZ", tz);
				}
				let output = cmd.output().unwrap();
				(output.status.code().unwrap_or(-1), output.stdout, output.stderr)
			}
		};
		let end = now_ns();
		drop(daemon);
		let window = ((start / 1_000_000_000) as i64, (end / 1_000_000_000) as i64);
		let wb = w.as_os_str().as_bytes();
		let mut out = normalize(&out, wb, window);
		if case.unordered {
			let sorted = sorted_lines(&out).join(&b'\n');
			out = sorted;
		}
		Outcome {
			code,
			out,
			err: normalize(&err, wb, window),
			tree: Snapshot::take(&w, start, end),
		}
	}
}

fn sorted_lines(data: &[u8]) -> Vec<&[u8]> {
	let mut lines: Vec<&[u8]> = data.split(|&byte| byte == b'\n').collect();
	lines.sort_unstable();
	lines
}

/// Whether an outcome of ours in its own order (`own`) differs from one with a
/// late receiver (`late`) exactly as the list-arrival race makes them differ.
/// With a summary: the same bytes sent, 4 (one frame header) fewer received,
/// and otherwise [`messages_earlier`]. Without one, only moved messages show
/// the race: [`moved_earlier`].
fn race_only(own: &Outcome, late: &Outcome) -> bool {
	match (split_summary(&own.out).0, split_summary(&late.out).0) {
		(Some((sent, received)), Some((late_sent, late_received))) => {
			sent == late_sent && received + 4 == late_received && messages_earlier(own, late)
		}
		(None, None) => moved_earlier(own, late),
		_ => false,
	}
}

/// Whether `own` is [`messages_earlier`] than `late` with at least one line
/// moved: the early side of the race, where it shows in the lines.
fn moved_earlier(own: &Outcome, late: &Outcome) -> bool {
	messages_earlier(own, late) && split_summary(&own.out).1 != split_summary(&late.out).1
}

/// Whether no reference outcome (`seen`) of a [`l`] scenario shows the early
/// side of the list-arrival race: none is [`moved_earlier`] than an outcome of
/// ours with a late receiver. The byte counts do not tell the sides apart: a
/// second race, of the sender's frames, moves them in both clients.
fn late_side_only(case: &Case, late: &[Outcome], seen: &[Outcome]) -> bool {
	case.list_race && !seen.iter().any(|theirs| late.iter().any(|ours| moved_earlier(theirs, ours)))
}

/// The outcome of ours with a late receiver that the late-side fallback of
/// [`check`] accepts: one a reference outcome equals, with an outcome of ours
/// in its own order that is its early side ([`race_only`]). Only where
/// [`late_side_only`].
fn late_side_match<'a>(case: &Case, mine: &[Outcome], late: &'a [Outcome], seen: &[Outcome]) -> Option<&'a Outcome> {
	if !late_side_only(case, late, seen) {
		return None;
	}
	late.iter().find(|late| seen.contains(late) && mine.iter().any(|own| race_only(own, late)))
}

/// Whether `own` and `late` have the same exit code, stderr and tree, and the
/// same stdout lines but the byte-count summary and one block of the
/// generator's messages ([`generator_message`]) that comes earlier in `own`,
/// ahead of data lines it overtook. Messages keep their order among
/// themselves: the generator writes them through one queue.
fn messages_earlier(own: &Outcome, late: &Outcome) -> bool {
	if own.code != late.code || own.err != late.err || own.tree != late.tree {
		return false;
	}
	let (a, b) = (split_summary(&own.out).1, split_summary(&late.out).1);
	if a.len() != b.len() {
		return false;
	}
	let head = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
	if head == a.len() {
		return true;
	}
	let tail = a.iter().rev().zip(b.iter().rev()).take_while(|(x, y)| x == y).count();
	let (a, b) = (&a[head..a.len() - tail], &b[head..b.len() - tail]);
	// `own`'s rest is `late`'s rest with a block of messages from its end moved
	// to the front, over data lines only.
	(1..b.len()).any(|cut| {
		a[..b.len() - cut] == b[cut..]
			&& a[b.len() - cut..] == b[..cut]
			&& b[cut..].iter().all(|line| generator_message(line))
			&& !b[..cut].iter().any(|line| generator_message(line))
	})
}

/// A line the generator of a [`l`] scenario sends as a message when it starts
/// `sub/`'s file list.
fn generator_message(line: &[u8]) -> bool {
	line.starts_with(b"*deleting ") || line.starts_with(b"deleting ") || line.starts_with(b"ignoring unsafe symlink ")
}

/// stdout's `sent N bytes  received M bytes` summary as (N, M), and its other
/// lines.
fn split_summary(out: &[u8]) -> (Option<(u64, u64)>, Vec<&[u8]>) {
	let count = |text: &[u8]| -> Option<u64> {
		let digits: Vec<u8> = text.iter().copied().filter(|byte| *byte != b',').collect();
		std::str::from_utf8(&digits).ok()?.parse().ok()
	};
	let find = |text: &[u8], needle: &[u8]| text.windows(needle.len()).position(|w| w == needle);
	let parse = |line: &[u8]| -> Option<(u64, u64)> {
		const RECEIVED: &[u8] = b" bytes  received ";
		let rest = line.strip_prefix(b"sent ")?;
		let at = find(rest, RECEIVED)?;
		let sent = count(&rest[..at])?;
		let rest = &rest[at + RECEIVED.len()..];
		Some((sent, count(&rest[..find(rest, b" bytes")?])?))
	};
	let mut summary = None;
	let mut lines = Vec::new();
	for line in out.split(|&byte| byte == b'\n') {
		match parse(line) {
			Some(numbers) if summary.is_none() => summary = Some(numbers),
			_ => lines.push(line),
		}
	}
	(summary, lines)
}

/// Runs one scenario; `Err` carries the report.
///
/// Each attempt of a [`l`] scenario runs ours both in its own order and with its
/// receiver starting late. It passes when an outcome in its own order equals a
/// reference outcome. Failing that, it passes only when no reference outcome
/// shows the early side of the list-arrival race ([`moved_earlier`] than a late
/// outcome of ours), an outcome of ours with a late receiver equals a reference
/// outcome, and an outcome in its own order is that one with nothing but the
/// race's difference ([`race_only`]): ours' own order is sampled as the
/// comparison samples it everywhere, some run must be right. So wherever the
/// reference shows the early side even once, ours' own order must match it. The
/// sides are told apart by the lines, not the byte counts, which a second race
/// of the sender's frames also moves in both clients. Every other scenario runs
/// ours in its own order only.
fn check(reference: &Path, mode: Mode, case: &Case) -> Result<(), String> {
	let dir = tempfile::tempdir().unwrap();
	// Canonical, so the paths both clients print agree with what `getcwd`
	// reports to the reference (macOS: /var → /private/var).
	let base = fs::canonicalize(dir.path()).unwrap();
	let bench = Bench::new(&base, reference, mode);
	// Distinct outcomes so far, first run first: ours in its own order, ours with
	// a late receiver, and the reference.
	let mut mine: Vec<Outcome> = Vec::new();
	let mut late: Vec<Outcome> = Vec::new();
	let mut seen: Vec<Outcome> = Vec::new();
	let mut matched = None;
	for attempt in 0..=RETRIES {
		let mut clients = vec![(Client::Ours, format!("ours{attempt}"))];
		if case.list_race {
			clients.push((Client::OursLate, format!("late{attempt}")));
		}
		clients.push((Client::Reference, format!("theirs{attempt}")));
		for (client, side) in clients {
			let outcomes = match client {
				Client::Ours => &mut mine,
				Client::OursLate => &mut late,
				Client::Reference => &mut seen,
			};
			let outcome = bench.run(case, &side, client);
			if !outcomes.contains(&outcome) {
				outcomes.push(outcome);
			}
		}
		matched = mine.iter().find(|outcome| seen.contains(outcome));
		if matched.is_some() {
			break;
		}
	}
	if matched.is_none() {
		matched = late_side_match(case, &mine, &late, &seen);
	}
	let (ours, theirs) = match matched {
		Some(outcome) if outcome.code == case.exit => return Ok(()),
		Some(outcome) => (outcome, outcome),
		None => (&mine[0], &seen[0]),
	};
	let verdict = if matched.is_some() {
		format!("ours matched one of {} distinct reference outcome(s)", seen.len())
	} else {
		let race = match (case.list_race, late_side_only(case, &late, &seen)) {
			(false, _) => "",
			(true, true) => " (no reference outcome shows the early side of the list-arrival race, and no outcome of ours in its own order is the early side of a late one that matched)",
			(true, false) => " (a reference outcome shows the early side of the list-arrival race)",
		};
		format!(
			"none of {} distinct outcome(s) of ours in its own order matched any of {} distinct reference outcome(s){race}; diff of the first of each",
			mine.len(),
			seen.len(),
		)
	};
	let mut report = format!("{} {:?}\n  {verdict}\n", case.name, bench.argv(case, 0));
	if theirs.code != case.exit {
		writeln!(report, "  reference exited {} (table expects {})", theirs.code, case.exit).unwrap();
	}
	if ours.code != theirs.code {
		writeln!(report, "  exit: ours {} vs reference {}", ours.code, theirs.code).unwrap();
	}
	for (what, a, b) in [("stdout", &ours.out, &theirs.out), ("stderr", &ours.err, &theirs.err)] {
		if a != b {
			writeln!(
				report,
				"  {what} differs:\n--- ours\n{}--- reference\n{}---",
				String::from_utf8_lossy(a),
				String::from_utf8_lossy(b)
			)
			.unwrap();
		}
	}
	report.push_str(&ours.tree.diff(&theirs.tree));
	Err(report)
}

/// Runs every scenario of `table` (a few at a time) and fails with all reports.
fn run_table(mode: Mode, table: &[Case]) {
	let Some(reference) = reference() else { return };
	let filter = std::env::var("RSYNC_CONFORMANCE_FILTER").unwrap_or_default();
	let cases: Vec<&Case> = table.iter().filter(|c| c.name.contains(filter.as_str())).collect();
	let next = AtomicUsize::new(0);
	let failures = Mutex::new(Vec::new());
	let workers = std::thread::available_parallelism().map_or(2, |n| n.get().min(4));
	std::thread::scope(|scope| {
		for _ in 0..workers {
			scope.spawn(|| {
				while let Some(case) = cases.get(next.fetch_add(1, Ordering::Relaxed)) {
					let result = std::panic::catch_unwind(|| check(&reference, mode, case))
						.unwrap_or_else(|panic| {
							let text = panic
								.downcast_ref::<String>()
								.cloned()
								.or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_owned()))
								.unwrap_or_default();
							Err(format!("{}: harness panicked: {text}\n", case.name))
						});
					if let Err(report) = result {
						failures.lock().unwrap().push(report);
					}
				}
			});
		}
	});
	let mut failures = failures.into_inner().unwrap();
	failures.sort();
	assert!(
		failures.is_empty(),
		"{} of {} scenarios differ from rsync 3.5.1:\n\n{}",
		failures.len(),
		cases.len(),
		failures.join("\n")
	);
}

#[test]
fn local_transfers_match_reference() {
	run_table(Mode::Local, cases::LOCAL);
}

#[test]
fn remote_shell_transfers_match_reference() {
	run_table(Mode::Rsh, cases::RSH);
}

#[test]
fn daemon_transfers_match_reference() {
	run_table(Mode::Daemon, cases::DAEMON);
}
