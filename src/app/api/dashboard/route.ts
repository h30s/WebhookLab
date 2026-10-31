import { handleRoute } from "@/lib/errors";
import { getWebhookService } from "@/lib/webhook";

/**
 * GET /api/dashboard
 *
 * The aggregated numbers the dashboard renders: totals, success rate and
 * wallet balances.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return handleRoute(
    async () => {
      const { service, mode } = await getWebhookService();
      return { summary: await service.getDashboard(), mode };
    },
    (payload) => Response.json(payload),
  );
}