import type { extensionsMethods } from "@vibestudio/service-schemas/extensions";
import type {
  BrowserEnvironmentIdentity,
  BrowserImportAcquisitionOption,
  BrowserImportAcquisitionResult,
  BrowserImportDataType,
  BrowserDownloadRecord,
  BrowserImportSelection,
  BrowserImportSource,
  ImportCategoryBreakdown,
  ImportCategoryProgress,
  ImportedBrowserOpenTab,
  ImportHostSummary,
  ImportJobSnapshot,
  PageFavicon,
} from "../environment.js";
import type {
  OpenTabsAsPanelsRequest,
  OpenTabsAsPanelsResult,
  RecordHistoryVisitRequest,
  UpdateHistoryTitleRequest,
} from "../types.js";
import type {
  StoredBookmark,
  StoredHistory,
  StoredPageFavicon,
  StoredSearchEngine,
} from "../storage/types.js";
import type { HistoryQuery } from "../types.js";

interface BrowserDataRpc {
  callService(service: string, method: string, args: unknown[]): Promise<unknown>;
}

type BrowserEnvironmentMethod =
  | "listDownloads"
  | "pauseDownload"
  | "resumeDownload"
  | "cancelDownload"
  | "openDownload"
  | "revealDownload";

export interface ImportPreview {
  job: ImportJobSnapshot;
  /** Per-category aggregates backing the review step's drill-down. */
  breakdowns: ImportCategoryBreakdown[];
  openTabCount: number;
  localDataSetCount: number;
}

export type NonSensitiveBrowserImportDataType = Exclude<
  BrowserImportDataType,
  "cookies" | "passwords" | "formFill"
>;
export type NonSensitiveBrowserImportSelection = Omit<BrowserImportSelection, "dataTypes"> & {
  dataTypes: NonSensitiveBrowserImportDataType[];
};
export type SensitiveBrowserImportDataType = Extract<
  BrowserImportDataType,
  "cookies" | "passwords" | "formFill"
>;
export interface SensitiveBrowserImportSelection {
  hostId: string;
  sourceId: string;
  dataTypes: SensitiveBrowserImportDataType[];
}
export interface SensitiveBrowserImportRequest extends SensitiveBrowserImportSelection {
  operationId: string;
}
export interface SensitiveBrowserImportCount {
  dataType: SensitiveBrowserImportDataType;
  read: number;
  stored: number;
  skipped: number;
  errors: number;
}
export interface SensitiveBrowserImportStatus {
  operationId: string;
  state: "running" | "complete" | "cancelled" | "failed";
  counts: SensitiveBrowserImportCount[];
  error?: string;
}
export interface SensitiveBrowserImportPreview {
  dataTypes: ImportCategoryProgress[];
  warnings: string[];
  breakdowns: ImportCategoryBreakdown[];
  openTabCount: number;
  localDataSetCount: number;
}
export type BrowserPrivacySection = "credentials" | "formFill" | "inspect" | "debug" | "export";

export interface BrowserDataClient {
  getBrowserEnvironment(): Promise<BrowserEnvironmentIdentity>;
  listImportHosts(): Promise<ImportHostSummary[]>;
  listImportAcquisitionOptions(hostId: string): Promise<BrowserImportAcquisitionOption[]>;
  beginImportAcquisition(
    hostId: string,
    acquisitionId: string
  ): Promise<BrowserImportAcquisitionResult>;
  releaseImportSource(hostId: string, sourceId: string): Promise<void>;
  listImportSources(hostId: string): Promise<BrowserImportSource[]>;
  previewImport(selection: NonSensitiveBrowserImportSelection): Promise<ImportPreview>;
  previewSensitiveImport(
    request: SensitiveBrowserImportSelection
  ): Promise<SensitiveBrowserImportPreview>;
  startImport(selection: NonSensitiveBrowserImportSelection): Promise<ImportJobSnapshot>;
  startSensitiveImport(
    request: SensitiveBrowserImportRequest
  ): Promise<SensitiveBrowserImportStatus>;
  observeSensitiveImport(operationId: string): Promise<SensitiveBrowserImportStatus>;
  cancelSensitiveImport(operationId: string): Promise<SensitiveBrowserImportStatus>;
  openBrowserPrivacyManager(section?: BrowserPrivacySection): Promise<void>;
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

  getSearchEngines(): Promise<StoredSearchEngine[]>;
  setDefaultEngine(id: number): Promise<void>;

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
}

/** Canonical client for the manifest-declared browser environment provider. */
export function createBrowserDataClient(rpc: BrowserDataRpc): BrowserDataClient {
  const callExtension = async <T>(
    method: keyof typeof extensionsMethods & string,
    ...args: unknown[]
  ): Promise<T> => {
    const { callTypedServiceMethod } = await import("@vibestudio/shared/typedServiceClient");
    return callTypedServiceMethod(
      "extensions",
      (await import("@vibestudio/service-schemas/extensions")).extensionsMethods,
      (service, wireMethod, wireArgs) => rpc.callService(service, wireMethod, wireArgs),
      method,
      args
    ) as Promise<T>;
  };
  const callNative = <T>(method: string, ...args: unknown[]): Promise<T> =>
    callExtension("invokeProvider", "browserData", method, args);
  const callBrowserEnvironment = <T>(method: BrowserEnvironmentMethod, ...args: unknown[]) =>
    rpc.callService("browserEnvironment", method, args) as Promise<T>;
  // Workspace-visible browser product records stay on the installed provider.
  // Protected records deliberately have no client methods here: their sealed
  // import and no-data-return manager handoff are separate provider intents.
  const callData = <T>(method: string, ...args: unknown[]): Promise<T> =>
    callNative(method, ...args);

  return {
    getBrowserEnvironment: () => callNative("getBrowserEnvironment"),
    listImportHosts: () => callNative("listImportHosts"),
    listImportAcquisitionOptions: (hostId) => callNative("listImportAcquisitionOptions", hostId),
    beginImportAcquisition: (hostId, acquisitionId) =>
      callNative("beginImportAcquisition", hostId, acquisitionId),
    releaseImportSource: (hostId, sourceId) => callNative("releaseImportSource", hostId, sourceId),
    listImportSources: (hostId) => callNative("listImportSources", hostId),
    previewImport: (selection) => callNative("previewImport", selection),
    previewSensitiveImport: (request) => callNative("previewSensitiveImport", request),
    startImport: (selection) => callNative("startImport", selection),
    startSensitiveImport: (request) => callNative("startSensitiveImport", request),
    observeSensitiveImport: (operationId) => callNative("observeSensitiveImport", operationId),
    cancelSensitiveImport: (operationId) => callNative("cancelSensitiveImport", operationId),
    openBrowserPrivacyManager: (section) => callNative("openBrowserPrivacyManager", section),
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
    getSearchEngines: () => callData("getSearchEngines"),
    setDefaultEngine: (id) => callData("setDefaultEngine", id),
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
  };
}
