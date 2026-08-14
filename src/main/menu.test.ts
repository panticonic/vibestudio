import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { name: "Vibestudio" },
  dialog: { showMessageBox: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
}));

import type { MenuItemConstructorOptions } from "electron";
import { buildHamburgerMenuTemplate } from "./menu.js";

function flatten(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) =>
    Array.isArray(item.submenu) ? [item, ...flatten(item.submenu)] : [item]
  );
}

describe("overlay accelerators", () => {
  const items = () => flatten(buildHamburgerMenuTemplate({} as never, async () => {}));
  const find = (label: string) => items().find((item) => item.label?.startsWith(label));

  it("binds the overlay to CmdOrCtrl+K on every platform", () => {
    // Off-mac this used to be Ctrl+Shift+K.
    expect(find("Command")?.accelerator).toBe("CmdOrCtrl+K");
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
  it("registers a shifted plus accelerator for zoom in", () => {
    const template = buildHamburgerMenuTemplate({} as never, async () => {});
    const view = template.find((item) => item.label === "View");
    const zoomIn = Array.isArray(view?.submenu)
      ? view.submenu.find((item) => item.role === "zoomIn")
      : undefined;

    expect(zoomIn?.accelerator).toBe(
      process.platform === "darwin" ? "Cmd+Plus" : "Ctrl+Shift+Plus"
    );
  });
});
