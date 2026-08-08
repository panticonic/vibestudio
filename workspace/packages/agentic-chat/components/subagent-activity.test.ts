import { describe, expect, it } from "vitest";
import type { SubagentProgressEntry } from "@workspace/agentic-core";
import {
  consolidateSubagentActivity,
  countToolCalls,
  latestActivity,
} from "./subagent-activity";

const at = (seq: number) => new Date(1_700_000_000_000 + seq * 1000).toISOString();

function entry(partial: Partial<SubagentProgressEntry> & { kind: SubagentProgressEntry["kind"] }) {
  const seq = partial.messageSeq ?? 1;
  return { messageSeq: seq, at: at(seq), ...partial } as SubagentProgressEntry;
}

describe("consolidateSubagentActivity", () => {
  it("folds a started/completed pair into one call carrying name, args and result", () => {
    const items = consolidateSubagentActivity([
      entry({
        kind: "tool-started",
        tool: "Read",
        callId: "c1",
        args: { path: "index.ts" },
        messageSeq: 1,
      }),
      // Terminal payloads carry no tool name — the name must survive pairing.
      entry({
        kind: "tool-completed",
        callId: "c1",
        result: { bytes: 12 },
        resultTruncated: true,
        sourceChannelId: "task-child",
        messageSeq: 2,
      }),
    ]);

    expect(items).toHaveLength(1);
    const call = items[0]!;
    expect(call.kind).toBe("tool");
    if (call.kind !== "tool") throw new Error("expected a tool item");
    expect(call.payload.name).toBe("Read");
    expect(call.payload.arguments).toEqual({ path: "index.ts" });
    expect(call.payload.execution.status).toBe("complete");
    expect(call.payload.execution.result).toEqual({ bytes: 12 });
    expect(call.payload.execution.resultTruncated).toBe(true);
    expect(call.preview).toMatchObject({
      sourceChannelId: "task-child",
      sourceMessageSeq: 2,
      resultTruncated: true,
    });
    expect(call.endedAt).toBe(at(2));
  });

  it("repairs a persisted terminal that was relayed before its start", () => {
    const items = consolidateSubagentActivity([
      entry({
        kind: "tool-completed",
        callId: "c1",
        result: { bytes: 12 },
        messageSeq: 11,
      }),
      entry({
        kind: "tool-started",
        tool: "Read",
        callId: "c1",
        args: { path: "index.ts" },
        messageSeq: 8,
      }),
    ]);

    expect(items).toHaveLength(1);
    const call = items[0]!;
    if (call.kind !== "tool") throw new Error("expected a tool item");
    expect(call.payload.name).toBe("Read");
    expect(call.payload.arguments).toEqual({ path: "index.ts" });
    expect(call.payload.execution.status).toBe("complete");
    expect(call.payload.execution.result).toEqual({ bytes: 12 });
  });

  it("keeps concurrent calls distinct and pairs each with its own terminal", () => {
    const items = consolidateSubagentActivity([
      entry({ kind: "tool-started", tool: "Read", callId: "a", messageSeq: 1 }),
      entry({ kind: "tool-started", tool: "Bash", callId: "b", messageSeq: 2 }),
      entry({ kind: "tool-failed", callId: "b", text: "exit 1", messageSeq: 3 }),
      entry({ kind: "tool-completed", callId: "a", messageSeq: 4 }),
    ]);

    expect(countToolCalls(items)).toBe(2);
    const [read, bash] = items as Array<Extract<(typeof items)[number], { kind: "tool" }>>;
    expect(read!.payload.name).toBe("Read");
    expect(read!.payload.execution.status).toBe("complete");
    expect(bash!.payload.name).toBe("Bash");
    expect(bash!.payload.execution.status).toBe("error");
    expect(bash!.payload.execution.isError).toBe(true);
    expect(bash!.payload.execution.description).toBe("exit 1");
  });

  it("pairs by tool name when an emitter relays no correlation id", () => {
    const items = consolidateSubagentActivity([
      entry({ kind: "tool-started", tool: "Read", messageSeq: 1 }),
      entry({ kind: "tool-completed", messageSeq: 2 }),
    ]);

    expect(countToolCalls(items)).toBe(1);
    const call = items[0]!;
    if (call.kind !== "tool") throw new Error("expected a tool item");
    expect(call.payload.name).toBe("Read");
    expect(call.payload.execution.status).toBe("complete");
  });

  it("settles legacy calls in most-recent matching-tool order", () => {
    const items = consolidateSubagentActivity([
      entry({ kind: "tool-started", tool: "Read", messageSeq: 1 }),
      entry({ kind: "tool-started", tool: "Grep", messageSeq: 2 }),
      entry({ kind: "tool-started", tool: "Read", messageSeq: 3 }),
      entry({ kind: "tool-completed", tool: "Read", messageSeq: 4 }),
      entry({ kind: "tool-failed", tool: "Read", messageSeq: 5 }),
      entry({ kind: "tool-completed", tool: "Grep", messageSeq: 6 }),
    ]);

    const calls = items.filter(
      (item): item is Extract<(typeof items)[number], { kind: "tool" }> => item.kind === "tool"
    );
    expect(calls.map((call) => call.payload.execution.status)).toEqual([
      "error",
      "complete",
      "complete",
    ]);
  });

  it("folds large correlated feeds without rescanning prior activity", () => {
    const feed: SubagentProgressEntry[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      feed.push(
        entry({
          kind: "tool-started",
          tool: index % 2 === 0 ? "Read" : "Grep",
          callId: `call-${index}`,
          messageSeq: index * 2 + 1,
        }),
        entry({
          kind: "tool-completed",
          callId: `call-${index}`,
          messageSeq: index * 2 + 2,
        })
      );
    }

    const items = consolidateSubagentActivity(feed);

    expect(items).toHaveLength(10_000);
    expect(countToolCalls(items)).toBe(10_000);
    expect(
      items.every(
        (item) => item.kind === "tool" && item.payload.execution.status === "complete"
      )
    ).toBe(true);
  });

  it("renders a terminal whose start was never seen rather than dropping it", () => {
    const items = consolidateSubagentActivity([
      entry({ kind: "tool-completed", tool: "Grep", callId: "orphan", messageSeq: 9 }),
    ]);

    expect(countToolCalls(items)).toBe(1);
    const call = items[0]!;
    if (call.kind !== "tool") throw new Error("expected a tool item");
    expect(call.payload.name).toBe("Grep");
    expect(call.payload.execution.status).toBe("complete");
  });

  it("does not let a correlated terminal close an unrelated open call", () => {
    const items = consolidateSubagentActivity([
      entry({ kind: "tool-started", tool: "Read", callId: "a", messageSeq: 1 }),
      entry({ kind: "tool-completed", tool: "Grep", callId: "z", messageSeq: 2 }),
    ]);

    expect(countToolCalls(items)).toBe(2);
    const open = items[0]!;
    if (open.kind !== "tool") throw new Error("expected a tool item");
    expect(open.payload.execution.status).toBe("running");
  });

  it("refines an open call in place instead of emitting a progress row", () => {
    const items = consolidateSubagentActivity([
      entry({ kind: "tool-started", tool: "Bash", callId: "c1", messageSeq: 1 }),
      entry({ kind: "tool-progress", callId: "c1", text: "installing deps", messageSeq: 2 }),
    ]);

    expect(items).toHaveLength(1);
    const call = items[0]!;
    if (call.kind !== "tool") throw new Error("expected a tool item");
    expect(call.payload.execution.description).toBe("installing deps");
  });

  it("keeps child messages as prose and turn boundaries as structure", () => {
    const items = consolidateSubagentActivity([
      entry({ kind: "turn-started", messageSeq: 1 }),
      entry({ kind: "said", text: "Done with the store.", say: true, messageSeq: 2 }),
      entry({ kind: "turn-finished", messageSeq: 3 }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["turn", "say", "turn"]);
    const said = items[1]!;
    if (said.kind !== "say") throw new Error("expected a say item");
    expect(said.say).toBe(true);
    expect(latestActivity(items)).toBe(said);
    // Turn boundaries are not activity worth previewing.
    expect(countToolCalls(items)).toBe(0);
  });

  it("drops empty child messages", () => {
    expect(consolidateSubagentActivity([entry({ kind: "said", messageSeq: 1 })])).toEqual([]);
  });
});
