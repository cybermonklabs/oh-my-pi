#!/usr/bin/env bash
# The Rust gate's build seed: the build the gate jobs start from instead of
# building every dependency again.
#
#   build <bazel build arguments...>
#     The writer, in sami-checks.yml's seed-linux and seed-macos jobs: one
#     `bazel build` of the commit under test into a disk cache of its own,
#     unbounded and with build scripts outside the sandbox, packed into
#     $SEED_ARCHIVE. It prints the archive's sha256 in a line
#     `GATESEED seed sha256=<hex>` and gives it as the step output `sha256`;
#     the readers check the bytes they download against one or the other. No
#     test and no root setup runs in that job: it runs the build code
#     sami-build.yml's release_binary already builds.
#   pick
#     The reader's first half, in sami-rust-test.yml: which run holds the seed
#     this job may read, and the sha256 that run's seed job published. It
#     writes the step outputs `run-id`, `sha256` and `reason`; an empty run-id
#     means there is nothing to download, and the job builds cold.
#       SEED_MODE=build  the calling run's own seed job ($GITHUB_RUN_ID), whose
#                        sha256 output the caller passes as SEED_SHA256.
#       SEED_MODE=auto   the newest cut's: the newest completed run of
#                        sami-checks.yml on a push of SEED_BRANCH whose job
#                        SEED_JOB succeeded, whose log names a sha256, and
#                        whose artifact SEED_NAME has not expired.
#       SEED_MODE=off    none: the job builds cold.
#   use
#     The reader's second half: the downloaded $SEED_ARCHIVE against
#     $SEED_SHA256. On a match it unpacks it into $SEED_DIR and points Bazel at
#     it through $RC, the bazelrc fragment .github/actions/bazel-cache wrote;
#     on a mismatch or a miss it leaves the job to build cold. It writes
#     exactly one `GATESEED path=seeded|cold reason=<why>` line and exits 0
#     either way: a seed makes a job faster and decides nothing. It always adds
#     `test --cache_test_results=no`, so every test of every run runs, whatever
#     the cache holds.
#
# No part of this touches a GitHub Actions cache. The gate's jobs hold no cache
# token at all (cache-mode: none in sami-checks.yml and sami-rust-test.yml),
# which is what keeps what a gate job writes out of release_binary's restore;
# an artifact is not a cache, and the readers hold only actions: read.
# .github/sami/tests/run.sh runs this script against stubs of bazelisk and gh
# (cases G*).
set -uo pipefail

usage() {
	echo "usage: gate-seed.sh build <bazel build arguments...> | pick | use" >&2
}

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

seed_dir="${SEED_DIR:-$HOME/gate-seed}"
archive="${SEED_ARCHIVE:-}"

# sha256 <file>: its sha256, with the tool of the runner's operating system.
sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	else
		shasum -a 256 "$1" | cut -d ' ' -f 1
	fi
}
bytes() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; }
kib() { if [ -d "$1" ]; then du -sk "$1" | cut -f1; else echo 0; fi; }
out() { [ -z "${GITHUB_OUTPUT:-}" ] || printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"; }
# The job whose failure says a cut's seed changed what the gate reported
# (sami-checks.yml's rust-test-compare); the auto search reads no seed of such
# a run.
SEED_CONTROL_JOB="${SEED_CONTROL_JOB:-rust test results, seeded against cold}"
# cache_lines <bazelrc>: the disk and repository caches of $seed_dir. The
# build-script strategy is not here: every build of the gate uses it, seeded or
# cold, so that a cold run and a seeded run of one commit differ in the cache
# and in nothing else. A cc build script that runs in Bazel's sandbox writes
# the sandbox path into its objects, and every dependent's action key then
# differs between runners: 4 of 268 spawns differed in run 45795251745, and
# 268 of 268 matched with --strategy=CargoBuildScriptRun=local (run
# 45798702911).
cache_lines() {
	{
		echo "common --disk_cache=$seed_dir/disk"
		echo "common --repository_cache=$seed_dir/repo"
		echo "common --repo_contents_cache=${RUNNER_TEMP:-/tmp}/bazel-repo-contents"
	} >>"$1"
}

case "${1:-}" in
build)
	shift
	[ "$#" -gt 0 ] || {
		usage
		exit 2
	}
	[ -n "$archive" ] || {
		echo "::error title=Gate seed::SEED_ARCHIVE is not set"
		exit 2
	}
	[ -n "${OMP_BAZEL_RC:-}" ] || {
		echo "::error title=Gate seed::OMP_BAZEL_RC is not set"
		exit 2
	}
	rm -rf -- "$seed_dir"
	mkdir -p "$seed_dir/disk" "$seed_dir/repo"
	cache_lines "$OMP_BAZEL_RC"
	echo "build --strategy=CargoBuildScriptRun=local" >>"$OMP_BAZEL_RC"
	cat "$OMP_BAZEL_RC"
	start="$(date +%s)"
	code=0
	bazelisk --bazelrc="$OMP_BAZEL_RC" build --keep_going "$@" || code=$?
	echo "GATESEED seed build exit=$code in $(($(date +%s) - start)) s"
	case "$code" in
	0) ;;
	1) echo "::warning title=Gate seed::a target did not build (bazel exited 1), so this seed holds what did; the gate job builds the rest and reports the failure" ;;
	*)
		echo "::error title=Gate seed::bazel build exited $code, which is bazel itself failing, so there is no seed to upload"
		exit "$code"
		;;
	esac
	mkdir -p "$(dirname "$archive")"
	start="$(date +%s)"
	if ! tar -cf - -C "$seed_dir" disk repo | zstd -T0 -3 -q -o "$archive"; then
		echo "::error title=Gate seed::packing the seed into $archive failed"
		exit 1
	fi
	sum="$(sha256 "$archive")"
	echo "GATESEED seed sha256=$sum bytes=$(bytes "$archive") packed in $(($(date +%s) - start)) s, disk $(kib "$seed_dir/disk") KiB, repository $(kib "$seed_dir/repo") KiB"
	out sha256 "$sum"
	;;
pick)
	mode="${SEED_MODE:-off}"
	run="" sum="" reason=""
	case "$mode" in
	off) reason="off" ;;
	build)
		sum="${SEED_SHA256:-}"
		run="${GITHUB_RUN_ID:-}"
		if [ -z "$sum" ]; then
			run=""
			reason="no-seed-sha256"
		elif [ -z "$run" ]; then
			sum=""
			reason="no-run-id"
		else
			reason="this-run-$run"
		fi
		;;
	auto)
		repo="${GITHUB_REPOSITORY:-}"
		branch="${SEED_BRANCH:-release-candidate}"
		job="${SEED_JOB:-}"
		name="${SEED_NAME:-}"
		if [ -z "$repo" ] || [ -z "$job" ] || [ -z "$name" ]; then
			reason="no-search-inputs"
		elif ! gh api -X GET "repos/$repo/actions/workflows/sami-checks.yml/runs" \
			-f branch="$branch" -f event=push -f status=completed -F per_page=10 \
			-q '.workflow_runs[].id' >"$tmp/runs.txt" 2>"$tmp/runs.err"; then
			sed 's/^/GATESEED auto gh: /' "$tmp/runs.err"
			reason="run-search-failed"
		elif [ ! -s "$tmp/runs.txt" ]; then
			reason="no-cut-run"
		else
			tried=0
			while read -r candidate; do
				[ "$tried" -lt "${SEED_TRIES:-5}" ] || break
				tried=$((tried + 1))
				gh api -X GET "repos/$repo/actions/runs/$candidate/jobs" -F per_page=100 \
					-q '.jobs[] | [.name, (.conclusion // "none"), (.id | tostring)] | @tsv' >"$tmp/jobs.tsv" 2>/dev/null
				id="$(awk -F'\t' -v j="$job" '$1 == j && $2 == "success" { print $3; exit }' "$tmp/jobs.tsv")"
				if [ -z "$id" ]; then
					echo "GATESEED auto run $candidate: no [$job] job that passed"
					continue
				fi
				# A cut whose cold control found that its seeded run and a cold run of
				# the same commit disagree is a cut whose seed nothing may read.
				if awk -F'\t' -v c="$SEED_CONTROL_JOB" '$1 == c && $2 == "failure" { f = 1 } END { exit !f }' "$tmp/jobs.tsv"; then
					echo "GATESEED auto run $candidate: its [$SEED_CONTROL_JOB] job failed, so its seed is not read"
					continue
				fi
				# The sha256 the seed job printed in its own log. A finished run's log
				# is what that job wrote: no later job can rewrite it, and no token of
				# this run can either.
				s="$(gh api "repos/$repo/actions/jobs/$id/logs" 2>/dev/null | grep -oE 'GATESEED seed sha256=[0-9a-f]{64}' | tail -n 1 | sed 's/.*=//')"
				if [ -z "$s" ]; then
					echo "GATESEED auto run $candidate: job $id printed no seed sha256"
					continue
				fi
				# Seed artifacts are kept 3 days, so an older run has none.
				if [ -z "$(gh api -X GET "repos/$repo/actions/runs/$candidate/artifacts" -F per_page=100 \
					-q ".artifacts[] | select(.name == \"$name\" and .expired == false) | .id" 2>/dev/null | sed -n 1p)" ]; then
					echo "GATESEED auto run $candidate: no [$name] artifact that has not expired"
					continue
				fi
				run="$candidate"
				sum="$s"
				reason="cut-run-$candidate"
				break
			done <"$tmp/runs.txt"
			[ -n "$run" ] || reason="no-cut-seed"
		fi
		;;
	*)
		echo "::warning title=Gate seed::seed mode [$mode] is no mode (build, auto or off), so this job builds cold"
		reason="unknown-mode"
		;;
	esac
	echo "GATESEED pick mode=$mode run=${run:-none} sha256=${sum:-none} reason=$reason"
	out run-id "$run"
	out sha256 "$sum"
	out reason "$reason"
	;;
use)
	[ -n "${RC:-}" ] || {
		echo "::error title=Gate seed::RC is not set"
		exit 2
	}
	[ -n "$archive" ] || {
		echo "::error title=Gate seed::SEED_ARCHIVE is not set"
		exit 2
	}
	path=cold
	reason="${SEED_REASON:-unknown}"
	if [ -n "${SEED_SHA256:-}" ] && [ -f "$archive" ]; then
		got="$(sha256 "$archive")"
		if [ "$got" != "${SEED_SHA256:-}" ]; then
			echo "::warning title=Gate seed::the seed of run ${SEED_RUN_ID:-unknown} has sha256 $got, and its seed job gives ${SEED_SHA256:-}: this job builds cold"
			reason="sha256-mismatch"
		else
			rm -rf -- "$seed_dir"
			mkdir -p "$seed_dir"
			start="$(date +%s)"
			if zstd -d -q -c "$archive" | tar -xf - -C "$seed_dir"; then
				echo "GATESEED unpacked $(bytes "$archive") bytes in $(($(date +%s) - start)) s"
				cache_lines "$RC"
				path=seeded
				rm -f -- "$archive"
			else
				echo "::warning title=Gate seed::unpacking the seed of run ${SEED_RUN_ID:-unknown} failed; this job builds cold"
				reason="unpack-failed"
				rm -rf -- "$seed_dir"
			fi
		fi
	elif [ -n "${SEED_SHA256:-}" ]; then
		echo "::warning title=Gate seed::run ${SEED_RUN_ID:-unknown} holds a seed, and $archive is not there: this job builds cold"
		reason="no-archive"
	fi
	# Whatever the build found, every test runs; and both the seeded build and
	# the cold one run build scripts in the same place, so that the control
	# below compares the cache and nothing else.
	{
		echo "build --strategy=CargoBuildScriptRun=local"
		echo "test --cache_test_results=no"
	} >>"$RC"
	echo "GATESEED path=$path reason=$reason run=${SEED_RUN_ID:-none} disk=$(kib "$seed_dir/disk") KiB repository=$(kib "$seed_dir/repo") KiB"
	echo "the bazelrc fragment this job builds with:"
	cat "$RC"
	;;
*)
	usage
	exit 2
	;;
esac
