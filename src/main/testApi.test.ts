import { afterEach, expect, it, vi } from "vitest";
import type { PanelOrchestrator } from "./panelOrchestrator.js";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { PanelView } from "./panelView.js";
vi.mock("electron", () => ({ webContents: {} }));
import { setupTestApi, cleanupTestApi, type TestWorkspaceOwner } from "./testApi.js";

afterEach(() => {
  cleanupTestApi();
  vi.unstubAllEnvs();
});

it("keeps identical panel IDs and RPC reads with their captured workspace owner", async () => {
  vi.stubEnv("VIBESTUDIO_TEST_MODE", "1");
  const owner = (label: string): TestWorkspaceOwner => ({
    panelOrchestrator: { callServer: vi.fn(async () => label) } as unknown as PanelOrchestrator,
    panelRegistry: {
      getRootPanels: () => [{ id: "same-panel", title: label, children: [] }],
    } as unknown as PanelRegistry,
    getPanelView: () => null,
  });
  const system = owner("System");
  const personal = owner("Personal");
  setupTestApi(system, {
    resolveWorkspace: async (id) => {
      if (id !== "personal") throw new Error("Workspace is unavailable");
      return personal;
    },
    listWorkspaces: async () => [],
  });
  const root = globalThis.__testApi!;
  const captured = await root.forWorkspace("personal");
  expect(captured).toBe(await root.forWorkspace("personal"));
  expect(root.getPanelTree()[0]?.title).toBe("System");
  expect(captured.getPanelTree()[0]?.title).toBe("Personal");
  await expect(captured.rpcCall("workspace", "getInfo")).resolves.toBe("Personal");
  await expect(root.rpcCall("workspace", "getInfo")).resolves.toBe("System");
  await expect(root.forWorkspace("missing")).rejects.toThrow("unavailable");
});

it("observes its owner's view becoming ready without reinstalling the global API", async () => {
  vi.stubEnv("VIBESTUDIO_TEST_MODE", "1");
  let view: PanelView | null = null;
  const owner = {
    panelOrchestrator: {} as PanelOrchestrator,
    panelRegistry: {} as PanelRegistry,
    getPanelView: () => view,
  };
  setupTestApi(owner, { resolveWorkspace: async () => owner, listWorkspaces: async () => [] });
  const api = globalThis.__testApi!;
  await expect(api.getPanelText("panel")).rejects.toThrow("PanelView not available");
  view = {
    getWebContents: () => ({
      isDestroyed: () => false,
      executeJavaScript: async () => "Personal chat",
    }),
  } as unknown as PanelView;
  await expect(api.getPanelText("panel")).resolves.toBe("Personal chat");
  expect(globalThis.__testApi).toBe(api);
});
