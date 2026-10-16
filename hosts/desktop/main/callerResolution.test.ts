import { describe, expect, it } from "vitest";
import { isPanelHostingClientView, resolveElectronViewCaller } from "./callerResolution.js";

describe("Electron caller resolution", () => {
  it("resolves a view to the principal kind of its type", () => {
    expect(resolveElectronViewCaller("panel-1", { type: "panel" })).toEqual({
      callerId: "panel-1",
      callerKind: "panel",
    });
    expect(resolveElectronViewCaller("window:chat:1", { type: "client" })).toEqual({
      callerId: "window:chat:1",
      callerKind: "client",
    });
  });

  it("recognizes only the panel-hosting client view as chrome", () => {
    expect(isPanelHostingClientView({ type: "client", hostChrome: true })).toBe(true);
    expect(isPanelHostingClientView({ type: "client" })).toBe(false);
    expect(isPanelHostingClientView({ type: "panel", hostChrome: true })).toBe(false);
    expect(isPanelHostingClientView(null)).toBe(false);
  });

  it("never invents a host: a renderer with no view metadata is unknown", () => {
    expect(() => resolveElectronViewCaller("shell", null)).toThrow(/Unknown Electron view caller/);
    expect(() => resolveElectronViewCaller("panel-1", null)).toThrow(
      /Unknown Electron view caller/
    );
  });
});
