import { describe, expect, it } from "vitest";
import { createInMemorySql } from "@vibestudio/runtime/worker/test-utils";
import type { SqlStorage } from "@vibestudio/runtime/worker";
import { SubagentRunStore } from "./subagent-runs.js";

describe("SubagentRunStore schema", () => {
  it("retains closed receipts without consuming an owned child slot", async () => {
    const sql = (await createInMemorySql()) as unknown as SqlStorage;
    const store = new SubagentRunStore(sql);
    store.createTables();
    store.insert({
      runId: "run-1",
      taskChannelId: "task-1",
      parentContextId: "parent-1",
      childContextId: "child-1",
      childEntityId: "entity-1",
      childParticipantId: null,
      parentChannelId: "channel-1",
      mode: "fresh",
      label: "child",
      depth: 1,
      status: "running",
      integration: "integrated",
      startedAt: 1,
      lastActivityAt: 2,
      agentKind: "pi",
      launchConfig: { model: "openai-codex:gpt-5.3-codex-spark" },
      externalSessionEntityId: null,
      externalGenerationId: null,
    });

    expect(store.countAllocated()).toBe(1);
    store.setStatus("run-1", "closed");

    expect(store.countAllocated()).toBe(0);
    expect(store.resolveReference("run-1")).toMatchObject({
      kind: "exact",
      run: { status: "closed", integration: "integrated" },
    });
  });

  it("rejects the obsolete merge_status shape instead of migrating it", async () => {
    const sql = (await createInMemorySql()) as unknown as SqlStorage;
    sql.exec(`
      CREATE TABLE subagent_runs (
        run_id TEXT PRIMARY KEY,
        task_channel_id TEXT NOT NULL,
        parent_context_id TEXT,
        child_context_id TEXT NOT NULL,
        child_entity_id TEXT NOT NULL,
        child_participant_id TEXT,
        parent_channel_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        label TEXT NOT NULL,
        depth INTEGER NOT NULL,
        status TEXT NOT NULL,
        merge_status TEXT,
        started_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        agent_kind TEXT,
        external_session_entity_id TEXT
      )
    `);
    const store = new SubagentRunStore(sql);
    expect(() => store.createTables()).toThrow(
      "Unsupported subagent_runs schema; delete this pre-release state"
    );
  });

  it.each([
    ["mode", "sideways"],
    ["status", "almost-done"],
    ["agent_kind", ""],
  ])("rejects an invalid persisted %s", async (column, value) => {
    const sql = (await createInMemorySql()) as unknown as SqlStorage;
    const store = new SubagentRunStore(sql);
    store.createTables();
    store.insert({
      runId: "run-1",
      taskChannelId: "task-1",
      parentContextId: "parent-1",
      childContextId: "child-1",
      childEntityId: "entity-1",
      childParticipantId: null,
      parentChannelId: "channel-1",
      mode: "fresh",
      label: "child",
      depth: 1,
      status: "running",
      integration: null,
      startedAt: 1,
      lastActivityAt: 2,
      agentKind: "pi",
      launchConfig: null,
      externalSessionEntityId: null,
      externalGenerationId: null,
    });
    sql.exec(`UPDATE subagent_runs SET ${column} = ? WHERE run_id = 'run-1'`, value);

    expect(() => store.get("run-1")).toThrow(`Invalid subagent_runs.${column}`);
  });
});
