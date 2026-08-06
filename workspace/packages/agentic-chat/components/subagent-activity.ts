import type {
  InvocationCardPayload,
  SubagentProgressEntry,
  ToolExecutionState,
} from "@workspace/agentic-core";

/**
 * Consolidate a subagent's relayed progress feed into the same shapes the
 * parent transcript already renders.
 *
 * The feed is a raw lifecycle log: a child tool call arrives as a
 * `tool-started` and, later, a separate terminal update. Rendered literally
 * that is what produced the old card's "Started read / Started read / Finished
 * tool / Tool failed" wall — two rows per call, and the terminal rows had lost
 * the tool name entirely (terminal invocation payloads carry no `name`).
 *
 * Here each call is folded back into ONE item carrying its name, arguments,
 * result and final status, expressed as an `InvocationCardPayload` so it can go
 * straight through `ActionPill` / `ExpandedAction` — the child's calls get the
 * identical pill, naming, and argument/result inspection as the parent's.
 */

export type SubagentActivityItem =
  | {
      kind: "tool";
      id: string;
      payload: InvocationCardPayload;
      startedAt: string;
      endedAt?: string;
    }
  | { kind: "say"; id: string; text: string; at: string; say: boolean }
  | { kind: "turn"; id: string; at: string; boundary: "started" | "finished" };

const TERMINAL_STATUS: Record<string, ToolExecutionState["status"]> = {
  "tool-completed": "complete",
  "tool-failed": "error",
  "tool-cancelled": "cancelled",
  "tool-abandoned": "abandoned",
};

function isTerminalKind(kind: SubagentProgressEntry["kind"]): boolean {
  return kind in TERMINAL_STATUS;
}

/**
 * Locate the open call a terminal update closes. `callId` is authoritative;
 * without one (updates relayed by an emitter predating correlation) fall back
 * to the most recent still-running call of the same tool, then to the most
 * recent still-running call at all. The fallback can mis-pair concurrent calls
 * to the same tool, which is strictly better than the previous behaviour of
 * never pairing anything.
 */
function findOpenCall(
  items: SubagentActivityItem[],
  entry: SubagentProgressEntry
): Extract<SubagentActivityItem, { kind: "tool" }> | null {
  const open: Array<Extract<SubagentActivityItem, { kind: "tool" }>> = [];
  for (const item of items) {
    if (item.kind === "tool" && item.payload.execution.status === "running") open.push(item);
  }
  if (entry.callId) {
    const byId = open.find((item) => item.payload.transportCallId === entry.callId);
    if (byId) return byId;
    // A correlated update with no open match belongs to a call whose start we
    // never saw (feed windowing) — don't let it close an unrelated call.
    return null;
  }
  if (entry.tool) {
    for (let i = open.length - 1; i >= 0; i -= 1) {
      const candidate = open[i]!;
      if (candidate.payload.name === entry.tool) return candidate;
    }
  }
  return open.length > 0 ? open[open.length - 1]! : null;
}

function startedItem(
  entry: SubagentProgressEntry,
  index: number
): Extract<SubagentActivityItem, { kind: "tool" }> {
  const id = entry.callId ?? `seq-${entry.messageSeq}-${index}`;
  return {
    kind: "tool",
    id,
    startedAt: entry.at,
    payload: {
      id,
      ...(entry.callId ? { transportCallId: entry.callId } : {}),
      name: entry.tool ?? "tool",
      arguments: entry.args ?? {},
      execution: {
        status: "running",
        description: "",
      },
    },
  };
}

/**
 * A terminal update for a call we never saw start — render it as a settled
 * call rather than dropping it, so a windowed feed still accounts for the work.
 */
function orphanTerminalItem(
  entry: SubagentProgressEntry,
  index: number
): Extract<SubagentActivityItem, { kind: "tool" }> {
  const id = entry.callId ?? `seq-${entry.messageSeq}-${index}`;
  const status = TERMINAL_STATUS[entry.kind] ?? "complete";
  return {
    kind: "tool",
    id,
    startedAt: entry.at,
    endedAt: entry.at,
    payload: {
      id,
      ...(entry.callId ? { transportCallId: entry.callId } : {}),
      name: entry.tool ?? "tool",
      arguments: {},
      execution: {
        status,
        description: entry.text ?? "",
        ...(entry.result !== undefined ? { result: entry.result } : {}),
        ...(status === "error" ? { isError: true } : {}),
      },
    },
  };
}

export function consolidateSubagentActivity(
  feed: readonly SubagentProgressEntry[]
): SubagentActivityItem[] {
  const items: SubagentActivityItem[] = [];

  feed.forEach((entry, index) => {
    if (entry.kind === "turn-started" || entry.kind === "turn-finished") {
      items.push({
        kind: "turn",
        id: `turn-${entry.messageSeq}-${index}`,
        at: entry.at,
        boundary: entry.kind === "turn-started" ? "started" : "finished",
      });
      return;
    }

    if (entry.kind === "said") {
      if (!entry.text) return;
      items.push({
        kind: "say",
        id: `say-${entry.messageSeq}-${index}`,
        text: entry.text,
        at: entry.at,
        say: entry.say === true,
      });
      return;
    }

    if (entry.kind === "tool-started") {
      items.push(startedItem(entry, index));
      return;
    }

    if (entry.kind === "tool-progress") {
      // Progress refines the call in place; it is never its own row.
      const open = findOpenCall(items, entry);
      if (open && entry.text) open.payload.execution.description = entry.text;
      return;
    }

    if (isTerminalKind(entry.kind)) {
      const open = findOpenCall(items, entry);
      const status = TERMINAL_STATUS[entry.kind]!;
      if (!open) {
        items.push(orphanTerminalItem(entry, index));
        return;
      }
      open.endedAt = entry.at;
      open.payload.execution.status = status;
      if (status === "error") open.payload.execution.isError = true;
      if (entry.result !== undefined) open.payload.execution.result = entry.result;
      // A terminal update names the tool only when the child's payload did;
      // otherwise the name already on the started item is the good one.
      if (entry.tool && open.payload.name === "tool") open.payload.name = entry.tool;
      if (entry.text) open.payload.execution.description = entry.text;
    }
  });

  return items;
}

/** Count of distinct child tool calls — a far more meaningful header stat than
 *  raw update count, which double-counted every call. */
export function countToolCalls(items: readonly SubagentActivityItem[]): number {
  return items.reduce((total, item) => (item.kind === "tool" ? total + 1 : total), 0);
}

/** The item a collapsed card should preview: the child's last words if it has
 *  spoken recently, else the most recent call. */
export function latestActivity(
  items: readonly SubagentActivityItem[]
): SubagentActivityItem | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === "say" || item.kind === "tool") return item;
  }
  return null;
}
