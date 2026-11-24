//! `pi_shell::testkit`: deterministic infrastructure for testing the bash
//! engine and its hosts.
//!
//! - [`FakeHost`]: captured output, a deterministic clock, scripted host
//!   callouts and native tasks, recorded events.
//! - [`MemFs`]: an in-memory filesystem with seeded latency
//!   ([`MemFs::with_latency`]) and EIO/EAGAIN/ENOSPC injection.
//! - [`fault`]: the fault injector (pause/resume and externalize → drop →
//!   restore at every k-th safepoint) and its oracle.
//! - [`store_conformance`]: the `StateStore` contract, for any store.
//! - [`golden`]: the golden event checker.

mod conformance;
pub mod fault;
pub mod golden;
mod host;
mod memfs;
mod rng;
pub mod run;

pub use crate::testkit::{
	conformance::store_conformance,
	fault::{Fault, Outcome, Rig, run_script},
	host::{
		Capture, Countdown, FakeHost, NativeFn, RestoreFn, SpawnFn, SpawnFutureFn, ToolFn, VerdictFn,
	},
	memfs::{Eio, FaultKind, MemFs},
	rng::Rng,
};

#[cfg(test)]
mod suites;

/// The pauses between the checks of a test's wait that only polling can
/// see: 1 ms at first, twice as long after each failed check, and at most
/// 20 ms, so a long wait costs almost no CPU.
#[cfg(all(test, unix))]
pub(crate) struct Backoff(std::time::Duration);

#[cfg(all(test, unix))]
impl Backoff {
	pub(crate) const fn new() -> Self {
		Self(std::time::Duration::from_millis(1))
	}

	/// The pause before the next check; it doubles the one after, up to
	/// 20 ms.
	pub(crate) fn pause(&mut self) -> std::time::Duration {
		let pause = self.0;
		self.0 = (pause * 2).min(std::time::Duration::from_millis(20));
		pause
	}
}
