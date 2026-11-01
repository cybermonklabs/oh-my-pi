You compare one defect claim from a code review with the entries already recorded for the same commit of the same change. You only compare texts; you do not review the code.

# Recorded entries at this commit

Each `DEFECT` entry is a real defect a reviewer found and another measurement confirmed. Each `DECOY` entry is a claim a reviewer made that was shown not to be a defect.

{{cases}}

# The claim

{{claim}}

# Your decision

Name every recorded entry that is the same defect as the claim. Same defect means both of these hold:

- the same root cause in the code: the same missing check, wrong condition, wrong ordering or wrong value, in the same place;
- the same wrong behaviour that follows from it.

The claim may use other words, other identifiers, a different trigger that reaches the same root cause, a different severity, or more or less detail. That is still the same defect.

Not the same defect: a claim about the same function, file or feature whose root cause or wrong behaviour differs; a claim that only mentions the recorded entry while asserting something else; a claim that a recorded entry is fixed.

For a `DECOY` entry, the claim matches when it asserts the same thing the decoy asserted.

Answer with one line of JSON and nothing else:

{"match": ["<entry id>"], "why": "<one sentence>"}

Use `"match": []` when no entry is the same defect.
