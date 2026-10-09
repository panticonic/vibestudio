import { z } from "zod";

export const RuntimeSupervisionKindSchema = z.enum(["panel", "worker", "do", "app", "extension"]);
export type RuntimeSupervisionKind = z.infer<typeof RuntimeSupervisionKindSchema>;

export const RuntimeSupervisionEntityKeySchema = z
  .object({
    kind: RuntimeSupervisionKindSchema,
    entityId: z.string().min(1),
  })
  .strict();
export type RuntimeSupervisionEntityKey = z.infer<typeof RuntimeSupervisionEntityKeySchema>;
