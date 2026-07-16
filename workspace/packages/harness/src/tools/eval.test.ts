import { describe, expect, it } from "vitest";
import { createEvalTool, formatEvalResult, type EvalRunResult } from "./eval.js";

const TEST_PROVENANCE: EvalRunResult["provenance"] = {
  startIntentDigest: "a".repeat(64),
  sourceDigest: "b".repeat(64),
  executionProvenanceDigest: "c".repeat(64),
  scopeInputRevision: "scope-1",
  runDigest: "d".repeat(64),
  sourceBundleDigest: "e".repeat(64),
  manifestDigest: "f".repeat(64),
  terminalReason: "completed",
};

function evalResult(result: Omit<EvalRunResult, "provenance">): EvalRunResult {
  return { ...result, provenance: TEST_PROVENANCE };
}

/** Join the text parts of a formatted tool result. */
function textOf(out: ReturnType<typeof formatEvalResult>): string {
  return out.content.map((c) => (c as { type: string; text?: string }).text ?? "").join("\n");
}

function evalTransport(calls: unknown[][], result: EvalRunResult) {
  return async (method: string, args: unknown[]): Promise<never> => {
    calls.push(args);
    if (method === "eval.start") return { runId: "run-1" } as never;
    if (method === "eval.events") return { events: [], next: 0 } as never;
    if (method === "eval.get") return { status: "succeeded", result } as never;
    return { status: "terminal" } as never;
  };
}

describe("formatEvalResult (shared by the eval tool's execute + the agent's deferred onEvalComplete)", () => {
  it("treats a transport-materialized empty path as omitted for inline code", async () => {
    const calls: unknown[][] = [];
    const tool = createEvalTool(evalTransport(calls, evalResult({ success: true, console: "" })));
    await tool.execute("call-1", { code: "return 1", path: "" } as never);
    expect(calls[0]?.[0]).toMatchObject({
      source: { kind: "inline", code: "return 1", pathHint: undefined },
    });
  });
  it("uses path as a source-base hint when inline code is present", async () => {
    const calls: unknown[][] = [];
    const tool = createEvalTool(evalTransport(calls, evalResult({ success: true, console: "" })));

    await tool.execute("call-1", { code: "return 1", path: "meta" } as never);

    expect(calls[0]?.[0]).toMatchObject({
      source: {
        kind: "inline",
        code: "return 1",
        pathHint: "meta/__inline_eval__.tsx",
      },
    });
  });
  it("forwards reset as an atomic pre-run lifecycle option", async () => {
    const calls: unknown[][] = [];
    const tool = createEvalTool(
      evalTransport(calls, evalResult({ success: true, console: "", scopeKeys: [] }))
    );

    await tool.execute("call-reset", { reset: true, code: "return Object.keys(scope)" } as never);

    expect(calls[0]?.[0]).toMatchObject({
      scope: { key: "default", reset: true },
      source: { kind: "inline", code: "return Object.keys(scope)" },
    });
  });
  it("preserves a non-executable text/data path for immutable kernel materialization", async () => {
    const calls: unknown[][] = [];
    const tool = createEvalTool(
      evalTransport(
        calls,
        evalResult({ success: true, console: "", returnValue: "# Sandbox" })
      )
    );

    await tool.execute("call-1", { path: "skills/sandbox/SKILL.md" } as never);

    expect(calls[0]?.[0]).toMatchObject({
      source: {
        kind: "context-file",
        path: "skills/sandbox/SKILL.md",
      },
    });
  });
  it("formats a successful run: console + return value + scope keys, raw result on details", () => {
    const result = evalResult({
      success: true,
      console: "hello",
      returnValue: { a: 1 },
      scopeKeys: ["x", "y"],
    });
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
    const text = textOf(
      formatEvalResult(evalResult({ success: false, console: "", error: "boom" }))
    );
    expect(text).toContain("[eval] Error: boom");
    expect(text).not.toContain("[eval] Return value");
    expect(text).toContain("[scope] (empty)");
  });

  it("uses 'unknown error' when a failure has no error string", () => {
    const text = textOf(formatEvalResult(evalResult({ success: false, console: "" })));
    expect(text).toContain("[eval] Error: unknown error");
  });

  it("does NOT print a return value on failure even if one is present", () => {
    const text = textOf(
      formatEvalResult(
        evalResult({ success: false, console: "", error: "x", returnValue: 42 })
      )
    );
    expect(text).not.toContain("[eval] Return value");
  });

  it("windows oversized console with a recovery notice pointing at $lastConsole", () => {
    const big = "a".repeat(150_000);
    const text = textOf(formatEvalResult(evalResult({ success: true, console: big })));
    expect(text.length).toBeLessThan(big.length); // truncated
    expect(text).toContain("truncated");
    expect(text).toContain("scope.$lastConsole");
  });

  it("windows an oversized return value pointing at $lastReturn", () => {
    const big = "b".repeat(150_000);
    const text = textOf(
      formatEvalResult(evalResult({ success: true, console: "", returnValue: big }))
    );
    expect(text).toContain("scope.$lastReturn");
    expect(text).toContain("truncated");
  });

  it("does not truncate normal-sized output", () => {
    const text = textOf(
      formatEvalResult(evalResult({ success: true, console: "small", returnValue: "tiny" }))
    );
    expect(text).not.toContain("truncated");
    expect(text).toContain("small");
    expect(text).toContain("tiny");
  });
});
