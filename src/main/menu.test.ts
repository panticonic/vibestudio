import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { name: "Vibestudio" },
  dialog: { showMessageBox: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
}));

import type { MenuItemConstructorOptions } from "electron";
import {
  desktopAccelerator,
  desktopChords,
  desktopKeyPlatform,
} from "@vibestudio/shared/desktopKeymap";
import { buildHamburgerMenuTemplate, chromeOwnedBinding } from "./menu.js";

const keyPlatform = desktopKeyPlatform(process.platform);

function flatten(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) =>
    Array.isArray(item.submenu) ? [item, ...flatten(item.submenu)] : [item]
  );
}

describe("overlay accelerators", () => {
  const items = () => flatten(buildHamburgerMenuTemplate({} as never, async () => {}));
  const find = (label: string) => items().find((item) => item.label?.startsWith(label));

  it("binds the overlay to the primary-modifier K chord on every platform", () => {
    // Off-mac this used to be Ctrl+Shift+K. The chord now comes from the one
    // keymap, so asserting a literal here would just restate it in a second
    // place — which is the drift this test would then be protecting.
    expect(find("Command")?.accelerator).toBe(desktopAccelerator("commandPalette", keyPlatform));
    expect(desktopChords("commandPalette", keyPlatform)).toHaveLength(1);
  });

  it("offers exactly one overlay entry point and no shift chord", () => {
    // One door: the overlay itself decides whether the input is a command, a
    // destination, or something to say to the panel's agent, and it resumes an
    // existing conversation on its own. A second accelerator would only
    // pre-expand the transcript.
    const overlayItems = items().filter((item) => item.label?.startsWith("Command"));
    expect(overlayItems).toHaveLength(1);
    expect(items().filter((item) => item.accelerator === "CmdOrCtrl+Shift+K")).toHaveLength(0);
  });
});

describe("native menu zoom shortcuts", () => {
  it("advertises the plain zoom chord and still accepts the shifted spellings", () => {
    // The menu used to advertise only `Ctrl+Shift+Plus` off-mac, on the
    // reasoning that a keyboard produces plus as shifted equals. That is true
    // of the hardware and false of the user, who presses Ctrl+= and expects to
    // zoom. The advertised chord is the plain one; the others still work.
    const template = buildHamburgerMenuTemplate({} as never, async () => {});
    const view = template.find((item) => item.label === "View");
    const zoomIn = Array.isArray(view?.submenu)
      ? view.submenu.find((item) => item.role === "zoomIn")
      : undefined;

    expect(zoomIn?.accelerator).toBe(desktopAccelerator("zoomIn", keyPlatform));
    expect(desktopChords("zoomIn", keyPlatform)).toEqual(
      expect.arrayContaining(
        keyPlatform === "mac"
          ? ["Cmd+Plus", "Cmd+=", "Cmd+Shift+Plus"]
          : ["Ctrl+Plus", "Ctrl+=", "Ctrl+Shift+Plus"]
      )
    );
  });
});

describe("chords the chrome owns wherever focus is", () => {
  const press = (partial: Partial<Electron.Input> & { key: string }): Electron.Input =>
    ({
      type: "keyDown",
      control: false,
      shift: false,
      alt: false,
      meta: false,
      ...partial,
    }) as Electron.Input;
  const primary = keyPlatform === "mac" ? { meta: true } : { control: true };

  it("claims navigation, reload, address and find from a focused page", () => {
    // Without this a page keeps these keys, which is the difference between
    // having browser shortcuts and their working: they are how you get out of
    // a page that is misbehaving.
    expect(chromeOwnedBinding(press({ key: "r", ...primary }))).toBe("reload");
    expect(chromeOwnedBinding(press({ key: "r", shift: true, ...primary }))).toBe("forceReload");
    expect(chromeOwnedBinding(press({ key: "l", ...primary }))).toBe("focusAddress");
    expect(chromeOwnedBinding(press({ key: "f", ...primary }))).toBe("findInPage");
    expect(chromeOwnedBinding(press({ key: "k", ...primary }))).toBe("commandPalette");
    expect(
      chromeOwnedBinding(
        keyPlatform === "mac"
          ? press({ key: "ArrowLeft", meta: true })
          : press({ key: "ArrowLeft", alt: true })
      )
    ).toBe("back");
  });

  it("leaves the page everything else, including the chord that closes a panel", () => {
    // Closing the panel someone is typing in is the one unrecoverable action
    // in this family, so it stays with the menu rather than the keyboard.
    expect(chromeOwnedBinding(press({ key: "w", ...primary }))).toBeNull();
    expect(chromeOwnedBinding(press({ key: "a", ...primary }))).toBeNull();
    expect(chromeOwnedBinding(press({ key: "s", ...primary }))).toBeNull();
    expect(chromeOwnedBinding(press({ key: "r" }))).toBeNull();
  });

  it("ignores key releases, which would double every press", () => {
    expect(
      chromeOwnedBinding({ ...press({ key: "r", ...primary }), type: "keyUp" } as Electron.Input)
    ).toBeNull();
  });
});
