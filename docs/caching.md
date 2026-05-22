# Prompt Caching (v2.21.0+)

`cross-review` integrates with the prompt-caching surface of every supported provider. The runtime emits a uniform `provider.cache.usage` event and persists a per-session `cache_manifest.json` so dashboards, FinOps reports and post-mortem tooling can read cache telemetry without branching on provider-specific shapes.

This document describes:

- per-provider behavior matrix
- the `stablePrefix` cache key + schema-version invariant
- pair-scoped cache keys
- cost savings accounting
- operator controls (kill-switch + TTL overrides)
- empirical guidance per provider

## Per-provider behavior matrix

| Peer (Provider)           | Cache mode      | Threshold       | TTL surface                                    | Telemetry source                                                      |
| ------------------------- | --------------- | --------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| `codex` (OpenAI)          | `auto`          | ~1k tokens      | `prompt_cache_retention` (`in_memory` / `24h`) | `usage.prompt_tokens_details.cached_tokens`                           |
| `claude` (Anthropic)      | `explicit`      | ~4k tokens      | `cache_control.ttl` (`5m` / `1h`)              | `usage.cache_creation_input_tokens` + `usage.cache_read_input_tokens` |
| `gemini` (Google)         | `implicit`      | service-managed | n/a                                            | `usageMetadata.cachedContentTokenCount`                               |
| `deepseek` (DeepSeek)     | `auto`          | service-managed | n/a                                            | `usage.prompt_cache_hit_tokens` + `usage.prompt_cache_miss_tokens`    |
| `grok` (xAI)              | `auto`          | service-managed | mirrors OpenAI                                 | `usage.prompt_tokens_details.cached_tokens`                           |
| `perplexity` (Perplexity) | `not_supported` | n/a             | n/a                                            | none — Sonar API exposes no prompt-cache surface                      |

`mode` values follow the canonical `TokenUsage.cache_provider_mode` enum:

- `auto` — provider auto-detects cacheable prefix (OpenAI, DeepSeek, Grok)
- `explicit` — runtime places cache_control breakpoints in the body (Anthropic only)
- `implicit` — provider transparently caches and reports tokens read (Gemini)
- `not_supported` — peer call did not produce cache telemetry

## Cache key scope strategy

Every cached call is bucketed by a **pair-scoped cache key**:

```
cross-review:<peer>:<caller>:v<cache_schema_version>
```

The pair scope means two different callers reviewing the same case still share cache hits within a peer; cache invalidation is bounded by the schema version. Bumping `CROSS_REVIEW_CACHE_SCHEMA_VERSION` (e.g. `v1` → `v2`) invalidates every previously cached entry, by design. Use this when prompt structure changes materially (new convergence rule, new system role line, new evidence index format).

Internally, we also emit a `stablePrefixHash` (sha256 hex) computed over the LF-normalized stablePrefix. The hash is invariant across rounds for the same case — see `prompt-parts.ts` and the smoke marker `cache_hash_invariance_test`.

## Cache schema versioning

`stablePrefix` always begins with the line `cache_schema_version: vN`. This appears verbatim inside the cached prefix payload so any structural shift produces a different hash and a different cache scope automatically.

When to bump:

- Adding/removing a section in stablePrefix (system, task, review_focus, convergence_rules, evidence_index)
- Reordering sections inside stablePrefix
- Changing the systemRole text materially
- Changing the convergence rules text

Smoke marker `cache_schema_version_in_prefix_test` pins the first-line shape so a regression is caught locally.

## Cost savings accounting

The cost layer (`src/core/cost.ts`) extends `CostEstimate` with two cache-related fields:

- `cache_savings_usd?: number` — populated when the rate card knows how to price the savings
- `cache_savings_unknown?: boolean` — set when cache telemetry was present but no rate card matched

Rate cards live in `src/core/cache-rates.json`. The primary input/output rates still flow through `config.cost_rates` (env vars `CROSS_REVIEW_<PROVIDER>_INPUT_USD_PER_MILLION` / `CROSS_REVIEW_<PROVIDER>_OUTPUT_USD_PER_MILLION`). The rate card delta is FALLBACK math: `(fresh_input_per_million - cached_input_per_million) × cache_read_tokens / 1e6`.

Adapters surface the read/write counts via `TokenUsage.cache_read_tokens` and `TokenUsage.cache_write_tokens`. The orchestrator reads them, emits a `provider.cache.usage` event, and appends a row to `<data_dir>/sessions/<session_id>/cache_manifest.json`.

## Bypass / kill-switch

```
CROSS_REVIEW_DISABLE_CACHE=true
```

Disables prompt caching globally for the runtime. Adapters fall back to the pre-v2.21 behavior (no `prompt_cache_key`, no `cache_control` blocks, no `x-grok-conv-id` header). The cost layer continues to merge `cache_read_tokens` / `cache_write_tokens` if a provider returns them anyway, so audit reproducibility is preserved.

Use cases:

- Provider misbehavior (cache poisoning, stale state)
- Audit reproducibility (force every call to make a fresh inference)
- A/B comparison between cached and uncached spend

## TTL configuration

```
CROSS_REVIEW_CACHE_TTL_ANTHROPIC=5m|1h          # default 1h
CROSS_REVIEW_CACHE_TTL_OPENAI=5m|1h             # default 1h
```

- **Anthropic** accepts `5m` and `1h` per the SDK. Values other than `5m`/`1h` are ignored with a stderr notice and the default is used.
- **OpenAI** accepts only `in_memory` and `24h` per the Responses API (the SDK type is locked to those two strings). The runtime translates `1h` → `24h` (extended retention) and anything else → `in_memory` (the default ~5 min window).

Grok mirrors OpenAI's mapping.

## Anthropic cache_control placement

The Anthropic adapter places exactly **one** cache_control breakpoint at the END of the system prompt block:

```ts
system: [
  {
    type: "text",
    text: systemPromptText,
    cache_control: { type: "ephemeral", ttl: "1h" },
  },
],
```

Anthropic supports up to 4 breakpoints per request; we reserve 3 for future additions (per-message layering, tool block caching, multi-tier prefixes). The `cache_creation_input_tokens` / `cache_read_input_tokens` fields on `response.usage` map directly to `cache_write_tokens` / `cache_read_tokens` on our canonical `TokenUsage` shape.

## Empirical guidance

| Provider  | Practical minimum cached prefix | Notes                                                                                      |
| --------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| OpenAI    | ≥ 1024 tokens                   | The Responses API auto-detects; `prompt_cache_key` improves hit rate for repeat callers.   |
| Anthropic | ≥ 4096 tokens                   | Below this size Anthropic may not actually create the cache entry. Adapter emits a notice. |
| Gemini    | service-managed                 | Implicit only at this writing; explicit `caches.create` is deferred.                       |
| DeepSeek  | service-managed                 | Auto-cached; both hit and miss tokens are returned.                                        |
| Grok      | service-managed                 | xAI mirrors OpenAI; `x-grok-conv-id` header binds the cache scope.                         |

## Reference URLs

- OpenAI prompt caching: https://platform.openai.com/docs/guides/prompt-caching
- Anthropic prompt caching: https://docs.claude.com/en/docs/build-with-claude/prompt-caching
- Google Gemini caching: https://ai.google.dev/gemini-api/docs/caching
- DeepSeek context caching: https://api-docs.deepseek.com/guides/kv_cache
- xAI / Grok caching: https://docs.x.ai/docs/api-reference

## Smoke markers

The smoke harness (`scripts/smoke.ts`) ships five anti-drift markers covering this surface:

- `cache_hash_invariance_test` — round/draft/priorRounds permutations do NOT mutate `stablePrefixHash`
- `cache_schema_version_in_prefix_test` — first line of `stablePrefix` matches `^cache_schema_version: v\d+$`
- `cache_rates_json_loaded_test` — every provider has a rate card with a numeric `fresh_input_per_million_usd`
- `cache_manifest_atomic_write_test` — sequential appends preserve every entry
- `cache_disable_kill_switch_test` — `CROSS_REVIEW_DISABLE_CACHE=true` flips `config.cache.enabled`
