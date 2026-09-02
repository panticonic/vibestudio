import { randomUUID } from "node:crypto";
import type {
  AcquisitionInfo,
  AttachedHostExecutionFact,
  InvocationSnapshot,
  ResourceScope,
} from "@vibestudio/rpc";
import type {
  AuthorityChallengePresentation,
  VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import {
  AttachedHostEndpoint,
  type AttachedHostApprovalChallenge,
  type AttachedHostApprovalDecision,
} from "./attachedHostProtocol.js";

export interface AttachedHostAcquisitionInput {
  snapshot: InvocationSnapshot;
  snapshotDigest: string;
  tier: "gated" | "critical";
  caller: VerifiedCaller;
  renderedAction: string;
  resource: ResourceScope;
  presentation?: AuthorityChallengePresentation;
  attachedHost?: AttachedHostExecutionFact;
}

/**
 * Child-side adapter for the canonical dispatcher acquisition seam. It never
 * invents prompt copy and never treats the route as a grant. The original
 * dispatch remains suspended while the signed typed snapshot is presented by
 * the parent; only a verified decision can mint the child-local exact grant
 * that lets the same dispatch continue.
 */
export class AttachedHostAuthorityBridge {
  constructor(
    private readonly deps: {
      endpoint: AttachedHostEndpoint;
      decisionConsumer: AttachedHostDecisionConsumer;
      present: (
        challenge: AttachedHostApprovalChallenge,
        signal?: AbortSignal
      ) => Promise<AttachedHostApprovalDecision>;
    }
  ) {}

  request(input: AttachedHostAcquisitionInput): AcquisitionInfo {
    if (!input.attachedHost) {
      throw bridgeError(
        "EATTACHED_CONTEXT",
        "Attached-host acquisition is missing verified route provenance"
      );
    }
    throw bridgeError(
      "EATTACHED_ACQUISITION_MODE",
      "Attached-host authority acquisition requires the live wait-capable route"
    );
  }

  async acquire(
    input: AttachedHostAcquisitionInput,
    signal?: AbortSignal
  ): Promise<{
    state: "decided";
    decision: "once" | "deny";
  }> {
    if (!input.attachedHost) {
      throw bridgeError(
        "EATTACHED_CONTEXT",
        "Attached-host acquisition is missing verified route provenance"
      );
    }
    const decision = await this.deps.present(this.challenge(input), signal);
    return {
      state: "decided",
      decision: this.deps.decisionConsumer.consume(decision),
    };
  }

  private challenge(input: AttachedHostAcquisitionInput): AttachedHostApprovalChallenge {
    const attached = input.attachedHost!;
    if (
      attached.sessionId === "" ||
      attached.authorityCeilingDigest === "" ||
      input.snapshotDigest === ""
    ) {
      throw bridgeError("EATTACHED_CONTEXT", "Attached-host acquisition binding is incomplete");
    }
    return this.deps.endpoint.prepareApproval({
      sessionId: attached.sessionId,
      nonce: randomUUID(),
      requestId: attached.requestId,
      invocationSnapshot: input.snapshot,
      capability: input.snapshot.capability,
      resourceKey: input.snapshot.resourceKey,
      tier: input.tier,
      ttlMs: 5 * 60_000,
    });
  }
}

/**
 * Applies a signed parent decision to one pending child invocation. The grant
 * is child-local, exact, single-use, and still subject to the dispatcher's full
 * re-preparation/evaluation when the original invocation is retried.
 */
export class AttachedHostDecisionConsumer {
  constructor(
    private readonly deps: {
      endpoint: AttachedHostEndpoint;
      grantStore: Pick<CapabilityGrantStore, "issue">;
      revalidate: (challenge: AttachedHostApprovalChallenge) => boolean;
    }
  ) {}

  consume(decision: AttachedHostApprovalDecision): "once" | "deny" {
    return this.deps.endpoint.consumeDecision({
      decision,
      evaluateLocally: this.deps.revalidate,
      mintLocalOnce: ({ challenge, decision: effectiveDecision }) => {
        const snapshot = challenge.invocationSnapshot;
        this.deps.grantStore.issue({
          effect: effectiveDecision === "once" ? "allow" : "deny",
          capability: snapshot.capability,
          resource: { kind: "exact", key: snapshot.resourceKey },
          subject: snapshot.callerPrincipal,
          constraints: {
            sessionId: snapshot.sessionId,
            invocationDigest: challenge.invocationSnapshotDigest,
            ...(snapshot.agentBindingId ? { agentBindingId: snapshot.agentBindingId } : {}),
            lineageAtConsent: [...(snapshot.lineageClasses ?? ["none"])],
          },
          issuedBy: `attached-host:${challenge.sessionId}`,
          provenance: challenge.tier === "critical" ? "critical-confirmation" : "acquisition",
          scope: "once",
          expiresAt: Math.min(challenge.expiresAt, Date.now() + 5 * 60_000),
          decisionSurface: "attached-host-parent",
        });
      },
    });
  }
}

export interface OrdinaryAuthorityAcquirer {
  request(input: AttachedHostAcquisitionInput): AcquisitionInfo;
  requestMany?(inputs: readonly AttachedHostAcquisitionInput[]): AcquisitionInfo;
  canAcquireMany?(inputs: readonly AttachedHostAcquisitionInput[]): boolean;
  acquire(
    input: AttachedHostAcquisitionInput,
    signal?: AbortSignal
  ): Promise<{
    state: "decided" | "closed";
    decision?: "once" | "session" | "task" | "mission" | "agent" | "lock" | "version" | "deny";
    info?: AcquisitionInfo;
  }>;
  acquireMany?(
    inputs: readonly AttachedHostAcquisitionInput[],
    signal?: AbortSignal
  ): Promise<{
    state: "decided" | "closed";
    decision?: "once" | "session" | "task" | "mission" | "agent" | "lock" | "version" | "deny";
    info?: AcquisitionInfo;
  }>;
  consume(grantId: string): boolean;
  touch?(grantId: string): boolean;
  priorInteractiveApprovalCount?(input: {
    agentBindingId: string;
    capability: string;
    resource: ResourceScope;
  }): number;
  invalidate(snapshotDigest: string, ownerRuntimeId: string, callerPrincipal: string): void;
}

/** One dispatcher adapter: local calls retain the normal coordinator while
 * attached calls export a signed child challenge through the exact same seam. */
export function attachedHostAwareAuthorityAcquirer(
  ordinary: OrdinaryAuthorityAcquirer,
  attached: AttachedHostAuthorityBridge
): OrdinaryAuthorityAcquirer {
  return {
    request: (input) => (input.attachedHost ? attached.request(input) : ordinary.request(input)),
    ...(ordinary.requestMany
      ? {
          canAcquireMany: (inputs: readonly AttachedHostAcquisitionInput[]) =>
            inputs.every((input) => !input.attachedHost),
          requestMany: (inputs: readonly AttachedHostAcquisitionInput[]) => {
            if (inputs.some((input) => input.attachedHost))
              throw bridgeError(
                "EATTACHED_ACQUISITION_MODE",
                "Attached-host routes do not support one signed decision over multiple leaves"
              );
            return ordinary.requestMany!(inputs);
          },
        }
      : {}),
    acquire: (input, signal) =>
      input.attachedHost ? attached.acquire(input) : ordinary.acquire(input, signal),
    ...(ordinary.acquireMany
      ? {
          acquireMany: async (
            inputs: readonly AttachedHostAcquisitionInput[],
            signal?: AbortSignal
          ) => {
            if (inputs.some((input) => input.attachedHost))
              throw bridgeError(
                "EATTACHED_ACQUISITION_MODE",
                "Attached-host routes do not support one signed decision over multiple leaves"
              );
            return ordinary.acquireMany!(inputs, signal);
          },
        }
      : {}),
    consume: (grantId) => ordinary.consume(grantId),
    ...(ordinary.touch ? { touch: (grantId: string) => ordinary.touch!(grantId) } : {}),
    ...(ordinary.priorInteractiveApprovalCount
      ? {
          priorInteractiveApprovalCount: (input: {
            agentBindingId: string;
            capability: string;
            resource: ResourceScope;
          }) => ordinary.priorInteractiveApprovalCount!(input),
        }
      : {}),
    invalidate: (snapshotDigest, ownerRuntimeId, callerPrincipal) =>
      ordinary.invalidate(snapshotDigest, ownerRuntimeId, callerPrincipal),
  };
}

function bridgeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
