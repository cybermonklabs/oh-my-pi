/// sami-checks' frames row, the reader: appended to this file by .github/sami-checks/frames.sh in CI
/// only, never part of a release. The previous release's build ran `sc_frames_write` (frames_write.rs)
/// and left its blobs in $SC_FRAMES_BASE.
mod sc_frames {
	use std::panic::{AssertUnwindSafe, catch_unwind};

	use crate::{
		bash::{
			Budget, Cx, Engine, EngineConfig, Incompatibility, MemStore, RestoreError, RestoreOpts,
			RunId, Script, Shell, Signal, StateStore, UnitId, store::BlobSlot,
		},
		testkit::{
			FakeHost,
			fault::skeleton_init,
			run::{Stop, advance},
		},
	};

	/// A store's blobs: the frames and the IR units they name.
	type Blobs = Vec<(BlobSlot, Vec<u8>)>;

	/// Ops enough for a script that ends, and no wall-time bound: a slow runner must not yield it.
	const FINISH: Budget = Budget { max_ops: 20_000, max_ns: u64::MAX };

	/// The previous release's blobs and the run its frames hold, in frames_write.rs's format.
	fn load() -> Result<(Blobs, RunId), String> {
		let dir = std::env::var_os("SC_FRAMES_BASE").ok_or("SC_FRAMES_BASE is not set")?;
		let dir = std::path::Path::new(&dir);
		let raw = std::fs::read(dir.join("blobs.bin")).map_err(|e| format!("blobs.bin: {e}"))?;
		let run = std::fs::read_to_string(dir.join("run.txt")).map_err(|e| format!("run.txt: {e}"))?;
		let run = RunId(run.trim().parse().map_err(|e| format!("run.txt: {e}"))?);
		let mut blobs = Vec::new();
		let mut rest = &raw[..];
		while !rest.is_empty() {
			if rest.len() < 41 {
				return Err("blobs.bin ends inside a blob's head".into());
			}
			let len = usize::try_from(u64::from_le_bytes(rest[33..41].try_into().unwrap()))
				.map_err(|e| e.to_string())?;
			let end = 41usize.saturating_add(len);
			let bytes = rest.get(41..end).ok_or("blobs.bin ends inside a blob")?;
			let slot = match rest[0] {
				b'F' => BlobSlot::Frames,
				b'U' => BlobSlot::Unit(UnitId(rest[1..33].try_into().unwrap())),
				k => return Err(format!("blobs.bin: blob kind {k}")),
			};
			blobs.push((slot, bytes.to_vec()));
			rest = &rest[end..];
		}
		Ok((blobs, run))
	}

	fn frames_of(blobs: &Blobs) -> Option<&[u8]> {
		blobs
			.iter()
			.find(|(slot, _)| *slot == BlobSlot::Frames)
			.map(|(_, bytes)| &bytes[..])
	}

	/// A frames header's IR version, frames version and build id. Postcard writes the magic and the
	/// build id as raw bytes and each version as a varint, one byte while it is below 128.
	fn header(blob: &[u8]) -> Result<(u8, u8, [u8; 32]), String> {
		if blob.len() < 38 || blob[..4] != *b"OBF1" {
			return Err(format!("not a frames blob ({} bytes)", blob.len()));
		}
		if blob[4] >= 0x80 || blob[5] >= 0x80 {
			return Err(format!(
				"a version of 128 or more (header bytes {} and {}): the row reads the header at fixed offsets",
				blob[4], blob[5]
			));
		}
		Ok((blob[4], blob[5], blob[6..38].try_into().unwrap()))
	}

	/// This build's shell after the writer's script: `kept=yes`, then a loop externalized mid-run.
	/// Its records are what an upgraded host still holds (the store's records are the host's; only
	/// the blobs are the engine build's).
	fn own() -> (FakeHost, MemStore) {
		let engine = Engine::new(EngineConfig::default());
		let mut host = FakeHost::new();
		let mut store = MemStore::new();
		let mut shell =
			Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
				.expect("this build creates a shell");
		let set = shell.submit(Script::command(&b"kept=yes"[..]));
		assert_eq!(advance(&mut shell, &mut host, &mut store, set, FINISH), Stop::Done(0));
		let id = shell.submit(Script::command(&b"while :; do :; done"[..]));
		assert_eq!(
			advance(&mut shell, &mut host, &mut store, id, Budget { max_ops: 9, max_ns: u64::MAX }),
			Stop::Yield
		);
		shell
			.externalize(&mut Cx { host: &mut host, store: &mut store })
			.expect("this build externalizes");
		(host, store)
	}

	/// A new run prints `kept=yes`: the root store state stayed.
	fn kept(shell: &mut Shell, host: &mut FakeHost, store: &mut MemStore) -> Result<(), String> {
		let next = shell.submit(Script::command(&b"echo \"kept=$kept\""[..]));
		let step = advance(shell, host, store, next, FINISH);
		let out = host.stdout.bytes();
		if step != Stop::Done(0) || !out.ends_with(b"kept=yes\n") {
			return Err(format!(
				"a new run gives {step:?} and the output is {:?}, not kept=yes",
				String::from_utf8_lossy(&out)
			));
		}
		Ok(())
	}

	/// Restores `blobs` (frames and units another build wrote) into this build's store of the same
	/// script, with a fresh engine (no unit of this build cached), as an upgraded host does. Frames
	/// of this build's id must restore and run on. Frames of another must be refused and kept, and
	/// `drop_frames` must then end their run with 255 and keep `kept=yes`.
	fn read(blobs: &Blobs, run: RunId) -> Result<String, String> {
		let (mut host, mut store) = own();
		let mine = store
			.get_blob(BlobSlot::Frames)
			.map_err(|e| format!("{e:?}"))?
			.ok_or("this build wrote no frames")?;
		let (ir, fv, build) = header(&mine)?;
		let theirs = frames_of(blobs).ok_or("the previous release wrote no frames")?;
		let (their_ir, their_fv, their_build) = header(theirs)?;
		store
			.del_blob(BlobSlot::Frames)
			.map_err(|e| format!("{e:?}"))?;
		for (slot, bytes) in blobs {
			store.put_blob(*slot, bytes).map_err(|e| format!("{e:?}"))?;
		}
		let engine = Engine::new(EngineConfig::default());
		let first =
			Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, RestoreOpts::default());
		let them = format!(
			"frames of IR {their_ir}, FRAMES_VERSION {their_fv} on a build of IR {ir}, FRAMES_VERSION {fv}"
		);
		if their_build == build {
			let (mut shell, report) = first.map_err(|e| {
				format!(
					"{them}, the same build id: restore fails ({e}: {e:?}); was a layout changed without a FRAMES_VERSION raise?"
				)
			})?;
			if !report.abandoned.is_empty() {
				return Err(format!("{them}, the same build id: restore abandoned {:?}", report.abandoned));
			}
			let step =
				advance(&mut shell, &mut host, &mut store, run, Budget { max_ops: 50, max_ns: u64::MAX });
			if step != Stop::Yield {
				return Err(format!("{them}, restored: the loop's run {} gives {step:?}, not Yield", run.0));
			}
			shell.control().cancel(Signal::Kill);
			let step = advance(&mut shell, &mut host, &mut store, run, FINISH);
			if step != Stop::Done(137) {
				return Err(format!("{them}, restored: the killed loop gives {step:?}, not Done(137)"));
			}
			kept(&mut shell, &mut host, &mut store).map_err(|e| format!("{them}, restored: {e}"))?;
			return Ok(format!(
				"{them}, the same build id: restored; the loop ran on and ended 137 on a kill; kept=yes"
			));
		}
		let why = match first {
			Err(RestoreError::Incompatible { why }) => why,
			Err(e) => return Err(format!("{them}: restore fails with {e:?}, not a refusal (Incompatible)")),
			Ok(_) => return Err(format!("{them}: restored; frames of another build id must be refused")),
		};
		let left = store
			.get_blob(BlobSlot::Frames)
			.map_err(|e| format!("{e:?}"))?;
		if left.is_none() {
			return Err(format!("{them}: refused ({why}), and the blob is gone; a refusal keeps it"));
		}
		let (mut shell, report) = Shell::restore(
			&engine,
			&mut Cx { host: &mut host, store: &mut store },
			RestoreOpts { drop_frames: true, ..RestoreOpts::default() },
		)
		.map_err(|e| format!("{them}: refused ({why}); then drop_frames fails: {e:?}"))?;
		if report.abandoned != [run] {
			return Err(format!(
				"{them}: drop_frames abandoned {:?}, not the run the frames hold ({})",
				report.abandoned, run.0
			));
		}
		let left = store
			.get_blob(BlobSlot::Frames)
			.map_err(|e| format!("{e:?}"))?;
		if left.is_some() {
			return Err(format!("{them}: drop_frames left the blob"));
		}
		let step = advance(&mut shell, &mut host, &mut store, run, FINISH);
		if step != Stop::Done(255) {
			return Err(format!("{them}: the abandoned run gives {step:?}, not Done(255)"));
		}
		kept(&mut shell, &mut host, &mut store).map_err(|e| format!("{them}, after drop_frames: {e}"))?;
		Ok(format!(
			"{them}: refused ({why}) and kept; drop_frames ended the run with 255; kept=yes"
		))
	}

	fn varint(bytes: &[u8], at: &mut usize) -> Result<u64, String> {
		let mut value = 0u64;
		for shift in (0..64).step_by(7) {
			let byte = *bytes.get(*at).ok_or("the header ends inside its run list")?;
			*at += 1;
			value |= u64::from(byte & 0x7f) << shift;
			if byte & 0x80 == 0 {
				return Ok(value);
			}
		}
		Err("a varint longer than 10 bytes".into())
	}

	/// The control: the previous release's frames under this build's header (its versions and
	/// build id) with their body one byte off, as a layout change without a version raise meets
	/// this build. `read` must not pass them.
	fn planted(blobs: &Blobs, mine: &[u8]) -> Result<Blobs, String> {
		let theirs = frames_of(blobs).ok_or("the previous release wrote no frames")?;
		header(theirs)?;
		header(mine)?;
		// The header's run list follows its 38 fixed bytes: a varint count, then a varint per run.
		let mut at = 38;
		let runs = varint(theirs, &mut at)?;
		for _ in 0..runs {
			varint(theirs, &mut at)?;
		}
		let mut frames = mine[..38].to_vec();
		frames.extend_from_slice(&theirs[38..at]);
		frames.push(0);
		frames.extend_from_slice(&theirs[at..]);
		Ok(blobs
			.iter()
			.map(|(slot, bytes)| (*slot, if *slot == BlobSlot::Frames { frames.clone() } else { bytes.clone() }))
			.collect())
	}

	/// The previous release's frames, read by this build (`read`), after the control (`planted`).
	/// Each outcome is one `SCFRAMES` line; sc.py frames reads them.
	#[test]
	fn previous_release_frames_are_read_by_this_build() {
		let (blobs, run) = match load() {
			Ok(loaded) => loaded,
			Err(e) => {
				println!("SCFRAMES unknown: the previous release's output: {e}");
				return;
			},
		};
		let (_, mut store) = own();
		let mine = store
			.get_blob(BlobSlot::Frames)
			.unwrap()
			.expect("this build writes frames");
		let heads = frames_of(&blobs)
			.ok_or_else(|| "the previous release wrote no frames".to_string())
			.and_then(header)
			.and_then(|theirs| Ok((theirs, header(&mine)?)));
		let ((their_ir, their_fv, their_build), (ir, fv, build)) = match heads {
			Ok(heads) => heads,
			Err(e) => {
				println!("SCFRAMES unknown: {e}");
				return;
			},
		};
		let case = if their_build == build { "restored" } else { "refused" };
		println!(
			"SCFRAMES case: {case}; the previous release's frames (IR {their_ir}, FRAMES_VERSION {their_fv}, run {}) on this build (IR {ir}, FRAMES_VERSION {fv}, package {})",
			run.0,
			env!("CARGO_PKG_VERSION")
		);
		match planted(&blobs, &mine) {
			Err(e) => println!("SCFRAMES control unknown: {e}"),
			Ok(plant) => match catch_unwind(AssertUnwindSafe(|| read(&plant, run))) {
				Ok(Ok(s)) => println!("SCFRAMES control NOT caught: {s}"),
				Ok(Err(e)) => println!("SCFRAMES control caught: {e}"),
				Err(_) => println!("SCFRAMES control caught: the read panicked (its message is above)"),
			},
		}
		match read(&blobs, run) {
			Ok(s) => println!("SCFRAMES read ok: {s}"),
			Err(e) => panic!("SCFRAMES read FAIL: {e}"),
		}
	}

	/// The release gate's frames row (kit only, never in the release): for every frames version from 30 to this
	/// build's, a frames blob is written by this build and its header is made the one a build of that version writes
	/// (the version byte and the build id `Engine::build_id` derives from it). A blob of an older version is refused as
	/// another build's (`Incompatible { why: Build }`) and kept; `drop_frames` then discards it, the root store state
	/// (`kept=yes`) stays, the run it names ends 255 and a new run works. A blob of this build's own version restores.
	/// Each case prints one `KITFRAMES` line.
	#[test]
	fn kit_frames_row_every_older_version_is_refused_and_drop_frames_recovers() {
		// `bash::vm` is private to `bash`, so the build's own FRAMES_VERSION is found as the one version whose build id
		// (`Engine::build_id`: the package version, IR_VERSION and FRAMES_VERSION) is this build's; each blob's header
		// then shows it (byte 5).
		let ir = crate::bash::ir::IR_VERSION;
		let id_of = |v: u32| -> [u8; 32] {
			let mut h = blake3::Hasher::new();
			h.update(env!("CARGO_PKG_VERSION").as_bytes());
			h.update(&ir.to_le_bytes());
			h.update(&v.to_le_bytes());
			*h.finalize().as_bytes()
		};
		let current = (30..=127u32)
			.find(|&v| id_of(v) == Engine::build_id())
			.expect("no frames version from 30 to 127 gives this build's id: the derivation the row assumes changed");
		println!("KITFRAMES build FRAMES_VERSION={current} IR_VERSION={ir} pkg={}", env!("CARGO_PKG_VERSION"));
		for stored in 30..=current {
			let engine = Engine::new(EngineConfig::default());
			let mut host = FakeHost::new();
			let mut store = MemStore::new();
			let mut shell =
				Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
					.unwrap();
			let set = shell.submit(Script::command(&b"kept=yes"[..]));
			assert_eq!(advance(&mut shell, &mut host, &mut store, set, Budget::default()), Stop::Done(0));
			let id = shell.submit(Script::command(&b"while :; do :; done"[..]));
			assert_eq!(
				advance(&mut shell, &mut host, &mut store, id, Budget { max_ops: 9, max_ns: u64::MAX }),
				Stop::Yield
			);
			shell
				.externalize(&mut Cx { host: &mut host, store: &mut store })
				.unwrap();
			drop(shell);
			let mut blob = store.get_blob(BlobSlot::Frames).unwrap().unwrap();
			assert_eq!(&blob[..4], b"OBF1");
			assert_eq!(u32::from(blob[4]), ir);
			assert_eq!(u32::from(blob[5]), current, "the header's frames version byte");
			assert_eq!(&blob[6..38], &Engine::build_id()[..], "the header's build id");
			blob[5] = u8::try_from(stored).unwrap();
			blob[6..38].copy_from_slice(&id_of(stored));
			store.put_blob(BlobSlot::Frames, &blob).unwrap();
			let first = Shell::restore(
				&engine,
				&mut Cx { host: &mut host, store: &mut store },
				RestoreOpts::default(),
			);
			if stored == current {
				let (_shell, report) = first.expect("this build's own frames restore");
				assert!(report.abandoned.is_empty(), "nothing abandoned: {:?}", report.abandoned);
				println!("KITFRAMES stored={stored} current={current} restore=ok abandoned=0");
				continue;
			}
			let err = first.err();
			assert!(
				matches!(err, Some(RestoreError::Incompatible { why: Incompatibility::Build })),
				"frames of version {stored} on a build of {current}: {err:?}"
			);
			let kept = store.get_blob(BlobSlot::Frames).unwrap().is_some();
			assert!(kept, "a refused restore keeps the blob");
			let (mut shell, report) =
				Shell::restore(&engine, &mut Cx { host: &mut host, store: &mut store }, RestoreOpts {
					drop_frames: true,
					..RestoreOpts::default()
				})
				.unwrap();
			assert_eq!(report.abandoned, [id], "the header still names the abandoned run");
			assert!(store.get_blob(BlobSlot::Frames).unwrap().is_none(), "drop_frames consumes the blob");
			let next = shell.submit(Script::command(&b"echo \"kept=$kept\""[..]));
			assert_eq!(advance(&mut shell, &mut host, &mut store, id, Budget::default()), Stop::Done(255));
			assert_eq!(advance(&mut shell, &mut host, &mut store, next, Budget::default()), Stop::Done(0));
			assert!(host.stdout.bytes().ends_with(b"kept=yes\n"), "the root store state stays");
			println!(
				"KITFRAMES stored={stored} current={current} restore=Incompatible(Build) blob-kept={kept} drop_frames: abandoned=[run] run=255 kept=yes next=0"
			);
		}
	}
}
