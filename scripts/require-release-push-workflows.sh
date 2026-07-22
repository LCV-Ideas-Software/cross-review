#!/usr/bin/env bash

set -euo pipefail

readonly WORKFLOW_PATHS=(
  ".github/workflows/ci.yml"
  ".github/workflows/codeql.yml"
  ".github/workflows/socket.yml"
  ".github/workflows/zizmor.yml"
  ".github/workflows/scorecard.yml"
  ".github/workflows/pages.yml"
)
readonly WORKFLOW_LABELS=(
  "CI"
  "CodeQL"
  "Socket Security"
  "Zizmor"
  "OpenSSF Scorecard"
  "Pages"
)

die() {
  echo "::error::$*" >&2
  exit 1
}

[ "$#" -eq 1 ] || die "Usage: $0 TARGET_SHA"
readonly TARGET_SHA="$1"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

git rev-parse --verify "$TARGET_SHA^{commit}" >/dev/null 2>&1 ||
  die "Release target is not a local commit: $TARGET_SHA"

declare -a workflow_ids=()
for discovery_attempt in {1..60}; do
  workflow_pages="$(gh api --method GET --paginate --slurp \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    "repos/$GITHUB_REPOSITORY/actions/workflows?per_page=100")"
  workflow_ids=()
  identities_ready=true
  for index in "${!WORKFLOW_PATHS[@]}"; do
    path="${WORKFLOW_PATHS[$index]}"
    label="${WORKFLOW_LABELS[$index]}"
    matches="$(jq -c --arg path "$path" '[
      .[] | .workflows[]?
      | select(.path == $path and .state == "active")
    ]' <<<"$workflow_pages")"
    count="$(jq 'length' <<<"$matches")"
    if [ "$count" -gt 1 ]; then
      die "Expected one active $label workflow at $path; found ambiguous count $count."
    fi
    if [ "$count" -eq 0 ]; then
      identities_ready=false
      workflow_ids+=("")
      echo "Waiting for GitHub to register active workflow $label at $path ($discovery_attempt/60)."
      continue
    fi
    workflow_ids+=("$(jq -er '.[0].id' <<<"$matches")")
  done
  if [ "$identities_ready" = true ]; then
    break
  fi
  [ "$discovery_attempt" -lt 60 ] ||
    die "GitHub did not register all six exact workflow paths within five minutes."
  sleep 5
done

assert_target_on_live_main() {
  local live_main_sha relation
  live_main_sha="$(gh api --method GET "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq '.object.sha')"
  relation="$(gh api --method GET "repos/$GITHUB_REPOSITORY/compare/${TARGET_SHA}...${live_main_sha}" --jq '.status')"
  if [ "$relation" != "ahead" ] && [ "$relation" != "identical" ]; then
    die "Release target $TARGET_SHA left live main history at $live_main_sha (compare status: $relation)."
  fi
}

# Workflows can legitimately spend close to their 30-minute timeout waiting in
# repository FIFO queues. Poll for up to 60 minutes so queue pressure does not
# manufacture a red release that then needs manual recovery.
for attempt in {1..360}; do
  # Recheck ancestry once per minute while waiting and again immediately
  # before success, staying well inside GITHUB_TOKEN's per-repository budget.
  if [ "$attempt" -eq 1 ] || [ $(((attempt - 1) % 6)) -eq 0 ]; then
    assert_target_on_live_main
  fi

  run_pages="$(gh api --method GET --paginate --slurp \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    "repos/$GITHUB_REPOSITORY/actions/runs" \
    -f head_sha="$TARGET_SHA" \
    -f event=push \
    -f per_page=100)"
  all_ready=true

  for index in "${!WORKFLOW_PATHS[@]}"; do
    path="${WORKFLOW_PATHS[$index]}"
    label="${WORKFLOW_LABELS[$index]}"
    workflow_id="${workflow_ids[$index]}"
    workflow_run="$(jq -c \
      --arg path "$path" \
      --arg repo "$GITHUB_REPOSITORY" \
      --arg sha "$TARGET_SHA" \
      --argjson workflow_id "$workflow_id" '
        [
          .[] | .workflow_runs[]?
          | select(.workflow_id == $workflow_id)
          | select(.path == $path)
          | select(.event == "push")
          | select(.head_sha == $sha)
          | select(.head_branch == "main")
          | select(.head_repository.full_name == $repo)
        ]
        | sort_by(.id)
        | last // null
      ' <<<"$run_pages")"
    workflow_state="$(jq -r 'if . == null then "missing" else "\(.status):\(.conclusion // "")" end' <<<"$workflow_run")"
    if [ "$workflow_state" = "completed:success" ]; then
      continue
    fi
    if [[ "$workflow_state" == completed:* ]]; then
      jq -r '[.id, .name, .path, .status, .conclusion, .html_url] | @tsv' <<<"$workflow_run" >&2
      die "$label ($path, id=$workflow_id) finished as $workflow_state for $TARGET_SHA."
    fi
    all_ready=false
    echo "Waiting for $label ($path, id=$workflow_id) on $TARGET_SHA (state: $workflow_state; attempt: $attempt/360)."
  done

  if [ "$all_ready" = true ]; then
    assert_target_on_live_main
    echo "All six exact-path, exact-ID push workflows passed for $TARGET_SHA."
    exit 0
  fi
  [ "$attempt" -lt 360 ] || die "Not every exact-path push workflow completed successfully for $TARGET_SHA within 60 minutes."
  sleep 10
done
