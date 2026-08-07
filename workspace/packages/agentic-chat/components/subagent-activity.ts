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

type ToolActivityItem = Extract<SubagentActivityItem, { kind: "tool" }>;

/**
 * Index active calls while folding the feed. Correlated updates are direct map
 * lookups; legacy uncorrelated updates use append-only per-tool and global
 * stacks whose settled tails are discarded lazily. Every call enters and
 * leaves each stack at most once, so a complete fold is linear in feed size.
 */
function createOpenCallIndex() {
  const byId = new Map<string, ToolActivityItem>();
  const byTool = new Map<string, ToolActivityItem[]>();
  const all: ToolActivityItem[] = [];
  const runningTail = (stack: ToolActivityItem[] | undefined): ToolActivityItem | null => {
    while (stack?.length) {
      const candidate = stack[stack.length - 1]!;
      if (candidate.payload.execution.status === "running") return candidate;
      stack.pop();
    }
    return null;
  };

  return {
    add(item: ToolActivityItem): void {
      const callId = item.payload.transportCallId;
      if (callId) byId.set(callId, item);
      const toolCalls = byTool.get(item.payload.name);
      if (toolCalls) toolCalls.push(item);
      else byTool.set(item.payload.name, [item]);
      all.push(item);
    },
    find(entry: SubagentProgressEntry): ToolActivityItem | null {
      if (entry.callId) {
        // A correlated update with no open match belongs to a call whose start
        // was outside the feed window. Never let it close an unrelated call.
        return byId.get(entry.callId) ?? null;
      }
      if (entry.tool) {
        const matching = runningTail(byTool.get(entry.tool));
        if (matching) return matching;
      }
      return runningTail(all);
    },
    settle(item: ToolActivityItem): void {
      const callId = item.payload.transportCallId;
      if (callId) byId.delete(callId);
    },
  };
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
  const openCalls = createOpenCallIndex();

  feed.forEach((entry, index) => {
    if (entry.kind === "title-changed") return;

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
      const item = startedItem(entry, index);
      items.push(item);
      openCalls.add(item);
      return;
    }

    if (entry.kind === "tool-progress") {
      // Progress refines the call in place; it is never its own row.
      const open = openCalls.find(entry);
      if (open && entry.text) open.payload.execution.description = entry.text;
      return;
    }

    if (isTerminalKind(entry.kind)) {
      const open = openCalls.find(entry);
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
      openCalls.settle(open);
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
