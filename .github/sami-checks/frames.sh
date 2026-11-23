#!/usr/bin/env bash
# The frames row (.github/workflows/sami-checks-frames.yml): a release must read the frames the
# release before it stored, or raise FRAMES_VERSION so that it refuses them cleanly. The previous
# release's build writes the frames of a loop externalized mid-run (frames_write.rs, appended to
# pi-shell's testkit/suites/control.rs in the job only); this build reads them (frames_read.rs,
# appended the same way, with the fork's hand-run kit's every-version row). A second build of this
# tree carries the kit's plant (frames.rs check() refuses no other version or build), which both
# tests must fail where it applies. sc.py frames turns the four runs into the row's units.
#   frames.sh pick    the previous release: $SC_FRAMES_BASE_INPUT, else the newest v*-sami.* tag on
#                     a strict ancestor of $SC_COMMIT; "base=<sha>" to $GITHUB_OUTPUT
#   frames.sh base    in base/: the previous release's pi-shell lib tests with the writer, run once
#   frames.sh build   in tree/: this build's pi-shell lib tests with the reader, then with the plant
#   frames.sh run     the reader and the kit's row in both binaries; sc.py frames writes $SC/res
set -uo pipefail
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
CTL=crates/pi-shell/src/testkit/suites/control.rs
FR=crates/pi-shell/src/bash/vm/frames.rs
READER=testkit::suites::control::sc_frames::previous_release_frames_are_read_by_this_build
KIT=testkit::suites::control::sc_frames::kit_frames_row_every_older_version_is_refused_and_drop_frames_recovers
WRITER=testkit::suites::control::sc_frames_write::writes_this_builds_frames
F=$SC/frames
mkdir -p "$F/base" "$F/bin" "$F/logs"

# build_lib LABEL DEST: pi-shell's lib test binary of the tree in the working directory, copied to
# DEST. On a failure, its first compiler errors go to the log and the first one to $F/bin/error-LABEL.txt
# or $F/base/error.txt (ERRFILE).
build_lib() {
	local label=$1 dest=$2 log=$F/logs/build-$1 s rc bin
	s=$(date +%s)
	cargo test --locked -p pi-shell --lib --no-run --message-format=json > "$log.json" 2> "$log.log"
	rc=$?
	bin=$(python3 - "$log.json" "$log.errors" << 'EOF'
import json, sys
exe, errors = None, []
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    try:
        m = json.loads(line)
    except ValueError:
        continue
    if m.get("reason") == "compiler-artifact" and m.get("executable") and m["target"]["name"] == "pi_shell" and m["profile"]["test"]:
        exe = m["executable"]
    elif m.get("reason") == "compiler-message" and m["message"].get("level") == "error":
        errors.append(m["message"].get("rendered") or m["message"].get("message", ""))
open(sys.argv[2], "w").write("\n".join(errors))
print(exe or "")
EOF
)
	echo "BUILT $label exit=$rc seconds=$(($(date +%s) - s)) binary=${bin:-none}"
	if [ "$rc" != 0 ] || [ -z "$bin" ] || [ ! -x "$bin" ]; then
		head -n 80 "$log.errors"
		tail -n 20 "$log.log"
		first=$(grep -m 1 -E '^error' "$log.errors" || grep -m 1 -E '^error' "$log.log" || true)
		echo "the $label build failed (cargo exit $rc): ${first:-no compiler error read; see build-$label.log}" > "$ERRFILE"
		return 1
	fi
	cp "$bin" "$dest"
}

cmd_pick() {
	local out=$F/base/pick.txt base="" tag="" how g c t rc
	fail() {
		echo "error=$*" >> "$out"
		echo "$*" > "$F/base/error.txt"
		echo "::error title=frames: the previous release::$*"
		echo "base=" >> "$GITHUB_OUTPUT"
		exit 1
	}
	: > "$out"
	if [ -n "${SC_FRAMES_BASE_INPUT:-}" ]; then
		[[ $SC_FRAMES_BASE_INPUT =~ ^[0-9a-f]{40}$ ]] ||
			fail "the frames_base input must be a full 40-character lowercase id, not '$SC_FRAMES_BASE_INPUT'"
		base=$SC_FRAMES_BASE_INPUT how="the frames_base input"
	else
		# Commits only (no trees, as a partial clone): every tag and the candidate, for the ancestry test.
		g=(git -C "$SC/pick.git")
		if ! { git init -q --bare "$SC/pick.git" &&
			"${g[@]}" config core.repositoryformatversion 1 &&
			"${g[@]}" config extensions.partialClone origin &&
			"${g[@]}" remote add origin "$SC_REPO_URL" &&
			"${g[@]}" config remote.origin.promisor true &&
			"${g[@]}" config remote.origin.partialclonefilter tree:0; }; then
			fail "could not set up a partial clone of $SC_REPO_URL"
		fi
		"${g[@]}" fetch -q --no-tags --filter=tree:0 origin '+refs/tags/*:refs/tags/*' "$SC_COMMIT" ||
			fail "could not fetch the tags and $SC_COMMIT from $SC_REPO_URL"
		# Newest first by the cut time in the name (v<version>-sami.<YYYYMMDD-HHMMSS>).
		while read -r t; do
			c=$("${g[@]}" rev-parse "$t^{commit}") || fail "$t names no commit"
			if [ "$c" = "$SC_COMMIT" ]; then
				echo "SKIP $t: the candidate itself"
				continue
			fi
			"${g[@]}" merge-base --is-ancestor "$c" "$SC_COMMIT"
			rc=$?
			case $rc in
			0) base=$c tag=$t how="the newest v*-sami.* tag on a strict ancestor of the candidate"; break ;;
			1) echo "SKIP $t ($c): not an ancestor of the candidate" ;;
			*) fail "git merge-base exited $rc for $t" ;;
			esac
		done < <("${g[@]}" for-each-ref --format='%(refname:strip=2)' refs/tags/ |
			grep -E '^v[0-9][^/]*-sami\.[0-9]{8}-[0-9]{6}$' | sed -E 's/^(.*)-sami\.([0-9-]+)$/\2 \1-sami.\2/' |
			sort -r | cut -d' ' -f2)
		[ -n "$base" ] || fail "no v*-sami.* tag is on a strict ancestor of $SC_COMMIT"
	fi
	{
		echo "base=$base"
		echo "tag=$tag"
		echo "how=$how"
	} >> "$out"
	echo "BASE $base${tag:+ ($tag)}: $how"
	echo "base=$base" >> "$GITHUB_OUTPUT"
}

cmd_base() {
	ERRFILE=$F/base/error.txt
	cd "$GITHUB_WORKSPACE/base" || exit 1
	echo "BASE TREE $(git rev-parse HEAD) FRAMES_VERSION line: $(grep -m 1 -E 'const FRAMES_VERSION' "$FR" || echo none)"
	{ printf '\n'; cat "$tool/frames_write.rs"; } >> "$CTL"
	build_lib base "$F/writer.bin" || exit 1
	local rc
	(cd "$RUNNER_TEMP" && env -i HOME="$RUNNER_TEMP" PATH=/usr/bin:/bin SC_FRAMES_OUT="$F/base" \
		timeout -k 10 300 "$F/writer.bin" --exact "$WRITER" --nocapture --test-threads=1) > "$F/base/write.log" 2>&1 < /dev/null
	rc=$?
	cat "$F/base/write.log"
	if [ "$rc" != 0 ] || [ ! -s "$F/base/blobs.bin" ] || [ ! -s "$F/base/run.txt" ]; then
		rm -f "$F/base/blobs.bin"
		echo "the previous release's writer did not write its frames (exit $rc): $(grep -m 1 -A 1 'panicked at' "$F/base/write.log" | tail -n 1)" > "$ERRFILE"
		exit 1
	fi
}

cmd_build() {
	cd "$SC_TREE" || exit 1
	echo "TREE $(git rev-parse HEAD) FRAMES_VERSION line: $(grep -m 1 -E 'const FRAMES_VERSION' "$FR" || echo none)"
	{ printf '\n'; cat "$tool/frames_read.rs"; } >> "$CTL"
	ERRFILE=$F/bin/error-test.txt
	if ! build_lib test "$F/bin/frames-test.bin"; then
		cp "$ERRFILE" "$F/bin/error-plant.txt"
		exit 1
	fi
	# The kit's plant, widened to the IR test: check() refuses frames of no other IR version, frames
	# version or build (the kit's row changes only the frames version and the build id).
	ERRFILE=$F/bin/error-plant.txt
	python3 - "$FR" << 'EOF' || { echo "the kit's plant does not apply: frames.rs does not hold each check line exactly once" > "$ERRFILE"; exit 1; }
import sys
p = sys.argv[1]
src = open(p, encoding="utf-8").read()
for old in ("\tif h.ir != IR_VERSION {\n", "\tif h.frames != FRAMES_VERSION || h.build != Engine::build_id() {\n"):
    if src.count(old) != 1:
        sys.exit(1)
    src = src.replace(old, "\tif false {\n", 1)
open(p, "w", encoding="utf-8").write(src)
EOF
	echo "PLANT $(git diff --stat -- "$FR" | tail -n 1)"
	build_lib plant "$F/bin/frames-plant.bin" || exit 1
}

cmd_run() {
	local runs=$F/runs label which name bin t s
	mkdir -p "$runs" "$SC/res"
	for label in test plant; do
		bin=$F/bin/frames-$label.bin
		for which in cross kit; do
			name=$label-$which
			if [ ! -s "$bin" ]; then
				cat "$F/bin/error-$label.txt" > "$runs/$name.skip" 2> /dev/null ||
					echo "no $label binary: the build job wrote none and no error (it failed, timed out or did not run)" > "$runs/$name.skip"
				continue
			fi
			if [ "$which" = cross ] && [ ! -s "$F/base/blobs.bin" ]; then
				cat "$F/base/error.txt" > "$runs/$name.skip" 2> /dev/null ||
					echo "no frames of the previous release: the base job wrote none and no error (it failed, timed out or did not run)" > "$runs/$name.skip"
				continue
			fi
			chmod 755 "$bin"
			t=$READER
			[ "$which" = kit ] && t=$KIT
			s=$(date +%s.%N)
			(cd "$RUNNER_TEMP" && env -i HOME="$RUNNER_TEMP" PATH=/usr/bin:/bin SC_FRAMES_BASE="$F/base" \
				timeout -k 10 300 "$bin" --exact "$t" --nocapture --test-threads=1 -Z unstable-options --format json --report-time) \
				> "$runs/$name.log" 2>&1 < /dev/null
			echo $? > "$runs/$name.exit"
			python3 -c "import time; print(f'{time.time() - $s:.1f}')" > "$runs/$name.secs"
			echo "RUN $name exit=$(cat "$runs/$name.exit")"
			grep -aE 'SCFRAMES|KITFRAMES|panicked at' -A 1 "$runs/$name.log" | cut -c1-400 | sed "s/^/  /"
		done
	done
	mkdir -p "$SC/res/logs"
	# Best effort: a run that did not happen has no log to copy.
	cp "$runs"/*.log "$runs"/*.skip "$F"/logs/*.log "$F"/base/*.log "$F"/base/pick.txt "$SC/res/logs/" 2> /dev/null || true
	python3 "$tool/sc.py" frames "$F" "$SC_COMMIT" "$SC/res"
}

case ${1:-} in
pick) cmd_pick ;;
base) cmd_base ;;
build) cmd_build ;;
run) cmd_run ;;
*) echo "usage: frames.sh pick|base|build|run" >&2; exit 2 ;;
esac
