import {
  DEVELOPMENT_NATIVE_EXECUTE_CAPABILITY,
  DEVELOPMENT_OPEN_AUTHORITY_RESOLVER,
  DEVELOPMENT_START_AUTHORITY_RESOLVER,
  developmentMethods,
  type DevelopmentRun,
  type DevelopmentSession,
  type DevelopmentTarget,
} from "@vibestudio/service-schemas/development";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import {
  fixedPreparedAuthoritySelection,
  preparedAuthorityPayload,
  selectedPreparedAuthoritySelection,
  type ServiceDefinition,
} from "@vibestudio/shared/serviceDefinition";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { ServiceContext, VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { createHash } from "node:crypto";
import type { RuntimeServiceInternal } from "./runtimeService.js";
import type {
  NativeDevelopmentCheckpointReceipt,
  NativeDevelopmentSemanticIngress,
  NativeDevelopmentSessionReceipt,
  NativeDevelopmentTerminalSnapshot,
  NativeDevelopmentToolId,
} from "./nativeDevelopmentExecutor.js";
import { nativeDevelopmentOwnedRootId } from "./nativeDevelopmentExecutor.js";
import { DevelopmentSessionStore, developmentSessionId } from "./developmentSessionStore.js";
import { DevelopmentExecutor, type PreparedDevelopmentBuild } from "./developmentExecutor.js";
import { DevelopmentRecipeRegistry } from "./developmentRecipes.js";
import type { IsolatedDevelopmentHostExecutor } from "./isolatedDevelopmentHostExecutor.js";
import type { DevelopmentClientExecutorRegistry } from "./developmentClientExecutorService.js";
import type { AttachedHostPublisher } from "./attachedHostController.js";
import { scopeContains } from "./attachedHostProtocol.js";
import type { CapabilityScope } from "@vibestudio/rpc";
import type {
  SystemTestBuildFault,
  SystemTestBuildFaultArmReceipt,
  SystemTestBuildFaultPhase,
} from "./systemTestBuildFaultRegistry.js";

export interface DevelopmentRepositoryResolver {
  resolveExact(input: { contextId: string; repositoryId: string }): Promise<
    | {
        status: "present";
        repoPath: string;
        sourceState: DevelopmentSession["basis"]["parentWorkingHead"];
      }
    | { status: "not-adopted" }
  >;
}

export interface NativeDevelopmentController {
  describeTool(toolId: NativeDevelopmentToolId): Promise<{
    toolId: NativeDevelopmentToolId;
    executorId: string;
    available: boolean;
    unavailableReason?: string;
    interactiveTerminal: boolean;
  }>;
  open(input: {
    sessionId: string;
    developmentContextId: string;
    repositoryId: string;
    childWorkingHead: DevelopmentSession["basis"]["childBaseState"];
    toolId: NativeDevelopmentToolId;
    idempotencyKey: string;
    ingress: NativeDevelopmentSemanticIngress;
  }): Promise<NativeDevelopmentSessionReceipt>;
  checkpoint(input: {
    sessionId: string;
    idempotencyKey: string;
    ingress: NativeDevelopmentSemanticIngress;
  }): Promise<NativeDevelopmentCheckpointReceipt>;
  inspect(
    sessionId: string,
    options?: { assessPendingChanges?: boolean }
  ): Promise<NativeDevelopmentSessionReceipt>;
  stop(sessionId: string): Promise<NativeDevelopmentSessionReceipt>;
  recover(sessionId: string): Promise<NativeDevelopmentSessionReceipt>;
  keep(sessionId: string): Promise<NativeDevelopmentSessionReceipt>;
  forceRetire(sessionId: string): Promise<{
    retired: boolean;
    cleanupErrors: string[];
  }>;
  readTerminal(input: {
    sessionId: string;
    after?: number;
    maxBytes?: number;
  }): Promise<NativeDevelopmentTerminalSnapshot>;
  writeTerminal(input: { sessionId: string; writeId: string; data: string }): Promise<void>;
  resizeTerminal(input: { sessionId: string; columns: number; rows: number }): Promise<void>;
}

type OpenSessionResult =
  | { kind: "opened"; session: DevelopmentSession }
  | {
      kind: "repository-not-adopted";
      repositoryId: string;
      contextId: string;
      adoptionAction: "gitInterop.importProject";
    };

const TERMINAL = new Set<DevelopmentRun["state"]>(["succeeded", "stopped", "failed", "cancelled"]);
const DAY_MS = 24 * 60 * 60 * 1_000;
const STANDING_GRANT_DAYS = 30;

export function createDevelopmentService(deps: {
  store: DevelopmentSessionStore;
  runtime: RuntimeServiceInternal;
  repositories: DevelopmentRepositoryResolver;
  executor: Pick<
    DevelopmentExecutor,
    "prepare" | "materialize" | "execute" | "stop" | "retire" | "resolveClientArtifactSource"
  >;
  native?: NativeDevelopmentController;
  isolatedExecutor?: Pick<
    IsolatedDevelopmentHostExecutor,
    | "start"
    | "stop"
    | "recover"
    | "mintClientInvite"
    | "waitForClientAttestation"
    | "takeAttachmentPorts"
    | "retireManagementChannel"
  >;
  attachedHostPublisher?: AttachedHostPublisher;
  attachedHostParentId?: string;
  attachedHostAuthorityCeiling?: readonly CapabilityScope[];
  clientExecutors?: Pick<
    DevelopmentClientExecutorRegistry,
    "select" | "launch" | "stop" | "acceptManagedChildAttestation"
  >;
  resolveClientExecutorRuntime?: (ctx: ServiceContext) => string | null;
  mintCurrentHostInvite?: (input: {
    userId: string;
    ttlMs: number;
  }) => Promise<{ pairing: { deepLink: string } }>;
  isStateDescendant(
    ancestor: DevelopmentSession["basis"]["childBaseState"],
    descendant: DevelopmentSession["basis"]["childBaseState"]
  ): Promise<boolean>;
  recipes?: DevelopmentRecipeRegistry;
  eventService?: Pick<EventService, "emitToCaller" | "emitToUser">;
  /** Host-attested, one-shot system-test seam; never a product build option. */
  armSystemTestBuildFailure?: (
    caller: VerifiedCaller,
    input: {
      sessionId: string;
      runId: string;
      ownerRuntimeId: string;
      ownerUserId: string | null;
    },
    phase: SystemTestBuildFaultPhase
  ) => SystemTestBuildFaultArmReceipt;
  consumeSystemTestBuildFailure?: (run: DevelopmentRun) => SystemTestBuildFault | null;
  now?: () => number;
}): ServiceDefinition {
  const now = deps.now ?? Date.now;
  const recipes = deps.recipes ?? new DevelopmentRecipeRegistry();
  const opening = new Map<string, Promise<OpenSessionResult>>();
  const running = new Map<string, Promise<void>>();

  deps.store.onRunEvent((run, event) => {
    const payload = { runId: run.runId, sessionId: run.sessionId, event };
    if (run.ownerUserId) {
      deps.eventService?.emitToUser(run.ownerUserId, "development:run-event", payload);
    } else {
      deps.eventService?.emitToCaller(run.ownerRuntimeId, "development:run-event", payload);
    }
  });

  const visibleSession = (
    session: DevelopmentSession | null,
    caller: VerifiedCaller
  ): DevelopmentSession | null =>
    session && ownerMatches(session.owner.runtimeId, session.owner.userId, caller) ? session : null;
  const requireSession = (
    session: DevelopmentSession | null,
    caller: VerifiedCaller
  ): DevelopmentSession => {
    const result = visibleSession(session, caller);
    if (!result) throw Object.assign(new Error("Unknown development session"), { code: "ENOENT" });
    return result;
  };
  const visibleRun = (run: DevelopmentRun | null, caller: VerifiedCaller): DevelopmentRun | null =>
    run && ownerMatches(run.ownerRuntimeId, run.ownerUserId, caller) ? run : null;
  const requireRun = (run: DevelopmentRun | null, caller: VerifiedCaller): DevelopmentRun => {
    const result = visibleRun(run, caller);
    if (!result) throw Object.assign(new Error("Unknown development run"), { code: "ENOENT" });
    return result;
  };

  async function openSession(
    ctx: ServiceContext,
    input: {
      repositoryId: string;
      mode: "semantic" | "native-tool";
      nativeTool?: NativeDevelopmentToolId;
      idempotencyKey: string;
    }
  ): Promise<OpenSessionResult> {
    const caller = ctx.caller;
    const key = `${developmentOwnerKey(caller)}\0${input.idempotencyKey}`;
    const active = opening.get(key);
    if (active) return active;
    const operation = openSessionOnce(ctx, input).finally(() => opening.delete(key));
    opening.set(key, operation);
    return operation;
  }

  async function openSessionOnce(
    ctx: ServiceContext,
    input: {
      repositoryId: string;
      mode: "semantic" | "native-tool";
      nativeTool?: NativeDevelopmentToolId;
      idempotencyKey: string;
    }
  ): Promise<OpenSessionResult> {
    const caller = ctx.caller;
    const owner = developmentOwner(caller);
    const existing = deps.store.findOpen(owner, input.idempotencyKey);
    if (existing) {
      if (
        existing.repository.repositoryId !== input.repositoryId ||
        existing.mode !== input.mode ||
        existing.nativeTool !== (input.nativeTool ?? null)
      ) {
        throw Object.assign(
          new Error("Open idempotency key was reused with different repository identity"),
          { code: "EIDEMPOTENCYDRIFT" }
        );
      }
      return { kind: "opened", session: existing };
    }
    const sessionId = developmentSessionId(developmentOwnerKey(caller), input.idempotencyKey);
    if (input.mode === "native-tool") {
      if (!input.nativeTool || !deps.native) {
        throw Object.assign(new Error("Native development executor is unavailable"), {
          code: "EEXECUTOR_UNAVAILABLE",
        });
      }
      const tool = await deps.native.describeTool(input.nativeTool);
      if (!tool.available || !tool.interactiveTerminal) {
        throw Object.assign(
          new Error(
            `Native tool ${input.nativeTool} is unavailable: ${
              tool.unavailableReason ?? "interactive-terminal-unavailable"
            }`
          ),
          { code: "EEXECUTOR_UNAVAILABLE" }
        );
      }
    }
    const parentContextId = await deps.runtime.resolveContext(caller.runtime.id);
    if (!parentContextId) {
      throw Object.assign(
        new Error(`Development session caller ${caller.runtime.id} has no semantic context`),
        { code: "ENOENT" }
      );
    }
    const parentRepository = await deps.repositories.resolveExact({
      contextId: parentContextId,
      repositoryId: input.repositoryId,
    });
    if (parentRepository.status === "not-adopted") {
      return {
        kind: "repository-not-adopted",
        repositoryId: input.repositoryId,
        contextId: parentContextId,
        adoptionAction: "gitInterop.importProject",
      };
    }
    const context = await deps.runtime.forkDevelopmentSessionContext(caller, sessionId);
    let childRepository: Awaited<ReturnType<DevelopmentRepositoryResolver["resolveExact"]>>;
    try {
      childRepository = await deps.repositories.resolveExact({
        contextId: context.contextId,
        repositoryId: input.repositoryId,
      });
    } catch (error) {
      await discardAfterRejectedOpen(deps.runtime, context.contextId, error);
      throw error;
    }
    if (childRepository.status === "not-adopted") {
      await discardAfterRejectedOpen(deps.runtime, context.contextId);
      return {
        kind: "repository-not-adopted",
        repositoryId: input.repositoryId,
        contextId: context.contextId,
        adoptionAction: "gitInterop.importProject",
      };
    }
    if (childRepository.repoPath !== parentRepository.repoPath) {
      await discardAfterRejectedOpen(deps.runtime, context.contextId);
      throw Object.assign(
        new Error("Repository identity changed across the semantic context fork"),
        { code: "EIDENTITYDRIFT" }
      );
    }
    const at = now();
    const session: DevelopmentSession = {
      sessionId,
      idempotencyKey: input.idempotencyKey,
      state: "opening",
      mode: input.mode,
      nativeTool: input.nativeTool ?? null,
      native: null,
      repository: {
        repositoryId: input.repositoryId,
        repoPath: childRepository.repoPath,
      },
      contextId: context.contextId,
      parentContextId: context.parentContextId,
      basis: {
        parentWorkingHead: context.parentWorkingHead,
        childBaseState: context.childBaseState,
      },
      owner: {
        runtimeId: caller.runtime.id,
        runtimeKind: caller.runtime.kind,
        userId: caller.subject?.userId ?? null,
      },
      contextEffect: "owned",
      repairAttention: null,
      createdAt: at,
      updatedAt: at,
      primaryDiagnostic: null,
      cleanupDiagnostics: [],
    };
    deps.store.putOpening(session);
    if (input.mode === "native-tool") {
      try {
        const native = await deps.native!.open({
          sessionId,
          developmentContextId: session.contextId,
          repositoryId: session.repository.repositoryId,
          childWorkingHead: session.basis.childBaseState,
          toolId: input.nativeTool!,
          idempotencyKey: input.idempotencyKey,
          ingress: semanticIngress(ctx),
        });
        return {
          kind: "opened",
          session: deps.store.update(
            sessionId,
            {
              state: native.state === "requires-repair" ? "requires-repair" : "ready",
              native: nativeSessionRecord(native),
              primaryDiagnostic:
                native.repair === null
                  ? null
                  : toDiagnostic(new Error(native.repair.primaryError), now()),
              cleanupDiagnostics:
                native.repair?.cleanupErrors.map((message) =>
                  toDiagnostic(new Error(message), now())
                ) ?? [],
              repairAttention: native.repair?.attention ?? null,
            },
            now()
          ),
        };
      } catch (error) {
        const diagnostic = toDiagnostic(error, now());
        deps.store.update(
          sessionId,
          {
            state: "requires-repair",
            primaryDiagnostic: diagnostic,
            cleanupDiagnostics: [],
            repairAttention: "actionable",
          },
          now()
        );
        throw error;
      }
    }
    return {
      kind: "opened",
      session: deps.store.update(
        sessionId,
        {
          state: "ready",
          primaryDiagnostic: null,
          cleanupDiagnostics: [],
          repairAttention: null,
        },
        at
      ),
    };
  }

  const prepareStart = async (
    ctx: Parameters<NonNullable<ServiceDefinition["authorityPreparation"]>[string]>[0],
    rawInput: unknown
  ) => {
    const input = rawInput as
      | {
          sessionId: string;
          runId: string;
          recipeId: string;
          target: DevelopmentTarget;
        }
      | { runId: string; idempotencyKey: string };
    let session: DevelopmentSession;
    let plan: PreparedDevelopmentBuild;
    let retry = false;
    if ("sessionId" in input) {
      session = requireSession(deps.store.get(input.sessionId), ctx.caller);
      if (session.state !== "ready")
        throw Object.assign(new Error("Development session is not ready"), { code: "ESTATE" });
      const existing = deps.store.getRun(input.runId);
      if (existing) {
        assertStartIntent(existing, input, ctx.caller);
        plan = deps.store.getRunPlan(input.runId);
      } else {
        plan = await deps.executor.prepare({
          session,
          runId: input.runId,
          recipeId: input.recipeId,
        });
      }
      if (canonicalJson(plan.recipe.target) !== canonicalJson(input.target)) {
        throw Object.assign(
          new Error("Selected target does not match the reviewed development recipe"),
          { code: "EIDEMPOTENCYDRIFT" }
        );
      }
      if (needsClientExecutor(input.target) && !plan.clientExecutor) {
        const ownerUserId = ctx.caller.subject?.userId;
        const ownerRuntimeId = deps.resolveClientExecutorRuntime?.(ctx) ?? null;
        if (!ownerUserId || !ownerRuntimeId || !deps.clientExecutors) {
          throw Object.assign(
            new Error(
              "This launch must be initiated from a connected desktop with a local Electron executor"
            ),
            { code: "EEXECUTOR_UNAVAILABLE" }
          );
        }
        const selected = deps.clientExecutors.select({
          ownerUserId,
          ownerRuntimeId,
          platform: plan.recipe.platform,
          arch: plan.recipe.arch,
        });
        if (!selected) {
          throw Object.assign(
            new Error("The initiating desktop has no live reviewed Electron executor"),
            { code: "EEXECUTOR_UNAVAILABLE" }
          );
        }
        plan = { ...plan, clientExecutor: selected };
      }
    } else {
      retry = true;
      const run = requireRun(deps.store.getRun(input.runId), ctx.caller);
      if (!run.repair?.retryable) {
        throw Object.assign(new Error("This run cannot be retried from a proven commit point"), {
          code: "ENOTRECOVERABLE",
        });
      }
      session = requireSession(deps.store.get(run.sessionId), ctx.caller);
      plan = deps.store.getRunPlan(run.runId);
    }
    if (
      !(await deps.isStateDescendant(session.basis.childBaseState, plan.snapshot.repositoryState))
    ) {
      throw Object.assign(
        new Error("Prepared source is not a descendant of the development session basis"),
        { code: "ELINEAGE" }
      );
    }
    const expiresAt = (Math.floor(now() / DAY_MS) + STANDING_GRANT_DAYS + 1) * DAY_MS;
    const resourceKey = developmentNativeResourceKey({
      contextId: session.contextId,
      repositoryId: session.repository.repositoryId,
      baseState: session.basis.childBaseState,
      executorId: plan.snapshot.toolchain.executorId,
      recipeId: plan.recipe.recipeId,
      lockfileDigest: plan.snapshot.lockfileDigest,
      network: plan.recipe.install.network,
      target: plan.recipe.target,
      clientExecutor: plan.clientExecutor ?? null,
    });
    const resource = {
      type: "development-build",
      label: "Development build scope",
      value: `${session.repository.repoPath} · ${plan.recipe.label}`,
    };
    return {
      selections: [
        fixedPreparedAuthoritySelection({
          capability: DEVELOPMENT_NATIVE_EXECUTE_CAPABILITY,
          resourceKey,
          grantExpiresAt: expiresAt,
          challenge: {
            title: `${retry ? "Retry" : "Build"} ${session.repository.repoPath}`,
            description:
              `Run the reviewed Vibestudio build with local OS authority. Choosing the standing ` +
              `option covers repeated descendant source builds in this development session until ` +
              `${new Date(expiresAt).toISOString()}, while the executor, recipe, lockfiles, and ` +
              `network scope remain unchanged. It is visible and revocable in Permissions.`,
            deniedReason: "Native development build was not approved",
            dedupKey: `development-build:${resourceKey}`,
            resource,
            operation: {
              kind: "runtime",
              verb: "Build exact semantic source",
              object: resource,
              groupKey: `development-build:${session.sessionId}`,
            },
            substance: {
              kind: "custom",
              summary: `Build exact snapshot ${plan.snapshot.snapshotDigest.slice(0, 12)}`,
              detail:
                "Dependency lifecycle scripts and project build code execute with the executor account's local OS authority.",
              facts: [
                { label: "Repository", value: session.repository.repoPath },
                { label: "Context", value: session.contextId },
                { label: "Semantic state", value: formatState(plan.snapshot.repositoryState) },
                { label: "Snapshot", value: plan.snapshot.snapshotDigest },
                { label: "Executor", value: plan.snapshot.toolchain.executorId },
                { label: "Recipe", value: plan.recipe.recipeId },
                { label: "Lockfiles", value: plan.snapshot.lockfileDigest },
                { label: "Network", value: plan.recipe.install.network },
                { label: "Target", value: developmentTargetLabel(plan.recipe.target) },
                ...(plan.clientExecutor
                  ? [
                      {
                        label: "Client executor",
                        value: `${plan.clientExecutor.platform}/${plan.clientExecutor.arch} · ${plan.clientExecutor.providerId}`,
                      },
                      {
                        label: "Initiating device",
                        value: plan.clientExecutor.ownerRuntimeId,
                      },
                    ]
                  : []),
              ],
            },
            details: [
              { label: "Exact snapshot", value: plan.snapshot.snapshotDigest },
              { label: "Node", value: plan.snapshot.toolchain.node.version },
              { label: "pnpm", value: plan.snapshot.toolchain.pnpm.version },
              { label: "Network", value: plan.recipe.install.network },
              {
                label: "Standing coverage",
                value: `Descendant source builds until ${new Date(expiresAt).toLocaleDateString()}`,
              },
            ],
            allowedDecisions: ["once", "session", "version", "deny"],
            grantExpiresAt: expiresAt,
          },
        }),
      ],
      payload: plan,
    };
  };

  const prepareOpen = async (
    ctx: Parameters<NonNullable<ServiceDefinition["authorityPreparation"]>[string]>[0],
    rawInput: unknown
  ) => {
    const input = rawInput as {
      repositoryId: string;
      mode: "semantic" | "native-tool";
      nativeTool?: NativeDevelopmentToolId;
      idempotencyKey: string;
    };
    if (input.mode === "semantic") return { selections: [], payload: null };
    if (!input.nativeTool || !deps.native) {
      throw Object.assign(new Error("Native development executor is unavailable"), {
        code: "EEXECUTOR_UNAVAILABLE",
      });
    }
    const contextId = await deps.runtime.resolveContext(ctx.caller.runtime.id);
    if (!contextId) {
      throw Object.assign(new Error("Development caller has no semantic context"), {
        code: "ENOENT",
      });
    }
    const repository = await deps.repositories.resolveExact({
      contextId,
      repositoryId: input.repositoryId,
    });
    if (repository.status === "not-adopted") {
      return { selections: [], payload: null };
    }
    const tool = await deps.native.describeTool(input.nativeTool);
    if (!tool.available || !tool.interactiveTerminal) {
      throw Object.assign(
        new Error(
          `Native tool ${input.nativeTool} is unavailable: ${
            tool.unavailableReason ?? "interactive-terminal-unavailable"
          }`
        ),
        { code: "EEXECUTOR_UNAVAILABLE" }
      );
    }
    const sourceState = canonicalJson(repository.sourceState);
    const sessionId = developmentSessionId(developmentOwnerKey(ctx.caller), input.idempotencyKey);
    const ownedRootId = nativeDevelopmentOwnedRootId(tool.executorId, sessionId);
    const resourceKey = createHash("sha256")
      .update(
        canonicalJson({
          kind: "development-native-session",
          contextId,
          repositoryId: input.repositoryId,
          sourceState: repository.sourceState,
          executorId: tool.executorId,
          toolId: input.nativeTool,
          sessionId,
          ownedRootId,
        })
      )
      .digest("hex");
    return {
      selections: [
        selectedPreparedAuthoritySelection({
          capability: DEVELOPMENT_NATIVE_EXECUTE_CAPABILITY,
          resourceKey,
          requirement: requirementForPrincipals(
            ["code", "user", "host"],
            DEVELOPMENT_NATIVE_EXECUTE_CAPABILITY
          ),
          challenge: {
            title: `Open ${input.nativeTool} for ${repository.repoPath}`,
            description:
              "Launch the reviewed native tool in a disposable private tree. The tool and project code run with the local executor account's OS authority.",
            deniedReason: "Native development session was not approved",
            dedupKey: resourceKey,
            resource: {
              type: "development-native-session",
              label: "Native development session",
              value: `${repository.repoPath} · ${input.nativeTool}`,
            },
            operation: {
              kind: "runtime",
              verb: "Launch native development tool",
              object: {
                type: "development-native-session",
                label: "Native development session",
                value: `${repository.repoPath} · ${input.nativeTool}`,
              },
            },
            substance: {
              kind: "custom",
              summary: `Launch ${input.nativeTool} for ${repository.repoPath}`,
              detail:
                "The source is materialized into a private writable tree and enters semantic history only when checkpoint is explicitly requested.",
              facts: [
                { label: "Repository", value: repository.repoPath },
                { label: "Context", value: contextId },
                { label: "Exact source state", value: sourceState },
                { label: "Session", value: sessionId },
                { label: "Private tree", value: ownedRootId },
                { label: "Executor", value: tool.executorId },
                { label: "Tool", value: input.nativeTool },
                { label: "Network", value: "Tool-managed" },
              ],
            },
            allowedDecisions: ["once", "session", "deny"],
          },
        }),
      ],
      payload: null,
    };
  };

  const orchestrate = (runId: string): Promise<void> => {
    const current = running.get(runId);
    if (current) return current;
    const operation = runBuild(runId).finally(() => running.delete(runId));
    running.set(runId, operation);
    return operation;
  };

  const runBuild = async (runId: string): Promise<void> => {
    let run = deps.store.getRun(runId);
    if (!run) return;
    const plan = deps.store.getRunPlan(runId);
    try {
      if (run.state === "accepted" || run.state === "materializing") {
        if (run.state === "accepted") {
          run = deps.store.transitionRun({
            runId,
            expected: ["accepted"],
            state: "materializing",
            message: "Materializing the exact semantic snapshot",
          }).run;
        }
        await deps.executor.materialize(plan);
        run = deps.store.transitionRun({
          runId,
          expected: ["materializing"],
          state: "installing",
          commitPoint: "snapshot-retained",
          message: "Exact private source is ready; installing frozen dependencies",
        }).run;
        const injectedFault = deps.consumeSystemTestBuildFailure?.(run);
        if (injectedFault) throw injectedBuildFailure(injectedFault);
      }
      if (run.state === "installing" || run.state === "building") {
        const artifact = await deps.executor.execute(run, plan, (phase) => {
          const live = deps.store.getRun(runId);
          if (phase === "building" && live?.state === "installing") {
            deps.store.transitionRun({
              runId,
              expected: ["installing"],
              state: "building",
              message: "Building reviewed host artifacts",
            });
          }
        });
        const live = deps.store.getRun(runId);
        if (!live || live.state === "stopping") return;
        if (live.target.kind === "build-only") {
          deps.store.transitionRun({
            runId,
            expected: ["installing", "building"],
            state: "succeeded",
            commitPoint: "artifacts-verified",
            artifact: JSON.parse(canonicalJson(artifact)) as DevelopmentRun["artifact"],
            repair: null,
            terminal: true,
            message: "Exact build artifacts verified and retained",
          });
          return;
        }
        run = deps.store.transitionRun({
          runId,
          expected: ["installing", "building"],
          state: "starting",
          commitPoint: "artifacts-verified",
          artifact: JSON.parse(canonicalJson(artifact)) as DevelopmentRun["artifact"],
          repair: null,
          message: "Exact build artifacts verified; starting the reviewed target",
        }).run;
      }
      if (run.state !== "starting") return;
      if (run.target.kind === "current-host-client") {
        if (!deps.clientExecutors || !deps.mintCurrentHostInvite || !plan.clientExecutor) {
          throw Object.assign(new Error("The current-host client executor is unavailable"), {
            code: "EEXECUTOR_UNAVAILABLE",
          });
        }
        if (!run.ownerUserId) {
          throw Object.assign(
            new Error("A current-host client requires an authenticated initiating user"),
            { code: "EACCES" }
          );
        }
        const artifactSource = await deps.executor.resolveClientArtifactSource(run, plan);
        const executionDigest = run.artifact!.executionDigest;
        const invite = await deps.mintCurrentHostInvite({
          userId: run.ownerUserId,
          ttlMs: 5 * 60_000,
        });
        const launch = deps.clientExecutors.launch({
          runId,
          binding: plan.clientExecutor,
          mainEntryBuildId: artifactSource.mainEntryBuildId,
          executionDigest,
          recipeId: plan.recipe.recipeId,
          artifactSource,
          pairingDeepLink: invite.pairing.deepLink,
          onRequested(receipt) {
            run = deps.store.transitionRun({
              runId,
              expected: ["starting"],
              state: "starting",
              client: {
                requestId: receipt.requestId,
                providerId: plan.clientExecutor!.providerId,
                initiatingRuntimeId: plan.clientExecutor!.ownerRuntimeId,
                executionDigest,
                state: "launching",
                childPid: null,
                childRuntimeId: null,
                requestedAt: receipt.requestedAt,
                launchedAt: null,
                attestedAt: null,
                stoppedAt: null,
                failure: null,
              },
              message: "Selected initiating desktop is launching the exact client artifact",
            }).run;
          },
          onProviderLaunched(receipt) {
            updateClientLaunch(deps.store, runId, {
              state: "provider-launched",
              childPid: receipt.childPid,
              launchedAt: receipt.launchedAt,
            });
          },
          onChildAttested(receipt) {
            updateClientLaunch(deps.store, runId, {
              state: "child-attested",
              childRuntimeId: receipt.childRuntimeId,
              attestedAt: receipt.attestedAt,
            });
          },
          onExited(receipt) {
            recordClientExit(deps.store, runId, receipt, now());
          },
        });
        const ready = await launch.ready;
        const client = deps.store.getRun(runId)?.client;
        if (!client) {
          throw Object.assign(new Error("Development client launch state was lost"), {
            code: "ESTATE",
          });
        }
        deps.store.transitionRun({
          runId,
          expected: ["starting"],
          state: "ready",
          commitPoint: "ready",
          client: {
            ...client,
            state: "ready",
            childPid: ready.childPid,
            childRuntimeId: ready.childRuntimeId,
            launchedAt: ready.launchedAt,
            attestedAt: ready.attestedAt,
          },
          repair: null,
          message:
            "Development client is ready after exact provider launch and paired-child attestation",
        });
        return;
      }
      if (!deps.isolatedExecutor) {
        throw Object.assign(new Error("The isolated-host executor is unavailable"), {
          code: "EEXECUTOR_UNAVAILABLE",
        });
      }
      await deps.isolatedExecutor.start(run, plan, {
        onRegistered(instance) {
          run = deps.store.transitionRun({
            runId,
            expected: ["starting"],
            state: "awaiting-readiness",
            commitPoint: "instance-registered",
            instance,
            hostReadiness: "starting",
            message: "Exact isolated instance generation registered; awaiting readiness",
          }).run;
        },
        async onReady(instance) {
          run = deps.store.transitionRun({
            runId,
            expected: ["awaiting-readiness"],
            state: "awaiting-readiness",
            instance,
            hostReadiness: "ready",
            repair: null,
            message: "Exact isolated host generation is ready",
          }).run;
          if (run.target.kind === "isolated-host" && run.target.includeClient) {
            if (!deps.clientExecutors || !plan.clientExecutor || !run.ownerUserId) {
              throw Object.assign(
                new Error("The initiating desktop client executor is unavailable"),
                { code: "EEXECUTOR_UNAVAILABLE" }
              );
            }
            const artifactSource = await deps.executor.resolveClientArtifactSource(run, plan);
            const executionDigest = run.artifact!.executionDigest;
            const pairingDeepLink = await deps.isolatedExecutor!.mintClientInvite(run);
            const launch = deps.clientExecutors.launch({
              runId,
              binding: plan.clientExecutor,
              mainEntryBuildId: artifactSource.mainEntryBuildId,
              executionDigest,
              recipeId: plan.recipe.recipeId,
              artifactSource,
              pairingDeepLink,
              onRequested(receipt) {
                run = deps.store.transitionRun({
                  runId,
                  expected: ["awaiting-readiness"],
                  state: "awaiting-readiness",
                  client: {
                    requestId: receipt.requestId,
                    providerId: plan.clientExecutor!.providerId,
                    initiatingRuntimeId: plan.clientExecutor!.ownerRuntimeId,
                    executionDigest,
                    state: "launching",
                    childPid: null,
                    childRuntimeId: null,
                    requestedAt: receipt.requestedAt,
                    launchedAt: null,
                    attestedAt: null,
                    stoppedAt: null,
                    failure: null,
                  },
                  message: "Launching a client paired directly to the exact isolated host",
                }).run;
              },
              onProviderLaunched(receipt) {
                updateClientLaunch(deps.store, runId, {
                  state: "provider-launched",
                  childPid: receipt.childPid,
                  launchedAt: receipt.launchedAt,
                });
              },
              onChildAttested(receipt) {
                updateClientLaunch(deps.store, runId, {
                  state: "child-attested",
                  childRuntimeId: receipt.childRuntimeId,
                  attestedAt: receipt.attestedAt,
                });
              },
              onExited(receipt) {
                recordClientExit(deps.store, runId, receipt, now());
              },
            });
            const childReceipt = await deps.isolatedExecutor!.waitForClientAttestation(
              run,
              launch.requestId
            );
            deps.clientExecutors.acceptManagedChildAttestation(childReceipt);
            const clientReady = await launch.ready;
            const client = deps.store.getRun(runId)?.client;
            if (!client) {
              throw Object.assign(new Error("Isolated client launch state was lost"), {
                code: "ESTATE",
              });
            }
            run = deps.store.transitionRun({
              runId,
              expected: ["awaiting-readiness"],
              state: "awaiting-readiness",
              client: {
                ...client,
                state: "ready",
                childPid: clientReady.childPid,
                childRuntimeId: clientReady.childRuntimeId,
                launchedAt: clientReady.launchedAt,
                attestedAt: clientReady.attestedAt,
              },
              message:
                "Directly paired isolated client proved its exact provider and child attestation",
            }).run;
          }
          if (deps.attachedHostPublisher) {
            if (!deps.attachedHostParentId) {
              throw Object.assign(new Error("Attached-host parent identity is unavailable"), {
                code: "EATTACHED_ROUTE",
              });
            }
            const ports = deps.isolatedExecutor!.takeAttachmentPorts(run);
            const publication = await deps.attachedHostPublisher.attach({
              run,
              instance,
              parentHostId: deps.attachedHostParentId,
              authorityCeiling: requireAttachedHostCeiling(run),
              ...ports,
            });
            deps.isolatedExecutor!.retireManagementChannel(run);
            run = deps.store.transitionRun({
              runId,
              expected: ["awaiting-readiness"],
              state: "awaiting-readiness",
              attachedHost: {
                sessionId: publication.attachedHostSessionId,
                childGenerationId: publication.childGenerationId,
                authorityCeilingDigest: publication.authorityCeilingDigest,
                state: "ready",
                expiresAt: publication.expiresAt,
                attachedAt: now(),
                routeLostAt: null,
              },
              message: "Exact isolated generation attached through its signed typed route",
            }).run;
          }
          run = deps.store.transitionRun({
            runId,
            expected: ["awaiting-readiness"],
            state: "ready",
            commitPoint: "ready",
            message:
              run.target.kind === "isolated-host" && run.target.includeClient
                ? "Isolated host and directly paired client are ready"
                : "Isolated host is ready with an ordinary paired device credential",
          }).run;
        },
        onExit(code) {
          recordIsolatedExit(deps.store, runId, code, now());
        },
      });
    } catch (error) {
      const live = deps.store.getRun(runId);
      if (!live || TERMINAL.has(live.state)) return;
      const injectedFault = readInjectedBuildFailure(error);
      const diagnostic = toDiagnostic(error, now());
      if (live.state === "stopping" || errorCode(error) === "ECANCELLED") {
        safeTransition(deps.store, {
          runId,
          expected: [live.state],
          state: "stopped",
          instance: stoppedInstance(live, now()),
          terminal: true,
          message: "Build stopped and owned process exited",
        });
        return;
      }
      deps.store.appendRunEvent(
        runId,
        "diagnostic",
        injectedFault
          ? { ...diagnostic, faultId: injectedFault.faultId, phase: injectedFault.phase }
          : diagnostic,
        diagnostic.at
      );
      safeTransition(deps.store, {
        runId,
        expected: [live.state],
        state: "failed",
        ...(live.target.kind === "isolated-host"
          ? {
              instance: stoppedInstance(live, now()),
              hostReadiness: "failed" as const,
            }
          : {}),
        terminal: true,
        repair: {
          phase: live.state,
          primaryError: diagnostic,
          cleanupErrors: [],
          retryable: injectedFault !== null || isRetryableExecutionError(error),
          attention: "actionable",
          knownEffects: {
            executionRoot: live.commitPoint === "none" ? "absent" : "owned",
            process: "absent",
            artifact: live.artifact ? "retained" : "absent",
          },
        },
        message: diagnostic.message,
      });
    }
  };

  const definition: ServiceDefinition = {
    name: "development",
    description: "Exact semantic development sessions and reviewed private build execution",
    authority: { principals: ["code", "user", "host"] },
    methods: developmentMethods,
    authorityPreparation: {
      [DEVELOPMENT_OPEN_AUTHORITY_RESOLVER]: (ctx, [rawInput]) => prepareOpen(ctx, rawInput),
      [DEVELOPMENT_START_AUTHORITY_RESOLVER]: (ctx, [rawInput]) => prepareStart(ctx, rawInput),
    },
    handler: defineServiceHandler("development", developmentMethods, {
      openSession: (ctx, [input]) => openSession(ctx, input),
      getSession: (ctx, [{ sessionId }]) => visibleSession(deps.store.get(sessionId), ctx.caller),
      listSessions: (ctx, [input]) => {
        const limit = Math.max(1, Math.min(200, input?.limit ?? 50));
        const ordered = deps.store.list(developmentOwner(ctx.caller));
        const after = input?.cursor
          ? ordered.filter(
              (session) =>
                session.createdAt < input.cursor!.createdAt ||
                (session.createdAt === input.cursor!.createdAt &&
                  session.sessionId > input.cursor!.sessionId)
            )
          : ordered;
        const sessions = after.slice(0, limit);
        const last = sessions.at(-1);
        return {
          sessions,
          nextCursor:
            after.length > limit && last
              ? { createdAt: last.createdAt, sessionId: last.sessionId }
              : null,
        };
      },
      closeSession: async (ctx, [input]) => {
        const current = requireSession(deps.store.get(input.sessionId), ctx.caller);
        const activeRuns = deps.store.activeRunCount(current.sessionId);
        if (activeRuns > 0) {
          throw Object.assign(
            new Error(`Session ${current.sessionId} still has ${activeRuns} active run(s)`),
            { code: "EACTIVE_RUNS" }
          );
        }
        if (current.mode === "native-tool" && deps.native) {
          const native = await deps.native.stop(current.sessionId);
          updateNativeSession(deps.store, current, native, now());
        }
        const closing = deps.store.beginClose({ ...input, disposition: "retain-context" }, now());
        if (closing.state === "closed") return closing;
        return deps.store.update(
          current.sessionId,
          {
            state: "closed",
            contextEffect: "retained",
            primaryDiagnostic: null,
            cleanupDiagnostics: [],
            repairAttention: null,
          },
          now()
        );
      },
      destroySession: async (ctx, [input]) => {
        const current = requireSession(deps.store.get(input.sessionId), ctx.caller);
        const activeRuns = deps.store.activeRunCount(current.sessionId);
        if (activeRuns > 0) {
          throw Object.assign(
            new Error(`Session ${current.sessionId} still has ${activeRuns} active run(s)`),
            { code: "EACTIVE_RUNS" }
          );
        }
        if (current.mode === "native-tool" && deps.native) {
          const retired = await deps.native.forceRetire(current.sessionId);
          if (!retired.retired) {
            const diagnostic = toDiagnostic(
              new Error(
                retired.cleanupErrors.join("; ") || "Native session cleanup was incomplete"
              ),
              now()
            );
            return deps.store.update(
              current.sessionId,
              {
                state: "requires-repair",
                primaryDiagnostic: diagnostic,
                cleanupDiagnostics: [diagnostic],
                repairAttention: "actionable",
              },
              now()
            );
          }
        }
        const closing = deps.store.beginClose({ ...input, disposition: "destroy-context" }, now());
        if (closing.state === "closed") return closing;
        try {
          await deps.runtime.discardDevelopmentSessionContext(current.contextId);
          return deps.store.update(
            current.sessionId,
            {
              state: "closed",
              contextEffect: "absent",
              primaryDiagnostic: null,
              cleanupDiagnostics: [],
              repairAttention: null,
            },
            now()
          );
        } catch (error) {
          const diagnostic = toDiagnostic(error, now());
          return deps.store.update(
            current.sessionId,
            {
              state: "requires-repair",
              contextEffect: "unknown",
              primaryDiagnostic: diagnostic,
              cleanupDiagnostics: [diagnostic],
              repairAttention: "actionable",
            },
            now()
          );
        }
      },
      keepSessionRepair: async (ctx, [input]) => {
        const session = requireSession(deps.store.get(input.sessionId), ctx.caller);
        deps.store.recordSessionRepairIntent({ ...input, action: "keep" });
        if (session.mode === "native-tool" && deps.native) {
          const native = await deps.native.keep(session.sessionId);
          return updateNativeSession(deps.store, session, native, now());
        }
        if (session.state !== "requires-repair") return session;
        return deps.store.update(session.sessionId, { repairAttention: "kept" }, now());
      },
      retrySessionCleanup: async (ctx, [input]) => {
        const session = requireSession(deps.store.get(input.sessionId), ctx.caller);
        deps.store.recordSessionRepairIntent({ ...input, action: "retry" });
        if (session.state !== "requires-repair") return session;
        if (deps.store.activeRunCount(session.sessionId) > 0) {
          throw Object.assign(new Error(`Session ${session.sessionId} still has active runs`), {
            code: "EACTIVE_RUNS",
          });
        }
        try {
          await deps.runtime.discardDevelopmentSessionContext(session.contextId);
          return deps.store.update(
            session.sessionId,
            {
              state: "closed",
              contextEffect: "absent",
              primaryDiagnostic: null,
              cleanupDiagnostics: [],
              repairAttention: null,
            },
            now()
          );
        } catch (error) {
          const diagnostic = toDiagnostic(error, now());
          return deps.store.update(
            session.sessionId,
            {
              state: "requires-repair",
              contextEffect: "unknown",
              primaryDiagnostic: diagnostic,
              cleanupDiagnostics: [...session.cleanupDiagnostics, diagnostic],
              repairAttention: "actionable",
            },
            now()
          );
        }
      },
      forceRetireSession: async (ctx, [input]) => {
        const session = requireSession(deps.store.get(input.sessionId), ctx.caller);
        deps.store.recordSessionRepairIntent({ ...input, action: "force-retire" });
        if (deps.store.activeRunCount(session.sessionId) > 0) {
          throw Object.assign(new Error(`Session ${session.sessionId} still has active runs`), {
            code: "EACTIVE_RUNS",
          });
        }
        const nativeCleanupErrors =
          session.mode === "native-tool" && deps.native
            ? (await deps.native.forceRetire(session.sessionId)).cleanupErrors
            : [];
        try {
          await deps.runtime.discardDevelopmentSessionContext(session.contextId);
          return deps.store.update(
            session.sessionId,
            {
              state: "closed",
              contextEffect: "absent",
              primaryDiagnostic: null,
              cleanupDiagnostics: nativeCleanupErrors.map((message) =>
                toDiagnostic(new Error(message), now())
              ),
              repairAttention: null,
            },
            now()
          );
        } catch (error) {
          const diagnostic = toDiagnostic(error, now());
          return deps.store.update(
            session.sessionId,
            {
              state: "closed",
              contextEffect: "unknown",
              primaryDiagnostic: session.primaryDiagnostic ?? diagnostic,
              cleanupDiagnostics: [...session.cleanupDiagnostics, diagnostic],
              repairAttention: "kept",
            },
            now()
          );
        }
      },
      checkpoint: async (ctx, [input]) => {
        const session = requireNativeSession(
          requireSession(deps.store.get(input.sessionId), ctx.caller),
          deps.native
        );
        if (session.state !== "ready" && session.state !== "checkpointing") {
          throw Object.assign(new Error("Native development session is not checkpointable"), {
            code: "ESTATE",
          });
        }
        deps.store.update(session.sessionId, { state: "checkpointing" }, now());
        try {
          await deps.native!.checkpoint({
            sessionId: session.sessionId,
            idempotencyKey: input.idempotencyKey,
            ingress: semanticIngress(ctx),
          });
          const native = await deps.native!.inspect(session.sessionId);
          return updateNativeSession(deps.store, session, native, now());
        } catch (error) {
          const native = await deps.native!.inspect(session.sessionId).catch(() => null);
          if (native) updateNativeSession(deps.store, session, native, now());
          throw error;
        }
      },
      inspectNative: async (ctx, [input]) => {
        const session = requireNativeSession(
          requireSession(deps.store.get(input.sessionId), ctx.caller),
          deps.native
        );
        const native = await deps.native!.inspect(session.sessionId, {
          assessPendingChanges: input.assessPendingChanges ?? false,
        });
        return updateNativeSession(deps.store, session, native, now());
      },
      stopNativeTool: async (ctx, [input]) => {
        const session = requireNativeSession(
          requireSession(deps.store.get(input.sessionId), ctx.caller),
          deps.native
        );
        deps.store.recordSessionRepairIntent({
          ...input,
          action: "stop-native-tool",
        });
        const native = await deps.native!.stop(session.sessionId);
        return updateNativeSession(deps.store, session, native, now());
      },
      readNativeTerminal: (ctx, [input]) => {
        const session = requireNativeSession(
          requireSession(deps.store.get(input.sessionId), ctx.caller),
          deps.native
        );
        return deps.native!.readTerminal({
          sessionId: session.sessionId,
          ...(input.after === undefined ? {} : { after: input.after }),
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        });
      },
      writeNativeTerminal: async (ctx, [input]) => {
        const session = requireNativeSession(
          requireSession(deps.store.get(input.sessionId), ctx.caller),
          deps.native
        );
        await deps.native!.writeTerminal({
          sessionId: session.sessionId,
          writeId: input.writeId,
          data: input.data,
        });
      },
      resizeNativeTerminal: async (ctx, [input]) => {
        const session = requireNativeSession(
          requireSession(deps.store.get(input.sessionId), ctx.caller),
          deps.native
        );
        await deps.native!.resizeTerminal({
          sessionId: session.sessionId,
          columns: input.columns,
          rows: input.rows,
        });
      },
      listRecipes: () => recipes.list(),
      listNativeTools: async () =>
        Promise.all(
          (["claude-code", "system-editor"] as const).map(async (toolId) => {
            if (!deps.native) {
              return {
                toolId,
                executorId: null,
                available: false,
                unavailableReason: "Native development executor is unavailable on this host",
                interactiveTerminal: false,
              };
            }
            const tool = await deps.native.describeTool(toolId);
            return {
              toolId,
              executorId: tool.executorId,
              available: tool.available,
              unavailableReason: tool.unavailableReason ?? null,
              interactiveTerminal: tool.interactiveTerminal,
            };
          })
        ),
      start: (ctx, [input]) => {
        const session = requireSession(deps.store.get(input.sessionId), ctx.caller);
        const plan = preparedAuthorityPayload<PreparedDevelopmentBuild>(
          ctx,
          DEVELOPMENT_START_AUTHORITY_RESOLVER
        );
        if (session.state !== "ready")
          throw Object.assign(new Error("Development session is not ready"), {
            code: "ESTATE",
          });
        const existing = deps.store.getRun(input.runId);
        if (existing) {
          assertStartIntent(existing, input, ctx.caller);
          return existing;
        }
        if (
          plan.runId !== input.runId ||
          plan.snapshot.sessionId !== session.sessionId ||
          plan.recipe.recipeId !== input.recipeId
        ) {
          throw Object.assign(
            new Error("Prepared development build does not match the admitted start intent"),
            { code: "EIDEMPOTENCYDRIFT" }
          );
        }
        const at = now();
        const run: DevelopmentRun = {
          version: 1,
          runId: input.runId,
          sessionId: session.sessionId,
          ownerRuntimeId: ctx.caller.runtime.id,
          ownerRuntimeKind: ctx.caller.runtime.kind,
          ownerUserId: ctx.caller.subject?.userId ?? null,
          attachedHostAuthorityCeiling:
            input.target.kind === "isolated-host"
              ? initiatingAttachedHostCeiling(ctx, deps.attachedHostAuthorityCeiling ?? [])
              : null,
          target: input.target,
          recipe: plan.recipe,
          snapshot: plan.snapshot,
          state: "accepted",
          commitPoint: "none",
          artifact: null,
          instance: null,
          hostReadiness: input.target.kind === "isolated-host" ? "starting" : null,
          client: null,
          attachedHost: null,
          repair: null,
          createdAt: at,
          updatedAt: at,
          terminalAt: null,
        };
        const stored = deps.store.putRun(run, plan, startIntentDigest(input, ctx.caller));
        void orchestrate(stored.run.runId);
        return stored.run;
      },
      faultFailBuildAfterSnapshotRetained: (ctx, [input]) => {
        const session = requireSession(deps.store.get(input.sessionId), ctx.caller);
        const existing = deps.store.getRun(input.runId);
        if (
          existing &&
          (existing.sessionId !== session.sessionId ||
            existing.ownerRuntimeId !== ctx.caller.runtime.id ||
            existing.ownerUserId !== (ctx.caller.subject?.userId ?? null))
        ) {
          throw Object.assign(
            new Error("Build run id is already owned by another development session"),
            { code: "EIDEMPOTENCYDRIFT" }
          );
        }
        if (!deps.armSystemTestBuildFailure) {
          throw Object.assign(new Error("Build failure injection is unavailable"), {
            code: "EUNAVAILABLE",
          });
        }
        return deps.armSystemTestBuildFailure(
          ctx.caller,
          {
            sessionId: session.sessionId,
            runId: input.runId,
            ownerRuntimeId: ctx.caller.runtime.id,
            ownerUserId: ctx.caller.subject?.userId ?? null,
          },
          input.phase
        );
      },
      get: (ctx, [{ runId }]) => visibleRun(deps.store.getRun(runId), ctx.caller),
      list: (ctx, [input]) =>
        deps.store.pageRuns({
          ownerRuntimeId: ctx.caller.runtime.id,
          ownerUserId: ctx.caller.subject?.userId ?? null,
          ...(input?.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input?.state ? { state: input.state } : {}),
          ...(input?.cursor ? { cursor: input.cursor } : {}),
          ...(input?.limit ? { limit: input.limit } : {}),
        }),
      events: (ctx, [input]) => {
        const run = requireRun(deps.store.getRun(input.runId), ctx.caller);
        return deps.store.listRunEvents(run.runId, input.after, input.limit);
      },
      stop: async (ctx, [input]) => {
        let run = requireRun(deps.store.getRun(input.runId), ctx.caller);
        deps.store.recordMutationIntent({
          runId: run.runId,
          operation: "stop",
          idempotencyKey: input.idempotencyKey,
          intent: { runId: run.runId },
        });
        if (TERMINAL.has(run.state) || run.state === "requires-repair") return run;
        run = deps.store.transitionRun({
          runId: run.runId,
          expected: [run.state],
          state: "stopping",
          message: "Stopping the owned development process",
        }).run;
        try {
          let stoppedInstanceReceipt = null;
          if (run.target.kind === "current-host-client") {
            if (!deps.clientExecutors) {
              throw Object.assign(new Error("The selected client executor is unavailable"), {
                code: "EOWNERSHIP",
              });
            }
            await deps.clientExecutors.stop(run.runId);
          } else if (run.target.kind === "isolated-host" && run.instance) {
            if (run.attachedHost) {
              if (!deps.attachedHostPublisher) {
                throw Object.assign(new Error("The attached-host route owner is unavailable"), {
                  code: "EOWNERSHIP",
                });
              }
              await deps.attachedHostPublisher.close(
                run.attachedHost.sessionId,
                "development-run-stop"
              );
              run = deps.store.transitionRun({
                runId: run.runId,
                expected: ["stopping"],
                state: "stopping",
                attachedHost: {
                  ...run.attachedHost,
                  state: "closed",
                },
                message: "Attached child route closed before instance shutdown",
              }).run;
            }
            if (
              run.target.kind === "isolated-host" &&
              run.target.includeClient &&
              run.client &&
              deps.clientExecutors
            ) {
              await deps.clientExecutors.stop(run.runId);
            }
            stoppedInstanceReceipt = await deps.isolatedExecutor?.stop(run);
          }
          if (
            run.target.kind === "build-only" ||
            (run.target.kind === "isolated-host" && !run.instance)
          ) {
            await deps.executor.stop(run.runId);
          } else if (run.target.kind === "isolated-host" && !deps.isolatedExecutor) {
            throw Object.assign(new Error("The exact isolated-host supervisor is unavailable"), {
              code: "EOWNERSHIP",
            });
          }
          const active = running.get(run.runId);
          if (active) await active.catch(() => {});
          const live = deps.store.getRun(run.runId);
          if (live?.state === "stopping") {
            return deps.store.transitionRun({
              runId: run.runId,
              expected: ["stopping"],
              state: "stopped",
              instance: stoppedInstanceReceipt ?? stoppedInstance(live, now()),
              hostReadiness: live.target.kind === "isolated-host" ? "stopped" : live.hostReadiness,
              terminal: true,
              message: "Owned development process stopped",
            }).run;
          }
          return live ?? run;
        } catch (error) {
          const diagnostic = toDiagnostic(error, now());
          return deps.store.transitionRun({
            runId: run.runId,
            expected: ["stopping"],
            state: "requires-repair",
            terminal: false,
            repair: {
              phase: "stopping",
              primaryError: diagnostic,
              cleanupErrors: [diagnostic],
              retryable: false,
              attention: "actionable",
              knownEffects: {
                executionRoot: "owned",
                process: "unknown",
                artifact: run.artifact ? "retained" : "absent",
              },
            },
            message: "Process stop outcome could not be proven",
          }).run;
        }
      },
      retry: (ctx, [input]) => {
        let run = requireRun(deps.store.getRun(input.runId), ctx.caller);
        const plan = preparedAuthorityPayload<PreparedDevelopmentBuild>(
          ctx,
          DEVELOPMENT_START_AUTHORITY_RESOLVER
        );
        if (
          plan.runId !== run.runId ||
          plan.snapshot.snapshotDigest !== run.snapshot.snapshotDigest
        ) {
          throw Object.assign(
            new Error("Prepared retry does not match the retained exact snapshot"),
            { code: "EIDEMPOTENCYDRIFT" }
          );
        }
        deps.store.recordMutationIntent({
          runId: run.runId,
          operation: "repair",
          idempotencyKey: input.idempotencyKey,
          intent: { runId: run.runId, action: "retry" },
        });
        if (!run.repair?.retryable) {
          throw Object.assign(new Error("This run cannot be retried from a proven commit point"), {
            code: "ENOTRECOVERABLE",
          });
        }
        run = deps.store.transitionRun({
          runId: run.runId,
          expected: [run.state],
          state: "materializing",
          repair: null,
          message: "Retrying from the retained exact snapshot",
        }).run;
        void orchestrate(run.runId);
        return run;
      },
      keepRunRepair: async (ctx, [input]) => {
        const run = requireRun(deps.store.getRun(input.runId), ctx.caller);
        deps.store.recordMutationIntent({
          runId: run.runId,
          operation: "repair",
          idempotencyKey: input.idempotencyKey,
          intent: { runId: run.runId, action: "keep" },
        });
        if (!run.repair) return run;
        return deps.store.transitionRun({
          runId: run.runId,
          expected: [run.state],
          state: run.state,
          repair: { ...run.repair, attention: "kept" },
          message: "Repair record kept for later inspection",
        }).run;
      },
      forceRetire: async (ctx, [input]) => {
        const run = requireRun(deps.store.getRun(input.runId), ctx.caller);
        deps.store.recordMutationIntent({
          runId: run.runId,
          operation: "repair",
          idempotencyKey: input.idempotencyKey,
          intent: { runId: run.runId, action: "force-retire" },
        });
        if (run.repair?.knownEffects.process === "unknown") {
          const diagnostic = {
            code: "EOWNERSHIP_UNKNOWN",
            message:
              "The execution root was retained because no live process ownership can be proven",
            at: now(),
          };
          deps.store.appendRunEvent(run.runId, "cleanup", diagnostic, diagnostic.at);
          return deps.store.transitionRun({
            runId: run.runId,
            expected: [run.state],
            state: "requires-repair",
            terminal: false,
            repair: {
              ...run.repair,
              cleanupErrors: [...run.repair.cleanupErrors, diagnostic],
              attention: "kept",
            },
            message: "Force-retire refused the unproven process; exact resources remain retained",
          }).run;
        }
        let processEffect = run.repair?.knownEffects.process ?? "absent";
        let executionRootEffect =
          run.repair?.knownEffects.executionRoot ??
          (run.commitPoint === "none" ? "absent" : "owned");
        try {
          if (run.attachedHost && deps.attachedHostPublisher) {
            try {
              await deps.attachedHostPublisher.close(
                run.attachedHost.sessionId,
                "development-run-force-retire"
              );
            } catch (routeError) {
              const routeDiagnostic = toDiagnostic(routeError, now());
              deps.store.appendRunEvent(run.runId, "cleanup", routeDiagnostic, routeDiagnostic.at);
            }
          }
          if (run.target.kind === "isolated-host" && run.instance && processEffect === "owned") {
            if (!deps.isolatedExecutor) {
              throw Object.assign(new Error("The exact isolated-host supervisor is unavailable"), {
                code: "EOWNERSHIP",
              });
            }
            await deps.isolatedExecutor.stop(run);
            processEffect = "absent";
          }
          if (
            run.target.kind === "isolated-host" &&
            run.target.includeClient &&
            run.client &&
            deps.clientExecutors
          ) {
            await deps.clientExecutors.stop(run.runId);
          }
          await deps.executor.retire(run);
          executionRootEffect = "absent";
          return deps.store.transitionRun({
            runId: run.runId,
            expected: [run.state],
            state: "cancelled",
            artifact: null,
            repair: null,
            terminal: true,
            message: "Run and its proven owned execution root retired",
          }).run;
        } catch (error) {
          const diagnostic = toDiagnostic(error, now());
          deps.store.appendRunEvent(run.runId, "cleanup", diagnostic, diagnostic.at);
          return deps.store.transitionRun({
            runId: run.runId,
            expected: [run.state],
            state: "requires-repair",
            repair: {
              phase: "force-retire",
              primaryError: run.repair?.primaryError ?? diagnostic,
              cleanupErrors: [...(run.repair?.cleanupErrors ?? []), diagnostic],
              retryable: false,
              attention: "actionable",
              knownEffects: {
                executionRoot: executionRootEffect,
                process: processEffect,
                artifact: run.artifact ? "retained" : "absent",
              },
            },
            message: "Force-retire could not prove complete cleanup",
          }).run;
        }
      },
    }),
  };

  queueMicrotask(async () => {
    if (deps.native) {
      for (const session of deps.store.listAllSessions()) {
        if (session.mode !== "native-tool" || session.state === "closed") {
          continue;
        }
        void deps.native
          .recover(session.sessionId)
          .then((receipt) => updateNativeSession(deps.store, session, receipt, now()))
          .catch(() => undefined);
      }
    }
    for (const run of deps.store.listRuns()) {
      if (run.state === "accepted" || run.state === "materializing" || run.state === "starting") {
        void orchestrate(run.runId);
      } else if (
        run.state === "installing" ||
        run.state === "building" ||
        run.state === "stopping" ||
        run.state === "awaiting-readiness" ||
        run.state === "ready"
      ) {
        if (
          run.target.kind === "isolated-host" &&
          (run.state === "awaiting-readiness" || run.state === "ready") &&
          deps.isolatedExecutor
        ) {
          const recovery = await deps.isolatedExecutor.recover(run, (code) =>
            recordIsolatedExit(deps.store, run.runId, code, now())
          );
          if (recovery === "owned") {
            if (run.attachedHost) {
              const routeRecovery = deps.attachedHostPublisher
                ? await deps.attachedHostPublisher.recover(
                    run.attachedHost.sessionId,
                    run.instance!.generationId
                  )
                : "generation-lost";
              if (routeRecovery === "generation-lost") {
                const diagnostic = {
                  code: "EATTACHED_ROUTE_LOST",
                  message:
                    "The exact isolated host was reattached, but its signed attached route generation was lost",
                  at: now(),
                };
                safeTransition(deps.store, {
                  runId: run.runId,
                  expected: [run.state],
                  state: "requires-repair",
                  attachedHost: {
                    ...run.attachedHost,
                    state: "route-lost",
                    routeLostAt: diagnostic.at,
                  },
                  repair: {
                    phase: "startup-recovery",
                    primaryError: diagnostic,
                    cleanupErrors: [],
                    retryable: false,
                    attention: "actionable",
                    knownEffects: {
                      executionRoot: "owned",
                      process: "owned",
                      artifact: run.artifact ? "retained" : "absent",
                    },
                  },
                  message: diagnostic.message,
                });
                continue;
              }
            }
            if (!run.target.includeClient) continue;
            const diagnostic = {
              code: "ERECOVERY_CLIENT_OWNERSHIP",
              message:
                "The exact isolated host was reattached, but the initiating desktop client process could not be proven after restart",
              at: now(),
            };
            safeTransition(deps.store, {
              runId: run.runId,
              expected: [run.state],
              state: "requires-repair",
              repair: {
                phase: "startup-recovery",
                primaryError: diagnostic,
                cleanupErrors: [],
                retryable: false,
                attention: "actionable",
                knownEffects: {
                  executionRoot: "owned",
                  process: "unknown",
                  artifact: run.artifact ? "retained" : "absent",
                },
              },
              message: diagnostic.message,
            });
            continue;
          }
          if (recovery === "stopped" || recovery === "absent") {
            const diagnostic = {
              code: "ERECOVERY_STOPPED",
              message: `Server restarted while run was ${run.state}; the exact incomplete child was stopped`,
              at: now(),
            };
            safeTransition(deps.store, {
              runId: run.runId,
              expected: [run.state],
              state: "failed",
              terminal: true,
              instance: stoppedInstance(run, now()),
              repair: {
                phase: "startup-recovery",
                primaryError: diagnostic,
                cleanupErrors: [],
                retryable: false,
                attention: "actionable",
                knownEffects: {
                  executionRoot: "owned",
                  process: "absent",
                  artifact: run.artifact ? "retained" : "absent",
                },
              },
              message: diagnostic.message,
            });
            continue;
          }
        }
        const diagnostic = {
          code: "ERECOVERY_OWNERSHIP",
          message: `Server restarted while run was ${run.state}; child process ownership is unknown`,
          at: now(),
        };
        safeTransition(deps.store, {
          runId: run.runId,
          expected: [run.state],
          state: "requires-repair",
          repair: {
            phase: "startup-recovery",
            primaryError: diagnostic,
            cleanupErrors: [],
            retryable: false,
            attention: "actionable",
            knownEffects: {
              executionRoot: "owned",
              process: "unknown",
              artifact: run.artifact ? "retained" : "absent",
            },
          },
          message: diagnostic.message,
        });
      }
    }
  });

  return definition;
}

async function discardAfterRejectedOpen(
  runtime: RuntimeServiceInternal,
  contextId: string,
  primary?: unknown
): Promise<void> {
  try {
    await runtime.discardDevelopmentSessionContext(contextId);
  } catch (cleanup) {
    const primaryDiagnostic = primary
      ? { code: errorCode(primary), message: errorMessage(primary) }
      : {
          code: "EDEVELOPMENT_ADMISSION",
          message: "Development-session admission was rejected",
        };
    throw Object.assign(new Error(primaryDiagnostic.message), {
      code: primaryDiagnostic.code,
      cause: primary,
      primaryDiagnostic,
      cleanupDiagnostic: { code: errorCode(cleanup), message: errorMessage(cleanup) },
    });
  }
}

function assertStartIntent(
  run: DevelopmentRun,
  input: {
    sessionId: string;
    runId: string;
    recipeId: string;
    target: DevelopmentTarget;
  },
  caller: VerifiedCaller
): void {
  if (
    !ownerMatches(run.ownerRuntimeId, run.ownerUserId, caller) ||
    run.sessionId !== input.sessionId ||
    run.recipe.recipeId !== input.recipeId ||
    canonicalJson(run.target) !== canonicalJson(input.target)
  ) {
    throw Object.assign(new Error("Run id was reused with different intent"), {
      code: "EIDEMPOTENCYDRIFT",
    });
  }
}

function developmentOwner(caller: VerifiedCaller): {
  runtimeId: string;
  userId: string | null;
} {
  return {
    runtimeId: caller.runtime.id,
    userId: caller.subject?.userId ?? null,
  };
}

function developmentOwnerKey(caller: VerifiedCaller): string {
  const owner = developmentOwner(caller);
  return owner.userId ? `user:${owner.userId}` : `runtime:${owner.runtimeId}`;
}

function ownerMatches(
  ownerRuntimeId: string,
  ownerUserId: string | null,
  caller: VerifiedCaller
): boolean {
  return ownerUserId
    ? ownerUserId === (caller.subject?.userId ?? null)
    : ownerRuntimeId === caller.runtime.id;
}

function startIntentDigest(input: unknown, caller: VerifiedCaller): string {
  return createHash("sha256")
    .update(canonicalJson({ ownerKey: developmentOwnerKey(caller), input }))
    .digest("hex");
}

export function developmentNativeResourceKey(input: {
  contextId: string;
  repositoryId: string;
  baseState: DevelopmentSession["basis"]["childBaseState"];
  executorId: string;
  recipeId: string;
  lockfileDigest: string;
  network: "approved-registry";
  target: DevelopmentTarget;
  clientExecutor: PreparedDevelopmentBuild["clientExecutor"] | null;
}): string {
  return [
    "development",
    `context=${encodeURIComponent(input.contextId)}`,
    `repository=${encodeURIComponent(input.repositoryId)}`,
    `base=${encodeURIComponent(formatState(input.baseState))}`,
    `executor=${input.executorId}`,
    `recipe=${encodeURIComponent(input.recipeId)}`,
    `lockfiles=${input.lockfileDigest}`,
    `network=${input.network}`,
    `target=${encodeURIComponent(canonicalJson(input.target))}`,
    `clientExecutor=${encodeURIComponent(canonicalJson(input.clientExecutor))}`,
  ].join("/");
}

function needsClientExecutor(target: DevelopmentTarget): boolean {
  return (
    target.kind === "current-host-client" ||
    (target.kind === "isolated-host" && target.includeClient)
  );
}

function developmentTargetLabel(target: DevelopmentTarget): string {
  if (target.kind === "build-only") return "Build only";
  if (target.kind === "current-host-client") return "Electron client on the initiating device";
  return target.includeClient ? "Isolated host and client" : "Isolated host";
}

function formatState(state: DevelopmentSession["basis"]["childBaseState"]): string {
  return state.kind === "event" ? `event:${state.eventId}` : `application:${state.applicationId}`;
}

function semanticIngress(ctx: ServiceContext): NativeDevelopmentSemanticIngress {
  const integrity = ctx.authorization?.contextIntegrity;
  if (!integrity) {
    throw Object.assign(
      new Error("Native development mutation requires verified context-integrity ingress"),
      { code: "EACCES" }
    );
  }
  return {
    causalParent: ctx.causalParent ?? null,
    contextIntegrity:
      integrity.class === "external"
        ? { class: "external", externalKeys: [...integrity.externalKeys] }
        : { class: "internal", externalKeys: [] },
  };
}

function nativeSessionRecord(
  receipt: NativeDevelopmentSessionReceipt
): NonNullable<DevelopmentSession["native"]> {
  return {
    ownedRootId: receipt.ownedRootId,
    executorId: receipt.executorId,
    toolId: receipt.toolId,
    repoPath: receipt.repoPath,
    baseEvent: receipt.baseEvent,
    baseSnapshotRevision: receipt.baseSnapshotRevision,
    state: receipt.state,
    process: receipt.process,
    lastCheckpoint: receipt.lastCheckpoint,
    pendingChanges: receipt.pendingChanges,
    repair: receipt.repair,
  };
}

function requireNativeSession(
  session: DevelopmentSession,
  native: NativeDevelopmentController | undefined
): DevelopmentSession {
  if (session.mode !== "native-tool" || !session.nativeTool || !native) {
    throw Object.assign(new Error("Development session is not a native-tool session"), {
      code: "ESTATE",
    });
  }
  return session;
}

function updateNativeSession(
  store: DevelopmentSessionStore,
  session: DevelopmentSession,
  receipt: NativeDevelopmentSessionReceipt,
  at: number
): DevelopmentSession {
  const primaryDiagnostic = receipt.repair
    ? toDiagnostic(new Error(receipt.repair.primaryError), at)
    : null;
  return store.update(
    session.sessionId,
    {
      state:
        receipt.state === "requires-repair"
          ? "requires-repair"
          : receipt.state === "checkpointing"
            ? "checkpointing"
            : session.state === "closed"
              ? "closed"
              : "ready",
      native: nativeSessionRecord(receipt),
      primaryDiagnostic,
      cleanupDiagnostics:
        receipt.repair?.cleanupErrors.map((message) => toDiagnostic(new Error(message), at)) ?? [],
      repairAttention: receipt.repair?.attention ?? null,
    },
    at
  );
}

function safeTransition(
  store: DevelopmentSessionStore,
  input: Parameters<DevelopmentSessionStore["transitionRun"]>[0]
): void {
  try {
    store.transitionRun(input);
  } catch (error) {
    if (errorCode(error) !== "ESTATE") throw error;
  }
}

function updateClientLaunch(
  store: DevelopmentSessionStore,
  runId: string,
  update: Partial<
    Pick<
      NonNullable<DevelopmentRun["client"]>,
      "state" | "childPid" | "childRuntimeId" | "launchedAt" | "attestedAt"
    >
  >
): void {
  const run = store.getRun(runId);
  if (!run?.client || TERMINAL.has(run.state) || run.state === "requires-repair") return;
  const current = run.client;
  const state =
    current.state === "provider-launched" && update.state === "child-attested"
      ? "provider-launched"
      : current.state === "child-attested" && update.state === "provider-launched"
        ? "child-attested"
        : (update.state ?? current.state);
  safeTransition(store, {
    runId,
    expected: [run.state],
    state: run.state,
    client: { ...current, ...update, state },
    message:
      update.state === "provider-launched"
        ? "Initiating desktop reported the exact owned client process"
        : "Newly paired child reported the opaque launch nonce",
  });
}

function recordClientExit(
  store: DevelopmentSessionStore,
  runId: string,
  receipt: {
    unexpected: boolean;
    cleanupError?: string;
    exitedAt: number;
  },
  at: number
): void {
  const run = store.getRun(runId);
  if (!run?.client || TERMINAL.has(run.state) || run.state === "requires-repair") return;
  const failed = receipt.unexpected || Boolean(receipt.cleanupError);
  const diagnostic = failed
    ? {
        code: receipt.cleanupError ? "ECLIENT_CLEANUP" : "ECLIENT_EXIT",
        message:
          receipt.cleanupError ??
          "Development client exited before an intentional stop was requested",
        at,
      }
    : null;
  if (receipt.unexpected) {
    safeTransition(store, {
      runId,
      expected: [run.state],
      state: "failed",
      terminal: true,
      client: {
        ...run.client,
        state: "failed",
        stoppedAt: receipt.exitedAt,
        failure: diagnostic,
      },
      repair: {
        phase: "client-runtime",
        primaryError: diagnostic!,
        cleanupErrors: receipt.cleanupError ? [diagnostic!] : [],
        retryable: false,
        attention: "actionable",
        knownEffects: {
          executionRoot: receipt.cleanupError ? "unknown" : "owned",
          process: "absent",
          artifact: run.artifact ? "retained" : "absent",
        },
      },
      message: diagnostic!.message,
    });
    return;
  }
  safeTransition(store, {
    runId,
    expected: [run.state],
    state: run.state,
    client: {
      ...run.client,
      state: receipt.cleanupError ? "failed" : "stopped",
      stoppedAt: receipt.exitedAt,
      failure: diagnostic,
    },
    message: receipt.cleanupError
      ? "Client exited but its exact owned root cleanup failed"
      : "Owned development client exited and its private root was removed",
  });
}

function stoppedInstance(run: DevelopmentRun, at: number): DevelopmentRun["instance"] | undefined {
  return run.instance ? { ...run.instance, state: "stopped", stoppedAt: at } : undefined;
}

function isRetryableExecutionError(error: unknown): boolean {
  return !new Set([
    "EARTIFACT_DRIFT",
    "EEXECUTOR_UNAVAILABLE",
    "ETOOLCHAIN_DRIFT",
    "EUNSUPPORTED_TARGET",
  ]).has(errorCode(error));
}

function injectedBuildFailure(fault: SystemTestBuildFault): Error {
  return Object.assign(
    new Error(
      `System-test injected build failure ${fault.faultId} after the retained exact snapshot`
    ),
    {
      code: "ESYSTEMTEST_INJECTED_BUILD",
      systemTestBuildFault: fault,
    }
  );
}

function readInjectedBuildFailure(error: unknown): SystemTestBuildFault | null {
  if (
    typeof error !== "object" ||
    error === null ||
    (error as { code?: unknown }).code !== "ESYSTEMTEST_INJECTED_BUILD"
  ) {
    return null;
  }
  const fault = (error as { systemTestBuildFault?: unknown }).systemTestBuildFault;
  if (
    !fault ||
    typeof fault !== "object" ||
    typeof (fault as { faultId?: unknown }).faultId !== "string" ||
    typeof (fault as { runId?: unknown }).runId !== "string" ||
    (fault as { phase?: unknown }).phase !== "after-snapshot-retained"
  ) {
    return null;
  }
  return fault as SystemTestBuildFault;
}

function recordIsolatedExit(
  store: DevelopmentSessionStore,
  runId: string,
  code: number,
  at: number
): void {
  const run = store.getRun(runId);
  if (
    !run ||
    TERMINAL.has(run.state) ||
    run.state === "requires-repair" ||
    run.state === "stopping"
  ) {
    return;
  }
  const instance = stoppedInstance(run, at);
  if (code === 0) {
    safeTransition(store, {
      runId,
      expected: [run.state],
      state: "stopped",
      ...(instance ? { instance } : {}),
      hostReadiness: "stopped",
      terminal: true,
      message: "Isolated host exited cleanly",
    });
    return;
  }
  const diagnostic = {
    code: "EISOLATED_HOST_EXIT",
    message: `Isolated host exited unexpectedly with code ${code}`,
    at,
  };
  store.appendRunEvent(runId, "diagnostic", diagnostic, at);
  safeTransition(store, {
    runId,
    expected: [run.state],
    state: "failed",
    ...(instance ? { instance } : {}),
    hostReadiness: "failed",
    repair: {
      phase: run.state,
      primaryError: diagnostic,
      cleanupErrors: [],
      retryable: true,
      attention: "actionable",
      knownEffects: {
        executionRoot: "owned",
        process: "absent",
        artifact: run.artifact ? "retained" : "absent",
      },
    },
    terminal: true,
    message: diagnostic.message,
  });
}

function toDiagnostic(error: unknown, at: number): { code: string; message: string; at: number } {
  return { code: errorCode(error), message: errorMessage(error), at };
}

function errorCode(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "EDEVELOPMENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initiatingAttachedHostCeiling(
  ctx: ServiceContext,
  interactiveCeiling: readonly CapabilityScope[]
): CapabilityScope[] {
  const inherited: (readonly CapabilityScope[])[] = [];
  if (ctx.attachedHost) inherited.push(ctx.attachedHost.authorityCeiling);
  if (ctx.caller.executionSession) {
    inherited.push(ctx.caller.executionSession.eval.authorityManifest.requests);
  } else if (ctx.caller.code) {
    inherited.push(ctx.caller.code.requested ?? []);
  }
  const selected =
    inherited.length === 0
      ? interactiveCeiling
      : inherited.reduce((left, right) => intersectAuthorityCeilings(left, right));
  return selected.map((scope) => ({
    capability: scope.capability,
    resource: { ...scope.resource },
  }));
}

function intersectAuthorityCeilings(
  left: readonly CapabilityScope[],
  right: readonly CapabilityScope[]
): readonly CapabilityScope[] {
  const intersection: CapabilityScope[] = [];
  for (const leftScope of left) {
    for (const rightScope of right) {
      if (scopeContains(leftScope, rightScope)) {
        intersection.push(rightScope);
      } else if (scopeContains(rightScope, leftScope)) {
        intersection.push(leftScope);
      }
    }
  }
  return intersection;
}

function requireAttachedHostCeiling(run: DevelopmentRun): readonly CapabilityScope[] {
  if (!run.attachedHostAuthorityCeiling) {
    throw Object.assign(new Error("Attached-host initiating authority ceiling is unavailable"), {
      code: "EATTACHED_CEILING",
    });
  }
  return run.attachedHostAuthorityCeiling;
}
