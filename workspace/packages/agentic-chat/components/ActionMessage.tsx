import React, { useCallback, useMemo, useState } from "react";
import { Badge, Box, Button, Flex, IconButton, Spinner, Text } from "@radix-ui/themes";
import { CheckIcon, CopyIcon, StopIcon } from "@radix-ui/react-icons";
import { prettifyToolName } from "@workspace/pubsub";
import type { InvocationCardPayload } from "@workspace/agentic-core";
import type { ChatSandboxValue } from "@workspace/agentic-core";
import { ExpandableChevron } from "./shared/Chevron";
import { CollapsibleSection } from "./shared/CollapsibleSection";
import { ToolArgumentsView, ToolDataView } from "./shared/ToolDataView";
import { formatArgsSummary, formatInvocationPreview } from "./action-format";

// ── Status helpers ─────────────────────────────────────────────────────────

const STATUS_DOT_COLOR = {
  pending: "var(--gray-8)",
  complete: "var(--green-9)",
  error: "var(--red-9)",
  cancelled: "var(--amber-9)",
  abandoned: "var(--amber-9)",
} as const;

type StatusKey = "pending" | "complete" | "error" | "cancelled" | "abandoned";

function getStatusKey(payload: InvocationCardPayload): StatusKey {
  const status = payload.execution.status;
  if (status === "pending") return "pending";
  if (status === "cancelled") return "cancelled";
  if (status === "abandoned") return "abandoned";
  return payload.execution.isError || status === "error" ? "error" : "complete";
}

function getStatusColor(sk: StatusKey): "red" | "amber" | "green" {
  return sk === "error" ? "red" : sk === "pending" || sk === "cancelled" || sk === "abandoned" ? "amber" : "green";
}

function StatusDot({ statusKey }: { statusKey: StatusKey }) {
  return (
    <Box
      style={{
        width: 6, height: 6, borderRadius: "50%",
        backgroundColor: STATUS_DOT_COLOR[statusKey], flexShrink: 0,
      }}
    />
  );
}

function formatDisplayName(toolName: string): string {
  return prettifyToolName(toolName)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

type ConsoleLine = {
  text: string;
  level: "log" | "info" | "debug" | "warn" | "error";
};

function parseConsoleLine(line: string): ConsoleLine {
  const match = /^\[(DEBUG|INFO|WARN|ERROR)\]\s?(.*)$/i.exec(line);
  if (match) {
    const level = match[1]!.toLowerCase();
    return {
      text: match[2] ?? "",
      level: isConsoleLevel(level) ? level : "log",
    };
  }
  return { text: line, level: "log" };
}

function isConsoleLevel(value: string): value is ConsoleLine["level"] {
  return value === "log" || value === "info" || value === "debug" || value === "warn" || value === "error";
}

function consoleLineTone(level: ConsoleLine["level"]): {
  color: "gray" | "blue" | "amber" | "red";
  background: string;
  border: string;
} {
  if (level === "error") {
    return { color: "red", background: "var(--red-a2)", border: "var(--red-a5)" };
  }
  if (level === "warn") {
    return { color: "amber", background: "var(--amber-a2)", border: "var(--amber-a5)" };
  }
  if (level === "info") {
    return { color: "blue", background: "var(--blue-a2)", border: "var(--blue-a5)" };
  }
  return { color: "gray", background: "transparent", border: "var(--gray-a4)" };
}

function ConsoleOutputView({ output }: { output: string }) {
  const lines = useMemo(
    () => output.split(/\r?\n/).map(parseConsoleLine),
    [output]
  );
  return (
    <Box
      style={{
        border: "1px solid var(--gray-a5)",
        borderRadius: "4px",
        background: "var(--gray-a2)",
        overflow: "hidden",
      }}
    >
      {lines.map((line, index) => {
        const tone = consoleLineTone(line.level);
        return (
          <Flex
            key={`${index}-${line.text}`}
            align="start"
            gap="2"
            style={{
              minHeight: 22,
              padding: "3px 8px",
              borderTop: index === 0 ? undefined : "1px solid var(--gray-a3)",
              borderLeft: `3px solid ${tone.border}`,
              background: tone.background,
            }}
          >
            <Text
              size="1"
              color={tone.color}
              style={{
                width: 42,
                flexShrink: 0,
                fontFamily: "var(--font-mono, monospace)",
                textTransform: "uppercase",
              }}
            >
              {line.level === "log" ? "" : line.level}
            </Text>
            <Text
              size="1"
              color={line.level === "log" || line.level === "debug" ? "gray" : tone.color}
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                fontFamily: "var(--font-mono, monospace)",
                lineHeight: 1.5,
              }}
            >
              {line.text || " "}
            </Text>
          </Flex>
        );
      })}
    </Box>
  );
}

// ── ActionPill (collapsed view) ────────────────────────────────────────────

export const ActionPill = React.memo(function ActionPill({
  id,
  payload,
  onExpand,
  onCancel,
}: {
  id: string;
  payload: InvocationCardPayload;
  onExpand: (id: string) => void;
  onCancel?: () => void;
}) {
  const statusKey = getStatusKey(payload);
  const isPending = statusKey === "pending";
  const color = getStatusColor(statusKey);

  const preview = useMemo(
    () => formatInvocationPreview(payload.arguments, payload.execution.description, 120),
    [payload.arguments, payload.execution.description],
  );
  const displayName = useMemo(() => formatDisplayName(payload.name), [payload.name]);
  const title = preview ? `${displayName}: ${preview}` : displayName;

  return (
    <Flex
      className="inline-action-pill"
      data-testid="invocation-pill"
      data-invocation-name={payload.name}
      data-invocation-status={statusKey}
      title={title}
      align="center"
      gap="1"
      onClick={() => onExpand(id)}
      tabIndex={0}
      aria-label={title}
      style={{
        cursor: "pointer",
        userSelect: "none",
        padding: "2px 6px",
        borderRadius: "4px",
        backgroundColor: `var(--${color}-a3)`,
        border: `1px solid var(--${color}-a5)`,
      }}
    >
      {isPending ? <Spinner size="1" /> : <StatusDot statusKey={statusKey} />}
      <Text className="inline-pill-label" size="1" color={color} weight="medium">
        {displayName}
      </Text>
      {preview && (
        <Text className="inline-pill-description" size="1" color="gray">
          {preview}
        </Text>
      )}
      {isPending && onCancel && (
        <IconButton
          size="1"
          color="gray"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
          aria-label="Cancel pending tool call"
          title="Stop"
          style={{ marginLeft: 4 }}
        >
          <StopIcon />
        </IconButton>
      )}
    </Flex>
  );
});

// ── ExpandedAction (expanded view) ─────────────────────────────────────────

export const ExpandedAction = React.memo(function ExpandedAction({
  payload,
  onCollapse,
  onCancel,
  chat,
}: {
  payload: InvocationCardPayload;
  onCollapse: () => void;
  onCancel?: () => void;
  chat?: Partial<Pick<ChatSandboxValue, "rpc">> | null;
}) {
  const statusKey = getStatusKey(payload);
  const isPending = statusKey === "pending";
  const isError = statusKey === "error";
  const color = getStatusColor(statusKey);
  const [copiedDetails, setCopiedDetails] = useState(false);

  const displayName = useMemo(() => formatDisplayName(payload.name), [payload.name]);

  const exec = payload.execution;
  const hasArgs = Object.keys(payload.arguments).length > 0;
  const detailsJson = useMemo(() => JSON.stringify(payload, null, 2), [payload]);
  const copyDetails = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    await navigator.clipboard.writeText(detailsJson);
    setCopiedDetails(true);
    window.setTimeout(() => setCopiedDetails(false), 1200);
  }, [detailsJson]);

  return (
    <Box
      style={{
        backgroundColor: `var(--${color}-a2)`,
        borderRadius: "6px",
        padding: "8px 10px",
        border: `1px solid var(--${color}-a4)`,
      }}
    >
      <Flex
        align="center"
        gap="2"
        onClick={onCollapse}
        tabIndex={0}
        style={{ cursor: "pointer", userSelect: "none" }}
      >
        <Text color={color} style={{ display: "flex", alignItems: "center" }}>
          <ExpandableChevron expanded={true} />
        </Text>
        <StatusDot statusKey={statusKey} />
        <Text size="1" color={color} weight="medium">
          {displayName}
        </Text>
        <Badge color={color} size="1" variant="soft">
          {exec.status}
        </Badge>
        <Button
          size="1"
          color="gray"
          variant="ghost"
          onClick={copyDetails}
          aria-label="Copy invocation details"
          title="Copy invocation details"
          style={{ marginLeft: "auto" }}
        >
          {copiedDetails ? <CheckIcon /> : <CopyIcon />}
          {copiedDetails ? "Copied" : "Copy details"}
        </Button>
        {isPending && onCancel && (
          <IconButton
            size="1"
            color="gray"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
            aria-label="Cancel pending tool call"
            title="Stop"
          >
            <StopIcon />
          </IconButton>
        )}
      </Flex>

      <Flex direction="column" gap="2" mt="2" ml="4">
        {exec.description && (
          <Text size="1" color="gray" style={{ fontStyle: "italic" }}>
            {exec.description}
          </Text>
        )}

        {exec.consoleOutput && (
          <CollapsibleSection label="Console" defaultOpen={true} color="blue">
            <ConsoleOutputView output={exec.consoleOutput} />
          </CollapsibleSection>
        )}

        {hasArgs && (
          <CollapsibleSection label="Arguments" defaultOpen={true}>
            <ToolArgumentsView args={payload.arguments} chat={chat} />
          </CollapsibleSection>
        )}

        {exec.result !== undefined && !isError && (
          <CollapsibleSection label="Result" defaultOpen={!isPending} color="green">
            <ToolDataView value={exec.result} label="Result" chat={chat} />
          </CollapsibleSection>
        )}

        {isError && exec.result !== undefined && (
          <CollapsibleSection label="Error" defaultOpen={true} color="red">
            <ToolDataView value={exec.result} label="Error" chat={chat} />
          </CollapsibleSection>
        )}

        {exec.resultImages && exec.resultImages.length > 0 && (
          <CollapsibleSection label="Images" defaultOpen={true} color="blue">
            <Flex gap="2" wrap="wrap">
              {exec.resultImages.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt=""
                  style={{
                    maxWidth: "240px", maxHeight: "240px",
                    borderRadius: "4px", border: "1px solid var(--gray-a4)",
                  }}
                />
              ))}
            </Flex>
          </CollapsibleSection>
        )}

        {exec.resultTruncated && (
          <Text size="1" color="amber">
            Result was marked truncated before it reached the chat renderer.
          </Text>
        )}
      </Flex>
    </Box>
  );
});
