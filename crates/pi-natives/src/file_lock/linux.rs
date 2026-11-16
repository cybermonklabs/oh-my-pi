use std::{
	io,
	os::{
		linux::net::SocketAddrExt,
		unix::net::{SocketAddr, UnixDatagram},
	},
	thread,
	time::{Duration, Instant},
};

/// Linux lock held by an abstract Unix-domain socket binding.
pub struct PlatformFileLock {
	socket: Option<UnixDatagram>,
}

/// How long after its first `AddrInUse` a claim keeps retrying the bind.
// Under gVisor a probe of the name, a `connect(2)` or a read of
// `/proc/net/unix`, delays the release of a just-closed socket's name, so a
// bind that follows a release can fail with `AddrInUse` although no socket
// holds the name: measured on 2026-11-16, 144 of 100,000 release-then-claim
// rounds beside a `connect(2)` probe, 0 with no probe. A retried bind
// succeeded within 17 to 36 ms under load; the bound leaves room above that.
const TRANSIENT_IN_USE_BOUND: Duration = Duration::from_millis(200);
/// How many times a claim retries a refused bind whose own `connect(2)`
/// reached a socket on the name before it answers "taken".
// During a transient `AddrInUse` that connect was refused 148 times and
// reached a socket 7 times, so one answer does not prove a live holder. Ten
// retries lost 0 of 2 x 250,000 claims beside a `connect(2)` probe, and a
// lease truly held still answers "taken" within about 1 to 10 ms.
const LIVE_HOLDER_RETRIES: u32 = 10;
/// The pause before each retried bind.
// Long enough not to spin against the probe, short against the 17 to 36 ms a
// transient `AddrInUse` lasted; the measurement above used this pause.
const RETRY_PAUSE: Duration = Duration::from_micros(100);

/// Claims the lock by binding a datagram socket to its abstract name, which
/// the kernel frees when that socket closes, at process exit too.
///
/// A bind refused with `AddrInUse` is retried `RETRY_PAUSE` apart, because
/// under gVisor a probe of the name can delay the release of a just-closed
/// socket's name. After each refusal the claim connects to the name itself:
/// it answers "taken" once that connect has reached a socket more than
/// `LIVE_HOLDER_RETRIES` times, or once `TRANSIENT_IN_USE_BOUND` has passed
/// since the first refusal, and never waits longer for a holder to release.
pub fn try_acquire(path: &str) -> io::Result<Option<PlatformFileLock>> {
	let name = super::memory_lock_name(path);
	let address = SocketAddr::from_abstract_name(name.as_bytes())?;
	let mut first_refusal = None;
	let mut live_answers = 0;
	loop {
		match UnixDatagram::bind_addr(&address) {
			Ok(socket) => return Ok(Some(PlatformFileLock { socket: Some(socket) })),
			Err(error) if error.kind() == io::ErrorKind::AddrInUse => {},
			Err(error) => return Err(error),
		}
		let refused_at = *first_refusal.get_or_insert_with(Instant::now);
		// A failed connect counts as no answer: the bound still ends the
		// retries.
		if matches!(connect_probe(&address), Ok(true)) {
			live_answers += 1;
			if live_answers > LIVE_HOLDER_RETRIES {
				return Ok(None);
			}
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
		drop(self.socket.take());
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use std::{
		sync::{
			Barrier,
			atomic::{AtomicBool, Ordering},
		},
		thread,
		time::{Instant, SystemTime, UNIX_EPOCH},
	};

	use super::{TRANSIENT_IN_USE_BOUND, is_held, try_acquire};

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

	#[test]
	fn a_free_lease_is_acquired() {
		let path = unique_path("free");
		assert!(!is_held(&path).expect("probe free lease"));
		let mut lease = try_acquire(&path)
			.expect("acquire")
			.expect("a free lease is taken");
		assert!(is_held(&path).expect("probe held lease"));
		lease.release().expect("release");
		assert!(!is_held(&path).expect("probe released lease"));
	}

	// A claim's own connect reaches a real holder, so it answers "taken" after
	// its few short retries instead of waiting out the whole bound.
	#[test]
	fn a_held_lease_is_answered_taken_within_the_bound() {
		let path = unique_path("held");
		let mut holder = try_acquire(&path).expect("acquire").expect("free lease");
		let started = Instant::now();
		let second = try_acquire(&path).expect("second claim");
		let waited = started.elapsed();
		assert!(second.is_none(), "a held lease was claimed twice");
		assert!(waited < TRANSIENT_IN_USE_BOUND, "answered taken after {waited:?}");
		holder.release().expect("release");
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
