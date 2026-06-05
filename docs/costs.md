# Costs

Runtime calls are real provider API calls by default.

## Smoke Tests

`npm test` uses `CROSS_REVIEW_STUB=1` and does not call provider APIs.

## Real Runs

`probe_peers`, `session_init`, `ask_peers` and `run_until_unanimous` may call provider APIs when keys are present.

The server records token usage returned by providers. Paid review/generation tools are blocked until explicit budget ceilings and rate cards are configured. This avoids stale hard-coded prices because provider pricing changes frequently.

`CROSS_REVIEW_MAX_OUTPUT_TOKENS` controls the maximum output budget requested from all providers. The default is `20000`; raise or lower it in the MCP host configuration according to the desired quality/cost tradeoff. Invalid, zero or negative values fall back to the default.

`session_report` and `session_doctor` distinguish total session cost from the
reviewer peer-call subtotal and the relator/lead generation subtotal. Historical
audits should compare like with like: summing `rounds[].peers[].cost.total_cost`
is peer-only, while `meta.totals.cost.total_cost` also includes generation
artifacts when present.

## Required Financial Configuration

Set rates through Windows environment variables or the MCP host configuration before running paid calls. Values are USD per million tokens. Use current official provider pricing; this project intentionally does not ship default provider prices.

Current reference values verified on 2026-06-03 for the maintained model pins:

| Provider/model                   | Input   | Output | Cached input / cache hit | Extended tier                                                      |
| -------------------------------- | ------- | ------ | ------------------------ | ------------------------------------------------------------------ |
| OpenAI `gpt-5.5`                 | `5`     | `30`   | `0.5`                    | `>272000` input tokens: input `10`, output `45`                    |
| Anthropic `claude-opus-4-8`      | `5`     | `25`   | `0.5`                    | none                                                               |
| Gemini `gemini-3.1-pro-preview`  | `2`     | `12`   | `0.2`                    | `>200000` input tokens: input `4`, output `18`, cached input `0.4` |
| DeepSeek `deepseek-v4-pro`       | `0.435` | `0.87` | `0.003625`               | none                                                               |
| xAI `grok-4.3`                   | `1.25`  | `2.5`  | `0.2`                    | none                                                               |
| Perplexity `sonar-reasoning-pro` | `2`     | `8`    | n/a                      | request fee: low `6`, medium `10`, high `14` per 1000 requests     |

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
