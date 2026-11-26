//! Memory rows and allocation counts, with a counting global
//! allocator (system allocator underneath, as `obash`):
//!
//! - **shell**: live bytes the `Shell` owns after `Shell::create` + `:`,
//!   measured as the bytes its drop frees (the shared engine's unit cache and
//!   the store are not the shell's). Target ≤ 64 KiB. The store's growth and
//!   the allocations of create + `:` are printed beside it.
//! - **idle vprocs**: background `idle` vprocs, where `idle` is a host task
//!   that stays pending until signalled (a `sleep` without a timer), started
//!   two ways ([`Fork`]): back to back (`idle &` repeated) and in a loop that
//!   writes `i` after each fork. Once every vproc is blocked, the shell's bytes
//!   are measured as above, for [`FEW`] and [`MANY`] vprocs; per vproc is the
//!   difference over [`MANY`] − [`FEW`] (vproc, job entry, task handle). Back
//!   to back the shell writes nothing between the forks, so the value is the
//!   same in every run: target ≤ 2,048 B ([`MAX_VPROC_NOWRITE_BYTES`]), a fixed
//!   margin that holds in every run: what a fork itself costs. In a loop each
//!   vproc also keeps the path to the counter that the shell copied when it
//!   wrote it after the fork, and the value moves by the shard the hasher puts
//!   the counter in. The retention line bounds that part alone: the loop value
//!   that at least [`RETAIN_AT_LEAST`] of [`RETAIN_PROCS`] child processes
//!   reach (each over [`RETAIN_NAMES`] counter names), less the back-to-back
//!   value (target [`MAX_RETAINED_BYTES`]). Each target says how it was set.
//!   The verdicts are printed only: the bench exits 0 on a `MISS`, and nothing
//!   runs it on its own, so a person or a Job reads them. The line after the
//!   loop's breaks its difference down by allocation size (8-byte classes, live
//!   allocations per vproc) to name the structures that cost the bytes, and the
//!   sizes line gives `size_of` of the engine structures an idle vproc holds
//!   (`pi_shell::bash::vproc_layout`), to match against those classes.
//! - **allocs**: allocations, reallocations and bytes per iteration of the
//!   loop/func/strops workloads with `EventMask::NONE` (the event-off path) and
//!   `DEFAULT` into a null sink, from two runs of different length on a warm
//!   engine (so compilation cancels out).
//!
//! Run (release): `cango bench -p pi-shell --bench memory`.
//! Output:
//!
//! ```text
//! memory shell: … bytes after create + `:` (target ≤ 65536) PASS|MISS; store +… bytes; create + `:` … allocs, … bytes
//! memory idle vprocs back to back: 16 → … bytes, 272 → … bytes; … bytes per vproc (target ≤ 2048) PASS|MISS
//! memory idle vprocs: 16 → … bytes, 272 → … bytes; … bytes per vproc in a loop writing `i` (…)
//! memory idle vproc allocations by size: 24-31 B ×1.00, …
//! memory idle vproc retention: … bytes per vproc (loop … B, reached by at least 5 of 128 processes × 16 names, less … B back to back; largest … B; … ms) (target ≤ 682) PASS|MISS
//! memory idle vproc retention classes: per name … B ×…, …; largest per process … B ×…
//! memory sizes: Vproc … B, Frame … B, Scratch … B, ScratchIo … B, ExecState … B…
//! allocs loop NONE: … allocs/iter, … reallocs/iter, … bytes/iter; per run … allocs
//! …
//! ```

mod common;
mod workloads;

use std::{
	alloc::{GlobalAlloc, Layout, System},
	collections::BTreeMap,
	fmt::Write as _,
	process::{Command, Stdio},
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	task::{Context, Poll, Waker},
	time::Instant,
};

use bstr::BString;
use pi_shell::{
	bash::{
		Cx, Engine, EngineConfig, EventMask, MemStore, Platform, Script, Shell, Signal, Step, Task,
		vproc_layout,
	},
	testkit::{FakeHost, NativeFn},
};

use crate::{
	common::{NullHost, UNBOUNDED, new_shell, run, verdict},
	workloads::Workload,
};

static ALLOCS: AtomicUsize = AtomicUsize::new(0);
static REALLOCS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);
static LIVE: AtomicUsize = AtomicUsize::new(0);

/// Size classes of [`SIZES`]: 8 bytes wide, the last one holds everything
/// from `8 * (CLASSES - 1)` bytes up.
const CLASSES: usize = 129;

/// Live allocations per size class.
static SIZES: [AtomicUsize; CLASSES] = [const { AtomicUsize::new(0) }; CLASSES];

/// Size class of an allocation of `size` bytes.
const fn class(size: usize) -> usize {
	let c = size / 8;
	if c < CLASSES { c } else { CLASSES - 1 }
}

/// The live allocations per size class now.
fn sizes() -> [usize; CLASSES] {
	std::array::from_fn(|c| SIZES[c].load(Ordering::Relaxed))
}

/// System allocator with counters.
struct Counting(System);

// SAFETY: every method forwards to System with its arguments unchanged and
// returns its result; the counter updates never allocate.
unsafe impl GlobalAlloc for Counting {
	unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
		// SAFETY: forwarded unchanged; the caller upholds `alloc`'s contract.
		let ptr = unsafe { self.0.alloc(layout) };
		if !ptr.is_null() {
			ALLOCS.fetch_add(1, Ordering::Relaxed);
			BYTES.fetch_add(layout.size(), Ordering::Relaxed);
			LIVE.fetch_add(layout.size(), Ordering::Relaxed);
			SIZES[class(layout.size())].fetch_add(1, Ordering::Relaxed);
		}
		ptr
	}

	unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
		// SAFETY: forwarded unchanged; the caller upholds `alloc_zeroed`'s
		// contract.
		let ptr = unsafe { self.0.alloc_zeroed(layout) };
		if !ptr.is_null() {
			ALLOCS.fetch_add(1, Ordering::Relaxed);
			BYTES.fetch_add(layout.size(), Ordering::Relaxed);
			LIVE.fetch_add(layout.size(), Ordering::Relaxed);
			SIZES[class(layout.size())].fetch_add(1, Ordering::Relaxed);
		}
		ptr
	}

	unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
		LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
		SIZES[class(layout.size())].fetch_sub(1, Ordering::Relaxed);
		// SAFETY: forwarded unchanged; `ptr` came from this allocator with
		// `layout`.
		unsafe { self.0.dealloc(ptr, layout) }
	}

	unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
		// SAFETY: forwarded unchanged; the caller upholds `realloc`'s
		// contract.
		let new = unsafe { self.0.realloc(ptr, layout, new_size) };
		if !new.is_null() {
			REALLOCS.fetch_add(1, Ordering::Relaxed);
			let old = layout.size();
			SIZES[class(old)].fetch_sub(1, Ordering::Relaxed);
			SIZES[class(new_size)].fetch_add(1, Ordering::Relaxed);
			if new_size >= old {
				BYTES.fetch_add(new_size - old, Ordering::Relaxed);
				LIVE.fetch_add(new_size - old, Ordering::Relaxed);
			} else {
				LIVE.fetch_sub(old - new_size, Ordering::Relaxed);
			}
		}
		new
	}
}

#[global_allocator]
static GLOBAL: Counting = Counting(System);

/// The counters at one point.
#[derive(Clone, Copy)]
struct Counts {
	allocs:   usize,
	reallocs: usize,
	bytes:    usize,
}

impl Counts {
	fn now() -> Self {
		Self {
			allocs:   ALLOCS.load(Ordering::Relaxed),
			reallocs: REALLOCS.load(Ordering::Relaxed),
			bytes:    BYTES.load(Ordering::Relaxed),
		}
	}

	/// What happened since `before`.
	const fn since(self, before: Self) -> Self {
		Self {
			allocs:   self.allocs - before.allocs,
			reallocs: self.reallocs - before.reallocs,
			bytes:    self.bytes - before.bytes,
		}
	}
}

fn live() -> usize {
	LIVE.load(Ordering::Relaxed)
}

const MAX_SHELL_BYTES: usize = 64 * 1024;
/// Bytes per idle vproc forked back to back ([`Fork::Back`]): the 2 KiB
/// target. With no write by the shell between the forks the value is the
/// same in every run, so a vproc that grows past the margin fails it in
/// every run. At Cut14 (34021711) it is 2,004 B in 3 of 3 rounds, a margin
/// of 44 B: planted allocations of 32 and 40 B per vproc pass, one of 96 B
/// fails. It was 2,013 B in 12 of 12 rounds at 29923cbf and in 3 of 3 at
/// Cut10 chain step 5 (a460228e), a margin of 35 B. Earlier trees, 3 rounds
/// each: 1,921 B at 9058ab9d; 1,889 B once forked vprocs own copy-on-write
/// images (d2d553c3, Cut7 a72018dd to Cut9 85936bf7); 1,897 B at chain step
/// 1; 1,909 B at steps 2' to 4. A waiting `break` (`Vproc::pending_break`,
/// step 1) and bash's kept statuses (`JobTable::bgp`, step 2), 8 B of
/// `Vproc` each, and each vproc's write keys (40 B of `Vproc` and one 64-71
/// B allocation, `Vproc::write_key`, step 5) added the bytes since d2d553c3.
/// Cut14's own `size_of` (Vproc 696 B, Frame 264 B, ExecState 392 B) is in
/// the size-guard comment of `vm/proc.rs`.
const MAX_VPROC_NOWRITE_BYTES: usize = 2048;
/// Bytes per idle vproc that a vproc forked in a loop keeps of the shell's
/// later writes (the retention line: the loop value its processes reach,
/// less the back-to-back value). An image shares the shell's maps, and when the
/// shell writes a variable it still shares with a child (the loop's
/// counter, and any variable the shell writes itself after a command), the
/// shell copies its path and the child keeps the earlier one: the shard
/// list, the shard and the entry with its name and value (`CowMap::insert`,
/// `CowMap::set`; finding: a background child keeps the old shard and
/// entry). A vproc must keep the state it was forked with, so those bytes
/// are the image's design; d2d553c3 brought them and took the loop from
/// 1,840 B (9058ab9d) past 2,048 B.
///
/// Their size depends on how full the shard is that the hasher puts the
/// written variable in. The hasher is one per process (`cow_map::HASHER`),
/// so one name in one process always gives the same class, and the classes
/// vary between processes. So the line runs [`RETAIN_PROCS`] child
/// processes, each running the loop once per name of [`RETAIN_NAMES`]
/// (each name its own shard), takes each process's largest value, and reads
/// the largest value that at least [`RETAIN_AT_LEAST`] processes reach.
/// The single largest is no reading: a rare process holds a fuller shard
/// (one more bucket class), and the maximum grows with the number of
/// processes. Measured in 40 runs of 128 processes (20 on runc, 20 on
/// gVisor; 5.2-5.5 s each): with the counter alone, 5 of 5,120 processes
/// reached that tail (2,467 B against the top class 2,323), at most one in
/// a run; with one more written variable, 7 of 5,120 (2,696 or 2,732 B
/// against 2,660), at most two in a run, while the top class itself was
/// reached by 16 to 34 processes a run. At those rates five tail processes
/// in one run (a MISS for no change) has a chance near 1e-6, and fewer than
/// five at the top class (a reading that cannot see) near 4e-7.
///
/// The bound is the top class with one more written variable than the
/// counter (647 B on this tree's base, 2,660 − 2,013; the same 646 B on
/// 2de01417, 2,563 − 1,917, as the cause predicts across both bases) plus
/// a margin of 35 B. It allows one more retained entry per child because
/// #235 writes `_` after every command, so it no longer catches a second
/// retained entry of up to 337 B at a tree where only the counter is written
/// (top class 310 B); once #235 is in, it catches any retention growth over
/// 35 B. At Cut14 (34021711), with the counter alone, it reads 318 B in 3
/// of 3 rounds: one retained allocation moved from the 128-135 B class to
/// 136-143 B with bash's kept `wait` statuses and killed-command notice
/// (107e2d7b).
const MAX_RETAINED_BYTES: usize = 682;
/// Child processes the retention line reads.
const RETAIN_PROCS: usize = 128;
/// Loop runs, each writing a variable of its own name, in each child.
const RETAIN_NAMES: usize = 16;
/// The retention line reads the largest value at least this many of its
/// processes reach.
const RETAIN_AT_LEAST: usize = 5;
/// Set in a child of the retention line: it prints [`CHILD_LINE`] and ends.
const CHILD_ENV: &str = "PI_SHELL_MEMORY_BENCH_LOOP_CHILD";
/// A child's line: each name's bytes per vproc in the loop.
const CHILD_LINE: &str = "memory loop child:";

/// Idle vprocs in the small and the large case.
const FEW: u32 = 16;
const MANY: u32 = 272;

/// Iterations of the short and the long allocation run.
const SHORT: u32 = 1_000;
const LONG: u32 = 3_000;

/// A task that stays pending until signalled; holds no timer and never
/// wakes itself.
struct Idle {
	waker:  Option<Waker>,
	status: Option<i32>,
}

impl Task for Idle {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<i32> {
		if let Some(status) = self.status {
			return Poll::Ready(status);
		}
		self.waker = Some(cx.waker().clone());
		Poll::Pending
	}

	fn signal(&mut self, sig: Signal) {
		self.status = Some(128 + i32::from(sig.number(Platform::Linux)));
		if let Some(w) = self.waker.take() {
			w.wake();
		}
	}
}

fn idle_host() -> NullHost {
	let mut host = FakeHost::new();
	let make: NativeFn =
		Arc::new(|_: &[BString]| Box::new(Idle { waker: None, status: None }) as Box<dyn Task>);
	host.native("idle", make, None);
	NullHost(host)
}

/// Bytes a shell owns: what dropping it frees.
fn owned(shell: Shell) -> usize {
	let before = live();
	drop(shell);
	before.saturating_sub(live())
}

/// How [`with_idle`] starts its idle vprocs.
#[derive(Clone, Copy)]
enum Fork<'a> {
	/// `idle &` repeated: the shell writes nothing between the forks, so each
	/// vproc holds only what its fork gave it.
	Back,
	/// `idle & v=$((v+1))` in a loop, for the variable named here: the shell
	/// writes it after each fork, so each vproc's image also keeps the path
	/// to it the shell copied.
	Loop(&'a str),
}

/// The bytes of a shell after `:` and `n` idle background vprocs started as
/// `fork` says, and the process's live allocations per size class just
/// before its drop.
fn with_idle(engine: &Arc<Engine>, n: u32, fork: Fork<'_>) -> (usize, [usize; CLASSES]) {
	let src = match fork {
		Fork::Back => "idle &\n".repeat(n as usize),
		Fork::Loop(v) => {
			format!(r#"{v}=0; while [ "${v}" -lt {n} ]; do idle & {v}=$(({v}+1)); done"#)
		},
	};
	let mut host = idle_host();
	let mut store = MemStore::new();
	let mut shell = new_shell(engine, &mut host, &mut store);
	shell.set_event_mask(EventMask::NONE);
	assert_eq!(run(&mut shell, &mut host, &mut store, b":"), 0, "`:` succeeds");
	let id = shell.submit(Script::command(src.into_bytes()));
	let mut done = false;
	loop {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, UNBOUNDED) {
			Step::Done { run, status } if run == id => {
				assert_eq!(status, 0, "the script succeeds");
				done = true;
			},
			Step::Done { .. } | Step::Yield => {},
			Step::Blocked if done => break,
			other => panic!("{other:?} while starting {n} idle vprocs"),
		}
	}
	assert_eq!(host.0.live_tasks(), n as usize, "every idle vproc holds its task");
	let live = sizes();
	let bytes = owned(shell);
	host.0.assert_released();
	(bytes, live)
}

/// Bytes per idle vproc started as `fork` says: the bytes at [`FEW`] and at
/// [`MANY`], the difference per vproc, and each case's live allocations
/// per size class. Each size runs once untimed first, so its unit is cached.
fn per_vproc(
	engine: &Arc<Engine>,
	fork: Fork<'_>,
) -> (usize, usize, usize, [usize; CLASSES], [usize; CLASSES]) {
	with_idle(engine, FEW, fork);
	with_idle(engine, MANY, fork);
	let (few, few_sizes) = with_idle(engine, FEW, fork);
	let (many, many_sizes) = with_idle(engine, MANY, fork);
	let per = many.saturating_sub(few) / (MANY - FEW) as usize;
	(few, many, per, few_sizes, many_sizes)
}

/// A child of the retention line: the loop once per name `v0`.. of
/// [`RETAIN_NAMES`], each name's bytes per vproc on one [`CHILD_LINE`].
fn loop_child(engine: &Arc<Engine>) {
	let mut line = String::from(CHILD_LINE);
	for k in 0..RETAIN_NAMES {
		// One width for every name, so a name's length moves no value.
		let (_, _, per, ..) = per_vproc(engine, Fork::Loop(&format!("v{k:02}")));
		let _ = write!(line, " {per}");
	}
	println!("{line}");
}

/// The loop values of [`RETAIN_PROCS`] child processes, run at once, one
/// list per child with one value per name. A child that fails, or prints
/// no full line, fails the bench: a missing child is no measurement.
fn loop_children() -> Vec<Vec<usize>> {
	let exe = std::env::current_exe().expect("the bench's own path");
	#[expect(
		clippy::needless_collect,
		reason = "start every child before waiting on any, so they run at once"
	)]
	let kids: Vec<_> = (0..RETAIN_PROCS)
		.map(|_| {
			Command::new(&exe)
				.env(CHILD_ENV, "1")
				.stdout(Stdio::piped())
				.spawn()
				.expect("a child of the bench starts")
		})
		.collect();
	kids
		.into_iter()
		.map(|kid| {
			let out = kid.wait_with_output().expect("a child of the bench ends");
			assert!(out.status.success(), "a child of the bench failed: {}", out.status);
			let text = String::from_utf8_lossy(&out.stdout);
			let values: Vec<usize> = text
				.lines()
				.find_map(|l| l.strip_prefix(CHILD_LINE))
				.expect("a child prints its line")
				.split_whitespace()
				.map(|v| v.parse().expect("a child prints byte counts"))
				.collect();
			assert_eq!(values.len(), RETAIN_NAMES, "a child measures every name");
			values
		})
		.collect()
}

/// `values` as `<value> B ×<count>`, smallest first.
fn histogram(values: impl Iterator<Item = usize>) -> String {
	let mut counts = BTreeMap::new();
	for v in values {
		*counts.entry(v).or_insert(0_usize) += 1;
	}
	let parts: Vec<String> = counts.iter().map(|(v, n)| format!("{v} B ×{n}")).collect();
	parts.join(", ")
}

fn main() {
	let engine = Engine::new(EngineConfig::default());
	if std::env::var_os(CHILD_ENV).is_some() {
		loop_child(&engine);
		return;
	}

	// Shell baseline. Warm first: lazy statics, the engine's unit cache.
	for _ in 0..2 {
		let mut host = NullHost(FakeHost::new());
		let mut store = MemStore::new();
		let mut shell = new_shell(&engine, &mut host, &mut store);
		run(&mut shell, &mut host, &mut store, b":");
	}
	let mut host = NullHost(FakeHost::new());
	let mut store = MemStore::new();
	let (live0, c0) = (live(), Counts::now());
	let mut shell = new_shell(&engine, &mut host, &mut store);
	assert_eq!(run(&mut shell, &mut host, &mut store, b":"), 0, "`:` succeeds");
	let work = Counts::now().since(c0);
	let shell_bytes = owned(shell);
	let store_bytes = live().saturating_sub(live0);
	println!(
		"memory shell: {shell_bytes} bytes after create + `:` (target ≤ {MAX_SHELL_BYTES}) {}; \
		 store +{store_bytes} bytes; create + `:` {} allocs, {} reallocs, {} bytes",
		verdict(shell_bytes <= MAX_SHELL_BYTES),
		work.allocs,
		work.reallocs,
		work.bytes
	);

	// Idle vprocs.
	let (few, many, back, ..) = per_vproc(&engine, Fork::Back);
	println!(
		"memory idle vprocs back to back: {FEW} → {few} bytes, {MANY} → {many} bytes; {back} bytes \
		 per vproc (target ≤ {MAX_VPROC_NOWRITE_BYTES}) {}",
		verdict(back <= MAX_VPROC_NOWRITE_BYTES)
	);
	let (few, many, per, few_sizes, many_sizes) = per_vproc(&engine, Fork::Loop("i"));
	println!(
		"memory idle vprocs: {FEW} → {few} bytes, {MANY} → {many} bytes; {per} bytes per vproc in a \
		 loop writing `i` (this process's class; the retention line bounds the largest)"
	);
	let mut breakdown = String::new();
	for (c, (&m, &f)) in many_sizes.iter().zip(&few_sizes).enumerate() {
		let per_vproc = (m as f64 - f as f64) / f64::from(MANY - FEW);
		if per_vproc.abs() >= 0.05 {
			let (lo, hi) = (c * 8, c * 8 + 7);
			let range = if c + 1 == CLASSES {
				format!("≥{lo} B")
			} else {
				format!("{lo}-{hi} B")
			};
			let _ = write!(breakdown, " {range} ×{per_vproc:.2},");
		}
	}
	println!("memory idle vproc allocations by size:{}", breakdown.trim_end_matches(','));
	// Retention: each child's largest loop value (the hasher, and so the
	// class, is one per process), then the largest value at least
	// RETAIN_AT_LEAST children reach, less back to back.
	let started = Instant::now();
	let kids = loop_children();
	let mut tops: Vec<usize> = kids
		.iter()
		.map(|k| k.iter().copied().max().unwrap_or(0))
		.collect();
	tops.sort_unstable_by(|a, b| b.cmp(a));
	let reached = tops.get(RETAIN_AT_LEAST - 1).copied().unwrap_or(0);
	let retained = reached.saturating_sub(back);
	println!(
		"memory idle vproc retention: {retained} bytes per vproc (loop {reached} B, reached by at \
		 least {RETAIN_AT_LEAST} of {} processes × {RETAIN_NAMES} names, less {back} B back to \
		 back; largest {} B; {} ms) (target ≤ {MAX_RETAINED_BYTES}) {}",
		kids.len(),
		tops.first().copied().unwrap_or(0),
		started.elapsed().as_millis(),
		verdict(retained <= MAX_RETAINED_BYTES)
	);
	println!(
		"memory idle vproc retention classes: per name {}; largest per process {}",
		histogram(kids.iter().flatten().copied()),
		histogram(tops.iter().copied())
	);
	let mut sizes = String::new();
	for (name, bytes) in vproc_layout() {
		let _ = write!(sizes, " {name} {bytes} B,");
	}
	println!("memory sizes:{}", sizes.trim_end_matches(','));

	// Allocations per iteration.
	for workload in [Workload::Loop, Workload::Func, Workload::Strops] {
		let (short, long) = (workload.script(SHORT), workload.script(LONG));
		for (mask_name, mask) in [("NONE", EventMask::NONE), ("DEFAULT", EventMask::DEFAULT)] {
			let counts = |src: &[u8]| {
				let mut host = NullHost(FakeHost::new());
				let mut store = MemStore::new();
				let mut shell = new_shell(&engine, &mut host, &mut store);
				shell.set_event_mask(mask);
				let before = Counts::now();
				assert_eq!(run(&mut shell, &mut host, &mut store, src), 0, "the workload succeeds");
				Counts::now().since(before)
			};
			counts(short.as_slice());
			counts(long.as_slice());
			let (a, b) = (counts(short.as_slice()), counts(long.as_slice()));
			let iters = f64::from(LONG - SHORT);
			let per_iter = |x: usize, y: usize| y.saturating_sub(x) as f64 / iters;
			let allocs = per_iter(a.allocs, b.allocs);
			println!(
				"allocs {} {mask_name}: {allocs:.2} allocs/iter, {:.2} reallocs/iter, {:.1} \
				 bytes/iter; per run {:.0} allocs",
				workload.name(),
				per_iter(a.reallocs, b.reallocs),
				per_iter(a.bytes, b.bytes),
				allocs.mul_add(-f64::from(SHORT), a.allocs as f64)
			);
		}
	}
}
