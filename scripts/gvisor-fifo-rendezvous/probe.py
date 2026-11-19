#!/usr/bin/env python3
"""FIFO rendezvous probe for pi-shell's builtins_waiting_on_a_fifo_see_its_writer_close, with no shell.

gVisor before google/gvisor@d6786915 can strand a reader in a blocking open(2) of a FIFO: the reader reads the
writer count, a writer opens, writes and closes, the reader then registers, finds no writer, and waits for a new one
for ever. Linux checks and registers together, so never.

--form old is the test's old shape: a reader thread does a blocking open(O_RDONLY) and reads to end of file while a
writer thread opens the FIFO for writing, writes one byte and closes (--writer blocking: a blocking open, as the
shell's opener thread does; --writer spin: O_NONBLOCK opens retried on ENXIO, as the shell's writer did before
cybermonklabs/oh-my-pi#18).

--form new is the test's new shape: the test's side opens a reader end of its own (O_NONBLOCK) and then the writer
end, both before the reader's blocking open, writes one byte, and closes the writer only once the reader has taken
the byte (FIONREAD on its own end reads 0). The reader's open then always finds a writer and never waits for one.

Per try: `right` (the reader got the byte, then end of file); `strand` (the reader still waits in open(2) 10 s after
the writer closed, or, in the new form, 10 s after the byte was written; the probe then frees it with a writer of
its own); `lost` (end of file without the byte). With --control the reader opens only after a writer came and went,
so every try must count as a strand (the instrument can see one, on Linux too).

Runs for SECONDS in each of PROCS processes at once; prints one line per process, then a TOTAL line.
Usage: probe.py --form old|new [--writer blocking|spin] [--control] [--strand-after S] [--procs N] [--label L] SECONDS"""
import argparse
import errno
import fcntl
import multiprocessing
import os
import struct
import sys
import tempfile
import termios
import threading
import time

STRAND_AFTER = 10.0  # --strand-after; the control, whose every try strands, can use less


def fionread(fd):
    return struct.unpack("i", fcntl.ioctl(fd, termios.FIONREAD, b"\0\0\0\0"))[0]


def free_reader(path):
    """A writer of the probe's own, so a reader waiting in open(2) for one returns."""
    fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
    os.close(fd)


def read_all(path, got, done):
    fd = os.open(path, os.O_RDONLY)
    data = b""
    while True:
        chunk = os.read(fd, 64)
        if not chunk:
            break
        data += chunk
    os.close(fd)
    got["data"] = data
    done.set()


def try_old(path, writer_kind, control):
    got, done = {}, threading.Event()

    def writer():
        if writer_kind == "spin":
            while True:
                try:
                    fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
                    break
                except OSError as e:
                    if e.errno != errno.ENXIO:
                        raise
        else:
            fd = os.open(path, os.O_WRONLY)
        try:
            os.write(fd, b"x")
        except BrokenPipeError:
            got["epipe"] = True
        os.close(fd)

    if control:
        # The writer comes and goes before the reader opens (a reader end of the probe's own lets it open).
        keeper = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        writer()
        os.close(keeper)
        r = threading.Thread(target=read_all, args=(path, got, done))
        r.start()
    else:
        r = threading.Thread(target=read_all, args=(path, got, done))
        w = threading.Thread(target=writer)
        r.start()
        w.start()
        w.join()
    stranded = not done.wait(STRAND_AFTER)
    if stranded:
        free_reader(path)
        done.wait()
    r.join()
    return stranded, got.get("data")


def try_new(path):
    got, done = {}, threading.Event()
    keeper = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    wfd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
    os.write(wfd, b"x")
    r = threading.Thread(target=read_all, args=(path, got, done))
    r.start()
    # The writer stays open until the reader has taken the byte, so the reader's open finds a writer.
    start = time.monotonic()
    stranded = False
    while fionread(keeper) > 0:
        if time.monotonic() - start > STRAND_AFTER:
            stranded = True
            break
        time.sleep(0)
    os.close(wfd)
    if stranded:
        free_reader(path)
    done.wait()
    r.join()
    os.close(keeper)
    return stranded, got.get("data")


def worker(args, out):
    counts = {"tries": 0, "right": 0, "strand": 0, "lost": 0}
    base = tempfile.mkdtemp(prefix="fifo-rdv.")
    end = time.monotonic() + args.seconds
    while time.monotonic() < end:
        path = os.path.join(base, f"f{counts['tries']}")
        os.mkfifo(path)
        if args.form == "old":
            stranded, data = try_old(path, args.writer, args.control)
        else:
            stranded, data = try_new(path)
        os.unlink(path)
        counts["tries"] += 1
        if stranded:
            counts["strand"] += 1
        elif data == b"x":
            counts["right"] += 1
        else:
            counts["lost"] += 1
    os.rmdir(base)
    out.put((os.getpid(), counts))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--form", choices=["old", "new"], required=True)
    ap.add_argument("--writer", choices=["blocking", "spin"], default="blocking")
    ap.add_argument("--control", action="store_true")
    ap.add_argument("--procs", type=int, default=1)
    ap.add_argument("--label", default="FIFO-RDV")
    ap.add_argument("--strand-after", type=float, default=STRAND_AFTER)
    ap.add_argument("seconds", type=float)
    args = ap.parse_args()
    globals()["STRAND_AFTER"] = args.strand_after
    if args.control and args.form != "old":
        ap.error("--control is a form of the old shape")
    name = f"{args.label} form={args.form}" + (f" writer={args.writer}" if args.form == "old" else "")
    name += " CONTROL" if args.control else ""
    q = multiprocessing.Queue()
    procs = [multiprocessing.Process(target=worker, args=(args, q)) for _ in range(args.procs)]
    for p in procs:
        p.start()
    total = {"tries": 0, "right": 0, "strand": 0, "lost": 0}
    for _ in procs:
        pid, counts = q.get()
        print(f"{name} pid={pid} " + " ".join(f"{k}={v}" for k, v in counts.items()), flush=True)
        for k in total:
            total[k] += counts[k]
    for p in procs:
        p.join()
    print(f"TOTAL {name} procs={args.procs} seconds={args.seconds:g} " + " ".join(f"{k}={v}" for k, v in total.items()),
          flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
