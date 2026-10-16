/**
 * Electron main of the RPC load smoke. Three client windows each drive RPCs
 * through their own port to the connection process while main samples its own
 * event-loop delay: the measurement of the budget "main-loop p99 under RPC
 * load" (docs/client-hosts-and-clients-plan.md section 5.1.1).
 */

import { app, BrowserWindow, MessageChannelMain, utilityProcess } from "electron";
import { monitorEventLoopDelay } from "node:perf_hooks";
import * as fs from "node:fs";
import { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { ConnectionLink } from "../../main/connectionLink.js";
import { launchConnectionProcess } from "../../main/connectionProcess.js";
import { RendererPortBroker } from "../../main/rendererPorts.js";
import { createHostServiceEndpoint } from "../../main/hostServiceEndpoint.js";
import { workspaceTransportArgument } from "../../preload/workspaceTransportIdentity.js";

interface Plan {
  utilityEntry: string;
  preload: string;
  page: string;
  windows: number;
  rpcsPerWindow: number;
  payloadBytes: number;
  inFlight: number;
  resultPath: string;
}

const plan = JSON.parse(process.env["RPC_LOAD_PLAN"] ?? "null") as Plan;

function histogramMs(histogram: ReturnType<typeof monitorEventLoopDelay>) {
  const ms = (ns: number) => Math.round((ns / 1e6) * 1000) / 1000;
  return {
    p50: ms(histogram.percentile(50)),
    p99: ms(histogram.percentile(99)),
    max: ms(histogram.max),
    samples: histogram.count,
  };
}

async function sample<T>(work: () => Promise<T>) {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const value = await work();
  histogram.disable();
  return { value, lag: histogramMs(histogram) };
}

app
  .whenReady()
  .then(async () => {
    const launched = launchConnectionProcess({
      fork: () =>
        utilityProcess.fork(plan.utilityEntry, [], {
          serviceName: "rpc-load-smoke",
          stdio: "inherit",
        }),
      createPorts: () => {
        const { port1, port2 } = new MessageChannelMain();
        return [port1, port2];
      },
    });
    const link = new ConnectionLink(launched.channel);
    const bindings = new Map<number, { index: number }>();
    const broker = new RendererPortBroker({
      link: () => link,
      resolveBinding: (contents) => {
        const entry = bindings.get(contents.id);
        if (!entry) return null;
        return {
          caller: {
            callerId: `window:smoke:${entry.index}`,
            callerKind: "client",
            runtimeId: `client:smoke${entry.index}:web:device`,
            workspaceId: "system",
          },
          state: {
            hostsPanels: false,
            client: {
              capabilities: [],
              executionDigest: "d",
              effectiveVersion: "1",
              principalId: `client:smoke${entry.index}:web:device`,
              workspaceId: "system",
            },
          },
        };
      },
    });
    broker.install();
    link.serveHost(
      createHostServiceEndpoint({
        resolveWorkspace: async (workspaceId) => ({
          workspaceId,
          dispatcher: new ServiceDispatcher(),
        }),
        codeIdentityForCaller: () => null,
        panelRuntimeConnection: () => undefined,
      })
    );
    await link.establish(
      {
        mode: null,
        prepareInitialWorkspace: false,
        appVersion: "0",
        userDataPath: app.getPath("userData"),
      },
      {
        confirmExistingLocalHub: async () => "cancel",
        credentials: { load: () => null, preflight: () => undefined, save: () => undefined },
        onStartupProgress: () => undefined,
        onConnectionStatusChanged: () => undefined,
        onTransportDiagnosticsChanged: () => undefined,
        onReconnectProgress: () => undefined,
        onLocalRecoveryFailure: () => undefined,
        onMainSessionTerminalClose: () => undefined,
        onCredentialSaveFailed: () => undefined,
      }
    );

    const windows: BrowserWindow[] = [];
    for (let index = 0; index < plan.windows; index++) {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: plan.preload,
          sandbox: true,
          contextIsolation: true,
          additionalArguments: [
            workspaceTransportArgument({
              workspaceId: "system",
              runtimeId: `client:smoke${index}:web:device`,
            }),
          ],
        },
      });
      bindings.set(window.webContents.id, { index });
      await window.loadFile(plan.page);
      windows.push(window);
    }

    // Idle baseline first, so the loaded figure is read against the timer floor.
    const idle = await sample(() => new Promise<void>((resolve) => setTimeout(resolve, 3000)));
    const loaded = await sample(async () =>
      Promise.all(
        windows.map((window) =>
          window.webContents.executeJavaScript(
            `window.__runRpcLoad(${plan.rpcsPerWindow}, ${plan.payloadBytes}, ${plan.inFlight})`
          )
        )
      )
    );
    const perWindow = loaded.value as {
      rpcs: number;
      elapsedMs: number;
      p50: number;
      p99: number;
    }[];
    fs.writeFileSync(
      plan.resultPath,
      JSON.stringify({
        electron: process.versions.electron,
        idle: idle.lag,
        loaded: loaded.lag,
        perWindow,
      })
    );
    broker.uninstall();
    await link.shutdownPorts();
    await launched.dispose();
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
