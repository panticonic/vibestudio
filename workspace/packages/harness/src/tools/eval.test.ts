import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { createEvalTool, formatEvalResult, type EvalRunResult } from "./eval.js";

/** Join the text parts of a formatted tool result. */
function textOf(out: ReturnType<typeof formatEvalResult>): string {
  return out.content.map((c) => (c as { type: string; text?: string }).text ?? "").join("\n");
}

describe("formatEvalResult (shared by the eval tool's execute + the agent's deferred onEvalComplete)", () => {
  it("makes the JavaScript parser boundary explicit in the model-visible schema", () => {
    const tool = createEvalTool(async () => ({ success: true, console: "" }) as never);
    const schema = JSON.stringify(tool.parameters);

    expect(schema).toContain("Omit this for TypeScript/TSX");
    expect(schema).toContain("only for plain JavaScript with no type annotations");
  });

  it("directs API discovery through the live self-describing runtime", () => {
    const tool = createEvalTool(async () => ({ success: true, console: "" }) as never);
    expect(tool.description).toContain("await help()");
    expect(tool.description).toContain('await help("workers")');
    expect(tool.description).toContain("before guessing an API or return shape");
  });

  it("accepts only a positive integer timeout and forwards the explicit deadline", async () => {
    const calls: unknown[][] = [];
    const tool = createEvalTool(async (_method, args) => {
      calls.push(args);
      return { success: true, console: "" } as never;
    });

    expect(Value.Check(tool.parameters, { code: "return 1" })).toBe(true);
    expect(Value.Check(tool.parameters, { code: "return 1", timeoutMs: 250 })).toBe(true);
    expect(Value.Check(tool.parameters, { code: "return 1", timeoutMs: 0 })).toBe(false);
    expect(Value.Check(tool.parameters, { code: "return 1", timeoutMs: 1.5 })).toBe(false);
    expect(tool.description).toContain("no implicit wall deadline");

    await tool.execute("call-timeout", { code: "return 1", timeoutMs: 250 });
    expect(calls[0]?.[0]).toMatchObject({ code: "return 1", timeoutMs: 250 });
  });

  it("treats a transport-materialized empty path as omitted for inline code", async () => {
    const calls: unknown[][] = [];
    const tool = createEvalTool(async (_method, args) => {
      calls.push(args);
      return { success: true, console: "" } as never;
    });
    await tool.execute("call-1", { code: "return 1", path: "" } as never);
    expect(calls[0]?.[0]).toMatchObject({ code: "return 1", path: undefined });
  });
  it("uses path as a source-base hint when inline code is present", async () => {
    const calls: unknown[][] = [];
    const tool = createEvalTool(async (_method, args) => {
      calls.push(args);
      return { success: true, console: "" } as never;
    });

    await tool.execute("call-1", { code: "return 1", path: "meta" } as never);

    expect(calls[0]?.[0]).toMatchObject({
      code: "return 1",
      path: undefined,
      sourcePath: "meta/__inline_eval__.tsx",
    });
  });
  it("forwards reset as an atomic pre-run lifecycle option", async () => {
    const calls: unknown[][] = [];
    const tool = createEvalTool(async (_method, args) => {
      calls.push(args);
      return { success: true, console: "", scopeKeys: [] } as never;
    });

    await tool.execute("call-reset", { reset: true, code: "return Object.keys(scope)" } as never);

    expect(calls[0]?.[0]).toMatchObject({
      reset: true,
      code: "return Object.keys(scope)",
    });
  });
  it("loads a non-executable text/data path instead of parsing it as TypeScript", async () => {
    const calls: unknown[][] = [];
    const tool = createEvalTool(async (_method, args) => {
      calls.push(args);
      return { success: true, console: "", returnValue: "# Sandbox" } as never;
    });

    await tool.execute("call-1", { path: "skills/sandbox/SKILL.md" } as never);

    expect(calls[0]?.[0]).toMatchObject({
      code: 'return await fs.readFile("skills/sandbox/SKILL.md", "utf8");',
    });
    expect(calls[0]?.[0]).not.toHaveProperty("path");
  });
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
    const text = textOf(formatEvalResult({ success: true, console: "", returnValue: big }));
    expect(text).toContain("scope.$lastReturn");
    expect(text).toContain("truncated");
  });

  it("does not truncate normal-sized output", () => {
    const text = textOf(formatEvalResult({ success: true, console: "small", returnValue: "tiny" }));
    expect(text).not.toContain("truncated");
    expect(text).toContain("small");
    expect(text).toContain("tiny");
  });
});
