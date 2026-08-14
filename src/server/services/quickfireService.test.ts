import { describe, expect, it, vi } from "vitest";
import { createHostCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type {
  WorkspaceQuickfireBindResult,
  WorkspaceQuickfireCleanupPage,
  WorkspaceQuickfireSession,
} from "@vibestudio/shared/panel/workspaceStateSnapshot";
import { createQuickfireService, type QuickfireServiceDeps } from "./quickfireService.js";
import type { QuickfireSession } from "@vibestudio/service-schemas/quickfire";

const ctx: ServiceContext = { caller: createHostCaller("server") };

/**
 * Minimal in-memory stand-in for the `quickfire_sessions` +
 * `quickfire_close_cleanup` tables. It mirrors WorkspaceDO's contract (which
 * has its own tests) so this suite can assert the SERVICE's semantics: what it
 * creates, what it retires, and what it refuses to do twice.
 */
function fakeWorkspaceDo() {
  const sessions = new Map<string, WorkspaceQuickfireSession>();
  const queue = new Map<
    string,
    {
      channelId: string;
      slotId: string;
      agentEntityId: string | null;
      contextId: string;
      closeId: string;
    }
  >();
  let now = 1_000;
  const dispatch = vi.fn(async (_ref: unknown, method: string, ...args: unknown[]) => {
    switch (method) {
      case "quickfireSessionGet":
        return sessions.get(String(args[0])) ?? null;
      case "quickfireSessionBind": {
        const input = args[0] as {
          slotId: string;
          channelId: string;
          agentEntityId?: string | null;
          contextId: string;
          replace?: boolean;
        };
        const existing = sessions.get(input.slotId);
        if (existing && !input.replace) {
          return { session: existing, created: false } satisfies WorkspaceQuickfireBindResult;
        }
        const session: WorkspaceQuickfireSession = {
          slotId: input.slotId as WorkspaceQuickfireSession["slotId"],
          channelId: input.channelId,
          agentEntityId: input.agentEntityId ?? null,
          contextId: input.contextId,
          createdAt: (now += 1),
          clearedAt: null,
          promotedAt: null,
        };
        sessions.set(input.slotId, session);
        return { session, created: true } satisfies WorkspaceQuickfireBindResult;
      }
      case "quickfireSessionClear": {
        const existing = sessions.get(String(args[0]));
        if (!existing) return null;
        sessions.delete(existing.slotId);
        if (existing.promotedAt === null) {
          queue.set(existing.channelId, {
            channelId: existing.channelId,
            slotId: existing.slotId,
            agentEntityId: existing.agentEntityId,
            contextId: existing.contextId,
            closeId: `clear:${existing.channelId}`,
          });
        }
        return { ...existing, clearedAt: (now += 1) };
      }
      case "quickfireSessionPromote": {
        const existing = sessions.get(String(args[0]));
        if (!existing) return null;
        const promoted = { ...existing, promotedAt: existing.promotedAt ?? (now += 1) };
        sessions.set(promoted.slotId, promoted);
        return promoted;
      }
      case "quickfireSessionList":
        return [...sessions.values()];
      case "quickfireCleanupPage": {
        const input = args[0] as { closeId?: string };
        const items = [...queue.values()]
          .filter((row) => input.closeId === undefined || row.closeId === input.closeId)
          .map(({ closeId: _closeId, ...rest }) => rest);
        return {
          items,
          nextCursor: null,
        } as unknown as WorkspaceQuickfireCleanupPage;
      }
      case "quickfireCleanupAck": {
        for (const channelId of args[0] as string[]) queue.delete(channelId);
        return undefined;
      }
      default:
        throw new Error(`unexpected WorkspaceDO method: ${method}`);
    }
  });
  return { dispatch, sessions, queue };
}

function makeService(overrides: Partial<QuickfireServiceDeps> = {}) {
  const store = fakeWorkspaceDo();
  const createAgent = vi.fn(
    async ({ channelId, contextId }: { channelId: string; contextId: string }) => ({
      entityId: `do:workers/quickfire-agent:QuickfireAgentWorker:${channelId}`,
      contextId,
    })
  );
  const releaseAgent = vi.fn(async () => undefined);
  let channelSeq = 0;
  const definition = createQuickfireService({
    doDispatch: { dispatch: store.dispatch } as never,
    workspaceId: "ws",
    harness: { source: "workers/quickfire-agent", className: "QuickfireAgentWorker" },
    createAgent,
    releaseAgent,
    resolveSlotContext: async () => "ctx-panel",
    newChannelId: () => `quickfire-${(channelSeq += 1)}`,
    channelActivity: async () => ({ messageCount: 3, lastActivityAt: 12_345 }),
    ...overrides,
  });
  const call = <T>(method: string, args: unknown[]) =>
    definition.handler(ctx, method, args) as Promise<T>;
  return { definition, store, createAgent, releaseAgent, call };
}

describe("quickfire service", () => {
  // `code` is the shell chrome (`code:apps/shell@<ev>`), the origin that carries
  // the user's gesture; agents never reach this surface (agentFacing is false
  // on every method and there is no `agent` principal).
  it("declares the user/host/code principal contract and no agent-facing methods", () => {
    const { definition } = makeService();
    expect(definition.authority).toEqual({ principals: ["user", "host", "code"] });
    for (const [name, schema] of Object.entries(definition.methods)) {
      expect(schema.agentFacing, `${name} must stay out of the agent tool surface`).toBe(false);
    }
  });

  it("places the channel in the panel's context before the vessel exists", async () => {
    // Placement goes to whoever activates the Durable Object first and is
    // permanent. If the vessel — or worse, a client — got there first, the
    // conversation's channel would live in that caller's context instead of the
    // panel's, and nothing would ever move it back.
    const order: string[] = [];
    const placeChannel = vi.fn(async () => {
      order.push("placeChannel");
    });
    const { call, store } = makeService({
      placeChannel,
      createAgent: vi.fn(async ({ channelId, contextId }) => {
        order.push("createAgent");
        return {
          entityId: `do:workers/quickfire-agent:QuickfireAgentWorker:${channelId}`,
          contextId,
        };
      }),
    });

    await call<QuickfireSession>("sessionFor", [{ slotId: "slot-a" }]);

    expect(order).toEqual(["placeChannel", "createAgent"]);
    expect(placeChannel).toHaveBeenCalledWith({
      channelId: "quickfire-1",
      contextId: "ctx-panel",
    });
    expect(store.sessions.get("slot-a")?.contextId).toBe("ctx-panel");
  });

  it("creates the backing exactly once and resumes the same conversation afterwards", async () => {
    const { call, createAgent } = makeService();

    const fresh = await call<QuickfireSession>("sessionFor", [{ slotId: "slot-a" }]);
    expect(fresh.state).toBe("fresh");
    expect(fresh.channelId).toBe("quickfire-1");
    expect(fresh.agentEntityId).toBe("do:workers/quickfire-agent:QuickfireAgentWorker:quickfire-1");
    // A brand-new conversation reports a real zero, not "unknown".
    expect(fresh.messageCount).toBe(0);

    const resumed = await call<QuickfireSession>("sessionFor", [{ slotId: "slot-a" }]);
    expect(resumed.state).toBe("resumed");
    expect(resumed.channelId).toBe("quickfire-1");
    expect(resumed.messageCount).toBe(3);
    expect(resumed.lastActivityAt).toBe(12_345);
    expect(createAgent).toHaveBeenCalledTimes(1);
  });

  it("retires the vessel it built when another opener won the slot", async () => {
    const { call, releaseAgent, store, createAgent } = makeService();
    // The lookup misses, then a concurrent opener commits the mapping while
    // this call is still creating its vessel — exactly the window the DO's
    // `created: false` answer exists to close.
    createAgent.mockImplementationOnce(async ({ channelId, contextId }) => {
      store.sessions.set("slot-a", {
        slotId: "slot-a" as WorkspaceQuickfireSession["slotId"],
        channelId: "quickfire-winner",
        agentEntityId: "do:workers/quickfire-agent:QuickfireAgentWorker:quickfire-winner",
        contextId: "ctx-panel",
        createdAt: 1,
        clearedAt: null,
        promotedAt: null,
      });
      return {
        entityId: `do:workers/quickfire-agent:QuickfireAgentWorker:${channelId}`,
        contextId,
      };
    });

    const result = await call<QuickfireSession>("sessionFor", [{ slotId: "slot-a" }]);
    expect(result.channelId).toBe("quickfire-winner");
    expect(result.state).toBe("resumed");
    expect(releaseAgent).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "quickfire-1" })
    );
  });

  it("clear archives the conversation through the recorded queue", async () => {
    const { call, releaseAgent, store } = makeService();
    await call("sessionFor", [{ slotId: "slot-a" }]);

    const cleared = await call<{ cleared: boolean; archived: number }>("clear", [
      { slotId: "slot-a" },
    ]);
    expect(cleared).toEqual({ cleared: true, archived: 1 });
    expect(releaseAgent).toHaveBeenCalledWith({
      agentEntityId: "do:workers/quickfire-agent:QuickfireAgentWorker:quickfire-1",
      channelId: "quickfire-1",
      contextId: "ctx-panel",
    });
    expect(store.queue.size).toBe(0);

    expect(await call("clear", [{ slotId: "slot-a" }])).toEqual({ cleared: false, archived: 0 });
  });

  it("clearing a promoted conversation detaches it without archiving the channel", async () => {
    const { call, releaseAgent } = makeService();
    await call("sessionFor", [{ slotId: "slot-a" }]);
    await call("promote", [{ slotId: "slot-a" }]);

    expect(await call("clear", [{ slotId: "slot-a" }])).toEqual({ cleared: true, archived: 0 });
    expect(releaseAgent).not.toHaveBeenCalled();
  });

  it("reports a promoted slot as promoted until the user starts over", async () => {
    const { call, createAgent } = makeService();
    await call("sessionFor", [{ slotId: "slot-a" }]);
    const promoted = await call<QuickfireSession>("promote", [{ slotId: "slot-a" }]);
    expect(promoted.state).toBe("promoted");
    expect(promoted.promotedAt).toBeTypeOf("number");

    const reopened = await call<QuickfireSession>("sessionFor", [{ slotId: "slot-a" }]);
    expect(reopened.state).toBe("promoted");
    expect(reopened.channelId).toBe("quickfire-1");
    expect(createAgent).toHaveBeenCalledTimes(1);

    const started = await call<QuickfireSession>("sessionFor", [{ slotId: "slot-a", fresh: true }]);
    expect(started.state).toBe("fresh");
    expect(started.channelId).toBe("quickfire-2");
    expect(createAgent).toHaveBeenCalledTimes(2);
  });

  it("promote on a slot with no conversation returns null instead of inventing one", async () => {
    const { call } = makeService();
    expect(await call("promote", [{ slotId: "nothing" }])).toBeNull();
  });

  it("keeps a row queued when its agent refuses to retire", async () => {
    const releaseAgent = vi.fn(async () => {
      throw new Error("vessel unreachable");
    });
    const { call, store } = makeService({ releaseAgent });
    await call("sessionFor", [{ slotId: "slot-a" }]);

    expect(await call("clear", [{ slotId: "slot-a" }])).toEqual({ cleared: true, archived: 0 });
    // Detached from the slot, but the archival work survives for the next drain.
    expect(store.sessions.has("slot-a")).toBe(false);
    expect([...store.queue.keys()]).toEqual(["quickfire-1"]);

    const drained = await call<{ archived: number; failed: number }>("drainCleanup", [undefined]);
    expect(drained).toEqual({ archived: 0, failed: 1 });
  });

  it("degrades to unknown activity rather than reporting a fabricated empty channel", async () => {
    const { call } = makeService({
      channelActivity: async () => {
        throw new Error("channel log unavailable");
      },
    });
    await call("sessionFor", [{ slotId: "slot-a" }]);
    const resumed = await call<QuickfireSession>("sessionFor", [{ slotId: "slot-a" }]);
    expect(resumed.messageCount).toBeNull();
    expect(resumed.lastActivityAt).toBeNull();
  });

  it("lists live mappings and drops them once cleared", async () => {
    const { call } = makeService();
    await call("sessionFor", [{ slotId: "slot-a" }]);
    await call("sessionFor", [{ slotId: "slot-b" }]);
    expect((await call<unknown[]>("list", [])).length).toBe(2);

    await call("clear", [{ slotId: "slot-a" }]);
    expect(await call("list", [])).toEqual([
      expect.objectContaining({ slotId: "slot-b", channelId: "quickfire-2" }),
    ]);
  });

  it("refuses to bind a slot that is not open", async () => {
    const { call } = makeService({ resolveSlotContext: async () => null });
    await expect(call("sessionFor", [{ slotId: "gone" }])).rejects.toThrow(
      "Panel slot is not open: gone"
    );
  });
});

/**
 * Binding-time authority (spec §6.2). The grants themselves are covered in
 * `quickfireAuthority.test.ts`; what matters here is that the SERVICE drives
 * the binder on exactly the lifecycle events that should move authority and on
 * no others — in particular, that nothing here consults a clock.
 */
describe("quickfire authority lifecycle", () => {
  function authorityService(overrides: Partial<QuickfireServiceDeps> = {}) {
    const bind = vi.fn(async () => true);
    const release = vi.fn(async () => undefined);
    const retargetSession = vi.fn(async () => undefined);
    const harness = makeService({
      authority: { bind, release },
      retargetSession,
      ...overrides,
    });
    return { ...harness, bind, release, retargetSession };
  }

  it("binds once when the conversation is created and not again on resume", async () => {
    const { call, bind } = authorityService();

    await call("sessionFor", [{ slotId: "slot-a" }]);
    expect(bind).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith({
      slotId: "slot-a",
      channelId: "quickfire-1",
      targetContextId: "ctx-panel",
      decidedBy: "user:workspace",
    });

    await call("sessionFor", [{ slotId: "slot-a" }]);
    // Resuming an unmoved slot is not a new authority decision.
    expect(bind).toHaveBeenCalledTimes(1);
  });

  it("re-mints for the new context when the slot navigated elsewhere", async () => {
    let context = "ctx-panel";
    const { call, bind, release, retargetSession } = authorityService({
      resolveSlotContext: async () => context,
    });

    await call("sessionFor", [{ slotId: "slot-a" }]);
    context = "ctx-after-navigation";
    const resumed = await call<QuickfireSession>("sessionFor", [{ slotId: "slot-a" }]);

    expect(resumed.state).toBe("resumed");
    // The conversation survives navigation; its authority does not follow it
    // silently — the old context's grants go and a new pair is minted.
    expect(release).toHaveBeenCalledWith({ channelId: "quickfire-1" });
    expect(bind).toHaveBeenLastCalledWith({
      slotId: "slot-a",
      channelId: "quickfire-1",
      targetContextId: "ctx-after-navigation",
      decidedBy: "user:workspace",
    });
    expect(retargetSession).toHaveBeenCalledWith({
      slotId: "slot-a",
      contextId: "ctx-after-navigation",
    });
    expect(resumed.contextId).toBe("ctx-after-navigation");
  });

  it("does not persist a retarget when the re-binding is refused", async () => {
    let context = "ctx-panel";
    const bind = vi.fn(async () => true);
    const release = vi.fn(async () => undefined);
    const retargetSession = vi.fn(async () => undefined);
    const { call } = makeService({
      authority: { bind, release },
      retargetSession,
      resolveSlotContext: async () => context,
    });

    await call("sessionFor", [{ slotId: "slot-a" }]);
    bind.mockResolvedValueOnce(false);
    context = "ctx-privileged";
    await call("sessionFor", [{ slotId: "slot-a" }]);

    // The old grants are gone either way — a refused re-binding must not leave
    // the previous context's reach in place.
    expect(release).toHaveBeenCalledWith({ channelId: "quickfire-1" });
    expect(retargetSession).not.toHaveBeenCalled();
  });

  it("keeps the existing binding when the slot's context cannot be read", async () => {
    let fail = false;
    const { call, bind, release } = authorityService({
      resolveSlotContext: async () => {
        if (fail) throw new Error("workspace-state unavailable");
        return "ctx-panel";
      },
    });

    await call("sessionFor", [{ slotId: "slot-a" }]);
    fail = true;
    await call("sessionFor", [{ slotId: "slot-a" }]);

    // Guessing in either direction is worse than waiting for the next open.
    expect(release).not.toHaveBeenCalled();
    expect(bind).toHaveBeenCalledTimes(1);
  });

  it("releases the conversation's grants when it is cleared", async () => {
    const { call, release } = authorityService();

    await call("sessionFor", [{ slotId: "slot-a" }]);
    await call("clear", [{ slotId: "slot-a" }]);
    expect(release).toHaveBeenCalledWith({ channelId: "quickfire-1" });
  });

  it("releases a promoted conversation's grants without archiving its channel", async () => {
    const { call, release, releaseAgent } = authorityService();

    await call("sessionFor", [{ slotId: "slot-a" }]);
    await call("promote", [{ slotId: "slot-a" }]);
    await call("clear", [{ slotId: "slot-a" }]);

    // The chat panel owns the transcript now, but the overlay's pre-granted
    // debug reach does not follow it there.
    expect(release).toHaveBeenCalledWith({ channelId: "quickfire-1" });
    expect(releaseAgent).not.toHaveBeenCalled();
  });

  it("releases grants as part of the slot-close cleanup drain", async () => {
    const { call, release, store } = authorityService();

    await call("sessionFor", [{ slotId: "slot-a" }]);
    // Slot close only *records* the work; the host-side drain executes it.
    store.queue.set("quickfire-1", {
      channelId: "quickfire-1",
      slotId: "slot-a",
      agentEntityId: "do:workers/quickfire-agent:QuickfireAgentWorker:quickfire-1",
      contextId: "ctx-panel",
      closeId: "close-1",
    });
    store.sessions.delete("slot-a");

    await call("drainCleanup", [{}]);
    expect(release).toHaveBeenCalledWith({ channelId: "quickfire-1" });
  });

  it("leaves grants in place when the agent refuses to retire", async () => {
    const releaseAgent = vi.fn(async () => {
      throw new Error("vessel is wedged");
    });
    const { call, release, store } = authorityService({ releaseAgent });

    await call("sessionFor", [{ slotId: "slot-a" }]);
    store.queue.set("quickfire-1", {
      channelId: "quickfire-1",
      slotId: "slot-a",
      agentEntityId: "do:workers/quickfire-agent:QuickfireAgentWorker:quickfire-1",
      contextId: "ctx-panel",
      closeId: "close-1",
    });

    const result = await call<{ archived: number; failed: number }>("drainCleanup", [{}]);
    expect(result.failed).toBe(1);
    // A half-released conversation must never be left running with authority
    // nobody can see it holding; the row stays queued and the next drain retries.
    expect(release).not.toHaveBeenCalled();
  });

  it("works unchanged when no binder is wired", async () => {
    const { call } = makeService();
    await expect(
      call<QuickfireSession>("sessionFor", [{ slotId: "slot-a" }])
    ).resolves.toMatchObject({ state: "fresh" });
    await expect(call("clear", [{ slotId: "slot-a" }])).resolves.toMatchObject({ cleared: true });
  });
});
