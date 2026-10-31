# WebhookLab

A webhook processing simulator. It demonstrates the full lifecycle of payment
webhook events: how they are **received**, **processed**, **retried** and
**recorded** — including the two things that actually break webhook integrations
in production: duplicate deliveries and partially applied wallet movements.

It is a working application, not a static dashboard. Every number on screen came
out of the processing pipeline.

---

## What it does

- **Dashboard** — total webhook events, successful events, failed events, wallet balances and success rate.
- **Simulate** — deliver payment webhook events (`payment.succeeded`, `payment.refunded`, `payment.failed`) the way a provider would, including signing.
- **Manual retry** — re-run the pipeline for any failed event, straight from the event list or the event detail page.
- **Event history** — every event with its id, provider event id, status, attempt count, last error and next scheduled retry.
- **Attempt log** — per event: every processing attempt, when it ran, how long it took and why it failed.
- **Wallet ledger** — wallet balances per user and currency, plus the transaction history with a link back to the event that produced each entry.
- **Multiple users and events** — one user can hold several wallets (one per currency).

---

## Tech stack

| Layer      | Choice                                  |
| ---------- | --------------------------------------- |
| Framework  | Next.js (App Router) + TypeScript       |
| API        | Next.js Node.js route handlers          |
| Database   | PostgreSQL                              |
| ORM        | Prisma                                  |
| Styling    | Tailwind CSS                            |
| Validation | Zod                                     |
| Tests      | Vitest (unit + integration)             |

---

## Quick start

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npx prisma db push        # create the tables
npm run db:seed           # optional: a realistic starting dataset
npm run dev
```

Open <http://localhost:3000>.

### Running PostgreSQL locally

If you do not have PostgreSQL installed, Docker is the quickest route:

```bash
docker run -d --name webhooklab-pg \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=webhooklab \
  postgres:16-alpine
```

That is exactly the connection string in `.env.example`.

### Demo mode (no database)

If `DATABASE_URL` is not set, WebhookLab falls back to an in-memory store so the
app still runs and the whole test suite still passes. The UI says so at the top
of every page. Data resets when the server restarts, and nothing is persisted.

---

## Tests

```bash
npm test                 # everything
npm run test:unit        # pure logic: handler rules, signatures, backoff, errors
npm run test:integration # pipeline + API routes
npm run test:watch       # watch mode
npm run typecheck        # tsc --noEmit
```

The suite has **99 tests** across 10 files:

| File                                | Covers                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `tests/unit/handler.test.ts`        | Business rules: credits, refunds, insufficient funds, failure injection, payload validation |
| `tests/unit/signature.test.ts`      | HMAC signing, tampering, wrong secret, replay window                          |
| `tests/unit/backoff.test.ts`        | Exponential backoff, ceiling, jitter, scheduling                              |
| `tests/unit/errors.test.ts`         | Error → HTTP mapping, the shared error body, `handleRoute`                    |
| `tests/integration/receive.test.ts` | Normal processing, refunds, multi-user/multi-currency, signatures             |
| `tests/integration/duplicates.test.ts` | Idempotency: same event id twice, changed body, concurrent delivery        |
| `tests/integration/retries.test.ts` | Failure recording, backoff scheduling, manual retry, exhausted retries        |
| `tests/integration/atomicity.test.ts` | Transaction rollback, the ledger unique guard, concurrent duplicate application |
| `tests/integration/api.test.ts`     | Every route handler end to end, including status codes and error bodies       |
| `tests/integration/postgres.test.ts` | The real database: unique indexes, atomic increments, interactive transactions |

### About `postgres.test.ts`

These 7 tests run against a real PostgreSQL and are **skipped when
`DATABASE_URL` is not set**, so `npm test` passes without a database. They are
the only place where database-level guarantees can actually be proven — the
unique index, `increment` under concurrency, and `$transaction` rollback.

To run them:

```bash
docker run -d --name webhooklab-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=webhooklab postgres:16-alpine
cp .env.example .env
npx prisma db push
npm test
```

Everything else runs against the in-memory store, which is written to behave
like PostgreSQL in the two ways that matter: `transaction()` really rolls back,
and every method returns a detached copy just as Prisma does.

---

## Architecture

The single most important decision: **webhook processing knows nothing about
HTTP or React.**

```
src/
  app/
    api/                      Node.js route handlers - the HTTP boundary
      webhooks/payments/      POST: receive a provider delivery
      events/                 GET list, GET one, POST retry
      wallets/, transactions/, dashboard/
      simulate/               the in-app "provider"
    page.tsx                  server components - read via the service
    events/, wallets/, simulate/
  components/                 presentation only
  lib/
    errors.ts                 one error shape + one error -> HTTP mapping
    webhook/
      service.ts              the engine: receive / process / retry
      handler.ts              pure business rules (no I/O at all)
      schema.ts               Zod validation of the wire format
      signature.ts            HMAC verification (pure)
      backoff.ts              retry schedule (pure)
      store.ts                the persistence interface
      prisma-store.ts         PostgreSQL implementation
      memory-store.ts         in-memory implementation (tests + demo mode)
      index.ts                composition root
    db.ts, env.ts, logger.ts, format.ts
```

### The processing pipeline

```
receive(rawBody, signatureHeader)
  ├─ verify HMAC signature            (401 if invalid)
  ├─ parse JSON + validate with Zod   (400 if invalid)
  ├─ look up providerEventId          ──► already seen? return { duplicate: true }, no writes
  ├─ upsert user, create event (RECEIVED)
  └─ runPipeline(event)
       ├─ record the attempt number   (BEFORE the transaction, so a rollback cannot reset the retry budget)
       ├─ BEGIN TRANSACTION
       │    ├─ planEffect()           pure: event -> wallet movement or none
       │    ├─ skip if a ledger entry already exists for this event
       │    ├─ applyWalletDelta()     atomic increment
       │    ├─ createTransaction()    unique on webhookEventId
       │    └─ mark the event PROCESSED
       ├─ COMMIT
       └─ on failure: record FAILED + lastError + nextRetryAt, log the attempt
```

### Three guarantees this design buys

1. **An event can never move money twice.** The unique index on
   `WalletTransaction.webhookEventId` is the backstop, and the pipeline checks
   for an existing entry before applying anything. A concurrent duplicate is
   detected, its own wallet movement is rolled back, and the event is settled as
   processed rather than reported as a failure.

2. **An event is never PROCESSED without its ledger entry.** The status change
   and the wallet movement are written in the same transaction, so they commit
   or roll back together. The attempt counter and the failure record are
   deliberately written *outside* that transaction — a rollback must not erase
   the fact that we tried.

3. **A duplicate delivery is a no-op.** `providerEventId` is unique. The second
   delivery returns `200 { duplicate: true }`, creates no event row and moves no
   money, even if the body changed.

### Error handling

Every failure is normalised into one `AppError` type carrying a `code`, an HTTP
`status` and a `retryable` flag. Route handlers use a single `handleRoute()`
wrapper, so there is exactly one place that turns a thrown error into a response
body:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "retryable": false, "details": { } } }
```

Errors are recognised by a structural marker rather than `instanceof`, because a
bundler can load the module more than once and two copies of a class make
`instanceof` silently fail — which turns a typed `409` into a `500`.

---

## API

| Method | Path                          | Purpose                                                        |
| ------ | ----------------------------- | -------------------------------------------------------------- |
| POST   | `/api/webhooks/payments`      | Receive a provider delivery. `202` new, `200` duplicate, `400` invalid, `401` bad signature |
| GET    | `/api/events`                 | Event history. `?status=FAILED&type=payment.succeeded&limit=50` |
| GET    | `/api/events/:id`             | One event with its user, attempt log and ledger entry           |
| POST   | `/api/events/:id/retry`       | Retry a FAILED event. `409` if it is not retryable              |
| GET    | `/api/wallets`                | Wallet balances and aggregate totals per currency               |
| GET    | `/api/transactions`           | The ledger, newest first                                        |
| GET    | `/api/dashboard`              | Totals, success rate, balances                                  |
| POST   | `/api/simulate`               | Build, sign and deliver a webhook (used by the Simulate page)   |

### Deliver one with curl

```bash
curl -X POST http://localhost:3000/api/webhooks/payments \
  -H "content-type: application/json" \
  -d '{
    "id": "evt_manual_1",
    "type": "payment.succeeded",
    "data": {
      "user": { "email": "ada@example.com", "name": "Ada Lovelace" },
      "amountCents": 2500,
      "currency": "usd",
      "reference": "order_1001"
    }
  }'
```

Send the same `id` again to see duplicate detection. Add
`"simulate": "transient_error"` inside `data` to make the first attempt fail, so
you have something to retry. `"simulate": "permanent_error"` fails forever.

When `WEBHOOK_SIGNING_SECRET` is set, add the signature header:

```
x-webhook-signature: t=<unix seconds>,v1=<HMAC-SHA256 hex of "t.body">
```

The **Simulate** page does all of this for you and shows the recorded outcome.

---

## Environment variables

| Variable                 | Default                     | Purpose                                                        |
| ------------------------ | --------------------------- | -------------------------------------------------------------- |
| `DATABASE_URL`           | *(unset)*                   | PostgreSQL connection string. Unset ⇒ in-memory demo mode.      |
| `WEBHOOK_SIGNING_SECRET` | *(unset)*                   | When set, `x-webhook-signature` is required and verified.       |
| `WEBHOOK_MAX_ATTEMPTS`   | `3`                         | Attempts (first delivery + retries) before an event stays FAILED |
| `WEBHOOK_BACKOFF_BASE_MS`| `5000`                      | Base delay for exponential retry backoff                        |
| `LOG_LEVEL`              | `info` (`error` in tests)   | `debug` \| `info` \| `warn` \| `error`                          |

---

## Scripts

| Script                 | Does                                              |
| ---------------------- | ------------------------------------------------- |
| `npm run dev`          | Development server                                |
| `npm run build`        | Production build                                  |
| `npm start`            | Serve the production build                        |
| `npm test`             | Run the full test suite                           |
| `npm run typecheck`    | `tsc --noEmit`                                    |
| `npm run db:push`      | Apply the Prisma schema to the database           |
| `npm run db:migrate`   | Create a migration                                |
| `npm run db:seed`      | Seed a realistic dataset (skips if data exists)   |
| `npm run db:studio`    | Prisma Studio                                     |

---

## Data model

```
User ──┬── Wallet ──── WalletTransaction ──┐
       │                                    │ (unique)
       └── WebhookEvent ───────────────────┘
                └── WebhookAttempt   (one row per processing attempt)
```

Money is stored as integer cents everywhere (`amountCents`, `balanceCents`), so
balances never drift. Balances are only ever changed by the pipeline, inside the
transaction that also records the event.

---

## Notes and limitations

- Retries are triggered by hand, from the UI. `nextRetryAt` is computed and
  stored with exponential backoff, but there is no background worker draining
  due retries — a real deployment would add one (`process()` already does the
  work; it just needs a scheduler calling it).
- A manual retry is allowed even after automatic retries are exhausted, on
  purpose: an operator looking at the dashboard is the last line of defence.
- The in-memory store serialises transactions. PostgreSQL gets the same effect
  with row locks; serialising is what keeps the in-memory rollback provably safe.
- The simulator's `transient_error` fault clears after the first attempt, so
  "fails once, then succeeds on retry" is demonstrable without editing code.#   W e b h o o k L a b  
 