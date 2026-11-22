#!/usr/bin/env python3
"""Ci53: read one nextest log (and, for `silent`, a zsh census).

  analyze.py summary <log>
      One line: the summary, the counts by status, UNCOMPARED/skipped lines and the tests that print them,
      then one line per test that did not pass (status, binary, name, time).
  analyze.py silent <census.tsv> <removed.log>
      The tests that started zsh in the census run and, in the run with zsh removed, passed without an
      UNCOMPARED: or skipped: line: each is a silent skip. Prints SILENT <n> and each one; n is UNKNOWN when
      the census named no test.
"""
import re
import sys
from collections import Counter

STATUS = re.compile(
    r"^\s*(PASS|FAIL|TIMEOUT|SIGSEGV|SIGABRT|SIGKILL|SIGTERM|SIGBUS|SIGILL|ABORT|LEAK|LEAK-FAIL)\s+"
    r"\[\s*([\d.]+)s\]\s+(?:\(\s*\d+/\d+\)\s+)?(\S+)\s+(\S+)\s*$"
)
HEADER = re.compile(r"^\s*[─━-]{2,}\s*STD(?:OUT|ERR):\s+(\S+)\s+(\S+)\s*$")
UNC = re.compile(r"^\s*UNCOMPARED:\s+([^:]+(?:::[^:]+)*):\s")
SKIP = re.compile(r"^\s*skipped:\s")
SUMMARY = re.compile(r"^\s*Summary \[")


def read(path):
    status, unc_lines, unc_tests, skip_lines, skip_tests, summary = {}, 0, set(), 0, set(), None
    current = None
    in_summary = False
    with open(path, errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            if SUMMARY.match(line):
                summary = line.strip()
                in_summary = True
                continue
            m = STATUS.match(line)
            if m:
                if not in_summary:
                    status[(m.group(3), m.group(4))] = (m.group(1), m.group(2))
                current = (m.group(3), m.group(4))
                continue
            m = HEADER.match(line)
            if m:
                current = (m.group(1), m.group(2))
                continue
            m = UNC.match(line)
            if m:
                unc_lines += 1
                unc_tests.add(m.group(1).strip())
                continue
            if SKIP.match(line):
                skip_lines += 1
                skip_tests.add(current[1] if current else "UNATTRIBUTED")
    return status, unc_lines, unc_tests, skip_lines, skip_tests, summary


def summary(path):
    status, unc_lines, unc_tests, skip_lines, skip_tests, summ = read(path)
    counts = Counter(s for s, _ in status.values())
    print(
        f"SUMMARY {summ or 'NO-SUMMARY'} | statuses {dict(sorted(counts.items()))} | "
        f"UNCOMPARED lines {unc_lines} tests {len(unc_tests)} | skipped lines {skip_lines} tests {len(skip_tests)}"
    )
    for (binary, name), (s, t) in sorted(status.items()):
        if s != "PASS":
            print(f"NOTPASS {s} {t}s {binary} {name}")
    for name in sorted(skip_tests):
        print(f"SKIPPED-BY {name}")


def silent(census, removed):
    started, unknown = set(), 0
    with open(census, errors="replace") as f:
        for row in f:
            parts = row.rstrip("\n").split("\t")
            if len(parts) < 2 or parts[1] == "UNKNOWN":
                unknown += 1
                continue
            started.add(parts[1])
    status, _, unc_tests, _, skip_tests, summ = read(removed)
    by_name = {}
    for (binary, name), (s, _) in status.items():
        by_name.setdefault(name, set()).add(s)
    said = unc_tests | skip_tests
    print(f"CENSUS {len(started)} tests started zsh; {unknown} zsh starts not attributed to a test")
    print(f"REMOVED {summ or 'NO-SUMMARY'}; {len(unc_tests)} tests printed UNCOMPARED, {len(skip_tests)} skipped")
    if not started:
        print("SILENT UNKNOWN: the census named no test")
        return
    missing = sorted(t for t in started if t not in by_name)
    failed = sorted(t for t in started if t in by_name and by_name[t] != {"PASS"})
    silent_tests = sorted(t for t in started if by_name.get(t) == {"PASS"} and t not in said)
    print(f"FAILED-WITHOUT-ZSH {len(failed)}")
    for t in failed:
        print(f"  FAILED {sorted(by_name[t])} {t}")
    print(f"NOT-IN-REMOVED-RUN {len(missing)}")
    for t in missing:
        print(f"  MISSING {t}")
    print(f"SILENT {len(silent_tests)}")
    for t in silent_tests:
        print(f"  SILENT {t}")


if __name__ == "__main__":
    if sys.argv[1] == "summary":
        summary(sys.argv[2])
    elif sys.argv[1] == "silent":
        silent(sys.argv[2], sys.argv[3])
    else:
        sys.exit("usage: analyze.py summary <log> | silent <census.tsv> <removed.log>")
