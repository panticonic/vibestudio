import React from "react";
import { Box, Text } from "ink";

export interface StatusBarProps {
  workspace: string;
  sessionTitle: string;
  status: string;
  pendingApprovals: number;
}

const STATUS_COLOR: Record<string, string> = {
  running: "green",
  starting: "yellow",
  errored: "red",
  closed: "gray",
  none: "gray",
};

export function StatusBar({
  workspace,
  sessionTitle,
  status,
  pendingApprovals,
}: StatusBarProps): React.ReactElement {
  return (
    <Box>
      <Text backgroundColor="blue" color="white">
        {` NatStack Terminal `}
      </Text>
      <Text>{`  ws: ${workspace}   session: ${sessionTitle}   `}</Text>
      <Text color={STATUS_COLOR[status] ?? "white"}>{`● ${status}`}</Text>
      {pendingApprovals > 0 ? <Text color="yellow">{`   approvals(${pendingApprovals})`}</Text> : null}
    </Box>
  );
}
