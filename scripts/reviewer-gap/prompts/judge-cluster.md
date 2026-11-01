Below are defect claims that several independent reviewers made about the same commit of one change. Group the claims that describe the same defect. You only compare texts; you do not review the code.

Two claims describe the same defect when they name the same root cause in the code (the same missing check, wrong condition, wrong ordering or wrong value, in the same place) and the same wrong behaviour that follows from it. Different words, identifiers, triggers that reach the same root cause, or severities do not make them different. Two claims about the same function whose root causes differ are different defects.

{{claims}}

Answer with one line of JSON and nothing else: every claim number appears in exactly one group.

{"groups": [[1, 4], [2], [3, 5, 6]]}
