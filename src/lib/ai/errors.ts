/** Provider hit a rate limit: the import pauses until `retryAfterMs` has passed. */
export class RateLimitedError extends Error {
  constructor(public readonly retryAfterMs: number, message = "Rate limited") {
    super(message);
    this.name = "RateLimitedError";
  }
}

/** 5xx, overloaded, timeouts, connection resets: retry with backoff. */
export class TransientAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientAiError";
  }
}

/** The model answered but the output failed JSON/zod validation: retry (with a repair hint). */
export class InvalidOutputError extends Error {
  constructor(message: string, public readonly partial?: unknown) {
    super(message);
    this.name = "InvalidOutputError";
  }
}

/** 4xx other than 429 (bad request, auth): do not retry. */
export class FatalAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalAiError";
  }
}

export interface RetryOptions {
  attempts: number;
  baseMs: number;
  maxMs: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with "equal jitter": delay = cap/2 + random(0, cap/2), cap = min(max, base·2^attempt). */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(cap / 2 + random() * (cap / 2));
}

/**
 * Retries transient errors and invalid output with exponential backoff + jitter. Rate limits and
 * fatal errors propagate immediately: rate limits pause the whole import instead of spinning here.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const doSleep = opts.sleep ?? sleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof TransientAiError || err instanceof InvalidOutputError;
      if (!retryable || attempt === opts.attempts - 1) throw err;
      const delay = backoffDelay(attempt, opts.baseMs, opts.maxMs, opts.random);
      opts.onRetry?.(err, attempt + 1, delay);
      await doSleep(delay);
    }
  }
  throw lastErr;
}
