/**
 * workspacePresence service schema — WP8 §4 "who's connected to this workspace".
 *
 * A HOST surface built purely from the session/connection registry (live RPC
 * connections + each caller's verified `subject.userId`) with ZERO channel
 * coupling (INV-1/INV-2): it answers "who is present in the workspace", NOT
 * "who is in a conversation" (that is userland channel presence, §3). The two
 * systems are never derived from each other.
 *
 * Presence is keyed on the LOGICAL `user:<userId>` — a person on a phone AND a
 * laptop is ONE present user with `endpoints: 2`, going offline only when the
 * last live human connection drops. Only human runtime kinds (shell/panel/app)
 * count; agent/worker/do deputies (which carry an inherited userId, WP0 §6) and
 * the synthetic `system` subject never appear as "people in the workspace".
 *
 * Attribution, not security: in a mutually-trusting team every member sees who
 * else is around. `handle`/`displayName`/`color` are resolved LIVE from the
 * shared identity DB on every read (never frozen), so a profile edit re-renders
 * everywhere a human is named.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/servicePolicy";
import type { SchemaCoversType } from "@vibestudio/shared/schemaTypeGuard";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { WorkspacePresenceEntry } from "@vibestudio/shared/workspacePresence";

/**
 * One present (or recently-departed) workspace member. `online` flips false
 * only when a user's last live human connection drops; `lastSeen` then freezes
 * at that drop time (for an online user it tracks "seen now"). `endpoints` is
 * the count of that user's live client/device endpoints (omitted when offline). The
 * payload carries NO channel/conversation/pubsub reference (WP8 §4.2).
 */
export const workspacePresenceEntrySchema = z
  .object({
    /** Stable logical account id (`user:<userId>` collapses all the user's devices). */
    userId: z.string(),
    /** Live handle from the shared identity DB (falls back to the raw userId). */
    handle: z.string(),
    /** Live display name from the shared identity DB. */
    displayName: z.string(),
    /** Live hex tint for presence/handle rendering, when the account sets one. */
    color: z.string().optional(),
    /** True while the user holds ≥1 live human (shell/panel/app) connection. */
    online: z.boolean(),
    /** Epoch ms: last time the user was seen (their last connection-drop time once offline). */
    lastSeen: z.number(),
    /** Count of the user's live client/device endpoints (present only while online). */
    endpoints: z.number().optional(),
  })
  .strict();

/**
 * The wire + render type for one workspace-presence row. Canonical home for the
 * type so the host service, the `workspace-presence-changed` event payload
 * (`events.ts`), and the shell consumer all derive from one source.
 */
const _workspacePresenceEntrySchemaCoversType: SchemaCoversType<
  WorkspacePresenceEntry,
  z.infer<typeof workspacePresenceEntrySchema>
> = true;
const _workspacePresenceEntrySchemaOutputIsType: z.infer<
  typeof workspacePresenceEntrySchema
> extends WorkspacePresenceEntry
  ? true
  : false = true;
void _workspacePresenceEntrySchemaCoversType;
void _workspacePresenceEntrySchemaOutputIsType;

// A pure read: it projects live session facts + live identity, mutating
// nothing. The service-level `policy` on the registration stays the enforced
// caller gate; this carries the read-only/doc metadata.
const LIST_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};

export const workspacePresenceMethods = defineServiceMethods({
  list: {
    description:
      "List the users with ≥1 live human connection to this workspace, plus recently-departed users with a last-seen time (WP8 §4 host presence). Fed only by the session registry — carries no channel/conversation data.",
    args: z.tuple([]),
    returns: z.array(workspacePresenceEntrySchema),
    access: LIST_ACCESS,
  },
});
