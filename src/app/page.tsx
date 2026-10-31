import Link from "next/link";
import { getWebhookService } from "@/lib/webhook";
import { formatCents } from "@/lib/webhook/balance";
import { formatDateTime } from "@/lib/format";
import { EmptyState, Panel, StatCard, StatusBadge, StoreModeNotice } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Dashboard.
 *
 * A server component: it reads through the service directly rather than
 * calling its own HTTP API, which keeps webhook processing out of the UI.
 */
export default async function DashboardPage() {
  const { service, mode } = await getWebhookService();
  const summary = await service.getDashboard();
  const users = await service.listUsers();

  const balances = Object.entries(summary.totalBalanceCentsByCurrency);

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-400">
          Incoming webhook events, how they resolved, and the wallet balances they produced.
        </p>
      </div>

      <StoreModeNotice mode={mode} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total webhook events" value={summary.totals.events} hint={`${summary.totals.attempts} processing attempts`} />
        <StatCard label="Successful events" value={summary.totals.processed} tone="positive" hint={`${summary.successRate}% of settled events`} />
        <StatCard label="Failed events" value={summary.totals.failed} tone="negative" hint={`${summary.totals.received} still awaiting a final status`} />
        <StatCard
          label="Wallet balance"
          value={balances.length === 0 ? formatCents(0) : balances.map(([, cents]) => formatCents(cents)).join(" + ")}
          tone="accent"
          hint={`${summary.wallets.length} wallet${summary.wallets.length === 1 ? "" : "s"} across ${users.length} user${users.length === 1 ? "" : "s"}`}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <Panel
          title="Recent webhook events"
          className="lg:col-span-3"
          actions={
            <Link href="/events" className="text-xs text-sky-400 hover:text-sky-300">
              View all
            </Link>
          }
        >
          {summary.recentEvents.length === 0 ? (
            <EmptyState message="No webhook events yet. Use the Simulate page to deliver one." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-ink-700/70 text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-4 py-2 font-medium">Event id</th>
                    <th className="px-4 py-2 font-medium">Type</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Attempts</th>
                    <th className="px-4 py-2 font-medium">Received</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-800/70">
                  {summary.recentEvents.map((event) => (
                    <tr key={event.id} className="hover:bg-ink-800/40">
                      <td className="px-4 py-2">
                        <Link href={`/events/${event.id}`} className="font-mono text-xs text-sky-400 hover:text-sky-300">
                          {event.id}
                        </Link>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-300">{event.type}</td>
                      <td className="px-4 py-2">
                        <StatusBadge status={event.status} />
                      </td>
                      <td className="px-4 py-2 tabular-nums text-slate-300">
                        {event.attempts}/{event.maxAttempts}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-400">{formatDateTime(event.receivedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="Wallet balances"
          className="lg:col-span-2"
          actions={
            <Link href="/wallets" className="text-xs text-sky-400 hover:text-sky-300">
              Ledger
            </Link>
          }
        >
          {summary.wallets.length === 0 ? (
            <EmptyState message="No wallets yet." />
          ) : (
            <ul className="divide-y divide-ink-800/70">
              {summary.wallets.map((wallet) => {
                const user = users.find((candidate) => candidate.id === wallet.userId);
                return (
                  <li key={wallet.id} className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-slate-200">{user?.name ?? wallet.userId}</p>
                      <p className="truncate text-xs text-slate-500">{user?.email ?? "-"}</p>
                    </div>
                    <div className="text-right">
                      <p className="tabular-nums text-sm font-medium text-slate-100">
                        {formatCents(wallet.balanceCents, wallet.currency)}
                      </p>
                      <p className="font-mono text-[11px] text-slate-500">{wallet.currency}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}