/**
 * workspace service method schemas — current-workspace configuration,
 * lifecycle, and semantic workspace data. Server-wide workspace discovery and
 * routing belong to the stable `hubControl` service, never to a workspace
 * child.
 * contract shared by the server registration (`src/server/services/
 * workspaceService.ts`) and the typed client (`clients/workspaceClient.ts`).
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import {
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import { JsonObjectSchema, JsonValueSchema } from "@vibestudio/shared/wireValues";
import { WorkspaceConfigSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { WorkspaceNode } from "@vibestudio/shared/types";

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

export const WORKSPACE_PREPARED_CONFIG_CAPABILITY = "workspace.config.apply" as const;
export const WORKSPACE_PREPARED_CONFIG_AUTHORITY_RESOLVER =
  "workspace.applyPreparedConfig.mutation" as const;
const WorkspaceConfigDigestSchema = z.string().regex(/^v1-sha256:[0-9a-f]{64}$/u);

// ─── Workspace data schemas ───────────────────────────────────────────────────

export const WorkspaceEntrySchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  lastOpened: z.number(),
});
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;

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
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "workspace.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Filesystem paths (source, state, contexts) and resolved config for the active workspace.",
    args: z.tuple([]),
    returns: z.object({
      id: z.string().min(1).describe("Opaque host-owned identity of the active workspace."),
      name: z.string().min(1).describe("User-facing catalog name of the active workspace."),
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
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "workspace.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description: "Name (id) of the currently active workspace.",
    args: z.tuple([]),
    returns: z.string(),
    access: READ_ACCESS,
  },
  getConfig: {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "workspace.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description: "The active workspace's resolved config (meta/vibestudio.yml).",
    args: z.tuple([]),
    returns: WorkspaceConfigSchema,
    access: READ_ACCESS,
  },
  validateConfig: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspace.control",
      rationale:
        "Pure validation of caller-supplied candidate configuration has no workspace effect; §2 default {code, session} family",
    },
    description:
      "Validate a complete flattened workspace runtime manifest without changing workspace state.",
    args: z.tuple([z.string().describe("Complete YAML document to validate.")]),
    returns: z.object({ valid: z.literal(true) }).strict(),
    authority: { principals: ["user", "code", "host"] },
    access: READ_ACCESS,
  },
  setInitPanels: {
    capability: "workspace.configure",
    tier: {
      tier: "gated",
      session: "family",
      residency: "protected-write",
      family: "workspace.mutate",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Change startup panels",
      action: "change startup panels",
      description: "Allows {requesterKind} to change startup panels.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
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
    capability: "workspace.configure",
    tier: {
      tier: "gated",
      session: "family",
      residency: "protected-write",
      family: "workspace.mutate",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Change workspace settings",
      action: "change workspace settings",
      description: "Allows {requesterKind} to change workspace settings.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
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
  applyPreparedConfig: {
    capability: WORKSPACE_PREPARED_CONFIG_CAPABILITY,
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspace.mutate",
      rationale:
        "The transport is open; code callers receive one prepared gated leaf bound to the exact config mutation digest.",
    },
    presentation: {
      title: "Apply workspace configuration",
      action: "apply workspace configuration",
      description: "Allows {requesterKind} to apply an exact reviewed workspace configuration.",
      group: "workspace",
      authorityCategory: { domain: "automation", verb: "manage" },
    },
    description:
      "Atomically apply a complete validated workspace configuration only when its base digest, result digest, and changed-path scope match.",
    args: z.tuple([
      z
        .object({
          expectedBaseDigest: WorkspaceConfigDigestSchema,
          nextState: WorkspaceConfigSchema,
          resultDigest: WorkspaceConfigDigestSchema,
          allowedPathScope: z.array(z.string().min(1)).min(1),
          summary: z.string().trim().min(1).max(240),
        })
        .strict(),
    ]),
    returns: z
      .object({
        changed: z.boolean(),
        resultDigest: WorkspaceConfigDigestSchema,
        config: WorkspaceConfigSchema,
      })
      .strict(),
    authority: {
      requirement: requirementForPrincipals(
        ["user", "host", "code"],
        WORKSPACE_PREPARED_CONFIG_CAPABILITY
      ),
      resource: { kind: "literal", key: WORKSPACE_PREPARED_CONFIG_CAPABILITY },
      prepared: {
        resolver: WORKSPACE_PREPARED_CONFIG_AUTHORITY_RESOLVER,
        leaves: [
          {
            capability: WORKSPACE_PREPARED_CONFIG_CAPABILITY,
            requirement: fixedPreparedAuthorityRequirement(
              requirementForPrincipals(["code"], WORKSPACE_PREPARED_CONFIG_CAPABILITY)
            ),
            tier: "gated",
          },
        ],
      },
    },
    access: { sensitivity: "write" },
  },
  // Agent resource loading — read AGENTS.md and skill definitions directly
  // from the workspace source tree. Kept server-side because they touch
  // the filesystem; panels/workers call these over the RPC transport.
  getAgentsMd: {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "workspace.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Read the workspace-level meta/AGENTS.md, returning an empty string if it is absent.",
    args: z.tuple([]),
    returns: z.string(),
    access: READ_ACCESS,
  },
  listSkills: {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "workspace.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "List repo-embedded workspace skills with name, description, repo path, and SKILL.md path parsed from each repo's top-level SKILL.md frontmatter. Context-bound runtimes use their verified ambient context; contextless host clients must provide an explicit contextId.",
    args: z.tuple([
      z
        .object({ contextId: z.string().min(1) })
        .strict()
        .optional()
        .describe("Explicit semantic context for a contextless host caller."),
    ]),
    returns: z.array(SkillEntrySchema),
    access: READ_ACCESS,
    // Linked external sessions receive the workspace skill catalog through
    // their exact entity principal; runtime kinds are not authorization.
    authority: { principals: ["host", "user", "code"] },
  },
  readSkill: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspace.semantic-read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Return raw SKILL.md contents for a canonical workspace repo path (`skills/code-review`, `packages/foo`, `workers/bar`, or `meta`). Path traversal is rejected. Context-bound runtimes use their verified ambient context; contextless host clients must provide an explicit contextId.",
    args: z.tuple([
      z.string().describe("Canonical workspace repo path containing SKILL.md."),
      z
        .object({ contextId: z.string().min(1) })
        .strict()
        .optional()
        .describe("Explicit semantic context for a contextless host caller."),
    ]),
    returns: z.string(),
    access: READ_ACCESS,
    // Read-only entity-principal access mirrors listSkills.
    authority: { principals: ["host", "user", "code"] },
    examples: [{ args: ["skills/code-review"] }, { args: ["packages/foo"] }, { args: ["meta"] }],
  },
  sourceTree: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspace.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description: "Return the workspace source tree, annotating units, launchables, and skills.",
    args: z.tuple([]),
    returns: WorkspaceTreeSchema,
    access: READ_ACCESS,
  },
  ensureContextFolder: {
    capability: "context.materialize",
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "workspace.context-materialization",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Prepare a task workspace folder",
      action: "prepare a task workspace folder",
      description: "Allows {requesterKind} to prepare a task workspace folder.",
      group: "workspace",
      authorityCategory: {
        domain: "files",
        verb: "act",
      },
    },
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
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspace.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Resolve a workspace-relative path to its owning unit and the path relative to that unit, or null if no unit owns it.",
    args: z.tuple([z.string().describe("Workspace-relative path to locate within the unit tree.")]),
    returns: WorkspaceFindUnitForPathResultSchema,
    access: READ_ACCESS,
    examples: [{ args: ["panels/chat/index.tsx"] }],
  },
  "recurring.list": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspace.semantic-read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "List declarative scheduled jobs from meta/vibestudio.yml with their durable run state (next/last run, failures, backoff).",
    args: z.tuple([]),
    returns: z.array(WorkspaceRecurringJobStatusSchema),
    authority: { principals: ["user", "code", "host"] },
    access: READ_ACCESS,
  },
  "heartbeats.list": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "workspace.heartbeat-supervision",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description: "List registered heartbeats with their schedule, channel binding, and run state.",
    args: z.tuple([]),
    returns: z.array(WorkspaceHeartbeatStatusSchema),
    authority: { principals: ["user", "code", "host"] },
    access: READ_ACCESS,
  },
  "heartbeats.runNow": {
    capability: "automations.control",
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace.heartbeat-supervision",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Run recurring workspace tasks now",
      action: "run recurring workspace tasks now",
      description: "Allows {requesterKind} to run recurring workspace tasks now.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
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
    capability: "automations.control",
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace.heartbeat-supervision",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Pause recurring workspace tasks",
      action: "pause recurring workspace tasks",
      description: "Allows {requesterKind} to pause recurring workspace tasks.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
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
    capability: "automations.control",
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace.heartbeat-supervision",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Resume recurring workspace tasks",
      action: "resume recurring workspace tasks",
      description: "Allows {requesterKind} to resume recurring workspace tasks.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
    description: "Resume a paused heartbeat so it resumes its schedule.",
    args: z.tuple([
      WorkspaceHeartbeatSelectorSchema.describe("Heartbeat name or a selector object."),
    ]),
    returns: z.object({ ok: z.literal(true) }),
    authority: { principals: ["user", "code", "host"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["news-briefing"] }],
  },
});
