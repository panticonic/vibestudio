import type { NativeTerminalSnapshot } from "./nativeTerminal.js";
import {
  developmentNativeMethods,
  type nativeDevelopmentSessionReceiptSchema,
} from "@vibestudio/service-schemas/developmentNative";
import type {
  DevelopmentRecipe,
  DevelopmentRun,
  DevelopmentSession,
  DevelopmentTarget,
} from "@vibestudio/service-schemas/development";
import type { VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import type { z } from "zod";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import {
  verifiedInitiatingUserId,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import type { CapabilityScope } from "@vibestudio/rpc";
import { serializeRpcFailure, type RpcFailure } from "@vibestudio/rpc";
import type { DevelopmentExecutor, PreparedDevelopmentBuild } from "./developmentExecutor.js";
import type { IsolatedDevelopmentHostExecutor } from "./isolatedDevelopmentHostExecutor.js";
import type { DevelopmentClientExecutorRegistry } from "./developmentClientExecutorService.js";
import type { AttachedHostPublisher } from "./attachedHostController.js";
import type {
  NativeDevelopmentCheckpointReceipt,
  NativeDevelopmentSemanticIngress,
  NativeDevelopmentSessionReceipt,
  NativeDevelopmentToolId,
} from "./nativeDevelopmentExecutor.js";
import type { TemplateRepositoryExchangeExecutor } from "./templateRepositoryExchangeExecutor.js";

export interface ExactNativeDevelopmentController {
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
  close(): Promise<void>;
  recover(sessionId: string): Promise<NativeDevelopmentSessionReceipt>;
  keep(sessionId: string): Promise<NativeDevelopmentSessionReceipt>;
  forceRetire(sessionId: string): Promise<{
    retired: boolean;
    cleanupFailures: import("@vibestudio/rpc").RpcFailure[];
  }>;
  readTerminal(input: {
    sessionId: string;
    after?: number;
    maxBytes?: number;
  }): Promise<NativeTerminalSnapshot>;
  writeTerminal(input: { sessionId: string; sequence: number; data: string }): Promise<void>;
  resizeTerminal(input: { sessionId: string; columns: number; rows: number }): Promise<void>;
}

type NativeSessionReceipt = z.infer<typeof nativeDevelopmentSessionReceiptSchema>;
type NativeTargetFields = Pick<
  DevelopmentRun,
  "artifact" | "instance" | "hostReadiness" | "client" | "attachedHost"
>;
type NativeBuildState = {
  snapshotDigest: string;
  run: DevelopmentRun;
  lifetime: AbortController;
  settled: Promise<void>;
  stop: Promise<NativeTargetFields> | null;
  phases: Array<"installing" | "building">;
  result:
    | { state: "running" }
    | ({ state: "succeeded" | "ready" | "stopped" } & NativeTargetFields)
    | ({ state: "failed"; error: RpcFailure } & NativeTargetFields);
};

/**
 * Exact host-native development effects.
 *
 * This service deliberately owns no sessions, runs, recipes, pagination, repair
 * policy, or target selection. Its in-memory plan cache is an execution handle:
 * callers must present the exact run and snapshot identity on every effect.
 */
export function createDevelopmentNativeService(deps: {
  native: ExactNativeDevelopmentController;
  executor: Pick<
    DevelopmentExecutor,
    "prepareExact" | "materialize" | "execute" | "stop" | "retire" | "resolveClientArtifactSource"
  >;
  isolatedExecutor?: Pick<
    IsolatedDevelopmentHostExecutor,
    | "start"
    | "stop"
    | "mintClientInvite"
    | "waitForClientAttestation"
    | "takeAttachmentPorts"
    | "retireManagementChannel"
  >;
  clientExecutors?: Pick<
    DevelopmentClientExecutorRegistry,
    "list" | "select" | "launch" | "stop" | "acceptManagedChildAttestation"
  >;
  resolveClientExecutorRuntime?: (ctx: ServiceContext) => string | null;
  mintCurrentHostInvite?: (input: {
    userId: string;
    ttlMs: number;
  }) => Promise<{ pairing: { deepLink: string } }>;
  attachedHostPublisher?: AttachedHostPublisher;
  attachedHostParentId?: string;
  attachedHostAuthorityCeiling?: readonly CapabilityScope[];
  takeLogs?: (runId: string) => Array<{ stream: "stdout" | "stderr"; line: string }>;
  templateExchange?: Pick<TemplateRepositoryExchangeExecutor, "prepare" | "apply">;
  /**
   * Read one repository's presence in an exact semantic context.
   *
   * The development builtin decides whether a repository is adopted before it
   * forks anything, which means reading the session owner's context — outside
   * its own reachable context graph, and refused by the workspace-source
   * receiver to every principal but the host. Its semantic writes are already
   * host-mediated; this is the matching read.
   */
  resolveAdoptedRepository?: (input: {
    contextId: string;
    repositoryId: string;
  }) => Promise<{ repoPath: string; workingHead: VcsStateNodeRef } | null>;
}): { definition: ServiceDefinition; close(): Promise<void> } {
  const plans = new Map<string, { plan: PreparedDevelopmentBuild; ownerRuntimeId: string }>();
  const builds = new Map<string, NativeBuildState>();
  const admissions = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | null = null;

  const ownedPlan = (ctx: ServiceContext, runId: string): PreparedDevelopmentBuild => {
    const handle = plans.get(runId);
    if (!handle || handle.ownerRuntimeId !== ctx.caller.runtime.id) {
      throw Object.assign(new Error("The caller does not own this native build handle"), {
        code: "EOWNERSHIP",
      });
    }
    return handle.plan;
  };

  const requirePlan = (ctx: ServiceContext, run: DevelopmentRun): PreparedDevelopmentBuild => {
    const plan = ownedPlan(ctx, run.runId);
    if (
      plan.snapshot.snapshotDigest !== run.snapshot.snapshotDigest ||
      plan.recipe.reviewDigest !== run.recipe.reviewDigest
    ) {
      throw Object.assign(
        new Error("The exact native build handle is absent or does not match the retained run"),
        { code: "EEXECUTION_HANDLE" }
      );
    }
    return plan;
  };

  const stopNativeBuild = (build: NativeBuildState): Promise<NativeTargetFields> =>
    (build.stop ??= (async () => {
      build.lifetime.abort(new Error(`Development run ${build.run.runId} was stopped`));
      const stopTargets = async () => {
        if (needsClientExecutor(build.run.target)) {
          await deps.clientExecutors?.stop(build.run.runId);
          if (build.run.client)
            build.run = {
              ...build.run,
              client: { ...build.run.client, state: "stopped", stoppedAt: Date.now() },
            };
        }
        if (build.run.attachedHost && build.run.attachedHost.state !== "closed") {
          if (!deps.attachedHostPublisher)
            throw new Error("Owned attached route has no lifecycle publisher");
          await deps.attachedHostPublisher.close(
            build.run.attachedHost.sessionId,
            "development-run-stopped"
          );
          build.run = {
            ...build.run,
            attachedHost: { ...build.run.attachedHost, state: "closed" },
          };
        }
        if (build.run.instance && build.run.instance.state !== "stopped") {
          const instance = await deps.isolatedExecutor?.stop(build.run);
          if (instance) build.run = { ...build.run, instance };
        }
      };
      await deps.executor.stop(build.run.runId);
      await stopTargets();
      // Materialization and launch own writers too. Their cancellation must
      // settle before retirement can remove the root or forget its handles.
      await build.settled;
      await stopTargets();
      const receipt: NativeTargetFields = {
        artifact: build.run.artifact,
        instance: build.run.instance,
        hostReadiness: build.run.target.kind === "isolated-host" ? "stopped" : null,
        client: build.run.client,
        attachedHost: build.run.attachedHost,
      };
      build.result = { state: "stopped", ...receipt };
      return receipt;
    })().catch((error: unknown) => {
      build.stop = null;
      throw error;
    }));

  const launchTarget = async (
    run: DevelopmentRun & { artifact: NonNullable<DevelopmentRun["artifact"]> },
    plan: PreparedDevelopmentBuild,
    build: NativeBuildState
  ): Promise<void> => {
    if (run.target.kind === "client-device") {
      if (
        !deps.clientExecutors ||
        !deps.mintCurrentHostInvite ||
        !plan.clientExecutor ||
        !run.ownerUserId
      ) {
        throw Object.assign(new Error("The selected client-device executor is unavailable"), {
          code: "EEXECUTOR_UNAVAILABLE",
        });
      }
      const artifactSource = await deps.executor.resolveClientArtifactSource(run, plan);
      build.lifetime.signal.throwIfAborted();
      const invite = await deps.mintCurrentHostInvite({
        userId: run.ownerUserId,
        ttlMs: 5 * 60_000,
      });
      build.lifetime.signal.throwIfAborted();
      let client: DevelopmentRun["client"] = null;
      const launch = deps.clientExecutors.launch({
        runId: run.runId,
        binding: plan.clientExecutor,
        mainEntryBuildId: artifactSource.mainEntryBuildId,
        executionDigest: run.artifact.executionDigest,
        recipeId: plan.recipe.recipeId,
        artifactSource,
        pairingDeepLink: invite.pairing.deepLink,
        onRequested(receipt) {
          client = {
            requestId: receipt.requestId,
            providerId: plan.clientExecutor!.providerId,
            initiatingRuntimeId: plan.clientExecutor!.ownerRuntimeId,
            executionDigest: run.artifact.executionDigest,
            state: "launching",
            childPid: null,
            childRuntimeId: null,
            requestedAt: receipt.requestedAt,
            launchedAt: null,
            attestedAt: null,
            stoppedAt: null,
            failure: null,
          };
          build.run = { ...build.run, client };
        },
        onProviderLaunched(receipt) {
          if (client) {
            client = {
              ...client,
              state: "provider-launched",
              childPid: receipt.childPid,
              launchedAt: receipt.launchedAt,
            };
            build.run = { ...build.run, client };
          }
        },
        onChildAttested(receipt) {
          if (client) {
            client = {
              ...client,
              state: "child-attested",
              childRuntimeId: receipt.childRuntimeId,
              attestedAt: receipt.attestedAt,
            };
            build.run = { ...build.run, client };
          }
        },
      });
      const ready = await launch.ready;
      build.lifetime.signal.throwIfAborted();
      const launchedClient = client as NonNullable<DevelopmentRun["client"]> | null;
      if (!launchedClient) throw new Error("Development client launch state was lost");
      build.result = {
        state: "ready",
        artifact: run.artifact,
        instance: null,
        hostReadiness: null,
        client: {
          ...launchedClient,
          state: "ready",
          childPid: ready.childPid,
          childRuntimeId: ready.childRuntimeId,
          launchedAt: ready.launchedAt,
          attestedAt: ready.attestedAt,
        },
        attachedHost: null,
      };
      build.run = { ...build.run, ...build.result };
      return;
    }
    if (!deps.isolatedExecutor) {
      throw Object.assign(new Error("The isolated-host executor is unavailable"), {
        code: "EEXECUTOR_UNAVAILABLE",
      });
    }
    let instance: DevelopmentRun["instance"] = null;
    let client: DevelopmentRun["client"] = null;
    let attachedHost: DevelopmentRun["attachedHost"] = null;
    await deps.isolatedExecutor.start(run, plan, {
      onRegistered(receipt) {
        build.lifetime.signal.throwIfAborted();
        instance = receipt;
        build.run = { ...build.run, instance: receipt };
      },
      async onReady(receipt) {
        build.lifetime.signal.throwIfAborted();
        instance = receipt;
        build.run = { ...build.run, instance: receipt };
        if (run.target.kind === "isolated-host" && run.target.includeClient) {
          if (!deps.clientExecutors || !plan.clientExecutor || !run.ownerUserId) {
            throw Object.assign(new Error("The selected client-device executor is unavailable"), {
              code: "EEXECUTOR_UNAVAILABLE",
            });
          }
          const artifactSource = await deps.executor.resolveClientArtifactSource(run, plan);
          const pairingDeepLink = await deps.isolatedExecutor!.mintClientInvite(run);
          build.lifetime.signal.throwIfAborted();
          const launch = deps.clientExecutors.launch({
            runId: run.runId,
            binding: plan.clientExecutor,
            mainEntryBuildId: artifactSource.mainEntryBuildId,
            executionDigest: run.artifact.executionDigest,
            recipeId: plan.recipe.recipeId,
            artifactSource,
            pairingDeepLink,
            onRequested(requested) {
              client = {
                requestId: requested.requestId,
                providerId: plan.clientExecutor!.providerId,
                initiatingRuntimeId: plan.clientExecutor!.ownerRuntimeId,
                executionDigest: run.artifact.executionDigest,
                state: "launching",
                childPid: null,
                childRuntimeId: null,
                requestedAt: requested.requestedAt,
                launchedAt: null,
                attestedAt: null,
                stoppedAt: null,
                failure: null,
              };
              build.run = { ...build.run, client };
            },
          });
          const child = await deps.isolatedExecutor!.waitForClientAttestation(
            run,
            launch.requestId,
            build.lifetime.signal
          );
          deps.clientExecutors.acceptManagedChildAttestation(child);
          const ready = await launch.ready;
          build.lifetime.signal.throwIfAborted();
          if (!client) throw new Error("Isolated client launch state was lost");
          client = {
            ...client,
            state: "ready",
            childPid: ready.childPid,
            childRuntimeId: ready.childRuntimeId,
            launchedAt: ready.launchedAt,
            attestedAt: ready.attestedAt,
          };
          build.run = { ...build.run, client };
        }
        if (deps.attachedHostPublisher && deps.attachedHostParentId) {
          const ports = deps.isolatedExecutor!.takeAttachmentPorts(run);
          const publication = await deps.attachedHostPublisher.attach({
            run,
            instance: receipt,
            parentHostId: deps.attachedHostParentId,
            authorityCeiling: initiatingAttachedHostCeiling(
              run,
              deps.attachedHostAuthorityCeiling ?? []
            ),
            ...ports,
          });
          deps.isolatedExecutor!.retireManagementChannel(run);
          attachedHost = {
            sessionId: publication.attachedHostSessionId,
            childGenerationId: publication.childGenerationId,
            authorityCeilingDigest: publication.authorityCeilingDigest,
            state: "ready",
            expiresAt: publication.expiresAt,
            attachedAt: Date.now(),
            routeLostAt: null,
          };
          build.run = { ...build.run, attachedHost };
        }
        build.lifetime.signal.throwIfAborted();
        build.result = {
          state: "ready",
          artifact: run.artifact,
          instance,
          hostReadiness: "ready",
          client,
          attachedHost,
        };
        build.run = { ...build.run, ...build.result };
      },
      onExit(code, stoppedInstance) {
        build.run = { ...build.run, instance: stoppedInstance };
        if (build.result.state === "ready" && code !== 0) {
          build.result = {
            state: "failed",
            error: serializeRpcFailure(
              new Error(`Isolated host exited with code ${code}`),
              "application"
            ),
            artifact: run.artifact,
            instance: stoppedInstance,
            hostReadiness: "failed",
            client,
            attachedHost,
          };
        }
      },
    });
  };

  const definition: ServiceDefinition = {
    name: "developmentNative",
    description: "Exact local build, process, and terminal effects for the development builtin",
    authority: { principals: ["host", "code"] },
    methods: developmentNativeMethods,
    handler: defineServiceHandler("developmentNative", developmentNativeMethods, {
      describeHost: () => ({ platform: process.platform, arch: process.arch }),
      resolveAdoptedRepository: async (_ctx, [input]) => {
        if (!deps.resolveAdoptedRepository) {
          throw Object.assign(new Error("This host cannot read adopted development repositories"), {
            code: "EEXECUTOR_UNAVAILABLE",
          });
        }
        return deps.resolveAdoptedRepository(input);
      },
      listClientExecutors: (ctx) => {
        const ownerUserId = verifiedInitiatingUserId(ctx);
        if (!ownerUserId || !deps.clientExecutors) return [];
        const currentExecutorId = deps.resolveClientExecutorRuntime?.(ctx) ?? null;
        return deps.clientExecutors.list(ownerUserId).map((executor) => ({
          executorId: executor.ownerRuntimeId,
          providerId: executor.providerId,
          platform: executor.platform,
          arch: executor.arch,
          current: executor.ownerRuntimeId === currentExecutorId,
        }));
      },
      describeTool: (_ctx, [toolId]) => deps.native.describeTool(toolId),
      openTool: (ctx, [input]) =>
        deps.native.open({
          ...input,
          ingress: semanticIngress(ctx),
        }) as Promise<NativeSessionReceipt>,
      checkpointTool: (ctx, [input]) =>
        deps.native.checkpoint({
          ...input,
          ingress: semanticIngress(ctx),
        }),
      inspectTool: (_ctx, [input]) =>
        deps.native.inspect(input.sessionId, {
          assessPendingChanges: input.assessPendingChanges ?? false,
        }) as Promise<NativeSessionReceipt>,
      stopTool: (_ctx, [input]) =>
        deps.native.stop(input.sessionId) as Promise<NativeSessionReceipt>,
      recoverTool: (_ctx, [input]) =>
        deps.native.recover(input.sessionId) as Promise<NativeSessionReceipt>,
      keepTool: (_ctx, [input]) =>
        deps.native.keep(input.sessionId) as Promise<NativeSessionReceipt>,
      retireTool: (_ctx, [input]) => deps.native.forceRetire(input.sessionId),
      readTerminal: (_ctx, [input]) => deps.native.readTerminal(input),
      writeTerminal: async (_ctx, [input]) => {
        await deps.native.writeTerminal(input);
      },
      resizeTerminal: async (_ctx, [input]) => {
        await deps.native.resizeTerminal(input);
      },
      prepareBuild: async (ctx, [{ session, runId, recipe, pair, target }]) => {
        if (plans.has(runId)) ownedPlan(ctx, runId);
        const plan = await deps.executor.prepareExact({
          session,
          runId,
          recipe: recipe as DevelopmentRecipe,
          pair,
        });
        assertRecipeTarget(plan.recipe.target, target);
        if (needsClientExecutor(target)) {
          const ownerUserId = verifiedInitiatingUserId(ctx);
          const executorId = clientExecutorId(target);
          const selected =
            ownerUserId && executorId
              ? deps.clientExecutors?.select({
                  ownerUserId,
                  executorId,
                  platform: plan.recipe.platform,
                  arch: plan.recipe.arch,
                })
              : null;
          if (!selected) {
            throw Object.assign(
              new Error("The selected client device has no live reviewed Electron executor"),
              { code: "EEXECUTOR_UNAVAILABLE" }
            );
          }
          plan.clientExecutor = selected;
        }
        // Another preparation may have settled while source planning awaited.
        if (plans.has(runId)) ownedPlan(ctx, runId);
        plans.set(runId, { plan, ownerRuntimeId: ctx.caller.runtime.id });
        return { runId, snapshot: plan.snapshot, recipe: plan.recipe };
      },
      prepareTemplateExchange: async (_ctx, [input]) => {
        if (!deps.templateExchange) {
          throw Object.assign(new Error("Template repository exchange is unavailable"), {
            code: "EEXECUTOR_UNAVAILABLE",
          });
        }
        return deps.templateExchange.prepare(input);
      },
      applyTemplateExchange: async (ctx, [input]) => {
        if (!deps.templateExchange) {
          throw Object.assign(new Error("Template repository exchange is unavailable"), {
            code: "EEXECUTOR_UNAVAILABLE",
          });
        }
        return deps.templateExchange.apply({ ...input, ingress: semanticIngress(ctx) });
      },
      beginBuild: async (ctx, [{ run }]) => {
        const plan = requirePlan(ctx, run);
        const existing = builds.get(run.runId);
        if (existing) {
          if (existing.snapshotDigest !== run.snapshot.snapshotDigest) {
            throw Object.assign(new Error("Build handle was reused for another snapshot"), {
              code: "EIDEMPOTENCYDRIFT",
            });
          }
          if (existing.result.state === "running") return { started: true as const };
          builds.delete(run.runId);
        }
        const build: NativeBuildState = {
          snapshotDigest: run.snapshot.snapshotDigest,
          run,
          lifetime: new AbortController(),
          settled: Promise.resolve(),
          stop: null,
          phases: [] as Array<"installing" | "building">,
          result: { state: "running" },
        };
        builds.set(run.runId, build);
        build.settled = (async () => {
          try {
            await deps.executor.materialize(plan);
            build.lifetime.signal.throwIfAborted();
            const artifact = await deps.executor.execute(run, plan, (phase) => {
              if (build.phases.at(-1) !== phase) build.phases.push(phase);
            });
            build.lifetime.signal.throwIfAborted();
            const retainedArtifact = artifact as unknown as NonNullable<DevelopmentRun["artifact"]>;
            build.run = { ...run, artifact: retainedArtifact };
            if (run.target.kind === "build-only") {
              build.result = {
                state: "succeeded",
                artifact: retainedArtifact,
                instance: null,
                hostReadiness: null,
                client: null,
                attachedHost: null,
              };
            } else {
              await launchTarget(
                build.run as DevelopmentRun & {
                  artifact: NonNullable<DevelopmentRun["artifact"]>;
                },
                plan,
                build
              );
            }
          } catch (error) {
            // Lifecycle receipts retain ownership and acknowledged teardown
            // even when startup or cancellation prevents a ready result.
            build.result = {
              state: "failed",
              error: serializeRpcFailure(error, "application"),
              artifact: build.run.artifact,
              instance: build.run.instance,
              hostReadiness:
                run.target.kind === "isolated-host"
                  ? build.run.instance?.state === "stopped"
                    ? "stopped"
                    : "failed"
                  : null,
              client: build.run.client,
              attachedHost: build.run.attachedHost,
            };
          }
        })();
        return { started: true as const };
      },
      inspectBuild: (ctx, [{ runId, snapshotDigest }]) => {
        ownedPlan(ctx, runId);
        const build = builds.get(runId);
        if (!build || build.snapshotDigest !== snapshotDigest) {
          throw Object.assign(new Error("Unknown exact native build handle"), {
            code: "EEXECUTION_HANDLE",
          });
        }
        const common = {
          phases: [...build.phases],
          logs: deps.takeLogs?.(runId) ?? [],
        };
        if (build.result.state === "running") {
          return {
            state: "running" as const,
            artifact: build.run.artifact,
            instance: build.run.instance,
            hostReadiness:
              build.run.instance?.state === "ready"
                ? "ready"
                : build.run.instance
                  ? "starting"
                  : null,
            client: build.run.client,
            attachedHost: build.run.attachedHost,
            ...common,
          };
        }
        if (build.result.state === "failed" || build.result.state === "stopped") {
          return { ...build.result, ...common };
        }
        if (!build.result.artifact) {
          throw new Error("Successful native build did not retain an artifact");
        }
        return {
          ...build.result,
          ...common,
        };
      },
      stopBuild: async (ctx, [{ runId, snapshotDigest }]) => {
        const plan = ownedPlan(ctx, runId);
        if (plan.snapshot.snapshotDigest !== snapshotDigest) {
          throw Object.assign(new Error("Unknown exact native build handle"), {
            code: "EEXECUTION_HANDLE",
          });
        }
        const build = builds.get(runId);
        if (build) return stopNativeBuild(build);
        await deps.executor.stop(runId);
        return {
          artifact: null,
          instance: null,
          hostReadiness: null,
          client: null,
          attachedHost: null,
        };
      },
      retireBuild: async (ctx, [{ run }]) => {
        requirePlan(ctx, run);
        const build = builds.get(run.runId);
        if (build) await stopNativeBuild(build);
        await deps.executor.retire(run);
        plans.delete(run.runId);
        builds.delete(run.runId);
      },
    }),
  };
  const handler = definition.handler;
  definition.handler = async (ctx, method, args) => {
    if (closed)
      throw Object.assign(new Error("Native development is shutting down"), { code: "ECLOSED" });
    const operation = handler(ctx, method, args);
    admissions.add(operation);
    try {
      return await operation;
    } finally {
      admissions.delete(operation);
    }
  };
  return {
    definition,
    close() {
      closed = true;
      return (closing ??= (async () => {
        // Cancel running effects before joining admitted calls. Their startup
        // writers must settle before their registered children can be forgotten.
        const initialStops = [...builds.values()].map(stopNativeBuild);
        const outcomes = await Promise.allSettled([...initialStops, ...admissions]);
        const finalStops = await Promise.allSettled([
          ...[...builds.values()].map(stopNativeBuild),
          deps.native.close(),
        ]);
        // Admitted RPC failures belong to those callers; teardown failures
        // belong to this owner and must prevent a successful shutdown receipt.
        const failures = [...outcomes.slice(0, initialStops.length), ...finalStops]
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        if (failures.length)
          throw new AggregateError(failures, "Native development shutdown failed");
        plans.clear();
        builds.clear();
      })().catch((error: unknown) => {
        closing = null;
        throw error;
      }));
    },
  };
}

function semanticIngress(ctx: ServiceContext): NativeDevelopmentSemanticIngress {
  return { causalParent: ctx.causalParent ?? null };
}

function needsClientExecutor(target: DevelopmentRun["target"]): boolean {
  return (
    target.kind === "client-device" || (target.kind === "isolated-host" && target.includeClient)
  );
}

function clientExecutorId(target: DevelopmentRun["target"]): string | null {
  if (target.kind === "client-device") return target.executorId;
  if (target.kind === "isolated-host" && target.includeClient) return target.executorId;
  return null;
}

function assertRecipeTarget(recipe: DevelopmentRecipe["target"], target: DevelopmentTarget): void {
  const compatible =
    recipe.kind === target.kind &&
    (recipe.kind === "build-only" ||
      (recipe.kind === "client-device" && target.kind === "client-device") ||
      (recipe.kind === "isolated-host" &&
        target.kind === "isolated-host" &&
        recipe.includeClient === target.includeClient));
  if (!compatible) {
    throw Object.assign(new Error("Selected target does not match the reviewed recipe"), {
      code: "EIDEMPOTENCYDRIFT",
    });
  }
}

function initiatingAttachedHostCeiling(
  run: DevelopmentRun,
  fallback: readonly CapabilityScope[]
): CapabilityScope[] {
  return (run.attachedHostAuthorityCeiling ?? fallback).map((scope) => ({
    capability: scope.capability,
    resource: { ...scope.resource },
  }));
}
