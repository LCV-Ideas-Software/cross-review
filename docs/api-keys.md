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

## Optional Model Overrides

Use overrides only when you intentionally want to pin a model rather than use automatic best-model selection.

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_MODEL", "gpt-5.5", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_REASONING_EFFORT", "xhigh", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_MODEL", "claude-opus-4-8", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_REASONING_EFFORT", "xhigh", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GEMINI_MODEL", "gemini-3.1-pro-preview", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_MODEL", "deepseek-v4-pro", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_REASONING_EFFORT", "max", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_MODEL", "grok-4.3", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_MODEL", "sonar-reasoning-pro", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_REASONING_EFFORT", "high", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_SEARCH_CONTEXT_SIZE", "low", "User")
```

To opt into Claude Fable 5 for the `claude` peer, replace the Anthropic model
override with:

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_MODEL", "claude-fable-5", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_INPUT_USD_PER_MILLION", "10", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_OUTPUT_USD_PER_MILLION", "50", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_CACHE_READ_USD_PER_MILLION", "1", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_CACHE_WRITE_USD_PER_MILLION", "20", "User")
```

When using the central `config.json`, prefer storing both Claude families under
`model_cost_rates.claude` instead of changing the Anthropic rate env vars by
hand. The runtime chooses the active rate card from the configured Claude
model, after honoring any explicit env/registry model override.

Fable 5 is generally available on the Claude API, but it can return successful
responses with `stop_reason="refusal"`. The runtime records those as
`provider_refusal` unless you configure an explicit Anthropic fallback chain.
Anthropic also documents Fable 5 as a 30-day-retention model with no zero data
retention option, so enable it only when that data posture is acceptable.

## Safety

- Do not create `.env` files containing real secrets.
- Do not paste keys into prompts, issues, logs, screenshots or README files.
- If a key is accidentally committed, revoke it immediately and rotate it at the provider.
