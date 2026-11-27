#!/usr/bin/env bash
# MODULE.bazel.lock against the tree it is in, through the tree's own generator,
# scripts/gen-bazel-lock.ts (`bun run gen:bazel-lock`, which MODULE.bazel names):
# `bazelisk fetch --repo=@crates --lockfile_mode=error` with --check, `update`
# without. The lock stores the result of rules_rust's crate extension, keyed by
# the sha256 of each Cargo file it read and by the environment variables it read.
# While each input is as recorded, a fresh Bazel server reuses that result; once
# one differs, every fresh server evaluates the extension again (cargo-bazel
# splice: tens of seconds to minutes) and builds the same outputs.
#
#   bazel-lock.sh run <tree> <log> [--check]
#       One run of the generator in <tree>, its output in <log>, in the fixed
#       environment below. Prints "<exit> <seconds>".
#   bazel-lock.sh inputs <tree>
#       Each file input the lock in <tree> records, against the file:
#       "<path><TAB><recorded sha256><TAB><the file's sha256, or missing>".
#   bazel-lock.sh candidate
#       sami-build.yml's bazel_lock step, in the checkout of the run's commit:
#       the check; when Bazel says the lock is stale, the generator, then the
#       check again. Writes lock=current|regenerated|unknown (and, for
#       regenerated, reason, files and sha256) to $GITHUB_OUTPUT and the step
#       summary. It never fails the run: a step that could not tell writes
#       lock=unknown and a warning, and the release builds the lock as committed.
#
# The fixed environment: env -i with bun and bazelisk on PATH, a HOME of its own
# (no ~/.bazelrc, no ~/.cargo), and USER (Bazel will not start without it). The
# lock records eight environment variables (CARGO_BAZEL_* and REPIN; .bazelrc
# sets two of them with --repo_env), so a check that inherits a job's
# environment can read a current lock as stale. sami-build's step and
# sami-checks' bazel-lock row both run here, so the lock the step writes is the
# lock the row reads current. A .bazelrc.user, which .bazelrc imports, is never
# in a checkout unless the tree commits one.
# The backquotes in single quotes below are Markdown and Bazel's own words, never expansions.
# shellcheck disable=SC2016
set -uo pipefail

run() { # <tree> <log> [generator arguments]: prints "<exit> <seconds>"
	local tree=$1 log=$2 bun bazelisk s r
	shift 2
	bun=$(command -v bun) || { echo "bazel-lock: no bun on PATH" >"$log"; echo "127 0"; return; }
	bazelisk=$(command -v bazelisk) || { echo "bazel-lock: no bazelisk on PATH" >"$log"; echo "127 0"; return; }
	# One HOME for every run of a job (the caller exports BAZEL_LOCK_HOME), so a second run reuses
	# Bazel, its server and the cargo registry the first one fetched.
	[ -n "${BAZEL_LOCK_HOME:-}" ] || { echo "bazel-lock: BAZEL_LOCK_HOME is not set" >"$log"; echo "125 0"; return; }
	s=$(date +%s)
	(cd "$tree" && timeout -k 30 1500 env -i PATH="$(dirname "$bun"):$(dirname "$bazelisk"):/usr/bin:/bin" \
		HOME="$BAZEL_LOCK_HOME" USER="${USER:-runner}" LANG=C.UTF-8 "$bun" scripts/gen-bazel-lock.ts "$@" </dev/null) >"$log" 2>&1
	r=$?
	echo "$r $(($(date +%s) - s))"
}

inputs() { # <tree>: each recorded file input against the file
	local tree=$1 path rec act
	jq -r '.moduleExtensions[][].recordedInputs[]? | select(startswith("FILE:@@//")) | ltrimstr("FILE:@@//")' \
		"$tree/MODULE.bazel.lock" | while read -r path rec; do
		if [ -f "$tree/$path" ]; then act=$(sha256sum "$tree/$path" | cut -d' ' -f1); else act=missing; fi
		printf '%s\t%s\t%s\n' "$path" "$rec" "$act"
	done
}

# Bazel's own line, never gen-bazel-lock.ts's hint, which quotes the same words.
stale_reason() { # <log>: the reason Bazel gives for a stale lock; nothing when it gives none
	sed 's/\x1b\[[0-9;]*m//g' "$1" | grep -v '^gen-bazel-lock:' |
		sed -n 's/^ERROR: MODULE\.bazel\.lock is no longer up-to-date because \(.*\)\. Please run `bazel mod deps --lockfile_mode=update` to update your lockfile\.$/\1/p' |
		head -n 1
}

current() { # <log> <exit>: Bazel read every recorded input as it is
	[ "$2" = 0 ] && grep -qx 'MODULE.bazel.lock is up to date.' "$1" && [ -z "$(stale_reason "$1")" ]
}

candidate() {
	local logs=${RUNNER_TEMP:-/tmp}/bazel-lock out=${GITHUB_OUTPUT:-/dev/null} summary=${GITHUB_STEP_SUMMARY:-/dev/null}
	local sha rc secs reason files rrc rsecs crc csecs changed before after
	sha=$(git rev-parse HEAD)
	mkdir -p "$logs"
	unknown() { # <what the step could not tell>: lock=unknown; the build goes on
		echo "::warning title=MODULE.bazel.lock::UNKNOWN: $1. The release builds the lock as committed."
		echo "lock=unknown" >>"$out"
		printf '### MODULE.bazel.lock: UNKNOWN at %s\n\n%s. The release builds the lock as committed; nothing is offered.\n' "$sha" "$1" >>"$summary"
		exit 0
	}
	command -v jq >/dev/null || unknown "jq is not on PATH, so the lock's record cannot be read"
	[ ! -e .bazelrc.user ] || unknown "the tree commits a .bazelrc.user, which can set the environment the lock records"
	echo "bun $(bun --version 2>/dev/null || echo absent), bazelisk $(command -v bazelisk || echo absent)"
	read -r rc secs < <(run . "$logs/check.log" --check)
	echo "::group::gen-bazel-lock --check at $sha: exit $rc, ${secs}s"
	cat "$logs/check.log"
	echo "::endgroup::"
	if current "$logs/check.log" "$rc"; then
		echo "lock=current" >>"$out"
		printf '### MODULE.bazel.lock is current at %s\n\nBazel (`bun scripts/gen-bazel-lock.ts --check`, %ss) read every input the lock records as it is. Nothing to commit.\n' \
			"$sha" "$secs" >>"$summary"
		echo "MODULE.bazel.lock is current: nothing to commit."
		return 0
	fi
	reason=$(stale_reason "$logs/check.log")
	[ -n "$reason" ] || unknown "gen-bazel-lock --check exited $rc and Bazel gave no reason the lock is stale: $(grep -v '^gen-bazel-lock:' "$logs/check.log" | grep -E 'ERROR|FATAL' | head -n 1 | cut -c 1-300)"
	files=$(inputs . | awk -F'\t' '$2 != $3 { print $1 }' | paste -sd ' ' -)
	before=$(sha256sum MODULE.bazel.lock | cut -d' ' -f1)
	read -r rrc rsecs < <(run . "$logs/regenerate.log")
	echo "::group::gen-bazel-lock (update) at $sha: exit $rrc, ${rsecs}s"
	tail -n 60 "$logs/regenerate.log"
	echo "::endgroup::"
	[ "$rrc" = 0 ] || unknown "Bazel reads the lock stale ($reason), and the generator exited $rrc"
	changed=$(git status --porcelain --untracked-files=no | cut -c 4- | paste -sd ' ' -)
	[ "$changed" = MODULE.bazel.lock ] ||
		unknown "the generator was to change MODULE.bazel.lock alone, and the tracked files it changed are [${changed:-none}]"
	read -r crc csecs < <(run . "$logs/recheck.log" --check)
	echo "::group::gen-bazel-lock --check of the regenerated lock: exit $crc, ${csecs}s"
	cat "$logs/recheck.log"
	echo "::endgroup::"
	current "$logs/recheck.log" "$crc" ||
		unknown "the regenerated lock does not read current to the same check (exit $crc: $(stale_reason "$logs/recheck.log"))"
	after=$(sha256sum MODULE.bazel.lock | cut -d' ' -f1)
	{
		echo "lock=regenerated"
		echo "reason=$reason"
		echo "files=${files:-none}"
		echo "sha256=$after"
	} >>"$out"
	{
		printf '### MODULE.bazel.lock was stale at %s, and is regenerated\n\n' "$sha"
		printf -- '- Bazel: `%s`\n' "$reason"
		printf -- '- The lock'"'"'s record differs from the file for: %s\n' "${files:-no file (an input other than a file differs)}"
		printf -- '- `bun scripts/gen-bazel-lock.ts` regenerated it in %ss; its `--check` then passed in %ss.\n' "$rsecs" "$csecs"
		printf -- '- sha256 %s before, %s after; `git diff --stat`: %s\n\n' "$before" "$after" "$(git diff --shortstat -- MODULE.bazel.lock | sed 's/^ //')"
	} >>"$summary"
	git --no-pager diff --stat -- MODULE.bazel.lock
}

case "${1:-}" in
run | candidate)
	BAZEL_LOCK_HOME=${BAZEL_LOCK_HOME:-$(mktemp -d)}
	export BAZEL_LOCK_HOME
	if [ "$1" = run ]; then shift; run "$@"; else candidate; fi
	;;
inputs) shift; inputs "$@" ;;
*)
	echo "usage: $0 run <tree> <log> [--check] | inputs <tree> | candidate" >&2
	exit 2
	;;
esac
