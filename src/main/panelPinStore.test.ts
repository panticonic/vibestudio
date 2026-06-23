import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PanelPinStore } from "./panelPinStore.js";

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pin-store-"));
  dirs.push(dir);
  return join(dir, "panel-pins.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PanelPinStore", () => {
  it("starts empty when the file does not exist", () => {
    const store = new PanelPinStore(tempFile());
    expect(store.list()).toEqual([]);
    expect(store.has("panel:tree/a")).toBe(false);
  });

  it("toggles and persists across a reload (round-trip)", () => {
    const file = tempFile();
    const store = new PanelPinStore(file);
    expect(store.toggle("panel:tree/a")).toBe(true);
    expect(store.toggle("panel:tree/b")).toBe(true);
    expect(store.has("panel:tree/a")).toBe(true);

    // A fresh instance reads the persisted file synchronously.
    const reloaded = new PanelPinStore(file);
    expect(new Set(reloaded.list())).toEqual(new Set(["panel:tree/a", "panel:tree/b"]));
  });

  it("toggle returns the new state and removes on second toggle", () => {
    const store = new PanelPinStore(tempFile());
    expect(store.toggle("panel:tree/a")).toBe(true);
    expect(store.toggle("panel:tree/a")).toBe(false);
    expect(store.has("panel:tree/a")).toBe(false);
  });

  it("prune drops ids no longer in the tree and persists", () => {
    const file = tempFile();
    const store = new PanelPinStore(file);
    store.toggle("panel:tree/keep");
    store.toggle("panel:tree/gone");

    store.prune(["panel:tree/keep"]);
    expect(store.has("panel:tree/keep")).toBe(true);
    expect(store.has("panel:tree/gone")).toBe(false);

    // Persisted: a reload reflects the prune.
    const reloaded = new PanelPinStore(file);
    expect(reloaded.list()).toEqual(["panel:tree/keep"]);
  });
});
