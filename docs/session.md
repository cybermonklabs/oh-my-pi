# Session Storage and Entry Model

This document is the source of truth for how coding-agent sessions are represented, persisted, migrated, and reconstructed at runtime.

## Scope

Covers:

- Session JSONL format and versioning
- Entry taxonomy and tree semantics (`id`/`parentId` + leaf pointer)
- Migration/compatibility behavior when loading old or malformed files
- Context reconstruction (`buildSessionContext`)
- Persistence guarantees, failure behavior, truncation/blob externalization
- Storage abstractions (`FileSessionStorage`, `MemorySessionStorage`, the `SqlSessionStorage` schema) and related utilities

Does not cover `/tree` UI rendering behavior beyond semantics that affect session data.

## Implementation Files

- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts) — orchestration: tree/leaf, appends, persistence, blobs, lifecycle factories
- [`src/session/session-entries.ts`](../packages/coding-agent/src/session/session-entries.ts) — entry/header types, `SessionEntry` union, `CURRENT_SESSION_VERSION`
- [`src/session/session-migrations.ts`](../packages/coding-agent/src/session/session-migrations.ts) — version migrations
- [`src/session/session-loader.ts`](../packages/coding-agent/src/session/session-loader.ts) — file load + blob-ref resolution
- [`src/session/session-context.ts`](../packages/coding-agent/src/session/session-context.ts) — `buildSessionContext`
- [`src/session/session-persistence.ts`](../packages/coding-agent/src/session/session-persistence.ts) — truncation + image blob externalization
- [`src/session/session-paths.ts`](../packages/coding-agent/src/session/session-paths.ts) — on-disk layout, dir encoding, terminal breadcrumbs
- [`src/session/session-listing.ts`](../packages/coding-agent/src/session/session-listing.ts) — discovery (list/recent/resolve)
- [`src/session/session-index.ts`](../packages/coding-agent/src/session/session-index.ts) — indexed titles and idle recap journal in `history.db`
- [`src/session/exit-diagnostics.ts`](../packages/coding-agent/src/session/exit-diagnostics.ts) — pending tools and interrupted-turn diagnostics
- [`src/session/session-storage.ts`](../packages/coding-agent/src/session/session-storage.ts) — storage abstractions
- [`src/session/session-title-slot.ts`](../packages/coding-agent/src/session/session-title-slot.ts) — fixed-width current-title slot
- [`src/session/indexed-session-storage.ts`](../packages/coding-agent/src/session/indexed-session-storage.ts) — local index + ordered remote-backed storage adapter
- [`src/session/sql-session-storage.ts`](../packages/coding-agent/src/session/sql-session-storage.ts) — PostgreSQL/MySQL/SQLite storage: session rows plus appended parts
- [`src/session/messages.ts`](../packages/coding-agent/src/session/messages.ts) — custom-message transformers
- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts) — content-addressed blob store
- [`src/session/history-storage.ts`](../packages/coding-agent/src/session/history-storage.ts) — prompt history (separate subsystem)

## On-Disk Layout

Default file-session location:

```text
~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
```

`<encoded-cwd>` is derived from the canonicalized cwd (so symlink aliases share a bucket): `-<relative>` for directories under home, `-tmp-<relative>` for directories under the temp root, and `--<encoded-absolute>--` for anything else, with path separators replaced by `-`.

On access, buckets written by the short-lived hashed scheme (`<scope>-<project-basename>-<sha256(canonical-cwd)>`, used in 17.2.5-17.2.8 and reverted in 17.2.9 by #7397) are migrated back into the path-encoded names best-effort, along with older `--<home-encoded>-*--` spellings of home-relative buckets.

Blob store location:

```text
~/.omp/agent/blobs/<sha256>
```

Terminal breadcrumb files are written under:

```text
~/.omp/agent/terminal-sessions/<terminal-id>
```

Breadcrumb content begins with cwd and session file path. Optional extra lines are `fresh` and `cwdstat <device> <inode>`. A fresh breadcrumb preserves an initially created, lazy session whose JSONL file does not exist yet, preventing `continueRecent()` from reopening the previous session. Explicit `newSession()` boundaries materialize their header before returning, except the lazy successor created by `drop` (`/delete`). The directory identity permits automatic re-rooting after a same-filesystem project rename; a missing cwd alone is not move evidence. Writes are synchronous, ordered, and best-effort.

## File Format

Session files are JSONL: one JSON object per line. Current files physically begin with a fixed-width, 256-byte `type: "title"` slot (including its newline), followed by the session header and then `SessionEntry` values. Legacy files may begin directly with the header. Loaders strip the physical slot and fold its current title/source into the logical header.

- The logical first entry is always the session header (`type: "session"`).
- Remaining logical entries are `SessionEntry` values.
- Ordinary appends extend the tree; branch navigation moves an in-memory pointer (`leafId`). Targeted rewrite/discard helpers can change existing records.

### Header (`SessionHeader`)

```json
{
	"type": "session",
	"version": 3,
	"id": "019c625b-b900-7000-8000-000000000001",
	"timestamp": "2026-02-16T10:20:30.000Z",
	"cwd": "/work/pi",
	"title": "optional session title",
	"titleSource": "auto",
	"additionalDirectories": ["/work/shared"],
	"previousSessionFiles": ["/old/location/session.jsonl"],
	"providerPromptCacheKey": "optional inherited cache identity",
	"taskPromptCacheKey": "optional local-only Task sibling family key",
	"parentSession": "optional lineage marker"
}
```

Notes:

- New session ids are UUIDv7 strings; readers also accept older string ids.
- `additionalDirectories` records normalized, deduplicated workspace roots beyond `cwd`.
- `previousSessionFiles` records prior absolute locations after successful moves.
- `providerPromptCacheKey` carries an inherited provider prompt-cache identity for eligible full forks.
- `taskPromptCacheKey` is a local-only Task sibling family key (`<parent cache key>:<agent name>`), omitted from shares and HTML exports.
   - The executor derives it once the child session exists, regardless of the child's initial model. An empty parent cache lineage derives nothing, so those children keep their own session identity.
   - Until a request uses it, the key lives in a session-scoped, non-persisted stash. The first primary request on a model that opts into `shared-prompt-cache` writes it to the header, so fork and reopen keep it.
   - Each request decides consumption against its own model: an explicit session key wins; otherwise the family key applies only on opted-in models.
   - The stash does not survive a fork, move, branch, new-session reset, or switch to a different session; a rolled-back move or switch restores it.
- `parentSession` is an opaque lineage string. Current code writes either a session id or a session path depending on flow (`fork`, `forkFrom`, `createBranchedSession`, or explicit `newSession({ parentSession })`). Treat it as metadata, not a typed foreign key.

- `titleSource` is `auto` or `user`; automatic renames cannot overwrite a user title.

### Entry Base (`SessionEntryBase`)

All non-header entries include:

```json
{
	"type": "...",
	"id": "8-char-id",
	"parentId": "previous-or-branch-parent",
	"timestamp": "2026-02-16T10:20:30.000Z"
}
```

`parentId` can be `null` for a root entry (first append, or after `resetLeaf()`). Generated entry ids are normally eight hexadecimal characters, with a full Snowflake id as the collision-exhaustion fallback; consumers must not assume a fixed width.

## Entry Taxonomy

`SessionEntry` is the union of:

- `message`
- `model_usage`
- `thinking_level_change`
- `model_change`
- `service_tier_change`
- `compaction`
- `branch_summary`
- `reset_boundary`
- `custom`
- `custom_message`
- `label`
- `title_change`
- `ttsr_injection`
- `credential_pin`
- `session_init`
- `mode_change`

### `message`

Stores an `AgentMessage` directly.

```json
{
	"type": "message",
	"id": "a1b2c3d4",
	"parentId": null,
	"timestamp": "2026-02-16T10:21:00.000Z",
	"message": {
		"role": "assistant",
		"api": "anthropic-messages",
		"provider": "anthropic",
		"model": "claude-sonnet-4-5",
		"content": [{ "type": "text", "text": "Done." }],
		"usage": {
			"input": 100,
			"output": 20,
			"cacheRead": 0,
			"cacheWrite": 0,
			"totalTokens": 120,
			"cost": {
				"input": 0,
				"output": 0,
				"cacheRead": 0,
				"cacheWrite": 0,
				"total": 0
			}
		},
		"stopReason": "stop",
		"timestamp": 1760000000000
	}
}
```

The persisted `message.role` discriminant is **camelCase**, not the snake_case used by
the LLM wire format or extension hook names. Ordinary conversation records use these
roles under `type: "message"`:

| Persisted `message.role` | Owner package | Notes                                                                             |
| ------------------------ | ------------- | --------------------------------------------------------------------------------- |
| `user`                   | pi-ai         | User/tool-feedback turn.                                                          |
| `developer`              | pi-ai         | Developer-role instruction turn.                                                  |
| `assistant`              | pi-ai         | Model turn; tool calls live in its `content` as `{ "type": "toolCall" }` blocks.  |
| `toolResult`             | pi-ai         | Result of one tool call — **not** `tool_result`. Carries `toolCallId`/`toolName`. |
| `bashExecution`          | pi-tui        | Standalone `!`-bash run.                                                          |
| `pythonExecution`        | pi-tui        | Standalone Python run.                                                            |
| `hookMessage`            | pi-tui        | Legacy hook-injected message, retained for migration; new code uses `custom`.     |
| `fileMention`            | pi-tui        | Inlined `@file` mention contents.                                                 |

Branch and compaction summary roles are synthesized from dedicated top-level entries
during session-context reconstruction. Extension messages sent through `pi.sendMessage`
likewise persist as `custom_message` entries and reconstruct as `custom`:

| Persisted entry type | Reconstructed role  |
| -------------------- | ------------------- |
| `branch_summary`     | `branchSummary`     |
| `compaction`         | `compactionSummary` |
| `custom_message`     | `custom`            |

Internal callers can append a `custom` message directly, so readers must discriminate on
`entry.type` rather than infer the persisted shape from the reconstructed role.

`toolCall` is a **content-block type inside an `assistant` message's `content` array**, not
a message role. An extension keying off `message.role` that matches snake_case constants
(`tool_result`, `tool_call`) or lowercases the role before comparing will silently skip
`toolResult` (and every other camelCase role) — no error is raised. Match the camelCase
values above verbatim. The base roles are `Message` in `packages/ai/src/types.ts`; the rest
are merged into `CustomAgentMessages` (`packages/agent/src/compaction/messages.ts`,
`packages/tui/src/chat/messages.ts`). Coding-agent re-exports the custom types and
converts them for provider context in `packages/coding-agent/src/session/messages.ts`.

### `model_usage`

Records model calls outside the conversation transcript. Fields are `purpose`,
optional model `role`, `api`, `provider`, `model`, `usage`, `stopReason`, and
optional `errorMessage`. These records contribute usage accounting, not model
messages or transcript turns. `appendModelUsage()` attaches the record to the
initiating session/branch and rejects stale session ownership.

### `model_change`

```json
{
	"type": "model_change",
	"id": "b1c2d3e4",
	"parentId": "a1b2c3d4",
	"timestamp": "2026-02-16T10:21:30.000Z",
	"model": "openai/gpt-4o",
	"role": "default"
}
```

`role` is optional; missing is treated as `default` in context reconstruction.
`resolvedModelIsFallback` optionally marks a retry-fallback transition. The
reserved role `fallback` is ephemeral: model restoration prefers the configured
default instead of restoring that role's temporary model.

### `service_tier_change`

```json
{
	"type": "service_tier_change",
	"id": "c1d2e3f4",
	"parentId": "b1c2d3e4",
	"timestamp": "2026-02-16T10:21:45.000Z",
	"serviceTier": { "openai": "priority", "google": "flex" }
}
```

`serviceTier` is a per-family map keyed by `openai`/`anthropic`/`google` (each value `auto`/`default`/`flex`/`scale`/`priority`/`ultrafast`), or `null` when no tier is active. Legacy entries that stored a single string (`"flex"`, `"openai-only"`, `"claude-only"`, …) are coerced to this map during context reconstruction; loading alone does not rewrite their payload.

### `thinking_level_change`

```json
{
	"type": "thinking_level_change",
	"id": "c1d2e3f4",
	"parentId": "b1c2d3e4",
	"timestamp": "2026-02-16T10:22:00.000Z",
	"thinkingLevel": "high"
}
```

`configured` may additionally preserve the selector the user chose (`"auto"` or a concrete level). Readers of older entries fall back to `thinkingLevel`. Both fields can be `null`; a null/missing resolved level reconstructs as `"off"`.

### `compaction`

```json
{
	"type": "compaction",
	"id": "d1e2f3a4",
	"parentId": "c1d2e3f4",
	"timestamp": "2026-02-16T10:23:00.000Z",
	"summary": "Conversation summary",
	"shortSummary": "Short recap",
	"firstKeptEntryId": "a1b2c3d4",
	"tokensBefore": 42000,
	"details": { "readFiles": ["src/a.ts"] },
	"preserveData": { "hookState": true },
	"fromExtension": false
}
```

Optional compaction metadata includes `tokensAfter`, `method`,
`providerReplayThroughEntryId`, and `warning`. `preserveData` can carry native
OpenAI/Anthropic replay state or a snapcompact archive; it is not just extension
state. `providerReplayThroughEntryId` marks the last entry represented by native
replacement history so later entries still replay normally.

### `branch_summary`

```json
{
	"type": "branch_summary",
	"id": "e1f2a3b4",
	"parentId": "a1b2c3d4",
	"timestamp": "2026-02-16T10:24:00.000Z",
	"fromId": "a1b2c3d4",
	"summary": "Summary of abandoned path",
	"details": { "note": "optional" },
	"fromExtension": true
}
```

If branching from root (`branchFromId === null`), `fromId` is the literal string `"root"`.

### `reset_boundary`

A payload-free marker appended by `/clear`. The collapsed live transcript and rebuilt model context begin after the latest applicable boundary; full-history transcript export still retains entries before it.

### `custom`

Opaque, non-LLM records owned by core subsystems or extensions. `buildSessionContext` does not directly turn them into model messages, but subsystem-specific replay code can consume `customType` values to restore runtime state or diagnose an interrupted turn.

```json
{
	"type": "custom",
	"id": "f1a2b3c4",
	"parentId": "e1f2a3b4",
	"timestamp": "2026-02-16T10:25:00.000Z",
	"customType": "com.example.my-extension.state",
	"data": { "state": 1 }
}
```

Current core-owned values include:

| `customType`             | `data` schema                                                                                                                                                                                                                                            | Writer and consumer                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_execution_start`   | `{ toolCallId: string, toolName: string, startedAt: string, args?: { command?: string, path?: string }, intent?: string }`                                                                                                                               | `AgentSession` writes a marker immediately before a tool implementation starts. Exit diagnostics combine it with assistant tool calls and tool results to reconstruct calls left pending. Argument summaries are truncated projections; older full argument objects are accepted on read.                                                                                                                                                                              |
| `session_exit`           | `{ reason: string, kind: "normal" \| "signal" \| "fatal" \| "process_exit", recordedAt: string, pendingToolCalls?: Array<{ toolCallId?: string, toolName: string, args?: unknown, intent?: string, assistantTimestamp?: number, startedAt?: string }> }` | Normal disposal and postmortem teardown record the exit when the session has assistant history or pending tool calls. The writer immediately calls `flushSync()` so a subsequent process can inspect the last durable turn; a flush failure is logged. Resume diagnostics consume the latest valid record.                                                                                                                                                             |
| `user_todo_edit`         | `{ phases: TodoPhase[] }`                                                                                                                                                                                                                                | SDK/UI todo editing persists the complete phase snapshot. Todo restoration scans backward for the latest snapshot (or a successful `todo` tool result) and restores its phases.                                                                                                                                                                                                                                                                                        |
| `vibe-session-lifecycle` | Version-1 event with `{ version: 1, id, ownerId, parentSessionId, action, ... }`; `spawn` adds `cli`, `agent`, `childSessionFile`, and `createdAt`; turn events add `turn`; tombstone events add `reason`.                                               | Vibe runtime persists and replays child spawn, turn-started/settled, tombstone, and tombstone-revoked transitions to recover owned child sessions and in-flight state. Invalid or out-of-scope events are ignored.                                                                                                                                                                                                                                                     |
| `autoresearch-control`   | `{ mode: "on" \| "off" \| "clear", goal?: string }`                                                                                                                                                                                                      | The built-in autoresearch command writes mode/goal changes, and experiment-limit shutdown writes `mode: "off"`. `reconstructControlState()` replays valid records on resume to restore whether autoresearch is active and its goal; `clear` removes the goal.                                                                                                                                                                                                          |
| `system-prompt-digest`   | Hexadecimal string: a hash of the base system prompt blocks (before a per-turn hook override)                                                                                                                                                            | `AgentSession` appends it just before a primary assistant reply with provider output whose prompt differs from the branch's latest record, and carries it onto a rewind branch with the reparented sibling reply. Before a resumed session's first model call, a prefix-bound tool-list rebuild commits only if it reproduces that prompt; without a record it freezes. Memory recall injected into the base prompt is part of the hash, so such sessions stay frozen. |

On resume, a valid latest `session_exit` after a non-terminal conversation tail causes `AgentSession`/SDK initialization to append a synthetic assistant message with `stopReason: "aborted"` and rebuild the display/agent context. A normal exit only triggers that transition when it recorded pending tool calls; abnormal exit kinds can trigger it without that list. This prevents the restored transcript from presenting an interrupted turn as still live.

The strings in the table are reserved for their core consumers. Extensions MUST NOT use them. Use a namespaced identifier such as a reverse-domain or package-qualified name for extension records; a collision can cause core replay logic to interpret extension data as lifecycle state. Unknown namespaced values remain opaque to core session-context reconstruction.

### `custom_message`

Extension-provided message that does participate in LLM context. `content` can be a string or text/image content blocks, and `attribution` records whether the user or agent initiated it.

```json
{
	"type": "custom_message",
	"id": "a2b3c4d5",
	"parentId": "f1a2b3c4",
	"timestamp": "2026-02-16T10:26:00.000Z",
	"customType": "my-extension",
	"content": "Injected context",
	"display": true,
	"details": { "debug": false },
	"attribution": "agent"
}
```

### `label`

```json
{
	"type": "label",
	"id": "b2c3d4e5",
	"parentId": "a2b3c4d5",
	"timestamp": "2026-02-16T10:27:00.000Z",
	"targetId": "a1b2c3d4",
	"label": "checkpoint"
}
```

`label: undefined` clears a label for `targetId`.

### `title_change`

Append-only audit entry for a session rename. It records `title`, `source` (`auto` or `user`), and optionally `previousTitle` and `trigger`. The current title is also updated in the fixed-width title slot so listing does not require a full-file rewrite.

`/rename <title>` sets an explicit title. `/rename` without a title generates one from recent conversation using the title-generation candidates (`tiny`, `commit`, `smol`, then eligible current-model fallbacks), keeping the current title's card (`<icon> <CODE>: `) if it has one. A title still without a card, typed or generated, gets one from the same candidates (`src/prompts/system/title-card.md`) unless `title.icons` is `boring`; a failed card leaves the title plain, and an interrupt drops only the card from a typed title. Both are user-requested renames (`source: "user"`), so later automatic titling cannot replace them. Empty conversation or failed generation leaves the current title unchanged. A session switch or newer rename while generation runs discards the stale result. Local tiny-model failures never fall back to an online provider.

### `ttsr_injection`

```json
{
	"type": "ttsr_injection",
	"id": "c2d3e4f5",
	"parentId": "b2c3d4e5",
	"timestamp": "2026-02-16T10:28:00.000Z",
	"injectedRules": ["ruleA", "ruleB"]
}
```

### `credential_pin`

Records the provider and a pseudonymous SHA-256 account/scope hash used to re-pin resumed OAuth traffic to the serving account and preserve account-scoped prompt-cache reuse. It does not store the raw account identity; exported hashes remain linkable and are not anonymous.

### `session_init`

```json
{
	"type": "session_init",
	"id": "d2e3f4a5",
	"parentId": "c2d3e4f5",
	"timestamp": "2026-02-16T10:29:00.000Z",
	"systemPrompt": ["...", "..."],
	"task": "...",
	"tools": ["read", "edit"],
	"outputSchema": { "type": "object" },
	"outputSchemaMode": "strict",
	"restrictToolNames": true,
	"spawns": "*",
	"readSummarize": false
}
```

The latest `session_init` is also the cold-subagent revival contract. Optional
fields include `agent`, `modelRole`, `resolvedModel`, `perCallModel` (boolean),
`perCallModelIdentity`, `perCallThinkingLevel`, `retryFallback`, `readOnly`,
`advisor`, and `compactionThreshold` (`thresholdPercent`/`thresholdTokens`).
For `perCallModel: true`, cold revival requires both `perCallModelIdentity` (the
exact `provider/model-id[@upstream]`, without an effort suffix) and
`perCallThinkingLevel` (the configured effort selector, including `auto`, or
`null` for unset). Legacy per-call records missing either field refuse revival
rather than guessing from the historical-display `resolvedModel`. These fields
are preserved in anonymized exports under the same flag, model-identity and
effort rules as other session metadata.
`isolated: true` marks an isolation-worktree child that cannot be cold-revived.
`mountedTools` names the entries of `tools` presented as `xd://` devices rather than top-level
tools; cold revival mounts them again, so the revived session sends the same tool list and tool
inventory. Files without it revive every name in `tools` top-level, and a seance restore uses its
own validated tool contract instead. Anonymized exports treat it like `tools`.
`systemPrompt` holds the base prompt blocks a model call was built from (never a per-turn
`before_agent_start` override), and revival replays them unchanged. A session appends a newer
`session_init` when a model call runs on a different base prompt or work-pool yield items
(`workPoolYieldItems`, restored on revival). Older files store one joined string, which revives
as a single block.
`extractSessionInit()` and read-only `peekSessionInit()` expose this contract.

### `mode_change`

```json
{
	"type": "mode_change",
	"id": "e2f3a4b5",
	"parentId": "d2e3f4a5",
	"timestamp": "2026-02-16T10:30:00.000Z",
	"mode": "plan",
	"data": { "planFilePath": "local://PLAN.md" }
}
```

## Versioning and Migration

Current session version: `3`.

### v1 -> v2

Applied when header `version` is missing or `< 2`:

- Adds `id` and `parentId` to each non-header entry.
- Reconstructs a linear parent chain using file order.
- Migrates compaction field `firstKeptEntryIndex` -> `firstKeptEntryId` when present.
- Sets header `version = 2`.

### v2 -> v3

Applied when header `version < 3`:

- For `message` entries: rewrites legacy `message.role === "hookMessage"` to `"custom"`.
- Sets header `version = 3`.

### Migration Trigger and Persistence

- Migrations run during session load (`setSessionFile`).
- If any migration ran, the in-memory representation is marked for a full rewrite rather than rewritten immediately.
- The next persistence operation performs the full rewrite before incremental appends continue.

## Load and Compatibility Behavior

`loadEntriesFromFile(path)` behavior:

- Missing file (`ENOENT`) -> returns `[]`, unless `throwIfMissing: true` requests an error.
- Transcripts of at least 8 MiB stream through the JSONL loader from any storage with `readChunks` (file storage and the indexed Redis/SQL storages); smaller ones, and storages without it, use a full text read.
- Malformed records are skipped and counted by the lenient JSONL parser.
- The optional fixed-width title slot is removed and folded into the header.
- If the first logical entry is not a valid session header (`type !== "session"` or missing string `id`) -> returns `[]`.

`SessionManager.setSessionFile()` behavior:

- Missing or genuinely empty files initialize a new session at that exact path and materialize its header immediately. `SessionManager.open(..., { throwIfMissing: true })` instead rejects missing/empty input.
- Non-empty data without a valid leading session header is rejected without modifying the file. An array-only `loadEntriesFromFile()` result of `[]` therefore does not distinguish empty from corrupt input; the manager uses `loadSessionFile()` diagnostics.
- Valid files are loaded, migrated if needed, blob refs resolved, then indexed. Migrations, skipped malformed records, and loaded OpenAI replay sanitization mark the next persistence operation for a full rewrite.
- A recorded cwd is adopted only when it is enterable. Otherwise runtime cwd stays at the launch/current directory while the transcript remains in its original location; workspace-root edits stay runtime-only until relocation.

## Tree and Leaf Semantics

The underlying model is append-only tree + mutable leaf pointer:

- Ordinary append methods create one new entry whose `parentId` is current `leafId`, then advance the leaf.
- `appendMessageToBranch()` appends to an explicit parent without moving the active leaf. `appendModelUsage()` likewise retains a successor branch's leaf when the initiating parent is no longer active.
- `branch(entryId)` moves only `leafId`; existing entries remain unchanged.
- `resetLeaf()` sets `leafId = null`; next append creates a new root entry (`parentId: null`).
- `branchWithSummary()` sets leaf to branch target and appends a `branch_summary` entry.

`getEntries()` returns all non-header entries in insertion order. There is no separate persisted leaf field: loading rebuilds the leaf from the last physical entry. Pointer-only `branch()`/`resetLeaf()` changes therefore need a subsequent append to survive reload. `discardEntryDurably()` appends a metadata branch marker and rewrites the journal to make a discarded path durable.

`createBranchedSession(leafId, { copyArtifacts? })` creates a new identity containing only the selected root-to-leaf path. It drops old label records and recreates the resolved labels for retained entries. Unlike a full fork, it does not inherit the provider prompt-cache key. With `copyArtifacts` (used by `AgentSession.fork(entryId)`), the artifacts directory is copied in the background and the new artifact manager waits for the copy before allocating ids or resolving `artifact://`, as for a move to a sibling file.

## Context Reconstruction (`buildSessionContext`)

`buildSessionContext(entries, leafId?, byId?, options?)` resolves what is sent to the model. `options.transcript: true` instead builds a display transcript. Full transcript mode preserves compactions inline; `collapseCompactedHistory` renders only the current compacted tail, and `keepDanglingToolCalls` preserves still-running tool calls during a mid-turn UI rebuild.

Algorithm:

1. Determine leaf:
   - `leafId === null` -> return empty context.
   - explicit `leafId` -> use that entry if found.
   - otherwise fallback to last entry.
2. Walk `parentId` to root, stopping on a repeated id to bound corrupt cycles, then reverse to root->leaf.
3. Derive runtime state across the path:
   - resolved and configured thinking selectors from latest `thinking_level_change`
   - service tier from latest `service_tier_change`
   - model map from `model_change` entries (`role ?? "default"`); assistant-message inference is legacy fallback only until an explicit default is seen
   - deduplicated `injectedTtsrRules`
   - mode/modeData from latest `mode_change` (default mode `"none"`)
4. Choose the emission boundary:
   - a later `reset_boundary` hides everything through that boundary from model context and collapsed live transcript
   - otherwise the latest compaction emits its summary plus kept/post-compaction messages (provider-native replacement history may supply the kept model context)
   - full transcript export retains pre-reset history and renders compactions chronologically
5. Convert `message`, `custom_message`, and `branch_summary` entries into messages. Other entry types only affect replay state or metadata.
6. Remove dangling tool calls from replay (unless explicitly retained for a mid-turn transcript), neutralizing protected reasoning metadata on rewritten turns; drop unsafe aborted/error assistant turns and their paired tool results from model context.

## Persistence Guarantees and Failure Model

### Persist vs in-memory

- `SessionManager.create/open/continueRecent/forkFrom` -> persistent mode (`persist = true`).
- `SessionManager.inMemory` -> non-persistent mode (`persist = false`) with `MemorySessionStorage`.

### Write pipeline

Ordinary completed appends update memory and local file storage synchronously once the lazy file-creation gate has been crossed. There is no `fsync`, so successful local writes protect against software crashes, not power loss. Indexed Redis/SQL backends update their local view immediately but publish remotely in an ordered async queue; `flush()`/backend drain is required to confirm those writes. Title changes and atomic batches have their own awaited persistence paths. Streaming partial text is not persisted until the completed message is appended.

- A new ordinary session remains memory-only until it contains an assistant message or a caller invokes `ensureOnDisk()`.
- Before that gate, entries remain in memory; crossing it writes the full title slot, header, and accumulated entries.
- Explicit `newSession()` (including `/new`) calls `ensureOnDisk()` before returning, preserving an empty session boundary across terminals. The `/delete` successor (`drop`) is the exception: it stays lazy, because the fresh terminal breadcrumb already pins this terminal to it and a failed deletion leaves the predecessor as a legitimate resume target; a zero-turn quit must not leave an empty file.
- Afterwards, entries append incrementally.
- Saving an editor draft forces a discoverable header and stores `draft.txt` with a marker; if the draft disappears while only startup metadata remains, close removes that draft-only session. Explicit `ensureOnDisk()` sessions remain resumable.
- Concurrent completed appends supersede an in-flight atomic rewrite with an authoritative full-body rewrite so stale publication cannot clobber them.
- A queued indexed full rewrite stays non-current until confirmation. When a fenced rewrite lands after a successor supersedes it, the manager validates that durable body and records its byte size before retrying the newer transcript.

### Durability operations

- `flush()` drains async disk/storage queues and the open writer (no `fsync`); `flushSync()` drains synchronously supported work or rewrites a non-current file. It cannot confirm queued remote publication; those backends still require awaited `flush()`/drain.
- Atomic full rewrites use storage `writeTextAtomic` with a commit guard and expected byte-size precondition; file storage stages then renames over the target, including an EPERM-safe move-aside fallback.
- `SessionManager` hands full rewrites over as lines (`writeLinesSync`/`writeLinesAtomic`) so no storage needs the body as one string. File storage streams them into its staging file. Indexed Redis/SQL storage spools them synchronously, in 1 MiB writes, into a file under `<os temp>/omp-spool/` that is unlinked as soon as it is open (so a killed process leaves nothing; on Windows the file is removed after the publish, and one older than an hour at the next start), then publishes from the spool through the backend's optional `writeFullStream` (SQL's staged swap below); a backend without it gets the spool read back whole through `writeFull`. A failed atomic publish still counts as landed when the stored bytes match the spool by size and SHA-256. A subclass or spy that overrides `writeTextSync`/`writeTextAtomic` keeps receiving the joined body.
- Indexed storage reads a transcript as chunks (`readChunks`) through the backend's optional `readChunks` (SQL pages through the parts), laying the indexed title over the first 256 bytes as `readTextFrom` does; a backend without it is read whole. Loading, `scanLines`, and copying a session's subagent transcripts (`copyTranscriptTree`, which appends each chunk through a writer) read through it.
- Local appends and publication share a cross-process publish lock. A changed byte size raises `SessionWriteConflictError`; lock contention raises `SessionLockError` without publishing the staged rewrite. This is not a content-hash comparison and cannot protect against non-cooperating external writers.
- `FileSessionStorage` holds a process-owned OS lease on each session a process writes, keyed by the session id rather than the file's path, so every process that reaches one journal (through a symlink, a hard link, or after a move) meets the same lease. The lease is `pi-utils` `tryAcquireFileLock` on `<session-owners>/<session-id>`, where `<session-owners>` is `~/.omp/run/session-owners` (XDG: `$XDG_STATE_HOME/omp/run/session-owners`), shared across profiles: on Linux an abstract socket and on Windows a named mutex, neither of which creates a file; on macOS and other non-Linux Unix a `flock` on a sidecar in that directory. Only write paths claim it, so the first process to write a session owns it; opening a session to inspect it (`omp share`, `--export`, `render`) never does. Managers in one process share the lease; it is released on close or a session switch, and the kernel drops it when its process exits. Processes with different home or state directories do not meet in this lease. A plain copy of a session file keeps its id, so a process writing the copy while the original's writer is live moves to a sibling; a collab guest's replica takes its own id (`parentSession` is the host's) so it never contends with the host.
- A process never writes a session whose lease another live process holds: its first write moves the session to a fresh sibling `<timestamp>_<new-session-id>.jsonl` in the same directory, publishes the whole in-memory transcript there once, and continues appending incrementally. The owner's file is left untouched. Like `fork`, the sibling gets a new session id with `parentSession` pointing at the old one and keeps the provider prompt-cache key, so resume-by-id, the title index, and the picker never see two files for one id. The artifacts directory is copied in the background without overwriting files the moved session has already written; its artifact manager waits for the copy before allocating ids or resolving `artifact://`, and `flush()`/`close()` await it. `local://` and `agent://` reads that bypass the artifact manager can miss pre-move files until the copy finishes.
- `moveTo()` refuses, before anything moves or any directory is created, to move a session another live process writes or to replace a destination file whose session (by its header id) another live process writes.
- Another program can check ownership without claiming: `isSessionLeaseHeld(sessionId)`, `omp session lease --json -- <id>...` (`{"held": [...], "unknown": [...]}`), and RPC `get_session_lease` observe the lease without taking or opening it (a connect probe on Linux, `F_GETLK` on other Unix, a `\BaseNamedObjects` directory listing on Windows), so they never make a concurrent claim fork the session.
- Under `bun test`, the lease directory is `<os temp>/omp-test-session-owners-<uid>` instead of the real state directory. It is exported as `PI_TEST_SESSION_OWNERS_DIR` when `session-storage` loads; a test that spawns an omp process which writes sessions must pass `env: process.env` (Bun's default is the launch environment), or run under `ci-test-ts`, whose children inherit `PI_TEST_RUNTIME=1` and derive the same directory.
- On the file and memory backends, a `SessionWriteConflictError` on durable bytes during a full rewrite means a writer without the lease (an older omp, an external tool) changed the file. The manager reads it back, keeps the entries it lacks as a side branch (the active leaf stays its own), and retries against the size it read, up to three times per rewrite. If that writer changes the file inside every retry, the session leaves the file to it and moves to a sibling (`reason: "contested"`) rather than re-serializing the transcript on every later write. A deleted file is recreated; a file that no longer reads as this session is left untouched and the session moves to a sibling. Indexed backends keep reporting the conflict, since there it can be the manager racing its own unconfirmed publish.
- `appendEntriesAtomically()` groups a synchronous callback's appends into one atomic publication. Failure rolls back staged entries and repairs retained concurrent work.
- Rewrites serve renames, entry rewrites, migrations/sanitization, move/fork, and recovery. Session-title changes normally update the fixed-width title slot and append a `title_change` audit entry instead of rewriting the body.

### Error behavior

- Ordinary append failures are latched and logged once with session-file context rather than thrown into the turn loop. Later appends may retry the complete in-memory journal; `flush()`/`flushSync()` and close surface unresolved failures.
- `onPersistenceNotice` reports a session moving to a sibling file as a `SessionPersistenceNotice` (`reason`, `from`, `to`); it latches nothing and never reaches `onPersistenceError`. Every notice raised so far is replayed to each new subscriber, like a latched failure. Interactive mode shows it as a warning, print mode on stderr, RPC as a `warning` notice frame, each with home-relative paths.
- Atomic batch and recovery paths attempt authoritative repair. If publication may have happened and repair cannot be proven durable, `SessionPersistenceIndeterminateError` fails closed with the original and recovery errors.
- Writer close propagates the first meaningful error. Final disposal seals the manager, making late appends/rewrites no-ops, then releases retained entries so a disposed manager cannot overwrite a revived transcript.

## Data Size Controls and Blob Externalization

Before persisting entries:

- Strings over 500,000 characters are truncated with `"[Session persistence truncated large content]"`, except signed/encrypted provider blocks, signature fields, validated Anthropic native web/tool-search history blocks, Anthropic server-compaction replay carriers, and Cursor server records (`cursorHistory` payloads), which must remain byte-exact for replay.
- Transient `jsonlEvents` is removed.
- If an object has both string `content` and numeric `lineCount`, line count is recomputed after truncation.
- Image data URLs in `image_url` fields are always content-addressed in the blob store and replaced with `blob:sha256:<hash>`, regardless of length. Base64 payloads at least 1,024 characters are externalized in image `content` blocks, `images[]`, snapcompact `frames[]`, and image-generation results.
- Redundant OpenAI Responses `thinkingSignature` copies are omitted when the authoritative reasoning item already exists in `providerPayload`.
- Spilled MCP tool results omit duplicate `details.structuredContent` when the rendered structured output already lives in their truncation artifact.

These projections leave the live entries unchanged. On load, ordinary persisted image references are resolved back to inline payloads. Snapcompact frames stay lazy until context reconstruction selects them. Archives with frames truncated by older persistence code fall back to their retained text or undamaged frames.

## Storage Abstractions

`SessionStorage` owns filesystem-like operations used by `SessionManager`: synchronous directory/existence/write/stat/list operations; async read, sliced read, write, guarded atomic write, rename, unlink, artifact-aware deletion, title update, writer creation, and backend drain. Optional capabilities include synchronous reads, chunked reads (`readChunks`), streamed full writes (`writeLinesSync`, `writeLinesAtomic`), confirmed remote writes, assistant-turn scans, file locking, session ownership claims, and conditional artifact-aware deletion.

An `IndexedSessionStorage` backend (`SessionStorageBackend`, for an SDK's own store) implements `readFull`, `readSlices`, `writeFull`, `append`, `updateSessionTitle`, `truncate`, `remove`, and `move`, and may implement `readFrom`, `readChunks(path, fromByte)` (the stored bytes as chunks; rejects with ENOENT for a missing path), and `writeFullStream(path, chunks, byteLength, mtimeMs, title, expectedSize)` (a `writeFull` whose body arrives as UTF-8 chunks, with the same size check). Without the last two, reads and full rewrites hold the whole transcript in memory.

Implementations and adapters:

- `FileSessionStorage`: real local files
- `MemorySessionStorage`: map/chunk-backed in-memory storage for non-persistent sessions and tests
- `IndexedSessionStorage`: shared local index plus ordered remote publication used by Redis/SQL-backed storage
- `SqlSessionStorage`: a PostgreSQL, MySQL, or SQLite session table (`omp_session_files`, created on first use) keyed by the same path string a file session would have, with each session's content in a `<table>_parts` table (see [SQL session storage](#sql-session-storage))

`SessionStorageWriter` exposes `append`, optional `appendSync`, `flush`, optional `flushSync`, `isOpen`, `close`, and `getError`.

### Selecting the storage

The root command (interactive, print, RPC and ACP modes, and `omp join`) resolves one process-wide default storage at start-up (`resolveSessionStorage` in `session-storage-config.ts`, installed with `setDefaultSessionStorage`) before it opens any session; every `SessionManager` factory, `resolveResumableSession`, the session picker, recent-session listing, the session archive's listing and lookup by id, and the subagent transcript discovery behind `/export` and `/dump all` fall back to `defaultSessionStorage()` when no storage is passed, so a session written to SQL is found by `--resume`, `--continue`, the picker, and the archive, and exports with its subagents, without a second path. `--export` and `omp share` read a session without reaching that install, so each resolves and installs the same storage itself first. `omp gc`'s blob sweep resolves `session.storage` the same way at maintenance time so it can discover a SQL-only session's blob references; its archive and WAL sweeps are unrelated to the transcript backend and stay on-disk-tree-only. The other subcommands never install the configured storage and still use the JSONL tree: `omp render` and session-id shell completion read sessions there, `omp stats` counts usage only from transcripts there (so SQL-stored sessions are not counted), and `omp cleanse` and `omp compress` write their own sessions there.

- `session.storage: file` (default) — the JSONL tree above; nothing is read or logged.
- `session.storage: sql` — read the file `session.sql.dsnFile` names, trim it, open it with `Bun.SQL` (dialect from the URL scheme: `postgres://`, `mysql://`, `sqlite:`), and `await SqlSessionStorage.create({ client })`, which creates both tables (migrating an older session table) and warms the index. `OMP_SESSION_STORAGE` and `OMP_SESSION_SQL_DSN_FILE` take precedence over both settings.
- SQL-backed sessions run subagents inline on the main thread until a session-storage service for workers exists; `task.workerThreads` does not offload their runs, follow-up turns, or revivals. File-backed sessions keep worker placement.
- For PostgreSQL and MySQL, an omp-created SQL client holds at most two connections and returns idle connections after five seconds. The next session operation reconnects if needed. This pool policy is built in; callers using `SqlSessionStorage` directly keep control of their own client.
- Resume takes the same value as today, `--resume=<session path>`: under SQL that string is the row's `path` key, and it embeds the home-relative sessions root, so the resuming process needs the same storage variables and the same home directory.
- Refusals (exit 1, message on stderr, never a fallback to files): `sql` with no file named anywhere names both `OMP_SESSION_SQL_DSN_FILE` and `session.sql.dsnFile`; a missing or unreadable file — `<source> names <path>, which could not be read: <reason>`; a blank file — `<source> names <path>, which is empty`; an unreachable database — `<source> names <path>, but the session database could not be opened: <driver error> (<code>)`; any other storage value — `<source> is "<value>"; expected "file" or "sql"`. `<source>` is the variable or setting that supplied the value; the connection string itself is never printed.
- Tool artifacts and image blobs stay under the agent directory on local disk in either mode; only the transcript moves. `omp gc`'s archive and WAL sweeps keep working on that on-disk tree; the blob sweep also reads a SQL-only session's transcript straight from the table so it never deletes a blob that transcript still references.
- Joining a collab session (`/join`) needs file storage: the guest's replica of the host session is a local file, so under `sql` the join refuses with an error naming `session.storage` rather than resuming an empty session.
- The resume picker's F2 rename reads and writes the session through the configured storage, and first claims the session, holding the claim until the title is written: under file storage it takes the session's ownership lease, and under `sql` it waits for the database's answer to a claim (`acquireSessionClaim`). A session another process holds is left alone: the rename fails with a message that the session is in use by another omp process (the session this process has open) or that it is in use or no longer available (any other session). A storage that claims nothing, such as an SDK store built without `claims`, has no other holder to refuse for, so the rename does not check.
- These features work only on the JSONL tree. Under `sql` each refuses with `<feature> is unavailable with session.storage: sql: <reason>` instead of acting on an empty tree:
   - `omp gc --compress` (or `gc.compress`) and the background `gc.autoCompress` run compress session files in place on disk. `omp gc` skips the compress and archive steps and runs the others; `gc.autoCompress` writes the refusal to `gc-auto-compress.log` and does not start.
   - `omp stats`, `/stats`, `/trace` and the `/usage` activity heatmap read session files. `/usage` still shows provider quotas.
   - `omp session lease` and RPC `get_session_lease` probe the file ownership lease, which a SQL-backed session never takes. `omp session pack`, `unpack`, and `moved` work only on session files on disk.
- `omp cleanse`, `omp compress` and session completion (`omp __complete sessions`) read the configured storage.
- The debug menu's "Clear artifact cache" removes tool output files (`<id>.<tool>.log`) older than 30 days from the sessions' artifacts directories, in both storages. Nothing else there is removed: not transcripts or their sidecars, subagent outputs, `/btw` conversations or drafts, and never a session or project directory. It does not follow a directory replaced by a symlink, and leaves a file replaced since it was listed.
- Resume forks a session that `omp session moved` marked as moved away (`forkIfMovedAway`). Only a session file can carry that mark, so a SQL-stored session always resumes in place.

### SQL session storage

`SqlSessionStorage` (`sql-session-storage.ts`) keeps sessions in PostgreSQL, MySQL/MariaDB, or SQLite through `bun:sql`, in two tables, and on PostgreSQL and MySQL a third:

- `<table>` (default `omp_session_files`): one row per session file with `path`, `content`, `mtime_ms`, the title fields, and `byte_len`, the session's size in UTF-8 bytes.
- `<table>_parts`: the session's content as parts keyed by (`path`, `start_offset`), where `start_offset` is the part's byte offset in the session.
- The lease table (option `leaseTable`, default `omp_session_leases`): one row per claimed session with `session_id`, `holder` (a random token of the store that holds it), `host`, `pid`, `acquired_at`, and `heartbeat_at`, both times in milliseconds since the epoch on the database's clock. Rows are keyed by session id, and session ids are UUIDs, so stores with different session tables can share one lease table.

A session's content is its row's `content` followed by its parts in `start_offset` order. `content` is non-empty only on rows written before parts existed, until the session's next full write.

- An append is one transaction: it adds the line's byte length to `byte_len`, which takes the session row's lock, and inserts the line as a part at the old length. Concurrent writers serialize on that lock, and an append writes only the appended bytes.
- A full write (rewrite, size-checked replace, create-if-missing, truncate) is one transaction that locks the row, compares `byte_len` with the expected size, empties `content`, and replaces the parts with parts of at most 1 MiB split on UTF-8 character boundaries. No stored value grows past 1 MiB or the longest appended line, so sessions stay clear of PostgreSQL's 1 GB field limit.
- A session's full rewrite arrives as a stream (`writeFullStream`) and is staged: its parts, cut the same way, go in under the staging path `<path>#staging-<epoch ms, 13 digits>-<id>`, 16 parts per transaction, and one last transaction locks the row and checks `byte_len`, checks that the staging parts still hold every byte (a staging set another writer deleted is refused with `SessionWriteConflictError`), deletes the session's parts, renames the staging parts to the session (`UPDATE <table>_parts SET path = <path> WHERE path = <staging path>`), and sets the row's `content` to `''` and its `byte_len`. Staging parts have no session row, so no listing or index warm-up sees them. A failed write deletes its own staging parts, and each staged write first deletes its path's staging sets more than an hour old, which only a killed writer leaves. Deleting a path deletes all of its staging sets, whatever their age, and a rename deletes those of the source and of a destination it replaces, each in the same transaction as the parts. These deletions are a primary-key range from `<path>#staging-` up to an epoch (the cutoff, or the largest 13-digit one), which code-point and locale collations alike order by the epoch's digits, and the prefix is also compared character by character, so a deletion never reaches another path's parts.
- Delete and rename remove or move the row and its parts, and delete the path's staging sets, in one transaction. Warming the index reads session rows only; a sliced read fetches only the bytes of the parts covering its head and tail windows, and a read from an offset (`readTextFrom`) only the session's size and the bytes of the parts covering `[offset, offset + maxBytes)`, each in one query whatever the part count.
- A whole read streams (`readChunks`): the row's own `content` when it has any, then the parts four at a time by keyset (`start_offset >= <next> ORDER BY start_offset LIMIT 4`), each part its own chunk, so no query returns more than four parts. The read stops at the size its first query saw. A part that does not start where the last one ended, or parts that end short, mean a full write or delete replaced the session during the read, and the read fails instead of returning a mix of two bodies.
- `moveTo()` refreshes the store before it checks the destination. A store that claims sessions claims the session the destination holds, and refuses when another live process holds it; a store that does not claim refuses a destination that holds any session, a copy of the moving session included, because another process may have it open. It moves the session and every row under its artifacts directory with a rename that never replaces (`renameNoReplace`): one `UPDATE … SET path` whose primary key rejects a destination row that exists, or that another client inserts during the move. The transaction then rolls back, the rows already moved go back (a key written at an old path since is kept, and the move reports the failed rollback), and the move fails with `SessionMoveRefusedError` naming the taken key. Redis storage does the same check, rename, mtime and title update in one script.
- Deleting a session removes its row and, in the same transaction, every row whose path starts with its artifacts directory (`substr(path, 1, n)`, so `%` and `_` stay literal) together with exactly those rows' parts, including rows another client committed after this client last refreshed, and the staging parts under that directory. PostgreSQL (a `DELETE … RETURNING` feeding the parts `DELETE`) and MySQL (a multi-table `DELETE`) delete the rows and their parts in one statement, so a child another client commits during the delete is either removed whole or kept whole, then delete the parts under the directory that have no row; SQLite's `BEGIN IMMEDIATE` keeps every other writer out meanwhile. Redis finds and deletes the keys and their metadata in one script.
- A store built with `claims: true` claims the sessions it writes, so a second live omp process that opens one moves to a sibling with a new id instead of writing the same journal. The CLI always builds it so; an SDK store built from a client alone claims nothing, as before, and neither does an in-memory SQLite database. A claim's holder token is 128 random bits per store (never the host or the pid), always sent as a bound parameter.
  - On PostgreSQL and MySQL/MariaDB a claim is a lease row. The claim inserts it, or takes it over when its `heartbeat_at` is older than the expiry (30 s, option `lease.expiryMs`) on the database clock, or more than one expiry in the future (`heartbeat_at > now + 30000`, which a login that can write the table, or a clock jump, could leave; written as an addition because the column is a `bigint` and the subtraction form overflows), in one statement on PostgreSQL (`INSERT … ON CONFLICT … DO UPDATE … WHERE`, behind a transaction-scoped advisory lock keyed by the lease table and the session id, so the same session id in two lease tables takes two locks; the table's name goes into the key folded to lower case, as PostgreSQL resolves an unquoted name, so `omp_x` and `OMP_X`, one table, take one lock) and in a `SELECT … FOR UPDATE` transaction on MySQL/MariaDB. A claim waits for another transaction's lock of the row (the holder's write in flight) at most what is left of its caller's wait, or 5 s when the caller set none, and never through session state a pooled connection would carry to another client: PostgreSQL's `lock_timeout` for the claim's transaction; on MySQL 8 and MariaDB a `FOR UPDATE NOWAIT` read, and on MariaDB the insert of a new row as `SET STATEMENT innodb_lock_wait_timeout = <s> FOR INSERT …` (whole seconds, rounded up, at most what is left of the bound). A refused `NOWAIT` read throws its whole transaction away, and the claim runs again from its start until the bound has passed; nothing of the claim runs on in a transaction the refusal ended. That matters on MariaDB with `innodb_rollback_on_timeout` ON, where a refused `NOWAIT` read (error 1205) rolls back the whole transaction, not only the statement: a statement sent after it would run on its own, holding no lock (measured on MariaDB 11.4; MySQL 8's refusal, error 3572, rolls back only the statement either way). A takeover therefore waits for a write in flight that commits within that time, and sees it; a claim that waited that long is refused, the session held by the other process, never counted as this process's own, so the 35 s an open waits holds behind a holder stalled inside a write. A store that claims sessions needs MySQL 8.0 or later, or MariaDB 10.3 or later: on an older server (MySQL 5.7 has no `NOWAIT` and no statement-scoped lock wait) `create()` refuses to start, naming the server's version; a store without claims opens there as before. Start-up then runs each lock form it picked by that version, once, on the lease table and matching no row (`FOR SHARE NOWAIT` for MySQL 8; `LOCK IN SHARE MODE NOWAIT` and `SET STATEMENT` for MariaDB), and refuses to start, naming the version and the form, on a server that rejects one: a server that reports another family's version would otherwise fail every claim and fence. On PostgreSQL a store that claims sessions or makes its tables refuses to start on a server in recovery (a hot standby or a read replica, `pg_is_in_recovery()` read in the start-up look), naming that, instead of counting claims it cannot write as held; a store that does neither opens there, as before. The store refreshes, every 10 s (`lease.heartbeatMs`), the lease rows of the sessions it still holds a live claim on, by session id, and no other row of its, and deletes its row once the claim is released and the writes queued under it have landed; `drain()` waits for that, so a clean exit frees the session at once and a killed process's session is free 30 s after its last heartbeat. The database gives that delete up after 2 s (PostgreSQL's `statement_timeout` for the delete; on MySQL 8 and MariaDB a `FOR UPDATE NOWAIT` lock of the row first, the whole delete run again from its start while that lock is refused, for that long, so no session-level setting changes), and the store stops waiting 250 ms later if the database does not answer at all; the row then expires on its own, since the heartbeat no longer refreshes it. On MySQL and MariaDB the heartbeat is two statements in no transaction (an update, then a read that takes no lock), so a lock wait timeout fails that heartbeat alone. `SessionManager.close()` releases its claim only after its last publish, so every write of a closing session meets the fence.
  - **MySQL 8 only: one case waits past the claim's bound.** MySQL bounds no `INSERT`'s lock wait without session state: `SET_VAR` does not apply to `innodb_lock_wait_timeout`, and `MAX_EXECUTION_TIME` applies only to a `SELECT` (both measured on MySQL 8.4). The case is a claim that inserts a new lease row while a write is stalled inside its transaction, between its fence and its commit, where that write comes from a store with claims on writing a session it holds no claim on (a title change or a delete of another session). That write's fence holds InnoDB's share lock on the missing row's index gap (see the next item), and an insert into the gap waits for it. The gap can hold other sessions' new rows too: with time-ordered session ids, every session started after the one written. The claim's insert waits until the write commits or rolls back, or for the server's `innodb_lock_wait_timeout` (50 s by default). At worst that is an explicit resume's 35 s wait plus that timeout, 85 s with the defaults. A claim that sets no wait (the automatic resume, or a new session's first write) waits that timeout alone, and the writes queued under it wait with it. A timeout counts as held by the other process, as every lock timeout does, so the session moves to a sibling, or the process stops under `OMP_SESSION_EXCLUSIVE=1`. It is safe: the insert lands only after the stalled write has ended, so a write whose fence found no fresh lease never lands after the claim, and two writers never share a session. MariaDB bounds the insert (`SET STATEMENT`) and PostgreSQL bounds the claim (`lock_timeout`). A store without claims, and an older omp, run no fence and take no lease lock, so they never make a claim wait.
  - Every content write (append, full write, each transaction of a staged full write (the delete of stale staging sets, each batch of staging parts, the swap, and the delete of its own staging parts after a failure), truncate, title update, delete, both paths of a rename, and every marker write, such as the draft-only marker and the draft under a session's artifacts directory) first reads, in the write's own transaction, the lease row of the session it writes: for a path this store claimed, its own row, share-locked (`FOR SHARE` on PostgreSQL, `FOR SHARE NOWAIT` on MySQL 8, `LOCK IN SHARE MODE NOWAIT` on MariaDB), refusing with `SessionLeaseLostError`, changing nothing, when the row is gone or names another holder; for any other path of a session (its file, or anything under its artifacts directory, by the `<time stamp>_<id>` name), refusing while another holder's lease of that session is fresh, after taking a shared lock a claim of that session waits for (on PostgreSQL the session's advisory lock, shared; on MySQL/MariaDB the share lock of the missing row's gap), so a claim made while such a write is open lands after it. A fence waits at most 2 s for another transaction's lock (a takeover in flight), then refuses the write the same way; on MySQL and MariaDB a refused fence read throws the write's whole transaction away and the write runs again from its start within those 2 s, so no statement of the write runs after a refusal in the transaction it ended (see the claim above for MariaDB's `innodb_rollback_on_timeout`); on PostgreSQL that bound covers the fence statements alone (the transaction's own `lock_timeout`, a client's session setting or the server's, is read as the bound is set and set back after them), so the write that follows waits as the connection says. On PostgreSQL the heartbeat commits as it runs (see "On PostgreSQL the store runs no code another login planted" below), so a fence never waits on the store's own heartbeat. A takeover's update of a row waits for a write in flight to commit, so the new holder sees it, and the old holder's later writes are refused. A takeover, a refused write, or a heartbeat that finds the row gone or another holder's marks the claim lost (only a release deletes a row, so a gone row means another holder came, wrote and released): `SessionManager` moves the session to a sibling at once and writes its whole transcript there, the refused entries included.
  - A subagent transcript under a session's artifacts directory (`<stem>/<agent>.jsonl`) is claimed under that session's lease, never under an id of its own. When the session's lease is lost and the session moves to a sibling in the same process, the transcript follows it: it moves to the same relative path under the sibling's artifacts directory once the session's artifacts are copied there, keeps its id, and publishes its whole transcript there. The process remembers such a move only while the manager that made it still runs that session: once it closes, or opens or starts another, the move is forgotten, and a transcript of the old session whose lease is lost later forks instead of following into the abandoned sibling. When the session is another process's (it holds the lease, or took it over and went on elsewhere), nothing records where it went, so the transcript forks to a session of its own beside the session's file, under a lease it takes there, whose header names the session as `parentSession` and carries no `continuationOf`, and publishes its whole transcript there, so no entry is lost. This happens under `OMP_SESSION_EXCLUSIVE=1` too: a subagent transcript's id is never the launcher's recorded one. An `OMP_SESSION_EXCLUSIVE=1` stop asks the store who holds the session for at most 2 s, so a database that stopped answering still lets the process end, without the holder's name.
  - A store that claims sessions also refuses an append onto bytes it did not write: another writer that claims nothing, such as an older omp, changed or replaced the file. `SessionManager` then reads the file back once its own queued writes have settled, keeps the other writer's new entries and publishes the whole transcript again, or moves to a sibling: `replaced` when the file now holds another session, `contested` after repeated conflicts. A full publish it queued itself (a `flushSync` publish the store confirms later) that meets such a change recovers the same way. A rewrite a caller asks for (`rewriteEntries()`) was computed from a stale view, so it still rejects with `SessionWriteConflictError` and changes nothing, on SQL as on Redis; the caller retries from a fresh load. Under `OMP_SESSION_EXCLUSIVE=1` either move ends the process non-zero instead, naming the reason.
  - A claim whose heartbeats the database has not answered for 20 s (the expiry less one interval, counted from when the last answered heartbeat was sent, however late its answer came) lapses: its writes wait, up to one expiry, for the next answered heartbeat, and nothing moves. When the database is reachable again, a heartbeat that finds the row still the store's confirms the claim; only another holder makes it lost.
  - An explicit resume (`--resume`, the session `--continue` picks, the picker's pick, and a switch, which RPC `open_session` and `switch_session` go through) takes its lease before `session_start`, waiting up to 35 s (the expiry and 5 s) for another holder's to go or expire, saying so on stderr; then it claims it and keeps the id, or moves to a new id if it is still held. The automatic resume claims the session it picks before `session_start` too, but does not wait: a start that names no session and picks none, with no `--resume` and no `--continue`, never waits, so a held session moves to a new id at once. A switch takes the lease before the manager takes the new id, so while it waits the manager still reports the session it had. After each acquire the manager reads the session again when its stored `byte_len` is not what it last loaded or wrote.
  - A move to a sibling is a fork: the sibling's header names the old id as `parentSession` and carries no `continuationOf`, so nothing points a later resume of the old id at it. An exact `--resume <id>` opens exactly that session and follows no continuation an older build recorded; the picker, `/resume` and a `--resume` prefix still follow one.
  - Under `OMP_SESSION_EXCLUSIVE=1`, which a launcher sets when it passes a recorded id, nothing moves the id: a session another process still holds after the wait, a lease taken over or gone, and a file another writer changed or replaced each end the process non-zero, naming the reason (and, for a lease, the holder's host and pid), and write no sibling, fork or continuation. A resume of such a session follows no continuation either. A `departed` entry (`omp session moved`, or one another process appended) neither forks nor stops it: the start logs the entry, naming it, and opens the session itself, writing its next turn there. So two processes can run one session id after `omp session moved`; stop the pod before moving its recorded session.
  - On a SQLite file the claim is an OS lock keyed by the database file's identity, its device and inode (so a symlink, a hard link, or another mount of the file meets the same lock), and the session id; the kernel drops it when its process dies. It needs no lease row, no heartbeat, no fence (`BEGIN IMMEDIATE` keeps every other writer out), and no wait.
  - Every claim checks first that the path holds no other session's header; a path that does is not claimed.
  - File storage claims a session at its first write, as before; SQL storage claims an opened session before the agent session starts, so a second process never runs under the held id.
- PostgreSQL and MySQL run a write again, up to five attempts, when the database aborts it as a deadlock victim; each attempt recomputes everything under its own locks. On MySQL a full write deletes a session's parts, and every write that deletes staging sets deletes them, only after a non-locking look finds some, so creating sessions at once takes no gap locks.
- On PostgreSQL every write runs in a transaction: each table-setup statement at start, an append, a full write, each transaction of a staged full write (`writeFullStream`), a title update, a delete, and a rename. The transaction's first statement is `SET TRANSACTION READ WRITE`. It then reads `setting` and `reset_val` of `default_transaction_read_only` in `pg_settings`. `setting` is the session's own value, which `SET TRANSACTION READ WRITE` does not change. `reset_val` is the default the session started from, which a session's `SET` does not change. A read-only value that a session set over a default that is off (`SET default_transaction_read_only = on`, or `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`) makes `setting` `on` and leaves `reset_val` `off`, and `SET TRANSACTION READ WRITE` overrides it. Another client of a transaction-mode pooler, such as PgBouncer, can leave such a value on a pooled connection. The store still writes on that connection, the `CREATE TABLE IF NOT EXISTS` at start included. A read-only default that the database, the role, the server or the backend connection's start parameters set, and that the session keeps, makes both `on`, and the store honours it: it refuses the write before it changes anything, with an error that names `default_transaction_read_only`. An operator, or a provider that makes a database read-only when its disk is nearly full, therefore stops the store's writes. A session that turned such a default off has `setting` `off` and `reset_val` `on`, and the store writes there, as older releases did. A transaction-mode pooler applies a client's start parameters and its `connect_query` to the backend as session `SET`s, so the store overrides them like any session value and does not honour them. An append costs five round trips (`BEGIN`, `SET TRANSACTION READ WRITE`, the `pg_settings` read, the append statement, `COMMIT`) instead of one. Reads run outside these transactions, a streamed whole read (`readChunks`) included. MySQL and SQLite do not do this, so a MySQL connection whose session default is read-only still refuses the store's writes.
- On PostgreSQL start-up first looks, in one read and outside any lock, at which of its three tables exist; that read also takes `default_transaction_read_only`'s `setting` and `reset_val`, and refuses to start on a read-only default the session keeps, as a write does. When all three tables exist, start-up takes no lock and makes nothing. Otherwise one transaction at `READ COMMITTED` makes them: after the `pg_settings` read it takes a transaction-scoped advisory lock (`pg_advisory_xact_lock`) with the store's fixed key `0x6f6d705f73657373`, decimal 8029197265931694963, looks again under it, and makes, in one round trip, each table still missing, with the `holder` index when it makes the lease table. `pg_locks` lists that lock as an `advisory` lock with `classid` 1869443167 and `objid` 1936028531, the key's high and low 32 bits. The lock ends with the transaction. Each later start-up statement (a missing column's `ALTER`, the `byte_len` backfill, the `holder` index on a lease table that was there without one) runs in its own such transaction. Stores that start at the same moment on a database without the tables therefore take turns, instead of failing with `duplicate key value violates unique constraint` or `already exists`, and stores that start on made tables never wait on one another. `READ COMMITTED` keeps a `repeatable read` default from failing the `byte_len` backfill with a serialization error after the lock wait. A store from an older Oh My Pi takes no lock, so it can still collide with a new one on such a database.
- On SQLite every store in a process runs one call at a time per database file, across all the clients of that file (keyed by the file's device and inode, so a symlink or a hard link to it shares the queue; a file that does not exist yet is created empty first, which SQLite reads as an empty database; in-memory databases, and wrappers that do not pass `options` through, queue per client), and opens every write with `BEGIN IMMEDIATE`. Clients of one file in one process therefore take turns and never wait on each other. When a client has no busy timeout, the store sets 5 s: a write then waits for another process's write lock, and if the lock is not released in time it fails at `BEGIN`, before changing anything. Keep your own transactions off a client the store uses: Bun runs each client on one connection, so the store's statements would join them.
- Deleting a session through `SessionManager` (`/delete`, the picker) on a store that claims sessions first claims it, waiting for the database, and refuses while another live process holds it.
- Table names are limited to 57 characters, so `<table>_parts` stays within the 63-character identifier limit, and the lease table's name to 56, so its index `<leaseTable>_holder` does.

With `createTable` on (the default), `create()` creates the tables when missing, the lease table and its `holder` index on PostgreSQL and MySQL included, whether or not the store claims; on PostgreSQL it looks in `pg_index` for an index of the lease table keyed by `holder` alone, under any name, and creates `<leaseTable>_holder` only when there is none and nothing else holds that name. On a session table from an older Oh My Pi it adds `byte_len`, backfills it from each row's `content` where it is null, and creates `<table>_parts`. Stop every older Oh My Pi process that writes the table before the first upgraded one starts: an older version appends to `content` without updating `byte_len`.

With `createTable: false`, `create()` runs no DDL and refuses to start, naming what is missing, until the session table has `byte_len` and `<table>_parts` exists, and, for a store that claims on PostgreSQL or MySQL, until the lease table exists; it also refuses while any row's `byte_len` is null. A store that does not claim never reads the lease table and needs none. Apply the schema in your own migration, substituting your table names for `omp_session_files` and `omp_session_leases`. A new database creates the session table with `byte_len`; an existing session table adds the column and backfills it. Both then create the parts table and the lease table.

A PostgreSQL login that owns none of the tables, such as one the tables' owner granted row access to, can open the store with `createTable` on once the tables and the index exist: every statement `create()` then runs is a read of the catalogs (it looks for the tables first and makes none that exists, so it needs no `CREATE` on the schema), or a statement it skips after looking (a missing column's `ALTER`, the `byte_len` backfill when no row lacks it, and the `holder` index, which PostgreSQL refuses to anyone but the table's owner even with `IF NOT EXISTS`). On the lease table the login needs `SELECT`, `INSERT`, `UPDATE` and `DELETE`: the fence's `FOR SHARE` needs `SELECT` and `UPDATE`, the claim's `INSERT … ON CONFLICT … DO UPDATE … RETURNING` needs `SELECT`, `INSERT` and `UPDATE`, and the release's `DELETE … WHERE` needs `SELECT` and `DELETE` (measured on PostgreSQL 16). On MySQL the lease table's index is part of its `CREATE TABLE`, so it adds no statement there; a MySQL user needs `SELECT`, `INSERT`, `UPDATE`, `DELETE` and `CREATE` on each of the three tables, since `CREATE TABLE IF NOT EXISTS` needs `CREATE` even when the table exists (measured on MySQL 8.4).

On PostgreSQL the store runs no code another login planted:

- Every transaction it opens starts with `SET LOCAL search_path = pg_catalog, pg_temp`, and every read it sends on its own (a session's content, slices or a window of it, each query of a chunked read, the index of sessions, a lease's holder) goes as one simple query, `SET LOCAL search_path = pg_catalog, pg_temp; <read>`, in whose implicit transaction the setting holds: one round trip, as before the lock. A simple query binds no values, so the read's values (paths and integers) are written into it as dollar-quoted literals whose tag they do not contain. The lease heartbeat is the one statement sent on its own outside that lock: it binds the holder token, so it cannot be a simple query, and it must commit before its answer travels back, so a slow answer never holds the lease rows' locks that the store's own next write waits for. It names every function, operator and cast it uses as `pg_catalog`'s (`OPERATOR(pg_catalog.=)`, `::pg_catalog.int8`), so the connection's `search_path` picks nothing in it; on a connection another client left read-only it runs as a locked transaction instead. Every statement names the store's tables as `public.<table>`, whatever the login's `search_path` names, so a login whose `search_path` starts with another schema meets new tables in `public`, not the ones in that schema. A function or operator another login made in `public`, an exact match for argument types where `pg_catalog` has only a match through an implicit cast (`*(numeric, integer)`, `convert_to(text, text)`, `=(oid, regclass)`), is then never picked. The connection sets nothing at start-up: PgBouncer before 1.26, in transaction mode, refuses a `search_path` startup parameter, and `SET LOCAL` ends with the transaction, so a transaction-mode pooler passes nothing on.
- `create()` refuses to start, naming the table and what it found, when one of its tables has a column the DDL below does not declare, a column of another type than declared (a type of the planter's own, whose assignment cast would run its function, is found through `pg_cast`, not the search path), a column default, a generated or identity column, a trigger, a rule, row-level security or a policy, a constraint other than a primary key, unique or not-null one, an index on an expression or with a predicate, a table inheriting from it, or is not an ordinary table; and when the lease table has no index keyed by `holder`, or the name `<leaseTable>_holder` is held by anything but such an index (an index of another table, or a table, under that name would make `CREATE INDEX IF NOT EXISTS` skip). This runs whatever `createTable` is. The store refuses every other column, not only one it would have to fill: an insert leaves the rest to their defaults, which it cannot vet without parsing them, and it reads none of them.

MySQL and SQLite need neither: an unqualified call to a built-in name always calls the built-in (MySQL notes "has the same name as a native function" when a stored function takes one, and has no `CREATE OPERATOR`), and SQLite has no SQL to define a function.

PostgreSQL:

```sql
-- New database
CREATE TABLE omp_session_files (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms BIGINT NOT NULL,
  title TEXT, title_source TEXT, title_updated_at TEXT, byte_len BIGINT);
-- Existing session table
ALTER TABLE omp_session_files ADD COLUMN byte_len BIGINT;
UPDATE omp_session_files SET byte_len = octet_length(content) WHERE byte_len IS NULL;
-- Both
CREATE TABLE omp_session_files_parts (path TEXT NOT NULL, start_offset BIGINT NOT NULL, content TEXT NOT NULL,
  PRIMARY KEY (path, start_offset));
CREATE TABLE omp_session_leases (session_id TEXT PRIMARY KEY, holder TEXT NOT NULL, host TEXT NOT NULL,
  pid BIGINT NOT NULL, acquired_at BIGINT NOT NULL, heartbeat_at BIGINT NOT NULL);
CREATE INDEX omp_session_leases_holder ON omp_session_leases (holder);
```

MySQL / MariaDB:

```sql
-- New database
CREATE TABLE omp_session_files (path VARCHAR(512) NOT NULL PRIMARY KEY, content LONGTEXT NOT NULL,
  mtime_ms BIGINT NOT NULL, title TEXT NULL, title_source VARCHAR(16) NULL, title_updated_at VARCHAR(64) NULL,
  byte_len BIGINT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
-- Existing session table
ALTER TABLE omp_session_files ADD COLUMN byte_len BIGINT NULL;
UPDATE omp_session_files SET byte_len = length(content) WHERE byte_len IS NULL;
-- Both
CREATE TABLE omp_session_files_parts (path VARCHAR(512) NOT NULL, start_offset BIGINT NOT NULL,
  content LONGTEXT NOT NULL, PRIMARY KEY (path, start_offset))
  ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE omp_session_leases (session_id VARCHAR(512) NOT NULL PRIMARY KEY, holder VARCHAR(64) NOT NULL,
  host VARCHAR(255) NOT NULL, pid BIGINT NOT NULL, acquired_at BIGINT NOT NULL, heartbeat_at BIGINT NOT NULL,
  INDEX omp_session_leases_holder (holder)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
```

SQLite:

```sql
-- New database
CREATE TABLE omp_session_files (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL,
  title TEXT, title_source TEXT, title_updated_at TEXT, byte_len INTEGER);
-- Existing session table
ALTER TABLE omp_session_files ADD COLUMN byte_len INTEGER;
UPDATE omp_session_files SET byte_len = length(cast(content AS blob)) WHERE byte_len IS NULL;
-- Both
CREATE TABLE omp_session_files_parts (path TEXT NOT NULL, start_offset INTEGER NOT NULL, content TEXT NOT NULL,
  PRIMARY KEY (path, start_offset));
```

Before running an older Oh My Pi against the tables, roll back. Stop the newer processes first. The statements fold each session's parts into its row's `content`, then delete the parts of, and clear `byte_len` on, only those rows whose `content` now measures `byte_len`. A session whose fold failed keeps its parts and `byte_len`, so this version still reads it whole, even when the client carries on past an error.

A session cannot be folded when its content exceeds the older version's single-value limit: 1 GB on PostgreSQL, `max_allowed_packet` on MySQL (64 MiB by default on MySQL 8, 4 MiB on 5.7, at most 1 GB), and `SQLITE_MAX_LENGTH` on SQLite (1,000,000,000 bytes by default). On PostgreSQL, on SQLite, and on MySQL in strict mode (the default), one such session makes the whole fold statement fail, so nothing is folded until that session is removed or the limit is raised.

```sql
-- PostgreSQL
BEGIN;
UPDATE omp_session_files AS s SET content = s.content || p.content
FROM (SELECT path, string_agg(content, '' ORDER BY start_offset) AS content
      FROM omp_session_files_parts GROUP BY path) AS p
WHERE p.path = s.path;
DELETE FROM omp_session_files_parts
WHERE path IN (SELECT path FROM omp_session_files WHERE octet_length(content) = byte_len);
UPDATE omp_session_files SET byte_len = NULL WHERE octet_length(content) = byte_len;
COMMIT;

-- MySQL / MariaDB (GROUP_CONCAT truncates at group_concat_max_len, 1024 bytes by default)
SET SESSION group_concat_max_len = 18446744073709551615;
START TRANSACTION;
UPDATE omp_session_files AS s
JOIN (SELECT path, GROUP_CONCAT(content ORDER BY start_offset SEPARATOR '') AS content
      FROM omp_session_files_parts GROUP BY path) AS p ON p.path = s.path
SET s.content = CONCAT(s.content, p.content)
WHERE length(CONCAT(s.content, p.content)) = s.byte_len;
DELETE FROM omp_session_files_parts
WHERE path IN (SELECT path FROM omp_session_files WHERE length(content) = byte_len);
UPDATE omp_session_files SET byte_len = NULL WHERE length(content) = byte_len;
COMMIT;

-- SQLite 3.44 or later
BEGIN;
UPDATE omp_session_files SET content = content || (
  SELECT string_agg(content, '' ORDER BY start_offset) FROM omp_session_files_parts AS p
  WHERE p.path = omp_session_files.path)
WHERE path IN (SELECT path FROM omp_session_files_parts);
DELETE FROM omp_session_files_parts
WHERE path IN (SELECT path FROM omp_session_files WHERE length(cast(content AS blob)) = byte_len);
UPDATE omp_session_files SET byte_len = NULL WHERE length(cast(content AS blob)) = byte_len;
COMMIT;
```

### Manual storage maintenance

`omp gc` previews maintenance by default; `--apply` is required to sweep unreferenced blobs, archive eligible cold sessions, checkpoint database WALs, or prune stale state. Storage maintenance is separate from model-context compaction.

The sessions phase also removes transcript rewrite temps (`.<name>.jsonl.<snowflake>.tmp`, and the same pattern beside registered `--session` files) once they are past the 5-minute write grace. A live rewrite renames its temp into place within milliseconds, so an older one was left by a killed or crashed writer.

The stale-state phase is opt-in: it runs only with `--stale` or when `gc.stale` is enabled (default off), so an unqualified `omp gc --apply` never deletes reports or replicas. It removes `custom-session-files` markers and terminal breadcrumbs whose session file no longer exists once they are a day old (a lazy session's marker names a transcript that is written only on its first turn). A breadcrumb recorded as a fresh `/new` boundary is always kept: `--continue` honors it before its transcript exists, and it is rewritten when the session materializes or replaced by the terminal's next session. For the default agent dir — or a custom agent dir named `agent`, whose parent is treated as the config root — it also expires debug report bundles (`reports/*.tar.gz`) and collab guest replicas (`collab/*.jsonl` plus their artifact directories and custom-session marker) that are both outside the newest `gc.staleRetainNewest` (default 20) and older than `gc.staleRetainDays` (default 30). A replica that a terminal breadcrumb points at, or that a running guest holds open, is kept. Stale state is pruned before the blob sweep, so blobs referenced only by an expired replica are swept in the same run.

The compress phase is opt-in as well: `--compress` or `gc.compress` (default off). It stores every file of a session (the transcript and its artifact tree) with the filesystem's transparent compression once the transcript has been idle for `gc.compressAfterDays` (default 7, `--compress-after-days`); files written more recently are skipped. Session ownership leases are taken only for sessions with files left to compress: a session is skipped while a running process holds the lease of its transcript or of any transcript nested in its artifact tree (subagent sessions, recognized by their session header whatever their file name), and those leases are held while its files are rewritten. Unlike archiving, a session with an interrupted last turn qualifies, since it stays resumable. Paths, bytes, and mtimes are unchanged and no history or stats rows are deleted, so compressed sessions stay listed, resumable, and searchable. A regular file with a single link that spans more than one filesystem block qualifies; already-compressed formats (`.gz`, `.zst`, images) are skipped. The volume holding the sessions root decides the method:

- **APFS (macOS):** detected by matching the directory's device against `apfs` entries in the mount table. `ditto --hfsCompression` writes compressed copies, with the original mtime to the nanosecond, into a fresh `.omp-gc-compress-XXXXXX` scratch directory beside the originals that holds an owner marker. A copy replaces its original only when its size and SHA-256 match and it allocates less space; immediately before the rename, the original's inode, size, and mtime must still match their values at selection and it must still have a single link, and a transcript's check and rename run under the session publish lock that serializes appends. A scratch directory left by a killed run is removed by the next `--compress --apply` run, under the sessions root and the archive root; a directory with that name and no owner marker is removed only when empty. Stats sync and the dashboard watcher skip `.omp-gc-compress-*` directories, so they never ingest a scratch copy. The replaced file is a new inode, so the next stats sync re-reads each compressed transcript once from the start; it replaces the session's rows rather than duplicating them. Appending to a compressed file stores it uncompressed again, which a later run picks up.
- **NTFS (Windows):** detected with `GetVolumeInformationW`, which must report NTFS with per-file compression support. `compact /c` sets LZNT1 compression on each file in place, keeping its inode and timestamps; later appends are stored compressed too. WOF (`compact /exe`) is not used because a write inflates the whole file.

Other filesystems report the phase as unsupported.

The strip phase is opt-in too: `--strip` or `gc.strip` (default off). Providers return state only they can read back, which omp persists so a resumed turn replays natively: signed and encrypted reasoning, the verbatim wire response kept for prompt caching, request controls, uploaded-file references. Once a transcript has been idle for `gc.stripAfterDays` (default 30, `--strip-after-days`), past every provider's cache and response retention, the phase rewrites it without that state: incremental OpenAI Responses histories, Cursor and Gemini native histories, `requestControls`, `inputTransformations`, opaque `thinkingSignature`s, `itemId`s, `redactedThinking` blocks, tool-call `thoughtSignature`s and leftover streaming state, and image `providerFile` references. Each turn then reads like one recorded by another model, which every provider already replays (reasoning as plain text, or not at all). The latest replay turn keeps everything: its run of assistant responses joined by tool results, which a provider replays as one assistant message and validates as a unit, since a resumed tool loop must replay every one of those responses' reasoning unmodified. State with no copy elsewhere also stays: reasoning source markers (`reasoning_content`), text signatures (OpenAI message phase), Anthropic message controls and native compaction blocks, OpenAI snapshot histories, and compaction entries (an OpenAI remote compaction's stored summary is only a placeholder for its encrypted history). It covers each session's transcript and the subagent transcripts in its artifact tree, under the same ownership-lease rules as compression, and archived `.jsonl.gz` sessions, which are recompressed. Lines without replay data keep their bytes, the title slot included, and the transcript keeps its mtime, so session ordering is unchanged; the stats database reparses a rewritten transcript once. The phase runs before archiving and compression so both store the stripped transcripts.

To compress without running the command, enable `gc.autoCompress` (default off). Once an interactive session has painted its first frame, omp starts a detached `omp gc --compress --apply` at low CPU priority when the last background run is at least a day old and the sessions directory supports compression. Support is checked by compressing a throwaway probe file in the sessions directory, so a volume whose compressor stores files uncompressed (macOS 27's `ditto --hfsCompression`, #16244) is not copied and hashed every day; when the check fails, `gc-auto-compress.log` records why and the next check is a day later. Launches claim the run under an OS lock keyed on the log and recheck the interval while holding it, so simultaneous launches start one child. The child outlives the launching session, writes its summary to `gc-auto-compress.log` in the agent dir, and that file's mtime marks the last run; a spawn that fails removes the log so the next launch retries. The child takes `gc.lock` like any other gc run, so a run that finds gc already running exits with that error in the log and is retried a day later. A file that compresses but does not shrink stays a candidate and is copied again on later runs. Print, RPC, and ACP launches never start it.

Journal payload I/O is streamed during blob-reference scans, archive history/stats reconciliation, gzip creation, and rollback. Active `.jsonl`, recoverable `.jsonl.*.bak`, and archived `.jsonl.gz` records all participate in reference discovery, including references in malformed JSON text. Compressed scans drain and validate the complete stream before their results can authorize deletion. Archives retain the original JSONL bytes when decompressed (less any replay data the strip phase removed), and artifact trees keep their existing layout.

Streaming avoids materializing a whole journal; it does not make GC constant-memory. A single long record, reference sets, and history/stats identity collections still consume memory. Original files and temporary compressed output also coexist during archive publication.

## Session Discovery Utilities

Discovery helpers live in `session-listing.ts`; `SessionManager` exposes project-scoped wrappers:

- `getRecentSessions(sessionDir, limit?)` -> lightweight welcome metadata, default limit 4
- `findMostRecentSession(sessionDir)` -> newest by mtime
- `findMostRecentNonEmptySession(sessionDir)` -> newest resumable content, used by `continueRecent`
- `listSessions(sessionDir, storage)` / `SessionManager.list(...)` -> project scope with lifecycle status
- `listSessionsReadOnly(...)` -> same metadata without backup recovery
- `listAllSessions(storage)` / `SessionManager.listAll()` -> project buckets under the managed sessions root, not arbitrary custom directories
- `SessionManager.listForPicker(...)` / `listAllForPicker()` -> pinned-first lists with untitled, prompt-less zero-turn stubs removed; pinned stubs remain selectable
- `resolveResumableSession(...)` -> local lookup then optional global fallback

`getRecentSessions()` sorts file stats and first looks up titles in `history.db`'s `session_titles` index; unindexed files fall back to content scanning and backfill their title. `findMostRecentSession()` reads a 4 KiB prefix. Status-enabled full/non-empty scans read that prefix plus a bounded 32 KiB tail. Scans are stat-keyed and cached; large full lists use bounded parallel workers. Normal per-directory scans also recover the newest orphaned EPERM backup when its primary JSONL is missing.

`SessionManager.list()`/`listAll()` sort pinned sessions first; raw listing helpers sort newest first. Empty filtering is picker/continue-specific, not applied to id lookup or maintenance. Resume matching is case-insensitive and accepts session id prefixes, full filename prefixes, or the id suffix after the timestamp. Explicit `sessionDir` disables global fallback unless `allowGlobalFallback: true` is requested.

## Related but Distinct: Prompt History Storage

`HistoryStorage` (`history-storage.ts`) is a separate SQLite subsystem for prompt recall/search, not session replay.

- DB: `~/.omp/agent/history.db`
- Table: `history(id, prompt, created_at, cwd, session_id, use_count)`, with unique `prompt`
- FTS5 index: `history_fts`; new prompts are indexed by an insert trigger
- Normalizes line endings and surrounding/trailing whitespace, then deduplicates prompts across the database
- Resubmission updates the latest timestamp/cwd/session provenance and increments `use_count`
- `add()` writes synchronously before returning its resolved promise; failures are logged rather than thrown
- The same DB also contains independent `session_titles` and append-only `session_recaps` tables. Idle recaps do not enter the session JSONL or model context.

Use session files for conversation graph/state replay; use `HistoryStorage` for prompt history UX.
