//! JSON nested deeper than `serde_json` reads.
//!
//! `serde_json` parses at most 128 levels, and decoding a [`Value`] into
//! another and dropping one both recurse once per level, which overflows the
//! stack long before the tree of a long session ends: `get_tree` nests each
//! entry two levels under its parent. [`parse`] builds a value on a stack of
//! its own, [`dispose`] drops one the same way, and [`Detached`] moves a parsed
//! value into a result field instead of rebuilding it.

use serde::de::Error as _;
use serde_json::{Map, Value};

/// `serde_json::from_slice::<Value>(text)`, also for text nested deeper than
/// it reads. Scalars and member names are still read by `serde_json`.
pub(crate) fn parse(text: &[u8]) -> Result<Value, serde_json::Error> {
	match serde_json::from_slice(text) {
		Ok(value) => Ok(value),
		// Text it refuses for another reason fails the deep parse too.
		Err(error) => parse_deep(text).map_err(|_| error),
	}
}

/// Drops `value` without recursing into it.
pub(crate) fn dispose(value: Value) {
	let mut pending = vec![value];
	while let Some(value) = pending.pop() {
		match value {
			Value::Array(items) => pending.extend(items),
			Value::Object(members) => pending.extend(members.into_iter().map(|(_, member)| member)),
			_ => {},
		}
	}
}

/// A container being parsed, with the members read so far.
enum Open {
	Array(Vec<Value>),
	/// The members, and the name of the member being read.
	Object(Map<String, Value>, String),
}

impl Open {
	fn into_value(self) -> Value {
		match self {
			Self::Array(items) => Value::Array(items),
			Self::Object(members, _) => Value::Object(members),
		}
	}
}

fn parse_deep(text: &[u8]) -> Result<Value, serde_json::Error> {
	let mut open = Vec::new();
	let parsed = parse_into(text, &mut open);
	// Left open by an error: their members may nest deep.
	while let Some(container) = open.pop() {
		dispose(container.into_value());
	}
	parsed
}

fn parse_into(text: &[u8], open: &mut Vec<Open>) -> Result<Value, serde_json::Error> {
	let mut at = skip_space(text, 0);
	loop {
		// A value starts at `at`: open a container, or read a scalar whole.
		let mut value = match text.get(at) {
			Some(b'[') => {
				at = skip_space(text, at + 1);
				if text.get(at) != Some(&b']') {
					open.push(Open::Array(Vec::new()));
					continue;
				}
				at += 1;
				Value::Array(Vec::new())
			},
			Some(b'{') => {
				at = skip_space(text, at + 1);
				if text.get(at) != Some(&b'}') {
					let (key, next) = read_key(text, at)?;
					open.push(Open::Object(Map::new(), key));
					at = next;
					continue;
				}
				at += 1;
				Value::Object(Map::new())
			},
			_ => {
				let end = scalar_end(text, at)?;
				let scalar = serde_json::from_slice(&text[at..end])?;
				at = end;
				scalar
			},
		};
		// `value` is whole: add it to the innermost container, closing each
		// container it completes.
		loop {
			let Some(container) = open.last_mut() else {
				at = skip_space(text, at);
				if at != text.len() {
					dispose(value);
					return Err(syntax_error(text, at));
				}
				return Ok(value);
			};
			let closing = match container {
				Open::Array(items) => {
					items.push(value);
					b']'
				},
				Open::Object(members, key) => {
					members.insert(std::mem::take(key), value);
					b'}'
				},
			};
			at = skip_space(text, at);
			match text.get(at) {
				Some(b',') => {
					at = skip_space(text, at + 1);
					if let Open::Object(_, key) = container {
						let (name, next) = read_key(text, at)?;
						*key = name;
						at = next;
					}
					break;
				},
				Some(&byte) if byte == closing => {
					at += 1;
					let Some(closed) = open.pop() else {
						unreachable!("the innermost container is open")
					};
					value = closed.into_value();
				},
				_ => return Err(syntax_error(text, at)),
			}
		}
	}
}

fn skip_space(text: &[u8], mut at: usize) -> usize {
	while matches!(text.get(at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
		at += 1;
	}
	at
}

/// End of the string, number or literal at `at`, which `serde_json` then
/// reads (and validates) whole.
fn scalar_end(text: &[u8], at: usize) -> Result<usize, serde_json::Error> {
	if text.get(at) == Some(&b'"') {
		return string_end(text, at);
	}
	let mut end = at;
	while matches!(text.get(end), Some(b'-' | b'+' | b'.' | b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z')) {
		end += 1;
	}
	if end == at { Err(syntax_error(text, at)) } else { Ok(end) }
}

/// End of the string at `at`, past its closing quote.
fn string_end(text: &[u8], at: usize) -> Result<usize, serde_json::Error> {
	let mut end = at + 1;
	loop {
		match text.get(end) {
			Some(b'"') => return Ok(end + 1),
			Some(b'\\') => end += 2,
			Some(_) => end += 1,
			None => return Err(syntax_error(text, end)),
		}
	}
}

/// The member name at `at`, and where the member's value starts, past its
/// colon.
fn read_key(text: &[u8], at: usize) -> Result<(String, usize), serde_json::Error> {
	if text.get(at) != Some(&b'"') {
		return Err(syntax_error(text, at));
	}
	let end = string_end(text, at)?;
	let key = serde_json::from_slice::<String>(&text[at..end])?;
	let colon = skip_space(text, end);
	if text.get(colon) != Some(&b':') {
		return Err(syntax_error(text, colon));
	}
	Ok((key, skip_space(text, colon + 1)))
}

fn syntax_error(text: &[u8], at: usize) -> serde_json::Error {
	match text.get(at) {
		Some(&byte) => serde_json::Error::custom(format_args!(
			"unexpected {:?} at byte {at} of the JSON text",
			char::from(byte)
		)),
		None => serde_json::Error::custom("unexpected end of the JSON text"),
	}
}

/// A result field that keeps JSON as received: a value of its shape is moved
/// into it, never rebuilt.
pub(crate) trait RawJson: Sized {
	/// What the field reads, for a decode error.
	const EXPECTED: &'static str;

	/// Whether `value` has the field's shape, checked as deep as the type goes.
	fn fits(value: &Value) -> bool;

	/// `value`, which [`fits`](Self::fits), as the field's type.
	fn take(value: Value) -> Self;
}

impl RawJson for Value {
	const EXPECTED: &'static str = "a JSON value";

	fn fits(_: &Value) -> bool {
		true
	}

	fn take(value: Value) -> Self {
		value
	}
}

impl RawJson for Map<String, Value> {
	const EXPECTED: &'static str = "an object";

	fn fits(value: &Value) -> bool {
		value.is_object()
	}

	fn take(value: Value) -> Self {
		match value {
			Value::Object(members) => members,
			_ => Map::new(),
		}
	}
}

impl<T: RawJson> RawJson for Vec<T> {
	const EXPECTED: &'static str = "an array";

	fn fits(value: &Value) -> bool {
		value.as_array().is_some_and(|items| items.iter().all(T::fits))
	}

	fn take(value: Value) -> Self {
		match value {
			Value::Array(items) => items.into_iter().map(T::take).collect(),
			_ => Vec::new(),
		}
	}
}

impl<T: RawJson> RawJson for Option<T> {
	const EXPECTED: &'static str = T::EXPECTED;

	fn fits(value: &Value) -> bool {
		value.is_null() || T::fits(value)
	}

	fn take(value: Value) -> Self {
		if value.is_null() { None } else { Some(T::take(value)) }
	}
}

/// Members of a result object that keep JSON as received, swapped out for
/// shallow placeholders while serde decodes the rest and then moved into their
/// fields ([`place`](Self::place)). A member not moved is disposed of on drop.
pub(crate) struct Detached(Vec<Option<Value>>);

impl Detached {
	/// Swaps each present member `(key, placeholder)` of `members` out of
	/// `object`.
	pub(crate) fn new<const N: usize>(object: &mut Value, members: [(&str, Value); N]) -> Self {
		Self(
			members
				.into_iter()
				.map(|(key, placeholder)| {
					let slot = object.as_object_mut()?.get_mut(key)?;
					Some(std::mem::replace(slot, placeholder))
				})
				.collect(),
		)
	}

	/// Moves member `index` (named `key`) into `field`; leaves `field` as
	/// decoded when the member was absent.
	pub(crate) fn place<T: RawJson>(
		&mut self,
		index: usize,
		key: &str,
		field: &mut T,
	) -> Result<(), serde_json::Error> {
		let Some(value) = self.0[index].take() else {
			return Ok(());
		};
		if !T::fits(&value) {
			dispose(value);
			return Err(serde_json::Error::custom(format_args!(
				"invalid type for `{key}`: expected {}",
				T::EXPECTED
			)));
		}
		*field = T::take(value);
		Ok(())
	}
}

impl Drop for Detached {
	fn drop(&mut self) {
		self.0.drain(..).flatten().for_each(dispose);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_as_serde_json_does() {
		for text in [
			"{}",
			"[]",
			r#"{"a":1,"b":[1,2.5,-3e2,true,false,null],"c":{"d":"x\u00e9\n\"\\"}}"#,
			r#" [ 1 , { "k" : [ ] } ] "#,
			r#""s""#,
			"-0.5E+3",
			r#"{"a":1,"a":2}"#,
			"[[[[]]],{}]",
		] {
			let expected: Value = serde_json::from_str(text).unwrap();
			assert_eq!(parse_deep(text.as_bytes()).unwrap(), expected, "{text}");
		}
		for text in [
			"[1,]", r#"{"a"}"#, r#"{"a":1,}"#, "[1 2]", "{a:1}", "[", "", "1 2", "[01]", "tru",
			r#"{"a":1}x"#, "\"\u{1}\"",
		] {
			assert!(parse_deep(text.as_bytes()).is_err(), "{text}");
		}
	}

	#[test]
	fn parses_and_disposes_of_a_value_of_any_depth() {
		let depth = 200_000;
		let text = format!("{}{}", "[".repeat(depth), "]".repeat(depth));
		assert!(serde_json::from_str::<Value>(&text).is_err());
		let mut value = parse(text.as_bytes()).unwrap();
		let mut levels = 0;
		while let Value::Array(mut items) = value {
			levels += 1;
			value = items.pop().unwrap_or(Value::Null);
		}
		assert_eq!(levels, depth);
		dispose(parse(text.as_bytes()).unwrap());
		// An error after a deep member disposes of what it built.
		let broken = format!("[{}{},x]", "[".repeat(depth), "]".repeat(depth));
		assert!(parse(broken.as_bytes()).is_err());
	}
}
