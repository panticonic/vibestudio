import { describe, expect, it, vi } from "vitest";
import { nativeInvocationIdentity } from "@vibestudio/service-schemas/nativeInvocation";
import {
  localModelRuntimeMethods,
  PREPARE_NATIVE_LOCAL_MODEL_AUTHORITY_RESOLVER,
} from "@vibestudio/service-schemas/localModelRuntime";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createLocalModelRuntimeService } from "./localModelRuntimeService.js";

const request = {
  providerId: "local" as const,
  modelId: "lfm2.5-1.2b",
  endpoint: null,
};
const nativeInvocation = nativeInvocationIdentity({
  owner: {
    runtimeId: "do:workers/agent:Agent:one",
    authoritySessionId: "lifetime:one",
    contextId: "context:one",
    incarnation: "storage:one",
    channelId: "channel:one",
    source: "workers/agent",
    effectiveVersion: "version:one",
    className: "Agent",
    objectKey: "one",
    executionDigest: "a".repeat(64),
  },
  task: { conversationId: 4, taskId: 23, kind: "pi.model", version: 1 },
  operation: {
    kind: "model",
    purpose: "generation",
    attempt: 1,
    cutoff: 13,
    providerId: request.providerId,
    modelId: request.modelId,
    endpoint: request.endpoint,
    requestDigest: "b".repeat(64),
  },
});
const caller = {
  ...createVerifiedCaller(nativeInvocation.owner.runtimeId, "do"),
  nativeInvocation,
  causalParent: {
    kind: "trajectory-invocation" as const,
    logId: "log:one",
    head: "head:one",
    invocationId: "invocation:one",
  },
};

function fixture() {
  const resolveNativeInvocation = vi.fn(async () => ({
    nativeInvocation,
    active: true,
  }));
  const ensureLoaded = vi.fn(async () => ({
    baseUrl: "http://127.0.0.1:43117/v1",
  }));
  const service = createLocalModelRuntimeService({
    resolveNativeInvocation,
    ensureLoaded,
  });
  const ctx: ServiceContext = { caller };
  const prepare = service.authorityPreparation![PREPARE_NATIVE_LOCAL_MODEL_AUTHORITY_RESOLVER]!;
  return { service, ctx, prepare, resolveNativeInvocation, ensureLoaded };
}

describe("native local model preparation", () => {
  it("exposes one typed website contract and prepares the exact local model", async () => {
    expect(localModelRuntimeMethods.prepareNativeModel.website.kind).toBe("eligible");
    const { prepare, ctx, resolveNativeInvocation } = fixture();
    const state = await prepare(ctx, [request]);
    expect(resolveNativeInvocation).toHaveBeenCalledWith(caller);
    expect(state.selections).toHaveLength(1);
    expect(state.selections[0]).toMatchObject({
      capability: "model.use",
      resourceKey: "model:local/lfm2.5-1.2b@runtime",
      challenge: {
        resource: { value: "local/lfm2.5-1.2b" },
      },
    });
  });

  it("revalidates the active task before starting the provider", async () => {
    const { service, ctx, prepare, ensureLoaded, resolveNativeInvocation } = fixture();
    const prepared = await prepare(ctx, [request]);
    ctx.preparedAuthority = {
      resolver: PREPARE_NATIVE_LOCAL_MODEL_AUTHORITY_RESOLVER,
      digest: "approved",
      payload: prepared.payload,
    };
    await expect(service.handler(ctx, "prepareNativeModel", [request])).resolves.toEqual({
      baseUrl: "http://127.0.0.1:43117/v1",
    });
    expect(ensureLoaded).toHaveBeenCalledWith(request.modelId, undefined);

    resolveNativeInvocation.mockResolvedValue({
      nativeInvocation,
      active: false,
    });
    await expect(service.handler(ctx, "prepareNativeModel", [request])).rejects.toThrow(
      "requires its active authenticated native invocation"
    );
    expect(ensureLoaded).toHaveBeenCalledTimes(1);
  });

  it("rejects caller-selected model and endpoint substitutions", async () => {
    const { prepare, ctx } = fixture();
    await expect(prepare(ctx, [{ ...request, modelId: "other" }])).rejects.toThrow(
      "does not match the active native model task"
    );
    await expect(prepare(ctx, [{ ...request, endpoint: "http://127.0.0.1:9/v1" }])).rejects.toThrow(
      "does not match the active native model task"
    );
  });
});
