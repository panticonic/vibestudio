import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "./index.js";

// Lightweight UUID-shaped id generator for tests. The gad-store doesn't
// require strict UUIDv7; any UUID-looking string is accepted.
let __idCounter = 0;
function id(label = ""): string {
  __idCounter += 1;
  const tag = __idCounter.toString(16).padStart(12, "0");
  const seed = label.padEnd(4, "x").slice(0, 4);
  // Build a UUID-shaped string. Real UUIDv7 has version bits, but the
  // store only checks shape.
  const a = "00000000";
  const b = seed.replace(/[^0-9a-f]/gi, "0").padEnd(4, "0");
  const c = "0000";
  const d = "0000";
  return `${a}-${b}-${c}-${d}-${tag}`;
}

describe("GadWorkspaceDO envelope persistence", () => {
  it("appends envelope items and stores typed payloads", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    const head = await call<any>("ensureGadBranch", {
      branchId: "branch-1",
      channelId: "channel-1",
      contextId: "context-1",
    });
    expect(head.headEntryId).toBeNull();

    const msgId = id("msg0");
    const result = await call<{
      headTrajectoryHash: string;
      headStateHash: string;
      headEntryId: string | null;
      items: Array<{ hash: string; entryId: string; parentEntryId: string | null }>;
    }>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        {
          entryId: msgId,
          parentEntryId: null,
          entryType: "message",
          actor: "user",
          payload: {
            message: {
              role: "user",
              content: [{ type: "text", text: "make the change" }],
              timestamp: 1,
            },
          },
        },
      ],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.entryId).toBe(msgId);
    expect(result.headTrajectoryHash).toMatch(/^trajectory:/);
    expect(result.headStateHash).toBe(head.headStateHash);
    expect(result.headEntryId).toBe(msgId);

    const materialized = await call<{ messages: Array<{ role: string; content: unknown }> }>(
      "materializePiMessages",
      { branchId: "branch-1" },
    );
    expect(materialized.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "make the change" }], timestamp: 1 },
    ]);

    const status = await call<Array<{ metric: string; value: number }>>("getStatus");
    expect(status.find((row) => row.metric === "Branches")?.value).toBe(1);
    expect(status.find((row) => row.metric === "Trajectory items")?.value).toBe(1);
  });

  it("rejects items with invalid envelope shape", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-bad" });

    // Missing entryId
    await expect(call("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [{ entryType: "system_event", parentEntryId: null, payload: {} }],
    })).rejects.toThrow(/invalid entryId/);

    // Unknown entryType
    await expect(call("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [{ entryId: id("a"), entryType: "not_a_type", parentEntryId: null, payload: {} }],
    })).rejects.toThrow(/unknown entryType/);

    // Non-object payload
    await expect(call("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [{ entryId: id("b"), entryType: "system_event", parentEntryId: null, payload: "oops" }],
    })).rejects.toThrow(/must be a JSON object/);

    // Dangling parentEntryId
    await expect(call("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [{ entryId: id("c"), entryType: "system_event", parentEntryId: id("missing"), payload: {} }],
    })).rejects.toThrow(/parentEntryId .* not found/);
  });

  it("supports parent references within the same batch", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-batch" });
    const messageId = id("m");
    const blockId = id("b");
    const result = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        {
          entryId: messageId,
          parentEntryId: null,
          entryType: "message",
          actor: "assistant",
          payload: {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hello" }],
              timestamp: 0,
            },
          },
        },
        {
          entryId: blockId,
          parentEntryId: messageId,
          entryType: "message_block",
          payload: { blockIndex: 0, blockKind: "text" },
        },
      ],
    });
    expect(result.items).toHaveLength(2);
    expect(result.items[1]!.parentEntryId).toBe(messageId);
  });

  it("materializes message envelopes verbatim", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-msg" });
    const userMsg = id("u");
    const assistantMsg = id("a");
    const toolCallId = "tool-1";
    const toolReqEntry = id("tr");
    const toolResultMsg = id("rm");
    await call("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        {
          entryId: userMsg,
          parentEntryId: null,
          entryType: "message",
          actor: "user",
          payload: {
            message: {
              role: "user",
              content: [{ type: "text", text: "please inspect" }],
              timestamp: 10,
            },
          },
        },
        {
          entryId: assistantMsg,
          parentEntryId: userMsg,
          entryType: "message",
          actor: "assistant",
          payload: {
            message: {
              role: "assistant",
              content: [
                { type: "toolCall", id: toolCallId, name: "read", input: { path: "README.md" } },
                { type: "text", text: "checking" },
              ],
              timestamp: 20,
              stopReason: "tool_calls",
            },
          },
        },
        {
          entryId: toolReqEntry,
          parentEntryId: assistantMsg,
          entryType: "tool_call_requested",
          payload: { toolName: "read", toolCallId },
        },
        {
          entryId: toolResultMsg,
          parentEntryId: assistantMsg,
          entryType: "message",
          actor: "tool",
          payload: {
            message: {
              role: "toolResult",
              toolCallId,
              toolName: "read",
              content: [{ type: "text", text: "README contents" }],
              isError: false,
              timestamp: 30,
            },
          },
        },
      ],
    });

    const materialized = await call<{ messages: Array<Record<string, unknown>> }>(
      "materializePiMessages",
      { branchId: "branch-msg" },
    );
    expect(materialized.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "please inspect" }],
        timestamp: 10,
      },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: toolCallId, name: "read", input: { path: "README.md" } },
          { type: "text", text: "checking" },
        ],
        timestamp: 20,
        stopReason: "tool_calls",
      },
      {
        role: "toolResult",
        toolCallId,
        toolName: "read",
        content: [{ type: "text", text: "README contents" }],
        isError: false,
        timestamp: 30,
      },
    ]);
  });

  it("flags tool results without a matching request", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-orphan-tool" });
    await call("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        {
          entryId: id("o1"),
          parentEntryId: null,
          entryType: "tool_result_observed",
          actor: "tool",
          payload: { toolCallId: "orphan-tool", toolName: "read", summary: "observed without request", isError: false },
        },
        {
          entryId: id("o2"),
          parentEntryId: null,
          entryType: "tool_call_requested",
          actor: "assistant",
          payload: { toolCallId: "dup-tool", toolName: "read", parameters: { path: "a.txt" } },
        },
        {
          entryId: id("o3"),
          parentEntryId: null,
          entryType: "tool_call_requested",
          actor: "assistant",
          payload: { toolCallId: "dup-tool", toolName: "read", parameters: { path: "b.txt" } },
        },
      ],
    });

    const calls = await call<Array<Record<string, unknown>>>("listGadBranchToolCalls", {
      branchId: "branch-orphan-tool",
    });
    expect(calls.find((row) => row["tool_call_id"] === "orphan-tool")).toMatchObject({
      status: "complete",
      result_summary: "observed without request",
    });

    await expect(call("materializePiMessages", { branchId: "branch-orphan-tool" }))
      .rejects.toThrow(/Malformed GAD transcript/);

    const integrity = await call<{ ok: boolean; errors: Array<{ code: string; toolCallId?: string }> }>(
      "checkGadIntegrity",
      { branchId: "branch-orphan-tool" },
    );
    expect(integrity.ok).toBe(false);
    expect(integrity.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "tool_result_without_request", toolCallId: "orphan-tool" }),
      expect.objectContaining({ code: "duplicate_tool_request", toolCallId: "dup-tool" }),
    ]));
  });

  it("enforces head/state CAS and forks by entryId", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-1" });
    const eventId = id("ev");
    const append = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [{ entryId: eventId, parentEntryId: null, entryType: "system_event", actor: "test", payload: { ok: true } }],
    });

    await expect(call("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [{ entryId: id("ev2"), parentEntryId: null, entryType: "system_event", actor: "test", payload: { stale: true } }],
    })).rejects.toThrow(/head conflict/);

    const beforeTrajectory = await call<{ rows: Array<unknown> }>("query", "SELECT * FROM gad_trajectory_items", []);
    const fork = await call<any>("forkGadBranch", {
      sourceBranchId: "branch-1",
      newBranchId: "branch-2",
      entryId: eventId,
    });
    expect(fork.branchId).toBe("branch-2");
    expect(fork.headTrajectoryHash).toBe(append.headTrajectoryHash);
    expect(fork.headEntryId).toBe(eventId);
    const afterTrajectory = await call<{ rows: Array<unknown> }>("query", "SELECT * FROM gad_trajectory_items", []);
    expect(afterTrajectory.rows).toHaveLength(beforeTrajectory.rows.length);

    const branches = await call<Array<{ id: string }>>("listGadBranches", {});
    expect(branches.map((branch) => branch.id)).toEqual(expect.arrayContaining([
      "branch-1",
      "branch-2",
    ]));
  });

  it("setBranchHead moves the head pointer to a known entry", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-head" });
    const ev1 = id("e1");
    const ev2 = id("e2");
    const append = await call<any>("appendGadTrajectoryBatch", {
      branchId: "branch-head",
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        { entryId: ev1, parentEntryId: null, entryType: "system_event", payload: { step: 1 } },
        { entryId: ev2, parentEntryId: ev1, entryType: "system_event", payload: { step: 2 } },
      ],
    });

    // Rewind to ev1
    const rewound = await call<any>("setBranchHead", {
      branchId: "branch-head",
      entryId: ev1,
      expectedHeadTrajectoryHash: append.headTrajectoryHash,
    });
    expect(rewound.headEntryId).toBe(ev1);
    expect(rewound.headTrajectoryHash).not.toBe(append.headTrajectoryHash);

    // CAS conflict if expected mismatches
    await expect(call("setBranchHead", {
      branchId: "branch-head",
      entryId: ev2,
      expectedHeadTrajectoryHash: append.headTrajectoryHash,
    })).rejects.toThrow(/head conflict/);

    // Detach to null
    const detached = await call<any>("setBranchHead", {
      branchId: "branch-head",
      entryId: null,
    });
    expect(detached.headEntryId).toBeNull();
    expect(detached.headTrajectoryHash).toBeNull();
  });

  it("setBranchHead rejects entries on a different branch", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const headA = await call<any>("ensureGadBranch", { branchId: "branch-a" });
    const evA = id("a1");
    await call("appendGadTrajectoryBatch", {
      branchId: "branch-a",
      expectedTrajectoryHash: headA.headTrajectoryHash,
      expectedStateHash: headA.headStateHash,
      items: [{ entryId: evA, parentEntryId: null, entryType: "system_event", payload: {} }],
    });

    const headB = await call<any>("ensureGadBranch", { branchId: "branch-b" });
    void headB;
    await expect(call("setBranchHead", { branchId: "branch-b", entryId: evA }))
      .rejects.toThrow(/not on branch/);
  });

  it("getEntryById returns an envelope row with parsed payload", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-getby" });
    const entry = id("g1");
    await call("appendGadTrajectoryBatch", {
      branchId: "branch-getby",
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [{ entryId: entry, parentEntryId: null, entryType: "system_event", actor: "tester", payload: { hello: "world" } }],
    });

    const row = await call<any>("getEntryById", { entryId: entry });
    expect(row).toMatchObject({
      entryId: entry,
      entryType: "system_event",
      actor: "tester",
      payload: { hello: "world" },
    });

    const missing = await call<any>("getEntryById", { entryId: id("none") });
    expect(missing).toBeNull();
  });

  it("getBranchPath returns the chain in root→head order", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-path" });
    const e1 = id("p1");
    const e2 = id("p2");
    const e3 = id("p3");
    await call("appendGadTrajectoryBatch", {
      branchId: "branch-path",
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        { entryId: e1, parentEntryId: null, entryType: "system_event", payload: { step: 1 } },
        { entryId: e2, parentEntryId: e1, entryType: "system_event", payload: { step: 2 } },
        { entryId: e3, parentEntryId: e2, entryType: "system_event", payload: { step: 3 } },
      ],
    });

    const full = await call<any[]>("getBranchPath", { branchId: "branch-path" });
    expect(full.map((row) => row.entryId)).toEqual([e1, e2, e3]);
    expect(full[0]).toMatchObject({ entryType: "system_event", payload: { step: 1 } });

    const partial = await call<any[]>("getBranchPath", { branchId: "branch-path", throughEntryId: e2 });
    expect(partial.map((row) => row.entryId)).toEqual([e1, e2]);
  });

  it("findBranchEntriesByType filters and slices the chain", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-find" });
    const m1 = id("f1");
    const m2 = id("f2");
    const sysE = id("fs");
    const m3 = id("f3");
    await call("appendGadTrajectoryBatch", {
      branchId: "branch-find",
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        { entryId: m1, parentEntryId: null, entryType: "message", payload: { message: { role: "user", content: [], timestamp: 1 } } },
        { entryId: m2, parentEntryId: m1, entryType: "message", payload: { message: { role: "assistant", content: [], timestamp: 2 } } },
        { entryId: sysE, parentEntryId: m2, entryType: "system_event", payload: { x: 1 } },
        { entryId: m3, parentEntryId: sysE, entryType: "message", payload: { message: { role: "assistant", content: [], timestamp: 3 } } },
      ],
    });

    const messages = await call<any[]>("findBranchEntriesByType", {
      branchId: "branch-find",
      entryType: "message",
    });
    expect(messages.map((row) => row.entryId)).toEqual([m1, m2, m3]);

    const second = await call<any[]>("findBranchEntriesByType", {
      branchId: "branch-find",
      entryType: "message",
      offset: 1,
      limit: 1,
    });
    expect(second.map((row) => row.entryId)).toEqual([m2]);

    const events = await call<any[]>("findBranchEntriesByType", {
      branchId: "branch-find",
      entryType: "system_event",
    });
    expect(events.map((row) => row.entryId)).toEqual([sysE]);
  });

  it("can list an unbounded branch trajectory", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-long" });
    await call("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: Array.from({ length: 205 }, (_, i) => ({
        entryId: id(`l${i}`),
        parentEntryId: null,
        entryType: "system_event" as const,
        actor: "test",
        payload: { i },
      })),
    });

    const rows = await call<Array<Record<string, unknown>>>("listGadBranchTrajectory", {
      branchId: "branch-long",
      limit: null,
    });
    expect(rows).toHaveLength(205);
  });

  it("forks by recursive ancestry without copying trajectory rows", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-a" });
    const baseMsg = id("base");
    const append = await call<any>("appendGadTrajectoryBatch", {
      branchId: "branch-a",
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        {
          entryId: baseMsg,
          parentEntryId: null,
          entryType: "message",
          actor: "user",
          payload: {
            message: { role: "user", content: [{ type: "text", text: "base" }], timestamp: 1 },
          },
        },
      ],
    });
    const beforeTrajectory = await call<{ rows: Array<unknown> }>("query", "SELECT * FROM gad_trajectory_items", []);

    await call("forkGadBranch", {
      sourceBranchId: "branch-a",
      newBranchId: "branch-b",
      entryId: baseMsg,
    });
    const afterForkTrajectory = await call<{ rows: Array<unknown> }>("query", "SELECT * FROM gad_trajectory_items", []);
    expect(afterForkTrajectory.rows).toHaveLength(beforeTrajectory.rows.length);

    const forked = await call<{ messages: Array<{ role: string; content: unknown }> }>(
      "materializePiMessages",
      { branchId: "branch-b" },
    );
    expect(forked.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "base" }], timestamp: 1 },
    ]);

    const forkHead = await call<any>("getGadBranchHead", { branchId: "branch-b" });
    await call("appendGadTrajectoryBatch", {
      branchId: "branch-b",
      expectedTrajectoryHash: forkHead.headTrajectoryHash,
      expectedStateHash: forkHead.headStateHash,
      items: [{ entryId: id("fonly"), parentEntryId: null, entryType: "system_event", actor: "test", payload: { forkOnly: true } }],
    });
    const forkTrajectory = await call<Array<{ entry_type: string; introduced_on_branch_id: string }>>(
      "listGadBranchTrajectory",
      { branchId: "branch-b", limit: 10 },
    );
    // Reverse to get ASC ordering
    expect(forkTrajectory.map((row) => row.entry_type).reverse()).toEqual([
      "message",
      "system_event",
    ]);
    expect(new Set(forkTrajectory.map((row) => row.introduced_on_branch_id))).toEqual(new Set(["branch-a", "branch-b"]));
    void append;
  });

  it("scopes state producers across forked branches", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "main-state" });
    const mainEntry = id("mst");
    const mainMutation = await call<any>("appendGadTrajectoryBatch", {
      branchId: "main-state",
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [{
        entryId: mainEntry,
        parentEntryId: null,
        entryType: "file_observed",
        actor: "main",
        payload: { path: "state.txt", contentHash: "blob:main", operation: "write", mode: 0o100644 },
      }],
    });
    const child = await call<any>("forkGadBranch", {
      sourceBranchId: "main-state",
      newBranchId: "child-state",
      entryId: mainEntry,
    });
    const mainProducer = await call<Record<string, unknown>>("getGadStateProducer", {
      stateHash: mainMutation.headStateHash,
      branchId: "main-state",
    });
    const childInheritedProducer = await call<Record<string, unknown>>("getGadStateProducer", {
      stateHash: mainMutation.headStateHash,
      branchId: "child-state",
    });
    expect(childInheritedProducer?.["trajectory_id"]).toBe(mainProducer?.["trajectory_id"]);

    // Child mutates using intent + observed (file_mutation_observed dispatches state).
    const intentId = id("ci");
    const observedId = id("co");
    const childMutation = await call<any>("appendGadTrajectoryBatch", {
      branchId: "child-state",
      expectedTrajectoryHash: child.headTrajectoryHash,
      expectedStateHash: child.headStateHash,
      items: [
        {
          entryId: intentId,
          parentEntryId: null,
          entryType: "file_mutation_intent",
          actor: "child",
          payload: {
            path: "state.txt",
            beforeHash: "blob:main",
            beforeSize: null,
            toolCallId: "tc-1",
            plannedTool: "write",
            plannedParams: {},
          },
        },
        {
          entryId: observedId,
          parentEntryId: intentId,
          entryType: "file_mutation_observed",
          actor: "child",
          payload: {
            path: "state.txt",
            afterHash: "blob:child",
            afterSize: null,
            outcome: "ok",
          },
        },
      ],
    });
    expect(await call("getGadStateProducer", {
      stateHash: childMutation.headStateHash,
      branchId: "main-state",
    })).toBeNull();
    expect(await call<Record<string, unknown>>("getGadStateProducer", {
      stateHash: childMutation.headStateHash,
      branchId: "child-state",
    })).toMatchObject({ actor: "child" });
  });

  it("does not expose session columns in gad tables", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const tables = await call<{ rows: Array<{ name: string }> }>(
      "query",
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'gad_%'",
      [],
    );
    expect(tables.rows.map((row) => row.name)).not.toContain("gad_sessions");
    for (const table of tables.rows.map((row) => row.name)) {
      const columns = await call<{ rows: Array<{ name: string }> }>("query", `PRAGMA table_info(${table})`, []);
      expect(columns.rows.map((row) => row.name)).not.toContain("session_id");
    }
  });

  it("does not expose legacy columns or compatibility tables", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const objects = await call<{ rows: Array<{ name: string }> }>(
      "query",
      "SELECT name FROM sqlite_master WHERE name IN ('gad_history_items', 'gad_branch_history_view', 'gad_branch_trajectory_view', 'gad_branch_trajectory_items', 'gad_tool_calls', 'gad_tool_calls_view', 'pi_messages_view', 'pi_message_blocks_view', 'gad_pi_messages', 'gad_pi_message_blocks', 'gad_file_activity', 'gad_file_activity_view', 'gad_file_blame_segments')",
      [],
    );
    expect(objects.rows).toEqual([]);

    const trajectoryColumns = await call<{ rows: Array<{ name: string }> }>(
      "query",
      "PRAGMA table_info(gad_trajectory_items)",
      [],
    );
    const colNames = trajectoryColumns.rows.map((row) => row.name);
    expect(colNames).not.toContain("kind");
    expect(colNames).not.toContain("message_id");
    expect(colNames).not.toContain("block_id");
    expect(colNames).not.toContain("input_state_hash");
    expect(colNames).not.toContain("output_state_hash");
    expect(colNames).toContain("entry_id");
    expect(colNames).toContain("parent_entry_id");
    expect(colNames).toContain("entry_type");
    expect(colNames).toContain("tool_call_id");
  });

  it("stores workspace state as a persistent tree manifest", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-tree" });
    const append = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        {
          entryId: id("t1"),
          parentEntryId: null,
          entryType: "file_observed",
          actor: "test",
          payload: { path: "src/index.ts", contentHash: "blob:index", operation: "write", mode: 0o100644 },
        },
        {
          entryId: id("t2"),
          parentEntryId: null,
          entryType: "file_observed",
          actor: "test",
          payload: { path: "src/lib/util.ts", contentHash: "blob:util", operation: "write", mode: 0o100644 },
        },
        {
          entryId: id("t3"),
          parentEntryId: null,
          entryType: "file_observed",
          actor: "test",
          payload: { path: "README.md", contentHash: "blob:readme", operation: "write", mode: 0o100644 },
        },
      ],
    });

    const files = await call<Array<{ path: string; content_hash: string }>>("listGadBranchFiles", {
      branchId: head.branchId,
    });
    expect(files.map((file) => file.path)).toEqual(["README.md", "src/index.ts", "src/lib/util.ts"]);

    const nested = await call<{ path: string; content_hash: string }>("readGadFileAtState", {
      stateHash: append.headStateHash,
      path: "src/lib/util.ts",
    });
    expect(nested).toMatchObject({ path: "src/lib/util.ts", content_hash: "blob:util" });

    const producer = await call<Record<string, unknown>>("getGadStateProducer", {
      stateHash: append.headStateHash,
      branchId: head.branchId,
    });
    expect(producer).toMatchObject({
      output_state_hash: append.headStateHash,
      entry_type: "file_observed",
    });

    const blame = await call<Array<Record<string, unknown>>>("blameGadFileSnippet", {
      stateHash: append.headStateHash,
      path: "src/lib/util.ts",
      startLine: 1,
      endLine: 1,
    });
    expect(blame[0]).toMatchObject({
      path: "src/lib/util.ts",
      entry_type: "file_observed",
    });

    const entries = await call<{ rows: Array<{ parent_hash: string; name: string; entry_kind: string; child_manifest_hash: string | null }> }>(
      "query",
      "SELECT parent_hash, name, entry_kind, child_manifest_hash FROM gad_manifest_entries ORDER BY parent_hash, name",
      [],
    );
    expect(entries.rows).toContainEqual(expect.objectContaining({
      name: "src",
      entry_kind: "dir",
      child_manifest_hash: expect.stringMatching(/^manifest:/),
    }));
    expect(entries.rows).toContainEqual(expect.objectContaining({
      name: "lib",
      entry_kind: "dir",
      child_manifest_hash: expect.stringMatching(/^manifest:/),
    }));
    expect(entries.rows).toContainEqual(expect.objectContaining({
      name: "util.ts",
      entry_kind: "file",
      child_manifest_hash: null,
    }));

    const validation = await call<{ ok: boolean; errors: string[] }>("validateGadHashes", {});
    expect(validation).toEqual({ ok: true, errors: [] });
  });

  it("does not assign output state or sidecars to no-op mutating actions", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-noop" });
    const e1 = id("n1");
    const initial = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [{
        entryId: e1,
        parentEntryId: null,
        entryType: "file_observed",
        actor: "test",
        payload: { path: "same.txt", contentHash: "blob:same", operation: "write", mode: 0o100644 },
      }],
    });
    const intentEntry = id("ni");
    const observedEntry = id("no");
    const noop = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: initial.headTrajectoryHash,
      expectedStateHash: initial.headStateHash,
      items: [
        {
          entryId: intentEntry,
          parentEntryId: null,
          entryType: "file_mutation_intent",
          actor: "test",
          payload: { path: "same.txt", beforeHash: "blob:same", beforeSize: null, toolCallId: "tc1", plannedTool: "write", plannedParams: {} },
        },
        {
          entryId: observedEntry,
          parentEntryId: intentEntry,
          entryType: "file_mutation_observed",
          actor: "test",
          payload: { path: "same.txt", afterHash: "blob:same", afterSize: null, outcome: "ok", mode: 0o100644 },
        },
      ],
    });

    expect(noop.headStateHash).toBe(initial.headStateHash);
    const rows = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      `SELECT ti.entry_type, st.id AS transition_id, h.id AS hunk_id
       FROM gad_trajectory_items ti
       LEFT JOIN gad_state_transitions st ON st.workspace_id = ti.workspace_id AND st.trajectory_id = ti.id
       LEFT JOIN gad_file_change_hunks h ON h.workspace_id = ti.workspace_id AND h.trajectory_id = ti.id
       WHERE ti.entry_id = ?`,
      [observedEntry],
    );
    expect(rows.rows[0]).toMatchObject({
      transition_id: null,
      hunk_id: null,
    });
  });

  it("file_mutation_observed produces state transition and uses intent for hunks", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-blame" });
    const initialEntry = id("bi");
    const initial = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [{
        entryId: initialEntry,
        parentEntryId: null,
        entryType: "file_observed",
        actor: "initial",
        payload: {
          path: "src/index.ts",
          contentHash: "blob:v1",
          operation: "write",
          mode: 0o100644,
          afterText: "alpha\nbeta\ngamma",
          newString: "alpha\nbeta\ngamma",
        },
      }],
    });
    const intentEntry = id("be-i");
    const observedEntry = id("be-o");
    const edited = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: initial.headTrajectoryHash,
      expectedStateHash: initial.headStateHash,
      items: [
        {
          entryId: intentEntry,
          parentEntryId: null,
          entryType: "file_mutation_intent",
          actor: "editor",
          payload: {
            path: "src/index.ts",
            beforeHash: "blob:v1",
            beforeSize: null,
            toolCallId: "tool-edit",
            plannedTool: "edit",
            plannedParams: {
              beforeText: "alpha\nbeta\ngamma",
              afterText: "alpha\nbeta\nGAMMA",
              oldString: "gamma",
              newString: "GAMMA",
            },
          },
        },
        {
          entryId: observedEntry,
          parentEntryId: intentEntry,
          entryType: "file_mutation_observed",
          actor: "editor",
          payload: {
            path: "src/index.ts",
            afterHash: "blob:v2",
            afterSize: null,
            outcome: "ok",
            operation: "write",
            mode: 0o100644,
          },
        },
      ],
    });

    const unchangedLine = await call<Array<Record<string, unknown>>>("blameGadFileSnippet", {
      stateHash: edited.headStateHash,
      path: "src/index.ts",
      startLine: 1,
      endLine: 1,
    });
    expect(unchangedLine[0]).toMatchObject({
      actor: "initial",
      entry_type: "file_observed",
    });

    const changedLine = await call<Array<Record<string, unknown>>>("blameGadFileSnippet", {
      stateHash: edited.headStateHash,
      path: "src/index.ts",
      startLine: 3,
      endLine: 3,
    });
    expect(changedLine[0]).toMatchObject({
      actor: "editor",
      entry_type: "file_mutation_observed",
    });
  });

  it("reports structured integrity errors for corrupted graph rows", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-corrupt" });
    const e1 = id("c1");
    const e2 = id("c2");
    const append = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        { entryId: e1, parentEntryId: null, entryType: "system_event", actor: "test", payload: { parent: true } },
        {
          entryId: e2,
          parentEntryId: e1,
          entryType: "file_observed",
          actor: "test",
          payload: { path: "corrupt.txt", contentHash: "blob:corrupt", operation: "write", mode: 0o100644 },
        },
      ],
    });

    await call("rawSql", "UPDATE gad_trajectory_items SET parent_hash = 'trajectory:wrong' WHERE id = ?", [append.items[1].id]);
    await call("rawSql", "UPDATE gad_branches SET head_trajectory_hash = 'trajectory:wrong-head' WHERE id = ?", ["branch-corrupt"]);
    await call("rawSql", "UPDATE gad_state_transitions SET output_state_hash = 'state:missing' WHERE trajectory_id = ?", [append.items[1].id]);
    await call("rawSql", "UPDATE gad_file_change_hunks SET after_file_version_id = 99999 WHERE trajectory_id = ?", [append.items[1].id]);

    const integrity = await call<{ ok: boolean; errors: Array<{ code: string }> }>("checkGadIntegrity", {
      branchId: "branch-corrupt",
    });
    expect(integrity.ok).toBe(false);
    expect(integrity.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "parent_hash_mismatch" }),
      expect.objectContaining({ code: "branch_head_hash_mismatch" }),
      expect.objectContaining({ code: "state_transition_missing_output_state" }),
      expect.objectContaining({ code: "file_hunk_missing_file_version" }),
    ]));
  });
});
