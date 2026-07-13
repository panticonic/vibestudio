import { z } from "zod";

const APPROVAL_KINDS = [
  "credential",
  "capability",
  "client-config",
  "credential-input",
  "secret-input",
  "userland",
  "unit-batch",
  "device-code",
  "external-agent",
] as const;

const MEMBERSHIP_OPS = [
  "invite-user",
  "revoke-user",
  "add-member",
  "remove-member",
  "role-change",
] as const;

/** Shared host-core parser for hub and child governance reads. */
export const governanceListQuerySchema = z
  .object({
    filter: z
      .object({
        recordKind: z.enum(["approval", "membership"]).optional(),
        userId: z.string().optional(),
        approvalKind: z.enum(APPROVAL_KINDS).optional(),
        op: z.enum(MEMBERSHIP_OPS).optional(),
        workspaceId: z.string().optional(),
        granted: z.boolean().optional(),
      })
      .strict()
      .optional(),
    limit: z.number().int().positive().optional(),
    after: z.number().optional(),
  })
  .strict();
