# Costs

Runtime calls are real provider API calls by default.

## Smoke Tests

`npm test` is safe to run locally: the repository smokes that exercise peer
review paths set `CROSS_REVIEW_STUB=1` with explicit confirmation, while
metadata/runtime smokes avoid provider calls. The test command must not spend
provider API budget.

## Real Runs

`session_init`, `ask_peers` and `run_until_unanimous` may call provider APIs
when keys are present. `probe_peers` may call provider metadata APIs; Perplexity
defaults to `CROSS_REVIEW_PERPLEXITY_PROBE_MODE=auth_only` so the probe does
not spend Sonar completion tokens unless the operator explicitly sets
`CROSS_REVIEW_PERPLEXITY_PROBE_MODE=live`.

The server records token usage returned by providers. Paid review/generation tools are blocked until explicit budget ceilings and rate cards are configured. This avoids stale hard-coded prices because provider pricing changes frequently.

`CROSS_REVIEW_MAX_OUTPUT_TOKENS` remains the global fallback (default
`20000`). Central `config.json` can set `max_output_tokens_by_peer`, or an MCP
host can set `CROSS_REVIEW_<PROVIDER>_MAX_OUTPUT_TOKENS`. The effective map is
shown by `server_info` and is also used by cost preflight. A central-config
value must be a positive integer; zero, negative or malformed values reject the
file atomically and surface `CROSS_REVIEW_CONFIG_FILE_INVALID`. Invalid env or
registry overrides are ignored in favor of the global fallback.

`session_report` and `session_doctor` distinguish total session cost from the
reviewer peer-call subtotal and the relator/lead generation subtotal. Historical
audits should compare like with like: summing `rounds[].peers[].cost.total_cost`
is peer-only, while `meta.totals.cost.total_cost` also includes generation
artifacts when present.

## Required Financial Configuration

Set rates through Windows environment variables or the MCP host configuration before running paid calls. Values are USD per million tokens. Use current official provider pricing; this project intentionally does not ship default provider prices.

Current reference values verified against official provider documentation on
2026-07-17 for the maintained model pins:

| Provider/model                   | Input   | Output | Cached input / cache hit | Extended tier                                                      |
| -------------------------------- | ------- | ------ | ------------------------ | ------------------------------------------------------------------ |
| OpenAI `gpt-5.6-sol`             | `5`     | `30`   | `0.5`                    | `>272000`: input `10`, output `45`, cached input `1`               |
| Anthropic `claude-fable-5`       | `10`    | `50`   | `1`                      | none                                                               |
| Gemini `gemini-3.1-pro-preview`  | `2`     | `12`   | `0.2`                    | `>200000` input tokens: input `4`, output `18`, cached input `0.4` |
| DeepSeek `deepseek-v4-pro`       | `0.435` | `0.87` | `0.003625`               | none                                                               |
| xAI `grok-4.5`                   | `2`     | `6`    | `0.5`                    | `>200000`: input `4`, output `12`, cached input `1`                |
| Perplexity `sonar-reasoning-pro` | `2`     | `8`    | n/a                      | request fee: low `6`, medium `10`, high `14` per 1000 requests     |

GPT-5.6 Sol reports cache-write tokens separately. Configure OpenAI cache write
at `6.25` USD/million in the base tier and `12.5` above the 272K threshold;
these are 1.25 times the corresponding uncached input rates. Grok 4.5 exposes
cached-input pricing but no distinct cache-write counter, so do not infer a
write charge from uncached input tokens.

OpenAI requests explicitly pin `service_tier: "default"`. This prevents a
project-level Priority processing setting from silently changing the service
tier and price basis, so the OpenAI rate cards configured here must use the
official Standard/default rates. The response's actual `service_tier` remains
provider telemetry; it does not authorize substituting a different price table
without matching configured rates.

Gemini's published output rate includes both visible candidate tokens and
thinking tokens. The runtime therefore adds `thoughtsTokenCount` to the
billable output bucket while preserving it separately as reasoning telemetry.
Gemini explicit-cache storage is priced per token-hour and is not represented
as `cache_write_per_million`; the implicit-cache adapter records cache reads
only.

Official pricing sources:

- OpenAI: [API pricing](https://developers.openai.com/api/docs/pricing),
  [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) and
  [Priority processing](https://developers.openai.com/api/docs/guides/priority-processing#configuring-priority-processing).
- Anthropic: [Fable 5 model, retention and base pricing](https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5)
  and [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
- Google: [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing).
- DeepSeek: [models and pricing](https://api-docs.deepseek.com/quick_start/pricing/).
- xAI: [Grok 4.5](https://docs.x.ai/developers/models/grok-4.5),
  [pricing](https://docs.x.ai/developers/pricing) and
  [prompt-cache usage and pricing](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing).
- Perplexity: [Sonar Reasoning Pro](https://docs.perplexity.ai/docs/sonar/models/sonar-reasoning-pro)
  and [Sonar API pricing](https://docs.perplexity.ai/docs/getting-started/pricing).

Anthropic cache-write rates are separate from cache-hit rates. For
`claude-fable-5`, configure `CROSS_REVIEW_ANTHROPIC_CACHE_WRITE_USD_PER_MILLION`
as `20` when using the workspace's default Anthropic `1h` cache TTL, or `12.5`
if you deliberately switch Anthropic cache TTL to `5m`.

The configured Perplexity request fee is charged in cross-review's accounting
for every Sonar request, including calls with `disable_search=true`. Disabling
search is not treated as a zero-cost request.

Central `config.json` supports model-aware rate cards through
`model_cost_rates`. This is the preferred shape when explicit operator
overrides can select models with different prices:

```json
{
  "models": {
    "codex": "gpt-5.6-sol",
    "claude": "claude-fable-5",
    "grok": "grok-4.5"
  },
  "model_cost_rates": {
    "claude": {
      "claude-fable-5": {
        "input_per_million": 10,
        "output_per_million": 50,
        "cache_read_per_million": 1,
        "cache_write_per_million": 20
      }
    },
    "codex": {
      "gpt-5.6-sol": {
        "input_per_million": 5,
        "output_per_million": 30,
        "cache_read_per_million": 0.5,
        "cache_write_per_million": 6.25,
        "threshold_tokens": 272000,
        "input_extended_per_million": 10,
        "output_extended_per_million": 45,
        "cache_read_extended_per_million": 1,
        "cache_write_extended_per_million": 12.5
      }
    },
    "grok": {
      "grok-4.5": {
        "input_per_million": 2,
        "output_per_million": 6,
        "cache_read_per_million": 0.5,
        "threshold_tokens": 200000,
        "input_extended_per_million": 4,
        "output_extended_per_million": 12,
        "cache_read_extended_per_million": 1
      }
    }
  }
}
```

If both `cost_rates.<peer>` and `model_cost_rates.<peer>` are present, the
model-specific entry for the configured peer model wins. Process environment
and Windows registry rate variables still have higher precedence than the file.

Accounting always resolves the model actually sent by the adapter, including
explicit overrides and fallbacks. A non-primary effective model must match a
retained model card (exact Sonar product IDs; documented family matching for
other providers, selecting the longest matching prefix). If no applicable card
exists, preflight and fallback fail closed with `unknown-rate`; the runtime
never borrows the primary model's price. Regular Sonar cards must include the
active context-tier request fee, and Deep Research cards must include citation,
reasoning and search-query dimensions, whether primary or fallback. Aggregated
usage preserves those dimensions and provider totals across every billed
attempt.

`sonar-deep-research` is account-able after a response but not hard-budgetable
before dispatch: the official API exposes no caller-controlled ceiling for
citation tokens, separate reasoning tokens or search-query count. Therefore a
Deep Research primary/fallback returns
`CROSS_REVIEW_PERPLEXITY_DEEP_RESEARCH_PREFLIGHT_UNBOUNDED` and the paid
orchestrator fails closed. Its retained card remains useful for exact post-call
audit data and offline adapter regressions; it is not presented as a guaranteed
preflight.

Round preflight prices the complete reachable call graph: all configured retry
attempts for the primary and each declared fallback, followed by the most
expensive possible format-recovery envelope. It also compares the distinct
input-moderation path (an initial envelope ending in prompt rejection, plus
compact-prompt and format-recovery envelopes) and uses the larger estimate.
Each of those three envelopes
uses `max_attempts`, because prompt blocking may follow earlier transient
failures. Recovery-local gates price only the adapter call they are about to
dispatch.

Perplexity citation-token, separate reasoning-token and search-query rates are
exclusive to `sonar-deep-research`. Keep them only in that model's rate card;
the cost engine also checks the active model identity so stale keys cannot
overcharge `sonar-reasoning-pro`.

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_MAX_SESSION_COST_USD", "20", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PREFLIGHT_MAX_ROUND_COST_USD", "20", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_UNTIL_STOPPED_MAX_COST_USD", "20", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_INPUT_USD_PER_MILLION", "<current OpenAI input rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_OUTPUT_USD_PER_MILLION", "<current OpenAI output rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_INPUT_USD_PER_MILLION", "<current Anthropic input rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_OUTPUT_USD_PER_MILLION", "<current Anthropic output rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GEMINI_INPUT_USD_PER_MILLION", "<current Gemini input rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GEMINI_OUTPUT_USD_PER_MILLION", "<current Gemini output rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_INPUT_USD_PER_MILLION", "<current DeepSeek input rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_OUTPUT_USD_PER_MILLION", "<current DeepSeek output rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_INPUT_USD_PER_MILLION", "<current Grok input rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_OUTPUT_USD_PER_MILLION", "<current Grok output rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_INPUT_USD_PER_MILLION", "<current Perplexity input rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_OUTPUT_USD_PER_MILLION", "<current Perplexity output rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_LOW_USD_PER_1000_REQUESTS", "<Perplexity per-1000-requests low-context fee>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_MEDIUM_USD_PER_1000_REQUESTS", "<Perplexity per-1000-requests medium-context fee>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_HIGH_USD_PER_1000_REQUESTS", "<Perplexity per-1000-requests high-context fee>", "User")
```

`CROSS_REVIEW_MAX_SESSION_COST_USD` sets the default per-session budget guard. `CROSS_REVIEW_PREFLIGHT_MAX_ROUND_COST_USD` blocks a round before calls begin when the estimated cost exceeds the configured value. `CROSS_REVIEW_UNTIL_STOPPED_MAX_COST_USD` is required for `until_stopped=true`.

When the estimated session cost exceeds the configured limit, the run is
finalized as `max-rounds` with reason `budget_exceeded`. Missing financial
configuration finalizes the session as `max-rounds` with reason
`financial_controls_missing` before any paid provider call is made.
