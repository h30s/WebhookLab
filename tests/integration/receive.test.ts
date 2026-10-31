import { beforeEach, describe, expect, it } from "vitest";
import { SignatureError, ValidationError } from "@/lib/errors";
import { balanceFor, createHarness, paymentPayload, TEST_SECRET, type Harness } from "../helpers/harness";

/**
 * Normal processing: a valid delivery is recorded once and moves money once.
 */

describe("receiving webhook events", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("records and processes a successful payment", async () => {
    const result = await harness.deliver(paymentPayload({ amountCents: 2500 }));

    expect(result.duplicate).toBe(false);
    expect(result.processed).toBe(true);
    expect(result.event.status).toBe("PROCESSED");
    expect(result.event.providerEventId).toBe("evt_provider_1");
    expect(result.event.attempts).toBe(1);
    expect(result.event.processedAt).not.toBeNull();
  });

  it("credits the wallet by the event amount", async () => {
    await harness.deliver(paymentPayload({ amountCents: 2500 }));

    expect(await balanceFor(harness, "ada@example.com")).toBe(2500);
  });

  it("writes a ledger entry that records the resulting balance", async () => {
    await harness.deliver(paymentPayload({ id: "evt_a", amountCents: 1000 }));
    await harness.deliver(paymentPayload({ id: "evt_b", amountCents: 500 }));

    const transactions = await harness.service.listTransactions();
    expect(transactions).toHaveLength(2);

    // Newest first.
    const newest = transactions[0];
    expect(newest.direction).toBe("CREDIT");
    expect(newest.amountCents).toBe(500);
    expect(newest.currency).toBe("USD");
    // 1000 + 500 - the running balance is captured at write time.
    expect(newest.balanceAfterCents).toBe(1500);
    expect(newest.webhookEventId).not.toBeNull();
  });

  it("records a successful attempt in the audit log", async () => {
    const { event } = await harness.deliver(paymentPayload());

    const attempts = await harness.store.listAttempts(event.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt: 1, status: "SUCCEEDED", error: null });
  });

  it("debits the wallet for a refund it can cover", async () => {
    await harness.deliver(paymentPayload({ id: "evt_pay", amountCents: 5000 }));
    await harness.deliver(
      paymentPayload({ id: "evt_refund", type: "payment.refunded", amountCents: 2000 }),
    );

    expect(await balanceFor(harness, "ada@example.com")).toBe(3000);

    const transactions = await harness.service.listTransactions();
    expect(transactions[0].direction).toBe("DEBIT");
    expect(transactions[0].amountCents).toBe(2000);
    expect(transactions[0].balanceAfterCents).toBe(3000);
  });

  it("fails a refund that the balance cannot cover, leaving the balance untouched", async () => {
    await harness.deliver(paymentPayload({ id: "evt_pay", amountCents: 1000 }));
    const result = await harness.deliver(
      paymentPayload({ id: "evt_refund", type: "payment.refunded", amountCents: 5000 }),
    );

    expect(result.event.status).toBe("FAILED");
    expect(result.event.lastError).toMatch(/insufficient funds: the wallet holds 1000 but this event requires 5000/i);
    expect(await balanceFor(harness, "ada@example.com")).toBe(1000);
    expect(await harness.service.listTransactions()).toHaveLength(1);
  });

  it("handles a failed payment without moving money", async () => {
    const result = await harness.deliver(paymentPayload({ id: "evt_declined", type: "payment.failed" }));

    expect(result.event.status).toBe("PROCESSED");
    expect(await balanceFor(harness, "ada@example.com")).toBe(0);
    expect(await harness.service.listTransactions()).toHaveLength(0);
  });

  it("keeps separate wallets per user and per currency", async () => {
    await harness.deliver(paymentPayload({ id: "e1", email: "ada@example.com", amountCents: 1000 }));
    await harness.deliver(paymentPayload({ id: "e2", email: "grace@example.com", amountCents: 700 }));
    await harness.deliver(
      paymentPayload({ id: "e3", email: "ada@example.com", amountCents: 400, currency: "eur" }),
    );

    expect(await balanceFor(harness, "ada@example.com", "USD")).toBe(1000);
    expect(await balanceFor(harness, "grace@example.com", "USD")).toBe(700);
    expect(await balanceFor(harness, "ada@example.com", "EUR")).toBe(400);

    const users = await harness.store.listUsers();
    expect(users.map((user) => user.email).sort()).toEqual(["ada@example.com", "grace@example.com"]);
  });

  it("reuses one user record across many events", async () => {
    for (const id of ["e1", "e2", "e3"]) {
      await harness.deliver(paymentPayload({ id }));
    }

    const users = await harness.store.listUsers();
    expect(users).toHaveLength(1);
    expect(await harness.service.listEvents()).toHaveLength(3);
    expect(await balanceFor(harness, "ada@example.com")).toBe(7500);
  });

  it("rejects a body that is not valid JSON", async () => {
    await expect(harness.service.receive({ rawBody: "{ not json" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a payload that fails validation", async () => {
    await expect(
      harness.deliver({ id: "evt_bad", type: "payment.succeeded", data: { amountCents: -5 } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("does not create an event row for a rejected payload", async () => {
    await harness.deliver({ id: "evt_bad", type: "payment.exploded", data: {} }).catch(() => undefined);

    expect(await harness.service.listEvents()).toHaveLength(0);
  });

  describe("with a signing secret configured", () => {
    beforeEach(() => {
      harness = createHarness({ signingSecret: TEST_SECRET });
    });

    it("accepts a correctly signed delivery", async () => {
      const result = await harness.deliver(paymentPayload());
      expect(result.event.status).toBe("PROCESSED");
    });

    it("rejects an unsigned delivery", async () => {
      await expect(harness.deliver(paymentPayload(), { sign: false })).rejects.toBeInstanceOf(SignatureError);
    });

    it("rejects a delivery signed with the wrong secret", async () => {
      await expect(
        harness.deliver(paymentPayload(), { secret: "whsec_wrong" }),
      ).rejects.toBeInstanceOf(SignatureError);
    });

    it("rejects a replayed delivery whose timestamp is stale", async () => {
      const staleTimestamp = Math.floor(harness.now().getTime() / 1000) - 3_600;
      await expect(harness.deliver(paymentPayload(), { timestamp: staleTimestamp })).rejects.toBeInstanceOf(
        SignatureError,
      );
    });
  });
});