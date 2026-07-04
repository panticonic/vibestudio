/**
 * DO-3 (C6): recall + touches + soft-state prune.
 *
 *  - T3: commit messages become searchable `kind='commit'` recall rows at
 *    projection time, anchored to the commit event id (real edit→commit path
 *    over in-memory host bridges);
 *  - recallMemory: `recallKeywords` OR-widen the FTS match, and published/fork
 *    copies are deduped (over-fetch → collapse → slice) so a page never
 *    under-fills and the trajectory-log copy wins;
 *  - upsertTouch: the §4.2 counted-upsert helper (hits bump, latest
 *    invocation/turn/block-sig; kind separates coalesced rows);
 *  - pruneProvenanceSoftState: ages out single-hit touches, stale cache rows,
 *    and old render-log rows;
 *  - trajectory_turns.ordinal stamping + the currentTurnOrdinal reader.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import {
  AGENTIC_PROTOCOL_VERSION,
  manifestHashForEntries,
  stateHashForRoot,
  type AgenticEvent,
} from "@workspace/agentic-protocol";
import { GadWorkspaceDO } from "./index.js";

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

type TreeEntry =
  | { name: string; kind: "file"; contentHash: string; mode: number }
  | { name: string; kind: "dir"; childHash: string };

const REPO = "packages/demo";
const LOG = `vcs:repo:${REPO}`;
const CTX = "ctx:t1";
const ACTOR = { kind: "agent" as const, id: "agent-1" };
const ACTOR_JSON = JSON.stringify(ACTOR);

const owner = { kind: "agent" as const, id: "agent-1" };

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** In-memory host content store over the shared canonical tree hashing. */
function createMemoryHostStore() {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, TreeEntry[]>();
  const states = new Map<string, string>();
  const resolveRoot = (ref: string): string | null =>
    ref.startsWith("state:") ? (states.get(ref) ?? null) : ref;
  const walk = (
    manifestHash: string,
    prefix: string,
    out: Array<{ path: string; kind: string; contentHash?: string; mode?: number }>
  ): void => {
    const entries = trees.get(manifestHash);
    if (!entries) throw new Error(`memory store: missing interior tree ${manifestHash}`);
    for (const entry of entries) {
      const p = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === "file") {
        out.push({ path: p, kind: "file", contentHash: entry.contentHash, mode: entry.mode });
      } else {
        out.push({ path: p, kind: "dir" });
        walk(entry.childHash, p, out);
      }
    }
  };
  const store = {
    async listTree(ref: string, opts?: { prefix?: string; limit?: number }) {
      const root = resolveRoot(ref);
      if (root === null || !trees.has(root)) return null;
      const out: Array<{ path: string; kind: string; contentHash?: string; mode?: number }> = [];
      walk(root, "", out);
      const prefix = opts?.prefix;
      return prefix
        ? out.filter((e) => e.path === prefix || e.path.startsWith(`${prefix}/`))
        : out;
    },
    async getTree(ref: string) {
      const root = resolveRoot(ref);
      return root !== null && trees.has(root) ? trees.get(root)! : null;
    },
    async getBase64(digest: string) {
      const bytes = blobs.get(digest);
      return bytes ? bytes.toString("base64") : null;
    },
    async putBase64(bytesBase64: string) {
      const bytes = Buffer.from(bytesBase64, "base64");
      const digest = sha256Hex(bytes);
      blobs.set(digest, bytes);
      return { digest, size: bytes.length };
    },
    async putTree(entries: TreeEntry[], opts?: { root?: boolean }) {
      const treeHash = manifestHashForEntries(entries);
      trees.set(treeHash, entries);
      if (!opts?.root) return { treeHash };
      const stateHash = stateHashForRoot(treeHash);
      states.set(stateHash, treeHash);
      return { treeHash, stateHash };
    },
  };
  return { store, blobs, trees, states };
}

function createMemoryRefs() {
  const values = new Map<string, string>();
  return {
    set(repo: string, _ref: string, value: string) {
      values.set(repo, value);
    },
    bridge: {
      async readMain(repoPath: string): Promise<{ stateHash: string } | null> {
        const stateHash = values.get(repoPath);
        return stateHash ? { stateHash } : null;
      },
      async listMains(): Promise<Array<{ repoPath: string; stateHash: string }>> {
        return [...values.entries()].map(([repoPath, stateHash]) => ({ repoPath, stateHash }));
      },
    },
  };
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

/** Private-helper reach-through — the working-edit test seam pattern (the
 *  helpers are consumed by DO-4's provenanceForFile, which lands in a sibling
 *  wave; exercise them directly here). */
type PrivateReach = {
  upsertTouch(input: {
    kind: "observed" | "cited";
    sessionLogId: string;
    sessionHead: string;
    dstKind: "file" | "claim";
    dstId: string;
    invocationId?: string | null;
    turnSeq?: number | null;
    blockSig?: string | null;
  }): void;
  currentTurnOrdinal(logId: string, head: string): number;
  indexMemoryRow(row: {
    text: string;
    kind: "message" | "claim" | "file" | "commit";
    logId?: string | null;
    head?: string | null;
    eventId?: string | null;
    path?: string | null;
    contentHash?: string | null;
    anchor?: Record<string, unknown> | null;
  }): void;
};
const reach = (doi: GadWorkspaceDO): PrivateReach => doi as unknown as PrivateReach;

describe("GadWorkspaceDO — recall (T3 commit messages + keyword widening)", () => {
  let gad: TestGad;
  let doi: GadWorkspaceDO;
  let mem: ReturnType<typeof createMemoryHostStore>;
  let refs: ReturnType<typeof createMemoryRefs>;

  beforeEach(async () => {
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad-recall" });
    doi = gad.instance;
    mem = createMemoryHostStore();
    refs = createMemoryRefs();
    Object.defineProperty(doi, "contentStore", { value: () => mem.store });
    Object.defineProperty(doi, "refsStore", { value: () => refs.bridge });
  });

  it("T3: a commit message becomes a kind='commit' recall hit anchored to the commit event", async () => {
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [{ kind: "create", path: "fetch.ts", content: { kind: "text", text: "fetch();\n" } }],
    });
    const commit = await doi.commitWorking({
      logId: LOG,
      head: CTX,
      message: "add retry backoff to the fetch loop",
      actor: ACTOR,
    });

    const recall = doi.recallMemory({ query: "retry backoff" });
    const hit = recall.results.find((r) => r.kind === "commit");
    expect(hit).toBeTruthy();
    expect(hit!.eventId).toBe(commit.eventId);
    expect(hit!.snippet).toContain("retry backoff");
    expect(hit!.anchor).toMatchObject({ commitEventId: commit.eventId });
    // Scoping to non-file entries: a commit row (path IS NULL) survives a
    // repoPaths-style prefix filter that would decimate file rows.
    const scoped = doi.recallMemory({ query: "retry backoff", pathPrefixes: ["some/other/repo"] });
    expect(scoped.results.some((r) => r.kind === "commit")).toBe(true);
  });

  it("recallKeywords OR-widen the match: a keyword surfaces a commit the base query misses", async () => {
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [{ kind: "create", path: "a.ts", content: { kind: "text", text: "x\n" } }],
    });
    const c1 = await doi.commitWorking({
      logId: LOG,
      head: CTX,
      message: "alpha subsystem initial scaffold",
      actor: ACTOR,
    });
    await doi.applyEditOps({
      logId: LOG,
      head: CTX,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      edits: [{ kind: "write", path: "a.ts", content: { kind: "text", text: "y\n" } }],
    });
    const c2 = await doi.commitWorking({
      logId: LOG,
      head: CTX,
      message: "beta subsystem cleanup",
      actor: ACTOR,
    });

    // Base query matches only the "alpha" commit.
    const base = doi
      .recallMemory({ query: "alpha" })
      .results.filter((r) => r.kind === "commit")
      .map((r) => r.eventId);
    expect(base).toEqual([c1.eventId]);

    // The steering keyword ORs the "beta" commit in without dropping the base hit.
    const widened = new Set(
      doi
        .recallMemory({ query: "alpha", recallKeywords: ["beta"] })
        .results.filter((r) => r.kind === "commit")
        .map((r) => r.eventId)
    );
    expect(widened).toEqual(new Set([c1.eventId, c2.eventId]));
  });
});

describe("GadWorkspaceDO — recall dedup / touches / prune / turn ordinal", () => {
  let gad: TestGad;
  let doi: GadWorkspaceDO;

  beforeEach(async () => {
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad-recall-soft" });
    doi = gad.instance;
  });

  async function queryRows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const res = (await gad.call("query", sql, params)) as { rows: Record<string, unknown>[] };
    return res.rows;
  }

  it("dedup keeps the page full: a duplicate copy is collapsed without stealing a slot", () => {
    // Six distinct items sharing the term "widget", each a distinct event id.
    for (let i = 1; i <= 6; i += 1) {
      reach(doi).indexMemoryRow({
        text: `widget number ${["one", "two", "three", "four", "five", "six"][i - 1]}`,
        kind: "message",
        logId: "traj:D",
        head: "h-main",
        eventId: `e-w${i}`,
      });
    }
    // A published/fork COPY of the first item: same (kind, event_id), other head.
    reach(doi).indexMemoryRow({
      text: "widget number one",
      kind: "message",
      logId: "traj:D",
      head: "h-fork",
      eventId: "e-w1",
    });

    const results = doi.recallMemory({ query: "widget", limit: 5 }).results;
    // Full page (a naive dedup-after-fetch under a limit-5 SQL page would return
    // 4 here, since the copy sits inside the first five inserted rows).
    expect(results).toHaveLength(5);
    const ids = results.map((r) => r.eventId);
    expect(new Set(ids).size).toBe(5);
    expect(ids.filter((id) => id === "e-w1").length).toBeLessThanOrEqual(1);
  });

  it("dedup prefers the trajectory-log copy over a channel republish", () => {
    gad.sql.exec(
      `INSERT INTO log_heads (log_id, head, log_kind, owner_json, created_at)
       VALUES ('traj:X', 'main', 'trajectory', '{}', '2026-01-01T00:00:00.000Z'),
              ('chan:Y', 'main', 'channel', '{}', '2026-01-01T00:00:00.000Z')`
    );
    // Insert the channel copy FIRST so the swap branch (adopt the trajectory
    // copy over an already-kept non-trajectory one) is exercised.
    reach(doi).indexMemoryRow({
      text: "shared echo of a published message",
      kind: "message",
      logId: "chan:Y",
      head: "main",
      eventId: "e-shared",
    });
    reach(doi).indexMemoryRow({
      text: "shared echo of a published message",
      kind: "message",
      logId: "traj:X",
      head: "main",
      eventId: "e-shared",
    });

    const results = doi.recallMemory({ query: "shared echo" }).results;
    expect(results).toHaveLength(1);
    expect(results[0]!.logId).toBe("traj:X");
  });

  it("upsertTouch coalesces: hits bump; latest invocation/turn/block-sig; kind separates rows", async () => {
    const touch = (patch: Partial<Parameters<PrivateReach["upsertTouch"]>[0]>) =>
      reach(doi).upsertTouch({
        kind: "observed",
        sessionLogId: "traj:S",
        sessionHead: "main",
        dstKind: "file",
        dstId: "a.txt",
        ...patch,
      });

    touch({ invocationId: "inv-1", turnSeq: 3, blockSig: "sig-1" });
    touch({ invocationId: "inv-2", turnSeq: 5, blockSig: "sig-2" });
    let row = (
      await queryRows(
        `SELECT hits, last_invocation_id, turn_seq, last_block_sig FROM gad_touches
          WHERE kind='observed' AND session_log_id='traj:S' AND dst_id='a.txt'`
      )
    )[0]!;
    expect(Number(row["hits"])).toBe(2);
    expect(row["last_invocation_id"]).toBe("inv-2");
    expect(Number(row["turn_seq"])).toBe(5);
    expect(row["last_block_sig"]).toBe("sig-2");

    // A repeat that omits fields bumps hits but COALESCE-preserves the last values.
    touch({});
    row = (
      await queryRows(
        `SELECT hits, last_invocation_id, turn_seq, last_block_sig FROM gad_touches
          WHERE kind='observed' AND session_log_id='traj:S' AND dst_id='a.txt'`
      )
    )[0]!;
    expect(Number(row["hits"])).toBe(3);
    expect(row["last_invocation_id"]).toBe("inv-2");
    expect(Number(row["turn_seq"])).toBe(5);
    expect(row["last_block_sig"]).toBe("sig-2");

    // `cited` is a distinct kind ⇒ a separate coalesced row for the same target.
    reach(doi).upsertTouch({
      kind: "cited",
      sessionLogId: "traj:S",
      sessionHead: "main",
      dstKind: "file",
      dstId: "a.txt",
      invocationId: "inv-3",
    });
    const total = Number(
      (await queryRows(`SELECT COUNT(*) AS n FROM gad_touches`))[0]!["n"]
    );
    expect(total).toBe(2);
  });

  it("pruneProvenanceSoftState ages out single-hit touches / stale cache / old render-log", async () => {
    const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    // Touches: old single-hit (prune), old multi-hit (survive), recent single-hit (survive).
    gad.sql.exec(
      `INSERT INTO gad_touches (kind, session_log_id, session_head, dst_kind, dst_id, hits, created_at, updated_at)
       VALUES ('observed','s','h','file','old-1hit',1,?,?),
              ('observed','s','h','file','old-3hit',3,?,?),
              ('observed','s','h','file','new-1hit',1,?,?)`,
      days(60),
      days(60),
      days(60),
      days(60),
      days(0),
      days(0)
    );
    // Cache: old (prune) + recent (survive).
    gad.sql.exec(
      `INSERT INTO gad_provenance_cache (head, path, created_at) VALUES ('h','old.ts',?),('h','new.ts',?)`,
      days(30),
      days(0)
    );
    // Render log: old (prune) + recent (survive).
    gad.sql.exec(
      `INSERT INTO gad_prov_render_log (path, created_at) VALUES ('old.ts',?),('new.ts',?)`,
      days(30),
      days(0)
    );

    const counts = doi.pruneProvenanceSoftState({});
    expect(counts).toEqual({ touches: 1, cache: 1, renderLog: 1 });

    const survivingTouches = (
      await queryRows(`SELECT dst_id FROM gad_touches ORDER BY dst_id`)
    ).map((r) => r["dst_id"]);
    expect(survivingTouches).toEqual(["new-1hit", "old-3hit"]);
    expect(Number((await queryRows(`SELECT COUNT(*) AS n FROM gad_provenance_cache`))[0]!["n"])).toBe(
      1
    );
    expect(Number((await queryRows(`SELECT COUNT(*) AS n FROM gad_prov_render_log`))[0]!["n"])).toBe(
      1
    );

    // Idempotent second pass — nothing left below the floors.
    expect(doi.pruneProvenanceSoftState({})).toEqual({ touches: 0, cache: 0, renderLog: 0 });
  });

  it("trajectory_turns.ordinal is stamped per branch; currentTurnOrdinal reads the max", async () => {
    await gad.call("appendTrajectoryBatch", {
      trajectoryId: "traj-1",
      branchId: "main",
      owner,
      events: [1, 2, 3].map((n) => ({
        eventId: `turn-opened-${n}`,
        event: event("turn.opened", {
          turnId: `turn-${n}` as never,
          payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: `turn ${n}` },
        }),
      })),
    });

    const ordinals = (
      await queryRows(
        `SELECT turn_id, ordinal FROM trajectory_turns WHERE log_id='traj-1' AND head='main' ORDER BY ordinal`
      )
    ).map((r) => ({ turnId: r["turn_id"], ordinal: Number(r["ordinal"]) }));
    expect(ordinals).toEqual([
      { turnId: "turn-1", ordinal: 0 },
      { turnId: "turn-2", ordinal: 1 },
      { turnId: "turn-3", ordinal: 2 },
    ]);

    expect(reach(doi).currentTurnOrdinal("traj-1", "main")).toBe(2);
    // A branch with no opened turns reports -1 (no session-recency basis yet).
    expect(reach(doi).currentTurnOrdinal("traj-1", "other")).toBe(-1);
  });
});
