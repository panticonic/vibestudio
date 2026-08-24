import { describe, expect, it, vi } from "vitest";
import type { ExecutionAdmissionFact } from "@vibestudio/rpc";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createEvalEventIngressService, EvalEventSinkRegistry } from "./evalEventIngressService.js";

const runtimeId = "do:vibestudio/internal:EvalDO:object-one";
const runId = "run:one";
const sinkNonce = "sink-nonce-0000000000000001";

function execution(): ExecutionAdmissionFact {
  return {
    v: 2,
    authoritySessionId: "authority:one",
    authoritySessionVersion: 1,
    admissionKey: "eval:one",
    controllerRuntimeId: "agent:one",
    mode: "interactive",
    ownerUser: "user:one",
    workspaceId: "workspace:one",
    contextId: "context:one",
    agentBinding: null,
    taskRef: "task:one",
    taskAuthority: "task:one",
    executionImage: {
      principal: `code:vibestudio/internal@one`,
      repoPath: "vibestudio/internal",
      ref: "state:one",
      effectiveVersion: "one",
      executionDigest: "a".repeat(64),
    },
    executor: {
      kind: "eval",
      runtimeId,
      evalRunId: runId,
      eventSinkNonce: sinkNonce,
      authorityManifest: {
        mode: "adaptive",
        effects: "read-write",
        approvals: "prompt",
        requests: [],
        digest: "b".repeat(64),
      },
    },
    parent: null,
    causalParent: null,
    issuedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    nonce: "execution-session-nonce",
  };
}

function context(): ServiceContext {
  return {
    caller: {
      runtime: { id: runtimeId, kind: "do" },
      executionSession: execution(),
      subject: { userId: "one", handle: "one" },
    },
  };
}

function setup(input: { owner: string; initiator: string }) {
  const sinks = new EvalEventSinkRegistry();
  sinks.register({
    nonce: sinkNonce,
    runtimeId,
    runId,
    contextId: "context:one",
    ownerCallerId: input.owner,
    initiatorCallerId: input.initiator,
    subKey: "notebook",
  });
  const emitToWatchesOfCaller = vi.fn(
    (_callerId: string, _event: string, _payload: unknown) => true
  );
  const service = createEvalEventIngressService({
    sinks,
    eventService: { emitToWatchesOfCaller } as never,
    entityStore: {
      cache: {
        resolveActive: () => ({
          id: runtimeId,
          kind: "do",
          className: "EvalDO",
          source: { repoPath: "vibestudio/internal", effectiveVersion: "one" },
          contextId: "context:one",
          parentId: input.owner,
          stateArgs: { ownerPrincipalId: input.owner, subKey: "notebook" },
        }),
      },
    } as never,
  });
  return { service, sinks, emitToWatchesOfCaller };
}

const event = {
  sequence: 1,
  at: 1,
  kind: "state" as const,
  payload: { status: "running" },
};

describe("eval event ingress", () => {
  it("routes a caller-owned run only to its host-derived owner", async () => {
    const { service, emitToWatchesOfCaller } = setup({
      owner: "panel:owner",
      initiator: "panel:owner",
    });
    await service.handler(context(), "publish", [sinkNonce, runId, event]);
    expect(emitToWatchesOfCaller).toHaveBeenCalledTimes(1);
    expect(emitToWatchesOfCaller).toHaveBeenCalledWith(
      "panel:owner",
      "eval:run-event",
      expect.objectContaining({ runId, scopeKey: "notebook" })
    );
  });

  it("routes owner-session runs to the derived owner and initiating shell without cross-owner fanout", async () => {
    const { service, emitToWatchesOfCaller } = setup({
      owner: "agent:owner-session",
      initiator: "shell:desktop",
    });
    await service.handler(context(), "publish", [sinkNonce, runId, event]);
    expect(emitToWatchesOfCaller.mock.calls.map(([caller]) => caller).sort()).toEqual([
      "agent:owner-session",
      "shell:desktop",
    ]);
    expect(emitToWatchesOfCaller).not.toHaveBeenCalledWith(
      "agent:unrelated",
      expect.anything(),
      expect.anything()
    );
  });

  it("refuses lifecycle-event forgery without the host-minted run sink", async () => {
    const { service, emitToWatchesOfCaller } = setup({
      owner: "panel:owner",
      initiator: "panel:owner",
    });
    await expect(
      service.handler(context(), "publish", [
        "forged-sink-0000000000000000",
        runId,
        { ...event, kind: "authority-decided" },
      ])
    ).rejects.toThrow(/does not belong to the authenticated execution session/);
    expect(emitToWatchesOfCaller).not.toHaveBeenCalled();
  });

  it("treats a delivery queued before sink closure as a benign durable-only event", async () => {
    const { service, sinks, emitToWatchesOfCaller } = setup({
      owner: "panel:owner",
      initiator: "panel:owner",
    });
    sinks.close(sinkNonce);

    await expect(service.handler(context(), "publish", [sinkNonce, runId, event])).resolves.toEqual(
      { delivered: false }
    );
    expect(emitToWatchesOfCaller).not.toHaveBeenCalled();
  });
});
