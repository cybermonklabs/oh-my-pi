#!/usr/bin/env bash
# Puts the tree to build or test at $PC/tree: the same absolute path on every runner of one
# image, so the paths cargo compiles into test binaries (CARGO_MANIFEST_DIR, CARGO_BIN_EXE_*)
# hold where the test legs run them.
#
#   tree.sh setup            export PC, PY and CARGO_TARGET_DIR to later steps
#   tree.sh checkout SHA     $PC/tree at commit SHA (fetched by id; it must be pushed)
#   tree.sh plant SHA        apply commit SHA's own change (SHA^..SHA) to $PC/tree and print
#                            the planted tree id on stdout. Exit 3: it does not apply; exit 4:
#                            it changes nothing; exit 5: it cannot be fetched. Messages go to
#                            stderr.
set -euo pipefail

case "$1" in
setup)
	if [ "$RUNNER_OS" = Windows ]; then
		pc=$(cygpath -m "$RUNNER_TEMP")/pc
		py=python
		git config --global core.longpaths true
	else
		pc=$RUNNER_TEMP/pc
		py=python3
	fi
	mkdir -p "$pc/out" "$pc/logs" "$pc/up" "$pc/results" "$pc/upload"
	{
		echo "PC=$pc"
		echo "PY=$py"
		echo "CARGO_TARGET_DIR=$pc/out/target"
	} >> "$GITHUB_ENV"
	echo "PC=$pc image=${ImageOS:-?}/${ImageVersion:-?} cpus=$(getconf _NPROCESSORS_ONLN 2> /dev/null || echo "${NUMBER_OF_PROCESSORS:-?}")"
	;;
checkout)
	sha=$2
	git fetch --quiet --no-tags --depth=1 origin "$sha" || {
		echo "::error::cannot fetch $sha from origin: push it to a branch of this repository first" >&2
		exit 1
	}
	git worktree add --quiet --detach "$PC/tree" "$sha"
	got=$(git -C "$PC/tree" rev-parse HEAD)
	[ "$got" = "$sha" ] || {
		echo "::error::the tree is at $got, not $sha" >&2
		exit 1
	}
	echo "TREE $sha (tree $(git -C "$PC/tree" rev-parse 'HEAD^{tree}'))"
	;;
plant)
	sha=$2
	git fetch --quiet --no-tags --depth=2 origin "$sha" || {
		echo "::error::cannot fetch the plant $sha from origin: push it to a scratch branch first" >&2
		exit 5
	}
	git diff --binary "$sha^" "$sha" > "$PC/plant.diff"
	if [ ! -s "$PC/plant.diff" ]; then
		echo "::error::PLANT CHANGES NOTHING: commit $sha has no change of its own" >&2
		exit 4
	fi
	git -C "$PC/tree" apply --index "$PC/plant.diff" || {
		echo "::error::PLANT DOES NOT APPLY: the change of $sha does not apply to the head" >&2
		exit 3
	}
	if git -C "$PC/tree" diff --cached --quiet; then
		echo "::error::PLANT CHANGES NOTHING: the head already holds the change of $sha" >&2
		exit 4
	fi
	git -C "$PC/tree" diff --cached --stat | sed 's/^/PLANT /' >&2
	git -C "$PC/tree" write-tree
	;;
*)
	echo "usage: tree.sh setup | checkout SHA | plant SHA" >&2
	exit 2
	;;
esac
