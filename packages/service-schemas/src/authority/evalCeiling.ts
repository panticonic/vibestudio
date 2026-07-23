import { z } from "zod";
import type { EvalAuthorityCeiling } from "@vibestudio/shared/authorityManifest";
import { UnitAuthorityRequestSchema } from "../build.js";

/** Wire shape for the immutable authority ceiling exposed to evaluated code. */
export const EvalAuthorityCeilingSchema = z
  .object({
    audience: z.literal("eval"),
    purpose: z.enum(["agentic-code-execution", "tool-eval", "test-eval"]),
    capabilities: z.array(UnitAuthorityRequestSchema).readonly(),
  })
  .strict() satisfies z.ZodType<EvalAuthorityCeiling>;
