import React from "react";
import { Box, Text } from "ink";
import type { PendingApproval } from "@natstack/shared/approvals";

export interface ApprovalsOverlayProps {
  pending: PendingApproval[];
  selectedIndex: number;
}

function summarize(a: PendingApproval): { title: string; detail: string } {
  const caller = a.callerTitle ?? a.callerId;
  switch (a.kind) {
    case "unit-batch":
      return { title: `Trust unit change · ${caller}`, detail: `version ${a.effectiveVersion}` };
    case "capability":
      return { title: `${a.title} · ${caller}`, detail: a.capability };
    case "credential":
      return { title: `Credential · ${a.credentialLabel}`, detail: caller };
    case "userland":
      return { title: `${a.title} · ${caller}`, detail: a.summary ?? "" };
    default:
      return { title: `${a.kind} · ${caller}`, detail: a.effectiveVersion ?? "" };
  }
}

/**
 * Host-owned, un-spoofable approvals overlay over the global shell queue. While
 * it's open the focused session's input is suspended and its output buffered,
 * so a worker cannot paint a fake prompt over it.
 */
export function ApprovalsOverlay({
  pending,
  selectedIndex,
}: ApprovalsOverlayProps): React.ReactElement {
  const current = pending[selectedIndex];
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="yellow">
        {`Approvals (${pending.length})`}
      </Text>
      {pending.length === 0 ? (
        <Text dimColor>Nothing pending. Esc to dismiss.</Text>
      ) : (
        <>
          {pending.map((a, i) => {
            const { title } = summarize(a);
            return (
              <Text key={a.approvalId} inverse={i === selectedIndex}>
                {`${i + 1}. ${title}`}
              </Text>
            );
          })}
          {current ? (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>{summarize(current).detail}</Text>
              <Text>
                {"[1] once  [2] session  [3] version  [4] repo  [5] deny  · ↑/↓ select · Esc dismiss"}
              </Text>
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );
}
