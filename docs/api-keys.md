# API Keys

All runtime credentials must come from Windows environment variables.

## Required Variables

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "<OPENAI_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "<ANTHROPIC_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "<GEMINI_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "<DEEPSEEK_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("GROK_API_KEY", "<GROK_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("PERPLEXITY_API_KEY", "<PERPLEXITY_API_KEY>", "User")
```

Restart any terminal, editor, app or MCP host after changing these variables.

## Cross-review caller capabilities

`host-tokens.json` contains seven local caller capabilities: six peer tokens
and a distinct `operator` token. Put each peer token only in its matching MCP
host as `CROSS_REVIEW_CALLER_TOKEN`. The operator token is mandatory for
evidence attachment, judge/checklist mutation, finalization, sweep and token
rotation; keep it only in a dedicated human-console host. Never put it in a
model host. Legacy six-token files are migrated in place without rotating the
existing peer tokens.

DeepSeek, Grok and Perplexity do not need separate local MCP caller hosts merely
to participate as outbound review adapters; their provider API keys are enough.
Distribute a peer capability token only when a local MCP client actually acts
under that peer identity. Cancellation and verdict contestation additionally
require the persisted petitioner's peer token (or the operator token).

## Optional Model Overrides

Use overrides only when you intentionally want to deviate from the canonical
no-fallback pins.

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_MODEL", "gpt-5.6-sol", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_REASONING_EFFORT", "max", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_MODEL", "claude-fable-5", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_REASONING_EFFORT", "max", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GEMINI_MODEL", "gemini-3.1-pro-preview", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_MODEL", "deepseek-v4-pro", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_REASONING_EFFORT", "max", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_MODEL", "grok-4.5", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_REASONING_EFFORT", "high", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_MODEL", "sonar-reasoning-pro", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_REASONING_EFFORT", "high", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_SEARCH_CONTEXT_SIZE", "low", "User")
```

The canonical Claude Fable 5 rate variables are:

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_MODEL", "claude-fable-5", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_INPUT_USD_PER_MILLION", "10", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_OUTPUT_USD_PER_MILLION", "50", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_CACHE_READ_USD_PER_MILLION", "1", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_CACHE_WRITE_USD_PER_MILLION", "20", "User")
```

When using central `config.json`, prefer a model-keyed entry under
`model_cost_rates.claude` instead of changing Anthropic rate variables by hand.
The runtime chooses the active rate card after honoring any explicit
environment/registry model override.

Fable 5 can return successful responses with `stop_reason="refusal"`. The
runtime records those as `provider_refusal` and discards partial refusal output.
Anthropic does not charge a refusal that occurs before output, even when the
response reports input usage; a mid-stream refusal is billable for input and
generated output, and the ledger distinguishes the two cases.
Its request omits the explicit `thinking` field because adaptive thinking is
automatic. Anthropic documents Fable 5 as a 30-day-retention model with no zero
data retention option, so enable it only when that posture is acceptable.

`ultra` is a Codex product/CLI mode, not a literal OpenAI Responses API
`reasoning.effort`. Cross-review accepts `reasoning_effort.codex="ultra"` as a
compatibility alias so an otherwise valid central config is not rejected
atomically, and the OpenAI adapter sends the official `max` value to
`gpt-5.6-sol`. The other adapters likewise clamp the alias to their strongest
documented value; no provider receives the string `ultra` on the wire.
Explicit older OpenAI overrides are normalized by family as well: GPT-5.5,
5.4 and 5.2 cap at `xhigh`; GPT-5.1 and original GPT-5 cap at `high`, with
`minimal`/`none` translated where those literals are unsupported.

Environment variables and central `config.json` are snapshotted at MCP process
startup. After changing either source, reload/restart the editor or MCP host and
confirm `server_info.config_load.reload_required=false`. The same object exposes
the loaded/current file hashes and any parse error without revealing secrets.

## Safety

- Do not create `.env` files containing real secrets.
- Do not paste keys into prompts, issues, logs, screenshots or README files.
- If a key is accidentally committed, revoke it immediately and rotate it at the provider.
