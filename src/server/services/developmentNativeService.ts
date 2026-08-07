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
import type { z } from "zod";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import {
  verifiedInitiatingUserId,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import type { CapabilityScope } from "@vibestudio/rpc";
import type { DevelopmentExecutor, PreparedDevelopmentBuild } from "./developmentExecutor.js";
import type { IsolatedDevelopmentHostExecutor } from "./isolatedDevelopmentHostExecutor.js";
import type { DevelopmentClientExecutorRegistry } from "./developmentClientExecutorService.js";
import type { AttachedHostPublisher } from "./attachedHostController.js";
import type {
  NativeDevelopmentCheckpointReceipt,
  NativeDevelopmentSemanticIngress,
  NativeDevelopmentSessionReceipt,
  NativeDevelopmentTerminalSnapshot,
  NativeDevelopmentToolId,
} from "./nativeDevelopmentExecutor.js";

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
  recover(sessionId: string): Promise<NativeDevelopmentSessionReceipt>;
  keep(sessionId: string): Promise<NativeDevelopmentSessionReceipt>;
  forceRetire(sessionId: string): Promise<{ retired: boolean; cleanupErrors: string[] }>;
  readTerminal(input: {
    sessionId: string;
    after?: number;
    maxBytes?: number;
  }): Promise<NativeDevelopmentTerminalSnapshot>;
  writeTerminal(input: { sessionId: string; writeId: string; data: string }): Promise<void>;
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
  phases: Array<"installing" | "building">;
  result:
    | { state: "running" }
    | ({ state: "succeeded" | "ready" } & NativeTargetFields)
    | ({ state: "failed"; error: string } & NativeTargetFields);
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
}): ServiceDefinition {
  const plans = new Map<string, PreparedDevelopmentBuild>();
  const builds = new Map<string, NativeBuildState>();

  const requirePlan = (run: DevelopmentRun): PreparedDevelopmentBuild => {
    const plan = plans.get(run.runId);
    if (
      !plan ||
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
      const invite = await deps.mintCurrentHostInvite({
        userId: run.ownerUserId,
        ttlMs: 5 * 60_000,
      });
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
        },
        onProviderLaunched(receipt) {
          if (client) {
            client = {
              ...client,
              state: "provider-launched",
              childPid: receipt.childPid,
              launchedAt: receipt.launchedAt,
            };
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
          }
        },
      });
      const ready = await launch.ready;
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
        instance = receipt;
      },
      async onReady(receipt) {
        instance = receipt;
        if (run.target.kind === "isolated-host" && run.target.includeClient) {
          if (!deps.clientExecutors || !plan.clientExecutor || !run.ownerUserId) {
            throw Object.assign(new Error("The selected client-device executor is unavailable"), {
              code: "EEXECUTOR_UNAVAILABLE",
            });
          }
          const artifactSource = await deps.executor.resolveClientArtifactSource(run, plan);
          const pairingDeepLink = await deps.isolatedExecutor!.mintClientInvite(run);
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
            },
          });
          const child = await deps.isolatedExecutor!.waitForClientAttestation(
            run,
            launch.requestId
          );
          deps.clientExecutors.acceptManagedChildAttestation(child);
          const ready = await launch.ready;
          if (!client) throw new Error("Isolated client launch state was lost");
          client = {
            ...client,
            state: "ready",
            childPid: ready.childPid,
            childRuntimeId: ready.childRuntimeId,
            launchedAt: ready.launchedAt,
            attestedAt: ready.attestedAt,
          };
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
        }
        build.result = {
          state: "ready",
          artifact: run.artifact,
          instance,
          hostReadiness: "ready",
          client,
          attachedHost,
        };
      },
      onExit(code) {
        if (build.result.state === "ready" && code !== 0) {
          build.result = {
            state: "failed",
            error: `Isolated host exited with code ${code}`,
            artifact: run.artifact,
            instance,
            hostReadiness: "failed",
            client,
            attachedHost,
          };
        }
      },
    });
  };

  return {
    name: "developmentNative",
    description: "Exact local build, process, and terminal effects for the development builtin",
    authority: { principals: ["host", "code"] },
    methods: developmentNativeMethods,
    handler: defineServiceHandler("developmentNative", developmentNativeMethods, {
      describeHost: () => ({ platform: process.platform, arch: process.arch }),
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
      prepareBuild: async (ctx, [{ session, runId, recipe, target }]) => {
        const plan = await deps.executor.prepareExact({
          session,
          runId,
          recipe: recipe as DevelopmentRecipe,
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
        plans.set(runId, plan);
        return { runId, snapshot: plan.snapshot, recipe: plan.recipe };
      },
      beginBuild: async (_ctx, [{ run }]) => {
        const plan = requirePlan(run);
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
          phases: [] as Array<"installing" | "building">,
          result: { state: "running" },
        };
        builds.set(run.runId, build);
        void (async () => {
          try {
            await deps.executor.materialize(plan);
            const artifact = await deps.executor.execute(run, plan, (phase) => {
              if (build.phases.at(-1) !== phase) build.phases.push(phase);
            });
            const retainedArtifact = artifact as unknown as NonNullable<DevelopmentRun["artifact"]>;
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
              build.run = { ...run, artifact: retainedArtifact };
              await launchTarget(
                build.run as DevelopmentRun & {
                  artifact: NonNullable<DevelopmentRun["artifact"]>;
                },
                plan,
                build
              );
            }
          } catch (error) {
            build.result = {
              state: "failed",
              error: error instanceof Error ? error.message : String(error),
              artifact: null,
              instance: null,
              hostReadiness: run.target.kind === "isolated-host" ? "failed" : null,
              client: null,
              attachedHost: null,
            };
          }
        })();
        return { started: true as const };
      },
      inspectBuild: (_ctx, [{ runId, snapshotDigest }]) => {
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
            artifact: null,
            instance: null,
            hostReadiness: null,
            client: null,
            attachedHost: null,
            ...common,
          };
        }
        if (build.result.state === "failed") {
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
      stopBuild: async (_ctx, [{ runId, snapshotDigest }]) => {
        const plan = plans.get(runId);
        if (!plan || plan.snapshot.snapshotDigest !== snapshotDigest) {
          throw Object.assign(new Error("Unknown exact native build handle"), {
            code: "EEXECUTION_HANDLE",
          });
        }
        const build = builds.get(runId);
        if (build?.run.target.kind === "client-device") {
          await deps.clientExecutors?.stop(runId);
        } else if (build?.run.target.kind === "isolated-host" && build.result.state !== "running") {
          await deps.isolatedExecutor?.stop(build.run);
        }
        await deps.executor.stop(runId);
      },
      retireBuild: async (_ctx, [{ run }]) => {
        requirePlan(run);
        await deps.executor.retire(run);
        plans.delete(run.runId);
        builds.delete(run.runId);
      },
    }),
  };
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
