export function decodePanelStateArgs(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored panel stateArgs must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * RFC 7386 JSON merge patch. Objects merge recursively; `null` deletes a key;
 * every other value (arrays included) replaces the target value wholesale.
 */
export function applyJsonMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const result: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else
      Object.defineProperty(result, key, {
        value: applyJsonMergePatch(Object.hasOwn(result, key) ? result[key] : undefined, value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return result;
}

/**
 * The RFC 7386 merge patch that turns `from` into `to`: keys absent from `to`
 * become `null`, nested objects diff recursively, and every other changed value
 * (arrays included) is carried whole. Use it to replace a nested object, whose
 * plain patch would otherwise merge into the stored value and keep stale keys.
 */
export function createJsonMergePatch(from: unknown, to: unknown): unknown {
  if (!isPlainObject(from) || !isPlainObject(to)) return to === undefined ? null : to;
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(from)) {
    if (!Object.hasOwn(to, key) || to[key] === undefined) {
      Object.defineProperty(patch, key, {
        value: null,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  for (const [key, value] of Object.entries(to)) {
    if (value === undefined) continue;
    const previous = Object.hasOwn(from, key) ? from[key] : undefined;
    if (isPlainObject(previous) && isPlainObject(value)) {
      const nested = createJsonMergePatch(previous, value) as Record<string, unknown>;
      if (Object.keys(nested).length > 0) {
        Object.defineProperty(patch, key, {
          value: nested,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    } else if (JSON.stringify(previous) !== JSON.stringify(value)) {
      Object.defineProperty(patch, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return patch;
}

export const PANEL_STATE_ARGS_CONFLICT_CODE = "PANEL_STATE_ARGS_CONFLICT" as const;

/**
 * The panel's current history entry or active build changed between resolving
 * the validation schema and applying a stateArgs patch. The patch was not
 * applied: it was addressed to a panel state that no longer exists.
 */
export class PanelStateArgsConflictError extends Error {
  readonly code = PANEL_STATE_ARGS_CONFLICT_CODE;
  constructor(
    readonly slotId: string,
    readonly conflict: { field: "entryKey" | "activeBuildKey"; expected: unknown; actual: unknown }
  ) {
    super(
      `stateArgs patch for ${slotId} conflicted: ${conflict.field} expected=${JSON.stringify(
        conflict.expected
      )} actual=${JSON.stringify(conflict.actual)}`
    );
    this.name = "PanelStateArgsConflictError";
  }
}

/** Apply one merge patch to a panel's stateArgs object. */
export function applyStateArgsMergePatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  if (!isPlainObject(patch)) throw new Error("stateArgs patch must be a JSON object");
  return applyJsonMergePatch(current, patch) as Record<string, unknown>;
}
