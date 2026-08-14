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

  it("binds the command palette to CmdOrCtrl+K on every platform", () => {
    // Off-mac this used to be Ctrl+Shift+K, which quickfire now owns.
    expect(find("Command Palette")?.accelerator).toBe("CmdOrCtrl+K");
  });

  it("binds quickfire to CmdOrCtrl+Shift+K", () => {
    expect(find("Ask About This Panel")?.accelerator).toBe("CmdOrCtrl+Shift+K");
  });

  it("offers exactly one item per overlay entry point", () => {
    expect(items().filter((item) => item.label?.startsWith("Command Palette"))).toHaveLength(1);
    expect(items().filter((item) => item.label?.startsWith("Ask About This Panel"))).toHaveLength(
      1
    );
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
