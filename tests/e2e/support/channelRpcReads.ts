import { channelClientRpcMethods } from "@vibestudio/service-schemas/channel";
import type { RpcCaller } from "@vibestudio/rpc";

export function readChannelParticipants(rpc: RpcCaller, targetId: string) {
  return rpc.call(targetId, channelClientRpcMethods["getParticipants"], []);
}

export function readChannelReplay(rpc: RpcCaller, targetId: string, after: number) {
  return rpc.call(targetId, channelClientRpcMethods["getReplayAfter"], [{ after }]);
}

export async function readChannelSnapshot(rpc: RpcCaller, targetId: string) {
  const [participants, replay] = await Promise.all([
    readChannelParticipants(rpc, targetId),
    readChannelReplay(rpc, targetId, 0),
  ]);
  return { participants, replay };
}

Object.defineProperty(globalThis, Symbol.for("vibestudio.e2e.channelRpcReads.v1"), {
  configurable: true,
  value: { readChannelParticipants, readChannelReplay, readChannelSnapshot },
});
