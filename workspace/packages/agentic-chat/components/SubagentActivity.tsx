import React, { useMemo } from "react";
import { Box, Flex, Text } from "@radix-ui/themes";
import { MessageContent } from "./MessageContent";
import { InlineGroup, type InlineItem } from "./InlineGroup";
import { formatDuration, formatRelativeTime } from "./shared/relativeTime";
import type { SubagentActivityItem } from "./subagent-activity";

/**
 * Renders a subagent's consolidated activity using the parent transcript's own
 * vocabulary: child tool calls become `InlineGroup` pills — identical naming,
 * identical expand-in-place inspection of arguments and results — and things
 * the child said become prose, not log rows.
 *
 * Runs of consecutive calls are packed into one `InlineGroup` so they wrap into
 * dense rows and expanding one splits its row exactly as it does in the main
 * chat, rather than each call claiming a full line of its own.
 */

type ActivityBlock =
  | { kind: "calls"; key: string; items: InlineItem[] }
  | { kind: "say"; key: string; text: string; at: string; say: boolean }
  | { kind: "turn"; key: string; at: string; boundary: "started" | "finished" };

function toBlocks(items: readonly SubagentActivityItem[]): ActivityBlock[] {
  const blocks: ActivityBlock[] = [];
  let run: InlineItem[] = [];
  const flush = () => {
    if (run.length === 0) return;
    blocks.push({ kind: "calls", key: `calls-${run[0]!.id}`, items: run });
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool") {
      run.push({
        type: "invocation",
        id: item.id,
        invocation: item.payload,
        complete: item.payload.execution.status !== "running",
        // Child calls are observed, never cancellable from the parent card, so
        // no sender needs to be addressable here.
        senderId: "",
      });
      continue;
    }
    flush();
    if (item.kind === "say") {
      blocks.push({ kind: "say", key: item.id, text: item.text, at: item.at, say: item.say });
    } else {
      blocks.push({ kind: "turn", key: item.id, at: item.at, boundary: item.boundary });
    }
  }
  flush();
  return blocks;
}

/**
 * Turn boundaries are structure, not events: a hairline separates turns instead
 * of spending a row on "Started working" / "Turn finished". Consecutive
 * boundaries (a close immediately followed by an open) collapse into one rule.
 */
function TurnRule() {
  return <Box className="subagent-turn-rule" role="separator" aria-label="New turn" />;
}

function SayBlock({ text, time, say }: { text: string; time: string | null; say: boolean }) {
  return (
    <Box className={`subagent-say${say ? " subagent-say-salient" : ""}`}>
      <Flex align="center" gap="2" className="subagent-say-meta">
        <Text size="1" className="subagent-say-label">
          {say ? "Reported" : "Said"}
        </Text>
        {time && (
          <Text size="1" className="subagent-time">
            {time}
          </Text>
        )}
      </Flex>
      <Box className="subagent-say-body">
        <MessageContent content={text} isStreaming={false} />
      </Box>
    </Box>
  );
}

export const SubagentActivity = React.memo(function SubagentActivity({
  items,
  now,
  chat,
}: {
  items: readonly SubagentActivityItem[];
  now: number;
  chat?: Record<string, unknown>;
}) {
  const blocks = useMemo(() => toBlocks(items), [items]);
  if (blocks.length === 0) return null;

  return (
    <Box className="subagent-activity" data-testid="subagent-activity">
      {blocks.map((block, index) => {
        if (block.kind === "calls") {
          return (
            <Box key={block.key} className="subagent-activity-calls">
              <InlineGroup items={block.items} chat={chat} />
            </Box>
          );
        }
        if (block.kind === "say") {
          return (
            <SayBlock
              key={block.key}
              text={block.text}
              time={formatRelativeTime(block.at, now)}
              say={block.say}
            />
          );
        }
        // Collapse a run of adjacent turn boundaries into a single rule, and
        // never open or close the list with one.
        const previous = blocks[index - 1];
        const next = blocks[index + 1];
        if (!previous || !next || previous.kind === "turn") return null;
        return <TurnRule key={block.key} />;
      })}
    </Box>
  );
});

export { formatDuration };
