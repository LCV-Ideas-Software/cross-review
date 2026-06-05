import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { redact } from "../security/redact.js";
import { mergeCost, mergeUsage } from "./cost.js";
import type {
  AppConfig,
  Confidence,
  ConvergenceResult,
  ConvergenceScope,
  EvidenceChecklistItem,
  EvidenceChecklistStatus,
  EvidenceStatusHistoryEntry,
  GenerationArtifact,
  GenerationResult,
  JudgmentPrecisionPeerStats,
  JudgmentPrecisionReport,
  PeerFailure,
  PeerHealthSummary,
  PeerId,
  PeerProbeResult,
  PeerResult,
  ReviewRound,
  ReviewStatus,
  RuntimeEvent,
  RuntimeMetrics,
  SessionDoctorEntry,
  SessionDoctorReport,
  SessionEvent,
  SessionMeta,
  ShadowJudgmentPeerStats,
  ShadowJudgmentRollup,
} from "./types.js";
import { PEERS } from "./types.js";

export const SWEEP_MIN_IDLE_MS = 24 * 60 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

function isStubSession(session: SessionMeta): boolean {
  const peerCosts = session.rounds.flatMap((round) => round.peers.map((peer) => peer.cost));
  const generationCosts = (session.generation_files ?? []).map((generation) => generation.cost);
  const costs = [...peerCosts, ...generationCosts].filter(Boolean);
  if (costs.length > 0) return costs.every((cost) => cost?.source === "stub");
  return session.capability_snapshot.some(
    (probe) => probe.provider.startsWith("stub-") || probe.model.startsWith("stub-"),
  );
}

function sessionPeerCostTotal(session: SessionMeta): number | null {
  let total = 0;
  let seen = false;
  for (const round of session.rounds) {
    for (const peer of round.peers) {
      const value = peer.cost?.total_cost;
      if (value == null || !Number.isFinite(value)) continue;
      seen = true;
      total += value;
    }
  }
  return seen ? total : null;
}

function sessionGenerationCostTotal(session: SessionMeta): number | null {
  let total = 0;
  let seen = false;
  for (const generation of session.generation_files ?? []) {
    const value = generation.cost?.total_cost;
    if (value == null || !Number.isFinite(value)) continue;
    seen = true;
    total += value;
  }
  return seen ? total : null;
}

function addNullableCost(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

// v2.4.0 / audit closure (P1.3): atomicWriteFile retry on Windows.
// `fs.renameSync` in Win32 fails with EPERM/EACCES/EBUSY when the
// destination is briefly held by another handle (AV scan, indexing,
// concurrent reader). Pre-v2.4.0 the rename threw and left the .tmp
// orphaned in the session directory. Now we (a) try rename, (b) on
// transient EPERM/EACCES/EBUSY/EEXIST retry up to 5 times with short
// backoff, (c) on terminal failure clean up the tmp file ourselves so
// the session directory does not accumulate `*.tmp` artifacts, (d)
// re-throw the last error so the caller still observes the failure.
// Mirrors the v1.6.7 P1.2 fix.
const ATOMIC_WRITE_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EEXIST"]);
const ATOMIC_WRITE_MAX_ATTEMPTS = 5;
const TMP_NONCE_BYTES = 2;

async function writeJson(file: string, data: unknown): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const nonce = crypto.randomBytes(TMP_NONCE_BYTES).toString("hex");
  const tmp = `${file}.${process.pid}.${Date.now()}.${nonce}.tmp`;
  fs.writeFileSync(tmp, redact(`${JSON.stringify(data, null, 2)}\n`), "utf8");
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < ATOMIC_WRITE_MAX_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !ATOMIC_WRITE_RETRY_CODES.has(code)) break;
      // v4.1.0 hardening: pre-v4.1.0 used `while (Date.now() - start <
      // wait) {}` busy-wait which blocked the single Node.js event loop
      // thread for up to 310 ms (10+20+40+80+160) under repeated
      // Windows-AV-induced EPERM/EBUSY contention. The CPU-burning
      // busy-wait starved SSE streaming + concurrent sessions + MCP
      // stdio reads. Now the backoff awaits a Promise-based timer:
      // event loop remains fully responsive between attempts.
      const wait = 10 * 2 ** attempt; // 10, 20, 40, 80, 160 ms
      await new Promise<void>((resolve) => {
        setTimeout(resolve, wait);
      });
    }
  }
  // Terminal failure path: best-effort tmp cleanup so callers don't see
  // the orphan accumulate even when the write itself failed.
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  throw lastErr;
}

// v2.4.0 / audit closure (P1.3 companion): boot sweep of orphan .tmp files.
// Crashes inside writeJson (between writeFileSync and renameSync) leave
// files matching `<basename>.<pid>.<ts>.<nonce>.tmp` in the session
// directory. They are never read but should not accumulate. Walk every
// session dir at boot, drop files matching the .tmp pattern whose holder
// pid is dead OR whose timestamp is older than 1h. Idempotent +
// best-effort.
const TMP_FILE_PATTERN = /\.(\d+)\.(\d+)\.[0-9a-f]+\.tmp$/;
const TMP_STALE_AFTER_MS = 60 * 60 * 1000; // 1h

function readJson<T>(file: string): T {
  // v2.4.0 / audit closure: contextualize JSON.parse failures so callers see
  // which file is malformed rather than a bare SyntaxError. Read errors
  // still propagate naturally (ENOENT, EACCES) so caller can branch.
  const raw = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse JSON at ${file}: ${message}`, { cause: err });
  }
}

function safeFilePart(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "evidence";
}

function timestampFilePart(): string {
  return now().replace(/[:.]/g, "-");
}

export class SessionStore {
  // v2.4.0 / audit closure (P3.13): in-memory monotonic seq counter per
  // session. Pre-v2.4.0 appendEvent recomputed seq by reading the events
  // file, splitting on newlines and counting non-empty lines — that race
  // remained even inside withSessionLock because two emit calls within
  // the same process could compute identical seqs if the OS write returned
  // before the next read. The cache below is initialized on first use
  // (lazy) by reading the existing file ONCE and is incremented strictly
  // monotonically thereafter. Restart re-initializes from disk, so seq
  // remains correct across process boundaries.
  private readonly seqCache = new Map<string, number>();
  // v4.1.0: track in-flight fire-and-forget appendEvent promises so
  // callers that need synchronous read-after-write semantics (smoke
  // tests, post-round aggregation) can call `flushPendingEvents()` to
  // wait for all pending event writes to settle before reading.
  // appendEvent is async because withSessionLock is async (proper-
  // lockfile); the emit pipeline must stay sync, so it uses
  // `void store.appendEvent(event)` and the store remembers the
  // promise here. Promises resolve/reject within appendEvent's own
  // try/catch — flush() therefore always settles, never rejects.
  private readonly pendingEventWrites = new Set<Promise<void>>();

  constructor(private readonly config: AppConfig) {
    fs.mkdirSync(this.sessionsDir(), { recursive: true });
  }

  sessionsDir(): string {
    return path.join(this.config.data_dir, "sessions");
  }

  sessionDir(sessionId: string): string {
    this.assertSessionId(sessionId);
    const sessionsRoot = fs.realpathSync(this.sessionsDir());
    const candidate = path.resolve(sessionsRoot, sessionId);
    const containedCandidate = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
    if (!this.isPathContained(sessionsRoot, containedCandidate)) {
      throw new Error(`session path escapes data directory: ${sessionId}`);
    }
    return containedCandidate;
  }

  metaPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "meta.json");
  }

  eventsPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "events.ndjson");
  }

  assertSessionId(sessionId: string): void {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(sessionId)) {
      throw new Error(`invalid session_id: ${sessionId}`);
    }
  }

  private isPathContained(parent: string, target: string): boolean {
    const relative = path.relative(parent, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private totalsFor(meta: SessionMeta): SessionMeta["totals"] {
    const peerResults = meta.rounds.flatMap((round) => round.peers);
    const generations = meta.generation_files ?? [];
    return {
      usage: mergeUsage([
        ...peerResults.map((peer) => peer.usage),
        ...generations.map((generation) => generation.usage),
      ]),
      cost: mergeCost([
        ...peerResults.map((peer) => peer.cost),
        ...generations.map((generation) => generation.cost),
      ]),
    };
  }

  // v4.1.0 hardening: pre-v4.1.0 acquired the lock via an exclusive
  // file-create syscall followed by a separate JSON metadata write,
  // which had a multi-process TOCTOU race window. Process A's create
  // returned an empty inode + fd; before A's metadata write executed,
  // process B could observe the empty file, fail to JSON-parse it,
  // remove the lock path, create its own valid lock, and enter the
  // critical section. Process A would then write into the now-orphan
  // inode via the still-open fd and ALSO enter the critical section,
  // corrupting meta.json. proper-lockfile uses `fs.mkdir` (atomic
  // across NTFS and POSIX) so the lock comes into existence as a
  // directory in a single syscall — no empty-window race possible.
  // The mkdir-based lock also fixes the lock-holder freshness signal:
  // proper-lockfile's `update` interval touches the lockfile's mtime
  // every 5 s, and any other process treats the lock as stale once the
  // mtime is older than `stale` ms (120 s). This is more robust than
  // the pre-v4.1.0 PID-aliveness check, which had collision risk after
  // process restart.
  private async withSessionLock<T>(sessionId: string, fn: () => T | Promise<T>): Promise<T> {
    const dir = this.sessionDir(sessionId);
    const target = this.metaPath(sessionId);
    const lockfilePath = path.join(dir, ".lock");
    fs.mkdirSync(dir, { recursive: true });
    // proper-lockfile requires the target path to exist (it uses it for
    // realpath resolution). Init creates the session dir then immediately
    // calls withSessionLock-protected writes; pre-create an empty meta
    // placeholder so the first init() can acquire the lock. Existing
    // session reuses preserve their meta.
    try {
      fs.writeFileSync(target, "{}\n", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      /* existing or concurrently-created meta; fine */
    }
    // Pre-v4.1.0 legacy `.lock` regular file detection — FAIL CLOSED.
    //
    // Pre-v4.1.0 created `.lock` as a regular file containing
    // `{pid, ts}` JSON. proper-lockfile claims `.lock` as a DIRECTORY
    // via mkdir, so a leftover regular file blocks every subsequent
    // lockfile.lock() with EEXIST. The original v4.1.0 design tried
    // to auto-clean stale legacy files. Codex (session 059b0093 R1
    // through R4) progressively demonstrated that NO auto-clean is
    // safe under live cross-version operation:
    //
    //   • R1: unconditional removal split-brained with a live legacy
    //     holder.
    //   • R2: removal-when-pid-alive-but-mtime-stale split-brained
    //     because legacy locks do not heartbeat (mtime is frozen at
    //     acquisition).
    //   • R3: per-process atomic decisions still raced two v4.1
    //     migrators.
    //   • R4: serializing v4.1 migrators via a separate mutex still
    //     left the cross-version race: v4.0.x's own stale-removal
    //     path does not honor any v4.1 mutex, so a concurrent v4.0.x
    //     could remove a stale `.lock` and create its own live one
    //     between v4.1's read and v4.1's path-based rmSync —
    //     v4.1 then deletes the new live legacy lock → split-brain.
    //
    // Resolution: v4.1.0 NEVER auto-removes a legacy regular `.lock`
    // file. If one is observed, withSessionLock throws a clear
    // remediation error to the caller, instructing the operator to
    // stop all cross-review processes and remove the file manually.
    // This is a ONE-TIME operator step at v4.0.x → v4.1.0 upgrade.
    // After all hosts are on v4.1.0 the locks are mkdir-atomic and
    // the issue cannot recur.
    try {
      const stat = fs.statSync(lockfilePath);
      if (stat.isFile()) {
        throw new Error(
          `cross-review v4.1.0 detected a pre-v4.1.0 lock file at ${lockfilePath}. ` +
            `Live cross-version migration is not supported (would split-brain with any ` +
            `concurrent v4.0.x process). To migrate safely: (1) stop all cross-review ` +
            `processes / close all MCP hosts that loaded the server, (2) remove the ` +
            `legacy lock file, (3) restart. POSIX one-liner for full cleanup: ` +
            `\`find ${this.config.data_dir}/sessions -name .lock -type f -delete\`. ` +
            `See CHANGELOG v04.01.00 migration notes for the rationale.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("detected a pre-v4.1.0 lock file")) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        /* ignore other stat errors; lockfile.lock will surface them */
      }
    }
    const release = await lockfile.lock(target, {
      stale: 120_000,
      update: 5_000,
      retries: { retries: 30, factor: 1.5, minTimeout: 100, maxTimeout: 1_000 },
      realpath: false,
      lockfilePath,
    });
    try {
      return await fn();
    } finally {
      try {
        await release();
      } catch {
        /* lock was already released by stale-detection or sibling process */
      }
    }
  }

  async init(
    task: string,
    caller: PeerId | "operator",
    snapshot: PeerProbeResult[],
    reviewFocus?: string,
  ): Promise<SessionMeta> {
    const session_id = crypto.randomUUID();
    // v2.22.0 (B.P3): snapshot the cost ceiling at session_init time so
    // budget pressure analysis is decoupled from later env-var mutation.
    // null when the operator runs without a session-level cost cap.
    const ceiling = this.config.budget.max_session_cost_usd;
    const meta: SessionMeta = {
      session_id,
      version: this.config.version,
      created_at: now(),
      updated_at: now(),
      task,
      ...(reviewFocus ? { review_focus: reviewFocus } : {}),
      caller,
      capability_snapshot: snapshot,
      convergence_health: {
        state: "idle",
        last_event_at: now(),
        detail: "Session initialized.",
      },
      rounds: [],
      totals: {
        usage: {},
        cost: { currency: "USD", estimated: false, source: "unknown-rate" },
      },
      cost_ceiling_usd: typeof ceiling === "number" && ceiling > 0 ? ceiling : null,
      costs_per_round: [],
      budget_warning_emitted: false,
    };
    fs.mkdirSync(path.join(this.sessionDir(session_id), "agent-runs"), { recursive: true });
    await writeJson(this.metaPath(session_id), meta);
    fs.writeFileSync(path.join(this.sessionDir(session_id), "task.md"), task, "utf8");
    if (reviewFocus) {
      fs.writeFileSync(
        path.join(this.sessionDir(session_id), "review-focus.md"),
        reviewFocus,
        "utf8",
      );
    }
    return meta;
  }

  // v2.4.0 / cross-review R5 (codex blocker): refuse to overwrite an
  // existing in_flight when starting a new round. Pre-R5 markInFlight
  // unconditionally clobbered `meta.in_flight`, so a second concurrent
  // ask_peers on the same session would silently steamroll the first
  // round's state — and the format-recovery quota counter would race
  // because both calls could read the same `recoveriesAlready` baseline.
  // R5 throws when in_flight is already populated; the boot-time
  // `clearStaleInFlight` sweep clears any orphan in_flight from a
  // crashed prior host so legitimate operators are not blocked.
  async markInFlight(
    sessionId: string,
    params: {
      round: number;
      peers: PeerId[];
      started_at: string;
      scope: ConvergenceScope;
    },
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      if (meta.in_flight) {
        throw new Error(
          `session ${sessionId} already has an in-flight round (round=${meta.in_flight.round}, started_at=${meta.in_flight.started_at}); refusing to start a concurrent round. Wait for the round to complete, cancel it via session_cancel_job, or recover it via session_recover_interrupted.`,
        );
      }
      meta.in_flight = {
        round: params.round,
        peers: params.peers,
        started_at: params.started_at,
        status: "running",
      };
      meta.convergence_scope = params.scope;
      meta.convergence_health = {
        state: "running",
        last_event_at: now(),
        detail: `Round ${params.round} is running.`,
      };
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  read(sessionId: string): SessionMeta {
    return readJson<SessionMeta>(this.metaPath(sessionId));
  }

  readTextArtifact(sessionId: string, relativePath: string, maxChars: number): string {
    const sessionDir = this.sessionDir(sessionId);
    const absolutePath = path.resolve(sessionDir, relativePath);
    if (!this.isPathContained(sessionDir, absolutePath)) {
      throw new Error(`artifact path escapes session directory: ${relativePath}`);
    }
    const raw = fs.readFileSync(absolutePath, "utf8");
    return raw.length > maxChars ? raw.slice(0, maxChars) : raw;
  }

  // v2.4.0 / audit closure (P3.13) — refined after cross-review R2 (codex
  // caught a durability gap in the initial implementation).
  //
  // Pre-R2: the cache was incremented BEFORE appendFileSync. If the
  // append failed (ENOSPC, EACCES, write-error mid-call) the cache held
  // an already-handed-out seq number that nothing on disk consumed —
  // and a subsequent successful append would reuse the same disk byte
  // for a different event, while the cache produced seq+1. After
  // process restart the cache rebuild re-counted lines and produced a
  // duplicate seq.
  //
  // R2 (codex): the cache is updated ONLY after the appendFileSync
  // returns. If append throws, the cache is unchanged so the next call
  // reuses the same intended seq (no gap, no duplicate). On restart
  // the cache rebuild reflects on-disk reality. The lazy load uses
  // line count of the existing file as a reasonable approximation of
  // the durable max-seq.
  private peekNextSeq(sessionId: string, file: string): number {
    let cached = this.seqCache.get(sessionId);
    if (cached === undefined) {
      try {
        cached = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).length;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        cached = 0;
      }
      this.seqCache.set(sessionId, cached);
    }
    return cached + 1;
  }

  private commitSeq(sessionId: string, committed: number): void {
    this.seqCache.set(sessionId, committed);
  }

  private appendEventRecord(event: RuntimeEvent): void {
    const sessionId = event.session_id;
    if (!sessionId) return;
    const file = this.eventsPath(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const seq = this.peekNextSeq(sessionId, file);
    fs.appendFileSync(
      file,
      `${JSON.stringify({ ...event, seq, ts: event.ts ?? now() })}\n`,
      "utf8",
    );
    this.commitSeq(sessionId, seq);
  }

  // v4.1.0: durable event persistence. withSessionLock became async
  // with the proper-lockfile refactor; appendEvent awaits the lock so
  // callers that read events after persisting get the expected
  // synchronous-write semantics (e.g. the session_doctor sweep + smoke
  // fixtures that read events.ndjson immediately after appendEvent).
  // Fire-and-forget callers wrap with `void store.appendEvent(...)`.
  async appendEvent(event: RuntimeEvent): Promise<void> {
    const sessionId = event.session_id;
    if (!sessionId) return;
    const write = (async () => {
      try {
        await this.withSessionLock(sessionId, () => {
          // Only commit the cache AFTER the durable append succeeded.
          // If appendFileSync threw inside appendEventRecord, the cache
          // still reflects the last persisted seq and the next call
          // reuses this seq number.
          this.appendEventRecord(event);
        });
      } catch {
        // Event persistence must never break provider calls or MCP responses.
      }
    })();
    this.pendingEventWrites.add(write);
    void write.finally(() => {
      this.pendingEventWrites.delete(write);
    });
    return write;
  }

  // v4.1.0: wait for all in-flight fire-and-forget event writes to
  // settle. Used by tests/sweeps that need synchronous read-after-write
  // semantics for events.ndjson when the emit pipeline used
  // `void store.appendEvent(...)`. Always resolves (never rejects);
  // appendEvent swallows its own errors.
  async flushPendingEvents(): Promise<void> {
    while (this.pendingEventWrites.size > 0) {
      const snapshot = Array.from(this.pendingEventWrites);
      await Promise.allSettled(snapshot);
    }
  }

  readEvents(sessionId: string, sinceSeq = 0): SessionEvent[] {
    const file = this.eventsPath(sessionId);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => ({ seq: index + 1, ...JSON.parse(line) }) as SessionEvent)
      .filter((event) => event.seq > sinceSeq);
  }

  // v2.27.0: corrupted meta.json files are silently skipped + quarantined to
  // `<session_dir>/meta.json.bad` so subsequent startup sweeps do not re-throw.
  // Empirically demonstrated by 3 sessions corrupted by the v2.25.1 redact
  // escape-boundary bug (77c47284, be47a5b0, 7edf63e3) that caused parse
  // errors on every Claude Code reload until manually deleted 2026-05-12.
  list(): SessionMeta[] {
    if (!fs.existsSync(this.sessionsDir())) return [];
    const entries = fs.readdirSync(this.sessionsDir(), { withFileTypes: true });
    const metas: SessionMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(this.sessionsDir(), entry.name);
      const file = path.join(sessionDir, "meta.json");
      if (!fs.existsSync(file)) continue;
      try {
        metas.push(readJson<SessionMeta>(file));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const quarantine = path.join(sessionDir, "meta.json.bad");
        try {
          if (!fs.existsSync(quarantine)) {
            fs.renameSync(file, quarantine);
            console.error(
              `[cross-review] quarantined corrupted meta.json at ${file} -> ${quarantine} (${message})`,
            );
          }
        } catch {
          /* best-effort */
        }
      }
    }
    return metas.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  // v2.27.0: prune finalized sessions older than `maxAgeDays` days. Default
  // 60 days (configurable via CROSS_REVIEW_PRUNE_AFTER_DAYS env var or
  // explicit arg). Only removes sessions whose outcome is terminal (converged
  // | aborted | max-rounds) AND whose updated_at is older than the cutoff.
  // In-flight or untyped-outcome sessions are never pruned. Idempotent +
  // best-effort. Empirically motivated by 534 sessions accumulated on disk
  // by 2026-05-12 inflating cold-start sweep cost.
  pruneOldSessions(maxAgeDays?: number): { scanned: number; pruned: number } {
    const envDays = Number.parseFloat(process.env.CROSS_REVIEW_PRUNE_AFTER_DAYS ?? "");
    const days =
      maxAgeDays != null && maxAgeDays > 0
        ? maxAgeDays
        : Number.isFinite(envDays) && envDays > 0
          ? envDays
          : 60;
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    let scanned = 0;
    let pruned = 0;
    for (const session of this.list()) {
      scanned += 1;
      if (!session.outcome) continue;
      const lastTouched = Date.parse(session.updated_at);
      if (!Number.isFinite(lastTouched) || lastTouched >= cutoffMs) continue;
      const dir = this.sessionDir(session.session_id);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        pruned += 1;
      } catch {
        /* best-effort */
      }
    }
    return { scanned, pruned };
  }

  savePrompt(sessionId: string, round: number, prompt: string): string {
    const file = path.join(this.sessionDir(sessionId), "agent-runs", `round-${round}-prompt.md`);
    fs.writeFileSync(file, redact(prompt), "utf8");
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  saveDraft(sessionId: string, round: number, draft: string): string {
    const file = path.join(this.sessionDir(sessionId), "agent-runs", `round-${round}-draft.md`);
    fs.writeFileSync(file, redact(draft), "utf8");
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  async saveGeneration(
    sessionId: string,
    round: number,
    result: GenerationResult,
    label = "generation",
  ): Promise<string> {
    const file = path.join(
      this.sessionDir(sessionId),
      "agent-runs",
      `round-${round}-${result.peer}-${label}.json`,
    );
    await writeJson(file, { ...result, text: redact(result.text) });
    const relativePath = path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
    await this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      const artifact: GenerationArtifact = {
        ts: now(),
        round,
        label,
        peer: result.peer,
        path: relativePath,
        usage: result.usage,
        cost: result.cost,
        latency_ms: result.latency_ms,
      };
      meta.generation_files = [...(meta.generation_files ?? []), artifact];
      meta.totals = this.totalsFor(meta);
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
    });
    return relativePath;
  }

  saveFinal(sessionId: string, text: string): string {
    const file = path.join(this.sessionDir(sessionId), "final.md");
    fs.writeFileSync(file, redact(text), "utf8");
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  saveReport(sessionId: string, text: string): string {
    const file = path.join(this.sessionDir(sessionId), "session-report.md");
    fs.writeFileSync(file, redact(text), "utf8");
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  async savePeerResult(
    sessionId: string,
    round: number,
    result: PeerResult,
    label = "response",
  ): Promise<string> {
    const file = path.join(
      this.sessionDir(sessionId),
      "agent-runs",
      `round-${round}-${result.peer}-${label}.json`,
    );
    await writeJson(file, { ...result, text: redact(result.text) });
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  async savePeerFailure(sessionId: string, round: number, failure: PeerFailure): Promise<string> {
    const file = path.join(
      this.sessionDir(sessionId),
      "agent-runs",
      `round-${round}-${failure.peer}-failure.json`,
    );
    await writeJson(file, { ...failure, message: redact(failure.message) });
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  async appendRound(
    sessionId: string,
    params: {
      caller_status: ReviewStatus;
      draft_file?: string | undefined;
      prompt_file: string;
      peers: PeerResult[];
      rejected: PeerFailure[];
      convergence: ConvergenceResult;
      convergence_scope: ConvergenceScope;
      started_at: string;
    },
  ): Promise<ReviewRound> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      // v3.2.0 (Codex bug report 2026-05-12): refuse to append a round
      // to a finalized session. Otherwise the per-round
      // `convergence_health` write below would clobber the converged
      // health set by `finalize()`, producing the contradictory
      // `outcome=converged / health=blocked` state observed in session
      // 41244a1c (R6 ran after a `session_finalize` call corrupted the
      // meta — but the orchestrator path can also produce this if any
      // post-finalize round mutator slips through).
      if (meta.outcome) {
        const err = new Error(
          `session_already_finalized: cannot append round to session ${sessionId} (outcome="${meta.outcome}")`,
        );
        (err as Error & { code?: string }).code = "session_already_finalized";
        throw err;
      }
      const round: ReviewRound = {
        round: meta.rounds.length + 1,
        started_at: params.started_at,
        completed_at: now(),
        caller_status: params.caller_status,
        draft_file: params.draft_file,
        prompt_file: params.prompt_file,
        peers: params.peers,
        rejected: params.rejected,
        convergence: params.convergence,
      };
      meta.rounds.push(round);
      meta.failed_attempts = [
        ...(meta.failed_attempts ?? []),
        ...params.rejected.map((failure) => ({ ...failure, round: round.round })),
      ];
      delete meta.in_flight;
      meta.convergence_scope = params.convergence_scope;
      meta.convergence_health = {
        state: params.convergence.converged ? "converged" : "blocked",
        last_event_at: now(),
        detail: params.convergence.reason,
      };
      meta.updated_at = now();
      meta.totals = this.totalsFor(meta);
      // v2.22.0 (B.P3): append per-round cost. Sum of peer.cost.total_cost
      // across this round's peers. Coerced to 0 when adapters didn't
      // surface a cost (stub paths, error rounds). Read AFTER totalsFor
      // so the new round's peer costs are already counted by the merger,
      // but we recompute the round-local sum independently to avoid
      // diff-based drift if a peer's cost changed in a retry loop.
      const roundCost = params.peers.reduce((sum, peer) => sum + (peer.cost?.total_cost ?? 0), 0);
      meta.costs_per_round = [...(meta.costs_per_round ?? []), roundCost];
      await writeJson(this.metaPath(sessionId), meta);
      return round;
    });
  }

  async recordPreflightFailure(
    sessionId: string,
    failures: PeerFailure[],
    round = 0,
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      meta.failed_attempts = [
        ...(meta.failed_attempts ?? []),
        ...failures.map((failure) => ({ ...failure, round })),
      ];
      meta.convergence_health = {
        state: "blocked",
        last_event_at: now(),
        detail:
          failures[0]?.message ??
          "truthfulness_preflight blocked the session before a provider round started.",
      };
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  // v2.22.0 (B.P3): one-shot guard for `session.budget_warning` emit
  // idempotency. Persisted in meta.json so the warning fires at most
  // once per session even across host restarts.
  async markBudgetWarningEmitted(sessionId: string): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      meta.budget_warning_emitted = true;
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  // v2.25.0 (circular mode): atomically replace meta.circular_state. The
  // orchestrator's circular loop calls this every round so resumed
  // sessions can pick up the rotation cursor and consecutive-no-change
  // count from disk without re-deriving them by walking events.
  async setCircularState(
    sessionId: string,
    state: NonNullable<SessionMeta["circular_state"]>,
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      meta.circular_state = state;
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  // v3.5.0 (CRV2-1 + CRV2-6, Codex operational report): persist
  // requested-vs-effective budget + max_rounds traceability once at the
  // start of a run. Pre-v3.5.0 the durable record only had
  // `cost_ceiling_usd` (always the effective value) and nothing for
  // max_rounds — so retroactive analysis could not tell whether a
  // ceiling came from a per-call arg or a config default, nor what
  // max_rounds the caller actually requested. This fills that gap with
  // pure-additive metadata; `cost_ceiling_usd` is kept in sync with
  // `effective_cost_ceiling_usd` for back-compat with v3.4.x readers.
  async setSessionTraceability(
    sessionId: string,
    traceability: {
      requested_max_rounds: number | null;
      effective_max_rounds: number | null;
      requested_max_cost_usd: number | null;
      effective_cost_ceiling_usd: number | null;
      cost_ceiling_source: "call_arg" | "env_default" | "config_default";
    },
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      meta.requested_max_rounds = traceability.requested_max_rounds;
      meta.effective_max_rounds = traceability.effective_max_rounds;
      meta.requested_max_cost_usd = traceability.requested_max_cost_usd;
      meta.effective_cost_ceiling_usd = traceability.effective_cost_ceiling_usd;
      meta.cost_ceiling_source = traceability.cost_ceiling_source;
      // Keep the legacy field in sync so v3.4.x dashboard/readers that
      // only know `cost_ceiling_usd` still see the effective ceiling.
      meta.cost_ceiling_usd = traceability.effective_cost_ceiling_usd;
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  // v3.2.0 (Codex bug report 2026-05-12): public guard for orchestrator
  // entry points. Throws when the session has already been finalized so
  // round-starting tools fail fast instead of appending rounds onto a
  // closed session (which would re-derive `convergence_health` from the
  // post-final round's `convergence.converged` and leave the meta in the
  // contradictory `outcome=converged / health=blocked` state observed in
  // session 41244a1c). Error code is structured for upstream callers.
  assertNotFinalized(sessionId: string): void {
    const meta = this.read(sessionId);
    if (meta.outcome) {
      const err = new Error(
        `session_already_finalized: session ${sessionId} is finalized with outcome="${meta.outcome}"; cannot start new rounds`,
      );
      (err as Error & { code?: string }).code = "session_already_finalized";
      throw err;
    }
  }

  async finalize(
    sessionId: string,
    outcome: NonNullable<SessionMeta["outcome"]>,
    reason?: string,
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      // v3.2.0 (Codex bug report 2026-05-12): when the caller asserts
      // outcome="converged", the latest round (if any) MUST have
      // `convergence.converged === true`. Otherwise we would persist the
      // contradictory `outcome=converged / health=blocked` state observed
      // in session 41244a1c (R6 had perplexity:unparseable_after_recovery
      // → convergence.converged=false, but session_finalize was invoked
      // with outcome="converged"/"unanimous_ready" anyway). Refuse with a
      // structured error so the operator/caller fixes the mismatch
      // upstream instead of corrupting the meta.
      if (outcome === "converged" && meta.rounds.length > 0) {
        const latest = meta.rounds[meta.rounds.length - 1];
        if (!latest || latest.convergence?.converged !== true) {
          const err = new Error(
            `session_finalize_outcome_mismatch: cannot finalize as "converged" — latest round (round=${latest?.round ?? "undefined"}) has convergence.converged=${latest?.convergence?.converged ?? "undefined"}, reason="${latest?.convergence?.reason ?? "n/a"}"`,
          );
          (err as Error & { code?: string }).code = "session_finalize_outcome_mismatch";
          throw err;
        }
      }
      meta.outcome = outcome;
      if (reason) meta.outcome_reason = reason;
      delete meta.in_flight;
      const ts = now();
      meta.convergence_health = {
        state:
          outcome === "converged" ? "converged" : outcome === "max-rounds" ? "blocked" : "stale",
        last_event_at: ts,
        detail: reason ?? outcome,
      };
      meta.updated_at = ts;
      await writeJson(this.metaPath(sessionId), meta);
      try {
        this.appendEventRecord({
          type: "session.finalized",
          session_id: sessionId,
          ts,
          message: `Session finalized as ${outcome}${reason ? `: ${reason}` : ""}`,
          data: { outcome, reason: reason ?? null },
        });
      } catch {
        /* event persistence is best-effort; session_doctor will flag gaps */
      }
      return meta;
    });
  }

  async requestCancellation(
    sessionId: string,
    reason = "operator_requested",
    jobId?: string,
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      meta.control = {
        status: "cancel_requested",
        reason,
        job_id: jobId,
        requested_at: now(),
        updated_at: now(),
      };
      meta.convergence_health = {
        state: meta.outcome === "converged" ? "converged" : "blocked",
        last_event_at: now(),
        detail: `Cancellation requested: ${reason}`,
      };
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  async markCancelled(sessionId: string, reason = "cancelled"): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      const ts = now();
      meta.outcome = "aborted";
      meta.outcome_reason = reason;
      delete meta.in_flight;
      meta.control = {
        status: "cancelled",
        reason,
        job_id: meta.control?.job_id,
        requested_at: meta.control?.requested_at,
        updated_at: ts,
      };
      meta.convergence_health = {
        state: "stale",
        last_event_at: ts,
        detail: reason,
      };
      meta.updated_at = ts;
      await writeJson(this.metaPath(sessionId), meta);
      try {
        this.appendEventRecord({
          type: "session.cancelled",
          session_id: sessionId,
          ts,
          message: `Session cancelled: ${reason}`,
          data: { outcome: "aborted", reason },
        });
      } catch {
        /* event persistence is best-effort; session_doctor will flag gaps */
      }
      return meta;
    });
  }

  isCancellationRequested(sessionId: string): boolean {
    const meta = this.read(sessionId);
    return meta.control?.status === "cancel_requested";
  }

  async appendFallbackEvent(
    sessionId: string,
    event: NonNullable<SessionMeta["fallback_events"]>[number],
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      meta.fallback_events = [...(meta.fallback_events ?? []), event];
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  // v2.7.0 Evidence Broker: aggregate NEEDS_EVIDENCE asks from a round
  // into the session-level checklist. Each (peer, ask) pair is
  // deduplicated by sha256(peer + ":" + ask) so the same ask repeated
  // across rounds increments `round_count` instead of producing
  // duplicate entries. Returns the updated checklist (or empty array
  // if nothing was added/updated).
  async appendEvidenceChecklistItems(
    sessionId: string,
    round: number,
    incoming: Array<{ peer: PeerId; ask: string }>,
  ): Promise<NonNullable<SessionMeta["evidence_checklist"]>> {
    if (!incoming.length) return [];
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      const existing = meta.evidence_checklist ?? [];
      const byId = new Map(existing.map((item) => [item.id, item]));
      const ts = now();
      for (const { peer, ask } of incoming) {
        const trimmed = ask.trim();
        if (!trimmed) continue;
        const id = crypto
          .createHash("sha256")
          .update(`${peer}:${trimmed}`)
          .digest("hex")
          .slice(0, 16);
        const existing = byId.get(id);
        if (existing) {
          // Same ask resurfaced. Bump last_round/last_seen_at and
          // round_count only when the round number is strictly newer
          // (avoid double-counting if the same caller_request appears
          // multiple times within the same round across peers — though
          // we already iterate per-peer, so this is defensive).
          if (round > existing.last_round) {
            existing.last_round = round;
            existing.last_seen_at = ts;
            existing.round_count += 1;
          }
        } else {
          byId.set(id, {
            id,
            peer,
            first_round: round,
            last_round: round,
            round_count: 1,
            ask: trimmed,
            first_seen_at: ts,
            last_seen_at: ts,
          });
        }
      }
      const updated = Array.from(byId.values()).sort((a, b) => {
        if (a.first_round !== b.first_round) return a.first_round - b.first_round;
        if (a.peer !== b.peer) return a.peer.localeCompare(b.peer);
        return a.ask.localeCompare(b.ask);
      });
      meta.evidence_checklist = updated;
      meta.updated_at = ts;
      await writeJson(this.metaPath(sessionId), meta);
      return updated;
    });
  }

  // v2.8.0: terminal statuses owned by the operator. The runtime never
  // auto-mutates items in these states — it only surfaces them via the
  // peer_resurfaced_terminal collection so the orchestrator can emit a
  // visibility event. Held as a Set because the runtime checks membership
  // on every item every round; a Set lookup avoids any risk of someone
  // later writing the buggy `(status === "satisfied" || "deferred" ||
  // "rejected")` truthy-OR form by accident.
  static readonly TERMINAL_STATUSES: ReadonlySet<EvidenceChecklistStatus> =
    new Set<EvidenceChecklistStatus>(["satisfied", "deferred", "rejected"]);

  // v2.8.0: resurfacing-inference for the evidence checklist. Runs AFTER
  // appendEvidenceChecklistItems for a given round and applies two rules
  // atomically under the session lock:
  //   1. Items in `open` whose `last_round < currentRound` were not
  //      brought back by any peer this round → promote to `addressed`
  //      and stamp `addressed_at_round`.
  //   2. Items in `addressed` whose `last_round === currentRound` were
  //      resurfaced this round (aggregation already bumped last_round
  //      and round_count) → revert to `open` and clear addressed_at_round.
  // Terminal operator statuses (satisfied/deferred/rejected) are NEVER
  // touched here. The peer_resurfaced_terminal information is surfaced
  // by the orchestrator via a separate event so operators see when peers
  // keep asking for items they explicitly closed; the status itself is
  // operator-owned.
  async runEvidenceChecklistAddressDetection(
    sessionId: string,
    currentRound: number,
  ): Promise<{
    // v3.5.0 (CRV2-2): renamed `addressed` → `not_resurfaced`. The
    // resurfacing-inference path no longer claims the evidence was
    // confirmed — it only records that the peer did not re-ask. See the
    // EvidenceChecklistStatus type doc for the semantics.
    not_resurfaced: EvidenceChecklistItem[];
    reopened: EvidenceChecklistItem[];
    peer_resurfaced_terminal: EvidenceChecklistItem[];
  }> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      const checklist = meta.evidence_checklist ?? [];
      if (!checklist.length) {
        return { not_resurfaced: [], reopened: [], peer_resurfaced_terminal: [] };
      }
      const notResurfaced: EvidenceChecklistItem[] = [];
      const reopened: EvidenceChecklistItem[] = [];
      const peerResurfacedTerminal: EvidenceChecklistItem[] = [];
      const history = meta.evidence_status_history ?? [];
      const ts = now();
      for (const item of checklist) {
        const status: EvidenceChecklistStatus = item.status ?? "open";
        if (status === "open" && item.last_round < currentRound) {
          // v3.5.0 (CRV2-2): an `open` item the peer did not resurface
          // becomes `not_resurfaced`, NOT `addressed`. "The peer did not
          // re-ask" is not proof the evidence was satisfied — only the
          // judge autowire (verified-satisfied) or explicit operator
          // action may move an item to a confirmed state. This keeps the
          // audit trail honest. `not_resurfaced` is still not `open`, so
          // it does not hard-block the `=== "open"` convergence gate;
          // the inference is recorded, not enforced.
          item.status = "not_resurfaced";
          item.addressed_at_round = currentRound;
          // v2.9.0: tag the inference path so the dashboard and audit
          // trail can distinguish runtime resurfacing from runtime judge
          // promotions. Operator-set terminal statuses do not populate
          // this field; setEvidenceChecklistItemStatus clears it.
          item.address_method = "resurfacing";
          delete item.judge_rationale;
          notResurfaced.push(item);
          history.push({
            ts,
            item_id: item.id,
            from: "open",
            to: "not_resurfaced",
            by: "runtime",
            round: currentRound,
            note: `auto: peer did not resurface ask in round ${currentRound} (not proof of satisfaction)`,
          });
        } else if (
          (status === "not_resurfaced" || status === "addressed") &&
          item.last_round === currentRound
        ) {
          // v3.5.0 (CRV2-2): a peer resurfacing an item reverts it to
          // `open` regardless of whether the prior state was the soft
          // `not_resurfaced` inference or a judge/operator `addressed` —
          // the peer's renewed ask wins over either inference path.
          const from: EvidenceChecklistStatus = status;
          item.status = "open";
          delete item.addressed_at_round;
          delete item.address_method;
          delete item.judge_rationale;
          reopened.push(item);
          history.push({
            ts,
            item_id: item.id,
            from,
            to: "open",
            by: "runtime",
            round: currentRound,
            note: `auto: peer resurfaced ask in round ${currentRound}`,
          });
        } else if (SessionStore.TERMINAL_STATUSES.has(status) && item.last_round === currentRound) {
          // Operator closed it but the peer brought it back this round.
          // Status stays terminal (operator-owned); we surface it for
          // the orchestrator to emit a visibility event.
          peerResurfacedTerminal.push(item);
        }
      }
      if (notResurfaced.length || reopened.length) {
        meta.evidence_status_history = history;
        meta.updated_at = ts;
        await writeJson(this.metaPath(sessionId), meta);
      }
      return {
        not_resurfaced: notResurfaced,
        reopened,
        peer_resurfaced_terminal: peerResurfacedTerminal,
      };
    });
  }

  // v2.8.0: operator workflow mutator for the evidence checklist. Used by
  // the session_evidence_checklist_update MCP tool. Allowed transitions
  // (operator): open → satisfied | deferred | rejected | open;
  // addressed | not_resurfaced → satisfied | deferred | rejected | open.
  // Terminal-state items can also be moved BACK to "open" by the operator
  // (retract a deferral/rejection); that re-arms the runtime
  // auto-promotion logic. Operator CANNOT move items to "addressed" or
  // "not_resurfaced" — both are runtime-managed (judge promotion and
  // resurfacing inference respectively). Returns the mutated item and the
  // appended history entry.
  async setEvidenceChecklistItemStatus(
    sessionId: string,
    itemId: string,
    status: Exclude<EvidenceChecklistStatus, "addressed" | "not_resurfaced">,
    options: { note?: string | undefined; by?: "operator" | "runtime" | undefined } = {},
  ): Promise<{ item: EvidenceChecklistItem; history_entry: EvidenceStatusHistoryEntry }> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      const checklist = meta.evidence_checklist ?? [];
      const item = checklist.find((entry) => entry.id === itemId);
      if (!item) {
        throw new Error(`evidence_checklist_item_not_found: ${itemId}`);
      }
      const from: EvidenceChecklistStatus = item.status ?? "open";
      if (from === status) {
        // No-op: already at the requested status. We still record a
        // history entry so the audit trail captures the operator's
        // explicit intent.
      }
      const ts = now();
      const entry: EvidenceStatusHistoryEntry = {
        ts,
        item_id: itemId,
        from,
        to: status,
        by: options.by ?? "operator",
        note: options.note,
      };
      item.status = status;
      // The signature excludes "addressed" so any operator-driven status
      // change clears the runtime-managed stamps (v2.8.0 addressed_at_round
      // + v2.9.0 address_method + judge_rationale).
      delete item.addressed_at_round;
      delete item.address_method;
      delete item.judge_rationale;
      const history = meta.evidence_status_history ?? [];
      history.push(entry);
      meta.evidence_status_history = history;
      meta.evidence_checklist = checklist;
      meta.updated_at = ts;
      await writeJson(this.metaPath(sessionId), meta);
      return { item, history_entry: entry };
    });
  }

  // v2.9.0: runtime-judge promotion path. Promotes an `open` item to
  // `addressed` ONLY — never touches terminal operator statuses, never
  // moves anything other than open. Atomic under the session lock.
  // Returns null when the item is not currently `open` (already
  // addressed, terminal, or missing) so the caller can skip emit.
  async markEvidenceItemAddressedByJudge(
    sessionId: string,
    itemId: string,
    params: { round: number; rationale: string; judge_peer: PeerId },
  ): Promise<{ item: EvidenceChecklistItem; history_entry: EvidenceStatusHistoryEntry } | null> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      const checklist = meta.evidence_checklist ?? [];
      const item = checklist.find((entry) => entry.id === itemId);
      if (!item) return null;
      const status: EvidenceChecklistStatus = item.status ?? "open";
      // Single allowed transition: open → addressed (judge). Terminal
      // statuses (satisfied/deferred/rejected) and already-addressed
      // items are NOT auto-mutated here.
      if (status !== "open") return null;
      const ts = now();
      const rationale = params.rationale.trim().slice(0, 800);
      item.status = "addressed";
      item.addressed_at_round = params.round;
      item.address_method = "judge";
      item.judge_rationale = rationale;
      const entry: EvidenceStatusHistoryEntry = {
        ts,
        item_id: itemId,
        from: "open",
        to: "addressed",
        by: "runtime",
        round: params.round,
        note: `judge[${params.judge_peer}]: ${rationale}`,
      };
      const history = meta.evidence_status_history ?? [];
      history.push(entry);
      meta.evidence_status_history = history;
      meta.evidence_checklist = checklist;
      meta.updated_at = ts;
      await writeJson(this.metaPath(sessionId), meta);
      return { item, history_entry: entry };
    });
  }

  async recoverInterruptedSessions(activeSessionIds = new Set<string>()): Promise<SessionMeta[]> {
    const recovered: SessionMeta[] = [];
    for (const session of this.list()) {
      if (session.outcome || activeSessionIds.has(session.session_id) || !session.in_flight)
        continue;
      const updated = await this.withSessionLock(session.session_id, async () => {
        const current = this.read(session.session_id);
        if (current.outcome || activeSessionIds.has(current.session_id) || !current.in_flight) {
          return current;
        }
        const round = current.in_flight.round;
        delete current.in_flight;
        current.control = {
          status: "recovered_after_restart",
          reason: `Round ${round} was interrupted before completion and can be resumed manually.`,
          updated_at: now(),
        };
        current.convergence_health = {
          state: "stale",
          last_event_at: now(),
          detail: `Recovered interrupted round ${round} after MCP restart. Start a new round to continue from saved session context.`,
        };
        current.updated_at = now();
        await writeJson(this.metaPath(current.session_id), current);
        return current;
      });
      recovered.push(updated);
    }
    return recovered;
  }

  // v2.12.0: walk session events.ndjson and aggregate
  // `session.evidence_judge_pass.shadow_decision` events into a peer-keyed
  // rollup. Operator observability: how many shadow decisions exist, what
  // the would_promote rate looks like per judge_peer, what confidence
  // distribution the judge returns. Walks the event log per session
  // (O(events) per call); acceptable for v2.12 because the corpus is
  // bounded (≤ a few hundred sessions historically) and the dashboard
  // refreshes on demand.
  aggregateShadowJudgments(sessionId?: string): ShadowJudgmentRollup {
    const sessions = sessionId ? [this.read(sessionId)] : this.list();
    const byPeer: Partial<Record<PeerId, ShadowJudgmentPeerStats>> = {};
    let decisionsTotal = 0;
    let wouldPromoteTotal = 0;
    const peerKnown: readonly PeerId[] = PEERS;
    for (const session of sessions) {
      const events = this.readEvents(session.session_id);
      for (const event of events) {
        if (event.type !== "session.evidence_judge_pass.shadow_decision") continue;
        const data = (event.data ?? {}) as {
          judge_peer?: PeerId | undefined;
          would_promote?: boolean | undefined;
          satisfied?: boolean | undefined;
          confidence?: "verified" | "inferred" | "unknown" | undefined;
        };
        const judgePeer = data.judge_peer;
        if (!judgePeer || !peerKnown.includes(judgePeer)) continue;
        let entry = byPeer[judgePeer];
        if (!entry) {
          entry = {
            judge_peer: judgePeer,
            decisions_total: 0,
            would_promote: 0,
            would_skip_satisfied_unverified: 0,
            would_skip_not_satisfied: 0,
            by_confidence: {},
            first_seen_at: null,
            last_seen_at: null,
          };
          byPeer[judgePeer] = entry;
        }
        entry.decisions_total += 1;
        decisionsTotal += 1;
        if (data.would_promote === true) {
          entry.would_promote += 1;
          wouldPromoteTotal += 1;
        } else if (data.satisfied === true) {
          entry.would_skip_satisfied_unverified += 1;
        } else {
          entry.would_skip_not_satisfied += 1;
        }
        if (
          data.confidence === "verified" ||
          data.confidence === "inferred" ||
          data.confidence === "unknown"
        ) {
          entry.by_confidence[data.confidence] = (entry.by_confidence[data.confidence] ?? 0) + 1;
        }
        const ts = event.ts ?? null;
        if (ts) {
          if (!entry.first_seen_at || ts < entry.first_seen_at) entry.first_seen_at = ts;
          if (!entry.last_seen_at || ts > entry.last_seen_at) entry.last_seen_at = ts;
        }
      }
    }
    return {
      decisions_total: decisionsTotal,
      would_promote_total: wouldPromoteTotal,
      by_judge_peer: byPeer,
    };
  }

  metrics(sessionId?: string): RuntimeMetrics {
    const sessions = sessionId ? [this.read(sessionId)] : this.list();
    const peerResults: RuntimeMetrics["peer_results"] = {};
    const peerFailures: RuntimeMetrics["peer_failures"] = {};
    const decisionQuality: RuntimeMetrics["decision_quality"] = {};
    const peerLatencies: number[] = [];
    const generationLatencies: number[] = [];
    let moderationRecoveries = 0;
    let fallbackEvents = 0;
    // v2.8.0: per-peer health roll-up. Each accumulator tracks all the
    // fields needed for PeerHealthSummary; rates are computed at the end.
    type PeerAccumulator = {
      results_total: number;
      ready_count: number;
      not_ready_count: number;
      needs_evidence_count: number;
      unresolved_count: number;
      cost_sum: number;
      cost_count: number;
      parser_warnings_total: number;
      rejected_total: number;
      failures_by_class: Partial<Record<PeerFailure["failure_class"], number>>;
    };
    const perPeer: Partial<Record<PeerId, PeerAccumulator>> = {};
    const accumulator = (peer: PeerId): PeerAccumulator => {
      let entry = perPeer[peer];
      if (!entry) {
        entry = {
          results_total: 0,
          ready_count: 0,
          not_ready_count: 0,
          needs_evidence_count: 0,
          unresolved_count: 0,
          cost_sum: 0,
          cost_count: 0,
          parser_warnings_total: 0,
          rejected_total: 0,
          failures_by_class: {},
        };
        perPeer[peer] = entry;
      }
      return entry;
    };

    for (const session of sessions) {
      fallbackEvents += session.fallback_events?.length ?? 0;
      for (const round of session.rounds) {
        for (const peer of round.peers) {
          peerResults[peer.peer] = (peerResults[peer.peer] ?? 0) + 1;
          const quality = peer.decision_quality ?? "failed";
          decisionQuality[quality] = (decisionQuality[quality] ?? 0) + 1;
          if (Number.isFinite(peer.latency_ms)) peerLatencies.push(peer.latency_ms);
          if (peer.parser_warnings.some((warning) => warning.includes("moderation_safe_retry"))) {
            moderationRecoveries += 1;
          }
          const acc = accumulator(peer.peer);
          acc.results_total += 1;
          if (peer.status === "READY") acc.ready_count += 1;
          else if (peer.status === "NOT_READY") acc.not_ready_count += 1;
          else if (peer.status === "NEEDS_EVIDENCE") acc.needs_evidence_count += 1;
          else acc.unresolved_count += 1;
          if (
            peer.cost?.total_cost != null &&
            Number.isFinite(peer.cost.total_cost) &&
            peer.cost.source !== "stub"
          ) {
            acc.cost_sum += peer.cost.total_cost;
            acc.cost_count += 1;
          }
          acc.parser_warnings_total += peer.parser_warnings.length;
        }
        for (const failure of round.rejected) {
          peerFailures[failure.failure_class] = (peerFailures[failure.failure_class] ?? 0) + 1;
          const acc = accumulator(failure.peer);
          acc.rejected_total += 1;
          acc.failures_by_class[failure.failure_class] =
            (acc.failures_by_class[failure.failure_class] ?? 0) + 1;
        }
      }
      for (const generation of session.generation_files ?? []) {
        if (generation.latency_ms != null && Number.isFinite(generation.latency_ms)) {
          generationLatencies.push(generation.latency_ms);
        }
      }
    }

    const average = (values: number[]): number | null =>
      values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

    const perPeerHealth: Partial<Record<PeerId, PeerHealthSummary>> = {};
    for (const [peer, acc] of Object.entries(perPeer) as Array<[PeerId, PeerAccumulator]>) {
      const total = acc.results_total;
      perPeerHealth[peer] = {
        peer,
        results_total: total,
        ready_count: acc.ready_count,
        not_ready_count: acc.not_ready_count,
        needs_evidence_count: acc.needs_evidence_count,
        unresolved_count: acc.unresolved_count,
        ready_rate: total > 0 ? acc.ready_count / total : 0,
        needs_evidence_rate: total > 0 ? acc.needs_evidence_count / total : 0,
        avg_cost_usd: acc.cost_count > 0 ? acc.cost_sum / acc.cost_count : null,
        total_cost_usd: acc.cost_count > 0 ? acc.cost_sum : null,
        parser_warnings_total: acc.parser_warnings_total,
        rejected_total: acc.rejected_total,
        failures_by_class: acc.failures_by_class,
      };
    }

    return {
      generated_at: now(),
      scope: sessionId ? "session" : "all",
      session_id: sessionId,
      sessions: {
        total: sessions.length,
        converged: sessions.filter((session) => session.outcome === "converged").length,
        aborted: sessions.filter((session) => session.outcome === "aborted").length,
        max_rounds: sessions.filter((session) => session.outcome === "max-rounds").length,
        unfinished: sessions.filter((session) => !session.outcome).length,
      },
      rounds: sessions.reduce((sum, session) => sum + session.rounds.length, 0),
      peer_results: peerResults,
      peer_failures: peerFailures,
      decision_quality: decisionQuality,
      moderation_recoveries: moderationRecoveries,
      fallback_events: fallbackEvents,
      total_usage: mergeUsage(sessions.map((session) => session.totals.usage)),
      total_cost: mergeCost(sessions.map((session) => session.totals.cost)),
      latency_ms: {
        peer_average: average(peerLatencies),
        generation_average: average(generationLatencies),
      },
      per_peer_health: perPeerHealth,
      // v2.12.0: shadow_decision rollup. See aggregateShadowJudgments().
      shadow_judgment: this.aggregateShadowJudgments(sessionId),
    };
  }

  // v2.16.0: read-only operational doctor. This is intentionally a
  // reporting surface, not a cleanup tool: it never finalizes, rewrites
  // or deletes sessions. Operators use it after audits to see which
  // sessions need human action and which records are legacy metadata
  // artifacts (for example caller==lead_peer before the petitioner/
  // relator split).
  //
  // v2.22.0 (A.P2): `includeLegacy` toggles per-session enumeration of
  // `findings.self_lead_metadata`. Default false because pre-v2.16.0
  // sessions carry the legacy self-lead artifact at a 38% hit rate
  // (178/467 in the May 2026 audit corpus); enumerating them every call
  // floods the response. `totals.self_lead_metadata` count remains
  // visible regardless. Pass `includeLegacy=true` to enumerate.
  //
  // v2.22.0 (B.P2): `findings.open_evidence_sessions[i]` entries gain
  // `item_types` (open items grouped by surfacing peer) and
  // `chronic_blockers` (item ids with `round_count >= 3`) so operators
  // can see which evidence asks are systemic vs cauda ruidosa.
  async sessionDoctor(
    limit = 20,
    includeLegacy = false,
    repair = false,
  ): Promise<SessionDoctorReport> {
    const cappedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 20));
    // v3.6.0 (C): opt-in repair pass BEFORE the read-only audit. Fixes
    // the contradictory `outcome="converged" + health.state="blocked"`
    // state left on disk by pre-v3.2.0 sessions (v3.2.0 fixed the cause
    // via the finalize/appendRound invariants; old corrupt metas
    // persist). Only that specific contradiction is touched, only when
    // the operator explicitly passes `repair: true`. Recomputes
    // `convergence_health` from the latest round's `convergence.converged`.
    const repaired: NonNullable<SessionDoctorReport["repaired"]> = [];
    if (repair) {
      for (const session of this.list()) {
        if (session.outcome === "converged" && session.convergence_health?.state === "blocked") {
          const latest = session.rounds.at(-1);
          const latestConverged = latest?.convergence?.converged === true;
          // Only repair when the latest round actually converged — i.e.
          // the `outcome="converged"` finalize was legitimate and only
          // the health field is the stale lie. If the latest round did
          // NOT converge, the contradiction is deeper and we leave it
          // for manual operator inspection rather than guessing.
          if (latestConverged) {
            const fromState = session.convergence_health?.state;
            const fixed = await this.withSessionLock(session.session_id, async () => {
              const meta = this.read(session.session_id);
              if (
                meta.outcome === "converged" &&
                meta.convergence_health?.state === "blocked" &&
                meta.rounds.at(-1)?.convergence?.converged === true
              ) {
                meta.convergence_health = {
                  state: "converged",
                  last_event_at: now(),
                  detail: `v3.6.0 doctor repair: recomputed health from latest round (was "blocked" with outcome="converged" — pre-v3.2.0 corruption artifact)`,
                };
                meta.updated_at = now();
                await writeJson(this.metaPath(session.session_id), meta);
                return true;
              }
              return false;
            });
            if (fixed) {
              repaired.push({
                session_id: session.session_id,
                from_health_state: fromState,
                to_health_state: "converged",
                reason:
                  "outcome=converged but health=blocked; latest round has convergence.converged=true — recomputed health",
              });
            }
          }
        }
      }
    }
    const sessions = this.list();
    const openSessions: SessionDoctorEntry[] = [];
    const staleSessions: SessionDoctorEntry[] = [];
    const blockedSessions: SessionDoctorEntry[] = [];
    const maxRoundsSessions: SessionDoctorEntry[] = [];
    const selfLeadMetadata: SessionDoctorEntry[] = [];
    const openEvidenceSessions: SessionDoctorEntry[] = [];
    const notResurfacedEvidenceSessions: SessionDoctorEntry[] = [];
    const grokProviderErrorSessions: SessionDoctorEntry[] = [];
    const eventReadErrorSessions: SessionDoctorEntry[] = [];
    const terminalEventMissingSessions: SessionDoctorEntry[] = [];
    let eventsTotal = 0;
    let tokenDeltaEvents = 0;
    let tokenCompletedEvents = 0;
    let realSessions = 0;
    let stubSessions = 0;
    let peerCallCostUsd: number | null = null;
    let generationCostUsd: number | null = null;
    let totalCostUsd: number | null = null;
    let terminalEventMissingCount = 0;

    const pushLimited = (target: SessionDoctorEntry[], entry: SessionDoctorEntry): void => {
      if (target.length < cappedLimit) target.push(entry);
    };

    for (const session of sessions) {
      const scope = session.convergence_scope;
      const petitioner = scope?.petitioner ?? scope?.caller ?? session.caller;
      const leadPeer = scope?.lead_peer;
      const evidenceList = session.evidence_checklist ?? [];
      const openEvidenceItemsList = evidenceList.filter(
        (item) => (item.status ?? "open") === "open",
      );
      const openEvidenceItems = openEvidenceItemsList.length;
      const notResurfacedEvidenceItems = evidenceList.filter(
        (item) => item.status === "not_resurfaced",
      ).length;
      const grokProviderErrors = (session.failed_attempts ?? []).filter(
        (failure) => failure.peer === "grok" && failure.failure_class === "provider_error",
      ).length;
      if (isStubSession(session)) stubSessions += 1;
      else realSessions += 1;
      peerCallCostUsd = addNullableCost(peerCallCostUsd, sessionPeerCostTotal(session));
      generationCostUsd = addNullableCost(generationCostUsd, sessionGenerationCostTotal(session));
      const sessionTotalCost = session.totals.cost.total_cost;
      if (sessionTotalCost != null && Number.isFinite(sessionTotalCost)) {
        totalCostUsd = addNullableCost(totalCostUsd, sessionTotalCost);
      }
      const entry: SessionDoctorEntry = {
        session_id: session.session_id,
        version: session.version,
        caller: session.caller,
        petitioner,
        lead_peer: leadPeer,
        outcome: session.outcome,
        outcome_reason: session.outcome_reason,
        health_state: session.convergence_health?.state,
        health_detail: session.convergence_health?.detail,
        rounds: session.rounds.length,
        updated_at: session.updated_at,
        ...(openEvidenceItems > 0 ? { open_evidence_items: openEvidenceItems } : {}),
        ...(notResurfacedEvidenceItems > 0
          ? { not_resurfaced_evidence_items: notResurfacedEvidenceItems }
          : {}),
        ...(grokProviderErrors > 0 ? { grok_provider_errors: grokProviderErrors } : {}),
      };

      // v2.22.0 (B.P2): drill-down for open-evidence entries. Aggregate
      // open items by peer + flag chronic blockers (round_count >= 3).
      if (openEvidenceItems > 0) {
        const itemTypes: Partial<Record<PeerId, number>> = {};
        const chronicBlockers: string[] = [];
        for (const item of openEvidenceItemsList) {
          itemTypes[item.peer] = (itemTypes[item.peer] ?? 0) + 1;
          if (item.round_count >= 3) {
            chronicBlockers.push(item.id);
          }
        }
        entry.item_types = itemTypes;
        entry.chronic_blockers = chronicBlockers;
      }

      // v3.7.5 (A1, logs+sessions study 2026-05-15): terminal outcomes
      // are NEVER stale or blocked — they are DONE. Pre-v3.7.5 the
      // doctor classified solely on `convergence_health.state` which
      // markCancelled writes as "stale" on `outcome="aborted"`. Result:
      // 22 cancelled sessions of 244 (9%) were flagged as needing
      // attention when they were terminal. Likewise the v3.6.0 repair
      // path was the symmetric symptom for `outcome="converged" +
      // state="blocked"`. The classification fix keeps backward compat
      // with the 244 existing sessions on disk (no migration) and only
      // recognizes the truth at the consumer layer: if the session has
      // a terminal outcome, do not flag it as stale or blocked.
      const isTerminal = session.outcome != null;
      if (!session.outcome) pushLimited(openSessions, entry);
      if (!isTerminal && session.convergence_health?.state === "stale")
        pushLimited(staleSessions, entry);
      if (!isTerminal && session.convergence_health?.state === "blocked")
        pushLimited(blockedSessions, entry);
      if (session.outcome === "max-rounds") pushLimited(maxRoundsSessions, entry);
      if (petitioner && leadPeer && petitioner === leadPeer) pushLimited(selfLeadMetadata, entry);
      if (openEvidenceItems > 0) pushLimited(openEvidenceSessions, entry);
      if (notResurfacedEvidenceItems > 0) pushLimited(notResurfacedEvidenceSessions, entry);
      if (grokProviderErrors > 0) pushLimited(grokProviderErrorSessions, entry);

      let sessionEvents: SessionEvent[] = [];
      try {
        sessionEvents = this.readEvents(session.session_id);
      } catch (error) {
        entry.event_read_error = redact(error instanceof Error ? error.message : String(error));
        pushLimited(eventReadErrorSessions, entry);
      }

      if (session.outcome) {
        const expectedTerminalEvent: "session.finalized" | "session.cancelled" =
          session.control?.status === "cancelled" || session.outcome_reason === "session_cancelled"
            ? "session.cancelled"
            : "session.finalized";
        const hasExpectedTerminalEvent = sessionEvents.some(
          (event) => event.type === expectedTerminalEvent,
        );
        if (!hasExpectedTerminalEvent) {
          terminalEventMissingCount += 1;
          entry.terminal_event_missing = true;
          entry.terminal_event_expected = expectedTerminalEvent;
          pushLimited(terminalEventMissingSessions, entry);
        }
      }

      for (const event of sessionEvents) {
        eventsTotal += 1;
        if (event.type === "peer.token.delta") tokenDeltaEvents += 1;
        if (event.type === "peer.token.completed") tokenCompletedEvents += 1;
      }
    }

    // v2.22.0 (A.P2): compute the headline self_lead_metadata count
    // BEFORE deciding whether to suppress the per-session array, so
    // `totals.self_lead_metadata` always reflects reality even when the
    // findings array is empty.
    const selfLeadCount = sessions.filter((session) => {
      const scope = session.convergence_scope;
      const petitioner = scope?.petitioner ?? scope?.caller ?? session.caller;
      return Boolean(petitioner && scope?.lead_peer && petitioner === scope.lead_peer);
    }).length;

    const recommendations: string[] = [];
    if (openSessions.length > 0) {
      recommendations.push(
        "Review open_sessions first; finalize, contest, cancel or explicitly continue each live case.",
      );
    }
    if (selfLeadCount > 0) {
      // Recommendation fires off the headline count, not the in-array
      // count, so operators are still nudged when the array is hidden.
      const baseAdvice =
        "Treat self_lead_metadata as legacy/protocol-drift evidence; do not rewrite historical records automatically.";
      if (!includeLegacy) {
        recommendations.push(
          `${baseAdvice} ${selfLeadCount} legacy sessions hidden by default — pass include_legacy=true to enumerate.`,
        );
      } else {
        recommendations.push(baseAdvice);
      }
    }
    if (openEvidenceSessions.length > 0) {
      recommendations.push(
        "Address or explicitly terminal-mark open evidence checklist items before expecting convergence.",
      );
    }
    if (notResurfacedEvidenceSessions.length > 0) {
      recommendations.push(
        "`not_resurfaced` evidence items are inference-only; review them separately from satisfied/deferred/rejected items.",
      );
    }
    if (grokProviderErrorSessions.length > 0) {
      recommendations.push(
        "Run a Grok-specific smoke/probe for sessions with grok provider errors before relying on Grok in release gates.",
      );
    }
    if (eventReadErrorSessions.length > 0) {
      recommendations.push(
        "Inspect event_read_error_sessions manually; malformed events.ndjson records were skipped for doctor aggregation but not modified.",
      );
    }
    if (eventsTotal > 0 && tokenDeltaEvents / eventsTotal > 0.5) {
      recommendations.push(
        "Token delta events dominate this corpus; increase CROSS_REVIEW_TOKEN_DELTA_CHARS_THRESHOLD or disable token streaming for low-noise audits.",
      );
    }
    if (terminalEventMissingCount > 0) {
      recommendations.push(
        "Terminal outcome metadata exists without matching terminal events; treat as legacy/event-gap evidence and inspect before relying on event-only analytics.",
      );
    }

    return {
      generated_at: now(),
      scope: "all",
      limit: cappedLimit,
      totals: {
        sessions: sessions.length,
        real_sessions: realSessions,
        stub_sessions: stubSessions,
        open: sessions.filter((session) => !session.outcome).length,
        stale: sessions.filter(
          (session) => !session.outcome && session.convergence_health?.state === "stale",
        ).length,
        blocked: sessions.filter(
          (session) => !session.outcome && session.convergence_health?.state === "blocked",
        ).length,
        max_rounds: sessions.filter((session) => session.outcome === "max-rounds").length,
        self_lead_metadata: selfLeadCount,
        open_evidence_sessions: sessions.filter((session) =>
          (session.evidence_checklist ?? []).some((item) => (item.status ?? "open") === "open"),
        ).length,
        not_resurfaced_evidence_sessions: sessions.filter((session) =>
          (session.evidence_checklist ?? []).some((item) => item.status === "not_resurfaced"),
        ).length,
        grok_provider_error_sessions: sessions.filter((session) =>
          (session.failed_attempts ?? []).some(
            (failure) => failure.peer === "grok" && failure.failure_class === "provider_error",
          ),
        ).length,
        event_read_error_sessions: eventReadErrorSessions.length,
        terminal_event_missing_sessions: terminalEventMissingCount,
      },
      cost_breakdown: {
        total_cost_usd: totalCostUsd,
        peer_call_cost_usd: peerCallCostUsd,
        generation_cost_usd: generationCostUsd,
      },
      findings: {
        open_sessions: openSessions,
        stale_sessions: staleSessions,
        blocked_sessions: blockedSessions,
        max_rounds_sessions: maxRoundsSessions,
        // v2.22.0 (A.P2): suppress per-session enumeration unless
        // operator passes include_legacy=true. Headline count remains
        // in `totals.self_lead_metadata`.
        self_lead_metadata: includeLegacy ? selfLeadMetadata : [],
        open_evidence_sessions: openEvidenceSessions,
        not_resurfaced_evidence_sessions: notResurfacedEvidenceSessions,
        grok_provider_error_sessions: grokProviderErrorSessions,
        event_read_error_sessions: eventReadErrorSessions,
        terminal_event_missing_sessions: terminalEventMissingSessions,
      },
      event_noise: {
        events_total: eventsTotal,
        token_delta_events: tokenDeltaEvents,
        token_completed_events: tokenCompletedEvents,
        token_delta_ratio: eventsTotal > 0 ? tokenDeltaEvents / eventsTotal : null,
      },
      recommendations,
      // v3.6.0 (C): only present when repair was requested; lists the
      // converged+blocked contradictions that were recomputed.
      ...(repair ? { repaired } : {}),
    };
  }

  // v2.14.0 (item 1): compute precision/recall/F1 for the shadow judge
  // against empirical ground truth (whether peers raised the same ask
  // in a subsequent round). Walks events.ndjson per session, finds each
  // `session.evidence_judge_pass.shadow_decision` event, looks up the
  // matching item in `meta.evidence_checklist` by id, and classifies
  // based on (would_promote x ask_resurfaced). Returns per-peer rollup.
  computeJudgmentPrecisionReport(opts?: {
    peer?: PeerId | undefined;
    since?: string | undefined;
    session_id?: string | undefined;
  }): JudgmentPrecisionReport {
    const sessions = opts?.session_id ? [this.read(opts.session_id)] : this.list();
    const peerKnown: readonly PeerId[] = PEERS;
    const byPeer: Partial<Record<PeerId, JudgmentPrecisionPeerStats>> = {};
    let totalDecisions = 0;
    let totalWithGroundTruth = 0;
    let totalSkippedNoGT = 0;
    const acc = (peer: PeerId): JudgmentPrecisionPeerStats => {
      let entry = byPeer[peer];
      if (!entry) {
        entry = {
          judge_peer: peer,
          decisions_total: 0,
          decisions_with_ground_truth: 0,
          decisions_skipped_no_ground_truth: 0,
          true_positive: 0,
          false_positive: 0,
          true_negative: 0,
          false_negative: 0,
          precision: null,
          recall: null,
          f1: null,
          by_confidence: {},
        };
        byPeer[peer] = entry;
      }
      return entry;
    };
    for (const session of sessions) {
      const events = this.readEvents(session.session_id);
      const checklist = session.evidence_checklist ?? [];
      const itemById = new Map<string, EvidenceChecklistItem>();
      for (const item of checklist) itemById.set(item.id, item);
      const maxRound = session.rounds.length;
      for (const event of events) {
        if (event.type !== "session.evidence_judge_pass.shadow_decision") continue;
        const data = (event.data ?? {}) as {
          item_id?: string | undefined;
          would_promote?: boolean | undefined;
          confidence?: Confidence | undefined;
          judge_peer?: PeerId | undefined;
        };
        const judgePeer = data.judge_peer;
        if (!judgePeer || !peerKnown.includes(judgePeer)) continue;
        if (opts?.peer && judgePeer !== opts.peer) continue;
        if (opts?.since && event.ts && event.ts < opts.since) continue;
        const itemId = data.item_id;
        if (!itemId) continue;
        const item = itemById.get(itemId);
        if (!item) continue;
        const judgeRound = event.round ?? item.last_round;
        const peerStats = acc(judgePeer);
        peerStats.decisions_total += 1;
        totalDecisions += 1;
        // Ground truth: did the ask resurface AFTER the judge ran?
        // last_round > judgeRound → resurfaced. last_round === judgeRound
        // AND maxRound > judgeRound → not resurfaced (we have evidence
        // peers had a chance to ask again and didn't). last_round ===
        // judgeRound AND maxRound === judgeRound → no ground truth.
        const resurfaced = item.last_round > judgeRound;
        const peersHadChance = maxRound > judgeRound;
        if (!resurfaced && !peersHadChance) {
          peerStats.decisions_skipped_no_ground_truth += 1;
          totalSkippedNoGT += 1;
          continue;
        }
        peerStats.decisions_with_ground_truth += 1;
        totalWithGroundTruth += 1;
        const wouldPromote = data.would_promote === true;
        let bucket: "tp" | "fp" | "tn" | "fn";
        if (wouldPromote && !resurfaced) bucket = "tp";
        else if (wouldPromote && resurfaced) bucket = "fp";
        else if (!wouldPromote && resurfaced) bucket = "tn";
        else bucket = "fn";
        if (bucket === "tp") peerStats.true_positive += 1;
        else if (bucket === "fp") peerStats.false_positive += 1;
        else if (bucket === "tn") peerStats.true_negative += 1;
        else peerStats.false_negative += 1;
        if (data.confidence) {
          let bc = peerStats.by_confidence[data.confidence];
          if (!bc) {
            bc = { tp: 0, fp: 0, tn: 0, fn: 0 };
            peerStats.by_confidence[data.confidence] = bc;
          }
          bc[bucket] += 1;
        }
      }
    }
    // Compute precision/recall/f1 per peer.
    for (const peer of Object.keys(byPeer) as PeerId[]) {
      const stats = byPeer[peer];
      if (!stats) continue;
      const tp = stats.true_positive;
      const fp = stats.false_positive;
      const fn = stats.false_negative;
      stats.precision = tp + fp > 0 ? tp / (tp + fp) : null;
      stats.recall = tp + fn > 0 ? tp / (tp + fn) : null;
      stats.f1 =
        stats.precision != null && stats.recall != null && stats.precision + stats.recall > 0
          ? (2 * stats.precision * stats.recall) / (stats.precision + stats.recall)
          : null;
    }
    return {
      generated_at: now(),
      peer_filter: opts?.peer,
      since_filter: opts?.since,
      session_filter: opts?.session_id,
      decisions_total: totalDecisions,
      decisions_with_ground_truth: totalWithGroundTruth,
      decisions_skipped_no_ground_truth: totalSkippedNoGT,
      by_judge_peer: byPeer,
    };
  }

  // v2.14.0 (path-A structural fix): resolve `meta.evidence_files[]`
  // entries into in-memory contents for inlining into peer prompts.
  // Reads each attachment from disk, applies a per-file cap (60% of the
  // total cap to leave room for at least 1 other attachment + headers),
  // accumulates into a total-cap, and returns whatever fits. Order
  // preserved (oldest attachment first). Files that cannot be read
  // (deleted, permission denied) are skipped silently — the caller
  // sees only the metadata that survived. This closes the recurring
  // "meta-channel limit" pattern (v2.5.0, v2.13.0) where codex demanded
  // evidence the MCP `caller → server` 200KB channel could not carry:
  // the file content already lives in `data_dir/sessions/<id>/evidence/`
  // by the time we inline, so the only constraint is the peer model's
  // context window — much larger than the MCP boundary.
  readEvidenceAttachments(
    sessionId: string,
    totalCapChars: number,
  ): Array<{
    label: string;
    relative_path: string;
    content: string;
    bytes: number;
    truncated: boolean;
    content_type?: string | undefined;
  }> {
    if (!Number.isFinite(totalCapChars) || totalCapChars <= 0) return [];
    const meta = this.read(sessionId);
    const files = meta.evidence_files ?? [];
    if (!files.length) return [];
    const perFileCap = Math.max(2_000, Math.floor(totalCapChars * 0.6));
    const sessionDir = this.sessionDir(sessionId);
    const result: Array<{
      label: string;
      relative_path: string;
      content: string;
      bytes: number;
      truncated: boolean;
      content_type?: string | undefined;
    }> = [];
    let used = 0;
    for (const file of files) {
      const absolutePath = path.resolve(sessionDir, file.path);
      if (!this.isPathContained(sessionDir, absolutePath)) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(absolutePath, "utf8");
      } catch {
        continue;
      }
      const remaining = totalCapChars - used;
      if (remaining <= 0) break;
      const cap = Math.min(perFileCap, remaining);
      const truncated = raw.length > cap;
      const slice = truncated ? raw.slice(0, cap) : raw;
      result.push({
        label: file.label,
        relative_path: file.path,
        content: slice,
        bytes: raw.length,
        truncated,
        content_type: file.content_type,
      });
      used += slice.length;
    }
    return result;
  }

  // v2.14.0 (item 4): contest a final verdict. Stamps the contested
  // session's meta with the contestation record AND initializes a new
  // session that references back. Validates the original session is
  // in a final state (converged | aborted | max-rounds). Per the
  // tribunal-colegiado memory, this is the canonical "caller NOT_READY
  // → novo ciclo deliberativo dentro dos mesmos autos" surface — the
  // original session is preserved (append-only); a new session opens
  // for re-deliberation with a fresh task + initial_draft and a
  // structural reference back to the contested session.
  async contestVerdict(params: {
    session_id: string;
    reason: string;
    new_task: string;
    new_initial_draft?: string | undefined;
    new_caller?: PeerId | "operator" | undefined;
  }): Promise<{ contested_meta: SessionMeta; new_session_id: string }> {
    const original = this.read(params.session_id);
    if (!original.outcome) {
      throw new Error(
        `cannot_contest_in_flight_session: session ${params.session_id} has no outcome yet (still in flight). Wait for it to converge or finalize before contesting.`,
      );
    }
    if (original.contestation) {
      throw new Error(
        `session_already_contested: session ${params.session_id} was already contested at ${original.contestation.contested_at} (new_session_id=${original.contestation.new_session_id}).`,
      );
    }
    const newCaller: PeerId | "operator" = params.new_caller ?? "operator";
    const newSession = await this.init(params.new_task, newCaller, [], undefined);
    // Cross-link new session → original.
    await this.withSessionLock(newSession.session_id, async () => {
      const m = this.read(newSession.session_id);
      m.contests_session_id = params.session_id;
      m.updated_at = now();
      await writeJson(this.metaPath(newSession.session_id), m);
      return m;
    });
    // Stamp original with contestation record.
    const contestedMeta = await this.withSessionLock(params.session_id, async () => {
      const m = this.read(params.session_id);
      m.contestation = {
        contested_at: now(),
        reason: params.reason,
        original_outcome: m.outcome ?? null,
        new_session_id: newSession.session_id,
      };
      m.updated_at = now();
      await writeJson(this.metaPath(params.session_id), m);
      return m;
    });
    return { contested_meta: contestedMeta, new_session_id: newSession.session_id };
  }

  async attachEvidence(
    sessionId: string,
    params: { label: string; content: string; content_type?: string; extension?: string },
  ): Promise<{ path: string; meta: SessionMeta }> {
    const extension = safeFilePart(params.extension ?? "txt").replace(/\./g, "") || "txt";
    const label = safeFilePart(params.label);
    const relativePath = `evidence/${timestampFilePart()}-${label}.${extension}`;
    const file = path.join(this.sessionDir(sessionId), relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, redact(params.content), "utf8");

    const meta = await this.withSessionLock(sessionId, async () => {
      const current = this.read(sessionId);
      current.evidence_files = [
        ...(current.evidence_files ?? []),
        {
          ts: now(),
          label: params.label,
          path: relativePath.replace(/\\/g, "/"),
          content_type: params.content_type,
        },
      ];
      current.updated_at = now();
      await writeJson(this.metaPath(sessionId), current);
      return current;
    });

    return { path: relativePath.replace(/\\/g, "/"), meta };
  }

  async escalateToOperator(
    sessionId: string,
    params: { reason: string; severity: "info" | "warning" | "critical" },
  ): Promise<SessionMeta> {
    return this.withSessionLock(sessionId, async () => {
      const meta = this.read(sessionId);
      meta.operator_escalations = [
        ...(meta.operator_escalations ?? []),
        { ts: now(), reason: params.reason, severity: params.severity },
      ];
      meta.convergence_health = {
        state: meta.outcome === "converged" ? "converged" : "blocked",
        last_event_at: now(),
        detail: `Operator escalation requested: ${params.reason}`,
      };
      meta.updated_at = now();
      await writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  async sweepIdle(
    idleMs: number,
    outcome: "aborted" | "max-rounds" = "aborted",
    reason = "stale",
  ): Promise<SessionMeta[]> {
    const effectiveIdleMs = Math.max(idleMs, SWEEP_MIN_IDLE_MS);
    const nowMs = Date.now();
    const swept: SessionMeta[] = [];
    for (const session of this.list()) {
      if (session.outcome) continue;
      const updatedAt = Date.parse(session.updated_at);
      const idleFor = Number.isFinite(updatedAt) ? nowMs - updatedAt : Infinity;
      if (idleFor < effectiveIdleMs) continue;
      const finalized = await this.withSessionLock(session.session_id, async () => {
        const current = this.read(session.session_id);
        const ts = now();
        current.outcome = outcome;
        current.outcome_reason = reason;
        delete current.in_flight;
        current.convergence_health = {
          state: "stale",
          last_event_at: ts,
          detail: reason,
          idle_ms: idleFor,
        };
        current.updated_at = ts;
        await writeJson(this.metaPath(session.session_id), current);
        try {
          this.appendEventRecord({
            type: "session.finalized",
            session_id: session.session_id,
            ts,
            message: `Session finalized as ${outcome}${reason ? `: ${reason}` : ""}`,
            data: { outcome, reason, idle_ms: idleFor },
          });
        } catch {
          /* event persistence is best-effort; session_doctor will flag gaps */
        }
        return current;
      });
      swept.push(finalized);
    }
    return swept;
  }

  // v2.4.0 / audit closure (P1.3 companion): boot sweep of orphan .tmp
  // files. Crashes inside writeJson (between writeFileSync and renameSync)
  // leave files matching `<basename>.<pid>.<ts>.<nonce>.tmp` in the session
  // directory. Walk every session dir at boot, drop files matching the
  // .tmp pattern whose holder pid is dead OR whose timestamp is older than
  // 1h. Idempotent + best-effort. Returns counts for telemetry.
  // v3.7.5 (B1, logs+sessions study 2026-05-15): prune the
  // `<data_dir>/corrupt_sessions/` quarantine directory. Created
  // historically when meta.json corruption was severe enough to move
  // the whole session dir (one such case from the 2026-05-08 v2.25.1
  // redact escape-boundary bug remains on disk). Pre-v3.7.5 there was
  // no automated cleanup — the entries accumulated forever even after
  // root-cause fixes shipped. This method scans the directory and
  // removes subdirectories whose mtime is older than `minAgeMs`,
  // leaving fresher cases for forensic inspection. Read-only when the
  // dir does not exist. Errors per-entry are swallowed and surface as
  // `kept` so a single permission failure doesn't abort the sweep.
  pruneCorruptSessions(minAgeMs: number): { scanned: number; removed: number; kept: number } {
    const corruptDir = path.join(this.config.data_dir, "corrupt_sessions");
    if (!fs.existsSync(corruptDir)) return { scanned: 0, removed: 0, kept: 0 };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(corruptDir, { withFileTypes: true });
    } catch {
      return { scanned: 0, removed: 0, kept: 0 };
    }
    const cutoff = Date.now() - Math.max(0, minAgeMs);
    let scanned = 0;
    let removed = 0;
    let kept = 0;
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      scanned += 1;
      const entryPath = path.join(corruptDir, ent.name);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(entryPath).mtimeMs;
      } catch {
        kept += 1;
        continue;
      }
      if (mtimeMs > cutoff) {
        kept += 1;
        continue;
      }
      try {
        fs.rmSync(entryPath, { recursive: true, force: true });
        removed += 1;
      } catch {
        kept += 1;
      }
    }
    return { scanned, removed, kept };
  }

  sweepOrphanTmpFiles(): { scanned: number; removed: number } {
    let scanned = 0;
    let removed = 0;
    const root = this.sessionsDir();
    if (!fs.existsSync(root)) return { scanned, removed };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return { scanned, removed };
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const sessionPath = path.join(root, ent.name);
      let files: string[];
      try {
        files = fs.readdirSync(sessionPath);
      } catch {
        continue;
      }
      for (const f of files) {
        const m = TMP_FILE_PATTERN.exec(f);
        if (!m) continue;
        scanned += 1;
        const tmpPid = Number.parseInt(m[1] ?? "", 10);
        const tmpTs = Number.parseInt(m[2] ?? "", 10);
        const tmpAge = Date.now() - tmpTs;
        const holderAlive = Number.isInteger(tmpPid) ? this.processAlive(tmpPid) : false;
        if (!holderAlive || tmpAge > TMP_STALE_AFTER_MS) {
          try {
            fs.unlinkSync(path.join(sessionPath, f));
            removed += 1;
          } catch {
            /* ignore */
          }
        }
      }
    }
    return { scanned, removed };
  }

  // v2.4.0 / audit closure (P3.11): clear stale meta.in_flight at boot.
  // `markInFlight` sets meta.in_flight before each round and clearInFlight
  // is supposed to clear it on resolve/reject. If the host crashes
  // mid-spawn, in_flight stays set forever — confusing audit consumers
  // and `recoverInterruptedSessions` consumers that read it as "round in
  // progress". sweepIdle clears in_flight only after 24h idle (footgun
  // floor). This companion sweep covers the common host-crash case where
  // we want to reconcile in_flight as soon as the new boot starts, not
  // after a day. Conditions to clear:
  //   - holder pid (lock holder, if any) is dead, OR
  //   - in_flight.started_at is older than HEARTBEAT_STALE_AFTER_MS.
  // Sessions still actively running on a live PID are skipped. Idempotent
  // + best-effort. Returns counts for telemetry.
  async clearStaleInFlight(): Promise<{ scanned: number; cleared: number }> {
    const HEARTBEAT_STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes
    let scanned = 0;
    let cleared = 0;
    for (const session of this.list()) {
      if (!session.in_flight) continue;
      scanned += 1;
      const startedIso = session.in_flight.started_at;
      const startedAge = startedIso ? Date.now() - Date.parse(startedIso) : Infinity;
      // v4.1.0: lock-holder freshness is reported by proper-lockfile's
      // mtime-based stale detection. lockfile.check returns true if the
      // lock is actively held (mtime within `stale` ms), false otherwise.
      // This replaces the pre-v4.1.0 PID-aliveness check, which had
      // collision risk after PID-recycling restart.
      let holderAlive: boolean;
      try {
        holderAlive = await lockfile.check(this.metaPath(session.session_id), {
          stale: 120_000,
          realpath: false,
          lockfilePath: path.join(this.sessionDir(session.session_id), ".lock"),
        });
      } catch {
        // metaPath missing or unreadable: treat as no active holder.
        holderAlive = false;
      }
      // Fallback heartbeat staleness signal when no active lock and
      // started_at indicates the in_flight marker itself is stale.
      if (!holderAlive && Number.isFinite(startedAge) && startedAge <= HEARTBEAT_STALE_AFTER_MS) {
        // No live holder but started_at is recent; do nothing yet (lock
        // may have been released cleanly; let normal finalize handle it).
        continue;
      }
      if (!holderAlive || startedAge > HEARTBEAT_STALE_AFTER_MS) {
        try {
          await this.withSessionLock(session.session_id, async () => {
            const current = this.read(session.session_id);
            if (!current.in_flight) return;
            delete current.in_flight;
            current.updated_at = now();
            await writeJson(this.metaPath(session.session_id), current);
            cleared += 1;
          });
        } catch {
          /* best-effort */
        }
      }
    }
    return { scanned, cleared };
  }

  // v2.5.0: abort sessions that were never finalized.
  //
  // Empirical analysis of 253 historical sessions surfaced 22 in-progress
  // orphans where every peer had reached READY but the caller never
  // invoked `session_finalize`. Those sessions stayed at `outcome:
  // undefined` indefinitely, polluting `session_list` and stealing rows
  // from `session_recover_interrupted` consumers that interpret a missing
  // outcome as "still running".
  //
  // The session-start contract (orchestrator.ts > sessionContractDirectives
  // rule 4) now codifies the caller's finalize obligation; this boot
  // sweep cleans up the cases where the caller exited without honoring
  // that contract. It is a companion to `clearStaleInFlight`, with a
  // longer threshold because the failure mode is "host died after a
  // session ran", not "host died mid-round".
  //
  // Conditions to abort:
  //   - meta.outcome is undefined (not finalized);
  //   - meta.in_flight is absent (i.e. the in-flight sweep already ran or
  //     the session was never marked in-flight); a still-in-flight session
  //     is the inFlight sweep's job, not ours;
  //   - no active lock holder, OR the session is past the staleness
  //     threshold (default 24h via CROSS_REVIEW_STALE_HOURS).
  //
  // Idempotent + best-effort. Returns counts for telemetry.
  async abortStaleSessions(staleHours?: number): Promise<{ scanned: number; aborted: number }> {
    const envHours = Number.parseFloat(process.env.CROSS_REVIEW_STALE_HOURS ?? "");
    const hours =
      staleHours != null && staleHours > 0
        ? staleHours
        : Number.isFinite(envHours) && envHours > 0
          ? envHours
          : 24;
    const staleThresholdMs = hours * 60 * 60 * 1000;
    let scanned = 0;
    let aborted = 0;
    for (const session of this.list()) {
      // Already finalized? Skip.
      if (session.outcome) continue;
      // Currently in-flight? Don't race the in-flight sweep — let it
      // either clear in_flight (next pass aborts) or leave it in place
      // (legitimate running session, must not be touched).
      if (session.in_flight) continue;
      scanned += 1;
      // v4.1.0: lock-holder freshness via proper-lockfile mtime-based
      // stale detection. lockfile.check returns true if a live holder
      // is touching the lockfile mtime within `stale` ms.
      let holderAlive: boolean;
      try {
        holderAlive = await lockfile.check(this.metaPath(session.session_id), {
          stale: 120_000,
          realpath: false,
          lockfilePath: path.join(this.sessionDir(session.session_id), ".lock"),
        });
      } catch {
        holderAlive = false;
      }
      if (holderAlive) continue;
      const lastTouched = Date.parse(session.updated_at);
      if (!Number.isFinite(lastTouched)) continue;
      if (Date.now() - lastTouched < staleThresholdMs) continue;
      try {
        await this.finalize(session.session_id, "aborted", `stale_no_finalize_${hours}h`);
        aborted += 1;
      } catch {
        /* best-effort */
      }
    }
    return { scanned, aborted };
  }
}
