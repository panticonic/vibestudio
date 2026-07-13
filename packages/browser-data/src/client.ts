export { createBrowserDataClient } from "./client/browserDataClient.js";
export type {
  AutocompleteDebugResult,
  AutocompleteDebugSuggestion,
  AutofillFieldSummary,
  BrowserDataClient,
  CookieDomainSummary,
  DomainReadiness,
  HistoryDomainSummary,
  ImportRun,
  PasswordOriginSummary,
  PreviewDiffSample,
  PreviewTypeResult,
  ProfileImportState,
} from "./client/browserDataClient.js";
export type {
  BrowserName,
  BrowserOpenTabsRequest,
  DetectedBrowser,
  DetectedProfile,
  ImportedOpenTab,
  ImportDataType,
  ImportRequest,
  ImportResult,
  OpenTabsAsPanelsResult,
  RecordHistoryVisitRequest,
  UpdateHistoryTitleRequest,
} from "./types.js";
export type {
  StoredAutofill,
  StoredBookmark,
  StoredCookie,
  StoredHistory,
  StoredPassword,
  StoredPermission,
  StoredSearchEngine,
} from "./storage/types.js";
