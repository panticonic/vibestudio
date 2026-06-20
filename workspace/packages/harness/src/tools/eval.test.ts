import { describe, expect, it } from "vitest";
import { formatEvalResult, type EvalRunResult } from "./eval.js";

/** Join the text parts of a formatted tool result. */
function textOf(out: ReturnType<typeof formatEvalResult>): string {
  return out.content
    .map((c) => (c as { type: string; text?: string }).text ?? "")
    .join("\n");
}

describe("formatEvalResult (shared by the eval tool's execute + the agent's deferred onEvalComplete)", () => {
  it("formats a successful run: console + return value + scope keys, raw result on details", () => {
    const result: EvalRunResult = {
      success: true,
      console: "hello",
      returnValue: { a: 1 },
      scopeKeys: ["x", "y"],
    };
    const out = formatEvalResult(result);
    const text = textOf(out);
    expect(text).toContain("[eval] Console:\nhello");
    expect(text).toContain("[eval] Return value:");
    expect(text).toContain('"a": 1');
    expect(text).toContain("[scope] keys: x, y (2 total)");
    // The untruncated result is preserved on `details` for the harness.
    expect(out.details).toBe(result);
  });

  it("formats a failure: error line, no return value", () => {
    const text = textOf(formatEvalResult({ success: false, console: "", error: "boom" }));
    expect(text).toContain("[eval] Error: boom");
    expect(text).not.toContain("[eval] Return value");
    expect(text).toContain("[scope] (empty)");
  });

  it("uses 'unknown error' when a failure has no error string", () => {
    const text = textOf(formatEvalResult({ success: false, console: "" }));
    expect(text).toContain("[eval] Error: unknown error");
  });

  it("does NOT print a return value on failure even if one is present", () => {
    const text = textOf(
      formatEvalResult({ success: false, console: "", error: "x", returnValue: 42 })
    );
    expect(text).not.toContain("[eval] Return value");
  });

  it("windows oversized console with a recovery notice pointing at $lastConsole", () => {
    const big = "a".repeat(150_000);
    const text = textOf(formatEvalResult({ success: true, console: big }));
    expect(text.length).toBeLessThan(big.length); // truncated
    expect(text).toContain("truncated");
    expect(text).toContain("scope.$lastConsole");
  });

  it("windows an oversized return value pointing at $lastReturn", () => {
    const big = "b".repeat(150_000);
    const text = textOf(
      formatEvalResult({ success: true, console: "", returnValue: big })
    );
    expect(text).toContain("scope.$lastReturn");
    expect(text).toContain("truncated");
  });

  it("does not truncate normal-sized output", () => {
    const text = textOf(
      formatEvalResult({ success: true, console: "small", returnValue: "tiny" })
    );
    expect(text).not.toContain("truncated");
    expect(text).toContain("small");
    expect(text).toContain("tiny");
  });
});
