// Share semver with host dependencies when wasm grammars are enabled.
#[cfg(feature = "wasm")]
use semver as _;

pub mod block;
pub mod language;
pub mod ops;
pub mod parse_cache;
pub mod search;
pub mod summary;
#[cfg(test)]
mod testing;

pub use language::SupportLang;

/// A doctest planted on a scratch branch, never a release member: it
/// prints, and the gate's doctest reader must fail the job naming it.
///
/// ```
/// println!("planted: a doctest that prints");
/// ```
pub fn planted_print() {}
