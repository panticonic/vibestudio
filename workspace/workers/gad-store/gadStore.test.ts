import { describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  GENESIS_EVENT_HASH,
  type AgenticEvent,
} from "@workspace/agentic-protocol";
import { GadWorkspaceDO } from "./index.js";

const owner = { kind: "agent" as const, id: "agent-1" };
const GENESIS = GENESIS_EVENT_HASH;

function event<K extends AgenticEvent["kind"]>(
  kind: K,
  patch: Omit<AgenticEvent<K>, "kind" | "actor" | "createdAt"> & { createdAt?: string }
): AgenticEvent<K> {
  return {
    kind,
    actor: owner,
    createdAt: patch.createdAt ?? "2026-05-20T12:00:00.000Z",
    ...patch,
  } as AgenticEvent<K>;
}

function blobRef(digest: string, encoded = "{}") {
  return {
    protocol: "vibez1.blob-ref.v1" as const,
    digest,
    size: encoded.length,
    encoding: "json" as const,
    originalBytes: encoded.length,
  };
}

function textMessagePayload(messageId: string, role: "user" | "assistant", content: string) {
  return {
    protocol: AGENTIC_PROTOCOL_VERSION,
    role,
    blocks: [{ blockId: `${messageId}:block:0` as never, type: "text" as const, content }],
    outcome: "completed" as const,
  };
}

function largeParticipantMetadata() {
  return {
    type: "panel",
    name: "Panel",
    handle: "user",
    methods: [
      {
        name: "eval",
        description: "large method description",
        parameters: { type: "object", properties: { code: { type: "string" } } },
        returns: { type: "object" },
      },
    ],
    arbitraryLargeField: "x".repeat(1024),
  };
}

function expectNoPrivateParticipantMetadata(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain("parameters");
  expect(serialized).not.toContain("returns");
  expect(serialized).not.toContain("description");
  expect(serialized).not.toContain("arbitraryLargeField");
}

/** Shorthand for an opaque (non-agentic) log event input for appendLogEvent. */
function opaque(envelopeId: string, value: unknown, appendedAt = "2026-05-20T12:00:00.000Z") {
  return {
    envelopeId,
    actor: { kind: "panel", id: "panel:user", participantId: "panel:user" },
    payloadKind: "custom.kind",
    payload: { value },
    appendedAt,
  };
}

/**
 * Subtree address at `path`, resolved from the DO's manifest tables via
 * `listManifest`: a dir resolves to its child manifest hash, a file to its
 * content hash, an absent path to null. (The dedicated `getSubtreeHash(es)`
 * RPCs were deleted when subtree addressing moved to the server's content
 * store; tests walk the surviving listing RPC instead.)
 */
async function subtreeHashAt(
  call: <T>(method: string, ...args: unknown[]) => Promise<T>,
  stateHash: string,
  path: string
): Promise<string | null> {
  const segments = path.split("/");
  const parent = segments.slice(0, -1).join("/");
  const name = segments[segments.length - 1];
  const entries = await call<any[]>("listManifest", {
    stateHash,
    ...(parent ? { path: parent } : {}),
  });
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) return null;
  return entry.kind === "dir" ? entry.childManifestHash : entry.contentHash;
}

async function countRows(
  call: (method: string, ...args: unknown[]) => Promise<unknown>,
  where: string,
  params: unknown[]
): Promise<number> {
  const result = (await call(
    "query",
    `SELECT COUNT(*) AS cnt FROM log_events WHERE ${where}`,
    params
  )) as { rows: Array<{ cnt: number }> };
  return Number(result.rows[0]?.cnt ?? 0);
}

describe("GadWorkspaceDO unified log (schema v19)", () => {
  // §3.1 — schema shape
  it("creates only the canonical unified-log tables and drops the v14 ledger tables", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const tables = await call<{ rows: Array<{ name: string }> }>(
      "query",
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      []
    );
    const names = tables.rows.map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "log_heads",
        "log_events",
        "log_blob_refs",
        "gad_worktree_heads",
        "vcs_context_bases",
        "refs",
        "ref_log",
        "gad_transition_parents",
        "trajectory_turns",
        "trajectory_messages",
        "trajectory_invocations",
        "channel_message_types",
        "channel_roster",
        "gad_worktree_states",
        "gad_manifest_nodes",
        "gad_manifest_entries",
        "gad_state_transitions",
        "gad_claims",
        "gad_claim_relations",
        "gad_knowledge_ledger",
        "gad_touches",
        "gad_provenance_cache",
        "gad_prov_metrics",
        "gad_prov_render_log",
      ])
    );
    for (const dropped of [
      "trajectory_branches",
      "trajectory_events",
      "trajectory_blob_refs",
      "channel_envelopes",
      "channel_blob_refs",
      "trajectory_channel_publications",
      "channel_envelope_forks",
      "trajectory_event_forks",
    ]) {
      expect(names).not.toContain(dropped);
    }
    for (const deadKnowledgeProjection of [
      "gad_claim_edges",
      "gad_theories",
      "gad_theory_versions",
      "gad_contradictions",
    ]) {
      expect(names).not.toContain(deadKnowledgeProjection);
    }
  });

  // §3.1 — read-only guard
  it("allows read-only CTE diagnostics while still blocking writes", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    await expect(
      call<{ rows: Array<{ value: number }> }>(
        "query",
        "WITH nums(value) AS (SELECT 1) SELECT value FROM nums",
        []
      )
    ).resolves.toEqual({ rows: [{ value: 1 }] });

    await expect(
      call(
        "query",
        "WITH doomed(value) AS (SELECT 1) DELETE FROM gad_blobs WHERE digest IN (SELECT value FROM doomed)",
        []
      )
    ).rejects.toThrow("rawSql writes are disabled");
  });

  // §3.1 — reopening a current-version schema must be non-destructive
  it("can reopen a current schema without dropping or recreating destructively", async () => {
    const first = await createTestDO(GadWorkspaceDO);
    await first.call("ensureBlob", "blob:one", 1, "text/plain");

    const second = await createTestDO(GadWorkspaceDO, undefined, { db: first.db });
    const rows = await second.call<{ rows: Array<{ hash: string }> }>(
      "query",
      "SELECT hash FROM gad_blobs WHERE hash = ?",
      ["blob:one"]
    );

    expect(rows.rows).toEqual([{ hash: "blob:one" }]);
  });

  // §3.1 — a stale-version stamp upgrades cleanly (drop + recreate)
  it("repairs a stamped older schema that is missing GAD tables", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`INSERT INTO state (key, value) VALUES ('schema_version', ?)`, ["14"]);

    const { call } = await createTestDO(GadWorkspaceDO, undefined, { db });
    const tables = await call<{ rows: Array<{ name: string }> }>(
      "query",
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'log_heads'",
      []
    );

    expect(tables.rows).toEqual([{ name: "log_heads" }]);
  });
});

describe("appendLogEvent core (§3.2)", () => {
  it("appends a hash-chained trajectory log starting at seq 1 and publishes via causality edges", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const result = await call<any>("appendLogEvent", {
      logId: "traj-core",
      head: "main",
      logKind: "trajectory",
      owner,
      events: [
        {
          envelopeId: "evt-1",
          actor: owner,
          payloadKind: "turn.opened",
          payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "start" },
          causality: { turnId: "turn-1" },
          appendedAt: "2026-05-20T12:00:00.000Z",
        },
        {
          envelopeId: "evt-2",
          actor: owner,
          payloadKind: "message.completed",
          payload: textMessagePayload("msg-1", "assistant", "hello from the unified log"),
          causality: { turnId: "turn-1", messageId: "msg-1" },
          appendedAt: "2026-05-20T12:00:01.000Z",
          publish: { channels: [{ channelId: "chan-core" }] },
        },
      ],
    });

    // seq starts at 1, prevHash chains from GENESIS
    expect(result.logId).toBe("traj-core");
    expect(result.head).toBe("main");
    expect(result.envelopes).toHaveLength(2);
    expect(result.envelopes[0]).toMatchObject({
      envelopeId: "evt-1",
      seq: 1,
      prevHash: GENESIS,
    });
    expect(result.envelopes[1]).toMatchObject({
      envelopeId: "evt-2",
      seq: 2,
      prevHash: result.envelopes[0].hash,
    });
    expect(result.headSeq).toBe(2);
    expect(result.headHash).toBe(result.envelopes[1].hash);

    // publication is a deterministic causality edge, not a synthesized event
    expect(result.published).toEqual([
      {
        originEnvelopeId: "evt-2",
        channelId: "chan-core",
        envelopeId: "pub:evt-2:chan-core",
      },
    ]);
    const synthesized = await call<{ rows: Array<{ cnt: number }> }>(
      "query",
      "SELECT COUNT(*) AS cnt FROM log_events WHERE payload_kind = 'external.envelope_published'",
      []
    );
    expect(synthesized.rows[0]?.cnt).toBe(0);

    // channel log got the published envelope in the same call
    const channelEnvelopes = await call<any[]>("readLog", {
      logId: "chan-core",
      head: "main",
    });
    expect(channelEnvelopes).toHaveLength(1);
    expect(channelEnvelopes[0]).toMatchObject({
      logId: "chan-core",
      head: "main",
      seq: 1,
      envelopeId: "pub:evt-2:chan-core",
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind: "message.completed",
        turnId: "turn-1",
      },
      causality: {
        originLogId: "traj-core",
        originHead: "main",
        originEnvelopeId: "evt-2",
      },
    });
    const channelHead = await call<any>("getLogHead", { logId: "chan-core", head: "main" });
    expect(channelHead).toMatchObject({ logKind: "channel", seq: 1 });

    // denormalized causality columns
    const denorm = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT origin_log_id, origin_envelope_id FROM log_events WHERE log_id = ? AND envelope_id = ?",
      ["chan-core", "pub:evt-2:chan-core"]
    );
    expect(denorm.rows[0]).toMatchObject({
      origin_log_id: "traj-core",
      origin_envelope_id: "evt-2",
    });

    // projections keyed (log_id, head)
    const messages = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT log_id, head, message_id, role, status FROM trajectory_messages WHERE log_id = ? AND head = ?",
      ["traj-core", "main"]
    );
    expect(messages.rows).toEqual([
      expect.objectContaining({
        log_id: "traj-core",
        head: "main",
        message_id: "msg-1",
        role: "assistant",
        status: "completed",
      }),
    ]);
    const turns = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT log_id, head, turn_id FROM trajectory_turns WHERE log_id = ? AND head = ?",
      ["traj-core", "main"]
    );
    expect(turns.rows).toEqual([
      expect.objectContaining({ log_id: "traj-core", head: "main", turn_id: "turn-1" }),
    ]);

    // structured log head pointer
    const head = await call<any>("getLogHead", { logId: "traj-core", head: "main" });
    expect(head).toMatchObject({ seq: 2, hash: result.headHash, envelopeId: "evt-2" });

    // point lookup + payloadKind filter
    const single = await call<any>("getLogEvent", {
      logId: "traj-core",
      head: "main",
      envelopeId: "evt-2",
    });
    expect(single).toMatchObject({ envelopeId: "evt-2", seq: 2 });
    const filtered = await call<any[]>("readLog", {
      logId: "traj-core",
      head: "main",
      payloadKind: "message.completed",
    });
    expect(filtered.map((row) => row.envelopeId)).toEqual(["evt-2"]);

    // one integrity code path passes over both log kinds
    const integrity = await call<{ ok: boolean; errors: unknown[] }>("checkLogIntegrity", {});
    expect(integrity).toMatchObject({ ok: true, errors: [] });
  });

  it("rejects appending with a different log_kind to an existing log", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendLogEvent", {
      logId: "log-kind-1",
      head: "main",
      logKind: "trajectory",
      events: [
        {
          envelopeId: "evt-1",
          actor: owner,
          payloadKind: "turn.opened",
          payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "start" },
          causality: { turnId: "turn-1" },
          appendedAt: "2026-05-20T12:00:00.000Z",
        },
      ],
    });
    await expect(
      call("appendLogEvent", {
        logId: "log-kind-1",
        head: "main",
        logKind: "channel",
        events: [opaque("evt-2", 1)],
      })
    ).rejects.toThrow();
  });

  it("enforces expectedHeadHash CAS on appendLogEvent", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const first = await call<any>("appendLogEvent", {
      logId: "log-cas",
      head: "main",
      logKind: "generic",
      events: [opaque("evt-1", 1)],
    });
    await expect(
      call("appendLogEvent", {
        logId: "log-cas",
        head: "main",
        logKind: "generic",
        expectedHeadHash: GENESIS, // stale: head has moved past genesis
        events: [opaque("evt-2", 2)],
      })
    ).rejects.toThrow(/log head conflict/u);
    // matching expectation succeeds
    await expect(
      call("appendLogEvent", {
        logId: "log-cas",
        head: "main",
        logKind: "generic",
        expectedHeadHash: first.headHash,
        events: [opaque("evt-2", 2)],
      })
    ).resolves.toMatchObject({ headSeq: 2 });
  });
});

describe("appendTrajectoryBatch adapter (§3.3)", () => {
  it("returns the legacy shape with exactly the input events and a populated published list", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const result = await call<any>("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-message-1",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: textMessagePayload("msg-1", "assistant", "hello from trajectory"),
          }),
          publish: { channelIds: ["channel-1"] },
        },
        {
          eventId: "event-message-2",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            createdAt: "2026-05-20T12:00:01.000Z",
            causality: { messageId: "msg-2" as never },
            payload: textMessagePayload("msg-2", "assistant", "second"),
          }),
        },
      ],
    });

    // no synthesized external.envelope_published event
    expect(result.events).toHaveLength(2);
    expect(result.events.map((row: any) => row.kind)).toEqual([
      "message.completed",
      "message.completed",
    ]);
    expect(result.events[0]).toMatchObject({
      eventId: "event-message-1",
      trajectoryId: "traj-1",
      branchId: "main",
      seq: 1,
      prevEventHash: GENESIS,
      turnId: "turn-1",
      createdAt: "2026-05-20T12:00:00.000Z",
    });
    expect(result.events[1]).toMatchObject({
      eventId: "event-message-2",
      seq: 2,
      prevEventHash: result.events[0].eventHash,
    });
    expect(result.headEventId).toBe("event-message-2");
    expect(result.headEventHash).toBe(result.events[1].eventHash);
    expect(result.published).toEqual([
      expect.objectContaining({
        eventId: "event-message-1",
        channelId: "channel-1",
        envelopeId: "pub:event-message-1:channel-1",
      }),
    ]);

    const events = await call<any[]>("listTrajectoryEvents", {
      trajectoryId: "traj-1",
      branchId: "main",
    });
    expect(events.map((row) => row.kind)).toEqual(["message.completed", "message.completed"]);
    expect(events[0]).toMatchObject({ eventId: "event-message-1", seq: 1, prevEventHash: GENESIS });

    const fetched = await call<any>("getTrajectoryEvent", { eventId: "event-message-2" });
    expect(fetched).toMatchObject({ eventId: "event-message-2", kind: "message.completed" });

    const head = await call<any>("getTrajectoryBranchHead", {
      trajectoryId: "traj-1",
      branchId: "main",
    });
    expect(head).toMatchObject({
      head_event_id: "event-message-2",
      head_event_hash: result.headEventHash,
    });
    expect(typeof head.head_state_hash).toBe("string");
  });

  it("rejects duplicate turn.opened events for the same branch turn", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "turn-opened-1",
          event: event("turn.opened", {
            turnId: "turn-1" as never,
            createdAt: "2026-05-20T12:00:00.000Z",
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "first open" },
          }),
        },
      ],
    });

    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        events: [
          {
            eventId: "turn-opened-2",
            event: event("turn.opened", {
              turnId: "turn-1" as never,
              createdAt: "2026-05-20T12:05:00.000Z",
              payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "duplicate open" },
            }),
          },
        ],
      })
    ).rejects.toThrow(/duplicate turn\.opened for turn turn-1/u);
  });

  it("rejects duplicate turn.opened events within the same append batch", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        events: [
          {
            eventId: "turn-opened-1",
            event: event("turn.opened", {
              turnId: "turn-1" as never,
              createdAt: "2026-05-20T12:00:00.000Z",
              payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "first open" },
            }),
          },
          {
            eventId: "turn-opened-2",
            event: event("turn.opened", {
              turnId: "turn-1" as never,
              createdAt: "2026-05-20T12:05:00.000Z",
              payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "duplicate open" },
            }),
          },
        ],
      })
    ).rejects.toThrow(/duplicate turn\.opened for turn turn-1/u);
  });

  it("treats replayed matching event ids as idempotent appends", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const input = {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-message-idempotent",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: textMessagePayload("msg-1", "assistant", "hello once"),
          }),
          publish: { channelIds: ["channel-1"] },
        },
      ],
    };

    const first = await call<any>("appendTrajectoryBatch", input);
    const second = await call<any>("appendTrajectoryBatch", input);

    expect(second.headEventId).toBe(first.headEventId);
    expect(second.headEventHash).toBe(first.headEventHash);
    expect(second.events.map((row: { eventId: string }) => row.eventId)).toEqual([
      "event-message-idempotent",
    ]);
    expect(second.published).toEqual(first.published);

    expect(await countRows(call, "envelope_id = ?", ["event-message-idempotent"])).toBe(1);
    // the deterministic publication envelope also stays single
    expect(
      await countRows(call, "envelope_id = ?", ["pub:event-message-idempotent:channel-1"])
    ).toBe(1);
  });

  it("continues trajectory append replay from an already-applied prefix", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const first = await call<any>("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-prefix",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-prefix" as never },
            payload: textMessagePayload("msg-prefix", "assistant", "already committed"),
          }),
          publish: { channelIds: ["channel-1"] },
        },
      ],
    });

    const replay = await call<any>("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-prefix",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-prefix" as never },
            payload: textMessagePayload("msg-prefix", "assistant", "already committed"),
          }),
          publish: { channelIds: ["channel-1"] },
        },
        {
          eventId: "event-suffix",
          event: event("invocation.completed", {
            turnId: "turn-1" as never,
            causality: { invocationId: "call-1" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              result: blobRef("result-ok", '"ok"'),
              terminalOutcome: "success",
            },
          }),
        },
      ],
    });

    expect(replay.events.map((row: { eventId: string }) => row.eventId)).toEqual([
      "event-prefix",
      "event-suffix",
    ]);
    expect(replay.published).toEqual(first.published);
    const rows = await call<{ rows: Array<{ envelope_id: string; payload_kind: string }> }>(
      "query",
      "SELECT envelope_id, payload_kind FROM log_events WHERE log_id = ? AND head = ? ORDER BY seq",
      ["traj-1", "main"]
    );
    expect(rows.rows.map((row) => row.envelope_id)).toEqual(["event-prefix", "event-suffix"]);
    expect(rows.rows.map((row) => row.payload_kind)).toEqual([
      "message.completed",
      "invocation.completed",
    ]);
  });

  it("rejects reused event ids with different event content", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-message-collision",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: textMessagePayload("msg-1", "assistant", "first"),
          }),
        },
      ],
    });

    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        events: [
          {
            eventId: "event-message-collision",
            event: event("message.completed", {
              turnId: "turn-1" as never,
              causality: { messageId: "msg-1" as never },
              payload: textMessagePayload("msg-1", "assistant", "different"),
            }),
          },
        ],
      })
    ).rejects.toThrow(
      // Instrumentation: the error must NAME the diverging field (here the payload),
      // not just say "different content" — so a live id-collision is diagnosable.
      /log envelope id collision with different content:.*diverged at → .*payload/u
    );
  });

  it("rejects appends whose expectedHeadEventHash does not match the current head", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const first = await call<any>("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-base",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: textMessagePayload("msg-1", "assistant", "base"),
          }),
        },
      ],
    });

    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        expectedHeadEventHash: GENESIS, // stale
        events: [
          {
            eventId: "event-next",
            event: event("message.completed", {
              turnId: "turn-1" as never,
              createdAt: "2026-05-20T12:00:01.000Z",
              causality: { messageId: "msg-2" as never },
              payload: textMessagePayload("msg-2", "assistant", "next"),
            }),
          },
        ],
      })
    ).rejects.toThrow(/log head conflict/u);

    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        expectedHeadEventHash: first.headEventHash,
        events: [
          {
            eventId: "event-next",
            event: event("message.completed", {
              turnId: "turn-1" as never,
              createdAt: "2026-05-20T12:00:01.000Z",
              causality: { messageId: "msg-2" as never },
              payload: textMessagePayload("msg-2", "assistant", "next"),
            }),
          },
        ],
      })
    ).resolves.toMatchObject({ headEventId: "event-next" });
  });

  it("indexes transport call ids on projected invocations keyed by (log_id, head)", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-invocation-1",
          event: event("invocation.started", {
            turnId: "turn-1" as never,
            causality: { invocationId: "tool-1" as never, transportCallId: "transport-1" },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              name: "eval",
              request: blobRef("request-1", '{"code":"1 + 1"}'),
            },
          }),
        },
      ],
    });

    const projected = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT invocation_id, transport_call_id FROM trajectory_invocations WHERE log_id = ? AND head = ?",
      ["traj-1", "main"]
    );
    expect(projected.rows).toEqual([{ invocation_id: "tool-1", transport_call_id: "transport-1" }]);
  });

  it("projects replayable knowledge events", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "claim-1-event",
          event: event("knowledge.claim_recorded", {
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              claimId: "claim-1",
              subject: "system",
              predicate: "uses",
              object: "log_events",
            },
          }),
        },
      ],
    });
    const claims = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT claim_id, subject, predicate, object, status FROM gad_claims",
      []
    );
    expect(claims.rows).toEqual([
      expect.objectContaining({
        claim_id: "claim-1",
        subject: "system",
        predicate: "uses",
        object: "log_events",
        status: "active",
      }),
    ]);
  });

  it("inspects turn and invocation state without hydrating full payloads", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "turn-opened-1",
          event: event("turn.opened", {
            turnId: "turn-1" as never,
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "started" },
          }),
        },
        {
          eventId: "message-started-1",
          event: event("message.started", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant" },
          }),
        },
        {
          eventId: "invocation-started-1",
          event: event("invocation.started", {
            turnId: "turn-1" as never,
            causality: { invocationId: "tool-1" as never, transportCallId: "transport-1" },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              name: "eval",
              request: blobRef("request-1", '{"code":"large"}'),
            },
          }),
        },
        {
          eventId: "turn-opened-2",
          event: event("turn.opened", {
            turnId: "turn-2" as never,
            createdAt: "2026-05-20T12:01:00.000Z",
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "second" },
          }),
        },
        {
          eventId: "message-completed-2",
          event: event("message.completed", {
            turnId: "turn-2" as never,
            causality: { messageId: "msg-2" as never },
            payload: textMessagePayload("msg-2", "assistant", "done"),
          }),
        },
      ],
    });

    const turns = await call<any>("inspectTurnState", { trajectoryId: "traj-1", branchId: "main" });
    expect(turns.summary).toMatchObject({
      openTurns: 2,
      streamingMessages: 1,
      nonterminalInvocations: 1,
      duplicateOpenedTurns: 0,
    });
    expect(turns.rows[0]).toMatchObject({
      turn_id: "turn-2",
      streaming_messages: 0,
      nonterminal_invocations: 0,
    });
    expect(turns.rows[1]).toMatchObject({
      turn_id: "turn-1",
      streaming_messages: 1,
      nonterminal_invocations: 1,
    });

    const invocations = await call<any>("inspectInvocationState", {
      transportCallId: "transport-1",
    });
    expect(invocations.summary).toMatchObject({
      projected: 1,
      startedEvents: 1,
      terminalEvents: 0,
      openProjectedInvocations: 1,
    });
    expect(invocations.rows[0]).toMatchObject({
      invocation_id: "tool-1",
      transport_call_id: "transport-1",
      status: "started",
    });
  });
});

describe("channel adapters (§3.4)", () => {
  it("stores generic opaque channel envelopes and exposes replay windows", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-1",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: 1 },
      metadata: { name: "User" },
      attachments: [{ id: "att-1", mimeType: "text/plain", data: "aGVsbG8=", size: 5 }],
      publishedAt: "2026-05-20T12:00:00.000Z",
    });
    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-2",
      from: { kind: "agent", id: "agent:one", participantId: "agent:one" },
      payloadKind: "custom.kind",
      payload: { value: 2 },
      publishedAt: "2026-05-20T12:00:01.000Z",
    });

    expect(
      await call<any[]>("listChannelEnvelopesAfter", { channelId: "channel-1", seq: 1 })
    ).toEqual([expect.objectContaining({ envelopeId: "env-2", seq: 2, payload: { value: 2 } })]);
    expect(
      await call<any[]>("listChannelEnvelopesBefore", { channelId: "channel-1", seq: 2, limit: 1 })
    ).toEqual([
      expect.objectContaining({
        envelopeId: "env-1",
        seq: 1,
        payloadKind: "custom.kind",
        metadata: { name: "User" },
        attachments: [expect.objectContaining({ id: "att-1" })],
      }),
    ]);
    const fetched = await call<any>("getChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-1",
    });
    expect(fetched).toMatchObject({
      channelId: "channel-1",
      seq: 1,
      publishedAt: "2026-05-20T12:00:00.000Z",
    });
    const initial = await call<any>("getInitialChannelWindow", {
      channelId: "channel-1",
      limit: 1,
    });
    expect(initial).toMatchObject({
      totalCount: 2,
      replayFromId: 2,
      replayToId: 2,
      hasMoreBefore: true,
      envelopes: [expect.objectContaining({ envelopeId: "env-2" })],
    });
    const window = await call<any>("getChannelReplayWindow", {
      channelId: "channel-1",
      mode: "after",
      sinceSeq: 0,
      limit: 1,
    });
    expect(window.envelopes.map((envelope: any) => envelope.seq)).toEqual([1]);
  });

  it("serves bounded channel replay windows without decoding out-of-window lineage rows", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);
    for (let index = 1; index <= 5; index += 1) {
      await call("appendChannelEnvelope", {
        channelId: "channel-parent",
        envelopeId: `env-parent-${index}`,
        from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
        payloadKind: "custom.kind",
        payload: { value: index },
        publishedAt: `2026-05-20T12:00:0${index}.000Z`,
      });
    }
    await call("forkChannelLog", {
      fromChannelId: "channel-parent",
      toChannelId: "channel-child",
      throughSeq: 5,
    });
    for (let index = 6; index <= 7; index += 1) {
      await call("appendChannelEnvelope", {
        channelId: "channel-child",
        envelopeId: `env-child-${index}`,
        from: { kind: "agent", id: "agent:one", participantId: "agent:one" },
        payloadKind: "custom.kind",
        payload: { value: index },
        publishedAt: `2026-05-20T12:00:0${index}.000Z`,
      });
    }

    sql.exec(
      "UPDATE log_events SET payload_ref_json = ? WHERE log_id = ? AND head = ? AND seq = ?",
      "{not-json",
      "channel-parent",
      "main",
      1
    );

    const initial = await call<any>("getInitialChannelWindow", {
      channelId: "channel-child",
      limit: 2,
    });
    expect(initial).toMatchObject({
      totalCount: 7,
      firstEnvelopeSeq: 1,
      replayFromId: 6,
      replayToId: 7,
      hasMoreBefore: true,
    });
    expect(initial.envelopes.map((envelope: any) => envelope.seq)).toEqual([6, 7]);

    const after = await call<any>("getChannelReplayWindow", {
      channelId: "channel-child",
      mode: "after",
      sinceSeq: 5,
      limit: 1,
    });
    expect(after.envelopes.map((envelope: any) => envelope.seq)).toEqual([6]);
    expect(after).toMatchObject({ totalCount: 7, firstEnvelopeSeq: 1 });

    const before = await call<any>("getChannelReplayWindow", {
      channelId: "channel-child",
      mode: "before",
      beforeSeq: 7,
      limit: 1,
    });
    expect(before.envelopes.map((envelope: any) => envelope.seq)).toEqual([6]);
    expect(before).toMatchObject({ totalCount: 7, firstEnvelopeSeq: 1, hasMoreBefore: true });

    await expect(
      call<any[]>("listChannelEnvelopes", { channelId: "channel-child", limit: 0 })
    ).resolves.toEqual([]);
  });

  it("projects channel presence envelopes into the roster", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-presence-join",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "presence",
      payload: { action: "join", metadata: { name: "User", type: "panel" } },
      publishedAt: "2026-05-20T12:00:00.000Z",
    });
    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-presence-update",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "presence",
      payload: { action: "update", metadata: { name: "Renamed", type: "panel" } },
      publishedAt: "2026-05-20T12:01:00.000Z",
    });
    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-presence-leave",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "presence",
      payload: { action: "leave" },
      publishedAt: "2026-05-20T12:02:00.000Z",
    });

    const count = await call<{ rows: Array<{ cnt: number }> }>(
      "query",
      "SELECT COUNT(*) AS cnt FROM channel_roster",
      []
    );
    expect(count.rows[0]?.cnt).toBe(1);

    const roster = await call<any>("inspectChannelRoster", { channelId: "channel-1" });
    expect(roster.summary).toMatchObject({
      rows: 1,
      activeParticipants: 0,
      inactiveParticipants: 1,
    });
    expect(roster.rows[0]).toMatchObject({
      participant_id: "panel:user",
      joined_at: "2026-05-20T12:00:00.000Z",
      left_at: "2026-05-20T12:02:00.000Z",
      roles: { name: "Renamed", type: "panel" },
    });
  });

  it("sanitizes every direct channel envelope append before persistence", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const hugeMetadata = largeParticipantMetadata();

    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-sanitized",
      from: {
        kind: "panel",
        id: "panel:user",
        participantId: "panel:user",
        metadata: hugeMetadata,
      },
      to: [{ kind: "agent", id: "agent:one", participantId: "agent:one", metadata: hugeMetadata }],
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: event("invocation.started", {
        causality: { invocationId: "inv-1" as never },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          name: "eval",
          transport: {
            kind: "channel",
            channelId: "channel-1" as never,
            target: {
              kind: "panel",
              id: "panel:user",
              participantId: "panel:user",
              metadata: hugeMetadata,
            },
          },
        },
      }),
      metadata: hugeMetadata,
    });

    const rows = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT actor_json, to_json, payload_ref_json, annotations_json FROM log_events WHERE envelope_id = ?",
      ["env-sanitized"]
    );
    expectNoPrivateParticipantMetadata(rows.rows);
    const annotations = JSON.parse(String(rows.rows[0]?.["annotations_json"])) as {
      metadata?: unknown;
    };
    expect(annotations.metadata).toEqual({
      type: "panel",
      name: "Panel",
      handle: "user",
      methods: [{ name: "eval" }],
    });
  });

  it("sanitizes registry and trajectory-published channel envelopes before persistence", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const hugeMetadata = largeParticipantMetadata();

    await call("appendChannelEnvelopeWithRegistryMutation", {
      channelId: "channel-1",
      envelopeId: "env-registry",
      from: {
        kind: "panel",
        id: "panel:user",
        participantId: "panel:user",
        metadata: hugeMetadata,
      },
      payloadKind: "messageType.registered",
      payload: { typeId: "x" },
      metadata: hugeMetadata,
      registryMutation: {
        kind: "upsertMessageType",
        typeId: "custom",
        row: {
          displayMode: "inline",
          source: { type: "code", code: "export default null" },
          registeredBy: { kind: "panel", id: "panel:user", metadata: hugeMetadata },
        },
      },
    });

    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner: { kind: "agent", id: "agent-1", metadata: hugeMetadata },
      events: [
        {
          eventId: "event-sanitized",
          event: {
            kind: "invocation.started",
            actor: { kind: "agent", id: "agent-1", metadata: hugeMetadata },
            createdAt: "2026-05-20T12:00:00.000Z",
            turnId: "turn-1" as never,
            causality: { invocationId: "inv-1" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              name: "eval",
              transport: {
                kind: "channel",
                channelId: "channel-1" as never,
                target: {
                  kind: "panel",
                  id: "panel:user",
                  participantId: "panel:user",
                  metadata: hugeMetadata,
                },
              },
            },
          },
          publish: {
            channelIds: ["channel-1"],
            audience: [
              {
                kind: "panel",
                id: "panel:user",
                participantId: "panel:user",
                metadata: hugeMetadata,
              },
            ],
          },
        },
      ],
    });

    // Single table now: every persisted row goes through the same scan.
    const rows = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT actor_json, to_json, payload_ref_json, annotations_json FROM log_events",
      []
    );
    const registered = await call<any[]>("listMessageTypes", { channelId: "channel-1" });

    expectNoPrivateParticipantMetadata(rows.rows);
    expectNoPrivateParticipantMetadata(registered);
  });

  it("sanitizes roster snapshot method metadata before hashing log events", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const hugeMetadata = largeParticipantMetadata();

    await call("appendLogEvent", {
      logId: "traj-roster",
      head: "main",
      logKind: "trajectory",
      events: [
        {
          envelopeId: "roster-1",
          actor: owner,
          payloadKind: "system.event",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            kind: "roster.snapshot",
            details: {
              kind: "roster.snapshot",
              roster: {
                participants: [
                  {
                    participantId: "panel:user",
                    ref: {
                      kind: "panel",
                      id: "panel:user",
                      participantId: "panel:user",
                      metadata: hugeMetadata,
                    },
                    handle: "user",
                    type: "panel",
                    methods: hugeMetadata.methods,
                  },
                ],
              },
            },
          },
        },
      ],
    });

    const rows = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT payload_ref_json FROM log_events WHERE envelope_id = ?",
      ["roster-1"]
    );
    const payload = JSON.parse(String(rows.rows[0]?.["payload_ref_json"])) as {
      details: {
        roster: {
          participants: Array<{
            ref: { metadata?: unknown };
            methods: unknown[];
          }>;
        };
      };
    };

    expectNoPrivateParticipantMetadata(payload);
    expect(payload.details.roster.participants[0]?.methods).toEqual([{ name: "eval" }]);
    expect(payload.details.roster.participants[0]?.ref.metadata).toEqual({
      type: "panel",
      name: "Panel",
      handle: "user",
      methods: [{ name: "eval" }],
    });
    await expect(call("checkGadIntegrity", {})).resolves.toMatchObject({ ok: true });
  });

  it("treats replayed matching channel envelope ids as idempotent appends", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const input = {
      channelId: "channel-1",
      envelopeId: "env-idempotent",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: 1 },
      publishedAt: "2026-05-20T12:00:00.000Z",
    };

    const first = await call<any>("appendChannelEnvelope", input);
    const second = await call<any>("appendChannelEnvelope", input);

    expect(second).toEqual(first);
    expect(
      await countRows(call, "log_id = ? AND envelope_id = ?", ["channel-1", "env-idempotent"])
    ).toBe(1);
    await expect(
      call("appendChannelEnvelope", {
        ...input,
        payload: { value: 2 },
      })
    ).rejects.toThrow(/log envelope id collision with different content/u);
  });

  it("applies registry mutations atomically with upsert/clear ordering", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const from = { kind: "panel", id: "panel:user", participantId: "panel:user" };

    await call("appendChannelEnvelopeWithRegistryMutation", {
      channelId: "channel-1",
      envelopeId: "env-upsert",
      from,
      payloadKind: "messageType.registered",
      payload: { typeId: "custom" },
      registryMutation: {
        kind: "upsertMessageType",
        typeId: "custom",
        row: {
          displayMode: "inline",
          source: { type: "code", code: "export default 1" },
        },
      },
    });
    expect(
      await call<any>("getMessageType", { channelId: "channel-1", typeId: "custom" })
    ).toMatchObject({ typeId: "custom" });

    await call("appendChannelEnvelopeWithRegistryMutation", {
      channelId: "channel-1",
      envelopeId: "env-clear",
      from,
      payloadKind: "messageType.cleared",
      payload: { typeId: "custom" },
      registryMutation: { kind: "clearMessageType", typeId: "custom" },
    });
    expect(
      await call<any>("getMessageType", { channelId: "channel-1", typeId: "custom" })
    ).toBeNull();
    expect(await call<any[]>("listMessageTypes", { channelId: "channel-1" })).toEqual([]);

    // a later upsert at a higher seq wins over the earlier clear
    await call("appendChannelEnvelopeWithRegistryMutation", {
      channelId: "channel-1",
      envelopeId: "env-upsert-2",
      from,
      payloadKind: "messageType.registered",
      payload: { typeId: "custom" },
      registryMutation: {
        kind: "upsertMessageType",
        typeId: "custom",
        row: {
          displayMode: "inline",
          source: { type: "code", code: "export default 2" },
        },
      },
    });
    expect(
      await call<any>("getMessageType", { channelId: "channel-1", typeId: "custom" })
    ).toMatchObject({ typeId: "custom" });
  });

  it("provides compact channel envelope inspection for debugging", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-large",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: "x".repeat(4096) },
      metadata: { name: "User" },
    });

    const raw = await call<any[]>("listChannelEnvelopes", { channelId: "channel-1" });
    const inspected = await call<{ rows: Array<Record<string, unknown>> }>(
      "inspectChannelEnvelopes",
      { channelId: "channel-1" }
    );

    expect(JSON.stringify(raw).length).toBeGreaterThan(4000);
    expect(JSON.stringify(inspected).length).toBeLessThan(2000);
    expect(inspected.rows[0]).toMatchObject({
      envelopeId: "env-large",
      payloadKind: "custom.kind",
    });
  });
});

describe("forkLog no-copy (§3.5)", () => {
  it("forks a channel log without copying rows and keeps both heads verifiable", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendLogEvent", {
      logId: "chan-parent",
      head: "main",
      logKind: "channel",
      events: [
        opaque("env-1", 1, "2026-05-20T12:00:01.000Z"),
        opaque("env-2", 2, "2026-05-20T12:00:02.000Z"),
        opaque("env-3", 3, "2026-05-20T12:00:03.000Z"),
      ],
    });
    const parentRows = await call<{ rows: Array<{ seq: number; hash: string }> }>(
      "query",
      "SELECT seq, hash FROM log_events WHERE log_id = ? AND head = ? ORDER BY seq",
      ["chan-parent", "main"]
    );

    const fork = await call<any>("forkLog", {
      fromLogId: "chan-parent",
      fromHead: "main",
      toLogId: "chan-fork",
      toHead: "main",
      atSeq: 2,
    });
    expect(fork).toMatchObject({
      fromLogId: "chan-parent",
      fromHead: "main",
      toLogId: "chan-fork",
      toHead: "main",
      forkSeq: 2,
      forkHash: parentRows.rows[1]?.hash,
      inherited: 2,
    });

    // lineage-aware read: child sees the parent prefix with ORIGINAL envelope ids
    const childView = await call<any[]>("readLog", { logId: "chan-fork", head: "main" });
    expect(childView.map((row) => [row.seq, row.envelopeId])).toEqual([
      [1, "env-1"],
      [2, "env-2"],
    ]);

    // no rows were copied
    expect(await countRows(call, "log_id = ?", ["chan-fork"])).toBe(0);

    // child appends continue at forkSeq + 1, chained from the fork hash
    const appended = await call<any>("appendLogEvent", {
      logId: "chan-fork",
      head: "main",
      logKind: "channel",
      events: [opaque("env-fork-new", 4, "2026-05-20T12:00:04.000Z")],
    });
    expect(appended.envelopes.at(-1)).toMatchObject({
      envelopeId: "env-fork-new",
      seq: 3,
      prevHash: fork.forkHash,
    });
    expect(await countRows(call, "log_id = ?", ["chan-fork"])).toBe(1);

    // fork idempotency
    await expect(
      call<any>("forkLog", {
        fromLogId: "chan-parent",
        fromHead: "main",
        toLogId: "chan-fork",
        toHead: "main",
        atSeq: 2,
      })
    ).resolves.toMatchObject({ forkSeq: 2, forkHash: fork.forkHash });
    await expect(
      call("forkLog", {
        fromLogId: "chan-parent",
        fromHead: "main",
        toLogId: "chan-fork",
        toHead: "main",
        atSeq: 1,
      })
    ).rejects.toThrow();

    // child head metadata
    const childHead = await call<any>("getLogHead", { logId: "chan-fork", head: "main" });
    expect(childHead).toMatchObject({
      logKind: "channel", // inherited from parent
      parentLogId: "chan-parent",
      parentHead: "main",
      forkSeq: 2,
      forkHash: fork.forkHash,
    });

    // one integrity path passes for both heads
    await expect(
      call("checkLogIntegrity", { logId: "chan-parent", head: "main" })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      call("checkLogIntegrity", { logId: "chan-fork", head: "main" })
    ).resolves.toMatchObject({ ok: true });
  });

  it("forks a trajectory log through the identical code path (P5)", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-p5",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "msg-1",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: textMessagePayload("msg-1", "assistant", "one"),
          }),
        },
        {
          eventId: "msg-2",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            createdAt: "2026-05-20T12:00:01.000Z",
            causality: { messageId: "msg-2" as never },
            payload: textMessagePayload("msg-2", "assistant", "two"),
          }),
        },
        {
          eventId: "msg-3",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            createdAt: "2026-05-20T12:00:02.000Z",
            causality: { messageId: "msg-3" as never },
            payload: textMessagePayload("msg-3", "assistant", "three"),
          }),
        },
      ],
    });

    const fork = await call<any>("forkLog", {
      fromLogId: "traj-p5",
      fromHead: "main",
      toLogId: "traj-p5-fork",
      toHead: "main",
      atSeq: 2,
      owner,
    });
    expect(fork).toMatchObject({ forkSeq: 2, inherited: 2 });

    const childView = await call<any[]>("readLog", { logId: "traj-p5-fork", head: "main" });
    expect(childView.map((row) => row.envelopeId)).toEqual(["msg-1", "msg-2"]);
    expect(await countRows(call, "log_id = ?", ["traj-p5-fork"])).toBe(0);

    // projections were seeded under the child key without copying log rows
    const childMessages = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT message_id FROM trajectory_messages WHERE log_id = ? AND head = ? ORDER BY message_id",
      ["traj-p5-fork", "main"]
    );
    expect(childMessages.rows.map((row) => row["message_id"])).toEqual(["msg-1", "msg-2"]);

    const appended = await call<any>("appendTrajectoryBatch", {
      trajectoryId: "traj-p5-fork",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "msg-fork-only",
          event: event("message.completed", {
            turnId: "turn-2" as never,
            createdAt: "2026-05-20T12:00:03.000Z",
            causality: { messageId: "msg-fork-only" as never },
            payload: textMessagePayload("msg-fork-only", "assistant", "diverged"),
          }),
        },
      ],
    });
    expect(appended.events[0]).toMatchObject({
      seq: 3,
      prevEventHash: fork.forkHash,
    });

    await expect(
      call("checkLogIntegrity", { logId: "traj-p5", head: "main" })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      call("checkLogIntegrity", { logId: "traj-p5-fork", head: "main" })
    ).resolves.toMatchObject({ ok: true });
  });

  it("keeps the legacy forkChannelLog adapter shape with inherited counts and empty lineage", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendChannelEnvelope", {
      channelId: "channel-parent",
      envelopeId: "env-1",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: 1 },
      publishedAt: "2026-05-20T12:00:01.000Z",
    });
    await call("appendChannelEnvelope", {
      channelId: "channel-parent",
      envelopeId: "env-presence",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "presence",
      payload: { action: "join" },
      publishedAt: "2026-05-20T12:00:02.000Z",
    });
    await call("appendChannelEnvelope", {
      channelId: "channel-parent",
      envelopeId: "env-2",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: 2 },
      publishedAt: "2026-05-20T12:00:03.000Z",
    });

    const result = await call<any>("forkChannelLog", {
      fromChannelId: "channel-parent",
      toChannelId: "channel-fork",
      throughSeq: 3,
    });
    // no-copy world: the whole prefix (including presence) is inherited as-is
    expect(result).toMatchObject({
      fromChannelId: "channel-parent",
      toChannelId: "channel-fork",
      copied: 3,
      lineage: [],
    });

    const forked = await call<any[]>("listChannelEnvelopesAfter", {
      channelId: "channel-fork",
      seq: 0,
      limit: 10,
    });
    expect(forked.map((envelope) => [envelope.seq, envelope.envelopeId])).toEqual([
      [1, "env-1"],
      [2, "env-presence"],
      [3, "env-2"],
    ]);

    await call("appendChannelEnvelope", {
      channelId: "channel-fork",
      envelopeId: "env-fork-new",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: 4 },
    });
    expect(
      await call<any[]>("listChannelEnvelopesAfter", {
        channelId: "channel-fork",
        seq: 3,
        limit: 10,
      })
    ).toEqual([expect.objectContaining({ envelopeId: "env-fork-new", seq: 4 })]);
  });
});

describe("fork-divergent deterministic terminals (§3.6)", () => {
  it("allows the same deterministic terminal envelope id to diverge per head with lineage-scoped dedupe", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    const startBatch = (trajectoryId: string, branchId: string) => ({
      trajectoryId,
      branchId,
      owner,
      events: [
        {
          eventId: "inv:1:start",
          event: event("invocation.started", {
            turnId: "turn-1" as never,
            causality: { invocationId: "inv-1" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, name: "long_task" },
          }),
        },
      ],
    });
    const parentTerminal = {
      eventId: "inv:1:terminal",
      event: event("invocation.completed", {
        turnId: "turn-1" as never,
        createdAt: "2026-05-20T12:01:00.000Z",
        causality: { invocationId: "inv-1" as never },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          result: blobRef("result-ok", '"ok"'),
          terminalOutcome: "success",
        },
      }),
    };

    // 1. parent appends invocation.started
    await call("appendTrajectoryBatch", startBatch("traj-div", "main"));

    // 2. fork two children at the start event (seq 1)
    await call("forkLog", {
      fromLogId: "traj-div",
      fromHead: "main",
      toLogId: "traj-div",
      toHead: "child",
      atSeq: 1,
      owner,
    });
    await call("forkLog", {
      fromLogId: "traj-div",
      fromHead: "main",
      toLogId: "traj-div",
      toHead: "child2",
      atSeq: 1,
      owner,
    });

    // 3. parent appends its terminal (completed)
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-div",
      branchId: "main",
      owner,
      events: [parentTerminal],
    });

    // 4. child2: appending the parent terminal CONTENT under the same id succeeds
    //    (the parent's terminal is past the fork point, so it is not in child2's
    //    lineage — cross-log dedupe by envelope_id alone must NOT happen) ...
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-div",
      branchId: "child2",
      owner,
      events: [parentTerminal],
    });
    //    ... and re-appending it is a lineage-scoped replay no-op.
    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-div",
        branchId: "child2",
        owner,
        events: [parentTerminal],
      })
    ).resolves.toMatchObject({ branchId: "child2" });
    expect(
      await countRows(call, "log_id = ? AND head = ? AND envelope_id = ?", [
        "traj-div",
        "child2",
        "inv:1:terminal",
      ])
    ).toBe(1);

    // 5. child appends a DIVERGENT terminal under the same deterministic id — succeeds
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-div",
      branchId: "child",
      owner,
      events: [
        {
          eventId: "inv:1:terminal",
          event: event("invocation.abandoned", {
            turnId: "turn-1" as never,
            createdAt: "2026-05-20T12:02:00.000Z",
            causality: { invocationId: "inv-1" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              reason: "superseded by fork",
              terminalOutcome: "abandoned",
            },
          }),
        },
      ],
    });

    // 6. after child divergence, parent re-append into parent is still a no-op
    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-div",
        branchId: "main",
        owner,
        events: [parentTerminal],
      })
    ).resolves.toMatchObject({ branchId: "main" });
    expect(
      await countRows(call, "log_id = ? AND head = ? AND envelope_id = ?", [
        "traj-div",
        "main",
        "inv:1:terminal",
      ])
    ).toBe(1);

    // 7. each head stored its own version of the terminal
    const parentEvent = await call<any>("getLogEvent", {
      logId: "traj-div",
      head: "main",
      envelopeId: "inv:1:terminal",
    });
    const childEvent = await call<any>("getLogEvent", {
      logId: "traj-div",
      head: "child",
      envelopeId: "inv:1:terminal",
    });
    expect(parentEvent.payloadKind).toBe("invocation.completed");
    expect(childEvent.payloadKind).toBe("invocation.abandoned");
    expect(parentEvent.hash).not.toBe(childEvent.hash);

    // 8. three independent rows share the deterministic envelope id
    expect(await countRows(call, "envelope_id = ?", ["inv:1:terminal"])).toBe(3);

    // projections diverge per head
    const statuses = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT head, status FROM trajectory_invocations WHERE log_id = ? AND invocation_id = ? ORDER BY head",
      ["traj-div", "inv-1"]
    );
    expect(statuses.rows).toEqual([
      expect.objectContaining({ head: "child", status: "abandoned" }),
      expect.objectContaining({ head: "child2", status: "completed" }),
      expect.objectContaining({ head: "main", status: "completed" }),
    ]);

    const integrity = await call<{ ok: boolean }>("checkLogIntegrity", {});
    expect(integrity.ok).toBe(true);
  });
});

describe("refs (§3.7)", () => {
  it("performs CAS ref updates with a reflog and supports kind/prefix listing", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    // create with expected: null (must not exist)
    const created = await call<any>("updateRef", {
      refName: "tag:release-1",
      kind: "tag",
      target: { stateHash: "state:aaa" },
      expected: null,
    });
    expect(created).toMatchObject({
      refName: "tag:release-1",
      kind: "tag",
      target: { stateHash: "state:aaa" },
    });

    // creating again with expected: null conflicts
    await expect(
      call("updateRef", {
        refName: "tag:release-1",
        kind: "tag",
        target: { stateHash: "state:bbb" },
        expected: null,
      })
    ).rejects.toThrow(/ref CAS conflict: tag:release-1/u);

    // update with matching expected succeeds
    const updated = await call<any>("updateRef", {
      refName: "tag:release-1",
      kind: "tag",
      target: { stateHash: "state:bbb" },
      expected: { stateHash: "state:aaa" },
    });
    expect(updated.target).toEqual({ stateHash: "state:bbb" });

    // update with stale expected conflicts
    await expect(
      call("updateRef", {
        refName: "tag:release-1",
        kind: "tag",
        target: { stateHash: "state:ccc" },
        expected: { stateHash: "state:aaa" },
      })
    ).rejects.toThrow(/ref CAS conflict: tag:release-1/u);

    // unconditional update (expected omitted)
    await call("updateRef", {
      refName: "tag:release-1",
      kind: "tag",
      target: { stateHash: "state:ccc" },
    });
    expect(await call<any>("resolveRef", { refName: "tag:release-1" })).toMatchObject({
      target: { stateHash: "state:ccc" },
    });
    expect(await call<any>("resolveRef", { refName: "tag:nope" })).toBeNull();

    // reflog recorded each transition
    const reflog = await call<any[]>("listRefLog", { refName: "tag:release-1" });
    expect(reflog).toHaveLength(3);
    const transitions = reflog.map((row: any) => [
      row.old_target_json ? JSON.parse(row.old_target_json).stateHash : null,
      JSON.parse(row.new_target_json).stateHash,
    ]);
    expect(transitions).toEqual(
      expect.arrayContaining([
        [null, "state:aaa"],
        ["state:aaa", "state:bbb"],
        ["state:bbb", "state:ccc"],
      ])
    );

    // listing by kind and prefix
    await call("updateRef", { refName: "context:ctx-1", kind: "context", target: { id: "ctx-1" } });
    const tags = await call<any[]>("listRefs", { kind: "tag" });
    expect(tags.map((row: any) => row.refName)).toEqual(["tag:release-1"]);
    const byPrefix = await call<any[]>("listRefs", { prefix: "context:" });
    expect(byPrefix.map((row: any) => row.refName)).toEqual(["context:ctx-1"]);
  });

  it("treats ref prefixes literally instead of as LIKE patterns", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("updateRef", {
      refName: "context:literal_%:one",
      kind: "context",
      target: { id: "literal" },
    });
    await call("updateRef", {
      refName: "context:literal_A:any",
      kind: "context",
      target: { id: "wildcard-candidate" },
    });
    await call("updateRef", {
      refName: "context:literal_zz:any",
      kind: "context",
      target: { id: "wildcard-candidate-2" },
    });

    const listed = await call<any[]>("listRefs", { prefix: "context:literal_%" });
    expect(listed.map((row: any) => row.refName)).toEqual(["context:literal_%:one"]);

    const deleted = await call<any>("deleteRefsByPrefix", { prefix: "context:literal_%" });
    expect(deleted.deleted).toBe(1);
    expect(await call<any>("resolveRef", { refName: "context:literal_%:one" })).toBeNull();
    expect(await call<any>("resolveRef", { refName: "context:literal_A:any" })).toBeTruthy();
    expect(await call<any>("resolveRef", { refName: "context:literal_zz:any" })).toBeTruthy();
  });
});

describe("recursive manifests (§3.8)", () => {
  const baseFiles = [
    { path: "src/a.ts", contentHash: "blob:a1", size: 10, mode: 420 },
    { path: "src/lib/util.ts", contentHash: "blob:u1", size: 20, mode: 420 },
    { path: "docs/readme.md", contentHash: "blob:r1", size: 30, mode: 420 },
  ];

  async function ingest(call: any, head: string, files: unknown[], eventId: string) {
    return call("ingestWorktreeState", {
      files,
      logId: "traj-manifest",
      head,
      actor: owner,
      eventId,
    });
  }

  it("builds nested dir nodes with structural sharing and supports subtree queries", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const stateA = await ingest(call, "a", baseFiles, "ingest-a");
    const stateB = await ingest(
      call,
      "b",
      [
        baseFiles[0],
        baseFiles[1],
        { path: "docs/readme.md", contentHash: "blob:r2", size: 31, mode: 420 },
      ],
      "ingest-b"
    );
    expect(stateA.stateHash).toMatch(/^state:/);
    expect(stateB.stateHash).toMatch(/^state:/);
    expect(stateA.stateHash).not.toBe(stateB.stateHash);

    // root listing has single-segment dir entries
    const root = await call<any[]>("listManifest", { stateHash: stateA.stateHash });
    expect(root.map((entry) => [entry.name, entry.kind])).toEqual([
      ["docs", "dir"],
      ["src", "dir"],
    ]);
    expect(root.every((entry) => !entry.name.includes("/"))).toBe(true);
    const srcEntry = root.find((entry) => entry.name === "src");
    expect(typeof srcEntry.childManifestHash).toBe("string");

    // subdir listing
    const srcListing = await call<any[]>("listManifest", {
      stateHash: stateA.stateHash,
      path: "src",
    });
    expect(srcListing.map((entry) => [entry.name, entry.kind])).toEqual([
      ["a.ts", "file"],
      ["lib", "dir"],
    ]);
    const aEntry = srcListing.find((entry) => entry.name === "a.ts");
    expect(aEntry).toMatchObject({ contentHash: "blob:a1" });

    // structural sharing: untouched src subtree has the same manifest hash in both states
    const srcA = await subtreeHashAt(call, stateA.stateHash, "src");
    const srcB = await subtreeHashAt(call, stateB.stateHash, "src");
    expect(srcA).toBe(srcB);
    const sharedNodes = await call<{ rows: Array<{ cnt: number }> }>(
      "query",
      "SELECT COUNT(*) AS cnt FROM gad_manifest_nodes WHERE manifest_hash = ?",
      [srcA]
    );
    expect(sharedNodes.rows[0]?.cnt).toBe(1);

    // changed subtree hash differs; file paths resolve to content hashes; missing → null
    const docsA = await subtreeHashAt(call, stateA.stateHash, "docs");
    const docsB = await subtreeHashAt(call, stateB.stateHash, "docs");
    expect(docsA).not.toBe(docsB);
    expect(await subtreeHashAt(call, stateA.stateHash, "docs/readme.md")).toBe("blob:r1");
    expect(await subtreeHashAt(call, stateA.stateHash, "nope/missing")).toBeNull();

    // full-file round trip through the worktree head
    const branchFiles = await call<any[]>("listGadBranchFiles", {
      trajectoryId: "traj-manifest",
      branchId: "a",
    });
    expect(branchFiles.map((row: any) => [row.path, row.content_hash]).sort()).toEqual([
      ["docs/readme.md", "blob:r1"],
      ["src/a.ts", "blob:a1"],
      ["src/lib/util.ts", "blob:u1"],
    ]);

    // O(depth) reads on nested paths
    const file = await call<any>("readGadFileAtState", {
      stateHash: stateA.stateHash,
      path: "src/lib/util.ts",
    });
    expect(file).toMatchObject({ path: "src/lib/util.ts", content_hash: "blob:u1" });
    expect(
      await call<any>("readGadFileAtState", { stateHash: stateA.stateHash, path: "src/missing.ts" })
    ).toBeNull();

    // diff prunes shared subtrees and reports only the changed file
    const diff = await call<any>("diffGadStates", {
      leftStateHash: stateA.stateHash,
      rightStateHash: stateB.stateHash,
    });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([expect.objectContaining({ path: "docs/readme.md" })]);
  });
});

describe("ingestWorktreeState (§3.9)", () => {
  it("creates the state, journals a snapshot event, records transition parents, and CAS-advances the worktree head", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const result = await call<any>("ingestWorktreeState", {
      files: [{ path: "a.txt", contentHash: "blob:a1" }],
      logId: "traj-ingest",
      head: "main",
      actor: owner,
      summary: "initial snapshot",
      eventId: "ingest-1",
    });
    expect(result.stateHash).toMatch(/^state:/);
    expect(result.eventId).toBe("ingest-1");
    expect(typeof result.headHash).toBe("string");

    // a state.snapshot_ingested event was appended to the log
    const events = await call<any[]>("readLog", { logId: "traj-ingest", head: "main" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      envelopeId: "ingest-1",
      payloadKind: "state.snapshot_ingested",
      payload: expect.objectContaining({ outputStateHash: result.stateHash }),
    });

    // transition row with parent 0 mirrored from input_state_hash
    const transitions = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT input_state_hash, output_state_hash FROM gad_state_transitions WHERE event_id = ?",
      ["ingest-1"]
    );
    expect(transitions.rows).toHaveLength(1);
    expect(transitions.rows[0]?.["output_state_hash"]).toBe(result.stateHash);
    const parents = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT ordinal, parent_state_hash FROM gad_transition_parents WHERE event_id = ? ORDER BY ordinal",
      ["ingest-1"]
    );
    expect(parents.rows).toEqual([
      { ordinal: 0, parent_state_hash: transitions.rows[0]?.["input_state_hash"] },
    ]);

    // structured worktree head advanced
    const head = await call<any>("resolveWorktreeHead", { logId: "traj-ingest", head: "main" });
    expect(head).toMatchObject({ stateHash: result.stateHash });

    // CAS conflict on the worktree head throws
    await expect(
      call("ingestWorktreeState", {
        files: [{ path: "a.txt", contentHash: "blob:a2" }],
        logId: "traj-ingest",
        head: "main",
        actor: owner,
        eventId: "ingest-cas",
        expectedRefStateHash: "state:wrong",
      })
    ).rejects.toThrow(/conflict/iu);

    // re-ingest with identical files: value no-op (same stateHash) but a new event
    const reingest = await call<any>("ingestWorktreeState", {
      files: [{ path: "a.txt", contentHash: "blob:a1" }],
      logId: "traj-ingest",
      head: "main",
      actor: owner,
      eventId: "ingest-2",
    });
    expect(reingest.stateHash).toBe(result.stateHash);
    expect(reingest.eventId).toBe("ingest-2");
    const afterEvents = await call<any[]>("readLog", {
      logId: "traj-ingest",
      head: "main",
      payloadKind: "state.snapshot_ingested",
    });
    expect(afterEvents.map((row) => row.envelopeId)).toEqual(["ingest-1", "ingest-2"]);
    const states = await call<{ rows: Array<{ cnt: number }> }>(
      "query",
      "SELECT COUNT(*) AS cnt FROM gad_worktree_states WHERE state_hash = ?",
      [result.stateHash]
    );
    expect(states.rows[0]?.cnt).toBe(1);
  });
});

describe("state.merge_applied (§3.11)", () => {
  it("records multi-parent transitions for merge events with a pre-created output state", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    // base state on main
    const base = await call<any>("ingestWorktreeState", {
      files: [{ path: "a.txt", contentHash: "blob:a1" }],
      logId: "traj-merge",
      head: "main",
      actor: owner,
      eventId: "ingest-base",
    });
    // second parent on a side head
    const sideParent = await call<any>("ingestWorktreeState", {
      files: [{ path: "b.txt", contentHash: "blob:b1" }],
      logId: "traj-merge",
      head: "side-p1",
      actor: owner,
      eventId: "ingest-p1",
    });
    // merge OUTPUT state pre-created on a side head (values exist before the merge append)
    const mergedOut = await call<any>("ingestWorktreeState", {
      files: [
        { path: "a.txt", contentHash: "blob:a1" },
        { path: "b.txt", contentHash: "blob:b1" },
      ],
      logId: "traj-merge",
      head: "side-out",
      actor: owner,
      eventId: "ingest-out",
    });

    const result = await call<any>("appendLogEvent", {
      logId: "traj-merge",
      head: "main",
      logKind: "trajectory",
      events: [
        {
          envelopeId: "merge-1",
          actor: owner,
          payloadKind: "state.merge_applied",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            inputStateHash: base.stateHash,
            parentStateHashes: [sideParent.stateHash],
            outputStateHash: mergedOut.stateHash,
            summary: "merge side-p1 into main",
          },
          appendedAt: "2026-05-20T12:10:00.000Z",
        },
      ],
    });
    expect(result.envelopes.at(-1)).toMatchObject({ envelopeId: "merge-1" });

    const transition = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT input_state_hash, output_state_hash FROM gad_state_transitions WHERE event_id = ?",
      ["merge-1"]
    );
    expect(transition.rows).toEqual([
      { input_state_hash: base.stateHash, output_state_hash: mergedOut.stateHash },
    ]);

    const parents = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT ordinal, parent_state_hash FROM gad_transition_parents WHERE event_id = ? ORDER BY ordinal",
      ["merge-1"]
    );
    expect(parents.rows).toEqual([
      { ordinal: 0, parent_state_hash: base.stateHash },
      { ordinal: 1, parent_state_hash: sideParent.stateHash },
    ]);

    // structured worktree head advanced to the merge output
    const head = await call<any>("resolveWorktreeHead", { logId: "traj-merge", head: "main" });
    expect(head.stateHash).toBe(mergedOut.stateHash);
  });

  it("rejects merge/snapshot events whose output state value does not exist", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await expect(
      call("appendLogEvent", {
        logId: "traj-merge-bad",
        head: "main",
        logKind: "trajectory",
        events: [
          {
            envelopeId: "merge-bad",
            actor: owner,
            payloadKind: "state.merge_applied",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              outputStateHash: "state:does-not-exist",
            },
            appendedAt: "2026-05-20T12:10:00.000Z",
          },
        ],
      })
    ).rejects.toThrow();
  });
});

describe("projection replay (§3.12)", () => {
  it("rebuilds projections from log_events", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "msg-start",
          event: event("message.started", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant", blocks: [] },
          }),
        },
        {
          eventId: "msg-delta",
          event: event("message.delta", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              blockId: "msg-1:block:0" as never,
              type: "text",
              text: "hello",
            },
          }),
        },
      ],
    });

    const replay = await call<{ replayed: number }>("rebuildTrajectoryProjections", {});
    expect(replay.replayed).toBe(2);
    const messages = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT log_id, head, message_id, role, status FROM trajectory_messages",
      []
    );
    expect(messages.rows).toEqual([
      expect.objectContaining({
        log_id: "traj-1",
        head: "main",
        message_id: "msg-1",
        role: "assistant",
        status: "streaming",
      }),
    ]);
  });

  it("rebuilds worktree heads for every head when replaying a forked trajectory", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    // Parent branch: a snapshot ingest, a fork-point marker, then a second
    // ingest that stays parent-only. Replay must re-derive each head's chain
    // from its own lineage view.
    const stateA = await call<any>("ingestWorktreeState", {
      files: [{ path: "a.ts", contentHash: "blob:a1" }],
      logId: "traj-parent",
      head: "branch-parent",
      actor: owner,
      eventId: "apply-a",
    });
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-parent",
      branchId: "branch-parent",
      owner,
      events: [
        {
          eventId: "fork-point",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-fork" as never },
            payload: textMessagePayload("msg-fork", "assistant", "fork here"),
          }),
        },
      ],
    });
    const stateB = await call<any>("ingestWorktreeState", {
      files: [
        { path: "a.ts", contentHash: "blob:a1" },
        { path: "b.ts", contentHash: "blob:b1" },
      ],
      logId: "traj-parent",
      head: "branch-parent",
      actor: owner,
      eventId: "apply-b",
    });

    const forkPointHash = String(
      (
        await call<{ rows: Array<Record<string, unknown>> }>(
          "query",
          "SELECT hash FROM log_events WHERE envelope_id = ?",
          ["fork-point"]
        )
      ).rows[0]?.["hash"]
    );

    // Fork through the marker: child inherits apply-a + the marker, NOT apply-b.
    const fork = await call<Record<string, unknown>>("forkTrajectoryBranch", {
      fromTrajectoryId: "traj-parent",
      fromBranchId: "branch-parent",
      toTrajectoryId: "traj-fork",
      toBranchId: "branch-fork",
      throughEventHash: forkPointHash,
      owner,
    });
    expect(fork["copied"]).toBe(2); // inherited count; nothing was physically copied
    expect((fork as any)["lineage"]).toEqual([]);
    expect(await countRows(call, "log_id = ?", ["traj-fork"])).toBe(0);

    // The two heads diverge: parent reflects both ingests, the fork only one.
    expect(stateA.stateHash).toMatch(/^state:/);
    expect(stateB.stateHash).toMatch(/^state:/);
    expect(stateA.stateHash).not.toBe(stateB.stateHash);

    const readHeads = async () => ({
      parent: await call<any>("resolveWorktreeHead", {
        logId: "traj-parent",
        head: "branch-parent",
      }),
      fork: await call<any>("resolveWorktreeHead", {
        logId: "traj-fork",
        head: "branch-fork",
      }),
    });
    const headsBefore = await readHeads();
    expect(headsBefore).toMatchObject({
      parent: { stateHash: stateB.stateHash },
      fork: { stateHash: stateA.stateHash },
    });
    const stableHeads = (heads: Awaited<ReturnType<typeof readHeads>>) => ({
      parent: {
        logId: heads.parent?.logId,
        head: heads.parent?.head,
        stateHash: heads.parent?.stateHash,
      },
      fork: {
        logId: heads.fork?.logId,
        head: heads.fork?.head,
        stateHash: heads.fork?.stateHash,
      },
    });

    // No-copy fork ⇒ apply-a exists once as a log event; its transition is keyed
    // by event_id, so the table holds one row per distinct event.
    const transitionsQuery =
      "SELECT event_id, input_state_hash, output_state_hash FROM gad_state_transitions ORDER BY event_id";
    const transitionsBefore = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      transitionsQuery,
      []
    );
    expect(transitionsBefore.rows).toHaveLength(2);

    // Replay folds every head's lineage view (3 parent events + 2 inherited).
    const replay = await call<{ replayed: number }>("rebuildTrajectoryProjections", {});
    expect(replay.replayed).toBe(5);

    expect(stableHeads(await readHeads())).toEqual(stableHeads(headsBefore));
    const transitionsAfter = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      transitionsQuery,
      []
    );
    expect(transitionsAfter.rows).toEqual(transitionsBefore.rows);
  });
});

describe("terminal idempotency guards (§3.13)", () => {
  it("enforces terminal invocation idempotency at append time", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-inv-start",
          event: event("invocation.started", {
            turnId: "turn-1" as never,
            causality: { invocationId: "inv-1" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, name: "read_file" },
          }),
        },
        {
          eventId: "event-inv-complete",
          event: event("invocation.completed", {
            turnId: "turn-1" as never,
            causality: { invocationId: "inv-1" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              result: blobRef("result-ok", '"ok"'),
              terminalOutcome: "success",
            },
          }),
        },
      ],
    });

    const inspection = await call<any>("inspectInvocationState", { invocationId: "inv-1" });
    expect(inspection.rows[0]).toMatchObject({
      invocation_id: "inv-1",
      status: "completed",
      terminal_outcome: "success",
      terminal_reason_code: null,
    });

    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        events: [
          {
            eventId: "event-inv-complete-replayed",
            event: event("invocation.completed", {
              turnId: "turn-1" as never,
              causality: { invocationId: "inv-1" as never },
              payload: {
                protocol: AGENTIC_PROTOCOL_VERSION,
                result: blobRef("result-ok", '"ok"'),
                terminalOutcome: "success",
              },
            }),
          },
        ],
      })
    ).resolves.toMatchObject({ branchId: "main" });

    const replayInspection = await call<any>("inspectInvocationState", { invocationId: "inv-1" });
    expect(replayInspection.rows[0]).toMatchObject({
      invocation_id: "inv-1",
      status: "completed",
      completed_event_id: "event-inv-complete",
    });

    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        events: [
          {
            eventId: "event-inv-complete-duplicate-projection",
            event: event("invocation.completed", {
              turnId: "turn-1" as never,
              causality: { invocationId: "inv-1" as never },
              payload: {
                protocol: AGENTIC_PROTOCOL_VERSION,
                result: blobRef("result-ok-wrapped", '{"ok":true}'),
                terminalOutcome: "success",
                terminalReasonCode: "duplicate_replay",
              },
            }),
          },
        ],
      })
    ).resolves.toMatchObject({ branchId: "main" });

    const duplicateProjectionInspection = await call<any>("inspectInvocationState", {
      invocationId: "inv-1",
    });
    expect(duplicateProjectionInspection.rows[0]).toMatchObject({
      invocation_id: "inv-1",
      status: "completed",
      terminal_outcome: "success",
      terminal_reason_code: null,
      completed_event_id: "event-inv-complete",
    });

    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        events: [
          {
            eventId: "event-inv-failed",
            event: event("invocation.failed", {
              turnId: "turn-1" as never,
              causality: { invocationId: "inv-1" as never },
              payload: {
                protocol: AGENTIC_PROTOCOL_VERSION,
                reason: "too late",
                terminalOutcome: "tool_error",
                terminalReasonCode: "eval_exception",
              },
            }),
          },
        ],
      })
    ).rejects.toThrow(/duplicate terminal invocation/u);
  });

  it("rejects terminal invocation events without typed terminal outcome", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        events: [
          {
            eventId: "event-invalid-terminal",
            event: event("invocation.failed", {
              turnId: "turn-1" as never,
              causality: { invocationId: "inv-invalid" as never },
              payload: {
                protocol: AGENTIC_PROTOCOL_VERSION,
                reason: "missing typed outcome",
              } as unknown as AgenticEvent<"invocation.failed">["payload"],
            }),
          },
        ],
      })
    ).rejects.toThrow(/terminalOutcome/u);
  });

  it("enforces terminal approval idempotency at projection time", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-approval-request",
          event: event("approval.requested", {
            turnId: "turn-1" as never,
            causality: { approvalId: "appr-1" as never, invocationId: "inv-1" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, question: "Run eval?" },
          }),
        },
        {
          eventId: "event-approval-grant",
          event: event("approval.resolved", {
            turnId: "turn-1" as never,
            causality: { approvalId: "appr-1" as never, invocationId: "inv-1" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, granted: true, resolvedBy: owner },
          }),
        },
      ],
    });

    // A second, different-content resolution (deny) carries a fresh event id,
    // so it is NOT an idempotent retry and must be rejected at projection time
    // rather than silently flipping the recorded decision.
    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        events: [
          {
            eventId: "event-approval-deny",
            event: event("approval.resolved", {
              turnId: "turn-1" as never,
              causality: { approvalId: "appr-1" as never, invocationId: "inv-1" as never },
              payload: { protocol: AGENTIC_PROTOCOL_VERSION, granted: false, resolvedBy: owner },
            }),
          },
        ],
      })
    ).rejects.toThrow(/duplicate terminal approval/u);

    const approval = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT status, resolved_event_id FROM trajectory_approvals WHERE approval_id = ?",
      ["appr-1"]
    );
    expect(approval.rows[0]).toMatchObject({
      status: "granted",
      resolved_event_id: "event-approval-grant",
    });
  });
});

describe("stored-value refs (§3.14)", () => {
  it("indexes stored value references into log_blob_refs", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-inv-complete-ref",
          event: event("invocation.completed", {
            turnId: "turn-1" as never,
            causality: { invocationId: "inv-1" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              result: {
                protocol: "vibez1.blob-ref.v1",
                digest: "abc123",
                size: 42,
                encoding: "json",
                originalBytes: 42,
              },
              terminalOutcome: "success",
            },
          }),
        },
      ],
    });

    const refs = await call<{
      rows: Array<{
        log_id: string;
        head: string;
        envelope_id: string;
        field_path: string;
        digest: string;
      }>;
    }>(
      "query",
      "SELECT log_id, head, envelope_id, field_path, digest FROM log_blob_refs ORDER BY envelope_id, field_path",
      []
    );
    expect(refs.rows).toEqual([
      {
        log_id: "traj-1",
        head: "main",
        envelope_id: "event-inv-complete-ref",
        field_path: "$.result",
        digest: "abc123",
      },
    ]);
  });

  it("rejects raw unbounded trajectory payload fields", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await expect(
      call("appendTrajectoryBatch", {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        events: [
          {
            eventId: "event-raw-result",
            event: event("invocation.completed", {
              turnId: "turn-1" as never,
              causality: { invocationId: "inv-1" as never },
              payload: {
                protocol: AGENTIC_PROTOCOL_VERSION,
                result: { raw: true },
                terminalOutcome: "success",
              },
            }),
          },
        ],
      })
    ).rejects.toThrow(/unencoded stored values/u);
  });

  it("reports oversized storage rows through diagnostics and integrity checks", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-oversized",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: "x".repeat(530 * 1024) },
    });

    const diagnostics = await call<{ rows: Array<Record<string, unknown>> }>(
      "inspectStorageDiagnostics",
      {}
    );
    expect(diagnostics.rows).toEqual([expect.objectContaining({ id: "env-oversized" })]);

    const integrity = await call<{ ok: boolean; errors: Array<Record<string, unknown>> }>(
      "checkGadIntegrity",
      {}
    );
    expect(integrity.ok).toBe(false);
    expect(integrity.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "storage-diagnostic", id: "env-oversized" }),
      ])
    );
  });

  it("reports storage diagnostics and garbage-collects unreferenced blob metadata", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("ensureBlob", "orphan-digest", 10, "text/plain");
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-ref",
          event: event("invocation.completed", {
            turnId: "turn-1" as never,
            causality: { invocationId: "inv-1" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              result: {
                protocol: "vibez1.blob-ref.v1",
                digest: "kept-digest",
                size: 20,
                encoding: "json",
                originalBytes: 20,
              },
              terminalOutcome: "success",
            },
          }),
        },
      ],
    });

    const refs = await call<{ rows: Array<{ digest: string }> }>("listStoredValueRefs", {
      eventId: "event-ref",
    });
    expect(refs.rows.map((row) => row.digest)).toEqual(["kept-digest"]);
    const diagnostics = await call<{ rows: unknown[] }>("inspectStorageDiagnostics", {});
    expect(diagnostics.rows).toEqual([]);
    const dryRun = await call<{ deleted: string[]; dryRun: boolean }>("collectGarbageBlobRefs", {});
    expect(dryRun).toMatchObject({ deleted: ["orphan-digest"], dryRun: true });
    const deleted = await call<{ deleted: string[]; dryRun: boolean }>("collectGarbageBlobRefs", {
      dryRun: false,
    });
    expect(deleted).toMatchObject({ deleted: ["orphan-digest"], dryRun: false });
  });
});

describe("lineage queries over causality edges (§3.15)", () => {
  it("links trajectory events to deterministic channel publications and back", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const result = await call<any>("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "event-message-1",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: textMessagePayload("msg-1", "assistant", "hello from trajectory"),
          }),
          publish: { channelIds: ["channel-1"] },
        },
      ],
    });
    expect(result.published).toEqual([
      expect.objectContaining({
        eventId: "event-message-1",
        channelId: "channel-1",
        envelopeId: "pub:event-message-1:channel-1",
      }),
    ]);

    const envelopes = await call<any[]>("listChannelEnvelopes", {
      channelId: "channel-1",
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
    });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      seq: 1,
      envelopeId: "pub:event-message-1:channel-1",
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind: "message.completed",
        causality: { messageId: "msg-1" },
      },
    });
    // the published payload is the semantic agentic event, free of storage fields
    expect(envelopes[0].payload.eventId).toBeUndefined();
    expect(envelopes[0].payload.branchId).toBeUndefined();
    expect(envelopes[0].payload.seq).toBeUndefined();

    const lineage = await call<any>("getTrajectoryForEnvelope", {
      envelopeId: "pub:event-message-1:channel-1",
    });
    expect(lineage).toMatchObject({
      publication: {
        eventId: "event-message-1",
        trajectoryId: "traj-1",
        branchId: "main",
        channelId: "channel-1",
        channelSeq: 1,
        envelopeId: "pub:event-message-1:channel-1",
      },
      envelope: {
        seq: 1,
        payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      },
      trajectoryEvent: {
        eventId: "event-message-1",
        kind: "message.completed",
        branchId: "main",
      },
    });

    const turnPublications = await call<any[]>("listPublishedEnvelopesForTrajectory", {
      branchId: "main",
      turnId: "turn-1",
    });
    expect(turnPublications).toHaveLength(1);
    expect(turnPublications[0]).toMatchObject({
      publication: {
        eventId: "event-message-1",
        channelId: "channel-1",
        channelSeq: 1,
      },
      trajectoryEvent: {
        causality: { messageId: "msg-1" },
      },
    });

    const envelopesForTrajectory = await call<any[]>("getEnvelopesForTrajectory", {
      branchId: "main",
      eventId: "event-message-1",
    });
    expect(envelopesForTrajectory).toHaveLength(1);

    const artifacts = await call<any[]>("getPublishedArtifactsForTurn", { turnId: "turn-1" });
    expect(artifacts).toEqual([
      expect.objectContaining({
        lineage: expect.objectContaining({
          publication: expect.objectContaining({ eventId: "event-message-1" }),
        }),
      }),
    ]);

    const privateLineage = await call<any>("getPrivateLineageForPublishedEnvelope", {
      envelopeId: "pub:event-message-1:channel-1",
    });
    expect(privateLineage.branchEvents.map((row: any) => row.eventId)).toEqual(["event-message-1"]);

    const publicationIntegrity = await call<any>("inspectPublicationIntegrity", {
      channelId: "channel-1",
    });
    expect(publicationIntegrity.summary).toMatchObject({
      expectedMappings: 1,
      missingMappings: 0,
      orphanMappings: 0,
    });

    const integrity = await call<{ ok: boolean }>("checkGadIntegrity", {});
    expect(integrity.ok).toBe(true);
  });

  it("keeps side trajectory events private while joining a published summary back to downstream consumers", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-main",
      branchId: "side-task",
      owner,
      events: [
        {
          eventId: "side-private-observation",
          event: event("system.event", {
            turnId: "turn-side" as never,
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              kind: "side-search-result",
              details: blobRef("details-side", '{"privateFinding":"keep this out of PubSub"}'),
            },
          }),
        },
        {
          eventId: "side-summary",
          event: event("message.completed", {
            turnId: "turn-side" as never,
            causality: { messageId: "side-summary-message" as never },
            payload: textMessagePayload(
              "side-summary-message",
              "assistant",
              "Side task summary for the main session"
            ),
          }),
          publish: { channelIds: ["main-channel"] },
        },
      ],
    });

    const sideEnvelopes = await call<any[]>("getEnvelopesForTrajectory", {
      branchId: "side-task",
    });
    expect(sideEnvelopes).toHaveLength(1);
    expect(sideEnvelopes[0]).toMatchObject({
      publication: {
        eventId: "side-summary",
        branchId: "side-task",
        channelId: "main-channel",
        envelopeId: "pub:side-summary:main-channel",
      },
      envelope: {
        payload: {
          kind: "message.completed",
          payload: {
            blocks: [
              expect.objectContaining({
                content: "Side task summary for the main session",
                type: "text",
              }),
            ],
            outcome: "completed",
          },
        },
      },
    });

    const publishedEnvelopeId = sideEnvelopes[0].publication.envelopeId;
    const publicChannel = await call<any[]>("listChannelEnvelopes", { channelId: "main-channel" });
    expect(publicChannel.map((envelope) => envelope.payload.payload.blocks?.[0]?.content)).toEqual([
      "Side task summary for the main session",
    ]);
    expect(JSON.stringify(publicChannel)).not.toContain("keep this out of PubSub");

    const privateLineage = await call<any>("getPrivateLineageForPublishedEnvelope", {
      envelopeId: publishedEnvelopeId,
    });
    expect(privateLineage.branchEvents.map((row: any) => row.eventId)).toEqual([
      "side-private-observation",
      "side-summary",
    ]);
    expect(JSON.stringify(privateLineage.branchEvents)).not.toContain("keep this out of PubSub");
    expect(privateLineage.branchEvents[0].payload.details).toMatchObject({
      protocol: "vibez1.blob-ref.v1",
      digest: "details-side",
    });

    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-main",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "main-consumes-side-summary",
          event: event("knowledge.claim_recorded", {
            turnId: "turn-main" as never,
            causality: { parentEventId: "side-summary" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              claimId: "claim-consumed-side-summary",
              subject: "main-session",
              predicate: "consumed-published-envelope",
              object: publishedEnvelopeId,
            },
          }),
        },
      ],
    });

    const consumers = await call<any[]>("getDownstreamConsumers", {
      envelopeId: publishedEnvelopeId,
    });
    expect(consumers.map((row) => row.eventId)).toEqual(["main-consumes-side-summary"]);
    expect(consumers[0]).toMatchObject({
      branchId: "main",
      payload: { object: publishedEnvelopeId },
    });
  });
});

describe("checkGadIntegrity (§3.16)", () => {
  it("detects a tampered log event", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "msg-1",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-1" as never },
            payload: textMessagePayload("msg-1", "assistant", "hello"),
          }),
        },
      ],
    });

    sql.exec("UPDATE log_events SET payload_ref_json = ? WHERE envelope_id = ?", "{}", "msg-1");

    const scoped = await call<{ ok: boolean; errors: unknown[] }>("checkLogIntegrity", {
      logId: "traj-1",
      head: "main",
    });
    expect(scoped.ok).toBe(false);
    expect(scoped.errors.length).toBeGreaterThan(0);

    const integrity = await call<{ ok: boolean; errors: Array<Record<string, unknown>> }>(
      "checkGadIntegrity",
      {}
    );
    expect(integrity.ok).toBe(false);
    expect(JSON.stringify(integrity.errors)).toContain("msg-1");
  });

  it("detects broken recursive manifests and missing transition states", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);
    const state = await call<any>("ingestWorktreeState", {
      files: [{ path: "src/lib/util.ts", contentHash: "blob:u1" }],
      logId: "traj-1",
      head: "main",
      actor: owner,
      eventId: "ingest-1",
    });
    expect(await call<{ ok: boolean }>("checkGadIntegrity", {})).toMatchObject({ ok: true });

    // break the recursive manifest: drop the nested dir node referenced by the root
    const subtree = await subtreeHashAt(call, state.stateHash, "src/lib");
    expect(subtree).toMatch(/^manifest:/);
    sql.exec("DELETE FROM gad_manifest_nodes WHERE manifest_hash = ?", subtree);
    sql.exec("DELETE FROM gad_manifest_entries WHERE manifest_hash = ?", subtree);

    // dangling transition referencing states that do not exist
    sql.exec(
      "INSERT INTO gad_state_transitions (event_id, input_state_hash, output_state_hash, created_at) VALUES (?, ?, ?, ?)",
      "missing-event",
      "state:missing-input",
      "state:missing-output",
      "2026-05-20T12:00:00.000Z"
    );

    const integrity = await call<{ ok: boolean; errors: Array<Record<string, unknown>> }>(
      "checkGadIntegrity",
      {}
    );
    expect(integrity.ok).toBe(false);
    const serialized = JSON.stringify(integrity.errors);
    expect(serialized).toContain(subtree);
    expect(serialized).toContain("missing-event");
  });

  it("detects a log head pointer that disagrees with the stored chain", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);
    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-1",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: 1 },
    });

    sql.exec(
      "UPDATE log_heads SET current_seq = ?, current_hash = ?, current_envelope_id = ? WHERE log_id = ? AND head = ?",
      99,
      "deadbeef",
      "env-x",
      "channel-1",
      "main"
    );

    const scoped = await call<{ ok: boolean; errors: unknown[] }>("checkLogIntegrity", {
      logId: "channel-1",
      head: "main",
    });
    expect(scoped.ok).toBe(false);

    const integrity = await call<{ ok: boolean; errors: Array<Record<string, unknown>> }>(
      "checkGadIntegrity",
      {}
    );
    expect(integrity.ok).toBe(false);
    expect(JSON.stringify(integrity.errors)).toContain("channel-1");
  });

  it("flags private participant metadata if storage rows are corrupted", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);
    await call("appendChannelEnvelope", {
      channelId: "channel-1",
      envelopeId: "env-corrupt",
      from: { kind: "panel", id: "panel:user", participantId: "panel:user" },
      payloadKind: "custom.kind",
      payload: { value: 1 },
    });
    sql.exec(
      `UPDATE log_events SET actor_json = ? WHERE envelope_id = ?`,
      JSON.stringify({ kind: "panel", id: "panel:user", metadata: largeParticipantMetadata() }),
      "env-corrupt"
    );

    const integrity = await call<{ ok: boolean; errors: Array<Record<string, unknown>> }>(
      "checkGadIntegrity",
      {}
    );

    expect(integrity.ok).toBe(false);
    expect(JSON.stringify(integrity.errors)).toContain("env-corrupt");
  });
});

describe("cache amnesia (§3.17)", () => {
  it("rebuilds identical derived state after deleting all projections and worktree heads", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);

    // Scenario: turn + message (published) + invocation round trip + a
    // worktree snapshot ingest (live worktree-provenance path).
    await call("ensureBlob", "blob:out1", 8, "text/plain");
    await call("ingestWorktreeState", {
      files: [{ path: "src/out.ts", contentHash: "blob:out1" }],
      logId: "traj-amnesia",
      head: "main",
      actor: owner,
      eventId: "ingest-out",
    });
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-amnesia",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "turn-1-open",
          event: event("turn.opened", {
            turnId: "turn-1" as never,
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "work" },
          }),
        },
        {
          eventId: "msg-1-done",
          event: event("message.completed", {
            turnId: "turn-1" as never,
            createdAt: "2026-05-20T12:00:01.000Z",
            causality: { messageId: "msg-1" as never },
            payload: textMessagePayload("msg-1", "assistant", "working on it"),
          }),
          publish: { channelIds: ["channel-amnesia"] },
        },
        {
          eventId: "inv-1-start",
          event: event("invocation.started", {
            turnId: "turn-1" as never,
            createdAt: "2026-05-20T12:00:02.000Z",
            causality: { invocationId: "inv-1" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, name: "write_file" },
          }),
        },
        {
          eventId: "inv-1-complete",
          event: event("invocation.completed", {
            turnId: "turn-1" as never,
            createdAt: "2026-05-20T12:00:04.000Z",
            causality: { invocationId: "inv-1" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              result: blobRef("result-write", '"ok"'),
              terminalOutcome: "success",
            },
          }),
        },
      ],
    });

    const readAll = async () => ({
      events: await call<any[]>("listTrajectoryEvents", {
        trajectoryId: "traj-amnesia",
        branchId: "main",
      }),
      files: await call<any[]>("listGadBranchFiles", {
        trajectoryId: "traj-amnesia",
        branchId: "main",
      }),
      turns: await call<any>("inspectTurnState", {
        trajectoryId: "traj-amnesia",
        branchId: "main",
      }),
      channel: await call<any[]>("listChannelEnvelopes", { channelId: "channel-amnesia" }),
      worktreeHead: await call<any>("resolveWorktreeHead", {
        logId: "traj-amnesia",
        head: "main",
      }),
    });

    const before = await readAll();
    expect(before.events.length).toBeGreaterThan(0);
    expect(before.files).toEqual([expect.objectContaining({ path: "src/out.ts" })]);
    expect(before.turns.summary.openTurns).toBe(1);
    expect(before.channel).toHaveLength(1);

    const valueCounts = async () => {
      const result = await call<{ rows: Array<Record<string, unknown>> }>(
        "query",
        `SELECT (SELECT COUNT(*) FROM gad_worktree_states) AS states,
                (SELECT COUNT(*) FROM gad_manifest_nodes) AS nodes,
                (SELECT COUNT(*) FROM gad_file_versions) AS versions`,
        []
      );
      return result.rows[0];
    };
    const valuesBefore = await valueCounts();

    // P3: derived state is deletable at any time.
    for (const table of [
      "trajectory_turns",
      "trajectory_messages",
      "trajectory_message_blocks",
      "trajectory_invocations",
      "trajectory_invocation_outputs",
      "trajectory_approvals",
      "trajectory_usage_rollups",
      "trajectory_checkpoints",
      "channel_roster",
      "gad_state_transitions",
      "gad_transition_parents",
      "gad_claims",
    ]) {
      sql.exec(`DELETE FROM ${table}`);
    }
    sql.exec("DELETE FROM gad_worktree_heads");

    // projections are gone
    expect(
      (
        await call<{ rows: Array<{ cnt: number }> }>(
          "query",
          "SELECT COUNT(*) AS cnt FROM trajectory_turns",
          []
        )
      ).rows[0]?.cnt
    ).toBe(0);

    await call("rebuildTrajectoryProjections", {});

    const after = await readAll();
    expect(after.events).toEqual(before.events);
    expect(after.files).toEqual(before.files);
    expect(after.turns).toEqual(before.turns);
    expect(after.channel).toEqual(before.channel);
    expect(after.worktreeHead).toMatchObject({
      logId: before.worktreeHead.logId,
      head: before.worktreeHead.head,
      stateHash: before.worktreeHead.stateHash,
    });

    // values were never touched
    expect(await valueCounts()).toEqual(valuesBefore);

    const integrity = await call<{ ok: boolean }>("checkGadIntegrity", {});
    expect(integrity.ok).toBe(true);
  });
});

describe("GC reachability protections (§3.18)", () => {
  // A timestamp far past the GC creation grace window so survival in these
  // tests is attributable to reachability rules, not the grace period.
  const PAST_GRACE = "2026-01-01T00:00:00.000Z";

  it("keeps uncommitted working-edit content live and sweeps it once committed", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);
    // Two blobs referenced ONLY by an uncommitted working-edit op: the edit's
    // result (new_content_hash) and its base (old_content_hash, needed by
    // revert/inverse-patch). Neither has a gad_file_versions row yet.
    await call("ensureBlob", "blob:edit-new", 4, "text/plain");
    await call("ensureBlob", "blob:edit-old", 4, "text/plain");
    sql.exec(
      `INSERT INTO gad_worktree_edit_ops (
         event_id, log_id, head, committed_event_id, committed_seq,
         edit_seq, output_state_hash, ordinal, kind, path,
         old_content_hash, new_content_hash, created_at
       ) VALUES (?, ?, ?, NULL, NULL, 1, NULL, 0, 'modify', ?, ?, ?, ?)`,
      "edit-evt-1",
      "vcs:repo:demo",
      "main",
      "notes.txt",
      "blob:edit-old",
      "blob:edit-new",
      PAST_GRACE
    );
    sql.exec(`UPDATE gad_blobs SET created_at = ?`, PAST_GRACE);
    sql.exec(`UPDATE gad_worktree_states SET created_at = ?`, PAST_GRACE);

    const mark = await call<{ liveBlobDigests: string[] }>("runGadGcMark");
    // Both hashes are in the live set and out of the candidate set.
    expect(mark.liveBlobDigests).toContain("blob:edit-new");
    expect(mark.liveBlobDigests).toContain("blob:edit-old");
    const candidates = await call<{ rows: Array<{ digest: string }> }>(
      "query",
      "SELECT digest FROM gad_gc_candidates",
      []
    );
    expect(candidates.rows.map((row) => row.digest)).not.toContain("blob:edit-new");
    expect(candidates.rows.map((row) => row.digest)).not.toContain("blob:edit-old");

    // The sweep leaves the uncommitted edit's bytes intact.
    const swept = await call<{ digests: string[] }>("runGadGcSweep", { minAgeMs: 0 });
    expect(swept.digests).not.toContain("blob:edit-new");
    expect(swept.digests).not.toContain("blob:edit-old");

    // Scoping check: the edit-op protection is UNCOMMITTED-only. Once the row
    // is re-keyed to committed (committed_event_id set — commit re-keys, never
    // re-inserts), a committed edit's content survives via its gad_file_versions
    // row (the canonical path), NOT the edit-op row. So with no file version
    // present here, the previously-protected blobs become sweepable — proving
    // the union does not over-protect committed rows.
    sql.exec(
      `UPDATE gad_worktree_edit_ops SET committed_event_id = 'commit-evt-1', committed_seq = 1`
    );
    const mark2 = await call<{ liveBlobDigests: string[] }>("runGadGcMark");
    expect(mark2.liveBlobDigests).not.toContain("blob:edit-new");
    expect(mark2.liveBlobDigests).not.toContain("blob:edit-old");
    const swept2 = await call<{ digests: string[] }>("runGadGcSweep", { minAgeMs: 0 });
    expect(swept2.digests).toEqual(expect.arrayContaining(["blob:edit-new", "blob:edit-old"]));
  });

  it("does not sweep a candidate that gained an uncommitted edit-op reference after mark", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);
    // A blob that is orphaned at mark time becomes a GC candidate. If an
    // uncommitted working-edit op starts referencing it BETWEEN mark and sweep,
    // the sweep's delete-time re-check must treat it as live — otherwise it is
    // deleted from gad_blobs and the host CAS, dangling the edit-op reference.
    await call("ensureBlob", "blob:toctou", 4, "text/plain");
    sql.exec(`UPDATE gad_blobs SET created_at = ?`, PAST_GRACE);

    await call("runGadGcMark");
    // The orphan blob is a candidate after mark (no live reference yet).
    const marked = await call<{ rows: Array<{ digest: string }> }>(
      "query",
      "SELECT digest FROM gad_gc_candidates WHERE digest = ?",
      ["blob:toctou"]
    );
    expect(marked.rows.map((row) => row.digest)).toContain("blob:toctou");

    // Race: an uncommitted edit op referencing the candidate is created after
    // mark but before sweep.
    sql.exec(
      `INSERT INTO gad_worktree_edit_ops (
         event_id, log_id, head, committed_event_id, committed_seq,
         edit_seq, output_state_hash, ordinal, kind, path,
         old_content_hash, new_content_hash, created_at
       ) VALUES (?, ?, ?, NULL, NULL, 1, NULL, 0, 'modify', ?, NULL, ?, ?)`,
      "edit-toctou",
      "vcs:repo:demo",
      "main",
      "notes.txt",
      "blob:toctou",
      PAST_GRACE
    );

    const swept = await call<{ digests: string[] }>("runGadGcSweep", { minAgeMs: 0 });
    expect(swept.digests).not.toContain("blob:toctou");
    const blobs = await call<{ rows: Array<{ hash: string }> }>(
      "query",
      "SELECT hash FROM gad_blobs WHERE hash = ?",
      ["blob:toctou"]
    );
    expect(blobs.rows).toHaveLength(1);

    // Once the edit op no longer references it (discarded/committed away), a
    // later mark+sweep cycle collects the now-orphaned blob.
    sql.exec(`DELETE FROM gad_worktree_edit_ops WHERE event_id = 'edit-toctou'`);
    await call("runGadGcMark");
    const swept2 = await call<{ digests: string[] }>("runGadGcSweep", { minAgeMs: 0 });
    expect(swept2.digests).toContain("blob:toctou");
    const blobs2 = await call<{ rows: Array<{ hash: string }> }>(
      "query",
      "SELECT hash FROM gad_blobs WHERE hash = ?",
      ["blob:toctou"]
    );
    expect(blobs2.rows).toHaveLength(0);
  });

  it("keeps committed-edit content live via its file-version row", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);
    // A committed edit op alone does not protect its content; the canonical
    // protection is the file-version row the commit produced. Simulate a
    // committed edit whose result blob IS backed by a file-version row kept
    // by a live manifest (so the mark's orphan-sweep keeps the version).
    await call("ensureBlob", "blob:committed", 6, "text/plain");
    await call("ingestWorktreeState", {
      files: [{ path: "committed.txt", contentHash: "blob:committed" }],
      logId: "vcs:repo:demo",
      head: "main",
      actor: owner,
      summary: "committed content",
      eventId: "commit-c1",
    });
    sql.exec(
      `INSERT INTO gad_worktree_edit_ops (
         event_id, log_id, head, committed_event_id, committed_seq,
         edit_seq, output_state_hash, ordinal, kind, path,
         old_content_hash, new_content_hash, created_at
       ) VALUES (?, ?, ?, 'commit-c1', 1, 1, ?, 0, 'modify', ?, NULL, ?, ?)`,
      "edit-committed",
      "vcs:repo:demo",
      "main",
      "state:committed",
      "committed.txt",
      "blob:committed",
      PAST_GRACE
    );
    sql.exec(`UPDATE gad_blobs SET created_at = ?`, PAST_GRACE);
    sql.exec(`UPDATE gad_worktree_states SET created_at = ?`, PAST_GRACE);

    const mark = await call<{ liveBlobDigests: string[] }>("runGadGcMark");
    expect(mark.liveBlobDigests).toContain("blob:committed");
    const swept = await call<{ digests: string[] }>("runGadGcSweep", { minAgeMs: 0 });
    expect(swept.digests).not.toContain("blob:committed");
  });

  it("protects newly staged worktree states during the creation grace window", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const staged = await call<{ stateHash: string }>("stageWorktreeState", {
      files: [{ path: "merged.txt", contentHash: "blob:staged-young", size: 6 }],
      summary: "merge staging",
    });

    await call("runGadGcMark");
    const states = await call<{ rows: Array<{ state_hash: string }> }>(
      "query",
      "SELECT state_hash FROM gad_worktree_states WHERE state_hash = ?",
      [staged.stateHash]
    );
    expect(states.rows).toHaveLength(1);
  });

  it("sweeps aged staged worktree states that were never referenced", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);
    const staged = await call<{ stateHash: string }>("stageWorktreeState", {
      files: [{ path: "merged.txt", contentHash: "blob:staged", size: 6 }],
      summary: "merge staging",
    });
    // Backdate every value past the creation grace window: staged metadata
    // alone is not a permanent root.
    for (const table of [
      "gad_worktree_states",
      "gad_blobs",
      "gad_manifest_nodes",
      "gad_file_versions",
    ]) {
      sql.exec(`UPDATE ${table} SET created_at = ?`, PAST_GRACE);
    }

    await call("runGadGcMark");
    const swept = await call<{ digests: string[] }>("runGadGcSweep", { minAgeMs: 0 });
    expect(swept.digests).toEqual(["blob:staged"]);

    const states = await call<{ rows: Array<{ state_hash: string }> }>(
      "query",
      "SELECT state_hash FROM gad_worktree_states WHERE state_hash = ?",
      [staged.stateHash]
    );
    expect(states.rows).toHaveLength(0);
  });

  it("never sweeps blobs younger than the creation grace period", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);
    await call("ensureBlob", "blob:orphan-young", 1);
    await call("ensureBlob", "blob:orphan-old", 1);
    sql.exec(`UPDATE gad_blobs SET created_at = ? WHERE hash = ?`, PAST_GRACE, "blob:orphan-old");

    await call("runGadGcMark");
    const swept = await call<{ digests: string[] }>("runGadGcSweep", { minAgeMs: 0 });
    expect(swept.digests).toEqual(["blob:orphan-old"]);

    const remaining = await call<{ rows: Array<{ hash: string }> }>(
      "query",
      "SELECT hash FROM gad_blobs WHERE hash LIKE 'blob:orphan-%'",
      []
    );
    expect(remaining.rows.map((row) => row.hash)).toEqual(["blob:orphan-young"]);
  });
});

describe("per-repo state primitives (W1)", () => {
  async function seedRepo(call: any, repoPath: string, contentHash: string, eventId: string) {
    return call("ingestWorktreeState", {
      files: [{ path: "x", contentHash, size: 1, mode: 420 }],
      logId: `vcs:repo:${repoPath}`,
      head: "main",
      actor: owner,
      eventId,
    });
  }

  it("ref-owned main ingest accepts a KNOWN non-head predecessor (follower/reconciler recording)", async () => {
    // P5a: `vcs:repo:* @ main` is owned by the server's protected-ref store;
    // this DO records transitions as downstream provenance (often after the
    // fact). The old strict head CAS would reject a legitimate recording
    // whenever the store lags the ref — so for main, expectedRefStateHash is
    // a KNOWN-PREDECESSOR guard: any state this store has recorded is an
    // acceptable claimed base, only unknown lineage rejects.
    const { call } = await createTestDO(GadWorkspaceDO);
    const s0 = await seedRepo(call, "packages/known", "blob:known-0", "known-0");
    const s1 = await call<any>("ingestWorktreeState", {
      files: [{ path: "x", contentHash: "blob:known-1", size: 1, mode: 420 }],
      logId: "vcs:repo:packages/known",
      head: "main",
      actor: owner,
      eventId: "known-1",
      expectedRefStateHash: s0.stateHash,
    });
    // Claimed base = s0 (known, but NOT the current head s1) → accepted.
    const s2 = await call<any>("ingestWorktreeState", {
      files: [{ path: "x", contentHash: "blob:known-2", size: 1, mode: 420 }],
      logId: "vcs:repo:packages/known",
      head: "main",
      actor: owner,
      eventId: "known-2",
      baseStateHash: s0.stateHash,
      expectedRefStateHash: s0.stateHash,
    });
    expect(s2.stateHash).not.toBe(s1.stateHash);
    const head = await call<any>("resolveWorktreeHead", {
      logId: "vcs:repo:packages/known",
      head: "main",
    });
    expect(head).toMatchObject({ stateHash: s2.stateHash });
    // The recorded transition attaches to the CLAIMED base, honestly.
    const transition = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT input_state_hash FROM gad_state_transitions WHERE event_id = ?",
      ["known-2"]
    );
    expect(transition.rows[0]?.["input_state_hash"]).toBe(s0.stateHash);

    // Non-main heads remain store-authoritative: strict CAS still applies.
    await expect(
      call("ingestWorktreeState", {
        files: [{ path: "x", contentHash: "blob:known-3", size: 1, mode: 420 }],
        logId: "vcs:repo:packages/known",
        head: "ctx:someone",
        actor: owner,
        eventId: "known-3",
        expectedRefStateHash: s0.stateHash,
      })
    ).rejects.toThrow(/CAS conflict/);
  });

  it("ingestRepoGroup advances all heads in one transaction", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const foo0 = await seedRepo(call, "packages/foo", "blob:foo-0", "foo-0");
    const bar0 = await seedRepo(call, "panels/bar", "blob:bar-0", "bar-0");

    const group = await call<any>("ingestRepoGroup", {
      entries: [
        {
          files: [{ path: "x", contentHash: "blob:foo-1", size: 1, mode: 420 }],
          logId: "vcs:repo:packages/foo",
          head: "main",
          actor: owner,
          eventId: "foo-1",
          expectedRefStateHash: foo0.stateHash,
        },
        {
          files: [{ path: "x", contentHash: "blob:bar-1", size: 1, mode: 420 }],
          logId: "vcs:repo:panels/bar",
          head: "main",
          actor: owner,
          eventId: "bar-1",
          expectedRefStateHash: bar0.stateHash,
        },
      ],
    });
    expect(group.results).toHaveLength(2);

    const fooFiles = await call<any[]>("listGadBranchFiles", {
      trajectoryId: "vcs:repo:packages/foo",
      branchId: "main",
    });
    expect(fooFiles.map((f: any) => f.content_hash)).toEqual(["blob:foo-1"]);
    const barFiles = await call<any[]>("listGadBranchFiles", {
      trajectoryId: "vcs:repo:panels/bar",
      branchId: "main",
    });
    expect(barFiles.map((f: any) => f.content_hash)).toEqual(["blob:bar-1"]);
  });

  it("ingestRepoGroup is all-or-none: a stale CAS on one entry leaves every head unchanged", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const foo0 = await seedRepo(call, "packages/foo", "blob:foo-0", "foo-0");
    await seedRepo(call, "panels/bar", "blob:bar-0", "bar-0");

    await expect(
      call("ingestRepoGroup", {
        entries: [
          {
            files: [{ path: "x", contentHash: "blob:foo-1", size: 1, mode: 420 }],
            logId: "vcs:repo:packages/foo",
            head: "main",
            actor: owner,
            eventId: "foo-x",
            expectedRefStateHash: foo0.stateHash,
          },
          {
            files: [{ path: "x", contentHash: "blob:bar-1", size: 1, mode: 420 }],
            logId: "vcs:repo:panels/bar",
            head: "main",
            actor: owner,
            eventId: "bar-x",
            // Ref-owned main heads (P5a): the strict CAS became a known-
            // predecessor guard — a claimed base this store never recorded is
            // genuinely inconsistent and still rejects the whole group.
            expectedRefStateHash: "state:stale-bogus",
          },
        ],
      })
    ).rejects.toThrow(/unknown predecessor/);

    // Neither head advanced — both still hold their seeded content.
    const fooFiles = await call<any[]>("listGadBranchFiles", {
      trajectoryId: "vcs:repo:packages/foo",
      branchId: "main",
    });
    expect(fooFiles.map((f: any) => f.content_hash)).toEqual(["blob:foo-0"]);
    const barFiles = await call<any[]>("listGadBranchFiles", {
      trajectoryId: "vcs:repo:panels/bar",
      branchId: "main",
    });
    expect(barFiles.map((f: any) => f.content_hash)).toEqual(["blob:bar-0"]);
  });
});

describe("computeMerge (P5b — userland merge semantics)", () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /** Shadow the DO's protected `contentStore()` seam with an in-memory
   *  content store (the test harness has no RPC gateway to the host
   *  blobstore). Mirrors the `blobstore.*` slice the MERGE engine uses;
   *  the P5c edit/commit composition has its own full-fidelity memory store
   *  in gadStoreVcs.test.ts. */
  function stubContentStore(instance: GadWorkspaceDO) {
    const blobs = new Map<string, Uint8Array>();
    const trees = new Map<
      string,
      Array<{ path: string; kind: string; contentHash: string; mode: number }>
    >();
    let n = 0;
    const store = {
      async listTree(ref: string) {
        return trees.get(ref) ?? null;
      },
      async getTree(ref: string) {
        return trees.get(ref) ?? null;
      },
      async getBase64(digest: string) {
        const bytes = blobs.get(digest);
        return bytes ? btoa(String.fromCharCode(...bytes)) : null;
      },
      async putBase64(bytesBase64: string) {
        const binary = atob(bytesBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const digest = `merged-${(n += 1)}`;
        blobs.set(digest, bytes);
        return { digest, size: bytes.length };
      },
      async putTree(): Promise<{ treeHash: string; stateHash?: string }> {
        throw new Error("merge tests never mirror trees");
      },
    };
    Object.defineProperty(instance, "contentStore", { value: () => store });
    return {
      blobs,
      trees,
      putText(text: string): string {
        const digest = `text-${(n += 1)}`;
        blobs.set(digest, enc.encode(text));
        return digest;
      },
      textOf(digest: string): string {
        const bytes = blobs.get(digest);
        if (!bytes) throw new Error(`no blob ${digest}`);
        return dec.decode(bytes);
      },
    };
  }

  /** Ingest base → tip on one repo log so the transition DAG carries the
   *  ancestry both merge sides share. */
  async function ingestLineage(
    call: <T>(method: string, ...args: unknown[]) => Promise<T>,
    logId: string,
    baseFiles: Array<{ path: string; contentHash: string; mode?: number }>,
    tipFiles: Array<{ path: string; contentHash: string; mode?: number }>,
    tag: string
  ): Promise<{ base: string; tip: string }> {
    const base = await call<{ stateHash: string }>("ingestWorktreeState", {
      files: baseFiles.map((f) => ({ size: 1, mode: 420, ...f })),
      logId,
      head: "main",
      actor: owner,
      eventId: `${tag}-base`,
    });
    const tip = await call<{ stateHash: string }>("ingestWorktreeState", {
      files: tipFiles.map((f) => ({ size: 1, mode: 420, ...f })),
      logId,
      head: "main",
      actor: owner,
      eventId: `${tag}-tip`,
    });
    return { base: base.stateHash, tip: tip.stateHash };
  }

  it("computes a clean diff3 merge over DO-recorded states, writing the merged blob", async () => {
    const gad = await createTestDO(GadWorkspaceDO);
    const cas = stubContentStore(gad.instance);
    const baseHash = cas.putText("line1\nline2\nline3\n");
    const oursHash = cas.putText("OURS\nline2\nline3\n");
    const theirsHash = cas.putText("line1\nline2\nTHEIRS\n");

    // Two logs sharing the identical base state → getMergeBase finds it.
    const ours = await ingestLineage(
      gad.call,
      "vcs:repo:panels/a",
      [{ path: "shared.txt", contentHash: baseHash }],
      [{ path: "shared.txt", contentHash: oursHash }],
      "ours"
    );
    const theirs = await ingestLineage(
      gad.call,
      "vcs:repo:panels/b",
      [{ path: "shared.txt", contentHash: baseHash }],
      [{ path: "shared.txt", contentHash: theirsHash }],
      "theirs"
    );
    expect(ours.base).toBe(theirs.base);

    const result = await gad.call<any>("computeMerge", {
      oursStateHash: ours.tip,
      theirsStateHash: theirs.tip,
      labels: { ours: "ctx:one", theirs: "main" },
    });
    expect(result.status).toBe("clean");
    expect(result.baseStateHash).toBe(ours.base);
    expect(result.conflicts).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(cas.textOf(result.files[0].contentHash)).toBe("OURS\nline2\nTHEIRS\n");
  });

  it("labels conflict markers with the caller-supplied head names", async () => {
    const gad = await createTestDO(GadWorkspaceDO);
    const cas = stubContentStore(gad.instance);
    const baseHash = cas.putText("line1\nline2\n");
    const oursHash = cas.putText("OURS\nline2\n");
    const theirsHash = cas.putText("THEIRS\nline2\n");
    const ours = await ingestLineage(
      gad.call,
      "vcs:repo:panels/a",
      [{ path: "shared.txt", contentHash: baseHash }],
      [{ path: "shared.txt", contentHash: oursHash }],
      "ours"
    );
    const theirs = await ingestLineage(
      gad.call,
      "vcs:repo:panels/b",
      [{ path: "shared.txt", contentHash: baseHash }],
      [{ path: "shared.txt", contentHash: theirsHash }],
      "theirs"
    );

    const result = await gad.call<any>("computeMerge", {
      oursStateHash: ours.tip,
      theirsStateHash: theirs.tip,
      labels: { ours: "ctx:one", theirs: "main" },
    });
    expect(result.status).toBe("conflicted");
    expect(result.conflicts).toEqual([{ path: "shared.txt", kind: "content" }]);
    const merged = cas.textOf(result.files[0].contentHash);
    expect(merged).toContain("<<<<<<< ctx:one");
    expect(merged).toContain(">>>>>>> main");
  });

  it("falls back to the content store's mirrored tree for states this store never recorded", async () => {
    const gad = await createTestDO(GadWorkspaceDO);
    const cas = stubContentStore(gad.instance);
    const baseHash = cas.putText("a\n");
    const ours = await ingestLineage(
      gad.call,
      "vcs:repo:panels/a",
      [{ path: "f.txt", contentHash: baseHash }],
      [
        { path: "f.txt", contentHash: baseHash },
        { path: "ours.txt", contentHash: cas.putText("o\n") },
      ],
      "ours"
    );
    // `theirs` is a server-minted state: unknown to the DO, mirrored in the
    // content store only. Unrelated lineage → merges from the empty base.
    const theirsState = `state:${"e".repeat(64)}`;
    cas.trees.set(theirsState, [
      { path: "f.txt", kind: "file", contentHash: baseHash, mode: 420 },
      { path: "theirs.txt", kind: "file", contentHash: cas.putText("t\n"), mode: 420 },
    ]);

    const result = await gad.call<any>("computeMerge", {
      oursStateHash: ours.tip,
      theirsStateHash: theirsState,
      labels: { ours: "ctx:one", theirs: "main" },
    });
    // Unrelated histories (null base): f.txt identical on both sides, each
    // side's addition taken — a clean union.
    expect(result.status).toBe("clean");
    expect(result.files.map((f: any) => f.path).sort()).toEqual([
      "f.txt",
      "ours.txt",
      "theirs.txt",
    ]);

    // A state neither recorded nor mirrored fails loudly.
    await expect(
      gad.call("computeMerge", {
        oursStateHash: ours.tip,
        theirsStateHash: `state:${"f".repeat(64)}`,
        labels: { ours: "a", theirs: "b" },
      })
    ).rejects.toThrow(/unknown worktree state/);
  });
});

describe("knowledge ledger + claims (§8.1)", () => {
  it("records a claim through the durable ledger and projects gad_claims + FTS", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const res = await call<{
      claimId?: string;
      ledgerEntryId?: string;
      duplicates: Array<{ claimId: string; text: string; score: number }>;
    }>("knowledgeRecordClaim", {
      logId: "traj-1",
      head: "main",
      invocationId: "inv-1",
      claim: {
        text: "The gad store owns all VCS semantics",
        subject: "gad-store",
        predicate: "owns",
        object: "vcs semantics",
      },
    });
    expect(res.claimId).toBeTruthy();
    expect(res.ledgerEntryId).toBeTruthy();
    expect(res.duplicates).toEqual([]);

    const ledger = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT entry_id, kind, seq FROM gad_knowledge_ledger",
      []
    );
    expect(ledger.rows.length).toBe(1);
    expect(ledger.rows[0]).toEqual(
      expect.objectContaining({ entry_id: res.ledgerEntryId, kind: "claim_recorded", seq: 1 })
    );

    const claims = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT claim_id, text, subject, predicate, object, status, ledger_entry_id, trajectory_event_id, invocation_id FROM gad_claims",
      []
    );
    expect(claims.rows.length).toBe(1);
    expect(claims.rows[0]).toEqual(
      expect.objectContaining({
        claim_id: res.claimId,
        text: "The gad store owns all VCS semantics",
        subject: "gad-store",
        predicate: "owns",
        object: "vcs semantics",
        status: "active",
        ledger_entry_id: res.ledgerEntryId,
        invocation_id: "inv-1",
      })
    );
    // trajectory_event_id is the (pre-minted) knowledge event's envelope id.
    expect(claims.rows[0]?.["trajectory_event_id"]).toBeTruthy();

    const recall = await call<{ results: Array<{ anchor: Record<string, unknown> | null }> }>(
      "recallMemory",
      { query: "vcs semantics", kinds: ["claim"] }
    );
    expect(recall.results.some((r) => r.anchor?.["claimId"] === res.claimId)).toBe(true);

    const metrics = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT metric, bucket, count FROM gad_prov_metrics",
      []
    );
    expect(metrics.rows).toContainEqual(
      expect.objectContaining({ metric: "claims_recorded", bucket: "standalone", count: 1 })
    );
  });

  it("survives a schema bump: the ledger is exempt from the drop and re-projects claims + relations", async () => {
    const first = await createTestDO(GadWorkspaceDO);
    const c1 = await first.call<{ claimId?: string }>("knowledgeRecordClaim", {
      logId: "traj-1",
      head: "main",
      claim: { text: "durable claim one that outlives the era" },
    });
    const c2 = await first.call<{ claimId?: string }>("knowledgeRecordClaim", {
      logId: "traj-1",
      head: "main",
      claim: { text: "durable claim two, unrelated words entirely" },
    });
    await first.call("knowledgeRelateClaims", {
      logId: "traj-1",
      head: "main",
      relations: [{ src: c1.claimId, relation: "contradicts", dst: c2.claimId }],
    });

    // Stamp an older schema version so reopening the same storage migrates
    // (drop projections + recreate) — the big-bang "last wipe".
    first.db.run("UPDATE state SET value = '24' WHERE key = 'schema_version'");
    const second = await createTestDO(GadWorkspaceDO, undefined, { db: first.db });

    const version = await second.call<{ rows: Array<{ value: string }> }>(
      "query",
      "SELECT value FROM state WHERE key = 'schema_version'",
      []
    );
    expect(version.rows[0]?.value).toBe("25");

    // The ledger survived the gad_% drop sweep.
    const ledger = await second.call<{ rows: Array<{ kind: string }> }>(
      "query",
      "SELECT kind FROM gad_knowledge_ledger ORDER BY seq",
      []
    );
    expect(ledger.rows.map((r) => r.kind)).toEqual([
      "claim_recorded",
      "claim_recorded",
      "claims_related",
    ]);

    // gad_claims was dropped and rebuilt purely by replaying the ledger.
    const claims = await second.call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT claim_id, text FROM gad_claims ORDER BY text",
      []
    );
    expect(claims.rows.map((r) => r["claim_id"])).toEqual([c1.claimId, c2.claimId]);

    // And so was the relation.
    const relations = await second.call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT src_claim_id, relation, dst_claim_id FROM gad_claim_relations",
      []
    );
    expect(relations.rows).toEqual([
      expect.objectContaining({
        src_claim_id: c1.claimId,
        relation: "contradicts",
        dst_claim_id: c2.claimId,
      }),
    ]);

    // A later full rebuild must NOT lose the ledger-only claims: post-bump the
    // trajectory events are gone, so the replay leans on the ledger for claims.
    await second.call("rebuildTrajectoryProjections", {});
    const afterReplay = await second.call<{ rows: Array<{ n: number }> }>(
      "query",
      "SELECT COUNT(*) AS n FROM gad_claims",
      []
    );
    expect(afterReplay.rows[0]?.n).toBe(2);
    const relAfterReplay = await second.call<{ rows: Array<{ n: number }> }>(
      "query",
      "SELECT COUNT(*) AS n FROM gad_claim_relations",
      []
    );
    expect(relAfterReplay.rows[0]?.n).toBe(1);
  });

  it("dedups on write: near-duplicates return candidates without recording unless forced", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const first = await call<{ claimId?: string }>("knowledgeRecordClaim", {
      logId: "traj-1",
      head: "main",
      claim: { text: "system uses log events for provenance" },
    });
    expect(first.claimId).toBeTruthy();

    const dup = await call<{
      claimId?: string;
      duplicates: Array<{ claimId: string; score: number }>;
    }>("knowledgeRecordClaim", {
      logId: "traj-1",
      head: "main",
      claim: { text: "system uses log events for provenance" },
    });
    expect(dup.claimId).toBeUndefined();
    expect(dup.duplicates.length).toBeGreaterThan(0);
    expect(dup.duplicates[0]?.claimId).toBe(first.claimId);
    expect(dup.duplicates[0]?.score).toBeGreaterThanOrEqual(0.6);

    const afterSkip = await call<{ rows: Array<{ n: number }> }>(
      "query",
      "SELECT COUNT(*) AS n FROM gad_claims",
      []
    );
    expect(afterSkip.rows[0]?.n).toBe(1);

    const forced = await call<{ claimId?: string }>("knowledgeRecordClaim", {
      logId: "traj-1",
      head: "main",
      claim: { text: "system uses log events for provenance" },
      force: true,
    });
    expect(forced.claimId).toBeTruthy();
    const afterForce = await call<{ rows: Array<{ n: number }> }>(
      "query",
      "SELECT COUNT(*) AS n FROM gad_claims",
      []
    );
    expect(afterForce.rows[0]?.n).toBe(2);
  });

  it("projects claims_related and dedups it across replay + a fork fold", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const c1 = await call<{ claimId?: string }>("knowledgeRecordClaim", {
      logId: "traj-1",
      head: "main",
      claim: { text: "claim one about apples and orchards" },
    });
    const c2 = await call<{ claimId?: string }>("knowledgeRecordClaim", {
      logId: "traj-1",
      head: "main",
      claim: { text: "claim two about oranges and groves" },
    });
    const rel = await call<{ ledgerEntryId: string; related: number }>("knowledgeRelateClaims", {
      logId: "traj-1",
      head: "main",
      invocationId: "inv-rel",
      relations: [{ src: c1.claimId, relation: "contradicts", dst: c2.claimId, weight: 3 }],
    });
    expect(rel.related).toBe(1);

    let rows = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT event_id, src_claim_id, relation, dst_claim_id, weight FROM gad_claim_relations",
      []
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]).toEqual(
      expect.objectContaining({
        src_claim_id: c1.claimId,
        relation: "contradicts",
        dst_claim_id: c2.claimId,
        weight: 3,
      })
    );

    // Fork the whole trajectory at its tip so the fork inherits the relate event.
    const tip = await call<{ rows: Array<{ n: number }> }>(
      "query",
      "SELECT MAX(seq) AS n FROM log_events WHERE log_id = ? AND head = ?",
      ["traj-1", "main"]
    );
    await call("forkLog", {
      fromLogId: "traj-1",
      fromHead: "main",
      toLogId: "traj-1",
      toHead: "ctx:fork",
      atSeq: tip.rows[0]?.n,
      owner,
    });

    // Replay projects the SAME relate event under both heads; the unique
    // identity + INSERT OR IGNORE keeps exactly one relation row.
    await call("rebuildTrajectoryProjections", {});
    rows = await call<{ rows: Array<{ n: number }> }>(
      "query",
      "SELECT COUNT(*) AS n FROM gad_claim_relations",
      []
    );
    expect(rows.rows[0]?.["n"]).toBe(1);
    // Claims dedup by claim_id across the fold too.
    const claims = await call<{ rows: Array<{ n: number }> }>(
      "query",
      "SELECT COUNT(*) AS n FROM gad_claims",
      []
    );
    expect(claims.rows[0]?.n).toBe(2);
  });

  it("projects a directly-appended knowledge.claims_related event (registration + inline fallback)", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-x",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "rel-ev-1",
          event: event("knowledge.claims_related", {
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              relations: [{ src: "claim-a", relation: "supports", dst: "claim-b", weight: 2 }],
            },
          }),
        },
      ],
    });
    const rows = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT event_id, src_claim_id, relation, dst_claim_id, weight FROM gad_claim_relations",
      []
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        event_id: "rel-ev-1",
        src_claim_id: "claim-a",
        relation: "supports",
        dst_claim_id: "claim-b",
        weight: 2,
      }),
    ]);
  });

  it("snapshots the anchor (repo, commit message, actor, time) and buckets commit-borne claims", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);
    // Seed a commit transition so the anchor resolves the message's first line.
    sql.exec(
      "INSERT INTO gad_state_transitions (event_id, input_state_hash, output_state_hash, summary, created_at) VALUES (?, ?, ?, ?, ?)",
      "commit-ev-1",
      "state:in",
      "state:out",
      "Fix the parser\n\nlong body text that is not the first line",
      "2026-05-20T12:00:00.000Z"
    );
    const rec = await call<{ ledgerEntryId?: string }>("knowledgeRecordClaim", {
      logId: "traj-1",
      head: "main",
      claim: { text: "the parser now handles trailing newlines" },
      anchor: { commitEventId: "commit-ev-1", repoPath: "packages/parser" },
    });
    const ledger = await call<{ rows: Array<{ anchor_json: string }> }>(
      "query",
      "SELECT anchor_json FROM gad_knowledge_ledger WHERE entry_id = ?",
      [rec.ledgerEntryId]
    );
    const anchor = JSON.parse(ledger.rows[0]!.anchor_json) as Record<string, unknown>;
    expect(anchor["repoPath"]).toBe("packages/parser");
    expect(anchor["commitEventId"]).toBe("commit-ev-1");
    expect(anchor["commitMessage"]).toBe("Fix the parser");
    expect(typeof anchor["actorLabel"]).toBe("string");
    expect(typeof anchor["recordedAt"]).toBe("string");

    const metrics = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT metric, bucket, count FROM gad_prov_metrics",
      []
    );
    expect(metrics.rows).toContainEqual(
      expect.objectContaining({ metric: "claims_recorded", bucket: "commit", count: 1 })
    );
  });

  it("revises and retracts a claim through the ledger", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const rec = await call<{ claimId: string }>("knowledgeRecordClaim", {
      logId: "traj-1",
      head: "main",
      claim: { subject: "parser", predicate: "handles", object: "newlines" },
    });
    const revised = await call<{ ledgerEntryId: string }>("knowledgeReviseClaim", {
      logId: "traj-1",
      head: "main",
      claimId: rec.claimId,
      patch: { object: "trailing newlines", kind: "statement" },
    });
    let claims = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT subject, predicate, object, claim_kind, status, ledger_entry_id FROM gad_claims WHERE claim_id = ?",
      [rec.claimId]
    );
    expect(claims.rows[0]).toEqual(
      expect.objectContaining({
        subject: "parser",
        predicate: "handles",
        object: "trailing newlines",
        claim_kind: "statement",
        status: "active",
        ledger_entry_id: revised.ledgerEntryId,
      })
    );

    const retracted = await call<{ ledgerEntryId: string }>("knowledgeRetractClaim", {
      logId: "traj-1",
      head: "main",
      claimId: rec.claimId,
    });
    claims = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT status, ledger_entry_id FROM gad_claims WHERE claim_id = ?",
      [rec.claimId]
    );
    expect(claims.rows[0]?.["status"]).toBe("retracted");
    // Retract is status-only: the content pointer stays on the revise entry,
    // never the retract entry.
    expect(claims.rows[0]?.["ledger_entry_id"]).toBe(revised.ledgerEntryId);
    expect(claims.rows[0]?.["ledger_entry_id"]).not.toBe(retracted.ledgerEntryId);

    const ledger = await call<{ rows: Array<{ kind: string }> }>(
      "query",
      "SELECT kind FROM gad_knowledge_ledger ORDER BY seq",
      []
    );
    expect(ledger.rows.map((r) => r.kind)).toEqual([
      "claim_recorded",
      "claim_revised",
      "claim_retracted",
    ]);
  });

  it("retracting a claim drops its FTS row so dedup + recall stop surfacing it (cl-1)", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const rec = await call<{ claimId: string }>("knowledgeRecordClaim", {
      logId: "traj-1",
      head: "main",
      claim: { text: "the parser handles trailing newlines" },
    });
    expect(rec.claimId).toBeTruthy();

    // Before retract: recall surfaces it and the identical text is a dedup block.
    const recallBefore = await call<{
      results: Array<{ anchor: Record<string, unknown> | null }>;
    }>("recallMemory", { query: "the parser handles trailing newlines", kinds: ["claim"] });
    expect(recallBefore.results.some((r) => r.anchor?.["claimId"] === rec.claimId)).toBe(true);

    await call("knowledgeRetractClaim", {
      logId: "traj-1",
      head: "main",
      claimId: rec.claimId,
    });

    // The claim's FTS row is gone (structural leg already filtered; FTS did not).
    const fts = await call<{ rows: Array<{ n: number }> }>(
      "query",
      "SELECT COUNT(*) AS n FROM gad_memory_fts WHERE kind = 'claim' AND anchor_json = ?",
      [JSON.stringify({ claimId: rec.claimId })]
    );
    expect(fts.rows[0]?.n).toBe(0);

    // Recall no longer surfaces the retracted (dead) claim.
    const recallAfter = await call<{
      results: Array<{ anchor: Record<string, unknown> | null }>;
    }>("recallMemory", { query: "the parser handles trailing newlines", kinds: ["claim"] });
    expect(recallAfter.results.some((r) => r.anchor?.["claimId"] === rec.claimId)).toBe(false);

    // Dedup-on-write no longer blocks a re-record against the dead claim: the
    // corrected claim records instead of being pointed at the retracted one.
    const corrected = await call<{
      claimId?: string;
      duplicates: Array<{ claimId: string }>;
    }>("knowledgeRecordClaim", {
      logId: "traj-1",
      head: "main",
      claim: { text: "the parser handles trailing newlines" },
    });
    expect(corrected.duplicates.some((d) => d.claimId === rec.claimId)).toBe(false);
    expect(corrected.claimId).toBeTruthy();
  });

  it("surfaces the anchoring commit on a claim drill-down within its era (cl-2)", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);
    sql.exec(
      "INSERT INTO gad_state_transitions (event_id, input_state_hash, output_state_hash, summary, created_at) VALUES (?, ?, ?, ?, ?)",
      "commit-ev-1",
      "state:in",
      "state:out",
      "Fix the parser\n\nlong body that is not the first line",
      "2026-05-20T12:00:00.000Z"
    );
    const rec = await call<{ claimId: string }>("knowledgeRecordClaim", {
      logId: "traj-1",
      head: "main",
      claim: { text: "the parser now handles trailing newlines" },
      anchor: { commitEventId: "commit-ev-1", repoPath: "packages/parser" },
    });
    const res = await call<{
      items: Array<{ line: string; handle: string; kind: string }>;
    }>("provenanceForClaim", {
      claimId: rec.claimId,
      sessionLogId: "traj-1",
      sessionHead: "main",
    });
    const commit = res.items.find((i) => i.kind === "commit");
    expect(commit).toBeDefined();
    expect(commit!.line).toContain("commit c:commit-e");
    expect(commit!.line).toContain("Fix the parser");
    expect(commit!.handle).toBe("commit:commit-e");
  });

  it("degrades a claim drill-down to the stored ledger snapshot (marked historical) after a schema bump (cl-2)", async () => {
    const first = await createTestDO(GadWorkspaceDO);
    first.sql.exec(
      "INSERT INTO gad_state_transitions (event_id, input_state_hash, output_state_hash, summary, created_at) VALUES (?, ?, ?, ?, ?)",
      "commit-ev-1",
      "state:in",
      "state:out",
      "Fix the parser\n\nbody",
      "2026-05-20T12:00:00.000Z"
    );
    const rec = await first.call<{ claimId: string }>("knowledgeRecordClaim", {
      logId: "traj-1",
      head: "main",
      claim: { text: "durable claim carried by a commit anchor" },
      anchor: { commitEventId: "commit-ev-1", repoPath: "packages/parser" },
    });

    // Big-bang schema bump: the trajectory events (log_%) are dropped and the
    // ledger re-projects gad_claims with a now-dangling trajectory_event_id.
    first.db.run("UPDATE state SET value = '24' WHERE key = 'schema_version'");
    const second = await createTestDO(GadWorkspaceDO, undefined, { db: first.db });

    // The causality event is gone, so the trajectory join is empty (post-era).
    const events = await second.call<{ rows: Array<{ n: number }> }>(
      "query",
      "SELECT COUNT(*) AS n FROM log_events",
      []
    );
    expect(events.rows[0]?.n).toBe(0);

    const res = await second.call<{ items: Array<{ line: string; kind: string }> }>(
      "provenanceForClaim",
      { claimId: rec.claimId, sessionLogId: "traj-1", sessionHead: "main" }
    );
    const historical = res.items.find((i) => i.kind === "historical");
    expect(historical).toBeDefined();
    expect(historical!.line).toContain("historical");
    expect(historical!.line).toContain("Fix the parser");
    expect(historical!.line).toContain("packages/parser");
  });

  it("stamps a per-branch turn ordinal on turn.opened", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "t1",
          event: event("turn.opened", {
            turnId: "turn-1" as never,
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "a" },
          }),
        },
        {
          eventId: "t2",
          event: event("turn.opened", {
            turnId: "turn-2" as never,
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "b" },
          }),
        },
      ],
    });
    const rows = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT turn_id, ordinal FROM trajectory_turns ORDER BY ordinal",
      []
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({ turn_id: "turn-1", ordinal: 0 }),
      expect.objectContaining({ turn_id: "turn-2", ordinal: 1 }),
    ]);
  });

  it("gates the knowledge RPCs to do/server/shell/worker callers", async () => {
    const { callAs } = await createTestDO(GadWorkspaceDO);
    const ok = await callAs<{ claimId?: string }>("shell", "knowledgeRecordClaim", {
      logId: "traj-1",
      head: "main",
      claim: { text: "shell may record claims" },
    });
    expect(ok.claimId).toBeTruthy();

    await expect(
      callAs("panel", "knowledgeRecordClaim", {
        logId: "traj-1",
        head: "main",
        claim: { text: "panel may not record claims" },
      })
    ).rejects.toThrow();
  });
});
