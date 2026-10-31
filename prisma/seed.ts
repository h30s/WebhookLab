/**
 * Seed the database with a realistic set of webhook events.
 *
 * It drives the real processing engine rather than inserting rows directly, so
 * the balances, ledger entries and attempt logs it produces are exactly what
 * the application would produce at runtime.
 *
 * Usage: npm run db:seed   (requires DATABASE_URL and a migrated database)
 */

import { existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { PrismaWebhookStore } from "../src/lib/webhook/prisma-store";
import { WebhookService } from "../src/lib/webhook/service";
import { signPayload } from "../src/lib/webhook/signature";

// The Prisma CLI loads .env for its own commands, but a plain script does not.
if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}

const prisma = new PrismaClient();
const store = new PrismaWebhookStore(prisma);
const signingSecret = process.env.WEBHOOK_SIGNING_SECRET?.trim() || null;

const service = new WebhookService({
  store,
  maxAttempts: Number.parseInt(process.env.WEBHOOK_MAX_ATTEMPTS ?? "3", 10),
  signingSecret,
  // Seeded events are processed immediately, so no retry is ever scheduled
  // far enough out to matter.
  backoff: { baseDelayMs: 1_000, factor: 2, maxDelayMs: 60_000, jitterRatio: 0 },
});

interface SeedEvent {
  id: string;
  type: "payment.succeeded" | "payment.refunded" | "payment.failed";
  email: string;
  name: string;
  amountCents: number;
  currency: string;
  reference: string;
  simulate?: "transient_error" | "permanent_error";
  /** Retry a failed event once after delivery. */
  retry?: boolean;
}

const SEED_EVENTS: SeedEvent[] = [
  { id: "evt_seed_001", type: "payment.succeeded", email: "ada@example.com", name: "Ada Lovelace", amountCents: 12_500, currency: "usd", reference: "order_1001" },
  { id: "evt_seed_002", type: "payment.succeeded", email: "ada@example.com", name: "Ada Lovelace", amountCents: 4_900, currency: "usd", reference: "order_1002" },
  { id: "evt_seed_003", type: "payment.succeeded", email: "grace@example.com", name: "Grace Hopper", amountCents: 8_000, currency: "usd", reference: "order_1003" },
  { id: "evt_seed_004", type: "payment.refunded", email: "ada@example.com", name: "Ada Lovelace", amountCents: 4_900, currency: "usd", reference: "order_1002" },
  { id: "evt_seed_005", type: "payment.failed", email: "grace@example.com", name: "Grace Hopper", amountCents: 2_000, currency: "usd", reference: "order_1004" },
  { id: "evt_seed_006", type: "payment.succeeded", email: "alan@example.com", name: "Alan Turing", amountCents: 21_000, currency: "usd", reference: "order_1005" },
  // Fails on first delivery, then succeeds on the retry.
  { id: "evt_seed_007", type: "payment.succeeded", email: "alan@example.com", name: "Alan Turing", amountCents: 3_500, currency: "usd", reference: "order_1006", simulate: "transient_error", retry: true },
  // Left failed, so the dashboard has something to retry.
  { id: "evt_seed_008", type: "payment.succeeded", email: "grace@example.com", name: "Grace Hopper", amountCents: 6_400, currency: "usd", reference: "order_1007", simulate: "permanent_error" },
  // A second currency, to show one user owning more than one wallet.
  { id: "evt_seed_009", type: "payment.succeeded", email: "ada@example.com", name: "Ada Lovelace", amountCents: 9_900, currency: "eur", reference: "order_1008" },
];

async function deliver(event: SeedEvent): Promise<void> {
  const payload = {
    id: event.id,
    type: event.type,
    created: Math.floor(Date.now() / 1000),
    data: {
      user: { email: event.email, name: event.name },
      amountCents: event.amountCents,
      currency: event.currency,
      reference: event.reference,
      ...(event.simulate ? { simulate: event.simulate } : {}),
    },
  };

  const rawBody = JSON.stringify(payload);
  const result = await service.receive({
    rawBody,
    signatureHeader: signingSecret ? signPayload(rawBody, signingSecret) : null,
  });

  const note = result.duplicate ? "duplicate, ignored" : result.event.status;

  if (event.retry && result.event.status === "FAILED") {
    const retried = await service.retry(result.event.id);
    console.log(`  ${event.id}  ${event.type.padEnd(18)} ${note} -> retried: ${retried.outcome}`);
    return;
  }

  console.log(`  ${event.id}  ${event.type.padEnd(18)} ${note}`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and point it at a database.");
  }

  const existing = await prisma.webhookEvent.count();
  if (existing > 0) {
    console.log(`Database already has ${existing} webhook event(s); seeding would duplicate them.`);
    console.log("Run `npm run db:push -- --force-reset` first if you want a clean seed.");
    return;
  }

  console.log("Seeding WebhookLab...");
  for (const event of SEED_EVENTS) {
    await deliver(event);
  }

  const summary = await service.getDashboard();
  console.log("\nSeeded:");
  console.log(`  events:    ${summary.totals.events}`);
  console.log(`  processed: ${summary.totals.processed}`);
  console.log(`  failed:    ${summary.totals.failed}`);
  console.log(`  wallets:   ${summary.wallets.length}`);
  for (const [currency, cents] of Object.entries(summary.totalBalanceCentsByCurrency)) {
    console.log(`  ${currency} balance: ${(cents / 100).toFixed(2)}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });