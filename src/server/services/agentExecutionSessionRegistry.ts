import { createHash, randomUUID } from "node:crypto";
import type { ExecutionAdmissionFact, AgentExecutionTestPolicySpec } from "@vibestudio/rpc";

type AdmissionInput = Omit<
  ExecutionAdmissionFact,
  | "v"
  | "authoritySessionId"
  | "authoritySessionVersion"
  | "issuedAt"
  | "expiresAt"
  | "nonce"
  | "executor"
> & {
  executor: Extract<ExecutionAdmissionFact["executor"], { kind: "eval" }>;
  taskAuthority: import("@vibestudio/rpc").TaskGrantPrincipal;
  expiresAt?: number;
};
type EvalAdmissionFact = ExecutionAdmissionFact & {
  executor: Extract<ExecutionAdmissionFact["executor"], { kind: "eval" }>;
};

interface AdmissionWaiter {
  input: AdmissionInput;
  resolve: (fact: EvalAdmissionFact) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Live host admission for evaluated execution. Facts intentionally live only
 * in the host process: a restart invalidates every run instead of pretending
 * that a JavaScript continuation survived.
 */
export class AgentExecutionSessionRegistry {
  private readonly byRuntime = new Map<string, ExecutionAdmissionFact>();
  private readonly byAdmissionKey = new Map<string, ExecutionAdmissionFact>();
  private readonly byNonce = new Map<string, ExecutionAdmissionFact>();
  /** A notebook history keeps one authority identity across cells, while this
   * map records the single cell currently executing in that history. */
  private readonly activeRunByRuntime = new Map<string, string>();
  /** Previous committed history fact while a new cell is being prepared. */
  private readonly priorFactByActiveRuntime = new Map<string, ExecutionAdmissionFact | null>();
  private readonly testPoliciesByContext = new Map<
    string,
    NonNullable<ExecutionAdmissionFact["testPolicy"]>
  >();
  private readonly orchestratorRuns = new Map<string, { runtimeId: string; runId: string }>();
  private readonly admissionWaiters = new Map<string, AdmissionWaiter[]>();

  createTestPolicy(runId: string): NonNullable<ExecutionAdmissionFact["testPolicy"]> {
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
        agent: Object.freeze({
          ...spec.agent,
          ...(spec.agent.fallback === "disabled"
            ? {}
            : {
                fallback: Object.freeze({
                  ...spec.agent.fallback,
                  on: Object.freeze([...spec.agent.fallback.on]) as readonly [
                    "usage_limit_terminal",
                  ],
                }),
              }),
        }),
        authority: Object.freeze(
          spec.authority.map((rule) =>
            Object.freeze({ ...rule, resource: Object.freeze({ ...rule.resource }) })
          )
        ),
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
    policy: NonNullable<ExecutionAdmissionFact["testPolicy"]>
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

  removeTestContext(contextId: string): void {
    this.testPoliciesByContext.delete(contextId);
  }

  testPolicyForContext(
    contextId: string
  ): NonNullable<ExecutionAdmissionFact["testPolicy"]> | null {
    return this.testPoliciesByContext.get(contextId) ?? null;
  }

  admit(input: AdmissionInput): EvalAdmissionFact {
    const issuedAt = Date.now();
    const retained = this.resolve(input.executor.runtimeId, issuedAt);
    if (retained && retained.executor.kind !== "eval") {
      throw new Error(
        `Execution runtime ${input.executor.runtimeId} is already admitted by a non-eval executor`
      );
    }
    const activeRunId = this.activeRunByRuntime.get(input.executor.runtimeId);
    if (retained && activeRunId) {
      if (activeRunId === input.executor.evalRunId) {
        if (!sameAdmission(retained, input)) {
          throw new Error(
            `Evaluated run ${input.executor.evalRunId} was replayed with different admission facts`
          );
        }
        return retained as EvalAdmissionFact;
      }
      throw new Error(
        `Evaluated runtime ${input.executor.runtimeId} is already admitted for run ${activeRunId}`
      );
    }
    const trustDrift = retained ? trustUnitDrift(retained, input) : [];
    if (retained && trustDrift.length > 0) {
      throw new Error(
        `Evaluated runtime ${input.executor.runtimeId} was reused by a different notebook trust unit ` +
          `(changed: ${trustDrift.join(", ")})`
      );
    }
    const fact: EvalAdmissionFact = Object.freeze({
      v: 2,
      authoritySessionId: retained?.authoritySessionId ?? randomUUID(),
      authoritySessionVersion: (retained?.authoritySessionVersion ?? 0) + 1,
      ...input,
      issuedAt,
      // A warm EvalDO is a notebook history, not a sequence of unrelated
      // programs. Keep its trust identity for the same retention window as its
      // live heap; individual cell completion only releases the execution slot.
      expiresAt: input.expiresAt ?? issuedAt + 7 * 24 * 60 * 60 * 1_000,
      nonce: retained?.nonce ?? randomUUID(),
    });
    this.byRuntime.set(fact.executor.runtimeId, fact);
    this.byAdmissionKey.set(fact.admissionKey, fact);
    this.byNonce.set(fact.nonce, fact);
    this.priorFactByActiveRuntime.set(fact.executor.runtimeId, retained);
    this.activeRunByRuntime.set(fact.executor.runtimeId, fact.executor.evalRunId);
    if (fact.mode === "test" && fact.testPolicy) {
      const rootPolicyId = orchestratorPolicyId(fact.testPolicy);
      const root = this.orchestratorRuns.get(rootPolicyId);
      if (!root) {
        if (fact.testPolicy.kind !== "orchestrator") {
          this.byRuntime.delete(fact.executor.runtimeId);
          throw new Error("Test-case authority policy requires a live system-test orchestrator");
        }
        this.orchestratorRuns.set(rootPolicyId, {
          runtimeId: fact.executor.runtimeId,
          runId: fact.executor.evalRunId,
        });
      } else if (
        fact.testPolicy.kind === "orchestrator" &&
        root.runtimeId === fact.executor.runtimeId
      ) {
        root.runId = fact.executor.evalRunId;
      }
      this.markTestContext(fact.contextId, fact.testPolicy);
    }
    return fact;
  }

  admitExecution(
    input: Omit<
      ExecutionAdmissionFact,
      "v" | "authoritySessionId" | "authoritySessionVersion" | "issuedAt" | "expiresAt" | "nonce"
    > & { expiresAt?: number }
  ): ExecutionAdmissionFact {
    if (input.executor.kind === "eval") return this.admit(input as AdmissionInput);
    const existing = this.byAdmissionKey.get(input.admissionKey);
    if (existing) {
      if (existing.expiresAt <= Date.now()) this.removeGeneric(existing);
      else if (sameGenericAdmission(existing, input)) return existing;
      else
        throw new Error(
          `Execution admission ${input.admissionKey} was replayed with different facts`
        );
    }
    const issuedAt = Date.now();
    const fact: ExecutionAdmissionFact = Object.freeze({
      v: 2,
      authoritySessionId: randomUUID(),
      authoritySessionVersion: 1,
      ...input,
      issuedAt,
      expiresAt: input.expiresAt ?? issuedAt + 24 * 60 * 60 * 1_000,
      nonce: randomUUID(),
    });
    this.byAdmissionKey.set(fact.admissionKey, fact);
    this.byNonce.set(fact.nonce, fact);
    return fact;
  }

  finishExecution(authoritySessionId: string): boolean {
    const fact = [...this.byAdmissionKey.values()].find(
      (candidate) => candidate.authoritySessionId === authoritySessionId
    );
    if (!fact) return false;
    if (fact.executor.kind === "eval")
      return this.close(fact.executor.runtimeId, fact.executor.evalRunId);
    this.removeGeneric(fact);
    return true;
  }

  hasLiveMissionSubject(subject: `mission:${string}@${string}`, now = Date.now()): boolean {
    for (const fact of this.byAdmissionKey.values()) {
      if (fact.expiresAt > now && fact.mission?.subject === subject) return true;
    }
    return false;
  }

  /**
   * Acquire the one live admission for an EvalDO in FIFO order.
   *
   * EvalDO deliberately serializes runs because they share one persistent
   * scope. Admission mirrors that existing execution queue instead of rejecting
   * concurrent callers before they reach it. There is no invented wait
   * deadline: the inbound RPC's cancellation signal owns abandonment.
   */
  admitWhenAvailable(input: AdmissionInput, signal?: AbortSignal): Promise<EvalAdmissionFact> {
    const runtimeId = input.executor.runtimeId;
    const queued = this.admissionWaiters.get(runtimeId);
    const retained = this.resolve(runtimeId);
    const activeRunId = this.activeRunByRuntime.get(runtimeId);
    if ((!queued || queued.length === 0) && !activeRunId) {
      return Promise.resolve(this.admit(input));
    }
    if (retained && activeRunId === input.executor.evalRunId) {
      return Promise.resolve(this.admit(input));
    }
    if (signal?.aborted) return Promise.reject(admissionAbortError(runtimeId));

    return new Promise<EvalAdmissionFact>((resolve, reject) => {
      const waiter: AdmissionWaiter = { input, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const waiters = this.admissionWaiters.get(runtimeId);
          const index = waiters?.indexOf(waiter) ?? -1;
          if (index >= 0) waiters!.splice(index, 1);
          if (waiters?.length === 0) this.admissionWaiters.delete(runtimeId);
          reject(admissionAbortError(runtimeId));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      const waiters = queued ?? [];
      waiters.push(waiter);
      this.admissionWaiters.set(runtimeId, waiters);
      this.drainAdmissionWaiters(runtimeId);
    });
  }

  resolve(runtimeId: string, now = Date.now()): ExecutionAdmissionFact | null {
    const fact = this.byRuntime.get(runtimeId);
    if (!fact) return null;
    if (fact.expiresAt <= now) {
      this.remove(fact);
      this.drainAdmissionWaiters(runtimeId);
      return null;
    }
    if (fact.mode === "test" && fact.testPolicy) {
      const rootPolicyId = orchestratorPolicyId(fact.testPolicy);
      const root = this.orchestratorRuns.get(rootPolicyId);
      const rootFact = root ? this.byRuntime.get(root.runtimeId) : undefined;
      if (
        !root ||
        !rootFact ||
        rootFact.executor.kind !== "eval" ||
        rootFact.executor.evalRunId !== root.runId ||
        rootFact.expiresAt <= now
      ) {
        this.revokeOrchestrator(rootPolicyId);
        return null;
      }
    }
    return fact;
  }

  /**
   * Resolve the admission claimed by one outbound evaluated-execution effect.
   * Runtime identity alone is insufficient: the EvalDO also performs its own
   * lifecycle work while a run is admitted.
   */
  resolveInvocation(runtimeId: string, nonce: string): ExecutionAdmissionFact | null {
    const candidate = this.byNonce.get(nonce);
    if (candidate?.executor.kind === "eval") {
      const fact = this.resolve(runtimeId);
      return fact?.nonce === nonce &&
        fact.executor.kind === "eval" &&
        this.activeRunByRuntime.get(runtimeId) === fact.executor.evalRunId
        ? fact
        : null;
    }
    if (candidate) {
      if (candidate.expiresAt <= Date.now()) {
        this.removeGeneric(candidate);
        return null;
      }
      return candidate.executor.runtimeId === runtimeId ? candidate : null;
    }
    return null;
  }

  close(runtimeId: string, runId?: string): boolean {
    const fact = this.byRuntime.get(runtimeId);
    const activeRunId = this.activeRunByRuntime.get(runtimeId);
    if (!fact || !activeRunId || (runId !== undefined && activeRunId !== runId)) {
      return false;
    }
    this.activeRunByRuntime.delete(runtimeId);
    this.priorFactByActiveRuntime.delete(runtimeId);
    this.drainAdmissionWaiters(runtimeId);
    return true;
  }

  /**
   * Roll back a cell that failed before it was accepted by the notebook
   * kernel. Unlike close(), this does not commit its per-cell authority facts.
   */
  discard(runtimeId: string, runId: string): boolean {
    const activeRunId = this.activeRunByRuntime.get(runtimeId);
    if (activeRunId !== runId) return false;
    const prior = this.priorFactByActiveRuntime.get(runtimeId) ?? null;
    this.activeRunByRuntime.delete(runtimeId);
    this.priorFactByActiveRuntime.delete(runtimeId);
    if (prior) this.byRuntime.set(runtimeId, prior);
    else this.byRuntime.delete(runtimeId);
    this.drainAdmissionWaiters(runtimeId);
    return true;
  }

  clear(): void {
    this.byRuntime.clear();
    this.byAdmissionKey.clear();
    this.byNonce.clear();
    this.activeRunByRuntime.clear();
    this.priorFactByActiveRuntime.clear();
    this.testPoliciesByContext.clear();
    this.orchestratorRuns.clear();
    for (const [runtimeId, waiters] of this.admissionWaiters) {
      for (const waiter of waiters) {
        this.detachAdmissionWaiter(waiter);
        waiter.reject(new Error(`Admission registry cleared while waiting for ${runtimeId}`));
      }
    }
    this.admissionWaiters.clear();
  }

  private remove(fact: ExecutionAdmissionFact): void {
    this.byAdmissionKey.delete(fact.admissionKey);
    this.byNonce.delete(fact.nonce);
    if (fact.executor.kind !== "eval") {
      this.removeGeneric(fact);
      return;
    }
    this.activeRunByRuntime.delete(fact.executor.runtimeId);
    this.priorFactByActiveRuntime.delete(fact.executor.runtimeId);
    const policy = fact.testPolicy;
    if (fact.mode !== "test" || !policy) {
      this.byRuntime.delete(fact.executor.runtimeId);
      return;
    }
    const rootPolicyId = orchestratorPolicyId(policy);
    const root = this.orchestratorRuns.get(rootPolicyId);
    if (root?.runtimeId === fact.executor.runtimeId && root.runId === fact.executor.evalRunId) {
      this.revokeOrchestrator(rootPolicyId);
      return;
    }
    this.byRuntime.delete(fact.executor.runtimeId);
  }

  private removeGeneric(fact: ExecutionAdmissionFact): void {
    this.byAdmissionKey.delete(fact.admissionKey);
    this.byNonce.delete(fact.nonce);
  }

  private revokeOrchestrator(policyId: string): void {
    this.orchestratorRuns.delete(policyId);
    const removedRuntimeIds: string[] = [];
    for (const [runtimeId, fact] of this.byRuntime) {
      if (
        fact.mode === "test" &&
        fact.testPolicy &&
        orchestratorPolicyId(fact.testPolicy) === policyId
      ) {
        this.byRuntime.delete(runtimeId);
        this.activeRunByRuntime.delete(runtimeId);
        this.priorFactByActiveRuntime.delete(runtimeId);
        removedRuntimeIds.push(runtimeId);
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
    for (const runtimeId of removedRuntimeIds) this.drainAdmissionWaiters(runtimeId);
  }

  private drainAdmissionWaiters(runtimeId: string): void {
    if (this.activeRunByRuntime.has(runtimeId)) return;
    const waiters = this.admissionWaiters.get(runtimeId);
    if (!waiters) return;
    for (;;) {
      const waiter = waiters.shift();
      if (!waiter) {
        this.admissionWaiters.delete(runtimeId);
        return;
      }
      this.detachAdmissionWaiter(waiter);
      if (waiter.signal?.aborted) {
        waiter.reject(admissionAbortError(runtimeId));
        continue;
      }
      try {
        const fact = this.admit(waiter.input);
        if (waiters.length === 0) this.admissionWaiters.delete(runtimeId);
        waiter.resolve(fact);
      } catch (error) {
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      return;
    }
  }

  private detachAdmissionWaiter(waiter: AdmissionWaiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }
}

function sameAdmission(fact: ExecutionAdmissionFact, input: AdmissionInput): boolean {
  if (fact.executor.kind !== "eval") return false;
  const { eventSinkNonce: _factSink, ...factEval } = fact.executor;
  const { eventSinkNonce: _inputSink, ...inputEval } = input.executor;
  return (
    fact.mode === input.mode &&
    fact.ownerUser === input.ownerUser &&
    fact.workspaceId === input.workspaceId &&
    fact.contextId === input.contextId &&
    fact.taskRef === input.taskRef &&
    fact.taskAuthority === input.taskAuthority &&
    JSON.stringify(fact.agentBinding) === JSON.stringify(input.agentBinding) &&
    JSON.stringify(fact.executionImage) === JSON.stringify(input.executionImage) &&
    JSON.stringify(factEval) === JSON.stringify(inputEval) &&
    JSON.stringify(fact.attachedHost ?? null) === JSON.stringify(input.attachedHost ?? null) &&
    JSON.stringify(fact.causalParent) === JSON.stringify(input.causalParent) &&
    JSON.stringify(fact.parent) === JSON.stringify(input.parent) &&
    JSON.stringify(fact.mission ?? null) === JSON.stringify(input.mission ?? null) &&
    fact.operationPolicyDigest === input.operationPolicyDigest &&
    JSON.stringify(fact.testPolicy ?? null) === JSON.stringify(input.testPolicy ?? null)
  );
}

function sameGenericAdmission(
  fact: ExecutionAdmissionFact,
  input: Omit<
    ExecutionAdmissionFact,
    "v" | "authoritySessionId" | "authoritySessionVersion" | "issuedAt" | "expiresAt" | "nonce"
  > & { expiresAt?: number }
): boolean {
  return (
    fact.admissionKey === input.admissionKey &&
    fact.mode === input.mode &&
    fact.ownerUser === input.ownerUser &&
    fact.workspaceId === input.workspaceId &&
    fact.contextId === input.contextId &&
    fact.taskRef === input.taskRef &&
    JSON.stringify(fact.mission ?? null) === JSON.stringify(input.mission ?? null) &&
    JSON.stringify(fact.executionImage) === JSON.stringify(input.executionImage) &&
    JSON.stringify(fact.executor) === JSON.stringify(input.executor) &&
    fact.operationPolicyDigest === input.operationPolicyDigest
  );
}

/**
 * Identity that owns one warm EvalDO notebook heap. Cell-local provenance
 * (run id, task ref, causal parent, manifest and event sink) deliberately does
 * not participate: those facts advance on every cell without changing who
 * owns the surviving modules and objects.
 */
function trustUnitDrift(fact: ExecutionAdmissionFact, input: AdmissionInput): string[] {
  const drift: string[] = [];
  const changed = (name: string, left: unknown, right: unknown): void => {
    if (JSON.stringify(left) !== JSON.stringify(right)) drift.push(name);
  };
  changed("mode", fact.mode, input.mode);
  changed("ownerUser", fact.ownerUser, input.ownerUser);
  changed("workspaceId", fact.workspaceId, input.workspaceId);
  changed("contextId", fact.contextId, input.contextId);
  changed("agentBinding", fact.agentBinding, input.agentBinding);
  changed("executionImage", fact.executionImage, input.executionImage);
  changed("attachedHost", fact.attachedHost ?? null, input.attachedHost ?? null);
  changed("mission", fact.mission ?? null, input.mission ?? null);
  changed("operationPolicyDigest", fact.operationPolicyDigest, input.operationPolicyDigest);
  changed("testPolicy", fact.testPolicy ?? null, input.testPolicy ?? null);
  return drift;
}

function admissionAbortError(runtimeId: string): Error {
  const error = new Error(`Admission wait cancelled for ${runtimeId}`);
  error.name = "AbortError";
  return error;
}

function orchestratorPolicyId(policy: NonNullable<ExecutionAdmissionFact["testPolicy"]>): string {
  return policy.kind === "orchestrator" ? policy.policyId : policy.orchestratorPolicyId;
}
