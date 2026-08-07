import { extensionsMethods } from "@vibestudio/service-schemas/extensions";
import { browserDataMethods } from "@vibestudio/service-schemas/browserData";
import { browserEnvironmentMethods } from "@vibestudio/service-schemas/browserEnvironment";
import {
  callTypedServiceMethod,
  createTypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import type {
  ApplyCookieMutationsRequest,
  BrowserEnvironmentIdentity,
  BrowserDownloadRecord,
  BrowserImportSelection,
  BrowserImportSource,
  FormFillSuggestionQuery,
  FormFillValueInput,
  ImportCategoryBreakdown,
  ImportedBrowserOpenTab,
  ImportHostSummary,
  ImportJobSnapshot,
  PageFavicon,
} from "../environment.js";
import type {
  ImportedPassword,
  OpenTabsAsPanelsRequest,
  OpenTabsAsPanelsResult,
  RecordHistoryVisitRequest,
  UpdateHistoryTitleRequest,
} from "../types.js";
import type {
  StoredBookmark,
  StoredCookie,
  StoredFormFill,
  StoredHistory,
  StoredPageFavicon,
  StoredPassword,
  StoredSearchEngine,
} from "../storage/types.js";
import type { HistoryQuery } from "../types.js";

interface BrowserDataRpc {
  callService(service: string, method: string, args: unknown[]): Promise<unknown>;
  callTarget(targetId: string, method: string, args: unknown[]): Promise<unknown>;
}

export interface ImportPreview {
  job: ImportJobSnapshot;
  /** Per-category aggregates backing the review step's drill-down. */
  breakdowns: ImportCategoryBreakdown[];
  openTabCount: number;
  localDataSetCount: number;
}

export interface BrowserDataClient {
  getBrowserEnvironment(): Promise<BrowserEnvironmentIdentity>;
  listImportHosts(): Promise<ImportHostSummary[]>;
  listImportSources(hostId: string): Promise<BrowserImportSource[]>;
  previewImport(selection: BrowserImportSelection): Promise<ImportPreview>;
  startImport(selection: BrowserImportSelection): Promise<ImportJobSnapshot>;
  cancelImport(jobId: string): Promise<void>;
  getImportJob(jobId: string): Promise<ImportJobSnapshot | null>;
  listImportJobs(): Promise<ImportJobSnapshot[]>;
  listOpenTabs(hostId: string, sourceId: string): Promise<ImportedBrowserOpenTab[]>;
  openTabsAsPanels(request: OpenTabsAsPanelsRequest): Promise<OpenTabsAsPanelsResult>;
  getSitePreferences(
    origin: string
  ): Promise<{ origin: string; zoomFactor: number; updatedAt?: number }>;
  setSiteZoom(origin: string, zoomFactor: number): Promise<void>;

  getBookmarks(folderPath?: string): Promise<StoredBookmark[]>;
  addBookmark(bookmark: {
    title: string;
    url?: string;
    folderPath?: string;
    dateAdded?: number;
    tags?: string;
    keyword?: string;
    position?: number;
  }): Promise<number>;
  updateBookmark(
    id: number,
    partial: Partial<{
      title: string;
      url: string;
      folderPath: string;
      tags: string;
      keyword: string;
      position: number;
    }>
  ): Promise<void>;
  deleteBookmark(id: number): Promise<void>;
  moveBookmark(id: number, folderPath: string, position: number): Promise<void>;
  searchBookmarks(query: string): Promise<StoredBookmark[]>;

  getHistory(query: HistoryQuery): Promise<StoredHistory[]>;
  deleteHistoryEntry(id: number): Promise<void>;
  deleteHistoryRange(startTime: number, endTime: number): Promise<number>;
  clearAllHistory(): Promise<void>;
  searchHistory(query: string, limit?: number): Promise<StoredHistory[]>;
  searchHistoryForAutocomplete(query: string, limit?: number): Promise<StoredHistory[]>;
  recordHistoryVisit(request: RecordHistoryVisitRequest): Promise<number>;
  updateHistoryTitle(request: UpdateHistoryTitleRequest): Promise<void>;

  getPasswords(): Promise<StoredPassword[]>;
  getPasswordForSite(url: string): Promise<StoredPassword[]>;
  addPassword(password: {
    url: string;
    username: string;
    password: string;
    actionUrl?: string;
    realm?: string;
  }): Promise<number>;
  updatePassword(id: number, partial: Partial<ImportedPassword>): Promise<void>;
  deletePassword(id: number): Promise<void>;
  updatePasswordLastUsed(id: number): Promise<void>;
  addNeverSavePassword(origin: string): Promise<void>;
  isNeverSavePassword(origin: string): Promise<boolean>;
  getNeverSavePasswordOrigins(): Promise<string[]>;
  removeNeverSavePassword(origin: string): Promise<void>;

  getFormFillSuggestions(query: FormFillSuggestionQuery): Promise<StoredFormFill[]>;
  addFormFillValue(value: FormFillValueInput): Promise<number>;
  updateFormFillValue(
    id: number,
    partial: Partial<Pick<FormFillValueInput, "value" | "displayLabel" | "aliases">>
  ): Promise<void>;
  markFormFillValueUsed(id: number): Promise<void>;
  deleteFormFillValue(id: number): Promise<void>;
  clearFormFillValues(): Promise<number>;

  getSearchEngines(): Promise<StoredSearchEngine[]>;
  setDefaultEngine(id: number): Promise<void>;

  applyCookieMutations(request: ApplyCookieMutationsRequest): Promise<{ revision: number }>;
  getCookieSnapshot(query?: { sinceRevision?: number }): Promise<{
    revision: number;
    cookies: StoredCookie[];
  }>;
  getCookiesForOrigin(origin: string): Promise<StoredCookie[]>;
  clearCookiesForOrigin(origin: string): Promise<number>;
  clearAllCookies(): Promise<number>;
  endBrowserSession(): Promise<number>;
  getCookieSiteSummary(
    origin: string
  ): Promise<{ origin: string; cookieCount: number; revision: number }>;
  flushCookieProjection(origins?: string[]): Promise<{ revision: number }>;
  getCookieProjectionDiagnostics(): Promise<{
    revision: number;
    hostId: string;
    converged: boolean;
    mismatchCount: number;
    outboxDepth: number;
    lastError?: string;
  }>;
  listDownloads(): Promise<BrowserDownloadRecord[]>;
  listDownloadRecords(hostId: string): Promise<BrowserDownloadRecord[]>;
  upsertDownloadRecord(record: BrowserDownloadRecord): Promise<void>;
  pauseDownload(id: string): Promise<void>;
  resumeDownload(id: string): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  openDownload(id: string): Promise<void>;
  revealDownload(id: string): Promise<void>;

  putPageFavicon(favicon: PageFavicon): Promise<void>;
  getPageFavicon(pageUrl: string): Promise<StoredPageFavicon | null>;

  exportBookmarks(format: "html" | "json" | "chrome-json"): Promise<string>;
  exportPasswords(format: "csv-chrome" | "csv-firefox" | "json"): Promise<string>;
  exportCookies(format: "json" | "netscape-txt"): Promise<string>;
}

/** Canonical client for the manifest-declared browser environment provider. */
export function createBrowserDataClient(rpc: BrowserDataRpc): BrowserDataClient {
  const extensions = createTypedServiceClient(
    "extensions",
    extensionsMethods,
    (service, method, args) => rpc.callService(service, method, args)
  );
  const callNative = <T>(method: string, ...args: unknown[]): Promise<T> =>
    extensions.invokeProvider("browserData", method, args) as Promise<T>;
  const callBrowserEnvironment = <T>(
    method: keyof typeof browserEnvironmentMethods & string,
    ...args: unknown[]
  ) =>
    callTypedServiceMethod(
      "browserEnvironment",
      browserEnvironmentMethods,
      (service, wireMethod, wireArgs) => rpc.callService(service, wireMethod, wireArgs),
      method,
      args
    ) as Promise<T>;
  let resolvedTarget: Promise<string> | null = null;
  const target = (): Promise<string> => {
    resolvedTarget ??= rpc
      .callService("workers", "resolveService", ["vibestudio.browser-data.v1", null])
      .then((resolved) => {
        if (
          !resolved ||
          typeof resolved !== "object" ||
          (resolved as { kind?: unknown }).kind !== "durable-object" ||
          typeof (resolved as { targetId?: unknown }).targetId !== "string"
        ) {
          throw new Error("The browser.data builtin did not resolve to a Durable Object");
        }
        return (resolved as { targetId: string }).targetId;
      })
      .catch((error: unknown) => {
        resolvedTarget = null;
        throw error;
      });
    return resolvedTarget;
  };
  const callData = async <T>(
    method: keyof typeof browserDataMethods & string,
    ...args: unknown[]
  ) =>
    callTypedServiceMethod(
      "browser.data",
      browserDataMethods,
      async (_service, wireMethod, wireArgs) =>
        rpc.callTarget(await target(), wireMethod, wireArgs),
      method,
      args
    ) as Promise<T>;

  return {
    getBrowserEnvironment: () => callNative("getBrowserEnvironment"),
    listImportHosts: () => callNative("listImportHosts"),
    listImportSources: (hostId) => callNative("listImportSources", hostId),
    previewImport: (selection) => callNative("previewImport", selection),
    startImport: (selection) => callNative("startImport", selection),
    cancelImport: (jobId) => callNative("cancelImport", jobId),
    getImportJob: (jobId) => callNative("getImportJob", jobId),
    listImportJobs: () => callNative("listImportJobs"),
    listOpenTabs: (hostId, sourceId) => callNative("listOpenTabs", { hostId, sourceId }),
    openTabsAsPanels: (request) => callNative("openTabsAsPanels", request),
    getSitePreferences: (origin) => callData("getSitePreferences", origin),
    setSiteZoom: (origin, zoomFactor) => callData("setSiteZoom", origin, zoomFactor),
    getBookmarks: (folderPath) => callData("getBookmarks", folderPath),
    addBookmark: (bookmark) => callData("addBookmark", bookmark),
    updateBookmark: (id, partial) => callData("updateBookmark", id, partial),
    deleteBookmark: (id) => callData("deleteBookmark", id),
    moveBookmark: (id, folderPath, position) => callData("moveBookmark", id, folderPath, position),
    searchBookmarks: (query) => callData("searchBookmarks", query),
    getHistory: (query) => callData("getHistory", query),
    deleteHistoryEntry: (id) => callData("deleteHistoryEntry", id),
    deleteHistoryRange: (startTime, endTime) => callData("deleteHistoryRange", startTime, endTime),
    clearAllHistory: () => callData("clearAllHistory"),
    searchHistory: (query, limit) => callData("searchHistory", query, limit),
    searchHistoryForAutocomplete: (query, limit) =>
      callData("searchHistoryForAutocomplete", { query, limit }),
    recordHistoryVisit: (request) => callData("recordHistoryVisit", request),
    updateHistoryTitle: (request) => callData("updateHistoryTitle", request),
    getPasswords: () => callData("getPasswords"),
    getPasswordForSite: (url) => callData("getPasswordForSite", url),
    addPassword: (password) => callData("addPassword", password),
    updatePassword: (id, partial) => callData("updatePassword", id, partial),
    deletePassword: (id) => callData("deletePassword", id),
    updatePasswordLastUsed: (id) => callData("updateLastUsed", id),
    addNeverSavePassword: (origin) => callData("addNeverSave", origin),
    isNeverSavePassword: (origin) => callData("isNeverSave", origin),
    getNeverSavePasswordOrigins: () => callData("getNeverSaveOrigins"),
    removeNeverSavePassword: (origin) => callData("removeNeverSave", origin),
    getFormFillSuggestions: (query) => callData("getFormFillSuggestions", query),
    addFormFillValue: (value) => callData("addFormFillValue", value),
    updateFormFillValue: (id, partial) => callData("updateFormFillValue", id, partial),
    markFormFillValueUsed: (id) => callData("markFormFillValueUsed", id),
    deleteFormFillValue: (id) => callData("deleteFormFillValue", id),
    clearFormFillValues: () => callData("clearFormFillValues"),
    getSearchEngines: () => callData("getSearchEngines"),
    setDefaultEngine: (id) => callData("setDefaultEngine", id),
    applyCookieMutations: (request) => callData("applyCookieMutations", request),
    getCookieSnapshot: (query) => callData("getCookieSnapshot", query ?? {}),
    getCookiesForOrigin: (origin) => callData("getCookiesForOrigin", origin),
    clearCookiesForOrigin: (origin) => callData("clearCookiesForOrigin", origin),
    clearAllCookies: () => callData("clearAllCookies"),
    endBrowserSession: () => callData("endBrowserSession"),
    getCookieSiteSummary: (origin) => callData("getCookieSiteSummary", origin),
    flushCookieProjection: (origins) =>
      callBrowserEnvironment("flushCookieProjection", origins ?? []),
    getCookieProjectionDiagnostics: () => callBrowserEnvironment("getCookieProjectionDiagnostics"),
    listDownloads: () => callBrowserEnvironment("listDownloads"),
    listDownloadRecords: (hostId) => callData("listDownloadRecords", hostId),
    upsertDownloadRecord: (record) => callData("upsertDownloadRecord", record),
    pauseDownload: (id) => callBrowserEnvironment("pauseDownload", id),
    resumeDownload: (id) => callBrowserEnvironment("resumeDownload", id),
    cancelDownload: (id) => callBrowserEnvironment("cancelDownload", id),
    openDownload: (id) => callBrowserEnvironment("openDownload", id),
    revealDownload: (id) => callBrowserEnvironment("revealDownload", id),
    putPageFavicon: (favicon) => callData("putPageFavicon", favicon),
    getPageFavicon: (pageUrl) => callData("getPageFavicon", pageUrl),
    exportBookmarks: (format) => callNative("exportBookmarks", format),
    exportPasswords: (format) => callNative("exportPasswords", format),
    exportCookies: (format) => callNative("exportCookies", format),
  };
}
