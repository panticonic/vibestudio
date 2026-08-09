import { describe, expect, it, vi } from "vitest";
import { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { Panel } from "@vibestudio/shared/types";
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
    children,
    snapshot,
    artifacts: {},
    ...overrides,
  };
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
  let createCounter = 0;
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
    createExecution: vi.fn(
      async (
        execution: { surface: "code"; source: string } | { surface: "external"; url: string },
        options?: { parentId?: string | null }
      ) => {
        const id = `panel:tree/created-${++createCounter}`;
        const contextId = `ctx-${id}`;
        const source =
          execution.surface === "external" ? `browser:${execution.url}` : execution.source;
        registry.addPanel(
          makePanel(id, [], {
            snapshot: { source, contextId, options: {} },
            ...(execution.surface === "external"
              ? { artifacts: { buildState: "ready" as const } }
              : {
                  runtimeEntityId: asPanelEntityId(`panel:nav-${id}`),
                  buildKey: null,
                  executionDigest: null,
                  artifacts: {
                    buildState: "pending" as const,
                    buildProgress: "Preparing panel runtime...",
                  },
                }),
          }),
          options?.parentId ?? null,
          { addAsRoot: options?.parentId == null }
        );
        return {
          panelId: id,
          title: id,
          contextId,
          source,
          options: {},
        };
      }
    ),
    navigate: vi.fn(async (panelId: string, source: string) => {
      const panel = registry.getPanel(panelId);
      if (!panel) return null;
      return {
        panelId,
        title: panel.title,
        contextId: getCurrentSnapshot(panel).contextId,
        source,
        options: {},
      };
    }),
    navigateHistory: vi.fn(async (panelId: string) => {
      const panel = registry.getPanel(panelId);
      return panel ? { id: panel.id, title: panel.title } : null;
    }),
    updateTitle: vi.fn(async (_panelId: string, _title: string) => {}),
    onStateArgsChanged: vi.fn(() => () => {}),
    notifyFocused: vi.fn(async () => {}),
    getPanelInit: vi.fn(async (panelId: string) => ({
      entityId: panelId,
      gatewayConfig: { serverUrl: "http://127.0.0.1:1234", token: "token" },
    })),
    getCurrentEntityId: vi.fn(async (panelId: string) => `panel:nav-${panelId}`),
    refreshSlotEntity: vi.fn(async (panelId: string) => `panel:nav-${panelId}`),
    getPanel: vi.fn(async (panelId: string) => registry.getPanel(panelId) ?? null),
    refreshPanel: vi.fn(async (panelId: string) => registry.getPanel(panelId) ?? null),
    replaceCurrentSnapshot: vi.fn(async () => undefined),
    syncEntityCachesFromRegistry: vi.fn(() => {}),
    loadViewState: vi.fn(async () => ({ collapsedIds: [] })),
    hasRootPanelSource: vi.fn(async (source: string) =>
      registry.getRootPanels().some((panel) => getCurrentSnapshot(panel).source === source)
    ),
  };
  let orchestratorRef: PanelOrchestrator | null = null;
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
    if (method === "reportView") return "reported";
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
    // reactive (panel-tree invalidation → local teardown, covered
    // by the prune test).
    expect(serverClient.call).toHaveBeenCalledWith("workspace-state", "slot.close", [root.id]);
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

  it("hydrates a query-first panel before creating its native view", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/query-first");
    const { orchestrator, panelView, shellCore } = createOrchestrator(registry);
    shellCore.getPanel.mockImplementationOnce(async () => {
      registry.addPanel(panel, null, { addAsRoot: true });
      return panel;
    });
    let loaded = false;
    panelView.createViewForPanel.mockImplementationOnce(async () => {
      loaded = true;
    });
    panelView.hasView.mockImplementation((panelId: string) => panelId === panel.id && loaded);

    await expect(orchestrator.ensureLoaded(panel.id)).resolves.toMatchObject({
      panelId: panel.id,
      status: "loaded",
      loaded: true,
    });

    expect(shellCore.getPanel).toHaveBeenCalledWith(panel.id);
    expect(panelView.createViewForPanel).toHaveBeenCalled();
  });

  it("does not create a renderer for a preparing, non-executable principal", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/preparing", [], {
      buildKey: null,
      executionDigest: null,
      artifacts: { buildState: "pending", buildProgress: "Preparing panel runtime..." },
    });
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView } = createOrchestrator(registry);
    await expect(orchestrator.ensureLoaded(panel.id)).resolves.toMatchObject({
      status: "preparing",
      loaded: false,
    });

    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
    expect(registry.getPanel(panel.id)?.artifacts).toMatchObject({
      buildState: "pending",
      buildProgress: "Preparing panel runtime...",
    });
    expect(registry.getPanel(panel.id)?.artifacts.htmlPath).toBeUndefined();
  });

  it("repairs a missing runtime lease for an existing native view and registers CDP", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/panel-1", [], {
      runtimeEntityId: "panel:nav-panel:tree/panel-1",
      artifacts: {
        buildState: "ready",
        htmlPath:
          "http://127.0.0.1:1234/panels/panel%3Atree/panel-1/?contextId=ctx-panel%3Atree%2Fpanel-1&buildKey=" +
          "b".repeat(64),
        hostedRuntimeEntityId: "panel:nav-panel:tree/panel-1",
      },
    });
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView, cdpHost, serverClient } = createOrchestrator(registry);
    panelView.hasView.mockImplementation((panelId: string) => panelId === panel.id);
    panelView.getWebContents.mockReturnValue({
      id: 42,
      isDestroyed: () => false,
      getURL: () => panel.artifacts.htmlPath,
      isLoading: () => false,
    } as never);

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
    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "reportView", [
      "panel:nav-panel:tree/panel-1",
      expect.any(String),
      expect.objectContaining({
        url: panel.artifacts.htmlPath,
        loading: false,
        boot: { kind: "unavailable" },
      }),
    ]);
    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
    expect(cdpHost.registerTarget).toHaveBeenCalledWith(panel.id, 42);
  });

  it("creates the sole renderer when a preparing entity becomes executable", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/prepared-after-lease", [], {
      runtimeEntityId: "panel:nav-panel:tree/prepared-after-lease",
      buildKey: null,
      executionDigest: null,
      artifacts: {
        buildState: "building",
        buildProgress: "Preparing panel runtime...",
        hostedRuntimeEntityId: "panel:nav-panel:tree/prepared-after-lease",
      },
    });
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView, shellCore } = createOrchestrator(registry);
    await expect(orchestrator.ensureLoaded(panel.id)).resolves.toMatchObject({
      status: "preparing",
      loaded: false,
    });
    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
    shellCore.refreshPanel.mockClear();

    await orchestrator.applyPanelExecutionActivated({
      panelId: panel.id,
      runtimeEntityId: panel.runtimeEntityId!,
      effectiveVersion: "effective-ready",
      buildKey: "b".repeat(64),
      executionDigest: "e".repeat(64),
      authorityRequests: [],
    });

    expect(shellCore.refreshPanel).not.toHaveBeenCalled();
    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      panel.id,
      expect.stringContaining(`buildKey=${"b".repeat(64)}`),
      panel.snapshot.contextId
    );
    expect(registry.getPanel(panel.id)?.artifacts).toMatchObject({
      buildState: "ready",
      htmlPath: expect.stringContaining(`buildKey=${"b".repeat(64)}`),
    });
  });

  it("rejoins durable state when activation beats the local slot projection", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/activation-before-create-response", [], {
      runtimeEntityId: "panel:nav-activation-before-create-response",
      effectiveVersion: "effective-ready",
      buildKey: "b".repeat(64),
      executionDigest: "e".repeat(64),
      authorityRequests: [],
      artifacts: { buildState: "building", buildProgress: "Loading panel runtime..." },
    });
    const { orchestrator, panelView, shellCore } = createOrchestrator(registry);
    shellCore.refreshPanel.mockImplementationOnce(async () => {
      registry.addPanel(panel, null, { addAsRoot: true });
      return panel;
    });

    await orchestrator.applyPanelExecutionActivated({
      panelId: panel.id,
      runtimeEntityId: panel.runtimeEntityId!,
      effectiveVersion: panel.effectiveVersion!,
      buildKey: panel.buildKey!,
      executionDigest: panel.executionDigest!,
      authorityRequests: [],
    });
    await orchestrator.ensureLoaded(panel.id);

    expect(shellCore.refreshPanel).toHaveBeenCalledWith(asPanelSlotId(panel.id));
    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      panel.id,
      expect.stringContaining(`buildKey=${panel.buildKey}`),
      panel.snapshot.contextId
    );
    expect(registry.getPanel(panel.id)?.artifacts.buildState).toBe("ready");
  });

  it("hydrates a presented durable panel before persisting shell layout focus", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/presented-before-query");
    const { orchestrator, shellCore } = createOrchestrator(registry);
    shellCore.getPanel.mockImplementationOnce(async () => {
      registry.addPanel(panel, null, { addAsRoot: true });
      return panel;
    });

    await orchestrator.setFocusedPanelId(panel.id);

    expect(shellCore.getPanel).toHaveBeenCalledWith(panel.id);
    expect(registry.getFocusedPanelId()).toBe(panel.id);
  });

  it("refreshes an already-presented native view when execution authority activates", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/already-presented", [], {
      runtimeEntityId: "panel:nav-already-presented",
      artifacts: {
        buildState: "ready",
        htmlPath: "http://127.0.0.1:1234/panel/already-presented",
        hostedRuntimeEntityId: "panel:nav-already-presented",
      },
    });
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);

    await orchestrator.applyPanelExecutionActivated({
      panelId: panel.id,
      runtimeEntityId: panel.runtimeEntityId!,
      effectiveVersion: "effective-ready",
      buildKey: panel.buildKey!,
      executionDigest: panel.executionDigest!,
      authorityRequests: [
        {
          capability: "userland:extensions/shell/native.shell.execute#*",
          resource: {
            kind: "exact",
            key: "native.shell:extension:@workspace-extensions/shell",
          },
        },
      ],
    });

    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      panel.id,
      panel.artifacts.htmlPath,
      panel.snapshot.contextId
    );
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

  it("keeps ordinary focus separate from creation placement", async () => {
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

    expect(emit).toHaveBeenCalledWith("navigate-to-panel", { panelId: child.id });
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

  it("retries a browser panel whose previous native navigation failed", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/browser-retry", [], {
      snapshot: {
        source: "browser:https://example.com",
        contextId: "ctx-browser-retry",
        options: {},
      },
      artifacts: {
        buildState: "ready",
        viewFailure: {
          code: "navigation_failed",
          message: "ERR_FAILED (-2) loading 'https://example.com'",
        },
      },
    });
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView } = createOrchestrator(registry);
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForBrowser.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });

    await expect(orchestrator.reloadPanel(panel.id)).resolves.toMatchObject({
      panelId: panel.id,
      operation: "reload",
      status: "loaded",
      loaded: true,
      rebuilt: false,
      reloaded: true,
    });

    expect(panelView.createViewForBrowser).toHaveBeenCalledWith(
      panel.id,
      "https://example.com",
      "ctx-browser-retry",
      expect.any(String)
    );
    expect(registry.getPanel(panel.id)?.artifacts).toMatchObject({
      buildState: "ready",
      htmlPath: "https://example.com",
    });
    expect(registry.getPanel(panel.id)?.artifacts.viewFailure).toBeUndefined();
  });

  it("retries a workspace panel after host navigation fails without rebuilding it", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/workspace-retry", [], {
      artifacts: {
        buildState: "ready",
        viewFailure: {
          code: "navigation_failed",
          message: "ERR_FAILED (-2) loading the sealed panel URL",
        },
      },
    });
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView, panelHttpServer } = createOrchestrator(registry);
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForPanel.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });

    await expect(orchestrator.ensureLoaded(panel.id)).resolves.toMatchObject({
      panelId: panel.id,
      status: "loaded",
      loaded: true,
    });

    expect(panelView.createViewForPanel).toHaveBeenCalledOnce();
    expect(panelHttpServer.invalidateBuild).not.toHaveBeenCalled();
    expect(registry.getPanel(panel.id)?.artifacts).toMatchObject({
      buildState: "ready",
      htmlPath: expect.any(String),
    });
    expect(registry.getPanel(panel.id)?.artifacts.viewFailure).toBeUndefined();
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
    const { orchestrator, panelView, serverClient, shellCore } = createOrchestrator(registry);
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForPanel.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });

    await orchestrator.createPanel(caller.id, "panels/created-panel");

    expect(shellCore.createExecution).toHaveBeenCalledWith(
      { surface: "code", source: "panels/created-panel" },
      expect.objectContaining({ parentId: caller.id }),
      undefined
    );
    expect(serverClient.callAs).not.toHaveBeenCalled();
  });

  it("publishes and returns a code panel without starting host-owned activation", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });
    const { orchestrator, panelView, emit } = createOrchestrator(registry);

    const result = await orchestrator.createPanel(caller.id, "panels/created-panel", {
      focus: true,
    });

    expect(emit).toHaveBeenCalledWith("panel-created", {
      panelId: result.id,
      parentId: caller.id,
      focus: true,
    });
    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
  });

  it("projects a server-owned activation failure for only the current entity", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });
    const { orchestrator, panelView, emit } = createOrchestrator(registry);

    await orchestrator.createPanel(caller.id, "panels/created-panel", { focus: true });
    expect(emit).toHaveBeenCalledWith("panel-created", {
      panelId: "panel:tree/created-1",
      parentId: caller.id,
      focus: true,
    });
    const entityId = registry.getPanel("panel:tree/created-1")?.runtimeEntityId;
    if (!entityId) throw new Error("missing runtime entity fixture");
    orchestrator.applyPanelExecutionFailed({
      panelId: "panel:tree/created-1",
      runtimeEntityId: entityId,
      message: "activation denied",
    });
    expect(registry.getPanel("panel:tree/created-1")?.artifacts).toMatchObject({
      buildState: "error",
      error: "activation denied",
    });

    orchestrator.applyPanelExecutionFailed({
      panelId: "panel:tree/created-1",
      runtimeEntityId: "panel:entity/stale",
      message: "stale failure",
    });
    expect(registry.getPanel("panel:tree/created-1")?.artifacts.error).toBe("activation denied");
    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
  });

  it("focuses after creating the native view for focused panels", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });

    const { orchestrator, panelView, emit, shellCore } = createOrchestrator(registry);
    // Reactive host: the acquired-lease broadcast builds the view, so track
    // built views in a Set (createViewForPanel marks the slot present).
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForPanel.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });
    const scopedCaller = { callerId: "@workspace-apps/shell", callerKind: "app" as const };

    const { id } = await orchestrator.createPanel(
      caller.id,
      "panels/created-panel",
      {
        focus: true,
      },
      undefined,
      scopedCaller
    );

    expect(shellCore.createExecution).toHaveBeenCalledWith(
      { surface: "code", source: "panels/created-panel" },
      expect.objectContaining({ parentId: caller.id }),
      expect.objectContaining({
        workspaceState: expect.any(Object),
        runtime: expect.any(Object),
      })
    );
    expect(emit).toHaveBeenCalledWith("panel-created", {
      panelId: id,
      parentId: caller.id,
      focus: true,
    });
    await orchestrator.applyPanelExecutionActivated({
      panelId: id,
      runtimeEntityId: registry.getPanel(id)!.runtimeEntityId!,
      effectiveVersion: "effective-ready",
      buildKey: "b".repeat(64),
      executionDigest: "e".repeat(64),
      authorityRequests: [],
    });
    await vi.waitFor(() =>
      expect(panelView.createViewForPanel).toHaveBeenCalledWith(
        id,
        expect.stringContaining("/panels/created-panel/"),
        `ctx-${id}`
      )
    );
    expect(panelView.setViewVisible).toHaveBeenCalledWith(id, true);
    expect(emit).not.toHaveBeenCalledWith("navigate-to-panel", expect.anything());
    expect(panelView.createViewForPanel.mock.invocationCallOrder[0]).toBeLessThan(
      panelView.setViewVisible.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("keeps a created workspace panel visible with an error when reactive native view creation fails", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });

    const { orchestrator, panelView, serverClient, emit } = createOrchestrator(registry);
    panelView.createViewForPanel.mockRejectedValue(new Error("native view failed"));
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
    ).resolves.toMatchObject({ id: "panel:tree/created-1" });

    const created = registry.getPanel("panel:tree/created-1")!;
    await expect(
      orchestrator.applyPanelExecutionActivated({
        panelId: created.id,
        runtimeEntityId: created.runtimeEntityId!,
        effectiveVersion: "effective-ready",
        buildKey: "b".repeat(64),
        executionDigest: "e".repeat(64),
        authorityRequests: [],
      })
    ).rejects.toThrow("native view failed");

    await vi.waitFor(() =>
      expect(registry.getPanel("panel:tree/created-1")?.artifacts.viewFailure).toMatchObject({
        code: "navigation_failed",
        message: "native view failed",
      })
    );

    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "release", [
      "panel:nav-panel:tree/created-1",
      expect.stringMatching(/^desktop-panel:tree\/created-1-/),
    ]);
    expect(serverClient.callAs).not.toHaveBeenCalledWith(
      scopedCaller,
      "workspace-state",
      "slot.close",
      ["panel:tree/created-1"]
    );
    expect(registry.getPanel("panel:tree/created-1")?.artifacts).toMatchObject({
      viewFailure: {
        code: "navigation_failed",
        message: "native view failed",
      },
    });
    expect(registry.getPanel("panel:tree/created-1")?.artifacts.buildState).not.toBe("error");
    expect(emit).not.toHaveBeenCalledWith("navigate-to-panel", expect.anything());
  });

  it("acquires a runtime lease before creating browser panel views", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });

    const { orchestrator, panelView, serverClient, shellCore } = createOrchestrator(registry);
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

    expect(shellCore.createExecution).toHaveBeenCalledWith(
      { surface: "external", url: "https://example.com/" },
      expect.objectContaining({ parentId: caller.id }),
      expect.objectContaining({
        workspaceState: expect.any(Object),
        runtime: expect.any(Object),
      })
    );
    await vi.waitFor(() =>
      expect(
        serverClient.call.mock.calls.some(
          ([service, method]) => service === "panelRuntime" && method === "acquire"
        )
      ).toBe(true)
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
    await vi.waitFor(() =>
      expect(panelView.createViewForBrowser).toHaveBeenCalledWith(
        id,
        "https://example.com/",
        `ctx-${id}`,
        "persist:browser-test"
      )
    );
    const acquireOrder = serverClient.call.mock.invocationCallOrder[acquireCallIndex];
    const createViewOrder = panelView.createViewForBrowser.mock.invocationCallOrder[0];
    expect(acquireOrder).toBeDefined();
    expect(createViewOrder).toBeDefined();
    expect(acquireOrder!).toBeLessThan(createViewOrder!);
  });

  it("returns the browser slot before environment readiness and delays only view attachment", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });
    let resolvePartition!: (partition: string) => void;
    const partitionReady = new Promise<string>((resolve) => {
      resolvePartition = resolve;
    });
    const { orchestrator, panelView, serverClient, shellCore } = createOrchestrator(
      registry,
      vi.fn(),
      {
        waitForBrowserSessionPartition: () => partitionReady,
      }
    );
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForBrowser.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });

    const creating = orchestrator.createBrowserUrlPanel(caller.id, "https://example.com/", {
      focus: false,
    });
    await vi.waitFor(() => expect(shellCore.createExecution).toHaveBeenCalledOnce());
    expect(
      serverClient.call.mock.calls.some(
        ([service, method]) => service === "panelRuntime" && method === "acquire"
      )
    ).toBe(false);
    expect(panelView.createViewForBrowser).not.toHaveBeenCalled();

    await expect(creating).resolves.toMatchObject({ id: expect.any(String) });

    resolvePartition("persist:browser-environment:ready");
    await vi.waitFor(() =>
      expect(panelView.createViewForBrowser).toHaveBeenCalledWith(
        expect.any(String),
        "https://example.com/",
        expect.any(String),
        "persist:browser-environment:ready"
      )
    );
  });

  it("commits deferred browser children without acquiring a lease or creating a view", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });
    const { orchestrator, panelView, serverClient, shellCore } = createOrchestrator(registry);
    const loaded = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loaded.has(panelId));
    panelView.createViewForBrowser.mockImplementation(async (panelId: string) => {
      loaded.add(panelId);
    });

    const result = await orchestrator.createBrowserUrlPanel(caller.id, "https://example.com/", {
      focus: false,
      initialLoad: "deferred",
    });

    expect(registry.getPanel(result.id)).toBeDefined();
    expect(shellCore.createExecution).toHaveBeenCalledWith(
      { surface: "external", url: "https://example.com/" },
      expect.objectContaining({
        parentId: caller.id,
      }),
      undefined
    );
    expect(
      serverClient.call.mock.calls.some(
        ([service, method]) => service === "panelRuntime" && method === "acquire"
      )
    ).toBe(false);
    expect(panelView.createViewForBrowser).not.toHaveBeenCalled();

    await expect(orchestrator.ensureLoaded(result.id)).resolves.toMatchObject({
      status: "loaded",
      loaded: true,
    });
    expect(panelView.createViewForBrowser).toHaveBeenCalledOnce();
  });

  it("creates unscoped browser child panels as the trusted host (shell authority)", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });
    const { orchestrator, panelView, serverClient, shellCore } = createOrchestrator(registry);
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForBrowser.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });

    await orchestrator.createBrowserUrlPanel(caller.id, "https://example.com/");

    expect(shellCore.createExecution).toHaveBeenCalledWith(
      { surface: "external", url: "https://example.com/" },
      expect.objectContaining({ parentId: caller.id }),
      undefined
    );
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
    ).resolves.toMatchObject({ id: "panel:tree/created-1" });

    await vi.waitFor(() =>
      expect(registry.getPanel("panel:tree/created-1")?.artifacts.viewFailure).toMatchObject({
        code: "navigation_failed",
        message: "native view failed",
      })
    );

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
    expect(serverClient.callAs).not.toHaveBeenCalledWith(
      scopedCaller,
      "workspace-state",
      "slot.close",
      ["panel:tree/created-1"]
    );
    expect(registry.getPanel("panel:tree/created-1")?.artifacts).toMatchObject({
      buildState: "ready",
      viewFailure: {
        code: "navigation_failed",
        message: "native view failed",
      },
    });
  });
});

describe("PanelOrchestrator.navigatePanel", () => {
  it("routes replacement through the shell connection without reconstructing the tree", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/current", [], {
      runtimeEntityId: asPanelEntityId("panel:nav-current"),
    });
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView, shellCore } = createOrchestrator(registry);

    await orchestrator.navigatePanel(panel.id, "panels/chat", {
      stateArgs: { initialPrompt: "hello" },
    });

    expect(shellCore.navigate).toHaveBeenCalledWith(
      panel.id,
      "panels/chat",
      { stateArgs: { initialPrompt: "hello" } },
      undefined
    );
    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
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
  it("replaces and presents only the named panel incarnation", async () => {
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

    const { orchestrator, panelView, panelHttpServer, shellCore } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);
    shellCore.replaceCurrentSnapshot.mockImplementationOnce(async () => {
      parent.runtimeEntityId = "panel:nav-rebuilt-parent";
      parent.buildKey = "c".repeat(64);
      parent.executionDigest = "f".repeat(64);
      parent.authorityRequests = [];
    });
    shellCore.getCurrentEntityId.mockResolvedValueOnce("panel:nav-rebuilt-parent");

    const result = await orchestrator.rebuildPanel(parent.id);

    expect(shellCore.replaceCurrentSnapshot).toHaveBeenCalledWith(asPanelSlotId(parent.id), {
      contextId: "ctx-panel:tree/parent",
      source: "panels/parent",
      stateArgs: {},
    });
    expect(panelHttpServer.invalidateBuild).not.toHaveBeenCalledWith("panels/parent");
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
      hostedRuntimeEntityId: "panel:nav-rebuilt-parent",
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
});

describe("PanelOrchestrator.recoverShellSnapshot", () => {
  it("re-registers the surviving runtime client before repairing views after recovery", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("panel:tree/root");
    registry.addPanel(root, null, { addAsRoot: true });
    const { orchestrator, panelView, serverClient } = createOrchestrator(registry);
    panelView.hasView.mockImplementation((panelId: string) => panelId === root.id);
    await orchestrator.registerRuntimeClient();
    serverClient.call.mockClear();

    await orchestrator.recoverShellSnapshot({ loadFocusedView: false });

    const runtimeCalls = serverClient.call.mock.calls.filter(
      ([service]) => service === "panelRuntime"
    );
    const methods = runtimeCalls.map(([, method]) => method);
    expect(methods[0]).toBe("registerClient");
    expect(methods[1]).toBe("getSnapshot");
    expect(methods.indexOf("acquire")).toBeGreaterThan(methods.indexOf("registerClient"));
  });

  it("syncs tree and leases, resolves focus, and publishes one normalized snapshot", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("panel:tree/root");
    registry.addPanel(root, null, { addAsRoot: true });
    const emit = vi.fn();
    const { orchestrator, shellCore, serverClient } = createOrchestrator(registry, emit);

    const snapshot = await orchestrator.recoverShellSnapshot({ loadFocusedView: false });

    expect(shellCore.loadViewState).toHaveBeenCalled();
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
  it("seeds and eagerly materializes every configured initial root through the product runtime", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const { orchestrator, shellCore, panelView } = createOrchestrator(registry, vi.fn(), {
      workspaceConfig: {
        id: "test",
        panelRestorePolicy: "none",
        initPanels: [
          { source: "panels/chat", stateArgs: { initialPrompt: "first" } },
          { source: "panels/terminal", stateArgs: { initialPrompt: "second" } },
        ],
      } as never,
    });

    await orchestrator.initializePanelTree();

    expect(shellCore.createExecution).toHaveBeenNthCalledWith(
      1,
      { surface: "code", source: "panels/chat" },
      expect.objectContaining({
        isRoot: true,
        addAsRoot: true,
        stateArgs: { initialPrompt: "first" },
      }),
      undefined
    );
    expect(shellCore.createExecution).toHaveBeenNthCalledWith(
      2,
      { surface: "code", source: "panels/terminal" },
      expect.objectContaining({
        isRoot: true,
        addAsRoot: true,
        stateArgs: { initialPrompt: "second" },
      }),
      undefined
    );
    for (const panel of registry.getRootPanels()) {
      await orchestrator.applyPanelExecutionActivated({
        panelId: panel.id,
        runtimeEntityId: panel.runtimeEntityId!,
        effectiveVersion: "effective-ready",
        buildKey: "b".repeat(64),
        executionDigest: "e".repeat(64),
        authorityRequests: [],
      });
    }
    await vi.waitFor(() => {
      expect(new Set(panelView.createViewForPanel.mock.calls.map(([panelId]) => panelId))).toEqual(
        new Set(registry.getRootPanels().map((panel) => panel.id))
      );
    });
    expect(shellCore.hasRootPanelSource).toHaveBeenCalledTimes(2);
  });

  it("keeps a headless renderer passive without hydrating the tree", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const { orchestrator, serverClient } = createOrchestrator(registry);

    await orchestrator.initializePanelTree({ seedInitialPanels: false });

    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "getSnapshot", []);
  });

  it("does not duplicate an existing initial root", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const seeded = makePanel("panel:tree/seeded", [], {
      snapshot: {
        source: "panels/chat",
        contextId: "ctx-panel:tree/seeded",
        options: {},
      },
      artifacts: { buildState: "ready" },
    });
    registry.addPanel(seeded, null, { addAsRoot: true });
    registry.updateSelectedPath(seeded.id);
    const { orchestrator, shellCore, panelView } = createOrchestrator(registry, vi.fn(), {
      workspaceConfig: {
        id: "test",
        panelRestorePolicy: "focused",
        initPanels: [{ source: "panels/chat" }],
      } as never,
    });
    await orchestrator.initializePanelTree();

    expect(shellCore.create).not.toHaveBeenCalled();
    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
    expect(registry.getPanel(seeded.id)?.artifacts.buildState).toBe("ready");
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

describe("PanelOrchestrator.refreshPanelProjection", () => {
  it("refreshes an existing local panel from durable state before returning presentation", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/stale", [], {
      runtimeEntityId: "panel:nav-old",
      buildKey: null,
      executionDigest: null,
      artifacts: { buildState: "pending", buildProgress: "Preparing panel runtime..." },
    });
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, shellCore } = createOrchestrator(registry);
    shellCore.refreshPanel.mockImplementationOnce(async () => {
      panel.runtimeEntityId = "panel:nav-current";
      panel.buildKey = "b".repeat(64);
      panel.executionDigest = "e".repeat(64);
      panel.authorityRequests = [];
      panel.artifacts = { buildState: "building", buildProgress: "Loading panel runtime..." };
      return panel;
    });

    await expect(orchestrator.refreshPanelProjection(panel.id)).resolves.toBe(panel);

    expect(shellCore.refreshPanel).toHaveBeenCalledWith(asPanelSlotId(panel.id));
    expect(registry.getPanel(panel.id)).toMatchObject({
      runtimeEntityId: "panel:nav-current",
      buildKey: "b".repeat(64),
    });
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

describe("PanelOrchestrator.getPanelHostObservation", () => {
  it("reports typed view failures as retryable navigation failures", () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/navigation-failure", [], {
      artifacts: {
        buildState: "ready",
        viewFailure: {
          code: "navigation_failed",
          message: "native view failed",
        },
      },
    });
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator } = createOrchestrator(registry);

    const observation = orchestrator.getPanelHostObservation(panel.id);
    expect(observation.viewRevision).toBe(0);
    expect(observation.failure).toEqual({
      code: "navigation_failed",
      stage: "load",
      message: "native view failed",
      details: {
        buildState: "ready",
        buildProgress: null,
      },
    });
  });

  it("never infers navigation failure from build-error wording", () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/build-failure", [], {
      artifacts: {
        buildState: "error",
        error: "Failed to load a build dependency",
      },
    });
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator } = createOrchestrator(registry);

    expect(orchestrator.getPanelHostObservation(panel.id).failure).toMatchObject({
      code: "compile_failed",
      stage: "build",
      message: "Failed to load a build dependency",
    });
  });

  it("keeps renderer boot failures in the renderer-owned boot record", () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/boot-failure");
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator } = createOrchestrator(registry);
    const boot = {
      kind: "observed" as const,
      observation: {
        phase: "failed" as const,
        failureStage: "bundle-load" as const,
        message: "bundle missing",
      },
    };

    expect(orchestrator.getPanelHostObservation(panel.id, boot)).toMatchObject({ boot });
    expect(orchestrator.getPanelHostObservation(panel.id, boot).failure).toBeUndefined();
  });
});

describe("PanelOrchestrator.handleRuntimeLeaseChanged", () => {
  it("replaces an existing slot view when its lease moves to a new runtime entity", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/new-news", [], {
      runtimeEntityId: "panel:nav-news",
      snapshot: {
        source: "panels/news",
        contextId: "ctx-news",
        options: {},
      },
      artifacts: {
        buildState: "ready",
        htmlPath: "http://127.0.0.1:1234/about/new/",
        hostedRuntimeEntityId: "panel:nav-about-new",
      },
    });
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);

    await orchestrator.handleRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: 2 },
      slotId: asPanelSlotId(panel.id),
      runtimeEntityId: asPanelEntityId("panel:nav-news"),
      previous: null,
      next: runtimeLease("panel:nav-news", {
        slotId: panel.id,
        clientSessionId: orchestrator.getRuntimeClientSessionId(),
        connectionId: "news-runtime-conn",
      }),
      reason: "acquired",
    });

    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      panel.id,
      expect.stringContaining("/panels/news/"),
      "ctx-news"
    );
    expect(registry.getPanel(panel.id)?.artifacts).toMatchObject({
      buildState: "ready",
      hostedRuntimeEntityId: "panel:nav-news",
      htmlPath: expect.stringContaining("/panels/news/"),
    });
  });

  it("coalesces repeated assignment delivery for the same runtime connection", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/new-news", [], {
      runtimeEntityId: "panel:nav-news",
      snapshot: { source: "panels/news", contextId: "ctx-news", options: {} },
      artifacts: { buildState: "ready" },
    });
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);
    const event = {
      type: "panel:runtimeLeaseChanged" as const,
      version: { epoch: "test", counter: 2 },
      slotId: asPanelSlotId(panel.id),
      runtimeEntityId: asPanelEntityId("panel:nav-news"),
      previous: null,
      next: runtimeLease("panel:nav-news", {
        slotId: panel.id,
        clientSessionId: orchestrator.getRuntimeClientSessionId(),
        connectionId: "news-runtime-conn",
      }),
      reason: "acquired" as const,
    };

    await Promise.all([
      orchestrator.handleRuntimeLeaseChanged(event),
      orchestrator.handleRuntimeLeaseChanged({
        ...event,
        version: { epoch: "test", counter: 3 },
        previous: event.next,
      }),
    ]);

    expect(panelView.createViewForPanel).toHaveBeenCalledTimes(1);
  });

  it("publishes a terminal view failure when same-slot replacement cannot load", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/new-news", [], {
      runtimeEntityId: "panel:nav-news",
      snapshot: { source: "panels/news", contextId: "ctx-news", options: {} },
      artifacts: {
        buildState: "ready",
        htmlPath: "http://127.0.0.1:1234/about/new/",
        hostedRuntimeEntityId: "panel:nav-about-new",
      },
    });
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView, serverClient } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);
    panelView.createViewForPanel.mockRejectedValueOnce(new Error("News renderer failed to load"));

    await orchestrator.handleRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: 2 },
      slotId: asPanelSlotId(panel.id),
      runtimeEntityId: asPanelEntityId("panel:nav-news"),
      previous: null,
      next: runtimeLease("panel:nav-news", {
        slotId: panel.id,
        clientSessionId: orchestrator.getRuntimeClientSessionId(),
        connectionId: "news-runtime-conn",
      }),
      reason: "acquired",
    });

    expect(panelView.destroyView).toHaveBeenCalledWith(panel.id);
    expect(registry.getPanel(panel.id)?.artifacts).toMatchObject({
      buildState: "ready",
      viewFailure: {
        code: "navigation_failed",
        message: "News renderer failed to load",
      },
    });
    expect(registry.getPanel(panel.id)?.artifacts.htmlPath).toBeUndefined();
    expect(registry.getPanel(panel.id)?.artifacts.hostedRuntimeEntityId).toBeUndefined();
    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "reportView", [
      "panel:nav-news",
      "news-runtime-conn",
      {
        url: "",
        loading: false,
        boot: { kind: "unavailable" },
        failure: {
          reporter: "host",
          failure: {
            stage: "navigation",
            code: "navigation_failed",
            message: "News renderer failed to load",
          },
        },
      },
    ]);
  });

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

  it("hydrates a server-created panel when its lease arrives before the local tree projection", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/server-created");
    const { orchestrator, panelView, shellCore } = createOrchestrator(registry, vi.fn(), {
      runtimeClient: {
        clientSessionId: "desktop-session",
        label: "Desktop",
        platform: "desktop",
        supportsCdp: true,
        loadOnLeaseAssignment: true,
        restorePolicy: "none",
      },
    });
    shellCore.refreshPanel.mockImplementation(async () => {
      registry.addPanel(panel, null, { addAsRoot: true });
      return panel;
    });

    await orchestrator.handleRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: 2 },
      slotId: asPanelSlotId(panel.id),
      runtimeEntityId: asPanelEntityId("panel:nav-server-created"),
      previous: null,
      next: runtimeLease(
        "panel:nav-server-created",
        {
          slotId: panel.id,
          clientSessionId: "desktop-session",
          connectionId: "assigned-runtime-conn",
          hostConnectionId: "desktop-session",
        },
        {
          loadOnLeaseAssignment: true,
        }
      ),
      reason: "acquired",
    });

    expect(shellCore.refreshPanel).toHaveBeenCalledWith(asPanelSlotId(panel.id));
    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      panel.id,
      expect.not.stringContaining("connectionId="),
      "ctx-panel:tree/server-created"
    );
  });

  it("creates a renderer when an assigned preparing runtime becomes ready", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/preparation-placeholder", [], {
      buildKey: null,
      executionDigest: null,
      artifacts: { buildState: "building", buildProgress: "Preparing panel runtime..." },
    });
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView, shellCore } = createOrchestrator(registry, vi.fn(), {
      runtimeClient: {
        clientSessionId: "desktop-session",
        label: "Desktop",
        platform: "desktop",
        supportsCdp: true,
        loadOnLeaseAssignment: false,
        restorePolicy: "none",
      },
    });
    panelView.hasView.mockReturnValue(false);
    shellCore.refreshPanel.mockImplementationOnce(async () => {
      panel.effectiveVersion = "effective-ready";
      panel.buildKey = "b".repeat(64);
      panel.executionDigest = "e".repeat(64);
      panel.authorityRequests = [];
      return panel;
    });

    await orchestrator.handleRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: 2 },
      slotId: asPanelSlotId(panel.id),
      runtimeEntityId: asPanelEntityId("panel:nav-preparation-placeholder"),
      previous: null,
      next: runtimeLease("panel:nav-preparation-placeholder", {
        slotId: panel.id,
        clientSessionId: "desktop-session",
        connectionId: "assigned-runtime-conn",
        hostConnectionId: "desktop-session",
      }),
      reason: "acquired",
    });

    expect(shellCore.refreshPanel).toHaveBeenCalledWith(asPanelSlotId(panel.id));
    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      panel.id,
      expect.stringContaining("buildKey="),
      panel.snapshot.contextId
    );
  });

  it("materializes load-on-assignment leases recovered from the initialization snapshot", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView, serverClient } = createOrchestrator(registry, vi.fn(), {
      runtimeClient: {
        clientSessionId: "desktop-session",
        label: "Desktop",
        platform: "desktop",
        supportsCdp: true,
        loadOnLeaseAssignment: true,
        restorePolicy: "none",
      },
    });
    const lease = runtimeLease(
      "panel:nav-panel-1",
      {
        slotId: panel.id,
        clientSessionId: "desktop-session",
        connectionId: "snapshot-runtime-conn",
        hostConnectionId: "desktop-session",
      },
      {
        loadOnLeaseAssignment: true,
      }
    );
    serverClient.call.mockResolvedValueOnce({
      version: { epoch: "test", counter: 2 },
      leases: [lease],
    } as never);

    await orchestrator.initializePanelTree();

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

  it("does not turn an intentionally unloaded in-flight view into a durable load error", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView } = createOrchestrator(registry, vi.fn(), {
      runtimeClient: {
        clientSessionId: "desktop-session",
        label: "Desktop",
        platform: "desktop",
        supportsCdp: true,
        loadOnLeaseAssignment: true,
        restorePolicy: "none",
      },
    });
    const loaded = new Set<string>();
    let rejectLoad!: (error: unknown) => void;
    panelView.hasView.mockImplementation((panelId: string) => loaded.has(panelId));
    panelView.createViewForPanel.mockImplementation(async (panelId: string) => {
      loaded.add(panelId);
      await new Promise<void>((_resolve, reject) => {
        rejectLoad = reject;
      });
    });
    panelView.destroyView.mockImplementation((panelId: string) => {
      loaded.delete(panelId);
    });
    const lease = runtimeLease("panel:nav-panel:tree/panel-1", {
      slotId: panel.id,
      clientSessionId: "desktop-session",
      connectionId: "assigned-runtime",
    });

    const loading = orchestrator.handleRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: 2 },
      slotId: asPanelSlotId(panel.id),
      runtimeEntityId: lease.runtimeEntityId,
      previous: null,
      next: lease,
      reason: "acquired",
    });
    await vi.waitFor(() => expect(loaded.has(panel.id)).toBe(true));

    await orchestrator.handleRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: 3 },
      slotId: asPanelSlotId(panel.id),
      runtimeEntityId: lease.runtimeEntityId,
      previous: lease,
      next: null,
      reason: "released",
    });
    rejectLoad(Object.assign(new Error("ERR_FAILED (-2)"), { code: -2 }));
    await expect(loading).resolves.toBeUndefined();

    expect(registry.getPanel(panel.id)?.artifacts).toMatchObject({
      buildState: "pending",
      buildProgress: "Panel unloaded - will rebuild when focused",
    });
    expect(registry.getPanel(panel.id)?.artifacts.error).toBeUndefined();
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

  it("evicts only the selected view when the resource-cap victim has loaded children", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const child = makePanel("panel:tree/parent/child");
    const parent = makePanel("panel:tree/parent");
    registry.addPanel(parent, null, { addAsRoot: true });
    registry.addPanel(child, parent.id);
    registry.updateSelectedPath(child.id);
    const { orchestrator, panelView } = createOrchestrator(registry, vi.fn(), {
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
    const loaded = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loaded.has(panelId));
    panelView.createViewForPanel.mockImplementation(async (panelId: string) => {
      loaded.add(panelId);
    });
    panelView.destroyView.mockImplementation((panelId: string) => {
      loaded.delete(panelId);
    });

    const assigned = (panelId: string, counter: number) =>
      orchestrator.handleRuntimeLeaseChanged({
        type: "panel:runtimeLeaseChanged" as const,
        version: { epoch: "test", counter },
        slotId: asPanelSlotId(panelId),
        runtimeEntityId: asPanelEntityId(`panel:nav-${panelId}`),
        previous: null,
        next: {
          slotId: asPanelSlotId(panelId),
          runtimeEntityId: asPanelEntityId(`panel:nav-${panelId}`),
          clientSessionId: "headless-session",
          hostConnectionId: "headless-session",
          connectionId: `assigned-${counter}`,
          holderLabel: "Headless",
          platform: "headless" as const,
          loadOnLeaseAssignment: true,
          supportsCdp: true,
          acquiredAt: counter,
        },
        reason: "acquired" as const,
      });

    await assigned(parent.id, 2);
    await assigned(child.id, 3);

    expect(panelView.destroyView).toHaveBeenCalledOnce();
    expect(panelView.destroyView).toHaveBeenCalledWith(parent.id);
    expect(loaded.has(parent.id)).toBe(false);
    expect(loaded.has(child.id)).toBe(true);
  });

  it("reads panel snapshots from the shell projection without loading local views", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView, serverClient } = createOrchestrator(registry);

    expect(orchestrator.snapshot(panel.id)).toEqual(getCurrentSnapshot(panel));

    expect(serverClient.call).not.toHaveBeenCalled();
    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
  });
});
