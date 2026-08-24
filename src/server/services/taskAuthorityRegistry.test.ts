import { describe, expect, it } from "vitest";
import type { ExecutionAdmissionFact } from "@vibestudio/rpc";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { TaskAuthorityRegistry, taskAuthorityPrincipal } from "./taskAuthorityRegistry.js";

function execution(runtimeId: string, taskAuthority: `task:${string}`): ExecutionAdmissionFact {
  return {
    v: 2,
    authoritySessionId: `authority:${runtimeId}`,
    authoritySessionVersion: 1,
    admissionKey: `task:${runtimeId}`,
    controllerRuntimeId: "agent:task-controller",
    mode: "interactive",
    ownerUser: "user:alice",
    workspaceId: "workspace:one",
    contextId: "context:one",
    agentBinding: null,
    taskRef: "channel:one",
    taskAuthority,
    executionImage: {
      principal: "code:workers/agent@one",
      repoPath: "workers/agent",
      ref: "state:one",
      effectiveVersion: "one",
      executionDigest: "a".repeat(64),
    },
    executor: {
      kind: "eval",
      runtimeId,
      evalRunId: "run:one",
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
    nonce: "nonce:one",
  };
}

function activate(cache: EntityCache, id: string, parentId?: string): void {
  cache._onActivate({
    id,
    kind: "panel",
    source: { repoPath: `panels/${id}`, effectiveVersion: "one" },
    contextId: "context:one",
    key: id,
    ...(parentId ? { parentId } : {}),
    createdAt: 1,
    status: "active",
    cleanupComplete: true,
  });
}

describe("TaskAuthorityRegistry", () => {
  it("resolves only descendants of a live admitted execution root", () => {
    const cache = new EntityCache();
    const registry = new TaskAuthorityRegistry();
    registry.bindExecution(execution("eval:root", "task:closure-one"));
    activate(cache, "eval:root", "agent:root");
    activate(cache, "panel:child", "eval:root");
    registry.inheritRuntime("panel:child", { runtime: { id: "eval:root", kind: "do" } }, cache);
    activate(cache, "worker:grandchild", "panel:child");
    registry.inheritRuntime(
      "worker:grandchild",
      { runtime: { id: "panel:child", kind: "panel" } },
      cache
    );
    activate(cache, "panel:unrelated", "agent:other");

    expect(registry.resolveRuntime("panel:child", cache)).toBe("task:closure-one");
    expect(registry.resolveRuntime("worker:grandchild", cache)).toBe("task:closure-one");
    expect(registry.resolveRuntime("panel:unrelated", cache)).toBeNull();
  });

  it("ends every inherited membership when the live registry is cleared", () => {
    const cache = new EntityCache();
    const registry = new TaskAuthorityRegistry();
    registry.bindExecution(execution("eval:root", "task:closure-one"));
    activate(cache, "eval:root");
    activate(cache, "panel:child", "eval:root");
    registry.inheritRuntime("panel:child", { runtime: { id: "eval:root", kind: "do" } }, cache);
    registry.clear();
    expect(registry.resolveRuntime("panel:child", cache)).toBeNull();
  });

  it("rejects descendants after their admitted execution root expires", () => {
    const cache = new EntityCache();
    let active = true;
    const registry = new TaskAuthorityRegistry({ executionIsActive: () => active });
    activate(cache, "eval:root");
    registry.bindExecution(execution("eval:root", "task:closure-one"));
    activate(cache, "panel:child", "eval:root");
    registry.inheritRuntime("panel:child", { runtime: { id: "eval:root", kind: "do" } }, cache);
    active = false;
    expect(registry.resolveRuntime("panel:child", cache)).toBeNull();
  });

  it("does not move existing descendants when a warm execution starts another task", () => {
    const cache = new EntityCache();
    const registry = new TaskAuthorityRegistry();
    activate(cache, "eval:root");
    registry.bindExecution(execution("eval:root", "task:first"));
    activate(cache, "panel:first", "eval:root");
    registry.inheritRuntime("panel:first", { runtime: { id: "eval:root", kind: "do" } }, cache);

    registry.bindExecution(execution("eval:root", "task:second"));
    activate(cache, "panel:second", "eval:root");
    registry.inheritRuntime("panel:second", { runtime: { id: "eval:root", kind: "do" } }, cache);

    expect(registry.resolveRuntime("panel:first", cache)).toBeNull();
    expect(registry.resolveRuntime("panel:second", cache)).toBe("task:second");
  });

  it("mints stable opaque principals from attested task coordinates", () => {
    const input = {
      workspaceId: "workspace:one",
      ownerUser: "user:alice" as const,
      taskRef: "channel:one",
    };
    expect(taskAuthorityPrincipal(input)).toBe(taskAuthorityPrincipal(input));
    expect(taskAuthorityPrincipal({ ...input, taskRef: "channel:two" })).not.toBe(
      taskAuthorityPrincipal(input)
    );
  });
});
