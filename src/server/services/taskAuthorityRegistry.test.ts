import { describe, expect, it } from "vitest";
import type { ExecutionAdmissionFact } from "@vibestudio/rpc";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
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
  it("retains an admitted agent's task for subsequent local child creation", () => {
    const cache = new EntityCache();
    const registry = new TaskAuthorityRegistry();
    activate(cache, "agent:parent");
    activate(cache, "eval:parent");
    registry.bindExecution({
      ...execution("eval:parent", "task:parent"),
      agentBinding: {
        entityId: "agent:parent",
        channelId: "channel:one",
        bindingId: "binding:parent",
      },
    });
    expect(
      registry.inheritRuntime("agent:child", { runtime: { id: "agent:parent", kind: "do" } }, cache)
    ).toBe("task:parent");
    activate(cache, "agent:child");
    expect(registry.resolveRuntime("agent:child", cache)).toBe("task:parent");
    expect(() =>
      registry.bindExecution({
        ...execution("eval:other", "task:other"),
        agentBinding: {
          entityId: "agent:parent",
          channelId: "channel:other",
          bindingId: "binding:other",
        },
      })
    ).toThrow(/already bound/);
  });

  it("retains the authenticated channel coordinates behind an opaque task principal", () => {
    const registry = new TaskAuthorityRegistry();
    const coordinates = {
      workspaceId: "workspace:one",
      contextId: "context:one",
      channelId: "channel:one",
    };
    const taskAuthority = taskAuthorityPrincipal(coordinates);
    registry.bindPrincipal(taskAuthority, coordinates);
    expect(registry.bindingFor(taskAuthority)).toEqual(coordinates);
  });

  it("does not reinterpret a descendant execution context as the task origin", () => {
    const registry = new TaskAuthorityRegistry();
    const coordinates = {
      workspaceId: "workspace:one",
      contextId: "context:one",
      channelId: "channel:one",
    };
    const taskAuthority = taskAuthorityPrincipal(coordinates);
    registry.bindPrincipal(taskAuthority, coordinates);
    registry.bindExecution({
      ...execution("eval:child", taskAuthority),
      contextId: "context:child-execution",
    });
    expect(registry.bindingFor(taskAuthority)).toEqual(coordinates);
  });

  it("rejects coordinates that do not mint the claimed task principal", () => {
    const registry = new TaskAuthorityRegistry();
    expect(() =>
      registry.bindPrincipal("task:not-the-binding", {
        workspaceId: "workspace:one",
        contextId: "context:one",
        channelId: "channel:one",
      })
    ).toThrow(/does not match/);
  });

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

  it("retains descendant authority only for a verified causal invocation", () => {
    const cache = new EntityCache();
    let active = true;
    const registry = new TaskAuthorityRegistry({ executionIsActive: () => active });
    const coordinates = {
      workspaceId: "workspace:one",
      contextId: "context:one",
      channelId: "channel:one",
    };
    const taskAuthority = taskAuthorityPrincipal(coordinates);
    registry.bindPrincipal(taskAuthority, coordinates);
    activate(cache, "eval:root");
    registry.bindExecution(execution("eval:root", taskAuthority));
    activate(cache, "do:subagent", "eval:root");
    registry.inheritRuntime("do:subagent", { runtime: { id: "eval:root", kind: "do" } }, cache);

    active = false;
    expect(registry.resolveRuntime("do:subagent", cache)).toBeNull();
    const childBinding = { ...coordinates, entityId: "do:subagent", channelId: "channel:child" };
    // The child invocation was authored by the parent agent, not an account.
    expect(
      registry.resolveInvocationAuthority(
        childBinding,
        channelTrajectoryFor("channel:child"),
        cache,
        { active: true, mayCreateRoot: false }
      )
    ).toBe(taskAuthority);
    expect(
      registry.resolveInvocationAuthority(
        childBinding,
        channelTrajectoryFor("channel:child"),
        cache,
        { active: false, mayCreateRoot: true }
      )
    ).toBeNull();
    expect(
      registry.resolveInvocationAuthority(
        childBinding,
        channelTrajectoryFor("channel:other"),
        cache,
        { active: true, mayCreateRoot: false }
      )
    ).toBeNull();
    activate(cache, "do:unbound");
    expect(
      registry.resolveInvocationAuthority(
        { ...childBinding, entityId: "do:unbound" },
        channelTrajectoryFor("channel:child"),
        cache,
        { active: true, mayCreateRoot: false }
      )
    ).toBeNull();
    const newAuthority = registry.resolveInvocationAuthority(
      { ...childBinding, entityId: "do:unbound" },
      channelTrajectoryFor("channel:child"),
      cache,
      { active: true, mayCreateRoot: true }
    );
    expect(newAuthority).toBe(
      taskAuthorityPrincipal({ ...coordinates, channelId: "channel:child" })
    );
    expect(newAuthority).not.toBe(taskAuthority);
    expect(() =>
      registry.bindExecution({
        ...execution("eval:child", taskAuthority),
        agentBinding: {
          entityId: childBinding.entityId,
          channelId: childBinding.channelId,
          bindingId: "binding:child",
        },
      })
    ).not.toThrow();
    expect(
      registry.resolveCausalBinding(
        { entityId: "do:subagent", channelId: "channel:one" },
        channelTrajectoryFor("channel:one"),
        cache
      )
    ).toBe(taskAuthority);
    expect(
      registry.resolveCausalBinding(
        { entityId: "do:subagent", channelId: "channel:one" },
        channelTrajectoryFor("channel:other"),
        cache
      )
    ).toBeNull();
  });

  it("binds an authenticated task origin so its later child can inherit", () => {
    const cache = new EntityCache();
    const registry = new TaskAuthorityRegistry();
    const binding = {
      entityId: "do:agent",
      workspaceId: "workspace:one",
      contextId: "context:one",
      channelId: "channel:one",
    };
    const authority = taskAuthorityPrincipal(binding);
    activate(cache, binding.entityId);
    registry.bindPrincipal(authority, binding);
    registry.bindCausalOrigin(authority, binding, channelTrajectoryFor(binding.channelId), cache);
    activate(cache, "do:child", binding.entityId);

    expect(
      registry.inheritRuntime(
        "do:child",
        { runtime: { id: binding.entityId, kind: "do" }, taskAuthority: authority },
        cache
      )
    ).toBe(authority);
    expect(() =>
      registry.bindCausalOrigin(
        authority,
        { ...binding, channelId: "channel:other" },
        channelTrajectoryFor("channel:other"),
        cache
      )
    ).toThrow(/does not belong/);
  });

  it("allows an inactive provisional creation snapshot to be replaced but freezes it on activation", () => {
    const cache = new EntityCache();
    const registry = new TaskAuthorityRegistry();
    const target = "do:preparing-child";

    expect(
      registry.inheritRuntime(
        target,
        { runtime: { id: "agent:first", kind: "do" }, taskAuthority: "task:first" },
        cache
      )
    ).toBe("task:first");
    expect(
      registry.inheritRuntime(
        target,
        { runtime: { id: "agent:second", kind: "do" }, taskAuthority: "task:second" },
        cache
      )
    ).toBe("task:second");

    activate(cache, target);
    expect(() =>
      registry.inheritRuntime(
        target,
        { runtime: { id: "agent:first", kind: "do" }, taskAuthority: "task:first" },
        cache
      )
    ).toThrow(/already bound/);
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
      contextId: "agent:one",
      channelId: "channel:one",
    };
    expect(taskAuthorityPrincipal(input)).toBe(taskAuthorityPrincipal(input));
    expect(taskAuthorityPrincipal({ ...input, channelId: "channel:two" })).not.toBe(
      taskAuthorityPrincipal(input)
    );
  });
});
