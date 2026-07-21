import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { agenticRuntimeTests } from "./agentic-runtime.js";
import { agentCapabilityTests } from "./agent-capabilities.js";
import { blobstoreTests } from "./blobstore.js";
import { cdpGadDiagnosticTests } from "./cdp-gad-diagnostics.js";
import { credentialTests } from "./credentials.js";
import { docsDiscoveryTests } from "./docs-discovery.js";
import { docsProbeTests } from "./docs-probes.js";
import { finalMessageHasAll } from "./_helpers.js";
import { interactionSurfaceTests } from "./interaction-surfaces.js";
import { gitInteropTests } from "./git-interop.js";
import { harnessToolTests } from "./harness-tools.js";
import { notificationTests } from "./notifications.js";
import { oauthTests } from "./oauth.js";
import { rpcTests } from "./rpc-communication.js";
import { serverLogTests } from "./server-logs.js";
import { skillTests } from "./skills.js";
import { unitDiagnosticsTests } from "./unit-diagnostics.js";
import { vcsAdvancedTests } from "./vcs-advanced.js";
import { webhookTests } from "./webhooks.js";

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
  it("keeps the assigned diagnostic prompts user-like and free of proof choreography", () => {
    const tests = [
      ...agenticRuntimeTests,
      ...skillTests,
      ...unitDiagnosticsTests,
      ...credentialTests,
      ...oauthTests,
      ...harnessToolTests,
      ...notificationTests,
      ...cdpGadDiagnosticTests,
      ...blobstoreTests,
      ...docsDiscoveryTests,
      ...docsProbeTests,
      ...serverLogTests,
      ...webhookTests,
      ...gitInteropTests,
    ];
    for (const test of tests) {
      expect(test.prompt, test.name).not.toMatch(
        /Finish with|Return (?:only|exactly)|[A-Z][A-Z0-9_]{3,}_OK|\w+:<(?:count|number)>|\b(?:blobstore|credentials|docs|git|notifications|serverLog|webhooks|workspace|gad)\.\w+\s*\(/u
      );
    }
  });

  it("requires direct semantic causality and blame evidence", () => {
    const test = vcsAdvancedTests.find(
      (candidate) => candidate.name === "vcs-walkable-causality-blame"
    )!;
    expect(test.workspaceRepoFixture).toEqual({ kind: "content", section: "projects" });
    const final = "The untouched line is supported by the recorded request and causal history.";
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
            "await vcs.edit(change); await vcs.commit(commit); await vcs.push(push); await vcs.blame(input); await vcs.inspect({ node: command }); await vcs.neighbors({ root: command });",
            {
              spans: [
                {
                  start: 0,
                  end: 8,
                  path: [],
                  change: { kind: "change", changeId: "change:1" },
                  workUnit: { kind: "work-unit", workUnitId: "work-unit:1" },
                  command: { kind: "command", commandId: "command:1" },
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

  it("requires provenance orientation to return a typed root and complete typed edges", () => {
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
    const final =
      "This session originates in the current trajectory; the returned trajectory root and trigger edge connect its turn to the initiating message context.";
    expect(test.validate(execution(final, [invocation]))).toEqual({
      passed: true,
      reason: undefined,
    });
    expect(test.validate(execution(final))).toMatchObject({ passed: false });
  });

  it("requires memory-search prose to be backed by canonical recall results", () => {
    const test = harnessToolTests.find((candidate) => candidate.name === "memory-search")!;
    const final =
      "Workspace memory found one prior conversation about a build failure, with the recalled message as its source provenance.";
    const recall = {
      name: "memory_recall",
      arguments: { query: "build failures", limit: 10 },
      execution: {
        status: "complete",
        isError: false,
        result: { details: { results: [{ kind: "message", snippet: "build failed" }] } },
      },
    };
    expect(test.validate(execution(final, [recall]))).toEqual({ passed: true });
    expect(test.validate(execution(final))).toMatchObject({ passed: false });
  });

  it("requires a large collection summary to be backed by its completed eval count", () => {
    const test = agentCapabilityTests.find((candidate) => candidate.name === "large-output")!;
    const invocation = {
      name: "eval",
      arguments: {
        code: "const values = Array.from({ length: 100000 }, (_, index) => index); return { count: values.length };",
      },
      execution: {
        status: "complete",
        isError: false,
        result: { details: { returnValue: { count: 100000 } } },
      },
    };
    expect(
      test.validate(
        execution("The generated collection contained 100,000 items; I kept the report compact.", [
          invocation,
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
    expect(test.validate(execution("The collection contained 100,000 items."))).toMatchObject({
      passed: false,
    });
  });

  it("rejects natural-language channel claims without an executed bounded inspection", () => {
    const test = agenticRuntimeTests.find(
      (candidate) => candidate.name === "channel-envelope-inspection-bounded"
    )!;
    const result = test.validate(
      execution("The nonexistent channel had no envelope history in the bounded inspection.")
    );
    expect(result).toMatchObject({ passed: false });
  });
  it("joins a reported worker count to the completed worker RPC result", () => {
    const test = rpcTests.find((candidate) => candidate.name === "worker-rpc")!;
    expect(
      test.validate(
        execution("The worker service reported 2 launchable worker sources.", [
          {
            name: "eval",
            arguments: { code: "return workers.listSources();" },
            execution: {
              status: "complete",
              isError: false,
              result: {
                details: {
                  returnValue: [{ source: "workers/alpha" }, { source: "workers/beta" }],
                },
              },
            },
          },
        ])
      )
    ).toEqual({ passed: true });
  });

  it("does not treat a prose limit as canonical bounded evidence", () => {
    const test = agenticRuntimeTests.find(
      (candidate) => candidate.name === "channel-envelope-inspection-bounded"
    )!;
    expect(
      test.validate(
        execution("The channel history query used a limit of 5 and found no envelopes.")
      )
    ).toMatchObject({ passed: false });
  });

  it("accepts a bounded executed channel-inspection call when prose omits the limit", () => {
    const test = agenticRuntimeTests.find(
      (candidate) => candidate.name === "channel-envelope-inspection-bounded"
    )!;
    expect(
      test.validate(
        execution("The bounded channel history inspection found no envelopes.", [
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

  it("requires a real completed tool before accepting a natural no-stall response", () => {
    const test = agenticRuntimeTests.find(
      (candidate) => candidate.name === "turn-no-silent-stall-after-tool"
    )!;
    const final = "The read-only check completed, and this is the visible final response.";
    const completed = {
      name: "read",
      arguments: { path: "README.md", limit: 1 },
      execution: { status: "complete", isError: false, result: { text: "Vibestudio" } },
    };
    expect(test.validate(execution(final, [completed]))).toEqual({ passed: true });
    expect(test.validate(execution(final))).toMatchObject({ passed: false });
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
