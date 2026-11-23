#!/usr/bin/env bash
# bun.sh          bun 1.4.5, the release zip whose sha256 sami-rust-test.yml's rust_test pins, on PATH:
#                 package.json names only a floor (bun@>=1.4.4), and test code runs in these jobs.
# bun.sh addon    the natives job's addon is the only addon a workspace load reads
#                 (packages/natives/native and bun's own directory: loader-state.js), as the
#                 gate kit's place_addon checks.
# bun.sh chrome   the Chrome for Testing build the tree's puppeteer-core pins (chrome.ts), as
#                 PUPPETEER_EXECUTABLE_PATH for the later steps: the browser tests run against the
#                 Chrome the tree targets. The runner's own google-chrome launches with the tree's
#                 --enable-features=WebMCPTesting,DevToolsWebMCPSupport and still gives pages no
#                 WebMCP (9 browser-webmcp tests failed on it in runs 45231893264 and 45245119907).
set -euo pipefail
case "${1:-install}" in
install)
	zip=$RUNNER_TEMP/bun-linux-x64.zip
	url=https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/bun-linux-x64.zip
	curl -fsSL --retry 3 --retry-delay 5 -o "$zip" "$url"
	echo "94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb  $zip" | sha256sum -c - ||
		{ echo "::error title=bun::$url does not have the pinned sha256"; exit 1; }
	unzip -q -o -d "$RUNNER_TEMP/bun" "$zip"
	mkdir -p "$HOME/.bun/bin"
	install -m 0755 "$RUNNER_TEMP/bun/bun-linux-x64/bun" "$HOME/.bun/bin/bun"
	echo "$HOME/.bun/bin" >> "$GITHUB_PATH"
	"$HOME/.bun/bin/bun" --version
	;;
addon)
	bun=$(command -v bun)
	found=$(find "$SC_TREE/packages/natives/native" "$(dirname "$(readlink -f "$bun")")" -maxdepth 1 -name '*.node' -print | sort)
	n=$(printf '%s\n' "$found" | grep -c . || true)
	echo "ADDONS $n: $found"
	[ "$n" = 1 ] || { echo "::error title=Addon::expected exactly one addon where the loader looks, found $n"; exit 1; }
	sha256sum $found
	;;
chrome)
	exe=$(bun "$(dirname "$0")/chrome.ts" "$SC_TREE" "$RUNNER_TEMP/chrome" | tail -n 1)
	[ -x "$exe" ] || { echo "::error title=Chrome::chrome.ts gave no executable ($exe)"; exit 1; }
	echo "CHROME pinned: $("$exe" --version) at $exe; the runner's own: $(google-chrome --version 2> /dev/null || echo none)"
	echo "PUPPETEER_EXECUTABLE_PATH=$exe" >> "$GITHUB_ENV"
	;;
esac
