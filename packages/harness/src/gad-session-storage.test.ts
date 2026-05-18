import { describe, expect, it, vi } from "vitest";
import type { MessageEntry, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { Session } from "@earendil-works/pi-agent-core";

import {
  GadSessionStorage,
  TranscriptShapeError,
  rowToSessionEntry,
  sessionEntryToSpec,
  type GadRpcCaller,
} from "./gad-session-storage.js";
import type { AppendPiEntryBatchInput, PiBranchHead, PiEntryRow } from "./gad-types.js";

interface FakeState {
  head: PiBranchHead;
  rows: PiEntryRow[];
  appendCalls: AppendPiEntryBatchInput[];
  gadEvents: unknown[];
  conflictsRemaining: number;
}

function fakeGad(branchId = "branch:test"): { rpc: GadRpcCaller; state: FakeState } {
  const state: FakeState = {
    head: { branchId, headEntryId: null, headEntryHash: null, headStateHash: "state:empty" },
    rows: [],
    appendCalls: [],
    gadEvents: [],
    conflictsRemaining: 0,
  };
  const call = vi.fn(async (_target: string, method: string, ...args: unknown[]): Promise<unknown> => {
    switch (method) {
      case "workers.resolveService":
        return {
          kind: "durable-object",
          targetId: "do:workers/gad-store:GadWorkspaceDO:workspace-gad",
        };
      case "ensurePiBranch":
      case "getPiBranchHead":
        return state.head;
      case "appendPiEntryBatch": {
        const input = args[0] as AppendPiEntryBatchInput;
        state.appendCalls.push(input);
        if (state.conflictsRemaining > 0) {
          state.conflictsRemaining--;
          throw new Error("pi head conflict");
        }
        for (const spec of input.items) {
          const entryHash = `pi-entry-v1:${spec.entryId}`;
          const row: PiEntryRow = {
            entryId: spec.entryId,
            parentEntryId: state.head.headEntryId,
            entryType: spec.entryType,
            actor: spec.actor ?? null,
            entryHash,
            parentEntryHash: state.head.headEntryHash,
            preStateHash: state.head.headStateHash,
            postStateHash: state.head.headStateHash,
            payload: spec.payload,
            metadata: spec.metadata ?? null,
            createdAt: new Date().toISOString(),
          };
          state.rows.push(row);
          state.head = { ...state.head, headEntryId: spec.entryId, headEntryHash: entryHash };
        }
        return { ...state.head, items: input.items.map((item) => ({ entryId: item.entryId, entryHash: `pi-entry-v1:${item.entryId}`, parentEntryId: item.parentEntryId })) };
      }
      case "appendGadEvents":
        state.gadEvents.push(...((args[0] as { events: unknown[] }).events));
        return { eventIds: [] };
      case "setBranchHead": {
        const { entryId } = args[0] as { entryId: string | null };
        const row = state.rows.find((candidate) => candidate.entryId === entryId);
        state.head = {
          ...state.head,
          headEntryId: entryId,
          headEntryHash: row?.entryHash ?? null,
          headStateHash: row?.postStateHash ?? "state:empty",
        };
        return state.head;
      }
      case "getEntryById": {
        const { entryId } = args[0] as { entryId: string };
        return state.rows.find((row) => row.entryId === entryId) ?? null;
      }
      case "getBranchPath": {
        const { throughEntryId } = args[0] as { throughEntryId?: string | null };
        if (throughEntryId == null) return [...state.rows];
        const index = state.rows.findIndex((row) => row.entryId === throughEntryId);
        return index < 0 ? [] : state.rows.slice(0, index + 1);
      }
      case "findEntries": {
        const { entryType } = args[0] as { entryType: string };
        return state.rows.filter((row) => row.entryType === entryType);
      }
      default:
        throw new Error(`unexpected rpc method ${method}`);
    }
  });
  return { rpc: { call: call as unknown as GadRpcCaller["call"] }, state };
}

describe("GadSessionStorage", () => {
  it("maps SessionTreeEntry to canonical Pi entry specs", () => {
    const entry: MessageEntry = {
      id: "entry-1",
      parentId: null,
      timestamp: "2026-05-17T12:00:00.000Z",
      type: "message",
      message: { role: "user", content: "hi", timestamp: 1 } as never,
    };
    const spec = sessionEntryToSpec(entry);
    expect(spec).toMatchObject({
      entryId: entry.id,
      parentEntryId: null,
      entryType: "message",
      payload: { message: entry.message },
    });
    expect(rowToSessionEntry({
      entryId: spec.entryId,
      parentEntryId: spec.parentEntryId,
      entryType: spec.entryType,
      actor: null,
      entryHash: "pi-entry-v1:test",
      parentEntryHash: null,
      preStateHash: "state:empty",
      postStateHash: "state:empty",
      payload: spec.payload,
      metadata: spec.metadata ?? null,
      createdAt: entry.timestamp,
    })).toEqual(entry);
  });

  it("appends Pi entries through appendPiEntryBatch", async () => {
    const { rpc, state } = fakeGad();
    const storage = new GadSessionStorage({ rpc, branchId: "branch:test" });
    await storage.appendEntry({
      id: "entry-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "message",
      message: { role: "user", content: "hello", timestamp: 1 } as never,
    });
    expect(state.appendCalls).toHaveLength(1);
    expect(state.appendCalls[0]?.items[0]).toMatchObject({ entryId: "entry-1", entryType: "message" });
  });

  it("splits sidecar events from Pi entries in appendBatch", async () => {
    const { rpc, state } = fakeGad();
    const storage = new GadSessionStorage({ rpc, branchId: "branch:test" });
    await storage.appendBatch([
      { eventId: "event-1", kind: "system_event", payload: { ok: true } },
    ]);
    expect(state.appendCalls).toHaveLength(0);
    expect(state.gadEvents).toEqual([{ eventId: "event-1", kind: "system_event", payload: { ok: true } }]);
  });

  it("retries Pi CAS conflicts", async () => {
    const { rpc, state } = fakeGad();
    state.conflictsRemaining = 2;
    const storage = new GadSessionStorage({ rpc, branchId: "branch:test" });
    await storage.appendEntry({
      id: "entry-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "message",
      message: { role: "user", content: "retry", timestamp: 1 } as never,
    });
    expect(state.appendCalls).toHaveLength(3);
  });

  it("surfaces TranscriptShapeError for malformed Pi payloads", async () => {
    const { rpc, state } = fakeGad();
    state.rows.push({
      entryId: "bad",
      parentEntryId: null,
      entryType: "message",
      actor: null,
      entryHash: "pi-entry-v1:bad",
      parentEntryHash: null,
      preStateHash: "state:empty",
      postStateHash: "state:empty",
      payload: {},
      metadata: null,
      createdAt: new Date().toISOString(),
    });
    const observer = vi.fn();
    const storage = new GadSessionStorage({ rpc, branchId: "branch:test", onTranscriptShapeError: observer });
    await expect(storage.getEntry("bad")).rejects.toBeInstanceOf(TranscriptShapeError);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("integrates with upstream Session.buildContext", async () => {
    const { rpc } = fakeGad();
    const storage = new GadSessionStorage({ rpc, branchId: "branch:test" });
    const session = new Session(storage);
    await session.appendMessage({ role: "user", content: "hello", timestamp: 1 } as never);
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi back" }],
      api: "anthropic" as never,
      provider: "anthropic" as never,
      model: "claude-opus",
      usage: { inputTokens: 0, outputTokens: 0 } as never,
      stopReason: "stop",
      timestamp: 2,
    } as never);
    const context = await session.buildContext();
    expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("rejects leaf entries as stored Pi rows", () => {
    expect(() => sessionEntryToSpec({
      id: "leaf",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "leaf",
      targetId: null,
    } as Extract<SessionTreeEntry, { type: "leaf" }>)).toThrow(/not stored/);
  });
});
