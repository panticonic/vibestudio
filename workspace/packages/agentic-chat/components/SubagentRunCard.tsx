import { useMemo, useState } from "react";
import { Badge, Box, Flex, IconButton, Popover, Text } from "@radix-ui/themes";
import { ChevronDownIcon, ExternalLinkIcon, InfoCircledIcon } from "@radix-ui/react-icons";
import type { ChatMessage, SubagentRunState } from "@workspace/agentic-core";
import { useOptionalChatMessageActions } from "../context/ChatContext";
import { MarkdownPreview } from "./MarkdownPreview";
import { MessageContent } from "./MessageContent";
import { SubagentActivity } from "./SubagentActivity";
import { SubagentTranscript } from "./SubagentTranscript";
import { toolPresentation } from "./ActionMessage";
import { CopyIconButton } from "./shared/CopyButton";
import { executionStatusLabel, executionStatusTone, isLiveStatus } from "./shared/invocationStatus";
import { formatDuration, formatRelativeTime, useNow } from "./shared/relativeTime";
import {
  consolidateSubagentActivity,
  countToolCalls,
  latestActivity,
  type SubagentActivityItem,
} from "./subagent-activity";

/**
 * SubagentRunCard — how a spawned child run appears in its parent's transcript.
 * Routed here from `MessageList.renderItem` for any invocation carrying an
 * `invocation.subagent` payload.
 *
 * The card has two sources of truth, in order of availability:
 *
 *  1. The relayed progress feed (`execution.progress`), folded by
 *     `consolidateSubagentActivity` into whole tool calls and child messages.
 *     Always present — it lives in the parent's own log, so it survives replay
 *     and works with no connection.
 *  2. The child's real transcript, observed live on its task channel and drawn
 *     by the same `MessageList` as the parent chat. Opt-in and lazily
 *     connected, because each observer costs a subscription.
 *
 * Both render through the main chat's components rather than card-local
 * lookalikes: a child's `Read` call is the same pill, with the same name and
 * the same argument/result inspection, as a `Read` in the parent conversation.
 */

const INTEGRATION_LABEL: Record<
  NonNullable<SubagentRunState["integration"]>,
  { label: string; color: "green" | "amber" | "gray" }
> = {
  merged: { label: "Merged", color: "green" },
  "needs-decision": { label: "Needs decision", color: "amber" },
  discarded: { label: "Discarded", color: "gray" },
};

type BodyView = "activity" | "transcript";

function compactId(value: string): string {
  if (value.length <= 36) return value;
  return `${value.slice(0, 18)}…${value.slice(-12)}`;
}

/** One-line description of the newest activity, for the collapsed card. */
function previewOf(item: SubagentActivityItem | null): { prefix?: string; content: string } | null {
  if (!item) return null;
  if (item.kind === "say") return { content: item.text };
  if (item.kind === "tool") {
    const presentation = toolPresentation(item.payload);
    return presentation.preview
      ? { prefix: `${presentation.displayName}:`, content: presentation.preview }
      : { content: presentation.displayName };
  }
  return null;
}

/** When the newest activity happened — the stamp the collapsed line shows. */
function activityAt(item: SubagentActivityItem | null): string | null {
  if (!item) return null;
  if (item.kind === "say") return item.at;
  if (item.kind === "tool") return item.endedAt ?? item.startedAt;
  return null;
}

function IdentifiersPopover({ rows }: { rows: Array<[string, string]> }) {
  return (
    <Popover.Root>
      <Popover.Trigger>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          title="Run identifiers"
          aria-label="Run identifiers"
        >
          <InfoCircledIcon />
        </IconButton>
      </Popover.Trigger>
      <Popover.Content size="1" className="subagent-ids-popover">
        <Text size="1" weight="medium" className="subagent-ids-heading">
          Run identifiers
        </Text>
        <Box className="subagent-detail-grid">
          {rows.map(([name, value]) => (
            <div className="subagent-detail-row" key={name}>
              <Text size="1" className="subagent-detail-name">
                {name}
              </Text>
              <Flex align="center" gap="1" className="subagent-detail-value-wrap">
                <Text size="1" className="subagent-detail-value" title={value}>
                  {compactId(value)}
                </Text>
                <CopyIconButton
                  value={value}
                  label={`Copy ${name.toLowerCase()} id`}
                  className="subagent-copy-button"
                />
              </Flex>
            </div>
          ))}
        </Box>
      </Popover.Content>
    </Popover.Root>
  );
}

export function SubagentRunCard({ msg }: { msg: ChatMessage }) {
  const actions = useOptionalChatMessageActions();
  const forkState = actions?.forkState;
  const childTranscript = actions?.childTranscript;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<BodyView>("activity");

  const invocation = msg.invocation;
  const progressFeed = useMemo(
    () => invocation?.execution.progress ?? [],
    [invocation?.execution.progress]
  );
  const activity = useMemo(() => consolidateSubagentActivity(progressFeed), [progressFeed]);
  const truncatedPreview = useMemo(() => {
    for (let index = activity.length - 1; index >= 0; index -= 1) {
      const item = activity[index]!;
      if (item.kind === "tool") {
        if (
          item.preview.argsTruncated ||
          item.preview.resultTruncated ||
          item.preview.textTruncated
        ) {
          return {
            channelId: item.preview.sourceChannelId,
            messageSeq: item.preview.sourceMessageSeq,
          };
        }
      } else if (item.kind === "say" && item.textTruncated) {
        return { channelId: item.sourceChannelId, messageSeq: item.sourceMessageSeq };
      }
    }
    return null;
  }, [activity]);

  const subagent = invocation?.subagent;
  const status = invocation?.execution.status ?? "pending";
  const isLive = isLiveStatus(status);
  const now = useNow(Boolean(invocation && subagent) && isLive);
  if (!invocation || !subagent) return null;

  const channelTitle = [...progressFeed]
    .reverse()
    .find((entry) => entry.kind === "title-changed" && entry.text?.trim())?.text;
  const label = channelTitle || subagent.label || invocation.name || "Subagent";
  const integration = subagent.integration ? INTEGRATION_LABEL[subagent.integration] : undefined;
  const canOpenPanel = Boolean(forkState && subagent.taskChannelId && subagent.contextId);
  const canObserve = Boolean(childTranscript && subagent.taskChannelId);

  const callCount = countToolCalls(activity);
  const latest = latestActivity(activity);
  const preview =
    previewOf(latest) ??
    (invocation.execution.description.trim()
      ? { content: invocation.execution.description.trim() }
      : {
          content: isLive ? "Waiting for the child agent to start" : "No child updates yet",
        });
  const latestAt = activityAt(latest);
  const latestTime = latestAt ? formatRelativeTime(latestAt, now) : null;

  // Wall time across the whole run, from the first relayed update to the last.
  const first = activity[0];
  const firstAt = first ? (first.kind === "tool" ? first.startedAt : first.at) : null;
  const elapsed = firstAt && latestAt ? formatDuration(firstAt, latestAt) : null;

  const detailRows = (
    [
      ["Run", subagent.runId],
      ["Task", subagent.taskChannelId],
      ["Context", subagent.contextId],
      ["Parent", subagent.parentContextId ?? undefined],
      ["Child", subagent.childEntityId],
    ] as Array<[string, string | undefined]>
  ).filter((row): row is [string, string] => typeof row[1] === "string" && row[1].length > 0);

  const handleOpenPanel = () => {
    if (subagent.taskChannelId && subagent.contextId) {
      forkState?.actions.openInNewPanel(subagent.taskChannelId, subagent.contextId);
    }
  };

  return (
    <Box className="message-row message-row-agent">
      <Box
        className={`message-card-subagent subagent-status-${status}${open ? " subagent-card-open" : ""}`}
        data-testid="subagent-run-card"
      >
        <div className="subagent-summary">
          <Flex align="center" gap="2" className="subagent-card-header">
            <button
              type="button"
              className="subagent-summary-toggle"
              aria-expanded={open}
              aria-label={open ? "Collapse run details" : "Expand run details"}
              onClick={() => setOpen((value) => !value)}
            >
              <span
                className={`subagent-status-dot subagent-status-dot-${status}`}
                aria-hidden="true"
              />
              <span
                className={`subagent-expand-chevron${open ? " subagent-expand-chevron-open" : ""}`}
                aria-hidden="true"
              >
                <ChevronDownIcon />
              </span>
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
              {integration && (
                <Badge
                  className="subagent-merge-badge"
                  size="1"
                  variant="soft"
                  color={integration.color}
                >
                  {integration.label}
                </Badge>
              )}
            </button>
            <Flex align="center" gap="2" className="subagent-card-actions">
              {/* Calls, not raw update count: the old "76 updates" counted each
                  call at least twice and told the reader nothing. */}
              {callCount > 0 && (
                <Text size="1" className="subagent-stat">
                  {callCount} {callCount === 1 ? "call" : "calls"}
                  {elapsed ? ` · ${elapsed}` : ""}
                </Text>
              )}
              <Badge
                className="subagent-status-badge"
                size="1"
                variant="soft"
                color={executionStatusTone(status)}
              >
                {executionStatusLabel(status)}
              </Badge>
              {detailRows.length > 0 && <IdentifiersPopover rows={detailRows} />}
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                disabled={!canOpenPanel}
                onClick={handleOpenPanel}
                title="Open subagent chat in a new panel"
                aria-label="Open subagent chat in a new panel"
              >
                <ExternalLinkIcon />
              </IconButton>
            </Flex>
          </Flex>
          {!open && preview.content && (
            <button
              type="button"
              className="subagent-update-preview"
              aria-label="Expand run details from latest update"
              onClick={() => setOpen(true)}
            >
              <span className="subagent-activity-text">
                {preview.prefix && (
                  <span className="subagent-activity-prefix">{preview.prefix}</span>
                )}
                <MarkdownPreview content={preview.content} />
              </span>
              {latestTime && (
                <Text size="1" className="subagent-time" title={latestAt ?? undefined}>
                  {latestTime}
                </Text>
              )}
            </button>
          )}
        </div>

        {open && (
          <Box className="subagent-details">
            {invocation.execution.description && (
              <div className="subagent-description">
                <MessageContent content={invocation.execution.description} isStreaming={false} />
              </div>
            )}

            {view === "activity" && truncatedPreview && (
              <Flex className="subagent-preview-notice" align="center" justify="between" gap="2">
                <Text size="1" color="amber">
                  Compact preview only. Full source: {truncatedPreview.channelId ?? "child task"}#
                  {truncatedPreview.messageSeq}.
                </Text>
                {canObserve && (
                  <button
                    type="button"
                    className="subagent-preview-transcript-button"
                    onClick={() => setView("transcript")}
                  >
                    Open full transcript
                  </button>
                )}
              </Flex>
            )}

            {canObserve && (
              <Flex className="subagent-view-switch" gap="1" align="center" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "activity"}
                  className={`subagent-view-tab${view === "activity" ? " subagent-view-tab-active" : ""}`}
                  onClick={() => setView("activity")}
                >
                  Activity
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "transcript"}
                  className={`subagent-view-tab${view === "transcript" ? " subagent-view-tab-active" : ""}`}
                  onClick={() => setView("transcript")}
                >
                  Full transcript
                </button>
              </Flex>
            )}

            {view === "transcript" && canObserve && childTranscript && subagent.taskChannelId ? (
              <SubagentTranscript
                connection={childTranscript}
                channelId={subagent.taskChannelId}
                contextId={subagent.contextId ?? null}
              />
            ) : activity.length > 0 ? (
              <SubagentActivity items={activity} now={now} />
            ) : (
              <Text size="1" color="gray" className="subagent-empty-feed">
                {canObserve
                  ? "No relayed activity yet — open the full transcript to watch the child live."
                  : "The child has not published progress yet."}
              </Text>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
