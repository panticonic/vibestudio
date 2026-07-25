import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@workspace/pi-core";
import {
  DEFAULT_LOCAL_TOOL_EXECUTION_TIMEOUT_MS,
  LocalToolExecutionTimeoutError,
  executeLocalToolWithDeadline,
} from "./local-tool-execution.js";

function tool(execute: AgentTool["execute"]): AgentTool {
  return {
    name: "probe",
    label: "probe",
    description: "probe",
    parameters: { type: "object" } as never,
    execute,
  };
}

describe("executeLocalToolWithDeadline", () => {
  it("settles with structured timeout evidence even when a tool ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const execution = executeLocalToolWithDeadline(
        tool(async (_id, _params, signal) => {
          observedSignal = signal;
          return await new Promise(() => {});
        }),
        {
          invocationId: "call-1",
          params: {},
          parentSignal: new AbortController().signal,
        }
      );
      const rejected = expect(execution).rejects.toMatchObject({
        code: "tool_execution_timeout",
        errorData: {
          tool: "probe",
          timeoutMs: DEFAULT_LOCAL_TOOL_EXECUTION_TIMEOUT_MS,
          elapsedMs: DEFAULT_LOCAL_TOOL_EXECUTION_TIMEOUT_MS,
        },
      } satisfies Partial<LocalToolExecutionTimeoutError>);

      await vi.advanceTimersByTimeAsync(DEFAULT_LOCAL_TOOL_EXECUTION_TIMEOUT_MS);
      await rejected;
      expect(observedSignal?.aborted).toBe(true);
      expect(observedSignal?.reason).toBeInstanceOf(LocalToolExecutionTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the finite runtime default and forwards progress", async () => {
    const onProgress = vi.fn();
    await expect(
      executeLocalToolWithDeadline(
        tool(async (_id, _params, _signal, update) => {
          update?.({ content: [], details: { phase: "done" } });
          return { content: [{ type: "text", text: "ok" }], details: null };
        }),
        {
          invocationId: "call-2",
          params: {},
          parentSignal: new AbortController().signal,
          onProgress,
        }
      )
    ).resolves.toMatchObject({ details: null });
    expect(DEFAULT_LOCAL_TOOL_EXECUTION_TIMEOUT_MS).toBe(30_000);
    expect(onProgress).toHaveBeenCalledOnce();
  });
});
