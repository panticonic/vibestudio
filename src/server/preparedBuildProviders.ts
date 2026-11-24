import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  ExtensionProcessManager,
  createExtensionBuildProvider,
  extensionPrimaryArtifactPath,
} from "@vibestudio/extension-host";
import { createInternalRpcClient, type RpcWireClient } from "@vibestudio/rpc/internal";
import { RPC_CONTRACT_VERSION } from "@vibestudio/rpc/protocol/contractVersion";
import { runtimeMethods } from "@vibestudio/service-schemas/runtime";
import {
  readWorkspaceConfig,
  resolveRuntimeRequiredExtensions,
} from "@vibestudio/workspace/configParser";
import type { BuildProvider, BuildProviderTarget } from "@vibestudio/shared/buildProvider";
import type { BuildSystemV2 } from "./buildV2/index.js";
import type { startNativeWorkspaceRuntime } from "./nativeWorkspaceRuntime.js";
import { ProcessSessionChannel } from "./rpcServer/processSessionChannel.js";
import {
  createSessionServerTransport,
  envelopeTransportFromSessionServer,
} from "./sessionServerTransport.js";

/** A release owns its exact build extensions in the existing native workspace.
 * It uses the same extension child, IPC protocol, provider adapter and lifecycle
 * manager as an interactive workspace. The producer exposes no workspace RPCs.
 */
export function createPreparedBuildProviders(input: {
  sourcePath: string;
  workspaceId: string;
  statePath: string;
  stateHash: string;
  native: Awaited<ReturnType<typeof startNativeWorkspaceRuntime>>;
  builds(): BuildSystemV2;
  signal?: AbortSignal;
}) {
  const bridges = new Map<string, RpcWireClient>();
  const preparations = new Map<BuildProviderTarget, Promise<BuildProvider>>();
  let retiring = false;
  const processes = new ExtensionProcessManager({
    launch: (environment) => input.native.fork(input.native.extensionEntry, environment),
    attachProcess(process, name) {
      const channel = new ProcessSessionChannel(process);
      const transport = createSessionServerTransport({ ws: channel, clientId: name });
      const lifetime = new AbortController();
      const bridge = createInternalRpcClient({
        selfId: "server",
        callerKind: "server",
        transport: envelopeTransportFromSessionServer(transport),
        lifetime: lifetime.signal,
      });
      bridge.expose(
        "runtime.supervision.reportReady",
        ({ args }) => {
          const [report] = runtimeMethods["supervision.reportReady"].args.parse(args);
          if (!report.methods?.includes("build"))
            throw new Error(`Build provider ${name} did not expose its build method`);
          processes.markReady(name, {
            methods: report.methods,
            hasFetch: report.hasFetch ?? false,
          });
          return null;
        },
        {
          kind: "closed",
          reason: "The native compilation owner accepts only its launched extension's lifecycle.",
        }
      );
      bridge.expose(
        "runtime.supervision.reportHealth",
        ({ args }) => {
          const [report] = runtimeMethods["supervision.reportHealth"].args.parse(args);
          console.log(`[workspace-release] Build provider ${name}: ${report.state}`);
          return null;
        },
        {
          kind: "closed",
          reason: "The native compilation owner accepts only its launched extension's lifecycle.",
        }
      );
      bridge.expose(
        "runtime.supervision.appendLog",
        ({ args }) => {
          const [report] = runtimeMethods["supervision.appendLog"].args.parse(args);
          console.log(`[build-provider:${name}] ${report.message}`);
          return null;
        },
        {
          kind: "closed",
          reason: "The native compilation owner accepts only its launched extension's lifecycle.",
        }
      );
      bridges.set(name, bridge);
      const remove = channel.onMessage((message) => {
        if (message.type === "ws:auth") {
          if (message.contractVersion !== RPC_CONTRACT_VERSION) {
            channel.close(4005, "Incompatible build extension RPC contract");
            return;
          }
          // The exclusive launcher-owned pipe authenticates this exact child.
          channel.sendMessage({
            type: "ws:auth-result",
            success: true,
            contractVersion: RPC_CONTRACT_VERSION,
          });
        } else if (message.type === "ws:rpc" || message.type === "ws:route") {
          // Only replies and this child's supervision handshake have receivers.
          // An extension cannot obtain runtime/approval/workspace services from
          // the compilation host: no such methods are exposed by the bridge.
          transport.deliver(name, message.envelope.message);
        }
      });
      const close = channel.onClose(() => {
        lifetime.abort(new Error(`Build extension ${name} disconnected`));
        transport.close();
      });
      return () => {
        channel.close(1001, "Prepared build provider retired");
        remove();
        close();
        transport.close();
        lifetime.abort(new Error(`Build extension ${name} retired`));
        if (bridges.get(name) === bridge) bridges.delete(name);
      };
    },
    onStatus: (name, status) =>
      console.log(`[workspace-release] Build provider ${name}: ${status}`),
    onHealth: (name, health) =>
      console.log(`[workspace-release] Build provider ${name}: ${health.state}`),
    onLog: (name, level, message) => {
      if (level === "warn" || level === "error")
        console[level](`[build-provider:${name}] ${message}`);
    },
  });
  const transport = {
    call: (name: string, method: string, args: unknown[]) => {
      const bridge = bridges.get(name);
      if (!bridge) throw new Error(`Build provider ${name} has no owned IPC session`);
      return bridge.call(name, method, args, { signal: input.signal });
    },
    streamCallTarget: (name: string, method: string, ...args: unknown[]) => {
      const bridge = bridges.get(name);
      if (!bridge) throw new Error(`Build provider ${name} has no owned IPC session`);
      return bridge.stream(name, method, args, { signal: input.signal });
    },
  };
  return {
    ensure(target: BuildProviderTarget): Promise<BuildProvider> {
      input.signal?.throwIfAborted();
      if (retiring) return Promise.reject(new Error("Prepared build providers are retiring"));
      let preparation = preparations.get(target);
      if (!preparation) {
        preparation = (async () => {
          const config = await readWorkspaceConfig(
            {
              readText: (file) => readFile(path.join(input.sourcePath, file), "utf8"),
            },
            input.workspaceId
          );
          const required = resolveRuntimeRequiredExtensions(config, target);
          const candidates = input
            .builds()
            .getGraph()
            .allNodes()
            .filter(
              (node) =>
                node.kind === "extension" &&
                required.some((declaration) => declaration.source === node.relativePath) &&
                node.manifest.extension?.contributes?.buildTargets?.includes(target)
            );
          if (candidates.length !== 1)
            throw new Error(
              `Prepared ${target} clients require exactly one declared build provider`
            );
          const node = candidates[0]!;
          const build = await input
            .builds()
            .getStoredBuild(node.relativePath, input.stateHash, { priority: "speculative" });
          input.signal?.throwIfAborted();
          const storageDir = path.join(
            input.statePath,
            "extensions",
            "storage",
            input.workspaceId,
            createHash("sha256").update(node.name).digest("hex")
          );
          await mkdir(storageDir, { recursive: true });
          await processes.start({
            name: node.name,
            version: node.packageVersion ?? "0.0.0",
            bundlePath: extensionPrimaryArtifactPath(build),
            storageDir,
          });
          await processes.whenRunning(node.name, input.signal);
          return createExtensionBuildProvider(
            { name: node.name, activeEv: build.metadata.ev, activeBuildKey: build.buildKey },
            target,
            transport
          );
        })();
        preparations.set(target, preparation);
      }
      return preparation;
    },
    async close() {
      retiring = true;
      await Promise.allSettled(preparations.values());
      await processes.shutdown();
    },
  };
}
