import { useMemo, useState } from "react";
import { Badge, Box, Button, Card, Flex, IconButton, Text } from "@radix-ui/themes";
import { ExternalLinkIcon, MagnifyingGlassIcon, UpdateIcon } from "@radix-ui/react-icons";
import type { ChatMessage, SubagentRunState } from "@workspace/agentic-core";
import { useOptionalChatContext } from "../context/ChatContext";
import { ExpandableChevron } from "./shared/Chevron";

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
  running: "blue",
  complete: "green",
  error: "red",
  cancelled: "amber",
  abandoned: "gray",
};

const MERGE_LABEL: Record<
  NonNullable<SubagentRunState["merge"]>,
  { label: string; color: "green" | "amber" | "gray" }
> = {
  merged: { label: "Merged", color: "green" },
  conflicted: { label: "Conflicted", color: "amber" },
  discarded: { label: "Discarded", color: "gray" },
};

function statusLabel(status: string): string {
  return status.slice(0, 1).toUpperCase() + status.slice(1);
}

function updateLines(output: string | undefined): string[] {
  return (output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function compactId(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 36) return value;
  return `${value.slice(0, 18)}...${value.slice(-12)}`;
}

export function SubagentRunCard({ msg }: { msg: ChatMessage }) {
  const forkState = useOptionalChatContext()?.forkState;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const invocation = msg.invocation;
  const sayFeed = useMemo(
    () => updateLines(invocation?.execution.consoleOutput),
    [invocation?.execution.consoleOutput]
  );
  const subagent = invocation?.subagent;
  if (!invocation || !subagent) return null;

  const status = invocation.execution.status;
  const label = subagent.label || invocation.name || "Subagent";
  const merge = subagent.merge ? MERGE_LABEL[subagent.merge] : undefined;
  const canOpen = Boolean(forkState && subagent.taskChannelId && subagent.contextId);
  const canReview = Boolean(forkState && subagent.contextId);
  // Live say / turn-report entries relayed onto the run, folded into
  // `consoleOutput` (newline-joined) by the chat projection.
  const latestUpdate =
    sayFeed.length > 0
      ? sayFeed[sayFeed.length - 1]
      : invocation.execution.description.trim() ||
        (status === "pending" ? "Waiting for the child agent to start" : "No child updates yet");
  const detailsLabel = detailsOpen ? "Hide details" : "Show details";
  const detailRows = [
    ["Run", subagent.runId],
    ["Task", subagent.taskChannelId],
    ["Context", subagent.contextId],
    ["Child", subagent.childEntityId],
  ].filter((row): row is [string, string] => typeof row[1] === "string" && row[1].length > 0);

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
      <Card className="message-card message-card-subagent" data-testid="subagent-run-card">
        <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
          <Flex align="center" gap="2" className="subagent-card-header">
            <span
              className={`subagent-status-dot subagent-status-dot-${status}`}
              aria-hidden="true"
            />
            <Flex align="center" gap="2" className="subagent-title-block">
              <Text className="subagent-title" size="2" weight="medium" truncate>
                {label}
              </Text>
              {subagent.mode && (
                <Badge className="subagent-mode-badge" size="1" variant="soft" color="gray">
                  {subagent.mode}
                </Badge>
              )}
              {merge && (
                <Badge className="subagent-merge-badge" size="1" variant="soft" color={merge.color}>
                  {merge.label}
                </Badge>
              )}
            </Flex>
            <Flex align="center" gap="1" className="subagent-card-actions">
              <Badge
                className="subagent-status-badge"
                size="1"
                variant="soft"
                color={STATUS_COLOR[status] ?? "gray"}
              >
                {statusLabel(status)}
              </Badge>
              <Button
                className="subagent-details-toggle"
                size="1"
                variant="ghost"
                color="gray"
                title={detailsLabel}
                aria-label={detailsLabel}
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((open) => !open)}
              >
                <ExpandableChevron expanded={detailsOpen} />
              </Button>
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                disabled={!canOpen}
                onClick={handleOpen}
                title="Open subagent chat"
                aria-label="Open subagent chat"
              >
                <ExternalLinkIcon />
              </IconButton>
              <IconButton
                size="1"
                variant="ghost"
                disabled={!canReview}
                onClick={handleReview}
                title="Review and pick changes"
                aria-label="Review and pick changes"
              >
                <MagnifyingGlassIcon />
              </IconButton>
            </Flex>
          </Flex>
          {latestUpdate && (
            <Flex align="center" gap="2" className="subagent-update-preview">
              <UpdateIcon aria-hidden="true" />
              <Text size="1" color="gray" truncate className="subagent-activity-text">
                {latestUpdate}
              </Text>
              {sayFeed.length > 1 && (
                <Badge size="1" variant="soft" color="gray">
                  {sayFeed.length}
                </Badge>
              )}
            </Flex>
          )}
          {detailsOpen && (
            <Box className="subagent-details">
              {detailRows.length > 0 && (
                <Box className="subagent-detail-grid">
                  {detailRows.map(([name, value]) => (
                    <div className="subagent-detail-row" key={name}>
                      <Text size="1" color="gray" className="subagent-detail-name">
                        {name}
                      </Text>
                      <Text size="1" className="subagent-detail-value" title={value}>
                        {compactId(value)}
                      </Text>
                    </div>
                  ))}
                </Box>
              )}
              {invocation.execution.description && (
                <Text size="1" color="gray" className="subagent-description">
                  {invocation.execution.description}
                </Text>
              )}
              {sayFeed.length > 0 && (
                <Box className="subagent-say-feed">
                  <Flex direction="column" gap="1">
                    {sayFeed.map((line, i) => (
                      <Text key={i} size="1" className="subagent-say-line">
                        {line}
                      </Text>
                    ))}
                  </Flex>
                </Box>
              )}
              {sayFeed.length === 0 && (
                <Text size="1" color="gray" className="subagent-empty-feed">
                  The child has not published progress yet. Open the task chat to inspect the live
                  transcript.
                </Text>
              )}
            </Box>
          )}
        </Flex>
      </Card>
    </Box>
  );
}
