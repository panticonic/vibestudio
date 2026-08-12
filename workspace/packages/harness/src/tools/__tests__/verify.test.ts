import { describe, expect, it, vi } from "vitest";
import type { UnitBuildReportWire } from "@vibestudio/service-schemas/build";
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
      builds: [
        {
          target: "library:worker" as const,
          buildKey: "a".repeat(64),
          diagnosticIndexes: [],
        },
      ],
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
    expect(result.details).toMatchObject({
      operation: "build",
      status: "ok",
      receipt: {
        protocol: "build-verification-receipt.v1",
        target: "packages/parser",
        contextId: "context-7",
        ref: "ctx:context-7",
        reportDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        unit: {
          repoPath: "packages/parser",
          unitName: "@workspace/parser",
          kind: "package",
        },
        status: "ok",
        builds: [{ target: "library:worker", buildKey: "a".repeat(64) }],
        diagnostics: { total: 0, retained: 0, truncated: 0 },
      },
    });
  });

  it("publishes an immediate running update before waiting for verification", async () => {
    let release!: (value: UnitBuildReportWire) => void;
    const pending = new Promise<UnitBuildReportWire>((resolve) => {
      release = resolve;
    });
    const callMain = async <T>(): Promise<T> => (await pending) as T;
    const updates: unknown[] = [];
    const execution = createVerifyTool(callMain, () => "context-7").execute(
      "call-progress",
      { operation: "build", target: "packages/example" },
      undefined,
      (update) => updates.push(update)
    );

    expect(updates).toEqual([
      {
        content: [{ type: "text", text: "Building packages/example…" }],
        details: { operation: "build", target: "packages/example", status: "running" },
      },
    ]);

    release({
      repoPath: "packages/example",
      kind: "package",
      status: "ok",
      diagnostics: [],
      builds: [],
    });
    await expect(execution).resolves.toMatchObject({ isError: false });
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
      builds: [{ target: "runtime" as const, diagnosticIndexes: [0] }],
    });
    const result = await createVerifyTool(callMain, () => "context-7").execute("call-build", {
      operation: "build",
      target: "panels/editor",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("1 diagnostic"),
    });
    expect((result.content[0] as { text: string }).text).not.toContain("Cannot find name");
    expect(result.details).toMatchObject({
      operation: "build",
      report: { diagnostics: [{ source: "tsc", severity: "error" }] },
    });
  });

  it("bounds the one canonical diagnostic array and remaps target references", async () => {
    const diagnostics = Array.from({ length: 45 }, (_, index) => ({
      source: "tsc" as const,
      severity: "error" as const,
      file: `panels/editor/file-${index}.ts`,
      line: index + 1,
      column: 1,
      message: index === 0 ? "x".repeat(3_000) : `failure ${index}`,
    }));
    const { callMain } = rpcResult({
      repoPath: "panels/editor",
      kind: "panel",
      status: "failed" as const,
      diagnostics,
      builds: [{ target: "runtime" as const, diagnosticIndexes: [0, 39, 40, 44] }],
    });

    const result = await createVerifyTool(callMain, () => "context-7").execute("call-build", {
      operation: "build",
      target: "panels/editor",
    });

    expect(result.details).toMatchObject({
      truncatedDiagnostics: 5,
      truncatedDiagnosticText: 1_000,
      receipt: {
        diagnostics: { total: 45, retained: 40, truncated: 5 },
      },
      report: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ message: expect.stringMatching(/\[truncated\]$/u) }),
        ]),
        builds: [{ target: "runtime", diagnosticIndexes: [0, 39] }],
      },
    });
    expect((result.details as { report: UnitBuildReportWire }).report.diagnostics).toHaveLength(40);
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
