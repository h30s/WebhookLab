import {
  ConflictError,
  NotFoundError,
  ProcessingError,
  SignatureError,
  ValidationError,
  isAppError,
  toAppError,
} from "@/lib/errors";
import { log } from "@/lib/logger";
import { DEFAULT_BACKOFF, nextRetryAt, type BackoffConfig } from "./backoff";
import { signedDelta } from "./handler";
import { planEffect } from "./handler";
import { parseWebhookPayload, type WebhookPayload } from "./schema";
import { SIGNATURE_HEADER, verifySignature } from "./signature";
import type { WebhookStore } from "./store";
import type {
  DashboardSummary,
  EventFilters,
  ProcessingOutcome,
  ProcessingResult,
  ReceiveResult,
  UserRecord,
  WalletRecord,
  WalletTransactionRecord,
  WebhookAttemptRecord,
  WebhookEventRecord,
} from "./types";

/**
 * The webhook processing engine.
 *
 * This module knows nothing about HTTP or React. It receives raw bytes, and it
 * owns three responsibilities:
 *
 *   1. `receive()`  - verify, validate and record a delivery (idempotently).
 *   2. `process()`  - apply the event's wallet movement inside a transaction,
 *                     recording every attempt and scheduling retries.
 *   3. `retry()`    - re-run the pipeline for a manually retried event.
 *
 * Every dependency (store, clock, randomness) is injected, so the whole engine
 * is testable without a database, a network, or waiting for real time.
 */

export interface WebhookServiceOptions {
  store: WebhookStore;
  /** Attempts (initial delivery + retries) before an event is left as FAILED. */
  maxAttempts?: number;
  /** When set, `x-webhook-signature` is required and verified. */
  signingSecret?: string | null;
  /** Seconds of clock skew tolerated on a signature timestamp. */
  signatureToleranceSeconds?: number;
  clock?: () => Date;
  backoff?: BackoffConfig;
  /** Injectable randomness, used only for backoff jitter. */
  random?: () => number;
}

export interface ReceiveInput {
  rawBody: string;
  signatureHeader?: string | null;
}

export interface EventDetail {
  event: WebhookEventRecord;
  user: UserRecord | null;
  attempts: WebhookAttemptRecord[];
  transaction: WalletTransactionRecord | null;
}

export class WebhookService {
  private readonly store: WebhookStore;
  private readonly maxAttempts: number;
  private readonly signingSecret: string | null;
  private readonly signatureToleranceSeconds: number;
  private readonly clock: () => Date;
  private readonly backoff: BackoffConfig;
  private readonly random: () => number;

  constructor(options: WebhookServiceOptions) {
    this.store = options.store;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.signingSecret = options.signingSecret ?? null;
    this.signatureToleranceSeconds = options.signatureToleranceSeconds ?? 300;
    this.clock = options.clock ?? (() => new Date());
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.random = options.random ?? Math.random;
  }

  private now(): Date {
    return this.clock();
  }

  // -------------------------------------------------------------------------
  // 1. Receive
  // -------------------------------------------------------------------------

  /**
   * Verify, validate and record one webhook delivery, then process it.
   *
   * Delivering the same `data.id` twice is safe: the second call is recognised
   * as a duplicate, no second event row is created, and no money moves twice.
   */
  async receive(input: ReceiveInput): Promise<ReceiveResult> {
    const payload = this.parseAndVerify(input);

    const user = await this.store.upsertUser({
      email: payload.data.user.email,
      name: payload.data.user.name,
    });

    // BUG: duplicate detection removed. Every delivery creates a new event
    // row and runs the pipeline, so re-delivering the same provider event id
    // credits the wallet again instead of being ignored.
    const event = await this.store.createEvent({
      providerEventId: payload.id,
      type: payload.type,
      payload: payload as unknown as Record<string, unknown>,
      userId: user.id,
      maxAttempts: this.maxAttempts,
      receivedAt: this.now(),
    });

    log("info", "Webhook event received", {
      eventId: event.id,
      providerEventId: event.providerEventId,
      type: event.type,
    });

    const result = await this.runPipeline(event);
    return { event: result.event, duplicate: false, processed: true };
  }

  /** Verify the signature (when configured) and validate the JSON body. */
  private parseAndVerify(input: ReceiveInput): WebhookPayload {
    if (this.signingSecret) {
      const verification = verifySignature(input.rawBody, input.signatureHeader, this.signingSecret, {
        toleranceSeconds: this.signatureToleranceSeconds,
        now: () => Math.floor(this.now().getTime() / 1000),
      });
      if (!verification.valid) {
        log("warn", "Rejected webhook with an invalid signature", { reason: verification.reason });
        throw new SignatureError(
          `Webhook signature verification failed (${verification.reason.replace(/_/g, " ")})`,
        );
      }
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(input.rawBody);
    } catch {
      throw new ValidationError("Request body is not valid JSON");
    }

    const parsed = parseWebhookPayload(decoded);
    if (!parsed.ok) {
      throw new ValidationError("Webhook payload failed validation", { issues: parsed.issues });
    }
    return parsed.payload;
  }

  // -------------------------------------------------------------------------
  // 2. Process
  // -------------------------------------------------------------------------

  /**
   * Run the pipeline for an event, recording the outcome.
   *
   * A processing failure is not an exception for the caller: it is recorded on
   * the event (status FAILED, lastError, nextRetryAt) and returned, because
   * that is exactly what a real webhook receiver has to report back to the
   * provider.
   */
  async process(eventId: string): Promise<ProcessingResult> {
    const event = await this.store.findEventById(eventId);
    if (!event) throw new NotFoundError("WebhookEvent", eventId);

    if (event.status === "PROCESSED") {
      return {
        event,
        outcome: "ALREADY_PROCESSED",
        transaction: await this.store.findTransactionByEventId(event.id),
        error: null,
      };
    }

    return this.runPipeline(event);
  }

  /**
   * Manually retry a failed event.
   *
   * Only FAILED events can be retried, and manual retries are allowed even
   * after automatic retries are exhausted - an operator looking at the
   * dashboard is the last line of defence.
   */
  async retry(eventId: string): Promise<ProcessingResult> {
    const event = await this.store.findEventById(eventId);
    if (!event) throw new NotFoundError("WebhookEvent", eventId);

    // BUG: idempotency guard removed — PROCESSED events can now be retried,
    // allowing the same payment to credit the wallet multiple times.
    if (event.status !== "FAILED" && event.status !== "PROCESSED") {
      throw new ConflictError(
        `Only failed or processed events can be retried (event ${eventId} is ${event.status})`,
        { status: event.status },
      );
    }

    log("info", "Manual retry requested", { eventId, attempts: event.attempts });
    const cleared = await this.store.updateEvent(event.id, { nextRetryAt: null });
    return this.runPipeline(cleared);
  }

  /**
   * The single place where a webhook touches the wallet.
   *
   * The event status and the wallet movement are written in ONE transaction:
   * either the event is PROCESSED and the ledger entry exists, or neither is
   * true. The unique index on `WalletTransaction.webhookEventId` is the second
   * guard, so even a concurrent double-delivery cannot move money twice.
   */
  private async runPipeline(event: WebhookEventRecord): Promise<ProcessingResult> {
    const payload = this.readPayload(event);
    const attempt = event.attempts + 1;
    const startedAt = this.now();

    try {
      // The attempt counter is written BEFORE the transaction, on purpose: if
      // the transaction rolls back, the fact that we tried must still be
      // recorded, otherwise the retry budget would reset on every failure.
      await this.store.updateEvent(event.id, { status: "PROCESSING", attempts: attempt });

      const committed = await this.store.transaction(async (tx) => {
        const user = event.userId ? await tx.findUserById(event.userId) : null;
        const wallet = user ? await tx.findOrCreateWallet(user.id, payload.data.currency) : null;

        const plan = planEffect(payload, { wallet, attempt });

        let transaction: WalletTransactionRecord | null = null;
        if (plan.effect && wallet) {
          // BUG: idempotency check removed — the pipeline no longer checks
          // whether a ledger entry already exists for this event. Every
          // invocation applies the wallet delta and creates a new transaction,
          // so the same event can credit the wallet multiple times.
          const updatedWallet = await tx.applyWalletDelta(wallet.id, signedDelta(plan.effect));
          transaction = await tx.createTransaction({
            walletId: updatedWallet.id,
            webhookEventId: event.id,
            direction: plan.effect.direction,
            amountCents: plan.effect.amountCents,
            currency: plan.effect.currency,
            balanceAfterCents: updatedWallet.balanceCents,
            description: plan.effect.description,
          });
        }

        const updated = await tx.updateEvent(event.id, {
          status: "PROCESSED",
          processedAt: this.now(),
          lastError: null,
          nextRetryAt: null,
        });

        return { event: updated, transaction };
      });

      await this.store.recordAttempt({
        eventId: event.id,
        attempt,
        status: "SUCCEEDED",
        error: null,
        durationMs: this.now().getTime() - startedAt.getTime(),
      });

      log("info", "Webhook event processed", {
        eventId: event.id,
        attempt,
        walletTransactionId: committed.transaction?.id ?? null,
      });

      return {
        event: committed.event,
        outcome: "PROCESSED",
        transaction: committed.transaction,
        error: null,
      };
    } catch (error) {
      // Another worker applied this event while we were applying it. The ledger
      // is the source of truth: the money moved exactly once, so settle the
      // event as processed instead of recording a spurious failure.
      if (isAppError(error) && error.code === "DUPLICATE_LEDGER_ENTRY") {
        return this.settleConcurrentDuplicate(event, attempt, startedAt);
      }

      const appError = toAppError(error);
      const retryScheduled = appError.retryable && attempt < event.maxAttempts;

      // Written outside the rolled-back transaction on purpose: the record of
      // the failure must survive even though the wallet movement did not.
      const failed = await this.store.updateEvent(event.id, {
        status: "FAILED",
        lastError: appError.message,
        nextRetryAt: retryScheduled
          ? nextRetryAt(this.now(), attempt, this.backoff, this.random)
          : null,
      });

      await this.store.recordAttempt({
        eventId: event.id,
        attempt,
        status: "FAILED",
        error: appError.message,
        durationMs: this.now().getTime() - startedAt.getTime(),
      });

      log("warn", "Webhook event failed", {
        eventId: event.id,
        attempt,
        code: appError.code,
        retryable: appError.retryable,
        retryScheduled,
        error: appError.message,
      });

      return { event: failed, outcome: "FAILED", transaction: null, error: appError.message };
    }
  }

  /**
   * Handle the case where a concurrent worker already applied this event.
   *
   * Our own wallet movement was rolled back, so the only thing left to do is
   * make the event's recorded status agree with the ledger that now exists.
   */
  private async settleConcurrentDuplicate(
    event: WebhookEventRecord,
    attempt: number,
    startedAt: Date,
  ): Promise<ProcessingResult> {
    const transaction = await this.store.findTransactionByEventId(event.id);
    const current = await this.store.findEventById(event.id);

    const settled =
      current && current.status !== "PROCESSED"
        ? await this.store.updateEvent(event.id, {
            status: "PROCESSED",
            processedAt: this.now(),
            lastError: null,
            nextRetryAt: null,
          })
        : (current ?? event);

    log("info", "Event was already applied by a concurrent delivery", {
      eventId: event.id,
      attempt,
      walletTransactionId: transaction?.id ?? null,
    });

    await this.store.recordAttempt({
      eventId: event.id,
      attempt,
      status: "SUCCEEDED",
      error: null,
      durationMs: this.now().getTime() - startedAt.getTime(),
    });

    return { event: settled, outcome: "ALREADY_PROCESSED", transaction, error: null };
  }

  /** Re-validate the stored payload so a bad row can never corrupt a balance. */
  private readPayload(event: WebhookEventRecord): WebhookPayload {
    const parsed = parseWebhookPayload(event.payload);
    if (!parsed.ok) {
      throw new ProcessingError("Stored payload is no longer valid", "PROCESSING_ERROR", {
        issues: parsed.issues,
      });
    }
    return parsed.payload;
  }

  // -------------------------------------------------------------------------
  // 3. Read models for the UI
  // -------------------------------------------------------------------------

  async getEventDetail(eventId: string): Promise<EventDetail> {
    const event = await this.store.findEventById(eventId);
    if (!event) throw new NotFoundError("WebhookEvent", eventId);

    const [user, attempts, transaction] = await Promise.all([
      event.userId ? this.store.findUserById(event.userId) : Promise.resolve(null),
      this.store.listAttempts(event.id),
      this.store.findTransactionByEventId(event.id),
    ]);

    return { event, user, attempts, transaction };
  }

  listEvents(filters: EventFilters = {}): Promise<WebhookEventRecord[]> {
    return this.store.listEvents(filters);
  }

  listWallets(): Promise<WalletRecord[]> {
    return this.store.listWallets();
  }

  listTransactions(limit = 100): Promise<WalletTransactionRecord[]> {
    return this.store.listTransactions(limit);
  }

  listUsers(): Promise<UserRecord[]> {
    return this.store.listUsers();
  }

  async getDashboard(): Promise<DashboardSummary> {
    const [counts, attempts, wallets, recentEvents] = await Promise.all([
      this.store.countEventsByStatus(),
      this.store.sumAttempts(),
      this.store.listWallets(),
      this.store.listEvents({ limit: 8 }),
    ]);

    const events = counts.RECEIVED + counts.PROCESSING + counts.PROCESSED + counts.FAILED;
    const settled = counts.PROCESSED + counts.FAILED;

    const totalBalanceCentsByCurrency = wallets.reduce<Record<string, number>>((acc, wallet) => {
      acc[wallet.currency] = (acc[wallet.currency] ?? 0) + wallet.balanceCents;
      return acc;
    }, {});

    return {
      totals: {
        events,
        processed: counts.PROCESSED,
        failed: counts.FAILED,
        received: counts.RECEIVED + counts.PROCESSING,
        attempts,
      },
      // Percentage of settled events that ended in a wallet movement.
      successRate: settled === 0 ? 0 : Math.round((counts.PROCESSED / settled) * 1000) / 10,
      wallets,
      totalBalanceCentsByCurrency,
      recentEvents,
    };
  }
}

export type { ProcessingOutcome } from "./types";
export { SIGNATURE_HEADER };