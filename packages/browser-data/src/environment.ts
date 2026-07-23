import { z } from "zod";
import { BrowserNameSchema } from "./types.js";
import type { BrowserName } from "./types.js";

export interface BrowserEnvironmentIdentity {
  workspaceId: string;
  ownerUserId: string;
  environmentKey: string;
}

export const BrowserEnvironmentIdentitySchema = z
  .object({
    workspaceId: z.string().min(1),
    ownerUserId: z.string().min(1),
    environmentKey: z.string().min(1),
  })
  .strict();

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

export const IMPORT_HOST_PLATFORMS = ["darwin", "linux", "win32"] as const;
export type ImportHostPlatform = (typeof IMPORT_HOST_PLATFORMS)[number];

export interface ImportHostSummary {
  hostId: string;
  displayName: string;
  platform: ImportHostPlatform;
  location: "desktop" | "server";
  connected: boolean;
}

export const ImportHostSummarySchema = z
  .object({
    hostId: z.string().min(1),
    displayName: z.string().min(1).max(200),
    platform: z.enum(IMPORT_HOST_PLATFORMS),
    location: z.enum(["desktop", "server"]),
    connected: z.boolean(),
  })
  .strict();

export const IMPORT_SOURCE_STATUSES = ["readable", "blocked", "unsupported"] as const;
export type ImportSourceStatus = (typeof IMPORT_SOURCE_STATUSES)[number];

/**
 * A provider-minted browser source. Profiles and filesystem paths stay inside
 * the trusted provider and are never represented in this contract.
 */
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

export const IMPORT_JOB_PHASES = [
  "queued",
  "discovering",
  "copying",
  "reading",
  "decrypting",
  "normalizing",
  "storing",
  "reconciling",
  "complete",
  "cancelled",
  "failed",
  "partial",
] as const;
export type ImportJobPhase = (typeof IMPORT_JOB_PHASES)[number];

export interface ImportCategoryProgress {
  dataType: BrowserImportDataType;
  itemsProcessed: number;
  totalItems?: number;
  stored: number;
  skipped: number;
  errors: number;
}

export interface ImportJobSnapshot {
  jobId: string;
  hostId: string;
  hostLabel?: string;
  sourceId: string;
  browser?: string;
  phase: ImportJobPhase;
  requestedDataTypes: BrowserImportDataType[];
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  progress: ImportCategoryProgress[];
  warnings: string[];
  error?: string;
  resumable: boolean;
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

export const ImportJobSnapshotSchema = z
  .object({
    jobId: z.string().min(1),
    hostId: z.string().min(1),
    hostLabel: z.string().min(1).optional(),
    sourceId: z.string().min(1),
    browser: z.string().min(1).optional(),
    phase: z.enum(IMPORT_JOB_PHASES),
    requestedDataTypes: z.array(BrowserImportDataTypeSchema),
    startedAt: z.number().finite(),
    updatedAt: z.number().finite(),
    finishedAt: z.number().finite().optional(),
    progress: z.array(ImportCategoryProgressSchema),
    warnings: z.array(z.string()),
    error: z.string().optional(),
    resumable: z.boolean(),
  })
  .strict();

export interface BrowserImportSelection {
  hostId: string;
  sourceId: string;
  dataTypes: BrowserImportDataType[];
}

export const BrowserImportSelectionSchema = z
  .object({
    hostId: z.string().min(1),
    sourceId: z.string().min(1),
    dataTypes: z.array(BrowserImportDataTypeSchema).min(1),
  })
  .strict();

export interface ImportPreviewSummary {
  dataTypes: ImportCategoryProgress[];
  openTabCount: number;
  localDataSetCount: number;
  warnings: string[];
}

export interface ImportSummary {
  dataTypes: ImportCategoryProgress[];
  warnings: string[];
}

export interface ImportedBrowserOpenTab {
  tabId: string;
  url: string;
  title?: string;
  active: boolean;
  pinned?: boolean;
  lastAccessed?: number;
}

export interface ImportBatch {
  jobId: string;
  sourceId: string;
  dataType: BrowserImportDataType;
  batchIndex: number;
  idempotencyKey: string;
  items: readonly unknown[];
}

export interface ImportPreviewSink {
  progress(progress: ImportCategoryProgress): void | Promise<void>;
  sample(dataType: BrowserImportDataType, maskedItems: readonly unknown[]): void | Promise<void>;
}

export interface ImportBatchSink {
  store(batch: ImportBatch): Promise<void>;
  progress(progress: ImportCategoryProgress): void | Promise<void>;
}

export interface BrowserImportProvider {
  listSources(signal: AbortSignal): Promise<BrowserImportSource[]>;
  preview(
    sourceId: string,
    dataTypes: BrowserImportDataType[],
    sink: ImportPreviewSink,
    signal: AbortSignal
  ): Promise<ImportPreviewSummary>;
  import(
    sourceId: string,
    dataTypes: BrowserImportDataType[],
    sink: ImportBatchSink,
    signal: AbortSignal
  ): Promise<ImportSummary>;
  listOpenTabs(sourceId: string, signal: AbortSignal): Promise<ImportedBrowserOpenTab[]>;
}

export const BROWSER_PERMISSION_CAPABILITIES = [
  "camera",
  "microphone",
  "geolocation",
  "notifications",
] as const;
export type BrowserPermissionCapability = (typeof BROWSER_PERMISSION_CAPABILITIES)[number];
export const BrowserPermissionCapabilitySchema = z.enum(BROWSER_PERMISSION_CAPABILITIES);

export interface BrowserCookieKey {
  name: string;
  domain: string;
  path: string;
  partitionKey?: string;
}

export interface BrowserCookieInput extends BrowserCookieKey {
  value: string;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  expirationDate?: number;
  sourceScheme?: string;
  sourcePort?: number;
  createdAt?: number;
  lastAccessed?: number;
}

export interface BrowserCookieRecord extends BrowserCookieKey {
  encryptedValue: string;
  contentHash: string;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  expirationDate?: number;
  sourceScheme?: string;
  sourcePort?: number;
  createdAt: number;
  lastAccessed?: number;
  revision: number;
}

export type BrowserCookieMutation =
  | { op: "put"; cookie: BrowserCookieInput; mutationId: string }
  | { op: "delete"; key: BrowserCookieKey; mutationId: string };

export interface ApplyCookieMutationsRequest {
  mutations: BrowserCookieMutation[];
}

export interface CookieSnapshot {
  revision: number;
  cookies: BrowserCookieRecord[];
}

export const BrowserCookieKeySchema = z
  .object({
    name: z.string().min(1).max(4_096),
    domain: z.string().min(1).max(4_096),
    path: z.string().min(1).max(4_096),
    partitionKey: z.string().max(4_096).optional(),
  })
  .strict();

export const BrowserCookieInputSchema = BrowserCookieKeySchema.extend({
  value: z.string().max(1_048_576),
  hostOnly: z.boolean(),
  secure: z.boolean(),
  httpOnly: z.boolean(),
  sameSite: z.enum(["unspecified", "no_restriction", "lax", "strict"]),
  expirationDate: z.number().finite().optional(),
  sourceScheme: z.string().max(100).optional(),
  sourcePort: z.number().int().min(-1).max(65_535).optional(),
  createdAt: z.number().finite().optional(),
  lastAccessed: z.number().finite().optional(),
}).strict();

export const BrowserCookieMutationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("put"),
      cookie: BrowserCookieInputSchema,
      mutationId: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      op: z.literal("delete"),
      key: BrowserCookieKeySchema,
      mutationId: z.string().min(1).max(512),
    })
    .strict(),
]);

export const ApplyCookieMutationsRequestSchema = z
  .object({
    mutations: z.array(BrowserCookieMutationSchema).max(1_000),
  })
  .strict();

export const FORM_FILL_TYPES = [
  "name",
  "given-name",
  "additional-name",
  "family-name",
  "honorific-prefix",
  "honorific-suffix",
  "email",
  "tel",
  "organization",
  "street-address",
  "address-line1",
  "address-line2",
  "address-line3",
  "address-level1",
  "address-level2",
  "postal-code",
  "country",
  "country-name",
] as const;
export type FormFillType = (typeof FORM_FILL_TYPES)[number];
export const FormFillTypeSchema = z.enum(FORM_FILL_TYPES);

export interface FormFillValueInput {
  type: FormFillType;
  value: string;
  displayLabel?: string;
  aliases?: string[];
  createdAt?: number;
  updatedAt?: number;
  useCount?: number;
}

export interface StoredFormFillValue {
  id: number;
  type: FormFillType;
  value: string;
  displayLabel: string | null;
  aliases: string[];
  createdAt: number;
  updatedAt: number;
  useCount: number;
}

export interface FormFillSuggestionQuery {
  type: FormFillType;
  prefix?: string;
  limit?: number;
}

export const FormFillSuggestionQuerySchema = z
  .object({
    type: FormFillTypeSchema,
    prefix: z.string().max(1_000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export interface PageFavicon {
  pageUrl: string;
  origin: string;
  sourceUrl?: string;
  png16?: Uint8Array;
  png32?: Uint8Array;
  mimeType: "image/png";
  updatedAt: number;
}

export interface FaviconHandle {
  pageUrl: string;
  updatedAt: number;
}

export type BrowserDownloadState =
  | "progressing"
  | "paused"
  | "completed"
  | "cancelled"
  | "interrupted";

export interface BrowserDownloadRecord {
  id: string;
  environmentKey: string;
  hostId: string;
  panelId?: string;
  origin?: string;
  url: string;
  filename: string;
  savePath: string;
  receivedBytes: number;
  totalBytes: number;
  state: BrowserDownloadState;
  startedAt: number;
  updatedAt: number;
}

export const PageFaviconSchema = z
  .object({
    pageUrl: z.string().url().max(16_384),
    origin: z.string().url().max(4_096),
    sourceUrl: z.string().url().max(16_384).optional(),
    png16: z.instanceof(Uint8Array).optional(),
    png32: z.instanceof(Uint8Array).optional(),
    mimeType: z.literal("image/png"),
    updatedAt: z.number().finite(),
  })
  .strict();
