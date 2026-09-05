# Model Selection

The server pins each peer to ONE canonical model per the no-downgrade policy
(operator directive 14/05/2026). The runtime never silently chains a
multi-model downgrade path. An explicit operator override via
`CROSS_REVIEW_<PROVIDER>_MODEL` env-var is the only way to deviate from the
canonical pin.

## Rules

1. When the provider exposes a model-list endpoint, query it with the current
   API key to validate that the canonical pin is available. Perplexity is the
   documented exception: its Agent API catalog is not exposed through the
   OpenAI-SDK `models.list` path the resolver shares with the other peers, so
   its pin is validated against official documentation and remains
   `confidence=inferred`.
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

## Current Canonical Pins (no-fallback policy, operator directive 14/05/2026)

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
| xAI/Grok         | `grok-4.6`               | `CROSS_REVIEW_GROK_MODEL`       |
| Perplexity       | `perplexity/kimi-k3`     | `CROSS_REVIEW_PERPLEXITY_MODEL` |

Haiku and other low-capacity Anthropic models are intentionally excluded —
the cross-review role requires advanced reasoning depth.

Claude Fable 5 (`claude-fable-5`) is the canonical Anthropic production model.
The adapter omits the explicit `thinking` field because Fable applies adaptive
thinking automatically; `output_config.effort` remains the depth control.
Fable refusals are successful API responses with `stop_reason="refusal"`; the
runtime discards partial refusal output and records a non-skippable
`provider_refusal`. A refusal before output is zero-cost even though Anthropic
can report input usage; a mid-stream refusal is billed for the input and output
already generated. Anthropic documents 30-day retention and no zero data
retention option for Fable, so operators must accept that posture before using
the peer.

Claude Opus 5 (`claude-opus-5`) is a supported explicit operator override. It
does not enter the canonical priority list and is never selected as an
automatic fallback. The Messages request uses
`thinking={type:"adaptive",display:"omitted"}` plus
`output_config.effort`; it never sends the removed manual
`thinking={type:"enabled",budget_tokens:...}` form or non-default sampling
parameters. Opus 5 has a 1M-token context window and 128K synchronous output
ceiling. Anthropic recommends starting with 64K `max_tokens` at `xhigh` or
`max`, which matches the maintained Claude budget.

Google's deprecation schedule lists `gemini-2.5-pro` for shutdown on
16/10/2026 and recommends `gemini-3.1-pro-preview` as the replacement.
Workspace policy remains: only `gemini-*-pro` variants >= 2.5 are permitted
for this peer; no `*-flash` variants and no models below 2.5. Operators can
still override the pin explicitly, but the default/canonical path follows the
documented replacement.

`GROK_API_KEY` is the canonical auth variable for xAI. The pinned `grok-4.6`
model accepts `low`, `medium`, `high`, and `xhigh` for `reasoning.effort`
("xhigh is available on grok-4.6 and later"); the adapter maps the shared scale
into that range (`max`/`ultra` → `xhigh`) so unsupported values do not reach
the wire.

`PERPLEXITY_API_KEY` is the canonical auth variable for Perplexity. Since
v4.6.0 the adapter speaks the Perplexity Agent API (`POST /v1/agent`, with the
OpenAI-Responses-compatible alias `/v1/responses`) because Perplexity retires
the Sonar Chat Completions API on 27/09/2026. Model ids use the documented
`provider/model` form; the canonical pin `perplexity/kimi-k3` (Moonshot AI
Kimi K3) was chosen as the most capable reasoning model of that catalog whose
family is not already a peer — Claude, GPT, Gemini, Grok and DeepSeek are also
available there but would duplicate an existing peer. Legacy unprefixed Sonar
ids are rejected before any network call with `perplexity_model_unsupported`,
and the financial preflight reports
`CROSS_REVIEW_PERPLEXITY_MODEL_SONAR_RETIRED_USE_AGENT_API_ID`. The Sonar-only
cost dimensions (per-request fee by search context size, citation tokens, Deep
Research reasoning tokens) no longer exist in the rate cards; see
[docs/costs.md](costs.md).

Web search is a declared tool: the reviewer role sends
`tools: [{ type: "web_search", search_context_size }]` with the wire-enforced
`max_steps` bound (`CROSS_REVIEW_PERPLEXITY_MAX_STEPS`, default `1`); the
relator role (lottery) and the evidence judge never declare it. The tool is
billed per invocation (`usage.tool_calls_details`), so
`CROSS_REVIEW_PERPLEXITY_DISABLE_SEARCH=true` removes that cost dimension
entirely.

Perplexity does not document a zero-token model/auth endpoint. To avoid
accidental probe spend, `probe_peers` defaults to
`CROSS_REVIEW_PERPLEXITY_PROBE_MODE=auth_only`, which reports key presence and
the configured pin without a completion. Set the mode to `live` when you
explicitly want a minimal round-trip without tools.

## Thinking Configuration

Cross-review is optimized for correctness over latency and cost. Provider adapters explicitly request thinking/reasoning where the official APIs support it:

- OpenAI/Codex: `gpt-5.6-sol` through the Responses API. The API accepts
  `reasoning.effort=max`; cross-review accepts the Codex product/CLI term
  `ultra` only as a config compatibility alias and normalizes it to `max`
  before the request. The shared legacy `minimal` setting is normalized to
  GPT-5.6's lowest active API effort, `low`; it is never sent literally.
  Explicit model overrides are also family-aware: GPT-5.5/5.4/5.2 accept
  through `xhigh` (`minimal` → `low`, `max`/`ultra` → `xhigh`); GPT-5.1
  accepts through `high` (`minimal` → `low`, higher shared values → `high`);
  original GPT-5 accepts `minimal` through `high` (`none` → `minimal`, higher
  shared values → `high`).
- Anthropic/Claude: Fable 5 omits the explicit `thinking` object because
  adaptive thinking is automatic. Opus 5 uses explicit adaptive thinking with
  display omitted. Both use `output_config.effort` for depth.
- Google/Gemini: the configured shared effort maps to native `LOW`, `MEDIUM`,
  or `HIGH` thinking for Gemini 3.1 Pro Preview. The default remains `high`.
- DeepSeek: `thinking.type=enabled` with `reasoning_effort=max` by default;
  shared-scale `xhigh`, `max`, and `ultra` all normalize to `max`.
- Grok: the pinned `grok-4.6` model accepts explicit `reasoning.effort` at
  `low`, `medium`, `high`, or `xhigh` (default `xhigh`); shared `none`/`minimal`
  normalize to `low` and `max`/`ultra` to `xhigh`. The explicit `grok-4.5`
  override keeps its `low`/`medium`/`high` ceiling, and for the explicit
  `grok-4.20-multi-agent` compatibility override the provider enum is
  `low`/`medium`/`high`/`xhigh`: shared `none`/`minimal` normalize to `low`,
  while `max`/`ultra` normalize to `xhigh`.
- Perplexity: the Agent API request schema accepts `reasoning.effort` with the
  documented enum `minimal`/`low`/`medium`/`high`/`xhigh`/`max` (verified live
  with `perplexity/kimi-k3` at `max` on 23/08/2026). The default is `max`;
  `clampEffortForPerplexity` maps the shared scale onto that enum
  (`none` → `minimal`; `ultra` → `max`).

The alias is accepted consistently by central `config.json`, environment
variables and per-call overrides. It is never a provider payload value:
OpenAI GPT-5.6, Anthropic, DeepSeek and Perplexity (Kimi K3) receive `max`;
Grok 4.6 receives `xhigh`; Gemini maps the configured setting to its native
thinking enum.
When an operator explicitly selects an older GPT-5 family, the OpenAI adapter
uses that family's documented ceiling rather than blindly sending GPT-5.6's
enum.

## Per-peer output budgets

The legacy `max_output_tokens` value remains the fallback. Use
`max_output_tokens_by_peer` when official reasoning guidance or model ceilings
differ. The maintained central configuration uses 25,000 for GPT-5.6 Sol,
64,000 for Claude Fable 5 or Opus 5 at `xhigh`/`max`, and 20,000 for the other
four peers. These
values follow the official OpenAI allocation guidance and Anthropic task-budget
minimum without assuming an undocumented Grok 4.6 ceiling. `server_info`
returns the effective six-peer map used by both provider payloads and budget
preflight.

## Official provider references

- OpenAI: [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
  and [latest-model guide](https://developers.openai.com/api/docs/guides/latest-model).
- Anthropic: [Fable 5 introduction](https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5),
  [Opus 5 changes](https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5),
  [Opus 5 migration guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide),
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
- xAI: [models](https://docs.x.ai/developers/models),
  [reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning),
  [pricing](https://docs.x.ai/developers/pricing), plus
  [prompt-cache usage and pricing](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing).
- Perplexity: [Agent API models](https://docs.perplexity.ai/docs/agent-api/models),
  [OpenAI compatibility](https://docs.perplexity.ai/docs/agent-api/openai-compatibility),
  the [Agent API request schema](https://docs.perplexity.ai/api-reference/agent-post),
  [structured output](https://docs.perplexity.ai/docs/agent-api/building-agents/shape-output),
  and the [Sonar retirement notice](https://docs.perplexity.ai/docs/sonar/models/sonar-reasoning-pro)
  (supported until 27/09/2026).

## Historical Documentation Refresh — 05/05/2026

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
  discontinuation on 24/07/2026 and must stay out of current pins and
  downgrade chains.
- xAI Grok: historical Grok notes covered aliases and the earlier concrete
  `grok-4.3` and `grok-4.5` pins. Current runtime behavior is defined above by
  the `grok-4.6` pin and its `low`/`medium`/`high`/`xhigh` reasoning effort.
- Perplexity: `sonar-reasoning-pro` on the Sonar Chat Completions API was the
  v3.0.0–v4.5.x pin; that API retires on 27/09/2026 and current runtime
  behavior is defined above by the `perplexity/kimi-k3` pin on the Agent API.

## Important

The canonical pin per peer is intentionally code-level configuration, not hidden behavior. Provider model catalogs and deprecation schedules change often, so this file and `src/peers/model-selection.ts` must be reviewed against official provider documentation whenever a pin changes.

The redacted real-API capability smoke from the historical v2 line is recorded
in `docs/reports/cross-review-v2-api-capability-smoke-2026-04-30.md`. The
`cross-review-v2` filename is intentionally preserved as historical record; it
does not override the post-v4 product name.
