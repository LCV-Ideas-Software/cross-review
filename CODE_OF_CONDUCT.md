# Code of Conduct

This project adopts the **Contributor Covenant 3.0** as its community standard. The full canonical text is available at:

- https://www.contributor-covenant.org/version/3/0/code_of_conduct/
- Plain-text mirror: https://www.contributor-covenant.org/version/3/0/code_of_conduct/code_of_conduct.md

By participating in this project (contributing code, filing issues, opening pull requests, participating in discussions, or using the cross-review MCP tooling against shared artifacts), you agree to follow the Contributor Covenant 3.0 standard linked above.

---

## Scope

This applies to:

- All project spaces on GitHub (issues, pull requests, discussions, commits).
- Cross-review sessions conducted with this MCP server when the session is shared or published.
- Any public representation of the project, including conference talks, blog posts, and social media posts identifying as maintainers or contributors.

---

## Enforcement contact

Reports of violations can be sent privately to:

**lcv@lcv.dev**

This is the same private channel used for security reports (see [SECURITY.md](./SECURITY.md)). Reports will be acknowledged within 48 hours and handled per the Contributor Covenant 3.0 enforcement ladder.

All reporters will have their identity kept confidential.

---

## Notes specific to cross-review

The cross-review protocol itself is designed around **structured disagreement**. Peers regularly respond with `NOT_READY` carrying technical objections; this is the intended behavior of the protocol and is NOT a code-of-conduct concern. The standard applies to personal conduct between contributors, not to the technical content of parecer/objections/findings exchanged by peers under the spec.

When a reviewer's feedback is technically sharp but professionally framed, that is the protocol working as designed (see spec `§2`): a strict peer review that catches residuals is a feature, not an obstacle. A reviewer emitting `NOT_READY` with precise technical `caller_requests` is doing the job the protocol asks them to do; a caller treating that rigor as hostile is misreading the contract. When personal conduct crosses the Contributor Covenant standard, that is a CoC matter handled via the enforcement contact above.
