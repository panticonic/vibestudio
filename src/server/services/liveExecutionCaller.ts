import type { AgentExecutionSessionFact, AgentExecutionTestPolicy } from "@vibestudio/rpc";
import type { VerifiedCaller, VerifiedCodeIdentity } from "@vibestudio/shared/serviceDispatcher";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { codePrincipalMatches } from "@vibestudio/shared/authority/codePrincipal";

/**
 * Materialize the code identity of the host-admitted harness for one marked
 * evaluated effect. The transport runtime remains the concrete EvalDO, but the
 * code executing inside it is the exact harness sealed into the admission.
 */
export function executionHarnessCodeIdentity(input: {
  runtime: VerifiedCaller["runtime"];
  executionSession: AgentExecutionSessionFact;
  residentCode?: VerifiedCodeIdentity;
}): VerifiedCodeIdentity {
  const { runtime, executionSession, residentCode } = input;
  if (runtime.kind !== "do") {
    throw new Error(`Evaluated execution runtime must be a Durable Object, got ${runtime.kind}`);
  }
  if (!codePrincipalMatches(executionSession.harness.principal, executionSession.harness)) {
    throw new Error("Evaluated execution harness principal does not match its source identity");
  }
  const executionDigest = executionSession.harness.executionDigest;
  if (!executionDigest) {
    throw new Error("Evaluated execution harness has no execution digest");
  }
  // Sealed requests transfer only when the resident image is the very artifact
  // the harness fact names — same reviewed unit version and same build.
  const residentIsHarness = Boolean(
    residentCode?.executionDigest === executionDigest &&
    residentCode &&
    codePrincipalMatches(executionSession.harness.principal, residentCode)
  );
  return {
    callerId: runtime.id,
    callerKind: "do",
    repoPath: executionSession.harness.repoPath,
    effectiveVersion: executionSession.harness.effectiveVersion,
    executionDigest,
    requested: residentIsHarness ? (residentCode?.requested ?? []) : [],
    ...(residentCode?.evalOrigin ? { evalOrigin: residentCode.evalOrigin } : {}),
  };
}

/**
 * Select the most-specific compatible test policy. A case policy refines its
 * orchestrator policy; unrelated policies are never composable.
 */
export function refineExecutionTestPolicy(
  first: AgentExecutionTestPolicy | null | undefined,
  second: AgentExecutionTestPolicy | null | undefined
): AgentExecutionTestPolicy | null {
  if (!first) return second ?? null;
  if (!second || first.policyId === second.policyId) return first;
  if (
    first.kind === "case" &&
    second.kind === "orchestrator" &&
    first.orchestratorPolicyId === second.policyId
  ) {
    return first;
  }
  if (
    second.kind === "case" &&
    first.kind === "orchestrator" &&
    second.orchestratorPolicyId === first.policyId
  ) {
    return second;
  }
  return null;
}

/**
 * Rehydrate the live execution facts for a long-lived attributed transport.
 *
 * Workerd's egress registration seals code identity when an image is bound,
 * while eval/session admission is intentionally shorter lived and may begin or
 * end without rebuilding that image. Resolving those facts per request keeps
 * direct egress on the same authority lineage as RPC instead of freezing the
 * caller at process-start time.
 */
export function resolveLiveExecutionCaller(input: {
  registered: VerifiedCaller;
  activeEntity: EntityRecord | null;
  executionSession: AgentExecutionSessionFact | null;
  contextTestPolicy: AgentExecutionTestPolicy | null;
  taskAuthority?: import("@vibestudio/rpc").TaskGrantPrincipal | null;
  /**
   * Re-evaluate exact-version approval at request time. Egress registrations
   * outlive individual calls, so this fact must not be frozen at registration.
   */
  isCodeApproved?: (code: VerifiedCodeIdentity) => boolean;
}): VerifiedCaller | null {
  const {
    registered,
    activeEntity,
    executionSession,
    contextTestPolicy,
    taskAuthority,
    isCodeApproved,
  } = input;
  const agentBinding = activeEntity?.agentBinding;

  if (
    executionSession &&
    (executionSession.eval.runtimeId !== registered.runtime.id ||
      executionSession.contextId !== activeEntity?.contextId ||
      executionSession.agentBinding?.entityId !== agentBinding?.entityId ||
      executionSession.agentBinding?.channelId !== agentBinding?.channelId)
  ) {
    return null;
  }

  const testPolicy = refineExecutionTestPolicy(executionSession?.testPolicy, contextTestPolicy);
  if (executionSession?.testPolicy && contextTestPolicy && !testPolicy) {
    return null;
  }

  const {
    agentBinding: _registeredAgentBinding,
    executionSession: _registeredExecutionSession,
    testPolicy: _registeredTestPolicy,
    code: registeredCode,
    codeApproved: registeredCodeApproved,
    ...stable
  } = registered;
  const code = executionSession
    ? executionHarnessCodeIdentity({
        runtime: registered.runtime,
        executionSession,
        ...(registeredCode ? { residentCode: registeredCode } : {}),
      })
    : registeredCode;
  const resolvedTaskAuthority = executionSession?.taskAuthority ?? taskAuthority;
  const resolved: VerifiedCaller = {
    ...stable,
    ...(code ? { code } : {}),
    ...(!executionSession && registeredCodeApproved ? { codeApproved: true } : {}),
    ...(agentBinding ? { agentBinding } : {}),
    ...(executionSession ? { executionSession } : {}),
    ...(testPolicy ? { testPolicy } : {}),
    ...(resolvedTaskAuthority ? { taskAuthority: resolvedTaskAuthority } : {}),
  };
  return resolved.code && (resolved.codeApproved || isCodeApproved?.(resolved.code))
    ? { ...resolved, codeApproved: true }
    : resolved;
}
