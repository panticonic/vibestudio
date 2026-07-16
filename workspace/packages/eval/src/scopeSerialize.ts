/**
 * scopeSerialize — Recursive per-property serializer for REPL scope.
 *
 * Keeps data leaves and, when the host supplies an executable codec, stores
 * source-reconstructible functions as run-neutral records. Handles type-tagged
 * values (Date, Map, Set, RegExp), circular references, and max depth.
 */

// Depth is a safety/perf bound only — circular refs are handled separately by `seen`, so it can be
// generous; deeply-nested legitimate data (e.g. test-result trees) is preserved, not truncated.
const MAX_DEPTH = 100;
/** Top-level values larger than this spill to the content-addressed blob store (never dropped). */
const SPILL_THRESHOLD_CHARS = 128 * 1024;
/** Inline (in-row) scope budget — the largest remaining values spill until the row fits comfortably
 *  under the DO-SQLite per-value limit. */
const MAX_INLINE_TOTAL_CHARS = 256 * 1024;
/** Diagnostic cap: bounds the `dropped_paths` record so a pathological value can't overflow it. */
const MAX_DROPPED_ENTRIES = 200;
const MAX_EXECUTABLES = 256;
const MAX_EXECUTABLE_SOURCE_CHARS = 4 * 1024 * 1024;

/**
 * Marker for a spilled top-level value: `{ [SCOPE_BLOB_REF]: <digest>, bytes }`. On hydrate, the
 * blob's content replaces it inline. Distinctive to avoid colliding with user data.
 */
export const SCOPE_BLOB_REF = "__vibestudioScopeBlob__";

/** A top-level value too large to inline — its serialized JSON is stored in the blob store and the
 *  placeholder (embedded in `serialized`) gets the content digest stamped in by `persist`. */
export interface ScopeSpill {
  placeholder: Record<string, unknown>;
  valueJson: string;
  bytes: number;
  key: string;
}

export interface SerializedScope {
  /** The scope object; large top-level values are replaced by blob-ref placeholders. */
  serialized: Record<string, unknown>;
  /** Large values to store in the blob store (the caller stamps each placeholder's digest). */
  spills: ScopeSpill[];
  /** Top-level keys that were fully serialized (incl. losslessly spilled). */
  serializedKeys: string[];
  /** Paths that were dropped, with reasons (functions/symbols/circular/depth — bounded). */
  droppedPaths: Array<{ path: string; reason: string }>;
  /** Top-level keys that were only partially serialized. */
  partialKeys: string[];
}

/**
 * Durable identity for a source-reconstructible function. The host, rather
 * than the generic scope package, owns compilation and invocation so a
 * restored function can be rebound to the CURRENT run's authority.
 */
export interface SerializedScopeExecutable {
  source: string;
  definitionSourceDigest: string;
  definitionRunDigest: string;
}

export interface ScopeExecutableCodec {
  serialize(value: (...args: unknown[]) => unknown, path: string): SerializedScopeExecutable | null;
  deserialize(value: SerializedScopeExecutable, path: string): (...args: unknown[]) => unknown;
}

/** A spilled-value placeholder produced by `serializeScope` (top-level only). */
export function isScopeBlobRef(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[SCOPE_BLOB_REF] === "string"
  );
}

// ---------------------------------------------------------------------------
// Type-tagged envelope for round-trip fidelity
// ---------------------------------------------------------------------------

interface TypeTagged {
  __t: string;
  v: unknown;
}

function isTypeTagged(val: unknown): val is TypeTagged {
  return (
    typeof val === "object" &&
    val !== null &&
    "__t" in val &&
    typeof (val as TypeTagged).__t === "string"
  );
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

type DroppedEntry = { path: string; reason: string };
type SerializedTopLevelEntry = {
  key: string;
  value: unknown;
  jsonChars: number;
};
type SerializationBudget = { executables: number; executableSourceChars: number };

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function serializeValue(
  val: unknown,
  path: string,
  dropped: DroppedEntry[],
  seen: Set<unknown>,
  depth: number,
  executableCodec?: ScopeExecutableCodec,
  budget?: SerializationBudget
): unknown {
  // Max depth
  if (depth > MAX_DEPTH) {
    dropped.push({ path, reason: "max depth exceeded" });
    return undefined;
  }

  // Primitives
  if (val === null || val === undefined) return val;
  const t = typeof val;
  if (t === "string" || t === "number" || t === "boolean") return val;
  if (t === "bigint") return { __t: "BigInt", v: val.toString() };

  // Executable values are host-owned. A codec serializes only functions it can
  // reconstruct without retaining a prior run's closures or credentials.
  if (t === "function") {
    const executable = executableCodec?.serialize(val as (...args: unknown[]) => unknown, path);
    if (executable) {
      const current = budget ?? { executables: 0, executableSourceChars: 0 };
      current.executables += 1;
      current.executableSourceChars += executable.source.length;
      if (
        current.executables > MAX_EXECUTABLES ||
        current.executableSourceChars > MAX_EXECUTABLE_SOURCE_CHARS
      ) {
        throw Object.assign(new Error("Persistent scope executable budget exceeded"), {
          code: "EVAL_RESOURCE_LIMIT",
        });
      }
      return { __t: "ExecutableFunctionV1", v: executable };
    }
    dropped.push({ path, reason: "function" });
    return undefined;
  }
  if (t === "symbol") {
    dropped.push({ path, reason: "symbol" });
    return undefined;
  }

  // Circular reference check
  if (typeof val === "object" && val !== null) {
    if (seen.has(val)) {
      dropped.push({ path, reason: "circular" });
      return undefined;
    }
    seen.add(val);
  }

  try {
    // Type-tagged values
    if (val instanceof Date) {
      return { __t: "Date", v: val.toISOString() };
    }
    if (val instanceof RegExp) {
      return { __t: "RegExp", v: { source: val.source, flags: val.flags } };
    }
    if (val instanceof Map) {
      const entries: [unknown, unknown][] = [];
      let i = 0;
      for (const [k, v] of val) {
        const kSer = serializeValue(
          k,
          `${path}[Map key ${i}]`,
          dropped,
          seen,
          depth + 1,
          executableCodec,
          budget
        );
        const vSer = serializeValue(
          v,
          `${path}[Map value ${i}]`,
          dropped,
          seen,
          depth + 1,
          executableCodec,
          budget
        );
        entries.push([kSer, vSer]);
        i++;
      }
      return { __t: "Map", v: entries };
    }
    if (val instanceof Set) {
      const items: unknown[] = [];
      let i = 0;
      for (const item of val) {
        const ser = serializeValue(
          item,
          `${path}[Set ${i}]`,
          dropped,
          seen,
          depth + 1,
          executableCodec,
          budget
        );
        items.push(ser);
        i++;
      }
      return { __t: "Set", v: items };
    }

    // WeakMap, WeakSet — drop
    if (val instanceof WeakMap || val instanceof WeakSet) {
      dropped.push({ path, reason: val.constructor.name });
      return undefined;
    }
    // WeakRef — may not exist in all targets, check by constructor name
    if (val.constructor?.name === "WeakRef") {
      dropped.push({ path, reason: "WeakRef" });
      return undefined;
    }

    // Arrays
    if (Array.isArray(val)) {
      const result: unknown[] = [];
      for (let i = 0; i < val.length; i++) {
        const elemPath = `${path}[${i}]`;
        const ser = serializeValue(
          val[i],
          elemPath,
          dropped,
          seen,
          depth + 1,
          executableCodec,
          budget
        );
        result.push(ser !== undefined ? ser : null);
      }
      return result;
    }

    // Plain objects
    if (isPlainObject(val)) {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(val)) {
        const childPath = path ? `${path}.${key}` : key;
        const ser = serializeValue(
          val[key],
          childPath,
          dropped,
          seen,
          depth + 1,
          executableCodec,
          budget
        );
        if (ser !== undefined) {
          result[key] = ser;
        }
      }
      return result;
    }

    // Class instances — drop (prototype not Object.prototype/null)
    dropped.push({ path, reason: `class instance (${val.constructor?.name ?? "unknown"})` });
    return undefined;
  } finally {
    if (typeof val === "object" && val !== null) {
      seen.delete(val);
    }
  }
}

export function serializeScope(
  scope: Map<string, unknown>,
  executableCodec?: ScopeExecutableCodec
): SerializedScope {
  const dropped: DroppedEntry[] = [];
  const entries: SerializedTopLevelEntry[] = [];
  const budget: SerializationBudget = { executables: 0, executableSourceChars: 0 };

  for (const [key, value] of scope) {
    const ser = serializeValue(value, key, dropped, new Set(), 0, executableCodec, budget);
    if (ser !== undefined) {
      entries.push({ key, value: ser, jsonChars: serializedJsonChars(ser) });
    }
  }

  // Decide which top-level values SPILL to the content-addressed blob store (lossless) rather than
  // being inlined in the scope row: any value over the per-value threshold, plus the largest
  // remaining values if the inline total is still over budget. (Previously such values were DROPPED.)
  const spillKeys = new Set<string>();
  for (const e of entries) if (e.jsonChars > SPILL_THRESHOLD_CHARS) spillKeys.add(e.key);
  let inlineTotal = entries
    .filter((e) => !spillKeys.has(e.key))
    .reduce((sum, e) => sum + e.jsonChars, 0);
  if (inlineTotal > MAX_INLINE_TOTAL_CHARS) {
    for (const e of entries
      .filter((x) => !spillKeys.has(x.key))
      .sort((a, b) => b.jsonChars - a.jsonChars)) {
      spillKeys.add(e.key);
      inlineTotal -= e.jsonChars;
      if (inlineTotal <= MAX_INLINE_TOTAL_CHARS) break;
    }
  }

  const serialized: Record<string, unknown> = {};
  const spills: ScopeSpill[] = [];
  for (const e of entries) {
    if (spillKeys.has(e.key)) {
      const placeholder: Record<string, unknown> = { [SCOPE_BLOB_REF]: "", bytes: e.jsonChars };
      serialized[e.key] = placeholder;
      spills.push({
        placeholder,
        valueJson: JSON.stringify(e.value),
        bytes: e.jsonChars,
        key: e.key,
      });
    } else {
      serialized[e.key] = e.value;
    }
  }

  // Bound the dropped-paths diagnostic so a pathological structure can't overflow the column.
  if (dropped.length > MAX_DROPPED_ENTRIES) {
    const omitted = dropped.length - MAX_DROPPED_ENTRIES;
    dropped.length = MAX_DROPPED_ENTRIES;
    dropped.push({ path: "(truncated)", reason: `${omitted} more dropped paths omitted` });
  }

  // serializedKeys = fully-preserved top-level keys (spilled values are lossless, so they count);
  // partialKeys = keys with some internal drops (functions/circular/depth).
  const serializedKeys: string[] = [];
  const partialKeys: string[] = [];
  for (const key of scope.keys()) {
    if (!(key in serialized)) continue; // not serializable at all (already in droppedPaths)
    const hasDrops = dropped.some(
      (d) => d.path === key || d.path.startsWith(key + ".") || d.path.startsWith(key + "[")
    );
    (hasDrops ? partialKeys : serializedKeys).push(key);
  }

  return { serialized, spills, serializedKeys, droppedPaths: dropped, partialKeys };
}

function serializedJsonChars(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

function deserializeValue(
  val: unknown,
  executableCodec?: ScopeExecutableCodec,
  path = ""
): unknown {
  if (val === null || val === undefined) return val;
  const t = typeof val;
  if (t === "string" || t === "number" || t === "boolean") return val;

  if (Array.isArray(val)) {
    return val.map((item, index) => deserializeValue(item, executableCodec, `${path}[${index}]`));
  }

  if (typeof val === "object" && val !== null) {
    // Type-tagged values
    if (isTypeTagged(val)) {
      switch (val.__t) {
        case "Date":
          return new Date(val.v as string);
        case "RegExp": {
          const rv = val.v as { source: string; flags: string };
          return new RegExp(rv.source, rv.flags);
        }
        case "Map": {
          const entries = val.v as [unknown, unknown][];
          return new Map(
            entries.map(([k, v], index) => [
              deserializeValue(k, executableCodec, `${path}[Map key ${index}]`),
              deserializeValue(v, executableCodec, `${path}[Map value ${index}]`),
            ])
          );
        }
        case "Set": {
          const items = val.v as unknown[];
          return new Set(
            items.map((item, index) =>
              deserializeValue(item, executableCodec, `${path}[Set ${index}]`)
            )
          );
        }
        case "BigInt":
          return BigInt(val.v as string);
        case "ExecutableFunctionV1":
          if (!executableCodec) {
            throw new Error(`Scope executable at ${path || "<root>"} requires an executable codec`);
          }
          return executableCodec.deserialize(val.v as SerializedScopeExecutable, path);
      }
    }

    // Plain object
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(val)) {
      const childPath = path ? `${path}.${key}` : key;
      result[key] = deserializeValue(child, executableCodec, childPath);
    }
    return result;
  }

  return val;
}

export function deserializeScope(
  json: string,
  executableCodec?: ScopeExecutableCodec
): Map<string, unknown> {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const map = new Map<string, unknown>();
  for (const [key, value] of Object.entries(parsed)) {
    map.set(key, deserializeValue(value, executableCodec, key));
  }
  return map;
}

/** Deserialize a single spilled value's JSON (the content stored in the blob store). */
export function deserializeScopeValue(
  json: string,
  executableCodec?: ScopeExecutableCodec
): unknown {
  return deserializeValue(JSON.parse(json), executableCodec);
}
