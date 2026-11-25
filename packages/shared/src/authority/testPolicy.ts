export type {
  AgentExecutionTestAuthorityRule,
  AgentExecutionTestCapabilityScope,
  AgentExecutionTestAgentPolicy,
  AgentExecutionTestCasePolicy,
  AgentExecutionTestPolicy,
  AgentExecutionTestPolicySpec,
} from "@vibestudio/rpc";

import type { AgentExecutionTestPolicy } from "@vibestudio/rpc";
import { scopeCovers } from "../authorization.js";

/** One ordered resident-policy decision for both admission and acquisition. */
export function testPolicyDecision(policy: AgentExecutionTestPolicy | null | undefined, input: {
  capability: string; resourceKey: string; tier: "open" | "gated" | "critical"; irreversible?: boolean;
}): {ruleId: string; decision: "once" | "task" | "deny" | "queue"} | null {
  if (!policy || input.tier === "open") return null;
  if (policy.kind === "orchestrator") return input.tier === "gated" && input.irreversible !== true
    ? {ruleId:"orchestrator-gated",decision:"once"} : null;
  const rule = policy.case.authority.find(candidate => scopeCovers(candidate.capability,input.capability) &&
    candidate.tier === input.tier && scopeCovers(candidate.resource,input.resourceKey));
  return rule ? {ruleId:rule.ruleId,decision:rule.decision} : null;
}
