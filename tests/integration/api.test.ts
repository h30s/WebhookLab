import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as receivePayment } from "@/app/api/webhooks/payments/route";
import { GET as listEvents } from "@/app/api/events/route";
import { GET as getEvent } from "@/app/api/events/[id]/route";
import { POST as retryEvent } from "@/app/api/events/[id]/retry/route";
import { GET as listWallets } from "@/app/api/wallets/route";
import { GET as listTransactions } from "@/app/api/transactions/route";
import { GET as getDashboard } from "@/app/api/dashboard/route";
import { setWebhookService } from "@/lib/webhook";
import { buildDelivery, createHarness, paymentPayload, TEST_SECRET, type Harness } from "../helpers/harness";

/**
 * HTTP-level integration tests.
 *
 * The route handlers are called directly with real `Request` objects, so this
 * exercises the full stack - routing, parsing, the service, the store and the
 * shared error mapping - without needing a running server.
 */

const BASE = "http://localhost:3000";

function post(path: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function get(path: string): Request {
  return new Request(`${BASE}${path}`, { method: "GET" });
}

describe("webhook API", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
    setWebhookService(harness.service);
  });

  afterEach(() => {
    setWebhookService(null);
  });

  describe("POST /api/webhooks/payments", () => {
    it("accepts a new delivery with 202 and reports the outcome", async () => {
      const delivery = buildDelivery(paymentPayload());
      const response = await receivePayment(post("/api/webhooks/payments", delivery.rawBody, delivery.headers));

      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.duplicate).toBe(false);
      expect(body.processed).toBe(true);
      expect(body.event.status).toBe("PROCESSED");
      expect(body.event.id).toMatch(/^mem_/);
    });

    it("answers a duplicate delivery with 200 and does not process it twice", async () => {
      const delivery = buildDelivery(paymentPayload());
      await receivePayment(post("/api/webhooks/payments", delivery.rawBody, delivery.headers));
      const response = await receivePayment(post("/api/webhooks/payments", delivery.rawBody, delivery.headers));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.duplicate).toBe(true);
      expect(body.processed).toBe(false);
    });

    it("returns the shared error shape for invalid JSON", async () => {
      const response = await receivePayment(post("/api/webhooks/payments", "{oops"));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.retryable).toBe(false);
    });

    it("returns 400 with field-level details for an invalid payload", async () => {
      const response = await receivePayment(
        post("/api/webhooks/payments", JSON.stringify({ id: "evt_1", type: "payment.succeeded", data: {} })),
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.details.issues.length).toBeGreaterThan(0);
    });

    it("returns 401 when a signing secret is configured and the signature is missing", async () => {
      const signed = createHarness({ signingSecret: TEST_SECRET });
      setWebhookService(signed.service);

      const response = await receivePayment(
        post("/api/webhooks/payments", buildDelivery(paymentPayload()).rawBody),
      );

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe("SIGNATURE_INVALID");
    });

    it("accepts a correctly signed delivery", async () => {
      const signed = createHarness({ signingSecret: TEST_SECRET });
      setWebhookService(signed.service);

      const delivery = buildDelivery(paymentPayload(), { secret: TEST_SECRET });
      const response = await receivePayment(post("/api/webhooks/payments", delivery.rawBody, delivery.headers));

      expect(response.status).toBe(202);
    });
  });

  describe("GET /api/events", () => {
    it("lists the event history newest first", async () => {
      const first = buildDelivery(paymentPayload({ id: "evt_1" }));
      await receivePayment(post("/api/webhooks/payments", first.rawBody, first.headers));
      harness.advanceClock(1_000);
      const second = buildDelivery(paymentPayload({ id: "evt_2" }));
      await receivePayment(post("/api/webhooks/payments", second.rawBody, second.headers));

      const response = await listEvents(get("/api/events"));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.count).toBe(2);
      expect(body.events[0].providerEventId).toBe("evt_2");
    });

    it("filters by status", async () => {
      const ok = buildDelivery(paymentPayload({ id: "evt_ok" }));
      const bad = buildDelivery(paymentPayload({ id: "evt_bad", simulate: "transient_error" }));
      await receivePayment(post("/api/webhooks/payments", ok.rawBody, ok.headers));
      await receivePayment(post("/api/webhooks/payments", bad.rawBody, bad.headers));

      const response = await listEvents(get("/api/events?status=FAILED"));
      const body = await response.json();

      expect(body.count).toBe(1);
      expect(body.events[0].providerEventId).toBe("evt_bad");
    });
  });

  describe("GET /api/events/:id", () => {
    it("returns the event with its attempt log", async () => {
      const delivery = buildDelivery(paymentPayload());
      const created = await receivePayment(post("/api/webhooks/payments", delivery.rawBody, delivery.headers));
      const { event } = await created.json();

      const response = await getEvent(get(`/api/events/${event.id}`), {
        params: Promise.resolve({ id: event.id }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.event.id).toBe(event.id);
      expect(body.attempts).toHaveLength(1);
      expect(body.user.email).toBe("ada@example.com");
    });

    it("returns 404 for an unknown event id", async () => {
      const response = await getEvent(get("/api/events/nope"), { params: Promise.resolve({ id: "nope" }) });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("POST /api/events/:id/retry", () => {
    it("retries a failed event and reports success", async () => {
      const delivery = buildDelivery(paymentPayload({ simulate: "transient_error" }));
      const created = await receivePayment(post("/api/webhooks/payments", delivery.rawBody, delivery.headers));
      const { event } = await created.json();
      expect(event.status).toBe("FAILED");

      const response = await retryEvent(post(`/api/events/${event.id}/retry`, ""), {
        params: Promise.resolve({ id: event.id }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.outcome).toBe("PROCESSED");
      expect(body.event.status).toBe("PROCESSED");
      expect(body.event.attempts).toBe(2);
      expect(body.transaction.amountCents).toBe(2500);
    });

    it("returns 409 when the event is not failed", async () => {
      const delivery = buildDelivery(paymentPayload());
      const created = await receivePayment(post("/api/webhooks/payments", delivery.rawBody, delivery.headers));
      const { event } = await created.json();

      const response = await retryEvent(post(`/api/events/${event.id}/retry`, ""), {
        params: Promise.resolve({ id: event.id }),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.code).toBe("CONFLICT");
    });

    it("returns 404 for an unknown event", async () => {
      const response = await retryEvent(post("/api/events/missing/retry", ""), {
        params: Promise.resolve({ id: "missing" }),
      });

      expect(response.status).toBe(404);
    });
  });

  describe("read models", () => {
    beforeEach(async () => {
      const ok = buildDelivery(paymentPayload({ id: "evt_ok", amountCents: 2500 }));
      const other = buildDelivery(paymentPayload({ id: "evt_other", email: "grace@example.com", amountCents: 1000 }));
      const bad = buildDelivery(paymentPayload({ id: "evt_bad", simulate: "transient_error" }));
      await receivePayment(post("/api/webhooks/payments", ok.rawBody, ok.headers));
      await receivePayment(post("/api/webhooks/payments", other.rawBody, other.headers));
      await receivePayment(post("/api/webhooks/payments", bad.rawBody, bad.headers));
    });

    it("GET /api/dashboard reports totals, success rate and balances", async () => {
      const response = await getDashboard();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.summary.totals.events).toBe(3);
      expect(body.summary.totals.processed).toBe(2);
      expect(body.summary.totals.failed).toBe(1);
      expect(body.summary.successRate).toBeCloseTo(66.7, 1);
      expect(body.summary.totalBalanceCentsByCurrency.USD).toBe(3500);
      expect(body.mode).toBe("memory");
    });

    it("GET /api/wallets lists each wallet with its user", async () => {
      const response = await listWallets();
      const body = await response.json();

      expect(body.wallets).toHaveLength(2);
      expect(body.wallets.map((wallet: { currency: string }) => wallet.currency)).toEqual(["USD", "USD"]);
      expect(body.wallets.map((wallet: { user: { email: string } }) => wallet.user.email).sort()).toEqual([
        "ada@example.com",
        "grace@example.com",
      ]);
      expect(body.totalBalanceCentsByCurrency.USD).toBe(3500);
    });

    it("GET /api/transactions lists the ledger with its source event", async () => {
      const response = await listTransactions(get("/api/transactions"));
      const body = await response.json();

      expect(body.count).toBe(2);
      expect(body.transactions.every((row: { webhookEventId: string }) => row.webhookEventId)).toBe(true);
      expect(body.transactions.map((row: { amountCents: number }) => row.amountCents).sort()).toEqual([1000, 2500]);
    });
  });
});