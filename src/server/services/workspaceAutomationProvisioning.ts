import { createHash } from "node:crypto";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { workspaceAutomationKey } from "@vibestudio/workspace-contracts/automations";
import { createHostCaller } from "@vibestudio/shared/serviceDispatcher";
import type { UserSubject } from "@vibestudio/identity/types";
import type { RuntimeServiceInternal } from "./runtimeService.js";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { DORef } from "@vibestudio/shared/doDispatcher";

/** Bootstrap declared member-owned automations through the ordinary runtime.
 * Persistent deduplication belongs to the Automations service; this cache only
 * coalesces connection/startup notifications in this host process. */
export function createWorkspaceAutomationProvisioner(deps: {
  config(): WorkspaceConfig;
  members(): UserSubject[];
  runtime(): Pick<RuntimeServiceInternal, "createEntity">;
  entity(id: string): Promise<EntityRecord | null>;
  dispatch(ref: DORef, method: string, ...args: unknown[]): Promise<unknown>;
  failed(id: string, userId: string, error: unknown): void;
}) {
  const pending = new Map<string, Promise<void>>();
  const completed = new Set<string>();
  async function reconcile(): Promise<void> {
    for (const member of deps.members()) {
      for (const [id, definition] of Object.entries(deps.config().defaultAutomations ?? {})) {
        if (!definition) continue;
        const key = workspaceAutomationKey(id, member.userId);
        if (completed.has(key)) continue;
        const inFlight = pending.get(key);
        if (inFlight) {
          await inFlight;
          continue;
        }
        const work = (async () => {
          try {
            const ref = {
              source: definition.source,
              className: definition.className,
              objectKey: key,
            };
            const targetId = `do:${ref.source}:${ref.className}:${key}`;
            const existing = await deps.entity(targetId);
            if (existing && existing.ownerUserId !== member.userId) {
              throw new Error(`Default automation ${id} has a different owner`);
            }
            // A user-retired runtime is a choice, not an invitation to resurrect it.
            if (existing?.status === "retired") {
              completed.add(key);
              return;
            }
            const entity =
              existing ??
              (await deps.runtime().createEntity(createHostCaller("server", "server", member), {
                kind: "do",
                execution: { surface: "code", source: definition.source, ref: "main" },
                contextId: `ctx-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`,
                className: definition.className,
                key,
                agentChannelId: key,
              }));
            await deps.dispatch(ref, "initializeAutomation", {
              id,
              contextId: entity.contextId,
              definition,
            });
            completed.add(key);
          } catch (error) {
            deps.failed(id, member.userId, error);
          }
        })();
        pending.set(key, work);
        try {
          await work;
        } finally {
          pending.delete(key);
        }
      }
    }
  }
  return { reconcile };
}
