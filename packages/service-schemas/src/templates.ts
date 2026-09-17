import { WorkspaceSourceReviewSchema } from "@vibestudio/workspace-contracts/workspaceSource";
import { vcsMergeCoordinateSchema } from "./vcs.js";
import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import {
  defineServiceMethods,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import {
  WorkspaceTemplateDependencySchema,
  WorkspaceGitCommitSchema,
  WorkspaceTemplatePinSchema,
} from "@vibestudio/workspace-contracts/workspaceConfigSchema";
export { sameWorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";

const READ: MethodAccessDescriptor = { sensitivity: "read" };
const WRITE: MethodAccessDescriptor = { sensitivity: "write" };
const commandId = z.string().trim().min(1);
const digest = z.string().regex(/^v1-sha256:[0-9a-f]{64}$/u);

export const DEFAULT_TEMPLATE_REGISTRY_URL =
  "https://raw.githubusercontent.com/panticonic/vibestudio/main/templates/registry.json";
export const TEMPLATE_REGISTRY_FILE_ENV = "VIBESTUDIO_TEMPLATE_REGISTRY_FILE";
export const templateRegistryEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    role: z.enum(["base", "personal", "system", "development", "catalog"]),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    url: z.string().url(),
    tags: z.array(z.string().trim().min(1)).optional(),
    recommended: z.boolean().optional(),
    consumers: z
      .array(z.enum(["base", "personal", "system"]))
      .min(1)
      .optional(),
  })
  .strict();
export const templateRegistrySchema = z
  .object({
    version: z.literal(1),
    templates: z.array(templateRegistryEntrySchema),
  })
  .strict()
  .superRefine((registry, ctx) => {
    const ids = new Set<string>();
    const urls = new Set<string>();
    for (const [index, entry] of registry.templates.entries()) {
      if (ids.has(entry.id)) {
        ctx.addIssue({ code: "custom", path: ["templates", index, "id"], message: "duplicate id" });
      }
      if (urls.has(entry.url)) {
        ctx.addIssue({
          code: "custom",
          path: ["templates", index, "url"],
          message: "duplicate URL",
        });
      }
      if (entry.role === "development" && !entry.consumers) {
        ctx.addIssue({
          code: "custom",
          path: ["templates", index, "consumers"],
          message: "development templates require consumers",
        });
      }
      if (entry.role !== "development" && entry.consumers) {
        ctx.addIssue({
          code: "custom",
          path: ["templates", index, "consumers"],
          message: "only development templates have consumers",
        });
      }
      ids.add(entry.id);
      urls.add(entry.url);
    }
  });
export type TemplateRegistry = z.infer<typeof templateRegistrySchema>;

export const templateLocatorSchema = z.union([
  z.object({ pin: WorkspaceTemplatePinSchema }).strict(),
  z.object({ url: z.string().url(), credential: z.string().trim().min(1).optional() }).strict(),
]);
export const templateSourceDeclarationSchema = z
  .object({
    url: z.string().url(),
    credential: z.string().trim().min(1).optional(),
  })
  .strict();
export const templateInspectionSchema = WorkspaceSourceReviewSchema.extend({
  pin: WorkspaceTemplatePinSchema,
}).strict();
const authoringIntentSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    parts: z.array(z.string()),
  })
  .strict();
export const templateAuthoringInspectionSchema = z
  .object({
    request: authoringIntentSchema,
    mainEventId: z.string().trim().min(1),
    selectableParts: z.array(z.string()),
    requestedParts: z.array(z.string()),
    includedParts: z.array(z.string()).min(1),
    requiredParts: z.array(z.string()),
    manifest: z.string().min(1),
    manifestDigest: digest,
    fingerprint: digest,
  })
  .strict();
const destinationSchema = z
  .object({
    provider: z.string().trim().min(1),
    owner: z.string().trim().min(1),
    name: z.string().trim().min(1),
  })
  .strict();
export const templatePublicationSchema = z
  .object({
    operationId: z.string(),
    destination: destinationSchema,
    created: z.boolean(),
    remoteUrl: z.string().url(),
    webUrl: z.string().url(),
    templateUrl: z.string(),
    credential: z.string().min(1).optional(),
    ref: z.string().startsWith("refs/tags/"),
    commit: WorkspaceGitCommitSchema,
    parts: z.array(z.string()).min(1),
  })
  .strict();
export const templateSourceTreeSchema = z
  .object({
    sources: z.array(WorkspaceTemplatePinSchema).min(1),
    repositories: z.array(
      z
        .object({
          repoPath: z.string(),
          snapshot: digest,
          files: z.array(
            z
              .object({
                path: z.string(),
                contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
                mode: z.number().int(),
              })
              .strict()
          ),
        })
        .strict()
    ),
  })
  .strict();
export type TemplateSourceTree = z.infer<typeof templateSourceTreeSchema>;

export const templateContributionPlanSchema = z
  .object({
    source: WorkspaceTemplatePinSchema,
    parts: z.array(z.string()).min(1),
    mainEventId: z.string(),
    fingerprint: digest,
  })
  .strict();
export type TemplateContributionPlan = z.infer<typeof templateContributionPlanSchema>;
export const templateContributionResultSchema = z
  .object({
    outcome: z.enum(["pushed", "already-at-remote", "nothing-to-suggest"]),
    operationId: z.string(),
    branch: z.string().nullable(),
    url: z.string().optional(),
    headCommit: z.string().nullable(),
    commits: z.number(),
    parts: z.array(z.string()),
  })
  .strict();
export const templateUpdateReviewSchema = z
  .object({
    operationId: z.string(),
    contextId: z.string(),
    sourceUrl: z.string(),
    target: WorkspaceTemplatePinSchema,
    mainEventId: z.string(),
    status: z.enum(["review", "published"]),
    repositories: z.array(
      z.object({ repoPath: z.string(), kind: z.enum(["added", "changed", "removed"]) }).strict()
    ),
    conflicts: z.array(
      z
        .object({ deltaId: z.string(), repoPath: z.string(), coordinate: vcsMergeCoordinateSchema })
        .strict()
    ),
  })
  .strict();
export type TemplateUpdateReview = z.infer<typeof templateUpdateReviewSchema>;

export const templateUpdateCheckSchema = z
  .object({
    source: WorkspaceTemplatePinSchema,
    checkedAt: z.number(),
    status: z.enum(["current", "available", "different-epoch", "error"]),
    target: WorkspaceTemplatePinSchema.optional(),
    targetEpoch: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
  })
  .strict();
export const templateUpdateStatusSchema = z
  .object({
    workspaceEpoch: z.number().int().nonnegative(),
    checks: z.array(templateUpdateCheckSchema),
  })
  .strict();
export type TemplateUpdateStatus = z.infer<typeof templateUpdateStatusSchema>;

export const templatesMethods = defineServiceMethods({
  updateSignal: {
    description:
      "Check upstream and return a model-free automation signal only for unannounced updates.",
    website: { kind: "closed", reason: "Workspace update automation is private." } as const,
    args: z.tuple([]),
    returns: z
      .object({ protocol: z.literal("automation-signal.v1"), prompt: z.string().nullable() })
      .strict(),
    access: READ,
  },
  acknowledgeUpdates: {
    description:
      "Record exact updates after the agent has successfully notified the user; does not apply updates.",
    website: { kind: "closed", reason: "Workspace update automation is private." } as const,
    args: z.tuple([z.object({ targets: z.array(WorkspaceTemplatePinSchema) }).strict()]),
    returns: z.void(),
    access: WRITE,
  },
  updateStatus: {
    description: "Read cached upstream availability without preparing or applying an update.",
    website: { kind: "closed", reason: "Workspace source provenance is private." } as const,
    args: z.tuple([]),
    returns: templateUpdateStatusSchema,
    access: READ,
  },
  checkUpdates: {
    description:
      "Check recorded template sources for upstream changes without modifying workspace content.",
    website: { kind: "closed", reason: "Workspace source provenance is private." } as const,
    args: z.tuple([]),
    returns: templateUpdateStatusSchema,
    access: READ,
  },
  installed: {
    description: "List the exact template sources recorded in this workspace.",
    website: {
      kind: "closed",
      reason: "Workspace source provenance is private to its members.",
    } as const,
    args: z.tuple([]),
    returns: z.array(
      templateInspectionSchema.extend({
        relationship: z.enum(["upstream", "direct", "transitive"]),
      })
    ),
    access: READ,
  },
  inspectContribution: {
    description: "Review selected owned units to suggest back to one installed template.",
    website: { kind: "closed", reason: "Controls workspace source publication." } as const,
    args: z.tuple([
      z.object({ sourceUrl: z.string(), parts: z.array(z.string()).min(1) }).strict(),
    ]),
    returns: templateContributionPlanSchema,
    access: READ,
  },
  suggestContribution: {
    description: "Push the reviewed units on a contribution branch in their template repository.",
    website: { kind: "closed", reason: "Controls workspace source publication." } as const,
    args: z.tuple([z.object({ commandId, plan: templateContributionPlanSchema }).strict()]),
    returns: templateContributionResultSchema,
    access: WRITE,
  },
  prepareUpdate: {
    description:
      "Prepare an exact template update in a separate VCS context, preserving local changes for review.",
    website: { kind: "closed", reason: "Controls workspace source updates." } as const,
    args: z.tuple([
      z
        .object({ commandId, sourceUrl: z.string(), target: WorkspaceTemplatePinSchema.optional() })
        .strict(),
    ]),
    returns: templateUpdateReviewSchema,
    access: WRITE,
  },
  reviewUpdate: {
    description: "Inspect a prepared update and its remaining native VCS conflicts.",
    website: { kind: "closed", reason: "Controls workspace source updates." } as const,
    args: z.tuple([z.object({ operationId: commandId }).strict()]),
    returns: templateUpdateReviewSchema,
    access: READ,
  },
  readUpdateFile: {
    description: "Read the base, local, and incoming versions of a file in a prepared update.",
    website: { kind: "closed", reason: "Workspace source is private." } as const,
    args: z.tuple([
      z.object({ operationId: commandId, repoPath: z.string(), path: z.string() }).strict(),
    ]),
    returns: z
      .object({
        base: z.string().nullable(),
        ours: z.string().nullable(),
        theirs: z.string().nullable(),
      })
      .strict(),
    access: READ,
  },
  resolveUpdate: {
    description: "Resolve one exact native VCS conflict in a template update.",
    website: { kind: "closed", reason: "Controls workspace source updates." } as const,
    args: z.tuple([
      z
        .object({
          operationId: commandId,
          deltaId: z.string(),
          coordinate: z.object({ kind: z.enum(["file", "repository"]), id: z.string() }).strict(),
          resolution: z.enum(["ours", "theirs"]),
        })
        .strict(),
    ]),
    returns: templateUpdateReviewSchema,
    access: WRITE,
  },
  publishUpdate: {
    description:
      "Publish a fully reviewed template update through the ordinary workspace VCS gate.",
    website: { kind: "closed", reason: "Controls workspace source updates." } as const,
    args: z.tuple([z.object({ operationId: commandId }).strict()]),
    returns: templateUpdateReviewSchema,
    access: WRITE,
  },
  registry: {
    website: {
      kind: "eligible",
      rationale: "Returns public catalog metadata from the requested registry address.",
    } as const,
    description: "Load the default template registry or a registry URL selected by the user.",
    args: z.tuple([z.object({ url: z.string().url().optional() }).strict()]),
    returns: templateRegistrySchema,
    access: READ,
  },
  resolveSource: {
    website: {
      kind: "closed",
      reason: "Websites use the reviewed templates.inspect operation.",
    } as const,
    description: "Resolve one moving workspace source address into an immutable exact pin.",
    args: z.tuple([templateSourceDeclarationSchema]),
    returns: WorkspaceTemplatePinSchema,
    access: READ,
  },
  inspect: {
    website: {
      kind: "eligible",
      rationale:
        "The exact extension method contract requires permission to disclose inspected source metadata; installation is a separate operation.",
    } as const,
    description: "Resolve, acquire, and verify one exact workspace template snapshot.",
    args: z.tuple([templateLocatorSchema]),
    returns: templateInspectionSchema,
    access: READ,
  },
  inspectAuthoring: {
    website: {
      kind: "closed",
      reason:
        "The templates receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    description:
      "Build a reviewed dependency-aware template plan from protected-main workspace source.",
    args: z.tuple([authoringIntentSchema]),
    returns: templateAuthoringInspectionSchema,
    access: READ,
  },
  publicationRepositories: {
    website: {
      kind: "closed",
      reason: "Lists private connected GitHub repository metadata.",
    } as const,
    description: "List writable GitHub repositories for a selected connected account.",
    args: z.tuple([
      z
        .object({
          credentialId: z.string().min(1).optional(),
          page: z.number().int().min(1).default(1),
        })
        .strict(),
    ]),
    returns: z
      .object({
        owner: z.string(),
        repositories: z.array(
          z
            .object({
              owner: z.string(),
              name: z.string(),
              private: z.boolean(),
              webUrl: z.string(),
            })
            .strict()
        ),
        nextPage: z.number().int().nullable(),
      })
      .strict(),
    access: READ,
  },
  authoringSetup: {
    website: { kind: "closed", reason: "Reads private workspace publication metadata." } as const,
    description:
      "Read template identity, upstream, dependencies, and declared publication contents from one workspace state.",
    args: z.tuple([]),
    returns: z
      .object({
        name: z.string(),
        description: z.string(),
        upstream: WorkspaceTemplatePinSchema.nullable(),
        dependencies: z.array(WorkspaceTemplateDependencySchema),
        parts: z.array(
          z
            .object({
              repoPath: z.string(),
              ownership: z.enum(["authored", "inherited", "unlisted"]),
              inheritedFrom: z.string().optional(),
            })
            .strict()
        ),
      })
      .strict(),
    access: READ,
  },
  publicationVersion: {
    website: { kind: "closed", reason: "Reads the selected GitHub repository's tags." } as const,
    description: "Suggest the next stable patch version from all existing repository tags.",
    args: z.tuple([
      z
        .object({
          owner: z.string().min(1),
          name: z.string().min(1),
          credentialId: z.string().optional(),
        })
        .strict(),
    ]),
    returns: z.object({ latest: z.string().nullable(), suggested: z.string() }).strict(),
    access: READ,
  },
  authoringUpstream: {
    website: {
      kind: "closed",
      reason: "Reads this workspace's private template upstream.",
    } as const,
    description: "Read the workspace's own template publishing repository, if configured.",
    args: z.tuple([]),
    returns: WorkspaceTemplatePinSchema.nullable(),
    access: READ,
  },
  authoringParts: {
    website: {
      kind: "closed",
      reason:
        "The templates receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    description: "List protected-main repositories available for snapshot authoring.",
    args: z.tuple([]),
    returns: z.array(
      z
        .object({
          repoPath: z.string(),
          packageName: z.string().optional(),
          inheritedFrom: z.string().optional(),
        })
        .strict()
    ),
    access: READ,
  },
  publishAuthoring: {
    website: {
      kind: "closed",
      reason:
        "The templates receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    description: "Revalidate and publish a reviewed workspace template snapshot.",
    args: z.tuple([
      z
        .object({
          commandId,
          intent: authoringIntentSchema,
          expectedFingerprint: digest,
          version: z.string().regex(/^v?[0-9]+(?:\.[0-9]+){0,2}(?:[-.][A-Za-z0-9]+)*$/u),
          destination: destinationSchema,
          credentialId: z.string().trim().min(1).optional(),
          creation: z
            .object({ private: z.boolean().optional(), description: z.string().optional() })
            .strict()
            .optional(),
        })
        .strict(),
    ]),
    returns: templatePublicationSchema,
    access: WRITE,
  },
});

/** Host-owned exact-source acquisition used by reviewed source consumers. */
export const workspaceTemplateSourceMethods = defineServiceMethods({
  composeExact: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspaceTemplateSource.exactSnapshot",
      rationale:
        "Reviewed template updates acquire their exact source composition through the host.",
    },
    authority: { principals: ["user", "code"] },
    description:
      "Acquire an exact template tree using the supplied layer pins, resolving newly introduced dependencies once.",
    website: {
      kind: "closed",
      reason: "Source acquisition is owned by the reviewed template workflow.",
    } as const,
    args: z.tuple([
      z
        .object({
          sources: z.array(WorkspaceTemplatePinSchema).min(1),
          purpose: z.enum(["use", "author"]).optional(),
        })
        .strict(),
    ]),
    returns: templateSourceTreeSchema,
    access: READ,
  },
  localRegistry: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspaceTemplateSource.exactSnapshot",
      rationale: "Trusted template consumers may read the instance-designated development catalog.",
    },
    authority: { principals: ["user", "code"] },
    website: {
      kind: "closed",
      reason: "The local development registry is exposed through templates.registry.",
    } as const,
    description: "Read the instance-designated local template registry, if one is configured.",
    args: z.tuple([]),
    returns: templateRegistrySchema.nullable(),
    access: READ,
  },
  resolveLocal: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspaceTemplateSource.exactSnapshot",
      rationale:
        "A trusted source consumer may prefer an instance-designated exact checkpoint without learning its host path.",
    },
    authority: { principals: ["user", "code"] },
    website: {
      kind: "closed",
      reason: "Host-designated source selection is exposed through templates.inspect.",
    } as const,
    description:
      "Resolve a canonical source URL to this instance's designated exact local pin, if present.",
    args: z.tuple([z.string().url()]),
    returns: WorkspaceTemplatePinSchema.nullable(),
    access: READ,
  },
  readEpoch: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspaceTemplateSource.exactSnapshot",
      rationale:
        "Verified source consumers read only the stable compatibility envelope; foreign source is never activated.",
    },
    authority: { principals: ["user", "code"] },
    website: { kind: "closed", reason: "Exact workspace source metadata is private." } as const,
    description:
      "Read only the compatibility epoch from an exact source, including future manifest schemas.",
    args: z.tuple([WorkspaceTemplatePinSchema]),
    returns: z.number().int().nonnegative(),
    access: READ,
  },
  inspectExact: {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspaceTemplateSource.exactSnapshot",
      rationale:
        "Reviewed shell and templates-extension flows delegate verified exact source acquisition to the host; their public inspection operation owns disclosure review.",
    },
    authority: { principals: ["user", "code"] },
    website: {
      kind: "closed",
      reason: "Host-owned source acquisition is exposed through templates.inspect.",
    } as const,
    description:
      "Acquire and verify one exact workspace source without exposing its host transport.",
    args: z.tuple([WorkspaceTemplatePinSchema]),
    returns: templateInspectionSchema,
    access: READ,
  },
});
export type TemplatesClient = TypedServiceClient<typeof templatesMethods>;
export type TemplateInspection = z.infer<typeof templateInspectionSchema>;
export type TemplateLocator = z.infer<typeof templateLocatorSchema>;
export type TemplateExactPin = z.infer<typeof WorkspaceTemplatePinSchema>;
export type TemplateAuthoringIntent = z.infer<typeof authoringIntentSchema>;
export type TemplateAuthoringInspection = z.infer<typeof templateAuthoringInspectionSchema>;
export type TemplatePublication = z.infer<typeof templatePublicationSchema>;
