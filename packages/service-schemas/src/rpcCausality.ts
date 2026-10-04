import { z } from "zod";
import type { RpcCausalParent } from "@vibestudio/rpc";

const coordinate = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"));
/** Exact retained trajectory coordinate; the owning vessel selects its parent. */
export const rpcCausalParentSchema = z
  .object({
    kind: z.literal("trajectory-invocation"),
    logId: coordinate,
    head: coordinate,
    invocationId: coordinate,
  })
  .strict() satisfies z.ZodType<RpcCausalParent>;
