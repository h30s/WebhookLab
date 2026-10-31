import { describe, expect, it } from "vitest";
import { nextRetryAt, nextRetryDelayMs } from "@/lib/webhook/backoff";

const CONFIG = { baseDelayMs: 1_000, factor: 2, maxDelayMs: 10_000, jitterRatio: 0 };

describe("retry backoff", () => {
  it("waits the base delay before the first retry", () => {
    expect(nextRetryDelayMs(1, CONFIG)).toBe(1_000);
  });

  it("doubles the delay on each subsequent attempt", () => {
    expect(nextRetryDelayMs(2, CONFIG)).toBe(2_000);
    expect(nextRetryDelayMs(3, CONFIG)).toBe(4_000);
  });

  it("never exceeds the configured ceiling", () => {
    expect(nextRetryDelayMs(20, CONFIG)).toBe(10_000);
  });

  it("adds jitter proportionally when configured", () => {
    const withJitter = { ...CONFIG, jitterRatio: 0.5 };
    expect(nextRetryDelayMs(1, withJitter, () => 1)).toBe(1_500);
    expect(nextRetryDelayMs(1, withJitter, () => 0)).toBe(1_000);
  });

  it("schedules the next retry relative to the failure time", () => {
    const failedAt = new Date("2026-01-01T12:00:00.000Z");
    expect(nextRetryAt(failedAt, 2, CONFIG).toISOString()).toBe("2026-01-01T12:00:02.000Z");
  });
});