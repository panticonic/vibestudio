import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PanelLayoutStore } from "./panelLayoutStore.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "layout-store-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PanelLayoutStore", () => {
  it("returns null when no layout has been persisted", () => {
    const store = new PanelLayoutStore(tempDir());
    expect(store.get("ws-1", "user-1")).toBeNull();
  });

  it("round-trips an opaque blob across a reload, keyed per workspace and account", () => {
    const dir = tempDir();
    const store = new PanelLayoutStore(dir);
    const layout = { version: 1, columns: [{ id: "col-a", panes: [] }] };
    store.set("ws-1", "user-1", layout);
    store.set("ws-1", "user-2", "other");

    const reloaded = new PanelLayoutStore(dir);
    expect(reloaded.get("ws-1", "user-1")).toEqual(layout);
    expect(reloaded.get("ws-1", "user-2")).toBe("other");
    expect(reloaded.get("ws-2", "user-1")).toBeNull();
  });

  it("tolerates a corrupt file by returning null", () => {
    const dir = tempDir();
    const store = new PanelLayoutStore(dir);
    store.set("ws-1", "user-1", { ok: true });
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file!), "{not json", "utf8");
    expect(new PanelLayoutStore(dir).get("ws-1", "user-1")).toBeNull();
  });

  it("encodes path-hostile ids so keys cannot escape the store directory", () => {
    const dir = tempDir();
    const store = new PanelLayoutStore(dir);
    store.set("../ws", "user/../x", { safe: true });
    expect(store.get("../ws", "user/../x")).toEqual({ safe: true });
    for (const file of readdirSync(dir)) {
      expect(file.startsWith("panel-layout.")).toBe(true);
      expect(file.includes("/")).toBe(false);
    }
  });
});
