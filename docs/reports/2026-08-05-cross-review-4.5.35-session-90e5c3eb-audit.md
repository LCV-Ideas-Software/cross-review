# Cross-review 4.5.35 — forensic audit of session `90e5c3eb`

Date: 5 August 2026
Scope: session `90e5c3eb-218c-42ef-b21a-6968ccc4aac5`, its persisted evidence,
peer artifacts, runtime events, and the corresponding source paths in cross-review 4.5.35.

## Executive conclusion

Three product defects were confirmed. None was caused by a stale runtime or by a central
configuration reload failure:

1. byte-exact JSON citations beginning with a quote were rejected when the quoted fragment did
   not also end in a quote;
2. the full decision-retry path rebuilt a peer request without the active caller-evidence
   attachment or Evidence Broker checklist;
3. the Perplexity streaming adapter ignored the documented aggregate
   `choices[].message.content` carried by a terminal `chat.completion.done` event when no usable
   delta text had been accumulated.

The third defect is a capability gap established from the official wire contract. The preserved
session artifact does not contain the original raw terminal event, so it is not possible to prove
that this exact representation caused the empty output in this session. The evidence-loss defect
in the subsequent decision retry is deterministic and independently reproduced.

## Runtime and repository state

- Runtime: cross-review 4.5.35, six peers enabled, real-provider mode.
- Central configuration: applied without parse error; loaded and current SHA-256 values matched;
  no reload was pending.
- Source: clean `main` at `304b6cefc01f964f6c867d1bb926ae551db89192`, identical to
  `origin/main`, npm `latest`, tag `v04.05.35`, and the immutable GitHub Release.

This rules out a stale process, uninstalled build, uncommitted local patch, or config drift as the
cause of the observed decisions.

## Session timeline and cost

- Evidence attachment persisted and activated at `2026-08-05T05:23:11.030Z`:
  22,767 bytes, SHA-256
  `e00bdc6d3f29e682e7e6586c09eba32ed57521d11d56404545939f95370e132e`.
- Gemini completed with effective `READY`.
- DeepSeek returned raw `READY`; both citations were exact substrings but were rejected.
- Grok returned raw `READY`; six rejected citations were exact substrings, while two others were
  genuinely coalesced/non-literal and therefore correctly remained unsupported.
- Perplexity's first call ran for 880.309 seconds, persisted one streamed chunk and zero usable
  output characters, and cost USD 0.02624.
- The full decision retry ran for 68.947 seconds and cost USD 0.01275. It returned
  `NEEDS_EVIDENCE` after being shown the draft without the active 22,767-byte attachment.
- Formal result: `max_rounds_without_unanimity`; session cost USD 0.133768.

The other session reported by the caller cost USD 0.075358, making the two-session total
USD 0.209126. No further paid round was required for this diagnosis.

## Defect 1 — false-negative JSON citation correlation

### Cause

`quotedEvidencePhrases()` treated the first quote after `Artifact quote:` as an outer delimiter.
It returned a phrase only if the complete payload also ended in the same delimiter. A literal such
as the following therefore yielded no candidate at all:

```text
Artifact quote: "org":{"activeCount":11}
```

The leading quote is part of the JSON key, while the fragment legitimately ends in `}`. Because
the extractor returned an empty list, the later path + digest + quote matcher could never examine
the byte-exact substring.

### Correction

The complete marker payload is now always offered as a candidate when it meets the existing
minimum length. A genuinely paired wrapper additionally contributes its unwrapped form. Every
candidate must still pass the existing same-attachment checks:

- exact path or label;
- matching SHA-256;
- literal byte-contiguous quote;
- minimum quote length;
- rejection of content found only in a removed diff hunk;
- no fabricated tokens or operational assertions.

The all-or-nothing policy remains intact. One valid source cannot mask a second fabricated,
coalesced, wrong-digest, or otherwise unsupported source. Consequently, the historical DeepSeek
vote becomes groundable, while the historical Grok vote still correctly fails because two of its
14 sources were not literal excerpts.

## Defect 2 — active evidence lost during decision retry

### Cause

The normal review prompt received the resolved attachment list and rendered both the caller
evidence and the outstanding Evidence Broker checklist. `buildDecisionRetryPrompt()` received
neither. It rebuilt only task, history, draft, and the empty prior response.

The input-token reduction from 10,120 on the first Perplexity call to 1,779 on the retry is
consistent with removal of the 22,767-byte attachment. The retry's statement that the draft had no
attachable raw evidence was therefore induced by the runtime prompt, not by missing custody.

### Correction

The decision-retry builder now requires the already resolved active attachment list, renders the
same session-start contract, caller-evidence block, and Evidence Broker checklist, and receives the
attachments at its sole call site. Making the parameter required turns future call-site omission
into a compile-time error.

No human/operator upload is introduced. Authenticated caller evidence remains automatically
persisted, activated, transported, and reused.

## Defect 3 — terminal Perplexity message was not a text fallback

The official Perplexity streaming documentation shows that a terminal
`chat.completion.done` event can contain the aggregate assistant response in
`choices[].message.content` while `choices[].delta.content` is empty. The adapter accumulated only
delta content. A terminal-only or aggregate-only representation could therefore become an empty
local result and unnecessarily trigger a second paid call.

The adapter now uses terminal `message.content` only when the accumulated delta stream produces no
usable post-`<think>` text. Delta output remains authoritative when present, preventing duplicate
content. The same behavior applies to reviewer and relator streaming paths.

The persisted provider artifact now records non-sensitive diagnostics instead of chain-of-thought
bytes: request ID, finish reasons, delta character count, terminal-message character count, visible
character count, whether the fallback was used, and whether usable output remained empty.

## What is and is not established about the provider call

The following is established empirically for the first Perplexity attempt:

- one stream chunk was observed;
- provider usage reported 10,120 prompt tokens and zero completion tokens;
- the adapter persisted zero usable output characters;
- the call completed within the configured 30-minute timeout, so it was not a timeout.

It is not possible to determine from 4.5.35 artifacts whether the wire carried no assistant bytes,
only a stripped `<think>` block, or aggregate terminal content that the adapter ignored. The raw
terminal event was not persisted. The new bounded telemetry resolves that observability gap without
storing private reasoning text.

## Official Perplexity contract consulted

- [Sonar API quickstart](https://docs.perplexity.ai/docs/sonar/quickstart): streaming support,
  OpenAI-compatible response structure, and terminal `finish_reason`.
- [Core features](https://docs.perplexity.ai/docs/sonar/features): streamed content chunks and
  documented JSON Schema `response_format`.
- [Sonar API reference](https://docs.perplexity.ai/api-reference/sonar-post): canonical request
  parameters and supported `sonar-reasoning-pro` model.
- [Stream mode](https://docs.perplexity.ai/docs/sonar/pro-search/stream-mode): terminal
  `chat.completion.done` representation with aggregate `message.content` and an empty delta.
- [Sonar Reasoning Pro](https://docs.perplexity.ai/docs/sonar/models/sonar-reasoning-pro): documented
  `<think>` preamble behavior and recommendation to extract the following JSON object.
- [SDK configuration](https://docs.perplexity.ai/docs/sdk/configuration): configurable retries and
  timeout examples. The examples are not provider service-level limits.

No undocumented API behavior is treated as a contract. Where the documentation does not state
whether a successful terminal event with zero completion tokens is valid, this report records the
observation without attributing fault to the provider.

## Regression coverage

The directed regressions cover:

- raw JSON fragments ending in `}`, `true`, or a numeric value;
- multi-line byte-exact JSON excerpts;
- invented suffixes, incorrect digests, and mixed valid/non-contiguous sources remaining blocked;
- required preservation of caller evidence, path, digest, and checklist in decision retry;
- terminal-only Perplexity aggregate content for both reviewer and relator streaming paths;
- bounded terminal diagnostics and `<think>` filtering.

The remediation deliberately does not weaken fabrication detection, attachment custody, blocking
claim relevance, or the requirement that every supplied source be independently groundable.
