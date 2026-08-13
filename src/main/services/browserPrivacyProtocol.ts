import { z } from "zod";
export {
  BROWSER_PRIVACY_FORM_FILL_TYPES,
  BrowserPrivacyRequestSchema,
  BrowserPrivacySectionSchema,
  BrowserPrivacySnapshotSchema,
  type BrowserPrivacyRequest,
  type BrowserPrivacySection,
  type BrowserPrivacySnapshot,
} from "@vibestudio/service-schemas/browserPrivacy";

export const BrowserPrivacyResultSchema = z
  .object({ ok: z.literal(true), value: z.unknown() })
  .or(z.object({ ok: z.literal(false), error: z.string().min(1) }));
export type BrowserPrivacyResult = z.infer<typeof BrowserPrivacyResultSchema>;
