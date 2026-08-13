import { z } from "zod";

export const BROWSER_PRIVACY_FORM_FILL_TYPES = [
  "name",
  "given-name",
  "additional-name",
  "family-name",
  "honorific-prefix",
  "honorific-suffix",
  "nickname",
  "username",
  "organization-title",
  "email",
  "tel",
  "tel-country-code",
  "tel-national",
  "tel-area-code",
  "tel-local",
  "tel-local-prefix",
  "tel-local-suffix",
  "tel-extension",
  "impp",
  "organization",
  "street-address",
  "address-line1",
  "address-line2",
  "address-line3",
  "address-level1",
  "address-level2",
  "address-level3",
  "address-level4",
  "postal-code",
  "country",
  "country-name",
  "cc-name",
  "cc-given-name",
  "cc-additional-name",
  "cc-family-name",
  "cc-number",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-type",
  "transaction-currency",
  "transaction-amount",
  "language",
  "bday",
  "bday-day",
  "bday-month",
  "bday-year",
  "sex",
  "url",
  "photo",
] as const;

const PersistableFormFillTypeSchema = z.enum(BROWSER_PRIVACY_FORM_FILL_TYPES);

export const BrowserPrivacySectionSchema = z.enum([
  "credentials",
  "formFill",
  "inspect",
  "debug",
  "export",
]);
export type BrowserPrivacySection = z.infer<typeof BrowserPrivacySectionSchema>;

export const BrowserPrivacyRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("snapshot"), origin: z.string().max(4_096) }).strict(),
  z
    .object({
      action: z.literal("snapshotPage"),
      collection: z.enum(["passwords", "neverSave", "formFill", "cookieOrigins"]),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(100),
      origin: z.string().max(4_096),
    })
    .strict(),
  z
    .object({
      action: z.literal("exportChunk"),
      exportKind: z.enum(["passwords", "cookies"]),
      format: z.enum(["csv-chrome", "csv-firefox", "json", "netscape-txt"]),
      offset: z.number().int().nonnegative(),
      chunkBytes: z.number().int().min(1).max(131_072),
    })
    .strict(),
  z.object({ action: z.literal("deletePassword"), id: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("removeNeverSave"), origin: z.string().url() }).strict(),
  z
    .object({
      action: z.literal("addFormFill"),
      type: PersistableFormFillTypeSchema,
      value: z.string().trim().min(1).max(100_000),
      displayLabel: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("updateFormFill"),
      id: z.number().int().nonnegative(),
      value: z.string().min(1).max(100_000),
    })
    .strict(),
  z.object({ action: z.literal("deleteFormFill"), id: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("clearFormFill") }).strict(),
  z.object({ action: z.literal("clearOrigin"), origin: z.string().url() }).strict(),
  z.object({ action: z.literal("endSession") }).strict(),
  z.object({ action: z.literal("clearAllCookies") }).strict(),
  z
    .object({
      action: z.literal("exportPasswords"),
      format: z.enum(["csv-chrome", "csv-firefox", "json"]),
    })
    .strict(),
  z
    .object({ action: z.literal("exportCookies"), format: z.enum(["json", "netscape-txt"]) })
    .strict(),
]);
export type BrowserPrivacyRequest = z.infer<typeof BrowserPrivacyRequestSchema>;

const PasswordSummarySchema = z
  .object({
    id: z.number().int().nonnegative(),
    origin_url: z.string(),
    username: z.string(),
  })
  .passthrough();
const FormFillRowSchema = z
  .object({
    id: z.number().int().nonnegative(),
    fieldName: z.string(),
    type: z.string().nullable(),
    value: z.string(),
  })
  .passthrough();
export const BrowserPrivacySnapshotSchema = z
  .object({
    passwords: z.array(PasswordSummarySchema),
    neverSave: z.array(z.string().url()),
    formFill: z.array(FormFillRowSchema),
    cookieOrigins: z.object({
      revision: z.number().int().nonnegative(),
      origins: z.array(z.string()),
    }),
    inspect: z.object({
      origin: z.string().url().nullable(),
      passwordCount: z.number().int().nonnegative(),
      cookieCount: z.number().int().nonnegative(),
    }),
    diagnostics: z
      .object({
        revision: z.number(),
        hostId: z.string(),
        converged: z.boolean(),
        mismatchCount: z.number(),
        outboxDepth: z.number(),
        lastError: z.string().optional(),
      })
      .nullable(),
  })
  .strict();
export type BrowserPrivacySnapshot = z.infer<typeof BrowserPrivacySnapshotSchema>;
