import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { trustedUnitAuthoringTests } from "./trusted-unit-authoring.js";

function execution(
  operations: Array<{ name: string; arguments: Record<string, unknown>; details: unknown }>
) {
  return {
    duration: 1,
    messages: operations.map((operation, index) => ({
      id: `call-${index}`,
      senderId: "agent",
      kind: "message" as const,
      contentType: "invocation" as const,
      complete: true,
      content: "",
      invocation: {
        id: `call-${index}`,
        name: operation.name,
        arguments: operation.arguments,
        execution: {
          status: "complete",
          isError: false,
          result: { details: operation.details },
        },
      },
    })),
  } as unknown as TestExecutionResult;
}

const completeRepair = () =>
  execution([
    {
      name: "verify",
      arguments: { operation: "test", target: "extensions/example" },
      details: { operation: "test", status: "passed" },
    },
    {
      name: "verify",
      arguments: { operation: "build", target: "extensions/example" },
      details: { operation: "build", status: "ok" },
    },
    {
      name: "vcs",
      arguments: { operation: "commit" },
      details: { operation: "commit", result: { event: { kind: "event" } } },
    },
    {
      name: "vcs",
      arguments: { operation: "status" },
      details: { operation: "status", result: { clean: true } },
    },
  ]);

describe("trusted unit authoring evidence", () => {
  it("requires objective evidence without putting the workflow in the prompt", () => {
    for (const test of trustedUnitAuthoringTests) {
      expect(test.validation).toBe("agent-evidence");
      expect(test.validate(completeRepair())).toEqual({ passed: true, reason: undefined });
    }
  });

  it("does not accept an edit that omitted focused verification", () => {
    const missingTest = completeRepair();
    missingTest.messages.shift();

    expect(trustedUnitAuthoringTests[0]!.validate(missingTest)).toMatchObject({ passed: false });
  });
});
