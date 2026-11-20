//! Shared POSIX regular-expression translation.
//!
//! `grep`, `sed`, and `nl` accept POSIX basic and extended regular
//! expressions but compile them with engines that implement neither dialect
//! (`grep-regex` and PCRE2 for `grep`, `fancy-regex` for the others). This
//! module rewrites a pattern into the form those engines read with the
//! meaning GNU gives it, so the dialect is defined in exactly one place.
//!
//! Every rule here was measured against GNU grep 3.11 and GNU sed 4.9 in the
//! C and the C.UTF-8 locale; the comments name the command that shows it.

use std::{iter::Peekable, str::Chars};

/// The dialect a pattern is written in.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Dialect {
	/// POSIX basic: `\(`, `\)`, `\{`, `\}`, `\|`, `\?` and `\+` are the
	/// operators, and a repetition character with nothing to repeat is an
	/// ordinary one (`grep -c '\{'` counts the lines holding a brace).
	Basic,
	/// POSIX extended: `(`, `)`, `{`, `}`, `|`, `?` and `+` are the
	/// operators, and a repetition operator with nothing to repeat is
	/// dropped, as GNU's warning says (`grep -cE '*x'` counts the lines
	/// holding an `x`, with "warning: * at start of expression").
	Extended,
}

/// The engine a translation is compiled with.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code, reason = "each variant is used by a different utility feature")]
pub(crate) enum Target {
	/// `grep-regex` (the `regex` crate): it cannot run a back-reference, it
	/// spells the word edges `\<` and `\>` itself, and its POSIX classes hold
	/// ASCII alone.
	Rust,
	/// `grep-regex` with Unicode off, for a line that is not UTF-8, which GNU
	/// grep reads a byte to a character in the C locale: as [`Self::Rust`],
	/// with the letter classes ASCII too. The caller writes each character
	/// outside ASCII as the escapes of its UTF-8 bytes.
	RustBytes,
	/// PCRE2, which `grep` compiles a back-reference with. It runs with
	/// PCRE2_UCP, where its own POSIX classes are Unicode categories, so each
	/// bracket-expression class is written to match what it matches for
	/// [`Self::Rust`] (see [`push_bracket_class`]). The word class is each
	/// engine's own: `\w`, `\W`, `\b`, `\B`, `\<`, `\>` and `-w` count `²`
	/// and `½` as word characters under PCRE2_UCP and not in the `regex`
	/// crate, so a back-reference among the patterns changes what those
	/// match: `printf 'x²\n' | grep -c -e 'x\w' -e '\(y\)\1'` is 1, where it
	/// is 0 without the back-reference and for GNU. It has the look-around the
	/// word edges need.
	Pcre,
	/// PCRE2 without PCRE2_UTF and PCRE2_UCP, for a line that is not UTF-8,
	/// which GNU grep reads a byte to a character in the C locale: its POSIX
	/// classes hold ASCII alone, as GNU's do there.
	PcreBytes,
	/// `fancy-regex`, which `sed` and `nl` compile with: the `regex` crate's
	/// syntax plus back-references and look-around.
	Fancy,
}

impl Target {
	/// Whether the engine runs a back-reference.
	const fn backrefs(self) -> bool {
		!matches!(self, Self::Rust | Self::RustBytes)
	}

	/// Whether a POSIX letter class is written as the Unicode property of the
	/// same name. The `regex` crate reads `[[:alpha:]]` as ASCII alone, while
	/// GNU in a UTF-8 locale counts every letter (`printf '\303\237\n' |
	/// grep -c '[[:alpha:]]'` is 1), and PCRE2_UCP reads it as `\p{L}`, which
	/// leaves out `Ⅻ`, a letter to GNU; in the C locale a byte from 0x80 up
	/// is no letter.
	const fn unicode_letters(self) -> bool {
		!self.reads_bytes()
	}

	/// Whether the engine reads a byte to a character: GNU grep's C locale.
	const fn reads_bytes(self) -> bool {
		matches!(self, Self::RustBytes | Self::PcreBytes)
	}

	/// Whether the engine is one of grep's that fold case by Unicode's own
	/// rules, where GNU grep's differ (see [`push_case_literal`]); `sed`
	/// and `nl` keep their engine's.
	const fn folds_unicode(self) -> bool {
		matches!(self, Self::Rust | Self::Pcre)
	}
}

/// The offset of the characters that stand for the bytes from 0x80 up where
/// a text holds bytes that are no UTF-8, as `sed`'s byte text and a pattern
/// of [`pattern_text`] hold them: the byte `b` (0x80 to 0xFF) is U+10FF00 +
/// `b`, so U+10FF80 to U+10FFFF, characters of the private use plane 16. A
/// text that also holds one of those characters as itself reads it as that
/// byte.
const BYTE_CHARS: u32 = 0x10_FF00;

/// The character that stands for `byte` (see [`BYTE_CHARS`]); an ASCII byte
/// is itself.
#[cfg(any(feature = "util.grep", feature = "util.sed", test))]
pub(crate) fn byte_char(byte: u8) -> char {
	if byte.is_ascii() {
		char::from(byte)
	} else {
		char::from_u32(BYTE_CHARS | u32::from(byte)).expect("U+10FF80 to U+10FFFF are scalar values")
	}
}

/// The byte from 0x80 up that the character `c` stands for (see
/// [`BYTE_CHARS`]), if it stands for one.
pub(crate) fn char_byte(c: char) -> Option<u8> {
	u32::from(c)
		.checked_sub(BYTE_CHARS)
		.and_then(|byte| u8::try_from(byte).ok())
		.filter(|byte| !byte.is_ascii())
}

/// The text [`translate_raw`] reads for the pattern `bytes`: its UTF-8 as it
/// is, and each byte that is no UTF-8 as the character that stands for it
/// ([`byte_char`]), with whether it holds such a byte. GNU grep reads a
/// pattern as its bytes: `grep $'\351'` selects a line holding the byte
/// 0xE9. sed reads the bytes a string of `y` names so.
#[cfg(any(feature = "util.grep", feature = "util.sed", test))]
pub(crate) fn pattern_text(bytes: &[u8]) -> (String, bool) {
	let mut text = String::with_capacity(bytes.len());
	let mut raw = false;
	for chunk in bytes.utf8_chunks() {
		text.push_str(chunk.valid());
		for &byte in chunk.invalid() {
			raw = true;
			text.push(byte_char(byte));
		}
	}
	(text, raw)
}

/// The bytes of a pattern of [`pattern_text`]: `text` with each character
/// that stands for a byte written as that byte.
#[cfg(any(feature = "util.grep", feature = "util.sed", test))]
pub(crate) fn pattern_bytes(text: &str) -> Vec<u8> {
	let mut bytes = Vec::with_capacity(text.len());
	for c in text.chars() {
		push_char_bytes(&mut bytes, c);
	}
	bytes
}

/// Appends the bytes `c` is: the byte it stands for (see [`BYTE_CHARS`]),
/// else its UTF-8.
#[cfg(any(feature = "util.grep", feature = "util.sed", test))]
pub(crate) fn push_char_bytes(bytes: &mut Vec<u8>, c: char) {
	match char_byte(c) {
		Some(byte) => bytes.push(byte),
		None => bytes.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes()),
	}
}

/// The number of bytes [`push_char_bytes`] appends for `c`.
#[cfg(any(feature = "util.sed", test))]
pub(crate) fn char_bytes_len(c: char) -> usize {
	if char_byte(c).is_some() { 1 } else { c.len_utf8() }
}

/// Writes the pattern byte `byte`, which is no UTF-8, as an atom of `target`
/// that matches that byte. GNU grep matches such a byte as itself in the C
/// and the C.UTF-8 locale alike, in a character too: `grep $'\303'` selects
/// the line `é` in both. PCRE2 with PCRE2_UTF matches whole characters
/// alone, so for [`Target::Pcre`] (a back-reference among the patterns, for
/// a line that is UTF-8) the byte matches nothing. `sed` and `nl` read no
/// pattern of [`pattern_text`].
pub(crate) fn push_raw_byte(out: &mut String, byte: u8, target: Target) {
	use std::fmt::Write as _;
	let _ = match target {
		Target::Rust | Target::Fancy => write!(out, r"(?-u:\x{byte:02X})"),
		Target::RustBytes => write!(out, r"\x{byte:02X}"),
		Target::PcreBytes => write!(out, r"\x{{{byte:02X}}}"),
		Target::Pcre => write!(out, "(?!)"),
	};
}

/// How `grep` reads a pattern of [`pattern_text`]: two facts, each of which
/// matters apart from the other; see [`translate_raw`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct PatternBytes {
	/// Whether its characters from U+10FF80 up stand for its bytes that are
	/// no UTF-8; else each character is itself (`sed`, `nl`, and a pattern
	/// that is UTF-8).
	pub raw:         bool,
	/// Whether it is read as GNU reads it in a UTF-8 locale, else as in the
	/// C locale, where every byte is a character. It decides what a pattern
	/// byte in a bracket expression is, and how a target that reads a byte
	/// to a character reads a line that is not UTF-8.
	pub utf8_locale: bool,
}

/// How strictly a pattern is read.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code, reason = "each variant is used by a different utility feature")]
pub(crate) enum Strictness {
	/// As GNU grep and GNU nl read it.
	Lenient,
	/// As GNU sed reads it, refusing what the others read leniently; see
	/// [`Translator::strict`].
	Sed,
}

/// A pattern the engines cannot express, or that GNU itself refuses.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum BreError {
	/// A bracket expression with no closing `]`.
	BracketUnmatched,
	/// A `[:name:]` naming no POSIX character class.
	ClassNameInvalid,
	/// A bracket expression that is a class name without its outer brackets,
	/// as in `grep '[:alpha:]'`, in a pattern that holds no other error.
	ClassSyntaxConfused,
	/// A `[.c.]` or `[=c=]` holding other than one single-byte character.
	CollationInvalid,
	/// A range that runs backwards - once its ends are folded, under `-i` -
	/// or that has a class for an end, or a `-` after a range or class in a
	/// bracket expression that is not its last member.
	RangeEndInvalid,
	/// An interval after an atom that the pattern ends inside of: `a\{1`.
	BraceUnmatched,
	/// An interval after an atom whose counts make no interval: none at all
	/// (`a\{\}`), a second comma (`a\{1,2,3\}`), a maximum below the minimum
	/// (`a\{2,1\}`), or, where the dialect does not read the brace as an
	/// ordinary character instead, a count that holds other than digits
	/// (`a\{1x\}`); see [`NoInterval`].
	IntervalInvalid,
	/// An interval whose count is above 32767, glibc's RE_DUP_MAX, wherever
	/// the dialect reads it as an interval: `grep 'a\{32768\}'`, and `grep
	/// -E '{32768}'` with nothing to repeat.
	TooBig,
	/// A repetition operator with nothing to repeat, or one more repetition
	/// than the dialect allows, which `sed` refuses where `grep` reads the
	/// text itself or drops the operator; in `sed` also a brace with nothing
	/// to repeat, whatever follows it.
	RepetitionOperandMissing,
	/// A `)` or `\)` that closes no group, where the dialect refuses one.
	ParenUnmatched,
	/// A `(` or `\(` that the pattern never closes.
	GroupUnclosed,
	/// A back-reference to a group that has not closed in the branch it is
	/// in, or to none at all.
	BackReferenceInvalid,
	/// A pattern that ends in a backslash.
	TrailingBackslash,
}

impl BreError {
	/// The message GNU prints for this condition.
	pub(crate) fn message(self) -> &'static str {
		match self {
			Self::BracketUnmatched => "Unmatched [, [^, [:, [., or [=",
			Self::ClassNameInvalid => "Invalid character class name",
			Self::ClassSyntaxConfused => "character class syntax is [[:space:]], not [:space:]",
			Self::CollationInvalid => "Invalid collation character",
			Self::RangeEndInvalid => "Invalid range end",
			Self::BraceUnmatched => "Unmatched \\{",
			Self::IntervalInvalid => "Invalid content of \\{\\}",
			Self::TooBig => "Regular expression too big",
			Self::RepetitionOperandMissing => "Invalid preceding regular expression",
			Self::ParenUnmatched => "Unmatched ) or \\)",
			Self::GroupUnclosed => "Unmatched ( or \\(",
			Self::BackReferenceInvalid => "Invalid back reference",
			Self::TrailingBackslash => "Trailing backslash",
		}
	}
}

/// [`translate_multiline`] for a pattern searched in one line at a time, as
/// `nl` searches it (`grep` reads its pattern with [`translate_raw`]).
#[cfg(any(feature = "util.nl", test))]
pub(crate) fn translate(
	pattern: &str,
	dialect: Dialect,
	target: Target,
	icase: bool,
	strictness: Strictness,
) -> Result<String, BreError> {
	translate_multiline(pattern, dialect, target, icase, strictness, false)
}

/// [`translate_multiline`] for GNU grep's pattern of [`pattern_text`], read
/// one line at a time and as `bytes` says. A pattern byte that is no UTF-8
/// is written as [`push_raw_byte`] writes it. In a bracket expression it is
/// a member of that byte in the C locale (`LC_ALL=C grep $'[\351]'` selects
/// the byte 0xE9), for a target that reads a byte to a character. In a UTF-8
/// locale it is no member, as no character is that byte (`grep $'[\351]'`
/// selects nothing, in a line that is not UTF-8 too), except as a range's
/// end, which is the character of its value there (`grep $'[\351-\377]'`
/// selects `é`, U+00E9). There a target that reads a byte to a character,
/// which grep reads a line that is not UTF-8 with where a back-reference
/// is among the patterns, matches each bracket member outside ASCII, and
/// `.`, only as the whole UTF-8 sequence of a character, and nothing of an
/// encoding error, as GNU does: `printf 'x\251\n' | grep -c -e '[é]' -e
/// '\(k\)\1'` is 0.
#[cfg(any(feature = "util.grep", test))]
pub(crate) fn translate_raw(
	pattern: &str,
	dialect: Dialect,
	target: Target,
	icase: bool,
	bytes: PatternBytes,
) -> Result<String, BreError> {
	Translator { bytes, ..translator(pattern, dialect, target, icase, Strictness::Lenient, false) }
		.run()
}

/// Rewrites `pattern`, written in `dialect`, into the syntax `target` reads
/// with the meaning GNU gives it, read as strictly as `strictness` says.
///
/// `icase` is the case folding the caller compiles with: GNU checks a range
/// against the ends it folds, so `[Z-a]` is a range of its own and "Invalid
/// range end" under `-i`.
///
/// `multiline` is GNU sed's `M` flag, for text of several lines: there a
/// bracket expression that negates holds no newline, as `.` matches none
/// (`printf 'ab\nba\n' | sed 'N;s/[^a]/X/Mg'` prints `aX` and `Xa`).
pub(crate) fn translate_multiline(
	pattern: &str,
	dialect: Dialect,
	target: Target,
	icase: bool,
	strictness: Strictness,
	multiline: bool,
) -> Result<String, BreError> {
	translator(pattern, dialect, target, icase, strictness, multiline).run()
}

/// The translation of `pattern`, each of whose characters is itself, read as
/// in the C locale by a target that reads a byte to a character; see
/// [`translate_raw`] for a pattern of [`pattern_text`].
fn translator(
	pattern: &str,
	dialect: Dialect,
	target: Target,
	icase: bool,
	strictness: Strictness,
	multiline: bool,
) -> Translator<'_> {
	Translator {
		chars: pattern.chars().peekable(),
		out: String::with_capacity(pattern.len() + 8),
		dialect,
		target,
		strictness,
		icase,
		multiline,
		bytes: PatternBytes { raw: false, utf8_locale: false },
		atom: None,
		quantified: false,
		atom_is_anchor: false,
		branch_start: true,
		confused: false,
		groups: Vec::new(),
		opened: 0,
		completed: 0,
	}
}

/// Whether a character of `pattern` outside every bracket expression
/// satisfies `found`, which is told whether a backslash escapes it. Inside a
/// bracket expression `\` is an ordinary member, so `[\1]` holds no
/// back-reference; a bracket expression is skipped by its extent alone,
/// whatever its members, so `\(a\)[a-Z]\1` holds one under `-i` too.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
fn holds(pattern: &str, found: impl Fn(char, bool) -> bool) -> bool {
	let mut chars = pattern.chars().peekable();
	let mut skipped = String::new();
	while let Some(&c) = chars.peek() {
		match c {
			'[' => {
				// Nothing past an unterminated one is read with any confidence;
				// the translation reports it.
				skipped.clear();
				if !bracket_text(&mut chars, &mut skipped) {
					return false;
				}
			},
			'\\' => {
				chars.next();
				if chars.next().is_some_and(|escaped| found(escaped, true)) {
					return true;
				}
			},
			_ => {
				chars.next();
				if found(c, false) {
					return true;
				}
			},
		}
	}
	false
}

/// Whether `pattern` holds a back-reference, which only an engine that runs
/// them can compile.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
pub(crate) fn has_backreference(pattern: &str) -> bool {
	holds(pattern, |c, escaped| escaped && matches!(c, '1'..='9'))
}

/// Whether `pattern`, of [`pattern_text`], holds a pattern byte that is no
/// UTF-8 outside every bracket expression, which [`Target::Pcre`] cannot
/// match (see [`push_raw_byte`]).
#[cfg(feature = "util.grep")]
pub(crate) fn has_raw_byte(pattern: &str) -> bool {
	holds(pattern, |c, _| char_byte(c).is_some())
}

/// Whether `pattern`, written in `dialect`, opens a group.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
fn opens_group(pattern: &str, dialect: Dialect) -> bool {
	holds(pattern, |c, escaped| c == '(' && escaped == (dialect == Dialect::Basic))
}

/// The most alternatives [`alternatives`] expands a pattern into. A pattern
/// with more of them is searched whole, as the engine prefers it.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
const ALTERNATIVE_LIMIT: usize = 64;

/// The deepest [`expand`] reads groups inside groups, fancy-regex's own
/// nesting limit: it recurses once for each group, and a `sed -E` pattern
/// nested tens of thousands of groups deep with a `|` overflowed the stack,
/// an abort no error handler catches, where such a pattern is left whole
/// for the engine to refuse.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
const NESTING_LIMIT: usize = 64;

/// Who splits a pattern into its alternatives; see [`alternatives`].
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code, reason = "each variant is used by a different utility feature")]
pub(crate) enum Split {
	/// `grep -o`, which compiles each alternative alone: an alternation
	/// inside a group that no repetition follows is expanded as well (the
	/// alternatives of `(|zz)` are `()` and `(zz)`), which holds because such
	/// a group matches exactly once, while a group a repetition follows is
	/// left whole (the branches of `(a|ab)*` are not the pattern's). A
	/// pattern holding a back-reference is left whole.
	Grep,
	/// `sed`, which searches each branch of the top-level alternation alone
	/// and numbers a branch's groups after those of the branches before it.
	/// The pattern is left whole where a branch after the first holds a
	/// back-reference and a branch before it opens a group: the branch alone
	/// numbers its groups from 1, so `\(a\)\|\(b\)\2` would lose its second
	/// group, while `x\|\(x\)\1` keeps its meaning.
	Sed,
}

/// The alternatives of `pattern`: the branches of its alternation, each
/// written in the same dialect, split as far as `split` says.
///
/// POSIX and GNU print the LONGEST match at a position while the engines
/// prefer the first branch that matches there, so the caller searches each
/// branch on its own and keeps the longest (`grep -oE 'a|ab'` prints `ab`).
///
/// The pattern itself is the only alternative when it holds no alternation,
/// when a back-reference keeps it whole (see [`Split`]), when a group never
/// closes, when groups nest deeper than [`NESTING_LIMIT`], or when it would
/// expand into more than [`ALTERNATIVE_LIMIT`] branches.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
pub(crate) fn alternatives(pattern: &str, dialect: Dialect, split: Split) -> Vec<String> {
	if !pattern.contains('|') || (split == Split::Grep && has_backreference(pattern)) {
		return vec![pattern.to_owned()];
	}
	let mut chars = pattern.chars().peekable();
	match expand(&mut chars, dialect, split == Split::Grep, 0) {
		Some((branches, _)) if branches.len() > 1 && !renumbers_reference(&branches, dialect) => {
			branches
		},
		_ => vec![pattern.to_owned()],
	}
}

/// Whether a back-reference of `branches` names another group when its
/// branch is searched alone: a branch after the first holds one, and a branch
/// before it opens a group.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
fn renumbers_reference(branches: &[String], dialect: Dialect) -> bool {
	branches.iter().enumerate().skip(1).any(|(index, branch)| {
		has_backreference(branch)
			&& branches[..index].iter().any(|earlier| opens_group(earlier, dialect))
	})
}

/// Where one alternative, searched alone, matched last: `None` until it is
/// searched, `Some(None)` where it has no match from the position searched,
/// else the match's start and end.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
pub(crate) type CachedMatch = Option<Option<(usize, usize)>>;

/// The first match of one alternative at or after `pos`, for the callers
/// that search each alternative alone to take the longest match (see
/// [`alternatives`]). `cached` holds the match found from a position at or
/// before `pos`: it stands while it starts at or after `pos`, and otherwise
/// `search` finds the match from `pos`, which `cached` then keeps. Asked at
/// each position of a line in turn, an alternative so scans the line once.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
pub(crate) fn next_match<E>(
	cached: &mut CachedMatch,
	pos: usize,
	search: impl FnOnce() -> Result<Option<(usize, usize)>, E>,
) -> Result<Option<(usize, usize)>, E> {
	if let Some(found) = *cached
		&& found.is_none_or(|(start, _)| start >= pos)
	{
		return Ok(found);
	}
	let found = search()?;
	*cached = Some(found);
	Ok(found)
}

/// Whether `pattern`, written in `dialect`, holds no character the dialect
/// reads otherwise than as itself, so that it matches its own text alone, as
/// a fixed string does. A character that is ordinary only where it stands
/// (a BRE's leading `*`, an ERE's unmatched `)`) counts as special.
#[cfg(feature = "util.grep")]
pub(crate) fn is_literal(pattern: &str, dialect: Dialect) -> bool {
	let special: &[char] = match dialect {
		Dialect::Basic => &['\\', '.', '[', '*', '^', '$'],
		Dialect::Extended => &['\\', '.', '[', '*', '^', '$', '+', '?', '{', '(', ')', '|'],
	};
	!pattern.contains(special)
}

/// Expands the alternation the iterator holds into its branches, stopping at
/// the end of the pattern or, inside a group (`depth` above 0), after the
/// group's closing text. Returns the branches and the raw text consumed
/// before that closing text.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
fn expand(
	chars: &mut Peekable<Chars<'_>>,
	dialect: Dialect,
	distribute: bool,
	depth: usize,
) -> Option<(Vec<String>, String)> {
	let nested = depth > 0;
	let basic = dialect == Dialect::Basic;
	let (open, close) = if basic { ("\\(", "\\)") } else { ("(", ")") };
	let mut done: Vec<String> = Vec::new();
	let mut current: Vec<String> = vec![String::new()];
	let mut raw = String::new();
	loop {
		let Some(c) = chars.peek().copied() else {
			// A group that never closes: the caller leaves the pattern whole.
			if nested {
				return None;
			}
			break;
		};
		// The structural tokens, which the dialects spell differently.
		let structural = if basic && c == '\\' {
			let mut ahead = chars.clone();
			ahead.next();
			ahead.peek().copied().filter(|&c| matches!(c, '|' | '(' | ')'))
		} else if !basic {
			Some(c).filter(|&c| matches!(c, '|' | '(' | ')'))
		} else {
			None
		};
		match structural {
			Some('|') => {
				chars.next();
				if basic {
					chars.next();
				}
				raw.push_str(if basic { "\\|" } else { "|" });
				done.append(&mut current);
				current.push(String::new());
				if done.len() >= ALTERNATIVE_LIMIT {
					return None;
				}
			},
			Some('(') => {
				chars.next();
				if basic {
					chars.next();
				}
				if depth == NESTING_LIMIT {
					return None;
				}
				let (inner, inner_raw) = expand(chars, dialect, distribute, depth + 1)?;
				if distribute && inner.len() > 1 && !repetition_follows(chars, dialect) {
					let mut next = Vec::with_capacity(current.len() * inner.len());
					for prefix in &current {
						for branch in &inner {
							if done.len() + next.len() >= ALTERNATIVE_LIMIT {
								return None;
							}
							next.push(format!("{prefix}{open}{branch}{close}"));
						}
					}
					current = next;
				} else {
					for text in &mut current {
						text.push_str(open);
						text.push_str(&inner_raw);
						text.push_str(close);
					}
				}
				raw.push_str(open);
				raw.push_str(&inner_raw);
				raw.push_str(close);
			},
			Some(')') if nested => {
				chars.next();
				if basic {
					chars.next();
				}
				break;
			},
			_ => {
				// Any other token holds no alternation: a bracket expression,
				// an escaped character, or one ordinary character. It is read
				// into `raw` and copied from there into every branch.
				let from = raw.len();
				if c == '[' {
					if !bracket_text(chars, &mut raw) {
						return None;
					}
				} else {
					chars.next();
					raw.push(c);
					if c == '\\' && let Some(escaped) = chars.next() {
						raw.push(escaped);
					}
				}
				let text = &raw[from..];
				for branch in &mut current {
					branch.push_str(text);
				}
			},
		}
	}
	done.append(&mut current);
	(done.len() <= ALTERNATIVE_LIMIT).then_some((done, raw))
}

/// Whether a repetition operator comes next, which binds to the group just
/// read.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
fn repetition_follows(chars: &Peekable<Chars<'_>>, dialect: Dialect) -> bool {
	let mut ahead = chars.clone();
	match ahead.next() {
		Some('*') => true,
		Some('\\') if dialect == Dialect::Basic => matches!(ahead.next(), Some('?' | '+' | '{')),
		Some(c) => dialect == Dialect::Extended && matches!(c, '?' | '+' | '{'),
		None => false,
	}
}

/// Copies a bracket expression, the `[` included, into `out`, returning
/// whether it closes. Only its extent is read here; its members are read by
/// [`take_bracket_expression`] when the pattern is translated.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
fn bracket_text(chars: &mut Peekable<Chars<'_>>, out: &mut String) -> bool {
	out.push('[');
	chars.next();
	if let Some(negate) = chars.next_if_eq(&'^') {
		out.push(negate);
	}
	// A `]` first in the list is a member, not its end.
	if let Some(bracket) = chars.next_if_eq(&']') {
		out.push(bracket);
	}
	while let Some(c) = chars.next() {
		out.push(c);
		match c {
			']' => return true,
			'[' => {
				let Some(delimiter) = chars.next_if(|&c| matches!(c, ':' | '.' | '=')) else {
					continue;
				};
				out.push(delimiter);
				while let Some(inner) = chars.next() {
					out.push(inner);
					if inner == delimiter && let Some(end) = chars.next_if_eq(&']') {
						out.push(end);
						break;
					}
				}
			},
			_ => {},
		}
	}
	false
}

/// Whether GNU's regex searches `pattern`, written in `dialect`, a byte at a
/// time in a UTF-8 locale, where a match may then start, and an empty one
/// fall, inside a character of several bytes: `sed 's/x*/-/g'` on `é`
/// prints `-\303-\251-`. glibc does so unless the pattern holds a bracket
/// expression that negates, holds a range, a class or a character outside
/// ASCII, or one of `\w`, `\W`, `\s`, `\S`, `\b`, `\B`, `\<` and `\>`; such
/// a pattern is searched a character at a time (`sed 's/[^é]*/-/g'` on `éa`
/// prints `-é-`), as is any pattern read without case (the `I` flag), which
/// the caller answers. glibc drops an atom repeated zero times before it
/// looks, so such a bracket expression or `\w` does not count then:
/// `sed 's/[[:alpha:]]\{0\}/-/g'` on `éa` prints `-\303-\251-a-`. A group
/// repeated zero times still counts here, where glibc drops it too
/// (`\([^a]\)\{0\}`).
#[cfg(feature = "util.sed")]
pub(crate) fn searched_by_byte(pattern: &str, dialect: Dialect) -> bool {
	let mut chars = pattern.chars().peekable();
	while let Some(c) = chars.next() {
		// Whether the atom just read is searched a character at a time.
		let by_chars = match c {
			'\\' => match chars.next() {
				Some('b' | 'B' | '<' | '>') => return false,
				escaped => matches!(escaped, Some('w' | 'W' | 's' | 'S')),
			},
			'[' => !plain_bracket(&mut chars),
			_ => false,
		};
		if by_chars && !zero_count_follows(&chars, dialect) {
			return false;
		}
	}
	true
}

/// Whether the bracket expression whose `[` is already consumed is a plain
/// list of ASCII characters, which glibc reads as a set of bytes. The
/// iterator ends past its `]`. One the translation refuses answers either
/// way, and ends anywhere.
#[cfg(feature = "util.sed")]
fn plain_bracket(chars: &mut Peekable<Chars<'_>>) -> bool {
	let mut plain = chars.next_if_eq(&'^').is_none();
	let mut first = true;
	loop {
		let Ok(member) = take_bracket_member(chars, first) else {
			return plain;
		};
		first = false;
		match member {
			BracketMember::Char(_) if opens_range(chars) => {
				plain = false;
				chars.next();
				if take_bracket_member(chars, true).is_err() {
					return plain;
				}
			},
			BracketMember::Char(c) | BracketMember::Equivalence(c) => plain &= c.is_ascii(),
			BracketMember::Class(_) => plain = false,
		}
		match chars.peek() {
			None => return plain,
			Some(']') => {
				chars.next();
				return plain;
			},
			Some(_) => {},
		}
	}
}

/// Whether an interval that repeats the atom just read zero times comes
/// next: `{0}`, `{0,0}` or GNU's `{,0}`, in a BRE with a backslash before
/// each brace.
#[cfg(feature = "util.sed")]
fn zero_count_follows(chars: &Peekable<Chars<'_>>, dialect: Dialect) -> bool {
	let mut ahead = chars.clone();
	if dialect == Dialect::Basic && ahead.next_if_eq(&'\\').is_none() {
		return false;
	}
	if ahead.next_if_eq(&'{').is_none() {
		return false;
	}
	// The operator is `{n}`, `{n,}` or `{n,m}`, its last number the most.
	read_interval(&mut ahead, dialect).is_ok_and(|(operator, _)| {
		operator
			.trim_end_matches('}')
			.rsplit(['{', ','])
			.next()
			.is_some_and(|most| !most.is_empty() && most.bytes().all(|digit| digit == b'0'))
	})
}

/// A group that is still open.
struct OpenGroup {
	/// Where in `out` it begins.
	start:       usize,
	/// Its number, counted by its opening as POSIX counts groups.
	number:      u32,
	/// The groups closed when it opened, which each branch inside it may
	/// refer to.
	initial:     u32,
	/// The groups closed in its branches before the current one, which a
	/// back-reference may name again once it closes: `\(\(a\)\|b\)\2` is
	/// valid, as glibc keeps them (`completed_bkref_map |=
	/// accumulated_bkref_map`).
	accumulated: u32,
}

/// The bit of group `number` in [`Translator::completed`]; a back-reference
/// names groups 1 to 9 alone.
const fn group_bit(number: u32) -> Option<u32> {
	1u32.checked_shl(number)
}

/// The translation of one pattern, which reads it left to right and writes
/// the engine's syntax as it goes.
struct Translator<'a> {
	chars:      Peekable<Chars<'a>>,
	out:        String,
	dialect:    Dialect,
	target:     Target,
	strictness: Strictness,
	icase:      bool,
	/// Whether a bracket expression that negates holds no newline; see
	/// [`translate_multiline`].
	multiline:  bool,
	/// How the pattern is read; see [`translate_raw`].
	bytes:      PatternBytes,
	/// Where in `out` the atom a repetition operator repeats begins, or
	/// `None` at a branch start, where there is nothing to repeat.
	atom:       Option<usize>,
	/// Whether that atom already carries a repetition operator, so the next
	/// one repeats the repetition instead of reading as the engine's lazy
	/// flag: GNU reads `a\+\?` as `(a+)?`, which matches the empty string.
	quantified: bool,
	/// Whether that atom is an anchor - `^` or `$` in GNU grep's ERE, or `\b`
	/// or `\B` - after which glibc parses no repetition, so that GNU grep
	/// reads a brace that makes no interval there as text: `grep -cE
	/// '^{1,2,3}'` counts the lines starting with `{1,2,3}`, where after any
	/// other atom it is "Invalid content of \{\}".
	atom_is_anchor: bool,
	/// Whether the token just read opens a branch: the start of the pattern,
	/// `\(` or `\|`, as glibc tells it. In a BRE only there does `^` anchor;
	/// after any other token, an assertion included, it is an ordinary
	/// character: `grep -c '^^'` counts the lines that start with a caret,
	/// and ``grep '\`^a'`` selects the line `^a`.
	branch_start: bool,
	/// Whether a bracket expression was a class name written without its
	/// outer brackets, which is reported only once the rest of the pattern
	/// has translated and closed every group: GNU reports any other error
	/// first, so `sed 's/[:alpha:][z-a]/x/'` is "Invalid range end" and `sed
	/// 's/[:alpha:]\(/x/'` "Unmatched ( or \(", each exit 1, not 4.
	confused:   bool,
	/// The groups that are still open, innermost last.
	groups:     Vec<OpenGroup>,
	/// How many groups have opened.
	opened:     u32,
	/// The groups a back-reference may name here, one bit per number: those
	/// closed in the current branch or before its enclosing group opened,
	/// and those an enclosing group closed in its earlier branches once it
	/// closes. GNU refuses `\(a\)\|\(b\)\1` and `\(a\1\)` ("Invalid back
	/// reference").
	completed:  u32,
}

impl Translator<'_> {
	fn run(mut self) -> Result<String, BreError> {
		let extended = self.dialect == Dialect::Extended;
		while let Some(c) = self.chars.next() {
			// Every token ends the start of a branch; `(` and `|` open one.
			let branch_start = std::mem::take(&mut self.branch_start);
			match c {
				'\\' => self.escape()?,
				'[' => {
					let start = self.out.len();
					self.confused |= take_bracket_expression(
						&mut self.chars,
						&mut self.out,
						self.icase,
						self.target,
						self.multiline,
						self.bytes,
					)?;
					self.set_atom(start);
				},
				'*' => self.repeat("*", "*")?,
				'+' if extended => self.repeat("+", "+")?,
				'?' if extended => self.repeat("?", "?")?,
				'{' if extended => self.brace()?,
				'(' if extended => self.open_group(),
				')' if extended => self.close_group()?,
				'|' if extended => self.alternate(),
				'^' => self.caret(branch_start),
				'$' => self.dollar(),
				_ => self.literal(c),
			}
		}
		// A group still open is refused before a class name written without
		// its outer brackets: `sed 's/[:alpha:]\(/x/'` is "Unmatched ( or
		// \(" and exit 1.
		if !self.groups.is_empty() {
			return Err(BreError::GroupUnclosed);
		}
		if self.confused {
			return Err(BreError::ClassSyntaxConfused);
		}
		Ok(self.out)
	}

	/// Whether the pattern is read as GNU sed reads it, which refuses what
	/// GNU grep and GNU nl read leniently: a repetition operator with nothing
	/// to repeat in an ERE (`sed -E 's/*x/Y/'`), an interval with nothing to
	/// repeat in either dialect, a `*` or interval right after another
	/// repetition in a BRE (`sed 's/a**/X/'`), and an unmatched `)` in an
	/// ERE - each "Invalid preceding regular expression" or "Unmatched ) or
	/// \)" there, where GNU grep drops the operator, matches the text, or
	/// reads the `)` as an ordinary character, and GNU nl accepts `a**`.
	fn strict(&self) -> bool {
		self.strictness == Strictness::Sed
	}

	/// The character after a backslash: an operator in a BRE, one of GNU's
	/// extensions, or the character itself. GNU reads a backslash before an
	/// ordinary character as that character, so `grep -o '\d'` prints a `d`,
	/// not a digit.
	fn escape(&mut self) -> Result<(), BreError> {
		let basic = self.dialect == Dialect::Basic;
		let Some(c) = self.chars.next() else {
			return Err(BreError::TrailingBackslash);
		};
		match c {
			'(' if basic => self.open_group(),
			')' if basic => self.close_group()?,
			'{' if basic => return self.brace(),
			'|' if basic => self.alternate(),
			'?' if basic => self.repeat("?", "?")?,
			'+' if basic => self.repeat("+", "+")?,
			digit @ '1'..='9' => self.backreference(digit)?,
			'<' => self.word_edge(true),
			'>' => self.word_edge(false),
			'`' => self.assertion("\\A"),
			'\'' => self.assertion("\\z"),
			// GNU's own classes and boundaries, which the engines share, and
			// punctuation, which an escape keeps a literal in the engines.
			// Before anything else a backslash is the character itself.
			'b' | 'B' => {
				let start = self.out.len();
				self.out.push('\\');
				self.out.push(c);
				self.set_atom(start);
				self.atom_is_anchor = true;
			},
			_ if matches!(c, 'w' | 'W' | 's' | 'S') || c.is_ascii_punctuation() => {
				let start = self.out.len();
				self.out.push('\\');
				self.out.push(c);
				self.set_atom(start);
			},
			_ => self.literal(c),
		}
		Ok(())
	}

	/// An interval: `{n}`, `{n,}`, `{n,m}`, or GNU's `{,m}` and `{,}`, which
	/// are `{0,m}` and `{0,}`.
	fn brace(&mut self) -> Result<(), BreError> {
		// Whether GNU grep reads a brace that makes no interval here as an
		// ordinary character: where there is nothing to repeat, or after an
		// anchor, which glibc gives no repetition.
		let text = !self.strict() && (self.atom.is_none() || self.atom_is_anchor);
		match read_interval(&mut self.chars, self.dialect) {
			Ok((operator, literal)) => self.repeat(&operator, &literal),
			// GNU sed refuses a brace with nothing to repeat before it reads
			// what follows: `sed -E 's{\{x{Y{'` is "Invalid preceding regular
			// expression".
			Err(_) if self.strict() && self.atom.is_none() => {
				Err(BreError::RepetitionOperandMissing)
			},
			// GNU grep's dfa reads a count in an ERE wherever it stands, so
			// `grep -E '^{32768}'` is "regular expression too big", while a
			// BRE's `\{` with nothing to repeat is text (`grep -c '\{32768\}'`
			// counts the lines holding `{32768}`).
			Err(NoInterval::TooBig) if !(text && self.dialect == Dialect::Basic) => {
				Err(BreError::TooBig)
			},
			// Otherwise there the brace is an ordinary character: `grep -c
			// '\{'` counts the lines holding one, and so do `grep -cE
			// '{1,2,3}'`, `grep -cE '^{}'` and `grep -c '\B\{\}'`.
			Err(_) if text => {
				self.literal('{');
				Ok(())
			},
			// GNU grep's ERE takes such a brace literally: `grep -cE 'a{1'`
			// counts the lines holding the text `a{1`.
			Err(NoInterval::Interrupted { .. })
				if self.dialect == Dialect::Extended && !self.strict() =>
			{
				self.literal('{');
				Ok(())
			},
			Err(NoInterval::Interrupted { ended: true }) => Err(BreError::BraceUnmatched),
			Err(_) => Err(BreError::IntervalInvalid),
		}
	}

	/// Writes a repetition operator, or what it means where there is nothing
	/// to repeat: `literal` is the text GNU grep matches in a BRE, while it
	/// drops the operator in an ERE. See [`Self::strict`] for what GNU sed
	/// refuses instead.
	fn repeat(&mut self, operator: &str, literal: &str) -> Result<(), BreError> {
		let interval = operator.starts_with('{');
		let Some(start) = self.atom else {
			if self.strict() && (self.dialect == Dialect::Extended || interval) {
				return Err(BreError::RepetitionOperandMissing);
			}
			if self.dialect == Dialect::Basic {
				let at = self.out.len();
				for c in literal.chars() {
					push_literal(&mut self.out, c);
				}
				self.set_atom(at);
			}
			return Ok(());
		};
		if self.quantified {
			if self.strict() && self.dialect == Dialect::Basic && (operator == "*" || interval) {
				return Err(BreError::RepetitionOperandMissing);
			}
			// A second operator repeats the repetition; written as it stands,
			// the engines would read `a*?` as a lazy `a*`, which matches the
			// empty string where GNU matches every `a`.
			self.out.insert_str(start, "(?:");
			self.out.push(')');
		}
		self.out.push_str(operator);
		self.quantified = true;
		Ok(())
	}

	fn open_group(&mut self) {
		self.opened += 1;
		self.groups.push(OpenGroup {
			start:       self.out.len(),
			number:      self.opened,
			initial:     self.completed,
			accumulated: 0,
		});
		self.out.push('(');
		self.atom = None;
		self.quantified = false;
		self.branch_start = true;
	}

	/// A group's closing text. GNU refuses an unmatched `\)` in a BRE, and
	/// GNU sed an unmatched `)` in an ERE, while GNU grep reads the latter
	/// as an ordinary character (`grep -cE 'a)'` counts the lines holding
	/// `a)`).
	fn close_group(&mut self) -> Result<(), BreError> {
		match self.groups.pop() {
			Some(group) => {
				self.out.push(')');
				self.completed |= group.accumulated;
				if let Some(bit) = group_bit(group.number) {
					self.completed |= bit;
				}
				self.set_atom(group.start);
				Ok(())
			},
			None if self.dialect == Dialect::Basic || self.strict() => Err(BreError::ParenUnmatched),
			None => {
				self.literal(')');
				Ok(())
			},
		}
	}

	fn alternate(&mut self) {
		self.out.push('|');
		// A branch may name only the groups closed before its enclosing group
		// opened, besides its own; those of the earlier branches count again
		// once that group closes.
		match self.groups.last_mut() {
			Some(group) => {
				group.accumulated |= self.completed;
				self.completed = group.initial;
			},
			None => self.completed = 0,
		}
		self.atom = None;
		self.quantified = false;
		self.branch_start = true;
	}

	/// A back-reference to group `digit`, one of `1` to `9`.
	fn backreference(&mut self, digit: char) -> Result<(), BreError> {
		let bit = 1u32 << (u32::from(digit) - u32::from('0'));
		if self.completed & bit == 0 {
			return Err(BreError::BackReferenceInvalid);
		}
		let start = self.out.len();
		if self.target.backrefs() {
			// Neither dialect has a multi-digit back-reference: `\11` is
			// group 1 and then a `1`, which the group keeps apart.
			self.out.push_str("(?:\\");
			self.out.push(digit);
			self.out.push(')');
		} else {
			self.out.push('\\');
			self.out.push(digit);
		}
		self.set_atom(start);
		Ok(())
	}

	/// GNU's `\<` and `\>`, the edges of a word.
	fn word_edge(&mut self, start: bool) {
		let text = match (self.target, start) {
			(Target::Rust | Target::RustBytes, true) => "\\<",
			(Target::Rust | Target::RustBytes, false) => "\\>",
			(_, true) => "\\b(?=\\w)",
			(_, false) => "\\b(?<=\\w)",
		};
		self.assertion(text);
	}

	/// A zero-width assertion, which no repetition operator repeats.
	fn assertion(&mut self, text: &str) {
		self.out.push_str(text);
		self.atom = None;
		self.quantified = false;
	}

	/// In a BRE `^` anchors only where a branch starts (see
	/// [`Self::branch_start`]); in an ERE it always anchors.
	fn caret(&mut self, branch_start: bool) {
		if self.dialect == Dialect::Extended || branch_start {
			let start = self.out.len();
			self.out.push('^');
			self.anchor_atom(start);
			return;
		}
		self.literal('^');
	}

	/// In a BRE `$` anchors only at the end of a branch - `grep 'a$\|b'`
	/// selects the lines ending in `a` as well as those holding a `b`.
	fn dollar(&mut self) {
		if self.dialect == Dialect::Extended || ends_branch(&self.chars) {
			let start = self.out.len();
			self.out.push('$');
			self.anchor_atom(start);
			return;
		}
		self.literal('$');
	}

	/// What a repetition operator after an anchor repeats. GNU grep's ERE
	/// repeats the anchor itself, which the engines read only inside a
	/// group, so the operator wraps it: `grep -cE 'a$*'` counts every line
	/// holding an `a`, as `a(?:$)*` does. GNU sed refuses that operator
	/// (`sed -E 's/^*/X/'`), and in a BRE the character is ordinary there,
	/// so for both nothing precedes it.
	fn anchor_atom(&mut self, start: usize) {
		if self.dialect == Dialect::Extended && !self.strict() {
			self.atom = Some(start);
			self.quantified = true;
			self.atom_is_anchor = true;
		} else {
			self.atom = None;
			self.quantified = false;
		}
	}

	fn literal(&mut self, c: char) {
		let start = self.out.len();
		match char_byte(c).filter(|_| self.bytes.raw) {
			Some(byte) => push_raw_byte(&mut self.out, byte, self.target),
			// In a UTF-8 locale `.` is a whole character, and no encoding
			// error, in a line that is not UTF-8 as in one that is (see
			// `close_class`): `printf 'x\377y\n' | grep -c -e 'x.y' -e
			// $'\351'` is 0.
			None if c == '.' && self.bytes.utf8_locale && self.target.reads_bytes() => {
				self.out.push_str(r"[^\n");
				let members = ClassMembers { written: true, ..ClassMembers::default() };
				close_class(&mut self.out, start, true, members, false, self.target, true);
			},
			None if self.icase && self.target.folds_unicode() && case_differs(c) => {
				push_case_literal(&mut self.out, c);
			},
			None => push_literal(&mut self.out, c),
		}
		self.set_atom(start);
	}

	fn set_atom(&mut self, start: usize) {
		self.atom = Some(start);
		self.quantified = false;
		self.atom_is_anchor = false;
	}
}

/// Why the text after an opening brace makes no interval, told apart as
/// glibc's `parse_dup_op` tells it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum NoInterval {
	/// A character other than a digit or a comma interrupts a count, or the
	/// pattern ends inside the interval (`ended`). GNU grep's ERE then reads
	/// the brace as an ordinary character (glibc's RE_INVALID_INTERVAL_ORD):
	/// `grep -cE 'a{1x}'` and `grep -cE 'a{1'` count the lines holding that
	/// text. Elsewhere it is "Unmatched \{" where the pattern ends, and
	/// "Invalid content of \{\}" otherwise.
	Interrupted { ended: bool },
	/// The counts are read but make no interval: none at all (`a{}`), a
	/// second comma (`a{1,2,3}`), or a maximum below the minimum (`a{2,1}`).
	/// "Invalid content of \{\}" in every dialect.
	Invalid,
	/// The counts make an interval whose most is above [`RE_DUP_MAX`]:
	/// `a{32768}`, `a{1,32768}`, `a{32768,}`. "Regular expression too big".
	TooBig,
}

/// The largest count of an interval glibc and GNU's dfa accept.
const RE_DUP_MAX: u32 = 32767;

/// What ends one count of an interval.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CountEnd {
	Comma,
	Close,
}

/// Reads one count of an interval as glibc's `fetch_number` does: up to the
/// comma or the closing brace that ends it, the whole of it even where a
/// character other than a digit interrupts it. Returns its digits, none
/// where it is empty, and what ended it.
fn read_count(
	chars: &mut Peekable<Chars<'_>>,
	dialect: Dialect,
) -> Result<(String, CountEnd), NoInterval> {
	let mut digits = String::new();
	let mut interrupted = false;
	let end = loop {
		match chars.next() {
			None => return Err(NoInterval::Interrupted { ended: true }),
			Some(',') => break CountEnd::Comma,
			Some('}') if dialect == Dialect::Extended => break CountEnd::Close,
			Some('\\') => match chars.next() {
				Some('}') if dialect == Dialect::Basic => break CountEnd::Close,
				// A pattern that ends in a backslash ends inside the interval.
				None => return Err(NoInterval::Interrupted { ended: true }),
				Some(_) => interrupted = true,
			},
			Some(digit @ '0'..='9') => digits.push(digit),
			Some(_) => interrupted = true,
		}
	};
	if interrupted {
		return Err(NoInterval::Interrupted { ended: false });
	}
	Ok((digits, end))
}

/// The number a count's digits spell, capped one past [`RE_DUP_MAX`], as
/// glibc caps it: `a{40000,32768}` is too big, not backwards.
fn count_value(digits: &str) -> u32 {
	digits
		.bytes()
		.fold(0, |value, digit| (value * 10 + u32::from(digit - b'0')).min(RE_DUP_MAX + 1))
}

/// Reads the interval after an opening brace, as glibc's `parse_dup_op`
/// reads it, leaving the iterator where it was when the text that follows
/// makes none. Returns the operator the engines read and the text GNU
/// matches where there is nothing to repeat.
fn read_interval(
	chars: &mut Peekable<Chars<'_>>,
	dialect: Dialect,
) -> Result<(String, String), NoInterval> {
	let mut ahead = chars.clone();
	let (low, end) = read_count(&mut ahead, dialect)?;
	let high = match end {
		// `a{}` holds no count at all.
		CountEnd::Close if low.is_empty() => return Err(NoInterval::Invalid),
		CountEnd::Close => None,
		CountEnd::Comma => match read_count(&mut ahead, dialect)? {
			(high, CountEnd::Close) => Some(high),
			// A second comma: `a{1,2,3}`, `a{1,,}`.
			(_, CountEnd::Comma) => return Err(NoInterval::Invalid),
		},
	};
	// A maximum below the minimum: `a{2,1}`.
	if high.as_deref().is_some_and(|high| !high.is_empty() && count_value(high) < count_value(&low)) {
		return Err(NoInterval::Invalid);
	}
	// The most, or the least where there is no most (`a{32768,}`), checked
	// once the interval is read, as glibc checks it.
	let most = high.as_deref().filter(|high| !high.is_empty()).unwrap_or(low.as_str());
	if count_value(most) > RE_DUP_MAX {
		return Err(NoInterval::TooBig);
	}
	let literal = match &high {
		Some(high) => format!("{{{low},{high}}}"),
		None => format!("{{{low}}}"),
	};
	// GNU reads `{,m}` as `{0,m}` and `{,}` as `{0,}`: `grep -cE 'a{,2}'`
	// and `grep -cE 'a{,}'` count every line.
	let operator = match &high {
		Some(high) if low.is_empty() => format!("{{0,{high}}}"),
		_ => literal.clone(),
	};
	*chars = ahead;
	Ok((operator, literal))
}

/// Whether the rest of the pattern ends the current branch of a BRE.
///
/// `$` is an anchor at the end of a branch, not only at the end of the whole
/// pattern: `grep 'a$\|b'` selects lines ending in `a` as well as lines
/// holding a `b`, and escaping it there made the first branch unmatchable
/// and silently dropped those lines.
fn ends_branch(chars: &Peekable<Chars<'_>>) -> bool {
	let mut rest = chars.clone();
	match rest.next() {
		None => true,
		Some('\\') => matches!(rest.next(), Some('|' | ')')),
		Some(_) => false,
	}
}

/// Writes `c` as an ordinary character, escaped where the engines would read
/// it as syntax.
fn push_literal(out: &mut String, c: char) {
	// A `.` is "any character" in both dialects, and a lone `]` is ordinary
	// to the engines, so neither is escaped here.
	if matches!(c, '\\' | '+' | '*' | '?' | '(' | ')' | '|' | '[' | '{' | '}' | '^' | '$')
	{
		out.push('\\');
	}
	out.push(c);
}

/// The character classes POSIX defines in every locale: the names GNU
/// accepts in `[:name:]`.
const POSIX_CLASSES: [&str; 12] = [
	"alnum", "alpha", "blank", "cntrl", "digit", "graph", "lower", "print", "punct", "space",
	"upper", "xdigit",
];

/// One member of a bracket expression.
#[derive(Clone, Copy)]
enum BracketMember {
	/// A character, written plainly or as the collating symbol `[.c.]`.
	Char(char),
	/// The equivalence class `[=c=]`, which holds `c` alone, as in GNU's C
	/// locale. Unlike a character it neither starts nor ends a range.
	Equivalence(char),
	/// `[:name:]`, one of `POSIX_CLASSES`.
	Class(&'static str),
}

/// Consume a bracket expression whose `[` is already consumed, and append it
/// to `out` in the form the engine reads with the meaning POSIX gives it.
///
/// Inside a bracket expression `\` is an ordinary character, a `]` first in
/// the list (after a negating `^`) is a member, `-` is a member first or last
/// in the list or as a range's end, and `[` opens something only as
/// `[:name:]`, `[.c.]` or `[=c=]`. The `regex` crate reads `\` as an escape,
/// `[` as a nested class and `&&`, `--` and `~~` as set operations, so each
/// member is written with the escape that keeps it a plain member. Measured
/// against GNU grep: `[\(]` selects a backslash or a parenthesis, `[]x]` a
/// bracket or an `x`, `[[]` a `[`, `[a&&b]` an `a`, `&` or `b`, `[~~]` a `~`,
/// and `[!--]` any character from `!` to `-`.
///
/// The errors are GNU's, met in its order: a list with no closing `]`, a
/// class name POSIX does not define, a collating symbol or equivalence class
/// of other than one single-byte character, a range that runs backwards or
/// has a class for an end, or a `-` after a range or class that does not
/// close the list. Returns whether the list is a class name without the
/// outer brackets, which the caller reports only where the rest of the
/// pattern holds no error.
///
/// A list that negates holds no newline where `multiline` (GNU sed's `M`
/// flag): `[^x]*$` stops at the end of a line there.
///
/// A member that stands for a pattern byte that is no UTF-8, and any member
/// outside ASCII for a target that reads a byte to a character, is read as
/// [`translate_raw`] says for `bytes`.
fn take_bracket_expression(
	chars: &mut Peekable<Chars<'_>>,
	out: &mut String,
	icase: bool,
	target: Target,
	multiline: bool,
	bytes: PatternBytes,
) -> Result<bool, BreError> {
	let class_start = out.len();
	out.push('[');
	let negated = chars.next_if_eq(&'^').is_some();
	if negated {
		out.push('^');
		if multiline {
			out.push_str("\\n");
		}
	}
	let raw_byte = |c: char| char_byte(c).filter(|_| bytes.raw);
	// A pattern byte that is no member, as in a UTF-8 locale: nothing alone,
	// the character of its value as a range's end.
	let as_char = |c: char| match raw_byte(c) {
		Some(byte) if bytes.utf8_locale => char::from(byte),
		_ => c,
	};
	// The members kept apart to be written at the close (see `close_class`):
	// in a UTF-8 locale an engine that reads a byte to a character (for a
	// line that is not UTF-8) matches a member outside ASCII only as its
	// whole UTF-8 sequence, and under `-i` a range whose ends are pattern
	// bytes holds no other case of its characters.
	let whole = bytes.utf8_locale && target.reads_bytes();
	let apart = whole || (icase && bytes.raw && bytes.utf8_locale);
	let mut members = ClassMembers::default();
	// The byte of a range's end that an engine reading a byte to a
	// character puts next to the `-`: the pattern byte it stands for, or
	// else the last of its UTF-8 bytes where it starts the range and the
	// first where it ends it, its other bytes being members of their own.
	let edge_byte = |c: char, start: bool| {
		raw_byte(c).unwrap_or_else(|| {
			let mut utf8 = [0; 4];
			let encoded = c.encode_utf8(&mut utf8).as_bytes();
			if start { encoded[encoded.len() - 1] } else { encoded[0] }
		})
	};
	// A `-` first in the list is a member.
	let mut first = true;
	// GNU warns where the list opens with a colon, the member last read is a
	// colon, some member is neither, and the list holds no range, class,
	// collating symbol or equivalence class: `[:alpha:]` is a class name
	// written without its outer brackets, and grep refuses it, while
	// `[:a-z:]` and `[:[:digit:]:]` are searched.
	let mut opens_colon = false;
	let mut other_member = false;
	let mut special = false;
	let mut ends_colon;
	loop {
		let symbol = {
			let mut ahead = chars.clone();
			ahead.next() == Some('[') && matches!(ahead.next(), Some(':' | '.' | '='))
		};
		let member = take_bracket_member(chars, first)?;
		// A colon read as `[.:.]` or opening a range makes the list special
		// as well, which no warning concerns.
		ends_colon = matches!(member, BracketMember::Char(':'));
		let range = matches!(member, BracketMember::Char(_)) && opens_range(chars);
		if first {
			opens_colon = ends_colon;
		}
		first = false;
		special |= symbol || range;
		other_member |= !ends_colon;
		match member {
			BracketMember::Char(start) if range => {
				chars.next();
				// A `-` right after the range's own is its end, as in `[!--]`.
				let BracketMember::Char(end) = take_bracket_member(chars, true)? else {
					return Err(BreError::RangeEndInvalid);
				};
				let raw_end = raw_byte(start).is_some() || raw_byte(end).is_some();
				// The ends GNU checks the upper case of a character against
				// under `-i` where an end is a pattern byte: that byte's
				// character as it is, and any other end's upper case.
				let upper_end =
					|c: char| if raw_byte(c).is_some() { as_char(c) } else { simple_upper(c) };
				let upper_ends = (upper_end(start), upper_end(end));
				let (start, end) = (as_char(start), as_char(end));
				// GNU checks the range against the ends it folds: `[Z-a]` is
				// a range of its own and "Invalid range end" under `-i`,
				// while `[a-Z]` is the other way round. One the engine cannot
				// express is refused here rather than searched as something
				// else. It is written as checked, which the engine's own
				// folding widens back: `grep -ic '[a-Z]'` selects `b`, and
				// `grep -ic '[A-z]'` does not select `_`.
				let (low, high) = if icase {
					(start.to_ascii_uppercase(), end.to_ascii_uppercase())
				} else {
					(start, end)
				};
				// An engine that reads a byte to a character is checked on the
				// bytes it gets, as GNU checks them in the C locale: `LC_ALL=C
				// grep $'[\xc3-\xc3\xa9]'` is the range C3-C3 and the byte A9.
				let backwards = if target.reads_bytes() && !whole {
					edge_byte(high, false) < edge_byte(low, true)
				} else {
					high < low
				};
				if backwards {
					return Err(BreError::RangeEndInvalid);
				}
				if icase && raw_end && bytes.utf8_locale {
					// GNU holds each character whose upper case is in the
					// range: under `-i` `[\300-\301]` matches `á`, and
					// `[\340-\341]` neither `á` nor `Á`; `[z-\351]` matches `Z`
					// and `É`, and not `a`, whose upper case is before `Z`.
					members.exact.extend(upper_case_in(upper_ends.0, upper_ends.1));
				} else if apart {
					if low.is_ascii() {
						push_bracket_char(out, low);
						out.push('-');
						if high.is_ascii() {
							push_bracket_char(out, high);
						} else {
							out.push_str(r"\x7F");
						}
						if icase {
							members.ascii.push((low, high.min('\x7F')));
						}
						members.written = true;
					}
					if !high.is_ascii() {
						members.wide.push((u32::from(low).max(0x80), u32::from(high)));
					}
				} else {
					push_bracket_member(out, low, raw_byte(low), target);
					out.push('-');
					push_bracket_member(out, high, raw_byte(high), target);
					members.written = true;
				}
			},
			BracketMember::Char(c) if raw_byte(c).is_some() && bytes.utf8_locale => {},
			BracketMember::Char(c) if apart && !c.is_ascii() => {
				members.wide.push((u32::from(c), u32::from(c)));
			},
			BracketMember::Char(c) | BracketMember::Equivalence(c) => {
				push_bracket_member(out, c, raw_byte(c), target);
				if apart && icase {
					members.ascii.push((c, c));
				}
				members.written = true;
			},
			BracketMember::Class(name) => {
				push_bracket_class(out, name, target, icase);
				members.written = true;
			},
		}
		match chars.peek() {
			None => return Err(BreError::BracketUnmatched),
			Some(']') => {
				chars.next();
				close_class(out, class_start, negated, members, icase, target, whole);
				return Ok(opens_colon && ends_colon && other_member && !special);
			},
			Some(_) => {},
		}
	}
}

/// The members of a bracket expression that are written at its close; see
/// [`close_class`].
#[derive(Default)]
struct ClassMembers {
	/// Whether a member was written to the list as it was read.
	written: bool,
	/// Under `-i`, the ranges of the ASCII members written, whose other case
	/// is a member too.
	ascii:   Vec<(char, char)>,
	/// The ranges of the members outside ASCII, as scalar values.
	wide:    Vec<(u32, u32)>,
	/// Members whose other case is none: under `-i`, the characters a range
	/// whose ends are pattern bytes holds ([`upper_case_in`]).
	exact:   Vec<(u32, u32)>,
}

/// Closes a bracket expression whose list `out` holds from `class_start`,
/// with the members it kept apart. A list that holds no member matches no
/// character, or every one where it negates.
///
/// For an engine that reads a byte to a character, in a UTF-8 locale
/// (`whole`), as GNU reads it there in a line that is not UTF-8: the members
/// outside ASCII match only as the whole UTF-8 sequence of a character, and
/// a list that negates matches any character it does not hold, and no
/// encoding error: `printf 'x\251\n' | grep -o $'[^\300-\377]'` prints the
/// `x` alone. Where `icase` the other case of each member is one too, as GNU
/// gives it ([`case_counterparts`]); the engine folds ASCII alone. It is
/// written as an alternation, `(?:[a]|\xC3[\x80-\xBF])` for `[a\300-\377]`.
///
/// For an engine that reads text the members are written in the class,
/// which the engine folds; where they were kept apart (a pattern of
/// [`pattern_text`] in a UTF-8 locale, under `-i`), each member's other
/// case is written as for `whole` and the class is read with case, as the
/// engine's folding is not GNU's: `printf 'I\377\n' | grep -ic
/// $'[\304\261\351]'` is 1.
fn close_class(
	out: &mut String,
	class_start: usize,
	negated: bool,
	members: ClassMembers,
	icase: bool,
	target: Target,
	whole: bool,
) {
	let ClassMembers { mut written, ascii, mut wide, exact } = members;
	let kept_apart = !(ascii.is_empty() && wide.is_empty() && exact.is_empty());
	let fold = icase && (whole || kept_apart);
	if fold {
		let lonesome = LONESOME_LOWER.map(|lone| (lone, simple_upper(lone)));
		let mut folded = Vec::new();
		let members = ascii.iter().map(|&(low, high)| (u32::from(low), u32::from(high)));
		for (low, high) in members.chain(wide.iter().copied()) {
			for c in (low..=high).filter_map(char::from_u32) {
				for other_case in case_counterparts(c, &lonesome) {
					if other_case.is_ascii() {
						push_bracket_char(out, other_case);
						written = true;
					} else {
						folded.push((u32::from(other_case), u32::from(other_case)));
					}
				}
			}
		}
		wide.extend(folded);
	}
	wide.extend(exact);
	wide.sort_unstable();
	let mut merged: Vec<(u32, u32)> = Vec::with_capacity(wide.len());
	for (low, high) in wide {
		match merged.last_mut() {
			Some(last) if low <= last.1 + 1 => last.1 = last.1.max(high),
			_ => merged.push((low, high)),
		}
	}
	if !whole {
		for &(low, high) in &merged {
			let low = char::from_u32(low).expect("a member's end is a scalar value");
			let high = char::from_u32(high).expect("a member's end is a scalar value");
			push_bracket_char(out, low);
			if high != low {
				out.push('-');
				push_bracket_char(out, high);
			}
		}
		if !written && merged.is_empty() {
			out.truncate(class_start);
			out.push_str(if negated { r"[\x00-\x{10FFFF}]" } else { r"[^\x00-\x{10FFFF}]" });
			return;
		}
		out.push(']');
		if fold {
			out.insert_str(class_start, "(?-i:");
			out.push(')');
		}
		return;
	}
	if !negated && merged.is_empty() {
		out.push(']');
		if !written {
			out.truncate(class_start);
			out.push_str(r"[^\x00-\xFF]");
		}
		return;
	}
	if negated {
		let mut gaps = Vec::new();
		let mut next = 0x80;
		for (low, high) in merged {
			if low > next {
				gaps.push((next, low - 1));
			}
			next = high + 1;
		}
		if next <= 0x10_FFFF {
			gaps.push((next, 0x10_FFFF));
		}
		merged = gaps;
	}
	out.insert_str(class_start, "(?:");
	let mut alternatives = negated || written;
	if negated {
		// The class holds ASCII alone; the other characters follow.
		push_raw_byte(out, 0x80, target);
		out.push('-');
		push_raw_byte(out, 0xFF, target);
		out.push(']');
	} else if written {
		out.push(']');
	} else {
		out.truncate(class_start + "(?:".len());
	}
	for (low, high) in merged {
		push_utf8_ranges(out, low, high, target, &mut alternatives);
	}
	out.push(')');
}

/// gnulib's `lonesome_lower`: the lower-case letters that are no other
/// letter's lower case, which GNU matches without case for their upper
/// case's other forms (`ς` for `Σ` and `σ`, `ſ` for `s` and `S`).
const LONESOME_LOWER: [char; 19] = [
	'\u{B5}', '\u{131}', '\u{17F}', '\u{1C5}', '\u{1C8}', '\u{1CB}', '\u{1F2}', '\u{345}', '\u{3C2}',
	'\u{3D0}', '\u{3D1}', '\u{3D5}', '\u{3D6}', '\u{3F0}', '\u{3F1}', '\u{3F2}', '\u{3F5}',
	'\u{1E9B}', '\u{1FBE}',
];

/// The characters GNU grep also matches for `c` without case, as gnulib's
/// `case_folded_counterparts` gives them with glibc's `towupper` and
/// `towlower`: the upper case of `c`, the lower case of that where its upper
/// case is the same, and each of `lonesome` (the [`LONESOME_LOWER`] with
/// their upper case) whose upper case is the same. So `[Σ]` matches `ς`,
/// `[s]` matches `ſ` and `[ı]` matches `I`, and the Kelvin sign and `k`
/// match each other neither way, as `printf 'k\377\n' | grep -ic
/// $'[\u212A\351]'` counts 0.
fn case_counterparts(c: char, lonesome: &[(char, char)]) -> impl Iterator<Item = char> + '_ {
	let upper = simple_upper(c);
	let lower = simple_lower(upper);
	let lonesome = lonesome
		.iter()
		.filter(move |&&(lone, lone_upper)| lone != lower && lone != upper && lone != c && lone_upper == upper)
		.map(|&(lone, _)| lone);
	(upper != c)
		.then_some(upper)
		.into_iter()
		.chain((lower != upper && lower != c && simple_upper(lower) == upper).then_some(lower))
		.chain(lonesome)
}

/// Whether the `regex` crate's and PCRE2's own folding of `c` may match
/// other characters than GNU grep matches without case ([`case_counterparts`]):
/// that of a letter outside ASCII, and of `i`, `I`, `k` and `K`, which they
/// fold with `İ`/`ı` left out and with the Kelvin sign.
pub(crate) fn case_differs(c: char) -> bool {
	if c.is_ascii() { matches!(c, 'i' | 'I' | 'k' | 'K') } else { c.is_alphabetic() }
}

/// Writes `c` as GNU grep matches it without case, for an engine that folds
/// case itself: `c` and its counterparts ([`case_counterparts`]) in a class
/// read with case. `printf '\342\204\252\n' | grep -ic k` (the Kelvin sign)
/// is 0, `printf 'I\n' | grep -ic $'\304\261'` (`ı`) is 1, and `printf
/// '\341\272\236\n' | grep -ic $'\303\237'` (`ẞ` against `ß`) is 0, in a
/// line that is not UTF-8 too.
pub(crate) fn push_case_literal(out: &mut String, c: char) {
	let lonesome = LONESOME_LOWER.map(|lone| (lone, simple_upper(lone)));
	out.push_str("(?-i:[");
	push_bracket_char(out, c);
	for other_case in case_counterparts(c, &lonesome) {
		push_bracket_char(out, other_case);
	}
	out.push_str("])");
}

/// The characters whose upper case ([`simple_upper`]) is from `low` to
/// `high`, as ranges of scalar values: the members GNU grep gives under
/// `-i` a range whose ends are pattern bytes, each the character of its
/// value.
fn upper_case_in(low: char, high: char) -> impl Iterator<Item = (u32, u32)> {
	(low..=high)
		.flat_map(|c| [c, simple_lower(c)])
		.chain(LONESOME_LOWER)
		.filter(move |&c| (low..=high).contains(&simple_upper(c)))
		.map(|c| (u32::from(c), u32::from(c)))
}

/// The simple upper case of `c`, as `towupper` gives it and GNU sed's `\U`
/// writes it: Rust's where it is one character, and for a lower-case Greek
/// letter with ypogegrammeni, whose full upper case is two, the one with
/// prosgegrammeni (`ᾀ` is `ᾈ`); any other whose full upper case is several
/// characters is itself (`ß`, `ﬁ`). Measured with GNU sed 4.9 in C.UTF-8 on
/// every code point whose full case mapping is several characters.
pub(crate) fn simple_upper(c: char) -> char {
	let mut upper = c.to_uppercase();
	if let (Some(one), None) = (upper.next(), upper.next()) {
		return one;
	}
	let code = u32::from(c);
	let simple = match code {
		0x1F80..=0x1F87 | 0x1F90..=0x1F97 | 0x1FA0..=0x1FA7 => code + 8,
		0x1FB3 | 0x1FC3 | 0x1FF3 => code + 9,
		_ => code,
	};
	char::from_u32(simple).unwrap_or(c)
}

/// The simple lower case of `c`, as `towlower` gives it and GNU sed's `\L`
/// writes it: Rust's where it is one character, and `i` for `İ`, the only
/// character whose full lower case is two.
pub(crate) fn simple_lower(c: char) -> char {
	let mut lower = c.to_lowercase();
	match (lower.next(), lower.next()) {
		(Some(one), None) => one,
		_ if c == '\u{130}' => 'i',
		_ => c,
	}
}

/// Appends, each after a `|` where `alternatives` says one came before,
/// alternatives that match the UTF-8 sequence of each scalar value from
/// `low` to `high`, and nothing else, for an engine that reads a byte to a
/// character: `\xC3[\x80-\xBF]` for U+00C0 to U+00FF. Each is a sequence of
/// byte ranges, split as the `regex-syntax` crate's `Utf8Sequences` splits
/// them, so that every byte of a range may follow every byte of the one
/// before.
fn push_utf8_ranges(out: &mut String, low: u32, high: u32, target: Target, alternatives: &mut bool) {
	/// The greatest scalar value of one, two and three bytes.
	const LENGTH_ENDS: [u32; 3] = [0x7F, 0x7FF, 0xFFFF];
	// No surrogate is a character.
	let mut pending: Vec<(u32, u32)> = [(low.max(0xE000), high), (low, high.min(0xD7FF))]
		.into_iter()
		.filter(|(start, end)| start <= end)
		.collect();
	'next: while let Some((start, end)) = pending.pop() {
		for length_end in LENGTH_ENDS {
			if start <= length_end && length_end < end {
				pending.push((length_end + 1, end));
				pending.push((start, length_end));
				continue 'next;
			}
		}
		for i in 1..4 {
			let mask = (1_u32 << (6 * i)) - 1;
			if start & !mask != end & !mask {
				if start & mask != 0 {
					pending.push(((start | mask) + 1, end));
					pending.push((start, start | mask));
					continue 'next;
				}
				if end & mask != mask {
					pending.push((end & !mask, end));
					pending.push((start, (end & !mask) - 1));
					continue 'next;
				}
			}
		}
		let (mut first_bytes, mut last_bytes) = ([0; 4], [0; 4]);
		let first = char::from_u32(start).expect("no surrogate").encode_utf8(&mut first_bytes).as_bytes();
		let last = char::from_u32(end).expect("no surrogate").encode_utf8(&mut last_bytes).as_bytes();
		if std::mem::replace(alternatives, true) {
			out.push('|');
		}
		for (&from, &to) in first.iter().zip(last) {
			if from == to {
				push_raw_byte(out, from, target);
			} else {
				out.push('[');
				push_raw_byte(out, from, target);
				out.push('-');
				push_raw_byte(out, to, target);
				out.push(']');
			}
		}
	}
}

/// Consume one member of a bracket expression. A `-` is a member first in
/// the list or as a range's end (`accept_hyphen`); anywhere else it follows a
/// range or a class, and GNU refuses it unless it is the last member.
fn take_bracket_member(
	chars: &mut Peekable<Chars<'_>>,
	accept_hyphen: bool,
) -> Result<BracketMember, BreError> {
	match chars.next().ok_or(BreError::BracketUnmatched)? {
		'[' => match chars.next_if(|&c| matches!(c, ':' | '.' | '=')) {
			Some(delimiter) => take_bracket_symbol(chars, delimiter),
			None => Ok(BracketMember::Char('[')),
		},
		'-' if !accept_hyphen && chars.peek() != Some(&']') => Err(BreError::RangeEndInvalid),
		c => Ok(BracketMember::Char(c)),
	}
}

/// Consume the rest of `[:name:]`, `[.c.]` or `[=c=]` after its `delimiter`.
/// As in GNU's regex, the name ends at the first `delimiter` that a `]`
/// follows, so it may start with `]` (`[.].]`) or be empty (`[..]`).
fn take_bracket_symbol(
	chars: &mut Peekable<Chars<'_>>,
	delimiter: char,
) -> Result<BracketMember, BreError> {
	let name_start = chars.clone();
	let mut length = 0;
	loop {
		let c = chars.next().ok_or(BreError::BracketUnmatched)?;
		if c == delimiter && chars.next_if_eq(&']').is_some() {
			break;
		}
		length += 1;
	}
	let mut name = name_start.take(length);
	if delimiter == ':' {
		return POSIX_CLASSES
			.into_iter()
			.find(|class| class.chars().eq(name.clone()))
			.map(BracketMember::Class)
			.ok_or(BreError::ClassNameInvalid);
	}
	match (name.next(), name.next()) {
		// A collating symbol or an equivalence class names ONE character, and
		// in the C and the C.UTF-8 locale alike GNU knows only the
		// single-byte ones: `grep '[[.é.]]'` is "Invalid collation
		// character" in both.
		(Some(c), None) if c.is_ascii() => Ok(if delimiter == '.' {
			BracketMember::Char(c)
		} else {
			BracketMember::Equivalence(c)
		}),
		_ => Err(BreError::CollationInvalid),
	}
}

/// Whether a `-` comes next and opens a range: one right before the closing
/// `]` is the last member instead.
fn opens_range(chars: &Peekable<Chars<'_>>) -> bool {
	let mut ahead = chars.clone();
	ahead.next() == Some('-') && ahead.peek() != Some(&']')
}

/// Append `c` as a member of a `regex` crate class, escaped where that crate
/// would read it as syntax: an escape, a nested class or its end, a negation,
/// a range, or the `&&`, `--` and `~~` set operations.
fn push_bracket_char(out: &mut String, c: char) {
	if matches!(c, '\\' | '[' | ']' | '^' | '-' | '&' | '~') {
		out.push('\\');
	}
	out.push(c);
}

/// Append `c` as a member of a class: the pattern byte `raw` it stands for,
/// for an engine that reads a byte to a character ([`push_raw_byte`]), or
/// else the character itself ([`push_bracket_char`]).
fn push_bracket_member(out: &mut String, c: char, raw: Option<u8>, target: Target) {
	match raw {
		Some(byte) if target.reads_bytes() => push_raw_byte(out, byte, target),
		_ => push_bracket_char(out, c),
	}
}

/// Append the POSIX class `name` as a member of a class, with the meaning it
/// has for [`Target::Rust`] whichever engine `target` is, and for
/// [`Target::RustBytes`] and [`Target::PcreBytes`] the ASCII one GNU gives
/// it in the C locale.
///
/// Without case `upper` and `lower` are `alpha`, as glibc and GNU's dfa read
/// them: `printf '中\n' | grep -ci '[[:lower:]]'` is 1. (PCRE2 folds no
/// Unicode property, so `\p{Lowercase}` would not match an `A` there.)
///
/// The letter classes are written as the Unicode property of the same name
/// where the engine's own POSIX class is not GNU's (see
/// [`Target::unicode_letters`]): GNU in a UTF-8 locale counts `ß` as a
/// letter, so `printf '\303\237\n' | grep -cw '[[:alpha:]]'` is 1.
///
/// The other classes hold ASCII alone, as the `regex` crate reads them. GNU
/// reads `digit` and `xdigit` so in every locale, and holds characters
/// outside ASCII in the others in a UTF-8 locale (`　` is a space to it,
/// `—` punctuation). PCRE2_UCP reads them as Unicode categories, so for
/// [`Target::Pcre`] they are written as their ASCII ranges: `printf
/// 'x\331\240\n' | grep -c -e '[[:digit:]]$' -e '\(y\)\1'` is 0, and so is
/// `printf 'x\302\240\n' | grep -c -e '[[:space:]]$' -e '\(y\)\1'`, as for
/// GNU.
fn push_bracket_class(out: &mut String, name: &str, target: Target, icase: bool) {
	let name = if icase && matches!(name, "lower" | "upper") { "alpha" } else { name };
	let pcre = target == Target::Pcre;
	let written = match name {
		"alpha" if target.unicode_letters() => r"\p{Alphabetic}",
		"alnum" if target.unicode_letters() => r"\p{Alphabetic}\p{Nd}",
		"lower" if target.unicode_letters() => r"\p{Lowercase}",
		"upper" if target.unicode_letters() => r"\p{Uppercase}",
		"digit" if pcre => "0-9",
		"xdigit" if pcre => "0-9A-Fa-f",
		"space" if pcre => r"\x09-\x0D\x20",
		"blank" if pcre => r"\x09\x20",
		"cntrl" if pcre => r"\x00-\x1F\x7F",
		"graph" if pcre => r"\x21-\x7E",
		"print" if pcre => r"\x20-\x7E",
		"punct" if pcre => r"\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E",
		_ => {
			out.push_str("[:");
			out.push_str(name);
			out.push_str(":]");
			return;
		},
	};
	out.push_str(written);
}

#[cfg(test)]
mod tests {
	use super::*;

	/// A BRE as `sed` compiles it.
	fn bre(pattern: &str) -> String {
		translate(pattern, Dialect::Basic, Target::Fancy, false, Strictness::Sed).expect("translatable")
	}

	fn bre_err(pattern: &str) -> Option<BreError> {
		translate(pattern, Dialect::Basic, Target::Fancy, false, Strictness::Sed).err()
	}

	/// An ERE as `grep` compiles it.
	fn ere(pattern: &str) -> String {
		translate(pattern, Dialect::Extended, Target::Rust, false, Strictness::Lenient).expect("translatable")
	}

	fn ere_err(pattern: &str) -> Option<BreError> {
		translate(pattern, Dialect::Extended, Target::Rust, false, Strictness::Lenient).err()
	}

	// Relocated from `sed`, which owned this translation before `grep` shared it.

	#[test]
	fn test_bre_group_translation() {
		assert_eq!(bre(r"\(a\?b\+c\|\)"), "(a?b+c|)");
		assert_eq!(bre(r"a\(b\)c"), "a(b)c");
	}

	#[test]
	fn test_bre_brace_quantifier_translation() {
		assert_eq!(bre(r"a\{1,4\}"), "a{1,4}");
		assert_eq!(bre(r"\(a\)\{1,4\}"), "(a){1,4}");
	}

	#[test]
	fn test_ere_metacharacters_escaped() {
		assert_eq!(bre(r"a+b?c{1}|(d)"), r"a\+b\?c\{1\}\|\(d\)");
	}

	#[test]
	fn test_literal_backslashes_preserved() {
		assert_eq!(bre(r"foo\\bar"), r"foo\\bar");
		assert_eq!(bre(r"\."), r"\.");
	}

	#[test]
	fn test_character_classes_unchanged() {
		assert_eq!(bre(r"[a-z]"), "[a-z]");
		assert_eq!(bre(r"[^0-9]"), "[^0-9]");
	}

	#[test]
	fn test_anchors_and_dot_and_star() {
		assert_eq!(bre(r"^a.*b$"), "^a.*b$");
	}

	#[test]
	fn test_caret_escaped_in_middle() {
		assert_eq!(bre(r"^a^[^x]c"), r"^a\^[^x]c");
	}

	#[test]
	fn test_dollar_escaped_in_middle() {
		assert_eq!(bre(r"a$c$"), r"a\$c$");
	}

	#[test]
	fn test_bre_back_reference() {
		assert_eq!(bre(r"\(.\)\1\(.\)\2"), r"(.)(?:\1)(.)(?:\2)");
	}

	#[test]
	fn a_trailing_backslash_is_refused() {
		// GNU: "grep: Trailing backslash", exit 2.
		assert_eq!(bre_err(r"abc\"), Some(BreError::TrailingBackslash));
		assert_eq!(ere_err(r"abc\"), Some(BreError::TrailingBackslash));
	}

	#[test]
	fn back_references_are_written_for_the_engine_that_runs_them() {
		// `grep-regex` cannot run one at all, so `grep` compiles a pattern
		// holding a back-reference with PCRE2 instead; the sequence is
		// written plainly for an engine that would refuse it, which keeps the
		// refusal (exit 2) rather than searching the text `\1`.
		assert_eq!(
			translate(r"\(a\)\1", Dialect::Basic, Target::Rust, false, Strictness::Lenient).expect("translatable"),
			r"(a)\1"
		);
		// The group exists only for the engines that run them, where a bare
		// `\11` would read as group 11 instead of group 1 and then a `1`.
		assert_eq!(bre(r"\(a\)\11"), r"(a)(?:\1)1");
	}

	#[cfg(feature = "util.grep")]
	#[test]
	fn an_ere_back_reference_is_written_too() {
		assert_eq!(
			translate(r"(a)\1", Dialect::Extended, Target::Pcre, false, Strictness::Lenient).expect("translatable"),
			r"(a)(?:\1)"
		);
		assert!(has_backreference(r"(a)\1"));
		assert!(has_backreference(r"\(a\)\1"));
		assert!(!has_backreference(r"[\1]"));
		assert!(!has_backreference(r"a\\1"));
		// A bracket expression is skipped by its extent, so a member the
		// translation refuses without `-i` does not hide what follows it.
		assert!(has_backreference(r"\(a\)[a-Z]\1"));
	}

	// ── Repetition operators with no preceding atom ──────────────────────────
	// POSIX: a repetition character with nothing to repeat is a literal in a
	// BRE. GNU drops it in an ERE, with a warning on standard error.

	#[test]
	fn escaped_plus_at_pattern_start_is_a_literal() {
		assert_eq!(bre(r"\+"), r"\+");
	}

	#[test]
	fn escaped_plus_after_anchor_is_a_literal() {
		assert_eq!(bre(r"^\+"), r"^\+");
	}

	#[test]
	fn escaped_question_after_anchor_is_a_literal() {
		assert_eq!(bre(r"^\?"), r"^\?");
	}

	#[test]
	fn an_interval_with_no_operand_is_the_text_itself_in_a_bre() {
		// Measured: `printf '{1,4}\n' | grep -c '\{1,4\}'` is 1 and
		// `printf 'x\n' | grep -c '\{1,4\}'` is 0, so for grep the interval
		// is the text, not an operator and not an error.
		let grep_bre = |pattern: &str| {
			translate(pattern, Dialect::Basic, Target::Rust, false, Strictness::Lenient).expect("translatable")
		};
		assert_eq!(grep_bre(r"\{1,4\}"), r"\{1,4\}");
		assert_eq!(grep_bre(r"^\{2\}"), r"^\{2\}");
		assert_eq!(grep_bre(r"\(\{2\}\)"), r"(\{2\})");
		assert_eq!(grep_bre(r"a\|\{2\}"), r"a|\{2\}");
		// With an operand it is an ordinary quantifier.
		assert_eq!(grep_bre(r"a\{2\}"), "a{2}");
		assert_eq!(bre(r"a\{2\}"), "a{2}");
		// GNU sed refuses it instead: `sed 's/\{1,3\}/X/'` reports an
		// invalid RE rather than substituting.
		assert_eq!(bre_err(r"\{1,3\}"), Some(BreError::RepetitionOperandMissing));
		assert_eq!(bre_err(r"^\{1,3\}"), Some(BreError::RepetitionOperandMissing));
	}

	#[test]
	fn a_brace_that_opens_no_interval_is_refused_after_an_atom() {
		// GNU: "grep: Unmatched \{", exit 2, for `a\{1`, `a\{x` and `a\{`.
		assert_eq!(bre_err(r"a\{1"), Some(BreError::BraceUnmatched));
		assert_eq!(bre_err(r"a\{x"), Some(BreError::BraceUnmatched));
		assert_eq!(bre_err(r"a\{"), Some(BreError::BraceUnmatched));
		// With nothing to repeat it is an ordinary brace to grep: `grep -c
		// '\{'` counts the lines holding one.
		let grep_bre =
			|pattern: &str| translate(pattern, Dialect::Basic, Target::Rust, false, Strictness::Lenient);
		assert_eq!(grep_bre(r"\{"), Ok(r"\{".to_owned()));
		assert_eq!(bre(r"\}"), r"\}");
	}

	#[test]
	fn sed_refuses_a_brace_with_nothing_to_repeat() {
		// If this regresses, `echo a | sed -E 's{\{x{Y{'` (where `\{` is the
		// delimiter, so sed's own interval check does not see it) prints `a`
		// and exits 0, where GNU sed prints "Invalid preceding regular
		// expression" and exits 1, whatever follows the brace.
		for pattern in [r"\{", r"\{x", r"\{1,2,3\}", r"\{\}", r"^\{x", r"x\|\{x", r"\(\{x\)"] {
			assert_eq!(bre_err(pattern), Some(BreError::RepetitionOperandMissing), "{pattern}");
		}
		let sed_ere = |pattern: &str| translate(pattern, Dialect::Extended, Target::Fancy, false, Strictness::Sed).err();
		for pattern in ["{x", "{1,2,3}", "{}", "{2\\}", "^{x", "x|{x", "({x)"] {
			assert_eq!(sed_ere(pattern), Some(BreError::RepetitionOperandMissing), "{pattern}");
		}
		// GNU grep reads each as text.
		for pattern in ["{x", "{1,2,3}", "{}", "^{x", "x|{x", "({x)"] {
			assert!(ere_err(pattern).is_none(), "{pattern}");
		}
	}

	#[test]
	fn a_count_above_re_dup_max_is_too_big() {
		// If this regresses, `grep -c 'a\{32768\}'` searches, and `grep -c
		// 'a\{1,32768\}'` counts the line `a`, where GNU grep prints "Regular
		// expression too big" and exits 2, as GNU sed does with exit 1.
		for pattern in [r"a\{32768\}", r"a\{1,32768\}", r"a\{32768,\}", r"a\{,32768\}", r"a\{0032768\}"] {
			assert_eq!(bre_err(pattern), Some(BreError::TooBig), "{pattern}");
			assert_eq!(
				translate(pattern, Dialect::Basic, Target::Rust, false, Strictness::Lenient).err(),
				Some(BreError::TooBig),
				"{pattern}"
			);
		}
		// Capped as glibc caps them, both counts are 32768: too big, not
		// backwards, while a maximum below the minimum is checked first.
		assert_eq!(ere_err("a{40000,32768}"), Some(BreError::TooBig));
		assert_eq!(ere_err("a{40000,1}"), Some(BreError::IntervalInvalid));
		assert_eq!(ere("a{32767}"), "a{32767}");
		assert_eq!(ere("a{0032767}"), "a{0032767}");
		// GNU grep's ERE reads a count wherever it stands; its BRE reads a
		// `\{` with nothing to repeat, or after an anchor, as text.
		for pattern in ["{32768}", "^{32768}", "a${32768}", r"\b{32768}", "x|{32768}"] {
			assert_eq!(ere_err(pattern), Some(BreError::TooBig), "{pattern}");
		}
		let grep_bre =
			|pattern: &str| translate(pattern, Dialect::Basic, Target::Rust, false, Strictness::Lenient);
		assert_eq!(grep_bre(r"\{32768\}"), Ok(r"\{32768\}".to_owned()));
		assert_eq!(grep_bre(r"\b\{32768\}"), Ok(r"\b\{32768\}".to_owned()));
		// A count a character interrupts is not read as a count at all.
		assert_eq!(ere("a{32768x}"), r"a\{32768x\}");
	}

	#[test]
	fn an_ere_takes_a_brace_that_opens_no_interval_literally() {
		// `grep -cE 'a{1'` counts the lines holding the text `a{1`, and
		// `grep -cE '{a}'` those holding `{a}`.
		assert_eq!(ere("a{1"), r"a\{1");
		assert_eq!(ere("a{1,2"), r"a\{1,2");
		assert_eq!(ere("{a}"), r"\{a\}");
		// GNU reads `{,}` as `{0,}`: `grep -cE 'a{,}'` counts every line.
		assert_eq!(ere("a{,}"), "a{0,}");
		assert_eq!(bre(r"a\{,\}"), "a{0,}");
		// An interval that opens is an operator.
		assert_eq!(ere("a{2}"), "a{2}");
		assert_eq!(ere("a{2,}"), "a{2,}");
		// GNU reads `{,m}` as `{0,m}`: `grep -cE 'a{,2}'` counts every line.
		assert_eq!(ere("a{,2}"), "a{0,2}");
		assert_eq!(bre(r"a\{,2\}"), "a{0,2}");
	}

	#[test]
	fn a_malformed_interval_is_refused_as_glibc_refuses_it() {
		// If this regresses, `grep -cE 'a{1,2,3}'` counts the lines holding
		// that text and exits 0, where GNU grep 3.11 prints "Invalid content
		// of \{\}" and exits 2: once its counts are read, an interval with a
		// second comma, none at all or a maximum below its minimum is refused
		// in every dialect.
		for pattern in ["a{1,2,3}", "a{1,2,", "a{1,,}", "a{}", "a{2,1}", "(){1,2,3}", "a{1,2,3"] {
			assert_eq!(ere_err(pattern), Some(BreError::IntervalInvalid), "{pattern}");
		}
		for pattern in [r"a\{1,2,3\}", r"a\{\}", r"a\{2,1\}", r"a\{1,2,"] {
			assert_eq!(bre_err(pattern), Some(BreError::IntervalInvalid), "{pattern}");
		}
		// A count a character other than a digit or a comma interrupts is
		// text in grep's ERE (`grep -cE 'a{1x}'` counts the lines holding
		// `a{1x}`), and "Invalid content of \{\}" in a BRE, or "Unmatched \{"
		// where the pattern ends inside it.
		assert_eq!(ere("a{1x}"), r"a\{1x\}");
		assert_eq!(ere("a{1,x}"), r"a\{1,x\}");
		assert_eq!(ere("a{x,2,3}"), r"a\{x,2,3\}");
		assert_eq!(ere("a{,"), r"a\{,");
		assert_eq!(bre_err(r"a\{x\}"), Some(BreError::IntervalInvalid));
		assert_eq!(bre_err(r"a\{1,x\}"), Some(BreError::IntervalInvalid));
		assert_eq!(bre_err(r"a\{1,2x"), Some(BreError::BraceUnmatched));
		// GNU sed's ERE reads it as its BRE does.
		let sed_ere = |pattern: &str| translate(pattern, Dialect::Extended, Target::Fancy, false, Strictness::Sed).err();
		assert_eq!(sed_ere("a{x}"), Some(BreError::IntervalInvalid));
		assert_eq!(sed_ere("a{1"), Some(BreError::BraceUnmatched));
		// With nothing to repeat the brace is text: `grep -cE '{1,2,3}'`
		// counts the lines holding `{1,2,3}`.
		assert_eq!(ere("{1,2,3}"), r"\{1,2,3\}");
		assert_eq!(
			translate(r"\{1,2,3\}", Dialect::Basic, Target::Rust, false, Strictness::Lenient).ok(),
			Some(r"\{1,2,3\}".to_owned())
		);
	}

	#[test]
	fn a_brace_that_makes_no_interval_after_an_anchor_is_text_to_grep() {
		// If this regresses, `grep -cE '^{1,2,3}'` and `grep -cE 'x|^{}'` exit
		// 2 with "Invalid content of \{\}", where GNU grep, which parses no
		// repetition after an anchor, reads the brace as text and searches.
		assert_eq!(ere("^{1,2,3}"), r"^\{1,2,3\}");
		assert_eq!(ere("^{}"), r"^\{\}");
		assert_eq!(ere("x|^{}"), r"x|^\{\}");
		assert_eq!(ere("a${1,2,3}"), r"a$\{1,2,3\}");
		assert_eq!(ere("^*{1,2,3}"), r"(?:^)*\{1,2,3\}");
		assert_eq!(ere(r"\b{1,2,3}"), r"\b\{1,2,3\}");
		assert_eq!(ere(r"\B{}"), r"\B\{\}");
		assert_eq!(
			translate(r"\B\{\}", Dialect::Basic, Target::Rust, false, Strictness::Lenient).ok(),
			Some(r"\B\{\}".to_owned())
		);
		// After any other atom, a group closing on an anchor included, GNU
		// refuses it, and so does GNU sed after an anchor.
		for pattern in [r"\w{1,2,3}", "(^){1,2,3}", "a{1,2}{1,2,3}", "^{1,2,3}x{}"] {
			assert_eq!(ere_err(pattern), Some(BreError::IntervalInvalid), "{pattern}");
		}
		assert_eq!(
			translate(r"\b{}", Dialect::Extended, Target::Fancy, false, Strictness::Sed).err(),
			Some(BreError::IntervalInvalid)
		);
	}

	#[test]
	fn an_ere_drops_a_repetition_operator_with_nothing_to_repeat() {
		// GNU warns ("* at start of expression") and matches as though the
		// operator were not there: `printf 'x\n' | grep -cE '*x'` is 1.
		assert_eq!(ere("*x"), "x");
		assert_eq!(ere("{2}x"), "x");
		assert_eq!(ere("a|*b"), "a|b");
		assert_eq!(ere("(*x)"), "(x)");
		// An anchor IS something to repeat in an ERE, and repeating it zero
		// times drops it: `grep -cE 'a$*'` counts every line holding an `a`,
		// and `grep -cE '^+'` counts every line.
		assert_eq!(ere("^+"), "(?:^)+");
		assert_eq!(ere("^*x"), "(?:^)*x");
		assert_eq!(ere("a$*"), "a(?:$)*");
	}

	#[test]
	fn a_second_repetition_operator_repeats_the_repetition() {
		// `printf 'b\n' | grep -c 'a\+\?'` is 1: GNU reads it as `(a+)?`,
		// which matches the empty string, where a lazy `a+` does not.
		assert_eq!(bre(r"a\+\?"), "(?:a+)?");
		assert_eq!(ere("a+?"), "(?:a+)?");
		assert_eq!(ere("a*?"), "(?:a*)?");
		assert_eq!(ere("a?*"), "(?:a?)*");
		assert_eq!(ere("a**"), "(?:a*)*");
		assert_eq!(ere("a{1,2}{2}"), "(?:a{1,2}){2}");
		assert_eq!(ere("a{1}?"), "(?:a{1})?");
		// One operator still binds to the atom alone.
		assert_eq!(ere("ab*"), "ab*");
		assert_eq!(ere("(ab)*"), "(ab)*");
	}

	#[test]
	fn caret_is_an_anchor_after_group_open_and_alternation() {
		// Measured: `grep '\(^alpha\)'` matches on GNU and BSD grep. Keying
		// this off "start of pattern" escaped the anchor and matched nothing.
		assert_eq!(bre(r"\(^a\)"), r"(^a)");
		assert_eq!(bre(r"a\|^b"), r"a|^b");
		assert_eq!(bre(r"\(^a\|^b\)"), r"(^a|^b)");
		// Still a literal where an atom precedes it.
		assert_eq!(bre(r"a^b"), r"a\^b");
		assert_eq!(bre(r"^a^"), r"^a\^");
	}

	#[test]
	fn caret_after_an_assertion_is_a_literal() {
		// If this regresses, `printf 'a\n^a\n' | grep -n '\<^a'` selects
		// `a`, where GNU selects nothing: glibc anchors `^` only first in a
		// branch, and `\<`, `\>`, `` \` `` and `\'` are tokens before it.
		assert_eq!(bre(r"\<^a"), r"\b(?=\w)\^a");
		assert_eq!(bre(r"\>^a"), r"\b(?<=\w)\^a");
		assert_eq!(bre(r"\`^a"), r"\A\^a");
		assert_eq!(bre(r"\'^a"), r"\z\^a");
		assert_eq!(bre(r"x\|\<^a"), r"x|\b(?=\w)\^a");
		assert_eq!(
			translate(r"\(\<^a\)", Dialect::Basic, Target::Rust, false, Strictness::Lenient).ok(),
			Some(r"(\<\^a)".to_owned())
		);
		// An ERE anchors it anywhere.
		assert_eq!(ere(r"\<^a"), r"\<^a");
	}

	#[test]
	fn bare_star_at_pattern_start_is_a_literal() {
		assert_eq!(bre(r"*x"), r"\*x");
	}

	#[test]
	fn bare_star_after_anchor_is_a_literal() {
		assert_eq!(bre(r"^*"), r"^\*");
	}

	#[test]
	fn repetition_after_group_open_is_a_literal() {
		assert_eq!(bre(r"\(\+a\)"), r"(\+a)");
		assert_eq!(bre(r"\(*a\)"), r"(\*a)");
	}

	#[test]
	fn repetition_after_alternation_is_a_literal() {
		assert_eq!(bre(r"a\|\+b"), r"a|\+b");
	}

	// The operator cases these must not break.

	#[test]
	fn repetition_with_an_operand_stays_an_operator() {
		assert_eq!(bre(r"a\+"), "a+");
		assert_eq!(bre(r"a\?"), "a?");
		assert_eq!(bre(r"a\{2\}"), "a{2}");
		assert_eq!(bre(r"a*"), "a*");
		assert_eq!(bre(r"^a\+"), "^a+");
		assert_eq!(bre(r"\(a\)\+"), "(a)+");
		assert_eq!(bre(r"[a-z]\+"), "[a-z]+");
		assert_eq!(bre(r".\+"), ".+");
	}

	#[test]
	fn an_unmatched_parenthesis_is_a_literal_only_in_grep_s_ere() {
		// `printf 'a)\n' | grep -cE 'a)'` is 1, while `grep 'a\)'`,
		// `sed 's/a\)/X/'` and `sed -E 's/a)/X/'` are "Unmatched ) or \)".
		assert_eq!(ere("a)"), r"a\)");
		assert_eq!(ere("(a)b)"), r"(a)b\)");
		assert_eq!(bre_err(r"a\)"), Some(BreError::ParenUnmatched));
		assert_eq!(
			translate(r"a\)", Dialect::Basic, Target::Rust, false, Strictness::Lenient).err(),
			Some(BreError::ParenUnmatched)
		);
		assert_eq!(
			translate("a)", Dialect::Extended, Target::Fancy, false, Strictness::Sed).err(),
			Some(BreError::ParenUnmatched)
		);
	}

	#[test]
	fn sed_refuses_the_repetitions_grep_reads_leniently() {
		// GNU sed 4.9: "Invalid preceding regular expression" for each, where
		// GNU grep drops the operator or matches the text.
		let sed_ere = |pattern: &str| translate(pattern, Dialect::Extended, Target::Fancy, false, Strictness::Sed);
		for pattern in ["*x", "a|*b", "(*x)", "^*", "a$*", "a^*", "{2}x"] {
			assert_eq!(sed_ere(pattern).err(), Some(BreError::RepetitionOperandMissing), "{pattern}");
		}
		// Repeating a repetition is fine in GNU sed's ERE.
		for pattern in ["a**", "a+*", "a*+", "a{2}*", "a*{2}", "x+?"] {
			assert!(sed_ere(pattern).is_ok(), "{pattern}");
		}
		// Its BRE takes `\+` and `\?` after a repetition, but not `*` or an
		// interval: `sed 's/a**/X/'` is refused, `sed 's/a*\+/X/'` is not.
		for pattern in [r"a**", r"a\+*", r"a\{2\}*", r"a\?*", r"\(a\)**", r"x*\{2\}"] {
			assert_eq!(bre_err(pattern), Some(BreError::RepetitionOperandMissing), "{pattern}");
		}
		for pattern in [r"a*\+", r"a*\?", r"a\+\?", r"*x", r"^*x", r"\+x", r"a\|*x"] {
			assert_eq!(bre_err(pattern), None, "{pattern}");
		}
		// GNU grep reads every one of them.
		for pattern in [r"a**", r"a\{2\}*", r"x*\{2\}"] {
			assert!(translate(pattern, Dialect::Basic, Target::Rust, false, Strictness::Lenient).is_ok(), "{pattern}");
		}
		// So does GNU nl: `printf 'aa\n' | nl -bp'a**'` numbers the line,
		// and a leading interval is the text it spells there, as for grep.
		let nl_bre =
			|pattern: &str| translate(pattern, Dialect::Basic, Target::Fancy, false, Strictness::Lenient);
		assert_eq!(nl_bre(r"a**"), Ok(r"(?:a*)*".to_owned()));
		assert_eq!(nl_bre(r"a*\{2\}"), Ok(r"(?:a*){2}".to_owned()));
		assert_eq!(nl_bre(r"\{1,3\}a"), Ok(r"\{1,3\}a".to_owned()));
	}

	#[test]
	fn a_back_reference_names_a_group_closed_in_its_own_branch() {
		// GNU: "Invalid back reference" for a group another branch holds, a
		// group not yet closed, and no group at all.
		for pattern in [r"\(a\)\|\(b\)\1", r"\(a\1\)", r"\1", r"\(a\)\2"] {
			assert_eq!(bre_err(pattern), Some(BreError::BackReferenceInvalid), "{pattern}");
		}
		assert_eq!(
			translate(r"(a)|b\1", Dialect::Extended, Target::Pcre, false, Strictness::Lenient).err(),
			Some(BreError::BackReferenceInvalid)
		);
		// A group closed before the enclosing group opened stays nameable in
		// each of its branches, and so does a group of the same branch.
		for pattern in [r"\(a\)\(b\|\1\)", r"\(a\)\|\(b\)\2", r"\(a\)\1"] {
			assert_eq!(bre_err(pattern), None, "{pattern}");
		}
		// Once a group closes, so do the groups its branches closed:
		// `printf 'aa\n' | grep '\(\(a\)\|b\)\2'` prints `aa`, in sed and
		// with -E too, while a later branch inside it cannot name them.
		assert_eq!(bre_err(r"\(\(a\)\|b\)\2"), None);
		assert_eq!(bre_err(r"\(\(a\)\|b\|c\)\2"), None);
		assert_eq!(
			translate(r"((a)|b)\2", Dialect::Extended, Target::Fancy, false, Strictness::Sed).err(),
			None
		);
		assert_eq!(
			translate(r"((a)|b)\2", Dialect::Extended, Target::Pcre, false, Strictness::Lenient).err(),
			None
		);
		assert_eq!(bre_err(r"\(\(a\)\|b\2\)"), Some(BreError::BackReferenceInvalid));
	}

	// ── A backslash before an ordinary character ─────────────────────────────

	#[test]
	fn a_backslash_before_an_ordinary_character_is_that_character() {
		// `printf 'd1\n' | grep -o '\d'` prints `d`, and `grep -c '\x'`
		// counts the lines holding an `x`.
		assert_eq!(bre(r"\d"), "d");
		assert_eq!(bre(r"\x"), "x");
		assert_eq!(ere(r"\d"), "d");
		assert_eq!(bre(r"\n"), "n");
		// The escapes GNU does define keep their meaning.
		assert_eq!(bre(r"\w\W\s\S\b\B"), r"\w\W\s\S\b\B");
		assert_eq!(bre(r"\`a\'"), r"\Aa\z");
		assert_eq!(bre(r"\."), r"\.");
		assert_eq!(bre(r"\*"), r"\*");
	}

	#[test]
	fn the_word_edges_are_written_for_the_engine() {
		assert_eq!(translate(r"\<a\>", Dialect::Basic, Target::Rust, false, Strictness::Lenient).unwrap(), r"\<a\>");
		assert_eq!(
			translate(r"\<a\>", Dialect::Basic, Target::Fancy, false, Strictness::Sed).unwrap(),
			r"\b(?=\w)a\b(?<=\w)"
		);
	}

	// ── Bracket expressions ──────────────────────────────────────────────────
	// POSIX has no nested class and no set operation inside `[...]`; the
	// `regex` crate has both, so a member it would read as syntax is written
	// escaped. Each pattern's meaning below is GNU grep 3.11's.

	#[test]
	fn bracket_members_the_regex_crate_reads_as_syntax_are_escaped() {
		// `[` is a member: `[[]` selects `[`, and `[[:space:]*?[]` a space,
		// `*`, `?` or `[`.
		assert_eq!(bre("[[]"), r"[\[]");
		assert_eq!(bre("[[:space:]*?[]"), r"[[:space:]*?\[]");
		// `&&` and `~~` are two members each, not set operations.
		assert_eq!(bre("[a&&b]"), r"[a\&\&b]");
		assert_eq!(bre("[~~]"), r"[\~\~]");
		// A `-` right after a range's own is the range's end; first or last in
		// the list a `-` is a member.
		assert_eq!(bre("[!--]"), r"[!-\-]");
		assert_eq!(bre("[--/]"), r"[\--/]");
		assert_eq!(bre("[%--a]"), r"[%-\-a]");
		assert_eq!(bre("[-a]"), r"[\-a]");
		assert_eq!(bre("[a-]"), r"[a\-]");
		assert_eq!(bre("[--]"), r"[\-\-]");
		assert_eq!(bre("[a-z-]"), r"[a-z\-]");
		// A `^` that does not negate.
		assert_eq!(bre("[a^]"), r"[a\^]");
	}

	#[test]
	fn common_bracket_expressions_keep_their_meaning() {
		assert_eq!(bre("[a-z]"), "[a-z]");
		assert_eq!(bre("[^x]"), "[^x]");
		// `]` first in the list, or first after `^`, is a member.
		assert_eq!(bre("[]a]"), r"[\]a]");
		assert_eq!(bre("[^]a]"), r"[^\]a]");
		assert_eq!(bre("[]-a]"), r"[\]-a]");
		assert_eq!(bre("[[:digit:][:space:]-]"), r"[[:digit:][:space:]\-]");
		// `\` is a member, so `[\]]` is a backslash and then a `]`. Outside a
		// bracket expression `\]` is still a `]`.
		assert_eq!(bre(r"[\]]"), r"[\\]]");
		assert_eq!(bre(r"a\]"), r"a\]");
	}

	#[test]
	fn the_letter_classes_are_written_as_their_unicode_property() {
		// GNU in a UTF-8 locale counts `ß` as [[:alpha:]], where the `regex`
		// crate's POSIX class holds ASCII alone.
		assert_eq!(bre("[[:alpha:]]"), r"[\p{Alphabetic}]");
		assert_eq!(bre("[[:alnum:]x]"), r"[\p{Alphabetic}\p{Nd}x]");
		assert_eq!(bre("[^[:upper:]]"), r"[^\p{Uppercase}]");
		assert_eq!(bre("[[:lower:]]"), r"[\p{Lowercase}]");
		// The other classes keep their POSIX definition.
		assert_eq!(bre("[[:digit:]]"), "[[:digit:]]");
		assert_eq!(bre("[[:space:]]"), "[[:space:]]");
		// PCRE2 for a line that is not UTF-8 runs without PCRE2_UCP, where
		// its POSIX class is ASCII, as GNU's is in the C locale.
		assert_eq!(
			translate("[[:alpha:]]", Dialect::Basic, Target::PcreBytes, false, Strictness::Lenient).unwrap(),
			"[[:alpha:]]"
		);
	}

	#[test]
	fn pcre2_classes_mean_what_they_mean_to_the_regex_crate() {
		// If this regresses, one back-reference among the patterns sends
		// them all to PCRE2, whose PCRE2_UCP classes are not GNU's:
		// `printf 'x\331\240\n' | grep -c -e '[[:digit:]]$' -e '\(y\)\1'`
		// counts the line, where GNU counts 0, and `Ⅻ` is no `[[:alpha:]]`.
		let pcre = |pattern: &str, icase: bool| {
			translate(pattern, Dialect::Basic, Target::Pcre, icase, Strictness::Lenient).unwrap()
		};
		assert_eq!(pcre("[[:digit:]]", false), "[0-9]");
		assert_eq!(pcre("[^[:xdigit:]]", false), "[^0-9A-Fa-f]");
		assert_eq!(pcre("[[:alpha:]]", false), r"[\p{Alphabetic}]");
		assert_eq!(pcre("[[:alnum:]]", false), r"[\p{Alphabetic}\p{Nd}]");
		assert_eq!(pcre("[[:lower:]]", false), r"[\p{Lowercase}]");
		assert_eq!(pcre("[[:upper:]]", false), r"[\p{Uppercase}]");
		// The other classes are the regex crate's ASCII ones: `printf
		// 'x\302\240\n' | grep -c -e '[[:space:]]$' -e '\(y\)\1'` is 0.
		assert_eq!(pcre("[[:space:]]", false), r"[\x09-\x0D\x20]");
		assert_eq!(pcre("[^[:blank:]]", false), r"[^\x09\x20]");
		assert_eq!(pcre("[[:cntrl:]]", false), r"[\x00-\x1F\x7F]");
		assert_eq!(pcre("[[:graph:]]", false), r"[\x21-\x7E]");
		assert_eq!(pcre("[[:print:]]", false), r"[\x20-\x7E]");
		assert_eq!(pcre("[[:punct:]]", false), r"[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]");
		// Without case `lower` and `upper` are `alpha`, as glibc reads them:
		// PCRE2 folds no Unicode property, and `printf 'A\n' | grep -ci -e
		// '^[[:lower:]]$' -e '\(y\)\1'` counts the line.
		assert_eq!(pcre("[[:lower:]]", true), r"[\p{Alphabetic}]");
		assert_eq!(pcre("[[:upper:]]", true), r"[\p{Alphabetic}]");
		assert_eq!(
			translate("[[:lower:]]", Dialect::Basic, Target::Rust, true, Strictness::Lenient).unwrap(),
			r"[\p{Alphabetic}]"
		);
		assert_eq!(
			translate("[[:digit:]]", Dialect::Basic, Target::PcreBytes, false, Strictness::Lenient).unwrap(),
			"[[:digit:]]"
		);
	}

	#[test]
	fn collating_symbols_and_equivalence_classes_are_their_character() {
		assert_eq!(bre("[[.-.]]"), r"[\-]");
		assert_eq!(bre("[[.].]]"), r"[\]]");
		assert_eq!(bre("[[...]]"), "[.]");
		assert_eq!(bre("[[=a=]]"), "[a]");
		assert_eq!(bre("[[.a.]-b]"), "[a-b]");
		assert_eq!(bre("[a-[.z.]]"), "[a-z]");
	}

	#[test]
	fn invalid_bracket_expressions_are_refused_as_gnu_grep_refuses_them() {
		for (pattern, error) in [
			("[[:foo:]]", BreError::ClassNameInvalid),
			// Names the `regex` crate knows and POSIX does not.
			("[[:ascii:]]", BreError::ClassNameInvalid),
			("[[:^alpha:]]", BreError::ClassNameInvalid),
			("[[::]]", BreError::ClassNameInvalid),
			("[[.ab.]]", BreError::CollationInvalid),
			("[[..]]", BreError::CollationInvalid),
			("[[==]]", BreError::CollationInvalid),
			// A collating symbol of a multibyte character: GNU knows the
			// single-byte ones alone.
			("[[.é.]]", BreError::CollationInvalid),
			("[[=é=]]", BreError::CollationInvalid),
			("[z-a]", BreError::RangeEndInvalid),
			("[a--]", BreError::RangeEndInvalid),
			("[a-b-z]", BreError::RangeEndInvalid),
			("[[:alpha:]-z]", BreError::RangeEndInvalid),
			("[[=a=]-z]", BreError::RangeEndInvalid),
			("[a-[:alpha:]]", BreError::RangeEndInvalid),
			("[a-[=z=]]", BreError::RangeEndInvalid),
			// A class name written without its outer brackets.
			("[:alpha:]", BreError::ClassSyntaxConfused),
			("[:x:]", BreError::ClassSyntaxConfused),
			("[^:alpha:]", BreError::ClassSyntaxConfused),
		] {
			assert_eq!(bre_err(pattern), Some(error), "{pattern}");
		}
	}

	#[test]
	fn the_confused_class_syntax_is_reported_after_every_other_error() {
		// If this regresses, `echo x | sed 's/[:alpha:][z-a]/x/'` exits 4
		// with the class-syntax message, where GNU sed prints "Invalid range
		// end" and exits 1: GNU reports an error of the rest of the pattern
		// first.
		assert_eq!(bre_err("[:alpha:][z-a]"), Some(BreError::RangeEndInvalid));
		assert_eq!(bre_err(r"[:alpha:]a\{1"), Some(BreError::BraceUnmatched));
		assert_eq!(ere_err("[:alpha:](a|b)x[[:foo:]]"), Some(BreError::ClassNameInvalid));
		assert_eq!(bre_err("[:alpha:]x"), Some(BreError::ClassSyntaxConfused));
		// A group still open is reported first, with glibc's message: `sed
		// 's/[:alpha:]\(/x/'` is "Unmatched ( or \(", exit 1.
		assert_eq!(bre_err(r"[:alpha:]\("), Some(BreError::GroupUnclosed));
		assert_eq!(bre_err(r"\([:alpha:]"), Some(BreError::GroupUnclosed));
		assert_eq!(
			translate("[:alpha:](", Dialect::Extended, Target::Fancy, false, Strictness::Sed).err(),
			Some(BreError::GroupUnclosed)
		);
		// As in grep: `grep -E '(a'` is "Unmatched ( or \(".
		assert_eq!(ere_err("(a"), Some(BreError::GroupUnclosed));
		assert_eq!(bre_err(r"\([:alpha:]\)"), Some(BreError::ClassSyntaxConfused));
	}

	#[test]
	fn a_list_of_colons_alone_is_not_the_confused_class_syntax() {
		// Measured: `grep -c '[::]'`, `grep -c '[:]'`, `grep -c '[:ab]'`,
		// `grep -c '[a:b:]'` and `grep -c '[:-:]'` all search and exit 0 or 1,
		// and so do the lists holding a range, a class, a collating symbol or
		// an equivalence class between the colons.
		for pattern in [
			"[::]",
			"[:]",
			"[:ab]",
			"[a:b:]",
			"[:-:]",
			"[x[:alpha:]]",
			"[:a-z:]",
			"[:[:digit:]:]",
			"[:x[=a=]:]",
			"[:x[.a.]:]",
		] {
			assert_eq!(bre_err(pattern), None, "{pattern}");
		}
	}

	#[test]
	fn a_range_is_checked_against_the_ends_case_folding_gives_it() {
		// `grep -ci '[Z-a]'` is "Invalid range end" where `grep -c '[Z-a]'`
		// searches, because `-i` folds the ends to `Z` and `A`.
		assert_eq!(translate("[Z-a]", Dialect::Basic, Target::Rust, false, Strictness::Lenient).ok(), Some(r"[Z-a]".to_owned()));
		assert_eq!(
			translate("[Z-a]", Dialect::Basic, Target::Rust, true, Strictness::Lenient).err(),
			Some(BreError::RangeEndInvalid)
		);
		assert_eq!(
			translate(r"[\-a]", Dialect::Basic, Target::Rust, true, Strictness::Lenient).err(),
			Some(BreError::RangeEndInvalid)
		);
		// `[A-z]` folds to `A` and `Z`, a range either way.
		assert!(translate("[A-z]", Dialect::Basic, Target::Rust, true, Strictness::Lenient).is_ok());
	}

	#[test]
	fn a_range_is_written_with_the_ends_it_was_checked_with() {
		// If this regresses, `printf 'b\n' | grep -ic '[a-Z]'` exits 2 on the
		// engine's refusal of `[a-Z]`, where GNU counts 1, and `grep -ic
		// '[A-z]'` selects `_`, where GNU does not: GNU's range under `-i`
		// runs between the folded ends.
		let icase = |pattern: &str, target: Target| {
			translate(pattern, Dialect::Basic, target, true, Strictness::Lenient).unwrap()
		};
		assert_eq!(icase("[a-Z]", Target::Rust), "[A-Z]");
		assert_eq!(icase("[A-z]", Target::Rust), "[A-Z]");
		assert_eq!(icase("[a-~]", Target::Pcre), "[A-\\~]");
		assert_eq!(icase("[!--]", Target::Fancy), r"[!-\-]");
		// Read with case the range is written as it stands.
		assert_eq!(bre("[a-z]"), "[a-z]");
	}

	/// GNU grep 3.11 refuses each with "Unmatched [, [^, [:, [., or [=".
	#[test]
	fn unterminated_bracket_expressions_are_refused() {
		for pattern in [
			"[[:alpha]]",
			"[[.a]b]",
			"[[=a]b]",
			"[a[:]b]",
			"a[b",
			"x[]",
			"[]",
			"[^]",
			"[[:alpha:]",
			r"\([a\)",
		] {
			assert_eq!(bre_err(pattern), Some(BreError::BracketUnmatched), "{pattern}");
		}
	}

	#[test]
	fn ere_bracket_expressions_are_read_as_in_a_bre() {
		assert_eq!(ere("[[]"), r"[\[]");
		assert_eq!(ere("[[:space:]*?[]"), r"[[:space:]*?\[]");
		assert_eq!(ere("[a&&b]+"), r"[a\&\&b]+");
		assert_eq!(ere("[~~]"), r"[\~\~]");
		assert_eq!(ere("[!--]"), r"[!-\-]");
		// `\` is a member inside a bracket expression and an escape outside.
		assert_eq!(ere(r"[\(]|\("), r"[\\(]|\(");
		assert_eq!(ere(r"[\]]"), r"[\\]]");
		// A brace is a literal inside a bracket expression, and outside one
		// unless it opens an interval.
		assert_eq!(ere("[{]{a}a{2}"), r"[{]\{a\}a{2}");
	}

	#[test]
	fn ere_invalid_bracket_expressions_are_refused() {
		for (pattern, error) in [
			("a[", BreError::BracketUnmatched),
			("[]", BreError::BracketUnmatched),
			("[[:alpha:]", BreError::BracketUnmatched),
			("[[:foo:]]", BreError::ClassNameInvalid),
			("[[.ab.]]", BreError::CollationInvalid),
			("[z-a]", BreError::RangeEndInvalid),
			("[:alpha:]", BreError::ClassSyntaxConfused),
		] {
			assert_eq!(ere_err(pattern), Some(error), "{pattern}");
		}
	}

	// ── Alternatives ─────────────────────────────────────────────────────────

	#[cfg(any(feature = "util.grep", feature = "util.sed"))]
	#[test]
	fn a_pattern_without_alternation_is_its_own_only_alternative() {
		for pattern in ["abc", "a[|]b", r"a\|b", "(a)*"] {
			assert_eq!(alternatives(pattern, Dialect::Extended, Split::Grep), vec![pattern.to_owned()]);
		}
	}

	#[cfg(any(feature = "util.grep", feature = "util.sed"))]
	#[test]
	fn an_alternation_is_split_into_its_branches() {
		assert_eq!(alternatives("a|ab", Dialect::Extended, Split::Grep), vec!["a", "ab"]);
		assert_eq!(alternatives("a||b", Dialect::Extended, Split::Grep), vec!["a", "", "b"]);
		assert_eq!(alternatives(r"q\?\|zz", Dialect::Basic, Split::Grep), vec![r"q\?", "zz"]);
		// A bracket expression and an escape hold no alternation.
		assert_eq!(alternatives(r"[a|b]|c", Dialect::Extended, Split::Grep), vec!["[a|b]", "c"]);
		assert_eq!(alternatives(r"a\|b|c", Dialect::Extended, Split::Grep), vec![r"a\|b", "c"]);
	}

	#[cfg(any(feature = "util.grep", feature = "util.sed"))]
	#[test]
	fn a_group_no_repetition_follows_is_distributed() {
		assert_eq!(alternatives("(|zz)", Dialect::Extended, Split::Grep), vec!["()", "(zz)"]);
		assert_eq!(alternatives("x(a|b)y", Dialect::Extended, Split::Grep), vec!["x(a)y", "x(b)y"]);
		assert_eq!(alternatives(r"\(a\|b\)", Dialect::Basic, Split::Grep), vec![r"\(a\)", r"\(b\)"]);
		// A repeated group matches more than once, so its branches are not
		// the pattern's: `(a|ab)*` is left whole.
		assert_eq!(alternatives("(a|ab)*", Dialect::Extended, Split::Grep), vec!["(a|ab)*"]);
		assert_eq!(alternatives(r"\(a\|b\)\+", Dialect::Basic, Split::Grep), vec![r"\(a\|b\)\+"]);
		// sed splits the top level alone.
		assert_eq!(alternatives("(a|b)|c", Dialect::Extended, Split::Sed), vec!["(a|b)", "c"]);
	}

	#[cfg(any(feature = "util.grep", feature = "util.sed"))]
	#[test]
	fn a_pattern_holding_a_back_reference_is_not_split() {
		// A branch alone numbers its groups from 1, so `\2` would name a
		// different group, or none.
		for pattern in [r"\(a\)\|\(b\)\2", r"\(b\)\|\(b\)\(c\)\2"] {
			assert_eq!(alternatives(pattern, Dialect::Basic, Split::Grep), vec![pattern.to_owned()]);
			assert_eq!(alternatives(pattern, Dialect::Basic, Split::Sed), vec![pattern.to_owned()]);
		}
		assert_eq!(alternatives(r"(a)|(b)\2", Dialect::Extended, Split::Sed), vec![r"(a)|(b)\2"]);
		// grep leaves any pattern holding one whole.
		assert_eq!(alternatives(r"x\|\(x\)\1", Dialect::Basic, Split::Grep), vec![r"x\|\(x\)\1"]);
	}

	#[cfg(any(feature = "util.grep", feature = "util.sed"))]
	#[test]
	fn sed_splits_where_each_reference_keeps_its_group() {
		// `echo xx | sed 's/x\|\(x\)\1/Y/'` prints `Y`: no branch before the
		// back-reference's opens a group, so it names the same one alone.
		assert_eq!(alternatives(r"x\|\(x\)\1", Dialect::Basic, Split::Sed), vec!["x", r"\(x\)\1"]);
		assert_eq!(alternatives(r"x|(x)\1", Dialect::Extended, Split::Sed), vec!["x", r"(x)\1"]);
		// A back-reference in the first branch keeps its group as well.
		assert_eq!(alternatives(r"\(x\)y\1\|x", Dialect::Basic, Split::Sed), vec![r"\(x\)y\1", "x"]);
		// A bracket expression opens no group.
		assert_eq!(alternatives(r"[(]|(x)\1", Dialect::Extended, Split::Sed), vec!["[(]", r"(x)\1"]);
	}

	#[cfg(any(feature = "util.grep", feature = "util.sed"))]
	#[test]
	fn an_unterminated_group_leaves_the_pattern_whole() {
		assert_eq!(alternatives("(a|b", Dialect::Extended, Split::Grep), vec!["(a|b"]);
	}

	#[cfg(any(feature = "util.grep", feature = "util.sed"))]
	#[test]
	fn an_expansion_beyond_the_limit_leaves_the_pattern_whole() {
		let pattern = "(a|b)(c|d)(e|f)(g|h)(i|j)(k|l)(m|n)";
		assert_eq!(alternatives(pattern, Dialect::Extended, Split::Grep), vec![pattern.to_owned()]);
	}

	#[cfg(any(feature = "util.grep", feature = "util.sed"))]
	#[test]
	fn groups_nested_past_the_limit_leave_the_pattern_whole() {
		// If this regresses, a `sed -E` pattern nested 100,000 groups deep
		// with a `|` overflows the stack while it is split and aborts the
		// whole process, where it should fail as an invalid regex.
		let deep = format!("{}a|b{}", "(".repeat(100_000), ")".repeat(100_000));
		assert_eq!(alternatives(&deep, Dialect::Extended, Split::Sed), [deep.as_str()]);
		let unclosed = format!("{}a|b", "(".repeat(100_000));
		assert_eq!(alternatives(&unclosed, Dialect::Extended, Split::Grep), [unclosed.as_str()]);
		let basic = format!("{}a\\|b", r"\(".repeat(100_000));
		assert_eq!(alternatives(&basic, Dialect::Basic, Split::Sed), [basic.as_str()]);
		// Up to the limit a top-level alternation is still split.
		let nested = |depth: usize| format!("x|{}a{}", "(".repeat(depth), ")".repeat(depth));
		assert_eq!(alternatives(&nested(64), Dialect::Extended, Split::Sed).len(), 2);
		assert_eq!(alternatives(&nested(65), Dialect::Extended, Split::Sed), [nested(65)]);
	}

	#[cfg(any(feature = "util.grep", feature = "util.sed"))]
	#[test]
	fn a_cached_match_is_searched_again_only_once_it_is_passed() {
		// If this regresses, `grep -o` and `sed` search each alternative
		// again at every position of a line, or miss a match they kept.
		let mut cached = None;
		assert_eq!(next_match(&mut cached, 0, || Ok::<_, ()>(Some((3, 5)))), Ok(Some((3, 5))));
		// A position at or before the match keeps it without a search.
		assert_eq!(next_match(&mut cached, 3, || Err(())), Ok(Some((3, 5))));
		// A position past its start is searched again.
		assert_eq!(next_match(&mut cached, 4, || Ok::<_, ()>(None)), Ok(None));
		// No match from a position is none from a later one either.
		assert_eq!(next_match(&mut cached, 9, || Err(())), Ok(None));
	}

	#[cfg(feature = "util.grep")]
	#[test]
	fn a_literal_holds_no_character_its_dialect_reads_as_special() {
		// If this regresses, `grep -o` searches a pattern holding an operator
		// as a plain string, and prints its text instead of its matches.
		assert!(is_literal("abc def", Dialect::Basic));
		assert!(is_literal("a+b?{c}(d)|e]", Dialect::Basic));
		assert!(is_literal("a}b]", Dialect::Extended));
		for pattern in [r"a\.b", "a.b", "[ab]", "a*", "^a", "a$"] {
			assert!(!is_literal(pattern, Dialect::Basic), "{pattern}");
			assert!(!is_literal(pattern, Dialect::Extended), "{pattern}");
		}
		for pattern in ["a+", "a?", "a{2}", "(a)", "a|b"] {
			assert!(!is_literal(pattern, Dialect::Extended), "{pattern}");
		}
	}

	/// A pattern byte that is no UTF-8 is that byte for an engine that reads
	/// a byte to a character, in a bracket expression too, as GNU grep 3.11
	/// reads it in the C locale. For one that reads characters it is that
	/// byte outside a bracket expression, no member inside one, and the
	/// character of its value as a range's end, as GNU grep 3.11 reads it in
	/// the C.UTF-8 locale; so it is in that locale for the engine that reads
	/// a line that is not UTF-8 a byte to a character, where a member
	/// outside ASCII is the whole UTF-8 sequence of a character.
	#[test]
	fn a_pattern_byte_that_is_no_utf8_is_that_byte() {
		// If this regresses, `grep $'\351'` selects no line holding the byte
		// 0xE9, or `grep $'[\351]'` selects one in a UTF-8 locale, where
		// GNU's selects none, or `LC_ALL=C grep $'[\xc3-\xc3\xa9]'` is
		// "Invalid range end", where GNU reads the range C3-C3, or in a UTF-8
		// locale `[\300-\377]` matches the byte 0xA9 alone of a line that is
		// not UTF-8.
		let translated = |pattern: &[u8], target: Target, utf8_locale: bool| {
			let (text, raw) = pattern_text(pattern);
			assert!(raw, "{pattern:?}");
			translate_raw(&text, Dialect::Basic, target, false, PatternBytes { raw, utf8_locale })
		};
		// The C locale reads a byte to a character, the C.UTF-8 one does not.
		let raw = |pattern: &[u8], target: Target| translated(pattern, target, !target.reads_bytes());
		assert_eq!(raw(b"caf\xe9", Target::RustBytes), Ok(r"caf\xE9".to_owned()));
		assert_eq!(raw(b"caf\xe9", Target::Rust), Ok(r"caf(?-u:\xE9)".to_owned()));
		assert_eq!(raw(b"\xe9*", Target::Rust), Ok(r"(?-u:\xE9)*".to_owned()));
		assert_eq!(raw(b"\\\xe9", Target::RustBytes), Ok(r"\xE9".to_owned()));
		assert_eq!(raw(b"\xc3", Target::PcreBytes), Ok(r"\x{C3}".to_owned()));
		assert_eq!(raw(b"\xc3", Target::Pcre), Ok("(?!)".to_owned()));
		assert_eq!(raw(b"[a\xe9]", Target::RustBytes), Ok(r"[a\xE9]".to_owned()));
		assert_eq!(raw(b"[^\xe9]", Target::RustBytes), Ok(r"[^\xE9]".to_owned()));
		assert_eq!(raw(b"[a\xe9]", Target::Rust), Ok("[a]".to_owned()));
		assert_eq!(raw(b"[\xe9]", Target::Rust), Ok(r"[^\x00-\x{10FFFF}]".to_owned()));
		assert_eq!(raw(b"[^\xe9]", Target::Rust), Ok(r"[\x00-\x{10FFFF}]".to_owned()));
		assert_eq!(raw(b"[\xe9-\xff]", Target::Rust), Ok("[\u{e9}-\u{ff}]".to_owned()));
		assert_eq!(raw(b"[\xe9-\xff]", Target::RustBytes), Ok(r"[\xE9-\xFF]".to_owned()));
		assert_eq!(raw(b"[\xff-\xe9]", Target::RustBytes), Err(BreError::RangeEndInvalid));
		// In the C locale a range is checked on the bytes the engine gets:
		// the last of its start's and the first of its end's.
		assert_eq!(raw(b"[\xc3-\xc3\xa9]", Target::RustBytes), Ok("[\\xC3-\u{e9}]".to_owned()));
		assert_eq!(raw(b"[\xc3-\xa9]", Target::RustBytes), Err(BreError::RangeEndInvalid));
		assert_eq!(raw(b"[\xc3\xa9-\xc3\x9f\xff]", Target::RustBytes), Ok("[\u{e9}-\u{df}\\xFF]".to_owned()));
		// In a UTF-8 locale a line that is not UTF-8 reads the bracket as the
		// text engine does, each member outside ASCII as the whole UTF-8
		// sequence of a character, and a list that negates matches no
		// encoding error.
		let utf8 = |pattern: &[u8], target: Target| translated(pattern, target, true);
		assert_eq!(utf8(b"[\xe9]", Target::RustBytes), Ok(r"[^\x00-\xFF]".to_owned()));
		assert_eq!(utf8(b"f[a\xe9]", Target::RustBytes), Ok("f[a]".to_owned()));
		assert_eq!(utf8(b"[\xc0-\xff]", Target::RustBytes), Ok(r"(?:\xC3[\x80-\xBF])".to_owned()));
		assert_eq!(utf8(b"[a\xc0-\xff]", Target::RustBytes), Ok(r"(?:[a]|\xC3[\x80-\xBF])".to_owned()));
		assert_eq!(utf8(b"[\xc0-\xff]", Target::PcreBytes), Ok(r"(?:\x{C3}[\x{80}-\x{BF}])".to_owned()));
		assert_eq!(utf8(b"[a-\xe9]", Target::RustBytes), Ok(r"(?:[a-\x7F]|\xC2[\x80-\xBF]|\xC3[\x80-\xA9])".to_owned()));
		assert_eq!(utf8(b"[\xff-\xc0]", Target::RustBytes), Err(BreError::RangeEndInvalid));
		assert_eq!(
			utf8(b"[^\xe9]", Target::RustBytes),
			Ok(concat!(
				r"(?:[^\x80-\xFF]|[\xC2-\xDF][\x80-\xBF]|\xE0[\xA0-\xBF][\x80-\xBF]",
				r"|[\xE1-\xEC][\x80-\xBF][\x80-\xBF]|\xED[\x80-\x9F][\x80-\xBF]",
				r"|[\xEE-\xEF][\x80-\xBF][\x80-\xBF]|\xF0[\x90-\xBF][\x80-\xBF][\x80-\xBF]",
				r"|[\xF1-\xF3][\x80-\xBF][\x80-\xBF][\x80-\xBF]|\xF4[\x80-\x8F][\x80-\xBF][\x80-\xBF])"
			)
			.to_owned())
		);
		// Without case a range whose ends are pattern bytes holds each
		// character whose upper case it holds, as GNU gives it: `[\300-\301]`
		// holds `á`, `[\340-\341]` nothing. The text engine reads it with
		// case.
		let folded = |pattern: &[u8], target: Target| {
			let text = pattern_text(pattern).0;
			translate_raw(&text, Dialect::Basic, target, true, PatternBytes { raw: true, utf8_locale: true })
		};
		assert_eq!(folded(b"[\xc0-\xc1]", Target::RustBytes), Ok(r"(?:\xC3[\x80-\x81]|\xC3[\xA0-\xA1])".to_owned()));
		assert_eq!(folded(b"[\xe0-\xe1]", Target::RustBytes), Ok(r"[^\x00-\xFF]".to_owned()));
		assert_eq!(folded(b"[\xc0-\xc1]", Target::Rust), Ok("(?-i:[\u{c0}-\u{c1}\u{e0}-\u{e1}])".to_owned()));
		assert_eq!(folded(b"[a\xc0-\xc1]", Target::Rust), Ok("(?-i:[aA\u{c0}-\u{c1}\u{e0}-\u{e1}])".to_owned()));
		assert_eq!(folded(b"[\xe0-\xe1]", Target::Rust), Ok(r"[^\x00-\x{10FFFF}]".to_owned()));
		assert_eq!(folded(b"[^\xe0-\xe1]", Target::Rust), Ok(r"[\x00-\x{10FFFF}]".to_owned()));
		// UTF-8 stays text, and the bytes come back as they were.
		assert_eq!(pattern_text("café".as_bytes()), ("café".to_owned(), false));
		assert_eq!(pattern_bytes(&pattern_text(b"a\xe9\xc3\xa9\xff").0), b"a\xe9\xc3\xa9\xff");
	}

	/// Without case grep's Unicode engines match a character's GNU
	/// counterparts, which their own folding gives otherwise for some.
	#[test]
	fn a_letter_without_case_is_its_gnu_counterparts() {
		// If this regresses, `printf '\342\204\252\n' | grep -ic k` (the
		// Kelvin sign) counts 1 where GNU grep 3.11 counts 0, or `printf
		// 'I\n' | grep -ic $'\304\261'` (`ı`) counts 0 where GNU counts 1.
		let icase = |pattern: &str, target: Target| {
			translate(pattern, Dialect::Basic, target, true, Strictness::Lenient).unwrap()
		};
		assert_eq!(icase("k", Target::Rust), "(?-i:[kK])");
		assert_eq!(icase("\u{212A}", Target::Rust), "(?-i:[\u{212A}])");
		assert_eq!(icase("\u{131}", Target::Pcre), "(?-i:[\u{131}Ii])");
		assert_eq!(icase("\u{e9}", Target::Rust), "(?-i:[\u{e9}\u{c9}])");
		assert_eq!(icase("\u{df}", Target::Rust), "(?-i:[\u{df}])");
		// Any other letter keeps the engine's folding, and sed's engine its
		// own.
		assert_eq!(icase("ab", Target::Rust), "ab");
		assert_eq!(icase("k\u{e9}", Target::Fancy), "k\u{e9}");
		assert_eq!(translate("k", Dialect::Basic, Target::Rust, false, Strictness::Lenient), Ok("k".to_owned()));
	}

	/// In a UTF-8 locale the engine for a line that is not UTF-8, which a
	/// pattern set with a back-reference reads it with, reads a bracket
	/// member outside ASCII as a whole character, of either case as GNU grep
	/// 3.11 gives it under `-i`.
	#[test]
	fn a_bracket_member_outside_ascii_is_a_whole_character_in_a_utf8_locale() {
		// If this regresses, `printf 'x\251\n' | grep -c -e '[é]' -e $'\377'`
		// counts 1 where GNU counts 0, or `-ic` with `[Σ\351]` misses `ς`.
		let utf8 = |pattern: &str, icase: bool| {
			let bytes = PatternBytes { raw: true, utf8_locale: true };
			translate_raw(pattern, Dialect::Basic, Target::RustBytes, icase, bytes)
		};
		assert_eq!(utf8("[é]", false), Ok(r"(?:\xC3\xA9)".to_owned()));
		assert_eq!(utf8("[^é]", false).map(|out| out.starts_with(r"(?:[^\x80-\xFF]|")), Ok(true));
		assert_eq!(utf8("[Σ]", true), Ok(r"(?:\xCE\xA3|\xCF[\x82-\x83])".to_owned()));
		assert_eq!(utf8("[s]", true), Ok(r"(?:[sS]|\xC5\xBF)".to_owned()));
		assert_eq!(utf8("[ı]", true), Ok(r"(?:[Ii]|\xC4\xB1)".to_owned()));
		// The Kelvin sign and `k` are no case of each other to GNU.
		assert_eq!(utf8("[\u{212A}]", true), Ok(r"(?:\xE2\x84\xAA)".to_owned()));
		assert_eq!(utf8("[k]", true), Ok("[kK]".to_owned()));
		// `ᾀ`'s simple upper case is the one character `ᾈ`.
		assert_eq!(utf8("[\u{1F80}]", true), Ok(r"(?:\xE1\xBE\x80|\xE1\xBE\x88)".to_owned()));
		// The C locale reads it a byte at a time.
		let c = PatternBytes { raw: false, utf8_locale: false };
		assert_eq!(translate_raw("[é]", Dialect::Basic, Target::RustBytes, false, c), Ok("[é]".to_owned()));
	}
}
