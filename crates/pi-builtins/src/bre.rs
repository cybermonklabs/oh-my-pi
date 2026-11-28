//! Shared POSIX basic-regular-expression translation.
//!
//! `grep`, `sed`, and `nl` accept BREs but compile them with different engines
//! (`grep-regex` for `grep`, `fancy-regex` for the others), neither of which
//! implements BRE syntax. This module converts a BRE into the ERE-compatible
//! form those engines accept, so the dialect is defined in exactly one place.

#[cfg(feature = "util.grep")]
use std::fmt::Write as _;

/// Whether the target engine supports back-references.
///
/// `sed` compiles with `fancy-regex`, which does; `grep` compiles with
/// `grep-regex` (the `regex` crate), which does not. When back-references are
/// unsupported the sequence is passed through unchanged, leaving the caller's
/// own compilation failure to decide what happens next.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code, reason = "each variant is used by a different utility feature")]
pub(crate) enum Backrefs {
	Supported,
	Unsupported,
}

/// What a BRE `\{` with nothing to repeat is, which the GNU tools read apart.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code, reason = "each variant is used by a different utility feature")]
pub(crate) enum LoneBrace {
	/// Text, as GNU grep and nl read it: `grep -c '\{'` counts a line
	/// holding `{`.
	Literal,
	/// An error, as GNU sed reads it.
	Invalid,
}

/// A pattern the BRE dialect cannot express.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum BreError {
	/// A repetition operator with nothing to repeat, where the tools error
	/// rather than treating the character as a literal.
	RepetitionOperandMissing,
	/// A bracket expression with no closing `]`, or a `[:`, `[.` or `[=` in
	/// one with no closing `:]`, `.]` or `=]`.
	UnmatchedBracket,
	/// A collating symbol or equivalence class that is not one byte, such as
	/// `[[.é.]]`: glibc's C and C.UTF-8 locales collate byte by byte.
	InvalidCollation,
	/// A class name without its outer brackets, such as `[:alpha:]`.
	#[cfg_attr(not(feature = "util.grep"), allow(dead_code, reason = "only grep refuses it"))]
	MisspelledClass,
	/// A range whose end sorts before its start, such as `[Z-a]` under `-i`.
	#[cfg_attr(not(feature = "util.grep"), allow(dead_code, reason = "only grep refuses it"))]
	InvalidRangeEnd,
	/// An ERE interval with a most below its least, or a third part, such as
	/// `a{1,2,3}` or `a{2,1}`.
	#[cfg_attr(not(feature = "util.grep"), allow(dead_code, reason = "only grep refuses it"))]
	InvalidInterval,
	/// An interval count above glibc's `RE_DUP_MAX`, 32767.
	#[cfg_attr(not(feature = "util.grep"), allow(dead_code, reason = "only grep refuses it"))]
	TooBig,
}

impl BreError {
	/// The message for this condition, in GNU's words where GNU refuses it.
	pub(crate) fn message(self) -> &'static str {
		match self {
			Self::RepetitionOperandMissing => "repetition-operator operand invalid",
			Self::UnmatchedBracket => "Unmatched [, [^, [:, [., or [=",
			Self::InvalidCollation => "Invalid collation character",
			Self::MisspelledClass => "character class syntax is [[:space:]], not [:space:]",
			Self::InvalidRangeEnd => "Invalid range end",
			Self::InvalidInterval => r"Invalid content of \{\}",
			Self::TooBig => "Regular expression too big",
		}
	}
}

/// glibc's `RE_DUP_MAX`, the largest count an interval may hold.
#[cfg(feature = "util.grep")]
const RE_DUP_MAX: u32 = 0x7fff;

/// An ERE interval, as glibc's `parse_dup_op` reads the text after its `{`.
#[cfg(feature = "util.grep")]
enum Interval {
	/// `{m}`, `{m,}` or `{m,n}`: the least count and the most, `None` for no
	/// most.
	Counts(u32, Option<u32>),
	/// The least count is missing, a count holds a character other than a
	/// digit, or the pattern ends inside the interval. GNU grep's ERE reads
	/// the brace as text.
	Malformed,
	/// A most below the least, or a third part.
	Invalid,
}

#[cfg(feature = "util.grep")]
impl Interval {
	/// Reads the interval after its `{` from `chars`.
	fn parse(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> Self {
		let (least, stop) = fetch_count(chars);
		let least = match least {
			Count::Number(least) => least,
			Count::Empty | Count::Bad => return Self::Malformed,
		};
		let (most, stop) =
			if stop == Stop::Close { (Count::Number(least), stop) } else { fetch_count(chars) };
		let most = match most {
			Count::Number(most) => Some(most),
			Count::Empty => None,
			Count::Bad => return Self::Malformed,
		};
		if stop != Stop::Close || most.is_some_and(|most| least > most) {
			return Self::Invalid;
		}
		Self::Counts(least, most)
	}
}

/// Append the interval of `least` to `most` counts in the engines' syntax.
#[cfg(feature = "util.grep")]
fn push_counts(result: &mut String, least: u32, most: Option<u32>) {
	let _ = match most {
		Some(most) if most == least => write!(result, "{{{least}}}"),
		Some(most) => write!(result, "{{{least},{most}}}"),
		None => write!(result, "{{{least},}}"),
	};
}

#[cfg(feature = "util.grep")]
enum Count {
	Empty,
	Number(u32),
	Bad,
}

#[cfg(feature = "util.grep")]
#[derive(PartialEq, Eq)]
enum Stop {
	Comma,
	Close,
	End,
}

/// glibc's `fetch_number`: a count read up to `,`, the closing brace or the
/// end of the pattern, where it is [`Count::Bad`]. Each count stops at
/// 32768, which is already too big.
#[cfg(feature = "util.grep")]
fn fetch_count(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> (Count, Stop) {
	let mut count = Count::Empty;
	loop {
		let (c, escaped) = match chars.next() {
			None => return (Count::Bad, Stop::End),
			Some('\\') => match chars.next() {
				Some(c) => (c, true),
				None => return (Count::Bad, Stop::End),
			},
			Some('}') => return (count, Stop::Close),
			Some(c) => (c, false),
		};
		if c == ',' {
			return (count, Stop::Comma);
		}
		count = match (count, c.to_digit(10).filter(|_| !escaped)) {
			(Count::Empty, Some(digit)) => Count::Number(digit),
			(Count::Number(count), Some(digit)) => {
				Count::Number((count * 10 + digit).min(RE_DUP_MAX + 1))
			},
			_ => Count::Bad,
		};
	}
}

/// Convert a primitive BRE pattern to a safe ERE-compatible pattern string.
/// - Replaces `\(`, `\)`, `\?`, `\+`, `\|`, `\{` and `\}` with `(`, `)`, `?`,
///   `+`, `|`, `{` and `}`.
/// - Puts single-digit back-references in non-capturing groups..
/// - Escapes ERE-only metacharacters: `+ ? { } | ( )`.
/// - Reads a backslash before an ordinary character as that character, and
///   `` \` `` and `\'` as `^` and `$`.
/// - Leaves all other characters as-is.
///
/// A repetition character with **no preceding atom** is emitted as a literal,
/// per POSIX: "an asterisk that is the first character of an RE ... shall lose
/// its special meaning". The same applies directly after `^`, `\(` or `\|`,
/// or a word assertion. This matters because the target engines accept `^+`
/// and compile it as `(?:^)+`, which matches the empty string at every line
/// start - so a pattern meant to find a few lines silently matches all of
/// them. A `\{` there is text or an error as `lone_brace` says.
///
/// An interval after an atom goes to the engine as written, which reads its
/// counts or refuses them.
pub(crate) fn bre_to_ere(
	pattern: &str,
	backrefs: Backrefs,
	lone_brace: LoneBrace,
) -> Result<String, BreError> {
	let mut result = String::with_capacity(pattern.len());
	let mut chars = pattern.chars().peekable();

	// Whether something repeatable precedes the current position. False at the
	// start of the pattern and directly after `\(` or `\|`, which are exactly
	// the positions where a repetition character is not an operator and where
	// `^` IS an anchor, and after a word assertion, where only the first holds.
	let mut has_atom = false;
	// Whether a `^` with nothing repeatable before it is still a literal: after
	// a branch-start `^` or a word assertion. Only the FIRST caret of a branch
	// anchors: measured, `grep -c '^^'` counts lines beginning with a literal
	// caret and `sed 's/^^/X/'` rewrites only those, so a second caret is an
	// ordinary character. Keyed off `has_atom` alone, both carets became
	// zero-width anchors and every line matched.
	let mut anchored = false;
	while let Some(c) = chars.next() {
		if c == '\\' {
			match chars.peek() {
				Some('(') => {
					chars.next();
					result.push('('); // Group start
					has_atom = false;
					anchored = false;
				},
				Some(')') => {
					chars.next();
					result.push(')'); // Group end
					has_atom = true;
				},
				Some('?') => {
					chars.next();
					if has_atom {
						result.push('?'); // Quantifier 0 or 1
					} else {
						result.push_str(r"\?"); // Nothing to repeat: literal
						has_atom = true;
					}
				},
				Some('+') => {
					chars.next();
					if has_atom {
						result.push('+'); // Quantifier 1 or more
					} else {
						result.push_str(r"\+"); // Nothing to repeat: literal
						has_atom = true;
					}
				},
				Some('|') => {
					chars.next();
					result.push('|'); // Alternation operator
					has_atom = false;
					anchored = false;
				},
				Some('{') => {
					chars.next();
					// With nothing to repeat, GNU grep and nl read the brace as
					// text and GNU sed refuses it.
					//
					// It cannot simply be emitted as an operator and left to
					// the engine. `^\{1,4\}` becomes `^{1,4}`, which BOTH
					// engines accept as `(?:^){1,4}` - matching the empty
					// string at every line start, so the pattern silently
					// selects every line with a success exit status. That is
					// the same fail-open this module exists to close, and it
					// has to be refused here because no later layer sees it.
					if !has_atom {
						if lone_brace == LoneBrace::Invalid {
							return Err(BreError::RepetitionOperandMissing);
						}
						result.push_str(r"\{");
						has_atom = true;
						continue;
					}
					result.push('{'); // Brace quantifier start
					// With no `\}` to close it, the rest of the pattern reads as
					// it does anywhere else.
					if !closes_interval(&chars) {
						continue;
					}
					// The interval as written, up to its `\}`, so that no escape
					// in it but `\,` turns into part of a count.
					while let Some(c) = chars.next() {
						if c != '\\' {
							// Text in a BRE, inside an interval as outside it.
							if matches!(c, '+' | '?' | '{' | '}' | '|' | '(' | ')') {
								result.push('\\');
							}
							result.push(c);
							continue;
						}
						match chars.next() {
							Some('}') => {
								result.push('}'); // Brace quantifier end
								break;
							},
							// glibc reads `\,` as the comma between the counts, as
							// GNU nl and sed do: `\{1\,2\}` is `{1,2}`.
							Some(',') => result.push(','),
							Some(escaped) => {
								result.push(c);
								result.push(escaped);
							},
							None => result.push(c),
						}
					}
				},
				Some('}') => {
					// A `\}` that closes no interval is text.
					chars.next();
					result.push_str(r"\}");
					has_atom = true;
				},
				Some(v @ '1'..='9') => {
					// Back-reference.  In sed BREs these are single-digit
					// (\1-\9) whereas fancy_regex supports multi-digit
					// back-references. Put them in a non-capturing group
					// to avoid having the number extend beyond the single
					// digit. Example: In sed \11 matches group 1 followed
					// by '1', not group 11.
					let v = *v;
					chars.next();
					match backrefs {
						Backrefs::Supported => result.push_str(&format!(r"(?:\{v})")),
						Backrefs::Unsupported => {
							result.push('\\');
							result.push(v);
						},
					}
					has_atom = true;
				},
				// A word assertion is no atom: a repetition after it is text,
				// as at the start of a branch. A caret after it is text too, as
				// a caret anchors only at a branch start.
				Some(&next @ ('b' | 'B' | '<' | '>')) => {
					chars.next();
					result.push('\\');
					result.push(next);
					has_atom = false;
					anchored = true;
				},
				// glibc's start and end of the text: a line to grep and nl, the
				// pattern space to sed. A repetition after either is text, as
				// after any anchor, and so is a caret, which anchors only at
				// the start of a branch.
				Some('`') => {
					chars.next();
					result.push('^');
					has_atom = false;
					anchored = true;
				},
				Some('\'') => {
					chars.next();
					result.push('$');
					has_atom = false;
					anchored = true;
				},
				Some(&next) if is_ordinary_escape(next) => {
					chars.next();
					result.push(next);
					has_atom = true;
				},
				Some(&next) => {
					// Preserve other escaped characters.
					chars.next();
					result.push('\\');
					result.push(next);
					has_atom = true;
				},
				None => {
					// Trailing backslash; keep it.
					result.push('\\');
					has_atom = true;
				},
			}
		} else {
			match c {
				'[' => {
					// A bracket expression is NOT BRE syntax: inside it, `\`,
					// `(`, `|` and `*` are ordinary characters. Translating
					// through it turned `[\(]` into a group opener and broke
					// compilation, so the whole expression is scanned as
					// bracket syntax and copied across. One with no closing
					// `]` is refused, as GNU refuses it, rather than passed
					// through for `grep` to search as the text typed.
					let bracket = take_bracket_expression(&mut chars, true)?;
					result.push('[');
					result.push_str(&bracket.body);
					has_atom = true;
				},
				'+' | '?' | '{' | '}' | '|' | '(' | ')' => {
					// Escape unsupported ERE metacharacters.
					result.push('\\');
					result.push(c);
					has_atom = true;
				},
				'*' => {
					if has_atom {
						result.push('*'); // Quantifier 0 or more
					} else {
						result.push_str(r"\*"); // Nothing to repeat: literal
						has_atom = true;
					}
				},
				'^' if has_atom || anchored => {
					// In a BRE `^` is an ANCHOR only at the start of a branch -
					// the start of the pattern, or directly after `\(` or `\|` -
					// and only ONCE there. Anywhere else, including a second
					// caret at the same branch start, it is a literal.
					//
					// Measured: `grep '\(^alpha\)'` matches on GNU and BSD grep,
					// so start-of-pattern is the wrong test; and `grep -c '^^'`
					// counts lines beginning with a caret while
					// `sed 's/^^/X/'` rewrites only those, so the second caret
					// is not a second anchor.
					//
					// Escaping the literal uses is valid in an ERE:
					// "the ERE "a^b" is valid, but can never match because
					// the 'a' prevents the expression "^b" from matching
					// starting at the first character."
					// POSIX 9.4.9 ERE Expression Anchoring
					result.push('\\');
					result.push(c);
					has_atom = true;
				},
				'$' if !ends_branch(&chars) => {
					// Similarly for `$` appearing not at the end of a branch.
					result.push('\\');
					result.push(c);
					has_atom = true;
				},
				// A branch-start anchor. It is not an atom, so `^*` still sees
				// no operand, but it is consumed: the next caret is a literal.
				'^' => {
					result.push(c);
					anchored = true;
				},
				'$' => result.push(c),
				_ => {
					result.push(c);
					has_atom = true;
				},
			}
		}
	}

	Ok(result)
}

/// Whether a `\}` follows, which closes the interval a `\{` opens.
fn closes_interval(chars: &std::iter::Peekable<std::str::Chars<'_>>) -> bool {
	let mut rest = chars.clone();
	while let Some(c) = rest.next() {
		if c == '\\' && rest.next() == Some('}') {
			return true;
		}
	}
	false
}

/// Whether the rest of the pattern ends the current branch.
///
/// `$` is an anchor at the end of a branch, not only at the end of the whole
/// pattern: `grep 'a$\|b'` selects lines ending in `a` as well as lines
/// containing `b`, and the alternation normalization this module replaced
/// preserved that by leaving `$` untouched. Escaping it here made the first
/// branch unmatchable and silently dropped those lines.
///
/// BSD grep differs - it anchors only at the very end of the pattern - but
/// `\|` is itself a GNU extension, so GNU decides its semantics.
fn ends_branch(chars: &std::iter::Peekable<std::str::Chars<'_>>) -> bool {
	let mut rest = chars.clone();
	match rest.next() {
		None => true,
		Some('\\') => matches!(rest.next(), Some('|' | ')')),
		Some(_) => false,
	}
}

/// Whether glibc reads `\c` as `c` itself, as it reads `\d` as `d` and `\x`
/// as `x`, where the engines read a digit class and a hex escape. GNU's own
/// escapes (`\w`, `\s`, `\b` and their capitals) and back-references (`\1`
/// to `\9`) keep their meaning, and so does a backslash before punctuation,
/// which the engines read as glibc does.
fn is_ordinary_escape(c: char) -> bool {
	!c.is_ascii()
		|| (c.is_ascii_alphanumeric() && !matches!(c, 'w' | 'W' | 's' | 'S' | 'b' | 'B' | '1'..='9'))
}

/// A bracket expression's body, without the outer `[]`, and what GNU grep
/// refuses in it beyond what glibc refuses ([`check_brackets`]).
struct Bracket {
	body:             String,
	/// A list whose first and last members are `:`, with a member between
	/// that is not and no class, collating element or range: `[:alpha:]`,
	/// which GNU's dfa reads as a misspelled `[[:alpha:]]`.
	#[cfg_attr(not(feature = "util.grep"), allow(dead_code, reason = "only grep refuses it"))]
	misspelled_class: bool,
	/// A range whose ends run backwards once upper-cased, as glibc compares
	/// them under `-i`: `[Z-a]`, where `a` folds to `A`.
	#[cfg_attr(not(feature = "util.grep"), allow(dead_code, reason = "only grep refuses it"))]
	folds_backwards:  bool,
}

/// Consume a bracket expression, returning its body without the outer `[]`.
///
/// The opening `[` is already consumed. One with no closing `]` is
/// [`BreError::UnmatchedBracket`], and one with a collating symbol or
/// equivalence class that is not one byte [`BreError::InvalidCollation`],
/// as glibc refuses them; either advances nothing.
///
/// With `normalize`, the body is rewritten so the engine reads it the way
/// POSIX does: `\` has no special meaning inside a bracket expression, so it
/// is doubled to stay a literal, and a leading `]` is escaped rather than
/// closing the expression. Measured, `grep -c '[\(]'` selects lines holding a
/// backslash OR a parenthesis, and `grep -c '[]x]'` selects lines holding a
/// bracket or an `x`.
///
/// Without it the body is copied verbatim, which is what an already-extended
/// pattern needs: the caller is only locating the expression so it can skip
/// over it, and must not change how it matches.
fn take_bracket_expression(
	chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
	normalize: bool,
) -> Result<Bracket, BreError> {
	let mut probe = chars.clone();
	let mut body = String::new();

	// A leading `^` negates, and a `]` immediately after that is the literal
	// `]` rather than the terminator.
	if let Some(caret) = probe.next_if_eq(&'^') {
		body.push(caret);
	}
	let leading_close = probe.next_if_eq(&']').is_some();
	if leading_close {
		body.push_str(if normalize { r"\]" } else { "]" });
	}

	// For `misspelled_class`: whether the first member is `:`, whether the
	// last one so far is, whether one is not, and whether a class, collating
	// element or range has been read.
	let colon_first = !leading_close && probe.peek() == Some(&':');
	let (mut colon_last, mut other, mut structured) = (false, false, false);
	let mut folds_backwards = false;
	// The character the last member stands for, where it may start a range,
	// and the start of a range whose `-` has been read.
	let mut endpoint = leading_close.then_some(']');
	let mut range_start = None;
	while let Some(c) = probe.next() {
		// The character this member stands for, where it may end a range.
		let member = match c {
			']' => {
				*chars = probe;
				body.push(c);
				let misspelled_class = colon_first && colon_last && other && !structured;
				return Ok(Bracket { body, misspelled_class, folds_backwards });
			},
			'-' if range_start.is_none()
				&& endpoint.is_some()
				&& probe.peek().is_some_and(|&next| next != ']') =>
			{
				range_start = endpoint;
				body.push(c);
				structured = true;
				continue;
			},
			// `\` is an ordinary character here; keep it one.
			'\\' => {
				body.push_str(if normalize { r"\\" } else { "\\" });
				Some(c)
			},
			// `[:alpha:]`, `[.x.]` and `[=x=]` carry their own terminators, so
			// the `]` that closes them does not close the bracket expression.
			'[' if matches!(probe.peek(), Some(':' | '.' | '=')) => {
				let kind = probe.next().ok_or(BreError::UnmatchedBracket)?;
				body.push('[');
				body.push(kind);
				let element_start = body.len();
				let mut previous = None;
				loop {
					let next = probe.next().ok_or(BreError::UnmatchedBracket)?;
					body.push(next);
					if previous == Some(kind) && next == ']' {
						break;
					}
					previous = Some(next);
				}
				structured = true;
				if kind == ':' {
					None
				} else {
					// glibc's C and C.UTF-8 locales collate byte by byte, so a
					// collating symbol or equivalence class is one byte:
					// `[[.é.]]` is "Invalid collation character" there.
					let mut element = body[element_start..body.len() - 2].chars();
					match (element.next(), element.next()) {
						(Some(symbol), None) if symbol.is_ascii() => (kind == '.').then_some(symbol),
						_ => return Err(BreError::InvalidCollation),
					}
				}
			},
			_ => {
				body.push(c);
				Some(c)
			},
		};
		colon_last = c == ':';
		other |= c != ':';
		if let Some(start) = range_start.take() {
			folds_backwards |= member.is_some_and(|end| simple_upper(start) > simple_upper(end));
			endpoint = None;
		} else {
			endpoint = member;
		}
	}
	Err(BreError::UnmatchedBracket)
}

/// `c`'s upper case where that is one character, as glibc's `towupper` maps
/// it, else `c`.
fn simple_upper(c: char) -> char {
	let mut upper = c.to_uppercase();
	match (upper.next(), upper.next()) {
		(Some(upper), None) => upper,
		_ => c,
	}
}

/// Refuses what GNU grep refuses in a bracket expression of `pattern`, a BRE
/// or an ERE: what the translation refuses, and a class name without its
/// outer brackets (`[:alpha:]`, "character class syntax is [[:space:]], not
/// [:space:]"), which GNU's dfa checks, and under `-i` (`ignore_case`) a
/// range whose ends run backwards once upper-cased (`[Z-a]`, "Invalid range
/// end"). `nl` compiles with glibc's regex alone, which takes `[:alpha:]` as
/// a list, so the translation does not refuse it.
#[cfg(feature = "util.grep")]
pub(crate) fn check_brackets(pattern: &str, ignore_case: bool) -> Result<(), BreError> {
	let mut chars = pattern.chars().peekable();
	while let Some(c) = chars.next() {
		match c {
			'\\' => {
				chars.next();
			},
			'[' => {
				let bracket = take_bracket_expression(&mut chars, false)?;
				if bracket.misspelled_class {
					return Err(BreError::MisspelledClass);
				}
				if ignore_case && bracket.folds_backwards {
					return Err(BreError::InvalidRangeEnd);
				}
			},
			_ => {},
		}
	}
	Ok(())
}

/// What precedes a repetition operator in an ERE.
#[cfg(feature = "util.grep")]
#[derive(Clone, Copy, PartialEq, Eq)]
enum Operand {
	/// Nothing: the start of a branch.
	None,
	/// An anchor: `^`, `$` or a word assertion.
	Anchor,
	/// Anything else.
	Atom,
}

/// Read an ERE's repetition operators and intervals as GNU grep reads them,
/// for the `regex` crate, which refuses or reads otherwise what GNU takes:
///
/// - An operator with nothing to repeat is skipped (`*x` is `x`), and a `)`
///   right after one is text, so `(*)` holds an unclosed group.
/// - After an anchor an operator repeats it, as GNU's dfa, which decides
///   which lines match, reads `a$*` and `^{2}`.
/// - After an atom a `{` that glibc refuses as an interval is refused
///   (`a{1,2,3}`, `a{2,1}`), and one a digit follows goes to the engine as
///   written, up to its `}`, which reads its counts or refuses them. Any other
///   `{` that makes no interval is text (`a{`, `{a}`, `a{,2}`, `a{}`,
///   `a{1\0}`, `^{1,2,3}`).
/// - At the start of a branch glibc skips a `{` that opens an interval and
///   reads the rest as text, which GNU prints for `-o`: `{1}y` is `1}y`.
/// - Where glibc parses no interval, GNU's dfa still reads one and refuses a
///   count above 32767.
/// - A backslash before an ordinary character is that character, and `` \` ``
///   and `\'` are `^` and `$`, as in a BRE.
///
/// A bracket expression is copied as it is.
#[cfg(feature = "util.grep")]
pub(crate) fn ere_to_rust(pattern: &str) -> Result<std::borrow::Cow<'_, str>, BreError> {
	let mut result = String::with_capacity(pattern.len());
	let mut chars = pattern.chars().peekable();
	let mut operand = Operand::None;
	// Whether the last token was an operator skipped for having nothing to
	// repeat.
	let mut skipped = false;
	while let Some(c) = chars.next() {
		let after_skip = std::mem::replace(&mut skipped, false);
		match c {
			'\\' => match chars.next() {
				Some('`') => {
					result.push('^');
					operand = Operand::Anchor;
				},
				Some('\'') => {
					result.push('$');
					operand = Operand::Anchor;
				},
				Some(next) if is_ordinary_escape(next) => {
					result.push(next);
					operand = Operand::Atom;
				},
				next => {
					result.push(c);
					result.extend(next);
					operand = if matches!(next, Some('b' | 'B' | '<' | '>')) {
						Operand::Anchor
					} else {
						Operand::Atom
					};
				},
			},
			'[' => {
				let bracket = take_bracket_expression(&mut chars, false)?;
				result.push('[');
				result.push_str(&bracket.body);
				operand = Operand::Atom;
			},
			'{' => {
				let mut interval = chars.clone();
				match (operand, Interval::parse(&mut interval)) {
					(Operand::Atom, Interval::Invalid) => return Err(BreError::InvalidInterval),
					// An escaped digit in a count, as in `a{1\0}`, makes the brace
					// text, as GNU reads it.
					(Operand::Atom, _)
						if chars.peek().is_some_and(char::is_ascii_digit)
							&& !escaped_digit_in_interval(&chars) =>
					{
						result.push('{');
						while let Some(c) = chars.next() {
							result.push(c);
							match c {
								'\\' => result.extend(chars.next()),
								'}' => break,
								_ => {},
							}
						}
					},
					// Where glibc parses no interval, GNU's dfa still reads one
					// and refuses a most above 32767.
					(_, Interval::Counts(_, Some(most))) if most > RE_DUP_MAX => {
						return Err(BreError::TooBig);
					},
					(Operand::Anchor, Interval::Counts(least, most)) => {
						push_counts(&mut result, least, most);
						chars = interval;
					},
					(Operand::None, Interval::Counts(..)) => skipped = true,
					_ => {
						result.push_str(r"\{");
						operand = Operand::Atom;
					},
				}
			},
			'*' | '+' | '?' => {
				if operand == Operand::None {
					skipped = true;
				} else {
					result.push(c);
				}
			},
			'(' => {
				result.push(c);
				operand = Operand::None;
			},
			')' => {
				if after_skip {
					result.push_str(r"\)");
				} else {
					result.push(c);
				}
				operand = Operand::Atom;
			},
			'|' => {
				result.push(c);
				operand = Operand::None;
			},
			'^' | '$' => {
				result.push(c);
				operand = Operand::Anchor;
			},
			_ => {
				result.push(c);
				operand = Operand::Atom;
			},
		}
	}

	Ok(if result == pattern {
		std::borrow::Cow::Borrowed(pattern)
	} else {
		std::borrow::Cow::Owned(result)
	})
}

/// Whether an escaped digit comes before the `}` of the ERE interval after
/// its `{`, as in `a{1\0}`.
#[cfg(feature = "util.grep")]
fn escaped_digit_in_interval(chars: &std::iter::Peekable<std::str::Chars<'_>>) -> bool {
	let mut rest = chars.clone();
	while let Some(c) = rest.next() {
		match c {
			'}' => return false,
			'\\' => {
				if rest.next().is_some_and(|escaped| escaped.is_ascii_digit()) {
					return true;
				}
			},
			_ => {},
		}
	}
	false
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The BRE as GNU sed reads it, where a `\{` with nothing to repeat is an
	/// error.
	fn ere(pattern: &str) -> String {
		bre_to_ere(pattern, Backrefs::Supported, LoneBrace::Invalid).expect("translatable")
	}

	fn ere_err(pattern: &str) -> Option<BreError> {
		bre_to_ere(pattern, Backrefs::Supported, LoneBrace::Invalid).err()
	}

	// Relocated from `sed`, which owned this translation before `grep` shared it.

	#[test]
	fn test_bre_group_translation() {
		assert_eq!(ere(r"\(a\?b\+c\|\)"), "(a?b+c|)");
		assert_eq!(ere(r"a\(b\)c"), "a(b)c");
	}

	#[test]
	fn test_bre_brace_quantifier_translation() {
		assert_eq!(ere(r"a\{1,4\}"), "a{1,4}");
		assert_eq!(ere(r"\(a\)\{1,4\}"), "(a){1,4}");
		// A bare `}` is text in a BRE, so it closes no interval.
		assert_eq!(ere(r"a\{1}"), r"a{1\}");
		assert_eq!(ere(r"a\{1}b\}"), r"a{1\}b}");
		// An escaped comma is the comma between the counts, as glibc reads it.
		assert_eq!(ere(r"a\{1\,2\}"), "a{1,2}");
		// With no `\}`, the rest of the pattern reads as it does anywhere else.
		assert_eq!(ere(r"x\{1\|y"), "x{1|y");
	}

	#[test]
	fn test_ere_metacharacters_escaped() {
		assert_eq!(ere(r"a+b?c{1}|(d)"), r"a\+b\?c\{1\}\|\(d\)");
	}

	#[test]
	fn test_literal_backslashes_preserved() {
		assert_eq!(ere(r"foo\\bar"), r"foo\\bar");
		assert_eq!(ere(r"\."), r"\.");
	}

	#[test]
	fn test_character_classes_unchanged() {
		assert_eq!(ere(r"[a-z]"), "[a-z]");
		assert_eq!(ere(r"[^0-9]"), "[^0-9]");
	}

	#[test]
	fn test_anchors_and_dot_and_star() {
		assert_eq!(ere(r"^a.*b$"), "^a.*b$");
	}

	#[test]
	fn test_trailing_backslash_is_preserved() {
		assert_eq!(ere(r"abc\"), r"abc\");
	}

	#[test]
	fn test_caret_escaped_in_middle() {
		assert_eq!(ere(r"^a^[^x]c"), r"^a\^[^x]c");
	}

	#[test]
	fn test_dollar_escaped_in_middle() {
		assert_eq!(ere(r"a$c$"), r"a\$c$");
	}

	#[test]
	fn test_bre_back_reference() {
		assert_eq!(ere(r"\(.\)\1\(.\)\2"), r"(.)(?:\1)(.)(?:\2)");
	}

	#[test]
	fn back_references_pass_through_when_the_engine_does_not() {
		// THE FALLBACK CONTRACT, stated because `grep` depends on it.
		//
		// `grep-regex` cannot compile a back-reference at all. Rather than
		// inventing a translation, the sequence is emitted unchanged, so the
		// pattern fails to compile and `grep`'s `build_default_matcher`
		// escapes it and matches it LITERALLY - which is exactly what
		// happened before this module existed. The behaviour is unchanged by
		// the refactor; it is not an endorsement of matching `\1` literally.
		assert_eq!(
			bre_to_ere(r"\(a\)\1", Backrefs::Unsupported, LoneBrace::Invalid).expect("translatable"),
			r"(a)\1"
		);
		// The grouping exists only for engines that support them, where a
		// bare `\11` would otherwise read as group 11 instead of group 1
		// followed by a literal '1'.
		assert_eq!(ere(r"\(a\)\11"), r"(a)(?:\1)1");
	}

	// ── Repetition operators with no preceding atom ──────────────────────────
	// POSIX BRE: a repetition character with nothing to repeat is a LITERAL.
	// Emitting it as an operator lets the Rust engine compile `^+` as `(?:^)+`,
	// which matches the empty string at every line start - so the pattern
	// silently matches EVERY line instead of the intended few.

	#[test]
	fn escaped_plus_at_pattern_start_is_a_literal() {
		assert_eq!(ere(r"\+"), r"\+");
	}

	#[test]
	fn escaped_plus_after_anchor_is_a_literal() {
		assert_eq!(ere(r"^\+"), r"^\+");
	}

	#[test]
	fn escaped_question_after_anchor_is_a_literal() {
		assert_eq!(ere(r"^\?"), r"^\?");
	}

	#[test]
	fn escaped_brace_quantifier_with_no_operand_is_rejected() {
		// Neither a literal nor an operator: an ERROR, which is what GNU sed
		// does. Emitting the operator and leaving it to the engine was
		// measurably wrong - `^{2}` and `^{1,4}` COMPILE as `(?:^){2}`, which
		// matches at every line start, so the pattern silently selected the
		// whole file with exit 0.
		assert_eq!(ere_err(r"^\{2\}"), Some(BreError::RepetitionOperandMissing));
		assert_eq!(ere_err(r"\{1,4\}"), Some(BreError::RepetitionOperandMissing));
		assert_eq!(ere_err(r"\(\{2\}\)"), Some(BreError::RepetitionOperandMissing));
		assert_eq!(ere_err(r"a\|\{2\}"), Some(BreError::RepetitionOperandMissing));
		// With an operand it is an ordinary quantifier.
		assert_eq!(ere_err(r"a\{2\}"), None);
		// GNU grep and nl read the same brace as text.
		let literal = |pattern| bre_to_ere(pattern, Backrefs::Supported, LoneBrace::Literal);
		assert_eq!(literal(r"^\{1,4\}"), Ok(r"^\{1,4\}".to_owned()));
	}

	#[test]
	fn caret_is_an_anchor_after_group_open_and_alternation() {
		// Measured: `grep '\(^alpha\)'` matches on GNU and BSD grep. Keying
		// this off "start of pattern" escaped the anchor and matched nothing.
		assert_eq!(ere(r"\(^a\)"), r"(^a)");
		assert_eq!(ere(r"a\|^b"), r"a|^b");
		assert_eq!(ere(r"\(^a\|^b\)"), r"(^a|^b)");
		// Still a literal where an atom precedes it.
		assert_eq!(ere(r"a^b"), r"a\^b");
		assert_eq!(ere(r"^a^"), r"^a\^");
	}

	#[test]
	fn bare_star_at_pattern_start_is_a_literal() {
		assert_eq!(ere(r"*x"), r"\*x");
	}

	#[test]
	fn bare_star_after_anchor_is_a_literal() {
		assert_eq!(ere(r"^*"), r"^\*");
	}

	#[test]
	fn repetition_after_group_open_is_a_literal() {
		assert_eq!(ere(r"\(\+a\)"), r"(\+a)");
		assert_eq!(ere(r"\(*a\)"), r"(\*a)");
	}

	#[test]
	fn repetition_after_alternation_is_a_literal() {
		assert_eq!(ere(r"a\|\+b"), r"a|\+b");
	}

	// The operator cases these must not break.

	#[test]
	fn repetition_with_an_operand_stays_an_operator() {
		assert_eq!(ere(r"a\+"), r"a+");
		assert_eq!(ere(r"a\?"), r"a?");
		assert_eq!(ere(r"a\{2\}"), r"a{2}");
		assert_eq!(ere(r"a*"), r"a*");
		assert_eq!(ere(r"^a\+"), r"^a+");
		assert_eq!(ere(r"\(a\)\+"), r"(a)+");
		assert_eq!(ere(r"[a-z]\+"), r"[a-z]+");
		assert_eq!(ere(r".\+"), r".+");
	}

	// ── ERE repetition, as GNU grep reads it ─────────────────────────────────

	#[cfg(feature = "util.grep")]
	#[test]
	fn ere_skips_an_operator_with_nothing_to_repeat() {
		for (pattern, translated) in [
			("*x", "x"),
			("+", ""),
			("a|+b", "a|b"),
			// A `)` right after a skipped operator is text, so the group
			// stays open and the engine refuses it, as GNU does.
			("(+)", r"(\)"),
			("(|+)", r"(|\)"),
			// After an anchor the operator repeats the anchor, as GNU's dfa
			// reads it.
			("^+", "^+"),
			("^{2}", "^{2}"),
			// At the start of a branch glibc skips the `{` of an interval.
			("{1}", "1}"),
			("{3,}", "3,}"),
			("(|{6})", "(|6})"),
		] {
			assert_eq!(ere_to_rust(pattern).as_deref(), Ok(translated), "{pattern}");
		}
		assert_eq!(ere_to_rust("^{32768}"), Err(BreError::TooBig));
	}

	#[cfg(feature = "util.grep")]
	#[test]
	fn ere_accepts_repetition_with_an_operand() {
		for pattern in [
			"a+",
			"^a+",
			"a{2}",
			"[a-z]+",
			".*",
			r"\++",     // an escaped plus is a literal, so it IS an operand
			"[^x]*",    // negated class, not an anchor
			"[]]*",     // `]` first in a class is a literal
			"[^]]*",    // and after a negation too
			"(a)+",
			"a|b+",
			"$",
			r"\\",
			r"a\",      // trailing backslash: not our error to report
			// A `{` that opens no interval is a LITERAL, not an operator.
			// Measured: `grep -E '^{'` and `grep -E '{a}'` match nothing and
			// report no error. Rejecting every `{` refused patterns the real
			// tool accepts.
			"^{",
			"{",
			"{a}",
			"{,5}",
			"^{}",
			"{1a}",
		] {
			assert!(ere_to_rust(pattern).is_ok(), "should accept {pattern}");
		}
	}

	/// GNU grep refuses each pattern below with exit 2 and prints no line.
	/// Regressed: grep searched a pattern that is not valid, as a list GNU
	/// never reads or with a range or a collating symbol glibc refuses, and a
	/// caller took the count or the "no match" for a real answer.
	#[cfg(feature = "util.grep")]
	#[tokio::test(flavor = "multi_thread")]
	async fn a_bracket_expression_gnu_refuses_is_refused() {
		use crate::{grep::Grep, host::run_async_util};

		for (args, stdin) in [
			// A class name without its outer brackets: "character class
			// syntax is [[:space:]], not [:space:]", in an ERE too.
			(&["-c", "[:alpha:]"][..], "a:\n"),
			(&["-cE", "[:alpha:]"], "a:\n"),
			// Under -i GNU checks a range against the upper case of its
			// ends, and `a` folds to `A`, before `Z`: "Invalid range end".
			(&["-ci", "[Z-a]"], "x\n"),
			// A collating symbol of a multibyte character in C.UTF-8:
			// "Invalid collation character".
			(&["-c", "[[.\u{e9}.]]"], "\u{e9}\n"),
		] {
			let (code, capture) = run_async_util::<Grep>(args, stdin, "/").await;
			assert_eq!((code, capture.out().as_str()), (2, ""), "grep {args:?}: {}", capture.err());
		}

		// The forms GNU still takes: a list between colons that holds a
		// range or a class, and the range `Z-a` read with case.
		for (args, stdin, expected) in [
			(&["-c", "[:a-z:]"][..], "a:\n", "1\n"),
			(&["-c", "[:[:digit:]:]"], "a:\n", "1\n"),
			(&["-c", "[Z-a]"], "x\nZ\n", "1\n"),
			(&["-c", "[[.a.]]"], "a\n\u{e9}\n", "1\n"),
		] {
			let (code, capture) = run_async_util::<Grep>(args, stdin, "/").await;
			assert_eq!((code, capture.out().as_str()), (0, expected), "grep {args:?}: {}", capture.err());
		}
	}

	/// Repetition operators and intervals read as glibc reads them, as GNU
	/// grep does. Regressed: a leading `*` or `{1}` in an ERE and a `\{` with
	/// nothing to repeat in a BRE stopped grep, and a count above 32767 after
	/// an anchor was searched.
	#[cfg(feature = "util.grep")]
	#[tokio::test(flavor = "multi_thread")]
	async fn repetition_operators_and_intervals_read_as_glibc_reads_them() {
		use crate::{grep::Grep, host::run_async_util};

		for (args, stdin, expected) in [
			// An ERE operator with nothing to repeat is skipped.
			(&["-cE", "*x"][..], "x\n", (0, "1\n")),
			(&["-cE", "(*a)"], "a\nb\n", (0, "1\n")),
			// A BRE `\{` with nothing to repeat is text, whatever its count.
			(&["-c", r"\{"], "{\n", (0, "1\n")),
			(&["-c", r"\{1"], "{1\n", (0, "1\n")),
			(&["-c", r"\{32768\}"], "{32768}\n", (0, "1\n")),
			// After an anchor a brace that makes no interval is text.
			(&["-cE", "^*{1,2,3}"], "{1,2,3}\n", (0, "1\n")),
			(&["-c", r"\B\{\}"], "{}\n", (0, "1\n")),
			// After any other atom it is refused.
			(&["-cE", r"\w{1,2,3}"], "x{1,2,3}\n", (2, "")),
			(&["-cE", "(^){1,2,3}"], "x\n", (2, "")),
			// An escaped digit in a count makes the brace text after an atom.
			(&["-E", r"^a{1\0}$"], "aaaaaaaaaa\na{10}\n", (0, "a{10}\n")),
			// An ERE that starts with an interval reads its text after `{`.
			(&["-Eo", "{1}"], "{1}\n", (0, "1}\n")),
			(&["-Eow", "{1}"], "{1}\n", (0, "1}\n")),
			(&["-Eo", "{1}y"], "x{1}y\n", (0, "1}y\n")),
			// After an anchor GNU's dfa finds a count above 32767 too big;
			// 32767 is the most.
			(&["-cE", "^{32768}"], "a\n", (2, "")),
			(&["-c", r"a\{32767\}"], "a\n", (1, "0\n")),
		] {
			let (code, capture) = run_async_util::<Grep>(args, stdin, "/").await;
			assert_eq!((code, capture.out().as_str()), expected, "grep {args:?}: {}", capture.err());
		}
	}

	/// A backslash before a character with no meaning of its own is that
	/// character, and `` \` `` and `\'` are the start and the end of the
	/// text, as glibc reads them for GNU grep and nl. Regressed: `\d` was a
	/// digit, `\x` an error searched as text, and `` \` `` a backtick.
	#[cfg(all(feature = "util.grep", feature = "util.nl"))]
	#[tokio::test(flavor = "multi_thread")]
	async fn a_backslash_before_an_ordinary_character_is_that_character() {
		use crate::{
			grep::Grep,
			host::{run_async_util, run_util},
			nl::Nl,
		};

		for (args, stdin, expected) in [
			(&["-o", r"\d"][..], "d1\n", (0, "d\n")),
			(&["-oE", r"\d"], "d1\n", (0, "d\n")),
			(&["-c", r"\x"], "x\n", (0, "1\n")),
			(&["-c", r"\0"], "0\n", (0, "1\n")),
			(&["-c", "\\\u{e9}"], "\u{e9}\n", (0, "1\n")),
			(&["-c", r"\`a"], "ab\n", (0, "1\n")),
			(&["-c", r"b\'"], "ab\n", (0, "1\n")),
			(&["-cE", r"b\'"], "ab\n", (0, "1\n")),
			// After `` \` `` a BRE caret is text, as it anchors only at the
			// start of a branch; an ERE caret anchors anywhere.
			(&["-n", r"\`^a"], "a\n^a\n", (0, "2:^a\n")),
			(&["-c", r"\`^a"], "ab\n^ab\n", (0, "1\n")),
			(&["-cE", r"\`^a"], "ab\n^ab\n", (0, "1\n")),
			// The same after `\<`, which was already GNU's answer.
			(&["-n", r"\<^a"], "a\n^a\n", (1, "")),
		] {
			let (code, capture) = run_async_util::<Grep>(args, stdin, "/").await;
			assert_eq!((code, capture.out().as_str()), expected, "grep {args:?}: {}", capture.err());
		}

		let (code, capture) = run_util::<Nl>(&[r"-bp\`^a"], "a\n^a\n", "/");
		assert_eq!((code, capture.out().as_str()), (0, "       a\n     1\t^a\n"), "{}", capture.err());
	}
}
