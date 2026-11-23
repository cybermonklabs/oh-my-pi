#!/usr/bin/env bash
# Downloads a file whose sha256 is pinned, from the first of its URLs that
# gives exactly those bytes: in .github/workflows/sami-rust-test.yml, the rust_test
# job's reference rsync, zsh and bash and its bun, and the bash that
# rust_test_macos runs its steps with.
#
# Usage: fetch-verified.sh <title> <destination> <sha256> <url>...
#
# Each URL is tried in order, with curl's retries. A URL whose download fails,
# or whose bytes have another sha256, gets a warning, and the next URL is
# tried. Exits 0 once <destination> holds the pinned bytes; exits 1, with an
# error and no file at <destination>, when no URL gave them.
# FETCH_VERIFIED_CURL names the command used in place of curl (the regression
# harness in .github/sami/tests runs this with no network).
set -euo pipefail
if [ "$#" -lt 4 ]; then
	echo "usage: fetch-verified.sh <title> <destination> <sha256> <url>..." >&2
	exit 2
fi
title="$1" dest="$2" sha="$3"
shift 3
if ! [[ "$sha" =~ ^[0-9a-f]{64}$ ]]; then
	echo "::error title=$title::$sha is not a sha256"
	exit 2
fi
curl="${FETCH_VERIFIED_CURL:-curl}"
# GNU coreutils' sha256sum, or macOS's shasum; both check `<sha>  <file>`.
sha256=(sha256sum)
command -v sha256sum >/dev/null || sha256=(shasum -a 256)
for url in "$@"; do
	rm -f -- "$dest"
	if "$curl" -fsSL --retry 3 --retry-all-errors --retry-delay 10 --connect-timeout 20 --max-time 120 -o "$dest" "$url" &&
		echo "$sha  $dest" | "${sha256[@]}" -c -; then
		echo "$(basename -- "$dest") from $url"
		exit 0
	fi
	echo "::warning title=$title::$url gave no file with sha256 $sha"
done
rm -f -- "$dest"
echo "::error title=$title::no source gave $(basename -- "$dest") with sha256 $sha"
exit 1
