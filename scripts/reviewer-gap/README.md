# reviewer-gap

Measures whether a reviewer under a given prompt finds a defect that a review
on the night of 2026-10-29/30 already found, on the same head of the same pull
request.

- `corpus/` — one record per finding from those reviews, and one per lane belief
  a measurement falsified. `corpus/SCHEMA.md` is the schema; `corpus.test.ts`
  enforces it. `bun scripts/reviewer-gap/corpus.ts` prints the distributions.
- `cases.json` — the frozen subset the eval runs on: three heads whose working
  trees still exist on the box, with the mechanism and trigger patterns of each
  finding at that head. Frozen before any model call; a result must not change it.
- `prompts/` — the arms. `control.md` is empty on purpose: without it you cannot
  tell a rule from what the model does anyway.
- `run.ts` — one run per (head, arm, trial). Every arm gets the same snapshot,
  the same patch, the same tools and the same budget; only the text appended to
  the system prompt differs.
- `grade.ts` — mechanical grading, no model judge. A finding counts when every
  mechanism group and every trigger group matches inside one window of the
  report. Intervals are Wilson over findings and a cluster bootstrap over runs,
  because findings inside one run are not independent.

```bash
bun scripts/reviewer-gap/run.ts --out <dir> --arms control,current,candidate,crossfamily --trials 2 --dry-run
bun scripts/reviewer-gap/run.ts --out <dir> --arms control,current,candidate,crossfamily --trials 2 --max-time 20m --max-cost 3
bun scripts/reviewer-gap/grade.ts --runs <dir> --json <dir>/results.json
```

The snapshots `cases.json` names are read-only trees under `/mnt/nvme`. Runs
share them; each run writes only into its own scratch directory. A run that
errors is excluded from `n` and reported as `failedRuns`: a zero would penalise
the wrong arm.

## The rounds lane

The first lane answered "does the prompt close the gap" with no. This one asks
whether the review *loop* does: the night's reviews ran 3 to 11 rounds, and
every arm of the first lane was one cold round.

- `rounds-freeze.json` — arms, round prompt templates, scoring scopes, the
  symlink-class definition, the cost cap and the dropped arms with their
  reasons. Frozen and committed before the first model call of this lane.
- `run-rounds.ts` — one *sequence* per (arm, head, trial), its rounds run
  serially in fresh sessions. Round 1 is the one-round arm, so it doubles as a
  provider-drift check. It refuses to start another round once the cumulative
  spend reaches `--budget`.
- `rounds.ts` — sequence-level scoring. Detection is `detects` from `grade.ts`,
  unchanged; this file only composes it over rounds (`union`, `final`, `first`)
  and adds the paired bootstrap and Fisher's exact test. `rounds.test.ts`
  reproduces the first lane's published numbers from its committed runs, which
  is what proves the grading was not redefined.
- `rounds-audit.ts` — per-round diagnostics: report length, prompt growth,
  minutes used, whether a later round named an earlier one, probe files left.
  Never a score. It reads the probe files under `runs/<dir>/scratch/`.
- `results-rounds-2026-10-30.md` — the report. Runs at `runs/rounds-2026-10-30/`.

```bash
bun scripts/reviewer-gap/run-rounds.ts --out <dir> --arms retry-blind,rounds-carry --dry-run
bun scripts/reviewer-gap/run-rounds.ts --out <dir> --arms retry-blind,rounds-carry --concurrency 6 --budget 85
bun scripts/reviewer-gap/rounds.ts --runs scripts/reviewer-gap/runs/rounds-2026-10-30,scripts/reviewer-gap/runs/2026-10-30
bun scripts/reviewer-gap/rounds-audit.ts --runs scripts/reviewer-gap/runs/rounds-2026-10-30
```

## The re-derivation lane

A third lever: a prompt that names one defect class (a fact established at T1
is re-derived at T2 from something that can change in between) and tells a
running reviewer to enumerate every re-lookup and attack the window between.

- `prompts/rederive.md` — the candidate, 2851 characters.
- `rederive-freeze.json` — arms, strata, trials, comparisons, the guard and the
  deviations. Frozen and committed before the first recorded model call.
- `rederive-rubric.md` and `corpus/rederive-labels/` — the labelling rule, two
  independent labellers' labels of all 229 records, and the adjudication of
  every disagreement.
- `corpus/findings-b/` and `cases-b.json` — stratum B: the findings of the
  latest completed round of five pull requests, and their frozen specs.
- `snapshot.ts` — builds a read-only head snapshot whose dependencies link to a
  donor this lane owns, and `check`s that no link dangles or leaves the
  snapshot. The first two lanes' snapshots linked to reviewers' own trees, two
  of which were deleted later.
- `rederive.ts` — scoring. Per-arm rates are `gradeRuns`, paired deltas are
  `pairedCompare`, unchanged; this file selects strata, subsets and the guard
  (findings an arm's prompt satisfies by itself), and reports the class share.
- `results-rederive-2026-10-30.md` — the report. Runs at
  `runs/rederive-2026-10-30/{a,b}/<arm>/`.

```bash
bun scripts/reviewer-gap/snapshot.ts check <snapshot>...
MISE_BUN_VERSION=1.4.4 bun scripts/reviewer-gap/run.ts --out <dir>/a/rederive --arms rederive --trials 4 --concurrency 1 --max-time 20m --max-cost 6 --no-repo-gate
MISE_BUN_VERSION=1.4.4 bun scripts/reviewer-gap/run.ts --cases scripts/reviewer-gap/cases-b.json --out <dir>/b/rederive --arms rederive --trials 4 --concurrency 1 --max-time 20m --max-cost 6 --no-repo-gate
bun scripts/reviewer-gap/rederive.ts --a <a dirs> --b <b dirs> --stored scripts/reviewer-gap/runs/2026-10-30
```

One `run.ts` per arm, started together, keeps the arms in the same time window;
a second runner on the same directory takes the next unclaimed job.

## The claims lane

The first three lanes scored recall only: a finding counted when its patterns
matched anywhere in a report. That cannot see a reviewer asserting a defect
that is not there, and it credits a report that names a real defect only to
clear it. This lane's cases carry both kinds, at real heads of the batch, and
scores only what a report asserts.

- `corpus/claims/` — one record per review round, per real defect (with which
  arm found it and which missed it) and per decoy: a claim a reviewer put
  forward that a measurement, a code fact, its own withdrawal or a deliberate
  change showed was not a defect.
- `claims-build.ts` — `cases` selects heads by a written rule and writes
  `cases-c.json` from the corpus; `setup` builds each head's read-only snapshot
  and patch, and a read-only copy of the previous round's reports and probes,
  which the run prompt asks the reviewer to replay.
- `claims-freeze.json` — the rule, the counts, the run settings and the hashes,
  committed before the first model call of this lane.
- `claims.ts` — scoring. A run in the `claims` format puts each asserted defect
  under `## DEFECT:` and everything it cleared under `## NOT A DEFECT`. A finding
  is found, and a decoy asserted, when its patterns fire inside one `## DEFECT:`
  section; `detects` from `grade.ts` is unchanged. `--compare a:b` gives paired
  deltas for both rates from the same bootstrap draws.

`run.ts` now checks every head before it starts (`preflight`): a snapshot whose
dependency links dangle, a missing patch or a missing earlier-round copy stops
the run, because a reviewer that cannot run its probes scores as a weak one.

```bash
bun scripts/reviewer-gap/claims-build.ts cases
bun scripts/reviewer-gap/claims-build.ts setup
MISE_BUN_VERSION=1.4.4 bun scripts/reviewer-gap/run.ts --cases scripts/reviewer-gap/cases-c.json --out <dir> --arms current --trials 3 --concurrency 2 --max-time 20m --no-repo-gate
bun scripts/reviewer-gap/claims.ts --runs <dir> [--compare candidate:current]
```

The harness's own tests are the six `*.test.ts` files at this directory's top
level: `bun test scripts/reviewer-gap/*.test.ts`. A bare `bun test
scripts/reviewer-gap/` also collects the reviewers' recorded probes under
`runs/*/scratch/`, which are evidence, not tests of the harness.

## The brief lane

The batch's reviewers found their defects under per-round briefs the
coordinator wrote; the shipped prompt finds few of them. This lane asks which
behaviour of those briefs carries the difference: naming the user-visible
loss, naming which earlier finding to re-break, or demanding a reproduction.
`brief-arms-freeze.json` is the pre-registration: question, heads, arms,
estimator, decision rule and hashes, committed before the first session.

- `briefs.ts` — reads each review round's brief from the coordinator's
  transcripts: the `§ Context` section the subagent got and its assignment.
  The verbatim text stays outside the repository (it carries paths and links);
  `corpus/briefs.jsonl` pins each by sha256.
- `how-found.ts` and `how-found-labelling.md` — the pointer axis of "how it
  was found". Two labellers of different model families split every brief into
  spans (loss, rebreak, reproduction, attack, change, logistics) and say, per
  defect and decoy, whether the brief stated it, named its area, the earlier
  finding it re-breaks, or its user-visible loss. `check` enforces the rule
  (spans verbatim, every case labelled, adaptations only delete); `merge`
  writes `corpus/how-found.jsonl`; `index` writes `corpus/cases-index.jsonl`,
  every case with its diff, title and how it was found (method and pointer).
  The label files live beside the brief store; `corpus/how-found-labels.json`
  pins them.
- `brief-build.ts` → `cases-brief.json` — what each arm shows at each head,
  cut from the real briefs. A sentence is removed when either labeller says it
  (or the same text in the round's other brief) states a recorded case, when
  either match judge says someone holding it and the diff could write a case's
  title (`prompts/judge-leak.md`), or when a frozen pattern fires on it. Every
  removal is kept with its reason; no case is dropped. `reopens` lists the
  cases that are the still-open form of an earlier finding the kept re-break
  text names (`prompts/judge-reopen.md`), scored apart.
- `run.ts` — the arms: `shipped` and every subset of {`loss`, `rebreak`,
  `repro`} (a 2x2x2 factorial), `full-brief`, and the static forms for the
  prompt change (`static-loss`, `static-rebreak`, `static-repro`,
  `static-all`: `prompts/static-*.md` appended to the shipped prompt). On this
  lane every arm gets the same user prompt but for the brief; the shared
  prompt states the scratch directory is writable and drops the replay and
  measured-output instructions the arms test. Each record carries model
  requests, tokens, the box's load at start and end, and what its scratch kept.
- `judge.ts` — `match` (two judges must both name a recorded case for a claim
  to count), `cluster` (claims tied to no case, grouped by defect per head),
  `verify` (an agent with the snapshot and that arm's own probes decides REAL
  or NOT-REAL per group and arm). Every judgement is cached by the hash of
  what it read.
- `brief-lane.ts` — recall and precision per arm, requests, tokens and wall
  time per diff; each arm against `shipped`; the three main effects and their
  differences, defect-weighted, with 95% intervals that resample pull requests
  (head-level beside).

```bash
# once per corpus change
bun scripts/reviewer-gap/briefs.ts extract --session <coordinator session dir>
bun scripts/reviewer-gap/how-found.ts inputs --out <inputs>
#   two labellers of different families follow how-found-labelling.md into <labels>/<name>/
bun scripts/reviewer-gap/how-found.ts check --labels <labels>/<name>
bun scripts/reviewer-gap/how-found.ts merge --labels <labels>/gpt,<labels>/claude
bun scripts/reviewer-gap/how-found.ts index
bun scripts/reviewer-gap/brief-build.ts --labels <labels>/gpt,<labels>/claude --judgements <judgements>
# stage 1, then stage 2 with the arms brief-arms-freeze.json's rule picks
systemd-run --user --scope -p MemoryMax=10G -p CPUQuota=800% -- \
  bun scripts/reviewer-gap/run.ts --cases scripts/reviewer-gap/cases-c.json --briefs scripts/reviewer-gap/cases-brief.json \
  --out <runs> --arms shipped,loss,rebreak,repro,loss-rebreak,loss-repro,rebreak-repro,loss-rebreak-repro,full-brief \
  --trials 2 --heads <frozen heads> --concurrency 2 --max-time 20m --no-repo-gate --min-free-gib 45
bun scripts/reviewer-gap/judge.ts match   --runs <runs> --out <judgements>
bun scripts/reviewer-gap/judge.ts cluster --runs <runs> --out <judgements>
bun scripts/reviewer-gap/judge.ts verify  --runs <runs> --out <judgements>
bun scripts/reviewer-gap/brief-lane.ts --runs <runs> --judgements <judgements> --heads <frozen heads> --md <report.md>
```

### Adding a case

A case is a real defect, or a claim shown not to be one, at the head of a
review round whose brief survives.

1. Add the round, defect and decoy records to `corpus/claims/<pr>.jsonl` in
   the shape the existing records have: the round names its head, base and
   arms (each arm's agent id is its transcript's name); a defect quotes the
   finding reviewer's section, with mechanism and trigger patterns that fire on
   it and on nothing else at the head. `bun test scripts/reviewer-gap/claims.test.ts`
   checks both.
2. `briefs.ts extract` for the new round's agents, then label the round with
   two labellers (`how-found-labelling.md`), `check`, `merge` and `index`.
3. `claims-build.ts cases` re-selects heads by its written rule and
   `claims-build.ts setup` builds the head's snapshot, patch and earlier-round
   copy; `brief-build.ts` cuts the new head's brief texts.
4. A new head joins a measurement only through a new freeze: add it to a
   freeze file's `heads` before any session runs on it, never after results.
