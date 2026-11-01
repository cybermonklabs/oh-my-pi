A reviewer asserted the defect below in a change. Nobody has checked it. Decide whether it is a real defect of this change. You are not reviewing the change for other defects.

# The change

Snapshot of the change's head, read-only, dependencies installed: {{checkout}}
The patch (`{{base}}..{{head}}`): {{diff}}
Subject: {{subject}}
The reviewer's scratch directory, read-only, with any probe it wrote: {{reviewer_scratch}}
Your own scratch directory, writable: {{scratch}}. Run a probe with `cd {{checkout}}/<package> && bun test {{scratch}}/<name>.test.ts`. `bun` is on PATH. Never run cargo or a native build; never write inside the snapshot.

# The claim

{{claim}}

# What to decide

A claim is REAL when all three hold:

1. **It happens.** The described wrong behaviour occurs at this head. Check it: run the reviewer's probe if there is one, or write the smallest probe that drives the production code, or show it from the code with the exact lines when a run cannot reach it.
2. **It is wrong.** A user or a caller of this code would call the behaviour a bug: it loses or corrupts something, sends or charges something it should not, hangs, crashes, reports something false, or breaks a promise the change itself makes in its code comments, messages, documentation or tests. A documented, deliberate choice of the change is not wrong.
3. **It belongs to this change.** The patch introduces the behaviour, or changes the code that produces it, or claims to fix it and does not. Behaviour the patch does not touch is not this change's defect.

Otherwise it is NOT-REAL, with one reason:

- `does-not-happen`: the behaviour does not occur, or the reviewer's probe does not reach the production code;
- `intended`: it occurs and the change does it on purpose, and says so;
- `outside-change`: it occurs and the patch does not touch it;
- `environment`: it occurs only because of this machine, its load, or a missing tool;
- `misread`: the claim misreads the code in a way that settles it.

Use UNDETERMINED only when you could neither run nor read your way to an answer within your budget, and say what would settle it.

Budget: {{minutes}} minutes of wall clock.

End your answer with one line of JSON and nothing after it:

{"verdict": "REAL" | "NOT-REAL" | "UNDETERMINED", "reason": "<one of the reasons above, or empty for REAL>", "evidence": "<the command and its result, or the lines that settle it, in one or two sentences>"}
