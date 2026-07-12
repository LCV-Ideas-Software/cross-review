import { estimateCost } from "../core/cost.js";
import type {
  AppConfig,
  CostEstimate,
  PeerCallContext,
  PeerId,
  TokenUsage,
} from "../core/types.js";

export type ProviderPhase = "review" | "generation";

type TerminalContext = {
  context: PeerCallContext;
  peer: PeerId;
  provider: string;
  model: string;
  phase: ProviderPhase;
};

export class ProviderTerminalStateError extends Error {
  readonly code = "provider_terminal_state_rejected";

  constructor(
    readonly provider: string,
    readonly model: string,
    readonly protocol: "responses" | "chat_completions" | "gemini" | "anthropic",
    readonly terminal_state: string,
  ) {
    super(
      `${provider} ${protocol} terminal state rejected for ${model}: ${terminal_state}. ` +
        "Partial, truncated, filtered, or unterminated output is not a usable response.",
    );
    this.name = "ProviderTerminalStateError";
  }
}

export class ProviderPromptBlockedError extends Error {
  readonly code = "provider_prompt_blocked";

  constructor(
    readonly provider: string,
    readonly model: string,
    readonly protocol: "gemini",
    readonly block_reason: string,
  ) {
    super(
      `${provider} ${protocol} input prompt was blocked for ${model}: ${block_reason}. ` +
        "No response candidate was produced; the prompt must be reformulated.",
    );
    this.name = "ProviderPromptBlockedError";
  }
}

export class ProviderOutputRefusalError extends Error {
  readonly code = "provider_output_refusal";

  constructor(
    readonly provider: string,
    readonly model: string,
    readonly protocol: "responses",
  ) {
    super(`${provider} ${protocol} output refusal from ${model}.`);
    this.name = "ProviderOutputRefusalError";
  }
}

/**
 * Preserve provider-reported accounting when a terminal validator rejects a
 * response before the normal result builder can run. The error classifier
 * consumes these non-enumerable fields and reconciles the attempt exactly as
 * it does for model-specific output-limit errors.
 */
export function withTerminalBilling<T>(
  billing: {
    usage?: TokenUsage | undefined;
    cost?: CostEstimate | undefined;
    accounted_attempts?: number | undefined;
  },
  check: () => T,
): T {
  try {
    return check();
  } catch (error) {
    if (!error || typeof error !== "object") throw error;
    if (billing.usage !== undefined || billing.cost !== undefined) {
      Object.defineProperty(error, "retry_billing_requires_merge", {
        configurable: true,
        enumerable: false,
        value: true,
      });
    }
    for (const [key, value] of [
      ["usage", billing.usage],
      ["cost", billing.cost],
      ["accounted_attempts", billing.accounted_attempts],
    ] as const) {
      if (value === undefined || key in error) continue;
      Object.defineProperty(error, key, {
        configurable: true,
        enumerable: false,
        value,
      });
    }
    throw error;
  }
}

export function withEstimatedTerminalBilling<T>(
  config: AppConfig,
  peer: PeerId,
  effectiveModel: string,
  usage: TokenUsage | undefined,
  check: () => T,
): T {
  const cost = usage ? estimateCost(config, peer, usage, effectiveModel) : undefined;
  const accountedAttempts =
    typeof cost?.total_cost === "number" && Number.isFinite(cost.total_cost) ? 1 : 0;
  return withTerminalBilling({ usage, cost, accounted_attempts: accountedAttempts }, check);
}

function rejectTerminal(
  params: TerminalContext & {
    protocol: ProviderTerminalStateError["protocol"];
    terminalState: string;
  },
): never {
  params.context.emit({
    type: "provider.terminal_rejected",
    session_id: params.context.session_id,
    round: params.context.round,
    peer: params.peer,
    message: `${params.provider} rejected an unhealthy provider terminal state.`,
    data: {
      provider: params.provider,
      configured_model: params.model,
      phase: params.phase,
      protocol: params.protocol,
      terminal_state: params.terminalState,
      retryable: false,
      usable_output: false,
    },
  });
  throw new ProviderTerminalStateError(
    params.provider,
    params.model,
    params.protocol,
    params.terminalState,
  );
}

function rejectPrompt(
  params: TerminalContext & {
    protocol: ProviderPromptBlockedError["protocol"];
    blockReason: string;
  },
): never {
  params.context.emit({
    type: "provider.prompt_rejected",
    session_id: params.context.session_id,
    round: params.context.round,
    peer: params.peer,
    message: `${params.provider} rejected the input prompt before producing candidates.`,
    data: {
      provider: params.provider,
      configured_model: params.model,
      phase: params.phase,
      protocol: params.protocol,
      block_reason: params.blockReason,
      moderation_recovery_eligible: params.phase === "review",
      usable_output: false,
    },
  });
  throw new ProviderPromptBlockedError(
    params.provider,
    params.model,
    params.protocol,
    params.blockReason,
  );
}

function rejectOutputRefusal(params: TerminalContext): never {
  params.context.emit({
    type: "provider.refusal",
    session_id: params.context.session_id,
    round: params.context.round,
    peer: params.peer,
    message: `${params.provider} returned a Responses API output refusal.`,
    data: {
      provider: params.provider,
      configured_model: params.model,
      phase: params.phase,
      protocol: "responses",
      retryable: false,
      usable_output: false,
    },
  });
  throw new ProviderOutputRefusalError(params.provider, params.model, "responses");
}

function normalized(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function hasResponsesOutputRefusal(output: unknown): boolean {
  if (!Array.isArray(output)) return false;
  return output.some((item) => {
    if (!item || typeof item !== "object") return false;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) return false;
    return content.some(
      (part) =>
        part !== null &&
        typeof part === "object" &&
        normalized((part as { type?: unknown }).type) === "refusal",
    );
  });
}

export function assertResponsesCompletion(
  response:
    | {
        status?: unknown;
        incomplete_details?: { reason?: unknown } | null | undefined;
        output?: unknown;
      }
    | null
    | undefined,
  params: TerminalContext,
): void {
  const status = normalized(response?.status);
  // Fail closed: Responses API output is usable only after the provider
  // explicitly reports the completed terminal. A plausible READY prefix with
  // a missing status is indistinguishable from a truncated/unterminated body.
  if (status !== "completed") {
    const incompleteReason = normalized(response?.incomplete_details?.reason);
    rejectTerminal({
      ...params,
      protocol: "responses",
      terminalState: `status=${status ?? "missing"}${incompleteReason ? ` reason=${incompleteReason}` : ""}`,
    });
  }
  if (hasResponsesOutputRefusal(response?.output)) rejectOutputRefusal(params);
}

export function observeResponsesStreamRefusal(
  event: { type?: unknown },
  refused: boolean,
): boolean {
  const eventType = normalized(event.type);
  return refused || eventType === "response.refusal.delta" || eventType === "response.refusal.done";
}

export function assertResponsesStreamNotRefused(refused: boolean, params: TerminalContext): void {
  if (!refused) return;
  rejectOutputRefusal(params);
}

export function observeResponsesStreamTerminal(
  event: {
    type?: unknown;
    response?: {
      status?: unknown;
      incomplete_details?: { reason?: unknown } | null | undefined;
    } | null;
  },
  completed: boolean,
  params: TerminalContext,
): boolean {
  const eventType = normalized(event.type);
  if (eventType === "response.incomplete") {
    const incompleteReason = normalized(event.response?.incomplete_details?.reason);
    rejectTerminal({
      ...params,
      protocol: "responses",
      terminalState: `event=response.incomplete${incompleteReason ? ` reason=${incompleteReason}` : ""}`,
    });
  }
  if (eventType !== "response.completed") return completed;
  assertResponsesCompletion(event.response, params);
  return true;
}

export function assertResponsesStreamCompleted(completed: boolean, params: TerminalContext): void {
  if (completed) return;
  rejectTerminal({
    ...params,
    protocol: "responses",
    terminalState: "missing_event=response.completed",
  });
}

type ChatChoiceLike = {
  index?: unknown;
  finish_reason?: unknown;
};

function allowedChatTerminal(reason: string, allowToolCalls: boolean): boolean {
  return reason === "stop" || (allowToolCalls && reason === "tool_calls");
}

export function assertChatCompletionTerminal(
  choices: readonly ChatChoiceLike[] | null | undefined,
  params: TerminalContext & { allowToolCalls?: boolean },
): void {
  if (!choices?.length) {
    rejectTerminal({
      ...params,
      protocol: "chat_completions",
      terminalState: "missing_choices_or_finish_reason",
    });
  }
  for (const choice of choices) {
    const reason = normalized(choice.finish_reason);
    if (!reason || !allowedChatTerminal(reason, params.allowToolCalls === true)) {
      rejectTerminal({
        ...params,
        protocol: "chat_completions",
        terminalState: `finish_reason=${reason ?? "missing"}`,
      });
    }
  }
}

export function observeChatStreamTerminals(
  choices: readonly ChatChoiceLike[] | null | undefined,
  completedChoices: Set<number>,
  params: TerminalContext & { allowToolCalls?: boolean },
  rejectedTerminals?: string[],
): void {
  for (const [position, choice] of (choices ?? []).entries()) {
    const reason = normalized(choice.finish_reason);
    // Chat streams use null/missing on intermediate chunks. Only a non-null
    // finish_reason is terminal; stream finalization below requires one.
    if (!reason) continue;
    if (!allowedChatTerminal(reason, params.allowToolCalls === true)) {
      if (rejectedTerminals) {
        rejectedTerminals.push(`finish_reason=${reason}`);
        continue;
      }
      rejectTerminal({
        ...params,
        protocol: "chat_completions",
        terminalState: `finish_reason=${reason}`,
      });
    }
    const index = typeof choice.index === "number" ? choice.index : position;
    completedChoices.add(index);
  }
}

export function assertChatStreamCompleted(
  completedChoices: ReadonlySet<number>,
  params: TerminalContext,
  rejectedTerminals: readonly string[] = [],
): void {
  const rejected = rejectedTerminals[0];
  if (rejected) {
    rejectTerminal({
      ...params,
      protocol: "chat_completions",
      terminalState: rejected,
    });
  }
  if (completedChoices.size > 0) return;
  rejectTerminal({
    ...params,
    protocol: "chat_completions",
    terminalState: "missing_finish_reason=stop",
  });
}

type GeminiCandidateLike = {
  index?: unknown | undefined;
  finishReason?: unknown | undefined;
};

type GeminiResponseLike = {
  promptFeedback?: { blockReason?: unknown | undefined } | null | undefined;
  candidates?: readonly GeminiCandidateLike[] | null | undefined;
};

function assertGeminiPromptNotBlocked(response: GeminiResponseLike, params: TerminalContext): void {
  const blockReason = normalized(response.promptFeedback?.blockReason);
  if (
    !blockReason ||
    blockReason === "block_reason_unspecified" ||
    blockReason === "blocked_reason_unspecified"
  ) {
    return;
  }
  rejectPrompt({
    ...params,
    protocol: "gemini",
    blockReason,
  });
}

function healthyGeminiFinish(reason: string): boolean {
  return reason === "stop";
}

export function assertGeminiCompletion(
  response: GeminiResponseLike,
  params: TerminalContext,
): void {
  assertGeminiPromptNotBlocked(response, params);
  if (!response.candidates?.length) {
    rejectTerminal({
      ...params,
      protocol: "gemini",
      terminalState: "missing_candidates_or_finishReason",
    });
  }
  for (const candidate of response.candidates) {
    const reason = normalized(candidate.finishReason);
    if (!reason || !healthyGeminiFinish(reason)) {
      rejectTerminal({
        ...params,
        protocol: "gemini",
        terminalState: `finishReason=${reason ?? "missing"}`,
      });
    }
  }
}

export function observeGeminiStreamTerminals(
  response: GeminiResponseLike,
  completedCandidates: Set<number>,
  params: TerminalContext,
): void {
  assertGeminiPromptNotBlocked(response, params);
  for (const [position, candidate] of (response.candidates ?? []).entries()) {
    const reason = normalized(candidate.finishReason);
    if (!reason) continue;
    if (!healthyGeminiFinish(reason)) {
      rejectTerminal({
        ...params,
        protocol: "gemini",
        terminalState: `finishReason=${reason}`,
      });
    }
    const index = typeof candidate.index === "number" ? candidate.index : position;
    completedCandidates.add(index);
  }
}

export function assertGeminiStreamCompleted(
  completedCandidates: ReadonlySet<number>,
  params: TerminalContext,
): void {
  if (completedCandidates.size > 0) return;
  rejectTerminal({
    ...params,
    protocol: "gemini",
    terminalState: "missing_finishReason=STOP",
  });
}

export function assertAnthropicCompletion(
  message: { stop_reason?: unknown } | null | undefined,
  params: TerminalContext,
): void {
  const reason = normalized(message?.stop_reason);
  // The adapter sends no stop sequences or tools. Therefore `end_turn` is
  // the sole complete terminal; max_tokens/model_context_window_exceeded,
  // pause_turn, tool_use, and unknown future states are all unusable here.
  if (reason === "end_turn") return;
  rejectTerminal({
    ...params,
    protocol: "anthropic",
    terminalState: `stop_reason=${reason ?? "missing"}`,
  });
}
