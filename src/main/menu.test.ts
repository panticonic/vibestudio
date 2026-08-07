import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { name: "Vibestudio" },
  dialog: { showMessageBox: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
}));

import { buildHamburgerMenuTemplate } from "./menu.js";

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
