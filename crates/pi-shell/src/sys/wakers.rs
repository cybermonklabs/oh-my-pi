//! The wakers of the tasks waiting on one thing, all woken at once: a
//! [`Wakers`] is itself a waker ([`Wake`]), so the one wait registered for
//! the thing (a readiness watch, a pump's poll) wakes every task stored in it.

use std::{
	sync::Arc,
	task::{Wake, Waker},
};

use parking_lot::Mutex;

/// The fewest wakers kept before [`Wakers::add`] wakes and forgets them all.
const MIN_CAP: usize = 64;

/// Wakers of the tasks waiting on one thing. A task is stored once (an equal
/// waker is not repeated) and is only ever forgotten by being woken, so a
/// waker that stands for several tasks (every engine vproc polls with the
/// engine's one waker) never loses one of their waits.
pub struct Wakers(Mutex<Set>);

struct Set {
	wakers: Vec<Waker>,
	/// Most wakers kept: [`MIN_CAP`], doubled each time the set fills up,
	/// back to [`MIN_CAP`] once the set is woken.
	cap:    usize,
}

impl Default for Wakers {
	fn default() -> Self {
		Self(Mutex::new(Set { wakers: Vec::new(), cap: MIN_CAP }))
	}
}

impl Wakers {
	/// Store `waker`, and say whether the set was empty: then nothing is
	/// registered to wake it, and the caller registers the one wait that does.
	///
	/// A task dropped while it waits leaves its waker here until the set is
	/// woken. So the set does not grow without end, a waker that finds it full
	/// first wakes and forgets every stored one and doubles the cap: a live
	/// task polls again and is stored anew, a dropped task's waker goes. N live
	/// tasks settle after about log2(N / 64) such rounds, and dropped tasks'
	/// wakers stay under twice the most live ones.
	pub fn add(&self, waker: &Waker) -> bool {
		let (was_empty, full) = {
			let mut set = self.0.lock();
			if set.wakers.iter().any(|w| w.will_wake(waker)) {
				return false;
			}
			let was_empty = set.wakers.is_empty();
			let full = if set.wakers.len() >= set.cap {
				set.cap *= 2;
				std::mem::take(&mut set.wakers)
			} else {
				Vec::new()
			};
			set.wakers.push(waker.clone());
			(was_empty, full)
		};
		for w in full {
			w.wake();
		}
		was_empty
	}

	/// Take them all (to wake or drop outside the lock).
	pub fn take(&self) -> Vec<Waker> {
		let mut set = self.0.lock();
		set.cap = MIN_CAP;
		std::mem::take(&mut set.wakers)
	}
}

impl Wake for Wakers {
	fn wake(self: Arc<Self>) {
		self.wake_by_ref();
	}

	fn wake_by_ref(self: &Arc<Self>) {
		for w in self.take() {
			w.wake();
		}
	}
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicUsize, Ordering};

	use super::*;

	/// A task's waker that counts its wakes.
	#[derive(Default)]
	struct Task(AtomicUsize);

	impl Wake for Task {
		fn wake(self: Arc<Self>) {
			self.0.fetch_add(1, Ordering::SeqCst);
		}
	}

	// Failure mode (review round 3): a cap that wakes every stored task each
	// time it is reached churns for good once more live tasks wait than it
	// holds: each woken task stores itself again and the next one over the cap
	// wakes them all again. Here every woken task stores itself again, as a
	// live task that polls again does, and the set must settle.
	#[test]
	fn live_tasks_past_the_cap_settle() {
		let wakers = Wakers::default();
		let tasks: Vec<Arc<Task>> = (0..1000).map(|_| Arc::default()).collect();
		let handles: Vec<Waker> = tasks.iter().map(|t| Waker::from(Arc::clone(t))).collect();
		let mut seen = vec![0; tasks.len()];
		for h in &handles {
			wakers.add(h);
		}
		let mut rounds = 0;
		loop {
			let woken: Vec<usize> = (0..tasks.len())
				.filter(|&i| tasks[i].0.load(Ordering::SeqCst) != seen[i])
				.collect();
			if woken.is_empty() {
				break;
			}
			rounds += 1;
			assert!(rounds <= 10, "1000 live tasks still churn after {rounds} rounds");
			for i in woken {
				seen[i] = tasks[i].0.load(Ordering::SeqCst);
				wakers.add(&handles[i]);
			}
		}
		// Every one of them is stored once, and waking the set wakes each.
		let before: Vec<usize> = tasks.iter().map(|t| t.0.load(Ordering::SeqCst)).collect();
		Waker::from(Arc::new(wakers)).wake();
		for (t, b) in tasks.iter().zip(before) {
			assert_eq!(t.0.load(Ordering::SeqCst), b + 1, "each stored task is woken once");
		}
	}

	// Failure mode: the caller is told the set was empty when it was not (a
	// second wait registered) or not told when it was (no wait at all).
	#[test]
	fn add_says_whether_the_set_was_empty() {
		let wakers = Arc::new(Wakers::default());
		let (a, b) = (Waker::from(Arc::new(Task::default())), Waker::from(Arc::new(Task::default())));
		assert!(wakers.add(&a));
		assert!(!wakers.add(&a), "the same waker again");
		assert!(!wakers.add(&b));
		Waker::from(Arc::clone(&wakers)).wake_by_ref();
		assert!(wakers.add(&b), "empty again once woken");
	}
}
