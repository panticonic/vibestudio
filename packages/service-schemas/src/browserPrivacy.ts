import { z } from "zod";
import { BROWSER_DATA_SECTIONS } from "@vibestudio/shared/shellSurface";

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

export const BrowserPrivacySectionSchema = z.enum(BROWSER_DATA_SECTIONS);
export type BrowserPrivacySection = z.infer<typeof BrowserPrivacySectionSchema>;

export const BrowserPrivacyRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("diagnostics") }).strict(),
  z.object({ action: z.literal("applyCookies") }).strict(),
  z.object({ action: z.literal("snapshot") }).strict(),
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
export const BrowserCookieProjectionDiagnosticsSchema = z.object({
  revision: z.number(),
  hostId: z.string(),
  converged: z.boolean(),
  mismatchCount: z.number(),
  outboxDepth: z.number(),
  lastError: z.string().optional(),
  lastFailure: z
    .object({
      message: z.string(),
      occurredAt: z.string(),
      recoveredAt: z.string().optional(),
    })
    .optional(),
});

export type BrowserCookieProjectionDiagnostics = z.infer<
  typeof BrowserCookieProjectionDiagnosticsSchema
>;

export const BrowserPrivacySnapshotSchema = z
  .object({
    passwords: z.array(PasswordSummarySchema),
    neverSave: z.array(z.string().url()),
    formFill: z.array(FormFillRowSchema),
    cookieOrigins: z.object({
      revision: z.number().int().nonnegative(),
      origins: z.array(z.string()),
    }),
  })
  .strict();
export type BrowserPrivacySnapshot = z.infer<typeof BrowserPrivacySnapshotSchema>;
