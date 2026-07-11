import { describe, expect, it, vi } from "vitest";
import { ELECTRON_LOCAL_SERVICE_NAMES } from "@vibestudio/rpc";
import {
  createVerifiedCaller,
  ServiceAccessError,
  ServiceDispatcher,
  ServiceError,
} from "@vibestudio/shared/serviceDispatcher";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import {
  createUserlandApprovalService,
  EXTERNAL_APPROVAL_TIMEOUT_MS,
} from "./userlandApprovalService.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { UserlandApprovalGrant } from "@vibestudio/shared/approvals";

function createDeps() {
  const queued = vi.fn<ApprovalQueue["requestUserland"]>(async () => ({
    kind: "choice",
    choice: "allow",
  }));
  const requestExternalAgent = vi.fn<ApprovalQueue["requestExternalAgent"]>(async () => ({
    behavior: "allow",
  }));
  const settleExternalAgent = vi.fn<ApprovalQueue["settleExternalAgent"]>(() => 1);
  const lookup = vi.fn<
    (principal: unknown, subjectId: string, issuer?: unknown) => UserlandApprovalGrant | null
  >(() => null);
  const record = vi.fn(async () => {});
  const revoke = vi.fn(async () => true);
  const list = vi.fn<(principal: unknown, issuer?: unknown) => UserlandApprovalGrant[]>(() => []);
  const resolveRuntimeEntity = vi.fn(async (id: string) =>
    id === "do:workers/alpha:AlphaDO:agent-1"
      ? {
          id,
          kind: "do" as const,
          source: { repoPath: "workers/alpha", effectiveVersion: "hash-1" },
          contextId: "ctx-1",
          className: "AlphaDO",
          key: "agent-1",
          createdAt: 1,
          status: "active" as const,
          cleanupComplete: true,
          agentBinding: { entityId: "entity-1", contextId: "ctx-1", channelId: "channel-1" },
        }
      : null
  );
  const service = createUserlandApprovalService({
    approvalQueue: {
      requestUserland: queued,
      requestExternalAgent,
      settleExternalAgent,
    } as Partial<ApprovalQueue> as ApprovalQueue,
    grantStore: { lookup, record, revoke, list },
    resolveRuntimeEntity,
  });
  return {
    service,
    queued,
    requestExternalAgent,
    settleExternalAgent,
    lookup,
    record,
    revoke,
    list,
    resolveRuntimeEntity,
  };
}

const workerCtx: ServiceContext = {
  caller: createVerifiedCaller("worker:alpha", "worker", {
    callerId: "worker:alpha",
    callerKind: "worker",
    repoPath: "workers/alpha",
    effectiveVersion: "hash-1",
  }),
};
const doCtx: ServiceContext = {
  caller: createVerifiedCaller("do:workers/alpha:AlphaDO:agent-1", "do", {
    callerId: "do:workers/alpha:AlphaDO:agent-1",
    callerKind: "do",
    repoPath: "workers/alpha",
    effectiveVersion: "hash-1",
  }),
};
const extensionCtx: ServiceContext = {
  caller: createVerifiedCaller("@workspace-extensions/shell", "extension"),
  chainCaller: {
    callerId: "panel:alpha",
    callerKind: "panel",
    repoPath: "panels/alpha",
    effectiveVersion: "panel-hash",
  },
};
const validRequest = {
  subject: { id: "team-x:foo", label: "Team X foo" },
  title: "Allow foo?",
  summary: "Caller wants foo.",
  promptOptions: "choices" as const,
  options: [
    { value: "allow", label: "Allow", tone: "primary" as const },
    { value: "deny", label: "Deny", tone: "danger" as const },
  ],
};

describe("userlandApprovalService", () => {
  it("is routed to the server by default", () => {
    expect(ELECTRON_LOCAL_SERVICE_NAMES).not.toContain("userlandApproval");
  });

  it("allows panels, workers, DOs, and extensions but rejects shell/server through policy", async () => {
    const { service } = createDeps();
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(service);
    dispatcher.markInitialized();

    await expect(dispatcher.dispatch(workerCtx, "userlandApproval", "list", [])).resolves.toEqual(
      []
    );
    await expect(dispatcher.dispatch(doCtx, "userlandApproval", "list", [])).resolves.toEqual([]);
    await expect(
      dispatcher.dispatch(extensionCtx, "userlandApproval", "list", [])
    ).resolves.toEqual([]);
    await expect(
      dispatcher.dispatch(
        { caller: createVerifiedCaller("shell", "shell") },
        "userlandApproval",
        "list",
        []
      )
    ).rejects.toBeInstanceOf(ServiceAccessError);
  });

  it("rejects unknown caller identities", async () => {
    const { service } = createDeps();

    await expect(
      service.handler({ caller: createVerifiedCaller("worker:unknown", "worker") }, "request", [
        validRequest,
      ])
    ).rejects.toMatchObject({
      name: "ServiceError",
      code: "ENOENT",
    });
  });

  it("rejects caller kind mismatches with a typed error", async () => {
    const { service } = createDeps();
    const mismatchCtx: ServiceContext = {
      caller: createVerifiedCaller("worker:alpha", "worker", {
        callerId: "worker:alpha",
        callerKind: "panel",
        repoPath: "workers/alpha",
        effectiveVersion: "hash-1",
      }),
    };

    await expect(service.handler(mismatchCtx, "request", [validRequest])).rejects.toMatchObject({
      name: "ServiceError",
      code: "EACCES",
    });
  });

  it("validates reserved prefixes, zero-width bypasses, and duplicate options after stripping", () => {
    const { service } = createDeps();
    const schema = service.methods["request"]!.args;

    expect(() => schema.parse([{ ...validRequest, subject: { id: "shell:foo" } }])).toThrow(
      /reserved/
    );
    expect(() => schema.parse([{ ...validRequest, subject: { id: "shell\u200B:foo" } }])).toThrow(
      /reserved/
    );
    expect(() => schema.parse([{ ...validRequest, title: "bad\u0001title" }])).toThrow(/control/);
    expect(() =>
      schema.parse([
        {
          ...validRequest,
          options: [
            { value: "allow", label: "Allow" },
            { value: "al\u200Blow", label: "Allow again" },
          ],
        },
      ])
    ).toThrow(/unique/);
  });

  it("short-circuits queue prompts on cache hit", async () => {
    const { service, lookup, queued } = createDeps();
    lookup.mockReturnValueOnce({
      principal: {
        callerId: "worker:alpha",
        callerKind: "worker" as const,
        repoPath: "workers/alpha",
        effectiveVersion: "hash-1",
      },
      subject: { id: "team-x:foo" },
      choice: "allow",
      grantedAt: 10,
    });

    await expect(service.handler(workerCtx, "request", [validRequest])).resolves.toEqual({
      kind: "choice",
      choice: "allow",
    });
    expect(queued).not.toHaveBeenCalled();
  });

  it("revokes stale cached choices and prompts when the current options changed", async () => {
    const { service, lookup, revoke, queued } = createDeps();
    lookup.mockReturnValueOnce({
      principal: {
        callerId: "worker:alpha",
        callerKind: "worker" as const,
        repoPath: "workers/alpha",
        effectiveVersion: "hash-1",
      },
      subject: { id: "team-x:foo" },
      choice: "old-choice",
      grantedAt: 10,
    });
    queued.mockResolvedValueOnce({ kind: "choice", choice: "allow" });

    await expect(service.handler(workerCtx, "request", [validRequest])).resolves.toEqual({
      kind: "choice",
      choice: "allow",
    });
    expect(revoke).toHaveBeenCalledWith(
      {
        callerId: "worker:alpha",
        callerKind: "worker",
        repoPath: "workers/alpha",
        effectiveVersion: "hash-1",
      },
      "team-x:foo",
      undefined
    );
    expect(queued).toHaveBeenCalledTimes(1);
  });

  it("continues to prompt if stale-grant revocation fails", async () => {
    const { service, lookup, revoke, queued } = createDeps();
    lookup.mockReturnValueOnce({
      principal: {
        callerId: "worker:alpha",
        callerKind: "worker" as const,
        repoPath: "workers/alpha",
        effectiveVersion: "hash-1",
      },
      subject: { id: "team-x:foo" },
      choice: "old-choice",
      grantedAt: 10,
    });
    revoke.mockRejectedValueOnce(new Error("disk full"));
    queued.mockResolvedValueOnce({ kind: "choice", choice: "allow" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(service.handler(workerCtx, "request", [validRequest])).resolves.toEqual({
      kind: "choice",
      choice: "allow",
    });
    expect(queued).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("persists choices, skips dismissals, and logs persistence failures without changing the result", async () => {
    const { service, queued, record } = createDeps();

    await expect(service.handler(workerCtx, "request", [validRequest])).resolves.toEqual({
      kind: "choice",
      choice: "allow",
    });
    expect(record).toHaveBeenCalledWith(
      {
        callerId: "worker:alpha",
        callerKind: "worker",
        repoPath: "workers/alpha",
        effectiveVersion: "hash-1",
      },
      validRequest.subject,
      "allow",
      expect.any(Number),
      undefined,
      "caller"
    );

    record.mockClear();
    queued.mockResolvedValueOnce({ kind: "dismissed" });
    await expect(service.handler(workerCtx, "request", [validRequest])).resolves.toEqual({
      kind: "dismissed",
    });
    expect(record).not.toHaveBeenCalled();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    queued.mockResolvedValueOnce({ kind: "choice", choice: "allow" });
    record.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
    await expect(service.handler(workerCtx, "request", [validRequest])).resolves.toEqual({
      kind: "choice",
      choice: "allow",
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("defaults to scoped allow options and records trust-version choices as allow", async () => {
    const { service, queued, record } = createDeps();
    queued.mockResolvedValueOnce({ kind: "choice", choice: "version" });
    const scopedRequest = {
      subject: { id: "team-x:scoped", label: "Team X scoped" },
      title: "Allow scoped action?",
    };

    await expect(service.handler(workerCtx, "request", [scopedRequest])).resolves.toEqual({
      kind: "choice",
      choice: "allow",
    });
    expect(queued).toHaveBeenCalledWith(
      expect.objectContaining({
        promptOptions: "scoped",
        options: expect.arrayContaining([
          expect.objectContaining({ value: "once" }),
          expect.objectContaining({ value: "session" }),
          expect.objectContaining({ value: "version" }),
          expect.objectContaining({ value: "deny" }),
        ]),
      })
    );
    expect(record).toHaveBeenCalledWith(
      {
        callerId: "worker:alpha",
        callerKind: "worker",
        repoPath: "workers/alpha",
        effectiveVersion: "hash-1",
      },
      scopedRequest.subject,
      "allow",
      expect.any(Number),
      undefined,
      "version"
    );
  });

  it("does not record scoped allow-once or deny choices", async () => {
    const { service, queued, record } = createDeps();
    const scopedRequest = {
      subject: { id: "team-x:once", label: "Team X once" },
      title: "Allow once?",
    };

    queued.mockResolvedValueOnce({ kind: "choice", choice: "once" });
    await expect(service.handler(workerCtx, "request", [scopedRequest])).resolves.toEqual({
      kind: "choice",
      choice: "allow",
    });

    queued.mockResolvedValueOnce({ kind: "choice", choice: "deny" });
    await expect(service.handler(workerCtx, "request", [scopedRequest])).resolves.toEqual({
      kind: "choice",
      choice: "deny",
    });

    expect(record).not.toHaveBeenCalled();
  });

  it("revokes and lists only the calling issuer grants", async () => {
    const { service, revoke, list } = createDeps();
    list.mockReturnValueOnce([
      {
        principal: {
          callerId: "worker:alpha",
          callerKind: "worker" as const,
          repoPath: "workers/alpha",
          effectiveVersion: "hash-1",
        },
        subject: { id: "team-x:foo" },
        choice: "allow",
        grantedAt: 10,
      },
    ]);

    await expect(service.handler(workerCtx, "revoke", ["team-x:foo"])).resolves.toBe(true);
    expect(revoke).toHaveBeenCalledWith(
      {
        callerId: "worker:alpha",
        callerKind: "worker",
        repoPath: "workers/alpha",
        effectiveVersion: "hash-1",
      },
      "team-x:foo",
      undefined
    );
    await expect(service.handler(workerCtx, "list", [])).resolves.toHaveLength(1);
    expect(list).toHaveBeenCalledWith(
      {
        callerId: "worker:alpha",
        callerKind: "worker",
        repoPath: "workers/alpha",
        effectiveVersion: "hash-1",
      },
      undefined
    );
  });

  it("returns uncallable for unattributed extension callers", async () => {
    const { service, queued, list } = createDeps();
    const unattributed: ServiceContext = {
      caller: createVerifiedCaller("@workspace-extensions/shell", "extension"),
    };

    await expect(service.handler(unattributed, "request", [validRequest])).resolves.toEqual({
      kind: "uncallable",
      reason: "no-user-context",
    });
    expect(queued).not.toHaveBeenCalled();
    await expect(service.handler(unattributed, "revoke", ["team-x:foo"])).resolves.toEqual({
      kind: "uncallable",
      reason: "no-user-context",
    });
    await expect(service.handler(unattributed, "list", [])).resolves.toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it("scopes extension approvals by chain caller and extension issuer", async () => {
    const { service, lookup, queued, record, revoke, list } = createDeps();
    queued.mockResolvedValueOnce({ kind: "choice", choice: "allow" });

    await expect(service.handler(extensionCtx, "request", [validRequest])).resolves.toEqual({
      kind: "choice",
      choice: "allow",
    });
    const issuer = { kind: "extension", id: "@workspace-extensions/shell" };
    expect(lookup).toHaveBeenCalledWith(extensionCtx.chainCaller, "team-x:foo", issuer);
    expect(queued).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: extensionCtx.chainCaller,
        issuer,
        details: expect.arrayContaining([
          { label: "Extension", value: "@workspace-extensions/shell" },
        ]),
      })
    );
    expect(record).toHaveBeenCalledWith(
      extensionCtx.chainCaller,
      validRequest.subject,
      "allow",
      expect.any(Number),
      issuer,
      "caller"
    );
    await service.handler(extensionCtx, "revoke", ["team-x:foo"]);
    expect(revoke).toHaveBeenCalledWith(extensionCtx.chainCaller, "team-x:foo", issuer);
    await service.handler(extensionCtx, "list", []);
    expect(list).toHaveBeenCalledWith(extensionCtx.chainCaller, issuer);
  });

  it("requestAs lets attributed extension callbacks request for a captured principal", async () => {
    const { service, queued } = createDeps();
    queued.mockResolvedValueOnce({ kind: "choice", choice: "once" });
    const principal = {
      callerId: "worker:deploy",
      callerKind: "worker" as const,
      repoPath: "workers/deploy",
      effectiveVersion: "hash-deploy",
    };

    await expect(
      service.handler(extensionCtx, "requestAs", [
        principal,
        {
          subject: validRequest.subject,
          title: validRequest.title,
          severity: "dangerous",
          defaultAction: "deny",
        },
      ])
    ).resolves.toEqual({ kind: "choice", choice: "allow" });

    expect(queued).toHaveBeenCalledWith(
      expect.objectContaining({
        principal,
        options: expect.arrayContaining([
          expect.objectContaining({ value: "deny", tone: "danger" }),
        ]),
        severity: "dangerous",
        defaultAction: "deny",
      })
    );
    expect(queued.mock.calls[0]![0].options[0]).toMatchObject({ value: "deny" });
  });

  it("rejects requestAs from non-extension callers", async () => {
    const { service } = createDeps();

    await expect(
      service.handler(workerCtx, "requestAs", [workerCtx.caller.code, validRequest])
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  const externalRequest = {
    channelId: "channel-1",
    capability: "external-agent.tool",
    operation: "Bash",
    description: "External agent wants to run Bash",
    preview: "npm install",
    requestId: "req-1",
    resolveToken: "resolve-token-123",
  };

  it("requestExternal maps the runtime payload onto the queue and returns the verdict", async () => {
    const { service, requestExternalAgent } = createDeps();
    requestExternalAgent.mockResolvedValueOnce({ behavior: "allow" });

    await expect(service.handler(doCtx, "requestExternal", [externalRequest])).resolves.toEqual({
      behavior: "allow",
    });
    expect(requestExternalAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "external-agent",
        callerId: "do:workers/alpha:AlphaDO:agent-1",
        callerKind: "do",
        entityId: "entity-1",
        channelId: "channel-1",
        capability: "external-agent.tool",
        operationName: "Bash",
        preview: "npm install",
        requestId: "req-1",
        resolveToken: "resolve-token-123",
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("requestExternal returns the deny verdict from the queue", async () => {
    const { service, requestExternalAgent } = createDeps();
    requestExternalAgent.mockResolvedValueOnce({ behavior: "deny" });
    await expect(service.handler(doCtx, "requestExternal", [externalRequest])).resolves.toEqual({
      behavior: "deny",
    });
  });

  it("requestExternal strips control chars from the preview before queueing", async () => {
    const { service, requestExternalAgent } = createDeps();
    await service.handler(doCtx, "requestExternal", [
      { ...externalRequest, preview: "line1 \nline2" },
    ]);
    expect(requestExternalAgent).toHaveBeenCalledWith(
      expect.objectContaining({ preview: "line1\nline2" })
    );
  });

  it("requestExternal arms a timeout that auto-denies (abort settles the queue as deny)", async () => {
    // The queue owns the abort→deny behavior (covered in approvalQueue.test.ts);
    // here we assert the service passes a live signal that fires on timeout.
    vi.useFakeTimers();
    try {
      const { service, requestExternalAgent } = createDeps();
      let capturedSignal: AbortSignal | undefined;
      requestExternalAgent.mockImplementationOnce((req) => {
        capturedSignal = req.signal;
        return new Promise((resolve) => {
          req.signal?.addEventListener("abort", () => resolve({ behavior: "deny" }), {
            once: true,
          });
        });
      });
      const promise = service.handler(doCtx, "requestExternal", [externalRequest]);
      // Flush the async principal resolution so the timeout is armed, then fire it.
      await vi.advanceTimersByTimeAsync(EXTERNAL_APPROVAL_TIMEOUT_MS);
      await expect(promise).resolves.toEqual({ behavior: "deny" });
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settleExternal quiet-settles by bound entity plus (channelId, requestId) and reports the count", async () => {
    const { service, settleExternalAgent } = createDeps();
    settleExternalAgent.mockReturnValueOnce(1);
    await expect(
      service.handler(doCtx, "settleExternal", [{ channelId: "channel-1", requestId: "req-1" }])
    ).resolves.toEqual({ settled: true });
    expect(settleExternalAgent).toHaveBeenCalledTimes(1);
    const predicate = settleExternalAgent.mock.calls[0]![0];
    expect(
      predicate({ entityId: "entity-1", channelId: "channel-1", requestId: "req-1" } as never)
    ).toBe(true);
    expect(
      predicate({ entityId: "entity-2", channelId: "channel-1", requestId: "req-1" } as never)
    ).toBe(false);
    expect(
      predicate({ entityId: "entity-1", channelId: "channel-2", requestId: "req-1" } as never)
    ).toBe(false);
    expect(
      predicate({ entityId: "entity-1", channelId: "channel-1", requestId: "req-9" } as never)
    ).toBe(false);
  });

  it("settleExternal reports settled=false when nothing matched", async () => {
    const { service, settleExternalAgent } = createDeps();
    settleExternalAgent.mockReturnValueOnce(0);
    await expect(
      service.handler(doCtx, "settleExternal", [{ channelId: "channel-1", requestId: "gone" }])
    ).resolves.toEqual({ settled: false });
  });

  it("gates requestExternal/settleExternal to do and worker callers via policy", () => {
    const { service } = createDeps();
    expect(service.methods["requestExternal"]!.policy?.allowed).toEqual(["do", "worker"]);
    expect(service.methods["settleExternal"]!.policy?.allowed).toEqual(["do", "worker"]);
  });

  it("throws ServiceError for unknown methods", async () => {
    const { service } = createDeps();

    await expect(service.handler(workerCtx, "missing", [])).rejects.toBeInstanceOf(ServiceError);
    await expect(service.handler(workerCtx, "missing", [])).rejects.toMatchObject({
      code: "ENOSYS",
    });
  });
});
