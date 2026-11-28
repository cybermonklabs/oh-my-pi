//! The shell's locale, as the utility builtins see it.
//!
//! Locale categories are read per invocation from the *shell's* environment
//! (`LC_ALL`, then the category, then `LANG`): uucore's i18n getters read the
//! host process environment once and cache it, which would ignore
//! `LC_ALL=C sort` at the prompt. Nothing here calls `setlocale`, which would
//! change the C locale of the whole host process.
//!
//! Used by `sort` and `comm` (collation), `sort` (numerics), `uniq`, `date`,
//! `du`, `df`, `env`, `fold`, and `column` (tree art), and by `env` to quote
//! the name of a command it cannot run, as GNU's `env` writes it.

#![allow(dead_code, reason = "each utility uses a subset")]

use std::{
	fmt::Write as _,
	sync::{Arc, LazyLock},
};

use foldhash::HashMap;
use icu_collator::{
	CollatorBorrowed,
	options::{AlternateHandling, CollatorOptions, Strength},
};
use icu_decimal::provider::{Baked, DecimalSymbolsV1};
use icu_locale_core::Locale;
use icu_provider::{DataIdentifierBorrowed, DataLocale, DataProvider, DataRequest};
use parking_lot::Mutex;
use xutf::{GeneralCategory, Ucd};

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
	let Some(name) = shell_locale(host, "LC_CTYPE") else {
		return false;
	};
	#[cfg(unix)]
	if !locale_loadable(name, libc::LC_CTYPE_MASK) {
		return false;
	}
	codeset_is_utf8(name)
}

/// `name` in quotes, as GNU's `env` names a command it cannot run: `‘…’` in a
/// UTF-8 locale (`utf8`) and `'…'` in C. Inside the quotes a backslash and
/// the closing quote take a backslash before them, a control with a C letter
/// escape (`\a \b \t \n \v \f \r`) takes that escape, and every byte of what
/// the locale cannot print as a character becomes `\` and three octal digits:
/// in C each byte outside printable ASCII, in UTF-8 each byte of an invalid
/// sequence and of a character [`printable`] refuses.
pub(crate) fn gnu_quote_bytes(utf8: bool, name: &[u8]) -> String {
	let (open, close) = if utf8 { ('\u{2018}', '\u{2019}') } else { ('\'', '\'') };
	let mut out = String::with_capacity(name.len() + 2 * close.len_utf8());
	out.push(open);
	if utf8 {
		for chunk in name.utf8_chunks() {
			for c in chunk.valid().chars() {
				push_quoted(&mut out, c, close);
			}
			push_octal(&mut out, chunk.invalid());
		}
	} else {
		for &byte in name {
			if byte.is_ascii() {
				push_quoted(&mut out, char::from(byte), close);
			} else {
				push_octal(&mut out, &[byte]);
			}
		}
	}
	out.push(close);
	out
}

/// Appends `c` as it reads between quotes that end with `close`.
fn push_quoted(out: &mut String, c: char, close: char) {
	let escape = match c {
		'\x07' => 'a',
		'\x08' => 'b',
		'\t' => 't',
		'\n' => 'n',
		'\x0b' => 'v',
		'\x0c' => 'f',
		'\r' => 'r',
		'\\' => '\\',
		_ if c == close => close,
		_ if printable(c) => {
			out.push(c);
			return;
		},
		_ => {
			push_octal(out, c.encode_utf8(&mut [0; 4]).as_bytes());
			return;
		},
	};
	out.push('\\');
	out.push(escape);
}

/// Whether GNU's quoting writes `c` as it is: every assigned character but
/// the controls and the line and paragraph separators (U+2028, U+2029).
/// Private-use and format characters count as printable; unassigned code
/// points and noncharacters do not. Measured on every code point under
/// glibc 2.41's `C.UTF-8`, the set is exactly that of Unicode 16.0, the
/// version `xutf`'s categories follow by default.
fn printable(c: char) -> bool {
	!matches!(
		c.general_category(),
		GeneralCategory::Control
			| GeneralCategory::Surrogate
			| GeneralCategory::Unassigned
			| GeneralCategory::LineSeparator
			| GeneralCategory::ParagraphSeparator
	)
}

/// Appends each byte as `\` and three octal digits.
fn push_octal(out: &mut String, bytes: &[u8]) {
	for byte in bytes {
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
