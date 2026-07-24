import { describe, expect, it, vi } from "vitest";
import { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { Panel, PanelTreeSnapshot } from "@vibestudio/shared/types";
import { getCurrentSnapshot } from "@vibestudio/shared/panel/accessors";
import { asPanelEntityId, asPanelSlotId } from "@vibestudio/shared/panel/ids";
import type { PanelRuntimeLease } from "@vibestudio/shared/panel/panelLease";
import { PanelOrchestrator } from "./panelOrchestrator.js";

function makePanel(id: string, children: Panel[] = [], overrides?: Partial<Panel>): Panel {
  const snapshot = {
    source: `panels/${id}`,
    contextId: `ctx-${id}`,
    options: {},
  };
  return {
    id,
    title: id,
    buildKey: "b".repeat(64),
    executionDigest: "e".repeat(64),
    authorityRequests: [],
    authorityEvalCeilings: [],
    children,
    snapshot,
    artifacts: {},
    ...overrides,
  };
}

// WP3 replaced PanelTreeSnapshot.rootPanels with an owner-grouped `forest`.
// These tests exercise tree-diff/title/prune logic, so grouping the roots under
// a single owner is the faithful shape; the flatMap(group => group.rootPanels)
// the orchestrator applies recovers exactly this root list.
function forestSnapshot(rootPanels: Panel[], revision = 1): PanelTreeSnapshot {
  return { revision, forest: [{ owner: "user-1", rootPanels }] };
}

function runtimeLease(
  runtimeEntityId: string,
  request: {
    slotId: string;
    clientSessionId: string;
    connectionId: string;
    hostConnectionId?: string;
    keepLoaded?: boolean;
  },
  overrides: Partial<PanelRuntimeLease> = {}
): PanelRuntimeLease {
  return {
    slotId: asPanelSlotId(request.slotId),
    runtimeEntityId: asPanelEntityId(runtimeEntityId),
    clientSessionId: request.clientSessionId,
    hostConnectionId: request.hostConnectionId ?? request.connectionId,
    connectionId: request.connectionId,
    holderLabel: "Desktop",
    platform: "desktop",
    supportsCdp: true,
    loadOnLeaseAssignment: false,
    ...(request.keepLoaded ? { keepLoaded: true } : {}),
    acquiredAt: Date.now(),
    ...overrides,
  };
}

function createOrchestrator(
  registry: PanelRegistry,
  emit = vi.fn(),
  opts: {
    panelRestorePolicy?: "focused" | "none";
    runtimeClient?: ConstructorParameters<typeof PanelOrchestrator>[0]["runtimeClient"];
    workspaceConfig?: ConstructorParameters<typeof PanelOrchestrator>[0]["workspaceConfig"];
    pinStore?: ConstructorParameters<typeof PanelOrchestrator>[0]["pinStore"];
    waitForBrowserSessionPartition?: () => Promise<string>;
  } = {}
) {
  const closedIds: string[] = [];
  const panelView = {
    createViewForPanel: vi.fn(async (_panelId: string, _url: string, _contextId?: string) => {}),
    createViewForBrowser: vi.fn(
      async (_panelId: string, _url: string, _contextId: string, _partition: string) => {}
    ),
    hasView: vi.fn((_panelId: string) => false),
    getWebContents: vi.fn((_panelId: string) => null),
    getViewPartition: vi.fn((_panelId: string) => undefined as string | undefined),
    setViewVisible: vi.fn((_panelId: string, _visible: boolean) => {}),
    destroyView: vi.fn((_panelId: string) => {}),
    reloadView: vi.fn(async (_panelId: string) => true),
  };
  const panelHttpServer = {
    getBuildRevision: vi.fn(() => undefined as number | undefined),
    invalidateBuild: vi.fn(),
    getPort: vi.fn(),
  };
  const shellCore = {
    close: vi.fn(async (panelId: string) => ({ closedIds: [panelId, ...closedIds] })),
    create: vi.fn(async (_source?: string, _options?: unknown) => ({
      panelId: "created-panel",
      title: "created-panel",
      contextId: "ctx-created-panel",
      source: "panels/created-panel",
      options: {},
    })),
    createBrowser: vi.fn(async (_parentId: string | null, url: string, _options?: unknown) => ({
      panelId: "created-browser",
      title: "created-browser",
      contextId: "ctx-created-browser",
      source: `browser:${url}`,
      options: {},
    })),
    updateTitle: vi.fn(async (_panelId: string, _title: string) => {}),
    onStateArgsChanged: vi.fn(() => () => {}),
    notifyFocused: vi.fn(async () => {}),
    getPanelInit: vi.fn(async (panelId: string) => ({
      entityId: panelId,
      gatewayConfig: { serverUrl: "http://127.0.0.1:1234", token: "token" },
    })),
    getCurrentEntityId: vi.fn(async (panelId: string) => `panel:nav-${panelId}`),
    refreshSlotEntity: vi.fn(async (panelId: string) => `panel:nav-${panelId}`),
    syncEntityCachesFromRegistry: vi.fn(() => {}),
    loadTree: vi.fn(async () => ({ collapsedIds: [] })),
  };
  let orchestratorRef: PanelOrchestrator | null = null;
  let createCounter = 0;
  let leaseVersionCounter = 0;
  // Mirror the server's lease broadcast. Local loading owns native view
  // creation directly; this event keeps registry state synchronized and tests
  // the independent remote-assignment path.
  const dispatchAssignedLease = async (
    runtimeEntityId: string,
    request: {
      slotId: string;
      clientSessionId: string;
      connectionId: string;
      keepLoaded?: boolean;
    }
  ): Promise<PanelRuntimeLease> => {
    const orch = orchestratorRef;
    const next = runtimeLease(runtimeEntityId, request);
    if (!orch) return next;
    leaseVersionCounter += 1;
    await orch.handleRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: leaseVersionCounter },
      slotId: asPanelSlotId(request.slotId),
      runtimeEntityId: asPanelEntityId(runtimeEntityId),
      previous: null,
      next,
      reason: "acquired",
    });
    return next;
  };
  const handleServerCall = async (service: string, method: string, args?: unknown[]) => {
    if (method === "registerClient") return undefined;
    if (method === "acquire" || method === "takeOver") {
      const [runtimeEntityId, request] = (args ?? []) as [
        string,
        { slotId: string; clientSessionId: string; connectionId: string },
      ];
      if (!runtimeEntityId || !request) throw new Error("panelRuntime.acquire fixture needs args");
      const lease = await dispatchAssignedLease(runtimeEntityId, request);
      return { acquired: true, lease };
    }
    if (method === "getSnapshot") return { version: { epoch: "test", counter: 1 }, leases: [] };
    if (service === "panelTree" && method === "getTreeSnapshot") {
      return registry.getPanelTreeSnapshot();
    }
    // Simulate the server panel-tree authority: create adds a panel to the
    // mirror (as the broadcast would) and returns its identity; archive removes
    // it. This lets the desktop orchestrator's panelTree create/close paths
    // resolve in tests.
    if (service === "panelTree" && method === "create") {
      const [src, opts] = (args ?? []) as [
        string,
        { parentId?: string | null; name?: string } | undefined,
      ];
      const isBrowser = /^https?:\/\//i.test(String(src));
      const id = `panel:tree/created-${++createCounter}`;
      const contextId = `ctx-${id}`;
      const snapshotSource = isBrowser ? `browser:${src}` : String(src);
      registry.addPanel(
        makePanel(id, [], {
          snapshot: { source: snapshotSource, contextId, options: {} },
          ...(isBrowser ? { artifacts: { buildState: "ready" } } : {}),
        }),
        opts?.parentId ?? null,
        { addAsRoot: opts?.parentId == null }
      );
      return {
        id,
        title: id,
        kind: isBrowser ? "browser" : "workspace",
        contextId,
        source: snapshotSource,
      };
    }
    if (service === "panelTree" && method === "archive") {
      const [id] = (args ?? []) as [string];
      registry.removePanel(String(id));
      return { closedIds: [String(id)] };
    }
    if (service === "panelTree" && method === "navigate") {
      const [id, src, opts] = (args ?? []) as [
        string,
        string,
        { contextId?: string; stateArgs?: Record<string, unknown>; ref?: string } | undefined,
      ];
      const panel = registry.getPanel(String(id));
      if (!panel) return null;
      const contextId = opts?.contextId ?? getCurrentSnapshot(panel).contextId;
      return {
        id,
        title: id,
        kind: "workspace",
        contextId,
        source: String(src),
      };
    }
    if (service === "panelTree" && method === "snapshot") {
      const [panelId] = (args ?? []) as [string];
      const panel = registry.getPanel(String(panelId));
      return panel ? getCurrentSnapshot(panel) : null;
    }
    return undefined;
  };
  const serverClient = {
    call: vi.fn(handleServerCall),
    callAs: vi.fn(
      async (
        _caller: { callerId: string; callerKind: string },
        service: string,
        method: string,
        args?: unknown[]
      ) => handleServerCall(service, method, args)
    ),
  };
  const cdpHost = {
    registerTarget: vi.fn(),
    cleanupPanelAccess: vi.fn(),
    unregisterTarget: vi.fn(),
  };
  const sendPanelEvent = vi.fn();
  const orchestrator = new PanelOrchestrator({
    registry,
    eventService: { emit } as never,
    serverClient: serverClient as never,
    shellCore: shellCore as never,
    cdpHost,
    panelHttpServer,
    externalHost: "localhost",
    protocol: "http",
    gatewayPort: 1234,
    sendPanelEvent,
    getPanelView: () => panelView as never,
    workspaceConfig:
      opts.workspaceConfig ??
      (opts.panelRestorePolicy
        ? ({ id: "test", panelRestorePolicy: opts.panelRestorePolicy } as never)
        : undefined),
    runtimeClient: opts.runtimeClient,
    pinStore: opts.pinStore,
    waitForBrowserSessionPartition:
      opts.waitForBrowserSessionPartition ?? (() => Promise.resolve("persist:browser-test")),
  });
  orchestratorRef = orchestrator;

  return {
    orchestrator,
    emit,
    shellCore,
    closedIds,
    panelView,
    panelHttpServer,
    serverClient,
    cdpHost,
    sendPanelEvent,
    dispatchAssignedLease,
  };
}

describe("PanelOrchestrator.closePanel", () => {
  it("registers the runtime host before CDP provider startup can claim its host id", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const { orchestrator, serverClient } = createOrchestrator(registry, vi.fn(), {
      runtimeClient: {
        clientSessionId: "host-session",
        platform: "headless",
        loadOnLeaseAssignment: true,
        label: "Headless",
        supportsCdp: true,
      },
    });

    await orchestrator.registerRuntimeClient();
    await orchestrator.registerRuntimeClient();

    expect(serverClient.call).toHaveBeenCalledTimes(1);
    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "registerClient", [
      {
        clientSessionId: "host-session",
        hostConnectionId: "host-session",
        label: "Headless",
        platform: "headless",
        loadOnLeaseAssignment: true,
        supportsCdp: true,
      },
    ]);
  });

  it("unregisters the runtime host once during shutdown", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const { orchestrator, serverClient } = createOrchestrator(registry, vi.fn(), {
      runtimeClient: {
        clientSessionId: "host-session",
        platform: "headless",
        loadOnLeaseAssignment: true,
        label: "Headless",
        supportsCdp: true,
      },
    });

    await orchestrator.registerRuntimeClient();
    await orchestrator.unregisterRuntimeClient();
    await orchestrator.unregisterRuntimeClient();

    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "unregisterClient", [
      "host-session",
    ]);
    expect(
      serverClient.call.mock.calls.filter(
        ([service, method]) => service === "panelRuntime" && method === "unregisterClient"
      )
    ).toHaveLength(1);
  });

  it("navigates away when closing a root that contains the focused panel", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const closingRoot = makePanel("panel:tree/closing-root");
    const nextRoot = makePanel("panel:tree/next-root");
    registry.addPanel(nextRoot, null, { addAsRoot: true });
    registry.addPanel(closingRoot, null, { addAsRoot: true });
    const focusedChild = makePanel("panel:tree/focused-child");
    registry.addPanel(focusedChild, closingRoot.id);
    registry.updateSelectedPath(focusedChild.id);

    const { orchestrator, emit, closedIds } = createOrchestrator(registry);
    closedIds.push(focusedChild.id);

    await orchestrator.closePanel(closingRoot.id);

    expect(emit).toHaveBeenCalledWith("navigate-to-panel", { panelId: nextRoot.id });
  });

  it("does not navigate when closing a sibling outside the focused subtree", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("panel:tree/root");
    registry.addPanel(root, null, { addAsRoot: true });
    const sibling = makePanel("panel:tree/sibling");
    registry.addPanel(sibling, root.id);
    const focusedChild = makePanel("panel:tree/focused-child");
    registry.addPanel(focusedChild, root.id);
    registry.updateSelectedPath(focusedChild.id);

    const { orchestrator, emit } = createOrchestrator(registry);

    await orchestrator.closePanel(sibling.id);

    expect(emit).not.toHaveBeenCalledWith("navigate-to-panel", expect.anything());
  });

  it("routes close through the server authority (reactive prune handles teardown)", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("panel:tree/root");
    registry.addPanel(root, null, { addAsRoot: true });
    const { orchestrator, serverClient } = createOrchestrator(registry);

    await orchestrator.closePanel(root.id);

    // The server closes the subtree + broadcasts; local view/lease teardown is
    // reactive (applyServerPanelTreeSnapshot → pruneRemovedPanelLocally, covered
    // by the prune test).
    expect(serverClient.call).toHaveBeenCalledWith("panelTree", "archive", [root.id]);
  });
});

describe("PanelOrchestrator.ensureLoaded", () => {
  it("loads a panel without selecting or focusing it", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/target");
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView, shellCore, emit } = createOrchestrator(registry);
    let loaded = false;
    panelView.createViewForPanel.mockImplementationOnce(async () => {
      loaded = true;
    });
    panelView.hasView.mockImplementation(
      (panelId: string) => panelId === "panel:tree/target" && loaded
    );

    await expect(orchestrator.ensureLoaded("panel:tree/target")).resolves.toMatchObject({
      panelId: "panel:tree/target",
      status: "loaded",
      focused: false,
      loaded: true,
    });

    expect(shellCore.notifyFocused).not.toHaveBeenCalled();
    expect(panelView.setViewVisible).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith("navigate-to-panel", expect.anything());
  });

  it("repairs a missing runtime lease for an existing native view and registers CDP", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView, cdpHost, serverClient } = createOrchestrator(registry);
    panelView.hasView.mockImplementation((panelId: string) => panelId === panel.id);
    panelView.getWebContents.mockReturnValue({ id: 42, isDestroyed: () => false } as never);

    await expect(orchestrator.ensureLoaded(panel.id)).resolves.toMatchObject({
      panelId: panel.id,
      status: "loaded",
      focused: false,
      loaded: true,
    });

    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "acquire", [
      expect.stringMatching(/^panel:nav-panel:tree\/panel-1$/),
      expect.objectContaining({
        slotId: panel.id,
        clientSessionId: orchestrator.getRuntimeClientSessionId(),
      }),
    ]);
    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
    expect(cdpHost.registerTarget).toHaveBeenCalledWith(panel.id, 42);
  });
});

describe("PanelOrchestrator.focusPanel", () => {
  it("shows an existing native panel view from main when focusing", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView, emit } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);

    const result = await orchestrator.focusPanel(panel.id);

    expect(panelView.setViewVisible).toHaveBeenCalledWith(panel.id, true);
    expect(emit).toHaveBeenCalledWith("navigate-to-panel", { panelId: panel.id });
    expect(result).toMatchObject({ status: "loaded", focused: true, loaded: true });
  });

  it("emits the layout intent with parentId and the snapshot's resolved placement hint", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const child = makePanel("panel:tree/parent/child", [], {
      snapshot: {
        source: "panels/child",
        contextId: "ctx-child",
        options: {},
        placement: { disposition: "split-below", preferredWidth: 500 },
      },
    });
    const parent = makePanel("panel:tree/parent");
    registry.addPanel(parent, null, { addAsRoot: true });
    registry.addPanel(child, parent.id);

    const { orchestrator, panelView, emit } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);

    await orchestrator.focusPanel(child.id);

    expect(emit).toHaveBeenCalledWith("navigate-to-panel", {
      panelId: child.id,
      parentId: parent.id,
      hint: { disposition: "split-below", preferredWidth: 500 },
    });
  });

  it("loads a missing native view during focus even when build is already ready", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/panel-1", [], {
      artifacts: { buildState: "ready" },
    });
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView } = createOrchestrator(registry);
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForPanel.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });
    const result = await orchestrator.focusPanel(panel.id, { loadIfNeeded: true });

    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      panel.id,
      expect.stringContaining("/panels/panel%3Atree/panel-1/"),
      "ctx-panel:tree/panel-1"
    );
    expect(panelView.setViewVisible).toHaveBeenCalledWith(panel.id, true);
    expect(result).toMatchObject({ status: "loaded", focused: true, loaded: true });
  });

  it("acquires and releases runtime leases for browser panels", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/browser-1", [], {
      snapshot: {
        source: "browser:https://example.com",
        contextId: "ctx-browser-1",
        options: {},
      },
      artifacts: { buildState: "ready" },
    });
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView, serverClient } = createOrchestrator(registry);
    const loadedPanels = new Set<string>([panel.id]);
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForBrowser.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });

    await expect(orchestrator.ensureLoaded(panel.id)).resolves.toMatchObject({
      status: "loaded",
      loaded: true,
    });

    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "acquire", [
      `panel:nav-${panel.id}`,
      expect.objectContaining({
        slotId: panel.id,
        clientSessionId: orchestrator.getRuntimeClientSessionId(),
      }),
    ]);

    await orchestrator.unloadPanel(panel.id);

    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "release", [
      `panel:nav-${panel.id}`,
      expect.stringContaining(`desktop-${panel.id}-`),
    ]);
  });

  it("returns a structured leased_elsewhere result when focus cannot acquire runtime", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/panel-1", [], {
      artifacts: { buildState: "pending" },
    });
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, serverClient } = createOrchestrator(registry);
    serverClient.call.mockImplementation(
      async (_service: string, method: string, args?: unknown[]) => {
        if (method === "registerClient") return undefined;
        if (method === "acquire") {
          const [runtimeEntityId, request] = args as [
            string,
            {
              slotId: string;
              clientSessionId: string;
              connectionId: string;
              hostConnectionId?: string;
            },
          ];
          return {
            acquired: false,
            lease: runtimeLease(runtimeEntityId, request, { holderLabel: "Desktop B" }),
          };
        }
        return undefined;
      }
    );

    const result = await orchestrator.focusPanel(panel.id, { loadIfNeeded: true });

    expect(result).toMatchObject({
      status: "leased_elsewhere",
      focused: true,
      loaded: false,
      message: expect.stringContaining("Desktop B"),
    });
  });
});

describe("PanelOrchestrator.createPanel", () => {
  it("creates unscoped child panels as the trusted host (shell authority)", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });
    const { orchestrator, panelView, serverClient } = createOrchestrator(registry);
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForPanel.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });

    // Host-intercepted panel links carry no scoped caller — the call must route
    // through the shell connection (serverClient.call), never an act-as-panel
    // scoped connection (callAs), which the panel lease gate would reject.
    await orchestrator.createPanel(caller.id, "panels/created-panel");

    expect(serverClient.call).toHaveBeenCalledWith("panelTree", "create", [
      "panels/created-panel",
      expect.objectContaining({ parentId: caller.id }),
    ]);
    expect(serverClient.callAs).not.toHaveBeenCalledWith(
      expect.anything(),
      "panelTree",
      "create",
      expect.anything()
    );
  });

  it("focuses after creating the native view for focused panels", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });

    const { orchestrator, panelView, emit, serverClient } = createOrchestrator(registry);
    // Reactive host: the acquired-lease broadcast builds the view, so track
    // built views in a Set (createViewForPanel marks the slot present).
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForPanel.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });
    const scopedCaller = { callerId: "@workspace-apps/shell", callerKind: "app" as const };

    // Scoped panelTree create: the harness mock adds the panel to the mirror
    // and returns its identity; acquiring the lease drives the reactive build.
    const { id } = await orchestrator.createPanel(
      caller.id,
      "panels/created-panel",
      {
        focus: true,
      },
      undefined,
      scopedCaller
    );

    expect(serverClient.callAs).toHaveBeenCalledWith(scopedCaller, "panelTree", "create", [
      "panels/created-panel",
      expect.objectContaining({ parentId: caller.id }),
    ]);
    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      id,
      expect.stringContaining("/panels/created-panel/"),
      `ctx-${id}`
    );
    expect(panelView.setViewVisible).toHaveBeenCalledWith(id, true);
    expect(emit).toHaveBeenCalledWith("navigate-to-panel", { panelId: id, parentId: caller.id });
    expect(panelView.createViewForPanel.mock.invocationCallOrder[0]).toBeLessThan(
      panelView.setViewVisible.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("keeps a created workspace panel visible with an error when reactive native view creation fails", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });

    const { orchestrator, panelView, serverClient, emit } = createOrchestrator(registry);
    panelView.createViewForPanel.mockRejectedValueOnce(new Error("native view failed"));
    const scopedCaller = { callerId: "@workspace-apps/shell", callerKind: "app" as const };

    await expect(
      orchestrator.createPanel(
        caller.id,
        "panels/created-panel",
        {
          focus: true,
        },
        undefined,
        scopedCaller
      )
    ).rejects.toThrow("native view failed");

    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "release", [
      "panel:nav-panel:tree/created-1",
      expect.stringMatching(/^desktop-panel:tree\/created-1-/),
    ]);
    expect(serverClient.callAs).not.toHaveBeenCalledWith(scopedCaller, "panelTree", "archive", [
      "panel:tree/created-1",
    ]);
    expect(registry.getPanel("panel:tree/created-1")?.artifacts).toMatchObject({
      buildState: "error",
      error: "native view failed",
      buildProgress: "native view failed",
    });
    expect(emit).toHaveBeenCalledWith("navigate-to-panel", {
      panelId: "panel:tree/created-1",
      parentId: "panel:tree/caller",
    });
  });

  it("acquires a runtime lease before creating browser panel views", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });

    const { orchestrator, panelView, serverClient } = createOrchestrator(registry);
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForBrowser.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });
    const scopedCaller = { callerId: "@workspace-apps/shell", callerKind: "app" as const };

    const { id } = await orchestrator.createBrowserUrlPanel(
      caller.id,
      "https://example.com/",
      {
        focus: false,
      },
      scopedCaller
    );

    const acquireCallIndex = serverClient.call.mock.calls.findIndex(
      ([service, method]) => service === "panelRuntime" && method === "acquire"
    );
    expect(acquireCallIndex).toBeGreaterThanOrEqual(0);
    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "acquire", [
      `panel:nav-${id}`,
      expect.objectContaining({
        slotId: id,
        clientSessionId: orchestrator.getRuntimeClientSessionId(),
      }),
    ]);
    expect(panelView.createViewForBrowser).toHaveBeenCalledWith(
      id,
      "https://example.com/",
      `ctx-${id}`,
      "persist:browser-test"
    );
    const acquireOrder = serverClient.call.mock.invocationCallOrder[acquireCallIndex];
    const createViewOrder = panelView.createViewForBrowser.mock.invocationCallOrder[0];
    expect(acquireOrder).toBeDefined();
    expect(createViewOrder).toBeDefined();
    expect(acquireOrder!).toBeLessThan(createViewOrder!);
  });

  it("waits for browser-environment readiness before acquiring a lease or creating a view", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });
    let resolvePartition!: (partition: string) => void;
    const partitionReady = new Promise<string>((resolve) => {
      resolvePartition = resolve;
    });
    const { orchestrator, panelView, serverClient } = createOrchestrator(registry, vi.fn(), {
      waitForBrowserSessionPartition: () => partitionReady,
    });
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForBrowser.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });

    const creating = orchestrator.createBrowserUrlPanel(caller.id, "https://example.com/", {
      focus: false,
    });
    await vi.waitFor(() =>
      expect(serverClient.call).toHaveBeenCalledWith("panelTree", "create", expect.any(Array))
    );
    expect(
      serverClient.call.mock.calls.some(
        ([service, method]) => service === "panelRuntime" && method === "acquire"
      )
    ).toBe(false);
    expect(panelView.createViewForBrowser).not.toHaveBeenCalled();

    resolvePartition("persist:browser-environment:ready");
    await expect(creating).resolves.toMatchObject({ id: expect.any(String) });
    expect(panelView.createViewForBrowser).toHaveBeenCalledWith(
      expect.any(String),
      "https://example.com/",
      expect.any(String),
      "persist:browser-environment:ready"
    );
  });

  it("creates unscoped browser child panels as the trusted host (shell authority)", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });
    const { orchestrator, panelView, serverClient } = createOrchestrator(registry);
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForBrowser.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });

    await orchestrator.createBrowserUrlPanel(caller.id, "https://example.com/");

    expect(serverClient.call).toHaveBeenCalledWith("panelTree", "create", [
      "https://example.com/",
      expect.objectContaining({ parentId: caller.id }),
    ]);
    expect(serverClient.callAs).not.toHaveBeenCalled();
  });

  it("keeps a created browser panel visible with an error when native browser view creation fails", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });

    const { orchestrator, panelView, serverClient } = createOrchestrator(registry);
    panelView.createViewForBrowser.mockRejectedValueOnce(new Error("native view failed"));
    const scopedCaller = { callerId: "@workspace-apps/shell", callerKind: "app" as const };

    await expect(
      orchestrator.createBrowserUrlPanel(
        caller.id,
        "https://example.com/",
        {
          focus: false,
        },
        scopedCaller
      )
    ).rejects.toThrow("native view failed");

    const acquireCall = serverClient.call.mock.calls.find(
      ([service, method]) => service === "panelRuntime" && method === "acquire"
    );
    expect(acquireCall).toBeDefined();
    // The harness assigns the first server-created panel id "panel:tree/created-1"; on browser
    // view failure attachCreatedPanel releases its lease before rethrowing.
    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "release", [
      "panel:nav-panel:tree/created-1",
      expect.stringMatching(/^desktop-panel:tree\/created-1-/),
    ]);
    expect(serverClient.callAs).not.toHaveBeenCalledWith(scopedCaller, "panelTree", "archive", [
      "panel:tree/created-1",
    ]);
    expect(registry.getPanel("panel:tree/created-1")?.artifacts).toMatchObject({
      buildState: "error",
      error: "native view failed",
      buildProgress: "native view failed",
    });
  });
});

describe("PanelOrchestrator.navigatePanel", () => {
  it("routes replacement through the shell connection and lets the authoritative tree load once", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/current", [], {
      runtimeEntityId: asPanelEntityId("panel:nav-current"),
    });
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView, serverClient } = createOrchestrator(registry);
    const loadedPanels = new Set<string>([panel.id]);
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForPanel.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });

    // No scoped caller: the trusted host navigates the source slot as chrome.
    await orchestrator.navigatePanel(panel.id, "panels/chat", {
      stateArgs: { initialPrompt: "hello" },
    });

    expect(serverClient.call).toHaveBeenCalledWith("panelTree", "navigate", [
      panel.id,
      "panels/chat",
      { stateArgs: { initialPrompt: "hello" } },
    ]);
    expect(serverClient.callAs).not.toHaveBeenCalled();
    expect(panelView.createViewForPanel).not.toHaveBeenCalled();

    await orchestrator.applyServerPanelTreeSnapshot(
      forestSnapshot([
        makePanel(panel.id, [], {
          runtimeEntityId: asPanelEntityId(`panel:nav-${panel.id}-next`),
          snapshot: {
            source: "panels/chat",
            contextId: `ctx-${panel.id}`,
            options: {},
            stateArgs: { initialPrompt: "hello" },
          },
        }),
      ])
    );

    expect(panelView.createViewForPanel).toHaveBeenCalledTimes(1);
    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      panel.id,
      expect.stringContaining("/panels/chat/"),
      `ctx-${panel.id}`
    );
  });

  it("keeps a build failure that arrives while the awaited panel load is in flight", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/current");
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView } = createOrchestrator(registry);
    panelView.hasView.mockImplementation((panelId: string) => panelId === panel.id);
    panelView.createViewForPanel.mockImplementationOnce(async () => {
      orchestrator.applyBuildComplete("panels/chat", "compile failed");
    });

    await orchestrator.navigatePanel(panel.id, "panels/chat");
    await orchestrator.applyServerPanelTreeSnapshot(
      forestSnapshot([
        makePanel(panel.id, [], {
          runtimeEntityId: asPanelEntityId(`panel:nav-${panel.id}-next`),
          snapshot: {
            source: "panels/chat",
            contextId: `ctx-${panel.id}`,
            options: {},
          },
        }),
      ])
    );

    expect(registry.getPanel(panel.id)?.artifacts).toMatchObject({
      buildState: "error",
      error: "compile failed",
      buildProgress: "compile failed",
    });
  });
});

describe("PanelOrchestrator.applyBuildComplete", () => {
  it("records source completion without pretending any slot selected or loaded that build", () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const first = makePanel("panel:tree/slot-a", [], {
      snapshot: {
        source: "panels/chat",
        contextId: "ctx-a",
        options: {},
      },
      artifacts: { buildState: "building", buildProgress: "Waiting for build..." },
    });
    const second = makePanel("panel:tree/slot-b", [], {
      snapshot: {
        source: "panels/chat",
        contextId: "ctx-b",
        options: {},
      },
      artifacts: { buildState: "building", buildProgress: "Waiting for build..." },
    });
    registry.addPanel(first, null, { addAsRoot: true });
    registry.addPanel(second, null, { addAsRoot: true });

    const { orchestrator, panelView, panelHttpServer } = createOrchestrator(registry);
    panelView.hasView.mockImplementation((panelId: string) => panelId === first.id);
    panelHttpServer.getBuildRevision.mockReturnValue(12);

    orchestrator.applyBuildComplete("panels/chat");

    expect(registry.getPanel(first.id)?.artifacts).toMatchObject({
      buildState: "building",
      buildRevision: 12,
      buildProgress: "Build complete — waiting for runtime activation",
    });
    expect(registry.getPanel(first.id)?.artifacts.htmlPath).toBeUndefined();
    expect(registry.getPanel(first.id)?.state?.view.exists).toBe(false);
    expect(registry.getPanel(second.id)?.artifacts).toMatchObject({
      buildState: "building",
      buildRevision: 12,
      buildProgress: "Build complete — waiting for runtime activation",
    });
    expect(registry.getPanel(second.id)?.artifacts.htmlPath).toBeUndefined();
    expect(registry.getPanel(second.id)?.state?.view.exists).toBe(false);
  });

  it("does not derive a panel URL when the slot has not received its immutable build key", () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/slot-a", [], {
      buildKey: null,
      executionDigest: null,
      snapshot: {
        source: "panels/chat",
        contextId: "ctx-a",
        options: {},
      },
      artifacts: { buildState: "building", buildProgress: "Waiting for build..." },
    });
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);

    expect(() => orchestrator.applyBuildComplete("panels/chat")).not.toThrow();
    expect(registry.getPanel(panel.id)?.artifacts).toMatchObject({
      buildState: "building",
      buildProgress: "Build complete — waiting for runtime activation",
    });
  });
});

describe("PanelOrchestrator.rebuildPanel", () => {
  it("forces a rebuild for the named panel without rebuilding child panels", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const child = makePanel("panel:tree/child", [], {
      snapshot: {
        source: "panels/child",
        contextId: "ctx-panel:tree/child",
        options: {},
      },
      artifacts: { buildState: "ready", buildRevision: 7 },
    });
    const parent = makePanel("panel:tree/parent", [], {
      snapshot: {
        source: "panels/parent",
        contextId: "ctx-panel:tree/parent",
        options: {},
      },
      artifacts: { buildState: "ready", buildRevision: 3 },
    });
    registry.addPanel(parent, null, { addAsRoot: true });
    registry.addPanel(child, parent.id);

    const { orchestrator, panelView, panelHttpServer } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);

    const result = await orchestrator.rebuildPanel(parent.id);

    expect(panelHttpServer.invalidateBuild).toHaveBeenCalledWith("panels/parent");
    expect(panelHttpServer.invalidateBuild).not.toHaveBeenCalledWith("panels/child");
    expect(panelView.createViewForPanel).toHaveBeenCalledTimes(1);
    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      parent.id,
      expect.stringContaining("/panels/parent/"),
      "ctx-panel:tree/parent"
    );
    expect(registry.getPanel(parent.id)?.artifacts).toMatchObject({
      buildState: "ready",
      buildProgress: undefined,
    });
    expect(registry.getPanel(child.id)?.artifacts).toMatchObject({
      buildState: "ready",
      buildRevision: 7,
    });
    expect(result).toMatchObject({
      panelId: parent.id,
      operation: "rebuild",
      status: "rebuild_requested",
      rebuilt: true,
      reloaded: false,
    });
  });

  it("rebuilds and reloads only the named panel", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const parent = makePanel("panel:tree/parent", [], {
      snapshot: {
        source: "panels/parent",
        contextId: "ctx-panel:tree/parent",
        options: {},
      },
      artifacts: { buildState: "ready", buildRevision: 3 },
    });
    const child = makePanel("panel:tree/child", [], {
      snapshot: {
        source: "panels/child",
        contextId: "ctx-panel:tree/child",
        options: {},
      },
      artifacts: { buildState: "ready", buildRevision: 7 },
    });
    registry.addPanel(parent, null, { addAsRoot: true });
    registry.addPanel(child, parent.id);

    const { orchestrator, panelView, panelHttpServer } = createOrchestrator(registry);
    panelView.hasView.mockImplementation((panelId: string) => panelId === parent.id);

    const result = await orchestrator.rebuildAndReloadPanel(parent.id);

    expect(panelHttpServer.invalidateBuild).toHaveBeenCalledWith("panels/parent");
    expect(panelHttpServer.invalidateBuild).not.toHaveBeenCalledWith("panels/child");
    expect(panelView.reloadView).toHaveBeenCalledWith(parent.id);
    expect(panelView.reloadView).not.toHaveBeenCalledWith(child.id);
    expect(panelView.destroyView).not.toHaveBeenCalledWith(child.id);
    expect(result).toMatchObject({
      panelId: parent.id,
      operation: "rebuildAndReload",
      status: "rebuilt_and_reloaded",
      loaded: true,
      rebuilt: true,
      reloaded: true,
    });
  });
});

describe("PanelOrchestrator.recoverShellSnapshot", () => {
  it("syncs tree and leases, resolves focus, and publishes one normalized snapshot", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("panel:tree/root");
    registry.addPanel(root, null, { addAsRoot: true });
    const emit = vi.fn();
    const { orchestrator, shellCore, serverClient } = createOrchestrator(registry, emit);

    const snapshot = await orchestrator.recoverShellSnapshot({ loadFocusedView: false });

    expect(shellCore.loadTree).toHaveBeenCalled();
    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "getSnapshot", []);
    expect(snapshot.focusedPanelId).toBe(root.id);
    expect(snapshot.focus).toMatchObject({
      panelId: root.id,
      status: "focused",
      focused: true,
      loaded: false,
    });
    expect(emit).toHaveBeenCalledWith(
      "panel:snapshot",
      expect.objectContaining({
        focusedPanelId: root.id,
        rootPanels: expect.arrayContaining([expect.objectContaining({ id: root.id })]),
      })
    );
  });

  it("loads the focused view by default restore policy", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("panel:tree/root", [], { artifacts: { buildState: "pending" } });
    registry.addPanel(root, null, { addAsRoot: true });
    registry.updateSelectedPath(root.id);
    const { orchestrator, panelView } = createOrchestrator(registry);
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForPanel.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });

    const snapshot = await orchestrator.recoverShellSnapshot();

    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      root.id,
      expect.stringContaining("/panels/panel%3Atree/root/"),
      "ctx-panel:tree/root"
    );
    expect(snapshot.focus).toMatchObject({ status: "loaded", loaded: true });
  });

  it("can restore only tree state when policy is none", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("panel:tree/root", [], { artifacts: { buildState: "pending" } });
    registry.addPanel(root, null, { addAsRoot: true });
    registry.updateSelectedPath(root.id);
    const { orchestrator, panelView } = createOrchestrator(registry, vi.fn(), {
      panelRestorePolicy: "none",
    });

    const snapshot = await orchestrator.recoverShellSnapshot();

    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
    expect(snapshot.focus).toMatchObject({ status: "focused", loaded: false });
  });
});

describe("PanelOrchestrator.initializePanelTree", () => {
  it("never client-seeds initPanels — the server is the sole tree authority", async () => {
    // The authenticated getTreeSnapshot read is the server-owned first-attach
    // trigger. The desktop must NOT create init panels itself.
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const { orchestrator, serverClient, shellCore } = createOrchestrator(registry, vi.fn(), {
      workspaceConfig: {
        id: "test",
        panelRestorePolicy: "none",
        initPanels: [
          { source: "panels/chat", stateArgs: { initialPrompt: "first" } },
          { source: "panels/chat", stateArgs: { initialPrompt: "second" } },
        ],
      } as never,
    });

    await orchestrator.initializePanelTree();

    const createCalls = serverClient.call.mock.calls.filter(
      ([service, method]) => service === "panelTree" && method === "create"
    );
    const createAsCalls = serverClient.callAs.mock.calls.filter(
      ([, service, method]) => service === "panelTree" && method === "create"
    );
    expect(createCalls).toHaveLength(0);
    expect(createAsCalls).toHaveLength(0);
    expect(serverClient.call).toHaveBeenCalledWith("panelTree", "getTreeSnapshot", []);
    expect(shellCore.loadTree).not.toHaveBeenCalled();
    expect(registry.getRootPanels()).toHaveLength(0);
  });

  it("syncs the server-seeded tree without re-creating or loading panels", async () => {
    // getTreeSnapshot returns the already-seeded roots. The hosted shell loads
    // the visible panel later through panel.ensureLoaded; no client create.
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const seeded = makePanel("panel:tree/seeded", [], { artifacts: { buildState: "ready" } });
    registry.addPanel(seeded, null, { addAsRoot: true });
    registry.updateSelectedPath(seeded.id);
    const { orchestrator, serverClient, panelView } = createOrchestrator(registry, vi.fn(), {
      workspaceConfig: {
        id: "test",
        panelRestorePolicy: "focused",
        initPanels: [{ source: "panels/chat" }],
      } as never,
    });
    await orchestrator.initializePanelTree();

    const createCalls = serverClient.call.mock.calls.filter(
      ([service, method]) => service === "panelTree" && method === "create"
    );
    expect(createCalls).toHaveLength(0);
    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
    expect(registry.getPanel(seeded.id)?.artifacts.buildState).toBe("pending");
  });

  it("does not regress a panel that became hosted while the tree initialized", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const seeded = makePanel("panel:tree/seeded", [], {
      artifacts: {
        buildState: "ready",
        htmlPath: "http://localhost/panels/seeded/",
      },
    });
    registry.addPanel(seeded, null, { addAsRoot: true });
    const { orchestrator, panelView } = createOrchestrator(registry);
    panelView.hasView.mockImplementation((panelId: string) => panelId === seeded.id);

    await orchestrator.initializePanelTree();

    expect(registry.getPanel(seeded.id)?.artifacts).toEqual({
      buildState: "ready",
      htmlPath: "http://localhost/panels/seeded/",
    });
  });
});

describe("PanelOrchestrator.applyServerPanelTreeSnapshot", () => {
  it("ignores server echo snapshots that match the optimistic local tree", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("panel:tree/root", [], {
      title: "Runtime title",
      artifacts: { buildState: "ready", htmlPath: "http://localhost/panels/panel:tree/root/" },
    });
    registry.addPanel(root, null, { addAsRoot: true });
    const { orchestrator, serverClient } = createOrchestrator(registry);
    const repopulate = vi.spyOn(registry, "repopulate");

    await orchestrator.applyServerPanelTreeSnapshot(
      forestSnapshot([
        makePanel("panel:tree/root", [], {
          title: "Runtime title",
          artifacts: { buildState: "building", buildProgress: "Restoring..." },
        }),
      ])
    );

    expect(repopulate).not.toHaveBeenCalled();
    expect(serverClient.call).not.toHaveBeenCalledWith("panelRuntime", "getSnapshot", []);
  });

  it("applies server snapshots when the semantic tree changes", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.addPanel(makePanel("panel:tree/root", [], { title: "Old title" }), null, {
      addAsRoot: true,
    });
    const { orchestrator } = createOrchestrator(registry);
    const repopulate = vi.spyOn(registry, "repopulate");

    await orchestrator.applyServerPanelTreeSnapshot(
      forestSnapshot([
        makePanel("panel:tree/root", [makePanel("panel:tree/child")], { title: "New title" }),
      ])
    );

    expect(repopulate).toHaveBeenCalledOnce();
    expect(registry.getPanel("panel:tree/root")?.title).toBe("New title");
    expect(registry.getPanel("panel:tree/child")).toBeDefined();
  });

  it("preserves host-local renderer artifacts across semantic tree changes", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.addPanel(
      makePanel("panel:tree/root", [], {
        title: "Runtime title",
        artifacts: {
          buildState: "ready",
          htmlPath: "http://localhost/panels/panel:tree/root/",
        },
      }),
      null,
      { addAsRoot: true }
    );
    const { orchestrator, panelView } = createOrchestrator(registry);
    panelView.hasView.mockImplementation((id: string) => id === "panel:tree/root");

    await orchestrator.applyServerPanelTreeSnapshot(
      forestSnapshot([
        makePanel("panel:tree/root", [makePanel("panel:tree/child")], {
          title: "Authoritative title",
          artifacts: {
            buildState: "pending",
            buildProgress: "Panel unloaded - will rebuild when focused",
          },
        }),
      ])
    );

    expect(registry.getPanel("panel:tree/root")?.title).toBe("Authoritative title");
    expect(registry.getPanel("panel:tree/root")?.artifacts).toEqual({
      buildState: "ready",
      htmlPath: "http://localhost/panels/panel:tree/root/",
    });
    expect(registry.getPanel("panel:tree/child")).toBeDefined();
    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
  });

  it("applies an owner-only server change and re-bands the local forest", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.addPanel(makePanel("panel:tree/root", [], { owner: "bob" }), null, {
      addAsRoot: true,
    });
    const { orchestrator } = createOrchestrator(registry);
    const repopulate = vi.spyOn(registry, "repopulate");

    await orchestrator.applyServerPanelTreeSnapshot({
      revision: 1,
      forest: [
        {
          owner: "alice",
          rootPanels: [makePanel("panel:tree/root", [], { owner: "alice" })],
        },
      ],
    });

    expect(repopulate).toHaveBeenCalledOnce();
    expect(registry.getPanel("panel:tree/root")?.owner).toBe("alice");
    expect(registry.getPanelTreeSnapshot().forest.map((group) => group.owner)).toEqual(["alice"]);
  });

  it("prunes the local view of a panel removed from the authoritative tree", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.repopulate([makePanel("panel:tree/root", [makePanel("panel:tree/child")])]);
    const { orchestrator, panelView } = createOrchestrator(registry);
    // The child currently has a live view hosted on this desktop.
    panelView.hasView.mockImplementation((id: string) => id === "panel:tree/child");

    await orchestrator.applyServerPanelTreeSnapshot(
      forestSnapshot([makePanel("panel:tree/root")]) // child closed by another client
    );

    expect(registry.getPanel("panel:tree/child")).toBeUndefined();
    expect(panelView.destroyView).toHaveBeenCalledWith("panel:tree/child");
  });

  it("reloads a hosted panel's view when the authoritative snapshot navigated it", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.repopulate([makePanel("panel:tree/root")]); // source panels/root, ctx-root
    const { orchestrator, panelView } = createOrchestrator(registry);
    // The desktop currently hosts a live view for this panel.
    panelView.hasView.mockImplementation((id: string) => id === "panel:tree/root");

    await orchestrator.applyServerPanelTreeSnapshot(
      forestSnapshot([
        makePanel("panel:tree/root", [], {
          // Server navigated the panel to a new source/context (it is the sole
          // writer); the desktop view-host must reload the view reactively.
          snapshot: { source: "panels/other", contextId: "ctx-other", options: {} },
        }),
      ])
    );

    expect(panelView.createViewForPanel).toHaveBeenCalled();
    const lastCall = panelView.createViewForPanel.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("panel:tree/root");
  });

  it("recovers a focused existing panel when a navigate snapshot arrives after its view was unloaded", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.repopulate([makePanel("panel:tree/root")]);
    registry.updateSelectedPath("panel:tree/root");
    const { orchestrator, panelView } = createOrchestrator(registry);
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForPanel.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });

    await orchestrator.applyServerPanelTreeSnapshot(
      forestSnapshot([
        makePanel("panel:tree/root", [], {
          snapshot: { source: "panels/other", contextId: "ctx-other", options: {} },
        }),
      ])
    );

    expect(panelView.createViewForPanel).toHaveBeenCalled();
    const lastCall = panelView.createViewForPanel.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("panel:tree/root");
    expect(lastCall?.[2]).toBe("ctx-other");
  });

  it("pushes state-args-only authoritative changes to hosted panels", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.repopulate([
      makePanel("root", [], {
        snapshot: {
          source: "panels/root",
          contextId: "ctx-root",
          options: {},
          stateArgs: { mode: "old" },
        },
      }),
    ]);
    const { orchestrator, panelView, sendPanelEvent } = createOrchestrator(registry);
    panelView.hasView.mockImplementation((id: string) => id === "root");

    await orchestrator.applyServerPanelTreeSnapshot(
      forestSnapshot([
        makePanel("root", [], {
          snapshot: {
            source: "panels/root",
            contextId: "ctx-root",
            options: {},
            stateArgs: { mode: "new" },
          },
        }),
      ])
    );

    expect(sendPanelEvent).toHaveBeenCalledWith("root", "runtime:stateArgsChanged", {
      mode: "new",
    });
    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
  });

  it("patches title-only server snapshots without repopulating the tree", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.addPanel(makePanel("panel:tree/root", [], { title: "Old title" }), null, {
      addAsRoot: true,
    });
    const { orchestrator, serverClient } = createOrchestrator(registry);
    const repopulate = vi.spyOn(registry, "repopulate");

    await orchestrator.applyServerPanelTreeSnapshot(
      forestSnapshot([makePanel("panel:tree/root", [], { title: "New title" })])
    );

    expect(repopulate).not.toHaveBeenCalled();
    expect(serverClient.call).not.toHaveBeenCalledWith("panelRuntime", "getSnapshot", []);
    expect(registry.getPanel("panel:tree/root")?.title).toBe("New title");
  });

  it("treats workspace external navigation state as non-semantic snapshot drift", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.addPanel(
      makePanel("panel:tree/root", [], {
        title: "Runtime title",
        navigation: {
          url: "https://example.com/",
          pageTitle: "Example Domain",
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
        },
        snapshot: {
          source: "panels/root",
          contextId: "ctx-panel:tree/root",
          options: {},
          resolvedUrl: "https://example.com/",
        },
      }),
      null,
      { addAsRoot: true }
    );
    const { orchestrator, serverClient } = createOrchestrator(registry);
    const repopulate = vi.spyOn(registry, "repopulate");

    await orchestrator.applyServerPanelTreeSnapshot(
      forestSnapshot([
        makePanel("panel:tree/root", [], {
          title: "Runtime title",
          snapshot: {
            source: "panels/root",
            contextId: "ctx-panel:tree/root",
            options: {},
          },
        }),
      ])
    );

    expect(repopulate).not.toHaveBeenCalled();
    expect(serverClient.call).not.toHaveBeenCalledWith("panelRuntime", "getSnapshot", []);
    expect(getCurrentSnapshot(registry.getPanel("panel:tree/root")!).source).toBe("panels/root");
    expect(getCurrentSnapshot(registry.getPanel("panel:tree/root")!).resolvedUrl).toBe(
      "https://example.com/"
    );
  });

  it("prevents non-explicit server title updates from overwriting explicit runtime titles", () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.addPanel(makePanel("panel:tree/root", [], { title: "Old title" }), null, {
      addAsRoot: true,
    });
    const { orchestrator } = createOrchestrator(registry);

    orchestrator.applyServerPanelTitleUpdate({
      panelId: "panel:tree/root",
      title: "Explicit title",
      explicit: true,
    });
    orchestrator.applyServerPanelTitleUpdate({
      panelId: "panel:tree/root",
      title: "Agentic Chat",
    });

    expect(registry.getPanel("panel:tree/root")?.title).toBe("Explicit title");
  });

  it("prevents title-only server snapshots from overwriting explicit runtime titles", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.addPanel(makePanel("panel:tree/root", [], { title: "Old title" }), null, {
      addAsRoot: true,
    });
    const { orchestrator, serverClient } = createOrchestrator(registry);
    const repopulate = vi.spyOn(registry, "repopulate");

    orchestrator.applyServerPanelTitleUpdate({
      panelId: "panel:tree/root",
      title: "Explicit title",
      explicit: true,
    });
    await orchestrator.applyServerPanelTreeSnapshot(
      forestSnapshot([makePanel("panel:tree/root", [], { title: "Agentic Chat" })])
    );

    expect(repopulate).not.toHaveBeenCalled();
    expect(serverClient.call).not.toHaveBeenCalledWith("panelRuntime", "getSnapshot", []);
    expect(registry.getPanel("panel:tree/root")?.title).toBe("Explicit title");
  });

  it("preserves explicit runtime titles when applying structural server snapshots", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.addPanel(makePanel("panel:tree/root", [], { title: "Old title" }), null, {
      addAsRoot: true,
    });
    const { orchestrator } = createOrchestrator(registry);
    const repopulate = vi.spyOn(registry, "repopulate");

    orchestrator.applyServerPanelTitleUpdate({
      panelId: "panel:tree/root",
      title: "Explicit title",
      explicit: true,
    });
    await orchestrator.applyServerPanelTreeSnapshot(
      forestSnapshot([
        makePanel("panel:tree/root", [makePanel("panel:tree/child")], { title: "Agentic Chat" }),
      ])
    );

    expect(repopulate).toHaveBeenCalledOnce();
    expect(registry.getPanel("panel:tree/root")?.title).toBe("Explicit title");
    expect(registry.getPanel("panel:tree/child")).toBeDefined();
  });

  it("prevents page-title fallback updates from overwriting explicit runtime titles", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.addPanel(makePanel("panel:tree/root", [], { title: "Old title" }), null, {
      addAsRoot: true,
    });
    const { orchestrator, shellCore } = createOrchestrator(registry);

    orchestrator.applyServerPanelTitleUpdate({
      panelId: "panel:tree/root",
      title: "Explicit title",
      explicit: true,
    });
    await orchestrator.updatePanelTitle("panel:tree/root", "Fallback page title");

    expect(shellCore.updateTitle).not.toHaveBeenCalled();
    expect(registry.getPanel("panel:tree/root")?.title).toBe("Explicit title");
  });
});

describe("PanelOrchestrator.getBootstrapConfig", () => {
  it("returns the leased runtime connection id string", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, shellCore, panelView } = createOrchestrator(registry);
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForPanel.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });

    await orchestrator.ensureLoaded(panel.id);
    const loadedUrl = panelView.createViewForPanel.mock.calls[0]?.[1] ?? "";

    const config = await orchestrator.getBootstrapConfig(panel.id);

    expect(shellCore.getPanelInit).toHaveBeenCalledWith(panel.id);
    expect(loadedUrl).not.toContain("connectionId=");
    expect(config).toMatchObject({
      entityId: panel.id,
      connectionId: expect.stringMatching(/^desktop-panel:tree\/panel-1-/),
      clientLabel: "Desktop",
    });
  });
});

describe("PanelOrchestrator.handleRuntimeLeaseChanged", () => {
  it("unloads local panel resources when the local runtime lease is released", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/panel-1", [], {
      artifacts: {
        htmlPath: "http://localhost:1234/panels/panel:tree/panel-1/",
        buildState: "ready",
      },
    });
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView, cdpHost, shellCore } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);
    shellCore.refreshSlotEntity.mockResolvedValue(asPanelEntityId("panel:nav-panel-1"));

    await orchestrator.handleRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: 2 },
      slotId: asPanelSlotId(panel.id),
      runtimeEntityId: asPanelEntityId("panel:nav-panel-1"),
      previous: {
        slotId: asPanelSlotId(panel.id),
        runtimeEntityId: asPanelEntityId("panel:nav-panel-1"),
        clientSessionId: orchestrator.getRuntimeClientSessionId(),
        hostConnectionId: orchestrator.getRuntimeClientSessionId(),
        connectionId: "desktop-conn",
        holderLabel: "Desktop",
        platform: "desktop",
        supportsCdp: true,
        loadOnLeaseAssignment: false,
        acquiredAt: 1,
      },
      next: null,
      reason: "retired",
    });

    expect(cdpHost.cleanupPanelAccess).toHaveBeenCalledWith(panel.id);
    expect(cdpHost.unregisterTarget).toHaveBeenCalledWith(panel.id);
    expect(panelView.destroyView).toHaveBeenCalledWith(panel.id);
    expect(registry.getPanel(panel.id)?.artifacts).toMatchObject({
      buildState: "pending",
      buildProgress: "Panel unloaded - will rebuild when focused",
    });
  });

  it("ignores an old lease release after the slot has navigated to a new entity", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView, shellCore } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);
    shellCore.refreshSlotEntity.mockResolvedValue(asPanelEntityId("panel:nav-panel-1-next"));

    const previous = {
      slotId: asPanelSlotId(panel.id),
      runtimeEntityId: asPanelEntityId("panel:nav-panel-1-old"),
      clientSessionId: orchestrator.getRuntimeClientSessionId(),
      hostConnectionId: orchestrator.getRuntimeClientSessionId(),
      connectionId: "old-desktop-conn",
      holderLabel: "Desktop",
      platform: "desktop" as const,
      supportsCdp: true,
      loadOnLeaseAssignment: false,
      acquiredAt: 1,
    };

    await orchestrator.handleRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: 2 },
      slotId: asPanelSlotId(panel.id),
      runtimeEntityId: previous.runtimeEntityId,
      previous: null,
      next: previous,
      reason: "acquired",
    });
    panelView.destroyView.mockClear();

    await orchestrator.handleRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: 3 },
      slotId: asPanelSlotId(panel.id),
      runtimeEntityId: previous.runtimeEntityId,
      previous,
      next: null,
      reason: "retired",
    });

    expect(shellCore.refreshSlotEntity).toHaveBeenCalledWith(asPanelSlotId(panel.id));
    expect(panelView.destroyView).not.toHaveBeenCalled();
  });

  it("loads panels assigned to a load-on-assignment host without reacquiring the lease", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView, serverClient } = createOrchestrator(registry, vi.fn(), {
      runtimeClient: {
        clientSessionId: "headless-session",
        label: "Headless",
        platform: "headless",
        supportsCdp: true,
        loadOnLeaseAssignment: true,
        restorePolicy: "none",
      },
    });

    await orchestrator.handleRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: 2 },
      slotId: asPanelSlotId(panel.id),
      runtimeEntityId: asPanelEntityId("panel:nav-panel-1"),
      previous: null,
      next: {
        slotId: asPanelSlotId(panel.id),
        runtimeEntityId: asPanelEntityId("panel:nav-panel-1"),
        clientSessionId: "headless-session",
        hostConnectionId: "headless-session",
        connectionId: "assigned-runtime-conn",
        holderLabel: "Headless",
        platform: "headless",
        loadOnLeaseAssignment: true,
        supportsCdp: true,
        acquiredAt: 1,
      },
      reason: "acquired",
    });

    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      panel.id,
      expect.not.stringContaining("connectionId="),
      "ctx-panel:tree/panel-1"
    );
    expect(serverClient.call).not.toHaveBeenCalledWith(
      "panelRuntime",
      "acquire",
      expect.any(Array)
    );
  });

  it("idle-sweeps panels assigned to a load-on-assignment host (unified sweep, no per-panel timers)", async () => {
    vi.useFakeTimers();
    try {
      const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
      const panel = makePanel("panel:tree/panel-1");
      registry.addPanel(panel, null, { addAsRoot: true });
      const { orchestrator, serverClient } = createOrchestrator(registry, vi.fn(), {
        runtimeClient: {
          clientSessionId: "headless-session",
          label: "Headless",
          platform: "headless",
          supportsCdp: true,
          loadOnLeaseAssignment: true,
          uiIdleUnloadMs: 1000,
          uiIdleSweepMs: 500,
          restorePolicy: "none",
        },
      });

      // Headless now uses the same sweep as desktop (armed on registration),
      // not a per-panel one-shot timer.
      await orchestrator.registerRuntimeClient();
      await orchestrator.handleRuntimeLeaseChanged({
        type: "panel:runtimeLeaseChanged",
        version: { epoch: "test", counter: 2 },
        slotId: asPanelSlotId(panel.id),
        runtimeEntityId: asPanelEntityId("panel:nav-panel-1"),
        previous: null,
        next: {
          slotId: asPanelSlotId(panel.id),
          runtimeEntityId: asPanelEntityId("panel:nav-panel-1"),
          clientSessionId: "headless-session",
          hostConnectionId: "headless-session",
          connectionId: "assigned-runtime-conn",
          holderLabel: "Headless",
          platform: "headless",
          loadOnLeaseAssignment: true,
          supportsCdp: true,
          acquiredAt: 1,
        },
        reason: "acquired",
      });

      // First sweep at 500ms sees age 500 (< 1000); the sweep at 1000ms unloads.
      await vi.advanceTimersByTimeAsync(1500);

      expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "release", [
        asPanelEntityId("panel:nav-panel-1"),
        "assigned-runtime-conn",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps load-on-assignment host resources by unloading the oldest assigned panel", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const first = makePanel("panel:tree/panel-1");
    const second = makePanel("panel:tree/panel-2");
    registry.addPanel(first, null, { addAsRoot: true });
    registry.addPanel(second, null, { addAsRoot: true });
    const { orchestrator, serverClient } = createOrchestrator(registry, vi.fn(), {
      runtimeClient: {
        clientSessionId: "headless-session",
        label: "Headless",
        platform: "headless",
        supportsCdp: true,
        loadOnLeaseAssignment: true,
        maxAssignedPanelViews: 1,
        restorePolicy: "none",
      },
    });

    await orchestrator.handleRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: 2 },
      slotId: asPanelSlotId(first.id),
      runtimeEntityId: asPanelEntityId("panel:nav-panel-1"),
      previous: null,
      next: {
        slotId: asPanelSlotId(first.id),
        runtimeEntityId: asPanelEntityId("panel:nav-panel-1"),
        clientSessionId: "headless-session",
        hostConnectionId: "headless-session",
        connectionId: "assigned-runtime-1",
        holderLabel: "Headless",
        platform: "headless",
        loadOnLeaseAssignment: true,
        supportsCdp: true,
        acquiredAt: 1,
      },
      reason: "acquired",
    });
    await orchestrator.handleRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: 3 },
      slotId: asPanelSlotId(second.id),
      runtimeEntityId: asPanelEntityId("panel:nav-panel-2"),
      previous: null,
      next: {
        slotId: asPanelSlotId(second.id),
        runtimeEntityId: asPanelEntityId("panel:nav-panel-2"),
        clientSessionId: "headless-session",
        hostConnectionId: "headless-session",
        connectionId: "assigned-runtime-2",
        holderLabel: "Headless",
        platform: "headless",
        loadOnLeaseAssignment: true,
        supportsCdp: true,
        acquiredAt: 2,
      },
      reason: "acquired",
    });

    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "release", [
      asPanelEntityId("panel:nav-panel-1"),
      "assigned-runtime-1",
    ]);
    expect(serverClient.call).not.toHaveBeenCalledWith("panelRuntime", "release", [
      asPanelEntityId("panel:nav-panel-2"),
      "assigned-runtime-2",
    ]);
  });

  it("routes panel snapshots through panelTree without loading local views", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView, serverClient } = createOrchestrator(registry);

    await expect(orchestrator.snapshot(panel.id)).resolves.toEqual(getCurrentSnapshot(panel));

    expect(serverClient.call).toHaveBeenCalledWith("panelTree", "snapshot", [panel.id]);
    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
  });
});
