export type SystemTestJsonValue =
  | null
  | boolean
  | number
  | string
  | SystemTestJsonValue[]
  | { [key: string]: SystemTestJsonValue };

/** A bounded, artifact-safe projection of a thrown value. Only explicitly
 * structured error fields cross this boundary. */
export interface StructuredSystemTestError {
  name: string;
  message: string;
  code?: string;
  errorKind?: string;
  errorData?: SystemTestJsonValue;
  /** Opaque diagnostic handles copied from errorData for direct artifact search. */
  diagnosticHandles?: string[];
}

export interface SystemTestFailure {
  phase: string;
  error: StructuredSystemTestError;
}

const MAX_TEXT_LENGTH = 4_096;
const MAX_DEPTH = 8;
const MAX_COLLECTION_SIZE = 200;
const REDACTED = "[redacted]";
const UNAVAILABLE = "[unavailable]";
const SENSITIVE_KEY =
  /(?:password|passphrase|secret|token|authorization|cookie|credential|api[-_]?key|private[-_]?key|session[-_]?key)/i;
const DIAGNOSTIC_HANDLE_KEY = /^(?:diagnostic[-_]?handle|handle)$/i;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor", "stack", "cause"]);

export function serializeSystemTestError(error: unknown): StructuredSystemTestError {
  const record = objectRecord(error);
  const name =
    boundedString(readDataProperty(record, "name")) ??
    (error instanceof Error ? "Error" : "ThrownValue");
  const message =
    boundedString(readDataProperty(record, "message")) ??
    (typeof error === "string" ? boundedText(error) : safeThrownValueSummary(error));
  const errorData = sanitizeJson(readDataProperty(record, "errorData"));
  const explicitCode = boundedString(readDataProperty(record, "code"));
  const dataCode =
    errorData && !Array.isArray(errorData) && typeof errorData === "object"
      ? boundedString(errorData["code"])
      : undefined;
  const code = explicitCode ?? dataCode;
  const errorKind = boundedString(readDataProperty(record, "errorKind"));
  const diagnosticHandles = errorData ? collectDiagnosticHandles(errorData) : [];

  return {
    name: name || "Error",
    message,
    ...(code ? { code } : {}),
    ...(errorKind ? { errorKind } : {}),
    ...(errorData !== undefined ? { errorData } : {}),
    ...(diagnosticHandles.length > 0 ? { diagnosticHandles } : {}),
  };
}

export function systemTestFailure(phase: string, error: unknown): SystemTestFailure {
  return { phase, error: serializeSystemTestError(error) };
}

function sanitizeJson(value: unknown): SystemTestJsonValue | undefined {
  return sanitizeJsonValue(value, 0, new WeakSet<object>());
}

function sanitizeJsonValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>
): SystemTestJsonValue | undefined {
  if (value === null) return null;
  if (typeof value === "string") return boundedText(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value !== "object") return undefined;
  if (depth >= MAX_DEPTH) return "[max-depth]";
  if (ancestors.has(value)) return "[circular]";

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: SystemTestJsonValue[] = [];
      const length = Math.min(value.length, MAX_COLLECTION_SIZE);
      for (let index = 0; index < length; index += 1) {
        const item = readArrayDataProperty(value, index);
        result.push(sanitizeJsonValue(item, depth + 1, ancestors) ?? null);
      }
      if (value.length > MAX_COLLECTION_SIZE) result.push("[truncated]");
      return result;
    }

    const descriptors = ownPropertyDescriptors(value);
    if (!descriptors) return UNAVAILABLE;
    const result: Record<string, SystemTestJsonValue> = {};
    let included = 0;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || FORBIDDEN_KEYS.has(key)) continue;
      if (included >= MAX_COLLECTION_SIZE) {
        result["$truncated"] = true;
        break;
      }
      included += 1;
      if (SENSITIVE_KEY.test(key)) {
        result[key] = REDACTED;
        continue;
      }
      if (!("value" in descriptor)) {
        result[key] = UNAVAILABLE;
        continue;
      }
      const item = sanitizeJsonValue(descriptor.value, depth + 1, ancestors);
      if (item !== undefined) result[key] = item;
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function collectDiagnosticHandles(value: SystemTestJsonValue): string[] {
  const handles = new Set<string>();
  const visit = (item: SystemTestJsonValue): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (DIAGNOSTIC_HANDLE_KEY.test(key) && typeof child === "string" && child.length > 0) {
        handles.add(child);
      }
      visit(child);
    }
  };
  visit(value);
  return [...handles].sort();
}

function objectRecord(value: unknown): object | null {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? (value as object)
    : null;
}

function readDataProperty(record: object | null, key: string): unknown {
  if (!record) return undefined;
  try {
    for (let current: object | null = record; current; current = Object.getPrototypeOf(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor) continue;
      return "value" in descriptor ? descriptor.value : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readArrayDataProperty(value: unknown[], index: number): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function ownPropertyDescriptors(value: object): PropertyDescriptorMap | null {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
}

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" ? boundedText(value) : undefined;
}

function boundedText(value: string): string {
  const redacted = value
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_=-]{8,}\b/g, REDACTED)
    .replace(
      /(\b(?:password|passphrase|secret|token|authorization|cookie|credential|api[-_]?key|private[-_]?key)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      `$1${REDACTED}`
    );
  return redacted.length <= MAX_TEXT_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_TEXT_LENGTH - 13)}...[truncated]`;
}

function safeThrownValueSummary(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return boundedText(String(value));
  }
  return "Non-Error value thrown";
}
