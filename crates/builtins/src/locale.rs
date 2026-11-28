//! The shell's locale, as the utility builtins see it.
//!
//! Locale categories are read per invocation from the *shell's* environment
//! (`LC_ALL`, then the category, then `LANG`): uucore's i18n getters read the
//! host process environment once and cache it, which would ignore
//! `LC_ALL=C sort` at the prompt. Nothing here calls `setlocale`, which would
//! change the C locale of the whole host process.
//!
//! Used by `sort` and `comm` (collation), `sort` (numerics), `uniq`, `date`,
//! `du`, `df`, `env`, `fold`, and `column` (tree art), by `env` to quote the
//! name of a command it cannot run, as GNU's `env` writes it, and by the
//! shell's `timeout` and `nohup` to quote such a name as GNU's do.

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
	locale_in(|key| host.var(key), category)
}

/// [`shell_locale`] for the environment whose variables `var` reads.
fn locale_in<'v>(var: impl Fn(&str) -> Option<&'v str>, category: &str) -> Option<&'v str> {
	["LC_ALL", category, "LANG"]
		.into_iter()
		.find_map(|key| var(key).filter(|value| !value.is_empty()))
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

/// [`ctype_is_utf8`] for the environment whose variables `var` reads: the
/// locale a GNU utility started with that environment quotes names in.
pub fn ctype_is_utf8_in<'v>(var: impl Fn(&str) -> Option<&'v str>) -> bool {
	let Some(name) = locale_in(var, "LC_CTYPE") else {
		return false;
	};
	#[cfg(unix)]
	if !locale_loadable(name, libc::LC_CTYPE_MASK) {
		return false;
	}
	codeset_is_utf8(name)
}

/// `name` in quotes, as GNU's `env` and `timeout` name a command they cannot
/// run: `‘…’` in a UTF-8 locale (`utf8`) and `'…'` in C. Inside the quotes a
/// backslash and the closing quote take a backslash before them, and what
/// the locale cannot print takes [`push_escaped`]'s escapes: in C each byte
/// outside printable ASCII, in UTF-8 each byte of an invalid sequence and
/// each character [`printable`] refuses.
pub fn gnu_quote_bytes(utf8: bool, name: &[u8]) -> String {
	let (open, close) = if utf8 { ('\u{2018}', '\u{2019}') } else { ('\'', '\'') };
	let mut out = String::with_capacity(name.len() + 2 * close.len_utf8());
	out.push(open);
	for_each_unit(name, utf8, |unit| match unit {
		Ok(c) if c == '\\' || c == close => {
			out.push('\\');
			out.push(c);
		},
		Ok(c) if printable(c) => out.push(c),
		Ok(c) => push_escaped(&mut out, c),
		Err(byte) => push_octal(&mut out, byte),
	});
	out.push(close);
	out
}

/// `name` as GNU's `nohup` names a program it cannot run: a word a POSIX
/// shell reads back as the same bytes, in any locale between ASCII quotes.
/// It goes between single quotes, a `'` in it is written `'\''`, and each run
/// of what the locale cannot print is written as `$'…'` between them, with
/// [`push_escaped`]'s escapes: `'a'$'\n''b'`, `''$'\377'`. A name that holds
/// a `'` and only printable characters, none of which
/// [`keeps_single_quotes`], goes between double quotes instead: `"it's"`.
pub fn gnu_quote_shell_bytes(utf8: bool, name: &[u8]) -> String {
	if name.contains(&b'\'')
		&& let Ok(text) = std::str::from_utf8(name)
		&& (utf8 || text.is_ascii())
		&& text.char_indices().all(|(at, c)| printable(c) && !keeps_single_quotes(at, c))
	{
		return format!("\"{text}\"");
	}
	let mut out = String::with_capacity(name.len() + 2);
	out.push('\'');
	// Whether `out` ends inside a `$'…'` run.
	let mut escaping = false;
	for_each_unit(name, utf8, |unit| match unit {
		Ok('\'') => {
			out.push_str("'\\''");
			escaping = false;
		},
		Ok(c) if printable(c) => {
			if escaping {
				out.push_str("''");
				escaping = false;
			}
			out.push(c);
		},
		_ => {
			if !escaping {
				out.push_str("'$'");
				escaping = true;
			}
			match unit {
				Ok(c) => push_escaped(&mut out, c),
				Err(byte) => push_octal(&mut out, byte),
			}
		},
	});
	out.push('\'');
	out
}

/// Whether `c`, at byte `at` of a name holding a `'`, keeps the name out of
/// double quotes in GNU's shell quoting. Measured over every name of up to
/// three printable ASCII characters: these 21 characters do, `#` and `~`
/// only after the first character.
fn keeps_single_quotes(at: usize, c: char) -> bool {
	match c {
		'#' | '~' => at > 0,
		'!' | '"' | '$' | '&' | '(' | ')' | '*' | ';' | '<' | '=' | '>' | '?' | '[' | '\\' | '^'
		| '`' | '{' | '|' | '}' => true,
		_ => false,
	}
}

/// Calls `f` with each unit of `name` as the locale reads it: `Ok` with a
/// character, or `Err` with a byte that is not part of one (in C each byte
/// outside ASCII, in UTF-8 each byte of an invalid sequence).
fn for_each_unit(name: &[u8], utf8: bool, mut f: impl FnMut(Result<char, u8>)) {
	if utf8 {
		for chunk in name.utf8_chunks() {
			chunk.valid().chars().for_each(|c| f(Ok(c)));
			chunk.invalid().iter().for_each(|&byte| f(Err(byte)));
		}
	} else {
		for &byte in name {
			f(if byte.is_ascii() { Ok(char::from(byte)) } else { Err(byte) });
		}
	}
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

/// Appends the escape of a character the locale cannot print: its C letter
/// escape (`\a \b \t \n \v \f \r`), or else `\` and three octal digits for
/// each of its UTF-8 bytes.
fn push_escaped(out: &mut String, c: char) {
	let letter = match c {
		'\x07' => 'a',
		'\x08' => 'b',
		'\t' => 't',
		'\n' => 'n',
		'\x0b' => 'v',
		'\x0c' => 'f',
		'\r' => 'r',
		_ => {
			for &byte in c.encode_utf8(&mut [0; 4]).as_bytes() {
				push_octal(out, byte);
			}
			return;
		},
	};
	out.push('\\');
	out.push(letter);
}

/// Appends `byte` as `\` and three octal digits.
fn push_octal(out: &mut String, byte: u8) {
	let _ = write!(out, "\\{byte:03o}");
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
