# Corpus schema (frozen 2026-10-30, before any extraction)

Two record kinds. One JSON object per line, UTF-8, no trailing commas, no comments.

## A. Finding records — `findings/<pr>.jsonl`

```json
{
  "id": "17399-R3-1",
  "pr": 17399,
  "round": 3,
  "head_sha": "670df28f7bf7",
  "severity": "P1",
  "title": "the request inventory still misses paid-capable remote memory paths",
  "files": ["packages/coding-agent/src/mnemopi/backend.ts:557-583"],
  "trigger": "reviewer's own words: the interleaving, input or fault that produces it",
  "measured": "verbatim measured output from the report (the actual text block, not a summary)",
  "closed": true,
  "closed_at_sha": "abc123" ,
  "closed_round": 4,
  "closed_evidence": "quote from the later round's closure table",
  "how_found_primary": "write-probe",
  "how_found": ["write-probe", "measure-timing"],
  "how_found_quote": "quote from the report that justifies the labels",
  "report_path": "/mnt/nvme/astra17399-r3/report.md",
  "report_lines": "9-44"
}
```

Rules:
- `severity`: exactly as the report gives it (`P1`, `P2`, `P3`, or `unlabelled`).
- `trigger` and `measured`: the reviewer's words. Never paraphrase `measured`. If the report
  shows a code block of output, copy it (newlines as `\n`).
- `closed`: `true` only when a later round's report in the same PR says it is closed; then fill
  `closed_at_sha` with that later round's head sha and quote the closure line. Unknown -> `false`
  with `closed_at_sha: null`.
- `report_lines`: the line range of the finding's section in the report file.

### `how_found` enum (frozen; multi-label allowed, `how_found_primary` is the strongest one present)

Ordered weakest to strongest. `how_found_primary` = the strongest label the finding needed.

1. `read-diff` — visible in the changed lines alone.
2. `read-surrounding` — needed unchanged code around the diff (callers, a second branch, an inventory sweep).
3. `run-existing-tests` — surfaced by running the repository's existing suite unchanged.
4. `historical-replay` — replayed an earlier round's probe to test a closure claim.
5. `write-probe` — wrote a new in-process test/probe that drives the production code.
6. `measure-timing` — the evidence is a measured time, clock advance or deadline.
7. `inject-fault` — injected a fault: ENOSPC, EXDEV, kill/crash, permission denial, a thrown send.
8. `two-processes-barrier` — needed two or more real processes/sessions ordered by a barrier.
9. `real-kernel-resource` — needed real kernel/filesystem behaviour: mount namespace, symlink,
   hardlink, cross-device rename, fd limits, a real syscall.

Strength order for `how_found_primary`: `real-kernel-resource` > `two-processes-barrier` >
`inject-fault` > `measure-timing` > `write-probe` > `historical-replay` > `run-existing-tests` >
`read-surrounding` > `read-diff`.

## B. False-belief records — `false-beliefs/<lane>.jsonl`

A claim the fix lane stated and a measurement then disproved.

```json
{
  "id": "FB-17399-1",
  "pr": 17399,
  "lane_report_path": "/mnt/nvme/sami/tmp/cachefix/pause-r12/report.md",
  "lane_claim": "the lane's own words",
  "claim_kind": "unreachable|enumeration-complete|residual-bounded|invariant-holds|other",
  "falsified_by": "17399-R3-2",
  "falsifying_evidence": "the measurement that disproved it, verbatim",
  "report_lines": "120-140"
}
```

`falsified_by` is a finding `id` when one matches, otherwise a short description.

## C. Verdict records — `verdicts.jsonl`

Added 2026-11-01 for a reviewer verdict that was itself wrong. A finding record
captures a defect and a false-belief record captures a fix lane's claim. Neither
captures a reviewer who obtains a real result and decides a different question.
The verdict lane uses each record with `cases-verdict.json` to score that
decision directly.

```json
{
  "id": "V-17646-r3-1",
  "head": "pr17646-r3",
  "pr": 17646,
  "round": 3,
  "head_sha": "4ef2e3be03abd33bef5c8dc5e4ad64b156617e7a",
  "coordinate": "object|quantity|domain",
  "expected": "holds|does-not-hold",
  "original_verdict": "holds|does-not-hold",
  "reviewer": {
    "agent": "the reviewer session id",
    "model": "provider/model",
    "transcript": "path to its transcript"
  },
  "claim": "the claim the reviewer was deciding",
  "instrument": "the real tool, command or measurement it used",
  "nearby_question": "what that instrument established instead",
  "wrong_verdict": [{ "source": "path and message/line", "text": "verbatim review text" }],
  "refutations": [{ "source": "path and message/line", "text": "verbatim contrary evidence" }],
  "diagnosis": { "by": "who diagnosed it", "source": "path and message/line", "text": "verbatim diagnosis" },
  "reproduced_here": "the current run against the pinned case materials"
}
```

`expected` and `original_verdict` MUST differ. `coordinate` is not a
theoretical label: it states the concrete coordinate that the original
instrument left unbound:

- `object` — it read or ran an artifact other than the one the claim names;
- `quantity` — it measured a proxy (such as a string's position) instead of
  the property claimed (such as a section containing it); or
- `domain` — it checked only a subset of the inputs covered by the claim.

Every record MUST retain the wrong verdict, a refutation and the diagnosis
where available. The record's scorer patterns belong in `cases-verdict.json`;
they MUST fire on every refutation and MUST NOT fire on the wrong verdict or
the shared prompt.
