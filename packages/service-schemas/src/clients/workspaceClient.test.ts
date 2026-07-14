import { describe, expect, it, vi } from "vitest";
import { createWorkspaceClient } from "./workspaceClient.js";

describe("createWorkspaceClient project discovery", () => {
  it("exposes status as the same authoritative unit listing", async () => {
    const rows = [
      {
        name: "@workspace-workers/demo",
        kind: "worker",
        source: "workers/demo",
        status: "available",
      },
    ];
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "workspace.units.list") return rows;
      throw new Error(`Unexpected RPC ${method}`);
    });
    const workspace = createWorkspaceClient({ call } as never);

    await expect(workspace.units.status()).resolves.toEqual(rows);
    expect(call).toHaveBeenCalledWith("main", "workspace.units.list", []);
  });

  it("lists project units and resolves only paths owned by projects", async () => {
    const call = vi.fn(async (_target: string, method: string, args: unknown[]) => {
      if (method === "workspace.sourceTree") {
        return {
          children: [
            {
              name: "projects",
              path: "projects",
              isUnit: false,
              children: [
                {
                  name: "zeta",
                  path: "projects/zeta",
                  isUnit: true,
                  children: [],
                },
                {
                  name: "alpha",
                  path: "projects/alpha",
                  isUnit: true,
                  children: [],
                },
              ],
            },
            {
              name: "panels",
              path: "panels",
              isUnit: false,
              children: [{ name: "chat", path: "panels/chat", isUnit: true, children: [] }],
            },
          ],
        };
      }
      if (method === "workspace.findUnitForPath") {
        const path = String(args[0]);
        if (path.startsWith("projects/alpha")) {
          return {
            unitPath: "projects/alpha",
            relativePath: path.slice("projects/alpha".length + 1),
          };
        }
        return { unitPath: "panels/chat", relativePath: "index.tsx" };
      }
      throw new Error(`Unexpected RPC ${method}`);
    });
    const workspace = createWorkspaceClient({ call } as never);

    await expect(workspace.projects.list()).resolves.toEqual(["projects/alpha", "projects/zeta"]);
    await expect(workspace.projects.findForPath("projects/alpha/src.ts")).resolves.toEqual({
      unitPath: "projects/alpha",
      relativePath: "src.ts",
    });
    await expect(workspace.projects.findForPath("panels/chat/index.tsx")).resolves.toBeNull();
  });

  it("coalesces watch refreshes and does not subscribe to its own diagnostic logs", async () => {
    let resolveFirst!: (rows: unknown[]) => void;
    const firstList = new Promise<unknown[]>((resolve) => {
      resolveFirst = resolve;
    });
    const listeners = new Map<string, () => void>();
    let listCalls = 0;
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "workspace.units.list") {
        listCalls += 1;
        if (listCalls === 1) return firstList;
        return [];
      }
      if (method === "events.subscribe" || method === "events.unsubscribe") return null;
      throw new Error(`Unexpected RPC ${method}`);
    });
    const on = vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    });
    const workspace = createWorkspaceClient({ call, on } as never);
    const iterator = workspace.units.watch()[Symbol.asyncIterator]();

    await vi.waitFor(() => expect(listCalls).toBe(1));
    expect(listeners.has("event:workspace:unit-log")).toBe(false);
    const statusListener = listeners.get("event:apps:status");
    expect(statusListener).toBeTypeOf("function");
    for (let index = 0; index < 100; index += 1) statusListener?.();
    expect(listCalls).toBe(1);

    resolveFirst([]);
    await vi.waitFor(() => expect(listCalls).toBe(2));
    await iterator.return?.();
  });

  it("reports one warning per continuous watch failure", async () => {
    const listeners = new Map<string, () => void>();
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "workspace.units.list") throw new Error("missing grant");
      if (method === "events.subscribe" || method === "events.unsubscribe") return null;
      throw new Error(`Unexpected RPC ${method}`);
    });
    const on = vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workspace = createWorkspaceClient({ call, on } as never);
    const iterator = workspace.units.watch()[Symbol.asyncIterator]();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    for (let index = 0; index < 20; index += 1) listeners.get("event:apps:status")?.();
    await vi.waitFor(() => {
      expect(
        call.mock.calls.filter(([, method]) => method === "workspace.units.list").length
      ).toBeGreaterThan(1);
    });
    expect(warn).toHaveBeenCalledTimes(1);

    await iterator.return?.();
    warn.mockRestore();
  });
});
