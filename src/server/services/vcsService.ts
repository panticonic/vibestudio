/**
 * Canonical semantic VCS service.
 *
 * This boundary performs principal/context authorization and preserves the
 * exact causal ingress edge.
 * GAD owns revision resolution, semantic planning, graph mutation, proof, and
 * publication orchestration.  The host is deliberately unable to recreate a
 * merge, split one workspace mutation into repository loops, or reinterpret a
 * state hash as ancestry.
 */
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler, mapServiceHandlers } from "@vibestudio/shared/serviceHandlers";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import type { RpcCausalParent } from "@vibestudio/rpc";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import {
  parseVcsSemanticRequest,
  vcsMethods,
  vcsOperationContextId,
  vcsOperationRegistry,
  type VcsMethodName,
} from "@vibestudio/service-schemas/vcs";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import { isAuthorizedChrome } from "./chromeTrust.js";

export interface VcsServiceDeps {
  workspaceVcs: WorkspaceVcs;
  entityCache?: Pick<EntityCache, "resolveContext" | "resolveActive">;
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  listOwnedContexts?: (input: { contextId: string }) => Promise<{
    contexts: Array<{
      contextId: string;
      kind?: "lifecycle" | "lineage";
      ownerEntityId?: string | null;
    }>;
  }>;
}

type CausalRequest<T> = {
  input: T;
  ingress: {
    causalParent: RpcCausalParent | null;
    contextIntegrity: {
      class: "internal" | "external";
      externalKeys: readonly string[];
    };
  };
};

function effectiveCallerId(ctx: ServiceContext): string {
  return ctx.caller.runtime.kind === "extension" && ctx.chainCaller
    ? ctx.chainCaller.callerId
    : ctx.caller.runtime.id;
}

function unauthorizedBinding(message: string): never {
  throw new ServiceError("vcs", "authorize", message, "EACCES", undefined, "access", {
    code: "Unauthorized",
    message,
    operation: "resolve-context",
  });
}

function verifiedAgentBinding(
  ctx: ServiceContext,
  deps: VcsServiceDeps
): {
  entityId: string;
  contextId: string;
  channelId: string;
} | null {
  if (ctx.caller.runtime.kind === "agent") {
    if (ctx.caller.agentBinding) return ctx.caller.agentBinding;
    return unauthorizedBinding("Agent caller has no verified entity binding");
  }
  const relay = deps.entityCache?.resolveActive(ctx.caller.runtime.id)?.agentBinding ?? null;
  return relay;
}

function callerContextId(ctx: ServiceContext, deps: VcsServiceDeps): string | null {
  const binding = verifiedAgentBinding(ctx, deps);
  if (binding) return binding.contextId;
  return deps.entityCache?.resolveContext(effectiveCallerId(ctx)) ?? null;
}

function callerContextAuthorities(ctx: ServiceContext, deps: VcsServiceDeps): string[] {
  const contexts = new Set<string>();
  const primary = callerContextId(ctx, deps);
  if (primary) contexts.add(primary);
  // An extension invocation carries both the verified upstream code identity
  // and the extension runtime principal. The former owns ordinary caller
  // work; the latter may own infrastructure lifecycle contexts it created.
  if (ctx.caller.runtime.kind === "extension") {
    const extensionContext = deps.entityCache?.resolveContext(ctx.caller.runtime.id) ?? null;
    if (extensionContext) contexts.add(extensionContext);
  }
  return [...contexts];
}

function privileged(ctx: ServiceContext, deps: VcsServiceDeps): boolean {
  return isAuthorizedChrome(ctx.caller, { hasAppCapability: deps.hasAppCapability });
}

function isCallerTrajectoryRoot(
  ctx: ServiceContext,
  deps: VcsServiceDeps,
  reference: { kind: string; value: unknown }
): boolean {
  if (reference.kind !== "node" || !isRecord(reference.value)) return false;
  const rootKind = reference.value["kind"];
  if (
    rootKind !== "trajectory" &&
    rootKind !== "trajectory-invocation" &&
    rootKind !== "trajectory-turn" &&
    rootKind !== "trajectory-message"
  ) {
    return false;
  }
  const binding = verifiedAgentBinding(ctx, deps);
  if (!binding) return false;
  const own = channelTrajectoryFor(binding.channelId);
  return reference.value["logId"] === own.logId && reference.value["head"] === own.head;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function authorizeContext(
  ctx: ServiceContext,
  deps: VcsServiceDeps,
  contextId: string,
  operation: "read" | "write"
): Promise<void> {
  const authorityRoots = callerContextAuthorities(ctx, deps);
  if (authorityRoots.includes(contextId) || privileged(ctx, deps)) return;
  const owned = await Promise.all(
    authorityRoots.map(async (root) => ({
      root,
      contexts: (await deps.listOwnedContexts?.({ contextId: root }))?.contexts ?? [],
    }))
  );
  if (operation === "write") {
    const ownerEntityIds = new Set([effectiveCallerId(ctx), ctx.caller.runtime.id]);
    const exactLifecycleOwnership = owned.some(({ contexts }) =>
      contexts.some(
        (entry) =>
          entry.contextId === contextId &&
          entry.kind === "lifecycle" &&
          entry.ownerEntityId != null &&
          ownerEntityIds.has(entry.ownerEntityId)
      )
    );
    if (exactLifecycleOwnership) return;
    const message = "The requested context is outside the caller's authority for writes";
    throw new ServiceError("vcs", "authorize", message, "EACCES", undefined, "access", {
      code: "Unauthorized",
      message,
      operation: "context-write",
    });
  }
  if (authorityRoots.length === 0) {
    const message = "The caller has no context read authority";
    throw new ServiceError("vcs", "authorize", message, "EACCES", undefined, "access", {
      code: "Unauthorized",
      message,
      operation: "context-read",
    });
  }
  if (owned.some(({ contexts }) => contexts.some((entry) => entry.contextId === contextId))) return;
  const message = "The requested context is outside the caller's reachable context graph";
  throw new ServiceError("vcs", "authorize", message, "EACCES", undefined, "access", {
    code: "Unauthorized",
    message,
    operation: "context-read",
  });
}

async function reachableContextAuthorities(
  ctx: ServiceContext,
  deps: VcsServiceDeps
): Promise<string[]> {
  const roots = callerContextAuthorities(ctx, deps);
  const owned = await Promise.all(
    roots.map((contextId) => deps.listOwnedContexts?.({ contextId }))
  );
  return [
    ...new Set([
      ...roots,
      ...owned.flatMap((result) => result?.contexts.map(({ contextId }) => contextId) ?? []),
    ]),
  ].sort();
}

function ingressFor(ctx: ServiceContext): CausalRequest<never>["ingress"] {
  const fact = ctx.authorization?.contextIntegrity;
  if (!fact) {
    throw new ServiceError(
      "vcs",
      "ingress",
      "Semantic VCS ingress requires resolved context-integrity authority",
      "EACCES"
    );
  }
  return {
    causalParent: ctx.causalParent ?? null,
    contextIntegrity:
      fact.class === "external"
        ? { class: "external", externalKeys: [...fact.externalKeys] }
        : { class: "internal", externalKeys: [] },
  };
}

export function createVcsService(deps: VcsServiceDeps): ServiceDefinition {
  const invoke = async <T>(ctx: ServiceContext, method: string, input: unknown): Promise<T> => {
    const ingress = ingressFor(ctx);
    if (method === "vcsPush") {
      return ctx.signal
        ? deps.workspaceVcs.semanticPublishCall<T>(
            input,
            ingress.causalParent,
            ctx.caller,
            ingress.contextIntegrity,
            ctx.signal
          )
        : deps.workspaceVcs.semanticPublishCall<T>(
            input,
            ingress.causalParent,
            ctx.caller,
            ingress.contextIntegrity
          );
    }
    return deps.workspaceVcs.semanticCall<T>(method, {
      input,
      ingress,
    } satisfies CausalRequest<unknown>);
  };

  const invokeOperation = async (
    ctx: ServiceContext,
    method: VcsMethodName,
    input: unknown
  ): Promise<unknown> => {
    const parsed = parseVcsSemanticRequest(method, input);
    const operation = vcsOperationRegistry[method];
    const isMutation =
      operation.accessClass === "context-write" || operation.accessClass === "workspace-write";
    if (isMutation && verifiedAgentBinding(ctx, deps) && !ctx.causalParent) {
      const message = "Agent-bound VCS mutation requires an exact causal tool invocation";
      throw new ServiceError("vcs", method, message, "EACCES", undefined, "access", {
        code: "Unauthorized",
        message,
        operation: "causal-ingress",
      });
    }
    const primaryContextId = vcsOperationContextId(method, parsed.input);
    if (primaryContextId !== null) {
      await authorizeContext(ctx, deps, primaryContextId, isMutation ? "write" : "read");
    }

    const readableContexts = [
      ...new Set(
        parsed.references
          .filter(({ kind, value }) => kind === "context" && value !== primaryContextId)
          .map(({ value }) => value)
          .filter((value): value is string => typeof value === "string")
      ),
    ].sort();
    await Promise.all(
      readableContexts.map((contextId) => authorizeContext(ctx, deps, contextId, "read"))
    );

    const exactRoots = parsed.references
      .filter(({ kind }) => kind === "state-node" || kind === "event" || kind === "node")
      .map(({ kind, value }) => ({ kind, value }));
    const guardedRoots = exactRoots.filter(
      (reference) => !isCallerTrajectoryRoot(ctx, deps, reference)
    );
    if (guardedRoots.length > 0 && !privileged(ctx, deps)) {
      const contextIds = await reachableContextAuthorities(ctx, deps);
      if (!(await deps.workspaceVcs.referencesReachable(contextIds, guardedRoots))) {
        const message = "An exact semantic root is outside the caller's reachable context graph";
        throw new ServiceError("vcs", method, message, "EACCES", undefined, "access", {
          code: "Unauthorized",
          message,
          operation: "semantic-root-read",
        });
      }
    }

    const dispatchMethod = `vcs${method.charAt(0).toUpperCase()}${method.slice(1)}`;
    return invoke(ctx, dispatchMethod, parsed.input);
  };

  const handlers = mapServiceHandlers(vcsMethods, (method, ctx, args) =>
    invokeOperation(ctx, method, args[0])
  );

  return {
    name: "vcs",
    description:
      "One provenance-native workspace history: direct state nodes, local incremental integration, whole-chain commit/discard, explicit move/copy, and protected publication.",
    authority: { principals: ["user", "code", "host"] },
    methods: vcsMethods,
    handler: defineServiceHandler("vcs", vcsMethods, handlers),
  };
}
