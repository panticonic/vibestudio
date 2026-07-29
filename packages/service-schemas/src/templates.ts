import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import {
  defineServiceMethods,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";

const READ_ACCESS: MethodAccessDescriptor = { sensitivity: "read" };
const WRITE_ACCESS: MethodAccessDescriptor = { sensitivity: "write" };
const commandId = z.string().trim().min(1);
const digest = z.string().regex(/^v1-sha256:[0-9a-f]{64}$/u);

/** A standard VCS review source. The UI resolves it through the normal
 * compare/integrate flow; templates never invent a second review channel. */
export const templateReviewHandleSchema = z
  .object({
    repoPath: z.string(),
    deltaId: z.string(),
  })
  .strict();

export const templateReviewSchema = z
  .object({
    operationId: z.string(),
    contextId: z.string(),
    approvalGranted: z.boolean(),
    items: z.array(templateReviewHandleSchema),
  })
  .strict();

export const templateContributionSchema = z
  .object({
    branch: z.string(),
    /** Exact remote-host URL when the provider can prove one. */
    url: z.string().url().optional(),
  })
  .strict();

export const templateLifecycleStateSchema = z.enum([
  "current",
  "update-available",
  "local-changes",
  "reviewing",
  "waiting-for-credential",
  "conflict",
  "error",
]);

export const templateRecoveryBlockerSchema = z
  .object({
    state: z.enum(["waiting-for-credential", "conflict", "error"]),
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
    nextAction: z.enum([
      "connect-credential",
      "choose-version",
      "resolve-conflict",
      "retry",
      "details",
    ]),
    credential: z
      .object({
        name: z.string().trim().min(1),
        remoteUrl: z.string().url(),
        provider: z.string().trim().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const templateStatusRowSchema = z
  .object({
    nodeId: z.string(),
    alias: z.string(),
    url: z.string(),
    ref: z.string(),
    commit: z.string().regex(/^[0-9a-f]{40}$/u),
    direct: z.boolean(),
    state: templateLifecycleStateSchema,
    ownedParts: z.number().int().nonnegative(),
    pendingReviews: z.number().int().nonnegative(),
    /** The copied lock/fragments are usable locally; a deferred check only
     * means no remote reacquisition has happened in this host session. */
    verification: z.enum(["verified", "deferred"]),
    review: templateReviewSchema.optional(),
    suggestions: z.array(
      z
        .object({
          section: z.enum(["trust", "providers"]),
          value: z.unknown(),
        })
        .strict()
    ),
    blocker: templateRecoveryBlockerSchema.optional(),
    error: z.string().optional(),
  })
  .strict();

export const templateConflictSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("repository"),
      repoPath: z.string(),
      claimants: z.array(z.string()).min(2),
    })
    .strict(),
]);

export const templateInspectionSchema = z
  .object({
    /** The exact immutable target resolved by inspect. Pass this value
     * unchanged to add; add never resolves a moving locator. */
    pin: WorkspaceTemplatePinSchema,
    fingerprint: digest,
    roots: z.array(z.string()),
    templates: z.array(
      z
        .object({
          nodeId: z.string(),
          alias: z.string(),
          url: z.string(),
          commit: z.string(),
        })
        .strict()
    ),
    addedParts: z.array(z.string()),
    retainedParts: z.array(z.string()),
    orphanedParts: z.array(z.string()),
    conflicts: z.array(templateConflictSchema),
    excludedSuggestions: z.array(
      z
        .object({
          alias: z.string(),
          section: z.enum(["trust", "providers"]),
          value: z.unknown(),
        })
        .strict()
    ),
  })
  .strict();

export const templateOperationSchema = z
  .object({
    operationId: z.string(),
    state: z.enum([
      "pending",
      "applied",
      "local-changes",
      "waiting-for-credential",
      "conflict",
      "error",
    ]),
    planFingerprint: digest.optional(),
    review: templateReviewSchema.optional(),
    contribution: templateContributionSchema.optional(),
    blocker: templateRecoveryBlockerSchema.optional(),
    publicationEventId: z.string().optional(),
    addedParts: z.array(z.string()),
    orphanedParts: z.array(z.string()),
  })
  .strict();

const choicesSchema = z.record(z.enum(["keep", "take", "skip"]));
const buildFailureModeSchema = z.enum(["discard-context", "retain-context"]);
const templateAuthoringRequestSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    parts: z.array(z.string()).min(1),
    parents: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();
export const templateAuthoringInspectionSchema = z
  .object({
    request: templateAuthoringRequestSchema,
    mainEventId: z.string().trim().min(1),
    selectableParts: z.array(z.string()),
    requestedParts: z.array(z.string()).min(1),
    includedParts: z.array(z.string()).min(1),
    requiredParts: z.array(z.string()),
    inheritedParts: z.array(z.string()),
    parents: z.array(
      z
        .object({
          alias: z.string(),
          url: z.string(),
          credential: z.string().optional(),
        })
        .strict()
    ),
    manifest: z.string().min(1),
    manifestDigest: digest,
    fingerprint: digest,
  })
  .strict();
const templateAuthoringDestinationSchema = z
  .object({
    provider: z.string().optional(),
    name: z.string().trim().min(1).optional(),
    organization: z.string().trim().min(1).optional(),
    private: z.boolean().optional(),
    description: z.string().optional(),
    credentialId: z.string().trim().min(1).optional(),
  })
  .strict();
export const templatePublicationSchema = z
  .object({
    operationId: z.string(),
    provider: z.string(),
    remoteUrl: z.string().url(),
    webUrl: z.string().url(),
    templateUrl: z.string(),
    ref: z.string().startsWith("refs/tags/"),
    commit: z.string().regex(/^[0-9a-f]{40}$/u),
    snapshot: digest,
    parts: z.array(z.string()).min(1),
  })
  .strict();
export const templateLocatorSchema = z.union([
  z.object({ alias: z.string().trim().min(1) }).strict(),
  z
    .object({
      url: z.string().url(),
      credential: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      catalogId: z.string().trim().min(1),
      registryRevision: z.string().trim().min(1),
    })
    .strict(),
]);

const catalogEntrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    url: z.string().url(),
    tags: z.array(z.string()),
    recommended: z.boolean(),
    promoted: z
      .object({
        ref: z.string().startsWith("refs/"),
        commit: z.string().regex(/^[0-9a-f]{40}$/u),
        snapshot: digest,
      })
      .strict(),
  })
  .strict();

export const templateCatalogSnapshotSchema = z
  .object({
    version: z.literal(1),
    revision: z.string().trim().min(1),
    systemEpoch: z.number().int().nonnegative(),
    entries: z.array(catalogEntrySchema),
    source: z.enum(["verified", "cache"]),
    stale: z.boolean(),
    verifiedAt: z.string().datetime(),
    refreshError: z.string().optional(),
  })
  .strict();

const updateCandidateSchema = z
  .object({
    nodeId: z.string(),
    alias: z.string(),
    currentRef: z.string(),
    currentCommit: z.string(),
    candidateRef: z.string(),
    candidateCommit: z.string().regex(/^[0-9a-f]{40}$/u),
    candidateSnapshot: digest,
  })
  .strict();

export const templatesMethods = defineServiceMethods({
  status: {
    description:
      "Return exact committed template relationships joined with local ownership state, pending VCS review handles, and unresolved content-addressed suggestions without acquisition or network work.",
    args: z.tuple([]),
    returns: z.array(templateStatusRowSchema),
    access: READ_ACCESS,
  },
  catalog: {
    description:
      "Return the last verified userland registry snapshot, optionally refreshing its configured moving source first.",
    args: z.union([z.tuple([]), z.tuple([z.object({ refresh: z.boolean().optional() }).strict()])]),
    returns: templateCatalogSnapshotSchema,
    access: READ_ACCESS,
  },
  check: {
    description:
      "Compare tracked exact pins with the verified registry snapshot without changing workspace content.",
    args: z.union([
      z.tuple([]),
      z.tuple([z.object({ alias: z.string().trim().min(1).optional() }).strict()]),
    ]),
    returns: z.array(updateCandidateSchema),
    access: READ_ACCESS,
  },
  inspect: {
    description:
      "Resolve and verify a template closure in userland without changing the workspace. Catalog selections require the reviewed registry revision.",
    args: z.tuple([templateLocatorSchema]),
    returns: templateInspectionSchema,
    access: READ_ACCESS,
  },
  inspectAuthoring: {
    description:
      "Prepare a content-addressed template authoring receipt from selected protected-main repositories, adding required workspace dependencies and projecting one portable manifest.",
    args: z.tuple([templateAuthoringRequestSchema]),
    returns: templateAuthoringInspectionSchema,
    access: READ_ACCESS,
  },
  authoringParts: {
    description:
      "List protected-main repositories available for template authoring with package and installed-template ownership hints.",
    args: z.tuple([]),
    returns: z.array(
      z
        .object({
          repoPath: z.string(),
          packageName: z.string().optional(),
          templateAlias: z.string().optional(),
        })
        .strict()
    ),
    access: READ_ACCESS,
  },
  publishAuthoring: {
    description:
      "Revalidate an unchanged authoring receipt and publish its exact protected-main repositories and portable manifest as a new versioned Git template repository.",
    args: z.tuple([
      z
        .object({
          commandId,
          plan: templateAuthoringInspectionSchema,
          version: z.string().regex(/^v?[0-9]+(?:\.[0-9]+){0,2}(?:[-.][A-Za-z0-9]+)*$/u),
          destination: templateAuthoringDestinationSchema,
        })
        .strict(),
    ]),
    returns: templatePublicationSchema,
    access: WRITE_ACCESS,
  },
  add: {
    description:
      "Stage, build, and atomically publish an exact template relationship from a semantic operation context.",
    args: z.tuple([
      z
        .object({
          commandId,
          pin: WorkspaceTemplatePinSchema,
          choices: choicesSchema.optional(),
          onBuildFailure: buildFailureModeSchema.optional(),
        })
        .strict(),
    ]),
    returns: templateOperationSchema,
    access: WRITE_ACCESS,
  },
  pull: {
    description:
      "Resolve a tracked template's promoted pin, review its ordinary VCS deltas, build the operation context, and publish only a clean composition.",
    args: z.tuple([
      z
        .object({
          commandId,
          alias: z.string().trim().min(1),
          toRef: z.string().trim().min(1).optional(),
          onBuildFailure: buildFailureModeSchema.optional(),
        })
        .strict(),
    ]),
    returns: templateOperationSchema,
    access: WRITE_ACCESS,
  },
  remove: {
    description:
      "Remove one direct template relationship in userland and atomically recompose; owned repositories are orphaned locally by default.",
    args: z.tuple([
      z
        .object({
          commandId,
          alias: z.string().trim().min(1),
          onBuildFailure: buildFailureModeSchema.optional(),
        })
        .strict(),
    ]),
    returns: templateOperationSchema,
    access: WRITE_ACCESS,
  },
  suggest: {
    description:
      "Delegate selected locally changed owned repositories to the ordinary Git contribution workflow.",
    args: z.tuple([
      z
        .object({
          commandId,
          alias: z.string().trim().min(1),
          parts: z.array(z.string()).optional(),
        })
        .strict(),
    ]),
    returns: templateOperationSchema,
    access: WRITE_ACCESS,
  },
  decideSuggestion: {
    description:
      "Individually accept or decline one exact trust/provider suggestion from an installed template. Both decisions are durably published so a declined suggestion does not reappear; acceptance also merges the exact value into the workspace layer.",
    args: z.tuple([
      z
        .object({
          commandId,
          alias: z.string().trim().min(1),
          section: z.enum(["trust", "providers"]),
          decision: z.enum(["accept", "decline"]),
        })
        .strict(),
    ]),
    returns: z
      .object({
        operationId: z.string(),
        state: z.enum(["accepted", "declined"]),
        section: z.enum(["trust", "providers"]),
        publicationEventId: z.string().optional(),
      })
      .strict(),
    access: WRITE_ACCESS,
  },
  operations: {
    description:
      "Discover only pending or reviewing semantic template operation contexts and their exact stored review handles.",
    args: z.tuple([]),
    returns: z.array(
      z
        .object({
          operationId: z.string(),
          kind: z.enum(["add", "pull", "remove", "recompose", "adopt-bootstrap"]),
          contextId: z.string(),
          state: z.enum(["pending", "reviewing"]),
          fingerprint: digest,
          review: templateReviewSchema.optional(),
        })
        .strict()
    ),
    access: READ_ACCESS,
  },
  resume: {
    description:
      "Resume one discovered exact semantic template operation by operation id. The host approval boundary is evaluated again.",
    args: z.tuple([
      z
        .object({
          operationId: commandId,
          onBuildFailure: buildFailureModeSchema.optional(),
        })
        .strict(),
    ]),
    returns: templateOperationSchema,
    access: WRITE_ACCESS,
  },
  cancel: {
    description:
      "Discard one in-flight semantic template operation context by operation id. A repeated cancellation is idempotent.",
    args: z.tuple([
      z
        .object({
          operationId: commandId,
        })
        .strict(),
    ]),
    returns: z
      .object({
        operationId: z.string(),
        state: z.literal("cancelled"),
      })
      .strict(),
    access: WRITE_ACCESS,
  },
});

export type TemplatesClient = TypedServiceClient<typeof templatesMethods>;
export type TemplateStatusRow = z.infer<typeof templateStatusRowSchema>;
export type TemplateInspection = z.infer<typeof templateInspectionSchema>;
export type TemplateOperation = z.infer<typeof templateOperationSchema>;
export type TemplateReviewHandle = z.infer<typeof templateReviewHandleSchema>;
export type TemplateLocator = z.infer<typeof templateLocatorSchema>;
export type TemplateExactPin = z.infer<typeof WorkspaceTemplatePinSchema>;
export type TemplateAuthoringInspection = z.infer<typeof templateAuthoringInspectionSchema>;
export type TemplatePublication = z.infer<typeof templatePublicationSchema>;
