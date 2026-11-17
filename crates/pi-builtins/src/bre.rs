//! Shared POSIX basic-regular-expression translation.
//!
//! `grep`, `sed`, and `nl` accept BREs but compile them with different engines
//! (`grep-regex` for `grep`, `fancy-regex` for the others), neither of which
//! implements BRE syntax. This module converts a BRE into the ERE-compatible
//! form those engines accept, so the dialect is defined in exactly one place.

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

/// A pattern the BRE and ERE dialects cannot express.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum BreError {
	/// A repetition operator with nothing to repeat, where the tools error
	/// rather than treating the character as a literal.
	RepetitionOperandMissing,
	/// A bracket expression with no closing `]`.
	BracketUnmatched,
	/// A `[:name:]` naming no POSIX character class.
	ClassNameInvalid,
	/// A `[.c.]` or `[=c=]` holding other than one character.
	CollationInvalid,
	/// A range that runs backwards or has a class for an end, or a `-` after a
	/// range or class in a bracket expression that is not its last member.
	RangeEndInvalid,
}

impl BreError {
	/// The message the real tools print for this condition: GNU's and BSD's
	/// alike for a missing operand, GNU's for a bracket expression.
	pub(crate) fn message(self) -> &'static str {
		match self {
			Self::RepetitionOperandMissing => "repetition-operator operand invalid",
			Self::BracketUnmatched => "Unmatched [, [^, [:, [., or [=",
			Self::ClassNameInvalid => "Invalid character class name",
			Self::CollationInvalid => "Invalid collation character",
			Self::RangeEndInvalid => "Invalid range end",
		}
	}
}

/// Convert a primitive BRE pattern to a safe ERE-compatible pattern string.
/// - Replaces `\(`, `\)`, `\?`, `\+`, `\|`, `\{` and `\}` with `(`, `)`, `?`,
///   `+`, `|`, `{` and `}`.
/// - Puts single-digit back-references in non-capturing groups..
/// - Escapes ERE-only metacharacters: `+ ? { } | ( )`.
/// - Leaves all other characters as-is.
///
/// A repetition character with **no preceding atom** is emitted as a literal,
/// per POSIX: "an asterisk that is the first character of an RE ... shall lose
/// its special meaning". The same applies directly after `^`, `\(` or `\|`.
/// This matters because the target engines accept `^+` and compile it as
/// `(?:^)+`, which matches the empty string at every line start - so a pattern
/// meant to find a few lines silently matches all of them.
pub(crate) fn bre_to_ere(pattern: &str, backrefs: Backrefs) -> Result<String, BreError> {
	let mut result = String::with_capacity(pattern.len());
	let mut chars = pattern.chars().peekable();

	// Whether something repeatable precedes the current position. False at the
	// start of the pattern and directly after `\(` or `\|`, which are exactly
	// the positions where a repetition character is not an operator and where
	// `^` IS an anchor. One piece of state answers both questions.
	let mut has_atom = false;
	// Whether a branch-start `^` has already been consumed as an anchor. Only
	// the FIRST caret of a branch anchors: measured, `grep -c '^^'` counts
	// lines beginning with a literal caret and `sed 's/^^/X/'` rewrites only
	// those, so a second caret is an ordinary character. Keyed off `has_atom`
	// alone, both carets became zero-width anchors and every line matched.
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
					// A brace quantifier with nothing to repeat is an ERROR in
					// both tools, not a literal brace: measured,
					// `grep '\{1,4\}'` and `sed 's/\{1,3\}/X/'` each report
					// "repetition-operator operand invalid".
					//
					// It cannot simply be emitted as an operator and left to
					// the engine. `^\{1,4\}` becomes `^{1,4}`, which BOTH
					// engines accept as `(?:^){1,4}` - matching the empty
					// string at every line start, so the pattern silently
					// selects every line with a success exit status. That is
					// the same fail-open this module exists to close, and it
					// has to be refused here because no later layer sees it.
					if !has_atom {
						return Err(BreError::RepetitionOperandMissing);
					}
					result.push('{'); // Brace quantifier start
				},
				Some('}') => {
					chars.next();
					result.push('}'); // Brace quantifier end
					has_atom = true;
				},
				Some(v) if v.is_ascii_digit() => {
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
					// compilation, so the whole expression is read as bracket
					// syntax and written out in the engine's.
					// An unterminated one is refused, as in an ERE and as GNU grep
					// refuses it ("Unmatched [, [^, [:, [., or [="): passed on as a
					// plain `[`, `grep` would match `a[b` as typed and read
					// `[[:alpha]]` as a nested class.
					take_bracket_expression(&mut chars, &mut result)?;
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

/// The character classes POSIX defines in every locale: the names GNU grep
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
	/// The equivalence class `[=c=]`, which holds `c` alone, as in GNU grep's
	/// C locale. Unlike a character it neither starts nor ends a range.
	Equivalence(char),
	/// `[:name:]`, one of `POSIX_CLASSES`.
	Class(&'static str),
}

/// Consume a bracket expression whose `[` is already consumed, and append it
/// to `out` in the form the `regex` crate reads with the meaning POSIX gives
/// it.
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
/// of other than one character, and a range that runs backwards or has a
/// class for an end, or a `-` after a range or class that does not close the
/// list.
fn take_bracket_expression(
	chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
	out: &mut String,
) -> Result<(), BreError> {
	out.push('[');
	if chars.next_if_eq(&'^').is_some() {
		out.push('^');
	}
	// A `-` first in the list is a member.
	let mut first = true;
	loop {
		let member = take_bracket_member(chars, first)?;
		first = false;
		match member {
			BracketMember::Char(start) if opens_range(chars) => {
				chars.next();
				// A `-` right after the range's own is its end, as in `[!--]`.
				let BracketMember::Char(end) = take_bracket_member(chars, true)? else {
					return Err(BreError::RangeEndInvalid);
				};
				if end < start {
					return Err(BreError::RangeEndInvalid);
				}
				push_bracket_char(out, start);
				out.push('-');
				push_bracket_char(out, end);
			},
			BracketMember::Char(c) | BracketMember::Equivalence(c) => push_bracket_char(out, c),
			BracketMember::Class(name) => {
				out.push_str("[:");
				out.push_str(name);
				out.push_str(":]");
			},
		}
		match chars.peek() {
			None => return Err(BreError::BracketUnmatched),
			Some(']') => {
				chars.next();
				out.push(']');
				return Ok(());
			},
			Some(_) => {},
		}
	}
}

/// Consume one member of a bracket expression. A `-` is a member first in
/// the list or as a range's end (`accept_hyphen`); anywhere else it follows a
/// range or a class, and GNU refuses it unless it is the last member.
fn take_bracket_member(
	chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
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
	chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
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
		(Some(c), None) if delimiter == '.' => Ok(BracketMember::Char(c)),
		(Some(c), None) => Ok(BracketMember::Equivalence(c)),
		_ => Err(BreError::CollationInvalid),
	}
}

/// Whether a `-` comes next and opens a range: one right before the closing
/// `]` is the last member instead.
fn opens_range(chars: &std::iter::Peekable<std::str::Chars<'_>>) -> bool {
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

/// Rewrite an ERE into the form the `regex` crate reads with the meaning GNU
/// grep gives it: each bracket expression as [`take_bracket_expression`]
/// writes it, and each `{` that opens no interval escaped.
///
/// POSIX leaves a `{` that opens no interval undefined, and both GNU and BSD
/// grep take it literally, while the `regex` crate rejects the pattern
/// outright. Measured against /usr/bin/grep:
///
/// ```text
/// grep -Ec '{a}'    1, literal          regex: "repetition operator missing expression"
/// grep -Ec 'a{'     2, literal          regex: "repetition quantifier expects a valid decimal"
/// grep -Ec '{foo'   1, literal          regex: "repetition operator missing expression"
/// grep -Ec 'a{1,2'  "braces not balanced"   regex: "unclosed counted repetition"
/// ```
///
/// The last line is why this cannot simply escape every brace that fails to
/// open an interval: an unterminated interval is an ERROR in both tools, and
/// escaping it would turn a diagnosed mistake into a silent literal match.
/// A digit after `{` is what separates the two - it marks an attempted
/// interval, which is left for the engine to accept or reject.
///
/// `sed -E` reads its bracket expressions through it too; its own parser has
/// already checked each interval.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
pub(crate) fn ere_to_regex(pattern: &str) -> Result<std::borrow::Cow<'_, str>, BreError> {
	if !pattern.contains(['{', '[']) {
		return Ok(std::borrow::Cow::Borrowed(pattern));
	}

	let mut result = String::with_capacity(pattern.len());
	let mut chars = pattern.chars().peekable();

	while let Some(c) = chars.next() {
		match c {
			// An escape already spells out its own meaning; copy the pair.
			'\\' => {
				result.push('\\');
				if let Some(escaped) = chars.next() {
					result.push(escaped);
				}
			},
			// A brace inside a bracket expression is already a literal.
			'[' => take_bracket_expression(&mut chars, &mut result)?,
			'{' if !chars.peek().is_some_and(char::is_ascii_digit) => result.push_str(r"\{"),
			_ => result.push(c),
		}
	}

	Ok(std::borrow::Cow::Owned(result))
}

/// True when an ERE contains a repetition operator with nothing to repeat.
///
/// POSIX leaves this undefined and both GNU and BSD grep reject it:
/// `grep -E '^+'` is "repetition-operator operand invalid". The `regex` crate
/// instead compiles `^+` as `(?:^)+`, which matches the empty string at every
/// line start, so without this check an invalid pattern silently selects every
/// line - a wrong answer with a success exit status.
#[cfg(feature = "util.grep")]
pub(crate) fn ere_repetition_operand_missing(pattern: &str) -> bool {
	let mut chars = pattern.chars().peekable();
	let mut has_atom = false;
	// Holds the translation of each bracket expression, read to find its end.
	let mut bracket = String::new();
	while let Some(c) = chars.next() {
		match c {
			// An escaped character is a literal, and therefore an atom.
			'\\' => {
				if chars.next().is_none() {
					return false;
				}
				has_atom = true;
			},
			// A bracket expression is one atom. One the translation refuses
			// is reported there.
			'[' => {
				bracket.clear();
				if take_bracket_expression(&mut chars, &mut bracket).is_err() {
					return false;
				}
				has_atom = true;
			},
			'(' | '|' => has_atom = false,
			')' => has_atom = true,
			// Anchors are not atoms and break adjacency to any earlier atom:
			// `a^+` repeats the anchor, not `a`. Clear the operand state so
			// repetition after an anchor is rejected wherever it appears.
			'^' | '$' => has_atom = false,
			'*' | '+' | '?' if !has_atom => return true,
			// A `{` is only a repetition operator when it actually opens an
			// interval. Measured: `grep -E '^{'` matches nothing and reports
			// no error, because a `{` that cannot be parsed as `{n}`, `{n,}`
			// or `{n,m}` is an ordinary literal - while `grep -E '{1}'` IS
			// "repetition-operator operand invalid". Flagging every `{` here
			// rejected patterns the real tool accepts.
			'{' => {
				let rest: String = chars.clone().collect();
				if opens_interval(&rest) {
					if !has_atom {
						return true;
					}
				} else {
					has_atom = true;
				}
			},
			_ => has_atom = true,
		}
	}
	false
}

/// Whether `rest`, the text just past a `{`, completes a valid interval:
/// `n}`, `n,}` or `n,m}`. Anything else leaves the `{` a literal.
#[cfg(feature = "util.grep")]
fn opens_interval(rest: &str) -> bool {
	let mut chars = rest.chars().peekable();
	let mut digits = 0usize;
	while chars.peek().is_some_and(char::is_ascii_digit) {
		chars.next();
		digits += 1;
	}
	if digits == 0 {
		return false;
	}
	if chars.peek() == Some(&',') {
		chars.next();
		while chars.peek().is_some_and(char::is_ascii_digit) {
			chars.next();
		}
	}
	chars.next() == Some('}')
}

#[cfg(test)]
mod tests {
	use super::*;

	fn ere(pattern: &str) -> String {
		bre_to_ere(pattern, Backrefs::Supported).expect("translatable")
	}

	fn ere_err(pattern: &str) -> Option<BreError> {
		bre_to_ere(pattern, Backrefs::Supported).err()
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
			bre_to_ere(r"\(a\)\1", Backrefs::Unsupported).expect("translatable"),
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
		// Neither a literal nor an operator: an ERROR, which is what both
		// tools do. Emitting the operator and leaving it to the engine was
		// measurably wrong - `^{2}` and `^{1,4}` COMPILE as `(?:^){2}`, which
		// matches at every line start, so the pattern silently selected the
		// whole file with exit 0.
		assert_eq!(ere_err(r"^\{2\}"), Some(BreError::RepetitionOperandMissing));
		assert_eq!(ere_err(r"\{1,4\}"), Some(BreError::RepetitionOperandMissing));
		assert_eq!(ere_err(r"\(\{2\}\)"), Some(BreError::RepetitionOperandMissing));
		assert_eq!(ere_err(r"a\|\{2\}"), Some(BreError::RepetitionOperandMissing));
		// With an operand it is an ordinary quantifier.
		assert_eq!(ere_err(r"a\{2\}"), None);
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

	// ── ERE operand validation ───────────────────────────────────────────────

	#[cfg(feature = "util.grep")]
	#[test]
	fn ere_rejects_repetition_with_no_operand() {
		for pattern in ["^+", "^*", "^?", "^{2}", "*x", "+", "(+)", "a|+b", "(|+)"] {
			assert!(ere_repetition_operand_missing(pattern), "should reject {pattern}");
		}
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
			// report no error, while `grep -E '{1}'` IS invalid. Rejecting
			// every `{` refused patterns the real tool accepts.
			"^{",
			"{",
			"{a}",
			"{,5}",
			"^{}",
			"{1a}",
		] {
			assert!(!ere_repetition_operand_missing(pattern), "should accept {pattern}");
		}
	}

	#[cfg(feature = "util.grep")]
	#[test]
	fn ere_rejects_only_intervals_that_really_open() {
		for pattern in ["{1}", "^{2}", "{3,}", "{4,5}", "(|{6})"] {
			assert!(ere_repetition_operand_missing(pattern), "should reject {pattern}");
		}
	}

	// ── Bracket expressions ──────────────────────────────────────────────────
	// POSIX has no nested class and no set operation inside `[...]`; the
	// `regex` crate has both, so a member it would read as syntax is written
	// escaped. Each pattern's meaning below is GNU grep 3.11's.

	#[test]
	fn bracket_members_the_regex_crate_reads_as_syntax_are_escaped() {
		// `[` is a member: `[[]` selects `[`, and `[[:space:]*?[]` a space,
		// `*`, `?` or `[`.
		assert_eq!(ere("[[]"), r"[\[]");
		assert_eq!(ere("[[:space:]*?[]"), r"[[:space:]*?\[]");
		// `&&` and `~~` are two members each, not set operations.
		assert_eq!(ere("[a&&b]"), r"[a\&\&b]");
		assert_eq!(ere("[~~]"), r"[\~\~]");
		// A `-` right after a range's own is the range's end; first or last in
		// the list a `-` is a member.
		assert_eq!(ere("[!--]"), r"[!-\-]");
		assert_eq!(ere("[--/]"), r"[\--/]");
		assert_eq!(ere("[%--a]"), r"[%-\-a]");
		assert_eq!(ere("[-a]"), r"[\-a]");
		assert_eq!(ere("[a-]"), r"[a\-]");
		assert_eq!(ere("[--]"), r"[\-\-]");
		assert_eq!(ere("[a-z-]"), r"[a-z\-]");
		// A `^` that does not negate.
		assert_eq!(ere("[a^]"), r"[a\^]");
	}

	#[test]
	fn common_bracket_expressions_keep_their_meaning() {
		assert_eq!(ere("[a-z]"), "[a-z]");
		assert_eq!(ere("[^x]"), "[^x]");
		// `]` first in the list, or first after `^`, is a member.
		assert_eq!(ere("[]a]"), r"[\]a]");
		assert_eq!(ere("[^]a]"), r"[^\]a]");
		assert_eq!(ere("[]-a]"), r"[\]-a]");
		assert_eq!(ere("[[:alpha:]]"), "[[:alpha:]]");
		assert_eq!(ere("[[:digit:][:alpha:]-]"), r"[[:digit:][:alpha:]\-]");
		// `\` is a member, so `[\]]` is a backslash and then a `]`. Outside a
		// bracket expression `\]` is still an escaped `]`.
		assert_eq!(ere(r"[\]]"), r"[\\]]");
		assert_eq!(ere(r"a\]"), r"a\]");
	}

	#[test]
	fn collating_symbols_and_equivalence_classes_are_their_character() {
		assert_eq!(ere("[[.-.]]"), r"[\-]");
		assert_eq!(ere("[[.].]]"), r"[\]]");
		assert_eq!(ere("[[...]]"), "[.]");
		assert_eq!(ere("[[=a=]]"), "[a]");
		assert_eq!(ere("[[.a.]-b]"), "[a-b]");
		assert_eq!(ere("[a-[.z.]]"), "[a-z]");
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
			("[z-a]", BreError::RangeEndInvalid),
			("[a--]", BreError::RangeEndInvalid),
			("[a-b-z]", BreError::RangeEndInvalid),
			("[[:alpha:]-z]", BreError::RangeEndInvalid),
			("[[=a=]-z]", BreError::RangeEndInvalid),
			("[a-[:alpha:]]", BreError::RangeEndInvalid),
			("[a-[=z=]]", BreError::RangeEndInvalid),
		] {
			assert_eq!(ere_err(pattern), Some(error), "{pattern}");
		}
	}

	/// GNU grep 3.11 refuses each with "Unmatched [, [^, [:, [., or [=", as an
	/// ERE already did here. A BRE passed the `[` on as a plain one, and
	/// `grep` matched it literally or read a nested class.
	#[test]
	fn unterminated_bracket_expressions_are_refused_in_a_bre() {
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
			assert_eq!(ere_err(pattern), Some(BreError::BracketUnmatched), "{pattern}");
		}
	}

	#[cfg(feature = "util.grep")]
	fn ere_regex(pattern: &str) -> String {
		ere_to_regex(pattern).expect("translatable").into_owned()
	}

	#[cfg(feature = "util.grep")]
	#[test]
	fn ere_bracket_expressions_are_read_as_in_a_bre() {
		assert_eq!(ere_regex("[[]"), r"[\[]");
		assert_eq!(ere_regex("[[:space:]*?[]"), r"[[:space:]*?\[]");
		assert_eq!(ere_regex("[a&&b]+"), r"[a\&\&b]+");
		assert_eq!(ere_regex("[~~]"), r"[\~\~]");
		assert_eq!(ere_regex("[!--]"), r"[!-\-]");
		// `\` is a member inside a bracket expression and an escape outside.
		assert_eq!(ere_regex(r"[\(]|\("), r"[\\(]|\(");
		assert_eq!(ere_regex(r"[\]]"), r"[\\]]");
		// A brace is a literal inside a bracket expression, and outside one
		// unless it opens an interval.
		assert_eq!(ere_regex("[{]{a}a{2}"), r"[{]\{a}a{2}");
		// With neither, the pattern itself.
		assert!(matches!(ere_to_regex("a|b"), Ok(std::borrow::Cow::Borrowed("a|b"))));
	}

	#[cfg(feature = "util.grep")]
	#[test]
	fn ere_invalid_bracket_expressions_are_refused() {
		for (pattern, error) in [
			("a[", BreError::BracketUnmatched),
			("[]", BreError::BracketUnmatched),
			("[[:alpha:]", BreError::BracketUnmatched),
			("[[:foo:]]", BreError::ClassNameInvalid),
			("[[.ab.]]", BreError::CollationInvalid),
			("[z-a]", BreError::RangeEndInvalid),
		] {
			assert_eq!(ere_to_regex(pattern).err(), Some(error), "{pattern}");
		}
	}

	#[cfg(feature = "util.grep")]
	#[test]
	fn ere_operand_check_reads_a_bracket_expression_whole() {
		// The `(` and `+` are members, so nothing repeats a missing operand.
		for pattern in ["[[:alpha:](+]", "[](+]*", "[[.].](+]"] {
			assert!(!ere_repetition_operand_missing(pattern), "should accept {pattern}");
		}
		assert!(ere_repetition_operand_missing("[a](+)"), "should reject [a](+)");
	}
}
