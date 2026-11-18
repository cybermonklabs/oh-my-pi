//! `pi_shell::testkit`: deterministic infrastructure for testing the bash
//! engine and its hosts.
//!
//! - [`FakeHost`]: captured output, a deterministic clock, scripted host
//!   callouts and native tasks, recorded events.
//! - [`MemFs`]: an in-memory filesystem with seeded latency
//!   ([`MemFs::with_latency`]) and EIO/EAGAIN/ENOSPC injection.
//! - [`child`]: fixture processes that outlive the test runner's bound and die
//!   with the test.
//! - [`fault`]: the fault injector (pause/resume and externalize → drop →
//!   restore at every k-th safepoint) and its oracle.
//! - [`store_conformance`]: the `StateStore` contract, for any store.
//! - [`golden`]: the golden event checker.

pub mod child;
mod conformance;
pub mod fault;
pub mod golden;
pub mod grace;
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
