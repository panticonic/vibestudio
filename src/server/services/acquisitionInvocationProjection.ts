import {
  authorityAcquisitionInvocationSchema,
  type AuthorityAcquisitionInvocation,
} from "@vibestudio/service-schemas/authority";
import { nativeInvocationId } from "@vibestudio/service-schemas/nativeInvocation";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { invocationSnapshotDigest } from "@vibestudio/shared/authority/invocationSnapshot";
import type { AuthorityAcquisitionRecord } from "./authorityAcquisitionStore.js";
import { restoreAcquisitionInputs } from "./acquisitionRequestStorage.js";

/** Keep the host's persistence format behind its authenticated receipt boundary. */
export function acquisitionInvocationProjection(
  record: AuthorityAcquisitionRecord
): AuthorityAcquisitionInvocation[] {
  const facts = record.admission.facts;
  if (
    !facts ||
    typeof facts !== "object" ||
    Array.isArray(facts) ||
    (facts["kind"] !== "invocation" && facts["kind"] !== "target-join") ||
    facts["inputs"] === undefined
  ) {
    throw new Error("Acquisition has no sealed invocation inputs");
  }
  const inputs = restoreAcquisitionInputs(facts["inputs"]);
  const invocations = inputs.map(({ caller, snapshot, snapshotDigest }) => {
    if (
      caller.runtime.id !== record.admission.ownerRuntimeId ||
      snapshot.sessionId !== record.admission.sessionId ||
      (caller.code && caller.code.callerId !== caller.runtime.id) ||
      invocationSnapshotDigest(snapshot) !== snapshotDigest ||
      (snapshot.nativeInvocation &&
        (!snapshot.causalParent ||
          nativeInvocationId(snapshot.nativeInvocation) !== snapshot.causalParent.invocationId))
    ) {
      throw new Error("Acquisition invocation disagrees with its sealed owner or snapshot");
    }
    return authorityAcquisitionInvocationSchema.parse({
      ownerRuntimeId: caller.runtime.id,
      sessionId: snapshot.sessionId,
      causalParent: snapshot.causalParent ?? null,
      nativeInvocation: snapshot.nativeInvocation ?? null,
      code: caller.code
        ? {
            repoPath: caller.code.repoPath,
            effectiveVersion: caller.code.effectiveVersion,
            executionDigest: caller.code.executionDigest ?? null,
          }
        : null,
      service: snapshot.service,
      method: snapshot.method,
      argsDigest: snapshot.argsDigest,
      preparedStateDigest: snapshot.preparedStateDigest,
      snapshotDigest,
      capability: snapshot.capability,
      resourceKey: snapshot.resourceKey,
    });
  });
  const first = invocations[0]!;
  if (
    invocations.some(
      (invocation) =>
        invocation.service !== first.service ||
        invocation.method !== first.method ||
        invocation.argsDigest !== first.argsDigest ||
        invocation.preparedStateDigest !== first.preparedStateDigest ||
        canonicalJson(invocation.causalParent) !== canonicalJson(first.causalParent) ||
        canonicalJson(invocation.nativeInvocation) !== canonicalJson(first.nativeInvocation) ||
        canonicalJson(invocation.code) !== canonicalJson(first.code)
    )
  ) {
    throw new Error("Acquisition facets do not belong to one exact invocation");
  }
  return invocations;
}
