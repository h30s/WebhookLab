import { handleRoute } from "@/lib/errors";
import { getWebhookService } from "@/lib/webhook";
import { SIGNATURE_HEADER } from "@/lib/webhook/signature";

/**
 * POST /api/webhooks/payments
 *
 * The endpoint a payment provider would call. Accepts the raw JSON body plus
 * an optional `x-webhook-signature` header, records the event idempotently and
 * processes it synchronously.
 *
 * Responses:
 *   202 - new event recorded and processed
 *   200 - duplicate delivery, ignored
 *   400 - body is not valid JSON / fails validation
 *   401 - signature verification failed
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleRoute(
    async () => {
      const rawBody = await request.text();
      const { service, mode } = await getWebhookService();

      const result = await service.receive({
        rawBody,
        signatureHeader: request.headers.get(SIGNATURE_HEADER),
      });

      return { result, mode };
    },
    ({ result, mode }) =>
      Response.json(
        {
          duplicate: result.duplicate,
          processed: result.processed,
          store: mode,
          event: {
            id: result.event.id,
            providerEventId: result.event.providerEventId,
            type: result.event.type,
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