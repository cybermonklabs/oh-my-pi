#!/bin/sh
# Runs a command as this user with no network but loopback: in a network
# namespace of its own (sudo unshare -n), whose loopback is brought up. The
# rust_test job's test step (.github/sami/rust-test.sh) runs the #[ignore]d
# cargo tests under it, through RUST_TEST_OFFLINE_UNDER: omp-rpc's smoke
# tests start the omp server, which reaches a dozen hosts as it starts (run
# 44898771348), so nothing of theirs leaves the runner, and a pass of theirs
# does not rest on the network. GitHub's runner has passwordless sudo.
# Usage: rust-test-offline.sh <command> [<argument>...]
set -eu
exec sudo -E unshare -n -- sh -c '
	ip link set lo up
	u="$1" p="$2"
	shift 2
	exec sudo -E -u "$u" env "PATH=$p" "$@"
' sh "$(id -un)" "$PATH" "$@"
