/** Domain types shared by the processing engine, the API routes and the UI. */

export const WEBHOOK_EVENT_TYPES = [
  "payment.succeeded",
  "payment.failed",
  "payment.refunded",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_EVENT_STATUSES = ["RECEIVED", "PROCESSING", "PROCESSED", "FAILED"] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

export const ATTEMPT_STATUSES = ["SUCCEEDED", "FAILED"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export type TransactionDirection = "CREDIT" | "DEBIT";

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

export interface WalletRecord {
  id: string;
  userId: string;
  currency: string;
  balanceCents: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookEventRecord {
  id: string;
  providerEventId: string;
  type: string;
  status: WebhookEventStatus;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  userId: string | null;
  receivedAt: Date;
  processedAt: Date | null;
  nextRetryAt: Date | null;
}

export interface WebhookAttemptRecord {
  id: string;
  eventId: string;
  attempt: number;
  status: AttemptStatus;
  error: string | null;
  durationMs: number;
  createdAt: Date;
}

export interface WalletTransactionRecord {
  id: string;
  walletId: string;
  webhookEventId: string | null;
  direction: TransactionDirection;
  amountCents: number;
  currency: string;
  balanceAfterCents: number;
  description: string;
  createdAt: Date;
}

/**
 * The instruction produced by the pure event handler.
 *
 * `null` means "this event carries no wallet movement" (for example a failed
 * payment), which is a perfectly successful outcome.
 */
export interface WalletEffect {
  direction: TransactionDirection;
  amountCents: number;
  currency: string;
  description: string;
}

export interface EventWithRelations extends WebhookEventRecord {
  user: UserRecord | null;
  wallet: WalletRecord | null;
}

export interface TransactionWithRelations extends WalletTransactionRecord {
  wallet: WalletRecord;
  webhookEvent: WebhookEventRecord | null;
}

export interface EventFilters {
  status?: WebhookEventStatus;
  type?: string;
  limit?: number;
}

export interface DashboardSummary {
  totals: {
    events: number;
    processed: number;
    failed: number;
    received: number;
    attempts: number;
  };
  successRate: number;
  wallets: WalletRecord[];
  totalBalanceCentsByCurrency: Record<string, number>;
  recentEvents: WebhookEventRecord[];
}

/** Result of receiving one webhook delivery. */
export interface ReceiveResult {
  event: WebhookEventRecord;
  /** True when this provider event id had already been received. */
  duplicate: boolean;
  /** True when this call ran the processing pipeline. */
  processed: boolean;
}

/** How a single run of the processing pipeline ended. */
export type ProcessingOutcome = "PROCESSED" | "FAILED" | "ALREADY_PROCESSED";

export interface ProcessingResult {
  /** The event as it now stands in the database. */
  event: WebhookEventRecord;
  outcome: ProcessingOutcome;
  /** The ledger entry written, when the event moved money. */
  transaction: WalletTransactionRecord | null;
  /** Human-readable failure reason, when the attempt failed. */
  error: string | null;
}