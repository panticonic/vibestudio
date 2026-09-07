import { describe, expect, it } from "vitest";
import {
  agentMessageNotificationData,
  channelInviteFromNotification,
  type UserNotification,
} from "./userNotifications.js";

const notification = (kind: string, data: Record<string, unknown>): UserNotification => ({
  id: "notification-1",
  userId: "user-1",
  kind,
  title: "Conversation",
  data,
  createdAt: 1,
  revision: 1,
});

describe("conversation notification identities", () => {
  it("requires the producer-owned channel target on agent messages", () => {
    const data = {
      channelId: "channel-1",
      messageId: "message-1",
      senderParticipantId: "agent-1",
      rung: "inbox",
    };
    expect(agentMessageNotificationData(notification("agent.message", data))).toBeNull();
    expect(
      agentMessageNotificationData(
        notification("agent.message", {
          ...data,
          channelTargetId: "do:channel-provider:Channel:channel-1",
        })
      )
    ).toMatchObject({
      channelId: "channel-1",
      channelTargetId: "do:channel-provider:Channel:channel-1",
    });
  });

  it("requires the producer-owned channel target on invitations", () => {
    const data = {
      channelId: "channel-1",
      userId: "user-1",
      memberId: "user:user-1",
      handle: "one",
      addedBy: "user:user-2",
      addedAt: 1,
    };
    expect(channelInviteFromNotification(notification("channel.invite", data))).toBeNull();
    expect(
      channelInviteFromNotification(
        notification("channel.invite", {
          ...data,
          channelTargetId: "do:channel-provider:Channel:channel-1",
        })
      )
    ).toMatchObject({
      channelId: "channel-1",
      channelTargetId: "do:channel-provider:Channel:channel-1",
    });
  });
});
