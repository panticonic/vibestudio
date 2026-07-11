/**
 * Governance read service (WP5 §7) — the host-side half of the unified
 * governance timeline.
 *
 * Exposes `governance.list({ filter })` over the host-owned governance log
 * (`GovernanceLog`), which unions approval-provenance resolutions and
 * membership-governance events (invite/revoke/add/remove/role-change). This is
 * a pure READ surface: the log is host-owned (INV-2) and single-writer; the
 * `gad-browser` Governance view stitches these host records together with the
 * userland GAD agent-approval projection for one timeline.
 *
 * The method shape is declared inline (mirroring `auditService.ts`) rather than
 * in a shared `serviceSchema`, so the host log has no compile-time dependency on
 * userland. A shared typed client for the `gad-browser` panel is a thin
 * follow-on wrapper over the same shape.
 */

import z from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import {
  GovernanceRecordSchema,
  type GovernanceQuery,
} from "@vibestudio/shared/governance/governanceLog";
import type { GovernanceRecord } from "@vibestudio/shared/governance/types";

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

export function createGovernanceService(deps: {
  query: (query: GovernanceQuery) => Promise<GovernanceRecord[]>;
}): ServiceDefinition {
  return {
    name: "governance",
    description: "Host governance log — approval provenance + membership events (read-only)",
    policy: { allowed: ["shell", "panel", "app", "server", "worker", "do", "extension"] },
    methods: {
      list: {
        description:
          "List host governance records (approval resolutions + membership events) newest-first, optionally filtered by record kind, acting user, approval kind, membership op, workspace, or grant outcome.",
        args: z.tuple([governanceListQuerySchema.optional()]),
        returns: z.array(GovernanceRecordSchema),
        access: { sensitivity: "read" },
        examples: [{ args: [{ filter: { recordKind: "approval" }, limit: 50 }] }],
      },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "list": {
          const raw = (args[0] as GovernanceQuery | undefined) ?? {};
          return await deps.query({
            ...raw,
            limit: Math.max(1, Math.min(500, raw.limit ?? 100)),
          });
        }
        default:
          throw new Error(`Unknown governance method: ${method}`);
      }
    },
  };
}
