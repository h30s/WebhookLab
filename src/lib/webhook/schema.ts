import { z } from "zod";
import { WEBHOOK_EVENT_TYPES } from "./types";

/**
 * Wire format of an incoming payment webhook.
 *
 * This is the boundary between "untrusted JSON off the network" and the typed
 * domain, so it is validated exactly once, here.
 */

export const webhookPayloadSchema = z
  .object({
    id: z.string().min(1, "id is required"),
    type: z.enum(WEBHOOK_EVENT_TYPES),
    created: z.number().int().nonnegative().optional(),
    data: z.object({
      /** Merchant/customer the event belongs to. */
      user: z.object({
        email: z.string().email(),
        name: z.string().min(1).optional(),
      }),
      amountCents: z.number().int().positive("amountCents must be greater than 0"),
      currency: z
        .string()
        .length(3, "currency must be a 3-letter ISO code")
        .transform((value) => value.toUpperCase()),
      reference: z.string().min(1).optional(),
      /**
       * Test hook for the simulator: force a specific failure mode so retries
       * and dead-letter behaviour can be demonstrated on purpose.
       */
      simulate: z.enum(["transient_error", "permanent_error"]).optional(),
    }),
  })
  .strict();

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

export interface ValidationFailure {
  path: string;
  message: string;
}

export type ParsePayloadResult =
  | { ok: true; payload: WebhookPayload }
  | { ok: false; issues: ValidationFailure[] };

/** Parse and validate a decoded webhook body. Never throws. */
export function parseWebhookPayload(input: unknown): ParsePayloadResult {
  const result = webhookPayloadSchema.safeParse(input);
  if (result.success) return { ok: true, payload: result.data };

  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    })),
  };
}