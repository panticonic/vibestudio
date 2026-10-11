import { RpcBoundaryError } from "./errors.js";

export const INVALID_RPC_METHOD_DESCRIPTOR_CODE = "INVALID_RPC_METHOD_DESCRIPTOR";

/** Reject malformed public descriptors before their members are invoked. */
export function assertRpcMethodDescriptor(method: unknown, operation: string): void {
  const invalid = (reason: string, cause?: unknown): never => {
    throw new RpcBoundaryError(
      `Invalid RPC method descriptor for ${operation}: ${reason}`,
      "protocol",
      INVALID_RPC_METHOD_DESCRIPTOR_CODE,
      cause,
      { rpcMethodDescriptor: { operation, reason } }
    );
  };

  if (!method || typeof method !== "object" || Array.isArray(method)) {
    invalid("expected a method descriptor object");
  }

  try {
    const descriptor = method as { name?: unknown; invoke?: unknown; parseArgs?: unknown };
    if (typeof descriptor.name !== "string" || descriptor.name.trim().length === 0) {
      invalid("name must be a non-empty string");
    }
    if (typeof descriptor.invoke !== "function") {
      invalid("invoke must be a function");
    }
    if (typeof descriptor.parseArgs !== "function") {
      invalid("parseArgs must be a function");
    }
  } catch (cause) {
    if (cause instanceof RpcBoundaryError) throw cause;
    invalid("descriptor properties could not be read", cause);
  }
}
