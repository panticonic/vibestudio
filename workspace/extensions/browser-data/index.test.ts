import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const orchestrationMocks = vi.hoisted(() => ({
  launchCollectionTask: vi.fn(async () => undefined),
}));

vi.mock("@workspace/collection-orchestration", async () => {
  const actual = await vi.importActual<typeof import("@workspace/collection-orchestration")>(
    "@workspace/collection-orchestration"
  );
  return {
    ...actual,
    launchCollectionTask: orchestrationMocks.launchCollectionTask,
  };
});

vi.mock("@vibestudio/browser-import", async () => {
  const actual = await vi.importActual<typeof import("@vibestudio/browser-import")>(
    "@vibestudio/browser-import"
  );
  return {
    ...actual,
    LocalBrowserImportProvider: class {
      async listSources() {
        return [
          {
            sourceId: "opaque-chrome",
            browser: "chrome",
            displayName: "Chrome",
            status: "readable",
            localDataSetCount: 2,
            supportedDataTypes: ["bookmarks", "history", "cookies"],
            warnings: [],
          },
        ];
      }
      async preview() {
        return { dataTypes: [], openTabCount: 2, localDataSetCount: 2, warnings: [] };
      }
      async import(
        sourceId: string,
        dataTypes: string[],
        sink: { store(batch: unknown): Promise<void>; progress(progress: unknown): Promise<void> }
      ) {
        const progress = [];
        if (dataTypes.includes("bookmarks")) {
          await sink.store({
            jobId: "",
            sourceId,
            dataType: "bookmarks",
            batchIndex: 0,
            idempotencyKey: "",
            items: [{ title: "Example", url: "https://example.com" }],
          });
          const bookmarks = {
            dataType: "bookmarks",
            itemsProcessed: 1,
            stored: 1,
            skipped: 0,
            errors: 0,
          };
          await sink.progress(bookmarks);
          progress.push(bookmarks);
        }
        if (dataTypes.includes("cookies")) {
          await sink.store({
            jobId: "",
            sourceId,
            dataType: "cookies",
            batchIndex: 0,
            idempotencyKey: "",
            items: [
              {
                name: "session",
                value: "opaque",
                domain: "example.com",
                hostOnly: true,
                path: "/",
                secure: true,
                httpOnly: true,
                sameSite: "lax",
              },
            ],
          });
          const cookies = {
            dataType: "cookies",
            itemsProcessed: 1,
            stored: 1,
            skipped: 0,
            errors: 0,
          };
          await sink.progress(cookies);
          progress.push(cookies);
        }
        return {
          dataTypes: progress,
          warnings: [],
        };
      }
      async listOpenTabs() {
        return [
          {
            tabId: "tab-1",
            url: "https://example.com/",
            title: "Example",
            active: true,
            windowId: "win-a",
            windowOrdinal: 1,
          },
          {
            tabId: "tab-2",
            url: "chrome://settings/",
            title: "Settings",
            active: false,
            windowId: "win-a",
            windowOrdinal: 1,
          },
          {
            tabId: "tab-3",
            url: "https://example.org/",
            title: "Other",
            active: false,
            windowId: "win-b",
            windowOrdinal: 2,
          },
        ];
      }
    },
  };
});

import { activate } from "./index.js";

type ApprovalChoice =
  | { kind: "choice"; choice: string }
  | { kind: "dismissed" }
  | { kind: "uncallable"; reason: string };

function makeContext(
  callerKind: string | null = "shell",
  callerId = "shell",
  approvalChoice: ApprovalChoice = { kind: "choice", choice: "allow" }
) {
  let createdPanels = 0;
  const rpcCall = vi.fn(
    async (_targetId: string, method: string, ..._args: unknown[]): Promise<unknown> => {
      if (method === "addBookmarksBatch") return 1;
      if (method === "addBookmark") return 42;
      if (method === "getBookmarks") return [{ id: 1, title: "Example" }];
      if (method === "getPasswords") return [{ id: 7, origin_url: "https://example.com" }];
      if (method === "panelTree.archive") return true;
      if (method === "panelTree.metadata") return { contextId: "ctx-caller" };
      if (method === "panelTree.create") {
        createdPanels += 1;
        return {
          id: `browser-panel-${createdPanels}`,
          title: `panel-${createdPanels}`,
          contextId: `ctx-panel-${createdPanels}`,
        };
      }
      return [];
    }
  );
  const emit = vi.fn();
  const rpcStream = vi.fn(async () => new Response());
  const health = { healthy: vi.fn(), degraded: vi.fn(), unhealthy: vi.fn() };
  const resolveDurableObject = vi.fn(async () => ({
    targetId: "do:vibestudio/internal:BrowserDataDO:environment-key",
    objectKey: "environment-key",
  }));
  const approvalsRequest = vi.fn(async () => approvalChoice);
  return {
    ctx: {
      rpc: { call: rpcCall, stream: rpcStream },
      workers: { resolveDurableObject },
      invocation: {
        current: () =>
          callerKind === null
            ? null
            : {
                caller: {
                  callerId,
                  callerKind,
                  userId: "user-1",
                  workspaceId: "workspace-1",
                },
              },
        signal: () => null,
      },
      approvals: { request: approvalsRequest },
      log: { info: vi.fn(), warn: vi.fn() },
      health,
      emit,
    },
    rpcCall,
    rpcStream,
    resolveDurableObject,
    approvalsRequest,
    emit,
    health,
  };
}

describe("@workspace-extensions/browser-data", () => {
  beforeEach(() => {
    orchestrationMocks.launchCollectionTask.mockReset();
    orchestrationMocks.launchCollectionTask.mockResolvedValue(undefined);
  });

  it("matches the manifest-declared provider and contains no retired import methods", async () => {
    const { ctx } = makeContext();
    const activated = await activate(ctx as never);
    const manifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8")
    ) as {
      vibestudio: { extension: { providerContracts: { browserData: { methods: string[] } } } };
    };
    const methods = Object.keys(activated.providerContracts.browserData);
    expect(methods).toEqual(manifest.vibestudio.extension.providerContracts.browserData.methods);
    expect(methods).not.toEqual(
      expect.arrayContaining(["detectBrowsers", "getProfileImportState", "getAutofillSuggestions"])
    );
  });

  it("requires a verified user and workspace", async () => {
    const { ctx } = makeContext(null);
    const api = (await activate(ctx as never)).providerContracts.browserData;
    await expect(api.getBookmarks()).rejects.toMatchObject({ code: "ENOCALLER" });
  });

  it("uses the server-derived environment key rather than a caller key", async () => {
    const { ctx, rpcCall, resolveDurableObject, health } = makeContext();
    const api = (await activate(ctx as never)).providerContracts.browserData;
    expect(health.healthy).not.toHaveBeenCalled();
    await api.getBookmarks();
    expect(resolveDurableObject).toHaveBeenCalledWith(
      "vibestudio/internal",
      "BrowserDataDO",
      "browser-environment"
    );
    expect(rpcCall).toHaveBeenCalledWith(
      "do:vibestudio/internal:BrowserDataDO:environment-key",
      "getBookmarks",
      "/"
    );
    expect(health.healthy).toHaveBeenCalledWith({
      summary: "Browser environment storage ready",
    });
  });

  it("degrades health on store resolution failure and retries the dependency", async () => {
    const { ctx, resolveDurableObject, health } = makeContext();
    resolveDurableObject.mockRejectedValueOnce(new Error("backing store refused"));
    const api = (await activate(ctx as never)).providerContracts.browserData;

    await expect(api.listImportJobs()).rejects.toThrow("backing store refused");
    expect(health.degraded).toHaveBeenCalledWith({
      summary: "Browser environment storage unavailable",
      reasons: ["backing store refused"],
    });

    await expect(api.listImportJobs()).resolves.toEqual([]);
    expect(resolveDurableObject).toHaveBeenCalledTimes(2);
    expect(health.healthy).toHaveBeenCalledWith({
      summary: "Browser environment storage ready",
    });
  });

  it("does not report healthy when the resolved store refuses a call", async () => {
    const { ctx, rpcCall, health } = makeContext();
    rpcCall.mockRejectedValueOnce(new Error("store authority refused"));
    const api = (await activate(ctx as never)).providerContracts.browserData;

    await expect(api.listImportJobs()).rejects.toThrow("store authority refused");
    expect(health.healthy).not.toHaveBeenCalled();
    expect(health.degraded).toHaveBeenCalledWith({
      summary: "Browser environment storage unavailable",
      reasons: ["store authority refused"],
    });
  });

  it("gates sensitive reads and rejects a denial", async () => {
    const { ctx, approvalsRequest } = makeContext("panel", "panel-1", {
      kind: "choice",
      choice: "deny",
    });
    const api = (await activate(ctx as never)).providerContracts.browserData;
    await expect(api.getPasswords()).rejects.toMatchObject({ code: "EACCES" });
    expect(approvalsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: { id: "browser-data:getPasswords", label: expect.any(String) },
      })
    );
  });

  it("discovers opaque sources without returning paths or profiles", async () => {
    const { ctx } = makeContext();
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();
    const sources = await api.listImportSources(host!.hostId);
    expect(sources).toEqual([
      expect.objectContaining({ sourceId: "opaque-chrome", localDataSetCount: 2 }),
    ]);
    expect(JSON.stringify(sources)).not.toMatch(/profile|[/\\\\]Users[/\\\\]|[/\\\\]home[/\\\\]/i);
  });

  it("stores imports as idempotent source-scoped batches", async () => {
    const { ctx, rpcCall, emit, health } = makeContext();
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();
    const result = await api.startImport({
      hostId: host!.hostId,
      sourceId: "opaque-chrome",
      dataTypes: ["bookmarks"],
    });
    expect(["queued", "discovering", "reading"]).toContain(result.phase);
    await vi.waitFor(async () => {
      expect(((await api.getImportJob(result.jobId)) as { phase?: string } | null)?.phase).toBe(
        "complete"
      );
    });
    expect(rpcCall).toHaveBeenCalledWith(
      "do:vibestudio/internal:BrowserDataDO:environment-key",
      "addBookmarksBatch",
      [{ title: "Example", url: "https://example.com" }],
      { sourceId: "opaque-chrome" }
    );
    expect(rpcCall).toHaveBeenCalledWith(
      "do:vibestudio/internal:BrowserDataDO:environment-key",
      "recordImportBatch",
      expect.objectContaining({ dataType: "bookmarks", batchIndex: 0 })
    );
    expect(emit).toHaveBeenCalledWith(
      "import-complete",
      expect.objectContaining({ phase: "complete" })
    );
    expect(health.healthy).toHaveBeenLastCalledWith({ summary: "Browser data import completed" });
  });

  it("keeps cookie imports reconciling until the active desktop jar is flushed", async () => {
    const { ctx, rpcCall, emit } = makeContext();
    rpcCall.mockImplementation(async (_targetId: string, method: string) => {
      if (method === "browserEnvironment.getImportHost") {
        return {
          hostId: "desktop-1",
          displayName: "This device",
          platform: "linux",
          location: "desktop",
          connected: true,
        };
      }
      if (method === "browserEnvironment.flushCookieProjection") return { revision: 1 };
      return [];
    });
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const hosts = await api.listImportHosts();
    const server = hosts.find((host) => host.hostId.startsWith("server:"));
    const result = await api.startImport({
      hostId: server!.hostId,
      sourceId: "opaque-chrome",
      dataTypes: ["cookies"],
    });

    await vi.waitFor(async () => {
      expect(((await api.getImportJob(result.jobId)) as { phase?: string } | null)?.phase).toBe(
        "complete"
      );
    });
    const flushCall = rpcCall.mock.calls.find(
      (call) => call[1] === "browserEnvironment.flushCookieProjection"
    );
    const completeEvent = emit.mock.calls.find((call) => call[0] === "import-complete");
    expect(flushCall).toBeDefined();
    expect(completeEvent?.[1]).toMatchObject({ phase: "complete" });
    expect(flushCall![0]).toBe("main");
    expect(rpcCall.mock.invocationCallOrder[rpcCall.mock.calls.indexOf(flushCall!)]).toBeLessThan(
      emit.mock.invocationCallOrder[emit.mock.calls.indexOf(completeEvent!)]!
    );
  });

  it("can keep selected HTTP tabs directly under the calling panel", async () => {
    const { ctx, rpcCall } = makeContext("panel", "panel-parent");
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();
    await expect(
      api.openTabsAsPanels({
        hostId: host!.hostId,
        sourceId: "opaque-chrome",
        selection: ["tab-1", "tab-2"],
        destination: "caller",
        groupBy: "none",
      })
    ).resolves.toMatchObject({ tabsFound: 2, panelsOpened: 1 });
    expect(rpcCall).toHaveBeenCalledWith(
      "main",
      "panelTree.create",
      { surface: "external", url: "https://example.com/" },
      {
        parentId: "panel-parent",
        title: "Example",
        focus: false,
        initialLoad: "deferred",
        contextId: "ctx-caller",
      }
    );
    expect(orchestrationMocks.launchCollectionTask).not.toHaveBeenCalled();
  });

  it("defaults to a new root with nested window collections and deferred tabs", async () => {
    const { ctx, rpcCall } = makeContext("panel", "panel-parent");
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();
    const result = await api.openTabsAsPanels({
      hostId: host!.hostId,
      sourceId: "opaque-chrome",
      selection: ["tab-1", "tab-2", "tab-3"],
    });

    expect(result).toMatchObject({ tabsFound: 3, panelsOpened: 2 });
    expect(result.root).toMatchObject({ id: "browser-panel-1", panelsOpened: 2 });
    expect(result.collections).toHaveLength(2);
    expect(result.collections.map((entry) => entry.panelsOpened)).toEqual([1, 1]);

    const collectionCalls = rpcCall.mock.calls.filter(
      (call) =>
        call[1] === "panelTree.create" &&
        (call[2] as { surface?: string; source?: string })?.surface === "code" &&
        (call[2] as { source?: string }).source === "about/collection"
    );
    expect(collectionCalls).toHaveLength(3);
    expect(collectionCalls[0]?.[3]).toMatchObject({
      parentId: null,
      title: "Chrome \u00b7 Imported Tabs",
      focus: false,
      initialLoad: "deferred",
      stateArgs: {
        title: "Chrome \u00b7 Imported Tabs",
        origin: "Chrome \u00b7 browser import",
        startupTask: {
          kind: "title-browser-import-windows",
          sourceName: "Chrome",
        },
        agentConfig: { approvalLevel: 2 },
        channelName: expect.stringMatching(/^collection-/),
        agentKey: expect.stringMatching(/^conductor-/),
      },
    });
    expect(collectionCalls[1]?.[3]).toMatchObject({
      parentId: "browser-panel-1",
      title: "Window 1",
      initialLoad: "deferred",
      contextId: "ctx-panel-1",
      stateArgs: { title: "Window 1" },
    });
    expect(collectionCalls[0]?.[3]).not.toHaveProperty("name");
    expect(collectionCalls[0]?.[3]).not.toHaveProperty("slug");
    expect(collectionCalls[2]?.[3]).toMatchObject({
      parentId: "browser-panel-1",
      title: "Window 2",
      initialLoad: "deferred",
      contextId: "ctx-panel-1",
      stateArgs: { title: "Window 2" },
    });

    const tabParents = rpcCall.mock.calls
      .filter(
        (call) =>
          call[1] === "panelTree.create" &&
          (call[2] as { surface?: string })?.surface === "external"
      )
      .map((call) => (call[3] as { parentId?: string }).parentId);
    expect(new Set(tabParents).size).toBe(2);
    expect(tabParents).not.toContain("browser-panel-1");
    expect(tabParents).not.toContain("panel-parent");
    const tabContexts = rpcCall.mock.calls
      .filter(
        (call) =>
          call[1] === "panelTree.create" &&
          (call[2] as { surface?: string })?.surface === "external"
      )
      .map((call) => (call[3] as { contextId?: string }).contextId);
    expect(new Set(tabContexts)).toEqual(new Set(["ctx-panel-1"]));
    const rootState = (
      collectionCalls[0]?.[3] as {
        stateArgs: { channelName: string; agentKey: string };
      }
    ).stateArgs;
    expect(orchestrationMocks.launchCollectionTask).toHaveBeenCalledOnce();
    expect(orchestrationMocks.launchCollectionTask).toHaveBeenCalledWith(
      expect.objectContaining({ selfId: "@workspace-extensions/browser-data" }),
      expect.objectContaining({
        rootPanelId: "browser-panel-1",
        rootTitle: "panel-1",
        contextId: "ctx-panel-1",
        session: {
          channelName: rootState.channelName,
          agentKey: rootState.agentKey,
        },
        task: expect.stringContaining("window collection"),
        idempotencyKey: `initial-prompt:${rootState.channelName}`,
      })
    );
    const lastPanelCreateOrder = Math.max(
      ...rpcCall.mock.invocationCallOrder.filter(
        (_, index) => rpcCall.mock.calls[index]?.[1] === "panelTree.create"
      )
    );
    expect(orchestrationMocks.launchCollectionTask.mock.invocationCallOrder[0]).toBeGreaterThan(
      lastPanelCreateOrder
    );
  });

  it("does not silently flatten tabs when a requested window collection cannot be created", async () => {
    const { ctx, rpcCall } = makeContext("panel", "panel-parent");
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();

    const passthrough = rpcCall.getMockImplementation()!;
    let collectionCreates = 0;
    rpcCall.mockImplementation(async (targetId: string, method: string, ...args: unknown[]) => {
      if (method !== "panelTree.create") return passthrough(targetId, method, ...args);
      const [execution] = args as [
        { surface: "code"; source: string } | { surface: "external"; url: string },
      ];
      if (execution.surface === "code" && execution.source === "about/collection") {
        collectionCreates += 1;
        if (collectionCreates === 1) {
          return {
            id: "import-root",
            title: "Chrome · Imported Tabs",
            contextId: "ctx-import-root",
          };
        }
        throw new Error("Server auth failed: Not a member of this workspace");
      }
      return { id: "tab-panel-1", title: "Example" };
    });

    const result = await api.openTabsAsPanels({
      hostId: host!.hostId,
      sourceId: "opaque-chrome",
      selection: ["tab-1"],
    });

    expect(result.panelsOpened).toBe(0);
    expect(result.root).toBeUndefined();
    expect(result.collections).toEqual([]);
    expect(result.skipped.map((entry) => entry.reason)).toEqual([
      expect.stringContaining("Could not create Window 1"),
    ]);
    expect(rpcCall).toHaveBeenCalledWith("main", "panelTree.archive", "import-root");
    expect(orchestrationMocks.launchCollectionTask).not.toHaveBeenCalled();
  });

  it("preserves the queued collection task when immediate conductor launch is transiently unavailable", async () => {
    orchestrationMocks.launchCollectionTask.mockRejectedValueOnce(
      new Error("model provider unavailable")
    );
    const { ctx } = makeContext("panel", "panel-parent");
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();

    await expect(
      api.openTabsAsPanels({
        hostId: host!.hostId,
        sourceId: "opaque-chrome",
        selection: ["tab-1"],
        groupBy: "none",
      })
    ).resolves.toMatchObject({ panelsOpened: 1 });

    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not start collection title assignment")
    );
  });

  it("uses one new root collection without scattering ungrouped tabs as roots", async () => {
    const { ctx, rpcCall } = makeContext("panel", "panel-parent");
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();
    const result = await api.openTabsAsPanels({
      hostId: host!.hostId,
      sourceId: "opaque-chrome",
      selection: ["tab-1", "tab-3"],
      groupBy: "none",
    });
    expect(result.root).toMatchObject({ id: "browser-panel-1", panelsOpened: 2 });
    expect(result.collections).toEqual([]);
    const createCalls = rpcCall.mock.calls.filter((call) => call[1] === "panelTree.create");
    expect(createCalls).toHaveLength(3);
    expect(createCalls[0]?.[3]).toMatchObject({ parentId: null });
    expect(createCalls.slice(1).map((call) => (call[3] as { parentId?: string }).parentId)).toEqual(
      ["browser-panel-1", "browser-panel-1"]
    );
  });
});
