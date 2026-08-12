// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatLayout } from "./ChatLayout";

vi.mock("./ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("./ChatConnectionErrorBanner", () => ({ ChatConnectionErrorBanner: () => null }));
vi.mock("./ChatDirtyRepoWarnings", () => ({ ChatDirtyRepoWarnings: () => null }));
vi.mock("./LazyChatActionBar", () => ({
  LazyChatActionBar: () => <div data-testid="action-bar" />,
}));
vi.mock("./ChatMessageArea", () => ({
  ChatMessageArea: (props: {
    renderMessage?: unknown;
    renderInlineGroup?: unknown;
    renderInvocation?: unknown;
    features: { inlineUi: boolean };
  }) => (
    <div
      data-testid="message-area"
      data-inline-ui={String(props.features.inlineUi)}
      data-render-message={String(props.renderMessage !== undefined)}
      data-render-inline-group={String(props.renderInlineGroup !== undefined)}
      data-render-invocation={String(props.renderInvocation !== undefined)}
    />
  ),
}));
vi.mock("./LazyChatFeedbackArea", () => ({
  LazyChatFeedbackArea: () => <div data-testid="feedback-area" />,
}));
vi.mock("./Outbox", () => ({ Outbox: () => null }));
vi.mock("./PendingDeliveryQueue", () => ({ PendingDeliveryQueue: () => null }));
vi.mock("./ChatDebugConsole", () => ({ ChatDebugConsole: () => null }));
vi.mock("./ChatInput", () => ({ ChatInput: () => <div data-testid="composer" /> }));

describe("ChatLayout sizing", () => {
  const fullFeatures = {
    feedback: true,
    inlineUi: true,
    actionBar: true,
    clientEval: true,
  } as const;

  it("fills its AgenticChat host so embedded composers remain visible", () => {
    const { container, getByTestId } = render(<ChatLayout features={fullFeatures} />);
    const root = container.querySelector<HTMLElement>(".agentic-chat-root");
    expect(root?.style.height).toBe("100%");
    expect(getByTestId("composer")).toBeTruthy();
  });

  it("mounts every explicitly selected browser-owned UI surface", () => {
    const { getByTestId } = render(<ChatLayout features={fullFeatures} />);

    expect(getByTestId("action-bar")).toBeTruthy();
    expect(getByTestId("feedback-area")).toBeTruthy();
    expect(getByTestId("message-area").dataset["inlineUi"]).toBe("true");
  });

  it("omits unselected UI surfaces and forwards transcript renderers", () => {
    const renderMessage = vi.fn();
    const renderInlineGroup = vi.fn();
    const renderInvocation = vi.fn();
    const { getByTestId, queryByTestId } = render(
      <ChatLayout
        features={{ feedback: false, inlineUi: false, actionBar: false, clientEval: false }}
        renderMessage={renderMessage}
        renderInlineGroup={renderInlineGroup}
        renderInvocation={renderInvocation}
      />
    );

    expect(queryByTestId("action-bar")).toBeNull();
    expect(queryByTestId("feedback-area")).toBeNull();
    expect(getByTestId("message-area")).toMatchObject({
      dataset: expect.objectContaining({
        inlineUi: "false",
        renderMessage: "true",
        renderInlineGroup: "true",
        renderInvocation: "true",
      }),
    });
  });
});
