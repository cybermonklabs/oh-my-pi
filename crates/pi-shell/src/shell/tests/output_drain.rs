//! Unix only (`next_read`): the Windows readers stop at a cancel.

use std::io::Write as _;

use super::*;

/// What the command under test wrote before it ended. The pipe's writer stays
/// open, as a background job keeps it, so the reader sees no end of file.
const WRITTEN: &str = "written before the end\n";

/// A pipe holding [`WRITTEN`], with its writer still open, and a cancel that
/// already fired: the post-exit wait cancels a reader once the pipe has been
/// quiet for 250 ms, and on a loaded machine (the GKE Sandbox) that can come
/// before the reader has run at all.
fn written_and_cancelled() -> (fs::File, fs::File, CancellationToken) {
	let (reader, mut writer) = pipe_to_files("output").expect("pipe");
	writer.write_all(WRITTEN.as_bytes()).expect("write");
	let cancel = CancellationToken::new();
	cancel.cancel();
	(reader, writer, cancel)
}

/// The streaming reader keeps what the pipe held when it was cancelled.
#[tokio::test(flavor = "current_thread")]
async fn a_cancelled_streaming_reader_keeps_what_the_pipe_holds() {
	for _ in 0..20 {
		let (reader, writer, cancel) = written_and_cancelled();
		let (tx, rx) = flume::unbounded::<String>();
		let (activity, _seen) = flume::bounded::<()>(1);
		read_output(reader, Some(tx), cancel, activity).await;
		assert_eq!(rx.drain().collect::<String>(), WRITTEN);
		drop(writer);
	}
}

/// The buffered reader keeps what the pipe held when it was cancelled, in its
/// capture and in what it streamed.
#[tokio::test(flavor = "current_thread")]
async fn a_cancelled_buffered_reader_keeps_what_the_pipe_holds() {
	for _ in 0..20 {
		let (reader, writer, cancel) = written_and_cancelled();
		let (tx, rx) = flume::unbounded::<String>();
		let (activity, _seen) = flume::bounded::<()>(1);
		let output = read_output_buffered(reader, Some(tx), cancel, activity, 1 << 20).await;
		assert_eq!((output.text.as_str(), output.input_bytes), (WRITTEN, WRITTEN.len()));
		assert_eq!(rx.drain().collect::<String>(), WRITTEN);
		drop(writer);
	}
}

/// The byte reader of `execute_shell_streams` keeps what the pipe held when it
/// was cancelled.
#[tokio::test(flavor = "current_thread")]
async fn a_cancelled_byte_reader_keeps_what_the_pipe_holds() {
	for _ in 0..20 {
		let (reader, writer, cancel) = written_and_cancelled();
		let (tx, rx) = flume::unbounded::<Bytes>();
		let (activity, _seen) = flume::bounded::<()>(1);
		read_output_bytes(reader, Some(tx), cancel, activity).await;
		let read: Vec<u8> = rx.drain().flat_map(|chunk| chunk.to_vec()).collect();
		assert_eq!(read, WRITTEN.as_bytes());
		drop(writer);
	}
}

/// A cancelled reader stops at what the pipe held at the cancel: a writer
/// that keeps writing after it (a background `yes`) does not keep it reading.
#[tokio::test(flavor = "current_thread")]
async fn a_cancelled_reader_stops_at_what_the_pipe_held() {
	let (reader, mut writer) = pipe_to_files("output").expect("pipe");
	let cancel = CancellationToken::new();
	cancel.cancel();
	let stop = Arc::new(AtomicBool::new(false));
	let writing = std::thread::spawn({
		let stop = stop.clone();
		move || {
			while !stop.load(Ordering::Relaxed) {
				if writer.write_all(&[b'y'; 4096]).is_err() {
					break;
				}
			}
		}
	});
	let (tx, rx) = flume::unbounded::<Bytes>();
	let (activity, _seen) = flume::bounded::<()>(1);
	read_output_bytes(reader, Some(tx), cancel, activity).await;
	stop.store(true, Ordering::Relaxed);
	// The reader returned while the writer still writes; the writer's next
	// write then fails on the closed pipe and it ends.
	writing.join().expect("writer");
	let read: usize = rx.drain().map(|chunk| chunk.len()).sum();
	assert!(read <= 1 << 20, "read {read} bytes, more than a pipe holds");
}
