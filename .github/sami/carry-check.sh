#!/usr/bin/env bash
# Fail when a new fork release does not carry the previous release's commits.
#
# A release is a flat octopus merge of member branches onto an upstream base,
# so the previous release is not an ancestor of the next one. This check
# compares them by content, as patch ids of zero-context diffs
# (`git log -p -U0 | git patch-id --stable`, which survive a rebase onto a
# moved base):
#
#   missing   a commit of the previous release that is not in the new
#             release's history and whose patch id no commit the new release
#             adds (fork or upstream) has;
#   reverted  a fork commit of the previous release, carried or not, whose
#             inverse patch id a fork commit the new release adds has, or
#             that such a commit names in "This reverts commit <sha>". A
#             member that grows by reverting part of itself still contains
#             the original commit, so ancestry alone would call it carried.
#
# Each finding must be named in the allow-list with a reason, one per line:
#   <commit sha, 12+ hex chars>  <reason>
# Blank lines and lines starting with '#' are ignored. An entry with no reason
# is an error. A squashed or reworded rebuild changes every patch id, so it is
# a finding for every commit it rewrote: name them, or keep the originals.
#
# Usage: carry-check.sh [--prev REV] [--new REV] [--upstream REV] [--allow FILE]
#                       [--notes FILE]
#   --prev      previous release (default: newest v*-sami.* tag not on --new)
#   --new       candidate release (default: HEAD)
#   --upstream  upstream trunk (default: upstream/main)
#   --allow     allow-list (default: .github/sami/carried-drops.txt in the
#               current checkout)
#   --notes     write release-note lines: the previous release and each
#               allow-listed drop since it, with its reason
# Exit: 0 carried or allowed, 1 unallowed findings, 2 usage or git error.
set -euo pipefail

prev="" new="HEAD" upstream="upstream/main" allow="" notes=""
while (($#)); do
	case "$1" in
	--prev) prev="$2"; shift 2 ;;
	--new) new="$2"; shift 2 ;;
	--upstream) upstream="$2"; shift 2 ;;
	--allow) allow="$2"; shift 2 ;;
	--notes) notes="$2"; shift 2 ;;
	-h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
	*) echo "carry-check: unknown argument: $1" >&2; exit 2 ;;
	esac
done

die() { echo "carry-check: $*" >&2; exit 2; }

new=$(git rev-parse --verify --quiet "$new^{commit}") || die "cannot resolve --new"
upstream=$(git rev-parse --verify --quiet "$upstream^{commit}") || die "cannot resolve --upstream (fetch upstream trunk first)"
if [[ -z $prev ]]; then
	while read -r tag; do
		c=$(git rev-parse "$tag^{commit}")
		if [[ $c != "$new" ]]; then prev=$tag; break; fi
	done < <(git tag -l 'v*-sami.*' --sort=-creatordate)
	[[ -n $prev ]] || die "no previous v*-sami.* tag; pass --prev"
fi
prev_label=$prev
prev=$(git rev-parse --verify --quiet "$prev^{commit}") || die "cannot resolve --prev"
[[ -n $allow ]] || allow="$(git rev-parse --show-toplevel)/.github/sami/carried-drops.txt"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# patch_ids OUT [-R] REV-LIST-ARGS...: "<patch-id> <commit>" per non-merge
# commit. A commit with an empty diff has no patch id; it carries nothing.
patch_ids() {
	local out=$1; shift
	local reverse=()
	if [[ ${1:-} == -R ]]; then reverse=(-R); shift; fi
	git log --no-merges --no-renames --no-color -p -U0 "${reverse[@]}" --format='commit %H' "$@" |
		git patch-id --stable | sort >"$out"
}

# The previous release's commits that the new release's history lacks.
git rev-list --no-merges "$new..$prev" >"$tmp/prev-only"
# Everything the new release adds over the previous one (fork and upstream),
# and the fork part alone.
patch_ids "$tmp/new-all" "$prev..$new"
patch_ids "$tmp/new-fork" "$prev..$new" "^$upstream"
# The previous release's fork commits, as inverse patches.
git rev-list --no-merges "$prev" "^$upstream" >"$tmp/prev-fork"
patch_ids "$tmp/prev-fork-inv" -R "$prev" "^$upstream"

declare -A finding=()
cut -d' ' -f1 "$tmp/new-all" | sort -u >"$tmp/new-all-ids"
if [[ -s $tmp/prev-only ]]; then
	git log --no-walk=unsorted --no-merges --no-renames --no-color -p -U0 --format='commit %H' \
		--stdin <"$tmp/prev-only" | git patch-id --stable >"$tmp/prev-only-ids"
	while read -r pid c; do
		grep -qxF "$pid" "$tmp/new-all-ids" || finding[$c]=missing
	done <"$tmp/prev-only-ids"
fi
cut -d' ' -f1 "$tmp/new-fork" | sort -u >"$tmp/new-fork-ids"
while read -r pid c; do
	if grep -qxF "$pid" "$tmp/new-fork-ids"; then finding[$c]=reverted; fi
done <"$tmp/prev-fork-inv"
{ git log --no-merges --format=%B "$prev..$new" "^$upstream" | grep -oE 'This reverts commit [0-9a-f]{7,40}' || true; } |
	awk '{print $4}' | sort -u >"$tmp/revert-named"
while read -r short; do
	c=$(grep -m1 "^$short" "$tmp/prev-fork" || true)
	if [[ -n $c ]]; then finding[$c]=reverted; fi
done <"$tmp/revert-named"

declare -A allowed=()
if [[ -f $allow ]]; then
	lineno=0
	while IFS= read -r line || [[ -n $line ]]; do
		lineno=$((lineno + 1))
		[[ $line =~ ^[[:space:]]*(#|$) ]] && continue
		[[ $line =~ ^([0-9a-f]{12,40})[[:space:]]+([^[:space:]].*)$ ]] ||
			die "$allow:$lineno: expected '<sha, 12+ hex chars> <reason>'"
		allowed[${BASH_REMATCH[1]}]=${BASH_REMATCH[2]}
	done <"$allow"
fi
reason_for() {
	local k
	for k in "${!allowed[@]}"; do
		if [[ $1 == "$k"* ]]; then printf '%s' "${allowed[$k]}"; return 0; fi
	done
	return 1
}

echo "carry-check: previous $prev_label (${prev:0:12}) -> new ${new:0:12}, upstream ${upstream:0:12}"
echo "carry-check: $(wc -l <"$tmp/prev-only") previous-release commit(s) outside the new history; ${#finding[@]} finding(s)"
: >"$tmp/allowed" >"$tmp/failed"
for c in "${!finding[@]}"; do
	subject=$(git log -1 --format=%s "$c")
	if reason=$(reason_for "$c"); then
		printf '%s\t%s\t%s\t%s\n' "${finding[$c]}" "${c:0:12}" "$subject" "$reason" >>"$tmp/allowed"
	else
		printf '%s\t%s\t%s\n' "${finding[$c]}" "${c:0:12}" "$subject" >>"$tmp/failed"
	fi
done
sort -o "$tmp/allowed" "$tmp/allowed"
sort -o "$tmp/failed" "$tmp/failed"
awk -F'\t' '{printf "  allowed  %s  %s  %s  -- %s\n", $1, $2, $3, $4}' "$tmp/allowed"
awk -F'\t' '{printf "  FAIL     %s  %s  %s\n", $1, $2, $3}' "$tmp/failed"
if [[ -n $notes ]]; then
	{
		echo "Previous release: $prev_label (${prev:0:12})."
		if [[ -s $tmp/allowed ]]; then
			echo "Deliberately not carried from it (.github/sami/carried-drops.txt):"
			awk -F'\t' '{printf "- %s %s (%s): %s\n", $2, $3, $1, $4}' "$tmp/allowed"
		else
			echo "Every commit of it is carried."
		fi
	} >"$notes"
fi
bad=$(wc -l <"$tmp/failed")
if ((bad)); then
	echo "carry-check: $bad finding(s) not in $allow. Carry them, or add '<sha> <reason>' lines for deliberate drops." >&2
	exit 1
fi
echo "carry-check: every previous-release commit is carried or allowed"
