# Configuration Discovery and Resolution

This document describes how the coding-agent resolves configuration today: which roots are scanned, how precedence works, and how resolved config is consumed by settings, skills, hooks, tools, and extensions.

## Scope

Primary implementation:

- `packages/coding-agent/src/config.ts`
- `packages/coding-agent/src/config/config-file.ts` (re-exported from `config.ts`)
- `packages/coding-agent/src/config/settings.ts`
- `packages/coding-agent/src/config/registry.ts` (setting definitions, typed handles)
- `packages/coding-agent/src/config/all-settings.ts` (imports every domain's `settings.ts` definitions)
- `packages/coding-agent/src/discovery/builtin.ts`
- `packages/coding-agent/src/discovery/helpers.ts`

Key integration points:

- `packages/coding-agent/src/capability/index.ts`
- `packages/coding-agent/src/discovery/index.ts`
- `packages/coding-agent/src/extensibility/skills.ts`
- `packages/coding-agent/src/extensibility/custom-tools/loader.ts`
- `packages/coding-agent/src/extensibility/extensions/loader.ts`

---

## Resolution flow (visual)

```text
         Generic helper order (`config.ts`)
┌───────────────────────────────────────┐
│ 1) ~/.omp/agent, ~/.claude, ...       │
│ 2) <cwd>/.omp, <cwd>/.claude, ...     │
└───────────────────────────────────────┘
                    │
                    ▼
        capability providers enumerate items
 (native provider scans project .omp before user .omp;
  other providers have their own loading rules)
                    │
                    ▼
      provider priority sort + capability dedup
                    │
                    ▼
          subsystem-specific consumption
   (settings, skills, hooks, tools, extensions)
```

## 1) Config roots and source order

## Canonical roots

`src/config.ts` defines a fixed source priority list:

1. `.omp` (native)
2. `.claude`
3. `.codex`
4. `.gemini`

User-level bases:

- OMP native: `~/<PI_CONFIG_DIR>/agent` (normally `~/.omp/agent`; a named profile changes this as described below)
- Claude's active config directory (`~/.claude` by default; `CLAUDE_CONFIG_DIR` overrides it)
- `~/.codex`
- `~/.gemini`

Project-level bases:

- `<cwd>/.omp`
- `<cwd>/.claude`
- `<cwd>/.codex`
- `<cwd>/.gemini`

`CONFIG_DIR_NAME` is `.omp` (`packages/utils/src/dirs.ts`). `PI_CONFIG_DIR` changes the OMP user root used by the generic helpers. `PI_CODING_AGENT_DIR` is different: for the default profile it changes `getAgentDir()` consumers such as native discovery, settings, and runtime state, but it does **not** change the generic `getConfigDirs()` / `findConfigFile()` OMP base. Named profiles ignore `PI_CODING_AGENT_DIR`.

## Profiles

A named profile (`omp --profile <name>`, `OMP_PROFILE`, or the legacy fallback `PI_PROFILE`) relocates the OMP user base. `OMP_PROFILE` wins when it is defined, including when it is explicitly empty; `default`, empty, or whitespace selects the default profile. When a profile is active, every OMP-native user-level path written here as `~/.omp/agent/...` normally resolves to `~/.omp/profiles/<name>/agent/...`. `--alias <command>` does not select a profile by itself: paired with `--profile`, it creates a shell shortcut for that profile.

While a named profile is active, the status line's `pi` segment tags the brand with the profile name (`π-work`, or `⠋-work 12s` while a turn runs) so sessions from different profiles are distinguishable at a glance. The default profile shows the bare glyph. Set `statusLine.segmentOptions.pi.showProfile: false` to keep the bare glyph under every profile, for example when each profile already has its own theme.

The relocation is uniform across the native provider (`builtin.ts`) and the generic `config.ts` helpers, so it covers slash commands, rules, prompts, instructions, hooks, tools, extensions, settings, skills, and MCP, plus the top-level `SYSTEM.md` / `RULES.md` / `AGENTS.md` files and runtime state (sessions, blobs, `agent.db`). A profile sees only its own OMP config, never the default profile's agent config.

Keybindings are the one exception: a named profile merges the default profile's `~/.omp/agent/keybindings.*` under its own `~/.omp/profiles/<name>/agent/keybindings.*`, with the profile file overriding per binding ([#4867](https://github.com/can1357/oh-my-pi/issues/4867)). Keybindings describe the terminal/keyboard in front of the user, which doesn't change with the active profile, so user-level remaps keep working in every profile unless the profile explicitly overrides them. The inherited file is read-only for the profile process — legacy-format migration of the default profile's file only happens when the default profile itself runs.

On macOS and Linux, an existing `$XDG_DATA_HOME/omp`, `$XDG_STATE_HOME/omp`, or `$XDG_CACHE_HOME/omp` can relocate the corresponding data, state, or cache paths. For a named profile, OMP uses an XDG category only when that category already contains `omp/profiles/<name>`; otherwise that category remains under `~/.omp/profiles/<name>`. Run `omp config init-xdg` before relying on XDG paths.

The other source bases are not profile-scoped and load identically under every profile: the external-tool bases (`~/.claude`, `~/.codex`, `~/.gemini`) belong to those tools, and the project-level bases (`<cwd>/.omp`, `<cwd>/.claude`, ...) are keyed to the working directory. Throughout this document, read `~/.omp/agent` as shorthand for the active profile's agent directory unless an environment override or XDG path is being discussed.

## Important constraint

The generic helpers in `src/config.ts` do **not** include `.pi` in source discovery order.

---

## 2) Core discovery helpers (`src/config.ts`)

## `getConfigDirs(subpath, options)`

Returns ordered entries:

- User-level entries first (by source priority)
- Then project-level entries (by same source priority)

Options:

- `user` (default `true`)
- `project` (default `true`)
- `cwd` (default `getProjectDir()`)
- `existingOnly` (default `false`)

This API is used for directory-based config lookups (commands, hooks, tools, agents, etc.).

Disabled foreign user sources (`isUserSourceEnabled`) are omitted from the user entries; project entries are not filtered by this helper. Claude user paths honor `CLAUDE_CONFIG_DIR` (trimmed and resolved relative to the process working directory).

## `findConfigFile(subpath, options)` / `findConfigFileWithMeta(...)`

Searches for the first existing file across ordered bases, returns first match (path-only or path+metadata).

## `findAllNearestProjectConfigDirs(subpath, cwd)`

Walks parent directories upward and returns the **nearest existing directory per source base** (`.omp`, `.claude`, `.codex`, `.gemini`), then sorts results by source priority.

Use this when project config should be inherited from ancestor directories (monorepo/nested workspace behavior).

---

## 3) File config wrapper (`ConfigFile<T>` in `src/config/config-file.ts`, re-exported from `src/config.ts`)

`ConfigFile<T>` is the schema-validated loader for single config files.

Supported formats:

- `.yml` / `.yaml`
- `.json` / `.jsonc`

Behavior:

- Validates parsed data against a provided omptype schema.
- A `.yml` target falls back to its sibling `.yaml` when `.yml` is absent; an existing `.yaml` also suppresses JSON migration. A `.yaml` target does not fall back to `.yml`.
- Both `.json` and `.jsonc` are parsed as JSONC.
- Caches load result until `invalidate()`.
- Returns tri-state result via `tryLoad()`:
   - `ok`
   - `not-found`
   - `error` (`ConfigError` with schema/parse context)

Legacy migration still supported:

- If target path is `.yml`/`.yaml`, a sibling `.json` is auto-migrated once (`migrateJsonToYml`).

---

## 4) Settings resolution model (`src/config/settings.ts`)

### Definitions (`src/config/registry.ts`)

Each setting is declared once with `register({ id, type, default, env?, protocolDefault?, validate?, pathScoped?, credential?, ui? })` in its domain's settings module (for example `src/tools/settings.ts`, `src/session/settings.ts`, `src/config/model-settings.ts`). `src/config/all-settings.ts` imports every domain in settings-panel order. `register` returns a typed `Setting` handle (`cfgX`); code reads and writes through it rather than by string key:

- `cfgX.get(scope)` — effective value; `scope` is a `Settings` instance or anything carrying one (`AgentSession`, `ToolSession`). Reads are memoized per scope.
- `cfgX.set(scope, v)` — writes the **global** layer and queues a background save; values the definition's type rejects throw.
- `cfgX.unset(scope)` — removes the key from the global layer (what `omp config reset` and clearing a settings-panel text field do), so later default changes still apply.
- `cfgX.setEntry(scope, key, v)` / `cfgX.setMember(scope, item, { member })` — write one entry of a record setting (`undefined` removes it) or add/remove one item of a list setting in the global layer; the save changes only that entry or item in `config.yml`, so entries another layer (a `--config` overlay) supplies never land there.
- `cfgX.override(scope, v)` / `cfgX.clearOverride(scope)` — runtime-only override, never persisted.
- `cfgX.map(fn)` / `combine({...}, fn)` — memoized derived values; `.listen(scope, cb)` observes changes of a handle or derivation, and `.listenChanges(scope, cb)` passes `cb` each leaf setting that changed with its earlier value.
- `cfgX.provenance(scope)` — layer supplying the value: `"env" | "runtime" | "overlay" | "project" | "global" | "default"`.
- `cfgX.layered(scope)` — the value from the settings layers alone, ignoring the environment variable (what the settings panel shows and edits).

A configured value that does not fit the declared type (or enum values) is ignored with a warning and the default is used; a definition's `validate` rejects malformed values on load, on every reload, and before every write. A keep-last-good watcher reload, and a save that merges external edits to `config.yml`, keep only the invalid file's layer at its last good values (the warning names the file) while the other layers still refresh. A configured `null` generally counts as unset. Record entries such as model roles and model presets can use `null` in runtime or overlay layers as tombstones that hide lower-layer entries; project/global null entries remain unset.

### Layers (`src/config/settings.ts`)

Effective precedence, highest first:

1. Environment variable declared on the definition (`env: "NAME"`), parsed by the setting's type; unparseable text counts as unset. Booleans follow `parseFlag`: empty is unset, `1`/`y`/`true`/`yes`/`on` (lower or upper case) is true, any other text is false
2. Runtime overrides: in-memory, non-persistent
3. Config overlays: `PI_CONFIG_FILES` (platform path-list), followed by repeated `omp --config <path>` files; all are loaded as `config.yml`-style YAML for this process only
4. Project settings: discovered via the settings capability (`settings.json` and `config.yml` from providers)
5. Global settings: the first present file among `~/.omp/agent/config.yml` and `config.yaml`
6. Definition default

A definition may instead declare `env: { name, fallback: true }`: that variable only replaces the default, and any layer configuring a non-null value wins over it (used by `SEARXNG_BASIC_*`). `fallback: "blank"` also lets the variable win over a configured empty or whitespace string (used by `SEARXNG_ENDPOINT`, `SEARXNG_TOKEN`, and `MNEMOPI_EMBEDDING_MODEL`).

Within the overlay list, later files override earlier files (`PI_CONFIG_FILES` entries load before `--config` files). Overlay paths are resolved relative to the active project directory (after `~` expansion).

Definitions with `protocolDefault: ["rpc", "acp"]` make RPC/ACP hosts start from the definition default: at startup `applyProtocolDefaults` (`src/main.ts`) pins the default as a soft runtime override unless the value is already configured. The pin is released by a `cfgX.set`/`cfgX.unset`/`cfgX.setEntry`/`cfgX.setMember` of that setting (settings panel, agents hub, `cfg://`), by a reload that finds a persisted layer configuring it (a `config.yml` edit picked up by the RPC file watcher), and by a re-scope or clone into a project that configures it (an ACP session's own project config).

Subagents receive `parent.overlay(overrides)`: reads fall through to the parent live, while the overrides and any later writes stay in the child and are never persisted.

A running session follows a settings change, whether a reload (the file watcher, `reloadFromDisk`) or a write (settings panel, `cfg://`) made it, through listeners that rebuild what the setting renders: the prompt inputs (`cfgSystemPromptInputs`, e.g. `personality`), the tool gates (`cfgSessionToolGates`, e.g. `todo.enabled`, and `modelRoles` for `find`), skill and command discovery (`cfgSkillsAndCommandsDiscovery`, e.g. `disabledProviders`, and the extension sources `extensions` and `disabledExtensions`, whose `skill:<name>` entries hide skills, and which suspend or resume an extension's tools), the workspace roots, and the memory backend (`SessionMemory`: a backend apply passes `memory.backend` and the selected backend's own `<id>.*` settings that moved since the last apply, such as `hindsight.apiUrl` or `mnemopi.injectionTokenLimit`, to the memory tool swap and the prompt rebuild, and the prompt rebuild of a Hindsight state rebuilt for a `hindsight.*` edit passes the backend's own settings that moved, `withdrawMemoryRecall`; an edit the backend's own settings hook took in, a Sharpshooter edit or a Hindsight edit that rebuilt nothing, counts as applied once the hook returns, and only the apply a `memory.backend` switch starts takes the switch in, so a hook or a state rebuild that ends while the switch waits for its apply leaves the switch to it). Each passes its change (`listenChanges`) to the session. A setting none of these watch that still renders into a tool definition (`tools.maxTimeout` in the `bash`, `eval` and `lsp` descriptions, `bash.autoBackground.thresholdMs`, `eval.tools.enabled`, `task.enableEffort` in the `task` schema) or into the system prompt (`task.maxConcurrency`) starts no rebuild, so a listener on every setting (`everySetting`) passes its change too (`SessionTools.holdToolDeclarationChange`). When an active tool's definition now differs from the one the last request sent, each changed setting that gives that tool another definition, set back to its earlier value alone or kept at its new value alone while every other held or changed setting is set back (`tools.maxTimeout`, which the `bash` description states only while `async.enabled` is on), is held as below. Every prompt build records each setting it reads, with the value it read (`trackSettingsReads`): a changed setting the current prompt's build read at another value, or one the build a held prompt stands in for read, is held as below when the prompt the settings give now differs from the one the base stands for, together with each changed setting that prompt's build reads and the current one's did not; the notice gives it the value the current prompt was built with. A hold whose prompt differs from the current one also holds each earlier change its build reads that no hold took, one that moved nothing alone because the prompt renders the setting only beside another one a later change set (`dev.autoqaConsent` once `dev.autoqa` is unset, `memories.summaryInjectionTokenLimit` once `memory.backend` is `local`): a setting the current prompt's build read at another value, or one it did not read that changed since (the `everySetting` listener records each such change until the next rebuild commits), each with the value the current prompt was built with, so the notice names every setting whose change the rebuild sends. A setting the prompt surface reads (an eval prelude's gate such as `computer.enabled`, the per-call models, `skillful`) is left to that surface's own notices, and goes into the prompt with the next rebuild. Before the session's first request (no reply, no model call yet), nothing is cached and nothing is held: a changed setting the current prompt's build read at another value rebuilds the prompt at once, so the first request carries it and no rebuild after the first reply sends it later. Any other change starts nothing. The definitions the last request this process sent count only while the conversation continues from it, under the same prompt and on a branch whose newest request declared them (`/tree` to a reply whose request declared others moves away from it). In a session resumed or switched to that has sent nothing yet, or on such a branch, the definitions the last request sent are the active tools' definitions under the settings from before the change, when they give the digest of the branch's newest `tool-definitions-digest` record and the branch records the current prompt; otherwise nothing shows them, and the tools declare what they render. A hold follows the conversation to another branch: after `/tree`, a rewind, a branch or fork into a new session file, or a session switch, to a reply whose request declared other definitions than the ones the hold keeps, it keeps that branch's own, found as above under the settings from before the held change, or none, and the tools declare what they render. On a prefix-bound model that has answered under the current prompt, or whose request in flight was sent with it (the session's first request included), `SessionTools` holds that rebuild, as it holds an implicit tool-list rebuild: the system prompt keeps its bytes and each tool keeps the definition the last request before the change sent (one that renders from live settings, such as the `edit` schema under `edit.mode` or the `bash` schema under `async.enabled`, included), the registry and settings apply at once, and the next user turn carries a hidden `settings` system notice naming each changed setting with the value the prompt was built with and the value now set (a credential's values are withheld), saying the change is held and the time it goes out at the latest. A tool whose kept definition the change altered runs, until the rebuild, under the settings that definition was written for: the tool session's `settings` reads each held setting's earlier value inside its calls (writes still reach the session's settings), and so does the `tools.maxTimeout` cap on a call's `timeout` argument, applied before the call, so an `edit` call in the kept `edit.mode` shape, a `bash` call with the kept `async` parameter, or one with the default timeout the kept `bash` description states, runs as declared. A tool looked up by name is the tool as declared too: the eval bridge (`tool.<name>()` in an eval cell), an `xd://` device write and `getToolByName` (transcript renderers, the `edit` mode a subagent's progress preview reads) give it with the kept definition and its calls run under the same settings, so an eval cell's `edit` call in the kept shape passes its check and applies. What a held setting shapes in a request outside the prompt and the definitions keeps the value the bound prompt was sent with until the rebuild (`AgentSession.requestSettings`): the intent field the agent injects into each schema (`tools.intentTracing`), description pruning (`inlineToolDescriptors`) and the tool-call dialect (`tools.format`), and with them the cache check that decides whether the next request can read the prompt cache entry. The agent loop reads the intent and pruning switches at each model call, as it reads the prompt and the tools, so the rebuild changes all of them at one request, in the middle of a run included. The notice reaches every request the held prompt goes out with: after `/tree` to a reply before it, or a switch to another session, the next user turn carries it again, and a request whose context no longer holds it (a compaction between the tool calls of a run summarized it, a change made while the run's tools ran) gets it once after its newest content. A tool the change disables (a gated tool, or a memory tool the new backend lacks) stays declared and a call to it is refused with that reason until the rebuild; a tool it enables (a new backend's memory tools included) is named as available after the rebuild. An `extensions` or `disabledExtensions` edit that suspends or resumes an extension is held the same way: a tool of the suspended extension's own is disabled (declared, its calls refused), one of a resumed extension's runs again or is available after the rebuild, and a built-in the suspended extension had replaced keeps the definition the extension's tool declared until the rebuild, while its calls already run the built-in (`SessionTools.setActiveToolPresentation` with `settingsChange`). The held rebuild runs before the first main request made five minutes or more after the change, however warm requests keep the prompt cache meanwhile, or earlier: after a cut the cut rule admits that rewrites every message anyway (its kept prefix is at most the system prompt and tools: a compaction, a forced rescue; a shake or prune that keeps earlier messages does not count, nor does an image clamp), or after the prompt cache entry the cut rule reads has lapsed or the next request cannot read it (another model, thinking level, tool set, system prompt or retention), whichever comes first; any other rebuild that changes the prompt (a model switch, `/move`, a memory or skill refresh that changes it) runs it too, except one that finishes the held change in the background: the mental-model load of a Hindsight state a held `memory.backend` switch or `hindsight.*` edit installed joins the hold, and its mental models go out with the held rebuild. In a process that resumes the session while it still sends the system prompt the conversation was last sent with (see `system-prompt` in [session](./session.md)), the mental-model load of the Hindsight state the process starts with joins that prompt the same way, and its mental models go out with the process's own build when that prompt does. Each hold renders the prompt the live settings give with the tools and skill list the prompt keeps; a later rebuild that renders that prompt again (a memory backend's periodic refresh, a `skill://` read of a skill installed meanwhile, which leaves the prompt's skill list as it is) changes nothing of its own and leaves the rebuild held, and so does one after a tool was taken off the roster while the change is held (plan mode, an extension's `setActiveTools`): the held prompt takes the roster in when the tool leaves it. A forced tool-set apply that changes nothing (an extension registering a tool again with the same definition) leaves the prompt, the declarations and the hold as they are. A change of the `xd://` state, other models, and a session with no reply and no request in flight yet rebuild at once.

The hidden `settings` notice names what changed since the hold's last notice on the branch, both ways: a setting set back is named with its return, a tool an earlier notice gave as disabled whose calls run again (its backend switched back) is named as running again, and one an earlier notice gave as available after the rebuild that the rebuild no longer brings is named as not coming. A hold that ends before a notice of its last state went out (a change set back whose held rebuild came due before the next request, a resumed process that no longer keeps the held prompt) leaves its notices standing: while no change is held, the next request's hidden `settings` notice says the change those notices described is no longer held and names what they said that the current settings contradict (a setting's value, a tool given as disabled that runs again, one given as available after the rebuild that is not), once; a credential's value, which no notice records, is not compared. A call to a tool the change disables is refused with the same reason however it reaches the tool: a direct call, a call named after its mounted device (`recall` or `xd://recall` as the tool name), a Cursor exec bridge call, a `write xd://<device>` to its mounted device (denied at the approval gate, so the user is never asked first), or `tool.<name>()` in an eval cell; a `read xd://<device>` of its docs, or `read xd://<tool>/<topic>` of one of its doc topics, gives the reason too, while the system prompt still lists it. The `read xd://` listing and its device count, the devices named when a read or write names an unknown device, and the devices suggested for a mistyped tool call leave such a device out. Each hold records on the branch the settings it holds, with the values the bound prompt was built with (`system-prompt-held-settings`, see [session](./session.md)), so a process that resumes the session while it may still send that prompt (see `system-prompt` there) tells the model at its first request what the change's notices in its context did not, both ways: each held setting whose value differs now from the one they gave it, else from the one the prompt was built with (a change made after the last request before the exit, and a setting set back before the restart, included), each tool they gave as disabled that runs again, and each they gave as available after the rebuild that no longer comes. It does so too when its own build is that prompt (the change was set back, or never reached the prompt); when a record names a credential, or a setting the process does not know, it sends its own build instead.

Generic setting-handle writes target the global layer; config overlays are read-only. Model roles have explicit project-write APIs: `setProjectModelRole()` / `clearProjectModelRole()` update the project layer and persist only the changed roles to `<cwd>/.omp/config.yml`. If an existing runtime override would shadow the role, setting a project role temporarily replaces it; clearing removes that runtime slot. The original override is captured for restoration when changing project scope.

### Settings load failures

- Missing global/project YAML is treated as empty configuration.
- Invalid global or native-project YAML is moved to a unique `.broken-<timestamp>-<pid>-<uuid>` sibling under a file lock, then startup fails with the original and backup paths. An unreadable file fails without being moved.
- Every `PI_CONFIG_FILES` / `--config` overlay is strict: missing files, invalid YAML, and non-mapping document roots are hard errors. Overlay files are not quarantined.

## Migration behavior still active

On startup, if neither global `config.yml` nor `config.yaml` exists:

1. Migrate from `~/.omp/agent/settings.json` (renamed to `.bak` on success)
2. Merge with legacy DB settings from `agent.db` (DB values win conflicts)
3. Write merged result to `config.yml`

Field-level migrations in `#migrateRawSettings`:

- `queueMode` -> `steeringMode`
- Legacy flat `theme: "..."` -> `theme.dark/theme.light` structure

---

## 5) Capability/discovery integration

Most non-core config loading flows through the capability registry (`src/capability/index.ts` + `src/discovery/index.ts`).

## Provider ordering

Providers are sorted by numeric priority (higher first). Full set:

- Native OMP (`builtin.ts`): `100`
- OMP plugins (`omp-plugins`): `90`
- Claude: `80`
- Agent Plugins standard (`agent-plugins`): `75`
- Codex / agents / Claude plugins marketplace: `70`
- Gemini: `60`
- OpenCode: `55`
- Cursor / Windsurf: `50`
- Cline: `40`
- GitHub Copilot: `30`
- VS Code: `20`
- agents-md (`AGENTS.md` files) / claude-md (standalone `CLAUDE.md` files): `10`
- mcp-json / ssh-json / managed-skills (auto-learn): `5`
- Built-in default rules (`builtin-defaults`): `1`

```text
Provider precedence (higher wins)

native (.omp)           priority 100
omp-plugins             priority  90
claude                  priority  80
agent-plugins           priority  75
codex / agents /
  claude-plugins        priority  70
gemini                  priority  60
opencode                priority  55
cursor / windsurf       priority  50
cline                   priority  40
github                  priority  30
vscode                  priority  20
agents-md / claude-md   priority  10
mcp-json / ssh-json /
  managed-skills        priority   5
builtin-defaults        priority   1
```

## Dedup semantics

Capabilities define a `key(item)`:

- same key => first item wins (higher-priority/earlier-loaded item)
- no key (`undefined`) => no dedup, all items retained

Relevant keys:

- skills: `name`
- tools: `name`
- hooks: `${type}:${tool}:${name}`
- extension modules: `name`
- extensions: `name`
- settings: no dedup (all items preserved)

---

## 6) Native `.omp` provider behavior (`packages/coding-agent/src/discovery/builtin.ts`)

Native provider (`id: native`) reads native config from:

- project: `<cwd>/.omp/...`
- user: `~/.omp/agent/...`

### Directory admission rules

- Slash commands, directory rules, prompts, instructions, hooks, tools, extensions, extension modules, and settings use a project/user root only when the root directory exists and is non-empty.
- Skills scan `<ancestor>/.omp/skills` for each ancestor from the current working directory up to the repo root/home boundary, plus `~/.omp/agent/skills`, without requiring the root `.omp` directory itself to be non-empty.
- `SYSTEM.md`, `SYSTEM_TEMPLATE.md`, `RULES.md`, and `.omp/AGENTS.md` read user-level files directly and use the nearest non-empty ancestor `.omp` directory for project files. Project system-prompt entries load before user entries. `RULES.md` becomes an always-apply sticky rule. See [`docs/system-prompt-customization.md`](./system-prompt-customization.md) for the full `SYSTEM.md` / `APPEND_SYSTEM.md` contract.
- MCP does not use the non-empty-root admission helper. It reads project `.omp/mcp.json` then `.omp/.mcp.json`, followed by user `mcp.json` then `.mcp.json`, directly.

### Scope-specific loading

- Skills: `<ancestor>/.omp/skills/*/SKILL.md` and `~/.omp/agent/skills/*/SKILL.md`
- Managed skills: `~/.omp/agent/managed-skills/*/SKILL.md`, through a separate priority-5 provider; authored skills from any other provider win name collisions. Discovery is unconditional; `autolearn.enabled` gates writing/nudging, not loading.
- Slash commands: `commands/*.md`
- Rules: `rules/*.{md,mdc}` plus top-level `RULES.md`
- Prompts: `prompts/*.md`
- Instructions: `instructions/*.md`
- Hooks: `hooks/pre/*`, `hooks/post/*`
- Tools: `tools/*.{json,md,ts,js,sh,bash,py}` and `tools/<name>/index.ts`
- Extension modules: discovered under `extensions/` (+ legacy `settings.json.extensions` string array)
- Extensions: `extensions/<name>/gemini-extension.json`
- Settings capability: `settings.json`, then `config.yml`
- Context files: `.omp/AGENTS.md`; standalone ancestor `AGENTS.md` files are loaded separately by the low-priority `agents-md` provider

### Nearest-project lookup nuance

For `SYSTEM.md`, `SYSTEM_TEMPLATE.md`, `RULES.md`, and `.omp/AGENTS.md`, the native provider walks upward to the nearest non-empty project `.omp` directory.

## 7) How major subsystems consume config

## Settings subsystem

- `Settings.init()` loads the global YAML file, discovered project settings, `PI_CONFIG_FILES` / `--config` overlays, and runtime overrides in the precedence described above.
- Only capability items with `level === "project"` are merged into the project layer.

### Session title prompt override

Create `TITLE_SYSTEM.md` in any generic config base:

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
```

- Missing `TITLE_SYSTEM.md` keeps the bundled title prompts. A new session's first title then comes from a fork of its first reply: when the reply's first text or tool-call block starts, the session's own model answers `src/prompts/system/title-fork.md` as a side turn on the cached prefix, naming the title plus a card index (Nerd Fonts icon, emoji, 1-6 character code) that the window title shows as `<icon> <CODE>: <title>`. The tiny title model takes over when the fork fails, times out, declines, or the reply never starts.
- With `TITLE_SYSTEM.md` present, the first title skips the fork and comes from the tiny title model with the override, as do replan refreshes.
- Discovery checks the current project directory bases first (`<cwd>/.omp`, `.claude`, `.codex`, `.gemini`), then the user bases in the generic helper order. Unlike native `SYSTEM.md`, project title discovery does **not** walk ancestor directories.
- The override replaces only the automatic session-title generation system prompt; normal `SYSTEM.md` / `APPEND_SYSTEM.md` prompt customization is unaffected.
- The online path asks the title model to wrap the title in `<title>...</title>` and parses it leniently from text (a plain sentence, a truncated/unclosed tag, or a stray `{"title": "..."}` JSON echo all still work). A `TITLE_SYSTEM.md` override gets the wrap-in-`<title>` instruction appended after it. The local tiny-title path keeps the `<title>...</title>` prefill/stop wrapper and uses this file as its system turn.

## Skills subsystem

- `extensibility/skills.ts` loads via `loadCapability(skillCapability.id, { cwd })`.
- Applies source toggles and filters (`ignoredSkills`, `includeSkills`, custom dirs).
- Legacy-named toggles still exist (`skills.enablePiUser`, `skills.enablePiProject`) but they gate the native provider (`provider === "native"`).

## Hooks subsystem

- `discoverExtensionPaths()` (in `extensibility/extensions/loader.ts`) appends `.ts`/`.js` hook paths from the hook capability to the extension module list.
- Those modules then load and run through the extension loader and runner, like any other extension.

## Tools subsystem

- `discoverAndLoadCustomTools()` resolves tool paths from tool capability + plugin tool paths + explicit configured paths.
- Declarative `.md/.json` tool files are metadata only; executable loading expects code modules.

## Extensions subsystem

- `discoverAndLoadExtensions()` loads native extension-module capability items, JS/TS hook factories, installed-plugin entry points, and explicit configured paths.
- Ambient extension-module capability discovery is explicitly restricted to `provider: "native"`; foreign providers are not scanned for this step.

---

## 8) Precedence rules to rely on

Use this mental model:

1. Source directory ordering from `config.ts` determines candidate path order.
2. Capability provider priority determines cross-provider precedence.
3. Capability key dedup determines collision behavior (first wins for keyed capabilities).
4. Subsystem-specific merge logic can further change effective precedence (especially settings).

### Settings-specific caveat

Settings capability items are not deduplicated; `Settings.#loadProjectSettings()` deep-merges project items in returned order, so later items override earlier ones. Providers are visited from highest to lowest priority, which means lower-priority provider settings can override higher-priority settings. Within the native provider, project `config.yml` follows and overrides `settings.json`. Native `.omp/config.yml` model roles are then reapplied as the authoritative project model-role layer.

---

## 9) Legacy/compatibility behaviors still present

- `ConfigFile` JSON -> YAML migration for YAML-targeted files.
- Settings migration from `settings.json` and `agent.db` to `config.yml`.
- Field migrations cover renamed/removed settings and value-shape changes, including `queueMode`, changelog settings, flat `theme`, retired image-tool settings, task isolation/eager settings, removed edit and compaction modes, `inlineToolDescriptors`, status-line segments, provider/search settings, memories/hindsight settings, and nested-leaf renames. Consult `Settings.#migrateRawSettings()` for the current exhaustive list.
- Legacy setting names `skills.enablePiUser` / `skills.enablePiProject` are still active gates for native skill source.

If these compatibility paths are removed in code, update this document immediately; several runtime behaviors still depend on them today.
