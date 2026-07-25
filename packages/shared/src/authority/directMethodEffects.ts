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

const HOST_INTRINSIC_DO_METHODS = new Set(["durableWorkCapabilities"]);

/**
 * Framework protocol methods invoked only by the host. They are implemented
 * by the runtime base class rather than each workspace worker, so they do not
 * appear in a worker package's source-derived public RPC catalog.
 */
export function isHostIntrinsicDirectMethod(method: string): boolean {
  return HOST_INTRINSIC_DO_METHODS.has(method);
}

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
