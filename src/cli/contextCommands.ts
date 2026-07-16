/**
 * `vibestudio context ...` — remote context mirrors (plan §6.5).
 *
 * `context mirror` materializes a context's repos into a local directory over
 * the host `mirror` service (read-side of the projector), then drops the
 * `.vibestudio-context.json` binding so subsequent CLI commands bind to that
 * context with zero flags. The mirror is a snapshot export, not a second
 * working tree or a filesystem-to-semantics reconstruction loop.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  CONTEXT_BINDING_FILE,
  contextBinding,
  encodeContextBinding,
} from "@vibestudio/shared/contextBinding";
import type { MirrorObjectsResult, MirrorTarget } from "@vibestudio/service-schemas/mirror";
import { writeFileAtomicSync } from "../atomicFile.js";
import { JSON_FLAG, type CliCommand, type ParsedInvocation } from "./commandTable.js";
import { jsonMode, printError, printResult } from "./output.js";
import { resolveSessionScope, SCOPE_FLAGS } from "./agent/sessionContext.js";
import type { RpcClient } from "./rpcClient.js";

/** Fetch every page of a state's tree and write each file under `destRepoDir`.
 *  Exported for unit testing the mirror write path against a mock client. */
export async function writeState(
  client: RpcClient,
  stateHash: string,
  destRepoDir: string,
  onWrite?: (absPath: string) => void
): Promise<number> {
  let cursor: string | undefined;
  let written = 0;
  do {
    const page = await client.call<MirrorObjectsResult>("mirror.objects", [
      { stateHash, ...(cursor ? { cursor } : {}) },
    ]);
    for (const file of page.files) {
      const abs = path.join(destRepoDir, file.path);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const mode = file.mode === 33261 ? 0o755 : 0o644;
      await fsp.writeFile(abs, Buffer.from(file.content, "base64"), { mode });
      onWrite?.(abs);
      written += 1;
    }
    cursor = page.next;
  } while (cursor);
  return written;
}

/** Write the exact durable identity binding for a mirror. */
export async function writeContextBinding(
  client: RpcClient,
  dir: string,
  contextId: string
): Promise<void> {
  const info = await client.call<Record<string, unknown>>("auth.getConnectionInfo", []);
  const workspaceId = info["workspaceId"];
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("workspace connection did not report a durable workspaceId");
  }
  writeFileAtomicSync(
    path.join(dir, CONTEXT_BINDING_FILE),
    encodeContextBinding(contextBinding({ workspaceId, contextId })),
    { mode: 0o644 }
  );
}

async function mirror(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const { client, contextId: scopeContext } = resolveSessionScope(inv);
    const contextId = inv.positionals[0] ?? scopeContext;
    const dir = path.resolve(inv.positionals[1] ?? contextId);
    await fsp.mkdir(dir, { recursive: true });

    const targets = await client.call<MirrorTarget[]>("mirror.targets", [{ contextId }]);
    let total = 0;
    for (const target of targets) {
      total += await writeState(client, target.stateHash, path.join(dir, target.repoPath));
    }
    await writeContextBinding(client, dir, contextId);

    const result = { contextId, dir, repos: targets.length, files: total };
    printResult(result, {
      json,
      human: () =>
        console.log(
          `mirrored ${total} file(s) across ${targets.length} repo(s) into ${dir}\n` +
            `binding: ${path.join(dir, CONTEXT_BINDING_FILE)}`
        ),
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

export const contextCommands: CliCommand[] = [
  {
    group: "context",
    name: "mirror",
    summary: "Export a context snapshot into a local directory",
    usage: "vibestudio context mirror [<contextId>] [dir]",
    flags: [...SCOPE_FLAGS, JSON_FLAG],
    run: mirror,
  },
];
