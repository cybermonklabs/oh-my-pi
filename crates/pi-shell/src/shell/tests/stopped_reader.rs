//! A reader cancelled while it waits on an empty pipe stops. On Windows its
//! read in flight is a blocking `ReadFile`, which only the cancel ends
//! (`PipeReader::settle`).

use super::*;

/// The pipe is empty and its writer stays open, as a background job that
/// prints nothing keeps it: the reader waits in a read, and its cancel
/// ends that read. A reader that waited for the read's own end would wait
/// for the writer, which this test holds until the reader has returned.
#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_reader_of_an_empty_pipe_a_job_holds_stops() {
	let (reader, writer) = pipe_to_files("output").expect("pipe");
	let cancel = CancellationToken::new();
	let (tx, rx) = flume::unbounded::<Bytes>();
	let (activity, _seen) = flume::bounded::<()>(1);
	let reading = tokio::spawn(read_output_bytes(reader, Some(tx), cancel.clone(), activity));
	// Before or after the reader's read starts: either way the read that the
	// reader waits in when it takes the cancel has to be ended.
	tokio::task::yield_now().await;
	cancel.cancel();
	reading.await.expect("reader");
	assert_eq!(rx.drain().map(|chunk| chunk.len()).sum::<usize>(), 0);
	drop(writer);
}
