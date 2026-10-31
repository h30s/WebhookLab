import { handleRoute } from "@/lib/errors";
import { getWebhookService } from "@/lib/webhook";

/**
 * GET /api/transactions?limit=100
 *
 * The wallet ledger, newest first. Each entry links back to the webhook event
 * that produced it.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleRoute(
    async () => {
      const url = new URL(request.url);
      const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const { service } = await getWebhookService();
      return service.listTransactions(Number.isFinite(limitParam) ? limitParam : 100);
    },
    (transactions) => Response.json({ count: transactions.length, transactions }),
  );
}