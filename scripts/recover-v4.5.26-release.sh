#!/usr/bin/env bash

# Narrow, fail-closed recovery for the immutable v04.05.26 transaction. The
# tag's frozen publish.yml cannot consume a valid JSON false through jq -e, so
# rerunning it can never finish. This script neither creates/moves tags nor
# publishes/deletes/overwrites packages or release assets.
set -euo pipefail

github_token="${GH_TOKEN:-}"
immutability_token="${IMMUTABILITY_TOKEN:-}"
unset GH_TOKEN
unset IMMUTABILITY_TOKEN

readonly repository="LCV-Ideas-Software/cross-review"
readonly repository_id="1224165864"
readonly operator_login="lcv-leo"
readonly operator_id="268063598"
readonly tag="v04.05.26"
readonly version="4.5.26"
readonly target_sha="2b8b9b086b4ca48544e42334e7ae625f006c88ae"
readonly release_id="358385263"
readonly release_title="cross-review v04.05.26"
readonly release_body_sha256="680cea720946b164dcb1627f0112266198f39e5f656ad089e3f87f30aa243444"
readonly source_run_id="29967505793"
readonly source_workflow_id="269031835"
readonly source_artifact_id="8548431216"
readonly source_artifact_archive_sha256="b0746ff47cdea0fea65ff32b6817a05551963336e983ab2b4ae5d333392fd51e"
readonly source_artifact_archive_size="1474403"
readonly package_name="@lcv-ideas-software/cross-review"
readonly package_tarball="lcv-ideas-software-cross-review-4.5.26.tgz"
readonly package_size="1474205"
readonly package_sha256="97ce84603d5d98654840b7ee6cf2c27e906cee883de6010e18351842869c9301"
readonly package_sri="sha512-i11a4PTnpmEk+30E1B/kziZlBgnVGHbUz/eY1kAspIEume+37KqNnW8dgIHOBOD+1g6XhOPTG3TjqgZBFHy/sg=="
readonly confirmation_phrase="RECOVER v04.05.26 RELEASE 358385263 FROM RUN 29967505793 ARTIFACT 8548431216"
readonly expected_prior_latest="v04.05.25"
readonly expected_final_latest="v04.05.26"

die() {
  echo "::error::$*" >&2
  exit 1
}

[ -n "$github_token" ] || die "GITHUB_TOKEN is required for exact recovery."
[ -n "$immutability_token" ] || die "LCV_AUTOMATION_TOKEN is required to prove immutable-release policy."
[ "${RECOVERY_CONFIRMATION:-}" = "$confirmation_phrase" ] || die "The exact recovery confirmation phrase does not match."
[ "${RECOVERY_ACTOR:-}" = "$operator_login" ] || die "Only $operator_login may dispatch this recovery."
[ "${RECOVERY_ACTOR_ID:-}" = "$operator_id" ] || die "Recovery actor id ${RECOVERY_ACTOR_ID:-missing} is not $operator_id."
[ "${RECOVERY_EVENT_NAME:-}" = "workflow_dispatch" ] || die "Recovery must use workflow_dispatch."
[ "${RECOVERY_REF:-}" = "refs/heads/main" ] || die "Recovery must execute from refs/heads/main."
[ "${RECOVERY_REF_TYPE:-}" = "branch" ] || die "Recovery ref type must be branch."
[ "${RECOVERY_REPOSITORY:-}" = "$repository" ] || die "Recovery repository identity changed."
[[ "${RECOVERY_WORKFLOW_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || die "Recovery workflow SHA is invalid."

github_json_api() {
  GH_TOKEN="$github_token" gh api \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    "$@"
}

# Keep this helper separate from github_json_api. Release asset downloads must
# send exactly the octet-stream media type, never a preceding JSON Accept value.
github_binary_api() {
  GH_TOKEN="$github_token" gh api \
    -H "Accept: application/octet-stream" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    "$@"
}

github_release() {
  GH_TOKEN="$github_token" gh release "$@"
}

immutability_json_api() {
  GH_TOKEN="$immutability_token" gh api \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    "$@"
}

work_dir="$(mktemp -d "${RUNNER_TEMP}/cross-review-release-recovery.XXXXXX")"
release_json="$work_dir/release.json"
artifact_zip="$work_dir/${source_artifact_id}.zip"
artifact_tarball="$work_dir/$package_tarball"
github_packages_npmrc="${RUNNER_TEMP}/cross-review-release-recovery.npmrc"

resolve_tag_to_commit() {
  local ref_json object_type object_sha tag_json
  ref_json="$(github_json_api --method GET "repos/$repository/git/ref/tags/$tag")"
  object_type="$(jq -er '.object.type' <<<"$ref_json")"
  object_sha="$(jq -er '.object.sha' <<<"$ref_json")"
  for _ in {1..8}; do
    if [ "$object_type" = "commit" ]; then
      resolved_tag_sha="$object_sha"
      return
    fi
    [ "$object_type" = "tag" ] || die "Recovery tag resolves to unsupported Git object type '$object_type'."
    tag_json="$(github_json_api --method GET "repos/$repository/git/tags/$object_sha")"
    object_type="$(jq -er '.object.type' <<<"$tag_json")"
    object_sha="$(jq -er '.object.sha' <<<"$tag_json")"
  done
  die "Recovery tag exceeded the annotated-tag dereference limit."
}

validate_commits() {
  local phase="$1" checkout_sha live_main_sha relation target_commit workflow_commit
  checkout_sha="$(git rev-parse HEAD)"
  live_main_sha="$(github_json_api --method GET "repos/$repository/git/ref/heads/main" --jq '.object.sha')"
  [ "$checkout_sha" = "$RECOVERY_WORKFLOW_SHA" ] || die "$phase: checkout $checkout_sha differs from workflow SHA $RECOVERY_WORKFLOW_SHA."
  [ "$live_main_sha" = "$RECOVERY_WORKFLOW_SHA" ] || die "$phase: live main advanced from recovery implementation $RECOVERY_WORKFLOW_SHA to $live_main_sha."
  [ -z "$(git status --porcelain=v1 --untracked-files=all)" ] || die "$phase: trusted recovery checkout is not byte-clean."
  git cat-file -e "$target_sha^{commit}" 2>/dev/null || die "$phase: exact release target is absent from full main history."
  git merge-base --is-ancestor "$target_sha" "$checkout_sha" || die "$phase: release target is not an ancestor of trusted recovery code."
  resolve_tag_to_commit
  [ "$resolved_tag_sha" = "$target_sha" ] || die "$phase: $tag moved from $target_sha to $resolved_tag_sha."
  relation="$(github_json_api --method GET "repos/$repository/compare/${target_sha}...${live_main_sha}" --jq '.status')"
  { [ "$relation" = "ahead" ] || [ "$relation" = "identical" ]; } || die "$phase: release target left live main history (status=$relation)."
  target_commit="$(github_json_api --method GET "repos/$repository/commits/$target_sha")"
  workflow_commit="$(github_json_api --method GET "repos/$repository/commits/$live_main_sha")"
  jq -e --arg sha "$target_sha" '.sha == $sha and .commit.verification.verified == true and .commit.verification.reason == "valid"' <<<"$target_commit" >/dev/null || die "$phase: release target signature is not valid."
  jq -e --arg sha "$live_main_sha" '.sha == $sha and .commit.verification.verified == true and .commit.verification.reason == "valid"' <<<"$workflow_commit" >/dev/null || die "$phase: recovery implementation signature is not valid."
}

validate_immutable_policy() {
  local phase="$1" policy_json enabled enforced
  policy_json="$(immutability_json_api --method GET "repos/$repository/immutable-releases")"
  enabled="$(jq -er 'if has("enabled") and ((.enabled | type) == "boolean") then (.enabled | tostring) else error("invalid enabled") end' <<<"$policy_json")"
  enforced="$(jq -er 'if has("enforced_by_owner") and ((.enforced_by_owner | type) == "boolean") then (.enforced_by_owner | tostring) else error("invalid enforced_by_owner") end' <<<"$policy_json")"
  [ "$enabled" = "true" ] && [ "$enforced" = "true" ] || die "$phase: immutable releases are not owner-enforced (enabled=$enabled enforced=$enforced)."
}

validate_source_evidence() {
  local phase="$1" run_json jobs_json artifact_json
  run_json="$(github_json_api --method GET "repos/$repository/actions/runs/$source_run_id")"
  jq -e \
    --arg repo "$repository" \
    --arg sha "$target_sha" \
    --arg tag "$tag" \
    --argjson run_id "$source_run_id" \
    --argjson workflow_id "$source_workflow_id" '
      .id == $run_id and .workflow_id == $workflow_id and
      .name == "Publish" and .path == ".github/workflows/publish.yml" and
      .event == "workflow_dispatch" and .status == "completed" and
      .conclusion == "failure" and .run_attempt == 1 and
      .head_sha == $sha and .head_branch == $tag and
      .repository.full_name == $repo and .head_repository.full_name == $repo and
      .actor.login == "github-actions[bot]" and .actor.id == 41898282 and
      .triggering_actor.login == "github-actions[bot]" and
      .triggering_actor.id == 41898282
    ' <<<"$run_json" >/dev/null || die "$phase: source Publish #119 identity changed."

  jobs_json="$(github_json_api --method GET "repos/$repository/actions/runs/$source_run_id/jobs?per_page=100")"
  jq -e --arg sha "$target_sha" '
      .total_count == 4 and (.jobs | length) == 4 and
      ([.jobs[] | select(.head_sha != $sha)] | length) == 0 and
      ([.jobs[] | select(.name == "Pre-publish gate (test + immutable artifact)" and .conclusion == "success")] | length) == 1 and
      ([.jobs[] | select(.name == "Publish to npmjs.com" and .conclusion == "success")] | length) == 1 and
      ([.jobs[] | select(.name == "Publish to GitHub Packages" and .conclusion == "success")] | length) == 1 and
      ([.jobs[] | select(.name == "Reconcile GitHub Release from immutable artifact" and .conclusion == "failure")] | length) == 1
    ' <<<"$jobs_json" >/dev/null || die "$phase: source run no longer proves both registries and the immutable artifact succeeded before the isolated release failure."

  artifact_json="$(github_json_api --method GET "repos/$repository/actions/artifacts/$source_artifact_id")"
  jq -e \
    --arg name "release-package-tgz" \
    --arg digest "sha256:$source_artifact_archive_sha256" \
    --arg sha "$target_sha" \
    --argjson artifact_id "$source_artifact_id" \
    --argjson run_id "$source_run_id" \
    --argjson repo_id "$repository_id" \
    --argjson archive_size "$source_artifact_archive_size" '
      .id == $artifact_id and .name == $name and .size_in_bytes == $archive_size and
      .digest == $digest and .expired == false and
      .workflow_run.id == $run_id and .workflow_run.head_sha == $sha and
      .workflow_run.head_repository_id == $repo_id and
      .workflow_run.repository_id == $repo_id
    ' <<<"$artifact_json" >/dev/null || die "$phase: exact source artifact metadata changed or expired."
}

download_and_validate_source_artifact() {
  github_json_api --method GET "repos/$repository/actions/artifacts/$source_artifact_id/zip" >"$artifact_zip"
  echo "$source_artifact_archive_sha256  $artifact_zip" | sha256sum --check --strict
  unzip -Z1 "$artifact_zip" >"$work_dir/archive-entries.txt"
  [ "$(wc -l <"$work_dir/archive-entries.txt" | tr -d '[:space:]')" = "1" ] || die "Source artifact archive must contain exactly one entry."
  [ "$(cat "$work_dir/archive-entries.txt")" = "$package_tarball" ] || die "Source artifact archive contains an unexpected path."
  unzip -p "$artifact_zip" "$package_tarball" >"$artifact_tarball"
  [ "$(stat -c '%s' "$artifact_tarball")" = "$package_size" ] || die "Package tarball size differs from the registry-published artifact."
  echo "$package_sha256  $artifact_tarball" | sha256sum --check --strict
  node scripts/release-policy.mjs verify-file-sri "$artifact_tarball" "$package_sri"
  while IFS= read -r entry; do
    case "$entry" in
      /*|../*|*/../*|*/..) die "Package tarball contains unsafe path '$entry'." ;;
    esac
  done < <(tar -tzf "$artifact_tarball")
  tar -xOf "$artifact_tarball" package/package.json | jq -e \
    --arg name "$package_name" --arg version "$version" \
    '.name == $name and .version == $version' >/dev/null || die "Package manifest identity differs from $package_name@$version."
}

normalize_registry_field() {
  local json="$1" field="$2"
  jq -er --arg field "$field" '
    if type == "array" and length == 1 and (.[0] | type) == "object"
    then .[0][$field]
    elif type == "object" then .[$field]
    else error("unexpected npm view response") end
    | select(type == "string" and length > 0)
  ' <<<"$json"
}

verify_registry_integrity() {
  local phase="$1" npmjs_json github_json npmjs_version github_version npmjs_sri github_sri npmjs_tags github_tags
  npmjs_json="$(npm view "$package_name@$version" version dist.integrity --json --registry=https://registry.npmjs.org)"
  npmjs_version="$(normalize_registry_field "$npmjs_json" version)"
  npmjs_sri="$(normalize_registry_field "$npmjs_json" dist.integrity)"
  [ "$npmjs_version" = "$version" ] || die "$phase: npmjs.com returned version $npmjs_version."
  node scripts/release-policy.mjs verify-sri "$package_sri" "$npmjs_sri" "npmjs.com during $phase"
  npmjs_tags="$(npm view "$package_name" dist-tags --json --registry=https://registry.npmjs.org)"
  [ "$(normalize_registry_field "$npmjs_tags" latest)" = "$version" ] || die "$phase: npmjs.com latest is not $version."

  umask 077
  printf '%s\n' \
    '@lcv-ideas-software:registry=https://npm.pkg.github.com' \
    "//npm.pkg.github.com/:_authToken=$github_token" \
    >"$github_packages_npmrc"
  github_json="$(npm view "$package_name@$version" version dist.integrity --json \
    --registry=https://npm.pkg.github.com \
    --scope=@lcv-ideas-software \
    --userconfig="$github_packages_npmrc")"
  github_version="$(normalize_registry_field "$github_json" version)"
  github_sri="$(normalize_registry_field "$github_json" dist.integrity)"
  [ "$github_version" = "$version" ] || die "$phase: GitHub Packages returned version $github_version."
  node scripts/release-policy.mjs verify-sri "$package_sri" "$github_sri" "GitHub Packages during $phase"
  github_tags="$(npm view "$package_name" dist-tags --json \
    --registry=https://npm.pkg.github.com \
    --scope=@lcv-ideas-software \
    --userconfig="$github_packages_npmrc")"
  [ "$(normalize_registry_field "$github_tags" latest)" = "$version" ] || die "$phase: GitHub Packages latest is not $version."
}

read_latest_release_tag() {
  github_json_api --method GET "repos/$repository/releases/latest" --jq '.tag_name'
}

load_exact_release() {
  local phase="$1" pages matches count
  pages="$(github_json_api --method GET --paginate --slurp "repos/$repository/releases?per_page=100")"
  matches="$(jq -ce --arg tag "$tag" '[.[][] | select(.tag_name == $tag)]' <<<"$pages")"
  count="$(jq -er 'length' <<<"$matches")"
  [ "$count" = "1" ] || die "$phase: expected one release for $tag, found $count."
  jq -e '.[0]' <<<"$matches" >"$release_json"
  jq -e \
    --arg tag "$tag" --arg sha "$target_sha" --arg title "$release_title" \
    --argjson release_id "$release_id" '
      .id == $release_id and .tag_name == $tag and .target_commitish == $sha and
      .name == $title and .author.login == "github-actions[bot]" and
      .author.id == 41898282 and .author.type == "Bot" and
      ((.draft | type) == "boolean") and
      ((.prerelease | type) == "boolean") and .prerelease == false and
      ((.immutable | type) == "boolean")
    ' "$release_json" >/dev/null || die "$phase: exact release identity or protected metadata changed."
  jq -j '.body' "$release_json" >"$work_dir/release-body.txt"
  echo "$release_body_sha256  $work_dir/release-body.txt" | sha256sum --check --strict
  release_draft="$(jq -er '.draft | tostring' "$release_json")"
  release_immutable="$(jq -er '.immutable | tostring' "$release_json")"
  matching_assets="$(jq --arg name "$package_tarball" '[.assets[]? | select(.name == $name)] | length' "$release_json")"
  unexpected_assets="$(jq --arg name "$package_tarball" '[.assets[]? | select(.name != $name)] | length' "$release_json")"
  [ "$matching_assets" -le 1 ] && [ "$unexpected_assets" = "0" ] || die "$phase: release asset set is ambiguous (matching=$matching_assets unexpected=$unexpected_assets)."
  loaded_asset_id=""
  if [ "$matching_assets" = "1" ]; then
    loaded_asset_id="$(jq -er --arg name "$package_tarball" '.assets[] | select(.name == $name) | .id' "$release_json")"
    jq -e --arg name "$package_tarball" --arg digest "sha256:$package_sha256" --argjson size "$package_size" '
        .assets[] | select(.name == $name) |
        .state == "uploaded" and .size == $size and
        ((.digest // "") == "" or .digest == $digest) and
        .uploader.login == "github-actions[bot]" and .uploader.id == 41898282
      ' "$release_json" >/dev/null || die "$phase: existing release asset metadata is not exact."
  fi
}

verify_release_asset_bytes() {
  local phase="$1" asset_id="$2" target
  target="$work_dir/release-asset-${phase}-${asset_id}.tgz"
  github_binary_api --method GET "repos/$repository/releases/assets/$asset_id" >"$target"
  [ "$(stat -c '%s' "$target")" = "$package_size" ] || die "$phase: release asset size mismatch."
  echo "$package_sha256  $target" | sha256sum --check --strict
  node scripts/release-policy.mjs verify-file-sri "$target" "$package_sri"
}

validate_commits initial-evidence
validate_immutable_policy initial-evidence
validate_source_evidence initial-evidence
download_and_validate_source_artifact
verify_registry_integrity initial-evidence
load_exact_release initial-evidence

if [ "$release_draft" = "false" ]; then
  [ "$release_immutable" = "true" ] || die "Existing public release is not immutable."
  [ "$matching_assets" = "1" ] || die "Existing public release is missing its exact package asset."
  [ "$(read_latest_release_tag)" = "$expected_final_latest" ] || die "Existing public recovery does not preserve exact latest release."
  asset_id="$loaded_asset_id"
  verify_release_asset_bytes idempotent-public "$asset_id"
else
  [ "$release_immutable" = "false" ] || die "Draft recovery unexpectedly reports immutable=true."
  [ "$(read_latest_release_tag)" = "$expected_prior_latest" ] || die "Draft recovery requires latest=$expected_prior_latest."

  if [ "$matching_assets" = "0" ]; then
    validate_commits final-upload-boundary
    validate_immutable_policy final-upload-boundary
    validate_source_evidence final-upload-boundary
    verify_registry_integrity final-upload-boundary
    load_exact_release final-upload-boundary
    [ "$release_draft" = "true" ] && [ "$release_immutable" = "false" ] && [ "$matching_assets" = "0" ] || die "Release changed before upload; refusing overwrite or duplication."
    upload_json="$work_dir/upload.json"
    encoded_asset_name="$(jq -rn --arg name "$package_tarball" '$name | @uri')"
    curl --fail-with-body --silent --show-error \
      --request POST \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer $github_token" \
      -H "X-GitHub-Api-Version: 2026-03-10" \
      -H "Content-Type: application/octet-stream" \
      --data-binary "@$artifact_tarball" \
      --output "$upload_json" \
      "https://uploads.github.com/repos/$repository/releases/$release_id/assets?name=$encoded_asset_name"
    uploaded_asset_id="$(jq -er --arg name "$package_tarball" 'select(.name == $name and .state == "uploaded") | .id' "$upload_json")"
  else
    uploaded_asset_id="$loaded_asset_id"
  fi

  load_exact_release staged
  [ "$release_draft" = "true" ] && [ "$release_immutable" = "false" ] && [ "$matching_assets" = "1" ] || die "Staged release is not one exact mutable draft with one asset."
  [ "$loaded_asset_id" = "$uploaded_asset_id" ] || die "Uploaded asset id $uploaded_asset_id differs from discovered id $loaded_asset_id."
  asset_id="$loaded_asset_id"
  verify_release_asset_bytes staged "$asset_id"

  validate_commits final-publish-boundary
  validate_immutable_policy final-publish-boundary
  validate_source_evidence final-publish-boundary
  verify_registry_integrity final-publish-boundary
  [ "$(read_latest_release_tag)" = "$expected_prior_latest" ] || die "GitHub latest changed before publication."
  load_exact_release final-publish-boundary
  [ "$release_draft" = "true" ] && [ "$release_immutable" = "false" ] && [ "$matching_assets" = "1" ] || die "Release changed before publication PATCH."
  [ "$loaded_asset_id" = "$asset_id" ] || die "Release asset id changed before publication."
  verify_release_asset_bytes final-publish-boundary "$asset_id"

  publish_payload="$work_dir/publish.json"
  expected_body="$(jq -r '.body' "$release_json")"
  jq -n \
    --arg tag "$tag" --arg target "$target_sha" --arg name "$release_title" \
    --arg body "$expected_body" \
    '{tag_name: $tag, target_commitish: $target, name: $name, body: $body,
      draft: false, prerelease: false, make_latest: "true"}' >"$publish_payload"
  github_json_api --method PATCH "repos/$repository/releases/$release_id" \
    --input "$publish_payload" >"$work_dir/patched-release.json"
  [ "$(jq -er '.id' "$work_dir/patched-release.json")" = "$release_id" ] || die "Publication PATCH returned a different release id."
fi

final_ready=false
for attempt in {1..12}; do
  load_exact_release final-pending
  if [ "$release_draft" = "false" ] && [ "$release_immutable" = "true" ] && \
    [ "$matching_assets" = "1" ] && [ "$loaded_asset_id" = "$asset_id" ]; then
    final_ready=true
    break
  fi
  [ "$attempt" -lt 12 ] || die "Exact release did not become public and immutable."
  echo "Waiting for immutable release state ($attempt/12)."
  sleep 5
done
[ "$final_ready" = "true" ] || die "Final immutable state was not established."
jq -e --arg name "$package_tarball" --arg digest "sha256:$package_sha256" '
  .assets[] | select(.name == $name) | .digest == $digest
' "$release_json" >/dev/null || die "Final immutable asset digest is not exact."

validate_commits final-immutable
validate_immutable_policy final-immutable
validate_source_evidence final-immutable
verify_registry_integrity final-immutable
verify_release_asset_bytes final-immutable "$asset_id"
actual_latest="$(read_latest_release_tag)"
[ "$actual_latest" = "$expected_final_latest" ] || die "Final GitHub latest is $actual_latest, expected $expected_final_latest."
node scripts/release-policy.mjs assert-github-latest "$version" "$expected_prior_latest" "$actual_latest" true

# gh <=2.92.0 can disclose GH_TOKEN while verifying release attestations
# (CVE-2026-48501). Refuse networking unless the patched verifier is present.
gh_cli_version="$(gh --version | awk 'NR == 1 && $1 == "gh" && $2 == "version" { print $3 }')"
node scripts/release-policy.mjs assert-safe-gh-release-verifier "$gh_cli_version"
attestation_verified=false
for attempt in {1..12}; do
  if github_release verify "$tag" --repo "$repository" >"$work_dir/release-attestation.out" 2>"$work_dir/release-attestation.err" && \
    github_release verify-asset "$tag" "$artifact_tarball" --repo "$repository" >"$work_dir/asset-attestation.out" 2>"$work_dir/asset-attestation.err"; then
    cat "$work_dir/release-attestation.out"
    cat "$work_dir/asset-attestation.out"
    attestation_verified=true
    break
  fi
  [ "$attempt" -lt 12 ] || {
    cat "$work_dir/release-attestation.err" >&2
    cat "$work_dir/asset-attestation.err" >&2
    die "Signed immutable release and asset attestations were not verifiable."
  }
  echo "Waiting for signed release attestations ($attempt/12)."
  sleep 5
done
[ "$attestation_verified" = "true" ] || die "Final signed attestation gate did not complete."

echo "Recovered exact release id $release_id for $tag with asset id $asset_id and SHA-256 $package_sha256; both registries and GitHub latest remain exact."
