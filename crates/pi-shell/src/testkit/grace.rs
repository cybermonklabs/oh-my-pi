//! The graces a cancel allows, for a test that drives what happens inside
//! one.
//!
//! A cancel sends `TERM`, keeps the run's output readers open, and ends the
//! run with `KILL` once the grace is over ([`crate::host::TERM_GRACE`] and
//! the shell's reader grace). A test of what happens during a grace — a
//! `TERM` trap that writes, a cleanup that must finish — otherwise has to
//! fit its fixture inside those windows, which a loaded host takes away:
//! [`Longer`] widens them instead, so the test decides when its fixture is
//! done, not the host's scheduling.

use std::{
	sync::atomic::{AtomicU64, Ordering},
	time::Duration,
};

/// Nanoseconds of the graces now in force; 0 is "the shipped value".
pub(crate) static TERM: AtomicU64 = AtomicU64::new(0);
pub(crate) static READER: AtomicU64 = AtomicU64::new(0);

/// `shipped`, unless a [`Longer`] is in force.
pub(crate) fn or(shipped: Duration, set: &AtomicU64) -> Duration {
	match set.load(Ordering::Relaxed) {
		0 => shipped,
		nanos => Duration::from_nanos(nanos),
	}
}

/// Graces no test fixture races, until this is dropped.
///
/// They are this process's, so a test that holds one must not run beside
/// another that cancels a run: hold the test lock of the suite, or run in a
/// process of your own.
#[must_use = "the graces are restored when this is dropped"]
pub struct Longer;

impl Longer {
	/// Both graces become `how_long`.
	pub fn than(how_long: Duration) -> Self {
		let nanos = u64::try_from(how_long.as_nanos())
			.unwrap_or(u64::MAX)
			.max(1);
		TERM.store(nanos, Ordering::Relaxed);
		READER.store(nanos, Ordering::Relaxed);
		Self
	}
}

impl Drop for Longer {
	fn drop(&mut self) {
		TERM.store(0, Ordering::Relaxed);
		READER.store(0, Ordering::Relaxed);
	}
}
