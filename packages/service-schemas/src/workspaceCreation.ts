/** One creation and receipt contract for shell, panel, worker and website callers. */
import { z } from "zod";
import {
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";

export const WorkspaceCreationOperationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const WORKSPACE_CREATION_AUTHORITY_RESOLVER =
  "hubControl.createWorkspace.exactRequest" as const;
export const WorkspaceCreationReceiptSchema = z
  .object({
    operationId: WorkspaceCreationOperationIdSchema,
    state: z.enum(["registered", "ready", "deleted"]),
    workspaceId: z.string(),
    name: z.string(),
  })
  .strict();

export const workspaceCreationMethods = defineServiceMethods({
  createWorkspace: {
    website: {
      kind: "eligible",
      rationale:
        "Workspace installation requires exact template review and durable operation ownership.",
    } as const,
    capability: "workspaces.create",
    authority: {
      requirement: requirementForPrincipals(
        ["user", "host", "code", "website"],
        "workspaces.create"
      ),
      resource: { kind: "argument", index: 0, path: ["operationId"] },
      prepared: {
        resolver: WORKSPACE_CREATION_AUTHORITY_RESOLVER,
        leaves: [
          {
            capability: "workspaces.create",
            requirement: fixedPreparedAuthorityRequirement(
              requirementForPrincipals(["user", "host", "code", "website"], "workspaces.create")
            ),
            tier: "gated",
          },
        ],
      },
    },
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "hubControl.create",
      rationale:
        "The transport leaf is open; the exact prepared creation request supplies the gated workspaces.create leaf.",
    },
    presentation: {
      title: "Create a workspace",
      action: "create a workspace",
      description: "Set up a new workspace from scratch or from a template.",
      group: "accounts",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
    description: "Create and register a workspace from one exact external root template.",
    args: z.tuple([
      z
        .object({
          operationId: WorkspaceCreationOperationIdSchema,
          workspace: z.string().min(1),
          rootTemplate: WorkspaceTemplatePinSchema.optional(),
        })
        .strict(),
    ]),
    returns: WorkspaceCreationReceiptSchema,
    access: { sensitivity: "write" },
  },
  workspaceCreationReceipt: {
    website: {
      kind: "eligible",
      rationale:
        "Only the authenticated durable owner can read the scoped minimal creation receipt with current permission.",
    },
    capability: "workspaces.creation.read",
    authority: {
      requirement: requirementForPrincipals(
        ["user", "host", "code", "website"],
        "workspaces.creation.read"
      ),
      resource: { kind: "argument", index: 0, path: ["operationId"] },
    },
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.creationReceipt",
      rationale:
        "Creation results can disclose workspaces outside the initiating workspace and require scoped consent.",
    },
    presentation: {
      title: "Read a workspace creation result",
      action: "read a workspace creation result",
      description:
        "Read the name, identifier, and status of the workspace created by this request.",
      group: "accounts",
      authorityCategory: { domain: "automation", verb: "see" },
    },
    description:
      "Reconcile one previously submitted workspace creation without creating or opening anything.",
    args: z.tuple([z.object({ operationId: WorkspaceCreationOperationIdSchema }).strict()]),
    returns: WorkspaceCreationReceiptSchema.nullable(),
    access: { sensitivity: "read" },
  },
});
