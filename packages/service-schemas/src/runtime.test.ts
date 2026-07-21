import { describe, expect, it } from "vitest";
import { RuntimeEntityHandleSchema } from "./runtime.js";

describe("RuntimeEntityHandleSchema", () => {
  it("preserves the execution authority selected by runtime.createEntity", () => {
    const handle = {
      id: "panel:history-entry",
      kind: "panel" as const,
      source: { repoPath: "about/new", effectiveVersion: "ev-about" },
      executionDigest: "a".repeat(64),
      authorityRequests: [
        {
          capability: "service:app.getInfo",
          resource: { kind: "prefix" as const, prefix: "" },
        },
      ],
      authorityDelegations: [
        {
          audience: "eval" as const,
          purpose: "agentic-code-execution" as const,
          capabilities: [
            {
              capability: "service:docs.listServices",
              resource: { kind: "prefix" as const, prefix: "" },
            },
          ],
        },
      ],
      contextId: "ctx-panel",
      targetId: "panel:history-entry",
    };

    expect(RuntimeEntityHandleSchema.parse(handle)).toEqual(handle);
  });
});
