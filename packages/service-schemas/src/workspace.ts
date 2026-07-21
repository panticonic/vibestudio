/**
 * workspace service method schemas — current-workspace configuration,
 * lifecycle, units, and host targets. Server-wide workspace discovery and
 * routing belong to the stable `hubControl` service, never to a workspace
 * child.
 * contract shared by the server registration (`src/server/services/
 * workspaceService.ts`) and the typed client (`clients/workspaceClient.ts`).
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { JsonObjectSchema, JsonValueSchema } from "@vibestudio/shared/wireValues";
import type {
  HostTarget,
  HostTargetCandidate,
  HostTargetLaunchResult as SharedHostTargetLaunchResult,
  HostTargetLaunchSessionSnapshot,
  HostTargetSelection,
  HostTargetSelectionInput,
} from "@vibestudio/shared/hostTargets";
import { WorkspaceConfigSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { WorkspaceNode } from "@vibestudio/shared/types";
import { APP_CAPABILITIES_BY_TARGET } from "@vibestudio/shared/unitManifest";
import { pendingUnitBatchApprovalSchema } from "./shellApproval.js";
import { CapabilityScopeSchema } from "./build.js";
import { EvalAuthorityDelegationSchema } from "./authority/evalDelegation.js";

// ─── Access descriptors ───────────────────────────────────────────────────────
// Mirrors the blobstore idiom of a shared `*_ACCESS` constant for the pure-read
// methods (which all share identical access metadata). Caller-kind authorization
// belongs exclusively to the service/method `policy`; this descriptor carries
// sensitivity metadata only. Mutators
// declare a method-specific `access.sensitivity` inline rather than sharing a
// generic constant.

/** Pure read: no writes, safe to retry. */
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};

// ─── Host target schemas ──────────────────────────────────────────────────────
// Structural shapes live in `@vibestudio/shared/hostTargets`; these zod wrappers bind the
// wire schemas to those types without redefining them field-for-field.

export const HostTargetSchema = z.enum([
  "electron",
  "react-native",
  "terminal",
]) satisfies z.ZodType<HostTarget>;

export const HostTargetSelectionInputSchema = z.object({
  source: z.string().min(1),
  mode: z.enum(["follow-ref", "pinned-build", "pinned-ref"]).optional(),
  ref: z.string().min(1).optional(),
  buildKey: z.string().min(1).optional(),
  autoSelected: z.boolean().optional(),
}) satisfies z.ZodType<HostTargetSelectionInput>;

export const HostTargetSelectionSchema = z
  .object({
    workspaceId: z.string(),
    target: HostTargetSchema,
    source: z.string(),
    appId: z.string(),
    mode: z.enum(["follow-ref", "pinned-build", "pinned-ref"]),
    ref: z.string().optional(),
    buildKey: z.string().optional(),
    updatedAt: z.number(),
    autoSelected: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<HostTargetSelection>;

export const HostTargetCandidateSchema = z
  .object({
    name: z.string(),
    source: z.string(),
    displayName: z.string().optional(),
    target: HostTargetSchema,
    declared: z.boolean(),
    status: z.enum([
      "not-built",
      "pending-approval",
      "building",
      "available",
      "running",
      "stopped",
      "error",
    ]),
    activeEv: z.string().nullable().optional(),
    activeBundleKey: z.string().nullable().optional(),
    capabilities: z.array(z.string()),
    canRollback: z.boolean(),
    previousVersions: z.array(JsonValueSchema),
    lastError: z.string().nullable().optional(),
    lastErrorDetails: JsonValueSchema.optional(),
    compatibility: z
      .object({
        selectable: z.boolean(),
        reasons: z.array(z.string()),
        recommended: z.boolean(),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<HostTargetCandidate>;

/** Result shape of `hostTargets.getSelection`. */
export const HostTargetSelectionStatusSchema = z.object({
  selection: HostTargetSelectionSchema.nullable(),
  valid: z.boolean(),
  reason: z.string().optional(),
});
export type HostTargetSelectionStatus = z.infer<typeof HostTargetSelectionStatusSchema>;

const AppCapabilitySchema = z.enum([
  ...APP_CAPABILITIES_BY_TARGET.electron,
  ...APP_CAPABILITIES_BY_TARGET["react-native"],
  ...APP_CAPABILITIES_BY_TARGET.terminal,
]);

export const HostTargetLaunchResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      launched: z.literal(true),
      target: HostTargetSchema,
      source: z.string(),
      appId: z.string(),
      buildKey: z.string(),
      artifactRoute: z.string().optional(),
      capabilities: z.array(AppCapabilitySchema).optional(),
      effectiveVersion: z.string().nullable().optional(),
      executionDigest: z.string().regex(/^[0-9a-f]{64}$/),
      authorityRequests: z.array(CapabilityScopeSchema).readonly(),
      authorityDelegations: z.array(EvalAuthorityDelegationSchema).readonly(),
      adoptionPolicy: z.enum(["immediate", "prompt", "artifact-only"]).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("approval-required"),
      launched: z.literal(false),
      target: HostTargetSchema,
      approvals: z.array(pendingUnitBatchApprovalSchema),
    })
    .strict(),
  z
    .object({
      status: z.literal("preparing"),
      launched: z.literal(false),
      target: HostTargetSchema,
      reason: z.string(),
      details: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      launched: z.literal(false),
      target: HostTargetSchema,
      reason: z.string(),
      details: z.array(z.string()),
    })
    .strict(),
]) satisfies z.ZodType<SharedHostTargetLaunchResult>;
export type HostTargetLaunchResult = z.infer<typeof HostTargetLaunchResultSchema>;

const HostTargetLaunchTimelinePhaseSchema = z
  .object({
    id: z.enum([
      "pair",
      "review-trust",
      "start-units",
      "build-app",
      "activate-target",
      "connected",
    ]),
    label: z.string(),
    state: z.enum(["pending", "active", "complete", "blocked", "failed", "skipped"]),
    detail: z.string().optional(),
  })
  .strict();

const HostTargetLaunchApprovalViewSchema = z
  .object({
    approvalId: z.string(),
    title: z.string(),
    summary: z.string(),
    chips: z.array(z.string()),
    units: z.array(
      z
        .object({
          name: z.string(),
          source: z.string(),
          capabilities: z.string(),
          kind: z.string(),
        })
        .strict()
    ),
  })
  .strict();

export const HostTargetLaunchSessionSnapshotSchema = z
  .object({
    sessionId: z.string(),
    target: HostTargetSchema,
    status: z.enum([
      "starting",
      "approval-required",
      "preparing",
      "ready",
      "unavailable",
      "denied",
    ]),
    currentPhase: z.enum([
      "pair",
      "review-trust",
      "start-units",
      "build-app",
      "activate-target",
      "connected",
    ]),
    message: z.string(),
    detail: z.string().optional(),
    timeline: z.array(HostTargetLaunchTimelinePhaseSchema),
    approvals: z.array(pendingUnitBatchApprovalSchema),
    approvalViews: z.array(HostTargetLaunchApprovalViewSchema),
    approvalsResolved: z.number().int().nonnegative(),
    launch: HostTargetLaunchResultSchema.optional(),
    startedAt: z.number(),
    updatedAt: z.number(),
    settled: z.boolean(),
  })
  .strict() satisfies z.ZodType<HostTargetLaunchSessionSnapshot>;
export type HostTargetLaunchSession = z.infer<typeof HostTargetLaunchSessionSnapshotSchema>;

// ─── Workspace data schemas ───────────────────────────────────────────────────

export const WorkspaceEntrySchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  lastOpened: z.number(),
});
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;

export const WorkspaceAppVersionRecordSchema = z.object({
  version: z.string(),
  target: z.string(),
  capabilities: z.array(z.string()),
  activeEv: z.string().nullable(),
  activeSourceHash: z.string().nullable(),
  activeBundleKey: z.string(),
  activeDependencyEvs: z.record(z.string()),
  activeExternalDeps: z.record(z.string()),
  activeRuntimeDepsKey: z.string().nullable(),
  activatedAt: z.number(),
});
export type WorkspaceAppVersionRecord = z.infer<typeof WorkspaceAppVersionRecordSchema>;

export const WorkspaceAppVersionsSchema = z.object({
  current: WorkspaceAppVersionRecordSchema.nullable(),
  previous: z.array(WorkspaceAppVersionRecordSchema),
  retentionLimit: z.number(),
});
export type WorkspaceAppVersions = z.infer<typeof WorkspaceAppVersionsSchema>;

export const WorkspaceUnitStatusSchema = z.object({
  name: z.string(),
  kind: z.enum(["panel", "worker", "extension", "app"]),
  source: z.string(),
  displayName: z.string().optional(),
  status: z.enum(["running", "stopped", "error", "pending-approval", "building", "available"]),
  version: z.string().optional(),
  ev: z.string().nullable().optional(),
  activeEv: z.string().nullable().optional(),
  activeBundleKey: z.string().nullable().optional(),
  activeRuntimeDepsKey: z.string().nullable().optional(),
  /** Epoch ms when the currently active build was produced (best-effort; null if unknown). */
  lastBuiltAt: z.number().nullable().optional(),
  /** Worker bindings (DOs, env). Only populated for kind === "worker". */
  bindings: z.record(z.unknown()).nullable().optional(),
  /**
   * Set when an extension install/update approval is currently in flight,
   * so a "running units" panel can surface a "pending approval" affordance
   * without polling the approval queue separately.
   */
  pendingApproval: z.object({ kind: z.string(), submittedAt: z.number() }).nullable().optional(),
  /**
   * Set when current workspace state would change the unit's runtime inputs
   * (a dependency push, an external-dep bump). Driven by needsBuildRefresh
   * for extensions; absent for workers/panels in v1.
   */
  availableUpdate: z
    .object({ reason: z.literal("dependency"), checkedAt: z.number() })
    .nullable()
    .optional(),
  lastError: z.string().nullable().optional(),
  lastErrorDetails: z.unknown().optional(),
  target: z.string().optional(),
  canRollback: z.boolean().optional(),
  rollbackRetentionLimit: z.number().optional(),
  previousVersions: z.array(WorkspaceAppVersionRecordSchema).optional(),
  health: z.unknown().optional(),
  methods: z.array(z.string()).optional(),
  hasFetch: z.boolean().optional(),
  respawn: z
    .object({ attempts: z.number(), nextAttemptAt: z.number().nullable() })
    .nullable()
    .optional(),
  inspectorUrl: z.string().nullable().optional(),
});
export type WorkspaceUnitStatus = z.infer<typeof WorkspaceUnitStatusSchema>;

export const WorkspaceUnitLogRecordSchema = z.object({
  workspaceId: z.string(),
  unitName: z.string(),
  kind: z.enum(["extension", "worker", "panel", "app"]),
  timestamp: z.number(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  fields: z.record(z.unknown()).optional(),
  source: z
    .enum(["stdout", "stderr", "ctx.log", "console", "lifecycle", "system", "runner"])
    .optional(),
  /** Monotonic per-unit sequence — exact resume cursor for `sinceSeq` polling. */
  seq: z.number().optional(),
});
export type WorkspaceUnitLogRecord = z.infer<typeof WorkspaceUnitLogRecordSchema>;

export const WorkspaceUnitBuildEventSchema = z.object({
  type: z.enum(["build-started", "build-complete", "build-error"]),
  name: z.string(),
  relativePath: z.string().optional(),
  buildKey: z.string().optional(),
  error: z.string().optional(),
  timestamp: z.string(),
});
export type WorkspaceUnitBuildEvent = z.infer<typeof WorkspaceUnitBuildEventSchema>;

export const WorkspaceUnitDiagnosticsSchema = z.object({
  unit: WorkspaceUnitStatusSchema.nullable(),
  logs: z.array(WorkspaceUnitLogRecordSchema),
  errors: z.array(WorkspaceUnitLogRecordSchema),
  /** Recent state-triggered build lifecycle events for the unit. */
  builds: z.array(WorkspaceUnitBuildEventSchema),
  dropped: z.object({ entries: z.number(), errors: z.number() }),
  capacity: z.object({ entries: z.number(), errors: z.number() }),
});
export type WorkspaceUnitDiagnostics = z.infer<typeof WorkspaceUnitDiagnosticsSchema>;

export const WorkspaceRecurringJobStatusSchema = z.object({
  name: z.string(),
  target: z.object({
    source: z.string(),
    className: z.string(),
    objectKey: z.string(),
    method: z.string(),
  }),
  args: z.array(z.unknown()),
  schedule: z.object({
    intervalMs: z.number(),
    atMinutes: z.number().nullable(),
  }),
  specHash: z.string(),
  status: z.enum(["scheduled", "backing-off", "failing"]),
  nextRunAt: z.number(),
  lastRunAt: z.number().nullable(),
  lastStartedAt: z.number().nullable(),
  lastSucceededAt: z.number().nullable(),
  lastFailedAt: z.number().nullable(),
  lastError: z.string().nullable(),
  lastDurationMs: z.number().nullable(),
  failCount: z.number(),
  backoffUntil: z.number().nullable(),
});
export type WorkspaceRecurringJobStatus = z.infer<typeof WorkspaceRecurringJobStatusSchema>;

export const WorkspaceHeartbeatStatusSchema = z.object({
  name: z.string(),
  target: z.object({
    source: z.string(),
    className: z.string(),
    objectKey: z.string(),
  }),
  channelId: z.string().nullable(),
  participantHandle: z.string().nullable(),
  kind: z.enum(["declarative", "code-owned"]),
  status: z.enum(["running", "paused", "stopped"]),
  nextRunAt: z.number().nullable(),
  lastWakeAt: z.number().nullable(),
  lastActionSummary: z.string().nullable(),
  lastError: z.string().nullable(),
  specHash: z.string().nullable(),
  updatedAt: z.number(),
});
export type WorkspaceHeartbeatStatus = z.infer<typeof WorkspaceHeartbeatStatusSchema>;

export const WorkspaceHeartbeatSelectorSchema = z.union([
  z.string(),
  z.object({
    name: z.string().optional(),
    target: z
      .object({
        source: z.string().optional(),
        className: z.string().optional(),
        objectKey: z.string().optional(),
      })
      .optional(),
    channelId: z.string().optional(),
    participantHandle: z.string().optional(),
  }),
]);
export type WorkspaceHeartbeatSelector = z.infer<typeof WorkspaceHeartbeatSelectorSchema>;

export const HeartbeatTickResultSchema = z.object({
  action: z.enum(["skip", "prompt", "continue", "none"]),
  enqueued: z.boolean(),
  skippedReason: z.string().optional(),
  nextRunAt: z.number().nullable().optional(),
  decision: z.unknown().optional(),
  error: z.string().optional(),
});
export type WorkspaceHeartbeatTickResult = z.infer<typeof HeartbeatTickResultSchema>;

export const SkillEntrySchema = z.object({
  /** Skill identifier (from frontmatter `name:`, falling back to the directory name). */
  name: z.string(),
  /** Short human-readable description from frontmatter `description:` (may be empty). */
  description: z.string(),
  /** Workspace-relative repo path containing the skill. */
  dirPath: z.string(),
  /** Workspace-relative path to the SKILL.md file. */
  skillPath: z.string(),
});

export type WorkspaceTreeNode = WorkspaceNode;
export const WorkspaceTreeNodeSchema: z.ZodType<WorkspaceTreeNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    isUnit: z.boolean(),
    launchable: z
      .object({
        type: z.literal("app"),
        title: z.string(),
        description: z.string().optional(),
        hidden: z.boolean().optional(),
      })
      .optional(),
    packageInfo: z.object({ name: z.string(), version: z.string().optional() }).optional(),
    skillInfo: z.object({ name: z.string(), description: z.string() }).optional(),
    children: z.array(WorkspaceTreeNodeSchema),
  })
);

export const WorkspaceTreeSchema = z.object({
  children: z.array(WorkspaceTreeNodeSchema),
});
export type WorkspaceTree = z.infer<typeof WorkspaceTreeSchema>;

export const WorkspaceFindUnitForPathResultSchema = z
  .object({
    unitPath: z.string(),
    relativePath: z.string(),
  })
  .nullable();
export type WorkspaceFindUnitForPathResult = z.infer<typeof WorkspaceFindUnitForPathResultSchema>;

/** Options accepted by `units.logs`. */
const UnitLogsOptionsSchema = z.object({
  since: z.number().optional(),
  sinceSeq: z.number().optional(),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

// ─── Method table ─────────────────────────────────────────────────────────────

export const workspaceMethods = defineServiceMethods({
  // Read methods
  getInfo: {
    description:
      "Filesystem paths (source, state, contexts) and resolved config for the active workspace.",
    args: z.tuple([]),
    returns: z.object({
      path: z.string().describe("Absolute path to the workspace source tree."),
      statePath: z.string().describe("Absolute path to the workspace's persisted state directory."),
      contextProjectionsPath: z
        .string()
        .describe("Absolute path to the workspace's current-epoch disposable context projections."),
      config: WorkspaceConfigSchema.describe(
        "The resolved workspace config (meta/vibestudio.yml)."
      ),
    }),
    access: READ_ACCESS,
  },
  getActive: {
    description: "Name (id) of the currently active workspace.",
    args: z.tuple([]),
    returns: z.string(),
    access: READ_ACCESS,
  },
  getConfig: {
    description: "The active workspace's resolved config (meta/vibestudio.yml).",
    args: z.tuple([]),
    returns: WorkspaceConfigSchema,
    access: READ_ACCESS,
  },
  setInitPanels: {
    description:
      "Replace the set of panels opened when this workspace starts; approval-gated for userland.",
    args: z.tuple([
      z
        .array(
          z.object({
            source: z.string().describe("Panel source path (e.g. `panels/chat`)."),
            stateArgs: z
              .record(z.unknown())
              .optional()
              .describe("Optional initial state args passed to the panel on launch."),
          })
        )
        .describe("Ordered list of init-panel descriptors."),
    ]),
    returns: z.void(),
    authority: { principals: ["user", "code", "host"] },
    access: { sensitivity: "write" },
    examples: [{ args: [[{ source: "panels/chat" }]] }],
  },
  // SECURITY: arbitrary config-field writes — server-internal use
  // by default, but userland can request a one-shot approval.
  setConfigField: {
    description:
      "Write an arbitrary field into the workspace config (meta/vibestudio.yml); approval-gated for userland.",
    args: z.tuple([
      z.string().describe("Config field key to write."),
      z.unknown().describe("New value for the field."),
    ]),
    returns: z.void(),
    authority: { principals: ["user", "code", "host"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["title", "My Workspace"] }],
  },
  // Agent resource loading — read AGENTS.md and skill definitions directly
  // from the workspace source tree. Kept server-side because they touch
  // the filesystem; panels/workers call these over the RPC transport.
  getAgentsMd: {
    description:
      "Read the workspace-level meta/AGENTS.md, returning an empty string if it is absent.",
    args: z.tuple([]),
    returns: z.string(),
    access: READ_ACCESS,
  },
  listSkills: {
    description:
      "List repo-embedded workspace skills with name, description, repo path, and SKILL.md path parsed from each repo's top-level SKILL.md frontmatter.",
    args: z.tuple([]),
    returns: z.array(SkillEntrySchema),
    access: READ_ACCESS,
    // Linked external sessions receive the workspace skill catalog through
    // their exact entity principal; runtime kinds are not authorization.
    authority: { principals: ["host", "user", "code", "entity"] },
  },
  readSkill: {
    description:
      "Return raw SKILL.md contents for a canonical workspace repo path (`skills/code-review`, `packages/foo`, `workers/bar`, or `meta`). Path traversal is rejected.",
    args: z.tuple([z.string().describe("Canonical workspace repo path containing SKILL.md.")]),
    returns: z.string(),
    access: READ_ACCESS,
    // Read-only entity-principal access mirrors listSkills.
    authority: { principals: ["host", "user", "code", "entity"] },
    examples: [{ args: ["skills/code-review"] }, { args: ["packages/foo"] }, { args: ["meta"] }],
  },
  sourceTree: {
    description: "Return the workspace source tree, annotating units, launchables, and skills.",
    args: z.tuple([]),
    returns: WorkspaceTreeSchema,
    access: READ_ACCESS,
  },
  ensureContextFolder: {
    description:
      "Materialize a context's working folder on the server host (idempotent) and return its absolute path. Used by launch orchestrators (e.g. the shell extension) to place context-scoped terminal sessions inside a real VCS-branched working tree.",
    args: z.tuple([z.string().describe("Context id whose working folder to materialize.")]),
    returns: z.object({
      dir: z.string().describe("Absolute path to the materialized context folder."),
    }),
    // Launch orchestration is an extension concern; panels/workers/DO drive it
    // too (e.g. opening a context terminal). Narrower than the service default
    // (drops `app`, which never places terminal sessions).
    authority: { principals: ["user", "code", "host"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["ctx-abc"] }],
  },
  findUnitForPath: {
    description:
      "Resolve a workspace-relative path to its owning unit and the path relative to that unit, or null if no unit owns it.",
    args: z.tuple([z.string().describe("Workspace-relative path to locate within the unit tree.")]),
    returns: WorkspaceFindUnitForPathResultSchema,
    access: READ_ACCESS,
    examples: [{ args: ["panels/chat/index.tsx"] }],
  },
  "units.list": {
    description:
      "List operational status rows for all workspace units (panels, workers, extensions, apps), including build/health state.",
    args: z.tuple([]),
    returns: z.array(WorkspaceUnitStatusSchema),
    access: READ_ACCESS,
  },
  "units.inspector": {
    description:
      "Return the devtools inspector URL for a unit by name or source, or null if it has none.",
    args: z.tuple([z.string().describe("Unit name or source path.")]),
    returns: z.object({ url: z.string().describe("Inspector websocket URL.") }).nullable(),
    access: READ_ACCESS,
    examples: [{ args: ["extensions/git-tools"] }],
  },
  "units.restart": {
    description: "Restart a workspace unit through its owning manager.",
    args: z.tuple([z.string().describe("Unit name or source path to restart.")]),
    returns: z.void(),
    access: { sensitivity: "write" },
    examples: [{ args: ["extensions/git-tools"] }],
  },
  "units.logs": {
    description:
      "Query retained log records for a unit, optionally filtered by time/sequence cursor, level, and limit.",
    args: z.tuple([
      z.string().describe("Unit name or source path."),
      UnitLogsOptionsSchema.optional(),
    ]),
    returns: z.array(WorkspaceUnitLogRecordSchema),
    access: READ_ACCESS,
    examples: [{ args: ["extensions/git-tools", { level: "error", limit: 50 }] }],
  },
  "units.diagnostics": {
    description:
      "Return combined diagnostics for a unit: current status, recent logs, errors, build events, and buffer capacity.",
    args: z.tuple([
      z.string().describe("Unit name or source path."),
      UnitLogsOptionsSchema.extend({
        errorLimit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Max number of error records to include."),
      }).optional(),
    ]),
    returns: WorkspaceUnitDiagnosticsSchema,
    access: READ_ACCESS,
  },
  "units.versions": {
    description:
      "List the active build and retained previous versions for an app unit. This is read-only diagnostics and is available to every workspace caller; rollback remains ownership-restricted.",
    args: z.tuple([z.string().describe("App unit name or source path.")]),
    returns: WorkspaceAppVersionsSchema,
    access: READ_ACCESS,
    examples: [{ args: ["apps/shell"] }],
  },
  "units.rollback": {
    description:
      "Roll an app unit back to a previous active build (or a specific build key); userland is restricted to managing its own app.",
    args: z.tuple([
      z.string().describe("App unit name or source path."),
      z
        .object({
          buildKey: z
            .string()
            .optional()
            .describe("Specific build to roll back to; omit for the previous active build."),
        })
        .optional(),
    ]),
    returns: JsonObjectSchema,
    access: { sensitivity: "write" },
    examples: [{ args: ["apps/shell"] }],
  },
  "units.bakeAppDist": {
    description:
      "Bake an app unit's active approved build into a packaging payload directory; trusted-chrome callers only.",
    args: z.tuple([
      z.string().describe("App unit name or source path."),
      z
        .object({
          outDir: z.string().optional().describe("Output directory for the baked dist payload."),
        })
        .optional(),
    ]),
    returns: JsonObjectSchema,
    authority: { principals: ["user", "host"] },
    access: { sensitivity: "write" },
  },
  "recurring.list": {
    description:
      "List declarative scheduled jobs from meta/vibestudio.yml with their durable run state (next/last run, failures, backoff).",
    args: z.tuple([]),
    returns: z.array(WorkspaceRecurringJobStatusSchema),
    authority: { principals: ["user", "code", "host"] },
    access: READ_ACCESS,
  },
  "heartbeats.list": {
    description: "List registered heartbeats with their schedule, channel binding, and run state.",
    args: z.tuple([]),
    returns: z.array(WorkspaceHeartbeatStatusSchema),
    authority: { principals: ["user", "code", "host"] },
    access: READ_ACCESS,
  },
  "heartbeats.runNow": {
    description: "Trigger a heartbeat tick immediately for the selected heartbeat.",
    args: z.tuple([
      WorkspaceHeartbeatSelectorSchema.describe("Heartbeat name or a selector object."),
    ]),
    returns: HeartbeatTickResultSchema,
    authority: { principals: ["user", "code", "host"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["news-briefing"] }],
  },
  "heartbeats.pause": {
    description: "Pause the selected heartbeat so it stops ticking until resumed.",
    args: z.tuple([
      WorkspaceHeartbeatSelectorSchema.describe("Heartbeat name or a selector object."),
    ]),
    returns: z.object({ ok: z.literal(true) }),
    authority: { principals: ["user", "code", "host"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["news-briefing"] }],
  },
  "heartbeats.resume": {
    description: "Resume a paused heartbeat so it resumes its schedule.",
    args: z.tuple([
      WorkspaceHeartbeatSelectorSchema.describe("Heartbeat name or a selector object."),
    ]),
    returns: z.object({ ok: z.literal(true) }),
    authority: { principals: ["user", "code", "host"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["news-briefing"] }],
  },
  "hostTargets.list": {
    description: "List app candidates selectable as the active app for a host target.",
    args: z.tuple([HostTargetSchema.describe("Host target to list candidates for.")]),
    returns: z.array(HostTargetCandidateSchema),
    authority: { principals: ["user", "host"] },
    access: READ_ACCESS,
    examples: [{ args: ["electron"] }],
  },
  "hostTargets.getSelection": {
    description:
      "Read the active per-workspace selection for a host target along with whether it is still valid.",
    args: z.tuple([HostTargetSchema.describe("Host target to read the selection for.")]),
    returns: HostTargetSelectionStatusSchema,
    authority: { principals: ["user", "host"] },
    access: READ_ACCESS,
    examples: [{ args: ["electron"] }],
  },
  "hostTargets.setSelection": {
    description: "Persist the per-workspace app selection for a host target.",
    args: z.tuple([
      HostTargetSchema.describe("Host target to set the selection for."),
      HostTargetSelectionInputSchema.describe("Selection input (source, mode, ref/buildKey)."),
    ]),
    returns: HostTargetSelectionSchema,
    authority: { principals: ["user", "host"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["electron", { source: "apps/shell" }] }],
  },
  "hostTargets.clearSelection": {
    description: "Clear the persisted per-workspace app selection for a host target.",
    args: z.tuple([HostTargetSchema.describe("Host target to clear the selection for.")]),
    returns: z.void(),
    authority: { principals: ["user", "host"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["electron"] }],
  },
  "hostTargets.versions": {
    description: "List retained versions for a specific host-target candidate.",
    args: z.tuple([
      HostTargetSchema.describe("Host target the candidate belongs to."),
      z.string().describe("Candidate app source or name."),
    ]),
    returns: WorkspaceAppVersionsSchema,
    authority: { principals: ["user", "host"] },
    access: READ_ACCESS,
    examples: [{ args: ["electron", "apps/shell"] }],
  },
  "hostTargets.preparePinnedRef": {
    description:
      "Materialize a retained build for a specific ref of a host-target candidate through the build system.",
    args: z.tuple([
      HostTargetSchema.describe("Host target the candidate belongs to."),
      z.string().describe("Candidate app source or name."),
      z.string().describe("Git ref (branch/tag/sha) to materialize a build for."),
    ]),
    returns: z.object({
      buildKey: z.string(),
      effectiveVersion: z.string(),
      appId: z.string(),
      source: z.string(),
    }),
    authority: { principals: ["user", "host"] },
    access: { sensitivity: "write" },
  },
  "hostTargets.launch": {
    description:
      "Launch or reload the selected target app in this host, returning a ready/preparing/approval-required/unavailable status.",
    args: z.tuple([HostTargetSchema.describe("Host target to launch.")]),
    returns: HostTargetLaunchResultSchema,
    authority: { principals: ["user", "code", "host"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["electron"] }],
  },
  "hostTargets.beginLaunch": {
    description:
      "Begin an asynchronous launch session for a host target, returning the initial session snapshot.",
    args: z.tuple([HostTargetSchema.describe("Host target to begin launching.")]),
    returns: HostTargetLaunchSessionSnapshotSchema,
    authority: { principals: ["user", "code", "host"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["electron"] }],
  },
  "hostTargets.getLaunchSession": {
    description: "Fetch the current snapshot of a launch session by id, or null if it is unknown.",
    args: z.tuple([z.string().describe("Launch session id.")]),
    returns: HostTargetLaunchSessionSnapshotSchema.nullable(),
    authority: { principals: ["user", "code", "host"] },
    access: READ_ACCESS,
  },
  "hostTargets.resolveLaunchSessionApproval": {
    description:
      "Resolve a pending approval on a launch session by allowing it once or denying it, returning the updated snapshot.",
    args: z.tuple([
      z.string().describe("Launch session id."),
      z.enum(["once", "deny"]).describe("Approval decision for the pending launch."),
    ]),
    returns: HostTargetLaunchSessionSnapshotSchema,
    authority: { principals: ["user", "code", "host"] },
    access: {
      sensitivity: "write",
    },
    examples: [{ args: ["session-123", "once"] }],
  },
  "hostTargets.cancelLaunchSession": {
    description: "Cancel an in-flight launch session by id.",
    args: z.tuple([z.string().describe("Launch session id to cancel.")]),
    returns: z.void(),
    authority: { principals: ["user", "code", "host"] },
    access: { sensitivity: "write" },
  },
});
