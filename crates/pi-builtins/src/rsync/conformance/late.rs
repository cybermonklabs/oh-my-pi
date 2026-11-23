//! Both sides of the list-arrival race, recorded from the reference, against
//! ours in its own order and ours with its receiver starting late (see the
//! parent module and the `generator` module). No reference binary is needed.
//!
//! Each text is rsync 3.5.1's normalized stdout for one local scenario. In the
//! early order `sub/`'s file list reached its generator before the output pass
//! at the end of the top-level list, so a line about `sub/` comes before the
//! top-level items; in the late order it comes after them. The late texts were
//! recorded under gVisor, where the reference took that side in most runs (in 4
//! to 18 of 20 test runs per scenario it took it in all of its 31 runs); the
//! early texts on a Linux host, where it took the early side in most runs (in
//! 40 runs: 37 of `delete`, 28 of `dry_run`, 37 of `delete_excluded`, 37 of
//! `delete_v`, 38 of `safe_links_v`). Outside those lines the two orders print
//! the same lines; `archive_vv_stale`, whose pending messages are `-vv` lines,
//! prints the same lines in both and is not here.
//!
//! The summary's byte counts are recorded but not compared: they depend on the
//! host (`-a` sends the user and group names) and on a race of the sender's
//! frames that both implementations have. The comparison against a reference
//! run on the same host covers them (parent module). To record a text again:
//! run the scenario's arguments with the reference rsync 3.5.1 in its fixture
//! and `LC_ALL=C.UTF-8`, and replace the summary's rate with `#`; the late order
//! comes in nearly every run under gVisor and in about 1 run in 10 natively.

use std::fs;
use std::path::Path;

use super::{Bench, Client, Mode, cases, late_side_match, messages_earlier, race_only, split_summary};

/// `delete` and `dry_run` (which prints the same), late: `*deleting   sub/extra2`
/// after the top-level items.
const DELETE_LATE: &str = r"*deleting   extradir/x.txt
*deleting   extradir/
*deleting   junk.o
*deleting   extra.txt
.d..t...... ./
>f+++++++++ -dash
>f+++++++++ .rsync-filter
>f+++++++++ a.tmp
cL+++++++++ abs -> /nonexistent/abs/target
>f..t...... big.bin
cL+++++++++ dangling -> missing-file
cL+++++++++ dirlink -> sub
>f+++++++++ empty
>f+++++++++ exec.sh
cS+++++++++ fifo
>f+++++++++ hl1
>f+++++++++ hl2
>f..t...... mid.bin
>f+++++++++ obj.o
>f+++++++++ private.txt
cL+++++++++ rel -> small.txt
>f.stp..... ro.txt
>f..t...... with space.txt
>f+++++++++ zeros.bin
>f+++++++++ ünï cødé.txt
*deleting   sub/extra2
cd+++++++++ emptydir/
cd+++++++++ sgid/
>f+++++++++ sgid/f
.d..t...... sub/
>f+++++++++ sub/.rsync-filter
>f+++++++++ sub/hl3
>f+++++++++ sub/inner.txt
cL+++++++++ sub/unsafe -> ../../outside.txt
>f+++++++++ sub/x.o
cd+++++++++ sub/deep/
cd+++++++++ sub/deep/deeper/
>f+++++++++ sub/deep/deeper/leaf.txt
";

/// `delete` and `dry_run`, early: `*deleting   sub/extra2` before the top-level
/// items.
const DELETE_EARLY: &str = r"*deleting   extradir/x.txt
*deleting   extradir/
*deleting   junk.o
*deleting   extra.txt
*deleting   sub/extra2
.d..t...... ./
>f+++++++++ -dash
>f+++++++++ .rsync-filter
>f+++++++++ a.tmp
cL+++++++++ abs -> /nonexistent/abs/target
>f..t...... big.bin
cL+++++++++ dangling -> missing-file
cL+++++++++ dirlink -> sub
>f+++++++++ empty
>f+++++++++ exec.sh
cS+++++++++ fifo
>f+++++++++ hl1
>f+++++++++ hl2
>f..t...... mid.bin
>f+++++++++ obj.o
>f+++++++++ private.txt
cL+++++++++ rel -> small.txt
>f.stp..... ro.txt
>f..t...... with space.txt
>f+++++++++ zeros.bin
>f+++++++++ ünï cødé.txt
cd+++++++++ emptydir/
cd+++++++++ sgid/
>f+++++++++ sgid/f
.d..t...... sub/
>f+++++++++ sub/.rsync-filter
>f+++++++++ sub/hl3
>f+++++++++ sub/inner.txt
cL+++++++++ sub/unsafe -> ../../outside.txt
>f+++++++++ sub/x.o
cd+++++++++ sub/deep/
cd+++++++++ sub/deep/deeper/
>f+++++++++ sub/deep/deeper/leaf.txt
";

/// `delete_excluded`, late.
const DELETE_EXCLUDED_LATE: &str = r"*deleting   extradir/x.txt
*deleting   extradir/
*deleting   junk.o
*deleting   extra.txt
.d..t...... ./
>f+++++++++ -dash
>f+++++++++ .rsync-filter
>f+++++++++ a.tmp
cL+++++++++ abs -> /nonexistent/abs/target
>f..t...... big.bin
cL+++++++++ dangling -> missing-file
cL+++++++++ dirlink -> sub
>f+++++++++ empty
>f+++++++++ exec.sh
cS+++++++++ fifo
>f+++++++++ hl1
>f+++++++++ hl2
>f..t...... mid.bin
>f+++++++++ private.txt
cL+++++++++ rel -> small.txt
>f.stp..... ro.txt
>f..t...... with space.txt
>f+++++++++ zeros.bin
>f+++++++++ ünï cødé.txt
*deleting   sub/extra2
cd+++++++++ emptydir/
cd+++++++++ sgid/
>f+++++++++ sgid/f
.d..t...... sub/
>f+++++++++ sub/.rsync-filter
>f+++++++++ sub/hl3
>f+++++++++ sub/inner.txt
cL+++++++++ sub/unsafe -> ../../outside.txt
cd+++++++++ sub/deep/
cd+++++++++ sub/deep/deeper/
>f+++++++++ sub/deep/deeper/leaf.txt
";

/// `delete_excluded`, early.
const DELETE_EXCLUDED_EARLY: &str = r"*deleting   extradir/x.txt
*deleting   extradir/
*deleting   junk.o
*deleting   extra.txt
*deleting   sub/extra2
.d..t...... ./
>f+++++++++ -dash
>f+++++++++ .rsync-filter
>f+++++++++ a.tmp
cL+++++++++ abs -> /nonexistent/abs/target
>f..t...... big.bin
cL+++++++++ dangling -> missing-file
cL+++++++++ dirlink -> sub
>f+++++++++ empty
>f+++++++++ exec.sh
cS+++++++++ fifo
>f+++++++++ hl1
>f+++++++++ hl2
>f..t...... mid.bin
>f+++++++++ private.txt
cL+++++++++ rel -> small.txt
>f.stp..... ro.txt
>f..t...... with space.txt
>f+++++++++ zeros.bin
>f+++++++++ ünï cødé.txt
cd+++++++++ emptydir/
cd+++++++++ sgid/
>f+++++++++ sgid/f
.d..t...... sub/
>f+++++++++ sub/.rsync-filter
>f+++++++++ sub/hl3
>f+++++++++ sub/inner.txt
cL+++++++++ sub/unsafe -> ../../outside.txt
cd+++++++++ sub/deep/
cd+++++++++ sub/deep/deeper/
>f+++++++++ sub/deep/deeper/leaf.txt
";

/// `delete_v`, late: `deleting sub/extra2` after the top-level items.
const DELETE_V_LATE: &str = r"sending incremental file list
deleting extradir/x.txt
deleting extradir/
deleting junk.o
deleting extra.txt
./
-dash
.rsync-filter
a.tmp
abs -> /nonexistent/abs/target
big.bin
dangling -> missing-file
dirlink -> sub
empty
exec.sh
fifo
hl1
hl2
mid.bin
obj.o
private.txt
rel -> small.txt
ro.txt
with space.txt
zeros.bin
ünï cødé.txt
deleting sub/extra2
emptydir/
sgid/
sgid/f
sub/
sub/.rsync-filter
sub/hl3
sub/inner.txt
sub/unsafe -> ../../outside.txt
sub/x.o
sub/deep/
sub/deep/deeper/
sub/deep/deeper/leaf.txt

sent 2,065,669 bytes  received 535 bytes  # bytes/sec
total size is 2,063,417  speedup is 1.00
";

/// `delete_v`, early.
const DELETE_V_EARLY: &str = r"sending incremental file list
deleting extradir/x.txt
deleting extradir/
deleting junk.o
deleting extra.txt
deleting sub/extra2
./
-dash
.rsync-filter
a.tmp
abs -> /nonexistent/abs/target
big.bin
dangling -> missing-file
dirlink -> sub
empty
exec.sh
fifo
hl1
hl2
mid.bin
obj.o
private.txt
rel -> small.txt
ro.txt
with space.txt
zeros.bin
ünï cødé.txt
emptydir/
sgid/
sgid/f
sub/
sub/.rsync-filter
sub/hl3
sub/inner.txt
sub/unsafe -> ../../outside.txt
sub/x.o
sub/deep/
sub/deep/deeper/
sub/deep/deeper/leaf.txt

sent 2,065,675 bytes  received 531 bytes  # bytes/sec
total size is 2,063,417  speedup is 1.00
";

/// `safe_links_v`, late: `ignoring unsafe symlink "sub/unsafe"` after the
/// top-level items.
const SAFE_LINKS_V_LATE: &str = r#"sending incremental file list
created directory dst
ignoring unsafe symlink "abs" -> "/nonexistent/abs/target"
./
-dash
.rsync-filter
a.tmp
big.bin
dangling -> missing-file
dirlink -> sub
empty
exec.sh
fifo
hl1
hl2
mid.bin
obj.o
private.txt
rel -> small.txt
ro.txt
small.txt
with space.txt
zeros.bin
ünï cødé.txt
ignoring unsafe symlink "sub/unsafe" -> "../../outside.txt"
emptydir/
sgid/
sgid/f
sub/
sub/.rsync-filter
sub/hl3
sub/inner.txt
sub/x.o
sub/deep/
sub/deep/deeper/
sub/deep/deeper/leaf.txt

sent 2,065,718 bytes  received 626 bytes  # bytes/sec
total size is 2,063,417  speedup is 1.00
"#;

/// `safe_links_v`, early.
const SAFE_LINKS_V_EARLY: &str = r#"sending incremental file list
created directory dst
ignoring unsafe symlink "abs" -> "/nonexistent/abs/target"
ignoring unsafe symlink "sub/unsafe" -> "../../outside.txt"
./
-dash
.rsync-filter
a.tmp
big.bin
dangling -> missing-file
dirlink -> sub
empty
exec.sh
fifo
hl1
hl2
mid.bin
obj.o
private.txt
rel -> small.txt
ro.txt
small.txt
with space.txt
zeros.bin
ünï cødé.txt
emptydir/
sgid/
sgid/f
sub/
sub/.rsync-filter
sub/hl3
sub/inner.txt
sub/x.o
sub/deep/
sub/deep/deeper/
sub/deep/deeper/leaf.txt

sent 2,065,720 bytes  received 622 bytes  # bytes/sec
total size is 2,063,417  speedup is 1.00
"#;

/// stdout's lines but the byte-count summary, and whether it has one.
fn lines(out: &[u8]) -> (bool, Vec<String>) {
	let (summary, lines) = split_summary(out);
	(summary.is_some(), lines.iter().map(|line| String::from_utf8_lossy(line).into_owned()).collect())
}

/// Ours prints the reference's early order in its own order and the reference's
/// late order with a late receiver, line for line, and the two differ only as
/// the race makes them differ.
#[test]
fn ours_prints_both_orders_of_the_reference() {
	for (name, early, late_order) in [
		("delete", DELETE_EARLY, DELETE_LATE),
		("dry_run", DELETE_EARLY, DELETE_LATE),
		("delete_excluded", DELETE_EXCLUDED_EARLY, DELETE_EXCLUDED_LATE),
		("delete_v", DELETE_V_EARLY, DELETE_V_LATE),
		("safe_links_v", SAFE_LINKS_V_EARLY, SAFE_LINKS_V_LATE),
	] {
		let case = cases::LOCAL.iter().find(|c| c.name == name).expect("the scenario");
		let dir = tempfile::tempdir().unwrap();
		let base = fs::canonicalize(dir.path()).unwrap();
		// A local scenario never runs the reference.
		let bench = Bench::new(&base, Path::new("rsync"), Mode::Local, case.locale);
		let own = bench.run(case, "own", Client::Ours);
		let late = bench.run(case, "late", Client::OursLate);
		assert_eq!((own.code, late.code), (case.exit, case.exit), "{name}: exit codes");
		assert_eq!(lines(&own.out), lines(early.as_bytes()), "{name}: ours' own order is not the reference's early one");
		assert_eq!(lines(&late.out), lines(late_order.as_bytes()), "{name}: ours with a late receiver is not the reference's late order");
		assert!(messages_earlier(&own, &late), "{name}: ours' two orders differ by more than the race");
		assert!(!race_only(&late, &late), "{name}: an outcome is not the early side of itself");
	}
}

/// The late-side fallback's check takes the list-arrival race and nothing else:
/// a block of the generator's messages earlier in ours' own order, the same
/// bytes sent and 4 fewer received.
#[test]
fn race_only_takes_the_race_and_nothing_else() {
	let case = cases::LOCAL.iter().find(|c| c.name == "delete_v").expect("the scenario");
	let dir = tempfile::tempdir().unwrap();
	let base = fs::canonicalize(dir.path()).unwrap();
	let bench = Bench::new(&base, Path::new("rsync"), Mode::Local, case.locale);
	let late = bench.run(case, "late", Client::OursLate);
	let late_text = String::from_utf8(late.out.clone()).unwrap();
	let (sent, received) = split_summary(&late.out).0.expect("a summary");
	let summary = |sent: u64, received: u64| format!("sent {sent} bytes  received {received} bytes  # bytes/sec");
	let late_summary = late_text.lines().find(|line| line.starts_with("sent ")).expect("the summary line").to_owned();
	// Ours' own order with its stdout replaced: the late stdout with `line`
	// moved before `before` and the summary given.
	let own_with = |side: &str, line: &str, before: &str, sent: u64, received: u64| {
		let mut own = bench.run(case, side, Client::Ours);
		let text = late_text.replacen(&format!("{line}\n"), "", 1);
		let text = text.replacen(&format!("{before}\n"), &format!("{line}\n{before}\n"), 1);
		own.out = text.replacen(&late_summary, &summary(sent, received), 1).into_bytes();
		own
	};
	let own = bench.run(case, "own", Client::Ours);
	assert!(messages_earlier(&own, &late), "ours' real own order is the race's difference in its lines");
	let race = own_with("race", "deleting sub/extra2", "./", sent, received - 4);
	assert!(race_only(&race, &late), "the race's difference built by hand");
	for (what, line, before, own_sent, own_received) in [
		("an item line earlier", "-dash", "./", sent, received - 4),
		("a message later", "deleting extra.txt", "emptydir/", sent, received - 4),
		("the message ahead of earlier messages", "deleting sub/extra2", "deleting extradir/x.txt", sent, received - 4),
		("the same bytes received", "deleting sub/extra2", "./", sent, received),
		("8 bytes fewer received", "deleting sub/extra2", "./", sent, received - 8),
		("more bytes sent", "deleting sub/extra2", "./", sent + 4, received - 4),
	] {
		let changed = own_with(what, line, before, own_sent, own_received);
		assert!(!race_only(&changed, &late), "race_only took {what}:\n{}", String::from_utf8_lossy(&changed.out));
	}
}

/// The late-side fallback holds only where no reference outcome shows the early
/// side in its lines; a byte-count variant of the reference's late side (the
/// sender's frame race, which ours with a late receiver need not have shown in
/// its runs) does not turn it off, and an early side at the wrong place is not
/// taken.
#[test]
fn the_late_side_fallback_needs_no_early_side_in_the_reference() {
	let case = cases::LOCAL.iter().find(|c| c.name == "delete_v").expect("the scenario");
	let dir = tempfile::tempdir().unwrap();
	let base = fs::canonicalize(dir.path()).unwrap();
	let bench = Bench::new(&base, Path::new("rsync"), Mode::Local, case.locale);
	let late_run = bench.run(case, "late", Client::OursLate);
	let late_text = String::from_utf8(late_run.out.clone()).unwrap();
	let (sent, received) = split_summary(&late_run.out).0.expect("a summary");
	let late_summary = late_text.lines().find(|line| line.starts_with("sent ")).expect("the summary line").to_owned();
	// An outcome of a real run with its stdout replaced: the late stdout with
	// `line` moved before `before` (when given) and the summary given.
	let outcome = |side: &str, moved: Option<(&str, &str)>, sent: u64, received: u64| {
		let mut outcome = bench.run(case, side, Client::Ours);
		let mut text = late_text.clone();
		if let Some((line, before)) = moved {
			text = text.replacen(&format!("{line}\n"), "", 1);
			text = text.replacen(&format!("{before}\n"), &format!("{line}\n{before}\n"), 1);
		}
		let summary = format!("sent {sent} bytes  received {received} bytes  # bytes/sec");
		outcome.out = text.replacen(&late_summary, &summary, 1).into_bytes();
		outcome
	};
	let early_at = |side: &str, before: &str| outcome(side, Some(("deleting sub/extra2", before)), sent, received - 4);
	// Each outcome comes from a run in a work directory of its own.
	let late = vec![outcome("l", None, sent, received)];
	// The reference took the late side in every run, once with the sender's
	// frame variant: the fallback takes ours' own order.
	let seen = vec![outcome("r1", None, sent, received), outcome("r2", None, sent + 4, received + 4)];
	assert!(late_side_match(case, &[early_at("o1", "./")], &late, &seen).is_some());
	// The same with ours' message ahead of the earlier deletions: not the race.
	assert!(late_side_match(case, &[early_at("o2", "deleting extradir/x.txt")], &late, &seen).is_none());
	// The reference showed the early side once: the fallback is off, even for
	// ours' own order at the right place; only an exact match passes.
	let seen = vec![outcome("r3", None, sent, received), early_at("r4", "./")];
	assert!(late_side_match(case, &[early_at("o3", "./")], &late, &seen).is_none());
}
