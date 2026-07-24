import type { AgentTool, AgentToolResult } from "@workspace/pi-core";

export const DEFAULT_LOCAL_TOOL_EXECUTION_TIMEOUT_MS = 30_000;

export class LocalToolExecutionTimeoutError extends Error {
  readonly code = "tool_execution_timeout";
  readonly errorData: {
    tool: string;
    timeoutMs: number;
    elapsedMs: number;
  };

  constructor(tool: string, timeoutMs: number, elapsedMs: number) {
    super(`${tool} did not complete within its ${timeoutMs}ms execution deadline`);
    this.name = "LocalToolExecutionTimeoutError";
    this.errorData = { tool, timeoutMs, elapsedMs };
  }
}

/**
 * Own the complete in-process tool boundary. Registry tools receive a child
 * signal, while the runtime settles durably even if a downstream transport
 * ignores cancellation. Long-running work belongs behind a deferred protocol
 * (for example eval), never behind an infinite local promise.
 */
export async function executeLocalToolWithDeadline(
  tool: AgentTool,
  input: {
    invocationId: string;
    params: unknown;
    parentSignal: AbortSignal;
    onProgress?: (chunk: unknown) => void;
  }
): Promise<AgentToolResult<unknown>> {
  const timeoutMs = tool.executionTimeoutMs ?? DEFAULT_LOCAL_TOOL_EXECUTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${tool.name} declares an invalid executionTimeoutMs: ${String(timeoutMs)}`);
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(input.parentSignal.reason);
  if (input.parentSignal.aborted) onParentAbort();
  else input.parentSignal.addEventListener("abort", onParentAbort, { once: true });

  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    const error = new LocalToolExecutionTimeoutError(tool.name, timeoutMs, Date.now() - startedAt);
    controller.abort(error);
    rejectDeadline(error);
  }, timeoutMs);

  try {
    return (await Promise.race([
      tool.execute(
        input.invocationId,
        input.params as never,
        controller.signal,
        (update) => input.onProgress?.(update)
      ),
      deadline,
    ])) as AgentToolResult<unknown>;
  } finally {
    clearTimeout(timer);
    input.parentSignal.removeEventListener("abort", onParentAbort);
  }
}
