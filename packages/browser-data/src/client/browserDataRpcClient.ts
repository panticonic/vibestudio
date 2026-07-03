import { extensionsMethods } from "@vibez1/shared/serviceSchemas/extensions";
import { createTypedServiceClient } from "@vibez1/shared/typedServiceClient";
import { browserDataBrokerPackageName } from "@vibez1/shared/workspace/configParser";
import type { WorkspaceConfig } from "@vibez1/shared/workspace/types";
import type { ImportedPassword } from "../types.js";
import type { RecordHistoryVisitRequest, UpdateHistoryTitleRequest } from "../types.js";
import type { StoredBookmark, StoredCookie, StoredHistory, StoredPassword, StoredSearchEngine } from "../storage/types.js";
interface RpcLike {
    call(service: string, method: string, args: unknown[]): Promise<unknown>;
}
export interface BrowserDataClient {
    cookies: {
        getByDomain(domain?: string): Promise<StoredCookie[]>;
    };
    history: {
        get(query: {
            limit: number;
        }): Promise<StoredHistory[]>;
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
        getForOrigin(origin: string): Promise<StoredPassword[]>;
        updateLastUsed(id: number): Promise<void>;
        update(id: number, partial: Partial<{
            username: string;
            password: string;
            actionUrl: string;
            realm: string;
        }>): Promise<void>;
        add(password: {
            url: string;
            username: string;
            password: string;
            actionUrl?: string;
            realm?: string;
        }): Promise<number>;
        addNeverSave(origin: string): Promise<void>;
        isNeverSave(origin: string): Promise<boolean>;
    };
}
/**
 * Resolve the manifest-declared browser-data broker extension name
 * (`providers.browserData.extension` in meta/vibez1.yml) over the workspace
 * service. Returns null when the workspace declares no broker — browser-data
 * features are then unavailable (there is no hardcoded fallback extension).
 */
export async function resolveBrowserDataExtensionName(rpc: RpcLike): Promise<string | null> {
    const config = (await rpc.call("workspace", "getConfig", [])) as WorkspaceConfig | null;
    return config ? browserDataBrokerPackageName(config) : null;
}

export function createBrowserDataRpcClient(rpc: RpcLike): BrowserDataClient {
    // Browser data lives in the manifest-declared broker extension
    // (providers.browserData.extension) — calls go through the dispatcher's
    // `extensions.invoke` relay rather than a dedicated host service. The
    // broker name is resolved lazily from the workspace manifest and cached;
    // resolution failures are retried on the next call.
    const extensions = createTypedServiceClient("extensions", extensionsMethods, (service, method, args) => rpc.call(service, method, args));
    let brokerNamePromise: Promise<string> | null = null;
    const resolveBroker = (): Promise<string> => {
        brokerNamePromise ??= resolveBrowserDataExtensionName(rpc)
            .then((name) => {
                if (!name) {
                    throw new Error(
                        "browser-data: no broker extension is declared in meta/vibez1.yml (providers.browserData.extension) — browser data is unavailable"
                    );
                }
                return name;
            })
            .catch((err: unknown) => {
                brokerNamePromise = null;
                throw err;
            });
        return brokerNamePromise;
    };
    const call = async <T>(method: string, ...args: unknown[]) => {
        // Only the outer extensions.invoke call is typed — the inner method
        // names are dynamic extension methods outside the wire schema, so each
        // wrapper keeps its local result cast.
        const broker = await resolveBroker();
        return (await extensions.invoke(broker, method, args)) as T;
    };
    return {
        cookies: {
            getByDomain: (domain?: string) => call("getCookies", domain),
        },
        history: {
            get: (query: {
                limit: number;
            }) => call("getHistory", query),
            searchForAutocomplete: (query: string, limit?: number) => call("searchHistoryForAutocomplete", { query, limit }),
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
            getForOrigin: (origin: string) => call("getPasswordForSite", origin),
            updateLastUsed: (id: number) => call<void>("updatePasswordLastUsed", id),
            update: (id: number, partial: Partial<ImportedPassword>) => call("updatePassword", id, partial),
            add: (password) => call("addPassword", password),
            addNeverSave: (origin: string) => call<void>("addNeverSavePassword", origin),
            isNeverSave: (origin: string) => call<boolean>("isNeverSavePassword", origin),
        },
    };
}
