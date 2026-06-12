import type { AppConfig, PeerFailure } from "../core/types.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function withRetry<T>(
  config: AppConfig,
  run: (attempt: number) => Promise<T>,
  onFailure: (error: unknown, attempt: number, started: number) => PeerFailure,
): Promise<T> {
  const started = Date.now();
  let last: PeerFailure | null = null;
  for (let attempt = 1; attempt <= config.retry.max_attempts; attempt++) {
    try {
      return await run(attempt);
    } catch (error) {
      last = onFailure(error, attempt, started);
      if (!last.retryable || attempt >= config.retry.max_attempts)
        throw attachPeerFailure(error, last);
      const wait = last.retry_after_ms ?? backoffWithJitter(attempt, config);
      await delay(wait);
    }
  }
  throw new Error(last?.message ?? "retry loop exhausted");
}
