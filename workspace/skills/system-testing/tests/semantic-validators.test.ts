import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { agenticRuntimeTests } from "./agentic-runtime.js";
import { agentCapabilityTests } from "./agent-capabilities.js";
import { finalMessageHasAll } from "./_helpers.js";
import { interactionSurfaceTests } from "./interaction-surfaces.js";
import { harnessToolTests } from "./harness-tools.js";
import { rpcTests } from "./rpc-communication.js";
import { vcsAdvancedTests } from "./vcs-advanced.js";

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
  it("requires direct semantic causality and blame evidence", () => {
    const test = vcsAdvancedTests.find(
      (candidate) => candidate.name === "vcs-walkable-causality-blame"
    )!;
    expect(test.workspaceRepoFixture).toEqual({ kind: "content", section: "projects" });
    const final =
      "VCS_CAUSALITY_OK untouched:original command:command:1 invocation:invocation:1 turn:turn:1 message:exact sender:exact request:walkable intent:observable-private blame:exact edges:walkable";
    const invocation = (code: string, result?: unknown) => [
      {
        name: "eval",
        arguments: { code },
        execution: { status: "complete", isError: false, result },
      },
    ];
    expect(
      test.validate(
        execution(
          final,
          invocation(
            "await vcs.blame(input); await vcs.inspect({ node: command }); await vcs.neighbors({ root: command });",
            {
              spans: [
                {
                  start: 0,
                  end: 8,
                  path: [],
                  changeId: "change:1",
                  workUnitId: "work-unit:1",
                  commandId: "command:1",
                },
              ],
              edges: [
                {
                  kind: "authored-change",
                  from: { kind: "work-unit", workUnitId: "work-unit:1" },
                  to: { kind: "change", changeId: "change:1" },
                },
                {
                  kind: "caused-by",
                  from: { kind: "work-unit", workUnitId: "work-unit:1" },
                  to: { kind: "command", commandId: "command:1" },
                },
                {
                  kind: "caused-by",
                  from: { kind: "command", commandId: "command:1" },
                  to: {
                    kind: "trajectory-invocation",
                    logId: "trajectory:1",
                    head: "main",
                    invocationId: "invocation:1",
                  },
                },
                {
                  kind: "part-of-turn",
                  from: {
                    kind: "trajectory-invocation",
                    logId: "trajectory:1",
                    head: "main",
                    invocationId: "invocation:1",
                  },
                  to: {
                    kind: "trajectory-turn",
                    logId: "trajectory:1",
                    head: "main",
                    turnId: "turn:1",
                  },
                },
                {
                  kind: "triggered-by",
                  from: {
                    kind: "trajectory-turn",
                    logId: "trajectory:1",
                    head: "main",
                    turnId: "turn:1",
                  },
                  to: {
                    kind: "trajectory-message",
                    logId: "trajectory:1",
                    head: "main",
                    messageId: "message:1",
                  },
                },
              ],
              inspected: [
                {
                  node: {
                    kind: "trajectory-invocation",
                    value: {
                      logId: "trajectory:1",
                      head: "main",
                      invocationId: "invocation:1",
                      turnId: "turn:1",
                      requestRef: {
                        digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                      },
                    },
                  },
                },
                {
                  node: {
                    kind: "trajectory-turn",
                    value: {
                      logId: "trajectory:1",
                      head: "main",
                      turnId: "turn:1",
                      triggerMessageId: "message:1",
                    },
                  },
                },
                {
                  node: {
                    kind: "trajectory-message",
                    value: {
                      logId: "trajectory:1",
                      head: "main",
                      messageId: "message:1",
                      role: "user",
                      sourceMessageId: "channel-message:current-prompt",
                      senderRef: { id: "user:fixture" },
                      textBlocks: [{ blockId: "block:1", content: test.prompt }],
                    },
                  },
                },
              ],
            }
          )
        )
      )
    ).toEqual({ passed: true, reason: undefined });
    expect(test.validate(execution(final, invocation("await vcs.blame(input);")))).toEqual({
      passed: false,
      reason:
        "Completed agent tools or successful eval did not exercise vcs.inspect, vcs.neighbors",
    });
  });

  it("requires provenance orientation to return and accurately count complete edge roots", () => {
    const test = harnessToolTests.find((candidate) => candidate.name === "provenance-orientation")!;
    const invocation = {
      name: "provenance",
      execution: {
        status: "complete",
        isError: false,
        result: {
          details: {
            root: { kind: "trajectory", logId: "trajectory:1", head: "main" },
            adjacency: [
              {
                kind: "part-of-trajectory",
                from: {
                  kind: "trajectory-turn",
                  logId: "trajectory:1",
                  head: "main",
                  turnId: "turn:1",
                },
                to: { kind: "trajectory", logId: "trajectory:1", head: "main" },
              },
              {
                kind: "triggered-by",
                from: {
                  kind: "trajectory-turn",
                  logId: "trajectory:1",
                  head: "main",
                  turnId: "turn:1",
                },
                to: {
                  kind: "trajectory-message",
                  logId: "trajectory:1",
                  head: "main",
                  messageId: "message:1",
                },
              },
            ],
          },
        },
      },
    };
    expect(test.validate(execution("PROVENANCE_OK roots:3", [invocation]))).toEqual({
      passed: true,
      reason: undefined,
    });
    expect(test.validate(execution("PROVENANCE_OK roots:0", [invocation]))).toEqual({
      passed: false,
      reason:
        "Agent reported roots:0; completed provenance evidence contained 3 unique complete roots",
    });
  });

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

  it("treats hyphenated prose tokens and spaced prose as equivalent", () => {
    expect(
      finalMessageHasAll(execution("Diagnosis used bounded diagnostics."), ["bounded-diagnostics"])
    ).toEqual({ passed: true, reason: undefined });
  });

  it("does not loosen underscore sentinel markers into ordinary prose", () => {
    expect(finalMessageHasAll(execution("skill headless ok"), ["SKILL_HEADLESS_OK"]).passed).toBe(
      false
    );
  });
});
