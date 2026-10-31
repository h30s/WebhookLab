import { beforeEach, describe, expect, it } from "vitest";
import { balanceFor, createHarness, paymentPayload, type Harness } from "../helpers/harness";

/**
 * Duplicate deliveries are the single most common real-world webhook bug.
 * These tests pin the idempotency guarantees down.
 */

describe("duplicate webhook events", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("ignores a re-delivery of the same provider event id", async () => {
    const first = await harness.deliver(paymentPayload());
    const second = await harness.deliver(paymentPayload());

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.processed).toBe(false);
    expect(second.event.id).toBe(first.event.id);
  });

  it("creates only one event row for a repeated delivery", async () => {
    await harness.deliver(paymentPayload());
    await harness.deliver(paymentPayload());
    await harness.deliver(paymentPayload());

    expect(await harness.service.listEvents()).toHaveLength(1);
  });

  it("moves money exactly once across repeated deliveries", async () => {
    await harness.deliver(paymentPayload({ amountCents: 2500 }));
    await harness.deliver(paymentPayload({ amountCents: 2500 }));

    expect(await balanceFor(harness, "ada@example.com")).toBe(2500);
    expect(await harness.service.listTransactions()).toHaveLength(1);
  });

  it("still ignores duplicates when the body changes but the id does not", async () => {
    await harness.deliver(paymentPayload({ amountCents: 1000 }));
    const replay = await harness.deliver(paymentPayload({ amountCents: 999_999 }));

    expect(replay.duplicate).toBe(true);
    expect(await balanceFor(harness, "ada@example.com")).toBe(1000);
  });

  it("keeps a different event id on the same payment as a separate event", async () => {
    await harness.deliver(paymentPayload({ id: "evt_first", amountCents: 1000 }));
    const second = await harness.deliver(paymentPayload({ id: "evt_second", amountCents: 1000 }));

    expect(second.duplicate).toBe(false);
    expect(await harness.service.listEvents()).toHaveLength(2);
    expect(await balanceFor(harness, "ada@example.com")).toBe(2000);
  });

  it("survives two concurrent deliveries of the same event", async () => {
    const results = await Promise.all([
      harness.deliver(paymentPayload()),
      harness.deliver(paymentPayload()),
    ]);

    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect(await harness.service.listEvents()).toHaveLength(1);
    expect(await harness.service.listTransactions()).toHaveLength(1);
    expect(await balanceFor(harness, "ada@example.com")).toBe(2500);
  });

  it("does not re-apply an event that is already processed", async () => {
    const { event } = await harness.deliver(paymentPayload());

    const again = await harness.service.process(event.id);

    expect(again.outcome).toBe("ALREADY_PROCESSED");
    expect(again.event.attempts).toBe(1);
    expect(await balanceFor(harness, "ada@example.com")).toBe(2500);
    expect(await harness.service.listTransactions()).toHaveLength(1);
  });

  it("refuses to retry an event that already succeeded", async () => {
    const { event } = await harness.deliver(paymentPayload());

    await expect(harness.service.retry(event.id)).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
  });
});