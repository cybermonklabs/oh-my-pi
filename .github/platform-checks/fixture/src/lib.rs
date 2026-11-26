//! Tests with known outcomes, for the platform-checks controls.

#[cfg(test)]
mod tests {
	#[test]
	fn passes() {}

	/// Fails; its name holds the word that must not make it read as a hang.
	#[test]
	fn fails_with_timeout_in_its_name() {
		panic!("a planted failure, not a timeout");
	}

	#[test]
	#[ignore = "counted apart, never run"]
	fn ignored_one() {}

	/// Never ends: nextest's time bound stops it.
	#[test]
	fn hangs() {
		loop {
			std::thread::sleep(std::time::Duration::from_millis(200));
		}
	}

	/// Fails on its first run and passes after, through a marker file
	/// PC_FIXTURE_MARK names.
	#[test]
	fn flaky_once() {
		let mark = std::env::var("PC_FIXTURE_MARK").expect("PC_FIXTURE_MARK");
		if std::fs::metadata(&mark).is_err() {
			std::fs::write(&mark, b"seen").unwrap();
			panic!("the first run fails");
		}
	}
}
