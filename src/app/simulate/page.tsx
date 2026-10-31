import { SimulatorForm } from "@/components/simulator-form";
import { Panel, StoreModeNotice } from "@/components/ui";
import { env } from "@/lib/env";
import { getWebhookService } from "@/lib/webhook";

export const dynamic = "force-dynamic";

/** Simulate incoming payment webhook events. */
export default async function SimulatePage() {
  const { mode } = await getWebhookService();

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Simulate</h1>
        <p className="mt-1 text-sm text-slate-400">
          Deliver a payment webhook the way a provider would. The event travels the same receive path as a real
          delivery, including signature verification.
        </p>
      </div>

      <StoreModeNotice mode={mode} />

      <SimulatorForm />

      <Panel title="How to deliver one with curl" className="mt-6">
        <div className="space-y-3 px-4 py-4 text-sm">
          <p className="text-slate-400">
            The receiver also accepts raw HTTP deliveries on{" "}
            <span className="font-mono text-xs text-slate-200">POST /api/webhooks/payments</span>.
            {env.signingSecret ? (
              <>
                {" "}
                Because <span className="font-mono text-xs text-slate-200">WEBHOOK_SIGNING_SECRET</span> is set,
                a request without a valid <span className="font-mono text-xs text-slate-200">x-webhook-signature</span>{" "}
                header is rejected with 401.
              </>
            ) : (
              <> No signing secret is configured, so unsigned deliveries are accepted.</>
            )}
          </p>
          <pre className="overflow-x-auto rounded-md border border-ink-700/70 bg-ink-950/80 px-3 py-3 font-mono text-[11px] leading-relaxed text-slate-300">
{`curl -X POST http://localhost:3000/api/webhooks/payments \\
  -H "content-type: application/json" \\
  -d '{
    "id": "evt_manual_1",
    "type": "payment.succeeded",
    "data": {
      "user": { "email": "ada@example.com", "name": "Ada Lovelace" },
      "amountCents": 2500,
      "currency": "usd",
      "reference": "order_1001"
    }
  }'`}
          </pre>
          <p className="text-xs text-slate-500">
            Send the same <span className="font-mono">id</span> twice to see duplicate detection: the second
            delivery returns 200 with <span className="font-mono">duplicate: true</span> and moves no money.
            Add <span className="font-mono">&quot;simulate&quot;: &quot;transient_error&quot;</span> inside{" "}
            <span className="font-mono">data</span> to make the first attempt fail so you can retry it.
          </p>
        </div>
      </Panel>
    </>
  );
}