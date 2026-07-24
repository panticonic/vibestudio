const BROWSER_DATA_READ = new Set([
  "getAllBookmarks",
  "getBookmarks",
  "getCookieSiteSummary",
  "getCookieSnapshot",
  "getCookiesForOrigin",
  "getFormFillSuggestions",
  "getHistory",
  "getImportJob",
  "getNeverSaveOrigins",
  "getPageFavicon",
  "getPasswordForSite",
  "getPasswords",
  "getSearchEngines",
  "getSitePreferences",
  "isNeverSave",
  "listDownloadRecords",
  "listImportJobs",
  "searchBookmarks",
  "searchHistory",
  "searchHistoryForAutocomplete",
]);

const BROWSER_DATA_DELETE = new Set([
  "clearAllCookies",
  "clearAllHistory",
  "clearCookiesForOrigin",
  "clearFormFillValues",
  "deleteBookmark",
  "deleteFormFillValue",
  "deleteHistoryEntry",
  "deleteHistoryRange",
  "deletePassword",
  "endBrowserSession",
  "removeNeverSave",
]);

const WORKSPACE_GRAPH_DELETE = new Set([
  "deleteChannelInvite",
  "deleteChannelMembership",
  "deleteLogHead",
  "deleteRef",
  "purgeRevokedUserChannelIndexes",
]);

/**
 * Product-sealed direct receivers that are not workspace-service providers.
 * Workspace-built providers are resolved from their live service declaration
 * and exact build catalog instead of entering this static host census.
 */
export function productDirectMethodCapability(className: string, method: string): string | null {
  if (className === "BrowserDataDO") {
    if (BROWSER_DATA_READ.has(method)) return "browser-data.read";
    if (BROWSER_DATA_DELETE.has(method)) return "browser-data.delete";
    return "browser-data.write";
  }
  if (className === "EvalDO") return "runtime.code-execution.manage";
  if (className === "WorkspaceDO") return "workspace.runtime-state.manage";
  if (className === "WebhookStoreDO") return "webhooks.manage";
  if (className === "GadWorkspaceDO" && WORKSPACE_GRAPH_DELETE.has(method)) {
    return "workspace.graph.delete";
  }
  return null;
}
