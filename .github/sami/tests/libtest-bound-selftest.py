#!/usr/bin/env python3
"""Controls of libtest-bound.py, against fake-libtest.py: each case states the run it expects.

    libtest-bound-selftest.py [RUNNER] [--config PATH]

RUNNER defaults to libtest-bound.py beside this file. With --config (the tree's
.config/nextest.toml), the runner's config reader must read that file as tomllib does, where
this Python has tomllib. Prints one line per case and "SELFTEST <n> of <m> cases as expected";
exits 1 unless every case is. A copy of the runner with one of its features taken out must fail
that feature's case (the cells member's plants).
"""
import importlib.util
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time

here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
tree_config = None
if "--config" in argv:
    i = argv.index("--config")
    tree_config = argv[i + 1]
    del argv[i:i + 2]
runner = os.path.abspath(argv[0]) if argv else os.path.join(here, "..", "libtest-bound.py")
fake = os.path.join(here, "fake-libtest.py")
JSON = ["-Z", "unstable-options", "--format", "json"]


def config(default, slow4):
    return f"""[profile.default]
slow-timeout = {{ period = "1s", terminate-after = {default} }}
[[profile.default.overrides]]
filter = 'package(pkg) & test(=m::slow4)'
slow-timeout = {{ period = "1s", terminate-after = {slow4} }}
[[profile.default.overrides]]
filter = 'package(other) & test(=m::slow3)'
slow-timeout = {{ period = "1s", terminate-after = 9 }}
"""


def events(text):
    out = []
    for line in text.splitlines():
        i = line.find('{"type"')
        if i >= 0:
            try:
                out.append(json.JSONDecoder().raw_decode(line, i)[0])
            except ValueError:
                pass
    return out


def results(evs):
    res = {}
    for e in evs:
        if e.get("type") == "test" and e.get("event") in ("ok", "failed", "ignored"):
            res.setdefault(e.get("name"), []).append(e["event"])
    return res


def write_spec(td, tests, extra=None):
    spec, log = os.path.join(td, "spec.json"), os.path.join(td, "argv.log")
    with open(spec, "w") as f:
        json.dump({"tests": tests, **(extra or {})}, f)
    if os.path.exists(log):
        os.unlink(log)
    return spec, log


def env_for(spec, log, env_extra=None):
    """The fake's environment; TEST_TIMEOUT (Bazel's) only where a case gives it."""
    env = {k: v for k, v in os.environ.items() if k != "TEST_TIMEOUT"}
    return dict(env, FAKE_SPEC=spec, FAKE_LOG=log, **(env_extra or {}))


def run(td, tests, args, cfg="nextest.toml", runner_on=True, extra=None, timeout=40, env_extra=None, stdin_closed=False):
    spec, log = write_spec(td, tests, extra)
    cmd = [fake, *args]
    if runner_on:
        cmd = [sys.executable, runner, "--nextest-config", os.path.join(td, cfg), "--package", "pkg", "--", *cmd]
    t0 = time.monotonic()
    try:
        p = subprocess.run(cmd, env=env_for(spec, log, env_extra), capture_output=True, timeout=timeout,
                           stdin=subprocess.DEVNULL, preexec_fn=(lambda: os.close(0)) if stdin_closed else None)
        code, out, err = p.returncode, p.stdout.decode(), p.stderr.decode()
    except subprocess.TimeoutExpired as e:
        code, out, err = "timeout", (e.stdout or b"").decode(), (e.stderr or b"").decode()
    argv = [json.loads(line) for line in open(log)] if os.path.exists(log) else []
    return code, out, err, time.monotonic() - t0, argv


def suite_ends(evs):
    return [e for e in evs if e.get("type") == "suite" and e.get("event") in ("ok", "failed")]


def adds_up(evs):
    """(whether there is one suite end and its counts add up to the suite's test_count, its not_run)."""
    ends = suite_ends(evs)
    start = [e for e in evs if e.get("type") == "suite" and e.get("event") == "started"]
    if len(ends) != 1 or not start:
        return False, None
    e = ends[0]
    return e["passed"] + e["failed"] + e["ignored"] + e.get("not_run", 0) == start[0]["test_count"], e.get("not_run")


def pid_of(path, what):
    """The pid the fake wrote for WHAT (binary, child, orphan) in its pids file, or None."""
    try:
        for line in open(path):
            k, _, v = line.strip().partition(" ")
            if k == what and v.isdigit():
                return int(v)
    except OSError:
        pass
    return None


def gone(pid):
    """Whether pid names no live process: none, or a zombie its new parent has not reaped yet."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] == "Z"
    except FileNotFoundError:
        return os.path.isdir("/proc")
    except OSError:
        return False


def wait_gone(pids, secs=3.0):
    end = time.monotonic() + secs
    while not all(gone(p) for p in pids):
        if time.monotonic() > end:
            return False
        time.sleep(0.05)
    return True


def has_line(path, text):
    try:
        return any(line.rstrip("\n") == text for line in open(path))
    except OSError:
        return False


def command_of(pid):
    """pid's command line ("" when it cannot be read), from /proc or ps (macOS)."""
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return f.read().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        pass
    try:
        r = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=10)
    except subprocess.TimeoutExpired:
        return ""
    return r.stdout.strip()


def clean_up(pids):
    """SIGKILL to each recorded pid that still runs a process of this selftest (the fake or one of its
    `sleep 300`), so that a runner that failed to stop them leaves nothing behind; a pid reused by
    another process is left alone. Returns the pids it found running."""
    left = [p for p in pids if p and not gone(p) and any(w in command_of(p) for w in ("fake-libtest", "sleep 300"))]
    for p in left:
        try:
            os.kill(p, signal.SIGKILL)
        except OSError:
            pass
    return left


def main():
    good = total = 0

    def case(name, cond, detail):
        nonlocal good, total
        total += 1
        good += bool(cond)
        print(f"{'ok  ' if cond else 'FAIL'} {name}: {detail}")

    with tempfile.TemporaryDirectory() as td:
        for name, d, s4 in (("nextest.toml", 2, 6), ("short.toml", 2, 2), ("long.toml", 60, 60)):
            with open(os.path.join(td, name), "w") as f:
                f.write(config(d, s4))
        base = {f"m::t{i}": "pass" for i in range(8)}

        # No stall: the binary's own run, byte for byte but its timings (one thread: a fixed order).
        t = {**base, "m::bad": "fail"}
        code, out, err, _, argv = run(td, t, [*JSON, "--test-threads", "1"])
        code0, out0, _, _, _ = run(td, t, [*JSON, "--test-threads", "1"], runner_on=False)
        same = re.sub(r'"exec_time": [0-9.]+', "", out) == re.sub(r'"exec_time": [0-9.]+', "", out0)
        runs = [a for a in argv if "--list" not in a]
        case("same-run", code == code0 == 101 and same and err == "" and len(runs) == 1,
             f"exit {code} (alone {code0}), same bytes {same}, stderr {err!r}, runs {len(runs)}")

        # libtest's warning about --logfile (the fake writes it as the nightly does): the runner
        # drops it when the runner added the option, and keeps it when the caller gave it.
        code, out, _, _, _ = run(td, base, [*JSON])
        code1, out1, _, _, _ = run(td, base, [*JSON, "--logfile", os.path.join(td, "own.log")])
        warn = "warning: `--logfile` is deprecated"
        case("logfile-warning", code == code1 == 0 and warn not in out and out1.startswith(warn)
             and out1[len(warn):].startswith('{"type": "suite"'),
             f"exit {code} and {code1}, runner's option: warning {warn in out}; caller's: warning first "
             f"{out1.startswith(warn)}")

        # Plant 1: a hung test is killed and named in libtest's record, at its bound.
        t = {**base, "m::stuck": "hang", **{f"m::z{i}": "pass" for i in range(3)}}
        code, out, err, secs, argv = run(td, t, [*JSON, "--test-threads", "2"])
        evs = events(out)
        res, ends = results(evs), suite_ends(evs)
        named = [e for e in evs if e.get("name") == "m::stuck" and e.get("event") == "failed"]
        start = [e for e in evs if e.get("type") == "suite" and e.get("event") == "started"]
        add_up = bool(ends and start) and (ends[-1]["passed"] + ends[-1]["failed"] + ends[-1]["ignored"]
                                           + ends[-1].get("not_run", 0) == start[0]["test_count"])
        case("hang-named", code == 101 and res.get("m::stuck") == ["failed"] and named
             and "libtest-bound:" in named[0].get("stdout", "") and len(ends) == 1 and add_up and secs < 15,
             f"exit {code}, m::stuck {res.get('m::stuck')}, suite ends {len(ends)}, counts add up {add_up}, {secs:.1f} s")

        # Plant 2: a binary that dies of SIGSEGV is reported as that: its status, nothing added.
        code, out, err, _, _ = run(td, base, [*JSON], extra={"segv_after": 3})
        evs = events(out)
        case("segv-kept", code == 139 and not suite_ends(evs) and "libtest-bound:" not in out,
             f"exit {code}, suite ends {len(suite_ends(evs))}")

        # Plant 3: no test counted twice and nothing run again, around a stall. A held lock
        # stalls three threads; the fourth reports the other tests before the stall.
        t = {"m::a_hold": "lockhang", "m::b_wait": "lock", "m::c_wait": "lock", **base}
        code, out, err, _, argv = run(td, t, [*JSON, "--test-threads", "4"])
        res = results(events(out))
        runs = [a for a in argv if "--list" not in a]
        twice = [n for n, v in res.items() if len(v) != 1]
        case("once-each", code == 101 and not twice and len(runs) == 1
             and {n for n, v in res.items() if v == ["failed"]} == {"m::a_hold", "m::b_wait", "m::c_wait"}
             and all(res.get(n) == ["ok"] for n in base),
             f"exit {code}, counted twice {twice}, binary runs {len(runs)}, failed "
             f"{sorted(n for n, v in res.items() if v == ['failed'])}")

        # Plant 4: the bound is the config's: a 4 s test passes under its 6 s override and is
        # stopped when the file gives it 2 s.
        t = {**base, "m::slow4": "slow:4"}
        c6, out6, _, _, _ = run(td, t, [*JSON])
        c2, out2, _, _, _ = run(td, t, [*JSON], cfg="short.toml")
        case("bound-from-config", c6 == 0 and results(events(out6)).get("m::slow4") == ["ok"]
             and c2 == 101 and results(events(out2)).get("m::slow4") == ["failed"],
             f"6 s: exit {c6}; 2 s: exit {c2}")

        # An override for another package does not apply: its 3 s test is stopped at 2 s.
        code, out, _, _, _ = run(td, {**base, "m::slow3": "slow:3"}, [*JSON])
        case("other-package", code == 101 and results(events(out)).get("m::slow3") == ["failed"], f"exit {code}")

        # A result event cut by a child's bytes on stdout: the logfile still has the result, so the
        # stall names only the test that hangs, and the record gets the cut result's event, once, so
        # that the suite end adds up (1 passed, 1 failed, 8 not run, of 10).
        code, out, err, secs, _ = run(td, {**base, "m::a_cut": "split", "m::stuck": "hang"}, [*JSON, "--test-threads", "1"])
        evs = events(out)
        res, (add_up, not_run) = results(evs), adds_up(evs)
        failed = sorted(n for n, v in res.items() if "failed" in v)
        case("cut-event", code == 101 and failed == ["m::stuck"] and res.get("m::a_cut") == ["ok"] and add_up
             and not_run == 8,
             f"exit {code}, failed {failed}, m::a_cut {res.get('m::a_cut')}, counts add up {add_up}, not_run {not_run}")

        # Bazel's timeout for the target (TEST_TIMEOUT) at or below a selected test's bound: the
        # runner could never fail that test at its bound, so it refuses before the binary runs.
        t = {**base, "m::slow4": "pass"}
        c6, _, e6, _, a6 = run(td, t, [*JSON], env_extra={"TEST_TIMEOUT": "6"})
        c7, _, _, _, _ = run(td, t, [*JSON], env_extra={"TEST_TIMEOUT": "7"})
        runs6 = [a for a in a6 if "--list" not in a]
        case("outer-timeout", c6 not in (0, 101, "timeout") and "m::slow4 (6 s)" in e6 and not runs6 and c7 == 0,
             f"TEST_TIMEOUT 6: exit {c6}, binary runs {len(runs6)}, stderr {e6.strip()[:100]!r}; 7: exit {c7}")

        # An #[ignore]d test does not run without --ignored (libtest's --list still names it), so
        # its bound does not count against TEST_TIMEOUT; with --ignored it does.
        t = {**base, "m::slow4": "ignored"}
        ci, oi, _, _, _ = run(td, t, [*JSON], env_extra={"TEST_TIMEOUT": "6"})
        cj, _, ej, _, _ = run(td, t, [*JSON, "--ignored"], env_extra={"TEST_TIMEOUT": "6"})
        case("outer-timeout-ignored", ci == 0 and results(events(oi)).get("m::slow4") == ["ignored"]
             and cj not in (0, 101, "timeout") and "m::slow4 (6 s)" in ej,
             f"not run: exit {ci}, m::slow4 {results(events(oi)).get('m::slow4')}; with --ignored: exit {cj}")

        # SIGTERM, the caller's bound for the whole run (Bazel's test timeout): the binary is stopped,
        # the record names the test it was running as stopped from outside, not by its bound, and
        # the tests that had not started are not_run.
        pf = os.path.join(td, "pids-term")
        spec, log = write_spec(td, {"m::a_run": "hang", **base}, {"pids_file": pf})
        p = subprocess.Popen([sys.executable, runner, "--nextest-config", os.path.join(td, "long.toml"), "--package",
                              "pkg", "--", fake, *JSON, "--test-threads", "1"], env=env_for(spec, log),
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
        binary, code, out, secs, stopped = None, "not run", b"", 0.0, False
        try:
            # The fake's test thread writes "running" after libtest's started event is on stdout.
            for _ in range(200):
                if has_line(pf, "running m::a_run"):
                    break
                time.sleep(0.05)
            binary = pid_of(pf, "binary")
            t0 = time.monotonic()
            p.send_signal(signal.SIGTERM)
            try:
                out, _ = p.communicate(timeout=20)
                code = p.returncode
            except subprocess.TimeoutExpired:
                p.kill()
                clean_up([binary])
                try:
                    out, _ = p.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    out = b""
                code = "timeout"
            secs = time.monotonic() - t0
            stopped = bool(binary) and wait_gone([binary])
        finally:
            if p.poll() is None:
                p.kill()
            clean_up([binary or pid_of(pf, "binary")])
        evs = events(out.decode())
        res, (add_up, not_run) = results(evs), adds_up(evs)
        named = [e.get("stdout", "") for e in evs if e.get("name") == "m::a_run" and e.get("event") == "failed"]
        case("outer-stop", code == 143 and res.get("m::a_run") == ["failed"] and named[0].startswith("libtest-bound:")
             and "SIGTERM" in named[0] and add_up and not_run == 8 and stopped and secs < 10,
             f"exit {code}, m::a_run {res.get('m::a_run')}, counts add up {add_up}, not_run {not_run}, "
             f"binary stopped {stopped}, {secs:.1f} s")

        # The binary's descendants are stopped with it: a child in a session and group of its own
        # (the binary's descendant, found in the process table), and a grandchild whose parent had
        # exited (no longer the binary's descendant; still in the binary's process group).
        pf = os.path.join(td, "pids-tree")
        code, out, err, secs, _ = run(td, {**base, "m::spawner": "spawnhang"}, [*JSON, "--test-threads", "1"],
                                      extra={"pids_file": pf})
        pids = {k: pid_of(pf, k) for k in ("binary", "child", "orphan")}
        stopped = all(pids.values()) and wait_gone(list(pids.values()))
        left = clean_up(list(pids.values()))
        case("descendants-stopped", code == 101 and stopped, f"exit {code}, pids {pids}, left running {left}")

        # SIGKILL to the caller's process group (`timeout -k`, Bazel after SIGTERM's grace) reaches
        # the runner but no process in the binary's group: the guard stops the binary and its
        # descendants when the runner dies. The runner leads a group here, as the caller's.
        def kill_callers_group(name, wait_for, need, stdin_closed=False):
            pf = os.path.join(td, f"pids-kill-{name}")
            spec, log = write_spec(td, {**base, "m::spawner": "spawnhang"}, {"pids_file": pf})

            def setup():
                os.setpgrp()
                if stdin_closed:
                    os.close(0)

            p = subprocess.Popen([sys.executable, runner, "--nextest-config", os.path.join(td, "long.toml"),
                                  "--package", "pkg", "--", fake, *JSON, "--test-threads", "1"], env=env_for(spec, log),
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                                 preexec_fn=setup)
            pids, stopped = {}, False
            try:
                for _ in range(200):
                    if pid_of(pf, wait_for):
                        break
                    time.sleep(0.05)
                os.killpg(p.pid, signal.SIGKILL)
                p.wait(timeout=10)
                time.sleep(0.5)  # a descendant the binary started as it was killed has recorded itself
                pids = {k: pid_of(pf, k) for k in ("binary", "child", "orphan")}
                started = [v for v in pids.values() if v]
                stopped = all(pids[k] for k in need) and wait_gone(started, 5.0)
            finally:
                if p.poll() is None:
                    p.kill()
                left = clean_up([v for v in pids.values() if v] or [pid_of(pf, "binary")])
            return stopped, f"pids {pids}, left running after SIGKILL to the runner's group {left}"

        # Once as soon as the binary has started; once while a test runs with its descendants, which
        # must all have been there to be stopped.
        case("caller-group-killed-at-start", *kill_callers_group("at-start", "binary", ("binary",)))
        everyone = ("binary", "child", "orphan")
        case("caller-group-killed-mid-test", *kill_callers_group("mid-test", "orphan", everyone))

        # A caller that closed stdin: the guard's pipe must not land on fd 0, where the guard puts
        # /dev/null (the guard would read the run's end there and quit before the binary starts, or
        # stop it). A healthy run passes, and the guard still stops the binary at a caller-group kill.
        code, out, err, secs, _ = run(td, {**base, "m::slow2": "slow:2"}, [*JSON], cfg="long.toml", stdin_closed=True)
        guarded, detail = kill_callers_group("stdin-closed", "orphan", everyone, stdin_closed=True)
        case("stdin-closed", code == 0 and results(events(out)).get("m::slow2") == ["ok"] and guarded,
             f"exit {code}, m::slow2 {results(events(out)).get('m::slow2')}; {detail}")

        # A child holding stdout open after the binary exits does not hold the runner.
        code, out, err, secs, _ = run(td, {**base, "m::orphan": "orphan"}, [*JSON])
        case("child-holds-stdout", code == 0 and secs < 15, f"exit {code}, {secs:.1f} s")

        # Not asked for JSON: the command runs as it is, with nothing added.
        code, out, err, _, argv_log = run(td, base, ["--test-threads", "2"])
        code0, out0, err0, _, _ = run(td, base, ["--test-threads", "2"], runner_on=False)
        case("no-json", code == code0 == 0 and out == out0 and err == err0 == ""
             and not [a for a in argv_log if "--list" in a],
             f"exit {code}, same output {out == out0}, stderr {err.strip()!r}")

        # Text that is not an event passes through; the stall's record starts on a line of its own.
        code, out, err, _, _ = run(td, {**base, "m::stuck": "hang"}, [*JSON], extra={"plain_lines": True})
        lines_ok = all(line.startswith("{") or line == "a child's line" for line in out.splitlines() if line)
        case("plain-lines", code == 101 and "a child's line" in out and lines_ok, f"exit {code}")

        # The config reader: the forms the file uses, as tomllib reads them; a form it does not take
        # stops the runner, naming the line, before anything runs.
        spec = importlib.util.spec_from_file_location("libtest_bound", runner)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        try:
            import tomllib
        except ImportError:
            tomllib = None
        paths = [os.path.join(td, "nextest.toml"), os.path.join(td, "short.toml")] + ([tree_config] if tree_config else [])
        same = []
        for p in paths:
            mine = mod.read_config(p)
            if tomllib:
                with open(p, "rb") as f:
                    same.append(mine == tomllib.load(f))
        case("config-reader", all(same) and (not tree_config or tomllib is None or len(same) == 3),
             f"files {len(paths)}, as tomllib reads them {same if tomllib else 'no tomllib here'}")
        with open(os.path.join(td, "odd.toml"), "w") as f:
            f.write('[profile.default]\nslow-timeout = { period = "1s", terminate-after = 2 }\n'
                    'default-filter = [\n  "all()",\n]\n')
        code, out, err, _, argv_log = run(td, base, [*JSON], cfg="odd.toml")
        case("config-unknown-form", code not in (0, 101) and "odd.toml:3" in err and not argv_log,
             f"exit {code}, stderr {err.strip()[:120]!r}, binary runs {len(argv_log)}")
    print(f"SELFTEST {good} of {total} cases as expected")
    return 0 if good == total else 1


if __name__ == "__main__":
    sys.exit(main())
