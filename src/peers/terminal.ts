import type { PeerCallContext, PeerId } from "../core/types.js";

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

function normalized(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

export function assertResponsesCompletion(
  response: { status?: unknown } | null | undefined,
  params: TerminalContext,
): void {
  const status = normalized(response?.status);
  // Fail closed: Responses API output is usable only after the provider
  // explicitly reports the completed terminal. A plausible READY prefix with
  // a missing status is indistinguishable from a truncated/unterminated body.
  if (status !== "completed") {
    rejectTerminal({
      ...params,
      protocol: "responses",
      terminalState: `status=${status ?? "missing"}`,
    });
  }
}

export function observeResponsesStreamTerminal(
  event: { type?: unknown; response?: { status?: unknown } | null },
  completed: boolean,
  params: TerminalContext,
): boolean {
  const eventType = normalized(event.type);
  if (eventType === "response.incomplete") {
    rejectTerminal({
      ...params,
      protocol: "responses",
      terminalState: "event=response.incomplete",
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
): void {
  for (const [position, choice] of (choices ?? []).entries()) {
    const reason = normalized(choice.finish_reason);
    // Chat streams use null/missing on intermediate chunks. Only a non-null
    // finish_reason is terminal; stream finalization below requires one.
    if (!reason) continue;
    if (!allowedChatTerminal(reason, params.allowToolCalls === true)) {
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
): void {
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
  if (!blockReason || blockReason === "block_reason_unspecified") return;
  rejectTerminal({
    ...params,
    protocol: "gemini",
    terminalState: `promptFeedback.blockReason=${blockReason}`,
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
