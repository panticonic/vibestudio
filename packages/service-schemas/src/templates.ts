import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import {
  defineServiceMethods,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import {
  WorkspaceGitCommitSchema,
  WorkspaceGitSnapshotSchema,
  WorkspaceLogicalCredentialNameSchema,
  WorkspaceTemplateDeclarationSchema,
  WorkspaceTemplatePinSchema,
} from "@vibestudio/workspace-contracts/workspaceConfigSchema";

const READ_ACCESS: MethodAccessDescriptor = { sensitivity: "read" };
const WRITE_ACCESS: MethodAccessDescriptor = { sensitivity: "write" };
const commandId = z.string().trim().min(1);
const digest = z.string().regex(/^v1-sha256:[0-9a-f]{64}$/u);

/** A standard VCS review source. The UI resolves it through the normal
 * compare/merge flow; templates never invent a second review channel. */
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
    contributedParts: z.number().int().nonnegative(),
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
    /** Repositories whose ordered template contribution set would change. */
    affectedParts: z.array(z.string()),
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
    /** A retained semantic context which an agent may edit with the ordinary
     * workspace/VCS tools before calling resume. */
    repair: z
      .object({
        contextId: z.string().trim().min(1),
        mainEventId: z.string().trim().min(1).optional(),
        failures: z.array(
          z
            .object({
              unit: z.string().trim().min(1),
              message: z.string().trim().min(1),
            })
            .strict()
        ),
      })
      .strict()
      .optional(),
    publicationEventId: z.string().optional(),
    affectedParts: z.array(z.string()),
  })
  .strict();

const buildFailureModeSchema = z.enum(["discard-context", "retain-context"]);
const templateAuthoringIntentSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    parts: z.array(z.string()).min(1),
    dependencies: z.array(WorkspaceTemplateDeclarationSchema).optional(),
  })
  .strict();
export const templateAuthoringInspectionSchema = z
  .object({
    request: templateAuthoringIntentSchema,
    mainEventId: z.string().trim().min(1),
    selectableParts: z.array(z.string()),
    requestedParts: z.array(z.string()).min(1),
    includedParts: z.array(z.string()).min(1),
    requiredParts: z.array(z.string()),
    inheritedParts: z.array(z.string()),
    manifest: z.string().min(1),
    manifestDigest: digest,
    fingerprint: digest,
  })
  .strict();
const templateAuthoringDestinationSchema = z
  .object({
    provider: z.string().trim().min(1),
    owner: z.string().trim().min(1),
    name: z.string().trim().min(1),
  })
  .strict();
const templateAuthoringCreationSchema = z
  .object({
    private: z.boolean().optional(),
    description: z.string().optional(),
  })
  .strict();
export const templatePublicationSchema = z
  .object({
    operationId: z.string(),
    destination: templateAuthoringDestinationSchema,
    created: z.boolean(),
    remoteUrl: z.string().url(),
    webUrl: z.string().url(),
    templateUrl: z.string(),
    ref: z.string().startsWith("refs/tags/"),
    commit: z.string().regex(/^[0-9a-f]{40}$/u),
    snapshot: digest,
    parts: z.array(z.string()).min(1),
  })
  .strict();
const templateRegistryEntryRequestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    tags: z.array(z.string().trim().min(1)).min(1),
    recommended: z.boolean(),
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
      registryCommit: WorkspaceGitCommitSchema,
      registrySnapshot: WorkspaceGitSnapshotSchema,
    })
    .strict(),
]);

export const templateAddRequestSchema = z.union([
  z
    .object({
      catalogId: z.string().trim().min(1),
      registryCommit: WorkspaceGitCommitSchema.optional(),
      registrySnapshot: WorkspaceGitSnapshotSchema.optional(),
      /** Refresh is explicit because it may perform network work. Omit it to
       * prepare from the last verified catalog snapshot. */
      refreshCatalog: z.boolean().optional(),
    })
    .strict()
    .refine(
      (value) => Boolean(value.registryCommit) === Boolean(value.registrySnapshot),
      "registryCommit and registrySnapshot must be provided together"
    ),
  z
    .object({
      url: z.string().url(),
      credential: WorkspaceLogicalCredentialNameSchema.optional(),
    })
    .strict(),
]);

export const templateAddPreparationSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().optional(),
    inspection: templateInspectionSchema,
  })
  .strict();

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
    coordinates: z
      .object({
        url: z.string().trim().min(1),
        ref: z.string().trim().min(1),
        commit: WorkspaceGitCommitSchema,
        snapshot: WorkspaceGitSnapshotSchema,
      })
      .strict(),
    source: z.enum(["verified", "cache"]),
    stale: z.boolean(),
    verifiedAt: z.string().datetime(),
    refreshError: z.string().optional(),
  })
  .strict();
export type TemplateCatalogSnapshot = z.infer<typeof templateCatalogSnapshotSchema>;

export const templateRegistryContributionSchema = z
  .object({
    operationId: z.string(),
    outcome: z.enum(["pushed", "already-at-remote", "nothing-to-suggest"]),
    registryUrl: z.string(),
    baseCommit: WorkspaceGitCommitSchema,
    branch: z.string().nullable(),
    headCommit: WorkspaceGitCommitSchema.nullable(),
    revision: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/u),
    entry: catalogEntrySchema,
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
      "Return exact committed template relationships joined with contribution counts, pending VCS review handles, and unresolved content-addressed suggestions without acquisition or network work.",
    args: z.tuple([]),
    returns: z.array(templateStatusRowSchema),
    access: READ_ACCESS,
  },
  catalog: {
    description:
      "Return the last verified userland registry snapshot, or null when none is cached, optionally refreshing its configured moving source first.",
    args: z.union([z.tuple([]), z.tuple([z.object({ refresh: z.boolean().optional() }).strict()])]),
    returns: templateCatalogSnapshotSchema.nullable(),
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
  prepareAdd: {
    description:
      "Prepare one catalog selection or template address as an exact, reviewable add operation without changing the workspace. Catalog refresh remains explicit.",
    args: z.tuple([templateAddRequestSchema]),
    returns: templateAddPreparationSchema,
    access: READ_ACCESS,
  },
  inspectAuthoring: {
    description:
      "Inspect selected protected-main content in the current composed workspace and record URL-only semantic dependencies. Dependencies are descriptive authoring intent, not compatibility proofs or exact release inputs.",
    args: z.tuple([templateAuthoringIntentSchema]),
    returns: templateAuthoringInspectionSchema,
    access: READ_ACCESS,
  },
  authoringParts: {
    description:
      "List protected-main repositories available for template authoring with package and installed template contribution hints.",
    args: z.tuple([]),
    returns: z.array(
      z
        .object({
          repoPath: z.string(),
          packageName: z.string().optional(),
          templateAliases: z.array(z.string()).optional(),
          templateUrls: z.array(z.string().trim().min(1)).optional(),
        })
        .strict()
    ),
    access: READ_ACCESS,
  },
  publishAuthoring: {
    description:
      "Recompute and publish reviewed template intent when its compact inspection fingerprint still matches protected main and resolved dependencies.",
    args: z.tuple([
      z
        .object({
          commandId,
          intent: templateAuthoringIntentSchema,
          expectedFingerprint: digest,
          version: z.string().regex(/^v?[0-9]+(?:\.[0-9]+){0,2}(?:[-.][A-Za-z0-9]+)*$/u),
          destination: templateAuthoringDestinationSchema,
          credentialId: z.string().trim().min(1).optional(),
          creation: templateAuthoringCreationSchema.optional(),
        })
        .strict(),
    ]),
    returns: templatePublicationSchema,
    access: WRITE_ACCESS,
  },
  suggestRegistryEntry: {
    description:
      "Revalidate an exact publication and verified registry receipt, then push a collision-safe review branch containing its catalog entry. This does not promote or merge the entry.",
    args: z.tuple([
      z
        .object({
          commandId,
          catalog: templateCatalogSnapshotSchema,
          publication: templatePublicationSchema,
          credential: WorkspaceLogicalCredentialNameSchema.optional(),
          entry: templateRegistryEntryRequestSchema,
          revision: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/u),
        })
        .strict(),
    ]),
    returns: templateRegistryContributionSchema,
    access: WRITE_ACCESS,
  },
  add: {
    description:
      "Merge an exact template's contributions through ordinary VCS, build them in a retained semantic context, and publish atomically when clean.",
    args: z.tuple([
      z
        .object({
          commandId,
          pin: WorkspaceTemplatePinSchema,
          onBuildFailure: buildFailureModeSchema.optional(),
        })
        .strict(),
    ]),
    returns: templateOperationSchema,
    access: WRITE_ACCESS,
  },
  adopt: {
    description:
      "Record an exact template release as the existing workspace lineage without merging its historical content, then build and publish the generated relationship metadata.",
    args: z.tuple([
      z
        .object({
          commandId,
          pin: WorkspaceTemplatePinSchema,
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
      "Remove one direct template relationship, merge the removal of its contributions through ordinary VCS review, rebuild, and publish the repaired composition.",
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
      "Delegate selected workspace repositories to the ordinary Git contribution workflow for an installed template; repositories may be shared with other templates.",
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
          kind: z.enum([
            "add",
            "adopt",
            "pull",
            "remove",
            "recompose",
            "adopt-bootstrap",
            "publish-authoring",
          ]),
          contextId: z.string(),
          state: z.enum(["pending", "reviewing", "repairing"]),
          fingerprint: digest,
          review: templateReviewSchema.optional(),
          repair: z
            .object({
              contextId: z.string().trim().min(1),
              mainEventId: z.string().trim().min(1).optional(),
              failures: z.array(z.object({ unit: z.string(), message: z.string() }).strict()),
            })
            .strict()
            .optional(),
        })
        .strict()
    ),
    access: READ_ACCESS,
  },
  resume: {
    description:
      "Resume one semantic template operation by operation id. A fully staged repair context is rebuilt as-is; an unfinished VCS review continues composition. The host approval boundary is evaluated again.",
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
export type TemplateAddRequest = z.infer<typeof templateAddRequestSchema>;
export type TemplateAddPreparation = z.infer<typeof templateAddPreparationSchema>;
export type TemplateExactPin = z.infer<typeof WorkspaceTemplatePinSchema>;
export type TemplateAuthoringIntent = z.infer<typeof templateAuthoringIntentSchema>;
export type TemplateAuthoringInspection = z.infer<typeof templateAuthoringInspectionSchema>;
export type TemplatePublication = z.infer<typeof templatePublicationSchema>;
export type TemplateRegistryContribution = z.infer<typeof templateRegistryContributionSchema>;
