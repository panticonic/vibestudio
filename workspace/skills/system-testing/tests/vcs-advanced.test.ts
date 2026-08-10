import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { vcsTests } from "./vcs.js";
import { vcsAdvancedTests } from "./vcs-advanced.js";

function invocation(
  id: string,
  name: string,
  code: string | Record<string, unknown>,
  result: unknown
) {
  return {
    kind: "message" as const,
    senderId: "agent",
    senderMetadata: { type: "agent" },
    complete: true,
    contentType: "invocation" as const,
    invocation: {
      id,
      name,
      arguments: typeof code === "string" ? (code ? { code } : {}) : code,
      execution: { status: "complete", result, isError: false },
    },
  };
}

function execution(final: string, calls: ReturnType<typeof invocation>[]): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      { kind: "message", senderId: "user", complete: true, content: "prompt" },
      ...calls,
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

describe("reduced VCS agentic catalog", () => {
  it("keeps every agent prompt user-like and free of method choreography", () => {
    expect([...vcsTests, ...vcsAdvancedTests]).toHaveLength(13);
    for (const test of [...vcsTests, ...vcsAdvancedTests]) {
      expect(test.prompt).not.toContain("vcs.");
      expect(test.prompt).not.toContain("expectedWorkingHead");
      expect(test.prompt).not.toContain("commandId");
      expect(test.prompt).not.toContain("frontier");
      expect(test.prompt).not.toContain("certificate");
      expect(test.prompt).not.toContain("outcome");
      expect(test.prompt).not.toContain("atom");
    }
    for (const test of vcsAdvancedTests) {
      expect(test.prompt).not.toMatch(/\bVCS_[A-Z_]+\b/u);
      expect(test.prompt).not.toMatch(/\b(?:restored|original|counteraction|refusal|recovered):/u);
    }
  });

  it("requires ordinary read output to carry exact blame-backed memory", () => {
    const test = vcsAdvancedTests.find(({ name }) => name === "vcs-read-injected-memory")!;
    const read = invocation(
      "read-memory",
      "read",
      { path: "projects/demo/src/retry-policy.ts" },
      {
        content: [
          { type: "text", text: "export const retryCeiling = 7;\n" },
          {
            type: "text",
            text: "memory · projects/demo/src/retry-policy.ts · shown lines 1-1",
          },
        ],
        details: {
          path: "projects/demo/src/retry-policy.ts",
          displayedRange: {
            coordinateKind: "utf16",
            start: 0,
            end: 31,
            startLine: 1,
            endLine: 1,
          },
          provenance: {
            status: "attached",
            episodes: [
              {
                change: { kind: "change", changeId: "change:retry" },
                workUnit: { kind: "work-unit", workUnitId: "work-unit:retry" },
                command: { kind: "command", commandId: "command:retry" },
                authorContextId: "context:author",
                intent: {
                  tier: "trigger",
                  text: "asked by user:test: Meridian relays reserve one retry slot for delayed acknowledgements",
                },
              },
            ],
          },
        },
      }
    );
    const final =
      "The retry ceiling stays at seven because Meridian relays reserve one slot for delayed acknowledgements.";

    expect(test.validate(execution(final, [read]))).toEqual({
      passed: true,
      reason: undefined,
    });

    const withoutMemory = structuredClone(read);
    const details = (
      withoutMemory.invocation.execution.result as { details: Record<string, unknown> }
    ).details;
    delete details["provenance"];
    expect(test.validate(execution(final, [withoutMemory])).passed).toBe(false);
  });

  it("accepts conclusive move/copy receipts and strictly validates an optional deeper walk", () => {
    const test = vcsAdvancedTests.find(({ name }) => name === "vcs-explicit-move-copy")!;
    const moveState = { kind: "application", applicationId: "application:move" };
    const copyState = { kind: "application", applicationId: "application:copy" };
    const copySource = {
      state: moveState,
      repositoryId: "repository:fixture",
      fileId: "file:source",
    };
    const calls = [
      invocation("move", "move_file", "", {
        operation: "moved",
        source: {
          state: { kind: "event", eventId: "event:base" },
          repositoryId: "repository:fixture",
          fileId: "file:moved",
        },
        destination: {
          state: moveState,
          repositoryId: "repository:fixture",
          fileId: "file:moved",
        },
        workUnitId: "work:move",
        applicationId: "application:move",
        changeId: "change:move",
      }),
      invocation("copy", "copy_file", "", {
        operation: "copied",
        source: copySource,
        destination: {
          state: copyState,
          repositoryId: "repository:fixture",
          fileId: "file:copy",
        },
        workUnitId: "work:copy",
        applicationId: "application:copy",
        changeId: "change:copy",
      }),
      invocation(
        "source-endpoint",
        "provenance",
        {},
        {
          adjacency: [
            {
              kind: "authored-copy-source",
              from: { kind: "change", changeId: "change:copy" },
              to: { kind: "file", ...copySource },
            },
          ],
        }
      ),
      invocation(
        "mapped-copy",
        "provenance",
        {},
        {
          node: {
            kind: "applied-change",
            value: {
              appliedChangeId: "applied:copy",
              applicationId: "application:copy",
              changeId: "change:copy",
            },
          },
          adjacency: [
            {
              kind: "realizes-change",
              from: { kind: "applied-change", appliedChangeId: "applied:copy" },
              to: { kind: "change", changeId: "change:copy" },
            },
            {
              kind: "copies-content",
              from: { kind: "applied-change", appliedChangeId: "applied:copy" },
              to: { kind: "applied-change", appliedChangeId: "applied:source" },
            },
          ],
        }
      ),
    ];
    const final = "The relocated file retained its identity; the duplicate has linked ancestry.";
    expect(test.validate(execution(final, calls))).toEqual({ passed: true, reason: undefined });
    expect(test.validate(execution(final, calls.slice(0, 2)))).toEqual({
      passed: true,
      reason: undefined,
    });
    expect(test.validate(execution(final, calls.slice(1))).passed).toBe(false);

    const arbitraryEdge = structuredClone(calls);
    const arbitraryResult = arbitraryEdge[3]!.invocation.execution.result as {
      adjacency: Array<{ from: { appliedChangeId: string } }>;
    };
    arbitraryResult.adjacency[1]!.from.appliedChangeId = "applied:unrelated";
    expect(test.validate(execution(final, arbitraryEdge)).passed).toBe(false);
  });

  it("accepts a structured stale-basis refusal followed by a new command", () => {
    const test = vcsAdvancedTests.find(({ name }) => name === "vcs-stale-basis-recovery")!;
    const beforeStale = {
      contextId: "context:test",
      committed: { kind: "event", eventId: "event:base" },
      workingHead: { kind: "application", applicationId: "application:advanced" },
      clean: false,
      workingCounts: { applications: 2, workUnits: 2, changes: 2 },
      integrating: [],
    };
    const recoveredHead = { kind: "application", applicationId: "application:recovered" };
    const result = execution(
      "The stale attempt changed nothing, and the intended update succeeded from a fresh view.",
      [
        invocation(
          "recover",
          "eval",
          [
            "const advance = await vcs.edit(advanceRequest);",
            "try { await vcs.edit(staleRequest); } catch (error) { refusal = { code: error.code }; }",
            "const retry = await vcs.edit(freshRequest);",
          ].join("\n"),
          {
            staleAttempt: {
              commandId: "command:stale",
              error: { code: "RevisionChanged" },
            },
            statusAfterAdvance: beforeStale,
            statusAfterStale: structuredClone(beforeStale),
            retry: {
              commandId: "command:recovered",
              contextId: "context:test",
              workUnitId: "work:recovered",
              applicationId: "application:recovered",
              changeCount: 1,
              changeIds: ["change:recovered"],
              incorporatedChangeCount: 0,
              incorporatedChangeIds: [],
              decisionIds: [],
              workingHead: recoveredHead,
            },
            statusAfterRetry: {
              ...beforeStale,
              workingHead: recoveredHead,
              workingCounts: { applications: 3, workUnits: 3, changes: 3 },
              integrating: [],
            },
          }
        ),
      ]
    );
    expect(test.validate(result)).toEqual({ passed: true, reason: undefined });

    const naturalSingleCell = execution(
      "The rejected stale request had no effect, and the fresh retry succeeded.",
      [
        invocation(
          "natural-recovery",
          "eval",
          [
            "const advance = await vcs.edit({ commandId: crypto.randomUUID(), expectedWorkingHead: base, changes });",
            "try { await vcs.edit({ commandId: crypto.randomUUID(), expectedWorkingHead: base, changes }); } catch (error) { staleError = { code: error.code }; }",
            "const statusAfterStale = await vcs.status({ contextId });",
            "const recovered = await vcs.edit({ commandId: crypto.randomUUID(), expectedWorkingHead: statusAfterStale.workingHead, changes });",
            "const statusFinal = await vcs.status({ contextId });",
          ].join("\n"),
          {
            advance: {
              commandId: "command:advance",
              contextId: "context:test",
              workUnitId: "work:advance",
              applicationId: "application:advanced",
              workingHead: { kind: "application", applicationId: "application:advanced" },
            },
            staleError: { code: "RevisionChanged" },
            statusAfterStale: beforeStale,
            recovered: {
              commandId: "command:recovered",
              contextId: "context:test",
              workUnitId: "work:recovered",
              applicationId: "application:recovered",
              workingHead: recoveredHead,
            },
            statusFinal: {
              ...beforeStale,
              workingHead: recoveredHead,
              workingCounts: { applications: 3, workUnits: 3, changes: 3 },
              integrating: [],
            },
          }
        ),
      ]
    );
    expect(test.validate(naturalSingleCell)).toEqual({ passed: true, reason: undefined });

    const rawRpcSingleCell = execution(
      "The rejected stale request had no effect, and the fresh retry succeeded.",
      [
        invocation(
          "raw-rpc-recovery",
          "eval",
          [
            "const advance2 = await rpc.call('main', 'vcs.edit', [{ commandId: 'command:advance', expectedWorkingHead: base, changes }]);",
            "try { await rpc.call('main', 'vcs.edit', [{ commandId: 'command:stale', expectedWorkingHead: base, changes }]); } catch (error) { stale = { code: error.code }; }",
            "const statusAfterStale = await rpc.call('main', 'vcs.status', [{ contextId }]);",
            "const retry4 = await rpc.call('main', 'vcs.edit', [{ commandId: 'command:fresh', expectedWorkingHead: statusAfterStale.workingHead, changes }]);",
            "const statusFinal = await rpc.call('main', 'vcs.status', [{ contextId }]);",
          ].join("\n"),
          {
            advance2: {
              commandId: "command:advance",
              workUnitId: "work:advance",
              applicationId: "application:advanced",
              workingHead: { applicationId: "application:advanced", kind: "application" },
            },
            stale: { code: "RevisionChanged" },
            statusAfterStale: beforeStale,
            retry4: {
              commandId: "command:fresh",
              workUnitId: "work:fresh",
              applicationId: "application:recovered",
              workingHead: { applicationId: "application:recovered", kind: "application" },
            },
            statusFinal: {
              ...beforeStale,
              workingHead: { kind: "application", applicationId: "application:recovered" },
              workingCounts: { applications: 3, workUnits: 3, changes: 3 },
              integrating: [],
            },
          }
        ),
      ]
    );
    expect(test.validate(rawRpcSingleCell)).toEqual({ passed: true, reason: undefined });

    const conciseNaturalShape = execution(
      "The rejected stale request had no effect, and the fresh retry succeeded.",
      [
        invocation(
          "concise-natural-recovery",
          "eval",
          [
            "const cmd = (label) => `demo:${label}:${Date.now()}:${Math.random()}`;",
            'const first = await rpc.call("main", "vcs.edit", [{ commandId: cmd("advance"), expectedWorkingHead: staleBasis, changes }]);',
            'try { await rpc.call("main", "vcs.edit", [{ commandId: cmd("stale"), expectedWorkingHead: staleBasis, changes }]); } catch (error) { staleError = { code: error.code }; }',
            'const afterRefusal = await rpc.call("main", "vcs.status", [{ contextId }]);',
            'const fresh = await rpc.call("main", "vcs.edit", [{ commandId: cmd("fresh"), expectedWorkingHead: first.workingHead, changes }]);',
            'const final = await rpc.call("main", "vcs.status", [{ contextId }]);',
          ].join("\n"),
          {
            first: {
              commandId: "command:advance",
              workUnitId: "work:advance",
              applicationId: "application:advanced",
              workingHead: { applicationId: "application:advanced", kind: "application" },
            },
            staleError: { code: "RevisionChanged" },
            afterRefusal: beforeStale,
            fresh: {
              commandId: "command:fresh",
              workUnitId: "work:fresh",
              applicationId: "application:recovered",
              workingHead: { applicationId: "application:recovered", kind: "application" },
            },
            final: {
              ...beforeStale,
              workingHead: { kind: "application", applicationId: "application:recovered" },
              workingCounts: { applications: 3, workUnits: 3, changes: 3 },
              integrating: [],
            },
          }
        ),
      ]
    );
    expect(test.validate(conciseNaturalShape)).toEqual({ passed: true, reason: undefined });

    const splitCellProof = execution(
      "The rejected stale request had no effect, and the fresh retry succeeded.",
      [
        invocation(
          "advance-cell",
          "eval",
          "const first = await vcs.edit({ commandId: 'command:advance', expectedWorkingHead: base, changes });",
          {
            first: {
              commandId: "command:advance",
              workUnitId: "work:advance",
              applicationId: "application:advanced",
              workingHead: { applicationId: "application:advanced", kind: "application" },
            },
          }
        ),
        invocation(
          "refusal-and-recovery-cell",
          "eval",
          [
            "try { await vcs.edit({ commandId: 'command:stale', expectedWorkingHead: base, changes }); } catch (error) { staleError = { code: error.code }; }",
            "const afterRefusalStatus = await vcs.status({ contextId });",
            "const freshResult = await vcs.edit({ commandId: 'command:fresh', expectedWorkingHead: afterRefusalStatus.workingHead, changes });",
            "const finalStatus = await vcs.status({ contextId });",
          ].join("\n"),
          {
            staleError: { code: "RevisionChanged" },
            afterRefusalStatus: beforeStale,
            freshResult: {
              commandId: "command:fresh",
              workUnitId: "work:fresh",
              applicationId: "application:recovered",
              workingHead: { applicationId: "application:recovered", kind: "application" },
            },
            finalStatus: {
              ...beforeStale,
              workingHead: { kind: "application", applicationId: "application:recovered" },
              workingCounts: { applications: 3, workUnits: 3, changes: 3 },
              integrating: [],
            },
          }
        ),
      ]
    );
    expect(test.validate(splitCellProof)).toEqual({ passed: true, reason: undefined });

    const neutralStatusNames = execution(
      "The rejected stale request had no effect, and the fresh retry succeeded.",
      [
        invocation(
          "neutral-status-names",
          "eval",
          [
            "const first = await vcs.edit({ commandId: cmd1, expectedWorkingHead: basis, changes });",
            "try { await vcs.edit({ commandId: cmd2, expectedWorkingHead: basis, changes }); } catch (error) { staleError = { code: error.code }; }",
            "const status1 = await vcs.status({ contextId });",
            "const fresh = await vcs.edit({ commandId: cmd3, expectedWorkingHead: status1.workingHead, changes });",
            "const finalStatus = await vcs.status({ contextId });",
          ].join("\n"),
          {
            first: {
              commandId: "command:advance",
              workUnitId: "work:advance",
              applicationId: "application:advanced",
              workingHead: { applicationId: "application:advanced", kind: "application" },
            },
            staleError: { code: "RevisionChanged" },
            status1: beforeStale,
            fresh: {
              commandId: "command:fresh",
              workUnitId: "work:fresh",
              applicationId: "application:recovered",
              workingHead: { applicationId: "application:recovered", kind: "application" },
            },
            finalStatus: {
              ...beforeStale,
              workingHead: { kind: "application", applicationId: "application:recovered" },
              workingCounts: { applications: 3, workUnits: 3, changes: 3 },
              integrating: [],
            },
          }
        ),
      ]
    );
    expect(test.validate(neutralStatusNames)).toEqual({ passed: true, reason: undefined });
  });

  it("proves an identical uncertain command retry from canonical results", () => {
    const test = vcsAdvancedTests.find(({ name }) => name === "vcs-command-idempotency")!;
    const mutation = {
      commandId: "command:one",
      contextId: "context:test",
      workUnitId: "work:one",
      applicationId: "application:one",
      changeCount: 1,
      changeIds: ["change:one"],
      incorporatedChangeCount: 0,
      incorporatedChangeIds: [],
      decisionIds: [],
      workingHead: { kind: "application", applicationId: "application:one" },
    };
    const proof = {
      first: mutation,
      retry: structuredClone(mutation),
      status: {
        contextId: "context:test",
        workingHead: { kind: "application", applicationId: "application:one" },
        workingCounts: { applications: 1, workUnits: 1, changes: 1 },
        integrating: [],
      },
    };
    const call = (returnValue: unknown) =>
      invocation(
        "idempotency",
        "eval",
        "const first = await vcs.edit(request); const retry = await vcs.edit(request);",
        { details: { returnValue } }
      );
    const final = "The uncertain retry returned the same result and created no duplicate history.";

    expect(test.validate(execution(final, [call(proof)]))).toEqual({
      passed: true,
      reason: undefined,
    });
    const rawCall = invocation(
      "idempotency-raw",
      "eval",
      "const first = await rpc.call('main', 'vcs.edit', [request]); const retry = await rpc.call('main', 'vcs.edit', [request]);",
      { details: { returnValue: proof } }
    );
    expect(test.validate(execution(final, [rawCall]))).toEqual({
      passed: true,
      reason: undefined,
    });
    expect(
      test.validate(
        execution(final, [
          call({
            first: mutation,
            retry: structuredClone(mutation),
          }),
        ])
      )
    ).toEqual({ passed: true, reason: undefined });

    const oneSubmission = invocation(
      "one-submission",
      "eval",
      "const first = await vcs.edit(request);",
      { details: { returnValue: proof } }
    );
    expect(test.validate(execution(final, [oneSubmission])).passed).toBe(false);
    expect(test.validate(execution("", [call(proof)])).passed).toBe(false);
  });

  it("joins revert to its exact counteracted change and restored final content", () => {
    const test = vcsAdvancedTests.find(({ name }) => name === "vcs-revert-preserves-history")!;
    const path = "projects/demo/src/value.ts";
    const calls = [
      invocation(
        "edit",
        "edit",
        { path, oldText: "value = 1", newText: "value = 2" },
        {
          storage: "vcs",
          vcsResult: {
            applicationId: "application:original",
            changeCount: 1,
            changeIds: ["change:original"],
            workingHead: { kind: "application", applicationId: "application:original" },
          },
        }
      ),
      invocation(
        "commit-original",
        "vcs",
        { operation: "commit", message: "Named change" },
        {
          operation: "commit",
          result: {
            event: { kind: "event", eventId: "event:original" },
            committedApplicationIds: ["application:original"],
            integrationSourceEventIds: [],
          },
        }
      ),
      invocation(
        "revert",
        "vcs",
        {
          operation: "revert",
          changeIds: ["change:original"],
        },
        {
          operation: "revert",
          result: {
            applicationId: "application:counteraction",
            changeIds: ["change:counteraction"],
            workingHead: { kind: "application", applicationId: "application:counteraction" },
          },
        }
      ),
      invocation(
        "counteracts",
        "provenance",
        {},
        {
          adjacency: [
            {
              kind: "counteracts",
              from: { kind: "change", changeId: "change:counteraction" },
              to: { kind: "change", changeId: "change:original" },
            },
          ],
        }
      ),
      invocation(
        "commit-counteraction",
        "vcs",
        { operation: "commit", message: "Undo named change" },
        {
          operation: "commit",
          result: {
            event: { kind: "event", eventId: "event:restored" },
            committedApplicationIds: ["application:counteraction"],
            integrationSourceEventIds: [],
          },
        }
      ),
      invocation(
        "status",
        "vcs",
        { operation: "status" },
        {
          operation: "status",
          result: {
            clean: true,
            committed: { kind: "event", eventId: "event:restored" },
            workingHead: { kind: "event", eventId: "event:restored" },
            workingCounts: { applications: 0, workUnits: 0, changes: 0 },
            integrating: [],
          },
        }
      ),
      invocation(
        "read",
        "read",
        { path },
        {
          protocolContent: [{ type: "text", text: "export const value = 1;\n" }],
          details: { path },
        }
      ),
    ];
    const final =
      "The file is restored and both the original edit and its reversal remain in history.";
    expect(test.validate(execution(final, calls))).toEqual({ passed: true, reason: undefined });

    const arbitrary = structuredClone(calls);
    const edge = arbitrary[3]!.invocation.execution.result as {
      adjacency: Array<{ to: { changeId: string } }>;
    };
    edge.adjacency[0]!.to.changeId = "change:other";
    expect(test.validate(execution(final, arbitrary)).passed).toBe(false);

    const attachedCounteraction = structuredClone(calls);
    attachedCounteraction.splice(3, 1);
    const finalRead = attachedCounteraction.at(-1)!.invocation.execution.result as {
      details: Record<string, unknown>;
    };
    finalRead.details["provenance"] = {
      status: "attached",
      state: { kind: "event", eventId: "event:restored" },
      episodes: [
        {
          change: { kind: "change", changeId: "change:counteraction" },
          counteractsChangeIds: ["change:original"],
        },
      ],
    };
    expect(test.validate(execution(final, attachedCounteraction))).toEqual({
      passed: true,
      reason: undefined,
    });

    const committedReadWithoutStatus = structuredClone(attachedCounteraction);
    committedReadWithoutStatus.splice(4, 1);
    committedReadWithoutStatus.unshift(
      invocation(
        "initial-status",
        "vcs",
        { operation: "status" },
        {
          operation: "status",
          result: {
            clean: true,
            committed: { kind: "event", eventId: "event:base" },
            workingHead: { kind: "event", eventId: "event:base" },
            workingCounts: { applications: 0, workUnits: 0, changes: 0 },
            integrating: [],
          },
        }
      )
    );
    expect(test.validate(execution(final, committedReadWithoutStatus))).toEqual({
      passed: true,
      reason: undefined,
    });

    const inverseEffectProof = structuredClone(calls);
    inverseEffectProof.pop();
    inverseEffectProof.splice(
      4,
      0,
      invocation(
        "original-change",
        "provenance",
        { target: "change:original" },
        {
          node: {
            kind: "change",
            value: {
              changeId: "change:original",
              effects: [
                {
                  kind: "content",
                  fileId: "file:value",
                  beforeContentHash: "hash:one",
                  afterContentHash: "hash:two",
                },
              ],
            },
          },
        }
      ),
      invocation(
        "counteraction-change",
        "provenance",
        { target: "change:counteraction" },
        {
          node: {
            kind: "change",
            value: {
              changeId: "change:counteraction",
              effects: [
                {
                  kind: "content",
                  fileId: "file:value",
                  beforeContentHash: "hash:two",
                  afterContentHash: "hash:one",
                },
              ],
            },
          },
        }
      )
    );
    expect(test.validate(execution(final, inverseEffectProof))).toEqual({
      passed: true,
      reason: undefined,
    });

    const notRestored = structuredClone(calls);
    const read = notRestored[6]!.invocation.execution.result as {
      protocolContent: Array<{ text: string }>;
    };
    read.protocolContent[0]!.text = "export const value = 2;\n";
    expect(test.validate(execution(final, notRestored)).passed).toBe(false);
  });

  it("joins blame identities through exact causal endpoints to an inspected invocation", () => {
    const test = vcsAdvancedTests.find(({ name }) => name === "vcs-walkable-causality-blame")!;
    const resultValue = {
      blame: {
        spans: [
          {
            start: 0,
            end: 12,
            change: { kind: "change", changeId: "change:origin" },
            workUnit: { kind: "work-unit", workUnitId: "work-unit:origin" },
            command: { kind: "command", commandId: "command:origin" },
            path: [],
            stop: "authored",
          },
        ],
      },
      walks: [
        {
          edges: [
            {
              kind: "authored-change",
              from: { kind: "work-unit", workUnitId: "work-unit:origin" },
              to: { kind: "change", changeId: "change:origin" },
            },
            {
              kind: "caused-by",
              from: { kind: "work-unit", workUnitId: "work-unit:origin" },
              to: { kind: "command", commandId: "command:origin" },
            },
            {
              kind: "caused-by",
              from: { kind: "command", commandId: "command:origin" },
              to: {
                kind: "trajectory-invocation",
                logId: "log:causal",
                head: "head:causal",
                invocationId: "invocation:causal",
              },
            },
            {
              kind: "part-of-turn",
              from: {
                kind: "trajectory-invocation",
                logId: "log:causal",
                head: "head:causal",
                invocationId: "invocation:causal",
              },
              to: {
                kind: "trajectory-turn",
                logId: "log:causal",
                head: "head:causal",
                turnId: "turn:causal",
              },
            },
            {
              kind: "triggered-by",
              from: {
                kind: "trajectory-turn",
                logId: "log:causal",
                head: "head:causal",
                turnId: "turn:causal",
              },
              to: {
                kind: "trajectory-message",
                logId: "log:causal",
                head: "head:causal",
                messageId: "message:causal",
              },
            },
          ],
        },
      ],
      inspected: [
        {
          node: {
            kind: "trajectory-invocation",
            value: {
              logId: "log:causal",
              head: "head:causal",
              invocationId: "invocation:causal",
              turnId: "turn:causal",
              name: "write",
              status: "complete",
              terminalOutcome: "success",
              requestRef: {
                protocol: "vibestudio.blob-ref.v1",
                digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                size: 64,
                encoding: "json",
                originalBytes: 64,
              },
              startedEventId: "trajectory-event:start",
              completedEventId: "trajectory-event:complete",
            },
          },
        },
        {
          node: {
            kind: "trajectory-turn",
            value: {
              logId: "log:causal",
              head: "head:causal",
              turnId: "turn:causal",
              triggerMessageId: "message:causal",
            },
          },
        },
        {
          node: {
            kind: "trajectory-message",
            value: {
              logId: "log:causal",
              head: "head:causal",
              messageId: "message:causal",
              role: "user",
              sourceMessageId: "channel-message:causal",
              senderRef: { kind: "user", id: "user:fixture", participantId: "user:fixture" },
              textBlocks: [{ blockId: "block:causal", content: test.prompt }],
            },
          },
        },
      ],
    };
    const final =
      "The untouched content traces to the recorded user request; private reasoning is not evidence.";
    const valid = execution(final, [
      invocation(
        "causality",
        "eval",
        "await vcs.edit(change); await vcs.commit(commit); await vcs.push(push); await vcs.blame(input); await vcs.neighbors(walk); await vcs.inspect(invocation);",
        resultValue
      ),
    ]);
    expect(test.validate(valid)).toEqual({ passed: true, reason: undefined });

    const attached = invocation(
      "causal-read",
      "read",
      { path: "projects/demo/distinctive-note.txt" },
      {
        details: {
          provenance: {
            status: "attached",
            episodes: [
              {
                change: { kind: "change", changeId: "change:origin" },
                workUnit: { kind: "work-unit", workUnitId: "work-unit:origin" },
                command: { kind: "command", commandId: "command:origin" },
                cause: {
                  invocation: {
                    kind: "trajectory-invocation",
                    logId: "log:causal",
                    head: "head:causal",
                    invocationId: "invocation:causal",
                  },
                  turn: {
                    kind: "trajectory-turn",
                    logId: "log:causal",
                    head: "head:causal",
                    turnId: "turn:causal",
                  },
                  message: {
                    kind: "trajectory-message",
                    logId: "log:causal",
                    head: "head:causal",
                    messageId: "message:causal",
                  },
                  sender: { kind: "user", id: "user:fixture", participantId: "user:fixture" },
                  requestRef: {
                    protocol: "vibestudio.blob-ref.v1",
                    digest: "a".repeat(64),
                    size: 64,
                    encoding: "json",
                    originalBytes: 64,
                  },
                  terminalOutcome: "success",
                  triggerText: test.prompt,
                },
              },
            ],
          },
        },
      }
    );
    expect(test.validate(execution(final, [attached]))).toEqual({
      passed: true,
      reason: undefined,
    });

    const minimalAttached = structuredClone(attached);
    const minimalCause = (
      minimalAttached.invocation.execution.result as {
        details: { provenance: { episodes: Array<{ cause: Record<string, unknown> }> } };
      }
    ).details.provenance.episodes[0]!.cause;
    delete minimalCause["requestRef"];
    delete minimalCause["terminalOutcome"];
    expect(test.validate(execution(final, [minimalAttached]))).toEqual({
      passed: true,
      reason: undefined,
    });

    const mismatched = structuredClone(resultValue);
    mismatched.walks[0]!.edges[0]!.to = { kind: "change", changeId: "change:other" };
    expect(
      test.validate(
        execution(final, [
          invocation(
            "causality-mismatch",
            "eval",
            "await vcs.edit(change); await vcs.commit(commit); await vcs.push(push); await vcs.blame(input); await vcs.neighbors(walk); await vcs.inspect(invocation);",
            mismatched
          ),
        ])
      ).passed
    ).toBe(false);

    const unrelatedPrompt = structuredClone(resultValue);
    unrelatedPrompt.inspected[2]!.node.value.textBlocks = [
      { blockId: "block:older", content: "An older, unrelated request" },
    ];
    expect(
      test.validate(
        execution(final, [
          invocation(
            "causality-wrong-prompt",
            "eval",
            "await vcs.edit(change); await vcs.commit(commit); await vcs.push(push); await vcs.blame(input); await vcs.neighbors(walk); await vcs.inspect(invocation);",
            unrelatedPrompt
          ),
        ])
      ).passed
    ).toBe(false);
  });

  it("joins imported blame through its ordinary change, import work, and command", () => {
    const test = vcsAdvancedTests.find(({ name }) => name === "vcs-honest-import-boundary")!;
    expect(test.prompt).toBe(
      "Who changed an untouched line in the disposable project, and what can we actually establish about why it is here?"
    );
    expect(test.prompt).not.toMatch(
      /pre-import|unknown|source URI|revision|digest|work unit|command|blame|inspect|neighbors/iu
    );
    const snapshot = {
      sourceKind: "generated",
      sourceUri: "system-test://vcs-honest-import-boundary/project",
      snapshotRevision: "fixture:revision",
      snapshotDigest: `snapshot:${"a".repeat(64)}`,
      targetRepositoryIds: ["repository:fixture"],
    };
    const intentSummary = "Create the disposable imported fixture";
    const evidence = {
      blame: {
        spans: [
          {
            start: 0,
            end: 8,
            change: { kind: "change", changeId: "change:import" },
            workUnit: { kind: "work-unit", workUnitId: "work:import" },
            command: { kind: "command", commandId: "command:import" },
            path: [],
            stop: "import-boundary",
          },
        ],
      },
      inspections: [
        {
          node: {
            kind: "change",
            value: {
              changeId: "change:import",
              authoredByWorkUnitId: "work:import",
              kind: "file-create",
            },
          },
        },
        {
          node: {
            kind: "work-unit",
            value: {
              workUnitId: "work:import",
              commandId: "command:import",
              kind: "import",
              intentSummary,
              externalSnapshot: snapshot,
            },
          },
        },
        {
          node: {
            kind: "command",
            value: {
              commandId: "command:import",
              method: "importSnapshot",
              status: "complete",
              result: { kind: "work-unit", workUnitId: "work:import" },
            },
          },
        },
      ],
    };
    const final =
      "The line enters our knowledge at the imported snapshot; earlier authorship is not recorded here.";
    const evidenceCalls = (value: typeof evidence) => [
      invocation("boundary-blame", "vcs", { operation: "blame" }, value.blame),
      ...value.inspections.map((inspection, index) =>
        invocation(`boundary-inspection-${index}`, "provenance", {}, inspection)
      ),
    ];
    const result = execution(final, evidenceCalls(evidence));
    expect(test.validate(result)).toEqual({ passed: true, reason: undefined });

    const attached = invocation(
      "import-read",
      "read",
      { path: "packages/demo/src/index.ts" },
      {
        details: {
          provenance: {
            status: "attached",
            episodes: [
              {
                stop: "import-boundary",
                changeKind: "file-create",
                change: { kind: "change", changeId: "change:import" },
                workUnit: { kind: "work-unit", workUnitId: "work:import" },
                command: { kind: "command", commandId: "command:import" },
                intentSummary,
                externalSnapshot: snapshot,
              },
            ],
          },
        },
      }
    );
    expect(test.validate(execution(final, [attached]))).toEqual({
      passed: true,
      reason: undefined,
    });

    const mismatched = structuredClone(evidence);
    mismatched.inspections[0]!.node.value.authoredByWorkUnitId = "work:other";
    expect(test.validate(execution(final, evidenceCalls(mismatched))).passed).toBe(false);

    const pseudoBarrier = structuredClone(evidence);
    pseudoBarrier.inspections[0]!.node.value.kind = "import-barrier";
    expect(test.validate(execution(final, evidenceCalls(pseudoBarrier))).passed).toBe(false);

    const fakeProse = "The line was imported, but this answer has no canonical supporting walk.";
    expect(
      test.validate(
        execution(fakeProse, [
          invocation("boundary-prose-only", "eval", "await vcs.blame(input);", {
            blame: evidence.blame,
            claimedSnapshot: snapshot,
          }),
        ])
      ).passed
    ).toBe(false);

    expect(
      test.validate(
        execution(final, [
          invocation("boundary-arbitrary-eval", "eval", "return evidence;", evidence),
        ])
      ).passed
    ).toBe(false);

    expect(
      test.validate(execution("A concise explanation in ordinary prose.", evidenceCalls(evidence)))
    ).toEqual({ passed: true, reason: undefined });
  });

  it("requires native intent and untouched import evidence to remain two exact joined origins", () => {
    const test = vcsAdvancedTests.find(({ name }) => name === "vcs-edited-import-boundary")!;
    const snapshot = {
      sourceKind: "generated",
      sourceUri: "system-test://vcs-edited-import-boundary/project",
      snapshotRevision: "fixture:revision",
      snapshotDigest: `snapshot:${"c".repeat(64)}`,
      targetRepositoryIds: ["repository:fixture"],
    };
    const importIntent = "Create the disposable imported fixture";
    const nativeSpan = {
      start: 0,
      end: 8,
      change: { kind: "change", changeId: "change:native" },
      workUnit: { kind: "work-unit", workUnitId: "work:native" },
      command: { kind: "command", commandId: "command:native" },
      path: [],
      stop: "authored",
    };
    const importSpan = {
      start: 9,
      end: 18,
      change: { kind: "change", changeId: "change:import" },
      workUnit: { kind: "work-unit", workUnitId: "work:import" },
      command: { kind: "command", commandId: "command:import" },
      path: [],
      stop: "import-boundary",
    };
    const calls = [
      invocation("mixed-blame", "vcs", { operation: "blame" }, { spans: [nativeSpan, importSpan] }),
      invocation("import-blame", "vcs", { operation: "blame" }, { spans: [importSpan] }),
      invocation(
        "native-walk",
        "provenance",
        {},
        {
          adjacency: [
            {
              kind: "authored-change",
              from: { kind: "work-unit", workUnitId: "work:native" },
              to: { kind: "change", changeId: "change:native" },
            },
            {
              kind: "caused-by",
              from: { kind: "work-unit", workUnitId: "work:native" },
              to: { kind: "command", commandId: "command:native" },
            },
            {
              kind: "caused-by",
              from: { kind: "command", commandId: "command:native" },
              to: {
                kind: "trajectory-invocation",
                logId: "log:mixed",
                head: "main",
                invocationId: "invocation:native",
              },
            },
            {
              kind: "part-of-turn",
              from: {
                kind: "trajectory-invocation",
                logId: "log:mixed",
                head: "main",
                invocationId: "invocation:native",
              },
              to: {
                kind: "trajectory-turn",
                logId: "log:mixed",
                head: "main",
                turnId: "turn:mixed",
              },
            },
            {
              kind: "triggered-by",
              from: {
                kind: "trajectory-turn",
                logId: "log:mixed",
                head: "main",
                turnId: "turn:mixed",
              },
              to: {
                kind: "trajectory-message",
                logId: "log:mixed",
                head: "main",
                messageId: "message:mixed",
              },
            },
          ],
        }
      ),
      invocation(
        "native-invocation",
        "provenance",
        {},
        {
          node: {
            kind: "trajectory-invocation",
            value: {
              logId: "log:mixed",
              head: "main",
              invocationId: "invocation:native",
              turnId: "turn:mixed",
              requestRef: { digest: "d".repeat(64) },
            },
          },
          adjacency: [],
        }
      ),
      invocation(
        "native-turn",
        "provenance",
        {},
        {
          node: {
            kind: "trajectory-turn",
            value: {
              logId: "log:mixed",
              head: "main",
              turnId: "turn:mixed",
              triggerMessageId: "message:mixed",
            },
          },
          adjacency: [],
        }
      ),
      invocation(
        "native-message",
        "provenance",
        {},
        {
          node: {
            kind: "trajectory-message",
            value: {
              logId: "log:mixed",
              head: "main",
              messageId: "message:mixed",
              role: "user",
              sourceMessageId: "channel-message:mixed",
              senderRef: { id: "user:fixture" },
              textBlocks: [{ blockId: "block:mixed", content: test.prompt }],
            },
          },
          adjacency: [],
        }
      ),
      invocation(
        "import-change",
        "provenance",
        {},
        {
          node: {
            kind: "change",
            value: {
              changeId: "change:import",
              authoredByWorkUnitId: "work:import",
              kind: "file-create",
            },
          },
          adjacency: [],
        }
      ),
      invocation(
        "import-work",
        "provenance",
        {},
        {
          node: {
            kind: "work-unit",
            value: {
              workUnitId: "work:import",
              commandId: "command:import",
              kind: "import",
              intentSummary: importIntent,
              externalSnapshot: snapshot,
            },
          },
          adjacency: [],
        }
      ),
      invocation(
        "import-command",
        "provenance",
        {},
        {
          node: {
            kind: "command",
            value: {
              commandId: "command:import",
              method: "importSnapshot",
              status: "complete",
              result: { kind: "work-unit", workUnitId: "work:import" },
            },
          },
          adjacency: [],
        }
      ),
    ];
    const final =
      "The edited line has native request history; the neighboring line is only known from the imported snapshot onward.";
    expect(test.validate(execution(final, calls))).toEqual({ passed: true, reason: undefined });

    const unjoinedNative = structuredClone(calls);
    const nativeWalk = unjoinedNative[2]!.invocation.execution.result as {
      adjacency: Array<{ to: Record<string, unknown> }>;
    };
    nativeWalk.adjacency[1]!.to["commandId"] = "command:unrelated";
    expect(test.validate(execution(final, unjoinedNative)).passed).toBe(false);

    const unjoinedImport = structuredClone(calls);
    const importChange = unjoinedImport[6]!.invocation.execution.result as {
      node: { value: Record<string, unknown> };
    };
    importChange.node.value["authoredByWorkUnitId"] = "work:unrelated";
    expect(test.validate(execution(final, unjoinedImport)).passed).toBe(false);
  });
});
