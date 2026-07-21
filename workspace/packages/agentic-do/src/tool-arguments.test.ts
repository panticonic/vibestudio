import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@workspace/pi-core";
import { prepareAgentToolArguments } from "./tool-arguments.js";

function tool(prepareArguments?: (raw: unknown) => { operation: "status" }): AgentTool {
  return {
    name: "vcs",
    label: "vcs",
    parameters: Type.Object({ operation: Type.Literal("status") }, { additionalProperties: false }),
    ...(prepareArguments ? { prepareArguments } : {}),
    execute: vi.fn(),
  } as unknown as AgentTool;
}

describe("prepareAgentToolArguments", () => {
  it("returns arguments that satisfy the advertised schema", () => {
    const input = { operation: "status" };
    expect(prepareAgentToolArguments(tool(), input)).toBe(input);
  });

  it("rejects malformed model arguments before tool execution", () => {
    expect(() =>
      prepareAgentToolArguments(tool(), { operation: "listFiles", sourceEventId: "event:1" })
    ).toThrow(/Invalid arguments for tool vcs/u);
  });

  it("names the allowed operations when a union discriminator is unknown", () => {
    const parameters = Type.Union([
      Type.Object({ operation: Type.Literal("status") }),
      Type.Object({ operation: Type.Literal("push") }),
    ]);
    const selected = { ...tool(), parameters } as AgentTool;
    expect(() => prepareAgentToolArguments(selected, { operation: "commit" })).toThrow(
      '/operation: Expected one of "status", "push"; received "commit"'
    );
  });

  it("reports the selected operation and nested decision branch", () => {
    const parameters = Type.Union([
      Type.Object({ operation: Type.Literal("status") }),
      Type.Object({
        operation: Type.Literal("integrate"),
        decision: Type.Union([
          Type.Object({
            kind: Type.Literal("adopted"),
            sourceChangeIds: Type.Array(Type.String()),
          }),
          Type.Object({
            kind: Type.Literal("reconciled"),
            sourceChangeIds: Type.Array(Type.String()),
            evidence: Type.Array(Type.String()),
          }),
        ]),
      }),
    ]);
    const selected = { ...tool(), parameters } as AgentTool;
    expect(() =>
      prepareAgentToolArguments(selected, {
        operation: "integrate",
        decision: { kind: "reconciled", sourceChangeIds: ["change:1"] },
      })
    ).toThrow("/decision/evidence: Expected required property");
  });

  it("applies compatibility preparation before validation", () => {
    const prepare = vi.fn(() => ({ operation: "status" as const }));
    expect(prepareAgentToolArguments(tool(prepare), { op: "status" })).toEqual({
      operation: "status",
    });
    expect(prepare).toHaveBeenCalledWith({ op: "status" });
  });

  it("leaves plain JSON-schema tools to their own executor validation", () => {
    const plain = {
      ...tool(),
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    } as unknown as AgentTool;
    expect(prepareAgentToolArguments(plain, { query: "history" })).toEqual({ query: "history" });
  });
});
