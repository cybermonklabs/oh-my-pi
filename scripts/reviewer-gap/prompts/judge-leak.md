A coordinator will give a code reviewer the numbered sentences below before the review starts. The reviewer must not be told the answer. You check whether any sentence gives away a recorded entry. You only compare texts; you do not review the code.

# Sentences the reviewer will be given

{{sentences}}

# Recorded entries at this commit

Each `DEFECT` entry is a real defect. Each `DECOY` entry is a claim that was shown not to be a defect.

{{cases}}

# Your decision

A sentence gives away a `DEFECT` entry when it states that defect's mechanism (its code-level cause: the function, the condition, the ordering, the missing check) or its trigger (the specific input, interleaving, fault or command that produces it), so that someone holding only that sentence and the diff could write the defect's title without running or searching. Judge each sentence by that test alone, whatever kind of sentence it is: a list of attacks, a statement of what a fix claims, or a statement of what a user could lose.

A sentence gives away a `DECOY` entry when it states the decoy's claim, or says why the claim is not a defect.

Answer with one line of JSON and nothing else, listing only the sentences that give something away:

{"leaks": [{"sentence": 3, "entries": ["<entry id>"]}]}

Use `"leaks": []` when no sentence gives anything away.
