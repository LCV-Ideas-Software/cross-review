# Costs

Runtime calls are real provider API calls by default.

## Smoke Tests

`npm test` uses `CROSS_REVIEW_STUB=1` and does not call provider APIs.

## Real Runs

`probe_peers`, `session_init`, `ask_peers` and `run_until_unanimous` may call provider APIs when keys are present.

The server records token usage returned by providers. Paid review/generation tools are blocked until explicit budget ceilings and rate cards are configured. This avoids stale hard-coded prices because provider pricing changes frequently.

`CROSS_REVIEW_MAX_OUTPUT_TOKENS` controls the maximum output budget requested from all providers. The default is `20000`; raise or lower it in the MCP host configuration according to the desired quality/cost tradeoff. Invalid, zero or negative values fall back to the default.

## Required Financial Configuration

Set rates through Windows environment variables or the MCP host configuration before running paid calls. Values are USD per million tokens. Use current official provider pricing; this project intentionally does not ship default provider prices.

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
```

`CROSS_REVIEW_MAX_SESSION_COST_USD` sets the default per-session budget guard. `CROSS_REVIEW_PREFLIGHT_MAX_ROUND_COST_USD` blocks a round before calls begin when the estimated cost exceeds the configured value. `CROSS_REVIEW_UNTIL_STOPPED_MAX_COST_USD` is required for `until_stopped=true`.

When the estimated session cost exceeds the configured limit, the run is
finalized as `max-rounds` with reason `budget_exceeded`. Missing financial
configuration finalizes the session as `max-rounds` with reason
`financial_controls_missing` before any paid provider call is made.
