#!/usr/bin/env python3
"""Counts the processes that die by a signal on a CI runner, and what the runner's core-dump hook
costs for them. A measurement, not a check: it fails nothing, and every number it could not read it
prints as UNKNOWN with the reason.

  sudo -E python3 signal-deaths.py start DIR   before the job's work: the runner's core-dump setup,
      the cells (the time of one crash under each way of sending a dump nowhere, each checked to
      have taken), then BSD process accounting of every process that ends, from here on, into
      DIR/pacct, a 1-second sampler of the hook's cgroups, and the control (planted deaths the
      report must find).
  python3 signal-deaths.py mark DIR NAME   a marker record in the accounting file: a copy of
      /bin/true named scm-NAME runs and ends, so the file's order splits it into windows.
  sudo -E python3 signal-deaths.py report DIR   after the job's work: stops the accounting and the
      sampler and writes DIR/report.json and a summary on stdout.

The accounting file holds one 64-byte acct_v3 record per process that ended, in the order they
ended, with its command name, pid, parent pid, exit code (the signal and the core-dumped bit) and
CPU time; process accounting set in the initial pid namespace records the processes of every pid
namespace below it too (containers, Bazel's sandboxes). It does not see the processes of a gVisor
sandbox, which are not host processes.
"""
import ctypes
import json
import os
import re
import resource
import signal
import struct
import subprocess
import sys
import time

REC = struct.Struct("<BBHIIIIIIf8H16s")
assert REC.size == 64
AFORK, ASU, ACORE, AXSIG = 0x01, 0x02, 0x08, 0x10
CORE_SIGNALS = {signal.SIGQUIT, signal.SIGILL, signal.SIGTRAP, signal.SIGABRT, signal.SIGBUS,
                signal.SIGFPE, signal.SIGSEGV, signal.SIGXCPU, signal.SIGXFSZ, signal.SIGSYS}
AHZ = 100.0
PATTERN = "/proc/sys/kernel/core_pattern"


def comp(c):
    return (c & 0x1FFF) << (3 * ((c >> 13) & 7))


def records(path):
    """Every record of the accounting file, in the order the processes ended."""
    out = []
    with open(path, "rb") as f:
        data = f.read()
    for i in range(0, len(data) - len(data) % 64, 64):
        flag, ver, _tty, code, uid, _gid, pid, ppid, btime, etime, ut, st, *_rest, comm = REC.unpack_from(data, i)
        out.append({"flag": flag, "ver": ver & 0x7F, "code": code, "uid": uid, "pid": pid, "ppid": ppid,
                    "btime": btime, "etime": etime / AHZ, "cpu": (comp(ut) + comp(st)) / AHZ,
                    "comm": comm.split(b"\0", 1)[0].decode("utf-8", "replace")})
    return out, len(data) % 64


def sig_of(r):
    return r["code"] & 0x7F if r["flag"] & AXSIG else None


def is_hook(r):
    return r["comm"].startswith("apport") or r["comm"] in ("systemd-coredum", "systemd-coredump")


def read(path, default="UNREADABLE"):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError as e:
        return f"{default} ({e.strerror})"


def run(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=60).stdout.strip()
    except (OSError, subprocess.SubprocessError) as e:
        return f"UNREADABLE ({e})"


def mark(d, name):
    exe = os.path.join(d, "bin", "scm-" + name)
    if not os.path.exists(exe):
        os.makedirs(os.path.dirname(exe), exist_ok=True)
        with open("/bin/true", "rb") as src, open(exe + ".tmp", "wb") as dst:
            dst.write(src.read())
        os.chmod(exe + ".tmp", 0o755)
        os.replace(exe + ".tmp", exe)
    subprocess.run([exe], check=True)


BASELINE_HOOKS = set()


def hook_procs():
    """The pids of the hook's processes now running, but for those that ran before the first crash."""
    n = set()
    for p in os.listdir("/proc"):
        if p.isdigit():
            try:
                with open(f"/proc/{p}/comm") as f:
                    c = f.read().strip()
            except OSError:
                continue
            if c.startswith("apport") or c.startswith("systemd-coredum"):
                n.add(int(p))
    return n - BASELINE_HOOKS


def settle(limit=30.0):
    """Waits until no hook process runs (for 1 s), at most `limit` seconds; returns the seconds."""
    t0 = time.monotonic()
    quiet = None
    while time.monotonic() - t0 < limit:
        if hook_procs():
            quiet = None
        elif quiet is None:
            quiet = time.monotonic()
        elif time.monotonic() - quiet >= 1.0:
            break
        time.sleep(0.1)
    return round(time.monotonic() - t0, 2)


def hook_cgroups():
    """Each cgroup under system.slice whose name holds apport or coredump, and its usage_usec."""
    out = {}
    base = "/sys/fs/cgroup/system.slice"
    try:
        names = os.listdir(base)
    except OSError:
        return out
    for n in names:
        if "apport" in n or "coredump" in n:
            try:
                with open(os.path.join(base, n, "cpu.stat")) as f:
                    for line in f:
                        k, v = line.split()
                        if k == "usage_usec":
                            out[n] = int(v)
            except OSError:
                pass
    return out


def proc_stat_cpu():
    with open("/proc/stat") as f:
        parts = f.readline().split()[1:]
    return sum(int(x) for x in parts[:8]) / os.sysconf("SC_CLK_TCK")


def sampler(d):
    """A daemon: every second, the hook's cgroups' usage and the machine's CPU time, until DIR/stop."""
    if os.fork():
        return
    os.setsid()
    if os.fork():
        os._exit(0)
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    with open(os.path.join(d, "samples.jsonl"), "a", buffering=1) as out:
        while not os.path.exists(os.path.join(d, "stop")):
            out.write(json.dumps({"t": time.time(), "cpu": proc_stat_cpu(), "cg": hook_cgroups()}) + "\n")
            time.sleep(1.0)
        out.write(json.dumps({"t": time.time(), "cpu": proc_stat_cpu(), "cg": hook_cgroups(), "end": True}) + "\n")
    os._exit(0)


def as_user():
    uid, gid = int(os.environ.get("SUDO_UID", os.getuid())), int(os.environ.get("SUDO_GID", os.getgid()))

    def drop():
        os.setgid(gid)
        os.setuid(uid)
    return drop


def caller_limits():
    """The job's own RLIMIT_CORE (SD_CALLER_CORE_LIMIT, bash's `ulimit -c`/`ulimit -Hc`: 512-byte
    blocks of 1024 bytes or unlimited): sudo gives its command another one (sudoers rlimit_core)."""
    def one(v):
        return resource.RLIM_INFINITY if v == "unlimited" else int(v) * 1024
    try:
        soft, hard = os.environ["SD_CALLER_CORE_LIMIT"].split("/")
        return one(soft), one(hard)
    except (KeyError, ValueError):
        return resource.getrlimit(resource.RLIMIT_CORE)


def form_pre(form):
    """The child's setup for a form: its core limit set as root, then the job's user, except
    sudo-root, which keeps what sudo gave this process and stays root."""
    soft, hard = caller_limits()
    drop = as_user()
    limit = {"as-the-job-has-it": (soft, hard), "core_pattern-false": (soft, hard), "ulimit-c-0": (0, hard),
             "rlimit-1-byte": (1, hard), "ulimit-c-unlimited": (hard, hard)}.get(form)

    def pre():
        if limit is not None:
            resource.setrlimit(resource.RLIMIT_CORE, limit)
            drop()
    return pre


def crash_once(sig, form):
    """One /bin/sh that kills itself with `sig` (0: exits 0) under `form`; its wall seconds and status."""
    script = f"kill -{signal.Signals(sig).name[3:]} $$" if sig else "exit 0"
    t0 = time.perf_counter()
    p = subprocess.run(["/bin/sh", "-c", script], preexec_fn=form_pre(form), cwd="/tmp", capture_output=True)
    return time.perf_counter() - t0, p.returncode


def limits_seen(form):
    p = subprocess.run(["/bin/cat", "/proc/self/limits"], preexec_fn=form_pre(form), capture_output=True, text=True)
    line = next((ln for ln in p.stdout.splitlines() if ln.startswith("Max core file size")), "")
    return " ".join(line.split()[4:6]) or "UNREADABLE"


FORMS = ["as-the-job-has-it", "ulimit-c-0", "rlimit-1-byte", "ulimit-c-unlimited", "sudo-root", "core_pattern-false"]


def cells(d, n):
    """Each form, each signal: n crashes timed one by one; a window of the accounting file each."""
    original = read(PATTERN)
    out = []
    for form in FORMS:
        took = None
        if form == "core_pattern-false":
            with open(PATTERN, "w") as f:
                f.write("|/bin/false")
            took = read(PATTERN)
        limit = limits_seen(form)
        for sig in (0, signal.SIGSEGV, signal.SIGABRT, signal.SIGQUIT):
            name = f"{form}:{signal.Signals(sig).name if sig else 'exit0'}"
            tag = f"c{len(out):02d}"
            mark(d, tag + "s")
            times, codes = [], []
            for _ in range(n):
                t, rc = crash_once(sig, form)
                times.append(t)
                codes.append(rc)
            settled = settle()
            mark(d, tag + "e")
            times.sort()
            out.append({"cell": name, "tag": tag, "form": form, "signal": sig, "n": n,
                        "core_pattern": took or read(PATTERN), "core_limit_seen": limit,
                        "median_ms": round(1000 * times[n // 2], 2), "max_ms": round(1000 * times[-1], 2),
                        "min_ms": round(1000 * times[0], 2), "returncodes": sorted(set(codes)),
                        "hook_settle_s": settled})
        if form == "core_pattern-false":
            with open(PATTERN, "w") as f:
                f.write(original)
            back = read(PATTERN)
            if back != original:
                print(f"::error::core_pattern is '{back}' after the cells, not the runner's '{original}'")
                sys.exit(3)
    return out


def cmd_start(d):
    os.makedirs(os.path.join(d, "bin"), exist_ok=True)
    uid, gid = int(os.environ.get("SUDO_UID", os.getuid())), int(os.environ.get("SUDO_GID", os.getgid()))
    os.chown(d, uid, gid)
    os.chown(os.path.join(d, "bin"), uid, gid)
    BASELINE_HOOKS.update(hook_procs())
    env = {
        "t": time.time(),
        "core_pattern": read(PATTERN),
        "core_pipe_limit": read("/proc/sys/kernel/core_pipe_limit"),
        "core_uses_pid": read("/proc/sys/kernel/core_uses_pid"),
        "suid_dumpable": read("/proc/sys/fs/suid_dumpable"),
        "caller_core_limit": os.environ.get("SD_CALLER_CORE_LIMIT", "UNKNOWN"),
        "core_limit_under_sudo": "/".join("unlimited" if v == resource.RLIM_INFINITY else str(v)
                                          for v in resource.getrlimit(resource.RLIMIT_CORE)),
        "kernel": os.uname().release,
        "cpu": next((ln.split(":", 1)[1].strip() for ln in read("/proc/cpuinfo").splitlines()
                     if ln.startswith("model name")), "UNKNOWN"),
        "nproc": os.cpu_count(),
        "image": f"{os.environ.get('ImageOS', '?')}/{os.environ.get('ImageVersion', '?')}",
        "etc_default_apport": read("/etc/default/apport", "ABSENT"),
        "apport_version": run(["dpkg-query", "-W", "-f=${Version}", "apport"]),
        "hooks_running_before": sorted(BASELINE_HOOKS),
        "hook_units": run(["systemctl", "list-units", "--all", "--no-pager", "--plain", "--no-legend", "*apport*", "*coredump*"]),
        "hook_sockets": run(["systemctl", "list-sockets", "--all", "--no-pager", "--plain", "--no-legend"]),
    }
    with open(os.path.join(d, "env.json"), "w") as f:
        json.dump(env, f, indent=1)
    print("SIGNAL-DEATHS env " + json.dumps({k: env[k] for k in ("core_pattern", "core_pipe_limit", "caller_core_limit",
                                                                  "kernel", "cpu", "nproc", "image", "apport_version")}))
    print("SIGNAL-DEATHS hook units: " + env["hook_units"].replace("\n", " | "))
    acct = os.path.join(d, "pacct")
    open(acct, "wb").close()
    os.chmod(acct, 0o600)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.acct(acct.encode()) != 0:
        e = ctypes.get_errno()
        print(f"SIGNAL-DEATHS UNKNOWN: acct({acct}) failed: {os.strerror(e)}; nothing below can be counted")
        with open(os.path.join(d, "acct-failed"), "w") as f:
            f.write(os.strerror(e))
        return
    sampler(d)
    mark(d, "start")
    n = int(os.environ.get("SD_CELL_N", "10"))
    try:
        c = cells(d, n)
    except Exception as e:  # the cells are one part; the control and the work window still run
        print(f"SIGNAL-DEATHS UNKNOWN: the cells failed: {e!r}")
        with open(os.path.join(d, "cells-failed"), "w") as f:
            f.write(repr(e))
        if read(PATTERN) != env["core_pattern"]:
            with open(PATTERN, "w") as f:
                f.write(env["core_pattern"])
        c = []
    with open(os.path.join(d, "cells.json"), "w") as f:
        json.dump(c, f, indent=1)
    for x in c:
        print(f"SIGNAL-DEATHS cell {x['cell']:42} median {x['median_ms']:8.2f} ms  max {x['max_ms']:8.2f} ms  "
              f"limit {x['core_limit_seen']:>20}  pattern {x['core_pattern']}  rc {x['returncodes']}  settle {x['hook_settle_s']} s")
    # The control: two SIGSEGV deaths at the job's own limit and one SIGKILL death, which the report
    # must find between these markers; the exit 0 must not count.
    mark(d, "ctl-s")
    for sig in (signal.SIGSEGV, signal.SIGSEGV, signal.SIGKILL, 0):
        crash_once(sig, "as-the-job-has-it")
    settle()
    mark(d, "ctl-e")
    mark(d, "work")


def window(recs, start, end):
    """Records strictly between the marker named start and the next marker named end."""
    i = next((k for k, r in enumerate(recs) if r["comm"] == "scm-" + start), None)
    if i is None:
        return None
    j = next((k for k in range(i + 1, len(recs)) if recs[k]["comm"] == "scm-" + end), None)
    return recs[i + 1:j] if j is not None else None


def summarize(rs):
    deaths = [r for r in rs if sig_of(r) is not None]
    core = [r for r in deaths if sig_of(r) in CORE_SIGNALS]
    hooks = [r for r in rs if is_hook(r)]
    by_sig = {}
    for r in deaths:
        k = signal.Signals(sig_of(r)).name if sig_of(r) in signal.valid_signals() else str(sig_of(r))
        by_sig[k] = by_sig.get(k, 0) + 1
    unrecorded = by_sig.pop("0", 0)
    return {"processes": len(rs), "signal_deaths": len(deaths) - unrecorded, "by_signal": by_sig,
            "signal_deaths_signal_unrecorded": unrecorded,
            "hook_dumps": sum(1 for r in hooks if r["ppid"] == 2),
            "core_signal_deaths": len(core), "core_dumped_bit": sum(1 for r in core if r["code"] & 0x80),
            "hook_processes": len(hooks), "hook_cpu_s": round(sum(r["cpu"] for r in hooks), 2),
            "hook_elapsed_s": round(sum(r["etime"] for r in hooks), 2),
            "core_death_elapsed_s": round(sum(r["etime"] for r in core), 2)}


def cgroup_total(path):
    """The hook cgroups' CPU seconds over the samples: each cgroup's growth, carried across a reset."""
    total, last = 0, {}
    first_t = last_t = None
    try:
        with open(path) as f:
            for line in f:
                s = json.loads(line)
                first_t = first_t or s["t"]
                last_t = s["t"]
                for k, v in s["cg"].items():
                    p = last.get(k)
                    total += v - p if p is not None and v >= p else (v if p is not None else 0)
                    last[k] = v
                for k in list(last):
                    if k not in s["cg"]:
                        del last[k]
    except OSError:
        return None
    return {"hook_cgroup_cpu_s": round(total / 1e6, 2), "seconds_sampled": round((last_t or 0) - (first_t or 0), 1)}


def journal(d, since):
    """The hook's units as systemd recorded them: units started and the CPU each consumed."""
    try:
        p = subprocess.run(["journalctl", "-o", "json", "--no-pager", f"--since=@{int(since)}"],
                           capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as e:
        return {"journal": f"UNREADABLE ({e})"}
    started, consumed, units, kept = 0, 0.0, set(), []
    for line in p.stdout.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        unit = e.get("UNIT") or e.get("_SYSTEMD_UNIT") or ""
        msg = e.get("MESSAGE") if isinstance(e.get("MESSAGE"), str) else ""
        if "apport" not in unit and "coredump" not in unit and "apport" not in msg:
            continue
        kept.append(line)
        if unit and ("apport" in unit or "coredump" in unit):
            units.add(unit)
        if msg.startswith("Started ") and ("apport" in unit or "coredump" in unit):
            started += 1
        m = re.search(r"Consumed ([0-9.]+)(ms|s|min) CPU time", msg)
        if m and ("apport" in unit or "coredump" in unit):
            v = float(m.group(1))
            consumed += v / 1000 if m.group(2) == "ms" else v * 60 if m.group(2) == "min" else v
    with open(os.path.join(d, "journal-hook.jsonl"), "w") as f:
        f.write("\n".join(kept))
    return {"journal_units_started": started, "journal_units": len(units),
            "journal_consumed_cpu_s": round(consumed, 2), "journal_lines": len(kept)}


def cmd_report(d):
    if os.path.exists(os.path.join(d, "acct-failed")) or not os.path.exists(os.path.join(d, "pacct")):
        print("SIGNAL-DEATHS UNKNOWN: process accounting never started; nothing was counted")
        sys.exit(2)
    with open(os.path.join(d, "env.json")) as f:
        BASELINE_HOOKS.update(json.load(f).get("hooks_running_before", []))
    mark(d, "done")
    settle()
    mark(d, "end")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.acct(None)
    open(os.path.join(d, "stop"), "w").close()
    time.sleep(2.5)
    with open(os.path.join(d, "env.json")) as f:
        env = json.load(f)
    recs, tail = records(os.path.join(d, "pacct"))
    versions = sorted({r["ver"] for r in recs})
    paused = [ln for ln in run(["dmesg"]).splitlines() if "process accounting paused" in ln.lower()]
    rep = {"env": env, "records": len(recs), "partial_bytes": tail, "acct_versions": versions,
           "acct_paused_lines": paused}
    unknown = []
    if versions != [3]:
        unknown.append(f"the accounting file's records are version {versions}, not 3 (acct_v3)")
    if paused:
        unknown.append("the kernel paused the accounting (free space): " + " | ".join(paused))
    ctl = window(recs, "ctl-s", "ctl-e")
    if ctl is None:
        unknown.append("no control window in the accounting file")
    else:
        c = summarize(ctl)
        rep["control"] = c
        if c["by_signal"].get("SIGSEGV", 0) < 2 or c["by_signal"].get("SIGKILL", 0) < 1:
            unknown.append(f"the control's planted deaths (2 SIGSEGV, 1 SIGKILL) were not all found: {c['by_signal']}")
        exits = [r for r in ctl if r["comm"] == "sh" and sig_of(r) is None]
        if not exits:
            unknown.append("the control's exit 0 left no record")
        if sum(1 for r in ctl if r["comm"] == "sh" and sig_of(r) is not None) != 3:
            unknown.append("the control's four sh processes did not read as 3 signal deaths and 1 exit")
    rep["cells"] = []
    try:
        with open(os.path.join(d, "cells.json")) as f:
            cl = json.load(f)
        for x in cl:
            w = window(recs, x["tag"] + "s", x["tag"] + "e")
            x.update(summarize(w) if w is not None else {"window": "UNKNOWN"})
            rep["cells"].append(x)
    except OSError:
        unknown.append("no cells.json")
    work = window(recs, "work", "done")
    if work is None:
        unknown.append("no work window in the accounting file")
    else:
        rep["work"] = summarize(work)
        core = [r for r in work if sig_of(r) in CORE_SIGNALS]
        names = {}
        for r in core:
            names[r["comm"]] = names.get(r["comm"], 0) + 1
        rep["work"]["core_deaths_by_comm"] = dict(sorted(names.items(), key=lambda kv: -kv[1]))
    rep["cgroup"] = cgroup_total(os.path.join(d, "samples.jsonl"))
    rep["journal"] = journal(d, env["t"])
    rep["unknown"] = unknown
    with open(os.path.join(d, "report.json"), "w") as f:
        json.dump(rep, f, indent=1)
    w = rep.get("work")
    head = "UNKNOWN (" + "; ".join(unknown) + ")" if unknown or w is None else "measured"
    print(f"SIGNAL-DEATHS verdict: {head}")
    print(f"SIGNAL-DEATHS core_pattern {env['core_pattern']!r}  records {len(recs)}")
    if w:
        print("SIGNAL-DEATHS work " + json.dumps({k: v for k, v in w.items() if k != "core_deaths_by_comm"}))
        print("SIGNAL-DEATHS work core deaths by command: " + json.dumps(w["core_deaths_by_comm"]))
    print("SIGNAL-DEATHS control " + json.dumps(rep.get("control")))
    print("SIGNAL-DEATHS cgroup " + json.dumps(rep["cgroup"]) + "  journal " + json.dumps(rep["journal"]))
    for x in rep["cells"]:
        print(f"SIGNAL-DEATHS cell {x['cell']:42} median {x['median_ms']:8.2f} ms  hook procs {x.get('hook_processes')}  "
              f"hook cpu {x.get('hook_cpu_s')} s  dumped-bit {x.get('core_dumped_bit')}/{x.get('core_signal_deaths')}")
    os.chmod(d, 0o755)
    for n in os.listdir(d):
        p = os.path.join(d, n)
        if os.path.isfile(p):
            os.chmod(p, 0o644)
    sys.exit(2 if unknown else 0)


if __name__ == "__main__":
    cmd, d = sys.argv[1], sys.argv[2]
    if cmd == "start":
        cmd_start(d)
    elif cmd == "mark":
        mark(d, sys.argv[3])
    elif cmd == "report":
        cmd_report(d)
    else:
        sys.exit(f"usage: {sys.argv[0]} start|mark|report DIR [NAME]")
