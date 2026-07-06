import { useState } from "react";
import { Badge, Button, Card, Flex, Text } from "@radix-ui/themes";
import type { ParticipantMetadata, PubSubClient } from "@workspace/pubsub";
import {
  useLinkedPermissionSignals,
  type LinkedPermissionPrompt,
} from "../hooks/useLinkedPermissionSignals";

interface ChatRpc {
  rpc: { call: (target: string, method: string, args: unknown[]) => Promise<unknown> };
}

export interface LinkedPermissionCardsProps<T extends ParticipantMetadata = ParticipantMetadata> {
  client: PubSubClient<T> | null;
  chat: ChatRpc;
}

/**
 * Inline permission cards for linked Claude Code sessions
 * (docs/claude-code-channels-plan.md §7.3). Each pending relayed tool-use prompt
 * renders as a card — "Claude Code wants to run <tool>" + description + monospace
 * preview + Allow/Deny — in the conversation flow. Resolving calls
 * `shellApproval.resolveExternalAgentByRequest`, and the card clears both
 * optimistically and on the vessel's companion `permission_settled` signal (fired
 * for any settle surface: workspace overlay, terminal, timeout, detach).
 */
export function LinkedPermissionCards<T extends ParticipantMetadata = ParticipantMetadata>({
  client,
  chat,
}: LinkedPermissionCardsProps<T>) {
  const { prompts, dismiss } = useLinkedPermissionSignals(client);
  if (prompts.length === 0) return null;
  return (
    <Flex direction="column" gap="2" px="2" pt="1">
      {prompts.map((prompt) => (
        <LinkedPermissionCard
          key={prompt.requestId}
          prompt={prompt}
          chat={chat}
          onSettled={() => dismiss(prompt.requestId)}
        />
      ))}
    </Flex>
  );
}

function LinkedPermissionCard({
  prompt,
  chat,
  onSettled,
}: {
  prompt: LinkedPermissionPrompt;
  chat: ChatRpc;
  onSettled: () => void;
}) {
  const [resolving, setResolving] = useState<"allow" | "deny" | null>(null);

  const resolve = async (behavior: "allow" | "deny") => {
    if (resolving) return;
    setResolving(behavior);
    // Optimistic clear — the vessel's `permission_settled` signal also clears
    // this card, but the local drop makes the user's own click feel immediate.
    onSettled();
    try {
      await chat.rpc.call("main", "shellApproval.resolveExternalAgentByRequest", [
        {
          channelId: prompt.channelId,
          requestId: prompt.requestId,
          resolveToken: prompt.resolveToken,
        },
        behavior,
      ]);
    } catch (err) {
      console.error("[LinkedPermissionCard] resolve failed:", err);
    }
  };

  return (
    <Card size="1" variant="surface">
      <Flex direction="column" gap="2">
        <Flex align="center" gap="2" wrap="wrap">
          <Badge color="amber" variant="soft" radius="full">
            Claude Code
          </Badge>
          <Text size="2" weight="medium">
            wants to run <code>{prompt.toolName}</code>
          </Text>
        </Flex>
        {prompt.description ? (
          <Text size="2" color="gray">
            {prompt.description}
          </Text>
        ) : null}
        {prompt.preview ? (
          <Text
            as="div"
            size="1"
            style={{
              fontFamily: "var(--code-font-family, monospace)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 200,
              overflowY: "auto",
              background: "var(--gray-a3)",
              borderRadius: "var(--radius-2)",
              padding: "6px 8px",
            }}
          >
            {prompt.preview}
          </Text>
        ) : null}
        <Flex gap="2" justify="end">
          <Button
            size="1"
            variant="soft"
            color="red"
            disabled={resolving !== null}
            onClick={() => void resolve("deny")}
          >
            Deny
          </Button>
          <Button
            size="1"
            variant="solid"
            color="green"
            disabled={resolving !== null}
            onClick={() => void resolve("allow")}
          >
            Allow
          </Button>
        </Flex>
      </Flex>
    </Card>
  );
}
