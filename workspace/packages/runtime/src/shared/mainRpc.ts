import type { RpcClient } from "@vibez1/rpc";

export type MainCaller = <T>(method: string, ...args: unknown[]) => Promise<T>;

export function createMainCaller(rpc: Pick<RpcClient, "call">): MainCaller {
  return <T>(method: string, ...args: unknown[]) => rpc.call<T>("main", method, args);
}
