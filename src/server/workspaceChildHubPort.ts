/**
 * The complete child→hub process boundary.
 *
 * A workspace child can report only the workspace-local observations and
 * request only the hub-owned writes listed here. This is deliberately not a
 * general RPC client: callers cannot choose a route, transport a subject, or
 * forward an arbitrary service invocation.
 */

import { z } from "zod";
import {
  ApprovalRecordSchema,
  GovernanceRecordSchema,
} from "@vibestudio/shared/governance/governanceLog";
import type { ApprovalResolvedEvent, GovernanceRecord } from "@vibestudio/shared/governance/types";
import { DEVICE_ID_PATTERN, SERVER_BOOT_ID_PATTERN } from "@vibestudio/shared/deviceCredentials";
import type { IssuedAgentCredential } from "./hostCore/deviceAuthStore.js";
import { governanceListQuerySchema } from "./hostCore/governanceQuery.js";

export const WorkspaceChildAgentCredentialMintInputSchema = z
  .object({
    entityId: z.string().min(1),
    ttlMs: z.number().int().positive().optional(),
  })
  .strict();
export const WorkspaceChildAgentCredentialMintResultSchema = z
  .object({ agentId: z.string().min(1), agentToken: z.string().min(1) })
  .strict();

export const WorkspaceChildAgentCredentialRevokeInputSchema = z
  .object({ agentId: z.string().min(1) })
  .strict();
export const WorkspaceChildAgentCredentialRevokeResultSchema = z
  .object({ revoked: z.boolean() })
  .strict();

export const WorkspaceChildAgentCredentialRevokeEntityInputSchema = z
  .object({ entityId: z.string().min(1) })
  .strict();
export const WorkspaceChildAgentCredentialRevokeEntityResultSchema = z
  .object({ revokedAgentIds: z.array(z.string().min(1)) })
  .strict();

export const WorkspaceChildDeviceTouchInputSchema = z
  .object({ deviceId: z.string().regex(DEVICE_ID_PATTERN) })
  .strict();
export const WorkspaceChildDeviceTouchResultSchema = z
  .object({ touched: z.literal(true) })
  .strict();

export const WorkspaceChildPresenceReportInputSchema = z
  .object({
    serverBootId: z.string().regex(SERVER_BOOT_ID_PATTERN),
    revision: z.number().int().nonnegative(),
    users: z
      .array(
        z
          .object({
            userId: z.string().min(1),
            endpoints: z.number().int().positive(),
          })
          .strict()
      )
      .refine(
        (users) => new Set(users.map((user) => user.userId)).size === users.length,
        "Presence report contains duplicate users"
      ),
  })
  .strict();
export const WorkspaceChildPresenceReportResultSchema = z.object({ updated: z.boolean() }).strict();

export const WorkspaceChildGovernanceAppendInputSchema = z
  .object({ record: ApprovalRecordSchema.omit({ workspaceId: true }) })
  .strict();
export const WorkspaceChildGovernanceAppendResultSchema = z
  .object({ appended: z.literal(true) })
  .strict();

export const WorkspaceChildGovernanceQueryInputSchema = z
  .object({ query: governanceListQuerySchema.optional() })
  .strict();
export const WorkspaceChildGovernanceQueryResultSchema = z
  .object({ records: z.array(GovernanceRecordSchema) })
  .strict();

export interface WorkspaceChildHubPort {
  mintAgentCredential(input: { entityId: string; ttlMs?: number }): Promise<IssuedAgentCredential>;
  revokeAgentCredential(agentId: string): Promise<boolean>;
  revokeAgentCredentialsForEntity(entityId: string): Promise<string[]>;
  touchDevice(deviceId: string): Promise<void>;
  reportPresence(input: z.infer<typeof WorkspaceChildPresenceReportInputSchema>): Promise<boolean>;
  appendApproval(record: ApprovalResolvedEvent): Promise<void>;
  queryGovernance(query?: z.infer<typeof governanceListQuerySchema>): Promise<GovernanceRecord[]>;
}

interface WorkspaceChildHubPortOptions {
  hubUrl: string;
  runtimeToken: string;
  fetchImpl?: typeof fetch;
}

export function createWorkspaceChildHubPort(
  options: WorkspaceChildHubPortOptions
): WorkspaceChildHubPort {
  const fetchImpl = options.fetchImpl ?? fetch;

  const post = async <TInput, TResult>(
    route:
      | "agent-credential/mint"
      | "agent-credential/revoke"
      | "agent-credential/revoke-entity"
      | "device/touch"
      | "presence/report"
      | "governance/append-approval"
      | "governance/query",
    inputSchema: z.ZodType<TInput>,
    resultSchema: z.ZodType<TResult>,
    input: TInput
  ): Promise<TResult> => {
    const body = inputSchema.parse(input);
    const response = await fetchImpl(new URL(`/_r/s/internal/${route}`, options.hubUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.runtimeToken}`,
      },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        payload &&
        typeof payload === "object" &&
        typeof (payload as { error?: unknown }).error === "string"
          ? (payload as { error: string }).error
          : `Hub child port failed with HTTP ${response.status}`;
      throw new Error(message);
    }
    return resultSchema.parse(payload);
  };

  return {
    mintAgentCredential: (input) =>
      post(
        "agent-credential/mint",
        WorkspaceChildAgentCredentialMintInputSchema,
        WorkspaceChildAgentCredentialMintResultSchema,
        input
      ),
    async revokeAgentCredential(agentId) {
      return (
        await post(
          "agent-credential/revoke",
          WorkspaceChildAgentCredentialRevokeInputSchema,
          WorkspaceChildAgentCredentialRevokeResultSchema,
          { agentId }
        )
      ).revoked;
    },
    async revokeAgentCredentialsForEntity(entityId) {
      return (
        await post(
          "agent-credential/revoke-entity",
          WorkspaceChildAgentCredentialRevokeEntityInputSchema,
          WorkspaceChildAgentCredentialRevokeEntityResultSchema,
          { entityId }
        )
      ).revokedAgentIds;
    },
    async touchDevice(deviceId) {
      await post(
        "device/touch",
        WorkspaceChildDeviceTouchInputSchema,
        WorkspaceChildDeviceTouchResultSchema,
        { deviceId }
      );
    },
    async reportPresence(input) {
      return (
        await post(
          "presence/report",
          WorkspaceChildPresenceReportInputSchema,
          WorkspaceChildPresenceReportResultSchema,
          input
        )
      ).updated;
    },
    async appendApproval(record) {
      await post(
        "governance/append-approval",
        WorkspaceChildGovernanceAppendInputSchema,
        WorkspaceChildGovernanceAppendResultSchema,
        { record }
      );
    },
    async queryGovernance(query) {
      return (
        await post(
          "governance/query",
          WorkspaceChildGovernanceQueryInputSchema,
          WorkspaceChildGovernanceQueryResultSchema,
          { query }
        )
      ).records;
    },
  };
}
