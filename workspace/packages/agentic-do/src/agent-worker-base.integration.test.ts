import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";

import { AgentWorkerBase } from "./agent-worker-base.js";
import type { TurnDispatcherRunner } from "./turn-dispatcher.js";

class TestAgentWorker extends AgentWorkerBase {
  protected override getModel(): string {
    return "test:model";
  }
}

describe("AgentWorkerBase runner contract", () => {
  it("uses the clean AgentHarness-facing dispatcher surface", () => {
    const methods = [
      "subscribe",
      "buildUserMessage",
      "prompt",
      "steerMessage",
      "continueAgent",
      "clearSteeringQueue",
    ] satisfies Array<keyof TurnDispatcherRunner>;

    expect(methods).toEqual([
      "subscribe",
      "buildUserMessage",
      "prompt",
      "steerMessage",
      "continueAgent",
      "clearSteeringQueue",
    ]);
  });
});

describe("AgentWorkerBase dispatched method results", () => {
  it("redrains a buffered result that arrives before its placeholder is visible", async () => {
    vi.useFakeTimers();
    try {
      const { instance } = await createTestDO(TestAgentWorker, {
        __objectKey: "agent-test",
      });
      const worker = instance as unknown as {
        dispatches: {
          store(input: {
            callId: string;
            channelId: string;
            kind: "tool-call";
            toolCallId: string;
          }): void;
          peek(callId: string): { pendingResultJson: string | null; pendingIsError: boolean | null } | null;
        };
        readRunnerMessages: ReturnType<typeof vi.fn>;
        drainDeferredDispatchesFor: ReturnType<typeof vi.fn>;
      };

      worker.dispatches.store({
        callId: "call-1",
        channelId: "chat-1",
        kind: "tool-call",
        toolCallId: "tool-1",
      });
      worker.readRunnerMessages = vi.fn().mockResolvedValue([]);
      worker.drainDeferredDispatchesFor = vi.fn().mockResolvedValue(undefined);

      await instance.onCallResult("call-1", { ok: true }, false);

      const stored = worker.dispatches.peek("call-1");
      expect(stored?.pendingResultJson).toBe(JSON.stringify({ value: { ok: true } }));
      expect(stored?.pendingIsError).toBe(false);
      expect(worker.drainDeferredDispatchesFor).not.toHaveBeenCalled();

      await vi.runOnlyPendingTimersAsync();
      expect(worker.drainDeferredDispatchesFor).toHaveBeenCalledWith("chat-1");
    } finally {
      vi.useRealTimers();
    }
  });
});
