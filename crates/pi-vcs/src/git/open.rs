//! Lazy gitoxide handle management for [`GitRepo`](super::GitRepo).
//!
//! Owns the single place a `gix::ThreadSafeRepository` is opened: isolated
//! from ambient `GIT_DIR`/`GIT_INDEX_FILE`-style environment overrides (the
//! wrapper always operates on the discovered repository), while still honoring
//! user/system config for identity and diff settings. Reftable repositories
//! must never be opened here — callers route those through [`super::cli`].

use std::{
	ffi::{OsStr, OsString},
	path::PathBuf,
};

use gix::{
	open::{Options, Permissions, permissions},
	sec::{Permission, Trust},
};

use super::GitRepo;
use crate::error::{Error, Result};

impl GitRepo {
	/// Thread-local gitoxide repository for this checkout, opening the shared
	/// thread-safe handle on first use.
	///
	/// Errors on reftable repositories: they are unreadable in-process and
	/// every operation on them must use the CLI fallback instead.
	pub(crate) fn gix(&self) -> Result<gix::Repository> {
		if self.info().is_reftable {
			return Err(Error::backend(
				"git open",
				"reftable repository cannot be opened in-process; use the CLI fallback",
			));
		}
		if let Some(repo) = self.gix.get() {
			return Ok(repo.to_thread_local());
		}
		let opened = open_discovered(self)?;
		// A concurrent open may have won the race; either handle is equivalent.
		let repo = self.gix.get_or_init(move || opened);
		Ok(repo.to_thread_local())
	}

	/// Freshly opened gitoxide repository, bypassing the cached handle.
	///
	/// The cached handle snapshots config and refs at first open; callers that
	/// must observe out-of-band mutations (config writes, remote edits) pay
	/// for a fresh open instead.
	pub(crate) fn gix_fresh(&self) -> Result<gix::Repository> {
		if self.info().is_reftable {
			return Err(Error::backend(
				"git open",
				"reftable repository cannot be opened in-process; use the CLI fallback",
			));
		}
		Ok(open_discovered(self)?.to_thread_local())
	}
}

/// Open the discovered `.git` entry (directory, or gitfile for linked
/// worktrees and separate git dirs).
///
/// Never pass the checkout root: gix treats any `*.git` path as the metadata
/// directory itself instead of probing `<path>/.git`, so a checkout named
/// `repo.git` would fail to open. The entry also keeps gix deriving the work
/// tree from it, which the resolved `git_dir` alone cannot for separate git
/// dirs.
fn open_discovered(repo: &GitRepo) -> Result<gix::ThreadSafeRepository> {
	open_options()?
		.open(&repo.info().git_entry_path)
		.map_err(|err| Error::backend("git open", err))
}

/// Load the persisted worktree index straight from disk, reconstructing it from
/// `HEAD^{tree}` (or an empty index when `HEAD` is unborn) if no index file
/// exists.
///
/// Reads bypass gix's shared, mtime-gated index snapshot. The cached
/// [`gix`](GitRepo::gix) handle shares one
/// `SharedFileSnapshot<gix_index::File>` across every thread-local clone and
/// only reloads it when the index file's mtime is *strictly* newer than the
/// snapshot — gix's freshness check is deliberately sub-second-racy (`gix_fs`
/// `recent_snapshot` notes it "relies on sub-section precision or else is a
/// race … up to the caller"). The in-process mutators here write a fresh index
/// within the same mtime tick as the read that populated the snapshot, so a
/// later read through that snapshot would return the pre-mutation index — e.g.
/// a commit right after staging sees an unchanged tree and fails with "nothing
/// to commit, working tree clean". Reading the index from disk makes
/// mutate→read deterministic regardless of filesystem timestamp granularity.
pub(crate) fn load_index_or_head(
	repo: &gix::Repository,
	op: &'static str,
) -> Result<gix::index::File> {
	match repo.open_index() {
		Ok(index) => Ok(index),
		Err(err) if index_file_missing(repo, &err) => Ok(repo
			.index_or_load_from_head_or_empty()
			.map_err(|err| Error::backend(op, err))?
			.into_owned()),
		Err(err) => Err(Error::backend(op, err)),
	}
}

/// Load the persisted worktree index straight from disk, falling back to an
/// empty index (never `HEAD^{tree}`) when no index file exists.
///
/// Same snapshot-bypass rationale as [`load_index_or_head`]; the empty-index
/// fallback matches gix's [`index_or_empty`](gix::Repository::index_or_empty).
pub(crate) fn load_index_or_empty(
	repo: &gix::Repository,
	op: &'static str,
) -> Result<gix::index::File> {
	match repo.open_index() {
		Ok(index) => Ok(index),
		Err(err) if index_file_missing(repo, &err) => Ok(repo
			.index_or_empty()
			.map_err(|err| Error::backend(op, err))?
			.into_owned_or_cloned()),
		Err(err) => Err(Error::backend(op, err)),
	}
}

/// The worktree index file does not exist, as opposed to existing but being
/// unreadable or corrupt.
fn index_file_missing(repo: &gix::Repository, err: &gix::Error) -> bool {
	err.downcast_any_ref::<gix::index::file::init::OpenError>()
		.is_some_and(|err| {
			err.path == repo.index_path() && err.source.kind() == std::io::ErrorKind::NotFound
		})
}

/// Start a status query over an explicitly supplied index.
pub(crate) fn status_with_index<'repo>(
	repo: &'repo gix::Repository,
	op: &'static str,
	index: gix::index::File,
) -> Result<gix::status::Platform<'repo, gix::progress::Discard>> {
	Ok(repo
		.status(gix::progress::Discard)
		.map_err(|err| Error::backend(op, err))?
		.index(index.into()))
}

/// Start a status query with an index loaded directly from disk.
///
/// Supplying the index is required even after other read paths bypass the
/// shared snapshot: [`gix::Repository::status`] otherwise reacquires that same
/// mtime-gated snapshot internally.
pub(crate) fn status_with_fresh_index<'repo>(
	repo: &'repo gix::Repository,
	op: &'static str,
) -> Result<gix::status::Platform<'repo, gix::progress::Discard>> {
	status_with_index(repo, op, load_index_or_empty(repo, op)?)
}

/// Open options for repositories the agent operates on.
///
/// - Environment: deny `GIT_*` location/object overrides — operations bind to
///   the discovered repository, mirroring the env-stripping the subprocess
///   wrapper performed. Home/XDG stay allowed so user config resolves.
/// - Config: user/system/git config allowed (identity, diff drivers), without
///   ever executing the git binary for its install-prefix config, in the scopes
///   `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM` choose for git
///   ([`ConfigScopes`]).
/// - Trust: full. This is a local dev tool operating on the user's own
///   checkout; ownership quarantine would only reject repos the user already
///   chose to work in.
fn open_options() -> Result<Options> {
	Ok(ConfigScopes::from_env(
		std::env::var_os("GIT_CONFIG_GLOBAL"),
		std::env::var_os("GIT_CONFIG_NOSYSTEM"),
	)?
	.apply(base_options(), || gix::config::Source::System.storage_location(&mut |_| None)))
}

/// [`open_options`] before the configuration scopes are chosen.
fn base_options() -> Options {
	Options::default()
		.permissions(Permissions {
			env:        permissions::Environment {
				xdg_config_home: Permission::Allow,
				home:            Permission::Allow,
				http_transport:  Permission::Deny,
				identity:        Permission::Allow,
				objects:         Permission::Deny,
				git_prefix:      Permission::Deny,
				other:           Permission::Allow,
				ssh_prefix:      Permission::Deny,
			},
			config:     permissions::Config::all(),
			attributes: permissions::Attributes::all(),
		})
		.with(Trust::Full)
}

/// The global and system configuration files git reads, as `git(1)` documents
/// them:
///
/// > GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: Take the configuration from the
/// > given files instead from global or system-level configuration files. If
/// > GIT_CONFIG_SYSTEM is set, the system config file defined at build time
/// > (usually /etc/gitconfig) will not be read. Likewise, if GIT_CONFIG_GLOBAL
/// > is set, neither $HOME/.gitconfig nor $XDG_CONFIG_HOME/git/config will be
/// > read. Can be set to /dev/null to skip reading configuration files of the
/// > respective level.
/// >
/// > GIT_CONFIG_NOSYSTEM: Whether to skip reading settings from the
/// > system-wide $(prefix)/etc/gitconfig file. This Boolean environment
/// > variable can be used along with $HOME and $XDG_CONFIG_HOME to create a
/// > predictable environment for a picky script […]
///
/// An empty `GIT_CONFIG_GLOBAL` names no file, so git 2.43 reads no global
/// configuration; a `GIT_CONFIG_NOSYSTEM` that is not a boolean is refused, as
/// git refuses it ([`git_env_bool`]). gix reads these variables only together
/// with every other `GIT_*` override, which [`open_options`] denies, so they
/// are applied here. `GIT_CONFIG_SYSTEM` is not.
#[derive(Debug, PartialEq, Eq)]
struct ConfigScopes {
	/// The system file is read: `GIT_CONFIG_NOSYSTEM` is unset or false.
	system: bool,
	/// The global scope `GIT_CONFIG_GLOBAL` chooses.
	global: GlobalConfig,
}

/// The global configuration git reads, as `GIT_CONFIG_GLOBAL` chooses it.
#[derive(Debug, PartialEq, Eq)]
enum GlobalConfig {
	/// Unset: `$XDG_CONFIG_HOME/git/config` and `~/.gitconfig`.
	Home,
	/// Set to an empty value, which names no file: no global configuration.
	Skipped,
	/// Set: the one file it names, in place of the home files.
	File(PathBuf),
}

impl ConfigScopes {
	fn from_env(global: Option<OsString>, nosystem: Option<OsString>) -> Result<Self> {
		let nosystem = match nosystem {
			Some(value) => git_env_bool("GIT_CONFIG_NOSYSTEM", &value)?,
			None => false,
		};
		let global = match global {
			None => GlobalConfig::Home,
			Some(path) if path.is_empty() => GlobalConfig::Skipped,
			Some(path) => GlobalConfig::File(PathBuf::from(path)),
		};
		Ok(Self { system: !nosystem, global })
	}

	/// `options` reading these scopes; `system_file` finds the system file git
	/// reads (`/etc/gitconfig` on unix), asked only when it is read.
	fn apply(self, mut options: Options, system_file: impl FnOnce() -> Option<PathBuf>) -> Options {
		let system_file = if self.system { system_file() } else { None };
		let config = &mut options.permissions.config;
		config.system = system_file.is_some();
		let global_file = match self.global {
			GlobalConfig::Home => None,
			GlobalConfig::Skipped => {
				config.git = false;
				config.user = false;
				None
			},
			GlobalConfig::File(path) => {
				config.git = false;
				config.user = false;
				Some(path)
			},
		};
		match (global_file, system_file) {
			// gix takes no path for the global scope, so the file goes in the
			// system slot, which gix loads after its installation slot and before
			// the repository's own configuration, and the system file, when read,
			// in the installation slot: the order git reads them in. An explicit
			// path loads without running the git binary.
			(Some(global_file), system_file) => {
				config.system = true;
				if let Some(system_file) = system_file {
					config.git_binary = true;
					options = options.git_installation_config_path(system_file);
				}
				options.system_config_path(global_file)
			},
			(None, Some(system_file)) => options.system_config_path(system_file),
			(None, None) => options,
		}
	}
}

/// The boolean value of the environment variable `name`, as git 2.43's
/// `git_env_bool` (parse.c) reads it through `git_parse_maybe_bool`: `true`,
/// `yes` and `on` are true and `false`, `no`, `off` and the empty string false,
/// in any case; anything else is a C `int` as `git_parse_int` reads it,
/// true when nonzero. A value that is neither is refused with git's message,
/// as git refuses it with `die()`.
fn git_env_bool(name: &str, value: &OsStr) -> Result<bool> {
	let text = value.to_str();
	let parsed = text.and_then(|text| match text.to_ascii_lowercase().as_str() {
		"true" | "yes" | "on" => Some(true),
		"false" | "no" | "off" | "" => Some(false),
		_ => git_parse_int(text).map(|number| number != 0),
	});
	parsed.ok_or_else(|| {
		Error::backend(
			"git open",
			format!("bad boolean environment value '{}' for '{name}'", value.to_string_lossy()),
		)
	})
}

/// git's `git_parse_int` (parse.c, `git_parse_signed` with the `int` bounds):
/// `strtoimax(value, &end, 0)`, which skips leading white space and takes an
/// optional sign and a `0x` (hexadecimal) or `0` (octal) prefix, then a unit
/// of `k`, `m` or `g` in either case (1024, 1024², 1024³) and nothing else.
/// The scaled number must lie within `-INT_MAX..=INT_MAX`.
fn git_parse_int(value: &str) -> Option<i64> {
	let unsigned = value.trim_start_matches([' ', '\t', '\n', '\u{b}', '\u{c}', '\r']);
	let (negative, unsigned) = match unsigned.as_bytes().first() {
		Some(b'-') => (true, &unsigned[1..]),
		Some(b'+') => (false, &unsigned[1..]),
		_ => (false, unsigned),
	};
	let bytes = unsigned.as_bytes();
	let hex = bytes.len() > 2
		&& bytes[0] == b'0'
		&& matches!(bytes[1], b'x' | b'X')
		&& bytes[2].is_ascii_hexdigit();
	let (radix, digits) = if hex {
		(16, &unsigned[2..])
	} else if bytes.first() == Some(&b'0') {
		(8, unsigned)
	} else {
		(10, unsigned)
	};
	let digits_len = digits
		.bytes()
		.take_while(|byte| char::from(*byte).is_digit(radix))
		.count();
	if digits_len == 0 {
		return None;
	}
	let magnitude = i64::from_str_radix(&digits[..digits_len], radix).ok()?;
	let number = if negative { -magnitude } else { magnitude };
	let factor: i64 = match &digits[digits_len..] {
		"" => 1,
		"k" | "K" => 1 << 10,
		"m" | "M" => 1 << 20,
		"g" | "G" => 1 << 30,
		_ => return None,
	};
	let max = i64::from(i32::MAX);
	if (number < 0 && -max / factor > number) || (number > 0 && max / factor < number) {
		return None;
	}
	Some(number * factor)
}

#[cfg(test)]
mod tests {
	use std::{collections::BTreeSet, ffi::OsString, fs, path::PathBuf, process::Command};

	use super::{ConfigScopes, GlobalConfig, base_options, git_env_bool, permissions};

	#[test]
	fn config_scopes_read_the_variables_as_git_does() {
		let scopes = |global: Option<&str>, nosystem: Option<&str>| {
			ConfigScopes::from_env(global.map(OsString::from), nosystem.map(OsString::from)).unwrap()
		};
		assert_eq!(scopes(None, None), ConfigScopes { system: true, global: GlobalConfig::Home });
		assert_eq!(scopes(Some("/global"), None), ConfigScopes {
			system: true,
			global: GlobalConfig::File("/global".into()),
		});
		assert_eq!(scopes(Some(""), None), ConfigScopes {
			system: true,
			global: GlobalConfig::Skipped,
		});
		assert!(!scopes(None, Some("1")).system);
		assert!(scopes(None, Some("0")).system);
		let refused = ConfigScopes::from_env(None, Some("maybe".into())).unwrap_err();
		assert!(matches!(refused, crate::Error::Backend { .. }), "{refused:?}");
		assert_eq!(
			refused.to_string(),
			"git open: bad boolean environment value 'maybe' for 'GIT_CONFIG_NOSYSTEM'"
		);
	}

	/// Values of each class `git_parse_maybe_bool` tells apart, with the
	/// answer: `Some(bool)`, or `None` where git refuses the value.
	const NOSYSTEM_CASES: &[(&str, Option<bool>)] = &[
		// The text forms, in any case.
		("true", Some(true)),
		("YES", Some(true)),
		("On", Some(true)),
		("false", Some(false)),
		("No", Some(false)),
		("OFF", Some(false)),
		("", Some(false)),
		// Integers: nonzero is true, with strtoimax's prefixes and git's units.
		("1", Some(true)),
		("0", Some(false)),
		("2", Some(true)),
		("-1", Some(true)),
		("+1", Some(true)),
		(" 1", Some(true)),
		("0x10", Some(true)),
		("0x0", Some(false)),
		("010", Some(true)),
		("1k", Some(true)),
		("1G", Some(true)),
		("0k", Some(false)),
		("2147483647", Some(true)),
		("-2147483647", Some(true)),
		// Refused: no boolean and no integer, or an integer outside `int`.
		("maybe", None),
		("1 ", None),
		(" yes", None),
		("0x", None),
		("08", None),
		("1x", None),
		("2g", None),
		("2147483648", None),
		("-2147483648", None),
		("99999999999999999999", None),
	];

	#[test]
	fn git_env_bool_reads_each_class_as_git_does() {
		for &(value, expected) in NOSYSTEM_CASES {
			let parsed = git_env_bool("GIT_CONFIG_NOSYSTEM", value.as_ref());
			match expected {
				Some(expected) => {
					assert_eq!(parsed.ok(), Some(expected), "GIT_CONFIG_NOSYSTEM={value:?}");
				},
				None => assert_eq!(
					parsed.map_err(|error| error.to_string()),
					Err(format!(
						"git open: bad boolean environment value '{value}' for 'GIT_CONFIG_NOSYSTEM'"
					)),
					"GIT_CONFIG_NOSYSTEM={value:?}"
				),
			}
		}
	}

	/// The same values given to the git binary: a refused value fails with
	/// git's message, and a system file is read exactly when the value is false.
	///
	/// The message's wording is the binary's own (git 2.43 says "bad boolean
	/// environment value", git 2.39 "bad boolean config value"), so it is read
	/// from the git this test runs: its refusal of `PROBE`, a value both sides
	/// refuse, gives the text around the value, and every other refused value
	/// must give that text with itself in its place.
	#[test]
	fn git_env_bool_matches_the_git_binary() {
		const PROBE: &str = "maybe";
		let temp = tempfile::tempdir().unwrap();
		let system = temp.path().join("system-gitconfig");
		fs::write(&system, "[probe]\n\tsystem = read\n").unwrap();
		let run = |value: &str| {
			Command::new("git")
				.args(["config", "--list"])
				.current_dir(temp.path())
				.env("GIT_CONFIG_GLOBAL", "/dev/null")
				.env("GIT_CONFIG_SYSTEM", &system)
				.env("GIT_CONFIG_NOSYSTEM", value)
				.env_remove("GIT_CONFIG_COUNT")
				.env_remove("GIT_CONFIG_PARAMETERS")
				.output()
				.unwrap()
		};

		assert!(NOSYSTEM_CASES.contains(&(PROBE, None)), "the probe is a value git_env_bool refuses");
		let probe = run(PROBE);
		assert!(!probe.status.success(), "git accepted GIT_CONFIG_NOSYSTEM={PROBE:?}");
		let probe_stderr = String::from_utf8_lossy(&probe.stderr).into_owned();
		let quoted_probe = format!("'{PROBE}'");
		let (before, after) = probe_stderr
			.split_once(&quoted_probe)
			.unwrap_or_else(|| panic!("git's refusal does not name the value: {probe_stderr}"));
		assert!(
			after.contains("GIT_CONFIG_NOSYSTEM"),
			"git's refusal does not name the variable: {probe_stderr}"
		);

		for &(value, expected) in NOSYSTEM_CASES {
			let output = run(value);
			let stdout = String::from_utf8_lossy(&output.stdout);
			let git = if output.status.success() {
				Some(!stdout.contains("probe.system=read"))
			} else {
				assert_eq!(
					String::from_utf8_lossy(&output.stderr),
					format!("{before}'{value}'{after}"),
					"GIT_CONFIG_NOSYSTEM={value:?}"
				);
				None
			};
			assert_eq!(git, expected, "GIT_CONFIG_NOSYSTEM={value:?}");
		}
	}

	#[test]
	fn unset_global_keeps_every_scope_but_the_system_file_nosystem_skips() {
		let read = |scopes: ConfigScopes| {
			let system = scopes.system;
			scopes
				.apply(base_options(), move || {
					assert!(system, "the system file is not asked for under GIT_CONFIG_NOSYSTEM");
					Some("/system-gitconfig".into())
				})
				.permissions
				.config
		};
		assert_eq!(
			read(ConfigScopes { system: true, global: GlobalConfig::Home }),
			permissions::Config::all()
		);
		assert_eq!(
			read(ConfigScopes { system: false, global: GlobalConfig::Home }),
			permissions::Config { system: false, ..permissions::Config::all() }
		);
	}

	/// A set `GIT_CONFIG_GLOBAL`, empty or naming a file, turns off the home
	/// files (`git` and `user`) whatever the test's own home holds: the
	/// read tests below pass on a home with no git configuration either way.
	#[test]
	fn set_global_drops_the_home_scopes() {
		let read = |global: GlobalConfig| {
			ConfigScopes { system: true, global }
				.apply(base_options(), || Some("/system-gitconfig".into()))
				.permissions
				.config
		};
		let without_home =
			permissions::Config { git: false, user: false, ..permissions::Config::all() };
		assert_eq!(read(GlobalConfig::Skipped), without_home);
		// The global file takes the system slot, so the system file moves to the
		// installation slot, which gix reads with `git_binary`.
		assert_eq!(read(GlobalConfig::File("/global-gitconfig".into())), permissions::Config {
			git_binary: true,
			..without_home
		});
	}

	/// A repository whose own configuration names the email, beside a system
	/// file and a `GIT_CONFIG_GLOBAL` file that each name a user, and what gix
	/// read under `scopes`: `user.name`, `user.email`, `system.only` and the
	/// files the values came from.
	fn read_scopes(
		scopes: ConfigScopes,
		global: Option<&str>,
	) -> (Vec<Option<String>>, BTreeSet<PathBuf>) {
		let temp = tempfile::tempdir().expect("tempdir");
		let root = fs::canonicalize(temp.path()).expect("canonical tempdir");
		let system = root.join("system-gitconfig");
		fs::write(
			&system,
			"[user]\n\tname = System\n\temail = system@example.com\n[system]\n\tonly = yes\n",
		)
		.expect("write system file");
		fs::write(
			root.join("global-gitconfig"),
			"[user]\n\tname = Global\n\temail = global@example.com\n",
		)
		.expect("write global file");
		let repo = root.join("repo");
		let init = Command::new("git")
			.args(["init", "-q"])
			.arg(&repo)
			.env("GIT_CONFIG_GLOBAL", "/dev/null")
			.env("GIT_CONFIG_NOSYSTEM", "1")
			.output()
			.expect("run git init");
		assert!(init.status.success(), "git init: {}", String::from_utf8_lossy(&init.stderr));
		let local = repo.join(".git/config");
		let mut config = fs::read_to_string(&local).expect("read local config");
		config.push_str("[user]\n\temail = local@example.com\n");
		fs::write(&local, config).expect("write local config");

		let scopes = match global {
			Some(name) => ConfigScopes { global: GlobalConfig::File(root.join(name)), ..scopes },
			None => scopes,
		};
		let repo = scopes
			.apply(base_options(), || Some(system.clone()))
			.open(repo.join(".git"))
			.expect("open")
			.to_thread_local();
		let snapshot = repo.config_snapshot();
		let values = ["user.name", "user.email", "system.only"]
			.map(|key| snapshot.string(key).map(|value| value.to_string()))
			.to_vec();
		// Values the environment adds (an omp session's `GIT_CONFIG_COUNT`
		// include) are no file scope of git's.
		let files = snapshot
			.plumbing()
			.sections()
			.filter(|section| section.meta().source.kind() != gix::config::source::Kind::Override)
			.filter_map(|section| section.meta().path.clone())
			.map(|path| path.strip_prefix(&root).map(PathBuf::from).unwrap_or(path))
			.collect();
		(values, files)
	}

	fn files(names: &[&str]) -> BTreeSet<PathBuf> {
		names.iter().map(PathBuf::from).collect()
	}

	#[test]
	fn global_file_replaces_the_home_files_between_system_and_repository() {
		let set = ConfigScopes { system: true, global: GlobalConfig::Home };
		let (values, read) = read_scopes(set, Some("global-gitconfig"));
		// The global file outranks the system file, and the repository both.
		assert_eq!(values, [
			Some("Global".into()),
			Some("local@example.com".into()),
			Some("yes".into())
		]);
		assert_eq!(read, files(&["system-gitconfig", "global-gitconfig", "repo/.git/config"]));
	}

	#[test]
	fn nosystem_skips_the_system_file_beside_a_global_file() {
		let set = ConfigScopes { system: false, global: GlobalConfig::Home };
		let (values, read) = read_scopes(set, Some("global-gitconfig"));
		assert_eq!(values, [Some("Global".into()), Some("local@example.com".into()), None]);
		assert_eq!(read, files(&["global-gitconfig", "repo/.git/config"]));
	}

	#[test]
	fn empty_global_reads_no_global_file() {
		let (values, read) =
			read_scopes(ConfigScopes { system: true, global: GlobalConfig::Skipped }, None);
		assert_eq!(values, [
			Some("System".into()),
			Some("local@example.com".into()),
			Some("yes".into())
		]);
		assert_eq!(read, files(&["system-gitconfig", "repo/.git/config"]));

		let (values, read) =
			read_scopes(ConfigScopes { system: false, global: GlobalConfig::Skipped }, None);
		assert_eq!(values, [None, Some("local@example.com".into()), None]);
		assert_eq!(read, files(&["repo/.git/config"]));
	}
}
