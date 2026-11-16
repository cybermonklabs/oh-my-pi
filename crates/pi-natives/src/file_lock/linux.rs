use std::{
	collections::HashSet,
	io,
	os::{
		linux::net::SocketAddrExt,
		unix::net::{SocketAddr, UnixDatagram},
	},
	sync::{LazyLock, Mutex, MutexGuard, PoisonError},
	thread,
	time::{Duration, Instant},
};

/// Linux lock held by an abstract Unix-domain socket binding.
pub struct PlatformFileLock {
	socket: Option<UnixDatagram>,
	/// The name `socket` holds, in `HELD_NAMES` until `socket` closes.
	name:   String,
}

/// The abstract names the locks of this process hold.
// A name enters once its bind succeeds and leaves before its socket closes,
// so every name in the set is held.
static HELD_NAMES: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

/// `HELD_NAMES`, also after a thread panicked while it held the lock.
fn held_names() -> MutexGuard<'static, HashSet<String>> {
	HELD_NAMES.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How long after its first `AddrInUse` a claim keeps retrying the bind,
/// unless a lock of this process holds the name: that claim answers "taken"
/// at once.
// Under gVisor a probe of the name, a `connect(2)` or a read of
// `/proc/net/unix`, delays the release of a just-closed socket's name, so a
// bind that follows a release can fail with `AddrInUse` although no socket
// holds the name: measured on 2026-11-16, 144 of 100,000 release-then-claim
// rounds beside a `connect(2)` probe, 0 with no probe. A retried bind
// succeeded within 17 to 36 ms under load, and across 4 x 250,000 rounds
// beside a probe, retried `RETRY_PAUSE` apart, the longest of 714 such
// refusals lasted 12.3 ms; the bound leaves room above that.
const TRANSIENT_IN_USE_BOUND: Duration = Duration::from_millis(200);
/// How long a claim's own `connect(2)` calls must keep reaching a socket on
/// the name, with no refusal between them, before a refused bind answers
/// "taken".
// During a transient `AddrInUse` that connect is mostly refused but can reach
// a socket: in those 4 x 250,000 rounds up to 9 consecutive connects of one
// claim reached a socket during one refusal, a run of 1.7 ms, so a count of
// 10 answers is too close to what a just-released name gives. A lease truly
// held answers every connect, so a claim of it answers "taken" after about
// this long, well inside `TRANSIENT_IN_USE_BOUND`. A name a lock of this
// process holds needs no such evidence and answers "taken" at once: the claim
// is synchronous, so the wait would block the calling thread, which can be
// the thread the holder needs to finish and release.
const LIVE_HOLDER_WINDOW: Duration = Duration::from_millis(50);
/// The pause before each retried bind.
// Long enough not to spin against the probe, short against the 17 to 36 ms a
// transient `AddrInUse` lasted; the measurements above paused this long.
const RETRY_PAUSE: Duration = Duration::from_micros(100);

/// Claims the lock by binding a datagram socket to its abstract name, which
/// the kernel frees when that socket closes, at process exit too.
///
/// A bind refused with `AddrInUse` is retried `RETRY_PAUSE` apart, because
/// under gVisor a probe of the name can delay the release of a just-closed
/// socket's name. After each refusal the claim connects to the name itself:
/// it answers "taken" once those connects have reached a socket with no
/// refusal between them for `LIVE_HOLDER_WINDOW` (a refused or failed connect
/// starts the window again), or once `TRANSIENT_IN_USE_BOUND` has passed since
/// the first refusal, and never waits longer for a holder to release.
///
/// A refusal while a lock of this process holds the name answers "taken" at
/// once instead. That name is held for certain, and a wait would block the
/// calling thread, which may be the one the holder needs to finish and
/// release: claims from one JavaScript thread would each stall the holder for
/// `LIVE_HOLDER_WINDOW`.
pub fn try_acquire(path: &str) -> io::Result<Option<PlatformFileLock>> {
	let name = super::memory_lock_name(path);
	let address = SocketAddr::from_abstract_name(name.as_bytes())?;
	let mut first_refusal = None;
	// When the claim's current run of connects that reached a socket began.
	let mut live_since = None;
	loop {
		match UnixDatagram::bind_addr(&address) {
			Ok(socket) => {
				held_names().insert(name.clone());
				return Ok(Some(PlatformFileLock { socket: Some(socket), name }));
			},
			Err(error) if error.kind() == io::ErrorKind::AddrInUse => {},
			Err(error) => return Err(error),
		}
		if held_names().contains(&name) {
			return Ok(None);
		}
		let refused_at = *first_refusal.get_or_insert_with(Instant::now);
		// A refused or failed connect ends the run; the bound still ends the
		// retries.
		if matches!(connect_probe(&address), Ok(true)) {
			if live_since.get_or_insert_with(Instant::now).elapsed() >= LIVE_HOLDER_WINDOW {
				return Ok(None);
			}
		} else {
			live_since = None;
		}
		if refused_at.elapsed() >= TRANSIENT_IN_USE_BOUND {
			return Ok(None);
		}
		thread::sleep(RETRY_PAUSE);
	}
}

/// Probes by `connect(2)` to the lock's abstract name: a bound name accepts
/// the connection and a free one refuses it. Its cost does not depend on how
/// many sockets exist, and the probe binds nothing, so it never takes the
/// lock. Under gVisor it can delay the release of a just-closed holder's name,
/// a transient `AddrInUse` that `try_acquire` retries.
pub fn is_held(path: &str) -> io::Result<bool> {
	let name = super::memory_lock_name(path);
	connect_probe(&SocketAddr::from_abstract_name(name.as_bytes())?)
}

/// Whether a socket bound to `address` accepts a `connect(2)` from an unbound
/// datagram socket; a refusal means none does.
fn connect_probe(address: &SocketAddr) -> io::Result<bool> {
	match UnixDatagram::unbound()?.connect_addr(address) {
		Ok(()) => Ok(true),
		Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => Ok(false),
		Err(error) => Err(error),
	}
}

impl PlatformFileLock {
	#[allow(clippy::unnecessary_wraps, reason = "uniform cross-platform interface")]
	pub fn release(&mut self) -> io::Result<()> {
		if let Some(socket) = self.socket.take() {
			// Before the socket closes: a claim between the close and the
			// removal could meet a transient `AddrInUse`, find the name in the
			// set and answer "taken" for a free lease.
			held_names().remove(&self.name);
			drop(socket);
		}
		Ok(())
	}
}

impl Drop for PlatformFileLock {
	fn drop(&mut self) {
		let _ = self.release();
	}
}

#[cfg(test)]
mod tests {
	use std::{
		os::{
			linux::net::SocketAddrExt,
			unix::net::{SocketAddr, UnixDatagram},
		},
		sync::{
			Barrier,
			atomic::{AtomicBool, Ordering},
		},
		thread,
		time::{Instant, SystemTime, UNIX_EPOCH},
	};

	use super::{LIVE_HOLDER_WINDOW, TRANSIENT_IN_USE_BOUND, held_names, is_held, try_acquire};

	/// Release-then-claim rounds beside the probe. Before claims retried, a
	/// `connect(2)` probe under gVisor failed about 1 claim in 700, so these
	/// rounds meet the race many times and still finish in a few seconds.
	const CLAIM_ROUNDS: u32 = 20_000;

	fn unique_path(label: &str) -> String {
		let nonce = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system clock")
			.as_nanos();
		std::env::temp_dir()
			.join(format!("omp-file-lock-{label}-{}-{nonce}", std::process::id()))
			.into_os_string()
			.into_string()
			.expect("utf-8 temp path")
	}

	// A holder in another process is not in this process's set, so the claim
	// meets the connect rule. A real holder answers every connect of the
	// claim, so no refusal starts the window again: the claim answers "taken"
	// once those answers have lasted `LIVE_HOLDER_WINDOW`, never sooner, and
	// well before it would wait out `TRANSIENT_IN_USE_BOUND`.
	#[test]
	fn a_held_lease_is_answered_taken_within_the_bound() {
		let path = unique_path("held");
		// Bound outside `try_acquire`, as another process holds the name.
		let address = SocketAddr::from_abstract_name(super::super::memory_lock_name(&path))
			.expect("abstract name");
		let holder = UnixDatagram::bind_addr(&address).expect("bind the name");
		let started = Instant::now();
		let second = try_acquire(&path).expect("second claim");
		let waited = started.elapsed();
		assert!(second.is_none(), "a held lease was claimed twice");
		assert!(waited >= LIVE_HOLDER_WINDOW, "answered taken after only {waited:?}");
		assert!(waited < TRANSIENT_IN_USE_BOUND, "answered taken after {waited:?}");
		drop(holder);
	}

	// A lease a lock of this process holds is held for certain, so its claim
	// answers "taken" without the connect rule's wait, and once that lock is
	// released the next claim takes the lease.
	#[test]
	fn a_lease_this_process_holds_is_answered_taken_at_once() {
		let path = unique_path("held-here");
		let name = super::super::memory_lock_name(&path);
		let mut holder = try_acquire(&path).expect("acquire").expect("free lease");
		let started = Instant::now();
		let second = try_acquire(&path).expect("second claim");
		let waited = started.elapsed();
		assert!(second.is_none(), "a held lease was claimed twice");
		assert!(waited < LIVE_HOLDER_WINDOW / 5, "answered taken after {waited:?}");
		holder.release().expect("release");
		assert!(!held_names().contains(&name), "a released lock kept its name");
		let mut successor = try_acquire(&path)
			.expect("claim after the release")
			.expect("a released lease stayed taken");
		successor.release().expect("release successor");
	}

	// A lock dropped without `release` must leave the set too: a name left
	// there would make a claim that meets a transient `AddrInUse` answer
	// "taken" for a free lease.
	#[test]
	fn a_dropped_lock_leaves_the_lease_free() {
		let path = unique_path("dropped");
		let name = super::super::memory_lock_name(&path);
		let lease = try_acquire(&path).expect("acquire").expect("free lease");
		drop(lease);
		assert!(!held_names().contains(&name), "a dropped lock kept its name");
		let mut successor = try_acquire(&path)
			.expect("claim after the drop")
			.expect("a dropped lock left the lease taken");
		successor.release().expect("release successor");
	}

	// A released lease is free, so the claim that follows must take it even
	// while another thread probes the name: a refused claim makes a starting
	// session move to another file.
	#[test]
	fn a_claim_after_a_release_survives_a_connect_probe() {
		let path = unique_path("race");
		let stop = AtomicBool::new(false);
		let started = Barrier::new(2);
		let (lost, probes) = thread::scope(|scope| {
			let probe = scope.spawn(|| {
				started.wait();
				let mut probes = 0u64;
				while !stop.load(Ordering::Relaxed) {
					is_held(&path).expect("probe");
					probes += 1;
				}
				probes
			});
			started.wait();
			let mut lost = 0u32;
			for _ in 0..CLAIM_ROUNDS {
				match try_acquire(&path).expect("claim") {
					Some(mut lease) => lease.release().expect("release"),
					None => lost += 1,
				}
			}
			stop.store(true, Ordering::Relaxed);
			(lost, probe.join().expect("probe thread"))
		});
		assert!(probes > 0, "the probe never ran beside the claims");
		assert_eq!(lost, 0, "claims lost to {probes} probes");
	}
}
