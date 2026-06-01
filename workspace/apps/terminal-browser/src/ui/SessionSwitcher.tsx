import React from "react";
import { Box, Text } from "ink";
import type { SessionRecord } from "../host/SessionManager.js";

export interface SessionSwitcherProps {
  sessions: SessionRecord[];
  selectedIndex: number;
}

export function SessionSwitcher({
  sessions,
  selectedIndex,
}: SessionSwitcherProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Sessions</Text>
      {sessions.length === 0 ? (
        <Text dimColor>No sessions. Press n to start one, Esc to close.</Text>
      ) : (
        sessions.map((s, i) => (
          <Text key={s.sessionId} inverse={i === selectedIndex}>
            {`${i + 1}. ${s.title}  [${s.status}]${s.focused ? "  (focused)" : ""}`}
          </Text>
        ))
      )}
      <Text dimColor>{"↑/↓ select · Enter focus · n new · x close · Esc dismiss"}</Text>
    </Box>
  );
}
