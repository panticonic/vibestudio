import { z } from "zod";

export const operationIntentSchema = z
  .object({
    service: z.string().min(1).max(256),
    method: z.string().min(1).max(256),
    args: z.array(z.unknown()).max(64).optional(),
    use: z.enum(["action", "conditional"]),
  })
  .strict();

export const agentActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), text: z.string().min(1).max(24_000) }).strict(),
  z
    .object({
      kind: z.literal("eval"),
      code: z.string().min(1).max(96_000),
      syntax: z.enum(["javascript", "typescript", "jsx", "tsx"]).optional(),
      timeoutMs: z.number().int().positive().max(86_400_000).optional(),
      reset: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("watch"),
      code: z.string().min(1).max(96_000),
      syntax: z.enum(["javascript", "typescript", "jsx", "tsx"]).optional(),
      timeoutMs: z.number().int().positive().max(86_400_000).optional(),
      reset: z.boolean().optional(),
    })
    .strict(),
]);

export const triggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z
    .object({
      kind: z.literal("schedule"),
      everyMs: z.number().int().min(60_000),
      anchorAt: z.number().int().nonnegative().optional(),
      jitterMs: z.number().int().nonnegative().optional(),
      untilAt: z.number().int().nonnegative().optional(),
      maxRuns: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cron"),
      expression: z.string().min(1).max(512),
      timezone: z.string().min(1).max(128),
      untilAt: z.number().int().nonnegative().optional(),
      maxRuns: z.number().int().positive().optional(),
    })
    .strict(),
]);

/** Initial defaults, installed once per workspace member. Runtime edits remain authoritative. */
export const WorkspaceAutomationSchema = z
  .object({
    source: z.string().regex(/^workers\/[a-zA-Z0-9_-]+$/),
    className: z.string().min(1),
    name: z.string().min(1).max(200),
    summary: z.string().min(1).max(4000),
    action: agentActionSchema,
    trigger: triggerSchema,
    operations: z.array(operationIntentSchema).max(256),
  })
  .strict();
export type WorkspaceAutomation = z.infer<typeof WorkspaceAutomationSchema>;
export const WorkspaceAutomationsSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  WorkspaceAutomationSchema.nullable()
);
/** Shared identity, independent of mutable defaults such as name and schedule. */
export function workspaceAutomationKey(id: string, userId: string): string {
  return `workspace-automation:${id}:${encodeURIComponent(userId)}`;
}
