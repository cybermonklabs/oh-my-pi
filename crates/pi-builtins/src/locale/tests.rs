//! The shell's locale as a command it starts would see it: its search
//! path, its working directory, and the locale utility that answers for
//! it. Each test runs in its own process under nextest.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// A locale name no installed locale archive can answer for, so only the
/// directory the test generates can supply it.
#[cfg(target_os = "linux")]
const SHELL_ONLY_LOCALE: &str = "omp_rsync_latin1";

/// An ISO-8859-1 locale under `<dir>/locales/<SHELL_ONLY_LOCALE>`, built with
/// `localedef`. ISO-8859-1 represents every byte, so rsync 3.5.1 under it
/// prints a non-ASCII name's bytes (measured: `env -i LOCPATH=… LC_ALL=…
/// rsync -ai "src/ünï.txt" dst/` prints them) where the C locale escapes
/// them. `None` on a host without locale sources, which cannot host the
/// scenario at all.
#[cfg(target_os = "linux")]
fn shell_only_locale(dir: &Path) -> Option<PathBuf> {
	let locales = dir.join("locales");
	fs::create_dir_all(locales.join(SHELL_ONLY_LOCALE)).unwrap();
	let built = Command::new("localedef")
		.args(["-i", "en_US", "-f", "ISO-8859-1"])
		.arg(locales.join(SHELL_ONLY_LOCALE))
		.output();
	fs::create_dir_all(dir.join("src")).unwrap();
	fs::write(dir.join("src/ünï.txt"), b"x\n").unwrap();
	built.is_ok_and(|built| built.status.success()).then_some(locales)
}

/// A working directory the child cannot be put into ends the query.
///
/// The error says nothing about what the reference resolves from a
/// directory it is already inside: `EACCES` can come from an ancestor the
/// reference never traverses, and `ENOENT` or `ENOTDIR` can mean the
/// directory was renamed rather than removed. Measured on the gate VM, the
/// reference answers `ISO-8859-1` in the ancestor and renamed cases and
/// `ANSI_X3.4-1968` in the archive one, and this cannot reproduce any of
/// them — so each is reported rather than answered from a question that was
/// changed to make it answerable.
///
/// The `unsearchable` row is the one that changed on purpose: an earlier
/// revision answered `ISO-8859-1` there, which is what the reference
/// answers, by dropping the relative entry. That agreement was luck — the
/// reference is inside a directory no process can enter — and the same
/// reasoning answered wrongly in every other row here.
#[cfg(target_os = "linux")]
#[test]
fn a_working_directory_the_child_cannot_enter_is_reported() {
	use std::os::unix::fs::PermissionsExt as _;

	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let mixed = format!("missing:{}", locales.display());
	let listed = format!("locales:{}", locales.display());
	let open = |at: &Path| fs::set_permissions(at, fs::Permissions::from_mode(0o755)).unwrap();
	let shut = |at: &Path| fs::set_permissions(at, fs::Permissions::from_mode(0o600)).unwrap();
	// Each case is a working directory and the search path the shell set in
	// it. The last is the one that used to come back from glibc's locale
	// archive, which an emptied `LOCPATH` turns back on: `en_US.utf8` is
	// installed, and the reference in that directory still reports the C
	// locale because its own `LOCPATH` names nothing it can read.
	let cases: [(&str, &str, &str); 5] = [
		("unsearchable", SHELL_ONLY_LOCALE, &mixed),
		("removed", SHELL_ONLY_LOCALE, &mixed),
		("ancestor/child", SHELL_ONLY_LOCALE, "locales"),
		("renamed", SHELL_ONLY_LOCALE, &listed),
		("archive", "en_US.utf8", "missing"),
	];
	for (at, locale, path) in cases {
		let cwd = dir.path().join(at);
		fs::create_dir_all(&cwd).unwrap();
		std::os::unix::fs::symlink(&locales, cwd.join("locales")).unwrap();
		// The shell is already in the directory; what no process can do is
		// enter it again, which is what putting a child there asks.
		let (host, _) = crate::host::Host::for_test("rsync", "", &cwd);
		let child = host.child_env();
		match at {
			"removed" => fs::remove_dir_all(&cwd).unwrap(),
			"ancestor/child" => shut(&dir.path().join("ancestor")),
			"renamed" => {
				fs::rename(&cwd, dir.path().join("renamed-away")).unwrap();
				fs::write(&cwd, b"not a directory\n").unwrap();
			},
			_ => shut(&cwd),
		}
		let env = |key: &str| (key == "LOCPATH").then(|| path.to_owned());
		let answer = crate::locale::loaded_codeset(locale, &env, Some(&child));
		match at {
			"removed" | "renamed" => {},
			"ancestor/child" => open(&dir.path().join("ancestor")),
			_ => open(&cwd),
		}
		assert!(matches!(&answer, crate::locale::Codeset::Unasked(_)), "{at}: {answer:?}");
	}
}

/// A working directory the child cannot be put into does not stop an answer
/// that never needed one.
///
/// `PATH_LOCALE` is the BSDs' variable, and no libc that runs on Linux
/// reads it, so a relative value there asks for no directory at all: the
/// lookup goes ahead and agrees with the reference.
///
/// A search path whose absolute entries come before its relative ones does
/// *not* get the same treatment, and the second half of this test holds
/// that line. Cutting the list at its first relative entry looked
/// order-preserving and is not: glibc tries each *name* candidate across
/// every directory before the next candidate (`intl/l10nflist.c`), so a
/// prefix can answer from fallback data where the whole list would have
/// found an exact match further along — measured for `astra@special`,
/// where the reference inside the directory chose UTF-8 and the prefix
/// chose Latin-1. A trailing cut can also invent a source: `/nonexistent::missing`
/// cut to `/nonexistent:` ends in an empty entry, which is the root.
#[cfg(target_os = "linux")]
#[test]
fn an_answer_that_needs_no_working_directory_is_still_given() {
	use std::os::unix::fs::PermissionsExt as _;

	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let absolute = locales.display().to_string();
	let cwd = dir.path().join("unsearchable");
	fs::create_dir_all(&cwd).unwrap();
	let (host, _) = crate::host::Host::for_test("rsync", "", &cwd);
	let child = host.child_env();
	fs::set_permissions(&cwd, fs::Permissions::from_mode(0o600)).unwrap();
	let free = |key: &str| match key {
		"LOCPATH" => Some(absolute.clone()),
		"PATH_LOCALE" => Some("relative-locales".to_owned()),
		_ => None,
	};
	let answered = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &free, Some(&child));
	// A list that starts absolute still needs the directory, because a
	// later entry can hold the better name candidate.
	let mixed = format!("{absolute}:missing");
	let bound = |key: &str| (key == "LOCPATH").then(|| mixed.clone());
	let reported = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &bound, Some(&child));
	fs::set_permissions(&cwd, fs::Permissions::from_mode(0o755)).unwrap();
	assert!(
		matches!(&answered, crate::locale::Codeset::Loaded(codeset) if codeset == "ISO-8859-1"),
		"{answered:?}"
	);
	assert!(matches!(&reported, crate::locale::Codeset::Unasked(_)), "{reported:?}");
}

/// A process that has the kernel reap its children cannot hold the
/// utility's number, so no query is started there.
///
/// With `SIGCHLD` ignored or `SA_NOCLDWAIT` set the leader is reaped the
/// moment it exits: `waitid` then says `ECHILD`, the number is back in
/// circulation, and `kill(-pid, SIGKILL)` reaches whatever took it — an
/// unrelated process, three times out of three in a private PID namespace,
/// under each disposition. The lookup reports instead, and nothing it did
/// can have signalled anyone.
#[cfg(target_os = "linux")]
#[test]
fn a_process_whose_children_are_reaped_for_it_asks_nothing() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let shell_path = locales.to_str().unwrap().to_owned();
	let env = move |key: &str| (key == "LOCPATH").then(|| shell_path.clone());
	// The same query answers under the ordinary disposition, so what the
	// second half measures is the disposition and nothing else.
	let ordinary = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, None);
	// SAFETY: nextest gives this test its own process, which starts no other
	// child; the disposition is put back below.
	let kept = unsafe { libc::signal(libc::SIGCHLD, libc::SIG_IGN) };
	let reaped_for_us = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, None);
	// SAFETY: as above.
	unsafe { libc::signal(libc::SIGCHLD, kept) };
	assert!(
		matches!(&ordinary, crate::locale::Codeset::Loaded(codeset) if codeset == "ISO-8859-1"),
		"{ordinary:?}"
	);
	let crate::locale::Codeset::Unasked(why) = &reaped_for_us else {
		panic!("{reaped_for_us:?}");
	};
	assert!(why.contains("reap its children"), "{why}");
}

/// A loadability answer needs a whole reply, not only silence.
///
/// A utility that exits 0 writing nothing, and one that floods its output
/// with no diagnostic at all, both pass the quiet test and have reported
/// nothing — and both used to affirm that a locale with no data anywhere
/// loads.
#[cfg(target_os = "linux")]
#[test]
fn a_silent_or_flooding_utility_affirms_nothing() {
	use std::os::unix::fs::PermissionsExt as _;

	let dir = tempfile::tempdir().unwrap();
	let cases: [(&str, &str, bool); 3] = [
		("quiet", "printf 'ISO-8859-1\\n'\n", true),
		("silent", "exit 0\n", false),
		("flood", "dd if=/dev/zero bs=1024 count=200 2>/dev/null | tr '\\\\0' 'X'\n", false),
	];
	for (name, body, accepts) in cases {
		let program = dir.path().join(name);
		fs::write(&program, format!("#!/bin/sh\n{body}")).unwrap();
		fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
		let answer = crate::locale::utility_accepts_for_test(&program, "de_DE@absent;bogus");
		match (&answer, accepts) {
			(crate::locale::Loadable::Yes, true) | (crate::locale::Loadable::Unasked(_), false) => {},
			_ => panic!("{name}: {}", matches!(answer, crate::locale::Loadable::No)),
		}
	}
}

/// A query libc could not be asked is not an observation of the C locale.
///
/// Under `SIGCHLD=SIG_IGN` no query runs at all, and reading that refusal
/// as "not a UTF-8 locale" put a newline inside `é`: GNU `fold -w1` on
/// `LC_ALL=C.UTF-8` gives `c3 a9`, and so must this.
#[cfg(target_os = "linux")]
#[test]
fn a_refused_query_falls_back_to_the_name_and_says_so() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let (host, capture) = crate::host::Host::for_test("fold", "", dir.path());
	let mut host = host;
	host.set_test_var("LC_ALL", "C.UTF-8");
	host.set_test_var("LOCPATH", locales.to_str().unwrap());
	// SAFETY: nextest gives this test its own process, which starts no other
	// child; the disposition is put back below.
	let kept = unsafe { libc::signal(libc::SIGCHLD, libc::SIG_IGN) };
	let utf8 = crate::locale::ctype_is_utf8(&host);
	// SAFETY: as above.
	unsafe { libc::signal(libc::SIGCHLD, kept) };
	assert!(utf8, "a refusal is not an observation of the C locale");
	assert!(
		String::from_utf8_lossy(&capture.stderr()).contains("cannot read the locale"),
		"{}",
		String::from_utf8_lossy(&capture.stderr())
	);
}

/// GNU utilities initialise with `setlocale(LC_ALL, "")`, which fails as a
/// whole when one category's data is missing — and then they run in C.
///
/// Measured against GNU fold 9.12 and sort 9.4: with `LC_ALL` naming a
/// locale that holds only `LC_CTYPE`, `fold -w1` splits `é`; with one that
/// holds only `LC_NUMERIC`, `sort -sn` uses the C decimal point.
#[cfg(target_os = "linux")]
#[test]
fn a_locale_missing_a_category_leaves_the_utilities_in_c() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let partial = |name: &str, keep: &str| {
		let built = Command::new("localedef")
			.args(["-i", "de_DE", "-f", "UTF-8"])
			.arg(locales.join(name))
			.output()
			.is_ok_and(|built| built.status.success());
		if !built {
			return false;
		}
		for left in fs::read_dir(locales.join(name)).unwrap() {
			let left = left.unwrap();
			if left.file_name() == keep {
				continue;
			}
			match left.file_type().unwrap().is_dir() {
				true => fs::remove_dir_all(left.path()).unwrap(),
				false => fs::remove_file(left.path()).unwrap(),
			}
		}
		true
	};
	if !partial("de_DE@partial;ctype", "LC_CTYPE") || !partial("de_DE@partial;numeric", "LC_NUMERIC") {
		return;
	}
	let shell = |name: &str| {
		let (host, _) = crate::host::Host::for_test("fold", "", dir.path());
		let mut host = host;
		host.set_test_var("LC_ALL", name);
		host.set_test_var("LOCPATH", locales.to_str().unwrap());
		host
	};
	let ctype = shell("de_DE@partial;ctype");
	assert!(!crate::locale::ctype_is_utf8(&ctype), "a locale with no LC_NUMERIC leaves fold in C");
	let numeric = shell("de_DE@partial;numeric");
	assert_eq!(
		crate::locale::numeric_symbols(&numeric),
		crate::locale::NumericSymbols::C,
		"a locale with no LC_CTYPE leaves sort in C"
	);
	// The control: the same generation with every category kept does
	// initialise, and its numerics are the locale's.
	let whole = "de_DE@whole;valid";
	let built = Command::new("localedef")
		.args(["-i", "de_DE", "-f", "UTF-8"])
		.arg(locales.join(whole))
		.output()
		.is_ok_and(|built| built.status.success());
	if built {
		assert_ne!(crate::locale::numeric_symbols(&shell(whole)), crate::locale::NumericSymbols::C, "{whole}");
	}
}

/// Another reaper in this process must not turn the query into a signal
/// aimed at whoever took the utility's number.
///
/// The query holds the child by a handle rather than by number, so a
/// competing `waitpid(-1)` can take the child away from it — the query then
/// reports — but nothing it does afterwards reaches a recycled number.
#[cfg(target_os = "linux")]
#[test]
fn a_competing_reaper_does_not_turn_the_query_into_a_stray_signal() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let shell_path = locales.to_str().unwrap().to_owned();
	let env = move |key: &str| (key == "LOCPATH").then(|| shell_path.clone());
	let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
	let reaper = {
		let stop = std::sync::Arc::clone(&stop);
		std::thread::spawn(move || {
			while !stop.load(std::sync::atomic::Ordering::Relaxed) {
				// SAFETY: a non-blocking wait for any child of this process.
				unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) };
			}
		})
	};
	let answers: Vec<_> =
		(0..20).map(|_| crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, None)).collect();
	stop.store(true, std::sync::atomic::Ordering::Relaxed);
	reaper.join().unwrap();
	for answer in &answers {
		assert!(
			matches!(answer, crate::locale::Codeset::Loaded(codeset) if codeset == "ISO-8859-1")
				|| matches!(answer, crate::locale::Codeset::Unasked(_)),
			"{answer:?}"
		);
	}
	// Nothing is left for the kernel to carry: every query either reaped
	// its own child or never started one. The children of *every* task,
	// because the query ran on a worker and `/proc/self/task/<pid>` is the
	// main thread's; and a list that cannot be read is a failure here, not
	// an empty one.
	let tasks = fs::read_dir("/proc/self/task").expect("this process's task list");
	for task in tasks {
		let task = task.expect("a task of this process");
		let left = fs::read_to_string(task.path().join("children")).expect("a task's children");
		assert!(left.trim().is_empty(), "children left behind by {:?}: {left}", task.file_name());
	}
}

/// Every caller of [`crate::locale::locale_loadable`] models
/// `setlocale(CATEGORY, "")`, which takes a name whole where `newlocale`
/// splits one carrying a `;` per category — and asks about the category it
/// was given, which a codeset cannot report on.
///
/// Measured: with no data named `LC_CTYPE=C;LC_TIME=C.UTF-8` the reference
/// reports `ANSI_X3.4-1968` and `fold -w1` splits the two bytes of `é`,
/// while `newlocale` loads that name and its `.UTF-8` tail reads as a UTF-8
/// locale; data literally named `astra;latin` loads as Latin-1 for the
/// reference while `newlocale` refuses it; and a German locale generated
/// against the ASCII charmap loads with a decimal comma while its codeset
/// is the C locale's, so reading loadability off `charmap` called its
/// numerics absent.
#[cfg(target_os = "linux")]
#[test]
fn a_composite_looking_name_is_loadable_only_as_the_reference_loads_it() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let mut copy = Command::new("cp");
	copy.arg("-a").arg(locales.join(SHELL_ONLY_LOCALE)).arg(locales.join("astra;latin"));
	assert!(copy.output().unwrap().status.success());
	// A locale whose charset is the C locale's but whose numerics are not.
	let ascii = "de_DE@ascii;valid";
	let built = Command::new("localedef")
		.args(["-i", "de_DE", "-f", "ANSI_X3.4-1968"])
		.arg(locales.join(ascii))
		.output()
		.is_ok_and(|built| built.status.success());
	// SAFETY: nextest gives this test its own process, and nothing else in
	// it reads `LOCPATH` concurrently.
	unsafe { std::env::set_var("LOCPATH", &locales) };
	let absent = crate::locale::locale_loadable("LC_CTYPE=C;LC_TIME=C.UTF-8", libc::LC_CTYPE_MASK);
	let present = crate::locale::locale_loadable("astra;latin", libc::LC_CTYPE_MASK);
	let numerics = built.then(|| crate::locale::locale_loadable(ascii, libc::LC_NUMERIC_MASK));
	let (utf8, _) = crate::host::Host::for_test("rsync", "", dir.path());
	let mut utf8 = utf8;
	utf8.set_test_var("LC_CTYPE", "LC_CTYPE=C;LC_TIME=C.UTF-8");
	let reads_as_utf8 = crate::locale::ctype_is_utf8(&utf8);
	// SAFETY: as above.
	unsafe { std::env::remove_var("LOCPATH") };
	assert!(!absent, "a name with no data of its own is not loadable");
	assert!(present, "data literally named with a semicolon is loadable");
	assert_ne!(numerics, Some(false), "an ASCII-charset locale still has its own numerics");
	assert!(!reads_as_utf8, "a name that loads nothing is not a UTF-8 locale");
}

/// A lock another thread of this process holds must not reach the lookup.
///
/// glibc takes one lock for every locale load, and a lookup that forks
/// inherits it held by a thread the child does not have: the child then
/// waits for it for ever. With `SIGALRM` blocked in the calling thread — as
/// it is inside that signal's own handler — the child inherits the mask too,
/// so even an alarm it set for itself cannot end the wait. Nothing here
/// loads a locale in this process or in a copy of it, so the lock is not
/// this lookup's business at all.
#[cfg(target_os = "linux")]
#[test]
fn a_locale_lock_another_thread_holds_does_not_reach_the_lookup() {
	use std::sync::mpsc;
	use std::time::Duration;

	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	// A locale whose `LC_CTYPE` is a FIFO nobody writes to: the thread that
	// loads it blocks in `open` with glibc's locale lock held.
	let blocking = dir.path().join("blocking");
	fs::create_dir_all(blocking.join("omp_rsync_fifo")).unwrap();
	let fifo = blocking.join("omp_rsync_fifo/LC_CTYPE");
	nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
	// SAFETY: nextest gives this test its own process, and nothing else in it
	// reads `LOCPATH` concurrently. libc reads it from the process
	// environment, so this is the only way to aim the holding thread at the
	// FIFO.
	unsafe { std::env::set_var("LOCPATH", &blocking) };
	std::thread::spawn(|| {
		// SAFETY: a valid NUL-terminated name; the call blocks and the handle,
		// if it ever returns one, is leaked with the thread.
		unsafe { libc::newlocale(libc::LC_CTYPE_MASK, c"omp_rsync_fifo".as_ptr(), std::ptr::null_mut()) };
	});
	// The lock is taken inside `newlocale`; give the thread time to reach it.
	std::thread::sleep(Duration::from_millis(300));

	let (answered, answer) = mpsc::channel();
	let shell_path = locales.to_str().unwrap().to_owned();
	std::thread::spawn(move || {
		let mut alarm = nix::sys::signal::SigSet::empty();
		alarm.add(nix::sys::signal::SIGALRM);
		alarm.thread_block().unwrap();
		let env = move |key: &str| (key == "LOCPATH").then(|| shell_path.clone());
		let _ = answered.send(format!("{:?}", crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, None)));
	});
	let codeset = answer.recv_timeout(Duration::from_secs(10));
	// Let the holding thread out of `open` before the directory goes.
	let _ = std::fs::OpenOptions::new().write(true).open(&fifo);
	// SAFETY: as above.
	unsafe { std::env::remove_var("LOCPATH") };
	assert_eq!(codeset.as_deref(), Ok("Loaded(\"ISO-8859-1\")"));
}

/// The lookup must spend no descriptor the answer does not need.
///
/// Measured with `RLIMIT_NOFILE=5`, which leaves two free: the reference
/// reports `ISO-8859-1`, while a lookup whose child keeps both ends of its
/// own result pipe has none left for the locale data and reports nothing.
/// Two free descriptors are exactly what the answer pipe costs here, and the
/// child that reads the locale keeps none of them.
#[cfg(target_os = "linux")]
#[test]
fn a_descriptor_limit_with_two_to_spare_still_answers() {
	use std::os::fd::{FromRawFd as _, OwnedFd};

	use nix::sys::resource::{Resource, getrlimit, setrlimit};

	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let shell_path = locales.to_str().unwrap().to_owned();
	let env = move |key: &str| (key == "LOCPATH").then(|| shell_path.clone());
	let (soft, hard) = getrlimit(Resource::RLIMIT_NOFILE).unwrap();
	let open = u64::try_from(fs::read_dir("/proc/self/fd").unwrap().count()).unwrap();
	// A limit just above what is open now, so filling it costs nothing.
	setrlimit(Resource::RLIMIT_NOFILE, open + 8, hard).unwrap();
	let mut burned: Vec<OwnedFd> = Vec::new();
	loop {
		// SAFETY: duplicating a descriptor this process owns until the limit
		// refuses; each result is owned here and closed below.
		let spare = unsafe { libc::dup(0) };
		if spare < 0 {
			break;
		}
		// SAFETY: `spare` is a fresh descriptor nothing else owns.
		burned.push(unsafe { OwnedFd::from_raw_fd(spare) });
	}
	// Give back exactly two: the answer pipe fits, and nothing else does.
	burned.truncate(burned.len().saturating_sub(2));
	let answer = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, None);
	drop(burned);
	setrlimit(Resource::RLIMIT_NOFILE, soft, hard).unwrap();
	assert!(matches!(&answer, crate::locale::Codeset::Loaded(codeset) if codeset == "ISO-8859-1"), "{answer:?}");
}

/// A second locale under `<dir>/<name>`, in `codeset`. `None` on a host
/// without locale sources.
#[cfg(target_os = "linux")]
fn generated_locale(dir: &Path, name: &str, codeset: &str) -> Option<PathBuf> {
	fs::create_dir_all(dir.join(name)).unwrap();
	let built = Command::new("localedef").args(["-i", "en_US", "-f", codeset]).arg(dir.join(name)).output();
	built.is_ok_and(|built| built.status.success()).then(|| dir.to_path_buf())
}

/// A directory name is not a list element: a working directory holding a
/// `:` has no spelling inside `LOCPATH`, so nothing may try to give it one.
///
/// Measured from a cwd named `with:colon` holding a `locales` symlink: the
/// reference reports `ISO-8859-1` for `LOCPATH=locales`, for `LOCPATH=.`,
/// and for the mixed list, and rsync 3.5.1 prints `ünï.txt` in each.
#[cfg(target_os = "linux")]
#[test]
fn a_colon_in_the_working_directory_is_not_a_list_separator() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let Some(utf8) = generated_locale(&dir.path().join("utf8"), SHELL_ONLY_LOCALE, "UTF-8") else { return };
	let cwd = dir.path().join("with:colon");
	fs::create_dir_all(&cwd).unwrap();
	std::os::unix::fs::symlink(&locales, cwd.join("locales")).unwrap();
	std::os::unix::fs::symlink(locales.join(SHELL_ONLY_LOCALE), cwd.join(SHELL_ONLY_LOCALE)).unwrap();
	let (host, _) = crate::host::Host::for_test("rsync", "", &cwd);
	let child = host.child_env();
	// The last one puts a UTF-8 locale of the same name second in the list,
	// so a lookup that loses the relative entry answers `UTF-8` rather than
	// merely falling back to C.
	for path in ["locales".to_owned(), ".".to_owned(), format!("locales:{}", utf8.display())] {
		let env = |key: &str| (key == "LOCPATH").then(|| path.clone());
		let answer = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, Some(&child));
		assert!(
			matches!(&answer, crate::locale::Codeset::Loaded(codeset) if codeset == "ISO-8859-1"),
			"{path}: {answer:?}"
		);
	}
}

/// A working directory the shell is in but that no longer exists keeps a
/// parent in the kernel that its vanished pathname does not: the reference
/// resolves `../locales` from it and this cannot. An answer from somewhere
/// else is not that answer, so the lookup says so instead of giving one —
/// and `./../` reaches that parent exactly as `../` does, so no reading of
/// the entries can stand in for entering the directory.
#[cfg(target_os = "linux")]
#[test]
fn a_vanished_working_directory_is_reported_rather_than_guessed() {
	let dir = tempfile::tempdir().unwrap();
	if shell_only_locale(dir.path()).is_none() {
		return;
	}
	for path in ["../locales", "./../locales", "././../locales"] {
		let cwd = dir.path().join(path.replace(['.', '/'], "-"));
		fs::create_dir_all(&cwd).unwrap();
		let (host, _) = crate::host::Host::for_test("rsync", "", &cwd);
		let child = host.child_env();
		fs::remove_dir(&cwd).unwrap();
		let env = |key: &str| (key == "LOCPATH").then(|| path.to_owned());
		let answer = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, Some(&child));
		assert!(matches!(&answer, crate::locale::Codeset::Unasked(_)), "{path}: {answer:?}");
	}
}

/// A utility that does not answer whole, or does not finish, has not
/// answered. A byte cap bounds what is stored, not what it means.
#[cfg(target_os = "linux")]
#[test]
fn a_locale_utility_that_misbehaves_is_reported() {
	use std::os::unix::fs::PermissionsExt as _;

	let dir = tempfile::tempdir().unwrap();
	let env = |_: &str| None;
	let cases: [(&str, &str, &str); 7] = [
		("plain", "printf 'ISO-8859-1\\n'\n", ""),
		("status", "printf 'UTF-8\\n'\nexit 7\n", "exited with status 7"),
		("signal", "printf 'UTF-8\\n'\nkill -9 $$\n", "ended on signal 9"),
		("diagnostic-first", "printf 'warning: alien\\nUTF-8\\n'\n", "where one codeset was due"),
		("nul", "printf 'UTF-8\\000junk\\n'\n", "where one codeset was due"),
		("flood", "dd if=/dev/zero bs=1024 count=4096 2>/dev/null | tr '\\\\0' 'X'\n", "wrote more than"),
		("closes-and-lingers", "printf 'UTF-8\\n'\nexec 1>&-\nsleep 30\n", "was ended before it finished"),
	];
	for (name, body, expected) in cases {
		let program = dir.path().join(name);
		fs::write(&program, format!("#!/bin/sh\n{body}")).unwrap();
		fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
		let answer = crate::locale::codeset_from_utility_for_test(&program, "C.UTF-8", &env);
		match (&answer, expected) {
			(crate::locale::Codeset::Loaded(codeset), "") => assert_eq!(codeset, "ISO-8859-1", "{name}"),
			(crate::locale::Codeset::Unasked(why), _) if !expected.is_empty() => {
				assert!(why.contains(expected), "{name}: {why}");
			},
			_ => panic!("{name}: {answer:?}"),
		}
	}
}

/// Nothing the utility leaves in its process group outlives the query,
/// whether it answered or not: a descendant that closes the answer pipe and
/// sleeps used to survive, because the normal-exit path returned without
/// sweeping the group. One that calls `setsid` leaves the group and is
/// beyond this.
#[cfg(target_os = "linux")]
#[test]
fn a_descendant_of_the_utility_does_not_outlive_the_query() {
	use std::os::unix::fs::PermissionsExt as _;

	let dir = tempfile::tempdir().unwrap();
	let program = dir.path().join("locale");
	let marker = dir.path().join("descendant");
	// The utility leaves a descendant that closes the pipe it inherited and
	// sleeps, records that descendant's process id (`$$` in a subshell is
	// still the shell's), answers, and exits 0.
	let body = format!(
		"#!/bin/sh\n(exec 1>&-; exec sleep 30) &\necho $! > '{}'\nprintf 'ISO-8859-1\\n'\nexit 0\n",
		marker.display()
	);
	fs::write(&program, body).unwrap();
	fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
	let env = |_: &str| None;
	let answer = crate::locale::codeset_from_utility_for_test(&program, "C.UTF-8", &env);
	assert!(matches!(&answer, crate::locale::Codeset::Loaded(codeset) if codeset == "ISO-8859-1"), "{answer:?}");
	let descendant: i32 = fs::read_to_string(&marker).unwrap().trim().parse().unwrap();
	// The kill is delivered as the group leader is reaped; give it the
	// moment the scheduler needs, then insist the process is gone.
	for _ in 0..200 {
		// SAFETY: a signal-free existence probe for a process this test
		// started and does not reap.
		if unsafe { libc::kill(descendant, 0) } != 0 {
			return;
		}
		std::thread::sleep(std::time::Duration::from_millis(10));
	}
	// SAFETY: as above; the test cleans up what it started before failing.
	unsafe { libc::kill(descendant, libc::SIGKILL) };
	panic!("the descendant {descendant} outlived the query");
}

/// A standard descriptor the caller has closed must not become the answer.
///
/// Whichever of them is closed, the open the child does for `/dev/null`
/// takes that number, so the answer stream has to be redirected first:
/// doing it the other way round put the answer file in `/dev/null`'s place
/// and left the later duplications reading *it* as their source. Measured
/// with stderr closed and real `/usr/bin/locale`: the diagnostics stream
/// carried `ISO-8859-1` instead of nothing and a loadable locale read as
/// unloadable.
#[cfg(target_os = "linux")]
#[test]
fn a_closed_standard_descriptor_never_becomes_the_answer() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	// A name only the utility can answer for, so the diagnostics stream is
	// exercised as well as the codeset one.
	let literal = "omp;literal";
	let mut copy = Command::new("cp");
	copy.arg("-a").arg(locales.join(SHELL_ONLY_LOCALE)).arg(locales.join(literal));
	assert!(copy.output().unwrap().status.success());
	let shell_path = locales.to_str().unwrap().to_owned();
	let env = move |key: &str| (key == "LOCPATH").then(|| shell_path.clone());
	// SAFETY: nextest gives this test its own process, and nothing else in
	// it reads `LOCPATH` concurrently.
	unsafe { std::env::set_var("LOCPATH", &locales) };
	for closed in 1..8u32 {
		let wanted: Vec<i32> = (0..3).filter(|standard| closed & (1 << standard) != 0).collect();
		// SAFETY: every descriptor is put back below, before anything else
		// in this process writes to one.
		let kept: Vec<(i32, i32)> =
			wanted.iter().map(|standard| (*standard, unsafe { libc::dup(*standard) })).collect();
		// SAFETY: as above.
		for (standard, _) in &kept {
			unsafe { libc::close(*standard) };
		}
		let codeset = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, None);
		let loadable = crate::locale::locale_loadable(literal, libc::LC_CTYPE_MASK);
		// SAFETY: as above; every saved descriptor is this test's own.
		for (standard, saved) in &kept {
			unsafe {
				libc::dup2(*saved, *standard);
				libc::close(*saved);
			}
		}
		assert!(
			matches!(&codeset, crate::locale::Codeset::Loaded(found) if found == "ISO-8859-1"),
			"closed {wanted:?}: {codeset:?}"
		);
		assert!(loadable, "closed {wanted:?}: the literal name is loadable");
	}
	// SAFETY: as above.
	unsafe { std::env::remove_var("LOCPATH") };
}

/// A query leaves the caller's signal mask as it found it, and leaves an
/// ignored disposition ignored.
///
/// Blocking every signal across the clone is this code's business and not
/// the caller's: a mask call whose failure went unchecked used to "restore"
/// an empty set and hand back a thread with nothing blocked. And resetting
/// *ignored* dispositions is not `posix_spawn`'s contract — with `SIGPIPE`
/// ignored in the caller, a utility that raises it and then answers
/// succeeds under `posix_spawn` and died on signal 13 when this reset it.
#[cfg(target_os = "linux")]
#[test]
fn a_query_leaves_the_callers_signal_settings_alone() {
	use std::os::unix::fs::PermissionsExt as _;

	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let shell_path = locales.to_str().unwrap().to_owned();
	let env = move |key: &str| (key == "LOCPATH").then(|| shell_path.clone());
	let blocked = |signal| {
		let mask = nix::sys::signal::SigSet::thread_get_mask();
		mask.map(|held| held.contains(signal)).unwrap_or_default()
	};
	let mut usr1 = nix::sys::signal::SigSet::empty();
	usr1.add(nix::sys::signal::SIGUSR1);
	usr1.thread_block().unwrap();
	// SAFETY: nextest gives this test its own process; the disposition is
	// put back below.
	let kept = unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) };
	let before = blocked(nix::sys::signal::SIGUSR1);
	let answer = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, None);
	let after = blocked(nix::sys::signal::SIGUSR1);
	// A utility that raises the signal the caller ignores, then answers.
	let program = dir.path().join("locale");
	fs::write(&program, "#!/bin/sh\nkill -PIPE $$\nprintf 'UTF-8\\n'\n").unwrap();
	fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
	let ignored = crate::locale::codeset_from_utility_for_test(&program, "C.UTF-8", &|_| None);
	// SAFETY: as above.
	unsafe { libc::signal(libc::SIGPIPE, kept) };
	usr1.thread_unblock().unwrap();
	assert!(matches!(&answer, crate::locale::Codeset::Loaded(found) if found == "ISO-8859-1"), "{answer:?}");
	assert!(before && after, "the caller's mask is its own: before {before}, after {after}");
	assert!(
		matches!(&ignored, crate::locale::Codeset::Loaded(found) if found == "UTF-8"),
		"an ignored disposition stays ignored: {ignored:?}"
	);
}

/// An inherited *handler* does not run in the child, in the one window
/// `execve` does not close by itself.
///
/// A successful `execve` resets every caught disposition on its own, so a
/// utility that raises a signal once it is running says nothing about
/// this code: the test that did that passed with the whole reset loop
/// deleted. The handler has to be observed — or observed not to run —
/// *before* the `execve`, and the child's life up to there is a few dozen
/// microseconds.
///
/// So this takes a process group of its own and sends `SIGUSR1` to it as
/// fast as it can while a query runs. The child is in that group until
/// its own `setpgid`, it starts with every signal blocked, and a signal
/// that arrives in that window is delivered the moment it puts the
/// caller's mask back — after the reset loop and before the `execve`.
///
/// The program named does not exist, so the only way the child can end
/// *on* the signal is by taking it before the `execve`; anything else
/// exits with the "would not run" status. That makes the test say when it
/// missed the window instead of passing because nothing happened. With
/// the reset loop deleted the inherited handler runs in the child
/// instead, writes the child's own number into the record below, and the
/// child goes on to the `execve` it cannot do — so both halves fail.
///
/// The storm carries a second signal, one the caller *ignores*. That is
/// the caller's own instruction and it has to reach the utility, so the
/// last query here runs a utility that reads its own `/proc` entry,
/// refuses unless that number is ignored and unblocked, and only then
/// raises it at itself and answers. Surviving the signal is not proof on
/// its own — a blocked signal with the default disposition survives too,
/// and a mutant that reset the readable ignore and then blocked the
/// number passed the survival form twenty times out of twenty. What this
/// cannot reach is an ignored disposition whose *read* is denied,
/// because denying one read needs a kernel filter, which lives in this
/// lane's harness rather than here.
#[cfg(target_os = "linux")]
#[test]
fn an_inherited_handler_does_not_run_in_the_child_before_exec() {
	use std::os::fd::AsRawFd as _;
	use std::os::unix::fs::PermissionsExt as _;
	use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

	/// This test's own number, and the descriptor the handler writes to.
	static OWNER: AtomicI32 = AtomicI32::new(0);
	static RECORD: AtomicI32 = AtomicI32::new(-1);

	extern "C" fn note_whoever_runs_this(_signal: libc::c_int) {
		// SAFETY: `getpid` and `write` are async-signal-safe, and the file
		// the descriptor names outlives every delivery below. A process
		// that is not this test is a child running an inherited handler.
		unsafe {
			let me = libc::getpid();
			if me != OWNER.load(Ordering::Relaxed) {
				let number = me.to_ne_bytes();
				libc::write(RECORD.load(Ordering::Relaxed), number.as_ptr().cast(), number.len());
			}
		}
	}

	let dir = tempfile::tempdir().unwrap();
	let record = dir.path().join("ran");
	let file = fs::File::create(&record).unwrap();
	// SAFETY: reading this process's own number.
	OWNER.store(unsafe { libc::getpid() }, Ordering::Relaxed);
	RECORD.store(file.as_raw_fd(), Ordering::Relaxed);
	// SAFETY: nextest gives this test its own process; the disposition and
	// the process group are both put back below. `SA_RESTART` keeps the
	// storm from turning this process's own calls into `EINTR`.
	let (kept, ignored, grouped) = unsafe {
		let mut catching: libc::sigaction = std::mem::zeroed();
		catching.sa_sigaction = note_whoever_runs_this as libc::sighandler_t;
		catching.sa_flags = libc::SA_RESTART;
		libc::sigemptyset(&raw mut catching.sa_mask);
		let mut kept: libc::sigaction = std::mem::zeroed();
		assert_eq!(libc::sigaction(libc::SIGUSR1, &raw const catching, &raw mut kept), 0);
		// And one the caller *ignores*, which is its own instruction and
		// has to reach the utility: a child that put it back to default
		// would die on the storm's own delivery of it.
		let ignored = libc::signal(libc::SIGUSR2, libc::SIG_IGN);
		assert_ne!(ignored, libc::SIG_ERR);
		let was = libc::getpgrp();
		// Its own group, so the storm reaches this test and its children
		// and nothing else the runner has going.
		assert_eq!(libc::setpgid(0, 0), 0, "a group of this test's own: {}", std::io::Error::last_os_error());
		(kept, ignored, was)
	};
	let storming = std::sync::Arc::new(AtomicBool::new(true));
	let until = std::sync::Arc::clone(&storming);
	let storm = std::thread::spawn(move || {
		while until.load(Ordering::Relaxed) {
			// SAFETY: the group is this test's own, made above.
			unsafe {
				libc::kill(0, libc::SIGUSR2);
				libc::kill(0, libc::SIGUSR1);
			}
			// A gap, because a storm with none starves this process: every
			// delivery interrupts the query's own waiting, and the whole
			// test made no progress in 90 seconds. A fifth of a
			// millisecond still puts a signal inside a window the child
			// takes tens of microseconds to cross, and the round below
			// that sees it is the first.
			std::thread::sleep(std::time::Duration::from_micros(200));
		}
	});
	let program = dir.path().join("locale-no-such-program");
	let mut taken = None;
	let mut last = String::new();
	let mut died_ignoring = None;
	for _ in 0..64 {
		let answer = crate::locale::codeset_from_utility_for_test(&program, "C.UTF-8", &|_| None);
		let crate::locale::Codeset::Unasked(why) = &answer else {
			panic!("a program that is not there answered: {answer:?}");
		};
		last = why.clone();
		if why.contains(&format!("ended on signal {}", libc::SIGUSR2)) {
			died_ignoring = Some(why.clone());
			break;
		}
		if why.contains(&format!("ended on signal {}", libc::SIGUSR1)) {
			taken = Some(why.clone());
			break;
		}
	}
	storming.store(false, Ordering::Relaxed);
	storm.join().unwrap();
	// With the storm stopped, one query says outright whether the ignored
	// disposition reached a child. Surviving the signal is not enough to
	// say it: a *blocked* signal with the default disposition survives
	// too, and a mutant that reset the readable ignore and then blocked
	// the number passed that form twenty times out of twenty. So the
	// utility reads its own `/proc` entry first and refuses unless the
	// number is in `SigIgn` and out of `SigBlk`, and only then raises it
	// at itself and answers. What this cannot reach is still said where
	// it is said above; restoring the *wrong* number, and skipping the
	// mask read-back, are covered by this lane's harness probes rather
	// than from here.
	let bit = 1u64 << (libc::SIGUSR2 - 1);
	let raises = dir.path().join("locale-raises-the-ignored-signal");
	let script = format!(
		"#!/bin/sh\n\
		 ignored=$(awk '/^SigIgn:/ {{ print $2 }}' /proc/$$/status)\n\
		 blocked=$(awk '/^SigBlk:/ {{ print $2 }}' /proc/$$/status)\n\
		 [ $(( 0x$ignored & {bit} )) -ne 0 ] || exit 71\n\
		 [ $(( 0x$blocked & {bit} )) -eq 0 ] || exit 72\n\
		 kill -{signal} $$\n\
		 printf 'UTF-8\\n'\n",
		signal = libc::SIGUSR2
	);
	fs::write(&raises, script).unwrap();
	fs::set_permissions(&raises, fs::Permissions::from_mode(0o755)).unwrap();
	let ignoring = crate::locale::codeset_from_utility_for_test(&raises, "C.UTF-8", &|_| None);
	// SAFETY: putting back what this test changed, before it can fail.
	unsafe {
		libc::sigaction(libc::SIGUSR1, &raw const kept, std::ptr::null_mut());
		libc::signal(libc::SIGUSR2, ignored);
		libc::setpgid(0, grouped);
	}
	let ran: Vec<i32> = fs::read(&record)
		.unwrap()
		.chunks_exact(4)
		.map(|number| i32::from_ne_bytes(number.try_into().unwrap()))
		.collect();
	assert!(ran.is_empty(), "the handler ran in the child before its `execve`: {ran:?}");
	assert!(taken.is_some(), "no query took the signal before its `execve`, so nothing was proved: {last}");
	assert!(
		died_ignoring.is_none(),
		"a disposition the caller ignores was not left ignored: {died_ignoring:?}"
	);
	assert!(
		matches!(&ignoring, crate::locale::Codeset::Loaded(found) if found == "UTF-8"),
		"the signal the caller ignores reached the utility ignored and unblocked, and it survived \
		 raising it — status 71 is a disposition that is no longer ignored, 72 is a blocked one: \
		 {ignoring:?}"
	);
}

/// A name is the name of locale data, whatever punctuation it carries.
///
/// `newlocale` splits a name containing `;` per category and `setlocale`
/// takes it whole, so the one answer that is right is the reference's: data
/// literally so named loads (measured: `ISO-8859-1`, and rsync 3.5.1 prints
/// `ünï.txt`), and with no such data the C locale follows. This asserts
/// against `locale charmap` under the same environment, through both of
/// this code's paths — the shell's search path differing from this
/// process's, which spawns, and neither set, which does not.
#[cfg(target_os = "linux")]
#[test]
fn a_name_is_the_name_of_the_data_whatever_punctuation_it_carries() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let literal = ["astra=latin", "astra;latin", "LC_CTYPE=astra;LC_TIME=C"];
	for name in literal {
		let mut copy = Command::new("cp");
		copy.arg("-a").arg(locales.join(SHELL_ONLY_LOCALE)).arg(locales.join(name));
		assert!(copy.output().unwrap().status.success(), "{name}");
	}
	let absent = format!("LC_CTYPE={SHELL_ONLY_LOCALE};LC_TIME=C");
	let shell_path = locales.to_str().unwrap().to_owned();
	for name in literal.iter().copied().chain([absent.as_str()]) {
		let reference = Command::new("/usr/bin/locale")
			.arg("charmap")
			.env_clear()
			.env("LC_CTYPE", name)
			.env("LOCPATH", &locales)
			.output()
			.unwrap();
		let reference = String::from_utf8_lossy(&reference.stdout).trim().to_owned();
		// Spawning: the shell's search path is not this process's.
		let env = |key: &str| (key == "LOCPATH").then(|| shell_path.clone());
		let spawned = crate::locale::loaded_codeset(name, &env, None);
		assert!(
			matches!(&spawned, crate::locale::Codeset::Loaded(codeset) if *codeset == reference),
			"{name} spawned: {spawned:?} vs {reference}"
		);
		// In process: neither search path is set, so the same name has to
		// read the same way through `newlocale` or not be answered there.
		// SAFETY: nextest gives this test its own process, and nothing else
		// in it reads `LOCPATH` concurrently.
		unsafe { std::env::set_var("LOCPATH", &locales) };
		let here = crate::locale::loaded_codeset(name, &env, None);
		// SAFETY: as above.
		unsafe { std::env::remove_var("LOCPATH") };
		assert!(
			matches!(&here, crate::locale::Codeset::Loaded(codeset) if *codeset == reference),
			"{name} in process: {here:?} vs {reference}"
		);
	}
}

/// A long list of relative entries is passed to the child as the shell wrote
/// it, so nothing it is joined with can push it past what `execve` takes.
#[cfg(target_os = "linux")]
#[test]
fn two_thousand_relative_entries_still_resolve() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let cwd = dir.path().join("a-working-directory-with-a-name-of-its-own");
	fs::create_dir_all(&cwd).unwrap();
	std::os::unix::fs::symlink(locales.join(SHELL_ONLY_LOCALE), cwd.join(SHELL_ONLY_LOCALE)).unwrap();
	let (host, _) = crate::host::Host::for_test("rsync", "", &cwd);
	let child = host.child_env();
	let path = vec!["."; 2048].join(":");
	let env = |key: &str| (key == "LOCPATH").then(|| path.clone());
	let answer = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, Some(&child));
	assert!(matches!(&answer, crate::locale::Codeset::Loaded(codeset) if codeset == "ISO-8859-1"), "{answer:?}");
}

/// The shell's conversion configuration decides whether a name's codeset is
/// an alias of the locale's own, and so whether libc loads it at all
/// (`findlocale.c`, `__gconv_compare_alias`). This asserts against the
/// reference under the same environment, so it holds whatever that glibc
/// makes of the alias.
#[cfg(target_os = "linux")]
#[test]
fn the_shells_conversion_configuration_reaches_the_lookup() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let gconv = dir.path().join("gconv");
	fs::create_dir_all(&gconv).unwrap();
	fs::write(gconv.join("gconv-modules"), "alias OMP_RSYNC_ALIAS// ISO-8859-1//\n").unwrap();
	let aliased = format!("{SHELL_ONLY_LOCALE}.OMP_RSYNC_ALIAS");
	std::os::unix::fs::symlink(locales.join(SHELL_ONLY_LOCALE), locales.join(&aliased)).unwrap();
	let reference = Command::new("/usr/bin/locale")
		.arg("charmap")
		.env_clear()
		.env("LC_CTYPE", &aliased)
		.env("LOCPATH", &locales)
		.env("GCONV_PATH", &gconv)
		.output();
	let Ok(reference) = reference else { return };
	let reference = String::from_utf8_lossy(&reference.stdout).trim().to_owned();
	let locales = locales.to_str().unwrap().to_owned();
	let gconv = gconv.to_str().unwrap().to_owned();
	let env = |key: &str| match key {
		"LOCPATH" => Some(locales.clone()),
		"GCONV_PATH" => Some(gconv.clone()),
		_ => None,
	};
	let answer = crate::locale::loaded_codeset(&aliased, &env, None);
	assert!(matches!(&answer, crate::locale::Codeset::Loaded(codeset) if *codeset == reference), "{answer:?} vs {reference}");
}

/// A German and an English locale, both UTF-8 and complete, under
/// `<dir>/utility-locales`, built with `localedef`. `None` on a host without
/// locale sources. Nothing here depends on what the host has installed.
#[cfg(target_os = "linux")]
fn utility_locales(dir: &Path) -> Option<PathBuf> {
	let locales = dir.join("utility-locales");
	for (name, source) in [("de_XX.UTF-8", "de_DE"), ("en_XX.UTF-8", "en_US")] {
		fs::create_dir_all(locales.join(name)).unwrap();
		let built = Command::new("localedef").args(["-i", source, "-f", "UTF-8"]).arg(locales.join(name)).output();
		if !built.is_ok_and(|built| built.status.success()) {
			return None;
		}
	}
	fs::write(dir.join("f1536"), vec![b'x'; 1536]).unwrap();
	fs::File::create(dir.join("f1234567")).unwrap().set_len(1_234_567).unwrap();
	Some(locales)
}

/// Clears whatever locale the test process passed to the shell, so each
/// script names its own.
#[cfg(target_os = "linux")]
const CLEAN_LOCALE: &str = "unset LC_ALL LANG LC_CTYPE LC_NUMERIC LC_TIME LC_COLLATE LC_MONETARY LC_MESSAGES \
                            LC_PAPER LC_NAME LC_ADDRESS LC_TELEPHONE LC_MEASUREMENT LC_IDENTIFICATION LOCPATH";

/// The last line of `df -B "'1" --output=size .`, a size well past a
/// thousand bytes: whether its digits are grouped, and by what.
#[cfg(target_os = "linux")]
fn df_grouping(line: &str) -> Option<char> {
	let size = line.trim();
	assert!(size.chars().next().is_some_and(|c| c.is_ascii_digit()), "{line:?}");
	size.chars().find(|c| !c.is_ascii_digit())
}

/// `df`, `du`, `env`, `fold` and `sort` find a locale only the shell
/// exports, through its `LOCPATH`, as the GNU utilities they stand in for
/// do as the shell's children. The builtin runs in this process, whose
/// environment has no `LOCPATH`, so asking libc here found nothing and every
/// one of them fell back to the C locale.
///
/// Measured against GNU coreutils 9.4 under the same exported environment:
/// `sort -sn` puts `1,10` before `1,9`, `du -h` prints `1,5K` and
/// `df -B "'1"` groups with dots. GNU `fold` and `env` 9.4 have neither
/// multibyte folding nor `QUOTING_STYLE`, so for those two the reference is
/// libc's: `locale charmap` reports UTF-8 for that locale under that
/// `LOCPATH`.
#[cfg(all(
	target_os = "linux",
	feature = "util.df",
	feature = "util.du",
	feature = "util.env",
	feature = "util.fold",
	feature = "util.sort"
))]
#[tokio::test]
async fn the_utilities_honour_a_locale_only_the_shell_exports() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = utility_locales(dir.path()) else { return };
	assert!(std::env::var_os("LOCPATH").is_none(), "the premise: this process has no LOCPATH");
	let script = format!(
		"{CLEAN_LOCALE}\nexport LOCPATH='{}'\n( export LC_ALL=de_XX.UTF-8\n  printf '1,9\\n1,10\\n' | sort -sn\n  du -h \
		 --apparent-size f1536\n  df -B \"'1\" --output=size . | tail -n 1 )\n( export LC_ALL=en_XX.UTF-8 \
		 QUOTING_STYLE=shell-escape X=é\n  printf 'é\\n' | fold -w1 | od -An -tx1\n  env | grep '^X=' )\n",
		locales.display()
	);
	let (code, out, err) = crate::host::run_script(&script, "", dir.path()).await;
	assert_eq!(code, 0, "{err}");
	let lines: Vec<&str> = out.lines().collect();
	assert_eq!(lines.len(), 6, "{out}");
	assert_eq!(&lines[..3], ["1,10", "1,9", "1,5K\tf1536"], "sort -sn and du -h take the German numerics");
	assert_eq!(df_grouping(lines[3]), Some('.'), "df groups digits the German way: {out}");
	assert_eq!(lines[4].trim(), "c3 a9 0a", "fold keeps the bytes of a UTF-8 character together");
	assert_eq!(lines[5], "X=é", "env prints a UTF-8 value as it is");
}

/// A locale environment in which one category names a locale that is not
/// installed leaves `df`, `du`, `env`, `fold` and `sort` in the C locale:
/// GNU utilities start with `setlocale(LC_ALL, "")`, which fails as a whole
/// then, and the other categories are not applied.
///
/// This process and the shell share `LOCPATH`, so the English locale loads
/// here too and only the missing `LC_TIME` decides. Measured against GNU
/// coreutils 9.4 under the same exported environment: `sort -sn` keeps
/// `1,000` before `2`, `sort` orders `A B a b`, `sort --debug` reports
/// `failed to set locale`, and `du` and `df` group no digits. For `fold`
/// and `env` the reference is libc's: the shell's own `setlocale` warns
/// that it cannot change `LC_TIME`.
#[cfg(all(
	target_os = "linux",
	feature = "util.df",
	feature = "util.du",
	feature = "util.env",
	feature = "util.fold",
	feature = "util.sort"
))]
#[tokio::test]
async fn a_missing_category_leaves_the_utilities_in_c() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = utility_locales(dir.path()) else { return };
	// SAFETY: nextest gives this test its own process, and nothing else in
	// it reads `LOCPATH` concurrently.
	unsafe { std::env::set_var("LOCPATH", &locales) };
	let script = format!(
		"{CLEAN_LOCALE}\nexport LOCPATH='{}' LANG=en_XX.UTF-8 LC_TIME=zz_ZZ.UTF-8\nprintf '1,000\\n2\\n' | sort \
		 -sn\nprintf 'b\\nA\\na\\nB\\n' | sort\nprintf 'a\\n' | sort --debug 2>&1 | head -n 1\ndu --block-size=\"'1\" \
		 --apparent-size f1234567\ndf -B \"'1\" --output=size . | tail -n 1\nprintf 'é\\n' | fold -w1 | od -An \
		 -tx1\n( export QUOTING_STYLE=shell-escape X=é; env | grep '^X=' )\n",
		locales.display()
	);
	let (code, out, err) = crate::host::run_script(&script, "", dir.path()).await;
	// SAFETY: as above.
	unsafe { std::env::remove_var("LOCPATH") };
	assert_eq!(code, 0, "{err}");
	let lines: Vec<&str> = out.lines().collect();
	assert_eq!(lines.len(), 11, "{out}");
	assert_eq!(&lines[..2], ["1,000", "2"], "sort -sn takes C's numerics");
	assert_eq!(&lines[2..6], ["A", "B", "a", "b"], "sort compares bytes");
	assert_eq!(lines[6], "sort: failed to set locale", "sort --debug says why");
	assert_eq!(lines[7], "1234567\tf1234567", "du groups no digits");
	assert_eq!(df_grouping(lines[8]), None, "df groups no digits: {out}");
	assert_eq!(lines[9].trim(), "c3 0a a9 0a", "fold splits the bytes of a character");
	assert_eq!(lines[10], "X=''$'\\303\\251'", "env escapes a byte C cannot print");
}
