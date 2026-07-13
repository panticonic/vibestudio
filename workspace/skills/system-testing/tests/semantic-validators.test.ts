import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { agenticRuntimeTests } from "./agentic-runtime.js";
import { agentCapabilityTests } from "./agent-capabilities.js";
import { interactionSurfaceTests } from "./interaction-surfaces.js";
import { rpcTests } from "./rpc-communication.js";
import { harnessToolTests } from "./harness-tools.js";
import { finalMessageHasAll } from "./_helpers.js";

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
  it("accepts a large-output marker followed directly by its numeric count", () => {
    const test = agentCapabilityTests.find((candidate) => candidate.name === "large-output")!;
    expect(test.validate(execution("Generated the data. AGENT_LARGE_SUMMARY_OK 100000"))).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("accepts natural-language bounded channel evidence", () => {
    const test = agenticRuntimeTests.find(
      (candidate) => candidate.name === "channel-envelope-inspection-bounded"
    )!;
    const result = test.validate(
      execution("Inspected the channel with a limit of 5. CHANNEL_INSPECT_OK")
    );
    expect(result).toMatchObject({ passed: true });
  });
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

  it("accepts a bounded executed channel-inspection call when prose omits the limit", () => {
    const test = agenticRuntimeTests.find(
      (candidate) => candidate.name === "channel-envelope-inspection-bounded"
    )!;
    expect(
      test.validate(
        execution("Inspected 0 envelopes. CHANNEL_INSPECT_OK", [
          {
            name: "eval",
            arguments: {
              code: 'await gad.inspectChannelEnvelopes({ channelId: "fake", limit: 10 });',
            },
            execution: { status: "complete", isError: false },
          },
        ])
      )
    ).toEqual({ passed: true });
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

  it("accepts Markdown formatting around a semantic field value", () => {
    const test = harnessToolTests.find((candidate) => candidate.name === "claims-lifecycle")!;
    expect(
      test.validate(
        execution("CLAIM_LIFECYCLE_OK — retracted: **yes**", [
          {
            id: "retract",
            name: "retract_claim",
            arguments: { claimId: "test-claim" },
            execution: { status: "complete", isError: false, result: { ok: true } },
          },
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("treats hyphenated prose tokens and spaced prose as equivalent", () => {
    expect(finalMessageHasAll(execution("Diagnosis used bounded diagnostics."), [
      "bounded-diagnostics",
    ])).toEqual({ passed: true, reason: undefined });
  });

  it("does not loosen underscore sentinel markers into ordinary prose", () => {
    expect(finalMessageHasAll(execution("skill headless ok"), ["SKILL_HEADLESS_OK"]).passed).toBe(
      false
    );
  });
});
