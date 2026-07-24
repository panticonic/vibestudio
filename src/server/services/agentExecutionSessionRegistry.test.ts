import { describe, expect, it, vi } from "vitest";
import { AgentExecutionSessionRegistry } from "./agentExecutionSessionRegistry.js";

function admission(runtimeId = "runtime:eval:one", runId = "run:one") {
  return {
    mode: "interactive" as const,
    ownerUser: "user:alice" as const,
    workspaceId: "workspace:one",
    contextId: "context:one",
    agentBinding: {
      entityId: "agent:news",
      channelId: "channel:one",
      bindingId: "binding:news",
    },
    taskRef: "task:one",
    harness: {
      principal: `code:workers/system-agent@${"a".repeat(64)}` as const,
      repoPath: "workers/system-agent",
      effectiveVersion: "ev:one",
    },
    eval: { runtimeId, runId },
    causalParent: { logId: "log:one", head: "head:one", invocationId: "invocation:one" },
  };
}

describe("AgentExecutionSessionRegistry test policy", () => {
  it("mints policies only for canonical system-test runs and inherits by context", () => {
    const registry = new AgentExecutionSessionRegistry();
    expect(() => registry.createTestPolicy("ordinary-agent:run")).toThrow(
      /canonical system-test run/
    );
    const policy = registry.createTestPolicy("system-test-runner:run-42");
    expect(policy).toEqual({
      policyId: "test:run-42",
      kind: "orchestrator",
    });
    registry.markTestContext("ctx:parent", policy);
    registry.inheritTestContext("ctx:child", "ctx:parent");
    expect(registry.testPolicyForContext("ctx:child")).toBe(policy);
  });

  it("rejects policy crossover and releases every adopted context when the run ends", () => {
    const registry = new AgentExecutionSessionRegistry();
    const policy = registry.createTestPolicy("system-test-runner:run-42");
    const first = registry.admit({
      ...admission("runtime:eval:one", "system-test-runner:run-42"),
      mode: "test",
      contextId: "ctx:runner",
      testPolicy: policy,
    });
    const second = registry.admit({
      ...admission("runtime:eval:two", "system-test-runner:child-42"),
      mode: "test",
      contextId: "ctx:child",
      testPolicy: policy,
    });
    registry.markTestContext("ctx:durable-receiver", policy);

    expect(() =>
      registry.markTestContext("ctx:durable-receiver", {
        policyId: "test:another-run",
        kind: "orchestrator",
      })
    ).toThrow(/already belongs to test policy/);

    expect(registry.close(second.eval.runtimeId, second.eval.runId)).toBe(true);
    expect(registry.testPolicyForContext("ctx:durable-receiver")).toBe(policy);
    expect(registry.close(first.eval.runtimeId, first.eval.runId)).toBe(true);
    expect(registry.testPolicyForContext("ctx:runner")).toBeNull();
    expect(registry.testPolicyForContext("ctx:child")).toBeNull();
    expect(registry.testPolicyForContext("ctx:durable-receiver")).toBeNull();
  });

  it("derives one exact case policy only from a live orchestrator context", () => {
    const registry = new AgentExecutionSessionRegistry();
    const orchestrator = registry.createTestPolicy("system-test-runner:run-42");
    registry.markTestContext("ctx:orchestrator", orchestrator);
    registry.inheritTestContext("ctx:case", "ctx:orchestrator");
    registry.attachCasePolicy("ctx:case", "ctx:orchestrator", {
      testId: "approval-roundtrip",
      authority: [
        {
          ruleId: "read",
          capability: "approvals.read",
          resource: { kind: "exact", key: "approvals.read" },
          tier: "gated",
          decision: "once",
        },
      ],
      userland: [
        {
          ruleId: "choice",
          subjectId: "system-test:harmless-resource",
          decision: "allow",
          remember: true,
        },
      ],
      unexpectedPrompts: "fail",
    });

    expect(registry.testPolicyForContext("ctx:case")).toMatchObject({
      kind: "case",
      orchestratorPolicyId: orchestrator.policyId,
      case: { testId: "approval-roundtrip" },
    });
    const casePolicy = registry.testPolicyForContext("ctx:case");
    expect(casePolicy?.kind).toBe("case");
    registry.markTestContext("ctx:case", orchestrator);
    expect(registry.testPolicyForContext("ctx:case")).toBe(casePolicy);
    expect(() =>
      registry.attachCasePolicy("ctx:case", "ctx:orchestrator", {
        testId: "approval-roundtrip",
        authority: [
          {
            ruleId: "read",
            capability: "approvals.read",
            resource: { kind: "exact", key: "approvals.read" },
            tier: "gated",
            decision: "once",
          },
        ],
        userland: [
          {
            ruleId: "choice",
            subjectId: "system-test:harmless-resource",
            decision: "allow",
            remember: true,
          },
        ],
        unexpectedPrompts: "fail",
      })
    ).not.toThrow();
    expect(() =>
      registry.attachCasePolicy("ctx:unowned", null, {
        testId: "bad",
        authority: [],
        userland: [],
        unexpectedPrompts: "fail",
      })
    ).toThrow(/orchestrator-owned/);
  });

  it("revokes descendant execution facts when the orchestrator run ends", () => {
    const registry = new AgentExecutionSessionRegistry();
    const orchestrator = registry.createTestPolicy("system-test-runner:run-42");
    const root = registry.admit({
      ...admission("runtime:eval:root", "system-test-runner:run-42"),
      mode: "test",
      contextId: "ctx:orchestrator",
      testPolicy: orchestrator,
    });
    registry.inheritTestContext("ctx:case", "ctx:orchestrator");
    registry.attachCasePolicy("ctx:case", "ctx:orchestrator", {
      testId: "approval-roundtrip",
      authority: [],
      userland: [],
      unexpectedPrompts: "fail",
    });
    const casePolicy = registry.testPolicyForContext("ctx:case");
    if (!casePolicy) throw new Error("Expected a case policy");
    const child = registry.admit({
      ...admission("runtime:eval:child", "system-test-runner:child-42"),
      mode: "test",
      contextId: "ctx:case",
      testPolicy: casePolicy,
    });

    expect(registry.close(root.eval.runtimeId, root.eval.runId)).toBe(true);
    expect(registry.resolve(child.eval.runtimeId)).toBeNull();
    expect(registry.testPolicyForContext("ctx:orchestrator")).toBeNull();
    expect(registry.testPolicyForContext("ctx:case")).toBeNull();
  });
});

describe("AgentExecutionSessionRegistry admission", () => {
  it("expires orphaned sessions, reuses exact run replays, and rejects a different live run", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const registry = new AgentExecutionSessionRegistry();
    const fact = registry.admit({ ...admission(), expiresAt: 2_000 });
    expect(registry.resolve(fact.eval.runtimeId, 1_999)).toBe(fact);
    expect(registry.admit(admission(fact.eval.runtimeId, fact.eval.runId))).toBe(fact);
    expect(() => registry.admit(admission(fact.eval.runtimeId, "run:replay"))).toThrow(
      /already admitted/
    );
    expect(registry.resolve(fact.eval.runtimeId, 2_000)).toBeNull();
    vi.restoreAllMocks();
  });

  it("requires the exact run to close a runtime and admits a fresh run afterward", () => {
    const registry = new AgentExecutionSessionRegistry();
    const first = registry.admit(admission());
    expect(registry.close(first.eval.runtimeId, "run:wrong-owner")).toBe(false);
    expect(registry.resolve(first.eval.runtimeId)).toBe(first);
    expect(registry.close(first.eval.runtimeId, first.eval.runId)).toBe(true);
    const second = registry.admit(admission(first.eval.runtimeId, "run:two"));
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.authoritySessionId).not.toBe(first.authoritySessionId);
  });

  it("queues concurrent runs in FIFO order until the prior admission closes", async () => {
    const registry = new AgentExecutionSessionRegistry();
    const first = registry.admit(admission());
    const order: string[] = [];
    const secondPromise = registry
      .admitWhenAvailable(admission(first.eval.runtimeId, "run:two"))
      .then((fact) => {
        order.push(fact.eval.runId);
        return fact;
      });
    const thirdPromise = registry
      .admitWhenAvailable(admission(first.eval.runtimeId, "run:three"))
      .then((fact) => {
        order.push(fact.eval.runId);
        return fact;
      });

    await Promise.resolve();
    expect(order).toEqual([]);
    expect(registry.close(first.eval.runtimeId, first.eval.runId)).toBe(true);
    const second = await secondPromise;
    expect(order).toEqual(["run:two"]);
    expect(registry.close(second.eval.runtimeId, second.eval.runId)).toBe(true);
    const third = await thirdPromise;
    expect(order).toEqual(["run:two", "run:three"]);
    expect(registry.close(third.eval.runtimeId, third.eval.runId)).toBe(true);
  });

  it("removes a cancelled admission wait without blocking the next run", async () => {
    const registry = new AgentExecutionSessionRegistry();
    const first = registry.admit(admission());
    const controller = new AbortController();
    const cancelled = registry.admitWhenAvailable(
      admission(first.eval.runtimeId, "run:cancelled"),
      controller.signal
    );
    const next = registry.admitWhenAvailable(admission(first.eval.runtimeId, "run:next"));

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    registry.close(first.eval.runtimeId, first.eval.runId);
    await expect(next).resolves.toMatchObject({ eval: { runId: "run:next" } });
  });

  it("rejects a same-run replay whose immutable admission facts changed", () => {
    const registry = new AgentExecutionSessionRegistry();
    const first = registry.admit(admission());
    expect(() =>
      registry.admit({
        ...admission(first.eval.runtimeId, first.eval.runId),
        contextId: "context:other",
      })
    ).toThrow(/different admission facts/);
  });

  it("keeps owner, binding, causal parent, and exact harness version in the immutable fact", () => {
    const registry = new AgentExecutionSessionRegistry();
    const fact = registry.admit(admission());
    expect(fact).toMatchObject({
      ownerUser: "user:alice",
      workspaceId: "workspace:one",
      contextId: "context:one",
      taskRef: "task:one",
      agentBinding: { bindingId: "binding:news", channelId: "channel:one" },
      causalParent: { invocationId: "invocation:one" },
      harness: {
        principal: `code:workers/system-agent@${"a".repeat(64)}`,
        effectiveVersion: "ev:one",
      },
    });
    expect(Object.isFrozen(fact)).toBe(true);
  });
});
