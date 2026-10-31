import { handleRoute, ValidationError } from "@/lib/errors";
import { env } from "@/lib/env";
import { getWebhookService } from "@/lib/webhook";
import { signPayload, SIGNATURE_HEADER } from "@/lib/webhook/signature";
import { buildProviderPayload, simulatorInputSchema } from "@/lib/webhook/simulator";

/**
 * POST /api/simulate
 *
 * The in-app "payment provider". It builds a payload, signs it with the
 * configured secret, and feeds it through the same `receive()` path a real
 * delivery takes - so signature verification and duplicate detection behave
 * exactly as they would in production.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleRoute(
    async () => {
      const body = await request.json().catch(() => null);
      const parsed = simulatorInputSchema.safeParse(body);
      if (!parsed.success) {
        throw new ValidationError(
          "Simulator input failed validation",
          {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join(".") || "(root)",
              message: issue.message,
            })),
          },
        );
      }

      const payload = buildProviderPayload(parsed.data);
      const rawBody = JSON.stringify(payload);
      const signatureHeader = env.signingSecret ? signPayload(rawBody, env.signingSecret) : null;

      const { service, mode } = await getWebhookService();
      const result = await service.receive({ rawBody, signatureHeader });
      return { payload, result, mode, signed: signatureHeader !== null };
    },
    ({ payload, result, mode, signed }) =>
      Response.json(
        {
          duplicate: result.duplicate,
          processed: result.processed,
          store: mode,
          signed,
          signatureHeaderName: SIGNATURE_HEADER,
          providerEventId: payload.id,
          event: {
            id: result.event.id,
            status: result.event.status,
            attempts: result.event.attempts,
            lastError: result.event.lastError,
            nextRetryAt: result.event.nextRetryAt,
          },
        },
        { status: result.duplicate ? 200 : 202 },
      ),
  );
}