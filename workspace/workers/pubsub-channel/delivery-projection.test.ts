import { beforeEach, describe, expect, it } from "vitest";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelEvent } from "@workspace/harness";
import type { ChannelAgenticContext } from "@workspace/pubsub";
import {
  CHANNEL_DELIVERY_PROJECTION_VERSION,
  ChannelDeliveryProjection,
} from "./delivery-projection.js";

const CHANNEL_ID = "channel-projection-test";
const AGENT_ID = "do:workers/agent-worker:AiChatWorker:agent-a";

function event(
  id: number,
  type: string,
  payload: unknown,
  senderId = "panel:user",
  messageId = `event-${id}`
): ChannelEvent {
  return { id, type, payload, senderId, messageId, ts: id * 1_000 } as ChannelEvent;
}

function relationship(
  id: number,
  revision: number,
  type:
    | "channel.subscription.opened"
    | "channel.subscription.revised"
    | "channel.subscription.ended" = "channel.subscription.opened"
): ChannelEvent {
  return event(
    id,
    type,
    type === "channel.subscription.ended"
      ? { participantId: AGENT_ID, revision }
      : {
          participantId: AGENT_ID,
          revision,
          delivery: "all",
          endpoint: { kind: "entity", entityId: AGENT_ID },
          metadata: { type: "agent", handle: "agent-a" },
          applicationConfig: { version: 1, value: { respondPolicy: "always" } },
        },
    AGENT_ID
  );
}

function message(
  id: number,
  senderId = "panel:user",
  messageId = `message-${id}`,
  replyTo?: string
): ChannelEvent {
  return event(
    id,
    "agentic.trajectory.v1/event",
    {
      kind: "message.completed",
      actor: { kind: senderId.startsWith("do:") ? "agent" : "user", id: senderId },
      causality: { messageId },
      payload: {
        protocol: "agentic.trajectory.v1",
        role: senderId.startsWith("do:") ? "assistant" : "user",
        blocks: [],
        outcome: "completed",
        ...(replyTo ? { replyTo } : {}),
      },
      createdAt: new Date(id * 1_000).toISOString(),
    },
    senderId,
    `envelope-${messageId}`
  );
}

describe("ChannelDeliveryProjection", () => {
  let sql: SqlStorage;
  let projection: ChannelDeliveryProjection;

  beforeEach(async () => {
    sql = (await createInMemorySql()) as unknown as SqlStorage;
    ChannelDeliveryProjection.createTables(sql);
    projection = new ChannelDeliveryProjection(sql, (callback) => callback(), CHANNEL_ID);
    projection.initializeChannelConfig({ conversationPolicy: "directed", agentHopLimit: 4 });
  });

  it("replays a canonical append omitted before a simulated activation loss", () => {
    projection.fold(relationship(1, 1));
    expect(() => projection.fold(message(3))).toThrow(/expected 2, received 3/);

    const restarted = new ChannelDeliveryProjection(sql, (callback) => callback(), CHANNEL_ID);
    expect(restarted.fold(message(2)).inserted).toBe(1);
    expect(restarted.fold(message(3)).inserted).toBe(1);
    expect(restarted.cursor()).toBe(3);
    expect(
      sql.exec(`SELECT COUNT(*) AS count FROM channel_delivery_mailbox`).toArray()[0]?.["count"]
    ).toBe(2);
  });

  it("routes at event sequence and terminalizes work when the relationship departs", () => {
    projection.fold(relationship(1, 1));
    projection.fold(message(2));
    projection.fold(relationship(3, 2, "channel.subscription.ended"));
    expect(projection.fold(message(4)).inserted).toBe(0);
    projection.fold(relationship(5, 3));
    expect(projection.fold(message(6)).inserted).toBe(1);

    const rows = sql
      .exec(
        `SELECT event_sequence, subscription_revision, state
           FROM channel_delivery_mailbox ORDER BY event_sequence`
      )
      .toArray();
    expect(rows).toEqual([
      { event_sequence: 2, subscription_revision: 1, state: "terminal-departed" },
      { event_sequence: 6, subscription_revision: 3, state: "ready" },
    ]);
  });

  it("retires a blocked receiver revision so recovery replay cannot leave its lane wedged", () => {
    projection.fold(relationship(1, 1));
    projection.fold(message(2));
    sql.exec(
      `UPDATE channel_delivery_mailbox
          SET state = 'retrying', attempts = 8, next_attempt_at = ?
        WHERE event_sequence = 2`,
      Date.now() + 30_000
    );

    projection.fold(relationship(3, 2, "channel.subscription.revised"));
    expect(projection.fold(message(4)).inserted).toBe(1);

    expect(
      sql
        .exec(
          `SELECT event_sequence, subscription_revision, state
             FROM channel_delivery_mailbox ORDER BY event_sequence`
        )
        .toArray()
    ).toEqual([
      { event_sequence: 2, subscription_revision: 1, state: "terminal-retired" },
      { event_sequence: 4, subscription_revision: 2, state: "ready" },
    ]);
  });

  it("delivers to a durable member without any activation-local transport", () => {
    projection.fold(relationship(1, 1));
    expect(projection.fold(message(2)).inserted).toBe(1);
    expect(projection.diagnostics(2)).toMatchObject({
      cursor: 2,
      lag: 0,
      memberships: [{ active: true, endpointKind: "entity", delivery: "all", count: 1 }],
      mailbox: [{ state: "ready", count: 1 }],
    });
  });

  it("resets disposable state on a projection version change and preserves initial config", () => {
    projection.fold(relationship(1, 1));
    projection.fold(message(2));
    sql.exec(
      `UPDATE channel_delivery_projection_cursor SET projection_version = ? WHERE singleton = 1`,
      CHANNEL_DELIVERY_PROJECTION_VERSION - 1
    );

    expect(projection.cursor()).toBe(0);
    expect(
      sql.exec(`SELECT COUNT(*) AS count FROM channel_delivery_mailbox`).toArray()[0]?.["count"]
    ).toBe(0);
    projection.fold(relationship(1, 1));
    projection.fold(message(2));
    const context = JSON.parse(
      String(
        sql.exec(`SELECT agentic_context_json FROM channel_delivery_mailbox`).toArray()[0]?.[
          "agentic_context_json"
        ]
      )
    ) as ChannelAgenticContext;
    expect(context.channelConfig).toEqual({
      conversationPolicy: "directed",
      agentHopLimit: 4,
    });
  });

  it("co-derives conversation, configuration, roster, and reply identity", () => {
    projection.fold(relationship(1, 1));
    projection.fold(message(2, "panel:author", "origin"));
    projection.fold(
      event(3, "config-update", { conversationPolicy: "moderated", agentHopLimit: 2 }, "system")
    );
    projection.fold(message(4, "panel:reply", "reply", "origin"));

    const row = sql
      .exec(`SELECT agentic_context_json FROM channel_delivery_mailbox WHERE event_sequence = 4`)
      .toArray()[0]!;
    const context = JSON.parse(String(row["agentic_context_json"])) as ChannelAgenticContext;
    expect(context).toMatchObject({
      version: 1,
      channelConfig: { conversationPolicy: "moderated", agentHopLimit: 2 },
      conversation: {
        lastCompletedSender: "panel:reply",
        previousCompletedSender: "panel:author",
      },
      replyToSenderId: "panel:author",
      relationships: [
        {
          participantId: AGENT_ID,
          applicationConfig: { version: 1, value: { respondPolicy: "always" } },
        },
      ],
    });
  });
});
