import { it } from "vitest";

export function ledgerTest(id: string, fn: () => void | Promise<void>, timeout?: number): void {
  if (timeout === undefined) {
    it(`ledger:${id}`, fn);
  } else {
    it(`ledger:${id}`, fn, timeout);
  }
}
