# GitHub Security Baseline

This document records the expected security baseline for the maintained public
`cross-review` repository.

Required repository settings after the remote is created:

1. Enable Secret Protection / Secret Scanning.
2. Enable Push Protection.
3. Keep Code Scanning on GitHub's CodeQL default setup, applied by the
   Enterprise security configuration (GitHub Actions, JavaScript/TypeScript
   and Python; extended query suite). The repository commits no CodeQL
   workflow.
4. Enable Code Quality.
5. Enable Dependabot alerts.
6. Enable Dependabot security updates.
7. Enable Dependabot version updates from `.github/dependabot.yml`.
8. Merge Dependabot pull requests through the repository-local
   `dependabot-auto-merge.yml`, the organization's canonical workflow: it arms
   GitHub's native auto-merge (squash), so the merge happens only after every
   ruleset rule and required check passes. No merge queue and no
   repository-owned controller.
9. Protect `main` with the Enterprise rulesets and create the repository
   ruleset `main: required checks` (Build, lint and smoke; Windows caller-token
   ACL regression; Dependency Review; Run zizmor; Build Pages artifact) before
   the first Dependabot auto-merge.
10. Require code scanning results with CodeQL security alerts: All / alerts: All.
11. Require code quality thresholds: Any / Any.
12. Require CI to pass before merge.
13. Disable force-push and branch deletion on `main`.

Package publishing to npmjs.com uses npm Trusted Publishing with GitHub Actions
OIDC; no long-lived npm publish token, GAT with 2FA bypass, or `NPM_TOKEN` secret
belongs in that path. The npm package must authorize owner
`LCV-Ideas-Software`, repository `cross-review`, workflow `publish.yml`,
environment `npm-production`, and the `npm publish` action. After OIDC is
verified, npm publishing access should be set to **Require two-factor
authentication and disallow tokens**, while the Trusted Publisher remains
authorized. The workflow grants `id-token: write`, uses a GitHub-hosted runner,
disables package-manager caches, pins npm 12 by exact version and registry
tarball SHA-512, verifies the CLI before execution, and verifies the published
SLSA provenance.

A successful CI run for a push to `main` may auto-create an
organization-standard display tag such as `vXX.XX.XX` from `package.json`. The
privileged auto-tag workflow uses the trusted default-branch event checkout,
compares it with the successful run SHA and skips every repository-reading or
publishing step on a mismatch. GitHub documents that a tag pushed with the
repository `GITHUB_TOKEN` does not trigger a second workflow, so Auto-tag
dispatches `publish.yml` on that actual tag ref with no tag input. Publish
requires `github.ref_type=tag`, the canonical `refs/tags/<name>` ref and a
protected tag, then checks tag = checkout = current `main` both after local
validation and before each external write. The active `v*` tag ruleset has no
bypass and blocks deletion and non-fast-forward update. The verified tag then
creates a normal GitHub Release and publishes
`@lcv-ideas-software/cross-review` to npmjs.com and GitHub Packages. The
API-first package is separate from the archived CLI package
`@lcv-ideas-software/cross-review-v1`.

CodeQL runs through GitHub's default setup for GitHub Actions,
JavaScript/TypeScript and Python with the extended query suite; the repository
commits no CodeQL workflow and no `merge_group` trigger. The Enterprise ruleset
requires CodeQL results on every pull request into `main`. Release automation is stricter:
it reads the exact-SHA default-setup analyses and requires zero results in
every category before tagging and publishing.

No secrets, runtime sessions, logs, prompts, provider responses, API keys or
local AI memories may be committed. The `.gitignore` stays strict because this
repository is public and runtime artifacts belong under local data directories,
not in source control.
