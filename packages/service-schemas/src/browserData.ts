import { z } from "zod";
import { defineServiceMethods, type MethodSchema } from "@vibestudio/shared/typedServiceClient";

const voidResult = z.void();
const id = z.number().int().nonnegative();
const text = z.string();
const nullableText = text.nullable();
const nullableNumber = z.number().nullable();
const browserDownloadRecordSchema = z
  .object({
    id: text,
    environmentKey: text,
    hostId: text,
    panelId: text.optional(),
    origin: text.optional(),
    url: text,
    filename: text,
    savePath: text,
    receivedBytes: z.number().nonnegative(),
    totalBytes: z.number().nonnegative(),
    state: z.enum(["progressing", "paused", "completed", "cancelled", "interrupted"]),
    startedAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
const sitePreferencesSchema = z
  .object({ origin: text, zoomFactor: z.number(), updatedAt: z.number().optional() })
  .strict();
const bookmarkInputSchema = z
  .object({
    title: text,
    url: text.optional(),
    folderPath: text.optional(),
    dateAdded: z.number().optional(),
    tags: text.optional(),
    keyword: text.optional(),
    position: z.number().int().optional(),
  })
  .strict();
const bookmarkRowSchema = z
  .object({
    id,
    title: text,
    url: nullableText,
    folder_path: text,
    date_added: z.number(),
    date_modified: nullableNumber,
    position: z.number().int(),
    source_id: nullableText,
    import_key: nullableText,
    tags: nullableText,
    keyword: nullableText,
  })
  .strict();
const historyQuerySchema = z
  .object({
    search: text.optional(),
    startTime: z.number().optional(),
    endTime: z.number().optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();
const historyRowSchema = z
  .object({
    id,
    url: text,
    title: nullableText,
    visit_count: z.number().int().nonnegative(),
    typed_count: z.number().int().nonnegative(),
    first_visit: nullableNumber,
    last_visit: z.number(),
  })
  .strict();
const historyVisitInputSchema = z
  .object({
    url: text,
    title: text.optional(),
    transition: text.optional(),
    visitTime: z.number().optional(),
    typed: z.boolean().optional(),
    source: z.enum(["vibestudio", "import"]).optional(),
    panelId: text.optional(),
  })
  .strict();
const historyTitleInputSchema = z
  .object({ url: text, title: text, observedAt: z.number().optional() })
  .strict();
const passwordInputSchema = z
  .object({
    url: text,
    actionUrl: text.optional(),
    username: text,
    password: text,
    realm: text.optional(),
    dateCreated: z.number().optional(),
    dateLastUsed: z.number().optional(),
    datePasswordChanged: z.number().optional(),
    timesUsed: z.number().int().nonnegative().optional(),
  })
  .strict();
const passwordRowSchema = z
  .object({
    id,
    origin_url: text,
    username: text,
    password: text,
    action_url: text,
    realm: text,
    date_created: nullableNumber,
    date_last_used: nullableNumber,
    date_password_changed: nullableNumber,
    times_used: z.number().int().nonnegative(),
  })
  .strict();
const formFillTypes = [
  "name", "given-name", "additional-name", "family-name", "honorific-prefix",
  "honorific-suffix", "nickname", "username", "new-password", "current-password",
  "one-time-code", "organization-title", "email", "tel", "tel-country-code",
  "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix",
  "tel-extension", "impp", "organization", "street-address", "address-line1",
  "address-line2", "address-line3", "address-level1", "address-level2", "address-level3",
  "address-level4", "postal-code", "country", "country-name", "cc-name", "cc-given-name",
  "cc-additional-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month",
  "cc-exp-year", "cc-csc", "cc-type", "transaction-currency", "transaction-amount",
  "language", "bday", "bday-day", "bday-month", "bday-year", "sex", "url", "photo",
] as const;
const formFillTypeSchema = z.enum(formFillTypes);
const formFillInputSchema = z
  .object({
    fieldName: text,
    type: formFillTypeSchema.optional(),
    value: text,
    displayLabel: text.optional(),
    aliases: z.array(text).optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
    useCount: z.number().int().nonnegative().optional(),
  })
  .strict();
const formFillQuerySchema = z
  .object({
    fieldName: text.optional(),
    type: formFillTypeSchema.optional(),
    prefix: text.optional(),
    limit: z.number().int().positive().max(100).optional(),
  })
  .strict();
const formFillRowSchema = z
  .object({
    id,
    fieldName: text,
    type: formFillTypeSchema.nullable(),
    value: text,
    displayLabel: nullableText,
    aliases: z.array(text),
    createdAt: z.number(),
    updatedAt: z.number(),
    useCount: z.number().int().nonnegative(),
  })
  .strict();
const cookiePartitionSchema = z
  .object({ topLevelSite: text, hasCrossSiteAncestor: z.boolean() })
  .strict();
const cookieKeySchema = z
  .object({
    name: text,
    domain: text,
    path: text,
    partitionKey: cookiePartitionSchema.optional(),
  })
  .strict();
const cookieInputSchema = cookieKeySchema
  .extend({
    value: text,
    hostOnly: z.boolean(),
    secure: z.boolean(),
    httpOnly: z.boolean(),
    sameSite: z.enum(["unspecified", "no_restriction", "lax", "strict"]),
    expirationDate: z.number().optional(),
    sourceScheme: text.optional(),
    sourcePort: z.number().int().optional(),
    createdAt: z.number().optional(),
    lastAccessed: z.number().optional(),
  })
  .strict();
const storedCookieSchema = cookieInputSchema
  .extend({
    encryptedValue: text,
    contentHash: text,
    createdAt: z.number(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
const cookieMutationRequestSchema = z
  .object({
    mutations: z.array(
      z.discriminatedUnion("op", [
        z.object({ op: z.literal("put"), cookie: cookieInputSchema, mutationId: text }).strict(),
        z.object({ op: z.literal("delete"), key: cookieKeySchema, mutationId: text }).strict(),
      ])
    ),
  })
  .strict();
const cookieSnapshotSchema = z
  .object({ revision: z.number().int().nonnegative(), cookies: z.array(storedCookieSchema) })
  .strict();
const searchEngineInputSchema = z
  .object({
    name: text,
    keyword: text.optional(),
    searchUrl: text,
    suggestUrl: text.optional(),
    faviconUrl: text.optional(),
    isDefault: z.boolean(),
    sourceId: text.optional(),
  })
  .strict();
const searchEngineRowSchema = z
  .object({
    id,
    name: text,
    keyword: nullableText,
    search_url: text,
    suggest_url: nullableText,
    favicon_url: nullableText,
    is_default: z.number().int(),
    source_id: nullableText,
    import_key: nullableText,
  })
  .strict();
const faviconInputSchema = z
  .object({
    pageUrl: text,
    origin: text,
    sourceUrl: text.optional(),
    data: text,
    mimeType: z.enum([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/x-icon",
      "image/svg+xml",
      "image/bmp",
      "image/avif",
    ]),
    updatedAt: z.number(),
  })
  .strict();
const faviconRowSchema = z
  .object({
    page_url: text,
    origin: text,
    source_url: nullableText,
    image_data: text,
    mime_type: text,
    updated_at: z.number(),
  })
  .strict();
const importProgressSchema = z
  .object({
    dataType: text,
    itemsProcessed: z.number().int().nonnegative(),
    totalItems: z.number().int().nonnegative().optional(),
    stored: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  })
  .strict();
const importJobInputSchema = z
  .object({
    jobId: text,
    hostId: text,
    hostLabel: text,
    sourceId: text,
    browser: text,
    phase: text,
    startedAt: z.number(),
    updatedAt: z.number(),
    finishedAt: z.number().optional(),
    dataTypes: z.array(text),
    progress: z.array(importProgressSchema),
    warnings: z.array(text),
    error: text.optional(),
    resumable: z.boolean(),
  })
  .strict();
const importJobRowSchema = z
  .object({
    jobId: text,
    hostId: text,
    hostLabel: text,
    sourceId: text,
    browser: text,
    phase: text,
    startedAt: z.number(),
    updatedAt: z.number(),
    finishedAt: z.number().optional(),
    requestedDataTypes: z.array(text),
    progress: z.array(importProgressSchema),
    warnings: z.array(text),
    error: text.optional(),
    resumable: z.boolean(),
  })
  .strict();
const importSourceMetaSchema = z.object({ sourceId: text }).strict();
const importedBookmarkSchema = z
  .object({
    title: text,
    url: text,
    dateAdded: z.number(),
    dateModified: z.number().optional(),
    folder: z.array(text),
    tags: z.array(text).optional(),
    keyword: text.optional(),
    sourceId: text.optional(),
  })
  .strict();
const importedHistoryVisitSchema = z
  .object({ visitTime: z.number(), transition: text.optional(), typed: z.boolean().optional() })
  .strict();
const importedHistorySchema = z
  .object({
    url: text,
    title: text,
    visitCount: z.number().int().nonnegative(),
    lastVisitTime: z.number(),
    firstVisitTime: z.number().optional(),
    typedCount: z.number().int().nonnegative().optional(),
    transition: text.optional(),
    visits: z.array(importedHistoryVisitSchema).optional(),
  })
  .strict();

function browserDataMethod(
  args: z.ZodType<unknown[]>,
  returns: z.ZodType,
  sensitivity: "read" | "write" | "destructive",
  options: { secret?: boolean; description: string }
): MethodSchema {
  const capability =
    sensitivity === "read"
      ? "browser-data.read"
      : sensitivity === "destructive"
        ? "browser-data.delete"
        : "browser-data.write";
  const tier = sensitivity === "read" && !options.secret ? "open" : "gated";
  return {
    description: options.description,
    args,
    returns,
    capability,
    authority: { principals: ["host", "user", "code"] },
    tier: {
      tier,
      session: "family",
      rationale:
        tier === "open"
          ? "Ordinary workspace-owned browser metadata read."
          : "Credential-bearing, persistent, or destructive browser-data operation.",
    },
    access: { sensitivity },
  };
}

const read = (
  args: z.ZodType<unknown[]>,
  returns: z.ZodType,
  description: string,
  secret = false
) => browserDataMethod(args, returns, "read", { description, secret });
const write = (args: z.ZodType<unknown[]>, returns: z.ZodType, description: string) =>
  browserDataMethod(args, returns, "write", { description });
const destroy = (args: z.ZodType<unknown[]>, returns: z.ZodType, description: string) =>
  browserDataMethod(args, returns, "destructive", { description });

/**
 * Canonical wire table for the product-owned browser data store. Native import,
 * download-control, cookie-projection, and export orchestration deliberately do
 * not appear here; those remain native brokerage concerns.
 */
export const browserDataMethods = defineServiceMethods({
  upsertDownloadRecord: write(z.tuple([browserDownloadRecordSchema]), voidResult, "Store canonical download state."),
  listDownloadRecords: read(z.tuple([text]), z.array(browserDownloadRecordSchema), "List canonical download state for one host."),
  getSitePreferences: read(z.tuple([text]), sitePreferencesSchema, "Read site preferences for one origin."),
  setSiteZoom: write(z.tuple([text, z.number().positive()]), voidResult, "Set site zoom."),
  getBookmarks: read(z.tuple([text.optional()]), z.array(bookmarkRowSchema), "List bookmarks in one folder."),
  getAllBookmarks: read(z.tuple([]), z.array(bookmarkRowSchema), "List all bookmarks for export."),
  addBookmark: write(z.tuple([bookmarkInputSchema]), id, "Add a bookmark."),
  updateBookmark: write(z.tuple([id, bookmarkInputSchema.partial().strict()]), voidResult, "Update a bookmark."),
  deleteBookmark: destroy(z.tuple([id]), voidResult, "Delete a bookmark."),
  moveBookmark: write(z.tuple([id, text, z.number().int()]), voidResult, "Move a bookmark."),
  searchBookmarks: read(z.tuple([text]), z.array(bookmarkRowSchema), "Search bookmarks."),
  getHistory: read(z.tuple([historyQuerySchema]), z.array(historyRowSchema), "List bounded browsing history."),
  searchHistory: read(
    z.tuple([text, z.number().int().positive().optional()]),
    z.array(historyRowSchema),
    "Search browsing history."
  ),
  searchHistoryForAutocomplete: read(
    z.tuple([z.object({ query: text, limit: z.number().int().positive().optional() }).strict()]),
    z.array(historyRowSchema),
    "Search browsing history for address completion."
  ),
  recordHistoryVisit: write(z.tuple([historyVisitInputSchema]), id, "Record one browsing-history visit."),
  updateHistoryTitle: write(z.tuple([historyTitleInputSchema]), voidResult, "Update a history title."),
  deleteHistoryEntry: destroy(z.tuple([id]), voidResult, "Delete a history entry."),
  deleteHistoryRange: destroy(
    z.tuple([z.number(), z.number()]),
    z.number().int().nonnegative(),
    "Delete history visits in a time range."
  ),
  clearAllHistory: destroy(z.tuple([]), voidResult, "Delete all browsing history."),
  getPasswords: read(z.tuple([]), z.array(passwordRowSchema), "Read saved passwords.", true),
  getPasswordForSite: read(z.tuple([text]), z.array(passwordRowSchema), "Read passwords matching one site.", true),
  addPassword: write(z.tuple([passwordInputSchema]), id, "Add a saved password."),
  updatePassword: write(z.tuple([id, passwordInputSchema.partial().strict()]), voidResult, "Update a saved password."),
  deletePassword: destroy(z.tuple([id]), voidResult, "Delete a saved password."),
  addNeverSave: write(z.tuple([text]), voidResult, "Add a password never-save origin."),
  isNeverSave: read(z.tuple([text]), z.boolean(), "Check a password never-save origin."),
  getNeverSaveOrigins: read(z.tuple([]), z.array(text), "List password never-save origins."),
  removeNeverSave: destroy(z.tuple([text]), voidResult, "Remove a password never-save origin."),
  updateLastUsed: write(z.tuple([id]), voidResult, "Update password last-used metadata."),
  getFormFillSuggestions: read(z.tuple([formFillQuerySchema]), z.array(formFillRowSchema), "Read form-fill suggestions.", true),
  addFormFillValue: write(z.tuple([formFillInputSchema, text.optional()]), id, "Add a form-fill value."),
  updateFormFillValue: write(z.tuple([id, formFillInputSchema.pick({ value: true, displayLabel: true, aliases: true }).partial().strict()]), voidResult, "Update a form-fill value."),
  markFormFillValueUsed: write(z.tuple([id]), voidResult, "Mark a form-fill value used."),
  deleteFormFillValue: destroy(z.tuple([id]), voidResult, "Delete a form-fill value."),
  clearFormFillValues: destroy(
    z.tuple([]),
    z.number().int().nonnegative(),
    "Delete all form-fill values."
  ),
  applyCookieMutations: write(
    z.tuple([cookieMutationRequestSchema]),
    z.object({ revision: z.number().int().nonnegative() }).strict(),
    "Apply an exact cookie mutation batch."
  ),
  getCookieSnapshot: read(z.tuple([z.object({ sinceRevision: z.number().int().nonnegative().optional() }).strict().optional()]), cookieSnapshotSchema, "Read a cookie snapshot."),
  getCookiesForOrigin: read(z.tuple([text]), z.array(storedCookieSchema), "Read cookies for one origin."),
  clearCookiesForOrigin: destroy(
    z.tuple([text]),
    z.number().int().nonnegative(),
    "Delete cookies for one origin."
  ),
  clearAllCookies: destroy(
    z.tuple([]),
    z.number().int().nonnegative(),
    "Delete all browser cookies."
  ),
  endBrowserSession: destroy(
    z.tuple([]),
    z.number().int().nonnegative(),
    "Delete session-scoped browser cookies."
  ),
  getCookieSiteSummary: read(z.tuple([text]), z.object({ origin: text, cookieCount: z.number().int().nonnegative(), revision: z.number().int().nonnegative() }).strict(), "Read cookie counts for one origin."),
  getSearchEngines: read(z.tuple([]), z.array(searchEngineRowSchema), "List imported search engines."),
  setDefaultEngine: write(z.tuple([id]), voidResult, "Select the default search engine."),
  putPageFavicon: write(z.tuple([faviconInputSchema]), voidResult, "Store a page favicon."),
  getPageFavicon: read(z.tuple([text]), faviconRowSchema.nullable(), "Read the favicon for one page."),
  upsertImportJob: write(z.tuple([importJobInputSchema]), voidResult, "Store browser-import job state."),
  getImportJob: read(z.tuple([text]), importJobRowSchema.nullable(), "Read one browser-import job."),
  listImportJobs: read(z.tuple([]), z.array(importJobRowSchema), "List browser-import jobs."),
  recordImportBatch: write(z.tuple([z.object({ jobId: text, dataType: text, batchIndex: z.number().int().nonnegative(), idempotencyKey: text, itemCount: z.number().int().nonnegative() }).strict()]), z.object({ stored: z.boolean() }).strict(), "Record imported batch progress."),
  addBookmarksBatch: write(
    z.tuple([z.array(importedBookmarkSchema), importSourceMetaSchema]),
    z.number().int().nonnegative(),
    "Import a bookmark batch."
  ),
  addHistoryBatch: write(
    z.tuple([z.array(importedHistorySchema), importSourceMetaSchema]),
    z.number().int().nonnegative(),
    "Import a history batch."
  ),
  addCookiesBatch: write(
    z.tuple([z.object({ jobId: text, batchIndex: z.number().int().nonnegative(), cookies: z.array(cookieInputSchema) }).strict()]),
    z.object({ revision: z.number().int().nonnegative() }).strict(),
    "Import a cookie batch."
  ),
  addPasswordsBatch: write(
    z.tuple([z.array(passwordInputSchema), importSourceMetaSchema]),
    z.number().int().nonnegative(),
    "Import a password batch."
  ),
  addFormFillBatch: write(
    z.tuple([z.array(formFillInputSchema), importSourceMetaSchema]),
    z.number().int().nonnegative(),
    "Import a form-fill batch."
  ),
  addSearchEnginesBatch: write(
    z.tuple([z.array(searchEngineInputSchema), importSourceMetaSchema]),
    z.number().int().nonnegative(),
    "Import a search-engine batch."
  ),
  addFaviconsBatch: write(
    z.tuple([z.array(faviconInputSchema)]),
    z.number().int().nonnegative(),
    "Import a favicon batch."
  ),
});
