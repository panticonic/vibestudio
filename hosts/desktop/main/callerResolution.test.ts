import { describe, expect, it } from "vitest";
import {
  callerKindForElectronViewType,
  isElectronShellChromeCaller,
  resolveElectronViewCaller,
} from "./callerResolution.js";

describe("Electron caller resolution", () => {
  it("resolves Electron view caller kinds through the principal-kind registry", () => {
    expect(callerKindForElectronViewType("shell")).toBe("shell");
    expect(callerKindForElectronViewType("panel")).toBe("panel");
    expect(callerKindForElectronViewType("app")).toBe("app");
  });

  it("recognizes only bootstrap and hosted app shell chrome", () => {
    expect(isElectronShellChromeCaller("shell", null)).toBe(true);
    expect(isElectronShellChromeCaller("apps/shell", { type: "app", hostChrome: true })).toBe(true);
    expect(isElectronShellChromeCaller("app", { type: "app" })).toBe(false);
    expect(isElectronShellChromeCaller("panel", { type: "panel", hostChrome: true })).toBe(false);
  });

  it("fails closed for unknown Electron view types", () => {
    expect(() => callerKindForElectronViewType("browser")).toThrow(
      /Unknown Electron view principal kind/
    );
    expect(() => callerKindForElectronViewType(undefined)).toThrow(
      /Unknown Electron view principal kind/
    );
  });

  it("does not silently treat missing view metadata as a panel", () => {
    expect(resolveElectronViewCaller("shell", null)).toEqual({
      callerId: "shell",
      callerKind: "shell",
    });
    expect(() => resolveElectronViewCaller("panel-1", null)).toThrow(
      /Unknown Electron view caller/
    );
  });
});
