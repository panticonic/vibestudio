/**
 * Panel expression evaluation — the shared half of `panelCdp.evaluate`
 * (quickfire-overlay-spec §5.3).
 *
 * Both CDP host providers (Electron `src/main/cdpHostProvider.ts` and
 * `apps/headless-host`) run the *same* wrapper around the caller's expression
 * and return the *same* serialized shape, so a caller cannot tell which host
 * answered. The wrapper does the serialization in-page because that is the only
 * place a live object graph exists; what crosses the wire is always a string.
 *
 * The bound here is an RPC/command bound, not authority. It exists so one
 * runaway expression cannot pin a host command slot open — nothing about how
 * long the caller may keep evaluating is decided by a clock.
 */

/** How long a single evaluation may run before the host abandons it. */
export const PANEL_EVALUATE_TIMEOUT_MS = 8_000;

/** Longest serialized value returned to the caller; longer values truncate. */
export const PANEL_EVALUATE_VALUE_LIMIT = 16_000;

export interface PanelEvaluateOptions {
  /** RPC bound in milliseconds. Defaults to {@link PANEL_EVALUATE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Serialized-value cap. Defaults to {@link PANEL_EVALUATE_VALUE_LIMIT}. */
  valueLimit?: number;
}

export interface PanelEvaluateResult {
  /** False when the expression threw, rejected, or ran past its bound. */
  ok: boolean;
  /** `typeof` of the produced value, `"error"` when it threw, `"timeout"` when bounded out. */
  type: string;
  /** Serialized value. Null when the expression did not produce one. */
  value: string | null;
  /** Thrown-error summary (message + first stack frames). Null on success. */
  error: string | null;
  /** True when {@link PanelEvaluateResult.value} was cut at the limit. */
  truncated: boolean;
}

export function panelEvaluateTimeoutMs(options?: PanelEvaluateOptions): number {
  const requested = options?.timeoutMs;
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? Math.min(requested, PANEL_EVALUATE_TIMEOUT_MS)
    : PANEL_EVALUATE_TIMEOUT_MS;
}

export function panelEvaluateValueLimit(options?: PanelEvaluateOptions): number {
  const requested = options?.valueLimit;
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), PANEL_EVALUATE_VALUE_LIMIT)
    : PANEL_EVALUATE_VALUE_LIMIT;
}

/**
 * Wrap a caller expression so the page returns {@link PanelEvaluateResult}
 * rather than a live object. The expression is evaluated as an *expression*
 * (indirect eval), so `1 + 1` and `document.title` work the way a console does;
 * a rejected promise is awaited and reported as a thrown error.
 */
export function panelEvaluateExpression(expression: string, valueLimit: number): string {
  return `(async () => {
  const limit = ${JSON.stringify(valueLimit)};
  const serialize = (value) => {
    if (typeof value === "string") return value;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "undefined") return "undefined";
    if (typeof value === "function") return String(value);
    const seen = new WeakSet();
    try {
      return JSON.stringify(
        value,
        (_key, entry) => {
          if (typeof entry === "bigint") return entry.toString();
          if (typeof entry === "function") return "[Function]";
          if (entry && typeof entry === "object") {
            if (seen.has(entry)) return "[Circular]";
            seen.add(entry);
            if (entry instanceof Error) return entry.stack || entry.message;
            if (typeof Node !== "undefined" && entry instanceof Node) {
              return entry.outerHTML || entry.textContent || String(entry);
            }
          }
          return entry;
        },
        2
      ) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const cut = (text) =>
    text.length > limit
      ? { value: text.slice(0, limit), truncated: true }
      : { value: text, truncated: false };
  try {
    const produced = await (0, eval)(${JSON.stringify(expression)});
    const rendered = cut(serialize(produced));
    return {
      ok: true,
      type: produced === null ? "null" : typeof produced,
      value: rendered.value,
      error: null,
      truncated: rendered.truncated,
    };
  } catch (error) {
    const summary =
      error && typeof error === "object" && "stack" in error && error.stack
        ? String(error.stack).split("\\n").slice(0, 4).join("\\n")
        : String(error && error.message ? error.message : error);
    return { ok: false, type: "error", value: null, error: cut(summary).value, truncated: false };
  }
})()`;
}

/** The result returned when an evaluation runs past its RPC bound. */
export function panelEvaluateTimedOut(timeoutMs: number): PanelEvaluateResult {
  return {
    ok: false,
    type: "timeout",
    value: null,
    error: `Panel evaluation exceeded its ${timeoutMs}ms bound`,
    truncated: false,
  };
}

/** Narrow an untrusted provider payload back to the contract shape. */
export function normalizePanelEvaluateResult(value: unknown): PanelEvaluateResult {
  const record = (value ?? {}) as Partial<Record<keyof PanelEvaluateResult, unknown>>;
  return {
    ok: record.ok === true,
    type: typeof record.type === "string" ? record.type : "undefined",
    value: typeof record.value === "string" ? record.value : null,
    error: typeof record.error === "string" ? record.error : null,
    truncated: record.truncated === true,
  };
}
