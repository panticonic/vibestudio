/**
 * quickfire — panel-slot-scoped agent micro-sessions (quickfire-overlay-spec §2.4).
 *
 * The service owns three things and nothing else:
 *
 *  1. the durable slot ↔ conversation mapping (a `quickfire_sessions` row in
 *     `WorkspaceDO`, reached through `doDispatch` like every other builtin),
 *  2. lazy creation of the conversation's backing — a channel id plus an agent
 *     vessel running the `workers/quickfire-agent` harness, created exactly the
 *     way the chat path does (`runtime.createEntity` with `agentChannelId`, then
 *     `subscribeChannel` on the vessel). The entity is host-managed: callers name
 *     a slot, never coordinates,
 *  3. execution of the archival work that slot close and clear only *record*.
 *     The DO never archives anything itself; `drainCleanup` is the host-side
 *     drain, acknowledging only rows whose agent actually retired.
 *
 * Lifecycle events are the only thing that ends a conversation: clear, slot
 * close, or promotion (which transfers ownership to the chat panel). There is no
 * TTL and nothing here reads a clock to decide authority or liveness.
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { DoDispatcher } from "@vibestudio/shared/doDispatcher";
import type {
  WorkspaceQuickfireBindResult,
  WorkspaceQuickfireCleanupItem,
  WorkspaceQuickfireCleanupPage,
  WorkspaceQuickfireSession,
} from "@vibestudio/shared/panel/workspaceStateSnapshot";
import {
  QUICKFIRE_POLICY,
  quickfireMethods,
  type QuickfireDrainResult,
  type QuickfireSession,
  type QuickfireSessionSummary,
} from "@vibestudio/service-schemas/quickfire";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import { WORKSPACE_DO_CLASS } from "./workspaceStateService.js";
import type { QuickfireAuthorityBinder } from "./quickfireAuthority.js";

/** Where a quickfire conversation's agent comes from. */
export interface QuickfireHarness {
  /** Userland unit path, e.g. `workers/quickfire-agent`. */
  source: string;
  /** Durable Object class the unit exports. */
  className: string;
}

export interface QuickfireAgentHandle {
  /** Canonical entity id; for a `do` entity this is also its RPC target id. */
  entityId: string;
  contextId: string;
}

export interface QuickfireChannelActivity {
  /** Durable envelope high-water mark, or null when it cannot be read. */
  messageCount: number | null;
  lastActivityAt: number | null;
}

export interface QuickfireServiceDeps {
  doDispatch: DoDispatcher;
  workspaceId: string;
  harness: QuickfireHarness;
  /**
   * Create the agent vessel for one conversation and subscribe it to the
   * channel. Implemented over `runtime.createEntity` + the vessel's
   * `subscribeChannel`, so the host derives every coordinate itself.
   */
  createAgent(input: {
    slotId: string;
    channelId: string;
    contextId: string;
    harness: QuickfireHarness;
  }): Promise<QuickfireAgentHandle>;
  /**
   * Release one conversation's agent: stop any turn in flight, unsubscribe it,
   * and retire the vessel. Throwing keeps the queued row for the next drain.
   */
  releaseAgent(input: {
    agentEntityId: string | null;
    channelId: string;
    contextId: string;
  }): Promise<void>;
  /** Resolve the context a slot currently lives in, for a fresh binding. */
  resolveSlotContext(slotId: string): Promise<string | null>;
  /** Best-effort resume-chip inputs. Failure degrades to "unknown", never to zero. */
  channelActivity?(channelId: string): Promise<QuickfireChannelActivity>;
  /**
   * Binding-time authority (§6.2). Absent in tests that only exercise the
   * mapping. Bind runs on the user's explicit open gesture; release runs on the
   * lifecycle events that end or re-target a conversation — never on a timer.
   */
  authority?: QuickfireAuthorityBinder;
  /** Persist a new bound context after the slot moved (§6.2 context change). */
  retargetSession?(input: { slotId: string; contextId: string }): Promise<void>;
  /** Injectable for tests; production mints a random conversation id. */
  newChannelId?(slotId: string): string;
  log?(message: string, detail?: Record<string, unknown>): void;
}

function defaultChannelId(): string {
  return `quickfire-${crypto.randomUUID().slice(0, 12)}`;
}

export function createQuickfireService(deps: QuickfireServiceDeps): ServiceDefinition {
  const ref = {
    source: INTERNAL_DO_SOURCE,
    className: WORKSPACE_DO_CLASS,
    objectKey: deps.workspaceId,
  };
  const dispatch = <T>(method: string, args: unknown[]) =>
    deps.doDispatch.dispatch(ref, method, ...args) as Promise<T>;

  async function activityFor(channelId: string): Promise<QuickfireChannelActivity> {
    if (!deps.channelActivity) return { messageCount: null, lastActivityAt: null };
    try {
      return await deps.channelActivity(channelId);
    } catch (error) {
      // A conversation whose log cannot be read right now is still a real
      // conversation. Report "unknown" rather than a fabricated empty count.
      deps.log?.("Quickfire channel activity unavailable", {
        channelId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return { messageCount: null, lastActivityAt: null };
    }
  }

  async function present(
    row: WorkspaceQuickfireSession,
    state: QuickfireSession["state"]
  ): Promise<QuickfireSession> {
    const activity =
      state === "fresh"
        ? { messageCount: 0, lastActivityAt: null }
        : await activityFor(row.channelId);
    return {
      slotId: row.slotId,
      channelId: row.channelId,
      contextId: row.contextId,
      agentEntityId: row.agentEntityId,
      state,
      messageCount: activity.messageCount,
      lastActivityAt: activity.lastActivityAt,
      createdAt: row.createdAt,
      promotedAt: row.promotedAt,
    };
  }

  /**
   * Re-mint a resumed conversation's grants when its slot has moved to another
   * context. The mapping survives navigation (§1.4) but its authority must not:
   * grants name a context, and this slot is no longer in the one they named.
   */
  async function rebindOnContextChange(
    row: WorkspaceQuickfireSession,
    decidedBy: `user:${string}`
  ): Promise<void> {
    if (!deps.authority) return;
    let current: string | null = null;
    try {
      current = await deps.resolveSlotContext(row.slotId);
    } catch (error) {
      // A slot whose context cannot be read right now keeps what it has; the
      // next open re-checks. Guessing either way would be worse.
      deps.log?.("Quickfire slot context unavailable; keeping the existing binding", {
        slotId: row.slotId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (current === null || current === row.contextId) return;
    await deps.authority.release({ channelId: row.channelId });
    const bound = await deps.authority.bind({
      slotId: row.slotId,
      channelId: row.channelId,
      targetContextId: current,
      decidedBy,
    });
    if (bound) {
      await deps.retargetSession?.({ slotId: row.slotId, contextId: current });
      row.contextId = current;
    }
  }

  /** Execute one queued archival. Returns false when the row must be retried. */
  async function archive(item: WorkspaceQuickfireCleanupItem): Promise<boolean> {
    try {
      await deps.releaseAgent({
        agentEntityId: item.agentEntityId,
        channelId: item.channelId,
        contextId: item.contextId,
      });
      // The agent is gone, so its pre-granted authority must be too. This runs
      // after the retire so a failed retire leaves the row queued *with* its
      // grants — a half-released conversation is never left holding authority
      // it can no longer be seen to hold.
      await deps.authority?.release({ channelId: item.channelId });
      return true;
    } catch (error) {
      deps.log?.("Quickfire archival failed; leaving the row queued", {
        channelId: item.channelId,
        slotId: item.slotId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async function drain(input?: {
    closeId?: string;
    limit?: number;
  }): Promise<QuickfireDrainResult> {
    let archived = 0;
    let failed = 0;
    let cursor: string | undefined;
    for (;;) {
      const page = await dispatch<WorkspaceQuickfireCleanupPage>("quickfireCleanupPage", [
        {
          ...(input?.closeId !== undefined ? { closeId: input.closeId } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          limit: input?.limit ?? 200,
        },
      ]);
      if (page.items.length === 0) return { archived, failed };
      const acknowledged: string[] = [];
      for (const item of page.items) {
        if (await archive(item)) {
          acknowledged.push(item.channelId);
          archived += 1;
        } else {
          failed += 1;
        }
      }
      if (acknowledged.length > 0) {
        await dispatch<void>("quickfireCleanupAck", [acknowledged]);
      }
      // A failed row keeps its place in the keyset, so paging past it is the
      // only way to make progress within this drain; the next drain retries it.
      cursor = page.nextCursor ?? undefined;
      if (cursor === undefined) return { archived, failed };
    }
  }

  return {
    name: "quickfire",
    description: "Panel-slot-scoped agent micro-sessions for the shell overlay",
    authority: QUICKFIRE_POLICY,
    methods: quickfireMethods,
    handler: defineServiceHandler("quickfire", quickfireMethods, {
      sessionFor: async (ctx, [input]) => {
        const decidedBy: `user:${string}` = ctx.caller.subject
          ? `user:${ctx.caller.subject.userId}`
          : "user:workspace";
        const existing = await dispatch<WorkspaceQuickfireSession | null>("quickfireSessionGet", [
          input.slotId,
        ]);
        if (existing && existing.promotedAt !== null && input.fresh !== true) {
          return present(existing, "promoted");
        }
        if (existing && existing.promotedAt === null && input.fresh !== true) {
          // Opening the overlay again is a fresh user gesture, so it is also the
          // moment to notice that the slot navigated somewhere else. The old
          // context's grants are revoked and a new pair is minted for where the
          // panel actually is now (§6.2) — no grant outlives the context it
          // named, and nothing here expires on a clock.
          await rebindOnContextChange(existing, decidedBy);
          return present(existing, "resumed");
        }

        const contextId = await deps.resolveSlotContext(input.slotId);
        if (!contextId) throw new Error(`Panel slot is not open: ${input.slotId}`);
        const channelId = (deps.newChannelId ?? defaultChannelId)(input.slotId);
        const agent = await deps.createAgent({
          slotId: input.slotId,
          channelId,
          contextId,
          harness: deps.harness,
        });
        const bound = await dispatch<WorkspaceQuickfireBindResult>("quickfireSessionBind", [
          {
            slotId: input.slotId,
            channelId,
            agentEntityId: agent.entityId,
            contextId: agent.contextId,
            ...(input.fresh === true ? { replace: true } : {}),
          },
        ]);
        if (!bound.created) {
          // Another opener won the slot. Retire the vessel we just built rather
          // than leaking an agent nobody can reach.
          await deps
            .releaseAgent({
              agentEntityId: agent.entityId,
              channelId,
              contextId: agent.contextId,
            })
            .catch(() => undefined);
          return present(bound.session, bound.session.promotedAt !== null ? "promoted" : "resumed");
        }
        await deps.authority?.bind({
          slotId: input.slotId,
          channelId,
          targetContextId: agent.contextId,
          decidedBy,
        });
        return present(bound.session, "fresh");
      },

      clear: async (_ctx, [input]) => {
        const cleared = await dispatch<WorkspaceQuickfireSession | null>("quickfireSessionClear", [
          input.slotId,
        ]);
        if (!cleared) return { cleared: false, archived: 0 };
        // Promoted conversations are detached without archival — the chat panel
        // owns them now, so the DO queued nothing for them.
        if (cleared.promotedAt !== null) {
          // The chat panel owns the conversation now, but the quickfire binding
          // is over: the overlay's pre-granted debug reach does not follow it.
          await deps.authority?.release({ channelId: cleared.channelId });
          return { cleared: true, archived: 0 };
        }
        const result = await drain({ closeId: `clear:${cleared.channelId}` });
        return { cleared: true, archived: result.archived };
      },

      promote: async (_ctx, [input]) => {
        const promoted = await dispatch<WorkspaceQuickfireSession | null>(
          "quickfireSessionPromote",
          [input.slotId]
        );
        return promoted ? present(promoted, "promoted") : null;
      },

      list: async () => {
        const rows = await dispatch<WorkspaceQuickfireSession[]>("quickfireSessionList", []);
        return rows.map(
          (row): QuickfireSessionSummary => ({
            slotId: row.slotId,
            channelId: row.channelId,
            contextId: row.contextId,
            agentEntityId: row.agentEntityId,
            createdAt: row.createdAt,
            promotedAt: row.promotedAt,
          })
        );
      },

      drainCleanup: (_ctx, [input]) => drain(input),
    }),
  };
}
