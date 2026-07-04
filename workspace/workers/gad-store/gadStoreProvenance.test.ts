/**
 * DO-4 — §6/§7 provenance density + read-time attachment, against the real
 * GadWorkspaceDO with in-memory host bridges (content CAS + refs + main-ref
 * log). Exercises the whole loop: touch(S) reconstruction, exceptions-first
 * ordering, the salience floor (no structural filler), session-density
 * re-ranking, re-read suppression + re-attach, paging, session orientation,
 * the warm cache + touch_version invalidation, cited touches, and the §12
 * counters. The DO test harness runs sql.js (plain-LIKE recall, no FTS5), so
 * the recall leg exercises the same widen/dedup path every DO memory test does.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { manifestHashForEntries, stateHashForRoot } from "@workspace/agentic-protocol";
import { GadWorkspaceDO } from "./index.js";

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

type TreeEntry =
  | { name: string; kind: "file"; contentHash: string; mode: number }
  | { name: string; kind: "dir"; childHash: string };

const REPO = "packages/demo";
const LOG = `vcs:repo:${REPO}`;
const CTX = "ctx:t1";
const SESSION_LOG = "trajectory:agent-1";
const SESSION_HEAD = "main";
const ACTOR = { kind: "agent" as const, id: "agent-1" };
const ACTOR_JSON = JSON.stringify(ACTOR);

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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
      return prefix ? out.filter((e) => e.path === prefix || e.path.startsWith(`${prefix}/`)) : out;
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

type MainMovement = {
  id: number;
  operation: string;
  old: string | null;
  new: string | null;
  writer: string | null;
  onBehalfOf: unknown;
  reason: string | null;
  createdAt: number;
};

function createMemoryRefs() {
  const values = new Map<string, string>();
  const log = new Map<string, MainMovement[]>();
  return {
    set(repo: string, _ref: string, value: string) {
      values.set(repo, value);
    },
    pushMovement(repo: string, m: MainMovement) {
      const list = log.get(repo) ?? [];
      list.push(m);
      log.set(repo, list);
    },
    bridge: {
      async readMain(repoPath: string): Promise<{ stateHash: string } | null> {
        const stateHash = values.get(repoPath);
        return stateHash ? { stateHash } : null;
      },
      async listMains(): Promise<Array<{ repoPath: string; stateHash: string }>> {
        return [...values.entries()].map(([repoPath, stateHash]) => ({ repoPath, stateHash }));
      },
      async listMainRefLog(repoPath: string, sinceId?: number): Promise<MainMovement[]> {
        const list = log.get(repoPath) ?? [];
        return sinceId ? list.filter((m) => m.id > sinceId) : list;
      },
    },
  };
}

describe("GadWorkspaceDO — provenance density + attachment (DO-4)", () => {
  let gad: TestGad;
  let doi: GadWorkspaceDO;
  let mem: ReturnType<typeof createMemoryHostStore>;
  let refs: ReturnType<typeof createMemoryRefs>;

  beforeEach(async () => {
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad-prov" });
    doi = gad.instance;
    mem = createMemoryHostStore();
    refs = createMemoryRefs();
    Object.defineProperty(doi, "contentStore", { value: () => mem.store });
    Object.defineProperty(doi, "refsStore", { value: () => refs.bridge });
  });

  // --- helpers --------------------------------------------------------------

  const untyped = () =>
    doi as unknown as {
      touchVersion(sessionLogId: string, sessionHead: string): number;
      writeProvenanceCache(head: string, path: string, version: number, items: unknown[]): void;
    };

  async function edit(
    head: string,
    edits: Array<Record<string, unknown>>,
    invocationId?: string
  ): Promise<void> {
    await doi.applyEditOps({
      logId: LOG,
      head,
      actorId: ACTOR.id,
      actorJson: ACTOR_JSON,
      ...(invocationId ? { invocationId } : {}),
      edits: edits as never,
    });
  }

  async function commit(head: string, message: string, invocationId?: string) {
    return doi.commitWorking({
      logId: LOG,
      head,
      message,
      actor: ACTOR,
      ...(invocationId ? { invocationId } : {}),
    });
  }

  function recordClaim(text: string, invocationId?: string): string {
    const r = doi.knowledgeRecordClaim({
      logId: SESSION_LOG,
      head: SESSION_HEAD,
      ...(invocationId ? { invocationId } : {}),
      claim: { text },
    });
    if (!r.claimId) throw new Error(`claim blocked as duplicate: ${text}`);
    return r.claimId;
  }

  function relate(src: string, relation: string, dst: string): void {
    doi.knowledgeRelateClaims({
      logId: SESSION_LOG,
      head: SESSION_HEAD,
      relations: [{ src, relation, dst }],
    });
  }

  /** Directly link an edit-op invocation to the session trajectory so the edit
   *  becomes an `edited` seed in touch(S). */
  function linkInvocation(invocationId: string, turnId: string, ordinal: number): void {
    gad.sql.exec(
      `INSERT OR IGNORE INTO trajectory_turns (log_id, head, turn_id, opened_at, ordinal)
       VALUES (?, ?, ?, ?, ?)`,
      SESSION_LOG,
      SESSION_HEAD,
      turnId,
      new Date().toISOString(),
      ordinal
    );
    gad.sql.exec(
      `INSERT OR IGNORE INTO trajectory_invocations (log_id, head, invocation_id, turn_id, kind, status, updated_at)
       VALUES (?, ?, ?, ?, 'tool', 'completed', ?)`,
      SESSION_LOG,
      SESSION_HEAD,
      invocationId,
      turnId,
      new Date().toISOString()
    );
  }

  function pf(input: Record<string, unknown>) {
    return doi.provenanceForFile({
      repoPath: REPO,
      head: CTX,
      sessionLogId: SESSION_LOG,
      sessionHead: SESSION_HEAD,
      ...input,
    } as never);
  }

  function metric(name: string, bucket: string): number {
    const row = gad.sql
      .exec(`SELECT count FROM gad_prov_metrics WHERE metric = ? AND bucket = ?`, name, bucket)
      .toArray()[0] as { count?: number } | undefined;
    return row ? Number(row.count) : 0;
  }

  function touchRows(kind: string): Array<Record<string, unknown>> {
    return gad.sql
      .exec(`SELECT * FROM gad_touches WHERE kind = ? ORDER BY id`, kind)
      .toArray() as Array<Record<string, unknown>>;
  }

  // --- tests ----------------------------------------------------------------

  it("tier 'none' returns no items but still writes the observed touch (§7.4)", () => {
    const res = pf({ path: "a.txt", tier: "none" });
    expect(res).toMatchObject({ items: [], shown: 0, total: 0, suppressed: false });
    const observed = touchRows("observed");
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ dst_kind: "file", session_log_id: SESSION_LOG });
    expect(metric("tier", "none")).toBe(1);
  });

  it("exception lines always render and sort first, above density", async () => {
    // A committed file (density: a 'last commit' item).
    await edit(
      CTX,
      [{ kind: "create", path: "a.txt", content: { kind: "text", text: "L1\n" } }],
      "inv-e"
    );
    await commit(CTX, "seed a", "inv-e");
    // Cross-session concurrency: another ctx head holds an uncommitted edit on a.txt.
    await edit("ctx:other", [
      { kind: "write", path: "a.txt", content: { kind: "text", text: "OTHER\n" } },
    ]);
    // Two file-linked claims (asserted by the invocation that edited a.txt) that contradict.
    const c1 = recordClaim("alpha owns the retry ledger", "inv-e");
    const c2 = recordClaim("beta owns the retry ledger not alpha", "inv-e");
    relate(c1, "contradicts", c2);

    const res = pf({ path: "a.txt", tier: "moderate" });
    expect(res.items.length).toBeGreaterThan(0);
    const kinds = res.items.map((i) => i.kind);
    // Every exception sorts strictly before every non-exception.
    const lastException = res.items.map((i) => i.exception).lastIndexOf(true);
    const firstDensity = res.items.findIndex((i) => !i.exception);
    if (lastException >= 0 && firstDensity >= 0) expect(lastException).toBeLessThan(firstDensity);
    expect(kinds).toContain("concurrency");
    expect(kinds).toContain("contradiction");
    expect(res.items[0]!.exception).toBe(true);
    // The concurrency line names the other session head; the block carries a commit.
    expect(res.items.find((i) => i.kind === "concurrency")!.handle).toBe("session:ctx:other");
    expect(kinds).toContain("commit");
  });

  it("salience floor yields a thin/empty block on a sparse graph — no structural filler", () => {
    // A file only observed once, never committed, no claims, no concurrent edits.
    const res = pf({ path: "lonely.txt", tier: "moderate" });
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.suppressed).toBe(false);
  });

  it("density ranks a session-near candidate above an equally-similar far one", () => {
    // Seed claim X on the session (not itself recalled by the keyword).
    const x = recordClaim("budget ownership overview note");
    // A is related to the session's seed X; B is unrelated. Both share the keyword.
    const a = recordClaim("the retrybudget belongs to the caller layer");
    const b = recordClaim("the retrybudget is clamped inside the dispatch queue");
    relate(x, "supports", a);

    const res = pf({ path: "notes.md", tier: "deep", recallKeywords: ["retrybudget"] });
    const claimItems = res.items.filter((i) => i.kind === "claim");
    const aIdx = claimItems.findIndex((i) => i.handle === `claim#${a}`);
    const bIdx = claimItems.findIndex((i) => i.handle === `claim#${b}`);
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThanOrEqual(0);
    // Both are equally-similar FTS hits; A sorts above B because the session
    // worked near it (X supports A).
    expect(aIdx).toBeLessThan(bIdx);
    const aScore = claimItems[aIdx]!.score;
    const bScore = claimItems[bIdx]!.score;
    expect(aScore).toBeGreaterThan(bScore);
  });

  it("suppression fires on an unchanged signature and re-attaches on content change", async () => {
    await edit(
      CTX,
      [{ kind: "create", path: "s.txt", content: { kind: "text", text: "one\n" } }],
      "inv-s"
    );
    await commit(CTX, "add s", "inv-s");

    const first = pf({ path: "s.txt", tier: "moderate" });
    expect(first.suppressed).toBe(false);
    expect(first.items.some((i) => i.kind === "commit")).toBe(true);

    const second = pf({ path: "s.txt", tier: "moderate" });
    expect(second.suppressed).toBe(true);
    expect(second.items).toEqual([]);

    // A content change flips the block signature → re-attach.
    await edit(
      CTX,
      [{ kind: "write", path: "s.txt", content: { kind: "text", text: "two\n" } }],
      "inv-s2"
    );
    const third = pf({ path: "s.txt", tier: "moderate" });
    expect(third.suppressed).toBe(false);
    expect(third.items.length).toBeGreaterThan(0);
    expect(metric("suppression", "suppressed")).toBe(1);
  });

  it("paging: the after cursor walks the ranked tail unbounded", async () => {
    // One commit co-editing a.txt with six siblings → a.txt has 6 co-edit neighbors.
    const files = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt", "g.txt"];
    await edit(
      CTX,
      files.map((path) => ({ kind: "create", path, content: { kind: "text", text: `${path}\n` } })),
      "inv-co"
    );
    await commit(CTX, "co-edit seven", "inv-co");

    // Seed a.txt into touch(S) at tier none, then page its moderate block.
    pf({ path: "a.txt", tier: "none" });
    const page1 = pf({ path: "a.txt", tier: "moderate" });
    expect(page1.total).toBeGreaterThan(5);
    expect(page1.shown).toBeLessThanOrEqual(
      Math.max(5, page1.items.filter((i) => i.exception).length)
    );
    expect(page1.nextCursor).toBeDefined();

    const page2 = pf({
      path: "a.txt",
      tier: "moderate",
      after: page1.nextCursor,
      skipSuppression: true,
    });
    expect(page2.shown).toBeGreaterThan(0);
    // The two pages together cover the whole ranked list with no overlap.
    const handles = new Set([...page1.items, ...page2.items].map((i) => i.handle));
    expect(handles.size).toBe(page1.items.length + page2.items.length);
    expect(page1.items.length + page2.items.length).toBe(page1.total);
    expect(metric("drilldown", "page")).toBeGreaterThanOrEqual(1);
  });

  it("session orientation surfaces cross-session uncommitted edits + main movement", async () => {
    const t0 = Date.now();
    // The session edits then reads m.txt (an `edited` + `observed` seed).
    await edit(
      CTX,
      [{ kind: "create", path: "m.txt", content: { kind: "text", text: "M\n" } }],
      "inv-m"
    );
    linkInvocation("inv-m", "turn-m", 0);
    pf({ path: "m.txt", tier: "none" });
    // Another context holds an uncommitted edit on m.txt.
    await edit("ctx:rival", [
      { kind: "write", path: "m.txt", content: { kind: "text", text: "RIVAL\n" } },
    ]);
    // main moved on the repo AFTER the session started.
    refs.pushMovement(REPO, {
      id: 1,
      operation: "push",
      old: null,
      new: "state:" + "9".repeat(64),
      writer: "panel",
      onBehalfOf: { kind: "user", id: "u" },
      reason: "ship it",
      createdAt: t0 + 100_000,
    });

    const res = await doi.provenanceForSession({
      sessionLogId: SESSION_LOG,
      sessionHead: SESSION_HEAD,
    });
    const kinds = res.items.map((i) => i.kind);
    expect(kinds).toContain("concurrency");
    expect(kinds).toContain("main-moved");
    // Exceptions render at the top.
    expect(res.items[0]!.exception).toBe(true);
    const mainMoved = res.items.find((i) => i.kind === "main-moved")!;
    expect(mainMoved.line).toContain(REPO);
    expect(mainMoved.line).toContain("push");
  });

  it("warm cache: a moderate hit serves the cached block; a touch bumps touch_version and invalidates", () => {
    const u = untyped();
    const sentinel = [
      {
        line: "SENTINEL cached line",
        handle: "file:sentinel",
        kind: "file",
        exception: false,
        score: 0.9,
      },
    ];
    // Cache a block for (CTX, w.txt) at the session's current touch_version.
    const version = u.touchVersion(SESSION_LOG, SESSION_HEAD);
    u.writeProvenanceCache(CTX, "w.txt", version, sentinel);

    // First moderate read serves the cache verbatim (version matches).
    const served = pf({ path: "w.txt", tier: "moderate" });
    expect(served.items).toEqual(sentinel);
    // …and its own observed touch advances touch_version, invalidating the row.
    const second = pf({ path: "w.txt", tier: "moderate" });
    expect(second.items).not.toEqual(sentinel);
    expect(second.items).toEqual([]); // bare file recomputes to an empty block
  });

  it("a claim drill-down writes a cited touch and returns the claim neighborhood", () => {
    const c1 = recordClaim("the cache is invalidated by touch_version");
    const c2 = recordClaim("the warm block is disposable never authority");
    relate(c1, "refines", c2);

    const res = doi.provenanceForClaim({
      claimId: c1,
      sessionLogId: SESSION_LOG,
      sessionHead: SESSION_HEAD,
      invocationId: "inv-cite",
    });
    expect(res.items.some((i) => i.handle === `claim#${c1}`)).toBe(true);
    expect(res.items.some((i) => i.handle === `claim#${c2}`)).toBe(true);
    const cited = touchRows("cited");
    expect(cited).toHaveLength(1);
    expect(cited[0]).toMatchObject({
      dst_kind: "claim",
      dst_id: c1,
      last_invocation_id: "inv-cite",
    });
    expect(metric("drilldown", "deepen")).toBeGreaterThanOrEqual(1);
  });

  it("attach→action rate counts a drill-down on a recently pushed handle (§12 #4)", () => {
    const x = recordClaim("attach action seed overview");
    const a = recordClaim("the retryquota belongs to the caller layer");
    relate(x, "supports", a);
    // Render a block that pushes claim#a into the render log.
    const rendered = pf({ path: "n.md", tier: "deep", recallKeywords: ["retryquota"] });
    expect(rendered.items.some((i) => i.handle === `claim#${a}`)).toBe(true);
    // Drilling that just-pushed claim is an attach→action hit.
    doi.provenanceForClaim({ claimId: a, sessionLogId: SESSION_LOG, sessionHead: SESSION_HEAD });
    expect(metric("action_rate", "hit")).toBeGreaterThanOrEqual(1);
  });

  it("metrics buckets move across tiers, drilldowns, and claim recording", () => {
    recordClaim("a standalone claim with no commit anchor");
    pf({ path: "z.txt", tier: "none" });
    pf({ path: "z.txt", tier: "moderate" });
    pf({ path: "z.txt", tier: "deep" });

    expect(metric("tier", "none")).toBe(1);
    expect(metric("tier", "moderate")).toBe(1);
    expect(metric("tier", "deep")).toBe(1);
    expect(metric("claims_recorded", "standalone")).toBe(1);
  });

  it("edge_graph + claim_graph views expose native + soft edges", async () => {
    await edit(
      CTX,
      [{ kind: "create", path: "v.txt", content: { kind: "text", text: "V\n" } }],
      "inv-v"
    );
    await commit(CTX, "commit v", "inv-v");
    const c1 = recordClaim("view claim one alpha", "inv-v");
    const c2 = recordClaim("view claim two beta", "inv-v");
    relate(c1, "supports", c2);
    pf({ path: "v.txt", tier: "none" }); // an observed touch (soft edge)

    const edges = gad.sql.exec(`SELECT DISTINCT kind FROM edge_graph`).toArray() as Array<{
      kind: string;
    }>;
    const edgeKinds = edges.map((e) => e.kind);
    expect(edgeKinds).toContain("committed_in");
    expect(edgeKinds).toContain("asserted");
    expect(edgeKinds).toContain("supports");
    expect(edgeKinds).toContain("observed");

    const rel = gad.sql
      .exec(`SELECT relation, related_claim_id FROM claim_graph WHERE claim_id = ?`, c1)
      .toArray() as Array<{ relation: string | null; related_claim_id: string | null }>;
    expect(rel.some((r) => r.relation === "supports" && r.related_claim_id === c2)).toBe(true);
  });
});
