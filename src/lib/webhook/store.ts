import type {
  AttemptStatus,
  EventFilters,
  TransactionDirection,
  UserRecord,
  WalletRecord,
  WalletTransactionRecord,
  WebhookAttemptRecord,
  WebhookEventRecord,
  WebhookEventStatus,
} from "./types";

/**
 * The persistence boundary.
 *
 * Everything above this interface (the service, the API routes, the UI) is
 * storage-agnostic. Two implementations exist:
 *
 *  - `PrismaWebhookStore`  - PostgreSQL, used in production.
 *  - `InMemoryWebhookStore` - used by tests and by demo mode.
 *
 * `transaction()` hands the callback a store bound to a database transaction,
 * so the service can write an event status and its wallet movement atomically.
 */

export interface CreateEventInput {
  providerEventId: string;
  type: string;
  payload: Record<string, unknown>;
  userId: string | null;
  maxAttempts: number;
  receivedAt: Date;
}

export interface UpdateEventInput {
  status?: WebhookEventStatus;
  attempts?: number;
  lastError?: string | null;
  processedAt?: Date | null;
  nextRetryAt?: Date | null;
  userId?: string | null;
}

export interface CreateTransactionInput {
  walletId: string;
  webhookEventId: string | null;
  direction: TransactionDirection;
  amountCents: number;
  currency: string;
  balanceAfterCents: number;
  description: string;
}

export interface RecordAttemptInput {
  eventId: string;
  attempt: number;
  status: AttemptStatus;
  error: string | null;
  durationMs: number;
}

export interface WebhookStore {
  // --- webhook events -----------------------------------------------------
  findEventByProviderId(providerEventId: string): Promise<WebhookEventRecord | null>;
  findEventById(id: string): Promise<WebhookEventRecord | null>;
  listEvents(filters?: EventFilters): Promise<WebhookEventRecord[]>;
  createEvent(input: CreateEventInput): Promise<WebhookEventRecord>;
  updateEvent(id: string, patch: UpdateEventInput): Promise<WebhookEventRecord>;
  countEventsByStatus(): Promise<Record<WebhookEventStatus, number>>;
  sumAttempts(): Promise<number>;

  // --- attempt log --------------------------------------------------------
  recordAttempt(input: RecordAttemptInput): Promise<WebhookAttemptRecord>;
  listAttempts(eventId: string): Promise<WebhookAttemptRecord[]>;

  // --- users, wallets, ledger --------------------------------------------
  upsertUser(input: { email: string; name?: string }): Promise<UserRecord>;
  findUserById(id: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  findOrCreateWallet(userId: string, currency: string): Promise<WalletRecord>;
  findWallet(userId: string, currency: string): Promise<WalletRecord | null>;
  /** Atomically adds `deltaCents` and returns the wallet with its new balance. */
  applyWalletDelta(walletId: string, deltaCents: number): Promise<WalletRecord>;
  listWallets(): Promise<WalletRecord[]>;
  findWalletById(id: string): Promise<WalletRecord | null>;
  createTransaction(input: CreateTransactionInput): Promise<WalletTransactionRecord>;
  findTransactionByEventId(webhookEventId: string): Promise<WalletTransactionRecord | null>;
  listTransactions(limit?: number): Promise<WalletTransactionRecord[]>;

  // --- atomicity ----------------------------------------------------------
  transaction<T>(fn: (tx: WebhookStore) => Promise<T>): Promise<T>;
}
