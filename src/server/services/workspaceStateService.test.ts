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
  onPresentationChanged?: (panelIds: string[]) => void;
  onEntityTitleChanged?: (entityId: string, title: string | undefined) => void;
  /**
   * Map of DO method → return value. The dispatcher uses this to drive
   * outcomes (e.g. simulating the entity-id WorkspaceDO returns from
   * `panelIndex` / `panelUpdateTitle`).
   */
  dispatchReturns?: Record<string, unknown>;
  panelAccess?: Partial<PanelAccessPermissionDeps>;
  presentationDispatch?: (method: string, args: unknown[]) => Promise<unknown>;
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
      return (
        opts.presentationDispatch ??
        (async (requestedMethod) => {
          if (requestedMethod === "titlesForSlots") return {};
          if (requestedMethod === "search") return { results: [], nextCursor: null };
          if (requestedMethod === "isEntityTitleExplicit") return false;
          return undefined;
        })
      )(method, args);
    },
    panelAccess: {
      contextExists: () => false,
      resolveCallerContext: async () => null,
      resolveEntityContext: () => null,
      resolveSubjectCaller: () => null,
      ...opts.panelAccess,
      controlsLifecycleContext: opts.panelAccess?.controlsLifecycleContext ?? (async () => false),
    },
    ...(opts.onSlotStateChanged ? { onSlotStateChanged: opts.onSlotStateChanged } : {}),
    ...(opts.onPresentationChanged ? { onPresentationChanged: opts.onPresentationChanged } : {}),
    ...(opts.onEntityTitleChanged ? { onEntityTitleChanged: opts.onEntityTitleChanged } : {}),
  });
  return { svc, calls, presentationCalls };
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

  it("derives current roots from the verified human behind an app caller", async () => {
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
    const ctx = {
      caller: {
        runtime: { kind: "app", id: "@workspace-apps/shell" },
        subject: { userId: "usr-current" },
      },
    };

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

  it("keeps addressed panel detail independent of cold Base-owned decoration", async () => {
    const detail = {
      revision: 1,
      slot: { slot_id: "panel:chat" },
      currentHistory: {
        source: "panels/chat",
        context_id: "ctx-chat",
        options: JSON.stringify({ ref: "event:chat" }),
      },
      entity: { id: "panel:chat" },
    };
    const { svc } = makeService({
      dispatchReturns: { panelTreeDetail: detail },
      presentationDispatch: async (method) =>
        method === "titlesForSlots" ? { "panel:chat": "Chat" } : undefined,
    });

    await expect(
      svc.handler(makeCtx() as never, "panelTree.detail", ["panel:chat"])
    ).resolves.toEqual({
      ...detail,
      slot: { ...detail.slot, current_entity_title: "panels/chat" },
    });
  });

  it("renders bounded tree rows immediately while Base-owned titles warm", async () => {
    const page = {
      revision: 1,
      group: { kind: "roots" as const, ownerUserId: null },
      nodes: [
        {
          slotId: "panel:chat",
          parentSlotId: null,
          ownerUserId: null,
          source: "panels/chat",
          createdAt: 1,
          childCount: 0,
        },
      ],
      nextCursor: null,
    };
    const onPresentationChanged = vi.fn();
    const { svc } = makeService({
      dispatchReturns: { panelTreePage: page },
      onPresentationChanged,
      presentationDispatch: async (method) =>
        method === "titlesForSlots" ? { "panel:chat": "Chat" } : undefined,
    });

    await expect(
      svc.handler(makeCtx() as never, "panelTree.page", [
        { group: { kind: "roots", ownerUserId: null } },
      ])
    ).resolves.toEqual({
      ...page,
      nodes: [{ ...page.nodes[0], title: "panels/chat", kind: "workspace" }],
    });
    await vi.waitFor(() => expect(onPresentationChanged).toHaveBeenCalledWith(["panel:chat"]));
    await expect(
      svc.handler(makeCtx() as never, "panelTree.page", [
        { group: { kind: "roots", ownerUserId: null } },
      ])
    ).resolves.toEqual({
      ...page,
      nodes: [{ ...page.nodes[0], title: "Chat", kind: "workspace" }],
    });
  });

  it("composes strict placement without awaiting title decoration", async () => {
    const page = {
      revision: 1,
      group: { kind: "roots" as const, ownerUserId: null },
      nodes: [
        {
          slotId: "panel:chat",
          parentSlotId: null,
          ownerUserId: null,
          source: "panels/chat",
          options: JSON.stringify({
            ref: "ctx:chat",
            placement: { disposition: "side", preferredWidth: 420 },
          }),
          createdAt: 1,
          childCount: 0,
        },
      ],
      nextCursor: null,
    };
    const { svc } = makeService({
      dispatchReturns: { panelTreePage: page },
      presentationDispatch: async (method) =>
        method === "titlesForSlots" ? { "panel:chat": "Agentic Chat" } : undefined,
    });

    await expect(
      svc.handler(makeCtx() as never, "panelTree.page", [
        { group: { kind: "roots", ownerUserId: null } },
      ])
    ).resolves.toMatchObject({
      nodes: [
        {
          title: "panels/chat",
          ref: "ctx:chat",
          placement: { disposition: "side", preferredWidth: 420 },
        },
      ],
    });
  });

  it("does not let an unavailable presentation projection block topology reads", async () => {
    const page = {
      revision: 1,
      group: { kind: "roots" as const, ownerUserId: null },
      nodes: [
        {
          slotId: "panel:chat",
          parentSlotId: null,
          ownerUserId: null,
          source: "panels/chat",
          createdAt: 1,
          childCount: 0,
        },
      ],
      nextCursor: null,
    };
    const never = new Promise<never>(() => undefined);
    const { svc } = makeService({
      dispatchReturns: { panelTreePage: page },
      presentationDispatch: async (method) => (method === "titlesForSlots" ? never : undefined),
    });

    await expect(
      svc.handler(makeCtx() as never, "panelTree.page", [
        { group: { kind: "roots", ownerUserId: null } },
      ])
    ).resolves.toMatchObject({
      nodes: [{ slotId: "panel:chat", title: "panels/chat" }],
    });
  });

  it("rejects malformed current presentation options instead of hiding them", async () => {
    const { svc } = makeService({
      dispatchReturns: {
        panelTreePage: {
          revision: 1,
          group: { kind: "roots" as const, ownerUserId: null },
          nodes: [
            {
              slotId: "panel:chat",
              parentSlotId: null,
              ownerUserId: null,
              source: "panels/chat",
              options: "{",
              createdAt: 1,
              childCount: 0,
            },
          ],
          nextCursor: null,
        },
      },
    });

    await expect(
      svc.handler(makeCtx() as never, "panelTree.page", [
        { group: { kind: "roots", ownerUserId: null } },
      ])
    ).rejects.toThrow("Workspace panel options are not valid current JSON");
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

  it("keeps presentation behind the existing workspace-state service boundary", () => {
    const { svc } = makeService({});
    expect(Object.keys(svc.methods)).toEqual(
      expect.arrayContaining(["panelTree.search", "panel.index", "panel.updateTitle"])
    );
  });

  it("indexes and titles through the Base owner without asking panel callers to resolve it", async () => {
    const onSlotStateChanged = vi.fn();
    const onPresentationChanged = vi.fn();
    const onEntityTitleChanged = vi.fn();
    const detail = {
      revision: 1,
      slot: { slot_id: "panel:chat" },
      currentHistory: { source: "panels/chat", context_id: "ctx-chat" },
      entity: { id: "panel:nav-chat" },
    };
    const { svc, presentationCalls } = makeService({
      onSlotStateChanged,
      onPresentationChanged,
      onEntityTitleChanged,
      dispatchReturns: { panelTreeDetail: detail },
    });

    await expect(
      svc.handler(makeCtx() as never, "panel.index", [
        { id: "panel:chat", title: "Agentic Chat", path: "panels/chat" },
      ])
    ).resolves.toBe("panel:nav-chat");
    await expect(
      svc.handler(makeCtx() as never, "panel.updateTitle", [
        "panel:chat",
        "Renamed chat",
        { explicit: true },
      ])
    ).resolves.toBe("panel:nav-chat");

    expect(presentationCalls).toEqual([
      { method: "isEntityTitleExplicit", args: ["panel:nav-chat"] },
      {
        method: "indexPanel",
        args: [
          {
            id: "panel:chat",
            title: "Agentic Chat",
            path: "panels/chat",
            source: "panels/chat",
          },
          "panel:nav-chat",
        ],
      },
      {
        method: "updatePanelTitle",
        args: ["panel:chat", "panel:nav-chat", "Renamed chat", { explicit: true }],
      },
    ]);
    expect(onSlotStateChanged).not.toHaveBeenCalled();
    expect(onPresentationChanged).toHaveBeenNthCalledWith(1, ["panel:chat"]);
    expect(onPresentationChanged).toHaveBeenNthCalledWith(2, ["panel:chat"]);
    expect(onEntityTitleChanged).toHaveBeenNthCalledWith(1, "panel:nav-chat", "Agentic Chat");
    expect(onEntityTitleChanged).toHaveBeenNthCalledWith(2, "panel:nav-chat", "Renamed chat");
  });

  it("publishes a native page title from the mutation cache on the next tree read", async () => {
    const page = {
      revision: 1,
      group: { kind: "roots" as const, ownerUserId: null },
      nodes: [
        {
          slotId: "panel:chat",
          parentSlotId: null,
          ownerUserId: null,
          source: "panels/chat",
          createdAt: 1,
          childCount: 0,
        },
      ],
      nextCursor: null,
    };
    const detail = {
      revision: 1,
      slot: { slot_id: "panel:chat" },
      currentHistory: { source: "panels/chat", context_id: "ctx-chat" },
      entity: { id: "panel:nav-chat" },
    };
    const onSlotStateChanged = vi.fn();
    const onPresentationChanged = vi.fn();
    const { svc, presentationCalls } = makeService({
      onSlotStateChanged,
      onPresentationChanged,
      dispatchReturns: { panelTreeDetail: detail, panelTreePage: page },
    });

    await svc.handler(makeCtx() as never, "panel.updateTitle", [
      "panel:chat",
      "Conversation title",
      { explicit: false },
    ]);
    await expect(
      svc.handler(makeCtx() as never, "panelTree.page", [
        { group: { kind: "roots", ownerUserId: null } },
      ])
    ).resolves.toMatchObject({
      nodes: [{ slotId: "panel:chat", title: "Conversation title" }],
    });

    expect(presentationCalls).toEqual([
      { method: "isEntityTitleExplicit", args: ["panel:nav-chat"] },
      {
        method: "updatePanelTitle",
        args: ["panel:chat", "panel:nav-chat", "Conversation title", { explicit: false }],
      },
    ]);
    expect(onSlotStateChanged).not.toHaveBeenCalled();
    expect(onPresentationChanged).toHaveBeenCalledWith(["panel:chat"]);
  });

  it("coalesces repeated runtime page titles without redundant presentation refreshes", async () => {
    const detail = {
      revision: 1,
      slot: { slot_id: "panel:chat" },
      currentHistory: { source: "panels/chat", context_id: "ctx-chat" },
      entity: { id: "panel:nav-chat" },
    };
    const onPresentationChanged = vi.fn();
    const { svc } = makeService({
      onPresentationChanged,
      dispatchReturns: { panelTreeDetail: detail },
    });

    await svc.handler(makeCtx() as never, "panel.updateTitle", [
      "panel:chat",
      "Conversation title",
      { explicit: false },
    ]);
    await svc.handler(makeCtx() as never, "panel.updateTitle", [
      "panel:chat",
      "Conversation title",
      { explicit: false },
    ]);

    expect(onPresentationChanged).toHaveBeenCalledTimes(1);
    expect(onPresentationChanged).toHaveBeenCalledWith(["panel:chat"]);
  });

  it("clears a panel title through the same cache and presentation owner", async () => {
    const page = {
      revision: 1,
      group: { kind: "roots" as const, ownerUserId: null },
      nodes: [
        {
          slotId: "panel:chat",
          parentSlotId: null,
          ownerUserId: null,
          source: "panels/chat",
          createdAt: 1,
          childCount: 0,
        },
      ],
      nextCursor: null,
    };
    const detail = {
      revision: 1,
      slot: { slot_id: "panel:chat" },
      currentHistory: { source: "panels/chat", context_id: "ctx-chat" },
      entity: { id: "panel:nav-chat" },
    };
    const onPresentationChanged = vi.fn();
    const { svc, presentationCalls } = makeService({
      onPresentationChanged,
      dispatchReturns: { panelTreeDetail: detail, panelTreePage: page },
    });

    await svc.handler(makeCtx() as never, "panel.updateTitle", [
      "panel:chat",
      "Conversation title",
      { explicit: true },
    ]);
    await svc.handler(makeCtx() as never, "panel.updateTitle", [
      "panel:chat",
      null,
      { explicit: true },
    ]);

    await expect(
      svc.handler(makeCtx() as never, "panelTree.page", [
        { group: { kind: "roots", ownerUserId: null } },
      ])
    ).resolves.toMatchObject({ nodes: [{ title: "panels/chat" }] });
    expect(presentationCalls).toContainEqual({
      method: "updatePanelTitle",
      args: ["panel:chat", "panel:nav-chat", null, { explicit: true }],
    });
    expect(onPresentationChanged).toHaveBeenCalledTimes(2);
  });

  it("does not let a later index pass replace a newer runtime page title", async () => {
    const page = {
      revision: 1,
      group: { kind: "roots" as const, ownerUserId: null },
      nodes: [
        {
          slotId: "panel:chat",
          parentSlotId: null,
          ownerUserId: null,
          source: "panels/chat",
          createdAt: 1,
          childCount: 0,
        },
      ],
      nextCursor: null,
    };
    const detail = {
      revision: 1,
      slot: { slot_id: "panel:chat" },
      currentHistory: { source: "panels/chat", context_id: "ctx-chat" },
      entity: { id: "panel:nav-chat" },
    };
    const onPresentationChanged = vi.fn();
    const { svc } = makeService({
      onPresentationChanged,
      dispatchReturns: { panelTreeDetail: detail, panelTreePage: page },
    });

    await svc.handler(makeCtx() as never, "panel.updateTitle", [
      "panel:chat",
      "Conversation title",
      { explicit: false },
    ]);
    await svc.handler(makeCtx() as never, "panel.index", [
      { id: "panel:chat", title: "Agentic Chat", path: "panels/chat" },
    ]);

    await expect(
      svc.handler(makeCtx() as never, "panelTree.page", [
        { group: { kind: "roots", ownerUserId: null } },
      ])
    ).resolves.toMatchObject({
      nodes: [{ slotId: "panel:chat", title: "Conversation title" }],
    });
    expect(onPresentationChanged).toHaveBeenCalledTimes(1);
    expect(onPresentationChanged).toHaveBeenCalledWith(["panel:chat"]);
  });
});

describe("workspaceStateService — slot-state change hook", () => {
  it("derives slot.create ownership from the verified human behind an app caller", async () => {
    const { svc, calls } = makeService({});
    const ctx = {
      caller: {
        runtime: { kind: "app", id: "@workspace-apps/shell" },
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

  it("derives slot.move ownership from the verified human behind an app caller", async () => {
    const { svc, calls } = makeService({});
    const ctx = {
      caller: {
        runtime: { kind: "app", id: "@workspace-apps/shell" },
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
      desiredExecution: {
        source: input.initialEntry.source,
        key: input.initialEntry.entryKey,
        contextId: input.initialEntry.contextId,
        stateArgs: {},
      },
    });
  });

  it("publishes the exact artifact committed with a preparing panel slot", async () => {
    const onSlotStateChanged = vi.fn();
    const { svc } = makeService({ onSlotStateChanged });
    const artifact = {
      buildKey: "e".repeat(64),
      executionDigest: "f".repeat(64),
    };
    const input = {
      slotId: "panel:tree/tests",
      parentSlotId: null,
      initialEntry: {
        entryKey: "nav-tests",
        entityId: "panel:nav-tests",
        source: "panels/tests",
        contextId: "ctx-tests",
        options: { artifact },
      },
    };

    await svc.handler(makeCtx() as never, "slot.create", [input]);

    expect(onSlotStateChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        desiredExecution: expect.objectContaining({ artifact }),
      })
    );
  });

  it("does not let a cold presentation bind delay durable execution handoff", async () => {
    const onSlotStateChanged = vi.fn();
    const never = new Promise<never>(() => undefined);
    const { svc } = makeService({
      onSlotStateChanged,
      dispatchReturns: {
        panelTreePage: {
          revision: 1,
          group: { kind: "roots", ownerUserId: null },
          nodes: [
            {
              slotId: "panel:tree/news",
              parentSlotId: null,
              ownerUserId: null,
              source: "panels/news",
              createdAt: 1,
              childCount: 0,
            },
          ],
          nextCursor: null,
        },
      },
      presentationDispatch: async (method) => (method === "bindSlot" ? never : undefined),
    });
    const input = {
      slotId: "panel:tree/news",
      parentSlotId: null,
      title: "Daily News",
      initialEntry: {
        entryKey: "nav-news",
        entityId: "panel:nav-news",
        source: "panels/news",
        contextId: "ctx-news",
      },
    };

    await expect(svc.handler(makeCtx() as never, "slot.create", [input])).resolves.toBeUndefined();
    expect(onSlotStateChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "current-entity",
        currentEntityId: "panel:nav-news",
        presentation: "awaiting-execution",
      })
    );

    await expect(
      svc.handler(makeCtx() as never, "panelTree.page", [
        { group: { kind: "roots", ownerUserId: null } },
      ])
    ).resolves.toMatchObject({
      nodes: [{ slotId: "panel:tree/news", title: "Daily News" }],
    });
  });

  it("binds the creation-time title so a new slot is never presented as its id", async () => {
    const { svc, calls, presentationCalls } = makeService({});
    const input = {
      slotId: "panel:tree/news",
      parentSlotId: null,
      title: "Daily News",
      initialEntry: {
        entryKey: "nav-news",
        entityId: "panel:nav-news",
        source: "panels/news",
        contextId: "ctx-news",
      },
    };

    await svc.handler(makeCtx() as never, "slot.create", [input]);

    expect(presentationCalls).toContainEqual({
      method: "bindSlot",
      args: [input.slotId, input.initialEntry.entityId, input.initialEntry.source, "Daily News"],
    });
    // Presentation only: the state engine stores slots, not display names.
    const slotCreate = calls.find((call) => call.method === "slotCreate");
    expect(slotCreate?.args[0]).not.toHaveProperty("title");
  });

  it("binds the destination title when a slot navigates", async () => {
    const result = {
      previousEntityId: "panel:nav-about",
      currentEntityId: "panel:nav-news",
      currentEntryKey: "nav-news",
      cursor: 1,
    };
    const { svc, calls, presentationCalls } = makeService({
      dispatchReturns: {
        slotCommitPreparedNavigation: result,
        panelTreeDetail: {
          slot: { slot_id: "panel:tree/news" },
          currentHistory: { source: "panels/news", context_id: "ctx-news" },
          entity: { id: result.currentEntityId },
        },
      },
    });
    const input = {
      slotId: "panel:tree/news",
      expectedCurrentEntityId: result.previousEntityId,
      title: "Daily News",
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

    await svc.handler(makeCtx() as never, "slot.commitPreparedNavigation", [input]);

    expect(presentationCalls).toContainEqual({
      method: "bindSlot",
      args: ["panel:tree/news", result.currentEntityId, "panels/news", "Daily News"],
    });
    // Presentation only: history rows carry no display name.
    const commit = calls.find((call) => call.method === "slotCommitPreparedNavigation");
    expect(commit?.args[0]).not.toHaveProperty("title");
  });

  it("binds a null title when a navigation had none to give", async () => {
    const result = {
      previousEntityId: "panel:nav-about",
      currentEntityId: "panel:nav-news",
      currentEntryKey: "nav-news",
      cursor: 1,
    };
    const { svc, presentationCalls } = makeService({
      dispatchReturns: {
        slotCommitPreparedNavigation: result,
        panelTreeDetail: {
          slot: { slot_id: "panel:tree/news" },
          currentHistory: { source: "panels/news", context_id: "ctx-news" },
          entity: { id: result.currentEntityId },
        },
      },
    });

    await svc.handler(makeCtx() as never, "slot.commitPreparedNavigation", [
      {
        slotId: "panel:tree/news",
        expectedCurrentEntityId: result.previousEntityId,
        mutation: { kind: "select", entryKey: result.currentEntryKey },
      },
    ]);

    expect(presentationCalls).toContainEqual({
      method: "bindSlot",
      args: ["panel:tree/news", result.currentEntityId, "panels/news", null],
    });
  });

  it("presents an untitled node by its source rather than by its slot id", async () => {
    const { svc } = makeService({
      dispatchReturns: {
        panelTreePage: {
          revision: 1,
          nodes: [
            {
              slotId: "panel:tree/news",
              parentSlotId: null,
              source: "panels/news",
              childCount: 0,
            },
          ],
          nextCursor: null,
        },
      },
      // Nothing has recorded a title for this slot yet.
      presentationDispatch: async (method) => (method === "titlesForSlots" ? {} : undefined),
    });

    const page = (await svc.handler(makeCtx() as never, "panelTree.page", [
      { group: { kind: "roots", ownerUserId: null }, limit: 50 },
    ])) as { nodes: Array<{ title: string }> };

    expect(page.nodes[0]?.title).toBe("panels/news");
  });

  it("binds a null title when the opener had none to give", async () => {
    const { svc, presentationCalls } = makeService({});
    await svc.handler(makeCtx() as never, "slot.create", [
      {
        slotId: "panel:tree/news",
        parentSlotId: null,
        initialEntry: {
          entryKey: "nav-news",
          entityId: "panel:nav-news",
          source: "panels/news",
          contextId: "ctx-news",
        },
      },
    ]);

    expect(presentationCalls).toContainEqual({
      method: "bindSlot",
      args: ["panel:tree/news", "panel:nav-news", "panels/news", null],
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
