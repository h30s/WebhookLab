import { DuplicateLedgerEntryError, NotFoundError } from "@/lib/errors";
import { applyWalletDelta as applyDelta } from "./balance";
import type {
  CreateEventInput,
  CreateTransactionInput,
  RecordAttemptInput,
  UpdateEventInput,
  WebhookStore,
} from "./store";
import type {
  EventFilters,
  UserRecord,
  WalletRecord,
  WalletTransactionRecord,
  WebhookAttemptRecord,
  WebhookEventRecord,
  WebhookEventStatus,
} from "./types";

/**
 * In-memory implementation of `WebhookStore`.
 *
 * Used by the automated tests and by demo mode when no `DATABASE_URL` is
 * configured. It is deliberately faithful to the PostgreSQL implementation in
 * the two ways that matter to the service:
 *
 *  1. `transaction()` really rolls back, and it cannot damage work committed by
 *     another transaction.
 *  2. Every method returns a *detached copy*, exactly like Prisma does, so
 *     callers cannot accidentally observe later mutations.
 */

interface State {
  users: UserRecord[];
  wallets: WalletRecord[];
  events: WebhookEventRecord[];
  attempts: WebhookAttemptRecord[];
  transactions: WalletTransactionRecord[];
}

export interface InMemoryStoreOptions {
  /** Seed data, mainly to make demo mode feel populated. */
  seed?: Partial<State>;
  idFactory?: () => string;
}

let fallbackIdCounter = 0;

function defaultId(prefix: string): string {
  fallbackIdCounter += 1;
  return `${prefix}_${fallbackIdCounter.toString().padStart(4, "0")}`;
}

/** Copy just the listed keys, to remember a row's previous values. */
function pick<T extends object>(source: T, keys: string[]): Partial<T> {
  const result: Partial<T> = {};
  for (const key of keys as Array<keyof T>) result[key] = source[key];
  return result;
}

export class InMemoryWebhookStore implements WebhookStore {
  private state: State;
  private idFactory: () => string;

  constructor(options: InMemoryStoreOptions = {}) {
    this.state = {
      users: options.seed?.users ? options.seed.users.map((row) => ({ ...row })) : [],
      wallets: options.seed?.wallets ? options.seed.wallets.map((row) => ({ ...row })) : [],
      events: options.seed?.events ? options.seed.events.map((row) => ({ ...row })) : [],
      attempts: options.seed?.attempts ? options.seed.attempts.map((row) => ({ ...row })) : [],
      transactions: options.seed?.transactions ? options.seed.transactions.map((row) => ({ ...row })) : [],
    };
    this.idFactory = options.idFactory ?? (() => defaultId("mem"));
  }

  private nextId(prefix: string): string {
    return this.idFactory() || defaultId(prefix);
  }

  // --- ordering -----------------------------------------------------------

  /**
   * Insertion order, used as a tiebreaker when sorting.
   *
   * Timestamps only have millisecond resolution, so rows written inside the
   * same millisecond would otherwise come back in an arbitrary order. A real
   * database orders by its serial primary key in exactly this situation.
   */
  private sequence = 0;
  private readonly sequences = new Map<string, number>();

  private stamp(id: string): void {
    this.sequence += 1;
    this.sequences.set(id, this.sequence);
  }

  private sequenceOf(id: string): number {
    return this.sequences.get(id) ?? 0;
  }

  /** Newest first, falling back to insertion order for equal timestamps. */
  private newestFirst<T extends { id: string }>(dateOf: (row: T) => Date) {
    return (a: T, b: T): number =>
      dateOf(b).getTime() - dateOf(a).getTime() || this.sequenceOf(b.id) - this.sequenceOf(a.id);
  }

  /** Test helper: read a copy of the whole state. */
  snapshot(): State {
    return {
      users: this.state.users.map((row) => ({ ...row })),
      wallets: this.state.wallets.map((row) => ({ ...row })),
      events: this.state.events.map((row) => ({ ...row })),
      attempts: this.state.attempts.map((row) => ({ ...row })),
      transactions: this.state.transactions.map((row) => ({ ...row })),
    };
  }

  // --- transaction support ------------------------------------------------

  /**
   * Undo actions for the transaction in flight, or null when none is open.
   *
   * Rollback replays these instead of restoring a whole-state snapshot: a
   * snapshot would also discard writes committed by a *different* transaction
   * that happened to overlap this one, which no real database would do.
   */
  private undoLog: Array<() => void> | null = null;

  /** Serialises transactions; see `transaction()`. */
  private lock: Promise<void> = Promise.resolve();

  private onRollback(undo: () => void): void {
    this.undoLog?.push(undo);
  }

  /** Register an undo that removes a row this transaction inserted. */
  private undoCannotInsert<T>(list: T[], row: T): void {
    this.onRollback(() => {
      const index = list.indexOf(row);
      if (index >= 0) list.splice(index, 1);
    });
  }

  async transaction<T>(fn: (tx: WebhookStore) => Promise<T>): Promise<T> {
    // A nested call joins the transaction already in flight, mirroring how
    // Prisma's interactive transactions behave.
    if (this.undoLog) return fn(this);

    // Transactions are serialised. PostgreSQL achieves the same effect with
    // row locks, which is what stops two concurrent deliveries from both
    // applying their delta to the same balance; here one transaction simply
    // waits for the previous one to finish.
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    const undoLog: Array<() => void> = [];
    this.undoLog = undoLog;
    try {
      return await fn(this);
    } catch (error) {
      // Reverse order, so dependent writes are undone before their parents.
      for (const undo of undoLog.reverse()) undo();
      throw error;
    } finally {
      this.undoLog = null;
      release();
    }
  }

  // --- events -------------------------------------------------------------

  async findEventByProviderId(providerEventId: string): Promise<WebhookEventRecord | null> {
    const row = this.state.events.find((event) => event.providerEventId === providerEventId);
    return row ? { ...row } : null;
  }

  async findEventById(id: string): Promise<WebhookEventRecord | null> {
    const row = this.state.events.find((event) => event.id === id);
    return row ? { ...row } : null;
  }

  async listEvents(filters: EventFilters = {}): Promise<WebhookEventRecord[]> {
    return this.state.events
      .filter((row) => (filters.status ? row.status === filters.status : true))
      .filter((row) => (filters.type ? row.type === filters.type : true))
      .sort(this.newestFirst<WebhookEventRecord>((row) => row.receivedAt))
      .slice(0, filters.limit ?? 100)
      .map((row) => ({ ...row }));
  }

  async createEvent(input: CreateEventInput): Promise<WebhookEventRecord> {
    const event: WebhookEventRecord = {
      id: this.nextId("evt"),
      providerEventId: input.providerEventId,
      type: input.type,
      status: "RECEIVED",
      payload: input.payload,
      attempts: 0,
      maxAttempts: input.maxAttempts,
      lastError: null,
      userId: input.userId,
      receivedAt: input.receivedAt,
      processedAt: null,
      nextRetryAt: null,
    };
    this.stamp(event.id);
    this.state.events.push(event);
    this.undoCannotInsert(this.state.events, event);
    return { ...event };
  }

  async updateEvent(id: string, patch: UpdateEventInput): Promise<WebhookEventRecord> {
    const event = this.state.events.find((row) => row.id === id);
    if (!event) throw new NotFoundError("WebhookEvent", id);

    const previous = pick(event, Object.keys(patch));
    Object.assign(event, patch);
    // Restore only the fields this call changed, so a concurrent transaction's
    // writes to other fields survive our rollback.
    this.onRollback(() => Object.assign(event, previous));
    return { ...event };
  }

  async countEventsByStatus(): Promise<Record<WebhookEventStatus, number>> {
    const counts: Record<WebhookEventStatus, number> = {
      RECEIVED: 0,
      PROCESSING: 0,
      PROCESSED: 0,
      FAILED: 0,
    };
    for (const event of this.state.events) counts[event.status] += 1;
    return counts;
  }

  async sumAttempts(): Promise<number> {
    return this.state.events.reduce((total, event) => total + event.attempts, 0);
  }

  // --- attempts -----------------------------------------------------------

  async recordAttempt(input: RecordAttemptInput): Promise<WebhookAttemptRecord> {
    const attempt: WebhookAttemptRecord = {
      id: this.nextId("att"),
      eventId: input.eventId,
      attempt: input.attempt,
      status: input.status,
      error: input.error,
      durationMs: input.durationMs,
      createdAt: new Date(),
    };
    this.stamp(attempt.id);
    this.state.attempts.push(attempt);
    this.undoCannotInsert(this.state.attempts, attempt);
    return { ...attempt };
  }

  async listAttempts(eventId: string): Promise<WebhookAttemptRecord[]> {
    return this.state.attempts
      .filter((row) => row.eventId === eventId)
      .sort((a, b) => a.attempt - b.attempt || this.sequenceOf(a.id) - this.sequenceOf(b.id))
      .map((row) => ({ ...row }));
  }

  // --- users / wallets / ledger ------------------------------------------

  async upsertUser(input: { email: string; name?: string }): Promise<UserRecord> {
    const existing = this.state.users.find((row) => row.email === input.email);
    if (existing) {
      if (input.name && input.name !== existing.name) {
        const previousName = existing.name;
        existing.name = input.name;
        this.onRollback(() => {
          existing.name = previousName;
        });
      }
      return { ...existing };
    }

    const user: UserRecord = {
      id: this.nextId("usr"),
      email: input.email,
      name: input.name ?? input.email.split("@")[0],
      createdAt: new Date(),
    };
    this.state.users.push(user);
    this.undoCannotInsert(this.state.users, user);
    return { ...user };
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const row = this.state.users.find((user) => user.id === id);
    return row ? { ...row } : null;
  }

  async listUsers(): Promise<UserRecord[]> {
    return [...this.state.users].sort((a, b) => a.email.localeCompare(b.email)).map((row) => ({ ...row }));
  }

  async findOrCreateWallet(userId: string, currency: string): Promise<WalletRecord> {
    const existing = this.state.wallets.find((row) => row.userId === userId && row.currency === currency);
    if (existing) return { ...existing };

    const wallet: WalletRecord = {
      id: this.nextId("wal"),
      userId,
      currency,
      balanceCents: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.state.wallets.push(wallet);
    this.undoCannotInsert(this.state.wallets, wallet);
    return { ...wallet };
  }

  async findWallet(userId: string, currency: string): Promise<WalletRecord | null> {
    const row = this.state.wallets.find((wallet) => wallet.userId === userId && wallet.currency === currency);
    return row ? { ...row } : null;
  }

  async findWalletById(id: string): Promise<WalletRecord | null> {
    const row = this.state.wallets.find((wallet) => wallet.id === id);
    return row ? { ...row } : null;
  }

  async applyWalletDelta(walletId: string, deltaCents: number): Promise<WalletRecord> {
    const wallet = this.state.wallets.find((row) => row.id === walletId);
    if (!wallet) throw new NotFoundError("Wallet", walletId);

    const previous = { balanceCents: wallet.balanceCents, updatedAt: wallet.updatedAt };
    wallet.balanceCents = applyDelta(wallet.balanceCents, deltaCents);
    wallet.updatedAt = new Date();
    this.onRollback(() => {
      wallet.balanceCents = previous.balanceCents;
      wallet.updatedAt = previous.updatedAt;
    });
    return { ...wallet };
  }

  async listWallets(): Promise<WalletRecord[]> {
    return [...this.state.wallets]
      .sort((a, b) => a.currency.localeCompare(b.currency))
      .map((row) => ({ ...row }));
  }

  async createTransaction(input: CreateTransactionInput): Promise<WalletTransactionRecord> {
    if (
      input.webhookEventId &&
      this.state.transactions.some((row) => row.webhookEventId === input.webhookEventId)
    ) {
      // Mirrors the unique index on WalletTransaction.webhookEventId.
      throw new DuplicateLedgerEntryError(input.webhookEventId);
    }

    const transaction: WalletTransactionRecord = {
      id: this.nextId("txn"),
      walletId: input.walletId,
      webhookEventId: input.webhookEventId,
      direction: input.direction,
      amountCents: input.amountCents,
      currency: input.currency,
      balanceAfterCents: input.balanceAfterCents,
      description: input.description,
      createdAt: new Date(),
    };
    this.stamp(transaction.id);
    this.state.transactions.push(transaction);
    this.undoCannotInsert(this.state.transactions, transaction);
    return { ...transaction };
  }

  async findTransactionByEventId(webhookEventId: string): Promise<WalletTransactionRecord | null> {
    const row = this.state.transactions.find((entry) => entry.webhookEventId === webhookEventId);
    return row ? { ...row } : null;
  }

  async listTransactions(limit = 100): Promise<WalletTransactionRecord[]> {
    return [...this.state.transactions]
      .sort(this.newestFirst<WalletTransactionRecord>((row) => row.createdAt))
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }
}