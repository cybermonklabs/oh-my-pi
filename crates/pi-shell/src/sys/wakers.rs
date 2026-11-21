//! The wakers of the tasks waiting on one thing, all woken at once: a
//! [`Wakers`] is itself a waker ([`Wake`]), so the one wait registered for
//! the thing (a readiness watch, a pump's poll) wakes every task stored in it.

use std::{
	sync::Arc,
	task::{Wake, Waker},
};

use parking_lot::Mutex;

/// The fewest new wakers stored before the next one wakes them
/// ([`Wakers::add`]).
const MIN_CAP: usize = 64;

/// Wakers of the tasks waiting on one thing. A task is stored once (an equal
/// waker is not repeated) and is only ever forgotten by being woken, so a
/// waker that stands for several tasks (every engine vproc polls with the
/// engine's one waker) never loses one of their waits.
pub struct Wakers(Mutex<Set>);

struct Set {
	/// The stored wakers.
	wakers:    Vec<Stored>,
	/// How many stored wakers are new (did not come back): at most `cap`.
	new:       usize,
	/// [`MIN_CAP`], or 4 × the stored wakers that came back at the last
	/// overflow if that is more.
	cap:       usize,
	/// Copies of the wakers overflows woke, to know them if they come back:
	/// one is kept while fewer than 4 × `cap` are.
	woken:     Vec<Waker>,
	/// Overflows since the set was last woken (64 bits: no count of
	/// overflows reaches its end).
	overflows: u64,
	/// The overflow at which `woken` is next forgotten: 1, 2, 4, 8, ...
	forget_at: u64,
}

struct Stored {
	waker: Waker,
	/// An overflow woke it, and its task waited again.
	back:  bool,
}

impl Default for Set {
	fn default() -> Self {
		Self {
			wakers:    Vec::new(),
			new:       0,
			cap:       MIN_CAP,
			woken:     Vec::new(),
			overflows: 0,
			forget_at: 1,
		}
	}
}

impl Default for Wakers {
	fn default() -> Self {
		Self(Mutex::new(Set::default()))
	}
}

impl Wakers {
	/// Store `waker`, and say whether the set was empty: then nothing is
	/// registered to wake it, and the caller registers the one wait that does.
	///
	/// A task dropped while it waits leaves its waker here until the set is
	/// woken, so the set must not keep every waker it is given. It keeps at
	/// most `cap` new wakers: the next new one is an overflow, which wakes
	/// them and keeps a copy of each it wakes (while fewer than 4 × `cap`
	/// copies are kept), to know it if it is stored again. A task alive when
	/// it is woken polls again and is stored again: it came back. The wakers
	/// that came back do not count against the cap, and every second overflow
	/// wakes them too, so one whose task was dropped since goes. The cap is 4
	/// × the stored wakers that came back, or 64 if that is more: it grows
	/// with live tasks and never with dropped ones, whose wakers do not come
	/// back. The copies are forgotten at overflows 1, 2, 4, 8, ... since the
	/// set was last woken, so dropped tasks' wakers cannot fill them for good.
	///
	/// So, with C the largest cap since the copies were last forgotten, at
	/// most C new wakers and 4¼ × C that came back or are copies are held:
	/// 5¼ × C in all. With one live task and any number that wait once and
	/// are dropped, C is 64 and at most 336 are held. Live tasks that each
	/// wait again when woken settle within a few rounds of wakes: 300 in 2,
	/// 1,000 in 3, 5,000 in 4.
	pub fn add(&self, waker: &Waker) -> bool {
		let (was_empty, wake, forgotten) = {
			let mut set = self.0.lock();
			if set.wakers.iter().any(|s| s.waker.will_wake(waker)) {
				return false;
			}
			let was_empty = set.wakers.is_empty();
			let (mut wake, mut forgotten) = (Vec::new(), Vec::new());
			if let Some(i) = set.woken.iter().position(|w| w.will_wake(waker)) {
				set.woken.swap_remove(i);
				set.wakers.push(Stored { waker: waker.clone(), back: true });
			} else {
				if set.new >= set.cap {
					(wake, forgotten) = set.overflow();
				}
				set.wakers
					.push(Stored { waker: waker.clone(), back: false });
				set.new += 1;
			}
			(was_empty, wake, forgotten)
		};
		// Woken, and dropped, outside the lock.
		drop(forgotten);
		for w in wake {
			w.wake();
		}
		was_empty
	}

	/// Take them all (to wake or drop outside the lock), and start again.
	pub fn take(&self) -> Vec<Waker> {
		let set = std::mem::take(&mut *self.0.lock());
		set.wakers.into_iter().map(|s| s.waker).collect()
	}
}

impl Set {
	/// A new waker found `cap` new ones stored. Returns the wakers to wake,
	/// and the copies forgotten (to drop outside the lock).
	fn overflow(&mut self) -> (Vec<Waker>, Vec<Waker>) {
		self.overflows += 1;
		let back = self.wakers.len() - self.new;
		self.cap = MIN_CAP.max(4 * back);
		let forgotten = if self.overflows >= self.forget_at {
			self.forget_at *= 2;
			std::mem::take(&mut self.woken)
		} else {
			Vec::new()
		};
		let wake_back = self.overflows % 2 == 0;
		// Those that came back first, so an overflow that wakes them keeps a
		// copy of each.
		let (came_back, new): (Vec<Stored>, Vec<Stored>) = std::mem::take(&mut self.wakers)
			.into_iter()
			.partition(|s| s.back);
		let mut wake = Vec::with_capacity(new.len() + if wake_back { came_back.len() } else { 0 });
		for s in came_back.into_iter().chain(new) {
			if s.back && !wake_back {
				self.wakers.push(s);
				continue;
			}
			if self.woken.len() < 4 * self.cap {
				self.woken.push(s.waker.clone());
			}
			wake.push(s.waker);
		}
		self.new = 0;
		(wake, forgotten)
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

	impl Task {
		fn wakes(&self) -> usize {
			self.0.load(Ordering::SeqCst)
		}
	}

	impl Wakers {
		/// Wakers held: stored, and copies of woken ones.
		fn held(&self) -> usize {
			let set = self.0.lock();
			set.wakers.len() + set.woken.len()
		}

		fn cap(&self) -> usize {
			self.0.lock().cap
		}
	}

	/// Live tasks, each storing itself again whenever it is woken (as a live
	/// task that polls again does), until none is woken. Returns the rounds of
	/// wakes it took, at most `most`.
	fn settle(wakers: &Wakers, tasks: &[Arc<Task>], most: usize) -> usize {
		let handles: Vec<Waker> = tasks.iter().map(|t| Waker::from(Arc::clone(t))).collect();
		let mut seen: Vec<usize> = tasks.iter().map(|t| t.wakes()).collect();
		for h in &handles {
			wakers.add(h);
		}
		let mut rounds = 0;
		loop {
			let woken: Vec<usize> = (0..tasks.len())
				.filter(|&i| tasks[i].wakes() != seen[i])
				.collect();
			if woken.is_empty() {
				return rounds;
			}
			rounds += 1;
			assert!(
				rounds <= most,
				"{} live tasks still churn after {rounds} rounds of wakes",
				tasks.len()
			);
			for i in woken {
				seen[i] = tasks[i].wakes();
				wakers.add(&handles[i]);
			}
		}
	}

	/// Every task is stored once: waking the set wakes each exactly once.
	fn each_stored_once(wakers: Wakers, tasks: &[Arc<Task>]) {
		let before: Vec<usize> = tasks.iter().map(|t| t.wakes()).collect();
		Waker::from(Arc::new(wakers)).wake();
		for (t, b) in tasks.iter().zip(before) {
			assert_eq!(t.wakes(), b + 1, "each stored task is woken once");
		}
	}

	// Failure mode (review round 3): a cap that wakes every stored task each
	// time it is reached churns for good once more live tasks wait than it
	// holds: each woken task stores itself again and the next one over the cap
	// wakes them all again. The rounds are the ones `Wakers::add` states.
	#[test]
	fn live_tasks_past_the_cap_settle() {
		for (n, rounds) in [(300, 2), (1000, 3), (5000, 4)] {
			let wakers = Wakers::default();
			let tasks: Vec<Arc<Task>> = (0..n).map(|_| Arc::default()).collect();
			settle(&wakers, &tasks, rounds);
			each_stored_once(wakers, &tasks);
		}
	}

	// Failure mode (review of #111 at b42e3751): the cap grows with every
	// waker that fills the set, dropped tasks' too, so one live task and
	// 10,000 that wait once and are dropped grew the set to 4,096 wakers and
	// its cap to 8,192.
	#[test]
	fn tasks_dropped_while_they_wait_do_not_grow_the_set() {
		let wakers = Wakers::default();
		let live = Arc::new(Task::default());
		let handle = Waker::from(Arc::clone(&live));
		let mut seen = 0;
		wakers.add(&handle);
		let mut most = 0;
		for _ in 0..10_000 {
			// It waits once, and is dropped: only the set holds it.
			wakers.add(&Waker::from(Arc::new(Task::default())));
			if live.wakes() != seen {
				seen = live.wakes();
				wakers.add(&handle);
			}
			most = most.max(wakers.held());
		}
		assert!(most <= 336, "{most} wakers held, more than 5¼ × 64");
		assert_eq!(wakers.cap(), MIN_CAP);
		each_stored_once(wakers, &[live]);
	}

	// Failure mode: a task that came back (an overflow woke it and it waited
	// again) and was dropped then is never woken again, so it is never
	// forgotten, and such tasks pile up past any bound.
	#[test]
	fn tasks_dropped_after_they_came_back_do_not_grow_the_set() {
		let wakers = Wakers::default();
		let mut waiting: Vec<(Arc<Task>, Waker)> = Vec::new();
		let mut most = 0;
		for step in 0..192_000 {
			if step % 64 == 0 {
				// It waits, and once woken waits again, and is dropped.
				let task = Arc::new(Task::default());
				let handle = Waker::from(Arc::clone(&task));
				wakers.add(&handle);
				waiting.push((task, handle));
			} else {
				wakers.add(&Waker::from(Arc::new(Task::default())));
			}
			waiting.retain(|(task, handle)| {
				if task.wakes() == 0 {
					return true;
				}
				wakers.add(handle);
				false
			});
			most = most.max(wakers.held());
		}
		assert!(most <= 336, "{most} wakers held, more than 5¼ × 64");
	}

	// Failure mode: the copies that tell a task that came back from a new one
	// fill up with dropped tasks' wakers and are never forgotten, so live
	// tasks are never known when they come back and churn for good.
	#[test]
	fn live_tasks_settle_after_many_dropped_ones() {
		let wakers = Wakers::default();
		for _ in 0..5000 {
			wakers.add(&Waker::from(Arc::new(Task::default())));
		}
		let tasks: Vec<Arc<Task>> = (0..1000).map(|_| Arc::default()).collect();
		settle(&wakers, &tasks, 5);
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
