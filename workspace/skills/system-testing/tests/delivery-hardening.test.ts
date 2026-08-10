import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { deliveryHardeningTests } from "./delivery-hardening.js";

function agentMessage(content = "Completed successfully.") {
  return {
    id: crypto.randomUUID(),
    kind: "message",
    contentType: "text",
    content,
    complete: true,
    senderMetadata: { type: "agent", name: "Agent", handle: "agent" },
  } as never;
}

function invocation(name: string, id = `invocation:${name}`) {
  return {
    id,
    kind: "message",
    contentType: "invocation",
    complete: true,
    senderMetadata: { type: "agent", name: "Agent", handle: "agent" },
    invocation: {
      id,
      name,
      execution: { status: "complete", isError: false, result: { ok: true } },
    },
  } as never;
}

function execution(diagnostics: Record<string, unknown>, tool?: string): TestExecutionResult {
  return {
    messages: [...(tool ? [invocation(tool)] : []), agentMessage()],
    duration: 1,
    diagnostics,
  };
}

function test(name: string) {
  return deliveryHardeningTests.find((candidate) => candidate.name === name)!;
}

describe("delivery hardening scenario validators", () => {
  it("requires an injected first-subscription failure and a recovered ready surface", () => {
    const result = execution({
      firstConnectRecovery: {
        connectedAfterRecovery: true,
        faults: [{ method: "join", injected: true }],
      },
    });
    expect(test("delivery-first-connect-recovery").validate(result)).toEqual({ passed: true });
  });

  it("requires one provider execution after a transient claim failure", () => {
    const result = execution(
      {
        transientClaimRecovery: {
          executionCount: 1,
          faults: [{ method: "claimMethodCall", injected: true }],
        },
      },
      "delivery_probe"
    );
    expect(test("delivery-transient-claim-recovery").validate(result)).toEqual({ passed: true });
  });

  it("requires one terminal identity and one execution across the vessel abort", () => {
    const result = execution(
      { terminalAfterVesselRestart: { aborted: true, executionCount: 1 } },
      "delayed_delivery_probe"
    );
    expect(test("delivery-terminal-after-vessel-restart").validate(result)).toEqual({
      passed: true,
    });
  });

  it("rejects per-mailbox context copies after wake", () => {
    const passing = execution({
      contextStorageAfterWake: {
        aborted: true,
        before: {
          envelopeCount: 10,
          eventRows: 6,
          mailboxRows: 12,
          mailboxContextCopies: 0,
        },
        after: {
          envelopeCount: 14,
          eventRows: 9,
          mailboxRows: 18,
          mailboxContextCopies: 0,
        },
      },
    });
    expect(test("delivery-context-storage-after-wake").validate(passing)).toEqual({
      passed: true,
    });

    const copied = structuredClone(passing);
    (
      copied.diagnostics!["contextStorageAfterWake"] as {
        after: { mailboxContextCopies: number };
      }
    ).after.mailboxContextCopies = 1;
    expect(test("delivery-context-storage-after-wake").validate(copied).passed).toBe(false);
  });
});
