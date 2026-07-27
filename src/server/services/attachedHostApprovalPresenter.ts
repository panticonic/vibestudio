import type { AttachedHostApprovalChallenge } from "@vibestudio/service-schemas/attachedHosts";
import { describeCapability } from "@vibestudio/shared/authorityPresentation";
import { hostMethodCapability } from "@vibestudio/shared/authority/hostMethodCapabilities";
import { methodTier } from "@vibestudio/shared/authority/tierTable";
import type { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import type { ApprovalQueue } from "./approvalQueue.js";
import {
  AttachedHostEndpoint,
  type AttachedHostApprovalDecision,
  type AttachedHostCanonicalApprovalPresentation,
  resolveStaticAttachedHostApprovalPresentation,
} from "./attachedHostProtocol.js";

/**
 * Bridges a verified child challenge into the one canonical host approval
 * queue without minting any parent-side grant. The returned signed decision is
 * evidence only; the child must re-evaluate and mint its own exact once result.
 */
export class AttachedHostApprovalPresenter {
  constructor(
    private readonly deps: {
      endpoint: AttachedHostEndpoint;
      approvalQueue: Pick<ApprovalQueue, "request">;
    }
  ) {}

  async present(
    challenge: AttachedHostApprovalChallenge,
    signal?: AbortSignal
  ): Promise<AttachedHostApprovalDecision> {
    const { presentation, shownPresentationDigest } = this.deps.endpoint.verifyChallenge(challenge);
    const session = this.deps.endpoint.sessionRecord(challenge.sessionId);
    if (!session || session.state !== "active") {
      throw presenterError("EATTACHED_SESSION", "Attached-host approval session is not active");
    }
    const decision = await this.deps.approvalQueue.request({
      kind: "capability",
      callerId: session.transcript.initiatingRuntimeId,
      callerKind: "system",
      repoPath: "vibestudio/attached-host",
      effectiveVersion: session.transcript.childGenerationId,
      ...(session.transcript.initiatingUserId
        ? { requestedByUserId: session.transcript.initiatingUserId }
        : {}),
      requesterCategory: "eval",
      dedupKey: `attached:${challenge.sessionId}:${challenge.nonce}`,
      capability: presentation.capability,
      severity: presentation.tier === "critical" ? "severe" : "standard",
      title: presentation.title,
      description: presentation.description,
      resource: {
        type: "authority-resource",
        label: "Where",
        value: presentation.resourceKey,
      },
      grantResourceKey: presentation.resourceKey,
      resourceScope: { kind: "exact", key: presentation.resourceKey },
      operation: {
        kind: "runtime",
        verb: presentation.action,
        groupKey: `attached:${challenge.sessionId}:${challenge.nonce}`,
      },
      snapshot: challenge.invocationSnapshot,
      cardType: presentation.tier === "critical" ? "confirm.critical" : "permission.gated",
      allowedDecisions: ["once", "deny"],
      ...(signal ? { signal } : {}),
    });
    if (decision !== "once" && decision !== "deny") {
      throw presenterError(
        "EATTACHED_APPROVAL_CLOSED",
        "Attached-host approval closed without an authorization decision"
      );
    }
    return this.deps.endpoint.createDecision({
      challenge,
      shownPresentationDigest,
      decision,
      ttlMs: 30_000,
    });
  }
}

export function attachedApprovalView(
  endpoint: AttachedHostEndpoint,
  challenge: AttachedHostApprovalChallenge
): AttachedHostCanonicalApprovalPresentation {
  return endpoint.verifyChallenge(challenge).presentation;
}

/**
 * Resolve prompt substance from the parent's own live service catalog. Static
 * host methods use the reviewed census; dynamically registered services must
 * declare their capability and tier on the method schema.
 */
export function createAttachedHostApprovalResolver(
  dispatcher: Pick<ServiceDispatcher, "getMethodSchema">
): (challenge: AttachedHostApprovalChallenge) => AttachedHostCanonicalApprovalPresentation | null {
  return (challenge) => {
    const reviewed = resolveStaticAttachedHostApprovalPresentation(challenge);
    if (reviewed) return reviewed;
    const snapshot = challenge.invocationSnapshot;
    const schema = dispatcher.getMethodSchema(snapshot.service, snapshot.method);
    const qualified = `${snapshot.service}.${snapshot.method}`;
    const capability = schema?.capability ?? hostMethodCapability(qualified);
    const tier = schema?.tier?.tier ?? methodTier(qualified)?.tier;
    if (
      !schema ||
      capability !== challenge.capability ||
      tier !== challenge.tier ||
      (tier !== "gated" && tier !== "critical")
    ) {
      return null;
    }
    const metadata = describeCapability(capability);
    return {
      title: metadata.title,
      action: metadata.action,
      description: metadata.description,
      service: snapshot.service,
      method: snapshot.method,
      capability,
      resourceKey: challenge.resourceKey,
      tier,
      invocationSnapshotDigest: challenge.invocationSnapshotDigest,
      preparedOperationDigest: challenge.preparedOperationDigest,
    };
  };
}

function presenterError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
