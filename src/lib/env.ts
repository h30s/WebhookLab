/** Server-side configuration, read once and validated. */

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const env = {
  /**
   * When unset, WebhookLab runs in demo mode with an in-memory store.
   * See the README for what that does and does not persist.
   */
  databaseUrl: process.env.DATABASE_URL?.trim() || null,

  /** When set, incoming webhooks must carry a valid `x-webhook-signature`. */
  signingSecret: process.env.WEBHOOK_SIGNING_SECRET?.trim() || null,

  maxAttempts: parsePositiveInt(process.env.WEBHOOK_MAX_ATTEMPTS, 3),

  /** Base delay for exponential retry backoff, in milliseconds. */
  backoffBaseDelayMs: parsePositiveInt(process.env.WEBHOOK_BACKOFF_BASE_MS, 5_000),
};

export type StoreMode = "postgres" | "memory";