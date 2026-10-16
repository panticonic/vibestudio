import {
  METHOD_CAPABILITY,
  type BrokerFailure,
  type ClientHostMethod,
  type ClientHostMethods,
} from "@vibestudio/rn-client-api/protocol";
import { decodeRpcJson, encodeRpcJson } from "@vibestudio/rpc";
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";
import { BrokerError } from "./ports";

type Handlers = {
  [M in ClientHostMethod]?: (
    ...args: ClientHostMethods[M]["args"]
  ) => ClientHostMethods[M]["result"] | Promise<ClientHostMethods[M]["result"]>;
};

export interface ClientBrokerOptions {
  /** The capabilities this instance holds right now. Read at every call: a revocation takes effect at once. */
  granted: () => readonly ClientCapability[];
  handlers: Handlers;
}

export type BrokerOutcome = { ok: true; resultJson: string } | ({ ok: false } & BrokerFailure);

function failureOf(error: unknown): BrokerFailure {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return {
    code: typeof code === "string" ? code : "HOST_ERROR",
    message: typeof message === "string" ? message : String(error),
  };
}

/**
 * The capability broker of one client instance. Native carries a client's
 * request here untouched; this decides. A method needs the capability
 * `METHOD_CAPABILITY` names (none for a client's own sessions, state, updates
 * and intents), checked against the capabilities held at the moment of the
 * call, and a method the host does not implement is refused rather than
 * ignored. Nothing a client can send reaches a handler otherwise.
 */
export function createClientBroker(options: ClientBrokerOptions) {
  return {
    async handle(method: string, argsJson: string): Promise<BrokerOutcome> {
      try {
        if (!Object.hasOwn(METHOD_CAPABILITY, method)) {
          throw new BrokerError("UNKNOWN_METHOD", `The host has no method "${method}".`);
        }
        const known = method as ClientHostMethod;
        const capability = METHOD_CAPABILITY[known];
        if (capability !== null && !options.granted().includes(capability)) {
          throw new BrokerError(
            "CAPABILITY_NOT_GRANTED",
            `"${method}" needs the "${capability}" capability, which this client does not hold.`
          );
        }
        const handler = options.handlers[known] as
          | ((...args: unknown[]) => unknown)
          | undefined;
        if (!handler) {
          throw new BrokerError("UNKNOWN_METHOD", `The host does not implement "${method}".`);
        }
        const args = decodeRpcJson(argsJson);
        if (!Array.isArray(args)) {
          throw new BrokerError("BAD_REQUEST", `"${method}" arguments must be an array.`);
        }
        const result = await handler(...args);
        return { ok: true, resultJson: encodeRpcJson(result === undefined ? null : result) };
      } catch (error) {
        return { ok: false, ...failureOf(error) };
      }
    },
  };
}

export type ClientBroker = ReturnType<typeof createClientBroker>;
