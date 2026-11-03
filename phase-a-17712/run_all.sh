#!/usr/bin/env bash
# Runs one corpus through Bash 5.2.21, Bash 5.3.20, obash and the session API
# (pi-natives' Shell, addon below), each in its own memory-capped scope.
# usage: run_all.sh <corpus.jsonl> <results-dir> <run-number> [ids-file]
set -u
H=/mnt/nvme/sami/scratch/SignalDeathReport/port/17712
ADDON=${ADDON:-/mnt/durable/sami/fleet-addon/main-ff0a986b/pi_natives.linux-x64-modern.node}
JOBS=${JOBS:-48}
corpus=$1 results=$2 n=$3 ids=${4:-}
mkdir -p "$results"
idarg=(); [ -n "$ids" ] && idarg=(--ids "$ids")
scope() { systemd-run --user --scope --quiet -p MemoryMax=96G -p MemorySwapMax=0 -- "$@"; }
echo "addon $ADDON $(sha256sum "$ADDON" | cut -d' ' -f1)" >"$results/addon.$n.txt"
for r in ${RUNNERS:-bash52 bash53 bash52c bash53c obash}; do
	scope python3 "$H/run_shells.py" "$r" "$corpus" "$results/$r.$n.jsonl" --jobs "$JOBS" "${idarg[@]}" &
done
shards=${ADDON_SHARDS:-$JOBS}
for ((s = 0; s < shards; s++)); do
	scope bun "$H/run_addon.mjs" "$ADDON" "$corpus" "$results/addon-$s.$n.part" "$s" "$shards" $ids &
done
wait
if ((shards > 0)); then
	cat "$results"/addon-*."$n".part >"$results/addon.$n.jsonl" && rm -f "$results"/addon-*."$n".part
fi
