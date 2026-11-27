# shellcheck shell=bash
# The tree's upstream base, for the rows that read a finding upstream's own (KNOWN) when the same
# check fails at that base on the lines the fork left as they are: rustfmt.sh and builtins-lint.sh.
# Sourced; it runs nothing by itself. sc.py read_fork_diff and base_line read what fork_diff writes.
sc_upstream=https://github.com/can1357/oh-my-pi.git

# upstream_base <tree> <base worktree> <setup log>: fetches upstream's main into TREE's repository
# (upstream is public; the checkout holds the fork's whole history without blobs, and upstream comes
# in the same way, as a second promisor remote), takes the merge base of TREE's HEAD and upstream's
# main, and checks it out at BASE WORKTREE. Prints the base's id on stdout and the line that names it
# on stderr; returns non-zero, with the reason in SETUP LOG, when a step fails.
upstream_base() {
	local b
	{
		git -C "$1" remote add upstream "$sc_upstream" &&
			git -C "$1" config remote.upstream.promisor true &&
			git -C "$1" config remote.upstream.partialclonefilter blob:none &&
			timeout -k 10 900 git -C "$1" fetch --no-tags --filter=blob:none upstream main &&
			b=$(git -C "$1" merge-base HEAD FETCH_HEAD) &&
			timeout -k 10 900 git -C "$1" worktree add --detach "$2" "$b"
	} > "$3" 2>&1 || return 1
	echo "UPSTREAM BASE $b: the merge base of $(git -C "$1" rev-parse HEAD) and upstream's main $(git -C "$1" rev-parse FETCH_HEAD)" >&2
	echo "$b"
}

# fork_diff <tree> <base> <out> <setup log> <file>...: the fork's changes from BASE to TREE as
# checked (its working tree: a plant and a lift are in it) in each FILE, one section a file: a
# `### <file>` line (the path as given, relative to TREE), then the hunk headers of `git diff -U0`
# of that file, with a literal pathspec (git would quote a path with other than ASCII in it). A
# file with no hunk is one the fork left as it is. Returns non-zero, with OUT removed, when a diff
# fails: the findings then stay unsorted (UNKNOWN).
fork_diff() {
	local tree=$1 base=$2 out=$3 log=$4 f
	shift 4
	: > "$out"
	for f in "$@"; do
		printf '### %s\n' "$f" >> "$out"
		if ! git -C "$tree" diff -U0 --no-color --no-ext-diff --no-renames --text "$base" -- ":(literal)$f" \
			> "$out.one" 2>> "$log"; then
			echo "::warning::the fork's diff of $f from the upstream base failed, so the findings stay unsorted (UNKNOWN)"
			rm -f "$out" "$out.one"
			return 1
		fi
		grep -E '^@@ ' "$out.one" >> "$out"
	done
	rm -f "$out.one"
	echo "FORK DIFF: $# file(s) with findings, $(grep -c '^@@ ' "$out") hunk(s) of the fork's in them"
}
