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
  WorkspaceTemplatePinSchema,
} from "@vibestudio/workspace-contracts/workspaceConfigSchema";
export { sameWorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";

const READ: MethodAccessDescriptor = { sensitivity: "read" };
const WRITE: MethodAccessDescriptor = { sensitivity: "write" };
const commandId = z.string().trim().min(1);
const digest = z.string().regex(/^v1-sha256:[0-9a-f]{64}$/u);

export const templateLocatorSchema = z.union([
  z.object({ pin: WorkspaceTemplatePinSchema }).strict(),
  z.object({ url: z.string().url(), credential: z.string().trim().min(1).optional() }).strict(),
  z
    .object({
      catalogId: z.string().trim().min(1),
      registryCommit: WorkspaceGitCommitSchema,
      registrySnapshot: WorkspaceGitSnapshotSchema,
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
        commit: WorkspaceGitCommitSchema,
        snapshot: WorkspaceGitSnapshotSchema,
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
export const templateInspectionSchema = z
  .object({
    pin: WorkspaceTemplatePinSchema,
    presentation: z
      .object({ name: z.string().optional(), description: z.string().optional() })
      .strict()
      .optional(),
    repositories: z.array(z.string()),
    files: z.array(z.string()),
  })
  .strict();
const authoringIntentSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    parts: z.array(z.string()).min(1),
  })
  .strict();
export const templateAuthoringInspectionSchema = z
  .object({
    request: authoringIntentSchema,
    mainEventId: z.string().trim().min(1),
    selectableParts: z.array(z.string()),
    requestedParts: z.array(z.string()).min(1),
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
    ref: z.string().startsWith("refs/tags/"),
    commit: WorkspaceGitCommitSchema,
    snapshot: WorkspaceGitSnapshotSchema,
    parts: z.array(z.string()).min(1),
  })
  .strict();
const registryEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    tags: z.array(z.string().trim().min(1)).min(1),
    recommended: z.boolean(),
  })
  .strict();
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

export const templatesMethods = defineServiceMethods({
  catalog: {
    description: "Return the verified upstream workspace catalog, optionally refreshing it.",
    args: z.union([z.tuple([]), z.tuple([z.object({ refresh: z.boolean().optional() }).strict()])]),
    returns: templateCatalogSnapshotSchema.nullable(),
    access: READ,
  },
  inspect: {
    description:
      "Resolve, acquire, and verify one exact self-contained upstream workspace snapshot.",
    args: z.tuple([templateLocatorSchema]),
    returns: templateInspectionSchema,
    access: READ,
  },
  inspectAuthoring: {
    description:
      "Build a reviewed self-contained snapshot plan from protected-main workspace source.",
    args: z.tuple([authoringIntentSchema]),
    returns: templateAuthoringInspectionSchema,
    access: READ,
  },
  authoringParts: {
    description: "List protected-main repositories available for snapshot authoring.",
    args: z.tuple([]),
    returns: z.array(
      z.object({ repoPath: z.string(), packageName: z.string().optional() }).strict()
    ),
    access: READ,
  },
  publishAuthoring: {
    description: "Revalidate and publish a reviewed self-contained workspace snapshot.",
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
  suggestRegistryEntry: {
    description: "Publish a review branch proposing an exact snapshot to the verified catalog.",
    args: z.tuple([
      z
        .object({
          commandId,
          catalog: templateCatalogSnapshotSchema,
          publication: templatePublicationSchema,
          credential: WorkspaceLogicalCredentialNameSchema.optional(),
          entry: registryEntrySchema,
          revision: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/u),
        })
        .strict(),
    ]),
    returns: templateRegistryContributionSchema,
    access: WRITE,
  },
});
export type TemplatesClient = TypedServiceClient<typeof templatesMethods>;
export type TemplateCatalogSnapshot = z.infer<typeof templateCatalogSnapshotSchema>;
export type TemplateInspection = z.infer<typeof templateInspectionSchema>;
export type TemplateLocator = z.infer<typeof templateLocatorSchema>;
export type TemplateExactPin = z.infer<typeof WorkspaceTemplatePinSchema>;
export type TemplateAuthoringIntent = z.infer<typeof authoringIntentSchema>;
export type TemplateAuthoringInspection = z.infer<typeof templateAuthoringInspectionSchema>;
export type TemplatePublication = z.infer<typeof templatePublicationSchema>;
