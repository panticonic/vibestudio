import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { skillTests } from "./skills.js";

const code = `
try {
  await credentials.fetch(
    "https://system-test-missing.invalid/resource",
    undefined,
    { credentialId: "credential:system-test-missing" }
  );
  return { missing: false };
} catch (error) {
  return { missing: String(error).includes("credential-unavailable") };
}
`;

function execution(
  evalCode: string,
  returnValue: unknown = { missing: true },
  finalMessage = "The API request could not authenticate because the reserved credential is unavailable. I did not inspect or expose any secret or open an authorization prompt."
): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      { id: "prompt", kind: "message", senderId: "user", complete: true, content: "prompt" },
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
          arguments: { code: evalCode },
          result: { details: { success: true, returnValue } },
        },
      } as unknown as TestExecutionResult["messages"][number],
      { id: "final", kind: "message", senderId: "agent", complete: true, content: finalMessage },
    ],
  } as TestExecutionResult;
}

const apiTest = skillTests.find((test) => test.name === "load-api-integrations")!;

describe("API integrations skill system-test validator", () => {
  it("accepts one bounded host-mediated missing-credential observation", () => {
    expect(apiTest.validate(execution(code))).toEqual({ passed: true });
  });

  it("rejects marker-only missing-credential claims", () => {
    expect(apiTest.validate(execution("return { missing: true };"))).toMatchObject({
      passed: false,
      reason: "Expected one successful host-mediated fetch with the reserved missing credential",
    });
  });

  it("rejects credential inspection alongside the API attempt", () => {
    expect(
      apiTest.validate(execution(`${code}\nawait credentials.listStoredCredentials();`))
    ).toMatchObject({
      passed: false,
      reason: "Missing-credential API probe inspected, mutated, or requested credential state",
    });
  });

  it("rejects raw or extra credential observations", () => {
    expect(
      apiTest.validate(execution(code, { missing: true, error: "credential-unavailable" }))
    ).toMatchObject({
      passed: false,
      reason: "Missing-credential API eval must return exactly { missing: true }",
    });
  });
});
