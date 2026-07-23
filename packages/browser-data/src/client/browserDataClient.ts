import { extensionsMethods } from "@vibestudio/service-schemas/extensions";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type {
  ApplyCookieMutationsRequest,
  BrowserEnvironmentIdentity,
  BrowserDownloadRecord,
  BrowserImportSelection,
  BrowserImportSource,
  FormFillSuggestionQuery,
  FormFillValueInput,
  ImportedBrowserOpenTab,
  ImportHostSummary,
  ImportJobSnapshot,
  PageFavicon,
} from "../environment.js";
import type {
  ImportedPassword,
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

interface RpcLike {
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
}

export interface ImportPreview {
  job: ImportJobSnapshot;
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
  openTabsAsPanels(request: {
    hostId: string;
    sourceId: string;
    selection: string[];
  }): Promise<OpenTabsAsPanelsResult>;
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
export function createBrowserDataClient(rpc: RpcLike): BrowserDataClient {
  const extensions = createTypedServiceClient(
    "extensions",
    extensionsMethods,
    (service, method, args) => rpc.call(service, method, args)
  );
  const call = <T>(method: string, ...args: unknown[]): Promise<T> =>
    extensions.invokeProvider("browserData", method, args) as Promise<T>;

  return {
    getBrowserEnvironment: () => call("getBrowserEnvironment"),
    listImportHosts: () => call("listImportHosts"),
    listImportSources: (hostId) => call("listImportSources", hostId),
    previewImport: (selection) => call("previewImport", selection),
    startImport: (selection) => call("startImport", selection),
    cancelImport: (jobId) => call("cancelImport", jobId),
    getImportJob: (jobId) => call("getImportJob", jobId),
    listImportJobs: () => call("listImportJobs"),
    listOpenTabs: (hostId, sourceId) => call("listOpenTabs", { hostId, sourceId }),
    openTabsAsPanels: (request) => call("openTabsAsPanels", request),
    getSitePreferences: (origin) => call("getSitePreferences", origin),
    setSiteZoom: (origin, zoomFactor) => call("setSiteZoom", origin, zoomFactor),
    getBookmarks: (folderPath) => call("getBookmarks", folderPath),
    addBookmark: (bookmark) => call("addBookmark", bookmark),
    updateBookmark: (id, partial) => call("updateBookmark", id, partial),
    deleteBookmark: (id) => call("deleteBookmark", id),
    moveBookmark: (id, folderPath, position) => call("moveBookmark", id, folderPath, position),
    searchBookmarks: (query) => call("searchBookmarks", query),
    getHistory: (query) => call("getHistory", query),
    deleteHistoryEntry: (id) => call("deleteHistoryEntry", id),
    deleteHistoryRange: (startTime, endTime) => call("deleteHistoryRange", startTime, endTime),
    clearAllHistory: () => call("clearAllHistory"),
    searchHistory: (query, limit) => call("searchHistory", query, limit),
    searchHistoryForAutocomplete: (query, limit) =>
      call("searchHistoryForAutocomplete", { query, limit }),
    recordHistoryVisit: (request) => call("recordHistoryVisit", request),
    updateHistoryTitle: (request) => call("updateHistoryTitle", request),
    getPasswords: () => call("getPasswords"),
    getPasswordForSite: (url) => call("getPasswordForSite", url),
    addPassword: (password) => call("addPassword", password),
    updatePassword: (id, partial) => call("updatePassword", id, partial),
    deletePassword: (id) => call("deletePassword", id),
    updatePasswordLastUsed: (id) => call("updatePasswordLastUsed", id),
    addNeverSavePassword: (origin) => call("addNeverSavePassword", origin),
    isNeverSavePassword: (origin) => call("isNeverSavePassword", origin),
    getNeverSavePasswordOrigins: () => call("getNeverSavePasswordOrigins"),
    removeNeverSavePassword: (origin) => call("removeNeverSavePassword", origin),
    getFormFillSuggestions: (query) => call("getFormFillSuggestions", query),
    addFormFillValue: (value) => call("addFormFillValue", value),
    updateFormFillValue: (id, partial) => call("updateFormFillValue", id, partial),
    markFormFillValueUsed: (id) => call("markFormFillValueUsed", id),
    deleteFormFillValue: (id) => call("deleteFormFillValue", id),
    clearFormFillValues: () => call("clearFormFillValues"),
    getSearchEngines: () => call("getSearchEngines"),
    setDefaultEngine: (id) => call("setDefaultEngine", id),
    applyCookieMutations: (request) => call("applyCookieMutations", request),
    getCookieSnapshot: (query) => call("getCookieSnapshot", query ?? {}),
    getCookiesForOrigin: (origin) => call("getCookiesForOrigin", origin),
    clearCookiesForOrigin: (origin) => call("clearCookiesForOrigin", origin),
    clearAllCookies: () => call("clearAllCookies"),
    endBrowserSession: () => call("endBrowserSession"),
    getCookieSiteSummary: (origin) => call("getCookieSiteSummary", origin),
    flushCookieProjection: (origins) => call("flushCookieProjection", origins ?? []),
    getCookieProjectionDiagnostics: () => call("getCookieProjectionDiagnostics"),
    listDownloads: () => call("listDownloads"),
    listDownloadRecords: (hostId) => call("listDownloadRecords", hostId),
    upsertDownloadRecord: (record) => call("upsertDownloadRecord", record),
    pauseDownload: (id) => call("pauseDownload", id),
    resumeDownload: (id) => call("resumeDownload", id),
    cancelDownload: (id) => call("cancelDownload", id),
    openDownload: (id) => call("openDownload", id),
    revealDownload: (id) => call("revealDownload", id),
    putPageFavicon: (favicon) => call("putPageFavicon", favicon),
    getPageFavicon: (pageUrl) => call("getPageFavicon", pageUrl),
    exportBookmarks: (format) => call("exportBookmarks", format),
    exportPasswords: (format) => call("exportPasswords", format),
    exportCookies: (format) => call("exportCookies", format),
  };
}
