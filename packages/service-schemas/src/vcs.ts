import { z } from "zod";

import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods, type MethodSchema } from "@vibestudio/shared/typedServiceClient";
import { normalizeWorkspaceRepoPath, splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import {
  SEMANTIC_VCS_MAX_PATH_UTF8_BYTES,
  semanticVcsPathAdmission,
} from "@vibestudio/shared/vcs/pathAdmission";
import { DigestSchema } from "./blobstore.js";
import { buildDiagnosticSchema } from "./build.js";

/**
 * Public semantic VCS contract.
 *
 * This is intentionally a small semantic protocol surface. Semantic state is
 * named only by committed events and local work applications. One
 * context working head, one integration flow, and causal command edges form
 * the complete public model.
 */

const READ_ACCESS: MethodAccessDescriptor = { sensitivity: "read" };
const WRITE_ACCESS: MethodAccessDescriptor = { sensitivity: "write" };
const DESTRUCTIVE_ACCESS: MethodAccessDescriptor = { sensitivity: "destructive" };

const id = (description: string) => z.string().min(1).describe(description);
const nonEmptyText = z.string().trim().min(1);
const externalSourceUri = nonEmptyText.max(2_048).superRefine((value, context) => {
  if (/^[\\/]|^[A-Za-z]:[\\/]/u.test(value) || value.includes("\0")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "External source identity must not expose a machine-local path",
    });
    return;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol === "file:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.toString() !== value
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "External source URI must be durable and credential-free (no file URI, userinfo, query, or fragment)",
      });
    }
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "External source identity must be a canonical URI",
    });
  }
});
const commandId = id("Stable idempotency identity. Reuse it for an uncertain retry.");
const contextId = id("Workspace context identity.");
const snapshotDigest = z
  .string()
  .regex(/^snapshot:[0-9a-f]{64}$/u)
  .describe("Semantic-workspace-derived commitment to the normalized imported descriptors.");
const canonicalSnapshot = z
  .string()
  .regex(/^v1-sha256:[0-9a-f]{64}$/u)
  .describe("Canonical commitment to the complete admitted external file set.");
const cursor = z.string().min(1);
const pageLimit = z.number().int().positive().max(500).default(100);
const canonicalRepoPath = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        return normalizeWorkspaceRepoPath(value) === value;
      } catch {
        return false;
      }
    },
    {
      message:
        "Expected a repository root shaped exactly as <section>/<name>; repositories cannot be nested inside another repository",
    }
  )
  .refine((value) => semanticVcsPathAdmission(value).admissible, {
    message:
      `Expected an admissible canonical workspace repository path of at most ` +
      `${SEMANTIC_VCS_MAX_PATH_UTF8_BYTES} UTF-8 bytes`,
  });

const canonicalFilePath = z
  .string()
  .min(1)
  .refine((value) => semanticVcsPathAdmission(value).admissible, {
    message:
      `Expected an admissible canonical repository-relative file path of at most ` +
      `${SEMANTIC_VCS_MAX_PATH_UTF8_BYTES} UTF-8 bytes`,
  });

const timestamp = z.string().datetime({ offset: true });
const boundedIds = (description: string) => z.array(id(description)).min(1).max(200);
const contentDescriptorFields = {
  contentKind: z.enum(["text", "bytes"]),
  byteLength: z.number().int().nonnegative(),
  coordinateExtent: z.number().int().nonnegative(),
};
const validateContentDescriptor = (
  value: { contentKind: "text" | "bytes"; byteLength: number; coordinateExtent: number },
  context: z.RefinementCtx
): void => {
  if (value.contentKind === "bytes" && value.coordinateExtent !== value.byteLength) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["coordinateExtent"],
      message: "Byte content coordinates must span exactly its byte length",
    });
  }
  if (value.contentKind === "text" && value.coordinateExtent > value.byteLength) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["coordinateExtent"],
      message: "UTF-16 coordinate extent cannot exceed the UTF-8 byte length",
    });
  }
};

// ---------------------------------------------------------------------------
// Stable typed references
// ---------------------------------------------------------------------------

export const vcsStateNodeRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("event"),
      eventId: id(
        "Opaque committed workspace-event:… identity. Copy the complete returned value unchanged."
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("application"),
      applicationId: id(
        "Opaque local application:… identity. Copy the complete returned value unchanged."
      ),
    })
    .strict(),
]);
export type VcsStateNodeRef = z.infer<typeof vcsStateNodeRefSchema>;

export const vcsFileRefSchema = z
  .object({
    repositoryId: id("Stable repository identity."),
    fileId: id("Stable workspace-wide file identity."),
  })
  .strict();
export type VcsFileRef = z.infer<typeof vcsFileRefSchema>;

export const vcsTrajectoryRefSchema = z
  .object({
    kind: z.literal("trajectory"),
    logId: id("Trajectory log identity."),
    head: id("Exact trajectory head."),
  })
  .strict();

export const vcsTrajectoryInvocationRefSchema = z
  .object({
    kind: z.literal("trajectory-invocation"),
    logId: id("Trajectory log identity."),
    head: id("Exact trajectory head."),
    invocationId: id("Exact tool invocation that caused a semantic command."),
  })
  .strict();

export const vcsTrajectoryTurnRefSchema = z
  .object({
    kind: z.literal("trajectory-turn"),
    logId: id("Trajectory log identity."),
    head: id("Exact trajectory head."),
    turnId: id("Exact agent turn."),
  })
  .strict();

export const vcsTrajectoryMessageRefSchema = z
  .object({
    kind: z.literal("trajectory-message"),
    logId: id("Trajectory log identity."),
    head: id("Exact trajectory head."),
    messageId: id("Exact trajectory message."),
  })
  .strict();

const vcsEventNodeRefSchema = z
  .object({ kind: z.literal("event"), eventId: id("Workspace event.") })
  .strict();

const vcsFileNodeRefSchema = z
  .object({
    kind: z.literal("file"),
    state: vcsStateNodeRefSchema,
    repositoryId: id("Repository containing the file at this state."),
    fileId: id("Stable file identity."),
  })
  .strict();

export const vcsAppliedChangeNodeRefSchema = z
  .object({
    kind: z.literal("applied-change"),
    appliedChangeId: id("Basis-specific applied change."),
  })
  .strict();

export const vcsWorkUnitNodeRefSchema = z
  .object({ kind: z.literal("work-unit"), workUnitId: id("Authored work unit.") })
  .strict();

export const vcsExternalDeltaNodeRefSchema = z
  .object({ kind: z.literal("external-delta"), deltaId: id("Unapplied external delta.") })
  .strict();

export const vcsChangeNodeRefSchema = z
  .object({ kind: z.literal("change"), changeId: id("Semantic change.") })
  .strict();

export const vcsCommandNodeRefSchema = z
  .object({ kind: z.literal("command"), commandId: id("Semantic command.") })
  .strict();

const vcsSemanticNodeSchemas = [
  vcsEventNodeRefSchema,
  vcsExternalDeltaNodeRefSchema,
  z.object({ kind: z.literal("application"), applicationId: id("Work application.") }).strict(),
  vcsAppliedChangeNodeRefSchema,
  vcsWorkUnitNodeRefSchema,
  vcsChangeNodeRefSchema,
  z.object({ kind: z.literal("decision"), decisionId: id("Integration decision.") }).strict(),
  vcsCommandNodeRefSchema,
  vcsFileNodeRefSchema,
  z
    .object({
      kind: z.literal("repository"),
      state: vcsStateNodeRefSchema,
      repositoryId: id("Stable repository identity."),
    })
    .strict(),
  vcsTrajectoryRefSchema,
  vcsTrajectoryInvocationRefSchema,
  vcsTrajectoryTurnRefSchema,
  vcsTrajectoryMessageRefSchema,
] as const;

export const vcsSemanticNodeRefSchema = z.discriminatedUnion("kind", vcsSemanticNodeSchemas);
export type VcsSemanticNodeRef = z.infer<typeof vcsSemanticNodeRefSchema>;

/** Public provenance roots use the same node vocabulary as inspect/neighbors. */
export const vcsProvenanceRootSchema = vcsSemanticNodeRefSchema;
export type VcsProvenanceRoot = VcsSemanticNodeRef;

// ---------------------------------------------------------------------------
// Files, effects, changes, applications, and decisions
// ---------------------------------------------------------------------------

export const vcsFileWriteContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  z.object({ kind: z.literal("bytes"), base64: z.string() }).strict(),
]);
export type VcsFileWriteContent = z.infer<typeof vcsFileWriteContentSchema>;

export const vcsFileReadContentSchema = vcsFileWriteContentSchema;
export type VcsFileReadContent = VcsFileWriteContent;

export const vcsTextEditSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    text: z.string(),
  })
  .strict()
  .refine((edit) => edit.end >= edit.start, { message: "end must be >= start" });
export type VcsTextEdit = z.infer<typeof vcsTextEditSchema>;

export const vcsStatePredicateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("file-content"),
      fileId: id("Stable file identity."),
      contentHash: id("Expected content blob hash."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file-placement"),
      fileId: id("Stable file identity."),
      repositoryId: id("Expected repository."),
      path: canonicalFilePath,
    })
    .strict(),
  z.object({ kind: z.literal("file-absent"), fileId: id("Stable file identity.") }).strict(),
  z
    .object({
      kind: z.literal("repository-present"),
      repositoryId: id("Stable repository identity."),
      repoPath: canonicalRepoPath,
    })
    .strict(),
  z
    .object({
      kind: z.literal("repository-absent"),
      repositoryId: id("Stable repository identity."),
    })
    .strict(),
]);
export type VcsStatePredicate = z.infer<typeof vcsStatePredicateSchema>;

export const vcsChangeEffectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("content"),
      fileId: id("Affected file."),
      beforeContentHash: id("Prior content hash.").nullable(),
      afterContentHash: id("Result content hash.").nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("placement"),
      fileId: id("Affected file."),
      before: z
        .object({ repositoryId: id("Repository."), path: canonicalFilePath })
        .strict()
        .nullable(),
      after: z
        .object({ repositoryId: id("Repository."), path: canonicalFilePath })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("mode"),
      fileId: id("Affected file."),
      beforeMode: z.number().int().nonnegative().max(0o777).nullable(),
      afterMode: z.number().int().nonnegative().max(0o777).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("repository-placement"),
      repositoryId: id("Affected repository."),
      beforePath: canonicalRepoPath.nullable(),
      afterPath: canonicalRepoPath.nullable(),
    })
    .strict(),
]);
export type VcsChangeEffect = z.infer<typeof vcsChangeEffectSchema>;

export const vcsChangeKindSchema = z.enum([
  "text-edit",
  "file-create",
  "file-delete",
  "file-restore",
  "file-move",
  "file-copy",
  "file-mode",
  "content-replace",
  "repository-create",
  "repository-delete",
  "repository-restore",
  "repository-move",
  "merge",
]);
export type VcsChangeKind = z.infer<typeof vcsChangeKindSchema>;

export const vcsChangeSchema = z
  .object({
    changeId: id("Stable semantic change identity."),
    authoredByWorkUnitId: id("Work unit that authored this change."),
    operation: z.number().int().nonnegative(),
    kind: vcsChangeKindSchema,
    effects: z.array(vcsChangeEffectSchema).min(1).max(32),
    counteractsChangeIds: z.array(id("Counteracted change.")).max(200),
    effectDigest: id("Canonical mechanical effect digest."),
    normalizationProtocol: id("Normalization protocol."),
  })
  .strict();
export type VcsChange = z.infer<typeof vcsChangeSchema>;

export const vcsAppliedChangeSchema = z
  .object({
    appliedChangeId: id("Basis-specific applied change."),
    applicationId: id("Owning work application."),
    changeId: id("Applied semantic change."),
    ordinal: z.number().int().nonnegative(),
    appliedEffects: z.array(vcsChangeEffectSchema).min(1).max(32),
    resultPredicate: vcsStatePredicateSchema.nullable(),
  })
  .strict();
export type VcsAppliedChange = z.infer<typeof vcsAppliedChangeSchema>;

export const vcsExternalSnapshotSchema = z
  .object({
    sourceKind: z.enum(["git", "archive", "filesystem", "upload", "generated"]),
    sourceUri: externalSourceUri.describe(
      "Canonical credential-free identity of the observed external source."
    ),
    snapshotRevision: nonEmptyText,
    sourceSubdir: canonicalFilePath.nullable().optional(),
    canonicalSnapshot: canonicalSnapshot.optional(),
    snapshotDigest,
    targetRepositoryIds: z
      .array(id("Exact native repositories admitted from this snapshot."))
      .min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sourceKind === "git" && value.canonicalSnapshot == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canonicalSnapshot"],
        message: "Git snapshot evidence requires its canonical snapshot digest",
      });
    }
    if (value.sourceKind !== "git" && value.sourceSubdir != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceSubdir"],
        message: "Only Git snapshot evidence may carry a source subdirectory",
      });
    }
    if (
      JSON.stringify(value.targetRepositoryIds) !==
      JSON.stringify([...new Set(value.targetRepositoryIds)].sort())
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetRepositoryIds"],
        message: "Target repository IDs must be unique and sorted",
      });
    }
  });
export type VcsExternalSnapshot = z.infer<typeof vcsExternalSnapshotSchema>;

export const vcsIntentEvidenceSchema = z
  .object({ text: nonEmptyText.max(1_200), tier: z.enum(["stated", "trigger", "mechanical"]) })
  .strict();

export const vcsWorkUnitSchema = z
  .object({
    workUnitId: id("Authored work unit."),
    commandId: id("Originating semantic command."),
    kind: z.enum([
      "edit",
      "file-transfer",
      "lifecycle",
      "merge",
      "revert",
      "import",
      "external-unapplied",
    ]),
    authoredChangeCount: z.number().int().nonnegative(),
    authoredChangeIds: z.array(id("Bounded preview of changes authored here.")).max(200),
    incorporatedChangeCount: z.number().int().nonnegative(),
    incorporatedChangeIds: z
      .array(id("Bounded preview of existing changes incorporated here."))
      .max(200),
    decisionCount: z.number().int().nonnegative(),
    decisionIds: z.array(id("Bounded preview of integration decisions made here.")).max(200),
    intent: vcsIntentEvidenceSchema,
    intentSummary: nonEmptyText.nullable(),
    authorContextId: contextId,
    triggerEvidence: z
      .object({
        text: nonEmptyText.max(1_200),
        sender: z
          .object({
            kind: nonEmptyText,
            id: id("Canonical sender identity."),
            participantId: id("Channel participant identity, when applicable.").nullable(),
          })
          .strict(),
      })
      .strict()
      .nullable(),
    externalSnapshot: vcsExternalSnapshotSchema.nullable(),
    contentClass: z.enum(["internal", "external"]),
    externalKeys: z.array(z.string().min(1)).max(256),
    normalizationProtocol: id("Normalization protocol."),
    createdAt: timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "import" && value.externalSnapshot == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["externalSnapshot"],
        message: "Import work units require an exact external snapshot",
      });
    } else if (value.kind !== "import" && value.externalSnapshot != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["externalSnapshot"],
        message: "Only import work units may carry an external snapshot",
      });
    }
    if (value.intentSummary != null && value.triggerEvidence != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggerEvidence"],
        message: "Stated intent and captured trigger evidence are mutually exclusive",
      });
    }
  });
export type VcsWorkUnit = z.infer<typeof vcsWorkUnitSchema>;

export const vcsWorkApplicationSchema = z
  .object({
    applicationId: id("Local work application."),
    workUnitId: id("Applied work unit."),
    basis: vcsStateNodeRefSchema,
    appliedChangeCount: z.number().int().nonnegative(),
    appliedChanges: z.array(vcsAppliedChangeSchema).max(200),
    resultWorkspaceFactRootId: id("Authenticated result workspace-fact root."),
    semanticProtocol: id("Semantic protocol."),
  })
  .strict();
export type VcsWorkApplication = z.infer<typeof vcsWorkApplicationSchema>;

export const vcsMergeCoordinateRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), id: id("Stable file identity.") }).strict(),
  z.object({ kind: z.literal("repository"), id: id("Stable repository identity.") }).strict(),
]);
export type VcsMergeCoordinateRef = z.infer<typeof vcsMergeCoordinateRefSchema>;

export const vcsMergeResolutionKindSchema = z.enum(["composed", "theirs", "ours", "current"]);
export type VcsMergeResolutionKind = z.infer<typeof vcsMergeResolutionKindSchema>;

export const vcsMergeDecisionEntrySchema = z
  .object({
    coordinate: vcsMergeCoordinateRefSchema,
    resolution: z.enum(["adopt", "convergent", "composed", "ours", "current"]),
    accountedSourceChangeIds: z.array(id("Accounted source change.")).max(10_000),
    resultChangeId: id("Change realizing the merged result.").optional(),
    rationale: nonEmptyText.max(2_000).optional(),
  })
  .strict();

export const vcsIntegrationDecisionSchema = z
  .object({
    decisionId: id("Merge decision."),
    intent: vcsIntentEvidenceSchema,
    sourceIntents: z
      .array(
        z
          .object({
            workUnitId: id("Source authoring work unit."),
            intent: vcsIntentEvidenceSchema,
          })
          .strict()
      )
      .max(500),
    sourceState: z.union([vcsEventNodeRefSchema, vcsExternalDeltaNodeRefSchema]),
    targetBasis: vcsStateNodeRefSchema,
    entries: z.array(vcsMergeDecisionEntrySchema).max(500),
  })
  .strict();
export type VcsIntegrationDecision = z.infer<typeof vcsIntegrationDecisionSchema>;

export const vcsWorkspaceEventSchema = z
  .object({
    eventId: id("Committed workspace event."),
    workspaceId: id("Owning workspace."),
    commandId: id("Originating semantic command."),
    kind: z.enum(["genesis", "commit", "integration-commit"]),
    workspaceFactRootId: id("Authenticated workspace-fact root."),
    parentEventIds: z.array(id("Parent event.")).max(201),
    externalDeltaIds: z.array(id("Integrated external delta.")).max(200).optional(),
    applicationIds: z.array(id("Complete local application chain committed here.")).max(10_000),
    decisionIds: z.array(id("Reachable integration decision.")).max(10_000),
    message: nonEmptyText.nullable(),
    semanticProtocol: id("Semantic protocol."),
    createdAt: timestamp,
  })
  .strict();
export type VcsWorkspaceEvent = z.infer<typeof vcsWorkspaceEventSchema>;

// ---------------------------------------------------------------------------
// Mutation requests and results
// ---------------------------------------------------------------------------

const mutationEnvelope = {
  commandId,
  contextId,
  expectedWorkingHead: vcsStateNodeRefSchema,
  intentSummary: nonEmptyText.optional(),
};

export const vcsEditChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("repository-create"),
      repoPath: canonicalRepoPath.describe(
        "New, currently unoccupied repository root shaped exactly as <section>/<name>. Repositories cannot be nested inside an existing project. To change an existing project, resolve its repository and file identities and use a file edit/create operation."
      ),
      files: z
        .array(
          z
            .object({
              path: canonicalFilePath,
              content: vcsFileWriteContentSchema,
              mode: z.number().int().nonnegative().max(0o777).default(0o644),
            })
            .strict()
        )
        .min(1)
        .max(199),
    })
    .strict(),
  z
    .object({
      kind: z.literal("text-edit"),
      repositoryId: id("Repository containing the file."),
      fileId: id("Stable file identity."),
      edits: z.array(vcsTextEditSchema).min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("binary-replace"),
      repositoryId: id("Repository containing the file."),
      fileId: id("Stable file identity."),
      base64: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file-create"),
      repositoryId: id("Destination repository."),
      path: canonicalFilePath,
      content: vcsFileWriteContentSchema,
      mode: z.number().int().nonnegative().max(0o777).default(0o644),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file-delete"),
      repositoryId: id("Repository containing the file."),
      fileId: id("Stable file identity."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file-mode"),
      repositoryId: id("Repository containing the file."),
      fileId: id("Stable file identity."),
      mode: z.number().int().nonnegative().max(0o777),
    })
    .strict(),
]);
export type VcsEditChange = z.infer<typeof vcsEditChangeSchema>;

export const vcsEditInputSchema = z
  .object({
    ...mutationEnvelope,
    changes: z.array(vcsEditChangeSchema).min(1).max(200),
  })
  .strict()
  .superRefine((input, context) => {
    const repoPaths = new Set<string>();
    let authoredChangeCount = 0;
    for (const [index, change] of input.changes.entries()) {
      authoredChangeCount += change.kind === "repository-create" ? change.files.length + 1 : 1;
      if (change.kind !== "repository-create") continue;
      if (repoPaths.has(change.repoPath)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["changes", index, "repoPath"],
          message: "Repository creation paths must be unique",
        });
      }
      repoPaths.add(change.repoPath);
      const filePaths = new Set<string>();
      for (const [fileIndex, file] of change.files.entries()) {
        if (filePaths.has(file.path)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["changes", index, "files", fileIndex, "path"],
            message: "Initial repository file paths must be unique",
          });
        }
        filePaths.add(file.path);
      }
    }
    if (authoredChangeCount > 200) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changes"],
        message: "One edit may author at most 200 semantic changes including initial files",
      });
    }
  });
export type VcsEditInput = z.infer<typeof vcsEditInputSchema>;

export const vcsMoveSpecSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("file"),
      repositoryId: id("Current repository."),
      fileId: id("Stable file identity."),
      destinationRepositoryId: id("Destination repository."),
      destinationPath: canonicalFilePath,
    })
    .strict(),
  z
    .object({
      kind: z.literal("repository"),
      repositoryId: id("Stable repository identity."),
      destinationPath: canonicalRepoPath,
    })
    .strict(),
]);
export type VcsMoveSpec = z.infer<typeof vcsMoveSpecSchema>;

export const vcsMoveInputSchema = z
  .object({ ...mutationEnvelope, moves: z.array(vcsMoveSpecSchema).min(1).max(200) })
  .strict();
export type VcsMoveInput = z.infer<typeof vcsMoveInputSchema>;

export const vcsCopySpecSchema = z
  .object({
    source: z
      .object({
        state: vcsStateNodeRefSchema,
        repositoryId: id("Source repository at the exact source state."),
        fileId: id("Source file identity."),
      })
      .strict(),
    destination: z
      .object({
        repositoryId: id("Destination repository."),
        path: canonicalFilePath,
      })
      .strict(),
  })
  .strict();
export type VcsCopySpec = z.infer<typeof vcsCopySpecSchema>;

export const vcsCopyInputSchema = z
  .object({ ...mutationEnvelope, copies: z.array(vcsCopySpecSchema).min(1).max(200) })
  .strict();
export type VcsCopyInput = z.infer<typeof vcsCopyInputSchema>;

export const vcsMergeResolutionSchema = z
  .object({
    coordinate: vcsMergeCoordinateRefSchema,
    resolution: vcsMergeResolutionKindSchema,
    rationale: nonEmptyText.max(2_000).optional(),
  })
  .strict();

export const vcsMergeAllRemainingResolutionSchema = z
  .object({
    allRemaining: z
      .object({
        resolution: z.enum(["ours", "current"]),
        rationale: nonEmptyText.max(2_000).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.allRemaining.resolution === "current" && !value.allRemaining.rationale) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allRemaining", "rationale"],
        message: "A current resolution requires a rationale",
      });
    }
  });

const uniqueMergeCoordinates = <
  T extends { coordinate: VcsMergeCoordinateRef } | VcsMergeCoordinateRef,
>(
  values: readonly T[],
  context: z.RefinementCtx,
  coordinateOf: (value: T) => VcsMergeCoordinateRef
): void => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const coordinate = coordinateOf(value);
    const key = `${coordinate.kind}:${coordinate.id}`;
    if (seen.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: `Duplicate merge coordinate ${key}`,
      });
    }
    seen.add(key);
  });
};

export const vcsMergeSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), eventId: id("Exact committed source event.") }).strict(),
  z.object({ kind: z.literal("external-delta"), deltaId: id("Exact external delta.") }).strict(),
]);
export type VcsMergeSource = z.infer<typeof vcsMergeSourceSchema>;

export const vcsMergeInputSchema = z
  .object({
    ...mutationEnvelope,
    source: vcsMergeSourceSchema,
    coordinates: z.array(vcsMergeCoordinateRefSchema).max(500).optional(),
    resolutions: z
      .union([z.array(vcsMergeResolutionSchema).max(500), vcsMergeAllRemainingResolutionSchema])
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.coordinates && value.resolutions && !Array.isArray(value.resolutions)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coordinates"],
        message: "allRemaining cannot be combined with an explicit coordinate page",
      });
    }
    uniqueMergeCoordinates(value.coordinates ?? [], context, (coordinate) => coordinate);
    const coordinateResolutions = Array.isArray(value.resolutions) ? value.resolutions : [];
    uniqueMergeCoordinates(coordinateResolutions, context, (resolution) => resolution.coordinate);
    const selected = new Set(
      (value.coordinates ?? []).map((coordinate) => `${coordinate.kind}:${coordinate.id}`)
    );
    for (const resolution of coordinateResolutions) {
      selected.add(`${resolution.coordinate.kind}:${resolution.coordinate.id}`);
    }
    if (selected.size > 500) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "array",
        maximum: 500,
        inclusive: true,
        exact: false,
        path: ["coordinates"],
        message: "A merge may select at most 500 distinct coordinates",
      });
    }
  });
export type VcsMergeInput = z.infer<typeof vcsMergeInputSchema>;

export const vcsRevertInputSchema = z
  .object({ ...mutationEnvelope, changeIds: boundedIds("Change to counteract.") })
  .strict();
export type VcsRevertInput = z.infer<typeof vcsRevertInputSchema>;

export const vcsCommitInputSchema = z
  .object({
    ...mutationEnvelope,
    message: nonEmptyText.optional(),
  })
  .strict();
export type VcsCommitInput = z.infer<typeof vcsCommitInputSchema>;

export const vcsDiscardInputSchema = z.object(mutationEnvelope).strict();
export type VcsDiscardInput = z.infer<typeof vcsDiscardInputSchema>;

export const vcsSnapshotFileSchema = z
  .object({
    path: canonicalFilePath,
    contentHash: DigestSchema.describe("Exact imported content digest."),
    mode: z.number().int().nonnegative().max(0o777),
  })
  .strict();

export const vcsSnapshotRepositorySchema = z
  .object({
    repositoryId: id("Existing repository identity, when replacing its snapshot.").optional(),
    repoPath: canonicalRepoPath,
    files: z.array(vcsSnapshotFileSchema),
  })
  .strict();

const vcsGitImportSourceSchema = z
  .object({
    kind: z.literal("git"),
    url: externalSourceUri.describe("Canonical credential-free Git remote URL."),
    commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .describe("Exact full lowercase Git commit object ID."),
    subdir: canonicalFilePath.optional(),
    snapshot: canonicalSnapshot,
  })
  .strict();

const nonGitImportSource = <const Kind extends "archive" | "filesystem" | "upload" | "generated">(
  kind: Kind
) =>
  z
    .object({
      kind: z.literal(kind),
      uri: externalSourceUri.describe(
        "Canonical credential-free external source identity; never a host checkout path."
      ),
      snapshotRevision: nonEmptyText.max(4_096),
      snapshot: canonicalSnapshot.optional(),
    })
    .strict();

export const vcsImportSourceSchema = z.discriminatedUnion("kind", [
  vcsGitImportSourceSchema,
  nonGitImportSource("archive"),
  nonGitImportSource("filesystem"),
  nonGitImportSource("upload"),
  nonGitImportSource("generated"),
]);
export type VcsImportSource = z.infer<typeof vcsImportSourceSchema>;

export const vcsRegisterExternalDeltaInputSchema = z
  .object({
    ...mutationEnvelope,
    repositoryId: id("Existing target repository."),
    repoPath: canonicalRepoPath,
    oldSource: vcsImportSourceSchema,
    newSource: vcsImportSourceSchema,
    oldFiles: z.array(vcsSnapshotFileSchema),
    newFiles: z.array(vcsSnapshotFileSchema),
    supersedesDeltaId: id("Prior active delta superseded atomically.").optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.oldSource.snapshot || !input.newSource.snapshot) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["oldSource"],
        message: "Both external delta sides require canonical snapshot digests",
      });
    }
    for (const [side, files] of [
      ["oldFiles", input.oldFiles],
      ["newFiles", input.newFiles],
    ] as const) {
      for (const [index, file] of files.entries()) {
        if (index > 0 && files[index - 1]!.path >= file.path) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [side, index, "path"],
            message: "External delta files must be strictly ordered by canonical path",
          });
        }
      }
    }
  });
export type VcsRegisterExternalDeltaInput = z.infer<typeof vcsRegisterExternalDeltaInputSchema>;

export const vcsExternalDeltaLifecycleInputSchema = z
  .object({
    ...mutationEnvelope,
    deltaId: id("External delta."),
  })
  .strict();
export type VcsExternalDeltaLifecycleInput = z.infer<typeof vcsExternalDeltaLifecycleInputSchema>;

export const vcsExternalDeltaResultSchema = z
  .object({
    deltaId: id("External delta."),
    workUnitId: id("Unapplied external work unit."),
    repositoryId: id("Target repository."),
    repoPath: canonicalRepoPath,
    oldSnapshot: canonicalSnapshot,
    newSnapshot: canonicalSnapshot,
    changeCount: z.number().int().nonnegative(),
    changeIds: z.array(id("Authored external change.")).max(200),
    status: z.enum(["active", "superseded", "finalized"]),
  })
  .strict();
export type VcsExternalDeltaResult = z.infer<typeof vcsExternalDeltaResultSchema>;

export const vcsImportSnapshotInputSchema = z
  .object({
    ...mutationEnvelope,
    source: vcsImportSourceSchema,
    repositories: z.array(vcsSnapshotRepositorySchema).min(1),
    message: nonEmptyText.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.source.kind === "git" && input.repositories.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repositories"],
        message: "One Git import must describe exactly one external repository",
      });
    }
    if (input.source.kind === "git") {
      for (const [repositoryIndex, repository] of input.repositories.entries()) {
        for (const [fileIndex, file] of repository.files.entries()) {
          if (file.mode !== 0o644 && file.mode !== 0o755) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["repositories", repositoryIndex, "files", fileIndex, "mode"],
              message: "Git imports admit only regular-file mode 0644 or executable mode 0755",
            });
          }
        }
      }
    }
    const repositoryPaths = new Set<string>();
    const repositoryIds = new Set<string>();
    for (const [repositoryIndex, repository] of input.repositories.entries()) {
      if (repositoryPaths.has(repository.repoPath)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["repositories", repositoryIndex, "repoPath"],
          message: "Snapshot repository paths must be unique",
        });
      }
      repositoryPaths.add(repository.repoPath);
      if (repository.repositoryId) {
        if (repositoryIds.has(repository.repositoryId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["repositories", repositoryIndex, "repositoryId"],
            message: "Snapshot repository identities must be unique",
          });
        }
        repositoryIds.add(repository.repositoryId);
      }
      const paths = new Set<string>();
      for (const [fileIndex, file] of repository.files.entries()) {
        if (paths.has(file.path)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["repositories", repositoryIndex, "files", fileIndex, "path"],
            message: "Snapshot file paths must be unique within a repository",
          });
        }
        paths.add(file.path);
      }
      if (
        repository.files.some(
          (file, index) => index > 0 && repository.files[index - 1]!.path >= file.path
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["repositories", repositoryIndex, "files"],
          message: "Snapshot files must be strictly ordered by canonical path",
        });
      }
    }
    if (
      input.repositories.some(
        (repository, index) =>
          index > 0 && input.repositories[index - 1]!.repoPath >= repository.repoPath
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repositories"],
        message: "Snapshot repositories must be strictly ordered by canonical path",
      });
    }
  });
export type VcsImportSnapshotInput = z.infer<typeof vcsImportSnapshotInputSchema>;

export const vcsPushInputSchema = z
  .object({
    commandId,
    contextId,
    expectedCommittedEventId: id("Exact context commit to publish."),
    expectedMainEventId: id("Observed protected main event."),
  })
  .strict();
export type VcsPushInput = z.infer<typeof vcsPushInputSchema>;

export const vcsWorkingMutationResultSchema = z
  .object({
    commandId: id("Completed command identity."),
    contextId,
    workUnitId: id("Created work unit."),
    applicationId: id("Created local application."),
    changeCount: z.number().int().nonnegative(),
    changeIds: z.array(id("Bounded preview of authored changes.")).max(200),
    incorporatedChangeCount: z.number().int().nonnegative(),
    incorporatedChangeIds: z
      .array(id("Bounded preview of incorporated existing changes."))
      .max(200),
    decisionIds: z.array(id("Bounded preview of integration decisions authored here.")).max(200),
    workingHead: vcsStateNodeRefSchema,
  })
  .strict();
export type VcsWorkingMutationResult = z.infer<typeof vcsWorkingMutationResultSchema>;

export const vcsCommitResultSchema = z
  .object({
    contextId,
    event: vcsStateNodeRefSchema.refine((state) => state.kind === "event", {
      message: "commit must return an event state",
    }),
    committedApplicationIds: z.array(id("Committed application.")).max(10_000),
    integrationSourceEventIds: z.array(id("Integration parent event.")).max(200),
    integrationSourceDeltaIds: z.array(id("Integrated external delta.")).max(200).optional(),
  })
  .strict();
export type VcsCommitResult = z.infer<typeof vcsCommitResultSchema>;

export const vcsDiscardResultSchema = z
  .object({
    contextId,
    workingHead: vcsStateNodeRefSchema,
    discardedApplicationIds: z.array(id("Discarded local application.")).max(10_000),
  })
  .strict();
export type VcsDiscardResult = z.infer<typeof vcsDiscardResultSchema>;

export const vcsImportSnapshotResultSchema = z
  .object({
    contextId,
    eventId: id("Committed import event."),
    workUnitId: id("Import work unit."),
    applicationId: id("Import application committed by the event."),
    externalSnapshot: vcsExternalSnapshotSchema,
    importedRepositoryIds: z.array(id("Imported repository identity.")).min(1),
  })
  .strict();
export type VcsImportSnapshotResult = z.infer<typeof vcsImportSnapshotResultSchema>;

export const vcsPushResultSchema = z
  .object({
    contextId,
    eventId: id("Published event."),
    mainEventId: id("New protected main event."),
    effectId: id("Durable publication effect."),
    appliedAt: timestamp,
  })
  .strict();
export type VcsPushResult = z.infer<typeof vcsPushResultSchema>;

// ---------------------------------------------------------------------------
// Read requests and projections
// ---------------------------------------------------------------------------

export const vcsStatusInputSchema = z.object({ contextId }).strict();
export type VcsStatusInput = z.infer<typeof vcsStatusInputSchema>;

export const vcsIntegrationProjectionSchema = z
  .object({
    source: vcsMergeSourceSchema,
    remainingCoordinateCount: z.number().int().nonnegative(),
    mergeableCoordinateCount: z.number().int().nonnegative(),
    conflictCoordinateCount: z.number().int().nonnegative(),
    concluded: z.boolean(),
    asOfWorkingHead: vcsStateNodeRefSchema,
    stale: z.boolean(),
  })
  .strict();
export type VcsIntegrationProjection = z.infer<typeof vcsIntegrationProjectionSchema>;

export const vcsStatusResultSchema = z
  .object({
    contextId,
    committed: vcsEventNodeRefSchema,
    workingHead: vcsStateNodeRefSchema,
    clean: z.boolean(),
    mainEventId: id("Protected main event."),
    mainRelation: z.enum(["at", "ahead", "behind", "diverged"]),
    workingCounts: z
      .object({
        applications: z.number().int().nonnegative(),
        workUnits: z.number().int().nonnegative(),
        changes: z.number().int().nonnegative(),
      })
      .strict(),
    integrating: z.array(vcsIntegrationProjectionSchema).default([]),
  })
  .strict();
export type VcsStatusResult = z.infer<typeof vcsStatusResultSchema>;

export const vcsIntentProjectionSchema = z
  .object({
    workUnitId: id("Attributed work unit."),
    side: z.enum(["ours", "theirs"]),
    intent: vcsIntentEvidenceSchema,
    coordinates: z.array(vcsMergeCoordinateRefSchema).max(500),
    state: z.enum(["merged", "settled", "split", "contested", "pending"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.side === "theirs") !== (value.state !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: "Only source-side intents carry merge state",
      });
    }
  });

export const vcsMergeAttributionSchema = z
  .object({
    changeId: id("Attributed change."),
    workUnitId: id("Attributed work unit."),
    undone: z.literal(true).optional(),
  })
  .strict();

export const vcsMergeAspectSchema = z
  .object({
    aspect: z.enum(["content", "placement", "mode", "presence", "path"]),
    base: z.unknown(),
    ours: z.unknown(),
    theirs: z.unknown(),
    baseValues: z
      .array(z.object({ eventId: id("Maximal base event."), value: z.unknown() }).strict())
      .min(2)
      .max(200)
      .optional(),
    status: z.enum(["adopt", "convergent", "composed", "conflict", "ours"]),
  })
  .strict();

export const vcsMergeCoordinateSchema = z
  .object({
    coordinate: z
      .object({
        kind: z.enum(["file", "repository"]),
        id: id("Stable coordinate identity."),
        paths: z
          .object({
            base: z.string().optional(),
            ours: z.string().optional(),
            theirs: z.string().optional(),
          })
          .strict(),
      })
      .strict(),
    status: z.enum(["adopt", "convergent", "composed", "conflict", "resolved"]),
    aspects: z.array(vcsMergeAspectSchema).min(1).max(5),
    attribution: z
      .object({
        ours: z.array(vcsMergeAttributionSchema).max(10_000),
        theirs: z.array(vcsMergeAttributionSchema).max(10_000),
      })
      .strict(),
    group: id("Coupled structural group.").optional(),
    structuralConflicts: z.array(vcsMergeCoordinateRefSchema).min(1).max(10_000).optional(),
    resolutions: z.array(vcsMergeResolutionKindSchema).max(4),
    decisionId: id("Reachable resolving decision.").optional(),
    summary: nonEmptyText,
  })
  .strict();

export const vcsMergeResolutionStateSchema = z
  .object({
    complete: z.boolean(),
    remainingCoordinateCount: z.number().int().nonnegative(),
    concluded: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.complete !== (value.remainingCoordinateCount === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["complete"],
        message: "Merge is complete exactly when no coordinates remain",
      });
    }
  });

export const vcsMergeCountsSchema = z
  .object({
    adopt: z.number().int().nonnegative(),
    convergent: z.number().int().nonnegative(),
    composed: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
  })
  .strict();
const intentCountsSchema = z
  .object({
    merged: z.number().int().nonnegative(),
    settled: z.number().int().nonnegative(),
    split: z.number().int().nonnegative(),
    contested: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  })
  .strict();

const compareInput = {
  target: vcsStateNodeRefSchema,
  source: z.union([
    vcsStateNodeRefSchema,
    z.object({ kind: z.literal("external-delta"), deltaId: id("Exact external delta.") }).strict(),
  ]),
  statusFilter: z.literal("conflict").optional(),
  cursor: cursor.optional(),
  limit: pageLimit,
};
export const vcsCompareInputSchema = z.object(compareInput).strict();
export type VcsCompareInput = z.infer<typeof vcsCompareInputSchema>;

export const vcsCompareResultSchema = z
  .object({
    target: vcsStateNodeRefSchema,
    source: compareInput.source,
    base: vcsStateNodeRefSchema,
    bases: z.array(vcsStateNodeRefSchema).min(2).max(200).optional(),
    resolution: vcsMergeResolutionStateSchema,
    counts: vcsMergeCountsSchema,
    intentCounts: intentCountsSchema,
    coordinates: z.array(vcsMergeCoordinateSchema).max(500),
    intents: z.array(vcsIntentProjectionSchema).max(500),
    intentsTruncated: z.boolean(),
    nextCursor: cursor.nullable(),
  })
  .strict();
export type VcsCompareResult = z.infer<typeof vcsCompareResultSchema>;

export const vcsComposedReviewSchema = z
  .object({
    coordinate: vcsMergeCoordinateRefSchema,
    ours: vcsIntentEvidenceSchema,
    theirs: vcsIntentEvidenceSchema,
  })
  .strict();
const vcsMergeReviewFields = {
  resolution: vcsMergeResolutionStateSchema,
  intents: z.array(vcsIntentProjectionSchema).max(500),
  intentsTruncated: z.boolean(),
  counts: vcsMergeCountsSchema,
  conflicts: z.array(vcsMergeCoordinateSchema).max(500),
  nextConflictCursor: cursor.nullable(),
};
export const vcsMergeResultSchema = z.discriminatedUnion("status", [
  vcsWorkingMutationResultSchema.extend({
    status: z.literal("working"),
    decisionId: id("Created merge decision."),
    outcomes: z.array(vcsMergeCoordinateSchema).max(500),
    ...vcsMergeReviewFields,
    composed: z.array(vcsComposedReviewSchema).max(500),
  }),
  z
    .object({
      status: z.literal("unchanged"),
      contextId,
      workingHead: vcsStateNodeRefSchema,
      ...vcsMergeReviewFields,
    })
    .strict(),
]);
export type VcsMergeResult = z.infer<typeof vcsMergeResultSchema>;

export const vcsSemanticCommandSchema = z
  .object({
    commandId: id("Semantic command."),
    workspaceId: id("Owning workspace."),
    contextId: contextId.nullable(),
    method: nonEmptyText,
    status: z.enum(["applying", "effect-pending", "complete"]),
    result: vcsSemanticNodeRefSchema.nullable(),
    createdAt: timestamp,
    completedAt: timestamp.nullable(),
  })
  .strict();

export const vcsRepositoryStateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("present"),
      repositoryId: id("Stable repository identity."),
      repoPath: canonicalRepoPath,
      manifestId: id("Immutable path-to-file identity manifest."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tombstone"),
      repositoryId: id("Stable repository identity."),
      priorPresentStateId: id("Exact prior present state."),
      tombstoneChangeId: id("Change that deleted the repository."),
    })
    .strict(),
]);

export const vcsFileStateSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("placed"),
        fileId: id("Stable file identity."),
        repositoryId: id("Containing repository."),
        path: canonicalFilePath,
        contentHash: id("Exact content blob."),
        mode: z.number().int().nonnegative().max(0o777),
        ...contentDescriptorFields,
      })
      .strict(),
    z
      .object({
        kind: z.literal("tombstone"),
        fileId: id("Stable file identity."),
        priorPlacedStateId: id("Exact prior placed state."),
        tombstoneChangeId: id("Change that deleted the file."),
      })
      .strict(),
  ])
  .superRefine((state, context) => {
    if (state.kind === "placed") validateContentDescriptor(state, context);
  });

/** Small public identity projection from the canonical sanitized trajectory actor/sender. */
export const vcsTrajectorySenderRefSchema = z
  .object({
    kind: nonEmptyText,
    id: id("Canonical sender identity."),
    participantId: id("Channel participant identity, when applicable.").nullable(),
  })
  .strict();
export type VcsTrajectorySenderRef = z.infer<typeof vcsTrajectorySenderRefSchema>;

/** Opaque request carrier retained by the canonical trajectory storage classes. */
export const vcsTrajectoryRequestRefSchema = z
  .object({
    protocol: z.literal("vibestudio.blob-ref.v1"),
    digest: DigestSchema.describe("Content address of the exact invocation request."),
    size: z.number().int().nonnegative(),
    encoding: z.enum(["json", "text"]),
    originalBytes: z.number().int().nonnegative(),
  })
  .strict();
export type VcsTrajectoryRequestRef = z.infer<typeof vcsTrajectoryRequestRefSchema>;

export const vcsInspectedTrajectoryInvocationSchema = z
  .object({
    logId: id("Trajectory log identity."),
    head: id("Exact trajectory head."),
    invocationId: id("Exact tool invocation identity."),
    turnId: id("Agent turn containing this invocation.").nullable(),
    name: nonEmptyText.nullable(),
    status: nonEmptyText,
    terminalOutcome: nonEmptyText.nullable(),
    requestRef: vcsTrajectoryRequestRefSchema.nullable(),
    startedEventId: id("Trajectory event that started this invocation.").nullable(),
    completedEventId: id("Trajectory event that completed this invocation.").nullable(),
  })
  .strict();
export type VcsInspectedTrajectoryInvocation = z.infer<
  typeof vcsInspectedTrajectoryInvocationSchema
>;

export const vcsInspectedTrajectoryTurnSchema = z
  .object({
    logId: id("Trajectory log identity."),
    head: id("Exact trajectory head."),
    turnId: id("Exact agent turn."),
    triggerMessageId: id("Exact message that triggered this turn.").nullable(),
    openedAt: timestamp.nullable(),
    closedAt: timestamp.nullable(),
    summary: nonEmptyText.nullable(),
    ordinal: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type VcsInspectedTrajectoryTurn = z.infer<typeof vcsInspectedTrajectoryTurnSchema>;

export const vcsInspectedTrajectoryMessageSchema = z
  .object({
    logId: id("Trajectory log identity."),
    head: id("Exact trajectory head."),
    messageId: id("Exact trajectory message."),
    turnId: id("Turn containing the message, when applicable.").nullable(),
    role: nonEmptyText,
    status: nonEmptyText,
    startedEventId: id("Trajectory event that started this message.").nullable(),
    completedEventId: id("Trajectory event that completed this message.").nullable(),
    sourceMessageId: id(
      "Original channel message, when the trajectory message was received."
    ).nullable(),
    senderRef: vcsTrajectorySenderRefSchema.nullable(),
    textBlocks: z
      .array(
        z
          .object({
            blockId: id("Stable message block identity."),
            content: z.string(),
          })
          .strict()
      )
      .max(10_000),
  })
  .strict();
export type VcsInspectedTrajectoryMessage = z.infer<typeof vcsInspectedTrajectoryMessageSchema>;

export const vcsInspectedNodeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), value: vcsWorkspaceEventSchema }).strict(),
  z.object({ kind: z.literal("external-delta"), value: vcsExternalDeltaResultSchema }).strict(),
  z.object({ kind: z.literal("application"), value: vcsWorkApplicationSchema }).strict(),
  z.object({ kind: z.literal("applied-change"), value: vcsAppliedChangeSchema }).strict(),
  z.object({ kind: z.literal("work-unit"), value: vcsWorkUnitSchema }).strict(),
  z.object({ kind: z.literal("change"), value: vcsChangeSchema }).strict(),
  z.object({ kind: z.literal("decision"), value: vcsIntegrationDecisionSchema }).strict(),
  z.object({ kind: z.literal("command"), value: vcsSemanticCommandSchema }).strict(),
  z
    .object({
      kind: z.literal("file"),
      state: vcsStateNodeRefSchema,
      value: vcsFileStateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("repository"),
      state: vcsStateNodeRefSchema,
      value: vcsRepositoryStateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("trajectory"),
      value: vcsTrajectoryRefSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("trajectory-invocation"),
      value: vcsInspectedTrajectoryInvocationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("trajectory-turn"),
      value: vcsInspectedTrajectoryTurnSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("trajectory-message"),
      value: vcsInspectedTrajectoryMessageSchema,
    })
    .strict(),
]);
export type VcsInspectedNode = z.infer<typeof vcsInspectedNodeSchema>;

/**
 * The complete immediate provenance-relation vocabulary.
 *
 * Each variant names the normalized fact that owns it and the only endpoint
 * combination that fact may expose. This is deliberately not a graph store:
 * neighbors are derived from the owning facts in either direction. Keeping the
 * endpoint contract here prevents a relation label from acquiring a second,
 * incompatible meaning in a handwritten adjacency branch.
 */
export const vcsProvenanceRelationRegistry = {
  "caused-by": [
    { from: "event", to: "command", fact: "workspace-event.command" },
    { from: "work-unit", to: "command", fact: "work-unit.command" },
    { from: "command", to: "trajectory-invocation", fact: "command.causal-parent" },
  ],
  "basis-state": [
    { from: "application", to: "event", fact: "application.basis" },
    { from: "application", to: "application", fact: "application.basis" },
  ],
  "committed-by": [{ from: "event", to: "application", fact: "event.application" }],
  "parent-event": [{ from: "event", to: "event", fact: "event.parent" }],
  "applies-work": [{ from: "application", to: "work-unit", fact: "application.work-unit" }],
  "applies-change": [
    { from: "application", to: "applied-change", fact: "application.applied-change" },
  ],
  "realizes-change": [{ from: "applied-change", to: "change", fact: "applied-change.change" }],
  "authored-change": [{ from: "work-unit", to: "change", fact: "change.work-unit" }],
  "incorporates-change": [{ from: "work-unit", to: "change", fact: "decision.source-change" }],
  "decides-change": [{ from: "decision", to: "change", fact: "decision.source-change" }],
  "records-decision": [{ from: "work-unit", to: "decision", fact: "decision.work-unit" }],
  "imports-repository": [
    { from: "work-unit", to: "repository", fact: "work-unit.external-snapshot-target" },
  ],
  counteracts: [{ from: "change", to: "change", fact: "change.counteraction" }],
  "authored-copy-source": [{ from: "change", to: "file", fact: "change.authored-source" }],
  "preserves-content": [
    { from: "applied-change", to: "applied-change", fact: "content-edge.mapping" },
  ],
  "copies-content": [
    { from: "applied-change", to: "applied-change", fact: "content-edge.mapping" },
  ],
  "incorporates-content": [
    { from: "applied-change", to: "applied-change", fact: "content-edge.mapping" },
  ],
  "places-file": [
    { from: "event", to: "file", fact: "workspace-state.file" },
    { from: "application", to: "file", fact: "workspace-state.file" },
  ],
  "contains-repository": [
    { from: "event", to: "repository", fact: "workspace-state.repository" },
    { from: "application", to: "repository", fact: "workspace-state.repository" },
  ],
  "part-of-trajectory": [
    { from: "trajectory-invocation", to: "trajectory", fact: "trajectory.invocation" },
    { from: "trajectory-turn", to: "trajectory", fact: "trajectory.turn" },
    { from: "trajectory-message", to: "trajectory", fact: "trajectory.message" },
  ],
  "part-of-turn": [
    { from: "trajectory-invocation", to: "trajectory-turn", fact: "invocation.turn" },
    { from: "trajectory-message", to: "trajectory-turn", fact: "message.turn" },
  ],
  "triggered-by": [
    { from: "trajectory-turn", to: "trajectory-message", fact: "turn.trigger-message" },
  ],
} as const;

export type VcsProvenanceEdgeKind = keyof typeof vcsProvenanceRelationRegistry;

const vcsProvenanceEdgeKinds = Object.keys(vcsProvenanceRelationRegistry) as [
  VcsProvenanceEdgeKind,
  ...VcsProvenanceEdgeKind[],
];

export const vcsProvenanceEdgeKindSchema = z.enum(vcsProvenanceEdgeKinds);

export const vcsProvenanceRelationAllows = (
  kind: VcsProvenanceEdgeKind,
  from: VcsSemanticNodeRef["kind"],
  to: VcsSemanticNodeRef["kind"]
): boolean =>
  vcsProvenanceRelationRegistry[kind].some((variant) => variant.from === from && variant.to === to);

export const vcsProvenanceEdgeSchema = z
  .object({
    kind: vcsProvenanceEdgeKindSchema,
    from: vcsSemanticNodeRefSchema,
    to: vcsSemanticNodeRefSchema,
    summary: nonEmptyText.optional(),
  })
  .strict()
  .superRefine((edge, context) => {
    if (!vcsProvenanceRelationAllows(edge.kind, edge.from.kind, edge.to.kind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: `${edge.kind} cannot connect ${edge.from.kind} to ${edge.to.kind}`,
      });
    }
  });
export type VcsProvenanceEdge = z.infer<typeof vcsProvenanceEdgeSchema>;

export const vcsInspectInputSchema = z
  .object({ node: vcsSemanticNodeRefSchema, edgeLimit: pageLimit })
  .strict();
export type VcsInspectInput = z.infer<typeof vcsInspectInputSchema>;

export const vcsInspectResultSchema = z
  .object({
    root: vcsSemanticNodeRefSchema,
    node: vcsInspectedNodeSchema,
    edges: z.array(vcsProvenanceEdgeSchema).max(500),
    hasMoreEdges: z.boolean(),
  })
  .strict();
export type VcsInspectResult = z.infer<typeof vcsInspectResultSchema>;

export const vcsNeighborsInputSchema = z
  .object({ root: vcsSemanticNodeRefSchema, cursor: cursor.optional(), limit: pageLimit })
  .strict();
export type VcsNeighborsInput = z.infer<typeof vcsNeighborsInputSchema>;

export const vcsNeighborsResultSchema = z
  .object({
    root: vcsSemanticNodeRefSchema,
    edges: z.array(vcsProvenanceEdgeSchema).max(500),
    nextCursor: cursor.nullable(),
  })
  .strict();
export type VcsNeighborsResult = z.infer<typeof vcsNeighborsResultSchema>;

export const vcsHistoryRootSchema = z.discriminatedUnion("kind", [
  vcsEventNodeRefSchema,
  vcsFileNodeRefSchema,
]);
export type VcsHistoryRoot = z.infer<typeof vcsHistoryRootSchema>;

const historyPageFields = {
  cursor: cursor.optional(),
  limit: pageLimit,
};

export const vcsHistoryInputSchema = z.union([
  z
    .object({
      root: vcsEventNodeRefSchema,
      direction: z.enum(["past", "future"]).default("past"),
      ...historyPageFields,
    })
    .strict(),
  z
    .object({
      root: vcsFileNodeRefSchema,
      direction: z.literal("past").default("past"),
      ...historyPageFields,
    })
    .strict(),
]);
export type VcsHistoryInput = z.infer<typeof vcsHistoryInputSchema>;

export const vcsHistoryEntrySchema = z
  .object({
    node: vcsSemanticNodeRefSchema,
    createdAt: timestamp.nullable(),
    summary: nonEmptyText,
    intent: vcsIntentEvidenceSchema.optional(),
    viaDecisionId: id(
      "Merge decision through which this authored change entered history."
    ).optional(),
  })
  .strict();

export const vcsHistoryResultSchema = z
  .object({
    root: vcsHistoryRootSchema,
    entries: z.array(vcsHistoryEntrySchema).max(500),
    nextCursor: cursor.nullable(),
  })
  .strict();
export type VcsHistoryResult = z.infer<typeof vcsHistoryResultSchema>;

export const vcsBlameInputSchema = z
  .object({
    state: vcsStateNodeRefSchema,
    repositoryId: id("Repository containing the file at this state."),
    fileId: id("Stable file identity."),
    range: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
      })
      .strict()
      .refine((range) => range.end >= range.start, { message: "end must be >= start" }),
    cursor: cursor.optional(),
    limit: pageLimit,
  })
  .strict();
export type VcsBlameInput = z.infer<typeof vcsBlameInputSchema>;

export const vcsBlameSpanSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    change: vcsChangeNodeRefSchema.describe("Terminal authored change root."),
    appliedChange: vcsAppliedChangeNodeRefSchema.describe("Terminal applied change root."),
    workUnit: vcsWorkUnitNodeRefSchema.describe("Original authored work unit root."),
    workUnitId: id("Original authored work unit."),
    tier: z.enum(["stated", "trigger", "mechanical"]),
    command: vcsCommandNodeRefSchema.describe("Originating semantic command root."),
    path: z.array(vcsProvenanceEdgeSchema).max(200),
    stop: z.enum(["authored", "import-boundary"]),
  })
  .strict();
export type VcsBlameSpan = z.infer<typeof vcsBlameSpanSchema>;

export const vcsBlameResultSchema = z
  .object({
    state: vcsStateNodeRefSchema,
    fileId: id("Stable file identity."),
    coordinateKind: z.enum(["utf16", "byte"]),
    spans: z.array(vcsBlameSpanSchema).max(500),
    nextCursor: cursor.nullable(),
  })
  .strict();
export type VcsBlameResult = z.infer<typeof vcsBlameResultSchema>;

const vcsReadMemoryRangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict()
  .refine((range) => range.end >= range.start, { message: "end must be >= start" });

const vcsReadMemoryWorkspacePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      const split = splitRepoPath(value);
      return Boolean(split?.repoRelPath) && semanticVcsPathAdmission(value).admissible;
    },
    {
      message: "Expected an admissible canonical workspace file path inside a managed repository",
    }
  );

export const vcsReadMemoryInputSchema = z
  .object({
    contextId,
    path: vcsReadMemoryWorkspacePathSchema,
    expectedContentHash: DigestSchema.describe(
      "Hash of the bytes actually returned by the file read; prevents memory from being attached to a different revision."
    ),
    range: vcsReadMemoryRangeSchema,
    episodeLimit: z.number().int().positive().max(12).default(4),
    historyLimit: z.number().int().nonnegative().max(8).default(3),
  })
  .strict();
export type VcsReadMemoryInput = z.infer<typeof vcsReadMemoryInputSchema>;

export const vcsReadMemoryArrivalSchema = z
  .object({
    decision: z
      .object({ kind: z.literal("decision"), decisionId: id("Anchoring integration decision.") })
      .strict(),
    resolution: z.enum(["adopt", "convergent", "composed", "ours", "current"]),
    mode: z.enum(["arrived", "accepted"]),
    rationale: nonEmptyText.nullable(),
    parentIntents: z
      .array(
        z
          .object({
            workUnitId: id("Parent authoring work unit."),
            role: z.enum(["source", "current"]),
            intent: vcsIntentEvidenceSchema,
          })
          .strict()
      )
      .max(2),
  })
  .strict();

export const vcsReadMemoryEpisodeSchema = z
  .object({
    ranges: z.array(vcsReadMemoryRangeSchema).min(1).max(500),
    stop: z.enum(["authored", "import-boundary"]),
    change: vcsChangeNodeRefSchema,
    appliedChange: vcsAppliedChangeNodeRefSchema,
    workUnit: vcsWorkUnitNodeRefSchema,
    command: vcsCommandNodeRefSchema,
    changeKind: vcsChangeKindSchema,
    counteractsChangeIds: z.array(id("Counteracted change.")).max(200),
    intent: vcsIntentEvidenceSchema,
    authorContextId: contextId,
    createdAt: timestamp,
    externalSnapshot: vcsExternalSnapshotSchema.nullable(),
    commit: z
      .object({
        event: vcsEventNodeRefSchema,
        message: nonEmptyText.nullable(),
        createdAt: timestamp,
      })
      .strict()
      .nullable(),
    arrival: vcsReadMemoryArrivalSchema.nullable(),
  })
  .strict();
export type VcsReadMemoryEpisode = z.infer<typeof vcsReadMemoryEpisodeSchema>;

export const vcsReadMemoryResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("attached"),
      state: vcsStateNodeRefSchema,
      repositoryId: id("Repository containing the read file."),
      fileId: id("Stable file identity."),
      path: vcsReadMemoryWorkspacePathSchema,
      contentHash: DigestSchema,
      range: vcsReadMemoryRangeSchema,
      coordinateKind: z.literal("utf16"),
      episodes: z.array(vcsReadMemoryEpisodeSchema).max(12),
      history: z.array(vcsHistoryEntrySchema).max(8),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal("stale"),
      path: vcsReadMemoryWorkspacePathSchema,
      expectedContentHash: DigestSchema,
      currentContentHash: DigestSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unmanaged"),
      path: vcsReadMemoryWorkspacePathSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unsupported"),
      path: vcsReadMemoryWorkspacePathSchema,
      reason: z.literal("non-text"),
    })
    .strict(),
]);
export type VcsReadMemoryResult = z.infer<typeof vcsReadMemoryResultSchema>;

export const vcsResolveRepositoryInputSchema = z
  .object({
    state: vcsStateNodeRefSchema,
    repoPath: canonicalRepoPath,
  })
  .strict();
export type VcsResolveRepositoryInput = z.infer<typeof vcsResolveRepositoryInputSchema>;

export const vcsResolveRepositoryResultSchema = z
  .object({
    state: vcsStateNodeRefSchema,
    repositoryId: id("Stable repository identity."),
    repoPath: canonicalRepoPath,
  })
  .strict()
  .nullable();
export type VcsResolveRepositoryResult = z.infer<typeof vcsResolveRepositoryResultSchema>;

export const vcsReadFileInputSchema = z
  .object({
    state: vcsStateNodeRefSchema,
    repositoryId: id("Repository containing the file."),
    file: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("id"), fileId: id("Stable file identity.") }).strict(),
      z.object({ kind: z.literal("path"), path: canonicalFilePath }).strict(),
    ]),
  })
  .strict();
export type VcsReadFileInput = z.infer<typeof vcsReadFileInputSchema>;

export const vcsReadFileResultSchema = z
  .object({
    repositoryId: id("Stable repository identity."),
    fileId: id("Stable file identity."),
    repoPath: canonicalRepoPath,
    path: canonicalFilePath,
    contentHash: id("Exact content blob."),
    authoredChangeId: id("Exact semantic change that authored this file version."),
    authoredByWorkUnitId: id("Work unit carrying this file version's persisted content class."),
    contentClass: z.enum(["internal", "external"]),
    externalKeys: z.array(z.string().min(1)).max(256),
    mode: z.number().int().nonnegative().max(0o777),
    content: vcsFileReadContentSchema,
  })
  .strict()
  .nullable();
export type VcsReadFileResult = z.infer<typeof vcsReadFileResultSchema>;

const vcsVisibleEntryLineageSchema = z
  .object({
    authoredChangeId: id("Exact semantic change witnessing this visible name.").nullable(),
    authoredByWorkUnitId: id("Work unit witnessing this visible name."),
    contentClass: z.enum(["internal", "external"]),
    externalKeys: z.array(z.string().min(1)).max(256),
  })
  .strict();

export const vcsListDirectoryInputSchema = z
  .object({
    state: vcsStateNodeRefSchema,
    path: z.string().refine((value) => value === "" || semanticVcsPathAdmission(value).admissible, {
      message:
        `Expected an admissible canonical workspace-relative directory path of at most ` +
        `${SEMANTIC_VCS_MAX_PATH_UTF8_BYTES} UTF-8 bytes`,
    }),
    cursor: cursor.optional(),
    limit: pageLimit,
  })
  .strict();
export type VcsListDirectoryInput = z.infer<typeof vcsListDirectoryInputSchema>;

export const vcsVisibleDirectoryEntrySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .refine((value) => !value.includes("/")),
    path: z.string().min(1),
    kind: z.enum(["file", "directory"]),
    identity: id("Stable semantic identity of the visible entry."),
    repositoryId: id("Containing or witnessed repository identity.").nullable(),
    repositoryRoot: z.boolean(),
    fileId: id("Stable file identity when the entry is a file.").nullable(),
    lineage: vcsVisibleEntryLineageSchema,
  })
  .strict();

export const vcsListDirectoryResultSchema = z
  .object({
    state: vcsStateNodeRefSchema,
    path: z.string(),
    entries: z.array(vcsVisibleDirectoryEntrySchema).max(500),
    nextCursor: cursor.nullable(),
  })
  .strict()
  .nullable();
export type VcsListDirectoryResult = z.infer<typeof vcsListDirectoryResultSchema>;

export const vcsListFilesInputSchema = z
  .object({
    state: vcsStateNodeRefSchema,
    repositoryId: id("Repository to list."),
    prefix: z.string().optional(),
    cursor: cursor.optional(),
    limit: pageLimit,
  })
  .strict();
export type VcsListFilesInput = z.infer<typeof vcsListFilesInputSchema>;

export const vcsFileListEntrySchema = z
  .object({
    fileId: id("Stable file identity."),
    path: canonicalFilePath,
    contentHash: id("Exact content blob."),
    authoredChangeId: id("Exact semantic change that authored this file version."),
    authoredByWorkUnitId: id("Work unit carrying this file version's persisted content class."),
    contentClass: z.enum(["internal", "external"]),
    externalKeys: z.array(z.string().min(1)).max(256),
    mode: z.number().int().nonnegative().max(0o777),
    ...contentDescriptorFields,
  })
  .strict()
  .superRefine(validateContentDescriptor);

export const vcsListFilesResultSchema = z
  .object({
    state: vcsStateNodeRefSchema,
    repositoryId: id("Listed repository."),
    files: z.array(vcsFileListEntrySchema).max(500),
    nextCursor: cursor.nullable(),
  })
  .strict();
export type VcsListFilesResult = z.infer<typeof vcsListFilesResultSchema>;

// ---------------------------------------------------------------------------
// Minimal typed failure vocabulary
// ---------------------------------------------------------------------------

const errorBase = { message: nonEmptyText };
export const vcsErrorSchema = z.discriminatedUnion("code", [
  z
    .object({
      code: z.literal("RevisionChanged"),
      ...errorBase,
      expected: vcsStateNodeRefSchema,
      actual: vcsStateNodeRefSchema,
    })
    .strict(),
  z.object({ code: z.literal("Unauthorized"), ...errorBase, operation: nonEmptyText }).strict(),
  z
    .object({
      code: z.literal("InvalidReference"),
      ...errorBase,
      referenceKind: nonEmptyText,
      reference: z.unknown(),
    })
    .strict(),
  z.object({ code: z.literal("NoEffect"), ...errorBase, commandId }).strict(),
  z
    .object({
      code: z.literal("DestinationOccupied"),
      ...errorBase,
      repositoryId: id("Occupied repository."),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      code: z.literal("ConflictPresent"),
      ...errorBase,
      coordinates: z.array(vcsMergeCoordinateSchema).min(1).max(500),
    })
    .strict(),
  z
    .object({
      code: z.literal("CoupledGroupIncomplete"),
      ...errorBase,
      group: id("Coupled structural group."),
      coordinates: z.array(vcsMergeCoordinateRefSchema).min(2).max(500),
    })
    .strict(),
  z
    .object({
      code: z.literal("IntegrationIncomplete"),
      ...errorBase,
      source: vcsMergeSourceSchema,
      unaccountedCoordinates: z.array(vcsMergeCoordinateRefSchema).min(1).max(500),
    })
    .strict(),
  z
    .object({
      code: z.literal("WorkingChangesPresent"),
      ...errorBase,
      contextId,
      workingHead: vcsStateNodeRefSchema,
    })
    .strict(),
  z.object({ code: z.literal("CommandIdReuse"), ...errorBase, commandId }).strict(),
  z
    .object({
      code: z.literal("ScopeTooLarge"),
      ...errorBase,
      scope: nonEmptyText,
      maximum: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      code: z.literal("ExternalEffectFailed"),
      ...errorBase,
      effectId: id("Failed host effect."),
    })
    .strict(),
  z
    .object({
      code: z.literal("BuildGateFailed"),
      ...errorBase,
      candidateState: id("Exact candidate workspace state checked before publication."),
      affectedUnits: z.array(id("Build unit in the affected dependency closure.")).max(10_000),
      diagnostics: z.array(buildDiagnosticSchema).max(100_000),
    })
    .strict(),
  z
    .object({
      code: z.literal("IntegrityFailure"),
      ...errorBase,
      handle: id("Opaque integrity diagnostic."),
    })
    .strict(),
]);
export type VcsError = z.infer<typeof vcsErrorSchema>;
export type VcsErrorCode = VcsError["code"];
export type VcsErrorForCode<C extends VcsErrorCode> = Extract<VcsError, { code: C }>;

export function createVcsError<const E extends VcsError>(error: E): E {
  return vcsErrorSchema.parse(error) as E;
}

const ERROR_DESCRIPTIONS: Record<VcsErrorCode, string> = {
  RevisionChanged: "The exact working or committed basis advanced.",
  Unauthorized: "The caller cannot reach or mutate the requested semantic root.",
  InvalidReference: "A typed semantic reference is invalid.",
  NoEffect: "The requested mutation has no semantic effect.",
  DestinationOccupied: "A move, copy, create, or import destination is occupied.",
  ConflictPresent: "An explicitly selected coordinate conflicts at the exact target basis.",
  CoupledGroupIncomplete: "The selected coordinate subset splits a coupled structural group.",
  IntegrationIncomplete: "An integration commit still has unaccounted source coordinates.",
  WorkingChangesPresent: "The operation requires a clean context.",
  CommandIdReuse: "The command identity was reused with a different request.",
  ScopeTooLarge: "The bounded operation requires a narrower request or page.",
  ExternalEffectFailed: "A requested host effect failed.",
  BuildGateFailed: "The exact candidate build/typecheck gate failed.",
  IntegrityFailure: "The semantic graph failed an integrity invariant.",
};

const methodErrors = (...codes: VcsErrorCode[]) =>
  codes.map((code) => ({ code, description: ERROR_DESCRIPTIONS[code] }));

const READ_ERRORS = methodErrors(
  "Unauthorized",
  "InvalidReference",
  "ScopeTooLarge",
  "IntegrityFailure"
);
const MUTATION_ERRORS = methodErrors(
  "RevisionChanged",
  "Unauthorized",
  "InvalidReference",
  "NoEffect",
  "CommandIdReuse",
  "ScopeTooLarge",
  "IntegrityFailure"
);

// ---------------------------------------------------------------------------
// Explicit request-reference metadata (no Zod private reflection)
// ---------------------------------------------------------------------------

export const vcsSemanticReferenceKinds = [
  "context",
  "state-node",
  "event",
  "application",
  "work-unit",
  "external-delta",
  "change",
  "decision",
  "command",
  "repository",
  "file",
  "node",
] as const;
export type VcsSemanticReferenceKind = (typeof vcsSemanticReferenceKinds)[number];
export type VcsSemanticReferenceRole =
  | "context"
  | "basis"
  | "source"
  | "target"
  | "resource"
  | "provenance-root"
  | "publication";

export interface VcsReferenceDescriptor {
  kind: VcsSemanticReferenceKind;
  role: VcsSemanticReferenceRole;
  /** Dot-free path segments from the sole request object; `*` walks an array. */
  path: readonly string[];
}

export interface VcsSemanticReference extends VcsReferenceDescriptor {
  value: unknown;
  /** Concrete path after expanding `*` array segments. */
  concretePath: readonly (string | number)[];
}

type VcsOperationClass = "read" | "context-write" | "workspace-write";
interface VcsMethodSchema extends MethodSchema {
  operationClass: VcsOperationClass;
  references: readonly VcsReferenceDescriptor[];
}

const ref = <
  const Kind extends VcsSemanticReferenceKind,
  const Role extends VcsSemanticReferenceRole,
  const Path extends readonly string[],
>(
  kind: Kind,
  role: Role,
  ...path: Path
): VcsReferenceDescriptor & { kind: Kind; role: Role; path: Path } => ({ kind, role, path });

const commonMutationRefs = [
  ref("command", "resource", "commandId"),
  ref("context", "context", "contextId"),
  ref("state-node", "basis", "expectedWorkingHead"),
] as const;

const defineVcsMethods = <const M extends Record<string, VcsMethodSchema>>(methods: M): M =>
  defineServiceMethods(methods) as M;

// ---------------------------------------------------------------------------
// Sole exhaustive public method registry
// ---------------------------------------------------------------------------

const vcsSemanticMethods = defineVcsMethods({
  edit: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.mutate",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description:
      "Atomically create repositories with their initial files or author exact text, binary, file-create, delete, and mode changes on the working head.",
    args: z.tuple([vcsEditInputSchema]),
    returns: vcsWorkingMutationResultSchema,
    access: WRITE_ACCESS,
    operationClass: "context-write",
    references: [
      ...commonMutationRefs,
      ref("repository", "resource", "changes", "*", "repositoryId"),
      ref("file", "resource", "changes", "*", "fileId"),
    ],
    errors: [...MUTATION_ERRORS, ...methodErrors("DestinationOccupied")],
    seeAlso: ["vcs.move", "vcs.copy", "vcs.revert"],
  },
  move: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description:
      "Move stable file or repository identities without reconstructing intent from bytes.",
    args: z.tuple([vcsMoveInputSchema]),
    returns: vcsWorkingMutationResultSchema,
    access: WRITE_ACCESS,
    operationClass: "context-write",
    references: [
      ...commonMutationRefs,
      ref("repository", "resource", "moves", "*", "repositoryId"),
      ref("repository", "target", "moves", "*", "destinationRepositoryId"),
      ref("file", "resource", "moves", "*", "fileId"),
    ],
    errors: [...MUTATION_ERRORS, ...methodErrors("DestinationOccupied")],
    seeAlso: ["vcs.copy", "vcs.neighbors"],
  },
  copy: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description:
      "Copy exact source files into new identities with immediate coordinate provenance.",
    args: z.tuple([vcsCopyInputSchema]),
    returns: vcsWorkingMutationResultSchema,
    access: WRITE_ACCESS,
    operationClass: "context-write",
    references: [
      ...commonMutationRefs,
      ref("state-node", "source", "copies", "*", "source", "state"),
      ref("repository", "source", "copies", "*", "source", "repositoryId"),
      ref("file", "source", "copies", "*", "source", "fileId"),
      ref("repository", "target", "copies", "*", "destination", "repositoryId"),
    ],
    errors: [...MUTATION_ERRORS, ...methodErrors("DestinationOccupied")],
    seeAlso: ["vcs.move", "vcs.blame"],
  },
  merge: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description:
      "Merge one bounded page of stable coordinates from an exact event or external delta by net effect.",
    args: z.tuple([vcsMergeInputSchema]),
    returns: vcsMergeResultSchema,
    access: WRITE_ACCESS,
    operationClass: "context-write",
    references: [
      ...commonMutationRefs,
      ref("event", "source", "source", "eventId"),
      ref("external-delta", "source", "source", "deltaId"),
    ],
    errors: [...MUTATION_ERRORS, ...methodErrors("ConflictPresent", "CoupledGroupIncomplete")],
    seeAlso: ["vcs.compare", "vcs.commit"],
  },
  revert: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description: "Author explicit counteractions of exact semantic changes.",
    args: z.tuple([vcsRevertInputSchema]),
    returns: vcsWorkingMutationResultSchema,
    access: DESTRUCTIVE_ACCESS,
    operationClass: "context-write",
    references: [...commonMutationRefs, ref("change", "source", "changeIds", "*")],
    errors: [...MUTATION_ERRORS, ...methodErrors("ConflictPresent")],
    seeAlso: ["vcs.history", "vcs.discard"],
  },
  commit: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.mutate",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description:
      "Commit the complete local application chain; derive every integration parent from recorded merge decisions.",
    args: z.tuple([vcsCommitInputSchema]),
    returns: vcsCommitResultSchema,
    access: WRITE_ACCESS,
    operationClass: "context-write",
    references: commonMutationRefs,
    errors: [...MUTATION_ERRORS, ...methodErrors("IntegrationIncomplete")],
    seeAlso: ["vcs.status", "vcs.push"],
  },
  discard: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description: "Discard the complete uncommitted chain and return to the committed event.",
    args: z.tuple([vcsDiscardInputSchema]),
    returns: vcsDiscardResultSchema,
    access: DESTRUCTIVE_ACCESS,
    operationClass: "context-write",
    references: commonMutationRefs,
    errors: MUTATION_ERRORS,
    seeAlso: ["vcs.revert", "vcs.status"],
  },
  importSnapshot: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description:
      "Import one exact complete external snapshot as ordinary changes on an import work unit and atomically return the committed event, application, work unit, admitted repository IDs, and canonical external snapshot.",
    args: z.tuple([vcsImportSnapshotInputSchema]),
    returns: vcsImportSnapshotResultSchema,
    access: WRITE_ACCESS,
    operationClass: "context-write",
    references: [
      ...commonMutationRefs,
      ref("repository", "resource", "repositories", "*", "repositoryId"),
    ],
    errors: [
      ...MUTATION_ERRORS,
      ...methodErrors("DestinationOccupied", "WorkingChangesPresent", "ExternalEffectFailed"),
    ],
    seeAlso: ["vcs.blame", "vcs.inspect"],
  },
  registerExternalDelta: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.create",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description: "Register one exact unapplied old-to-new external repository delta.",
    args: z.tuple([vcsRegisterExternalDeltaInputSchema]),
    returns: vcsExternalDeltaResultSchema,
    access: WRITE_ACCESS,
    operationClass: "context-write",
    references: [
      ...commonMutationRefs,
      ref("repository", "resource", "repositoryId"),
      ref("external-delta", "source", "supersedesDeltaId"),
    ],
    errors: [...MUTATION_ERRORS, ...methodErrors("ExternalEffectFailed")],
    seeAlso: ["vcs.compare", "vcs.merge"],
  },
  supersedeExternalDelta: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description: "Retire one active external delta so it can no longer be merged.",
    args: z.tuple([vcsExternalDeltaLifecycleInputSchema]),
    returns: vcsExternalDeltaResultSchema,
    access: WRITE_ACCESS,
    operationClass: "context-write",
    references: [...commonMutationRefs, ref("external-delta", "source", "deltaId")],
    errors: MUTATION_ERRORS,
    seeAlso: ["vcs.compare"],
  },
  finalizeExternalDelta: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description: "Finalize one fully decided external delta and release its dedicated GC roots.",
    args: z.tuple([vcsExternalDeltaLifecycleInputSchema]),
    returns: vcsExternalDeltaResultSchema,
    access: WRITE_ACCESS,
    operationClass: "context-write",
    references: [...commonMutationRefs, ref("external-delta", "source", "deltaId")],
    errors: [...MUTATION_ERRORS, ...methodErrors("IntegrationIncomplete")],
    seeAlso: ["vcs.commit", "vcs.compare"],
  },
  push: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.mutate",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description: "Publish one exact already-committed event to protected main.",
    args: z.tuple([vcsPushInputSchema]),
    returns: vcsPushResultSchema,
    access: WRITE_ACCESS,
    operationClass: "workspace-write",
    references: [
      ref("command", "resource", "commandId"),
      ref("context", "context", "contextId"),
      ref("event", "publication", "expectedCommittedEventId"),
      ref("event", "basis", "expectedMainEventId"),
    ],
    errors: [
      ...methodErrors(
        "RevisionChanged",
        "Unauthorized",
        "InvalidReference",
        "WorkingChangesPresent",
        "CommandIdReuse",
        "ExternalEffectFailed",
        "BuildGateFailed",
        "IntegrityFailure"
      ),
    ],
    seeAlso: ["vcs.commit", "vcs.status"],
  },
  status: {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "vcs.read-transport",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description: "Return context pointers, clean state, main relation, and compact working counts.",
    args: z.tuple([vcsStatusInputSchema]),
    returns: vcsStatusResultSchema,
    access: READ_ACCESS,
    operationClass: "read",
    references: [ref("context", "context", "contextId")],
    errors: READ_ERRORS,
    seeAlso: ["vcs.compare", "vcs.history"],
  },
  compare: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description:
      "Compare an exact target state with a committed source event or coordinator-owned external delta by semantic change.",
    args: z.tuple([vcsCompareInputSchema]),
    returns: vcsCompareResultSchema,
    access: READ_ACCESS,
    operationClass: "read",
    references: [
      ref("state-node", "target", "target"),
      ref("event", "source", "source", "eventId"),
      ref("external-delta", "source", "source", "deltaId"),
    ],
    errors: READ_ERRORS,
    seeAlso: ["vcs.merge", "vcs.inspect"],
  },
  inspect: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.read-protected",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description: "Inspect one typed semantic node and a bounded preview of its direct adjacency.",
    args: z.tuple([vcsInspectInputSchema]),
    returns: vcsInspectResultSchema,
    access: READ_ACCESS,
    operationClass: "read",
    references: [ref("node", "provenance-root", "node")],
    errors: READ_ERRORS,
    seeAlso: ["vcs.neighbors", "vcs.history"],
  },
  neighbors: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description: "Page immediate typed provenance edges without persisting traversal state.",
    args: z.tuple([vcsNeighborsInputSchema]),
    returns: vcsNeighborsResultSchema,
    access: READ_ACCESS,
    operationClass: "read",
    references: [ref("node", "provenance-root", "root")],
    errors: READ_ERRORS,
    seeAlso: ["vcs.inspect", "vcs.blame"],
  },
  history: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description:
      "Page event history in either direction or past file history from one exact state.",
    args: z.tuple([vcsHistoryInputSchema]),
    returns: vcsHistoryResultSchema,
    access: READ_ACCESS,
    operationClass: "read",
    references: [ref("node", "provenance-root", "root")],
    errors: READ_ERRORS,
    seeAlso: ["vcs.inspect", "vcs.neighbors"],
  },
  blame: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description: "Trace an exact bounded file range through immediate content-coordinate mappings.",
    args: z.tuple([vcsBlameInputSchema]),
    returns: vcsBlameResultSchema,
    access: READ_ACCESS,
    operationClass: "read",
    references: [
      ref("state-node", "basis", "state"),
      ref("repository", "resource", "repositoryId"),
      ref("file", "resource", "fileId"),
    ],
    errors: READ_ERRORS,
    seeAlso: ["vcs.neighbors", "vcs.history"],
  },
  readMemory: {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "vcs.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description:
      "Project bounded blame-backed workspace memory for the exact text range and content hash returned by a managed file read.",
    args: z.tuple([vcsReadMemoryInputSchema]),
    returns: vcsReadMemoryResultSchema,
    access: READ_ACCESS,
    operationClass: "read",
    references: [ref("context", "context", "contextId")],
    errors: READ_ERRORS,
    seeAlso: ["vcs.blame", "vcs.inspect", "vcs.history"],
  },
  resolveRepository: {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "vcs.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description: "Resolve one canonical repository path at one exact semantic state.",
    args: z.tuple([vcsResolveRepositoryInputSchema]),
    returns: vcsResolveRepositoryResultSchema,
    access: READ_ACCESS,
    operationClass: "read",
    references: [ref("state-node", "basis", "state")],
    errors: READ_ERRORS,
    seeAlso: ["vcs.listFiles", "vcs.inspect"],
  },
  readFile: {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "vcs.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description: "Read one file from an exact semantic state.",
    args: z.tuple([vcsReadFileInputSchema]),
    returns: vcsReadFileResultSchema,
    access: READ_ACCESS,
    operationClass: "read",
    references: [
      ref("state-node", "basis", "state"),
      ref("repository", "resource", "repositoryId"),
      ref("file", "resource", "file", "fileId"),
    ],
    errors: [...READ_ERRORS, ...methodErrors("ExternalEffectFailed")],
    seeAlso: ["vcs.listFiles", "vcs.blame"],
  },
  listDirectory: {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "vcs.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description:
      "Page immediate visible children of one workspace directory with stable identities and attached name provenance.",
    args: z.tuple([vcsListDirectoryInputSchema]),
    returns: vcsListDirectoryResultSchema,
    access: READ_ACCESS,
    operationClass: "read",
    references: [ref("state-node", "basis", "state")],
    errors: READ_ERRORS,
    seeAlso: ["vcs.readFile", "vcs.listFiles", "vcs.resolveRepository"],
  },
  listFiles: {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "vcs.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    description: "Page the exact path-to-file manifest of one repository at one semantic state.",
    args: z.tuple([vcsListFilesInputSchema]),
    returns: vcsListFilesResultSchema,
    access: READ_ACCESS,
    operationClass: "read",
    references: [
      ref("state-node", "basis", "state"),
      ref("repository", "resource", "repositoryId"),
    ],
    errors: READ_ERRORS,
    seeAlso: ["vcs.readFile", "vcs.inspect"],
  },
});

/**
 * Agent-facing VCS surface. External deltas are context-owned semantic review
 * resources: callers may register, supersede, and finalize only deltas reachable
 * from their authorized context graph, and finalization succeeds only after the
 * semantic engine verifies that every effective change is accounted for.
 */
export const vcsMethods = vcsSemanticMethods;
export type VcsMethodName = keyof typeof vcsMethods;
export type VcsSemanticMethodName = keyof typeof vcsSemanticMethods;

export type VcsOperationMetadata = Readonly<{
  accessClass: VcsOperationClass;
  references: readonly VcsReferenceDescriptor[];
}>;

export const vcsOperationRegistry = Object.freeze(
  Object.fromEntries(
    Object.entries(vcsMethods).map(([method, definition]) => [
      method,
      Object.freeze({
        accessClass: definition.operationClass,
        references: definition.references,
      }),
    ])
  ) as unknown as Record<VcsMethodName, VcsOperationMetadata>
);

const vcsAllSemanticReferenceInventory = Object.freeze(
  Object.fromEntries(
    Object.entries(vcsSemanticMethods).map(([method, definition]) => [
      method,
      definition.references,
    ])
  ) as unknown as Record<VcsSemanticMethodName, readonly VcsReferenceDescriptor[]>
);

export const vcsSemanticReferenceInventory = Object.freeze(
  Object.fromEntries(
    Object.entries(vcsMethods).map(([method, definition]) => [method, definition.references])
  ) as unknown as Record<VcsMethodName, readonly VcsReferenceDescriptor[]>
);

function collectPathValues(
  value: unknown,
  path: readonly string[],
  concretePath: readonly (string | number)[] = []
): Array<{ value: unknown; concretePath: readonly (string | number)[] }> {
  if (path.length === 0) {
    return value === undefined ? [] : [{ value, concretePath }];
  }
  const [head, ...tail] = path;
  if (head === undefined) return [];
  if (head === "*") {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item, index) => collectPathValues(item, tail, [...concretePath, index]));
  }
  if (!value || typeof value !== "object") return [];
  return collectPathValues((value as Record<string, unknown>)[head], tail, [...concretePath, head]);
}

/** Reference extraction is driven only by stable public descriptors. */
export function extractVcsSemanticReferences(
  method: VcsSemanticMethodName,
  canonicalArgs: readonly unknown[]
): VcsSemanticReference[] {
  const input = canonicalArgs[0];
  return vcsAllSemanticReferenceInventory[method].flatMap((descriptor) =>
    collectPathValues(input, descriptor.path).map(({ value, concretePath }) => ({
      ...descriptor,
      value,
      concretePath: [0, ...concretePath],
    }))
  );
}

export function parseVcsSemanticRequest(
  method: VcsSemanticMethodName,
  input: unknown
): { input: unknown; references: VcsSemanticReference[] } {
  const canonicalArgs = vcsSemanticMethods[method].args.parse([input]) as unknown[];
  return {
    input: canonicalArgs[0],
    references: extractVcsSemanticReferences(method, canonicalArgs),
  };
}

/** Metadata is already explicit; this asserts registry completeness only. */
export function assertVcsSemanticReferenceContract(): void {
  for (const method of Object.keys(vcsSemanticMethods) as VcsSemanticMethodName[]) {
    if (!Object.hasOwn(vcsAllSemanticReferenceInventory, method)) {
      throw new Error(`VCS ${method} lacks explicit semantic reference metadata`);
    }
  }
}

export function vcsOperationContextId(method: VcsMethodName, parsedInput: unknown): string | null {
  const descriptor = vcsSemanticReferenceInventory[method].find(
    (candidate) => candidate.kind === "context" && candidate.role === "context"
  );
  if (!descriptor) return null;
  const matches = collectPathValues(parsedInput, descriptor.path);
  if (matches.length !== 1 || typeof matches[0]?.value !== "string") {
    throw new Error(`VCS ${method} lacks its declared context reference`);
  }
  return matches[0].value;
}

export function createVcsMethodError(method: VcsMethodName, error: VcsError): VcsError {
  const parsed = createVcsError(error);
  if (!vcsMethods[method].errors?.some(({ code }) => code === parsed.code)) {
    throw new Error(`VCS ${method} does not declare error ${parsed.code}`);
  }
  return parsed;
}
