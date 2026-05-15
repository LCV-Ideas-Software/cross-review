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

## Current Priority Lists

OpenAI/Codex:

```text
gpt-5.5 > gpt-5.4 > gpt-5.2 > gpt-5.1-codex-max > gpt-5.1-codex > gpt-5.1 > gpt-5-pro > gpt-5
```

Anthropic/Claude:

```text
claude-opus-4-7 > claude-opus-4-6 > claude-sonnet-4-6
```

Haiku is intentionally excluded because the cross-review role requires advanced reasoning depth.

Google/Gemini:

```text
gemini-2.5-pro > gemini-3.1-pro-preview
```

Operator preference 2026-05-07: `gemini-2.5-pro` is the runtime default because under Google One AI Ultra subscription it carries 1k requests/day vs `gemini-3.1-pro-preview`'s 250 requests/day; `gemini-3.1-pro-preview` remains in the priority list as a fallback. Workspace policy (operator directive 2026-05-07): only `gemini-*-pro` variants ≥ 2.5 are permitted — no `*-flash` variants and no models below 2.5 (those are deprecated). `gemini-3-pro-preview` is intentionally excluded from the active fallback path because preview model deprecation is tracked through official Gemini release notes and this project avoids soon-to-deprecate intermediate previews when a newer advanced model is available.

DeepSeek:

```text
deepseek-v4-pro > deepseek-v4-flash
```

`deepseek-chat` and `deepseek-reasoner` are not active fallbacks because DeepSeek has announced their deprecation for 2026-07-24. `deepseek-v4-pro` is the preferred thinking-capable model for this project.

xAI/Grok:

```text
grok-4.20-multi-agent > grok-4-latest > grok-4.3 > grok-4.20-reasoning > grok-4.20 > grok-4-1-fast > grok-4 > grok-3-fast > grok-3
```

`GROK_API_KEY` is the canonical auth variable. The operator chooses the model
with `CROSS_REVIEW_GROK_MODEL`. Per official xAI reasoning docs, only
`grok-4.20-multi-agent` accepts an explicit `reasoning.effort` request body
field, where the value selects agent count (`low`/`medium` = 4 agents,
`high`/`xhigh` = 16 agents). Automatic-reasoning Grok models such as
`grok-4-latest`, `grok-4.20`, and `grok-4.20-reasoning` must not receive that
field; the adapter detects the configured model and omits it automatically.
The xAI model catalog currently recommends `grok-4.3` for general Chat API
usage; the multi-agent model remains first in this project because it is the
only documented Grok model with explicit agent-count control.

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
