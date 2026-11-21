//! The tasks waiting on one thing, all woken at once.
//!
//! Each waiting task holds a [`WaitKey`]: its slot in the [`Wakers`] of the
//! thing it waits on, which it frees when it is dropped (the wait ended, or
//! the task was dropped while it waited), as `futures::lock::Mutex` keeps
//! the waiters of a lock. A task that polls again replaces the waker in its
//! own slot. So a [`Wakers`] holds one slot per live key and nothing for a
//! task that is gone, however many tasks waited before. A [`Wakers`] is
//! itself a waker ([`Wake`]): the one wait registered for the thing (a
//! readiness watch) wakes every task waiting in it.

use std::{
	sync::Arc,
	task::{Wake, Waker},
};

use parking_lot::Mutex;

/// The wakers of the tasks waiting on one thing, one slot per [`WaitKey`].
#[derive(Default)]
pub struct Wakers(Mutex<Set>);

#[derive(Default)]
struct Set {
	slots:   Vec<Slot>,
	/// Free slots, reused before the vector grows.
	free:    Vec<usize>,
	/// How many slots hold a waker.
	waiting: usize,
}

#[derive(Default)]
enum Slot {
	/// No key holds it.
	#[default]
	Free,
	/// Its key's task waits.
	Waiting(Waker),
	/// Its key's task was woken and has not waited since.
	Woken,
}

/// One task's wait in a [`Wakers`]: none until the task first waits, then
/// its slot there, freed when the key is dropped. The waiting future holds
/// it, so a task dropped while it waits leaves nothing behind.
#[derive(Default)]
pub struct WaitKey(Option<(Arc<Wakers>, usize)>);

impl Wakers {
	/// `key`'s task waits here with `waker`, which replaces the one it waited
	/// with before (a key it held in another set first leaves that set). Says
	/// whether no task waited here before: then nothing is registered to wake
	/// them, and the caller registers the one wait that does.
	pub fn wait(self: &Arc<Self>, key: &mut WaitKey, waker: &Waker) -> bool {
		if key
			.0
			.as_ref()
			.is_some_and(|(set, _)| !Arc::ptr_eq(set, self))
		{
			*key = WaitKey::default();
		}
		let (first, replaced) = {
			let mut set = self.0.lock();
			let at = if let Some((_, at)) = &key.0 {
				*at
			} else {
				let at = set.free.pop().unwrap_or_else(|| {
					set.slots.push(Slot::Free);
					set.slots.len() - 1
				});
				key.0 = Some((Arc::clone(self), at));
				at
			};
			if let Slot::Waiting(old) = &set.slots[at]
				&& old.will_wake(waker)
			{
				return false;
			}
			let first = set.waiting == 0;
			let replaced = std::mem::replace(&mut set.slots[at], Slot::Waiting(waker.clone()));
			if matches!(replaced, Slot::Waiting(_)) {
				(false, replaced)
			} else {
				set.waiting += 1;
				(first, replaced)
			}
		};
		// Dropped outside the lock.
		drop(replaced);
		first
	}

	/// Take the waker of every waiting task (to wake outside the lock). Their
	/// keys keep their slots and wait again with them.
	pub fn take(&self) -> Vec<Waker> {
		let mut set = self.0.lock();
		let mut wakers = Vec::with_capacity(set.waiting);
		set.waiting = 0;
		for slot in &mut set.slots {
			if matches!(slot, Slot::Waiting(_))
				&& let Slot::Waiting(waker) = std::mem::replace(slot, Slot::Woken)
			{
				wakers.push(waker);
			}
		}
		wakers
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

impl Drop for WaitKey {
	/// Free the slot; its waker, if the task still waited, is dropped outside
	/// the lock.
	fn drop(&mut self) {
		let Some((wakers, at)) = self.0.take() else {
			return;
		};
		let freed = {
			let mut set = wakers.0.lock();
			let freed = std::mem::take(&mut set.slots[at]);
			if matches!(freed, Slot::Waiting(_)) {
				set.waiting -= 1;
			}
			if set.free.len() + 1 == set.slots.len() {
				// The last key is gone: give the memory back.
				set.slots = Vec::new();
				set.free = Vec::new();
			} else {
				set.free.push(at);
			}
			freed
		};
		drop(freed);
	}
}

#[cfg(test)]
impl Wakers {
	/// Test only: wakers held, the slots of tasks that wait.
	pub(crate) fn held(&self) -> usize {
		let set = self.0.lock();
		set.slots
			.iter()
			.filter(|s| matches!(s, Slot::Waiting(_)))
			.count()
	}

	/// Test only: slots taken by keys.
	pub(crate) fn keys(&self) -> usize {
		let set = self.0.lock();
		set.slots.len() - set.free.len()
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

	/// A live task: its waker and the key its waiting future holds.
	struct Live {
		task:  Arc<Task>,
		waker: Waker,
		key:   WaitKey,
	}

	fn live(n: usize) -> Vec<Live> {
		(0..n)
			.map(|_| {
				let task = Arc::new(Task::default());
				Live { waker: Waker::from(Arc::clone(&task)), task, key: WaitKey::default() }
			})
			.collect()
	}

	/// A fixed pseudo-random order of `0..n` (xorshift), the same each run.
	fn shuffled(n: usize, seed: u64) -> Vec<usize> {
		let mut order: Vec<usize> = (0..n).collect();
		let mut x = seed;
		for i in (1..n).rev() {
			x ^= x << 13;
			x ^= x >> 7;
			x ^= x << 17;
			order.swap(i, (x % (i as u64 + 1)) as usize);
		}
		order
	}

	/// A task that waits once and is dropped with its future: nothing but
	/// the set could still hold its waker.
	fn wait_once_and_drop(wakers: &Arc<Wakers>, woken: &Arc<Task>) {
		let mut key = WaitKey::default();
		wakers.wait(&mut key, &Waker::from(Arc::clone(woken)));
	}

	// Failure mode (review of #111 at 7eb2f7d0): live tasks woke each other
	// for good when they waited again in another order than they first
	// waited. Only the thing's readiness wakes a task here: until it fires
	// no live task is woken, whatever the order, and one fire wakes each
	// once.
	#[test]
	fn live_tasks_in_any_order_are_woken_once_each_by_a_fire() {
		let wakers = Arc::new(Wakers::default());
		let mut tasks = live(5000);
		for seed in [0x9e37_79b9_7f4a_7c15, 0x2545_f491_4f6c_dd1d, 0xd1b5_4a32_d192_ed03] {
			for _ in 0..3 {
				for i in shuffled(tasks.len(), seed) {
					let t = &mut tasks[i];
					wakers.wait(&mut t.key, &t.waker);
				}
			}
			assert!(tasks.iter().all(|t| t.task.wakes() == 0), "no task is woken before a fire");
			assert_eq!(wakers.held(), 5000, "each task is stored once");
		}
		Waker::from(Arc::clone(&wakers)).wake();
		assert!(tasks.iter().all(|t| t.task.wakes() == 1), "a fire wakes each task once");
		for i in shuffled(tasks.len(), 7) {
			let t = &mut tasks[i];
			wakers.wait(&mut t.key, &t.waker);
		}
		Waker::from(Arc::clone(&wakers)).wake();
		assert!(tasks.iter().all(|t| t.task.wakes() == 2), "the next fire wakes each once again");
	}

	// Failure mode (review of #111 at 7eb2f7d0): live tasks after 300,000
	// dropped ones were woken for 235 rounds before they settled. Dropped
	// tasks leave nothing here, so live ones after them are held and woken
	// as if they were the first.
	#[test]
	fn live_tasks_after_many_dropped_ones_are_held_alone() {
		let wakers = Arc::new(Wakers::default());
		let dropped = Arc::new(Task::default());
		for _ in 0..300_000 {
			wait_once_and_drop(&wakers, &dropped);
		}
		assert_eq!((wakers.held(), wakers.keys()), (0, 0), "dropped tasks leave nothing");
		let mut tasks = live(1000);
		for t in &mut tasks {
			wakers.wait(&mut t.key, &t.waker);
		}
		assert_eq!(wakers.held(), 1000);
		Waker::from(Arc::clone(&wakers)).wake();
		assert!(tasks.iter().all(|t| t.task.wakes() == 1), "a fire wakes each live task once");
		assert_eq!(dropped.wakes(), 0, "no dropped task is woken");
	}

	// Failure mode (review of #111 at 7eb2f7d0): 100 live tasks beside a
	// stream of 37,020 that wait once and are dropped were woken 2,000,033
	// times. Here they are not woken at all until a fire, and the set never
	// holds more than the live tasks and the one dropped task in flight.
	#[test]
	fn live_tasks_beside_a_stream_of_dropped_ones_are_not_woken() {
		let wakers = Arc::new(Wakers::default());
		let dropped = Arc::new(Task::default());
		let mut tasks = live(100);
		for t in &mut tasks {
			wakers.wait(&mut t.key, &t.waker);
		}
		for n in 0..37_020 {
			let mut key = WaitKey::default();
			wakers.wait(&mut key, &Waker::from(Arc::clone(&dropped)));
			assert!(wakers.held() <= 101, "{} wakers held", wakers.held());
			drop(key);
			// A live task polls again now and then, with the same waker.
			let t = &mut tasks[n % 100];
			wakers.wait(&mut t.key, &t.waker);
		}
		let woken: usize = tasks.iter().map(|t| t.task.wakes()).sum();
		assert_eq!(woken, 0, "live tasks woken {woken} times by tasks that came and went");
		assert_eq!(wakers.held(), 100);
		Waker::from(Arc::clone(&wakers)).wake();
		assert!(tasks.iter().all(|t| t.task.wakes() == 1));
		assert_eq!(dropped.wakes(), 0);
	}

	// Failure mode: a dropped task's waker stays stored, and with it the
	// task's memory.
	#[test]
	fn a_dropped_waiter_leaves_nothing_stored() {
		let wakers = Arc::new(Wakers::default());
		let task = Arc::new(Task::default());
		let mut key = WaitKey::default();
		wakers.wait(&mut key, &Waker::from(Arc::clone(&task)));
		assert_eq!((wakers.held(), Arc::strong_count(&task)), (1, 2));
		drop(key);
		assert_eq!((wakers.held(), wakers.keys()), (0, 0));
		assert_eq!(Arc::strong_count(&task), 1, "the set keeps no clone of the waker");
	}

	// Failure mode: a task that polls again takes a second slot, and the
	// set grows with every poll of a live task.
	#[test]
	fn a_task_waiting_again_replaces_its_own_wait() {
		let wakers = Arc::new(Wakers::default());
		let (first, second) = (Arc::new(Task::default()), Arc::new(Task::default()));
		let mut key = WaitKey::default();
		wakers.wait(&mut key, &Waker::from(Arc::clone(&first)));
		wakers.wait(&mut key, &Waker::from(Arc::clone(&second)));
		assert_eq!((wakers.held(), wakers.keys()), (1, 1));
		Waker::from(Arc::clone(&wakers)).wake();
		assert_eq!((first.wakes(), second.wakes()), (0, 1), "only the latest waker is woken");
	}

	// Failure mode: the caller is told no task waited when one did (a second
	// watch registered) or not told when none did (no watch at all, the
	// next fire never comes).
	#[test]
	fn wait_says_whether_a_task_waited() {
		let wakers = Arc::new(Wakers::default());
		let (a, b) = (Waker::from(Arc::new(Task::default())), Waker::from(Arc::new(Task::default())));
		let (mut ka, mut kb) = (WaitKey::default(), WaitKey::default());
		assert!(wakers.wait(&mut ka, &a));
		assert!(!wakers.wait(&mut ka, &a), "the same task again");
		assert!(!wakers.wait(&mut kb, &b));
		Waker::from(Arc::clone(&wakers)).wake_by_ref();
		assert!(wakers.wait(&mut kb, &b), "none waits once all were woken");
		drop(kb);
		assert!(wakers.wait(&mut ka, &a), "none waits once the only one waiting is gone");
	}

	// Failure mode: a key that waits in another set (its file was replaced)
	// keeps its slot in the first, which then holds a waker for good.
	#[test]
	fn a_key_waits_in_one_set_at_a_time() {
		let (one, two) = (Arc::new(Wakers::default()), Arc::new(Wakers::default()));
		let task = Arc::new(Task::default());
		let waker = Waker::from(Arc::clone(&task));
		let mut key = WaitKey::default();
		one.wait(&mut key, &waker);
		assert!(two.wait(&mut key, &waker));
		assert_eq!((one.keys(), two.keys()), (0, 1));
	}
}
