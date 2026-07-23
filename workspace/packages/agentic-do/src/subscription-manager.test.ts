import { describe, expect, it, vi } from "vitest";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelClient } from "./channel-client.js";
import { DOIdentity } from "./identity.js";
import { SubscriptionManager } from "./subscription-manager.js";

async function makeManager(
  channel: Partial<ChannelClient>,
  onRecovered?: ConstructorParameters<typeof SubscriptionManager>[3]
) {
  const sql = (await createInMemorySql()) as unknown as SqlStorage;
  const identity = new DOIdentity(sql);
  identity.createTables();
  identity.bootstrap(
    { source: "workers/test-agent", className: "TestAgentWorker", objectKey: "agent-1" },
    "session-1"
  );
  const manager = new SubscriptionManager(
    sql,
    () => channel as ChannelClient,
    identity,
    onRecovered
  );
  manager.createTables();
  return { manager, sql };
}

describe("SubscriptionManager", () => {
  it("does not leave a local subscription row when remote subscribe fails", async () => {
    const channel = {
      openSubscription: vi.fn(async () => {
        throw new Error("duplicate participant");
      }),
    };
    const { manager } = await makeManager(channel);

    await expect(
      manager.subscribe({
        channelId: "ch-1",
        contextId: "ctx-1",
        descriptor: { name: "Test", type: "agent", handle: "test" },
      })
    ).rejects.toThrow("duplicate participant");

    expect(manager.count()).toBe(0);
    expect(manager.listAll()).toEqual([]);
  });

  it("rename re-keys the channel and re-homes the context", async () => {
    const channel = {
      // The manager only stores the row + reads channelConfig/envelope opaquely;
      // a minimal stub cast to the full return type is enough here.
      openSubscription: vi.fn(
        async () =>
          ({
            result: { ok: true },
            closed: new Promise<void>(() => {}),
            release: vi.fn(),
            close: vi.fn(),
          }) as unknown as Awaited<ReturnType<ChannelClient["openSubscription"]>>
      ),
    };
    const { manager } = await makeManager(channel);
    await manager.subscribe({
      channelId: "ch-1",
      contextId: "ctx-src",
      descriptor: { name: "Test", type: "agent", handle: "test" },
    });

    manager.rename("ch-1", "ch-2", "ctx-fork");
    expect(manager.getContextId("ch-2")).toBe("ctx-fork");
  });

  it("reopens an unexpectedly closed response and hands replay to the owner", async () => {
    vi.useFakeTimers();
    try {
      let closeFirst!: () => void;
      const firstClosed = new Promise<void>((resolve) => {
        closeFirst = resolve;
      });
      const secondClosed = new Promise<void>(() => {});
      const close = vi.fn();
      const openSubscription = vi
        .fn()
        .mockResolvedValueOnce({
          result: { ok: true, participantId: "agent-1", envelope: { mode: "none" } },
          closed: firstClosed,
          release: vi.fn(),
          close,
        })
        .mockResolvedValueOnce({
          result: {
            ok: true,
            participantId: "agent-1",
            envelope: { mode: "after", logEvents: [] },
          },
          closed: secondClosed,
          release: vi.fn(),
          close,
        });
      const onRecovered = vi.fn(async () => {});
      const { manager } = await makeManager({ openSubscription }, onRecovered);
      await manager.subscribe({
        channelId: "ch-1",
        contextId: "ctx-1",
        config: { wakePolicy: "every-envelope" },
        descriptor: { name: "Test", type: "agent", handle: "test" },
      });

      closeFirst();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(250);

      expect(openSubscription).toHaveBeenCalledTimes(2);
      expect(openSubscription.mock.calls[1]?.[1]).toMatchObject({ replay: true });
      expect(onRecovered).toHaveBeenCalledWith({
        channelId: "ch-1",
        config: { wakePolicy: "every-envelope" },
        envelope: { mode: "after", logEvents: [] },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reopen a response closed by explicit unsubscribe", async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const closed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const close = vi.fn(() => finish());
      const openSubscription = vi.fn(async () => ({
        result: { ok: true },
        closed,
        release: vi.fn(() => finish()),
        close,
      })) as unknown as ChannelClient["openSubscription"];
      const { manager } = await makeManager({ openSubscription });
      await manager.subscribe({
        channelId: "ch-1",
        contextId: "ctx-1",
        descriptor: { name: "Test", type: "agent", handle: "test" },
      });

      await manager.unsubscribeFromChannel("ch-1");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(openSubscription).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases every activation stream without deleting durable membership or recovering", async () => {
    vi.useFakeTimers();
    try {
      const terminals: Array<() => void> = [];
      const close = vi.fn((index: number) => terminals[index]?.());
      const release = vi.fn((index: number) => terminals[index]?.());
      const openSubscription = vi.fn(async () => {
        const index = terminals.length;
        let terminal!: () => void;
        const closed = new Promise<void>((resolve) => {
          terminal = resolve;
        });
        terminals.push(terminal);
        return {
          result: { ok: true, participantId: "agent-1", envelope: { mode: "none" } },
          closed,
          release: () => release(index),
          close: () => close(index),
        };
      }) as unknown as ChannelClient["openSubscription"];
      const { manager } = await makeManager({ openSubscription });
      await manager.subscribe({
        channelId: "ch-1",
        contextId: "ctx-1",
        descriptor: { name: "Test", type: "agent", handle: "test" },
      });
      await manager.subscribe({
        channelId: "ch-2",
        contextId: "ctx-1",
        descriptor: { name: "Test", type: "agent", handle: "test" },
      });

      await expect(manager.releaseActivation()).resolves.toBe(2);
      expect(manager.listChannelIds()).toEqual(["ch-1", "ch-2"]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(openSubscription).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalledTimes(2);
      expect(close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
