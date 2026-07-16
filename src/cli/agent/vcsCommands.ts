/** Small semantic VCS CLI over the canonical public contract. */

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  vcsMethods,
  type VcsCommitInput,
  type VcsCopyInput,
  type VcsMoveInput,
  type VcsStateNodeRef,
} from "@vibestudio/service-schemas/vcs";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import {
  JSON_FLAG,
  type CliCommand,
  type FlagSpec,
  type ParsedInvocation,
} from "../commandTable.js";
import { jsonMode, printError, printResult, UsageError } from "../output.js";
import { resolveSessionScope, SCOPE_FLAGS } from "./sessionContext.js";
import type { RpcClient } from "../rpcClient.js";
import { vcsGitCommand } from "./vcsGitCommands.js";
import {
  loadVcsCommandJournalEntry,
  saveVcsCommandJournalEntry,
  type FriendlyVcsMutationMethod,
} from "./vcsCommandJournal.js";

type CliVcs = TypedServiceClient<typeof vcsMethods>;

const INPUT_FLAG: FlagSpec = {
  name: "input",
  takesValue: true,
  description: "Canonical JSON input object; omit to read JSON from stdin",
};
const MESSAGE_FLAG: FlagSpec = {
  name: "message",
  short: "m",
  takesValue: true,
  description: "Commit message",
};
const INTEGRATES_FLAG: FlagSpec = {
  name: "integrates",
  takesValue: true,
  description: "Exact fully-accounted source event to add as integration parent",
};
const COMMAND_ID_FLAG: FlagSpec = {
  name: "command-id",
  takesValue: true,
  description: "Stable retry identity (generated and printed when omitted)",
};
const VIEW_FLAG: FlagSpec = {
  name: "view",
  takesValue: true,
  description: "overview | changes",
};
const LIMIT_FLAG: FlagSpec = {
  name: "limit",
  takesValue: true,
  description: "Maximum page size",
};
const DRY_RUN_FLAG: FlagSpec = {
  name: "dry-run",
  takesValue: false,
  description: "Resolve and print exact state/file identities without mutating",
};

interface FriendlyTransfer {
  source: string;
  destination: string;
}

interface FriendlyTransferBatch {
  transfers: FriendlyTransfer[];
  intentSummary?: string;
}

function clientFor(client: RpcClient): CliVcs {
  return createTypedServiceClient("vcs", vcsMethods, (_service, method, args) =>
    client.call(`vcs.${method}`, args)
  );
}

function commandId(inv: ParsedInvocation): string {
  return typeof inv.flags["command-id"] === "string"
    ? inv.flags["command-id"]
    : `cli:${randomUUID()}`;
}

function mutationCommandId(inv: ParsedInvocation): string {
  const explicit = inv.flags["command-id"];
  if (typeof explicit === "string") return explicit;
  const generated = `cli:${randomUUID()}`;
  console.error(`[vibestudio] command-id: ${generated}`);
  return generated;
}

function pageLimit(inv: ParsedInvocation, fallback = 50): number {
  const value = typeof inv.flags["limit"] === "string" ? Number(inv.flags["limit"]) : fallback;
  if (!Number.isInteger(value) || value <= 0 || value > 500) {
    throw new UsageError("--limit must be an integer between 1 and 500");
  }
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function jsonInput(inv: ParsedInvocation): Promise<unknown> {
  const raw =
    typeof inv.flags["input"] === "string" ? inv.flags["input"] : (await readStdin()).trim();
  if (!raw) throw new UsageError("pass --input '<canonical JSON object>' or pipe JSON on stdin");
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("input must be an object");
    }
    return value;
  } catch (error) {
    throw new UsageError(`invalid JSON input: ${String(error)}`);
  }
}

function output(inv: ParsedInvocation, result: unknown): void {
  printResult(result, {
    json: jsonMode(inv.flags["json"] === true),
    human: () => console.log(JSON.stringify(result, null, 2)),
  });
}

async function run(
  inv: ParsedInvocation,
  operation: (vcs: CliVcs, contextId: string, serverUrl: string) => Promise<unknown>
) {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const { client, contextId, session } = resolveSessionScope(inv);
    output(inv, await operation(clientFor(client), contextId, session.serverUrl));
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function runRetriableMutation(
  inv: ParsedInvocation,
  vcs: CliVcs,
  target: { serverUrl: string; contextId: string },
  method: FriendlyVcsMutationMethod,
  intent: unknown,
  buildInput: (commandId: string) => Promise<Record<string, unknown>>
): Promise<unknown> {
  const id = mutationCommandId(inv);
  const journalTarget = { ...target, commandId: id };
  const existing = loadVcsCommandJournalEntry(journalTarget);
  if (existing) {
    if (existing.method !== method || !isDeepStrictEqual(existing.intent, intent)) {
      throw new UsageError(
        `--command-id ${id} already identifies a different ${existing.method} request`
      );
    }
    const member = vcs[method] as unknown as (input: Record<string, unknown>) => Promise<unknown>;
    return member(existing.input);
  }
  const input = await buildInput(id);
  saveVcsCommandJournalEntry({
    schemaVersion: 1,
    ...journalTarget,
    method,
    intent,
    input,
    createdAt: Date.now(),
  });
  const member = vcs[method] as unknown as (input: Record<string, unknown>) => Promise<unknown>;
  return member(input);
}

async function repositoryAt(vcs: CliVcs, state: VcsStateNodeRef, repoPath: string) {
  const repository = await vcs.resolveRepository({ state, repoPath });
  if (repository) return repository;
  throw new UsageError(`repository ${repoPath} is not present at the requested state`);
}

function splitFile(path: string) {
  const split = splitRepoPath(path.replace(/^\/+/, ""));
  if (!split?.repoRelPath) throw new UsageError(`${path} must name a workspace repository file`);
  return split;
}

async function resolveExactFile(vcs: CliVcs, state: VcsStateNodeRef, workspacePath: string) {
  const split = splitFile(workspacePath);
  const repository = await repositoryAt(vcs, state, split.repoPath);
  return vcs.readFile({
    state,
    repositoryId: repository.repositoryId,
    file: { kind: "path", path: split.repoRelPath },
  });
}

const status = (inv: ParsedInvocation) => run(inv, (vcs, contextId) => vcs.status({ contextId }));

const compare = (inv: ParsedInvocation) =>
  run(inv, async (vcs, contextId) => {
    const current = await vcs.status({ contextId });
    const view = String(inv.flags["view"] ?? "overview");
    if (view !== "overview" && view !== "changes") {
      throw new UsageError("--view must be overview or changes");
    }
    return vcs.compare({
      target: current.workingHead,
      sourceEventId: inv.positionals[0] ?? current.mainEventId,
      view,
      limit: pageLimit(inv),
    });
  });

const history = (inv: ParsedInvocation) =>
  run(inv, async (vcs, contextId) => {
    const current = await vcs.status({ contextId });
    return vcs.history({ root: current.committed, direction: "past", limit: pageLimit(inv) });
  });

const resolveFile = (inv: ParsedInvocation) =>
  run(inv, async (vcs, contextId) => {
    const path = inv.positionals[0];
    if (!path) throw new UsageError("usage: vibestudio vcs resolve-file PATH");
    const current = await vcs.status({ contextId });
    return resolveExactFile(vcs, current.workingHead, path);
  });

async function transfer(inv: ParsedInvocation, kind: "move" | "copy") {
  return run(inv, async (vcs, contextId, serverUrl) => {
    const batch = await friendlyTransferBatch(inv, kind);
    const resolve = async () => {
      const current = await vcs.status({ contextId });
      const workingHead = current.workingHead;
      const resolved = await Promise.all(
        batch.transfers.map(async ({ source: sourcePath, destination: destinationPath }) => {
          const source = await resolveExactFile(vcs, workingHead, sourcePath);
          if (!source?.repositoryId || !source.fileId) {
            throw new UsageError(`${sourcePath} is not present at the working state`);
          }
          const destinationSplit = splitFile(destinationPath);
          const destinationRepository = await repositoryAt(
            vcs,
            workingHead,
            destinationSplit.repoPath
          );
          return {
            sourcePath,
            destinationPath,
            source: {
              ...source,
              repositoryId: source.repositoryId,
              fileId: source.fileId,
            },
            destination: {
              repositoryId: destinationRepository.repositoryId,
              path: destinationSplit.repoRelPath,
            },
          };
        })
      );
      const onlyTransfer = resolved.length === 1 ? resolved[0] : undefined;
      const intentSummary =
        batch.intentSummary ??
        (onlyTransfer
          ? `${kind === "move" ? "Move" : "Copy"} ${onlyTransfer.sourcePath} to ${onlyTransfer.destinationPath}`
          : `${kind === "move" ? "Move" : "Copy"} ${resolved.length} files atomically`);
      return { workingHead, resolved, intentSummary };
    };
    if (inv.flags["dry-run"] === true) {
      const { workingHead, resolved } = await resolve();
      return {
        dryRun: true,
        operation: kind,
        commandId: commandId(inv),
        contextId,
        expectedWorkingHead: workingHead,
        transfers: resolved,
      };
    }
    return runRetriableMutation(inv, vcs, { contextId, serverUrl }, kind, batch, async (id) => {
      const { workingHead, resolved, intentSummary } = await resolve();
      if (kind === "move") {
        const input: VcsMoveInput = {
          contextId,
          expectedWorkingHead: workingHead,
          commandId: id,
          intentSummary,
          moves: resolved.map(({ source, destination }) => ({
            kind: "file",
            repositoryId: source.repositoryId,
            fileId: source.fileId,
            destinationRepositoryId: destination.repositoryId,
            destinationPath: destination.path,
          })),
        };
        return input;
      }
      const input: VcsCopyInput = {
        contextId,
        expectedWorkingHead: workingHead,
        commandId: id,
        intentSummary,
        copies: resolved.map(({ source, destination }) => ({
          source: {
            state: workingHead,
            repositoryId: source.repositoryId,
            fileId: source.fileId,
          },
          destination,
        })),
      };
      return input;
    });
  });
}

async function friendlyTransferBatch(
  inv: ParsedInvocation,
  kind: "move" | "copy"
): Promise<FriendlyTransferBatch> {
  if (inv.positionals.length > 0) {
    if (typeof inv.flags["input"] === "string") {
      throw new UsageError("choose positional SOURCE/DESTINATION pairs or --input, not both");
    }
    if (inv.positionals.length % 2 !== 0) {
      throw new UsageError(
        `usage: vibestudio vcs ${kind}-file SOURCE DESTINATION [SOURCE DESTINATION ...]`
      );
    }
    const transfers: FriendlyTransfer[] = [];
    for (let index = 0; index < inv.positionals.length; index += 2) {
      const source = inv.positionals[index];
      const destination = inv.positionals[index + 1];
      if (!source || !destination) {
        throw new UsageError(
          `usage: vibestudio vcs ${kind}-file SOURCE DESTINATION [SOURCE DESTINATION ...]`
        );
      }
      transfers.push({
        source,
        destination,
      });
    }
    return { transfers };
  }

  const record = (await jsonInput(inv)) as Record<string, unknown>;
  const unknownTopLevel = Object.keys(record).filter(
    (key) => key !== "transfers" && key !== "intentSummary"
  );
  if (unknownTopLevel.length > 0) {
    throw new UsageError(`unknown batch input field(s): ${unknownTopLevel.join(", ")}`);
  }
  if (!Array.isArray(record["transfers"]) || record["transfers"].length === 0) {
    throw new UsageError(
      `batch input for ${kind}-file requires {"transfers":[{"source":"...","destination":"..."}]}`
    );
  }
  const transfers = record["transfers"].map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new UsageError(`transfers[${index}] must be an object`);
    }
    const candidate = entry as Record<string, unknown>;
    const unknown = Object.keys(candidate).filter(
      (key) => key !== "source" && key !== "destination"
    );
    if (unknown.length > 0) {
      throw new UsageError(`transfers[${index}] has unknown field(s): ${unknown.join(", ")}`);
    }
    if (typeof candidate["source"] !== "string" || typeof candidate["destination"] !== "string") {
      throw new UsageError(`transfers[${index}] requires string source and destination paths`);
    }
    return { source: candidate["source"], destination: candidate["destination"] };
  });
  if (record["intentSummary"] !== undefined && typeof record["intentSummary"] !== "string") {
    throw new UsageError("intentSummary must be a string");
  }
  const intentSummary =
    typeof record["intentSummary"] === "string" ? record["intentSummary"].trim() : undefined;
  if (intentSummary === "") throw new UsageError("intentSummary must not be empty");
  return { transfers, ...(intentSummary ? { intentSummary } : {}) };
}

const commit = (inv: ParsedInvocation) =>
  run(inv, async (vcs, contextId, serverUrl) => {
    const message = typeof inv.flags["message"] === "string" ? inv.flags["message"].trim() : "";
    if (!message) throw new UsageError("commit requires -m MESSAGE");
    const integratesEventId =
      typeof inv.flags["integrates"] === "string" ? inv.flags["integrates"] : null;
    return runRetriableMutation(
      inv,
      vcs,
      { contextId, serverUrl },
      "commit",
      { message, integratesEventId },
      async (id) => {
        const current = await vcs.status({ contextId });
        const input: VcsCommitInput = {
          contextId,
          expectedWorkingHead: current.workingHead,
          message,
          commandId: id,
          ...(integratesEventId ? { integratesEventId } : {}),
        };
        return input;
      }
    );
  });

const discard = (inv: ParsedInvocation) =>
  run(inv, (vcs, contextId, serverUrl) =>
    runRetriableMutation(inv, vcs, { contextId, serverUrl }, "discard", {}, async (id) => {
      const current = await vcs.status({ contextId });
      return { contextId, expectedWorkingHead: current.workingHead, commandId: id };
    })
  );

const push = (inv: ParsedInvocation) =>
  run(inv, (vcs, contextId, serverUrl) =>
    runRetriableMutation(inv, vcs, { contextId, serverUrl }, "push", {}, async (id) => {
      const current = await vcs.status({ contextId });
      if (current.committed.kind !== "event") throw new Error("committed state is not an event");
      return {
        contextId,
        expectedCommittedEventId: current.committed.eventId,
        expectedMainEventId: current.mainEventId,
        commandId: id,
      };
    })
  );

function jsonMethod(method: keyof CliVcs) {
  return (inv: ParsedInvocation) =>
    run(inv, async (vcs) => {
      const member = vcs[method] as (value: unknown) => Promise<unknown>;
      return member(await jsonInput(inv));
    });
}

const common = [...SCOPE_FLAGS, JSON_FLAG];
const inputFlags = [INPUT_FLAG, ...common];
const commandFlags = [COMMAND_ID_FLAG, ...common];
const transferFlags = [INPUT_FLAG, DRY_RUN_FLAG, ...commandFlags];

export const vcsCommands: CliCommand[] = [
  vcsGitCommand,
  {
    group: "vcs",
    name: "status",
    summary: "Inspect committed and working state",
    flags: common,
    run: status,
  },
  {
    group: "vcs",
    name: "compare",
    summary: "Compare the working state with a source event (main by default)",
    usage: "vibestudio vcs compare [SOURCE_EVENT_ID]",
    flags: [VIEW_FLAG, LIMIT_FLAG, ...common],
    run: compare,
  },
  {
    group: "vcs",
    name: "history",
    summary: "Page committed semantic history",
    flags: [LIMIT_FLAG, ...common],
    run: history,
  },
  {
    group: "vcs",
    name: "resolve-file",
    summary: "Resolve PATH to stable repository/file identity",
    usage: "vibestudio vcs resolve-file PATH",
    flags: common,
    run: resolveFile,
  },
  {
    group: "vcs",
    name: "move-file",
    summary: "Move one stable file identity atomically",
    usage: "vibestudio vcs move-file SOURCE DESTINATION [SOURCE DESTINATION ...] [--dry-run]",
    flags: transferFlags,
    run: (inv) => transfer(inv, "move"),
  },
  {
    group: "vcs",
    name: "copy-file",
    summary: "Copy a file with explicit immediate provenance",
    usage: "vibestudio vcs copy-file SOURCE DESTINATION [SOURCE DESTINATION ...] [--dry-run]",
    flags: transferFlags,
    run: (inv) => transfer(inv, "copy"),
  },
  {
    group: "vcs",
    name: "commit",
    summary: "Commit the complete local application chain",
    usage: "vibestudio vcs commit -m MESSAGE [--integrates SOURCE_EVENT_ID]",
    flags: [MESSAGE_FLAG, INTEGRATES_FLAG, ...commandFlags],
    run: commit,
  },
  {
    group: "vcs",
    name: "discard",
    summary: "Discard the complete local application chain",
    flags: commandFlags,
    run: discard,
  },
  {
    group: "vcs",
    name: "push",
    summary: "Publish the exact committed event to protected main",
    flags: commandFlags,
    run: push,
  },
  ...(
    [
      ["edit", "Submit an identity-checked edit transaction"],
      ["integrate", "Take one local integration decision"],
      ["revert", "Counteract exact semantic changes"],
      ["importSnapshot", "Import an exact external snapshot"],
      ["inspect", "Inspect one typed semantic node"],
      ["neighbors", "Page adjacent provenance edges"],
      ["blame", "Trace content coordinates through provenance"],
      ["readFile", "Read file content from an exact semantic state"],
      ["listFiles", "Page files in one repository state"],
    ] as const
  ).map(([method, summary]) => ({
    group: "vcs",
    name: method.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
    summary,
    flags: inputFlags,
    run: jsonMethod(method),
  })),
];
