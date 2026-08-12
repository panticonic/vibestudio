// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ChatMessageArea } from "./ChatMessageArea";

const chatContext = {
  connected: true,
  messages: [],
  participants: {},
  selfId: null,
  allParticipants: {},
  inlineUiComponents: new Map(),
  messageTypeComponents: new Map(),
  hasMoreHistory: false,
  loadingMore: false,
  onLoadEarlierMessages: undefined,
  onInterrupt: undefined,
  onCancelInvocation: undefined,
  onFocusPanel: undefined,
  onReloadPanel: undefined,
  chat: { send: vi.fn() },
  browserHandoffCaller: undefined,
  clientRef: { current: null },
  deferredAgent: undefined,
  connectionError: undefined,
};

vi.mock("../context/ChatContext", () => ({
  useChatContext: () => chatContext,
}));
vi.mock("../context/ChatInputContext", () => ({
  useChatInputActions: () => ({ setReplyTo: vi.fn() }),
}));
vi.mock("./FirstRunCard", () => ({
  FirstRunCard: () => <div data-testid="stock-empty-state">Stock first run</div>,
}));
vi.mock("./MessageList", () => ({
  MessageList: ({ emptyState }: { emptyState?: ReactNode }) => (
    <div data-testid="message-list">{emptyState}</div>
  ),
}));
vi.mock("./SignalPills", () => ({ SignalPills: () => null }));
vi.mock("./Outbox", () => ({ deriveActiveOutbox: () => [] }));

describe("ChatMessageArea empty transcript", () => {
  it("lets products delegate to the complete stock empty state", () => {
    const renderEmptyState = vi.fn((defaultContent: ReactNode) => (
      <section data-testid="product-empty-state">{defaultContent}</section>
    ));

    render(
      <ChatMessageArea
        features={{ feedback: false, inlineUi: false, actionBar: false, clientEval: false }}
        renderEmptyState={renderEmptyState}
      />
    );

    expect(renderEmptyState).toHaveBeenCalledOnce();
    expect(
      screen
        .getByTestId("product-empty-state")
        .contains(screen.getByTestId("stock-empty-state"))
    ).toBe(true);
  });
});
