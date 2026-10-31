import { describe, expect, it } from "vitest";
import { parseSignatureHeader, signPayload, verifySignature } from "@/lib/webhook/signature";

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({ id: "evt_1", type: "payment.succeeded" });
const NOW = 1_800_000_000;

describe("webhook signature", () => {
  it("accepts a signature it produced itself", () => {
    const header = signPayload(BODY, SECRET, NOW);
    const result = verifySignature(BODY, header, SECRET, { now: () => NOW });
    expect(result).toEqual({ valid: true });
  });

  it("rejects a body that was tampered with after signing", () => {
    const header = signPayload(BODY, SECRET, NOW);
    const tampered = JSON.stringify({ id: "evt_1", type: "payment.succeeded", extra: true });
    const result = verifySignature(tampered, header, SECRET, { now: () => NOW });
    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("rejects a signature produced with a different secret", () => {
    const header = signPayload(BODY, "whsec_other", NOW);
    const result = verifySignature(BODY, header, SECRET, { now: () => NOW });
    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("rejects a missing header", () => {
    expect(verifySignature(BODY, null, SECRET)).toEqual({ valid: false, reason: "missing_header" });
  });

  it("rejects a malformed header", () => {
    expect(verifySignature(BODY, "not-a-signature", SECRET)).toEqual({
      valid: false,
      reason: "malformed_header",
    });
  });

  it("rejects a replayed payload outside the tolerance window", () => {
    const header = signPayload(BODY, SECRET, NOW);
    const result = verifySignature(BODY, header, SECRET, { now: () => NOW + 3600 });
    expect(result).toEqual({ valid: false, reason: "timestamp_out_of_tolerance" });
  });

  it("accepts a payload inside the tolerance window", () => {
    const header = signPayload(BODY, SECRET, NOW);
    const result = verifySignature(BODY, header, SECRET, { now: () => NOW + 60, toleranceSeconds: 300 });
    expect(result).toEqual({ valid: true });
  });

  it("skips the timestamp check when tolerance is disabled", () => {
    const header = signPayload(BODY, SECRET, NOW);
    const result = verifySignature(BODY, header, SECRET, { now: () => NOW + 999_999, toleranceSeconds: 0 });
    expect(result).toEqual({ valid: true });
  });

  it("parses the header it writes", () => {
    const header = signPayload(BODY, SECRET, NOW);
    const parsed = parseSignatureHeader(header);
    expect(parsed?.timestamp).toBe(NOW);
    expect(parsed?.signature).toMatch(/^[0-9a-f]{64}$/);
  });
});