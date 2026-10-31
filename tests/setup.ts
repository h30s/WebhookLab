/**
 * Load `.env` for the test run.
 *
 * Next.js reads `.env` itself, but Vitest does not. Loading it here means the
 * PostgreSQL integration test picks up DATABASE_URL when one is configured,
 * and skips cleanly when it is not.
 */

import { existsSync } from "node:fs";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}