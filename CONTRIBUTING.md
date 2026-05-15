# Contributing

This repository is maintained by LCV Ideas & Software. Contributions should preserve the security, automation, and release posture of cross-review.

## Baseline

- Keep pull requests focused and small enough to review safely.
- Do not commit secrets, tokens, private keys, credentials, generated build output, or local environment files.
- Keep GitHub Actions least-privilege by default and grant write permissions only at the job that needs them.
- Pin third-party GitHub Actions to immutable commit SHAs.
- Preserve Dependabot automation. Do not add required reviewers or CODEOWNERS rules that force manual approval for routine Dependabot updates.
- Prefer squash merges for automation and keep the default branch as `main`.

## Validation

Before opening or merging changes, run the repository-specific checks documented in the README, package scripts, or workflow files. For security-sensitive changes, include evidence of the checks performed in the pull request.
