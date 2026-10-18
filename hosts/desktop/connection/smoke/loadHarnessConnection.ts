/**
 * The connection process of the RPC load smoke: the real control channel,
 * connection host and renderer port host, with an echoing server in place of a
 * hub. It exists so the smoke measures exactly the production port path
 * without needing a workspace server.
 */

import { NodeArtifactStore } from "@vibestudio/client-host-core/node";
import type { RpcCallOptions } from "@vibestudio/rpc";
import type { ConnectedSession } from "../../main/serverSession.js";
import type { ConnectedServerClient } from "../../main/serverClient.js";
import { ControlChannel, type MessagePortLike } from "../controlChannel.js";
import { ConnectionHost } from "../connectionHost.js";

const noop = (): (() => void) => () => undefined;

function echoClient(): ConnectedServerClient {
  return {
    isClosed: () => false,
    isConnected: () => true,
    getConnectionStatus: () => "connected",
    transportDiagnostics: () => null,
    onRecovery: noop,
    onConnectionStatusChange: noop,
    onDirectEvent: noop,
    exposeHostMethod: () => undefined,
    exposeHostStream: () => undefined,
    setClientPrincipalSessions: () => undefined,
    close: async () => undefined,
    call: async (_service: string, _method: string, args: unknown[]) => args[0],
    callTarget: async () => undefined,
    callAs: async (_caller, _service, _method, args: unknown[], _options?: RpcCallOptions) =>
      args[0],
    stream: async () => new Response(null),
    streamReadable: async () => {
      throw new Error("The smoke server does not stream");
    },
    streamAs: async () => new Response(null),
    openHostUiSession: async () => {
      throw new Error("The smoke server has no UI sessions");
    },
    openPanelSession: async () => {
      throw new Error("The smoke server has no panel sessions");
    },
    sendAs: async () => undefined,
    addMessageListener: noop,
    openClientSession: async () => undefined,
    releaseClientSession: async () => undefined,
  };
}

function smokeSession(): ConnectedSession {
  const client = echoClient();
  const workspace = {
    nativeStorageScope: "smoke",
    connectionMode: "local" as const,
    serverOwnership: "external" as const,
    protocol: "http" as const,
    gatewayPort: 1,
    externalHost: "localhost",
    gatewayConfig: { serverUrl: "http://127.0.0.1:1", workspace: "system" },
    workerdPort: 0,
    workspaceName: "System",
    workspaceId: "system",
    workspacePath: "/smoke",
    statePath: "/smoke",
    workspaceConfig: { id: "system" } as never,
    serverClient: client,
    close: async () => undefined,
    panelHttpServer: { invalidateBuild: () => undefined, getPort: () => 1 },
    serverInfo: {
      gatewayConfig: { serverUrl: "http://127.0.0.1:1" },
      workerdPort: 0,
      externalHost: "localhost",
      gatewayPort: 1,
      protocol: "http" as const,
      call: async () => undefined,
    },
    getCdpAuthToken: () => "",
    onCdpAuthToken: noop,
  };
  return {
    ...workspace,
    hubControlClient: echoClient(),
    hubProcessManager: null,
    connectWorkspace: async () => {
      throw new Error("The smoke has one workspace");
    },
  };
}

const parentPort = (
  process as unknown as {
    parentPort: {
      once(
        event: "message",
        listener: (event: { data: unknown; ports: MessagePortLike[] }) => void
      ): void;
    };
  }
).parentPort;

parentPort.once("message", (event) => {
  const [port] = event.ports;
  if (!port) throw new Error("No control port");
  const channel = new ControlChannel(port, "b");
  const host = new ConnectionHost({
    channel,
    establish: async () => smokeSession(),
    createCentralData: () => ({}) as never,
    // The harness launches no clients, so nothing is ever written here.
    createArtifactStore: (userDataPath) =>
      new NodeArtifactStore(`${userDataPath}/client-artifacts`),
  });
  channel.onClose(() => void host.close().finally(() => process.exit(0)));
});
