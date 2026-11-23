#!/usr/bin/env bash
# release-candidate.sh find|verify: the checks of sami-build.yml's publish
# job. That job runs on a push to sami, and publishes the archives and the
# release notes of the green sami-build run of $CANDIDATE_BRANCH at the same
# commit. It never builds them again.
#
#   find    Finds that run with one REST call, checks each of the query's
#           filters again on the answer, and writes the highest such run id
#           to $GITHUB_OUTPUT as run_id. No such run: it fails.
#   verify  Checks run $RUN_ID's artifacts, downloaded under
#           $RUNNER_TEMP/candidate. For each target of $RELEASE_TARGETS,
#           mise-<target>/ holds exactly one omp-<tag>-<target>.tar.gz and its
#           sidecar <archive>.sha256, and nothing else; no other mise-*
#           artifact exists. The sidecar, the archive and
#           release-notes/carry-notes.md each have an attestation that run
#           made (gh attestation verify); each archive's sha256 is the one its
#           sidecar gives, and a mismatch is named with both digests; every
#           archive names the same tag. The notes' first line, which
#           carry-check.sh writes, names the newest v*-sami.* tag not on this
#           commit: a release published after the candidate's carry check
#           was not compared with it. Then it copies the archives to
#           $RUNNER_TEMP/candidate/publish/ and writes tag, files and notes to
#           $GITHUB_OUTPUT. It reads the tags of the checkout it runs in.
# Each failure writes ::error lines and a step summary and exits 1, so the
# job publishes nothing.
set -euo pipefail

workflow=.github/workflows/sami-build.yml
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"

fail() { # <message>...: each one as an ::error line and in the summary; exit 1
	local m
	for m in "$@"; do
		m="${m//'%'/%25}"
		m="${m//$'\r'/%0D}"
		printf '::error title=Release candidate::%s\n' "${m//$'\n'/%0A}"
	done
	{
		echo "### Nothing is published"
		echo
		for m in "$@"; do printf -- '- %s\n' "$m"; done
	} >>"$summary"
	exit 1
}

need() { # <variable>...: each one must be set and not empty
	local v
	for v in "$@"; do
		[ -n "${!v:-}" ] || fail "$v is not set"
	done
}

find_run() {
	need GITHUB_REPOSITORY GITHUB_SHA CANDIDATE_BRANCH GITHUB_OUTPUT
	local runs id url
	runs="$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/sami-build.yml/runs?branch=$CANDIDATE_BRANCH&event=push&head_sha=$GITHUB_SHA&status=success&per_page=100")" ||
		fail "the query for green sami-build runs of $CANDIDATE_BRANCH at $GITHUB_SHA failed; nothing is published"
	# One page holds every run of one commit; if it did not, the newest
	# could be on a page this call did not read.
	jq -e '(.workflow_runs | length) == .total_count' <<<"$runs" >/dev/null ||
		fail "UNKNOWN: the query for sami-build runs of $CANDIDATE_BRANCH at $GITHUB_SHA returned $(jq '.workflow_runs | length' <<<"$runs") of $(jq .total_count <<<"$runs") runs; nothing is published"
	# The query's filters are not trusted: each one is checked again here.
	id="$(jq -r --arg sha "$GITHUB_SHA" --arg branch "$CANDIDATE_BRANCH" --arg path "$workflow" '
		[.workflow_runs[]
		 | select(.head_sha == $sha and .event == "push" and .head_branch == $branch
		          and .conclusion == "success" and .path == $path)
		 | .id] | max // empty' <<<"$runs")"
	[ -n "$id" ] || fail "no green sami-build run of $CANDIDATE_BRANCH at $GITHUB_SHA; nothing is published"
	url="$(jq -r --argjson id "$id" '.workflow_runs[] | select(.id == $id) | .html_url' <<<"$runs")"
	echo "run_id=$id" >>"$GITHUB_OUTPUT"
	echo "The candidate run: $url ($CANDIDATE_BRANCH at $GITHUB_SHA)"
	printf 'Candidate run: [%s](%s), %s at %s\n\n' "$id" "$url" "$CANDIDATE_BRANCH" "$GITHUB_SHA" >>"$summary"
}

# attested <file>: true when gh attestation verify accepts the file as built
# by this repository's sami-build.yml from $GITHUB_SHA on
# refs/heads/$CANDIDATE_BRANCH on a GitHub-hosted runner, and one of the
# attestations it accepts was made by run $RUN_ID. Otherwise it sets why and
# returns 1.
attested() {
	local out err
	err="$(mktemp)"
	if ! out="$(gh attestation verify "$1" --repo "$GITHUB_REPOSITORY" \
		--signer-workflow "$GITHUB_REPOSITORY/$workflow" \
		--source-digest "$GITHUB_SHA" --source-ref "refs/heads/$CANDIDATE_BRANCH" \
		--deny-self-hosted-runners --limit 1000 --format json 2>"$err")"; then
		why="gh attestation verify refused it: $(tr -s '\n' ' ' <"$err" | cut -c 1-400)"
		rm -f -- "$err"
		return 1
	fi
	rm -f -- "$err"
	if ! jq -e --arg r "/actions/runs/$RUN_ID/" '[.. | strings | select(contains($r))] | length > 0' <<<"$out" >/dev/null; then
		why="it has no attestation that run $RUN_ID made"
		return 1
	fi
}

# previous_line: the first line carry-check.sh writes in its notes for the
# newest v*-sami.* tag not on $GITHUB_SHA, chosen as carry-check.sh chooses
# its --prev. No such tag: returns 1.
previous_line() {
	local tag c
	while read -r tag; do
		c="$(git rev-parse "$tag^{commit}")"
		if [ "$c" != "$GITHUB_SHA" ]; then
			printf 'Previous release: %s (%s).\n' "$tag" "${c:0:12}"
			return 0
		fi
	done < <(git tag -l 'v*-sami.*' --sort=-creatordate)
	return 1
}

verify() {
	need GITHUB_REPOSITORY GITHUB_SHA CANDIDATE_BRANCH RUN_ID RELEASE_TARGETS RUNNER_TEMP GITHUB_OUTPUT
	[[ "$RUN_ID" =~ ^[0-9]+$ ]] || fail "RUN_ID is not a run id: $RUN_ID"
	local dir="$RUNNER_TEMP/candidate" t d e x known base listing archive sidecar want got tag i notes noted prev pub delim
	local -a errors=() entries=() archives=() sums=() tags=()
	echo "::group::$(gh --version | sed -n 1p): gh attestation verify --help"
	gh attestation verify --help
	echo "::endgroup::"

	# Exactly one archive and its sidecar per target, and nothing else.
	for t in $RELEASE_TARGETS; do
		d="$dir/mise-$t"
		if [ ! -d "$d" ] || [ -L "$d" ]; then
			errors+=("the candidate run has no mise-$t artifact")
			continue
		fi
		listing="$(cd "$d" && find . -mindepth 1 -printf '%P\n' | LC_ALL=C sort)"
		mapfile -t entries <<<"$listing"
		if [ "${#entries[@]}" = 2 ] && [[ "${entries[0]}" == omp-*-"$t".tar.gz && "${entries[0]}" != */* ]] &&
			[ "${entries[1]}" = "${entries[0]}.sha256" ] &&
			[ -f "$d/${entries[0]}" ] && [ ! -L "$d/${entries[0]}" ] &&
			[ -f "$d/${entries[1]}" ] && [ ! -L "$d/${entries[1]}" ]; then
			archives+=("$d/${entries[0]}")
		else
			errors+=("mise-$t must hold exactly one omp-<tag>-$t.tar.gz and its .sha256, and nothing else; it holds: $(printf '%s ' "${entries[@]}")")
		fi
	done
	for d in "$dir"/mise-*; do
		[ -e "$d" ] || continue
		t="${d##*/mise-}"
		known=0
		for x in $RELEASE_TARGETS; do
			if [ "$x" = "$t" ]; then known=1; fi
		done
		[ "$known" = 1 ] ||
			errors+=("the candidate run has an artifact mise-$t, and $t is not a release target ($RELEASE_TARGETS)")
	done
	[ "${#errors[@]}" = 0 ] || fail "${errors[@]}"

	# Each archive: its sidecar is attested and is one sha256sum line, the
	# archive's own sha256 is the sidecar's, and the archive is attested.
	for archive in "${archives[@]}"; do
		sidecar="$archive.sha256"
		base="${archive##*/}"
		want=""
		if attested "$sidecar"; then
			if [ "$(wc -l <"$sidecar")" = 1 ] && [[ "$(cat -- "$sidecar")" =~ ^([0-9a-f]{64})\ \ (.+)$ ]] && [ "${BASH_REMATCH[2]}" = "$base" ]; then
				want="${BASH_REMATCH[1]}"
			else
				errors+=("$base.sha256 is not exactly one line '<sha256>  $base'")
			fi
		else
			errors+=("$base.sha256: $why")
		fi
		got="$(sha256sum -- "$archive" | cut -d ' ' -f 1)"
		if [ -n "$want" ] && [ "$got" != "$want" ]; then
			errors+=("$base: sha256 $got; the candidate run attested $want")
		fi
		attested "$archive" || errors+=("$base: $why")
		t="${archive%/*}"
		t="${t##*/mise-}"
		tag="${base#omp-}"
		tags+=("${tag%-"$t".tar.gz}")
		sums+=("$got")
	done
	for tag in "${tags[@]}"; do
		[ "$tag" = "${tags[0]}" ] || errors+=("the archives name different tags: ${tags[*]}")
	done
	[[ "${tags[0]}" =~ ^v[0-9][0-9A-Za-z.]*-sami\.[0-9]{8}-[0-9]{6}$ ]] ||
		errors+=("the archives' tag ${tags[0]} is not v<version>-sami.<YYYYMMDD>-<HHMMSS>")

	notes="$dir/release-notes/carry-notes.md"
	if [ ! -f "$notes" ] || [ -L "$notes" ]; then
		errors+=("the candidate run's release-notes artifact holds no carry-notes.md")
	elif ! attested "$notes"; then
		errors+=("release-notes/carry-notes.md: $why")
	elif ! prev="$(previous_line)"; then
		errors+=("UNKNOWN: the checkout has no v*-sami.* tag, so the release the candidate must carry is not known")
	else
		noted="$(sed -n 1p -- "$notes")"
		[ "$noted" = "$prev" ] ||
			errors+=("the candidate's carry check compared it with the release in [$noted], and the newest release is now [$prev]: push the candidate to $CANDIDATE_BRANCH again, so that carry compares it with that release")
	fi
	[ "${#errors[@]}" = 0 ] || fail "${errors[@]}"

	# Publish copies of the checked files, each checked again after the copy.
	pub="$dir/publish"
	mkdir -- "$pub"
	for i in "${!archives[@]}"; do
		cp -- "${archives[$i]}" "$pub/"
		got="$(sha256sum -- "$pub/${archives[$i]##*/}" | cut -d ' ' -f 1)"
		[ "$got" = "${sums[$i]}" ] || fail "the copy of ${archives[$i]##*/} has sha256 $got, not ${sums[$i]}"
	done
	# sami-release pastes its body into a double-quoted shell echo, so the
	# notes must not carry quotes, backquotes, dollars or backslashes.
	delim="CARRY_NOTES_$(od -An -N 16 -t x1 /dev/urandom | tr -d ' \n')"
	{
		echo "tag=${tags[0]}"
		echo "files=$pub/*.tar.gz"
		echo "notes<<$delim"
		printf '%s\n' "$(tr -d '"`$\\' <"$notes")"
		echo "$delim"
	} >>"$GITHUB_OUTPUT"

	{
		echo "### Verified: what run [$RUN_ID](${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY/actions/runs/$RUN_ID) built and attested"
		echo
		echo "Tag \`${tags[0]}\`. Each archive, its sidecar and release-notes/carry-notes.md have an attestation of that run."
		echo
		echo "| Archive | sha256 |"
		echo "| --- | --- |"
		for i in "${!archives[@]}"; do
			printf '| `%s` | `%s` |\n' "${archives[$i]##*/}" "${sums[$i]}"
		done
	} >>"$summary"
	echo "Verified against run $RUN_ID, tag ${tags[0]}:"
	for i in "${!archives[@]}"; do
		printf '%s  %s\n' "${sums[$i]}" "${archives[$i]##*/}"
	done
}

case "${1:-}" in
find) find_run ;;
verify) verify ;;
*)
	echo "usage: $0 find|verify" >&2
	exit 2
	;;
esac
