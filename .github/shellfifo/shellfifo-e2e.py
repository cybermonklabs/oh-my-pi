#!/usr/bin/env python3
"""`echo x > fifo` and `echo x >> fifo` by each shell, as root and as the
runner, onto a FIFO of another user (nobody) in a world-writable sticky
directory that root owns, with fs.protected_fifos at 1.

Run as root. Usage: shellfifo-e2e.py <dir> <runner-user> <label=shell>...

The FIFO's two ends are held open (O_RDWR) by this script for each run, so a
write open that the kernel lets through ends at once, and what it wrote stays
in the FIFO for this script to read. bash is the control: its plain open must
be refused (EACCES), or every row is UNKNOWN.
"""
import os
import pwd
import subprocess
import sys

COMMANDS = {">": 'echo x > "$1"; echo "rc=$?"', ">>": 'echo x >> "$1"; echo "rc=$?"'}


def setup(directory):
    sticky = os.path.join(directory, "sticky")
    os.makedirs(sticky, exist_ok=True)
    os.chmod(sticky, 0o1777)
    fifo = os.path.join(sticky, "report.txt")
    if not os.path.exists(fifo):
        os.mkfifo(fifo)
    os.chmod(fifo, 0o666)
    nobody = pwd.getpwnam("nobody")
    os.chown(fifo, nobody.pw_uid, nobody.pw_gid)
    st, dst = os.stat(fifo), os.stat(sticky)
    print(f"SETUP dir {sticky} mode {oct(dst.st_mode & 0o7777)} uid {dst.st_uid}; "
          f"fifo mode {oct(st.st_mode & 0o7777)} uid {st.st_uid}; "
          f"protected_fifos={open('/proc/sys/fs/protected_fifos').read().strip()}")
    return fifo


def run(shell, who, redirect, fifo):
    held = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
    try:
        cmd = [shell, "-c", COMMANDS[redirect], "sh", fifo]
        if who != "root":
            cmd = ["runuser", "-u", who, "--"] + cmd
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            out, err = p.stdout.strip(), p.stderr.strip().replace("\n", " | ")
        except subprocess.TimeoutExpired:
            out, err = "TIMEOUT (UNKNOWN)", ""
        try:
            got = os.read(held, 4096)
        except BlockingIOError:
            got = b""
    finally:
        os.close(held)
    rc = out.rsplit("rc=", 1)[-1] if "rc=" in out else "?"
    return rc, got, err


def main():
    directory, runner = sys.argv[1], sys.argv[2]
    shells = [arg.split("=", 1) for arg in sys.argv[3:]]
    fifo = setup(directory)
    control = {}
    for who in ("root", runner):
        for redirect in COMMANDS:
            for label, shell in shells:
                rc, got, err = run(shell, who, redirect, fifo)
                opened = got != b""
                if label == "bash":
                    control[(who, redirect)] = rc != "0" and not opened
                verdict = "OPENED (another user's FIFO got the write)" if opened else "refused"
                print(f"E2E {label:<12} as {who:<6} echo x {redirect:<2} fifo: rc={rc} {verdict}; "
                      f"FIFO got {got!r}; stderr: {err}")
    for (who, redirect), ok in control.items():
        if not ok:
            print(f"UNKNOWN: bash as {who} with {redirect} was not refused, so fs.protected_fifos "
                  "does not hold here; no row above is a verdict")


if __name__ == "__main__":
    main()
