import React from "react";
import { Box, Text } from "ink";

export interface LogLine {
  level: "info" | "error";
  source: string;
  message: string;
}

export interface LogsViewProps {
  lines: LogLine[];
  maxLines?: number;
}

export function LogsView({ lines, maxLines = 16 }: LogsViewProps): React.ReactElement {
  const shown = lines.slice(-maxLines);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Logs</Text>
      {shown.length === 0 ? (
        <Text dimColor>No logs yet. Esc to dismiss.</Text>
      ) : (
        shown.map((l, i) => (
          <Text key={i} color={l.level === "error" ? "red" : undefined} dimColor={l.level !== "error"}>
            {`[${l.source}] ${l.message}`}
          </Text>
        ))
      )}
      <Text dimColor>Esc to dismiss</Text>
    </Box>
  );
}
