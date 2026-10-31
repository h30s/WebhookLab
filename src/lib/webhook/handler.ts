import { InsufficientFundsError, ProcessingError, TransientProcessingError } from "@/lib/errors";
import type { WebhookPayload } from "./schema";
import type { WalletEffect, WalletRecord } from "./types";

/**
 * The pure heart of the pipeline.
 *
 * `planEffect` turns a validated webhook into the wallet movement it implies.
 * It touches no database, no clock and no network, which makes every rule
 * here testable in isolation. Side effects are applied by the service inside a
 * transaction.
 */

export interface PlanContext {
  /** Wallet for the event's user + currency, if one already exists. */
  wallet: WalletRecord | null;
  /**
   * 1 for the first delivery, 2 for the first retry, and so on. The simulator
   * uses it so a transient fault clears after the first attempt - which is
   * what makes "fail once, then succeed on manual retry" demonstrable.
   */
  attempt: number;
}

export interface PlanResult {
  /** `null` means "handled, no money moves" - a successful outcome. */
  effect: WalletEffect | null;
  description: string;
}

export function planEffect(payload: WebhookPayload, context: PlanContext = { wallet: null, attempt: 1 }): PlanResult {
  const { type, data } = payload;

  // Explicit failure injection for the simulator. Runs before any business
  // rule so retries can be demonstrated deterministically.
  if (data.simulate === "transient_error" && context.attempt === 1) {
    throw new TransientProcessingError("Simulated upstream timeout while applying the event");
  }
  if (data.simulate === "permanent_error") {
    throw new ProcessingError("Simulated permanent failure: the event can never be applied");
  }

  const base = {
    amountCents: data.amountCents,
    currency: data.currency,
  };

  switch (type) {
    case "payment.succeeded":
      return {
        effect: { ...base, direction: "CREDIT", description: describe("Payment received", data.reference) },
        description: "Credited wallet",
      };

    case "payment.refunded": {
      const available = context.wallet?.balanceCents ?? 0;
      if (available < data.amountCents) {
        throw new InsufficientFundsError(available, data.amountCents);
      }
      return {
        effect: { ...base, direction: "DEBIT", description: describe("Refund issued", data.reference) },
        description: "Debited wallet",
      };
    }

    case "payment.failed":
      // A declined payment carries no money movement, but the event was still
      // handled correctly. Recorded, not retried.
      return { effect: null, description: "Recorded a failed payment (no wallet movement)" };

    default: {
      const exhaustive: never = type;
      throw new ProcessingError(`Unsupported event type: ${String(exhaustive)}`);
    }
  }
}

function describe(prefix: string, reference?: string): string {
  return reference ? `${prefix} (${reference})` : prefix;
}

/** Signed amount a wallet effect moves. Credits are positive, debits negative. */
export function signedDelta(effect: WalletEffect): number {
  return effect.direction === "CREDIT" ? effect.amountCents : -effect.amountCents;
}