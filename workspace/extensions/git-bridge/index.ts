/**
 * git-bridge extension — the platform's git interchange venue (eviction stage
 * P5c part 2). Hosts the {@link GitBridge} core in a trusted Node extension
 * process and adapts it onto the platform primitives:
 *
 *  - the canonical public `vcs.*` service over the same main transport used by
 *    panels, tools, and agents
 *  - raw Node disk access for operational checkouts under workspace host state
 *
 * The host reaches it exclusively through the manifest-declared
 * `providers.gitInterop` slot. Userland calls the typed `gitInterop.*` service
 * through the runtime `git` client and never names this extension.
 */

import type {
  GitCommitMappingOptions,
  GitInteropProvider,
  GitPublishRepoInput,
  GitPullUpstreamOptions,
  GitPushUpstreamOptions,
  GitUpstreamStatusOptions,
} from "@vibestudio/service-schemas/gitInterop";
import { blobstoreMethods } from "@vibestudio/service-schemas/blobstore";
import { vcsMethods } from "@vibestudio/service-schemas/vcs";
import { runtimeMethods } from "@vibestudio/service-schemas/runtime";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { gitCheckoutsPath } from "@vibestudio/workspace/gitCheckouts";
import { GitBridge, type BridgeHost } from "./bridge.js";
import { UpstreamEngine } from "./upstream.js";
import type { ExtensionContextLike } from "./context.js";

function createBridgeHost(ctx: ExtensionContextLike): BridgeHost {
  const main = <T>(method: string, ...args: unknown[]): Promise<T> =>
    ctx.rpc.call<T>("main", method, ...args);
  const vcs = createTypedServiceClient("vcs", vcsMethods, (_service, method, args) =>
    main(`vcs.${method}`, ...args)
  );
  const blobstore = createTypedServiceClient(
    "blobstore",
    blobstoreMethods,
    (_service, method, args) => main(`blobstore.${method}`, ...args)
  );
  const runtime = createTypedServiceClient("runtime", runtimeMethods, (_service, method, args) =>
    main(`runtime.${method}`, ...args)
  );

  return {
    checkoutRoot: async () => gitCheckoutsPath((await ctx.workspace.getInfo()).statePath),
    ensureContext: async (contextId) => {
      await runtime.createContext({ contextId });
    },
    blobstore,
    vcs,
  };
}

type GitBridgeApi = {
  providerContracts: { gitInterop: GitInteropProvider };
  retryUpstreamPush(repoPath: string): Promise<unknown>;
  pauseAutoPush(repoPath: string): Promise<unknown>;
  openGitTab(repoPath?: string): ReturnType<UpstreamEngine["openGitTab"]>;
};

/** Internal provider surface exposed to the extension host. */
export type Api = Awaited<ReturnType<typeof activate>>;
// Intentionally NOT registered in the WorkspaceExtensions type registry:
// git-bridge is host/agent infrastructure, not a panel-facing client library.

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("git-bridge activating");
  const bridge = new GitBridge(createBridgeHost(ctx));
  const upstream = new UpstreamEngine(ctx, bridge);
  await upstream.activate();
  const gitInterop = {
    upstreamStatus(repoPaths: string[], options: GitUpstreamStatusOptions = {}) {
      return upstream.upstreamStatus(repoPaths, options);
    },
    pushUpstream(repoPath: string, options?: GitPushUpstreamOptions) {
      return upstream.pushUpstream(repoPath, options);
    },
    pullUpstream(repoPath: string, options?: GitPullUpstreamOptions) {
      return upstream.pullUpstream(repoPath, options);
    },
    publishRepo(input: GitPublishRepoInput) {
      return upstream.publishRepo(input);
    },
    commitMapping(repoPath: string, options: GitCommitMappingOptions = {}) {
      return upstream.commitMapping(repoPath, options);
    },
    pushDisposableRemote(input: { repoPath: string; url: string; branch: string }) {
      return upstream.pushDisposableRemote(input);
    },
    cloneRepo(input: { repoPath: string }) {
      return upstream.cloneRepo(input);
    },
    remoteDefaultBranch(input: { url: string; credentialId?: string }) {
      return upstream.remoteDefaultBranch(input);
    },
    async onMainAdvanced(repoPaths: string[]) {
      upstream.onMainAdvanced(repoPaths);
      return { queued: repoPaths.length };
    },
  } satisfies GitInteropProvider;
  const api = {
    providerContracts: { gitInterop },
    retryUpstreamPush(repoPath: string) {
      return ctx.rpc.call("main", "gitInterop.pushUpstream", repoPath);
    },
    pauseAutoPush(repoPath: string) {
      return ctx.rpc.call("main", "gitInterop.setAutoPush", repoPath, false);
    },
    openGitTab(repoPath?: string) {
      return upstream.openGitTab(repoPath);
    },
  } satisfies GitBridgeApi;
  return api;
}
