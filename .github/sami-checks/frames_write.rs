
/// sami-checks' frames row, the writer: appended to this file by .github/sami-checks/frames.sh in CI
/// only, never part of a release. Run by the previous release's build, it writes that build's frames
/// of a loop externalized mid-run after `kept=yes`, with every blob they need, to $SC_FRAMES_OUT for
/// the next release's build to read (frames_read.rs).
mod sc_frames_write {
	use crate::{
		bash::{
			Budget, Cx, Engine, EngineConfig, MemStore, Script, Shell, StateStore,
			store::{BlobSlot, KeyBuf, Record},
		},
		testkit::{
			FakeHost,
			fault::skeleton_init,
			run::{Stop, advance},
		},
	};

	#[test]
	fn writes_this_builds_frames() {
		let out = std::env::var_os("SC_FRAMES_OUT").expect("SC_FRAMES_OUT names the directory to write");
		let out = std::path::Path::new(&out);
		let engine = Engine::new(EngineConfig::default());
		let mut host = FakeHost::new();
		let mut store = MemStore::new();
		let mut shell =
			Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
				.unwrap();
		let set = shell.submit(Script::command(&b"kept=yes"[..]));
		let finish = Budget { max_ops: 20_000, max_ns: u64::MAX };
		assert_eq!(advance(&mut shell, &mut host, &mut store, set, finish), Stop::Done(0));
		let id = shell.submit(Script::command(&b"while :; do :; done"[..]));
		assert_eq!(
			advance(&mut shell, &mut host, &mut store, id, Budget { max_ops: 9, max_ns: u64::MAX }),
			Stop::Yield
		);
		shell
			.externalize(&mut Cx { host: &mut host, store: &mut store })
			.unwrap();
		drop(shell);
		// Every blob of the store, from its image (MemStore's StoreImage: records, blobs, epoch).
		let (_, blobs, _): (Vec<(KeyBuf, Record)>, Vec<(BlobSlot, Vec<u8>)>, u64) =
			postcard::from_bytes(&store.to_bytes()).expect("the store image is records, blobs, epoch");
		// Per blob: a kind byte (`F` frames, `U` a unit), the unit's id (32 bytes, zero for the
		// frames), the length (8 bytes, little-endian), the bytes.
		let mut file = Vec::new();
		for (slot, bytes) in &blobs {
			match slot {
				BlobSlot::Frames => {
					file.push(b'F');
					file.extend_from_slice(&[0; 32]);
				},
				BlobSlot::Unit(unit) => {
					file.push(b'U');
					file.extend_from_slice(&unit.0);
				},
			}
			file.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
			file.extend_from_slice(bytes);
		}
		let frames = store
			.get_blob(BlobSlot::Frames)
			.unwrap()
			.expect("externalize wrote frames");
		std::fs::write(out.join("blobs.bin"), &file).unwrap();
		std::fs::write(out.join("run.txt"), format!("{}\n", id.0)).unwrap();
		println!(
			"SCFRAMES wrote {} blobs ({} bytes of frames); run {}; header bytes: IR {} FRAMES_VERSION {}; package {}",
			blobs.len(),
			frames.len(),
			id.0,
			frames[4],
			frames[5],
			env!("CARGO_PKG_VERSION")
		);
	}
}
