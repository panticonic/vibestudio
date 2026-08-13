import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SensitiveBrowserImportLedger } from "./sensitiveBrowserImportLedger.js";

function file(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "sensitive-import-ledger-")), "ledger.json");
}

describe("SensitiveBrowserImportLedger", () => {
  it("replays an exact lost-response receipt after restart", () => {
    const ledgerPath = file();
    const input = { sourceId: "source", dataTypes: ["passwords" as const] };
    const first = new SensitiveBrowserImportLedger(ledgerPath);
    first.begin("operation", input);
    const terminal = first.complete("operation", input, [
      { dataType: "passwords", read: 2, stored: 2, skipped: 0, errors: 0 },
    ]);

    const restarted = new SensitiveBrowserImportLedger(ledgerPath);
    expect(restarted.begin("operation", input)).toEqual(terminal);
    expect(restarted.running()).toEqual([]);
  });

  it("retains a running claim for safe replay after restart", () => {
    const ledgerPath = file();
    const input = { sourceId: "source", dataTypes: ["cookies" as const, "formFill" as const] };
    new SensitiveBrowserImportLedger(ledgerPath).begin("operation", input);

    expect(new SensitiveBrowserImportLedger(ledgerPath).running()).toEqual([
      { operationId: "operation", input },
    ]);
  });

  it("rejects operation-id reuse with different inputs after restart", () => {
    const ledgerPath = file();
    new SensitiveBrowserImportLedger(ledgerPath).begin("operation", {
      sourceId: "source",
      dataTypes: ["cookies"],
    });
    const restarted = new SensitiveBrowserImportLedger(ledgerPath);
    expect(() =>
      restarted.begin("operation", { sourceId: "other", dataTypes: ["cookies"] })
    ).toThrow("different inputs");
  });

  it("durably records cancellation with the latest aggregate progress", () => {
    const ledgerPath = file();
    const input = { sourceId: "source", dataTypes: ["passwords" as const] };
    const first = new SensitiveBrowserImportLedger(ledgerPath);
    first.begin("operation", input);
    first.progress("operation", input, {
      dataType: "passwords",
      read: 10,
      stored: 8,
      skipped: 2,
      errors: 0,
    });
    first.cancel("operation");

    expect(new SensitiveBrowserImportLedger(ledgerPath).observe("operation")).toEqual({
      operationId: "operation",
      state: "cancelled",
      counts: [{ dataType: "passwords", read: 10, stored: 8, skipped: 2, errors: 0 }],
    });
  });
});
