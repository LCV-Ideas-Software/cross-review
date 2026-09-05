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
not spend Perplexity completion tokens unless the operator explicitly sets
`CROSS_REVIEW_PERPLEXITY_PROBE_MODE=live`.

The server records token usage returned by providers. Paid review/generation tools are blocked until explicit budget ceilings and rate cards are configured. This avoids stale hard-coded prices because provider pricing changes frequently.

`CROSS_REVIEW_MAX_OUTPUT_TOKENS` remains the global fallback (default
`20000`). Central `config.json` can set `max_output_tokens_by_peer`, or an MCP
host can set `CROSS_REVIEW_<PROVIDER>_MAX_OUTPUT_TOKENS`. The effective map is
shown by `server_info` and is also used by cost preflight. A central-config
value must be a positive integer; zero, negative or malformed values reject the
file atomically and surface `CROSS_REVIEW_CONFIG_FILE_INVALID`. A rejected file
is ignored in full — every value in it (models, budgets, rate cards, cache,
evidence broker) falls back to env, registry or hardcoded defaults, not only
the offending field — so the server prints a boot notice with the diagnostic
and `server_info.config_load.parse_error` carries it until the file is fixed
and the MCP host restarted. Invalid env or registry overrides are ignored in
favor of the global fallback.

`session_report` and `session_doctor` distinguish total session cost from the
reviewer peer-call subtotal and the relator/lead generation subtotal. Historical
audits should compare like with like: summing `rounds[].peers[].cost.total_cost`
is peer-only, while `meta.totals.cost.total_cost` also includes generation
artifacts when present.

## Required Financial Configuration

Set rates through Windows environment variables or the MCP host configuration before running paid calls. Values are USD per million tokens. Use current official provider pricing; this project intentionally does not ship default provider prices.

Current reference values verified against official provider documentation on
23/08/2026 for the maintained model pins and supported Claude Opus 5 override:

| Provider/model                  | Input  | Output | Cached input / cache hit | Extended tier                                                                                                                                             |
| ------------------------------- | ------ | ------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI `gpt-5.6-sol`            | `4`    | `20`   | `0.4`                    | `>272000`: input `8`, output `30`, cached input `0.8` (promotional pricing at least through 21/11/2026; list rates `5`/`30`, `10`/`45`, cached `0.5`/`1`) |
| Anthropic `claude-fable-5`      | `10`   | `50`   | `1`                      | none                                                                                                                                                      |
| Anthropic `claude-opus-5`       | `5`    | `25`   | `0.5`                    | none                                                                                                                                                      |
| Gemini `gemini-3.1-pro-preview` | `2`    | `12`   | `0.2`                    | `>200000` input tokens: input `4`, output `18`, cached input `0.4`                                                                                        |
| DeepSeek `deepseek-v4-pro`      | `1.32` | `3.96` | `0.044`                  | none (peak rates effective 16/08/2026; the official off-peak window is 50% lower)                                                                         |
| xAI `grok-4.6`                  | `2`    | `6`    | `0.5`                    | `>200000`: input `4`, output `12`, cached input `1`                                                                                                       |
| Perplexity `perplexity/kimi-k3` | `3`    | `15`   | `0.3`                    | `web_search` tool: `2.5` per 1000 invocations (`search_queries_per_1000`)                                                                                 |

GPT-5.6 Sol reports cache-write tokens separately. Configure OpenAI cache write
at 1.25 times the corresponding uncached input rate: `5` USD/million in the
base tier and `10` above the 272K threshold while the promotional input rates
apply (`6.25`/`12.5` at the list rates). Model the promotion with the
`promo_*` fields and `promo_expires_at_utc` so the card falls back to the list
rates automatically. Grok 4.6 exposes cached-input pricing but no distinct
cache-write counter, so do not infer a write charge from uncached input tokens.

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
- Anthropic: [models overview](https://platform.claude.com/docs/en/about-claude/models/overview),
  [Opus 5 changes](https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5)
  and [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
- Google: [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing).
- DeepSeek: [models and pricing](https://api-docs.deepseek.com/quick_start/pricing/).
- xAI: [models](https://docs.x.ai/developers/models),
  [pricing](https://docs.x.ai/developers/pricing) and
  [prompt-cache usage and pricing](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing).
- Perplexity: [Agent API models and pricing](https://docs.perplexity.ai/docs/agent-api/models)
  and the [Agent API request schema](https://docs.perplexity.ai/api-reference/agent-post)
  (usage `cost` and `tool_calls_details`).

Anthropic cache-write rates are separate from cache-hit rates. With the
workspace's default `1h` TTL, configure cache write as `20` for Fable 5 and
`10` for Opus 5. If you deliberately switch to `5m`, the corresponding values
are `12.5` and `6.25`.

Perplexity Agent API requests pay the `web_search` tool per invocation
reported in `usage.tool_calls_details`; the adapter surfaces that count as
`num_search_queries` and bills it at `search_queries_per_1000`, which is
required while search is enabled. The relator role never declares the tool and
`CROSS_REVIEW_PERPLEXITY_DISABLE_SEARCH=true` removes the dimension entirely.
The API exposes no provider-enforced cap on invocations (the request reference
documents `max_steps` and the per-call `max_results` only; `max_tool_calls`,
`parallel_tool_calls` and `tool_choice` are absent, and a live probe on
24/08/2026 returned three searches for a single step regardless of
`parallel_tool_calls`). The round preflight therefore prices
`CROSS_REVIEW_PERPLEXITY_WEB_SEARCH_INVOCATIONS_ESTIMATE` (positive integer,
default `3`, the count observed with `max_steps=1`) per reviewer request as a
declared estimate, not a hard bound, while post-call accounting uses the exact
reported count. `CROSS_REVIEW_PERPLEXITY_SEARCH_PREFLIGHT_POLICY` selects how a
hard-budget session treats that residual: `estimate` (default) accepts it;
`fail_closed` reports `CROSS_REVIEW_PERPLEXITY_WEB_SEARCH_PREFLIGHT_UNBOUNDED`
whenever Perplexity can review with search enabled, so paid rounds refuse to
start until search is disabled. The `perplexity/kimi-k3` card (`3` input, `15`
output, `0.30` cached input per million) and the `web_search` fee of `0.0025`
per invocation (`2.5` per 1000) were re-verified on 04/09/2026 against the
[Agent API models page](https://docs.perplexity.ai/docs/agent-api/models).
`CROSS_REVIEW_PERPLEXITY_SEARCH_CONTEXT_SIZE` still shapes the `web_search`
tool but no longer selects any fee tier: the legacy Sonar cost dimensions
(per-request fee by context size, citation tokens, Deep Research reasoning
tokens) were removed in CROSREV-19 (#233) because the runtime has dispatched
no Sonar id since v4.6.0.

Central `config.json` supports model-aware rate cards through
`model_cost_rates`. This is the preferred shape when explicit operator
overrides can select models with different prices:

```json
{
  "models": {
    "codex": "gpt-5.6-sol",
    "claude": "claude-fable-5",
    "grok": "grok-4.6",
    "perplexity": "perplexity/kimi-k3"
  },
  "model_cost_rates": {
    "claude": {
      "claude-opus-5": {
        "input_per_million": 5,
        "output_per_million": 25,
        "cache_read_per_million": 0.5,
        "cache_write_per_million": 10
      },
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
      "grok-4.6": {
        "input_per_million": 2,
        "output_per_million": 6,
        "cache_read_per_million": 0.5,
        "threshold_tokens": 200000,
        "input_extended_per_million": 4,
        "output_extended_per_million": 12,
        "cache_read_extended_per_million": 1
      }
    },
    "perplexity": {
      "perplexity/kimi-k3": {
        "input_per_million": 3,
        "output_per_million": 15,
        "cache_read_per_million": 0.3,
        "search_queries_per_1000": 2.5
      }
    }
  }
}
```

If both `cost_rates.<peer>` and `model_cost_rates.<peer>` are present, the
model-specific entry for the configured peer model wins. Process environment
and Windows registry rate variables still have higher precedence than the file.

A central config card for a retired Sonar id, or any card carrying one of the
removed keys (`request_fee_low_per_1000`, `request_fee_medium_per_1000`,
`request_fee_high_per_1000`, `citation_tokens_per_million`,
`deep_research_reasoning_tokens_per_million`), is rejected by the strict
schema: the boot notice and `server_info.config_load.parse_error` read
`schema_validation_failed` with an `unrecognized_keys` issue naming the key and
the card path (for example `model_cost_rates` › `perplexity` ›
`sonar-reasoning-pro`), the whole file is ignored, and paid calls stay blocked
with `CROSS_REVIEW_CONFIG_FILE_INVALID` until the card is deleted and the MCP
host restarted.

Accounting always resolves the model actually sent by the adapter, including
explicit overrides and fallbacks. A non-primary effective model must match a
retained model card (exact Perplexity model ids; documented family matching
for other providers, selecting the longest matching prefix). If no applicable
card exists, preflight and fallback fail closed with `unknown-rate`; the
runtime never borrows the primary model's price. Agent API cards must include
the web-search fee while search is enabled, whether primary or fallback; a
retired Sonar id as primary or fallback fails closed with
`CROSS_REVIEW_PERPLEXITY_MODEL_SONAR_RETIRED_USE_AGENT_API_ID` before anything
is priced. Aggregated usage preserves the search dimension and provider totals
across every billed attempt.

Round preflight prices the complete reachable call graph: all configured retry
attempts for the primary and each declared fallback, followed by the most
expensive possible format-recovery envelope. It also compares the distinct
input-moderation path (an initial envelope ending in prompt rejection, plus
compact-prompt and format-recovery envelopes) and uses the larger estimate.
Each of those three envelopes
uses `max_attempts`, because prompt blocking may follow earlier transient
failures. Recovery-local gates price only the adapter call they are about to
dispatch.

`search_queries_per_1000` is the only non-token Perplexity dimension and
applies to Agent API web-search invocations. The cost engine checks the active
model identity so a card cannot bill a dimension the model does not have.

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
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_CACHE_READ_USD_PER_MILLION", "<current Perplexity cached-input rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_SEARCH_QUERIES_USD_PER_1000_REQUESTS", "<Perplexity web_search fee per 1000 invocations>", "User")
```

`CROSS_REVIEW_MAX_SESSION_COST_USD` sets the default per-session budget guard. `CROSS_REVIEW_PREFLIGHT_MAX_ROUND_COST_USD` blocks a round before calls begin when the estimated cost exceeds the configured value. `CROSS_REVIEW_UNTIL_STOPPED_MAX_COST_USD` is required for `until_stopped=true`.

When the estimated session cost exceeds the configured limit, the run is
finalized as `max-rounds` with reason `budget_exceeded`. Missing financial
configuration finalizes the session as `max-rounds` with reason
`financial_controls_missing` before any paid provider call is made.
