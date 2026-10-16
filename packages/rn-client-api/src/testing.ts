import { decodeRpcJson, encodeRpcJson } from "@vibestudio/rpc";
import type { BrokerChannel } from "./channel";
import type { BrokerFailure, ClientHostEvent, ClientHostMethod, ClientHostMethods } from "./protocol";

/** The host end of an in-memory broker: what native plus the host runtime do. */
export interface MemoryBrokerHost {
  /** Deliver an event to the client. */
  emit(event: ClientHostEvent): void;
}

/**
 * A client channel wired to a host handler in the same JavaScript realm, with
 * the broker's contract: arguments and results cross as JSON text, so neither
 * side can share an object with the other (bytes survive as the rpc wire encodes them).
 */
export function createMemoryBroker(
  handle: (method: ClientHostMethod, args: unknown[]) => unknown | Promise<unknown>
): { channel: BrokerChannel; host: MemoryBrokerHost } {
  const handlers = new Set<(event: ClientHostEvent) => void>();
  const channel: BrokerChannel = {
    async request<M extends ClientHostMethod>(
      method: M,
      ...args: ClientHostMethods[M]["args"]
    ): Promise<ClientHostMethods[M]["result"]> {
      const wireArgs = decodeRpcJson(encodeRpcJson(args)) as unknown[];
      try {
        const result = await handle(method, wireArgs);
        return decodeRpcJson(encodeRpcJson(result ?? null)) as ClientHostMethods[M]["result"];
      } catch (failure) {
        const { code, message } = failure as Partial<BrokerFailure>;
        throw Object.assign(new Error(message ?? String(failure)), {
          ...(typeof code === "string" ? { code } : {}),
        });
      }
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  return {
    channel,
    host: {
      emit(event) {
        const wire = decodeRpcJson(encodeRpcJson(event)) as ClientHostEvent;
        for (const handler of [...handlers]) handler(wire);
      },
    },
  };
}
