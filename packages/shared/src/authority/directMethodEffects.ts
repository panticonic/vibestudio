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

// Product WorkspaceDO methods are still direct RPC receivers, so their
// semantic effect must match the receiver's reviewed declaration exactly.
// Most entity reads deliberately retain the manage capability because they
// expose mutable runtime topology; this retention scan is the narrow,
// inspect-only projection declared by WorkspaceDO itself.
const WORKSPACE_RUNTIME_STATE_INSPECT = new Set(["entityListExecutionRoots"]);
const EVAL_RUNTIME_INTRINSIC = new Set(["listRetainedExecutionRoots"]);

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
  if (className === "EvalDO") {
    return EVAL_RUNTIME_INTRINSIC.has(method) ? null : "runtime.code-execution.manage";
  }
  if (className === "WorkspaceDO") {
    return WORKSPACE_RUNTIME_STATE_INSPECT.has(method)
      ? "workspace.runtime-state.inspect"
      : "workspace.runtime-state.manage";
  }
  if (className === "WebhookStoreDO") return "webhooks.manage";
  if (className === "GadWorkspaceDO" && WORKSPACE_GRAPH_DELETE.has(method)) {
    return "workspace.graph.delete";
  }
  return null;
}
