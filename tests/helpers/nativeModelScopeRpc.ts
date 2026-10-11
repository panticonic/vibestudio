import type { RpcCaller } from "@vibestudio/rpc";
import { mainRpcMethods } from "@vibestudio/service-schemas/mainRpc";

/** The protected host boundary used by native model transport fixtures. */
export function createNativeModelScopeRpc() {
  const scopes = new Set<string>();
  const closed: string[] = [];
  const rpc: RpcCaller = {
    call: (target, method, args) =>
      method.invoke(args, async (parsed) => {
        if (target !== "main") throw new Error(`Unexpected scope target: ${target}`);
        if (Object.is(method, mainRpcMethods["credentials.openWebSocketScope"])) {
          const scopeId = crypto.randomUUID();
          scopes.add(scopeId);
          return { scopeId };
        }
        if (Object.is(method, mainRpcMethods["credentials.closeWebSocketScope"])) {
          const { scopeId } = parsed[0] as { scopeId: string };
          if (!scopes.delete(scopeId)) throw new Error(`Scope is not owned: ${scopeId}`);
          closed.push(scopeId);
          return null;
        }
        throw new Error(`Unexpected model scope operation: ${method.name}`);
      }),
    stream: async () => {
      throw new Error("No model scope stream is expected");
    },
  };
  return { rpc, inspect: () => ({ open: [...scopes], closed: [...closed] }) };
}
