import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { E2E_CLEANUP_LEDGER_ENV, E2E_TEMP_ROOT_ENV } from "./e2eRun.js";
import {
  assertRunOwnedPath,
  cleanupRunTempRoot,
  registerRunCleanupPath,
  releaseRunCleanupPath,
} from "./e2eCleanupLedger.js";

describe("E2E cleanup ledger", () => {
  const roots: string[] = [];
  afterEach(() => {
    delete process.env[E2E_TEMP_ROOT_ENV];
    delete process.env[E2E_CLEANUP_LEDGER_ENV];
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("accepts only exact descendants of the owned run root", () => {
    expect(assertRunOwnedPath("/tmp/run/case-a", "/tmp/run")).toBe("/tmp/run/case-a");
    expect(() => assertRunOwnedPath("/tmp/run", "/tmp/run")).toThrow("strict descendant");
    expect(() => assertRunOwnedPath("/tmp/run-neighbor", "/tmp/run")).toThrow("strict descendant");
  });

  it("defers managed paths when a Playwright run owns them", () => {
    process.env[E2E_TEMP_ROOT_ENV] = "/tmp/run";
    expect(releaseRunCleanupPath("/tmp/run/case-a")).toBe(true);
  });

  it("joins canonical run retirement in the final cleanup phase", async () => {
    const retire = vi.fn(async () => {});
    await cleanupRunTempRoot("/tmp/run", retire);
    expect(retire).toHaveBeenCalledOnce();
  });

  it("records an unreleased fixture without preserving its dead worker's whole profile", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-cleanup-ledger-"));
    roots.push(root);
    process.env[E2E_TEMP_ROOT_ENV] = root;
    process.env[E2E_CLEANUP_LEDGER_ENV] = path.join(
      os.tmpdir(),
      `cleanup-${path.basename(root)}.jsonl`
    );
    roots.push(process.env[E2E_CLEANUP_LEDGER_ENV]!);
    registerRunCleanupPath(path.join(root, "case-a"));
    const retire = vi.fn(async () => fs.rmSync(root, { recursive: true, force: true }));
    await cleanupRunTempRoot(root, retire);
    expect(retire).toHaveBeenCalledOnce();
    expect(fs.existsSync(root)).toBe(false);
    const events = fs
      .readFileSync(process.env[E2E_CLEANUP_LEDGER_ENV]!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.find((event) => event.event === "unreleased-fixtures")).toMatchObject({
      pendingCount: 1,
      sample: [path.join(root, "case-a")],
    });
    expect(events.at(-1).event).toBe("run-cleanup-complete");
  });

  it("still retires resources when diagnostic ledger writing fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-cleanup-ledger-"));
    roots.push(root);
    const impossible = path.join(root, "not-a-directory");
    fs.writeFileSync(impossible, "file");
    process.env[E2E_CLEANUP_LEDGER_ENV] = path.join(impossible, "ledger");
    const retire = vi.fn(async () => {});
    await expect(cleanupRunTempRoot(root, retire)).rejects.toThrow();
    expect(retire).toHaveBeenCalledOnce();
  });

  it("retains an original retirement failure rather than reporting cleanup complete", async () => {
    const error = new Error("resource still live");
    await expect(
      cleanupRunTempRoot("/tmp/run", async () => {
        throw error;
      })
    ).rejects.toBe(error);
  });
});
