import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("@vibestudio/browser-import", async () => {
  const actual =
    await vi.importActual<typeof import("@vibestudio/browser-import")>(
      "@vibestudio/browser-import"
    );
  return {
    ...actual,
    LocalBrowserImportProvider: class {
      async listSources() {
        return [{
          sourceId: "opaque-chrome",
          browser: "chrome",
          displayName: "Chrome",
          status: "readable",
          localDataSetCount: 2,
          supportedDataTypes: ["bookmarks", "history"],
          warnings: [],
        }];
      }
      async preview() {
        return { dataTypes: [], openTabCount: 2, localDataSetCount: 2, warnings: [] };
      }
      async import(
        sourceId: string,
        dataTypes: string[],
        sink: { store(batch: unknown): Promise<void>; progress(progress: unknown): Promise<void> }
      ) {
        if (dataTypes.includes("bookmarks")) {
          await sink.store({
            jobId: "",
            sourceId,
            dataType: "bookmarks",
            batchIndex: 0,
            idempotencyKey: "",
            items: [{ title: "Example", url: "https://example.com" }],
          });
          await sink.progress({
            dataType: "bookmarks",
            itemsProcessed: 1,
            stored: 1,
            skipped: 0,
            errors: 0,
          });
        }
        return {
          dataTypes: [{
            dataType: "bookmarks",
            itemsProcessed: 1,
            stored: 1,
            skipped: 0,
            errors: 0,
          }],
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
  const rpcCall = vi.fn(async (_targetId: string, method: string, ..._args: unknown[]) => {
    if (method === "addBookmarksBatch") return 1;
    if (method === "addBookmark") return 42;
    if (method === "getBookmarks") return [{ id: 1, title: "Example" }];
    if (method === "getPasswords") return [{ id: 7, origin_url: "https://example.com" }];
    if (method === "panelTree.create") {
      createdPanels += 1;
      return { id: `browser-panel-${createdPanels}`, title: `panel-${createdPanels}` };
    }
    return [];
  });
  const emit = vi.fn();
  const health = { healthy: vi.fn(), degraded: vi.fn(), unhealthy: vi.fn() };
  const resolveDurableObject = vi.fn(async () => ({
    targetId: "do:vibestudio/internal:BrowserDataDO:environment-key",
    objectKey: "environment-key",
  }));
  const approvalsRequest = vi.fn(async () => approvalChoice);
  return {
    ctx: {
      rpc: { call: rpcCall },
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
      log: { info: vi.fn() },
      health,
      emit,
    },
    rpcCall,
    resolveDurableObject,
    approvalsRequest,
    emit,
    health,
  };
}

describe("@workspace-extensions/browser-data", () => {
  it("matches the manifest-declared provider and contains no retired import methods", async () => {
    const { ctx } = makeContext();
    const activated = await activate(ctx as never);
    const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
      vibestudio: { extension: { providerContracts: { browserData: { methods: string[] } } } };
    };
    const methods = Object.keys(activated.providerContracts.browserData);
    expect(methods).toEqual(manifest.vibestudio.extension.providerContracts.browserData.methods);
    expect(methods).not.toEqual(expect.arrayContaining([
      "detectBrowsers",
      "getProfileImportState",
      "getAutofillSuggestions",
    ]));
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
      expect.objectContaining({ subject: { id: "browser-data:getPasswords", label: expect.any(String) } })
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
      expect(
        (await api.getImportJob(result.jobId) as { phase?: string } | null)?.phase
      ).toBe("complete");
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
    expect(emit).toHaveBeenCalledWith("import-complete", expect.objectContaining({ phase: "complete" }));
    expect(health.healthy).toHaveBeenLastCalledWith({ summary: "Browser data import completed" });
  });

  it("opens only selected HTTP tabs as ordinary child panels", async () => {
    const { ctx, rpcCall } = makeContext("panel", "panel-parent");
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();
    await expect(
      api.openTabsAsPanels({
        hostId: host!.hostId,
        sourceId: "opaque-chrome",
        selection: ["tab-1", "tab-2"],
      })
    ).resolves.toMatchObject({ tabsFound: 2, panelsOpened: 1 });
    expect(rpcCall).toHaveBeenCalledWith("main", "panelTree.create", "https://example.com/", {
      parentId: "panel-parent",
      title: "Example",
      focus: false,
    });
  });

  it("nests tabs under one collection panel per source window when grouping", async () => {
    const { ctx, rpcCall } = makeContext("panel", "panel-parent");
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();
    const result = await api.openTabsAsPanels({
      hostId: host!.hostId,
      sourceId: "opaque-chrome",
      selection: ["tab-1", "tab-2", "tab-3"],
      groupBy: "window",
    });

    expect(result).toMatchObject({ tabsFound: 3, panelsOpened: 2 });
    expect(result.collections).toHaveLength(2);
    expect(result.collections.map((entry) => entry.panelsOpened)).toEqual([1, 1]);

    const collectionCalls = rpcCall.mock.calls.filter(
      (call) => call[1] === "panelTree.create" && call[2] === "about/collection"
    );
    expect(collectionCalls).toHaveLength(2);
    // `name` would mint the panel's id segment, not a label: the collection
    // takes its title from stateArgs instead.
    expect(collectionCalls[0]?.[3]).toMatchObject({
      parentId: "panel-parent",
      title: "Chrome \u00b7 Window 1",
      stateArgs: { title: "Chrome \u00b7 Window 1" },
    });
    // `name` would mint an id segment; identity stays generated.
    expect(collectionCalls[0]?.[3]).not.toHaveProperty("name");
    expect(collectionCalls[0]?.[3]).not.toHaveProperty("slug");
    expect(collectionCalls[1]?.[3]).toMatchObject({
      stateArgs: { title: "Chrome \u00b7 Window 2" },
    });

    // Each tab is parented to its window's collection, not to the caller.
    const tabParents = rpcCall.mock.calls
      .filter((call) => call[1] === "panelTree.create" && String(call[2]).startsWith("https://"))
      .map((call) => (call[3] as { parentId?: string }).parentId);
    expect(new Set(tabParents).size).toBe(2);
    expect(tabParents).not.toContain("panel-parent");
  });

  it("still opens tabs when their collection cannot host children", async () => {
    const { ctx, rpcCall } = makeContext("panel", "panel-parent");
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();

    // Collections are created fine, but parenting a tab under one fails —
    // the failure mode that silently produced empty collections.
    const passthrough = rpcCall.getMockImplementation()!;
    rpcCall.mockImplementation(async (targetId: string, method: string, ...args: unknown[]) => {
      if (method !== "panelTree.create") return passthrough(targetId, method, ...args);
      const [source, options] = args as [string, { parentId?: string }];
      if (source === "about/collection") return { id: "collection-1", title: "Collection" };
      if (options?.parentId === "collection-1") {
        throw new Error("Server auth failed: Not a member of this workspace");
      }
      return { id: "tab-panel-1", title: "Example" };
    });

    const result = await api.openTabsAsPanels({
      hostId: host!.hostId,
      sourceId: "opaque-chrome",
      selection: ["tab-1"],
      groupBy: "window",
    });

    // The tab lands under the caller rather than being lost.
    expect(result.panelsOpened).toBe(1);
    expect(result.collections).toEqual([]);
    expect(result.skipped.map((entry) => entry.reason)).toEqual([
      expect.stringContaining("Tabs opened outside their collection"),
    ]);
  });

  it("skips grouping when groupBy is omitted", async () => {
    const { ctx, rpcCall } = makeContext("panel", "panel-parent");
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();
    const result = await api.openTabsAsPanels({
      hostId: host!.hostId,
      sourceId: "opaque-chrome",
      selection: ["tab-1", "tab-3"],
    });
    expect(result.collections).toEqual([]);
    expect(
      rpcCall.mock.calls.filter((call) => call[2] === "about/collection")
    ).toHaveLength(0);
  });
});
