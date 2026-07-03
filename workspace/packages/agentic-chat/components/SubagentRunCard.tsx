import { Badge, Box, Button, Card, Flex, Text } from "@radix-ui/themes";
import { ExternalLinkIcon, MagnifyingGlassIcon } from "@radix-ui/react-icons";
import type { ChatMessage, SubagentRunState } from "@workspace/agentic-core";
import { useOptionalChatContext } from "../context/ChatContext";

/**
 * SubagentRunCard — a standalone, richer render for an invocation that spawned a
 * subagent (its `invocation.subagent` payload is populated). Unlike the inline
 * tool pill, it presents the run's label, status, and merge state, plus "Open"
 * (child chat panel on the task channel) and "Review & pick" (diff overlay
 * against the subagent's context). Routed here from `MessageList.renderItem`.
 *
 * The live `say` / turn-report feed is relayed onto the run as `invocation.output`
 * subagent events and folded by the chat projection into `execution.consoleOutput`
 * (channel-chat-merge). We render those entries inline here so the supervisor sees
 * the subagent narrate without leaving the transcript; "Open" still shows the full
 * child channel.
 */

const STATUS_COLOR: Record<string, "gray" | "green" | "red" | "amber" | "blue"> = {
  pending: "blue",
  complete: "green",
  error: "red",
  cancelled: "amber",
  abandoned: "gray",
};

const MERGE_LABEL: Record<NonNullable<SubagentRunState["merge"]>, { label: string; color: "green" | "amber" | "gray" }> = {
  merged: { label: "Merged", color: "green" },
  conflicted: { label: "Conflicted", color: "amber" },
  discarded: { label: "Discarded", color: "gray" },
};

export function SubagentRunCard({ msg }: { msg: ChatMessage }) {
  const forkState = useOptionalChatContext()?.forkState;
  const invocation = msg.invocation;
  const subagent = invocation?.subagent;
  if (!invocation || !subagent) return null;

  const status = invocation.execution.status;
  const label = subagent.label || invocation.name || "Subagent";
  const merge = subagent.merge ? MERGE_LABEL[subagent.merge] : undefined;
  const canOpen = Boolean(subagent.taskChannelId && subagent.contextId);
  const canReview = Boolean(subagent.contextId);
  // Live say / turn-report entries relayed onto the run, folded into
  // `consoleOutput` (newline-joined) by the chat projection.
  const sayFeed = (invocation.execution.consoleOutput ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const handleOpen = () => {
    if (subagent.taskChannelId && subagent.contextId) {
      forkState?.actions.openInNewPanel(subagent.taskChannelId, subagent.contextId);
    }
  };
  const handleReview = () => {
    if (subagent.contextId) {
      forkState?.actions.reviewContext({ kind: "subagent", contextId: subagent.contextId, label });
    }
  };

  return (
    <Box className="message-row message-row-agent">
      <Card className="message-card message-card-subagent">
        <Flex direction="column" gap="2" style={{ minWidth: 0 }}>
          <Flex align="center" justify="between" gap="2" wrap="wrap">
            <Flex align="center" gap="2" style={{ minWidth: 0 }}>
              <Text size="1" aria-hidden="true">
                ⑂
              </Text>
              <Text size="2" weight="medium" truncate>
                {label}
              </Text>
              {subagent.mode && (
                <Badge size="1" variant="soft" color="gray">
                  {subagent.mode}
                </Badge>
              )}
            </Flex>
            <Flex align="center" gap="2">
              <Badge size="1" variant="soft" color={STATUS_COLOR[status] ?? "gray"}>
                {status}
              </Badge>
              {merge && (
                <Badge size="1" variant="soft" color={merge.color}>
                  {merge.label}
                </Badge>
              )}
            </Flex>
          </Flex>
          <Text size="1" color="gray" style={{ whiteSpace: "pre-wrap", minWidth: 0 }}>
            {invocation.execution.description}
          </Text>
          {sayFeed.length > 0 && (
            <Box
              className="subagent-say-feed"
              style={{
                maxHeight: 160,
                overflowY: "auto",
                borderLeft: "2px solid var(--gray-a5)",
                paddingLeft: 8,
              }}
            >
              <Flex direction="column" gap="1">
                {sayFeed.map((line, i) => (
                  <Text
                    key={i}
                    size="1"
                    style={{ whiteSpace: "pre-wrap", minWidth: 0, wordBreak: "break-word" }}
                  >
                    {line}
                  </Text>
                ))}
              </Flex>
            </Box>
          )}
          <Flex align="center" gap="2" wrap="wrap">
            <Button size="1" variant="soft" color="gray" disabled={!canOpen} onClick={handleOpen}>
              <ExternalLinkIcon />
              Open
            </Button>
            <Button size="1" variant="soft" disabled={!canReview} onClick={handleReview}>
              <MagnifyingGlassIcon />
              Review &amp; pick
            </Button>
          </Flex>
        </Flex>
      </Card>
    </Box>
  );
}
