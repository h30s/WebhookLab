import { handleRoute } from "@/lib/errors";
import { getWebhookService } from "@/lib/webhook";

/**
 * GET /api/wallets
 *
 * Wallet balances per user and currency, plus the aggregate totals the
 * dashboard shows.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return handleRoute(
    async () => {
      const { service } = await getWebhookService();
      const [wallets, users] = await Promise.all([service.listWallets(), service.listUsers()]);

      const totalBalanceCentsByCurrency = wallets.reduce<Record<string, number>>((acc, wallet) => {
        acc[wallet.currency] = (acc[wallet.currency] ?? 0) + wallet.balanceCents;
        return acc;
      }, {});

      return {
        totalBalanceCentsByCurrency,
        wallets: wallets.map((wallet) => ({
          ...wallet,
          user: users.find((user) => user.id === wallet.userId) ?? null,
        })),
      };
    },
    (payload) => Response.json(payload),
  );
}