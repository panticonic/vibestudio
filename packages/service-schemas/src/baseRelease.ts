import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { templateOperationSchema, templateStatusRowSchema } from "./templates.js";

const READ_ACCESS: MethodAccessDescriptor = { sensitivity: "read" };
const WRITE_ACCESS: MethodAccessDescriptor = { sensitivity: "write" };

export const baseReleaseCheckSchema = z
  .object({
    alias: z.string().trim().min(1),
    installed: templateStatusRowSchema,
    target: WorkspaceTemplatePinSchema,
    updateAvailable: z.boolean(),
  })
  .strict();

export const baseReleaseMethods = defineServiceMethods({
  check: {
    description:
      "Compare the installed Base lineage with the host's verified immutable Base release pin.",
    args: z.tuple([]),
    returns: baseReleaseCheckSchema,
    access: READ_ACCESS,
  },
  pull: {
    capability: "workspace.update-base",
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace.base-release",
      rationale:
        "The host supplies only its verified immutable Base pin; Composer retains ordinary semantic review, repair, and protected-main publication.",
    },
    presentation: {
      title: "Update Vibestudio Base",
      action: "update Vibestudio Base",
      description:
        "Prepare the exact Base shipped by this Vibestudio version through the normal workspace review.",
      group: "workspace",
      authorityCategory: { domain: "automation", verb: "manage" },
    },
    description:
      "Ask Composer to pull the host's verified exact Base release through its server-only release handshake.",
    args: z.tuple([z.object({ commandId: z.string().trim().min(1) }).strict()]),
    returns: templateOperationSchema,
    access: WRITE_ACCESS,
  },
});

export type BaseReleaseCheck = z.infer<typeof baseReleaseCheckSchema>;
