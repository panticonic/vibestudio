export {
  createBrowserDataClient,
  type BrowserDataClient,
  type BrowserPrivacySection,
  type NonSensitiveBrowserImportDataType,
  type NonSensitiveBrowserImportSelection,
  type SensitiveBrowserImportDataType,
  type SensitiveBrowserImportCount,
  type SensitiveBrowserImportRequest,
  type SensitiveBrowserImportPreview,
  type SensitiveBrowserImportSelection,
  type SensitiveBrowserImportStatus,
} from "./client/browserDataClient.js";
export type { ImportPreview } from "./client/browserDataClient.js";
export type {
  BrowserImportSelection,
  BrowserImportAcquisitionOption,
  BrowserImportAcquisitionResult,
  BrowserDownloadRecord,
  BrowserImportSource,
  ImportCategoryBreakdown,
  ImportCategoryBreakdownGroup,
  ImportedBrowserOpenTab,
  ImportHostSummary,
  ImportJobSnapshot,
  PageFavicon,
} from "./environment.js";
export type {
  OpenTabsAsPanelsRequest,
  OpenTabsPanelDestination,
  OpenTabsPanelGrouping,
  OpenTabsAsPanelsResult,
  RecordHistoryVisitRequest,
  UpdateHistoryTitleRequest,
} from "./types.js";
export type {
  StoredBookmark,
  StoredHistory,
  StoredPageFavicon,
  StoredSearchEngine,
} from "./storage/types.js";
