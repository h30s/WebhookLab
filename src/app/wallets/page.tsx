import Link from "next/link";
import { getWebhookService } from "@/lib/webhook";
import { formatCents } from "@/lib/webhook/balance";
import { formatDateTime } from "@/lib/format";
import { EmptyState, Panel, StatCard, StoreModeNotice } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Wallet balances and the ledger entries that produced them. */
export default async function WalletsPage() {
  const { service, mode } = await getWebhookService();
  const [wallets, transactions, users] = await Promise.all([
    service.listWallets(),
    service.listTransactions(100),
    service.listUsers(),
  ]);

  const walletById = new Map(wallets.map((wallet) => [wallet.id, wallet]));
  const totalByCurrency = wallets.reduce<Record<string, number>>((acc, wallet) => {
    acc[wallet.currency] = (acc[wallet.currency] ?? 0) + wallet.balanceCents;
    return acc;
  }, {});

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Wallets</h1>
        <p className="mt-1 text-sm text-slate-400">
          Balances are only ever changed by the webhook pipeline, inside the same transaction that records the
          event.
        </p>
      </div>

      <StoreModeNotice mode={mode} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Object.entries(totalByCurrency).map(([currency, cents]) => (
          <StatCard key={currency} label={`${currency} held`} value={formatCents(cents, currency)} tone="accent" />
        ))}
        <StatCard label="Wallets" value={wallets.length} hint={`${users.length} customers`} />
        <StatCard label="Ledger entries" value={transactions.length} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Panel title="Balances" className="lg:col-span-1">
          {wallets.length === 0 ? (
            <EmptyState message="No wallets yet." />
          ) : (
            <ul className="divide-y divide-ink-800/70">
              {wallets.map((wallet) => {
                const user = users.find((candidate) => candidate.id === wallet.userId);
                return (
                  <li key={wallet.id} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-slate-200">{user?.name ?? wallet.userId}</p>
                        <p className="truncate text-xs text-slate-500">{user?.email ?? "-"}</p>
                      </div>
                      <p className="tabular-nums text-sm font-medium text-slate-100">
                        {formatCents(wallet.balanceCents, wallet.currency)}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Transaction history" className="lg:col-span-2">
          {transactions.length === 0 ? (
            <EmptyState message="No wallet transactions yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-ink-700/70 text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-4 py-2 font-medium">When</th>
                    <th className="px-4 py-2 font-medium">Direction</th>
                    <th className="px-4 py-2 font-medium">Amount</th>
                    <th className="px-4 py-2 font-medium">Balance after</th>
                    <th className="px-4 py-2 font-medium">Wallet</th>
                    <th className="px-4 py-2 font-medium">Source event</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-800/70">
                  {transactions.map((entry) => {
                    const wallet = walletById.get(entry.walletId);
                    const user = wallet ? users.find((candidate) => candidate.id === wallet.userId) : undefined;
                    return (
                      <tr key={entry.id} className="hover:bg-ink-800/40">
                        <td className="px-4 py-3 text-xs text-slate-400">{formatDateTime(entry.createdAt)}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`chip ${
                              entry.direction === "CREDIT"
                                ? "border-emerald-600 bg-emerald-500/10 text-emerald-300"
                                : "border-rose-600 bg-rose-500/10 text-rose-300"
                            }`}
                          >
                            {entry.direction}
                          </span>
                        </td>
                        <td className="px-4 py-3 tabular-nums text-slate-200">
                          {formatCents(entry.amountCents, entry.currency)}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-slate-300">
                          {formatCents(entry.balanceAfterCents, entry.currency)}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-400">
                          {user?.email ?? "-"}
                          <span className="ml-1 font-mono text-[11px] text-slate-500">{entry.currency}</span>
                        </td>
                        <td className="px-4 py-3">
                          {entry.webhookEventId ? (
                            <Link
                              href={`/events/${entry.webhookEventId}`}
                              className="font-mono text-xs text-sky-400 hover:text-sky-300"
                            >
                              {entry.webhookEventId}
                            </Link>
                          ) : (
                            <span className="text-xs text-slate-600">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}