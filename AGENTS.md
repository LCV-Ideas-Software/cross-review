# AGENTS.md - cross-review

Pointer for AI agents working in this repository.

## Project

- Repository: `https://github.com/LCV-Ideas-Software/cross-review`
- Package: `@lcv-ideas-software/cross-review`
- Site: `https://cross-review.lcv.dev`
- Branch: `main`
- License: Apache-2.0

## Runtime Shape

This repository is the source of the cross-review MCP server: API-first
multi-model cross-review with unanimous convergence gates. Binaries published
by the package: `cross-review` and `cross-review-dashboard`.

## Mandatory Gates

```bash
npm test
npm run check
npm run lint
npm run biome
npm run typecheck
npm run format:check
npm pack --dry-run
```

Regression suites are versioned (`npm run` lists the full set); a change that
touches a guarded contract must run the matching regression before closure.

## Release

Publishing runs on GitHub's documented model with no manual gesture: a push to
`main` that changes the `package.json` version publishes the package to
npmjs.com through npm Trusted Publishing (OIDC) with provenance, mirrors it to
GitHub Packages, and then records the Release with the run's own token. The
repository owns no tagging or dispatch automation and holds no publishing
secret.

The merge is the deliberate act. A pull request that bumps the version
publishes when it lands, so a version that must not be published must not be
merged. The manifest version has to be a plain three-part numeric version,
never a prerelease: the workflow refuses anything else before deriving the
`vXX.XX.XX` tag. The push that bumps the version is the push that
publishes: the manifest version is compared with the one the previous head
declared, so a push that changes `package.json` without changing the version,
such as a Dependabot merge, ends as a no-op that says so. A run that dies
after a registry write is resumed with GitHub's own recovery,
`gh run rerun --failed <run-id>`, which reruns only the failed jobs and keeps
the outputs of the ones that passed, so nothing is published twice; the
workflow refuses to start over a version npm already serves and says so.

The release checks inside `publish.yml` are business logic with no
repository-owned regression, by the operator's decision: native scanners
(zizmor, CodeQL) own workflow security, and the script changes only through a
reviewed pull request. The regression rule above does not apply to them.

## Language

cross-review is an agent-to-agent protocol. Agents natively speak English, so
every surface of the protocol is English: prompts, tool descriptions, runtime
and error messages, reports, code comments, test descriptions and these
instructions.

Four things stay as they are, and each for a reason that is not style:

- **Verbatim quotations of the operator's standing directives.** Marked as
  quoted in pt-BR, never translated. A translated instruction is a paraphrase,
  and a paraphrase of an instruction is no longer the instruction.
- **Raw provider, OS and tool output** quoted as evidence, byte for byte.
- **Technical identifiers**: model ids, env var names, file paths, and the
  GitHub Project option names (`Triagem`, `Backlog`, `Em andamento`,
  `Em cross-review`, `Em PR`, `Concluido`, `Bloqueado`, `Descartado`), which are
  literal values configured on the board.
- **Passive multilingual recognition.** The truthfulness and status parsers
  match Portuguese phrasing so cross-review can READ evidence and peer output in
  that language. Those alternations, and the test inputs that exercise them, are
  the capability — deleting them would delete it. What matters is that
  cross-review never EMITS in that language.

`site/` is out of scope: it is a public sponsorship page for human sponsors, not
an interface between agents.

**Enforcement is by review, not by a checker.** GitHub's rulesets constrain
branch and tag names, commit metadata, file paths, extensions, size, code
scanning, code quality, coverage and workflows — there is no rule for the
natural language of file content. The repository's existing official tooling
(Biome, ESLint, Prettier, typescript-eslint) has no natural-language rule
either. A custom language detector is explicitly not authorized, and writing one
would be the repository-owned policy engine the workspace policy forbids. So no
mechanism is added: this section is the rule, and review is the gate.

## Workspace Policy

Follow the workspace-root `AGENTS.md` directives of the private workspace that
hosts this checkout (not versioned in this public repository). In
particular: use `ultrabrain`, never allow self-review when a cross-review gate
is applicable, keep `main` as the deployment branch, and use Commit & Sync only
after the requested final audit.

Cross-review is a proportional gate, not a universal ceremony. Require it for
changes with material implementation, architecture, security, privacy,
financial, data-integrity, release-safety, or cross-system risk, and whenever
the operator explicitly requests it. Dispense it for simple mechanical work
such as documentation-only corrections, typo or formatting fixes, immutable
action/dependency pin updates, lockfile regeneration, and equivalent action
substitution when the relevant static validators and CI gates cover the
change. When in doubt, justify the risk classification from the actual diff;
do not invoke cross-review merely because this repository implements the
cross-review product. Do not use historical versioned names for the gate.

## Work record (GitHub Projects, Issues and Discussions)

The team has three members: the **operator** (human), **Claude Code** and
**ChatGPT-Codex**. Almost all work happens in a pair (operator+Claude or
operator+Codex). Whatever stays only in a session transcript is lost to the other
member. That is why the record below is **mandatory**.

This repository's board: `https://github.com/orgs/LCV-Ideas-Software/projects/6`
The organization's consolidated board: `https://github.com/orgs/LCV-Ideas-Software/projects/17`

### The four triggers

**G1 — end of a work block.** Publish a _status update_ on this repository's board
saying what was done, what is still open, and what the next agent needs to know:

```bash
gh api graphql -f query='
  mutation($id:ID!, $body:String!) {
    createProjectV2StatusUpdate(input:{projectId:$id, status:ON_TRACK, body:$body}) {
      statusUpdate { id }
    }
  }' -f id="$PROJECT_ID" -f body="..."
```

Use `AT_RISK` or `OFF_TRACK` when they apply. `PROJECT_ID` comes from
`gh api graphql -f query='query{organization(login:"LCV-Ideas-Software"){projectV2(number:6){id}}}'`.

**G2 — a finding you did not fix.** Every bug, failure, platform limitation or
unexpected behaviour you meet and do **not** resolve on the spot becomes an issue
immediately, with reproduction, environment, evidence, what was already tried and
the hypothesised cause. Use the right form in `.github/ISSUE_TEMPLATE/`.
**Security exception**: no case covered by the private report channel in
`SECURITY.md` — not even the suspicion of one — becomes a public issue; follow the
private channel described there.

**G3 — a durable decision or lesson.** The objective test: _"would this help
whoever meets this problem three months from now?"_ If yes, it becomes a Discussion.

- Knowledge specific to this repository -> Discussions **in this repository** (Q&A or Ideas).
- Knowledge that crosses repositories (release policy, ruleset rule, platform
  constraint) -> Discussions **in the organization**.

**Security exception** (G3 as well): a root cause, exploitation path or remediation
lesson tied to **any case covered by the private report channel in `SECURITY.md`**
does not become a public Discussion before coordinated disclosure. Record it in the
`SECURITY.md` private channel or the matching advisory; after disclosure, publish the
sanitized version as a Discussion, without exploitation detail.

**G4 — non-trivial work.** Open the issue **before** the PR and reference it with
`Closes #N`. That activates automatic closing, the _Linked pull requests_ field and
Status progression.
**Security exception** (G4 as well): work that remediates **any case covered by the
private report channel in `SECURITY.md`** — the list there, not a narrower one:
suspected vulnerability, credential leak, private-data exposure, authentication
bypass, payment-flow problem, supply-chain issue or misconfigured deployment — opens
no public issue and carries no public-surface `Closes #N`. Tracking follows the
`SECURITY.md` private channel and the matching advisory; the PR references the
advisory, without exploitation detail. If `SECURITY.md` changes scope, its text wins.

### Escape valve

A dependency bump, a typo fix, a lockfile and a formatting adjustment **need no
issue**. The PR is enough — it reaches the board on its own when the trigger catches
it; a Dependabot PR is a declared gap in that trigger and may depend on the
activation backfill or reconciliation.

### Fields

Classify every issue with **Type** (Task, Bug, Feature, Incident, Security,
Maintenance, Documentation, Spike) and fill the organization's issue fields **Agent**
(who is working on it) and **Origin** (where it came from). On Bug and Incident, fill
**Environment** as well. These fields are `ORG_ONLY`: they are not visible to the
public, even in this public repository.

### Status flow on the board

`Triagem` -> `Backlog` -> `Em andamento` -> `Em cross-review` -> `Em PR` ->
`Concluido`, with the `Bloqueado` and `Descartado` detours.

These option names are the literal values configured on the GitHub Project. They are
technical identifiers, not prose, and are deliberately left in the operator's
language: renaming them here would describe a board that does not exist.

> **Invariant**: the `Triagem` and `Concluido` options are bound **by ID** to internal
> GitHub workflows that no API can edit. They may be renamed; **never deleted**.

> **Per-board update**: `Status`, `Area` and `Ciclo` are project fields with their own
> IDs on each board. Update BOTH boards — this repository's and portfolio #17 — on
> every transition; an option ID from one board is never valid on the other
> (Discussion org#176).

### No real identifiers in a public repository

Issues, PRs and Discussions in this repository are public and permanent. Use
placeholders (`proj-x`, `exemplo-projeto-000`, `exemplo.com`) instead of cloud project
IDs, database names, domains and accounts. Sensitive operational detail goes to the
private board or to `.github-private`. In this repository the rule carries double
weight: test fixtures have leaked real identifiers in the past, and the standing
directive has required placeholders since the first commit.
