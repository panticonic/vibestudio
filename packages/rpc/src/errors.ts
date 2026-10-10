import type { RpcErrorData, RpcErrorKind, RpcFailure, RpcFailureReference } from "./types.js";
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
  const reasonCode = (error as { errorData?: { authorityFailure?: { reasonCode?: unknown } } })
    .errorData?.authorityFailure?.reasonCode;
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

/** Preserve the cancelling owner's reason at the local RPC boundary. */
export function rpcCallerAbortedError(reason?: unknown): Error & { code: typeof RPC_ABORTED_CODE } {
  return Object.assign(new Error("RPC call aborted by caller", { cause: reason }), {
    code: RPC_ABORTED_CODE,
  });
}

/** True only for cancellation caused by this exact owner, including pure aggregate cancellation. */
export function isRpcAbortedBy(error: unknown, reason: unknown): boolean {
  if (reason === undefined) return false;
  const visited = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (value === reason) return true;
    if (!value || typeof value !== "object" || visited.has(value)) return false;
    visited.add(value);
    try {
      const fields = value as { cause?: unknown; errors?: unknown[] };
      if (Array.isArray(fields.errors)) {
        return (
          fields.errors.length > 0 &&
          fields.errors.every(visit) &&
          (fields.cause === undefined || visit(fields.cause))
        );
      }
      return isRpcAborted(value) && fields.cause === reason;
    } finally {
      visited.delete(value);
    }
  };
  return visit(error);
}

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

/**
 * A panel session was refused because the panel runtime lease belongs to a
 * different connection. Raised while a lease moves — a reconnect re-leasing a
 * panel, a handoff between holders — and resolved by the holder's next attempt.
 */
export const PANEL_RUNTIME_LEASED_CODE = "panel_runtime_leased" as const;

/**
 * True when a call failed only because it raced a panel runtime lease moving.
 * Like {@link isRpcAborted}, this separates a self-healing transition from a
 * defect: logged as an error it reads as a broken panel and, in the desktop
 * smoke, fails a run whose panel recovered on its very next poll.
 */
export function isPanelRuntimeLeaseConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === PANEL_RUNTIME_LEASED_CODE) return true;
  // Boundary-crossed copies keep the lower code in `errorCode` (see RemoteRpcError).
  return (error as { errorCode?: unknown }).errorCode === PANEL_RUNTIME_LEASED_CODE;
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

/** Product observation identity is separate from application-owned errorData.
 * A WeakMap keeps even frozen domain exceptions untouched; wire owners serialize this identity explicitly.
 */
const diagnosticOrigins = new WeakMap<object, string>();
export function rpcDiagnosticIdOf(error: unknown): string | undefined {
  const visited = new Set<object>();
  while (error && typeof error === "object" && !visited.has(error)) {
    visited.add(error);
    const value = diagnosticOrigins.get(error);
    if (value) return value;
    error = (error as { cause?: unknown }).cause;
  }
  return undefined;
}
export function attachRpcDiagnosticId(error: unknown, id: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) return;
  if (error && typeof error === "object" && !rpcDiagnosticIdOf(error))
    diagnosticOrigins.set(error, id);
}

/** Aggregate failures retain the native AggregateError contract remotely. */
export class RemoteRpcAggregateError extends AggregateError {
  constructor(
    errors: unknown[],
    message: string,
    public readonly errorKind: RpcErrorKind,
    public readonly code?: string,
    public readonly errorData?: RpcErrorData
  ) {
    super(errors, message);
  }
}

export function isRemoteRpcError(
  error: unknown
): error is RemoteRpcError | RemoteRpcAggregateError {
  return error instanceof RemoteRpcError || error instanceof RemoteRpcAggregateError;
}

/** Serialize the complete failure graph once, at the boundary which owns it. */
export function serializeRpcFailure(
  error: unknown,
  fallback: RpcErrorKind = "application"
): RpcFailure {
  const seen = new Map<object, number>();
  const visit = (value: unknown): RpcFailure | RpcFailureReference => {
    if (value === null || typeof value !== "object")
      return { message: String(value), errorKind: fallback };
    const previous = seen.get(value);
    if (previous !== undefined) return { reference: previous };
    const id = seen.size;
    seen.set(value, id);
    const fields = value as {
      message?: unknown;
      name?: unknown;
      stack?: unknown;
      code?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    return {
      id,
      message: typeof fields.message === "string" ? fields.message : String(value),
      errorKind: rpcErrorKindOf(value, fallback),
      ...(typeof fields.name === "string" ? { name: fields.name } : {}),
      ...(typeof fields.stack === "string" ? { stack: fields.stack } : {}),
      ...(typeof fields.code === "string" ? { code: fields.code } : {}),
      ...(rpcErrorDataOf(value) !== undefined ? { errorData: rpcErrorDataOf(value) } : {}),
      ...(rpcDiagnosticIdOf(value) ? { diagnosticId: rpcDiagnosticIdOf(value) } : {}),
      ...("cause" in value ? { cause: visit(fields.cause) } : {}),
      ...(Array.isArray(fields.errors) ? { errors: fields.errors.map(visit) } : {}),
    };
  };
  return visit(error) as RpcFailure;
}

/** Restore causes, aggregate children and their identity on the waiting side. */
export function deserializeRpcFailure(failure: unknown): RemoteRpcError | RemoteRpcAggregateError {
  const restored = new Map<number, RemoteRpcError | RemoteRpcAggregateError>();
  const invalid = (detail: string): never => {
    throw new RemoteRpcError(`Invalid RPC failure: ${detail}`, "protocol");
  };
  const visit = (input: unknown): RemoteRpcError | RemoteRpcAggregateError => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      return invalid("expected an object");
    const node = input as RpcFailure | RpcFailureReference;
    if ("reference" in node) {
      const existing = restored.get(node.reference);
      if (!existing) return invalid(`unknown reference ${node.reference}`);
      return existing;
    }
    if (
      typeof node.message !== "string" ||
      !["access", "service", "transport", "protocol", "application", "internal"].includes(
        node.errorKind
      )
    )
      return invalid("missing message or errorKind");
    for (const key of ["name", "stack", "code", "diagnosticId"] as const) {
      if (node[key] !== undefined && typeof node[key] !== "string")
        return invalid(`${key} must be a string`);
    }
    if (
      node.id !== undefined &&
      (!Number.isSafeInteger(node.id) || node.id < 0 || restored.has(node.id))
    )
      return invalid(`invalid or repeated id ${node.id}`);
    if (node.errors !== undefined && !Array.isArray(node.errors))
      return invalid("errors must be an array");
    const error =
      node.errors !== undefined
        ? new RemoteRpcAggregateError([], node.message, node.errorKind, node.code, node.errorData)
        : new RemoteRpcError(node.message, node.errorKind, node.code, node.errorData);
    if (node.id !== undefined) restored.set(node.id, error);
    if (node.name !== undefined) error.name = node.name;
    if (node.stack !== undefined) error.stack = node.stack;
    if (node.diagnosticId !== undefined) attachRpcDiagnosticId(error, node.diagnosticId);
    if (node.cause !== undefined)
      Object.defineProperty(error, "cause", {
        value: visit(node.cause),
        writable: true,
        configurable: true,
      });
    if (node.errors !== undefined)
      (error as RemoteRpcAggregateError).errors.push(...node.errors.map(visit));
    return error;
  };
  return visit(failure);
}

/** Render the failure graph rather than discarding it at a UI/logging boundary. */
export function formatRpcFailure(error: unknown): string {
  const seen = new Set<object>();
  const visit = (value: unknown): string => {
    if (value === null || typeof value !== "object") return String(value);
    if (seen.has(value)) return "";
    seen.add(value);
    const fields = value as { message?: unknown; cause?: unknown; errors?: unknown };
    const message = typeof fields.message === "string" ? fields.message : String(value);
    const details = [
      ...(Array.isArray(fields.errors) ? fields.errors.map(visit) : []),
      ...("cause" in value ? [visit(fields.cause)] : []),
    ].filter(Boolean);
    return details.length === 0 ? message : `${message}: ${details.join("; ")}`;
  };
  return visit(error);
}
