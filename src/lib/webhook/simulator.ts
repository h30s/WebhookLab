import { z } from "zod";
import { WEBHOOK_EVENT_TYPES } from "./types";
import type { WebhookPayload } from "./schema";

/**
 * The in-app simulator.
 *
 * It plays the part of the payment provider: it builds a provider-shaped
 * payload and signs it with the same secret the receiver verifies, so
 * simulated deliveries travel the identical code path as a real one.
 */

export const simulatorInputSchema = z.object({
  type: z.enum(WEBHOOK_EVENT_TYPES),
  email: z.string().email("A valid email is required"),
  name: z.string().min(1).optional(),
  amountCents: z.coerce.number().int().positive("Amount must be greater than 0"),
  currency: z
    .string()
    .length(3, "Currency must be a 3-letter code")
    .transform((value) => value.toUpperCase()),
  reference: z.string().min(1).optional(),
  /** Failure injection, so retries can be demonstrated on purpose. */
  simulate: z.enum(["none", "transient_error", "permanent_error"]).default("none"),
  /** Re-use a previous event id to demonstrate duplicate detection. */
  providerEventId: z.string().min(1).optional(),
});

export type SimulatorInput = z.infer<typeof simulatorInputSchema>;

export interface BuildPayloadOptions {
  now?: Date;
  /** Injectable so tests and the demo can produce deterministic ids. */
  idFactory?: () => string;
}

export function defaultEventId(): string {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Turn simulator form input into a provider-shaped webhook payload. */
export function buildProviderPayload(
  input: SimulatorInput,
  options: BuildPayloadOptions = {},
): WebhookPayload {
  const now = options.now ?? new Date();
  const idFactory = options.idFactory ?? defaultEventId;

  return {
    id: input.providerEventId ?? idFactory(),
    type: input.type,
    created: Math.floor(now.getTime() / 1000),
    data: {
      user: { email: input.email, ...(input.name ? { name: input.name } : {}) },
      amountCents: input.amountCents,
      currency: input.currency,
      ...(input.reference ? { reference: input.reference } : {}),
      ...(input.simulate === "none" ? {} : { simulate: input.simulate }),
    },
  } as WebhookPayload;
}