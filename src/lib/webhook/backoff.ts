/**
 * Exponential backoff for retries.
 *
 * Kept as a pure function so the schedule can be asserted in tests without
 * waiting for real time to pass.
 */

export const DEFAULT_BACKOFF = {
  /** Delay before the first retry, in milliseconds. */
  baseDelayMs: 5_000,
  /** Multiplier applied per attempt. */
  factor: 2,
  /** Upper bound for a single delay. */
  maxDelayMs: 5 * 60_000,
  /** Random jitter applied on top, as a fraction of the computed delay. */
  jitterRatio: 0,
} as const;

export interface BackoffConfig {
  baseDelayMs: number;
  factor: number;
  maxDelayMs: number;
  jitterRatio: number;
}

/**
 * Delay before the next attempt.
 *
 * @param attemptNumber the attempt that just failed (1 for the first delivery).
 * @param random source of jitter in [0, 1); injectable for deterministic tests.
 */
export function nextRetryDelayMs(
  attemptNumber: number,
  config: BackoffConfig = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attemptNumber - 1);
  const raw = config.baseDelayMs * Math.pow(config.factor, exponent);
  const capped = Math.min(raw, config.maxDelayMs);
  const jitter = capped * config.jitterRatio * random();
  return Math.round(capped + jitter);
}

export function nextRetryAt(
  failedAt: Date,
  attemptNumber: number,
  config: BackoffConfig = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): Date {
  return new Date(failedAt.getTime() + nextRetryDelayMs(attemptNumber, config, random));
}