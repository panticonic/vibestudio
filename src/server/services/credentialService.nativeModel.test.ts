import { nativeInvocationIdentity } from "@vibestudio/service-schemas/nativeInvocation";
import {
  credentialsMethods,
  RESOLVE_NATIVE_MODEL_AUTHORITY_RESOLVER,
  ResolveNativeModelCredentialParamsSchema,
} from "@vibestudio/service-schemas/credentials";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  type AuthorityAcquirer,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import { parseUnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import { testAuthority } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { describe, expect, it, vi } from "vitest";
import { createCredentialService } from "./credentialService.js";

const request = {
  providerId: "openai",
  modelId: "gpt-test",
  endpoint: "https://api.example.test/v1",
};
const source = {
  owner: { runtimeId: "do:workers/agent:Agent:one", authoritySessionId: "lifetime:one" },
  task: { conversationId: 4, taskId: 23 },
  operation: {
    kind: "model" as const,
    purpose: "generation" as const,
    attempt: 1,
    cutoff: 13,
    providerId: request.providerId,
    modelId: request.modelId,
    endpoint: request.endpoint,
  },
};
const workerImage = {
  source: "workers/agent",
  effectiveVersion: "version:one",
  executionDigest: "a".repeat(64),
};
const nativeInvocation = nativeInvocationIdentity({
  owner: {
    ...source.owner,
    contextId: "context:one",
    incarnation: "storage:one",
    channelId: "channel:one",
    ...workerImage,
    className: "Agent",
    objectKey: "one",
  },
  task: { ...source.task, kind: "pi.model", version: 1 },
  operation: { ...source.operation, requestDigest: "b".repeat(64) },
});
const caller = {
  ...createVerifiedCaller(source.owner.runtimeId, "do"),
  nativeInvocation,
  causalParent: {
    kind: "trajectory-invocation" as const,
    logId: "log:one",
    head: "head:one",
    invocationId: "invocation:one",
  },
};
const credential = {
  id: "credential:one",
  providerId: "url-bound",
  connectionId: "connection:one",
  connectionLabel: "OpenAI account",
  label: "OpenAI account",
  accountIdentity: { providerUserId: "acct-1" },
  accessToken: "secret",
  scopes: [],
  metadata: { modelProviderId: "openai" },
  bindings: [
    {
      id: "model-fetch",
      use: "fetch" as const,
      audience: [{ url: request.endpoint, match: "exact" as const }],
      injection: {
        type: "header" as const,
        name: "authorization",
        valueTemplate: "Bearer {token}",
      },
    },
  ],
};

function fixture() {
  const resolveNativeInvocation = vi.fn(async () => ({ nativeInvocation, active: true }));
  const service = createCredentialService({
    credentialStore: {
      listUrlBound: async () => [credential],
      loadUrlBound: async (id: string) => (id === credential.id ? credential : null),
    } as never,
    resolveNativeInvocation,
  });
  const prepare = service.authorityPreparation![RESOLVE_NATIVE_MODEL_AUTHORITY_RESOLVER]!;
  return { service, prepare, resolveNativeInvocation };
}

function dispatchFixture(options: { declaresModelUse?: boolean; connected?: boolean } = {}) {
  const authority = parseUnitAuthorityManifest(
    {
      requests: options.declaresModelUse
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
    },
    "workers/agent/package.json vibestudio.authority"
  );
  const code = {
    callerId: source.owner.runtimeId,
    callerKind: "do" as const,
    repoPath: workerImage.source,
    effectiveVersion: workerImage.effectiveVersion,
    executionDigest: workerImage.executionDigest,
    requested: authority.requests,
  };
  const workerCaller = {
    ...createVerifiedCaller(source.owner.runtimeId, "do", code),
    nativeInvocation,
    causalParent: caller.causalParent,
  };
  const storedCredential = {
    ...credential,
    // Existing credential consent remains independent of model authorization.
    grants: [
      {
        scope: "version" as const,
        repoPath: code.repoPath,
        effectiveVersion: code.effectiveVersion,
        bindingId: "model-fetch",
        use: "fetch" as const,
        resource: request.endpoint,
        action: "use" as const,
        grantedAt: 1,
        grantedBy: "user:one",
      },
    ],
  };
  const resolveNativeInvocation = vi.fn(async () => ({ nativeInvocation, active: true }));
  const service = createCredentialService({
    credentialStore: {
      listUrlBound: async () => (options.connected === false ? [] : [storedCredential]),
      loadUrlBound: async (id: string) => (id === storedCredential.id ? storedCredential : null),
    } as never,
    resolveNativeInvocation,
  });
  const handler = vi.spyOn(service, "handler");
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
    approvedResources.add(input.snapshot.resourceKey);
    return { state: "decided", decision: "version" };
  });
  const requestApproval = vi.fn<AuthorityAcquirer["request"]>();
  dispatcher.setAuthorityAcquirer({
    acquire,
    request: requestApproval,
    consume: vi.fn(() => false),
    invalidate: vi.fn(),
  });
  dispatcher.registerService(service);
  dispatcher.markInitialized();
  const ctx: ServiceContext = { caller: workerCaller, authorityAcquisition: "wait" };
  const dispatch = (params = request) =>
    dispatcher.dispatch(ctx, "credentials", "resolveNativeModel", [params]);
  return { ctx, dispatch, acquire, requestApproval, handler, resolveNativeInvocation };
}

describe("native model credential admission", () => {
  it("denies an undeclared model capability before invoking credential resolution", async () => {
    const f = dispatchFixture();
    await expect(f.dispatch()).rejects.toMatchObject({
      code: "EACCES",
      errorData: {
        authorityFailure: { reasonCode: "fixed-code-not-requested", capability: "model.use" },
      },
    });
    expect(f.resolveNativeInvocation).toHaveBeenCalledOnce();
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.requestApproval).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();
  });

  it("acquires only the declared exact model/account before returning a secret-free credential", async () => {
    const f = dispatchFixture({ declaresModelUse: true });
    await expect(f.dispatch()).resolves.toMatchObject({ id: credential.id });
    expect(f.acquire).toHaveBeenCalledOnce();
    expect(f.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          service: "credentials",
          method: "resolveNativeModel",
          capability: "model.use",
          resourceKey: "model:openai/gpt-test@openai%3Aacct-1",
        }),
        resource: { kind: "exact", key: "model:openai/gpt-test@openai%3Aacct-1" },
      }),
      undefined
    );
    expect(f.handler).toHaveBeenCalledOnce();
    expect(await f.dispatch()).not.toHaveProperty("accessToken");
    expect(f.acquire).toHaveBeenCalledOnce();
  });

  it("returns a canonical null miss for an active model with no connected account", async () => {
    const f = dispatchFixture({ connected: false });
    await expect(f.dispatch()).resolves.toBeNull();
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.handler).toHaveBeenCalledOnce();
  });

  it("rejects a model substitution through dispatch before acquisition or credential access", async () => {
    const f = dispatchFixture({ declaresModelUse: true });
    await expect(f.dispatch({ ...request, modelId: "other-model" })).rejects.toThrow(
      "does not match the active native model task"
    );
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();
  });

  it("rejects a tool invocation even when its worker declares model use", async () => {
    const f = dispatchFixture({ declaresModelUse: true });
    const toolInvocation = {
      ...nativeInvocation,
      operation: {
        kind: "tool" as const,
        assistantEntryId: 12,
        callId: "call:tool",
        name: "draft",
        argumentsDigest: "c".repeat(64),
      },
    } as typeof nativeInvocation;
    f.ctx.caller = { ...f.ctx.caller, nativeInvocation: toolInvocation };
    f.resolveNativeInvocation.mockResolvedValue({ nativeInvocation: toolInvocation, active: true });
    await expect(f.dispatch()).rejects.toThrow("does not match the active native model task");
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();
  });

  it("keeps generic website credential resolution closed and exposes only the native inference contract", () => {
    expect(credentialsMethods.resolveCredential.website.kind).toBe("closed");
    expect(credentialsMethods.resolveNativeModel.website.kind).toBe("eligible");
    expect(ResolveNativeModelCredentialParamsSchema.parse(request)).toEqual(request);
    expect(
      ResolveNativeModelCredentialParamsSchema.safeParse({ ...request, credentialId: "attacker" })
        .success
    ).toBe(false);
  });

  it("selects the account on the host and prepares one exact model/account model.use leaf", async () => {
    const { prepare, resolveNativeInvocation } = fixture();
    const state = await prepare({ caller }, [request]);
    expect(resolveNativeInvocation).toHaveBeenCalledWith(caller);
    expect(state.selections).toHaveLength(1);
    expect(state.selections[0]).toMatchObject({
      capability: "model.use",
      resourceKey: "model:openai/gpt-test@openai%3Aacct-1",
      requirement: expect.objectContaining({ kind: "any" }),
      challenge: {
        resource: { value: "openai/gpt-test · acct-1" },
        details: [
          { label: "Model", value: "openai/gpt-test" },
          { label: "Account", value: "acct-1" },
          { label: "Endpoint", value: request.endpoint },
        ],
      },
    });
  });

  it("rejects a caller target that differs from the active native model task", async () => {
    const { prepare } = fixture();
    await expect(prepare({ caller }, [{ ...request, modelId: "other-model" }])).rejects.toThrow(
      "does not match the active native model task"
    );
  });

  it("rejects non-model invocations before using caller-supplied model arguments", async () => {
    const { prepare, resolveNativeInvocation } = fixture();
    const toolInvocation = {
      ...nativeInvocation,
      operation: {
        kind: "tool" as const,
        assistantEntryId: 12,
        callId: "call:tool",
        name: "search",
        argumentsDigest: "c".repeat(64),
      },
    } as typeof nativeInvocation;
    resolveNativeInvocation.mockResolvedValue({ nativeInvocation: toolInvocation, active: true });
    const toolCaller = { ...caller, nativeInvocation: toolInvocation };
    await expect(prepare({ caller: toolCaller }, [request])).rejects.toThrow(
      "does not match the active native model task"
    );
  });

  it("rejects retired invocations before selecting or authorizing an account", async () => {
    const { prepare, resolveNativeInvocation } = fixture();
    resolveNativeInvocation.mockResolvedValue({ nativeInvocation, active: false });
    await expect(prepare({ caller }, [request])).rejects.toThrow(
      "requires its active authenticated invocation"
    );
  });
});
