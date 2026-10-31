import { handleRoute } from "@/lib/errors";
import { getWebhookService } from "@/lib/webhook";

/**
 * GET /api/events/:id
 *
 * A single event with its user, its attempt log and the ledger entry it wrote.
 */

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(
    async () => {
      const { id } = await context.params;
      const { service } = await getWebhookService();
      return service.getEventDetail(id);
    },
    (detail) => Response.json(detail),
  );
}