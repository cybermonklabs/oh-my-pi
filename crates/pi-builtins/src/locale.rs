//! The shell's locale, as the utility builtins see it.
//!
//! Locale categories are read per invocation from the *shell's* environment
//! (`LC_ALL`, then the category, then `LANG`): uucore's i18n getters read the
//! host process environment once and cache it, which would ignore
//! `LC_ALL=C sort` at the prompt. Nothing here calls `setlocale`, which would
//! change the C locale of the whole host process.
//!
//! Used by `sort` and `comm` (collation), `sort` (numerics), `uniq`, `date`,
//! `du`, `df`, `env`, and `fold`.

#![allow(dead_code, reason = "each utility uses a subset")]

use std::sync::{Arc, LazyLock};

use foldhash::HashMap;
use icu_collator::{
	CollatorBorrowed,
	options::{AlternateHandling, CollatorOptions, Strength},
};
use icu_decimal::provider::{Baked, DecimalSymbolsV1};
use icu_locale_core::Locale;
use icu_provider::{DataIdentifierBorrowed, DataLocale, DataProvider, DataRequest};
use parking_lot::Mutex;

use crate::host::Host;

/// The shell's value for locale category `category` (`"LC_CTYPE"`, …):
/// `LC_ALL`, then the category, then `LANG`, with empty values treated as
/// unset (POSIX). `None` means the C locale.
pub(crate) fn shell_locale<'h>(host: &'h Host, category: &str) -> Option<&'h str> {
	["LC_ALL", category, "LANG"]
		.into_iter()
		.find_map(|key| host.var(key).filter(|value| !value.is_empty()))
}

/// Whether a `language_TERRITORY[.codeset][@modifier]` name has a UTF-8
/// codeset (`C.UTF-8` included).
pub(crate) fn codeset_is_utf8(name: &str) -> bool {
	name.split(['.', '@']).nth(1).is_some_and(|codeset| {
		codeset.eq_ignore_ascii_case("utf-8") || codeset.eq_ignore_ascii_case("utf8")
	})
}

/// Whether the shell's `LC_CTYPE` is a UTF-8 locale the system can load: the
/// multibyte character rules GNU utilities switch on after `setlocale`.
pub(crate) fn ctype_is_utf8(host: &Host) -> bool {
	ctype_is_utf8_in(|key| host.var(key))
}

/// [`ctype_is_utf8`] for the environment `var` reads (`LC_ALL`, `LC_CTYPE`,
/// `LANG`).
fn ctype_is_utf8_in<'v>(var: impl Fn(&str) -> Option<&'v str>) -> bool {
	let Some(name) = ["LC_ALL", "LC_CTYPE", "LANG"]
		.into_iter()
		.find_map(|key| var(key).filter(|value| !value.is_empty()))
	else {
		return false;
	};
	#[cfg(unix)]
	if !locale_loadable(name, libc::LC_CTYPE_MASK) {
		return false;
	}
	codeset_is_utf8(name)
}

/// `name` quoted for a diagnostic as GNU's `quote` (quotearg's
/// `locale_quoting_style`) quotes it in the locale `var` reads (`LC_ALL`,
/// `LC_CTYPE`, `LANG`), as coreutils' `env` and `timeout` and findutils'
/// `find` print a command they could not run: `‘name’` in a UTF-8 locale
/// the system can load, `'name'` otherwise (the C locale, where a `'` in the
/// name is `\'`). A backslash is `\\`; a character that is not printable in
/// the locale is a C escape (`\t`, `\n`, …) or the octal escapes of its
/// bytes (`\303\251` for `é` in the C locale).
pub fn gnu_quote<'v>(var: impl Fn(&str) -> Option<&'v str>, name: &str) -> String {
	let utf8 = ctype_is_utf8_in(var);
	let (open, close) = if utf8 { ('‘', '’') } else { ('\'', '\'') };
	let mut out = String::with_capacity(name.len() + 2);
	out.push(open);
	for c in name.chars() {
		match c {
			'\\' => out.push_str("\\\\"),
			'\'' if !utf8 => out.push_str("\\'"),
			c if printable(c, utf8) => out.push(c),
			c => escape(&mut out, c),
		}
	}
	out.push(close);
	out
}

/// `name` quoted as GNU's `quoteaf` (quotearg's
/// `shell_escape_always_quoting_style`) quotes it in the locale `var`
/// reads, as coreutils' `nohup` prints a command it could not run: a word
/// a shell reads back as `name`. `'name'`, with a `'` as `'\''` and a
/// character not printable in the locale as `$'\t'`, `$'\303\251'`, …;
/// but `"name"` for a name holding a `'` whose characters are all safe in
/// both C and shell double quotes (`"it's"`).
pub fn gnu_quote_shell<'v>(var: impl Fn(&str) -> Option<&'v str>, name: &str) -> String {
	let utf8 = ctype_is_utf8_in(var);
	let safe = |c: char| {
		c.is_ascii_alphanumeric() || "%+,-./:]_@'".contains(c) || (!c.is_ascii() && printable(c, utf8))
	};
	if name.contains('\'') && name.chars().all(safe) {
		return format!("\"{name}\"");
	}
	let mut out = String::with_capacity(name.len() + 2);
	out.push('\'');
	// Inside a `$'…'` of escapes, closed (and the quotes reopened) at the
	// next printable character.
	let mut escaping = false;
	for c in name.chars() {
		if printable(c, utf8) {
			if escaping {
				out.push_str("''");
				escaping = false;
			}
			if c == '\'' {
				out.push_str("'\\''");
			} else {
				out.push(c);
			}
		} else {
			if !escaping {
				out.push_str("'$'");
				escaping = true;
			}
			escape(&mut out, c);
		}
	}
	out.push('\'');
	out
}

/// Whether quotearg prints `c` as itself: printable ASCII, or in a UTF-8
/// locale any character but a control.
fn printable(c: char, utf8: bool) -> bool {
	if c.is_ascii() {
		(' '..='~').contains(&c)
	} else {
		utf8 && !c.is_control()
	}
}

/// quotearg's backslash escape of the unprintable `c`: a C escape, else the
/// octal escape of each of its bytes.
fn escape(out: &mut String, c: char) {
	use std::fmt::Write as _;
	let letter = match c {
		'\x07' => Some('a'),
		'\x08' => Some('b'),
		'\x0c' => Some('f'),
		'\n' => Some('n'),
		'\r' => Some('r'),
		'\t' => Some('t'),
		'\x0b' => Some('v'),
		_ => None,
	};
	if let Some(letter) = letter {
		out.push('\\');
		out.push(letter);
		return;
	}
	let mut bytes = [0; 4];
	for byte in c.encode_utf8(&mut bytes).bytes() {
		let _ = write!(out, "\\{byte:03o}");
	}
}

/// Parses a locale name the way uucore parses the process one:
/// `language_TERRITORY[.codeset][@modifier]` becomes a BCP 47 locale plus
/// whether the codeset is UTF-8. `None` means the C locale: C/POSIX, or a name
/// ICU cannot read.
pub(crate) fn parse_locale_name(name: &str) -> Option<(Locale, bool)> {
	let language = name
		.split(['.', '@'])
		.next()
		.filter(|language| !matches!(*language, "C" | "POSIX"))?;
	let locale = Locale::try_from_str(&language.replace('_', "-"))
		.ok()
		.filter(|locale| *locale != Locale::UNKNOWN)?;
	Some((locale, codeset_is_utf8(name)))
}

/// Collators built so far, by locale. Building one resolves the locale's
/// tailoring through ICU's fallback chain, which repeated calls skip. `None`
/// records a locale ICU could not build a collator for.
static COLLATORS: LazyLock<Mutex<HashMap<Locale, Option<Arc<CollatorBorrowed<'static>>>>>> =
	LazyLock::new(Default::default);

/// The collator for the shell's `LC_COLLATE`, or `None` to compare text by
/// bytes: the locale must be UTF-8 (uucore's rule) and loadable by the system
/// (GNU falls back to byte order otherwise). `sort` orders lines with it and
/// `comm` merges with it, so `sort | comm` agree in every locale.
pub(crate) fn shell_collator(host: &Host) -> Option<Arc<CollatorBorrowed<'static>>> {
	let (locale, utf8) = parse_locale_name(shell_locale(host, "LC_COLLATE")?)?;
	if !utf8 || collation_locale_failed(host) {
		return None;
	}
	COLLATORS
		.lock()
		.entry(locale)
		.or_insert_with_key(|locale| {
			// Shift punctuation behind letters, but retain its quaternary
			// distinctions for `-u` and `-c` instead of treating paths as equal.
			let mut options = CollatorOptions::default();
			options.alternate_handling = Some(AlternateHandling::Shifted);
			options.strength = Some(Strength::Quaternary);
			CollatorBorrowed::try_new(locale.into(), options)
				.ok()
				.map(Arc::new)
		})
		.clone()
}

/// Whether the shell names an `LC_COLLATE` locale the system cannot load:
/// GNU's "failed to set locale", after which text compares by bytes.
#[cfg(unix)]
pub(crate) fn collation_locale_failed(host: &Host) -> bool {
	shell_locale(host, "LC_COLLATE")
		.is_some_and(|locale| !locale_loadable(locale, libc::LC_COLLATE_MASK))
}

/// Windows has no system locale to load; `LC_ALL=missing` stands in for an
/// unloadable one.
#[cfg(not(unix))]
pub(crate) fn collation_locale_failed(host: &Host) -> bool {
	host.var("LC_ALL") == Some("missing")
}

/// Whether the system can load `locale` for the categories in `mask`, probed
/// with `newlocale` rather than `setlocale`, which would change the C locale
/// of the whole host process.
#[cfg(unix)]
pub(crate) fn locale_loadable(locale: &str, mask: libc::c_int) -> bool {
	let Ok(locale) = std::ffi::CString::new(locale) else {
		return false;
	};
	// SAFETY: `locale` is a valid NUL-terminated string; a non-null result is
	// a fresh locale object owned here and freed immediately.
	unsafe {
		let handle = libc::newlocale(mask, locale.as_ptr(), std::ptr::null_mut());
		if handle.is_null() {
			return false;
		}
		libc::freelocale(handle);
	}
	true
}

/// Single-byte decimal point and thousands separator of a numeric locale.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct NumericSymbols {
	pub decimal_point: u8,
	/// `None` when the locale groups digits with no separator or with a
	/// multibyte one (GNU ignores those too).
	pub thousands_sep: Option<u8>,
}

impl NumericSymbols {
	/// The C locale: `.` and no grouping.
	pub const C: Self = Self { decimal_point: b'.', thousands_sep: None };
}

/// Decimal point and thousands separator for the shell's `LC_NUMERIC`, from
/// ICU's CLDR data for that locale (the data uucore reads for the process
/// locale). C rules apply when it names C, or on Unix a locale the system
/// cannot load (GNU's fallback); Windows has no system locale to probe, so any
/// locale ICU parses uses its CLDR rules.
pub(crate) fn numeric_symbols(host: &Host) -> NumericSymbols {
	let Some(name) = shell_locale(host, "LC_NUMERIC") else {
		return NumericSymbols::C;
	};
	let Some((locale, utf8)) = parse_locale_name(name) else {
		return NumericSymbols::C;
	};
	#[cfg(unix)]
	if !locale_loadable(name, libc::LC_NUMERIC_MASK) {
		return NumericSymbols::C;
	}
	let data_locale = DataLocale::from(&locale);
	let request = DataRequest {
		id:       DataIdentifierBorrowed::for_locale(&data_locale),
		metadata: Default::default(),
	};
	let Ok(response) = DataProvider::<DecimalSymbolsV1>::load(&Baked, request) else {
		return NumericSymbols::C;
	};
	let symbols = response.payload.get();
	NumericSymbols {
		decimal_point: match symbols.decimal_separator().as_bytes().first() {
			Some(b',') => b',',
			_ => b'.',
		},
		// Upstream GNU coreutils ignore multibyte thousands separators
		// (FIXME in C source). We keep the same single-byte behavior.
		thousands_sep: match symbols.grouping_separator().as_bytes() {
			[b] => Some(*b),
			// ICU returns NBSP as UTF-8 (0xC2 0xA0). In non-UTF8 locales like
			// ISO-8859-1, the input byte is 0xA0, so map it to a single byte.
			[0xc2, 0xa0] if !utf8 => Some(0xa0),
			_ => None,
		},
	}
}

#[cfg(all(test, unix))]
mod tests {
	use super::{gnu_quote, gnu_quote_shell};

	/// `quote` and `quoteaf` as coreutils 9.4 prints a command it could not
	/// run, measured with `/usr/bin/timeout 5 NAME` and `/usr/bin/nohup NAME`
	/// in the C and C.UTF-8 locales: for each name, the C `quote`, the UTF-8
	/// `quote`, and `quoteaf` in C and in UTF-8.
	#[test]
	fn names_are_quoted_as_coreutils_quotes_them() {
		let cases = [
			("plain", "'plain'", "‘plain’", "'plain'", "'plain'"),
			("it's", "'it\\'s'", "‘it's’", "\"it's\"", "\"it's\""),
			("it's\"q", "'it\\'s\"q'", "‘it's\"q’", "'it'\\''s\"q'", "'it'\\''s\"q'"),
			("a b", "'a b'", "‘a b’", "'a b'", "'a b'"),
			("dq\"x", "'dq\"x'", "‘dq\"x’", "'dq\"x'", "'dq\"x'"),
			("d$x", "'d$x'", "‘d$x’", "'d$x'", "'d$x'"),
			("b\\s", "'b\\\\s'", "‘b\\\\s’", "'b\\s'", "'b\\s'"),
			("t\tab", "'t\\tab'", "‘t\\tab’", "'t'$'\\t''ab'", "'t'$'\\t''ab'"),
			("n\nl", "'n\\nl'", "‘n\\nl’", "'n'$'\\n''l'", "'n'$'\\n''l'"),
			("é", "'\\303\\251'", "‘é’", "''$'\\303\\251'", "'é'"),
		];
		let c = |key: &str| (key == "LC_ALL").then_some("C");
		let utf8 = |key: &str| (key == "LC_ALL").then_some("C.UTF-8");
		for (name, quote_c, quote_utf8, shell_c, shell_utf8) in cases {
			let got = (gnu_quote(c, name), gnu_quote(utf8, name), gnu_quote_shell(c, name), gnu_quote_shell(utf8, name));
			let want = (quote_c.to_owned(), quote_utf8.to_owned(), shell_c.to_owned(), shell_utf8.to_owned());
			assert_eq!(got, want, "{name:?}");
		}
	}
}
