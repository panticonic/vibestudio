import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { PaletteCommand } from "@vibestudio/shared/types";
import { createPaletteService } from "./paletteService.js";
import type { ViewManager } from "../viewManager.js";

// A real leaf-panel caller (kind "panel") — the actual contributor of palette
// commands. The previous test faked a chrome "app" with panel-hosting, which
// hid the bug that real panels (no panel-hosting, kind "panel") were rejected.
const panelCtx: ServiceContext = {
  caller: createVerifiedCaller("@workspace-panels/chat", "panel"),
  authority: {
    allows: vi.fn(async () => false),
    assert: vi.fn(async () => undefined),
  },
};
// Native-host shell (bootstrap launch gate / electron-main) — chrome.
const shellCtx: ServiceContext = {
  caller: createVerifiedCaller("shell", "shell"),
  authority: {
    allows: vi.fn(async ({ capability }) => capability === "panel-hosting"),
    assert: vi.fn(async () => undefined),
  },
};
// The hosted workspace shell — resolves as kind:"app" (apps/shell), authorized
// chrome. The old `kind === "shell"` gate silently rejected this, dropping every
// panel-contributed command (the bug that motivated this whole change).
const hostedShellCtx: ServiceContext = {
  caller: createVerifiedCaller("@workspace-apps/shell", "app"),
  authority: {
    allows: vi.fn(async ({ capability }) => capability === "panel-hosting"),
    assert: vi.fn(async () => undefined),
  },
};
// An arbitrary workspace app must NOT enumerate/dispatch across panels.
const otherAppCtx: ServiceContext = {
  caller: createVerifiedCaller("@workspace-apps/news", "app"),
  authority: {
    allows: vi.fn(async () => false),
    assert: vi.fn(async () => undefined),
  },
};

function harness() {
  const registry = new Map<string, PaletteCommand[]>();
  const runPaletteCommand = vi.fn();
  const orchestrator = {
    registerPaletteCommands: (panelId: string, commands: PaletteCommand[]) =>
      registry.set(panelId, commands),
    unregisterPaletteCommands: (panelId: string) => registry.delete(panelId),
    listPaletteCommands: () =>
      [...registry.entries()].map(([panelId, commands]) => ({ panelId, commands })),
    runPaletteCommand,
  };
  // Only the workspace shell view carries panel-hosting + source apps/shell.
  const viewManager = {
    getViewInfo: (id: string) =>
      id === "@workspace-apps/shell"
        ? { type: "app", capabilities: ["panel-hosting"], appIdentity: { source: "apps/shell" } }
        : { type: "app", capabilities: [], appIdentity: { source: "apps/news" } },
  } as unknown as ViewManager;
  const service = createPaletteService({
    panelOrchestrator: orchestrator as never,
    getViewManager: () => viewManager,
  });
  return { service, registry, runPaletteCommand };
}

describe("paletteService", () => {
  it("a leaf panel registers its own commands; the hosted shell lists + dispatches them", async () => {
    const { service, registry, runPaletteCommand } = harness();
    const commands: PaletteCommand[] = [{ id: "c1", label: "Do thing", section: "Panel" }];

    // Register works for a real panel caller (no capability gate; scoped by id).
    await service.handler(panelCtx, "register", [commands]);
    expect(registry.get("@workspace-panels/chat")).toEqual(commands);

    // The hosted workspace shell (kind:"app", apps/shell) enumerates + dispatches.
    const listed = await service.handler(hostedShellCtx, "list", []);
    expect(listed).toEqual([{ panelId: "@workspace-panels/chat", commands }]);

    await service.handler(hostedShellCtx, "run", ["@workspace-panels/chat", "c1"]);
    expect(runPaletteCommand).toHaveBeenCalledWith("@workspace-panels/chat", "c1");

    // A native-host shell is also chrome and may list.
    expect(await service.handler(shellCtx, "list", [])).toHaveLength(1);

    await service.handler(panelCtx, "unregister", []);
    expect(registry.size).toBe(0);
  });

  it("restricts list/run to chrome — panels and arbitrary apps are rejected", async () => {
    const { service } = harness();
    await expect(service.handler(panelCtx, "list", [])).rejects.toThrow(/panel-hosting/);
    await expect(service.handler(panelCtx, "run", ["p", "c"])).rejects.toThrow(/panel-hosting/);
    // An arbitrary app lacking panel-hosting/apps/shell cannot either.
    await expect(service.handler(otherAppCtx, "list", [])).rejects.toThrow();
    await expect(service.handler(otherAppCtx, "run", ["p", "c"])).rejects.toThrow();
  });
});
