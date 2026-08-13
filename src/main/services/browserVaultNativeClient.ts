import type {
  ApplyCookieMutationsRequest,
  BrowserCookieInput,
  FormFillSuggestionQuery,
  FormFillValueInput,
  ImportedPassword,
  StoredCookie,
  StoredFormFill,
  StoredPassword,
  StoredPasswordSummary,
} from "@vibestudio/browser-data";
import type { ServerClient } from "../serverClient.js";

export interface BrowserVaultNativeClient {
  listPasswordSummaries(): Promise<StoredPasswordSummary[]>;
  listPasswordSummariesPage(
    offset: number,
    limit: number
  ): Promise<{ items: StoredPasswordSummary[]; total: number }>;
  getPasswordForSite(url: string): Promise<StoredPassword[]>;
  listPasswordsPage(
    offset: number,
    limit: number
  ): Promise<{ items: StoredPassword[]; total: number }>;
  addPassword(input: ImportedPassword): Promise<number>;
  updatePassword(id: number, input: Partial<ImportedPassword>): Promise<void>;
  deletePassword(id: number): Promise<void>;
  addNeverSavePassword(origin: string): Promise<void>;
  isNeverSavePassword(origin: string): Promise<boolean>;
  getNeverSavePasswordOrigins(): Promise<string[]>;
  getNeverSavePasswordOriginsPage(
    offset: number,
    limit: number
  ): Promise<{ items: string[]; total: number }>;
  removeNeverSavePassword(origin: string): Promise<void>;
  updatePasswordLastUsed(id: number): Promise<void>;
  getFormFillSuggestions(query: FormFillSuggestionQuery): Promise<StoredFormFill[]>;
  listFormFillValues(): Promise<StoredFormFill[]>;
  listFormFillValuesPage(
    offset: number,
    limit: number
  ): Promise<{ items: StoredFormFill[]; total: number }>;
  addFormFillValue(input: FormFillValueInput, sourceId?: string): Promise<number>;
  updateFormFillValue(
    id: number,
    input: Partial<Pick<FormFillValueInput, "value" | "displayLabel" | "aliases">>
  ): Promise<void>;
  markFormFillValueUsed(id: number): Promise<void>;
  deleteFormFillValue(id: number): Promise<void>;
  clearFormFillValues(): Promise<number>;
  applyCookieMutations(input: ApplyCookieMutationsRequest): Promise<{ revision: number }>;
  listCookieOrigins(): Promise<{ revision: number; origins: string[] }>;
  listCookieOriginsPage(
    offset: number,
    limit: number
  ): Promise<{ items: string[]; total: number; revision: number }>;
  getCookiesForOrigin(origin: string): Promise<StoredCookie[]>;
  listCookiesPage(offset: number, limit: number): Promise<{ items: StoredCookie[]; total: number }>;
  clearCookiesForOrigin(origin: string): Promise<number>;
  clearAllCookies(): Promise<number>;
  endBrowserSession(): Promise<number>;
  getCookieSiteSummary(origin: string): Promise<{
    origin: string;
    cookieCount: number;
    revision: number;
  }>;
  addCookiesBatch(input: {
    jobId: string;
    batchIndex: number;
    cookies: BrowserCookieInput[];
  }): Promise<{ revision: number }>;
  addPasswordsBatch(passwords: ImportedPassword[], meta: { sourceId: string }): Promise<number>;
  addFormFillBatch(values: FormFillValueInput[], meta: { sourceId: string }): Promise<number>;
}

/** Electron-only typed client for the host-owned browser vault. */
export function createBrowserVaultNativeClient(
  serverClient: ServerClient
): BrowserVaultNativeClient {
  const call = <T>(method: string, ...args: unknown[]): Promise<T> =>
    serverClient.call("browserVaultNative", method, args) as Promise<T>;
  return {
    listPasswordSummaries: () => call("listPasswordSummaries"),
    listPasswordSummariesPage: (offset, limit) => call("listPasswordSummariesPage", offset, limit),
    getPasswordForSite: (url) => call("getPasswordForSite", url),
    listPasswordsPage: (offset, limit) => call("listPasswordsPage", offset, limit),
    addPassword: (input) => call("addPassword", input),
    updatePassword: (id, input) => call("updatePassword", id, input),
    deletePassword: (id) => call("deletePassword", id),
    addNeverSavePassword: (origin) => call("addNeverSave", origin),
    isNeverSavePassword: (origin) => call("isNeverSave", origin),
    getNeverSavePasswordOrigins: () => call("getNeverSaveOrigins"),
    getNeverSavePasswordOriginsPage: (offset, limit) =>
      call("getNeverSaveOriginsPage", offset, limit),
    removeNeverSavePassword: (origin) => call("removeNeverSave", origin),
    updatePasswordLastUsed: (id) => call("updateLastUsed", id),
    getFormFillSuggestions: (query) => call("getFormFillSuggestions", query),
    listFormFillValues: () => call("listFormFillValues"),
    listFormFillValuesPage: (offset, limit) => call("listFormFillValuesPage", offset, limit),
    addFormFillValue: (input, sourceId) => call("addFormFillValue", input, sourceId),
    updateFormFillValue: (id, input) => call("updateFormFillValue", id, input),
    markFormFillValueUsed: (id) => call("markFormFillValueUsed", id),
    deleteFormFillValue: (id) => call("deleteFormFillValue", id),
    clearFormFillValues: () => call("clearFormFillValues"),
    applyCookieMutations: (input) => call("applyCookieMutations", input),
    listCookieOrigins: () => call("listCookieOrigins"),
    listCookieOriginsPage: (offset, limit) => call("listCookieOriginsPage", offset, limit),
    getCookiesForOrigin: (origin) => call("getCookiesForOrigin", origin),
    listCookiesPage: (offset, limit) => call("listCookiesPage", offset, limit),
    clearCookiesForOrigin: (origin) => call("clearCookiesForOrigin", origin),
    clearAllCookies: () => call("clearAllCookies"),
    endBrowserSession: () => call("endBrowserSession"),
    getCookieSiteSummary: (origin) => call("getCookieSiteSummary", origin),
    addCookiesBatch: (input) => call("addCookiesBatch", input),
    addPasswordsBatch: (passwords, meta) => call("addPasswordsBatch", passwords, meta),
    addFormFillBatch: (values, meta) => call("addFormFillBatch", values, meta),
  };
}
