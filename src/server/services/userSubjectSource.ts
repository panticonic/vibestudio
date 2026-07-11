/**
 * `createUserSubjectSource` — the hub-backed `UserSubjectSource` the child's
 * `RpcServer` uses to attribute every authenticated caller to an account
 * `subject` (WP0 §5.2/§5.5).
 *
 * It reads the shared identity DB (via `deviceAuthStore`/`userStore`) and the
 * Node-side `EntityCache` lineage mirror to map:
 *   - `shell:<deviceId>`   → owning user (`deviceAuthStore.userFor` → device→user FK)
 *   - `agent:<entityId>`   → the spawning user carried on the credential binding
 *   - `panel:`/`do:`/`worker:` → the lineage owner (`resolveUserSubject`, §6),
 *     enriched with the live account handle
 *   - the local-console bootstrap principals (`electron-main`/`headless-host`) →
 *     the machine root under the trusted-console rule (§5.4)
 *
 * The in-process `server` principal is handled by `RpcServer` itself
 * (→ `SYSTEM_SUBJECT`) and never reaches this source. Returns null when no
 * account can be attributed — acceptable only for the enumerated §5.4 bootstrap
 * set (e.g. a console principal before any root exists in local/dev mode).
 *
 * Host-boundary clean: only host/shared imports, never `workspace/`.
 */

import type { CallerKind, AgentBinding } from "@vibestudio/shared/serviceDispatcher";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { UserStore } from "@vibestudio/shared/users/userStore";
import type { UserSubject } from "@vibestudio/shared/users/types";
import type { UserSubjectSource } from "../rpcServer.js";
import type { DeviceAuthStore } from "./deviceAuthStore.js";
import { resolveUserSubject } from "./principalIdentity.js";

/**
 * The local desktop/console principals. They authenticate as caller kind
 * `shell` with these fixed caller ids (not the `shell:<deviceId>` device shape)
 * and act as the machine ROOT (WP0 §5.4) — the trusted local console owns the
 * host.
 */
const CONSOLE_PRINCIPAL_IDS: ReadonlySet<string> = new Set(["electron-main", "headless-host"]);

const SHELL_PREFIX = "shell:";

/** Workspace infrastructure launched by the server carries the synthetic system owner. */
export function isSystemOwnedRuntime(
  entityCache: Pick<EntityCache, "resolveActive">,
  callerId: string,
  callerKind: CallerKind
): boolean {
  if (callerKind !== "do" && callerKind !== "worker") return false;
  return entityCache.resolveActive(callerId)?.ownerUserId === "system";
}

export function createUserSubjectSource(deps: {
  deviceAuthStore: Pick<DeviceAuthStore, "userFor">;
  userStore: Pick<UserStore, "getUser" | "listUsers">;
  entityCache: Pick<EntityCache, "resolveActive">;
  isSystemRuntime?: (callerId: string, callerKind: CallerKind) => boolean;
}): UserSubjectSource {
  const { deviceAuthStore, userStore, entityCache } = deps;

  /** The single live (non-revoked) root account, or null before bootstrap. */
  const resolveRoot = (): UserSubject | null => {
    const root = userStore.listUsers().find((u) => u.role === "root" && u.revokedAt === undefined);
    return root ? { userId: root.id, handle: root.handle } : null;
  };

  /** Attach the canonical live account handle to a userId. */
  const subjectFor = (userId: string): UserSubject | null => {
    const user = userStore.getUser(userId);
    if (!user || user.revokedAt !== undefined) return null;
    return { userId, handle: user.handle };
  };

  return {
    resolve(
      callerId: string,
      callerKind: CallerKind,
      agentBinding?: AgentBinding
    ): UserSubject | null {
      if (deps.isSystemRuntime?.(callerId, callerKind)) {
        return { userId: "system", handle: "system" };
      }
      // Local-console bootstrap principals act as root (§5.4), regardless of the
      // `shell` kind they authenticate under.
      if (CONSOLE_PRINCIPAL_IDS.has(callerId)) return resolveRoot();

      switch (callerKind) {
        case "shell": {
          if (!callerId.startsWith(SHELL_PREFIX)) return null;
          const deviceId = callerId.slice(SHELL_PREFIX.length);
          const userId = deviceAuthStore.userFor(deviceId);
          if (!userId) return null;
          return subjectFor(userId);
        }
        case "agent": {
          const userId = agentBinding?.userId;
          if (!userId) return null;
          return subjectFor(userId);
        }
        case "panel":
        case "do":
        case "worker": {
          const s = resolveUserSubject(entityCache, callerId);
          if (!s) return null;
          return subjectFor(s.userId);
        }
        case "extension":
          // Extension code is a host/system principal, not a human account.
          // RpcServer stamps its synthetic system subject; delegated human
          // provenance travels separately through the verified caller chain.
          return null;
        default:
          return null;
      }
    },
  };
}
