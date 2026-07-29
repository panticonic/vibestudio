import { describe, expect, it, vi } from "vitest";
import { STORED_VALUE_REF_PROTOCOL } from "@vibestudio/agentic-protocol";
import type { TestExecutionResult } from "./types.js";
import { materializeValidationEvidence } from "./validation-evidence.js";

describe("materializeValidationEvidence", () => {
  it("returns inline evidence without requiring a blob reader", async () => {
    const execution = { messages: [], duration: 1 } as TestExecutionResult;

    await expect(materializeValidationEvidence(execution)).resolves.toBe(execution);
  });

  it("hydrates referenced invocation evidence without mutating the durable execution", async () => {
    const result = {
      details: {
        provenance: {
          ranges: [
            { start: 0, end: 37, origin: "authored" },
            { start: 37, end: 82, origin: "import-boundary" },
          ],
        },
      },
    };
    const execution = {
      messages: [
        {
          id: "invocation-1",
          senderId: "agent-1",
          content: "",
          contentType: "invocation",
          kind: "system",
          complete: true,
          invocation: {
            id: "call-1",
            name: "read",
            arguments: {},
            execution: {
              status: "complete",
              description: "Read the file",
              result: {
                protocol: STORED_VALUE_REF_PROTOCOL,
                digest: "sha256-result",
                size: 123,
                encoding: "json",
                originalBytes: 123,
              },
            },
          },
        },
      ],
      duration: 1,
    } as TestExecutionResult;
    const getText = vi.fn(async (digest: string) =>
      digest === "sha256-result" ? JSON.stringify(result) : null
    );

    const validation = await materializeValidationEvidence(execution, { getText });

    expect(validation.messages[0]?.invocation?.execution.result).toEqual(result);
    expect(execution.messages[0]?.invocation?.execution.result).toMatchObject({
      protocol: STORED_VALUE_REF_PROTOCOL,
      digest: "sha256-result",
    });
    expect(getText).toHaveBeenCalledWith("sha256-result");
  });

  it("fails validation setup when canonical evidence is missing", async () => {
    const execution = {
      messages: [],
      duration: 1,
      snapshot: {
        invocations: [
          {
            result: {
              protocol: STORED_VALUE_REF_PROTOCOL,
              digest: "missing-result",
              size: 10,
              encoding: "json",
              originalBytes: 10,
            },
          },
        ],
      },
    } as unknown as TestExecutionResult;

    await expect(
      materializeValidationEvidence(execution, { getText: async () => null })
    ).rejects.toThrow(
      "system-test validation evidence stored value missing at $.snapshot.invocations[0].result"
    );
  });
});
