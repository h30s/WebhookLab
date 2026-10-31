import { env, type StoreMode } from "@/lib/env";
import { log } from "@/lib/logger";
import { getPrismaClient } from "@/lib/db";
import { InMemoryWebhookStore } from "./memory-store";
import { PrismaWebhookStore } from "./prisma-store";
import { WebhookService, type WebhookServiceOptions } from "./service";
import type { WebhookStore } from "./store";

/**
 * Composition root.
 *
 * The API routes and server components never construct a store or a service
 * themselves; they ask for one here. That keeps the choice of persistence in
 * exactly one place and lets the tests swap in an in-memory store.
 */

export interface CreateStoreResult {
  store: WebhookStore;
  mode: StoreMode;
}

export async function createStore(): Promise<CreateStoreResult> {
  const prisma = await getPrismaClient();
  if (prisma) return { store: new PrismaWebhookStore(prisma), mode: "postgres" };

  log("warn", "No DATABASE_URL (or Prisma client unavailable) - using the in-memory demo store");
  return { store: new InMemoryWebhookStore(), mode: "memory" };
}

/** Build a service around an explicit store. Used by tests and by seeding. */
export function createWebhookService(
  store: WebhookStore,
  overrides: Partial<WebhookServiceOptions> = {},
): WebhookService {
  return new WebhookService({
    store,
    maxAttempts: env.maxAttempts,
    signingSecret: env.signingSecret,
    backoff: {
      baseDelayMs: env.backoffBaseDelayMs,
      factor: 2,
      maxDelayMs: 300_000,
      jitterRatio: 0,
    },
    ...overrides,
  });
}

/**
 * The service used by the running application.
 *
 * The holder lives on `globalThis` rather than in a module-level variable:
 * Next.js bundles each route and page separately, so a plain module variable
 * would give every route its own in-memory store and the demo would appear to
 * lose its data whenever you navigated. This is the same reason the Prisma
 * client is cached on `globalThis`.
 */
interface Container {
  pending: Promise<{ service: WebhookService; mode: StoreMode }> | null;
  override: WebhookService | null;
}

const globalForContainer = globalThis as unknown as { __webhookLabContainer?: Container };

function container(): Container {
  if (!globalForContainer.__webhookLabContainer) {
    globalForContainer.__webhookLabContainer = { pending: null, override: null };
  }
  return globalForContainer.__webhookLabContainer;
}

export function getWebhookService(): Promise<{ service: WebhookService; mode: StoreMode }> {
  const state = container();
  if (state.override) return Promise.resolve({ service: state.override, mode: "memory" });

  if (!state.pending) {
    state.pending = createStore().then(({ store, mode }) => ({
      service: createWebhookService(store),
      mode,
    }));
  }
  return state.pending;
}

/** Test hook: inject a service (for example one backed by an in-memory store). */
export function setWebhookService(service: WebhookService | null): void {
  const state = container();
  state.override = service;
  state.pending = null;
}

export { WebhookService } from "./service";
export { InMemoryWebhookStore } from "./memory-store";
export { PrismaWebhookStore } from "./prisma-store";
export * from "./types";