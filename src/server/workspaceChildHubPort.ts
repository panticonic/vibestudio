/**
 * The complete child→hub process boundary.
 *
 * A workspace child can report only the workspace-local observations and
 * request only the hub-owned writes listed here. This is deliberately not a
 * general RPC client. Cross-workspace envelopes use a dedicated host-attested
 * forwarding operation; ordinary workspace code never receives this port.
 */

import { z } from "zod";
import {
  forwardWorkspaceRpcHttp,
  WORKSPACE_RPC_INTERNAL_ROUTE,
  type WorkspaceRpcInvocation,
} from "./workspaceRpcTransport.js";
import type { RpcEnvelope } from "@vibestudio/rpc";
import {
  ApprovalRecordSchema,
  GovernanceRecordSchema,
} from "@vibestudio/shared/governance/governanceLog";
import type { ApprovalResolvedEvent, GovernanceRecord } from "@vibestudio/shared/governance/types";
import { DEVICE_ID_PATTERN, SERVER_BOOT_ID_PATTERN } from "@vibestudio/shared/deviceCredentials";
import { workspaceCreationMethods } from "@vibestudio/service-schemas/workspaceCreation";
import { HubPairingInviteSchema } from "@vibestudio/service-schemas/hubControl";
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
export const WorkspaceChildDeviceInviteInputSchema = z
  .object({
    userId: z.string().min(1),
    ttlMs: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000),
  })
  .strict();
export const WorkspaceChildDeviceInviteResultSchema = z
  .object({
    workspace: z.string().min(1),
    pairing: HubPairingInviteSchema,
  })
  .strict();

export const WorkspaceChildPresenceReportInputSchema = z
  .object({
    serverBootId: z.string().regex(SERVER_BOOT_ID_PATTERN),
    revision: z.number().int().nonnegative(),
    workspaceApprovalCount: z.number().int().nonnegative(),
    pendingApprovals: z
      .array(
        z
          .object({
            userId: z.string().min(1),
            count: z.number().int().positive(),
          })
          .strict()
      )
      .refine(
        (entries) => new Set(entries.map((entry) => entry.userId)).size === entries.length,
        "Approval report contains duplicate users"
      ),
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
export const WorkspaceChildCreationCompleteInputSchema = z.object({}).strict();
export const WorkspaceChildCreationCompleteResultSchema = z
  .object({ completed: z.boolean() })
  .strict();
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

/** Caller evidence is supplied only by the authenticated workspace host, never page arguments. */
const WorkspaceCreationRequesterSchema = z
  .object({
    userId: z.string().min(1),
    subject: z.string().min(1).max(2048),
  })
  .strict();
export const WorkspaceChildCreateInputSchema = z
  .object({
    requester: WorkspaceCreationRequesterSchema,
    input: workspaceCreationMethods.createWorkspace.args.items[0],
  })
  .strict();
export const WorkspaceChildCreationReceiptInputSchema = z
  .object({
    requester: WorkspaceCreationRequesterSchema,
    input: workspaceCreationMethods.workspaceCreationReceipt.args.items[0],
  })
  .strict();

export interface WorkspaceChildHubPort {
  createWorkspace(
    input: z.infer<typeof WorkspaceChildCreateInputSchema>
  ): Promise<z.infer<typeof workspaceCreationMethods.createWorkspace.returns>>;
  workspaceCreationReceipt(
    input: z.infer<typeof WorkspaceChildCreationReceiptInputSchema>
  ): Promise<z.infer<typeof workspaceCreationMethods.workspaceCreationReceipt.returns>>;

  forwardWorkspaceRpc(
    invocation: WorkspaceRpcInvocation,
    options: {
      body?: ReadableStream<Uint8Array> | null;
      signal?: AbortSignal;
      onEnvelope(envelope: RpcEnvelope): Promise<void> | void;
      assertLive?(): void;
    }
  ): Promise<void>;
  mintAgentCredential(input: { entityId: string; ttlMs?: number }): Promise<IssuedAgentCredential>;
  revokeAgentCredential(agentId: string): Promise<boolean>;
  revokeAgentCredentialsForEntity(entityId: string): Promise<string[]>;
  touchDevice(deviceId: string): Promise<void>;
  mintDeviceInvite(
    input: z.infer<typeof WorkspaceChildDeviceInviteInputSchema>
  ): Promise<z.infer<typeof WorkspaceChildDeviceInviteResultSchema>>;
  reportPresence(input: z.infer<typeof WorkspaceChildPresenceReportInputSchema>): Promise<boolean>;
  completeWorkspaceCreation(): Promise<boolean>;
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
      | "device/invite"
      | "presence/report"
      | "workspace/create"
      | "workspace/creation-receipt"
      | "workspace/creation-complete"
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
    createWorkspace: (input) =>
      post(
        "workspace/create",
        WorkspaceChildCreateInputSchema,
        workspaceCreationMethods.createWorkspace.returns,
        input
      ),
    workspaceCreationReceipt: (input) =>
      post(
        "workspace/creation-receipt",
        WorkspaceChildCreationReceiptInputSchema,
        workspaceCreationMethods.workspaceCreationReceipt.returns,
        input
      ),
    forwardWorkspaceRpc: (invocation, delivery) =>
      forwardWorkspaceRpcHttp({
        ...delivery,
        invocation,
        runtimeToken: options.runtimeToken,
        fetchImpl,
        url: new URL(WORKSPACE_RPC_INTERNAL_ROUTE, options.hubUrl),
      }),
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
    mintDeviceInvite: (input) =>
      post(
        "device/invite",
        WorkspaceChildDeviceInviteInputSchema,
        WorkspaceChildDeviceInviteResultSchema,
        input
      ),
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
    async completeWorkspaceCreation() {
      return (
        await post(
          "workspace/creation-complete",
          WorkspaceChildCreationCompleteInputSchema,
          WorkspaceChildCreationCompleteResultSchema,
          {}
        )
      ).completed;
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
