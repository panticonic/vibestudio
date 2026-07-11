/**
 * git-bridge extension — the platform's git interchange venue (eviction stage
 * P5c part 2). Hosts the {@link GitBridge} core in a trusted Node extension
 * process and adapts it onto the platform primitives:
 *
 *  - the userland `vcs` service (gad-store DO, protocol vibestudio.vcs.v1),
 *    resolved through `ctx.workers.resolveService` and called over unified RPC
 *  - the host `blobstore.*` content-store RPC (blob bytes + immutable trees)
 *  - the host `refs.*` protected-ref reads
 *  - the userland `vcs.vcsImportPublish` gated single-writer import publish
 *  - raw Node disk access for the git checkouts under `workspace/<repoPath>`
 *  - extension storage for bridge-private markers/checkout maps
 *
 * Host consumers reach it through the manifest-declared `providers.gitInterop`
 * slot and the `gitInterop.*` service; userland consumers can still call the
 * installed extension API directly when they intentionally depend on it.
 */

import { GitBridge, type BridgeHost } from "./bridge.js";
import {
  UpstreamEngine,
  type PublishRepoInput,
  type UpstreamStatusOptions,
} from "./upstream.js";
import type { ExtensionContextLike } from "./context.js";

interface ResolvedServiceLike {
  kind?: string;
  targetId?: string;
}

const VCS_SERVICE_PROTOCOL = "vibestudio.vcs.v1";
const STATE_DIR = "state";

function createBridgeHost(ctx: ExtensionContextLike): BridgeHost {
  // The gad-store DO target behind the userland `vcs` service — resolved
  // lazily (workerd may still be warming at activate) and re-resolved after a
  // failure rather than pinning a rejection forever.
  let vcsTarget: Promise<string> | null = null;
  const vcsTargetId = (): Promise<string> => {
    vcsTarget ??= ctx.workers.resolveService(VCS_SERVICE_PROTOCOL).then((resolved) => {
      const service = resolved as ResolvedServiceLike;
      if (service?.kind !== "durable-object" || !service.targetId) {
        throw new Error(`Service '${VCS_SERVICE_PROTOCOL}' did not resolve to a Durable Object`);
      }
      return service.targetId;
    });
    vcsTarget.catch(() => {
      vcsTarget = null;
    });
    return vcsTarget;
  };
  const vcsCall = async <T>(method: string, ...args: unknown[]): Promise<T> =>
    ctx.rpc.call<T>(await vcsTargetId(), method, ...args);
  const main = <T>(method: string, ...args: unknown[]): Promise<T> =>
    ctx.rpc.call<T>("main", method, ...args);

  // Bridge-private durable state (markers + checkout maps) in extension
  // storage, one file per key. Serialized by the bridge's per-repo lock.
  let stateDirReady: Promise<unknown> | null = null;
  const ensureStateDir = (): Promise<unknown> =>
    (stateDirReady ??= ctx.storage.mkdir(STATE_DIR, { recursive: true }));
  const stateFile = (key: string): string => `${STATE_DIR}/${encodeURIComponent(key)}.json`;

  return {
    workspaceRoot: async () => (await ctx.workspace.getInfo()).path,
    store: {
      vcsLog: (repoPath, limit, head) => vcsCall("vcsLog", repoPath, limit, head),
      ingestWorktreeState: (input) => vcsCall("ingestWorktreeState", input),
      importPublish: (input) => vcsCall("vcsImportPublish", input),
    },
    blobstore: {
      has: (digest) => main("blobstore.has", digest),
      putBase64: (bytesBase64) => main("blobstore.putBase64", bytesBase64),
      getBase64: (digest) => main("blobstore.getBase64", digest),
      putTree: (entries, opts) => main("blobstore.putTree", entries, opts),
      getTree: (ref) => main("blobstore.getTree", ref),
      listTree: (ref, opts) => main("blobstore.listTree", ref, opts),
    },
    refs: {
      readMain: (repoPath) => main("refs.readMain", repoPath),
    },
    state: {
      async get(key) {
        try {
          const raw = await ctx.storage.readFile(stateFile(key), "utf8");
          return typeof raw === "string" ? raw : raw.toString("utf8");
        } catch {
          return null;
        }
      },
      async set(key, value) {
        await ensureStateDir();
        await ctx.storage.writeFile(stateFile(key), value);
      },
    },
  };
}

/** Public API surface of this extension — the awaited return of {@link activate}. */
export type Api = Awaited<ReturnType<typeof activate>>;
// Intentionally NOT registered in the WorkspaceExtensions type registry:
// git-bridge is host/agent infrastructure, not a panel-facing client library.

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("git-bridge activating");
  const bridge = new GitBridge(createBridgeHost(ctx));
  const upstream = new UpstreamEngine(ctx, bridge);
  await upstream.activate();
  return {
    /**
     * Import a repo's current git checkout tree (`workspace/<repoPath>`) as a
     * snapshot transition on a non-main staging head, then publish it onto the
     * protected `main` through the gated single-writer import path. No-ops when
     * the tree already matches `main`.
     */
    importRepoTree(repoPath: string, opts?: { summary?: string }) {
      return bridge.importRepoTree(repoPath, opts);
    },
    /**
     * Export a repo's `main` transition history into its git checkout
     * (`workspace/<repoPath>`) as commits carrying GAD-Repo/GAD-State/
     * GAD-Event trailers. Incremental and idempotent.
     */
    exportRepoHead(repoPath: string, opts?: { authorName?: string; authorEmail?: string }) {
      return bridge.exportRepoHead(repoPath, opts);
    },
    onMainAdvanced(repoPaths: string[]) {
      upstream.onMainAdvanced(repoPaths);
      return { queued: repoPaths.length };
    },
    upstreamStatus(repoPaths?: string | string[], opts: UpstreamStatusOptions = {}) {
      return upstream.upstreamStatus(
        typeof repoPaths === "string" ? [repoPaths] : repoPaths,
        opts
      );
    },
    pushUpstream(repoPath: string, opts?: { force?: boolean }) {
      return upstream.pushUpstream(repoPath, opts);
    },
    pullUpstream(repoPath: string, opts?: { dryRun?: boolean }) {
      return upstream.pullUpstream(repoPath, opts);
    },
    publishRepo(
      input:
        | string
        | PublishRepoInput,
      opts: Omit<PublishRepoInput, "repoPath"> = {}
    ) {
      return typeof input === "string"
        ? upstream.publishRepo({ repoPath: input, ...opts })
        : upstream.publishRepo({ ...input, ...opts });
    },
    cloneRepo(input: { repoPath: string }) {
      return upstream.cloneRepo(input);
    },
    importRepo(input: { url: string; path: string; branch?: string; credentialId?: string }) {
      return upstream.importRepo(input);
    },
    setUpstream(
      repoPath: string,
      config: {
        remote: string;
        branch?: string;
        autoPush?: boolean;
        credentialId?: string;
        authorEmail?: string;
        authorName?: string;
      }
    ) {
      return upstream.setUpstream(repoPath, config);
    },
    removeUpstream(repoPath: string) {
      return upstream.removeUpstream(repoPath);
    },
    setAutoPush(repoPath: string, on?: boolean) {
      return upstream.setAutoPush(repoPath, on);
    },
    setRemote(repoPath: string, remote: { name: string; url: string; branch?: string }) {
      return upstream.setRemote(repoPath, remote);
    },
    removeRemote(repoPath: string, remoteName?: string) {
      return upstream.removeRemote(repoPath, remoteName);
    },
    openGitTab(repoPath?: string) {
      return upstream.openGitTab(repoPath);
    },
  };
}
