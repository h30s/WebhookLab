/**
 * Balance arithmetic.
 *
 * Money is stored as integer minor units (cents) everywhere, so balances never
 * suffer floating point drift. Debits are allowed to take a balance negative
 * only when the caller has already validated the movement - see
 * `planEffect()` in `handler.ts`, which rejects refunds above the balance.
 */
export function applyWalletDelta(balanceCents: number, deltaCents: number): number {
  return balanceCents + deltaCents;
}

export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}