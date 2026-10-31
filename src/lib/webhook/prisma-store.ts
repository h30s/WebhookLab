import { Prisma, type PrismaClient } from "@prisma/client";
import { NotFoundError } from "@/lib/errors";
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
 * PostgreSQL implementation of `WebhookStore` via Prisma.
 *
 * `transaction()` delegates to `prisma.$transaction`, so a callback receives a
 * client bound to one database transaction. If the callback throws, Prisma
 * rolls the whole thing back - which is what guarantees an event can never be
 * marked PROCESSED without its wallet movement also being committed.
 */

/** Prisma client or an interactive-transaction client. */
export type PrismaLike = PrismaClient | Prisma.TransactionClient;

type EventRow = {
  id: string;
  providerEventId: string;
  type: string;
  status: string;
  payload: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  userId: string | null;
  receivedAt: Date;
  processedAt: Date | null;
  nextRetryAt: Date | null;
};

/**
 * True for a Postgres unique-constraint violation (Prisma error code P2002).
 *
 * Checked structurally rather than with `instanceof`, so it still works if the
 * bundler loads this module more than once.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return candidate.code === "P2002" && String(candidate.name).includes("Prisma");
}

/** True when Prisma reported that the target row does not exist (code P2025). */
function isRecordNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return candidate.code === "P2025" && String(candidate.name).includes("Prisma");
}

function toEventRecord(row: EventRow): WebhookEventRecord {
  return {
    id: row.id,
    providerEventId: row.providerEventId,
    type: row.type,
    status: row.status as WebhookEventStatus,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    userId: row.userId,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
    nextRetryAt: row.nextRetryAt,
  };
}

export class PrismaWebhookStore implements WebhookStore {
  constructor(private readonly prisma: PrismaLike) {}

  private get db(): PrismaLike {
    return this.prisma;
  }

  // --- events -------------------------------------------------------------

  async findEventByProviderId(providerEventId: string): Promise<WebhookEventRecord | null> {
    const row = await this.db.webhookEvent.findFirst({
      where: { providerEventId },
      orderBy: { receivedAt: "asc" },
    });
    return row ? toEventRecord(row) : null;
  }

  async findEventById(id: string): Promise<WebhookEventRecord | null> {
    const row = await this.db.webhookEvent.findUnique({ where: { id } });
    return row ? toEventRecord(row) : null;
  }

  async listEvents(filters: EventFilters = {}): Promise<WebhookEventRecord[]> {
    const rows = await this.db.webhookEvent.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.type ? { type: filters.type } : {}),
      },
      orderBy: { receivedAt: "desc" },
      take: filters.limit ?? 100,
    });
    return rows.map(toEventRecord);
  }

  async createEvent(input: CreateEventInput): Promise<WebhookEventRecord> {
    const row = await this.db.webhookEvent.create({
      data: {
        providerEventId: input.providerEventId,
        type: input.type,
        payload: input.payload as Prisma.InputJsonValue,
        userId: input.userId,
        maxAttempts: input.maxAttempts,
        receivedAt: input.receivedAt,
      },
    });
    return toEventRecord(row);
  }

  async updateEvent(id: string, patch: UpdateEventInput): Promise<WebhookEventRecord> {
    try {
      const row = await this.db.webhookEvent.update({ where: { id }, data: patch });
      return toEventRecord(row);
    } catch (error) {
      if (isRecordNotFound(error)) {
        throw new NotFoundError("WebhookEvent", id);
      }
      throw error;
    }
  }

  async countEventsByStatus(): Promise<Record<WebhookEventStatus, number>> {
    const grouped = await this.db.webhookEvent.groupBy({ by: ["status"], _count: { _all: true } });
    const counts: Record<WebhookEventStatus, number> = {
      RECEIVED: 0,
      PROCESSING: 0,
      PROCESSED: 0,
      FAILED: 0,
    };
    for (const group of grouped) {
      counts[group.status as WebhookEventStatus] = group._count._all;
    }
    return counts;
  }

  async sumAttempts(): Promise<number> {
    const result = await this.db.webhookEvent.aggregate({ _sum: { attempts: true } });
    return result._sum.attempts ?? 0;
  }

  // --- attempts -----------------------------------------------------------

  async recordAttempt(input: RecordAttemptInput): Promise<WebhookAttemptRecord> {
    try {
      const row = await this.db.webhookAttempt.create({
        data: {
          eventId: input.eventId,
          attempt: input.attempt,
          status: input.status,
          error: input.error,
          durationMs: input.durationMs,
        },
      });
      return { ...row, status: row.status as WebhookAttemptRecord["status"] };
    } catch (error) {
      // A duplicate attempt number means another worker logged this same
      // attempt concurrently. The audit log must not break the pipeline, so
      // return the row that is already there.
      if (isUniqueViolation(error)) {
        const existing = await this.db.webhookAttempt.findUnique({
          where: { eventId_attempt: { eventId: input.eventId, attempt: input.attempt } },
        });
        if (existing) return { ...existing, status: existing.status as WebhookAttemptRecord["status"] };
      }
      throw error;
    }
  }

  async listAttempts(eventId: string): Promise<WebhookAttemptRecord[]> {
    const rows = await this.db.webhookAttempt.findMany({
      where: { eventId },
      orderBy: { attempt: "asc" },
    });
    return rows.map((row) => ({ ...row, status: row.status as WebhookAttemptRecord["status"] }));
  }

  // --- users / wallets / ledger ------------------------------------------

  async upsertUser(input: { email: string; name?: string }): Promise<UserRecord> {
    return this.db.user.upsert({
      where: { email: input.email },
      update: input.name ? { name: input.name } : {},
      create: { email: input.email, name: input.name ?? input.email.split("@")[0] },
    });
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    return this.db.user.findUnique({ where: { id } });
  }

  async listUsers(): Promise<UserRecord[]> {
    return this.db.user.findMany({ orderBy: { email: "asc" } });
  }

  async findOrCreateWallet(userId: string, currency: string): Promise<WalletRecord> {
    return this.db.wallet.upsert({
      where: { userId_currency: { userId, currency } },
      update: {},
      create: { userId, currency },
    });
  }

  async findWallet(userId: string, currency: string): Promise<WalletRecord | null> {
    return this.db.wallet.findUnique({ where: { userId_currency: { userId, currency } } });
  }

  async findWalletById(id: string): Promise<WalletRecord | null> {
    return this.db.wallet.findUnique({ where: { id } });
  }

  async applyWalletDelta(walletId: string, deltaCents: number): Promise<WalletRecord> {
    try {
      // `increment` is an atomic read-modify-write in SQL, so concurrent
      // deliveries cannot lose an update.
      return await this.db.wallet.update({
        where: { id: walletId },
        data: { balanceCents: { increment: deltaCents } },
      });
    } catch (error) {
      if (isRecordNotFound(error)) {
        throw new NotFoundError("Wallet", walletId);
      }
      throw error;
    }
  }

  async listWallets(): Promise<WalletRecord[]> {
    return this.db.wallet.findMany({ orderBy: [{ currency: "asc" }, { createdAt: "asc" }] });
  }

  async createTransaction(input: CreateTransactionInput): Promise<WalletTransactionRecord> {
    // BUG: duplicate-ledger-entry guard removed. The unique constraint on
    // webhookEventId no longer exists, so the same event can create multiple
    // ledger entries and credit the wallet more than once.
    return this.db.walletTransaction.create({ data: input });
  }

  async findTransactionByEventId(webhookEventId: string): Promise<WalletTransactionRecord | null> {
    // BUG: findUnique replaced with findFirst because webhookEventId is no
    // longer a unique column.
    return this.db.walletTransaction.findFirst({ where: { webhookEventId } });
  }

  async listTransactions(limit = 100): Promise<WalletTransactionRecord[]> {
    return this.db.walletTransaction.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  // --- atomicity ----------------------------------------------------------

  async transaction<T>(fn: (tx: WebhookStore) => Promise<T>): Promise<T> {
    // A nested call (already inside a transaction client) just runs inline.
    if (!("$transaction" in this.prisma)) {
      return fn(this);
    }
    return this.prisma.$transaction(async (tx) => fn(new PrismaWebhookStore(tx)));
  }
}