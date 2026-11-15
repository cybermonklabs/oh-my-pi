# Secret Obfuscation

Redacts sensitive values (API keys, tokens, passwords) in conversation messages sent to LLM providers. When enabled, configured secrets and built-in credential-shaped token patterns are replaced in supported message and replay text fields. Static system prompts, static tool definitions, and binary payloads are not redacted by this subsystem. Reversible placeholders are restored in model-authored tool arguments before execution and when local session context is rebuilt for display or resume.

## Enabling

Disabled by default. Toggle via `/settings` UI or directly in `config.yml`:

```yaml
secrets:
   enabled: true
```

## How it works

1. On session startup, secrets are collected from:
   - **Environment variables** whose names match common secret patterns (`KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASS`, `AUTH`, `CREDENTIAL`, `PRIVATE`, `OAUTH`) with values at least 8 characters long. `GIT_CONFIG_KEY_<n>` and `SSH_ASKPASS` are left out: they hold git configuration key names and the path of a program, not secrets.
   - **`secrets.yml` files** (see below)
   - Built-in reversible regexes for common credential shapes that appear only in session content or tool results: GitHub, GitLab, OpenAI, and Anthropic tokens, AWS access keys, Google API keys, Slack tokens, npm tokens, Stripe secret and restricted keys and webhook secrets, Hugging Face tokens, SendGrid keys, JWTs, Bearer header tokens, and PEM private key blocks
   - Passwords embedded in connection-URL environment values — any variable holding a `scheme://user:password@host`-style value (for example `DATABASE_URL`) has its password registered regardless of the variable name when it is at least 8 characters long. Both raw and percent-decoded forms are collected when they meet that limit.

2. Provider-visible text has matching values replaced with deterministic placeholders such as `$$3P8W5JH1TK2Q$$`, `$$3P8W5JH1TK2Q:L$$`, or `$$GITHUBTOKEN_3P8W5JH1TK2Q:L$$`.

3. Live model-authored tool arguments are deep-walked and placeholders are restored before the tool executes. Session context restores placeholders for local display/resume and re-obfuscates it before provider replay. Replace-mode substitutions are one-way and are not restored.

Two modes control what happens to each secret:

| Mode                  | Behavior                                                                                      | Reversible |
| --------------------- | --------------------------------------------------------------------------------------------- | ---------- |
| `obfuscate` (default) | Replaced with a deterministic `$$HASH(:hint)$$` or `$$FRIENDLY_HASH(:hint)$$` placeholder     | Yes        |
| `replace`             | Replaced with the configured `replacement`, or a deterministic same-length value when omitted | No         |

Obfuscate-mode plain values and regex matches shorter than 8 characters are ignored to avoid redacting ordinary short words. Replace mode can handle short values; a replace-mode regex with no custom replacement is rejected only when every possible 1–2 character match would be impossible to redact to a distinct stable value.

This obfuscation changes only the text sent to the model provider. The session store keeps the text the agent wrote. To mask secret values in the session store as well, see [Secrets in stored sessions](#secrets-in-stored-sessions).

## secrets.yml

Define custom secret entries in YAML. Two locations are checked:

| Level   | Path                                                                   | Purpose                                            |
| ------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| Global  | `<active-agent-dir>/secrets.yml` (normally `~/.omp/agent/secrets.yml`) | Secrets across projects using that agent directory |
| Project | `<cwd>/.omp/secrets.yml`                                               | Project-specific secrets                           |

Project entries override global entries with matching `content`. The global location follows the session's agent directory, including named profiles and explicit SDK agent-directory overrides.

### Schema

Each entry in the array has these fields:

| Field          | Type                         | Required | Description                                                   |
| -------------- | ---------------------------- | -------- | ------------------------------------------------------------- |
| `type`         | `"plain"` or `"regex"`       | Yes      | Match strategy                                                |
| `content`      | string                       | Yes      | The secret value (plain) or regex pattern (regex)             |
| `mode`         | `"obfuscate"` or `"replace"` | No       | Default: `"obfuscate"`                                        |
| `replacement`  | string                       | No       | Custom replacement (replace mode only)                        |
| `flags`        | string                       | No       | Regex flags (regex type only)                                 |
| `friendlyName` | string                       | No       | Sanitized model-visible label for obfuscate-mode placeholders |

### Examples

#### Plain secrets

```yaml
# Obfuscate a specific API key (default mode)
- type: plain
  content: sk-proj-abc123def456

# Replace a database password with a fixed string
- type: plain
  content: hunter2
  mode: replace
  replacement: "********"
```

#### Friendly names

`friendlyName` adds semantic context to reversible obfuscation placeholders without exposing the secret value:

```yaml
- type: plain
  content: github_pat_abc123def456
  friendlyName: GitHub Token
```

This produces placeholders shaped like `$$GITHUBTOKEN_3P8W5JH1TK2Q:L$$`. The friendly name is sanitized to uppercase letters and digits, capped at 32 characters, and omitted if it sanitizes to an empty value. Invalid optional `friendlyName` metadata does not disable the secret entry; the secret still obfuscates with an unlabeled placeholder. A label is also dropped for a particular placeholder if it would expose a configured literal secret or match a configured secret regex.

Native Responses replay plaintext is obfuscated too, including message text, tool arguments/results, and file/web-search text. Dynamic definitions in `mcp_list_tools`, `tool_search_output`, and `additional_tools` also redact tool/namespace descriptions, shell skill descriptions, MCP annotations, and schema descriptive annotations and examples. Schema constraints (including `enum`/`const`), execution defaults, unknown schema extensions, identifiers, authentication/routing settings, and grammars remain unchanged and outside text redaction. Static `context.tools`, system prompts, and image/file bytes are unchanged.

Native collision values are collected through the same field traversal before redaction, so a value found only in a dynamic definition or search item can invalidate an earlier friendly prefix in history or pending advisor updates. Advisors re-scrub replay and its next-compaction source after maintenance commits, including snapshots containing newly discovered values. Encrypted replay and unknown protocol variants remain opaque; encrypted history cannot be retrospectively inspected or rewritten.

The 12-character hash base is an HMAC of the exact secret under a private per-install key (stored at `~/.omp/agent/secret-placeholder.key`, or `$XDG_STATE_HOME/omp/secret-placeholder.key` on XDG-enabled installs, never sent to a model). This prevents a transcript reader from dictionary-hashing a placeholder back to its secret. Secrets that differ only by case receive independent bases, so seeing one placeholder does not let a provider synthesize another by changing the case hint. If the key cannot be persisted on the lazy built-in-token path, the session warns and uses a process-ephemeral key; obfuscation remains reversible within that process but placeholders are not stable across restarts. A case-hint suffix labels the casing of the redacted value:

| Hint | Meaning                                        |
| ---- | ---------------------------------------------- |
| `:U` | all cased ASCII letters are uppercase          |
| `:L` | all cased ASCII letters are lowercase          |
| `:C` | first cased ASCII letter uppercase, rest lower |
| `:M` | mixed ASCII casing                             |

`friendlyName` on regex entries labels the configured regex entry, not the matched value. Keep regex labels broad enough to be true for every match.

#### Regex secrets

```yaml
# Obfuscate any AWS-style key
- type: regex
  content: "AKIA[0-9A-Z]{16}"

# Case-insensitive match with explicit flags
- type: regex
  content: "api[_-]?key\\s*=\\s*\\w+"
  flags: "i"

# Regex literal syntax (pattern and flags in one string)
- type: regex
  content: "/bearer\\s+[a-zA-Z0-9._~+\\/=-]+/i"
```

Regex entries always scan globally (the `g` flag is enforced automatically). The regex literal syntax `/pattern/flags` is supported as an alternative to separate `content` + `flags` fields. Escaped slashes within the pattern (`\\/`) are handled correctly.

#### Replace mode with regex

```yaml
# One-way replace connection strings (not reversible)
- type: regex
  content: "postgres://[^\\s]+"
  mode: replace
  replacement: "postgres://***"
```

## Invalid entries and files

- A missing `secrets.yml` is treated as no entries.
- A parse failure or non-array document is ignored with a warning.
- Invalid entries are skipped individually with a warning. `type` must be `plain` or `regex`; `content` must be a non-empty string; `mode`, `replacement`, `flags`, and regex syntax are validated as shown above.
- Invalid optional `friendlyName` metadata is dropped without dropping an otherwise valid entry.

## Interaction with automatic detection

Environment variables are collected first, file-defined entries follow, and the built-in credential regex runs last so configured entries see matching content before the generic detector. Duplicate environment values are collapsed within the environment scan. Environment and file entries are not deduplicated against each other, so a plain value present in both is registered twice; both placeholders restore to the same secret, so deobfuscation is unaffected.

## Secrets in stored sessions

The session store keeps every session entry as the agent wrote it, with `file` and `sql` storage alike. A secret that a command prints is in the stored session, and `secrets.enabled` does not change that. Set `secrets.maskSessionStore` to mask the secret values the agent holds before they reach the session store:

```yaml
secrets:
   maskSessionStore: true
```

The setting is off by default and does not depend on `secrets.enabled`. When it is on, the agent replaces each value it holds with a marker that names where the value came from. A marker never holds the value.

1. `[REDACTED:env:<NAME>]`: the value of an environment variable that the name rule above takes, and the password of a connection URL in any variable.
2. `[REDACTED:file:<NAME>]`: the content of the file that an environment variable ending in `_FILE` names, and the password of a connection URL on a line of that file. `<NAME>` is the `_FILE` variable.
3. `[REDACTED:secrets.yml:<label>]`: a `secrets.yml` entry, project or global. That is a replace-mode plain value of any length, an obfuscate-mode plain value of 8 characters or more, and every match of a regex entry. `<label>` is the sanitized `friendlyName`, else `project#<n>` or `global#<n>` for the entry's position in its file.

When two sources hold the same value, the source the agent read first names it. At the first write, that is the first source in this list. When a name or a `friendlyName` contains a held value, or a regex entry matches it, the marker uses the index form instead (`#<n>`, `project#<n>`, `global#<n>`). The agent never changes its own markers, so masking a stored text again gives the same text.

The agent masks every session entry and the session header, the title slot and the title the store keeps beside it, the editor draft, the replica that a collab guest writes, and, under file storage, the title and the recaps that it records in `history.db`. It masks every string of an entry except these, which it keeps as written:

- object keys, numbers and booleans
- the fields `type`, `role`, `id`, `parentId`, `timestamp` and `toolCallId`
- the header's `cwd`, `parentSession` and `version`
- blob references and image data
- provider ciphertext: `redactedThinking` data and `encrypted_content`

The masking changes only the stored copy. The live session keeps the real values, so tools, the model provider and the screen get what they got before. A resumed session, a revived subagent and every reader of the stored transcript get the markers.

### How the values are read

- **Environment variables**: the same name rule as the obfuscator, with values of at least 8 characters.
- **`_FILE` variables**: the agent follows symbolic links and reads only a regular file of at most 1 MiB. It opens the file without blocking, so a FIFO cannot stop a write. It trims the content and keeps it when it has at least 8 characters. It matches the content of a file as one value.
- **`secrets.yml`**: the global file and the project file of each working directory the agent writes sessions for, through the same parser as the obfuscator.

The agent reads the sources at its first session write. Then, at most once a minute, it reads the environment again and checks each `_FILE` file and each `secrets.yml` for a change. It adds new values and never removes a value, so the old value of a rotated token stays masked. A source that fails (a bad `secrets.yml`, a file it cannot read) is skipped and logged. The log gives the kind and the name of each source the agent holds (`Session store masking sources`), never a value.

### Replay of a masked turn

A provider checks some blocks byte for byte when it replays a session. When masking changes a signed thinking, text or tool-call block, the stored copy has no signature. When masking changes provider replay state (`providerPayload`, an Anthropic compaction or server-tool block, Cursor history, Gemini native content), the stored copy does not keep it. Only a turn that held a secret changes. On resume, an Anthropic model gets such a thinking block as text, and a Gemini model on Vertex can refuse to resume such a turn.

### Cost

With the setting off, a session write checks one flag and does nothing more. With it on, `packages/coding-agent/bench/session-store-mask.bench.ts` measured these wall-clock times on 2026-11-15, at commit `42287d5c7d76` of the fork's release line: Bun 1.4.4, a 4-CPU container in a gVisor sandbox, the median of five runs. The typical masker holds nine values from environment variables and `_FILE` files. The heavy masker holds 59 values and five regex entries. The rewritten session has 5,000 entries, 104 MiB of serialized text, and a held value in one entry of ten.

| Case                                   | Typical masker: off → on | Heavy masker: off → on |
| -------------------------------------- | ------------------------ | ---------------------- |
| Build the masker at the first write    | 0.30 ms                  | 0.62 ms                |
| Append a 2 KB message                  | 0.05 → 0.11 ms           | 0.03 → 0.09 ms         |
| Append a 500,000-character tool result | 0.53 → 1.97 ms           | 0.50 → 9.33 ms         |
| Rewrite the 5,000-entry session        | 144 → 467 ms             | 142 → 1,016 ms         |

### What masking does not catch

Masking finds a value only where it appears exactly as the agent holds it. It does not catch:

- a value that an agent transforms: encoded (for example in base64), cut into parts, or with characters added
- a value shorter than 8 characters, except a replace-mode plain `secrets.yml` value and a match of a `secrets.yml` regex entry
- a value in no source, for example a variable set only in a child shell
- a credential in a git configuration value set through the environment (`GIT_CONFIG_VALUE_<n>`)
- the content of a `_FILE` file that is not a regular file, that the agent cannot read, that is larger than 1 MiB, or whose trimmed content is shorter than 8 characters
- a `secrets.yml` entry the parser refuses (see [Invalid entries and files](#invalid-entries-and-files))
- part of a multi-line file printed alone, because the content of a file is one value
- object keys, numbers, the working directory, ids and images
- entries written before the setting was on, and the copies of stored text that fork, move, render, `session unpack`, archive restore, `gc strip`, the title backfill into `history.db` and the `history.db` repair make (an entry written while the setting was on is masked already)
- files outside the session store: artifact files with full command output, blobs, prompt history, and logs
- text sent to the model provider, which is the work of `secrets.enabled`

A collab guest masks its replica with its own sources only.

Masking reduces the exposure of a secret. It does not remove it. To remove it, hold no long-lived secret at all, for example short-lived credentials from workload identity federation.

## Key files

- `packages/coding-agent/src/secrets/index.ts` -- loading, merging, the obfuscator build
- `packages/coding-agent/src/secrets/env-secrets.ts` -- environment variable collection
- `packages/coding-agent/src/secrets/secrets-file.ts` -- the `secrets.yml` parser and its readers
- `packages/coding-agent/src/secrets/obfuscator.ts` -- `SecretObfuscator` class, placeholder generation, message obfuscation
- `packages/coding-agent/src/secrets/regex.ts` -- regex literal parsing and compilation
- `packages/coding-agent/src/secrets/message-transform.ts` -- provider-context and local-context transforms
- `packages/coding-agent/src/secrets/patterns.ts` -- built-in credential patterns
- `packages/coding-agent/src/secrets/session-store-mask.ts` -- the values and markers of stored-session masking
- `packages/coding-agent/src/session/session-entry-mask.ts` -- which fields of a session entry are masked
- `packages/coding-agent/src/secrets/settings.ts` -- `secrets.enabled` and `secrets.maskSessionStore` setting definitions

## See also

- [`auth-broker-gateway.md`](./auth-broker-gateway.md) -- remote credential vault and forward-proxy that keep provider OAuth refresh tokens and access tokens off developer hosts entirely (complementary to in-process obfuscation).
