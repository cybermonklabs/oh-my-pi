//! End-to-end runs of the builtin: local copies (both halves in-process),
//! transfers against the reference `rsync --server` through a fake remote
//! shell, batch round trips, and the option outcomes.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::*;
use crate::host::run_util;
use crate::rsync::Rsync;

fn run(argv: &[&str], cwd: &Path) -> (i32, String, String) {
	let (code, cap) = run_util::<Rsync>(argv, "", cwd);
	(code, cap.out(), cap.err())
}

/// The reference rsync 3.x binary, when one is installed. Without one, the
/// calling test skips: it prints `skipped: <reason>`, as every test that
/// cannot run here does, and returns.
fn reference() -> Option<PathBuf> {
	let mut candidates = vec![PathBuf::from("/opt/homebrew/bin/rsync")];
	if let Some(path) = std::env::var_os("PATH") {
		candidates.extend(std::env::split_paths(&path).map(|d| d.join("rsync")));
	}
	let found = candidates.into_iter().find(|p| {
		Command::new(p)
			.arg("--version")
			.output()
			.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).starts_with("rsync  version 3."))
	});
	if found.is_none() {
		eprintln!("skipped: no rsync 3.x on PATH");
	}
	found
}

/// A small tree: a file, a nested file, and (unix) a symlink.
fn make_tree(root: &Path) {
	fs::create_dir_all(root.join("sub")).unwrap();
	fs::write(root.join("a"), b"hello\n").unwrap();
	fs::write(root.join("sub/b"), b"x\n").unwrap();
	fs::write(root.join("big"), (0..200_000u32).flat_map(|i| i.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
	#[cfg(unix)]
	std::os::unix::fs::symlink("a", root.join("link")).unwrap();
}

/// Asserts `b` mirrors `a` (contents, symlink targets, and mtimes of files).
fn assert_same_tree(a: &Path, b: &Path) {
	let mut names: Vec<_> = fs::read_dir(a).unwrap().map(|e| e.unwrap().file_name()).collect();
	names.sort();
	let mut other: Vec<_> = fs::read_dir(b).unwrap().map(|e| e.unwrap().file_name()).collect();
	other.sort();
	assert_eq!(names, other, "entries of {}", b.display());
	for name in names {
		let (pa, pb) = (a.join(&name), b.join(&name));
		let ma = fs::symlink_metadata(&pa).unwrap();
		let mb = fs::symlink_metadata(&pb).unwrap();
		assert_eq!(ma.file_type().is_dir(), mb.file_type().is_dir(), "{}", pb.display());
		if ma.file_type().is_symlink() {
			assert_eq!(fs::read_link(&pa).unwrap(), fs::read_link(&pb).unwrap());
		} else if ma.is_dir() {
			assert_same_tree(&pa, &pb);
		} else {
			assert_eq!(fs::read(&pa).unwrap(), fs::read(&pb).unwrap(), "{}", pb.display());
		}
	}
}

fn mtime(p: &Path) -> std::time::SystemTime {
	fs::metadata(p).unwrap().modified().unwrap()
}

/// The physical path of `dir`, resolved like `realpath`: `fs::canonicalize`
/// spells Windows paths `\\?\…`, where `/` is not a separator.
fn physical(dir: &Path) -> PathBuf {
	pi_vfs::BlockingFs::native().canonicalize_with(dir, &pi_vfs::CanonicalizeOptions::default()).unwrap()
}

#[test]
fn version_and_help_go_to_stdout() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) = run(&["--version"], dir.path());
	assert_eq!(code, 0);
	assert!(out.starts_with("rsync  version 3.5.1  protocol version 33\n"), "{out}");
	assert_eq!(err, "");
	let (code, out, _) = run(&["--help"], dir.path());
	assert_eq!(code, 0);
	assert!(out.contains("Usage: rsync [OPTION]... SRC [SRC]... DEST"), "{out}");
}

/// Captured from rsync 3.5.1: no arguments prints the usage to stderr.
#[test]
fn no_arguments_is_a_usage_error() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) = run(&[], dir.path());
	assert_eq!(code, 1);
	assert_eq!(out, "");
	assert!(err.ends_with("rsync error: syntax or usage error (code 1) at main.c(1898) [client=3.5.1]\n"), "{err}");
}

#[test]
fn daemon_mode_is_refused() {
	let dir = tempfile::tempdir().unwrap();
	let (code, _, err) = run(&["--daemon"], dir.path());
	assert_eq!(code, 4);
	assert!(err.starts_with("rsync: --daemon is not supported by this rsync\n"), "{err}");
	assert!(err.contains("(code 4) at main.c(1954)"), "{err}");
}

/// Captured from rsync 3.5.1: `rsync --protocol=19 -a src/ d/` on a local copy.
#[test]
fn too_old_protocol_is_a_mismatch() {
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (code, _, err) = run(&["--protocol=19", "-a", "src/", "d/"], dir.path());
	assert_eq!(code, 2);
	// The server half fails the same check and is stopped by its client
	// (upstream: SIGUSR1 to the local child).
	assert_eq!(
		err,
		"protocol version mismatch -- is your shell clean?\n(see the rsync manpage for an explanation)\n\
		 rsync error: protocol incompatibility (code 2) at compat.c(625) [sender=3.5.1]\n\
		 rsync error: received SIGUSR1 (code 19) at main.c(1687) [Receiver=3.5.1]\n"
	);
}

/// The client of a local copy stops its server half while the half is in the
/// protocol exchange: the half has sent its version and not yet read the
/// client's. Upstream's child exits on that SIGUSR1 wherever it is, so the
/// half's one line is `received SIGUSR1`, never the read the stop cancelled.
/// `too_old_protocol_is_a_mismatch` takes this path when its half is slow.
#[test]
fn a_local_half_stopped_in_its_handshake_exits_as_signalled() {
	let dir = tempfile::tempdir().unwrap();
	let (mut host, cap) = crate::host::Host::for_test("rsync", Vec::new(), dir.path());
	let io = HostIo::new(&mut host, Arc::new(HashMap::new()), OsString::from("rsync"));
	let getenv = |_: &str| None;
	let argv = ["--protocol=19", "-a", "src/", "d/"].map(OsString::from);
	let Ok(Parsed::Run(opts)) = options::parse(&argv, &getenv) else { panic!("the operands parse") };
	let mut sopts = options::local_server_options(&opts, &getenv).unwrap();
	sopts.args = vec![OsString::from("."), OsString::from("d/")];
	sopts.old_style_args = 2;
	let kill = Arc::new(AtomicBool::new(false));
	let (mut client, server) = transport::local_pair(Arc::clone(&kill));
	let mut sio = io.clone();
	sio.cancel = Arc::clone(&kill);
	let local = LocalServer {
		conn: server,
		client_info: handshake::local_client_info(&opts, false),
		filters: Filters::new(FilterConfig::default()),
	};
	let half = thread::spawn(move || server_main(&sio, sopts, Some(local)));
	// The half's version arrives; the client's never does.
	let mut version = [0u8; 4];
	client.reader.read_exact(&mut version).unwrap();
	kill.store(true, Ordering::Relaxed);
	let code = half.join().unwrap();
	assert_eq!(
		(code, cap.err().as_str()),
		(RERR_SIGNAL1, "rsync error: received SIGUSR1 (code 19) at main.c(1687) [Receiver=3.5.1]\n")
	);
}

/// Captured from rsync 3.5.1: when the server half of a local copy fails while
/// setting up, the client exits with its code and prints nothing of its own.
#[test]
fn local_server_setup_failure_is_reported_once() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = physical(tmp.path());
	fs::create_dir_all(dir.join("src")).unwrap();
	fs::write(dir.join("src/a"), b"a\n").unwrap();
	// A file list far larger than the in-process pipe, so the client is still
	// writing it when the server half gives up.
	for i in 0..600 {
		let name = format!("{i:04}-a-rather-long-file-name-to-make-the-file-list-big.txt");
		fs::write(dir.join("src").join(name), b"x").unwrap();
	}
	let (code, _, err) = run(&["-ai", "src/", "dst/new/deeper/"], &dir);
	assert_eq!(code, 11, "{err}");
	assert_eq!(
		err,
		format!(
			"rsync: [Receiver] mkdir \"{}/dst/new/deeper\" failed: No such file or directory (2)\n\
			 rsync error: error in file IO (code 11) at main.c(821) [Receiver=3.5.1]\n",
			String::from_utf8_lossy(&crate::rsync::paths::path_bytes(&dir))
		)
	);
	let (code, _, err) = run(&["-ai", "--temp-dir=../nope", "src/", "dst2/"], &dir);
	assert_eq!(code, 1, "{err}");
	assert_eq!(
		err,
		"The temp-dir does not exist: ../nope\n\
		 rsync error: syntax or usage error (code 1) at main.c(1069) [Receiver=3.5.1]\n"
	);
}

/// Captured from rsync 3.5.1: `rsync --protocol=40 -a src/ d/`.
#[test]
fn too_new_protocol_option_on_a_local_copy() {
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (code, _, err) = run(&["--protocol=40", "-a", "src/", "d/"], dir.path());
	assert_eq!(code, 2);
	assert_eq!(
		err,
		"--protocol must be no more than 33 on the Client.\n\
		 rsync error: protocol incompatibility (code 2) at compat.c(639) [sender=3.5.1]\n\
		 rsync error: received SIGUSR1 (code 19) at main.c(1687) [Receiver=3.5.1]\n"
	);
}

/// Captured from rsync 3.5.1 (a build without preallocation): `rsync --preallocate f h`.
#[test]
fn preallocate_is_refused_by_the_receiving_half() {
	let dir = tempfile::tempdir().unwrap();
	fs::write(dir.path().join("f"), b"x\n").unwrap();
	let (code, _, err) = run(&["--preallocate", "f", "h"], dir.path());
	if crate::rsync::usage::SUPPORT_PREALLOCATION {
		assert_eq!(code, 0, "{err}");
		return;
	}
	assert_eq!(code, 12, "{err}");
	assert_eq!(
		err,
		"preallocation is not supported on this Server\n\
		 rsync error: syntax or usage error (code 1) at compat.c(660) [Receiver=3.5.1]\n\
		 rsync: connection unexpectedly closed (0 bytes received so far) [sender]\n\
		 rsync error: error in rsync protocol data stream (code 12) at io.c(303) [sender=3.5.1]\n"
	);
}

/// Protocol 33 MSG_BLOCK_STATS: the receiving half's 4 KiB block count reaches
/// the sending client's --stats (rsync 3.5.1 prints 1 for this delta).
#[test]
fn touched_blocks_reach_the_sending_client() {
	let dir = tempfile::tempdir().unwrap();
	let data: Vec<u8> = (0..65536u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
	fs::write(dir.path().join("src"), &data).unwrap();
	fs::write(dir.path().join("dst"), &data).unwrap();
	let mut changed = data;
	changed[..3].copy_from_slice(b"xyz");
	fs::write(dir.path().join("src"), &changed).unwrap();
	let (code, out, err) = run(&["-a", "--stats", "--inplace", "-I", "--no-whole-file", "src", "dst"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	assert!(out.contains("Number of 4 KiB logical blocks touched: 1\n"), "{out}");
	assert_eq!(fs::read(dir.path().join("dst")).unwrap(), changed);
}

/// `--confine-root` bounds option paths and --files-from entries, not the
/// transfer roots or the list file (rsync 3.5.1 exits 0 for both).
#[test]
fn confine_root_leaves_roots_and_list_file_alone() {
	let tmp = tempfile::tempdir().unwrap();
	// Physical paths: the confine check (like the reference's) refuses a path
	// that only reaches the root through an alias such as macOS's /var symlink.
	let dir = physical(tmp.path());
	let root = dir.join("X/root");
	fs::create_dir_all(&root).unwrap();
	fs::write(root.join("keep"), b"k\n").unwrap();
	fs::write(dir.join("list"), b"keep\n").unwrap();
	let confine = format!("--confine-root={}", root.display());
	let keep = root.join("keep");
	let (code, _, err) = run(&["-r", &confine, keep.to_str().unwrap(), "d/"], &dir);
	assert_eq!((code, err.as_str()), (0, ""));
	assert_eq!(fs::read(dir.join("d/keep")).unwrap(), b"k\n");
	let list = format!("--files-from={}", dir.join("list").display());
	let src = format!("{}/", root.display());
	let (code, _, err) = run(&["-r", &confine, &list, &src, "d2/"], &dir);
	assert_eq!((code, err.as_str()), (0, ""));
	assert_eq!(fs::read(dir.join("d2/keep")).unwrap(), b"k\n");
}

/// `host://path` is a host spec unless the shell's filesystem routes the scheme.
#[test]
fn url_spelled_operand_without_a_provider_is_remote() {
	let fs = crate::host::ShellPaths::default().fs().clone();
	assert!(!routes_locally(&fs, OsStr::new("localhost:///tmp/x")));
	assert!(!routes_locally(&fs, OsStr::new("/tmp/x")));
}

#[cfg(unix)]
#[test]
fn url_spelled_remote_operand_reaches_the_shell() {
	let Some(rsync) = reference() else { return };
	let dir = tempfile::tempdir().unwrap();
	fs::create_dir_all(dir.path().join("Y/src")).unwrap();
	fs::write(dir.path().join("Y/src/file"), b"hi\n").unwrap();
	let rsh = fake_rsh(dir.path());
	let rpath = format!("--rsync-path={}", rsync.display());
	let source = format!("h:/{}/Y/src/file", dir.path().display());
	assert!(source.starts_with("h://"));
	let (code, _, err) = run(&["-a", "-e", rsh.to_str().unwrap(), &rpath, &source, "d1/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_eq!(fs::read(dir.path().join("d1/file")).unwrap(), b"hi\n");
}

/// Parses "sent X bytes  received Y bytes" (commas allowed) from a line.
fn sent_received(line: &str) -> (i64, i64) {
	let num = |word: &str| word.replace(',', "").parse::<i64>().unwrap();
	let words: Vec<&str> = line.split_whitespace().collect();
	let at = |key: &str| words.iter().position(|w| *w == key).map(|i| num(words[i + 1])).unwrap();
	(at("sent"), at("received"))
}

/// The bytes of the log-file exit line (`sent N bytes  received M bytes  total size T`).
fn log_exit_line(log: &str) -> (i64, i64) {
	let line = log.lines().find(|l| l.contains("] sent ") && l.contains(" total size ")).unwrap();
	sent_received(line)
}

/// The --log-file exit line reports the connection's live byte counters (log_exit),
/// which include what was exchanged after the --stats snapshot (handle_stats).
/// Every comparison is within one run, because byte totals can vary between runs.
#[test]
fn log_file_exit_line_uses_live_counters() {
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	fs::create_dir_all(&src).unwrap();
	fs::write(src.join("a"), (0..300_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 11) as u8).collect::<Vec<u8>>()).unwrap();
	fs::write(src.join("b"), b"hi\n").unwrap();

	// Local push. A clean client run with --stats writes no exit line, but one
	// ending with code 23 writes both (the summary, then log_exit on the error
	// exit), so a missing extra source puts the two in one run. Measured with
	// rsync 3.5.1 (`-a --stats --log-file=r.log src/ nope dst/`, six runs, all
	// identical): --stats sent 300,244 / received 57, log line sent 300249 /
	// received 74. That is +5 sent (the sender's goodbye NDX_DONE frame) and +17
	// received (the receiver's MSG_BLOCK_STATS frame, 12, and goodbye frame, 5).
	let (code, out, _) = run(&["-a", "--stats", "--log-file=r.log", "src/", "nope", "d1/"], dir.path());
	assert_eq!(code, 23, "{out}");
	let summary = sent_received(out.lines().find(|l| l.starts_with("sent ")).unwrap());
	let log = fs::read_to_string(dir.path().join("r.log")).unwrap();
	assert_eq!(log_exit_line(&log), (summary.0 + 5, summary.1 + 17), "{log}");

	// Pull from the reference server. A pulling client logs the exit line only
	// on a clean run without --stats, so its counterpart is the server's own
	// log line for the same connection: the client sent exactly what the
	// server received. The client received what the server sent, plus whatever
	// the server wrote after logging. Measured with rsync 3.5.1 on both ends
	// (five runs): client sent 70 = server received 70 every time; client
	// received 300264 or 300280 against server sent 300264.
	#[cfg(unix)]
	{
		let Some(rsync) = reference() else { return };
		// Runs the remote command through sh so --rsync-path can carry options.
		let rsh = dir.path().join("shrsh");
		crate::testprog::write(&rsh, "#!/bin/sh\nshift\nexec /bin/sh -c \"$*\"\n");
		let server_log = dir.path().join("s.log");
		let rpath = format!("--rsync-path={} --log-file={}", rsync.display(), server_log.display());
		let source = format!("h:{}/src/", dir.path().display());
		let (code, _, err) = run(&["-a", "--log-file=p.log", "-e", rsh.to_str().unwrap(), &rpath, &source, "p/"], dir.path());
		assert_eq!((code, err.as_str()), (0, ""));
		let client = log_exit_line(&fs::read_to_string(dir.path().join("p.log")).unwrap());
		let server = log_exit_line(&fs::read_to_string(&server_log).unwrap());
		assert_eq!(client.0, server.1, "client sent vs server received");
		assert!(matches!(client.1 - server.0, 0 | 16), "client received {} vs server sent {}", client.1, server.0);
	}
}

/// Local `--delete` copies terminate at protocol 29 (the server's input is not
/// multiplexed, so its reads never refill) and at 33 (inc-recursion: the receiver's
/// successes are messages that can hold back its forwarded lists): before the
/// receiver blocks on the socket it hands every queued item to the generator.
#[test]
fn local_delete_copies_terminate() {
	for args in [&["-aiH", "--delete", "--protocol=29"][..], &["-ai", "--delete", "--protocol=29"], &["-ai", "--delete"]] {
		let dir = tempfile::tempdir().unwrap();
		make_tree(&dir.path().join("src"));
		fs::create_dir_all(dir.path().join("dst/sub")).unwrap();
		fs::write(dir.path().join("dst/stale"), b"x").unwrap();
		fs::write(dir.path().join("dst/sub/stale2"), b"y").unwrap();
		let cwd = dir.path().to_path_buf();
		let mut argv: Vec<&'static str> = args.to_vec();
		argv.extend(["src/", "dst/"]);
		let (tx, rx) = std::sync::mpsc::channel();
		std::thread::spawn(move || {
			let _ = tx.send(run(&argv, &cwd));
		});
		let (code, _, err) = rx.recv_timeout(std::time::Duration::from_secs(60)).expect("local --delete copy hung");
		assert_eq!((code, err.as_str()), (0, ""), "{args:?}");
		assert!(!dir.path().join("dst/stale").exists() && !dir.path().join("dst/sub/stale2").exists());
	}
}

/// Byte totals are a function of the transfer, not of thread timing: copies of
/// one tree carry the same payload, and their `sent` and `received` totals
/// differ only by whole 4-byte multiplex headers, a few at most. Where a frame
/// ends is timing in rsync 3.5.1 itself: whether its generator's reply reaches
/// the sender before or after the sender's next read decides whether that
/// read's flush goes out as one frame or as several. With only the generator's
/// writes delayed (an `LD_PRELOAD` shim), rsync 3.5.1 copying this tree sent
/// 803,108 and received 467 bytes with no delay, and sent 803,116 and received
/// 471 with 2, 20 or 100 ms: two headers more one way, one the other, in 10 of
/// 10 copies each. The builtin's frame logs under CPU load show the same
/// split at the same read, and the test this replaced, which wanted equal
/// totals, failed 17 of 1,416 runs of the whole test binary, each failure a
/// whole number of headers: in those runs at most two headers on `sent` and
/// one on `received`, on one copy of five or on several. Each copy must also
/// be the source tree, because a difference of whole headers alone does not
/// say the payload is the same: a counter wrong by a whole multiple of four,
/// within the bound, passes this check, and only `assert_same_tree` sees the
/// copy itself. The bound is measured headroom, not a guarantee rsync makes.
/// The test runs in a process of its own, away from the other tests'
/// threads.
#[test]
fn local_copy_byte_totals_differ_only_by_frame_headers() {
	if !crate::own_process::own_process() {
		return;
	}
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	for i in 0..20 {
		fs::write(src.join(format!("sub/f{i}")), format!("file {i}\n").repeat(i + 1)).unwrap();
	}
	let mut totals = Vec::new();
	for run_no in 0..5 {
		let dest = format!("d{run_no}/");
		let (code, out, err) = run(&["-a", "--stats", "src/", &dest], dir.path());
		assert_eq!((code, err.as_str()), (0, ""), "{out}");
		assert_same_tree(&src, &dir.path().join(&dest));
		let summary = out.lines().find(|l| l.starts_with("sent ")).unwrap();
		totals.push(sent_received(summary));
	}
	if let Err(why) = header_differences(&totals) {
		panic!("{why}");
	}
}

/// The most multiplex headers by which one copy's total may exceed or fall
/// short of another's, each way. rsync 3.5.1 and the builtin were measured at
/// two sent and one received.
const MAX_HEADER_DIFFERENCE: i64 = 4;

/// Whether every copy's `(sent, received)` differs from the first copy's by
/// whole 4-byte multiplex headers, at most [`MAX_HEADER_DIFFERENCE`] each way:
/// only its framing moved. A difference of whole headers inside the bound is
/// not by itself a payload that agrees: a counter wrong by a whole multiple
/// of four passes this check, and only the tree comparison sees the copy
/// itself. The error names the first copy that does not.
fn header_differences(totals: &[(i64, i64)]) -> Result<(), String> {
	let Some((first, rest)) = totals.split_first() else {
		return Err("no copy".to_owned());
	};
	for (copy, total) in rest.iter().enumerate() {
		for (way, diff) in [("sent", total.0 - first.0), ("received", total.1 - first.1)] {
			if diff % 4 != 0 || diff.abs() > 4 * MAX_HEADER_DIFFERENCE {
				return Err(format!(
					"copy {} {way} {diff:+} bytes against copy 0, not a whole number of at most \
					 {MAX_HEADER_DIFFERENCE} frame headers: {totals:?}",
					copy + 1
				));
			}
		}
	}
	Ok(())
}

/// The check accepts the splits rsync 3.5.1 and the builtin show (two headers
/// more sent and one more received, or one header fewer sent), and refuses a
/// difference that is not whole headers or is more of them than the bound.
#[test]
fn header_difference_check_accepts_only_a_few_whole_headers() {
	assert_eq!(header_differences(&[(803_108, 467), (803_116, 471), (803_108, 467)]), Ok(()));
	assert_eq!(header_differences(&[(803_116, 471), (803_108, 467)]), Ok(()));
	assert_eq!(header_differences(&[(803_214, 467), (803_210, 467)]), Ok(()));
	assert!(header_differences(&[(803_108, 467), (803_109, 467)]).is_err(), "one payload byte");
	assert!(header_differences(&[(803_108, 467), (803_108, 470)]).is_err(), "three bytes");
	assert!(header_differences(&[(803_108, 467), (803_128, 467)]).is_err(), "five headers");
}

/// A server's stdio may be O_NONBLOCK: EAGAIN is retried, not fatal.
#[test]
fn shared_writer_retries_would_block() {
	struct Flaky {
		left: usize,
		out: Arc<Mutex<Vec<u8>>>,
	}
	impl Write for Flaky {
		fn write(&mut self, b: &[u8]) -> io::Result<usize> {
			if self.left > 0 {
				self.left -= 1;
				return Err(io::ErrorKind::WouldBlock.into());
			}
			lock(&self.out).extend_from_slice(b);
			Ok(b.len())
		}
		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}
	let out = Arc::new(Mutex::new(Vec::new()));
	let cancel = Arc::new(AtomicBool::new(false));
	let mut w = SharedWrite::new(Box::new(Flaky { left: 3, out: Arc::clone(&out) }), &cancel);
	w.write_all(b"data").unwrap();
	assert_eq!(&*lock(&out), b"data");
	let mut stuck = SharedWrite::new(Box::new(Flaky { left: usize::MAX, out }), &cancel);
	cancel.store(true, Ordering::Relaxed);
	let err = stuck.write_all(b"x").unwrap_err();
	assert_eq!(RsyncError::from_io(&err, 0).code, RERR_SIGNAL);
}

/// Cancelling while the client waits on its peer (a remote shell that never
/// answers, and whose `sleep 600` outlives the test runner's 4-minute bound)
/// ends the run with upstream's signal exit: code 20 and the `received
/// SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874)` trailer. Only the
/// cancel can end it: a run that did not notice it is failed by the runner.
#[cfg(unix)]
#[test]
fn cancel_mid_connection_exits_20_with_trailer() {
	use clap::Parser as _;

	use crate::rsync::transport::wait;
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let rsh = dir.path().join("stuckrsh");
	// The shell takes the client's protocol version, says so, and never answers.
	crate::testprog::write(&rsh, "#!/bin/sh\nhead -c 4 >/dev/null\n: > \"$0.ready\"\nexec sleep 600\n");
	let ready = dir.path().join("stuckrsh.ready");
	let (mut host, cap) = crate::host::Host::for_test_owning("rsync", Vec::new(), dir.path());
	let cancel = host.cancel_flag_for_test();
	let client = wait::Sleeper::current();
	let canceller = std::thread::spawn(move || {
		// Cancel once the client waits on its peer: the shell has the client's
		// version, and the client sleeps reading the reply.
		wait::until("the shell to receive the client's version", || ready.exists());
		client.wait_asleep("the client to block on the shell's reply", Duration::from_millis(300));
		cancel.store(true, Ordering::Relaxed);
	});
	let rsh_arg = rsh.to_str().unwrap().to_string();
	let parsed = Rsync::try_parse_from(["rsync", "--", "-a", "-e", &rsh_arg, "src/", "h:dst/"]).unwrap();
	let started = Instant::now();
	let code = crate::host::run_caught::<Rsync>(parsed, &mut host);
	canceller.join().unwrap();
	assert_eq!(code, RERR_SIGNAL);
	assert!(started.elapsed() < Duration::from_secs(10), "cancellation was not prompt");
	assert_eq!(cap.err(), "rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [sender=3.5.1]\n");
}

/// Cancelling a local copy mid-transfer: the client reports the signal, then
/// stops its server half, whose generator reports SIGUSR1. Captured from
/// rsync 3.5.1 (`rsync -a bigsrc/ dst/`, SIGTERM to the client), three runs:
/// exactly these two lines, exit 20.
///
/// The test cancels once the copy is under way (the receiver's file in `dst`
/// holds bytes), not at a fixed time, and asserts what the cancellation did:
/// exit 20, both lines, a copy that stopped short, and a run that ended
/// within 30 s of the cancel. `--bwlimit=100` makes the whole copy take about
/// 80 s, so a slow machine lengthens the run but cannot finish the copy
/// before the cancel. The 30 s is generous on purpose: the measured runs
/// ended about 3 s after the cancel, and a cancel noticed late but before
/// the copy's end fails it. The client's own bound is in the second
/// line: it waits at most 10 s for its server half to stop, and reports the
/// first line alone when it does not.
#[test]
fn cancel_local_copy_reports_like_upstream() {
	use clap::Parser as _;
	let dir = tempfile::tempdir().unwrap();
	fs::create_dir_all(dir.path().join("bigsrc")).unwrap();
	fs::write(dir.path().join("bigsrc/f"), vec![0u8; 8 << 20]).unwrap();
	let (mut host, cap) = crate::host::Host::for_test_owning("rsync", Vec::new(), dir.path());
	let cancel = host.cancel_flag_for_test();
	let ended = Arc::new(AtomicBool::new(false));
	let (dst, run_ended) = (dir.path().join("dst"), Arc::clone(&ended));
	let canceller = std::thread::spawn(move || {
		let deadline = Instant::now() + Duration::from_secs(120);
		let under_way = || {
			fs::read_dir(&dst)
				.into_iter()
				.flatten()
				.flatten()
				.any(|entry| entry.metadata().is_ok_and(|meta| meta.len() > 0))
		};
		while !under_way() && !run_ended.load(Ordering::Relaxed) && Instant::now() < deadline {
			std::thread::sleep(Duration::from_millis(10));
		}
		let cancelled_at = Instant::now();
		cancel.store(true, Ordering::Relaxed);
		cancelled_at
	});
	let parsed = Rsync::try_parse_from(["rsync", "--", "-a", "--bwlimit=100", "bigsrc/", "dst/"]).unwrap();
	let code = crate::host::run_caught::<Rsync>(parsed, &mut host);
	let run_ended_at = Instant::now();
	ended.store(true, Ordering::Relaxed);
	let cancelled_at = canceller.join().unwrap();
	assert_eq!(code, RERR_SIGNAL);
	assert_eq!(
		cap.err(),
		"rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [sender=3.5.1]\n\
		 rsync error: received SIGUSR1 (code 19) at main.c(1687) [generator=3.5.1]\n"
	);
	let copied = fs::metadata(dir.path().join("dst/f")).map_or(0, |meta| meta.len());
	assert!(copied < 8 << 20, "the copy ran to its end: the cancellation did not stop it");
	let after_cancel = run_ended_at.saturating_duration_since(cancelled_at);
	assert!(after_cancel < Duration::from_secs(30), "the run ended {after_cancel:?} after the cancel");
}

/// A cancelled run ends with upstream's signal exit (code 20).
#[test]
fn cancelled_run_exits_20() {
	use clap::Parser as _;
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (mut host, _cap) = crate::host::Host::for_test("rsync", Vec::new(), dir.path());
	host.cancel_for_test();
	let parsed = Rsync::try_parse_from(["rsync", "--", "-a", "src/", "dst/"]).unwrap();
	assert_eq!(crate::host::run_caught::<Rsync>(parsed, &mut host), RERR_SIGNAL);
}

#[test]
fn local_archive_copy_then_noop_rerun() {
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	let (code, out, err) = run(&["-ai", "src/", "dst/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	assert_same_tree(&src, &dir.path().join("dst"));
	assert_eq!(mtime(&src.join("big")), mtime(&dir.path().join("dst/big")));
	let mut expected = String::from("created directory dst\ncd+++++++++ ./\n>f+++++++++ a\n>f+++++++++ big\n");
	if cfg!(unix) {
		expected.push_str("cL+++++++++ link -> a\n");
	}
	expected.push_str("cd+++++++++ sub/\n>f+++++++++ sub/b\n");
	assert_eq!(out, expected);
	// Nothing changed: a second run itemizes nothing.
	let (code, out, err) = run(&["-ai", "src/", "dst/"], dir.path());
	assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));
}

/// The builtin itemizes a transfer as rsync 3.5.1 does, given the same
/// destination: both are the same older tree, an `a` of the source's size
/// and a root, whose mtimes the fixture sets to one time far from the
/// source's. Written at the moment they are, the two destinations would get
/// whatever mtimes the clock gave them: compared by the second (the default
/// `--modify-window`), a host slow enough that a second ended between the
/// two writes gave `ours/` the source's times and `theirs/` later ones, so
/// the tools were compared on different trees; and where no second ended,
/// neither tool had a time to itemize, nor `a` to send.
#[test]
fn itemize_output_matches_reference() {
	let Some(rsync) = reference() else { return };
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	let old = fs::FileTimes::new().set_modified(
		std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000),
	);
	for side in ["ours", "theirs"] {
		let root = dir.path().join(side);
		fs::create_dir_all(&root).unwrap();
		fs::write(root.join("a"), b"old!!\n").unwrap();
		fs::set_times_nofollow(root.join("a"), old).unwrap();
		fs::set_times_nofollow(&root, old).unwrap();
	}
	let theirs = Command::new(&rsync).args(["-ai", "src/", "theirs/"]).current_dir(dir.path()).output().unwrap();
	let (code, out, _) = run(&["-ai", "src/", "ours/"], dir.path());
	assert_eq!(code, 0);
	assert_eq!(out, String::from_utf8_lossy(&theirs.stdout));
	assert!(
		out.starts_with(".d..t...... ./\n>f..t...... a\n"),
		"the times the fixture set are itemized: {out}"
	);
	let theirs = Command::new(&rsync).args(["-ai", "src/", "theirs/"]).current_dir(dir.path()).output().unwrap();
	let (_, out, _) = run(&["-ai", "src/", "ours/"], dir.path());
	assert_eq!(out, String::from_utf8_lossy(&theirs.stdout));
}

#[test]
fn delete_removes_extraneous_files() {
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	assert_eq!(run(&["-a", "src/", "dst/"], dir.path()).0, 0);
	fs::write(dir.path().join("dst/extra"), b"gone").unwrap();
	fs::create_dir(dir.path().join("dst/olddir")).unwrap();
	// Adding the extras bumped dst's mtime; restore src's so only the deletions are itemized
	// rather than also `.d..t...... ./` whenever the writes crossed a timestamp tick.
	let src_mtime = fs::metadata(&src).unwrap().modified().unwrap();
	fs::set_times_nofollow(dir.path().join("dst"), fs::FileTimes::new().set_modified(src_mtime)).unwrap();
	let (code, out, err) = run(&["-ai", "--delete", "src/", "dst/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_eq!(out, "*deleting   olddir/\n*deleting   extra\n");
	assert_same_tree(&src, &dir.path().join("dst"));
}

#[test]
fn checksum_mode_catches_same_size_and_time() {
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	let (code, _, err) = run(&["-a", "src/", "dst/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	let target = dir.path().join("dst/a");
	let when = mtime(&target);
	fs::write(&target, b"HELLO\n").unwrap();
	fs::File::options().write(true).open(&target).unwrap().set_modified(when).unwrap();
	// The quick check sees nothing to do.
	let (code, out, err) = run(&["-ai", "src/", "dst/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_eq!(out, "");
	assert_eq!(fs::read(&target).unwrap(), b"HELLO\n");
	// -c compares contents.
	let (code, out, err) = run(&["-aic", "src/", "dst/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_eq!(out, ">fc........ a\n");
	assert_eq!(fs::read(&target).unwrap(), b"hello\n");
}

#[test]
fn dry_run_changes_nothing() {
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (code, out, _) = run(&["-ain", "src/", "dst/"], dir.path());
	assert_eq!(code, 0);
	assert!(out.starts_with("created directory dst\ncd+++++++++ ./\n>f+++++++++ a\n"), "{out}");
	assert!(!dir.path().join("dst").exists());
	let (code, out, _) = run(&["-an", "--stats", "src/", "dst/"], dir.path());
	assert_eq!(code, 0);
	assert!(out.contains("Number of regular files transferred: 3"), "{out}");
	assert!(out.trim_end().ends_with("(DRY RUN)"), "{out}");
}

#[test]
fn list_only_matches_reference() {
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (code, out, _) = run(&["--list-only", "src/"], dir.path());
	assert_eq!(code, 0);
	assert!(out.lines().any(|l| l.starts_with("-rw") && l.ends_with(" a")), "{out}");
	let Some(rsync) = reference() else { return };
	let theirs = Command::new(&rsync).args(["--list-only", "src/"]).current_dir(dir.path()).output().unwrap();
	assert_eq!(out, String::from_utf8_lossy(&theirs.stdout));
	let (_, out, _) = run(&["-r", "src"], dir.path());
	let theirs = Command::new(&rsync).args(["-r", "src"]).current_dir(dir.path()).output().unwrap();
	assert_eq!(out, String::from_utf8_lossy(&theirs.stdout));
}

/// A fake remote shell that runs the remote command locally.
#[cfg(unix)]
fn fake_rsh(dir: &Path) -> PathBuf {
	let path = dir.join("fakersh");
	crate::testprog::write(&path, "#!/bin/sh\nshift\nexec \"$@\"\n");
	path
}

#[cfg(unix)]
#[test]
fn remote_shell_push_and_pull_against_reference_server() {
	let Some(rsync) = reference() else { return };
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	let rsh = fake_rsh(dir.path());
	let rsh = rsh.to_str().unwrap();
	let rpath = format!("--rsync-path={}", rsync.display());
	let pushed = dir.path().join("pushed");
	let dest = format!("h:{}/", pushed.display());
	let (code, out, err) = run(&["-ai", "-e", rsh, &rpath, "src/", &dest], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	// A pushing client itemizes sends with `<` (rsync 3.5.1 over a remote shell).
	assert!(out.contains("<f+++++++++ sub/b\n"), "{out}");
	assert_same_tree(&src, &pushed);
	// Pull it back, with deltas against a stale copy.
	let pulled = dir.path().join("pulled");
	fs::create_dir(&pulled).unwrap();
	let mut stale = fs::read(src.join("big")).unwrap();
	stale.truncate(500_000);
	stale.extend_from_slice(b"stale tail");
	fs::write(pulled.join("big"), stale).unwrap();
	let source = format!("h:{}/", pushed.display());
	let (code, out, err) = run(&["-a", "--stats", "-e", rsh, &rpath, &source, "pulled/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	assert!(out.contains("Matched data: "), "{out}");
	assert_same_tree(&src, &pulled);
	// Protocol 29 against the same server.
	let old = dir.path().join("old");
	let dest = format!("h:{}/", old.display());
	let (code, _, err) = run(&["-a", "--protocol=29", "-e", rsh, &rpath, "src/", &dest], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_same_tree(&src, &old);
}

/// A tree whose only file is unreadable (`m/file`, mode 000); false when running
/// as root, where the file stays readable.
#[cfg(unix)]
fn unreadable_only_file(dir: &Path) -> bool {
	use std::os::unix::fs::PermissionsExt;
	let file = dir.join("m/file");
	fs::create_dir_all(dir.join("m")).unwrap();
	fs::write(&file, b"payload\n").unwrap();
	fs::set_permissions(&file, fs::Permissions::from_mode(0)).unwrap();
	fs::File::open(&file).is_err()
}

/// Runs `argv` in `cwd` on its own thread; panics when it does not finish.
#[cfg(unix)]
fn run_bounded(argv: Vec<String>, cwd: &Path, what: &str) -> (i32, String, String) {
	let cwd = cwd.to_path_buf();
	let (tx, rx) = std::sync::mpsc::channel();
	std::thread::spawn(move || {
		let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
		let _ = tx.send(run(&argv, &cwd));
	});
	rx.recv_timeout(std::time::Duration::from_secs(60)).unwrap_or_else(|_| panic!("{what} hung"))
}

/// Under inc-recursion the sender's MSG_NO_SEND for the only file reaches the
/// receiving side while its receiver already waits for input; the receiver
/// forwards it to the generator in its next output pass, which completes the
/// segment, so the run ends with code 23 instead of hanging (rsync 3.5.1).
#[cfg(unix)]
#[test]
fn unreadable_only_file_is_a_partial_transfer() {
	let dir = tempfile::tempdir().unwrap();
	if !unreadable_only_file(dir.path()) {
		return;
	}
	let argv = vec!["-r".to_owned(), "m/file".to_owned(), "d1/".to_owned()];
	let (code, out, err) = run_bounded(argv, dir.path(), "local copy of an unreadable file");
	assert_eq!(code, 23, "{out}{err}");
	assert!(err.starts_with("rsync: [sender] send_files failed to open \""), "{err}");
	assert!(err.contains("m/file\": Permission denied (13)\n"), "{err}");
	assert!(
		err.ends_with(
			"rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1412) [sender=3.5.1]\n"
		),
		"{err}"
	);
	assert!(!dir.path().join("d1/file").exists());

	// The same from a reference `--server --sender`: our receiver forwards its
	// MSG_NO_SEND.
	let Some(rsync) = reference() else { return };
	let rsh = fake_rsh(dir.path());
	let argv = vec![
		"-r".to_owned(),
		"-e".to_owned(),
		rsh.to_str().unwrap().to_owned(),
		format!("--rsync-path={}", rsync.display()),
		format!("h:{}/m/file", dir.path().display()),
		"d2/".to_owned(),
	];
	let (code, out, err) = run_bounded(argv, dir.path(), "pull of an unreadable file");
	assert_eq!(code, 23, "{out}{err}");
	assert!(err.contains("send_files failed to open"), "{err}");
	assert!(
		err.ends_with(
			"rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1983) [generator=3.5.1]\n"
		),
		"{err}"
	);
}

#[cfg(unix)]
#[test]
fn remote_error_exit_code_is_the_servers() {
	let Some(rsync) = reference() else { return };
	let dir = tempfile::tempdir().unwrap();
	let rsh = fake_rsh(dir.path());
	let rpath = format!("--rsync-path={}", rsync.display());
	let source = format!("h:{}/nonexistent/", dir.path().display());
	let (code, _, err) = run(&["-r", "-e", rsh.to_str().unwrap(), &rpath, &source, "out/"], dir.path());
	assert_eq!(code, 23, "{err}");
	assert!(err.contains("change_dir"), "{err}");
	// Captured from rsync 3.5.1: after the trailer the client's MSG_ERROR_EXIT
	// meets the departed server (exit_cleanup's tail).
	assert!(
		err.ends_with(
			"(code 23) at main.c(1983) [Receiver=3.5.1]\nrsync: [Receiver] write error: Broken pipe (32)\n"
		),
		"{err}"
	);
}

#[test]
fn batch_write_then_read_round_trip() {
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	let (code, _, err) = run(&["-a", "--exclude=*.o", "--write-batch=b", "src/", "d1/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_same_tree(&src, &dir.path().join("d1"));
	let script = fs::read_to_string(dir.path().join("b.sh")).unwrap();
	assert_eq!(script, "'rsync' --filter='._-' '-a' --read-batch='b' ${1:-'d1/'} <<'#E#'\n- *.o\n#E#\n");
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let mode = fs::metadata(dir.path().join("b.sh")).unwrap().permissions().mode() & 0o777;
		assert_eq!(mode, 0o700);
	}
	let (code, out, err) = run(&["-a", "-i", "--read-batch=b", "d2/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	assert_same_tree(&src, &dir.path().join("d2"));
	// --only-write-batch leaves the destination alone.
	let (code, out, _) = run(&["-a", "--only-write-batch=c", "-v", "src/", "d3/"], dir.path());
	assert_eq!(code, 0);
	assert!(!dir.path().join("d3").exists());
	assert!(out.trim_end().ends_with("(BATCH ONLY)"), "{out}");
	let (code, _, _) = run(&["-a", "--read-batch=c", "d3/"], dir.path());
	assert_eq!(code, 0);
	assert_same_tree(&src, &dir.path().join("d3"));
}

#[test]
fn batch_read_by_reference_rsync() {
	let Some(rsync) = reference() else { return };
	// The batch file carries our protocol (33); an older reference refuses it.
	let version = Command::new(&rsync).arg("--version").output().unwrap();
	if !String::from_utf8_lossy(&version.stdout).contains("protocol version 33") {
		return;
	}
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	let (code, _, _) = run(&["-a", "--only-write-batch=b", "src/", "d1/"], dir.path());
	assert_eq!(code, 0);
	let status = Command::new(&rsync).args(["-a", "--read-batch=b", "d1/"]).current_dir(dir.path()).status().unwrap();
	assert!(status.success());
	assert_same_tree(&src, &dir.path().join("d1"));
	// And the other way round.
	let status = Command::new(&rsync).args(["-a", "--only-write-batch=r", "src/", "d2/"]).current_dir(dir.path()).status().unwrap();
	assert!(status.success());
	let (code, _, err) = run(&["-a", "--read-batch=r", "d2/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_same_tree(&src, &dir.path().join("d2"));
}

#[test]
fn missing_source_is_a_partial_transfer() {
	let dir = tempfile::tempdir().unwrap();
	let (code, _, err) = run(&["-a", "nope", "dst/"], dir.path());
	assert_eq!(code, 23, "{err}");
	assert!(err.contains("link_stat"), "{err}");
	assert!(err.ends_with("(code 23) at main.c(1412) [sender=3.5.1]\n"), "{err}");
}

#[test]
fn fold_exit_precedence() {
	assert_eq!(fold_exit(0, IOERR_DEL_LIMIT | IOERR_VANISHED, false), RERR_VANISHED);
	assert_eq!(fold_exit(0, IOERR_VANISHED, true), crate::rsync::exit::RERR_PARTIAL);
	assert_eq!(fold_exit(0, IOERR_DEL_LIMIT, false), crate::rsync::exit::RERR_DEL_LIMIT);
	assert_eq!(fold_exit(12, IOERR_GENERAL, true), 12);
	assert_eq!(fold_exit(0, 0, false), 0);
}

#[test]
fn delete_excluded_position_counts_rules_before_it() {
	let argv: Vec<OsString> =
		["rsync", "-f- a", "--exclude", "b", "--delete-excluded", "--include=c", "x", "y"].iter().map(OsString::from).collect();
	assert_eq!(delete_excluded_position(&argv, 3), 2);
	let argv: Vec<OsString> = ["rsync", "--delete-excluded", "-f- a"].iter().map(OsString::from).collect();
	assert_eq!(delete_excluded_position(&argv, 1), 0);
	let argv: Vec<OsString> = ["rsync", "-e", "--delete-excluded", "-f- a"].iter().map(OsString::from).collect();
	assert_eq!(delete_excluded_position(&argv, 1), 1);
}

#[test]
fn d_option_hint_for_old_servers() {
	let buf = std::sync::Arc::new(Mutex::new(Vec::new()));
	struct Out(Arc<Mutex<Vec<u8>>>);
	impl Write for Out {
		fn write(&mut self, b: &[u8]) -> io::Result<usize> {
			lock(&self.0).extend_from_slice(b);
			Ok(b.len())
		}
		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}
	let logger = Logger::local(Box::new(io::sink()), Box::new(Out(Arc::clone(&buf))), LogConfig::default());
	check_for_d_option_error(&logger, b"rsync: on remote machine: -vde.LsfxC: unknown option");
	check_for_d_option_error(&logger, b"rsync: on remote machine: --dirs: unknown option");
	assert_eq!(&*lock(&buf), b"*** Try using \"--old-d\" if remote rsync is <= 2.6.3 ***\n");
}

#[test]
fn files_from_forwarding_collapses_lines() {
	let counters = IoCounters::default();
	struct Out(Arc<Mutex<Vec<u8>>>);
	impl Write for Out {
		fn write(&mut self, b: &[u8]) -> io::Result<usize> {
			lock(&self.0).extend_from_slice(b);
			Ok(b.len())
		}
		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}
	let buf = Arc::new(Mutex::new(Vec::new()));
	let w = MuxWriter::new(Box::new(Out(Arc::clone(&buf))), counters, WriteConfig::default());
	// With -R the whole forwarded path is what was asked for.
	let implied = Mutex::new(ImpliedFilters::new(true, false, false));
	let src: Box<dyn Read + Send> = Box::new(&b"\n\na\r\n\nb/c\nlast"[..]);
	forward_files_from(src, &w, 31, false, Some(&implied), &AtomicBool::new(false)).unwrap();
	assert_eq!(&*lock(&buf), b"a\0b/c\0last\0\0");
	assert_eq!(lock(&implied).check(b"b/c", false), crate::rsync::filter::Verdict::Include);
}

/// A `--log-file` that cannot be opened is reported as rsync 3.5.1 reports
/// it, and the copy goes on. Measured with rsync 3.5.1 under `LC_ALL=C`: a
/// missing directory, a directory, and (not as root) a directory it may not
/// write give the client `rsync: [client] failed to open log-file …` on
/// stderr and `Ignoring "log file" setting.` on stdout, and a local copy's
/// server half (`-M--log-file=`) both lines on stderr as `[Receiver]`; an
/// empty name means syslog and prints nothing on either side. Before, the
/// client named itself `[sender]`, and an empty name opened the current
/// directory and failed with `Is a directory (21)`.
#[cfg(unix)]
#[test]
fn a_log_file_that_cannot_be_opened_is_reported_as_rsync_does() {
	use std::os::unix::fs::PermissionsExt;
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	fs::create_dir_all(dir.path().join("adir")).unwrap();
	fs::create_dir_all(dir.path().join("ro")).unwrap();
	fs::set_permissions(dir.path().join("ro"), fs::Permissions::from_mode(0o555)).unwrap();
	let d = dir.path().display().to_string();
	let mut cases = vec![
		("missing", format!("{d}/nope/x.log"), Some(format!("{d}/nope/x.log: No such file or directory (2)"))),
		("dir", format!("{d}/adir"), Some(format!("{d}/adir: Is a directory (21)"))),
		("empty", String::new(), None),
	];
	if !nix::unistd::geteuid().is_root() {
		cases.push(("unwritable", format!("{d}/ro/x.log"), Some(format!("{d}/ro/x.log: Permission denied (13)"))));
	}
	for (case, path, failure) in cases {
		for server in [false, true] {
			let _ = fs::remove_dir_all(dir.path().join("dst"));
			let arg = if server { format!("-M--log-file={path}") } else { format!("--log-file={path}") };
			let (code, out, err) = run(&["-a", &arg, "src/", "dst/"], dir.path());
			let (want_out, want_err) = match (&failure, server) {
				(None, _) => (String::new(), String::new()),
				(Some(why), false) => {
					("Ignoring \"log file\" setting.\n".to_string(), format!("rsync: [client] failed to open log-file {why}\n"))
				},
				(Some(why), true) => (
					String::new(),
					format!("rsync: [Receiver] failed to open log-file {why}\nIgnoring \"log file\" setting.\n"),
				),
			};
			assert_eq!((code, out, err), (0, want_out, want_err), "{case} server={server}");
			assert_eq!(fs::read(dir.path().join("dst/sub/b")).unwrap(), b"x\n", "{case} server={server}");
		}
	}
}

/// The builtin run as a remote server (`--server`, as a client's remote
/// shell starts it) names itself `[server]` when its `--log-file` cannot be
/// opened, as rsync 3.5.1's remote server does while it is starting up.
#[cfg(unix)]
#[test]
fn a_remote_server_names_itself_server_when_its_log_cannot_be_opened() {
	let dir = tempfile::tempdir().unwrap();
	let log = dir.path().join("nope/x.log");
	let arg = format!("--log-file={}", log.display());
	let (_, _, err) = run(&["--server", "-logDtpre.iLsfxCIvu", &arg, ".", "dst/"], dir.path());
	let first = err.lines().next().unwrap_or_default();
	assert_eq!(first, format!("rsync: [server] failed to open log-file {}: No such file or directory (2)", log.display()), "{err}");
}
