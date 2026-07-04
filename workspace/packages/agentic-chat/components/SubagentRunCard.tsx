import { useMemo, useState, type MouseEvent } from "react";
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

type ProgressTone = "blue" | "green" | "red" | "amber" | "gray";

interface ProgressItem {
  title: string;
  body: string;
  tone: ProgressTone;
}

function stripMarkdownLabel(value: string): string {
  return value.replace(/\*\*/g, "").trim();
}

function parseProgressLine(line: string): ProgressItem {
  const said = /^Said:\s*(?:(?:\*\*([^*]+)\*\*)\s*)?(.*)$/i.exec(line);
  if (said) {
    return {
      title: stripMarkdownLabel(said[1] || "Said"),
      body: stripMarkdownLabel(said[2] || ""),
      tone: "blue",
    };
  }
  if (/^Started working$/i.test(line)) {
    return { title: "Started working", body: "", tone: "blue" };
  }
  const started = /^Started\s+(.+)$/i.exec(line);
  if (started) {
    return { title: `Started ${stripMarkdownLabel(started[1] ?? "")}`, body: "", tone: "blue" };
  }
  if (/^Turn finished/i.test(line)) {
    return {
      title: "Turn finished",
      body: stripMarkdownLabel(line.replace(/^Turn finished[:\s]*/i, "")),
      tone: "green",
    };
  }
  if (/^Tool completed/i.test(line)) {
    return {
      title: "Tool completed",
      body: stripMarkdownLabel(line.replace(/^Tool completed[:\s]*/i, "")),
      tone: "green",
    };
  }
  if (/^Tool failed/i.test(line)) {
    return {
      title: "Tool failed",
      body: stripMarkdownLabel(line.replace(/^Tool failed[:\s]*/i, "")),
      tone: "red",
    };
  }
  if (/cancelled|abandoned/i.test(line)) {
    return { title: "Stopped", body: stripMarkdownLabel(line), tone: "amber" };
  }
  return { title: stripMarkdownLabel(line), body: "", tone: "gray" };
}

function progressPreview(item: ProgressItem): string {
  return item.body ? `${item.title}: ${item.body}` : item.title;
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
  const progressFeed = useMemo(() => sayFeed.map(parseProgressLine), [sayFeed]);
  const subagent = invocation?.subagent;
  if (!invocation || !subagent) return null;

  const status = invocation.execution.status;
  const label = subagent.label || invocation.name || "Subagent";
  const merge = subagent.merge ? MERGE_LABEL[subagent.merge] : undefined;
  const canOpen = Boolean(forkState && subagent.taskChannelId && subagent.contextId);
  const canReview = Boolean(forkState && subagent.contextId);
  // Live say / turn-report entries relayed onto the run, folded into
  // `consoleOutput` (newline-joined) by the chat projection.
  const latestProgress = progressFeed.length > 0 ? progressFeed[progressFeed.length - 1] : null;
  const latestUpdate = latestProgress
    ? progressPreview(latestProgress)
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
  const toggleDetails = () => setDetailsOpen((open) => !open);
  const stopActionClick = (event: MouseEvent) => event.stopPropagation();

  return (
    <Box className="message-row message-row-agent">
      <Card
        className="message-card message-card-subagent"
        data-testid="subagent-run-card"
        role="button"
        tabIndex={0}
        aria-expanded={detailsOpen}
        onClick={toggleDetails}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleDetails();
          }
        }}
      >
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
                onClick={(event) => {
                  event.stopPropagation();
                  toggleDetails();
                }}
              >
                <ExpandableChevron expanded={detailsOpen} />
              </Button>
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                disabled={!canOpen}
                onClick={(event) => {
                  event.stopPropagation();
                  handleOpen();
                }}
                title="Open subagent chat"
                aria-label="Open subagent chat"
              >
                <ExternalLinkIcon />
              </IconButton>
              <IconButton
                size="1"
                variant="ghost"
                disabled={!canReview}
                onClick={(event) => {
                  event.stopPropagation();
                  handleReview();
                }}
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
                  {sayFeed.length} updates
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
              {progressFeed.length > 0 && (
                <Box className="subagent-progress-feed" onClick={stopActionClick}>
                  <Flex direction="column" gap="1">
                    {progressFeed.map((item, i) => (
                      <Box
                        key={`${i}-${item.title}`}
                        className={`subagent-progress-item subagent-progress-${item.tone}`}
                      >
                        <Text size="1" weight="medium" className="subagent-progress-title">
                          {item.title}
                        </Text>
                        {item.body && (
                          <Text size="1" className="subagent-progress-body">
                            {item.body}
                          </Text>
                        )}
                      </Box>
                    ))}
                  </Flex>
                </Box>
              )}
              {progressFeed.length === 0 && (
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
