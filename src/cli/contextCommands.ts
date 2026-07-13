/**
 * `vibestudio context ...` — remote context mirrors (plan §6.5).
 *
 * `context mirror` materializes a context's repos into a local directory over
 * the host `mirror` service (read-side of the projector), drops the
 * `.vibestudio-context.json` marker so all CLI scoping (§6.2) then binds here
 * with zero flags, and — with `--watch` — records local edits as context edit
 * ops (`vcs.edit`) and polls for inbound state-hash changes to re-materialize.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { MirrorObjectsResult, MirrorTarget } from "@vibestudio/service-schemas/mirror";
import {
  JSON_FLAG,
  type CliCommand,
  type FlagSpec,
  type ParsedInvocation,
} from "./commandTable.js";
import { jsonMode, printError, printResult } from "./output.js";
import { resolveSessionScope, SCOPE_FLAGS, CONTEXT_MARKER_FILE } from "./agent/sessionContext.js";
import type { RpcClient } from "./rpcClient.js";

const WATCH_POLL_MS = 4000;

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
    let total = 0;
    for (const target of targets) {
      total += await writeState(client, target.stateHash, path.join(dir, target.repoPath));
    }
    await writeMarker(client, dir, contextId, session.serverUrl);

    const result = { contextId, dir, repos: targets.length, files: total };
    if (inv.flags["watch"] === true) {
      if (!json) {
        console.log(`mirrored ${total} file(s) across ${targets.length} repo(s) into ${dir}`);
        console.log("watching for local edits and inbound changes (Ctrl-C to stop)…");
      }
      await watch(client, contextId, dir, targets);
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
 * v1 watch: local edits → `vcs.edit` ops; inbound state-hash changes → re-write.
 * Conflicts surface via the context's normal edit/commit semantics (the mirror
 * adds no merge model). Inbound polling is a simple interval over `mirror.targets`.
 */
async function watch(
  client: RpcClient,
  contextId: string,
  dir: string,
  initialTargets: MirrorTarget[]
): Promise<void> {
  const head = `ctx:${contextId}`;
  const repoPaths = initialTargets.map((t) => t.repoPath).sort((a, b) => b.length - a.length);
  const lastState = new Map(initialTargets.map((t) => [t.repoPath, t.stateHash]));
  // Paths we just wrote from inbound updates — skip the echo edit they trigger.
  const suppress = new Set<string>();

  /** Map an absolute local path to its (repoPath, inner path), or null. */
  const locate = (abs: string): { repoPath: string; inner: string } | null => {
    const rel = path.relative(dir, abs).split(path.sep).join("/");
    if (!rel || rel.startsWith("..") || rel === CONTEXT_MARKER_FILE) return null;
    for (const repoPath of repoPaths) {
      if (rel === repoPath) continue;
      if (rel.startsWith(`${repoPath}/`)) {
        return { repoPath, inner: rel.slice(repoPath.length + 1) };
      }
    }
    return null;
  };

  const pending = new Map<string, NodeJS.Timeout>();
  const recordEdit = (abs: string): void => {
    const located = locate(abs);
    if (!located) return;
    if (suppress.delete(abs)) return; // inbound write — don't echo it back
    const existing = pending.get(abs);
    if (existing) clearTimeout(existing);
    pending.set(
      abs,
      setTimeout(() => {
        pending.delete(abs);
        void applyEdit(abs, located).catch((error) => {
          console.error(`watch: edit of ${located.inner} failed: ${String(error)}`);
        });
      }, 200)
    );
  };

  const applyEdit = async (abs: string, located: { repoPath: string; inner: string }) => {
    let edit: { kind: string; path: string; content?: string };
    if (fs.existsSync(abs)) {
      const content = await fsp.readFile(abs, "utf8");
      edit = { kind: "write", path: located.inner, content };
    } else {
      edit = { kind: "delete", path: located.inner };
    }
    await client.call("vcs.edit", [{ edits: [edit], head, repoPath: located.repoPath }]);
  };

  const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    recordEdit(path.join(dir, filename.toString()));
  });

  // Inbound poll: re-materialize any repo whose state hash advanced upstream.
  const poll = setInterval(() => {
    void (async () => {
      const targets = await client
        .call<MirrorTarget[]>("mirror.targets", [{ contextId }])
        .catch((error: unknown) => {
          console.error(
            `watch: failed to check inbound updates; will retry: ${error instanceof Error ? error.message : String(error)}`
          );
          return null;
        });
      if (!targets) return;
      for (const target of targets) {
        if (lastState.get(target.repoPath) === target.stateHash) continue;
        try {
          await writeState(client, target.stateHash, path.join(dir, target.repoPath), (abs) =>
            suppress.add(abs)
          );
          lastState.set(target.repoPath, target.stateHash);
        } catch (error) {
          console.error(
            `watch: failed to apply inbound update for ${target.repoPath}; will retry: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    })();
  }, WATCH_POLL_MS);

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  watcher.close();
  clearInterval(poll);
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
