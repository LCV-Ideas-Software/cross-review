# Model Selection

The server pins each peer to ONE canonical model per the no-downgrade policy
(operator directive 2026-05-14). The runtime never silently chains a
multi-model downgrade path. An explicit operator override via
`CROSS_REVIEW_<PROVIDER>_MODEL` env-var is the only way to deviate from the
canonical pin.

## Rules

1. Query the provider's official model API using the current API key to
   validate that the canonical pin is currently available.
2. Keep only models that can perform text generation for the peer role.
3. Exclude known non-thinking, low-capacity or deprecated models — they
   never become the canonical pin.
4. Compare returned model IDs against the canonical pin documented below.
5. If the canonical pin is in the API response, select it; if the canonical
   pin is NOT in the response, KEEP the canonical pin anyway (no silent
   downgrade) so any provider availability problem surfaces visibly in
   probes and review rounds instead of mutating into a weaker model behind
   the operator's back.
6. Persist the selected model, candidate list, source URL, confidence and
   reason in the session snapshot.

The no-downgrade behavior is covered by `scripts/smoke.ts`: when a provider
returns only a weak/deprecated candidate such as `claude-haiku-4-5`,
selection stays on the canonical pin and records `confidence=unknown`.

## Current Canonical Pins (no-fallback policy, operator directive 2026-05-14)

Each peer is pinned to exactly ONE canonical model — the most advanced "pro
with reasoning" model available from the provider. The runtime no longer
chains a multi-model downgrade list. If the pinned model is genuinely
unavailable, the round retries on the same model or skips that peer
(skip-gated quorum floor; see `src/core/convergence.ts`). The only escape
hatch is an explicit operator override via `CROSS_REVIEW_<PROVIDER>_MODEL`
env-var per host — a deliberate decision, never a silent downgrade.

| Peer             | Pin                   | Override env-var                |
| ---------------- | --------------------- | ------------------------------- |
| OpenAI/Codex     | `gpt-5.5`             | `CROSS_REVIEW_OPENAI_MODEL`     |
| Anthropic/Claude | `claude-opus-4-7`     | `CROSS_REVIEW_ANTHROPIC_MODEL`  |
| Google/Gemini    | `gemini-2.5-pro`      | `CROSS_REVIEW_GEMINI_MODEL`     |
| DeepSeek         | `deepseek-v4-pro`     | `CROSS_REVIEW_DEEPSEEK_MODEL`   |
| xAI/Grok         | `grok-4-latest`       | `CROSS_REVIEW_GROK_MODEL`       |
| Perplexity       | `sonar-reasoning-pro` | `CROSS_REVIEW_PERPLEXITY_MODEL` |

Haiku and other low-capacity Anthropic models are intentionally excluded —
the cross-review role requires advanced reasoning depth.

Operator preference 2026-05-07: `gemini-2.5-pro` is the runtime default
because under Google One AI Ultra subscription it carries 1k requests/day vs
`gemini-3.1-pro-preview`'s 250 requests/day. Workspace policy: only
`gemini-*-pro` variants ≥ 2.5 are permitted — no `*-flash` variants and no
models below 2.5.

`GROK_API_KEY` is the canonical auth variable for xAI. The pinned
`grok-4-latest` model uses automatic reasoning in this runtime, so the
adapter omits the explicit `reasoning.effort` field automatically unless a
future operator-approved pin explicitly supports that parameter.

`PERPLEXITY_API_KEY` is the canonical auth variable for Perplexity Sonar.
Sonar billing has a 3rd dimension: per-1000-requests fee that scales with
`CROSS_REVIEW_PERPLEXITY_SEARCH_CONTEXT_SIZE` (low/medium/high). When
Perplexity is the relator (lottery), the adapter forces `disable_search=true`
to skip search for the synthesis step.

## Thinking Configuration

Cross-review is optimized for correctness over latency and cost. Provider adapters explicitly request thinking/reasoning where the official APIs support it:

- OpenAI/Codex: Responses API with reasoning effort `xhigh` by default.
- Anthropic/Claude: adaptive thinking with omitted thinking display plus `output_config.effort=xhigh` by default on Opus 4.7.
- Google/Gemini: automatic thinking budget for the pinned Gemini 2.5 Pro model; Gemini 3.x thinking-level notes are historical and apply only to an explicit operator-approved override.
- DeepSeek: `thinking.type=enabled` with `reasoning_effort=max` by default.
- Grok: the pinned `grok-4-latest` model uses xAI automatic reasoning without
  the explicit `reasoning.effort` field.

## Historical Documentation Refresh — 2026-05-05

This section is historical context for the v2.16.0 protocol repair. Do not
read it as the current pin list; the authoritative current pins are listed
above and enforced by `src/peers/model-selection.ts`.

- OpenAI: GPT-5.5 is the current recommended frontier model for complex
  reasoning/coding, with Responses API reasoning effort values through `xhigh`
  and 1M context / 128K output.
- Anthropic: Claude Opus 4.7 is the generally available complex-reasoning and
  agentic-coding default; current docs expose 1M context and adaptive thinking.
- Google Gemini: Gemini 3.1 Pro Preview was the advanced Gemini 3.1 option at
  the time; Gemini 3 Pro Preview was deprecated/shut down and must stay out of
  current pins and downgrade chains.
- DeepSeek: DeepSeek-V4 exposes `deepseek-v4-pro` and `deepseek-v4-flash`;
  legacy `deepseek-chat` and `deepseek-reasoner` were scheduled for
  discontinuation on 2026-07-24 and must stay out of current pins and
  downgrade chains.
- xAI Grok: historical Grok notes covered explicit-effort models that predate
  the current `grok-4-latest` pin. Current runtime behavior is defined above:
  omit explicit `reasoning.effort` for `grok-4-latest`.

## Important

The canonical pin per peer is intentionally code-level configuration, not hidden behavior. Provider model catalogs and deprecation schedules change often, so this file and `src/peers/model-selection.ts` must be reviewed against official provider documentation whenever a pin changes.

The redacted real-API capability smoke from the historical v2 line is recorded
in `docs/reports/cross-review-v2-api-capability-smoke-2026-04-30.md`. The
`cross-review-v2` filename is intentionally preserved as historical record; it
does not override the post-v4 product name.
