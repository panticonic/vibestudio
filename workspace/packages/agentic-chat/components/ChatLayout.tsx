import React from "react";
import { Flex } from "@radix-ui/themes";
import { ChatHeader } from "./ChatHeader";
import { ChatConnectionErrorBanner } from "./ChatConnectionErrorBanner";
import { ChatDirtyRepoWarnings } from "./ChatDirtyRepoWarnings";
import { LazyChatActionBar } from "./LazyChatActionBar";
import { ChatMessageArea } from "./ChatMessageArea";
import { LazyChatFeedbackArea } from "./LazyChatFeedbackArea";
import { Outbox } from "./Outbox";
import { PendingDeliveryQueue } from "./PendingDeliveryQueue";
import { ChatInput } from "./ChatInput";
import { ChatDebugConsole } from "./ChatDebugConsole";
import type { ChatMessageAreaProps } from "./ChatMessageArea";
import { DEFAULT_AGENTIC_CHAT_UI_FEATURES, type ResolvedAgenticChatUiFeatures } from "../features";
import "../styles.css";

export interface ChatLayoutProps extends Pick<
  ChatMessageAreaProps,
  "renderMessage" | "renderInlineGroup" | "renderInvocation"
> {
  /** Resolved browser-owned capabilities to mount in the stock layout. */
  uiFeatures?: ResolvedAgenticChatUiFeatures;
}

/**
 * Default full chat layout — drop-in replacement for the old ChatPhase.
 * Composes all sub-components reading from ChatContext.
 *
 * NOTE: Theme is applied in AgenticChat (above ChatProvider) so that
 * ChatLayout does NOT read from context. This prevents keystroke-driven
 * context updates (from ChatInput → setInput) from re-rendering
 * ChatLayout and triggering unnecessary Radix theme context propagation,
 * which can cause layout shifts that break autoscroll.
 *
 * For custom layouts, use the individual components directly:
 * ```tsx
 * <ChatProvider value={chatState}>
 *   <MyCustomHeader />
 *   <ChatMessageArea />
 *   <ChatInput />
 * </ChatProvider>
 * ```
 */
export const ChatLayout = React.memo(function ChatLayout({
  renderMessage,
  renderInlineGroup,
  renderInvocation,
  uiFeatures = DEFAULT_AGENTIC_CHAT_UI_FEATURES,
}: ChatLayoutProps) {
  return (
    <>
      <Flex
        className="agentic-chat-root"
        data-part="chat-root"
        direction="column"
        style={{
          height: "100%",
          minWidth: 0,
          width: "100%",
          boxSizing: "border-box",
          overflow: "hidden",
          gap: "var(--agentic-root-gap)",
          padding:
            "max(var(--agentic-root-padding), env(safe-area-inset-top, 0)) max(var(--agentic-root-padding), env(safe-area-inset-right, 0)) max(var(--agentic-root-padding), env(safe-area-inset-bottom, 0)) max(var(--agentic-root-padding), env(safe-area-inset-left, 0))",
        }}
      >
        <ChatHeader />
        <ChatConnectionErrorBanner />
        <ChatDirtyRepoWarnings />
        {uiFeatures.actionBar ? <LazyChatActionBar /> : null}
        <ChatMessageArea
          renderMessage={renderMessage}
          renderInlineGroup={renderInlineGroup}
          renderInvocation={renderInvocation}
          uiFeatures={uiFeatures}
        />
        {uiFeatures.feedback ? <LazyChatFeedbackArea /> : null}
        <PendingDeliveryQueue />
        <Outbox />
        <ChatInput />
      </Flex>
      <ChatDebugConsole />
    </>
  );
});
