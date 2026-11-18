# Compaction and Branch Summaries

Compaction and branch summaries are the two mechanisms that keep long sessions usable without losing prior work context.

- **Compaction** rewrites old history into a summary on the current branch.
- **Branch summary** captures abandoned branch context during `/tree` navigation.

Both are persisted as session entries and converted back into user-context messages when rebuilding LLM input.

## Key implementation files

- `packages/agent/src/compaction/compaction.ts` (context-full summarization and handoff generation)
- `packages/snapcompact/src/snapcompact.ts` (snapcompact strategy: history archived as dense bitmap images)
- `packages/agent/src/compaction/branch-summarization.ts`
- `packages/agent/src/compaction/pruning.ts`
- `packages/agent/src/compaction/compaction-v2-streaming.ts` (provider-native streaming compaction)
- `packages/agent/src/compaction/shake.ts` (mechanical content elision)
- `packages/agent/src/compaction/cut-rule.ts` (whether an automatic cut runs now or waits for the prompt cache)
- `packages/agent/src/compaction/utils.ts`
- `packages/agent/src/compaction/openai.ts`
- `packages/agent/src/compaction/messages.ts` (shared LLM conversion and summary wrappers)
- `packages/coding-agent/src/session/session-context.ts` (context and transcript assembly)
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/session-maintenance.ts` (automatic maintenance orchestration)
- `packages/coding-agent/src/session/messages.ts`
- `packages/coding-agent/src/extensibility/hooks/types.ts`
- `packages/coding-agent/src/session/context-settings.ts` (`compaction.*`, `snapcompact.*`, `branchSummary.*` definitions)

## Session entry model

Compaction and branch summaries are first-class session entries, not plain assistant/user messages.

- `CompactionEntry`
   - `type: "compaction"`
   - `summary`, optional `shortSummary`
   - `firstKeptEntryId` (compaction boundary)
   - `tokensBefore`
   - optional `details`, `preserveData`, `fromExtension`
   - optional `method`, `tokensAfter`, `warning` (maintenance/display metadata)
   - optional `providerReplayThroughEntryId` (last entry covered by a native replay snapshot)
- `BranchSummaryEntry`
   - `type: "branch_summary"`
   - `fromId`, `summary`
   - optional `details`, `fromExtension`

When context is rebuilt (`buildSessionContext`):

1. The latest compaction on the active path that `options.model` can read (any compaction when the option is omitted, and always for transcripts; see below) is converted to one `compactionSummary` message.
2. Kept entries from `firstKeptEntryId` to the compaction point are re-included.
3. Later entries on the path are appended.
4. `branch_summary` entries are converted to `branchSummary` messages.
5. `custom_message` entries are converted to `custom` messages.

Those custom roles are then transformed into LLM-facing messages in `convertToLlm()`: `compactionSummary` and `branchSummary` become user messages rendered through the static templates

- `packages/agent/src/compaction/prompts/compaction-summary-context.md`
- `packages/agent/src/compaction/prompts/branch-summary-context.md`
- `packages/agent/src/compaction/prompts/handoff-summary-context.md` (when `method === "handoff"`)

Snapcompact summaries with ordered archive blocks bypass these wrappers and send the lead-in plus archive blocks directly. `custom` messages normally pass through as developer messages with their raw content (no summary template).

Native replay also requires a matching provider and a Responses-family API on the active model. A separate native compaction endpoint does not give a Chat Completions or Anthropic encoder the ability to consume its output.

Disabling future native compaction does not disable normal replay of an existing payload. Compaction preparation has a separate, stricter reuse policy: local summarization must re-expand the original messages rather than treat an opaque placeholder as a readable summary.

The LLM context is built for the model that reads it. When the active model cannot replay the latest OpenAI payload (another provider, including `openai` ↔ `openai-codex`), the context stands on the newest compaction it can read and carries the raw history behind the unreadable one; a model switch rebuilds the agent's messages when the two models stand on different boundaries. The pre-prompt threshold then measures that history, so a target whose window cannot hold it compacts before its first request. Retry fallback and context promotion judge a candidate's window against the context that candidate would read, and a compact-first switch (`/switch`, Alt+P, plan approval) skips a native method whose payload the target cannot replay.

## Compaction pipeline

### Triggers

Compaction/context maintenance can run in six ways:

1. **Manual context compaction**: `/compact [instructions]` calls `AgentSession.compact(...)`.
2. **Automatic overflow recovery**: after a same-model assistant error that matches context overflow.
3. **Automatic incomplete-output recovery**: after a same-model assistant message ends with `stopReason === "length"` (including OpenAI/Codex `response.incomplete` and Anthropic output/context limits), subject to the output-cap checks below.
4. **Automatic threshold maintenance**: after a successful turn when context exceeds the resolved threshold.
5. **Mid-turn threshold maintenance**: before the next provider request when a tool-loop turn crosses the threshold and `compaction.midTurnEnabled !== false`. Subagent sessions always run this check: `createSubagentSettings` pins `compaction.midTurnEnabled` on for the child because a whole assignment is one turn, so post-turn maintenance would only fire after the run already ended.
6. **Idle maintenance**: `runIdleCompaction()` can invoke the same auto-maintenance path with reason `"idle"`.

### ACP notifications

ACP sessions forward automatic maintenance as JSON-RPC extension notifications:

| Method | Params |
| --- | --- |
| `_omp/compaction/start` | `sessionId`, `reason`, `action` |
| `_omp/compaction/end` | `sessionId`, `action`, `aborted`, `willRetry`, optional `skipped`, `errorMessage`, `tokensBefore` |

Clients that do not implement them can ignore them.

### Compaction shape (visual)

```text
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9      10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

### Overflow/incomplete recovery vs threshold/idle maintenance

The automatic paths are intentionally different:

- **Overflow recovery**
   - Trigger: current-model assistant error is detected as context overflow and the error is not older than the latest compaction.
   - The failing assistant error message is removed from active agent state before retry.
   - Context promotion is tried first; if a configured larger model is available, the agent switches model and retries without compacting.
   - If promotion is unavailable and compaction is enabled, automatic maintenance walks `compaction.methodOrder` with `reason: "overflow"` and `willRetry: true`; handoff is skipped because its request would reuse the overflowing input.
   - On success, `agent.continue()` is scheduled to retry the turn.

- **Incomplete-output recovery**
   - Trigger: same-model assistant message ends with `stopReason === "length"` and the message is not older than the latest compaction.
   - When the window is below the compaction threshold and the turn delivered text or a tool call, the truncated turn is retained and an output-limit warning is shown; compaction cannot raise the output cap.
   - Otherwise the incomplete assistant is removed from active state, and context promotion is tried first.
   - With maintenance enabled, no-output turns below threshold retry without compaction; a reasoning-only output-cap stop also receives a developer reminder to act in smaller steps.
   - Above threshold (or with an unknown window), auto maintenance walks `compaction.methodOrder` with `reason: "incomplete"` and `willRetry: true`. Unlike overflow, a reachable `handoff` may run because the input remains usable.
   - Consecutive recoveries without text or a tool call are capped at three; new user input or actionable output resets the counter. The terminal cap blocks automatic continuation and reports an actionable failure.
   - Successful recovery schedules continuation.

- **Threshold maintenance**
   - Trigger: successful, non-error assistant message whose adjusted context tokens exceed `resolveThresholdTokens(...)`. The measured count comes from `calculateContextTokens(...)`, which subtracts provider-side orchestration tokens (billable, but never replayed into the conversation prefix) so auto-compaction and context-promotion thresholds are not inflated by them.
   - Mid-turn maintenance also checks safe tool-loop boundaries before the next provider request when `compaction.midTurnEnabled !== false`.
   - The initial trigger uses adjusted provider usage floored by the stored-conversation estimate; pruning does not retroactively reduce the just-billed prompt. Reclaimed tokens affect the subsequent maintenance target. Usage predating the latest compaction is ignored in favor of the live stored estimate.
   - Context promotion is tried before post-turn compaction.
   - If promotion is unavailable, auto maintenance walks `compaction.methodOrder` with `reason: "threshold"` and `willRetry: false`.
   - Every method, `handoff` included, runs inline: post-turn maintenance generates the handoff document and commits it as a compaction entry before the run's `agent_end` settles, so the settle's `willContinue`/`yielded` reflects whether a continuation was actually scheduled.
   - On success, if `compaction.autoContinue !== false`, post-turn maintenance schedules an agent-authored developer auto-continue prompt from `prompts/system/auto-continue.md`; mid-turn maintenance never schedules a separate continuation because the core loop already owns the next provider request.

- **Idle maintenance**
   - Trigger: `runIdleCompaction()` when not streaming or already compacting; it cancels pending cache-warm refreshes first so no warm replay races the summary. The idle timer belongs to the session's idle-maintenance scheduler, which the interactive TUI enables for the session on screen (see [SDK idle maintenance](./sdk.md#idle-maintenance)). It arms once a turn has settled — nothing live, admitted, queued or scheduled, and no background job or delivery that could wake the session — while the editor holds no draft and context is at or above `compaction.idleThresholdTokens`; a draft defers it until the draft is cleared, which re-arms it with a fresh delay. When a response has confirmed a long-tier (1h, Anthropic long retention) prompt-cache entry — it read or wrote the cache — the timer fires 5s before the cache warmer's refresh point, `min(90% of TTL, TTL − 10s)` after the last request or warm hit (about 54 min), so the summary request still reads the cached prefix; a turn that settles past that point but before expiry compacts immediately. A 5-minute entry never drives the timer: it lapses too soon after a turn for compaction to be worth starting on its schedule. In that case, with an unknown lifetime, or once the entry has expired, the timer waits `compaction.idleTimeoutSeconds`.
   - Short-tier trade-off (deliberate): the fallback delay counts from the moment the turn settles while the cache lifetime counts from the request send, so with the default 300s delay an idle summary after a 5-minute entry always runs on an expired cache and pays a cold full-prefix read. This is accepted so a short break never triggers compaction; shorter `compaction.idleTimeoutSeconds` values (minimum 60s) can still land inside the entry's lifetime.
   - While the pass rewrites history, prompts, turn-starting custom messages, IRC wakes and background-result deliveries wait for it to finish and then run on the compacted context.
   - Uses `reason: "idle"` and does not auto-continue afterward.

### Payload-rejection guard

HTTP 413 / payload rejections are not automatically treated as token overflow. A known window with at least 10% locally estimated headroom and provider input usage within that window, or explicit image-limit evidence without usage-backed overflow, blocks automatic continuation and emits a payload-budget warning rather than promoting or compacting.

When provider usage proves token overflow, maintenance can still shrink context. Snapcompact is excluded for byte/media-shaped rejections unless usage proves a token overflow without explicit media-limit evidence. With an unknown window, maintenance may attempt a runnable overflow method; an unavailable or no-progress recovery blocks automatic continuation rather than resubmitting unchanged history.

### Cut rule: when an automatic cut may rewrite the cached prompt

A cut (a prune, a shake, a compaction, an image clamp) changes the prompt from its first changed position on. The next request still reads the tokens before that position from the prompt cache, but writes every token after it again. `decideContextCut()` (`packages/agent/src/compaction/cut-rule.ts`) decides whether an automatic cut runs now or waits.

Inputs:

- `P`: prompt tokens of the request the cut changes.
- `p`: tokens before the cut's first changed position.
- `s`: tokens the cut removes.
- `r` and `w`: the price of one cached token read and of one token written, at the cache lifetime the next request asks, from the model's cost data by the rule usage is billed by (`getCacheTokenPrices()` in `packages/catalog/src/models.ts`: a read at `cacheRead`; where the card prices a cache write, a one-hour write at twice the input price and a five-minute write at `cacheWrite`; where it prices none, as OpenAI's GPT cards do, a write at the input price at either lifetime, since a token such a card writes to its cache bills as input). A card that prices neither a cache read nor a cache write has no cache to keep, so both are 0 at either lifetime.
- `T`: the compaction threshold `shouldCompact` uses (`resolveThresholdTokens`). A model whose window is unknown has none: nothing compacts its context, so the tokens a cut removes are saved on every later request. `T` is then unbounded, and so is `N`: a cut that removes tokens whose reads cost anything pays.
- `g`: the mean prompt growth per main request over the last 20 main requests, at least 1 token (`meanPromptGrowth()`; a request whose prompt shrank came after a cut and is left out).
- `N = max(0, floor((T - (P - s)) / g))`: the requests until the context after the cut reaches the threshold again.
- idle: the time since the last request; life: that request's cache lifetime.

The cut is admitted when any of these holds:

1. The request cannot be served without it: `P` is over the window less the reserve, or the provider refused the request for its size.
2. idle ≥ life: the prefix has already left the cache, so the cut adds no write.
3. `N * s * r > (P - p - s) * (w - r)`: the reads the cut saves before the threshold is reached again cost more than writing the tokens after it again. A cut whose rewrite costs nothing more than its reads is admitted too (`(P - p - s) * (w - r) <= 0`: a cut at the tail, a model with no cache prices, or a write no dearer than a read).

A cut that is not admitted waits, and runs at the first later point where it is admitted: a lapse, the threshold, or a forced cut. The decision names the condition that decided it (`forced`, `lapsed`, `pays` or `waits`) and carries `N`, the saving `N * s * r` and the write cost `(P - p - s) * (w - r)`, so a caller can log why a cut ran or waited. Negative or NaN inputs count as 0.

The prunes are offered after each turn, when its reply has just refreshed the cache entry, so a prune the rule withheld there is offered again before the first request after the entry lapsed: in the maintenance before a prompt is sent, and at a tool-loop boundary when a tool ran past the entry's lifetime. That request writes the whole prompt again anyway, so the rule admits the prune (`lapsed`). The session knows only the offers its own process made: on a branch it made none on (after a restart or a resume, in another session, after a move to another branch) the prunes count as withheld, so a prune withheld before a restart runs at the resumed session's first request after the entry lapsed.

Worked figures, on claude-opus-5-5 with one-hour writes (`w` = $8 and `r` = $0.20 per million tokens, so `(w - r) / r` = 39):

- A prune of `s` = 21,500 tokens at `p` = 100,000 in a prompt of `P` = 600,000 leaves 478,500 tokens to write again, so (3) needs `N` ≥ 868. With `g` = 1,000 and `T` = 850,000, `N` = 271, and the prune waits.
- A compaction at `P` = 850,000 that keeps `p` = 30,000 tokens of tools and system prompt and sends 60,000 (`s` = 790,000, 30,000 to write again) needs `N` ≥ 2, and `N` = 790: it is admitted.

The rule governs every automatic cut: the superseded-read, useless-result and age-based tool-result prunes (`pruneSupersededToolResults`, `pruneToolOutputs`), automatic shake, the maintenance rescue's shake and image drop (`dropImages`), the request-body-timeout shake, threshold, pre-prompt, mid-run and idle compaction (and the notes-backed rollover they run when experimental context management is on), and the provider image clamps (`ProviderImageClamp.clampImageCount`, `ProviderImageClamp.clampImageBytes`). Manual `/shake` and `/compact`, a compaction an RPC client requests, and a rollover the model asks for with `new_context` are a person's, an operator's or the model's choice and are not governed by it.

In the coding agent each automatic cut asks `decideSessionContextCut()` (`packages/coding-agent/src/session/context-cut.ts`) before it changes the context, through `SessionMaintenance.admitsContextCut()`. The session supplies the inputs the cut site does not know:

- `P`: the context tokens the threshold check uses (the site's trigger figure where it has one, else the live context floored by the stored estimate).
- idle, life, and the lifetime `r` and `w` are priced at: from the prompt cache entry the next request would read, the one the status line's cache marker reports (the warmer's live entry, else the one the branch's newest cached reply left). Idle runs from the newest real or warm request that hit the entry, so a warm refresh keeps the cache counted as live; life is the lifetime the model declares for the entry's tier, else five minutes or one hour; `long` prices one-hour writes and `short` five-minute ones. Every cut counts as lapsed when the next request has no entry it can read: no reply used the cache, something the entry depends on changed since (the model, thinking level, tool set, system prompt or retention, or a compaction; the marker shows the entry cold for that reason), or the next request asks for no caching.
- `T`: `resolveThresholdTokens()` for the model's compaction settings; unbounded when the model's window is unknown.
- `g`: from the prompt sizes (input + cache read + cache write) of the recent main-loop replies on the current branch.
- forced: the site's own evidence (a provider overflow or size refusal, an incomplete turn with the window full, a request-body timeout, the dead-end rescue, an exceeded image budget), or `P` over the window less the reserve. With default settings the threshold is the window less the reserve, so default threshold compaction is always forced.

Each site supplies `p` and `s`. A prune keeps what precedes its first blanked result and saves what it blanks (the agent's prune passes take an `admit` gate for this). A shake keeps what precedes its first elided region and saves the regions less their placeholders. A compaction keeps the tools and system prompt and writes everything it leaves after them again (its summary and the kept tail); it removes the rest of the stored context, and a pending prompt counted in `P` is sent either way, so it is not removed. A compaction that summarizes with a model is asked before it starts, when its summary does not exist yet: the summary is counted at the summarizer's cap, plus the file lists appended to it, so its write is never underestimated. Snapcompact is asked twice. Before it starts, it is asked about the most favourable cut it could make: its archive counted at no tokens, so it leaves the tools and system prompt and the kept tail, or the tools and system prompt alone when an extension handles `session_before_compact` (its compaction may keep a shorter tail). A larger cut never saves fewer reads and never writes more again, and a forced or lapsed cut is admitted whatever its size, so a pass that waits on that cut would wait on any archive: it starts nothing and renders no archive. After it renders its archive and before it commits, it is asked by the context the archive (or an extension's `session_before_compact` compaction) and the kept tail leave; only this second answer counts as an admitted cut. A pass refused there is remembered with what its archive would leave: while the context it was rendered for stands (a branch grown from the one it was weighed on, with the same newest compaction, model, compaction settings and archive shape), each later point asks the rule about those figures instead of the no-token archive before it starts, so the pass starts, runs its `session_before_compact` handlers and renders again only once those figures are admitted (the context grew enough, the entry lapsed or cannot be read, or the reason forces the cut) or that context is gone. The memory is the process's own: after a restart the first point that reaches the pass renders again. Where a site cannot measure `p` exactly it errs low, which only makes the cut's write look larger. A cut that waits does not run: the next maintenance point proposes it again, and a compaction that waits leaves a background speculation armed. A cut asked before it starts starts nothing; a snapcompact pass that waits after rendering ends its maintenance as skipped and starts no other method. With nothing to cut (no prune candidate, no shake region, no history to summarize) the rule is not asked and the site's own no-progress handling runs as before.

#### Image clamps

A conversation's provider-context transform holds one `ProviderImageClamp`, so its count clamp drops the same images from one request to the next: it remembers which images it dropped, each by the turn that carries it and its bytes. While the other images a request sends fit the image budget, it drops exactly those again, and the prompt prefix keeps its bytes. When a new image would exceed the budget the request cannot be sent without a drop (a forced cut): the clamp drops the oldest images down to half the budget, rounded up, in one step, so the next forced drop is at least half the budget of new images away. Where the newest message that sends images sends more than half the budget, it keeps as many of them as the budget carries instead. The images dropped beyond the one the budget needed come after it in the prompt, so they add nothing to the write the forced drop already causes. A dropped image keeps its placement: an image-only message still carries the omission text.

A request that sends part of what the conversation already sent (a side request's prefix, a prune, a branch switch) drops the dropped images it still sends and keeps every other image, so its shared prefix keeps its bytes and no image the budget carries is dropped in place of one the request no longer sends. The clamp finds a conversation's drops by the turn that carried its oldest image when it first had to drop, which such a request still carries even where a prune blanked that turn's images. A compaction replaces that turn, so the history it leaves starts again from its own images; a model with another image budget does too. Without this, past the budget each new image dropped one more old image, and every request rewrote the prompt from the oldest image it still sent. Each forced drop is also written to the session's branch (a `provider-image-drop` entry, see [session](./session.md)): a process that resumes the session, or switches to it, and remembers no drops for a conversation whose images pass the budget reads them there and drops the same images again, so its first request keeps the prompt the previous process sent instead of making a new forced drop of another set.

The byte clamp keeps the newest user message and the newest image tool result past the byte budget while they fit the request-body limit, and which messages those are moves with every turn, so a remembered drop would evict a different set of images. It keeps its per-request behaviour, and each drop that evicts more images than the previous request's is passed to the rule as forced. The auto-learn capture, a side request that reads the session's cached prompt, shares the count clamp's drops and their record but keeps its own byte count and passes nothing to the rule, so only the main loop's requests are counted and reported.

### Experimental notes-backed context windows

Enable **Notes-backed context windows (experimental)** in `/settings`; the running session gains the tools immediately. The equivalent configuration is:

```yaml
compaction:
   experimentalContextManagement: true
```

This opt-in mode replaces automatic summary recompression with local context-window
boundaries. It also applies to `/compact` without an explicit mode or focus text.
Explicit compaction modes and focused instructions retain their existing behavior.

- `context_notes` reads the current notebook when `text` is omitted, replaces it
  when `text` is supplied, and clears it with `text: ""`.
- Notebook revisions are journal entries on the active branch. Only the latest
  visible revision is injected into model context, including after resume or fork.
  A context reset clears the visible notebook. Each replacement is limited to
  **16,384 UTF-8 bytes**; oversized writes fail without replacing the notes.
- `new_context` requests rollover at the next safe tool-loop boundary. Rollover
  retains complete recent tool-call/result units and the notebook without calling
  a summarization model. Near the automatic threshold, the model receives a
  once-per-window reminder to save its working state.
- `read` and `grep` can recover original messages and tool outputs through
  `history://current/full`. The text includes stable entry IDs and window
  boundaries. Shared selectors work, for example
  `history://current/full:1-200` and `history://current/full:raw:1-200`.
  Queries, fragments, trailing slashes, and additional path components are rejected.
- The full-history route is bound to the calling session's current branch. It
  never falls back to another registered agent or an on-disk session search.
  Existing `history://<id>` routes retain their concise transcript behavior.

Experimental rollover requires the effective tool set to contain `context_notes`,
`new_context`, `read`, and `grep`. Restricted sessions without all four retain
legacy maintenance. Disabling the setting restores legacy compaction and disables
the experimental tools and full-history route; existing notes remain in the journal
and provider context.

The default is `false`. This is an independent implementation of persistent notes
and searchable history, with the existing session journal as its only transcript
store.[^experimental-context-history]

[^experimental-context-history]:
    Earlier pruning or explicit destructive history
    operations cannot be undone by enabling the setting. Text history represents
    images as markers. Notebook quality and timely updates remain the model's
    responsibility; the mode does not automatically generate missing notes.

### Shake method

Including `shake` in `compaction.methodOrder` performs an inline, local reduction instead of calling a summarization model. It replaces eligible tool results and large fenced/XML blocks with recoverable `artifact://` references, using a protected recent-token window and minimum-savings threshold. Automatic shake emits the normal auto-compaction events with `action: "shake"`.

Threshold, incomplete-output, and overflow recovery advance to the next configured method when shake cannot reclaim enough context to get below the recovery band; this prevents repeated no-op shake loops. Idle shake does not use that fallback because the idle timer rechecks usage before running again. Manual `/shake` is a separate, more aggressive command that can target all eligible history.

### Snapcompact method

Including `snapcompact` in `compaction.methodOrder` replaces the LLM summarization call with a local, deterministic archival pass (`compact` from `@oh-my-pi/snapcompact`):

- The discarded history is serialized, whitespace-collapsed, and printed onto model-aware PNG frames (frame width fixed per shape; frame height hugs the rows actually printed) using bundled public-domain pixel fonts. The shape — and frame size — resolve from the **model id** when the model line was measured: Claude reads X.org `8x13` glyphs on an 11px advance (extra letter-spacing, black ink — `11on16-bw`; high-res lines — Opus 4.7+, Fable, Mythos — get 1932px frames under Anthropic's 4,784 visual-token cap, older lines stay at 1568px), Gemini reads `8x13` glyphs on a 22px pitch (extra leading, black ink — `8on22-bw` at 2048px, since Gemini 3.x bills a fixed 1,120-token budget per image at any pixel size), GPT/Codex read the same `8on22-bw` shape at 1568px (patch billing is area-proportional, so larger frames cannot improve chars per token), and Kimi/GLM read `8x13` glyphs on a 16px pitch (`8on16-bw` at 1568px — kimi's processor downscales past 1792px). A Claude routed through Vertex or OpenRouter keeps its Claude shape. Auto selection is also font-aware (`resolveShapeForText`): when the model-default font cannot safely render the transcript, or wide CJK glyphs dominate it and the `silver16-bw` grid can render it safely, auto switches to `silver16-bw`; forced variants are never overridden. Unmeasured models fall back to their wire API family (Anthropic-family/unknown → `11on16-bw`, Google → `8on22-bw`, OpenAI-compatible → `8on22-bw`); the per-frame token estimate follows the reading model's lineage, from its catalog `image-tokenization` rule (a Claude behind Vertex or OpenRouter is priced as Claude, and Opus/Sonnet/Haiku before 4.7 under the standard 1,568-token tier), falling back to the catalog rule for the wire API carrying the request when the lineage has none, computed for the resolved frame size. OpenAI-compatible wires also get the `detail: "original"` hint. The `snapcompact.shape` setting (default `auto`) forces one of the research-eval variants instead: square grids (`8x8r`/`8x8u`/`6x6u`/`5x8` × sentence-hue/black ink) or the per-model eval winners (`6x12-dim`, `8x13-bw`, `8on16-bw`, `8on22-bw`, `11on16-bw`, `silver16-bw` — the embedded Silver TrueType font on a 16px grid for CJK and other non-Latin text — and the two-column word-wrapped `doc-8on16-bw`/`-sent`/`-sent-dim`, where `dim` prints stopwords in gray). A forced variant keeps its geometry but is re-priced for the reading model's image billing. A host that downscales images before the model reads them (catalog `image-max-edge`; Cursor fits Claude and GPT images into 1024×1024) gets frames no wider than that edge, forced variants included. The same setting governs inline system-prompt/tool-result imaging (`snapcompact.systemPrompt`, `snapcompact.toolResults`).
- Serialization keeps the archive conversation-dense: tool results are truncated head+tail (default 2,000 chars at a 0.6 head ratio), tool-call argument values are capped per value (500) and per call (2,000), and tool output is printed in dim gray ink so conversation reads louder than tool noise. All budgets and the dimming are configurable via `SerializeOptions` (`toolResultMaxChars`, `toolArgMaxChars`, `toolCallMaxChars`, `truncateHeadRatio`, `dimToolResults`).
- The snapcompact archive persists under `CompactionEntry.preserveData.snapcompact` as bounded source text plus rendered frames. On each context rebuild it is reconstructed into ordered compaction blocks: plain text at the oldest edge, an imaged middle, then plain text at the newest edge. The entry's `summary` is just the short resume lead-in plus the usual file-operation list.
- Later compactions re-render from that bounded source text (`Archive.text`), not by carrying old PNGs forward blindly. `maxFrames` now defaults to `MAX_FRAMES_DEFAULT` (80) and acts only as an upper limit; when the imaged middle is large it foveates internally (HQ/LQ/HQ), while both chronological edges stay verbatim text.
- No model, API key, or network is involved, so snapcompact is also safe for overflow recovery. It requires a vision-capable current model (`model.input` includes `"image"`); otherwise automatic maintenance skips it and advances to the next configured method. Manual `/compact` honors the method order unless custom instructions are given (those imply a directed LLM summary).
- Rationale: the shape table comes from the snapcompact 200k-token evals in `packages/snapcompact`, where bitmap frames preserved QA recall at lower billed-token cost than raw text for vision-capable models.

The archive is sized from the room under the compaction trigger, not from the window. The plan gives the frames half of what the resolved threshold (the active model's `compaction.modelThresholds` entry applied) leaves after the system prompt, tools, kept recent turns (counted as the trigger counts them, without opaque reasoning replay signatures), the archive's text and, for a pre-prompt pass, the pending prompt, keeps the whole compacted context plus that prompt within 60% of the threshold, and never goes past what fits the window; it always allows at least one frame (a text-only archive when the discarded text fits the text edges), so when even that leaves no room it only logs a warning and renders one frame. Each frame is charged the shape's own price for the active model when the model's catalog `image-tokenization` rule is `verified` against provider billing, and otherwise that price or `FRAME_TOKEN_ESTIMATE` (5,024), whichever is higher. The 80-frame default, the deployment's catalog `image-count-budget`, and the frame payload budget (`frameDataBytesBudget`: half the deployment's catalog `inline-image-byte-budget`, 60 MB on the official Anthropic endpoint, 12 MB on the Codex backend, else 3,000,000 bytes; sized from a per-shape frame estimate) cap the result whatever the room. Every context rebuild attaches the archive at the active model's frame payload budget, and every request drops the oldest archive frames past the request model's budget, so a model switch to a host with a smaller budget never sends the larger archive. 60% is a sizing target, not a guarantee: a render that lands above it or over the frame payload budget is re-rendered with the oldest frames dropped, at most twice, at the frame count estimated to fit both (`frames × budget / payload` for bytes), and a one-frame archive cannot shrink further. The result is then judged by the path that asked for it: a render still over the byte budget or the window is rejected/skipped rather than committed as an unusable prompt; a threshold pass whose result (plus its pending prompt) is above the 80% recovery band moves to the next configured method with a warning notice, or, when no later method other than `shake` can run, keeps that result with a warning notice as long as it still fits the window with the pending prompt; overflow and incomplete recovery retry the turn and need only the window fit, and manual `/compact` keeps only its reduction and window-fit checks.

### Maintenance progress guard

Automatic maintenance checks that the rewritten context creates real headroom (normally at or below 80% of the resolved threshold) before scheduling continuation. No-progress passes can try local rescue: re-render an existing snapcompact archive with a smaller frame budget, elide heavy blocks to recoverable artifacts, or drop attached images. Archive rescue can truncate the oldest carried source text; image dropping is destructive. If maintenance still cannot create headroom, it emits a warning and blocks automatic continuation instead of looping on the same oversized context.

### Display transcript

Compaction no longer visually restarts the conversation. The TUI renders the **display transcript** (`buildSessionContext({ transcript: true })` / `AgentSession.buildTranscriptSessionContext()`): every path entry in chronological order, with each compaction shown inline as a slim divider — `── 📷 compacted · ctrl+o ──` — at the point it fired. Expanding (ctrl+o) reveals the summary. Only the LLM context resets at the compaction boundary; the scrollback above the divider stays intact, including across session resume.

### Pre-compaction pruning

Before compaction checks, tool-result pruning may run (`pruneToolOutputs`).

Default prune policy:

- Protect newest `40_000` tool-output tokens.
- Require at least `20_000` total estimated savings.
- Never blank a result below `50` tokens (`MIN_PRUNE_TOKENS`): the `[Output truncated - N tokens]` placeholder costs ~8 tokens, so pruning a sub-floor result would grow the context and churn the prompt cache for nothing. (Superseded and useless results keep their own rules — the useless collector already drops no-savings candidates; superseded reads prune for correctness regardless of size.)
- Never prune `skill` tool results, `read` results of `skill://` paths, or reads of the active plan reference file (added via `AgentSession`'s plan protection).

Pruned tool results are replaced with:

- `[Output truncated - N tokens]`

If pruning changes entries, session storage is rewritten and agent message state is refreshed before compaction decisions.

### Useless-result elision

Tools can flag a finished result as contextually useless — a search with zero matches or a `wait` whose window elapsed with only still-running work. The flag originates on the tool result (`AgentToolResult.useless`, set via `ToolResultBuilder.useless()` or directly on the returned object), is copied by the agent loop onto the persisted `ToolResultMessage` (never together with `isError` — errors always win), and is consumed in three places:

- **Per-turn stale-result pass** (`pruneSupersededToolResults`, gated by `compaction.dropUseless`, default on): flagged results are blanked to the exact placeholder `[Uneventful result elided]` (`USELESS_NOTICE`) with the same cache-aware timing as superseded reads — only when the suffix after the candidate is small (≤ ~8k tokens) and, for models with a known prompt-cache lookback (catalog `prompt-cache-lookback`; Claude: 20 positions), sits within a conservative bound on it, or the session has idled past the provider prompt-cache lifetime. The bound projects the candidate's issuing assistant turn, its tool-result batch and everything after it through the session's `convertToLlm` (so file mentions, command output with images and custom-message image splits count as sent) and counts positions the way Anthropic does (a run of consecutive `tool_use` or `tool_result` blocks is one position; images hoisted out of error results and padding turns count). It allows at most the lookback minus 6, keeping 6 positions for the next request's input and for request projections it does not count (orphan-result notes, replayed compaction file metadata, tool-change controls). An input or projection larger than that margin can still cost one cache rebuild. Models without a known lookback skip the bound. The threshold prune's warm-cache guard applies the same limit. Results smaller than the notice itself are never blanked (no savings), and protected tools are exempt.
- **Threshold prune** (`pruneToolOutputs`): flagged results bypass the protect-recent window, same as superseded reads, and receive `USELESS_NOTICE` instead of the token-count placeholder.
- **Summary serialization**: `serializeConversation` (agent and snapcompact) drops the whole tool call/result pair from summarizer/archive input — the source region is discarded after summarization anyway, so the exclusion costs no cache.

The flag never reaches provider wire formats, and flagged pairs are never removed from history (only blanked in place), so tool-call/result pairing and provider-native history replay stay intact.

### Boundary and cut-point logic

`prepareCompaction()` builds one effective message sequence for estimation, cut-point selection, and the history-summary, turn-prefix, and retained-message regions.

1. Find the latest compaction whose summary or provider-native history is reusable by the active model.
2. Honor the latest `/clear` `reset_boundary`: a newer reset discards the previous summary, and an older reset remains the lower bound for recovering retained messages.
3. For a local summary, recover the original entries from `firstKeptEntryId` up to the previous compaction record, then append entries after that record.
4. For reusable provider-native history, start after `providerReplayThroughEntryId` when it identifies an older snapshot, without crossing the latest reset boundary. This recovers the uncovered snapshot-to-commit interval, not the original messages already covered by native replay. A trailing native compaction record does not make that interval already compacted.
5. Exclude compaction records and other non-message metadata. Pass the previous summary separately through `previousSummary`; retain message-bearing `custom_message` and `branch_summary` entries.
6. Adapt `keepRecentTokens` using the measured usage ratio, then run `findCutPoint()` and partition that same sequence into `messagesToSummarize`, `turnPrefixMessages`, and `recentMessages`.

When updating a local summary, every effective original message belongs to exactly one of those three regions. For example, after `summary(A) + B` grows to `summary(A) + B + C`, the next preparation distributes both B and C, not just C. The new `firstKeptEntryId` refers to an original entry; preparation does not move, duplicate, or rewrite journal entries. This is a local-summary preparation guarantee, not an end-to-end guarantee for provider-native or speculative native replay.

Valid cut points include:

- message entries with roles: `user`, `assistant`, `bashExecution`, `hookMessage`, `branchSummary`, `compactionSummary`
- `custom_message` entries
- `branch_summary` entries

Hard rule: never cut at `toolResult`.

Preparation filters out pure metadata (`model_change`, `thinking_level_change`, labels, etc.) before selecting the retained-message boundary. Those records remain in the journal but are not conversation input.

### Split-turn handling

If cut point is not at a user-turn start, compaction treats it as a split turn.

Turn start detection treats these as user-turn boundaries:

- `message.role === "user"`
- `message.role === "bashExecution"`
- `custom_message` entry
- `branch_summary` entry

Split-turn compaction generates two summaries:

1. History summary (`messagesToSummarize`)
2. Turn-prefix summary (`turnPrefixMessages`)

Final stored summary is merged as:

```markdown
<history summary>

---

**Turn Context (split turn):**

<turn prefix summary>
```

### Summary generation

`compact(...)` builds summaries from serialized conversation text:

1. Convert messages via `convertToLlm()`.
2. Serialize with `serializeConversationForSummary()` using the target model's preferred dialect.
3. Wrap in `<conversation>...</conversation>`.
4. Optionally include `<previous-summary>...</previous-summary>`.
5. Optionally inject extension hook context and active memory-backend compaction context as `<additional-context>` entries.
6. Execute summarization prompt with `SUMMARIZATION_SYSTEM_PROMPT`.

Oversized local-summary input is folded through budgeted conversation windows, carrying each summary into the next update. Provider context-overflow rejections halve and re-plan the rejected window down to a minimum input budget; other failures surface normally.

Prompt selection:

- first compaction: `compaction-summary.md`
- iterative compaction with prior summary: `compaction-update-summary.md`
- split-turn second pass: `compaction-turn-prefix.md`
- short UI summary: `compaction-short-summary.md`
- handoff document: `handoff-document.md` (used by `generateHandoff(...)`, not serialized compaction)

Remote summarization modes, consulted in order (each stage falls back to the next while one is available):

- **V2 streaming Responses compaction** (tried first, on by default via `compaction.remoteStreamingV2Enabled`): for eligible models — `shouldUseCompactionV2Streaming(...)`: `openai-responses`, `azure-openai-responses`, or `openai-codex-responses` APIs with `remoteCompaction.v2StreamingEnabled` (on by default for Amazon Bedrock's OpenAI routes, see below) and a resolvable Responses endpoint — compaction forwards the full conversation, including provider-native tool-call history replay, to the model's normal Responses streaming endpoint with a trailing `compaction_trigger` input item, and requires exactly one streamed `compaction` output item. The request carries session routing and prompt-cache identifiers (routing/session-id headers plus `prompt_cache_key`) and resolves the model's reasoning effort the same way a normal turn does. Replacement history is Codex-style: retained real user messages within the `compaction.v2RetainedMessageBudget` (default `64000` tokens, clamped to that ceiling) followed by the compaction item, stored in `preserveData.openaiRemoteCompaction` (version `"v2"`). Transient stream errors retry up to `V2_COMPACTION_MAX_RETRIES` (`2`) times with exponential backoff under a five-minute timeout (`V2_COMPACTION_TIMEOUT_MS`, same as V1); user aborts are never retried.
- **V1 native `/responses/compact`**: for OpenAI models, OpenAI Codex models with an explicit compatible `remoteCompaction.endpoint`, and `openai-responses` models on Amazon Bedrock's OpenAI routes (`shouldUseOpenAiRemoteCompaction`), when remote compaction is enabled and V2 did not run (ineligible or failed), compaction tries the provider-native `/responses/compact` endpoint. It preserves provider replacement history in `preserveData.openaiRemoteCompaction`. A native failure surfaces its transport error instead of silently switching to generic summarization — unless `compaction.remoteEndpoint` is set, in which case summary generation falls through to that endpoint/local summarization.
- **Anthropic on-demand compaction** (`compact-2026-09-04` beta): for model lines the beta supports (`compat.supportsServerCompaction`, a catalog rule: Opus 4.6+, Sonnet 4.6+, Fable/Mythos 5+ on the `anthropic`, `google-vertex`, `amazon-bedrock`, and `bedrock-mantle` providers) whose effective endpoint implements it (`shouldUseAnthropicNativeCompaction`: the Claude API, Vertex, Foundry, Claude Platform on AWS, and Amazon Bedrock's `/anthropic` routes; another provider reaching one of the first four needs `remoteCompaction.enabled`, and unknown gateway URLs stay excluded), when remote compaction is enabled and no OpenAI lane applies. Compaction sends the history to summarize with the live conversation's system prompt, tools, and thinking settings, plus a top-level `compaction: { type: "summarize", instructions }` parameter carrying the harness summary prompt. The API answers with one signed `compaction` block (`stop_reason: "compaction"`), surfaced as an `anthropicCompaction` payload. Its plain-text summary becomes the entry `summary` (plus the file-operation list) **and** `preserveData.anthropicCompaction`; later requests on a compaction-capable endpoint send the block back unchanged as the first block, while every other provider reads the summary text. A block's signed `tool_changes` (net tool additions/removals across the summarized range) are persisted and replayed verbatim with it. The retained tail after the cut point is replayed from session entries like a local summary. A response without a signed summary, such as a refusal, an output limit, or a tool call during summarization, is a native failure, like the OpenAI lanes. Blocks written by the older `compact-2026-01-12` threshold beta (`encryptedContent`) are replay-only.
   - On Amazon Bedrock, use `https://bedrock-runtime.<region>.amazonaws.com/anthropic` or `https://bedrock-mantle.<region>.api.aws/anthropic` ([setup](./models.md#claude-on-bedrocks-anthropic-messages-api-anthropic)); the FIPS and PrivateLink hostnames listed below for the OpenAI routes count too. The gate reads `compat.bedrockMessagesApi`, detected from such a `baseUrl`; set it in `models.yml` to opt a proxy or an `ANTHROPIC_BASE_URL` reroute in, or `false` to opt a Bedrock route out.
   - Bedrock Converse models (`bedrock-converse-stream`) whose model card lists the beta (`compat.supportsServerCompaction`, a `providers/amazon-bedrock.kdl` rule: Haiku 4.5/5.5, Sonnet 5/5.5, Opus 4.7/4.8/5/5.5) compact through a Bedrock Runtime `InvokeModelWithResponseStream` side request carrying the same Anthropic Messages body; Converse itself rejects the beta ([AWS compaction guide](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-compaction.html)). Ordinary turns stay on Converse and read the summary text; the signed block is replayed only to later compaction requests. AWS bedrock-runtime origins (public, FIPS, PrivateLink) qualify by default; any other `baseUrl` is treated as a gateway that may implement only Converse and needs `remoteCompaction.enabled: true`. `remoteCompaction.enabled: false` opts a model out.
- **Custom remote endpoint**: if `compaction.remoteEndpoint` is set and remote compaction is enabled, local summary generation POSTs one of two wire formats:
   - custom omp summarizer endpoints receive `{ systemPrompt, prompt, maxTokens }` and must return JSON containing at least `{ summary }`.
   - OpenAI-compatible endpoints whose path ends in `/chat/completions` receive `{ model, messages, stream: false, max_tokens }`, where `messages` contains one system prompt and one user prompt. The summary is read from `choices[0].message.content`, which lets self-hosted servers such as llama.cpp and vLLM act as remote compactors without a separate summarizer shim.

Amazon Bedrock's OpenAI routes get both OpenAI lanes without an opt-in. The route is detected from the model `baseUrl` (`isBedrockOpenAIUrl` in `packages/catalog/src/hosts.ts`), for any provider id with `api: openai-responses`: an HTTPS `/openai/…` path on a `bedrock-runtime` or `bedrock-mantle` endpoint, or Mantle's documented `/v1` base. Endpoint hostnames are the public ones (`bedrock-runtime.<region>.amazonaws.com`, FIPS `bedrock-runtime-fips.<region>.amazonaws.com`, `bedrock-mantle.<region>.api.aws`, including the bundled `bedrock-mantle` provider's `{region}` template) and AWS PrivateLink endpoint-specific names (`<vpce-id>[-<az>].bedrock-runtime[-fips].<region>.vpce.amazonaws.com` or `….bedrock-mantle.<region>.vpce.amazonaws.com`); a VPC endpoint with private DNS answers on the public names ([Endpoints supported by Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html), [Bedrock service endpoints](https://docs.aws.amazon.com/general/latest/gr/bedrock.html), [Bedrock VPC endpoints](https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html), [PrivateLink DNS names](https://docs.aws.amazon.com/vpc/latest/privatelink/privatelink-access-aws-services.html)). Other Bedrock paths, such as `/anthropic`, `/v1` on bedrock-runtime, or the Converse root, do not count. On these Bedrock routes only, both compaction requests are shaped like a normal Bedrock turn by `prepareBedrockCompactionRequest` (`packages/agent/src/compaction/bedrock.ts`): configured headers are resolved, the transport fetch applies (provider proxy, extra CA, User-Agent, request recording), and the provider's own request hooks run. So the bundled `bedrock-mantle` provider fills in `{region}` and uses its bearer token or SigV4 signing. Other providers' compaction requests keep their own transport. To turn the default off for a model or provider in `models.yml`, set `remoteCompaction.enabled: false` (both lanes) or `remoteCompaction.v2StreamingEnabled: false` (V1 only). AWS documents the Responses API on both endpoints ([Responses API](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-responses-api.html)), and OpenAI lists Bedrock's feature coverage ([OpenAI models in Amazon Bedrock](https://developers.openai.com/api/docs/guides/amazon-bedrock)). None of these pages mention compaction. Support was verified live instead, on 2026-09-25 with a Bedrock API key (not SigV4) on the public `/openai/v1` bases: in `us-east-1`, V1 `POST {base}/responses/compact` returned `object: "response.compaction"` and V2 streamed a `compaction` output item on `bedrock-runtime` (`us.openai.gpt-6-astra`, `-sol`, `-luna`) and on `bedrock-mantle` (`openai.gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-terra`, `gpt-5.5`, `gpt-5.4`). FIPS, PrivateLink, and Mantle `/v1` bases reach the same services but were not verified live. `openai.gpt-oss-120b` on Mantle does not support the Responses API.

When a native remote compaction (V2, V1, or Anthropic) succeeds, local LLM summarization is skipped entirely. For the OpenAI lanes the durable history lives in the provider replay payload and the stored `summary` is a placeholder lead-in plus the file-operation list; the Anthropic lane stores the real summary text, so a later compaction by any provider can build on it.

When native compaction starts from an ordinary local summary, that summary is included as a context message alongside the prepared conversation. Later native passes reuse the provider payload instead of re-injecting its placeholder summary. Snapcompact source text keeps its separate archive migration path.

For speculative native compaction, `providerReplayThroughEntryId` records the snapshot's last entry, not the later commit position. Context rebuilding and the next compaction preparation both include messages appended between those positions, followed by post-commit messages. The native payload and uncovered interval are replayed once each; `/clear` discards both when it supersedes that compaction.

Advisor runtimes retain native `preserveData` for subsequent maintenance and attach its provider payload to the in-memory compaction summary for the next model request. Native replay already contains the retained tail, so advisors do not also append that tail as raw messages. Local summaries still keep recent messages separately. Advisor requests use the shared message converter so both textual compaction summaries and native payloads reach the provider.

### Handoff generation

`packages/agent/src/compaction/compaction.ts` exports `generateHandoff(...)` and `generateHandoffFromContext(...)`. Coding-agent uses the context-aware function through `SessionHandoff`: the side request uses the base system prompt, normalized tools, transformed live history, and live prompt-cache key, with a unique side session id and trailing agent-attributed `user` handoff prompt. It starts with `toolChoice: "none"` and retries once with `"auto"` only after an explicit-tool-choice compatibility rejection. Only joined text blocks are returned; tools are never dispatched. See [the handoff pipeline](./handoff-generation-pipeline.md).

Handoff commits a regular `CompactionEntry` on the current session: `SessionMaintenance.handoff()` (manual `/handoff`) and the auto-maintenance `handoff` method both generate the document via `SessionHandoff.generateDocument()` and store it as the compaction summary with `firstKeptEntryId` from `prepareCompaction`, so recent history is kept and the session id, transcript, and provider cache key are unchanged.

When `compaction.handoffSaveToDisk` is enabled, an **automatically triggered** handoff also writes `handoff-<ISO timestamp>.md` in the persisted session's artifact directory. Manual handoffs are not written by this setting, and non-persisted sessions have no artifact directory.

### File-operation context in summaries

Compaction tracks cumulative file activity using assistant tool calls:

- `read(path)` → read set
- `write(path)` → modified set
- `edit(path)` → modified set

Cumulative behavior:

- Includes prior compaction details only when prior entry is pi-generated (`fromExtension !== true`).
- In split turns, includes turn-prefix file ops too.
- `details.readFiles` excludes files also modified; `details.modifiedFiles` carries the rest (persisted shape is unchanged).

The file list is a grouped, prefix-folded directory tree (find-tool shape) with a per-file access marker — `(Read)` for read-only files, `(Write)` for modified files never read, `(RW)` for modified files also present in the cumulative read set. Capped at 20 files with an `[…N files elided…]` line. LLM-summary strategies append it as a `<files>` tag (via `upsertFileOperations`); snapcompact renders it inside its summary template as a `FILES` section instead.

```xml
<files>
# packages/agent/src/compaction/
compaction.ts (Read)
utils.ts (RW)
## prompts/
file-operations.md (Write)
</files>
```

Legacy `<read-files>`/`<modified-files>` tags from summaries written by earlier versions are stripped (alongside `<files>`) before re-appending, so old summaries self-heal on the next compaction.

### Persist and reload

After summary generation (or hook-provided summary), agent session:

1. Appends `CompactionEntry` with `appendCompaction(...)`; the handoff method commits the generated document as the entry's summary on the same session.
2. Rebuilds display context from the active leaf via `buildDisplaySessionContext()`.
3. Replaces live agent messages with rebuilt context.
4. Synchronizes active todo phases from the rebuilt branch and closes provider sessions whose history was rewritten.
5. Emits `session_compact` hook event.

## Branch summarization pipeline

Branch summarization is tied to tree navigation, not token overflow.

### Trigger

During `navigateTree(...)`:

1. Compute abandoned entries from old leaf to common ancestor using `collectEntriesForBranchSummary(...)`.
2. If caller requested summary (`options.summarize`), generate summary before switching leaf.
3. If summary exists, attach it at the navigation target using `branchWithSummary(...)`.

Operationally this is commonly driven by `/tree` flow when `branchSummary.enabled` is enabled.

### Branch switch shape (visual)

```text
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D (abandoned branch, unchanged)
    A ───┤
         └─ E ─ F ─ [summary of B,C,D] (new leaf)
```

### Preparation and token budget

`generateBranchSummary(...)` computes budget as:

- `tokenBudget = (model.contextWindow || 128000) - branchSummary.reserveTokens`

`prepareBranchEntries(...)` then:

1. First pass: collect cumulative file ops from all summarized entries, including prior pi-generated `branch_summary` details.
2. Second pass: walk newest → oldest, adding messages until token budget is reached.
3. Prefer preserving recent context.
4. May still include large summary entries near budget edge for continuity.

Compaction entries are included as messages (`compactionSummary`) during branch summarization input.

### Summary generation and persistence

Branch summarization:

1. Converts and serializes selected messages with `serializeConversationForSummary()` and the target model's preferred dialect.
2. Wraps in `<conversation>`.
3. Uses custom instructions if supplied, otherwise `branch-summary.md`.
4. Calls summarization model with `SUMMARIZATION_SYSTEM_PROMPT` and a 2,048-token output limit.
5. Prepends `branch-summary-preamble.md`.
6. Appends file-operation tags.

Result is stored as `BranchSummaryEntry` with optional details (`readFiles`, `modifiedFiles`).

## Extension and hook touchpoints

### `session_before_compact`

Pre-compaction hook.

Can:

- cancel compaction (`{ cancel: true }`)
- provide full custom compaction payload (`{ compaction: CompactionResult }`)

The hook's `customInstructions` carries only the public user focus. Internal summarizer guidance — currently the plan-mode "Approve and compact context" distillation prompt — travels a separate `internalGuidance` channel on `CompactOptions` that reaches only native summarization, never this hook or `session.compacting`; when both are set the summarizer uses `internalGuidance` while hooks still see the public `customInstructions` (issue #4359).

### `session.compacting`

Prompt/context customization hook for default compaction.

Can return:

- `prompt` (override base summary prompt)
- `context` (extra context lines injected into `<additional-context>`)
- `preserveData` (stored on compaction entry)

### `session_compact`

Post-compaction notification with saved `compactionEntry` and `fromExtension` flag.

### `session_before_tree`

Runs on tree navigation before default branch summary generation.

Can:

- cancel navigation
- provide custom `{ summary: { summary, details } }` used when user requested summarization

### `session_tree`

Post-navigation event exposing new/old leaf and optional summary entry.

## Runtime behavior and failure semantics

- Manual compaction aborts current agent operation first. If that abort cut a turn in flight, the compaction resumes it once the summary is committed — or immediately when it rejects as a no-op (session too small / already compacted), since that pass makes no history change — using a queued steer/follow-up first, otherwise the auto-continue prompt. A hook cancel or summarizer failure does not resume. The resume is skipped when `compaction.autoContinue` is `false` or the caller passed `suppressContinuation` (plan-mode approval dispatches its own execution turn). A manual compaction issued while idle never starts a turn. A prompt submitted while the compaction runs waits for it and, if it starts or queues a turn, replaces the resume; a locally handled extension/custom command hands the resume back — unless a turn it triggered (`pi.sendMessage(..., { triggerTurn: true })`, `pi.sendUserMessage()`), a later prompt, or any other turn starts first. A second manual compaction started while such a resume is still withheld takes it over.
- In the TUI, `/compact` sent with the follow-up key (`app.message.followUp`, Ctrl+Q / Ctrl+Enter) during a run does not abort it: the request waits in the "After yield" queue and runs when the run settles. Follow-ups sent after it wait for that compaction; follow-ups sent before it run first. Alt+Up dequeues it back into the editor; stopping the run (Esc), switching sessions, or moving to another branch of the tree hands it back with the follow-ups held behind it. Enter keeps the immediate abort-and-compact behavior, and while idle both keys compact at once.
- `abortCompaction()` cancels manual compaction, auto-compaction, and handoff generation controllers.
- Auto compaction emits start/end session events for UI/state updates.
- Auto compaction can try multiple model candidates and retry transient failures; long retry delays prefer the next candidate when one is available.
- Overflow errors are excluded from generic retry path because they are handled by context promotion/compaction.
- If auto-compaction fails:
   - overflow path emits `Context overflow recovery failed: ...`
   - incomplete-output path emits `Incomplete response recovery failed: ...`
   - threshold/idle paths emit `Auto-compaction failed: ...`
- Automatic summary candidates, including armed speculative results, are checked for context reduction before commit. Non-shrinking candidates advance to the next configured method; if none makes progress, no compaction entry is committed. Mid-turn retries, including new speculative requests, stay suppressed until the retained-history cut point advances.
  Native Responses replay counts visible replacement history and image estimates, not opaque encrypted-state bytes. Both sides use the rebuilt active context, so history before `/clear` cannot inflate the reduction baseline. These are local estimates, not provider-billed token counts.
- Branch summarization can be cancelled via abort signal (e.g., Escape), returning canceled/aborted navigation result.

## Settings and defaults

Defined in `packages/coding-agent/src/session/context-settings.ts`:

- `compaction.enabled` = `true`
- `compaction.experimentalContextManagement` = `false`. Opt-in persistent notes, branch-bound raw-history retrieval, and local context-window rollover; toggling it adds or removes `context_notes`/`new_context` in the running session.
- `compaction.methodOrder` = `["remote", "snapcompact", "handoff", "shake", "soft"]`. `remote` uses provider-native server compaction (OpenAI Responses compact, Anthropic compaction beta, including Bedrock Converse's Runtime side request) when available; unavailable or failed methods advance to the next preference.
- `compaction.asyncEnabled` = `true`. Async (speculative) compaction: when context enters the pre-threshold band `[threshold − lead, threshold)` (lead = `clamp(threshold × 0.125, 8192, 32000)`), maintenance starts a background summarization for the first configured LLM-backed method (`remote`, `handoff`, or `soft`) off a branch snapshot, isolated from the live turn by a side session id. The armed result is committed instantly when the threshold is actually crossed, hiding summarization latency; post-snapshot turns are appended after the summary unchanged. Armed results are discarded when the branch prefix changes (new compaction, reset boundary, `/tree` navigation), when a provider-native replay payload is no longer readable by the active model, or when context grows past `keepRecentTokens` since compute (a fresh speculation replaces it). Speculation is skipped while an extension registers `session_before_compact`. The status line pulses the auto-compact icon while a speculation runs and holds it in accent when a result is armed.
- `compaction.reserveTokens` is unset by default. The effective reserve is `max(floor(contextWindow × 0.15), configuredReserve ?? 16384)`. Budget checks use the proportional reserve when the unset default is impractical on a small window, or when the effective reserve reaches/exceeds the whole window. Explicit reserves otherwise retain the 15% floor.
- `compaction.keepRecentTokens` = `20000`. Preparation caps this budget so the compacted context lands in the recovery band (80% of the trigger): at most `0.8 × trigger − reserveFloor`, where `reserveFloor` is the smaller of the effective budget reserve and `compaction.reserveTokens` (or `16384` when unset), or half the band when the floor alone fills it. The cap applies before adjusting for measured usage, so a low trigger on a small or provider-capped window keeps less history instead of compacting again right away.
- `compaction.autoContinue` = `true`
- `compaction.midTurnEnabled` = `true`; a `false` value applies to the session that configured it, not to spawned subagents — each subagent keeps mid-run checks so its single-turn assignment still compacts at the configured threshold.
- `compaction.handoffSaveToDisk` = `false`
- The `handoff` method generates a handoff document through the live-cache side-request pipeline and commits it as a compaction entry on the current session (no new session is created); `/handoff` does the same manually.
- `compaction.remoteEndpoint` = `undefined`
- `compaction.remoteStreamingV2Enabled` = `true`
- `compaction.v2RetainedMessageBudget` = `64000`
- `compaction.thresholdPercent` = `-1` and `compaction.thresholdTokens` = `-1`; a positive fixed token limit takes precedence over percentage, and otherwise the reserve-based threshold is used.
- `compaction.modelThresholds` = `{}`; `provider/model-id` or `provider/…*` prefix → a token base the threshold policy scales in place of the window (dropping a global `thresholdTokens`), a fixed trigger (`"f90000"`), or a percentage replacing both thresholds, while that model is active. Editable from the `/models` Roles view (`k`). See [Settings](./settings.md#context-compaction-and-memory).
- `task.agentCompactionThresholdOverrides` = `{}`; exact-name task/eval agent → token count (`90000`) or percentage (`"80%"`) replacing both thresholds for that agent only. See [Settings](./settings.md#context-compaction-and-memory).
- `compaction.idleEnabled` = `false`
- `compaction.idleThresholdTokens` = `200000`
- `compaction.idleTimeoutSeconds` = `300` (fallback unless a confirmed 1h prompt-cache entry sets the timing)
- `compaction.supersedeReads` = `true`
- `compaction.dropUseless` = `true`
- `snapcompact.systemPrompt` = `"none"` (`"agents-md"` and `"all"` opt into transient system-prompt imaging)
- `snapcompact.toolResults` = `false` (transient imaging of large tool results, the newest one included; `read` results stay text unless the model's catalog rule sets `snapcompact-image-reads` (Opus 5.5+). An imaged `read` draws each row's leading indentation as a count bracket (`[»2]` two tabs, `[·4]` four spaces) because frames collapse whitespace, and keeps its `[path#TAG]` header as text beside the frames, so edits can copy both. The planner keeps a result in the form it was first sent in until the `snapcompact.*` settings, the model or earlier history change, or later images push the request past the provider's image cap; a downstream request-byte limit can still drop older inline frames, as it can any inline image)
- `snapcompact.shape` = `"auto"`
- `branchSummary.enabled` = `false`
- `branchSummary.reserveTokens` = `16384`

These values are consumed at runtime by `AgentSession`, `SessionMaintenance`, and the compaction/branch-summarization modules.
