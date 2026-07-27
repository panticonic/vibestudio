import { it } from "vitest";

/**
 * Marks a workspace test as evidence for one runtime-foundation ledger claim.
 *
 * This lives with workspace tests so the workspace template never reaches into
 * a host-private test root.
 */
export function ledgerTest(id: string, fn: () => void | Promise<void>, timeout?: number): void {
  if (timeout === undefined) {
    it(`ledger:${id}`, fn);
  } else {
    it(`ledger:${id}`, fn, timeout);
  }
}
