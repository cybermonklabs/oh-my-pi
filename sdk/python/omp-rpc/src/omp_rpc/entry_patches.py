"""`entry_patch` records of a session transcript, as every reader of the file applies them.

A port of `packages/utils/src/entry-patches.ts`, the rules the omp readers
share; a change to the rules changes both.

A pass that changes an entry after its line is written (a retry saga's marker,
a compaction's dead-end `warning` or corrected `tokensAfter`, a snapcompact
archive, an elide pass's placeholders) appends one `custom` entry with
`customType` `ENTRY_PATCH_CUSTOM_TYPE` that names entries already in the file
and the fields to set on them, instead of rewriting the file. The original
lines stay, so a reader that shows or derives anything from those fields
applies the records first:

- over the entries of a whole transcript, or of one window of it,
  `apply_entry_patches`;
- over entries a reader read and kept earlier (an earlier window of a
  transcript, rows it stored), `entry_patches_of` on each later record, then
  `entry_accepts_patch` and `set_patched_fields` on the kept entry the patch
  names, in file order.

Records apply in file order, so the newest value of a field wins, and applying
them again changes nothing. Entries are parsed JSON objects, changed in place.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Literal

from ._wire_runtime import JsonObject, JsonValue, decode_json

ENTRY_PATCH_CUSTOM_TYPE = "entry_patch"
"""`customType` of an `entry_patch` record."""

EntryPatchSkipReason = Literal["malformed", "missing-target", "misfit"]
"""Why a reader left a record, or one patch of it, unapplied: its `data` is not
a list of patches (`malformed`; a text block without a string `text`, an image
block without string `data`, and a counter that is not a finite number make it
so), no entry has the id the patch names (`missing-target`), or the patch names
a field its target's kind or role lacks, or `content` of another shape
(`misfit`)."""


@dataclass(slots=True, frozen=True)
class EntryPatchSkip:
    """A record, or one patch of it, a reader left unapplied."""

    reason: EntryPatchSkipReason
    record_id: str | None
    """Id of the record."""
    entry_id: str | None = None
    """Id of the entry the patch names; `None` for a malformed record."""


SkipHook = Callable[[EntryPatchSkip], None]

_COMPACTION_FIELDS = ("warning", "tokensAfter", "preserveData")
_ASSISTANT_FIELDS = (
    "retryRecovery",
    "continued",
    "contextSnapshot",
    "elidedOutputTokens",
)
# Message roles whose `content` an elide pass shortens, each with whether that
# `content` may be a string; assistant and tool-result `content` is always a
# list of blocks.
_CONTENT_TAKES_STRING = {
    "user": True,
    "developer": True,
    "assistant": False,
    "toolResult": False,
}


def _is_count(value: object) -> bool:
    """Whether `value` is a finite number, as every counter a patch sets is."""
    # A JSON `true` decodes to a Python bool, which is an int.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        # An integer past the float range, which `JSON.parse` reads as Infinity.
        return False


def _is_content_block(block: object) -> bool:
    """Whether `block` is a content block a message can hold: a string `type`,
    and the payload a text or image block carries (`text`, `data`) as a string,
    so a provider request built from it never meets a block without its
    payload."""
    if not isinstance(block, dict):
        return False
    kind = block.get("type")
    if kind == "text":
        return isinstance(block.get("text"), str)
    if kind == "image":
        return isinstance(block.get("data"), str)
    return isinstance(kind, str)


def _is_content(value: object) -> bool:
    return isinstance(value, str) or (
        isinstance(value, list) and all(_is_content_block(block) for block in value)
    )


def _absent_or(fields: JsonObject, key: str, check: Callable[[object], bool]) -> bool:
    return key not in fields or check(fields[key])


def _is_entry_fields(value: object) -> bool:
    return (
        isinstance(value, dict)
        and _absent_or(value, "warning", lambda warning: isinstance(warning, str))
        and _absent_or(value, "tokensAfter", _is_count)
        and _absent_or(value, "preserveData", lambda data: isinstance(data, dict))
        and _absent_or(value, "content", _is_content)
    )


def _is_message_fields(value: object) -> bool:
    return (
        isinstance(value, dict)
        and _absent_or(
            value, "retryRecovery", lambda recovery: isinstance(recovery, dict)
        )
        and _absent_or(value, "continued", lambda continued: continued is True)
        and _absent_or(
            value, "contextSnapshot", lambda snapshot: isinstance(snapshot, dict)
        )
        and _absent_or(value, "elidedOutputTokens", _is_count)
        and _absent_or(value, "prunedAt", _is_count)
        and _absent_or(value, "content", _is_content)
    )


def _is_entry_patch(value: object) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("entryId"), str)
        and _absent_or(value, "entry", _is_entry_fields)
        and _absent_or(value, "message", _is_message_fields)
    )


def is_entry_patch_data(value: object) -> bool:
    """Whether `value` is the `data` of a well-formed `entry_patch` record."""
    if not isinstance(value, dict):
        return False
    patches = value.get("patches")
    return isinstance(patches, list) and all(
        _is_entry_patch(patch) for patch in patches
    )


def is_entry_patch_record(entry: object) -> bool:
    """Whether `entry` is an `entry_patch` record."""
    return (
        isinstance(entry, dict)
        and entry.get("type") == "custom"
        and entry.get("customType") == ENTRY_PATCH_CUSTOM_TYPE
    )


def entry_patches_of(record: JsonObject) -> list[JsonObject] | None:
    """The patches of `record`, or `None` when its `data` is malformed."""
    data = record.get("data")
    if not is_entry_patch_data(data):
        return None
    assert isinstance(data, dict)
    patches = data["patches"]
    assert isinstance(patches, list)
    return [patch for patch in patches if isinstance(patch, dict)]


def _record_id_of(record: JsonObject) -> str | None:
    record_id = record.get("id")
    return record_id if isinstance(record_id, str) else None


def _entry_id_of(patch: JsonObject) -> str:
    entry_id = patch.get("entryId")
    return entry_id if isinstance(entry_id, str) else ""


def entry_accepts_patch(entry: object, patch: JsonObject) -> bool:
    """Whether every field `patch` names exists on `entry`'s kind, with a `content` of the shape its role holds."""
    if not isinstance(entry, dict):
        return False
    fields = patch.get("entry")
    if isinstance(fields, dict):
        compaction_fields = any(key in fields for key in _COMPACTION_FIELDS)
        if compaction_fields and entry.get("type") != "compaction":
            return False
        if "content" in fields and entry.get("type") != "custom_message":
            return False
    patched = patch.get("message")
    if not isinstance(patched, dict):
        return True
    message = entry.get("message")
    if entry.get("type") != "message" or not isinstance(message, dict):
        return False
    role = message.get("role")
    assistant_fields = any(key in patched for key in _ASSISTANT_FIELDS)
    if assistant_fields and role != "assistant":
        return False
    if "prunedAt" in patched and role != "toolResult":
        return False
    if "content" not in patched:
        return True
    takes_string = _CONTENT_TAKES_STRING.get(role) if isinstance(role, str) else None
    return takes_string is not None and (
        takes_string or not isinstance(patched["content"], str)
    )


def _own_copy(holder: JsonObject, key: str, value: JsonValue) -> JsonValue:
    """`value` for `holder[key]`: `value` itself when `holder` already holds it there, else a copy."""
    return value if holder.get(key) is value else decode_json(value, key)


def _write_fields(
    entry: object, patch: JsonObject, take: Callable[[str], bool]
) -> bool:
    """`set_patched_fields`, setting only the fields `take` claims; `take` is
    asked once for each field the patch sets on `entry`. Returns whether any
    field was claimed."""
    if not isinstance(entry, dict):
        return False
    claimed = False
    fields = patch.get("entry")
    if isinstance(fields, dict):
        if entry.get("type") == "compaction":
            for key in _COMPACTION_FIELDS:
                if key in fields and take(f"entry.{key}"):
                    entry[key] = _own_copy(entry, key, fields[key])
                    claimed = True
        if (
            "content" in fields
            and entry.get("type") == "custom_message"
            and take("entry.content")
        ):
            entry["content"] = _own_copy(entry, "content", fields["content"])
            claimed = True
    patched = patch.get("message")
    if not isinstance(patched, dict) or entry.get("type") != "message":
        return claimed
    message = entry.get("message")
    if not isinstance(message, dict):
        return claimed
    if message.get("role") == "assistant":
        for key in _ASSISTANT_FIELDS:
            if key in patched and take(f"message.{key}"):
                message[key] = _own_copy(message, key, patched[key])
                claimed = True
    if (
        "prunedAt" in patched
        and message.get("role") == "toolResult"
        and take("message.prunedAt")
    ):
        message["prunedAt"] = patched["prunedAt"]
        claimed = True
    if "content" in patched and "content" in message and take("message.content"):
        message["content"] = _own_copy(message, "content", patched["content"])
        claimed = True
    return claimed


def set_patched_fields(entry: JsonObject, patch: JsonObject) -> None:
    """Set `patch`'s fields on `entry`, which `entry_accepts_patch` accepted.

    Each object value is copied unless `entry` already holds that very value,
    so `entry` never shares an object with a record.
    """
    _write_fields(entry, patch, lambda _field: True)


def _target_id_of(entry: object) -> str | None:
    """Id under which `entry` is a patch target: every entry but the session header has one."""
    if not isinstance(entry, dict) or entry.get("type") == "session":
        return None
    entry_id = entry.get("id")
    return entry_id if isinstance(entry_id, str) else None


def apply_entry_patches(
    entries: Sequence[JsonObject], *, on_skip: SkipHook | None = None
) -> bool:
    """Set, in place, every field an `entry_patch` record in `entries` names.

    A patch finds the entry with its id among `entries`. Records apply in file
    order, so the newest value of a field wins, and applying them again changes
    nothing. A record may precede its target. A malformed record, or a patch
    whose target is missing, lacks a field it names, or holds `content` of
    another shape, is skipped and reported to `on_skip`. Returns whether any
    field was set.
    """
    by_id: dict[str, JsonObject] | None = None
    changed = False
    for entry in entries:
        if not is_entry_patch_record(entry):
            continue
        record_id = _record_id_of(entry)
        patches = entry_patches_of(entry)
        if patches is None:
            if on_skip is not None:
                on_skip(EntryPatchSkip("malformed", record_id))
            continue
        if by_id is None:
            by_id = {}
            for held in entries:
                held_id = _target_id_of(held)
                if held_id is not None:
                    by_id[held_id] = held
        for patch in patches:
            entry_id = _entry_id_of(patch)
            target = by_id.get(entry_id)
            if target is None:
                if on_skip is not None:
                    on_skip(EntryPatchSkip("missing-target", record_id, entry_id))
                continue
            if not entry_accepts_patch(target, patch):
                if on_skip is not None:
                    on_skip(EntryPatchSkip("misfit", record_id, entry_id))
                continue
            set_patched_fields(target, patch)
            changed = True
    return changed


RecordParents = dict[str, str | None]
"""Each `entry_patch` record a reader read, by id, with its parent past records."""


def past_records(entry_id: str | None, record_parents: RecordParents) -> str | None:
    """The entry that takes the place of `entry_id` once the records are left out:
    `entry_id` itself, or the parent of the record it names."""
    if entry_id is None or entry_id not in record_parents:
        return entry_id
    return record_parents[entry_id]


def _note_record(entry: JsonObject, record_parents: RecordParents) -> None:
    record_id = _record_id_of(entry)
    if record_id is not None:
        parent = entry.get("parentId")
        record_parents[record_id] = parent if isinstance(parent, str) else None


def entries_past_records(
    entries: Iterable[JsonObject], record_parents: RecordParents
) -> list[JsonObject]:
    """`entries`, in file order, without their `entry_patch` records.

    An entry whose parent is a record takes the record's parent. Adds each
    record to `record_parents`, which holds the records of earlier reads of the
    same transcript.
    """
    kept: list[JsonObject] = []
    for entry in entries:
        if entry.get("type") != "session":
            parent = entry.get("parentId")
            if isinstance(parent, str):
                entry["parentId"] = past_records(parent, record_parents)
            if is_entry_patch_record(entry):
                _note_record(entry, record_parents)
                continue
        kept.append(entry)
    return kept


@dataclass(slots=True)
class _Level:
    """Sibling tree nodes being read, and the list that receives the nodes kept of them."""

    nodes: Sequence[JsonValue]
    into: list[JsonValue]
    relink: bool = False
    """Whether the nodes were the children of a record, whose parent their entries take."""
    parent: str | None = None
    index: int = 0


def tree_past_records(
    roots: Sequence[JsonObject], record_parents: RecordParents
) -> list[JsonValue]:
    """`roots`, the nodes of a `get_tree` answer, without their `entry_patch` record nodes.

    The children of a record node take its place among its parent's children,
    and its parent as their entries' parent. Adds each record to
    `record_parents`. Walks with a stack of its own, as a session tree nests one
    level for each entry of a chain.
    """
    kept_roots: list[JsonValue] = []
    stack = [_Level(roots, kept_roots)]
    while stack:
        level = stack[-1]
        if level.index >= len(level.nodes):
            stack.pop()
            continue
        node = level.nodes[level.index]
        level.index += 1
        if not isinstance(node, dict):
            level.into.append(node)
            continue
        entry = node.get("entry")
        children = node.get("children")
        children = children if isinstance(children, list) else []
        if isinstance(entry, dict):
            if level.relink:
                entry["parentId"] = level.parent
            if is_entry_patch_record(entry):
                _note_record(entry, record_parents)
                parent = entry.get("parentId")
                parent = parent if isinstance(parent, str) else None
                stack.append(_Level(children, level.into, relink=True, parent=parent))
                continue
        level.into.append(node)
        kept: list[JsonValue] = []
        node["children"] = kept
        stack.append(_Level(children, kept))
    return kept_roots
