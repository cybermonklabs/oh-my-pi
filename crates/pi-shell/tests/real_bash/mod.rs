//! The bash the tests compare obash with: `PI_TEST_REAL_BASH` when it is set
//! (macOS's `/bin/bash` is bash 3.2 and cannot be replaced, so the platform
//! checks point this at a current bash there), else `/bin/bash`.
//!
//! Without the variable (or with it empty) it says so, on one line naming the
//! variable, each time it is called; a local run still uses `/bin/bash`. The
//! Rust gate (`.github/sami/rust-test.sh`) sets the variable and fails each
//! passing test whose output it does not list, so there a variable that did
//! not arrive fails each test that used another bash, by its name.

use std::path::Path;

/// The bash to compare with; `None` when neither is there.
pub fn real_bash() -> Option<String> {
	match std::env::var("PI_TEST_REAL_BASH") {
		Ok(path) if !path.is_empty() => Some(path),
		_ if Path::new("/bin/bash").exists() => {
			eprintln!("real_bash: PI_TEST_REAL_BASH is not set or is empty; using /bin/bash");
			Some("/bin/bash".to_owned())
		},
		_ => {
			eprintln!(
				"real_bash: PI_TEST_REAL_BASH is not set or is empty, and there is no /bin/bash"
			);
			None
		},
	}
}
