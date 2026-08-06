import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { PanelRuntimeCoordinator } from "../panelRuntimeCoordinator.js";
import { createPanelRuntimeService } from "./panelRuntimeService.js";

describe("panelRuntimeService", () => {
  const currentEntityForSlot = async () => null;
  const observeHostSlot = async () => null;

  it("accepts headless CDP-capable clients with stable host ids", async () => {
    const coordinator = {
      registerClient: vi.fn(),
      unregisterClient: vi.fn(),
      getSnapshot: vi.fn(),
      acquire: vi.fn(),
      takeOver: vi.fn(),
      release: vi.fn(),
      ownsClientSession: vi.fn(() => true),
    };
    const service = createPanelRuntimeService({
      coordinator: coordinator as never,
      currentEntityForSlot,
      observeHostSlot,
    });
    const input = {
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
      supportsCdp: true,
    };

    expect(() => service.methods["registerClient"]?.args.parse([input])).not.toThrow();
    await service.handler(
      { caller: createVerifiedCaller("shell:desktop", "shell") },
      "registerClient",
      [input]
    );

    expect(coordinator.registerClient).toHaveBeenCalledWith({
      ...input,
      ownerCallerId: "shell:desktop",
    });
  });

  it("accepts lease requests that carry a provider host id", () => {
    const service = createPanelRuntimeService({
      coordinator: {} as never,
      currentEntityForSlot,
      observeHostSlot,
    });

    expect(() =>
      service.methods["acquire"]?.args.parse([
        "panel:entity",
        {
          slotId: "slot",
          clientSessionId: "headless-session",
          connectionId: "runtime-connection",
          hostConnectionId: "headless-host",
        },
      ])
    ).not.toThrow();
  });

  it("forwards client unregister requests to the coordinator", async () => {
    const coordinator = {
      registerClient: vi.fn(),
      unregisterClient: vi.fn(),
      getSnapshot: vi.fn(),
      acquire: vi.fn(),
      takeOver: vi.fn(),
      release: vi.fn(),
      ownsClientSession: vi.fn(() => true),
    };
    const service = createPanelRuntimeService({
      coordinator: coordinator as never,
      currentEntityForSlot,
      observeHostSlot,
    });

    expect(() =>
      service.methods["unregisterClient"]?.args.parse(["headless-session"])
    ).not.toThrow();
    await service.handler(
      { caller: createVerifiedCaller("shell:desktop", "shell") },
      "unregisterClient",
      ["headless-session"]
    );

    expect(coordinator.unregisterClient).toHaveBeenCalledWith("headless-session");
    expect(coordinator.ownsClientSession).toHaveBeenCalledWith("headless-session", "shell:desktop");
  });

  it("rejects lease mutations for client sessions owned by another caller", async () => {
    const coordinator = new PanelRuntimeCoordinator();
    const service = createPanelRuntimeService({
      coordinator,
      currentEntityForSlot,
      observeHostSlot,
    });
    const desktopCtx = { caller: createVerifiedCaller("shell:desktop", "shell") };
    const headlessCtx = { caller: createVerifiedCaller("shell:headless", "shell") };

    await service.handler(desktopCtx, "registerClient", [
      {
        clientSessionId: "desktop-session",
        hostConnectionId: "desktop-host",
        label: "Desktop",
        platform: "desktop",
      },
    ]);
    await service.handler(desktopCtx, "acquire", [
      "panel:nav-a",
      {
        slotId: "panel:tree/slot-a",
        clientSessionId: "desktop-session",
        connectionId: "desktop-runtime",
      },
    ]);

    await expect(
      service.handler(headlessCtx, "release", ["panel:nav-a", "desktop-runtime"])
    ).rejects.toMatchObject({
      code: "PANEL_RUNTIME_CLIENT_FORBIDDEN",
    });
    await expect(
      service.handler(headlessCtx, "unregisterClient", ["desktop-session"])
    ).rejects.toMatchObject({
      code: "PANEL_RUNTIME_CLIENT_FORBIDDEN",
    });
    await expect(
      service.handler(headlessCtx, "acquire", [
        "panel:nav-b",
        {
          slotId: "panel:tree/slot-b",
          clientSessionId: "desktop-session",
          connectionId: "headless-runtime",
        },
      ])
    ).rejects.toMatchObject({
      code: "PANEL_RUNTIME_CLIENT_FORBIDDEN",
    });
    await expect(
      service.handler(headlessCtx, "takeOver", [
        "panel:nav-a",
        {
          slotId: "panel:tree/slot-a",
          clientSessionId: "desktop-session",
          connectionId: "headless-runtime",
        },
      ])
    ).rejects.toMatchObject({
      code: "PANEL_RUNTIME_CLIENT_FORBIDDEN",
    });
    await expect(
      service.handler(headlessCtx, "reportView", [
        "panel:nav-a",
        "desktop-runtime",
        {
          url: "http://127.0.0.1/panels/chat/",
          loading: false,
          boot: { phase: "ready" },
        },
      ])
    ).rejects.toMatchObject({
      code: "PANEL_RUNTIME_CLIENT_FORBIDDEN",
    });

    expect(coordinator.getLease("panel:nav-a")).toEqual(
      expect.objectContaining({
        clientSessionId: "desktop-session",
        connectionId: "desktop-runtime",
      })
    );
  });

  it("reads and caches the active desktop host observation on demand", async () => {
    const coordinator = new PanelRuntimeCoordinator();
    const hostObservation = {
      url: "http://127.0.0.1/panels/chat/",
      loading: false,
      boot: { phase: "ready" as const },
    };
    const observeHost = vi.fn(async () => hostObservation);
    const service = createPanelRuntimeService({
      coordinator,
      currentEntityForSlot,
      observeHostSlot: observeHost,
    });
    const desktopCtx = { caller: createVerifiedCaller("shell:desktop", "shell") };
    await service.handler(desktopCtx, "registerClient", [
      {
        clientSessionId: "desktop-session",
        hostConnectionId: "desktop-host",
        label: "Desktop",
        platform: "desktop",
      },
    ]);
    await service.handler(desktopCtx, "acquire", [
      "panel:nav-a",
      {
        slotId: "panel:tree/slot-a",
        clientSessionId: "desktop-session",
        connectionId: "desktop-runtime",
      },
    ]);

    await expect(
      service.handler(desktopCtx, "observeSlot", ["panel:tree/slot-a"])
    ).resolves.toEqual({
      lease: expect.objectContaining({ runtimeEntityId: "panel:nav-a" }),
      observation: {
        view: { url: hostObservation.url, loading: false },
        boot: expect.objectContaining({ phase: "ready" }),
      },
    });
    await service.handler(desktopCtx, "observeSlot", ["panel:tree/slot-a"]);
    expect(observeHost).toHaveBeenCalledTimes(1);
  });

  it("refreshes a cached loading observation until the host reports readiness", async () => {
    const coordinator = new PanelRuntimeCoordinator();
    const observeHost = vi.fn(async () => ({
      url: "http://127.0.0.1/panels/chat/",
      loading: false,
      boot: { phase: "ready" as const },
    }));
    const service = createPanelRuntimeService({
      coordinator,
      currentEntityForSlot,
      observeHostSlot: observeHost,
    });
    const desktopCtx = { caller: createVerifiedCaller("shell:desktop", "shell") };
    await service.handler(desktopCtx, "registerClient", [
      {
        clientSessionId: "desktop-session",
        hostConnectionId: "desktop-host",
        label: "Desktop",
        platform: "desktop",
      },
    ]);
    await service.handler(desktopCtx, "acquire", [
      "panel:nav-a",
      {
        slotId: "panel:tree/slot-a",
        clientSessionId: "desktop-session",
        connectionId: "desktop-runtime",
      },
    ]);
    coordinator.reportView("panel:nav-a", "desktop-runtime", {
      url: "http://127.0.0.1/panels/chat/",
      loading: false,
      boot: { phase: "booting" },
    });

    await expect(
      service.handler(desktopCtx, "observeSlot", ["panel:tree/slot-a"])
    ).resolves.toMatchObject({ observation: { boot: { phase: "ready" } } });
    await service.handler(desktopCtx, "observeSlot", ["panel:tree/slot-a"]);
    expect(observeHost).toHaveBeenCalledOnce();
  });

  it("refreshes an external document while its managed boot phase is unavailable", async () => {
    const coordinator = new PanelRuntimeCoordinator();
    const observeHost = vi
      .fn()
      .mockResolvedValueOnce({
        url: "https://example.com/",
        loading: true,
        boot: { phase: "unavailable" as const },
      })
      .mockResolvedValue({
        url: "https://example.com/",
        loading: false,
        boot: { phase: "unavailable" as const },
      });
    const service = createPanelRuntimeService({
      coordinator,
      currentEntityForSlot,
      observeHostSlot: observeHost,
    });
    const desktopCtx = { caller: createVerifiedCaller("shell:desktop", "shell") };
    await service.handler(desktopCtx, "registerClient", [
      {
        clientSessionId: "headless-session",
        hostConnectionId: "headless-host",
        label: "Headless",
        platform: "headless",
      },
    ]);
    await service.handler(desktopCtx, "acquire", [
      "panel:nav-browser",
      {
        slotId: "panel:tree/browser",
        clientSessionId: "headless-session",
        connectionId: "headless-runtime",
      },
    ]);
    coordinator.reportView("panel:nav-browser", "headless-runtime", {
      url: "about:blank",
      loading: false,
      boot: { phase: "unavailable" },
    });

    await expect(
      service.handler(desktopCtx, "observeSlot", ["panel:tree/browser"])
    ).resolves.toMatchObject({
      observation: {
        view: { url: "https://example.com/", loading: true },
        boot: { phase: "unavailable" },
      },
    });
    await expect(
      service.handler(desktopCtx, "observeSlot", ["panel:tree/browser"])
    ).resolves.toMatchObject({
      observation: { view: { url: "https://example.com/", loading: false } },
    });
    expect(observeHost).toHaveBeenCalledTimes(2);
  });

  it("does not require a panel RPC route for an external browser document", async () => {
    const coordinator = new PanelRuntimeCoordinator();
    const observeHost = vi.fn(async () => ({
      url: "data:text/html,<p>ready</p>",
      loading: false,
      boot: { phase: "unavailable" as const },
    }));
    const isRuntimeRouteReachable = vi.fn(() => false);
    const service = createPanelRuntimeService({
      coordinator,
      currentEntityForSlot,
      observeHostSlot: observeHost,
      isRuntimeRouteReachable,
    });
    const desktopCtx = { caller: createVerifiedCaller("shell:desktop", "shell") };
    await service.handler(desktopCtx, "registerClient", [
      {
        clientSessionId: "headless-session",
        hostConnectionId: "headless-host",
        label: "Headless",
        platform: "headless",
      },
    ]);
    await service.handler(desktopCtx, "acquire", [
      "panel:nav-browser",
      {
        slotId: "panel:tree/browser",
        clientSessionId: "headless-session",
        connectionId: "headless-runtime",
      },
    ]);

    await expect(
      service.handler(desktopCtx, "observeSlot", ["panel:tree/browser"])
    ).resolves.toMatchObject({
      observation: {
        view: { url: "data:text/html,<p>ready</p>", loading: false },
        boot: { phase: "unavailable" },
      },
    });
    expect(isRuntimeRouteReachable).not.toHaveBeenCalled();
  });

  it("does not refresh or expose a disconnected host during reconnect grace", async () => {
    const coordinator = new PanelRuntimeCoordinator();
    const observeHost = vi.fn(async () => ({
      url: "http://127.0.0.1/panels/chat/",
      loading: false,
      boot: { phase: "ready" as const },
    }));
    const service = createPanelRuntimeService({
      coordinator,
      currentEntityForSlot,
      observeHostSlot: observeHost,
    });
    const desktopCtx = { caller: createVerifiedCaller("shell:desktop", "shell") };
    await service.handler(desktopCtx, "registerClient", [
      {
        clientSessionId: "desktop-session",
        hostConnectionId: "desktop-host",
        label: "Desktop",
        platform: "desktop",
      },
    ]);
    await service.handler(desktopCtx, "acquire", [
      "panel:nav-a",
      {
        slotId: "panel:tree/slot-a",
        clientSessionId: "desktop-session",
        connectionId: "desktop-runtime",
      },
    ]);
    coordinator.reportView("panel:nav-a", "desktop-runtime", {
      url: "http://127.0.0.1/panels/chat/",
      loading: false,
      boot: { phase: "ready" },
    });
    coordinator.markDisconnected("panel:nav-a", "desktop-runtime");

    await expect(
      service.handler(desktopCtx, "observeSlot", ["panel:tree/slot-a"])
    ).resolves.toMatchObject({
      lease: { expiresAt: expect.any(Number) },
      observation: null,
    });
    expect(observeHost).not.toHaveBeenCalled();
  });

  it("does not expose cached boot readiness before the exact panel RPC route registers", async () => {
    const coordinator = new PanelRuntimeCoordinator();
    let routeReachable = false;
    const service = createPanelRuntimeService({
      coordinator,
      currentEntityForSlot,
      observeHostSlot,
      isRuntimeRouteReachable: (runtimeEntityId, connectionId) => {
        expect(runtimeEntityId).toBe("panel:nav-a");
        expect(connectionId).toBe("desktop-runtime");
        return routeReachable;
      },
    });
    const desktopCtx = { caller: createVerifiedCaller("shell:desktop", "shell") };
    await service.handler(desktopCtx, "registerClient", [
      {
        clientSessionId: "desktop-session",
        hostConnectionId: "desktop-host",
        label: "Desktop",
        platform: "desktop",
      },
    ]);
    await service.handler(desktopCtx, "acquire", [
      "panel:nav-a",
      {
        slotId: "panel:tree/slot-a",
        clientSessionId: "desktop-session",
        connectionId: "desktop-runtime",
      },
    ]);
    coordinator.reportView("panel:nav-a", "desktop-runtime", {
      url: "http://127.0.0.1/panels/chat/",
      loading: false,
      boot: { phase: "ready" },
    });

    await expect(
      service.handler(desktopCtx, "observeSlot", ["panel:tree/slot-a"])
    ).resolves.toMatchObject({
      lease: { runtimeEntityId: "panel:nav-a", connectionId: "desktop-runtime" },
      observation: null,
    });

    routeReachable = true;
    await expect(
      service.handler(desktopCtx, "observeSlot", ["panel:tree/slot-a"])
    ).resolves.toMatchObject({
      observation: { boot: { phase: "ready" } },
    });
  });

  it("autospawns the default headless host for programmatic panel assignment", async () => {
    const ensureDefaultHeadlessHost = vi.fn(async () => true);
    const ensureDefaultCdpHostForSlot = vi
      .fn()
      .mockReturnValueOnce({ assigned: false, reason: "no_default_cdp_host" as const })
      .mockReturnValueOnce({
        assigned: true,
        lease: {
          runtimeEntityId: "panel:nav-a",
          slotId: "panel:tree/slot-a",
          clientSessionId: "headless-session",
          connectionId: "default-cdp-panel:tree/slot-a",
          hostConnectionId: "headless-host",
          platform: "headless",
          supportsCdp: true,
        },
      });
    const coordinator = {
      ensureDefaultCdpHostForSlot,
    };
    const service = createPanelRuntimeService({
      coordinator: coordinator as never,
      currentEntityForSlot: async () => "panel:nav-a",
      observeHostSlot,
      ensureDefaultHeadlessHost,
    });

    await expect(
      service.handler({ caller: createVerifiedCaller("do:test", "do") }, "ensureSlot", [
        "panel:tree/slot-a",
        "panel:nav-a",
      ])
    ).resolves.toMatchObject({ status: "assigned" });
    expect(ensureDefaultHeadlessHost).toHaveBeenCalledOnce();
    expect(ensureDefaultCdpHostForSlot).toHaveBeenCalledTimes(2);
  });

  it("lets userland callers read lease snapshots but not mutate leases", async () => {
    const coordinator = {
      registerClient: vi.fn(),
      unregisterClient: vi.fn(),
      getSnapshot: vi.fn(() => ({ version: { epoch: "test", counter: 0 }, leases: [] })),
      acquire: vi.fn(),
      takeOver: vi.fn(),
      release: vi.fn(),
      ownsClientSession: vi.fn(() => true),
      getLease: vi.fn(() => null),
    };
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(
      createPanelRuntimeService({
        coordinator: coordinator as never,
        currentEntityForSlot,
        observeHostSlot,
      })
    );
    dispatcher.markInitialized();

    for (const kind of ["panel", "worker", "do"] as const) {
      await expect(
        dispatcher.dispatch(
          { caller: createVerifiedCaller(`${kind}:test`, kind) },
          "panelRuntime",
          "getSnapshot",
          []
        )
      ).resolves.toMatchObject({ leases: [] });
    }

    await expect(
      dispatcher.dispatch(
        { caller: createVerifiedCaller("panel:test", "panel") },
        "panelRuntime",
        "acquire",
        [
          "panel:nav-a",
          {
            slotId: "panel:tree/slot-a",
            clientSessionId: "desktop-session",
            connectionId: "panel-runtime",
          },
        ]
      )
    ).rejects.toThrow(/no authority branch admits the code origin/);
  });
});
