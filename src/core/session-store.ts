import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AppConfig,
  Confidence,
  ConvergenceResult,
  ConvergenceScope,
  EvidenceChecklistItem,
  EvidenceChecklistStatus,
  EvidenceStatusHistoryEntry,
  GenerationResult,
  GenerationArtifact,
  PeerFailure,
  PeerHealthSummary,
  PeerId,
  PeerProbeResult,
  PeerResult,
  RuntimeEvent,
  RuntimeMetrics,
  SessionDoctorEntry,
  SessionDoctorReport,
  SessionEvent,
  ReviewRound,
  ReviewStatus,
  SessionMeta,
  JudgmentPrecisionPeerStats,
  JudgmentPrecisionReport,
  ShadowJudgmentPeerStats,
  ShadowJudgmentRollup,
} from "./types.js";
import { PEERS } from "./types.js";
import { mergeCost, mergeUsage } from "./cost.js";
import { redact } from "../security/redact.js";

export const SWEEP_MIN_IDLE_MS = 24 * 60 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
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

function writeJson(file: string, data: unknown): void {
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
      const wait = 10 * 2 ** attempt; // 10, 20, 40, 80, 160 ms
      const start = Date.now();
      while (Date.now() - start < wait) {
        /* spin — sync write path, brief by design */
      }
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

  private sleepSync(ms: number): void {
    const buffer = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buffer), 0, 0, ms);
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

  private withSessionLock<T>(sessionId: string, fn: () => T): T {
    const dir = this.sessionDir(sessionId);
    const lockPath = path.join(dir, ".lock");
    const timeoutAt = Date.now() + 30_000;
    while (true) {
      try {
        const fd = fs.openSync(lockPath, "wx");
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquired_at: now() }));
        fs.closeSync(fd);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lock = readJson<{ pid?: number; acquired_at?: string }>(lockPath);
          const age = lock.acquired_at ? Date.now() - Date.parse(lock.acquired_at) : Infinity;
          if (!lock.pid || age > 120_000 || !this.processAlive(lock.pid)) {
            fs.rmSync(lockPath, { force: true });
            continue;
          }
        } catch {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
        if (Date.now() >= timeoutAt) {
          throw new Error(`timed out waiting for session lock: ${sessionId}`, { cause: error });
        }
        this.sleepSync(100);
      }
    }

    try {
      return fn();
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  }

  init(
    task: string,
    caller: PeerId | "operator",
    snapshot: PeerProbeResult[],
    reviewFocus?: string,
  ): SessionMeta {
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
    writeJson(this.metaPath(session_id), meta);
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

  // v2.4.0 / cross-review-v2 R5 (codex blocker): refuse to overwrite an
  // existing in_flight when starting a new round. Pre-R5 markInFlight
  // unconditionally clobbered `meta.in_flight`, so a second concurrent
  // ask_peers on the same session would silently steamroll the first
  // round's state — and the format-recovery quota counter would race
  // because both calls could read the same `recoveriesAlready` baseline.
  // R5 throws when in_flight is already populated; the boot-time
  // `clearStaleInFlight` sweep clears any orphan in_flight from a
  // crashed prior host so legitimate operators are not blocked.
  markInFlight(
    sessionId: string,
    params: {
      round: number;
      peers: PeerId[];
      started_at: string;
      scope: ConvergenceScope;
    },
  ): SessionMeta {
    return this.withSessionLock(sessionId, () => {
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
      writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  read(sessionId: string): SessionMeta {
    return readJson<SessionMeta>(this.metaPath(sessionId));
  }

  // v2.4.0 / audit closure (P3.13) — refined after cross-review-v2 R2 (codex
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

  appendEvent(event: RuntimeEvent): void {
    const sessionId = event.session_id;
    if (!sessionId) return;
    try {
      this.withSessionLock(sessionId, () => {
        const file = this.eventsPath(sessionId);
        const seq = this.peekNextSeq(sessionId, file);
        fs.appendFileSync(
          file,
          `${JSON.stringify({ ...event, seq, ts: event.ts ?? now() })}\n`,
          "utf8",
        );
        // Only commit the cache AFTER the durable append succeeded.
        // If appendFileSync threw above, the cache still reflects the
        // last persisted seq and the next call reuses this seq number.
        this.commitSeq(sessionId, seq);
      });
    } catch {
      // Event persistence must never break provider calls or MCP responses.
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
              `[cross-review-v2] quarantined corrupted meta.json at ${file} -> ${quarantine} (${message})`,
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
  // 60 days (configurable via CROSS_REVIEW_V2_PRUNE_AFTER_DAYS env var or
  // explicit arg). Only removes sessions whose outcome is terminal (converged
  // | aborted | max-rounds) AND whose updated_at is older than the cutoff.
  // In-flight or untyped-outcome sessions are never pruned. Idempotent +
  // best-effort. Empirically motivated by 534 sessions accumulated on disk
  // by 2026-05-12 inflating cold-start sweep cost.
  pruneOldSessions(maxAgeDays?: number): { scanned: number; pruned: number } {
    const envDays = Number.parseFloat(process.env.CROSS_REVIEW_V2_PRUNE_AFTER_DAYS ?? "");
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

  saveGeneration(
    sessionId: string,
    round: number,
    result: GenerationResult,
    label = "generation",
  ): string {
    const file = path.join(
      this.sessionDir(sessionId),
      "agent-runs",
      `round-${round}-${result.peer}-${label}.json`,
    );
    writeJson(file, { ...result, text: redact(result.text) });
    const relativePath = path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
    this.withSessionLock(sessionId, () => {
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
      writeJson(this.metaPath(sessionId), meta);
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

  savePeerResult(sessionId: string, round: number, result: PeerResult, label = "response"): string {
    const file = path.join(
      this.sessionDir(sessionId),
      "agent-runs",
      `round-${round}-${result.peer}-${label}.json`,
    );
    writeJson(file, { ...result, text: redact(result.text) });
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  savePeerFailure(sessionId: string, round: number, failure: PeerFailure): string {
    const file = path.join(
      this.sessionDir(sessionId),
      "agent-runs",
      `round-${round}-${failure.peer}-failure.json`,
    );
    writeJson(file, { ...failure, message: redact(failure.message) });
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  appendRound(
    sessionId: string,
    params: {
      caller_status: ReviewStatus;
      draft_file?: string;
      prompt_file: string;
      peers: PeerResult[];
      rejected: PeerFailure[];
      convergence: ConvergenceResult;
      convergence_scope: ConvergenceScope;
      started_at: string;
    },
  ): ReviewRound {
    return this.withSessionLock(sessionId, () => {
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
      writeJson(this.metaPath(sessionId), meta);
      return round;
    });
  }

  // v2.22.0 (B.P3): one-shot guard for `session.budget_warning` emit
  // idempotency. Persisted in meta.json so the warning fires at most
  // once per session even across host restarts.
  markBudgetWarningEmitted(sessionId: string): SessionMeta {
    return this.withSessionLock(sessionId, () => {
      const meta = this.read(sessionId);
      meta.budget_warning_emitted = true;
      meta.updated_at = now();
      writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  // v2.25.0 (circular mode): atomically replace meta.circular_state. The
  // orchestrator's circular loop calls this every round so resumed
  // sessions can pick up the rotation cursor and consecutive-no-change
  // count from disk without re-deriving them by walking events.
  setCircularState(
    sessionId: string,
    state: NonNullable<SessionMeta["circular_state"]>,
  ): SessionMeta {
    return this.withSessionLock(sessionId, () => {
      const meta = this.read(sessionId);
      meta.circular_state = state;
      meta.updated_at = now();
      writeJson(this.metaPath(sessionId), meta);
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

  finalize(
    sessionId: string,
    outcome: NonNullable<SessionMeta["outcome"]>,
    reason?: string,
  ): SessionMeta {
    return this.withSessionLock(sessionId, () => {
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
        if (latest.convergence?.converged !== true) {
          const err = new Error(
            `session_finalize_outcome_mismatch: cannot finalize as "converged" — latest round (round=${latest.round}) has convergence.converged=${latest.convergence?.converged ?? "undefined"}, reason="${latest.convergence?.reason ?? "n/a"}"`,
          );
          (err as Error & { code?: string }).code = "session_finalize_outcome_mismatch";
          throw err;
        }
      }
      meta.outcome = outcome;
      if (reason) meta.outcome_reason = reason;
      delete meta.in_flight;
      meta.convergence_health = {
        state:
          outcome === "converged" ? "converged" : outcome === "max-rounds" ? "blocked" : "stale",
        last_event_at: now(),
        detail: reason ?? outcome,
      };
      meta.updated_at = now();
      writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  requestCancellation(
    sessionId: string,
    reason = "operator_requested",
    jobId?: string,
  ): SessionMeta {
    return this.withSessionLock(sessionId, () => {
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
      writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  markCancelled(sessionId: string, reason = "cancelled"): SessionMeta {
    return this.withSessionLock(sessionId, () => {
      const meta = this.read(sessionId);
      meta.outcome = "aborted";
      meta.outcome_reason = reason;
      delete meta.in_flight;
      meta.control = {
        status: "cancelled",
        reason,
        job_id: meta.control?.job_id,
        requested_at: meta.control?.requested_at,
        updated_at: now(),
      };
      meta.convergence_health = {
        state: "stale",
        last_event_at: now(),
        detail: reason,
      };
      meta.updated_at = now();
      writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  isCancellationRequested(sessionId: string): boolean {
    const meta = this.read(sessionId);
    return meta.control?.status === "cancel_requested";
  }

  appendFallbackEvent(
    sessionId: string,
    event: NonNullable<SessionMeta["fallback_events"]>[number],
  ): SessionMeta {
    return this.withSessionLock(sessionId, () => {
      const meta = this.read(sessionId);
      meta.fallback_events = [...(meta.fallback_events ?? []), event];
      meta.updated_at = now();
      writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  // v2.7.0 Evidence Broker: aggregate NEEDS_EVIDENCE asks from a round
  // into the session-level checklist. Each (peer, ask) pair is
  // deduplicated by sha256(peer + ":" + ask) so the same ask repeated
  // across rounds increments `round_count` instead of producing
  // duplicate entries. Returns the updated checklist (or empty array
  // if nothing was added/updated).
  appendEvidenceChecklistItems(
    sessionId: string,
    round: number,
    incoming: Array<{ peer: PeerId; ask: string }>,
  ): NonNullable<SessionMeta["evidence_checklist"]> {
    if (!incoming.length) return [];
    return this.withSessionLock(sessionId, () => {
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
      writeJson(this.metaPath(sessionId), meta);
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
  runEvidenceChecklistAddressDetection(
    sessionId: string,
    currentRound: number,
  ): {
    addressed: EvidenceChecklistItem[];
    reopened: EvidenceChecklistItem[];
    peer_resurfaced_terminal: EvidenceChecklistItem[];
  } {
    return this.withSessionLock(sessionId, () => {
      const meta = this.read(sessionId);
      const checklist = meta.evidence_checklist ?? [];
      if (!checklist.length) {
        return { addressed: [], reopened: [], peer_resurfaced_terminal: [] };
      }
      const addressed: EvidenceChecklistItem[] = [];
      const reopened: EvidenceChecklistItem[] = [];
      const peerResurfacedTerminal: EvidenceChecklistItem[] = [];
      const history = meta.evidence_status_history ?? [];
      const ts = now();
      for (const item of checklist) {
        const status: EvidenceChecklistStatus = item.status ?? "open";
        if (status === "open" && item.last_round < currentRound) {
          item.status = "addressed";
          item.addressed_at_round = currentRound;
          // v2.9.0: tag the inference path so the dashboard and audit
          // trail can distinguish runtime resurfacing from runtime judge
          // promotions. Operator-set terminal statuses do not populate
          // this field; setEvidenceChecklistItemStatus clears it.
          item.address_method = "resurfacing";
          delete item.judge_rationale;
          addressed.push(item);
          history.push({
            ts,
            item_id: item.id,
            from: "open",
            to: "addressed",
            by: "runtime",
            round: currentRound,
            note: `auto: peer did not resurface ask in round ${currentRound}`,
          });
        } else if (status === "addressed" && item.last_round === currentRound) {
          item.status = "open";
          delete item.addressed_at_round;
          delete item.address_method;
          delete item.judge_rationale;
          reopened.push(item);
          history.push({
            ts,
            item_id: item.id,
            from: "addressed",
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
      if (addressed.length || reopened.length) {
        meta.evidence_status_history = history;
        meta.updated_at = ts;
        writeJson(this.metaPath(sessionId), meta);
      }
      return { addressed, reopened, peer_resurfaced_terminal: peerResurfacedTerminal };
    });
  }

  // v2.8.0: operator workflow mutator for the evidence checklist. Used by
  // the session_evidence_checklist_update MCP tool. Allowed transitions
  // (operator): open → satisfied | deferred | rejected | open;
  // addressed → satisfied | deferred | rejected | open. Terminal-state
  // items can also be moved BACK to "open" by the operator (retract a
  // deferral/rejection); that re-arms the runtime auto-promotion logic.
  // Operator CANNOT move items to "addressed" — that status is
  // runtime-managed (resurfacing inference). Returns the mutated item
  // and the appended history entry.
  setEvidenceChecklistItemStatus(
    sessionId: string,
    itemId: string,
    status: Exclude<EvidenceChecklistStatus, "addressed">,
    options: { note?: string; by?: "operator" | "runtime" } = {},
  ): { item: EvidenceChecklistItem; history_entry: EvidenceStatusHistoryEntry } {
    return this.withSessionLock(sessionId, () => {
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
      writeJson(this.metaPath(sessionId), meta);
      return { item, history_entry: entry };
    });
  }

  // v2.9.0: runtime-judge promotion path. Promotes an `open` item to
  // `addressed` ONLY — never touches terminal operator statuses, never
  // moves anything other than open. Atomic under the session lock.
  // Returns null when the item is not currently `open` (already
  // addressed, terminal, or missing) so the caller can skip emit.
  markEvidenceItemAddressedByJudge(
    sessionId: string,
    itemId: string,
    params: { round: number; rationale: string; judge_peer: PeerId },
  ): { item: EvidenceChecklistItem; history_entry: EvidenceStatusHistoryEntry } | null {
    return this.withSessionLock(sessionId, () => {
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
      writeJson(this.metaPath(sessionId), meta);
      return { item, history_entry: entry };
    });
  }

  recoverInterruptedSessions(activeSessionIds = new Set<string>()): SessionMeta[] {
    const recovered: SessionMeta[] = [];
    for (const session of this.list()) {
      if (session.outcome || activeSessionIds.has(session.session_id) || !session.in_flight)
        continue;
      const updated = this.withSessionLock(session.session_id, () => {
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
        writeJson(this.metaPath(current.session_id), current);
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
          judge_peer?: PeerId;
          would_promote?: boolean;
          satisfied?: boolean;
          confidence?: "verified" | "inferred" | "unknown";
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
  sessionDoctor(limit = 20, includeLegacy = false): SessionDoctorReport {
    const cappedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 20));
    const sessions = this.list();
    const openSessions: SessionDoctorEntry[] = [];
    const staleSessions: SessionDoctorEntry[] = [];
    const blockedSessions: SessionDoctorEntry[] = [];
    const maxRoundsSessions: SessionDoctorEntry[] = [];
    const selfLeadMetadata: SessionDoctorEntry[] = [];
    const openEvidenceSessions: SessionDoctorEntry[] = [];
    const grokProviderErrorSessions: SessionDoctorEntry[] = [];
    const eventReadErrorSessions: SessionDoctorEntry[] = [];
    let eventsTotal = 0;
    let tokenDeltaEvents = 0;
    let tokenCompletedEvents = 0;

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
      const grokProviderErrors = (session.failed_attempts ?? []).filter(
        (failure) => failure.peer === "grok" && failure.failure_class === "provider_error",
      ).length;
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

      if (!session.outcome) pushLimited(openSessions, entry);
      if (session.convergence_health?.state === "stale") pushLimited(staleSessions, entry);
      if (session.convergence_health?.state === "blocked") pushLimited(blockedSessions, entry);
      if (session.outcome === "max-rounds") pushLimited(maxRoundsSessions, entry);
      if (petitioner && leadPeer && petitioner === leadPeer) pushLimited(selfLeadMetadata, entry);
      if (openEvidenceItems > 0) pushLimited(openEvidenceSessions, entry);
      if (grokProviderErrors > 0) pushLimited(grokProviderErrorSessions, entry);

      let sessionEvents: SessionEvent[] = [];
      try {
        sessionEvents = this.readEvents(session.session_id);
      } catch (error) {
        entry.event_read_error = redact(error instanceof Error ? error.message : String(error));
        pushLimited(eventReadErrorSessions, entry);
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
        "Token delta events dominate this corpus; increase CROSS_REVIEW_V2_TOKEN_DELTA_CHARS_THRESHOLD or disable token streaming for low-noise audits.",
      );
    }

    return {
      generated_at: now(),
      scope: "all",
      limit: cappedLimit,
      totals: {
        sessions: sessions.length,
        open: sessions.filter((session) => !session.outcome).length,
        stale: sessions.filter((session) => session.convergence_health?.state === "stale").length,
        blocked: sessions.filter((session) => session.convergence_health?.state === "blocked")
          .length,
        max_rounds: sessions.filter((session) => session.outcome === "max-rounds").length,
        self_lead_metadata: selfLeadCount,
        open_evidence_sessions: sessions.filter((session) =>
          (session.evidence_checklist ?? []).some((item) => (item.status ?? "open") === "open"),
        ).length,
        grok_provider_error_sessions: sessions.filter((session) =>
          (session.failed_attempts ?? []).some(
            (failure) => failure.peer === "grok" && failure.failure_class === "provider_error",
          ),
        ).length,
        event_read_error_sessions: eventReadErrorSessions.length,
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
        grok_provider_error_sessions: grokProviderErrorSessions,
        event_read_error_sessions: eventReadErrorSessions,
      },
      event_noise: {
        events_total: eventsTotal,
        token_delta_events: tokenDeltaEvents,
        token_completed_events: tokenCompletedEvents,
        token_delta_ratio: eventsTotal > 0 ? tokenDeltaEvents / eventsTotal : null,
      },
      recommendations,
    };
  }

  // v2.14.0 (item 1): compute precision/recall/F1 for the shadow judge
  // against empirical ground truth (whether peers raised the same ask
  // in a subsequent round). Walks events.ndjson per session, finds each
  // `session.evidence_judge_pass.shadow_decision` event, looks up the
  // matching item in `meta.evidence_checklist` by id, and classifies
  // based on (would_promote x ask_resurfaced). Returns per-peer rollup.
  computeJudgmentPrecisionReport(opts?: {
    peer?: PeerId;
    since?: string;
    session_id?: string;
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
          item_id?: string;
          would_promote?: boolean;
          confidence?: Confidence;
          judge_peer?: PeerId;
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
    content_type?: string;
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
      content_type?: string;
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
  contestVerdict(params: {
    session_id: string;
    reason: string;
    new_task: string;
    new_initial_draft?: string;
    new_caller?: PeerId | "operator";
  }): { contested_meta: SessionMeta; new_session_id: string } {
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
    const newSession = this.init(params.new_task, newCaller, [], undefined);
    // Cross-link new session → original.
    this.withSessionLock(newSession.session_id, () => {
      const m = this.read(newSession.session_id);
      m.contests_session_id = params.session_id;
      m.updated_at = now();
      writeJson(this.metaPath(newSession.session_id), m);
      return m;
    });
    // Stamp original with contestation record.
    const contestedMeta = this.withSessionLock(params.session_id, () => {
      const m = this.read(params.session_id);
      m.contestation = {
        contested_at: now(),
        reason: params.reason,
        original_outcome: m.outcome ?? null,
        new_session_id: newSession.session_id,
      };
      m.updated_at = now();
      writeJson(this.metaPath(params.session_id), m);
      return m;
    });
    return { contested_meta: contestedMeta, new_session_id: newSession.session_id };
  }

  attachEvidence(
    sessionId: string,
    params: { label: string; content: string; content_type?: string; extension?: string },
  ): { path: string; meta: SessionMeta } {
    const extension = safeFilePart(params.extension ?? "txt").replace(/\./g, "") || "txt";
    const label = safeFilePart(params.label);
    const relativePath = `evidence/${timestampFilePart()}-${label}.${extension}`;
    const file = path.join(this.sessionDir(sessionId), relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, redact(params.content), "utf8");

    const meta = this.withSessionLock(sessionId, () => {
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
      writeJson(this.metaPath(sessionId), current);
      return current;
    });

    return { path: relativePath.replace(/\\/g, "/"), meta };
  }

  escalateToOperator(
    sessionId: string,
    params: { reason: string; severity: "info" | "warning" | "critical" },
  ): SessionMeta {
    return this.withSessionLock(sessionId, () => {
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
      writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  sweepIdle(
    idleMs: number,
    outcome: "aborted" | "max-rounds" = "aborted",
    reason = "stale",
  ): SessionMeta[] {
    const effectiveIdleMs = Math.max(idleMs, SWEEP_MIN_IDLE_MS);
    const nowMs = Date.now();
    const swept: SessionMeta[] = [];
    for (const session of this.list()) {
      if (session.outcome) continue;
      const updatedAt = Date.parse(session.updated_at);
      const idleFor = Number.isFinite(updatedAt) ? nowMs - updatedAt : Infinity;
      if (idleFor < effectiveIdleMs) continue;
      const finalized = this.withSessionLock(session.session_id, () => {
        const current = this.read(session.session_id);
        current.outcome = outcome;
        current.outcome_reason = reason;
        delete current.in_flight;
        current.convergence_health = {
          state: "stale",
          last_event_at: now(),
          detail: reason,
          idle_ms: idleFor,
        };
        current.updated_at = now();
        writeJson(this.metaPath(session.session_id), current);
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
  clearStaleInFlight(): { scanned: number; cleared: number } {
    const HEARTBEAT_STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes
    let scanned = 0;
    let cleared = 0;
    for (const session of this.list()) {
      if (!session.in_flight) continue;
      scanned += 1;
      const startedIso = session.in_flight.started_at;
      const startedAge = startedIso ? Date.now() - Date.parse(startedIso) : Infinity;
      // Best-effort liveness probe via the active lock holder pid (if any).
      let holderAlive = true;
      const lockPath = path.join(this.sessionDir(session.session_id), ".lock");
      if (fs.existsSync(lockPath)) {
        try {
          const lock = readJson<{ pid?: number }>(lockPath);
          if (Number.isInteger(lock.pid)) {
            holderAlive = this.processAlive(lock.pid as number);
          }
        } catch {
          // malformed lock — assume dead so the lock sweep cleans it up.
          holderAlive = false;
        }
      } else {
        // No active lock — heartbeat staleness is the only signal.
        holderAlive = !Number.isFinite(startedAge) ? false : startedAge <= HEARTBEAT_STALE_AFTER_MS;
      }
      if (!holderAlive || startedAge > HEARTBEAT_STALE_AFTER_MS) {
        try {
          this.withSessionLock(session.session_id, () => {
            const current = this.read(session.session_id);
            if (!current.in_flight) return;
            delete current.in_flight;
            current.updated_at = now();
            writeJson(this.metaPath(session.session_id), current);
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
  //     threshold (default 24h via CROSS_REVIEW_V2_STALE_HOURS).
  //
  // Idempotent + best-effort. Returns counts for telemetry.
  abortStaleSessions(staleHours?: number): { scanned: number; aborted: number } {
    const envHours = Number.parseFloat(process.env.CROSS_REVIEW_V2_STALE_HOURS ?? "");
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
      // Live lock holder => assume still running, skip.
      const lockPath = path.join(this.sessionDir(session.session_id), ".lock");
      if (fs.existsSync(lockPath)) {
        try {
          const lock = readJson<{ pid?: number }>(lockPath);
          if (Number.isInteger(lock.pid) && this.processAlive(lock.pid as number)) {
            continue;
          }
        } catch {
          /* malformed lock — fall through to staleness check */
        }
      }
      const lastTouched = Date.parse(session.updated_at);
      if (!Number.isFinite(lastTouched)) continue;
      if (Date.now() - lastTouched < staleThresholdMs) continue;
      try {
        this.finalize(session.session_id, "aborted", `stale_no_finalize_${hours}h`);
        aborted += 1;
      } catch {
        /* best-effort */
      }
    }
    return { scanned, aborted };
  }
}
