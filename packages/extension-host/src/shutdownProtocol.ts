export interface ShutdownError {
  name: string;
  message: string;
  stack?: string;
  cause?: ShutdownError;
  errors?: ShutdownError[];
}
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
  return (
    value.ok === true || (value.ok === false && "error" in value && isShutdownError(value.error))
  );
}

function isShutdownError(value: unknown): value is ShutdownError {
  return (
    !!value &&
    typeof value === "object" &&
    "name" in value &&
    typeof value.name === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    (!("stack" in value) || typeof value.stack === "string") &&
    (!("cause" in value) || isShutdownError(value.cause)) &&
    (!("errors" in value) || (Array.isArray(value.errors) && value.errors.every(isShutdownError)))
  );
}

export function shutdownError(error: unknown, ancestors = new Set<unknown>()): ShutdownError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const record: ShutdownError = {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  };
  if (ancestors.has(error)) return record;
  const next = new Set(ancestors).add(error);
  if (error.cause !== undefined) record.cause = shutdownError(error.cause, next);
  if (error instanceof AggregateError)
    record.errors = Array.from(error.errors, (item) => shutdownError(item, next));
  return record;
}

export function restoreShutdownError(record: ShutdownError): Error {
  const options = record.cause ? { cause: restoreShutdownError(record.cause) } : undefined;
  const error = record.errors
    ? new AggregateError(record.errors.map(restoreShutdownError), record.message, options)
    : new Error(record.message, options);
  error.name = record.name;
  if (record.stack) error.stack = record.stack;
  return error;
}
