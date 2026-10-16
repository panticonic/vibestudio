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
    const { version: _version, ...receipt } = terminal;
    expect(restarted.begin("operation", input)).toEqual({
      ...receipt,
      version: expect.any(String),
    });
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
      version: expect.any(String),
    });
  });
  it("retains saved counts across application failure and restart", () => {
    const ledgerPath = file();
    const input = { sourceId: "source", dataTypes: ["cookies" as const] };
    const counts = [{ dataType: "cookies" as const, read: 2, stored: 2, skipped: 0, errors: 0 }];
    const first = new SensitiveBrowserImportLedger(ledgerPath);
    first.begin("operation", input);
    first.applying("operation", input, counts);
    first.applicationFailed("operation", "Apply saved cookies again");
    const restarted = new SensitiveBrowserImportLedger(ledgerPath);
    expect(restarted.running()).toEqual([{ operationId: "operation", input }]);
    expect(restarted.observe("operation")).toMatchObject({ state: "application_failed", counts });
    restarted.applying("operation", input, counts);
    expect(restarted.complete("operation", input, counts)).toEqual({
      operationId: "operation",
      state: "complete",
      counts,
      version: expect.any(String),
    });
  });

  it("resolves a versioned observation on the next change, not before", async () => {
    const ledger = new SensitiveBrowserImportLedger(file());
    const input = { sourceId: "source", dataTypes: ["passwords" as const] };
    const started = ledger.begin("operation", input);
    let settled = false;
    const next = ledger.observeAfter("operation", started.version).then((status) => {
      settled = true;
      return status;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const progressed = ledger.progress("operation", input, {
      dataType: "passwords",
      read: 4,
      stored: 3,
      skipped: 1,
      errors: 0,
    });
    await expect(next).resolves.toEqual(progressed);
    expect(progressed.version).not.toBe(started.version);
    await expect(ledger.observeAfter("operation", started.version)).resolves.toEqual(progressed);
  });

  it("answers at once for terminal imports and settles waits on abort or release", async () => {
    const ledger = new SensitiveBrowserImportLedger(file());
    const input = { sourceId: "source", dataTypes: ["passwords" as const] };
    const started = ledger.begin("operation", input);

    const aborted = new AbortController();
    const abandoned = ledger.observeAfter("operation", started.version, aborted.signal);
    aborted.abort(new Error("caller left"));
    await expect(abandoned).rejects.toThrow("caller left");

    const released = ledger.observeAfter("operation", started.version);
    ledger.releaseWaiters(new Error("host stopped"));
    await expect(released).rejects.toThrow("host stopped");

    const cancelled = ledger.cancel("operation");
    await expect(ledger.observeAfter("operation", cancelled.version)).resolves.toEqual(cancelled);
  });
});
