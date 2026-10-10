import { z } from "zod";
import type { RpcFailure, RpcFailureReference } from "@vibestudio/rpc";

const rpcFailureReferenceSchema: z.ZodType<RpcFailureReference> = z
  .object({ reference: z.number().int().nonnegative() })
  .strict();

/** Schema for a root node of the transport-neutral RPC failure graph. */
export const rpcFailureSchema: z.ZodType<RpcFailure> = z.lazy(() =>
  z
    .object({
      id: z.number().int().nonnegative().optional(),
      message: z.string(),
      name: z.string().optional(),
      stack: z.string().optional(),
      errorKind: z.enum([
        "access",
        "service",
        "transport",
        "protocol",
        "application",
        "internal",
      ] as const),
      code: z.string().optional(),
      errorData: z.unknown().optional(),
      diagnosticId: z.string().optional(),
      cause: z.union([rpcFailureSchema, rpcFailureReferenceSchema]).optional(),
      errors: z.array(z.union([rpcFailureSchema, rpcFailureReferenceSchema])).optional(),
    })
    .strict()
);

export type RpcFailurePayload = z.infer<typeof rpcFailureSchema>;
