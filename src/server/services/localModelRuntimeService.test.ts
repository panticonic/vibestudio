import { describe, expect, it, vi } from "vitest";
import { nativeInvocationIdentity } from "@vibestudio/service-schemas/nativeInvocation";
import {
  localModelRuntimeMethods,
  PREPARE_NATIVE_LOCAL_MODEL_AUTHORITY_RESOLVER,
} from "@vibestudio/service-schemas/localModelRuntime";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  type AuthorityAcquirer,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import { parseUnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import { testAuthority } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { createLocalModelRuntimeService } from "./localModelRuntimeService.js";

const request = {
  providerId: "local" as const,
  modelId: "lfm2.5-1.2b",
  endpoint: null,
};
const workerImage = {
  source: "workers/agent",
  effectiveVersion: "version:one",
  executionDigest: "a".repeat(64),
};
const nativeInvocation = nativeInvocationIdentity({
  owner: {
    runtimeId: "do:workers/agent:Agent:one",
    authoritySessionId: "lifetime:one",
    contextId: "context:one",
    incarnation: "storage:one",
    channelId: "channel:one",
    ...workerImage,
    className: "Agent",
    objectKey: "one",
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

function dispatchFixture(declaresModelUse: boolean) {
  const f = fixture();
  const authority = parseUnitAuthorityManifest({
    requests: declaresModelUse
      ? [
          {
            capability: "model.use",
            resource: { kind: "prefix", prefix: "model:" },
            tier: "gated",
            evidence: "bounded-dynamic",
          },
        ]
      : [],
    provides: [],
  });
  f.ctx.caller = {
    ...createVerifiedCaller(caller.runtime.id, "do", {
      callerId: caller.runtime.id,
      callerKind: "do",
      repoPath: workerImage.source,
      effectiveVersion: workerImage.effectiveVersion,
      executionDigest: workerImage.executionDigest,
      requested: authority.requests,
    }),
    nativeInvocation,
    causalParent: caller.causalParent,
  };
  f.ctx.authorityAcquisition = "wait";
  const dispatcher = new ServiceDispatcher();
  const approvedResources = new Set<string>();
  dispatcher.setAuthorityResolver(({ caller: author, capability, resourceKey }) => {
    const resolved = testAuthority(author, capability, resourceKey);
    return {
      ...resolved,
      grants:
        capability === "model.use" && !approvedResources.has(resourceKey) ? [] : resolved.grants,
    };
  });
  const acquire = vi.fn<AuthorityAcquirer["acquire"]>(async (input) => {
    expect(f.ensureLoaded).not.toHaveBeenCalled();
    approvedResources.add(input.snapshot.resourceKey);
    return { state: "decided", decision: "version" };
  });
  dispatcher.setAuthorityAcquirer({
    acquire,
    request: vi.fn(),
    consume: vi.fn(() => false),
    invalidate: vi.fn(),
  });
  dispatcher.registerService(f.service);
  dispatcher.markInitialized();
  return {
    ...f,
    acquire,
    dispatch: () =>
      dispatcher.dispatch(f.ctx, "localModelRuntime", "prepareNativeModel", [request]),
  };
}

describe("native local model preparation", () => {
  it("denies an undeclared local model before starting the runtime", async () => {
    const f = dispatchFixture(false);
    await expect(f.dispatch()).rejects.toMatchObject({
      code: "EACCES",
      errorData: {
        authorityFailure: { reasonCode: "fixed-code-not-requested", capability: "model.use" },
      },
    });
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.ensureLoaded).not.toHaveBeenCalled();
  });

  it("starts only the exact local model after acquiring its declared model authority", async () => {
    const f = dispatchFixture(true);
    await expect(f.dispatch()).resolves.toEqual({ baseUrl: "http://127.0.0.1:43117/v1" });
    expect(f.acquire).toHaveBeenCalledOnce();
    expect(f.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          capability: "model.use",
          resourceKey: "model:local/lfm2.5-1.2b@runtime",
        }),
        resource: { kind: "exact", key: "model:local/lfm2.5-1.2b@runtime" },
      }),
      undefined
    );
    expect(f.ensureLoaded).toHaveBeenCalledOnce();
    expect(f.ensureLoaded).toHaveBeenCalledWith(request.modelId, undefined);
  });

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
