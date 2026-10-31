"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Manual retry control.
 *
 * All this does is call the retry endpoint and refresh the page - the
 * processing itself lives entirely in the engine behind the API.
 */
export function RetryButton({
  eventId,
  disabled,
  disabledReason,
}: {
  eventId: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function retry() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/events/${eventId}/retry`, { method: "POST" });
      const body = await response.json();

      if (!response.ok) {
        setMessage({ ok: false, text: body?.error?.message ?? "Retry failed" });
        return;
      }

      setMessage({
        ok: body.outcome === "PROCESSED",
        text:
          body.outcome === "PROCESSED"
            ? "Retried successfully - the event is now processed."
            : `Retry ran but the event is still failing: ${body.error ?? "unknown error"}`,
      });
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Retry failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        className="btn-ghost"
        onClick={retry}
        disabled={disabled || busy}
        title={disabled ? disabledReason : "Re-run the processing pipeline"}
      >
        {busy || pending ? "Retrying..." : "Retry"}
      </button>
      {message ? (
        <span className={`text-xs ${message.ok ? "text-emerald-300" : "text-rose-300"}`}>{message.text}</span>
      ) : null}
    </div>
  );
}