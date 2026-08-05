# Cross Review v2 - API Capability Smoke

Date: 30/04/2026, America/Sao_Paulo
Runtime under test: local `cross-review-v2` source, package version `2.1.1`

## Purpose

This report records a real provider capability smoke test for the API-first
runtime. It is intended to support release review without exposing API keys,
raw secrets, full prompts or full provider responses.

The test used the same Windows environment variable strategy as the MCP host
configuration. The keys were detected in the current process, User environment
and Machine environment. No key value was printed or written to this report.

## Official Documentation Checked

- OpenAI latest model: `https://platform.openai.com/docs/guides/latest-model`
  (redirects to `https://developers.openai.com/api/docs/guides/latest-model`)
- OpenAI reasoning:
  `https://platform.openai.com/docs/guides/reasoning`
- Anthropic adaptive thinking: `https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`
- Anthropic effort: `https://platform.claude.com/docs/en/build-with-claude/effort`
- Google Gemini thinking: `https://ai.google.dev/gemini-api/docs/thinking`
- DeepSeek quick start: `https://api-docs.deepseek.com/`
- DeepSeek thinking mode: `https://api-docs.deepseek.com/guides/thinking_mode`
- DeepSeek multi-round conversation: `https://api-docs.deepseek.com/guides/multi_round_chat`

Relevant current documentation observations:

- OpenAI documents GPT-5.5 as the latest model page, recommends updating the
  model slug to `gpt-5.5`, recommends the Responses API for reasoning,
  tool-calling and multi-turn use cases, and documents `xhigh` for the hardest
  asynchronous agentic tasks and security/code review workloads.
- Anthropic's official Claude API Docs on `platform.claude.com` document
  `claude-opus-4-7` with adaptive thinking and `output_config.effort`,
  including `xhigh` for advanced coding and complex agentic work.
- Gemini documents `thinkingConfig` for Gemini API calls; the real model
  metadata for `gemini-3.1-pro-preview` reports `thinking: true`.
- DeepSeek documents `deepseek-v4-pro`, `thinking.type=enabled`,
  `reasoning_effort=high|max`, JavaScript OpenAI-client examples with
  top-level `thinking` and `reasoning_effort`, the 24/07/2026 deprecation of
  `deepseek-chat` and `deepseek-reasoner`, and stateless multi-round chat
  behavior.

## Model Exclusion Rationale

- `deepseek-chat` and `deepseek-reasoner` are excluded because DeepSeek marks
  both names for deprecation on 24/07/2026 and maps them to compatibility names
  for `deepseek-v4-flash`.
- `claude-haiku-4-5` is excluded because the cross-review role requires the
  advanced Opus/Sonnet adaptive-thinking line. Anthropic documents adaptive
  thinking support for Opus 4.7, Opus 4.6 and Sonnet 4.6; Haiku is not in the
  active advanced priority set for this peer-review role.
- `gemini-3-pro-preview` is excluded because the user's key exposes the newer
  `gemini-3.1-pro-preview` model with thinking support. The runtime should use
  the highest visible advanced thinking model and avoid older intermediate
  previews when a newer advanced model is available.

## Redacted Model API Excerpts

The following snippets are reduced to non-secret model metadata needed for
release review. They are not full API-key-bearing responses.

```json
{
  "openai": {
    "models_endpoint_count": 126,
    "relevant_model_ids": [
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.2",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex",
      "gpt-5.1",
      "gpt-5-pro",
      "gpt-5"
    ],
    "selected": "gpt-5.5",
    "reported_model": "gpt-5.5-2026-04-23"
  },
  "anthropic": {
    "models_endpoint_count": 9,
    "relevant_model_ids": [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-opus-4-5-20251101",
      "claude-haiku-4-5-20251001"
    ],
    "selected": "claude-opus-4-7",
    "reported_model": "claude-opus-4-7"
  },
  "gemini": {
    "models_endpoint_count": 55,
    "selected_model_metadata": {
      "id": "gemini-3.1-pro-preview",
      "displayName": "Gemini 3.1 Pro Preview",
      "inputTokenLimit": 1048576,
      "outputTokenLimit": 65536,
      "supportedActions": [
        "generateContent",
        "countTokens",
        "createCachedContent",
        "batchGenerateContent"
      ],
      "thinking": true
    },
    "reported_model": "gemini-3.1-pro-preview"
  },
  "deepseek": {
    "models_endpoint_count": 2,
    "model_ids": ["deepseek-v4-flash", "deepseek-v4-pro"],
    "selected": "deepseek-v4-pro",
    "reported_model": "deepseek-v4-pro"
  }
}
```

## Real API Results

All four provider capability checks succeeded.

### OpenAI

- Configured model: `gpt-5.5`
- API model catalog count visible to the key: `126`
- Selected model: `gpt-5.5`
- Reported model from real Responses API call: `gpt-5.5-2026-04-23`
- Capability tested: Responses API, `reasoning.effort=xhigh`
- Reasoning tokens observed: `15`
- Output preview: `OK_OPENAI`

### Anthropic

- Configured model: `claude-opus-4-7`
- API model catalog count visible to the key: `9`
- Relevant advanced models observed: `claude-opus-4-7`,
  `claude-opus-4-6`, `claude-sonnet-4-6`
- Selected model: `claude-opus-4-7`
- Capability tested: Messages API, `thinking.type=adaptive`,
  `thinking.display=omitted`, `output_config.effort=max`
- Additional capability test: `output_config.effort=xhigh`
- Reported model from both real calls: `claude-opus-4-7`
- Stop reason: `end_turn`

### Google Gemini

- Configured model: `gemini-3.1-pro-preview`
- API model catalog count visible to the key: `55`
- Selected model: `gemini-3.1-pro-preview`
- Selected model metadata:
  - `inputTokenLimit`: `1048576`
  - `outputTokenLimit`: `65536`
  - `supportedActions`: `generateContent`, `countTokens`,
    `createCachedContent`, `batchGenerateContent`
  - `thinking`: `true`
- Capability tested: `generateContent` with `thinkingConfig.thinkingLevel=HIGH`
- Thoughts token count observed: `115`
- Output preview: `OK_GEMINI`

### DeepSeek

- Configured model: `deepseek-v4-pro`
- API model catalog count visible to the key: `2`
- Models visible to the key: `deepseek-v4-flash`, `deepseek-v4-pro`
- Selected model: `deepseek-v4-pro`
- Capability tested: OpenAI-compatible chat completions with
  `thinking.type=enabled` and `reasoning_effort=max`
- Reasoning tokens observed: `29`
- Output preview: `OK_DEEPSEEK`

## Local Runtime Evidence

`npm test` passed after the latest change set. The test command includes:

1. `npm run build`
2. `npm run smoke`
3. `npm run runtime-smoke`

Runtime smoke reported this server identity:

```json
{
  "name": "cross-review-v2",
  "publisher": "LCV Ideas & Software",
  "version": "2.1.1",
  "release_date": "2026-04-30",
  "transport": "stdio",
  "api_only": true,
  "cli_execution": false,
  "stable_release": true,
  "max_output_tokens": 20000,
  "stub": true,
  "retry_timeout_ms": 1800000
}
```

The package dry run reported:

```json
{
  "id": "@lcv-ideas-software/cross-review-v2@2.1.1",
  "name": "@lcv-ideas-software/cross-review-v2",
  "version": "2.1.1",
  "filename": "lcv-ideas-software-cross-review-v2-2.1.1.tgz",
  "entryCount": 91,
  "bundled": []
}
```

The dry-run file list includes `dist/`, `docs/`, `README.md`, `LICENSE`,
`NOTICE`, `SECURITY.md`, `CHANGELOG.md`, `package.json`, and this report. It
does not include `data/`, `.env`, logs, session files or API keys.

Full dry-run path list:

```text
CHANGELOG.md
LICENSE
NOTICE
README.md
SECURITY.md
dist/scripts/runtime-smoke.d.ts
dist/scripts/runtime-smoke.js
dist/scripts/runtime-smoke.js.map
dist/scripts/smoke.d.ts
dist/scripts/smoke.js
dist/scripts/smoke.js.map
dist/src/core/config.d.ts
dist/src/core/config.js
dist/src/core/config.js.map
dist/src/core/convergence.d.ts
dist/src/core/convergence.js
dist/src/core/convergence.js.map
dist/src/core/cost.d.ts
dist/src/core/cost.js
dist/src/core/cost.js.map
dist/src/core/orchestrator.d.ts
dist/src/core/orchestrator.js
dist/src/core/orchestrator.js.map
dist/src/core/reports.d.ts
dist/src/core/reports.js
dist/src/core/reports.js.map
dist/src/core/session-store.d.ts
dist/src/core/session-store.js
dist/src/core/session-store.js.map
dist/src/core/status.d.ts
dist/src/core/status.js
dist/src/core/status.js.map
dist/src/core/timeouts.d.ts
dist/src/core/timeouts.js
dist/src/core/timeouts.js.map
dist/src/core/types.d.ts
dist/src/core/types.js
dist/src/core/types.js.map
dist/src/dashboard/server.d.ts
dist/src/dashboard/server.js
dist/src/dashboard/server.js.map
dist/src/mcp/server.d.ts
dist/src/mcp/server.js
dist/src/mcp/server.js.map
dist/src/observability/logger.d.ts
dist/src/observability/logger.js
dist/src/observability/logger.js.map
dist/src/peers/anthropic.d.ts
dist/src/peers/anthropic.js
dist/src/peers/anthropic.js.map
dist/src/peers/base.d.ts
dist/src/peers/base.js
dist/src/peers/base.js.map
dist/src/peers/deepseek.d.ts
dist/src/peers/deepseek.js
dist/src/peers/deepseek.js.map
dist/src/peers/errors.d.ts
dist/src/peers/errors.js
dist/src/peers/errors.js.map
dist/src/peers/gemini.d.ts
dist/src/peers/gemini.js
dist/src/peers/gemini.js.map
dist/src/peers/model-selection.d.ts
dist/src/peers/model-selection.js
dist/src/peers/model-selection.js.map
dist/src/peers/openai.d.ts
dist/src/peers/openai.js
dist/src/peers/openai.js.map
dist/src/peers/registry.d.ts
dist/src/peers/registry.js
dist/src/peers/registry.js.map
dist/src/peers/retry.d.ts
dist/src/peers/retry.js
dist/src/peers/retry.js.map
dist/src/peers/stub.d.ts
dist/src/peers/stub.js
dist/src/peers/stub.js.map
dist/src/peers/text.d.ts
dist/src/peers/text.js
dist/src/peers/text.js.map
dist/src/security/redact.d.ts
dist/src/security/redact.js
dist/src/security/redact.js.map
docs/api-keys.md
docs/architecture.md
docs/costs.md
docs/github-security-baseline.md
docs/model-selection.md
docs/reports/cross-review-v2-api-capability-smoke-2026-04-30.md
docs/reports/cross-review-v2-format-recovery-findings-2026-04-28.md
package.json
```

## Regression Coverage Added

- `scripts/smoke.ts` verifies `CROSS_REVIEW_V2_MAX_OUTPUT_TOKENS` accepts
  positive integers and falls back to `20000` for invalid values.
- `scripts/smoke.ts` verifies all four adapters use the configured output
  token value rather than hard-coded limits.
- `scripts/smoke.ts` verifies Anthropic, Gemini and DeepSeek thinking markers
  are present in adapter source.
- `scripts/smoke.ts` verifies active priority lists do not contain
  `claude-haiku-4-5`, `gemini-3-pro-preview`, `deepseek-chat` or
  `deepseek-reasoner`.
- `scripts/smoke.ts` verifies a provider returning only
  `claude-haiku-4-5-20251001` does not cause a silent weak-model downgrade; the
  selected model remains `claude-opus-4-7` with `confidence=unknown`.
- `scripts/smoke.ts` verifies malformed, mismatched, overlapping, repeated,
  CRLF and long private-key markers do not reintroduce the previous redaction
  complexity issue.
- `scripts/smoke.ts` verifies empty peer output triggers the full decision retry
  and records `decision_retry_succeeded`.
- `scripts/smoke.ts` verifies moderation recovery, model fallback, budget
  preflight, cooperative cancellation, runtime events and metrics.

## Pre-Commit Identity

This evidence report is intentionally pre-commit. The candidate is based on
current `main` HEAD `b7ae98836dfe8c461d72b406e5ab30712705d765` plus the local
working-tree changes described above. The `release_date` constant is
intentionally set to `2026-04-30`, the planned ship date for package `2.1.1`.
The final commit SHA and GitHub release tag will be produced only after
cross-review approval and the commit/push workflow.

## Release Implications

- The current model defaults are reachable with the user's keys.
- The runtime should continue to prefer advanced thinking-capable models only.
- `claude-haiku-4-5`, `gemini-3-pro-preview`, `deepseek-chat` and
  `deepseek-reasoner` must stay out of active priority lists.
- If a provider model API returns candidates but none match the advanced
  priority list, the runtime must keep the documented advanced fallback rather
  than silently downgrading to a weaker returned candidate.
- `CROSS_REVIEW_V2_MAX_OUTPUT_TOKENS=20000` remains the configured production
  output budget; this smoke used a smaller request budget to avoid unnecessary
  test output while proving the parameters are accepted.
