import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import {
  defineServiceMethods,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import {
  WorkspaceGitCommitSchema,
  WorkspaceGitSnapshotSchema,
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
]);
export const templateSourceDeclarationSchema = z
  .object({
    url: z.string().url(),
    credential: z.string().trim().min(1).optional(),
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
export const templatesMethods = defineServiceMethods({
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
    description:
      "Resolve, acquire, and verify one exact self-contained upstream workspace snapshot.",
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
      "Build a reviewed self-contained snapshot plan from protected-main workspace source.",
    args: z.tuple([authoringIntentSchema]),
    returns: templateAuthoringInspectionSchema,
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
      z.object({ repoPath: z.string(), packageName: z.string().optional() }).strict()
    ),
    access: READ,
  },
  publishAuthoring: {
    website: {
      kind: "closed",
      reason:
        "The templates receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
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
});

/** Host-owned exact-source acquisition used by reviewed source consumers. */
export const workspaceTemplateSourceMethods = defineServiceMethods({
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
