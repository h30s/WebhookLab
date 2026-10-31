import Link from "next/link";
import { getWebhookService } from "@/lib/webhook";
import { formatDateTime } from "@/lib/format";
import { WEBHOOK_EVENT_STATUSES, type WebhookEventStatus } from "@/lib/webhook/types";
import { RetryButton } from "@/components/retry-button";
import { EmptyState, Panel, StoreModeNotice, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

const FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  ...WEBHOOK_EVENT_STATUSES.map((status) => ({ value: status, label: status })),
];

/**
 * Webhook event history: every event with its id, status and attempt count,
 * plus a manual retry control for anything that failed.
 */
export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const activeStatus = WEBHOOK_EVENT_STATUSES.includes(status as WebhookEventStatus)
    ? (status as WebhookEventStatus)
    : undefined;

  const { service, mode } = await getWebhookService();
  const [events, users] = await Promise.all([
    service.listEvents({ status: activeStatus, limit: 100 }),
    service.listUsers(),
  ]);

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Webhook events</h1>
        <p className="mt-1 text-sm text-slate-400">
          Every delivery is recorded once. Failed events can be retried by hand.
        </p>
      </div>

      <StoreModeNotice mode={mode} />

      <Panel
        title={`${events.length} event${events.length === 1 ? "" : "s"}`}
        actions={
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((filter) => {
              const isActive = (filter.value || undefined) === activeStatus;
              return (
                <Link
                  key={filter.value || "all"}
                  href={filter.value ? `/events?status=${filter.value}` : "/events"}
                  className={`rounded-md px-2.5 py-1 text-xs transition ${
                    isActive ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-ink-800 hover:text-slate-200"
                  }`}
                >
                  {filter.label}
                </Link>
              );
            })}
          </div>
        }
      >
        {events.length === 0 ? (
          <EmptyState message="No events match this filter." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-ink-700/70 text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Event id</th>
                  <th className="px-4 py-2 font-medium">Provider id</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">User</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Attempts</th>
                  <th className="px-4 py-2 font-medium">Received</th>
                  <th className="px-4 py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800/70">
                {events.map((event) => {
                  const user = users.find((candidate) => candidate.id === event.userId);
                  return (
                    <tr key={event.id} className="align-top hover:bg-ink-800/40">
                      <td className="px-4 py-3">
                        <Link href={`/events/${event.id}`} className="font-mono text-xs text-sky-400 hover:text-sky-300">
                          {event.id}
                        </Link>
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-slate-400">{event.providerEventId}</td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-300">{event.type}</td>
                      <td className="px-4 py-3 text-xs text-slate-400">{user?.email ?? "-"}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={event.status} />
                        {event.lastError ? (
                          <p className="mt-1 max-w-xs text-[11px] text-rose-300/80">{event.lastError}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-slate-300">
                        {event.attempts}/{event.maxAttempts}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400">{formatDateTime(event.receivedAt)}</td>
                      <td className="px-4 py-3">
                        {event.status === "FAILED" ? (
                          <RetryButton eventId={event.id} />
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
    </>
  );
}