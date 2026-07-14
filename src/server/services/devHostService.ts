import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  devHostMethods,
  type DevHostTarget,
  type DevHostProviderLaunchInput,
  type DevHostProviderPreparationFailure,
  type DevHostProviderPreparationInput,
  type DevHostProviderPreparationResult,
  type DevHostProviderRebuildInput,
  type DevLaunchStatus,
} from "@vibestudio/service-schemas/devHost";
import type { ExecutionSnapshot } from "../execution/executionSnapshotService.js";
import { domainHash } from "@vibestudio/shared/execution/identity";

export interface DevHostProvider {
  prepare(input: DevHostProviderPreparationInput): Promise<DevHostProviderPreparationResult>;
  failPreparation(
    input: DevHostProviderPreparationInput,
    failure: DevHostProviderPreparationFailure
  ): Promise<DevLaunchStatus>;
  launch(input: DevHostProviderLaunchInput): Promise<DevLaunchStatus>;
  status(): Promise<DevLaunchStatus[]>;
  rebuild(input: DevHostProviderRebuildInput): Promise<{
    launchId: string;
    executionInputHash: string;
    hostBuildId: string | null;
    active: boolean;
    state: DevLaunchStatus["state"];
  }>;
  stop(launchId: string): Promise<{ launchId: string; stopped: boolean }>;
  eval(launchId: string, code: string): Promise<unknown>;
  logs(launchId: string, after?: number): Promise<Response>;
  watch(launchId: string, after?: number): Promise<Response>;
}

export interface DevHostServiceDeps {
  workspaceId: string;
  resolveCallerContext(callerId: string): string | null;
  resolveSource(contextId: string): Promise<{ stateHash: string; dirtyCount: number }>;
  createSnapshot(input: { stateHash: string; target: DevHostTarget }): Promise<ExecutionSnapshot>;
  releaseSnapshot(snapshot: ExecutionSnapshot): Promise<void>;
  prepareCurrentHostClient(
    ctx: ServiceContext,
    snapshot: DevHostProviderLaunchInput["snapshot"]
  ): Promise<NonNullable<DevHostProviderLaunchInput["currentHostPairing"]>>;
  authorize(input: {
    ctx: ServiceContext;
    capability:
      | "service:devHost.launch"
      | "service:devHost.status"
      | "service:devHost.rebuild"
      | "service:devHost.stop"
      | "service:devHost.eval"
      | "service:devHost.logs"
      | "service:devHost.watch"
      | "devHost.admin";
    resource: string;
    executionInputHash?: string;
  }): Promise<void>;
  /** Binds provider invocations to the authenticated caller for host-side attribution. */
  provider(ctx: ServiceContext): DevHostProvider;
  now?: () => number;
}

export interface DevHostSourceWatcherDeps {
  provider: DevHostProvider;
  resolveSource(contextId: string): Promise<{ stateHash: string; dirtyCount: number }>;
  createSnapshot(input: { stateHash: string; target: DevHostTarget }): Promise<ExecutionSnapshot>;
  releaseSnapshot(snapshot: ExecutionSnapshot): Promise<void>;
  onError?: (contextId: string, error: unknown) => void;
}

/**
 * Coalesces canonical context advances into provider-owned candidate snapshots.
 * It never executes a candidate: the owner must return through `rebuild`, where
 * the host authorizes the exact pending execution input.
 */
export class DevHostSourceWatcher {
  private readonly dirtyContexts = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly deps: DevHostSourceWatcherDeps) {}

  notify(contextId: string): void {
    this.dirtyContexts.add(contextId);
    if (this.running.has(contextId)) return;
    const run = Promise.resolve()
      .then(async () => {
        while (this.dirtyContexts.delete(contextId)) await this.refresh(contextId);
      })
      .catch((error) => this.deps.onError?.(contextId, error))
      .finally(() => {
        this.running.delete(contextId);
        if (this.dirtyContexts.has(contextId)) this.notify(contextId);
      });
    this.running.set(contextId, run);
  }

  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()]);
  }

  private async refresh(contextId: string): Promise<void> {
    const launches = (await this.deps.provider.status()).filter(
      (launch) =>
        launch.owner.contextId === contextId &&
        launch.activeHostBuildId !== null &&
        launch.state !== "failed" &&
        launch.state !== "stopping" &&
        launch.state !== "stopped"
    );
    if (launches.length === 0) return;
    const source = await this.deps.resolveSource(contextId);
    for (const launch of launches) {
      if (
        launch.sourceStateHash === source.stateHash ||
        launch.candidateSourceStateHash === source.stateHash
      ) {
        continue;
      }
      const snapshot = await this.deps.createSnapshot({
        stateHash: source.stateHash,
        target: launch.target,
      });
      let handedOff = false;
      try {
        await this.deps.provider.prepare({
          operation: "rebuild",
          request: {
            launchId: launch.launchId,
            owner: launch.owner,
            sourceRepoPath: "projects/vibestudio",
            sourceStateHash: source.stateHash,
            dirtyCount: source.dirtyCount,
            target: launch.target,
            snapshot: providerSnapshot(snapshot),
          },
        });
        handedOff = true;
      } finally {
        if (!handedOff) await this.deps.releaseSnapshot(snapshot);
      }
    }
  }
}

export function createDevHostService(deps: DevHostServiceDeps): ServiceDefinition {
  const ownerOf = (ctx: ServiceContext, contextId: string): DevLaunchStatus["owner"] => ({
    principal: ctx.caller.code
      ? `code:${ctx.caller.code.repoPath}@${ctx.caller.code.executionDigest}`
      : ctx.caller.subject
        ? `user:${ctx.caller.subject.userId}`
        : `entity:${ctx.caller.runtime.id}`,
    workspaceId: deps.workspaceId,
    contextId,
  });
  const assertOwned = async (
    ctx: ServiceContext,
    launchId: string,
    capability: Parameters<DevHostServiceDeps["authorize"]>[0]["capability"]
  ): Promise<DevLaunchStatus> => {
    const launch = (await deps.provider(ctx).status()).find(
      (candidate) => candidate.launchId === launchId
    );
    if (!launch)
      throw new ServiceError(
        "devHost",
        capability.split(".").at(-1) ?? capability,
        `Unknown launch: ${launchId}`,
        "ENOENT"
      );
    const callerContext = deps.resolveCallerContext(ctx.caller.runtime.id);
    const owner = ownerOf(ctx, callerContext ?? launch.owner.contextId);
    const foreign =
      launch.owner.principal !== owner.principal || launch.owner.workspaceId !== owner.workspaceId;
    if (foreign) {
      await deps.authorize({ ctx, capability: "devHost.admin", resource: launchResource(launch) });
    }
    await deps.authorize({ ctx, capability, resource: launchResource(launch) });
    return launch;
  };

  return {
    name: "devHost",
    description: "Exact-state Vibestudio host development lifecycle",
    authority: {
      principals: ["user", "code", "host", "entity"],
    },
    methods: devHostMethods,
    handler: defineServiceHandler("devHost", devHostMethods, {
      launch: async (ctx, [input]) => {
        const callerContext = deps.resolveCallerContext(ctx.caller.runtime.id);
        const contextId = input.contextId ?? callerContext;
        if (!contextId)
          throw new ServiceError("devHost", "launch", "Caller has no bound context", "ENOCTX");
        if (input.contextId && input.contextId !== callerContext) {
          throw new ServiceError(
            "devHost",
            "launch",
            "A caller cannot name another context",
            "EACCES"
          );
        }
        const owner = ownerOf(ctx, contextId);
        const resource = `workspace:${deps.workspaceId}/context:${contextId}/repo:projects/vibestudio`;
        await deps.authorize({ ctx, capability: "service:devHost.launch", resource });
        const source = await deps.resolveSource(contextId);
        const snapshot = await deps.createSnapshot({
          stateHash: source.stateHash,
          target: input.target,
        });
        let handedOff = false;
        try {
          const launchId = deterministicLaunchId(owner, input.target, input.idempotencyKey);
          const provider = deps.provider(ctx);
          const preparation: DevHostProviderPreparationInput = {
            operation: "launch",
            request: {
              launchId,
              idempotencyKey: input.idempotencyKey,
              owner,
              sourceRepoPath: "projects/vibestudio",
              sourceStateHash: source.stateHash,
              dirtyCount: source.dirtyCount,
              target: input.target,
              snapshot: providerSnapshot(snapshot),
            },
          };
          const prepared = await provider.prepare(preparation);
          handedOff = true;
          if (!prepared.proceed) return prepared.status;
          const approvedRequest = prepared.request as typeof preparation.request;
          try {
            await deps.authorize({
              ctx,
              capability: "service:devHost.launch",
              resource,
              executionInputHash: approvedRequest.snapshot.executionInputHash,
            });
            const currentHostPairing =
              input.target.kind === "current-host-client"
                ? await deps.prepareCurrentHostClient(ctx, approvedRequest.snapshot)
                : undefined;
            return await provider.launch({
              ...approvedRequest,
              executionGrant: {
                resource: `${resource}/execution:${approvedRequest.snapshot.executionInputHash}`,
                authorizedAt: (deps.now ?? Date.now)(),
              },
              ...(currentHostPairing ? { currentHostPairing } : {}),
            });
          } catch (error) {
            await provider
              .failPreparation(preparation, preparationFailure(error))
              .catch(() => undefined);
            throw error;
          }
        } finally {
          if (!handedOff) await deps.releaseSnapshot(snapshot);
        }
      },
      status: async (ctx, [input]) => {
        const all = await deps.provider(ctx).status();
        const contextId = deps.resolveCallerContext(ctx.caller.runtime.id);
        const owner = ownerOf(ctx, contextId ?? "unbound");
        const owned = all.filter(
          (launch) =>
            launch.owner.principal === owner.principal &&
            launch.owner.workspaceId === owner.workspaceId
        );
        let selected = input?.launchId
          ? owned.filter((launch) => launch.launchId === input.launchId)
          : owned;
        if (input?.launchId && selected.length === 0) {
          const foreign = all.find((launch) => launch.launchId === input.launchId);
          if (foreign) {
            await deps.authorize({
              ctx,
              capability: "devHost.admin",
              resource: launchResource(foreign),
            });
            selected = [foreign];
          }
        }
        await Promise.all(
          selected.map((launch) =>
            deps.authorize({
              ctx,
              capability: "service:devHost.status",
              resource: launchResource(launch),
            })
          )
        );
        return selected;
      },
      rebuild: async (ctx, [input]) => {
        const launch = await assertOwned(ctx, input.launchId, "service:devHost.rebuild");
        const source = await deps.resolveSource(launch.owner.contextId);
        const snapshot = await deps.createSnapshot({
          stateHash: source.stateHash,
          target: launch.target,
        });
        let handedOff = false;
        try {
          const provider = deps.provider(ctx);
          const preparation: DevHostProviderPreparationInput = {
            operation: "rebuild",
            request: {
              launchId: launch.launchId,
              owner: launch.owner,
              sourceRepoPath: "projects/vibestudio",
              sourceStateHash: source.stateHash,
              dirtyCount: source.dirtyCount,
              target: launch.target,
              snapshot: providerSnapshot(snapshot),
            },
          };
          const prepared = await provider.prepare(preparation);
          handedOff = true;
          if (!prepared.proceed) {
            return providerBuildResult(prepared.status, snapshot.executionInputHash);
          }
          const approvedRequest = prepared.request as typeof preparation.request;
          try {
            await deps.authorize({
              ctx,
              capability: "service:devHost.rebuild",
              resource: launchResource(launch),
              executionInputHash: approvedRequest.snapshot.executionInputHash,
            });
            const currentHostPairing =
              launch.target.kind === "current-host-client"
                ? await deps.prepareCurrentHostClient(ctx, approvedRequest.snapshot)
                : undefined;
            return await provider.rebuild({
              ...approvedRequest,
              executionGrant: {
                resource: `${launchResource(launch)}/execution:${approvedRequest.snapshot.executionInputHash}`,
                authorizedAt: (deps.now ?? Date.now)(),
              },
              ...(currentHostPairing ? { currentHostPairing } : {}),
            });
          } catch (error) {
            await provider
              .failPreparation(preparation, preparationFailure(error))
              .catch(() => undefined);
            throw error;
          }
        } finally {
          if (!handedOff) await deps.releaseSnapshot(snapshot);
        }
      },
      stop: async (ctx, [input]) => {
        await assertOwned(ctx, input.launchId, "service:devHost.stop");
        return deps.provider(ctx).stop(input.launchId);
      },
      eval: async (ctx, [input]) => {
        const launch = await assertOwned(ctx, input.launchId, "service:devHost.eval");
        if (!launch.activeHostBuildId || launch.state === "stopped" || launch.state === "failed") {
          throw new ServiceError(
            "devHost",
            "eval",
            "Launch has no ready active generation",
            "ENOTREADY"
          );
        }
        return {
          launchId: launch.launchId,
          hostBuildId: launch.activeHostBuildId,
          sourceStateHash: launch.sourceStateHash,
          result: await deps.provider(ctx).eval(input.launchId, input.code),
        };
      },
      logs: async (ctx, [input]) => {
        await assertOwned(ctx, input.launchId, "service:devHost.logs");
        return deps.provider(ctx).logs(input.launchId, input.after);
      },
      watch: async (ctx, [input]) => {
        await assertOwned(ctx, input.launchId, "service:devHost.watch");
        return deps.provider(ctx).watch(input.launchId, input.after);
      },
    }),
  };
}

function launchResource(launch: DevLaunchStatus): string {
  return `workspace:${launch.owner.workspaceId}/context:${launch.owner.contextId}/repo:${launch.sourceRepoPath}/launch:${launch.launchId}`;
}

function providerSnapshot(snapshot: ExecutionSnapshot): DevHostProviderLaunchInput["snapshot"] {
  return {
    snapshotId: snapshot.snapshotId,
    executionInputHash: snapshot.executionInputHash,
    recipeDigest: snapshot.recipeDigest,
    sourceRoot: snapshot.sourceRoot,
    scratchRoot: snapshot.scratchRoot,
    manifestPath: snapshot.manifestPath,
    createdAt: snapshot.createdAt,
  };
}

function deterministicLaunchId(
  owner: DevLaunchStatus["owner"],
  target: DevHostTarget,
  key: string
): string {
  const input = JSON.stringify({ owner, target, key });
  return `dev_${domainHash("vibestudio/dev-host-launch/v1", input)}`;
}

function preparationFailure(error: unknown): DevHostProviderPreparationFailure {
  return {
    phase: "approval",
    code:
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "DEV_HOST_PREPARATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function providerBuildResult(
  status: DevLaunchStatus,
  executionInputHash: string
): Awaited<ReturnType<DevHostProvider["rebuild"]>> {
  return {
    launchId: status.launchId,
    executionInputHash,
    hostBuildId: status.activeHostBuildId,
    active: status.state === "ready" && status.executionInputHash === executionInputHash,
    state: status.state,
  };
}
