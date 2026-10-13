import { canonicalJson } from "@vibestudio/content-addressing";
import type { NativeInvocationIdentity } from "@vibestudio/rpc";
import {
  localModelRuntimeMethods,
  PREPARE_NATIVE_LOCAL_MODEL_AUTHORITY_RESOLVER,
  type PrepareNativeLocalModelParams,
} from "@vibestudio/service-schemas/localModelRuntime";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import { describeCapability } from "@vibestudio/shared/authorityPresentation";
import {
  preparedAuthorityPayload,
  selectedPreparedAuthoritySelection,
  type ServiceDefinition,
} from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceContext, VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";

export interface ActiveNativeInvocationFact {
  nativeInvocation: NativeInvocationIdentity;
  active: boolean;
}

export type ResolveActiveNativeInvocation = (
  caller: VerifiedCaller
) => Promise<ActiveNativeInvocationFact | null>;

interface PreparedLocalModel {
  request: PrepareNativeLocalModelParams;
  resourceKey: string;
}

export interface LocalModelRuntimeServiceDeps {
  resolveNativeInvocation: ResolveActiveNativeInvocation;
  ensureLoaded(modelId: string, signal?: AbortSignal): Promise<unknown>;
}

export function exactActiveLocalModel(
  caller: VerifiedCaller,
  fact: ActiveNativeInvocationFact | null,
  request?: PrepareNativeLocalModelParams
): { modelId: string; endpoint: string | null } {
  const locator = caller.nativeInvocation;
  if (
    !locator ||
    !fact?.active ||
    canonicalJson(fact.nativeInvocation) !== canonicalJson(locator) ||
    locator.operation.kind !== "model" ||
    locator.operation.providerId !== "local"
  ) {
    throw new Error(
      "Local model runtime preparation requires its active authenticated native invocation"
    );
  }
  if (
    request &&
    (request.providerId !== "local" ||
      request.modelId !== locator.operation.modelId ||
      request.endpoint !== locator.operation.endpoint)
  ) {
    throw new Error("Requested local model does not match the active native model task");
  }
  return {
    modelId: locator.operation.modelId,
    endpoint: locator.operation.endpoint,
  };
}

export function createLocalModelRuntimeService(
  deps: LocalModelRuntimeServiceDeps
): ServiceDefinition {
  const prepare = async (
    ctx: ServiceContext,
    request: PrepareNativeLocalModelParams
  ): Promise<PreparedLocalModel> => {
    const model = exactActiveLocalModel(
      ctx.caller,
      await deps.resolveNativeInvocation(ctx.caller),
      request
    );
    return {
      request,
      resourceKey: `model:local/${encodeURIComponent(model.modelId)}@runtime`,
    };
  };

  return {
    name: "localModelRuntime",
    description: "Host-owned preparation and secret injection for native local-model inference",
    authority: { principals: ["user", "code", "host", "website"] },
    methods: localModelRuntimeMethods,
    authorityPreparation: {
      [PREPARE_NATIVE_LOCAL_MODEL_AUTHORITY_RESOLVER]: async (ctx, [rawRequest]) => {
        const prepared = await prepare(ctx, rawRequest as PrepareNativeLocalModelParams);
        const copy = describeCapability("model.use");
        const label = `local/${prepared.request.modelId}`;
        return {
          selections: [
            selectedPreparedAuthoritySelection({
              capability: "model.use",
              resourceKey: prepared.resourceKey,
              resource: { kind: "exact", key: prepared.resourceKey },
              requirement: requirementForPrincipals(
                ["website", "user", "host", "code"],
                "model.use"
              ),
              tier: "gated",
              challenge: {
                title: copy.title,
                description: "Allow this exact local model to run on the connected device.",
                deniedReason: "Using this local model was not allowed",
                dedupKey: `native-model:${ctx.caller.runtime.id}:${prepared.resourceKey}`,
                resource: {
                  type: "model",
                  label: "Local model",
                  value: label,
                },
                operation: {
                  kind: "unknown",
                  verb: copy.action,
                  object: {
                    type: "model",
                    label: "Local model",
                    value: label,
                  },
                  groupKey: `native-model:${ctx.caller.runtime.id}:${prepared.resourceKey}`,
                },
                authorityVocabulary: {
                  domain: "automation",
                  verb: "act",
                  declaredBy: "vibestudio/host",
                },
                allowedDecisions: ["once", "session", "always", "deny"],
              },
            }),
          ],
          payload: prepared,
        };
      },
    },
    handler: defineServiceHandler("localModelRuntime", localModelRuntimeMethods, {
      prepareNativeModel: async (ctx, [request]) => {
        const prepared = preparedAuthorityPayload<PreparedLocalModel>(
          ctx,
          PREPARE_NATIVE_LOCAL_MODEL_AUTHORITY_RESOLVER
        );
        if (canonicalJson(prepared.request) !== canonicalJson(request)) {
          throw new Error("Prepared local model target does not match the admitted request");
        }
        exactActiveLocalModel(ctx.caller, await deps.resolveNativeInvocation(ctx.caller), request);
        const loaded = await deps.ensureLoaded(request.modelId, ctx.signal);
        if (
          !loaded ||
          typeof loaded !== "object" ||
          Array.isArray(loaded) ||
          typeof (loaded as Record<string, unknown>)["baseUrl"] !== "string"
        ) {
          throw new Error("Local model provider returned no concrete endpoint");
        }
        return {
          baseUrl: (loaded as { baseUrl: string }).baseUrl,
        };
      },
    }),
  };
}
