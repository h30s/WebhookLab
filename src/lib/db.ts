import type { PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";

/**
 * Prisma client singleton.
 *
 * Next.js reloads modules in development, so the client is cached on
 * `globalThis` to avoid exhausting the connection pool.
 */

const globalForPrisma = globalThis as unknown as { __webhookLabPrisma?: PrismaClient };

/**
 * Create (or reuse) the Prisma client.
 *
 * The import is dynamic and guarded: if `prisma generate` has not been run yet
 * the app falls back to the in-memory store instead of crashing on boot.
 */
export async function getPrismaClient(): Promise<PrismaClient | null> {
  if (!env.databaseUrl) return null;
  if (globalForPrisma.__webhookLabPrisma) return globalForPrisma.__webhookLabPrisma;

  try {
    const { PrismaClient: Client } = await import("@prisma/client");
    const client = new Client({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
    globalForPrisma.__webhookLabPrisma = client;
    return client;
  } catch (error) {
    log("error", "Could not initialise the Prisma client; falling back to the in-memory store", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}