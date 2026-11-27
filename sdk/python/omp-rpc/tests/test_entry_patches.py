"""`entry_patch` records: the rules of `omp_rpc.entry_patches`, and the client reads that use them."""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from omp_rpc import RpcClient, RpcError
from omp_rpc._wire_runtime import JsonObject, JsonValue
from omp_rpc.entry_patches import (
    ENTRY_PATCH_CUSTOM_TYPE,
    EntryPatchSkip,
    RecordParents,
    apply_entry_patches,
    entries_past_records,
    entry_accepts_patch,
    is_entry_patch_data,
    past_records,
    set_patched_fields,
    tree_past_records,
)

_REPO_ROOT = Path(__file__).resolve().parents[4]
# Real RPC dispatch (`runRpcMode`) over one session file; its mock model is never called here.
_HOST = (
    _REPO_ROOT / "packages" / "coding-agent" / "test" / "fixtures" / "tree-rpc-agent.ts"
)
_BUN = shutil.which("bun")
_TIMESTAMP = "2026-01-01T00:00:00.000Z"
_ELIDED: list[JsonValue] = [{"type": "text", "text": "[elided: see artifact://1]"}]
_HEAVY: list[JsonValue] = [{"type": "text", "text": "heavy tool output " * 16}]


def _message(entry_id: str, parent: str | None, message: JsonObject) -> JsonObject:
    return {
        "type": "message",
        "id": entry_id,
        "parentId": parent,
        "timestamp": _TIMESTAMP,
        "message": message,
    }


def _user(entry_id: str, parent: str | None = None, text: str = "go") -> JsonObject:
    return _message(entry_id, parent, {"role": "user", "content": text, "timestamp": 1})


def _assistant(
    entry_id: str, parent: str | None = None, **extra: JsonValue
) -> JsonObject:
    message: JsonObject = {
        "role": "assistant",
        "content": [
            {
                "type": "toolCall",
                "id": "call_1",
                "name": "bash",
                "arguments": {"command": "ls"},
            }
        ],
        "api": "anthropic-messages",
        "provider": "anthropic",
        "model": "claude-sonnet-4-5",
        "usage": {
            "input": 1,
            "output": 1,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 2,
            "cost": {
                "input": 0,
                "output": 0,
                "cacheRead": 0,
                "cacheWrite": 0,
                "total": 0,
            },
        },
        "stopReason": "toolUse",
        "timestamp": 2,
    }
    message.update(extra)
    return _message(entry_id, parent, message)


def _tool_result(
    entry_id: str, parent: str | None, content: list[JsonValue]
) -> JsonObject:
    return _message(
        entry_id,
        parent,
        {
            "role": "toolResult",
            "toolCallId": "call_1",
            "toolName": "bash",
            "content": content,
            "isError": False,
            "timestamp": 3,
        },
    )


def _compaction(entry_id: str) -> JsonObject:
    return {
        "type": "compaction",
        "id": entry_id,
        "parentId": None,
        "timestamp": _TIMESTAMP,
        "summary": "s",
        "firstKeptEntryId": "u1",
        "tokensBefore": 100,
        "tokensAfter": 80,
    }


def _record(record_id: str, parent: str | None, patches: list[JsonValue]) -> JsonObject:
    return {
        "type": "custom",
        "customType": ENTRY_PATCH_CUSTOM_TYPE,
        "id": record_id,
        "parentId": parent,
        "timestamp": _TIMESTAMP,
        "data": {"patches": patches},
    }


class ApplyRulesTests(unittest.TestCase):
    def test_applies_a_record_to_its_target(self) -> None:
        entries = [
            _tool_result("t1", None, _HEAVY),
            _record(
                "p1",
                "t1",
                [{"entryId": "t1", "message": {"content": _ELIDED, "prunedAt": 5}}],
            ),
        ]
        self.assertTrue(apply_entry_patches(entries))
        message = entries[0]["message"]
        assert isinstance(message, dict)
        self.assertEqual((message["content"], message["prunedAt"]), (_ELIDED, 5))

    def test_the_newest_value_wins_and_applying_again_changes_nothing(self) -> None:
        entries = [
            _compaction("c1"),
            _record(
                "p1",
                None,
                [{"entryId": "c1", "entry": {"tokensAfter": 40, "warning": "first"}}],
            ),
            _record("p2", None, [{"entryId": "c1", "entry": {"tokensAfter": 20}}]),
        ]
        apply_entry_patches(entries)
        once = json.dumps(entries)
        apply_entry_patches(entries)
        self.assertEqual(json.dumps(entries), once)
        self.assertEqual(
            (entries[0]["tokensAfter"], entries[0]["warning"]), (20, "first")
        )

    def test_a_record_may_precede_its_target(self) -> None:
        entries = [
            _record(
                "p1", None, [{"entryId": "a1", "message": {"elidedOutputTokens": 9}}]
            ),
            _assistant("a1"),
        ]
        self.assertTrue(apply_entry_patches(entries))
        self.assertEqual(entries[1]["message"]["elidedOutputTokens"], 9)  # type: ignore[index]

    def test_skips_a_malformed_record_a_missing_target_and_a_misfit(self) -> None:
        entries = [
            _user("u1"),
            {
                "type": "custom",
                "customType": ENTRY_PATCH_CUSTOM_TYPE,
                "id": "bad",
                "data": {"patches": "not a list"},
            },
            _record("p1", None, [{"entryId": "gone", "message": {"prunedAt": 1}}]),
            # `continued` is an assistant field; a user message lacks it.
            _record("p2", None, [{"entryId": "u1", "message": {"continued": True}}]),
            # An assistant's content is a list of blocks, never a string.
            _record("p3", None, [{"entryId": "a1", "message": {"content": "flat"}}]),
            _assistant("a1"),
        ]
        skipped: list[EntryPatchSkip] = []
        self.assertFalse(apply_entry_patches(entries, on_skip=skipped.append))
        self.assertEqual(
            skipped,
            [
                EntryPatchSkip("malformed", "bad"),
                EntryPatchSkip("missing-target", "p1", "gone"),
                EntryPatchSkip("misfit", "p2", "u1"),
                EntryPatchSkip("misfit", "p3", "a1"),
            ],
        )
        self.assertNotIn("continued", entries[0]["message"])  # type: ignore[operator]

    def test_validates_each_field_of_a_patch(self) -> None:
        for data in (
            {"patches": [{"entryId": 1}]},
            {"patches": [{"entryId": "x", "entry": {"warning": 3}}]},
            {"patches": [{"entryId": "x", "entry": {"tokensAfter": "1"}}]},
            # A JSON `true` is not a number.
            {"patches": [{"entryId": "x", "entry": {"tokensAfter": True}}]},
            {"patches": [{"entryId": "x", "entry": {"preserveData": []}}]},
            {"patches": [{"entryId": "x", "message": {"continued": False}}]},
            {
                "patches": [
                    {"entryId": "x", "message": {"content": [{"text": "no type"}]}}
                ]
            },
            {"patches": [{"entryId": "x", "message": {"prunedAt": None}}]},
            {"patches": {}},
        ):
            self.assertFalse(is_entry_patch_data(data), data)
        self.assertTrue(
            is_entry_patch_data(
                {
                    "patches": [
                        {
                            "entryId": "x",
                            "entry": {
                                "warning": "w",
                                "tokensAfter": 1,
                                "preserveData": {},
                                "content": "c",
                            },
                        },
                        {
                            "entryId": "y",
                            "message": {
                                "retryRecovery": {},
                                "continued": True,
                                "contextSnapshot": {},
                                "elidedOutputTokens": 1,
                                "prunedAt": 2.5,
                                "content": [],
                            },
                        },
                    ]
                }
            )
        )

    def _set_result_content(
        self, content: JsonValue
    ) -> tuple[list[EntryPatchSkip], JsonValue]:
        """The skips of a record that sets a tool result's `content`, and the content it leaves."""
        entries = [
            _tool_result("t1", None, _HEAVY),
            _record("p1", "t1", [{"entryId": "t1", "message": {"content": content}}]),
        ]
        skipped: list[EntryPatchSkip] = []
        apply_entry_patches(entries, on_skip=skipped.append)
        return skipped, entries[0]["message"]["content"]  # type: ignore[index]

    # A provider request built from a text block without its text fails, so a
    # record that writes one is skipped whole, as the TypeScript readers skip it.
    def test_a_text_block_without_a_string_text_makes_a_record_malformed(
        self,
    ) -> None:
        for block in ({"type": "text"}, {"type": "text", "text": 5}):
            self.assertEqual(
                self._set_result_content([block]),
                ([EntryPatchSkip("malformed", "p1")], _HEAVY),
                block,
            )
        self.assertEqual(self._set_result_content(_ELIDED), ([], _ELIDED))

    def test_an_image_block_without_string_data_makes_a_record_malformed(
        self,
    ) -> None:
        for block in (
            {"type": "image", "mimeType": "image/png"},
            {"type": "image", "data": None, "mimeType": "image/png"},
        ):
            self.assertEqual(
                self._set_result_content([block]),
                ([EntryPatchSkip("malformed", "p1")], _HEAVY),
                block,
            )
        # A block of another type needs only its string `type`.
        blocks: list[JsonValue] = [
            {"type": "image", "data": "aGVsbG8=", "mimeType": "image/png"},
            {"type": "toolCall", "id": "c1"},
        ]
        self.assertEqual(self._set_result_content(blocks), ([], blocks))

    # `JSON.parse` reads `1e400`, and an integer past the float range, as
    # Infinity; Python reads them as `inf` and a large `int`.
    def test_a_counter_that_is_not_a_finite_number_makes_a_record_malformed(
        self,
    ) -> None:
        for value in (json.loads("1e400"), json.loads("-1e400"), float("nan"), 10**400):
            for fields in (
                {"entry": {"tokensAfter": value}},
                {"message": {"elidedOutputTokens": value}},
                {"message": {"prunedAt": value}},
            ):
                data: JsonObject = {"patches": [{"entryId": "x", **fields}]}
                self.assertFalse(is_entry_patch_data(data), (value, fields))
        for value in (0, -0.0, 1e308, json.loads("1e-400"), 10**300):
            data = {"patches": [{"entryId": "x", "entry": {"tokensAfter": value}}]}
            self.assertTrue(is_entry_patch_data(data), value)

    def test_accepts_each_field_on_its_kind_and_role_only(self) -> None:
        custom_message: JsonObject = {
            "type": "custom_message",
            "id": "m1",
            "content": "long",
        }
        self.assertTrue(
            entry_accepts_patch(
                _compaction("c1"), {"entryId": "c1", "entry": {"warning": "w"}}
            )
        )
        self.assertFalse(
            entry_accepts_patch(
                custom_message, {"entryId": "m1", "entry": {"warning": "w"}}
            )
        )
        self.assertTrue(
            entry_accepts_patch(
                custom_message, {"entryId": "m1", "entry": {"content": "short"}}
            )
        )
        self.assertFalse(
            entry_accepts_patch(
                _compaction("c1"), {"entryId": "c1", "entry": {"content": "x"}}
            )
        )
        self.assertTrue(
            entry_accepts_patch(
                _user("u1"), {"entryId": "u1", "message": {"content": "short"}}
            )
        )
        self.assertFalse(
            entry_accepts_patch(
                _tool_result("t1", None, _HEAVY),
                {"entryId": "t1", "message": {"content": "short"}},
            )
        )
        self.assertTrue(
            entry_accepts_patch(
                _tool_result("t1", None, _HEAVY),
                {"entryId": "t1", "message": {"prunedAt": 1}},
            )
        )
        self.assertFalse(
            entry_accepts_patch(
                _assistant("a1"), {"entryId": "a1", "message": {"prunedAt": 1}}
            )
        )
        self.assertFalse(
            entry_accepts_patch(
                _compaction("c1"), {"entryId": "c1", "message": {"prunedAt": 1}}
            )
        )
        custom_role = _message("x1", None, {"role": "custom", "content": "c"})
        self.assertFalse(
            entry_accepts_patch(
                custom_role, {"entryId": "x1", "message": {"content": "d"}}
            )
        )

    def test_sets_copies_and_only_a_content_the_message_holds(self) -> None:
        entry = _message("b1", None, {"role": "user", "timestamp": 1})
        set_patched_fields(entry, {"entryId": "b1", "message": {"content": "x"}})
        self.assertNotIn("content", entry["message"])  # type: ignore[operator]
        target = _tool_result("t1", None, _HEAVY)
        patch: JsonObject = {
            "entryId": "t1",
            "message": {"content": [{"type": "text", "text": "short"}]},
        }
        set_patched_fields(target, patch)
        # The entry never shares an object with the record.
        self.assertIsNot(target["message"]["content"], patch["message"]["content"])  # type: ignore[index]


class ListingTests(unittest.TestCase):
    def test_lists_entries_past_records(self) -> None:
        parents: RecordParents = {}
        entries = [
            {"type": "session", "id": "s"},
            _user("u1"),
            _record("p1", "u1", []),
            _record("p2", "p1", []),
            _user("u2", "p2"),
        ]
        kept = entries_past_records(entries, parents)
        self.assertEqual(
            [(entry["id"], entry.get("parentId", "absent")) for entry in kept],
            [("s", "absent"), ("u1", None), ("u2", "u1")],
        )
        self.assertEqual(
            (
                past_records("p2", parents),
                past_records("u2", parents),
                past_records(None, parents),
            ),
            ("u1", "u2", None),
        )
        # A later read relinks past a record an earlier read held.
        self.assertEqual(
            entries_past_records([_user("u3", "p1")], parents)[0]["parentId"], "u1"
        )

    def test_splices_record_nodes_out_of_a_tree(self) -> None:
        def node(entry: JsonObject, *children: JsonObject) -> JsonObject:
            return {"entry": entry, "children": list(children)}

        tree = [
            node(
                _record("r0", None, []),
                node(
                    _user("u1", "r0"),
                    node(
                        _record("p1", "u1", []),
                        node(_record("p2", "p1", []), node(_user("u2", "p2"))),
                    ),
                    node(_user("x1", "u1")),
                ),
            )
        ]
        parents: RecordParents = {}
        roots = tree_past_records(tree, parents)
        self.assertEqual(
            _shape(roots), [("u1", None, [("u2", "u1", []), ("x1", "u1", [])])]
        )
        self.assertEqual(
            (past_records("p2", parents), past_records("r0", parents)), ("u1", None)
        )

    def test_splices_a_chain_deeper_than_recursion_reaches(self) -> None:
        depth = 100_000
        root: JsonObject = {}
        node = root
        for index in range(depth):
            parent = None if index == 0 else f"e{index - 1}"
            entry = (
                _record(f"e{index}", parent, [])
                if index % 2
                else _user(f"e{index}", parent)
            )
            node["entry"] = entry
            child: JsonObject = {}
            node["children"] = [child] if index < depth - 1 else []
            node = child
        roots = tree_past_records([root], {})
        seen = 0
        current: Any = roots[0]
        parent_id: str | None = None
        while isinstance(current, dict):
            self.assertEqual(
                (current["entry"]["id"], current["entry"]["parentId"]),
                (f"e{seen * 2}", parent_id),
            )
            parent_id = current["entry"]["id"]
            seen += 1
            current = current["children"][0] if current["children"] else None
        self.assertEqual(seen, depth // 2)


def _shape(nodes: list[JsonValue]) -> list[object]:
    shaped: list[object] = []
    for node in nodes:
        assert isinstance(node, dict)
        entry = node["entry"]
        children = node["children"]
        assert isinstance(entry, dict) and isinstance(children, list)
        shaped.append((entry["id"], entry["parentId"], _shape(children)))
    return shaped


class _ScriptedClient(RpcClient):
    """A client whose server answers each command with the next reply scripted for it."""

    def __init__(self, replies: Mapping[str, list[JsonObject]]) -> None:
        super().__init__()
        self._replies = {command: list(answers) for command, answers in replies.items()}
        self.sent: list[tuple[str, dict[str, object]]] = []

    def _command(
        self,
        command: str,
        params: Mapping[str, object],
        *,
        timeout: float | None = None,
    ) -> JsonObject | None:
        self.sent.append((command, dict(params)))
        return json.loads(json.dumps(self._replies[command].pop(0)))


def _subagent_reply(
    file: str,
    from_byte: int,
    next_byte: int,
    entries: list[JsonObject],
    reset: bool = False,
) -> JsonObject:
    """A `get_subagent_messages` answer as the server's reader gives one."""
    messages: list[JsonValue] = [
        entry["message"] for entry in entries if entry["type"] == "message"
    ]
    return {
        "sessionFile": file,
        "fromByte": from_byte,
        "nextByte": next_byte,
        "reset": reset,
        "entries": list(entries),
        "messages": messages,
    }


def _result_content(messages: tuple[Any, ...]) -> object:
    return next(
        message["content"] for message in messages if message["role"] == "toolResult"
    )


class ClientReadTests(unittest.TestCase):
    # A subagent transcript is read in windows: a record that an elide pass
    # appends lands in a later window than the tool result it shortens. If this
    # regresses, a host polling the transcript keeps the heavy result, and
    # lists the record as an entry.
    def test_get_subagent_messages_returns_the_patch_of_a_later_record(self) -> None:
        client = _ScriptedClient(
            {
                "get_subagent_messages": [
                    _subagent_reply(
                        "/s.jsonl",
                        0,
                        100,
                        [_user("u1"), _tool_result("t1", "u1", _HEAVY)],
                    ),
                    _subagent_reply(
                        "/s.jsonl",
                        100,
                        200,
                        [
                            _record(
                                "p1",
                                "t1",
                                [{"entryId": "t1", "message": {"content": _ELIDED}}],
                            ),
                            _user("u2", "p1", "thanks"),
                        ],
                    ),
                    # Control: the same transcript with the field written inline.
                    _subagent_reply(
                        "/inline.jsonl",
                        0,
                        200,
                        [
                            _user("u1"),
                            _tool_result("t1", "u1", _ELIDED),
                            _user("u2", "t1", "thanks"),
                        ],
                    ),
                ]
            }
        )
        first = client.get_subagent_messages(session_file="/s.jsonl")
        second = client.get_subagent_messages(
            session_file="/s.jsonl", from_byte=first.next_byte
        )
        inline = client.get_subagent_messages(session_file="/inline.jsonl")

        self.assertEqual(
            client.sent[1],
            ("get_subagent_messages", {"sessionFile": "/s.jsonl", "fromByte": 100}),
        )
        # What a caller that holds the earlier entries does with the patches.
        held = {entry["id"]: entry for entry in first.entries}
        for patch in second.entry_patches:
            target = held.get(patch["entryId"])
            if target is not None and entry_accepts_patch(target, patch):
                set_patched_fields(target, patch)

        self.assertEqual(
            second.entry_patches, ({"entryId": "t1", "message": {"content": _ELIDED}},)
        )
        self.assertEqual(
            [(entry["id"], entry["parentId"]) for entry in second.entries],
            [("u2", "t1")],
        )
        self.assertEqual([message["role"] for message in second.messages], ["user"])
        # The patched entry reads as the inline file's, and the message the
        # first reply returned with it.
        self.assertEqual(first.entries, inline.entries[:2])
        self.assertEqual(
            _result_content(first.messages), _result_content(inline.messages)
        )
        self.assertEqual(inline.entry_patches, ())

    # The records of one reply apply to its entries whatever the server did,
    # and only a patch whose target the reply lacks comes back.
    def test_get_subagent_messages_applies_a_record_within_its_reply(self) -> None:
        patches: list[JsonValue] = [
            {"entryId": "t1", "message": {"content": _ELIDED}},
            {"entryId": "a0", "message": {"elidedOutputTokens": 9}},
        ]
        client = _ScriptedClient(
            {
                "get_subagent_messages": [
                    _subagent_reply(
                        "/s.jsonl",
                        100,
                        200,
                        [
                            _assistant("a1", "a0"),
                            _tool_result("t1", "a1", _HEAVY),
                            _record("p1", "t1", patches),
                        ],
                    )
                ]
            }
        )
        read = client.get_subagent_messages(session_file="/s.jsonl", from_byte=100)
        self.assertEqual([entry["id"] for entry in read.entries], ["a1", "t1"])
        self.assertEqual(_result_content(read.messages), _ELIDED)
        self.assertNotIn("elidedOutputTokens", read.messages[0])
        self.assertEqual(
            read.entry_patches,
            ({"entryId": "a0", "message": {"elidedOutputTokens": 9}},),
        )

    # A poll ends where the file ends, so a record an elide pass appends last
    # ends a reply, and the next entry, whose parent is that record, comes in
    # the next reply. If this regresses, that entry's parent is an id no reply
    # lists.
    def test_get_subagent_messages_relinks_past_a_record_that_ended_an_earlier_reply(
        self,
    ) -> None:
        elide: list[JsonValue] = [{"entryId": "t1", "message": {"content": _ELIDED}}]
        client = _ScriptedClient(
            {
                "get_subagent_messages": [
                    _subagent_reply(
                        "/a.jsonl",
                        0,
                        100,
                        [
                            _user("u1"),
                            _tool_result("t1", "u1", _HEAVY),
                            _record("p1", "t1", elide),
                        ],
                    ),
                    # /b.jsonl never held the record.
                    _subagent_reply("/b.jsonl", 0, 100, [_user("b1", "p1")]),
                    _subagent_reply("/a.jsonl", 100, 200, [_user("u2", "p1")]),
                    # The transcript was rewritten: the server reads it again
                    # from the start.
                    _subagent_reply("/a.jsonl", 0, 100, [_user("u1")], reset=True),
                    _subagent_reply("/a.jsonl", 100, 200, [_user("u3", "p1")]),
                ]
            }
        )
        reads = [
            client.get_subagent_messages(session_file=file, from_byte=from_byte)
            for file, from_byte in (
                ("/a.jsonl", None),
                ("/b.jsonl", 0),
                ("/a.jsonl", 100),
                ("/a.jsonl", 200),
                ("/a.jsonl", 100),
            )
        ]
        self.assertEqual(
            [
                [(entry["id"], entry["parentId"]) for entry in read.entries]
                for read in reads
            ],
            [
                [("u1", None), ("t1", "u1")],
                [("b1", "p1")],
                [("u2", "t1")],
                [("u1", None)],
                [("u3", "p1")],
            ],
        )
        self.assertEqual(_result_content(reads[0].messages), _ELIDED)

    # The session manager always writes `parentId`; a record line without one
    # stands for a record at the root, so what it hides takes no parent.
    def test_get_entries_and_get_tree_give_no_parent_past_a_record_with_no_parent_id(
        self,
    ) -> None:
        record = _record("q1", None, [])
        del record["parentId"]
        client = _ScriptedClient(
            {
                "get_entries": [
                    {
                        "entries": [_user("u1"), record, _user("q2", "q1")],
                        "leafId": "q1",
                    }
                ],
                "get_tree": [
                    {
                        "tree": [
                            {"entry": _user("u1"), "children": []},
                            {
                                "entry": record,
                                "children": [
                                    {"entry": _user("q2", "q1"), "children": []}
                                ],
                            },
                        ],
                        "leafId": "q1",
                    }
                ],
            }
        )
        entries = client.get_entries()
        tree = client.get_tree()
        self.assertEqual(
            [(entry["id"], entry["parentId"]) for entry in entries.entries],
            [("u1", None), ("q2", None)],
        )
        self.assertIsNone(entries.leaf_id)
        self.assertEqual(_shape(list(tree.tree)), [("u1", None, []), ("q2", None, [])])
        self.assertIsNone(tree.leaf_id)

    # A host that mirrors the session with get_entries(since) or get_tree sees
    # each record as an entry, and an entry after it whose parent is no entry
    # it lists. The server's live entries already carry each record; a record
    # it holds can keep a value a later rewrite-only pass replaced in its
    # entry, so applying it again would bring that value back.
    def test_get_entries_and_get_tree_list_no_record_and_apply_none_again(self) -> None:
        with_image: list[JsonValue] = [
            *_ELIDED,
            {"type": "image", "data": "aGVsbG8=", "mimeType": "image/png"},
        ]
        record = _record(
            "p1", "t1", [{"entryId": "t1", "message": {"content": with_image}}]
        )
        client = _ScriptedClient(
            {
                "get_entries": [
                    {
                        "entries": [
                            _user("u1"),
                            _tool_result("t1", "u1", _ELIDED),
                            record,
                            _user("u2", "p1", "thanks"),
                            _record("p2", "u2", []),
                        ],
                        "leafId": "p2",
                    },
                    {"entries": [_user("u3", "p2", "more")], "leafId": "u3"},
                ],
                "get_tree": [
                    {
                        "tree": [
                            {
                                "entry": _user("u1"),
                                "children": [
                                    {
                                        "entry": _tool_result("t1", "u1", _ELIDED),
                                        "children": [
                                            {
                                                "entry": record,
                                                "children": [
                                                    {
                                                        "entry": _user(
                                                            "u2", "p1", "thanks"
                                                        ),
                                                        "children": [
                                                            {
                                                                "entry": _record(
                                                                    "p2", "u2", []
                                                                ),
                                                                "children": [],
                                                            }
                                                        ],
                                                    }
                                                ],
                                            }
                                        ],
                                    }
                                ],
                            }
                        ],
                        "leafId": "p2",
                    }
                ],
            }
        )
        whole = client.get_entries()
        since = client.get_entries("u2")
        tree = client.get_tree()

        self.assertEqual(
            [(entry["id"], entry["parentId"]) for entry in whole.entries],
            [("u1", None), ("t1", "u1"), ("u2", "t1")],
        )
        self.assertEqual(whole.leaf_id, "u2")
        self.assertEqual(whole.entries[1]["message"]["content"], _ELIDED)  # type: ignore[index]
        self.assertEqual(
            [(entry["id"], entry["parentId"]) for entry in since.entries],
            [("u3", "u2")],
        )
        self.assertEqual(
            _shape(list(tree.tree)), [("u1", None, [("t1", "u1", [("u2", "t1", [])])])]
        )
        self.assertEqual(tree.leaf_id, "u2")
        result = tree.tree[0]["children"][0]["entry"]  # type: ignore[index]
        self.assertEqual(result["message"]["content"], _ELIDED)  # type: ignore[index]


@unittest.skipUnless(
    _BUN is not None and _HOST.is_file(),
    "needs bun on PATH and this repository checkout to start the real omp host",
)
class HostReadTests(unittest.TestCase):
    """`get_entries` and `get_tree` of a session file holding records, read from this checkout's own omp host."""

    def _read(self, root: Path, entries: list[JsonObject]) -> tuple[Any, Any]:
        assert _BUN is not None
        root.mkdir()
        session_file = root / "session.jsonl"
        header = {
            "type": "session",
            "version": 3,
            "id": root.name,
            "timestamp": _TIMESTAMP,
            "cwd": str(root),
        }
        session_file.write_text(
            "".join(json.dumps(line) + "\n" for line in [header, *entries]),
            encoding="utf-8",
        )
        client = RpcClient(
            command=[_BUN, str(_HOST), str(root), str(session_file)],
            cwd=root,
            env={"PI_CODING_AGENT_DIR": str(root), "PI_NO_TITLE": "1"},
            startup_timeout=120.0,
            request_timeout=120.0,
        )
        try:
            client.start()
        except RpcError as exc:
            self.skipTest(f"the omp host did not start: {exc}")
        try:
            return client.get_entries(), client.get_tree()
        finally:
            client.stop()

    def test_lists_no_record_and_reads_as_the_fields_written_inline(self) -> None:
        with tempfile.TemporaryDirectory(prefix="omp-rpc-entry-patch-") as directory:
            patched = self._read(
                Path(directory) / "patched",
                [
                    _user("u1", None, "list the files"),
                    _assistant("a1", "u1"),
                    _tool_result("t1", "a1", _HEAVY),
                    _record(
                        "p1", "t1", [{"entryId": "t1", "message": {"content": _ELIDED}}]
                    ),
                    _user("u2", "p1", "thanks"),
                    _record(
                        "p2",
                        "u2",
                        [{"entryId": "a1", "message": {"elidedOutputTokens": 7}}],
                    ),
                ],
            )
            # Control: the same session with the fields written inline.
            inline = self._read(
                Path(directory) / "inline",
                [
                    _user("u1", None, "list the files"),
                    _assistant("a1", "u1", elidedOutputTokens=7),
                    _tool_result("t1", "a1", _ELIDED),
                    _user("u2", "t1", "thanks"),
                ],
            )
        self.assertEqual(
            [entry["id"] for entry in patched[0].entries], ["u1", "a1", "t1", "u2"]
        )
        self.assertEqual(patched[0], inline[0])
        self.assertEqual(patched[0].leaf_id, "u2")
        self.assertEqual(patched[1], inline[1])
        self.assertEqual(patched[1].leaf_id, "u2")


if __name__ == "__main__":
    unittest.main()
