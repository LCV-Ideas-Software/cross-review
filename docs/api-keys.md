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

`host-tokens.json` contains six local caller capabilities, one per peer. Put
each token only in its matching MCP host as `CROSS_REVIEW_CALLER_TOKEN`. A
seventh capability existed for an `operator` identity whose token was meant to
live in a separate human console; that host does not exist — the whole surface
is MCP, exercised by agents — so the capability bound a secret to nobody and is
gone, together with the tools that demanded it. Routine AI evidence needs no
token beyond the peer's own: the authenticated peer sends raw proof in
the `evidence` field of a review starter, and the runtime persists it
automatically as `caller_submitted_unverified`. A record written before v07.00.00 carries the
seventh token; loading it rewrites the file without that entry and leaves every
peer token untouched.

The runtime refuses an insecure token file: POSIX permissions must remain
owner-only (`0600`), and Windows inheritance is removed so only the current
user, SYSTEM and Administrators retain access. This protects against inherited
model-sandbox ACLs; hosts that run unrestricted under the same OS identity still
require OS-level isolation or a secret vault.

DeepSeek, Grok and Perplexity do not need separate local MCP caller hosts merely
to participate as outbound review adapters; their provider API keys are enough.
Distribute a peer capability token only when a local MCP client actually acts
under that peer identity. Cancellation, verdict contestation and closing your
own non-terminal session (`session_finalize` as `aborted`) additionally require
the persisted petitioner's peer token.

## Optional Model Overrides

Use overrides only when you intentionally want to deviate from the canonical
no-fallback pins.

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_MODEL", "gpt-6-astra", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_REASONING_EFFORT", "max", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_MODEL", "claude-fable-5-1", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_REASONING_EFFORT", "max", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GEMINI_MODEL", "gemini-3.1-pro-preview", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GEMINI_REASONING_EFFORT", "high", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_MODEL", "deepseek-v4-pro", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_REASONING_EFFORT", "max", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_MODEL", "grok-4.6", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_REASONING_EFFORT", "xhigh", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_MODEL", "perplexity/kimi-k3", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_REASONING_EFFORT", "max", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_SEARCH_CONTEXT_SIZE", "low", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_MAX_STEPS", "1", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_SEARCH_PREFLIGHT_POLICY", "estimate", "User")
```

Provider-specific output ceilings can coexist with the legacy global fallback:

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_MAX_OUTPUT_TOKENS", "128000", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_MAX_OUTPUT_TOKENS", "128000", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GEMINI_MAX_OUTPUT_TOKENS", "20000", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_MAX_OUTPUT_TOKENS", "20000", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_MAX_OUTPUT_TOKENS", "20000", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_MAX_OUTPUT_TOKENS", "20000", "User")
```

The equivalent central-config key is `max_output_tokens_by_peer`. Each value
above is the provider's documented synchronous output maximum for the pinned
model: 128,000 for GPT-6 Astra and for Claude Fable 5.1, 20,000 for the other
four. `server_info` reports the effective value for all six peers.

These ceilings are not cosmetic. The relator seat has to re-emit the artifact
inside its own ceiling, so `max_output_tokens_by_peer` decides which peers are
eligible to be drawn as relator for a given draft; lowering a value here can
make a large draft unroutable rather than merely slower.

The canonical Claude Fable 5.1 rate variables are:

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_MODEL", "claude-fable-5-1", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_INPUT_USD_PER_MILLION", "10", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_OUTPUT_USD_PER_MILLION", "50", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_CACHE_READ_USD_PER_MILLION", "0.25", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_CACHE_WRITE_USD_PER_MILLION", "20", "User")
```

There is no second supported model to opt into. cross-review runs the top model
of each provider, so the canonical pin is the whole admissible set.
`CROSS_REVIEW_<PROVIDER>_MODEL` still overrides it — it is your lever, outside
the MCP surface — but a non-flagship pin is reported with
`confidence: "inferred"` rather than `"verified"`, and it needs its own rate
card, because a card is matched by model id and a missing one blocks paid calls.

When using central `config.json`, prefer a model-keyed entry under
`model_cost_rates.claude` instead of changing Anthropic rate variables by hand.
The runtime chooses the active rate card after honoring any explicit
environment/registry model override.

Fable 5.1 can return successful responses with
`stop_reason="refusal"`. The runtime records those as `provider_refusal` and
discards partial refusal output.
Anthropic does not charge a refusal that occurs before output, even when the
response reports input usage; a mid-stream refusal is billable for input and
generated output, and the ledger distinguishes the two cases.
Fable's request omits the explicit `thinking` field because adaptive thinking
is automatic.
Anthropic documents Fable 5 as a 30-day-retention model with no zero data
retention option, so enable it only when that posture is acceptable.

`ultra` is a Codex product/CLI mode, not a literal OpenAI Responses API
`reasoning.effort`. Cross-review accepts `reasoning_effort.codex="ultra"` as a
compatibility alias so an otherwise valid central config is not rejected
atomically, and the OpenAI adapter sends the official `max` value to
`gpt-6-astra`. The other adapters likewise clamp the alias to their strongest
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
