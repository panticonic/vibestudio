import { z } from "zod";

export const USAGE_DESTINATION = "https://vibestudio.app/v1/problem-reports/usage";
export const STARTUP_DESTINATION = `${USAGE_DESTINATION}/startup`;
export const UsageMetricSchema = z.enum([
  "startup",
  "reporting-runtime-minutes",
  "report-draft",
  "report-preview",
  "report-queued",
  "shell-surface-open",
  "browser-navigation",
  "entity-created",
  "context-created",
]);
export type UsageMetric = z.infer<typeof UsageMetricSchema>;
const count = z.number().int().safe().min(1).max(10000);
/** No identifier, signature, source timestamp, version, or free-text field exists in this wire contract. */
export const UsagePingSchema = z
  .object({
    schema: z.literal("vibestudio.usage.v1"),
    counts: z
      .object({
        startup: z.literal(1).optional(),
        "reporting-runtime-minutes": count.optional(),
        "report-draft": count.optional(),
        "report-preview": count.optional(),
        "report-queued": count.optional(),
        "shell-surface-open": count.optional(),
        "browser-navigation": count.optional(),
        "entity-created": count.optional(),
        "context-created": count.optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0),
  })
  .strict();
export type UsagePing = z.infer<typeof UsagePingSchema>;
