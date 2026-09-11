import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopWorkspaceRuntime,
  prepareDesktopWorkspaceRuntime,
} from "./workspaceRuntimeController.js";
import type { WorkspaceSessionConnection } from "./serverSession.js";
import type { ApplicationWindowController } from "./applicationWindowController.js";
import type { CdpHostProvider } from "./cdpHostProvider.js";
import { createHostCaller, createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { setWorkspaceAppTrust } from "@vibestudio/shared/chromeTrust";

const edges = vi.hoisted(() => ({
  controller: vi.fn(),
  partition: vi.fn(),
  permissionStop: vi.fn(),
  downloads: vi.fn(),
  cdp: vi.fn(),
  watch: vi.fn(),
  personal: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/runtime-test" },
  session: { fromPartition: (partition: string) => ({ partition }) },
}));
vi.mock("./desktopWorkspaceController.js", () => ({
  createDesktopWorkspaceController: edges.controller,
}));
vi.mock("./services/browserPermissionController.js", () => ({
  BrowserPermissionController: class {
    attachBrowserEnvironment = edges.partition;
    stop = edges.permissionStop;
    getEnvironmentKey = () => "environment";
  },
}));
vi.mock("./services/browserDownloadManager.js", () => ({
  BrowserDownloadManager: class {
    constructor(deps: unknown) {
      return edges.downloads(deps);
    }
  },
}));
vi.mock("./cdpHostProvider.js", () => ({
  CdpHostProvider: class {
    constructor(deps: unknown) {
      return edges.cdp(deps);
    }
  },
}));
vi.mock("./remoteCdpHostProviderSocket.js", () => ({
  RemoteCdpHostProviderSocket: class {},
  whenServerChannelAvailable: () => Promise.resolve(),
}));
vi.mock("../server/runtimeDiagnosticsStore.js", () => ({ RuntimeDiagnosticsStore: class {} }));
vi.mock("./panelPinStore.js", () => ({ PanelPinStore: class {} }));
vi.mock("./serverEventSubscriptionBridge.js", () => ({
  createServerEventSubscriptionBridge: edges.watch,
}));
// Service behavior has separate receiver tests. Keep the real container here:
// it must start and stop the same registered resources for every workspace.
vi.mock("./services/viewService.js", () => ({
  createViewService: () => ({ name: "view", methods: {}, handler: async () => undefined }),
}));
vi.mock("./services/menuService.js", () => ({
  createMenuService: () => ({ name: "menu", methods: {}, handler: async () => undefined }),
}));
vi.mock("./services/browserVaultNativeClient.js", () => ({
  createBrowserVaultNativeClient: () => ({}),
}));
vi.mock("./services/browserEnvironmentService.js", () => ({
  createBrowserEnvironmentService: () => ({
    name: "browserEnvironment",
    methods: {},
    handler: async () => undefined,
  }),
  localBrowserEnvironmentImportRouter: () => ({}),
}));
vi.mock("./personalBrowserServices.js", () => ({
  registerPersonalBrowserServices: edges.personal,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const closing: Array<ReturnType<typeof createDesktopWorkspaceRuntime>> = [];

describe("prepareDesktopWorkspaceRuntime", () => {
  it("keeps routing callers behind the local-service readiness boundary", async () => {
    let releaseStart!: () => void;
    const startPending = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const runtime = {
      start: vi.fn(() => startPending),
      close: vi.fn(async () => {}),
    };
    const runtimes = new Map<string, Promise<typeof runtime>>();

    const publication = prepareDesktopWorkspaceRuntime(runtimes, "system", runtime);
    expect(runtimes.get("system")).toBe(publication.ready);
    let observed = false;
    void runtimes.get("system")!.then(() => {
      observed = true;
    });
    await Promise.resolve();
    expect(observed).toBe(false);

    const starting = publication.start();
    releaseStart();
    await expect(starting).resolves.toBe(runtime);
    expect(observed).toBe(true);
  });

  it("removes a runtime whose local-service startup rejects", async () => {
    const failure = new Error("desktop services failed");
    const runtime = {
      start: vi.fn(async () => {
        throw failure;
      }),
      close: vi.fn(async () => {}),
    };
    const runtimes = new Map<string, Promise<typeof runtime>>();

    const publication = prepareDesktopWorkspaceRuntime(runtimes, "system", runtime);
    await expect(publication.start()).rejects.toBe(failure);
    expect(runtimes.has("system")).toBe(false);
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("closes a startup superseded by workspace removal", async () => {
    let releaseStart!: () => void;
    const runtime = {
      start: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseStart = resolve;
          })
      ),
      close: vi.fn(async () => {}),
    };
    const runtimes = new Map<string, Promise<typeof runtime>>();
    const publication = prepareDesktopWorkspaceRuntime(runtimes, "system", runtime);
    const ready = publication.start();
    await Promise.resolve();
    runtimes.delete("system");

    releaseStart();
    await expect(ready).rejects.toThrow("Workspace access was removed during startup");
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("terminalizes an aborted publication even when cleanup rejects", async () => {
    const cleanupFailure = new Error("cleanup failed");
    const runtime = {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {
        throw cleanupFailure;
      }),
    };
    const runtimes = new Map<string, Promise<typeof runtime>>();
    const publication = prepareDesktopWorkspaceRuntime(runtimes, "system", runtime);

    await expect(publication.abort(new Error("startup stopped"))).rejects.toThrow(
      "Workspace runtime startup and cleanup failed"
    );
    await expect(publication.ready).rejects.toThrow("startup stopped");
    await expect(publication.start()).rejects.toThrow("startup stopped");
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(runtimes.has("system")).toBe(false);
  });

  it("rejects readiness before an aborted runtime finishes closing", async () => {
    let releaseClose!: () => void;
    const runtime = {
      start: vi.fn(async () => {}),
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseClose = resolve;
          })
      ),
    };
    const runtimes = new Map<string, Promise<typeof runtime>>();
    const publication = prepareDesktopWorkspaceRuntime(runtimes, "system", runtime);
    const failure = new Error("startup stopped");
    const aborting = publication.abort(failure);
    let cleanupFinished = false;
    void aborting.then(() => {
      cleanupFinished = true;
    });

    await expect(publication.ready).rejects.toBe(failure);
    expect(cleanupFinished).toBe(false);
    await expect(publication.start()).rejects.toBe(failure);
    expect(runtime.start).not.toHaveBeenCalled();

    releaseClose();
    await aborting;
    expect(cleanupFinished).toBe(true);
  });
});

beforeEach(() => {
  vi.resetAllMocks();
  setWorkspaceAppTrust({ chromeApps: ["apps/shell"] });
  edges.partition.mockResolvedValue("persist:workspace-test");
  edges.personal.mockResolvedValue({ publishedServices: [] });
});
afterEach(async () => {
  await Promise.allSettled(closing.splice(0).map((runtime) => runtime.close()));
  vi.useRealTimers();
  setWorkspaceAppTrust(null);
});

function fixture(workspaceId: string, personal = false) {
  const orchestrator = {
    registerRuntimeClient: vi.fn(async (): Promise<void> => undefined),
    unregisterRuntimeClient: vi.fn(async () => undefined),
    getRuntimeClientSessionId: () => `${workspaceId}-lease-client`,
    initializePanelTree: vi.fn(async () => undefined),
    recoverShellSnapshot: vi.fn(async () => undefined),
  };
  const shutdown = vi.fn();
  const registry = {
    listPanels: () => [{ panelId: "same-local-panel" }],
    getPanel: () => ({ snapshot: { source: "about/new", contextId: "context", options: {} } }),
  };
  edges.controller.mockImplementationOnce(() => ({
    registry,
    orchestrator,
    core: { shutdown },
    workspaceId,
  }));
  const watch = {
    recover: vi.fn(async (): Promise<void> => undefined),
    close: vi.fn(async () => undefined),
    retainAll: vi.fn(async () => undefined),
    retainMany: vi.fn(() => () => {}),
  };
  edges.watch.mockReturnValueOnce(watch);
  const download = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
  edges.downloads.mockReturnValueOnce(download);
  const cdp = { start: vi.fn(), stop: vi.fn() };
  edges.cdp.mockReturnValueOnce(cdp);
  const release = vi.fn();
  const directEvents = new Map<string, (payload: unknown) => void>();
  const serverClient = {
    call: vi.fn(async () => undefined),
    getConnectionStatus: () => "connected",
    onDirectEvent: vi.fn((event: string, handler: (payload: unknown) => void) => {
      directEvents.set(event, handler);
      return release;
    }),
    onRecovery: vi.fn(() => release),
    onConnectionStatusChange: vi.fn((_listener: (status: string) => void) => release),
  };
  const send = vi.fn();
  const chromeSend = vi.fn();
  const ownPanel = { getWebContents: vi.fn(() => ({ isDestroyed: () => false, send })) };
  const window = {
    getWorkspacePanelView: vi.fn((id: string) => (id === workspaceId ? ownPanel : null)),
    attachWorkspaceServices: vi.fn(),
    detachWorkspace: vi.fn(),
    handleWebsiteNotificationAction: vi.fn(),
    viewManager: {
      getViewInfo: vi.fn((): unknown => null),
      getHostedShellWebContents: () => ({ isDestroyed: () => false, send: chromeSend }),
    },
  };
  const events = {
    onNotificationAction: vi.fn(async () => undefined),
    onAttentionRequired: vi.fn(),
  };
  if (personal)
    edges.personal.mockResolvedValueOnce({
      publishedServices: [],
    });
  const openShellSurface = vi.fn();
  const runtime = createDesktopWorkspaceRuntime({
    connection: {
      workspaceId,
      statePath: `/tmp/${workspaceId}`,
      connectionMode: "local",
      gatewayConfig: { serverUrl: "http://localhost/" },
      serverClient,
    } as unknown as WorkspaceSessionConnection,
    personal,
    app: { shellSurfaces: () => ["settings", "about"], onOpenShellSurface: openShellSurface },
    events,
    window: window as unknown as ApplicationWindowController,
    authorize: async () => {
      throw new Error("No service call expected in lifecycle test");
    },
    adBlockManager: {} as Parameters<typeof createDesktopWorkspaceRuntime>[0]["adBlockManager"],
    openExternal: vi.fn(async () => undefined),
  });
  closing.push(runtime);
  const managedStop = vi.fn(async () => undefined);
  runtime.container.registerManaged({
    name: "owned-resource",
    start: async () => ({}),
    stop: managedStop,
  });
  return {
    runtime,
    orchestrator,
    shutdown,
    watch,
    download,
    cdp,
    serverClient,
    window,
    send,
    chromeSend,
    managedStop,
    release,
    directEvents,
    events,
    openShellSurface,
  };
}

async function connectionSnapshot(owner: ReturnType<typeof fixture>) {
  owner.window.viewManager.getViewInfo.mockReturnValue({
    type: "app",
    hostChrome: true,
    capabilities: ["panel-hosting"],
    workspaceIdentity: { workspaceId: "system", runtimeId: "@workspace-apps/shell" },
    codeIdentity: { source: "apps/shell" },
  });
  const definition = owner.runtime.dispatcher
    .getServiceDefinitions()
    .find((service) => service.name === "desktopEvents")!;
  const response = (await definition.handler!(
    { caller: createHostCaller("native-system-shell", "shell") },
    "watch",
    [["server-connection-changed"], "connection-state"]
  )) as Response;
  const reader = response.body!.getReader();
  try {
    const ready = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(ready.value))).toMatchObject({ kind: "watching" });
    const snapshot = await reader.read();
    const record = JSON.parse(new TextDecoder().decode(snapshot.value));
    expect(record).toMatchObject({ kind: "snapshot", event: "server-connection-changed" });
    return record.payload as { status: string; isRemote: boolean };
  } finally {
    await reader.cancel();
  }
}

describe("workspace runtime ownership", () => {
  it("offers the same native navigation service in Personal, System and ordinary workspaces", async () => {
    const owners = [fixture("personal", true), fixture("system"), fixture("project")];
    for (const owner of owners) {
      await owner.runtime.start();
      const service = owner.runtime.dispatcher
        .getServiceDefinitions()
        .find((entry) => entry.name === "app")!;
      expect(service).toBeDefined();
      const context = { caller: createVerifiedCaller("panel:onboarding", "panel") };
      await service.handler!(context, "openShellSurface", [
        { kind: "settings", section: "devices" },
      ]);
      expect(owner.openShellSurface).toHaveBeenCalledExactlyOnceWith({
        kind: "settings",
        section: "devices",
      });
    }
  });

  it.each(["app", "panel", "shell"] as const)(
    "rejects an unadmitted %s watch before it can observe already-retained private host events",
    async (kind) => {
      const owner = fixture("shared");
      await owner.runtime.start();
      const definition = owner.runtime.dispatcher
        .getServiceDefinitions()
        .find((service) => service.name === "desktopEvents")!;
      const openWatch = vi.spyOn(owner.runtime.eventService, "openWatch");
      await expect(
        definition.handler!(
          {
            caller:
              kind === "shell"
                ? createHostCaller("shell", "shell")
                : createVerifiedCaller(`ordinary-${kind}`, kind, null),
          },
          "watch",
          [["shell-approval:pending-changed"], "unprivileged-watch"]
        )
      ).rejects.toThrow();
      expect(owner.watch.retainMany).not.toHaveBeenCalled();
      expect(openWatch).not.toHaveBeenCalled();
    }
  );

  it("retains native chrome's topics for precisely its response lifetime", async () => {
    const owner = fixture("shared");
    await owner.runtime.start();
    owner.window.viewManager.getViewInfo.mockReturnValue({
      type: "app",
      hostChrome: true,
      capabilities: ["panel-hosting"],
      workspaceIdentity: { workspaceId: "system", runtimeId: "@workspace-apps/shell" },
      codeIdentity: { source: "apps/shell" },
    });
    const definition = owner.runtime.dispatcher
      .getServiceDefinitions()
      .find((service) => service.name === "desktopEvents")!;
    const releaseTopics = vi.fn();
    owner.watch.retainMany.mockReturnValueOnce(releaseTopics);
    const response = (await definition.handler!(
      { caller: createHostCaller("native-system-shell", "shell") },
      "watch",
      [["shell-approval:pending-changed"], "chrome-watch"]
    )) as Response;
    try {
      expect(owner.watch.retainMany).toHaveBeenCalledWith(["shell-approval:pending-changed"]);
      expect(releaseTopics).not.toHaveBeenCalled();
    } finally {
      await response.body!.cancel();
    }
    expect(releaseTopics).toHaveBeenCalledOnce();
  });

  it.each(["personal", "system", "shared"])(
    "handles %s notification actions and native attention without duplicating UI events",
    async (workspaceId) => {
      const owner = fixture(workspaceId, workspaceId === "personal");
      await owner.runtime.start();
      const emit = vi.spyOn(owner.runtime.eventService, "emit");
      owner.directEvents.get("notification:action")!({
        id: "website-notification",
        actionId: "open",
      });
      expect(owner.window.handleWebsiteNotificationAction).toHaveBeenCalledWith(
        workspaceId,
        "website-notification",
        "open"
      );
      expect(owner.events.onNotificationAction).toHaveBeenCalledWith(
        "website-notification",
        "open"
      );
      owner.directEvents.get("notification:action")!({
        id: "oauth-notification",
        actionId: "oauth-cancel:own-transaction",
      });
      await vi.waitFor(() =>
        expect(owner.serverClient.call).toHaveBeenCalledWith("credentials", "cancelOAuth", [
          { transactionId: "own-transaction" },
        ])
      );
      owner.directEvents.get("notification:show")!({ id: "ordinary-toast", title: "Ordinary" });
      expect(owner.events.onAttentionRequired).not.toHaveBeenCalled();
      owner.directEvents.get("notification:show")!({
        id: "chat-attention:owned",
        title: "Attention",
        message: "Owned message",
      });
      expect(owner.events.onAttentionRequired).toHaveBeenCalledOnce();
      expect(owner.events.onAttentionRequired).toHaveBeenCalledWith("Attention", "Owned message");
      expect(emit).not.toHaveBeenCalled();
    }
  );

  it.each(["system", "personal", "shared"])(
    "owns the same ordinary lifecycle for %s",
    async (id) => {
      const owner = fixture(id, id === "personal");
      const start = owner.runtime.start();
      expect(owner.runtime.start()).toBe(start);
      await start;
      expect(owner.orchestrator.registerRuntimeClient).toHaveBeenCalledOnce();
      expect(owner.orchestrator.initializePanelTree).toHaveBeenCalledOnce();
      expect(edges.downloads).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: `desktop:${id}-lease-client` })
      );
      expect(owner.runtime.dispatcher.hasService("view")).toBe(true);
      expect(owner.runtime.dispatcher.hasService("desktopEvents")).toBe(true);
      await owner.runtime.recover("cold-recover");
      expect(owner.window.getWorkspacePanelView).toHaveBeenCalledWith(id);
      expect(owner.send).toHaveBeenCalledWith("vibestudio:rpc:recovery", "cold-recover", id);
      expect(owner.chromeSend).toHaveBeenCalledWith("vibestudio:rpc:recovery", "cold-recover", id);
      expect(owner.watch.recover).toHaveBeenCalledOnce();
      expect(owner.orchestrator.recoverShellSnapshot).toHaveBeenCalledWith({
        loadFocusedView: false,
      });
      expect(owner.watch.recover.mock.invocationCallOrder[0]).toBeLessThan(
        owner.orchestrator.recoverShellSnapshot.mock.invocationCallOrder[0]!
      );
      expect(owner.orchestrator.recoverShellSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
        owner.send.mock.invocationCallOrder[0]!
      );
      await owner.runtime.close();
      await owner.runtime.close();
      expect(owner.managedStop).toHaveBeenCalledOnce();
      expect(owner.download.stop).toHaveBeenCalledOnce();
      expect(owner.cdp.stop).toHaveBeenCalledOnce();
      expect(owner.shutdown).toHaveBeenCalledOnce();
      expect(owner.orchestrator.unregisterRuntimeClient).toHaveBeenCalledOnce();
      expect(owner.window.detachWorkspace).toHaveBeenCalledWith(id);
      expect(owner.release).toHaveBeenCalledTimes(
        owner.serverClient.onDirectEvent.mock.calls.length +
          owner.serverClient.onRecovery.mock.calls.length +
          owner.serverClient.onConnectionStatusChange.mock.calls.length
      );
    }
  );

  it("keeps recovery and diagnostic writes with the captured workspace despite equal local panel IDs", async () => {
    const system = fixture("system");
    await system.runtime.start();
    const personal = fixture("personal", true);
    await personal.runtime.start();
    await personal.runtime.recover("resubscribe");
    expect(system.send).not.toHaveBeenCalled();
    expect(personal.send).toHaveBeenCalledOnce();
    const cdpOptions = edges.cdp.mock.calls[1]![0] as ConstructorParameters<
      typeof CdpHostProvider
    >[0];
    cdpOptions.forwardDiagnostic!("same-local-panel", {
      timestamp: Date.now(),
      level: "warning",
      message: "owned warning",
      source: "console",
    } as Parameters<NonNullable<typeof cdpOptions.forwardDiagnostic>>[1]);
    await personal.runtime.close();
    expect(personal.serverClient.call).toHaveBeenCalledWith("panelLog", "append", [
      [
        expect.objectContaining({
          panelId: "same-local-panel",
          unitSource: "about/new",
          level: "warn",
        }),
      ],
    ]);
    expect(system.serverClient.call).not.toHaveBeenCalled();
  });

  it("retires a pending lease registration without attaching a closed workspace", async () => {
    const owner = fixture("shared");
    const lease = deferred<void>();
    owner.orchestrator.registerRuntimeClient.mockReturnValueOnce(lease.promise);
    const started = owner.runtime.start();
    const rejected = expect(started).rejects.toThrow("Workspace runtime is closed");
    await vi.waitFor(() => expect(owner.orchestrator.registerRuntimeClient).toHaveBeenCalledOnce());
    const closed = owner.runtime.close();
    lease.resolve();
    await rejected;
    await closed;
    expect(owner.window.attachWorkspaceServices).not.toHaveBeenCalled();
    expect(owner.orchestrator.unregisterRuntimeClient).toHaveBeenCalledOnce();
    expect(owner.shutdown).toHaveBeenCalledOnce();
  });

  it("cleans allocated resources after startup failure", async () => {
    const owner = fixture("system");
    owner.download.start.mockRejectedValueOnce(new Error("download startup failed"));
    await expect(owner.runtime.start()).rejects.toThrow("download startup failed");
    expect(owner.download.stop).toHaveBeenCalledOnce();
    expect(owner.watch.close).toHaveBeenCalledOnce();
    expect(owner.orchestrator.unregisterRuntimeClient).toHaveBeenCalledOnce();
    expect(owner.shutdown).toHaveBeenCalledOnce();
    expect(owner.window.attachWorkspaceServices).not.toHaveBeenCalled();
  });

  it("does not resume panel recovery after the workspace retires during replay", async () => {
    const owner = fixture("shared");
    await owner.runtime.start();
    const replay = deferred<void>();
    owner.watch.recover.mockReturnValueOnce(replay.promise);
    const recovery = owner.runtime.recover("cold-recover");
    await owner.runtime.close();
    replay.resolve();
    await recovery;
    expect(owner.orchestrator.recoverShellSnapshot).not.toHaveBeenCalled();
  });

  it("keeps each workspace disconnected until its subscription and panel recovery finish", async () => {
    const owner = fixture("personal", true);
    await owner.runtime.start();
    expect(await connectionSnapshot(owner)).toEqual({ status: "connected", isRemote: false });
    const emit = vi.spyOn(owner.runtime.eventService, "emit");
    const status = owner.serverClient.onConnectionStatusChange.mock.calls[0]![0];
    const replay = deferred<void>();
    const snapshot = deferred<undefined>();
    owner.watch.recover.mockReturnValueOnce(replay.promise);
    owner.orchestrator.recoverShellSnapshot.mockReturnValueOnce(snapshot.promise);
    status("disconnected");
    expect(emit).toHaveBeenLastCalledWith("server-connection-changed", {
      status: "disconnected",
      isRemote: false,
    });
    emit.mockClear();
    status("connected");
    expect(emit).not.toHaveBeenCalled();
    expect(await connectionSnapshot(owner)).toEqual({ status: "disconnected", isRemote: false });
    const recovery = owner.runtime.recover("resubscribe");
    expect(emit).not.toHaveBeenCalled();
    expect(await connectionSnapshot(owner)).toEqual({ status: "disconnected", isRemote: false });
    replay.resolve();
    await vi.waitFor(() => expect(owner.orchestrator.recoverShellSnapshot).toHaveBeenCalledOnce());
    expect(owner.send).not.toHaveBeenCalled();
    snapshot.resolve(undefined);
    await recovery;
    expect(owner.orchestrator.recoverShellSnapshot).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith("server-connection-changed", {
      status: "connected",
      isRemote: false,
    });
    expect(await connectionSnapshot(owner)).toEqual({ status: "connected", isRemote: false });
    await owner.runtime.close();
    emit.mockClear();
    status("disconnected");
    status("connected");
    await owner.runtime.recover("cold-recover");
    expect(emit).not.toHaveBeenCalled();
  });

  it("reports failed lease cleanup after stopping the remaining owned resources", async () => {
    const owner = fixture("personal", true);
    await owner.runtime.start();
    owner.orchestrator.unregisterRuntimeClient.mockRejectedValueOnce(
      new Error("lease release failed")
    );
    await expect(owner.runtime.close()).rejects.toThrow("Workspace runtime cleanup failed");
    await owner.runtime.close();
    expect(owner.orchestrator.unregisterRuntimeClient).toHaveBeenCalledTimes(2);
    expect(owner.managedStop).toHaveBeenCalledOnce();
    expect(owner.download.stop).toHaveBeenCalledOnce();
    expect(owner.cdp.stop).toHaveBeenCalledOnce();
    expect(owner.shutdown).toHaveBeenCalledOnce();
    expect(owner.window.detachWorkspace).toHaveBeenCalledWith("personal");
  });
});
