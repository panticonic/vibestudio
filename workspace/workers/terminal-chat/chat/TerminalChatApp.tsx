import React from "react";
import { Box, Text, useInput } from "ink";
import type { ChatViewModel, ViewMessage } from "./ChatViewModel.js";

export interface TerminalChatAppProps {
  vm: ChatViewModel;
}

const ROLE_META: Record<ViewMessage["role"], { color?: string; label: (s: string) => string; dim?: boolean }> = {
  user: { color: "cyan", label: () => "you" },
  agent: { color: "green", label: (s) => s },
  thinking: { color: "magenta", label: () => "thinking", dim: true },
  tool: { color: "yellow", label: () => "tool" },
  approval: { color: "yellow", label: () => "approval" },
  system: { label: () => "·", dim: true },
};

function MessageLine({ m }: { m: ViewMessage }): React.ReactElement {
  const meta = ROLE_META[m.role];
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={meta.color} bold={!meta.dim} dimColor={meta.dim}>
          {`${meta.label(m.sender)}: `}
        </Text>
        <Text dimColor={meta.dim} color={m.error ? "red" : undefined}>
          {m.text || (m.streaming ? "…" : "")}
        </Text>
        {m.streaming ? <Text color="gray">▍</Text> : null}
      </Box>
      {m.error ? <Text color="red">{`  ⚠ ${m.error}`}</Text> : null}
    </Box>
  );
}

export function TerminalChatApp({ vm }: TerminalChatAppProps): React.ReactElement {
  const [, force] = React.useState(0);
  React.useEffect(() => vm.subscribe(() => force((n) => n + 1)), [vm]);

  const [draft, setDraft] = React.useState("");
  // null = stuck to the latest (auto-follow); a number freezes the view so the
  // visible screenful ends at that message index (scrolled-up history).
  const [endIndex, setEndIndex] = React.useState<number | null>(null);

  const messages = vm.view();
  const status = vm.status();
  const len = messages.length;
  const PAGE = 10;

  useInput((input, key) => {
    if (key.pageUp) {
      setEndIndex((cur) => Math.max(1, (cur ?? len) - PAGE));
      return;
    }
    if (key.pageDown) {
      setEndIndex((cur) => {
        const next = (cur ?? len) + PAGE;
        return next >= len ? null : next;
      });
      return;
    }
    if (key.return) {
      const line = draft;
      setDraft("");
      setEndIndex(null); // jump to latest on send
      void vm.submit(line);
      return;
    }
    if (key.backspace || key.delete) {
      setDraft((d) => d.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || key.escape) return; // host owns global chords
    if (input) setDraft((d) => d + input);
  });

  const scrolledUp = endIndex !== null;
  const effectiveEnd = endIndex ?? len;
  // Bounded window ending at effectiveEnd; Ink clips to the terminal height and
  // shows its tail (the screenful ending at effectiveEnd), so paging endIndex
  // scrolls history without re-rendering the whole transcript.
  const recent = messages.slice(Math.max(0, effectiveEnd - 300), effectiveEnd);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Vibestudio Chat</Text>
        <Text dimColor>{`  (agent: ${status})`}</Text>
        {scrolledUp ? (
          <Text color="yellow">{`   ↑ history (${effectiveEnd}/${len}) · PgDn to latest`}</Text>
        ) : null}
      </Box>
      <Text dimColor>{"─".repeat(48)}</Text>
      <Box flexDirection="column">
        {recent.length === 0 ? (
          <Text dimColor>
            {status === "connecting" ? "Connecting to agent…" : "Say hello, or type /help."}
          </Text>
        ) : (
          recent.map((m) => <MessageLine key={m.id} m={m} />)
        )}
      </Box>
      <Text dimColor>{"─".repeat(48)}</Text>
      <Box>
        <Text>{"> "}</Text>
        <Text>{draft}</Text>
        <Text inverse> </Text>
      </Box>
    </Box>
  );
}
