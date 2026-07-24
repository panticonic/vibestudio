import { createHash, randomUUID } from "node:crypto";
import type { AgentExecutionSessionFact, AgentExecutionTestPolicySpec } from "@vibestudio/rpc";

/**
 * Live host admission for evaluated execution. Facts intentionally live only
 * in the host process: a restart invalidates every run instead of pretending
 * that a JavaScript continuation survived.
 */
export class AgentExecutionSessionRegistry {
  private readonly byRuntime = new Map<string, AgentExecutionSessionFact>();
  private readonly testPoliciesByContext = new Map<
    string,
    NonNullable<AgentExecutionSessionFact["testPolicy"]>
  >();
  private readonly orchestratorRuns = new Map<string, { runtimeId: string; runId: string }>();

  createTestPolicy(runId: string): NonNullable<AgentExecutionSessionFact["testPolicy"]> {
    if (!runId.startsWith("system-test-runner:")) {
      throw new Error("Test authority policy requires a canonical system-test run");
    }
    return Object.freeze({
      policyId: `test:${runId.slice("system-test-runner:".length)}`,
      kind: "orchestrator",
    });
  }

  attachCasePolicy(
    contextId: string,
    ownerContextId: string | null,
    spec: AgentExecutionTestPolicySpec
  ): void {
    if (!ownerContextId) {
      throw new Error("A test-case authority policy requires an orchestrator-owned context");
    }
    const orchestrator = this.testPoliciesByContext.get(ownerContextId);
    if (!orchestrator || orchestrator.kind !== "orchestrator") {
      throw new Error("Test-case authority policy requires a live system-test orchestrator");
    }
    const digest = createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 20);
    const policy = Object.freeze({
      policyId: `${orchestrator.policyId}:case:${encodeURIComponent(spec.testId)}:${digest}`,
      kind: "case" as const,
      orchestratorPolicyId: orchestrator.policyId,
      case: Object.freeze({
        testId: spec.testId,
        authority: Object.freeze(
          spec.authority.map((rule) =>
            Object.freeze({ ...rule, resource: Object.freeze({ ...rule.resource }) })
          )
        ),
        userland: Object.freeze(spec.userland.map((rule) => Object.freeze({ ...rule }))),
        unexpectedPrompts: spec.unexpectedPrompts,
      }),
    });
    const inherited = this.testPoliciesByContext.get(contextId);
    if (inherited?.policyId === policy.policyId) {
      return;
    }
    if (inherited && inherited.policyId !== orchestrator.policyId) {
      throw new Error(
        `Execution context ${contextId} already belongs to test policy ${inherited.policyId}`
      );
    }
    this.testPoliciesByContext.set(contextId, policy);
  }

  markTestContext(
    contextId: string,
    policy: NonNullable<AgentExecutionSessionFact["testPolicy"]>
  ): void {
    const existing = this.testPoliciesByContext.get(contextId);
    if (existing?.policyId === policy.policyId) {
      return;
    }
    if (
      existing?.kind === "case" &&
      policy.kind === "orchestrator" &&
      existing.orchestratorPolicyId === policy.policyId
    ) {
      return;
    }
    if (
      existing?.kind === "orchestrator" &&
      policy.kind === "case" &&
      policy.orchestratorPolicyId === existing.policyId
    ) {
      this.testPoliciesByContext.set(contextId, policy);
      return;
    }
    if (existing) {
      throw new Error(
        `Execution context ${contextId} already belongs to test policy ${existing.policyId}`
      );
    }
    this.testPoliciesByContext.set(contextId, policy);
  }

  inheritTestContext(childContextId: string, ownerContextId: string | null): void {
    if (!ownerContextId) return;
    const policy = this.testPoliciesByContext.get(ownerContextId);
    if (policy) this.testPoliciesByContext.set(childContextId, policy);
  }

  testPolicyForContext(
    contextId: string
  ): NonNullable<AgentExecutionSessionFact["testPolicy"]> | null {
    return this.testPoliciesByContext.get(contextId) ?? null;
  }

  admit(
    input: Omit<
      AgentExecutionSessionFact,
      "v" | "authoritySessionId" | "authoritySessionVersion" | "issuedAt" | "expiresAt" | "nonce"
    > & { expiresAt?: number }
  ): AgentExecutionSessionFact {
    const issuedAt = Date.now();
    const active = this.resolve(input.eval.runtimeId, issuedAt);
    if (active) {
      if (active.eval.runId === input.eval.runId) {
        if (!sameAdmission(active, input)) {
          throw new Error(
            `Evaluated run ${input.eval.runId} was replayed with different admission facts`
          );
        }
        return active;
      }
      throw new Error(
        `Evaluated runtime ${input.eval.runtimeId} is already admitted for run ${active.eval.runId}`
      );
    }
    const fact: AgentExecutionSessionFact = Object.freeze({
      v: 1,
      authoritySessionId: randomUUID(),
      authoritySessionVersion: 1,
      ...input,
      issuedAt,
      // This bounds orphaned async runs. Live held runs are removed on completion.
      expiresAt: input.expiresAt ?? issuedAt + 7 * 24 * 60 * 60 * 1_000,
      nonce: randomUUID(),
    });
    this.byRuntime.set(fact.eval.runtimeId, fact);
    if (fact.mode === "test" && fact.testPolicy) {
      const rootPolicyId = orchestratorPolicyId(fact.testPolicy);
      const root = this.orchestratorRuns.get(rootPolicyId);
      if (!root) {
        if (fact.testPolicy.kind !== "orchestrator") {
          this.byRuntime.delete(fact.eval.runtimeId);
          throw new Error("Test-case authority policy requires a live system-test orchestrator");
        }
        this.orchestratorRuns.set(rootPolicyId, {
          runtimeId: fact.eval.runtimeId,
          runId: fact.eval.runId,
        });
      }
      this.markTestContext(fact.contextId, fact.testPolicy);
    }
    return fact;
  }

  resolve(runtimeId: string, now = Date.now()): AgentExecutionSessionFact | null {
    const fact = this.byRuntime.get(runtimeId);
    if (!fact) return null;
    if (fact.expiresAt <= now) {
      this.remove(fact);
      return null;
    }
    if (fact.mode === "test" && fact.testPolicy) {
      const rootPolicyId = orchestratorPolicyId(fact.testPolicy);
      const root = this.orchestratorRuns.get(rootPolicyId);
      const rootFact = root ? this.byRuntime.get(root.runtimeId) : undefined;
      if (!root || !rootFact || rootFact.eval.runId !== root.runId || rootFact.expiresAt <= now) {
        this.revokeOrchestrator(rootPolicyId);
        return null;
      }
    }
    return fact;
  }

  close(runtimeId: string, runId?: string): boolean {
    const fact = this.byRuntime.get(runtimeId);
    if (!fact || (runId !== undefined && fact.eval.runId !== runId)) return false;
    this.remove(fact);
    return true;
  }

  clear(): void {
    this.byRuntime.clear();
    this.testPoliciesByContext.clear();
    this.orchestratorRuns.clear();
  }

  private remove(fact: AgentExecutionSessionFact): void {
    const policy = fact.testPolicy;
    if (fact.mode !== "test" || !policy) {
      this.byRuntime.delete(fact.eval.runtimeId);
      return;
    }
    const rootPolicyId = orchestratorPolicyId(policy);
    const root = this.orchestratorRuns.get(rootPolicyId);
    if (root?.runtimeId === fact.eval.runtimeId && root.runId === fact.eval.runId) {
      this.revokeOrchestrator(rootPolicyId);
      return;
    }
    this.byRuntime.delete(fact.eval.runtimeId);
  }

  private revokeOrchestrator(policyId: string): void {
    this.orchestratorRuns.delete(policyId);
    for (const [runtimeId, fact] of this.byRuntime) {
      if (
        fact.mode === "test" &&
        fact.testPolicy &&
        orchestratorPolicyId(fact.testPolicy) === policyId
      ) {
        this.byRuntime.delete(runtimeId);
      }
    }
    for (const [contextId, contextPolicy] of this.testPoliciesByContext) {
      if (
        contextPolicy.policyId === policyId ||
        (contextPolicy.kind === "case" && contextPolicy.orchestratorPolicyId === policyId)
      ) {
        this.testPoliciesByContext.delete(contextId);
      }
    }
  }
}

type AdmissionInput = Parameters<AgentExecutionSessionRegistry["admit"]>[0];

function sameAdmission(fact: AgentExecutionSessionFact, input: AdmissionInput): boolean {
  return (
    fact.mode === input.mode &&
    fact.ownerUser === input.ownerUser &&
    fact.workspaceId === input.workspaceId &&
    fact.contextId === input.contextId &&
    fact.taskRef === input.taskRef &&
    JSON.stringify(fact.agentBinding) === JSON.stringify(input.agentBinding) &&
    JSON.stringify(fact.harness) === JSON.stringify(input.harness) &&
    JSON.stringify(fact.eval) === JSON.stringify(input.eval) &&
    JSON.stringify(fact.causalParent) === JSON.stringify(input.causalParent) &&
    JSON.stringify(fact.mission ?? null) === JSON.stringify(input.mission ?? null) &&
    JSON.stringify(fact.testPolicy ?? null) === JSON.stringify(input.testPolicy ?? null)
  );
}

function orchestratorPolicyId(
  policy: NonNullable<AgentExecutionSessionFact["testPolicy"]>
): string {
  return policy.kind === "orchestrator" ? policy.policyId : policy.orchestratorPolicyId;
}
