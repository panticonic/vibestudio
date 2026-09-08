/** One creation and receipt contract for shell, panel, worker and website callers. */
import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";

export const WorkspaceCreationOperationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
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
    },
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.create",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
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
    description:
      "Reconcile one previously submitted workspace creation without creating or opening anything.",
    args: z.tuple([z.object({ operationId: WorkspaceCreationOperationIdSchema }).strict()]),
    returns: WorkspaceCreationReceiptSchema.nullable(),
    access: { sensitivity: "read" },
  },
});
