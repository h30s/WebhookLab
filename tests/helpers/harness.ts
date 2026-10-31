import { InMemoryWebhookStore, type InMemoryStoreOptions } from "@/lib/webhook/memory-store";
import { WebhookService } from "@/lib/webhook/service";
import { signPayload } from "@/lib/webhook/signature";
import type { ReceiveResult } from "@/lib/webhook/types";

/**
 * Shared test harness.
 *
 * Everything the engine depends on is injected, so a test can run the full
 * receive -> process -> retry pipeline with no database and no waiting.
 */

export const TEST_SECRET = "whsec_test_secret";
export const FIXED_NOW = new Date("2026-01-01T12:00:00.000Z");

export interface HarnessOptions {
  signingSecret?: string | null;
  maxAttempts?: number;
  now?: Date;
  seed?: InMemoryStoreOptions["seed"];
}

export interface Harness {
  store: InMemoryWebhookStore;
  service: WebhookService;
  /**
   * Build a delivery and hand it to the service, signing it when the harness
   * has a secret configured. This is the normal way to drive the pipeline.
   */
  deliver(payload: Record<string, unknown>, options?: DeliverOptions): Promise<ReceiveResult>;
  /** Move the injected clock forward. */
  advanceClock(ms: number): void;
  /** Set the injected clock to an absolute instant. */
  setClock(date: Date): void;
  now(): Date;
}

export interface DeliverOptions {
  /** Set false to send an unsigned delivery even when a secret is configured. */
  sign?: boolean;
  /** Override the secret used to sign (for example to send a wrong one). */
  secret?: string | null;
  timestamp?: number;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  let current = new Date((options.now ?? FIXED_NOW).getTime());
  const store = new InMemoryWebhookStore({ seed: options.seed });
  const signingSecret = options.signingSecret ?? null;

  const service = new WebhookService({
    store,
    maxAttempts: options.maxAttempts ?? 3,
    signingSecret,
    clock: () => new Date(current.getTime()),
    // Deterministic backoff: 1s, 2s, 4s with no jitter.
    backoff: { baseDelayMs: 1_000, factor: 2, maxDelayMs: 60_000, jitterRatio: 0 },
    random: () => 0,
  });

  const harness: Harness = {
    store,
    service,
    deliver: (payload, deliverOptions = {}) => {
      const secret = deliverOptions.secret === undefined ? signingSecret : deliverOptions.secret;
      const delivery = buildDelivery(payload, {
        secret: deliverOptions.sign === false ? null : secret,
        timestamp: deliverOptions.timestamp,
      });
      return service.receive({
        rawBody: delivery.rawBody,
        signatureHeader: delivery.headers["x-webhook-signature"] ?? null,
      });
    },
    advanceClock: (ms) => {
      current = new Date(current.getTime() + ms);
    },
    setClock: (date) => {
      current = new Date(date.getTime());
    },
    now: () => new Date(current.getTime()),
  };

  return harness;
}

export interface PaymentOverrides {
  id?: string;
  type?: string;
  email?: string;
  name?: string;
  amountCents?: number;
  currency?: string;
  reference?: string;
  simulate?: "transient_error" | "permanent_error";
  [key: string]: unknown;
}

/** A well-formed `payment.succeeded` style webhook body. */
export function paymentPayload(overrides: PaymentOverrides = {}): Record<string, unknown> {
  const {
    id = "evt_provider_1",
    type = "payment.succeeded",
    email = "ada@example.com",
    name = "Ada Lovelace",
    amountCents = 2500,
    currency = "usd",
    reference = "order_1001",
    simulate,
    ...rest
  } = overrides;

  return {
    id,
    type,
    created: Math.floor(FIXED_NOW.getTime() / 1000),
    data: {
      user: { email, name },
      amountCents,
      currency,
      reference,
      ...(simulate ? { simulate } : {}),
    },
    ...rest,
  };
}

export interface Delivery {
  rawBody: string;
  headers: Record<string, string>;
}

/** Serialise a payload and sign it the way a real provider would. */
export function buildDelivery(
  payload: Record<string, unknown>,
  options: { secret?: string | null; timestamp?: number } = {},
): Delivery {
  const rawBody = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.secret) {
    headers["x-webhook-signature"] = signPayload(
      rawBody,
      options.secret,
      options.timestamp ?? Math.floor(FIXED_NOW.getTime() / 1000),
    );
  }
  return { rawBody, headers };
}

/** Read a wallet's balance for a user email + currency, or 0 when it does not exist yet. */
export async function balanceFor(harness: Harness, email: string, currency = "USD"): Promise<number> {
  const users = await harness.store.listUsers();
  const user = users.find((row) => row.email === email);
  if (!user) return 0;
  const wallet = await harness.store.findWallet(user.id, currency);
  return wallet?.balanceCents ?? 0;
}