// v07.00.00 (PR #300 review round 6) — the two authority rules this release
// asserts must hold at RUNTIME, not only in the type system and not only for
// callers that arrive through the MCP layer.
//
// 1. `caller` is required and must be a peer. The declaration `caller: PeerId`
//    is erased in the shipped JavaScript, and `askPeers` used to read a missing
//    caller as `"operator"` — the identity v07.00.00 retired precisely because
//    it was exempt from auto-recusal and from the no-self-review guard. A
//    JavaScript consumer importing dist/src/core/orchestrator.js recreated that
//    hole by omission, and could persist sessions with no usable owner.
//
// 2. An owner-scoped mutation needs the owner's TOKEN, not a self-report. With
//    hard enforcement off and no token installed, a client whose declared
//    `clientInfo.name` matches its declared `caller` passes identity
//    verification with `verification_method="client_info"`. That is the client
//    describing itself. Every owner-scoped mutation runs through
//    `assertOwnerTokenVerified`, so the rule has one statement; round 5 scoped
//    recovery by ownership but left it on identity alone, and session_doctor's
//    repair pass was never scoped at all.
//
// Each case carries the control that would catch the opposite mistake: a guard
// that refuses everything, or a token rule that refuses nothing.
import assert from "node:assert/strict";
import { loadConfig } from "../src/core/config.js";
import { CrossReviewOrchestrator } from "../src/core/orchestrator.js";
import type { CallerIdentityResult } from "../src/mcp/server.js";
import { assertOwnerTokenVerified } from "../src/mcp/server.js";

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

function captured(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected_throw_did_not_happen");
}

async function capturedAsync(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected_rejection_did_not_happen");
}

// --- 1. a missing caller is refused at both public entry points -----------
{
  const orchestrator = new CrossReviewOrchestrator(loadConfig());
  // The cast is the point of the case: this is what a JavaScript consumer of
  // the shipped module can do, and what the type system cannot prevent.
  const withoutCaller = { task: "Anything.", initial_draft: "Body." } as unknown as Parameters<
    CrossReviewOrchestrator["runUntilUnanimous"]
  >[0];
  const runError = await capturedAsync(() => orchestrator.runUntilUnanimous(withoutCaller));
  assert.match(
    String(runError),
    /caller_required/,
    `runUntilUnanimous must refuse a missing caller rather than invent one; got ${String(runError)}`,
  );

  const askWithoutCaller = { task: "Anything.", draft: "Body." } as unknown as Parameters<
    CrossReviewOrchestrator["askPeers"]
  >[0];
  const askError = await capturedAsync(() => orchestrator.askPeers(askWithoutCaller));
  assert.match(
    String(askError),
    /caller_required/,
    `askPeers must refuse a missing caller — it used to read one as "operator"; got ${String(askError)}`,
  );

  const notAPeer = {
    task: "Anything.",
    initial_draft: "Body.",
    caller: "operator",
  } as unknown as Parameters<CrossReviewOrchestrator["runUntilUnanimous"]>[0];
  const operatorError = await capturedAsync(() => orchestrator.runUntilUnanimous(notAPeer));
  assert.match(
    String(operatorError),
    /caller_required/,
    `the retired "operator" identity must be refused by name too; got ${String(operatorError)}`,
  );
  console.log("[v7.0.0-authority] missing_caller_is_refused_at_the_runtime_boundary: PASS");
}

// --- 2. CONTROL: a real peer is not refused by that guard ----------------
// A guard that refused everything would satisfy case 1 completely.
{
  const orchestrator = new CrossReviewOrchestrator(loadConfig());
  const error = await capturedAsync(() =>
    orchestrator.runUntilUnanimous({
      task: "Anything.",
      initial_draft: "Body.",
      caller: "claude",
      peers: ["codex"],
      max_rounds: 1,
    }),
  ).catch(() => null);
  assert.ok(
    error === null || !/caller_required/.test(String(error)),
    `CONTROL: a declared peer must pass the caller guard; got ${String(error)}`,
  );
  console.log("[v7.0.0-authority] control_a_real_peer_passes_the_caller_guard: PASS");
}

// --- 3. a self-reported identity cannot mutate an owner's session ---------
{
  const selfReported: CallerIdentityResult = {
    identity_verified: true,
    verification_method: "client_info",
    client_info_name: "claude",
    identity_metadata: {},
  } as unknown as CallerIdentityResult;
  const error = captured(() =>
    assertOwnerTokenVerified("session_recover_interrupted", selfReported, "claude"),
  );
  assert.match(
    String(error),
    /session_owner_token_required/,
    `an owner-scoped mutation must require the capability token, not a self-declared clientInfo match; got ${String(error)}`,
  );

  // CONTROL: with the token the same call must pass, or the rule would be
  // refusing every caller rather than refusing self-reports.
  const tokenVerified: CallerIdentityResult = {
    identity_verified: true,
    verification_method: "token",
    client_info_name: "claude",
    identity_metadata: {},
  } as unknown as CallerIdentityResult;
  assertOwnerTokenVerified("session_recover_interrupted", tokenVerified, "claude");
  console.log("[v7.0.0-authority] owner_scoped_mutation_requires_the_token: PASS");
}

// --- 4. the store boundary refuses an ownerless session ------------------
// Round 6 guarded two orchestrator entry points, round 7 a third, and round 8
// found this one: `SessionStore.init` writes `caller` straight to disk, and its
// own comment already claimed only a peer may open a session. A JavaScript
// consumer of dist/ could persist a v7 session owned by nobody — which no
// ownership check can ever satisfy — or by the retired "operator".
{
  const orchestrator = new CrossReviewOrchestrator(loadConfig());
  const store = orchestrator.store;
  const missing = await capturedAsync(() =>
    (store.init as unknown as (t: string, c: unknown, s: unknown[]) => Promise<unknown>)(
      "Anything.",
      undefined,
      [],
    ),
  );
  assert.match(
    String(missing),
    /caller_required/,
    `SessionStore.init must refuse an ownerless session; got ${String(missing)}`,
  );
  const retired = await capturedAsync(() =>
    (store.init as unknown as (t: string, c: unknown, s: unknown[]) => Promise<unknown>)(
      "Anything.",
      "operator",
      [],
    ),
  );
  assert.match(
    String(retired),
    /caller_required/,
    `SessionStore.init must refuse the retired identity by name; got ${String(retired)}`,
  );
  // CONTROL: a real peer still opens a session, or the guard would be refusing
  // every caller rather than refusing the two that cannot own one.
  const opened = await store.init("Anything.", "claude", []);
  assert.equal(
    opened.caller,
    "claude",
    "CONTROL: a declared peer must still be able to open a session",
  );
  console.log("[v7.0.0-authority] store_boundary_refuses_ownerless_sessions: PASS");
}

console.log("[v7.0.0-authority] ALL CASES PASS");
