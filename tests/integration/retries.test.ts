import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { balanceFor, createHarness, paymentPayload, type Harness } from "../helpers/harness";

/**
 * Failure and retry behaviour, including the manual retry an operator triggers
 * from the dashboard.
 */

describe("failed webhook events", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("records a retryable failure without moving money", async () => {
    const result = await harness.deliver(paymentPayload({ simulate: "transient_error" }));

    expect(result.event.status).toBe("FAILED");
    expect(result.event.attempts).toBe(1);
    expect(result.event.lastError).toMatch(/simulated upstream timeout/i);
    expect(await balanceFor(harness, "ada@example.com")).toBe(0);
    expect(await harness.service.listTransactions()).toHaveLength(0);
  });

  it("schedules the next automatic retry with exponential backoff", async () => {
    const result = await harness.deliver(paymentPayload({ simulate: "transient_error" }));

    expect(result.event.nextRetryAt).not.toBeNull();
    // Harness backoff: base 1000ms, factor 2, no jitter -> attempt 1 waits 1s.
    expect(result.event.nextRetryAt!.getTime() - harness.now().getTime()).toBe(1_000);
  });

  it("logs the failed attempt in the audit trail", async () => {
    const { event } = await harness.deliver(paymentPayload({ simulate: "transient_error" }));

    const attempts = await harness.store.listAttempts(event.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("FAILED");
    expect(attempts[0].error).toMatch(/simulated upstream timeout/i);
  });

  it("does not schedule a retry for a permanent failure", async () => {
    const result = await harness.deliver(paymentPayload({ simulate: "permanent_error" }));

    expect(result.event.status).toBe("FAILED");
    expect(result.event.nextRetryAt).toBeNull();
  });
});

describe("manually retrying a failed webhook", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("succeeds on retry and credits the wallet exactly once", async () => {
    const failed = await harness.deliver(paymentPayload({ amountCents: 2500, simulate: "transient_error" }));
    expect(failed.event.status).toBe("FAILED");

    const retried = await harness.service.retry(failed.event.id);

    expect(retried.outcome).toBe("PROCESSED");
    expect(retried.event.status).toBe("PROCESSED");
    expect(retried.event.attempts).toBe(2);
    expect(retried.event.lastError).toBeNull();
    expect(retried.event.nextRetryAt).toBeNull();
    expect(retried.event.processedAt).not.toBeNull();
    expect(await balanceFor(harness, "ada@example.com")).toBe(2500);
    expect(await harness.service.listTransactions()).toHaveLength(1);
  });

  it("writes one ledger entry linked to the event", async () => {
    const { event } = await harness.deliver(paymentPayload({ simulate: "transient_error" }));

    const retried = await harness.service.retry(event.id);

    expect(retried.transaction?.webhookEventId).toBe(event.id);
    expect(retried.transaction?.amountCents).toBe(2500);
  });

  it("appends a second entry to the attempt log", async () => {
    const { event } = await harness.deliver(paymentPayload({ simulate: "transient_error" }));
    await harness.service.retry(event.id);

    const attempts = await harness.store.listAttempts(event.id);
    expect(attempts.map((attempt) => [attempt.attempt, attempt.status])).toEqual([
      [1, "FAILED"],
      [2, "SUCCEEDED"],
    ]);
  });

  it("stays failed when the underlying fault is permanent", async () => {
    const { event } = await harness.deliver(paymentPayload({ simulate: "permanent_error" }));

    const retried = await harness.service.retry(event.id);

    expect(retried.outcome).toBe("FAILED");
    expect(retried.event.status).toBe("FAILED");
    expect(retried.event.attempts).toBe(2);
    expect(await balanceFor(harness, "ada@example.com")).toBe(0);
  });

  it("allows a manual retry after automatic retries are exhausted", async () => {
    // maxAttempts = 1 means the first failure is final as far as the automatic
    // pipeline is concerned, but an operator can still retry by hand.
    harness = createHarness({ maxAttempts: 1 });

    const { event } = await harness.deliver(paymentPayload({ simulate: "transient_error" }));
    expect(event.status).toBe("FAILED");
    expect(event.nextRetryAt).toBeNull();

    const retried = await harness.service.retry(event.id);

    expect(retried.outcome).toBe("PROCESSED");
    expect(await balanceFor(harness, "ada@example.com")).toBe(2500);
  });

  it("stops scheduling automatic retries once maxAttempts is reached", async () => {
    harness = createHarness({ maxAttempts: 2 });

    const { event } = await harness.deliver(paymentPayload({ simulate: "permanent_error" }));
    const second = await harness.service.retry(event.id);

    expect(second.event.attempts).toBe(2);
    expect(second.event.nextRetryAt).toBeNull();
  });

  it("rejects a retry for an event that is not failed", async () => {
    const { event } = await harness.deliver(paymentPayload());

    await expect(harness.service.retry(event.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects a retry for an unknown event", async () => {
    await expect(harness.service.retry("evt_does_not_exist")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("never double-credits when a retry races the automatic pipeline", async () => {
    const { event } = await harness.deliver(paymentPayload({ amountCents: 2500, simulate: "transient_error" }));

    // Both retries run the pipeline; only one ledger row may exist.
    const results = await Promise.allSettled([
      harness.service.retry(event.id),
      harness.service.retry(event.id),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(await harness.service.listTransactions()).toHaveLength(1);
    expect(await balanceFor(harness, "ada@example.com")).toBe(2500);
  });
});