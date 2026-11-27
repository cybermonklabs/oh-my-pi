#!/usr/bin/env bash
# The rustfmt row: `cargo fmt --all --check -v` in each cargo workspace the gate builds (sc.py
# rustfmt-workspaces: the root one, and each one .github/sami/rust-test-cargo-workspaces.txt lists),
# from the workspace's own directory, on the tree's own toolchain (the workflow's Toolchain step).
# rustfmt reads the rustfmt.toml nearest each file, so a workspace with none of its own takes the
# root's, as a developer's `cargo fmt` there does. One unit per workspace, named by its Cargo.toml.
# A formatter only: it compiles nothing and runs no code of the tree.
#
# Upstream's own formatting is no failure of the fork's. When a workspace has places rustfmt would
# change, the same check runs at the tree's upstream base: the merge base of the tree and upstream's
# main, fetched here (upstream is public; the checkout holds the fork's whole history without
# blobs, and upstream comes in the same way). sc.py rustfmt reads a place as upstream's own (KNOWN)
# when the lines it rewrites are lines the fork left as they are (`git diff -U0` from the base maps
# them) and the base's run fails the same run at the lines they map to; a place a fork change
# brought reads FAIL; one in a file the base's run did not check (rustfmt's own -v names each file
# it checks) stays unsorted (UNKNOWN).
#
# SC_PLANT=rustfmt first appends sc.py's planted function to the first target root of each
# workspace in the tree (the row's control: a fork-side place each unit must name). The verdicts
# are the summary's: this script ends 0 once it wrote every result.
set -uo pipefail
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
logs=$SC/res/logs
mkdir -p "$logs"
# shellcheck source=.github/sami-checks/upstream-base.sh
. "$tool/upstream-base.sh"
echo "TOOLCHAIN $(cd "$SC_TREE" && rustc -V) | $(cd "$SC_TREE" && cargo fmt --version)"
mapfile -t manifests < <(python3 "$tool/sc.py" rustfmt-workspaces)
if [ "${#manifests[@]}" = 0 ]; then
	echo "::error::sc.py named no cargo workspace to check"
	exit 1
fi
if [ "${SC_PLANT:-}" = rustfmt ]; then
	python3 "$tool/sc.py" plant rustfmt "$SC_TREE" || exit 1
fi

# `-- -v` makes rustfmt name each file it checks (`Formatting <path>`): at the base, that is the
# evidence that it read a file whose places the tree's run reports.
check() { # <workspace directory> <log>: prints "<exit> <seconds>"
	local s r
	s=$(date +%s)
	(cd "$1" && timeout -k 10 600 cargo fmt --all --check -v -- -v) > "$2" 2>&1 < /dev/null
	r=$?
	echo "$r $(($(date +%s) - s))"
}

declare -A rc secs
places=0
for m in "${manifests[@]}"; do
	name=$(printf '%s' "$m" | tr -c 'A-Za-z0-9_-' '_')
	if [ -f "$SC_TREE/$m" ]; then
		read -r "rc[$m]" "secs[$m]" < <(check "$(dirname "$SC_TREE/$m")" "$logs/rustfmt-$name.log")
	else
		: > "$logs/rustfmt-$name.log"
		rc[$m]=- secs[$m]=0
	fi
	if grep -q -E '^(Diff in .*:[0-9]+:|Incorrect newline style in )' "$logs/rustfmt-$name.log"; then
		places=1
	fi
done

# The upstream base (upstream-base.sh), only when some workspace has places to sort, and the fork's
# changes from it (`git diff -U0` of the base and the tree as checked, plant and all) in each file
# with places, headed by the path as rustfmt printed it: a place on lines the fork left as they are
# maps to its line at the base.
base=- base_tree=$SC/upstream-base setup=$logs/rustfmt-upstream-base.log fork=$logs/rustfmt-fork.diff
if [ "$places" = 1 ]; then
	if b=$(upstream_base "$SC_TREE" "$base_tree" "$setup"); then
		base=$b
		mapfile -t files < <(sed -n -E 's#^Diff in (.+):[0-9]+:$#\1#p; s#^Incorrect newline style in (.+)$#\1#p' "$logs"/rustfmt-*.log |
			sed "s#^$SC_TREE/##" | sort -u)
		fork_diff "$SC_TREE" "$base" "$fork" "$setup" "${files[@]}"
	else
		echo "::warning::the upstream base could not be set up, so a workspace's places stay unsorted (UNKNOWN):"
		tail -n 20 "$setup"
	fi
fi

for m in "${manifests[@]}"; do
	name=$(printf '%s' "$m" | tr -c 'A-Za-z0-9_-' '_')
	log=$logs/rustfmt-$name.log
	blog=$setup brc=-
	if [ "$base" != - ] && grep -q -E '^(Diff in .*:[0-9]+:|Incorrect newline style in )' "$log"; then
		blog=$logs/rustfmt-$name.upstream-base.log
		if [ -f "$base_tree/$m" ]; then
			read -r brc _ < <(check "$(dirname "$base_tree/$m")" "$blog")
		else
			: > "$blog"
			brc=absent
		fi
	fi
	python3 "$tool/sc.py" rustfmt "$m" "$log" "${rc[$m]}" "${secs[$m]}" "$SC_TREE" "$blog" "$brc" "$base_tree" "$base" "$fork" \
		> "$SC/res/rustfmt-$name.json"
	echo "RUSTFMT $m exit=${rc[$m]} ${secs[$m]}s, $(grep -c '^\[' "$log") target root(s); upstream base exit=$brc"
	python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["status"], r["note"]); [print("  FAIL", f) for f in r["failures"]]; [print("  KNOWN", f) for f in r["upstream_places"]]; [print("  UNSORTED", f) for f in r["unsorted_places"]]' "$SC/res/rustfmt-$name.json"
	# Each place as rustfmt printed it, for the reader of the job log.
	grep -v '^\[' "$log" | head -n 400
done
exit 0
