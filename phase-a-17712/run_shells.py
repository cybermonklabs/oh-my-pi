#!/usr/bin/env python3
"""Run every corpus row as a script on standard input through one shell.

usage: run_shells.py <runner> <corpus.jsonl> <out.jsonl> [--jobs N] [--ids file]

<runner> is bash52, bash53 (script on stdin), bash52c, bash53c (`bash -c script`,
the oracle for the session API, which runs each call with `-c` semantics) or
obash (stdin). Each row runs in a fresh
temporary directory, in a session of its own, with stdout and stderr merged
into one pipe (the order a reader sees), bounded by the row's budget. After
the row, every process still in its session is killed by exact pid, and any
pid the script wrote to a `*.pid` file there.
"""
import concurrent.futures
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time

SHELLS = {
    "bash52": ["/usr/bin/bash", "--noprofile", "--norc"],
    "bash53": ["/mnt/nvme/sami/scratch/SignalDeathReport/bash53/inst/bin/bash", "--noprofile", "--norc"],
    "bash52c": ["/usr/bin/bash", "--noprofile", "--norc", "-c"],
    "bash53c": ["/mnt/nvme/sami/scratch/SignalDeathReport/bash53/inst/bin/bash", "--noprofile", "--norc", "-c"],
    "obash": [os.environ.get("OBASH", "/mnt/nvme/sami/scratch/SignalDeathReport/target-main/debug/obash")],
}
SCRATCH = pathlib.Path("/mnt/nvme/sami/scratch/SignalDeathReport/Port17712-2/rows")


def session_pids(sid, cwd=None):
    pids = []
    for entry in os.listdir("/proc"):
        if entry.isdigit():
            try:
                fields = open(f"/proc/{entry}/stat").read().rsplit(")", 1)[1].split()
            except OSError:
                continue
            if int(fields[3]) == sid:
                pids.append(int(entry))
                continue
            try:
                if cwd and os.readlink(f"/proc/{entry}/cwd").startswith(cwd):
                    pids.append(int(entry))
            except OSError:
                pass
    return pids


def run_row(argv, row):
    SCRATCH.mkdir(parents=True, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if k not in ("PI_SHELL_PREFIX", "BASH_ENV", "ENV", "PI_CONFIG_FILES")}
    env["TMPDIR"] = str(SCRATCH)
    budget = row.get("budget_ms", 30000) / 1000
    with tempfile.TemporaryDirectory(dir=SCRATCH) as cwd:
        start = time.monotonic()
        dash_c = argv[-1] == "-c"
        full = argv + [row["script"]] if dash_c else argv
        proc = subprocess.Popen(full, stdin=subprocess.DEVNULL if dash_c else subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                cwd=cwd, env=env, start_new_session=True)
        result = {"id": row["id"]}
        try:
            out, _ = proc.communicate(None if dash_c else row["script"].encode(), timeout=budget)
            result.update(exit=proc.returncode, output=out.decode(errors="replace"))
        except subprocess.TimeoutExpired:
            proc.kill()
            out, _ = proc.communicate()
            result.update(exit=None, timed_out=True, output=out.decode(errors="replace"))
        for pid in session_pids(proc.pid, cwd):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for file in pathlib.Path(cwd).rglob("*.pid"):
            for word in file.read_text(errors="replace").split():
                if word.isdigit():
                    try:
                        os.kill(int(word), signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
        result["ms"] = round((time.monotonic() - start) * 1000)
        result["cwd"] = cwd
    return result


def main():
    runner, corpus, out = sys.argv[1:4]
    jobs = int(sys.argv[sys.argv.index("--jobs") + 1]) if "--jobs" in sys.argv else 64
    ids = None
    if "--ids" in sys.argv:
        ids = set(open(sys.argv[sys.argv.index("--ids") + 1]).read().split("\n")) - {""}
    rows = [json.loads(line) for line in open(corpus)]
    rows = [r for r in rows if ids is None or r["id"] in ids]
    argv = SHELLS[runner]
    with open(out, "w") as sink, concurrent.futures.ProcessPoolExecutor(jobs) as pool:
        for result in pool.map(run_row, [argv] * len(rows), rows, chunksize=4):
            sink.write(json.dumps(result) + "\n")
            sink.flush()


if __name__ == "__main__":
    main()
