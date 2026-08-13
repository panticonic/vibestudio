// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { PanelAccessPermissionDeps } from "./panelAccessPermission.js";

import { createWorkspaceStateService, type SlotStateChange } from "./workspaceStateService.js";

interface MockHandlerCtx {
  caller: {
    runtime: { kind: string; id: string };
    hostOriginated?: true;
    subject?: { userId: string };
  };
}

function makeCtx(): MockHandlerCtx {
  return { caller: { runtime: { kind: "shell", id: "shell" } } };
}

function makeDoCtx(key: { source: string; className: string; objectKey: string }): MockHandlerCtx {
  return {
    caller: {
      runtime: {
        kind: "do",
        id: `do:${key.source}:${key.className}:${key.objectKey}`,
      },
    },
  };
}

function makeService(opts: {
  onSlotStateChanged?: (change?: SlotStateChange) => void;
  /**
   * Map of DO method → return value. The dispatcher uses this to drive
   * outcomes (e.g. simulating the entity-id WorkspaceDO returns from
   * `panelIndex` / `panelUpdateTitle`).
   */
  dispatchReturns?: Record<string, unknown>;
  panelAccess?: Partial<PanelAccessPermissionDeps>;
}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const doDispatch = {
    dispatch: async (_ref: unknown, method: string, ...args: unknown[]) => {
      calls.push({ method, args });
      if (method === "slotClose") return { closeId: String(args[0]), closedCount: 0 };
      if (method === "slotCloseCleanupPage") return { items: [], nextCursor: null };
      return opts.dispatchReturns?.[method];
    },
  };
  const svc = createWorkspaceStateService({
    doDispatch: doDispatch as never,
    workspaceId: "test-workspace",
    panelAccess: {
      contextExists: () => false,
      resolveCallerContext: async () => null,
      resolveEntityContext: () => null,
      resolveSubjectCaller: () => null,
      ...opts.panelAccess,
      controlsLifecycleContext: opts.panelAccess?.controlsLifecycleContext ?? (async () => false),
    },
    ...(opts.onSlotStateChanged ? { onSlotStateChanged: opts.onSlotStateChanged } : {}),
  });
  return { svc, calls };
}

describe("workspaceStateService — topology authority", () => {
  it("prepares exact context-boundary authority at the WorkspaceDO mutation surface", async () => {
    const { svc } = makeService({
      dispatchReturns: {
        panelTreeDetail: {
          slot: { slot_id: "panel:target" },
          currentHistory: { source: "panels/target", context_id: "ctx-target" },
          entity: { id: "panel:target" },
        },
      },
      panelAccess: {
        contextExists: () => true,
        resolveCallerContext: async () => "ctx-origin",
        resolveEntityContext: () => "ctx-target",
      },
    });
    const caller = createVerifiedCaller("panel:caller", "panel", {
      callerId: "panel:caller",
      callerKind: "panel",
      repoPath: "panels/caller",
      effectiveVersion: "ev-caller",
      executionDigest: "digest-caller",
      requested: [],
    });

    await expect(
      svc.authorityPreparation?.["workspace-state.slot.close.contextBoundary"]?.({ caller }, [
        "panel:target",
      ])
    ).resolves.toMatchObject({
      selections: [
        {
          capability: "context.boundary",
          challenge: {
            operation: { verb: "Close panel in" },
          },
        },
      ],
      payload: null,
    });
  });

  it("allows approved shell apps to read and write workspace slot state", () => {
    const { svc } = makeService({});

    expect(svc.authority.principals).toContain("code");
    expect(svc.methods["panelTree.page"]?.authority).toEqual({
      principals: expect.arrayContaining(["host", "user", "code"]),
    });
    expect(svc.methods["panelTree.detail"]?.authority).toEqual({
      principals: expect.arrayContaining(["host", "user", "code"]),
    });
    expect(svc.methods["slot.create"]?.authority).toMatchObject({
      principals: expect.arrayContaining(["host", "user", "code"]),
    });
  });

  it("derives current roots from the verified caller instead of caller input", async () => {
    const { svc, calls } = makeService({
      dispatchReturns: {
        panelTreePage: {
          revision: 1,
          group: { kind: "roots", ownerUserId: "usr-current" },
          nodes: [],
          nextCursor: null,
        },
      },
    });
    const ctx = makeCtx();
    ctx.caller.subject = { userId: "usr-current" };

    await svc.handler(ctx as never, "panelTree.rootsForCaller", [{ limit: 50 }]);

    expect(calls).toEqual([
      {
        method: "panelTreePage",
        args: [
          {
            group: { kind: "roots", ownerUserId: "usr-current" },
            limit: 50,
          },
        ],
      },
    ]);
  });

  it("returns raw panel detail without host presentation composition", async () => {
    const detail = {
      revision: 1,
      slot: { slot_id: "panel:chat" },
      currentHistory: { source: "panels/chat", context_id: "ctx-chat" },
      entity: { id: "panel:chat" },
    };
    const { svc } = makeService({
      dispatchReturns: { panelTreeDetail: detail },
    });

    await expect(
      svc.handler(makeCtx() as never, "panelTree.detail", ["panel:chat"])
    ).resolves.toEqual(detail);
  });

  it("returns raw tree rows without host presentation composition", async () => {
    const page = {
      revision: 1,
      group: { kind: "roots" as const, ownerUserId: null },
      nodes: [
        {
          slotId: "panel:chat",
          parentSlotId: null,
          ownerUserId: null,
          title: "Chat",
          source: "panels/chat",
          createdAt: 1,
          childCount: 0,
        },
      ],
      nextCursor: null,
    };
    const { svc } = makeService({
      dispatchReturns: { panelTreePage: page },
    });

    await expect(
      svc.handler(makeCtx() as never, "panelTree.page", [
        { group: { kind: "roots", ownerUserId: null } },
      ])
    ).resolves.toEqual(page);
  });

  it("exposes lifecycle lease methods to DO callers", async () => {
    const { svc, calls } = makeService({});
    const key = { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" };

    expect(svc.methods["lifecycleLeaseUpsert"]?.authority).toEqual({
      principals: ["host", "code"],
    });
    expect(svc.methods["lifecycleLeaseClear"]?.authority).toEqual({ principals: ["host", "code"] });

    await svc.handler(makeDoCtx(key) as never, "lifecycleLeaseUpsert", [
      { ...key, detail: "turn" },
    ]);
    await svc.handler(makeDoCtx(key) as never, "lifecycleLeaseClear", [key]);

    expect(calls).toEqual([
      { method: "lifecycleLeaseUpsert", args: [{ ...key, detail: "turn" }] },
      { method: "lifecycleLeaseClear", args: [key] },
    ]);
  });

  it("allows a Durable Object to manage only its own alarm key", async () => {
    const { svc, calls } = makeService({});
    const own = { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" };
    const foreign = { ...own, objectKey: "ch-2" };

    await svc.handler(makeDoCtx(own) as never, "alarmSet", [{ ...own, wakeAt: 123 }]);
    await expect(svc.handler(makeDoCtx(own) as never, "alarmClear", [foreign])).rejects.toThrow(
      /cannot clear an alarm/
    );

    expect(calls).toEqual([{ method: "alarmSet", args: [{ ...own, wakeAt: 123 }] }]);
  });

  it("attaches the host-verified test policy to the durable alarm record", async () => {
    const { svc, calls } = makeService({});
    const own = { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" };
    const testPolicy = {
      policyId: "system-test:permissions-list",
      kind: "orchestrator" as const,
    };
    const ctx = makeDoCtx(own) as MockHandlerCtx & {
      caller: MockHandlerCtx["caller"] & { testPolicy: typeof testPolicy };
    };
    ctx.caller.testPolicy = testPolicy;

    await svc.handler(ctx as never, "alarmSet", [{ ...own, wakeAt: 123 }]);

    expect(calls).toEqual([
      {
        method: "alarmSet",
        args: [{ ...own, wakeAt: 123, testPolicy }],
      },
    ]);
  });

  it("allows verified host infrastructure to manage any alarm key", async () => {
    const { svc, calls } = makeService({});
    const key = { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" };
    const host = {
      caller: { runtime: { kind: "server", id: "server" }, hostOriginated: true as const },
    };

    await svc.handler(host as never, "alarmClear", [key]);

    expect(calls).toEqual([{ method: "alarmClear", args: [key] }]);
  });

  it("exposes no product presentation methods", () => {
    const { svc } = makeService({});
    expect(Object.keys(svc.methods)).not.toEqual(
      expect.arrayContaining([
        "panelTree.search",
        "panel.search",
        "panel.sourceUsage",
        "panel.index",
        "panel.updateTitle",
        "panel.incrementAccess",
        "panel.rebuildIndex",
      ])
    );
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

    await svc.handler(ctx as never, "slot.create", [{ slotId: "s1", parentSlotId: null }]);

    expect(calls).toContainEqual({
      method: "slotCreate",
      args: [
        {
          slotId: "s1",
          parentSlotId: null,
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

    await svc.handler(ctx as never, "slot.move", ["s1", null, { afterSlotId: "s0" }]);

    expect(calls).toContainEqual({
      method: "slotMove",
      args: ["s1", null, { afterSlotId: "s0" }, "user-verified"],
    });
  });

  const mutating: Array<[method: string, args: unknown[]]> = [
    ["slot.create", [{ slotId: "s1", parentSlotId: null }]],
    ["slot.updateCurrentStateArgs", ["s1", {}]],
    ["slot.move", ["s1", null, { afterSlotId: "s0" }]],
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

  it("publishes the committed durable desired entity for presentation reconciliation", async () => {
    const onSlotStateChanged = vi.fn();
    const result = {
      previousEntityId: "panel:nav-about-new",
      currentEntityId: "panel:nav-news",
      currentEntryKey: "nav-news",
      cursor: 1,
    };
    const input = {
      slotId: "panel:tree/news",
      expectedCurrentEntityId: result.previousEntityId,
      mutation: {
        kind: "append",
        entry: {
          entryKey: result.currentEntryKey,
          entityId: result.currentEntityId,
          source: "panels/news",
          contextId: "ctx-news",
        },
      },
    };
    const { svc } = makeService({
      onSlotStateChanged,
      dispatchReturns: { slotCommitPreparedNavigation: result },
    });

    await expect(
      svc.handler(makeCtx() as never, "slot.commitPreparedNavigation", [input])
    ).resolves.toEqual(result);
    expect(onSlotStateChanged).toHaveBeenCalledWith({
      kind: "current-entity",
      slotId: input.slotId,
      previousEntityId: result.previousEntityId,
      currentEntityId: result.currentEntityId,
      presentation: "executable",
    });
  });

  it("publishes a newly created slot's durable desired entity", async () => {
    const onSlotStateChanged = vi.fn();
    const { svc } = makeService({ onSlotStateChanged });
    const input = {
      slotId: "panel:tree/news",
      parentSlotId: null,
      initialEntry: {
        entryKey: "nav-news",
        entityId: "panel:nav-news",
        source: "panels/news",
        contextId: "ctx-news",
      },
    };

    await svc.handler(makeCtx() as never, "slot.create", [input]);

    expect(onSlotStateChanged).toHaveBeenCalledWith({
      kind: "current-entity",
      slotId: input.slotId,
      previousEntityId: null,
      currentEntityId: input.initialEntry.entityId,
      presentation: "awaiting-execution",
    });
  });

  const reads: Array<[method: string, args: unknown[]]> = [
    ["panelTree.rootGroups", [{}]],
    ["panelTree.rootsForCaller", [{ limit: 50 }]],
    ["panelTree.page", [{ group: { kind: "roots", ownerUserId: null }, limit: 50 }]],
    ["panelTree.path", ["s1"]],
    ["panelTree.detail", ["s1"]],
    ["slot.get", ["s1"]],
    ["slot.historyRelative", ["s1", -1]],
    ["entity.resolveActive", ["e1"]],
    ["entity.resolve", ["e1"]],
  ];

  for (const [method, args] of reads) {
    it(`does not fire onSlotStateChanged for read/non-tree method ${method}`, async () => {
      const onSlotStateChanged = vi.fn();
      const dispatchReturns =
        method === "panelTree.rootsForCaller" || method === "panelTree.page"
          ? {
              panelTreePage: {
                revision: 1,
                group: { kind: "roots", ownerUserId: null },
                nodes: [],
                nextCursor: null,
              },
            }
          : undefined;
      const { svc } = makeService({
        onSlotStateChanged,
        ...(dispatchReturns ? { dispatchReturns } : {}),
      });
      await svc.handler(makeCtx() as never, method, args);
      expect(onSlotStateChanged).not.toHaveBeenCalled();
    });
  }
});
