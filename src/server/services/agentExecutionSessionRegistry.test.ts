import { describe, expect, it, vi } from "vitest";
import { AgentExecutionSessionRegistry } from "./agentExecutionSessionRegistry.js";

function admission(
  runtimeId = "runtime:eval:one",
  runId = "run:one"
): Parameters<AgentExecutionSessionRegistry["admit"]>[0] {
  return {
    admissionKey: `${runtimeId}:${runId}`,
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
    taskAuthority: "task:one",
    executionImage: {
      principal: `code:workers/system-agent@ev:one` as const,
      repoPath: "workers/system-agent",
      ref: "state:one",
      effectiveVersion: "ev:one",
      executionDigest: "a".repeat(64),
    },
    executor: {
      kind: "eval",
      runtimeId,
      evalRunId: runId,
      authorityManifest: {
        mode: "adaptive",
        effects: "read-write",
        approvals: "prompt",
        requests: [],
        digest: "0".repeat(64),
      },
    },
    parent: null,
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
    registry.removeTestContext("ctx:child");
    expect(registry.testPolicyForContext("ctx:child")).toBeNull();
  });

  it("rejects policy crossover and retains adopted contexts between orchestrator cells", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const registry = new AgentExecutionSessionRegistry();
    const policy = registry.createTestPolicy("system-test-runner:run-42");
    const first = registry.admit({
      ...admission("runtime:eval:one", "system-test-runner:run-42"),
      expiresAt: 2_000,
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

    expect(registry.close(second.executor.runtimeId, second.executor.evalRunId)).toBe(true);
    expect(registry.testPolicyForContext("ctx:durable-receiver")).toBe(policy);
    expect(registry.close(first.executor.runtimeId, first.executor.evalRunId)).toBe(true);
    expect(registry.testPolicyForContext("ctx:runner")).toBe(policy);
    expect(registry.resolve(first.executor.runtimeId, 2_000)).toBeNull();
    expect(registry.testPolicyForContext("ctx:runner")).toBeNull();
    expect(registry.testPolicyForContext("ctx:child")).toBeNull();
    expect(registry.testPolicyForContext("ctx:durable-receiver")).toBeNull();
    vi.restoreAllMocks();
  });

  it("derives one exact case policy only from a live orchestrator context", () => {
    const registry = new AgentExecutionSessionRegistry();
    const orchestrator = registry.createTestPolicy("system-test-runner:run-42");
    registry.markTestContext("ctx:orchestrator", orchestrator);
    registry.inheritTestContext("ctx:case", "ctx:orchestrator");
    registry.attachCasePolicy("ctx:case", "ctx:orchestrator", {
      testId: "approval-roundtrip",
      agent: {
        model: "openai-codex:gpt-5.3-codex-spark",
        approvalLevel: 2,
        fallback: "disabled",
      },
      authority: [
        {
          ruleId: "read",
          capability: { kind: "exact", key: "approvals.read" },
          resource: { kind: "exact", key: "approvals.read" },
          tier: "gated",
          decision: "once",
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
        agent: {
          model: "openai-codex:gpt-5.3-codex-spark",
          approvalLevel: 2,
          fallback: "disabled",
        },
        authority: [
          {
            ruleId: "read",
            capability: { kind: "exact", key: "approvals.read" },
            resource: { kind: "exact", key: "approvals.read" },
            tier: "gated",
            decision: "once",
          },
        ],
        unexpectedPrompts: "fail",
      })
    ).not.toThrow();
    expect(() =>
      registry.attachCasePolicy("ctx:unowned", null, {
        testId: "bad",
        agent: {
          model: "openai-codex:gpt-5.3-codex-spark",
          approvalLevel: 2,
          fallback: "disabled",
        },
        authority: [],
        unexpectedPrompts: "fail",
      })
    ).toThrow(/orchestrator-owned/);
  });

  it("revokes descendant execution facts when the orchestrator history expires", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const registry = new AgentExecutionSessionRegistry();
    const orchestrator = registry.createTestPolicy("system-test-runner:run-42");
    const root = registry.admit({
      ...admission("runtime:eval:root", "system-test-runner:run-42"),
      expiresAt: 2_000,
      mode: "test",
      contextId: "ctx:orchestrator",
      testPolicy: orchestrator,
    });
    registry.inheritTestContext("ctx:case", "ctx:orchestrator");
    registry.attachCasePolicy("ctx:case", "ctx:orchestrator", {
      testId: "approval-roundtrip",
      agent: {
        model: "openai-codex:gpt-5.3-codex-spark",
        approvalLevel: 2,
        fallback: "disabled",
      },
      authority: [],
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

    expect(registry.close(root.executor.runtimeId, root.executor.evalRunId)).toBe(true);
    expect(registry.resolve(child.executor.runtimeId)).toBe(child);
    expect(registry.resolve(root.executor.runtimeId, 2_000)).toBeNull();
    expect(registry.resolve(child.executor.runtimeId)).toBeNull();
    expect(registry.testPolicyForContext("ctx:orchestrator")).toBeNull();
    expect(registry.testPolicyForContext("ctx:case")).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("AgentExecutionSessionRegistry admission", () => {
  it("expires orphaned sessions, reuses exact run replays, and rejects a different live run", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const registry = new AgentExecutionSessionRegistry();
    const fact = registry.admit({ ...admission(), expiresAt: 2_000 });
    expect(registry.resolve(fact.executor.runtimeId, 1_999)).toBe(fact);
    expect(registry.admit(admission(fact.executor.runtimeId, fact.executor.evalRunId))).toBe(fact);
    expect(() => registry.admit(admission(fact.executor.runtimeId, "run:replay"))).toThrow(
      /already admitted/
    );
    expect(registry.resolve(fact.executor.runtimeId, 2_000)).toBeNull();
    vi.restoreAllMocks();
  });

  it("requires the exact run to close a cell and preserves the notebook trust identity", () => {
    const registry = new AgentExecutionSessionRegistry();
    const first = registry.admit(admission());
    expect(registry.close(first.executor.runtimeId, "run:wrong-owner")).toBe(false);
    expect(registry.resolve(first.executor.runtimeId)).toBe(first);
    expect(registry.close(first.executor.runtimeId, first.executor.evalRunId)).toBe(true);
    expect(registry.resolve(first.executor.runtimeId)).toBe(first);
    expect(registry.resolveInvocation(first.executor.runtimeId, first.nonce)).toBeNull();
    const second = registry.admit(admission(first.executor.runtimeId, "run:two"));
    expect(second.nonce).toBe(first.nonce);
    expect(second.authoritySessionId).toBe(first.authoritySessionId);
    expect(second.authoritySessionVersion).toBe(first.authoritySessionVersion + 1);
    expect(registry.resolveInvocation(first.executor.runtimeId, first.nonce)).toBe(second);
  });

  it("names trust dimensions without exposing their values when a warm notebook drifts", () => {
    const registry = new AgentExecutionSessionRegistry();
    const first = registry.admit(admission());
    expect(registry.close(first.executor.runtimeId, first.executor.evalRunId)).toBe(true);

    expect(() =>
      registry.admit({
        ...admission(first.executor.runtimeId, "run:two"),
        contextId: "context:other",
        executionImage: {
          ...first.executionImage,
          effectiveVersion: "ev:other",
        },
      })
    ).toThrow(/changed: contextId, executionImage/);
  });

  it("resolves evaluated effects only with the exact live admission nonce", () => {
    const registry = new AgentExecutionSessionRegistry();
    const fact = registry.admit(admission());

    expect(registry.resolveInvocation(fact.executor.runtimeId, fact.nonce)).toBe(fact);
    expect(registry.resolveInvocation(fact.executor.runtimeId, "another-session-nonce")).toBeNull();
    expect(registry.resolveInvocation("runtime:eval:other", fact.nonce)).toBeNull();
  });

  it("queues concurrent runs in FIFO order until the prior admission closes", async () => {
    const registry = new AgentExecutionSessionRegistry();
    const first = registry.admit(admission());
    const order: string[] = [];
    const secondPromise = registry
      .admitWhenAvailable(admission(first.executor.runtimeId, "run:two"))
      .then((fact) => {
        order.push(fact.executor.evalRunId);
        return fact;
      });
    const thirdPromise = registry
      .admitWhenAvailable(admission(first.executor.runtimeId, "run:three"))
      .then((fact) => {
        order.push(fact.executor.evalRunId);
        return fact;
      });

    await Promise.resolve();
    expect(order).toEqual([]);
    expect(registry.close(first.executor.runtimeId, first.executor.evalRunId)).toBe(true);
    const second = await secondPromise;
    expect(order).toEqual(["run:two"]);
    expect(registry.close(second.executor.runtimeId, second.executor.evalRunId)).toBe(true);
    const third = await thirdPromise;
    expect(order).toEqual(["run:two", "run:three"]);
    expect(registry.close(third.executor.runtimeId, third.executor.evalRunId)).toBe(true);
  });

  it("removes a cancelled admission wait without blocking the next run", async () => {
    const registry = new AgentExecutionSessionRegistry();
    const first = registry.admit(admission());
    const controller = new AbortController();
    const cancelled = registry.admitWhenAvailable(
      admission(first.executor.runtimeId, "run:cancelled"),
      controller.signal
    );
    const next = registry.admitWhenAvailable(admission(first.executor.runtimeId, "run:next"));

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    registry.close(first.executor.runtimeId, first.executor.evalRunId);
    await expect(next).resolves.toMatchObject({
      executor: { kind: "eval", evalRunId: "run:next" },
    });
  });

  it("rejects a same-run replay whose immutable admission facts changed", () => {
    const registry = new AgentExecutionSessionRegistry();
    const first = registry.admit(admission());
    expect(() =>
      registry.admit({
        ...admission(first.executor.runtimeId, first.executor.evalRunId),
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
      executionImage: {
        principal: `code:workers/system-agent@ev:one`,
        effectiveVersion: "ev:one",
        executionDigest: "a".repeat(64),
      },
    });
    expect(Object.isFrozen(fact)).toBe(true);
  });

  it.each(["agent-turn", "method"] as const)(
    "admits and terminally closes a generic %s executor",
    (kind) => {
      const registry = new AgentExecutionSessionRegistry();
      const runtimeId = `do:workers/automation:${kind}:one`;
      const fact = registry.admitExecution({
        admissionKey: `mission:one:${kind}`,
        mode: "mission",
        ownerUser: "user:alice",
        workspaceId: "workspace:one",
        contextId: "context:one",
        agentBinding:
          kind === "agent-turn"
            ? { entityId: runtimeId, channelId: "channel:one", bindingId: "binding:one" }
            : null,
        taskRef: "run:one",
        taskAuthority: "task:run-one",
        executionImage: {
          principal: "code:workers/automation@one",
          repoPath: "workers/automation",
          ref: "state:one",
          effectiveVersion: "one",
          executionDigest: "a".repeat(64),
        },
        executor:
          kind === "agent-turn"
            ? {
                kind,
                runtimeId,
                entityId: runtimeId,
                channelId: "channel:one",
                turnId: "turn:one",
              }
            : {
                kind,
                runtimeId,
                invocationId: "invocation:one",
                service: "workers/automation",
                method: "run",
              },
        operationPolicyDigest: "b".repeat(64),
        mission: {
          subject: `mission:one@${"c".repeat(64)}`,
          missionId: "one",
          revision: 1,
          revisionDigest: "c".repeat(64),
        },
        parent: null,
        causalParent: null,
      });

      expect(registry.resolveInvocation(runtimeId, fact.nonce)).toBe(fact);
      expect(
        registry.admitExecution({
          admissionKey: fact.admissionKey,
          mode: fact.mode,
          ownerUser: fact.ownerUser,
          workspaceId: fact.workspaceId,
          contextId: fact.contextId,
          agentBinding: fact.agentBinding,
          taskRef: fact.taskRef,
          taskAuthority: fact.taskAuthority!,
          executionImage: fact.executionImage,
          executor: fact.executor,
          operationPolicyDigest: fact.operationPolicyDigest,
          mission: fact.mission,
          parent: fact.parent,
          causalParent: fact.causalParent,
        })
      ).toBe(fact);
      expect(registry.finishExecution(fact.authoritySessionId)).toBe(true);
      expect(registry.resolveInvocation(runtimeId, fact.nonce)).toBeNull();
      expect(registry.finishExecution(fact.authoritySessionId)).toBe(false);
    }
  );
});
