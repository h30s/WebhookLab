import type { WebhookEventStatus } from "@/lib/webhook/types";

/** Small presentational primitives shared by the pages. */

const STATUS_STYLES: Record<WebhookEventStatus, string> = {
  RECEIVED: "border-slate-600 bg-slate-500/10 text-slate-300",
  PROCESSING: "border-sky-600 bg-sky-500/10 text-sky-300",
  PROCESSED: "border-emerald-600 bg-emerald-500/10 text-emerald-300",
  FAILED: "border-rose-600 bg-rose-500/10 text-rose-300",
};

export function StatusBadge({ status }: { status: WebhookEventStatus }) {
  return <span className={`chip ${STATUS_STYLES[status]}`}>{status}</span>;
}

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "positive" | "negative" | "accent";
}) {
  const toneClass = {
    default: "text-slate-100",
    positive: "text-emerald-300",
    negative: "text-rose-300",
    accent: "text-sky-300",
  }[tone];

  return (
    <div className="panel p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function Panel({
  title,
  actions,
  children,
  className = "",
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-header">
        <h2 className="panel-title">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <p className="px-4 py-10 text-center text-sm text-slate-500">{message}</p>;
}

export function Mono({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span className="font-mono text-xs text-slate-300" title={title}>
      {children}
    </span>
  );
}

export function StoreModeNotice({ mode }: { mode: "postgres" | "memory" }) {
  if (mode === "postgres") {
    return (
      <p className="mb-6 rounded-md border border-emerald-800/60 bg-emerald-500/5 px-4 py-2 text-xs text-emerald-300">
        Persisting to PostgreSQL via Prisma.
      </p>
    );
  }
  return (
    <p className="mb-6 rounded-md border border-amber-800/60 bg-amber-500/5 px-4 py-2 text-xs text-amber-300">
      Demo mode: no <Mono>DATABASE_URL</Mono> is configured, so data lives in memory and resets when the
      server restarts. Set it in <Mono>.env</Mono> and run <Mono>npm run db:push</Mono> to use PostgreSQL.
    </p>
  );
}