import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { cdpGadDiagnosticTests } from "./cdp-gad-diagnostics.js";

function executionWithFinal(
  content: string,
  extra: Partial<TestExecutionResult> = {}
): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      {
        kind: "message",
        senderId: "user",
        complete: true,
        content: "prompt",
      },
      {
        kind: "message",
        senderId: "agent",
        complete: true,
        content,
      },
    ],
    ...extra,
  } as TestExecutionResult;
}

function executionWithInvocation(
  content: string,
  invocation: Record<string, unknown>,
  extra: Partial<TestExecutionResult> = {}
): TestExecutionResult {
  const base = executionWithFinal(content, extra);
  return {
    ...base,
    messages: [
      base.messages[0]!,
      {
        kind: "message",
        senderId: "agent",
        complete: true,
        contentType: "invocation",
        content: JSON.stringify(invocation),
      },
      base.messages[1]!,
    ],
  } as TestExecutionResult;
}

const clickTest = cdpGadDiagnosticTests.find(
  (test) => test.name === "cdp-lightweight-click-type-evaluate"
)!;
const stateArgsTest = cdpGadDiagnosticTests.find(
  (test) => test.name === "panel-stateargs-cdp-roundtrip"
)!;
const integrityTest = cdpGadDiagnosticTests.find(
  (test) => test.name === "gad-integrity-diagnostics"
)!;
const branchTest = cdpGadDiagnosticTests.find(
  (test) => test.name === "gad-branch-file-diff-probe"
)!;

describe("cdp-gad diagnostics validators", () => {
  it("rejects a final success marker when an invocation failed", () => {
    const result = clickTest.validate(
      executionWithInvocation("CDP_LIGHTWEIGHT_INTERACTION_OK clicked evaluated screenshot", {
        id: "call-1",
        name: "eval",
        execution: {
          status: "error",
          isError: true,
          result: { error: "data URL DOM was not reachable" },
        },
      })
    );

    expect(result).toMatchObject({
      passed: false,
    });
    expect(result.reason).toContain("Expected no failed tool calls");
  });

  it("rejects terminal failure outcomes even when invocation status is complete", () => {
    const result = clickTest.validate(
      executionWithInvocation("CDP_LIGHTWEIGHT_INTERACTION_OK clicked evaluated screenshot", {
        id: "call-1",
        name: "eval",
        execution: {
          status: "complete",
          terminalOutcome: "tool_error",
          result: "snapshot target not reachable",
        },
      })
    );

    expect(result).toMatchObject({
      passed: false,
    });
    expect(result.reason).toContain("Expected no failed tool calls");
  });

  it("rejects an ok:false diagnostic result behind a final success marker", () => {
    const result = integrityTest.validate(
      executionWithInvocation(
        "GAD_DIAGNOSTICS_OK storage publication turn invocation hashes integrity",
        {
          id: "call-1",
          name: "eval",
          execution: {
            status: "complete",
            result: { summary: { ok: false, problem: "publication mismatch" } },
          },
        }
      )
    );

    expect(result).toMatchObject({
      passed: false,
    });
    expect(result.reason).toContain("ok:false");
  });

  it("rejects a stringified ok:false diagnostic result", () => {
    const result = integrityTest.validate(
      executionWithInvocation(
        "GAD_DIAGNOSTICS_OK storage publication turn invocation hashes integrity",
        {
          id: "call-1",
          name: "eval",
          execution: {
            status: "complete",
            result: '{"summary":{"ok":false}}',
          },
        }
      )
    );

    expect(result).toMatchObject({
      passed: false,
    });
    expect(result.reason).toContain("ok:false");
  });

  it("accepts a live-turn-only GAD health report without forcing the OK marker", () => {
    const result = integrityTest.validate(
      executionWithInvocation(
        "GAD health check reported storage publication turn invocation hashes integrity; no storage, publication, hash, or integrity issues, only the current open turn and nonterminal invocation",
        {
          id: "call-1",
          name: "eval",
          execution: {
            status: "complete",
            result: {
              health: {
                summary: {
                  ok: false,
                  publicationIssues: 0,
                  openTurns: 1,
                  nonterminalInvocations: 1,
                  storageIssues: 0,
                },
              },
              hashes: { ok: true },
              integrity: { ok: true },
            },
          },
        }
      )
    );

    expect(result).toEqual({ passed: true });
  });

  it("rejects ok:false wording in the final success message", () => {
    const result = integrityTest.validate(
      executionWithFinal(
        "GAD_DIAGNOSTICS_OK storage publication turn invocation hashes integrity, but overall ok: false only because the current turn is open"
      )
    );

    expect(result).toMatchObject({
      passed: false,
    });
    expect(result.reason).toContain("ok:false");
  });

  it("rejects impossible success wording in the final message", () => {
    const result = stateArgsTest.validate(
      executionWithFinal(
        "STATEARGS_CDP_OK STATEARGS_CDP_OK_2 snapshot stateArgs, but snapshot target was not reachable"
      )
    );

    expect(result).toMatchObject({
      passed: false,
    });
    expect(result.reason).toContain("not reachable");
  });

  it("accepts controlled branch probe rejections returned as data", () => {
    const result = branchTest.validate(
      executionWithInvocation("GAD_BRANCH_OK branch-files state-probe controlled-errors", {
        id: "call-1",
        name: "eval",
        execution: {
          status: "complete",
          result: {
            checks: [{ name: "branch-files", ok: true }],
            controlledErrors: [
              { name: "write CTE", ok: false, error: "rawSql writes are disabled" },
            ],
          },
        },
      })
    );

    expect(result).toEqual({ passed: true });
  });

  it("accepts unrelated in-flight agent health during a branch probe", () => {
    const result = branchTest.validate(
      executionWithInvocation("GAD_BRANCH_OK branch-files state-probe controlled-errors", {
        id: "call-1",
        name: "eval",
        execution: {
          status: "complete",
          result: {
            priorHealth: {
              summary: {
                ok: false,
                publicationIssues: 0,
                storageIssues: 0,
                openTurns: 1,
                nonterminalInvocations: 1,
              },
            },
            branchFiles: [],
            stateProbe: null,
          },
        },
      })
    );

    expect(result).toEqual({ passed: true });
  });

  it("accepts stringified controlled branch probe rejections returned as data", () => {
    const result = branchTest.validate(
      executionWithInvocation("GAD_BRANCH_OK branch-files state-probe controlled-errors", {
        id: "call-1",
        name: "eval",
        execution: {
          status: "complete",
          result:
            '[eval] Return value:\n{"checks":[{"name":"branch-files","ok":true}],"controlledErrors":[{"name":"write CTE","ok":false,"error":"rawSql writes are disabled"}]}',
        },
      })
    );

    expect(result).toEqual({ passed: true });
  });

  it("accepts explicit no-failure wording when no tool actually failed", () => {
    const result = clickTest.validate(
      executionWithFinal(
        "CDP_LIGHTWEIGHT_INTERACTION_OK clicked evaluated screenshot; no tool failures"
      )
    );

    expect(result).toEqual({ passed: true });
  });

  it("still rejects a missing final marker", () => {
    const result = clickTest.validate(executionWithFinal("clicked evaluated screenshot"));

    expect(result).toMatchObject({
      passed: false,
    });
    expect(result.reason).toContain("Missing CDP_LIGHTWEIGHT_INTERACTION_OK");
  });
});

describe("cdp-gad diagnostics prompts", () => {
  it("stay goal-level instead of encoding implementation details", () => {
    const brittleDetails = [
      "panels/testbench",
      "Unknown build unit",
      "Do not use a data: URL",
      "page.evaluate",
      "gad.inspectAgentHealth",
      "gad.listGadBranchFiles",
      "gad.query",
      "{ rows }",
      "result.rows",
      "trajectory_branches",
      "branch_id",
      "ok:false",
      "bounded APIs",
      "bounded diagnostic APIs",
      "expected:true",
      "rejected:true",
      "do not substitute",
    ];

    for (const test of cdpGadDiagnosticTests) {
      for (const detail of brittleDetails) {
        expect(test.prompt, `${test.name} prompt should not include ${detail}`).not.toContain(
          detail
        );
      }
    }

    expect(stateArgsTest.prompt).toContain("Open a workspace panel");
    expect(integrityTest.prompt).toContain("Run a quick GAD health check");
    expect(branchTest.prompt).toContain("Probe GAD branch and state inspection");
  });
});
