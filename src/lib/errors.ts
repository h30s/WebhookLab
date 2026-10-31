/**
 * One error shape for the whole application.
 *
 * Every failure that crosses a boundary (service -> API route -> HTTP
 * response) is normalised into an `AppError`. That gives us a single
 * `toErrorResponse()` mapping instead of ad-hoc `if (err instanceof ...)`
 * chains in every route handler.
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "SIGNATURE_INVALID"
  | "NOT_FOUND"
  | "CONFLICT"
  | "DUPLICATE_LEDGER_ENTRY"
  | "TRANSIENT_PROCESSING_ERROR"
  | "PROCESSING_ERROR"
  | "INSUFFICIENT_FUNDS"
  | "INTERNAL_ERROR";

export interface AppErrorOptions {
  /** Machine-readable code returned in the JSON error body. */
  code: ErrorCode;
  /** HTTP status to use when this error reaches a route handler. */
  status: number;
  /** Whether a retry could plausibly succeed. */
  retryable?: boolean;
  /** Extra, non-sensitive context (field names, ids, ...). */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  /**
   * Structural brand.
   *
   * Errors are recognised by this marker rather than with `instanceof`,
   * because a bundler can load this module more than once (Next.js bundles
   * each route separately). Two copies means two `AppError` classes, and
   * `instanceof` would silently fail - turning a typed 409 into a 500.
   */
  readonly isAppError = true as const;
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: AppErrorOptions) {
    super(message);
    this.name = "AppError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** True when `value` is one of our errors, whichever copy of this module made it. */
export function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AppError>;
  return (
    candidate.isAppError === true &&
    typeof candidate.code === "string" &&
    typeof candidate.status === "number" &&
    typeof candidate.message === "string"
  );
}

/** Bad input from the caller. Never retryable. */
export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "VALIDATION_ERROR", status: 400, details });
    this.name = "ValidationError";
  }
}

/** The `x-webhook-signature` header did not match the payload. */
export class SignatureError extends AppError {
  constructor(message = "Webhook signature verification failed") {
    super(message, { code: "SIGNATURE_INVALID", status: 401 });
    this.name = "SignatureError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} ${id} was not found`, { code: "NOT_FOUND", status: 404, details: { id } });
    this.name = "NotFoundError";
  }
}

/** The request was understood but the current state forbids it. */
export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "CONFLICT", status: 409, details });
    this.name = "ConflictError";
  }
}

/** Something downstream was temporarily unavailable. Retryable. */
export class TransientProcessingError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "TRANSIENT_PROCESSING_ERROR", status: 503, retryable: true, cause });
    this.name = "TransientProcessingError";
  }
}

/** The event is well-formed but cannot be applied. Never retryable. */
export class ProcessingError extends AppError {
  constructor(message: string, code: ErrorCode = "PROCESSING_ERROR", details?: Record<string, unknown>) {
    super(message, { code, status: 422, details });
    this.name = "ProcessingError";
  }
}

export class InsufficientFundsError extends ProcessingError {
  constructor(availableCents: number, requestedCents: number) {
    super(
      `Insufficient funds: the wallet holds ${availableCents} but this event requires ${requestedCents}`,
      "INSUFFICIENT_FUNDS",
      { availableCents, requestedCents },
    );
    this.name = "InsufficientFundsError";
  }
}

/**
 * Another worker already wrote the ledger entry for this event.
 *
 * Raised from the store when the unique constraint on
 * `WalletTransaction.webhookEventId` is violated, which is the database-level
 * guarantee that an event can never move money twice.
 */
export class DuplicateLedgerEntryError extends AppError {
  constructor(webhookEventId: string) {
    super(`A ledger entry already exists for webhook event ${webhookEventId}`, {
      code: "DUPLICATE_LEDGER_ENTRY",
      status: 409,
      details: { webhookEventId },
    });
    this.name = "DuplicateLedgerEntryError";
  }
}

/**
 * Wrap anything thrown into an `AppError`.
 *
 * Unknown errors become a generic 500 so internal details never leak into an
 * HTTP response body.
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    return new AppError(error.message, { code: "INTERNAL_ERROR", status: 500, cause: error });
  }
  return new AppError("An unknown error occurred", { code: "INTERNAL_ERROR", status: 500 });
}

export interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

/** The single JSON error body every API route returns. */
export function toErrorResponse(error: unknown): Response {
  const appError = toAppError(error);
  const body: ErrorResponseBody = {
    error: {
      code: appError.code,
      message: appError.message,
      retryable: appError.retryable,
      ...(appError.details ? { details: appError.details } : {}),
    },
  };
  return Response.json(body, { status: appError.status });
}

/**
 * Run a route handler and convert any thrown error into the shared JSON error
 * response. Keeps every route handler free of try/catch boilerplate.
 */
export async function handleRoute<T>(
  handler: () => Promise<T>,
  toResponse: (result: T) => Response,
): Promise<Response> {
  try {
    return toResponse(await handler());
  } catch (error) {
    return toErrorResponse(error);
  }
}