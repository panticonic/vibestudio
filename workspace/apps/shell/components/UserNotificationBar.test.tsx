// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellUserNotification } from "../shell/client";

const shellClient = vi.hoisted(() => ({
  list: vi.fn(),
  openChannel: vi.fn(),
  acknowledge: vi.fn(),
}));
const eventHandlers = vi.hoisted(
  () => new Map<string, (payload: Record<string, unknown>) => void>()
);

vi.mock("../shell/client", () => ({
  userNotifications: shellClient,
}));
vi.mock("../shell/useShellEvent", () => ({
  useShellEvent: (event: string, callback: (payload: Record<string, unknown>) => void) => {
    eventHandlers.set(event, callback);
  },
}));
vi.mock("@radix-ui/themes", () => ({
  Badge: ({ children, title }: { children?: React.ReactNode; title?: string }) => (
    <span title={title}>{children}</span>
  ),
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Flex: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  IconButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Spinner: () => <span>Loading</span>,
  Text: ({
    children,
    truncate: _truncate,
    color: _color,
    weight: _weight,
    ...props
  }: React.HTMLAttributes<HTMLSpanElement> & {
    truncate?: boolean;
    color?: string;
    weight?: string;
  }) => <span {...props}>{children}</span>,
}));
vi.mock("@radix-ui/react-icons", () => ({
  ChatBubbleIcon: () => <span />,
  Cross2Icon: () => <span />,
  InfoCircledIcon: () => <span />,
  ReloadIcon: () => <span />,
}));

import { UserNotificationBar } from "./UserNotificationBar";

function channelNotification(
  channelId: string,
  patch: Partial<ShellUserNotification> = {}
): ShellUserNotification {
  return {
    id: `channel.invite:${channelId}`,
    userId: "usr_bob",
    kind: "channel.invite",
    title: "Channel invitation",
    createdAt: 10,
    revision: 1,
    channelInvite: {
      channelId,
      channelTitle: `Conversation ${channelId}`,
      userId: "usr_bob",
      memberId: "user:usr_bob",
      handle: "bob",
      addedBy: "user:usr_alice",
      addedAt: 10,
      inviter: {
        userId: "usr_alice",
        handle: "alice",
        displayName: "Alice",
        role: "member",
      },
    },
    ...patch,
  };
}

describe("UserNotificationBar", () => {
  beforeEach(() => {
    eventHandlers.clear();
    shellClient.list.mockReset().mockResolvedValue([]);
    shellClient.openChannel.mockReset().mockResolvedValue({ id: "panel-chat" });
    shellClient.acknowledge.mockReset().mockResolvedValue(true);
  });

  it("renders a channel invitation from the generic inbox", async () => {
    shellClient.list.mockResolvedValue([channelNotification("one"), channelNotification("two")]);
    render(<UserNotificationBar />);

    expect(await screen.findByText("Conversation one")).toBeTruthy();
    expect(screen.getByText(/invited by Alice/)).toBeTruthy();
    expect(screen.getByTitle("2 pending notifications").textContent).toBe("+1");
  });

  it("refreshes from targeted account events without installing a timer poll", async () => {
    const setInterval = vi.spyOn(window, "setInterval");
    render(<UserNotificationBar />);
    expect(setInterval).not.toHaveBeenCalled();
    setInterval.mockRestore();
    await waitFor(() => expect(shellClient.list).toHaveBeenCalledTimes(1));
    shellClient.list.mockResolvedValue([channelNotification("live")]);

    eventHandlers.get("user-notifications-changed")?.({ changedAt: 20 });

    expect(await screen.findByText("Conversation live")).toBeTruthy();
  });

  it("opens a channel before acknowledging its generic notification", async () => {
    const order: string[] = [];
    shellClient.list.mockResolvedValue([channelNotification("one")]);
    shellClient.openChannel.mockImplementation(async () => {
      order.push("open");
      return { id: "panel-chat" };
    });
    shellClient.acknowledge.mockImplementation(async () => {
      order.push("acknowledge");
      return true;
    });
    const created = vi.fn();
    window.addEventListener("shell-panel-created", created);
    render(<UserNotificationBar />);

    fireEvent.click(await screen.findByRole("button", { name: "Join" }));

    await waitFor(() => expect(screen.queryByText("Conversation one")).toBeNull());
    expect(order).toEqual(["open", "acknowledge"]);
    expect(shellClient.acknowledge).toHaveBeenCalledWith("channel.invite:one");
    expect((created.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ panelId: "panel-chat" });
    window.removeEventListener("shell-panel-created", created);
  });

  it("renders and dismisses notification kinds unknown to the shell", async () => {
    shellClient.list.mockResolvedValue([
      {
        id: "build:done",
        userId: "usr_bob",
        kind: "build.completed",
        title: "Build complete",
        message: "The release build is ready.",
        createdAt: 10,
        revision: 1,
      },
    ]);
    render(<UserNotificationBar />);

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss Build complete" }));

    await waitFor(() => expect(screen.queryByText("Build complete")).toBeNull());
    expect(shellClient.acknowledge).toHaveBeenCalledWith("build:done");
  });

  it("shows the actual snapshot error instead of masking it", async () => {
    shellClient.list.mockRejectedValue(new Error("account subject missing"));
    render(<UserNotificationBar />);

    expect(await screen.findByText(/account subject missing/)).toBeTruthy();
  });
});
