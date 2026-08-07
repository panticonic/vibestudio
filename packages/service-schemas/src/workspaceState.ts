/**
 * workspace-state service method schemas — read/write surface over slot.* and
 * entity.* on WorkspaceDO. Pure-data wire contract shared by the server
 * registration and typed clients.
 *
 * Bounded tree queries, addressed slot reads, and entity resolution are open
 * to all runtime kinds; writes (slot create / commitPreparedNavigation /
 * move / close) are gated to the shipped shell, approved shell app, and
 * server. Panels and workers manipulate slots via runtime.*, not directly here.
 */

import { z } from "zod";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { UnitAuthorityManifestSchema } from "./build.js";
import { contextBoundaryAuthority } from "./authority/contextBoundary.js";

const WORKSPACE_RUNTIME_STATE_PRESENTATION = {
  title: "Manage running workspace services",
  action: "manage apps, panels, background tasks, and scheduled work that's currently running",
  description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
  group: "workspace",
  authorityCategory: { domain: "automation", verb: "manage" },
} as const;

const WORKSPACE_RUNTIME_STATE_INSPECT_PRESENTATION = {
  title: "Inspect running workspace services",
  action: "inspect apps, panels, background tasks, and scheduled work that's currently running",
  description: "Read the current structure and status of running workspace services",
  group: "workspace",
  authorityCategory: { domain: "automation", verb: "see" },
} as const;

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
export type SlotCommitPreparedNavigationInput = z.infer<
  typeof SlotCommitPreparedNavigationInputSchema
>;
export type SlotCommitPreparedNavigationResult = z.infer<
  typeof SlotCommitPreparedNavigationResultSchema
>;

export const SlotCreateInputSchema = z.object({
  slotId: z.string(),
  parentSlotId: z.string().nullable(),
  placement: z
    .object({
      beforeSlotId: z.string().nullable().optional(),
      afterSlotId: z.string().nullable().optional(),
    })
    .strict()
    .optional(),
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
  current_history_cursor: z.number().int().nonnegative().nullable().optional(),
  history_count: z.number().int().nonnegative().optional(),
  sort_key: z.number().int(),
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

export const PanelDetailSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    slot: SlotRowSchema,
    currentHistory: SlotHistoryRowSchema,
    entity: EntityRecordSchema,
  })
  .strict();

const PanelTreeGroupSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("roots"), ownerUserId: z.string().nullable() }).strict(),
  z.object({ kind: z.literal("children"), parentSlotId: z.string() }).strict(),
]);

const PanelTreeNodeSchema = z
  .object({
    slotId: z.string(),
    parentSlotId: z.string().nullable(),
    ownerUserId: z.string().nullable(),
    title: z.string(),
    createdAt: z.number(),
    childCount: z.number().int().nonnegative(),
    source: z.string().optional(),
    kind: z.enum(["workspace", "browser"]).optional(),
    contextId: z.string().optional(),
    runtimeEntityId: z.string().nullable().optional(),
    effectiveVersion: z.string().nullable().optional(),
    buildKey: z.string().nullable().optional(),
    ref: z.string().nullable().optional(),
    placement: z
      .object({
        disposition: z.enum(["side", "replace", "split-below"]).optional(),
        preferredWidth: z.number().positive().optional(),
        minWidth: z.number().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PanelTreePageInputSchema = z
  .object({
    group: PanelTreeGroupSchema,
    cursor: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();

export const PanelTreePageSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    group: PanelTreeGroupSchema,
    nodes: z.array(PanelTreeNodeSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const PanelTreePageWindowSchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();

export const PanelTreeRootGroupsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    groups: z.array(
      z
        .object({
          ownerUserId: z.string().nullable(),
          rootCount: z.number().int().nonnegative(),
        })
        .strict()
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const PanelTreePathSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    nodes: z.array(PanelTreeNodeSchema),
  })
  .strict();

export const PanelTreeSearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(2_000),
    cursor: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();

export const PanelTreeSearchPageSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    hits: z.array(
      z
        .object({
          node: PanelTreeNodeSchema,
          ancestors: z.array(PanelTreeNodeSchema),
          ancestorsTruncated: z.boolean().optional(),
        })
        .strict()
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const PanelTreePlacementSchema = z
  .object({
    beforeSlotId: z.string().nullable().optional(),
    afterSlotId: z.string().nullable().optional(),
  })
  .strict();

export const workspaceStateMethods = defineServiceMethods({
  "panelTree.rootGroups": {
    agentFacing: false,
    capability: "workspace.runtime-state.inspect",
    presentation: WORKSPACE_RUNTIME_STATE_INSPECT_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Bounded durable ownership census over the builtin slot topology used to select an exact account forest",
    },
    args: z.tuple([PanelTreePageWindowSchema]),
    description:
      "Low-level owner-band census; this returns owners and counts, not panels. Runtime eval should use panelTree.rootOwners().",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: PanelTreeRootGroupsSchema,
  },
  "panelTree.rootsForCaller": {
    agentFacing: false,
    capability: "workspace.runtime-state.inspect",
    presentation: WORKSPACE_RUNTIME_STATE_INSPECT_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Bounded durable root projection scoped by the server-verified subject instead of a caller-supplied owner id",
    },
    args: z.tuple([PanelTreePageWindowSchema]),
    description:
      "Low-level transport behind runtime panelTree.roots(); read one bounded root-panel page scoped to the verified caller subject.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: PanelTreePageSchema,
  },
  "panelTree.page": {
    agentFacing: false,
    capability: "workspace.runtime-state.inspect",
    presentation: WORKSPACE_RUNTIME_STATE_INSPECT_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Bounded durable parent/child and ownership projection from the builtin slot identity authority",
    },
    args: z.tuple([PanelTreePageInputSchema]),
    description:
      "Advanced exact-group sibling page. Runtime eval should prefer roots(), rootsForOwner(), or children(); direct calls require {kind:'roots', ownerUserId} or {kind:'children', parentSlotId}.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: PanelTreePageSchema,
  },
  "panelTree.path": {
    agentFacing: false,
    capability: "workspace.runtime-state.inspect",
    presentation: WORKSPACE_RUNTIME_STATE_INSPECT_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Bounded durable ancestry projection used to preserve the exact slot ownership and context boundary",
    },
    args: z.tuple([z.string()]),
    description: "Read the bounded root-to-slot path for one open panel.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: PanelTreePathSchema.nullable(),
  },
  "panelTree.detail": {
    agentFacing: false,
    capability: "workspace.runtime-state.inspect",
    presentation: WORKSPACE_RUNTIME_STATE_INSPECT_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Exact durable slot/history/entity join used to attest the active panel identity and context",
    },
    args: z.tuple([z.string()]),
    description: "Read the current runtime detail for one open panel without its siblings/history.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: PanelDetailSchema.nullable(),
  },
  "panelTree.search": {
    agentFacing: false,
    capability: "workspace.runtime-state.inspect",
    presentation: WORKSPACE_RUNTIME_STATE_INSPECT_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "workspace-state.builtin-rpc",
      rationale:
        "Exact typed proxy to the builtin topology owner for one bounded indexed presentation query",
    },
    args: z.tuple([PanelTreeSearchInputSchema]),
    description: "Keyset-page full-text title matches with their ancestor breadcrumbs.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: PanelTreeSearchPageSchema,
  },
  "slot.get": {
    agentFacing: false,
    capability: "workspace.runtime-state.inspect",
    presentation: WORKSPACE_RUNTIME_STATE_INSPECT_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "The stable slot-to-entity/context binding is an input to caller ancestry and context-boundary enforcement",
    },
    args: z.tuple([z.string()]),
    description: "Get a single slot row by id.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: SlotRowSchema.nullable(),
  },
  "slot.historyRelative": {
    agentFacing: false,
    capability: "workspace.runtime-state.inspect",
    presentation: WORKSPACE_RUNTIME_STATE_INSPECT_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "workspace-state.builtin-rpc",
      rationale:
        "Exact typed proxy to the builtin topology owner for one bounded adjacent-history read",
    },
    args: z.tuple([z.string(), z.union([z.literal(-1), z.literal(1)])]),
    description: "Read the adjacent history entry relative to a slot's current cursor.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: SlotHistoryRowSchema.nullable(),
  },
  "slot.historyEntry": {
    agentFacing: false,
    capability: "workspace.runtime-state.inspect",
    presentation: WORKSPACE_RUNTIME_STATE_INSPECT_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "The exact stored destination context is an input to context-boundary enforcement before history selection",
    },
    args: z.tuple([z.string(), z.string()]),
    description: "Read one exact history entry belonging to a slot.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: SlotHistoryRowSchema.nullable(),
  },
  "entity.resolveActive": {
    agentFacing: false,
    capability: "workspace.runtime-state.inspect",
    presentation: WORKSPACE_RUNTIME_STATE_INSPECT_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "The active entity incarnation is an input to runtime attestation and caller identity",
    },
    args: z.tuple([z.string()]),
    description: "Resolve a single active entity record by id.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: EntityRecordSchema.nullable(),
  },
  "entity.resolve": {
    agentFacing: false,
    capability: "workspace.runtime-state.inspect",
    presentation: WORKSPACE_RUNTIME_STATE_INSPECT_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "The reserved or active entity incarnation is an input to runtime attestation and caller identity",
    },
    args: z.tuple([z.string()]),
    description: "Resolve an entity record by id, including a preparing reservation.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: EntityRecordSchema.nullable(),
  },
  "slot.resolveByEntity": {
    agentFacing: false,
    capability: "workspace.runtime-state.inspect",
    presentation: WORKSPACE_RUNTIME_STATE_INSPECT_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "The entity-to-slot binding determines runtime ancestry and the context-boundary target",
    },
    args: z.tuple([z.string()]),
    description:
      "Resolve the OPEN slot id whose current entity is the given runtime-entity (nav) id, or null. " +
      "Durable nav→slot mapping used to nest launches under the owning panel's tree slot.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: z.string().nullable(),
  },
  "slot.create": {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Creating a stable slot records the ownership and ancestry identity used by panel access enforcement",
    },
    args: z.tuple([SlotCreateInputSchema]),
    description: "Create a new slot row.",
    authority: contextBoundaryAuthority({
      service: "workspace-state",
      method: "slot.create",
      primaryCapability: "workspace.runtime-state.manage",
      principals: ["user", "code", "host"],
      operation: "openPanel",
      targetPath: ["parentSlotId"],
      tier: "gated",
    }),
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  "slot.commitPreparedNavigation": {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "The prepared commit atomically changes the slot-to-entity/context identity consumed by access enforcement",
    },
    args: z.tuple([SlotCommitPreparedNavigationInputSchema]),
    description:
      "Commit prepared panel history and publish the slot's desired runtime entity for presentation reconciliation.",
    authority: contextBoundaryAuthority({
      service: "workspace-state",
      method: "slot.commitPreparedNavigation",
      primaryCapability: "workspace.runtime-state.manage",
      principals: ["user", "code", "host"],
      operation: "replacePanel",
      targetPath: ["slotId"],
      requestedContextPath: ["mutation", "entry", "contextId"],
      requestedContextLookup: {
        method: "slotHistoryEntry",
        arguments: [
          { argument: 0, path: ["slotId"] },
          { argument: 0, path: ["mutation", "entryKey"] },
        ],
        resultPath: ["context_id"],
      },
      tier: "gated",
    }),
    access: { sensitivity: "write" },
    returns: SlotCommitPreparedNavigationResultSchema,
  },
  "slot.updateCurrentStateArgs": {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "workspace-state.builtin-rpc",
      rationale:
        "Exact typed proxy to the builtin topology owner for one receiver-validated current-entry update",
    },
    args: z.tuple([z.string(), z.unknown()]),
    description: "Mutate the stateArgs for a slot's current history entry.",
    authority: contextBoundaryAuthority({
      service: "workspace-state",
      method: "slot.updateCurrentStateArgs",
      primaryCapability: "workspace.runtime-state.manage",
      principals: ["user", "code", "host"],
      operation: "updatePanelState",
      tier: "gated",
    }),
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  "slot.move": {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Reparenting changes stable panel ancestry and owning-user identity consumed by access enforcement",
    },
    args: z.tuple([z.string(), z.string().nullable(), PanelTreePlacementSchema.optional()]),
    description: "Atomically reparent a slot and place it using stable sibling anchors.",
    authority: contextBoundaryAuthority({
      service: "workspace-state",
      method: "slot.move",
      primaryCapability: "workspace.runtime-state.manage",
      principals: ["user", "code", "host"],
      operation: "movePanel",
      tier: "gated",
    }),
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  "slot.close": {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Closing a subtree retires its stable ownership and ancestry identities atomically",
    },
    args: z.tuple([z.string()]),
    description:
      "Atomically close a subtree and enqueue its runtime cleanup without materializing descendants.",
    authority: contextBoundaryAuthority({
      service: "workspace-state",
      method: "slot.close",
      primaryCapability: "workspace.runtime-state.manage",
      principals: ["user", "code", "host"],
      operation: "close",
      tier: "gated",
    }),
    access: { sensitivity: "destructive" },
    returns: z
      .object({ closeId: z.string(), closedCount: z.number().int().nonnegative() })
      .strict(),
  },
  "slot.closeCleanupPage": {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace-state.cleanup",
      rationale: "Bounded durable retirement work is consumed by the runtime cleanup supervisor",
    },
    args: z.tuple([
      z
        .object({
          closeId: z.string().optional(),
          ownerUserId: z.string().nullable().optional(),
          cursor: z.string().optional(),
          limit: z.number().int().positive().max(200).optional(),
        })
        .strict(),
    ]),
    description: "Read one bounded page of durable post-close runtime cleanup work.",
    authority: WORKSPACE_STATE_WRITE_POLICY,
    access: { sensitivity: "destructive" },
    returns: z
      .object({
        items: z.array(z.object({ slotId: z.string(), entityId: z.string().nullable() }).strict()),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  },
  "slot.closeOwnedRoots": {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Account revocation atomically closes only roots carrying the revoked durable owner identity",
    },
    args: z.tuple([z.string().min(1)]),
    description: "Close every open root owned by one revoked workspace user.",
    authority: { principals: ["host"] },
    access: { sensitivity: "destructive" },
    returns: z
      .object({
        rootIds: z.array(z.string()),
        closedIds: z.array(z.string()),
      })
      .strict(),
  },
  "slot.closeCleanupAck": {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace-state.cleanup",
      rationale: "Acknowledgement advances the durable runtime cleanup supervisor queue",
    },
    args: z.tuple([z.array(z.string()).max(200)]),
    description: "Acknowledge successfully completed post-close cleanup items.",
    authority: WORKSPACE_STATE_WRITE_POLICY,
    access: { sensitivity: "destructive" },
    returns: z.void(),
  },
  "panel.search": {
    agentFacing: false,
    capability: "workspace.runtime-state.inspect",
    presentation: WORKSPACE_RUNTIME_STATE_INSPECT_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "workspace-state.lifecycle",
      rationale: "Workspace-member panel-index read; no C1-C4 or G1-G5 rule applies",
    },
    args: z.tuple([z.string(), z.number().optional()]),
    description: "FTS5 search over panel entities.",
    authority: WORKSPACE_STATE_READ_POLICY,
    access: { sensitivity: "read" },
    returns: z.array(PanelSearchResultSchema),
  },
  "panel.index": {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace-state.lifecycle",
      rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
    },
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
    returns: z.string().nullable(),
  },
  "panel.updateTitle": {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "workspace-state.builtin-rpc",
      rationale:
        "Exact typed proxy to the builtin topology owner for one slot-bound presentation update",
    },
    args: z.tuple([
      z.string(),
      z.string(),
      z.object({ explicit: z.boolean().optional() }).strict().optional(),
    ]),
    description: "Update the searchable title for a panel entity.",
    authority: contextBoundaryAuthority({
      service: "workspace-state",
      method: "panel.updateTitle",
      primaryCapability: "workspace.runtime-state.manage",
      principals: ["user", "code", "host"],
      operation: "updatePanelState",
      tier: "gated",
    }),
    access: { sensitivity: "write" },
    returns: z.string().nullable(),
  },
  "panel.incrementAccess": {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace-state.lifecycle",
      rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
    },
    args: z.tuple([z.string()]),
    description: "Bump the access counter for a panel entity.",
    authority: WORKSPACE_STATE_WRITE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  "panel.rebuildIndex": {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace-state.lifecycle",
      rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
    },
    args: z.tuple([]),
    description: "Rebuild the panel-search index from active panel entities.",
    authority: WORKSPACE_STATE_WRITE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  lifecycleLeaseUpsert: {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "workspace-state.supervision",
      rationale:
        "Runtime-intrinsic self-lease tracking is not discretionary authority; the receiver requires an exact DO lifecycle-key match or a host-originated call",
    },
    args: z.tuple([LifecycleLeaseSchema]),
    description: "Mark a Durable Object as having active checkpointable work.",
    authority: WORKSPACE_STATE_LIFECYCLE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  lifecycleLeaseClear: {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "workspace-state.supervision",
      rationale:
        "Runtime-intrinsic self-lease cleanup is not discretionary authority; the receiver requires an exact DO lifecycle-key match or a host-originated call",
    },
    args: z.tuple([LifecycleKeySchema]),
    description: "Clear a Durable Object active-work lease.",
    authority: WORKSPACE_STATE_LIFECYCLE_POLICY,
    access: { sensitivity: "destructive" },
    returns: z.void(),
  },
  alarmSet: {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "workspace-state.supervision",
      rationale:
        "Runtime-intrinsic self-alarm scheduling is not discretionary authority; the receiver requires an exact DO lifecycle-key match or a host-originated call",
    },
    args: z.tuple([AlarmSetSchema]),
    description: "Register/replace a Durable Object's server-driven wake time.",
    authority: WORKSPACE_STATE_LIFECYCLE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  alarmClear: {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "workspace-state.supervision",
      rationale:
        "Runtime-intrinsic self-alarm cleanup is not discretionary authority; the receiver requires an exact DO lifecycle-key match or a host-originated call",
    },
    args: z.tuple([LifecycleKeySchema]),
    description: "Clear a Durable Object's pending server-driven alarm.",
    authority: WORKSPACE_STATE_LIFECYCLE_POLICY,
    access: { sensitivity: "destructive" },
    returns: z.void(),
  },
  heartbeatRegister: {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "supervision",
      family: "workspace-state.lifecycle",
      rationale: "The durable heartbeat row schedules and supervises a reviewed recurring runtime",
    },
    args: z.tuple([HeartbeatRegistryRowSchema]),
    description: "Register or update an agent heartbeat registry row.",
    authority: WORKSPACE_STATE_LIFECYCLE_POLICY,
    access: { sensitivity: "write" },
    returns: z.void(),
  },
  heartbeatRemove: {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: WORKSPACE_RUNTIME_STATE_PRESENTATION,
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "supervision",
      family: "workspace-state.lifecycle",
      rationale: "Removing the durable heartbeat row retires a reviewed recurring runtime schedule",
    },
    args: z.tuple([z.object({ name: z.string().min(1) })]),
    description: "Remove an agent heartbeat registry row.",
    authority: WORKSPACE_STATE_LIFECYCLE_POLICY,
    access: { sensitivity: "destructive" },
    returns: z.void(),
  },
});
