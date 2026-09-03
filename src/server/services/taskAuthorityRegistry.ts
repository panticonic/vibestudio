import { createHash } from "node:crypto";
import type { ExecutionAdmissionFact, TaskGrantPrincipal } from "@vibestudio/rpc";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";

const TASK_AUTHORITY_DOMAIN = "vibestudio:task-authority:v1\0";

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

  inheritRuntime(
    runtimeId: string,
    caller: Pick<VerifiedCaller, "runtime" | "executionSession" | "taskAuthority">,
    entities: Pick<EntityCache, "resolveActive">
  ): TaskGrantPrincipal | null {
    const inherited = this.resolveCaller(caller, entities);
    if (!inherited) return null;
    const existing = this.members.get(runtimeId);
    if (existing && existing !== inherited) {
      throw new Error(`Runtime ${runtimeId} is already bound to another task authority`);
    }
    this.members.set(runtimeId, inherited);
    return inherited;
  }

  clear(): void {
    this.members.clear();
    this.executionRoots.clear();
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
