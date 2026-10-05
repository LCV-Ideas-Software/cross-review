import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { reviewableEvidenceAttachments } from "../src/core/orchestrator.js";
import { SessionStore } from "../src/core/session-store.js";

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-evidence-custody-"));
const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });

const session = await store.init("Evidence custody smoke", "codex", []);
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
// v07.00.00: there is no trusted corpus to be excluded from. A digest-verified
// attachment attributed to a peer is auditable and caller-submitted, which is
// now the only provenance any attachment can have.
assert.equal(resolved[0]?.authority_status, "caller_submitted_unverified");

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

// Historical deduplication must check and read one native file descriptor.
// A local replacement or growth must not bypass the custody size/read bound.
for (const scenario of [
  "intact",
  "short-reads",
  "same-size-corruption",
  "rename-after-check",
  "growth-after-check",
] as const) {
  const dedupeSession = await store.init(`Historical custody: ${scenario}`, "codex", []);
  const proof = "SYNTHETIC_COMPLETE_CUSTODY_BYTES_71b0ca";
  const params = {
    submitted_by: "codex" as const,
    artifact_text: "Synthetic source artifact for custody verification",
    items: [{ label: "caller-structured-evidence", content: proof }],
  };
  const original = await store.attachCallerEvidenceSubmission(dedupeSession.session_id, params);
  const originalPath = original.submission.attachment_paths[0];
  assert.ok(originalPath);
  const originalFile = path.join(store.sessionDir(dedupeSession.session_id), originalPath);
  const preservedFile = `${originalFile}.preserved`;
  const replacementFile = `${originalFile}.replacement`;
  const proofBytes = Buffer.byteLength(proof, "utf8");
  if (scenario === "same-size-corruption") {
    fs.writeFileSync(originalFile, Buffer.alloc(proofBytes, 0x58));
  } else if (scenario === "rename-after-check") {
    fs.writeFileSync(replacementFile, Buffer.alloc(2_000_000, 0x58));
  }
  const nativeStat = fs.statSync;
  const nativeFstat = fs.fstatSync;
  const nativeOpen = fs.openSync;
  const nativeReadFile = fs.readFileSync;
  const nativeRead = fs.readSync;
  const nativeClose = fs.closeSync;
  let candidateFd: number | undefined;
  let fdClosed = false;
  let changed = false;
  let readBytes = 0;
  let largestReadRequest = 0;
  let readingWholeFile = false;
  const replaceAfterCheck = () => {
    if (scenario !== "rename-after-check" || changed) return;
    changed = true;
    fs.renameSync(originalFile, preservedFile);
    fs.renameSync(replacementFile, originalFile);
  };
  const growBeforeRead = () => {
    if (scenario !== "growth-after-check" || changed) return;
    changed = true;
    fs.writeFileSync(originalFile, Buffer.alloc(2_000_000, 0x58));
  };
  fs.statSync = ((file: fs.PathLike, options?: fs.StatOptions) => {
    const existing = nativeStat(file, options as never);
    if (file === originalFile) replaceAfterCheck();
    return existing;
  }) as typeof fs.statSync;
  fs.openSync = (file, flags, mode) => {
    const fd = nativeOpen(file, flags, mode);
    if (file === originalFile && candidateFd === undefined) candidateFd = fd;
    return fd;
  };
  fs.fstatSync = ((fd: number, options?: fs.StatOptions) => {
    const existing = nativeFstat(fd, options as never);
    if (fd === candidateFd) replaceAfterCheck();
    return existing;
  }) as typeof fs.fstatSync;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, options?: unknown) => {
    const candidate = file === originalFile || file === candidateFd;
    if (candidate) growBeforeRead();
    const previous = readingWholeFile;
    readingWholeFile = true;
    try {
      const value = nativeReadFile(file, options as never);
      if (candidate) readBytes += Buffer.byteLength(value);
      return value;
    } finally {
      readingWholeFile = previous;
    }
  }) as typeof fs.readFileSync;
  fs.readSync = ((
    fd: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    if (fd === candidateFd) {
      growBeforeRead();
      if (!readingWholeFile) largestReadRequest = Math.max(largestReadRequest, length);
    }
    const amount = nativeRead(
      fd,
      buffer,
      offset,
      scenario === "short-reads" && fd === candidateFd ? Math.min(length, 5) : length,
      position,
    );
    if (fd === candidateFd && !readingWholeFile) readBytes += amount;
    return amount;
  }) as typeof fs.readSync;
  fs.closeSync = (fd) => {
    nativeClose(fd);
    if (fd === candidateFd) fdClosed = true;
  };
  let repeated: Awaited<ReturnType<typeof store.attachCallerEvidenceSubmission>>;
  try {
    repeated = await store.attachCallerEvidenceSubmission(dedupeSession.session_id, params);
  } finally {
    fs.statSync = nativeStat;
    fs.fstatSync = nativeFstat;
    fs.openSync = nativeOpen;
    fs.readFileSync = nativeReadFile;
    fs.readSync = nativeRead;
    fs.closeSync = nativeClose;
  }
  const intact = scenario === "intact" || scenario === "short-reads";
  assert.equal(
    repeated.submission.attachment_paths[0] === originalPath,
    intact,
    `${scenario}: only exact current file bytes may reuse historical custody`,
  );
  assert.ok(readBytes <= proofBytes + 1, `${scenario}: reading must remain bounded by custody`);
  assert.ok(largestReadRequest <= proofBytes + 1);
  assert.ok(candidateFd !== undefined && fdClosed, `${scenario}: native descriptor must close`);
  if (scenario === "rename-after-check") {
    assert.equal(changed, true);
    assert.equal(fs.readFileSync(preservedFile, "utf8"), proof);
    assert.equal(fs.statSync(originalFile).size, 2_000_000);
  } else if (scenario === "growth-after-check") {
    assert.equal(changed, true);
    assert.equal(readBytes, proofBytes + 1, "growth must stop at the first unexpected byte");
    assert.equal(fs.statSync(originalFile).size, 2_000_000);
  }
  assert.equal(repeated.meta.evidence_files?.length, intact ? 1 : 2);
  const active = store.readEvidenceAttachments(dedupeSession.session_id, 200_000);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.content, proof);
  assert.equal(active[0]?.provenance_status, "verified");
  assert.equal(active[0]?.authority_status, "caller_submitted_unverified");
  assert.equal(store.read(dedupeSession.session_id).in_flight, undefined);
}

// Opening a replaced FIFO must not wait for a writer before fstat rejects it.
// Run the native POSIX fixture in a bounded child so a regression cannot hang.
if (process.platform !== "win32") {
  const fifoSession = await store.init("Historical custody replaced with FIFO", "codex", []);
  const params = {
    submitted_by: "codex" as const,
    artifact_text: "Synthetic FIFO custody fixture",
    items: [{ label: "caller-structured-evidence", content: "SYNTHETIC_FIFO_PROOF_71b0ca" }],
  };
  const original = await store.attachCallerEvidenceSubmission(fifoSession.session_id, params);
  const originalPath = original.submission.attachment_paths[0];
  assert.ok(originalPath);
  const originalFile = path.join(store.sessionDir(fifoSession.session_id), originalPath);
  fs.unlinkSync(originalFile);
  const creation = spawnSync("mkfifo", [originalFile], { encoding: "utf8", timeout: 5_000 });
  assert.equal(creation.status, 0, creation.stderr || String(creation.error));
  assert.equal(fs.lstatSync(originalFile).isFIFO(), true);
  const childSource = [
    `import { loadConfig } from ${JSON.stringify(new URL("../src/core/config.ts", import.meta.url).href)};`,
    `import { SessionStore } from ${JSON.stringify(new URL("../src/core/session-store.ts", import.meta.url).href)};`,
    `const store = new SessionStore({ ...loadConfig(), data_dir: ${JSON.stringify(dataDir)} });`,
    `const result = await store.attachCallerEvidenceSubmission(${JSON.stringify(fifoSession.session_id)}, ${JSON.stringify(params)});`,
    "console.log(JSON.stringify({ attachment_paths: result.submission.attachment_paths, in_flight: Boolean(result.meta.in_flight) }));",
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", childSource],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );
  assert.equal(child.error, undefined, "native FIFO rejection must finish without timeout");
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim()) as {
    attachment_paths: string[];
    in_flight: boolean;
  };
  assert.notEqual(result.attachment_paths[0], originalPath);
  assert.equal(result.in_flight, false);
  assert.equal(fs.lstatSync(originalFile).isFIFO(), true, "rejected history must remain intact");
  assert.equal(
    store.readEvidenceAttachments(fifoSession.session_id, 200_000)[0]?.content,
    params.items[0]?.content,
  );
} else {
  console.log("[smoke] historical FIFO control: SKIP (POSIX native fixture)");
}

// Regression contract: attachment paths must remain unique even when several
// submissions with the same label are created during the exact same clock
// tick. Otherwise later writes replace earlier bytes while metadata retains
// each original digest, and the custody reader fails with an integrity
// mismatch.
const collisionSession = await store.init("Concurrent evidence path collision", "codex", []);
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
        attached_by: "claude",
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

const legacySession = await store.init("Legacy evidence compatibility", "codex", []);
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
// Legacy attachments stay readable for audit and keep their own marker.
assert.equal(legacyResolved[0]?.authority_status, "legacy_unverified");

// v07.00.00 contract change: this case used to attach evidence AS the operator
// and assert it was promoted to "operator_verified". That attribution named a
// caller with no channel to this server, so the tier was never reachable in a
// real session. Attaching through the same surface as a peer now yields the
// one provenance that exists.
const promotionSession = await store.init("Attachment provenance", "claude", []);
await store.attachEvidence(promotionSession.session_id, {
  label: "peer-proof",
  content: "peer-custodied proof",
  attached_by: "claude",
  origin: "session_attach_evidence",
});
const promotionResolved = store.readEvidenceAttachments(promotionSession.session_id, 10_000);
assert.equal(
  promotionResolved[0]?.authority_status,
  "caller_submitted_unverified",
  "v07.00.00: session_attach_evidence promotes nothing; there is no tier above caller-submitted",
);

const finalizedSession = await store.init("Finalized evidence rejection", "claude", []);
await store.finalize(finalizedSession.session_id, "aborted", "smoke-finalized");
const filesBeforeRejectedAttach = fs.readdirSync(store.sessionDir(finalizedSession.session_id));
await assert.rejects(
  store.attachEvidence(finalizedSession.session_id, {
    label: "too-late",
    content: "must not be persisted",
    attached_by: "claude",
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
const silentSession = await store.init("Requester silence stays unresolved", "codex", []);
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

const requesterSession = await store.init("Requester reverification lifecycle", "codex", []);
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

const immutableTerminal = await store.init("Terminal immutability", "codex", []);
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
