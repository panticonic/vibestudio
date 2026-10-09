import type { AuthorityPlanAuthor } from "@vibestudio/rpc";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { missionExecutionImageDigest } from "@vibestudio/automation/mission";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceContext, VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { AcquisitionOwner, AuthorityAcquisitionRecord } from "./authorityAcquisitionStore.js";
import {
  authorityAcquisitionReceiptSchema,
  type AuthorityAcquisitionReceipt,
} from "@vibestudio/service-schemas/authority";
import { callerAccountUserId } from "@vibestudio/shared/serviceDispatcher";
import { isAccountUserId } from "@vibestudio/identity/types";
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
import type { TaskAuthorityRegistry } from "./taskAuthorityRegistry.js";
import { describeCapability } from "@vibestudio/shared/authorityPresentation";
import { resourcePhrase } from "@vibestudio/shared/authority/authorityRows";
import { acquisitionInvocationProjection } from "./acquisitionInvocationProjection.js";
import { doTargetId } from "@vibestudio/shared/workspaceServiceRpc";
import { bindContextArgs } from "@vibestudio/service-schemas/clients/contextBinding";

export function createAuthorityService(deps: {
  dispatcher: ServiceDispatcher;
  acquisitions: AcquisitionCoordinator;
  authorityPlans?: AuthorityPlanStore;
  executionAdmissions?: AgentExecutionSessionRegistry;
  grants?: CapabilityGrantStore;
  taskAuthorities?: TaskAuthorityRegistry;
  workspaceId?: string;
  resolveCodeIdentity?: (runtimeId: string) => VerifiedCodeIdentity | null;
  resolveAuthorEntity?: (runtimeId: string) => EntityRecord | null;
}): ServiceDefinition {
  const planAuthor = (caller: VerifiedCaller): AuthorityPlanAuthor => {
    const workspaceId = requireDependency(deps.workspaceId, "Authority plan author binding");
    const resolveEntity = requireDependency(
      deps.resolveAuthorEntity,
      "Authority plan author binding"
    );
    const resolveCode = requireDependency(
      deps.resolveCodeIdentity,
      "Authority plan author binding"
    );
    const entity = resolveEntity(caller.runtime.id);
    const code = resolveCode(caller.runtime.id);
    const userId = callerAccountUserId(caller);
    if (
      (caller.workspaceId !== undefined && caller.workspaceId !== workspaceId) ||
      entity?.status !== "active" ||
      !entity.authoritySessionId ||
      !code?.executionDigest ||
      !caller.code ||
      !userId ||
      code.repoPath !== caller.code.repoPath ||
      code.effectiveVersion !== caller.code.effectiveVersion ||
      code.executionDigest !== caller.code.executionDigest ||
      (caller.agentBinding &&
        canonicalJson(caller.agentBinding) !== canonicalJson(entity.agentBinding))
    ) {
      throw Object.assign(
        new Error("Authority plan author is not the exact active authenticated entity"),
        { code: "EACCES" }
      );
    }
    return {
      workspaceId,
      userId,
      runtimeId: caller.runtime.id,
      authoritySessionId: entity.authoritySessionId,
      contextId: entity.contextId,
      code: {
        repoPath: code.repoPath,
        effectiveVersion: code.effectiveVersion,
        executionDigest: code.executionDigest,
      },
      agentBinding: entity.agentBinding ?? null,
    };
  };
  const intentDigest = (execution: unknown) =>
    createHash("sha256")
      .update("authority-execution-intent-v1\0")
      .update(canonicalJson(execution))
      .digest("hex");
  return {
    name: "authority",
    description: "Acquisition lifecycle and side-effect-free authority inspection",
    authority: { principals: ["host", "user", "code", "session", "mission"] },
    methods: authorityMethods,
    handler: defineServiceHandler("authority", authorityMethods, {
      listTaskRules: (ctx, [input]) => {
        requireWorkspaceMember(ctx, "Task rule inspection");
        const workspaceId = requireDependency(deps.workspaceId, "Task rule inspection");
        const grants = requireDependency(deps.grants, "Task rule inspection");
        const subject = taskAuthorityPrincipal({ workspaceId, ...input });
        return grants
          .listActiveAuthorityGrants()
          .filter(
            (grant) =>
              grant.effect === "allow" &&
              grant.scope === "task" &&
              (grant.subject === subject || grant.constraints?.taskRef === input.channelId)
          )
          .map((grant) => ({
            id: grant.id,
            capability: grant.capability,
            action: describeCapability(grant.capability).action,
            resource: resourcePhrase(grant.resource),
            decidedAt: grant.createdAt,
          }));
      },
      resetTaskRules: (ctx, [input]) => {
        requireWorkspaceMember(ctx, "Task rule reset");
        const workspaceId = requireDependency(deps.workspaceId, "Task rule reset");
        const grants = requireDependency(deps.grants, "Task rule reset");
        const subject = taskAuthorityPrincipal({ workspaceId, ...input });
        const subjects = new Set(
          grants
            .listActiveAuthorityGrants()
            .filter(
              (grant) =>
                grant.scope === "task" &&
                (grant.subject === subject || grant.constraints?.taskRef === input.channelId)
            )
            .map((grant) => grant.subject)
        );
        subjects.add(subject);
        let revokedGrantCount = 0;
        grants.transaction(() => {
          for (const current of subjects) revokedGrantCount += grants.revokeSubject(current);
        });
        return { revokedGrantCount };
      },
      awaitDecision: async (ctx, [input]) => {
        const outcome = await deps.acquisitions.awaitDecision({
          acquisitionId: input.acquisitionId,
          ...acquisitionOwner(ctx),
          signal: ctx.signal,
        });
        return {
          state: outcome.state,
          ...(outcome.decision ? { decision: outcome.decision } : {}),
        };
      },
      acquisitionReceipt: (ctx, [input]) => {
        const owner = acquisitionOwner(ctx);
        const grants = requireDependency(deps.grants, "Acquisition receipt inspection");
        const record = grants.acquisitions.get(input.acquisitionId, owner);
        return record ? acquisitionReceipt(record) : null;
      },
      outstandingAcquisitions: (ctx, [input]) => {
        const owner = acquisitionOwner(ctx);
        const grants = requireDependency(deps.grants, "Acquisition recovery");
        const records = grants.acquisitions.outstanding(owner, input);
        const last = records[records.length - 1];
        return {
          receipts: records.map(acquisitionReceipt),
          next:
            records.length === 64 && last
              ? { createdAt: last.createdAt, acquisitionId: last.acquisitionId }
              : null,
        };
      },
      withdrawAcquisition: async (ctx, [input]) =>
        acquisitionReceipt(
          await deps.acquisitions.withdrawAcquisition({ ...input, ...acquisitionOwner(ctx) })
        ),
      acknowledgeAcquisition: (ctx, [input]) => {
        const owner = acquisitionOwner(ctx);
        const grants = requireDependency(deps.grants, "Acquisition acknowledgement");
        grants.acquisitions.acknowledge(input.acquisitionId, owner, input.resolutionDigest);
        return { acknowledged: true };
      },
      preflight: (ctx, [input]) =>
        deps.dispatcher.preflightAuthority(ctx, input.service, input.method, input.args),
      compileAuthorityPlan: async (ctx, [input]) => {
        const authorityPlans = requireDependency(deps.authorityPlans, "Authority plan compilation");
        const author = planAuthor(ctx.caller);
        const operations = [];
        for (const operation of input.execution.operations) {
          operations.push(
            await deps.dispatcher.compileAuthorityPlanOperation(ctx, {
              ...operation,
              args: bindContextArgs(
                operation.service,
                operation.method,
                operation.args ?? [],
                author.contextId
              ),
            })
          );
        }
        const leaves = operations.flatMap((operation) => operation.leaves);
        const catalogDigest = createHash("sha256")
          .update("authority-catalog-v1\0")
          .update(canonicalJson(operations.map((operation) => operation.definitionDigest)))
          .digest("hex");
        const artifact = authorityPlans.publish({
          catalogDigest,
          executionImageDigest: missionExecutionImageDigest(input.execution.image),
          leaves,
          author,
          executionIntentDigest: intentDigest({
            ...input.execution,
            operations: operations.map((operation) => operation.intent),
          }),
        });
        return {
          schemaVersion: 2,
          digest: artifact.bodyDigest,
          artifactRef: `authority-plan:${artifact.bodyDigest}` as const,
          compilerVersion: artifact.compilerVersion,
          catalogDigest: artifact.catalogDigest,
        };
      },
      verifyAuthorityPlan: (ctx, [input]) => {
        const plans = requireDependency(deps.authorityPlans, "Authority plan verification");
        const artifact = plans.get(input.authorityPlanDigest);
        if (!artifact || artifact.schemaVersion !== 2)
          throw Object.assign(
            new Error("New automation definitions require an author-bound authority plan"),
            { code: "EACCES" }
          );
        // The live parent contains both the root review initiator and the actual
        // immediate author. Neither identity replaces the controller's caller.
        const invokingCaller = ctx.invokingCaller ?? ctx.caller;
        const author = planAuthor(invokingCaller);
        if (canonicalJson(author) !== canonicalJson(artifact.author))
          throw Object.assign(
            new Error("Authority plan belongs to a different author or entity lifecycle"),
            { code: "EACCES" }
          );
        const operations = input.execution.operations.map((operation) =>
          deps.dispatcher.normalizeAuthorityPlanOperation(
            { caller: invokingCaller },
            {
              ...operation,
              args: bindContextArgs(
                operation.service,
                operation.method,
                operation.args ?? [],
                author.contextId
              ),
            }
          )
        );
        if (
          artifact.executionImageDigest !== missionExecutionImageDigest(input.execution.image) ||
          artifact.executionIntentDigest !== intentDigest({ ...input.execution, operations })
        )
          throw Object.assign(
            new Error("Authority plan does not match the exact declared execution intent"),
            { code: "EACCES" }
          );
        if (input.execution.kind === "agent" && input.execution.conversation.mode === "continue") {
          const continuation = input.execution.conversation;
          const resolveEntity = requireDependency(
            deps.resolveAuthorEntity,
            "Continuing automation target verification"
          );
          const target = resolveEntity(continuation.executorId);
          const targetCode = deps.resolveCodeIdentity?.(continuation.executorId);
          const targetOwner =
            target?.ownerUserId ??
            deps.executionAdmissions?.resolve(continuation.executorId)?.ownerUser.slice(5);
          if (
            target?.status !== "active" ||
            !target.authoritySessionId ||
            !target.agentBinding ||
            !targetCode?.executionDigest ||
            targetOwner !== author.userId ||
            target.contextId !== continuation.contextId ||
            target.agentBinding.contextId !== continuation.contextId ||
            target.agentBinding.channelId !== continuation.channelId ||
            target.className !== input.execution.image.className ||
            target.key !== input.execution.image.objectKey ||
            continuation.executorId !== doTargetId(input.execution.image) ||
            targetCode.repoPath !== input.execution.image.source ||
            targetCode.effectiveVersion !== input.execution.image.effectiveVersion
          )
            throw Object.assign(
              new Error(
                "Continuing automation does not name its exact live authoring conversation"
              ),
              { code: "EACCES" }
            );
        }
        return {
          schemaVersion: 2,
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
        if (
          !registered &&
          (artifact.schemaVersion !== 2 || artifact.author.userId !== sourceUser.slice(5))
        )
          throw Object.assign(new Error("New mission authority requires its owner's bound plan"), {
            code: "EACCES",
          });
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
            operationKey: canonicalJson({
              service: leaf.service,
              method: leaf.method,
              capability: leaf.capability,
              capabilityDefinitionDigest: leaf.capabilityDefinitionDigest,
              resource: leaf.resource,
            }),
            capability: leaf.capability,
            capabilityDefinitionDigest: leaf.capabilityDefinitionDigest,
            resource: leaf.resource,
            tier: leaf.tier,
            sourceUser,
            renderedAction: leaf.review.action,
            review: leaf.review,
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
      acquireForCurrentTask: (ctx, [input]) => {
        const authorityPlans = requireDependency(
          deps.authorityPlans,
          "Task authority pre-acquisition"
        );
        const artifact = authorityPlans.get(input.authorityPlanDigest);
        if (!artifact) throw new Error(`Unknown authority plan ${input.authorityPlanDigest}`);
        if (
          artifact.schemaVersion !== 2 ||
          canonicalJson(artifact.author) !== canonicalJson(planAuthor(ctx.caller))
        )
          throw Object.assign(
            new Error("Task pre-acquisition requires its live author's bound plan"),
            { code: "EACCES" }
          );
        const targetSubject = ctx.caller.taskAuthority;
        if (!targetSubject) {
          throw Object.assign(
            new Error("Authority pre-acquisition requires an authenticated agent task"),
            { code: "EACCES" }
          );
        }
        const sourceUser = attributedUser(ctx);
        const plannedRules = [];
        for (const leaf of artifact.leaves) {
          // Open calls need no grant. Critical consent is invocation-specific
          // and therefore cannot honestly be pre-acquired for a future turn.
          if (leaf.tier === "open" || leaf.tier === "critical") continue;
          plannedRules.push({
            targetSubject,
            authorityPlanDigest: input.authorityPlanDigest,
            operationKey: canonicalJson({
              service: leaf.service,
              method: leaf.method,
              capability: leaf.capability,
              capabilityDefinitionDigest: leaf.capabilityDefinitionDigest,
              resource: leaf.resource,
            }),
            capability: leaf.capability,
            capabilityDefinitionDigest: leaf.capabilityDefinitionDigest,
            resource: leaf.resource,
            tier: leaf.tier,
            sourceUser,
            renderedAction: leaf.review.action,
            review: leaf.review,
          });
        }
        deps.acquisitions.requestTaskRulesForTarget(plannedRules);
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
          contextId: input.contextId,
          channelId:
            input.executor.kind === "agent-turn" ? input.executor.channelId : input.taskRef,
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
        const taskAuthorities = requireDependency(deps.taskAuthorities, "Execution admission");
        taskAuthorities.bindPrincipal(taskAuthority, {
          workspaceId,
          contextId: input.contextId,
          channelId:
            input.executor.kind === "agent-turn" ? input.executor.channelId : input.taskRef,
        });
        taskAuthorities.bindExecution(fact);
        return { authoritySessionId: fact.authoritySessionId, nonce: fact.nonce };
      },
      finishExecution: async (ctx, [input]) => {
        await requireDependency(deps.executionAdmissions, "Execution admission").finishExecution(
          input.authoritySessionId,
          ctx.caller.runtime.id,
          (sessionId) => deps.acquisitions.closeSession(sessionId)
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
    authorizingUserId && isAccountUserId(authorizingUserId)
      ? (`user:${authorizingUserId}` as const)
      : undefined;
  const user = ctx.authorization?.actingUser ?? ctx.authorization?.ownerChain.at(-1);
  const direct = callerAccountUserId(ctx.caller);
  const resolved = authorizingUser ?? user ?? (direct ? (`user:${direct}` as const) : undefined);
  if (!resolved || !isAccountUserId(resolved.slice("user:".length))) {
    throw Object.assign(new Error("Target authority acquisition requires user-attributed intent"), {
      code: "EACCES",
    });
  }
  return resolved;
}

function requireWorkspaceMember(
  ctx: Parameters<ServiceDefinition["handler"]>[0],
  operation: string
): void {
  if (!ctx.caller.subject || ctx.caller.subject.userId === "system") {
    throw Object.assign(new Error(`${operation} requires an authenticated workspace member`), {
      code: "EACCES",
    });
  }
}

/** The dispatcher installs these facts after authenticating the live caller. No service argument selects a session. */
function acquisitionOwner(ctx: Pick<ServiceContext, "caller" | "authorization">): AcquisitionOwner {
  const sessionId = ctx.authorization?.session.id;
  if (!sessionId)
    throw Object.assign(new Error("Acquisition access requires its authenticated session"), {
      code: "EACCES",
    });
  return { ownerRuntimeId: ctx.caller.runtime.id, sessionId };
}

function acquisitionReceipt(record: AuthorityAcquisitionRecord): AuthorityAcquisitionReceipt {
  return authorityAcquisitionReceiptSchema.parse({
    acquisitionId: record.acquisitionId,
    admission: record.admission,
    invocations: acquisitionInvocationProjection(record),
    bindingDigest: record.bindingDigest,
    createdAt: record.createdAt,
    state: record.state,
    ...(record.resolution
      ? {
          resolution: record.resolution.value,
          resolutionDigest: record.resolutionDigest,
          settledAt: record.settledAt,
          ...(record.acknowledgedAt !== undefined ? { acknowledgedAt: record.acknowledgedAt } : {}),
        }
      : {}),
  });
}
