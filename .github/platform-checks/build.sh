#!/usr/bin/env bash
# Builds the tests of one tree once and archives them (`cargo nextest archive`). In the head
# job, then applies the plant to the same tree and archives again: cargo rebuilds only the
# crates the plant changed. Writes the archives to $PC/up and the build record, which the
# report reads, to $PC/logs/build.env.
set -uo pipefail
cd "$PC/tree" || exit 1
rec=$PC/logs/build.env
args=()
IFS=, read -ra crates <<< "$PC_CRATES"
for c in "${crates[@]}"; do args+=(-p "$c"); done

# Dependency files rust-cache put back: 0 is a cold build.
restored=$(find "$CARGO_TARGET_DIR/debug/deps" -maxdepth 1 -type f 2> /dev/null | wc -l | tr -d ' ')
{
	echo "sha=$(git rev-parse HEAD)"
	echo "image=${ImageOS:-?}/${ImageVersion:-?}"
	echo "rustc=$(rustc -V | cut -d' ' -f2-)"
	echo "nextest=$(cargo nextest --version | head -n 1)"
	echo "cache_hit=${PC_CACHE_HIT:-}"
	echo "restored_deps=$restored"
} > "$rec"

archive() { # LABEL: build and archive the tree as it stands into $PC/up/LABEL.tar.zst
	local s rc
	s=$(date +%s)
	cargo nextest archive "${args[@]}" --archive-file "$PC/up/$1.tar.zst" > "$PC/logs/build-$1.log" 2>&1
	rc=$?
	echo "BUILD $1 exit=$rc in $(($(date +%s) - s)) s, $(grep -c '^ *Compiling ' "$PC/logs/build-$1.log") crates compiled" >&2
	echo "$rc $(($(date +%s) - s))"
}

read -r rc secs < <(archive "$PC_TREE")
{
	echo "exit=$rc"
	echo "seconds=$secs"
} >> "$rec"
status=$rc

if [ "$PC_TREE" = head ] && [ -n "${PC_PLANT:-}" ]; then
	if [ "$rc" != 0 ]; then
		echo "plant_exit=not built: the head did not build" >> "$rec"
	else
		planted=$(bash "$GITHUB_WORKSPACE/.github/platform-checks/tree.sh" plant "$PC_PLANT")
		prc=$?
		case "$prc" in
		0) ;;
		4) echo "plant_exit=changes nothing" >> "$rec" ;;
		5) echo "plant_exit=cannot be fetched" >> "$rec" ;;
		*) echo "plant_exit=does not apply" >> "$rec" ;;
		esac
		if [ "$prc" != 0 ]; then
			status=1
		else
			echo "plant_tree=$planted" >> "$rec"
			if [ "$planted" != "$PC_PLANT_TREE" ]; then
				echo "::error::the planted tree is $planted here and $PC_PLANT_TREE in the plan"
				status=1
			fi
			read -r prc psecs < <(archive plant)
			{
				echo "plant_exit=$prc"
				echo "plant_seconds=$psecs"
			} >> "$rec"
			[ "$prc" = 0 ] || status=$prc
		fi
	fi
fi
du -k "$PC"/up/*.tar.zst 2> /dev/null | sed 's/^/ARCHIVE KiB /' >&2
exit "$status"
