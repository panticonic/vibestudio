import { browserVaultNativeMethods } from "@vibestudio/service-schemas/browserVaultNative";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
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
  applyCookieMutations(
    input: ApplyCookieMutationsRequest,
    signal?: AbortSignal
  ): Promise<{ revision: number }>;
  listCookieOrigins(signal?: AbortSignal): Promise<{ revision: number; origins: string[] }>;
  listCookieOriginsPage(
    offset: number,
    limit: number
  ): Promise<{ items: string[]; total: number; revision: number }>;
  getCookiesForOrigin(origin: string, signal?: AbortSignal): Promise<StoredCookie[]>;
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
  const client = (signal?: AbortSignal) =>
    createTypedServiceClient(
      "browserVaultNative",
      browserVaultNativeMethods,
      (service, method, args) =>
        serverClient.call(service, method, args, signal ? { signal } : undefined)
    );
  const vault = client();
  return {
    listPasswordSummaries: () => vault.listPasswordSummaries(),
    listPasswordSummariesPage: (offset, limit) => vault.listPasswordSummariesPage(offset, limit),
    getPasswordForSite: (url) => vault.getPasswordForSite(url),
    listPasswordsPage: (offset, limit) => vault.listPasswordsPage(offset, limit),
    addPassword: (input) => vault.addPassword(input),
    updatePassword: (id, input) => vault.updatePassword(id, input),
    deletePassword: (id) => vault.deletePassword(id),
    addNeverSavePassword: (origin) => vault.addNeverSave(origin),
    isNeverSavePassword: (origin) => vault.isNeverSave(origin),
    getNeverSavePasswordOrigins: () => vault.getNeverSaveOrigins(),
    getNeverSavePasswordOriginsPage: (offset, limit) =>
      vault.getNeverSaveOriginsPage(offset, limit),
    removeNeverSavePassword: (origin) => vault.removeNeverSave(origin),
    updatePasswordLastUsed: (id) => vault.updateLastUsed(id),
    getFormFillSuggestions: (query) => vault.getFormFillSuggestions(query),
    listFormFillValues: () => vault.listFormFillValues(),
    listFormFillValuesPage: (offset, limit) => vault.listFormFillValuesPage(offset, limit),
    addFormFillValue: (input, sourceId) => vault.addFormFillValue(input, sourceId),
    updateFormFillValue: (id, input) => vault.updateFormFillValue(id, input),
    markFormFillValueUsed: (id) => vault.markFormFillValueUsed(id),
    deleteFormFillValue: (id) => vault.deleteFormFillValue(id),
    clearFormFillValues: () => vault.clearFormFillValues(),
    applyCookieMutations: (input, signal) => client(signal).applyCookieMutations(input),
    listCookieOrigins: (signal) => client(signal).listCookieOrigins(),
    listCookieOriginsPage: (offset, limit) => vault.listCookieOriginsPage(offset, limit),
    getCookiesForOrigin: (origin, signal) => client(signal).getCookiesForOrigin(origin),
    listCookiesPage: (offset, limit) => vault.listCookiesPage(offset, limit),
    clearCookiesForOrigin: (origin) => vault.clearCookiesForOrigin(origin),
    clearAllCookies: () => vault.clearAllCookies(),
    endBrowserSession: () => vault.endBrowserSession(),
    getCookieSiteSummary: (origin) => vault.getCookieSiteSummary(origin),
    addCookiesBatch: (input) => vault.addCookiesBatch(input),
    addPasswordsBatch: (passwords, meta) => vault.addPasswordsBatch(passwords, meta),
    addFormFillBatch: (values, meta) => vault.addFormFillBatch(values, meta),
  };
}
