// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { createWorkspaceStateService } from "./workspaceStateService.js";

interface MockHandlerCtx {
  caller: { runtime: { kind: string; id: string } };
}

function makeCtx(): MockHandlerCtx {
  return { caller: { runtime: { kind: "shell", id: "shell" } } };
}

function makeService(opts: {
  onPanelTitleChanged?: (entityId: string, title: string) => void;
  onSlotStateChanged?: () => void;
  /**
   * Map of DO method → return value. The dispatcher uses this to drive
   * outcomes (e.g. simulating the entity-id WorkspaceDO returns from
   * `panelIndex` / `panelUpdateTitle`).
   */
  dispatchReturns?: Record<string, unknown>;
}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const doDispatch = {
    dispatch: async (_ref: unknown, method: string, ...args: unknown[]) => {
      calls.push({ method, args });
      return opts.dispatchReturns?.[method];
    },
  };
  const svc = createWorkspaceStateService({
    doDispatch: doDispatch as never,
    workspaceId: "test-workspace",
    ...(opts.onPanelTitleChanged ? { onPanelTitleChanged: opts.onPanelTitleChanged } : {}),
    ...(opts.onSlotStateChanged ? { onSlotStateChanged: opts.onSlotStateChanged } : {}),
  });
  return { svc, calls };
}

describe("workspaceStateService — title mirror hooks", () => {
  it("declares user and code authority for workspace slot state", () => {
    const { svc } = makeService({});

    expect(svc.authority.principals).toContain("code");
    expect(svc.methods["slot.list"]?.authority).toEqual(
      expect.objectContaining({ principals: expect.arrayContaining(["user", "code"]) })
    );
    expect(svc.methods["slot.create"]?.authority).toEqual(
      expect.objectContaining({ principals: expect.arrayContaining(["user", "code"]) })
    );
  });

  it("exposes lifecycle lease methods to exact code principals", async () => {
    const { svc, calls } = makeService({});
    const key = { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" };

    expect(svc.methods["lifecycleLeaseUpsert"]?.authority).toEqual(
      expect.objectContaining({ principals: expect.arrayContaining(["code"]) })
    );
    expect(svc.methods["lifecycleLeaseClear"]?.authority).toEqual(
      expect.objectContaining({ principals: expect.arrayContaining(["code"]) })
    );

    await svc.handler(makeCtx() as never, "lifecycleLeaseUpsert", [{ ...key, detail: "turn" }]);
    await svc.handler(makeCtx() as never, "lifecycleLeaseClear", [key]);

    expect(calls).toEqual([
      { method: "lifecycleLeaseUpsert", args: [{ ...key, detail: "turn" }] },
      { method: "lifecycleLeaseClear", args: [key] },
    ]);
  });

  it("fires onPanelTitleChanged with the DO-resolved entity id on panel.index", async () => {
    const onPanelTitleChanged = vi.fn();
    const { svc } = makeService({
      onPanelTitleChanged,
      // WorkspaceDO returns the slot's current entity id when it stamped a
      // title — the service should pass THAT (not the slot id) to the hook.
      dispatchReturns: { panelIndex: "entity:abc-current" },
    });
    await svc.handler(makeCtx() as never, "panel.index", [
      { id: "panel:abc", title: "Spectrolite — README" },
    ]);
    expect(onPanelTitleChanged).toHaveBeenCalledWith("entity:abc-current", "Spectrolite — README");
  });

  it("skips onPanelTitleChanged on panel.index when the input has no title", async () => {
    const onPanelTitleChanged = vi.fn();
    const { svc } = makeService({
      onPanelTitleChanged,
      dispatchReturns: { panelIndex: null },
    });
    await svc.handler(makeCtx() as never, "panel.index", [{ id: "panel:abc", title: "" }]);
    expect(onPanelTitleChanged).not.toHaveBeenCalled();
  });

  it("fires onPanelTitleChanged with the resolved entity id on panel.updateTitle", async () => {
    const onPanelTitleChanged = vi.fn();
    const { svc } = makeService({
      onPanelTitleChanged,
      dispatchReturns: { panelUpdateTitle: "entity:abc-current" },
    });
    await svc.handler(makeCtx() as never, "panel.updateTitle", ["panel:abc", "New title"]);
    expect(onPanelTitleChanged).toHaveBeenCalledWith("entity:abc-current", "New title");
  });

  it("does not fire onPanelTitleChanged when the slot has no current entity", async () => {
    const onPanelTitleChanged = vi.fn();
    const { svc } = makeService({
      onPanelTitleChanged,
      dispatchReturns: { panelUpdateTitle: null },
    });
    await svc.handler(makeCtx() as never, "panel.updateTitle", ["panel:abc", "Stale"]);
    expect(onPanelTitleChanged).not.toHaveBeenCalled();
  });

  it("never fires onPanelTitleChanged for unrelated methods", async () => {
    const onPanelTitleChanged = vi.fn();
    const { svc } = makeService({ onPanelTitleChanged });
    await svc.handler(makeCtx() as never, "panel.incrementAccess", ["panel:abc"]);
    expect(onPanelTitleChanged).not.toHaveBeenCalled();
  });
});

describe("workspaceStateService — slot-state change hook", () => {
  it("derives slot.create ownership from the verified caller subject", async () => {
    const { svc, calls } = makeService({});
    const ctx = {
      caller: {
        runtime: { kind: "shell", id: "shell" },
        subject: { userId: "user-verified", username: "verified" },
      },
    };

    await svc.handler(ctx as never, "slot.create", [
      { slotId: "s1", parentSlotId: null, positionId: "p1" },
    ]);

    expect(calls).toContainEqual({
      method: "slotCreate",
      args: [
        {
          slotId: "s1",
          parentSlotId: null,
          positionId: "p1",
          ownerUserId: "user-verified",
        },
      ],
    });
  });

  it("derives slot.move ownership from the verified caller subject", async () => {
    const { svc, calls } = makeService({});
    const ctx = {
      caller: {
        runtime: { kind: "shell", id: "shell" },
        subject: { userId: "user-verified", username: "verified" },
      },
    };

    await svc.handler(ctx as never, "slot.move", ["s1", null, "p1"]);

    expect(calls).toContainEqual({
      method: "slotMove",
      args: ["s1", null, "p1", "user-verified"],
    });
  });

  const mutating: Array<[method: string, args: unknown[]]> = [
    ["slot.create", [{ slotId: "s1", parentSlotId: null, positionId: "p1" }]],
    [
      "slot.appendHistory",
      ["s1", { entryKey: "e1", entityId: "entity-1", source: "panels/test", contextId: "ctx-1" }],
    ],
    ["slot.setCurrent", ["s1", "e1"]],
    ["slot.updateCurrentStateArgs", ["s1", {}]],
    ["slot.replaceHistory", ["s1", [], 0]],
    ["slot.setParent", ["s1", null]],
    ["slot.setPosition", ["s1", "p1"]],
    ["slot.move", ["s1", null, "p1"]],
    ["slot.close", ["s1"]],
  ];

  for (const [method, args] of mutating) {
    it(`fires onSlotStateChanged after ${method}`, async () => {
      const onSlotStateChanged = vi.fn();
      const { svc } = makeService({ onSlotStateChanged });
      await svc.handler(makeCtx() as never, method, args);
      expect(onSlotStateChanged).toHaveBeenCalledTimes(1);
    });
  }

  const reads: Array<[method: string, args: unknown[]]> = [
    ["slot.list", []],
    ["slot.get", ["s1"]],
    ["slot.history", ["s1"]],
    ["entity.resolveActive", ["e1"]],
    ["panel.search", ["q", 10]],
    ["panel.incrementAccess", ["e1"]],
  ];

  for (const [method, args] of reads) {
    it(`does not fire onSlotStateChanged for read/non-tree method ${method}`, async () => {
      const onSlotStateChanged = vi.fn();
      const { svc } = makeService({ onSlotStateChanged });
      await svc.handler(makeCtx() as never, method, args);
      expect(onSlotStateChanged).not.toHaveBeenCalled();
    });
  }
});
