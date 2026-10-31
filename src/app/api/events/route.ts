import { handleRoute } from "@/lib/errors";
import { getWebhookService } from "@/lib/webhook";
import { WEBHOOK_EVENT_STATUSES, type WebhookEventStatus } from "@/lib/webhook/types";

/**
 * GET /api/events?status=FAILED&type=payment.succeeded&limit=50
 *
 * The webhook event history, newest first.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleRoute(
    async () => {
      const url = new URL(request.url);
      const statusParam = url.searchParams.get("status");
      const status = WEBHOOK_EVENT_STATUSES.includes(statusParam as WebhookEventStatus)
        ? (statusParam as WebhookEventStatus)
        : undefined;
      const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);

      const { service } = await getWebhookService();
      const events = await service.listEvents({
        status,
        type: url.searchParams.get("type") ?? undefined,
        limit: Number.isFinite(limitParam) ? limitParam : 50,
      });

      return { events };
    },
    ({ events }) => Response.json({ count: events.length, events }),
  );
}