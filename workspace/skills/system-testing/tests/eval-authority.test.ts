import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { evalAuthorityTests } from "./eval-authority.js";

interface MutableEvalInvocation {
  arguments: Record<string, unknown>;
  result: {
    details: {
      authority: { approvalsRequested: number; approvalsDenied: number };
      returnValue: Record<string, unknown>;
    };
  };
}

function evalInvocation(value: TestExecutionResult): MutableEvalInvocation {
  return value.messages[1]!.invocation as unknown as MutableEvalInvocation;
}

function execution(overrides: Partial<TestExecutionResult> = {}): TestExecutionResult {
  return {
    duration: 1,
    messages: [
      { id: "prompt", senderId: "user", kind: "message", complete: true, content: "prompt" },
      {
        id: "eval",
        senderId: "agent",
        kind: "message",
        contentType: "invocation",
        complete: true,
        invocation: {
          id: "eval-call",
          name: "eval",
          status: "complete",
          isError: false,
          arguments: { authority: { preauthorize: [{ method: "corsApproval.authorize" }] } },
          result: {
            details: {
              authority: { approvalsRequested: 1, approvalsDenied: 0 },
              returnValue: { allowed: true, decision: "run" },
            },
          },
        },
      },
      {
        id: "final",
        senderId: "agent",
        kind: "message",
        complete: true,
        content: "AGENT_EVAL_PREAUTHORIZATION_OK",
      },
    ] as TestExecutionResult["messages"],
    ...overrides,
  };
}

function approvalResumeExecution(
  overrides: Partial<TestExecutionResult> = {}
): TestExecutionResult {
  const value = execution();
  const invocation = evalInvocation(value);
  invocation.arguments = { authority: { approvals: "prompt" } };
  invocation.result.details = {
    authority: { approvalsRequested: 1, approvalsDenied: 0 },
    returnValue: { before: 4, after: 5, delta: 1, allowed: true, decision: "once" },
  };
  value.messages[2]!.content = "AGENT_EVAL_APPROVAL_RESUME_OK replayed:no";
  return { ...value, ...overrides };
}

function revocationExecution(overrides: Partial<TestExecutionResult> = {}): TestExecutionResult {
  const value = execution();
  const invocation = evalInvocation(value);
  invocation.arguments = { authority: { approvals: "prompt" } };
  invocation.result.details = {
    authority: { approvalsRequested: 3, approvalsDenied: 0 },
    returnValue: {
      firstAllowed: true,
      firstDecision: "session",
      revoked: true,
      secondCode: "EVAL_GRANT_REVOKED",
      promptedAgain: false,
    },
  };
  value.messages[2]!.content = "AGENT_EVAL_REVOCATION_NEXT_DISPATCH_OK";
  return { ...value, ...overrides };
}

describe("eval authority semantic validation", () => {
  const preauthorization = evalAuthorityTests.find(
    (entry) => entry.name === "agent-eval-preauthorization"
  )!;
  const approvalResume = evalAuthorityTests.find(
    (entry) => entry.name === "agent-eval-approval-resume"
  )!;
  const revocation = evalAuthorityTests.find(
    (entry) => entry.name === "agent-eval-revocation-next-dispatch"
  )!;

  it("requires structured evidence of one reusable preauthorization decision", () => {
    expect(preauthorization.validate(execution())).toEqual({ passed: true });
  });

  it("rejects a success marker accompanied by an unexpected eval failure", () => {
    expect(
      preauthorization.validate(
        execution({
          toolFailures: [{ name: "eval", error: "boom", source: "message" }],
        })
      ).passed
    ).toBe(false);
  });

  it("rejects once because preauthorization cannot authorize only one exact dispatch", () => {
    const value = execution();
    evalInvocation(value).result.details.returnValue["decision"] = "once";
    expect(preauthorization.validate(value).passed).toBe(false);
  });

  it("requires one prompt challenge and an exactly-once counter delta when approval resumes", () => {
    expect(approvalResume.validate(approvalResumeExecution())).toEqual({ passed: true });
  });

  it("rejects a resumed dispatch whose surrounding snippet was replayed", () => {
    const value = approvalResumeExecution();
    const returnValue = evalInvocation(value).result.details.returnValue;
    returnValue["after"] = 6;
    returnValue["delta"] = 2;
    expect(approvalResume.validate(value).passed).toBe(false);
  });

  it("rejects approval-resume evidence without the prompt-mode challenge", () => {
    const value = approvalResumeExecution();
    evalInvocation(value).result.details.authority.approvalsRequested = 0;
    expect(approvalResume.validate(value).passed).toBe(false);
  });

  it("requires a reusable capability grant revoked before the second live dispatch", () => {
    expect(revocation.validate(revocationExecution())).toEqual({ passed: true });
  });

  it("rejects revocation evidence that used a run-local rather than externally saved grant", () => {
    const value = revocationExecution();
    evalInvocation(value).result.details.returnValue["firstDecision"] = "run";
    expect(revocation.validate(value).passed).toBe(false);
  });

  it("rejects a revoked grant that silently reprompted", () => {
    const value = revocationExecution();
    evalInvocation(value).result.details.returnValue["promptedAgain"] = true;
    expect(revocation.validate(value).passed).toBe(false);
  });
});
