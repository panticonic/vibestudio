/**
 * panelTree service method schemas.
 *
 * The panelTree service is the single server-owned authority for panel slot
 * creation, navigation, lifecycle commands, and tree metadata.
 */

import { z } from "zod";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import {
  MovePanelRequestSchema,
  PanelDiagnosticPacketSchema,
  PanelObservationSchema,
  PanelFocusResultSchema,
  PanelLifecycleResultSchema,
  PanelNavigationStateSchema,
  PanelRuntimeLeaseSchema,
  PanelSnapshotObservationSchema,
  PanelTreeSnapshotSchema,
} from "@vibestudio/shared/panelContracts";
import { JsonObjectSchema, JsonValueSchema } from "@vibestudio/shared/wireValues";

// Access descriptors classify panel-tree operations. The service and method
// authority declarations own their compositional principal requirements.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const CLOSE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "destructive",
};
const ARCHIVE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "destructive",
};

function navigationAuthority(method: "navigate" | "navigateHistory") {
  const capability = `service:panelTree.${method}`;
  const commitCapability = "service:workspace-state.slot.commitPreparedNavigation";
  return {
    requirement: requirementForPrincipals(["code", "user", "host"], capability),
    resource: { kind: "literal" as const, key: capability },
    additional: [
      {
        capability: commitCapability,
        requirement: requirementForPrincipals(["code", "user", "host"], commitCapability),
        resource: { kind: "literal" as const, key: commitCapability },
      },
    ],
    prepared: panelBoundaryPrepared(method),
  };
}

function panelBoundaryPrepared(method: string) {
  return {
    resolver: `panelTree.${method}.contextBoundary`,
    leaves: [
      {
        capability: "context.boundary",
        requirement: requirementForPrincipals(["code", "user", "host"], "context.boundary"),
        tier: { selectedFrom: ["gated", "critical"] as const },
      },
    ],
  };
}

function panelBoundaryAuthority(method: string) {
  const capability = `service:panelTree.${method}`;
  return {
    requirement: requirementForPrincipals(["code", "user", "host"], capability),
    resource: { kind: "literal" as const, key: capability },
    prepared: panelBoundaryPrepared(method),
  };
}

const PanelIdSchema = z.string();
export const PanelPlacementHintSchema = z.object({
  disposition: z
    .enum(["side", "replace", "split-below"])
    .optional()
    .describe("How the panel wants to be placed relative to its parent; default side."),
  preferredWidth: z.number().positive().optional().describe("Preferred column width in px."),
  minWidth: z.number().positive().optional().describe("Minimum column width in px."),
});
const StateArgsSchema = z.record(z.unknown());
// The list/handle APIs intentionally expose lightweight slot metadata, not the
// recursive persisted Panel record used by getTreeSnapshot. Keeping these wire
// contracts distinct prevents handle hydration from being coupled to internal
// tree/history/artifact storage fields.
const PanelListItemSchema = z.object({
  panelId: z.string(),
  title: z.string(),
  source: z.string(),
  kind: z.enum(["workspace", "browser"]),
  parentId: z.string().nullable(),
  contextId: z.string(),
  runtimeEntityId: z.string().nullable().optional(),
  effectiveVersion: z.string().nullable().optional(),
  buildKey: z.string().nullable().optional(),
  ref: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
});
const PanelMetadataSchema = z.object({
  id: z.string(),
  title: z.string(),
  source: z.string(),
  kind: z.enum(["workspace", "browser"]),
  parentId: z.string().nullable(),
  contextId: z.string(),
  runtimeEntityId: z.string().nullable().optional(),
  effectiveVersion: z.string().nullable().optional(),
  buildKey: z.string().nullable().optional(),
  ref: z.string().nullable().optional(),
  privileged: z.boolean().optional(),
});
const CreateResultSchema = z.object({
  id: z.string().describe("Stable panel/slot id of the created panel."),
  title: z.string().describe("Display title resolved for the panel."),
  parentId: z
    .string()
    .nullable()
    .optional()
    .describe("Stable parent panel/slot id, or null for a root panel."),
  kind: z
    .enum(["browser", "workspace"])
    .optional()
    .describe("Panel surface kind: an external browser view or a workspace runtime."),
  contextId: z.string().optional().describe("Resolved storage-isolation context id."),
  source: z.string().optional().describe("Workspace-relative source path that backs the panel."),
  runtimeEntityId: z
    .string()
    .optional()
    .describe("Identifier of the runtime entity bound to the panel, when loaded."),
  effectiveVersion: z
    .string()
    .nullable()
    .optional()
    .describe("Resolved code version serving the panel, or null when unversioned."),
  buildKey: z
    .string()
    .nullable()
    .optional()
    .describe("Exact immutable BuildV2 artifact selected for the panel."),
  observation: PanelObservationSchema.describe(
    "Canonical boot-ready observation established before create returns."
  ),
});

export const PanelTreeCreateOptionsSchema = z
  .object({
    parentId: z
      .string()
      .nullable()
      .optional()
      .describe("Parent panel id to nest under; null/omitted creates a root-level panel."),
    name: z.string().optional().describe("Optional display name override for the new panel."),
    focus: z.boolean().optional().describe("Focus the new panel immediately after creation."),
    contextId: z
      .string()
      .optional()
      .describe("Storage-isolation context id to create the panel in."),
    ref: z.string().optional().describe("Optional git-style ref / version pin for the source."),
    stateArgs: StateArgsSchema.optional().describe(
      "Initial validated state-args passed to the panel runtime."
    ),
    placement: PanelPlacementHintSchema.optional().describe(
      "Layout placement hint for the new panel; overrides the manifest's placement default."
    ),
  })
  .optional();

export const PanelTreeFocusOptionsSchema = z.object({
  placement: PanelPlacementHintSchema.optional().describe(
    "Visual placement request for the panel; omitted preserves ordinary focus behavior."
  ),
  anchorPanelId: z
    .string()
    .optional()
    .describe(
      "Panel to place the target relative to; defaults to the panel focused before this request."
    ),
});

export const PanelTreeNavigateOptionsSchema = z
  .object({
    ref: z.string().optional().describe("Optional ref / version pin to navigate the panel to."),
    contextId: z
      .string()
      .optional()
      .describe("Storage-isolation context id to navigate into (changes data scope)."),
    env: z.record(z.string()).optional().describe("Environment variables to pass to the runtime."),
    stateArgs: StateArgsSchema.optional().describe(
      "Validated state-args supplied to the navigated panel."
    ),
  })
  .optional();

export const panelTreeMethods = defineServiceMethods({
  list: {
    description:
      "List the children of a panel (or the root panels when the parent id is null/omitted).",
    args: z.tuple([z.string().nullable().optional()]),
    returns: z.array(PanelListItemSchema),
    access: READ_ACCESS,
  },
  roots: {
    description: "List all root-level panels in the tree.",
    args: z.tuple([]),
    returns: z.array(PanelListItemSchema),
    access: READ_ACCESS,
  },
  getTreeSnapshot: {
    description: "Return a full snapshot of the panel tree (revision plus root panels).",
    args: z.tuple([]),
    returns: PanelTreeSnapshotSchema,
    access: READ_ACCESS,
    // `agent` (linked external sessions): tree enumeration is the discovery
    // step of the CLI panel screenshot/console loop. Read-only widening; every
    // mutating panelTree op stays closed to entity-only authority.
    authority: { principals: ["code", "user", "host"] },
  },
  getFocusedPanelId: {
    description: "Return the id of the currently focused panel, or null if none is focused.",
    args: z.tuple([]),
    returns: z.string().nullable(),
    access: READ_ACCESS,
  },
  create: {
    description:
      "Create a new panel from a workspace source path, optionally nested under a parent and focused.",
    args: z.tuple([z.string(), PanelTreeCreateOptionsSchema]),
    returns: CreateResultSchema,
    authority: panelBoundaryAuthority("create"),
    access: WRITE_ACCESS,
    examples: [{ args: ["panels/chat", { focus: true }] }],
  },
  ensureLoaded: {
    description:
      "Internal host assignment primitive; application callers use readiness-bearing handle operations.",
    args: z.tuple([PanelIdSchema]),
    returns: PanelFocusResultSchema,
    access: WRITE_ACCESS,
    authority: { principals: ["host"] },
  },
  focus: {
    description:
      "Focus a panel and return only after its current attempt is boot-ready; throws the canonical structured failure otherwise.",
    args: z.union([
      z.tuple([PanelIdSchema]),
      z.tuple([PanelIdSchema, PanelTreeFocusOptionsSchema]),
    ]),
    returns: PanelObservationSchema,
    access: WRITE_ACCESS,
  },
  getRuntimeLease: {
    description:
      "Internal host lease read. Application readiness is reported only by observe().",
    args: z.tuple([PanelIdSchema]),
    returns: PanelRuntimeLeaseSchema.nullable(),
    access: READ_ACCESS,
    authority: { principals: ["host"] },
  },
  observe: {
    description:
      "Return the canonical current panel attempt, including exact provenance, host/boot state, and structured failure.",
    args: z.tuple([PanelIdSchema]),
    returns: PanelObservationSchema,
    access: READ_ACCESS,
  },
  diagnose: {
    description:
      "Return one bounded diagnostic packet with the canonical observation, host lifecycle/console history, and a document capture when ready.",
    args: z.tuple([PanelIdSchema]),
    returns: PanelDiagnosticPacketSchema,
    access: READ_ACCESS,
  },
  getStateArgs: {
    description: "Return the validated state-args currently bound to a panel.",
    args: z.tuple([PanelIdSchema]),
    returns: JsonObjectSchema,
    access: READ_ACCESS,
  },
  setStateArgs: {
    description:
      "Merge a patch into a panel's ordinary application state (null removes a key); returns the full resulting validated state. contextId is reserved for the panel's host-bound workspace branch and must be changed through explicit panel navigation, never state args.",
    args: z.tuple([PanelIdSchema, StateArgsSchema]),
    returns: JsonObjectSchema,
    authority: panelBoundaryAuthority("setStateArgs"),
    access: WRITE_ACCESS,
  },
  reload: {
    description:
      "Reload a panel's view and return only after that exact attempt is boot-ready; throws the canonical structured failure otherwise.",
    args: z.tuple([PanelIdSchema]),
    returns: PanelObservationSchema,
    authority: panelBoundaryAuthority("reload"),
    access: WRITE_ACCESS,
  },
  close: {
    description: "Close a panel, removing it (and its subtree) from the tree.",
    args: z.tuple([PanelIdSchema]),
    returns: PanelLifecycleResultSchema,
    authority: panelBoundaryAuthority("close"),
    access: CLOSE_ACCESS,
  },
  archive: {
    description: "Archive a panel, removing it from the active tree while preserving its history.",
    args: z.tuple([PanelIdSchema]),
    returns: PanelLifecycleResultSchema,
    authority: panelBoundaryAuthority("archive"),
    access: ARCHIVE_ACCESS,
  },
  archiveOwnedRoots: {
    description: "Internal revocation cleanup: archive every root owned by one account.",
    args: z.tuple([z.string().min(1)]),
    returns: z.object({
      archivedRootIds: z.array(z.string()),
      closedIds: z.array(z.string()),
    }),
    access: ARCHIVE_ACCESS,
    authority: { principals: ["host"] },
  },
  unload: {
    description:
      "Unload a panel's runtime/view to free resources while keeping the panel in the tree.",
    args: z.tuple([PanelIdSchema]),
    returns: PanelLifecycleResultSchema,
    authority: panelBoundaryAuthority("unload"),
    access: WRITE_ACCESS,
  },
  movePanel: {
    description: "Reparent and/or reposition a panel among its siblings (drag-and-drop move).",
    args: z.tuple([MovePanelRequestSchema]),
    returns: z.void(),
    authority: panelBoundaryAuthority("movePanel"),
    access: WRITE_ACCESS,
    examples: [{ args: [{ panelId: "panel-1", newParentId: null, targetPosition: 0 }] }],
  },
  navigate: {
    description:
      "Transactionally navigate to a prepared runtime and return only after the new attempt is boot-ready.",
    args: z.tuple([PanelIdSchema, z.string(), PanelTreeNavigateOptionsSchema]),
    returns: CreateResultSchema.nullable(),
    access: WRITE_ACCESS,
    authority: navigationAuthority("navigate"),
    examples: [{ args: ["panel-1", "panels/chat"] }],
  },
  navigateHistory: {
    description:
      "Move a panel backward (-1) or forward (1) through its navigation history, returning the resulting panel descriptor or null.",
    args: z.tuple([PanelIdSchema, z.union([z.literal(-1), z.literal(1)])]),
    returns: CreateResultSchema.nullable(),
    access: WRITE_ACCESS,
    authority: navigationAuthority("navigateHistory"),
    examples: [{ args: ["panel-1", -1] }],
  },
  takeOver: {
    description:
      "Take over a panel's runtime lease for the calling client, focusing it on this host.",
    args: z.tuple([PanelIdSchema]),
    returns: PanelFocusResultSchema,
    authority: panelBoundaryAuthority("takeOver"),
    access: WRITE_ACCESS,
  },
  openDevTools: {
    description: "Open developer tools for a panel, optionally docked to a side or detached.",
    args: z.tuple([PanelIdSchema, z.enum(["detach", "right", "bottom"]).optional()]),
    returns: z.void(),
    authority: panelBoundaryAuthority("openDevTools"),
    access: WRITE_ACCESS,
  },
  rebuildPanel: {
    description:
      "Transactionally replace the current runtime from source and return only after the new attempt is boot-ready.",
    args: z.tuple([PanelIdSchema]),
    returns: PanelObservationSchema,
    authority: panelBoundaryAuthority("rebuildPanel"),
    access: WRITE_ACCESS,
  },
  updatePanelState: {
    description:
      "Update a panel's live navigation state (url, page title, loading/back/forward flags) from the rendering surface.",
    args: z.tuple([PanelIdSchema, PanelNavigationStateSchema]),
    returns: z.void(),
    authority: panelBoundaryAuthority("updatePanelState"),
    access: WRITE_ACCESS,
  },
  snapshot: {
    description:
      "Wait for the current panel attempt to become boot-ready, then capture a provenance-bearing readable document; throws the canonical structured failure otherwise.",
    args: z.tuple([PanelIdSchema]),
    returns: PanelSnapshotObservationSchema,
    access: READ_ACCESS,
  },
  callAgent: {
    description:
      "Invoke a panel's in-process agent method (e.g. _agent.snapshot/_agent.tree/_agent.setMode) with optional arguments.",
    args: z.tuple([PanelIdSchema, z.string(), z.array(z.unknown()).optional()]),
    returns: JsonValueSchema.optional(),
    authority: panelBoundaryAuthority("callAgent"),
    access: WRITE_ACCESS,
    examples: [{ args: ["panel-1", "_agent.snapshot"] }],
  },
  metadata: {
    description:
      "Return lightweight runtime-handle metadata for a panel id, or null if it does not exist.",
    args: z.tuple([PanelIdSchema]),
    returns: PanelMetadataSchema.nullable(),
    access: READ_ACCESS,
    // Read-only widening for entity authority (see getTreeSnapshot).
    authority: { principals: ["code", "user", "host"] },
  },
  getCollapsedIds: {
    description: "Return the ids of panels that are currently collapsed in the tree UI.",
    args: z.tuple([]),
    returns: z.array(z.string()),
    access: READ_ACCESS,
  },
  setCollapsed: {
    description: "Set whether a panel is collapsed in the tree UI.",
    args: z.tuple([PanelIdSchema, z.boolean()]),
    returns: z.void(),
    authority: panelBoundaryAuthority("setCollapsed"),
    access: WRITE_ACCESS,
    examples: [{ args: ["panel-1", true] }],
  },
  expandIds: {
    description: "Expand (un-collapse) a set of panels in the tree UI.",
    args: z.tuple([z.array(PanelIdSchema)]),
    returns: z.void(),
    authority: panelBoundaryAuthority("expandIds"),
    access: WRITE_ACCESS,
    examples: [{ args: [["panel-1", "panel-2"]] }],
  },
});
