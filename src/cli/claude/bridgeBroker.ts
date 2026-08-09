import { readChannelSubscriptionRecords } from "@vibestudio/service-schemas/channel";
import {
  startClaudeBridgeBroker,
  type ClaudeBridgeAuthority,
  type ClaudeBridgeBroker,
  type ClaudeBridgeJson,
  type ClaudeBridgeStreamRecord,
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
  const vesselCall = <T>(method: string, args: unknown[]): Promise<T> =>
    client.callTargetPush<T>(input.vesselRef, method, args);
  return {
    openBridge: async function* (request, signal): AsyncIterable<ClaudeBridgeStreamRecord> {
      const response = await client.stream(input.vesselRef, "openBridge", [request], { signal });
      for await (const record of readChannelSubscriptionRecords<
        { pendingCount: number },
        Record<string, unknown>
      >(response)) {
        if (record.kind === "subscribed") {
          yield { kind: "subscribed", result: record.result };
        } else {
          yield { kind: "event", payload: record.payload as never };
        }
      }
    },
    say: (request) => vesselCall("say", [request]) as Promise<ClaudeBridgeJson>,
    complete: ({ report, outcome }) =>
      vesselCall("completeFromBridge", [{ report, outcome }]) as Promise<ClaudeBridgeJson>,
    requestPermission: async () => {
      throw new Error(
        "Claude permission relay is disabled until workspace approvals provide a trusted verdict"
      );
    },
    ackDelivery: (request) => vesselCall("ackDelivery", [request]) as Promise<ClaudeBridgeJson>,
    ingestHookEvent: (request) =>
      vesselCall("ingestHookEvent", [request]) as Promise<ClaudeBridgeJson>,
    listSkills: () => client.call("workspace.listSkills", []) as Promise<ClaudeBridgeJson>,
    readSkill: ({ name }) =>
      client.call("workspace.readSkill", [name]) as Promise<ClaudeBridgeJson>,
    linkedStatus: () => vesselCall("linkedStatus", []) as Promise<ClaudeBridgeJson>,
    onRecovery: (handler) => client.onRecovery(handler),
    close: () => client.close(),
  };
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
