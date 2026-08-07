import { z } from "zod";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";
import {
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
  selectedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";
import { CapabilityScopeSchema, executionArtifactRefSchema } from "./build.js";
import { vcsImportSnapshotResultSchema, vcsStateNodeRefSchema } from "./vcs.js";

const nonEmpty = z.string().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const diagnosticSchema = z
  .object({ code: nonEmpty, message: nonEmpty, at: z.number().int().nonnegative() })
  .strict();

export const developmentSessionModeSchema = z.enum(["semantic", "native-tool"]);
export const nativeDevelopmentToolSchema = z.enum(["claude-code", "system-editor"]);
const nativeProcessSchema = z
  .object({
    ownershipToken: nonEmpty,
    processId: nonEmpty,
    terminalSessionId: nonEmpty.optional(),
  })
  .strict();
const nativeCheckpointSchema = z
  .object({
    version: z.literal(1),
    sessionId: nonEmpty,
    idempotencyKey: nonEmpty,
    commandId: nonEmpty,
    snapshotRevision: nonEmpty,
    descriptorDigest: sha256,
    imported: vcsImportSnapshotResultSchema,
    checkpointedAt: z.number().int().nonnegative(),
  })
  .strict();
const nativeRepairSchema = z
  .object({
    phase: nonEmpty,
    primaryError: nonEmpty,
    cleanupErrors: z.array(nonEmpty),
    attention: z.enum(["actionable", "kept"]),
    knownEffects: z
      .object({
        nativeTree: z.enum(["owned", "absent", "unknown"]),
        process: z.enum(["owned", "absent", "unknown"]),
        importedEvent: z.enum(["present", "absent", "unknown"]),
      })
      .strict(),
  })
  .strict();
export const nativeDevelopmentSessionSchema = z
  .object({
    ownedRootId: nonEmpty,
    executorId: nonEmpty,
    toolId: nativeDevelopmentToolSchema,
    repoPath: nonEmpty,
    baseEvent: vcsStateNodeRefSchema,
    baseSnapshotRevision: nonEmpty,
    state: z.enum([
      "opening",
      "launching",
      "ready",
      "checkpointing",
      "stopping",
      "stopped",
      "requires-repair",
    ]),
    process: nativeProcessSchema.nullable(),
    lastCheckpoint: nativeCheckpointSchema.nullable(),
    pendingChanges: z.enum(["none", "present", "unknown"]),
    repair: nativeRepairSchema.nullable(),
  })
  .strict();
export type NativeDevelopmentSession = z.infer<typeof nativeDevelopmentSessionSchema>;

export const developmentSessionSchema = z
  .object({
    sessionId: nonEmpty,
    idempotencyKey: nonEmpty,
    state: z.enum(["opening", "ready", "checkpointing", "closing", "closed", "requires-repair"]),
    mode: developmentSessionModeSchema,
    nativeTool: nativeDevelopmentToolSchema.nullable(),
    native: nativeDevelopmentSessionSchema.nullable(),
    repository: z.object({ repositoryId: nonEmpty, repoPath: nonEmpty }).strict(),
    contextId: nonEmpty,
    parentContextId: nonEmpty,
    basis: z
      .object({
        parentWorkingHead: vcsStateNodeRefSchema,
        childBaseState: vcsStateNodeRefSchema,
      })
      .strict(),
    owner: z
      .object({ runtimeId: nonEmpty, runtimeKind: nonEmpty, userId: nonEmpty.nullable() })
      .strict(),
    contextEffect: z.enum(["owned", "retained", "absent", "unknown"]),
    repairAttention: z.enum(["actionable", "kept"]).nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    primaryDiagnostic: diagnosticSchema.nullable(),
    cleanupDiagnostics: z.array(diagnosticSchema),
  })
  .strict();
export type DevelopmentSession = z.infer<typeof developmentSessionSchema>;

const commandSchema = z
  .object({
    id: z.enum(["install-root", "build-host"]),
    executable: z.enum(["pnpm", "node"]),
    args: z.array(z.string()),
  })
  .strict();
export const developmentRecipeTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("build-only") }).strict(),
  z
    .object({
      kind: z.literal("client-device"),
      client: z.literal("electron"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("isolated-host"),
      includeClient: z.boolean(),
    })
    .strict(),
]);
export type DevelopmentRecipeTarget = z.infer<typeof developmentRecipeTargetSchema>;

export const developmentTargetSchema = z.union([
  z.object({ kind: z.literal("build-only") }).strict(),
  z
    .object({
      kind: z.literal("client-device"),
      client: z.literal("electron"),
      executorId: nonEmpty,
    })
    .strict(),
  z.discriminatedUnion("includeClient", [
    z
      .object({
        kind: z.literal("isolated-host"),
        includeClient: z.literal(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal("isolated-host"),
        includeClient: z.literal(true),
        executorId: nonEmpty,
      })
      .strict(),
  ]),
]);
export type DevelopmentTarget = z.infer<typeof developmentTargetSchema>;

export const developmentClientExecutorSchema = z
  .object({
    executorId: nonEmpty,
    providerId: nonEmpty,
    platform: nonEmpty,
    arch: nonEmpty,
    current: z.boolean(),
  })
  .strict();
export type DevelopmentClientExecutor = z.infer<typeof developmentClientExecutorSchema>;

export const developmentRecipeSchema = z
  .object({
    version: z.literal(1),
    recipeId: nonEmpty,
    label: nonEmpty,
    target: developmentRecipeTargetSchema,
    executor: z.literal("node-pnpm"),
    install: z
      .object({
        lockfiles: z.tuple([z.literal("pnpm-lock.yaml")]),
        mode: z.literal("frozen"),
        network: z.literal("approved-registry"),
        registry: z.literal("https://registry.npmjs.org"),
      })
      .strict(),
    commands: z.tuple([commandSchema, commandSchema]),
    declaredEnvironment: z
      .object({ CI: z.literal("1"), NODE_ENV: z.literal("production") })
      .strict(),
    platform: nonEmpty,
    arch: nonEmpty,
    reviewDigest: sha256,
  })
  .strict();
export type DevelopmentRecipe = z.infer<typeof developmentRecipeSchema>;

export const developmentExecutionSnapshotSchema = z
  .object({
    version: z.literal(1),
    sessionId: nonEmpty,
    contextId: nonEmpty,
    repositoryId: nonEmpty,
    repoPath: nonEmpty,
    repositoryState: vcsStateNodeRefSchema,
    repositoryManifestDigest: sha256,
    materializedTreeDigest: sha256,
    contentRoot: z.string().regex(/^state:[0-9a-f]{64}$/u),
    sourcePlanDigest: sha256,
    recipeDigest: sha256,
    toolchain: z
      .object({
        executorId: sha256,
        node: z
          .object({
            digest: sha256,
            version: nonEmpty,
            platform: nonEmpty,
            arch: nonEmpty,
          })
          .strict(),
        pnpm: z.object({ digest: sha256, version: nonEmpty }).strict(),
        hostSourceBuild: z.object({ digest: sha256 }).strict(),
      })
      .strict(),
    declaredEnvironment: z.record(z.string()),
    environmentDigest: sha256,
    lockfileDigest: sha256,
    snapshotDigest: sha256,
  })
  .strict();
export type DevelopmentExecutionSnapshot = z.infer<typeof developmentExecutionSnapshotSchema>;

export const developmentRunStateSchema = z.enum([
  "accepted",
  "materializing",
  "installing",
  "building",
  "starting",
  "awaiting-readiness",
  "ready",
  "succeeded",
  "stopping",
  "stopped",
  "failed",
  "cancelled",
  "requires-repair",
]);
export type DevelopmentRunState = z.infer<typeof developmentRunStateSchema>;

export const developmentRunEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    at: z.number().int().nonnegative(),
    kind: z.enum(["state", "log", "diagnostic", "cleanup"]),
    payload: z.unknown(),
  })
  .strict();
export type DevelopmentRunEvent = z.infer<typeof developmentRunEventSchema>;

const repairSchema = z
  .object({
    phase: nonEmpty,
    primaryError: diagnosticSchema,
    cleanupErrors: z.array(diagnosticSchema),
    retryable: z.boolean(),
    attention: z.enum(["actionable", "kept"]),
    knownEffects: z
      .object({
        executionRoot: z.enum(["absent", "owned", "unknown"]),
        process: z.enum(["absent", "owned", "unknown"]),
        artifact: z.enum(["absent", "retained", "unknown"]),
      })
      .strict(),
  })
  .strict();

export const developmentInstanceSchema = z
  .object({
    instanceId: nonEmpty.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
    generationId: nonEmpty.regex(/^[a-f0-9]{32}$/u),
    lifecycle: z.literal("ephemeral"),
    state: z.enum(["registered", "ready", "stopped"]),
    executionDigest: sha256,
    serverBuildId: sha256,
    serverId: nonEmpty.nullable(),
    serverBootId: nonEmpty.nullable(),
    workspaceId: nonEmpty.nullable(),
    workspaceName: nonEmpty.nullable(),
    gatewayUrl: z.string().url().nullable(),
    registeredAt: z.number().int().nonnegative(),
    readyAt: z.number().int().nonnegative().nullable(),
    stoppedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type DevelopmentInstance = z.infer<typeof developmentInstanceSchema>;

const developmentClientLaunchSchema = z
  .object({
    requestId: nonEmpty.regex(/^development-client-[a-f0-9]{32}$/u),
    providerId: nonEmpty,
    initiatingRuntimeId: nonEmpty,
    executionDigest: sha256,
    state: z.enum([
      "launching",
      "provider-launched",
      "child-attested",
      "ready",
      "failed",
      "stopped",
    ]),
    childPid: z.number().int().positive().nullable(),
    childRuntimeId: nonEmpty.nullable(),
    requestedAt: z.number().int().nonnegative(),
    launchedAt: z.number().int().nonnegative().nullable(),
    attestedAt: z.number().int().nonnegative().nullable(),
    stoppedAt: z.number().int().nonnegative().nullable(),
    failure: diagnosticSchema.nullable(),
  })
  .strict();

const attachedDevelopmentHostSchema = z
  .object({
    sessionId: nonEmpty,
    childGenerationId: nonEmpty.regex(/^[a-f0-9]{32}$/u),
    authorityCeilingDigest: sha256,
    state: z.enum(["attaching", "ready", "route-lost", "closed"]),
    expiresAt: z.number().int().nonnegative(),
    attachedAt: z.number().int().nonnegative().nullable(),
    routeLostAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const developmentRunSchema = z
  .object({
    version: z.literal(1),
    runId: nonEmpty,
    sessionId: nonEmpty,
    ownerRuntimeId: nonEmpty,
    ownerRuntimeKind: z.enum([
      "panel",
      "app",
      "worker",
      "do",
      "extension",
      "shell",
      "server",
      "agent",
    ]),
    ownerUserId: nonEmpty.nullable(),
    attachedHostAuthorityCeiling: z.array(CapabilityScopeSchema).max(512).nullable(),
    target: developmentTargetSchema,
    recipe: developmentRecipeSchema,
    snapshot: developmentExecutionSnapshotSchema,
    state: developmentRunStateSchema,
    commitPoint: z.enum([
      "none",
      "snapshot-retained",
      "artifacts-verified",
      "instance-registered",
      "ready",
    ]),
    artifact: executionArtifactRefSchema.nullable(),
    instance: developmentInstanceSchema.nullable(),
    hostReadiness: z.enum(["starting", "ready", "stopped", "failed"]).nullable(),
    client: developmentClientLaunchSchema.nullable(),
    attachedHost: attachedDevelopmentHostSchema.nullable(),
    repair: repairSchema.nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    terminalAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type DevelopmentRun = z.infer<typeof developmentRunSchema>;

const repositoryInput = z.object({ repositoryId: nonEmpty }).strict();
const openResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("opened"), session: developmentSessionSchema }).strict(),
  z
    .object({
      kind: z.literal("repository-not-adopted"),
      repositoryId: nonEmpty,
      contextId: nonEmpty,
      adoptionAction: z.literal("gitInterop.importProject"),
    })
    .strict(),
]);

const DEVELOPMENT_PRINCIPALS: ServiceAuthorityPolicy = {
  principals: ["code", "user", "host"],
};
export const DEVELOPMENT_NATIVE_EXECUTE_CAPABILITY = "development.native.execute";
export const DEVELOPMENT_START_AUTHORITY_RESOLVER = "development.start.native";
export const DEVELOPMENT_OPEN_AUTHORITY_RESOLVER = "development.open.native";
const nativeExecuteAuthority = {
  requirement: requirementForPrincipals(
    ["code", "user", "host"],
    DEVELOPMENT_NATIVE_EXECUTE_CAPABILITY
  ),
  resource: { kind: "literal" as const, key: DEVELOPMENT_NATIVE_EXECUTE_CAPABILITY },
  prepared: {
    resolver: DEVELOPMENT_START_AUTHORITY_RESOLVER,
    leaves: [
      {
        capability: DEVELOPMENT_NATIVE_EXECUTE_CAPABILITY,
        requirement: fixedPreparedAuthorityRequirement(
          requirementForPrincipals(["code", "user", "host"], DEVELOPMENT_NATIVE_EXECUTE_CAPABILITY)
        ),
        tier: "gated" as const,
      },
    ],
  },
};
const adaptiveOpenAuthority = {
  requirement: requirementForPrincipals(
    ["code", "user", "host"],
    "service:development.openSession"
  ),
  resource: {
    kind: "literal" as const,
    key: "service:development.openSession",
  },
  prepared: {
    resolver: DEVELOPMENT_OPEN_AUTHORITY_RESOLVER,
    leaves: [
      {
        capability: DEVELOPMENT_NATIVE_EXECUTE_CAPABILITY,
        requirement: selectedPreparedAuthorityRequirement(["code", "user", "host"]),
        tier: "gated" as const,
      },
    ],
  },
};

export const developmentMethods = defineServiceMethods({
  openSession: {
    tier: {
      tier: "open",
      session: "family",
      rationale:
        "Adaptive boundary: semantic mode is a reversible source-only fork; native-tool mode selects exact prepared gated local-tool authority",
    },
    description:
      "Fork the caller's exact semantic working state. Semantic mode stays in the control plane; native-tool mode launches the selected reviewed local tool in a private owned terminal and tree.",
    args: z.tuple([
      repositoryInput
        .extend({
          mode: developmentSessionModeSchema,
          nativeTool: nativeDevelopmentToolSchema.optional(),
          idempotencyKey: nonEmpty,
        })
        .strict()
        .superRefine((value, context) => {
          if ((value.mode === "native-tool") !== (value.nativeTool !== undefined)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["nativeTool"],
              message: "nativeTool is required exactly for native-tool sessions",
            });
          }
        }),
    ]),
    returns: openResultSchema,
    authority: adaptiveOpenAuthority,
    access: { sensitivity: "write" },
  },
  getSession: {
    tier: {
      tier: "open",
      session: "family",
      rationale: "Owner-scoped read of one semantic development session",
    },
    description: "Read an owned development session.",
    args: z.tuple([z.object({ sessionId: nonEmpty }).strict()]),
    returns: developmentSessionSchema.nullable(),
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "read" },
  },
  listSessions: {
    tier: {
      tier: "open",
      session: "family",
      rationale: "Owner-scoped listing of semantic development sessions",
    },
    description: "Page development sessions owned by the caller in stable newest-first order.",
    args: z.tuple([
      z
        .object({
          cursor: z
            .object({
              createdAt: z.number().int().nonnegative(),
              sessionId: nonEmpty,
            })
            .strict()
            .optional(),
          limit: z.number().int().positive().max(200).optional(),
        })
        .strict()
        .optional(),
    ]),
    returns: z
      .object({
        sessions: z.array(developmentSessionSchema),
        nextCursor: z
          .object({
            createdAt: z.number().int().nonnegative(),
            sessionId: nonEmpty,
          })
          .strict()
          .nullable(),
      })
      .strict(),
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "read" },
  },
  closeSession: {
    tier: {
      tier: "open",
      session: "family",
      rationale:
        "Owner-scoped lifecycle reduction that closes the session record while retaining its semantic child context",
    },
    description:
      "Close a development session idempotently while retaining its semantic child context.",
    args: z.tuple([z.object({ sessionId: nonEmpty, idempotencyKey: nonEmpty }).strict()]),
    returns: developmentSessionSchema,
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "write" },
  },
  destroySession: {
    capability: "development.sessions.destroy",
    tier: {
      tier: "critical",
      session: "family",
      rationale: "C3: permanently retires an owned semantic development context",
    },
    presentation: {
      title: "Destroy a development workspace",
      action: "permanently destroy a development workspace",
      description:
        "Allows {requesterKind} to permanently destroy this isolated semantic working copy.",
      group: "runtime",
      authorityCategory: {
        domain: "files",
        verb: "act",
      },
    },
    description:
      "Close a development session and destroy its owned semantic child context. Active runs are refused.",
    args: z.tuple([z.object({ sessionId: nonEmpty, idempotencyKey: nonEmpty }).strict()]),
    returns: developmentSessionSchema,
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "destructive" },
  },
  retrySessionCleanup: {
    capability: "development.sessions.cleanup.retry",
    tier: {
      tier: "critical",
      session: "family",
      rationale:
        "C3: retries the prior explicit destruction of an owned semantic development context",
    },
    presentation: {
      title: "Retry development-workspace cleanup",
      action: "retry permanent cleanup of a development workspace",
      description:
        "Allows {requesterKind} to retry the previously requested cleanup of this isolated semantic working copy.",
      group: "runtime",
      authorityCategory: {
        domain: "files",
        verb: "act",
      },
    },
    description:
      "Retry the previously requested destruction of a session's owned semantic child context.",
    args: z.tuple([z.object({ sessionId: nonEmpty, idempotencyKey: nonEmpty }).strict()]),
    returns: developmentSessionSchema,
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "destructive" },
  },
  keepSessionRepair: {
    tier: {
      tier: "open",
      session: "family",
      rationale:
        "Owner-scoped acknowledgement that retains the session context and diagnostics unchanged",
    },
    description:
      "Keep a session repair record without performing cleanup. Read the session to inspect it.",
    args: z.tuple([z.object({ sessionId: nonEmpty, idempotencyKey: nonEmpty }).strict()]),
    returns: developmentSessionSchema,
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "write" },
  },
  listRecipes: {
    tier: {
      tier: "open",
      session: "family",
      rationale: "Read-only discovery of reviewed development build recipes",
    },
    description: "List the reviewed build recipes. No method accepts a command line.",
    args: z.tuple([]),
    returns: z.array(developmentRecipeSchema),
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "read" },
  },
  listClientExecutors: {
    tier: {
      tier: "open",
      session: "family",
      rationale: "Read-only discovery of the caller's live reviewed client-device executors",
    },
    description:
      "List the authenticated user's live reviewed Electron executors as explicit launch coordinates.",
    args: z.tuple([]),
    returns: z.array(developmentClientExecutorSchema),
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "read" },
  },
  listNativeTools: {
    tier: {
      tier: "open",
      session: "family",
      rationale:
        "Read-only live discovery of reviewed native tools and executor-supplied availability reasons",
    },
    description:
      "List reviewed native development tools with live executor availability and an actionable unavailable reason.",
    args: z.tuple([]),
    returns: z.array(
      z
        .object({
          toolId: nativeDevelopmentToolSchema,
          executorId: nonEmpty.nullable(),
          available: z.boolean(),
          unavailableReason: nonEmpty.nullable(),
          interactiveTerminal: z.boolean(),
        })
        .strict()
    ),
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "read" },
  },
  start: {
    capability: "development.native.execute",
    tier: {
      tier: "gated",
      session: "family",
      rationale:
        "G1: runs reviewed project build code with local OS authority through the exact prepared development.native.execute capability",
    },
    presentation: {
      title: "Build the current workspace source",
      action: "run a reviewed build of the current workspace source",
      description:
        "Allows {requesterKind} to install frozen dependencies and run the reviewed build for one exact workspace snapshot.",
      group: "runtime",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
    description:
      "Build one exact semantic snapshot in a private root. A caller-owned runId is the sole start idempotency key.",
    args: z.tuple([
      z
        .object({
          sessionId: nonEmpty,
          runId: nonEmpty,
          recipeId: nonEmpty,
          target: developmentTargetSchema,
        })
        .strict(),
    ]),
    returns: developmentRunSchema,
    authority: nativeExecuteAuthority,
    access: {
      sensitivity: "write",
      approval: [
        {
          reason:
            "Installs frozen dependencies and runs reviewed project build code with local OS authority.",
          operation: {
            kind: "runtime",
            verb: "Build exact workspace source",
          },
        },
      ],
    },
  },
  faultFailBuildAfterSnapshotRetained: {
    description:
      "System-test-only fault injection: fail one caller-owned build immediately after its exact snapshot is durably retained.",
    args: z.tuple([
      z
        .object({
          sessionId: nonEmpty,
          runId: nonEmpty,
          phase: z.literal("after-snapshot-retained"),
        })
        .strict(),
    ]),
    returns: z
      .object({
        faultId: nonEmpty,
        runId: nonEmpty,
        phase: z.literal("after-snapshot-retained"),
        armedAt: z.number().int().nonnegative(),
      })
      .strict(),
    authority: { principals: ["code"] },
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "development.test-fault",
      rationale:
        "Hidden system-test transport admitted only through a sealed code-bearing session; the host verifies the blessed harness and the service binds the fault to one owned development run.",
    },
    agentFacing: false,
    execution: { harness: "attested-system-test" },
    access: { sensitivity: "write" },
  },
  get: {
    tier: {
      tier: "open",
      session: "family",
      rationale: "Owner-scoped read of one durable development build record",
    },
    description: "Read one owned development run.",
    args: z.tuple([z.object({ runId: nonEmpty }).strict()]),
    returns: developmentRunSchema.nullable(),
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "read" },
  },
  list: {
    tier: {
      tier: "open",
      session: "family",
      rationale: "Owner-scoped listing of durable development builds",
    },
    description:
      "Page owned development runs with stable newest-first cursors and optional session/state filters.",
    args: z.tuple([
      z
        .object({
          sessionId: nonEmpty.optional(),
          state: developmentRunStateSchema.optional(),
          cursor: z
            .object({
              createdAt: z.number().int().nonnegative(),
              runId: nonEmpty,
            })
            .strict()
            .optional(),
          limit: z.number().int().positive().max(200).optional(),
        })
        .strict()
        .optional(),
    ]),
    returns: z
      .object({
        runs: z.array(developmentRunSchema),
        nextCursor: z
          .object({
            createdAt: z.number().int().nonnegative(),
            runId: nonEmpty,
          })
          .strict()
          .nullable(),
      })
      .strict(),
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "read" },
  },
  events: {
    tier: {
      tier: "open",
      session: "family",
      rationale: "Owner-scoped bounded read of durable development build events",
    },
    description:
      "Page bounded durable run events. Subscribe to development:run-event for live delivery.",
    args: z.tuple([
      z
        .object({
          runId: nonEmpty,
          after: z.number().int().nonnegative().optional(),
          limit: z.number().int().positive().max(200).optional(),
        })
        .strict(),
    ]),
    returns: z
      .object({
        events: z.array(developmentRunEventSchema),
        nextAfter: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "read" },
  },
  stop: {
    tier: {
      tier: "open",
      session: "family",
      rationale:
        "Owner-scoped effect reduction that terminates only the run's proven-owned process group",
    },
    description: "Stop an owned build process and record exact cleanup outcome.",
    args: z.tuple([z.object({ runId: nonEmpty, idempotencyKey: nonEmpty }).strict()]),
    returns: developmentRunSchema,
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "write" },
  },
  retry: {
    capability: "development.native.execute",
    tier: {
      tier: "gated",
      session: "family",
      rationale:
        "G1: re-runs reviewed project build code through the same exact prepared development.native.execute authority",
    },
    presentation: {
      title: "Retry a development build",
      action: "retry a reviewed build of the exact workspace source",
      description:
        "Allows {requesterKind} to run the reviewed build again with the same exact prepared native authority.",
      group: "runtime",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
    description:
      "Retry a failed exact build from its retained snapshot under the same native-execution authority contract.",
    args: z.tuple([z.object({ runId: nonEmpty, idempotencyKey: nonEmpty }).strict()]),
    returns: developmentRunSchema,
    authority: nativeExecuteAuthority,
    access: {
      sensitivity: "write",
      approval: [
        {
          reason: "Re-runs reviewed project build code from the retained exact snapshot.",
          operation: { kind: "runtime", verb: "Retry exact workspace build" },
        },
      ],
    },
  },
  keepRunRepair: {
    tier: {
      tier: "open",
      session: "family",
      rationale:
        "Owner-scoped acknowledgement that retains all run effects and diagnostics unchanged",
    },
    description: "Keep a run repair record. Read the run to inspect it.",
    args: z.tuple([z.object({ runId: nonEmpty, idempotencyKey: nonEmpty }).strict()]),
    returns: developmentRunSchema,
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "write" },
  },
  forceRetire: {
    capability: "development.runs.force-retire",
    tier: {
      tier: "critical",
      session: "family",
      rationale: "C3: permanently abandons a retained development execution and its recovery path",
    },
    presentation: {
      title: "Abandon development-build recovery",
      action: "permanently abandon recovery of a development build",
      description:
        "Allows {requesterKind} to permanently retire a development run whose remaining native effects can no longer be proven.",
      group: "runtime",
      authorityCategory: {
        domain: "computer",
        verb: "manage",
      },
    },
    description:
      "Abandon a failed run and remove only execution effects whose ownership is proven.",
    args: z.tuple([z.object({ runId: nonEmpty, idempotencyKey: nonEmpty }).strict()]),
    returns: developmentRunSchema,
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "destructive" },
  },
  forceRetireSession: {
    capability: "development.sessions.force-retire",
    tier: {
      tier: "critical",
      session: "family",
      rationale: "C3: permanently abandons a semantic development context and its recovery path",
    },
    presentation: {
      title: "Abandon development-workspace recovery",
      action: "permanently abandon recovery of a development workspace",
      description:
        "Allows {requesterKind} to retire an isolated semantic working copy whose ownership can no longer be proven.",
      group: "runtime",
      authorityCategory: {
        domain: "files",
        verb: "manage",
      },
    },
    description:
      "Abandon a broken session after attempting cleanup of its proven-owned semantic context.",
    args: z.tuple([z.object({ sessionId: nonEmpty, idempotencyKey: nonEmpty }).strict()]),
    returns: developmentSessionSchema,
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "destructive" },
  },
  checkpoint: {
    tier: {
      tier: "open",
      session: "family",
      rationale:
        "Owner-scoped Save operation inside an already approved native session; freezes, snapshots, imports, and resumes only its proven-owned tree and process",
    },
    description:
      "Freeze an owned native tool, import one exact external snapshot into the development child, and resume the tool.",
    args: z.tuple([z.object({ sessionId: nonEmpty, idempotencyKey: nonEmpty }).strict()]),
    returns: developmentSessionSchema,
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "write" },
  },
  inspectNative: {
    tier: {
      tier: "open",
      session: "family",
      rationale:
        "Owner-scoped bounded read of native tool ownership, checkpoint, terminal, and repair state",
    },
    description:
      "Inspect native session ownership, checkpoint, repair, and optionally exact pending-change state.",
    args: z.tuple([
      z
        .object({
          sessionId: nonEmpty,
          assessPendingChanges: z.boolean().optional(),
        })
        .strict(),
    ]),
    returns: developmentSessionSchema,
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "read" },
  },
  stopNativeTool: {
    tier: {
      tier: "open",
      session: "family",
      rationale:
        "Owner-scoped effect reduction that terminates only the native session's proven-owned process group",
    },
    description:
      "Stop the exact owned native tool process group while retaining its terminal and writable tree for inspection.",
    args: z.tuple([z.object({ sessionId: nonEmpty, idempotencyKey: nonEmpty }).strict()]),
    returns: developmentSessionSchema,
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "write" },
  },
  readNativeTerminal: {
    tier: {
      tier: "open",
      session: "family",
      rationale: "Owner-scoped cursor-based bounded read of a development terminal",
    },
    description: "Read bounded scrollback from the native session's owned terminal.",
    args: z.tuple([
      z
        .object({
          sessionId: nonEmpty,
          after: z.number().int().nonnegative().optional(),
          maxBytes: z
            .number()
            .int()
            .positive()
            .max(512 * 1024)
            .optional(),
        })
        .strict(),
    ]),
    returns: z
      .object({
        terminalSessionId: nonEmpty,
        cursor: z.number().int().nonnegative(),
        text: z.string(),
        alive: z.boolean(),
        exit: z
          .object({
            code: z.number().int(),
            signal: z.number().int().optional(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "read" },
  },
  writeNativeTerminal: {
    tier: {
      tier: "open",
      session: "family",
      rationale:
        "Owner-scoped idempotent interactive input within an already approved native tool session",
    },
    description: "Write interactive input to the native session's owned terminal.",
    args: z.tuple([
      z
        .object({
          sessionId: nonEmpty,
          writeId: nonEmpty.max(128),
          data: z.string().max(64 * 1024),
        })
        .strict(),
    ]),
    returns: z.void(),
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "write" },
  },
  resizeNativeTerminal: {
    tier: {
      tier: "open",
      session: "family",
      rationale:
        "Owner-scoped idempotent terminal geometry update within an already approved native tool session",
    },
    description: "Resize the native session's owned terminal.",
    args: z.tuple([
      z
        .object({
          sessionId: nonEmpty,
          columns: z.number().int().min(20).max(1000),
          rows: z.number().int().min(5).max(1000),
        })
        .strict(),
    ]),
    returns: z.void(),
    authority: DEVELOPMENT_PRINCIPALS,
    access: { sensitivity: "write" },
  },
  snapshotExecutionRoots: {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "supervision",
      family: "development.retention",
      rationale:
        "Feeds the generic execution-artifact retention census from durable builtin ownership",
    },
    description: "Return the exact retained development artifacts for one GC epoch.",
    args: z.tuple([z.object({ epoch: z.number().int().nonnegative() }).strict()]),
    returns: z.array(
      z
        .object({
          owner: z.literal("development-run"),
          ownerId: nonEmpty,
          reason: z.literal("retained-result"),
          artifact: executionArtifactRefSchema,
        })
        .strict()
    ),
    agentFacing: false,
    authority: { principals: ["host"] },
    access: { sensitivity: "read" },
  },
  nativeRunEvent: {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "supervision",
      family: "development.native-event",
      rationale:
        "Accepts one exact lifecycle event emitted by the host-owned process or route handle",
    },
    description: "Apply one exact host-native lifecycle event to its durable run.",
    args: z.tuple([
      z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("attached-route-lost"),
            runId: nonEmpty,
            sessionId: nonEmpty,
            childGenerationId: nonEmpty,
          })
          .strict(),
      ]),
    ]),
    returns: z.void(),
    agentFacing: false,
    authority: { principals: ["host"] },
    access: { sensitivity: "write" },
  },
});

/**
 * Direct receiver authority for the product builtin. Prepared host authority
 * belongs to the downstream exact native primitive, so the durable receiver
 * never attempts to interpret host approval payloads.
 */
export const developmentBuiltinMethods = Object.fromEntries(
  Object.entries(developmentMethods).map(([name, method]) => [
    name,
    {
      ...method,
      capability:
        (["start", "retry"].includes(name)
          ? `service:development.${name}`
          : "capability" in method
            ? method.capability
            : undefined) ?? `service:development.${name}`,
      ...(["start", "retry"].includes(name)
        ? {
            tier: {
              ...method.tier,
              tier: "open" as const,
              rationale:
                "Durable builtin bookkeeping is open; the exact downstream native build handle owns the gated execution effect",
            },
          }
        : {}),
      ...(["openSession", "start", "retry"].includes(name)
        ? { authority: DEVELOPMENT_PRINCIPALS }
        : {}),
    },
  ])
) as unknown as typeof developmentMethods;
