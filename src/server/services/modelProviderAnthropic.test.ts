import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { ConnectCredentialParamsSchema } from "@vibestudio/service-schemas/credentials";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import { toCredentialConnectRequest } from "@vibestudio/shared/providerConnect";
import { createApprovalQueue } from "./approvalQueue";
import {
  createCredentialConnectionCoordinator,
  type CredentialConnectionCoordinatorDeps,
} from "./credentialConnectionCoordinator";

afterEach(() => vi.unstubAllGlobals());

function fixture(
  onPrompt: (queue: ReturnType<typeof createApprovalQueue>) => void,
  signal?: AbortSignal
) {
  const caller = createVerifiedCaller("app:test", "app");
  const ctx: ServiceContext = {
    caller,
    connectionId: "connection",
    signal,
    wsClient: { caller, ws: null, connectionId: "connection", authenticated: true },
  };
  const queue = createApprovalQueue({
    eventService: {
      emitProjected: () => {
        queueMicrotask(() => onPrompt(queue));
      },
    } as never,
    scopeAccess: { isMember: () => true, isAdmin: () => true },
  });
  let authUrl: URL | undefined;
  const emitToConnection = vi.fn<
    NonNullable<CredentialConnectionCoordinatorDeps["eventService"]>["emitToConnection"]
  >((_caller, _connection, event, payload) => {
    if (
      event === "external-open:open" &&
      payload &&
      typeof payload === "object" &&
      "url" in payload &&
      typeof payload.url === "string"
    )
      authUrl = new URL(payload.url);
    return true;
  });
  const storeCredential = vi.fn<CredentialConnectionCoordinatorDeps["storeCredential"]>(
    async (_ctx, request) => ({
      id: "saved",
      label: request.label,
      audience: request.audience.map((entry) => ({ ...entry, match: entry.match ?? "origin" })),
      injection: request.injection,
      scopes: [],
      lifecycle: { state: "active", canRefresh: true },
      metadata: request.metadata,
    })
  );
  const coordinator = createCredentialConnectionCoordinator({
    credentialStore: { loadUrlBound: vi.fn(), saveUrlBound: vi.fn() },
    clientConfigStore: { load: vi.fn() },
    approvalQueue: queue,
    eventService: { emitToConnection, emitToCaller: vi.fn(() => true) },
    storeCredential,
    resolveApprovalIdentity: () => ({
      callerId: "app:test",
      repoPath: "test",
      effectiveVersion: "v1",
    }),
    requestCredentialApproval: async () => "session",
    loadActiveCredential: vi.fn(),
    authorizeCredentialSubjectUse: vi.fn(),
    findReplacementCandidate: async () => null,
    validateCredentialBindings: vi.fn(),
    appendAudit: vi.fn(),
  });
  return {
    queue,
    storeCredential,
    url: () => authUrl!,
    connect: () =>
      coordinator.connect(
        ctx,
        ConnectCredentialParamsSchema.parse(
          toCredentialConnectRequest("anthropic", { browser: "external" })
        )
      ),
  };
}

it("uses native Claude copy-code PKCE and keeps renewable provider state private", async () => {
  const wireApprovals: unknown[] = [];
  const fetchToken = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          access_token: "access",
          refresh_token: "private-refresh",
          expires_in: 3600,
        })
      )
  );
  vi.stubGlobal("fetch", fetchToken);
  const f = fixture((queue) => {
    const pending = queue.listPending()[0];
    if (pending?.kind !== "credential-input") return;
    wireApprovals.push(JSON.parse(JSON.stringify(pending)));
    const field = pending.fields[0]!;
    if (field.type === "select") {
      expect(pending.browserSignIn).toBeUndefined();
      expect(field.options.map((option) => option.id)).toEqual(["browser", "copy_code"]);
      void queue.submitCredentialInput(pending.approvalId, { value: "copy_code" });
    } else {
      expect(pending.browserSignIn).toEqual({
        browser: "external",
        callbackExpected: false,
        instructions:
          "Complete login in your browser, then copy the code Anthropic shows and paste it here.",
      });
      void queue.submitCredentialInput(pending.approvalId, {
        value: "auth-code#" + f.url().searchParams.get("state"),
      });
    }
  });
  const result = await f.connect();
  expect(shellApprovalMethods.listPending.returns.parse(wireApprovals)).toEqual(wireApprovals);
  const url = f.url();
  expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
  expect(url.searchParams.get("code")).toBe("true");
  expect(url.searchParams.get("redirect_uri")).toBe(
    "https://platform.claude.com/oauth/code/callback"
  );
  const [endpoint, init] = fetchToken.mock.calls[0]!;
  const body = JSON.parse(String(init!.body));
  expect(endpoint).toBe("https://platform.claude.com/v1/oauth/token");
  expect(body).toMatchObject({
    code: "auth-code",
    state: url.searchParams.get("state"),
    code_verifier: url.searchParams.get("state"),
    redirect_uri: url.searchParams.get("redirect_uri"),
    client_id: url.searchParams.get("client_id"),
    grant_type: "authorization_code",
  });
  expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(
    url.searchParams.get("code_challenge")
  );
  expect(f.storeCredential.mock.calls[0]![1]).toMatchObject({
    material: { token: "access" },
    modelProviderSession: { providerId: "anthropic", credential: { refresh: "private-refresh" } },
  });
  expect(JSON.stringify(result)).not.toContain("private-refresh");
  expect(f.queue.listPending()).toEqual([]);
});

it("cancels native sign-in and removes its still-actionable method prompt", async () => {
  const controller = new AbortController();
  const f = fixture((queue) => {
    if (queue.listPending().length) controller.abort(new Error("Caller cancelled"));
  }, controller.signal);
  await expect(f.connect()).rejects.toMatchObject({ code: "approval_denied" });
  expect(f.storeCredential).not.toHaveBeenCalled();
  expect(f.queue.listPending()).toEqual([]);
});

it("completes browser login through pi's loopback callback and retires manual input", async () => {
  const nativeFetch = globalThis.fetch;
  const fetchToken = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          access_token: "browser-access",
          refresh_token: "browser-refresh",
          expires_in: 3600,
        })
      )
  );
  vi.stubGlobal("fetch", fetchToken);
  let callback: Promise<Response> | undefined;
  const f = fixture((queue) => {
    const pending = queue.listPending()[0];
    if (pending?.kind !== "credential-input") return;
    if (pending.fields[0]!.type === "select") {
      void queue.submitCredentialInput(pending.approvalId, { value: "browser" });
    } else if (!callback) {
      expect(shellApprovalMethods.listPending.returns.parse([pending])).toEqual([pending]);
      expect(pending.browserSignIn).toMatchObject({ browser: "external", callbackExpected: true });
      expect(pending.browserSignIn?.instructions).toContain("paste the final redirect URL");
      expect(pending.fields[0]!.required).toBe(true);
      const url = new URL(f.url().searchParams.get("redirect_uri")!);
      expect(url.hostname).toBe("localhost");
      expect(url.pathname).toBe("/callback");
      url.searchParams.set("code", "browser-code");
      url.searchParams.set("state", f.url().searchParams.get("state")!);
      callback = nativeFetch(url);
    }
  });
  const result = await f.connect();
  expect((await callback!).ok).toBe(true);
  const [endpoint, init] = fetchToken.mock.calls[0]!;
  const body = JSON.parse(String(init!.body));
  expect(endpoint).toBe("https://platform.claude.com/v1/oauth/token");
  expect(new Headers(init!.headers).get("content-type")).toBe("application/json");
  expect(body).toMatchObject({
    code: "browser-code",
    redirect_uri: f.url().searchParams.get("redirect_uri"),
    state: f.url().searchParams.get("state"),
    code_verifier: f.url().searchParams.get("state"),
    client_id: f.url().searchParams.get("client_id"),
    grant_type: "authorization_code",
  });
  expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(
    f.url().searchParams.get("code_challenge")
  );
  expect(f.storeCredential.mock.calls[0]![1]).toMatchObject({
    material: { type: "bearer-token", token: "browser-access" },
    modelProviderSession: { providerId: "anthropic", credential: { refresh: "browser-refresh" } },
    metadata: { modelProviderId: "anthropic", modelAuthMethod: "subscription" },
  });
  expect(JSON.stringify(result)).not.toContain("browser-refresh");
  expect(f.queue.listPending()).toEqual([]);
  expect(f.storeCredential).toHaveBeenCalledOnce();
});

it("propagates Claude's token exchange rejection without storing a credential", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("invalid_grant", { status: 400 }))
  );
  const f = fixture((queue) => {
    const pending = queue.listPending()[0];
    if (pending?.kind !== "credential-input") return;
    void queue.submitCredentialInput(pending.approvalId, {
      value: pending.fields[0]!.type === "select" ? "copy_code" : "auth-code",
    });
  });
  await expect(f.connect()).rejects.toThrow("invalid_grant");
  expect(f.storeCredential).not.toHaveBeenCalled();
  expect(f.queue.listPending()).toEqual([]);
});
