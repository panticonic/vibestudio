import { createHash } from "node:crypto";
import type { ExecutionAdmissionFact, TaskGrantPrincipal } from "@vibestudio/rpc";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";

const TASK_AUTHORITY_DOMAIN = "vibestudio:task-authority:v1\0";

export interface TaskAuthorityBinding {
  workspaceId: string;
  contextId: string;
  channelId: string;
}

/**
 * Host-resident proof that live runtime entities belong to one task closure.
 *
 * Only admitted Eval runtimes are roots. Runtime creation snapshots the
 * verified initiator's membership onto each child, so reusing a warm Eval root
 * for a later task cannot retroactively reclassify older descendants.
 */
export class TaskAuthorityRegistry {
  private readonly members = new Map<string, TaskGrantPrincipal>();
  private readonly executionRoots = new Map<string, TaskGrantPrincipal>();
  private readonly bindings = new Map<TaskGrantPrincipal, TaskAuthorityBinding>();

  constructor(
    private readonly deps: {
      executionIsActive?: (runtimeId: string, authority: TaskGrantPrincipal) => boolean;
    } = {}
  ) {}

  bindExecution(session: ExecutionAdmissionFact): void {
    const runtimeId = session.executor.runtimeId;
    if (!session.taskAuthority) {
      throw new Error(`Runtime ${runtimeId} has no task authority`);
    }
    this.executionRoots.set(runtimeId, session.taskAuthority);
    this.members.set(runtimeId, session.taskAuthority);
  }

  /** Retain the authenticated coordinates behind an opaque task principal. */
  bindPrincipal(authority: TaskGrantPrincipal, binding: TaskAuthorityBinding): void {
    if (taskAuthorityPrincipal(binding) !== authority) {
      throw new Error(`Task authority ${authority} does not match its authenticated binding`);
    }
    this.rememberBinding(authority, binding);
  }

  private rememberBinding(authority: TaskGrantPrincipal, binding: TaskAuthorityBinding): void {
    const existing = this.bindings.get(authority);
    if (existing && canonicalJson(existing) !== canonicalJson(binding)) {
      throw new Error(`Task authority ${authority} is already bound to different coordinates`);
    }
    this.bindings.set(authority, Object.freeze({ ...binding }));
  }

  bindingFor(authority: TaskGrantPrincipal): TaskAuthorityBinding | null {
    const binding = this.bindings.get(authority);
    return binding ? { ...binding } : null;
  }

  /**
   * Attach a newly authenticated task to its bound agent runtime.
   *
   * This is the root membership from which later host-created descendants
   * inherit. It is accepted only when the causal coordinate, live entity,
   * agent binding, and authority binding all describe the same channel and
   * context.
   */
  bindCausalOrigin(
    authority: TaskGrantPrincipal,
    binding: { entityId: string; contextId: string; channelId: string },
    causalParent: { logId: string; head: string },
    entities: Pick<EntityCache, "resolveActive">
  ): void {
    const expected = channelTrajectoryFor(binding.channelId);
    if (causalParent.logId !== expected.logId || causalParent.head !== expected.head) {
      throw new Error("Task origin causal coordinate does not match its agent channel");
    }
    const entity = entities.resolveActive(binding.entityId);
    if (!entity || entity.contextId !== binding.contextId) {
      throw new Error("Task origin is not an active entity in its bound context");
    }
    const authorityBinding = this.bindings.get(authority);
    if (
      !authorityBinding ||
      authorityBinding.contextId !== binding.contextId ||
      authorityBinding.channelId !== binding.channelId
    ) {
      throw new Error("Task authority does not belong to the bound agent channel");
    }
    const existing = this.members.get(binding.entityId);
    if (existing && existing !== authority) {
      throw new Error(`Runtime ${binding.entityId} is already bound to another task authority`);
    }
    this.members.set(binding.entityId, authority);
  }

  resolveCaller(
    caller: Pick<VerifiedCaller, "runtime" | "executionSession" | "taskAuthority">,
    entities: Pick<EntityCache, "resolveActive">
  ): TaskGrantPrincipal | null {
    if (caller.executionSession?.taskAuthority) return caller.executionSession.taskAuthority;
    if (caller.taskAuthority) return caller.taskAuthority;
    return this.resolveRuntime(caller.runtime.id, entities);
  }

  resolveRuntime(
    runtimeId: string,
    entities: Pick<EntityCache, "resolveActive">
  ): TaskGrantPrincipal | null {
    // Resolve the entity to prove the runtime is still live. Membership itself
    // is the creation-time snapshot, not a mutable walk through its ancestors.
    if (!entities.resolveActive(runtimeId)) return null;
    const membership = this.members.get(runtimeId);
    if (!membership) return null;
    return this.authorityIsActive(membership) ? membership : null;
  }

  /**
   * Resolve authority for a host-verified, currently active causal invocation.
   *
   * Descendant membership is minted only while an authorized task member
   * creates the runtime. An exact causal invocation proves the descendant is
   * acting now on its own bound channel, so it may keep using that task after
   * the parent's individual execution turn ends. Non-causal egress continues
   * through resolveRuntime and therefore still requires a live admitted
   * execution root.
   */
  resolveCausalBinding(
    binding: { entityId: string; channelId: string },
    causalParent: { logId: string; head: string },
    entities: Pick<EntityCache, "resolveActive">
  ): TaskGrantPrincipal | null {
    const expected = channelTrajectoryFor(binding.channelId);
    if (causalParent.logId !== expected.logId || causalParent.head !== expected.head) return null;
    if (!entities.resolveActive(binding.entityId)) return null;
    const membership = this.members.get(binding.entityId);
    if (!membership || !this.bindings.has(membership)) return null;
    return membership;
  }

  inheritRuntime(
    runtimeId: string,
    caller: Pick<VerifiedCaller, "runtime" | "executionSession" | "taskAuthority">,
    entities: Pick<EntityCache, "resolveActive">
  ): TaskGrantPrincipal | null {
    const inherited = this.resolveCaller(caller, entities);
    if (!inherited) return null;
    const existing = this.members.get(runtimeId);
    if (existing && existing !== inherited) {
      // A preparing/failed target has never become an executable principal.
      // Its provisional creation snapshot may therefore be replaced by a
      // later authenticated retry. Once active, membership is immutable.
      if (entities.resolveActive(runtimeId)) {
        throw new Error(`Runtime ${runtimeId} is already bound to another task authority`);
      }
    }
    this.members.set(runtimeId, inherited);
    return inherited;
  }

  clear(): void {
    this.members.clear();
    this.executionRoots.clear();
    this.bindings.clear();
  }

  private authorityIsActive(authority: TaskGrantPrincipal): boolean {
    for (const [runtimeId, rootAuthority] of this.executionRoots) {
      if (rootAuthority !== authority) continue;
      if (!this.deps.executionIsActive || this.deps.executionIsActive(runtimeId, authority)) {
        return true;
      }
      this.executionRoots.delete(runtimeId);
    }
    return false;
  }
}

/** Mint a stable opaque principal from host-attested task coordinates. */
export function taskAuthorityPrincipal(input: {
  workspaceId: string;
  contextId: string;
  channelId: string;
}): TaskGrantPrincipal {
  const digest = createHash("sha256")
    .update(TASK_AUTHORITY_DOMAIN)
    .update(canonicalJson(input))
    .digest("hex");
  return `task:${digest}`;
}
