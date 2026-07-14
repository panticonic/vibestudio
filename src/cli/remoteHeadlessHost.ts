import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isSelectedWorkspaceUrl } from "@vibestudio/shared/connect";
import { loadCliCredentials } from "./credentialStore.js";
import type { ParsedInvocation } from "./commandTable.js";
import { CliError, UsageError, jsonMode, printError, redactCliSecrets } from "./output.js";
import { NOT_PAIRED_GUIDANCE } from "./pairingGuidance.js";
import type { DeviceCredential } from "@vibestudio/direct-client";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Resolve the sole supported headless-host module entry. Development and
 * packaged CLI runs use the same built artifact; tests and deployments may
 * replace it explicitly, but there is no source/dist candidate search. */
export function resolveRemoteHeadlessHostEntryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["VIBESTUDIO_HEADLESS_HOST_ENTRY"];
  if (override) return path.resolve(override);
  const appRoot = env["VIBESTUDIO_APP_ROOT"] || repositoryRoot;
  return path.join(appRoot, "dist", "headless-host", "index.js");
}

async function createWebRtcHeadlessHostOverrides(
  creds: DeviceCredential & {
    workspacePairing: NonNullable<DeviceCredential["workspacePairing"]>;
  },
  opts: { entryPath: string; label?: string }
): Promise<Record<string, unknown>> {
  const [{ WebRtcRpcClient }, { startPanelAssetFacade }, { RemoteCdpHostBridgeSocket }] =
    await Promise.all([
      import("@vibestudio/direct-client/webrtc"),
      import("../node/panelAssets/panelAssetFacade.js"),
      import(pathToFileURL(opts.entryPath).href),
    ]);

  const clientSessionId = `headless-${randomUUID()}`;
  const label = opts.label ?? "Headless";
  const token = `refresh:${creds.deviceId}:${creds.refreshToken}`;
  const client = new WebRtcRpcClient({
    pairing: creds.workspacePairing,
    callerId: `shell:${creds.deviceId}`,
    getToken: () => token,
    connectionId: clientSessionId,
    clientLabel: label,
    logPrefix: "[headless-webrtc]",
  });

  let facade: Awaited<ReturnType<typeof startPanelAssetFacade>> | null = null;
  const cleanups: Array<() => void> = [];
  const releaseSubscriptions = () => {
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Continue releasing the remaining transport subscriptions.
      }
    }
  };
  try {
    await client.ready();
    const rpc = {
      call<T = unknown>(
        targetId: string,
        method: string,
        args: unknown[] = [],
        options?: unknown
      ): Promise<T> {
        void options;
        return targetId === "main"
          ? client.call<T>(method, args)
          : client.callTarget<T>(targetId, method, args);
      },
      stream(
        targetId: string,
        method: string,
        args: unknown[] = [],
        options?: Parameters<
          import("@vibestudio/direct-client/webrtc").WebRtcRpcClient["stream"]
        >[3]
      ): Promise<Response> {
        return client.stream(targetId, method, args, options);
      },
    };
    facade = await startPanelAssetFacade(
      {
        stream(service, method, args, options) {
          return client.stream("main", `${service}.${method}`, args, options);
        },
      },
      {
        stateDir: path.join(
          os.homedir(),
          ".local",
          "state",
          "vibestudio",
          "headless-host",
          "panel-asset-facade"
        ),
      }
    );
    const activeFacade = facade;

    const eventListeners = new Set<(event: string, payload: unknown) => void>();
    const recoveryHandlers = new Set<() => void | Promise<void>>();
    cleanups.push(
      await client.onEvent("panel:runtimeLeaseChanged", (payload) => {
        for (const listener of eventListeners) listener("panel:runtimeLeaseChanged", payload);
      })
    );
    cleanups.push(
      await client.onRecovery(async () => {
        for (const handler of recoveryHandlers) await handler();
      })
    );

    return {
      serverUrl: `http://127.0.0.1:${activeFacade.port}`,
      clientSessionId,
      connectionFactory: async () => ({
        rpc,
        getToken: () => token,
        onServerEvent(listener: (event: string, payload: unknown) => void) {
          eventListeners.add(listener);
        },
        onResubscribe(handler: () => void | Promise<void>) {
          recoveryHandlers.add(handler);
        },
        async close() {
          releaseSubscriptions();
          await client.close();
        },
      }),
      bridgeSocketFactory: () =>
        new RemoteCdpHostBridgeSocket({
          rpc,
          hostConnectionId: clientSessionId,
        }),
      cleanup: async () => {
        releaseSubscriptions();
        await activeFacade.close().catch(() => undefined);
        await client.close().catch(() => undefined);
      },
    };
  } catch (error) {
    releaseSubscriptions();
    await facade?.close().catch(() => undefined);
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function runRemoteHeadlessHost(inv: ParsedInvocation): Promise<number> {
  const flagStr = (name: string): string | undefined =>
    typeof inv.flags[name] === "string" ? (inv.flags[name] as string) : undefined;
  const flagMin = (name: string, allowZero = false): number | undefined => {
    const raw = flagStr(name);
    if (!raw) return undefined;
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || (!allowZero && minutes <= 0) || (allowZero && minutes < 0)) {
      throw new UsageError(
        `--${name} must be ${allowZero ? "zero or a positive number" : "a positive number"}`
      );
    }
    return minutes * 60_000;
  };

  const maxPanelsRaw = flagStr("max-panels");
  const maxPanels = maxPanelsRaw === undefined ? undefined : Number(maxPanelsRaw);
  if (maxPanels !== undefined && (!Number.isInteger(maxPanels) || maxPanels <= 0)) {
    throw new UsageError("--max-panels must be a positive integer");
  }
  const idleUnloadMs = flagMin("idle-unload-min");
  const idleExitMs = flagMin("idle-exit-min", true);
  const entryPath = resolveRemoteHeadlessHostEntryPath();

  const creds = loadCliCredentials();
  if (!creds) {
    console.error(NOT_PAIRED_GUIDANCE);
    return 3;
  }
  if (!isSelectedWorkspaceUrl(creds.url)) {
    console.error("stored remote credential is not scoped to a workspace");
    return 3;
  }
  const configOverrides: Record<string, unknown> = await createWebRtcHeadlessHostOverrides(creds, {
    entryPath,
    label: flagStr("label"),
  });
  const cleanup =
    typeof configOverrides["cleanup"] === "function"
      ? (configOverrides["cleanup"] as () => Promise<void>)
      : null;
  delete configOverrides["cleanup"];

  try {
    const { HeadlessHost, resolveConfig } = (await import(pathToFileURL(entryPath).href)) as {
      HeadlessHost: new (config: unknown) => {
        start(): Promise<void>;
        stop(reason: string): Promise<void>;
        done: Promise<void>;
      };
      resolveConfig: (overrides: Record<string, unknown>) => unknown;
    };
    const config = resolveConfig({
      ...configOverrides,
      label: flagStr("label"),
      maxPanels,
      idleUnloadMs,
      idleExitMs,
      chromiumPath: flagStr("chromium-path"),
      leanBrowser: inv.flags["lean-browser"] === true,
    });
    const host = new HeadlessHost(config);
    const stopOnSigint = () => void host.stop("SIGINT");
    const stopOnSigterm = () => void host.stop("SIGTERM");
    process.on("SIGINT", stopOnSigint);
    process.on("SIGTERM", stopOnSigterm);
    try {
      try {
        await host.start();
      } catch (error) {
        throw new CliError(
          `headless host failed to start: ${redactCliSecrets(error instanceof Error ? error.message : String(error))}`
        );
      }
      await host.done;
      return 0;
    } finally {
      process.off("SIGINT", stopOnSigint);
      process.off("SIGTERM", stopOnSigterm);
    }
  } finally {
    await cleanup?.().catch(() => undefined);
  }
}

export async function remoteHost(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    return await runRemoteHeadlessHost(inv);
  } catch (error) {
    return printError(error, { json });
  }
}
