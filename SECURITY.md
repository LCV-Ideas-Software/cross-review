# Security Policy

## Supported status

Current supported source candidate: v04.05.00 for package 4.5.0. Latest published npm release: v04.04.08 for package 4.4.8. The current main branch is supported for security fixes until the next release is published.

v04.05.00 strengthens the trust boundary around model output and runtime
evidence. Incomplete or unhealthy provider terminal states fail closed;
operator-only mutations require a distinct operator capability token; attached
evidence is hashed, attributed and reverified on every read; and unsupported operational
claims, model-pin contradictions and unresolved evidence cannot converge.
Invalid session metadata is quarantined rather than trusted by list/doctor
operations. The release also retains the dependency advisory floors introduced
in v04.04.07 and v04.04.08.

READY is a canonical envelope, not a free-form natural-language classification:
its summary is fixed, requests/follow-ups are empty and outside prose is
rejected. Session cancellation and verdict contestation require the explicit
petitioner token or the operator token; ambiguous legacy ownership is
operator-only.

The capability token authenticates the MCP host, not a model's internal intent
or amount of cognitive effort. The operator token must never be placed in a
model host. The local token file is plaintext and therefore assumes processes
with read access to the cross-review data directory are trusted; use OS-level
isolation for adversaries that can read another host's files.

No API can prove how much internal reasoning a model performed. The runtime
proves observable protocol behavior—terminal completion, evidence custody,
source grounding, independent unanimity and contradiction checks—not private
cognition. In circular mode, byte-identical output is an artifact-stability
signal only; convergence still requires a complete rotation, but an individual
echo is not cryptographic proof that the rotator read deeply. SHA-256 likewise
proves file integrity after custody, not human authorship.

## Reporting a vulnerability

Please do not open a public issue for suspected vulnerabilities, credential leaks, private data exposure, authentication bypasses, payment-flow issues, supply-chain issues, or deployment misconfiguration.

Report privately by email:

- lcv@lcv.dev

If GitHub private vulnerability reporting is enabled for this repository, that channel is also acceptable.

Please include:

- affected repository, component, route, package, workflow, or public surface;
- affected version, release tag, commit SHA, or deployment URL when known;
- impact and exploitability;
- reproduction steps or a safe proof of concept, if available;
- whether any credential, personal data, payment data, private editorial material, or operational secret may be involved.

## Scope

In scope: application code, Workers/Pages functions, package publication, GitHub Actions, dependency and supply-chain configuration, repository publication boundaries, security documentation, and public service configuration documented in this repository.

Out of scope: social engineering, physical attacks, denial-of-service testing without prior written authorization, spam, automated noisy scanning, and reports that rely only on outdated browser or dependency versions without a concrete vulnerable path in this repository.

## Coordinated disclosure

LCV Ideas & Software will triage reports privately, request clarification when needed, and coordinate remediation before public disclosure. Public disclosure should wait until a fix or mitigation is available, unless there is an immediate user-safety reason to do otherwise.
