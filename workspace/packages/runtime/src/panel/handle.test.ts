import { beforeEach, describe, expect, it, vi } from "vitest";

function readyObservation(panelId: string, source = "panels/example") {
  const runtimeEntityId =
    panelId === "panel-self"
      ? "panel:self-entity"
      : panelId === "panel-parent"
        ? "panel:parent-entity"
        : `panel:${panelId}-entity`;
  return {
    panelId,
    title: panelId.includes("parent") ? "Parent" : "Panel",
    source,
    kind: "workspace" as const,
    parentId: panelId.includes("parent") ? null : "panel-parent",
    contextId: "ctx-meta",
    requestedRef: "main",
    runtimeEntityId,
    attemptId: `${runtimeEntityId}@build-${panelId}`,
    effectiveVersion: `ev-${panelId}`,
    buildKey: `build-${panelId}`,
    phase: "ready" as const,
    updatedAt: 1,
  };
}

function createRpcCall() {
  return vi.fn(async (_target: string, method: string, args: unknown[]) => {
    switch (method) {
      case "workers.resolveService":
        return {
          kind: "durable-object",
          targetId: "do:vibestudio/internal:WorkspaceDO:workspace",
        };
      case "runtime.reserveEntity":
      case "runtime.activateReservedEntity":
      case "runtime.createEntity": {
        const spec = args[0] as {
          key: string;
          contextId?: string;
          execution: { surface: "code"; source: string } | { surface: "external"; url: string };
        };
        return {
          id: `panel:${spec.key}`,
          contextId: spec.contextId ?? "ctx-created",
          source: {
            effectiveVersion: method === "runtime.reserveEntity" ? "" : "ev-created",
          },
          ...(method === "runtime.reserveEntity" ? {} : { buildKey: "build-created" }),
        };
      }
      case "slotCreate":
      case "panelUpdateTitle":
      case "slotUpdateCurrentStateArgs":
      case "panelTree.focus":
        return undefined;
      case "slotCommitPreparedNavigation": {
        const input = args[0] as {
          expectedCurrentEntityId: string;
          mutation: { entry: { entityId: string } };
        };
        return {
          previousEntityId: input.expectedCurrentEntityId,
          currentEntityId: input.mutation.entry.entityId,
        };
      }
      case "build.getPanelMetadata":
        return { title: "Created" };
      case "panelTreeRootGroups":
        return {
          revision: 1,
          groups: [{ ownerUserId: null, rootCount: 1 }],
          nextCursor: null,
        };
      case "panelTreePage": {
        const input = args[0] as {
          group:
            | { kind: "roots"; ownerUserId: string | null }
            | { kind: "children"; parentSlotId: string };
        };
        const childParent = input.group.kind === "children" ? input.group.parentSlotId : null;
        const nodes =
          input.group.kind === "roots"
            ? [
                {
                  slotId: "browser-1",
                  title: "Browser",
                  source: "browser:https://example.com",
                  kind: "browser",
                  parentSlotId: null,
                  ownerUserId: null,
                  contextId: "ctx",
                  runtimeEntityId: "panel:browser-entity",
                  effectiveVersion: "ev-browser",
                  createdAt: 1,
                  childCount: 0,
                },
              ]
            : childParent
              ? [
                  {
                    slotId: "child-1",
                    title: "Child",
                    source: "panels/child",
                    kind: "workspace",
                    parentSlotId: childParent,
                    ownerUserId: null,
                    contextId: "ctx",
                    runtimeEntityId: "panel:child-entity",
                    effectiveVersion: "ev-child",
                    createdAt: 1,
                    childCount: 0,
                  },
                ]
              : [];
        return { revision: 1, group: input.group, nodes, nextCursor: null };
      }
      case "panelTreeDetail":
        return {
          slot: {
            parent_slot_id: String(args[0]).includes("parent") ? null : "panel-parent",
            current_entity_title: String(args[0]).includes("parent") ? "Parent" : "Panel",
          },
          currentHistory: {
            source: String(args[0]).includes("parent") ? "panels/parent" : "panels/self",
            context_id: "ctx-meta",
            state_args: '{"preserved":true}',
            options: null,
          },
          entity: {
            id: `panel:${String(args[0])}-entity`,
            source: { effectiveVersion: `ev-${String(args[0])}` },
          },
        };
      case "panelTree.observe":
        return readyObservation(String(args[0]));
      case "panelRuntime.observeSlot":
        return {
          lease: {
            holderLabel: "Test host",
            platform: "headless",
            supportsCdp: true,
          },
          observation: {
            url: "http://panel.test/",
            loading: false,
            boot: { phase: "ready", updatedAt: 1 },
          },
        };
      case "panelRuntime.ensureSlot":
        return { status: "assigned", lease: null };
      case "panelTree.diagnose":
        return {
          observation: readyObservation(String(args[0])),
          consoleHistory: {
            entries: [{ message: "loaded" }],
            errors: [],
            dropped: { entries: 0, errors: 0 },
            capacity: { entries: 1000, errors: 500 },
          },
        };
      case "panelCdp.getCdpEndpoint":
        return { wsEndpoint: "ws://localhost", token: "t" };
      case "panelCdp.consoleHistory":
        return {
          entries: [
            {
              timestamp: 1,
              level: "info",
              message: "loaded",
              line: 1,
              sourceId: "app.tsx",
              url: "https://example.com",
            },
          ],
          errors: [],
          dropped: { entries: 0, errors: 0 },
          capacity: { entries: 1000, errors: 500 },
        };
      case "panelTree.reload":
        return readyObservation(String(args[0]));
      case "panelTree.rebuildPanel":
        return readyObservation(String(args[0]));
      case "panelTree.navigate":
        return {
          id: args[0],
          title: "Navigated",
          observation: readyObservation(String(args[0]), String(args[1])),
        };
      default:
        return undefined;
    }
  });
}

describe("PanelHandle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@workspace/cdp-client");
    delete (globalThis as any).__vibestudioShell;
    delete (globalThis as any).__vibestudioRequire__;
    delete (globalThis as any).__vibestudioRequireAsync__;
    delete (globalThis as any).__vibestudioLoadImport__;
  });

  it("returns a workspace handle from openPanel", async () => {
    const { _initPanelHandleBridge, openPanel } = await import("./handle.js");
    _initPanelHandleBridge({ call: createRpcCall(), on: vi.fn() } as never);

    const handle = await openPanel("panels/example");

    expect(handle).toMatchObject({
      id: expect.stringMatching(/^panel:tree\/panels~example\//),
      title: "Created",
      source: "panels/example",
      kind: "workspace",
    });
    await expect(handle.cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://localhost",
      token: "t",
    });
    await expect(handle.cdp.consoleHistory()).resolves.toMatchObject({
      capacity: { entries: 1000, errors: 500 },
    });
  });

  it("defaults panel opens under self but treats parentId null as root", async () => {
    const { _initPanelHandleBridge, openPanel } = await import("./handle.js");
    const rpcCall = createRpcCall();
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never, {
      selfId: "panel-self",
    });

    await openPanel("panels/child");
    await openPanel("panels/root", { parentId: null });
    await openPanel("panels/context", {
      contextId: "ctx-next",
      ref: "ctx:ctx-next",
    });

    const reservations = rpcCall.mock.calls.filter(
      ([target, method]) => target === "main" && method === "runtime.reserveEntity"
    );
    expect(reservations).toHaveLength(3);
    expect(reservations[0]?.[2]?.[0]).toMatchObject({
      execution: { surface: "code", source: "panels/child" },
    });
    expect(reservations[1]?.[2]?.[0]).toMatchObject({
      execution: { surface: "code", source: "panels/root" },
    });
    expect(reservations[2]?.[2]?.[0]).toMatchObject({
      execution: {
        surface: "code",
        source: "panels/context",
        ref: "ctx:ctx-next",
      },
      contextId: "ctx-next",
    });
    expect(rpcCall.mock.calls.filter(([, method]) => method === "panelTree.create")).toHaveLength(
      0
    );
  });

  it("hydrates paged browser handles with CDP automation", async () => {
    const { _initPanelHandleBridge, panelTree } = await import("./handle.js");
    _initPanelHandleBridge({ call: createRpcCall(), on: vi.fn() } as never);

    const page = await panelTree.page({
      group: { kind: "roots", ownerUserId: null },
      limit: 200,
    });
    const handle = page.entries[0]?.handle;

    expect(handle?.kind).toBe("browser");
    expect(handle?.source).toBe("https://example.com");
    await expect(handle?.cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://localhost",
      token: "t",
    });
  });

  it("routes hydrated handle RPC to the current runtime entity", async () => {
    const rpcCall = createRpcCall();
    const rpcEmit = vi.fn(async () => undefined);
    const eventHandlers: Array<
      (event: { caller: { callerId: string }; payload: unknown }) => void
    > = [];
    const rpcOn = vi.fn(
      (
        _event: string,
        handler: (event: { caller: { callerId: string }; payload: unknown }) => void
      ) => {
        eventHandlers.push(handler);
        return vi.fn();
      }
    );
    const { _initPanelHandleBridge, panelTree } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, emit: rpcEmit, on: rpcOn } as never);

    const child = (
      await panelTree.page({
        group: { kind: "children", parentSlotId: "parent-1" },
        limit: 200,
      })
    ).entries[0]?.handle;
    expect(child).toBeDefined();
    await (child!.call as Record<string, () => Promise<unknown>>)["ping"]!();
    await child!.emit("ready", { ok: true });
    const listener = vi.fn();
    child!.on("status", listener);
    eventHandlers[0]?.({ caller: { callerId: "panel:other-entity" }, payload: { ignored: true } });
    eventHandlers[0]?.({ caller: { callerId: "panel:child-entity" }, payload: { ok: true } });

    expect(rpcCall).toHaveBeenCalledWith("panel:child-entity", "ping", []);
    expect(rpcEmit).toHaveBeenCalledWith("panel:child-entity", "ready", { ok: true });
    expect(rpcOn).toHaveBeenCalledWith("status", expect.any(Function));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ ok: true });
  });

  it("keeps child contract handles unified with the underlying panel target", async () => {
    const rpcCall = createRpcCall();
    const rpcEmit = vi.fn(async () => undefined);
    const { _initPanelHandleBridge, panelTree } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, emit: rpcEmit, on: vi.fn() } as never);

    const child = (
      await panelTree.page({
        group: { kind: "children", parentSlotId: "parent-1" },
        limit: 200,
      })
    ).entries[0]!.handle;
    const typedChild = child!.withContract({ source: "panels/child" }, "child");

    expect(typedChild).toBe(child);
    expect(typedChild.id).toBe("child-1");
    await (typedChild.call as Record<string, () => Promise<unknown>>)["ping"]!();
    await typedChild.emit("ready", { ok: true });
    await expect(typedChild.cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://localhost",
      token: "t",
    });
    await expect(typedChild.stateArgs.set({ mode: "live" })).resolves.toEqual({
      mode: "live",
      preserved: true,
    });

    expect(rpcCall).toHaveBeenCalledWith("panel:child-entity", "ping", []);
    expect(rpcEmit).toHaveBeenCalledWith("panel:child-entity", "ready", { ok: true });
    expect(rpcCall).toHaveBeenCalledWith(
      "do:vibestudio/internal:WorkspaceDO:workspace",
      "slotUpdateCurrentStateArgs",
      ["child-1", { mode: "live", preserved: true }]
    );
  });

  it("exposes bounded panelTree queries plus get and self handles", async () => {
    const { _initPanelHandleBridge, panelTree } = await import("./handle.js");
    const rpcCall = createRpcCall();
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never, {
      selfId: "panel-self",
      selfRpcTargetId: "panel:self-entity",
      parentId: "panel-parent",
      parentRpcTargetId: "panel:parent-entity",
    });

    const groups = await panelTree.rootGroups({ limit: 200 });
    const roots = await panelTree.page({
      group: { kind: "roots", ownerUserId: groups.groups[0]!.ownerUserId },
      limit: 200,
    });
    const self = panelTree.self();
    const parent = self.parent();

    expect(roots.entries).toHaveLength(1);
    expect(roots.entries[0]?.handle.id).toBe("browser-1");
    await expect(roots.entries[0]?.handle.observe()).resolves.toMatchObject({
      phase: "ready",
    });
    expect(panelTree.get("arbitrary").id).toBe("arbitrary");
    expect(self.id).toBe("panel-self");
    await expect(self.observe()).resolves.toMatchObject({
      panelId: "panel-self",
      parentId: "panel-parent",
    });
    await (self.call as Record<string, () => Promise<unknown>>)["ping"]!();
    expect(rpcCall).toHaveBeenCalledWith("panel:panel-self-entity", "ping", []);
    expect(parent?.id).toBe("panel-parent");
    await expect(parent?.observe()).resolves.toMatchObject({
      panelId: "panel-parent",
      parentId: null,
    });
    await (parent!.call as Record<string, () => Promise<unknown>>)["ping"]!();
    expect(rpcCall).toHaveBeenCalledWith("panel:panel-parent-entity", "ping", []);
  });

  it("lazily resolves arbitrary panel handles before target RPC", async () => {
    const { _initPanelHandleBridge, panelTree } = await import("./handle.js");
    const rpcCall = createRpcCall();
    const rpcEmit = vi.fn(async () => undefined);
    _initPanelHandleBridge({ call: rpcCall, emit: rpcEmit, on: vi.fn() } as never);

    const handle = panelTree.get("arbitrary");
    await (handle.call as Record<string, () => Promise<unknown>>)["ping"]!();
    await handle.emit("ready", { ok: true });

    expect(rpcCall).toHaveBeenCalledWith(
      "do:vibestudio/internal:WorkspaceDO:workspace",
      "panelTreeDetail",
      ["arbitrary"]
    );
    expect(rpcCall).toHaveBeenCalledWith("panel:arbitrary-entity", "ping", []);
    expect(rpcEmit).toHaveBeenCalledWith("panel:arbitrary-entity", "ready", { ok: true });
  });

  it("resolves arbitrary panel event targets once and filters synchronously afterward", async () => {
    const { _initPanelHandleBridge, panelTree } = await import("./handle.js");
    let resolveMetadata!: (value: unknown) => void;
    const metadataPromise = new Promise<unknown>((resolve) => {
      resolveMetadata = resolve;
    });
    const rpcCall = vi.fn(async (_target: string, method: string) => {
      if (method === "workers.resolveService") {
        return {
          kind: "durable-object",
          targetId: "do:vibestudio/internal:WorkspaceDO:workspace",
        };
      }
      if (method === "panelTreeDetail") return metadataPromise;
      return undefined;
    });
    const eventHandlers: Array<
      (event: { caller: { callerId: string }; payload: unknown }) => void
    > = [];
    const rpcOn = vi.fn(
      (
        _event: string,
        handler: (event: { caller: { callerId: string }; payload: unknown }) => void
      ) => {
        eventHandlers.push(handler);
        return vi.fn();
      }
    );
    _initPanelHandleBridge({ call: rpcCall, on: rpcOn } as never);

    const handle = panelTree.get("arbitrary-events");
    const listener = vi.fn();
    handle.on("status", listener);

    for (let i = 0; i < 5; i += 1) {
      eventHandlers[0]?.({
        caller: { callerId: "panel:arbitrary-events-entity" },
        payload: { before: i },
      });
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(rpcCall).toHaveBeenCalledTimes(2);
    expect(rpcCall).toHaveBeenCalledWith(
      "do:vibestudio/internal:WorkspaceDO:workspace",
      "panelTreeDetail",
      ["arbitrary-events"]
    );
    expect(listener).not.toHaveBeenCalled();

    resolveMetadata({
      slot: { parent_slot_id: null, current_entity_title: "Events" },
      currentHistory: {
        source: "panels/events",
        context_id: "ctx-events",
        state_args: null,
        options: null,
      },
      entity: {
        id: "panel:arbitrary-events-entity",
        source: { effectiveVersion: "ev-events" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    eventHandlers[0]?.({
      caller: { callerId: "panel:other-entity" },
      payload: { ignored: true },
    });
    eventHandlers[0]?.({
      caller: { callerId: "panel:arbitrary-events-entity" },
      payload: { ok: true },
    });

    expect(rpcCall).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ ok: true });
  });

  it("targets parent slot, not self, when navigating, reloading, and rebuilding parent handles", async () => {
    const { _initPanelHandleBridge, panelTree } = await import("./handle.js");
    const rpcCall = createRpcCall();
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never, {
      selfId: "panel-self",
      selfRpcTargetId: "panel:self-entity",
      parentId: "panel-parent",
      parentRpcTargetId: "panel:parent-entity",
    });

    const parent = panelTree.self().parent();
    await expect(parent?.rebuild()).resolves.toMatchObject({
      panelId: "panel-parent",
      phase: "ready",
    });
    await expect(parent?.reload()).resolves.toMatchObject({
      panelId: "panel-parent",
      phase: "ready",
    });
    await expect(
      parent?.navigate("panels/next", { contextId: "ctx-next", stateArgs: { mode: "live" } })
    ).resolves.toMatchObject({ panelId: "panel-parent", phase: "ready" });

    expect(rpcCall).toHaveBeenCalledWith("main", "runtime.supervision.restart", [
      { kind: "panel", entityId: "panel:panel-parent-entity" },
    ]);
    expect(rpcCall).toHaveBeenCalledWith(
      "do:vibestudio/internal:WorkspaceDO:workspace",
      "slotCommitPreparedNavigation",
      [
        expect.objectContaining({
          slotId: "panel-parent",
          mutation: expect.objectContaining({ kind: "replace" }),
        }),
      ]
    );
    expect(rpcCall).not.toHaveBeenCalledWith(
      "main",
      "panelTree.rebuildPanel",
      expect.any(Array)
    );
    expect(rpcCall).not.toHaveBeenCalledWith(
      "main",
      "panelTree.reload",
      expect.any(Array)
    );
    expect(rpcCall).toHaveBeenCalledWith(
      "do:vibestudio/internal:WorkspaceDO:workspace",
      "slotCommitPreparedNavigation",
      [expect.objectContaining({ slotId: "panel-parent" })]
    );
    expect(rpcCall).not.toHaveBeenCalledWith("main", "panelTree.navigate", expect.any(Array));
    expect(rpcCall).not.toHaveBeenCalledWith("main", "panelTree.rebuildPanel", ["panel-self"]);
    expect(rpcCall).not.toHaveBeenCalledWith("main", "panelTree.reload", ["panel-self"]);
    expect(rpcCall).not.toHaveBeenCalledWith(
      "main",
      "panelTree.navigate",
      expect.arrayContaining(["panel-self"])
    );
  });

  it("hydrates arbitrary parent handles from discovered tree metadata", async () => {
    const { _initPanelHandleBridge, panelTree } = await import("./handle.js");
    _initPanelHandleBridge({ call: createRpcCall(), on: vi.fn() } as never, {
      selfId: "panel-self",
      parentId: "panel-parent",
    });

    const child = (
      await panelTree.page({
        group: { kind: "children", parentSlotId: "parent-1" },
        limit: 200,
      })
    ).entries[0]?.handle;
    const parent = child?.parent();

    expect(child?.id).toBe("child-1");
    expect(panelTree.parent("child-1")?.id).toBe("parent-1");
    expect(parent?.id).toBe("parent-1");
  });

  it("creates non-panel runtime handles that cannot be targeted", async () => {
    const { createNonPanelRuntimeHandle } = await import("../shared/handles.js");
    const parent = createNonPanelRuntimeHandle({ id: "panel-parent" });
    const handle = createNonPanelRuntimeHandle({
      id: "worker:agent",
      parentId: "panel-parent",
      parent: () => parent,
    });

    expect(handle.id).toBe("worker:agent");
    expect(handle.parent()?.id).toBe("panel-parent");
    await expect(handle.observe()).rejects.toThrow("worker:agent is not a panel target");
    await expect(handle.cdp.getCdpEndpoint()).rejects.toThrow(
      "CDP is not available for panel worker:agent"
    );
    await expect(handle.call["anything"]!()).rejects.toThrow("worker:agent is not a panel target");
    await expect(handle.emit("event", {})).rejects.toThrow("worker:agent is not a panel target");
  });

  it("fails loudly for operations on the unified no-parent handle", async () => {
    const { createNoPanelHandle } = await import("../shared/handles.js");
    const handle = createNoPanelHandle();

    expect(handle.parent()).toBeNull();
    await expect(handle.call["anything"]!()).rejects.toThrow("No parent panel");
    await expect(handle.close()).rejects.toThrow("No parent panel");
    await expect(handle.stateArgs.set({ mode: "fixture" })).rejects.toThrow("No parent panel");
    await expect(handle.emit("event", {})).rejects.toThrow("No parent panel");
  });

  it("routes non-Electron CDP calls through the server panelCdp service", async () => {
    const rpcCall = vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/panel-1", token: "t" }));
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await expect(getPanelHandle("panel-1", "browser").cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://server/cdp/panel-1",
      token: "t",
    });

    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.getCdpEndpoint", ["panel-1"]);
  });

  it("routes non-Electron CDP drive verbs through panelCdp", async () => {
    const rpcCall = createRpcCall();
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await getPanelHandle("panel-1", "browser").cdp.navigate("https://example.com");

    expect(rpcCall).toHaveBeenCalledWith(
      "do:vibestudio/internal:WorkspaceDO:workspace",
      "slotCommitPreparedNavigation",
      [expect.objectContaining({ slotId: "panel-1" })]
    );
    expect(rpcCall).toHaveBeenCalledWith("main", "panelRuntime.handoffSlot", expect.any(Array));
    expect(rpcCall).not.toHaveBeenCalledWith("main", "panelTree.navigate", expect.any(Array));
  });

  it("routes historical console access through panelCdp", async () => {
    const rpcCall = createRpcCall();
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await expect(
      getPanelHandle("panel-1").cdp.consoleHistory({ limit: 50, errorLimit: 50 })
    ).resolves.toMatchObject({
      entries: [expect.objectContaining({ message: "loaded" })],
      capacity: { entries: 1000, errors: 500 },
    });

    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.consoleHistory", [
      "panel-1",
      { limit: 50, errorLimit: 50 },
    ]);
  });

  it("exposes a unified panel diagnostics bundle", async () => {
    const rpcCall = createRpcCall();
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await expect(getPanelHandle("panel-1").diagnose()).resolves.toMatchObject({
      observation: { panelId: "panel-1", phase: "ready" },
      consoleHistory: {
        entries: [expect.objectContaining({ message: "loaded" })],
      },
    });

    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.consoleHistory", [
      "panel-1",
      { limit: 200, errorLimit: 100 },
    ]);
    expect(rpcCall).not.toHaveBeenCalledWith(
      "main",
      "panelTree.diagnose",
      expect.any(Array)
    );
  });

  it("supports handle.click as a CDP automation convenience", async () => {
    const click = vi.fn(async () => undefined);
    const locator = vi.fn(() => ({ click }));
    const page = { locator };
    const connect = vi.fn(async () => ({
      contexts: () => [{ pages: () => [page] }],
    }));
    (globalThis as any).__vibestudioRequireAsync__ = vi.fn(async (id: string) => {
      if (id === "@workspace/cdp-client") return { BrowserImpl: { connect } };
      throw new Error(`unexpected module: ${id}`);
    });
    const rpcCall = vi.fn(async () => ({
      wsEndpoint: "ws://server/cdp/panel-1",
      token: "token-1",
    }));
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await getPanelHandle("panel-1", "browser").click("button.submit");

    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.getCdpEndpoint", ["panel-1"]);
    expect(locator).toHaveBeenCalledWith("button.submit");
    expect(click).toHaveBeenCalledWith();
    expect((globalThis as any).__vibestudioRequireAsync__).toHaveBeenCalledWith(
      "@workspace/cdp-client"
    );
  });

  it("loads the canonical CDP page client only when requested", async () => {
    const page = { marker: "async-page" };
    const connect = vi.fn(async () => ({
      contexts: () => [{ pages: () => [page] }],
    }));
    (globalThis as any).__vibestudioRequire__ = vi.fn(() => {
      throw new Error("not in map");
    });
    (globalThis as any).__vibestudioRequireAsync__ = vi.fn(async (id: string) => {
      if (id === "@workspace/cdp-client") return { BrowserImpl: { connect } };
      throw new Error(`unexpected module: ${id}`);
    });
    const rpcCall = vi.fn(async () => ({
      wsEndpoint: "ws://server/cdp/panel-1",
      token: "token-1",
    }));
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await expect(getPanelHandle("panel-1", "browser").cdp.page()).resolves.toBe(page);

    expect((globalThis as any).__vibestudioRequireAsync__).toHaveBeenNthCalledWith(
      1,
      "@workspace/cdp-client"
    );
  });

  it("routes CDP operations through rpc for workspace and self handles", async () => {
    const rpcCall = createRpcCall();
    const { _initPanelHandleBridge, getPanelHandle, panelTree } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never, {
      selfId: "panel-self",
    });

    // CDP automation is available for every panel target, including workspace
    // panels and the panel the agent is running in (panelTree.self()).
    await expect(
      getPanelHandle("workspace-1").cdp.navigate("https://example.com")
    ).resolves.toBeUndefined();
    await expect(getPanelHandle("workspace-1").cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://localhost",
      token: "t",
    });
    await expect(panelTree.self().cdp.reload()).resolves.toBeUndefined();

    expect(rpcCall).toHaveBeenCalledWith(
      "do:vibestudio/internal:WorkspaceDO:workspace",
      "slotCommitPreparedNavigation",
      [expect.objectContaining({ slotId: "workspace-1" })]
    );
    expect(rpcCall).not.toHaveBeenCalledWith("main", "panelTree.navigate", expect.any(Array));
    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.getCdpEndpoint", ["workspace-1"]);
    expect(rpcCall).toHaveBeenCalledWith("main", "runtime.supervision.restart", [
      { kind: "panel", entityId: "panel:panel-self-entity" },
    ]);
  });

  it("hydrates direct children through bounded pages", async () => {
    const { _initPanelHandleBridge, openPanel, panelTree } = await import("./handle.js");
    const rpcCall = createRpcCall();
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);
    const handle = await openPanel("panels/example");

    const children = await panelTree.page({
      group: { kind: "children", parentSlotId: handle.id },
      limit: 200,
    });

    expect(children.entries).toHaveLength(1);
    expect(children.entries[0]?.handle.id).toBe("child-1");
    expect(rpcCall).toHaveBeenCalledWith(
      "do:vibestudio/internal:WorkspaceDO:workspace",
      "panelTreePage",
      [
        {
          group: { kind: "children", parentSlotId: handle.id },
          limit: 200,
        },
      ]
    );
  });
});
