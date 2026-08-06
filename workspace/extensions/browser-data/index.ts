import {
  exportChromiumBookmarks,
  exportCsvPasswords,
  exportNetscapeBookmarks,
  exportNetscapeCookies,
  LocalBrowserImportProvider,
} from "@vibestudio/browser-import";
import {
  BrowserImportCoordinator,
  RemoteBrowserImportProvider,
  type BrowserCookieInput,
  type BrowserEnvironmentIdentity,
  type BrowserImportDataType,
  type BrowserImportSelection,
  type BrowserImportStore,
  type ImportBatch,
  type ImportedBookmark,
  type ImportedCookie,
  type ImportedPassword,
  type ImportJobSnapshot,
  type ImportHostSummary,
  type OpenTabsAsPanelsRequest,
  type OpenTabsAsPanelsResult,
} from "@vibestudio/browser-data";
import {
  createCollectionSession,
  launchCollectionTask,
  promptForCollectionStartupTask,
  type CollectionOrchestrationRpc,
  type CollectionSessionDescriptor,
  type CollectionStartupTask,
} from "@workspace/collection-orchestration";
import { createPanelRuntime } from "@workspace/runtime/panel-runtime";

interface InvocationLike {
  current(): {
    caller: {
      callerId?: string;
      callerKind: string;
      callerTitle?: string;
      userId?: string;
      workspaceId?: string;
    };
    chainCaller?: { callerId: string; callerKind: string };
  } | null;
  signal?(): AbortSignal | null;
}

interface ResolvedBuiltinService {
  kind: "durable-object";
  targetId: string;
  objectKey?: string;
}

interface ExtensionContextLike {
  rpc: {
    call<T>(targetId: string, method: string, ...args: unknown[]): Promise<T>;
    stream(
      targetId: string,
      method: string,
      args: unknown[],
      options?: { signal?: AbortSignal }
    ): Promise<Response>;
  };
  workers: {
    resolveService(protocol: string): Promise<ResolvedBuiltinService>;
  };
  invocation: InvocationLike;
  log: {
    info(message: string): void;
    warn?(message: string): void;
  };
  health?: {
    healthy(detail?: { summary: string }): void;
    degraded(detail: { summary: string; reasons?: string[] }): void;
    unhealthy(detail: { summary: string; reasons?: string[] }): void;
  };
  emit(event: string, payload: unknown): void;
}

const BROWSER_DATA_PROTOCOL = "vibestudio.browser-data.v1";
const TRUSTED_CALLER_KINDS = new Set(["shell", "server"]);

function collectionOrchestrationRpc(ctx: ExtensionContextLike): CollectionOrchestrationRpc {
  return {
    selfId: "@workspace-extensions/browser-data",
    call: (targetId, method, args) => ctx.rpc.call(targetId, method, ...args),
    stream: (targetId, method, args, options) => ctx.rpc.stream(targetId, method, args, options),
  };
}

/** Public API surface of this extension. */
export type Api = Awaited<ReturnType<typeof activate>>;

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("browser-data extension activating");

  const resolvedStores = new Map<
    string,
    Promise<{ identity: BrowserEnvironmentIdentity; targetId: string }>
  >();
  const targetByEnvironment = new Map<string, string>();
  const unregisterServerHosts = new Map<string, () => void>();
  const desktopHosts = new Map<string, { hostId: string; unregister: () => void }>();
  const hostLabels = new Map<string, string>();
  const sourceBrowsers = new Map<string, string>();
  const provider = new LocalBrowserImportProvider();

  const currentIdentity = async (): Promise<{
    identity: BrowserEnvironmentIdentity;
    targetId: string;
  }> => {
    const invocation = ctx.invocation.current();
    const userId = invocation?.caller.userId?.trim();
    const workspaceId = invocation?.caller.workspaceId?.trim();
    if (!userId || !workspaceId || userId === "system") {
      throw Object.assign(new Error("Browser data requires a verified user and workspace"), {
        code: "ENOCALLER",
      });
    }
    const cacheKey = `${workspaceId}\x00${userId}`;
    let pending = resolvedStores.get(cacheKey);
    if (!pending) {
      pending = ctx.workers
        .resolveService(BROWSER_DATA_PROTOCOL)
        .then((target) => {
          if (target.kind !== "durable-object") {
            throw new Error("browser.data did not resolve to a Durable Object");
          }
          const environmentKey = target.objectKey ?? target.targetId.split(":").at(-1) ?? "";
          if (!environmentKey) {
            throw new Error("Server did not derive a browser environment key");
          }
          const identity = {
            workspaceId,
            ownerUserId: userId,
            environmentKey,
          };
          targetByEnvironment.set(environmentKey, target.targetId);
          return { identity, targetId: target.targetId };
        })
        .catch((error: unknown) => {
          resolvedStores.delete(cacheKey);
          ctx.health?.degraded({
            summary: "Browser environment storage unavailable",
            reasons: [error instanceof Error ? error.message : String(error)],
          });
          throw error;
        });
      resolvedStores.set(cacheKey, pending);
    }
    return pending;
  };

  const callStoreForIdentity = <T>(
    identity: BrowserEnvironmentIdentity,
    method: string,
    ...args: unknown[]
  ): Promise<T> => {
    const targetId = targetByEnvironment.get(identity.environmentKey);
    if (!targetId) throw new Error("Browser environment target is not resolved");
    return ctx.rpc
      .call<T>(targetId, method, ...args)
      .then((result) => {
        ctx.health?.healthy({ summary: "Browser environment storage ready" });
        return result;
      })
      .catch((error: unknown) => {
        ctx.health?.degraded({
          summary: "Browser environment storage unavailable",
          reasons: [error instanceof Error ? error.message : String(error)],
        });
        throw error;
      });
  };

  const store: BrowserImportStore = {
    async storeBatch(identity, batch) {
      await storeImportBatch(batch, (method, ...args) =>
        callStoreForIdentity(identity, method, ...args)
      );
      await callStoreForIdentity(identity, "recordImportBatch", {
        jobId: batch.jobId,
        dataType: batch.dataType,
        batchIndex: batch.batchIndex,
        idempotencyKey: batch.idempotencyKey,
        itemCount: batch.items.length,
      });
      ctx.emit("data-changed", { dataType: batch.dataType });
    },
    async reconcileImport(identity, dataTypes) {
      if (!dataTypes.includes("cookies") || !desktopHosts.has(identity.environmentKey)) return;
      await ctx.rpc.call("main", "browserEnvironment.flushCookieProjection", []);
    },
    persistJob(identity, job) {
      return callStoreForIdentity(identity, "upsertImportJob", {
        jobId: job.jobId,
        hostId: job.hostId,
        hostLabel: hostLabels.get(job.hostId) ?? "Browser host",
        sourceId: job.sourceId,
        browser: sourceBrowsers.get(job.sourceId) ?? "unknown",
        phase: job.phase,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt,
        dataTypes: job.requestedDataTypes,
        progress: job.progress,
        warnings: job.warnings,
        error: job.error,
        resumable: job.resumable,
      });
    },
    getJob(identity, jobId) {
      return callStoreForIdentity(identity, "getImportJob", jobId);
    },
  };
  const coordinator = new BrowserImportCoordinator(store, (identity, job) => {
    ctx.emit("import-job-changed", {
      environmentKey: identity.environmentKey,
      job,
    });
  });

  const ensureServerHost = (identity: BrowserEnvironmentIdentity): void => {
    if (unregisterServerHosts.has(identity.environmentKey)) return;
    const unregister = coordinator.registerHost({
      hostId: `server:${identity.workspaceId}`,
      ownerUserId: identity.ownerUserId,
      displayName: "Server",
      platform: normalizedPlatform(),
      location: "server",
      connected: true,
      provider,
    });
    unregisterServerHosts.set(identity.environmentKey, unregister);
    hostLabels.set(`server:${identity.workspaceId}`, "Server");
  };

  const ensureDesktopHost = async (
    identity: BrowserEnvironmentIdentity
  ): Promise<ImportHostSummary | null> => {
    try {
      const summary = await ctx.rpc.call<ImportHostSummary>(
        "main",
        "browserEnvironment.getImportHost"
      );
      const current = desktopHosts.get(identity.environmentKey);
      if (current?.hostId === summary.hostId) return summary;
      current?.unregister();
      const remoteProvider = new RemoteBrowserImportProvider((method, ...args) =>
        ctx.rpc.call("main", `browserEnvironment.${method}`, ...args)
      );
      const unregister = coordinator.registerHost({
        ...summary,
        ownerUserId: identity.ownerUserId,
        provider: remoteProvider,
      });
      desktopHosts.set(identity.environmentKey, {
        hostId: summary.hostId,
        unregister,
      });
      hostLabels.set(summary.hostId, summary.displayName);
      return summary;
    } catch {
      desktopHosts.get(identity.environmentKey)?.unregister();
      desktopHosts.delete(identity.environmentKey);
      return null;
    }
  };

  const ensureImportHosts = async (identity: BrowserEnvironmentIdentity): Promise<void> => {
    ensureServerHost(identity);
    await ensureDesktopHost(identity);
  };

  const guarded =
    <Args extends unknown[], Result>(_method: string, fn: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      return fn(...args);
    };

  const callStore = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    const { identity } = await currentIdentity();
    return callStoreForIdentity<T>(identity, method, ...args);
  };
  const browserData = {
    getBrowserEnvironment: guarded("getBrowserEnvironment", async () => {
      const invocation = ctx.invocation.current();
      if (!invocation || !TRUSTED_CALLER_KINDS.has(invocation.caller.callerKind)) {
        throw Object.assign(
          new Error("Browser environment identity is available only to the trusted host"),
          { code: "EACCES" }
        );
      }
      return (await currentIdentity()).identity;
    }),
    listImportHosts: guarded("listImportHosts", async () => {
      const { identity } = await currentIdentity();
      await ensureImportHosts(identity);
      return coordinator.listHosts(identity);
    }),
    listImportSources: guarded("listImportSources", async (hostId: string) => {
      const { identity } = await currentIdentity();
      await ensureImportHosts(identity);
      const sources = await coordinator.listSources(
        identity,
        hostId,
        ctx.invocation.signal?.() ?? undefined
      );
      for (const source of sources) sourceBrowsers.set(source.sourceId, source.browser);
      return sources;
    }),
    previewImport: guarded("previewImport", async (selection: BrowserImportSelection) => {
      const { identity } = await currentIdentity();
      await ensureImportHosts(identity);
      return coordinator.preview(identity, selection, ctx.invocation.signal?.() ?? undefined);
    }),
    startImport: guarded("startImport", async (selection: BrowserImportSelection) => {
      const { identity } = await currentIdentity();
      await ensureImportHosts(identity);
      const started = coordinator.start(identity, selection);
      void coordinator.waitForJob(identity, started.jobId).then((completed) => {
        reportImportHealth(ctx, completed);
        ctx.emit("import-complete", completed);
      });
      return started;
    }),
    cancelImport: guarded("cancelImport", async (jobId: string) => {
      const { identity } = await currentIdentity();
      coordinator.cancel(identity, jobId);
    }),
    resumeImport: guarded("resumeImport", async (jobId: string) => {
      const { identity } = await currentIdentity();
      await ensureImportHosts(identity);
      const resumed = await coordinator.resume(identity, jobId);
      void coordinator.waitForJob(identity, resumed.jobId).then((completed) => {
        reportImportHealth(ctx, completed);
        ctx.emit("import-complete", completed);
      });
      return resumed;
    }),
    getImportJob: guarded("getImportJob", async (jobId: string) => {
      const { identity } = await currentIdentity();
      return coordinator.getJob(identity, jobId) ?? callStore("getImportJob", jobId);
    }),
    listImportJobs: guarded("listImportJobs", async () => {
      const { identity } = await currentIdentity();
      const live = coordinator.listJobs(identity);
      return live.length > 0 ? live : callStore("listImportJobs");
    }),
    listOpenTabs: guarded("listOpenTabs", async (request: { hostId: string; sourceId: string }) => {
      const { identity } = await currentIdentity();
      await ensureImportHosts(identity);
      return coordinator.listOpenTabs(
        identity,
        request.hostId,
        request.sourceId,
        ctx.invocation.signal?.() ?? undefined
      );
    }),
    openTabsAsPanels: guarded("openTabsAsPanels", async (request: OpenTabsAsPanelsRequest) => {
      const { identity } = await currentIdentity();
      await ensureImportHosts(identity);
      const tabs = await coordinator.listOpenTabs(
        identity,
        request.hostId,
        request.sourceId,
        ctx.invocation.signal?.() ?? undefined
      );
      const chosen =
        request.selection.length > 0
          ? tabs.filter((tab) => request.selection.includes(tab.tabId))
          : tabs;
      const sources = await coordinator.listSources(
        identity,
        request.hostId,
        ctx.invocation.signal?.() ?? undefined
      );
      const sourceName =
        sources.find((source) => source.sourceId === request.sourceId)?.displayName ?? "Browser";
      return openTabsAsPanels(chosen, ctx, {
        destination: request.destination ?? "new-root",
        groupBy: request.groupBy ?? "window",
        sourceName,
      });
    }),
    flushCookieProjection: guarded("flushCookieProjection", async (origins?: string[]) =>
      ctx.rpc.call("main", "browserEnvironment.flushCookieProjection", origins ?? [])
    ),
    getCookieProjectionDiagnostics: guarded("getCookieProjectionDiagnostics", async () =>
      ctx.rpc.call("main", "browserEnvironment.getCookieProjectionDiagnostics")
    ),
    listDownloads: guarded("listDownloads", async () =>
      ctx.rpc.call("main", "browserEnvironment.listDownloads")
    ),
    pauseDownload: guarded("pauseDownload", async (id: string) =>
      ctx.rpc.call("main", "browserEnvironment.pauseDownload", id)
    ),
    resumeDownload: guarded("resumeDownload", async (id: string) =>
      ctx.rpc.call("main", "browserEnvironment.resumeDownload", id)
    ),
    cancelDownload: guarded("cancelDownload", async (id: string) =>
      ctx.rpc.call("main", "browserEnvironment.cancelDownload", id)
    ),
    openDownload: guarded("openDownload", async (id: string) =>
      ctx.rpc.call("main", "browserEnvironment.openDownload", id)
    ),
    revealDownload: guarded("revealDownload", async (id: string) =>
      ctx.rpc.call("main", "browserEnvironment.revealDownload", id)
    ),

    exportBookmarks: guarded("exportBookmarks", async (format: "html" | "json" | "chrome-json") =>
      exportBookmarks(format, await callStore<Array<Record<string, unknown>>>("getAllBookmarks"))
    ),
    exportPasswords: guarded(
      "exportPasswords",
      async (format: "csv-chrome" | "csv-firefox" | "json") =>
        exportPasswords(format, await callStore<Array<Record<string, unknown>>>("getPasswords"))
    ),
    exportCookies: guarded("exportCookies", async (format: "json" | "netscape-txt") => {
      const snapshot = await callStore<{
        cookies: Array<Record<string, unknown>>;
      }>("getCookieSnapshot", {});
      return exportCookies(format, snapshot.cookies);
    }),
  };

  return { providerContracts: { browserData } };
}

async function storeImportBatch(
  batch: ImportBatch,
  callStore: <T>(method: string, ...args: unknown[]) => Promise<T>
): Promise<void> {
  const source = { sourceId: batch.sourceId };
  switch (batch.dataType) {
    case "bookmarks":
      await callStore("addBookmarksBatch", batch.items, source);
      return;
    case "history":
      await callStore("addHistoryBatch", batch.items, source);
      return;
    case "cookies":
      await callStore("addCookiesBatch", {
        jobId: batch.jobId,
        batchIndex: batch.batchIndex,
        cookies: batch.items as BrowserCookieInput[],
      });
      return;
    case "passwords":
      await callStore("addPasswordsBatch", batch.items, source);
      return;
    case "formFill":
      await callStore("addFormFillBatch", batch.items, source);
      return;
    case "searchEngines":
      await callStore("addSearchEnginesBatch", batch.items, source);
      return;
    case "favicons":
      await callStore("addFaviconsBatch", batch.items);
  }
}

interface OpenableTab {
  url: string;
  title?: string;
  windowId?: string;
  windowOrdinal?: number;
}

async function openTabsAsPanels(
  tabs: OpenableTab[],
  ctx: ExtensionContextLike,
  policy: {
    destination: "new-root" | "caller";
    groupBy: "window" | "none";
    sourceName: string;
  }
): Promise<OpenTabsAsPanelsResult> {
  const importStartedAt = Date.now();
  const slotTimings: Array<{ stage: string; durationMs: number; outcome: string }> = [];
  const panelRuntime = createPanelRuntime({
    rpc: {
      call: async <T>(target: string, method: string, args: unknown[]): Promise<T> =>
        (await ctx.rpc.call(target, method, ...args)) as T,
      emit: async () => {
        throw new Error("Browser-data panel composition does not emit target events");
      },
      on: () => () => {},
    },
    onCreateSlotTiming: (event) => {
      slotTimings.push(event);
      if (event.durationMs >= 5_000) {
        ctx.log.warn?.(
          `Slow browser panel creation stage ${event.stage}: ${event.durationMs}ms (${event.outcome})`
        );
      }
    },
  });
  const callerId = parentPanelIdFromInvocation(ctx.invocation.current());
  const panels: Array<{ id: string; title: string; url: string }> = [];
  const collections: Array<{
    id: string;
    title: string;
    parentId: string;
    panelsOpened: number;
  }> = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  const openable: OpenableTab[] = [];
  for (const tab of tabs) {
    if (!/^https?:\/\//i.test(tab.url)) {
      skipped.push({ url: tab.url, reason: "unsupported browser-panel URL scheme" });
      continue;
    }
    openable.push(tab);
  }

  if (openable.length === 0) {
    return {
      destination: policy.destination,
      groupBy: policy.groupBy,
      tabsFound: tabs.length,
      panelsOpened: 0,
      collections,
      panels,
      skipped,
    };
  }

  const createCollection = async (
    parentId: string | null,
    title: string,
    origin: string,
    options: {
      contextId?: string;
      stateArgs?: Record<string, unknown>;
    } = {}
  ): Promise<{ id: string; title: string; contextId: string }> => {
    const panel = await panelRuntime.openPanel("about/collection", {
      parentId,
      title,
      focus: false,
      ...(options.contextId ? { contextId: options.contextId } : {}),
      stateArgs: { title, origin, ...(options.stateArgs ?? {}) },
    });
    const observation = await panel.observe();
    return {
      id: panel.id,
      title: panel.title ?? title,
      contextId: observation.contextId,
    };
  };

  let root: OpenTabsAsPanelsResult["root"];
  let rootOrchestration:
    | {
        id: string;
        title: string;
        contextId: string;
        session: CollectionSessionDescriptor;
        startupTask: CollectionStartupTask;
      }
    | undefined;
  let anchorId: string;
  let orchestrationContextId: string | undefined;
  if (policy.destination === "new-root") {
    const title = `${policy.sourceName} · Imported Tabs`;
    const session = createCollectionSession();
    const startupTask: CollectionStartupTask = {
      kind: "title-browser-import-windows",
      sourceName: policy.sourceName,
    };
    const created = await createCollection(null, title, `${policy.sourceName} · browser import`, {
      stateArgs: {
        ...session,
        startupTask,
        agentConfig: { approvalLevel: 2 },
      },
    });
    root = { id: created.id, title: created.title, panelsOpened: 0 };
    rootOrchestration = {
      id: created.id,
      title: created.title,
      contextId: created.contextId,
      session,
      startupTask,
    };
    anchorId = created.id;
    orchestrationContextId = created.contextId;
  } else {
    if (!callerId) {
      throw new Error("The calling panel is unavailable; choose a new workspace root instead");
    }
    anchorId = callerId;
    const anchor = panelRuntime.getPanelHandle(anchorId);
    orchestrationContextId = (await anchor.observe()).contextId;
  }

  const groups = new Map<string, { title: string; tabs: OpenableTab[] }>();
  for (const tab of openable) {
    const key = policy.groupBy === "window" && tab.windowId ? tab.windowId : "";
    let group = groups.get(key);
    if (!group) {
      const ordinal = tab.windowOrdinal ?? groups.size + 1;
      group = {
        title:
          policy.destination === "new-root"
            ? `Window ${ordinal}`
            : `${policy.sourceName} · Window ${ordinal}`,
        tabs: [],
      };
      groups.set(key, group);
    }
    group.tabs.push(tab);
  }

  const archiveEmptyContainer = async (id: string, title: string) => {
    try {
      await panelRuntime.getPanelHandle(id).close();
    } catch (error) {
      skipped.push({
        url: "(collection)",
        reason: `Could not remove empty collection ${title}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  };

  for (const [windowId, group] of groups) {
    let panelParentId = anchorId;
    let collection: (typeof collections)[number] | undefined;
    if (policy.groupBy === "window" && windowId) {
      try {
        const created = await createCollection(
          anchorId,
          group.title,
          `${policy.sourceName} · imported browser window`,
          { contextId: orchestrationContextId }
        );
        collection = {
          id: created.id,
          title: created.title,
          parentId: anchorId,
          panelsOpened: 0,
        };
        collections.push(collection);
        panelParentId = created.id;
      } catch (error) {
        const reason = `Could not create ${group.title}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        skipped.push(...group.tabs.map((tab) => ({ url: tab.url, reason })));
        continue;
      }
    }

    for (const tab of group.tabs) {
      const title = (tab.title?.trim() || hostnameFromUrl(tab.url) || "Imported Tab").slice(0, 80);
      try {
        // Browser panels are intentionally deferred: importing a tab records
        // its durable slot and URL, but must not wait for the external page to
        // finish loading. `openPanel` waits up to 90 seconds for browser
        // readiness, which serializes a tab import behind every slow site.
        const created = await panelRuntime.createPanelSlot(tab.url, {
          parentId: panelParentId,
          // A label, not an id: page titles repeat constantly ("New Tab"), and
          // as an id segment they collided.
          title,
          ...(orchestrationContextId ? { contextId: orchestrationContextId } : {}),
        });
        panels.push({ id: created.id, title: created.title ?? title, url: tab.url });
        if (collection) collection.panelsOpened += 1;
        if (root) root.panelsOpened += 1;
      } catch (error) {
        skipped.push({
          url: tab.url,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (collection?.panelsOpened === 0) {
      await archiveEmptyContainer(collection.id, collection.title);
    }
  }

  const nonEmptyCollections = collections.filter((entry) => entry.panelsOpened > 0);
  if (root?.panelsOpened === 0) {
    await archiveEmptyContainer(root.id, root.title);
    root = undefined;
    rootOrchestration = undefined;
  }
  if (root && rootOrchestration) {
    const launchStartedAt = Date.now();
    try {
      await launchCollectionTask(collectionOrchestrationRpc(ctx), {
        rootPanelId: rootOrchestration.id,
        rootTitle: rootOrchestration.title,
        contextId: rootOrchestration.contextId,
        session: rootOrchestration.session,
        task: promptForCollectionStartupTask(rootOrchestration.startupTask),
        // The collection UI uses the same key for its queued fallback. A
        // successful immediate publish therefore cannot duplicate on open.
        idempotencyKey: `initial-prompt:${rootOrchestration.session.channelName}`,
        agentConfig: { approvalLevel: 2 },
      });
    } catch (error) {
      // Tab import is already durable. Preserve startupTask as the idempotent
      // fallback when the user later opens the collection, and surface the
      // transient launch problem without misreporting imported tabs as skipped.
      ctx.log.warn?.(
        `Imported tabs, but could not start collection title assignment: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      const durationMs = Date.now() - launchStartedAt;
      if (durationMs >= 5_000) {
        ctx.log.warn?.(`Slow post-import collection launch: ${durationMs}ms`);
      }
    }
  }
  const stageTotals = slotTimings.reduce<Record<string, { calls: number; durationMs: number }>>(
    (totals, timing) => {
      const current = totals[timing.stage] ?? { calls: 0, durationMs: 0 };
      current.calls += 1;
      current.durationMs += timing.durationMs;
      totals[timing.stage] = current;
      return totals;
    },
    {}
  );
  ctx.log.info(
    `Browser panel import completed: ${panels.length}/${openable.length} panels in ${
      Date.now() - importStartedAt
    }ms; stages=${JSON.stringify(stageTotals)}`
  );
  return {
    destination: policy.destination,
    groupBy: policy.groupBy,
    tabsFound: tabs.length,
    panelsOpened: panels.length,
    ...(root ? { root } : {}),
    collections: nonEmptyCollections,
    panels,
    skipped,
  };
}

function parentPanelIdFromInvocation(
  invocation: ReturnType<InvocationLike["current"]>
): string | undefined {
  const caller = invocation?.chainCaller ?? invocation?.caller;
  return caller && ["panel", "app", "worker", "do"].includes(caller.callerKind) && caller.callerId
    ? caller.callerId
    : undefined;
}

function exportBookmarks(
  format: "html" | "json" | "chrome-json",
  rows: Array<Record<string, unknown>>
): string {
  const bookmarks: ImportedBookmark[] = rows.map((row) => ({
    title: String(row["title"] ?? ""),
    url: String(row["url"] ?? ""),
    dateAdded: Number(row["date_added"] ?? Date.now()),
    folder: String(row["folder_path"] ?? "/")
      .split("/")
      .filter(Boolean),
    tags: row["tags"] ? String(row["tags"]).split(",").filter(Boolean) : undefined,
    keyword: row["keyword"] ? String(row["keyword"]) : undefined,
  }));
  if (format === "html") return exportNetscapeBookmarks(bookmarks);
  if (format === "chrome-json") return exportChromiumBookmarks(bookmarks);
  return JSON.stringify(bookmarks, null, 2);
}

function exportPasswords(
  format: "csv-chrome" | "csv-firefox" | "json",
  rows: Array<Record<string, unknown>>
): string {
  const passwords: ImportedPassword[] = rows.map((row) => ({
    url: String(row["origin_url"] ?? ""),
    username: String(row["username"] ?? ""),
    password: String(row["password"] ?? ""),
    actionUrl: row["action_url"] ? String(row["action_url"]) : undefined,
    realm: row["realm"] ? String(row["realm"]) : undefined,
  }));
  if (format === "csv-chrome") return exportCsvPasswords(passwords, "chrome");
  if (format === "csv-firefox") return exportCsvPasswords(passwords, "firefox");
  return JSON.stringify(passwords, null, 2);
}

function exportCookies(
  format: "json" | "netscape-txt",
  rows: Array<Record<string, unknown>>
): string {
  const cookies: ImportedCookie[] = rows.map((row) => {
    const partitionKey = row["partitionKey"];
    return {
      name: String(row["name"] ?? ""),
      valueStatus: "available",
      value: String(row["value"] ?? ""),
      domain: String(row["domain"] ?? ""),
      hostOnly: Boolean(row["hostOnly"]),
      path: String(row["path"] ?? "/"),
      ...(partitionKey && typeof partitionKey === "object"
        ? {
            partitionKey: partitionKey as NonNullable<ImportedCookie["partitionKey"]>,
          }
        : {}),
      expirationDate: row["expirationDate"] == null ? undefined : Number(row["expirationDate"]),
      secure: Boolean(row["secure"]),
      httpOnly: Boolean(row["httpOnly"]),
      sameSite: String(row["sameSite"] ?? "unspecified") as ImportedCookie["sameSite"],
      sourceScheme: String(row["sourceScheme"] ?? "unset") as ImportedCookie["sourceScheme"],
      sourcePort: Number(row["sourcePort"] ?? -1),
    };
  });
  if (format === "netscape-txt" && cookies.some((cookie) => cookie.partitionKey)) {
    throw new Error(
      "Netscape cookie files cannot represent partition keys; use JSON export instead"
    );
  }
  return format === "netscape-txt"
    ? exportNetscapeCookies(cookies)
    : JSON.stringify(cookies, null, 2);
}

function reportImportHealth(ctx: ExtensionContextLike, job: ImportJobSnapshot): void {
  if (job.phase === "failed" || job.phase === "cancelled") {
    ctx.health?.degraded({
      summary: job.phase === "cancelled" ? "Browser import cancelled" : "Browser import failed",
      reasons: job.error ? [job.error] : undefined,
    });
  } else if (job.phase === "partial" || job.warnings.length > 0) {
    ctx.health?.degraded({
      summary: "Browser import completed with warnings",
      reasons: job.warnings.slice(0, 8),
    });
  } else {
    ctx.health?.healthy({ summary: "Browser data import completed" });
  }
}

function normalizedPlatform(): "darwin" | "linux" | "win32" {
  const platform = (globalThis as { process?: { platform?: string } }).process?.platform;
  return platform === "darwin" || platform === "win32" ? platform : "linux";
}

function hostnameFromUrl(raw: string): string | null {
  try {
    return new URL(raw).hostname || null;
  } catch {
    return null;
  }
}
