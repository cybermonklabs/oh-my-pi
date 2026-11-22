#!/usr/bin/env bash
# Scratch only, never merged: pi-shell at #53's head ($HEAD_SHA) and at its base ($BASE_SHA) on this runner,
# each in its own worktree and target: clippy --all-targets (the full list, then -D warnings), the whole pi-shell
# set under nextest (the tree's own .config/nextest.toml, plus a zsh53r10 profile that bounds a test at 10 minutes),
# and the doctests. Then every test that fails at the head and not at the base runs 5 times alone at both
# trees; it counts as head-only when it fails in some rerun at the head and in none at the base.
# Plain bash 3.2 (macOS's /bin/bash).
set -u
here=$PWD
out=$here/zsh53r10-logs
mkdir -p "$out"
PY=$(command -v python3 || command -v python)
[ -n "$PY" ] || { echo "no python"; exit 2; }
case "$(uname -s)" in
Darwin) os=macos ;;
MINGW* | MSYS* | CYGWIN*) os=windows ;;
*) os=linux ;;
esac
echo "RUNNER $os $(uname -a)"
# cargo-nextest goes into a directory of its own, first on PATH: macos-15 has no ~/.cargo/bin (run 44899137028).
nxbin=$(cd .. && pwd)/nxbin
mkdir -p "$nxbin"
export PATH="$nxbin:$PATH"
nextest() {
	local d
	d=$(mktemp -d)
	if [ "$os" = macos ]; then
		curl -fsSL -o "$d/nx.tgz" https://get.nexte.st/0.9.151/universal-apple-darwin.tar.gz || return 1
		echo "d1d7d025d4bfc9fb154cd76aea3949bd78534829a0589abefa6e5dd4edb135dd  $d/nx.tgz" | shasum -a 256 -c - || return 1
		tar -xzf "$d/nx.tgz" -C "$nxbin" cargo-nextest || return 1
	else
		curl -fsSL -o "$d/nx.zip" https://get.nexte.st/0.9.151/x86_64-pc-windows-msvc.zip || return 1
		echo "ba35ee0ce14ace65cd8c7aaa9613adb7d2644b0fe3866e85131eb4c269786efb  $d/nx.zip" | sha256sum -c - || return 1
		(cd "$nxbin" && 7z x -y "$d/nx.zip" > /dev/null) || return 1
	fi
}
nextest || { echo "nextest install failed"; exit 2; }
cargo nextest --version | head -1
for label in head base; do
	sha=$HEAD_SHA
	[ "$label" = base ] && sha=$BASE_SHA
	git fetch --no-tags --depth=1 origin "$sha" > /dev/null 2>&1 && git worktree add "../$label" "$sha" > /dev/null 2>&1 || { echo "worktree $label failed"; exit 2; }
	got=$(git -C "../$label" rev-parse HEAD)
	echo "TREE $label $got"
	[ "$got" = "$sha" ] || { echo "tree $label is not $sha"; exit 2; }
done
# rustup, where the image has none on PATH, from rustup.rs into ~/.cargo (after nxbin on PATH).
if ! command -v rustup > /dev/null; then
	curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain none --profile minimal --no-modify-path > "$out/rustup-init.log" 2>&1 || { tail -20 "$out/rustup-init.log"; exit 2; }
fi
export PATH="$nxbin:$HOME/.cargo/bin:$PATH"
echo "RUSTUP $(command -v rustup) $(rustup --version 2> /dev/null | head -1)"
(cd ../head && rustup toolchain install --profile minimal) > "$out/rustup.log" 2>&1 || { tail -20 "$out/rustup.log"; exit 2; }
(cd ../head && rustc -V && cargo -V && cargo clippy -V)
for label in head base; do
	t=$(cd "../$label" && pwd)
	"$PY" - "$t/.config/nextest.toml" > "$out/nextest-$label.toml" << 'EOF'
import re, sys
text = open(sys.argv[1]).read()
blocks = re.findall(r"^\[\[profile\.default\.overrides\]\]\n(?:(?!^\[).*\n?)*", text, flags=re.M)
print(text)
print("[profile.zsh53r10]\nfailure-output = \"immediate-final\"\nfail-fast = false\nslow-timeout = { period = \"60s\", terminate-after = 10 }\n")
for b in blocks:
    print(b.replace("[[profile.default.overrides]]", "[[profile.zsh53r10.overrides]]", 1))
EOF
	s=$(date -u +%FT%TZ)
	(cd "$t" && cargo clippy -p pi-shell --all-targets --message-format short) > "$out/clippy-warn-$label.log" 2>&1
	a=$?
	(cd "$t" && cargo clippy -p pi-shell --all-targets -- -D warnings) > "$out/clippy-deny-$label.log" 2>&1
	b=$?
	echo "CLIPPY $label warn-only exit=$a findings=$(grep -cE '^[^ ]+:[0-9]+:[0-9]+: (warning|error)' "$out/clippy-warn-$label.log"); -D warnings exit=$b errors=$(grep -c '^error' "$out/clippy-deny-$label.log") ($s..$(date -u +%FT%TZ))"
	grep -E '^[^ ]+:[0-9]+:[0-9]+: (warning|error)' "$out/clippy-warn-$label.log" | sed -E 's/^([^:]+):[0-9]+:[0-9]+: /\1: /' | tr '\\' '/' | sort | uniq -c | sort -k2 > "$out/clippy-$label.keys"
	s=$(date -u +%FT%TZ)
	(cd "$t" && cargo nextest run -p pi-shell --no-fail-fast --config-file "$out/nextest-$label.toml" --profile zsh53r10) > "$out/test-$label.log" 2>&1
	echo "WHOLE $label exit=$? ($s..$(date -u +%FT%TZ))"
	"$PY" .github/scratch-zsh53r10-analyze.py summary "$out/test-$label.log" | sed 's/^/  /'
	(cd "$t" && cargo test --doc -p pi-shell) > "$out/doc-$label.log" 2>&1
	echo "DOCTESTS $label exit=$? $(grep '^test result:' "$out/doc-$label.log" | tail -1)"
done
"$PY" - "$out/clippy-head.keys" "$out/clippy-base.keys" << 'EOF'
import sys
from collections import Counter
def load(p):
    c = Counter()
    for line in open(p):
        n, key = line.strip().split(" ", 1)
        c[key] += int(n)
    return c
h, b = load(sys.argv[1]), load(sys.argv[2])
print(f"CLIPPY-COMPARE head {sum(h.values())} base {sum(b.values())}; head-only {sum((h - b).values())}, base-only {sum((b - h).values())}")
for k, n in sorted((h - b).items()):
    print(f"  HEAD-ONLY {n} {k}")
for k, n in sorted((b - h).items()):
    print(f"  BASE-ONLY {n} {k}")
EOF
for label in head base; do
	"$PY" .github/scratch-zsh53r10-analyze.py summary "$out/test-$label.log" | grep '^NOTPASS ' | awk '{print $4 "\t" $5}' | sort -u > "$out/notpass-$label.txt"
done
comm -23 "$out/notpass-head.txt" "$out/notpass-base.txt" > "$out/head-only.txt"
echo "HEAD-ONLY candidates $(wc -l < "$out/head-only.txt"); base-only $(comm -13 "$out/notpass-head.txt" "$out/notpass-base.txt" | wc -l)"
comm -13 "$out/notpass-head.txt" "$out/notpass-base.txt" | sed 's/^/  BASE-ONLY /'
status=0
while IFS="$(printf '\t')" read -r bin name; do
	[ -n "$name" ] || continue
	m=0 b=0
	for i in 1 2 3 4 5; do
		for label in head base; do
			(cd "../$label" && cargo nextest run -p pi-shell --config-file "$out/nextest-$label.toml" --profile zsh53r10 -E "binary_id($bin) & test(=$name)") > "$out/rerun-$label-$i.log" 2>&1
			if ! grep -qE '^ +Summary .* 1 tests? run: 1 passed' "$out/rerun-$label-$i.log"; then
				[ "$label" = head ] && m=$((m + 1)) || b=$((b + 1))
				cp "$out/rerun-$label-$i.log" "$out/rerun-fail-$label-$(echo "$name" | tr ':/' '__')-$i.log"
			fi
		done
	done
	echo "RECHECK $bin $name: head failed $m of 5, base failed $b of 5"
	if [ "$m" -gt 0 ] && [ "$b" = 0 ]; then
		echo "HEAD-ONLY $bin $name"
		status=1
	fi
done < "$out/head-only.txt"
echo "DONE $(date -u +%FT%TZ) status=$status"
exit $status
