#!/usr/bin/env python3
"""THROWAWAY measurement for INFRA-5336, on scratch/infra-5336-platform-cpu-wall only.

Runs one step's command and reports the CPU time it used against its wall time, and samples the
whole runner's CPU use every 5 s while it runs, so a step that holds its runner while waiting
(timers, I/O, one busy core) reads apart from one that keeps every core busy.

  cpuwall.py NAME OUTDIR -- CMD ARGS...   run CMD; print a CPUWALL line; write OUTDIR/cpuwall-NAME.tsv
  cpuwall.py spin SECONDS                 control: one busy process per core for SECONDS

The CPUWALL line: wall_s (the command's wall time), user_s and sys_s (getrusage RUSAGE_CHILDREN:
every descendant that was waited for), ncpu, cores_used = cpu_s / wall_s, util = cores_used /
ncpu; machine_* from the 5 s samples of the whole runner (/proc/stat on Linux, `top -l` on macOS),
which also sees processes nobody waited for; idle_frac = the share of samples in which the whole
runner used less than one core. The tsv has one line per sample: seconds since start, busy cores.
The command's exit status is this script's.
"""
import os
import re
import resource
import subprocess
import sys
import threading
import time

INTERVAL = 5.0
NCPU = os.cpu_count() or 1


def spin(seconds):
    if len(sys.argv) > 3 and sys.argv[3] == "one":
        end = time.monotonic() + seconds
        n = 0
        while time.monotonic() < end:
            n += 1
        return 0
    procs = [subprocess.Popen([sys.executable, __file__, "spin", str(seconds), "one"]) for _ in range(NCPU)]
    return max(p.wait() for p in procs)


class LinuxSampler:
    def __init__(self):
        self.samples = []
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    @staticmethod
    def read():
        with open("/proc/stat") as f:
            v = [int(x) for x in f.readline().split()[1:]]
        idle = v[3] + v[4]
        return sum(v) - idle, sum(v)

    def run(self):
        t0 = time.monotonic()
        busy0, total0 = self.read()
        while not self.stop.wait(INTERVAL):
            busy, total = self.read()
            if total > total0:
                self.samples.append((time.monotonic() - t0, (busy - busy0) / (total - total0) * NCPU))
            busy0, total0 = busy, total

    def start(self):
        self.thread.start()

    def finish(self):
        self.stop.set()
        self.thread.join()


class MacSampler:
    PAT = re.compile(r"CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle")

    def __init__(self):
        self.samples = []
        self.proc = None
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        t0 = time.monotonic()
        first = True
        for line in self.proc.stdout:
            m = self.PAT.search(line)
            if not m:
                continue
            if first:  # top's first sample does not cover the interval
                first = False
                continue
            self.samples.append((time.monotonic() - t0, (100.0 - float(m.group(3))) / 100.0 * NCPU))

    def start(self):
        self.proc = subprocess.Popen(["top", "-l", "0", "-s", str(int(INTERVAL)), "-n", "0"],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.thread.start()

    def finish(self):
        self.proc.terminate()
        self.proc.wait()
        self.thread.join(timeout=10)


def main():
    if sys.argv[1] == "spin":
        return spin(float(sys.argv[2]))
    name, outdir = sys.argv[1], sys.argv[2]
    if sys.argv[3] != "--":
        print("usage: cpuwall.py NAME OUTDIR -- CMD ARGS...", file=sys.stderr)
        return 2
    cmd = sys.argv[4:]
    sampler = LinuxSampler() if sys.platform.startswith("linux") else MacSampler()
    sampler.start()
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    t0 = time.monotonic()
    proc = subprocess.Popen(cmd)
    rc = proc.wait()
    wall = time.monotonic() - t0
    # Read before the sampler's own top process is reaped, so its CPU is not counted.
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    sampler.finish()
    user = after.ru_utime - before.ru_utime
    sys_ = after.ru_stime - before.ru_stime
    cpu = user + sys_
    s = sampler.samples
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, f"cpuwall-{name}.tsv"), "w") as f:
        f.write("t_s\tbusy_cores\n")
        for t, b in s:
            f.write(f"{t:.1f}\t{b:.3f}\n")
    machine_busy = sum(b for _, b in s) * INTERVAL
    span = len(s) * INTERVAL
    idle = sum(1 for _, b in s if b < 1.0)
    print(f"CPUWALL name={name} rc={rc} wall_s={wall:.1f} user_s={user:.1f} sys_s={sys_:.1f} cpu_s={cpu:.1f} "
          f"ncpu={NCPU} cores_used={cpu / wall if wall else 0:.3f} util={cpu / wall / NCPU if wall else 0:.3f} "
          f"machine_samples={len(s)} machine_busy_core_s={machine_busy:.1f} "
          f"machine_util={machine_busy / span / NCPU if span else 0:.3f} idle_frac={idle / len(s) if s else 0:.3f}",
          flush=True)
    return rc


if __name__ == "__main__":
    sys.exit(main())
