#!/usr/bin/env python3
"""Collect every Bash-oracle script #17712 carries into corpus.jsonl.

Sources (each row keeps `source` so the table can count per source):
- tests/<file>: every script the branch's test files run (background_job_ids.rs,
  simple_command_order.rs + fixtures, background_job_cancel.rs, and the round-10
  Anthropic arm's two test files), dumped by `run_in`/`run` while the branch's
  tests ran against upstream main (dump.jsonl). Scripts one test runs in the
  same Shell one after another become one `multi` row.
- r11-openai/<set>: every case set of /mnt/durable/sami/OpenAIReview17712r11.
- r10-openai/<set>: every case set of /mnt/durable/sami/OpenAIReview17712r10.
- r10-anthropic/<file>.sh: the round-10 Anthropic arm's shell probes.
Rows with byte-identical scripts are kept once (the first source wins).

usage: build_corpus.py <dump.jsonl> <corpus.jsonl>
"""
import collections
import json
import pathlib
import sys

R11 = pathlib.Path("/mnt/durable/sami/OpenAIReview17712r11")
R10 = pathlib.Path("/mnt/durable/sami/OpenAIReview17712r10")
A10 = pathlib.Path("/mnt/durable/sami/AnthropicReview17712r10")
R11_SETS = ["fixture-cases", "job-cases", "readonly-cases", "trap-cases", "status-cases", "edge-cases",
            "lex-cases", "ambiguity-cases", "confirm-cases", "current-cases", "current-repeat-cases",
            "findings-cases", "focused-cases", "killed-current-cases", "smoke-cases", "main-controls",
            "timeout-0", "timeout-1", "timeout-2"]
R10_SETS = ["aliases", "control", "discard", "focus", "kill", "previous-job", "repro"]


def main():
    dump, out = sys.argv[1:3]
    rows, seen = [], set()

    def add(row):
        key = json.dumps(row.get("multi") or row["script"])
        if key in seen:
            return
        seen.add(key)
        rows.append(row)

    by_shell = collections.OrderedDict()
    singles = []
    for line in open(dump):
        d = json.loads(line)
        file = pathlib.Path(d["file"]).name
        if d["shell"]:
            by_shell.setdefault((file, d["test"], d["shell"]), []).append(d)
        else:
            singles.append((file, d))
    for (file, test, _), runs in by_shell.items():
        if len(runs) == 1:
            singles.append((file, runs[0]))
        else:
            add({"id": f"tests/{file}/{test}/multi{len(rows)}", "source": f"tests/{file}", "test": test,
                 "multi": [r["script"] for r in runs], "script": "\n".join(r["script"] for r in runs), "budget_ms": 60000})
    for file, d in singles:
        add({"id": f"tests/{file}/{d['test']}/{len(rows)}", "source": f"tests/{file}", "test": d["test"],
             "script": d["script"], "budget_ms": 60000})
    for name in R11_SETS:
        cases = json.load(open(R11 / f"{name}.json"))
        if isinstance(cases, dict):
            cases = [cases]
        for c in cases:
            add({"id": f"r11/{name}/{c['id']}", "source": f"r11-openai/{name}", "script": c["script"],
                 "budget_ms": c.get("budget", 30000)})
    for name in R10_SETS:
        for c in json.load(open(R10 / f"{name}.json")):
            add({"id": f"r10/{name}/{c['id']}", "source": f"r10-openai/{name}", "script": c["script"],
                 "budget_ms": c.get("timeout", 30000)})
    for sh in sorted(A10.glob("*.sh")):
        add({"id": f"a10/{sh.name}", "source": "r10-anthropic/sh", "script": sh.read_text(), "budget_ms": 120000})
    with open(out, "w") as sink:
        for row in rows:
            sink.write(json.dumps(row) + "\n")
    print(collections.Counter(r["source"] for r in rows))
    print(len(rows), "rows")


if __name__ == "__main__":
    main()
