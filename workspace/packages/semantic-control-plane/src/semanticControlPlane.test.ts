import { describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { AgentHealthInspectionSchema } from "@workspace/runtime/gad-schema";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  GENESIS_EVENT_HASH,
  type AgenticEvent,
} from "@workspace/agentic-protocol";
import { GadWorkspaceDO } from "./index.js";

const owner = { kind: "agent" as const, id: "agent-1" };
const GENESIS = GENESIS_EVENT_HASH;

function setVerifiedCaller(instance: GadWorkspaceDO, userId: string | null): void {
  const internal = instance as unknown as {
    _currentRpcCallerId: string | null;
    _currentRpcCallerKind: string | null;
    _currentVerifiedCaller: unknown;
  };
  internal._currentRpcCallerId = userId ? "shell" : null;
  internal._currentRpcCallerKind = userId ? "shell" : null;
  internal._currentVerifiedCaller = userId
    ? { callerId: "shell", callerKind: "shell", userId }
    : null;
}

function setDoCaller(instance: GadWorkspaceDO, channelId: string): void {
  const callerId = `do:workers/pubsub-channel:PubSubChannel:${channelId}`;
  const internal = instance as unknown as {
    _currentRpcCallerId: string | null;
    _currentRpcCallerKind: string | null;
    _currentVerifiedCaller: unknown;
  };
  internal._currentRpcCallerId = callerId;
  internal._currentRpcCallerKind = "do";
  internal._currentVerifiedCaller = { callerId, callerKind: "do" };
}

function setServerCaller(instance: GadWorkspaceDO): void {
  const internal = instance as unknown as {
    _currentRpcCallerId: string | null;
    _currentRpcCallerKind: string | null;
    _currentVerifiedCaller: unknown;
  };
  internal._currentRpcCallerId = "server";
  internal._currentRpcCallerKind = "server";
  internal._currentVerifiedCaller = { callerId: "server", callerKind: "server" };
}

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
    protocol: "vibestudio.blob-ref.v1" as const,
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
    handle: "alice",
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

interface TrajectoryEventFixture {
  event: AgenticEvent;
  eventId?: string | null;
  publish?: { channelIds: string[]; audience?: unknown } | null;
}

/** Append agentic fixtures through the canonical unified-log RPC. */
async function appendTrajectoryEvents<T = any>(
  call: <R>(method: string, ...args: unknown[]) => Promise<R>,
  input: {
    trajectoryId: string;
    branchId: string;
    owner: { kind: "agent"; id: string; metadata?: Record<string, unknown> };
    expectedHeadHash?: string | null;
    events: TrajectoryEventFixture[];
  }
): Promise<T> {
  return call<T>("appendLogEvent", {
    logId: input.trajectoryId,
    head: input.branchId,
    logKind: "trajectory",
    owner: input.owner,
    ...("expectedHeadHash" in input ? { expectedHeadHash: input.expectedHeadHash ?? null } : {}),
    events: input.events.map((item) => {
      const causality = {
        ...(item.event.causality ?? {}),
        ...(item.event.turnId ? { turnId: item.event.turnId } : {}),
      };
      return {
        envelopeId: item.eventId ?? null,
        actor: item.event.actor,
        payloadKind: item.event.kind,
        payload: item.event.payload,
        ...(Object.keys(causality).length > 0 ? { causality } : {}),
        appendedAt: item.event.createdAt,
        ...(item.publish
          ? {
              publish: {
                channels: item.publish.channelIds.map((channelId) => ({
                  channelId,
                  audience: item.publish?.audience,
                })),
              },
            }
          : {}),
      };
    }),
  });
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

describe("GadWorkspaceDO unified log and semantic VCS schema", () => {
  it("fails closed when topology does not bind a workspace identity", async () => {
    const { instance } = await createTestDO(GadWorkspaceDO, {
      __objectKey: "storage-coordinate-is-not-workspace-identity",
    });
    const semanticWorkspaceId = (
      instance as unknown as { semanticWorkspaceId(): string }
    ).semanticWorkspaceId.bind(instance);

    expect(semanticWorkspaceId).toThrow(
      "GadWorkspaceDO requires the topology-owned WORKSPACE_ID binding"
    );
  });

  it("uses only the topology-owned workspace identity, never the object coordinate", async () => {
    const { instance } = await createTestDO(GadWorkspaceDO, {
      __objectKey: "storage-coordinate",
      WORKSPACE_ID: "ws_authoritative",
    });

    expect((instance as unknown as { semanticWorkspaceId(): string }).semanticWorkspaceId()).toBe(
      "ws_authoritative"
    );
  });

  it("does not self-register its sealed identity through a public runtime RPC", async () => {
    const { instance } = await createTestDO(GadWorkspaceDO);

    // The host's sealed workspace-service declaration owns this singleton's
    // identity and display title. Constructing the storage authority must not
    // open the public service bridge merely to publish duplicate metadata.
    expect((instance as unknown as { _connectionless: unknown })._connectionless).toBeNull();
  });

  // §3.1 — schema shape
  it("creates the canonical semantic graph and leaves no retired VCS infrastructure", async () => {
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
        "refs",
        "ref_log",
        "trajectory_turns",
        "trajectory_messages",
        "trajectory_invocations",
        "channel_message_types",
        "channel_roster",
        "vcs_repositories",
        "vcs_files",
        "vcs_repository_states",
        "vcs_file_states",
        "vcs_file_manifests",
        "vcs_workspace_fact_roots",
        "vcs_contexts",
        "vcs_workspace_heads",
        "gad_workspace_events",
        "gad_workspace_event_parents",
        "gad_workspace_event_applications",
        "gad_work_units",
        "gad_work_unit_applications",
        "gad_changes",
        "gad_applied_changes",
        "gad_applied_change_predicates",
        "gad_content_edges",
        "gad_integration_decisions",
        "vcs_command_journal",
        "gad_effect_intents",
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
      "vcs_workspace_frontiers",
      "vcs_context_frontiers",
      "vcs_workspace_frontier_heads",
      "gad_change_atoms",
      "gad_atom_locations",
      "gad_atom_applications",
      "gad_atom_application_endpoints",
      "gad_semantic_outcomes",
      "gad_outcome_realizations",
      "gad_merge_certificates",
    ]) {
      expect(names).not.toContain(dropped);
    }

    const turnColumns = await call<{ rows: Array<{ name: string }> }>(
      "query",
      "PRAGMA table_info(trajectory_turns)",
      []
    );
    expect(turnColumns.rows.map((row) => row.name)).toContain("trigger_message_id");
    expect(turnColumns.rows.map((row) => row.name)).not.toContain("opened_by_json");
    for (const deadKnowledgeProjection of [
      "gad_claims",
      "gad_claim_relations",
      "gad_knowledge_ledger",
    ]) {
      expect(names).not.toContain(deadKnowledgeProjection);
    }
  });

  it("owns the generic user notification inbox and keys reads to the verified caller", async () => {
    const { instance, sql } = await createTestDO(GadWorkspaceDO);
    setDoCaller(instance, "channel-b");
    instance.putChannelMembership({
      channelId: "channel-b",
      userId: "usr_bob",
      memberId: "user:usr_bob",
      handle: "bob",
      addedBy: "user:usr_alice",
      addedAt: 20,
      revision: 1,
    });
    setDoCaller(instance, "channel-a");
    instance.putChannelMembership({
      channelId: "channel-a",
      userId: "usr_bob",
      memberId: "user:usr_bob",
      handle: "bob",
      addedBy: "user:usr_alice",
      addedAt: 10,
      revision: 1,
    });
    setDoCaller(instance, "channel-private");
    instance.putChannelMembership({
      channelId: "channel-private",
      userId: "usr_charlie",
      memberId: "user:usr_charlie",
      handle: "charlie",
      addedBy: "user:usr_alice",
      addedAt: 30,
      revision: 1,
    });

    setDoCaller(instance, "channel-other");
    expect(() =>
      instance.putChannelMembership({
        channelId: "channel-b",
        userId: "usr_bob",
        memberId: "user:usr_bob",
        handle: "bob",
        addedBy: "user:usr_mallory",
        addedAt: 40,
        revision: 2,
      })
    ).toThrow(/only the owning channel DO/);
    setDoCaller(instance, "channel-b");
    expect(() =>
      instance.putChannelMembership({
        channelId: "channel-b",
        userId: "usr_bob",
        memberId: "user:usr_bob",
        handle: "bob",
        addedBy: "user:usr_alice",
        addedAt: 20,
      } as never)
    ).toThrow(/revision must be a positive safe integer/);

    setVerifiedCaller(instance, "usr_bob");
    expect(instance.listUserNotificationsForMe()).toMatchObject({
      notifications: [
        { id: "channel.invite:channel-b", kind: "channel.invite", userId: "usr_bob" },
        { id: "channel.invite:channel-a", kind: "channel.invite", userId: "usr_bob" },
      ],
    });
    expect(instance.acknowledgeUserNotification({ id: "channel.invite:channel-b" })).toEqual({
      acknowledged: true,
    });
    expect(instance.acknowledgeUserNotification({ id: "channel.invite:channel-b" })).toEqual({
      acknowledged: false,
    });
    setDoCaller(instance, "channel-b");
    expect(
      instance.putChannelMembership({
        channelId: "channel-b",
        userId: "usr_bob",
        memberId: "user:usr_bob",
        handle: "bob",
        addedBy: "user:usr_alice",
        addedAt: 20,
        revision: 1,
      })
    ).toEqual({ applied: false, currentRevision: 1 });
    // A lost-response retry of the already-applied put must not resurrect the
    // pending invite after the user acknowledged it.
    expect(
      sql
        .exec(
          `SELECT 1 FROM user_notifications
            WHERE user_id = 'usr_bob' AND notification_id = 'channel.invite:channel-b'
              AND acknowledged_at IS NULL`
        )
        .toArray()
    ).toEqual([]);
    expect(
      sql
        .exec(`SELECT COUNT(*) AS count FROM user_notifications WHERE acknowledged_at IS NULL`)
        .one()["count"]
    ).toBe(2);
    setServerCaller(instance);
    expect(instance.listChannelMembershipsForUser({ userId: "usr_bob" })).toEqual({
      userId: "usr_bob",
      channelIds: ["channel-a", "channel-b"],
    });
    instance.purgeRevokedUserChannelIndexes({ userId: "usr_bob" });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM user_notifications`).one()["count"]).toBe(1);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM channel_membership_index`).one()["count"]).toBe(
      1
    );

    setVerifiedCaller(instance, null);
    expect(() => instance.listUserNotificationsForMe()).toThrow(/authenticated workspace account/);
    setDoCaller(instance, "bad");
    expect(() =>
      instance.putChannelMembership({
        channelId: "bad",
        userId: "user:usr_bob",
        memberId: "user:usr_bob",
        handle: "bob",
        addedBy: "user:usr_alice",
        addedAt: 1,
        revision: 1,
      })
    ).toThrow(/bare workspace account id/);
  });

  it("stores arbitrary notification kinds durably without exposing them cross-account", async () => {
    const { instance } = await createTestDO(GadWorkspaceDO);
    setDoCaller(instance, "producer");
    expect(
      instance.putUserNotification({
        id: "build:release-42",
        userId: "usr_bob",
        kind: "build.completed",
        title: "Build complete",
        message: "Release 42 is ready.",
        data: { buildId: 42 },
        createdAt: 42,
        revision: 1,
      })
    ).toMatchObject({
      id: "build:release-42",
      kind: "build.completed",
      userId: "usr_bob",
      data: { buildId: 42 },
    });

    setVerifiedCaller(instance, "usr_charlie");
    expect(instance.listUserNotificationsForMe()).toEqual({ notifications: [] });
    setVerifiedCaller(instance, "usr_bob");
    expect(instance.listUserNotificationsForMe()).toMatchObject({
      notifications: [{ id: "build:release-42", title: "Build complete" }],
    });
    expect(instance.acknowledgeUserNotification({ id: "build:release-42" })).toEqual({
      acknowledged: true,
    });
    expect(instance.listUserNotificationsForMe()).toEqual({ notifications: [] });
    setDoCaller(instance, "producer");
    instance.putUserNotification({
      id: "build:release-42",
      userId: "usr_bob",
      kind: "build.completed",
      title: "Build complete",
      message: "Release 42 is ready.",
      data: { buildId: 42 },
      createdAt: 42,
      revision: 1,
    });
    setVerifiedCaller(instance, "usr_bob");
    expect(instance.listUserNotificationsForMe()).toEqual({ notifications: [] });

    setDoCaller(instance, "producer");
    instance.putUserNotification({
      id: "build:release-42",
      userId: "usr_bob",
      kind: "build.completed",
      title: "Build complete again",
      createdAt: 43,
      revision: 2,
    });
    setVerifiedCaller(instance, "usr_bob");
    expect(instance.listUserNotificationsForMe()).toMatchObject({
      notifications: [{ id: "build:release-42", revision: 2 }],
    });

    setDoCaller(instance, "producer");
    expect(() =>
      instance.putUserNotification({
        id: "channel.invite:forged",
        userId: "usr_bob",
        kind: "channel.invite",
        title: "Forged channel invite",
        createdAt: 44,
        revision: 1,
      })
    ).toThrow(/reserved for the revisioned channel membership projection/);
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
    const present = await call<string[]>("hasLogEvents", {
      logId: "traj-core",
      head: "main",
      envelopeIds: ["evt-2", "missing", "evt-1", "evt-2"],
    });
    expect(present.sort()).toEqual(["evt-1", "evt-2"]);
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

  it("skips an identical already-applied event that follows a new one (mid-batch replay)", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const duplicate = {
      envelopeId: "evt-dup",
      actor: owner,
      payloadKind: "message.completed",
      payload: textMessagePayload("msg-dup", "assistant", "landed by the other writer"),
      causality: { turnId: "turn-1", messageId: "msg-dup" },
      appendedAt: "2026-05-20T12:00:00.000Z",
    };
    await call<any>("appendLogEvent", {
      logId: "traj-midbatch",
      head: "main",
      logKind: "trajectory",
      owner,
      events: [duplicate],
    });

    // At-least-once redelivery composes [new, already-applied] — the identical
    // duplicate is skipped, the new event appends, nothing is double-written.
    const result = await call<any>("appendLogEvent", {
      logId: "traj-midbatch",
      head: "main",
      logKind: "trajectory",
      owner,
      events: [
        {
          envelopeId: "evt-new",
          actor: owner,
          payloadKind: "message.completed",
          payload: textMessagePayload("msg-new", "assistant", "genuinely new"),
          causality: { turnId: "turn-1", messageId: "msg-new" },
          appendedAt: "2026-05-20T12:00:01.000Z",
        },
        duplicate,
      ],
    });

    expect(result.envelopes.map((row: { envelopeId: string }) => row.envelopeId)).toEqual([
      "evt-dup",
      "evt-new",
    ]);
    const rows = await call<{ rows: Array<{ envelope_id: string }> }>(
      "query",
      "SELECT envelope_id FROM log_events WHERE log_id = ? AND head = ? ORDER BY seq",
      ["traj-midbatch", "main"]
    );
    expect(rows.rows.map((row) => row.envelope_id)).toEqual(["evt-dup", "evt-new"]);
  });

  it("still rejects a DIVERGENT already-applied event after a new one", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call<any>("appendLogEvent", {
      logId: "traj-midbatch-div",
      head: "main",
      logKind: "trajectory",
      owner,
      events: [
        {
          envelopeId: "evt-dup",
          actor: owner,
          payloadKind: "message.completed",
          payload: textMessagePayload("msg-dup", "assistant", "original content"),
          causality: { turnId: "turn-1", messageId: "msg-dup" },
          appendedAt: "2026-05-20T12:00:00.000Z",
        },
      ],
    });

    await expect(
      call<any>("appendLogEvent", {
        logId: "traj-midbatch-div",
        head: "main",
        logKind: "trajectory",
        owner,
        events: [
          {
            envelopeId: "evt-new",
            actor: owner,
            payloadKind: "message.completed",
            payload: textMessagePayload("msg-new", "assistant", "genuinely new"),
            causality: { turnId: "turn-1", messageId: "msg-new" },
            appendedAt: "2026-05-20T12:00:01.000Z",
          },
          {
            envelopeId: "evt-dup",
            actor: owner,
            payloadKind: "message.completed",
            payload: textMessagePayload("msg-dup", "assistant", "DIFFERENT content"),
            causality: { turnId: "turn-1", messageId: "msg-dup" },
            appendedAt: "2026-05-20T12:00:00.000Z",
          },
        ],
      })
    ).rejects.toThrow(/replay-mismatch.*DIVERGENT/s);
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

describe("trajectory projection invariants", () => {
  it("walks prompting intent through its turn and invocation to the semantic command", async () => {
    const { call, instance } = await createTestDO(GadWorkspaceDO);
    const triggerMessageId = "recv:channel-1:prompt-envelope-1";
    const turnId = "turn-1";
    const invocationId = "invocation-1";

    await appendTrajectoryEvents(call, {
      trajectoryId: "trajectory-1",
      branchId: "main",
      owner,
      events: [
        {
          eventId: triggerMessageId,
          event: event("message.completed", {
            causality: { messageId: triggerMessageId as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              role: "user",
              blocks: [
                {
                  blockId: "prompt-block-1" as never,
                  type: "text",
                  content: "Move the parser without changing its behavior",
                },
              ],
              outcome: "completed",
              sourceMessageId: "channel-message-1",
              senderRef: {
                kind: "user",
                id: "user:alice",
                participantId: "user:alice",
              },
            } as never,
          }),
        },
        {
          eventId: "turn-opened-1",
          event: event("turn.opened", {
            turnId: turnId as never,
            causality: { messageId: triggerMessageId as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION },
          }),
        },
        {
          eventId: "invocation-started-1",
          event: event("invocation.started", {
            turnId: turnId as never,
            causality: { invocationId: invocationId as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              name: "edit",
              request: blobRef("intent-request-1", '{"path":"src/parser.ts"}'),
            },
          }),
        },
      ],
    });

    setServerCaller(instance);
    instance.vcsEnsureContext({
      contextId: "context-1",
      commandId: "command-1",
      ingress: {
        causalParent: {
          kind: "trajectory-invocation",
          logId: "trajectory-1",
          head: "main",
          invocationId,
        },
      },
    });

    const walk = instance.query(
      `SELECT json_extract(message.payload_ref_json, '$.blocks[0].content') AS intent,
              turns.trigger_message_id,
              turns.turn_id,
              invocations.invocation_id,
              commands.command_id
         FROM trajectory_turns turns
         JOIN trajectory_messages messages
           ON messages.log_id = turns.log_id
          AND messages.head = turns.head
          AND messages.message_id = turns.trigger_message_id
         JOIN log_events message
           ON message.log_id = messages.log_id
          AND message.head = messages.head
          AND message.envelope_id = messages.completed_event_id
         JOIN trajectory_invocations invocations
           ON invocations.log_id = turns.log_id
          AND invocations.head = turns.head
          AND invocations.turn_id = turns.turn_id
         JOIN vcs_command_journal commands
           ON commands.cause_log_id = invocations.log_id
          AND commands.cause_head = invocations.head
          AND commands.cause_invocation_id = invocations.invocation_id
        WHERE turns.log_id = ? AND turns.head = ? AND turns.turn_id = ?`,
      ["trajectory-1", "main", turnId]
    ).rows;
    expect(walk).toEqual([
      {
        intent: "Move the parser without changing its behavior",
        trigger_message_id: triggerMessageId,
        turn_id: turnId,
        invocation_id: invocationId,
        command_id: "command-1",
      },
    ]);

    const turnInspection = instance.inspectTurnState({
      trajectoryId: "trajectory-1",
      branchId: "main",
    });
    expect(turnInspection.rows[0]).toMatchObject({
      turn_id: turnId,
      trigger_message_id: triggerMessageId,
    });
    const invocationInspection = instance.inspectInvocationState({
      trajectoryId: "trajectory-1",
      branchId: "main",
      invocationId,
    });
    expect(invocationInspection.rows[0]).toMatchObject({
      invocation_id: invocationId,
      turn_id: turnId,
    });
  });

  it("rejects duplicate turn.opened events for the same branch turn", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    await appendTrajectoryEvents(call, {
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
      appendTrajectoryEvents(call, {
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
      appendTrajectoryEvents(call, {
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

    const first = await appendTrajectoryEvents<any>(call, input);
    const second = await appendTrajectoryEvents<any>(call, input);

    expect(second.headSeq).toBe(first.headSeq);
    expect(second.headHash).toBe(first.headHash);
    expect(second.envelopes.map((row: { envelopeId: string }) => row.envelopeId)).toEqual([
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
    const first = await appendTrajectoryEvents<any>(call, {
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

    const replay = await appendTrajectoryEvents<any>(call, {
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

    expect(replay.envelopes.map((row: { envelopeId: string }) => row.envelopeId)).toEqual([
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
    await appendTrajectoryEvents(call, {
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
      appendTrajectoryEvents(call, {
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

  it("rejects appends whose expectedHeadHash does not match the current head", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const first = await appendTrajectoryEvents<any>(call, {
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
      appendTrajectoryEvents(call, {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        expectedHeadHash: GENESIS, // stale
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
      appendTrajectoryEvents(call, {
        trajectoryId: "traj-1",
        branchId: "main",
        owner,
        expectedHeadHash: first.headHash,
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
    ).resolves.toMatchObject({ envelopes: [{ envelopeId: "event-next" }] });
  });

  it("indexes transport call ids on projected invocations keyed by (log_id, head)", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await appendTrajectoryEvents(call, {
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

  it("inspects turn and invocation state without hydrating full payloads", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await appendTrajectoryEvents(call, {
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

    const health = await call<any>("inspectAgentHealth", {
      channelId: "channel-1",
      branchId: "main",
      // A broad detailed-inspector limit must not make the summary unbounded.
      limit: 500,
    });
    expect(health.summary).toMatchObject({
      ok: false,
      durableIntegrityOk: true,
      inFlightOnly: true,
      activity: "in-flight",
      publicationIssues: 0,
      turnIntegrityIssues: 0,
      openTurns: 2,
      nonterminalInvocations: 1,
    });
    expect(health.invocationState.rows).toEqual([
      expect.objectContaining({ invocation_id: "tool-1", status: "started" }),
    ]);
    expect(health.turnState.rows).toHaveLength(2);
    expect(AgentHealthInspectionSchema.safeParse(health).success).toBe(true);
  });

  it("does not count failed terminal messages as streaming", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await appendTrajectoryEvents(call, {
      trajectoryId: "traj-failed-terminal",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "turn-opened",
          event: event("turn.opened", {
            turnId: "turn-1" as never,
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "started" },
          }),
        },
        {
          eventId: "message-started",
          event: event("message.started", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-failed" as never },
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant" },
          }),
        },
        {
          eventId: "message-failed",
          event: event("message.failed", {
            turnId: "turn-1" as never,
            causality: { messageId: "msg-failed" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              reason: "provider stream failed",
            },
          }),
        },
        {
          eventId: "turn-closed",
          event: event("turn.closed", {
            turnId: "turn-1" as never,
            payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "closed" },
          }),
        },
      ],
    });

    const turns = await call<any>("inspectTurnState", {
      trajectoryId: "traj-failed-terminal",
      branchId: "main",
    });

    expect(turns.summary).toMatchObject({
      openTurns: 0,
      streamingMessages: 0,
      nonterminalInvocations: 0,
      duplicateOpenedTurns: 0,
    });
    expect(turns.rows[0]).toMatchObject({
      turn_id: "turn-1",
      closed_at: expect.any(String),
      streaming_messages: 0,
    });
  });
});

describe("channel projections (§3.4)", () => {
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
      (
        await call<any>("readChannelEnvelopes", {
          channelId: "channel-1",
          window: { kind: "after", seq: 1 },
        })
      ).items
    ).toEqual([expect.objectContaining({ envelopeId: "env-2", seq: 2, payload: { value: 2 } })]);
    expect(
      (
        await call<any>("readChannelEnvelopes", {
          channelId: "channel-1",
          window: { kind: "before", seq: 2 },
          limit: 1,
        })
      ).items
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
    const initial = await call<any>("readChannelEnvelopes", {
      channelId: "channel-1",
      window: { kind: "tail" },
      limit: 1,
    });
    expect(initial).toMatchObject({
      pageInfo: {
        totalCount: 2,
        returnedFromSeq: 2,
        returnedToSeq: 2,
        hasMoreBefore: true,
        hasMoreAfter: false,
      },
      items: [expect.objectContaining({ envelopeId: "env-2" })],
    });
    const window = await call<any>("readChannelEnvelopes", {
      channelId: "channel-1",
      window: { kind: "after", seq: 0 },
      limit: 1,
    });
    expect(window.items.map((envelope: any) => envelope.seq)).toEqual([1]);
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
    await call("forkLog", {
      fromLogId: "channel-parent",
      fromHead: "main",
      toLogId: "channel-child",
      toHead: "main",
      atSeq: 5,
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

    const initial = await call<any>("readChannelEnvelopes", {
      channelId: "channel-child",
      window: { kind: "tail" },
      limit: 2,
    });
    expect(initial).toMatchObject({
      pageInfo: {
        totalCount: 7,
        firstSeq: 1,
        returnedFromSeq: 6,
        returnedToSeq: 7,
        hasMoreBefore: true,
        hasMoreAfter: false,
      },
    });
    expect(initial.items.map((envelope: any) => envelope.seq)).toEqual([6, 7]);

    const after = await call<any>("readChannelEnvelopes", {
      channelId: "channel-child",
      window: { kind: "after", seq: 5 },
      limit: 1,
    });
    expect(after.items.map((envelope: any) => envelope.seq)).toEqual([6]);
    expect(after.pageInfo).toMatchObject({ totalCount: 7, firstSeq: 1 });

    const before = await call<any>("readChannelEnvelopes", {
      channelId: "channel-child",
      window: { kind: "before", seq: 7 },
      limit: 1,
    });
    expect(before.items.map((envelope: any) => envelope.seq)).toEqual([6]);
    expect(before.pageInfo).toMatchObject({ totalCount: 7, firstSeq: 1, hasMoreBefore: true });

    await expect(
      call<any>("readChannelEnvelopes", { channelId: "channel-child", limit: 0 })
    ).resolves.toMatchObject({ items: [] });
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
      handle: "alice",
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

    await appendTrajectoryEvents(call, {
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
                    handle: "alice",
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
      handle: "alice",
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

    const raw = await call<any>("readChannelEnvelopes", { channelId: "channel-1" });
    const inspected = await call<{ items: Array<Record<string, unknown>> }>(
      "inspectChannelEnvelopes",
      { channelId: "channel-1" }
    );

    expect(JSON.stringify(raw.items).length).toBeGreaterThan(4000);
    expect(JSON.stringify(inspected).length).toBeLessThan(2000);
    expect(inspected.items[0]).toMatchObject({
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
    await appendTrajectoryEvents(call, {
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

    const appended = await appendTrajectoryEvents<any>(call, {
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
    expect(appended.envelopes[0]).toMatchObject({
      seq: 3,
      prevHash: fork.forkHash,
    });

    await expect(
      call("checkLogIntegrity", { logId: "traj-p5", head: "main" })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      call("checkLogIntegrity", { logId: "traj-p5-fork", head: "main" })
    ).resolves.toMatchObject({ ok: true });
  });

  it("forks channel history through the canonical unified-log RPC", async () => {
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

    const result = await call<any>("forkLog", {
      fromLogId: "channel-parent",
      fromHead: "main",
      toLogId: "channel-fork",
      toHead: "main",
      atSeq: 3,
    });
    // no-copy world: the whole prefix (including presence) is inherited as-is
    expect(result).toMatchObject({
      fromLogId: "channel-parent",
      toLogId: "channel-fork",
      forkSeq: 3,
      inherited: 3,
    });

    const forked = (
      await call<any>("readChannelEnvelopes", {
        channelId: "channel-fork",
        window: { kind: "after", seq: 0 },
        limit: 10,
      })
    ).items;
    expect(forked.map((envelope: any) => [envelope.seq, envelope.envelopeId])).toEqual([
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
      (
        await call<any>("readChannelEnvelopes", {
          channelId: "channel-fork",
          window: { kind: "after", seq: 3 },
          limit: 10,
        })
      ).items
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
    await appendTrajectoryEvents(call, startBatch("traj-div", "main"));

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
    await appendTrajectoryEvents(call, {
      trajectoryId: "traj-div",
      branchId: "main",
      owner,
      events: [parentTerminal],
    });

    // 4. child2: appending the parent terminal CONTENT under the same id succeeds
    //    (the parent's terminal is past the fork point, so it is not in child2's
    //    lineage — cross-log dedupe by envelope_id alone must NOT happen) ...
    await appendTrajectoryEvents(call, {
      trajectoryId: "traj-div",
      branchId: "child2",
      owner,
      events: [parentTerminal],
    });
    //    ... and re-appending it is a lineage-scoped replay no-op.
    await expect(
      appendTrajectoryEvents(call, {
        trajectoryId: "traj-div",
        branchId: "child2",
        owner,
        events: [parentTerminal],
      })
    ).resolves.toMatchObject({ head: "child2" });
    expect(
      await countRows(call, "log_id = ? AND head = ? AND envelope_id = ?", [
        "traj-div",
        "child2",
        "inv:1:terminal",
      ])
    ).toBe(1);

    // 5. child appends a DIVERGENT terminal under the same deterministic id — succeeds
    await appendTrajectoryEvents(call, {
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
      appendTrajectoryEvents(call, {
        trajectoryId: "traj-div",
        branchId: "main",
        owner,
        events: [parentTerminal],
      })
    ).resolves.toMatchObject({ head: "main" });
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

describe("projection replay", () => {
  it("rebuilds trajectory projections from immutable log events", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await appendTrajectoryEvents(call, {
      trajectoryId: "traj-replay",
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
        log_id: "traj-replay",
        head: "main",
        message_id: "msg-1",
        role: "assistant",
        status: "streaming",
      }),
    ]);
  });
});

describe("terminal idempotency guards (§3.13)", () => {
  it("enforces terminal invocation idempotency at append time", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await appendTrajectoryEvents(call, {
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
      appendTrajectoryEvents(call, {
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
    ).resolves.toMatchObject({ head: "main" });

    const replayInspection = await call<any>("inspectInvocationState", { invocationId: "inv-1" });
    expect(replayInspection.rows[0]).toMatchObject({
      invocation_id: "inv-1",
      status: "completed",
      completed_event_id: "event-inv-complete",
    });

    await expect(
      appendTrajectoryEvents(call, {
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
    ).resolves.toMatchObject({ head: "main" });

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
      appendTrajectoryEvents(call, {
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
      appendTrajectoryEvents(call, {
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
    await appendTrajectoryEvents(call, {
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
      appendTrajectoryEvents(call, {
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
    await appendTrajectoryEvents(call, {
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
                protocol: "vibestudio.blob-ref.v1",
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
      appendTrajectoryEvents(call, {
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

  it("reports stored-value references without a second blob-ownership protocol", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await appendTrajectoryEvents(call, {
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
                protocol: "vibestudio.blob-ref.v1",
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
  });
});

describe("lineage queries over causality edges (§3.15)", () => {
  it("links trajectory events to deterministic channel publications and back", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const result = await appendTrajectoryEvents<any>(call, {
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
        originEnvelopeId: "event-message-1",
        channelId: "channel-1",
        envelopeId: "pub:event-message-1:channel-1",
      }),
    ]);

    const envelopes = (
      await call<any>("readChannelEnvelopes", {
        channelId: "channel-1",
        payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      })
    ).items;
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
    await appendTrajectoryEvents(call, {
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
    const publicChannel = (await call<any>("readChannelEnvelopes", { channelId: "main-channel" }))
      .items;
    expect(
      publicChannel.map((envelope: any) => envelope.payload.payload.blocks?.[0]?.content)
    ).toEqual(["Side task summary for the main session"]);
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
      protocol: "vibestudio.blob-ref.v1",
      digest: "details-side",
    });

    await appendTrajectoryEvents(call, {
      trajectoryId: "traj-main",
      branchId: "main",
      owner,
      events: [
        {
          eventId: "main-consumes-side-summary",
          event: event("system.event", {
            turnId: "turn-main" as never,
            causality: { parentEventId: "side-summary" as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              kind: "published-envelope-consumed",
              details: { object: publishedEnvelopeId },
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
      payload: { details: { object: publishedEnvelopeId } },
    });
  });
});

describe("checkGadIntegrity (§3.16)", () => {
  it("detects a tampered log event", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);
    await appendTrajectoryEvents(call, {
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

describe("trajectory projection details", () => {
  it("stamps a per-branch turn ordinal on turn.opened", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await appendTrajectoryEvents(call, {
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
});
