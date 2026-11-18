#!/usr/bin/env python3
"""Writes a Kubernetes Job that runs probe.py (beside this file) in a sandboxed pod: its control, then each shape of
the FIFO rendezvous, idle and beside LOAD exec loops and LOAD busy loops (ended by their recorded pids). Each phase
prints probe.py's TOTAL line; read them with `kubectl logs job/<name>`. Nothing is built and no credential is used.

Usage: make-job.py OUT --namespace NS [--runtime-class gvisor] [--node-selector K=V]... [--label K=V]...
                   [--annotation K=V]... [--pod-label K=V]... [--pod-annotation K=V]... [--name-prefix P]
                   [--seconds S] [--new-seconds S] [--procs N] [--load N] [--cpu N] [--cpu-request N]
                   [--memory M] [--deadline S] [--image IMAGE]
--new-seconds defaults to 1.5 x --seconds, so the new shape runs at least as many tries as the old."""
import argparse
import base64
import json
import pathlib

here = pathlib.Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument("out")
ap.add_argument("--namespace", required=True)
ap.add_argument("--runtime-class", default="gvisor")
ap.add_argument("--node-selector", action="append", default=[])
ap.add_argument("--label", action="append", default=[])
ap.add_argument("--annotation", action="append", default=[])
ap.add_argument("--pod-label", action="append", default=[])
ap.add_argument("--pod-annotation", action="append", default=[])
ap.add_argument("--name-prefix", default="fifo-rdv-")
ap.add_argument("--seconds", type=float, default=300)
ap.add_argument("--new-seconds", type=float)
ap.add_argument("--procs", type=int, default=16)
ap.add_argument("--load", type=int, default=16)
ap.add_argument("--cpu", default="16")
ap.add_argument("--cpu-request")
ap.add_argument("--memory", default="8Gi")
ap.add_argument("--deadline", type=int, default=7200)
# rust:1-bookworm; probe.py needs only python3, which the script installs if the image lacks it.
ap.add_argument("--image", default="docker.io/library/rust@sha256:198cd28b4ba92b20fe849d5d8b119ace1bd28423d9e82e9c4de5ee1300d453a0")
a = ap.parse_args()
new_seconds = a.new_seconds if a.new_seconds is not None else a.seconds * 1.5


def pairs(items):
    out = {}
    for item in items:
        k, sep, v = item.partition("=")
        assert sep and k, f"want KEY=VALUE: {item!r}"
        out[k] = v
    return out


probe = base64.b64encode((here / "probe.py").read_bytes()).decode()
s, n, procs, load = a.seconds, new_seconds, a.procs, a.load
script = f"""set -uo pipefail
echo "START $(date -u +%FT%TZ) KERNEL $(uname -r) nproc=$(nproc) uid=$(id -u)"
export DEBIAN_FRONTEND=noninteractive
command -v python3 > /dev/null || {{ apt-get update && apt-get install -y --no-install-recommends python3; }} > /tmp/apt.log 2>&1 \\
  || {{ tail -20 /tmp/apt.log; echo "Error: no python3"; exit 3; }}
echo {probe} | base64 -d > /tmp/probe.py
cd /tmp || exit 3
start_of() {{ sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20; }}
PIDS=(); STARTS=()
load_on() {{
  local i p
  for i in $(seq 1 {load}); do ( while :; do /bin/true; done ) & p=$!; PIDS+=("$p"); STARTS+=("$(start_of "$p")"); done
  for i in $(seq 1 {load}); do ( while :; do :; done ) & p=$!; PIDS+=("$p"); STARTS+=("$(start_of "$p")"); done
}}
load_off() {{
  local i
  for i in "${{!PIDS[@]}}"; do
    [ "$(start_of "${{PIDS[$i]}}")" = "${{STARTS[$i]}}" ] && kill -KILL "${{PIDS[$i]}}" 2> /dev/null
    wait "${{PIDS[$i]}}" 2> /dev/null
  done
  PIDS=(); STARTS=()
}}
phase() {{ python3 /tmp/probe.py --procs {procs} "$@" | grep '^TOTAL'; }}
python3 /tmp/probe.py --form old --control --strand-after 1 --procs 2 5 | grep '^TOTAL'
for mode in idle loaded; do
  [ $mode = loaded ] && load_on
  for order in writer-first reader-first; do
    for writer in blocking spin; do
      phase --label "FIFO-RDV $mode" --form old --writer $writer --order $order {s:g}
    done
  done
  phase --label "FIFO-RDV $mode" --form new {n:g}
  [ $mode = loaded ] && load_off
done
echo "SUMMARY done $(date -u +%FT%TZ)"
"""
resources = {"requests": {"cpu": a.cpu_request or a.cpu, "memory": a.memory}, "limits": {"cpu": a.cpu, "memory": a.memory}}
manifest = {
    "apiVersion": "batch/v1",
    "kind": "Job",
    "metadata": {"generateName": a.name_prefix, "namespace": a.namespace, "labels": pairs(a.label),
                 "annotations": pairs(a.annotation)},
    "spec": {
        "backoffLimit": 0,
        "ttlSecondsAfterFinished": 86400,
        "activeDeadlineSeconds": a.deadline,
        "template": {
            "metadata": {"labels": pairs(a.pod_label), "annotations": pairs(a.pod_annotation)},
            "spec": {
                "restartPolicy": "Never",
                "activeDeadlineSeconds": a.deadline,
                "automountServiceAccountToken": False,
                "runtimeClassName": a.runtime_class,
                "nodeSelector": pairs(a.node_selector),
                "containers": [{"name": "probe", "image": a.image, "command": ["/bin/bash", "-c", script],
                                "resources": resources}],
            },
        },
    },
}
pathlib.Path(a.out).write_text(json.dumps(manifest, indent=2) + "\n")
print(a.out)
