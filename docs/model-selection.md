# Model Selection

The server pins each peer to ONE canonical model per the no-downgrade policy
(operator directive 2026-05-14). The runtime never silently chains a
multi-model downgrade path. An explicit operator override via
`CROSS_REVIEW_<PROVIDER>_MODEL` env-var is the only way to deviate from the
canonical pin.

## Rules

1. When the provider exposes a model-list endpoint, query it with the current
   API key to validate that the canonical pin is available. Perplexity is the
   documented exception: Sonar exposes no public `models.list`, so its pin is
   validated against official documentation and remains `confidence=inferred`.
2. Keep only models that can perform text generation for the peer role.
3. Exclude known non-thinking, low-capacity or deprecated models — they
   never become the canonical pin.
4. Compare returned model IDs against the canonical pin documented below.
5. If an explicit supported operator-selected pin is configured and appears in
   the provider response, select that pin. Otherwise, if the canonical pin is
   in the API response, select it. If the configured pin is NOT in the response,
   KEEP the configured pin anyway (no silent downgrade) so any provider
   availability problem surfaces visibly in probes and review rounds instead
   of mutating into a weaker model behind the operator's back.
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

| Peer             | Pin                      | Override env-var                |
| ---------------- | ------------------------ | ------------------------------- |
| OpenAI/Codex     | `gpt-5.6-sol`            | `CROSS_REVIEW_OPENAI_MODEL`     |
| Anthropic/Claude | `claude-fable-5`         | `CROSS_REVIEW_ANTHROPIC_MODEL`  |
| Google/Gemini    | `gemini-3.1-pro-preview` | `CROSS_REVIEW_GEMINI_MODEL`     |
| DeepSeek         | `deepseek-v4-pro`        | `CROSS_REVIEW_DEEPSEEK_MODEL`   |
| xAI/Grok         | `grok-4.5`               | `CROSS_REVIEW_GROK_MODEL`       |
| Perplexity       | `sonar-reasoning-pro`    | `CROSS_REVIEW_PERPLEXITY_MODEL` |

Haiku and other low-capacity Anthropic models are intentionally excluded —
the cross-review role requires advanced reasoning depth.

Claude Fable 5 (`claude-fable-5`) is the canonical Anthropic production model.
The adapter omits the explicit `thinking` field because Fable applies adaptive
thinking automatically; `output_config.effort` remains the depth control.
Fable refusals are successful API responses with `stop_reason="refusal"`; the
runtime discards partial refusal output and records a non-skippable
`provider_refusal`. Anthropic documents 30-day retention and no zero data
retention option for Fable, so operators must accept that posture before using
the peer.

Google's deprecation schedule lists `gemini-2.5-pro` for shutdown on
2026-10-16 and recommends `gemini-3.1-pro-preview` as the replacement.
Workspace policy remains: only `gemini-*-pro` variants >= 2.5 are permitted
for this peer; no `*-flash` variants and no models below 2.5. Operators can
still override the pin explicitly, but the default/canonical path follows the
documented replacement.

`GROK_API_KEY` is the canonical auth variable for xAI. The pinned `grok-4.5`
model accepts exactly `low`, `medium`, and `high` for `reasoning.effort`; the
adapter maps the shared scale into that range so unsupported values do not
reach the wire.

`PERPLEXITY_API_KEY` is the canonical auth variable for Perplexity Sonar.
Sonar billing has a 3rd dimension: per-1000-requests fee that scales with
`CROSS_REVIEW_PERPLEXITY_SEARCH_CONTEXT_SIZE` (low/medium/high). When
Perplexity is the relator (lottery), the adapter forces `disable_search=true`
to skip search for the synthesis step. The runtime still accounts for the
configured Sonar request fee: disabling search does not turn the request into
a zero-cost probe or synthesis call.

Perplexity does not document a zero-token model/auth endpoint. To avoid
accidental probe spend, `probe_peers` defaults to
`CROSS_REVIEW_PERPLEXITY_PROBE_MODE=auth_only`, which reports key presence and
the configured pin without a Sonar completion. Set the mode to `live` when you
explicitly want a minimal `disable_search` round-trip.

## Thinking Configuration

Cross-review is optimized for correctness over latency and cost. Provider adapters explicitly request thinking/reasoning where the official APIs support it:

- OpenAI/Codex: `gpt-5.6-sol` through the Responses API. The API accepts
  `reasoning.effort=max`; `ultra` is a Codex product/CLI mode and is not valid
  in cross-review central config or an API request.
- Anthropic/Claude: Fable 5 omits the explicit `thinking` object (adaptive
  thinking is automatic) and uses `output_config.effort` for depth.
- Google/Gemini: high thinking level for the pinned Gemini 3.1 Pro Preview
  model; the adapter keeps the Gemini 3 thinking path explicit because this
  peer is used for complex reasoning and coding review.
- DeepSeek: `thinking.type=enabled` with `reasoning_effort=max` by default.
- Grok: the pinned `grok-4.5` model accepts explicit `reasoning.effort` at
  `low`, `medium`, or `high`; unsupported shared-scale values are clamped.
- Perplexity: the pinned `sonar-reasoning-pro` model accepts an explicit
  `reasoning_effort` enum (`minimal`/`low`/`medium`/`high`, `high` by default);
  `clampEffortForPerplexity` narrows the shared effort scale into that range
  (`none`/`minimal` → `minimal`; `xhigh`/`max` → `high`).

## Official provider references

- OpenAI: [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
  and [latest-model guide](https://developers.openai.com/api/docs/guides/latest-model).
- Anthropic: [Fable 5 introduction](https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5),
  [effort](https://platform.claude.com/docs/en/build-with-claude/effort),
  [refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback),
  and [API/data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention).
- Google: [Gemini 3.1 Pro Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview),
  [Gemini 3](https://ai.google.dev/gemini-api/docs/gemini-3), and
  [thinking](https://ai.google.dev/gemini-api/docs/thinking), plus the
  [deprecation schedule](https://ai.google.dev/gemini-api/docs/deprecations).
- DeepSeek: [API updates](https://api-docs.deepseek.com/updates) and
  [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode), plus
  [models and pricing](https://api-docs.deepseek.com/quick_start/pricing/).
- xAI: [Grok 4.5](https://docs.x.ai/developers/grok-4-5) and
  [reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning),
  plus [prompt-cache usage and pricing](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing).
- Perplexity: [Sonar models](https://docs.perplexity.ai/docs/sonar/models) and
  [Sonar Reasoning Pro](https://docs.perplexity.ai/docs/sonar/models/sonar-reasoning-pro),
  [OpenAI compatibility](https://docs.perplexity.ai/docs/sonar/openai-compatibility),
  the [request schema](https://docs.perplexity.ai/api-reference/sonar-post), and
  [pricing](https://docs.perplexity.ai/docs/getting-started/pricing).

## Historical Documentation Refresh — 2026-05-05

This section is historical context for the v2.16.0 protocol repair. Do not
read it as the current pin list; the authoritative current pins are listed
above and enforced by `src/peers/model-selection.ts`.

- OpenAI: GPT-5.5 was, at that time, the recommended frontier model for complex
  reasoning/coding, with Responses API reasoning effort values through `xhigh`
  and 1M context / 128K output.
- Anthropic: Claude Opus 4.8 had superseded Opus 4.7 as the then-current
  complex-reasoning and agentic-coding default; the documentation at that time
  retained the same regular price tier as 4.7.
- Google Gemini: Gemini 3.1 Pro Preview is the documented replacement for
  Gemini 2.5 Pro. Gemini 3 Pro Preview was deprecated/shut down and must stay
  out of current pins and downgrade chains.
- DeepSeek: DeepSeek-V4 exposes `deepseek-v4-pro` and `deepseek-v4-flash`;
  legacy `deepseek-chat` and `deepseek-reasoner` were scheduled for
  discontinuation on 2026-07-24 and must stay out of current pins and
  downgrade chains.
- xAI Grok: historical Grok notes covered aliases and the earlier concrete
  `grok-4.3` pin. Current runtime behavior is defined above by the
  `grok-4.5` pin and its clamped `low`/`medium`/`high` reasoning effort.

## Important

The canonical pin per peer is intentionally code-level configuration, not hidden behavior. Provider model catalogs and deprecation schedules change often, so this file and `src/peers/model-selection.ts` must be reviewed against official provider documentation whenever a pin changes.

The redacted real-API capability smoke from the historical v2 line is recorded
in `docs/reports/cross-review-v2-api-capability-smoke-2026-04-30.md`. The
`cross-review-v2` filename is intentionally preserved as historical record; it
does not override the post-v4 product name.
