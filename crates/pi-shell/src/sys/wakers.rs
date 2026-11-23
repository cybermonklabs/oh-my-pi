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
	collections::HashMap,
	sync::Arc,
	task::{Wake, Waker},
};

use parking_lot::Mutex;

/// The room a set keeps for slots however few keys hold one, until the last
/// key goes ([`WaitKey`]'s drop); below twice it, it gives none back.
const MIN_ROOM: usize = 16;

/// The wakers of the tasks waiting on one thing, one slot per [`WaitKey`].
#[derive(Default)]
pub struct Wakers(Mutex<Set>);

#[derive(Default)]
struct Set {
	/// The slots of the keys that hold one, by the key's id.
	slots:   HashMap<u64, Slot>,
	/// The id of the next key to take a slot.
	next:    u64,
	/// How many slots hold a waker.
	waiting: usize,
}

enum Slot {
	/// Its key's task waits.
	Waiting(Waker),
	/// Its key's task was woken and has not waited since.
	Woken,
}

/// One task's wait in a [`Wakers`]: none until the task first waits, then
/// its slot there, freed when the key is dropped. The waiting future holds
/// it, so a task dropped while it waits leaves nothing behind.
#[derive(Default)]
pub struct WaitKey {
	/// The set this key waits in, and the id of its slot there.
	slot: Option<(Arc<Wakers>, u64)>,
	/// Keys of its own for things the task waits on at once ([`Self::sub`]).
	subs: Vec<Self>,
}

impl WaitKey {
	/// The key of the `i`th of several things this key's task waits on at
	/// once, through one object (a zsh multios tee waits on each of its
	/// targets). A key waits in one set at a time, so each thing needs a key
	/// of its own. It belongs to this key and is dropped with it.
	pub fn sub(&mut self, i: usize) -> &mut Self {
		if self.subs.len() <= i {
			self.subs.resize_with(i + 1, Self::default);
		}
		&mut self.subs[i]
	}

	/// The id of this key's slot in `set`, once it has waited there. It stays
	/// the key's until the key is dropped or waits in another set, and no
	/// other key of `set` ever has it: a thing waited on can tell its tasks
	/// apart by it (a provider file keeps a write's result for the task that
	/// started it).
	pub fn id_in(&self, set: &Arc<Wakers>) -> Option<u64> {
		self
			.slot
			.as_ref()
			.filter(|(wakers, _)| Arc::ptr_eq(wakers, set))
			.map(|(_, id)| *id)
	}

	/// Leave the set this key waits in: free its slot, and drop its waker,
	/// if the task still waited, outside the lock. Its sub keys stay.
	fn leave(&mut self) {
		let Some((wakers, id)) = self.slot.take() else {
			return;
		};
		let freed = {
			let mut set = wakers.0.lock();
			let freed = set.slots.remove(&id);
			if matches!(freed, Some(Slot::Waiting(_))) {
				set.waiting -= 1;
			}
			if set.slots.is_empty() {
				// The last key is gone: give the memory back.
				set.slots = HashMap::new();
			} else if set.slots.capacity() > 2 * MIN_ROOM && set.slots.len() * 4 < set.slots.capacity()
			{
				// Room for about as many slots as keys hold, not for as many as
				// the set ever held.
				let room = (set.slots.len() * 2).max(MIN_ROOM);
				set.slots.shrink_to(room);
			}
			freed
		};
		drop(freed);
	}
}

impl Wakers {
	/// `key`'s task waits here with `waker`, which replaces the one it waited
	/// with before (a key it held in another set first leaves that set). Says
	/// whether no task waited here before: then nothing is registered to wake
	/// them, and the caller registers the one wait that does.
	pub fn wait(self: &Arc<Self>, key: &mut WaitKey, waker: &Waker) -> bool {
		if key
			.slot
			.as_ref()
			.is_some_and(|(set, _)| !Arc::ptr_eq(set, self))
		{
			key.leave();
		}
		let (first, replaced) = {
			let mut set = self.0.lock();
			let id = if let Some((_, id)) = &key.slot {
				*id
			} else {
				let id = set.next;
				set.next += 1;
				key.slot = Some((Arc::clone(self), id));
				id
			};
			if let Some(Slot::Waiting(old)) = set.slots.get(&id)
				&& old.will_wake(waker)
			{
				return false;
			}
			let first = set.waiting == 0;
			let replaced = set.slots.insert(id, Slot::Waiting(waker.clone()));
			if matches!(replaced, Some(Slot::Waiting(_))) {
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
		for slot in set.slots.values_mut() {
			if matches!(slot, Slot::Waiting(_))
				&& let Slot::Waiting(waker) = std::mem::replace(slot, Slot::Woken)
			{
				wakers.push(waker);
			}
		}
		wakers
	}

	/// Whether the key whose slot is `id` still holds it: neither dropped nor
	/// gone to wait in another set.
	pub fn holds(&self, id: u64) -> bool {
		self.0.lock().slots.contains_key(&id)
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
	/// Free the slot (its sub keys free theirs as they drop).
	fn drop(&mut self) {
		self.leave();
	}
}

#[cfg(test)]
impl Wakers {
	/// Test only: wakers held, the slots of tasks that wait.
	pub(crate) fn held(&self) -> usize {
		let set = self.0.lock();
		set.slots
			.values()
			.filter(|s| matches!(s, Slot::Waiting(_)))
			.count()
	}

	/// Test only: slots taken by keys.
	pub(crate) fn keys(&self) -> usize {
		self.0.lock().slots.len()
	}

	/// Test only: how many slots the set has room for without growing.
	fn room(&self) -> usize {
		self.0.lock().slots.capacity()
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

	// Failure mode (review of #111 at 3b9fe7ab): a set kept room for as many
	// slots as the most keys it held at once until its last key went: 10,000
	// slots for one waiting key. It gives the room back as keys go, wherever
	// the keys that stay took their slots.
	#[test]
	fn a_set_gives_back_room_as_its_keys_go() {
		let wakers = Arc::new(Wakers::default());
		let mut tasks = live(10_000);
		for t in &mut tasks {
			wakers.wait(&mut t.key, &t.waker);
		}
		assert!(wakers.room() >= 10_000);
		let stays = tasks.swap_remove(5_000);
		for i in shuffled(tasks.len(), 0x6a09_e667_f3bc_c908) {
			tasks[i].key = WaitKey::default();
		}
		assert_eq!((wakers.held(), wakers.keys()), (1, 1));
		assert!(wakers.room() <= 4 * MIN_ROOM, "room for {} slots kept for one key", wakers.room());
		Waker::from(Arc::clone(&wakers)).wake();
		assert_eq!(stays.task.wakes(), 1, "the key that stays still waits");
		drop(stays);
		assert_eq!(wakers.room(), 0, "the last key gives all the room back");
	}

	// Failure mode (review of #111 at bd60965e): no test failed when giving
	// room back freed a slot whose key still waited, since one key stayed
	// and a plant that freed the first waiting slot rarely picked it. Here
	// 100 of 10,000 keys stay, taken from all through the set, in 8 rounds
	// of 9,900 other keys that come and go in a random order. After each
	// round the set holds the 100, each with its id, and one fire wakes each
	// once.
	#[test]
	fn keys_that_stay_keep_their_waits_as_the_set_gives_back_room() {
		let wakers = Arc::new(Wakers::default());
		let mut stays = live(100);
		for (round, seed) in [
			0xbb67_ae85_84ca_a73b_u64,
			0x3c6e_f372_fe94_f82b,
			0xa54f_f53a_5f1d_36f1,
			0x510e_527f_ade6_82d1,
			0x9b05_688c_2b3e_6c1f,
			0x1f83_d9ab_fb41_bd6b,
			0x5be0_cd19_137e_2179,
			0xcbbb_9d5d_c105_9ed8,
		]
		.into_iter()
		.enumerate()
		{
			let mut others = live(9_900);
			// The 100 wait between the others, so their slots are all
			// through the set.
			for (i, t) in others.iter_mut().enumerate() {
				if i % 99 == 0 && i / 99 < 100 {
					let s = &mut stays[i / 99];
					wakers.wait(&mut s.key, &s.waker);
				}
				wakers.wait(&mut t.key, &t.waker);
			}
			let ids: Vec<u64> = stays
				.iter()
				.map(|s| s.key.id_in(&wakers).unwrap())
				.collect();
			let room = wakers.room();
			assert!(room >= 10_000, "round {round}: room for {room} slots");
			for i in shuffled(others.len(), seed) {
				others[i].key = WaitKey::default();
			}
			assert!(wakers.room() < room / 8, "round {round}: no room given back ({room} slots)");
			assert_eq!((wakers.held(), wakers.keys()), (100, 100), "round {round}");
			for (s, id) in stays.iter().zip(&ids) {
				assert_eq!(
					s.key.id_in(&wakers),
					Some(*id),
					"round {round}: a key that stays lost its id"
				);
			}
			Waker::from(Arc::clone(&wakers)).wake();
			let wakes: Vec<usize> = stays.iter().map(|s| s.task.wakes()).collect();
			assert!(wakes.iter().all(|&w| w == round + 1), "round {round}: wakes {wakes:?}");
			assert!(
				others.iter().all(|t| t.task.wakes() == 0),
				"round {round}: a dropped key was woken"
			);
		}
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

	// Failure mode (review of #111 at 3b9fe7ab): a task that waits on two
	// things at once through one object (a zsh multios tee's targets) with
	// one key waited only on the last, so the first one's readiness never
	// woke it. Each sub key waits in its own set, and they go with their key.
	#[test]
	fn sub_keys_wait_in_sets_of_their_own() {
		let (one, two) = (Arc::new(Wakers::default()), Arc::new(Wakers::default()));
		let task = Arc::new(Task::default());
		let waker = Waker::from(Arc::clone(&task));
		let mut key = WaitKey::default();
		one.wait(key.sub(0), &waker);
		two.wait(key.sub(1), &waker);
		assert_eq!((one.held(), two.held()), (1, 1));
		// The key itself waits elsewhere, and moves on: its sub keys stay.
		let (three, four) = (Arc::new(Wakers::default()), Arc::new(Wakers::default()));
		three.wait(&mut key, &waker);
		four.wait(&mut key, &waker);
		assert_eq!((one.keys(), two.keys(), three.keys(), four.keys()), (1, 1, 0, 1));
		Waker::from(Arc::clone(&one)).wake();
		assert_eq!(task.wakes(), 1, "the first thing's readiness wakes the task");
		Waker::from(Arc::clone(&two)).wake();
		assert_eq!(task.wakes(), 2, "the second thing's readiness wakes it too");
		one.wait(key.sub(0), &waker);
		drop(key);
		assert_eq!((one.keys(), two.keys(), four.keys()), (0, 0, 0), "sub keys go with their key");
	}

	// Failure mode: a thing that keeps a result for the task that asked for
	// it (a provider file's write) gave it to another task, because two keys
	// shared an id or a key's id changed while it lived, or kept it for good
	// after the task's key was gone.
	#[test]
	fn a_key_keeps_its_id_and_no_other_key_gets_it() {
		let (set, other) = (Arc::new(Wakers::default()), Arc::new(Wakers::default()));
		let waker = Waker::from(Arc::new(Task::default()));
		let (mut a, mut b) = (WaitKey::default(), WaitKey::default());
		assert_eq!(a.id_in(&set), None, "no id before it waits");
		set.wait(&mut a, &waker);
		let id = a.id_in(&set).unwrap();
		Waker::from(Arc::clone(&set)).wake();
		set.wait(&mut a, &waker);
		assert_eq!(a.id_in(&set), Some(id), "the same id after a wake and a new wait");
		set.wait(&mut b, &waker);
		assert_ne!(b.id_in(&set), Some(id));
		assert!(set.holds(id));
		drop(a);
		assert!(!set.holds(id), "a dropped key holds nothing");
		// The set empties, gives its room back, and gives out ids again.
		drop(b);
		let mut c = WaitKey::default();
		set.wait(&mut c, &waker);
		assert_ne!(c.id_in(&set), Some(id), "an id is never given again");
		other.wait(&mut c, &waker);
		assert_eq!(c.id_in(&set), None, "a key that waits elsewhere has no id here");
		assert_eq!(set.keys(), 0);
	}
}
