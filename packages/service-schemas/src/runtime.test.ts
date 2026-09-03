import { describe, expect, it } from "vitest";
import {
  AgentExecutionTestPolicySpecSchema,
  RuntimeEntityHandleSchema,
  runtimeMethods,
} from "./runtime.js";

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
  it("binds lifecycle grants to the exact operation, runtime kind, and target", () => {
    expect(runtimeMethods["supervision.activate"].authority).toMatchObject({
      resource: {
        kind: "argument-fields",
        fields: ["kind", "releaseId"],
        prefix: "activate:",
      },
    });
    expect(runtimeMethods["supervision.retire"].authority).toMatchObject({
      resource: {
        kind: "argument-fields",
        fields: ["kind", "entityId"],
        prefix: "retire:",
      },
    });
  });

  it("requires explicit exact or prefix capability-name scopes in test policies", () => {
    const spec = {
      testId: "dynamic-service",
      agent: {
        model: "openai-codex:gpt-5.3-codex-spark",
        approvalLevel: 2,
        fallback: "disabled",
      },
      authority: [
        {
          ruleId: "fixture-service",
          capability: { kind: "prefix", prefix: "workspace-service:" },
          resource: { kind: "prefix", prefix: "do:workers/fixture:FixtureDO:" },
          tier: "gated",
          decision: "once",
        },
      ],
      unexpectedPrompts: "fail",
    };

    expect(AgentExecutionTestPolicySpecSchema.parse(spec)).toEqual(spec);
    expect(
      AgentExecutionTestPolicySpecSchema.parse({
        ...spec,
        authority: [{ ...spec.authority[0], decision: "task" }],
      }).authority[0]?.decision
    ).toBe("task");
    expect(() =>
      AgentExecutionTestPolicySpecSchema.parse({
        ...spec,
        initiatingUserId: "usr_masked-attribution",
      })
    ).toThrow();
    expect(() =>
      AgentExecutionTestPolicySpecSchema.parse({
        ...spec,
        authority: [{ ...spec.authority[0], capability: "workspace-service:*" }],
      })
    ).toThrow();
  });

  it("accepts the exact low-effort Luna usage-limit fallback policy", () => {
    const spec = {
      testId: "model-fallback",
      agent: {
        model: "openai-codex:gpt-5.3-codex-spark",
        approvalLevel: 2,
        fallback: {
          model: "openai-codex:gpt-5.6-luna",
          thinkingLevel: "low",
          on: ["usage_limit_terminal"],
          scope: "all-turns",
        },
      },
      authority: [],
      unexpectedPrompts: "fail",
    };

    expect(AgentExecutionTestPolicySpecSchema.parse(spec)).toEqual(spec);
  });

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
      tier: { tier: "open", session: "family" },
    });
    expect(
      runtimeMethods.faultAbortAgentVessel.args.parse([
        { targetId: "do:workers/agent-worker:AiChatWorker:agent-1" },
      ])
    ).toEqual([{ targetId: "do:workers/agent-worker:AiChatWorker:agent-1" }]);
  });
});
