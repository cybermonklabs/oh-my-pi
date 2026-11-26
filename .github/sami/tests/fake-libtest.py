#!/usr/bin/env python3
"""A stand-in for a libtest binary, for libtest-bound.py's controls.

FAKE_SPEC names a JSON file: {"tests": {name: behaviour}, "segv_after": n?, "plain_lines": bool?,
"pids_file": path?}. Behaviours: "pass", "fail", "slow:S" (passes after S s), "hang" (never ends),
"lockhang" (takes the process's lock and never ends), "lock" (takes the lock, passes), "ignored",
"orphan" (passes, leaving a child that holds stdout open for 30 s), "split" (passes; a child's bytes
cut its result event in two on stdout, as a child writing to the same pipe can), "spawnhang"
(starts a `sleep 300` in a session of its own and, through a shell that exits at once, a
`sleep 300` left in the binary's process group, then never ends). It reads the options libtest
reads (--list --format terse, --exact, --skip, --ignored, --include-ignored, --test-threads N,
-Z unstable-options, --format json, --logfile PATH, filters), writes the events libtest writes, one
line per result to the logfile, and exits 0, or 101 when a test failed. With segv_after it dies
of SIGSEGV when it would start test number n. Each run appends its arguments to FAKE_LOG. With
pids_file, a run (not a --list) appends "binary <its pid>" to it, spawnhang "child <pid>" and
"orphan <pid>" as it starts each, and a test that never ends "running <its name>" once libtest's
started event for it is on stdout.
"""
import json
import os
import signal
import subprocess
import sys
import threading
import time

spec = json.load(open(os.environ["FAKE_SPEC"]))
tests = spec["tests"]
if os.environ.get("FAKE_LOG"):
    with open(os.environ["FAKE_LOG"], "a") as f:
        f.write(json.dumps(sys.argv[1:]) + "\n")
args = sys.argv[1:]
opts, filters, skips, flags, i = {}, [], [], set(), 0
while i < len(args):
    a = args[i]
    if a in ("--test-threads", "--format", "-Z", "--skip", "--logfile"):
        if a == "--skip":
            skips.append(args[i + 1])
        else:
            opts[a] = args[i + 1]
        i += 2
        continue
    if a.startswith("-"):
        flags.add(a)
    else:
        filters.append(a)
    i += 1
exact = "--exact" in flags


def matches(name, pat):
    return name == pat if exact else pat in name


names = sorted(tests)
if filters:
    names = [n for n in names if any(matches(n, p) for p in filters)]
names = [n for n in names if not any(matches(n, s) for s in skips)]
if "--ignored" in flags:
    names = [n for n in names if tests[n] == "ignored"]
if "--list" in flags:
    for n in names:
        print(f"{n}: test")
    sys.exit(0)
if opts.get("--format") != "json":
    for n in names:
        print(f"test {n} ... ok")
    sys.exit(0)
out = threading.Lock()
lock = threading.Lock()
log = open(opts["--logfile"], "a") if "--logfile" in opts else None
if log:
    # libtest's nightly answers --logfile so, on stderr, with no newline, before anything else.
    sys.stderr.write("warning: `--logfile` is deprecated")
    sys.stderr.flush()


def write(text):
    with out:
        sys.stdout.write(text)
        sys.stdout.flush()


def emit(ev):
    write(json.dumps(ev) + "\n")


def note(line):
    if spec.get("pids_file"):
        with open(spec["pids_file"], "a") as f:
            f.write(line + "\n")


note(f"binary {os.getpid()}")
emit({"type": "suite", "event": "started", "test_count": len(names)})
results = {"ok": 0, "failed": 0, "ignored": 0}
gate = threading.Semaphore(int(opts.get("--test-threads", "4")))


def result(name, ev, t0, split=False):
    if log:
        log.write(f"{ev} {name}\n")
        log.flush()
    line = json.dumps({"type": "test", "name": name, "event": ev, "exec_time": round(time.monotonic() - t0, 3)})
    if split:
        write(line[:20] + "\na child's line\n" + line[20:] + "\n")
    else:
        write(line + "\n")
    results[ev] += 1
    gate.release()


def run(name):
    b = tests[name]
    t0 = time.monotonic()
    if b == "ignored" and "--ignored" not in flags and "--include-ignored" not in flags:
        return result(name, "ignored", t0)
    if b in ("hang", "lockhang", "spawnhang"):
        if b == "lockhang":
            lock.acquire()
        if b == "spawnhang":
            child = subprocess.Popen(["sleep", "300"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, start_new_session=True)
            note(f"child {child.pid}")
            orphan = subprocess.run(["sh", "-c", "sleep 300 >/dev/null 2>&1 & echo $!"], stdin=subprocess.DEVNULL,
                                    capture_output=True, text=True).stdout.strip()
            note(f"orphan {orphan}")
        note(f"running {name}")
        while True:
            time.sleep(3600)
    if b == "lock":
        with lock:
            time.sleep(0.2)
    if b.startswith("slow:"):
        time.sleep(float(b.split(":")[1]))
    if b == "orphan":
        subprocess.Popen(["sleep", "30"], stdout=sys.stdout, stderr=sys.stderr, start_new_session=True)
    result(name, "failed" if b == "fail" else "ok", t0, split=(b == "split"))


started = time.monotonic()
workers = []
for n, name in enumerate(names):
    gate.acquire()
    if spec.get("segv_after") is not None and n == spec["segv_after"]:
        os.kill(os.getpid(), signal.SIGSEGV)
    if spec.get("plain_lines"):
        write("a child's line\n")
    emit({"type": "test", "event": "started", "name": name})
    t = threading.Thread(target=run, args=(name,), daemon=True)
    t.start()
    workers.append(t)
for t in workers:
    t.join()
emit({"type": "suite", "event": "failed" if results["failed"] else "ok", "passed": results["ok"],
      "failed": results["failed"], "ignored": results["ignored"], "measured": 0,
      "filtered_out": len(tests) - len(names), "exec_time": round(time.monotonic() - started, 3)})
sys.exit(101 if results["failed"] else 0)
