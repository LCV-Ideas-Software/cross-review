# Model Selection

The server uses automatic model selection unless an explicit environment override is present.

## Rules

1. Query the provider's official model API using the current API key.
2. Keep only models that can perform text generation for the peer role.
3. Exclude known non-thinking, low-capacity or deprecated models from cross-review priority lists.
4. Compare returned model IDs against the documented priority list.
5. Select the first available model in that priority list.
6. Persist the selected model, candidate list, source URL, confidence and reason in the session snapshot.

If a provider returns models but none match the advanced thinking priority list, the runtime keeps the documented advanced fallback instead of silently downgrading to a weaker random candidate. That makes availability problems visible in probes and review rounds.

The no-downgrade behavior is covered by `scripts/smoke.ts`: when a provider
returns only a weak/deprecated candidate such as `claude-haiku-4-5`, selection
stays on the documented advanced fallback and records `confidence=unknown`.

## Current Canonical Pins (no-fallback policy, operator directive 2026-05-14)

Each peer is pinned to exactly ONE canonical model — the most advanced "pro
with reasoning" model available from the provider. The runtime no longer
chains a multi-model fallback list. If the pinned model is genuinely
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

`GROK_API_KEY` is the canonical auth variable for xAI. The runtime sends
`reasoning.effort` only for models that explicitly accept it (e.g.
`grok-4.20-multi-agent`); for automatic-reasoning models such as the pinned
`grok-4-latest`, the adapter omits the field automatically.

`PERPLEXITY_API_KEY` is the canonical auth variable for Perplexity Sonar.
Sonar billing has a 3rd dimension: per-1000-requests fee that scales with
`CROSS_REVIEW_PERPLEXITY_SEARCH_CONTEXT_SIZE` (low/medium/high). When
Perplexity is the relator (lottery), the adapter forces `disable_search=true`
to skip search for the synthesis step.

## Thinking Configuration

Cross-review-v2 is optimized for correctness over latency and cost. Provider adapters explicitly request thinking/reasoning where the official APIs support it:

- OpenAI/Codex: Responses API with reasoning effort `xhigh` by default.
- Anthropic/Claude: adaptive thinking with omitted thinking display plus `output_config.effort=xhigh` by default on Opus 4.7.
- Google/Gemini: `thinkingConfig.thinkingLevel=HIGH` for Gemini 3.x and automatic thinking budget for Gemini 2.5 Pro fallback.
- DeepSeek: `thinking.type=enabled` with `reasoning_effort=max` by default.
- Grok: `reasoning.effort` is sent only for `grok-4.20-multi-agent`; all other
  Grok reasoning models use xAI automatic reasoning without the explicit field.

## Official Documentation Refresh — 2026-05-05

Checked against primary provider documentation before the v2.16.0 protocol
repair:

- OpenAI: GPT-5.5 is the current recommended frontier model for complex
  reasoning/coding, with Responses API reasoning effort values through `xhigh`
  and 1M context / 128K output.
- Anthropic: Claude Opus 4.7 is the generally available complex-reasoning and
  agentic-coding default; current docs expose 1M context and adaptive thinking.
- Google Gemini: Gemini 3.1 Pro Preview is the current advanced Gemini 3.1
  option; Gemini 3 Pro Preview is deprecated/shut down and must stay out of
  active fallbacks.
- DeepSeek: DeepSeek-V4 exposes `deepseek-v4-pro` and `deepseek-v4-flash`;
  legacy `deepseek-chat` and `deepseek-reasoner` are scheduled for
  discontinuation on 2026-07-24 and must stay out of priority fallbacks.
- xAI Grok: the model catalog currently recommends `grok-4.3` for general Chat
  API use, while reasoning docs identify `grok-4.20-multi-agent` as the only
  explicit `reasoning.effort` model. Other Grok reasoning models reason
  automatically and must not receive explicit effort.

## Important

The priority list is intentionally code-level configuration, not hidden behavior. Provider model catalogs and deprecation schedules change often, so this file and `src/peers/model-selection.ts` must be reviewed against official provider documentation whenever defaults change.

The redacted real-API capability smoke for the current default models is recorded in `docs/reports/cross-review-api-capability-smoke-2026-04-30.md`.
