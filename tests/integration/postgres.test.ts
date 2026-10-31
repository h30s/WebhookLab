import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaWebhookStore } from "@/lib/webhook/prisma-store";
import { WebhookService } from "@/lib/webhook/service";
import { buildDelivery, paymentPayload } from "../helpers/harness";

/**
 * Integration tests against a real PostgreSQL database through Prisma.
 *
 * These are skipped when DATABASE_URL is not set, so `npm test` still passes
 * without a database. To run them:
 *
 *   docker run -d --name webhooklab-pg -p 5432:5432 \
 *     -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres \
 *     -e POSTGRES_DB=webhooklab postgres:16-alpine
 *   copy .env.example .env      # DATABASE_URL already points here
 *   npx prisma db push
 *   npm test
 *
 * They cover what only a real database can prove: the unique indexes, the
 * interactive transaction, and atomic increments under concurrency.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL?.trim());

describe.skipIf(!hasDatabase)("PostgreSQL store", () => {
  let prisma: PrismaClient;
  let store: PrismaWebhookStore;
  let service: WebhookService;

  beforeAll(() => {
    prisma = new PrismaClient();
    store = new PrismaWebhookStore(prisma);
    service = new WebhookService({
      store,
      maxAttempts: 3,
      signingSecret: null,
      backoff: { baseDelayMs: 1_000, factor: 2, maxDelayMs: 60_000, jitterRatio: 0 },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Delete in foreign-key order.
    await prisma.walletTransaction.deleteMany();
    await prisma.webhookAttempt.deleteMany();
    await prisma.webhookEvent.deleteMany();
    await prisma.wallet.deleteMany();
    await prisma.user.deleteMany();
  });

  async function balanceFor(email: string, currency = "USD"): Promise<number> {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return 0;
    const wallet = await prisma.wallet.findUnique({
      where: { userId_currency: { userId: user.id, currency } },
    });
    return wallet?.balanceCents ?? 0;
  }

  it("processes a payment and credits the wallet", async () => {
    const result = await service.receive(buildDelivery(paymentPayload({ amountCents: 2500 })));

    expect(result.event.status).toBe("PROCESSED");
    expect(await balanceFor("ada@example.com")).toBe(2500);

    const entries = await prisma.walletTransaction.findMany();
    expect(entries).toHaveLength(1);
    expect(entries[0].balanceAfterCents).toBe(2500);
    expect(entries[0].webhookEventId).toBe(result.event.id);
  });

  it("records only one event and one ledger entry for a duplicate delivery", async () => {
    const delivery = buildDelivery(paymentPayload({ amountCents: 2500 }));
    await service.receive(delivery);
    const replay = await service.receive(delivery);

    expect(replay.duplicate).toBe(true);
    expect(await prisma.webhookEvent.count()).toBe(1);
    expect(await prisma.walletTransaction.count()).toBe(1);
    expect(await balanceFor("ada@example.com")).toBe(2500);
  });

  it("credits once when a failed event is retried", async () => {
    const failed = await service.receive(
      buildDelivery(paymentPayload({ amountCents: 2500, simulate: "transient_error" })),
    );
    expect(failed.event.status).toBe("FAILED");
    expect(await balanceFor("ada@example.com")).toBe(0);

    const retried = await service.retry(failed.event.id);

    expect(retried.outcome).toBe("PROCESSED");
    expect(await balanceFor("ada@example.com")).toBe(2500);
    expect(await prisma.walletTransaction.count()).toBe(1);

    const attempts = await prisma.webhookAttempt.findMany({ orderBy: { attempt: "asc" } });
    expect(attempts.map((attempt) => attempt.status)).toEqual(["FAILED", "SUCCEEDED"]);
  });

  it("refuses a second ledger entry for the same event at the database level", async () => {
    const { event } = await service.receive(buildDelivery(paymentPayload()));
    const wallet = await prisma.wallet.findFirstOrThrow();

    await expect(
      prisma.walletTransaction.create({
        data: {
          walletId: wallet.id,
          webhookEventId: event.id,
          direction: "CREDIT",
          amountCents: 100,
          currency: "USD",
          balanceAfterCents: 100,
          description: "second entry for the same event",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("applies concurrent balance increments atomically", async () => {
    const { event } = await service.receive(buildDelivery(paymentPayload({ amountCents: 1000 })));
    const wallet = await prisma.wallet.findFirstOrThrow();

    await Promise.all([
      store.applyWalletDelta(wallet.id, 500),
      store.applyWalletDelta(wallet.id, 250),
      store.applyWalletDelta(wallet.id, 125),
    ]);

    const after = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(after.balanceCents).toBe(1000 + 500 + 250 + 125);
    expect(await prisma.walletTransaction.count()).toBe(1);
    expect(event.status).toBe("PROCESSED");
  });

  it("rolls back an interactive transaction that throws", async () => {
    const { event } = await service.receive(buildDelivery(paymentPayload({ amountCents: 1000 })));
    const wallet = await prisma.wallet.findFirstOrThrow();

    await expect(
      store.transaction(async (tx) => {
        await tx.applyWalletDelta(wallet.id, 999);
        await tx.updateEvent(event.id, { status: "FAILED", lastError: "abort" });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");

    const after = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    const eventAfter = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(after.balanceCents).toBe(1000);
    expect(eventAfter.status).toBe("PROCESSED");
  });

  it("reports dashboard totals from the database", async () => {
    await service.receive(buildDelivery(paymentPayload({ id: "pg_1", amountCents: 1000 })));
    await service.receive(buildDelivery(paymentPayload({ id: "pg_2", email: "grace@example.com", amountCents: 400 })));
    await service.receive(buildDelivery(paymentPayload({ id: "pg_3", simulate: "permanent_error" })));

    const summary = await service.getDashboard();

    expect(summary.totals.events).toBe(3);
    expect(summary.totals.processed).toBe(2);
    expect(summary.totals.failed).toBe(1);
    expect(summary.totalBalanceCentsByCurrency.USD).toBe(1400);
    expect(summary.wallets).toHaveLength(2);
  });
});