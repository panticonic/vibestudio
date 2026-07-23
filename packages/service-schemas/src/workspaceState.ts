/**
 * workspace-state service method schemas — read/write surface over slot.* and
 * entity.* on WorkspaceDO. Pure-data wire contract shared by the server
 * registration and typed clients.
 *
 * Reads (slot.list/get/history, entity.resolveActive) are open to all runtime
 * kinds; writes (slot create / commitPreparedNavigation / setParent / close)
 * are gated to the shipped shell, approved shell app, and
 * server. Panels and workers manipulate slots via runtime.*, not directly
 * here.
 */

import { z } from "zod";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { UnitAuthorityManifestSchema } from "./build.js";

export const SlotHistoryEntryInputSchema = z.object({
  entryKey: z.string(),
  entityId: z.string(),
  source: z.string(),
  contextId: z.string(),
  stateArgs: z.unknown().optional(),
  options: z.unknown().optional(),
});

export const SlotCommitPreparedNavigationInputSchema = z.object({
  slotId: z.string(),
  expectedCurrentEntityId: z.string(),
  mutation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("append"), entry: SlotHistoryEntryInputSchema }),
    z.object({ kind: z.literal("replace"), entry: SlotHistoryEntryInputSchema }),
    z.object({ kind: z.literal("select"), entryKey: z.string() }),
  ]),
});

export const SlotCommitPreparedNavigationResultSchema = z.object({
  previousEntityId: z.string(),
  currentEntityId: z.string(),
  currentEntryKey: z.string(),
  cursor: z.number().int().nonnegative(),
});

export const SlotCreateInputSchema = z.object({
  slotId: z.string(),
  parentSlotId: z.string().nullable(),
  positionId: z.string(),
  initialEntry: SlotHistoryEntryInputSchema.optional(),
});

export const WORKSPACE_STATE_READ_POLICY: ServiceAuthorityPolicy = {
  principals: ["user", "code", "host"],
};
export const WORKSPACE_STATE_WRITE_POLICY: ServiceAuthorityPolicy = {
  principals: ["user", "code", "host"],
};
export const WORKSPACE_STATE_LIFECYCLE_POLICY: ServiceAuthorityPolicy = {
  principals: ["host", "code"],
};

export const LifecycleKeySchema = z.object({
  source: z.string().min(1),
  className: z.string().min(1),
  objectKey: z.string().min(1),
});

export const LifecycleLeaseSchema = LifecycleKeySchema.extend({
  detail: z.unknown().optional(),
});

export const AlarmSetSchema = LifecycleKeySchema.extend({
  wakeAt: z.number(),
});

export const HeartbeatRegistryRowSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  className: z.string().min(1),
  objectKey: z.string().min(1),
  channelId: z.string().nullable().optional(),
  participantHandle: z.string().nullable().optional(),
  kind: z.enum(["declarative", "code-owned"]),
  status: z.enum(["running", "paused", "stopped"]),
  nextRunAt: z.number().nullable().optional(),
  lastWakeAt: z.number().nullable().optional(),
  lastActionSummary: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  specHash: z.string().nullable().optional(),
  updatedAt: z.number(),
});

export const PanelSearchResultSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    relevance: z.number(),
    accessCount: z.number(),
    matchContext: z.string().optional(),
  })
  .strict();

export const SlotRowSchema = z.object({
  slot_id: z.string(),
  parent_slot_id: z.string().nullable(),
  current_entity_id: z.string().nullable(),
  current_entity_title: z.string().nullable().optional(),
  current_entry_key: z.string().nullable(),
  position_id: z.string(),
  owner_user_id: z.string().nullable().optional(),
  created_at: z.number(),
  closed_at: z.number().nullable(),
});

export const SlotHistoryRowSchema = z.object({
  slot_id: z.string(),
  cursor: z.number(),
  entry_key: z.string(),
  entity_id: z.string(),
  source: z.string(),
  context_id: z.string(),
  state_args: z.string().nullable(),
  options: z.string().nullable().optional(),
  recorded_at: z.number(),
});

export const EntityRecordSchema = z.object({
  id: z.string(),
  kind: z.enum(["panel", "app", "worker", "do", "session", "shell", "server"]),
  source: z.object({ repoPath: z.string(), effectiveVersion: z.string() }),
  activeBuildKey: z.string().optional(),
  activeExecutionDigest: z.string().optional(),
  activeAuthority: UnitAuthorityManifestSchema.optional(),
  contextId: z.string(),
  className: z.string().optional(),
  key: z.string(),
  stateArgs: z.unknown().optional(),
  agentBinding: z
    .object({ entityId: z.string(), contextId: z.string(), channelId: z.string() })
    .optional(),
  parentId: z.string().optional(),
  ownerUserId: z.string().optional(),
  createdAt: z.number(),
  status: z.enum(["preparing", "active", "retired"]),
  retiredAt: z.number().optional(),
  cleanupComplete: z.boolean(),
  error: z.string().optional(),
});

export const workspaceStateMethods = defineServiceMethods({
  "slot.list": {
    args: z.tuple([]),
    description: "List open slots.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: z.array(SlotRowSchema),
  },
  "slot.get": {
    args: z.tuple([z.string()]),
    description: "Get a single slot row by id.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: SlotRowSchema.nullable(),
  },
  "slot.history": {
    args: z.tuple([z.string()]),
    description: "Get the history for a slot.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: z.array(SlotHistoryRowSchema),
  },
  "entity.resolveActive": {
    args: z.tuple([z.string()]),
    description: "Resolve a single active entity record by id.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: EntityRecordSchema.nullable(),
  },
  "entity.resolve": {
    args: z.tuple([z.string()]),
    description: "Resolve an entity record by id, including a preparing reservation.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: EntityRecordSchema.nullable(),
  },
  "slot.resolveByEntity": {
    args: z.tuple([z.string()]),
    description:
      "Resolve the OPEN slot id whose current entity is the given runtime-entity (nav) id, or null. " +
      "Durable nav→slot mapping used to nest launches under the owning panel's tree slot.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: z.string().nullable(),
  },
  "slot.create": {
    args: z.tuple([SlotCreateInputSchema]),
    description: "Create a new slot row.",
    authority: WORKSPACE_STATE_WRITE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  "slot.commitPreparedNavigation": {
    args: z.tuple([SlotCommitPreparedNavigationInputSchema]),
    description:
      "Atomically append, replace, or select history and swap current to a prepared panel incarnation.",
    authority: WORKSPACE_STATE_WRITE_POLICY,
    access: { sensitivity: "write" },
    returns: SlotCommitPreparedNavigationResultSchema,
  },
  "slot.updateCurrentStateArgs": {
    args: z.tuple([z.string(), z.unknown()]),
    description: "Mutate the stateArgs for a slot's current history entry.",
    authority: WORKSPACE_STATE_WRITE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  "slot.setParent": {
    args: z.tuple([z.string(), z.string().nullable()]),
    description: "Reparent a slot.",
    authority: WORKSPACE_STATE_WRITE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  "slot.setPosition": {
    args: z.tuple([z.string(), z.string()]),
    description: "Update a slot's position rank.",
    authority: WORKSPACE_STATE_WRITE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  "slot.move": {
    args: z.tuple([z.string(), z.string().nullable(), z.string()]),
    description: "Atomically update a slot's parent and position.",
    authority: WORKSPACE_STATE_WRITE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  "slot.close": {
    args: z.tuple([z.string()]),
    description: "Mark a slot closed.",
    authority: WORKSPACE_STATE_WRITE_POLICY,
    access: { sensitivity: "destructive" },
    returns: z.void(),
  },
  "panel.search": {
    args: z.tuple([z.string(), z.number().optional()]),
    description: "FTS5 search over panel entities.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: z.array(PanelSearchResultSchema),
  },
  "panel.index": {
    args: z.tuple([
      z.object({
        id: z.string(),
        title: z.string(),
        path: z.string().optional(),
        manifestDescription: z.string().optional(),
        manifestDependencies: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        keywords: z.array(z.string()).optional(),
      }),
    ]),
    description: "Upsert a panel's search-metadata row.",
    authority: WORKSPACE_STATE_WRITE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  "panel.updateTitle": {
    args: z.tuple([z.string(), z.string()]),
    description: "Update the searchable title for a panel entity.",
    authority: WORKSPACE_STATE_WRITE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  "panel.incrementAccess": {
    args: z.tuple([z.string()]),
    description: "Bump the access counter for a panel entity.",
    authority: WORKSPACE_STATE_WRITE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  "panel.rebuildIndex": {
    args: z.tuple([]),
    description: "Rebuild the panel-search index from active panel entities.",
    authority: WORKSPACE_STATE_WRITE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  lifecycleLeaseUpsert: {
    args: z.tuple([LifecycleLeaseSchema]),
    description: "Mark a Durable Object as having active checkpointable work.",
    authority: WORKSPACE_STATE_LIFECYCLE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  lifecycleLeaseClear: {
    args: z.tuple([LifecycleKeySchema]),
    description: "Clear a Durable Object active-work lease.",
    authority: WORKSPACE_STATE_LIFECYCLE_POLICY,
    access: { sensitivity: "destructive" },
    returns: z.void(),
  },
  alarmSet: {
    args: z.tuple([AlarmSetSchema]),
    description: "Register/replace a Durable Object's server-driven wake time.",
    authority: WORKSPACE_STATE_LIFECYCLE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  alarmClear: {
    args: z.tuple([LifecycleKeySchema]),
    description: "Clear a Durable Object's pending server-driven alarm.",
    authority: WORKSPACE_STATE_LIFECYCLE_POLICY,
    access: { sensitivity: "destructive" },
    returns: z.void(),
  },
  heartbeatRegister: {
    args: z.tuple([HeartbeatRegistryRowSchema]),
    description: "Register or update an agent heartbeat registry row.",
    authority: WORKSPACE_STATE_LIFECYCLE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  heartbeatRemove: {
    args: z.tuple([z.object({ name: z.string().min(1) })]),
    description: "Remove an agent heartbeat registry row.",
    authority: WORKSPACE_STATE_LIFECYCLE_POLICY,
    access: { sensitivity: "destructive" },
    returns: z.void(),
  },
});
