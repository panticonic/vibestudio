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
});
