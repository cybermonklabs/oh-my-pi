//! `entry_patch` records of a session transcript, as every reader of the file
//! applies them: a port of `packages/utils/src/entry-patches.ts`, the rules
//! the omp readers share. A change to the rules changes both.
//!
//! A pass that changes an entry after its line is written (a retry saga's
//! marker, a compaction's dead-end `warning` or corrected `tokensAfter`, a
//! snapcompact archive, an elide pass's placeholders) appends one `custom`
//! entry with `customType` [`ENTRY_PATCH_CUSTOM_TYPE`] that names entries
//! already in the file and the fields to set on them, instead of rewriting the
//! file. The original lines stay, so a reader that shows or derives anything
//! from those fields applies the records first:
//!
//! - over the entries of a whole transcript, or of one window of it,
//!   [`apply_entry_patches`];
//! - over entries a reader read and kept earlier (an earlier window of a
//!   transcript, rows it stored), [`entry_patches_of`] on each later record,
//!   then [`entry_accepts_patch`] and [`set_patched_fields`] on the kept entry
//!   the patch names, in file order.
//!
//! Records apply in file order, so the newest value of a field wins, and
//! applying them again changes nothing.

use std::collections::{HashMap, VecDeque};

use serde_json::{Map, Value};

use crate::deep::drop_deep;

/// `customType` of an `entry_patch` record.
pub const ENTRY_PATCH_CUSTOM_TYPE: &str = "entry_patch";

/// Why a reader left a record, or one patch of it, unapplied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryPatchSkipReason {
	/// The record's `data` is not a list of patches of the fields a patch may
	/// set; a text block without a string `text`, an image block without
	/// string `data`, and a counter that is not a finite number make it so.
	Malformed,
	/// No entry has the id the patch names.
	MissingTarget,
	/// The patch names a field its target's kind or role lacks, or `content`
	/// of another shape.
	Misfit,
}

/// A record, or one patch of it, a reader left unapplied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryPatchSkip {
	pub reason:    EntryPatchSkipReason,
	/// Id of the record.
	pub record_id: Option<String>,
	/// Id of the entry the patch names; `None` for a malformed record.
	pub entry_id:  Option<String>,
}

/// One field a patch sets, by where it lives: on the entry, or on a `message`
/// entry's message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum PatchField {
	EntryWarning,
	EntryTokensAfter,
	EntryPreserveData,
	EntryContent,
	MessageRetryRecovery,
	MessageContinued,
	MessageContextSnapshot,
	MessageElidedOutputTokens,
	MessagePrunedAt,
	MessageContent,
}

/// Fields of a `compaction` entry a patch may set.
const COMPACTION_FIELDS: [(&str, PatchField); 3] = [
	("warning", PatchField::EntryWarning),
	("tokensAfter", PatchField::EntryTokensAfter),
	("preserveData", PatchField::EntryPreserveData),
];

/// Fields of an assistant message a patch may set, `content` aside.
const ASSISTANT_FIELDS: [(&str, PatchField); 4] = [
	("retryRecovery", PatchField::MessageRetryRecovery),
	("continued", PatchField::MessageContinued),
	("contextSnapshot", PatchField::MessageContextSnapshot),
	("elidedOutputTokens", PatchField::MessageElidedOutputTokens),
];

/// For a message role whose `content` an elide pass shortens, whether that
/// `content` may be a string; assistant and tool-result `content` is always a
/// list of blocks.
fn content_takes_string(role: &str) -> Option<bool> {
	match role {
		"user" | "developer" => Some(true),
		"assistant" | "toolResult" => Some(false),
		_ => None,
	}
}

/// Whether `block` is a content block a message can hold: a string `type`, and
/// the payload a text or image block carries (`text`, `data`) as a string, so
/// a provider request built from it never meets a block without its payload.
fn is_content_block(block: &Value) -> bool {
	let payload = match block.get("type").and_then(Value::as_str) {
		None => return false,
		Some("text") => "text",
		Some("image") => "data",
		Some(_) => return true,
	};
	block.get(payload).is_some_and(Value::is_string)
}

/// `content` as a record holds it: a string, or a list of content blocks.
fn is_content(value: &Value) -> bool {
	match value {
		Value::String(_) => true,
		Value::Array(blocks) => blocks.iter().all(is_content_block),
		_ => false,
	}
}

/// Whether `value` is a finite number, as every counter a patch sets is:
/// `JSON.parse` reads a number past the `f64` range (`1e400`) as Infinity.
/// serde_json refuses such a number by default; with its `arbitrary_precision`
/// feature, which any crate in a build can turn on, a [`Value`] holds it, and
/// [`Value::is_number`] accepts it.
fn is_count(value: &Value) -> bool {
	value.as_f64().is_some_and(f64::is_finite)
}

/// Whether `object` lacks `key`, or holds a value there that `check` accepts.
fn absent_or(object: &Map<String, Value>, key: &str, check: impl FnOnce(&Value) -> bool) -> bool {
	object.get(key).is_none_or(check)
}

fn is_entry_fields(value: &Value) -> bool {
	value.as_object().is_some_and(|fields| {
		absent_or(fields, "warning", Value::is_string)
			&& absent_or(fields, "tokensAfter", is_count)
			&& absent_or(fields, "preserveData", Value::is_object)
			&& absent_or(fields, "content", is_content)
	})
}

fn is_message_fields(value: &Value) -> bool {
	value.as_object().is_some_and(|fields| {
		absent_or(fields, "retryRecovery", Value::is_object)
			&& absent_or(fields, "continued", |continued| continued.as_bool() == Some(true))
			&& absent_or(fields, "contextSnapshot", Value::is_object)
			&& absent_or(fields, "elidedOutputTokens", is_count)
			&& absent_or(fields, "prunedAt", is_count)
			&& absent_or(fields, "content", is_content)
	})
}

fn is_entry_patch(value: &Value) -> bool {
	value.as_object().is_some_and(|patch| {
		patch.get("entryId").is_some_and(Value::is_string)
			&& absent_or(patch, "entry", is_entry_fields)
			&& absent_or(patch, "message", is_message_fields)
	})
}

/// Whether `value` is the `data` of a well-formed `entry_patch` record.
pub fn is_entry_patch_data(value: &Value) -> bool {
	value
		.get("patches")
		.and_then(Value::as_array)
		.is_some_and(|patches| patches.iter().all(is_entry_patch))
}

/// Whether `entry` is an `entry_patch` record.
pub fn is_entry_patch_record(entry: &Map<String, Value>) -> bool {
	entry.get("type").and_then(Value::as_str) == Some("custom")
		&& entry.get("customType").and_then(Value::as_str) == Some(ENTRY_PATCH_CUSTOM_TYPE)
}

/// The patches of `data`, a record's `data`, or `None` when it is malformed.
fn patches_in(data: &Value) -> Option<impl Iterator<Item = &Map<String, Value>>> {
	if !is_entry_patch_data(data) {
		return None;
	}
	Some(
		data["patches"]
			.as_array()?
			.iter()
			.filter_map(Value::as_object),
	)
}

/// The patches of `record`, or `None` when its `data` is malformed. Each is
/// an object with a string `entryId` and the fields above.
pub fn entry_patches_of(
	record: &Map<String, Value>,
) -> Option<impl Iterator<Item = &Map<String, Value>>> {
	patches_in(record.get("data")?)
}

/// The id of the entry `patch` names.
pub fn patch_entry_id(patch: &Map<String, Value>) -> &str {
	patch
		.get("entryId")
		.and_then(Value::as_str)
		.unwrap_or_default()
}

/// Id of `record`, for a skip report.
fn record_id_of(record: &Map<String, Value>) -> Option<String> {
	record.get("id").and_then(Value::as_str).map(str::to_owned)
}

/// Whether every field `patch` names exists on `entry`'s kind, with a
/// `content` of the shape its role holds.
pub fn entry_accepts_patch(entry: &Map<String, Value>, patch: &Map<String, Value>) -> bool {
	let kind = entry.get("type").and_then(Value::as_str);
	if let Some(fields) = patch.get("entry").and_then(Value::as_object) {
		let compaction_fields = COMPACTION_FIELDS
			.iter()
			.any(|(key, _)| fields.contains_key(*key));
		if compaction_fields && kind != Some("compaction") {
			return false;
		}
		if fields.contains_key("content") && kind != Some("custom_message") {
			return false;
		}
	}
	let Some(fields) = patch.get("message").and_then(Value::as_object) else {
		return true;
	};
	let Some(message) = entry
		.get("message")
		.and_then(Value::as_object)
		.filter(|_| kind == Some("message"))
	else {
		return false;
	};
	let role = message.get("role").and_then(Value::as_str);
	let assistant_fields = ASSISTANT_FIELDS
		.iter()
		.any(|(key, _)| fields.contains_key(*key));
	if assistant_fields && role != Some("assistant") {
		return false;
	}
	if fields.contains_key("prunedAt") && role != Some("toolResult") {
		return false;
	}
	let Some(content) = fields.get("content") else {
		return true;
	};
	role
		.and_then(content_takes_string)
		.is_some_and(|takes_string| takes_string || !content.is_string())
}

/// [`set_patched_fields`], setting only the fields `take` claims; `take` is
/// asked once for each field the patch sets on `entry`. Returns whether any
/// field was claimed.
fn write_fields(
	entry: &mut Map<String, Value>,
	patch: &Map<String, Value>,
	take: &mut dyn FnMut(PatchField) -> bool,
) -> bool {
	let kind = entry.get("type").and_then(Value::as_str);
	let (is_compaction, is_custom_message, is_message) =
		(kind == Some("compaction"), kind == Some("custom_message"), kind == Some("message"));
	let mut claimed = false;
	if let Some(fields) = patch.get("entry").and_then(Value::as_object) {
		if is_compaction {
			for (key, field) in COMPACTION_FIELDS {
				if let Some(value) = fields.get(key)
					&& take(field)
				{
					entry.insert(key.to_owned(), value.clone());
					claimed = true;
				}
			}
		}
		if is_custom_message
			&& let Some(content) = fields.get("content")
			&& take(PatchField::EntryContent)
		{
			entry.insert("content".to_owned(), content.clone());
			claimed = true;
		}
	}
	let Some(fields) = patch.get("message").and_then(Value::as_object) else {
		return claimed;
	};
	if !is_message {
		return claimed;
	}
	let Some(message) = entry.get_mut("message").and_then(Value::as_object_mut) else {
		return claimed;
	};
	let role = message.get("role").and_then(Value::as_str);
	let (is_assistant, is_tool_result) = (role == Some("assistant"), role == Some("toolResult"));
	if is_assistant {
		for (key, field) in ASSISTANT_FIELDS {
			if let Some(value) = fields.get(key)
				&& take(field)
			{
				message.insert(key.to_owned(), value.clone());
				claimed = true;
			}
		}
	}
	if is_tool_result
		&& let Some(pruned_at) = fields.get("prunedAt")
		&& take(PatchField::MessagePrunedAt)
	{
		message.insert("prunedAt".to_owned(), pruned_at.clone());
		claimed = true;
	}
	if let Some(content) = fields.get("content")
		&& message.contains_key("content")
		&& take(PatchField::MessageContent)
	{
		message.insert("content".to_owned(), content.clone());
		claimed = true;
	}
	claimed
}

/// Set `patch`'s fields on `entry`, which [`entry_accepts_patch`] accepted.
/// Each value is a copy of the record's, so `entry` shares nothing with it.
pub fn set_patched_fields(entry: &mut Map<String, Value>, patch: &Map<String, Value>) {
	write_fields(entry, patch, &mut |_| true);
}

/// Id under which `entry` is a patch target: every entry but the session
/// header has one.
fn target_id_of(entry: &Map<String, Value>) -> Option<&str> {
	if entry.get("type").and_then(Value::as_str) == Some("session") {
		return None;
	}
	entry.get("id").and_then(Value::as_str)
}

/// Takes the `data` of the record `entries[index]` out while its patches
/// apply, so no entry is borrowed twice, and puts it back after `apply`.
fn with_record_data<R>(
	entries: &mut [Map<String, Value>],
	index: usize,
	apply: impl FnOnce(&mut [Map<String, Value>], Option<&Value>) -> R,
) -> R {
	let data = entries[index].get_mut("data").map(Value::take);
	let result = apply(entries, data.as_ref());
	if let Some(data) = data
		&& let Some(slot) = entries[index].get_mut("data")
	{
		*slot = data;
	}
	result
}

/// Set, in place, every field an `entry_patch` record in `entries` names on
/// the entry with that id among `entries`, so entries read from a transcript
/// read as the live session's entries did. Records apply in file order, so
/// the newest value of a field wins, and applying them again changes nothing.
/// A record may precede its target. A malformed record, or a patch whose
/// target is missing, lacks a field it names, or holds `content` of another
/// shape, is skipped and reported to `on_skip`. Returns whether any field was
/// set.
pub fn apply_entry_patches(
	entries: &mut [Map<String, Value>],
	mut on_skip: impl FnMut(EntryPatchSkip),
) -> bool {
	let mut by_id: Option<HashMap<String, usize>> = None;
	let mut changed = false;
	for index in 0..entries.len() {
		if !is_entry_patch_record(&entries[index]) {
			continue;
		}
		let record_id = record_id_of(&entries[index]);
		with_record_data(entries, index, |entries, data| {
			let Some(patches) = data.and_then(patches_in) else {
				on_skip(EntryPatchSkip {
					reason:    EntryPatchSkipReason::Malformed,
					record_id: record_id.clone(),
					entry_id:  None,
				});
				return;
			};
			let by_id = by_id.get_or_insert_with(|| {
				let mut by_id = HashMap::new();
				for (index, entry) in entries.iter().enumerate() {
					if let Some(id) = target_id_of(entry) {
						by_id.insert(id.to_owned(), index);
					}
				}
				by_id
			});
			for patch in patches {
				let entry_id = patch_entry_id(patch);
				let skip = |reason| EntryPatchSkip {
					reason,
					record_id: record_id.clone(),
					entry_id: Some(entry_id.to_owned()),
				};
				let Some(&target) = by_id.get(entry_id) else {
					on_skip(skip(EntryPatchSkipReason::MissingTarget));
					continue;
				};
				if !entry_accepts_patch(&entries[target], patch) {
					on_skip(skip(EntryPatchSkipReason::Misfit));
					continue;
				}
				set_patched_fields(&mut entries[target], patch);
				changed = true;
			}
		});
	}
	changed
}

/// Each `entry_patch` record a reader read, by id, with its parent past
/// records: `None` for a record at the root.
pub(crate) type RecordParents = HashMap<String, Option<String>>;

/// Sets `object[key]`, an entry id, past records: to the parent of the record
/// it names, if it names one.
pub(crate) fn relink(object: &mut Map<String, Value>, key: &str, record_parents: &RecordParents) {
	if let Some(id) = object.get(key).and_then(Value::as_str)
		&& let Some(parent) = record_parents.get(id)
	{
		let parent = parent.clone().map_or(Value::Null, Value::String);
		object.insert(key.to_owned(), parent);
	}
}

/// `entries`, in file order, without their `entry_patch` records; an entry
/// whose parent is a record takes the record's parent. Adds each record to
/// `record_parents`, which holds the records of earlier reads of the same
/// transcript.
pub(crate) fn entries_past_records(
	entries: Vec<Map<String, Value>>,
	record_parents: &mut RecordParents,
) -> Vec<Map<String, Value>> {
	let mut kept = Vec::with_capacity(entries.len());
	for mut entry in entries {
		if entry.get("type").and_then(Value::as_str) != Some("session") {
			relink(&mut entry, "parentId", record_parents);
			if is_entry_patch_record(&entry) {
				if let Some(id) = record_id_of(&entry) {
					let parent = entry
						.get("parentId")
						.and_then(Value::as_str)
						.map(str::to_owned);
					record_parents.insert(id, parent);
				}
				drop_deep(Value::Object(entry));
				continue;
			}
		}
		kept.push(entry);
	}
	kept
}

/// Sibling tree nodes still to read, each with the parent its entry takes
/// when it was the child of a record, and the nodes kept of the siblings read.
struct Level {
	pending: VecDeque<(Value, Option<Option<String>>)>,
	kept:    Vec<Value>,
	/// The node these are the children of; `None` for the roots.
	node:    Option<Map<String, Value>>,
}

impl Level {
	fn new(nodes: Value, node: Option<Map<String, Value>>) -> Self {
		let pending = match nodes {
			Value::Array(nodes) => nodes.into_iter().map(|node| (node, None)).collect(),
			other => {
				drop_deep(other);
				VecDeque::new()
			},
		};
		Self { pending, kept: Vec::new(), node }
	}
}

/// `roots`, the nodes of a `get_tree` answer (`{ entry, children, label? }`),
/// without their `entry_patch` record nodes: the children of a record node
/// take its place among its parent's children, and its parent as their
/// entries' parent. Adds each record to `record_parents`. Walks with a stack
/// of its own and moves every value, as a session tree nests one level for
/// each entry of a chain.
pub(crate) fn tree_past_records(roots: Value, record_parents: &mut RecordParents) -> Vec<Value> {
	let mut stack = vec![Level::new(roots, None)];
	loop {
		let Some(level) = stack.last_mut() else {
			return Vec::new();
		};
		match level.pending.pop_front() {
			Some((Value::Object(mut node), relinked)) => {
				let mut record_parent = None;
				if let Some(entry) = node.get_mut("entry").and_then(Value::as_object_mut) {
					if let Some(parent) = relinked {
						entry.insert("parentId".to_owned(), parent.map_or(Value::Null, Value::String));
					}
					if is_entry_patch_record(entry) {
						let parent = entry
							.get("parentId")
							.and_then(Value::as_str)
							.map(str::to_owned);
						if let Some(id) = record_id_of(entry) {
							record_parents.insert(id, parent.clone());
						}
						record_parent = Some(parent);
					}
				}
				let children = node.get_mut("children").map_or(Value::Null, Value::take);
				match record_parent {
					Some(parent) => {
						// The record's children take its place, before its later
						// siblings.
						match children {
							Value::Array(children) => {
								for child in children.into_iter().rev() {
									level.pending.push_front((child, Some(parent.clone())));
								}
							},
							other => drop_deep(other),
						}
						drop_deep(Value::Object(node));
					},
					None => stack.push(Level::new(children, Some(node))),
				}
			},
			Some((other, _)) => level.kept.push(other),
			None => {
				let Some(Level { kept, node, .. }) = stack.pop() else {
					return Vec::new();
				};
				let Some(mut node) = node else {
					return kept;
				};
				node.insert("children".to_owned(), Value::Array(kept));
				if let Some(parent) = stack.last_mut() {
					parent.kept.push(Value::Object(node));
				}
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	fn object(value: Value) -> Map<String, Value> {
		match value {
			Value::Object(map) => map,
			other => panic!("not an object: {other}"),
		}
	}

	fn message(id: &str, parent: Option<&str>, message: Value) -> Map<String, Value> {
		object(
			json!({"type": "message", "id": id, "parentId": parent, "timestamp": "t", "message": message}),
		)
	}

	fn tool_result(id: &str, text: &str) -> Map<String, Value> {
		message(
			id,
			None,
			json!({"role": "toolResult", "toolCallId": "c1", "toolName": "bash", "content": [{"type": "text", "text": text}], "isError": false, "timestamp": 3}),
		)
	}

	fn assistant(id: &str) -> Map<String, Value> {
		message(
			id,
			None,
			json!({"role": "assistant", "content": [{"type": "text", "text": "hi"}], "stopReason": "stop", "timestamp": 2}),
		)
	}

	fn user(id: &str) -> Map<String, Value> {
		message(id, None, json!({"role": "user", "content": "go", "timestamp": 1}))
	}

	fn compaction(id: &str) -> Map<String, Value> {
		object(
			json!({"type": "compaction", "id": id, "parentId": null, "timestamp": "t", "summary": "s", "firstKeptEntryId": "u1", "tokensBefore": 100, "tokensAfter": 80}),
		)
	}

	fn record(id: &str, patches: Value) -> Map<String, Value> {
		object(
			json!({"type": "custom", "customType": ENTRY_PATCH_CUSTOM_TYPE, "id": id, "parentId": null, "timestamp": "t", "data": {"patches": patches}}),
		)
	}

	fn text(value: &str) -> Value {
		json!([{"type": "text", "text": value}])
	}

	fn content(entry: &Map<String, Value>) -> &Value {
		&entry["message"]["content"]
	}

	#[test]
	fn applies_a_record_to_its_target() {
		let mut entries = vec![
			tool_result("t1", "heavy"),
			record(
				"p1",
				json!([{"entryId": "t1", "message": {"content": text("elided"), "prunedAt": 5}}]),
			),
		];
		assert!(apply_entry_patches(&mut entries, |_| {}));
		assert_eq!(content(&entries[0]), &text("elided"));
		assert_eq!(entries[0]["message"]["prunedAt"], 5);
	}

	#[test]
	fn the_newest_value_wins_and_applying_again_changes_nothing() {
		let mut entries = vec![
			compaction("c1"),
			record("p1", json!([{"entryId": "c1", "entry": {"tokensAfter": 40, "warning": "first"}}])),
			record("p2", json!([{"entryId": "c1", "entry": {"tokensAfter": 20}}])),
		];
		apply_entry_patches(&mut entries, |_| {});
		let once = entries.clone();
		apply_entry_patches(&mut entries, |_| {});
		assert_eq!(entries, once);
		assert_eq!(entries[0]["tokensAfter"], 20);
		assert_eq!(entries[0]["warning"], "first");
	}

	#[test]
	fn a_record_may_precede_its_target() {
		let mut entries = vec![
			record("p1", json!([{"entryId": "a1", "message": {"elidedOutputTokens": 9}}])),
			assistant("a1"),
		];
		assert!(apply_entry_patches(&mut entries, |_| {}));
		assert_eq!(entries[1]["message"]["elidedOutputTokens"], 9);
	}

	#[test]
	fn skips_a_malformed_record_a_missing_target_and_a_misfit() {
		let mut entries = vec![
			user("u1"),
			object(
				json!({"type": "custom", "customType": ENTRY_PATCH_CUSTOM_TYPE, "id": "bad", "data": {"patches": "not a list"}}),
			),
			record("p1", json!([{"entryId": "gone", "message": {"prunedAt": 1}}])),
			// `continued` is an assistant field; a user message lacks it.
			record("p2", json!([{"entryId": "u1", "message": {"continued": true}}])),
			// An assistant's content is a list of blocks, never a string.
			record("p3", json!([{"entryId": "a1", "message": {"content": "flat"}}])),
			assistant("a1"),
		];
		let mut seen = Vec::new();
		assert!(!apply_entry_patches(&mut entries, |skip| seen.push(skip)));
		let reasons: Vec<_> = seen
			.iter()
			.map(|skip| (skip.reason, skip.record_id.as_deref(), skip.entry_id.as_deref()))
			.collect();
		assert_eq!(reasons, [
			(EntryPatchSkipReason::Malformed, Some("bad"), None),
			(EntryPatchSkipReason::MissingTarget, Some("p1"), Some("gone")),
			(EntryPatchSkipReason::Misfit, Some("p2"), Some("u1")),
			(EntryPatchSkipReason::Misfit, Some("p3"), Some("a1")),
		]);
		assert!(
			!entries[0]["message"]
				.as_object()
				.unwrap()
				.contains_key("continued")
		);
		assert_eq!(entries[5]["message"]["content"], json!([{"type": "text", "text": "hi"}]));
	}

	#[test]
	fn validates_each_field_of_a_patch() {
		for data in [
			json!({"patches": [{"entryId": 1}]}),
			json!({"patches": [{"entryId": "x", "entry": {"warning": 3}}]}),
			json!({"patches": [{"entryId": "x", "entry": {"tokensAfter": "1"}}]}),
			json!({"patches": [{"entryId": "x", "entry": {"preserveData": []}}]}),
			json!({"patches": [{"entryId": "x", "message": {"continued": false}}]}),
			json!({"patches": [{"entryId": "x", "message": {"content": [{"text": "no type"}]}}]}),
			json!({"patches": [{"entryId": "x", "message": {"prunedAt": null}}]}),
			json!({"patches": {}}),
		] {
			assert!(!is_entry_patch_data(&data), "{data}");
		}
		assert!(is_entry_patch_data(&json!({"patches": [
			{"entryId": "x", "entry": {"warning": "w", "tokensAfter": 1, "preserveData": {}, "content": "c"}},
			{"entryId": "y", "message": {"retryRecovery": {}, "continued": true, "contextSnapshot": {}, "elidedOutputTokens": 1, "prunedAt": 2, "content": []}},
		]})));
	}

	/// The skips of a record that sets a tool result's `content`, and the
	/// content it leaves.
	fn set_result_content(content: Value) -> (Vec<EntryPatchSkip>, Value) {
		let mut entries = vec![
			tool_result("t1", "heavy"),
			record("p1", json!([{"entryId": "t1", "message": {"content": content}}])),
		];
		let mut seen = Vec::new();
		apply_entry_patches(&mut entries, |skip| seen.push(skip));
		(seen, entries[0]["message"]["content"].clone())
	}

	fn malformed_p1() -> Vec<EntryPatchSkip> {
		vec![EntryPatchSkip {
			reason:    EntryPatchSkipReason::Malformed,
			record_id: Some("p1".to_owned()),
			entry_id:  None,
		}]
	}

	// A provider request built from a text block without its text fails, so a
	// record that writes one is skipped whole, as the TypeScript readers skip
	// it.
	#[test]
	fn a_text_block_without_a_string_text_makes_a_record_malformed() {
		for block in [json!({"type": "text"}), json!({"type": "text", "text": 5})] {
			assert_eq!(set_result_content(json!([block])), (malformed_p1(), text("heavy")), "{block}");
		}
		assert_eq!(set_result_content(text("elided")), (Vec::new(), text("elided")));
	}

	#[test]
	fn an_image_block_without_string_data_makes_a_record_malformed() {
		for block in [
			json!({"type": "image", "mimeType": "image/png"}),
			json!({"type": "image", "data": null, "mimeType": "image/png"}),
		] {
			assert_eq!(set_result_content(json!([block])), (malformed_p1(), text("heavy")), "{block}");
		}
		// A block of another type needs only its string `type`.
		let blocks = json!([
			{"type": "image", "data": "aGVsbG8=", "mimeType": "image/png"},
			{"type": "toolCall", "id": "c1"},
		]);
		assert_eq!(set_result_content(blocks.clone()), (Vec::new(), blocks));
	}

	// `JSON.parse` reads `1e400`, and an integer past the `f64` range, as
	// Infinity, so no reader takes it as a counter.
	#[test]
	fn a_counter_that_is_not_a_finite_number_makes_a_record_malformed() {
		let huge = format!("1{}", "0".repeat(400));
		for value in ["1e400", "-1e400", huge.as_str()] {
			for fields in [
				format!(r#""entry": {{"tokensAfter": {value}}}"#),
				format!(r#""message": {{"elidedOutputTokens": {value}}}"#),
				format!(r#""message": {{"prunedAt": {value}}}"#),
			] {
				let data = format!(r#"{{"patches": [{{"entryId": "x", {fields}}}]}}"#);
				match serde_json::from_str::<Value>(&data) {
					// serde_json refuses the number by default: no record holds it.
					Err(error) => {
						assert!(error.to_string().starts_with("number out of range"), "{error}");
					},
					// Its `arbitrary_precision` feature keeps the number.
					Ok(data) => assert!(!is_entry_patch_data(&data), "{data}"),
				}
			}
		}
		for value in [
			json!(0),
			json!(-0.0),
			json!(1e308),
			serde_json::from_str::<Value>("1e-400").unwrap(),
			json!(2.5),
		] {
			let data = json!({"patches": [{"entryId": "x", "entry": {"tokensAfter": value}}]});
			assert!(is_entry_patch_data(&data), "{data}");
		}
	}

	#[test]
	fn accepts_each_field_on_its_kind_and_role_only() {
		let patch = |value: Value| object(value);
		let custom_message = object(json!({"type": "custom_message", "id": "m1", "content": "long"}));
		assert!(entry_accepts_patch(
			&compaction("c1"),
			&patch(json!({"entryId": "c1", "entry": {"warning": "w"}}))
		));
		assert!(!entry_accepts_patch(
			&custom_message,
			&patch(json!({"entryId": "m1", "entry": {"warning": "w"}}))
		));
		assert!(entry_accepts_patch(
			&custom_message,
			&patch(json!({"entryId": "m1", "entry": {"content": "short"}}))
		));
		assert!(!entry_accepts_patch(
			&compaction("c1"),
			&patch(json!({"entryId": "c1", "entry": {"content": "x"}}))
		));
		assert!(entry_accepts_patch(
			&user("u1"),
			&patch(json!({"entryId": "u1", "message": {"content": "short"}}))
		));
		assert!(!entry_accepts_patch(
			&tool_result("t1", "x"),
			&patch(json!({"entryId": "t1", "message": {"content": "short"}}))
		));
		assert!(entry_accepts_patch(
			&tool_result("t1", "x"),
			&patch(json!({"entryId": "t1", "message": {"prunedAt": 1}}))
		));
		assert!(!entry_accepts_patch(
			&assistant("a1"),
			&patch(json!({"entryId": "a1", "message": {"prunedAt": 1}}))
		));
		assert!(!entry_accepts_patch(
			&compaction("c1"),
			&patch(json!({"entryId": "c1", "message": {"prunedAt": 1}}))
		));
		let custom_role = message("x1", None, json!({"role": "custom", "content": "c"}));
		assert!(!entry_accepts_patch(
			&custom_role,
			&patch(json!({"entryId": "x1", "message": {"content": "d"}}))
		));
	}

	#[test]
	fn sets_a_message_content_only_where_the_message_holds_one() {
		let mut entry = message("b1", None, json!({"role": "user", "timestamp": 1}));
		set_patched_fields(
			&mut entry,
			&object(json!({"entryId": "b1", "message": {"content": "x"}})),
		);
		assert!(
			!entry["message"]
				.as_object()
				.unwrap()
				.contains_key("content")
		);
	}

	#[test]
	fn lists_entries_past_records() {
		let mut parents = RecordParents::new();
		let entries = vec![
			object(json!({"type": "session", "id": "s"})),
			user("u1"),
			object(
				json!({"type": "custom", "customType": ENTRY_PATCH_CUSTOM_TYPE, "id": "p1", "parentId": "u1", "data": {"patches": []}}),
			),
			object(
				json!({"type": "custom", "customType": ENTRY_PATCH_CUSTOM_TYPE, "id": "p2", "parentId": "p1", "data": {"patches": []}}),
			),
			object(
				json!({"type": "message", "id": "u2", "parentId": "p2", "message": {"role": "user", "content": "x"}}),
			),
		];
		let kept = entries_past_records(entries, &mut parents);
		let ids: Vec<_> = kept
			.iter()
			.map(|entry| (entry["id"].clone(), entry.get("parentId").cloned()))
			.collect();
		assert_eq!(ids, [
			(json!("s"), None),
			(json!("u1"), Some(Value::Null)),
			(json!("u2"), Some(json!("u1"))),
		]);
		let mut leaf = object(json!({"leafId": "p2", "other": "u2"}));
		relink(&mut leaf, "leafId", &parents);
		relink(&mut leaf, "other", &parents);
		assert_eq!(Value::Object(leaf), json!({"leafId": "u1", "other": "u2"}));
		// A later read relinks past a record an earlier read held.
		let later = vec![object(
			json!({"type": "message", "id": "u3", "parentId": "p1", "message": {"role": "user", "content": "y"}}),
		)];
		assert_eq!(entries_past_records(later, &mut parents)[0]["parentId"], "u1");
	}

	#[test]
	fn splices_record_nodes_out_of_a_tree() {
		let node = |entry: Value, children: Vec<Value>| json!({"entry": entry, "children": children});
		let custom = |id: &str, parent: Option<&str>| json!({"type": "custom", "customType": ENTRY_PATCH_CUSTOM_TYPE, "id": id, "parentId": parent, "data": {"patches": []}});
		let entry = |id: &str, parent: &str| json!({"type": "message", "id": id, "parentId": parent});
		let tree = json!([node(custom("r0", None), vec![node(entry("u1", "r0"), vec![
			node(custom("p1", Some("u1")), vec![node(custom("p2", Some("p1")), vec![node(
				entry("u2", "p2"),
				vec![]
			)])]),
			node(entry("x1", "u1"), vec![]),
		])])]);
		let mut parents = RecordParents::new();
		let roots = tree_past_records(tree, &mut parents);
		assert_eq!(
			Value::Array(roots),
			json!([
				{"entry": {"type": "message", "id": "u1", "parentId": null}, "children": [
					{"entry": {"type": "message", "id": "u2", "parentId": "u1"}, "children": []},
					{"entry": {"type": "message", "id": "x1", "parentId": "u1"}, "children": []},
				]},
			])
		);
		let mut leaves = object(json!({"onRecord": "p2", "onRoot": "r0"}));
		relink(&mut leaves, "onRecord", &parents);
		relink(&mut leaves, "onRoot", &parents);
		assert_eq!(Value::Object(leaves), json!({"onRecord": "u1", "onRoot": null}));
	}

	#[test]
	fn splices_a_chain_deeper_than_the_stack_recurses() {
		let depth = 100_000;
		let mut text = String::from("[");
		for index in 0..depth {
			let parent = if index == 0 {
				"null".to_owned()
			} else {
				format!("\"e{}\"", index - 1)
			};
			let kind = if index % 2 == 1 {
				format!(r#""type":"custom","customType":"{}""#, ENTRY_PATCH_CUSTOM_TYPE)
			} else {
				r#""type":"message""#.to_owned()
			};
			text.push_str(&format!(
				r#"{{"entry":{{{kind},"id":"e{index}","parentId":{parent}}},"children":["#
			));
		}
		text.push_str(&"]}".repeat(depth));
		text.push(']');
		let answer =
			format!(r#"{{"type":"response","command":"get_tree","data":{{"tree":{text}}}}}"#);
		let mut answer = crate::deep::parse(answer.as_bytes()).unwrap();
		let tree = answer["data"]["tree"].take();
		let mut parents = RecordParents::new();
		let roots = tree_past_records(tree, &mut parents);
		let mut depth_seen = 0;
		let mut next = roots.first().and_then(Value::as_object);
		let mut parent = Value::Null;
		while let Some(node) = next {
			assert_eq!(node["entry"]["id"], format!("e{}", depth_seen * 2));
			assert_eq!(node["entry"]["parentId"], parent);
			parent = node["entry"]["id"].clone();
			depth_seen += 1;
			next = node["children"]
				.as_array()
				.and_then(|children| children.first())
				.and_then(Value::as_object);
		}
		assert_eq!(depth_seen, depth / 2);
		for root in roots {
			drop_deep(root);
		}
	}
}
