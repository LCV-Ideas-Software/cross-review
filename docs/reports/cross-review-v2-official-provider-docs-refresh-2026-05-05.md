# cross-review-v2 Official Provider Docs Refresh — 05/05/2026

Scope: official documentation check for the five cross-review-v2 peers before
the v2.16.0 protocol repair release.

## Sources Checked

- OpenAI — GPT-5.5 latest-model guide:
  https://developers.openai.com/api/docs/guides/latest-model
- OpenAI — model catalog:
  https://developers.openai.com/api/docs/models
- OpenAI — Responses API reasoning fields:
  https://developers.openai.com/api/reference/resources/responses
- Anthropic — Claude model overview:
  https://platform.claude.com/docs/en/about-claude/models/overview
- Anthropic — extended/adaptive thinking:
  https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- Google — Gemini models:
  https://ai.google.dev/gemini-api/docs/models
- Google — Gemini thinking:
  https://ai.google.dev/gemini-api/docs/thinking
- DeepSeek — API changelog:
  https://api-docs.deepseek.com/updates
- DeepSeek — reasoning model guide:
  https://api-docs.deepseek.com/guides/reasoning_model
- xAI — Grok reasoning:
  https://docs.x.ai/developers/model-capabilities/text/reasoning
- xAI — Grok multi-agent:
  https://docs.x.ai/developers/model-capabilities/text/multi-agent
- xAI — models and pricing / aliases:
  https://docs.x.ai/developers/models

## Findings Applied

- OpenAI: `gpt-5.5` remains the correct top Codex/OpenAI priority. Responses
  API reasoning effort through `xhigh` is still compatible with the adapter.
- Anthropic: `claude-opus-4-7` remains the strongest Claude default for complex
  reasoning and agentic coding. The adapter's adaptive-thinking path remains
  aligned with current docs.
- Gemini: `gemini-3.1-pro-preview` remains the correct advanced Gemini priority.
  `gemini-3-pro-preview` is deprecated/shut down and remains excluded.
- DeepSeek: `deepseek-v4-pro` and `deepseek-v4-flash` are the current V4 API
  models. Legacy `deepseek-chat` and `deepseek-reasoner` are scheduled for
  discontinuation on 24/07/2026 and remain excluded from priority fallbacks.
- Grok: `GROK_API_KEY` is canonical in this project. The xAI model catalog
  currently recommends `grok-4.3` for general Chat API use, while the reasoning
  docs identify `grok-4.20-multi-agent` as the only Grok model that accepts
  explicit `reasoning.effort`. Automatic-reasoning models such as
  `grok-4-latest`, `grok-4.3`, `grok-4.20`, and `grok-4.20-reasoning` must omit
  that field. The priority list preserves operator choice through
  `CROSS_REVIEW_GROK_MODEL` and keeps the explicit multi-agent model first for
  cross-review runs that require agent-count control.

## Code/Docs Changes

- Updated `src/peers/model-selection.ts` Grok priority list and docs URL.
- Clarified Grok model/effort behavior in `src/peers/grok.ts`,
  `src/core/config.ts`, `README.md`, and `docs/model-selection.md`.
- Added smoke coverage so the official-doc-backed priority list keeps current
  model IDs and excludes known deprecated/weak IDs.
