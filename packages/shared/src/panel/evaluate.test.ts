import { describe, expect, it } from "vitest";
import {
  PANEL_EVALUATE_TIMEOUT_MS,
  PANEL_EVALUATE_VALUE_LIMIT,
  normalizePanelEvaluateResult,
  panelEvaluateExpression,
  panelEvaluateTimedOut,
  panelEvaluateTimeoutMs,
  panelEvaluateValueLimit,
} from "./evaluate.js";

/**
 * The wrapper is a string both providers ship into a page, so the only honest
 * way to test it is to run it. `eval` here plays the part of the page.
 */
async function runWrapper(expression: string, limit = PANEL_EVALUATE_VALUE_LIMIT) {
  // eslint-disable-next-line no-eval
  return (await (0, eval)(panelEvaluateExpression(expression, limit))) as ReturnType<
    typeof normalizePanelEvaluateResult
  >;
}

describe("panel evaluate bounds", () => {
  it("defaults to the shared bound and never lets a caller raise it", () => {
    expect(panelEvaluateTimeoutMs()).toBe(PANEL_EVALUATE_TIMEOUT_MS);
    expect(panelEvaluateTimeoutMs({ timeoutMs: 1_000 })).toBe(1_000);
    // A caller asking for longer gets the bound, not the ask: this is a host
    // command slot, and one runaway expression must not pin it open.
    expect(panelEvaluateTimeoutMs({ timeoutMs: 60_000 })).toBe(PANEL_EVALUATE_TIMEOUT_MS);
    expect(panelEvaluateTimeoutMs({ timeoutMs: -1 })).toBe(PANEL_EVALUATE_TIMEOUT_MS);
    expect(panelEvaluateTimeoutMs({ timeoutMs: Number.NaN })).toBe(PANEL_EVALUATE_TIMEOUT_MS);
  });

  it("clamps the serialized-value limit the same way", () => {
    expect(panelEvaluateValueLimit()).toBe(PANEL_EVALUATE_VALUE_LIMIT);
    expect(panelEvaluateValueLimit({ valueLimit: 10 })).toBe(10);
    expect(panelEvaluateValueLimit({ valueLimit: 10 ** 9 })).toBe(PANEL_EVALUATE_VALUE_LIMIT);
  });

  it("describes a timed-out evaluation as a result, not an exception", () => {
    expect(panelEvaluateTimedOut(8_000)).toEqual({
      ok: false,
      type: "timeout",
      value: null,
      error: "Panel evaluation exceeded its 8000ms bound",
      truncated: false,
    });
  });
});

describe("panel evaluate wrapper", () => {
  it("returns a serialized value with its type", async () => {
    await expect(runWrapper("1 + 1")).resolves.toEqual({
      ok: true,
      type: "number",
      value: "2",
      error: null,
      truncated: false,
    });
  });

  it("evaluates as an expression, not a statement", async () => {
    await expect(runWrapper("({ a: 1 })")).resolves.toMatchObject({
      ok: true,
      type: "object",
    });
  });

  it("awaits a promise and reports its resolved value", async () => {
    await expect(runWrapper("Promise.resolve('done')")).resolves.toMatchObject({
      ok: true,
      type: "string",
      value: "done",
    });
  });

  it("reports a throw as a summarized error rather than rejecting", async () => {
    const result = await runWrapper("(() => { throw new TypeError('nope') })()");
    expect(result.ok).toBe(false);
    expect(result.type).toBe("error");
    expect(result.error).toContain("nope");
    // A stack summary, not the whole stack.
    expect((result.error ?? "").split("\n").length).toBeLessThanOrEqual(4);
  });

  it("reports a rejected promise the same way", async () => {
    const result = await runWrapper("Promise.reject(new Error('async boom'))");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("async boom");
  });

  it("truncates a value past the limit and says so", async () => {
    const result = await runWrapper("'x'.repeat(500)", 32);
    expect(result.truncated).toBe(true);
    expect(result.value).toHaveLength(32);
  });

  it("survives a circular object instead of throwing on serialization", async () => {
    const result = await runWrapper("(() => { const a = {}; a.self = a; return a })()");
    expect(result.ok).toBe(true);
    expect(result.value).toContain("[Circular]");
  });

  it("distinguishes null from undefined", async () => {
    await expect(runWrapper("null")).resolves.toMatchObject({ type: "null" });
    await expect(runWrapper("undefined")).resolves.toMatchObject({
      type: "undefined",
      value: "undefined",
    });
  });
});

describe("normalizePanelEvaluateResult", () => {
  it("refuses to trust an untyped provider payload", () => {
    expect(normalizePanelEvaluateResult(undefined)).toEqual({
      ok: false,
      type: "undefined",
      value: null,
      error: null,
      truncated: false,
    });
    expect(normalizePanelEvaluateResult({ ok: "yes", value: 4, truncated: 1 })).toEqual({
      ok: false,
      type: "undefined",
      value: null,
      error: null,
      truncated: false,
    });
  });

  it("passes a well-formed payload through unchanged", () => {
    const payload = { ok: true, type: "string", value: "hi", error: null, truncated: false };
    expect(normalizePanelEvaluateResult(payload)).toEqual(payload);
  });
});
