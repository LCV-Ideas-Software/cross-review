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
8. Enable Dependabot auto-merge workflow only after branch rules are active.
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
SLSA provenance. The read-only `STEPSECURITY_NPM_TOKEN` is scoped only to
dependency installation steps.

A successful CI run for a push to `main` may auto-create an
organization-standard display tag such as `vXX.XX.XX` from `package.json`. The
privileged auto-tag workflow uses the trusted default-branch event checkout,
compares it with the successful run SHA and skips every repository-reading or
publishing step on a mismatch. The verified tag then creates a normal GitHub Release and publishes
`@lcv-ideas-software/cross-review` to npmjs.com and GitHub Packages. The
API-first package is separate from the archived CLI package
`@lcv-ideas-software/cross-review-v1`.

CodeQL Advanced Setup is committed for GitHub Actions and
JavaScript/TypeScript, with `security-extended` queries. Any change to that
workflow or a migration to Default Setup must be proposed with justification;
the two modes must not run duplicate analyses.

No secrets, runtime sessions, logs, prompts, provider responses, API keys or
local AI memories may be committed. The `.gitignore` stays strict because this
repository is public and runtime artifacts belong under local data directories,
not in source control.
