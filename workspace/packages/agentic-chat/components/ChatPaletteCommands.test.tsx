// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPaletteCommands } from "./ChatPaletteCommands";

const palette = vi.hoisted(() => ({
  commands: [] as Array<{ id: string; label: string; hint?: string; section: string }>,
  run: null as ((id: string) => void) | null,
}));

vi.mock("@workspace/react", () => ({
  usePaletteCommands: (
    commands: Array<{ id: string; label: string; hint?: string; section: string }>,
    onRun: (id: string) => void
  ) => {
    palette.commands = commands;
    palette.run = onRun;
  },
}));
vi.mock("../context/ChatContext", () => ({
  useChatContext: () => ({
    onNewConversation: vi.fn(),
    messages: [],
    selfId: "user:self",
    participants: {},
    agentBusy: false,
    pendingSendCount: 0,
    flushOutboxAndInterrupt: vi.fn(),
    cancelPendingMessage: vi.fn(),
    undoableAction: undefined,
    undoLastAction: undefined,
  }),
}));
vi.mock("./ChatNativeActionsDialog", () => ({
  ChatNativeActionsDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="native-conversation-actions" /> : null,
}));

afterEach(() => {
  palette.commands = [];
  palette.run = null;
  Reflect.deleteProperty(globalThis, "__vibestudioHostPlatform");
});

describe("ChatPaletteCommands native presentation", () => {
  it("keeps the native-only conversation entry out of the desktop palette", () => {
    render(<ChatPaletteCommands />);
    expect(palette.commands.map((command) => command.id)).not.toContain(
      "chat-conversation-actions"
    );
  });

  it("opens touch-oriented conversation controls from the contributed command", () => {
    Object.assign(globalThis, { __vibestudioHostPlatform: "mobile" });
    const view = render(<ChatPaletteCommands />);
    expect(palette.commands).toContainEqual({
      id: "chat-conversation-actions",
      label: "Conversation actions",
      hint: "People, agents, branches, and autonomy",
      section: "Chat",
    });

    act(() => palette.run?.("chat-conversation-actions"));
    expect(view.getByTestId("native-conversation-actions")).toBeTruthy();
  });
});
