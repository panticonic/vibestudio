export const TERMINAL_CONTROL_PROTOCOL_VERSION = 1 as const;

export type TerminalNotificationSeverity =
  | "info"
  | "done"
  | "waiting"
  | "approval"
  | "failure";

export type TerminalControlOperation =
  | { kind: "list" }
  | { kind: "badge"; text: string; color?: string }
  | { kind: "label"; label: string }
  | { kind: "meta-set"; key: string; value: unknown }
  | { kind: "meta-get"; key: string }
  | { kind: "meta-delete"; key: string }
  | {
      kind: "notify";
      severity: TerminalNotificationSeverity;
      title: string;
      message: string;
    }
  | { kind: "send"; targetSessionId: string; text: string }
  | { kind: "split"; direction: "row" | "column"; command?: string }
  | { kind: "open"; url: string };

export interface TerminalControlRequest {
  protocolVersion: typeof TERMINAL_CONTROL_PROTOCOL_VERSION;
  hostBuildId: string;
  pid: number;
  operation: TerminalControlOperation;
}

export type TerminalControlResponse =
  | { ok: true; stdout?: string }
  | { ok: false; error: string };

export function parseTerminalControlRequest(value: unknown): TerminalControlRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("terminal-control request must be an object");
  }
  const request = value as Partial<TerminalControlRequest>;
  if (request.protocolVersion !== TERMINAL_CONTROL_PROTOCOL_VERSION) {
    throw new Error("unsupported terminal-control protocol");
  }
  if (
    typeof request.hostBuildId !== "string" ||
    !/^[0-9a-f]{64}$/.test(request.hostBuildId)
  ) {
    throw new Error("terminal-control request requires a full host build digest");
  }
  if (!Number.isInteger(request.pid) || Number(request.pid) <= 0) {
    throw new Error("terminal-control request has an invalid process identity");
  }
  if (!request.operation || typeof request.operation !== "object") {
    throw new Error("terminal-control request has no typed operation");
  }
  assertOperation(request.operation);
  return request as TerminalControlRequest;
}

function assertOperation(value: object): asserts value is TerminalControlOperation {
  const operation = value as Record<string, unknown>;
  const kind = operation["kind"];
  switch (kind) {
    case "list":
      assertKeys(operation, ["kind"]);
      return;
    case "badge":
      assertKeys(operation, ["kind", "text"], ["color"]);
      assertString(operation["text"], "badge text");
      if (operation["color"] !== undefined) assertString(operation["color"], "badge color");
      return;
    case "label":
      assertKeys(operation, ["kind", "label"]);
      assertString(operation["label"], "terminal label");
      return;
    case "meta-set":
      assertKeys(operation, ["kind", "key", "value"]);
      assertNonEmptyString(operation["key"], "metadata key");
      assertJsonValue(operation["value"], "metadata value");
      return;
    case "meta-get":
    case "meta-delete":
      assertKeys(operation, ["kind", "key"]);
      assertNonEmptyString(operation["key"], "metadata key");
      return;
    case "notify":
      assertKeys(operation, ["kind", "severity", "title", "message"]);
      if (
        operation["severity"] !== "info" &&
        operation["severity"] !== "done" &&
        operation["severity"] !== "waiting" &&
        operation["severity"] !== "approval" &&
        operation["severity"] !== "failure"
      ) {
        throw new Error("terminal notification has an invalid severity");
      }
      assertString(operation["title"], "notification title");
      assertString(operation["message"], "notification message");
      return;
    case "send":
      assertKeys(operation, ["kind", "targetSessionId", "text"]);
      assertNonEmptyString(operation["targetSessionId"], "target session identity");
      assertString(operation["text"], "terminal input");
      return;
    case "split":
      assertKeys(operation, ["kind", "direction"], ["command"]);
      if (operation["direction"] !== "row" && operation["direction"] !== "column") {
        throw new Error("terminal split has an invalid direction");
      }
      if (operation["command"] !== undefined) {
        assertString(operation["command"], "terminal split command");
      }
      return;
    case "open":
      assertKeys(operation, ["kind", "url"]);
      assertNonEmptyString(operation["url"], "URL");
      return;
    default:
      throw new Error(`unknown terminal-control operation: ${String(kind)}`);
  }
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) throw new Error(`terminal-control operation has unknown field: ${extra}`);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) throw new Error(`terminal-control operation is missing field: ${missing}`);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!value) throw new Error(`${label} must not be empty`);
}

function assertJsonValue(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain finite numbers`);
    return;
  }
  if (!value || typeof value !== "object") throw new Error(`${label} must be JSON-compatible`);
  if (seen.has(value)) throw new Error(`${label} must not be cyclic`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (!key || item === undefined) throw new Error(`${label} must be JSON-compatible`);
      assertJsonValue(item, label, seen);
    }
  }
  seen.delete(value);
}
