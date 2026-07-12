import type { AppConfig, PeerFailure } from "../core/types.js";

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
  };
  const unpriced =
    typeof record.unpriced_attempts === "number" && record.unpriced_attempts > 0
      ? Math.floor(record.unpriced_attempts)
      : 0;
  for (const [key, value] of [
    ["usage", record.usage],
    ["cost", record.cost],
    ["accounted_attempts", Math.max(0, attempt - unpriced)],
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

export async function withRetry<T>(
  config: AppConfig,
  run: (attempt: number) => Promise<T>,
  onFailure: (error: unknown, attempt: number, started: number) => PeerFailure,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<T> {
  const started = Date.now();
  let last: PeerFailure | null = null;
  for (let attempt = 1; attempt <= config.retry.max_attempts; attempt++) {
    if (options.signal?.aborted) {
      const error = cancellationError(options.signal);
      const failure = onFailure(error, attempt - 1, started);
      throw attachPeerFailure(error, {
        ...failure,
        failure_class: "cancelled",
        retryable: false,
        attempts: attempt - 1,
      });
    }
    try {
      const result = await run(attempt);
      if (options.signal?.aborted) {
        throw attachSettledBilling(cancellationError(options.signal), result, attempt);
      }
      return result;
    } catch (error) {
      last = onFailure(error, attempt, started);
      if (options.signal?.aborted) {
        throw attachPeerFailure(error, {
          ...last,
          failure_class: "cancelled",
          retryable: false,
          attempts: attempt,
        });
      }
      if (!last.retryable || attempt >= config.retry.max_attempts)
        throw attachPeerFailure(error, last);
      const wait = last.retry_after_ms ?? backoffWithJitter(attempt, config);
      try {
        await delay(wait, options.signal);
      } catch (delayError) {
        const failure = onFailure(delayError, attempt, started);
        throw attachPeerFailure(delayError, {
          ...failure,
          failure_class: "cancelled",
          retryable: false,
          attempts: attempt,
        });
      }
    }
  }
  throw new Error(last?.message ?? "retry loop exhausted");
}
