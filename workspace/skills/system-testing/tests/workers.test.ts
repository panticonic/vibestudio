import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { workerTests } from "./workers.js";

function execution(
  finalMessage: string,
  evalStatus?: "complete" | "error",
  code = "return true"
): TestExecutionResult {
  const messages: TestExecutionResult["messages"] = [
    {
      id: "prompt",
      kind: "message",
      senderId: "user",
      complete: true,
      content: "prompt",
    },
  ] as TestExecutionResult["messages"];
  if (evalStatus) {
    messages.push({
      id: "call-eval-message",
      kind: "message",
      senderId: "agent",
      complete: true,
      contentType: "invocation",
      content: "",
      invocation: {
        id: "call-eval",
        name: "eval",
        status: evalStatus,
        terminalOutcome: evalStatus === "complete" ? "success" : "tool_error",
        isError: evalStatus !== "complete",
        arguments: { code },
      },
    } as unknown as TestExecutionResult["messages"][number]);
  }
  messages.push({
    id: "final",
    kind: "message",
    senderId: "agent",
    complete: true,
    content: finalMessage,
  } as TestExecutionResult["messages"][number]);
  return { messages, duration: 0 };
}

function test(name: string) {
  const found = workerTests.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing worker test ${name}`);
  return found;
}

describe("worker test validators", () => {
  it("does not turn an explicit destruction mismatch into a passing test", () => {
    const result = test("create-destroy").validate(
      execution("WORKER_DESTROY_MISMATCH", "complete")
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("WORKER_DESTROY_OK was not verified");
  });

  it("does not turn an unobservable environment into a passing test", () => {
    const result = test("worker-env").validate(
      execution("WORKER_ENV_UNOBSERVABLE", "complete")
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("WORKER_ENV_OK was not verified");
  });

  it("requires successful tool evidence for positive lifecycle markers", () => {
    expect(test("create-destroy").validate(execution("WORKER_DESTROY_OK")).passed).toBe(false);
    expect(
      test("create-destroy").validate(execution("WORKER_DESTROY_OK", "error")).passed
    ).toBe(false);
    expect(test("create-destroy").validate(execution("WORKER_DESTROY_OK", "complete")).passed)
      .toBe(false);
    const verified = execution(
      "WORKER_DESTROY_OK",
      "complete",
      [
        'await rpc.call("main", "runtime.createEntity", [{}]);',
        'await rpc.call("main", "runtime.listEntities", [{ kind: "worker" }]);',
        'await rpc.call("main", "runtime.retireEntity", [{ id }]);',
      ].join("\n")
    );
    expect(test("create-destroy").validate(verified).passed).toBe(true);
  });

  it("requires worker-side observation before accepting WORKER_ENV_OK", () => {
    const acceptedOnly = execution(
      "WORKER_ENV_OK",
      "complete",
      [
        'const handle = await rpc.call("main", "runtime.createEntity", [{ env: { PROBE: "x" } }]);',
        'await rpc.call("main", "runtime.retireEntity", [{ id: handle.id }]);',
      ].join("\n")
    );
    expect(test("worker-env").validate(acceptedOnly)).toMatchObject({
      passed: false,
      reason: "Successful eval did not contain worker-side observation",
    });

    const observed = execution(
      "WORKER_ENV_OK",
      "complete",
      [
        'const handle = await rpc.call("main", "runtime.createEntity", [{ env: { PROBE: "x" } }]);',
        'await rpc.call(handle.targetId, "readNonSecretProbe", []);',
        'await rpc.call("main", "runtime.retireEntity", [{ id: handle.id }]);',
      ].join("\n")
    );
    expect(test("worker-env").validate(observed).passed).toBe(true);
  });
});
