#!/usr/bin/env python3
"""Generate the expected outputs of `tests/bash_rows.rs` from real Bash.

usage: generate.py [--jobs N] [--import CORPUS] [--add GROUP FILE PREFIX]...

Reads every row of `scripts.jsonl` (`{group, id, script}`) beside this file
and runs its script as the session API's oracle runs it:
`bash --noprofile --norc -c SCRIPT`, with argv0 `bash`, stdin from
/dev/null, stdout and stderr merged into one pipe (the order a reader sees),
in a session of its own, in a fresh temporary directory that is also the
row's `TMPDIR`. The output is everything read from the pipe until it closes.
Bash 5.3.20 runs each script three times and Bash 5.2.21 five times (its
job reports race with the job's exit in some rows):
`BASH53` and `BASH52` give their paths (defaults below).

Writes one fixture per group, `<group>.jsonl`, each line
`{id, script, exit, output}` with Bash 5.3.20's normalized result, plus
`bash52: {exit, output}` when Bash 5.2.21's five results agree and differ
from it, or `bash52: {"unstable": true}` when they do not agree. The test
holds the session API to 5.3.20's; 5.2.21's is the record of where the
versions part. A row whose three 5.3.20 results are not all equal is left out of its
fixture and listed, with each result, in `unstable.jsonl` and on stderr.
A row that has not ended after `BUDGET_S` seconds is killed (its whole
session) and recorded with exit `null`.

Normalization (the same as `normalize` in `tests/bash_rows.rs`; nothing
else is rewritten): the row's temporary directory becomes `<TMP>`, a
`mktemp` name in it (`<TMP>/tmp.XXXXXXXXXX`) `<TMP>/tmp.X`, and a run of 4
or more ASCII digits with no ASCII letter, digit, `_` or `.` on either side
(a pid) `<N>`.

`--import CORPUS` first rewrites `scripts.jsonl` from the #17712 Phase A
corpus (rows whose `source` starts with `tests/`, without the `multi` rows,
which `background_job_ids.rs` tests by hand): rows keep the corpus order and
are grouped by the test that ran them. The corpus names one test `?`: those
rows are `jobs_n_lists_a_job_whose_state_changed`'s, and their scripts name
the fifo directory that test made, which becomes the row's own directory.

`--add GROUP FILE PREFIX` then appends to `scripts.jsonl` the rows of the
JSONL file FILE whose `id` starts with PREFIX, as group GROUP (rows another
slice of the #17712 port measured; `--import` and every `--add` together
rebuild `scripts.jsonl`).

Running the generator twice gives the same fixtures, as long as no row
turns unstable.
"""
import concurrent.futures
import ctypes
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
BASH53 = os.environ.get("BASH53", "/mnt/nvme/sami/scratch/SignalDeathReport/bash53/inst/bin/bash")
BASH52 = os.environ.get("BASH52", "/usr/bin/bash")
BUDGET_S = 60
RUNS_53 = 3
RUNS_52 = 5
PID = re.compile(r"(?<![A-Za-z0-9_.])[0-9]{4,}(?![A-Za-z0-9_.])")
MKTEMP = re.compile(r"<TMP>/tmp\.[A-Za-z0-9]{10}")
# Variables that would make Bash read a file at start-up.
DROPPED_ENV = ("BASH_ENV", "ENV", "PI_SHELL_PREFIX", "PI_CONFIG_FILES")
UNNAMED_TEST = "jobs_n_lists_a_job_whose_state_changed"
FIFO_DIR = re.compile(r"/[^' ]*/\.tmp[A-Za-z0-9]{6}/")


def normalize(output: str, cwd: str) -> str:
    output = output.replace(cwd, "<TMP>")
    output = MKTEMP.sub("<TMP>/tmp.X", output)
    return PID.sub("<N>", output)


def stat_fields(pid: int) -> list[str] | None:
    try:
        return open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
    except OSError:
        return None


def children(pid: int) -> list[int]:
    found = []
    try:
        tasks = os.listdir(f"/proc/{pid}/task")
    except OSError:
        return found
    for task in tasks:
        try:
            found += [int(c) for c in open(f"/proc/{pid}/task/{task}/children").read().split()]
        except OSError:
            pass
    return found


def descendants(pid: int) -> list[int]:
    found, todo = [], [pid]
    while todo:
        for child in children(todo.pop()):
            found.append(child)
            todo.append(child)
    return found


def kill_session(sid: int) -> None:
    """Kills and reaps every process left in the row's session `sid`.

    This process is a child subreaper (`PR_SET_CHILD_SUBREAPER`), so a process
    the row left behind is a descendant of Bash while Bash runs and a child of
    this process once Bash has ended: only those are looked at, never the
    whole of /proc. Bash itself (pid `sid`) is left to `Popen`.
    """
    while True:
        left = [
            pid
            for pid in descendants(sid) + children(os.getpid())
            if pid != sid and (fields := stat_fields(pid)) is not None and int(fields[3]) == sid
        ]
        if not left:
            return
        for pid in left:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for pid in left:
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass


def run(bash: str, script: str) -> dict:
    """One run of `script`; `{exit, output}`, normalized."""
    env = {k: v for k, v in os.environ.items() if k not in DROPPED_ENV}
    with tempfile.TemporaryDirectory(prefix="bash-row-") as cwd:
        cwd = os.path.realpath(cwd)
        env["TMPDIR"] = cwd
        proc = subprocess.Popen(
            ["bash", "--noprofile", "--norc", "-c", script],
            executable=bash,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=cwd,
            env=env,
            start_new_session=True,
        )
        try:
            out, _ = proc.communicate(timeout=BUDGET_S)
            status = proc.returncode
        except subprocess.TimeoutExpired:
            # A process left in the session can hold the pipe open after Bash
            # has ended, so end Bash and the whole session before reading the
            # rest.
            proc.kill()
            kill_session(proc.pid)
            out, _ = proc.communicate()
            status = None
        kill_session(proc.pid)
        # A signal-killed Bash reports 128 + the signal, as a shell would.
        if status is not None and status < 0:
            status = 128 - status
        return {"exit": status, "output": normalize(out.decode(errors="replace"), cwd)}


def measure(row: dict) -> dict:
    runs = [run(BASH53, row["script"]) for _ in range(RUNS_53)]
    return {"row": row, "bash53": runs, "bash52": [run(BASH52, row["script"]) for _ in range(RUNS_52)]}


def import_corpus(corpus: str) -> None:
    rows, counts = [], {}
    for line in open(corpus):
        r = json.loads(line)
        if not r["source"].startswith("tests/") or r.get("multi"):
            continue
        group, script = r["test"], r["script"]
        if group == "?":
            group = UNNAMED_TEST
            script = FIFO_DIR.sub("", script)
        counts[group] = counts.get(group, 0) + 1
        rows.append({"group": group, "id": f"{group}/{counts[group]}", "script": script})
    with open(HERE / "scripts.jsonl", "w") as sink:
        for row in rows:
            sink.write(json.dumps(row, ensure_ascii=False) + "\n")


def add_rows(group: str, source: str, prefix: str) -> None:
    with open(HERE / "scripts.jsonl", "a") as sink:
        count = 0
        for line in open(source):
            r = json.loads(line)
            if r["id"].startswith(prefix):
                count += 1
                row = {"group": group, "id": f"{group}/{count}", "script": r["script"]}
                sink.write(json.dumps(row, ensure_ascii=False) + "\n")


def main() -> None:
    # Orphans of a row become children of this process (see `kill_session`).
    PR_SET_CHILD_SUBREAPER = 36
    if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_CHILD_SUBREAPER)")
    args = sys.argv[1:]
    jobs = int(args[args.index("--jobs") + 1]) if "--jobs" in args else 32
    if "--import" in args:
        import_corpus(args[args.index("--import") + 1])
    for at, arg in enumerate(args):
        if arg == "--add":
            add_rows(*args[at + 1 : at + 4])
    rows = [json.loads(line) for line in open(HERE / "scripts.jsonl")]
    fixtures: dict[str, list[dict]] = {}
    unstable = []
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(jobs) as pool:
        for done, result in enumerate(pool.map(measure, rows), 1):
            row, runs, b52 = result["row"], result["bash53"], result["bash52"]
            fixtures.setdefault(row["group"], [])
            if any(r != runs[0] for r in runs):
                unstable.append({"id": row["id"], "script": row["script"], "bash53": runs})
                print(f"unstable: {row['id']}: {json.dumps(runs)}", file=sys.stderr)
                continue
            entry = {"id": row["id"], "script": row["script"], **runs[0]}
            if any(r != b52[0] for r in b52):
                entry["bash52"] = {"unstable": True}
            elif b52[0] != runs[0]:
                entry["bash52"] = b52[0]
            fixtures[row["group"]].append(entry)
            if done % 500 == 0:
                print(f"{done}/{len(rows)} rows, {time.monotonic() - started:.0f} s", file=sys.stderr)
    for old in HERE.glob("*.jsonl"):
        if old.name != "scripts.jsonl":
            old.unlink()
    for group, entries in fixtures.items():
        with open(HERE / f"{group}.jsonl", "w") as sink:
            for entry in entries:
                sink.write(json.dumps(entry, ensure_ascii=False) + "\n")
    with open(HERE / "unstable.jsonl", "w") as sink:
        for entry in unstable:
            sink.write(json.dumps(entry, ensure_ascii=False) + "\n")
    kept = sum(len(e) for e in fixtures.values())
    print(f"{len(rows)} rows: {kept} in {len(fixtures)} fixtures, {len(unstable)} unstable", file=sys.stderr)


if __name__ == "__main__":
    main()
