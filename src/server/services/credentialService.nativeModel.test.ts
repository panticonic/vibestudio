import { nativeInvocationIdentity } from "@vibestudio/service-schemas/nativeInvocation";
import {
  credentialsMethods,
  RESOLVE_NATIVE_MODEL_AUTHORITY_RESOLVER,
  ResolveNativeModelCredentialParamsSchema,
} from "@vibestudio/service-schemas/credentials";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
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
const nativeInvocation = nativeInvocationIdentity({
  owner: {
    ...source.owner,
    contextId: "context:one",
    incarnation: "storage:one",
    channelId: "channel:one",
    source: "workers/agent",
    effectiveVersion: "version:one",
    className: "Agent",
    objectKey: "one",
    executionDigest: "a".repeat(64),
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

describe("native model credential admission", () => {
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
