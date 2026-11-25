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


def run(td, tests, args, cfg="nextest.toml", runner_on=True, extra=None, timeout=40):
    spec, log = os.path.join(td, "spec.json"), os.path.join(td, "argv.log")
    with open(spec, "w") as f:
        json.dump({"tests": tests, **(extra or {})}, f)
    if os.path.exists(log):
        os.unlink(log)
    cmd = [fake, *args]
    if runner_on:
        cmd = [sys.executable, runner, "--nextest-config", os.path.join(td, cfg), "--package", "pkg", "--", *cmd]
    t0 = time.monotonic()
    try:
        p = subprocess.run(cmd, env=dict(os.environ, FAKE_SPEC=spec, FAKE_LOG=log), capture_output=True,
                           timeout=timeout, stdin=subprocess.DEVNULL)
        code, out, err = p.returncode, p.stdout.decode(), p.stderr.decode()
    except subprocess.TimeoutExpired as e:
        code, out, err = "timeout", (e.stdout or b"").decode(), (e.stderr or b"").decode()
    argv = [json.loads(line) for line in open(log)] if os.path.exists(log) else []
    return code, out, err, time.monotonic() - t0, argv


def suite_ends(evs):
    return [e for e in evs if e.get("type") == "suite" and e.get("event") in ("ok", "failed")]


def main():
    good = total = 0

    def case(name, cond, detail):
        nonlocal good, total
        total += 1
        good += bool(cond)
        print(f"{'ok  ' if cond else 'FAIL'} {name}: {detail}")

    with tempfile.TemporaryDirectory() as td:
        for name, d, s4 in (("nextest.toml", 2, 6), ("short.toml", 2, 2)):
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
        # stall names only the test that hangs.
        code, out, err, secs, _ = run(td, {**base, "m::a_cut": "split", "m::stuck": "hang"}, [*JSON, "--test-threads", "1"])
        failed = sorted(n for n, v in results(events(out)).items() if "failed" in v)
        case("cut-event", code == 101 and failed == ["m::stuck"], f"exit {code}, failed {failed}")

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
