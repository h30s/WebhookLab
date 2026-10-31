import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature verification (HMAC-SHA256 over the raw request body).
 *
 * Pure and dependency-free so it can be unit tested without a database or a
 * running server. The header format mirrors Stripe's:
 *
 *   x-webhook-signature: t=<unix seconds>,v1=<hex digest>
 */

export const SIGNATURE_HEADER = "x-webhook-signature";

export interface ParsedSignature {
  timestamp: number;
  signature: string;
}

export function signPayload(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function parseSignatureHeader(header: string): ParsedSignature | null {
  const parts = header.split(",").reduce<Record<string, string>>((acc, part) => {
    const [key, value] = part.split("=");
    if (key && value) acc[key.trim()] = value.trim();
    return acc;
  }, {});

  const timestamp = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(timestamp)) return null;
  return { timestamp, signature: parts.v1 };
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export interface VerifyOptions {
  /** Reject payloads older than this many seconds (replay protection). 0 disables the check. */
  toleranceSeconds?: number;
  /** Injectable clock so tests are not time dependent. */
  now?: () => number;
}

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: "missing_header" | "malformed_header" | "timestamp_out_of_tolerance" | "signature_mismatch" };

export function verifySignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
  options: VerifyOptions = {},
): VerifyResult {
  if (!header) return { valid: false, reason: "missing_header" };

  const parsed = parseSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  const tolerance = options.toleranceSeconds ?? 300;
  if (tolerance > 0) {
    const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
    if (Math.abs(now - parsed.timestamp) > tolerance) {
      return { valid: false, reason: "timestamp_out_of_tolerance" };
    }
  }

  const expected = createHmac("sha256", secret).update(`${parsed.timestamp}.${rawBody}`).digest("hex");
  if (!safeEqual(expected, parsed.signature)) return { valid: false, reason: "signature_mismatch" };

  return { valid: true };
}