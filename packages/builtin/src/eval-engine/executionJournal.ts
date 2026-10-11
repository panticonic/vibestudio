import { parseServiceMethodArgs } from "@vibestudio/shared/typedServiceClient";
import {
  runtimeMethods,
  NativeRuntimeHealthObservationSchema,
  NativeRuntimeUnitObservationSchema,
} from "@vibestudio/service-schemas/runtime";
import {
  webhookIngressMethods,
  NativeWebhookObservationSchema,
  type NativeWebhookObservation,
} from "@vibestudio/service-schemas/webhookIngress";
import { sha256HexSyncText } from "@vibestudio/content-addressing";
import {
  blobstoreMethods,
  NativeBlobTextObservationSchema,
  NativeBlobTreeObservationSchema,
  type NativeBlobTreeObservation,
  type NativeBlobTextObservation,
} from "@vibestudio/service-schemas/blobstore";
import {
  EVAL_OPERATION_JOURNAL_MAX_ENTRIES,
  EVAL_OPERATION_JOURNAL_PREVIEW_CHARS,
  evalRpcCallObservationSchema,
  evalWorkerLifecycleObservationSchema,
  type EvalRpcCallObservation,
  type EvalOperationJournal,
  type EvalWorkerLifecycleObservation,
} from "@vibestudio/service-schemas/eval";
import {
  serverLogMethods,
  NativeServerLogObservationSchema,
  type NativeServerLogObservation,
} from "@vibestudio/service-schemas/serverLog";
import type { BuildPerformanceProfileWire } from "@vibestudio/service-schemas/build";
import {
  permissionsMethods,
  NativePermissionInventoryObservationSchema,
} from "@vibestudio/service-schemas/permissions";
import {
  credentialsMethods,
  NativeCredentialResolutionObservationSchema,
} from "@vibestudio/service-schemas/credentials";
import {
  notificationMethods,
  NativeNotificationLifecycleObservationSchema,
} from "@vibestudio/service-schemas/notification";
import { workersMethods } from "@vibestudio/service-schemas/workers";

type WorkerLifecycleRequest =
  | { method: "runtime.createEntity"; kind: "do"; className: string; objectKey?: string }
  | { method: "runtime.createEntity"; kind: "worker"; objectKey?: string }
  | { method: "workers.resolveDurableObject" }
  | { method: "workers.resolveService"; query: string }
  | { method: "runtime.retireEntity"; entityId: string };

import {
  extensionsMethods,
  NativeExtensionInvocationObservationSchema,
  type NativeExtensionInvocationObservation,
} from "@vibestudio/service-schemas/extensions";

/** Native effect evidence belongs to one execution, independently of its return value. */
export class ExecutionJournal {
  readonly entries: Record<string, unknown>[] = [];
  truncated = false;
  private characters = 0;
  private closed = false;

  /** Guest-visible runtime hooks may record descriptive effects, but native
   * execution receipts are written only by this journal's owning host path. */
  appendGuestOperation(entry: Record<string, unknown>): void {
    if (entry["type"] === "rpc.call" || entry["type"] === "worker.lifecycle") {
      throw new Error(`Operation type ${String(entry["type"])} is reserved for host evidence`);
    }
    this.append(entry);
  }

  append(entry: Record<string, unknown>): void {
    if (this.closed) return;
    const encoded = JSON.stringify(entry);
    if (
      this.entries.length >= EVAL_OPERATION_JOURNAL_MAX_ENTRIES ||
      this.characters + encoded.length > EVAL_OPERATION_JOURNAL_PREVIEW_CHARS
    ) {
      this.truncated = true;
      return;
    }
    // Guest code can later mutate a returned object; it cannot mutate this copy.
    this.entries.push(JSON.parse(encoded) as Record<string, unknown>);
    this.characters += encoded.length;
  }

  recordRpcCall(receipt: EvalRpcCallObservation): void {
    if (this.closed) return;
    this.append({
      type: "rpc.call",
      receipt: evalRpcCallObservationSchema.parse(receipt),
    });
  }

  captureWorkerLifecycleRequest(
    method: string,
    args: unknown[]
  ): WorkerLifecycleRequest | undefined {
    try {
      if (method === "runtime.createEntity") {
        const [spec] = parseServiceMethodArgs(
          "runtime",
          "createEntity",
          runtimeMethods.createEntity,
          args
        );
        if (spec.kind !== "do" && spec.kind !== "worker") return undefined;
        return {
          method,
          ...(spec.kind === "do"
            ? { kind: "do" as const, className: spec.className }
            : { kind: "worker" as const }),
          ...(spec.key === undefined ? {} : { objectKey: spec.key }),
        };
      }
      if (method === "workers.resolveDurableObject") {
        parseServiceMethodArgs(
          "workers",
          "resolveDurableObject",
          workersMethods.resolveDurableObject,
          args
        );
        return { method };
      }
      if (method === "workers.resolveService") {
        const [query] = parseServiceMethodArgs(
          "workers",
          "resolveService",
          workersMethods.resolveService,
          args
        );
        return { method, query };
      }
      if (method === "runtime.retireEntity") {
        const [request] = parseServiceMethodArgs(
          "runtime",
          "retireEntity",
          runtimeMethods.retireEntity,
          args
        );
        return { method, entityId: request.id };
      }
    } catch {
      // Receipt capture must not change the RPC's actual validation/dispatch result.
    }
    return undefined;
  }

  recordWorkerLifecycle(
    request: WorkerLifecycleRequest | undefined,
    result: unknown,
    callId: number
  ): void {
    if (this.closed) return;
    if (!request) return;
    let receipt: EvalWorkerLifecycleObservation;
    if (request.method === "runtime.createEntity") {
      const entity = runtimeMethods.createEntity.returns!.parse(result);
      if (entity.kind !== request.kind) return;
      const creation = {
        protocol: "worker-lifecycle-observation.v1" as const,
        callId,
        operation: "create" as const,
        entityId: entity.id,
        targetId: entity.targetId,
        source: entity.source.repoPath,
        ...(request.objectKey === undefined ? {} : { objectKey: request.objectKey }),
      };
      receipt =
        request.kind === "do"
          ? { ...creation, kind: "do", className: request.className }
          : { ...creation, kind: "worker" };
    } else if (request.method === "workers.resolveDurableObject") {
      const target = workersMethods.resolveDurableObject.returns!.parse(result);
      receipt = {
        protocol: "worker-lifecycle-observation.v1",
        callId,
        operation: "resolve",
        targetId: target.targetId,
        source: target.source,
        className: target.className,
        objectKey: target.objectKey,
      };
    } else if (request.method === "workers.resolveService") {
      const service = workersMethods.resolveService.returns!.parse(result);
      // Regular-worker service resolutions are HTTP routes, not RPC receivers.
      if (service.kind !== "durable-object") return;
      receipt = {
        protocol: "worker-lifecycle-observation.v1",
        callId,
        operation: "resolve-service",
        query: request.query,
        serviceName: service.name,
        targetId: service.targetId,
        source: service.source,
        className: service.className,
        objectKey: service.objectKey,
      };
    } else if (request.method === "runtime.retireEntity") {
      runtimeMethods.retireEntity.returns!.parse(result);
      receipt = {
        protocol: "worker-lifecycle-observation.v1",
        callId,
        operation: "retire",
        entityId: request.entityId,
      };
    } else return;
    this.append({
      type: "worker.lifecycle",
      receipt: evalWorkerLifecycleObservationSchema.parse(receipt),
    });
  }

  recordExtensionInvocation(method: string, args: unknown[], result: unknown): void {
    if (this.closed) return;
    let target:
      | Pick<
          Extract<NativeExtensionInvocationObservation, { transport: "invoke" }>,
          "transport" | "extensionKey"
        >
      | Pick<
          Extract<NativeExtensionInvocationObservation, { transport: "invokeProvider" }>,
          "transport" | "providerKey"
        >;
    let invokedMethod: string;
    if (method === "extensions.invoke") {
      const [extensionKey, publicMethod] = parseServiceMethodArgs(
        "extensions",
        "invoke",
        extensionsMethods.invoke,
        args
      );
      target = { transport: "invoke", extensionKey };
      invokedMethod = publicMethod;
    } else if (method === "extensions.invokeProvider") {
      const [providerKey, providerMethod] = parseServiceMethodArgs(
        "extensions",
        "invokeProvider",
        extensionsMethods.invokeProvider,
        args
      );
      target = { transport: "invokeProvider", providerKey };
      invokedMethod = providerMethod;
    } else return;
    const returned = extensionsMethods.invoke.returns!.parse(result);
    const shape: NativeExtensionInvocationObservation["result"] =
      returned === null
        ? { kind: "null" }
        : Array.isArray(returned)
          ? { kind: "array", length: returned.length }
          : typeof returned === "object"
            ? { kind: "object", keyCount: Object.keys(returned).length }
            : typeof returned === "string"
              ? { kind: "string", length: returned.length }
              : typeof returned === "number"
                ? { kind: "number" }
                : { kind: "boolean" };
    this.append({
      type: "extension.invocation",
      receipt: NativeExtensionInvocationObservationSchema.parse({
        protocol: "extension-invocation-observation.v1",
        ...target,
        method: invokedMethod,
        result: shape,
      }),
    });
  }

  recordWebhookOperation(method: string, args: unknown[], result: unknown): void {
    if (this.closed) return;
    const protocol = "webhook-observation.v1" as const;
    let receipt: NativeWebhookObservation;
    if (method === "webhookIngress.createSubscription") {
      const subscription = webhookIngressMethods.createSubscription.returns!.parse(result);
      receipt = {
        protocol,
        method: "createSubscription",
        subscriptionId: subscription.subscriptionId,
        hasSecret: subscription.verifier.hasSecret,
      };
    } else if (method === "webhookIngress.listSubscriptions") {
      const options = parseServiceMethodArgs(
        "webhookIngress",
        "listSubscriptions",
        webhookIngressMethods.listSubscriptions,
        args
      )[0];
      const subscriptions = webhookIngressMethods.listSubscriptions.returns!.parse(result);
      receipt = {
        protocol,
        method: "listSubscriptions",
        includeRevoked: options?.includeRevoked ?? false,
        subscriptions: subscriptions.map(({ subscriptionId, revokedAt }) => ({
          subscriptionId,
          revoked: revokedAt !== undefined,
        })),
      };
    } else if (method === "webhookIngress.rotateSecret") {
      const [input] = parseServiceMethodArgs(
        "webhookIngress",
        "rotateSecret",
        webhookIngressMethods.rotateSecret,
        args
      );
      const rotated = webhookIngressMethods.rotateSecret.returns!.parse(result);
      if (rotated.subscription.subscriptionId !== input.subscriptionId)
        throw new Error("Webhook secret rotation returned a different subscription identity");
      receipt = {
        protocol,
        method: "rotateSecret",
        subscriptionId: rotated.subscription.subscriptionId,
        secretPresent: rotated.secret.length > 0,
      };
    } else if (method === "webhookIngress.revokeSubscription") {
      const [input] = parseServiceMethodArgs(
        "webhookIngress",
        "revokeSubscription",
        webhookIngressMethods.revokeSubscription,
        args
      );
      // A void operation has no result payload to validate. Successful RPC
      // completion is authoritative; JSON transports encode absence as null.
      receipt = { protocol, method: "revokeSubscription", subscriptionId: input.subscriptionId };
    } else return;
    this.append({
      type: "webhook.observation",
      receipt: NativeWebhookObservationSchema.parse(receipt),
    });
  }

  recordPermissionInventory(method: string, args: unknown[], result: unknown): void {
    if (this.closed || method !== "permissions.list") return;
    parseServiceMethodArgs("permissions", "list", permissionsMethods.list, args);
    const grants = permissionsMethods.list.returns!.parse(result);
    const counts = { capability: 0, "credential-use": 0, "browser-site": 0 };
    for (const grant of grants) counts[grant.kind]++;
    this.append({
      type: "permissions.inventory",
      receipt: NativePermissionInventoryObservationSchema.parse({
        protocol: "permission-inventory-observation.v1",
        method,
        total: grants.length,
        counts,
      }),
    });
  }

  recordRuntimeHealth(method: string, args: unknown[], result: unknown): void {
    if (this.closed || method !== "runtime.supervision.health") return;
    const [identity, options] = parseServiceMethodArgs(
      "runtime",
      "supervision.health",
      runtimeMethods["supervision.health"],
      args
    );
    const health = runtimeMethods["supervision.health"].returns!.parse(result);
    const sameIdentity = (candidate: typeof identity) =>
      candidate.kind === identity.kind && candidate.entityId === identity.entityId;
    if (
      !sameIdentity(health.entity.identity) ||
      !health.logs.every((entry) => sameIdentity(entry.identity)) ||
      !health.errors.every((entry) => sameIdentity(entry.identity))
    )
      throw new Error("Runtime health read returned a different supervised entity identity");
    const limit = options?.limit ?? health.capacity.entries;
    const errorLimit = options?.errorLimit ?? health.capacity.errors;
    if (health.logs.length > limit || health.errors.length > errorLimit) {
      throw new Error("Runtime health read returned more records than its reported bounds");
    }
    this.append({
      type: "runtime.health",
      receipt: NativeRuntimeHealthObservationSchema.parse({
        protocol: "runtime-health-observation.v1",
        identity,
        source: health.entity.source,
        logCount: health.logs.length,
        errorCount: health.errors.length,
        limit,
        errorLimit,
        dropped: health.dropped,
        capacity: health.capacity,
      }),
    });
  }

  recordRuntimeUnits(method: string, result: unknown): void {
    if (
      this.closed ||
      !["runtime.supervision.list", "runtime.supervision.describe"].includes(method)
    )
      return;
    const entities =
      method === "runtime.supervision.list"
        ? runtimeMethods["supervision.list"].returns!.parse(result)
        : runtimeMethods["supervision.describe"].returns!.parse(result);
    this.append({
      type: "runtime.units",
      receipt: NativeRuntimeUnitObservationSchema.parse({
        protocol: "runtime-unit-observation.v1",
        method,
        entities: entities.map(({ identity, source, status }) => ({ identity, source, status })),
      }),
    });
  }

  recordCredentialResolution(method: string, args: unknown[], result: unknown): void {
    if (this.closed || method !== "credentials.resolveCredential") return;
    const request = parseServiceMethodArgs(
      "credentials",
      "resolveCredential",
      credentialsMethods.resolveCredential,
      args
    );
    const resolved = credentialsMethods.resolveCredential.returns!.parse(result);
    this.append({
      type: "credentials.resolution",
      receipt: NativeCredentialResolutionObservationSchema.parse({
        protocol: "credential-resolution-observation.v1",
        method,
        requestDigest: sha256HexSyncText(JSON.stringify(request)),
        found: resolved !== null,
      }),
    });
  }

  recordNotificationLifecycle(method: string, args: unknown[], result: unknown): void {
    if (this.closed) return;
    const protocol = "notification-lifecycle-observation.v1" as const;
    let receipt;
    if (method === "notification.show") {
      const [input] = parseServiceMethodArgs(
        "notification",
        "show",
        notificationMethods.show,
        args
      );
      const notificationId = notificationMethods.show.returns!.parse(result);
      receipt = {
        protocol,
        method,
        notificationId,
        actionLabels: (input.actions ?? []).map((action) => action.label),
      };
    } else if (method === "notification.dismiss") {
      const [notificationId] = parseServiceMethodArgs(
        "notification",
        "dismiss",
        notificationMethods.dismiss,
        args
      );
      receipt = { protocol, method, notificationId };
    } else return;
    this.append({
      type: "notification.lifecycle",
      receipt: NativeNotificationLifecycleObservationSchema.parse(receipt),
    });
  }

  recordBlobTreeOperation(method: string, args: unknown[], result: unknown): void {
    if (this.closed) return;
    const protocol = "blob-tree-observation.v1" as const;
    let receipt: NativeBlobTreeObservation;
    if (method === "blobstore.putTree") {
      const stored = blobstoreMethods.putTree.returns!.parse(result);
      receipt = { protocol, method: "putTree", ...stored };
    } else if (method === "blobstore.listTree") {
      const [ref] = parseServiceMethodArgs("blobstore", "listTree", blobstoreMethods.listTree, [
        args[0],
        args[1],
      ]);
      receipt = {
        protocol,
        method: "listTree",
        ref,
        page: blobstoreMethods.listTree.returns!.parse(result),
      };
    } else if (method === "blobstore.diffTrees") {
      const [from, to] = parseServiceMethodArgs(
        "blobstore",
        "diffTrees",
        blobstoreMethods.diffTrees,
        args
      );
      receipt = {
        protocol,
        method: "diffTrees",
        from,
        to,
        diff: blobstoreMethods.diffTrees.returns!.parse(result),
      };
    } else if (method === "blobstore.materializeTree") {
      const [ref] = parseServiceMethodArgs(
        "blobstore",
        "materializeTree",
        blobstoreMethods.materializeTree,
        [args[0], args[1], args[2]]
      );
      receipt = {
        protocol,
        method: "materializeTree",
        ref,
        ...blobstoreMethods.materializeTree.returns!.parse(result),
      };
    } else return;
    this.append({
      type: "blob-tree.observation",
      receipt: NativeBlobTreeObservationSchema.parse(receipt),
    });
  }

  recordBlobTextOperation(method: string, args: unknown[], result: unknown): void {
    if (this.closed) return;
    let receipt: NativeBlobTextObservation;
    const protocol = "blob-text-observation.v1" as const;
    if (method === "blobstore.putText") {
      const [text] = parseServiceMethodArgs("blobstore", "putText", blobstoreMethods.putText, args);
      const stored = blobstoreMethods.putText.returns!.parse(result);
      receipt = {
        protocol,
        method: "putText",
        ...stored,
        contentDigest: sha256HexSyncText(text),
        lineCount: text.split(/\r?\n/u).length,
      };
    } else if (method === "blobstore.getText") {
      const [digest] = parseServiceMethodArgs(
        "blobstore",
        "getText",
        blobstoreMethods.getText,
        args
      );
      const text = blobstoreMethods.getText.returns!.parse(result);
      receipt = {
        protocol,
        method: "getText",
        digest,
        contentDigest: text === null ? null : sha256HexSyncText(text),
        size: text === null ? null : new TextEncoder().encode(text).length,
      };
    } else if (method === "blobstore.getRange") {
      const [digest, offset, length] = parseServiceMethodArgs(
        "blobstore",
        "getRange",
        blobstoreMethods.getRange,
        args
      );
      const text = blobstoreMethods.getRange.returns!.parse(result);
      receipt = {
        protocol,
        method: "getRange",
        digest,
        offset,
        length,
        present: text !== null,
        decodedSize: text === null ? null : new TextEncoder().encode(text).length,
      };
    } else if (method === "blobstore.grep") {
      const [digest, , options] = parseServiceMethodArgs(
        "blobstore",
        "grep",
        blobstoreMethods.grep,
        [args[0], args[1], args[2]]
      );
      const matches = blobstoreMethods.grep.returns!.parse(result);
      receipt = {
        protocol,
        method: "grep",
        digest,
        matchCount: matches === null ? null : matches.length,
        maxMatches: options?.maxMatches ?? 50,
      };
    } else return;
    this.append({
      type: "blob-text.observation",
      receipt: NativeBlobTextObservationSchema.parse(receipt),
    });
  }

  recordServerLogRead(method: string, args: unknown[], result: unknown): void {
    if (this.closed) return;
    let receipt: NativeServerLogObservation;
    if (method === "serverLog.stats") {
      const stats = serverLogMethods.stats.returns!.parse(result);
      receipt = {
        protocol: "server-log-observation.v1",
        kind: "stats",
        latestSeq: stats.latestSeq,
        totalCaptured: stats.totalCaptured,
        bufferSize: stats.bufferSize,
        byLevel: stats.byLevel,
      };
    } else if (method === "serverLog.tail" || method === "serverLog.query") {
      const kind = method === "serverLog.tail" ? "tail" : "query";
      const resultSchema =
        kind === "tail" ? serverLogMethods.tail.returns! : serverLogMethods.query.returns!;
      const envelope = resultSchema.parse(result);
      const query =
        kind === "query"
          ? parseServiceMethodArgs("serverLog", "query", serverLogMethods.query, [args[0]])[0]
          : undefined;
      const tailLimit =
        kind === "tail"
          ? parseServiceMethodArgs("serverLog", "tail", serverLogMethods.tail, [args[0]])[0]
          : undefined;
      const byLevel = { verbose: 0, info: 0, warn: 0, error: 0 };
      for (const row of envelope.records) byLevel[row.level]++;
      receipt = {
        protocol: "server-log-observation.v1",
        kind: "records",
        method: kind,
        limit: tailLimit ?? query?.limit ?? 500,
        ...(query?.level ? { minimumLevel: query.level } : {}),
        serverBootId: envelope.serverBootId,
        latestSeq: envelope.latestSeq,
        firstSeq: envelope.records[0]?.seq ?? null,
        lastSeq: envelope.records.at(-1)?.seq ?? null,
        count: envelope.records.length,
        byLevel,
        newestLevel: envelope.records.at(-1)?.level ?? null,
      };
    } else return;
    this.append({
      type: "server-log.observation",
      receipt: NativeServerLogObservationSchema.parse(receipt),
    });
  }

  recordBuildProfile(profile: BuildPerformanceProfileWire): void {
    this.append({
      type: "build.profile",
      receipt: {
        version: profile.version,
        source: profile.source,
        ref: profile.ref,
        startedAt: profile.startedAt,
        firstRun: { ...profile.firstRun },
        verifiedCacheRun: profile.verifiedCacheRun ? { ...profile.verifiedCacheRun } : null,
        report: {
          repoPath: profile.report.repoPath,
          kind: profile.report.kind,
          status: profile.report.status,
          stateHash: profile.report.stateHash,
          diagnostics: profile.report.diagnostics.map(({ severity }) => ({ severity })),
          builds: profile.report.builds.map(({ target, buildKey }) => ({ target, buildKey })),
        },
        targets: profile.targets.map(
          ({
            target,
            buildKey,
            artifactCount,
            artifactBytes,
            executableModuleCount,
            executableSourceBytes,
            bundleReport,
          }) => ({
            target,
            buildKey,
            artifactCount,
            artifactBytes,
            executableModuleCount,
            executableSourceBytes,
            ...(bundleReport
              ? { bundleReport: { initial: { bytes: bundleReport.initial.bytes } } }
              : {}),
          })
        ),
      },
    });
  }

  close(): EvalOperationJournal {
    this.closed = true;
    return {
      protocol: "workspace-operations.v1",
      entries: this.entries,
      truncated: this.truncated,
    };
  }
}
