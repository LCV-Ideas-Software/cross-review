import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import {
  reviewableEvidenceAttachments,
  trustedEvidenceAttachments,
} from "../src/core/orchestrator.js";
import { SessionStore } from "../src/core/session-store.js";

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-evidence-custody-"));
const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });

const session = await store.init("Evidence custody smoke", "operator", []);
const content = "evidencia persistida com bytes UTF-8: foguete 🚀";
const expectedBytes = Buffer.byteLength(content, "utf8");
const expectedSha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");

const attached = await store.attachEvidence(session.session_id, {
  label: "runtime-proof",
  content,
  content_type: "text/plain; charset=utf-8",
  extension: "txt",
  attached_by: "claude",
  origin: "caller_submitted",
});

const attachment = attached.meta.evidence_files?.at(-1);
assert.ok(attachment, "attachment metadata must be registered");
assert.ok(
  "integrity_version" in attachment,
  "new attachments must use the custody-aware metadata shape",
);
assert.equal(attachment.sha256, expectedSha256);
assert.equal(attachment.bytes, expectedBytes);
assert.equal(attachment.attached_by, "claude");
assert.equal(attachment.origin, "caller_submitted");
assert.match(attachment.attached_at, /^\d{4}-\d{2}-\d{2}T/);
assert.equal(attachment.ts, attachment.attached_at, "legacy ts alias must stay synchronized");

const resolved = store.readEvidenceAttachments(session.session_id, 10_000);
assert.equal(resolved.length, 1);
assert.equal(resolved[0]?.content, content);
assert.equal(resolved[0]?.bytes, expectedBytes);
assert.equal(resolved[0]?.sha256, expectedSha256);
assert.equal(resolved[0]?.attached_by, "claude");
assert.equal(resolved[0]?.origin, "caller_submitted");
assert.equal(resolved[0]?.provenance_status, "verified");
assert.equal(resolved[0]?.authority_status, "caller_submitted_unverified");
assert.equal(reviewableEvidenceAttachments(resolved).length, 1);
assert.deepEqual(
  trustedEvidenceAttachments(resolved),
  [],
  "a digest-verified attachment attributed to a peer is auditable but cannot become trusted proof",
);

const attachedEvent = store
  .readEvents(session.session_id)
  .find((event) => event.type === "session.evidence_attached");
assert.ok(attachedEvent, "attachment must persist a durable custody event");
assert.deepEqual(attachedEvent.data, {
  label: "runtime-proof",
  path: attached.path,
  content_type: "text/plain; charset=utf-8",
  sha256: expectedSha256,
  bytes: expectedBytes,
  attached_by: "claude",
  attached_at: attachment.attached_at,
  origin: "caller_submitted",
  authority_status: "caller_submitted_unverified",
});

// Regression contract: attachment paths must remain unique even when several
// submissions with the same label are created during the exact same clock
// tick. Otherwise later writes replace earlier bytes while metadata retains
// each original digest, and the custody reader fails with an integrity
// mismatch.
const collisionSession = await store.init("Concurrent evidence path collision", "operator", []);
const realDate = globalThis.Date;
const fixedEpoch = realDate.parse("2026-07-11T12:34:56.789Z");
class FixedDate extends realDate {
  constructor() {
    super(fixedEpoch);
  }

  static override now(): number {
    return fixedEpoch;
  }
}

let concurrentAttachments: Awaited<ReturnType<typeof store.attachEvidence>>[];
try {
  globalThis.Date = FixedDate as DateConstructor;
  concurrentAttachments = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      store.attachEvidence(collisionSession.session_id, {
        label: "same-label",
        content: `collision-payload-${String(index).padStart(2, "0")}`,
        content_type: "text/plain; charset=utf-8",
        extension: "txt",
        attached_by: "operator",
        origin: "session_attach_evidence",
      }),
    ),
  );
} finally {
  globalThis.Date = realDate;
}

const concurrentPaths = concurrentAttachments.map((entry) => entry.path);
assert.equal(
  new Set(concurrentPaths).size,
  concurrentAttachments.length,
  "concurrent same-label attachments at a fixed clock tick must receive unique paths",
);
assert.doesNotThrow(() => {
  const collisionResolved = store.readEvidenceAttachments(collisionSession.session_id, 100_000);
  assert.equal(collisionResolved.length, concurrentAttachments.length);
  assert.deepEqual(
    collisionResolved.map((entry) => entry.content).sort(),
    Array.from(
      { length: concurrentAttachments.length },
      (_, index) => `collision-payload-${String(index).padStart(2, "0")}`,
    ).sort(),
  );
}, "concurrent attachments must remain independently readable without evidence_integrity_mismatch");

const absoluteEvidencePath = path.join(store.sessionDir(session.session_id), attached.path);
// Preserve byte length so this specifically proves the digest is rechecked,
// not merely that a changed file size is noticed.
fs.writeFileSync(absoluteEvidencePath, Buffer.alloc(expectedBytes, 0x58));
assert.throws(
  () => store.readEvidenceAttachments(session.session_id, 10_000),
  /evidence_integrity_mismatch/,
  "a changed attachment must fail closed instead of entering peer prompts",
);

const legacySession = await store.init("Legacy evidence compatibility", "operator", []);
const legacyRelativePath = "evidence/legacy.txt";
const legacyAbsolutePath = path.join(
  store.sessionDir(legacySession.session_id),
  legacyRelativePath,
);
fs.mkdirSync(path.dirname(legacyAbsolutePath), { recursive: true });
fs.writeFileSync(legacyAbsolutePath, "legacy body", "utf8");
const legacyMeta = store.read(legacySession.session_id);
legacyMeta.evidence_files = [
  {
    ts: "2026-01-01T00:00:00.000Z",
    label: "legacy",
    path: legacyRelativePath,
    content_type: "text/plain",
  },
];
fs.writeFileSync(
  store.metaPath(legacySession.session_id),
  `${JSON.stringify(legacyMeta, null, 2)}\n`,
);

const legacyResolved = store.readEvidenceAttachments(legacySession.session_id, 10_000);
assert.equal(legacyResolved.length, 1, "legacy attachments remain readable");
assert.equal(legacyResolved[0]?.content, "legacy body");
assert.equal(legacyResolved[0]?.provenance_status, "legacy_unverified");
assert.equal(legacyResolved[0]?.authority_status, "legacy_unverified");
assert.equal(legacyResolved[0]?.sha256, undefined);
assert.equal(legacyResolved[0]?.attached_by, undefined);
assert.deepEqual(
  trustedEvidenceAttachments(legacyResolved),
  [],
  "legacy attachments remain readable for audit but must never enter the trusted evidence corpus",
);

const operatorSession = await store.init("Operator evidence trust", "operator", []);
await store.attachEvidence(operatorSession.session_id, {
  label: "operator-proof",
  content: "operator-custodied proof",
  attached_by: "operator",
  origin: "session_attach_evidence",
});
const operatorResolved = store.readEvidenceAttachments(operatorSession.session_id, 10_000);
assert.equal(operatorResolved[0]?.authority_status, "operator_verified");
assert.equal(
  trustedEvidenceAttachments(operatorResolved).length,
  1,
  "only current, integrity-checked operator custody may enter the trusted evidence corpus",
);

const finalizedSession = await store.init("Finalized evidence rejection", "operator", []);
await store.finalize(finalizedSession.session_id, "aborted", "smoke-finalized");
const filesBeforeRejectedAttach = fs.readdirSync(store.sessionDir(finalizedSession.session_id));
await assert.rejects(
  store.attachEvidence(finalizedSession.session_id, {
    label: "too-late",
    content: "must not be persisted",
    attached_by: "operator",
    origin: "session_attach_evidence",
  }),
  /session_already_finalized/,
);
assert.deepEqual(
  fs.readdirSync(store.sessionDir(finalizedSession.session_id)),
  filesBeforeRejectedAttach,
  "a rejected post-finalization attach must not leave an orphan file",
);
assert.equal(store.read(finalizedSession.session_id).evidence_files, undefined);
assert.equal(
  store
    .readEvents(finalizedSession.session_id)
    .filter((event) => event.type === "session.evidence_attached").length,
  0,
);

// v4.5.1 regression contract: a peer that originally requested evidence may
// close ONLY its own prior asks after returning a strictly grounded
// READY/verified verdict. This is a runtime transition, not an operator
// mutation. Mere silence remains `not_resurfaced` and must not be promoted.
const silentSession = await store.init("Requester silence stays unresolved", "operator", []);
await store.appendEvidenceChecklistItems(silentSession.session_id, 1, [
  { peer: "perplexity", ask: "Provide the raw release gate output." },
]);
const silentDetection = await store.runEvidenceChecklistAddressDetection(
  silentSession.session_id,
  2,
);
assert.equal(silentDetection.not_resurfaced.length, 1);
assert.equal(
  store.read(silentSession.session_id).evidence_checklist?.[0]?.status,
  "not_resurfaced",
  "silence alone must remain not_resurfaced; it is not requester reverification",
);

const requesterSession = await store.init("Requester reverification lifecycle", "operator", []);
const claudeOldAsk = "Provide raw output proving 74 passing tests.";
const claudeOpenAsk = "Provide the exact successful command exit code.";
const codexOpenAsk = "Provide the changed-file diff.";
const terminalAsks = [
  { peer: "gemini" as const, ask: "Terminal satisfied fixture.", status: "satisfied" as const },
  { peer: "deepseek" as const, ask: "Terminal deferred fixture.", status: "deferred" as const },
  { peer: "grok" as const, ask: "Terminal rejected fixture.", status: "rejected" as const },
];

await store.appendEvidenceChecklistItems(requesterSession.session_id, 1, [
  { peer: "claude", ask: claudeOldAsk },
]);
await store.runEvidenceChecklistAddressDetection(requesterSession.session_id, 2);
await store.appendEvidenceChecklistItems(requesterSession.session_id, 2, [
  { peer: "claude", ask: claudeOpenAsk },
  { peer: "codex", ask: codexOpenAsk },
  ...terminalAsks.map(({ peer, ask }) => ({ peer, ask })),
]);

let requesterMeta = store.read(requesterSession.session_id);
for (const fixture of terminalAsks) {
  const item = requesterMeta.evidence_checklist?.find((entry) => entry.ask === fixture.ask);
  assert.ok(item, `terminal fixture must exist: ${fixture.ask}`);
  await store.setEvidenceChecklistItemStatus(requesterSession.session_id, item.id, fixture.status, {
    note: "test fixture",
  });
  requesterMeta = store.read(requesterSession.session_id);
}

const beforeReverification = store.read(requesterSession.session_id);
const byAskBefore = new Map(
  (beforeReverification.evidence_checklist ?? []).map((item) => [item.ask, structuredClone(item)]),
);
assert.equal(byAskBefore.get(claudeOldAsk)?.status, "not_resurfaced");
assert.equal(byAskBefore.get(claudeOpenAsk)?.status ?? "open", "open");
assert.equal(byAskBefore.get(codexOpenAsk)?.status ?? "open", "open");

type RequesterReverificationStore = {
  markEvidenceItemsAddressedByRequesterReverification: (
    sessionId: string,
    params: {
      round: number;
      peer: "claude";
      evidence_sources: string[];
    },
  ) => Promise<unknown>;
};
const requesterReverificationStore = store as unknown as RequesterReverificationStore;
assert.equal(
  typeof requesterReverificationStore.markEvidenceItemsAddressedByRequesterReverification,
  "function",
  "RED/requester_reverified: SessionStore must expose the runtime requester-reverification transition",
);
await requesterReverificationStore.markEvidenceItemsAddressedByRequesterReverification(
  requesterSession.session_id,
  {
    round: 3,
    peer: "claude",
    evidence_sources: ["Tests 74 passed (74)\nEXIT_CODE: 0"],
  },
);

const afterReverification = store.read(requesterSession.session_id);
const byAskAfter = new Map(
  (afterReverification.evidence_checklist ?? []).map((item) => [item.ask, item]),
);
for (const ask of [claudeOldAsk, claudeOpenAsk]) {
  const item = byAskAfter.get(ask);
  assert.ok(item, `requester item must remain present: ${ask}`);
  assert.equal(item.status, "addressed", `${ask} must be addressed by its requester`);
  assert.equal(
    (item as typeof item & { address_method?: string }).address_method,
    "requester_reverified",
  );
  assert.equal(item.addressed_at_round, 3);
  assert.ok(
    afterReverification.evidence_status_history?.some(
      (entry) =>
        entry.item_id === item.id &&
        entry.to === "addressed" &&
        entry.by === "runtime" &&
        entry.round === 3 &&
        entry.note?.includes("requester_reverified[claude]"),
    ),
    `${ask} must have an auditable runtime requester_reverified history entry`,
  );
}

assert.deepEqual(
  byAskAfter.get(codexOpenAsk),
  byAskBefore.get(codexOpenAsk),
  "requester reverification must not close another peer's open ask",
);
for (const fixture of terminalAsks) {
  assert.deepEqual(
    byAskAfter.get(fixture.ask),
    byAskBefore.get(fixture.ask),
    `requester reverification must preserve terminal status ${fixture.status}`,
  );
}

const immutableTerminal = await store.init("Terminal immutability", "operator", []);
const firstTerminal = await store.finalize(immutableTerminal.session_id, "aborted", "first");
const idempotentTerminal = await store.finalize(immutableTerminal.session_id, "aborted", "first");
assert.deepEqual(idempotentTerminal, firstTerminal, "exact terminal replay must be idempotent");
await assert.rejects(
  store.finalize(immutableTerminal.session_id, "max-rounds", "overwrite"),
  /session_already_finalized/,
  "a terminal outcome must never be overwritten by another terminal state",
);
await assert.rejects(
  store.markCancelled(immutableTerminal.session_id, "cancel-overwrite"),
  /session_already_finalized/,
  "markCancelled must not overwrite an existing terminal outcome",
);
assert.deepEqual(
  store.read(immutableTerminal.session_id),
  firstTerminal,
  "rejected cancellation must leave terminal metadata byte-for-byte unchanged",
);

console.log("[smoke] evidence_custody_test: PASS");
