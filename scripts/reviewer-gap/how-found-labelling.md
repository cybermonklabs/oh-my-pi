# Labelling spec: what each review brief pointed at

You label review rounds of a batch of pull-request reviews. In each round, a
coordinator wrote a **brief** for each reviewer (one or two reviewers per
round: arm `astra` on GPT-6 Astra, arm `claude` on Claude Opus 5). The
reviewers then found **defects** (real, confirmed) and raised **decoys**
(claims that looked like defects and were shown not to be).

The question this labelling answers: **for each defect, what did the brief tell
the reviewer about it before the reviewer started?** Was the defect already
stated in the brief, did the brief only point at the area, at an earlier
finding, at the user-visible loss, or at nothing?

Every label you make is checked by a program and compared with a second,
independent labeller from another model family. Do not coordinate with anyone.

## Input

One JSON bundle per round, in `<inputs>/<head>.json` (written by `how-found.ts inputs --out <inputs>`):

- `head`: the round id, for example `pr17402-r51`.
- `briefs[]`: `agent`, `arm`, `model`, `started_at`, `sha256`, `text`. The brief
  text has a `## Context` part and an `## Assignment` part. Both were written
  by the coordinator before the reviewer started.
- `defects[]`: `id`, `title`, `mechanism_summary`, `found_by` (per arm:
  `found`, `missed`, `not-run`), `finder_sections[]` (the finding reviewer's
  own words).
- `decoys[]`: `id`, `title`, `claimed_by[]` (the reviewer's words).

## Output

One JSON file per round, in `<labels>/<LABELLER>/<head>.json`
(`<LABELLER>` is given in your task). Shape:

```json
{
  "head": "pr17402-r51",
  "labeler": "<LABELLER>",
  "briefs": [
    {
      "agent": "AstraReview17402r51",
      "sha256": "<copy from the bundle>",
      "spans": [
        { "id": "s1", "element": "change", "text": "<verbatim substring of the brief text>", "adapted": "<see below>" }
      ]
    }
  ],
  "defects": [
    {
      "id": "D-17402-r51-1",
      "by_brief": {
        "AstraReview17402r51": { "pointer": ["rebreak", "area"], "spans": ["s4", "s12"], "why": "one sentence" },
        "ClaudeReview17402r51": { "pointer": [], "spans": [], "why": "one sentence" }
      }
    }
  ],
  "decoys": [ { "id": "F-...", "by_brief": { "...": { "pointer": [], "spans": [], "why": "..." } } } ]
}
```

Label **every** defect and **every** decoy against **every** brief of the round,
not only the brief of the reviewer who found it.

## Step 1: split each brief into spans

A span is a **contiguous verbatim substring** of the brief text (copy exactly:
same characters, same markdown, same backticks; a program checks
`brief.text.includes(span.text)`). Cover every sentence of the brief with
exactly one span. A sentence that mixes two elements: split it at a clause
boundary into two spans if you can; otherwise give it the element that carries
its main point. Headings (`# Change`, `# Acceptance`) can be their own span
with element `logistics`.

Elements:

| element | the span... | examples |
| --- | --- | --- |
| `loss` | names what a user or a consumer of the change would lose, get wrong, pay or see, **in their terms** — data or a copy deleted, a count reported wrong, a request sent twice, a keyboard dead, a session that cannot open — including a verdict asked for in those terms | "a reported zero can be wrong"; "an explicit verdict on whether a zero report can still be wrong"; "three paths that delete the only surviving copy" |
| `rebreak` | names an earlier round's finding, or the fix for it, or what the author now claims about it, or tells the reviewer to replay / re-run earlier reproductions or probes | "Re-run your five reproductions unchanged"; "What round 50 claims against your five: 1. Retained callbacks..." |
| `reproduction` | demands evidence from running: a reproduction, a measurement, a count, exit codes, raw output, re-measuring, comparing against the base, writing evidence to files, judging gates by recorded exit code, "with the evidence you ran" | "Judge every gate by its recorded exit code."; "Each finding closed or open with the evidence you ran" |
| `attack` | names a **new** code area, rule, mechanism or scenario to attack or audit (not an earlier finding), including lists of scenarios and "judge X", "audit Y", "read the changelog against the code" | "Attack the abort fallback. A reason that throws on copy, ..."; "Audit the five uncertain annotation groups" |
| `change` | describes what the change does or claims (not tied to an earlier finding), the gates the author ran, declared limits or costs, pull-request status | "The central change is an identity rule ..."; "Gates: check:ts exit 0 ..." |
| `logistics` | paths, trees, tool versions, environment traps, coordination, report format, model id, "do not edit" | "Bun 1.4.4 is at ..."; "Model id first." |

When a span reads as two elements, prefer in this order: `rebreak` over
`change` (a statement about an earlier finding's fix is re-break material);
`loss` over `change` (a consequence in the user's terms); `attack` over
`change` (an instruction to attack).

### `adapted`

For every span except `logistics`, write `adapted`: the span as a different
reviewer, on a different copy of the tree, could use it. Only these edits are
allowed:

- delete absolute paths, file-system locations of evidence, agent names,
  `dispatch://` links, URLs, and words that only make sense with them;
- replace "your" / "you found" when it means the original reviewer's own
  earlier work with "the earlier round's" (for example "your five
  reproductions" → "the earlier round's five reproductions").

Never add, reword or summarise anything else. A program checks that
`adapted` adds no word except `the`, `earlier`, `round`, `s`. For `logistics`,
`adapted` is `""`.

## Step 2: label each defect and decoy against each brief

For each (case, brief) give `pointer`: a list, possibly empty, of these values,
and the ids of the spans that carry them:

| pointer | when |
| --- | --- |
| `states` | some span states **this defect's mechanism** (its code-level cause: the function, the condition, the ordering, the missing check) **or its trigger** (the specific input, interleaving, fault or command that produces it), so that someone holding only that span and the diff could write the defect's title without running or searching. Also: the case is an earlier finding the brief names, and the case is that this same finding is still open. |
| `area` | some span names the code area, rule, feature or scenario family the defect lives in — "attack identity-by-handle", "audit the annotation groups", "read the changelog against the code" — **without** its mechanism or trigger. |
| `rebreak` | some span names an earlier finding or fix that this defect breaks, re-opens in a new form, or is a variant of (but does not state this defect). |
| `loss` | some span names the user-visible loss this defect causes, **without** area, mechanism or trigger. |

An empty list means the brief pointed at nothing about this case. Several
values can hold at once; list every one that holds and the spans for each.
`why`: one sentence, quoting the decisive words.

The test for `states` versus `area`: cover the defect's title. Holding only the
span and the diff, could you have written that title? Yes → `states`. You
would know where to look but not what goes wrong or how to trigger it →
`area`.

For a **decoy**, `states` means the brief says this claim is not a defect or
explains why (for example "two older tests were changed on purpose; judge
that" against a decoy that calls the changed tests a regression), or states
the claim itself.

## Rules

- Read the whole brief, both parts, before labelling.
- Judge from the brief text only. The brief was written before the round; do
  not credit it with what the reviewer later found.
- Label every round in your slice; skip none. If a bundle is broken, write
  the file anyway with what you can and say what is broken in your final
  report.
- Write valid JSON. After writing each file, check it with:
  `bun scripts/reviewer-gap/how-found.ts check --labels <labels>/<LABELLER>` from the repository root.
  It checks all heads, so heads outside your slice report "no label file":
  ignore those, fix every problem it reports for your own heads.
- Do not edit any file outside your own labels directory. Do not run tests,
  builds or reviews. Do not read or write any other labeller's directory.
