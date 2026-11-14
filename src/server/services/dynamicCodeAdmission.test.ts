import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, ServiceError } from "@vibestudio/shared/serviceDispatcher";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { AgentExecutionSessionRegistry } from "./agentExecutionSessionRegistry.js";
import { TaskAuthorityRegistry } from "./taskAuthorityRegistry.js";
import {
  assertAgentCausalParent,
  createDynamicCodeAdmission,
  normalizeAuthorityManifest,
} from "./dynamicCodeAdmission.js";

const caller = () =>
  createVerifiedCaller("shell:dev_cli", "shell", undefined, undefined, {
    userId: "usr_test",
    handle: "test",
  });

function setup(
  preauthorize?: Parameters<typeof createDynamicCodeAdmission>[0]["preauthorize"],
  hasActiveEntity?: (runtimeId: string) => Promise<boolean>
) {
  const executionSessions = new AgentExecutionSessionRegistry();
  const taskAuthorities = new TaskAuthorityRegistry();
  const admission = createDynamicCodeAdmission({
    executionSessions,
    taskAuthorities,
    entityCache: new EntityCache(),
    workspaceId: "ws_1",
    ...(preauthorize ? { preauthorize } : {}),
    ...(hasActiveEntity ? { hasActiveEntity } : {}),
  });
  const input = (over: Record<string, unknown> = {}) => ({
    runId: "run-1",
    hostRuntimeId: "do:host:Kernel:k1",
    ownerId: "session:cli",
    contextId: "ctx-1",
    authority: undefined,
    executionImage: {
      repoPath: "workers/kernel",
      effectiveVersion: "v1",
      executionDigest: "e".repeat(64),
      stateHash: `state:${"a".repeat(64)}` as const,
      requested: [],
    },
    admissionKey: "code:do:host:Kernel:k1:run-1",
    taskRefFallback: "code:session:cli:run-1",
    eventSinkNonce: "sink-1",
    ...over,
  });
  return { executionSessions, admission, input };
}

describe("admitDynamicCode", () => {
  it("returns the session nonce the call into the hosted class carries, and a discard", async () => {
    const { executionSessions, admission, input } = setup();
    const admitted = await admission.admit({ caller: caller() }, input());
    expect(admitted.nonce).toBe(admitted.executionSession.nonce);
    expect(admitted.executionSession.executor).toMatchObject({
      runtimeId: "do:host:Kernel:k1",
      evalRunId: "run-1",
    });
    expect(admitted.authorityManifestDigest).toBe(admitted.authorityManifest.digest);
    expect(executionSessions.resolve("do:host:Kernel:k1")).toBeTruthy();
    admitted.discard();
    expect(executionSessions.resolve("do:host:Kernel:k1")).toBeFalsy();
  });

  it("says a retired EvalDO notebook was dropped only while its entity is still recorded active (D5)", async () => {
    const legacy = "do:vibestudio/internal:EvalDO:abc";
    const active = vi.fn(async (id: string) => id === legacy);
    const { admission, input } = setup(undefined, active);
    const dropped = await admission.admit(
      { caller: caller() },
      input({ legacyHostRuntimeId: legacy })
    );
    expect(dropped.legacyNotebookDropped).toBe(true);
    dropped.discard();
    const none = await admission.admit(
      { caller: caller() },
      input({ legacyHostRuntimeId: "do:vibestudio/internal:EvalDO:other" })
    );
    expect(none.legacyNotebookDropped).toBe(false);
    none.discard();
    // No legacy coordinates, or a host that cannot tell: never reported.
    const plain = await admission.admit({ caller: caller() }, input());
    expect(plain.legacyNotebookDropped).toBe(false);
  });

  it("refuses a caller with no authenticated user", async () => {
    const { admission, input } = setup();
    await expect(
      admission.admit({ caller: createVerifiedCaller("shell:x", "shell") }, input())
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("discards the session when a preauthorization fails, so a refused run leaves no authority", async () => {
    const preauthorize = vi.fn().mockRejectedValue(new Error("not permitted"));
    const { executionSessions, admission, input } = setup(preauthorize);
    await expect(
      admission.admit(
        { caller: caller() },
        input({
          authority: { preauthorize: [{ service: "fs", method: "readFile", args: ["/x"] }] },
        })
      )
    ).rejects.toThrow("not permitted");
    expect(preauthorize).toHaveBeenCalledTimes(1);
    expect(executionSessions.resolve("do:host:Kernel:k1")).toBeFalsy();
  });

  it("refuses preauthorization when the host has no authorization-only path", async () => {
    const { admission, input } = setup();
    await expect(
      admission.admit(
        { caller: caller() },
        input({
          authority: { preauthorize: [{ service: "fs", method: "readFile", args: ["/x"] }] },
        })
      )
    ).rejects.toMatchObject({ code: "EUNAVAILABLE" });
  });
});

describe("assertAgentCausalParent", () => {
  const binding = { entityId: "agent:a", contextId: "ctx-1", channelId: "chan_1" };
  it("requires an exact causal invocation of an agent-bound run, on the relay's own trajectory", () => {
    expect(() => assertAgentCausalParent({ caller: caller() }, binding)).toThrow(ServiceError);
    const trajectory = channelTrajectoryFor("chan_1");
    const cause = { kind: "trajectory-invocation" as const, invocationId: "i", ...trajectory };
    expect(() =>
      assertAgentCausalParent({ caller: caller(), causalParent: cause }, binding)
    ).not.toThrow();
    expect(() =>
      assertAgentCausalParent(
        { caller: caller(), causalParent: { ...cause, head: "other" } },
        binding
      )
    ).toThrow(/trajectory/);
    expect(() => assertAgentCausalParent({ caller: caller() }, undefined)).not.toThrow();
  });
});

describe("normalizeAuthorityManifest", () => {
  it("bounds a wildcard request by an equivalent sealed request", () => {
    const wildcard = {
      requests: [{ capability: "fs.*", resource: { kind: "prefix" as const, prefix: "" } }],
    };
    expect(() => normalizeAuthorityManifest(wildcard as never, [])).toThrow(/not bounded/);
    expect(
      normalizeAuthorityManifest(wildcard as never, [
        { capability: "fs.*", resource: { kind: "prefix", prefix: "" } },
      ]).mode
    ).toBe("strict");
  });

  it("an intent with no requests is adaptive, and the digest is stable", () => {
    const first = normalizeAuthorityManifest(undefined, []);
    expect(first.mode).toBe("adaptive");
    expect(normalizeAuthorityManifest(undefined, []).digest).toBe(first.digest);
  });
});
