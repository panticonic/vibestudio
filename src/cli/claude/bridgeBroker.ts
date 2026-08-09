import { createClaudeBridgeAuthority } from "@vibestudio/shared/claudeBridgeAuthority";
import {
  startClaudeBridgeBroker,
  type ClaudeBridgeAuthority,
  type ClaudeBridgeBroker,
} from "@vibestudio/shared/claudeBridgeBroker";
import { loadCliCredentials, type CliStoredPairing } from "../credentialStore.js";
import { RpcClient } from "../rpcClient.js";

function transportCredential(
  serverUrl: string,
  agentToken: string
): {
  url: string;
  token: string;
  workspacePairing?: CliStoredPairing;
} {
  if (new URL(serverUrl).protocol !== "webrtc:") return { url: serverUrl, token: agentToken };
  const credentials = loadCliCredentials();
  if (!credentials || credentials.url !== serverUrl) {
    throw new Error("Claude launch WebRTC route does not match this machine's paired workspace");
  }
  return { url: serverUrl, token: agentToken, workspacePairing: credentials.workspacePairing };
}

export function createCliClaudeBridgeAuthority(input: {
  serverUrl: string;
  agentToken: string;
  vesselRef: string;
  makeClient?: (credential: ReturnType<typeof transportCredential>) => RpcClient;
}): ClaudeBridgeAuthority {
  const client = (input.makeClient ?? ((credential) => new RpcClient(credential)))(
    transportCredential(input.serverUrl, input.agentToken)
  );
  return createClaudeBridgeAuthority({
    callVessel: <T>(method: string, args: unknown[]) =>
      client.callTargetPush<T>(input.vesselRef, method, args),
    streamVessel: (method, args, signal) =>
      client.stream(input.vesselRef, method, args, { signal }),
    callWorkspace: <T>(method: string, args: unknown[]) => client.call<T>(method, args),
    onRecovery: (handler) => client.onRecovery(handler),
    close: () => client.close(),
  });
}

export async function startCliClaudeBridgeBroker(input: {
  socketPath: string;
  generation: string;
  serverUrl: string;
  agentToken: string;
  vesselRef: string;
  makeClient?: Parameters<typeof createCliClaudeBridgeAuthority>[0]["makeClient"];
}): Promise<ClaudeBridgeBroker> {
  return await startClaudeBridgeBroker({
    socketPath: input.socketPath,
    generation: input.generation,
    authority: createCliClaudeBridgeAuthority(input),
  });
}
