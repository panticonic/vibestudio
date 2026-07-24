import type { AgentExecutionSessionFact, AgentExecutionTestPolicy } from "@vibestudio/rpc";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";

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
}): VerifiedCaller | null {
  const { registered, activeEntity, executionSession, contextTestPolicy } = input;
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

  const testPolicy = refineExecutionTestPolicy(
    executionSession?.testPolicy,
    contextTestPolicy
  );
  if (executionSession?.testPolicy && contextTestPolicy && !testPolicy) {
    return null;
  }

  const {
    agentBinding: _registeredAgentBinding,
    executionSession: _registeredExecutionSession,
    testPolicy: _registeredTestPolicy,
    ...stable
  } = registered;
  return {
    ...stable,
    ...(agentBinding ? { agentBinding } : {}),
    ...(executionSession ? { executionSession } : {}),
    ...(testPolicy ? { testPolicy } : {}),
  };
}
