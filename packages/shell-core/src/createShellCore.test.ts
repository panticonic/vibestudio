import { describe, expect, it, vi } from "vitest";
import { createRuntimeClient, createWorkspaceStateClient } from "./createShellCore.js";

describe("shared shell service adapters", () => {
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
      source: "panels/a",
      contextId: "ctx:a",
      key: "entry:a",
    };

    await client.reservePanelEntity(spec);
    await client.activatePanelEntity(spec);

    expect(call.mock.calls).toEqual([
      ["runtime", "reservePanelEntity", [spec]],
      ["runtime", "activatePanelEntity", [spec]],
    ]);
  });
});
