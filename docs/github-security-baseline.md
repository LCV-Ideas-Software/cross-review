# GitHub Security Baseline

This document records the expected security baseline for the maintained public
`cross-review` repository.

Required repository settings after the remote is created:

1. Enable Secret Protection / Secret Scanning.
2. Enable Push Protection.
3. Keep Code Scanning on the committed Advanced CodeQL workflow in
   `.github/workflows/codeql.yml`; leave Default Setup disabled to avoid
   duplicate analyses.
4. Enable Code Quality.
5. Enable Dependabot alerts.
6. Enable Dependabot security updates.
7. Enable Dependabot version updates from `.github/dependabot.yml`.
8. Admit Dependabot pull requests only through an explicit human action in
   GitHub's native merge queue after branch rules are active; do not enable a
   repository-owned auto-merge controller.
9. Protect `main` with a repository ruleset.
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

CodeQL Advanced Setup is committed for GitHub Actions and
JavaScript/TypeScript, and Python, with `security-and-quality` queries. The
workflow runs on `merge_group` so the native merge queue requires the three
`Analyze ...` status contexts and scans the synthetic merge commit. GitHub
documents that Code Scanning ruleset merge protection does not apply to merge
queue groups; consequently, those required contexts prove that the official
analysis completed and uploaded SARIF, but they do not make findings fail the
job on that synthetic commit. This organization-standard platform limitation
is accepted here instead of adding a custom or cross-repository SARIF gate.
Release automation remains stricter and independently checks the exact-SHA
CodeQL analyses before publishing. Any change to this workflow or a migration
to Default Setup must be proposed with justification; the two modes must not
run duplicate analyses. See
<https://docs.github.com/en/code-security/concepts/code-scanning/merge-protection#exceptions-and-limitations>.

No secrets, runtime sessions, logs, prompts, provider responses, API keys or
local AI memories may be committed. The `.gitignore` stays strict because this
repository is public and runtime artifacts belong under local data directories,
not in source control.
