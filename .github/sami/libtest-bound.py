#!/usr/bin/env python3
"""Runs one libtest binary in one process, as its caller asked, under the tree's bound per test.

    libtest-bound.py --nextest-config PATH --package NAME -- BINARY [LIBTEST ARGUMENTS...]

The tree's .config/nextest.toml holds the one time bound per test: its default profile's
slow-timeout (period times terminate-after) and the overrides that name one test. nextest applies
it to a test in a process of its own. A binary run whole, in one libtest process, has no bound
per test, so one test that never ends holds the run until the caller's bound for the whole binary,
and the run then names nothing. This runner gives that run the tree's bound and names the tests.

The command runs as it is, and its output passes through unchanged, so a run in which libtest keeps
reporting is the same run, byte for byte. The arguments must ask for libtest's JSON events
(-Z unstable-options --format json); the runner reads them as they come, and adds --logfile (a file
of its own, which no child of the binary can write to) to read each result. libtest's nightly
answers that option with "warning: `--logfile` is deprecated" before anything else; the runner
drops that warning, which its own option caused (a --logfile the caller gives keeps its warning).
When libtest has started tests it has not reported, and has reported nothing for the longest bound
among them, the binary has stopped making progress: every test it is running has run past its bound,
or libtest
itself is stuck. The runner then stops the binary (SIGKILL to it and the processes it started),
waits for it, and ends the record: a `failed` event for each test libtest started and did not
report, saying why, and one suite end whose counts add up. It runs nothing again: the tests that
had not started have no result, and the suite end gives their number as `not_run`. The exit code is
then 101, libtest's code for failed tests.

A binary that dies on its own keeps its exit status (128 plus the signal, as a shell reports it),
and the runner adds nothing to its record. A command that does not ask for JSON runs as it is,
with nothing added. One that asks for JSON but whose `--list` fails is no libtest binary: it runs
as it is, after one line on stderr saying it has no bound per test.
"""
import json
import os
import re
import select
import signal
import subprocess
import sys
import tempfile
import time

VALUED = {"--logfile", "--test-threads", "--skip", "--color", "--format", "--shuffle-seed", "-Z"}
SELECTING = {"--exact", "--ignored", "--include-ignored", "--exclude-should-panic"}
EVENT_START = re.compile(r'\{ ?"type": ?"(test|suite|bench)"')
NOTE = "libtest-bound:"
GRACE = 2.0
LOGFILE_WARNING = b"warning: `--logfile` is deprecated"


def split_args(args):
    """(options as (flag, value or None) pairs, positional filters), as libtest's getopts reads them."""
    opts, filters, i = [], [], 0
    while i < len(args):
        a = args[i]
        if a in VALUED:
            opts.append((a, args[i + 1] if i + 1 < len(args) else None))
            i += 2
            continue
        if a.startswith("-Z") and len(a) > 2:
            opts.append(("-Z", a[2:]))
        elif a.startswith("--") and "=" in a and a.split("=", 1)[0] in VALUED:
            opts.append(tuple(a.split("=", 1)))
        elif a.startswith("-"):
            opts.append((a, None))
        else:
            filters.append(a)
        i += 1
    return opts, filters


def asks_json(opts):
    fmt = [v for k, v in opts if k == "--format"]
    return bool(fmt) and fmt[-1] == "json" and ("-Z", "unstable-options") in opts


class ConfigError(Exception):
    pass


TOKEN = re.compile(r"""\s*(?:'([^'\n]*)'|"([^"\\\n]*)"|(-?\d+)\b|(true|false)\b|([A-Za-z0-9_-]+)|([{},=]))""")


def read_config(path):
    """A nextest config as nested dicts, for the forms .config/nextest.toml uses: `[a.b]` and
    `[[a.b.c]]` headers, `#` comments, and `key = value` on one line, the value a string ('...', or
    "..." without escapes), an integer, true, false or an inline table of those. Any other line is
    an error, so a form this reader does not know is refused, never misread. (Python 3.9, macOS's,
    has no tomllib; the selftest checks this reader against tomllib on the tree's own file.)"""
    root, cur = {}, None
    for n, raw in enumerate(open(path, encoding="utf-8"), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            m = re.fullmatch(r"(\[\[?)\s*([A-Za-z0-9_.-]+)\s*(\]\]?)", line)
            if m:
                if len(m.group(1)) != len(m.group(3)):
                    raise ConfigError("an unbalanced header")
                *parents, last = m.group(2).split(".")
                node = root
                for p in parents:
                    node = node.setdefault(p, {})
                if m.group(1) == "[[":
                    cur = {}
                    node.setdefault(last, []).append(cur)
                else:
                    cur = node.setdefault(last, {})
                continue
            if cur is None:
                raise ConfigError("a key outside a table")
            toks, pos = [], 0
            while pos < len(line):
                if line[pos:].lstrip().startswith("#"):
                    break
                t = TOKEN.match(line, pos)
                if not t or t.end() == pos:
                    raise ConfigError(f"cannot read {line[pos:]!r}")
                toks.append(t)
                pos = t.end()

            def value(i):
                t = toks[i]
                if t.group(1) is not None or t.group(2) is not None:
                    return (t.group(1) if t.group(1) is not None else t.group(2)), i + 1
                if t.group(3):
                    return int(t.group(3)), i + 1
                if t.group(4):
                    return t.group(4) == "true", i + 1
                if t.group(6) == "{":
                    table, i = {}, i + 1
                    while toks[i].group(6) != "}":
                        k = toks[i].group(5)
                        if k is None or toks[i + 1].group(6) != "=":
                            raise ConfigError("an inline table without key = value")
                        table[k], i = value(i + 2)
                        if toks[i].group(6) == ",":
                            i += 1
                    return table, i + 1
                raise ConfigError(f"a value this reader does not take: {t.group(0).strip()!r}")

            key = toks[0].group(5) or toks[0].group(1) or toks[0].group(2)
            if key is None or toks[1].group(6) != "=":
                raise ConfigError("not key = value")
            cur[key], end = value(2)
            if end != len(toks):
                raise ConfigError("text after the value")
        except (ConfigError, IndexError) as e:
            raise SystemExit(f"{NOTE} {path}:{n}: {e or 'an unfinished value'}: {line}")
    return root


def bounds_from(config, package):
    """(the default profile's bound in seconds, {test name: bound}) from a nextest config."""
    prof = read_config(config).get("profile", {}).get("default", {})

    def seconds(st):
        if not isinstance(st, dict) or "period" not in st or "terminate-after" not in st:
            raise SystemExit(f"{NOTE} {config}: a slow-timeout needs a period and terminate-after: {st!r}")
        m = re.fullmatch(r"(\d+)s", str(st["period"]))
        if not m:
            raise SystemExit(f"{NOTE} {config}: a period not in whole seconds: {st['period']!r}")
        return int(m.group(1)) * int(st["terminate-after"])

    if "slow-timeout" not in prof:
        raise SystemExit(f"{NOTE} {config}: the default profile has no slow-timeout")
    per_test = {}
    for o in prof.get("overrides", []):
        if "slow-timeout" not in o:
            continue
        m = re.fullmatch(r"(?:package\(([^()]+)\) & )?test\(=([^()]+)\)", str(o.get("filter", "")).strip())
        if not m:
            raise SystemExit(f"{NOTE} {config}: an override with a slow-timeout names its tests in a filter "
                             f"this runner cannot read: {o.get('filter')!r}")
        if m.group(1) in (None, package):
            per_test[m.group(2)] = seconds(o["slow-timeout"])
    return seconds(prof["slow-timeout"]), per_test


def count_listed(binary, opts, filters):
    """How many tests the arguments select (libtest's --list, terse), or None when --list fails."""
    sel = [x for x in opts if x[0] in SELECTING or x[0] in ("--skip", "-Z")]
    flat = [y for k, v in sel for y in ((k,) if v is None else (k, v))]
    r = subprocess.run([binary, *flat, *filters, "--list", "--format", "terse"], stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, errors="replace")
    if r.returncode != 0:
        return None
    return sum(1 for line in r.stdout.splitlines() if line.endswith((": test", ": benchmark")))


def proc_table():
    """{pid: (ppid, pgrp, state)} from /proc ({} when it cannot be read)."""
    table = {}
    try:
        entries = os.listdir("/proc")
    except OSError:
        return table
    for e in entries:
        if e.isdigit():
            try:
                with open(f"/proc/{e}/stat") as f:
                    s = f.read()
            except OSError:
                continue
            rest = s[s.rfind(")") + 2:].split()
            table[int(e)] = (int(rest[1]), int(rest[2]), rest[0])
    return table


def stop(pid):
    """SIGKILL to pid and every process it started, in any group or session; returns how many."""
    me = os.getpid()
    killed = set()
    for _ in range(4):
        table = proc_table()
        kids = {}
        for q, (pp, _, _) in table.items():
            kids.setdefault(pp, []).append(q)
        todo = [pid, *killed]
        found = set()
        while todo:
            q = todo.pop()
            if q in found or q == me:
                continue
            found.add(q)
            todo += kids.get(q, [])
        new = {q for q in found - killed if q in table or q == pid}
        if not new:
            break
        for q in new:
            try:
                os.kill(q, signal.SIGKILL)
            except OSError:
                pass
        killed |= new
    return len(killed)


class Binary:
    """The binary's one run: its output goes to stdout as it comes; its events are read."""

    def __init__(self, cmd, logfile, drop_warning):
        self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT)
        self.fd = self.proc.stdout.fileno()
        os.set_blocking(self.fd, False)
        self.logfile, self.logpos, self.logbuf = logfile, 0, b""
        # The first bytes, held until they show whether they are libtest's warning about the
        # --logfile the runner added (libtest writes it before anything else, without a newline).
        self.head = b"" if drop_warning else None
        self.buf = b""
        self.last_byte = b"\n"
        self.started = {}  # name -> monotonic time libtest started it
        self.reported = {}  # name -> "ok" | "failed" | "ignored", from stdout's events or the logfile
        self.in_record = {}  # the results stdout's record holds, which the suite end must add up to
        self.last = time.monotonic()
        self.eof = False

    def read(self):
        try:
            data = os.read(self.fd, 65536)
        except BlockingIOError:
            return
        if not data:
            self.eof = True
            self.take_head(final=True)
            return
        if self.head is not None:
            self.head += data
            self.take_head()
            return
        self.take(data)

    def take_head(self, final=False):
        if self.head is None:
            return
        head = self.head
        if not final and len(head) <= len(LOGFILE_WARNING) and LOGFILE_WARNING.startswith(head):
            return
        self.head = None
        if head.startswith(LOGFILE_WARNING):
            head = head[len(LOGFILE_WARNING):]
            if head.startswith(b"\n"):
                head = head[1:]
        if head:
            self.take(head)

    def take(self, data):
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        self.last_byte = data[-1:]
        self.buf += data
        *lines, self.buf = self.buf.split(b"\n")
        for line in lines:
            self.event(line.decode("utf-8", "replace"))

    def event(self, text):
        m = EVENT_START.search(text)
        if not m:
            return
        try:
            ev, _ = json.JSONDecoder().raw_decode(text, m.start())
        except ValueError:
            return
        if not isinstance(ev, dict) or ev.get("type") != "test":
            return
        name, e = ev.get("name"), ev.get("event")
        if e == "started" and name not in self.reported:
            self.started[name] = time.monotonic()
            self.last = time.monotonic()
        elif e in ("ok", "failed", "ignored"):
            self.in_record.setdefault(name, e)
            self.result(name, e)

    def result(self, name, e):
        if name not in self.reported:
            self.reported[name] = e
            self.last = time.monotonic()

    def read_log(self):
        """libtest's --logfile: one line per result, `<ok|failed[: message]|ignored[: message]> <name> [<time>]`."""
        try:
            with open(self.logfile, "rb") as f:
                f.seek(self.logpos)
                data = f.read()
        except OSError:
            return
        self.logpos += len(data)
        self.logbuf += data
        *lines, self.logbuf = self.logbuf.split(b"\n")
        for raw in lines:
            words = raw.decode("utf-8", "replace").split()
            if words and words[-1].startswith("<") and words[-1].endswith(">"):
                words = words[:-1]
            if len(words) >= 2:
                kind = words[0].rstrip(":")
                if kind in ("ok", "failed", "ignored"):
                    self.result(words[-1], kind)

    def unreported(self):
        return {n: t for n, t in self.started.items() if n not in self.reported}

    def finish(self):
        """Waits for the process, then reads what is left, for at most GRACE s: a child may hold the pipe."""
        code = self.proc.wait()
        end = time.monotonic() + GRACE
        while not self.eof and time.monotonic() < end:
            r, _, _ = select.select([self.fd], [], [], max(0.0, end - time.monotonic()))
            if r:
                self.read()
        self.take_head(final=True)
        if self.buf:
            self.event(self.buf.decode("utf-8", "replace"))
            self.buf = b""
        self.read_log()
        self.proc.stdout.close()
        return code


def emit(ev):
    sys.stdout.write(json.dumps(ev) + "\n")
    sys.stdout.flush()


def main(argv):
    if "--" not in argv:
        raise SystemExit(__doc__)
    i = argv.index("--")
    head, cmd = argv[:i], argv[i + 1:]
    conf = dict(zip(head[0::2], head[1::2]))
    if len(head) % 2 or set(conf) - {"--nextest-config", "--package"} or len(conf) != 2 or not cmd:
        raise SystemExit(__doc__)
    default, per_test = bounds_from(conf["--nextest-config"], conf["--package"])
    binary, args = cmd[0], cmd[1:]
    opts, filters = split_args(args)
    if not asks_json(opts):
        os.execvp(binary, cmd)
    selected = count_listed(binary, opts, filters)
    if selected is None:
        sys.stderr.write(f"{NOTE} {binary} runs without a bound per test: its --list failed.\n")
        sys.stderr.flush()
        os.execvp(binary, cmd)
    own_log = [v for k, v in opts if k == "--logfile"]
    tmp = None
    if own_log:
        logfile = own_log[-1]
    else:
        tmp = tempfile.mkdtemp(prefix="libtest-bound.")
        logfile = os.path.join(tmp, "results.log")
        cmd = [*cmd, "--logfile", logfile]
    run = Binary(cmd, logfile, drop_warning=tmp is not None)
    signal.signal(signal.SIGTERM, lambda *_: (stop(run.proc.pid), sys.exit(128 + signal.SIGTERM)))
    t0 = time.monotonic()
    stalled = None
    try:
        while True:
            r, _, _ = select.select([] if run.eof else [run.fd], [], [], 1.0)
            if r:
                run.read()
            run.read_log()
            if run.proc.poll() is not None:
                break
            waiting = run.unreported()
            if waiting:
                quiet = time.monotonic() - run.last
                if quiet >= max(per_test.get(n, default) for n in waiting):
                    stalled = quiet
                    stop(run.proc.pid)
                    break
        code = run.finish()
    finally:
        if tmp:
            for f in os.listdir(tmp):
                os.unlink(os.path.join(tmp, f))
            os.rmdir(tmp)
    if stalled is None:
        return code if code >= 0 else 128 - code
    now = time.monotonic()
    if run.last_byte != b"\n":
        sys.stdout.write("\n")
    waiting = run.unreported()
    for name in sorted(waiting):
        ran = now - waiting[name]
        emit({"type": "test", "name": name, "event": "failed", "exec_time": round(ran, 3),
              "stdout": f"{NOTE} libtest started {name} {ran:.0f} s before the runner stopped the binary, and "
                        f"had reported no test for {stalled:.0f} s, past the bound of each test it had not "
                        f"reported (this one's is {per_test.get(name, default)} s, .config/nextest.toml).\n"})
    counts = {"ok": 0, "failed": 0, "ignored": 0}
    for e in run.in_record.values():
        counts[e] += 1
    counts["failed"] += len(waiting)
    total = count_listed(binary, [x for x in opts if x[0] == "-Z"], [])
    emit({"type": "suite", "event": "failed", "passed": counts["ok"], "failed": counts["failed"],
          "ignored": counts["ignored"], "measured": 0,
          "filtered_out": max(0, total - selected) if total is not None else 0,
          "exec_time": round(now - t0, 3), "not_run": selected - len(run.reported) - len(waiting)})
    return 101


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
