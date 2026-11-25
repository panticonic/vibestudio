import { z } from "zod";
import { operationalErrorMetadata, type OperationalErrorMetadata } from "@vibestudio/rpc";

/** Wire validation for the existing bounded, content-free operational error projection. */
function node(depth: number): z.ZodType<OperationalErrorMetadata> {
  const identifier = z
    .string()
    .max(80)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/u);
  const base = z
    .object({
      name: identifier.optional(),
      code: identifier.optional(),
      syscall: identifier.optional(),
      phase: z
        .enum(["dns", "connect", "fetch-head", "response-body", "websocket-upgrade", "socket"])
        .optional(),
      address: z
        .string()
        .max(64)
        .refine((value) => operationalErrorMetadata({ address: value }).address === value)
        .optional(),
      port: z.number().int().min(0).max(65535).optional(),
      errno: z.number().int().safe().optional(),
      circular: z.literal(true).optional(),
      truncated: z.literal(true).optional(),
    })
    .strict();
  if (depth >= 4) return base;
  return base
    .extend({
      cause: node(depth + 1).optional(),
      errors: z
        .array(node(depth + 1))
        .max(3)
        .optional(),
    })
    .strict();
}
export const operationalErrorMetadataSchema = node(0);
