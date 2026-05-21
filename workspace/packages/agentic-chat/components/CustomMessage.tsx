import React, { useMemo } from "react";
import { Badge, Box, Card, Flex, Spinner, Text } from "@radix-ui/themes";
import type { CustomMessageCardPayload } from "@workspace/agentic-core";
import { foldCustomMessageState } from "@workspace/agentic-core";
import type { MessageTypeComponentEntry } from "../types";

interface CustomRenderProps {
  payload: CustomMessageCardPayload;
  entry?: MessageTypeComponentEntry;
  chat: Record<string, unknown>;
  scope: Record<string, unknown>;
  scopes: Record<string, unknown>;
}

function useFoldedState(payload: CustomMessageCardPayload, entry?: MessageTypeComponentEntry): unknown {
  return useMemo(() => {
    if (entry?.status !== "ready") return payload.initialState;
    return foldCustomMessageState(payload.initialState, payload.updates, entry.module.reduce);
  }, [entry, payload.initialState, payload.lastSeq, payload.updates]);
}

export const CustomPill = React.memo(function CustomPill({
  id,
  payload,
  entry,
  chat,
  scope,
  scopes,
  onExpand,
}: CustomRenderProps & {
  id: string;
  onExpand: (id: string) => void;
}) {
  const state = useFoldedState(payload, entry);
  if (!entry || entry.status === "loading") {
    return (
      <Flex align="center" gap="1" style={pillStyle("gray")} title={payload.typeId}>
        <Spinner size="1" />
        <Text size="1" color="gray" weight="medium">{payload.typeId}</Text>
      </Flex>
    );
  }
  if (entry.status === "error") {
    return (
      <Flex align="center" gap="1" style={pillStyle("red")} title={entry.message}>
        <Text size="1" color="red" weight="medium">{payload.typeId}</Text>
      </Flex>
    );
  }
  const Pill = entry.module.Pill;
  return (
    <Flex align="center" gap="1" style={pillStyle("blue")} onClick={() => onExpand(id)} tabIndex={0}>
      {Pill
        ? <Pill typeId={payload.typeId} state={state} chat={chat} scope={scope} scopes={scopes} />
        : <Text size="1" color="blue" weight="medium">{payload.typeId}</Text>}
    </Flex>
  );
});

export const ExpandedCustom = React.memo(function ExpandedCustom({
  payload,
  entry,
  chat,
  scope,
  scopes,
  onCollapse,
}: CustomRenderProps & {
  onCollapse?: () => void;
}) {
  const state = useFoldedState(payload, entry);
  if (!entry || entry.status === "loading") {
    return <CustomPlaceholder typeId={payload.typeId} status="loading" />;
  }
  if (entry.status === "error") {
    return <CustomPlaceholder typeId={payload.typeId} status="error" message={entry.message} />;
  }
  const Component = entry.module.default;
  if (!Component) {
    return <CustomPlaceholder typeId={payload.typeId} status="error" message="Message type has no default export" />;
  }
  return (
    <Card className="message-card">
      {onCollapse && (
        <Flex
          align="center"
          justify="between"
          mb="2"
          onClick={onCollapse}
          tabIndex={0}
          style={{ cursor: "pointer", userSelect: "none" }}
        >
          <Text size="1" color="gray" weight="medium">{payload.typeId}</Text>
          <Text size="1" color="gray">Collapse</Text>
        </Flex>
      )}
      <Box>
        <Component state={state} chat={chat} scope={scope} scopes={scopes} />
      </Box>
    </Card>
  );
});

export function CustomMessageCard(props: CustomRenderProps) {
  return <ExpandedCustom {...props} />;
}

function CustomPlaceholder({
  typeId,
  status,
  message,
}: {
  typeId: string;
  status: "loading" | "error";
  message?: string;
}) {
  return (
    <Card className="message-card">
      <Flex direction="column" gap="2">
        <Flex align="center" gap="2">
          {status === "loading" ? <Spinner size="1" /> : <Badge color="red" size="1">Custom type</Badge>}
          <Text size="2" weight="medium">{typeId}</Text>
        </Flex>
        {message && <Text size="1" color="red">{message}</Text>}
      </Flex>
    </Card>
  );
}

function pillStyle(color: "blue" | "gray" | "red"): React.CSSProperties {
  return {
    cursor: color === "gray" ? "default" : "pointer",
    userSelect: "none",
    padding: "2px 6px",
    borderRadius: "4px",
    backgroundColor: `var(--${color}-a3)`,
    border: `1px solid var(--${color}-a5)`,
  };
}
