import type { PendingApproval } from "@vibestudio/shared/approvals";
import { APPROVAL_DECISIONS, type ApprovalDecisionId } from "@vibestudio/shared/approvalContract";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import { RpcClient } from "@vibestudio/direct-client";
import { JSON_FLAG, type CliCommand, type ParsedInvocation } from "./commandTable.js";
import { loadCliCredentials, type CliCredentials } from "./credentialStore.js";
import { AuthError, CliError, UsageError, jsonMode, printError, printResult } from "./output.js";
import { typedClient } from "./typedClients.js";
import { resolveVerifiedLocalWorkspaceClient } from "./verifiedLocalWorkspaceClient.js";

const DEFAULT_WATCH_INTERVAL_MS = 2_000;

function workspaceCredentials(): CliCredentials {
  const credentials = loadCliCredentials();
  if (!credentials) {
    throw new AuthError('not paired — run `vibestudio remote pair "<pair-link>"` first');
  }
  if (!credentials.workspaceName) {
    throw new AuthError(
      "no remote workspace selected — run `vibestudio remote select <workspace>`"
    );
  }
  return credentials;
}

function positiveInterval(inv: ParsedInvocation): number {
  const raw = inv.flags["interval-ms"];
  if (raw === undefined) return DEFAULT_WATCH_INTERVAL_MS;
  if (typeof raw !== "string") throw new UsageError("--interval-ms requires a value");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 250) {
    throw new UsageError("--interval-ms must be an integer of at least 250");
  }
  return value;
}

function approvalTitle(approval: PendingApproval): string {
  if ("title" in approval && typeof approval.title === "string") return approval.title;
  if (approval.kind === "credential") return `Use ${approval.credentialLabel}`;
  if (approval.kind === "external-agent") return approval.operationName;
  if (approval.kind === "device-code") return `Connect ${approval.credentialLabel}`;
  return approval.operation?.verb ?? approval.kind;
}

export function approvalSummary(approval: PendingApproval) {
  return {
    approvalId: approval.approvalId,
    kind: approval.kind,
    title: approvalTitle(approval),
    callerId: approval.callerId,
    callerKind: approval.callerKind,
    repoPath: approval.repoPath,
    executionDigest: approval.executionDigest,
    requestedAt: approval.requestedAt,
    decisionDeadlineAt: approval.decisionDeadlineAt,
    operation: approval.operation,
    requester: approval.requester,
    ...(approval.kind === "capability"
      ? {
          capability: approval.capability,
          allowedDecisions: approval.allowedDecisions ?? APPROVAL_DECISIONS,
        }
      : {}),
    ...(approval.kind === "userland"
      ? { choices: [...approval.options.map((option) => option.value), "dismiss"] }
      : {}),
    ...(approval.kind === "external-agent" ? { choices: ["allow", "deny"] } : {}),
    ...(approval.kind === "unit-batch" ? { choices: ["once", "deny"] } : {}),
  };
}

async function withApprovalClient<T>(operation: (client: RpcClient) => Promise<T>): Promise<T> {
  const client = await approvalClient();
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}

async function approvalClient(): Promise<RpcClient> {
  const credentials = workspaceCredentials();
  const resolution = await resolveVerifiedLocalWorkspaceClient(credentials);
  if (resolution.unavailableReason) {
    console.warn(
      `[approval] doctor-verified local gateway became unavailable: ${resolution.unavailableReason}; ` +
        "continuing over the paired transport"
    );
  }
  return resolution.local?.client ?? new RpcClient(credentials);
}

async function queueState(client: RpcClient) {
  const shellApproval = typedClient("shellApproval", shellApprovalMethods, client);
  // The direct WebRTC transport preserves a single ordered RPC stream. Keep
  // this snapshot sequential so large approval payloads cannot interleave with
  // the reachability response and close an otherwise healthy side-channel.
  const pending = await shellApproval.listPending();
  const presence = await client.call<{
    reachable: boolean;
    activeApproverCount: number;
    maxAgeMs: number;
  }>("shellPresence.status", []);
  return {
    pending: pending.map(approvalSummary),
    approvers: presence,
  };
}

async function listApprovals(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const state = await withApprovalClient(queueState);
    printResult(state, {
      json,
      human: () => {
        console.log(
          `approver reachable: ${state.approvers.reachable ? "yes" : "no"} (${state.approvers.activeApproverCount} active)`
        );
        if (state.pending.length === 0) {
          console.log("no pending approvals");
          return;
        }
        for (const approval of state.pending) {
          console.log(
            `${approval.approvalId}\t${approval.kind}\t${approval.title}\t${approval.repoPath ?? approval.callerId}`
          );
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

export async function resolvePendingApproval(
  client: RpcClient,
  approvalId: string,
  decision: string
): Promise<void> {
  const shellApproval = typedClient("shellApproval", shellApprovalMethods, client);
  const approval = (await shellApproval.listPending()).find(
    (candidate) => candidate.approvalId === approvalId
  );
  if (!approval) throw new CliError(`no pending approval found for ${approvalId}`);

  if (approval.kind === "unit-batch") {
    if (decision !== "once" && decision !== "deny") {
      throw new UsageError("unit-batch approvals accept only once or deny");
    }
    await shellApproval.resolveBootstrap(approvalId, decision);
    return;
  }
  if (approval.kind === "userland") {
    const choices = new Set([...approval.options.map((option) => option.value), "dismiss"]);
    if (!choices.has(decision)) {
      throw new UsageError(`userland approval choice must be one of: ${[...choices].join(", ")}`);
    }
    await shellApproval.resolveUserland(approvalId, decision);
    return;
  }
  if (approval.kind === "external-agent") {
    if (decision !== "allow" && decision !== "deny") {
      throw new UsageError("external-agent approvals accept only allow or deny");
    }
    await shellApproval.resolveExternalAgent(approvalId, decision);
    return;
  }
  if (
    approval.kind === "client-config" ||
    approval.kind === "credential-input" ||
    approval.kind === "secret-input"
  ) {
    throw new UsageError(
      `${approval.kind} requires field values; use \`vibestudio approval submit ${approvalId} '{...}'\``
    );
  }
  if (approval.kind === "device-code") {
    throw new UsageError(
      `device-code approval must be completed at ${approval.verificationUri}; it cannot be decided locally`
    );
  }
  if (!APPROVAL_DECISIONS.includes(decision as ApprovalDecisionId)) {
    throw new UsageError(`decision must be one of: ${APPROVAL_DECISIONS.join(", ")}`);
  }
  if (
    approval.kind === "capability" &&
    approval.allowedDecisions &&
    !approval.allowedDecisions.includes(decision as ApprovalDecisionId)
  ) {
    throw new UsageError(
      `this capability approval accepts only: ${approval.allowedDecisions.join(", ")}`
    );
  }
  await shellApproval.resolve(approvalId, decision as ApprovalDecisionId);
}

async function resolveApproval(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const [approvalId, decision] = inv.positionals;
    if (!approvalId || !decision) throw new UsageError("pass APPROVAL_ID and DECISION");
    await withApprovalClient((client) => resolvePendingApproval(client, approvalId, decision));
    printResult({ approvalId, decision, resolved: true }, { json });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function submitApproval(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const [approvalId, valuesJson] = inv.positionals;
    if (!approvalId || !valuesJson) throw new UsageError("pass APPROVAL_ID and VALUES_JSON");
    let values: unknown;
    try {
      values = JSON.parse(valuesJson);
    } catch {
      throw new UsageError("VALUES_JSON must be valid JSON");
    }
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new UsageError("VALUES_JSON must be an object of string fields");
    }
    await withApprovalClient(async (client) => {
      const shellApproval = typedClient("shellApproval", shellApprovalMethods, client);
      const approval = (await shellApproval.listPending()).find(
        (candidate) => candidate.approvalId === approvalId
      );
      if (!approval) throw new CliError(`no pending approval found for ${approvalId}`);
      if (approval.kind === "client-config") {
        await shellApproval.submitClientConfig(approvalId, values as Record<string, string>);
      } else if (approval.kind === "credential-input") {
        await shellApproval.submitCredentialInput(approvalId, values as Record<string, string>);
      } else if (approval.kind === "secret-input") {
        await shellApproval.submitSecretInput(approvalId, values as Record<string, string>);
      } else {
        throw new UsageError(`${approval.kind} does not accept submitted field values`);
      }
    });
    printResult({ approvalId, submitted: true }, { json });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function watchApprovals(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  const intervalMs = positiveInterval(inv);
  const client = await approvalClient();
  let previous = "";
  try {
    for (;;) {
      await client.call("shellPresence.heartbeat", []);
      const state = await queueState(client);
      const signature = JSON.stringify(state.pending);
      if (signature !== previous) {
        previous = signature;
        printResult(state, {
          json,
          human: () => {
            const now = new Date().toISOString();
            console.log(`[${now}] ${state.pending.length} pending approval(s)`);
            for (const approval of state.pending) {
              console.log(
                `${approval.approvalId}\t${approval.kind}\t${approval.title}\n  resolve: vibestudio approval resolve ${approval.approvalId} <decision>`
              );
            }
          },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ABORT_ERR") return 0;
    return printError(error, { json });
  } finally {
    await client.close();
  }
}

export const approvalCommands: CliCommand[] = [
  {
    group: "approval",
    name: "list",
    summary: "List pending approvals and approver reachability",
    usage: "vibestudio approval list",
    flags: [JSON_FLAG],
    run: listApprovals,
  },
  {
    group: "approval",
    name: "watch",
    summary: "Keep an approval-capable CLI side-channel active and print queue changes",
    usage: "vibestudio approval watch [--interval-ms 2000]",
    flags: [
      {
        name: "interval-ms",
        takesValue: true,
        description: "Queue poll and presence-heartbeat interval (minimum 250; default 2000)",
      },
      JSON_FLAG,
    ],
    run: watchApprovals,
  },
  {
    group: "approval",
    name: "resolve",
    summary: "Resolve a pending approval with an allowed decision",
    usage: "vibestudio approval resolve APPROVAL_ID DECISION",
    flags: [JSON_FLAG],
    run: resolveApproval,
  },
  {
    group: "approval",
    name: "submit",
    summary: "Submit fields for a pending configuration or secret-input approval",
    usage: "vibestudio approval submit APPROVAL_ID VALUES_JSON",
    flags: [JSON_FLAG],
    run: submitApproval,
  },
];
