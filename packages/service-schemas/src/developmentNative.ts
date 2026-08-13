import { z } from "zod";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import {
  developmentExecutionSnapshotSchema,
  developmentClientExecutorSchema,
  developmentPairSelectionSchema,
  developmentRecipeSchema,
  developmentRunSchema,
  developmentSessionSchema,
  developmentTargetSchema,
  nativeDevelopmentToolSchema,
} from "./development.js";
import { vcsImportSnapshotResultSchema, vcsStateNodeRefSchema } from "./vcs.js";

const nonEmpty = z.string().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const templateExchangePathSchema = z
  .object({
    path: nonEmpty,
    status: z.enum(["equal", "update", "delete", "target-changed", "conflict"]),
    baseline: sha256.nullable(),
    source: sha256.nullable(),
    target: sha256.nullable(),
  })
  .strict();
const templateExchangePlanSchema = z
  .object({
    format: z.literal("vibestudio-template-exchange-plan/1"),
    direction: z.enum(["export", "import"]),
    workspace: nonEmpty,
    checkout: nonEmpty,
    source: nonEmpty,
    target: nonEmpty,
    manifestDigest: sha256,
    baselineDigest: sha256.nullable(),
    projection: z.array(nonEmpty),
    paths: z.array(templateExchangePathSchema),
    conflicts: z.array(nonEmpty),
    untouched: z.array(nonEmpty),
    operationId: sha256,
  })
  .strict();
const templateExchangeReceiptSchema = z
  .object({
    format: z.literal("vibestudio-template-exchange-receipt/1"),
    operationId: sha256,
    direction: z.enum(["export", "import"]),
    manifestDigest: sha256,
    baselineBefore: sha256.nullable(),
    baselineAfter: sha256,
    written: z.array(z.object({ path: nonEmpty, digest: sha256, mode: z.number().int() }).strict()),
    deleted: z.array(nonEmpty),
    preserved: z.array(nonEmpty),
    completedAt: nonEmpty,
  })
  .strict();
const nativePrincipals: ServiceAuthorityPolicy = { principals: ["host", "code"] };
const nativeExecuteAuthority = {
  requirement: requirementForPrincipals(["host", "code"], "development.native.execute"),
  resource: { kind: "literal" as const, key: "development.native.execute" },
};
const nativeSessionExecuteAuthority = {
  ...nativeExecuteAuthority,
  resource: {
    kind: "argument" as const,
    index: 0,
    path: ["sessionId"] as const,
    prefix: "development-native-session:",
  },
};
const nativeBuildExecuteAuthority = {
  ...nativeExecuteAuthority,
  resource: {
    kind: "argument" as const,
    index: 0,
    path: ["run", "runId"] as const,
    prefix: "development-build:",
  },
};
const templateExchangeAuthority = {
  ...nativeExecuteAuthority,
  resource: {
    kind: "argument" as const,
    index: 0,
    path: ["checkout"] as const,
    prefix: "template-checkout:",
  },
};

export const nativeDevelopmentProcessSchema = z
  .object({
    ownershipToken: nonEmpty,
    processId: nonEmpty,
    terminalSessionId: nonEmpty.optional(),
  })
  .strict();

export const nativeDevelopmentCheckpointReceiptSchema = z
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

export const nativeDevelopmentRepairSchema = z
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

export const nativeDevelopmentSessionReceiptSchema = z
  .object({
    version: z.literal(1),
    sessionId: nonEmpty,
    ownedRootId: nonEmpty,
    executorId: nonEmpty,
    toolId: nativeDevelopmentToolSchema,
    developmentContextId: nonEmpty,
    repositoryId: nonEmpty,
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
    process: nativeDevelopmentProcessSchema.nullable(),
    lastCheckpoint: nativeDevelopmentCheckpointReceiptSchema.nullable(),
    pendingChanges: z.enum(["none", "present", "unknown"]),
    repair: nativeDevelopmentRepairSchema.nullable(),
  })
  .strict();

export const nativeDevelopmentTerminalSnapshotSchema = z
  .object({
    terminalSessionId: nonEmpty,
    cursor: z.number().int().nonnegative(),
    text: z.string(),
    alive: z.boolean(),
    exit: z
      .object({ code: z.number().int(), signal: z.number().int().optional() })
      .strict()
      .nullable(),
  })
  .strict();

export const preparedNativeBuildSchema = z
  .object({
    runId: nonEmpty,
    snapshot: developmentExecutionSnapshotSchema,
    recipe: developmentRecipeSchema,
  })
  .strict();

export const developmentNativeMethods = defineServiceMethods({
  describeHost: {
    description: "Read the exact platform and architecture of the local native executor.",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.discovery",
      rationale: "Reports the platform coordinate required to select a reviewed native recipe",
    },
    args: z.tuple([]),
    returns: z.object({ platform: nonEmpty, arch: nonEmpty }).strict(),
    authority: nativePrincipals,
    access: { sensitivity: "read" },
  },
  listClientExecutors: {
    description: "List the authenticated user's live reviewed client-device executors.",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.discovery",
      rationale: "Returns explicit executor coordinates without launching native code",
    },
    args: z.tuple([]),
    returns: z.array(developmentClientExecutorSchema),
    authority: nativePrincipals,
    access: { sensitivity: "read" },
  },
  describeTool: {
    description: "Read availability of one sealed native development tool driver.",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.discovery",
      rationale: "Reports availability of one sealed native tool driver on this host",
    },
    args: z.tuple([nativeDevelopmentToolSchema]),
    returns: z
      .object({
        toolId: nativeDevelopmentToolSchema,
        executorId: nonEmpty,
        available: z.boolean(),
        unavailableReason: nonEmpty.optional(),
        interactiveTerminal: z.boolean(),
      })
      .strict(),
    authority: nativePrincipals,
    access: { sensitivity: "read" },
  },
  openTool: {
    description: "Launch one sealed tool in an exact private native session root.",
    presentation: {
      title: "Launch a native development tool",
      action: "launch a native development tool",
      description:
        "Allows {requesterKind} to run one reviewed tool in an exact private source tree.",
      group: "runtime",
      authorityCategory: { domain: "automation", verb: "act" },
    },
    capability: "development.native.execute",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.tool",
      rationale: "Materializes and launches one exact sealed tool in a host-owned private root",
    },
    args: z.tuple([
      z
        .object({
          sessionId: nonEmpty,
          developmentContextId: nonEmpty,
          repositoryId: nonEmpty,
          childWorkingHead: vcsStateNodeRefSchema,
          toolId: nativeDevelopmentToolSchema,
          idempotencyKey: nonEmpty,
        })
        .strict(),
    ]),
    returns: nativeDevelopmentSessionReceiptSchema,
    authority: nativeSessionExecuteAuthority,
    access: { sensitivity: "write" },
  },
  checkpointTool: {
    description: "Checkpoint one exact native tool session into semantic source.",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.tool",
      rationale: "Freezes and snapshots the exact already-owned native tool session",
    },
    args: z.tuple([z.object({ sessionId: nonEmpty, idempotencyKey: nonEmpty }).strict()]),
    returns: nativeDevelopmentCheckpointReceiptSchema,
    authority: nativePrincipals,
    access: { sensitivity: "write" },
  },
  inspectTool: {
    description: "Inspect one exact native tool session and its proven effects.",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.tool",
      rationale: "Reads ownership and process state for one exact native session handle",
    },
    args: z.tuple([
      z.object({ sessionId: nonEmpty, assessPendingChanges: z.boolean().optional() }).strict(),
    ]),
    returns: nativeDevelopmentSessionReceiptSchema,
    authority: nativePrincipals,
    access: { sensitivity: "read" },
  },
  stopTool: {
    description: "Stop the process group owned by one exact native tool session.",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.tool",
      rationale: "Stops only the process group proven by one exact native session handle",
    },
    args: z.tuple([z.object({ sessionId: nonEmpty }).strict()]),
    returns: nativeDevelopmentSessionReceiptSchema,
    authority: nativePrincipals,
    access: { sensitivity: "write" },
  },
  recoverTool: {
    description: "Recover one exact native tool session from its durable marker.",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.tool",
      rationale: "Reconciles marker and process ownership for one exact native session handle",
    },
    args: z.tuple([z.object({ sessionId: nonEmpty }).strict()]),
    returns: nativeDevelopmentSessionReceiptSchema,
    authority: nativePrincipals,
    access: { sensitivity: "write" },
  },
  keepTool: {
    description: "Keep one exact native tool session's repair state.",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.tool",
      rationale: "Acknowledges repair state without expanding the exact native session effects",
    },
    args: z.tuple([z.object({ sessionId: nonEmpty }).strict()]),
    returns: nativeDevelopmentSessionReceiptSchema,
    authority: nativePrincipals,
    access: { sensitivity: "write" },
  },
  retireTool: {
    capability: "development.native.session.retire",
    description: "Retire the proven process and private root of one exact native tool session.",
    presentation: {
      title: "Retire a native development tool",
      action: "retire a native development tool",
      description:
        "Allows {requesterKind} to remove the proven process and private tree for one exact tool.",
      group: "runtime",
      authorityCategory: { domain: "computer", verb: "manage" },
    },
    tier: {
      tier: "critical",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.tool",
      rationale:
        "Retires only the private root and process proven by one exact native session handle",
    },
    args: z.tuple([z.object({ sessionId: nonEmpty }).strict()]),
    returns: z.object({ retired: z.boolean(), cleanupErrors: z.array(nonEmpty) }).strict(),
    authority: nativePrincipals,
    access: { sensitivity: "destructive" },
  },
  readTerminal: {
    description: "Read bounded output from one exact native terminal session.",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.terminal",
      rationale: "Reads bounded output from one exact host-owned terminal session",
    },
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
    returns: nativeDevelopmentTerminalSnapshotSchema,
    authority: nativePrincipals,
    access: { sensitivity: "read" },
  },
  writeTerminal: {
    description: "Write bounded idempotent input to one exact native terminal session.",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.terminal",
      rationale: "Writes bounded input to one exact host-owned terminal session",
    },
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
    authority: nativePrincipals,
    access: { sensitivity: "write" },
  },
  resizeTerminal: {
    description: "Resize one exact native terminal session.",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.terminal",
      rationale: "Resizes one exact host-owned terminal session",
    },
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
    authority: nativePrincipals,
    access: { sensitivity: "write" },
  },
  prepareBuild: {
    description: "Attest an exact semantic source, reviewed recipe, and local toolchain.",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "untrusted-execution",
      family: "development-native.build",
      rationale:
        "Attests the exact host toolchain and semantic source plan without executing project code",
    },
    args: z.tuple([
      z
        .object({
          session: developmentSessionSchema,
          runId: nonEmpty,
          recipe: developmentRecipeSchema,
          pair: developmentPairSelectionSchema,
          target: developmentTargetSchema,
        })
        .strict(),
    ]),
    returns: preparedNativeBuildSchema,
    authority: nativePrincipals,
    access: { sensitivity: "read" },
  },
  prepareTemplateExchange: {
    description: "Plan one explicit three-way exchange with a selected sibling Git checkout.",
    capability: "development.native.execute",
    presentation: {
      title: "Inspect a template checkout exchange",
      action: "inspect a template checkout exchange",
      description:
        "Allows {requesterKind} to read one selected Git checkout and compare it with an exact semantic template repository.",
      group: "runtime",
      authorityCategory: { domain: "automation", verb: "act" },
    },
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.template-exchange",
      rationale:
        "Reads only the explicitly selected sibling checkout and an exact semantic snapshot",
    },
    args: z.tuple([
      z
        .object({
          direction: z.enum(["export", "import"]),
          checkout: nonEmpty,
          contextId: nonEmpty,
          repositoryId: nonEmpty,
          expectedWorkingHead: vcsStateNodeRefSchema,
          idempotencyKey: nonEmpty,
        })
        .strict(),
    ]),
    returns: z.object({ intentDigest: sha256, plan: templateExchangePlanSchema }).strict(),
    authority: templateExchangeAuthority,
    access: { sensitivity: "read" },
  },
  applyTemplateExchange: {
    description: "Apply one previously reviewed exact template checkout exchange.",
    capability: "development.native.execute",
    presentation: {
      title: "Apply a template checkout exchange",
      action: "apply a template checkout exchange",
      description:
        "Allows {requesterKind} to write the reviewed projection to a selected checkout or import it into one semantic context.",
      group: "runtime",
      authorityCategory: { domain: "automation", verb: "act" },
    },
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.template-exchange",
      rationale: "Applies only a prior exact plan and returns external and semantic receipts",
    },
    args: z.tuple([
      z.object({ operationId: sha256, intentDigest: sha256, checkout: nonEmpty }).strict(),
    ]),
    returns: z.discriminatedUnion("direction", [
      z
        .object({
          direction: z.literal("export"),
          exchange: templateExchangeReceiptSchema,
          imported: z.null(),
        })
        .strict(),
      z
        .object({
          direction: z.literal("import"),
          exchange: templateExchangeReceiptSchema,
          imported: vcsImportSnapshotResultSchema,
        })
        .strict(),
    ]),
    authority: templateExchangeAuthority,
    access: { sensitivity: "write" },
  },
  beginBuild: {
    description: "Begin execution of one exact prepared native build handle.",
    presentation: {
      title: "Build exact workspace source",
      action: "build exact workspace source",
      description:
        "Allows {requesterKind} to install frozen dependencies and execute one reviewed build closure.",
      group: "runtime",
      authorityCategory: { domain: "automation", verb: "act" },
    },
    capability: "development.native.execute",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "untrusted-execution",
      family: "development-native.build",
      rationale: "Executes one previously attested exact build closure in its proven private root",
    },
    args: z.tuple([z.object({ run: developmentRunSchema }).strict()]),
    returns: z.object({ started: z.literal(true) }).strict(),
    authority: nativeBuildExecuteAuthority,
    access: { sensitivity: "write" },
  },
  inspectBuild: {
    description: "Inspect bounded state, phase, and output for one exact native build handle.",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "untrusted-execution",
      family: "development-native.build",
      rationale: "Reads bounded status and output from one exact native build handle",
    },
    args: z.tuple([z.object({ runId: nonEmpty, snapshotDigest: sha256 }).strict()]),
    returns: z.discriminatedUnion("state", [
      z
        .object({
          state: z.literal("running"),
          artifact: developmentRunSchema.shape.artifact,
          instance: developmentRunSchema.shape.instance,
          hostReadiness: developmentRunSchema.shape.hostReadiness,
          client: developmentRunSchema.shape.client,
          attachedHost: developmentRunSchema.shape.attachedHost,
          phases: z.array(z.enum(["installing", "building"])),
          logs: z.array(
            z.object({ stream: z.enum(["stdout", "stderr"]), line: z.string() }).strict()
          ),
        })
        .strict(),
      z
        .object({
          state: z.literal("succeeded"),
          artifact: developmentRunSchema.shape.artifact.unwrap(),
          instance: developmentRunSchema.shape.instance,
          hostReadiness: developmentRunSchema.shape.hostReadiness,
          client: developmentRunSchema.shape.client,
          attachedHost: developmentRunSchema.shape.attachedHost,
          phases: z.array(z.enum(["installing", "building"])),
          logs: z.array(
            z.object({ stream: z.enum(["stdout", "stderr"]), line: z.string() }).strict()
          ),
        })
        .strict(),
      z
        .object({
          state: z.literal("ready"),
          artifact: developmentRunSchema.shape.artifact.unwrap(),
          instance: developmentRunSchema.shape.instance,
          hostReadiness: developmentRunSchema.shape.hostReadiness,
          client: developmentRunSchema.shape.client,
          attachedHost: developmentRunSchema.shape.attachedHost,
          phases: z.array(z.enum(["installing", "building"])),
          logs: z.array(
            z.object({ stream: z.enum(["stdout", "stderr"]), line: z.string() }).strict()
          ),
        })
        .strict(),
      z
        .object({
          state: z.literal("failed"),
          error: nonEmpty,
          artifact: developmentRunSchema.shape.artifact,
          instance: developmentRunSchema.shape.instance,
          hostReadiness: developmentRunSchema.shape.hostReadiness,
          client: developmentRunSchema.shape.client,
          attachedHost: developmentRunSchema.shape.attachedHost,
          phases: z.array(z.enum(["installing", "building"])),
          logs: z.array(
            z.object({ stream: z.enum(["stdout", "stderr"]), line: z.string() }).strict()
          ),
        })
        .strict(),
    ]),
    authority: nativePrincipals,
    access: { sensitivity: "read" },
  },
  stopBuild: {
    description: "Stop the process group owned by one exact native build handle.",
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "untrusted-execution",
      family: "development-native.build",
      rationale: "Stops only the process group owned by one exact build handle",
    },
    args: z.tuple([z.object({ runId: nonEmpty, snapshotDigest: sha256 }).strict()]),
    returns: z.void(),
    authority: nativePrincipals,
    access: { sensitivity: "write" },
  },
  retireBuild: {
    capability: "development.native.build.retire",
    description: "Retire the private execution root owned by one exact native build handle.",
    presentation: {
      title: "Retire a development build",
      action: "retire a development build",
      description:
        "Allows {requesterKind} to remove the private execution root proven by one exact run.",
      group: "runtime",
      authorityCategory: { domain: "computer", verb: "manage" },
    },
    tier: {
      tier: "critical",
      session: "codeOnly",
      residency: "untrusted-execution",
      family: "development-native.build",
      rationale: "Removes only the execution root proven by one exact retained run record",
    },
    args: z.tuple([z.object({ run: developmentRunSchema }).strict()]),
    returns: z.void(),
    authority: nativePrincipals,
    access: { sensitivity: "destructive" },
  },
});
