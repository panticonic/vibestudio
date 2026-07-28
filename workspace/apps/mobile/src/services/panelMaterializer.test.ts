import type { Panel } from "@vibestudio/shared/types";
import {
  materializeLatestMobilePanel,
  materializeMobilePanel,
  needsMobilePanelMaterialization,
  PanelMaterializationRetryQueue,
} from "./panelMaterializer";

const hostConfig = {
  protocol: "https",
  host: "vibestudio.example.com",
  port: "3000",
  basePath: "/_workspace/dev",
};

function makePanel(source: string): Panel {
  return {
    id: "panel-1",
    title: "Panel 1",
    runtimeEntityId: "panel:nav-1",
    buildKey: "b".repeat(64),
    children: [],
    snapshot: {
      source,
      contextId: "ctx-panel-1",
      options: {},
    },
    artifacts: { buildState: "ready" },
  };
}

function makeDeps(overrides?: {
  panelInit?: unknown;
  acquireResult?: { acquired: boolean; lease?: { holderLabel: string } };
}) {
  return {
    getPanelInit: jest.fn(async () => overrides?.panelInit ?? { entityId: "panel:nav-1" }),
    acquireLease: jest.fn(async () => overrides?.acquireResult ?? { acquired: true }),
    takeOverLease: jest.fn(async () => overrides?.acquireResult ?? { acquired: true }),
  };
}

describe("needsMobilePanelMaterialization", () => {
  it("waits for a build identity before completing a reserved WebView", () => {
    const panel = makePanel("panels/editor");
    panel.buildKey = null;

    expect(
      needsMobilePanelMaterialization(panel, {
        url: "about:blank",
        runtimeEntityId: "panel:nav-1",
      })
    ).toBe(false);
  });

  it("materializes reserved WebViews regardless of visibility", () => {
    expect(
      needsMobilePanelMaterialization(makePanel("panels/editor"), {
        url: "about:blank",
        runtimeEntityId: "panel:nav-1",
      })
    ).toBe(true);
  });

  it("rematerializes a retained WebView when navigation publishes a new runtime entity", () => {
    const panel = makePanel("panels/chat");
    panel.runtimeEntityId = "panel:nav-2";

    expect(
      needsMobilePanelMaterialization(panel, {
        url: "http://127.0.0.1/panels/editor/",
        runtimeEntityId: "panel:nav-1",
      })
    ).toBe(true);
    expect(
      needsMobilePanelMaterialization(panel, {
        url: "http://127.0.0.1/panels/chat/",
        runtimeEntityId: "panel:nav-2",
      })
    ).toBe(false);
  });

  it("rematerializes browser WebViews without requiring a workspace build", () => {
    const panel = makePanel("browser:https://example.com/next");
    panel.buildKey = null;
    panel.runtimeEntityId = "panel:nav-browser-next";

    expect(
      needsMobilePanelMaterialization(panel, {
        url: "https://example.com/current",
        runtimeEntityId: "panel:nav-browser-current",
      })
    ).toBe(true);
    expect(
      needsMobilePanelMaterialization(panel, {
        url: "https://example.com/next",
        runtimeEntityId: "panel:nav-browser-next",
      })
    ).toBe(false);
  });
});

describe("materializeMobilePanel", () => {
  it("leases a reserved panel and returns an immediate blank WebView without requesting a grant", async () => {
    const deps = makeDeps();
    const panel = makePanel("panels/editor");
    panel.buildKey = null;
    panel.artifacts = { buildState: "pending" };

    await expect(
      materializeMobilePanel({
        panelId: "panel-1",
        panel,
        hostConfig,
        ...deps,
        leaseMode: "acquire",
      })
    ).resolves.toEqual({
      panelId: "panel-1",
      runtimeEntityId: "panel:nav-1",
      url: "about:blank",
      managed: true,
      panelInit: null,
    });
    expect(deps.getPanelInit).not.toHaveBeenCalled();
    expect(deps.acquireLease).toHaveBeenCalledWith("panel-1", "panel:nav-1", {
      connectionId: expect.stringMatching(/^mobile-panel-1-/),
    });
  });

  it("acquires a mobile runtime lease for browser panels before returning the browser URL", async () => {
    const deps = makeDeps();

    const result = await materializeMobilePanel({
      panelId: "panel-1",
      panel: makePanel("browser:https://example.com/docs"),
      hostConfig,
      ...deps,
      leaseMode: "acquire",
    });

    expect(result).toEqual({
      panelId: "panel-1",
      runtimeEntityId: "panel:nav-1",
      url: "https://example.com/docs",
      managed: false,
      panelInit: null,
    });
    expect(deps.getPanelInit).toHaveBeenCalledWith("panel-1");
    expect(deps.acquireLease).toHaveBeenCalledWith("panel-1", "panel:nav-1", {
      connectionId: expect.stringMatching(/^mobile-panel-1-/),
    });
    expect(deps.takeOverLease).not.toHaveBeenCalled();
  });

  it("uses takeover mode when materializing browser panels during mobile takeover", async () => {
    const deps = makeDeps();

    await materializeMobilePanel({
      panelId: "panel-1",
      panel: makePanel("browser:https://example.com"),
      hostConfig,
      ...deps,
      leaseMode: "takeOver",
    });

    expect(deps.takeOverLease).toHaveBeenCalledWith("panel-1", "panel:nav-1", {
      connectionId: expect.stringMatching(/^mobile-panel-1-/),
    });
    expect(deps.acquireLease).not.toHaveBeenCalled();
  });

  it("rejects browser panel materialization when another client holds the lease", async () => {
    const deps = makeDeps({
      acquireResult: { acquired: false, lease: { holderLabel: "Desktop" } },
    });

    await expect(
      materializeMobilePanel({
        panelId: "panel-1",
        panel: makePanel("browser:https://example.com"),
        hostConfig,
        ...deps,
        leaseMode: "acquire",
      })
    ).rejects.toThrow("Panel panel-1 is running on Desktop");
  });

  it("keeps managed panel materialization payloads lease-bound", async () => {
    const deps = makeDeps({ panelInit: { entityId: "panel:nav-1", slotId: "panel-1" } });

    const result = await materializeMobilePanel({
      panelId: "panel-1",
      panel: makePanel("panels/editor"),
      hostConfig,
      ...deps,
      leaseMode: "acquire",
    });

    expect(result).toMatchObject({
      panelId: "panel-1",
      // Mobile serves panels through the local asset façade (127.0.0.1:<port>) over
      // the WebRTC pipe, not the remote host directly.
      url: `http://127.0.0.1:3000/_workspace/dev/panels/editor/?contextId=ctx-panel-1&buildKey=${"b".repeat(64)}`,
      managed: true,
      panelInit: {
        entityId: "panel:nav-1",
        slotId: "panel-1",
        clientLabel: "Mobile",
        connectionId: expect.stringMatching(/^mobile-panel-1-/),
      },
    });
  });

  it("rejects a panel init from a different runtime before acquiring its lease", async () => {
    const deps = makeDeps({ panelInit: { entityId: "panel:nav-2" } });

    await expect(
      materializeMobilePanel({
        panelId: "panel-1",
        panel: makePanel("panels/editor"),
        hostConfig,
        ...deps,
        leaseMode: "acquire",
      })
    ).rejects.toThrow("changed runtime identity");
    expect(deps.acquireLease).not.toHaveBeenCalled();
  });

  it("restarts from the latest panel when navigation lands during materialization", async () => {
    let currentPanel: Panel | null = makePanel("panels/editor");
    const nextPanel = makePanel("panels/chat");
    nextPanel.runtimeEntityId = "panel:nav-2";
    const deps = makeDeps();
    deps.getPanelInit
      .mockImplementationOnce(async () => {
        currentPanel = nextPanel;
        return { entityId: "panel:nav-2" };
      })
      .mockImplementationOnce(async () => ({ entityId: "panel:nav-2" }));

    const result = await materializeLatestMobilePanel({
      panelId: "panel-1",
      getPanel: () => currentPanel,
      hostConfig,
      ...deps,
      leaseMode: "acquire",
    });

    expect(result).toMatchObject({
      runtimeEntityId: "panel:nav-2",
      url: `http://127.0.0.1:3000/_workspace/dev/panels/chat/?contextId=ctx-panel-1&buildKey=${"b".repeat(64)}`,
      panelInit: { entityId: "panel:nav-2" },
    });
    expect(deps.acquireLease).toHaveBeenCalledTimes(1);
    expect(deps.acquireLease).toHaveBeenCalledWith("panel-1", "panel:nav-2", {
      connectionId: expect.stringMatching(/^mobile-panel-1-/),
    });
  });
});

describe("PanelMaterializationRetryQueue", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("retries failed convergence with bounded backoff and coalesces duplicates", () => {
    const onRetry = jest.fn();
    const retries = new PanelMaterializationRetryQueue(onRetry, 100, 1_000);

    retries.schedule("panel-1");
    retries.schedule("panel-1");
    jest.advanceTimersByTime(99);
    expect(onRetry).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onRetry).toHaveBeenCalledTimes(1);

    retries.schedule("panel-1");
    jest.advanceTimersByTime(199);
    expect(onRetry).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("cancels retries for WebViews that are no longer retained", () => {
    const onRetry = jest.fn();
    const retries = new PanelMaterializationRetryQueue(onRetry, 100, 1_000);

    retries.schedule("panel-1");
    retries.retainOnly(new Set());
    jest.runAllTimers();

    expect(onRetry).not.toHaveBeenCalled();
  });

  it("does not resurrect retries after shutdown", () => {
    const onRetry = jest.fn();
    const retries = new PanelMaterializationRetryQueue(onRetry, 100, 1_000);

    retries.schedule("panel-1");
    retries.stop();
    retries.schedule("panel-1");
    jest.runAllTimers();

    expect(onRetry).not.toHaveBeenCalled();
  });
});
