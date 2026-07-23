/** RFC-8785-shaped canonical JSON used for authority and mission digests. */

function normalize(value: unknown, stack: Set<object>): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" ? value.normalize("NFC") : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON rejects non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new Error(`Canonical JSON cannot encode ${typeof value}`);
  }
  if (value === undefined) return undefined;
  if (typeof value !== "object") throw new Error("Canonical JSON received an unsupported value");
  if (stack.has(value)) throw new Error("Canonical JSON rejects cyclic values");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((child) => {
        const normalized = normalize(child, stack);
        return normalized === undefined ? null : normalized;
      });
    }
    const source = value as Record<string, unknown>;
    const keyed = Object.keys(source).map((key) => ({ original: key, normalized: key.normalize("NFC") }));
    keyed.sort((left, right) => compareUtf8(left.normalized, right.normalized));
    const result: Record<string, unknown> = {};
    for (const key of keyed) {
      if (Object.prototype.hasOwnProperty.call(result, key.normalized)) {
        throw new Error(`Canonical JSON key collision after NFC normalization: ${key.normalized}`);
      }
      const child = normalize(source[key.original], stack);
      if (child !== undefined) result[key.normalized] = child;
    }
    return result;
  } finally {
    stack.delete(value);
  }
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const delta = a[index]! - b[index]!;
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

export function canonicalJson(value: unknown): string {
  const normalized = normalize(value, new Set());
  if (normalized === undefined) throw new Error("Canonical JSON root cannot be undefined");
  return JSON.stringify(normalized);
}
