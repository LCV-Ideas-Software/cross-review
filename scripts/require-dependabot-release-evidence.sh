#!/usr/bin/env bash

set -euo pipefail

readonly DEPENDABOT_CONFIG_PATH=".github/dependabot.yml"
readonly DEPENDABOT_WORKFLOW_PATH="dynamic/dependabot/dependabot-updates"
readonly EXPECTED_ECOSYSTEMS=("npm_and_yarn" "github_actions" "pip" "pre_commit")

die() {
  echo "::error::$*" >&2
  exit 1
}

release_evidence_github_token=""
github_api() {
  GH_TOKEN="$release_evidence_github_token" gh api "$@"
}

commit_parent() {
  git rev-list --parents -n 1 "$1" | awk '{print $2}'
}

config_blob() {
  git rev-parse "$1:$DEPENDABOT_CONFIG_PATH" 2>/dev/null || true
}

assert_first_parent_epoch() {
  local target_sha="$1" version_boundary_sha="$2" cursor parent
  cursor="$target_sha"
  while [ "$cursor" != "$version_boundary_sha" ]; do
    parent="$(commit_parent "$cursor")"
    if [ -z "$parent" ]; then
      die "Version boundary $version_boundary_sha is not on the first-parent chain of release target $target_sha."
    fi
    cursor="$parent"
  done
}

# Prints one JSON object that identifies whether the final Dependabot
# configuration was introduced during this version epoch and, when it was,
# every first-parent commit that carries that exact final blob. Comparing tree
# blobs (rather than diff-tree output) handles root and merge commits without
# losing changes introduced through a merge's second parent.
resolve_provenance() {
  local target_sha="$1" version_boundary_sha="$2"
  local final_blob cursor parent parent_blob config_boundary_sha changed_in_epoch
  local -a stable_shas=()

  git rev-parse --verify "$target_sha^{commit}" >/dev/null 2>&1 ||
    die "Release target is not a local commit: $target_sha"
  git rev-parse --verify "$version_boundary_sha^{commit}" >/dev/null 2>&1 ||
    die "Version boundary is not a local commit: $version_boundary_sha"
  assert_first_parent_epoch "$target_sha" "$version_boundary_sha"

  final_blob="$(config_blob "$target_sha")"
  [ -n "$final_blob" ] || die "$DEPENDABOT_CONFIG_PATH is missing from release target $target_sha."

  cursor="$target_sha"
  changed_in_epoch=false
  config_boundary_sha=""
  while :; do
    if [ "$(config_blob "$cursor")" != "$final_blob" ]; then
      die "First-parent provenance left the final Dependabot configuration blob at $cursor."
    fi
    stable_shas+=("$cursor")
    parent="$(commit_parent "$cursor")"

    if [ -z "$parent" ]; then
      [ "$cursor" = "$version_boundary_sha" ] ||
        die "Reached a root commit before version boundary $version_boundary_sha."
      changed_in_epoch=true
      config_boundary_sha="$cursor"
      break
    fi

    parent_blob="$(config_blob "$parent")"
    if [ "$parent_blob" != "$final_blob" ]; then
      changed_in_epoch=true
      config_boundary_sha="$cursor"
      break
    fi

    if [ "$cursor" = "$version_boundary_sha" ]; then
      # The final blob predates this version. It was already release-gated in
      # an earlier epoch, so no managed update run is required for this one.
      break
    fi
    cursor="$parent"
  done

  printf '%s\n' "${stable_shas[@]}" |
    jq -Rsc \
      --arg target_sha "$target_sha" \
      --arg version_boundary_sha "$version_boundary_sha" \
      --arg final_blob "$final_blob" \
      --arg config_boundary_sha "$config_boundary_sha" \
      --arg changed_in_epoch "$changed_in_epoch" '
        {
          target_sha: $target_sha,
          version_boundary_sha: $version_boundary_sha,
          final_config_blob: $final_blob,
          changed_in_epoch: ($changed_in_epoch == "true"),
          config_boundary_sha: (if $config_boundary_sha == "" then null else $config_boundary_sha end),
          eligible_head_shas: (split("\n") | map(select(length > 0)))
        }
      '
}

assert_target_on_live_main() {
  local target_sha="$1" live_main_sha relation
  live_main_sha="$(github_api --method GET "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq '.object.sha')"
  relation="$(github_api --method GET "repos/$GITHUB_REPOSITORY/compare/${target_sha}...${live_main_sha}" --jq '.status')"
  if [ "$relation" != "ahead" ] && [ "$relation" != "identical" ]; then
    die "Release target $target_sha left live main history at $live_main_sha (compare status: $relation)."
  fi
}

resolve_dependabot_workflow_id() {
  local workflow_pages matches count
  workflow_pages="$(github_api --method GET --paginate --slurp \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    "repos/$GITHUB_REPOSITORY/actions/workflows?per_page=100")"
  matches="$(jq -c --arg path "$DEPENDABOT_WORKFLOW_PATH" '[
    .[] | .workflows[]?
    | select(.path == $path and .state == "active")
  ]' <<<"$workflow_pages")"
  count="$(jq 'length' <<<"$matches")"
  [ "$count" -eq 1 ] ||
    die "Expected exactly one active managed Dependabot workflow at $DEPENDABOT_WORKFLOW_PATH; found $count."
  jq -er '.[0].id' <<<"$matches"
}

select_latest_ecosystem_runs() {
  local run_pages="$1" eligible_head_shas="$2"
  jq -c --argjson eligible "$eligible_head_shas" '
    def ecosystem:
      if (.name | startswith("npm_and_yarn in /.") or startswith("npm_and_yarn in / ")) then "npm_and_yarn"
      elif (.name | startswith("github_actions in /.") or startswith("github_actions in / ")) then "github_actions"
      elif (.name | startswith("pip in /.") or startswith("pip in / ")) then "pip"
      elif (.name | startswith("pre_commit in /.") or startswith("pre_commit in / ")) then "pre_commit"
      else null
      end;
    [
      .[] | .workflow_runs[]?
      | select(.path == "dynamic/dependabot/dependabot-updates")
      | select(.event == "dynamic")
      | select(.actor.login == "dependabot[bot]")
      | select(.triggering_actor.login == "dependabot[bot]")
      | select(.head_sha as $head | $eligible | index($head) != null)
      | (ecosystem) as $ecosystem
      | select($ecosystem != null)
      | . + { ecosystem: $ecosystem }
    ]
    | sort_by(.ecosystem, .id)
    | group_by(.ecosystem)
    | map(last)
  ' <<<"$run_pages"
}

require_evidence() {
  local target_sha="$1" version_boundary_sha="$2"
  local provenance changed config_boundary_sha eligible_head_shas workflow_id created_after
  local run_pages latest_runs all_ready run state

  : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
  release_evidence_github_token="${GH_TOKEN:-}"
  unset GH_TOKEN
  [ -n "$release_evidence_github_token" ] || die "GH_TOKEN is required"

  provenance="$(resolve_provenance "$target_sha" "$version_boundary_sha")"
  changed="$(jq -r '.changed_in_epoch' <<<"$provenance")"
  if [ "$changed" != "true" ]; then
    echo "$DEPENDABOT_CONFIG_PATH final blob predates version boundary $version_boundary_sha; no managed update gate is required."
    return 0
  fi

  config_boundary_sha="$(jq -er '.config_boundary_sha' <<<"$provenance")"
  eligible_head_shas="$(jq -c '.eligible_head_shas' <<<"$provenance")"
  workflow_id="$(resolve_dependabot_workflow_id)"
  created_after="$(git show -s --format=%cI "$config_boundary_sha")"

  echo "Dependabot configuration blob $(jq -r '.final_config_blob' <<<"$provenance") was introduced at $config_boundary_sha."
  echo "Requiring the newest trusted run for each configured ecosystem on a commit carrying that exact blob through $target_sha."

  for attempt in {1..60}; do
    assert_target_on_live_main "$target_sha"
    run_pages="$(github_api --method GET --paginate --slurp \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2026-03-10" \
      "repos/$GITHUB_REPOSITORY/actions/workflows/${workflow_id}/runs" \
      -f per_page=100 \
      -f created=">=$created_after")"
    latest_runs="$(select_latest_ecosystem_runs "$run_pages" "$eligible_head_shas")"
    all_ready=true

    for ecosystem in "${EXPECTED_ECOSYSTEMS[@]}"; do
      run="$(jq -c --arg ecosystem "$ecosystem" '[.[] | select(.ecosystem == $ecosystem)] | last // null' <<<"$latest_runs")"
      state="$(jq -r 'if . == null then "missing" else "\(.status):\(.conclusion // "")" end' <<<"$run")"
      if [ "$state" != "completed:success" ]; then
        all_ready=false
        echo "Waiting for trusted $ecosystem Dependabot evidence (state: $state; attempt: $attempt/60)."
      fi
    done

    if [ "$all_ready" = true ]; then
      echo "All four managed Dependabot ecosystems have newest completed:success evidence for the final configuration blob."
      jq -r '.[] | [.ecosystem, .id, .head_sha, .status, .conclusion, .html_url] | @tsv' <<<"$latest_runs"
      return 0
    fi

    if [ "$attempt" -eq 60 ]; then
      echo "::error::Dependabot evidence did not converge to newest completed:success for all four ecosystems." >&2
      jq -r '.[] | [.ecosystem, .id, .head_sha, .status, .conclusion, .html_url] | @tsv' <<<"$latest_runs" >&2
      return 1
    fi
    sleep 5
  done
}

case "${1:-}" in
  resolve-provenance)
    [ "$#" -eq 3 ] || die "Usage: $0 resolve-provenance TARGET_SHA VERSION_BOUNDARY_SHA"
    resolve_provenance "$2" "$3"
    ;;
  require)
    [ "$#" -eq 3 ] || die "Usage: $0 require TARGET_SHA VERSION_BOUNDARY_SHA"
    require_evidence "$2" "$3"
    ;;
  *)
    die "Usage: $0 {resolve-provenance|require} TARGET_SHA VERSION_BOUNDARY_SHA"
    ;;
esac
