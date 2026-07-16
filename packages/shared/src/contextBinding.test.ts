import { describe, expect, it } from "vitest";
import {
  CONTEXT_BINDING_PROTOCOL,
  contextBinding,
  encodeContextBinding,
  parseContextBinding,
} from "./contextBinding.js";

describe("context binding protocol", () => {
  it("encodes only durable workspace and context identities", () => {
    const binding = contextBinding({ workspaceId: "workspace-1", contextId: "context-1" });
    expect(binding).toEqual({
      protocol: CONTEXT_BINDING_PROTOCOL,
      workspaceId: "workspace-1",
      contextId: "context-1",
    });
    expect(JSON.parse(encodeContextBinding(binding))).toEqual(binding);
  });

  it.each([
    { workspaceId: "workspace-1", contextId: "context-1" },
    {
      protocol: CONTEXT_BINDING_PROTOCOL,
      workspaceId: "workspace-1",
      contextId: "context-1",
      serverUrl: "http://127.0.0.1:5000",
    },
    {
      protocol: "vibestudio.context-binding.v0",
      workspaceId: "workspace-1",
      contextId: "context-1",
    },
  ])("rejects non-current or expanded shapes", (value) => {
    expect(() => parseContextBinding(value)).toThrow(/context binding/u);
  });
});
