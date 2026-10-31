import { handleRoute } from "@/lib/errors";
import { getWebhookService } from "@/lib/webhook";

/**
 * POST /api/events/:id/retry
 *
 * Manually re-runs the processing pipeline for a FAILED event.
 *
 * Responses:
 *   200 - the pipeline ran again; `outcome` says whether it succeeded
 *   404 - no such event
 *   409 - the event is not in a retryable state (already processed)
 */

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(
    async () => {
      const { id } = await context.params;
      const { service } = await getWebhookService();
      return service.retry(id);
    },
    (result) =>
      Response.json({
        outcome: result.outcome,
        error: result.error,
        event: {
          id: result.event.id,
          status: result.event.status,
          attempts: result.event.attempts,
          lastError: result.event.lastError,
          nextRetryAt: result.event.nextRetryAt,
          processedAt: result.event.processedAt,
        },
        transaction: result.transaction,
      }),
  );
}