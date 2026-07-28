import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { credentialTests } from "./credentials.js";

function execution(code: string, result: unknown = { count: 2, states: ["active"] }) {
  return {
    duration: 0,
    messages: [
      {
        id: "prompt",
        kind: "message",
        senderId: "user",
        complete: true,
        content: "prompt",
      },
      {
        id: "eval",
        kind: "message",
        senderId: "agent",
        complete: true,
        contentType: "invocation",
        content: "",
        invocation: {
          id: "eval-call",
          name: "eval",
          status: "complete",
          terminalOutcome: "success",
          isError: false,
          arguments: { code },
          result: { details: { success: true, returnValue: result } },
        },
      } as unknown as TestExecutionResult["messages"][number],
      {
        id: "final",
        kind: "message",
        senderId: "agent",
        complete: true,
        content:
          "I found two managed credentials. The represented lifecycle state is active; I inspected only the summary without exposing secrets or changing credential state.",
      },
    ],
  } as TestExecutionResult;
}

function test() {
  const found = credentialTests.find((candidate) => candidate.name === "credential-store-inspect");
  if (!found) throw new Error("Missing credential-store-inspect test");
  return found;
}

describe("credential store system test validator", () => {
  it("accepts one bounded, read-only managed-store inspection", () => {
    expect(
      test().validate(
        execution(
          "const records = await credentials.inspectStoredCredentials(); return { count: records.length, states: [...new Set(records.map((record) => record.lifecycle.state))] };"
        )
      )
    ).toEqual({ passed: true });
  });

  it("rejects prose-only inspection claims", () => {
    expect(test().validate(execution("return { count: 2, states: ['active'] };"))).toMatchObject({
      passed: false,
      reason: "Expected a successful eval inspecting the managed credential store",
    });
  });

  it("rejects fabricated natural-language claims without canonical inspection evidence", () => {
    expect(test().validate(execution("return { count: 2, states: ['active'] };"))).toMatchObject({
      passed: false,
    });
  });

  it("rejects any credential-state mutation attempt", () => {
    expect(
      test().validate(
        execution(
          "const records = await credentials.inspectStoredCredentials(); await credentials.revokeCredential(records[0].id); return { count: records.length, states: [] };"
        )
      )
    ).toMatchObject({
      passed: false,
      reason: "Credential inspection probe attempted to mutate credential state",
    });
  });

  it("requires a bounded count and lifecycle-state result", () => {
    expect(
      test().validate(
        execution("return await credentials.inspectStoredCredentials();", [{ id: "credential:1" }])
      )
    ).toMatchObject({
      passed: false,
      reason: "Credential inspection eval returned no bounded count/lifecycle-state evidence",
    });
  });

  it("rejects extra record, identifier, or material fields in the returned value", () => {
    const code =
      "const records = await credentials.inspectStoredCredentials(); return { count: records.length, states: [], records, credentialId: records[0]?.id, material: 'redacted' };";

    expect(
      test().validate(
        execution(code, {
          count: 1,
          states: ["active"],
          records: [{ id: "credential:1" }],
          credentialId: "credential:1",
          material: "redacted",
        })
      )
    ).toMatchObject({
      passed: false,
      reason: "Credential inspection returned sensitive credential fields",
    });
  });

  it("accepts the public listing API when it returns bounded lifecycle evidence", () => {
    expect(
      test().validate(
        execution(
          "const records = await credentials.listStoredCredentials(); return { credentialCount: records.length, lifecycleStateValues: ['active'] };",
          { credentialCount: 2, lifecycleStateValues: ["active"] }
        )
      )
    ).toEqual({ passed: true });
  });

  it("accepts the dedicated bounded credential-store summary", () => {
    expect(
      test().validate(
        execution("return credentials.summarizeStoredCredentials();", {
          credentialCount: 2,
          lifecycleStates: ["active"],
          stateCounts: { active: 2 },
        })
      )
    ).toEqual({ passed: true });
  });

  it("accepts a bounded aggregate computed through the documented raw RPC spelling", () => {
    expect(
      test().validate(
        execution(
          `const records = await rpc.call("main", "credentials.listStoredCredentials", []);
           return {
             total: records.length,
             lifecycleStates: [...new Set(records.map((record) => record.lifecycle.state))],
             countsByState: { active: records.length },
           };`,
          {
            total: 2,
            lifecycleStates: ["active"],
            countsByState: { active: 2 },
          }
        )
      )
    ).toEqual({ passed: true });
  });

  it("accepts the dedicated summary through the documented raw RPC spelling", () => {
    expect(
      test().validate(
        execution(
          `return rpc.call("main", "credentials.summarizeStoredCredentials", []);`,
          {
            credentialCount: 2,
            lifecycleStates: ["active"],
            stateCounts: { active: 2 },
          }
        )
      )
    ).toEqual({ passed: true });
  });
});
