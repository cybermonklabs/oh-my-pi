#!/bin/sh
# Runs one test binary with a temporary directory of its own. The rust_test
# job (.github/sami/rust-test.sh) gives it to `bazel test` as --run_under, so
# each test action gets a new TMPDIR under <parent>, on the reflink
# filesystem. Bazel gives every action the one TMPDIR of the bazel command,
# and linux-sandbox starts each action in a PID namespace of its own, so two
# tests that name a path by their process id would otherwise meet in one
# directory.
# A rust_test target runs all its tests in one libtest process, and Bazel's
# timeout bounds only the whole target: a test that never ends holds it to
# that timeout, and its TIMEOUT names no test. So the binary runs under
# libtest-bound.py, which gives each test the bound the tree's
# .config/nextest.toml gives it under nextest, and fails by name, in libtest's
# own record, the tests the binary was running when it stopped making
# progress. A doctest target (its name ends in _doc_test) runs as it is: its
# runner hands the arguments to each doctest binary, so it is not one libtest
# process.
# Usage: rust-test-tmpdir.sh <parent> <test binary> [<argument>...]
set -eu
parent="$1"
shift
TMPDIR="$(mktemp -d "$parent/test.XXXXXXXX")"
export TMPDIR
case "${TEST_TARGET:-}" in
*_doc_test) exec "$@" ;;
esac
here="$(cd "$(dirname "$0")" && pwd)"
# //crates/pi-builtins:pi-builtins_test is cargo's package pi-builtins, which
# the config's overrides name.
package="${TEST_TARGET:-}"
package="${package#//}"
package="${package%%:*}"
exec python3 "$here/libtest-bound.py" --nextest-config "$here/../../.config/nextest.toml" \
	--package "${package##*/}" -- "$@"
