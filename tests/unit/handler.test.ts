import { describe, expect, it } from "vitest";
import { InsufficientFundsError, ProcessingError, TransientProcessingError } from "@/lib/errors";
import { planEffect, signedDelta } from "@/lib/webhook/handler";
import { parseWebhookPayload } from "@/lib/webhook/schema";
import type { WalletRecord } from "@/lib/webhook/types";

/**
 * The handler is the only place that decides what an event means. These tests
 * pin the business rules down without touching a store.
 */

function payload(overrides: { data?: Record<string, unknown> } & Record<string, unknown> = {}) {
  const { data, ...rest } = overrides;
  const parsed = parseWebhookPayload({
    id: "evt_1",
    type: "payment.succeeded",
    ...rest,
    data: {
      user: { email: "ada@example.com" },
      amountCents: 2500,
      currency: "usd",
      reference: "order_1",
      ...data,
    },
  });
  if (!parsed.ok) throw new Error(`test payload invalid: ${JSON.stringify(parsed.issues)}`);
  return parsed.payload;
}

function wallet(balanceCents: number): WalletRecord {
  return {
    id: "wal_1",
    userId: "usr_1",
    currency: "USD",
    balanceCents,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("planEffect", () => {
  it("credits the wallet for a successful payment", () => {
    const plan = planEffect(payload(), { wallet: null, attempt: 1 });
    expect(plan.effect).toEqual({
      direction: "CREDIT",
      amountCents: 2500,
      currency: "USD",
      description: "Payment received (order_1)",
    });
  });

  it("uppercases the currency from the payload", () => {
    const plan = planEffect(payload({ data: { currency: "eur" } }), { wallet: null, attempt: 1 });
    expect(plan.effect?.currency).toBe("EUR");
  });

  it("debits the wallet for a refund when the balance covers it", () => {
    const plan = planEffect(payload({ type: "payment.refunded" }), { wallet: wallet(5000), attempt: 1 });
    expect(plan.effect?.direction).toBe("DEBIT");
    expect(plan.effect?.amountCents).toBe(2500);
  });

  it("refuses a refund larger than the balance", () => {
    expect(() => planEffect(payload({ type: "payment.refunded" }), { wallet: wallet(100), attempt: 1 })).toThrow(
      InsufficientFundsError,
    );
  });

  it("treats a failed payment as handled with no wallet movement", () => {
    const plan = planEffect(payload({ type: "payment.failed" }), { wallet: null, attempt: 1 });
    expect(plan.effect).toBeNull();
  });

  it("raises a retryable error for a simulated transient fault on the first attempt", () => {
    let caught: unknown;
    try {
      planEffect(payload({ data: { simulate: "transient_error" } }), { wallet: null, attempt: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TransientProcessingError);
    expect((caught as TransientProcessingError).retryable).toBe(true);
  });

  it("lets the simulated transient fault clear on a later attempt", () => {
    const plan = planEffect(payload({ data: { simulate: "transient_error" } }), { wallet: null, attempt: 2 });
    expect(plan.effect?.direction).toBe("CREDIT");
  });

  it("raises a non-retryable error for a simulated permanent fault", () => {
    let caught: unknown;
    try {
      planEffect(payload({ data: { simulate: "permanent_error" } }), { wallet: null, attempt: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProcessingError);
    expect((caught as ProcessingError).retryable).toBe(false);
  });

  it("reports a signed delta with credits positive and debits negative", () => {
    const credit = planEffect(payload(), { wallet: null, attempt: 1 });
    const debit = planEffect(payload({ type: "payment.refunded" }), { wallet: wallet(9000), attempt: 1 });
    expect(signedDelta(credit.effect!)).toBe(2500);
    expect(signedDelta(debit.effect!)).toBe(-2500);
  });
});

describe("payload validation", () => {
  it("rejects an unknown event type", () => {
    const result = parseWebhookPayload({ id: "evt_1", type: "payment.exploded", data: {} });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-positive amount", () => {
    const result = parseWebhookPayload({
      id: "evt_1",
      type: "payment.succeeded",
      data: { user: { email: "a@b.co" }, amountCents: 0, currency: "usd" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid email", () => {
    const result = parseWebhookPayload({
      id: "evt_1",
      type: "payment.succeeded",
      data: { user: { email: "nope" }, amountCents: 100, currency: "usd" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.path.includes("email"))).toBe(true);
  });
});