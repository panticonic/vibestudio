import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import { randomUUID } from "node:crypto";
import {
  shellApprovalMethods,
  shellApprovalValuesSchema,
  templateInstallResolutionSchema,
} from "@vibestudio/service-schemas/shellApproval";
import { readEventWatchRecords } from "@vibestudio/service-schemas/events";
import type { EventPayloads } from "@vibestudio/shared/events";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { JSON_FLAG, type CliCommand, type ParsedInvocation } from "./commandTable.js";
import { loadCliCredentials } from "./credentialStore.js";
import { AuthError, UsageError, jsonMode, printError, printResult } from "./output.js";
import { RpcClient } from "./rpcClient.js";
import { typedClient } from "./typedClients.js";

function requireClient(): RpcClient {
  const credentials = loadCliCredentials();
  if (!credentials) {
    throw new AuthError('not paired — run `vibestudio remote pair "<pair-link>"` first');
  }
  if (!credentials.workspaceName) {
    throw new AuthError(
      "no remote workspace selected — run `vibestudio remote select <workspace>`"
    );
  }
  return new RpcClient(credentials);
}

type ApprovalsClient = ReturnType<typeof approvalClient>;
function approvalClient(rpc: RpcClient) {
  return typedClient("shellApproval", shellApprovalMethods, rpc);
}

function positionals(inv: ParsedInvocation, count: number, usage: string): void {
  if (inv.positionals.length !== count || inv.positionals.some((value) => !value.trim())) {
    throw new UsageError(`usage: vibestudio approvals ${usage}`);
  }
}

async function jsonInput(inv: ParsedInvocation, usage: string): Promise<unknown> {
  const stdin = inv.flags["input"] === true;
  positionals(inv, stdin ? 1 : 2, usage);
  let raw = inv.positionals[1]!;
  if (stdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    raw = Buffer.concat(chunks).toString("utf8");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError("response must be valid JSON");
  }
}

function validate<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function renderPending(pending: PendingApproval[]): void {
  if (pending.length === 0) console.log("no pending approvals");
  for (const approval of pending) {
    const title = "title" in approval ? approval.title : approval.kind;
    const decisions = "allowedDecisions" in approval ? approval.allowedDecisions : undefined;
    console.log(
      `${approval.approvalId}\t${approval.kind}\t${approval.lifecycle?.state ?? "ready"}\t${title}` +
        `\tcaller=${approval.callerId}` +
        (decisions ? `\tdecisions=${decisions.join(",")}` : "")
    );
  }
}

async function pendingApproval(client: ApprovalsClient, id: string): Promise<PendingApproval> {
  const approval = (await client.listPending()).find((pending) => pending.approvalId === id);
  if (!approval) throw new Error(`No pending approval found: ${id}`);
  return approval;
}

function command(
  name: string,
  summary: string,
  usage: string,
  action: (inv: ParsedInvocation, client: ApprovalsClient) => Promise<unknown>,
  options: { input?: boolean; render?: (result: unknown) => void } = {}
): CliCommand {
  return {
    group: "approvals",
    name,
    summary,
    usage: `vibestudio approvals ${usage}`,
    flags: [
      ...(options.input
        ? [{ name: "input", takesValue: false, description: "Read the response JSON from stdin" }]
        : []),
      JSON_FLAG,
    ],
    run: async (inv) => {
      const json = jsonMode(inv.flags["json"] === true);
      let rpc: RpcClient | undefined;
      let exitCode = 0;
      try {
        rpc = requireClient();
        const result = await action(inv, approvalClient(rpc));
        printResult(result, {
          json,
          human: () => {
            if (options.render) options.render(result);
            else printResult(result, { json: false });
          },
        });
      } catch (error) {
        exitCode = printError(error, { json });
      } finally {
        try {
          await rpc?.close();
        } catch (error) {
          const cleanupExitCode = printError(error, { json });
          if (exitCode === 0) exitCode = cleanupExitCode;
        }
      }
      return exitCode;
    },
  };
}

async function watch(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  const controller = new AbortController();
  const stop = () => controller.abort();
  let rpc: RpcClient | undefined;
  let exitCode = 0;
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    positionals(inv, 0, "watch");
    rpc = requireClient();
    const response = await EventsClient.openWatch(
      rpc,
      ["shell-approval:pending-changed", "shell-approval:resolved"],
      randomUUID(),
      { signal: controller.signal, bodyIdleTimeoutMs: null }
    );
    let acknowledged = false;
    for await (const record of readEventWatchRecords(response)) {
      if (controller.signal.aborted) break;
      if (record.kind === "watching") {
        if (acknowledged) throw new Error("Approval watch sent more than one acknowledgement");
        acknowledged = true;
      } else if (!acknowledged) {
        throw new Error("Approval watch delivered data before its acknowledgement");
      }
      if (json) {
        console.log(JSON.stringify(record));
      } else if (record.kind === "watching") {
        console.error("watching workspace approvals (Ctrl-C to stop)");
      } else if (record.event === "shell-approval:pending-changed") {
        renderPending((record.payload as EventPayloads["shell-approval:pending-changed"]).pending);
      } else if (record.event === "shell-approval:resolved") {
        const resolved = record.payload as EventPayloads["shell-approval:resolved"];
        console.log(`${resolved.approvalId}\tresolved\t${resolved.decision}`);
      }
    }
    if (!controller.signal.aborted) throw new Error("Approval watch closed unexpectedly");
  } catch (error) {
    if (!controller.signal.aborted) exitCode = printError(error, { json });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    controller.abort();
    try {
      await rpc?.close();
    } catch (error) {
      const cleanupExitCode = printError(error, { json });
      if (exitCode === 0) exitCode = cleanupExitCode;
    }
  }
  return exitCode;
}

export const approvalCommands: CliCommand[] = [
  command(
    "list",
    "List all visible pending workspace approvals",
    "list",
    async (inv, client) => {
      positionals(inv, 0, "list");
      return client.listPending();
    },
    { render: (result) => renderPending(result as PendingApproval[]) }
  ),
  command(
    "show",
    "Show the complete pending approval and its offered choices",
    "show ID",
    async (inv, client) => {
      positionals(inv, 1, "show ID");
      return pendingApproval(client, inv.positionals[0]!);
    }
  ),
  {
    group: "approvals",
    name: "watch",
    summary: "Stream the current approval queue, changes, and resolutions",
    usage: "vibestudio approvals watch [--json]",
    flags: [JSON_FLAG],
    run: watch,
  },
  command(
    "resolve",
    "Answer an approval with one of its offered decisions",
    "resolve ID DECISION",
    async (inv, client) => {
      positionals(inv, 2, "resolve ID DECISION");
      const [id, decision] = validate(shellApprovalMethods.resolve.args, inv.positionals);
      await client.resolve(id, decision);
      return { approvalId: id, decision };
    }
  ),
  command(
    "review",
    "Accept or cancel an install/update review with exact permission selections",
    "review ID [RESPONSE_JSON | --input]",
    async (inv, client) => {
      const resolution = validate(
        templateInstallResolutionSchema,
        await jsonInput(inv, "review ID [RESPONSE_JSON | --input]")
      );
      return client.resolveInstallReview(inv.positionals[0]!, resolution);
    },
    { input: true }
  ),
  command(
    "rules",
    "Accept selected chat permission rows or cancel the review",
    "rules ID [RESPONSE_JSON | --input]",
    async (inv, client) => {
      const response = await jsonInput(inv, "rules ID [RESPONSE_JSON | --input]");
      const [id, resolution] = validate(shellApprovalMethods.resolveTaskRules.args, [
        inv.positionals[0],
        response,
      ]);
      await client.resolveTaskRules(id, resolution);
      return { approvalId: id, decision: resolution.decision };
    },
    { input: true }
  ),
  command(
    "submit",
    "Submit fields for a secret, credential, or provider configuration prompt",
    "submit ID [VALUES_JSON | --input]",
    async (inv, client) => {
      const values = validate(
        shellApprovalValuesSchema,
        await jsonInput(inv, "submit ID [VALUES_JSON | --input]")
      );
      const id = inv.positionals[0]!;
      const approval = await pendingApproval(client, id);
      switch (approval.kind) {
        case "client-config":
          await client.submitClientConfig(id, values);
          break;
        case "credential-input":
          await client.submitCredentialInput(id, values);
          break;
        case "secret-input":
          await client.submitSecretInput(id, values);
          break;
        default:
          throw new UsageError(`Approval kind '${approval.kind}' does not accept field values`);
      }
      return { approvalId: id, decision: "submit" };
    },
    { input: true }
  ),
];
