import { mergeCost, mergeUsage } from "../core/cost.js";
import type { AppConfig, CostEstimate, PeerFailure, TokenUsage } from "../core/types.js";
import { indeterminateSpendMarkerFor } from "../core/types.js";

type RetryBilling = {
  usage?: TokenUsage | undefined;
  cost?: CostEstimate | undefined;
  accountedAttempts: number;
};

function retryBillingFromError(error: unknown): RetryBilling | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as {
    retry_billing_requires_merge?: unknown;
    usage?: unknown;
    cost?: unknown;
    accounted_attempts?: unknown;
  };
  if (record.retry_billing_requires_merge !== true) return undefined;
  const usage =
    record.usage && typeof record.usage === "object" ? (record.usage as TokenUsage) : undefined;
  const cost =
    record.cost && typeof record.cost === "object" ? (record.cost as CostEstimate) : undefined;
  const accountedAttempts =
    typeof record.accounted_attempts === "number" &&
    Number.isInteger(record.accounted_attempts) &&
    record.accounted_attempts > 0
      ? record.accounted_attempts
      : 0;
  return { usage, cost, accountedAttempts };
}

// Aggregated spend of the tries that failed before the final one. The final
// failure's cumulative unpriced count blends tries of different classes, so
// the aggregate marker must compose each earlier try's own indeterminate
// share (review finding, session f131f43f) instead of deriving everything
// from the final class/message.
type PriorTrySpend = {
  unpricedAttempts: number;
  indeterminateAttempts: number;
};

function mergeRetryBillingIntoResult<T>(
  result: T,
  prior: readonly RetryBilling[],
  priorSpend: PriorTrySpend = { unpricedAttempts: 0, indeterminateAttempts: 0 },
): T {
  if (!result || typeof result !== "object") return result;
  const record = result as T & {
    usage?: TokenUsage | undefined;
    cost?: CostEstimate | undefined;
    unpriced_attempts?: number | undefined;
    indeterminate_spend_attempts?: number | undefined;
  };
  const usageItems = [...prior.map((item) => item.usage), record.usage];
  if (usageItems.some(Boolean)) {
    // v4.7.0 (CROSREV-6): mergeUsage deliberately drops per-call cache
    // attributes (mode/key_hash are not additive). Failed prior tries only
    // contribute BILLING here; the successful attempt's own per-call cache
    // attributes remain authoritative for the call result, so re-stamp
    // them after the additive merge instead of losing them.
    const cacheProviderMode = record.usage?.cache_provider_mode;
    const cacheKeyHash = record.usage?.cache_key_hash;
    record.usage = mergeUsage(usageItems);
    if (cacheProviderMode !== undefined) record.usage.cache_provider_mode = cacheProviderMode;
    if (cacheKeyHash !== undefined) record.usage.cache_key_hash = cacheKeyHash;
  }
  const costItems = [...prior.map((item) => item.cost), record.cost];
  if (costItems.some(Boolean)) record.cost = mergeCost(costItems);
  const priorAccounted = prior.reduce((sum, item) => sum + item.accountedAttempts, 0);
  // The adapter may or may not have counted the earlier failed tries in the
  // result's own unpriced_attempts; the wrapper observed them directly, so
  // take the larger of the two views instead of dropping the wrapper's
  // (round-2 grok finding, session f131f43f: deleting both fields on a
  // priced success fail-opened an earlier indeterminate try).
  const declaredUnpriced = Math.max(0, (record.unpriced_attempts ?? 0) - priorAccounted);
  const unpriced = Math.max(declaredUnpriced, priorSpend.unpricedAttempts);
  if (unpriced > 0) {
    record.unpriced_attempts = unpriced;
    // Settlement writers derive an unknown billing status from unpriced
    // attempts, so the result must carry the per-try indeterminate share or
    // it would persist as the legacy fail-closed trio (session f131f43f).
    // Compose the record's OWN marker with the wrapper-observed one instead
    // of replacing it (round-7 codex finding): an adapter-stamped positive
    // marker covers intra-attempt sub-calls the wrapper never saw, so the
    // shares are disjoint and sum, capped at the unpriced total.
    record.indeterminate_spend_attempts = Math.min(
      unpriced,
      (record.indeterminate_spend_attempts ?? 0) + priorSpend.indeterminateAttempts,
    );
  } else {
    delete record.unpriced_attempts;
    delete record.indeterminate_spend_attempts;
  }
  return result;
}

function mergeRetryBillingIntoFailure(
  failure: PeerFailure,
  prior: readonly RetryBilling[],
  priorSpend: PriorTrySpend = { unpricedAttempts: 0, indeterminateAttempts: 0 },
): PeerFailure {
  if (prior.length === 0 && priorSpend.unpricedAttempts === 0) {
    if ((failure.unpriced_attempts ?? 0) === 0) return failure;
    // Trust an explicit producer-stamped marker (round-8 codex finding):
    // recomputing from the final class alone rewrote a positive marker as
    // zero when the failure's own sub-attempts were of mixed classes.
    if (failure.indeterminate_spend_attempts != null) return failure;
    return {
      ...failure,
      indeterminate_spend_attempts: indeterminateSpendMarkerFor(
        failure.failure_class,
        failure.message,
        failure.unpriced_attempts ?? 0,
      ),
    };
  }
  const usageItems = [...prior.map((item) => item.usage), failure.usage];
  const costItems = [...prior.map((item) => item.cost), failure.cost];
  const usage = usageItems.some(Boolean) ? mergeUsage(usageItems) : undefined;
  const cost = costItems.some(Boolean) ? mergeCost(costItems) : undefined;
  const priorAccounted = prior.reduce((sum, item) => sum + item.accountedAttempts, 0);
  const unpriced = Math.max(0, (failure.unpriced_attempts ?? 0) - priorAccounted);
  const finalOwnUnpriced = Math.max(0, unpriced - priorSpend.unpricedAttempts);
  // The failure's own explicit marker (adapter mergers compose it from
  // intra-attempt sub-calls the wrapper never saw) takes precedence over a
  // recomputation from the final class, capped at the failure's own share
  // of the unpriced total (round-8 codex finding).
  const finalOwnIndeterminate =
    failure.indeterminate_spend_attempts != null
      ? Math.min(finalOwnUnpriced, failure.indeterminate_spend_attempts)
      : indeterminateSpendMarkerFor(failure.failure_class, failure.message, finalOwnUnpriced);
  const indeterminate = priorSpend.indeterminateAttempts + finalOwnIndeterminate;
  return {
    ...failure,
    ...(usage ? { usage } : {}),
    ...(cost ? { cost } : {}),
    billing_status: unpriced > 0 ? "unknown" : usage || cost ? "reported" : failure.billing_status,
    ...(unpriced > 0
      ? {
          unpriced_attempts: unpriced,
          indeterminate_spend_attempts: indeterminate,
        }
      : { unpriced_attempts: undefined, indeterminate_spend_attempts: undefined }),
  };
}

function cancellationError(signal: AbortSignal): Error {
  const detail =
    typeof signal.reason === "string" && signal.reason.trim().length > 0
      ? `: ${signal.reason.trim()}`
      : "";
  const error = new Error(`Request was aborted${detail}`);
  error.name = "AbortError";
  return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancellationError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(cancellationError(signal as AbortSignal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// v2.4.0 / audit closure (P2.6): full jitter on the exponential backoff.
// Without jitter, multiple peers hitting the same provider rate-limit
// synchronize their retries (10ms, 20ms, 40ms... in lockstep) and produce
// thundering-herd that prolongs the rate limit instead of relieving it.
// Full jitter (random in [0, capped]) is the AWS-recommended pattern and
// is appropriate here because the cap (`config.retry.max_delay_ms`)
// already bounds tail latency. When the provider returns an explicit
// `retry_after_ms` (P2.7 wires this), we respect it as-is — that value
// is server-authoritative and adding jitter on top would only delay
// recovery further.
function backoffWithJitter(attempt: number, config: AppConfig): number {
  const exponential = config.retry.base_delay_ms * 2 ** (attempt - 1);
  const capped = Math.min(config.retry.max_delay_ms, exponential);
  return Math.floor(Math.random() * capped);
}

function attachPeerFailure(error: unknown, failure: PeerFailure): unknown {
  if (typeof error === "object" && error !== null) {
    Object.defineProperty(error, "peerFailure", {
      value: failure,
      enumerable: false,
      configurable: true,
    });
    return error;
  }
  const wrapped = new Error(String(error));
  Object.defineProperty(wrapped, "peerFailure", {
    value: failure,
    enumerable: false,
    configurable: true,
  });
  return wrapped;
}

function attachSettledBilling(error: Error, result: unknown, attempt: number): Error {
  if (!result || typeof result !== "object") return error;
  const record = result as {
    usage?: unknown;
    cost?: unknown;
    unpriced_attempts?: unknown;
    attempts?: unknown;
  };
  const unpriced =
    typeof record.unpriced_attempts === "number" && record.unpriced_attempts > 0
      ? Math.floor(record.unpriced_attempts)
      : 0;
  // Codex round 27 (PR #240): the adapter may have accounted internal
  // sub-calls (an ambiguous cache creation) beyond the wrapper's loop
  // counter - accounted attempts derive from the RESULT's total attempt
  // count, so a settled cancellation after such a call reports its known
  // generation billing instead of zero accounted attempts.
  const resultAttempts =
    typeof record.attempts === "number" && record.attempts > attempt
      ? Math.floor(record.attempts)
      : attempt;
  for (const [key, value] of [
    ["usage", record.usage],
    ["cost", record.cost],
    ["accounted_attempts", Math.max(0, resultAttempts - unpriced)],
    // The provider promise returned a complete result before cancellation.
    // Adapters that aggregate retry usage into their result can use this
    // marker to avoid merging prior-attempt billing a second time.
    ["provider_result_settled", true],
  ] as const) {
    if (value === undefined) continue;
    Object.defineProperty(error, key, {
      value,
      enumerable: false,
      configurable: true,
    });
  }
  return error;
}

// Exported for the provider-refresh smoke only.
export const __attachSettledBillingForTests = attachSettledBilling;

function hasSettledProviderResult(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { provider_result_settled?: unknown }).provider_result_settled === true
  );
}

export async function withRetry<T>(
  config: AppConfig,
  run: (attempt: number) => Promise<T>,
  onFailure: (error: unknown, attempt: number, started: number) => PeerFailure,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<T> {
  const started = Date.now();
  let last: PeerFailure | null = null;
  const priorRetryBilling: RetryBilling[] = [];
  const priorTrySpend = { unpricedAttempts: 0, indeterminateAttempts: 0 };
  for (let attempt = 1; attempt <= config.retry.max_attempts; attempt++) {
    if (options.signal?.aborted) {
      const error = cancellationError(options.signal);
      const failure = onFailure(error, attempt - 1, started);
      const billedFailure = mergeRetryBillingIntoFailure(failure, priorRetryBilling, priorTrySpend);
      throw attachPeerFailure(error, {
        ...billedFailure,
        failure_class: "cancelled",
        retryable: false,
        // Codex round 15 (PR #240): the classifier may have accounted
        // internal sub-calls (an ambiguous cache creation) beyond the
        // wrapper's loop counter — preserve the larger attempt count.
        attempts: Math.max(attempt - 1, billedFailure.attempts ?? 0),
      });
    }
    try {
      const result = await run(attempt);
      const resultWithRetryBilling = mergeRetryBillingIntoResult(
        result,
        priorRetryBilling,
        priorTrySpend,
      );
      if (options.signal?.aborted) {
        throw attachSettledBilling(
          cancellationError(options.signal),
          resultWithRetryBilling,
          attempt,
        );
      }
      return resultWithRetryBilling;
    } catch (error) {
      last = onFailure(error, attempt, started);
      if (options.signal?.aborted) {
        const billedFailure = hasSettledProviderResult(error)
          ? last
          : mergeRetryBillingIntoFailure(last, priorRetryBilling, priorTrySpend);
        throw attachPeerFailure(error, {
          ...billedFailure,
          failure_class: "cancelled",
          retryable: false,
          // Round 15: preserve the classifier's larger attempt count (it
          // may include accounted intra-attempt sub-calls).
          attempts: Math.max(attempt, billedFailure.attempts ?? 0),
        });
      }
      if (!last.retryable || attempt >= config.retry.max_attempts) {
        throw attachPeerFailure(
          error,
          mergeRetryBillingIntoFailure(last, priorRetryBilling, priorTrySpend),
        );
      }
      const currentRetryBilling = retryBillingFromError(error);
      if (currentRetryBilling) priorRetryBilling.push(currentRetryBilling);
      // Record this try's own spend before retrying: one unpriced attempt
      // unless its billing was captured, carrying its own class's
      // indeterminate share into the aggregate marker. Captured billing
      // means the try's spend is KNOWN even when it is not counted in
      // accounted_attempts (truncation recoveries bill the failed try's
      // tokens): the classified failure reports it (billing_status
      // "reported" when the error carried usage/cost), and adapters that
      // accumulate internally flag it on the retry-billing record.
      const billingCaptured =
        last.billing_status === "reported" ||
        (currentRetryBilling !== undefined &&
          (currentRetryBilling.accountedAttempts > 0 ||
            currentRetryBilling.usage !== undefined ||
            currentRetryBilling.cost !== undefined));
      if (!billingCaptured) {
        priorTrySpend.unpricedAttempts += 1;
        priorTrySpend.indeterminateAttempts += indeterminateSpendMarkerFor(
          last.failure_class,
          last.message,
          1,
        );
      }
      const wait = last.retry_after_ms ?? backoffWithJitter(attempt, config);
      try {
        await delay(wait, options.signal);
      } catch (delayError) {
        const failure = onFailure(delayError, attempt, started);
        const billedDelayFailure = mergeRetryBillingIntoFailure(
          failure,
          priorRetryBilling,
          priorTrySpend,
        );
        throw attachPeerFailure(delayError, {
          ...billedDelayFailure,
          failure_class: "cancelled",
          retryable: false,
          // Round 15: same preservation on the backoff-delay cancellation.
          attempts: Math.max(attempt, billedDelayFailure.attempts ?? 0),
        });
      }
    }
  }
  throw new Error(last?.message ?? "retry loop exhausted");
}
