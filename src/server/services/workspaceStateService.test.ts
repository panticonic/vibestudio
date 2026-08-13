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
  onPanelTitleChanged?: (entityId: string, title: string) => void;
  isEntityTitleExplicit?: (entityId: string) => boolean;
  onSlotStateChanged?: (change?: SlotStateChange) => void;
  getUnitIcon?: (source: string) => string | undefined;
  /**
   * Map of DO method → return value. The dispatcher uses this to drive
   * outcomes (e.g. simulating the entity-id WorkspaceDO returns from
   * `panelIndex` / `panelUpdateTitle`).
   */
  dispatchReturns?: Record<string, unknown>;
  presentationReturns?: Record<string, unknown>;
  panelAccess?: Partial<PanelAccessPermissionDeps>;
}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const presentationCalls: Array<{ method: string; args: unknown[] }> = [];
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
    presentationDispatch: async (method, args) => {
      presentationCalls.push({ method, args });
      if (method === "titlesForSlots") return {};
      if (method === "search") return { results: [], nextCursor: null };
      if (method === "sourceUsage") return [];
      return opts.presentationReturns?.[method];
    },
    ...(opts.getUnitIcon ? { getUnitIcon: opts.getUnitIcon } : {}),
    panelAccess: {
      contextExists: () => false,
      resolveCallerContext: async () => null,
      resolveEntityContext: () => null,
      resolveSubjectCaller: () => null,
      ...opts.panelAccess,
      controlsLifecycleContext: opts.panelAccess?.controlsLifecycleContext ?? (async () => false),
    },
    ...(opts.onPanelTitleChanged ? { onPanelTitleChanged: opts.onPanelTitleChanged } : {}),
    ...(opts.isEntityTitleExplicit ? { isEntityTitleExplicit: opts.isEntityTitleExplicit } : {}),
    ...(opts.onSlotStateChanged ? { onSlotStateChanged: opts.onSlotStateChanged } : {}),
  });
  return { svc, calls, presentationCalls };
}

describe("workspaceStateService — title mirror hooks", () => {
  it("prepares exact context-boundary authority at the WorkspaceDO mutation surface", async () => {
    const { svc } = makeService({
      dispatchReturns: {
        panelTreeDetail: {
          slot: { slot_id: "panel:target", current_entity_title: "Target" },
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

  it("enriches panel detail from the server-owned unit manifest", async () => {
    const detail = {
      revision: 1,
      slot: { slot_id: "panel:chat", current_entity_title: "Chat" },
      currentHistory: { source: "panels/chat", context_id: "ctx-chat" },
      entity: { id: "panel:chat" },
    };
    const { svc } = makeService({
      dispatchReturns: { panelTreeDetail: detail },
      getUnitIcon: (source) => (source === "panels/chat" ? "💬" : undefined),
    });

    await expect(
      svc.handler(makeCtx() as never, "panelTree.detail", ["panel:chat"])
    ).resolves.toEqual({ ...detail, icon: "💬" });
  });

  it("enriches tree rows before they cross into native shell presentation", async () => {
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
      getUnitIcon: (source) => (source === "panels/chat" ? "💬" : undefined),
    });

    await expect(
      svc.handler(makeCtx() as never, "panelTree.page", [
        { group: { kind: "roots", ownerUserId: null } },
      ])
    ).resolves.toEqual({
      ...page,
      nodes: [{ ...page.nodes[0], title: "panel:chat", icon: "💬" }],
    });
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

  it("fires onPanelTitleChanged with the DO-resolved entity id on panel.index", async () => {
    const onPanelTitleChanged = vi.fn();
    const { svc } = makeService({
      onPanelTitleChanged,
      dispatchReturns: {
        panelTreeDetail: {
          slot: { slot_id: "panel:abc" },
          currentHistory: { source: "panels/chat" },
          entity: { id: "entity:abc-current" },
        },
      },
    });
    const result = await svc.handler(makeCtx() as never, "panel.index", [
      { id: "panel:abc", title: "Spectrolite — README" },
    ]);
    expect(onPanelTitleChanged).toHaveBeenCalledWith(
      "entity:abc-current",
      "Spectrolite — README",
      false
    );
    expect(result).toBe("entity:abc-current");
  });

  it("skips onPanelTitleChanged on panel.index when the input has no title", async () => {
    const onPanelTitleChanged = vi.fn();
    const { svc } = makeService({
      onPanelTitleChanged,
      dispatchReturns: { panelTreeDetail: null },
    });
    await svc.handler(makeCtx() as never, "panel.index", [{ id: "panel:abc", title: "" }]);
    expect(onPanelTitleChanged).not.toHaveBeenCalled();
  });

  it("indexes source metadata without replacing an existing explicit title", async () => {
    const onPanelTitleChanged = vi.fn();
    const { svc, calls, presentationCalls } = makeService({
      onPanelTitleChanged,
      isEntityTitleExplicit: () => true,
      dispatchReturns: {
        panelTreeDetail: {
          entity: { id: "entity:abc-current" },
          slot: { slot_id: "panel:abc", current_entity_title: "Pinned title" },
          currentHistory: { source: "browser:https://example.com/" },
        },
      },
    });

    const result = await svc.handler(makeCtx() as never, "panel.index", [
      { id: "panel:abc", title: "Inferred title", path: "browser:https://example.com/" },
    ]);

    expect(calls).toEqual([{ method: "panelTreeDetail", args: ["panel:abc"] }]);
    expect(presentationCalls).toEqual([
      { method: "titlesForSlots", args: [["panel:abc"]] },
      {
        method: "indexPanel",
        args: [
          {
            id: "panel:abc",
            source: "browser:https://example.com/",
            title: "Pinned title",
            path: "browser:https://example.com/",
          },
          "entity:abc-current",
        ],
      },
    ]);
    expect(onPanelTitleChanged).not.toHaveBeenCalled();
    expect(result).toBe("entity:abc-current");
  });

  it("fires onPanelTitleChanged with the resolved entity id on panel.updateTitle", async () => {
    const onPanelTitleChanged = vi.fn();
    const { svc } = makeService({
      onPanelTitleChanged,
      dispatchReturns: {
        panelTreeDetail: { entity: { id: "entity:abc-current" } },
      },
    });
    const result = await svc.handler(makeCtx() as never, "panel.updateTitle", [
      "panel:abc",
      "New title",
    ]);
    expect(onPanelTitleChanged).toHaveBeenCalledWith("entity:abc-current", "New title", false);
    expect(result).toBe("entity:abc-current");
  });

  it("does not let an inferred title replace an explicit title", async () => {
    const onPanelTitleChanged = vi.fn();
    const { svc, calls } = makeService({
      onPanelTitleChanged,
      isEntityTitleExplicit: () => true,
      dispatchReturns: {
        panelTreeDetail: {
          entity: { id: "panel:abc-current" },
        },
      },
    });

    const result = await svc.handler(makeCtx() as never, "panel.updateTitle", [
      "panel:abc",
      "Document title",
    ]);

    expect(result).toBe("panel:abc-current");
    expect(calls.map(({ method }) => method)).toEqual(["panelTreeDetail"]);
    expect(onPanelTitleChanged).not.toHaveBeenCalled();
  });

  it("does not fire onPanelTitleChanged when the slot has no current entity", async () => {
    const onPanelTitleChanged = vi.fn();
    const { svc } = makeService({
      onPanelTitleChanged,
      dispatchReturns: { panelTreeDetail: null },
    });
    const result = await svc.handler(makeCtx() as never, "panel.updateTitle", [
      "panel:abc",
      "Stale",
    ]);
    expect(onPanelTitleChanged).not.toHaveBeenCalled();
    expect(result).toBeNull();
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
    ["panelTree.search", [{ query: "q" }]],
    ["slot.get", ["s1"]],
    ["slot.historyRelative", ["s1", -1]],
    ["entity.resolveActive", ["e1"]],
    ["entity.resolve", ["e1"]],
    ["panel.search", ["q", 10]],
    ["panel.sourceUsage", [20]],
    ["panel.incrementAccess", ["e1"]],
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
          : method === "panelTree.search"
            ? { panelTreeSearch: { revision: 1, hits: [], nextCursor: null } }
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
