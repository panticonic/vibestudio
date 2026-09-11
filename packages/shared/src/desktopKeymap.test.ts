import { describe, expect, it } from "vitest";
import {
  desktopAccelerator,
  desktopBindingFor,
  desktopChords,
  desktopKeyPlatform,
  desktopNeutralShortcutLabel,
  desktopShortcutLabel,
  desktopShortcutTokens,
  matchesDesktopBinding,
  type DesktopKeyInput,
} from "./desktopKeymap.js";

function input(partial: Partial<DesktopKeyInput> & { key: string }): DesktopKeyInput {
  return { ctrl: false, shift: false, alt: false, meta: false, ...partial };
}

describe("desktop keymap", () => {
  it("binds the chords a browser binds for history navigation", () => {
    // The gap this table was written for: both the context menu and the
    // shortcuts page advertised Alt+Left, and nothing in the app bound it.
    expect(desktopAccelerator("back", "other")).toBe("Alt+Left");
    expect(desktopAccelerator("forward", "other")).toBe("Alt+Right");
    expect(desktopAccelerator("back", "mac")).toBe("Cmd+Left");
    expect(desktopChords("back", "mac")).toContain("Cmd+[");
  });

  it("keeps reload and force-reload where a browser puts them", () => {
    expect(desktopAccelerator("reload", "other")).toBe("Ctrl+R");
    expect(desktopAccelerator("forceReload", "other")).toBe("Ctrl+Shift+R");
    // The previous bindings, kept as unadvertised chords so a user who learned
    // them is not punished for the correction.
    expect(desktopChords("forceReload", "other")).toContain("Ctrl+Alt+R");
    expect(desktopChords("focusAddress", "other")).toContain("Ctrl+Shift+L");
  });

  it("does not spend Ctrl+Y on history where that chord means redo", () => {
    expect(desktopAccelerator("history", "other")).toBe("Ctrl+H");
    expect(desktopAccelerator("history", "mac")).toBe("Cmd+Y");
  });

  it("matches every spelling of zooming in", () => {
    for (const key of ["+", "="]) {
      expect(
        matchesDesktopBinding("zoomIn", input({ key, ctrl: true, code: "Equal" }), "other")
      ).toBe(true);
    }
    expect(
      matchesDesktopBinding(
        "zoomIn",
        input({ key: "+", ctrl: true, shift: true, code: "Equal" }),
        "other"
      )
    ).toBe(true);
  });

  it("matches a letter chord by physical key as well as by character", () => {
    expect(matchesDesktopBinding("reload", input({ key: "r", ctrl: true }), "other")).toBe(true);
    expect(
      matchesDesktopBinding("reload", input({ key: "®", code: "KeyR", ctrl: true }), "other")
    ).toBe(true);
    expect(matchesDesktopBinding("reload", input({ key: "r", meta: true }), "mac")).toBe(true);
    // The primary modifier is not interchangeable: Ctrl+R on a Mac is not reload.
    expect(matchesDesktopBinding("reload", input({ key: "r", ctrl: true }), "mac")).toBe(false);
  });

  it("does not match a chord that carries an extra modifier", () => {
    expect(
      matchesDesktopBinding("reload", input({ key: "r", ctrl: true, shift: true }), "other")
    ).toBe(false);
    expect(
      matchesDesktopBinding("forceReload", input({ key: "r", ctrl: true, shift: true }), "other")
    ).toBe(true);
  });

  it("matches function keys and arrows", () => {
    expect(matchesDesktopBinding("reload", input({ key: "F5" }), "other")).toBe(true);
    expect(matchesDesktopBinding("findNext", input({ key: "F3" }), "other")).toBe(true);
    expect(matchesDesktopBinding("findPrevious", input({ key: "F3", shift: true }), "other")).toBe(
      true
    );
    expect(matchesDesktopBinding("back", input({ key: "ArrowLeft", alt: true }), "other")).toBe(
      true
    );
    expect(matchesDesktopBinding("back", input({ key: "ArrowLeft" }), "other")).toBe(false);
  });

  it("resolves the first binding a key event performs", () => {
    expect(
      desktopBindingFor(input({ key: "l", ctrl: true }), "other", [
        "reload",
        "focusAddress",
        "findInPage",
      ])
    ).toBe("focusAddress");
    expect(desktopBindingFor(input({ key: "q" }), "other", ["reload"])).toBeNull();
  });

  it("renders chords the way each platform writes them", () => {
    expect(desktopShortcutTokens("back", "other")).toEqual(["Alt", "←"]);
    expect(desktopShortcutTokens("back", "mac")).toEqual(["⌘", "←"]);
    expect(desktopShortcutLabel("reload", "other")).toBe("Ctrl+R");
    expect(desktopShortcutLabel("reload", "mac")).toBe("⌘R");
  });

  it("writes one label for a surface that renders on both platforms", () => {
    expect(desktopNeutralShortcutLabel("reload")).toBe("Cmd/Ctrl+R");
    expect(desktopNeutralShortcutLabel("stop")).toBe("Esc");
    expect(desktopNeutralShortcutLabel("back")).toBe("Cmd+Left / Alt+Left");
  });

  it("reads the platform from what the host or the browser reports", () => {
    expect(desktopKeyPlatform("darwin")).toBe("mac");
    expect(desktopKeyPlatform("MacIntel")).toBe("mac");
    expect(desktopKeyPlatform("win32")).toBe("other");
    expect(desktopKeyPlatform("linux")).toBe("other");
  });
});
