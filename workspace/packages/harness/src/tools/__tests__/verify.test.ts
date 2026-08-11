import { describe, expect, it, vi } from "vitest";
import { createVerifyTool } from "../verify.js";

function rpcResult<T>(value: T) {
  const calls = vi.fn();
  return {
    calls,
    callMain: async <R>(method: string, args: unknown[], signal?: AbortSignal) => {
      calls(method, args, signal);
      return value as unknown as R;
    },
  };
}

describe("context-exact verify tool", () => {
  it("builds the current semantic context and reports success", async () => {
    const { callMain, calls } = rpcResult({
      repoPath: "packages/parser",
      unitName: "@workspace/parser",
      kind: "package",
      status: "ok" as const,
      diagnostics: [],
      builds: [{ target: "library:worker" as const, diagnostics: [] }],
    });
    const controller = new AbortController();
    const tool = createVerifyTool(callMain, () => "context-7");

    const result = await tool.execute(
      "call-build",
      { operation: "build", target: "packages/parser" },
      controller.signal
    );

    expect(calls).toHaveBeenCalledWith(
      "build.getBuildReport",
      ["packages/parser", "ctx:context-7"],
      controller.signal
    );
    expect(result.isError).toBe(false);
    expect(result.details).toMatchObject({ operation: "build", status: "ok" });
  });

  it("keeps structured build diagnostics while marking a failed build as an error", async () => {
    const { callMain } = rpcResult({
      repoPath: "panels/editor",
      kind: "panel",
      status: "failed" as const,
      diagnostics: [
        {
          source: "tsc" as const,
          severity: "error" as const,
          file: "panels/editor/index.tsx",
          line: 4,
          column: 9,
          message: "Cannot find name 'missing'",
        },
      ],
      builds: [],
    });
    const result = await createVerifyTool(callMain, () => "context-7").execute("call-build", {
      operation: "build",
      target: "panels/editor",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("panels/editor/index.tsx:4:9"),
    });
    expect(result.details).toMatchObject({
      operation: "build",
      report: { diagnostics: [{ source: "tsc", severity: "error" }] },
    });
  });

  it("runs one focused test selection through the approved extension", async () => {
    const { callMain, calls } = rpcResult({
      summary: "1 passed",
      passed: 1,
      failed: 0,
      total: 1,
      contextId: "context-7",
      target: "packages/parser",
      pattern: "parser.test.ts",
      details: [{ file: "parser.test.ts", status: "pass" as const }],
    });
    const result = await createVerifyTool(callMain, () => "context-7").execute("call-test", {
      operation: "test",
      target: "packages/parser",
      file: "parser.test.ts",
      testName: "parses empty input",
    });

    expect(calls).toHaveBeenCalledWith(
      "extensions.invoke",
      [
        "@workspace-extensions/test-runner",
        "run",
        [
          {
            target: "packages/parser",
            contextId: "context-7",
            fileFilter: "parser.test.ts",
            testName: "parses empty input",
          },
        ],
      ],
      undefined
    );
    expect(result.isError).toBe(false);
    expect(result.details).toMatchObject({ operation: "test", status: "passed" });
  });

  it("does not present zero discovered tests as successful verification", async () => {
    const { callMain } = rpcResult({
      summary: "No tests",
      passed: 0,
      failed: 0,
      total: 0,
      contextId: "context-7",
      target: "packages/parser",
      pattern: "**/*.test.ts",
      details: [],
    });
    const result = await createVerifyTool(callMain, () => "context-7").execute("call-test", {
      operation: "test",
      target: "packages/parser",
    });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ operation: "test", status: "no-tests" });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("verification did not pass"),
    });
  });
});
