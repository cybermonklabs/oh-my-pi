//! The bash the tests compare obash with: `PI_TEST_REAL_BASH` when it is set
//! (macOS's `/bin/bash` is bash 3.2 and cannot be replaced, so the platform
//! checks point this at a current bash there), else `/bin/bash`.

use std::path::Path;

/// The bash to compare with; `None` when neither is there.
pub fn real_bash() -> Option<String> {
	match std::env::var("PI_TEST_REAL_BASH") {
		Ok(path) if !path.is_empty() => Some(path),
		_ => Path::new("/bin/bash")
			.exists()
			.then(|| "/bin/bash".to_owned()),
	}
}
