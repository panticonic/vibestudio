import { z } from "zod";
import { claudeLaunchProfileSchema } from "@vibestudio/shared/claudeLaunchProfile";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";

const id = z.string().min(1).max(256);
export const linkedClaudeOptionsSchema = z
  .object({
    model: z.string().min(1).max(256).regex(/^[^-]/u).optional(),
    fallbackModel: z.string().min(1).max(256).regex(/^[^-]/u).optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    permissionMode: z
      .enum(["auto", "acceptEdits", "bypassPermissions", "manual", "dontAsk", "plan"])
      .optional(),
    maxBudgetUsd: z.number().finite().positive().optional(),
  })
  .strict();
export const linkedClaudeStartSchema = z
  .object({
    profile: claudeLaunchProfileSchema,
    prompt: z
      .string()
      .min(1)
      .max(1024 * 1024),
    options: linkedClaudeOptionsSchema.optional(),
  })
  .strict();
export type LinkedClaudeStart = z.infer<typeof linkedClaudeStartSchema>;
export const linkedClaudeContinueSchema = z
  .object({
    entityId: id,
    generationId: id,
    sessionId: z.string().uuid(),
    prompt: z
      .string()
      .min(1)
      .max(1024 * 1024),
    options: linkedClaudeOptionsSchema.optional(),
  })
  .strict();
export type LinkedClaudeContinue = z.infer<typeof linkedClaudeContinueSchema>;
export const linkedClaudeSnapshotSchema = z
  .object({
    generationId: id,
    entityId: id,
    state: z.enum(["running", "exited"]),
    pid: z.number().int().positive().nullable(),
    exit: z
      .object({ code: z.number().int().nullable(), signal: z.string().nullable(), at: z.string() })
      .nullable(),
    log: z.object({ bytes: z.number(), tail: z.string(), truncated: z.boolean() }),
  })
  .strict();
export type LinkedClaudeSnapshot = z.infer<typeof linkedClaudeSnapshotSchema>;
const reference = z.object({ generationId: id, entityId: id }).strict();
const controlTier = {
  tier: "open" as const,
  session: "family" as const,
  residency: "native-effect" as const,
  family: "linked-claude.session",
  rationale:
    "Controls only a host-owned generation bound to the verified extension connection and live session owner",
};
export const linkedClaudeMethods = defineServiceMethods({
  start: {
    description:
      "Start an authorized linked Claude agent with host-owned runtime and credential materialization; accepts no filesystem paths or executable grants",
    capability: "subagents.create",
    presentation: {
      title: "Launch a linked Claude agent",
      action: "launch a linked Claude agent",
      description:
        "Run the installed Claude provider with its linked account and network access, using an isolated profile and the agent's workspace context.",
      group: "automation",
      authorityCategory: { domain: "automation", verb: "act" },
    },
    authority: {
      requirement: requirementForPrincipals(["user", "code"], "subagents.create"),
      resource: { kind: "literal", key: "" },
    },
    tier: {
      ...controlTier,
      tier: "gated" as const,
      family: "linked-claude.start",
      rationale:
        "Runs a linked provider only for an active agent session owned by the authenticated caller",
    },
    args: z.tuple([linkedClaudeStartSchema]),
    returns: linkedClaudeSnapshotSchema,
    access: { sensitivity: "write" },
  },
  continue: {
    website: {
      kind: "closed",
      reason:
        "The linkedClaude receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    description: "Continue an owned linked Claude conversation in its retained host profile",
    tier: controlTier,
    args: z.tuple([linkedClaudeContinueSchema]),
    returns: linkedClaudeSnapshotSchema,
    access: { sensitivity: "write" },
  },
  interrupt: {
    website: {
      kind: "closed",
      reason:
        "The linkedClaude receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    description:
      "Stop the active turn of an owned linked Claude conversation without retiring its profile",
    tier: controlTier,
    args: z.tuple([reference]),
    returns: linkedClaudeSnapshotSchema,
    access: { sensitivity: "write" },
  },
  inspect: {
    description: "Read the bounded state of an owned linked Claude generation",
    tier: controlTier,
    args: z.tuple([reference]),
    returns: linkedClaudeSnapshotSchema,
    access: { sensitivity: "read" },
  },
  stop: {
    description:
      "Retire an owned linked Claude generation and reconcile its isolated credential after confirmed exit",
    tier: controlTier,
    args: z.tuple([reference]),
    returns: z.object({ stopped: z.boolean() }).strict(),
    access: { sensitivity: "write" },
  },
});
