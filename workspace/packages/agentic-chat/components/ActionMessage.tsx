import React, { useMemo } from "react";
import { Badge, Box, Flex, IconButton, Spinner, Text } from "@radix-ui/themes";
import { StopIcon } from "@radix-ui/react-icons";
import { prettifyToolName } from "@workspace/pubsub";
import type { InvocationCardPayload } from "@workspace/agentic-core";
import type { ChatSandboxValue } from "@workspace/agentic-core";
import { ExpandableChevron } from "./shared/Chevron";
import { CollapsibleSection } from "./shared/CollapsibleSection";
import { ToolArgumentsView, ToolDataView } from "./shared/ToolDataView";
import { formatArgsSummary } from "./action-format";

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

  const argsSummary = useMemo(
    () => formatArgsSummary(payload.arguments, 50),
    [payload.arguments],
  );
  const displayName = useMemo(() => prettifyToolName(payload.name), [payload.name]);

  return (
    <Flex
      className="inline-action-pill"
      data-testid="invocation-pill"
      data-invocation-name={payload.name}
      data-invocation-status={statusKey}
      title={payload.name}
      align="center"
      gap="1"
      onClick={() => onExpand(id)}
      tabIndex={0}
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
      {argsSummary && (
        <Text className="inline-pill-summary" size="1" color="gray" style={{
          opacity: 0.85,
        }}>
          ({argsSummary})
        </Text>
      )}
      {payload.execution.description && (
        <Text className="inline-pill-description" size="1" color="gray" style={{
          opacity: 0.85,
        }}>
          {payload.execution.description}
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

  const displayName = useMemo(() => prettifyToolName(payload.name), [payload.name]);

  const exec = payload.execution;
  const hasArgs = Object.keys(payload.arguments).length > 0;

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
            <ToolDataView value={exec.consoleOutput} label="Console output" chat={chat} />
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
