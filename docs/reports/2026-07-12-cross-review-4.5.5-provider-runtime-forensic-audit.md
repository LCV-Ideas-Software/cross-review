# cross-review 4.5.5 forensic and contract audit

Date: 12/07/2026
Scope: runtime 4.5.5, six AI APIs, the sessions and logs of the preceding 36
hours, central configuration, costs, anti-fabrication mechanisms and the
preparation of the final 4.5.7 correction (contracts introduced in source
4.5.6).

## Executive summary

The loaded runtime was confirmed as 4.5.5. The central configuration was applied
in full, with no model, effort or price override from environment variables. The
investigation found real defects in cross-review; they were not merit-based
rejections of the submitted applications.

The principal causes were:

1. a single canonical JSON Schema was transmitted to APIs with different
   documented subsets;
2. literal citation correlation handled neither a JSON escape layer nor the
   later logical image of a diff;
3. file references embedded in composite evidence lost custody between rounds;
4. model names belonging to the reviewed product could be confused with runtime
   pins;
5. OpenAI's `response.incomplete` had no controlled recovery;
6. filtering terminals could improperly enter input-moderation recovery;
7. the effort configured for Gemini was emitted by the file configuration but
   never read by the runtime;
8. sessions terminalized by the job could retain `control=running`;
9. part of the pricing configuration mixed different regimes or models;
10. fallbacks were accounted against the primary pin, not against the effective
    model;
11. streaming partials from a failed attempt could remain visible with no
    attempt identifier and no transactional discard;
12. matching described as literal normalized case/whitespace, and a `-` marker
    could make removed code reappear as evidence;
13. a generic assurance repeated from the draft could ground its own READY;
14. fallback rate cards, overlapping prefixes and the retry call graph were not
    preflighted conservatively;
15. rejected terminals discarded usage/cost, and the Responses API's official
    events and refusals were flattened into a generic error or into format
    recovery;
16. `server_info` falsely claimed there was no advanced CodeQL workflow.

The correction keeps the complete contract locally and transmits to each API
only the officially documented subset. No paid call was made during this audit
or its tests.

## Method and evidence rule

For each provider, only official documentation and the installed official SDK
were accepted as the contract. Real sessions were used as empirical evidence of
failures, never as a substitute for the documentation. Where the documentation
does not enumerate a JSON Schema keyword, the wire schema was reduced to the
published subset and the complete contract stayed enforced by prompt,
normalization and local Zod.

What was used:

- installed SDKs: `openai@6.46.0`, `@anthropic-ai/sdk@0.111.0` and
  `@google/genai@2.11.0`;
- persisted artifacts from sessions, attachments and NDJSON events;
- `server_info` at runtime;
- offline tests that intercept each adapter's final body;
- the official documentation listed in the references section.

## Runtime and configuration state

`server_info`, consulted on 12/07/2026, confirmed:

| Field                    | Value                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| Loaded version           | `4.5.5`                                                            |
| Effective config         | `C:\Users\leona\.cross-review\data\config.json`                    |
| Loaded SHA-256           | `87f809f2bd9cba20147c707d3a33be0745907889d0e9a3968c8a3090db1a9c0b` |
| Fields applied           | `70`                                                               |
| Fields overridden by env | `0`                                                                |
| Reload required          | `false`                                                            |
| Global output            | `20000`                                                            |

Active pins:

| Peer       | Model                    |
| ---------- | ------------------------ |
| Codex      | `gpt-5.6-sol`            |
| Claude     | `claude-fable-5`         |
| Gemini     | `gemini-3.1-pro-preview` |
| DeepSeek   | `deepseek-v4-pro`        |
| Grok       | `grok-4.5`               |
| Perplexity | `sonar-reasoning-pro`    |

The 4.5.5 effort map omitted Gemini, even though the central file already
accepted `reasoning_effort.gemini`. It was not a stale window: the file → env
transport existed, but `loadConfig()` did not read the variable and the adapter
hardcoded `ThinkingLevel.HIGH`.

### Central configuration state after publication

After 4.5.7 was published, the central file was updated without installing a
local artifact and validated directly against the source 4.5.7 schema. The
offline result was:

| Field                            | Value                                                              |
| -------------------------------- | ------------------------------------------------------------------ |
| Current SHA-256 of the file      | `f526bbdc87648631dcb0eab98cc43da4b7b0062d8e5523773b7b977b96376023` |
| Schema 4.5.7                     | valid                                                              |
| Fields applied                   | `70`                                                               |
| Fields overridden by env         | `0`                                                                |
| Missing financial controls       | `0`                                                                |
| Generic `cost_rates`             | removed                                                            |
| Cards in `model_cost_rates`      | six peers                                                          |
| Output Codex / Claude / the rest | `25000` / `64000` / `20000`                                        |
| Perplexity probe                 | `auth_only`                                                        |
| Anthropic cache                  | TTL `1h`, disabled                                                 |

The per-model cards remove Grok's unpublished long tier, Gemini's non-existent
per-token cache-write, and the Deep Research-exclusive dimensions from the
active `sonar-reasoning-pro` card. The `sonar-deep-research` card was kept only
for post-response accounting; it stays out of primary and fallback because its
provider-controlled dimensions do not allow a conservative financial hardgate
before the call.

A fresh `server_info` query confirmed the window is still running 4.5.5. That
process keeps the earlier snapshot
`87f809f2bd9cba20147c707d3a33be0745907889d0e9a3968c8a3090db1a9c0b`, exposes the
current hash above as `current_sha256`, declares `reload_required=true` and
blocks paid calls with `CROSS_REVIEW_CONFIG_RELOAD_REQUIRED`. The 4.5.7
configuration only becomes effective after the operator runs the published
global upgrade and reloads the window.

The 4.5.7 package was later installed by the operator, but the window was not
reloaded. The observed runtime therefore correctly stays at 4.5.5; the next
reload was reserved for version 4.5.8.

## Audit of the last 36 hours

Approximate forensic window: since `2026-07-11T02:48:41Z`.

### Inventory

- 51 session directories touched;
- 44 sessions created in the window;
- 7 old 4.4.8 sessions only reached by sweep;
- new versions: 4.5.0 = 28, 4.5.2 = 6, 4.5.3 = 5, 4.5.5 = 5;
- outcomes of the new sessions: 10 open, 24 aborted, 9 max-rounds and 1
  converged;
- 11 log files, 4,266 NDJSON records and zero parse errors;
- 18 attachments, all present and with the correct SHA-256;
- zero event-sequence gaps or duplications;
- zero currently corrupted sessions.

### 4.5.5 findings

- Anthropic rejected the wire schema in sessions
  `30998abe-b4fa-46c7-8f36-6c97791e2af3` and
  `61ce42d5-0dc0-48e3-a6d0-48aabb4dc9ec` with `maxItems` unsupported. The
  identifier `4fe60040-d2b0-4950-ae6e-24751ca1b534` cited in the field was the
  job, not the session ID.
- There were eight `raw READY` dismissals. Across 76 sources, 35 matched
  directly, a further 24 matched after exactly one JSON unescape layer, 9 after
  a safe reconstruction of the diff's later image, and 8 were genuinely
  uncorrelated. Six of the eight votes contained no genuinely false source.
- Session `04691dd6-a3fc-4795-895e-8184425d6899` demonstrated a model-namespace
  false positive: a Gemini model belonging to the reviewed application was
  compared against the runtime's peer pin.
- Session `0e311ee7-667b-4f6d-b205-ba308cf44f37` demonstrated loss of custody
  for files explicitly delimited by `BEGIN FILE`/`END FILE` inside composite
  evidence.
- Exactly three terminal 4.5.5 sessions retained `running` control:
  `04691dd6-a3fc-4795-895e-8184425d6899`,
  `0e311ee7-667b-4f6d-b205-ba308cf44f37` and
  `61ce42d5-0dc0-48e3-a6d0-48aabb4dc9ec`. The cause was deterministic: the
  outcome was sealed before the control was cleared, and the later cleanup
  correctly refused a post-terminal mutation.
- The preserved session `741b69bc-cc03-40a8-9899-1199fb834e85` remains a test
  case: 13 of Grok's 15 sources were byte-for-byte valid, but the vote was
  downgraded by a quote escape and the all-or-nothing policy.
- An OpenAI `response.incomplete` sat for 351.5 seconds and was persisted as an
  unpriced attempt, even though the official Response carried usage.

No tampered attachments, event gaps or session corruption were found that would
explain these results.

## Official Structured Outputs matrix

| Provider   | Official contract applied                                                                             | Audit result                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| OpenAI     | strict Responses Structured Outputs; `maxItems` and `maxLength` supported on the non-fine-tuned model | full canonical schema preserved                                                  |
| Anthropic  | Structured Outputs with its own subset and lowering by the official helper                            | the official helper removes incompatible constraints; local validation preserved |
| Gemini     | closed list includes `maxItems`, not `maxLength`                                                      | `maxLength` removed from the wire                                                |
| DeepSeek   | JSON Object mode, no full response schema                                                             | `json_object` + prompt + local Zod preserved                                     |
| xAI        | JSON Schema; `maxItems` guaranteed up to 256 and `maxLength` up to 2,048                              | evidence limited to 2,048 on the wire; the local limit stays 2,500               |
| Perplexity | Sonar `json_schema` wrapper, no closed matrix of dimensional constraints                              | minimal structural wrapper; local limits preserved                               |

Fields not covered by the minimal official contract were also removed:
`text.verbosity` from the xAI wire, and `name` and
`stream_options.include_usage` from the Sonar wire.

## Output recovery and safety

Automatic recovery is allowed only when the official terminal unambiguously
identifies an output limit:

- Anthropic `stop_reason=max_tokens`;
- OpenAI `response.incomplete` + `reason=max_output_tokens`;
- Gemini `finishReason=MAX_TOKENS`.

Each eligible path makes at most one new call, on the same model, prompt and
ceiling, with medium effort/thinking. On Claude Fable 5, recovery happens only
if the original effort was `high`, `xhigh` or `max`; `low`/`medium` end without
a retry, since medium would not reduce effort. Usage and cost are computed per
attempt and then summed; this avoids artificially crossing the 200K/272K tiers.
A second truncation ends the flow.

No retry was inferred for:

- DeepSeek `length`, which may represent either output or the context window;
- xAI incomplete, whose documentation does not enumerate the reason;
- Perplexity, whose documentation does not enumerate the relevant finish
  reasons.

The `content_filter`, `Candidate.finishReason=SAFETY` and equivalent terminals
are now recognized structurally as filtered output and never enter a retry, a
fallback or reduced-context recovery. By contrast, `promptFeedback.blockReason`
is Gemini's official input-prompt block signal and may trigger exactly one new
attempt with a compact prompt, subject to the budget hardgate.

Even a rejected terminal can be billed. Usage and cost for the effective model
are now attached before the throw and accumulated across attempts. DeepSeek
drains the official final `choices: []` chunk carrying usage before rejecting
`length`; every non-null non-stream `response.error` is preserved before status
validation (including the xAI `incomplete` envelope), SSE `type=error` reads the
top-level fields, and `output[].content[].type=refusal` or
`response.refusal.delta/done` refusals never enter format recovery.

DeepSeek's documented `insufficient_system_resource` terminal is the explicit
transient exception: the interrupted inference discards partial text, preserves
billing and uses only the already-limited retry envelope. `length` and
`content_filter` remain terminal. The ledger race audit also closed three
windows: double-counting after settle+cancel, loss of the previous attempt
before the next dispatch, and a false `billing_status=reported` while an
unpriced attempt still exists.

The preflight distinguishes attribution, not the mere presence of tokens. The
canonical `server_info`, `runtime_capabilities`, `runtime_version` and
`model_pin` formats are current by nature; denials such as "not 4.5.6; is 4.5.5"
are rejected, but an npm or application version with its own subject is not
compared against the cross-review runtime.

## Audit of the anti-lying and anti-laziness mechanisms

The fundamental mechanisms remain appropriate:

1. READY requires a canonical status, concrete evidence and the absence of
   requests or follow-ups.
2. Every source claiming attachment custody requires a path/label, the full
   SHA-256 and a matching literal in the same attachment. A direct quotation of
   the artifact itself may use the non-custody route, but it has to be literal
   and concrete; a generic assurance copied from the draft does not prove its
   own READY.
3. The vote's all-or-nothing policy was kept. The correction does not accept a
   majority of sources; it only began comparing logically equivalent
   representations.
4. Unescaping is limited to one controlled layer (`\n`, `\r`, `\t`, `\"`,
   `\\`), never recursive. Unknown escapes are rejected; after that controlled
   deserialization, case and whitespace remain literal.
5. Diffs are reconstructed only inside hunks: additions and context form the
   later image; removals cannot prove the current state, including when the
   citation repeats the `-` marker. Metadata and logs outside hunks remain
   quotable.
6. `BEGIN FILE`/`END FILE` grants submission custody only when the path pair
   matches and the body is non-empty; it does not promote caller evidence to
   operator authority.
7. Model pins are compared only when the sentence attributes the value to the
   cross-review runtime/server, MCP, `server_info`, `runtime_capabilities` or
   `model_pin`. Mere co-occurrence in a "cross-review submission/session" does
   not transfer the application's models, versions or dates into the server's
   namespace.
8. Output filters are not reinterpreted as a prompt rejection in order to obtain
   a second attempt.
9. Terminal sessions remain immutable and now atomically clear the normal
   control before sealing the outcome.
10. Streaming deltas are provisional and bound to the attempt; a failure cancels
    the timer and emits a discard, and only a healthy terminal confirms the
    text.
11. A generic narrative assurance copied from the draft is not independent
    evidence of a correction or of tests.

These changes reduce false positives without weakening the block on fabricated
citation, self-review, forged authority or lazy READY.

## Financial audit

The active base prices matched the official pages. Three semantic errors were
found in the shape of the cards:

1. Grok 4.5 contained a local >200K 4/12/1 tier that is not officially
   published;
2. Gemini contained `cache_write=2/4`, but the adapter uses implicit caching and
   explicit storage is priced per token-hour;
3. the active Sonar Reasoning Pro card contained dimensions exclusive to Sonar
   Deep Research.

The engine now resolves the model each adapter/fallback actually sends; an
override with no applicable card fails closed instead of inheriting the primary
pin's price. Citation/reasoning/search-query apply only when that model is
`sonar-deep-research`. Gemini adds thinking to billable output without
double-counting the telemetry sub-bucket. `mergeUsage` preserves the Sonar
dimensions across attempts; `mergeCost` preserves input/output and keeps a
`tier_used` only when every attempt shares the same tier.

The loader and the resolver choose the most specific family prefix. Regular
Sonar requires the active context's request rate in both primary and fallback.
Deep Research requires the three additional fields for accounting but stays
fail-closed before the call: the API publishes no controllable ceiling for
searches, citation tokens or reasoning tokens, so no estimate can honestly be
presented as a hardgate. The preflight for the remaining models covers every
primary/fallback attempt and the longest format/moderation recovery path,
without the old heuristic cap of four calls.

Configuration recommendation for 4.5.7:

- keep the global fallback at 20,000;
- Codex: 25,000;
- Claude: 64,000;
- Gemini, DeepSeek, Grok and Perplexity: 20,000;
- move rates into `model_cost_rates`, so that an unknown model fails closed
  instead of inheriting another model's price;
- keep `reasoning_effort.gemini=high` and `perplexity.probe_mode=auth_only`
  explicit.
- keep `sonar-deep-research` out of primary/fallback while its
  provider-controlled dimensions have no official pre-dispatch ceiling.

## CI #307

[CI #307](https://github.com/LCV-Ideas-Software/cross-review/actions/runs/29181944333)
on commit `f6ec468` failed in Smoke tests only. `SECURITY.md` had swapped the
contractual phrase `Current supported source/release target` for `Current
supported release`, breaking the deterministic `release_metadata` assertion. The
following commit `785f905` restored the neutral form, and
[CI #308](https://github.com/LCV-Ideas-Software/cross-review/actions/runs/29182158627)
passed in full. The failure was already superseded and required no new fix.

This audit also aligned `server_info.codeql_policy` and the baseline with the
Advanced CodeQL workflow actually in version control (`actions` and
`javascript-typescript`, `security-extended` queries); the remote Default Setup
is `not-configured`, avoiding duplicate analysis.

## Offline verification

The new `v4.5.6-runtime-contract-regression` contract covers 22 cases,
including:

- the final bodies of all six adapters;
- per-provider wire schemas;
- Gemini effort config/reload;
- per-peer budgets and preflight;
- OpenAI and Gemini, streaming and non-streaming;
- exactly one retry and no safety retry;
- the ledger after a network failure and after cancellation;
- Gemini cost with thinking;
- Deep Research-exclusive costs;
- escaped citations and the diff post-image;
- literal case/whitespace, the removal marker, the maximum status envelope and
  the configuration's patch compatibility;
- embedded files, model-pin namespace, terminal control, the Gemini prompt block
  and transactional streaming discard.

The historical smokes also passed: provider terminal, provider refresh,
grounding, cancellation, durable jobs, accounting, evidence custody,
truthfulness, the main smoke and the runtime smoke. No paid API was called.

## npm 12 publication security and GAT/2FA

The official announcement of 8 July 2026 was incorporated as a release hardgate.
npm 12 made dependency install scripts and the resolution of Git dependencies or
remote URLs opt-in. npm GATs with 2FA bypass will stop bypassing 2FA on
sensitive operations in early August 2026 and, around January 2027, will stop
publishing directly.

The repository's npmjs path was already on the correct architecture:
GitHub-hosted runner, `npm-production` environment, `id-token: write`, Trusted
Publishing OIDC and provenance. The published 4.5.5 version was queried on the
registry and carries
`dist.attestations.provenance.predicateType = https://slsa.dev/provenance/v1`.
There is no `NPM_TOKEN`, GAT or OTP in the npmjs job; `GITHUB_TOKEN` serves only
GitHub Packages and is not part of the npm GAT contract.

The residual gaps were fixed:

- the release workflow pins npm 12.0.1 before any `npm ci`;
- every package-manager cache was disabled;
- `STEPSECURITY_NPM_TOKEN` left the global environment and exists only in the
  four install steps;
- the requested tag must exist under `refs/tags/` and point at the `HEAD` that
  was actually published;
- the temporary GitHub Packages npmrc file is created with `umask 077` and mode
  `0600`;
- post-publication verification requires and queries the SLSA v1 attestation;
- `.npmrc` pins `strict-allow-scripts=true`, `allow-git=none` and
  `allow-remote=none`;
- `package.json` permits only the reviewed and pinned scripts of
  `@google/genai@2.11.0`, `protobufjs@7.6.4`, `esbuild@0.28.1` and the optional
  macOS `fsevents@2.3.3`. The official read-only command went from three pending
  items on Windows to zero; an upgrade of those artifacts fails again until a new
  review.
- the upgrade commands set `@lcv-ideas-software:registry` explicitly, because a
  generic `--registry` does not beat a registry persisted for the scope;
  `npm upgrade` is not given `@latest`, which npm 12 rejects with
  `EUPDATEARGS`;
- because `npm upgrade -g` evaluates the whole global tree and the local lock
  does not govern the consumer's transitive resolution, applying a strict
  project allowlist to that command failed in `dry-run` on scripts belonging to
  other global packages. The portable flow uses `--ignore-scripts`,
  `--allow-git=none` and `--allow-remote=none`: no dependency lifecycle runs,
  and the published package has no install lifecycle of its own.

The supplementary report received was used where confirmed. Two claims were
rejected: this machine already runs npm 12.0.1, not npm 11; and a global install
from a tarball produced from local source violates the operator's directive. The
only documented flow is `npm upgrade -g` of the published version.

An npmjs credential was detected in the user's `.npmrc`, without revealing its
value. It takes no part in OIDC publication. Its purpose should be audited on
npmjs.com and, if it is an automation/bypass GAT, downgraded to read-only or
revoked. That account change was neither inferred nor performed by code.

## Deliberate limitations

- No fourth paid round was run on the preserved sessions. The directive was to
  avoid repetitive spend; the adapters were verified by wire interception and
  official SDKs.
- DeepSeek/Grok/Perplexity remain fail-closed on ambiguous terminals. The single
  DeepSeek exception is `insufficient_system_resource`, which the official API
  defines as an interruption caused by insufficient inference-system resources.
- The new `max_output_tokens_by_peer` key must not be loaded by a 4.5.5 host:
  the old strict schema would reject it atomically. 4.5.7 was published before
  the change; since the current host does not support live reload, it preserved
  the earlier snapshot, marked a reload mandatory and blocked paid calls. The
  operator has to run the published global upgrade before reloading the window.

## Official references

- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI reasoning budgets](https://developers.openai.com/api/docs/guides/reasoning#allocating-space-for-reasoning)
- [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
- [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Anthropic task budgets](https://platform.claude.com/docs/en/build-with-claude/task-budgets)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Gemini Structured Outputs](https://ai.google.dev/gemini-api/docs/structured-output?lang=rest)
- [Gemini GenerateContent API](https://ai.google.dev/api/generate-content)
- [Gemini 3.1 Pro Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview)
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [DeepSeek JSON mode](https://api-docs.deepseek.com/guides/json_mode/)
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion)
- [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [xAI Structured Outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)
- [xAI pricing](https://docs.x.ai/developers/pricing)
- [Perplexity Sonar API](https://docs.perplexity.ai/api-reference/sonar-post)
- [Perplexity Sonar Reasoning Pro](https://docs.perplexity.ai/docs/sonar/models/sonar-reasoning-pro)
- [Perplexity pricing](https://docs.perplexity.ai/docs/getting-started/pricing)
- [npm install-time security and GAT bypass2fa deprecation](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)
- [npm 12 configuration](https://docs.npmjs.com/cli/v12/using-npm/config/)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
- [GitHub Actions `workflow_run`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)
- [OpenSSF Scorecard — Pinned Dependencies](https://github.com/ossf/scorecard/blob/main/docs/checks.md#pinned-dependencies)
- [OpenSSF npm package-manager best practices](https://github.com/ossf/package-manager-best-practices/blob/main/published/npm.md)

## Release evidence

### Local validation before the commit

- clean install: `npm ci --ignore-scripts --no-audit --no-fund`, 245 packages,
  exit 0;
- 4.5.6 contracts: 22/22;
- 4.5.4 grounding: 20/20;
- provider refresh, provider terminal, citations, truthfulness, cancellation,
  durable jobs, health/activity, accounting, evidence transport/custody and
  source contracts: all green;
- broad fail-fast smoke: 122 events and `ok: true` after updating the old
  fixtures to the complete FinOps call graph;
- stdio runtime smoke: `ok: true`, runtime 4.5.7, six stub peers, preflights,
  identity, cancellation and convergence exercised;
- `npm run check`, `git diff --check` and every workflow through `actionlint`:
  exit 0;
- `npm audit --omit=dev`: 0 vulnerabilities at every level;
- `npm pack --dry-run --ignore-scripts`: package 4.5.7, 185 entries, about
  914 kB packed and 4.21 MB unpacked. The report ships inside the package
  itself, so the self-referential integrity is not frozen here; the
  authoritative registry value will be recorded after publication.

The aggregate `npm test` command is fail-fast. The first runs revealed drift in
historical fixtures (Portuguese namespace, stub cards and synthetic ceilings
predating the complete call graph). Rather than restart the whole battery after
each stop, every remaining component was run to completion; all came out green.
A clean aggregate confirmation is the CI's responsibility on the published
commit and is recorded below. No paid API was called in this validation.

### Publication

The first push created `v04.05.06`, but the CI used the npm bundled with Node 24
and failed the install with `EALLOWREMOTE` under the npm 12 policy. Cancelling
publish run `29204032723` arrived after the publication commands: npmjs records
4.5.6 at `2026-07-12T18:33:54.523Z`, with SLSA provenance, integrity
`sha512-WklDb7JYeu5x3GFBt8E9pdDmhCdyRswcYtlLcD4dmZ2eU/ccWrnAeGM7Uew63IF3vOXfQd0lETCyA9vYY0B80A==`
and shasum `9147bdbd8fdc8cd2b81021993e730c2ab69e8973`. The equivalent GitHub
Packages step also registered the package before the cancellation, but the later
verifications and the GitHub Release creation were skipped. This is therefore a
partial publication, not an avoided one.

The fix aligns the common CI with npm 12.0.1, confirms at runtime which `npm`
executable became active, disables caching, requires strictly approved scripts
and limits the StepSecurity token to the install. Auto-tag stopped competing
with the CI on every push: it now receives `workflow_run` only from a CI
completed on `main`, requires `conclusion == success` for a `push` event, checks
out the validated `head_sha` and only then creates the tag and dispatches the
publication. An automated contract protects these properties. 4.5.7 replaces
4.5.6 as the complete delivery.

Closing of the 4.5.7 delivery:

- commit and tag: `cddd72a082e840cad3208ce653449524b6c8c5f6` = `v04.05.07`;
- [CI 29204616990](https://github.com/LCV-Ideas-Software/cross-review/actions/runs/29204616990):
  green, including effective npm 12.0.1, release policy, formatting, lint,
  Biome, typecheck and smoke;
- [auto-tag 29204660252](https://github.com/LCV-Ideas-Software/cross-review/actions/runs/29204660252):
  green and triggered by `workflow_run` only after the CI;
- [publish 29204668442](https://github.com/LCV-Ideas-Software/cross-review/actions/runs/29204668442):
  four green jobs — aggregate gate, npmjs, GitHub Packages and GitHub Release;
- advanced CodeQL `29204617014`, CodeQL default setup `29204616646` and Socket
  `29204616978`: green on the same SHA;
- npmjs published 4.5.7 as `latest` at `2026-07-12T18:53:50.676Z`, with shasum
  `50a329c9663070f007c58a17cb6887e75da23a82`, integrity
  `sha512-58CDvnqq2EWlkuvF19FObsbB3dDVgdkORexMx/745peiT1/UIH8ykKyj1rU/GpTU+jKF2IXkxAULpArGS5zNRQ==`
  and an SLSA provenance v1 attestation;
- [GitHub Release v04.05.07](https://github.com/LCV-Ideas-Software/cross-review/releases/tag/v04.05.07):
  published, immutable, not a draft and not a prerelease; the asset is 914,021
  bytes with digest
  `sha256:d55eea25641efbff8c2f91c2ea28100f4b2c1ace0be9262e04ca8b1847c3a8c7`.

Every workflow associated with the final SHA/tag reached the terminal state
`success`. No local global install and no paid call to the six providers were
made in this delivery.

## Addendum: seven code scanning alerts and the 4.5.8 target

After the 4.5.7 publication, GitHub opened seven findings that reduce to two
causes:

| Alerts  | Scanner   | Cause                                                              |
| ------- | --------- | ------------------------------------------------------------------ |
| `32–35` | Scorecard | four global npm bootstraps in the publication workflow             |
| `37`    | Scorecard | the same global bootstrap in the common CI                         |
| `36`    | Scorecard | dynamic checkout of `workflow_run.head_sha` in a writable workflow |
| `38`    | CodeQL    | the same event-controlled checkout in auto-tag                     |

Scorecard treats any `npm install` in a workflow as unpinned, except for the
paths the scanner recognizes, even when the argument carries an exact SemVer
version. The material risk exists too: a fixed version does not authenticate the
tarball's contents before executing the new CLI. The regression was first changed
to require SHA-512 and the absence of `npm install --global`; it failed against
the previous state with `release jobs must pin the npm v12 tarball by SHA-512`.

The fix replaces the five occurrences with a local composite action that:

1. accepts only an `X.Y.Z` version and a 128-character hexadecimal SHA-512
   digest;
2. downloads the exact `npm-12.0.1.tgz` URL from the official registry;
3. verifies the SHA-512 before extracting or executing;
4. confirms the extracted CLI reports 12.0.1;
5. activates a temporary wrapper, with no global install and no npm lifecycle.

The pinned digest matches the official integrity
`sha512-L5T9i/YAQWQWqTS/xZxJkei/9zcu99hCeE4qi41IyBVV7mRQad3qc2JfuOktwmH+qwGI/V2rbCL+/UYxb1+RQA==`.

For auto-tag, the checkout stopped accepting `head_sha` in the `ref` field. The
workflow uses the trusted default checkout of the default branch, passes the
event's SHA only through `env`, compares it immediately against
`git rev-parse HEAD`, and gates on the output `matches=true` the four steps that
read, tag or publish content. If another push advances `main`, the old run ends
without creating a tag; the new commit's CI will start the next attempt.

Targeted local validation: red reproduction, green npm/release regression and
green `actionlint`. The integrated check passed with no warnings after the style
fix, the runtime smoke returned `ok: true` and version 4.5.8, the central
configuration stayed valid with 70 fields / zero overrides / zero missing
controls, and the dry-run packed 185 entries, about 917 kB packed and 4.22 MB
unpacked.

Remote closing of 4.5.8:

- commit and tag: `1cc3bb83fd12fb13a09b4acfba7c3b9ce1f961d0` = `v04.05.08`;
- [CI 29205474027](https://github.com/LCV-Ideas-Software/cross-review/actions/runs/29205474027):
  green, including the real SHA-512 bootstrap on the Ubuntu runner, check and
  smoke;
- advanced CodeQL `29205474005`, CodeQL default setup `29205473700`, Scorecard
  `29205474038` and Socket `29205473999`: green;
- [auto-tag 29205513498](https://github.com/LCV-Ideas-Software/cross-review/actions/runs/29205513498):
  green with a matching checkout/default branch and CI SHA;
- [publish 29205522124](https://github.com/LCV-Ideas-Software/cross-review/actions/runs/29205522124):
  gate, npmjs, GitHub Packages and GitHub Release green;
- alerts 32–38: `state=fixed`, `dismissed_at=null`; open code scanning: 0;
- open Dependabot: 0; open secret scanning: 0;
- full `npm audit` and `--omit=dev`: 0 at info, low, moderate, high and
  critical;
- 12/12 check-runs on the release SHA: `completed/success`.

npmjs published 4.5.8 as `latest` at `2026-07-12T19:20:03.672Z`, with shasum
`2846cc6fe4c5bd4d06209ad75360fef6264f1418`, integrity
`sha512-n8F4Wm9qe9ahL5DECG/weL05e30rCdASeYHnacBjHPF93nUzB1cgK5cwbJepiAv75WOHyetzEm3R0mLGQBHHKQ==`
and an SLSA provenance v1 attestation. The
[GitHub Release v04.05.08](https://github.com/LCV-Ideas-Software/cross-review/releases/tag/v04.05.08)
is immutable, not a draft and not a prerelease; the asset is 917,386 bytes with
digest
`sha256:4f6892233e7ed6bfaa41947bfe4a956b35be8d0f858219d6f840181f96e52095`.

After every workflow went green, no new occurrence was found in code
scanning/CodeQL/Scorecard/Socket, Dependabot, secret scanning or npm audit. The
window's runtime was not reloaded during that closing.
