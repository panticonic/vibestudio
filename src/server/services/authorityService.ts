import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { authorityMethods } from "@vibestudio/service-schemas/authority";
import type { AcquisitionCoordinator } from "./acquisitionCoordinator.js";
import type { AuthorityPlanStore } from "./authorityPlanStore.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import type { AgentExecutionSessionRegistry } from "./agentExecutionSessionRegistry.js";
import type { VerifiedCodeIdentity } from "@vibestudio/shared/serviceDispatcher";
import { codePrincipal } from "@vibestudio/shared/authority/codePrincipal";
import { taskAuthorityPrincipal } from "./taskAuthorityRegistry.js";
import { receiverAuthorityPolicy } from "@vibestudio/shared/authority/receiverAuthorityPolicy";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";

export function createAuthorityService(deps: {
  dispatcher: ServiceDispatcher;
  acquisitions: AcquisitionCoordinator;
  authorityPlans?: AuthorityPlanStore;
  executionAdmissions?: AgentExecutionSessionRegistry;
  grants?: CapabilityGrantStore;
  workspaceId?: string;
  resolveCodeIdentity?: (runtimeId: string) => VerifiedCodeIdentity | null;
}): ServiceDefinition {
  return {
    name: "authority",
    description: "Acquisition lifecycle and side-effect-free authority inspection",
    authority: { principals: ["host", "user", "code", "session", "mission"] },
    methods: authorityMethods,
    handler: defineServiceHandler("authority", authorityMethods, {
      awaitDecision: (ctx, [input]) => {
        return deps.acquisitions.awaitDecision({
          acquisitionId: input.acquisitionId,
          ownerRuntimeId: ctx.caller.runtime.id,
          signal: ctx.signal,
        });
      },
      preflight: (ctx, [input]) =>
        deps.dispatcher.preflightAuthority(ctx, input.service, input.method, input.args),
      compileAuthorityPlan: (_ctx, [input]) => {
        const authorityPlans = requireDependency(deps.authorityPlans, "Authority plan compilation");
        const leaves = input.operations.map((operation) =>
          deps.dispatcher.compileAuthorityPlanLeaf({
            ...operation,
            args: operation.args ?? [],
          })
        );
        const catalogDigest = createHash("sha256")
          .update("authority-catalog-v1\0")
          .update(
            canonicalJson(
              leaves.map((leaf) => ({
                service: leaf.service,
                method: leaf.method,
                capabilityDefinitionDigest: leaf.capabilityDefinitionDigest,
              }))
            )
          )
          .digest("hex");
        const artifact = authorityPlans.publish({
          catalogDigest,
          executionImageDigest: input.executionImageDigest,
          leaves,
        });
        return {
          schemaVersion: 1,
          digest: artifact.bodyDigest,
          artifactRef: `authority-plan:${artifact.bodyDigest}` as const,
          compilerVersion: artifact.compilerVersion,
          catalogDigest: artifact.catalogDigest,
        };
      },
      acquireForTarget: (ctx, [input]) => {
        const authorityPlans = requireDependency(
          deps.authorityPlans,
          "Target authority acquisition"
        );
        const artifact = authorityPlans.get(input.authorityPlanDigest);
        if (!artifact) throw new Error(`Unknown authority plan ${input.authorityPlanDigest}`);
        const targetSubject = input.targetSubject as `mission:${string}@${string}`;
        const registered = deps.acquisitions.targetSubject(targetSubject);
        const sourceUser = registered?.ownerUser ?? attributedUser(ctx);
        if (registered) {
          if (
            registered.state !== "active" ||
            registered.authorityPlanDigest !== input.authorityPlanDigest ||
            registered.controllerRuntimeId !== ctx.caller.runtime.id
          ) {
            throw new Error(
              `Authority subject ${targetSubject} was replayed by a different controller or with a different policy or lifecycle`
            );
          }
        } else {
          deps.acquisitions.registerTargetSubject(
            targetSubject,
            input.authorityPlanDigest,
            sourceUser,
            ctx.caller.runtime.id
          );
        }
        for (const leaf of artifact.leaves) {
          if (
            leaf.tier === "open" ||
            leaf.tier === "critical" ||
            !receiverAuthorityPolicy(leaf.capability).missionGrant
          ) {
            continue;
          }
          deps.acquisitions.requestForTarget({
            targetSubject,
            authorityPlanDigest: input.authorityPlanDigest,
            operationKey: `${leaf.service}.${leaf.method}:${leaf.capabilityDefinitionDigest}`,
            capability: leaf.capability,
            capabilityDefinitionDigest: leaf.capabilityDefinitionDigest,
            resource: leaf.resource,
            tier: leaf.tier,
            sourceUser,
            renderedAction: `${leaf.service}.${leaf.method}`,
          });
        }
        const requests = deps.acquisitions.targetRequestsFor(
          targetSubject,
          input.authorityPlanDigest
        );
        return {
          requestIds: requests
            .filter((request) => request.state === "pending")
            .map((request) => request.requestId),
          grantIds: requests
            .filter((request) => request.state === "granted")
            .map((request) => request.grantId ?? request.requestId),
          denialIds: requests
            .filter((request) => request.state === "denied")
            .map((request) => request.requestId),
        };
      },
      admitExecution: (ctx, [input]) => {
        const authorityPlans = requireDependency(deps.authorityPlans, "Execution admission");
        const executionAdmissions = requireDependency(
          deps.executionAdmissions,
          "Execution admission"
        );
        const workspaceId = requireDependency(deps.workspaceId, "Execution admission");
        const resolveCodeIdentity = requireDependency(
          deps.resolveCodeIdentity,
          "Execution admission"
        );
        const missionSubject = input.mission.subject as `mission:${string}@${string}`;
        const mission = { ...input.mission, subject: missionSubject };
        const registered = deps.acquisitions.targetSubject(missionSubject);
        if (!registered || registered.state !== "active")
          throw new Error(`Unknown active authority subject ${input.mission.subject}`);
        if (registered.controllerRuntimeId !== ctx.caller.runtime.id)
          throw new Error("Execution admission was requested by a different mission controller");
        if (registered.authorityPlanDigest !== input.authorityPlanDigest)
          throw new Error("Execution policy does not match the registered mission subject");
        const artifact = authorityPlans.get(input.authorityPlanDigest);
        if (!artifact) throw new Error(`Unknown authority plan ${input.authorityPlanDigest}`);
        const imageDigest = createHash("sha256")
          .update("mission-execution-image-v1\0")
          .update(
            canonicalJson({
              source: input.executionImage.source,
              ref: input.executionImage.ref,
              effectiveVersion: input.executionImage.effectiveVersion,
              className: input.executionImage.className,
            })
          )
          .digest("hex");
        if (artifact.executionImageDigest !== imageDigest)
          throw new Error("Execution image does not match the compiled authority plan");
        const resident = resolveCodeIdentity(input.executor.runtimeId);
        if (
          !resident ||
          resident.repoPath !== input.executionImage.source ||
          resident.effectiveVersion !== input.executionImage.effectiveVersion ||
          !resident.executionDigest
        ) {
          throw new Error("Execution admission target is not the requested live immutable image");
        }
        if (
          !input.executor.runtimeId.startsWith(
            `do:${input.executionImage.source}:${input.executionImage.className}:`
          )
        ) {
          throw new Error("Execution admission target is not an instance of the requested class");
        }
        const taskAuthority = taskAuthorityPrincipal({
          workspaceId,
          ownerUser: registered.ownerUser,
          taskRef: input.taskRef,
        });
        const fact = executionAdmissions.admitExecution({
          controllerRuntimeId: ctx.caller.runtime.id,
          admissionKey: input.admissionKey,
          mode: "mission",
          ownerUser: registered.ownerUser,
          workspaceId,
          contextId: input.contextId,
          agentBinding:
            input.executor.kind === "agent-turn"
              ? {
                  entityId: input.executor.entityId,
                  channelId: input.executor.channelId,
                  bindingId: `${input.executor.entityId}@${input.contextId}`,
                }
              : null,
          taskRef: input.taskRef,
          taskAuthority,
          mission,
          authorityPlanDigest: input.authorityPlanDigest,
          executionImage: {
            principal: codePrincipal(resident),
            repoPath: resident.repoPath,
            ref: input.executionImage.ref as `state:${string}`,
            effectiveVersion: resident.effectiveVersion,
            executionDigest: resident.executionDigest,
          },
          executor: input.executor,
          parent: null,
          causalParent: ctx.causalParent
            ? {
                logId: ctx.causalParent.logId,
                head: ctx.causalParent.head,
                invocationId: ctx.causalParent.invocationId,
              }
            : null,
        });
        return { authoritySessionId: fact.authoritySessionId, nonce: fact.nonce };
      },
      finishExecution: (ctx, [input]) => {
        requireDependency(deps.executionAdmissions, "Execution admission").finishExecution(
          input.authoritySessionId,
          ctx.caller.runtime.id
        );
      },
      retireTarget: (ctx, [input]) => {
        const admissions = requireDependency(deps.executionAdmissions, "Target retirement");
        const grants = requireDependency(deps.grants, "Target retirement");
        const subject = input.targetSubject as `mission:${string}@${string}`;
        const registered = deps.acquisitions.targetSubject(subject);
        if (!registered) throw new Error(`Unknown authority subject ${subject}`);
        if (
          registered.controllerRuntimeId !== ctx.caller.runtime.id &&
          registered.ownerUser !== attributedUser(ctx)
        ) {
          throw Object.assign(
            new Error("Only the attributed owner can retire this authority subject"),
            { code: "EACCES" }
          );
        }
        if (admissions.hasLiveMissionSubject(subject)) {
          throw Object.assign(
            new Error("Target authority cannot retire while an admitted execution is live"),
            { code: "EBUSY" }
          );
        }
        const retired = deps.acquisitions.retireTargetSubject(subject);
        return {
          cancelledRequestCount: retired.cancelledRequests,
          revokedGrantCount: grants.revokeSubject(subject),
        };
      },
    }),
  };
}

function requireDependency<T>(value: T | undefined, operation: string): T {
  if (value === undefined) throw new Error(`${operation} is unavailable in this host role`);
  return value;
}

function attributedUser(ctx: Parameters<ServiceDefinition["handler"]>[0]): `user:${string}` {
  const authorizingUserId = ctx.authorizingCaller?.subject?.userId;
  const authorizingUser =
    authorizingUserId && authorizingUserId !== "system"
      ? (`user:${authorizingUserId}` as const)
      : undefined;
  const user = ctx.authorization?.actingUser ?? ctx.authorization?.ownerChain.at(-1);
  const direct = ctx.caller.subject?.userId;
  const resolved =
    authorizingUser ??
    user ??
    (direct && direct !== "system" ? (`user:${direct}` as const) : undefined);
  if (!resolved || resolved === "user:system") {
    throw Object.assign(new Error("Target authority acquisition requires user-attributed intent"), {
      code: "EACCES",
    });
  }
  return resolved;
}
