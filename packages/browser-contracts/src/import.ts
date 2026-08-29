import { z } from "zod";

/** Dependency-neutral browser import vocabulary shared by data and RPC layers. */
export const BROWSER_NAMES = [
  "firefox",
  "zen",
  "chrome",
  "chrome-beta",
  "chrome-dev",
  "chrome-canary",
  "chromium",
  "edge",
  "edge-beta",
  "edge-dev",
  "brave",
  "vivaldi",
  "opera",
  "opera-gx",
  "arc",
  "safari",
] as const;
export type BrowserName = (typeof BROWSER_NAMES)[number];
export const BrowserNameSchema = z.enum(BROWSER_NAMES);

export const BROWSER_IMPORT_DATA_TYPES = [
  "bookmarks",
  "history",
  "cookies",
  "passwords",
  "formFill",
  "searchEngines",
  "favicons",
] as const;
export type BrowserImportDataType = (typeof BROWSER_IMPORT_DATA_TYPES)[number];
export const BrowserImportDataTypeSchema = z.enum(BROWSER_IMPORT_DATA_TYPES);

export const IMPORT_HOST_PLATFORMS = ["darwin", "linux", "win32", "ios", "android"] as const;
export type ImportHostPlatform = (typeof IMPORT_HOST_PLATFORMS)[number];
export interface ImportHostSummary {
  hostId: string;
  displayName: string;
  platform: ImportHostPlatform;
  location: "device" | "server";
  connected: boolean;
}
export const ImportHostSummarySchema = z
  .object({
    hostId: z.string().min(1),
    displayName: z.string().min(1).max(200),
    platform: z.enum(IMPORT_HOST_PLATFORMS),
    location: z.enum(["device", "server"]),
    connected: z.boolean(),
  })
  .strict();

export const IMPORT_SOURCE_STATUSES = ["readable", "blocked", "unsupported"] as const;
export type ImportSourceStatus = (typeof IMPORT_SOURCE_STATUSES)[number];
export interface BrowserImportSource {
  sourceId: string;
  browser: BrowserName;
  displayName: string;
  status: ImportSourceStatus;
  localDataSetCount: number;
  supportedDataTypes: BrowserImportDataType[];
  lastActivityAt?: number;
  warnings: string[];
}
export const BrowserImportSourceSchema = z
  .object({
    sourceId: z.string().min(1).max(512),
    browser: BrowserNameSchema,
    displayName: z.string().min(1).max(200),
    status: z.enum(IMPORT_SOURCE_STATUSES),
    localDataSetCount: z.number().int().nonnegative(),
    supportedDataTypes: z.array(BrowserImportDataTypeSchema),
    lastActivityAt: z.number().finite().optional(),
    warnings: z.array(z.string().max(2_000)),
  })
  .strict();

export interface ImportCategoryProgress {
  dataType: BrowserImportDataType;
  itemsProcessed: number;
  totalItems?: number;
  stored: number;
  skipped: number;
  errors: number;
}
export const ImportCategoryProgressSchema = z
  .object({
    dataType: BrowserImportDataTypeSchema,
    itemsProcessed: z.number().int().nonnegative(),
    totalItems: z.number().int().nonnegative().optional(),
    stored: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  })
  .strict();
