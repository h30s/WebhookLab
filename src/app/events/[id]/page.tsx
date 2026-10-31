import Link from "next/link";
import { notFound } from "next/navigation";
import { toAppError } from "@/lib/errors";
import { getWebhookService } from "@/lib/webhook";
import { formatCents } from "@/lib/webhook/balance";
import { formatDateTime, formatDuration } from "@/lib/format";
import { RetryButton } from "@/components/retry-button";
import { Panel, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

/** One event in full: its payload, every processing attempt, and its ledger entry. */
export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { service } = await getWebhookService();

  const detail = await service.getEventDetail(id).catch((error: unknown) => {
    const appError = toAppError(error);
    if (appError.status === 404) return null;
    throw error;
  });

  if (!detail) notFound();

  const { event, user, attempts, transaction } = detail;

  return (
    <>
      <div className="mb-6">
        <Link href="/events" className="text-xs text-sky-400 hover:text-sky-300">
          &larr; All events
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl font-semibold tracking-tight text-white">{event.id}</h1>
          <StatusBadge status={event.status} />
        </div>
        <p className="mt-1 text-sm text-slate-400">
          {event.type} &middot; received {formatDateTime(event.receivedAt)}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Panel title="Processing attempts">
            {attempts.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">No attempt has run yet.</p>
            ) : (
              <ul className="divide-y divide-ink-800/70">
                {attempts.map((attempt) => (
                  <li key={attempt.id} className="flex items-start justify-between gap-4 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm text-slate-200">
                        Attempt {attempt.attempt} &middot;{" "}
                        <span className={attempt.status === "SUCCEEDED" ? "text-emerald-300" : "text-rose-300"}>
                          {attempt.status}
                        </span>
                      </p>
                      {attempt.error ? (
                        <p className="mt-1 break-words font-mono text-[11px] text-rose-300/80">{attempt.error}</p>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-right text-xs text-slate-500">
                      <p>{formatDuration(attempt.durationMs)}</p>
                      <p>{formatDateTime(attempt.createdAt)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Payload">
            <pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed text-slate-300">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="Outcome">
            <dl className="space-y-3 px-4 py-4 text-sm">
              <Row label="Status">
                <StatusBadge status={event.status} />
              </Row>
              <Row label="Provider event id">
                <span className="break-all font-mono text-xs text-slate-200">{event.providerEventId}</span>
              </Row>
              <Row label="Customer">
                <span className="text-slate-200">{user?.email ?? "-"}</span>
              </Row>
              <Row label="Attempts">
                <span className="tabular-nums text-slate-200">
                  {event.attempts}/{event.maxAttempts}
                </span>
              </Row>
              <Row label="Processed at">
                <span className="font-mono text-xs text-slate-200">{formatDateTime(event.processedAt)}</span>
              </Row>
              <Row label="Next retry">
                <span className="font-mono text-xs text-slate-200">{formatDateTime(event.nextRetryAt)}</span>
              </Row>
              {event.lastError ? (
                <Row label="Last error">
                  <span className="break-words font-mono text-[11px] text-rose-300">{event.lastError}</span>
                </Row>
              ) : null}
            </dl>

            {event.status === "FAILED" ? (
              <div className="border-t border-ink-700/70 px-4 py-3">
                <RetryButton eventId={event.id} />
              </div>
            ) : null}
          </Panel>

          <Panel title="Wallet transaction">
            {transaction ? (
              <dl className="space-y-3 px-4 py-4 text-sm">
                <Row label="Direction">
                  <span className={transaction.direction === "CREDIT" ? "text-emerald-300" : "text-rose-300"}>
                    {transaction.direction}
                  </span>
                </Row>
                <Row label="Amount">
                  <span className="tabular-nums text-slate-100">
                    {formatCents(transaction.amountCents, transaction.currency)}
                  </span>
                </Row>
                <Row label="Balance after">
                  <span className="tabular-nums text-slate-200">
                    {formatCents(transaction.balanceAfterCents, transaction.currency)}
                  </span>
                </Row>
                <Row label="Recorded">
                  <span className="font-mono text-xs text-slate-200">{formatDateTime(transaction.createdAt)}</span>
                </Row>
              </dl>
            ) : (
              <p className="px-4 py-6 text-sm text-slate-500">
                This event moved no money. That is expected for a failed payment, and for any event that failed
                before it could be applied.
              </p>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-slate-400">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}