import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Badge, Box, Flex, IconButton, Text } from "@radix-ui/themes";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  MagnifyingGlassIcon,
} from "@radix-ui/react-icons";
import type {
  ChatMessage,
  SubagentProgressEntry,
  SubagentRunState,
  ToolExecutionState,
} from "@workspace/agentic-core";
import { useOptionalChatContext } from "../context/ChatContext";

/**
 * SubagentRunCard — a standalone, richer render for an invocation that spawned a
 * subagent (its `invocation.subagent` payload is populated). Unlike the inline
 * tool pill, it presents the run's label, status, and merge state, plus "Open"
 * (child chat panel on the task channel) and "Review & pick" (diff overlay
 * against the subagent's context). Routed here from `MessageList.renderItem`.
 *
 * The child's activity arrives as structured `execution.progress` entries
 * (SubagentProgressEntry: kind + tool + text + timestamp), relayed from the
 * task channel via `invocation.progress` events and folded by the chat
 * projection — no string parsing happens here.
 *
 * Everything is collapsed by default: the card shows a one-line summary plus
 * the latest activity ticker. Expanding reveals the timestamped timeline (each
 * entry individually expandable) and a further-collapsed "Run identifiers"
 * disclosure with copy-to-clipboard.
 */

type CardStatus = ToolExecutionState["status"];

const STATUS_COLOR: Record<CardStatus, "gray" | "green" | "red" | "amber" | "blue"> = {
  pending: "gray",
  running: "blue",
  complete: "green",
  error: "red",
  cancelled: "amber",
  abandoned: "gray",
};

const STATUS_LABEL: Record<CardStatus, string> = {
  pending: "Pending",
  running: "Running",
  complete: "Complete",
  error: "Error",
  cancelled: "Cancelled",
  abandoned: "Abandoned",
};

const MERGE_LABEL: Record<
  NonNullable<SubagentRunState["merge"]>,
  { label: string; color: "green" | "amber" | "gray" }
> = {
  merged: { label: "Merged", color: "green" },
  conflicted: { label: "Conflicted", color: "amber" },
  discarded: { label: "Discarded", color: "gray" },
};

type ProgressTone = "blue" | "green" | "red" | "amber" | "gray";

const PROGRESS_PRESENTATION: Record<
  SubagentProgressEntry["kind"],
  { title: (entry: SubagentProgressEntry) => string; tone: ProgressTone }
> = {
  "turn-started": { title: () => "Started working", tone: "blue" },
  "turn-finished": { title: () => "Turn finished", tone: "green" },
  "tool-started": { title: (e) => `Started ${e.tool ?? "tool"}`, tone: "blue" },
  "tool-progress": { title: (e) => (e.tool ? `${e.tool} progress` : "Progress"), tone: "gray" },
  "tool-completed": { title: (e) => `Finished ${e.tool ?? "tool"}`, tone: "green" },
  "tool-failed": { title: (e) => `${e.tool ?? "Tool"} failed`, tone: "red" },
  "tool-cancelled": { title: (e) => `${e.tool ?? "Tool"} cancelled`, tone: "amber" },
  "tool-abandoned": { title: (e) => `${e.tool ?? "Tool"} abandoned`, tone: "amber" },
  said: { title: () => "Said", tone: "blue" },
};

function progressTitle(entry: SubagentProgressEntry): string {
  return PROGRESS_PRESENTATION[entry.kind].title(entry);
}

function progressPreview(entry: SubagentProgressEntry): string {
  return entry.text ? `${progressTitle(entry)}: ${entry.text}` : progressTitle(entry);
}

/** Compact relative time: "now", "42s", "5m", "3h", "2d". */
function formatRelativeTime(at: string, now: number): string | null {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Ticking clock so relative timestamps stay honest while the run is live. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

function compactId(value: string): string {
  if (value.length <= 36) return value;
  return `${value.slice(0, 18)}…${value.slice(-12)}`;
}

/** One identifier row with the full value on hover and one-click copy. */
function DetailRow({ name, value }: { name: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (event: MouseEvent) => {
    event.stopPropagation();
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="subagent-detail-row">
      <Text size="1" className="subagent-detail-name">
        {name}
      </Text>
      <Flex align="center" gap="1" className="subagent-detail-value-wrap">
        <Text size="1" className="subagent-detail-value" title={value}>
          {compactId(value)}
        </Text>
        <IconButton
          size="1"
          variant="ghost"
          color={copied ? "green" : "gray"}
          className="subagent-copy-button"
          onClick={copy}
          title={copied ? "Copied" : `Copy ${name.toLowerCase()} id`}
          aria-label={copied ? "Copied" : `Copy ${name.toLowerCase()} id`}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </IconButton>
      </Flex>
    </div>
  );
}

/** A single timeline entry; long bodies are clamped and expand on click.
 *  Expandable entries are native buttons — no nested interactive content. */
function TimelineItem({
  entry,
  isLast,
  live,
  now,
}: {
  entry: SubagentProgressEntry;
  isLast: boolean;
  live: boolean;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(entry.text);
  const tone = PROGRESS_PRESENTATION[entry.kind].tone;
  const time = formatRelativeTime(entry.at, now);
  const content = (
    <>
      <span
        className={`subagent-timeline-node${live && isLast ? " subagent-timeline-node-live" : ""}`}
        aria-hidden="true"
      />
      <div className="subagent-timeline-content">
        <Flex align="center" gap="1" className="subagent-timeline-title-row">
          <Text size="1" weight="medium" className="subagent-timeline-title">
            {progressTitle(entry)}
          </Text>
          {entry.say && (
            <Badge size="1" variant="soft" color="blue" className="subagent-say-badge">
              say
            </Badge>
          )}
          {expandable && <ChevronDownIcon className="subagent-timeline-chevron" aria-hidden="true" />}
          {time && (
            <Text size="1" className="subagent-timeline-time" title={entry.at}>
              {time}
            </Text>
          )}
        </Flex>
        {entry.text && (
          <Text
            size="1"
            className={`subagent-timeline-body${open ? "" : " subagent-timeline-body-clamped"}`}
          >
            {entry.text}
          </Text>
        )}
      </div>
    </>
  );
  const className = [
    "subagent-timeline-item",
    `subagent-tone-${tone}`,
    isLast ? "subagent-timeline-item-last" : "",
    open ? "subagent-timeline-item-open" : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (!expandable) {
    return <div className={className}>{content}</div>;
  }
  return (
    <button
      type="button"
      className={`${className} subagent-timeline-item-expandable`}
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
    >
      {content}
    </button>
  );
}

export function SubagentRunCard({ msg }: { msg: ChatMessage }) {
  const forkState = useOptionalChatContext()?.forkState;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [idsOpen, setIdsOpen] = useState(false);
  const invocation = msg.invocation;
  const progressFeed = useMemo(
    () => invocation?.execution.progress ?? [],
    [invocation?.execution.progress]
  );
  const subagent = invocation?.subagent;
  const status = invocation?.execution.status ?? "pending";
  const isLive = status === "pending" || status === "running";
  const now = useNow(Boolean(invocation && subagent) && isLive);
  if (!invocation || !subagent) return null;

  const label = subagent.label || invocation.name || "Subagent";
  const merge = subagent.merge ? MERGE_LABEL[subagent.merge] : undefined;
  const canOpen = Boolean(forkState && subagent.taskChannelId && subagent.contextId);
  const canReview = Boolean(forkState && subagent.contextId);
  const latestEntry = progressFeed.length > 0 ? progressFeed[progressFeed.length - 1] : null;
  const latestUpdate = latestEntry
    ? progressPreview(latestEntry)
    : invocation.execution.description.trim() ||
      (isLive ? "Waiting for the child agent to start" : "No child updates yet");
  const latestTime = latestEntry ? formatRelativeTime(latestEntry.at, now) : null;
  const detailsLabel = detailsOpen ? "Collapse run details" : "Expand run details";
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
      <Box
        className={`message-card-subagent subagent-status-${status}${detailsOpen ? " subagent-card-open" : ""}`}
        data-testid="subagent-run-card"
      >
        <div className="subagent-summary">
          <Flex align="center" gap="2" className="subagent-card-header">
            <button
              type="button"
              className="subagent-summary-toggle"
              aria-expanded={detailsOpen}
              aria-label={detailsLabel}
              onClick={() => setDetailsOpen((open) => !open)}
            >
              <span
                className={`subagent-status-dot subagent-status-dot-${status}`}
                aria-hidden="true"
              />
              <Text className="subagent-title" size="2" weight="medium" truncate>
                {label}
              </Text>
              {subagent.mode && (
                <Badge className="subagent-mode-badge" size="1" variant="surface" color="gray">
                  {subagent.mode}
                </Badge>
              )}
              {subagent.agentKind === "claude-code" && (
                <Badge
                  className="subagent-kind-badge"
                  size="1"
                  variant="soft"
                  color="amber"
                  title="Claude Code subagent"
                >
                  Claude Code
                </Badge>
              )}
              {merge && (
                <Badge className="subagent-merge-badge" size="1" variant="soft" color={merge.color}>
                  {merge.label}
                </Badge>
              )}
              <span
                className={`subagent-expand-chevron${detailsOpen ? " subagent-expand-chevron-open" : ""}`}
                aria-hidden="true"
              >
                <ChevronDownIcon />
              </span>
            </button>
            <Flex align="center" gap="2" className="subagent-card-actions">
              {progressFeed.length > 0 && (
                <Text size="1" className="subagent-update-count">
                  {progressFeed.length} {progressFeed.length === 1 ? "update" : "updates"}
                </Text>
              )}
              <Badge
                className="subagent-status-badge"
                size="1"
                variant="soft"
                color={STATUS_COLOR[status]}
              >
                {STATUS_LABEL[status]}
              </Badge>
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
          {!detailsOpen && latestUpdate && (
            <Flex align="center" gap="2" className="subagent-update-preview">
              <Text size="1" truncate className="subagent-activity-text">
                {latestUpdate}
              </Text>
              {latestTime && (
                <Text size="1" className="subagent-timeline-time" title={latestEntry?.at}>
                  {latestTime}
                </Text>
              )}
            </Flex>
          )}
        </div>
        {detailsOpen && (
          <Box className="subagent-details">
            {invocation.execution.description && (
              <Text size="1" className="subagent-description">
                {invocation.execution.description}
              </Text>
            )}
            {progressFeed.length > 0 ? (
              <div className="subagent-timeline">
                {progressFeed.map((entry, i) => (
                  <TimelineItem
                    key={`${entry.messageSeq}-${i}`}
                    entry={entry}
                    isLast={i === progressFeed.length - 1}
                    live={isLive}
                    now={now}
                  />
                ))}
              </div>
            ) : (
              <Text size="1" color="gray" className="subagent-empty-feed">
                The child has not published progress yet. Open the task chat to inspect the live
                transcript.
              </Text>
            )}
            {detailRows.length > 0 && (
              <div className="subagent-ids-section">
                <button
                  type="button"
                  className="subagent-ids-toggle"
                  aria-expanded={idsOpen}
                  onClick={() => setIdsOpen((open) => !open)}
                >
                  <ChevronDownIcon
                    className={`subagent-ids-chevron${idsOpen ? " subagent-ids-chevron-open" : ""}`}
                    aria-hidden="true"
                  />
                  Run identifiers
                </button>
                {idsOpen && (
                  <Box className="subagent-detail-grid">
                    {detailRows.map(([name, value]) => (
                      <DetailRow key={name} name={name} value={value} />
                    ))}
                  </Box>
                )}
              </div>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
