# Independent harness for .github/sami/release-candidate.sh (the PR #232 reviewer's), with a stub gh. run.sh runs it.
set -u
RC="$1"; pass=0; failn=0
W=$(mktemp -d); mkdir -p "$W/bin" "$W/repo"
cat > "$W/bin/gh" <<'GH'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "gh version 2.104.0 (stub)"; exit 0; fi
if [ "$1" = attestation ] && [ "$2" = verify ] && [ "${3:-}" = --help ]; then echo "stub help"; exit 0; fi
if [ "$1" = attestation ] && [ "$2" = verify ]; then
  f="$3"; b="${f##*/}"
  printf '%s\n' "$*" >> "$STUB_LOG"
  case " ${STUB_REFUSE:-} " in *" $b "*) echo "Error: HTTP 404 stub refuses $b" >&2; exit 1;; esac
  run="${STUB_RUN:-4242}"; case " ${STUB_OTHER:-} " in *" $b "*) run=999;; esac
  repo=o/r; case " ${STUB_FOREIGN:-} " in *" $b "*) repo=x/r;; esac
  trigger=push; case " ${STUB_DISPATCH:-} " in *" $b "*) trigger=workflow_dispatch;; esac
  ref=sami-candidate; case " ${STUB_SIGNER_REF:-} " in *" $b "*) ref=other;; esac
  printf '[{"verificationResult":{"signature":{"certificate":{"runInvocationURI":"https://github.com/%s/actions/runs/%s/attempts/1","buildTrigger":"%s","buildSignerURI":"https://github.com/o/r/.github/workflows/sami-build.yml@refs/heads/%s"}}},"attestation":{"bundle":{"x":"%s"}}}]\n' "$repo" "$run" "$trigger" "$ref" "${STUB_PLANT:-}"
  exit 0
fi
if [ "$1" = api ]; then cat "$STUB_RUNS"; exit 0; fi
echo "stub gh: unexpected $*" >&2; exit 3
GH
chmod +x "$W/bin/gh"
export PATH="$W/bin:$PATH" STUB_LOG="$W/ghlog"
cd "$W/repo" && git init -q && git config user.email r@x && git config user.name r
git commit -q --allow-empty -m old && git tag v18.18.6-sami.20261122-091943 && sleep 1.1
git commit -q --allow-empty -m prev && git tag v18.18.6-sami.20261123-024918 && PREVC=$(git rev-parse HEAD)
git commit -q --allow-empty -m cand && SHA=$(git rev-parse HEAD)
TAG=v18.18.7-sami.20261123-090000
setup() { # fresh candidate dir
  export RUNNER_TEMP="$W/rt"; rm -rf "$RUNNER_TEMP"; mkdir -p "$RUNNER_TEMP/candidate/release-notes"
  for t in linux-x64 darwin-arm64; do d="$RUNNER_TEMP/candidate/mise-$t"; mkdir -p "$d"; a="omp-$TAG-$t.tar.gz"
    head -c 4096 /dev/urandom > "$d/$a"; (cd "$d" && sha256sum "$a" > "$a.sha256"); done
  printf 'Previous release: v18.18.6-sami.20261123-024918 (%s).\n\nnotes body\n' "${PREVC:0:12}" > "$RUNNER_TEMP/candidate/release-notes/carry-notes.md"
  export GITHUB_OUTPUT="$W/out"; : > "$GITHUB_OUTPUT"; export GITHUB_STEP_SUMMARY="$W/sum"; : > "$GITHUB_STEP_SUMMARY"
  export GITHUB_REPOSITORY=o/r GITHUB_SHA="$SHA" CANDIDATE_BRANCH=sami-candidate RUN_ID=4242 RELEASE_TARGETS="linux-x64 darwin-arm64"
  unset STUB_REFUSE STUB_OTHER STUB_PLANT STUB_RUN STUB_FOREIGN STUB_DISPATCH STUB_SIGNER_REF; : > "$STUB_LOG"
}
case_() { # name want(0|1) msg-regex  -- runs verify in the repo
  local name="$1" want="$2" msg="$3" out rc ok=1
  out="$(cd "$W/repo" && bash "$RC" verify 2>&1)"; rc=$?
  if [ "$want" = 0 ] && [ "$rc" != 0 ]; then ok=0; fi
  if [ "$want" != 0 ] && [ "$rc" = 0 ]; then ok=0; fi
  if [ -n "$msg" ] && ! printf '%s\n' "$out" | grep -Eq -- "$msg"; then ok=0; fi
  if [ "$ok" = 1 ]; then pass=$((pass+1)); echo "PASS $name rc=$rc"; else failn=$((failn+1)); echo "FAIL $name rc=$rc want=$want msg=/$msg/"; printf '%s\n' "$out" | grep -E '::error|Verified' | head -4 | sed 's/^/    | /'; fi
}
setup; case_ V0-good 0 "Verified against run 4242, tag $TAG"
grep -q "^tag=$TAG$" "$GITHUB_OUTPUT" && echo "PASS V0-output-tag" || { echo "FAIL V0-output-tag"; failn=$((failn+1)); }
grep -c -- '--source-ref refs/heads/sami-candidate' "$STUB_LOG" | sed 's/^/INFO verify calls with source-ref: /'
grep -c -- '--deny-self-hosted-runners' "$STUB_LOG" | sed 's/^/INFO verify calls with deny-self-hosted: /'
[ "$(grep -c -- '--cert-identity https://github.com/o/r/.github/workflows/sami-build.yml@refs/heads/sami-candidate ' "$STUB_LOG")" = 5 ] && echo "PASS V0-cert-identity" || { echo "FAIL V0-cert-identity"; failn=$((failn+1)); }
setup; touch "$RUNNER_TEMP/candidate/mise-linux-x64/extra"; case_ V1-extra-file 1 'mise-linux-x64 must hold exactly one'
setup; mkdir -p "$RUNNER_TEMP/candidate/mise-linux-arm64"; case_ V2-extra-artifact 1 'artifact mise-linux-arm64'
setup; head -c 10 /dev/urandom >> "$RUNNER_TEMP/candidate/mise-linux-x64/omp-$TAG-linux-x64.tar.gz"; case_ V3-swapped-archive 1 'sha256 [0-9a-f]{64}; the candidate run attested [0-9a-f]{64}'
setup; export STUB_OTHER="omp-$TAG-linux-x64.tar.gz"; case_ V4-archive-attested-by-another-run 1 'has no attestation that run 4242 made'
setup; export STUB_OTHER="carry-notes.md"; case_ V4b-notes-attested-by-another-run 1 'carry-notes.md: it has no attestation that run 4242 made'
setup; export STUB_REFUSE="omp-$TAG-darwin-arm64.tar.gz.sha256"; case_ V5-sidecar-refused 1 'sha256: gh attestation verify refused it'
setup; printf 'Previous release: v18.18.6-sami.20261122-091943 (abc).\n' > "$RUNNER_TEMP/candidate/release-notes/carry-notes.md"; case_ V6-stale-notes 1 'compared it with the release in'
setup; d="$RUNNER_TEMP/candidate/mise-darwin-arm64"; rm "$d"/*; a="omp-v18.18.7-sami.20261123-090001-darwin-arm64.tar.gz"; head -c 99 /dev/urandom > "$d/$a"; (cd "$d" && sha256sum "$a" > "$a.sha256"); case_ V7-tags-differ 1 'name different tags'
setup; d="$RUNNER_TEMP/candidate/mise-linux-x64"; a="omp-$TAG-linux-x64.tar.gz"; mv "$d/$a" "$W/real.tgz"; ln -s "$W/real.tgz" "$d/$a"; case_ V8-symlinked-archive 1 'must hold exactly one'
setup; printf 'Previous release: v18.18.6-sami.20261123-024918 (%s).\nx $(id) `id` "q" \\\\ end\n' "${PREVC:0:12}" > "$RUNNER_TEMP/candidate/release-notes/carry-notes.md"; case_ V9-notes-shell-chars-stripped 0 'Verified'
if grep -q '[$`"\\]' <(sed -n '/^notes<</,/^CARRY_NOTES/p' "$GITHUB_OUTPUT" | sed '1d;$d'); then echo "FAIL V9-notes-output-clean"; failn=$((failn+1)); else echo "PASS V9-notes-output-clean"; fi
setup; d="$RUNNER_TEMP/candidate/mise-linux-x64"; a="omp-$TAG-linux-x64.tar.gz"; echo "extra line" >> "$d/$a.sha256"; case_ V10-sidecar-two-lines 1 'is not exactly one line'
setup; rm -r "$RUNNER_TEMP/candidate/mise-darwin-arm64"; case_ V11-missing-target 1 'has no mise-darwin-arm64 artifact'
setup; d="$RUNNER_TEMP/candidate/mise-linux-x64"; for f in "$d"/*; do mv "$f" "${f/$TAG/v18.18.7-bad}"; done; d="$RUNNER_TEMP/candidate/mise-darwin-arm64"; for f in "$d"/*; do mv "$f" "${f/$TAG/v18.18.7-bad}"; done; (cd "$RUNNER_TEMP/candidate/mise-linux-x64" && sha256sum *.tar.gz > "$(ls *.tar.gz).sha256"); (cd "$RUNNER_TEMP/candidate/mise-darwin-arm64" && sha256sum *.tar.gz > "$(ls *.tar.gz).sha256"); case_ V12-bad-tag-shape 1 'is not v<version>-sami'
setup; export STUB_RUN=42420 ; case_ V13-run-id-prefix-is-not-the-run 1 'has no attestation that run 4242 made'
setup; export STUB_OTHER="omp-$TAG-linux-x64.tar.gz" STUB_PLANT="https://github.com/o/r/actions/runs/4242/attempts/1"; case_ V14-run-url-planted-elsewhere-in-json 1 'has no attestation that run 4242 made'
setup; export STUB_DISPATCH="omp-$TAG-linux-x64.tar.gz"; case_ V15-dispatch-triggered-attestation 1 'linux-x64.tar.gz: it has no attestation that run 4242 made'
setup; export STUB_FOREIGN="omp-$TAG-darwin-arm64.tar.gz.sha256"; case_ V16-run-url-of-another-repository 1 'darwin-arm64.tar.gz.sha256: it has no attestation that run 4242 made'
setup; export STUB_SIGNER_REF="carry-notes.md"; case_ V17-signer-workflow-at-another-ref 1 'carry-notes.md: it has no attestation that run 4242 made'
# find
fcase() { # name want msg json
  local name="$1" want="$2" msg="$3" out rc ok=1; printf '%s' "$4" > "$W/runs.json"; export STUB_RUNS="$W/runs.json"
  out="$(cd "$W/repo" && GITHUB_OUTPUT="$W/fout" bash "$RC" find 2>&1)"; rc=$?
  if [ "$want" = 0 ] && [ "$rc" != 0 ]; then ok=0; fi; if [ "$want" != 0 ] && [ "$rc" = 0 ]; then ok=0; fi
  if [ -n "$msg" ] && ! { printf '%s\n' "$out"; cat "$W/fout" 2>/dev/null; } | grep -Eq -- "$msg"; then ok=0; fi
  if [ "$ok" = 1 ]; then pass=$((pass+1)); echo "PASS $name rc=$rc"; else failn=$((failn+1)); echo "FAIL $name rc=$rc"; printf '%s\n' "$out" | head -3 | sed 's/^/    | /'; fi; : > "$W/fout"
}
run() { printf '{"id":%s,"head_sha":"%s","event":"%s","head_branch":"%s","conclusion":"%s","path":".github/workflows/sami-build.yml","html_url":"u%s"}' "$1" "$2" "$3" "$4" "$5" "$1"; }
fcase F0-one-green 0 '^run_id=7$' "{\"total_count\":1,\"workflow_runs\":[$(run 7 $SHA push sami-candidate success)]}"
fcase F1-two-green-takes-max 0 '^run_id=9$' "{\"total_count\":2,\"workflow_runs\":[$(run 9 $SHA push sami-candidate success),$(run 7 $SHA push sami-candidate success)]}"
fcase F2-page-short 1 'UNKNOWN' "{\"total_count\":3,\"workflow_runs\":[$(run 7 $SHA push sami-candidate success)]}"
fcase F3-wrong-branch 1 'no green sami-build run' "{\"total_count\":1,\"workflow_runs\":[$(run 7 $SHA push sami success)]}"
fcase F4-dispatch 1 'no green sami-build run' "{\"total_count\":1,\"workflow_runs\":[$(run 7 $SHA workflow_dispatch sami-candidate success)]}"
fcase F5-red 1 'no green sami-build run' "{\"total_count\":1,\"workflow_runs\":[$(run 7 $SHA push sami-candidate failure)]}"
fcase F6-other-sha 1 'no green sami-build run' "{\"total_count\":1,\"workflow_runs\":[$(run 7 0000000000000000000000000000000000000000 push sami-candidate success)]}"
echo "release-candidate.sh harness: $pass passed, $failn failed"
