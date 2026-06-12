# GitHub Security Baseline

This document records the expected security baseline for the maintained public
`cross-review` repository.

Required repository settings after the remote is created:

1. Enable Secret Protection / Secret Scanning.
2. Enable Push Protection.
3. Enable Code Scanning with CodeQL Default Setup.
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

Package publishing requires the `NPM_TOKEN` secret. Pushes to `main`
auto-create an organization-standard display tag such as `vXX.XX.XX` from
`package.json`; the tag then creates a normal GitHub Release and publishes
`@lcv-ideas-software/cross-review` to npmjs.com and GitHub Packages. The
API-first package is separate from the archived CLI package
`@lcv-ideas-software/cross-review-v1`.

CodeQL Advanced Setup is intentionally not committed. If Advanced Setup ever becomes necessary,
it must be proposed with justification and approved before adding a workflow file.

No secrets, runtime sessions, logs, prompts, provider responses, API keys or
local AI memories may be committed. The `.gitignore` stays strict because this
repository is public and runtime artifacts belong under local data directories,
not in source control.
