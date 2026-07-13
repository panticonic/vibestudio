import type { RpcErrorKind } from "./types.js";

/** Locally categorized failure ready to cross an RPC boundary. */
export class RpcBoundaryError extends Error {
  constructor(
    message: string,
    public readonly errorKind: RpcErrorKind,
    public readonly code?: string,
    cause?: unknown
  ) {
    super(message);
    if (cause !== undefined) {
      // Match the standard Error.cause descriptor without requiring the ES2022
      // two-argument Error constructor; RPC also targets the mobile ES2020 build.
      Object.defineProperty(this, "cause", {
        value: cause,
        writable: true,
        configurable: true,
      });
    }
    this.name = "RpcBoundaryError";
  }
}

/** Error reconstructed from a structured remote RPC failure. */
export class RemoteRpcError extends Error {
  constructor(
    message: string,
    public readonly errorKind: RpcErrorKind,
    public readonly code?: string
  ) {
    super(message);
    this.name = "RemoteRpcError";
  }
}

/** Preserve an explicit domain category, otherwise use the boundary's fallback. */
export function rpcErrorKindOf(
  error: unknown,
  fallback: RpcErrorKind = "application"
): RpcErrorKind {
  const kind = (error as { errorKind?: unknown } | null)?.errorKind;
  switch (kind) {
    case "access":
    case "service":
    case "transport":
    case "protocol":
    case "application":
    case "internal":
      return kind;
    default:
      return fallback;
  }
}
