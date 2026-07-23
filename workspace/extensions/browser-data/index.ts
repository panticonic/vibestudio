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
  type FormFillValueInput,
  type ImportBatch,
  type ImportedBookmark,
  type ImportedCookie,
  type ImportedPassword,
  type ImportJobSnapshot,
  type ImportHostSummary,
  type PageFavicon,
  type RecordHistoryVisitRequest,
  type UpdateHistoryTitleRequest,
} from "@vibestudio/browser-data";

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

interface UserlandApprovalRequestLike {
  subject: { id: string; label?: string };
  title: string;
  summary?: string;
  warning?: string;
  details?: Array<{ label: string; value: string; format?: "plain" | "markdown" | "code" }>;
  severity?: "standard" | "dangerous";
  defaultAction?: "allow" | "deny";
  promptOptions?: "scoped" | "choices";
}

type UserlandApprovalChoiceLike =
  | { kind: "choice"; choice: string }
  | { kind: "dismissed" }
  | { kind: "uncallable"; reason: string };

interface ResolvedDurableObject {
  targetId: string;
  objectKey?: string;
}

interface ExtensionContextLike {
  rpc: {
    call<T>(targetId: string, method: string, ...args: unknown[]): Promise<T>;
  };
  workers: {
    resolveDurableObject(
      source: string,
      className: string,
      objectKey: string
    ): Promise<ResolvedDurableObject>;
  };
  invocation: InvocationLike;
  approvals: {
    request(req: UserlandApprovalRequestLike): Promise<UserlandApprovalChoiceLike>;
  };
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

const DO_SOURCE = "vibestudio/internal";
const DO_CLASS = "BrowserDataDO";
const DO_RESOLUTION_SENTINEL = "browser-environment";
const TRUSTED_CALLER_KINDS = new Set(["shell", "server"]);

const GATED_METHODS = new Set([
  "listImportHosts",
  "listImportSources",
  "previewImport",
  "startImport",
  "cancelImport",
  "resumeImport",
  "listOpenTabs",
  "openTabsAsPanels",
  "getPasswords",
  "getPasswordForSite",
  "addPassword",
  "updatePassword",
  "deletePassword",
  "getFormFillSuggestions",
  "addFormFillValue",
  "updateFormFillValue",
  "deleteFormFillValue",
  "clearFormFillValues",
  "applyCookieMutations",
  "getCookieSnapshot",
  "getCookiesForOrigin",
  "clearCookiesForOrigin",
  "clearAllCookies",
  "endBrowserSession",
  "listDownloads",
  "listDownloadRecords",
  "upsertDownloadRecord",
  "pauseDownload",
  "resumeDownload",
  "cancelDownload",
  "openDownload",
  "revealDownload",
  "exportBookmarks",
  "exportPasswords",
  "exportCookies",
  "addBookmark",
  "updateBookmark",
  "deleteBookmark",
  "moveBookmark",
  "getHistory",
  "deleteHistoryEntry",
  "deleteHistoryRange",
  "clearAllHistory",
  "recordHistoryVisit",
  "updateHistoryTitle",
  "setDefaultEngine",
  "putPageFavicon",
]);

const DANGEROUS_METHODS = new Set([
  "getPasswords",
  "getPasswordForSite",
  "getCookieSnapshot",
  "getCookiesForOrigin",
  "clearCookiesForOrigin",
  "clearAllCookies",
  "endBrowserSession",
  "deletePassword",
  "clearFormFillValues",
  "clearAllHistory",
  "exportPasswords",
  "exportCookies",
]);

const METHOD_LABELS: Record<string, string> = {
  listImportHosts: "Find devices with browser data",
  listImportSources: "Inspect installed browsers",
  previewImport: "Review browser data to import",
  startImport: "Import browser data",
  cancelImport: "Cancel browser import",
  resumeImport: "Resume browser import",
  listOpenTabs: "Inspect open browser tabs",
  openTabsAsPanels: "Open imported browser tabs",
  getPasswords: "Read saved passwords",
  getPasswordForSite: "Fill a saved password",
  getFormFillSuggestions: "Read saved form-fill values",
  getCookieSnapshot: "Read browser cookies",
  getCookiesForOrigin: "Read site cookies",
  clearCookiesForOrigin: "Clear site data",
  clearAllCookies: "Clear all browser cookies",
  endBrowserSession: "End the browser session",
  listDownloads: "Review browser downloads",
  listDownloadRecords: "Read canonical browser download metadata",
  upsertDownloadRecord: "Record canonical browser download metadata",
  exportBookmarks: "Export bookmarks",
  exportPasswords: "Export passwords",
  exportCookies: "Export cookies",
};

/** Public API surface of this extension. */
export type Api = Awaited<ReturnType<typeof activate>>;

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("browser-data extension activating");
  ctx.health?.healthy({ summary: "Browser environment ready" });

  const resolvedStores = new Map<
    string,
    Promise<{ identity: BrowserEnvironmentIdentity; targetId: string }>
  >();
  const targetByEnvironment = new Map<string, string>();
  const unregisterServerHosts = new Map<string, () => void>();
  const desktopHosts = new Map<
    string,
    { hostId: string; unregister: () => void }
  >();
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
      throw Object.assign(
        new Error("Browser data requires a verified user and workspace"),
        { code: "ENOCALLER" }
      );
    }
    const cacheKey = `${workspaceId}\x00${userId}`;
    let pending = resolvedStores.get(cacheKey);
    if (!pending) {
      pending = ctx.workers
        .resolveDurableObject(DO_SOURCE, DO_CLASS, DO_RESOLUTION_SENTINEL)
        .then((target) => {
          const environmentKey =
            target.objectKey ?? target.targetId.split(":").at(-1) ?? "";
          if (!environmentKey || environmentKey === DO_RESOLUTION_SENTINEL) {
            throw new Error("Server did not derive a browser environment key");
          }
          const identity = {
            workspaceId,
            ownerUserId: userId,
            environmentKey,
          };
          targetByEnvironment.set(environmentKey, target.targetId);
          return { identity, targetId: target.targetId };
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
    return ctx.rpc.call<T>(targetId, method, ...args);
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
      const remoteProvider = new RemoteBrowserImportProvider(
        (method, ...args) =>
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

  const requireApproval = async (method: string): Promise<void> => {
    const caller = ctx.invocation.current()?.caller;
    if (caller && TRUSTED_CALLER_KINDS.has(caller.callerKind)) return;
    if (!caller || caller.callerKind === "http") {
      throw Object.assign(
        new Error(`browser-data.${method} requires an interactive caller`),
        { code: "ENOCALLER" }
      );
    }
    const label = METHOD_LABELS[method] ?? humanizeMethod(method);
    const dangerous = DANGEROUS_METHODS.has(method);
    const choice = await ctx.approvals.request({
      subject: { id: `browser-data:${method}`, label },
      title: `${label}?`,
      summary: `${caller.callerTitle ?? caller.callerKind} wants to ${label.toLowerCase()}.`,
      ...(dangerous
        ? { warning: "This action reads or changes personal browser data." }
        : {}),
      details: [{ label: "Requested by", value: caller.callerTitle ?? caller.callerKind }],
      severity: dangerous ? "dangerous" : "standard",
      defaultAction: "deny",
      promptOptions: "scoped",
    });
    if (choice.kind === "uncallable") {
      throw Object.assign(new Error(`browser-data.${method} requires an interactive caller`), {
        code: "ENOCALLER",
      });
    }
    if (choice.kind === "dismissed" || choice.choice === "deny") {
      throw Object.assign(new Error(`browser-data.${method} denied by user`), {
        code: "EACCES",
      });
    }
  };

  const guarded =
    <Args extends unknown[], Result>(
      method: string,
      fn: (...args: Args) => Promise<Result>
    ) =>
    async (...args: Args): Promise<Result> => {
      if (GATED_METHODS.has(method)) await requireApproval(method);
      return fn(...args);
    };

  const callStore = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    const { targetId } = await currentIdentity();
    return ctx.rpc.call<T>(targetId, method, ...args);
  };
  const mutate = async <T>(
    dataType: string,
    method: string,
    ...args: unknown[]
  ): Promise<T> => {
    const result = await callStore<T>(method, ...args);
    ctx.emit("data-changed", { dataType });
    return result;
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
    listOpenTabs: guarded(
      "listOpenTabs",
      async (request: { hostId: string; sourceId: string }) => {
        const { identity } = await currentIdentity();
        await ensureImportHosts(identity);
        return coordinator.listOpenTabs(
          identity,
          request.hostId,
          request.sourceId,
          ctx.invocation.signal?.() ?? undefined
        );
      }
    ),
    openTabsAsPanels: guarded(
      "openTabsAsPanels",
      async (request: { hostId: string; sourceId: string; selection: string[] }) => {
        const { identity } = await currentIdentity();
        await ensureImportHosts(identity);
        const tabs = await coordinator.listOpenTabs(
          identity,
          request.hostId,
          request.sourceId,
          ctx.invocation.signal?.() ?? undefined
        );
        return openTabsAsPanels(
          request.selection.length > 0
            ? tabs.filter((tab) => request.selection.includes(tab.tabId))
            : tabs,
          ctx
        );
      }
    ),
    getSitePreferences: guarded("getSitePreferences", async (origin: string) =>
      callStore("getSitePreferences", origin)
    ),
    setSiteZoom: guarded("setSiteZoom", async (origin: string, zoomFactor: number) =>
      mutate("sitePreferences", "setSiteZoom", origin, zoomFactor)
    ),

    getBookmarks: guarded("getBookmarks", async (folderPath?: string) =>
      callStore("getBookmarks", folderPath ?? "/")
    ),
    addBookmark: guarded("addBookmark", async (bookmark: unknown) =>
      mutate("bookmarks", "addBookmark", bookmark)
    ),
    updateBookmark: guarded("updateBookmark", async (id: number, partial: unknown) =>
      mutate("bookmarks", "updateBookmark", id, partial)
    ),
    deleteBookmark: guarded("deleteBookmark", async (id: number) =>
      mutate("bookmarks", "deleteBookmark", id)
    ),
    moveBookmark: guarded(
      "moveBookmark",
      async (id: number, folderPath: string, position: number) =>
        mutate("bookmarks", "moveBookmark", id, folderPath, position)
    ),
    searchBookmarks: guarded("searchBookmarks", async (query: string) =>
      callStore("searchBookmarks", query)
    ),

    getHistory: guarded("getHistory", async (query: unknown) => callStore("getHistory", query)),
    deleteHistoryEntry: guarded("deleteHistoryEntry", async (id: number) =>
      mutate("history", "deleteHistoryEntry", id)
    ),
    deleteHistoryRange: guarded("deleteHistoryRange", async (start: number, end: number) =>
      mutate("history", "deleteHistoryRange", start, end)
    ),
    clearAllHistory: guarded("clearAllHistory", async () =>
      mutate("history", "clearAllHistory")
    ),
    searchHistory: guarded("searchHistory", async (query: string, limit?: number) =>
      callStore("searchHistory", query, limit)
    ),
    searchHistoryForAutocomplete: guarded(
      "searchHistoryForAutocomplete",
      async (query: unknown) => callStore("searchHistoryForAutocomplete", query)
    ),
    recordHistoryVisit: guarded(
      "recordHistoryVisit",
      async (request: RecordHistoryVisitRequest) =>
        mutate("history", "recordHistoryVisit", validateHistoryVisit(request))
    ),
    updateHistoryTitle: guarded(
      "updateHistoryTitle",
      async (request: UpdateHistoryTitleRequest) =>
        mutate("history", "updateHistoryTitle", validateHistoryTitle(request))
    ),

    getPasswords: guarded("getPasswords", async () => callStore("getPasswords")),
    getPasswordForSite: guarded("getPasswordForSite", async (url: string) =>
      callStore("getPasswordForSite", url)
    ),
    addPassword: guarded("addPassword", async (password: unknown) =>
      mutate("passwords", "addPassword", password)
    ),
    updatePassword: guarded("updatePassword", async (id: number, partial: unknown) =>
      mutate("passwords", "updatePassword", id, partial)
    ),
    deletePassword: guarded("deletePassword", async (id: number) =>
      mutate("passwords", "deletePassword", id)
    ),
    updatePasswordLastUsed: guarded("updatePasswordLastUsed", async (id: number) =>
      mutate("passwords", "updateLastUsed", id)
    ),
    addNeverSavePassword: guarded("addNeverSavePassword", async (origin: string) =>
      mutate("passwords", "addNeverSave", origin)
    ),
    isNeverSavePassword: guarded("isNeverSavePassword", async (origin: string) =>
      callStore("isNeverSave", origin)
    ),
    getNeverSavePasswordOrigins: guarded("getNeverSavePasswordOrigins", async () =>
      callStore("getNeverSaveOrigins")
    ),
    removeNeverSavePassword: guarded("removeNeverSavePassword", async (origin: string) =>
      mutate("passwords", "removeNeverSave", origin)
    ),

    getFormFillSuggestions: guarded(
      "getFormFillSuggestions",
      async (query: unknown) => callStore("getFormFillSuggestions", query)
    ),
    addFormFillValue: guarded("addFormFillValue", async (value: FormFillValueInput) =>
      mutate("formFill", "addFormFillValue", value)
    ),
    updateFormFillValue: guarded(
      "updateFormFillValue",
      async (id: number, partial: unknown) =>
        mutate("formFill", "updateFormFillValue", id, partial)
    ),
    markFormFillValueUsed: guarded("markFormFillValueUsed", async (id: number) =>
      mutate("formFill", "markFormFillValueUsed", id)
    ),
    deleteFormFillValue: guarded("deleteFormFillValue", async (id: number) =>
      mutate("formFill", "deleteFormFillValue", id)
    ),
    clearFormFillValues: guarded("clearFormFillValues", async () =>
      mutate("formFill", "clearFormFillValues")
    ),

    getSearchEngines: guarded("getSearchEngines", async () => callStore("getSearchEngines")),
    setDefaultEngine: guarded("setDefaultEngine", async (id: number) =>
      mutate("searchEngines", "setDefaultEngine", id)
    ),

    applyCookieMutations: guarded("applyCookieMutations", async (request: unknown) =>
      mutate("cookies", "applyCookieMutations", request)
    ),
    getCookieSnapshot: guarded("getCookieSnapshot", async (query?: unknown) =>
      callStore("getCookieSnapshot", query ?? {})
    ),
    getCookiesForOrigin: guarded("getCookiesForOrigin", async (origin: string) =>
      callStore("getCookiesForOrigin", origin)
    ),
    clearCookiesForOrigin: guarded("clearCookiesForOrigin", async (origin: string) =>
      mutate("cookies", "clearCookiesForOrigin", origin)
    ),
    clearAllCookies: guarded("clearAllCookies", async () =>
      mutate("cookies", "clearAllCookies")
    ),
    endBrowserSession: guarded("endBrowserSession", async () =>
      mutate("cookies", "endBrowserSession")
    ),
    getCookieSiteSummary: guarded("getCookieSiteSummary", async (origin: string) =>
      callStore("getCookieSiteSummary", origin)
    ),
    flushCookieProjection: guarded("flushCookieProjection", async (origins?: string[]) =>
      ctx.rpc.call("main", "browserEnvironment.flushCookieProjection", origins ?? [])
    ),
    getCookieProjectionDiagnostics: guarded("getCookieProjectionDiagnostics", async () =>
      ctx.rpc.call("main", "browserEnvironment.getCookieProjectionDiagnostics")
    ),
    listDownloads: guarded("listDownloads", async () =>
      ctx.rpc.call("main", "browserEnvironment.listDownloads")
    ),
    listDownloadRecords: guarded("listDownloadRecords", async (hostId: string) => {
      const caller = ctx.invocation.current()?.caller;
      if (!caller || !TRUSTED_CALLER_KINDS.has(caller.callerKind)) {
        throw new Error("Canonical download metadata is host-only");
      }
      const { identity } = await currentIdentity();
      const rows = await callStoreForIdentity<Array<Record<string, unknown>>>(
        identity,
        "listDownloadRecords",
        hostId
      );
      return rows.map((row) => ({ ...row, environmentKey: identity.environmentKey }));
    }),
    upsertDownloadRecord: guarded("upsertDownloadRecord", async (record: unknown) => {
      const caller = ctx.invocation.current()?.caller;
      if (!caller || !TRUSTED_CALLER_KINDS.has(caller.callerKind)) {
        throw new Error("Canonical download metadata is host-only");
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new Error("Download metadata must be an object");
      }
      const { identity } = await currentIdentity();
      await callStoreForIdentity(identity, "upsertDownloadRecord", {
        ...(record as Record<string, unknown>),
        environmentKey: identity.environmentKey,
      });
    }),
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

    putPageFavicon: guarded("putPageFavicon", async (favicon: PageFavicon) =>
      mutate("favicons", "putPageFavicon", favicon)
    ),
    getPageFavicon: guarded("getPageFavicon", async (pageUrl: string) =>
      callStore("getPageFavicon", pageUrl)
    ),

    exportBookmarks: guarded(
      "exportBookmarks",
      async (format: "html" | "json" | "chrome-json") =>
        exportBookmarks(
          format,
          await callStore<Array<Record<string, unknown>>>("getAllBookmarks")
        )
    ),
    exportPasswords: guarded(
      "exportPasswords",
      async (format: "csv-chrome" | "csv-firefox" | "json") =>
        exportPasswords(
          format,
          await callStore<Array<Record<string, unknown>>>("getPasswords")
        )
    ),
    exportCookies: guarded(
      "exportCookies",
      async (format: "json" | "netscape-txt") => {
        const snapshot = await callStore<{
          cookies: Array<Record<string, unknown>>;
        }>("getCookieSnapshot", {});
        return exportCookies(format, snapshot.cookies);
      }
    ),
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

async function openTabsAsPanels(
  tabs: Array<{ url: string; title?: string }>,
  ctx: ExtensionContextLike
) {
  const parentId = parentPanelIdFromInvocation(ctx.invocation.current());
  const panels: Array<{ id: string; title: string; url: string }> = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  for (const tab of tabs) {
    if (!/^https?:\/\//i.test(tab.url)) {
      skipped.push({ url: tab.url, reason: "unsupported browser-panel URL scheme" });
      continue;
    }
    try {
      const created = await ctx.rpc.call<{ id: string; title: string }>(
        "main",
        "panelTree.create",
        tab.url,
        {
          ...(parentId ? { parentId } : {}),
          name: (tab.title?.trim() || hostnameFromUrl(tab.url) || "Imported Tab").slice(0, 80),
          focus: false,
        }
      );
      panels.push({ id: created.id, title: created.title, url: tab.url });
    } catch (error) {
      skipped.push({
        url: tab.url,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    tabsFound: tabs.length,
    panelsOpened: panels.length,
    panels,
    skipped,
  };
}

function parentPanelIdFromInvocation(
  invocation: ReturnType<InvocationLike["current"]>
): string | undefined {
  const caller = invocation?.chainCaller ?? invocation?.caller;
  return caller &&
    ["panel", "app", "worker", "do"].includes(caller.callerKind) &&
    caller.callerId
    ? caller.callerId
    : undefined;
}

function validateHistoryVisit(request: RecordHistoryVisitRequest): RecordHistoryVisitRequest {
  validateHttpUrl(request.url);
  return {
    ...request,
    title: request.title?.trim() || undefined,
    visitTime: request.visitTime ?? Date.now(),
    transition: request.transition ?? "link",
    typed: request.typed === true,
    source: request.source ?? "vibestudio",
    panelId: request.panelId?.trim() || undefined,
  };
}

function validateHistoryTitle(request: UpdateHistoryTitleRequest): UpdateHistoryTitleRequest {
  validateHttpUrl(request.url);
  return {
    url: request.url,
    title: request.title.trim(),
    observedAt: request.observedAt ?? Date.now(),
  };
}

function validateHttpUrl(raw: string): void {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser history URL must use http or https");
  }
}

function exportBookmarks(
  format: "html" | "json" | "chrome-json",
  rows: Array<Record<string, unknown>>
): string {
  const bookmarks: ImportedBookmark[] = rows.map((row) => ({
    title: String(row["title"] ?? ""),
    url: String(row["url"] ?? ""),
    dateAdded: Number(row["date_added"] ?? Date.now()),
    folder: String(row["folder_path"] ?? "/").split("/").filter(Boolean),
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
  const cookies: ImportedCookie[] = rows.map((row) => ({
    name: String(row["name"] ?? ""),
    value: String(row["value"] ?? ""),
    domain: String(row["domain"] ?? ""),
    hostOnly: Boolean(row["hostOnly"]),
    path: String(row["path"] ?? "/"),
    expirationDate:
      row["expirationDate"] == null ? undefined : Number(row["expirationDate"]),
    secure: Boolean(row["secure"]),
    httpOnly: Boolean(row["httpOnly"]),
    sameSite: String(row["sameSite"] ?? "unspecified") as ImportedCookie["sameSite"],
    sourceScheme: String(row["sourceScheme"] ?? "unset") as ImportedCookie["sourceScheme"],
    sourcePort: Number(row["sourcePort"] ?? -1),
  }));
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
  return process.platform === "darwin" || process.platform === "win32"
    ? process.platform
    : "linux";
}

function hostnameFromUrl(raw: string): string | null {
  try {
    return new URL(raw).hostname || null;
  } catch {
    return null;
  }
}

function humanizeMethod(method: string): string {
  return method.replace(/([a-z])([A-Z])/g, "$1 $2").toLocaleLowerCase();
}
