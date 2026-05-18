import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "./index.js";

let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

describe("GadWorkspaceDO clean Pi/GAD persistence", () => {
  it("stores Pi entries, blocks, and tool-call projections without legacy tables", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensurePiBranch", { branchId: "main", channelId: "ch-1" });
    expect(head.headEntryId).toBeNull();

    const user = id("user");
    const assistant = id("assistant");
    const result = await call<any>("appendPiEntryBatch", {
      branchId: "main",
      expectedHeadEntryHash: head.headEntryHash,
      expectedStateHash: head.headStateHash,
      items: [
        {
          entryId: user,
          parentEntryId: null,
          entryType: "message",
          payload: { message: { role: "user", content: "read it", timestamp: 1 } },
        },
        {
          entryId: assistant,
          parentEntryId: user,
          entryType: "message",
          payload: {
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "ok" },
                { type: "toolCall", id: "tc-1", name: "read", input: { path: "README.md" } },
              ],
              timestamp: 2,
            },
          },
        },
      ],
    });

    expect(result.headEntryId).toBe(assistant);
    expect(result.headEntryHash).toMatch(/^pi-entry-v1:/);

    const context = await call<{ messages: Array<Record<string, unknown>> }>("materializePiMessages", {
      branchId: "main",
    });
    expect(context.messages.map((msg) => msg["role"])).toEqual(["user", "assistant"]);

    const blocks = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT block_type, text, tool_call_id, tool_name FROM pi_message_blocks ORDER BY message_entry_id, block_index",
      [],
    );
    expect(blocks.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ block_type: "text", text: "read it" }),
      expect.objectContaining({ block_type: "toolCall", tool_call_id: "tc-1", tool_name: "read" }),
    ]));

    const tables = await call<{ rows: Array<{ name: string }> }>(
      "query",
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      [],
    );
    expect(tables.rows.map((row) => row.name)).not.toEqual(expect.arrayContaining([
      "gad_trajectory_items",
      "gad_branches",
      "gad_state_roots",
      "gad_payloads",
    ]));
  });

  it("keeps GAD sidecars out of Pi context and records a Merkle event chain", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("ensurePiBranch", { branchId: "main" });
    await call("appendPiEntryBatch", {
      branchId: "main",
      items: [{
        entryId: id("msg"),
        parentEntryId: null,
        entryType: "message",
        payload: { message: { role: "user", content: "hello", timestamp: 1 } },
      }],
    });

    await call("appendGadEvents", {
      events: [
        {
          eventId: id("event"),
          kind: "system_event",
          anchorKind: "system",
          anchorId: "test",
          payload: { kind: "audit", note: "not model visible" },
        },
        {
          eventId: id("event"),
          kind: "claim_recorded",
          anchorKind: "entry",
          anchorId: "msg",
          payload: { text: "hello was said", confidence: 0.9 },
        },
      ],
    });

    const context = await call<{ messages: Array<Record<string, unknown>> }>("materializePiMessages", {
      branchId: "main",
    });
    expect(context.messages).toHaveLength(1);

    const events = await call<Array<Record<string, unknown>>>("listGadEvents", {});
    expect(events).toHaveLength(2);
    expect(events[0]?.["event_hash"]).toMatch(/^gad-event-v1:/);
    expect(events[1]?.["prev_event_hash"]).toBe(events[0]?.["event_hash"]);

    const claims = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT text, status FROM gad_claims",
      [],
    );
    expect(claims.rows).toEqual([expect.objectContaining({ text: "hello was said", status: "active" })]);
  });

  it("records file mutations as events, states, transitions, diff, read, and blame data", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendGadEvents", {
      events: [
        {
          eventId: "plan-1",
          kind: "file_mutation_planned",
          anchorKind: "tool_call",
          anchorId: "tc-write",
          payload: {
            mutationId: "mut-1",
            toolCallId: "tc-write",
            path: "src/index.ts",
            operation: "write",
            plannedTool: "write",
            plannedParams: { path: "src/index.ts" },
          },
        },
        {
          eventId: "obs-1",
          kind: "file_mutation_observed",
          anchorKind: "tool_call",
          anchorId: "tc-write",
          payload: {
            mutationId: "mut-1",
            toolCallId: "tc-write",
            path: "src/index.ts",
            operation: "write",
            inputStateHash: "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7",
            afterHash: "blob:v1",
            outcome: "ok",
          },
        },
      ],
    });

    const mutation = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT output_state_hash FROM gad_file_mutations WHERE mutation_id = ?",
      ["mut-1"],
    );
    const outputStateHash = String(mutation.rows[0]?.["output_state_hash"]);
    expect(outputStateHash).toMatch(/^state:[0-9a-f]{64}$/);

    const producer = await call<Record<string, unknown>>("getGadStateProducer", {
      stateHash: outputStateHash,
    });
    expect(producer).toMatchObject({ event_id: "obs-1", produced_by_tool_call_id: "tc-write" });

    const file = await call<Record<string, unknown> | null>("readGadFileAtState", {
      stateHash: outputStateHash,
      path: "src/index.ts",
    });
    expect(file).toMatchObject({ path: "src/index.ts", content_hash: "blob:v1" });

    const diff = await call<{ added: Array<Record<string, unknown>>; removed: unknown[]; changed: unknown[] }>(
      "diffGadStates",
      {
        leftStateHash: "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7",
        rightStateHash: outputStateHash,
      },
    );
    expect(diff.added).toEqual([expect.objectContaining({ path: "src/index.ts" })]);

    const blame = await call<Array<Record<string, unknown>>>("blameGadFileSnippet", {
      stateHash: outputStateHash,
      path: "src/index.ts",
    });
    expect(blame[0]).toMatchObject({ mutation_id: "mut-1", tool_call_id: "tc-write" });

    await call("ensurePiBranch", { branchId: "main" });
    const appended = await call<any>("appendPiEntryBatch", {
      branchId: "main",
      expectedStateHash: "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7",
      items: [{
        entryId: "after-mutation",
        parentEntryId: null,
        entryType: "message",
        preStateHash: "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7",
        postStateHash: outputStateHash,
        payload: { message: { role: "assistant", content: "changed", timestamp: 3 } },
      }],
    });
    expect(appended.headStateHash).toBe(outputStateHash);

    const integrity = await call<{ ok: boolean; errors: Array<Record<string, unknown>> }>("checkGadIntegrity", {});
    expect(integrity).toEqual({ ok: true, errors: [] });

    const replay = await call<{ replayed: number }>("replayGadEvents", {});
    expect(replay.replayed).toBe(2);
    const replayIntegrity = await call<{ ok: boolean; errors: Array<Record<string, unknown>> }>("checkGadIntegrity", {});
    expect(replayIntegrity).toEqual({ ok: true, errors: [] });
  });

  it("forks Pi branches by entry or raw worktree state", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("ensurePiBranch", { branchId: "main" });
    const first = id("entry");
    await call("appendPiEntryBatch", {
      branchId: "main",
      items: [{
        entryId: first,
        parentEntryId: null,
        entryType: "message",
        payload: { message: { role: "user", content: "base", timestamp: 1 } },
      }],
    });

    const conversationFork = await call<any>("forkPiBranch", {
      sourceBranchId: "main",
      newBranchId: "fork-entry",
      entryId: first,
    });
    expect(conversationFork.headEntryId).toBe(first);

    const worldFork = await call<any>("forkPiBranch", {
      sourceBranchId: "main",
      newBranchId: "fork-state",
      stateHash: "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7",
    });
    expect(worldFork.headEntryId).toBeNull();
    expect(worldFork.headStateHash).toBe("state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7");
  });
});
