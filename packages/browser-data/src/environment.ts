import { z } from "zod";
import { FORM_FILL_TYPES, type FormFillType } from "./formFillTypes.js";
export {
  FORM_FILL_TYPES,
  NON_PERSISTABLE_FORM_FILL_TYPES,
  isPersistableFormFillType,
  type FormFillType,
} from "./formFillTypes.js";
import type { BrowserCookiePartitionKey } from "./cookies.js";
import { FAVICON_MIME_TYPES, type FaviconMimeType } from "./favicon.js";
import {
  BROWSER_IMPORT_DATA_TYPES,
  BrowserImportDataTypeSchema,
  BrowserImportSourceSchema,
  IMPORT_HOST_PLATFORMS,
  IMPORT_SOURCE_STATUSES,
  ImportCategoryProgressSchema,
  ImportHostSummarySchema,
  type BrowserImportDataType,
  type BrowserImportSource,
  type ImportCategoryProgress,
  type ImportHostPlatform,
  type ImportHostSummary,
  type ImportSourceStatus,
} from "@vibestudio/browser-contracts/import";
export {
  BROWSER_IMPORT_DATA_TYPES,
  BrowserImportDataTypeSchema,
  BrowserImportSourceSchema,
  IMPORT_HOST_PLATFORMS,
  IMPORT_SOURCE_STATUSES,
  ImportCategoryProgressSchema,
  ImportHostSummarySchema,
  type BrowserImportDataType,
  type BrowserImportSource,
  type ImportCategoryProgress,
  type ImportHostPlatform,
  type ImportHostSummary,
  type ImportSourceStatus,
} from "@vibestudio/browser-contracts/import";

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

export interface ImportCategoryBreakdownGroup {
  /** Display label: a site host, or a category-specific bucket name. */
  label: string;
  count: number;
}

/**
 * Aggregate shape of one category's readable items, so the migration UI can
 * answer "what exactly am I importing?" before anything is written. Buckets are
 * counts over already-public keys (hosts, field names) — never secret values.
 */
export interface ImportCategoryBreakdown {
  dataType: BrowserImportDataType;
  /** How items were bucketed, so the UI can label the drill-down. */
  groupedBy: "site" | "kind";
  total: number;
  /** Largest buckets first, capped; the tail is folded into the counters below. */
  groups: ImportCategoryBreakdownGroup[];
  /** Buckets not listed in `groups`. */
  otherGroups: number;
  /** Items inside those unlisted buckets. */
  otherItems: number;
}

export interface ImportPreviewSummary {
  dataTypes: ImportCategoryProgress[];
  breakdowns: ImportCategoryBreakdown[];
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
  /**
   * Opaque identifier for the source browser window this tab belongs to. Tabs
   * sharing a `windowId` were open side by side; the value carries no profile
   * path or window handle, only grouping identity.
   */
  windowId: string;
  /** 1-based window position, stable across profiles, for display ("Window 2"). */
  windowOrdinal: number;
  /**
   * How this tab relates to what the user would actually see:
   * `open` — the profile is running and the tab is open right now;
   * `restores` — the browser is closed, but launching it reopens this window;
   * `saved` — a stored session that will not come back on its own (another
   * profile launches by default, or session restore is switched off).
   */
  sessionState: BrowserTabSessionState;
}

export const BROWSER_TAB_SESSION_STATES = ["open", "restores", "saved"] as const;
export type BrowserTabSessionState = (typeof BROWSER_TAB_SESSION_STATES)[number];

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
  partitionKey?: BrowserCookiePartitionKey;
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

export const BrowserCookiePartitionKeySchema = z
  .object({
    topLevelSite: z.string().url().max(4_096),
    hasCrossSiteAncestor: z.boolean(),
  })
  .strict();

export const BrowserCookieKeySchema = z
  .object({
    name: z.string().min(1).max(4_096),
    domain: z.string().min(1).max(4_096),
    path: z.string().min(1).max(4_096),
    partitionKey: BrowserCookiePartitionKeySchema.optional(),
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

export const FormFillTypeSchema = z.enum(FORM_FILL_TYPES);

export interface FormFillValueInput {
  /**
   * Browser-native HTML field name. This is the lossless identity used when a
   * field has no standard autocomplete meaning.
   */
  fieldName: string;
  /** Standard HTML autocomplete meaning, when one can be determined. */
  type?: FormFillType;
  value: string;
  displayLabel?: string;
  aliases?: string[];
  createdAt?: number;
  updatedAt?: number;
  useCount?: number;
}

export interface StoredFormFillValue {
  id: number;
  fieldName: string;
  type: FormFillType | null;
  value: string;
  displayLabel: string | null;
  aliases: string[];
  createdAt: number;
  updatedAt: number;
  useCount: number;
}

export interface FormFillSuggestionQuery {
  fieldName?: string;
  type?: FormFillType;
  prefix?: string;
  limit?: number;
}

export const FormFillSuggestionQuerySchema = z
  .object({
    fieldName: z.string().max(1_000).optional(),
    type: FormFillTypeSchema.optional(),
    prefix: z.string().max(1_000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine((query) => query.fieldName !== undefined || query.type !== undefined, {
    message: "A form-fill query requires a field name or semantic type",
  });

/**
 * A page's icon as it travels between processes.
 *
 * Image data is base64, not `Uint8Array`: every producer and consumer of this
 * type is on the far side of a JSON-encoded RPC hop, where a typed array
 * serializes to `{"0":137,"1":80,…}` — roughly six bytes of JSON per byte of
 * image, arriving as a plain object rather than a `Uint8Array`. Bulk favicon
 * imports blew past the 16 MiB websocket frame cap that way and closed the
 * connection mid-import. The store decodes to real BLOBs on write.
 */
export interface PageFavicon {
  pageUrl: string;
  origin: string;
  sourceUrl?: string;
  /** Base64-encoded bytes whose signature agrees with `mimeType`. */
  data: string;
  mimeType: FaviconMimeType;
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
    data: z.string().base64(),
    mimeType: z.enum(FAVICON_MIME_TYPES),
    updatedAt: z.number().finite(),
  })
  .strict();
