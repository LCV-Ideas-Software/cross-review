# Prompt Caching (v2.21.0+)

`cross-review` integrates with each supported provider's available
prompt-caching surface. Perplexity exposes no Sonar prompt-cache control or
telemetry and is represented as `not_supported`. For participating providers,
the runtime emits a uniform `provider.cache.usage` event and persists a
per-session `cache_manifest.json` so dashboards, FinOps reports and post-mortem
tooling can read cache telemetry without branching on provider-specific shapes.

This document describes:

- per-provider behavior matrix
- the `stablePrefix` cache key + schema-version invariant
- pair-scoped cache keys
- cost savings accounting
- operator controls (kill-switch + TTL overrides)
- empirical guidance per provider

## Per-provider behavior matrix

| Peer (Provider)           | Cache mode      | Default participation | Threshold       | TTL surface                                     | Telemetry source                                                      |
| ------------------------- | --------------- | --------------------- | --------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| `codex` (OpenAI)          | `auto`          | on                    | ~1k tokens      | Sol: `prompt_cache_options` (`implicit`, `30m`) | cached + cache-write token fields                                     |
| `claude` (Anthropic)      | `explicit`      | off                   | ~4k tokens      | `cache_control.ttl` (`5m` / `1h`)               | `usage.cache_creation_input_tokens` + `usage.cache_read_input_tokens` |
| `gemini` (Google)         | `implicit`      | on                    | service-managed | n/a                                             | `usageMetadata.cachedContentTokenCount`                               |
| `deepseek` (DeepSeek)     | `auto`          | on                    | service-managed | n/a                                             | `usage.prompt_cache_hit_tokens` + `usage.prompt_cache_miss_tokens`    |
| `grok` (xAI)              | `auto`          | on                    | service-managed | `prompt_cache_key`; no client TTL               | Responses `input_tokens_details` / Chat `prompt_tokens_details`       |
| `perplexity` (Perplexity) | `not_supported` | off by capability     | n/a             | n/a                                             | none — Sonar API exposes no prompt-cache surface                      |

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

The pair scope lets repeated rounds from the same peer/caller pair reuse a cache
route. Different callers intentionally receive different keys, even when they
review the same case. Cache invalidation is bounded by the schema version.
Bumping `CROSS_REVIEW_CACHE_SCHEMA_VERSION` (e.g. `v1` → `v2`) invalidates
every previously cached entry, by design. Use this when prompt structure
changes materially (new convergence rule, new system role line, new evidence
index format).

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

Rate cards live in `config.cost_rates`, loaded from environment variables or the central config file. Central config can also define `model_cost_rates`, so explicit model overrides select the matching rate card without stale cross-model pricing. Cache read/write rates use the same per-provider prefix as input/output, for example `CROSS_REVIEW_<PROVIDER>_CACHE_READ_USD_PER_MILLION` and `CROSS_REVIEW_<PROVIDER>_CACHE_WRITE_USD_PER_MILLION`. The rate card delta is computed from the configured rates: `(fresh_input_per_million - cached_input_per_million) × cache_read_tokens / 1e6`.

Adapters surface provider-reported cache counts via
`TokenUsage.cache_read_tokens` and, only when the provider exposes a
creation/miss counter, `TokenUsage.cache_write_tokens`. GPT-5.6 Sol exposes a
cache-write field and cross-review prices it separately; Grok exposes cached
reads but no write counter, so the runtime never infers writes from
`input_tokens - cached_tokens`. The orchestrator emits
`provider.cache.usage` and appends a row to
`<data_dir>/sessions/<session_id>/cache_manifest.json`.

## Bypass / kill-switch

```
CROSS_REVIEW_DISABLE_CACHE=true
```

Disables the cache controls that the runtime can influence globally. OpenAI and
Grok omit `prompt_cache_key`/`prompt_cache_options`, and Anthropic omits
`cache_control`. The flag cannot force Gemini or DeepSeek to stop their
provider-managed implicit/automatic caching. The cost layer still merges cache
tokens if any provider reports them, preserving audit reproducibility.

The central schema also parses per-provider switches:

```powershell
CROSS_REVIEW_DISABLE_CACHE_OPENAI=true
CROSS_REVIEW_DISABLE_CACHE_ANTHROPIC=false
CROSS_REVIEW_DISABLE_CACHE_GEMINI=true
CROSS_REVIEW_DISABLE_CACHE_DEEPSEEK=true
CROSS_REVIEW_DISABLE_CACHE_GROK=true
CROSS_REVIEW_DISABLE_CACHE_PERPLEXITY=true
```

Anthropic defaults to disabled because the recorded hit rate was not
cost-effective for the observed session corpus; set
`CROSS_REVIEW_DISABLE_CACHE_ANTHROPIC=false` to re-enable it deliberately. In
the current adapters, Anthropic is the provider whose request body honors its
per-provider switch. Use the global switch for the client-controlled OpenAI and
Grok request fields. Gemini and DeepSeek remain service-managed, and Perplexity
has no cache surface.

Use cases:

- Provider misbehavior (cache poisoning, stale state)
- Audit reproducibility for client-controlled cache hints
- A/B comparison between cached and uncached spend where the provider exposes
  that control

## TTL configuration

```
CROSS_REVIEW_CACHE_TTL_ANTHROPIC=5m|1h          # default 1h
CROSS_REVIEW_CACHE_TTL_OPENAI=5m|1h             # legacy override families only
```

- **Anthropic** accepts `5m` and `1h` per the SDK. Values other than `5m`/`1h` are ignored with a stderr notice and the default is used.
- **OpenAI GPT-5.6 Sol** uses the current request-wide
  `prompt_cache_options={mode:"implicit", ttl:"30m"}` surface. The legacy
  `CROSS_REVIEW_CACHE_TTL_OPENAI` mapping applies only to older explicitly
  overridden model families that still use `prompt_cache_retention`.
- **Grok 4.5** sends only `prompt_cache_key`; xAI manages retention and does not
  receive the OpenAI retention field.

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
| Grok      | service-managed                 | Grok 4.5 uses `prompt_cache_key`; xAI manages retention.                                   |

## Reference URLs

- OpenAI prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching
- Anthropic prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Google Gemini caching: https://ai.google.dev/gemini-api/docs/caching
- DeepSeek context caching: https://api-docs.deepseek.com/guides/kv_cache
- xAI / Grok caching: https://docs.x.ai/developers/advanced-api-usage/prompt-caching
- xAI cache usage and pricing: https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing

## Smoke markers

The smoke harness (`scripts/smoke.ts`) ships five anti-drift markers covering this surface:

- `cache_hash_invariance_test` — round/draft/priorRounds permutations do NOT mutate `stablePrefixHash`
- `cache_schema_version_in_prefix_test` — first line of `stablePrefix` matches `^cache_schema_version: v\d+$`
- `cache_rates_json_loaded_test` — every provider has a rate card with a numeric `fresh_input_per_million_usd`
- `cache_manifest_atomic_write_test` — sequential appends preserve every entry
- `cache_disable_kill_switch_test` — global and per-provider cache switches
  are parsed, including Anthropic's default-off behavior
