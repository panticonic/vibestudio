import { z } from "zod";
import type { EvalAuthorityDelegation } from "@vibestudio/shared/authorityManifest";
import { CapabilityScopeSchema } from "../build.js";

/** Wire shape for an immutable authority ceiling delegated to evaluated code. */
export const EvalAuthorityDelegationSchema = z
  .object({
    audience: z.literal("eval"),
    purpose: z.enum(["agentic-code-execution", "tool-eval", "test-eval"]),
    capabilities: z.array(CapabilityScopeSchema).readonly(),
  })
  .strict() satisfies z.ZodType<EvalAuthorityDelegation>;
