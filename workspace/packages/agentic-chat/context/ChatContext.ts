import { createContext, useContext } from "react";
import type { ChatContextValue } from "../types";

export const ChatContext = createContext<ChatContextValue | null>(null);

/**
 * Access the chat context. Must be used within a `<ChatProvider>`.
 * Throws if used outside of a ChatProvider.
 */
export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be used within a <ChatProvider>");
  }
  return ctx;
}

/**
 * Access the chat context without requiring a provider. Returns `null` when
 * rendered outside a `<ChatProvider>`.
 *
 * Item-render-depth components (MessageCard, ForkRow, SubagentRunCard) are
 * exported via MessageList and rendered provider-less in tests and standalone
 * transcript views. They use this so fork/edit affordances degrade gracefully
 * (hidden) instead of throwing when no chat context is present.
 */
export function useOptionalChatContext(): ChatContextValue | null {
  return useContext(ChatContext);
}
