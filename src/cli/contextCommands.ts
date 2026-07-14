/**
 * `vibestudio context ...` — remote context mirrors (plan §6.5).
 *
 * `context mirror` materializes a context's repos into a local directory over
 * the host `mirror` service (read-side of the projector), drops the
 * `.vibestudio-context.json` marker so all CLI scoping (§6.2) then binds here
 * with zero flags, and — with `--watch` — records local edits as context edit
 * ops (`vcs.edit`) and polls for inbound state-hash changes to re-materialize.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { MirrorObjectsResult, MirrorTarget } from "@vibestudio/service-schemas/mirror";
import type { VcsEditResult } from "@vibestudio/service-schemas/vcs";
import {
  ContextWorkspaceSession,
  type CanonicalWorkspaceFile,
  type ContextWorkspaceAdapters,
} from "@vibestudio/context-workspace";
import {
  JSON_FLAG,
  type CliCommand,
  type FlagSpec,
  type ParsedInvocation,
} from "./commandTable.js";
import { jsonMode, printError, printResult } from "./output.js";
import { resolveSessionScope, SCOPE_FLAGS, CONTEXT_MARKER_FILE } from "./agent/sessionContext.js";
import type { RpcClient } from "@vibestudio/direct-client";

/** Read one exact repository state into the shared synchronizer's binary-safe model. */
export async function readCanonicalState(
  client: RpcClient,
  stateHash: string
): Promise<CanonicalWorkspaceFile[]> {
  let cursor: string | undefined;
  const files: CanonicalWorkspaceFile[] = [];
  do {
    const page = await client.call<MirrorObjectsResult>("mirror.objects", [
      { stateHash, ...(cursor ? { cursor } : {}) },
    ]);
    for (const file of page.files) {
      if (file.mode !== 33188 && file.mode !== 33261) {
        throw new Error(`mirror returned unsupported file mode ${file.mode} for ${file.path}`);
      }
      files.push({
        path: file.path,
        bytes: Buffer.from(file.content, "base64"),
        mode: file.mode === 33261 ? 0o755 : 0o644,
      });
    }
    cursor = page.next;
  } while (cursor);
  return files;
}

export function createContextWorkspaceAdapters(
  client: RpcClient,
  contextId: string
): ContextWorkspaceAdapters {
  return {
    readState: async (_repoPath, stateHash) => readCanonicalState(client, stateHash),
    edit: async ({ repoPath, baseStateHash, clientEditId, edits }) => {
      const result = await client.call<VcsEditResult>("vcs.edit", [
        {
          head: `ctx:${contextId}`,
          repoPath,
          baseStateHash,
          clientEditId,
          edits: edits.map((edit) =>
            edit.kind === "delete"
              ? edit
              : {
                  kind: "write",
                  path: edit.path,
                  content: { kind: "bytes", base64: Buffer.from(edit.bytes).toString("base64") },
                  mode: edit.mode === 0o755 ? 33261 : 33188,
                }
          ),
        },
      ]);
      if (!result.stateHash) throw new Error("vcs.edit did not return a repository state hash");
      return { stateHash: result.stateHash };
    },
  };
}

/** Fetch every page of a state's tree and write each file under `destRepoDir`.
 *  Exported for unit testing the mirror write path against a mock client. */
export async function writeState(
  client: RpcClient,
  stateHash: string,
  destRepoDir: string,
  onWrite?: (absPath: string) => void
): Promise<number> {
  const files = await readCanonicalState(client, stateHash);
  for (const file of files) {
    const abs = path.join(destRepoDir, file.path);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, file.bytes, { mode: file.mode });
    await fsp.chmod(abs, file.mode);
    onWrite?.(abs);
  }
  return files.length;
}

/** Exported for unit testing the marker write. */
export async function writeMarker(
  client: RpcClient,
  dir: string,
  contextId: string,
  serverUrl: string
): Promise<void> {
  let workspaceId: string | undefined;
  try {
    const info = await client.call<Record<string, unknown>>("auth.getConnectionInfo", []);
    if (typeof info["workspaceId"] === "string") workspaceId = info["workspaceId"];
  } catch {
    // best effort — the marker is still useful without a workspaceId
  }
  const marker = { contextId, ...(workspaceId ? { workspaceId } : {}), serverUrl };
  await fsp.writeFile(path.join(dir, CONTEXT_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
}

async function mirror(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const { client, contextId: scopeContext, session } = resolveSessionScope(inv);
    const contextId = inv.positionals[0] ?? scopeContext;
    const dir = path.resolve(inv.positionals[1] ?? contextId);
    await fsp.mkdir(dir, { recursive: true });

    const targets = await client.call<MirrorTarget[]>("mirror.targets", [{ contextId }]);
    const adapters = createContextWorkspaceAdapters(client, contextId);
    const workspace = await ContextWorkspaceSession.open({ root: dir, targets, adapters });
    const total = Object.values(workspace.statuses()).reduce(
      (sum, status) => sum + status.fileCount,
      0
    );
    await writeMarker(client, dir, contextId, session.serverUrl);

    const result = { contextId, dir, repos: targets.length, files: total };
    if (inv.flags["watch"] === true) {
      if (!json) {
        console.log(`mirrored ${total} file(s) across ${targets.length} repo(s) into ${dir}`);
        console.log("watching for local edits and inbound changes (Ctrl-C to stop)…");
      }
      await watch(client, contextId, workspace);
      return 0;
    }
    printResult(result, {
      json,
      human: () =>
        console.log(
          `mirrored ${total} file(s) across ${targets.length} repo(s) into ${dir}\n` +
            `marker: ${path.join(dir, CONTEXT_MARKER_FILE)}`
        ),
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

/**
 * Poll the shared durable synchronizers. Local batches are journaled before
 * RPC, while inbound states use their attached-safe per-file generation path.
 */
async function watch(
  client: RpcClient,
  contextId: string,
  workspace: ContextWorkspaceSession
): Promise<void> {
  workspace.start({
    readTargets: () => client.call<MirrorTarget[]>("mirror.targets", [{ contextId }]),
    onError: (message, error) =>
      console.error(
        `watch: ${message}; will retry: ${error instanceof Error ? error.message : String(error)}`
      ),
  });

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  await workspace.stop();
  await client.close();
}

const WATCH_FLAG: FlagSpec = {
  name: "watch",
  takesValue: false,
  description: "Record local edits as context edit ops and apply inbound changes",
};

export const contextCommands: CliCommand[] = [
  {
    group: "context",
    name: "mirror",
    summary: "Materialize a context's repos into a local directory (optionally --watch)",
    usage: "vibestudio context mirror [<contextId>] [dir] [--watch]",
    flags: [WATCH_FLAG, ...SCOPE_FLAGS, JSON_FLAG],
    run: mirror,
  },
];
