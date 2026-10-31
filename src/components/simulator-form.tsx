"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { WebhookEventType } from "@/lib/webhook/types";

/**
 * The simulator form.
 *
 * It POSTs to /api/simulate, which builds a signed provider payload and feeds
 * it through the real receive path. The response is shown verbatim so the
 * recorded outcome (status, attempts, duplicate flag) is visible.
 */

const EVENT_TYPES: { value: WebhookEventType; label: string; hint: string }[] = [
  { value: "payment.succeeded", label: "payment.succeeded", hint: "Credits the wallet" },
  { value: "payment.refunded", label: "payment.refunded", hint: "Debits the wallet" },
  { value: "payment.failed", label: "payment.failed", hint: "Recorded, no wallet movement" },
];

const FAILURE_MODES = [
  { value: "none", label: "None - process normally" },
  { value: "transient_error", label: "Transient error - fails once, retry succeeds" },
  { value: "permanent_error", label: "Permanent error - always fails" },
] as const;

type FailureMode = (typeof FAILURE_MODES)[number]["value"];

interface SimulatorResult {
  duplicate: boolean;
  processed: boolean;
  store: string;
  signed: boolean;
  providerEventId: string;
  event: {
    id: string;
    status: string;
    attempts: number;
    lastError: string | null;
    nextRetryAt: string | null;
  };
}

export function SimulatorForm() {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [type, setType] = useState<WebhookEventType>("payment.succeeded");
  const [email, setEmail] = useState("ada@example.com");
  const [name, setName] = useState("Ada Lovelace");
  const [amount, setAmount] = useState("25.00");
  const [currency, setCurrency] = useState("USD");
  const [reference, setReference] = useState("order_1001");
  const [simulate, setSimulate] = useState<FailureMode>("none");
  const [reuseEventId, setReuseEventId] = useState("");

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SimulatorResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);

    const amountCents = Math.round(Number.parseFloat(amount) * 100);

    try {
      const response = await fetch("/api/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type,
          email,
          name: name || undefined,
          amountCents,
          currency,
          reference: reference || undefined,
          simulate,
          providerEventId: reuseEventId || undefined,
        }),
      });

      const body = await response.json();
      if (!response.ok) {
        setError(body?.error?.message ?? "The simulator request failed");
        return;
      }
      setResult(body as SimulatorResult);
      startTransition(() => router.refresh());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The simulator request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form onSubmit={submit} className="panel p-5">
        <h2 className="panel-title mb-4">Send a payment webhook</h2>

        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="type">
              Event type
            </label>
            <select id="type" className="field" value={type} onChange={(e) => setType(e.target.value as WebhookEventType)}>
              {EVENT_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} - {option.hint}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="email">
                Customer email
              </label>
              <input id="email" className="field" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <label className="label" htmlFor="name">
                Customer name
              </label>
              <input id="name" className="field" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="amount">
                Amount
              </label>
              <input
                id="amount"
                className="field"
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="currency">
                Currency
              </label>
              <input
                id="currency"
                className="field"
                maxLength={3}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="reference">
                Reference
              </label>
              <input id="reference" className="field" value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="simulate">
              Failure injection
            </label>
            <select
              id="simulate"
              className="field"
              value={simulate}
              onChange={(e) => setSimulate(e.target.value as FailureMode)}
            >
              {FAILURE_MODES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="reuseEventId">
              Re-use a provider event id (optional)
            </label>
            <input
              id="reuseEventId"
              className="field font-mono text-xs"
              placeholder="evt_... - send the same id twice to see duplicate detection"
              value={reuseEventId}
              onChange={(e) => setReuseEventId(e.target.value)}
            />
          </div>
        </div>

        <button type="submit" className="btn-primary mt-5 w-full" disabled={busy}>
          {busy ? "Delivering..." : "Deliver webhook"}
        </button>
      </form>

      <section className="panel p-5">
        <h2 className="panel-title mb-4">Recorded outcome</h2>

        {error ? (
          <p className="rounded-md border border-rose-800/60 bg-rose-500/5 px-3 py-2 text-sm text-rose-300">
            {error}
          </p>
        ) : null}

        {!error && !result ? (
          <p className="text-sm text-slate-500">
            Deliver an event to see what the receiver recorded: its status, attempt count and whether the
            delivery was treated as a duplicate.
          </p>
        ) : null}

        {result ? (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              <dt className="text-slate-400">Event id</dt>
              <dd className="font-mono text-xs text-slate-200">{result.event.id}</dd>
              <dt className="text-slate-400">Provider event id</dt>
              <dd className="break-all font-mono text-xs text-slate-200">{result.providerEventId}</dd>
              <dt className="text-slate-400">Status</dt>
              <dd className="font-mono text-xs text-slate-200">{result.event.status}</dd>
              <dt className="text-slate-400">Attempts</dt>
              <dd className="tabular-nums text-slate-200">{result.event.attempts}</dd>
              <dt className="text-slate-400">Duplicate delivery</dt>
              <dd className={result.duplicate ? "text-amber-300" : "text-slate-200"}>
                {result.duplicate ? "yes - ignored" : "no"}
              </dd>
              <dt className="text-slate-400">Signature verified</dt>
              <dd className="text-slate-200">{result.signed ? "yes" : "not required"}</dd>
              <dt className="text-slate-400">Next retry</dt>
              <dd className="font-mono text-xs text-slate-200">{result.event.nextRetryAt ?? "-"}</dd>
            </dl>

            {result.event.lastError ? (
              <p className="rounded-md border border-rose-800/60 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">
                {result.event.lastError}
              </p>
            ) : null}

            <p className="text-xs text-slate-500">
              {result.duplicate
                ? "This provider event id was already recorded, so no second event row was created and no money moved."
                : "Open the Events page to inspect the attempt log and retry a failed event."}
            </p>
          </div>
        ) : null}
      </section>
    </div>
  );
}