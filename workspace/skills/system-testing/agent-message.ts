import type { ChatMessage } from "@workspace/agentic-core";

/**
 * Message authorship is carried by the channel participant projection. Do not
 * infer the local participant from message order: recipient-specific delivery
 * may intentionally omit every self-authored event.
 */
export function isAgentAuthoredMessage(message: ChatMessage): boolean {
  return message.senderMetadata?.type === "agent";
}

export function isAgentCompletionMessage(message: ChatMessage): boolean {
  return (
    isAgentAuthoredMessage(message) &&
    message.kind === "message" &&
    message.complete === true &&
    message.contentType !== "thinking" &&
    message.contentType !== "typing" &&
    message.contentType !== "invocation" &&
    !message.pending
  );
}

export function findFinalAgentCompletionMessage(
  messages: readonly ChatMessage[]
): ChatMessage | undefined {
  return [...messages].reverse().find(isAgentCompletionMessage);
}
