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
	/// PCRE2_UCP, where a POSIX class already means the Unicode one, and it
	/// has the look-around the word edges need.
	Pcre,
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
	/// grep -c '[[:alpha:]]'` is 1); PCRE2 already does with PCRE2_UCP, and in
	/// the C locale a byte from 0x80 up is no letter.
	const fn unicode_letters(self) -> bool {
		!matches!(self, Self::Pcre | Self::RustBytes)
	}
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
	/// as in `grep '[:alpha:]'`.
	ClassSyntaxConfused,
	/// A `[.c.]` or `[=c=]` holding other than one single-byte character.
	CollationInvalid,
	/// A range that runs backwards - once its ends are folded, under `-i` -
	/// or that has a class for an end, or a `-` after a range or class in a
	/// bracket expression that is not its last member.
	RangeEndInvalid,
	/// A `\{` that opens no interval where an interval must follow.
	BraceUnmatched,
	/// A repetition operator with nothing to repeat, or one more repetition
	/// than the dialect allows, which `sed` refuses where `grep` reads the
	/// text itself or drops the operator.
	RepetitionOperandMissing,
	/// A `)` or `\)` that closes no group, where the dialect refuses one.
	ParenUnmatched,
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
			Self::RepetitionOperandMissing => "Invalid preceding regular expression",
			Self::ParenUnmatched => "Unmatched ) or \\)",
			Self::BackReferenceInvalid => "Invalid back reference",
			Self::TrailingBackslash => "Trailing backslash",
		}
	}
}

/// [`translate_multiline`] for a pattern searched in one line at a time, as
/// `grep` and `nl` search it.
#[cfg(any(feature = "util.grep", feature = "util.nl", test))]
pub(crate) fn translate(
	pattern: &str,
	dialect: Dialect,
	target: Target,
	icase: bool,
	strictness: Strictness,
) -> Result<String, BreError> {
	translate_multiline(pattern, dialect, target, icase, strictness, false)
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
	Translator {
		chars: pattern.chars().peekable(),
		out: String::with_capacity(pattern.len() + 8),
		dialect,
		target,
		strictness,
		icase,
		multiline,
		atom: None,
		quantified: false,
		anchored: false,
		groups: Vec::new(),
		opened: 0,
		completed: 0,
	}
	.run()
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

/// Whether `pattern`, written in `dialect`, opens a group.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
fn opens_group(pattern: &str, dialect: Dialect) -> bool {
	holds(pattern, |c, escaped| c == '(' && escaped == (dialect == Dialect::Basic))
}

/// The most alternatives [`alternatives`] expands a pattern into. A pattern
/// with more of them is searched whole, as the engine prefers it.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
const ALTERNATIVE_LIMIT: usize = 64;

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
/// closes, or when it would expand into more than [`ALTERNATIVE_LIMIT`]
/// branches.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
pub(crate) fn alternatives(pattern: &str, dialect: Dialect, split: Split) -> Vec<String> {
	if !pattern.contains('|') || (split == Split::Grep && has_backreference(pattern)) {
		return vec![pattern.to_owned()];
	}
	let mut chars = pattern.chars().peekable();
	match expand(&mut chars, dialect, split == Split::Grep, false) {
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

/// Expands the alternation the iterator holds into its branches, stopping at
/// the end of the pattern or, when `nested`, after the group's closing text.
/// Returns the branches and the raw text consumed before that closing text.
#[cfg(any(feature = "util.grep", feature = "util.sed"))]
fn expand(
	chars: &mut Peekable<Chars<'_>>,
	dialect: Dialect,
	distribute: bool,
	nested: bool,
) -> Option<(Vec<String>, String)> {
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
				let (inner, inner_raw) = expand(chars, dialect, distribute, true)?;
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
	read_interval(&mut ahead, dialect).is_some_and(|(operator, _)| {
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
	/// Where in `out` the atom a repetition operator repeats begins, or
	/// `None` at a branch start, where there is nothing to repeat.
	atom:       Option<usize>,
	/// Whether that atom already carries a repetition operator, so the next
	/// one repeats the repetition instead of reading as the engine's lazy
	/// flag: GNU reads `a\+\?` as `(a+)?`, which matches the empty string.
	quantified: bool,
	/// Whether the branch's `^` anchor has been read: in a BRE only the first
	/// caret of a branch anchors, and `grep -c '^^'` counts the lines that
	/// start with a caret.
	anchored:   bool,
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
			match c {
				'\\' => self.escape()?,
				'[' => {
					let start = self.out.len();
					take_bracket_expression(
						&mut self.chars,
						&mut self.out,
						self.icase,
						self.target,
						self.multiline,
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
				'^' => self.caret(),
				'$' => self.dollar(),
				_ => self.literal(c),
			}
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
			_ if matches!(c, 'w' | 'W' | 's' | 'S' | 'b' | 'B') || c.is_ascii_punctuation() => {
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
		match read_interval(&mut self.chars, self.dialect) {
			Some((operator, literal)) => self.repeat(&operator, &literal),
			// `grep 'a\{1'` and `grep 'a\{x'` are "Unmatched \{", while a
			// `\{` with nothing to repeat is an ordinary brace
			// (`grep -c '\{'` counts the lines holding one).
			None if self.dialect == Dialect::Basic && self.atom.is_some() => {
				Err(BreError::BraceUnmatched)
			},
			// An ERE takes a brace that opens no interval literally:
			// `grep -cE 'a{1'` counts the lines holding the text `a{1`.
			None => {
				self.literal('{');
				Ok(())
			},
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
		self.anchored = false;
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
		self.anchored = false;
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

	/// In a BRE `^` anchors only at the start of a branch, and only once
	/// there; in an ERE it always anchors.
	fn caret(&mut self) {
		if self.dialect == Dialect::Extended || (self.atom.is_none() && !self.anchored) {
			let start = self.out.len();
			self.out.push('^');
			self.anchored = true;
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
		} else {
			self.atom = None;
			self.quantified = false;
		}
	}

	fn literal(&mut self, c: char) {
		let start = self.out.len();
		push_literal(&mut self.out, c);
		self.set_atom(start);
	}

	fn set_atom(&mut self, start: usize) {
		self.atom = Some(start);
		self.quantified = false;
	}
}

/// Reads the interval after an opening brace, leaving the iterator where it
/// was when the text that follows is no interval. Returns the operator the
/// engines read and the text GNU matches where there is nothing to repeat.
fn read_interval(chars: &mut Peekable<Chars<'_>>, dialect: Dialect) -> Option<(String, String)> {
	let mut ahead = chars.clone();
	let mut low = String::new();
	while let Some(digit) = ahead.next_if(char::is_ascii_digit) {
		low.push(digit);
	}
	let high = ahead.next_if_eq(&',').map(|_| {
		let mut text = String::new();
		while let Some(digit) = ahead.next_if(char::is_ascii_digit) {
			text.push(digit);
		}
		text
	});
	// `{` followed by neither a digit nor a comma opens no interval; GNU
	// reads `{,}` as `{0,}` (`grep -cE 'a{,}'` counts every line).
	if low.is_empty() && high.is_none() {
		return None;
	}
	if dialect == Dialect::Basic && ahead.next_if_eq(&'\\').is_none() {
		return None;
	}
	ahead.next_if_eq(&'}')?;
	let literal = match &high {
		Some(high) => format!("{{{low},{high}}}"),
		None => format!("{{{low}}}"),
	};
	// GNU reads `{,m}` as `{0,m}`: `grep -cE 'a{,2}'` counts every line.
	let operator = match &high {
		Some(high) if low.is_empty() => format!("{{0,{high}}}"),
		_ => literal.clone(),
	};
	*chars = ahead;
	Some((operator, literal))
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
/// close the list, and a list that is a class name without the outer
/// brackets.
///
/// A list that negates holds no newline where `multiline` (GNU sed's `M`
/// flag): `[^x]*$` stops at the end of a line there.
fn take_bracket_expression(
	chars: &mut Peekable<Chars<'_>>,
	out: &mut String,
	icase: bool,
	target: Target,
	multiline: bool,
) -> Result<(), BreError> {
	out.push('[');
	if chars.next_if_eq(&'^').is_some() {
		out.push('^');
		if multiline {
			out.push_str("\\n");
		}
	}
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
				// GNU checks the range against the ends it folds: `[Z-a]` is
				// a range of its own and "Invalid range end" under `-i`,
				// while `[a-Z]` is the other way round. One the engine cannot
				// express is refused here rather than searched as something
				// else.
				let (low, high) = if icase {
					(start.to_ascii_uppercase(), end.to_ascii_uppercase())
				} else {
					(start, end)
				};
				if high < low {
					return Err(BreError::RangeEndInvalid);
				}
				push_bracket_char(out, start);
				out.push('-');
				push_bracket_char(out, end);
			},
			BracketMember::Char(c) | BracketMember::Equivalence(c) => push_bracket_char(out, c),
			BracketMember::Class(name) => push_bracket_class(out, name, target),
		}
		match chars.peek() {
			None => return Err(BreError::BracketUnmatched),
			Some(']') => {
				chars.next();
				out.push(']');
				return if opens_colon && ends_colon && other_member && !special {
					Err(BreError::ClassSyntaxConfused)
				} else {
					Ok(())
				};
			},
			Some(_) => {},
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

/// Append the POSIX class `name` as a member of a class.
///
/// The letter classes are written as the Unicode property of the same name
/// where the engine's own POSIX class holds ASCII alone: GNU in a UTF-8
/// locale counts `ß` as a letter, so `printf '\303\237\n' | grep -cw
/// '[[:alpha:]]'` is 1. The others keep their POSIX definition, which is what
/// GNU gives them in the C locale and, for `digit` and `xdigit`, in C.UTF-8
/// as well.
fn push_bracket_class(out: &mut String, name: &str, target: Target) {
	let unicode = match name {
		_ if !target.unicode_letters() => None,
		"alpha" => Some(r"\p{Alphabetic}"),
		"alnum" => Some(r"\p{Alphabetic}\p{Nd}"),
		"lower" => Some(r"\p{Lowercase}"),
		"upper" => Some(r"\p{Uppercase}"),
		_ => None,
	};
	match unicode {
		Some(property) => out.push_str(property),
		None => {
			out.push_str("[:");
			out.push_str(name);
			out.push_str(":]");
		},
	}
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
		// With nothing to repeat it is an ordinary brace: `grep -c '\{'`
		// counts the lines holding one.
		assert_eq!(bre(r"\{"), r"\{");
		assert_eq!(bre(r"\}"), r"\}");
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
		// An interval that opens is left for the engine, which refuses
		// `a{2,1}` as GNU does ("Invalid content of \{\}").
		assert_eq!(ere("a{2}"), "a{2}");
		assert_eq!(ere("a{2,}"), "a{2,}");
		// GNU reads `{,m}` as `{0,m}`: `grep -cE 'a{,2}'` counts every line.
		assert_eq!(ere("a{,2}"), "a{0,2}");
		assert_eq!(bre(r"a\{,2\}"), "a{0,2}");
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
		// PCRE2 runs with PCRE2_UCP, where the POSIX class already means the
		// Unicode one.
		assert_eq!(
			translate("[[:alpha:]]", Dialect::Basic, Target::Pcre, false, Strictness::Lenient).unwrap(),
			"[[:alpha:]]"
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
}
