import { extensionsMethods } from "@vibestudio/service-schemas/extensions";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type {
  BrowserName,
  BrowserOpenTabsRequest,
  DetectedBrowser,
  DetectedProfile,
  HistoryQuery,
  ImportedOpenTab,
  ImportedPassword,
  ImportDataType,
  ImportRequest,
  ImportResult,
  OpenTabsAsPanelsResult,
  RecordHistoryVisitRequest,
  UpdateHistoryTitleRequest,
} from "../types.js";
import type {
  StoredAutofill,
  StoredBookmark,
  StoredCookie,
  StoredHistory,
  StoredImportRunWithSummaries,
  StoredPassword,
  StoredPermission,
  StoredSearchEngine,
} from "../storage/types.js";

interface RpcLike {
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
}

export interface PreviewDiffSample {
  status: string;
  label: string;
  detail?: string;
}

export interface PreviewTypeResult {
  dataType: ImportDataType;
  scanned: number;
  added: number;
  changed: number;
  unchanged: number;
  skipped: number;
  samples: PreviewDiffSample[];
  warnings: string[];
  error?: string;
}

export type ImportRun = StoredImportRunWithSummaries;

export interface ProfileImportState {
  lastRun: ImportRun | null;
  runs: ImportRun[];
}

export interface CookieDomainSummary {
  domain: string;
  count: number;
  secure: number;
  httpOnly: number;
  sourceBrowser: string | null;
  earliest: number | null;
  latest: number | null;
}

export interface HistoryDomainSummary {
  domain: string;
  visits: number;
  typed: number;
  pages: number;
  lastVisit: number;
}

export interface PasswordOriginSummary {
  origin: string;
  count: number;
}

export interface AutofillFieldSummary {
  fieldName: string;
  count: number;
  timesUsed: number;
}

export interface DomainReadiness {
  domain: string;
  cookies: number;
  password: boolean;
  permissions: Array<{ permission: string; setting: string }>;
  recentHistoryCount: number;
  lastVisit: number | null;
}

export interface AutocompleteDebugSuggestion {
  url?: string;
  title?: string;
  keyword?: string;
  source: "history" | "bookmark" | "search-engine";
  score: number;
  reasons: string[];
}

export interface AutocompleteDebugResult {
  query: string;
  suggestions: AutocompleteDebugSuggestion[];
}

export interface BrowserDataClient {
  detectBrowsers(): Promise<DetectedBrowser[]>;
  getOpenTabs(request: BrowserOpenTabsRequest): Promise<ImportedOpenTab[]>;
  openTabsAsPanels(request: BrowserOpenTabsRequest): Promise<OpenTabsAsPanelsResult>;
  startImport(request: ImportRequest): Promise<ImportResult[]>;
  getImportHistory(): Promise<ImportRun[]>;
  getProfileImportState(query: {
    browser: BrowserName | string;
    profilePath?: string;
    profile?: DetectedProfile | string;
  }): Promise<ProfileImportState>;
  previewImport(request: ImportRequest): Promise<PreviewTypeResult[]>;
  getCookieDomains(): Promise<CookieDomainSummary[]>;
  getHistoryDomains(limit?: number): Promise<HistoryDomainSummary[]>;
  getPasswordOrigins(): Promise<PasswordOriginSummary[]>;
  getAutofillFieldNames(): Promise<AutofillFieldSummary[]>;
  getDomainReadiness(domain: string): Promise<DomainReadiness>;
  getAutocompleteDebug(query: string): Promise<AutocompleteDebugResult>;
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
  getAutofillSuggestions(fieldName: string, prefix?: string): Promise<StoredAutofill[]>;
  getSearchEngines(): Promise<StoredSearchEngine[]>;
  setDefaultEngine(id: number): Promise<void>;
  getPermissions(origin?: string): Promise<StoredPermission[]>;
  setPermission(
    origin: string,
    permission: string,
    setting: "allow" | "block" | "ask"
  ): Promise<void>;
  exportBookmarks(format: "html" | "json" | "chrome-json"): Promise<string>;
  exportPasswords(format: "csv-chrome" | "csv-firefox" | "json"): Promise<string>;
  exportCookies(format: "json" | "netscape-txt"): Promise<string>;
  exportAll(): Promise<string>;
  getCookies(domain?: string): Promise<StoredCookie[]>;
  deleteCookie(id: number): Promise<void>;
  clearCookies(domain?: string): Promise<number>;
}

/** Complete, canonical client for the manifest-declared browserData provider. */
export function createBrowserDataClient(rpc: RpcLike): BrowserDataClient {
  const extensions = createTypedServiceClient(
    "extensions",
    extensionsMethods,
    (service, method, args) => rpc.call(service, method, args)
  );
  const call = <T>(method: string, ...args: unknown[]): Promise<T> =>
    extensions.invokeProvider("browserData", method, args) as Promise<T>;

  return {
    detectBrowsers: () => call("detectBrowsers"),
    getOpenTabs: (request) => call("getOpenTabs", request),
    openTabsAsPanels: (request) => call("openTabsAsPanels", request),
    startImport: (request) => call("startImport", request),
    getImportHistory: () => call("getImportHistory"),
    getProfileImportState: (query) => call("getProfileImportState", query),
    previewImport: (request) => call("previewImport", request),
    getCookieDomains: () => call("getCookieDomains"),
    getHistoryDomains: (limit) => call("getHistoryDomains", limit),
    getPasswordOrigins: () => call("getPasswordOrigins"),
    getAutofillFieldNames: () => call("getAutofillFieldNames"),
    getDomainReadiness: (domain) => call("getDomainReadiness", domain),
    getAutocompleteDebug: (query) => call("getAutocompleteDebug", query),
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
    getAutofillSuggestions: (fieldName, prefix) =>
      call("getAutofillSuggestions", fieldName, prefix),
    getSearchEngines: () => call("getSearchEngines"),
    setDefaultEngine: (id) => call("setDefaultEngine", id),
    getPermissions: (origin) => call("getPermissions", origin),
    setPermission: (origin, permission, setting) =>
      call("setPermission", origin, permission, setting),
    exportBookmarks: (format) => call("exportBookmarks", format),
    exportPasswords: (format) => call("exportPasswords", format),
    exportCookies: (format) => call("exportCookies", format),
    exportAll: () => call("exportAll"),
    getCookies: (domain) => call("getCookies", domain),
    deleteCookie: (id) => call("deleteCookie", id),
    clearCookies: (domain) => call("clearCookies", domain),
  };
}
