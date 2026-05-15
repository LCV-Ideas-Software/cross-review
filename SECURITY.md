# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this repository, please do **not** open a public issue. Instead, please report it privately to the repository maintainer.

**Contact:** alert@lcvmail.com

Please include:

- Description of the vulnerability
- Steps to reproduce (if applicable)
- Potential impact
- Suggested fix (if you have one)

We will acknowledge your report within 24 hours and work to resolve the issue promptly.

## Supported Versions

| Version           | Supported                |
| ----------------- | ------------------------ |
| Latest            | ✅                       |
| Previous releases | ⚠️ Security updates only |

## Security Measures

This repository employs:

- **Code Scanning (CodeQL)**: Automated static analysis on all commits
- **Dependency Scanning (Dependabot)**: Automated dependency vulnerability detection
- **Secret Scanning**: Detection and remediation of exposed secrets
- **Branch Protection**: Required status checks before merge to main

## Threat Model

`cross-review` is designed for a **single-user trusted host**. Inputs from operator and peers are not adversarial; the orchestrator holds API credentials in process memory and relies on local-only network bindings for the dashboard. Outside this model, the following caveats apply:

- **Multi-host concurrency.** Running two MCP host instances of `cross-review` against the same `CROSS_REVIEW_DATA_DIR` is **not supported**. The per-session lock has TTL + PID-liveness fallbacks that close the common cases but leave a narrow TOCTOU window when two hosts contend for the same session. If you need multi-host operation, point each instance at a distinct `CROSS_REVIEW_DATA_DIR` (introduced in v2.0; tilde expansion since v2.4.0) or share one host across all clients.
- **API keys in memory.** `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY` are loaded into `AppConfig.api_keys` at boot. The persistence layer redacts secrets via [`redact()`](./src/security/redact.ts) before any meta.json/event log write, but the in-memory object is not opaque — do not log `config` directly. Stack traces from SDK errors are passed through `safeErrorMessage()` which redacts known key shapes.
- **Stub adapters.** `CROSS_REVIEW_STUB=1` alone is **ignored** since v2.4.0. To activate stubs, also set `NODE_ENV=test` OR `CROSS_REVIEW_STUB_CONFIRMED=1`. This double-confirmation prevents a stray dotenv variable from invalidating a cross-review used as a pre-commit gate.
- **Dashboard HTTP.** The dashboard binds only to `127.0.0.1`. There is no authentication or rate-limit; same-machine processes can read all session metadata, costs and report markdown. Do not expose the dashboard port over a network without an authenticating reverse proxy.
- **Untrusted callers.** The MCP `tools/list` schemas enforce per-field caps (`maxLength`, `pattern`) since v2.4.0 to defend against memory-exhaustion attempts via oversized `task`/`draft`/`prompt`. The trust boundary still assumes a cooperative caller — do not expose the stdio transport over a network socket without an authenticating proxy.
- **Untrusted peers.** Peer streaming responses are capped at 16 MiB per call (`STREAM_TEXT_MAX_BYTES` since v2.4.0). The structured `<cross_review_status>` payload is rejected as malformed when it exceeds 64 KiB before `JSON.parse` runs.
- **MCP schema transforms.** `SessionIdSchema` lowercases its input via a zod `.transform()`. JSON Schema does not have a native equivalent for transforms, so the JSON Schema published by the MCP SDK reflects only the regex validation, not the lowercasing. External clients see "uppercase UUIDv4 accepted" in the schema and the server still accepts it — the lowercasing happens server-side after parsing. The on-disk session_id and any value returned through MCP responses are always lowercase.
- **Provider env-var precedence.** The DeepSeek adapter constructs the OpenAI SDK with `baseURL: "https://api.deepseek.com"`. The OpenAI SDK can also honor `OPENAI_BASE_URL` from the environment; the constructor argument takes precedence in current SDK versions, but operators should avoid setting `OPENAI_BASE_URL` globally to prevent any future SDK regression from redirecting DeepSeek traffic.

## Best Practices

- Keep dependencies up-to-date
- Use strong authentication (SSH keys, personal access tokens)
- Review pull requests carefully before merge
- Report any suspicious activity immediately
