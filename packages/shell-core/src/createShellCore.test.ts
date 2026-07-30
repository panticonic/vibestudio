import { describe, expect, it, vi } from "vitest";
import { createRuntimeClient, createWorkspaceStateClient } from "./createShellCore.js";

describe("shared shell service adapters", () => {
  it("routes bounded panel-tree pages through workspace state", async () => {
    const call = vi.fn(async () => ({
      revision: 0,
      group: { kind: "roots", ownerUserId: null },
      nodes: [],
      nextCursor: null,
    }));
    const client = createWorkspaceStateClient(call);
    const input = { group: { kind: "roots" as const, ownerUserId: null }, limit: 25 };

    await client.getPanelTreePage(input);

    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith("workspace-state", "panelTree.page", [input]);
  });

  it("routes entity resolution through the complete workspace-state contract", async () => {
    const call = vi.fn(async () => ({ id: "panel:nav-a" }));
    const client = createWorkspaceStateClient(call);

    await client.resolveEntity("panel:nav-a");

    expect(call).toHaveBeenCalledWith("workspace-state", "entity.resolve", ["panel:nav-a"]);
  });

  it("routes both phases of panel runtime creation through the shared runtime contract", async () => {
    const call = vi.fn(async () => ({ id: "panel:nav-a" }));
    const client = createRuntimeClient(call);
    const spec = {
      kind: "panel" as const,
      execution: { surface: "code" as const, source: "panels/a" },
      contextId: "ctx:a",
      key: "entry:a",
    };

    await client.reserveEntity(spec);
    await client.activateReservedEntity(spec);

    expect(call.mock.calls).toEqual([
      ["runtime", "reserveEntity", [spec]],
      ["runtime", "activateReservedEntity", [spec]],
    ]);
  });
});
