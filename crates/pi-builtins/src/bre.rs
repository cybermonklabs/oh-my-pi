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

/// A pattern the BRE dialect cannot express.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum BreError {
	/// A repetition operator with nothing to repeat, where the tools error
	/// rather than treating the character as a literal.
	RepetitionOperandMissing,
	/// A bracket expression with no closing `]`, or a `[:`, `[.` or `[=` in
	/// one with no closing `:]`, `.]` or `=]`.
	UnmatchedBracket,
	/// A `\(` with no `\)`.
	UnmatchedGroup,
	/// A `\{` with no `\}`.
	UnmatchedInterval,
	/// A collating symbol or equivalence class that is not one byte, such as
	/// `[[.é.]]`: glibc's C and C.UTF-8 locales collate byte by byte.
	InvalidCollation,
	/// A class name without its outer brackets, such as `[:alpha:]`.
	#[cfg_attr(not(feature = "util.grep"), allow(dead_code, reason = "only grep refuses it"))]
	MisspelledClass,
	/// A range whose end sorts before its start, such as `[Z-a]` under `-i`.
	#[cfg_attr(not(feature = "util.grep"), allow(dead_code, reason = "only grep refuses it"))]
	InvalidRangeEnd,
}

impl BreError {
	/// The message for this condition, in GNU's words where GNU refuses it.
	pub(crate) fn message(self) -> &'static str {
		match self {
			Self::RepetitionOperandMissing => "repetition-operator operand invalid",
			Self::UnmatchedBracket => "Unmatched [, [^, [:, [., or [=",
			Self::UnmatchedGroup => r"Unmatched ( or \(",
			Self::UnmatchedInterval => r"Unmatched \{",
			Self::InvalidCollation => "Invalid collation character",
			Self::MisspelledClass => "character class syntax is [[:space:]], not [:space:]",
			Self::InvalidRangeEnd => "Invalid range end",
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
	// How many `\(` are still open: one never closed is refused, as GNU
	// refuses it, rather than left to the engine.
	let mut open_groups = 0usize;
	while let Some(c) = chars.next() {
		if c == '\\' {
			match chars.peek() {
				Some('(') => {
					chars.next();
					result.push('('); // Group start
					open_groups += 1;
					has_atom = false;
					anchored = false;
				},
				Some(')') => {
					chars.next();
					result.push(')'); // Group end
					open_groups = open_groups.saturating_sub(1);
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
					// glibc reads on to the end of the pattern for the `\}`
					// that closes the interval, so `a\{2` is "Unmatched \{".
					if !closes_interval(&chars) {
						return Err(BreError::UnmatchedInterval);
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

	if open_groups > 0 {
		return Err(BreError::UnmatchedGroup);
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

/// Make an ERE's non-interval `{` the literal both real tools treat it as.
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
#[cfg(feature = "util.grep")]
pub(crate) fn ere_literalize_braces(pattern: &str) -> std::borrow::Cow<'_, str> {
	if !pattern.contains('{') {
		return std::borrow::Cow::Borrowed(pattern);
	}

	let mut result = String::with_capacity(pattern.len());
	let mut chars = pattern.chars().peekable();
	let mut rewrote = false;

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
			'[' => match take_bracket_expression(&mut chars, false) {
				Ok(bracket) => {
					result.push('[');
					result.push_str(&bracket.body);
				},
				Err(_) => result.push('['),
			},
			'{' if !chars.peek().is_some_and(char::is_ascii_digit) => {
				result.push_str(r"\{");
				rewrote = true;
			},
			_ => result.push(c),
		}
	}

	if rewrote { std::borrow::Cow::Owned(result) } else { std::borrow::Cow::Borrowed(pattern) }
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
	while let Some(c) = chars.next() {
		match c {
			// An escaped character is a literal, and therefore an atom.
			'\\' => {
				if chars.next().is_none() {
					return false;
				}
				has_atom = true;
			},
			// A bracket expression is one atom. `]` immediately after the
			// opening bracket (or its negation) is a literal, not the close.
			'[' => {
				if chars.peek() == Some(&'^') {
					chars.next();
				}
				if chars.peek() == Some(&']') {
					chars.next();
				}
				for inner in chars.by_ref() {
					if inner == ']' {
						break;
					}
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

	/// GNU grep refuses each pattern below with exit 2 and prints no line.
	/// Regressed: grep searched a pattern that is not valid, as the text
	/// typed or as a list GNU never reads, and a caller took the count or
	/// the "no match" for a real answer.
	#[cfg(feature = "util.grep")]
	#[tokio::test(flavor = "multi_thread")]
	async fn an_unterminated_bracket_is_refused_in_a_bre() {
		use crate::{grep::Grep, host::run_async_util};

		let lines = "a\n:\nb]\n^\na[b\nx[]\nx\n[x\n";
		for (args, stdin) in [
			// A `[` with no closing `]`, so nothing closes the list.
			(&["-n", "a[b"][..], lines),
			// A `[` that ends the pattern.
			(&["-c", "a["], lines),
			(&["-o", "a["], lines),
			// A `]` first in the list is a member, so it closes nothing.
			(&["-n", "x[]"], lines),
			(&["-n", "[]"], lines),
			(&["-n", "[^]"], lines),
			// A valid class, and then no closing `]`.
			(&["-n", "[[:alpha:]"], lines),
			// One invalid pattern beside a valid one.
			(&["-n", "-e", "[x", "-e", "x"], lines),
			// A group or an interval the pattern never closes.
			(&["-c", r"\(a"], "x\n"),
			(&["-c", r"a\{2"], "x\n"),
			// A class name without its outer brackets: "character class
			// syntax is [[:space:]], not [:space:]", in an ERE too.
			(&["-c", "[:alpha:]"], "a:\n"),
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

	/// Repetition operators and intervals read as glibc reads them, which
	/// GNU grep, nl and sed share. Regressed: `a+?` was a lazy `+`, a leading
	/// `*` or `{1}` stopped grep, `{,2}` and `a{1` were text or errors as the
	/// engine chose, a malformed interval took the engine's message, and a
	/// count above 32767 was searched.
	#[cfg(all(feature = "util.grep", feature = "util.nl", feature = "util.sed"))]
	#[tokio::test(flavor = "multi_thread")]
	async fn repetition_operators_and_intervals_read_as_glibc_reads_them() {
		use crate::{
			grep::Grep,
			host::{run_async_util, run_util},
			nl::Nl,
			sed::Sed,
		};

		for (args, stdin, expected) in [
			// A `?` after another operator repeats it: `(a+)?`, not a lazy `+`.
			(&["-cE", "a+?"][..], "b\n", (0, "1\n")),
			(&["-c", r"a\+\?"], "b\n", (0, "1\n")),
			(&["-oE", "a*?"], "aa\n", (0, "aa\n")),
			// An ERE operator with nothing to repeat is skipped.
			(&["-cE", "*x"], "x\n", (0, "1\n")),
			(&["-cE", "(*a)"], "a\nb\n", (0, "1\n")),
			// `{,2}` is `{0,2}` and `{,}` is `{0,}`, in either dialect.
			(&["-cE", "a{,2}"], "b\n", (0, "1\n")),
			(&["-c", r"a\{,2\}"], "b\n", (0, "1\n")),
			(&["-c", r"a\{,\}"], "b\n", (0, "1\n")),
			// An ERE brace whose count a character interrupts, or that the
			// pattern ends inside of, is text; one with no count is refused.
			(&["-cE", "a{1"], "a{1\n", (0, "1\n")),
			(&["-cE", "a{1,x"], "a{1,x\nax\n", (0, "1\n")),
			(&["-cE", "a{1x}"], "a{1x}\n", (0, "1\n")),
			(&["-cE", "a{}"], "a{}\n", (2, "")),
			// So is an ERE `)` that closes no group.
			(&["-cE", "a)"], "a)\n", (0, "1\n")),
			// A BRE `\{` with nothing to repeat is text, whatever its count.
			(&["-c", r"\{"], "{\n", (0, "1\n")),
			(&["-c", r"\{1"], "{1\n", (0, "1\n")),
			(&["-c", r"\{32768\}"], "{32768}\n", (0, "1\n")),
			// After an anchor a brace that makes no interval is text.
			(&["-cE", "^{1,2,3}"], "{1,2,3}\n", (0, "1\n")),
			(&["-cE", "a${1,2,3}"], "a{1,2,3}\n", (1, "0\n")),
			(&["-cE", "^*{1,2,3}"], "{1,2,3}\n", (0, "1\n")),
			(&["-cE", r"\b{1,2,3}"], "x{1,2,3}\n", (0, "1\n")),
			(&["-c", r"\B\{\}"], "{}\n", (0, "1\n")),
			// After any other atom it is refused.
			(&["-cE", r"\w{1,2,3}"], "x{1,2,3}\n", (2, "")),
			(&["-cE", "(^){1,2,3}"], "x\n", (2, "")),
			// An ERE that starts with an interval reads its text after `{`.
			(&["-Eo", "{1}"], "{1}\n", (0, "1}\n")),
			(&["-Eow", "{1}"], "{1}\n", (0, "1}\n")),
			(&["-Eo", "{1}y"], "x{1}y\n", (0, "1}y\n")),
			// A count above 32767 is too big, as GNU's dfa finds after an
			// anchor too; 32767 is the most.
			(&["-cE", "a{32768,}"], "a\n", (2, "")),
			(&["-cE", "^{32768}"], "a\n", (2, "")),
			(&["-c", r"a\{32767\}"], "a\n", (1, "0\n")),
		] {
			let (code, capture) = run_async_util::<Grep>(args, stdin, "/").await;
			assert_eq!((code, capture.out().as_str()), expected, "grep {args:?}: {}", capture.err());
		}

		for (args, message) in [
			(&["-E", "a{2,1}"][..], r"Invalid content of \{\}"),
			(&[r"a\{1,2,3\}"], r"Invalid content of \{\}"),
			(&[r"a\{\}"], r"Invalid content of \{\}"),
			(&[r"a\{1,32768\}"], "Regular expression too big"),
		] {
			let (code, capture) = run_async_util::<Grep>(args, "a\n", "/").await;
			let err = format!("grep: {message}\n");
			assert_eq!((code, capture.out(), capture.err()), (2, String::new(), err), "grep {args:?}");
		}
		for (spec, message) in
			[(r"-bpa\{1,2,3\}", r"Invalid content of \{\}"), (r"-bpa\{1,32768\}", "Regular expression too big")]
		{
			let (code, capture) = run_util::<Nl>(&[spec], "a\n", "/");
			let err = format!("nl: {message}\n");
			assert_eq!((code, capture.out(), capture.err()), (1, String::new(), err), "nl {spec}");
		}
		// With `{` the delimiter, `\{` is a brace of the ERE.
		let (code, capture) = run_util::<Sed>(&["-E", r"s{a\{1,32768}{Y{"], "a\n", "/");
		assert_eq!((code, capture.out().as_str()), (1, ""), "{}", capture.err());
	}
}
