import { describe, expect, it } from "vitest";
import { RuntimeEntityHandleSchema, runtimeMethods } from "./runtime.js";

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
          tier: "gated" as const,
          evidence: "intentional-broad" as const,
        },
      ],
      contextId: "ctx-panel",
      targetId: "panel:history-entry",
    };

    expect(RuntimeEntityHandleSchema.parse(handle)).toEqual(handle);
  });
});

describe("runtime context-boundary authority", () => {
  it("uses reviewed semantic capabilities as the primary authority leaves", () => {
    const capabilityFor = (method: keyof typeof runtimeMethods) => {
      const authority = runtimeMethods[method].authority;
      if (!authority || !("resource" in authority) || authority.resource.kind !== "literal") {
        throw new Error(`${String(method)} has no literal primary authority`);
      }
      return authority.resource.key;
    };

    expect(capabilityFor("createEntity")).toBe("context.boundary");
    expect(capabilityFor("retireEntity")).toBe("context.boundary");
    expect(capabilityFor("createContext")).toBe("context.boundary");
    expect(capabilityFor("destroyContext")).toBe("context.boundary");
    expect(capabilityFor("cloneContext")).toBe("context.clone");
    expect(capabilityFor("createSubagentContext")).toBe("subagents.create");
  });

  it("keeps exact vessel fault injection out of agent-facing discovery", () => {
    expect(runtimeMethods.faultAbortAgentVessel).toMatchObject({
      agentFacing: false,
      authority: { principals: ["code"] },
      tier: { tier: "open", session: "codeOnly" },
    });
    expect(
      runtimeMethods.faultAbortAgentVessel.args.parse([
        { targetId: "do:workers/agent-worker:AiChatWorker:agent-1" },
      ])
    ).toEqual([{ targetId: "do:workers/agent-worker:AiChatWorker:agent-1" }]);
  });
});
