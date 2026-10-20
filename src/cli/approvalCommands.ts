import { formatRpcFailure } from "@vibestudio/rpc";
import { schemaRpcCaller } from "@vibestudio/rpc/internal";
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
import { loadCliIdentity, type CliCredentials } from "./credentialStore.js";
import { openHubControlRpc } from "./remoteClient.js";
import { AuthError, UsageError, jsonMode, printError, printResult } from "./output.js";
import { RpcClient } from "./rpcClient.js";
import { typedClient } from "./typedClients.js";

/** Where a pending approval is queued: the selected workspace, or the hub the account lives on. */
type ApprovalSource = "workspace" | "hub";
type LabelledApproval = PendingApproval & { source: ApprovalSource };

type ApprovalsClient = ReturnType<typeof approvalClient>;
function approvalClient(rpc: RpcClient) {
  return typedClient("shellApproval", shellApprovalMethods, rpc);
}

/** A queue that could not be consulted, and why. */
interface SurfaceFailure {
  source: ApprovalSource;
  error: unknown;
}

/** The queues reachable now, the ones that were not, and whether an answer omits the latter. */
interface SurfaceSet {
  surfaces: Surface[];
  unavailable: SurfaceFailure[];
  incomplete: boolean;
}

function unavailableError(failure: SurfaceFailure): Error {
  return new Error(`${failure.source} approvals unavailable: ${formatRpcFailure(failure.error)}`, {
    cause: failure.error,
  });
}

interface Surface {
  source: ApprovalSource;
  rpc: RpcClient;
  client: ApprovalsClient;
}

/**
 * Open every approval queue this login can answer. A paired device owns the
 * hub's queue (device lifecycle and workspace-creation consent) as well as the
 * selected workspace's; an agent profile reaches only its workspace. Both
 * queues speak `shellApproval`, so one surface serves both, labelled by source.
 */
async function openSurfaces(): Promise<SurfaceSet> {
  const identity = loadCliIdentity();
  if (!identity) {
    throw new AuthError('not paired — run `vibestudio remote pair "<pair-link>"` first');
  }
  const workspace =
    identity.kind === "agent" || identity.phase === "workspace"
      ? (identity as CliCredentials)
      : undefined;
  const set: SurfaceSet = { surfaces: [], unavailable: [], incomplete: false };
  if (workspace) {
    const rpc = new RpcClient(workspace);
    set.surfaces.push({ source: "workspace", rpc, client: approvalClient(rpc) });
  }
  if (identity.kind === "device") {
    // One queue being unreachable must not discard the other's answers: it is
    // recorded against its source and reported with them.
    try {
      const rpc = await openHubControlRpc(identity);
      set.surfaces.push({ source: "hub", rpc, client: approvalClient(rpc) });
    } catch (error) {
      set.unavailable.push({ source: "hub", error });
    }
  }
  if (set.surfaces.length === 0 && set.unavailable[0]) throw set.unavailable[0].error;
  return set;
}

async function closeSurfaces(surfaces: Surface[]): Promise<void> {
  const results = await Promise.allSettled(surfaces.map((surface) => surface.rpc.close()));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Failed to close approval connections");
}

async function listAll(set: SurfaceSet): Promise<LabelledApproval[]> {
  const settled = await Promise.allSettled(
    set.surfaces.map(async (surface) =>
      (await surface.client.listPending()).map(
        (approval): LabelledApproval => ({ ...approval, source: surface.source })
      )
    )
  );
  const approvals: LabelledApproval[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") approvals.push(...result.value);
    else set.unavailable.push({ source: set.surfaces[index]!.source, error: result.reason });
  });
  // The list is what the reachable queues hold; the caller is told it is not everything.
  set.incomplete = set.unavailable.length > 0;
  return approvals;
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

function renderPending(pending: Array<PendingApproval & { source?: ApprovalSource }>): void {
  if (pending.length === 0) console.log("no pending approvals");
  for (const approval of pending) {
    const title = "title" in approval ? approval.title : approval.kind;
    const decisions = "allowedDecisions" in approval ? approval.allowedDecisions : undefined;
    console.log(
      `${approval.source ? `${approval.source}\t` : ""}${approval.approvalId}\t${approval.kind}\t${approval.lifecycle?.state ?? "ready"}\t${title}` +
        `\tcaller=${approval.callerId}` +
        (decisions ? `\tdecisions=${decisions.join(",")}` : "")
    );
  }
}

/** The approval and the queue that owns it, so a decision reaches the right server. */
async function pendingApproval(
  set: SurfaceSet,
  id: string
): Promise<{ approval: LabelledApproval; client: ApprovalsClient }> {
  const failures = [...set.unavailable];
  for (const surface of set.surfaces) {
    try {
      const approval = (await surface.client.listPending()).find((p) => p.approvalId === id);
      if (approval) {
        return { approval: { ...approval, source: surface.source }, client: surface.client };
      }
    } catch (error) {
      failures.push({ source: surface.source, error });
    }
  }
  // Not found in the queues that answered: if another could not be consulted,
  // the approval may live there, so say that instead of claiming it is absent.
  const first = failures[0];
  if (first) throw unavailableError(first);
  throw new Error(`No pending approval found: ${id}`);
}

function command(
  name: string,
  summary: string,
  usage: string,
  action: (inv: ParsedInvocation, set: SurfaceSet) => Promise<unknown>,
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
      let set: SurfaceSet = { surfaces: [], unavailable: [], incomplete: false };
      let exitCode = 0;
      try {
        set = await openSurfaces();
        const result = await action(inv, set);
        printResult(result, {
          json,
          human: () => {
            if (options.render) options.render(result);
            else printResult(result, { json: false });
          },
        });
        for (const failure of set.unavailable) {
          const code = printError(unavailableError(failure), { json });
          if (set.incomplete) exitCode ||= code;
        }
      } catch (error) {
        exitCode = printError(error, { json });
      } finally {
        try {
          await closeSurfaces(set.surfaces);
        } catch (error) {
          const cleanupExitCode = printError(error, { json });
          if (exitCode === 0) exitCode = cleanupExitCode;
        }
      }
      return exitCode;
    },
  };
}

/** Follow one queue until aborted; every record is attributed to its source. */
async function watchSurface(
  surface: Surface,
  signal: AbortSignal,
  json: boolean,
  multiple: boolean
): Promise<void> {
  const response = await EventsClient.openWatch(
    schemaRpcCaller({ streamReadable: surface.rpc.streamReadable.bind(surface.rpc) }),
    ["shell-approval:pending-changed", "shell-approval:resolved"],
    randomUUID(),
    { signal, bodyIdleTimeoutMs: null }
  );
  let acknowledged = false;
  for await (const record of readEventWatchRecords(response)) {
    if (signal.aborted) return;
    if (record.kind === "watching") {
      if (acknowledged) throw new Error("Approval watch sent more than one acknowledgement");
      acknowledged = true;
    } else if (!acknowledged) {
      throw new Error("Approval watch delivered data before its acknowledgement");
    }
    if (json) {
      console.log(JSON.stringify(multiple ? { source: surface.source, ...record } : record));
    } else if (record.kind === "watching") {
      console.error(`watching ${surface.source} approvals (Ctrl-C to stop)`);
    } else if (record.event === "shell-approval:pending-changed") {
      renderPending(
        (record.payload as EventPayloads["shell-approval:pending-changed"]).pending.map(
          (approval) => ({ ...approval, source: surface.source })
        )
      );
    } else if (record.event === "shell-approval:resolved") {
      const resolved = record.payload as EventPayloads["shell-approval:resolved"];
      console.log(`${surface.source}\t${resolved.approvalId}\tresolved\t${resolved.decision}`);
    }
  }
  if (!signal.aborted) throw new Error("Approval watch closed unexpectedly");
}

async function watch(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  const controller = new AbortController();
  let userStopped = false;
  const stop = () => {
    userStopped = true;
    controller.abort();
  };
  let surfaces: Surface[] = [];
  let exitCode = 0;
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    positionals(inv, 0, "watch");
    const opened = await openSurfaces();
    surfaces = opened.surfaces;
    // Each queue is followed independently: one failing (at open or mid-stream)
    // is reported against its source and does not end its peers. The watch ends
    // when every queue has, and exits non-zero if any of them failed.
    const report = (failure: SurfaceFailure) => {
      const code = printError(unavailableError(failure), { json });
      exitCode ||= code;
    };
    opened.unavailable.forEach(report);
    await Promise.all(
      surfaces.map((surface) =>
        watchSurface(surface, controller.signal, json, surfaces.length > 1).catch((error) => {
          if (!userStopped) report({ source: surface.source, error });
        })
      )
    );
  } catch (error) {
    if (!userStopped) exitCode = printError(error, { json });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    controller.abort();
    try {
      await closeSurfaces(surfaces);
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
    "List all visible pending hub and workspace approvals, labelled by source",
    "list",
    async (inv, set) => {
      positionals(inv, 0, "list");
      return listAll(set);
    },
    { render: (result) => renderPending(result as LabelledApproval[]) }
  ),
  command(
    "show",
    "Show the complete pending approval and its offered choices",
    "show ID",
    async (inv, set) => {
      positionals(inv, 1, "show ID");
      return (await pendingApproval(set, inv.positionals[0]!)).approval;
    }
  ),
  {
    group: "approvals",
    name: "watch",
    summary: "Stream the current hub and workspace approval queues, changes, and resolutions",
    usage: "vibestudio approvals watch [--json]",
    flags: [JSON_FLAG],
    run: watch,
  },
  command(
    "resolve",
    "Answer an approval with one of its offered decisions",
    "resolve ID DECISION",
    async (inv, set) => {
      positionals(inv, 2, "resolve ID DECISION");
      const [id, decision] = validate(shellApprovalMethods.resolve.args, inv.positionals);
      await (await pendingApproval(set, id)).client.resolve(id, decision);
      return { approvalId: id, decision };
    }
  ),
  command(
    "review",
    "Accept or cancel an install/update review with exact permission selections",
    "review ID [RESPONSE_JSON | --input]",
    async (inv, set) => {
      const resolution = validate(
        templateInstallResolutionSchema,
        await jsonInput(inv, "review ID [RESPONSE_JSON | --input]")
      );
      const { client } = await pendingApproval(set, inv.positionals[0]!);
      return client.resolveInstallReview(inv.positionals[0]!, resolution);
    },
    { input: true }
  ),
  command(
    "rules",
    "Accept selected chat permission rows or cancel the review",
    "rules ID [RESPONSE_JSON | --input]",
    async (inv, set) => {
      const response = await jsonInput(inv, "rules ID [RESPONSE_JSON | --input]");
      const [id, resolution] = validate(shellApprovalMethods.resolveTaskRules.args, [
        inv.positionals[0],
        response,
      ]);
      await (await pendingApproval(set, id)).client.resolveTaskRules(id, resolution);
      return { approvalId: id, decision: resolution.decision };
    },
    { input: true }
  ),
  command(
    "submit",
    "Submit fields for a secret, credential, or provider configuration prompt",
    "submit ID [VALUES_JSON | --input]",
    async (inv, set) => {
      const values = validate(
        shellApprovalValuesSchema,
        await jsonInput(inv, "submit ID [VALUES_JSON | --input]")
      );
      const id = inv.positionals[0]!;
      const { approval, client } = await pendingApproval(set, id);
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
