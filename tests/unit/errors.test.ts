import { describe, expect, it } from "vitest";
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  handleRoute,
  toAppError,
  toErrorResponse,
} from "@/lib/errors";

describe("error handling", () => {
  it("maps a validation error to a 400 with a machine-readable code", async () => {
    const response = toErrorResponse(new ValidationError("bad payload", { issues: [] }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.retryable).toBe(false);
    expect(body.error.details).toEqual({ issues: [] });
  });

  it("maps a conflict to a 409", () => {
    expect(toErrorResponse(new ConflictError("nope")).status).toBe(409);
  });

  it("maps a missing resource to a 404", () => {
    expect(toErrorResponse(new NotFoundError("WebhookEvent", "evt_1")).status).toBe(404);
  });

  it("hides the internals of an unexpected error behind a 500", () => {
    const response = toErrorResponse(new Error("connection string leaked here"));
    expect(response.status).toBe(500);
    return response.json().then((body) => {
      expect(body.error.code).toBe("INTERNAL_ERROR");
      expect(body.error.message).toBe("connection string leaked here");
    });
  });

  it("wraps a non-Error throw into an AppError", () => {
    const error = toAppError("just a string");
    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(500);
  });

  it("passes an AppError through untouched", () => {
    const original = new ValidationError("keep me");
    expect(toAppError(original)).toBe(original);
  });

  it("turns a thrown error inside handleRoute into a JSON error response", async () => {
    const response = await handleRoute(
      async () => {
        throw new ConflictError("already processed");
      },
      () => Response.json({ ok: true }),
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.message).toBe("already processed");
  });

  it("returns the handler result when nothing throws", async () => {
    const response = await handleRoute(
      async () => ({ ok: true }),
      (result) => Response.json(result),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});