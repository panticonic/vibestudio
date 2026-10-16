import { DeviceEventEmitter, NativeModules } from "react-native";
import { decodeRpcJson, encodeRpcJson } from "@vibestudio/rpc";
import type { BrokerChannel } from "./channel";
import { createRnClientApi, type RnClientApi } from "./api";
import {
  CLIENT_BROKER_MODULE,
  CLIENT_EVENT_NAME,
  type BrokerFailure,
  type ClientHostEvent,
  type ClientHostMethod,
  type ClientHostMethods,
} from "./protocol";

interface NativeBroker {
  request(method: string, argsJson: string): Promise<string>;
}

/** Brokered failures carry the host's code; keep it on the error a caller sees. */
function brokerError(failure: unknown): Error {
  const { code, message } = (failure ?? {}) as Partial<BrokerFailure>;
  return Object.assign(new Error(message ?? "The host rejected the request"), {
    ...(typeof code === "string" ? { code } : {}),
  });
}

/**
 * The native broker of this client instance. It exists only in a client RN
 * instance the host started, and is bound to that instance's tag by native
 * code; there is no way to name another client.
 */
export function createNativeChannel(): BrokerChannel {
  const broker = NativeModules[CLIENT_BROKER_MODULE] as NativeBroker | undefined;
  if (!broker) {
    throw new Error(
      `${CLIENT_BROKER_MODULE} is not available: this bundle is not running as a Vibestudio client`
    );
  }
  return {
    async request<M extends ClientHostMethod>(
      method: M,
      ...args: ClientHostMethods[M]["args"]
    ): Promise<ClientHostMethods[M]["result"]> {
      let resultJson: string;
      try {
        resultJson = await broker.request(method, encodeRpcJson(args));
      } catch (failure) {
        throw brokerError(failure);
      }
      // The host always answers with JSON; a void result is `null`.
      return decodeRpcJson(resultJson) as ClientHostMethods[M]["result"];
    },
    onEvent(handler) {
      const subscription = DeviceEventEmitter.addListener(CLIENT_EVENT_NAME, (payload: string) => {
        handler(decodeRpcJson(payload) as ClientHostEvent);
      });
      return () => subscription.remove();
    },
  };
}

/** The host API of this client instance. Call once at startup and share the result. */
export function connectNativeClientApi(): Promise<RnClientApi> {
  return createRnClientApi(createNativeChannel());
}
