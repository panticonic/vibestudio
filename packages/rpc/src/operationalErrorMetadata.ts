export function errorDataProperty(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    // Error identifiers may be inherited, but observing a failure must never
    // execute an accessor supplied by the failed operation.
    let current: object | null = value;
    for (let depth = 0; current && depth < 6; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
      current = Object.getPrototypeOf(current);
    }
  } catch {
    // Proxies and foreign errors need not expose descriptors safely.
  }
  return undefined;
}

export type OperationalErrorMetadata = {
  readonly name?: string;
  readonly code?: string;
  readonly syscall?: string;
  readonly phase?:
    | "dns"
    | "connect"
    | "fetch-head"
    | "response-body"
    | "websocket-upgrade"
    | "socket";
  readonly address?: string;
  readonly port?: number;
  readonly errno?: number;
  readonly cause?: OperationalErrorMetadata;
  readonly errors?: readonly OperationalErrorMetadata[];
  readonly circular?: true;
  readonly truncated?: true;
};

/** Only protocol error identifiers; error messages/stacks may contain request data. */
export function operationalErrorMetadata(error: unknown): OperationalErrorMetadata {
  const seen = new Set<object>();
  let remaining = 8;
  const identifier = (value: unknown): string | undefined =>
    typeof value === "string" && value.length <= 80 && /^[A-Za-z][A-Za-z0-9_]*$/u.test(value)
      ? value
      : undefined;
  const visit = (value: unknown, depth: number): OperationalErrorMetadata => {
    if (!value || typeof value !== "object") return {};
    if (seen.has(value)) return { circular: true };
    if (depth >= 4 || remaining-- <= 0) return { truncated: true };
    seen.add(value);
    const system = errorDataProperty(value, "systemError");
    const systemField = (key: string) =>
      system && typeof system === "object" ? errorDataProperty(system, key) : undefined;
    const name = identifier(errorDataProperty(value, "name"));
    const code = identifier(errorDataProperty(value, "code")) ?? identifier(systemField("code"));
    const syscall =
      identifier(errorDataProperty(value, "syscall")) ?? identifier(systemField("syscall"));
    const rawPhase = errorDataProperty(value, "phase");
    const phase =
      typeof rawPhase === "string" &&
      ["dns", "connect", "fetch-head", "response-body", "websocket-upgrade", "socket"].includes(
        rawPhase
      )
        ? (rawPhase as OperationalErrorMetadata["phase"])
        : undefined;
    const rawAddress = errorDataProperty(value, "address") ?? systemField("address");
    const address =
      typeof rawAddress === "string" &&
      (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(rawAddress)
        ? rawAddress.split(".").every((x) => Number(x) <= 255)
        : /^[A-Fa-f0-9:]{2,64}$/.test(rawAddress) && rawAddress.includes(":"))
        ? rawAddress
        : undefined;
    const rawPort = errorDataProperty(value, "port") ?? systemField("port");
    const port =
      typeof rawPort === "number" && Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535
        ? rawPort
        : undefined;
    const rawErrno = errorDataProperty(value, "errno") ?? systemField("errno");
    const errno =
      typeof rawErrno === "number" && Number.isSafeInteger(rawErrno) ? rawErrno : undefined;
    const cause = errorDataProperty(value, "cause") ?? errorDataProperty(value, "error");
    const errors = errorDataProperty(value, "errors");
    return {
      ...(name ? { name } : {}),
      ...(code ? { code } : {}),
      ...(syscall ? { syscall } : {}),
      ...(phase ? { phase } : {}),
      ...(address ? { address } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(errno !== undefined ? { errno } : {}),
      ...(cause && typeof cause === "object" ? { cause: visit(cause, depth + 1) } : {}),
      ...(Array.isArray(errors)
        ? {
            errors: errorArrayItems(errors, 3).map((item) => visit(item, depth + 1)),
            ...((errorDataProperty(errors, "length") as number) > 3
              ? { truncated: true as const }
              : {}),
          }
        : {}),
    };
  };
  try {
    return visit(error, 0);
  } catch {
    return {};
  }
}

/** Array entries are observed without invoking indexed accessors or array methods. */
export function errorArrayItems(value: unknown, limit = Number.POSITIVE_INFINITY): unknown[] {
  if (!Array.isArray(value)) return [];
  const length = errorDataProperty(value, "length");
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return [];
  const out: unknown[] = [];
  for (let index = 0; index < Math.min(length, limit); index++) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (item && "value" in item) out.push(item.value);
  }
  return out;
}
