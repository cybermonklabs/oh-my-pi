#!/usr/bin/env bash
# The linux-x64 binary embeds two native addons, linux-x64-baseline and
# linux-x64-modern, and packages/natives/scripts/embed-native.ts embeds each
# one it finds in packages/natives/native, and only those. Each addon is one
# whole-program (thin LTO) compile of pi_natives, so sami-build.yml's
# release_binary builds each on a runner of its own: the linux-x64 leg builds
# the baseline addon and the binary, and the linux-x64-modern leg builds the
# modern addon and uploads it as the artifact addon-linux-x64-modern. The
# linux-x64 leg runs this script before its binary: it waits for that
# artifact in this run and installs the one addon it holds into <dest>.
#
#   await-addon.sh <addon> <dest>
#
# The binary is not built (the script exits 1) when the leg that uploads the
# artifact ended without uploading it, when no artifact came within
# AWAIT_ADDON_TIMEOUT seconds (default 3600), or when the artifact holds
# anything but pi_natives.<addon>.node. When it cannot ask GitHub, it prints
# UNKNOWN and exits 3. Environment: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID,
# GITHUB_RUN_ATTEMPT; AWAIT_ADDON_INTERVAL, the seconds between looks
# (default 15). .github/sami/tests/run.sh runs it against a stub gh (cases A*).
#
# AWAIT_ADDON_TIMEOUT bounds the wait for a leg that never ends, not a build:
# this leg starts waiting once its own addon is built, the same work as the
# other leg's, started at the same time, so the wait is short. A build of one
# addon from an empty cache took 13 to 18 min on ubuntu-22.04 (INFRA-5336,
# 2026-11-28), so 60 min is past a cold build on the slowest runner seen. The
# bound is on waiting for the artifact to appear: no wait between looks runs
# past it, and the last look is at it. A look that began before it and finds
# the artifact is taken, however late GitHub answers; a call to GitHub that
# never answers is ended by the step's own timeout-minutes.
set -euo pipefail

addon="${1:?usage: await-addon.sh <addon> <dest>}"
dest="${2:?usage: await-addon.sh <addon> <dest>}"
name="addon-$addon"
file="pi_natives.$addon.node"
api="repos/$GITHUB_REPOSITORY/actions"
timeout="${AWAIT_ADDON_TIMEOUT:-3600}"
interval="${AWAIT_ADDON_INTERVAL:-15}"

fail() {
	echo "::error title=$name::$1"
	exit 1
}
unknown() {
	echo "::error title=$name::UNKNOWN: $1"
	exit 3
}

# The clock is `date +%s`, which the harness replaces with its own (and sleep
# with one that moves it), so the bound is tested to the second.
deadline=$(($(date +%s) + timeout))
echo "waiting up to $timeout s for the $name artifact of this run, looking every $interval s"
# Looks since the uploading leg passed: its upload is listed before the job
# ends, so a leg that passed and still shows no artifact two looks later
# never uploaded it.
after_pass=0
while :; do
	out="$(gh api "$api/runs/$GITHUB_RUN_ID/artifacts?name=$name&per_page=100" 2>&1)" ||
		unknown "could not list this run's artifacts: $out"
	id="$(printf '%s' "$out" | jq -r '[.artifacts[] | select(.expired | not)] | sort_by(.created_at) | last | .id // empty' 2>&1)" ||
		unknown "could not read this run's artifact list: $out"
	[ -z "$id" ] || break
	# The uploading leg is the one job of this attempt whose name ends in its
	# matrix value, the addon: `release_binary (ubuntu-22.04, <addon>)`.
	out="$(gh api "$api/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT/jobs?per_page=100" 2>&1)" ||
		unknown "could not list this attempt's jobs: $out"
	state="$(printf '%s' "$out" | jq -r --arg tail ", $addon)" '[.jobs[] | select(.name | endswith($tail))] | if length == 1 then .[0] | .status + (if .conclusion then " " + .conclusion else "" end) else "jobs \(length)" end' 2>&1)" ||
		unknown "could not read this attempt's job list: $out"
	case "$state" in
	"completed success")
		after_pass=$((after_pass + 1))
		[ "$after_pass" -le 2 ] || fail "the $addon leg passed and uploaded no $name artifact, so this leg cannot build a binary that embeds $file"
		;;
	completed*) fail "the $addon leg ended (${state#completed }) without uploading $name, so this leg cannot build a binary that embeds $file" ;;
	jobs*) echo "UNKNOWN: ${state#jobs } jobs of this attempt end in [, $addon)], not one; waiting for the artifact alone" ;;
	*) echo "the $addon leg is $state; no $name artifact yet" ;;
	esac
	# Stop at the bound: no wait runs past it, and the last look is at it.
	left=$((deadline - $(date +%s)))
	[ "$left" -gt 0 ] || fail "no $name artifact in this run after $timeout s"
	sleep "$((interval < left ? interval : left))"
done

w="$(mktemp -d)"
trap 'rm -rf -- "$w"' EXIT
gh api "$api/artifacts/$id/zip" >"$w/artifact.zip" 2>"$w/err" ||
	unknown "could not download artifact $id: $(cat "$w/err")"
listing="$(unzip -Z1 "$w/artifact.zip" 2>&1 | LC_ALL=C sort | paste -sd ' ' -)"
[ "$listing" = "$file" ] || fail "artifact $id ($name) holds [$listing], not $file alone"
unzip -q -d "$w/x" "$w/artifact.zip"
[ -s "$w/x/$file" ] || fail "artifact $id ($name) holds an empty $file"
mkdir -p "$dest"
install -m 0644 "$w/x/$file" "$dest/$file"
if command -v sha256sum >/dev/null; then sum=(sha256sum); else sum=(shasum -a 256); fi
echo "installed $file from artifact $id of this run: sha256 $("${sum[@]}" "$dest/$file" | cut -d ' ' -f 1)"
