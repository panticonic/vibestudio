import { describe, expect, it } from "vitest";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import { createSemanticVcsSchema } from "./semanticVcsSchema.js";
import { SemanticVcsStore } from "./semanticVcsStore.js";
import { SemanticWorkspace } from "./semanticWorkspace.js";

const timestamp = "2026-07-16T00:00:00.000Z";

describe("SemanticWorkspace causal provenance reachability", () => {
  it("follows only normalized command-to-invocation, turn, and trigger-message edges", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    sql.exec(`
      CREATE TABLE trajectory_invocations (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        turn_id TEXT,
        kind TEXT,
        status TEXT NOT NULL,
        terminal_outcome TEXT,
        request_ref_json TEXT,
        started_event_id TEXT,
        completed_event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, invocation_id)
      );
      CREATE TABLE trajectory_turns (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        opened_at TEXT,
        closed_at TEXT,
        summary TEXT,
        ordinal INTEGER,
        trigger_message_id TEXT,
        PRIMARY KEY (log_id, head, turn_id)
      );
      CREATE TABLE trajectory_messages (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        message_id TEXT NOT NULL,
        turn_id TEXT,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        started_event_id TEXT,
        completed_event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, message_id)
      )
    `);

    const store = new SemanticVcsStore(sql, () => timestamp);
    const initial = store.initializeWorkspace("context:own", "command:genesis");
    const basis = initial.working.ref;
    if (basis.kind !== "event") throw new Error("genesis did not produce an event basis");
    const root = store.stateRoot(basis);

    sql.exec(
      `INSERT INTO trajectory_turns
       (log_id, head, turn_id, opened_at, closed_at, summary, ordinal, trigger_message_id)
       VALUES
       ('trajectory:own', 'main', 'turn:causal', ?, NULL, 'Causal intent', 0, 'message:causal'),
       ('trajectory:own', 'main', 'turn:sibling', ?, NULL, 'Unrelated intent', 1, 'message:sibling')`,
      timestamp,
      timestamp
    );
    sql.exec(
      `INSERT INTO trajectory_messages
       (log_id, head, message_id, turn_id, role, status, started_event_id,
        completed_event_id, updated_at)
       VALUES
       ('trajectory:own', 'main', 'message:causal', NULL, 'user', 'completed', NULL, NULL, ?),
       ('trajectory:own', 'main', 'message:sibling', NULL, 'user', 'completed', NULL, NULL, ?)`,
      timestamp,
      timestamp
    );
    sql.exec(
      `INSERT INTO trajectory_invocations
       (log_id, head, invocation_id, turn_id, kind, status, terminal_outcome,
        request_ref_json, started_event_id, completed_event_id, updated_at)
       VALUES
       ('trajectory:own', 'main', 'invocation:causal', 'turn:causal', 'vcs', 'completed',
        'completed', NULL, NULL, NULL, ?),
       ('trajectory:own', 'main', 'invocation:sibling', 'turn:sibling', 'vcs', 'completed',
        'completed', NULL, NULL, NULL, ?)`,
      timestamp,
      timestamp
    );
    sql.exec(
      `INSERT INTO vcs_command_journal
       (command_id, scope_kind, scope_id, method, request_digest,
        cause_log_id, cause_head, cause_invocation_id, status, result_json,
        created_at, completed_at)
       VALUES ('command:causal', 'context', 'context:own', 'edit', 'request:digest',
               'trajectory:own', 'main', 'invocation:causal', 'complete',
               '{"workUnitId":"work-unit:causal"}', ?, ?)`,
      timestamp,
      timestamp
    );
    sql.exec(
      `INSERT INTO gad_work_units
       (work_unit_id, command_id, kind, intent_summary, external_snapshot_json,
        normalization_protocol, created_at)
       VALUES ('work-unit:causal', 'command:causal', 'edit', 'Apply the causal intent', NULL,
               'normalization:test', ?)`,
      timestamp
    );
    sql.exec(
      `INSERT INTO gad_work_unit_applications
       (application_id, work_unit_id, basis_kind, basis_id,
        result_workspace_fact_root_id, semantic_protocol)
       VALUES ('application:causal', 'work-unit:causal', 'event', ?, ?, 'semantic:test')`,
      basis.eventId,
      root
    );
    sql.exec(
      `INSERT INTO gad_changes
       (change_id, work_unit_id, operation, ordinal, kind, base_json, result_json,
        payload_json, effect_digest)
       VALUES ('change:causal', 'work-unit:causal', 0, 0, 'repo-add', NULL,
               '{"kind":"repository","repositoryId":"repository:test","repoPath":"packages/test"}',
               '{}', 'effect:digest')`
    );
    sql.exec(
      `UPDATE vcs_contexts SET working_head_application_id = ?, updated_at = ?
        WHERE context_id = ?`,
      "application:causal",
      timestamp,
      "context:own"
    );

    let transactionOrdinal = 0;
    const semantic = new SemanticWorkspace({
      workspaceId: "workspace:test",
      sql,
      store,
      now: () => timestamp,
      transaction: <T>(fn: () => T): T => {
        const savepoint = `reachability_test_${transactionOrdinal++}`;
        sql.exec(`SAVEPOINT ${savepoint}`);
        try {
          const result = fn();
          sql.exec(`RELEASE ${savepoint}`);
          return result;
        } catch (error) {
          sql.exec(`ROLLBACK TO ${savepoint}`);
          sql.exec(`RELEASE ${savepoint}`);
          throw error;
        }
      },
    });
    const reachable = (value: Record<string, unknown>, contextIds = ["context:own"]) =>
      semantic.referencesReachable(contextIds, [{ kind: "node", value }]);

    expect(reachable({ kind: "change", changeId: "change:causal" })).toBe(true);
    expect(reachable({ kind: "work-unit", workUnitId: "work-unit:causal" })).toBe(true);
    expect(reachable({ kind: "command", commandId: "command:causal" })).toBe(true);
    expect(
      reachable({
        kind: "trajectory-invocation",
        logId: "trajectory:own",
        head: "main",
        invocationId: "invocation:causal",
      })
    ).toBe(true);
    expect(
      reachable({
        kind: "trajectory-turn",
        logId: "trajectory:own",
        head: "main",
        turnId: "turn:causal",
      })
    ).toBe(true);
    expect(
      reachable({
        kind: "trajectory-message",
        logId: "trajectory:own",
        head: "main",
        messageId: "message:causal",
      })
    ).toBe(true);

    expect(
      reachable({
        kind: "trajectory-invocation",
        logId: "trajectory:own",
        head: "main",
        invocationId: "invocation:sibling",
      })
    ).toBe(false);
    expect(
      reachable({
        kind: "trajectory-turn",
        logId: "trajectory:own",
        head: "main",
        turnId: "turn:sibling",
      })
    ).toBe(false);
    expect(
      reachable({
        kind: "trajectory-message",
        logId: "trajectory:own",
        head: "main",
        messageId: "message:sibling",
      })
    ).toBe(false);
    expect(reachable({ kind: "change", changeId: "change:causal" }, ["context:foreign"])).toBe(
      false
    );
  });
});
