#!/bin/sh
# Runs one test binary with a temporary directory of its own. The rust_test
# job (.github/sami/rust-test.sh) gives it to `bazel test` as --run_under, so
# each test action gets a new TMPDIR under <parent>, on the reflink
# filesystem. Bazel gives every action the one TMPDIR of the bazel command,
# and linux-sandbox starts each action in a PID namespace of its own, so two
# tests that name a path by their process id would otherwise meet in one
# directory.
# Usage: rust-test-tmpdir.sh <parent> <test binary> [<argument>...]
set -eu
parent="$1"
shift
TMPDIR="$(mktemp -d "$parent/test.XXXXXXXX")"
export TMPDIR
exec "$@"
