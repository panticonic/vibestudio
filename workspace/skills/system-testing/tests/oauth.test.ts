import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import { oauthTests } from "./oauth.js";

const URL = "https://system-test-missing.invalid/resource";

function credentialMissExecution(
  code: string,
  result: unknown = { missing: true }
): TestExecutionResult {
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
          "No stored credential is bound to that API audience. I checked quietly without opening an authorization prompt or exposing any secret.",
      },
    ],
  } as TestExecutionResult;
}

function test() {
  const found = oauthTests.find((candidate) => candidate.name === "resolve-credential-miss");
  if (!found) throw new Error("Missing resolve-credential-miss test");
  return found;
}

describe("OAuth system test validators", () => {
  it("proves the null credential-resolution contract without interactive authorization", () => {
    const result = credentialMissExecution(
      `const value = await credentials.resolveCredential({ url: "${URL}" }); return { missing: value === null };`
    );

    expect(test().validate(result)).toEqual({ passed: true });
  });

  it("rejects prose-only claims of a credential miss", () => {
    const result = credentialMissExecution("return { missing: true };");

    expect(test().validate(result)).toMatchObject({
      passed: false,
      reason: "Successful eval did not resolve the reserved missing credential audience",
    });
  });

  it("rejects credential or authorization UI attempts", () => {
    const result = credentialMissExecution(
      `const value = await credentials.resolveCredential({ url: "${URL}" }); await credentials.connect({}); return { missing: value === null };`
    );

    expect(test().validate(result)).toMatchObject({
      passed: false,
      reason: "Credential miss probe attempted interactive credential or authorization UI",
    });
  });

  it("rejects an eval that did not return a true miss observation", () => {
    const result = credentialMissExecution(
      `const value = await credentials.resolveCredential({ url: "${URL}" }); return { missing: value === null };`,
      { missing: false }
    );

    expect(test().validate(result)).toMatchObject({
      passed: false,
      reason: "Credential miss eval must return exactly { missing: true }",
    });
  });

  it("rejects extra credential metadata in the miss result", () => {
    const result = credentialMissExecution(
      `const value = await credentials.resolveCredential({ url: "${URL}" }); return { missing: value === null, credentialId: value?.id };`,
      { missing: true, credentialId: null }
    );

    expect(test().validate(result)).toMatchObject({
      passed: false,
      reason: "Credential miss eval must return exactly { missing: true }",
    });
  });
});
