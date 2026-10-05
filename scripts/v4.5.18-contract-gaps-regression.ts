import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { checkConvergence } from "../src/core/convergence.js";
import {
  CrossReviewOrchestrator,
  groundReadyPeerEvidence,
  peerAuthoredEvidenceChecklistAsks,
} from "../src/core/orchestrator.js";
import type {
  AppConfig,
  EvidenceAskJudgment,
  PeerAdapter,
  PeerCallContext,
  PeerId,
  PeerResult,
} from "../src/core/types.js";
import { PEERS } from "../src/core/types.js";
import { BasePeerAdapter } from "../src/peers/base.js";
import { StubAdapter } from "../src/peers/stub.js";

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";

const tempDirs: string[] = [];

function fixtureConfig(
  label: string,
  overrides: (base: AppConfig) => Partial<AppConfig> = () => ({}),
): AppConfig {
  const base = loadConfig();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `cross-review-v4518-contract-${label}-`));
  tempDirs.push(dataDir);
  const common: AppConfig = {
    ...base,
    stub: true,
    data_dir: dataDir,
    cache: { ...base.cache, enabled: false },
    peer_enabled: Object.fromEntries(PEERS.map((peer) => [peer, true])) as Record<PeerId, boolean>,
    evidence_preflight_enabled: false,
    truthfulness_preflight_enabled: false,
    evidence_judge_autowire: {
      ...base.evidence_judge_autowire,
      mode: "off",
      active: false,
      peer: undefined,
      consensus_peers: [],
      max_items_per_pass: 4,
      max_output_tokens: 512,
    },
    cost_rates: {
      codex: { input_per_million: 0, output_per_million: 0 },
      claude: { input_per_million: 0, output_per_million: 0 },
      gemini: { input_per_million: 0, output_per_million: 0 },
      deepseek: { input_per_million: 0, output_per_million: 0 },
      grok: { input_per_million: 0, output_per_million: 0 },
      perplexity: {
        input_per_million: 0,
        output_per_million: 0,
        // v4.6.0: the canonical Agent API pin bills web_search per
        // invocation; the fee dimension must exist for paid readiness.
        search_queries_per_1000: 0,
      },
    },
    budget: {
      ...base.budget,
      max_session_cost_usd: 10_000,
      preflight_max_round_cost_usd: 10_000,
      until_stopped_max_cost_usd: 10_000,
    },
  };
  return { ...common, ...overrides(common) };
}

function stubAdapters(config: AppConfig): Record<PeerId, PeerAdapter> {
  return Object.fromEntries(
    PEERS.map((peer) => [peer, new StubAdapter(config, peer)]),
  ) as unknown as Record<PeerId, PeerAdapter>;
}

function judgeResult(peer: PeerId): EvidenceAskJudgment {
  return {
    peer,
    provider: `fixture-${peer}`,
    model: `fixture-${peer}`,
    satisfied: false,
    confidence: "verified",
    rationale: "The exact requested evidence is still absent.",
    raw: { fixture: true },
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    },
    cost: {
      currency: "USD",
      total_cost: 0,
      estimated: false,
      source: "stub",
    },
    latency_ms: 1,
    attempts: 1,
    parser_warnings: [],
  };
}

function reviewResult(peer: PeerId, status: "READY" | "NEEDS_EVIDENCE", ask: string): PeerResult {
  return {
    peer,
    provider: `fixture-${peer}`,
    model: `fixture-${peer}`,
    raw_status: status,
    parsed_status: status,
    normalized_status: status,
    status,
    structured: {
      status,
      summary:
        status === "READY"
          ? "No blocking objections remain."
          : "The exact raw evidence is required.",
      confidence: "verified",
      evidence_sources: status === "READY" ? ['Artifact quote: "Stable fixture draft."'] : [],
      caller_requests: status === "NEEDS_EVIDENCE" ? [ask] : [],
      follow_ups: [],
    },
    text: "",
    raw: { fixture: true },
    latency_ms: 1,
    attempts: 1,
    unpriced_attempts: 1,
    parser_warnings: [],
    decision_quality: "clean",
  };
}

type Regression = {
  name: string;
  run: () => void | Promise<void>;
};

const regressions: Regression[] = [
  {
    name: "recovery reuses only exact current artifact, custody, roles and enabled model provenance",
    run: async () => {
      for (const scenario of [
        "unchanged",
        "draft",
        "task",
        "evidence",
        "focus",
        "mode",
        "model",
        "legacy",
        "disabled",
        "reported_model_mismatch",
      ] as const) {
        const config = fixtureConfig(`recovery-${scenario}`);
        const adapters = stubAdapters(config);
        let artifact = "The renderer uses a blue title.";
        const calls: PeerId[] = [];
        for (const peer of ["claude", "gemini"] as const) {
          const native = adapters[peer].call.bind(adapters[peer]);
          adapters[peer].call = async (prompt, context) => {
            calls.push(peer);
            const result = await native(prompt, context);
            const structured = {
              status: "READY" as const,
              summary: "No blocking objections remain.",
              confidence: "verified" as const,
              evidence_sources: [`Artifact quote: "${artifact}"`],
              caller_requests: [],
              follow_ups: [],
            };
            return {
              ...result,
              status: "READY" as const,
              structured,
              text: JSON.stringify(structured),
              parser_warnings: [],
              decision_quality: "clean" as const,
            };
          };
        }
        let orchestrator = new CrossReviewOrchestrator(
          config,
          () => {},
          () => adapters,
        );
        const session = await orchestrator.store.init("Review the renderer artifact.", "codex", []);
        const first = await orchestrator.askPeers({
          session_id: session.session_id,
          task: session.task,
          draft: artifact,
          caller: "codex",
          caller_status: "NEEDS_EVIDENCE",
          peers: ["claude", "gemini"],
        });
        assert.equal(first.converged, false);
        assert.match(first.round.review_context_sha256 ?? "", /^[a-f0-9]{64}$/);
        if (scenario === "draft") artifact = "The renderer sends private data to an external host.";
        if (scenario === "evidence") {
          await orchestrator.store.attachEvidence(session.session_id, {
            label: "new literal corpus",
            content: "A new complete evidence corpus.",
            attached_by: "codex",
            origin: "session_attach_evidence",
          });
        }
        if (scenario === "model") adapters.gemini.model = "synthetic-new-requested-model";
        if (scenario === "mode") config.stub = false;
        if (scenario === "legacy" || scenario === "reported_model_mismatch") {
          const saved = orchestrator.store.read(session.session_id);
          if (scenario === "legacy") delete saved.rounds[0]?.review_context_sha256;
          else {
            const oldGemini = saved.rounds[0]?.peers.find((peer) => peer.peer === "gemini");
            assert.ok(oldGemini);
            oldGemini.model_match = false;
          }
          fs.writeFileSync(
            path.join(config.data_dir, "sessions", session.session_id, "meta.json"),
            JSON.stringify(saved),
          );
        }
        if (scenario === "disabled") {
          await orchestrator.store.flushPendingEvents();
          const disabledConfig: AppConfig = {
            ...config,
            peer_enabled: {
              ...config.peer_enabled,
              gemini: false,
              deepseek: false,
              grok: false,
              perplexity: false,
            },
          };
          orchestrator = new CrossReviewOrchestrator(
            disabledConfig,
            () => {},
            () => adapters,
          );
        }
        const second = await orchestrator.askPeers({
          session_id: session.session_id,
          task: scenario === "task" ? "Review the new export contract." : session.task,
          draft: artifact,
          caller: "codex",
          caller_status: "READY",
          ...(scenario === "disabled" ? {} : { peers: ["claude"] as PeerId[] }),
          ...(scenario === "focus" ? { review_focus: "Review confidentiality." } : {}),
        });
        assert.deepEqual(calls, ["claude", "gemini", "claude"], scenario);
        assert.equal(second.converged, scenario === "unchanged", scenario);
        assert.deepEqual(second.round.convergence.quorum_peers, ["claude", "gemini"], scenario);
        assert.equal(
          second.round.convergence.ready_peers.includes("gemini"),
          scenario === "unchanged",
          scenario,
        );
        assert.equal(
          second.round.review_context_sha256 === first.round.review_context_sha256,
          ["unchanged", "model", "legacy", "disabled", "reported_model_mismatch"].includes(
            scenario,
          ),
          scenario,
        );
        await orchestrator.store.flushPendingEvents();
      }
    },
  },
  {
    name: "present malformed recovery provenance is rejected before append or metadata use",
    run: async () => {
      const config = fixtureConfig("invalid-review-context");
      const orchestrator = new CrossReviewOrchestrator(config, () => {});
      const session = await orchestrator.store.init("Malformed provenance contract", "codex", []);
      const metadataPath = path.join(config.data_dir, "sessions", session.session_id, "meta.json");
      const before = fs.readFileSync(metadataPath);
      await assert.rejects(
        () =>
          orchestrator.store.appendRound(session.session_id, {
            caller_status: "READY",
            peers: [],
            rejected: [],
            prompt_file: "prompt.md",
            convergence: checkConvergence(["claude"], "READY", [], []),
            convergence_scope: {
              caller: "codex",
              caller_status: "READY",
              expected_peers: ["claude"],
              reviewer_peers: ["claude"],
            },
            started_at: new Date().toISOString(),
            review_context_sha256: "INVALID",
          }),
        /review_context_sha256/,
      );
      assert.ok(fs.readFileSync(metadataPath).equals(before));
      const legacy = await orchestrator.store.appendRound(session.session_id, {
        caller_status: "READY",
        peers: [],
        rejected: [],
        prompt_file: "prompt.md",
        convergence: checkConvergence(["claude"], "READY", [], []),
        convergence_scope: {
          caller: "codex",
          caller_status: "READY",
          expected_peers: ["claude"],
          reviewer_peers: ["claude"],
        },
        started_at: new Date().toISOString(),
      });
      assert.equal(legacy.review_context_sha256, undefined);
      const saved = orchestrator.store.read(session.session_id);
      const savedRound = saved.rounds[0];
      assert.ok(savedRound);
      savedRound.review_context_sha256 = "A".repeat(64);
      fs.writeFileSync(metadataPath, JSON.stringify(saved));
      assert.throws(() => orchestrator.store.read(session.session_id), /review_context_sha256/);
      await orchestrator.store.flushPendingEvents();
    },
  },
  {
    name: "native single and consensus judges preserve generation diagnostics and reject model mismatches",
    run: async () => {
      for (const pass of ["single", "consensus"] as const) {
        for (const diagnostic of ["healthy", "model_mismatch", "provider_warning"] as const) {
          const config = fixtureConfig(`judge-generation-${pass}-${diagnostic}`);
          const adapters = stubAdapters(config);
          const generations: PeerId[] = [];
          for (const peer of ["claude", "gemini"] as const) {
            const nativeGenerate = adapters[peer].generate.bind(adapters[peer]);
            adapters[peer].generate = async (prompt, context) => {
              generations.push(peer);
              const generation = await nativeGenerate(prompt, context);
              return {
                ...generation,
                model_reported:
                  diagnostic === "model_mismatch" && peer === "claude"
                    ? "synthetic-wrong-model"
                    : adapters[peer].model,
                model_match: !(diagnostic === "model_mismatch" && peer === "claude"),
                text: JSON.stringify({
                  satisfied: true,
                  confidence: "verified",
                  rationale: "Synthetic draft includes the literal requested proof.",
                }),
                parser_warnings:
                  diagnostic === "provider_warning" && peer === "claude"
                    ? ["synthetic_provider_warning", "synthetic_provider_warning"]
                    : undefined,
              };
            };
            adapters[peer].judgeEvidenceAsk = BasePeerAdapter.prototype.judgeEvidenceAsk.bind(
              adapters[peer],
            );
          }
          const orchestrator = new CrossReviewOrchestrator(config, undefined, () => adapters);
          const session = await orchestrator.store.init(
            "Native generation judge diagnostics.",
            "codex",
            [],
          );
          const items = await orchestrator.store.appendEvidenceChecklistItems(
            session.session_id,
            1,
            [{ peer: "grok", ask: "Provide the literal synthetic proof." }],
          );
          const result =
            pass === "single"
              ? await orchestrator.runEvidenceChecklistJudgePass({
                  session_id: session.session_id,
                  judge_peer: "claude",
                  draft: "Synthetic draft includes the literal requested proof.",
                  round: 2,
                })
              : await orchestrator.runEvidenceChecklistJudgeConsensusPass({
                  session_id: session.session_id,
                  judge_peers: ["claude", "gemini"],
                  draft: "Synthetic draft includes the literal requested proof.",
                  round: 2,
                });
          assert.equal(generations.length, pass === "single" ? 1 : 2);
          assert.equal(result.promoted.length, diagnostic === "healthy" ? 1 : 0);
          const saved = orchestrator.store.read(session.session_id);
          assert.equal(saved.pending_provider_call_reservations?.length ?? 0, 0);
          assert.equal(
            saved.evidence_checklist?.[0]?.status ?? "open",
            diagnostic === "healthy" ? "addressed" : "open",
          );
          const artifact = JSON.parse(
            fs.readFileSync(
              path.join(
                orchestrator.store.sessionDir(session.session_id),
                "agent-runs",
                `round-2-claude-judge-${items[0]?.id}.json`,
              ),
              "utf8",
            ),
          ) as { parser_warnings?: string[] };
          if (diagnostic === "provider_warning") {
            assert.deepEqual(artifact.parser_warnings, [
              "synthetic_provider_warning",
              "synthetic_provider_warning",
            ]);
          } else if (diagnostic === "model_mismatch") {
            assert.ok(artifact.parser_warnings?.includes("judge_reported_model_mismatch"));
          }
        }
      }
    },
  },
  {
    name: "disabled single evidence judge refuses before dispatch or metadata mutation",
    run: async () => {
      const config = fixtureConfig("disabled-single-judge", (base) => ({
        peer_enabled: { ...base.peer_enabled, claude: false },
      }));
      const adapters = stubAdapters(config);
      let calls = 0;
      adapters.claude.judgeEvidenceAsk = async () => {
        calls += 1;
        return { ...judgeResult("claude"), satisfied: true };
      };
      const orchestrator = new CrossReviewOrchestrator(config, undefined, () => adapters);
      const session = await orchestrator.store.init("Disabled single judge.", "codex", []);
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
        { peer: "gemini", ask: "Provide the literal requested proof." },
      ]);
      const before = fs.readFileSync(orchestrator.store.metaPath(session.session_id));
      await assert.rejects(
        () =>
          orchestrator.runEvidenceChecklistJudgePass({
            session_id: session.session_id,
            judge_peer: "claude",
            draft: "Synthetic proof.",
          }),
        /peer_disabled: claude/,
      );
      assert.equal(calls, 0);
      assert.deepEqual(fs.readFileSync(orchestrator.store.metaPath(session.session_id)), before);
    },
  },
  {
    name: "circular traceability records the resolved rotation ceiling and preserves explicit or unbounded requests",
    run: async () => {
      for (const request of ["omitted", "explicit", "until_stopped"] as const) {
        const config = fixtureConfig(`circular-effective-${request}`, (base) => ({
          budget: { ...base.budget, default_max_rounds: 2, circular_max_rotations: 1 },
        }));
        const adapters = stubAdapters(config);
        const controller = new AbortController();
        let calls = 0;
        for (const peer of PEERS) {
          const nativeGenerate = adapters[peer].generate.bind(adapters[peer]);
          adapters[peer].generate = async (prompt, context) => {
            calls += 1;
            const result = await nativeGenerate(prompt, context);
            if (request === "until_stopped" && calls === 2)
              controller.abort("synthetic bounded stop");
            return result;
          };
        }
        const orchestrator = new CrossReviewOrchestrator(config, undefined, () => adapters);
        const result = await orchestrator.runUntilUnanimous({
          task: "Deliberate over the stable synthetic renderer plan.",
          caller: "codex",
          mode: "circular",
          initial_draft: "Stable synthetic renderer plan.",
          ...(request === "explicit" ? { max_rounds: 1 } : {}),
          ...(request === "until_stopped"
            ? { until_stopped: true, signal: controller.signal }
            : {}),
        });
        const saved = orchestrator.store.read(result.session.session_id);
        assert.equal(saved.requested_max_rounds, request === "explicit" ? 1 : null);
        const expected = request === "until_stopped" ? null : request === "explicit" ? 1 : 5;
        assert.equal(saved.effective_max_rounds, expected);
        if (request === "until_stopped") {
          assert.equal(saved.outcome, "aborted");
          assert.equal(saved.outcome_reason, "session_cancelled");
        } else {
          assert.equal(saved.rounds.length, expected);
          assert.equal(saved.outcome, "max-rounds");
        }
      }
    },
  },
  {
    name: "consensus evidence judges receive their own medium reasoning effort and output cap",
    run: async () => {
      const config = fixtureConfig("judge-context");
      const adapters = stubAdapters(config);
      const contexts: Array<{ peer: PeerId; context: PeerCallContext }> = [];
      for (const peer of ["codex", "claude"] as const) {
        adapters[peer].judgeEvidenceAsk = async (_ask, _draft, context) => {
          contexts.push({ peer, context });
          return judgeResult(peer);
        };
      }
      const orchestrator = new CrossReviewOrchestrator(
        config,
        () => {},
        () => adapters,
      );
      const session = await orchestrator.store.init("Judge context contract", "gemini", []);
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
        { peer: "perplexity", ask: "Provide the exact raw command output." },
      ]);

      await orchestrator.runEvidenceChecklistJudgeConsensusPass({
        session_id: session.session_id,
        judge_peers: ["codex", "claude"],
        draft: "Stable fixture draft.",
        mode: "shadow",
      });

      assert.equal(contexts.length, 2, "both eligible consensus judges must be dispatched");
      for (const { peer, context } of contexts) {
        assert.equal(
          context.reasoning_effort_override,
          "medium",
          `${peer} inherited the full-review reasoning effort instead of the compact judge effort`,
        );
        assert.equal(
          context.max_output_tokens_override,
          config.evidence_judge_autowire.max_output_tokens,
          `${peer} did not receive the configured evidence-judge output cap`,
        );
      }
    },
  },
  {
    name: "evidence-judge output never exceeds an operator's lower peer ceiling",
    run: async () => {
      const config = fixtureConfig("judge-peer-cap", (base) => ({
        max_output_tokens: 64,
        max_output_tokens_by_peer: {
          ...base.max_output_tokens_by_peer,
          codex: 64,
        },
        evidence_judge_autowire: {
          ...base.evidence_judge_autowire,
          max_output_tokens: 512,
        },
      }));
      const adapters = stubAdapters(config);
      let context: PeerCallContext | undefined;
      adapters.codex.judgeEvidenceAsk = async (_ask, _draft, candidateContext) => {
        context = candidateContext;
        return judgeResult("codex");
      };
      const orchestrator = new CrossReviewOrchestrator(
        config,
        () => {},
        () => adapters,
      );
      const session = await orchestrator.store.init("Judge peer cap contract", "codex", []);
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
        { peer: "claude", ask: "Provide the exact raw command output." },
      ]);

      await orchestrator.runEvidenceChecklistJudgePass({
        session_id: session.session_id,
        judge_peer: "codex",
        draft: "Stable fixture draft.",
        mode: "shadow",
      });

      assert.equal(
        context?.max_output_tokens_override,
        64,
        "the judge override exceeded the configured Codex output ceiling",
      );
    },
  },
  {
    name: "active autowire can resolve a prior ask after it becomes not_resurfaced",
    run: async () => {
      const config = fixtureConfig("not-resurfaced-autowire", (base) => ({
        evidence_judge_autowire: {
          ...base.evidence_judge_autowire,
          mode: "active",
          active: true,
          peer: "codex",
          consensus_peers: [],
        },
      }));
      const adapters = stubAdapters(config);
      let judgeCalls = 0;
      adapters.codex.judgeEvidenceAsk = async () => {
        judgeCalls += 1;
        return {
          ...judgeResult("codex"),
          satisfied: true,
          rationale: "The revised draft supplies the exact requested evidence.",
        };
      };
      const orchestrator = new CrossReviewOrchestrator(
        config,
        () => {},
        () => adapters,
      );

      const first = await orchestrator.askPeers({
        task: "Autowire must resolve a historical evidence request.",
        draft: "FORCE_NEEDS_EVIDENCE",
        // v07.00.00: was `caller: "operator"`, which skipped auto-recusal. A peer
        // OUTSIDE this panel keeps the reviewer set identical to what the case
        // was written against, instead of silently shrinking it.
        caller: "gemini",
        peers: ["claude", "codex"],
      });
      const claudeItem = first.session.evidence_checklist?.find((item) => item.peer === "claude");
      assert.ok(claudeItem, "the first round must create Claude's evidence ask");

      await orchestrator.askPeers({
        session_id: first.session.session_id,
        task: "Autowire must resolve a historical evidence request.",
        draft: "The revised implementation contains the requested evidence.",
        // v07.00.00: was `caller: "operator"`, which skipped auto-recusal. A peer
        // OUTSIDE this panel keeps the reviewer set identical to what the case
        // was written against, instead of silently shrinking it.
        caller: "gemini",
        peers: ["claude", "codex"],
      });

      const resolved = orchestrator.store
        .read(first.session.session_id)
        .evidence_checklist?.find((item) => item.id === claudeItem.id);
      assert.equal(judgeCalls, 1, "the independent judge never saw the historical ask");
      assert.equal(resolved?.status, "addressed");
      assert.equal(resolved?.address_method, "judge");
    },
  },
  {
    name: "autowire never judges a historical ask reasserted in the current round",
    run: async () => {
      const ask = "Provide the exact raw command output.";
      const config = fixtureConfig("reasserted-autowire", (base) => ({
        evidence_judge_autowire: {
          ...base.evidence_judge_autowire,
          mode: "active",
          active: true,
          peer: "codex",
          consensus_peers: [],
        },
      }));
      const adapters = stubAdapters(config);
      const settledReview = (peer: PeerId, status: "READY" | "NEEDS_EVIDENCE"): PeerResult => ({
        ...reviewResult(peer, status, ask),
        unpriced_attempts: 0,
        cost: {
          currency: "USD" as const,
          total_cost: 0,
          estimated: false,
          source: "stub",
        },
      });
      adapters.claude.call = async () => settledReview("claude", "NEEDS_EVIDENCE");
      adapters.codex.call = async () => settledReview("codex", "READY");
      let judgeCalls = 0;
      adapters.codex.judgeEvidenceAsk = async () => {
        judgeCalls += 1;
        return {
          ...judgeResult("codex"),
          satisfied: true,
          rationale: "This answer must not be used against a reasserted ask.",
        };
      };
      const orchestrator = new CrossReviewOrchestrator(
        config,
        () => {},
        () => adapters,
      );

      const first = await orchestrator.askPeers({
        task: "A repeated request is still current evidence work.",
        draft: "Stable fixture draft.",
        // v07.00.00: was `caller: "operator"`, which skipped auto-recusal. A peer
        // OUTSIDE this panel keeps the reviewer set identical to what the case
        // was written against, instead of silently shrinking it.
        caller: "gemini",
        peers: ["claude", "codex"],
      });
      const item = first.session.evidence_checklist?.find(
        (candidate) => candidate.peer === "claude",
      );
      assert.ok(item, "the first round must create Claude's evidence ask");

      await orchestrator.askPeers({
        session_id: first.session.session_id,
        task: "A repeated request is still current evidence work.",
        draft: "Stable fixture draft.",
        // v07.00.00: was `caller: "operator"`, which skipped auto-recusal. A peer
        // OUTSIDE this panel keeps the reviewer set identical to what the case
        // was written against, instead of silently shrinking it.
        caller: "gemini",
        peers: ["claude", "codex"],
      });

      const reasserted = orchestrator.store
        .read(first.session.session_id)
        .evidence_checklist?.find((candidate) => candidate.id === item.id);
      assert.equal(judgeCalls, 0, "judge was sent an ask that the author reasserted this round");
      assert.equal(reasserted?.status ?? "open", "open");
      assert.equal(reasserted?.last_round, 2);
    },
  },
  {
    name: "consensus judge can resolve a not_resurfaced ask without reopening it",
    run: async () => {
      const config = fixtureConfig("not-resurfaced-consensus");
      const adapters = stubAdapters(config);
      for (const peer of ["codex", "gemini"] as const) {
        adapters[peer].judgeEvidenceAsk = async () => ({
          ...judgeResult(peer),
          satisfied: true,
          rationale: `Independent ${peer} judge verified the requested evidence.`,
        });
      }
      const orchestrator = new CrossReviewOrchestrator(
        config,
        () => {},
        () => adapters,
      );
      const session = await orchestrator.store.init("Consensus unresolved ask", "claude", []);
      const checklist = await orchestrator.store.appendEvidenceChecklistItems(
        session.session_id,
        1,
        [{ peer: "claude", ask: "Provide the exact raw command output." }],
      );
      const item = checklist[0];
      assert.ok(item);
      await orchestrator.store.runEvidenceChecklistAddressDetection(session.session_id, 2);
      assert.equal(
        orchestrator.store.read(session.session_id).evidence_checklist?.[0]?.status,
        "not_resurfaced",
      );

      const result = await orchestrator.runEvidenceChecklistJudgeConsensusPass({
        session_id: session.session_id,
        judge_peers: ["codex", "gemini"],
        draft: "The revised draft supplies the requested evidence.",
        round: 2,
        mode: "active",
      });

      assert.deepEqual(
        result.promoted.map((entry) => entry.item_id),
        [item.id],
      );
      const resolved = orchestrator.store
        .read(session.session_id)
        .evidence_checklist?.find((candidate) => candidate.id === item.id);
      assert.equal(resolved?.status, "addressed");
      assert.equal(resolved?.address_method, "judge");
    },
  },
  {
    name: "an ungrounded factual NOT_READY creates an actionable checklist request",
    run: async () => {
      const config = fixtureConfig("grounding-request");
      const orchestrator = new CrossReviewOrchestrator(config, () => {});
      const session = await orchestrator.store.init("Grounding request contract", "codex", []);
      const rawNotReady: PeerResult = {
        peer: "claude",
        provider: "fixture-claude",
        model: "fixture-claude",
        raw_status: "NOT_READY",
        parsed_status: "NOT_READY",
        normalized_status: "NOT_READY",
        status: "NOT_READY",
        structured: {
          status: "NOT_READY",
          summary: "src/index.ts:42 contains a production-breaking defect.",
          confidence: "verified",
          evidence_sources: [],
          caller_requests: ["Fix the production-breaking DELETE before release."],
          follow_ups: [],
        },
        text: "",
        raw: { fixture: true },
        latency_ms: 1,
        attempts: 1,
        parser_warnings: [],
        decision_quality: "clean",
      };
      const grounded = groundReadyPeerEvidence(rawNotReady, {
        artifactText: "Stable implementation candidate.",
        attachedEvidenceText: "",
        attachmentRefs: [],
        evidenceAttachments: [],
        callerSubmittedAttachments: [],
        requirePeerSubmittedCorroboration: false,
        runtimeFacts: {
          runtime_version: config.version,
          release_date: "2026-07-17",
          model_pins: config.models,
        },
      });

      assert.equal(grounded.result.status, "NEEDS_EVIDENCE");
      const callerRequests = grounded.result.structured?.caller_requests ?? [];
      assert.ok(
        callerRequests.includes("Fix the production-breaking DELETE before release."),
        "the original remediation request disappeared from the auditable peer result",
      );
      const synthesizedRequest = callerRequests.find(
        (request) =>
          /cite|quote|attach|provide/i.test(request) && /source|evidence|blocker/i.test(request),
      );
      assert.ok(
        synthesizedRequest,
        "the runtime demoted the blocker but did not synthesize an actionable caller_request",
      );

      const brokerAsks = peerAuthoredEvidenceChecklistAsks([grounded.result]);
      assert.equal(
        brokerAsks.length,
        1,
        "ordinary code-remediation prose leaked into the Evidence Broker alongside the citation request",
      );
      assert.equal(brokerAsks[0]?.ask, synthesizedRequest);
      const checklist = await orchestrator.store.appendEvidenceChecklistItems(
        session.session_id,
        1,
        brokerAsks,
      );
      assert.equal(checklist.length, 1, "the actionable request did not reach evidence_checklist");
      assert.equal(checklist[0]?.peer, "claude");
      assert.equal(checklist[0]?.ask, synthesizedRequest);
    },
  },
  {
    name: "judge autowire fails closed when the in-flight provider round has unpriced attempts",
    run: async () => {
      const events: string[] = [];
      const ask = "Provide the exact raw command output.";
      const config = fixtureConfig("unpriced-round", (base) => ({
        evidence_judge_autowire: {
          ...base.evidence_judge_autowire,
          mode: "shadow",
          active: true,
          consensus_peers: ["codex", "claude"],
          configured_consensus_peers_raw: "codex,claude",
        },
      }));
      const adapters = stubAdapters(config);
      let judgeCalls = 0;
      for (const peer of ["codex", "claude", "perplexity"] as const) {
        adapters[peer].call = async () =>
          reviewResult(peer, peer === "perplexity" ? "NEEDS_EVIDENCE" : "READY", ask);
      }
      for (const peer of ["codex", "claude"] as const) {
        adapters[peer].judgeEvidenceAsk = async () => {
          judgeCalls += 1;
          return judgeResult(peer);
        };
      }
      const orchestrator = new CrossReviewOrchestrator(
        config,
        (event) => events.push(event.type),
        () => adapters,
      );
      const session = await orchestrator.store.init("Unknown paid-round cost", "gemini", []);
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 0, [
        { peer: "gemini", ask },
      ]);

      await orchestrator.askPeers({
        session_id: session.session_id,
        task: session.task,
        draft: "Stable fixture draft.",
        // v07.00.00: was `caller: "operator"`, which skipped auto-recusal. A peer
        // OUTSIDE this panel keeps the reviewer set identical to what the case
        // was written against, instead of silently shrinking it.
        caller: "gemini",
        peers: ["codex", "claude", "perplexity"],
      });

      assert.equal(
        judgeCalls,
        0,
        "paid judges were dispatched even though the provider round contained unpriced attempts",
      );
      assert.ok(
        events.includes("session.evidence_judge_pass.budget_blocked"),
        "the unknown-cost refusal was not exposed as an auditable budget-blocked event",
      );
    },
  },
  {
    name: "manual judge fails closed while a generation dispatch is still unpriced",
    run: async () => {
      const events: string[] = [];
      const config = fixtureConfig("generation-in-flight-budget");
      const adapters = stubAdapters(config);
      let judgeCalls = 0;
      adapters.codex.judgeEvidenceAsk = async () => {
        judgeCalls += 1;
        return judgeResult("codex");
      };
      const orchestrator = new CrossReviewOrchestrator(
        config,
        (event) => events.push(event.type),
        () => adapters,
      );
      const session = await orchestrator.store.init("Generation cost is not settled", "codex", []);
      await orchestrator.store.appendEvidenceChecklistItems(session.session_id, 1, [
        { peer: "claude", ask: "Provide the exact raw command output." },
      ]);
      await orchestrator.store.markBackgroundGenerationInFlight(session.session_id, {
        peer: "claude",
        provider: "anthropic",
        model: "claude-fable-5",
        label: "lead-generation",
        round: 1,
        started_at: new Date().toISOString(),
        owner_pid: process.pid,
      });

      await assert.rejects(
        () =>
          orchestrator.runEvidenceChecklistJudgePass({
            session_id: session.session_id,
            judge_peer: "codex",
            draft: "Stable fixture draft.",
            mode: "shadow",
          }),
        /evidence_judge_budget_preflight/,
      );
      assert.equal(judgeCalls, 0, "judge dispatched while a generation cost was unknown");
      assert.ok(events.includes("session.evidence_judge_pass.budget_blocked"));
    },
  },
  {
    name: "effective config snapshot includes complete prompt and Perplexity controls without secrets",
    run: async () => {
      const secretSentinels = {
        codex: "sk-fixture-codex-never-persist",
        perplexity: "pplx-fixture-never-persist",
      };
      const config = fixtureConfig("config-reproducibility", (base) => ({
        prompt: {
          ...base.prompt,
          max_task_chars: 12_345,
          max_attached_evidence_chars: 54_321,
        },
        perplexity: {
          max_steps: 1,
          web_search_invocations_estimate: 3,
          search_preflight_policy: "estimate",
          search_context_size: "high",
          disable_search: true,
          probe_mode: "live",
        },
        api_keys: {
          ...base.api_keys,
          codex: secretSentinels.codex,
          perplexity: secretSentinels.perplexity,
        },
      }));
      const orchestrator = new CrossReviewOrchestrator(config, () => {});
      const session = await orchestrator.store.init("Config reproducibility", "codex", []);
      const snapshot = orchestrator.store.read(session.session_id).effective_config_snapshot;

      assert.ok(snapshot, "effective_config_snapshot is absent");
      assert.deepEqual(
        snapshot?.prompt,
        config.prompt,
        "prompt truncation controls are missing from the reproducibility snapshot",
      );
      assert.deepEqual(
        snapshot?.perplexity,
        config.perplexity,
        "Perplexity search/probe controls are missing from the reproducibility snapshot",
      );
      const serialized = JSON.stringify(snapshot);
      assert.ok(!serialized.includes(secretSentinels.codex));
      assert.ok(!serialized.includes(secretSentinels.perplexity));
      assert.equal(Object.hasOwn(snapshot ?? {}, "api_keys"), false);
    },
  },
];

const failures: Array<{ name: string; error: string }> = [];
for (const regression of regressions) {
  try {
    await regression.run();
    console.log(`[v4.5.18-contract-gaps] PASS: ${regression.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ name: regression.name, error: message });
    console.error(`[v4.5.18-contract-gaps] FAIL: ${regression.name}\n  ${message}`);
  }
}

for (const dir of tempDirs) {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(
  JSON.stringify(
    {
      ok: failures.length === 0,
      regressions: regressions.length,
      failed: failures.length,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exitCode = 1;
