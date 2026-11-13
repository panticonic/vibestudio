import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PanelRuntimeStore } from "./panelRuntimeStore.js";

describe("PanelRuntimeStore", () => {
  const dirs: string[] = [];
  const open = (now = () => 1) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-runtime-store-"));
    dirs.push(dir);
    return new PanelRuntimeStore({ databasePath: path.join(dir, "panel-runtime.db"), now });
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("proves builds once and never un-proves them", () => {
    const store = open();
    expect(store.proofOf("d1")).toBe("unproven");
    expect(store.recordProof("d1", { state: "failed", failure: { code: "boot" } })).toEqual({
      state: "failed",
      changed: true,
    });
    expect(store.failureOf("d1")).toEqual({ code: "boot" });
    expect(store.recordProof("d1", { state: "failed", failure: {} }).changed).toBe(false);
    expect(store.recordProof("d1", { state: "proven" })).toEqual({
      state: "proven",
      changed: true,
    });
    expect(store.recordProof("d1", { state: "failed", failure: {} })).toEqual({
      state: "proven",
      changed: false,
    });
    expect(store.failureOf("d1")).toBeNull();
  });

  it("keeps durable presentation requests per slot and device", () => {
    const store = open();
    store.request({ slotId: "s1", deviceId: "phone", focus: true, alert: "inbox" });
    store.request({ slotId: "s1", deviceId: "tablet", focus: false, alert: "none" });
    store.request({ slotId: "s1", deviceId: "phone", focus: false, alert: "interrupt" });
    expect(store.pending("phone")).toEqual([
      { slotId: "s1", deviceId: "phone", focus: false, alert: "interrupt", requestedAt: 1 },
    ]);
    expect(store.pending()).toHaveLength(2);
    expect(store.clear("s1", "phone")).toBe(true);
    expect(store.clear("s1", "phone")).toBe(false);
    expect(store.clearSlot("s1")).toBe(1);
    expect(store.pending()).toEqual([]);
  });

  it("persists across reopen", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-runtime-store-"));
    dirs.push(dir);
    const file = path.join(dir, "panel-runtime.db");
    const a = new PanelRuntimeStore({ databasePath: file });
    a.recordProof("d", { state: "proven" });
    a.request({ slotId: "s", deviceId: "phone", focus: true, alert: "none" });
    a.close();
    const b = new PanelRuntimeStore({ databasePath: file });
    expect(b.proofOf("d")).toBe("proven");
    expect(b.pending("phone")).toHaveLength(1);
    b.close();
  });
});
