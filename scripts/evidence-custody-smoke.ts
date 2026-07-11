import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { trustedEvidenceAttachments } from "../src/core/orchestrator.js";
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
  origin: "session_attach_evidence",
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
assert.equal(attachment.origin, "session_attach_evidence");
assert.match(attachment.attached_at, /^\d{4}-\d{2}-\d{2}T/);
assert.equal(attachment.ts, attachment.attached_at, "legacy ts alias must stay synchronized");

const resolved = store.readEvidenceAttachments(session.session_id, 10_000);
assert.equal(resolved.length, 1);
assert.equal(resolved[0]?.content, content);
assert.equal(resolved[0]?.bytes, expectedBytes);
assert.equal(resolved[0]?.sha256, expectedSha256);
assert.equal(resolved[0]?.attached_by, "claude");
assert.equal(resolved[0]?.origin, "session_attach_evidence");
assert.equal(resolved[0]?.provenance_status, "verified");
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
  origin: "session_attach_evidence",
});

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

console.log("[smoke] evidence_custody_test: PASS");
