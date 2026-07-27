import type { AttachedHostExecutionFact } from "@vibestudio/rpc";
import type { ServiceDispatcher, VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  AttachedHostEndpoint,
  type AttachedHostLocalFacts,
  type AttachedHostProtocolStore,
  type AttachedHostRelationshipFacts,
  type AttachedHostSessionFacts,
} from "./attachedHostProtocol.js";

export interface AttachedHostChildRuntimeOptions {
  store: AttachedHostProtocolStore;
  dispatcher: Pick<ServiceDispatcher, "dispatch">;
  localFacts: (facts: AttachedHostSessionFacts) => AttachedHostLocalFacts;
  /**
   * Child-owned lookup of the initiating principal. It must resolve from the
   * mutually signed session and local runtime/user state, never route args.
   */
  resolveCaller: (relationship: AttachedHostRelationshipFacts) => VerifiedCaller;
  now?: () => number;
}

export interface AttachedHostChildEnvironment {
  instanceId: string;
  generationId: string;
  developmentRunId: string;
  parentGatewayUrl: string;
}

/**
 * Decode the environment marker for an isolated development child.
 *
 * `VIBESTUDIO_INSTANCE` also identifies ordinary developer-server instances,
 * so it cannot by itself opt a workspace runtime into attached-child mode.
 * The three development-specific facts form that marker; once any is present,
 * the complete binding (including the generic instance identity) is required.
 */
export function readAttachedHostChildEnvironment(
  env: NodeJS.ProcessEnv
): AttachedHostChildEnvironment | null {
  const instanceId = nonEmptyEnvironmentValue(env["VIBESTUDIO_INSTANCE"]);
  const generationId = nonEmptyEnvironmentValue(env["VIBESTUDIO_DEVELOPMENT_INSTANCE_GENERATION"]);
  const developmentRunId = nonEmptyEnvironmentValue(env["VIBESTUDIO_DEVELOPMENT_PARENT_RUN"]);
  const parentGatewayUrl = nonEmptyEnvironmentValue(env["VIBESTUDIO_ATTACHED_PARENT_GATEWAY_URL"]);
  const attachedValues = [generationId, developmentRunId, parentGatewayUrl];
  if (attachedValues.every((value) => value === null)) return null;
  if (
    instanceId === null ||
    generationId === null ||
    developmentRunId === null ||
    parentGatewayUrl === null
  ) {
    throw new Error("Attached-host child environment is incomplete");
  }
  return { instanceId, generationId, developmentRunId, parentGatewayUrl };
}

/** Construct the only child dispatch adapter. Every routed service call enters
 * the ordinary ServiceDispatcher with immutable route provenance. */
export function createAttachedHostChildEndpoint(
  options: AttachedHostChildRuntimeOptions
): AttachedHostEndpoint {
  return new AttachedHostEndpoint({
    role: "child",
    store: options.store,
    localFacts: options.localFacts,
    now: options.now,
    dispatch: async (input) => {
      const caller = options.resolveCaller(input.relationship);
      assertCallerMatchesRelationship(caller, input.relationship);
      const attachedHost: AttachedHostExecutionFact = {
        v: 1,
        sessionId: input.relationship.sessionId,
        requestId: input.invocationReference.requestId,
        parentHostId: input.relationship.parentHostId,
        childHostId: input.relationship.childHostId,
        childGenerationId: input.relationship.childGenerationId,
        developmentRunId: input.relationship.developmentRunId,
        ownerRuntimeId: input.relationship.ownerRuntimeId,
        ownerRuntimeKind: input.relationship.ownerRuntimeKind,
        ownerUserId: input.relationship.ownerUserId,
        authorityCeiling: input.authorityCeiling,
        authorityCeilingDigest: input.authorityCeilingDigest,
        expiresAt:
          options.store.getSession(input.relationship.sessionId)?.transcript.expiresAt ?? 0,
      };
      return await options.dispatcher.dispatch(
        {
          caller,
          attachedHost,
          // Attached invocations own a live parent rendezvous; they wait at the
          // canonical dispatcher acquisition seam.
          authorityAcquisition: "wait",
          requestId: input.invocationReference.requestId,
        },
        input.service,
        input.method,
        input.args
      );
    },
  });
}

function assertCallerMatchesRelationship(
  caller: VerifiedCaller,
  relationship: AttachedHostRelationshipFacts
): void {
  if (
    caller.runtime.id !== relationship.ownerRuntimeId ||
    caller.runtime.kind !== relationship.ownerRuntimeKind ||
    (caller.subject?.userId ?? null) !== relationship.ownerUserId
  ) {
    throw runtimeError(
      "EATTACHED_OWNER",
      "Child-local caller resolution does not match the attached session owner"
    );
  }
}

function runtimeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function nonEmptyEnvironmentValue(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
