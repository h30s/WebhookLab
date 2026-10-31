import { describe, expect, it } from "vitest";
import { InMemoryWebhookStore } from "@/lib/webhook/memory-store";
import { WebhookService } from "@/lib/webhook/service";
import type { CreateTransactionInput } from "@/lib/webhook/store";
import { buildDelivery, paymentPayload } from "../helpers/harness";

/**
 * Atomicity: an event must never be marked PROCESSED without its ledger entry,
 * and a wallet balance must never move without one either.
 */

/** A store whose ledger write fails, to prove the transaction rolls back. */
class FlakyLedgerStore extends InMemoryWebhookStore {
  failNextLedgerWrite = false;

  override async createTransaction(input: CreateTransactionInput) {
    if (this.failNextLedgerWrite) {
      this.failNextLedgerWrite = false;
      throw new Error("ledger write failed: disk full");
    }
    return super.createTransaction(input);
  }
}

/**
 * A store that reports "no ledger entry yet" once, simulating the stale read a
 * real database allows when two workers apply the same event concurrently:
 * both check, both see nothing, and the unique index is what stops the second
 * write.
 */
class StaleLedgerReadStore extends InMemoryWebhookStore {
  hideLedgerEntryOnce = false;

  override async findTransactionByEventId(webhookEventId: string) {
    if (this.hideLedgerEntryOnce) {
      this.hideLedgerEntryOnce = false;
      return null;
    }
    return super.findTransactionByEventId(webhookEventId);
  }
}

describe("transactional processing", () => {
  it("rolls back a wallet movement when a later write in the same transaction fails", async () => {
    const store = new FlakyLedgerStore();
    const service = new WebhookService({
      store,
      maxAttempts: 3,
      clock: () => new Date("2026-01-01T12:00:00.000Z"),
      backoff: { baseDelayMs: 1_000, factor: 2, maxDelayMs: 60_000, jitterRatio: 0 },
    });

    store.failNextLedgerWrite = true;
    const result = await service.receive(buildDelivery(paymentPayload({ amountCents: 2500 })));

    expect(result.event.status).toBe("FAILED");
    expect(result.event.lastError).toMatch(/ledger write failed/i);

    // The balance delta that was applied before the failure must be undone.
    const wallets = await store.listWallets();
    expect(wallets[0]?.balanceCents ?? 0).toBe(0);
    expect(await store.listTransactions()).toHaveLength(0);
  });

  it("rolls back every write made inside a failed transaction", async () => {
    const store = new InMemoryWebhookStore();
    const user = await store.upsertUser({ email: "ada@example.com" });
    const wallet = await store.findOrCreateWallet(user.id, "USD");
    await store.applyWalletDelta(wallet.id, 1000);

    await expect(
      store.transaction(async (tx) => {
        await tx.applyWalletDelta(wallet.id, 500);
        await tx.createTransaction({
          walletId: wallet.id,
          webhookEventId: null,
          direction: "CREDIT",
          amountCents: 500,
          currency: "USD",
          balanceAfterCents: 1500,
          description: "should not survive",
        });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");

    const after = await store.findWalletById(wallet.id);
    expect(after?.balanceCents).toBe(1000);
    expect(await store.listTransactions()).toHaveLength(0);
  });

  it("commits every write when the transaction succeeds", async () => {
    const store = new InMemoryWebhookStore();
    const user = await store.upsertUser({ email: "ada@example.com" });
    const wallet = await store.findOrCreateWallet(user.id, "USD");

    await store.transaction(async (tx) => {
      await tx.applyWalletDelta(wallet.id, 1000);
      await tx.createTransaction({
        walletId: wallet.id,
        webhookEventId: null,
        direction: "CREDIT",
        amountCents: 1000,
        currency: "USD",
        balanceAfterCents: 1000,
        description: "committed",
      });
    });

    const after = await store.findWalletById(wallet.id);
    expect(after?.balanceCents).toBe(1000);
    expect(await store.listTransactions()).toHaveLength(1);
  });

  it("refuses a second ledger entry for the same event", async () => {
    const store = new InMemoryWebhookStore();
    const user = await store.upsertUser({ email: "ada@example.com" });
    const wallet = await store.findOrCreateWallet(user.id, "USD");
    const event = await store.createEvent({
      providerEventId: "evt_1",
      type: "payment.succeeded",
      payload: {},
      userId: user.id,
      maxAttempts: 3,
      receivedAt: new Date(),
    });

    const entry = {
      walletId: wallet.id,
      webhookEventId: event.id,
      direction: "CREDIT" as const,
      amountCents: 100,
      currency: "USD",
      balanceAfterCents: 100,
      description: "first",
    };
    await store.createTransaction(entry);

    await expect(store.createTransaction(entry)).rejects.toThrow(/already exists/i);
  });
});
describe("a concurrent duplicate application", () => {
  /**
   * The case the unique index exists for: this worker read the ledger before
   * the other worker committed, so it believes the event still needs applying.
   */
  it("detects the duplicate, rolls back its own movement, and settles the event", async () => {
    const store = new StaleLedgerReadStore();
    const service = new WebhookService({
      store,
      maxAttempts: 3,
      clock: () => new Date("2026-01-01T12:00:00.000Z"),
      backoff: { baseDelayMs: 1_000, factor: 2, maxDelayMs: 60_000, jitterRatio: 0 },
    });

    // The event fails its first delivery, so it is retryable.
    const { event } = await service.receive({
      rawBody: JSON.stringify(paymentPayload({ amountCents: 2500, simulate: "transient_error" })),
    });
    expect(event.status).toBe("FAILED");

    // Another worker applies it first, while this worker's read is stale.
    const user = await store.upsertUser({ email: "ada@example.com" });
    const wallet = await store.findOrCreateWallet(user.id, "USD");
    const applied = await store.applyWalletDelta(wallet.id, 2500);
    await store.createTransaction({
      walletId: wallet.id,
      webhookEventId: event.id,
      direction: "CREDIT",
      amountCents: 2500,
      currency: "USD",
      balanceAfterCents: applied.balanceCents,
      description: "Payment received (order_1001)",
    });

    store.hideLedgerEntryOnce = true;
    const retried = await service.retry(event.id);

    // The retry recognised the existing ledger entry instead of failing.
    expect(retried.outcome).toBe("ALREADY_PROCESSED");
    expect(retried.event.status).toBe("PROCESSED");
    expect(retried.error).toBeNull();

    // ...and its own wallet movement was rolled back, so money moved once.
    const finalWallet = await store.findWalletById(wallet.id);
    expect(finalWallet?.balanceCents).toBe(2500);
    expect(await store.listTransactions()).toHaveLength(1);
  });
});