import type { RpcErrorData, RpcErrorKind } from "./types.js";
import { SESSION_CONNECTION_LOST_CODE } from "./protocol/remoteSession.js";

/** True only for a structured authority decision made by the user. */
export function isAuthorityDecisionDenied(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (
    (error as { errorData?: { authorityFailure?: { reasonCode?: unknown } } }).errorData
      ?.authorityFailure?.reasonCode === "user-denied"
  );
}

/** True for a structured authority refusal that cannot be repaired by retrying. */
export function isTerminalAuthorityFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const reasonCode = (
    error as { errorData?: { authorityFailure?: { reasonCode?: unknown } } }
  ).errorData?.authorityFailure?.reasonCode;
  return reasonCode === "user-denied" || reasonCode === "receiver-rejected";
}

/** Routine logical-session loss; callers still own recovery and mutation policy. */
export function isRpcConnectionLost(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (
    "code" in error &&
    error.code === SESSION_CONNECTION_LOST_CODE &&
    (!("errorKind" in error) || error.errorKind === "transport")
  ) {
    return true;
  }
  // Domain wrappers such as PubSubError keep their own category in `code`,
  // preserve the lower RPC code in `errorCode`, and retain the typed cause.
  return (
    "errorCode" in error &&
    error.errorCode === SESSION_CONNECTION_LOST_CODE &&
    "cause" in error &&
    isRpcConnectionLost(error.cause)
  );
}

/** A caller cancelled its own call; nothing failed and nothing needs recovery. */
export const RPC_ABORTED_CODE = "RPC_ABORTED" as const;

/**
 * True when a call ended because its caller abandoned it — an unmounted view, a
 * superseded request, an aborted signal. Distinguishing this from a failure
 * matters at every logging boundary: a cancellation reported as an error reads
 * as a defect and, in the desktop smoke, fails a run that did nothing wrong.
 */
export function isRpcAborted(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === RPC_ABORTED_CODE
  );
}

/** Locally categorized failure ready to cross an RPC boundary. */
export class RpcBoundaryError extends Error {
  constructor(
    message: string,
    public readonly errorKind: RpcErrorKind,
    public readonly code?: string,
    cause?: unknown,
    public readonly errorData?: RpcErrorData
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
    public readonly code?: string,
    public readonly errorData?: RpcErrorData
  ) {
    super(message);
    this.name = "RemoteRpcError";
  }
}

/** Read only an explicitly structured error payload; never infer from prose. */
export function rpcErrorDataOf(error: unknown): RpcErrorData | undefined {
  if (error === null || typeof error !== "object" || !("errorData" in error)) return undefined;
  return (error as { errorData?: RpcErrorData }).errorData;
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
