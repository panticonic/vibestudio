import { createHash } from "node:crypto";
import type { InvocationSnapshot } from "@vibestudio/rpc";
import { canonicalJson } from "../canonicalJson.js";

const DOMAIN = "vibestudio:invocation-snapshot:v2\0";

export type InvocationSnapshotInput = Omit<InvocationSnapshot, "v" | "argsDigest" | "at"> & {
  args: readonly unknown[];
  at?: number;
};

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function createInvocationSnapshot(input: InvocationSnapshotInput): InvocationSnapshot {
  return {
    v: 2,
    service: input.service,
    method: input.method,
    capability: input.capability,
    capabilityDefinitionDigest: input.capabilityDefinitionDigest,
    resourceType: input.resourceType,
    provider: input.provider,
    providerExecutionDigest: input.providerExecutionDigest,
    ...(input.targetRequirement ? { targetRequirement: input.targetRequirement } : {}),
    ...(input.targetCapability ? { targetCapability: input.targetCapability } : {}),
    resourceKey: input.resourceKey,
    argsDigest: sha256Canonical(input.args),
    preparedStateDigest: input.preparedStateDigest,
    callerPrincipal: input.callerPrincipal,
    sessionId: input.sessionId,
    ...(input.taskRef ? { taskRef: input.taskRef } : {}),
    ...(input.taskAuthority ? { taskAuthority: input.taskAuthority } : {}),
    ...(input.agentBindingId ? { agentBindingId: input.agentBindingId } : {}),
    ...(input.agentName ? { agentName: input.agentName } : {}),
    ...(input.lineageClasses ? { lineageClasses: [...input.lineageClasses] } : {}),
    ...(input.irreversible ? { irreversible: true } : {}),
    ...(input.agentScopeEligible ? { agentScopeEligible: true } : {}),
    ...(input.executionMode ? { executionMode: input.executionMode } : {}),
    ...(input.testPolicyId ? { testPolicyId: input.testPolicyId } : {}),
    missionSubject: input.missionSubject,
    snippetDigest: input.snippetDigest,
    codeLineage: {
      class: input.codeLineage.class,
      chain: [...input.codeLineage.chain],
    },
    contextLineage: input.contextLineage
      ? { ...input.contextLineage, externalKeys: [...input.contextLineage.externalKeys] }
      : null,
    initiatorChain: [...input.initiatorChain],
    at: input.at ?? Date.now(),
  };
}

export function invocationSnapshotDigest(snapshot: InvocationSnapshot): string {
  const digestFields = {
    v: snapshot.v,
    service: snapshot.service,
    method: snapshot.method,
    capability: snapshot.capability,
    capabilityDefinitionDigest: snapshot.capabilityDefinitionDigest,
    resourceType: snapshot.resourceType,
    provider: snapshot.provider,
    providerExecutionDigest: snapshot.providerExecutionDigest,
    targetRequirement: snapshot.targetRequirement ?? null,
    targetCapability: snapshot.targetCapability ?? null,
    resourceKey: snapshot.resourceKey,
    argsDigest: snapshot.argsDigest,
    preparedStateDigest: snapshot.preparedStateDigest,
    taskRef: snapshot.taskRef ?? null,
    taskAuthority: snapshot.taskAuthority ?? null,
    agentBindingId: snapshot.agentBindingId ?? null,
    lineageClasses: snapshot.lineageClasses ?? [],
    irreversible: snapshot.irreversible ?? false,
    executionMode: snapshot.executionMode ?? null,
    testPolicyId: snapshot.testPolicyId ?? null,
    missionSubject: snapshot.missionSubject,
    snippetDigest: snapshot.snippetDigest,
    codeLineageClass: snapshot.codeLineage.class,
  };
  return createHash("sha256")
    .update(DOMAIN, "utf8")
    .update(canonicalJson(digestFields), "utf8")
    .digest("hex");
}
