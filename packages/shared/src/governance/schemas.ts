import { z } from "zod";

const UserActorSchema = z
  .object({
    userId: z.string().min(1),
    handle: z.string().min(1),
    deviceId: z.string().min(1).optional(),
  })
  .strict();

export const ApprovalRecordSchema = z
  .object({
    approvalId: z.string().min(1),
    approvalKind: z.enum([
      "credential",
      "capability",
      "client-config",
      "credential-input",
      "secret-input",
      "userland",
      "unit-install-review",
      "device-code",
      "external-agent",
      "browser-permission",
    ]),
    decision: z.enum([
      "once",
      "task",
      "agent",
      "lock",
      "session",
      "version",
      "always",
      "block",
      "deny",
      "dismiss",
      "approve",
      "submit",
    ]),
    granted: z.boolean(),
    workspaceId: z.string().min(1),
    resolvedAt: z.number().finite(),
    resolvedBy: UserActorSchema.extend({ deviceLabel: z.string().min(1).optional() }),
    resolvedVia: z.enum(["shell", "mobile-notification", "app", "server"]),
    requestedBy: z
      .object({
        callerId: z.string().min(1),
        callerKind: z.string().min(1),
        repoPath: z.string().min(1).optional(),
        effectiveVersion: z.string().min(1).optional(),
        userId: z.string().min(1).optional(),
      })
      .strict(),
    resource: z
      .object({
        capability: z.string().min(1).optional(),
        key: z.string().min(1).optional(),
        value: z.string().optional(),
        credentialId: z.string().min(1).optional(),
        subjectId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    grantScopeStored: z
      .enum(["task", "agent", "lock", "session", "version", "always", "block", "mission"])
      .nullable()
      .optional(),
    operationId: z.string().min(1).optional(),
    taskSubject: z.string().min(1).optional(),
    securityIdentity: z.string().min(1).optional(),
    semanticFamily: z.string().min(1).optional(),
    sourcesShown: z.array(z.string().min(1)).optional(),
    repeatReason: z
      .enum([
        "none",
        "new-source",
        "new-resource",
        "new-actor",
        "changed-effect",
        "restart-undecided",
        "duplicate",
      ])
      .optional(),
    surface: z
      .object({ title: z.string(), description: z.string(), rows: z.array(z.string()) })
      .strict()
      .optional(),
  })
  .strict();

export const MembershipRecordSchema = z
  .object({
    kind: z.literal("membership"),
    operationId: z.string().min(1).optional(),
    op: z.enum(["invite-user", "revoke-user", "add-member", "remove-member", "role-change"]),
    actor: UserActorSchema,
    target: z.object({ userId: z.string().min(1), handle: z.string().min(1).optional() }).strict(),
    workspaceId: z.string().min(1).optional(),
    role: z.enum(["root", "admin", "member"]).optional(),
    at: z.number().finite(),
  })
  .strict();

export const GovernanceRecordSchema = z.union([MembershipRecordSchema, ApprovalRecordSchema]);
