import { randomBytes } from "node:crypto";
import { developmentClientExecutorMethods } from "@vibestudio/service-schemas/developmentClientExecutor";
import type { EventService } from "@vibestudio/shared/eventsService";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";

const LEASE_MS = 60_000;
const REQUEST_MS = 5 * 60_000;
const EXTERNAL_ATTESTATION_LIMIT = 256;

export interface DevelopmentClientExecutorBinding {
  providerId: string;
  ownerRuntimeId: string;
  ownerUserId: string;
  platform: string;
  arch: string;
  executorDigest: string;
  leaseExpiresAt: number;
}

export type DevelopmentClientExecutorIdentity = Omit<
  DevelopmentClientExecutorBinding,
  "leaseExpiresAt"
>;

export interface DevelopmentClientLaunchInput {
  runId: string;
  binding: DevelopmentClientExecutorIdentity;
  mainEntryBuildId: string;
  executionDigest: string;
  recipeId: string;
  artifactSource: {
    manifest: readonly {
      path: string;
      integrity: string;
      byteLength: number;
    }[];
    read(path: string, offset: number, length: number): Buffer;
  };
  pairingDeepLink: string;
  onRequested?: (receipt: { requestId: string; requestedAt: number }) => void;
  onProviderLaunched?: (receipt: {
    requestId: string;
    childPid: number;
    ownershipDigest: string;
    launchedAt: number;
  }) => void;
  onChildAttested?: (receipt: {
    requestId: string;
    childRuntimeId: string;
    attestedAt: number;
  }) => void;
  onExited?: (receipt: {
    requestId: string;
    childPid: number;
    unexpected: boolean;
    exitCode: number | null;
    signal: string | null;
    cleanupError?: string;
    exitedAt: number;
  }) => void;
}

interface PendingLaunch extends DevelopmentClientLaunchInput {
  requestId: string;
  expiresAt: number;
  settle: {
    resolve(value: {
      requestId: string;
      childPid: number;
      childRuntimeId: string;
      launchedAt: number;
      attestedAt: number;
    }): void;
    reject(error: Error): void;
  };
  timeout: NodeJS.Timeout;
  launchReceipt?: { childPid: number; ownershipDigest: string; launchedAt: number };
  childAttestation?: { childRuntimeId: string; attestedAt: number };
  stop?: StopWait;
}

interface StopWait {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

interface LiveLaunch {
  requestId: string;
  runId: string;
  binding: DevelopmentClientExecutorIdentity;
  childPid: number;
  childRuntimeId: string;
  onExited?: DevelopmentClientLaunchInput["onExited"];
  stop?: StopWait;
}

export class DevelopmentClientExecutorRegistry {
  private readonly providers = new Map<string, DevelopmentClientExecutorBinding>();
  private readonly pending = new Map<string, PendingLaunch>();
  private readonly live = new Map<string, LiveLaunch>();
  private readonly externalAttestations = new Map<
    string,
    { requestId: string; childRuntimeId: string; attestedAt: number; expiresAt: number }
  >();
  private isolatedManagerRuntimeId: string | null = null;

  constructor(
    private readonly deps: {
      eventService: Pick<EventService, "emitToCaller">;
      now?: () => number;
      isolatedHost?: { instanceId: string; generationId: string };
    }
  ) {}

  definition(): ServiceDefinition {
    return {
      name: "developmentClientExecutor",
      description: "Authenticated desktop executors for exact development-client launches",
      authority: { principals: ["host"] },
      methods: developmentClientExecutorMethods,
      handler: defineServiceHandler("developmentClientExecutor", developmentClientExecutorMethods, {
        register: (ctx, [input]) => {
          const userId = requireUser(ctx.caller);
          const now = this.now();
          const binding: DevelopmentClientExecutorBinding = {
            ...input,
            ownerRuntimeId: ctx.caller.runtime.id,
            ownerUserId: userId,
            leaseExpiresAt: now + LEASE_MS,
          };
          this.providers.set(ctx.caller.runtime.id, binding);
          return { leaseExpiresAt: binding.leaseExpiresAt };
        },
        claim: (ctx, [{ requestId }]) => {
          const request = this.requirePending(requestId, ctx.caller);
          return {
            requestId,
            runId: request.runId,
            mainEntryBuildId: request.mainEntryBuildId,
            executionDigest: request.executionDigest,
            recipeId: request.recipeId,
            artifacts: request.artifactSource.manifest,
            pairingDeepLink: request.pairingDeepLink,
            expiresAt: request.expiresAt,
          };
        },
        readArtifact: (ctx, [input]) => {
          const request = this.requirePending(input.requestId, ctx.caller);
          const artifact = request.artifactSource.manifest.find(
            (candidate) => candidate.path === input.path
          );
          if (!artifact || input.offset > artifact.byteLength) {
            throw coded("ENOENT", "Unknown development client artifact coordinate");
          }
          const bytes = request.artifactSource.read(
            artifact.path,
            input.offset,
            Math.min(input.length, artifact.byteLength - input.offset)
          );
          const nextOffset = input.offset + bytes.byteLength;
          return {
            base64: bytes.toString("base64"),
            nextOffset,
            eof: nextOffset === artifact.byteLength,
          };
        },
        launched: (ctx, [input]) => {
          const request = this.requirePending(input.requestId, ctx.caller);
          if (request.launchReceipt) {
            if (
              request.launchReceipt.childPid !== input.childPid ||
              request.launchReceipt.ownershipDigest !== input.ownershipDigest
            ) {
              throw coded("EIDEMPOTENCYDRIFT", "Launch receipt changed for this request");
            }
          } else {
            request.launchReceipt = {
              childPid: input.childPid,
              ownershipDigest: input.ownershipDigest,
              launchedAt: this.now(),
            };
            request.onProviderLaunched?.({
              requestId: request.requestId,
              ...request.launchReceipt,
            });
          }
          if (request.stop) this.emitStopRequest(request);
          this.trySettle(request);
          return { accepted: true as const };
        },
        attest: (ctx, [{ requestId }]) => {
          const request = this.pending.get(requestId);
          if (!request) {
            this.recordExternalAttestation(requestId, ctx.caller);
            return { accepted: true as const };
          }
          const userId = ctx.caller.subject?.userId;
          if (
            !request ||
            request.expiresAt <= this.now() ||
            !userId ||
            userId !== request.binding.ownerUserId ||
            ctx.caller.runtime.kind !== "shell" ||
            ctx.caller.runtime.id === request.binding.ownerRuntimeId
          ) {
            throw coded("ENOENT", "Unknown development client attestation");
          }
          if (
            request.childAttestation &&
            request.childAttestation.childRuntimeId !== ctx.caller.runtime.id
          ) {
            throw coded("EIDEMPOTENCYDRIFT", "A different paired device attested this request");
          }
          if (!request.childAttestation) {
            request.childAttestation = {
              childRuntimeId: ctx.caller.runtime.id,
              attestedAt: this.now(),
            };
            request.onChildAttested?.({
              requestId: request.requestId,
              ...request.childAttestation,
            });
          }
          this.trySettle(request);
          return { accepted: true as const };
        },
        bindIsolatedManager: (ctx, [input]) => {
          const isolated = this.deps.isolatedHost;
          if (
            !isolated ||
            input.instanceId !== isolated.instanceId ||
            input.generationId !== isolated.generationId ||
            ctx.caller.runtime.kind !== "shell"
          ) {
            throw coded("ENOENT", "Unknown isolated development manager binding");
          }
          if (
            this.isolatedManagerRuntimeId &&
            this.isolatedManagerRuntimeId !== ctx.caller.runtime.id
          ) {
            throw coded("EIDEMPOTENCYDRIFT", "A different management device is already bound");
          }
          this.isolatedManagerRuntimeId = ctx.caller.runtime.id;
          return { accepted: true as const };
        },
        consumeAttestation: (ctx, [{ requestId }]) => {
          if (
            !this.deps.isolatedHost ||
            !this.isolatedManagerRuntimeId ||
            this.isolatedManagerRuntimeId !== ctx.caller.runtime.id
          ) {
            throw coded("ENOENT", "Unknown isolated development manager");
          }
          const receipt = this.externalAttestations.get(requestId);
          if (!receipt || receipt.expiresAt <= this.now()) {
            this.externalAttestations.delete(requestId);
            return null;
          }
          this.externalAttestations.delete(requestId);
          return {
            requestId: receipt.requestId,
            childRuntimeId: receipt.childRuntimeId,
            attestedAt: receipt.attestedAt,
          };
        },
        fail: (ctx, [input]) => {
          const request = this.requirePending(input.requestId, ctx.caller);
          this.pending.delete(input.requestId);
          clearTimeout(request.timeout);
          request.settle.reject(coded(input.code, input.message));
          if (request.stop) {
            clearTimeout(request.stop.timeout);
            request.stop.resolve();
          }
          return { accepted: true as const };
        },
        exited: (ctx, [input]) => {
          const launch = [...this.live.values()].find(
            (candidate) => candidate.requestId === input.requestId
          );
          if (!launch) {
            const pending = this.pending.get(input.requestId);
            if (!pending || !ownedBy(pending.binding, ctx.caller)) {
              throw coded("ENOENT", "Unknown development client process");
            }
            if (pending.launchReceipt && pending.launchReceipt.childPid !== input.childPid) {
              throw coded("EOWNERSHIP", "Exited client PID does not match the launch receipt");
            }
            this.pending.delete(input.requestId);
            clearTimeout(pending.timeout);
            const intentional = Boolean(pending.stop);
            const error = coded(
              intentional ? "ECANCELLED" : "ECLIENT_EXIT",
              intentional
                ? "Development client launch was stopped before readiness"
                : `Development client exited before readiness (${input.signal ?? input.exitCode ?? "unknown"})`
            );
            pending.settle.reject(error);
            if (pending.stop) {
              clearTimeout(pending.stop.timeout);
              if (input.cleanupError) pending.stop.reject(coded("ECLEANUP", input.cleanupError));
              else pending.stop.resolve();
            }
            pending.onExited?.({
              ...input,
              unexpected: !intentional,
              exitedAt: this.now(),
            });
            return { accepted: true as const };
          }
          if (!ownedBy(launch.binding, ctx.caller)) {
            throw coded("ENOENT", "Unknown development client process");
          }
          if (input.childPid !== launch.childPid) {
            throw coded("EOWNERSHIP", "Exited client PID does not match the launch receipt");
          }
          const unexpected = !launch.stop;
          this.live.delete(launch.runId);
          if (launch.stop) {
            clearTimeout(launch.stop.timeout);
            if (input.cleanupError) {
              launch.stop.reject(coded("ECLEANUP", input.cleanupError));
            } else {
              launch.stop.resolve();
            }
          }
          launch.onExited?.({
            ...input,
            unexpected,
            exitedAt: this.now(),
          });
          return { accepted: true as const };
        },
      }),
    };
  }

  select(input: {
    ownerUserId: string;
    ownerRuntimeId: string;
    platform: string;
    arch: string;
  }): DevelopmentClientExecutorIdentity | null {
    const now = this.now();
    const provider = this.providers.get(input.ownerRuntimeId);
    if (
      !provider ||
      provider.ownerUserId !== input.ownerUserId ||
      provider.platform !== input.platform ||
      provider.arch !== input.arch ||
      provider.leaseExpiresAt <= now
    ) {
      return null;
    }
    return stableIdentity(provider);
  }

  launch(input: DevelopmentClientLaunchInput): {
    requestId: string;
    ready: Promise<{
      requestId: string;
      childPid: number;
      childRuntimeId: string;
      onExited?: DevelopmentClientLaunchInput["onExited"];
      launchedAt: number;
      attestedAt: number;
    }>;
  } {
    const current = this.providers.get(input.binding.ownerRuntimeId);
    if (!current || !sameBinding(current, input.binding) || current.leaseExpiresAt <= this.now()) {
      throw coded("EEXECUTOR_UNAVAILABLE", "Selected desktop executor expired");
    }
    const requestId = `development-client-${randomBytes(16).toString("hex")}`;
    const ready = new Promise<{
      requestId: string;
      childPid: number;
      childRuntimeId: string;
      launchedAt: number;
      attestedAt: number;
    }>((resolve, reject) => {
      const expiresAt = this.now() + REQUEST_MS;
      const timeout = setTimeout(() => {
        const pending = this.pending.get(requestId);
        this.pending.delete(requestId);
        const error = coded(
          "EEXECUTOR_TIMEOUT",
          "Desktop executor did not complete the client launch"
        );
        reject(error);
        if (pending?.stop) {
          clearTimeout(pending.stop.timeout);
          pending.stop.reject(error);
        }
      }, REQUEST_MS);
      timeout.unref();
      this.pending.set(requestId, {
        ...input,
        requestId,
        expiresAt,
        settle: { resolve, reject },
        timeout,
      });
      input.onRequested?.({ requestId, requestedAt: this.now() });
      this.deps.eventService.emitToCaller(
        input.binding.ownerRuntimeId,
        "development:client-launch-request",
        { requestId, runId: input.runId, expiresAt }
      );
    });
    return { requestId, ready };
  }

  stop(runId: string): Promise<void> {
    const pending = [...this.pending.values()].find((candidate) => candidate.runId === runId);
    if (pending) {
      if (pending.stop) return pending.stop.promise;
      pending.stop = this.createStopWait(() => {
        pending.stop = undefined;
      });
      if (pending.launchReceipt) this.emitStopRequest(pending);
      return pending.stop.promise;
    }
    const launch = this.live.get(runId);
    if (!launch) return Promise.resolve();
    if (launch.stop) return launch.stop.promise;
    launch.stop = this.createStopWait(() => {
      launch.stop = undefined;
    });
    this.deps.eventService.emitToCaller(
      launch.binding.ownerRuntimeId,
      "development:client-stop-request",
      { requestId: launch.requestId, runId, childPid: launch.childPid }
    );
    return launch.stop.promise;
  }

  acceptManagedChildAttestation(input: {
    requestId: string;
    childRuntimeId: string;
    attestedAt: number;
  }): void {
    const request = this.pending.get(input.requestId);
    if (!request || request.expiresAt <= this.now()) {
      throw coded("ENOENT", "Unknown development client attestation");
    }
    if (
      request.childAttestation &&
      (request.childAttestation.childRuntimeId !== input.childRuntimeId ||
        request.childAttestation.attestedAt !== input.attestedAt)
    ) {
      throw coded("EIDEMPOTENCYDRIFT", "Managed child attestation changed");
    }
    if (!request.childAttestation) {
      request.childAttestation = {
        childRuntimeId: input.childRuntimeId,
        attestedAt: input.attestedAt,
      };
      request.onChildAttested?.(input);
    }
    this.trySettle(request);
  }

  private requirePending(requestId: string, caller: VerifiedCaller): PendingLaunch {
    const request = this.pending.get(requestId);
    if (!request || request.expiresAt <= this.now() || !ownedBy(request.binding, caller)) {
      throw coded("ENOENT", "Unknown development client launch request");
    }
    return request;
  }

  private trySettle(request: PendingLaunch): void {
    if (request.stop) return;
    if (!request.launchReceipt || !request.childAttestation) return;
    this.pending.delete(request.requestId);
    clearTimeout(request.timeout);
    this.live.set(request.runId, {
      requestId: request.requestId,
      runId: request.runId,
      binding: request.binding,
      childPid: request.launchReceipt.childPid,
      childRuntimeId: request.childAttestation.childRuntimeId,
      onExited: request.onExited,
    });
    request.settle.resolve({
      requestId: request.requestId,
      childPid: request.launchReceipt.childPid,
      childRuntimeId: request.childAttestation.childRuntimeId,
      launchedAt: request.launchReceipt.launchedAt,
      attestedAt: request.childAttestation.attestedAt,
    });
  }

  private emitStopRequest(
    request: Pick<PendingLaunch, "requestId" | "runId" | "binding" | "launchReceipt">
  ): void {
    if (!request.launchReceipt) return;
    this.deps.eventService.emitToCaller(
      request.binding.ownerRuntimeId,
      "development:client-stop-request",
      {
        requestId: request.requestId,
        runId: request.runId,
        childPid: request.launchReceipt.childPid,
      }
    );
  }

  private createStopWait(onTimeout: () => void): StopWait {
    let settle!: { resolve(): void; reject(error: Error): void };
    const promise = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const timeout = setTimeout(() => {
      onTimeout();
      settle.reject(coded("EEXECUTOR_TIMEOUT", "Desktop executor did not prove client cleanup"));
    }, 30_000);
    timeout.unref();
    return {
      promise,
      resolve: settle.resolve,
      reject: settle.reject,
      timeout,
    };
  }

  private recordExternalAttestation(requestId: string, caller: VerifiedCaller): void {
    if (
      !this.deps.isolatedHost ||
      !this.isolatedManagerRuntimeId ||
      caller.runtime.kind !== "shell" ||
      caller.runtime.id === this.isolatedManagerRuntimeId ||
      !caller.subject?.userId
    ) {
      throw coded("ENOENT", "Unknown development client attestation");
    }
    const existing = this.externalAttestations.get(requestId);
    if (existing) {
      if (existing.childRuntimeId !== caller.runtime.id) {
        throw coded("EIDEMPOTENCYDRIFT", "A different paired child attested this request");
      }
      return;
    }
    const now = this.now();
    for (const [id, receipt] of this.externalAttestations) {
      if (receipt.expiresAt <= now) this.externalAttestations.delete(id);
    }
    if (this.externalAttestations.size >= EXTERNAL_ATTESTATION_LIMIT) {
      throw coded("EATTESTATION_CAPACITY", "Isolated client attestation inbox is full");
    }
    this.externalAttestations.set(requestId, {
      requestId,
      childRuntimeId: caller.runtime.id,
      attestedAt: now,
      expiresAt: now + REQUEST_MS,
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

export function createDevelopmentClientExecutorService(
  deps: ConstructorParameters<typeof DevelopmentClientExecutorRegistry>[0]
): ServiceDefinition {
  return new DevelopmentClientExecutorRegistry(deps).definition();
}

function requireUser(caller: VerifiedCaller): string {
  const userId = caller.subject?.userId;
  if (!userId)
    throw coded("EACCES", "Desktop executor registration requires an authenticated user");
  return userId;
}

function ownedBy(binding: DevelopmentClientExecutorIdentity, caller: VerifiedCaller): boolean {
  return (
    binding.ownerRuntimeId === caller.runtime.id && binding.ownerUserId === caller.subject?.userId
  );
}

function sameBinding(
  left: DevelopmentClientExecutorBinding,
  right: DevelopmentClientExecutorIdentity
): boolean {
  return (
    left.providerId === right.providerId &&
    left.ownerRuntimeId === right.ownerRuntimeId &&
    left.ownerUserId === right.ownerUserId &&
    left.platform === right.platform &&
    left.arch === right.arch &&
    left.executorDigest === right.executorDigest
  );
}

function stableIdentity(
  binding: DevelopmentClientExecutorBinding
): DevelopmentClientExecutorIdentity {
  return {
    providerId: binding.providerId,
    ownerRuntimeId: binding.ownerRuntimeId,
    ownerUserId: binding.ownerUserId,
    platform: binding.platform,
    arch: binding.arch,
    executorDigest: binding.executorDigest,
  };
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
