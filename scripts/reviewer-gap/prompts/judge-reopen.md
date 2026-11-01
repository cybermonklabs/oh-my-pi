A coordinator told a code reviewer which earlier findings to try to re-break, in the numbered sentences below. Each names an earlier finding, or what the author says the fix for it now does. You decide which recorded entries at this commit are an earlier finding that the sentences name, still open or re-opened at this commit. You only compare texts; you do not review the code.

# What the reviewer was told to re-break

{{sentences}}

# Recorded entries at this commit

{{cases}}

# Your decision

A `DEFECT` entry re-opens a named finding when the sentences name a finding or a fix, and this entry is that same finding not closed by the fix: the same wrong behaviour still happens, through the same code path or a path the fix should have covered. An entry about a different behaviour, or one the sentences do not name, does not.

Answer with one line of JSON and nothing else:

{"reopens": [{"entry": "<entry id>", "sentences": [2]}]}

Use `"reopens": []` when no entry re-opens a named finding.
