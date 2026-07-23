const BROWSER_DATA_READ = new Set([
  "classifyAgainstStore", "getAllBookmarks", "getAutofillFieldNames",
  "getAutofillSuggestions", "getBookmarks", "getCookieDomains", "getCookies",
  "getDomainReadiness", "getHistory", "getHistoryDomains", "getImportHistory",
  "getNeverSaveOrigins", "getPasswordForSite", "getPasswordOrigins", "getPasswords",
  "getPermissions", "getProfileImportState", "getSearchEngines", "isNeverSave",
  "searchBookmarks", "searchHistory", "searchHistoryForAutocomplete",
]);

const BROWSER_DATA_DELETE = new Set([
  "clearAllHistory", "clearCookies", "deleteBookmark", "deleteCookie",
  "deleteHistoryEntry", "deleteHistoryRange", "deletePassword", "removeNeverSave",
]);

const WORKSPACE_GRAPH_DELETE = new Set([
  "deleteChannelInvite", "deleteChannelMembership", "deleteLogHead", "deleteRef",
  "purgeRevokedUserChannelIndexes", "vcsDropContext",
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
