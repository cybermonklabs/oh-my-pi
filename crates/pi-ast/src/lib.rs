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

/// A doctest planted on a scratch branch, never a release member: the gate
/// runs pi-ast's cargo doctests once its source holds one.
///
/// ```
/// assert_eq!(1 + 1, 2);
/// ```
pub fn planted_doctest() {}
