import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/runtime", () => ({
  browserData: {
    listImportJobs: vi.fn(async () => []),
  },
}));

import type { TestExecutionResult } from "../types.js";
import { agenticRuntimeTests } from "./agentic-runtime.js";
import { agentCapabilityTests } from "./agent-capabilities.js";
import { blobstoreTests } from "./blobstore.js";
import { cdpGadDiagnosticTests } from "./cdp-gad-diagnostics.js";
import { credentialTests } from "./credentials.js";
import { docsDiscoveryTests } from "./docs-discovery.js";
import { docsProbeTests } from "./docs-probes.js";
import { agentMessageHasAll, finalMessageHasAll } from "./_helpers.js";
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
        senderMetadata: { type: "agent" },
        complete: true,
        contentType: "invocation" as const,
        content: JSON.stringify(invocation),
      })),
      {
        kind: "message",
        senderId: "agent",
        senderMetadata: { type: "agent" },
        complete: true,
        content: final,
      },
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
        "Completed tool results did not contain one identity-joined blame → change → work unit → command → invocation with request reference → turn → exact current user prompt with source message and sender identities",
    });
  });

  it("requires stale RPC catalog guidance to preserve exact-build authority", () => {
    const test = docsProbeTests.find(
      (candidate) => candidate.name === "docs-do-rpc-catalog-mismatch"
    )!;
    const docsRead = {
      name: "docs_open",
      execution: {
        status: "complete",
        isError: false,
        result: {
          text: "WORKSPACE_RPC_METHOD_UNDECLARED means the exact active provider build does not declare the requested method. Inspect its declared methods.",
        },
      },
    };

    expect(
      test.validate(
        execution(
          "The source edit is not the live contract. Publish or activate the exact provider build, or use a declared method from the live service docs. Do not bypass this with raw addressing.",
          [docsRead]
        )
      ).passed
    ).toBe(true);
    expect(
      test.validate(execution("Call the raw Durable Object target directly.", [docsRead])).passed
    ).toBe(false);
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
    expect(
      test.validate(
        execution("The generated collection contained 200,000 items.", [
          {
            ...invocation,
            execution: {
              status: "complete",
              isError: false,
              result: { details: { returnValue: { totalItems: 200000 } } },
            },
          },
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("accepts the scalar identity returned by workspace.getActive", () => {
    const test = rpcTests.find((candidate) => candidate.name === "cross-service-call")!;
    expect(
      test.validate(
        execution("The active workspace ID is dev.", [
          {
            name: "eval",
            arguments: { code: "return workspace.getActive();" },
            execution: {
              status: "complete",
              isError: false,
              result: { details: { returnValue: "dev" } },
            },
          },
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
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

  it("accepts the bounded channel-health inspector as canonical channel history evidence", () => {
    const test = agenticRuntimeTests.find(
      (candidate) => candidate.name === "channel-envelope-inspection-bounded"
    )!;
    expect(
      test.validate(
        execution("The bounded channel health report found no history.", [
          {
            name: "eval",
            arguments: {
              code: 'await gad.inspectAgentHealth({ channelId: "fake", limit: 10 });',
            },
            execution: { status: "complete", isError: false },
          },
        ])
      )
    ).toEqual({ passed: true });
  });

  it("accepts agent.describe as canonical agent debug-state evidence", () => {
    const test = agenticRuntimeTests.find(
      (candidate) => candidate.name === "agent-debug-state-method"
    )!;
    expect(
      test.validate(
        execution("The agent exposes debug state through its available description.", [
          {
            name: "eval",
            arguments: {
              code: "return await agent.describe();",
            },
            execution: { status: "complete", isError: false },
          },
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("accepts the canonical direct VCS tool as runtime VCS evidence", () => {
    const test = agenticRuntimeTests.find(
      (candidate) => candidate.name === "runtime-vcs-client-helper"
    )!;
    expect(
      test.validate(
        execution("The VCS client is available and usable.", [
          {
            name: "vcs",
            arguments: { operation: "status" },
            execution: { status: "complete", isError: false, result: { clean: true } },
          },
        ])
      )
    ).toEqual({ passed: true });
  });

  it("accepts typed gad.status metrics", () => {
    const test = agenticRuntimeTests.find((candidate) => candidate.name === "gad-status-summary")!;
    expect(
      test.validate(
        execution("The GAD status returned one metric value.", [
          {
            name: "eval",
            arguments: {
              code: "return await gad.status();",
            },
            execution: {
              status: "complete",
              isError: false,
              result: { metrics: [{ metric: "log_events", value: 1 }] },
            },
          },
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("accepts a human-formatted two-thousand result", () => {
    const test = agenticRuntimeTests.find(
      (candidate) => candidate.name === "large-eval-result-terminal"
    )!;
    expect(
      test.validate(
        execution("Created a concise summary for 2,000 items.", [
          {
            name: "eval",
            arguments: { code: "return Array.from({ length: 2000 }, (_, i) => i).length;" },
            execution: { status: "complete", isError: false, result: 2000 },
          },
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("accepts the structured scoped test-runner request and passing result", () => {
    const test = agenticRuntimeTests.find(
      (candidate) => candidate.name === "workspace-test-runner-extension"
    )!;
    expect(
      test.validate(
        execution("Passed 12 tests, failed 0, in context ctx-1.", [
          {
            name: "eval",
            arguments: {
              code: [
                'import { extensions } from "@workspace/runtime";',
                'return extensions.invoke("@workspace-extensions/test-runner", "run", [{',
                '  target: "extensions/test-runner",',
                '  fileFilter: "index.test.ts",',
                "}]);",
              ].join("\n"),
            },
            execution: {
              status: "complete",
              isError: false,
              result: { passed: 12, failed: 0, total: 12, contextId: "ctx-1" },
            },
          },
        ])
      )
    ).toEqual({ passed: true, reason: undefined });
  });

  it("pregrants only the test-runner provider capability for the scenario", () => {
    const test = agenticRuntimeTests.find(
      (candidate) => candidate.name === "workspace-test-runner-extension"
    )!;
    expect(test.authorityPolicy).toEqual({
      authority: [
        {
          ruleId: "workspace-test-runner-execution",
          capability: {
            kind: "prefix",
            prefix: "userland:extensions/test-runner/native.tests.execute#",
          },
          resource: {
            kind: "exact",
            key: "native.tests:extension:@workspace-extensions/test-runner",
          },
          tier: "gated",
          decision: "once",
        },
      ],
    });
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

  it("validates delivered transcript messages without conflating separate messages", () => {
    const result = execution("The requested action was delivered.");
    result.messages.splice(1, 0, {
      id: "delivered-action",
      kind: "message",
      senderId: "agent",
      senderMetadata: { type: "agent" },
      complete: true,
      content:
        '<ActionButton message="Follow-up acknowledged">Open follow-up</ActionButton> MDX_ACTION_OK',
    });
    expect(agentMessageHasAll(result, ["MDX_ACTION_OK", "ActionButton"])).toEqual({
      passed: true,
      reason: undefined,
    });

    result.messages[1]!.content = "<ActionButton>Open follow-up</ActionButton>";
    expect(agentMessageHasAll(result, ["MDX_ACTION_OK", "ActionButton"]).passed).toBe(false);
  });

  it("validates an action-button response as the product outcome", () => {
    const test = interactionSurfaceTests.find(
      (candidate) => candidate.name === "mdx-action-button-message"
    )!;
    expect(test.validation).toBe("harness");
    expect(
      test.validate(execution('<ActionButton message="Tell me more">Continue</ActionButton>'))
    ).toEqual({ passed: true, reason: undefined });
  });
});
