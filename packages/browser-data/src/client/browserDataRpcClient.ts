import { extensionsMethods } from "@vibestudio/shared/serviceSchemas/extensions";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { ImportedPassword } from "../types.js";
import type { RecordHistoryVisitRequest, UpdateHistoryTitleRequest } from "../types.js";
import type {
  StoredBookmark,
  StoredCookie,
  StoredHistory,
  StoredPassword,
  StoredSearchEngine,
} from "../storage/types.js";
interface RpcLike {
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
}
export interface BrowserDataClient {
  cookies: {
    getByDomain(domain?: string): Promise<StoredCookie[]>;
  };
  history: {
    get(query: { limit: number }): Promise<StoredHistory[]>;
    searchForAutocomplete(query: string, limit?: number): Promise<StoredHistory[]>;
    recordVisit(request: RecordHistoryVisitRequest): Promise<number>;
    updateTitle(request: UpdateHistoryTitleRequest): Promise<void>;
  };
  bookmarks: {
    search(query: string): Promise<StoredBookmark[]>;
  };
  searchEngines: {
    getAll(): Promise<StoredSearchEngine[]>;
  };
  passwords: {
    getAll(): Promise<StoredPassword[]>;
    getForOrigin(origin: string): Promise<StoredPassword[]>;
    updateLastUsed(id: number): Promise<void>;
    update(
      id: number,
      partial: Partial<{
        username: string;
        password: string;
        actionUrl: string;
        realm: string;
      }>
    ): Promise<void>;
    add(password: {
      url: string;
      username: string;
      password: string;
      actionUrl?: string;
      realm?: string;
    }): Promise<number>;
    addNeverSave(origin: string): Promise<void>;
    isNeverSave(origin: string): Promise<boolean>;
    delete(id: number): Promise<void>;
    listNeverSaveOrigins(): Promise<string[]>;
    removeNeverSave(origin: string): Promise<void>;
  };
}
export function createBrowserDataRpcClient(rpc: RpcLike): BrowserDataClient {
  // The host resolves providers.browserData to its declared extension. The
  // provider namespace is the only invocation path; clients never resolve or
  // name the implementing extension.
  const extensions = createTypedServiceClient(
    "extensions",
    extensionsMethods,
    (service, method, args) => rpc.call(service, method, args)
  );
  const call = async <T>(method: string, ...args: unknown[]) => {
    return (await extensions.invokeProvider("browserData", method, args)) as T;
  };
  return {
    cookies: {
      getByDomain: (domain?: string) => call("getCookies", domain),
    },
    history: {
      get: (query: { limit: number }) => call("getHistory", query),
      searchForAutocomplete: (query: string, limit?: number) =>
        call("searchHistoryForAutocomplete", { query, limit }),
      recordVisit: (request: RecordHistoryVisitRequest) => call("recordHistoryVisit", request),
      updateTitle: (request: UpdateHistoryTitleRequest) => call("updateHistoryTitle", request),
    },
    bookmarks: {
      search: (query: string) => call("searchBookmarks", query),
    },
    searchEngines: {
      getAll: () => call("getSearchEngines"),
    },
    passwords: {
      getAll: () => call("getPasswords"),
      getForOrigin: (origin: string) => call("getPasswordForSite", origin),
      updateLastUsed: (id: number) => call<void>("updatePasswordLastUsed", id),
      update: (id: number, partial: Partial<ImportedPassword>) =>
        call("updatePassword", id, partial),
      add: (password) => call("addPassword", password),
      addNeverSave: (origin: string) => call<void>("addNeverSavePassword", origin),
      isNeverSave: (origin: string) => call<boolean>("isNeverSavePassword", origin),
      delete: (id: number) => call<void>("deletePassword", id),
      listNeverSaveOrigins: () => call<string[]>("getNeverSavePasswordOrigins"),
      removeNeverSave: (origin: string) => call<void>("removeNeverSavePassword", origin),
    },
  };
}
