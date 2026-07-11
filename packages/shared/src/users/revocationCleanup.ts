import { z } from "zod";

export const RevokedUserCleanupRequestSchema = z
  .object({ userId: z.string().min(1) })
  .strict();

export const RevokedUserCleanupResultSchema = z
  .object({
    userId: z.string().min(1),
    closedSessions: z.number().int().nonnegative(),
    retiredDeputyIds: z.array(z.string()),
    archivedRootIds: z.array(z.string()),
    archivedPanelIds: z.array(z.string()),
    removedChannelIds: z.array(z.string()),
    removedPushRegistrations: z.number().int().nonnegative(),
  })
  .strict();

export type RevokedUserCleanupRequest = z.infer<typeof RevokedUserCleanupRequestSchema>;
export type RevokedUserCleanupResult = z.infer<typeof RevokedUserCleanupResultSchema>;
