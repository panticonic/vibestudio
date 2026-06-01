import React from "react";
import { Box, Text } from "ink";
import type { StyledRun } from "../host/VtSession.js";

export interface ViewportProps {
  /** Composited styled grid rows from the focused session's VT emulator. */
  rows: StyledRun[][];
  placeholder?: string;
}

/**
 * Renders the focused session's VT-emulated grid inside the host's single Ink
 * frame, preserving the worker's colors/attributes. This is the proven
 * "Option B": only the host Ink touches the real TTY, so chrome + worker output
 * never corrupt each other.
 */
export function Viewport({ rows, placeholder }: ViewportProps): React.ReactElement {
  const hasContent = rows.some((r) => r.length > 0);
  if (!hasContent) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>{placeholder ?? "No active session. Ctrl+N to start one."}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {rows.map((runs, y) => (
        <Text key={y}>
          {runs.length === 0
            ? " "
            : runs.map((run, i) => (
                <Text
                  key={i}
                  color={run.fg}
                  backgroundColor={run.bg}
                  bold={run.bold}
                  dimColor={run.dim}
                  italic={run.italic}
                  underline={run.underline}
                  inverse={run.inverse}
                  strikethrough={run.strikethrough}
                >
                  {run.text}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  );
}
