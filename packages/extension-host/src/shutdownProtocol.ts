import { serializeRpcFailure, deserializeRpcFailure, type RpcFailure } from "@vibestudio/rpc";
export type ShutdownError = RpcFailure;
export type ExtensionShutdownRequest = { type: "shutdown"; requestId: string };
export type ExtensionShutdownResult =
  | { type: "shutdown-result"; requestId: string; ok: true }
  | { type: "shutdown-result"; requestId: string; ok: false; error: ShutdownError };

export function isExtensionShutdownResult(value: unknown): value is ExtensionShutdownResult {
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    value.type !== "shutdown-result" ||
    !("requestId" in value) ||
    typeof value.requestId !== "string" ||
    !("ok" in value)
  )
    return false;
  return value.ok === true || (value.ok === false && "error" in value);
}

export const shutdownError = serializeRpcFailure;
export const restoreShutdownError = deserializeRpcFailure;
