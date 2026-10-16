import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIENT_STATE_MAX_BYTES, ClientStateStore } from "./clientState.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "client-state-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("ClientStateStore", () => {
  it("keeps one object per client and starts empty", () => {
    const store = new ClientStateStore(root);
    expect(store.get("chat")).toEqual({});
    store.set("chat", { homeContextId: "ctx-1" });
    store.set("other", { a: 1 });
    expect(new ClientStateStore(root).get("chat")).toEqual({ homeContextId: "ctx-1" });
    expect(store.get("other")).toEqual({ a: 1 });
  });

  it("writes atomically and leaves no scratch file", () => {
    const store = new ClientStateStore(root);
    store.set("chat", { a: 1 });
    store.set("chat", { a: 2 });
    const dir = path.join(root, "chat");
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
    expect(fs.statSync(path.join(dir, "state.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses non-objects and oversized state, keeping the previous value", () => {
    const store = new ClientStateStore(root);
    store.set("chat", { keep: true });
    expect(() => store.set("chat", [1])).toThrow("JSON object");
    expect(() => store.set("chat", { big: "x".repeat(CLIENT_STATE_MAX_BYTES) })).toThrow("limited");
    expect(store.get("chat")).toEqual({ keep: true });
  });

  it("cannot be steered out of its root by a client id", () => {
    const store = new ClientStateStore(root);
    store.set("../escape", { a: 1 });
    expect(fs.existsSync(path.join(root, "..", "escape"))).toBe(false);
    expect(store.get("../escape")).toEqual({ a: 1 });
  });
});
