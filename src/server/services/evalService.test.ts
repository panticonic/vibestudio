import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { EVAL_DO_SOURCE, productSeedExecutionDigest } from "../internalDOs/productBootManifest.js";
import { createEvalService } from "./evalService.js";
import {
  DevHostEvalAuthorityIssuer,
  type DevEvalGenerationIdentity,
} from "./devHostEvalAuthority.js";

const EXECUTION_DIGEST = productSeedExecutionDigest(EVAL_DO_SOURCE);
const SOURCE_DIGEST = "s".repeat(64);
const PROVENANCE_DIGEST = "p".repeat(64);
const caller = createVerifiedCaller("do:workers/agent:Agent:one", "do");
const source = { kind: "inline" as const, code: "return 42;" };

function evalKey(ownerId: string, scopeKey: string): string {
  return createHash("sha256").update(`${ownerId}\0${scopeKey}`).digest("hex").slice(0, 40);
}

function harness(
  options: {
    needsStart?: boolean;
    delegatedAuthority?: {
      parentHostId: string;
      publicKeySpki: string;
      generation: DevEvalGenerationIdentity;
      recipientPrivateKey: string;
    };
    preauthorize?: (signal: AbortSignal) => Promise<void>;
    prepareError?: Error;
    execute?: (runId: string) => Promise<unknown>;
  } = {}
) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const terminal = { success: true, console: "ok", returnValue: 42 };
  const doDispatch = {
    dispatch: vi.fn(async (_ref: unknown, method: string, ...args: unknown[]) => {
      calls.push({ method, args });
      if (method === "accept") {
        const accepted = args[0] as { runId: string; startIntentDigest: string };
        return {
          runId: accepted.runId,
          status: "accepted",
          acceptedAt: 10,
          startIntentDigest: accepted.startIntentDigest,
          needsStart: options.needsStart ?? true,
        };
      }
      if (method === "begin") return { status: "queued" };
      if (method === "prepare") {
        if (options.prepareError) throw options.prepareError;
        return {
          sourceDigest: SOURCE_DIGEST,
          executionProvenanceDigest: PROVENANCE_DIGEST,
          scopeInputRevision: "scope-1",
        };
      }
      if (method === "awaitPreauthorization") return { status: "awaiting-preauthorization" };
      if (method === "activate") return { status: "preparing" };
      if (method === "execute") return options.execute?.(String(args[0])) ?? terminal;
      if (method === "attachAuthoritySummary") return { ...terminal, authority: args[1] };
      if (method === "get") return { runId: args[0], status: "running" };
      if (method === "events") return { events: [], next: args[1] };
      if (method === "cancel") return { status: "requested" };
      if (method === "terminate") {
        return { status: (args[0] as { status: string }).status };
      }
      if (method === "reset" || method === "forceReset") return { status: "reset" };
      if (method === "readScopeTextPage") {
        return { length: 3, encoding: "utf16le-base64", chunk: "YQBiAGMA" };
      }
      if (method === "deleteScopeValue") return { ok: true, existed: true };
      if (method === "onEvalComplete") return undefined;
      throw new Error(`unexpected dispatch ${method}`);
    }),
    dispatchHeld: vi.fn(async (ref: unknown, method: string, ...args: unknown[]) =>
      doDispatch.dispatch(ref, method, ...args)
    ),
  };
  const entityStore = {
    cache: {
      resolveActive: vi.fn(() => null),
      resolve: vi.fn(() => null),
    },
    resolveContext: vi.fn(async (id: string) => (id === "missing" ? null : "ctx-1")),
    activate: vi.fn(async () => undefined),
    resolveSlotByEntity: vi.fn(async () => undefined),
    resolveRecord: vi.fn(async () => null),
  };
  const coordinator = {
    issuePreparation: vi.fn(() => ({
      runId: "run-1",
      credential: "preparation-credential",
      policy: { mode: "adaptive", effects: "mutable", approvals: "prompt", requests: [] },
    })),
    finalize: vi.fn(() => ({
      runId: "run-1",
      runDigest: "run-digest",
      credential: "run-credential",
      invocationPrincipal: "invocation:run-1",
      policy: { mode: "adaptive", effects: "mutable", approvals: "prompt", requests: [] },
      manifestDigest: "manifest-digest",
    })),
    authoritySummary: vi.fn(() => ({ requested: 0, granted: 0, reused: 0, denied: 0 })),
    invalidate: vi.fn(),
    invalidateObject: vi.fn(),
    renew: vi.fn(() => ({ expiresAt: Date.now() + 30_000 })),
    beginCleanup: vi.fn(() => ({ expiresAt: Date.now() + 30_000 })),
  };
  const preauthorize = vi.fn(async (input: { signal: AbortSignal }) => {
    await options.preauthorize?.(input.signal);
  });
  const activity = { begin: vi.fn(), end: vi.fn(() => finish()) };
  const service = createEvalService({
    doDispatch: doDispatch as never,
    entityStore: entityStore as never,
    invocationCoordinator: coordinator as never,
    preauthorize,
    activity: activity as never,
    ...(options.delegatedAuthority ? { delegatedAuthority: options.delegatedAuthority } : {}),
  });
  return { service, calls, coordinator, doDispatch, entityStore, preauthorize, activity, settled };
}

describe("createEvalService", () => {
  it("binds one accepted handle to the verified owner and executes the unified lifecycle", async () => {
    const h = harness();
    const result = await h.service.handler({ caller }, "start", [
      { source, scope: { key: "channel-1" }, idempotencyKey: "turn-1" },
    ]);
    expect(result).toMatchObject({ status: "accepted", acceptedAt: 10 });
    await h.settled;

    const objectKey = evalKey(caller.runtime.id, "channel-1");
    expect(h.entityStore.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "do",
        source: { repoPath: EVAL_DO_SOURCE },
        activeExecutionDigest: EXECUTION_DIGEST,
        contextId: "ctx-1",
        key: objectKey,
        parentId: caller.runtime.id,
      })
    );
    expect(h.calls.map((call) => call.method)).toEqual([
      "accept",
      "begin",
      "prepare",
      "activate",
      "execute",
      "attachAuthoritySummary",
    ]);
    expect(h.coordinator.invalidate).toHaveBeenCalledWith(
      (result as { runId: string }).runId,
      objectKey
    );
  });

  it("returns an idempotent accepted handle without starting a second invocation", async () => {
    const h = harness({ needsStart: false });
    await h.service.handler({ caller }, "start", [
      { source, scope: { key: "default" }, idempotencyKey: "same" },
    ]);
    expect(h.coordinator.issuePreparation).not.toHaveBeenCalled();
    expect(h.calls.map((call) => call.method)).toEqual(["accept"]);
  });

  it("does not mint a preparation lease until a queued run owns its scope", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let execution = 0;
    const h = harness({
      execute: async () => {
        execution += 1;
        if (execution === 1) await firstBlocked;
        return { success: true, console: "ok", returnValue: execution };
      },
    });

    await h.service.handler({ caller }, "start", [
      { source, scope: { key: "shared" }, idempotencyKey: "first" },
    ]);
    await vi.waitFor(() => expect(h.coordinator.issuePreparation).toHaveBeenCalledTimes(1));
    await h.service.handler({ caller }, "start", [
      { source, scope: { key: "shared" }, idempotencyKey: "second" },
    ]);

    expect(h.coordinator.issuePreparation).toHaveBeenCalledTimes(1);
    releaseFirst();
    await vi.waitFor(() => expect(h.coordinator.issuePreparation).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.activity.end).toHaveBeenCalledTimes(2));
  });

  it("uses RPC delivery correlation for agent completion independently of logical idempotency", async () => {
    const h = harness();
    await h.service.handler({ caller, idempotencyKey: "tool-call-7" }, "start", [
      {
        source,
        scope: { key: "channel-1" },
        channelId: "channel-1",
        idempotencyKey: "logical-run",
      },
    ]);
    await h.settled;

    expect(h.calls.find((call) => call.method === "onEvalComplete")?.args[0]).toMatchObject({
      invocationId: "tool-call-7",
    });
  });

  it("preauthorizes canonical call intents before activation", async () => {
    const h = harness();
    await h.service.handler({ caller }, "start", [
      {
        source,
        authority: {
          preauthorize: [{ plane: "host-service", method: "fs.readFile", args: ["README.md"] }],
        },
      },
    ]);
    await h.settled;
    expect(h.preauthorize).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.any(String),
        credential: "run-credential",
        readOnly: false,
      })
    );
    const methods = h.calls.map((call) => call.method);
    expect(methods.indexOf("awaitPreauthorization")).toBeLessThan(methods.indexOf("activate"));
  });

  it("aborts a pending preauthorization when the run deadline expires", async () => {
    let observedSignal: AbortSignal | null = null;
    const h = harness({
      preauthorize: (signal) => {
        observedSignal = signal;
        return new Promise<void>((_resolve, reject) => {
          const rejectFromAbort = () => reject(signal.reason);
          if (signal.aborted) rejectFromAbort();
          else signal.addEventListener("abort", rejectFromAbort, { once: true });
        });
      },
    });
    await h.service.handler({ caller }, "start", [
      {
        source,
        deadlineMs: 20,
        authority: {
          preauthorize: [{ plane: "host-service", method: "fs.readFile", args: ["README.md"] }],
        },
      },
    ]);
    await h.settled;

    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(h.calls.find((call) => call.method === "terminate")?.args[0]).toMatchObject({
      status: "expired",
      errorCode: "EVAL_INVOCATION_EXPIRED",
    });
    expect(h.calls.map((call) => call.method)).not.toContain("activate");
    expect(h.coordinator.invalidate).toHaveBeenCalled();
  });

  it("preserves deterministic preparation failures instead of reporting process loss", async () => {
    const failure = Object.assign(new Error("source bundle is too large"), {
      code: "EVAL_RESOURCE_LIMIT",
    });
    const h = harness({ prepareError: failure });
    await h.service.handler({ caller }, "start", [{ source }]);
    await h.settled;

    expect(h.calls.find((call) => call.method === "terminate")?.args[0]).toMatchObject({
      status: "failed",
      error: "source bundle is too large",
      errorCode: "EVAL_RESOURCE_LIMIT",
    });
  });

  it("routes lifecycle reads and cancellation through the owner-derived EvalDO", async () => {
    const h = harness({ needsStart: false });
    await h.service.handler({ caller }, "get", [{ runId: "run-1", scope: { key: "x" } }]);
    await h.service.handler({ caller }, "events", [
      { runId: "run-1", scope: { key: "x" }, after: 7 },
    ]);
    await h.service.handler({ caller }, "cancel", [{ runId: "run-1", scope: { key: "x" } }]);
    expect(h.calls.map((call) => call.method)).toEqual(["get", "events", "cancel"]);
    expect(h.coordinator.invalidate).toHaveBeenCalledWith("run-1", evalKey(caller.runtime.id, "x"));
    expect(h.doDispatch.dispatch.mock.invocationCallOrder.at(-1)).toBeLessThan(
      h.coordinator.invalidate.mock.invocationCallOrder.at(-1)!
    );
  });

  it("invalidates every scope lease after reset and force-reset cleanup settles", async () => {
    const h = harness({ needsStart: false });
    const objectKey = evalKey(caller.runtime.id, "x");
    await h.service.handler({ caller }, "reset", [{ scope: { key: "x" } }]);
    await h.service.handler({ caller }, "forceReset", [{ scope: { key: "x" } }]);
    expect(h.coordinator.invalidateObject).toHaveBeenNthCalledWith(1, objectKey);
    expect(h.coordinator.invalidateObject).toHaveBeenNthCalledWith(2, objectKey);
    expect(h.calls.map((call) => call.method)).toEqual(["reset", "forceReset"]);
    expect(h.doDispatch.dispatch.mock.invocationCallOrder.at(-1)).toBeLessThan(
      h.coordinator.invalidateObject.mock.invocationCallOrder.at(-1)!
    );
  });

  it("only renews a lease for the matching EvalDO kernel", async () => {
    const h = harness({ needsStart: false });
    const objectKey = "scope-object";
    const credential = "c".repeat(43);
    const evalCaller = createVerifiedCaller(`do:${EVAL_DO_SOURCE}:EvalDO:${objectKey}`, "do");
    await expect(
      h.service.handler({ caller: evalCaller }, "renew", [{ runId: "run-1", credential }])
    ).resolves.toEqual(expect.objectContaining({ expiresAt: expect.any(Number) }));
    expect(h.coordinator.renew).toHaveBeenCalledWith({
      runId: "run-1",
      credential,
      objectKey,
    });
    await expect(
      h.service.handler({ caller }, "renew", [{ runId: "run-1", credential }])
    ).rejects.toThrow("active EvalDO kernel");
  });

  it("only opens the cleanup phase for the matching EvalDO kernel", async () => {
    const h = harness({ needsStart: false });
    const objectKey = "scope-object";
    const credential = "c".repeat(43);
    const evalCaller = createVerifiedCaller(`do:${EVAL_DO_SOURCE}:EvalDO:${objectKey}`, "do");
    await expect(
      h.service.handler({ caller: evalCaller }, "beginCleanup", [{ runId: "run-1", credential }])
    ).resolves.toEqual(expect.objectContaining({ expiresAt: expect.any(Number) }));
    expect(h.coordinator.beginCleanup).toHaveBeenCalledWith({
      runId: "run-1",
      credential,
      objectKey,
    });
    await expect(
      h.service.handler({ caller }, "beginCleanup", [{ runId: "run-1", credential }])
    ).rejects.toThrow("active EvalDO kernel");
  });

  it("rejects attached-session authority overrides from ordinary entities", async () => {
    const h = harness({ needsStart: false });
    await expect(
      h.service.handler({ caller }, "start", [
        {
          source,
          target: { kind: "attached-session", ownerId: "other", contextId: "ctx-2" },
        },
      ])
    ).rejects.toThrow("restricted to shell/server callers");
  });

  it("accepts a managed child start only from the signed original initiator", async () => {
    const generation: DevEvalGenerationIdentity = {
      launchId: "launch-1",
      hostBuildId: "build-1",
      childServerId: "child-1",
      processIdentity: "123:boot",
      childWorkspaceId: "workspace-1",
      childContextId: "unbound",
      recipientPublicKey: "",
    };
    const recipient = generateKeyPairSync("x25519");
    generation.recipientPublicKey = recipient.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url");
    const recipientPrivateKey = recipient.privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64url");
    const issuer = new DevHostEvalAuthorityIssuer("parent:boot");
    const initiator = createVerifiedCaller("worker:agent", "worker", {
      callerId: "worker:agent",
      callerKind: "worker",
      repoPath: "workers/agent",
      executionDigest: "b".repeat(64),
      requested: [],
      delegations: [],
    });
    const input = { source };
    const authority = issuer.issue({ generation, initiator, start: input });
    const approvalRoute = issuer.issueApprovalRoute({ generation, authority });
    const h = harness({
      delegatedAuthority: {
        parentHostId: issuer.parentHostId,
        publicKeySpki: issuer.publicKeySpki,
        generation,
        recipientPrivateKey,
      },
    });
    await h.service.handler({ caller }, "delegatedStart", [{ input, authority, approvalRoute }]);
    expect(h.coordinator.issuePreparation).toHaveBeenCalledWith(
      expect.objectContaining({ initiator })
    );
  });

  it("maps replay of one delegated authority envelope to the same durable run", async () => {
    const recipient = generateKeyPairSync("x25519");
    const generation: DevEvalGenerationIdentity = {
      launchId: "launch-replay",
      hostBuildId: "build-1",
      childServerId: "child-1",
      processIdentity: "125:boot",
      childWorkspaceId: "workspace-1",
      childContextId: "unbound",
      recipientPublicKey: recipient.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64url"),
    };
    const issuer = new DevHostEvalAuthorityIssuer("parent:boot");
    const input = { source };
    const authority = issuer.issue({ generation, initiator: caller, start: input });
    const approvalRoute = issuer.issueApprovalRoute({ generation, authority });
    const h = harness({
      needsStart: false,
      delegatedAuthority: {
        parentHostId: issuer.parentHostId,
        publicKeySpki: issuer.publicKeySpki,
        generation,
        recipientPrivateKey: recipient.privateKey
          .export({ type: "pkcs8", format: "der" })
          .toString("base64url"),
      },
    });

    const first = await h.service.handler({ caller }, "delegatedStart", [
      { input, authority, approvalRoute },
    ]);
    const replay = await h.service.handler({ caller }, "delegatedStart", [
      { input, authority, approvalRoute },
    ]);

    expect(replay).toMatchObject({ runId: (first as { runId: string }).runId });
    expect(h.calls.filter((call) => call.method === "accept").map((call) => call.args[0])).toEqual([
      expect.objectContaining({ runId: (first as { runId: string }).runId }),
      expect.objectContaining({ runId: (first as { runId: string }).runId }),
    ]);
  });

  it("refuses prompt-capable managed child eval before source preparation when no route is live", async () => {
    const recipient = generateKeyPairSync("x25519");
    const generation: DevEvalGenerationIdentity = {
      launchId: "launch-route-loss",
      hostBuildId: "build-1",
      childServerId: "child-1",
      processIdentity: "124:boot",
      childWorkspaceId: "workspace-1",
      childContextId: "unbound",
      recipientPublicKey: recipient.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64url"),
    };
    const issuer = new DevHostEvalAuthorityIssuer("parent:boot");
    const input = { source };
    const authority = issuer.issue({ generation, initiator: caller, start: input });
    const h = harness({
      delegatedAuthority: {
        parentHostId: issuer.parentHostId,
        publicKeySpki: issuer.publicKeySpki,
        generation,
        recipientPrivateKey: recipient.privateKey
          .export({ type: "pkcs8", format: "der" })
          .toString("base64url"),
      },
    });

    await expect(
      h.service.handler({ caller }, "delegatedStart", [{ input, authority }])
    ).rejects.toMatchObject({ code: "EVAL_APPROVAL_ROUTE_LOST" });
    expect(h.coordinator.issuePreparation).not.toHaveBeenCalled();
  });
});
