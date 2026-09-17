// v09.01.00 — the provider's error object is preserved, not discarded
// (CROSREV-50, issue #320).
//
// The defect this closes was found the expensive way. In session `5c55f692` a
// peer refused three rounds with the bare literal `invalid request`. The
// persisted record kept `message`, `failure_class` and `latency_ms`, and
// dropped the HTTP status, `type`, `code` and body — so the investigation could
// not separate two causes that demand opposite responses:
//
//   creation rejected (400)  → OUR request body is wrong; we fix it
//   background job failed    → the provider's, after accepting the request
//
// Lacking the fields, that investigation inferred from timing and concluded the
// wrong one. A live probe disproved it: the full payload, every field in
// isolation, `max_output_tokens` to 128,000 and inputs to 900,000 characters
// are all accepted. What actually distinguished the two was the SHAPE of the
// error object — precisely what was not persisted.
//
// So the acceptance criterion these cases enforce is not "the fields exist". It
// is that an investigator can reach the right verdict READING ONLY THE RECORD,
// with no new call to the provider. Case 3 is that criterion, and it is written
// as the discriminator an investigator would actually apply.
import assert from "node:assert/strict";
import type { PeerFailure } from "../src/core/types.js";
import { classifyProviderError } from "../src/peers/errors.js";

const STARTED = Date.now();

function classify(error: unknown): PeerFailure {
  return classifyProviderError("perplexity", "perplexity", "perplexity/kimi-k3", error, 1, STARTED);
}

/**
 * The verdict an investigator reaches from the persisted record alone. It reads
 * only fields the record carries — never the live provider.
 */
function verdictFromRecord(failure: PeerFailure): "creation_rejected" | "job_failed" | "unknown" {
  const detail = failure.provider_error_detail;
  if (!detail) return "unknown";
  const status = detail.http_status;
  const rejectedAtCreation =
    (status !== undefined && status >= 400 && status <= 499) ||
    detail.type !== undefined ||
    detail.code !== undefined;
  if (rejectedAtCreation) return "creation_rejected";
  // The request was accepted and the failure arrived later: a message with no
  // structured error fields is what an already-created job reports.
  return failure.message ? "job_failed" : "unknown";
}

// --- 1. a creation-time 400 keeps every field the provider sent -------------
{
  const error = Object.assign(new Error("Invalid value for 'reasoning.effort'"), {
    status: 400,
    error: {
      message: "Invalid value for 'reasoning.effort'",
      type: "invalid_request_error",
      code: "invalid_value",
      param: "reasoning.effort",
    },
  });
  const failure = classify(error);
  const detail = failure.provider_error_detail;
  assert.ok(detail, "a structured provider error must be preserved");
  assert.equal(detail.http_status, 400, "the status decides creation-vs-job and must survive");
  assert.equal(detail.type, "invalid_request_error", "the provider's type must survive verbatim");
  assert.equal(detail.code, "invalid_value", "and its code");
  assert.equal(detail.param, "reasoning.effort", "and the parameter it names");
  assert.match(
    detail.raw_body ?? "",
    /invalid_request_error/,
    "the body must carry the diagnosis, not an SDK wrapper",
  );
  console.log("[v9.1.0-provider-error-detail] creation_400_preserves_every_field: PASS");
}

// --- 2. the measured async failure, reproduced in its exact shape -----------
// This is session `5c55f692` as it actually arrived: the bare literal, with no
// `type`, no `code` and no HTTP status, because creation had returned 200 and
// the failure surfaced at the first poll of the background job.
{
  const error = Object.assign(new Error("invalid request"), {
    error: { message: "invalid request" },
  });
  const failure = classify(error);
  const detail = failure.provider_error_detail;
  assert.ok(detail, "even a bare provider error must leave a record of its shape");
  assert.equal(detail.type, undefined, "there was no type, and none may be invented");
  assert.equal(detail.code, undefined, "nor a code");
  assert.equal(detail.http_status, undefined, "and no 4xx, because creation succeeded");
  assert.match(detail.raw_body ?? "", /invalid request/, "the body is what there was");
  console.log("[v9.1.0-provider-error-detail] bare_async_failure_records_its_shape: PASS");
}

// --- 3. THE ACCEPTANCE CRITERION: the record alone decides ------------------
// Both records, read with no access to the provider, must yield opposite and
// correct verdicts. Before this change both produced `unknown`, which is the
// whole defect: two different causes collapsing into one indistinguishable
// record.
{
  const creation = classify(
    Object.assign(new Error("Invalid value for 'reasoning.effort'"), {
      status: 400,
      error: { message: "Invalid value", type: "invalid_request_error", code: "invalid_value" },
    }),
  );
  const asyncJob = classify(
    Object.assign(new Error("invalid request"), { error: { message: "invalid request" } }),
  );

  assert.equal(
    verdictFromRecord(creation),
    "creation_rejected",
    "a 400 with type and code is our request body, and the record must say so",
  );
  assert.equal(
    verdictFromRecord(asyncJob),
    "job_failed",
    "a bare message with no structured fields is the provider's job, not our body",
  );
  assert.notEqual(
    verdictFromRecord(creation),
    verdictFromRecord(asyncJob),
    "the two causes must not collapse into the same verdict — that collapse WAS the defect",
  );
  console.log("[v9.1.0-provider-error-detail] the_record_alone_decides_the_cause: PASS");
}

// --- 4. a secret in the body never reaches the record -----------------------
// An error body can echo fragments of the request, including credentials. The
// body is redacted as STRUCTURE before serialization, so this is not a string
// scrub applied after the fact.
{
  const leaked = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const error = Object.assign(new Error("auth failed"), {
    status: 400,
    error: {
      message: "auth failed",
      type: "invalid_request_error",
      echoed_header: `Bearer ${leaked}`,
      echoed_key: leaked,
    },
  });
  const failure = classify(error);
  const body = failure.provider_error_detail?.raw_body ?? "";
  assert.ok(body, "the body must still be recorded");
  assert.ok(
    !body.includes(leaked),
    `a credential must never survive into the record; got: ${body.slice(0, 200)}`,
  );
  assert.match(body, /invalid_request_error/, "while the diagnosis itself is kept");
  console.log("[v9.1.0-provider-error-detail] secrets_never_reach_the_record: PASS");
}

// --- 5. an oversized body is capped, and says that it was -------------------
// Silent truncation would be its own version of this bug: a reader cannot tell
// a short body from a cut one unless the record says which it is.
{
  const error = Object.assign(new Error("payload rejected"), {
    status: 413,
    error: {
      message: "payload rejected",
      type: "invalid_request_error",
      detail: "x".repeat(50_000),
    },
  });
  const failure = classify(error);
  const detail = failure.provider_error_detail;
  assert.ok(detail?.raw_body, "an oversized body is still recorded");
  assert.ok(
    (detail.raw_body?.length ?? 0) <= 4_096,
    `the ceiling must hold; got ${detail.raw_body?.length}`,
  );
  assert.equal(detail.raw_body_truncated, true, "and truncation must be declared, never silent");
  assert.equal(detail.http_status, 413, "the fields that decide the cause survive the cap");
  console.log("[v9.1.0-provider-error-detail] oversized_body_is_capped_and_says_so: PASS");
}

// --- 6. an unserializable body must not take the round down ----------------
// Losing the body is acceptable. Losing the failure record — and with it the
// round — is not.
{
  const cyclic: Record<string, unknown> = { message: "boom", type: "server_error" };
  cyclic.self = cyclic;
  const error = Object.assign(new Error("boom"), { status: 500, error: cyclic });
  const failure = classify(error);
  assert.equal(failure.peer, "perplexity", "the failure record must exist");
  assert.equal(
    failure.provider_error_detail?.http_status,
    500,
    "and keep the fields that do serialize",
  );
  assert.equal(
    failure.provider_error_detail?.type,
    "server_error",
    "including the type read before serialization",
  );
  console.log("[v9.1.0-provider-error-detail] unserializable_body_never_kills_the_record: PASS");
}

// --- 7. CONTROL: nothing to preserve means no field ------------------------
// An empty object would be worse than absence: it asserts that the provider
// said nothing, when in fact nothing was ever offered to read.
{
  const failure = classify(new Error("socket hang up"));
  assert.equal(
    failure.provider_error_detail,
    undefined,
    "CONTROL: with no status and no structured error, the field must be absent, not empty",
  );
  console.log("[v9.1.0-provider-error-detail] control_absent_when_there_is_nothing: PASS");
}

console.log("[v9.1.0-provider-error-detail] ALL CASES PASS");
