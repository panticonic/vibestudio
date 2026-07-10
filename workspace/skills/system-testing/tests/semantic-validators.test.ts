import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { agenticRuntimeTests } from "./agentic-runtime.js";
import { interactionSurfaceTests } from "./interaction-surfaces.js";
import { rpcTests } from "./rpc-communication.js";

function execution(
  final: string,
  invocations: Record<string, unknown>[] = []
): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      { kind: "message", senderId: "user", complete: true, content: "prompt" },
      ...invocations.map((invocation) => ({
        kind: "message" as const,
        senderId: "agent",
        complete: true,
        contentType: "invocation" as const,
        content: JSON.stringify(invocation),
      })),
      { kind: "message", senderId: "agent", complete: true, content: final },
    ],
  } as TestExecutionResult;
}

describe("semantic system-test validators", () => {
  it("accepts a marker followed directly by the worker count", () => {
    const test = rpcTests.find((candidate) => candidate.name === "worker-rpc")!;
    expect(test.validate(execution("RPC worker inspection succeeded. RPC_WORKERS_OK 14"))).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("accepts an explicit channel history limit as bounded evidence", () => {
    const test = agenticRuntimeTests.find(
      (candidate) => candidate.name === "channel-envelope-inspection-bounded"
    )!;
    expect(
      test.validate(execution("CHANNEL_INSPECT_OK; queried with limit 5 and got 0 rows"))
    ).toEqual({
      passed: true,
    });
  });

  it("does not require eval when action-bar files are already available", () => {
    const test = interactionSurfaceTests.find(
      (candidate) => candidate.name === "load-action-bar-transcript-event"
    )!;
    const completed = (id: string, args: Record<string, unknown>) => ({
      id,
      name: "load_action_bar",
      arguments: args,
      execution: { status: "complete", isError: false, result: { ok: true } },
    });
    expect(
      test.validate(
        execution("ACTION_BAR_TRANSCRIPT_OK ACTION_BAR_CLEAR_OK", [
          completed("load", { path: "panels/tools/action-bar.tsx" }),
          completed("clear", { clear: true }),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
  });
});
