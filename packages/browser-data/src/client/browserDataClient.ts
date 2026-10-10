import type { browserProductMethods } from "@vibestudio/service-schemas/browserData";
import type { TypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import {
  createReceiverRpcMethods,
  createRpcMethodCaller,
  type RpcMethodArgs,
} from "@vibestudio/shared/rpcMethods";
import { schemaRpcCaller } from "@vibestudio/rpc/internal";
import type { browserEnvironmentMethods } from "@vibestudio/service-schemas/browserEnvironment";
import { callTypedServiceMethod, type MethodFn } from "@vibestudio/shared/typedServiceClient";
import type { BrowserAddressSuggestion } from "@vibestudio/shared/webSearch";
import type { WebSearchEngineInput } from "@vibestudio/shared/webSearch";
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
  ImportJobObservation,
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
  callService(
    service: string,
    method: string,
    args: unknown[],
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
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
  state: "running" | "applying" | "application_failed" | "complete" | "cancelled" | "failed";
  counts: SensitiveBrowserImportCount[];
  error?: string;
  /** Opaque status version; pass it back as `afterVersion` to await the next change. */
  version: string;
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
  getBrowserEnvironment(signal?: AbortSignal): Promise<BrowserEnvironmentIdentity>;
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
  startImport(
    selection: NonSensitiveBrowserImportSelection,
    operationId: string
  ): Promise<ImportJobSnapshot>;
  startSensitiveImport(
    request: SensitiveBrowserImportRequest
  ): Promise<SensitiveBrowserImportStatus>;
  /**
   * Read aggregate status. With `afterVersion`, a running or applying import
   * resolves on its next status change instead of returning the same version.
   */
  observeSensitiveImport(
    operationId: string,
    options?: { afterVersion?: string; signal?: AbortSignal }
  ): Promise<SensitiveBrowserImportStatus>;
  cancelSensitiveImport(operationId: string): Promise<SensitiveBrowserImportStatus>;
  openBrowserPrivacyManager(section?: BrowserPrivacySection): Promise<void>;
  cancelImport(jobId: string): Promise<void>;
  getImportJob(jobId: string): Promise<ImportJobSnapshot | null>;
  /** Wait for the next published snapshot; cancellation releases only observation. */
  observeImportJob(
    jobId: string,
    options?: { afterVersion?: string; signal?: AbortSignal }
  ): Promise<ImportJobObservation>;
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
  saveSearchEngine(engine: WebSearchEngineInput & { id?: number }): Promise<number>;
  getSearchSuggestions(query: string): Promise<BrowserAddressSuggestion[]>;

  listDownloads(): Promise<BrowserDownloadRecord[]>;
  listDownloadRecords(hostId: string, signal?: AbortSignal): Promise<BrowserDownloadRecord[]>;
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

/** Shared provider contract. The installed receiver must satisfy this surface. */
type ProductProviderMethods = Pick<
  TypedServiceClient<typeof browserProductMethods>,
  Extract<keyof BrowserDataClient, keyof typeof browserProductMethods>
>;
export type BrowserDataProvider = ProductProviderMethods &
  Omit<
    BrowserDataClient,
    | keyof ProductProviderMethods
    | "listDownloads"
    | "pauseDownload"
    | "resumeDownload"
    | "cancelDownload"
    | "openDownload"
    | "revealDownload"
    | "getBrowserEnvironment"
    | "observeImportJob"
    | "observeSensitiveImport"
    | "listDownloadRecords"
    | "listOpenTabs"
    | "searchHistoryForAutocomplete"
  > & {
    resumeImport(jobId: string): Promise<ImportJobSnapshot>;
    listOpenTabs(request: { hostId: string; sourceId: string }): Promise<ImportedBrowserOpenTab[]>;
    searchHistoryForAutocomplete(request: {
      query: string;
      limit?: number;
    }): Promise<StoredHistory[]>;
    getBrowserEnvironment(): Promise<BrowserEnvironmentIdentity>;
    observeSensitiveImport(
      operationId: string,
      options?: { afterVersion?: string }
    ): Promise<SensitiveBrowserImportStatus>;
    observeImportJob(
      jobId: string,
      options?: { afterVersion?: string }
    ): Promise<ImportJobObservation>;
    listDownloadRecords(hostId: string): Promise<BrowserDownloadRecord[]>;
  };
export const browserDataProviderRpcMethods = createReceiverRpcMethods<BrowserDataProvider>([
  "resumeImport",
  "getBrowserEnvironment",
  "listImportHosts",
  "listImportAcquisitionOptions",
  "beginImportAcquisition",
  "releaseImportSource",
  "listImportSources",
  "previewImport",
  "previewSensitiveImport",
  "startImport",
  "startSensitiveImport",
  "observeSensitiveImport",
  "cancelSensitiveImport",
  "openBrowserPrivacyManager",
  "cancelImport",
  "getImportJob",
  "observeImportJob",
  "listImportJobs",
  "listOpenTabs",
  "openTabsAsPanels",
  "getSitePreferences",
  "setSiteZoom",
  "getBookmarks",
  "addBookmark",
  "updateBookmark",
  "deleteBookmark",
  "moveBookmark",
  "searchBookmarks",
  "getHistory",
  "deleteHistoryEntry",
  "deleteHistoryRange",
  "clearAllHistory",
  "searchHistory",
  "searchHistoryForAutocomplete",
  "recordHistoryVisit",
  "updateHistoryTitle",
  "getSearchEngines",
  "setDefaultEngine",
  "saveSearchEngine",
  "getSearchSuggestions",
  "listDownloadRecords",
  "upsertDownloadRecord",
  "putPageFavicon",
  "getPageFavicon",
  "exportBookmarks",
]);

/** Canonical client for the manifest-declared browser environment provider. */
export function createBrowserDataClient(rpc: BrowserDataRpc): BrowserDataClient {
  const providerRpc = schemaRpcCaller({
    call: (_target, method, args, options) =>
      options?.signal
        ? rpc.callService("extensions", "invokeProvider", ["browserData", method, args], {
            signal: options.signal,
          })
        : rpc.callService("extensions", "invokeProvider", ["browserData", method, args]),
    stream: async () => {
      throw new Error("Browser data provider does not expose response streams");
    },
  });
  const invoke = createRpcMethodCaller(providerRpc, "browserData", browserDataProviderRpcMethods);
  const callNative = <K extends keyof BrowserDataProvider & string>(
    method: K,
    ...args: RpcMethodArgs<(typeof browserDataProviderRpcMethods)[K]>
  ) => invoke(method, args);
  const callBrowserEnvironment = <K extends BrowserEnvironmentMethod>(
    method: K,
    ...args: Parameters<MethodFn<(typeof browserEnvironmentMethods)[K]>>
  ) =>
    import("@vibestudio/service-schemas/browserEnvironment").then(({ browserEnvironmentMethods }) =>
      callTypedServiceMethod(
        "browserEnvironment",
        browserEnvironmentMethods,
        rpc.callService.bind(rpc),
        method,
        args
      )
    );
  const callData = callNative;

  return {
    getBrowserEnvironment: (signal) => invoke("getBrowserEnvironment", [], { signal }),
    listImportHosts: () => callNative("listImportHosts"),
    listImportAcquisitionOptions: (hostId) => callNative("listImportAcquisitionOptions", hostId),
    beginImportAcquisition: (hostId, acquisitionId) =>
      callNative("beginImportAcquisition", hostId, acquisitionId),
    releaseImportSource: (hostId, sourceId) => callNative("releaseImportSource", hostId, sourceId),
    listImportSources: (hostId) => callNative("listImportSources", hostId),
    previewImport: (selection) => callNative("previewImport", selection),
    previewSensitiveImport: (request) => callNative("previewSensitiveImport", request),
    startImport: (selection, operationId) => callNative("startImport", selection, operationId),
    startSensitiveImport: (request) => callNative("startSensitiveImport", request),
    observeSensitiveImport: (operationId, options) =>
      invoke(
        "observeSensitiveImport",
        options?.afterVersion === undefined
          ? [operationId]
          : [operationId, { afterVersion: options.afterVersion }],
        { signal: options?.signal }
      ),
    cancelSensitiveImport: (operationId) => callNative("cancelSensitiveImport", operationId),
    openBrowserPrivacyManager: (section) => callNative("openBrowserPrivacyManager", section),
    cancelImport: (jobId) => callNative("cancelImport", jobId),
    getImportJob: (jobId) => callNative("getImportJob", jobId),
    observeImportJob: (jobId, options) =>
      invoke("observeImportJob", [jobId, { afterVersion: options?.afterVersion }], {
        signal: options?.signal,
      }),
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
    saveSearchEngine: (engine) => callData("saveSearchEngine", engine),
    getSearchSuggestions: (query) => callData("getSearchSuggestions", query),
    listDownloads: () => callBrowserEnvironment("listDownloads"),
    listDownloadRecords: (hostId, signal) => invoke("listDownloadRecords", [hostId], { signal }),
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
