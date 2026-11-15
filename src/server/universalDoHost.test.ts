import type { RpcFailure } from "@vibestudio/rpc";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
/**
 * Integration test for the UniversalDO facet host — exercises the REAL celld
 * node end-to-end (set `VIBESTUDIO_CELLD_BIN`, or stage `native/celld`):
 *   - a userland DO class loads dynamically into the static `universal-do`
 *     service as a durable facet (no per-class service, no workerd restart),
 *   - dispatch reaches it via `/_u/{packedKey}/{method}`,
 *   - per-facet SQLite storage persists across calls,
 *   - a NEW userland DO class needs no restart (boot generation unchanged),
 *   - distinct object keys get isolated facet storage.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ledgerTest } from "../../tests/helpers/ledgerTest.js";

import { TokenManager } from "@vibestudio/shared/tokenManager";
import {
  schemaProbeEnvironmentForFixture,
  useSchemaProbeFixtureCache,
} from "../../tests/fixtures/schemaProbeEnvironment.js";
useSchemaProbeFixtureCache();
import {
  RuntimeManager,
  type RuntimeManagerDeps,
  type WorkerdWorkspaceProvider,
} from "./runtimeManager.js";
import { SingletonRegistry } from "@vibestudio/workspace/singletonRegistry";
import { encodeUniversalKey } from "./doDispatch.js";
import { doExecutableHeaders, type DoExecutableAdmission } from "./doExecutableDispatch.js";
import type { BuildResult } from "./buildV2/buildStore.js";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  verifyExecutionArtifactRef,
  type ExecutionArtifactRefV1,
} from "@vibestudio/shared/execution/retention";
import { sha256 } from "@vibestudio/shared/execution/identity";
import { celldTestBinary, nodeProxy } from "../../tests/helpers/celldNodeHarness.js";
import { beginDurableObjectRelay } from "./workerdRpcRelay.js";
import {
  cleanupStoredBuildFixtures,
  storedBuildFixture,
} from "../../tests/helpers/storedBuildFixture.js";

const EGRESS_SECRET = "universal-do-host-egress-secret";
// The product's runtime application (dist/runtime-app.json) on the fork's node.
const celldBinary = celldTestBinary();

function runtimeArtifact(source: string, ref = "main"): ExecutionArtifactRefV1 {
  const contentRoots = [
    { repoPath: source, stateHash: `state:${sha256(`state:${source}:${ref}`)}` },
  ];
  const unsigned = {
    version: 1 as const,
    sourceState: {
      kind: "workspace" as const,
      workspaceId: "workspace:universal-do-host-test",
      effectiveVersion: sha256(`ev:${source}:${ref}`),
      state: { kind: "event" as const, eventId: `event:${source}:${ref}` },
      contentRoots,
      sourceClosureDigest: executionSourceClosureDigest(contentRoots),
    },
    recipeDigest: sha256(`recipe:${source}`),
    buildKey: sha256(`build:${source}:${ref}`),
    artifactDigest: sha256(`artifact:${source}:${ref}`),
  };
  return verifyExecutionArtifactRef({
    ...unsigned,
    executionDigest: executionArtifactDigest(unsigned),
  });
}

const COUNTER_DO = `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
let unitConstructors = 0;
export class VibestudioExecutable extends WorkerEntrypoint {
  fetch() { return new Response(null, {status:204}); }
}
export class CounterDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    unitConstructors++;
    this.ctx = ctx; this.env = env;
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS c (n INTEGER)");
  }
  async fetch(request) {
    if (this.env.VIBESTUDIO_SCHEMA_PROBE === true) {
      return Response.json({
        className: "CounterDO", version: 1, nativeOwner: false, durableWorkQueues: [],
        freshSchemaFingerprint: JSON.stringify([...this.ctx.storage.sql.exec(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name = 'c' ORDER BY type, name"
        )]),
      });
    }
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const userKey = parts[0] ? decodeURIComponent(parts[0]) : "";
    const method = parts.slice(1).join("/") || "get";
    if (method === "network") {
      const response = await fetch("http://shared-unit-egress.invalid/probe");
      return Response.json({ result: await response.json() });
    }
    if (method === "generation") return Response.json({result:"v1"});
    if (method === "compile") {
      // Code generation from a string: only a class the deployment declares may do it.
      const attempt = (compile) => { try { return { ok: compile() }; } catch (error) { return { error: String(error && error.message || error) }; } };
      return Response.json({result:{
        newFunction: attempt(() => new Function("return 1")()),
        indirectEval: attempt(() => (0, eval)("1")),
      }});
    }
    if (method === "failure") throw new Error("Original provider failure (503)");
    if (method === "instance") {
      this.localCalls = (this.localCalls || 0) + 1;
      return Response.json({result:{unitConstructors,localCalls:this.localCalls,held:this.held === true,stateArgs:this.ctx.props.stateArgs,hasStateArgsEnv:Object.hasOwn(this.env,"STATE_ARGS"),key:userKey}});
    }
    if (method === "hold") {
      this.held = true;
      await new Promise(() => {});
    }
    if (request.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (method === "incr") {
      this.ctx.storage.sql.exec("INSERT INTO c (n) VALUES (1)");
    }
    const total = [...this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM c").raw()][0][0];
    return new Response(JSON.stringify({ result: {
      count: total, source: this.env.WORKER_SOURCE, cls: this.env.WORKER_CLASS_NAME, key: userKey,
    }}), { headers: { "content-type": "application/json" } });
  }
  async webSocketMessage(ws, msg) {
    this.ctx.storage.sql.exec("INSERT INTO c (n) VALUES (1)");
    ws.send("echo:" + msg + ":" + this.env.WORKER_CLASS_NAME);
  }
  async webSocketClose(ws, code, reason) {
    ws.close(code, reason);
  }
}
export default { fetch() { return new Response("counter host"); } };`;

/** An entity that hosts code: it forwards a hosting request through its CODE_HOST binding. */
const HOST_DO = `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
export class VibestudioExecutable extends WorkerEntrypoint {
  fetch() { return new Response(null, {status:204}); }
}
export class HostDO extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; }
  async fetch(request) {
    if (this.env.VIBESTUDIO_SCHEMA_PROBE === true)
      return Response.json({ className: "HostDO", version: 1, nativeOwner: false, durableWorkQueues: [], freshSchemaFingerprint: "[]" });
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    const method = parts.slice(1).join("/");
    if (method === "compile") {
      try { return Response.json({ result: { ok: new Function("return 1")() } }); }
      catch (error) { return Response.json({ result: { error: String(error && error.message || error) } }); }
    }
    if (method === "props") {
      return Response.json({ result: { hasCodeHost: Boolean(this.env.CODE_HOST), codeHost: this.ctx.props.codeHost ? Object.keys(this.ctx.props.codeHost) : null } });
    }
    // "code" passes a hosting request through the binding; "forged" breaks the proof.
    const proof = this.ctx.props.codeHost;
    const body = JSON.parse(await request.text());
    const response = await this.env.CODE_HOST.fetch("http://code-host/", {
      method: "POST",
      headers: { "X-Code-Host-Name": body.name ?? proof.name, "X-Code-Host-Proof": method === "forged" ? "AAAA" : proof.proof },
      body: JSON.stringify(body.request),
    });
    return Response.json({ result: { status: response.status, body: await response.text() } });
  }
}
export default { fetch() { return new Response("host"); } };`;

/** A hosted class: a Dolt facet whose class holds codegen and residency, reached only through its root. */
const KERNEL_DO = `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
export class VibestudioExecutable extends WorkerEntrypoint {
  fetch() { return new Response(null, {status:204}); }
}
export class KernelDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx; this.env = env; this.runs = 0;
  }
  async fetch(request) {
    if (this.env.VIBESTUDIO_SCHEMA_PROBE === true)
      return Response.json({ className: "KernelDO", version: 1, nativeOwner: false, durableWorkQueues: [], freshSchemaFingerprint: "[]" });
    const sql0 = this.ctx.storage.sql;
    if (sql0.exec("SELECT name FROM sqlite_master WHERE name = 'runs'").toArray().length === 0)
      this.ctx.storage.transactionSync(() => sql0.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY, status TEXT NOT NULL)"), { commit: "kernel schema" });
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    if (parts[1] !== "__hosted") return new Response("not hosted", { status: 404 });
    const method = parts[2];
    const { args = [], reason } = JSON.parse(await request.text() || "{}");
    const sql = this.ctx.storage.sql;
    const commit = (message, write) => this.ctx.storage.transactionSync(write, { commit: message });
    if (method === "run") {
      const result = new Function("return " + args[0])();
      this.runs++;
      commit("eval: run " + this.runs, () => sql.exec("INSERT INTO runs(status) VALUES ('ok')"));
      return Response.json({ result: { result, runs: this.runs } });
    }
    if (method === "spin") { for (;;) {} }
    if (method === "who") {
      const props = this.ctx.props;
      return Response.json({ result: { host: props.host && props.host.entityId, hasToken: typeof (props.host && props.host.token) === "string", codeHost: props.codeHost ?? null, hasCodeHostBinding: Object.hasOwn(this.env, "CODE_HOST"), key: parts[0] } });
    }
    if (method === "__revoked") {
      commit("revoked: " + reason, () => sql.exec("INSERT INTO runs(status) VALUES ('revoked')"));
      return Response.json({ result: null });
    }
    if (method === "info")
      return Response.json({ result: { runs: this.runs, log: this.ctx.storage.dolt.log({ limit: 10 }).map((entry) => entry.message), hasHold: typeof this.ctx.residency } });
    return Response.json({ error: { message: "no such method " + method } }, { status: 404 });
  }
}
export default { fetch() { return new Response("kernel"); } };`;

/**
 * A class that can be either engine: the same code on the legacy SQLite facet and on the Dolt
 * facet that replaces it. `notes` is versioned, `local_hits` is a `doltLocal` table. The
 * `__legacy/*` calls are what the product base serves (`@vibestudio/durable/legacyImport`).
 */
const NOTES_DO = `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
export class VibestudioExecutable extends WorkerEntrypoint {
  fetch() { return new Response(null, {status:204}); }
}
export class NotesDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.ctx = ctx; this.env = env;
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS local_hits (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
  }
  async fetch(request) {
    if (this.env.VIBESTUDIO_SCHEMA_PROBE === true)
      return Response.json({ className: "NotesDO", version: 1, nativeOwner: false, durableWorkQueues: [], freshSchemaFingerprint: "[]" });
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    const method = parts.slice(1).join("/");
    const sql = this.ctx.storage.sql;
    const dolt = this.ctx.storage.dolt;
    const body = request.method === "POST" ? JSON.parse((await request.text()) || "null") : null;
    if (method.startsWith("__legacy/")) {
      if (request.headers.get("x-legacy-import-proof") !== (this.ctx.props.codeHost && this.ctx.props.codeHost.proof))
        return Response.json({ error: { message: "Forbidden" } }, { status: 403 });
      const call = method.slice("__legacy/".length);
      if (call === "engine") return Response.json({ result: { engine: dolt ? "dolt" : "sqlite" } });
      if (call === "tables") return Response.json({ result: [
        { name: "notes", columns: ["id", "body"], count: sql.exec("SELECT count(*) AS n FROM notes").one().n },
        { name: "local_hits", columns: ["id", "n"], count: 1 } ] });
      if (call === "rows") {
        const rows = [...sql.exec("SELECT * FROM " + body.table + " ORDER BY id").raw()];
        return Response.json({ result: { columns: body.table === "notes" ? ["id", "body"] : ["id", "n"], rows, next: null } });
      }
      if (call === "load") {
        this.ctx.storage.transactionSync(() => { for (const row of body.rows) sql.exec("INSERT OR REPLACE INTO " + body.table + " (" + body.columns.join(", ") + ") VALUES (" + body.columns.map(() => "?").join(", ") + ")", ...row); });
        return Response.json({ result: body.rows.length });
      }
      if (call === "commit") {
        // Fault injection for the resume test: fail the Nth commit this object's import makes.
        const counts = (globalThis.__importCommits ??= new Map());
        const nth = (counts.get(parts[0]) ?? 0) + 1;
        counts.set(parts[0], nth);
        if (this.ctx.props.stateArgs && this.ctx.props.stateArgs.failOnCommit === nth) throw new Error("injected commit failure " + nth);
        return Response.json({ result: dolt.commit({ message: body.message, allowEmpty: true }) });
      }
    }
    this.ctx.storage.transactionSync(() => {
      sql.exec("INSERT INTO local_hits (id, n) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1");
    });
    if (method === "add") {
      const write = () => sql.exec("INSERT INTO notes (body) VALUES (?)", body);
      if (dolt) this.ctx.storage.transactionSync(write, { commit: "note: " + body });
      else write();
    }
    if (method === "reset-to") dolt.reset({ hard: true, to: body });
    return Response.json({ result: {
      engine: dolt ? "dolt" : "sqlite",
      notes: [...sql.exec("SELECT body FROM notes ORDER BY id").raw()].map((r) => r[0]),
      hits: sql.exec("SELECT n FROM local_hits WHERE id = 1").toArray()[0]?.n ?? 0,
      log: dolt ? dolt.log({ limit: 20 }).map((e) => e.message) : null,
      head: dolt ? dolt.hashOf("HEAD") : null,
      commits: dolt ? dolt.log({ limit: 20 }).map((e) => [e.hash, e.message]) : null,
    }});
  }
}
export default { fetch() { return new Response("notes"); } };`;

/** Runs the SQL features the channel and Pi stores use against a Dolt facet, one try each. */
const DIALECT_DO = `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
export class VibestudioExecutable extends WorkerEntrypoint {
  fetch() { return new Response(null, {status:204}); }
}
export class DialectDO extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; }
  async fetch(request) {
    if (this.env.VIBESTUDIO_SCHEMA_PROBE === true)
      return Response.json({ className: "DialectDO", version: 1, nativeOwner: false, durableWorkQueues: [], freshSchemaFingerprint: "[]" });
    if (!request.url.endsWith("/run")) return Response.json({ result: { engine: this.ctx.storage.dolt ? "dolt" : "sqlite" } });
    const sql = this.ctx.storage.sql;
    const results = {};
    const attempt = (name, fn) => { try { results[name] = { ok: fn() }; } catch (error) { results[name] = { error: String(error && error.message || error) }; } };
    attempt("partial unique index", () => {
      sql.exec("CREATE TABLE p (id TEXT PRIMARY KEY, handle TEXT)");
      sql.exec("CREATE UNIQUE INDEX p_handle ON p(handle) WHERE handle IS NOT NULL");
      sql.exec("INSERT INTO p VALUES ('a', NULL), ('b', NULL), ('c', 'h')");
      try { sql.exec("INSERT INTO p VALUES ('d', 'h')"); return "not unique"; } catch (e) { return /unique/i.test(String(e.message)) ? "enforced" : String(e.message); }
    });
    attempt("check constraint", () => {
      sql.exec("CREATE TABLE ck (n INTEGER CHECK (n > 0), s TEXT CHECK (s IN ('a','b')))");
      try { sql.exec("INSERT INTO ck VALUES (0, 'a')"); return "not enforced"; } catch (e) { return "enforced"; }
    });
    attempt("json functions", () => {
      sql.exec("CREATE TABLE j (id INTEGER PRIMARY KEY, doc TEXT)");
      sql.exec("INSERT INTO j VALUES (1, '{\\"type\\":\\"agent\\",\\"n\\":{\\"a\\":0}}')");
      const a = sql.exec("SELECT json_extract(doc, '$.type') AS t, json_type(doc, '$.n.a') AS ty FROM j").one();
      sql.exec("UPDATE j SET doc = json_set(doc, '$.n.a', json('false'))");
      return [a.t, a.ty, sql.exec("SELECT doc FROM j").one().doc];
    });
    attempt("returning", () => {
      sql.exec("CREATE TABLE r (id INTEGER PRIMARY KEY, v TEXT)");
      return sql.exec("INSERT INTO r (v) VALUES ('x') RETURNING id, v").toArray().length;
    });
    attempt("upsert with where", () => {
      sql.exec("CREATE TABLE u (k TEXT PRIMARY KEY, n INTEGER, m INTEGER)");
      sql.exec("INSERT INTO u VALUES ('k', 1, 1)");
      sql.exec("INSERT INTO u VALUES ('k', 2, 2) ON CONFLICT(k) DO UPDATE SET n = MAX(n, excluded.n) WHERE excluded.n > u.n");
      return sql.exec("SELECT n FROM u").one().n;
    });
    attempt("multi-statement exec", () => { sql.exec("CREATE TABLE m1 (a INTEGER); CREATE TABLE m2 (b INTEGER); INSERT INTO m1 VALUES (1);"); return sql.exec("SELECT count(*) AS n FROM m1").one().n; });
    attempt("insert or replace / ignore", () => { sql.exec("CREATE TABLE ir (k TEXT PRIMARY KEY, v TEXT)"); sql.exec("INSERT OR REPLACE INTO ir VALUES ('a','1')"); sql.exec("INSERT OR REPLACE INTO ir VALUES ('a','2')"); sql.exec("INSERT OR IGNORE INTO ir VALUES ('a','3')"); return sql.exec("SELECT v FROM ir").one().v; });
    attempt("pragma table_info", () => sql.exec("PRAGMA table_info(ir)").toArray().map((r) => r.name));
    attempt("table_info shape", () => {
      sql.exec("CREATE TABLE ti (item_id TEXT PRIMARY KEY, kind TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, disposition TEXT NOT NULL DEFAULT 'ready', note TEXT)");
      return sql.exec("PRAGMA table_info(ti)").toArray();
    });
    attempt("pragma foreign_keys", () => { sql.exec("PRAGMA foreign_keys = ON"); return "accepted"; });
    attempt("strict table", () => { sql.exec("CREATE TABLE st (id INTEGER PRIMARY KEY, b BLOB, t TEXT) STRICT"); return "created"; });
    attempt("blob and bigint", () => { sql.exec("CREATE TABLE bl (id INTEGER PRIMARY KEY, b BLOB)"); sql.exec("INSERT INTO bl VALUES (1, ?)", new Uint8Array([1,2,3])); return [...new Uint8Array(sql.exec("SELECT b FROM bl").one().b)]; });
    attempt("total_changes", () => typeof sql.exec("SELECT total_changes() AS n").one().n);
    attempt("sqlite_master text", () => sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'p'").toArray().length);
    attempt("dolt_log columns", () => Object.keys(sql.exec("SELECT * FROM dolt_log LIMIT 1").toArray()[0] || {}));
    return Response.json({ result: results });
  }
}
export default { fetch() { return new Response("dialect"); } };`;

/**
 * The channel's write shape on a Dolt facet, for the commit-volume measurement (R1): per event one
 * committed transaction that appends a ledger row (`body` bytes, in 64 KiB chunks) and one plain
 * transaction for the local projection (mailbox row and cursor), as the channel does.
 */
const LOAD_DO = `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
export class VibestudioExecutable extends WorkerEntrypoint {
  fetch() { return new Response(null, {status:204}); }
}
export class LoadDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.ctx = ctx; this.env = env;
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS ledger (sequence INTEGER PRIMARY KEY, envelope_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, body TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS local_mailbox (delivery_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, state TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS local_cursor (singleton INTEGER PRIMARY KEY, through INTEGER NOT NULL)");
  }
  async fetch(request) {
    if (this.env.VIBESTUDIO_SCHEMA_PROBE === true)
      return Response.json({ className: "LoadDO", version: 1, nativeOwner: false, durableWorkQueues: [], freshSchemaFingerprint: "[]" });
    const url = new URL(request.url);
    const method = url.pathname.split("/").filter(Boolean).slice(1).join("/");
    if (method === "__legacy/engine") return Response.json({ result: { engine: "dolt" } });
    const input = JSON.parse((await request.text()) || "{}");
    const sql = this.ctx.storage.sql;
    const dolt = this.ctx.storage.dolt;
    const stat = (xs) => { const s = [...xs].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length }; };
    if (method === "load") {
      const body = "x".repeat(input.bytes);
      const base = Number(sql.exec("SELECT COALESCE(MAX(sequence), 0) AS n FROM ledger").one().n);
      const append = [], local = [], both = [];
      for (let i = 1; i <= input.events; i++) {
        const sequence = base + i;
        const t0 = performance.now();
        this.ctx.storage.transactionSync(() => sql.exec("INSERT INTO ledger VALUES (?, ?, 'message', ?)", sequence, "env-" + sequence, body), { commit: "channel: append " + sequence + " message env-" + sequence });
        const t1 = performance.now();
        this.ctx.storage.transactionSync(() => {
          sql.exec("INSERT INTO local_mailbox VALUES (?, ?, 'ready')", "d-" + sequence, sequence);
          sql.exec("INSERT INTO local_cursor VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET through = excluded.through", sequence);
        });
        const t2 = performance.now();
        append.push(t1 - t0); local.push(t2 - t1); both.push(t2 - t0);
      }
      return Response.json({ result: { commits: dolt.log({ limit: 1_000_000 }).length, append: stat(append), local: stat(local), both: stat(both) } });
    }
    if (method === "gc") { const t0 = performance.now(); dolt.gc(); return Response.json({ result: { ms: performance.now() - t0 } }); }
    if (method === "reads") {
      const t0 = performance.now();
      const head = Number(sql.exec("SELECT MAX(sequence) AS n FROM ledger").one().n);
      const t1 = performance.now();
      const hash = sql.exec("SELECT commit_hash FROM dolt_log WHERE message LIKE ? ORDER BY date DESC LIMIT 1", "channel: append " + Math.floor(head / 2) + " %").toArray()[0];
      const t2 = performance.now();
      const at = Number(sql.exec("SELECT COALESCE(MAX(sequence), 0) AS n FROM dolt_at_ledger('" + hash.commit_hash + "')").one().n);
      const t3 = performance.now();
      return Response.json({ result: { head, headMs: t1 - t0, commitLookupMs: t2 - t1, atMs: t3 - t2, at } });
    }
    return Response.json({ error: { message: "no such method " + method } }, { status: 404 });
  }
}
export default { fetch() { return new Response("load"); } };`;

const SCHEMA_PROBE_DO = `import { DurableObject } from "cloudflare:workers";
export class SchemaProbeDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.ctx = ctx; this.env = env;
    this.ctx.storage.sql.exec("CREATE TABLE cards (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
    this.ctx.storage.sql.exec("CREATE INDEX cards_title ON cards(title)");
  }
  async fetch() {
    const shape = JSON.stringify([...this.ctx.storage.sql.exec(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name IN ('cards', 'cards_title') ORDER BY type, name"
    )]);
    const descriptor = {
      className: "SchemaProbeDO", version: 1, freshSchemaFingerprint: shape, nativeOwner: false, durableWorkQueues: [],
    };
    if (this.env.VIBESTUDIO_SCHEMA_PROBE === true) {
      let outboundSucceeded = false;
      try { await fetch("http://schema-probe.invalid/forbidden"); outboundSucceeded = true; } catch {}
      if (outboundSucceeded) throw new Error("schema probe acquired outbound access");
      return Response.json(descriptor);
    }
    const trusted = this.env.VIBESTUDIO_SCHEMA_DESCRIPTOR;
    if (!trusted || trusted.className !== descriptor.className || trusted.version !== descriptor.version ||
      trusted.freshSchemaFingerprint !== descriptor.freshSchemaFingerprint) {
      return new Response("missing trusted schema descriptor", { status: 500 });
    }
    return Response.json({ result: descriptor });
  }
}
export default { fetch() { return new Response("probe host"); } };`;

function doBuild(
  source: string,
  ev: string,
  bundle = COUNTER_DO,
  extraArtifacts: BuildResult["artifacts"] = []
): BuildResult {
  const buildKey = `build:${source}:${ev}`;
  return {
    dir: "/tmp/test-build",
    buildKey,
    sourceStateHash: "state:test",
    metadata: {
      kind: "worker",
      name: source,
      buildKey,
      sourcePath: source,
      ev,
      sourceStateHash: "state:test",
      sourcemap: false,
      authority: { requests: [], provides: [], serviceRequests: [] },
      executableModules: [
        {
          moduleId: source + "/index.ts",
          package: { kind: "workspace", name: source, effectiveVersion: ev },
          format: "ts",
          source: bundle,
          contentDigest: sha256(bundle),
        },
      ],
      details: { kind: "generic" },
      builtAt: "2026-01-01T00:00:00.000Z",
    },
    artifacts: [
      {
        path: "worker.js",
        role: "primary",
        contentType: "text/javascript; charset=utf-8",
        encoding: "utf8",
        content: bundle,
      },
      ...extraArtifacts,
    ],
  };
}

interface Harness {
  ownedPaths: string[];
  manager: RuntimeManager;
  gateway: Server;
  codeFetches: Map<string, number>;
  admissionFetches: Map<string, number>;
  dispatch: (
    ref: { source: string; className: string; objectKey: string },
    method: string,
    body?: string
  ) => Promise<unknown>;
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
}

async function createHarness(
  builds: Record<string, BuildResult>,
  hooks: {
    onAdmission?: (
      ref: { source: string; className: string; objectKey: string },
      admission: DoExecutableAdmission
    ) => Promise<void>;
    /** `durable.classes` of each source, as the workspace graph would report them. */
    manifests?: Record<
      string,
      Array<{
        className: string;
        hosts?: Array<{ source: string; className: string }>;
        hosted?: import("@vibestudio/shared/types").HostedClassManifest;
      }>
    >;
  } = {}
): Promise<Harness> {
  const tokenManager = new TokenManager();
  const boundBuilds = new Map<string, BuildResult>(
    Object.values(builds)
      .filter((build) => build.metadata.execution)
      .map((build) => [build.buildKey, build])
  );
  // Construct the manager first (its getServerUrl reads the port lazily via the
  // holder) so the gateway closure below can reference a `const` manager.
  const portHolder = { value: 0 };
  const statePath = mkdtempSync(join(tmpdir(), "vibestudio-udo-state-"));

  const deps: RuntimeManagerDeps = {
    schemaProbeEnvironment: schemaProbeEnvironmentForFixture("universal-do-host-test"),
    schemaProbeReleaseRoot: join(statePath, "installed-resources"),
    tokenManager,
    fsService: { closeHandlesForCaller: () => {} } as unknown as RuntimeManagerDeps["fsService"],
    getServerUrl: () => `http://127.0.0.1:${portHolder.value}`,
    workspaceId: "workspace:universal-do-host-test",
    getInternalDoEnv: () => ({}),
    workspacePath: mkdtempSync(join(tmpdir(), "vibestudio-udo-ws-")),
    statePath,
    getSharedEgressPort: () => Promise.resolve(portHolder.value),
    registerEgressCaller: () => {},
    unregisterEgressCaller: () => {},
    egressSecret: EGRESS_SECRET,
    getWorkerdGatewayToken: () => "udo-gateway-token",
  };
  const provider: WorkerdWorkspaceProvider = {
    bindRuntimeImage: async (source: string, ref?: string) => {
      const b = builds[source];
      if (!b) throw new Error(`no build for ${source}`);
      const artifact = runtimeArtifact(source, ref ?? "main");
      boundBuilds.set(artifact.buildKey, {
        ...b,
        buildKey: artifact.buildKey,
        metadata: {
          ...b.metadata,
          buildKey: artifact.buildKey,
          execution: artifact,
          ev: artifact.sourceState.effectiveVersion,
          sourceState: artifact.sourceState.state,
        },
      });
      return {
        source,
        unitName: source,
        artifact,
        authority: { requests: [], provides: [], serviceRequests: [] },
      };
    },
    getBuildByKey: async (key: string) => {
      const build = boundBuilds.get(key);
      return build ? storedBuildFixture(build) : null;
    },
    readBuildArtifactContent: async (build, artifact) => {
      const bytes = await readFile(join(build.dir, artifact.path));
      return artifact.encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8");
    },
    getBuildByExecution: async (key: string, executionDigest: string) => {
      const build = boundBuilds.get(key) ?? null;
      return build?.metadata.execution?.executionDigest === executionDigest
        ? storedBuildFixture(build)
        : null;
    },
    getManifestRoutes: () => [],
    getManifestDoClasses: (source: string) => hooks.manifests?.[source] ?? [],
    singletonRegistry: new SingletonRegistry([]),
  };
  const manager = new RuntimeManager(deps);
  manager.bindWorkspaceProvider(provider);
  const codeFetches = new Map<string, number>();
  const admissionFetches = new Map<string, number>();

  // The node reaches this gateway, and sends all egress, through one proxy
  // listener: loaded code's traffic is answered with who the node says it is.
  const gatewayHandler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? "";
    const secret = req.headers["x-vibestudio-loader-secret"];
    if (url.startsWith("/_doadmission/")) {
      if (secret !== manager.getDoLoaderSecret()) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      const requested = new URL(url, "http://gateway");
      const [source, className] = requested.pathname
        .slice("/_doadmission/".length)
        .split("/")
        .map(decodeURIComponent);
      const objectKey = requested.searchParams.get("objectKey");
      const executableVersion = requested.searchParams.get("executableVersion");
      const incarnationVersion = requested.searchParams.get("incarnationVersion");
      if (!source || !className || !objectKey || !executableVersion || !incarnationVersion) {
        res.writeHead(400);
        res.end("Incomplete admission");
        return;
      }
      admissionFetches.set(objectKey, (admissionFetches.get(objectKey) ?? 0) + 1);
      const admission = manager.getDoAdmission(source, className, objectKey);
      if (
        !admission ||
        admission.executableVersion !== executableVersion ||
        admission.incarnationVersion !== incarnationVersion
      ) {
        res.writeHead(409);
        res.end("Admission changed");
        return;
      }
      void Promise.resolve(hooks.onAdmission?.({ source, className, objectKey }, admission)).then(
        () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(admission));
        },
        (error) => {
          res.writeHead(500);
          res.end(error instanceof Error ? error.message : String(error));
        }
      );
      return;
    }
    if (url.startsWith("/_dohost/")) {
      if (secret !== manager.getDoLoaderSecret()) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      const requested = new URL(url, "http://gateway");
      const [hostedSource, hostedClass] = requested.pathname
        .slice("/_dohost/".length)
        .split("/")
        .map(decodeURIComponent);
      const [hostSource, hostClass, hostObjectKey] = (requested.searchParams.get("host") ?? "")
        .split("|")
        .map(decodeURIComponent);
      void manager
        .admitHostedCode(
          { source: hostSource!, className: hostClass!, objectKey: hostObjectKey! },
          { source: hostedSource!, className: hostedClass! }
        )
        .then(
          (admission) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(admission));
          },
          (error: unknown) => {
            const code = (error as { code?: string }).code;
            res.writeHead(code === "EACCES" ? 403 : code === "ENOTFOUND" ? 404 : 409);
            res.end(error instanceof Error ? error.message : String(error));
          }
        );
      return;
    }
    if (url.startsWith("/_docode/")) {
      if (secret !== manager.getDoLoaderSecret()) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      const segs = (url.slice("/_docode/".length).split("?")[0] ?? "").split("/");
      const source = decodeURIComponent(segs[0] ?? "");
      const className = decodeURIComponent(segs[1] ?? "");
      const objectKey = new URL(url, "http://gateway").searchParams.get("objectKey") ?? "";

      codeFetches.set(objectKey, (codeFetches.get(objectKey) ?? 0) + 1);
      void Promise.resolve()
        .then(() =>
          manager.getDoCode(
            source,
            className,
            new URL(url, "http://gateway").searchParams.get("version") ?? "",
            objectKey
          )
        )
        .then((code) => {
          if (!code) {
            res.writeHead(404);
            res.end("nf");
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(code));
        })
        .catch((error: unknown) => {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(error instanceof Error ? error.message : String(error));
        });
      return;
    }
    res.writeHead(404);
    res.end("nf");
  };
  const proxy = nodeProxy({
    secret: EGRESS_SECRET,
    gateway: gatewayHandler,
    other: ({ identity }, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ caller: identity.egressIdentity[0] ?? null }));
    },
  });
  const gateway = createServer(proxy.listener);
  portHolder.value = await listen(gateway);

  const dispatch = async (
    ref: { source: string; className: string; objectKey: string },
    method: string,
    body = "[]"
  ): Promise<unknown> => {
    const port = manager.getPort();
    if (!port) throw new Error("workerd not running");
    const key = encodeUniversalKey(ref);
    const res = await fetch(`http://127.0.0.1:${port}/_u/${encodeURIComponent(key)}/${method}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer udo-gateway-token",
        "X-Vibestudio-Dispatch-Secret": manager.getDispatchSecret(),
        ...doExecutableHeaders(ref, (key) =>
          manager.getDoAdmission(key.source, key.className, key.objectKey)
        ),
        "Content-Type": "application/json",
      },
      body,
    });
    if (!res.ok) throw new Error(`dispatch failed ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { result: unknown }).result;
  };

  return {
    manager,
    gateway,
    codeFetches,
    admissionFetches,
    dispatch,
    ownedPaths: [deps.workspacePath, deps.statePath],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bindConfiguredObject(
  manager: RuntimeManager,
  ref: { source: string; className: string; objectKey: string },
  stateArgs: Record<string, unknown>
) {
  const prepared = await manager.ensureDurableObjectEntity({
    source: ref.source,
    className: ref.className,
    key: ref.objectKey,
    ref: "main",
    contextId: "configured-context",
    stateArgs,
  });
  await manager.restoreDurableObjectEntity({
    id: prepared.targetId,
    kind: "do",
    className: ref.className,
    key: ref.objectKey,
    source: { repoPath: ref.source, effectiveVersion: prepared.effectiveVersion },
    activeBuildKey: prepared.buildKey,
    activeExecutionDigest: prepared.executionDigest,
    activeAuthority: prepared.authority,
    stateArgs,
    contextId: "configured-context",
    createdAt: 1,
    status: "active",
    cleanupComplete: false,
  });
  return manager.getDoAdmission(ref.source, ref.className, ref.objectKey)!;
}

let active: Harness | null = null;
afterEach(async () => {
  if (active) {
    const owned = active;
    active = null;
    try {
      await owned.manager.shutdown();
    } finally {
      await new Promise<void>((r) => owned.gateway.close(() => r()));
      for (const ownedPath of owned.ownedPaths) rmSync(ownedPath, { recursive: true, force: true });
      cleanupStoredBuildFixtures();
    }
  }
});

function cloneReservation(
  source: { source: string; className: string; objectKey: string },
  key: string,
  manager: RuntimeManager
): EntityRecord {
  const sourceId = `do:${source.source}:${source.className}:${source.objectKey}`;
  const image = manager.listRuntimeImages().find((entry) => entry.id === sourceId);
  if (!image) throw new Error(`Missing exact source fixture image ${sourceId}`);
  return {
    id: `do:${source.source}:${source.className}:${key}`,
    kind: "do",
    source: { repoPath: source.source, effectiveVersion: "" },
    className: source.className,
    key,
    contextId: `clone:${key}`,
    authoritySessionId: `clone-session:${key}`,
    status: "preparing",
    createdAt: 1,
    cleanupComplete: true,
    cloneProvenance: {
      storage: "snapshot",
      operationContextId: `clone:${key}`,
      sourceEntityId: sourceId,
      sourceContextId: "source-context",
      sourceAuthoritySessionId: "source-session",
      sourceBuildKey: image.artifact.buildKey,
      sourceExecutionDigest: image.artifact.executionDigest,
    },
  };
}

function sourceOwner(reservation: EntityRecord): EntityRecord {
  const source = reservation.cloneProvenance!;
  return {
    ...reservation,
    id: source.sourceEntityId,
    key: source.sourceEntityId.slice(
      `do:${reservation.source.repoPath}:${reservation.className}:`.length
    ),
    contextId: source.sourceContextId,
    authoritySessionId: source.sourceAuthoritySessionId,
    activeBuildKey: source.sourceBuildKey,
    activeExecutionDigest: source.sourceExecutionDigest,
    activeAuthority: { provides: [], requests: [] },
    status: "active",
    cloneProvenance: undefined,
  };
}

describe.skipIf(!celldBinary)("UniversalDO facet host (real celld)", () => {
  beforeEach(() => {
    vi.stubEnv("VIBESTUDIO_CELLD_BIN", celldBinary!);
  });

  it("preserves application failures containing HTTP status text", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");
    const ref = { source: "workers/counter", className: "CounterDO", objectKey: "failure" };
    await expect(dispatch(ref, "failure")).rejects.toThrow("dispatch failed 500");
    await expect(dispatch(ref, "failure")).rejects.toThrow("Original provider failure (503)");
    expect(await dispatch(ref, "get")).toMatchObject({ count: 0 });
  });
  it("confines code generation: a userland object cannot compile what it was not deployed with", async () => {
    // P2 confinement gate (docs/dolt-redesign.md section 10): only the isolate pool of a class the
    // deployment declares `codegen` (eval kernel today, the kernel facet's loader grant later) compiles.
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");
    const ref = { source: "workers/counter", className: "CounterDO", objectKey: "compile" };
    const result = (await dispatch(ref, "compile")) as Record<
      string,
      { ok?: unknown; error?: string }
    >;
    expect(result["newFunction"]?.ok).toBeUndefined();
    expect(result["newFunction"]?.error).toMatch(/code generation|eval|Function/i);
    expect(result["indirectEval"]?.ok).toBeUndefined();
    expect(result["indirectEval"]?.error).toMatch(/code generation|eval/i);
  }, 30_000);

  it("shares executable code while isolating SQLite, fields and retirement cancellation", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch, codeFetches } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");
    const first = { source: "workers/counter", className: "CounterDO", objectKey: "shared-first" };
    const second = { ...first, objectKey: "shared-second" };
    expect(await dispatch(first, "incr")).toMatchObject({ count: 1 });
    expect(await dispatch(second, "get")).toMatchObject({ count: 0 });
    expect(await dispatch(first, "instance")).toMatchObject({
      localCalls: 1,
      key: first.objectKey,
    });
    expect(await dispatch(second, "instance")).toMatchObject({
      localCalls: 1,
      key: second.objectKey,
    });
    expect([...codeFetches.values()].reduce((sum, value) => sum + value, 0)).toBe(1);
    const boot = manager.getBootGeneration();
    // A request running in a facet that is retired fails: celld rejects the
    // facet's pending call and the root's response goes out.
    const held = dispatch(first, "hold").then(
      () => ({ ok: true }),
      (error) => ({ error })
    );
    // A second request to this exact facet proves the first request entered its
    // owning instance before retirement; no time-based readiness surrogate.
    expect(await dispatch(first, "instance")).toMatchObject({ localCalls: 2, held: true });
    await manager.retireDOEntity(first);
    expect(await held).toHaveProperty("error");
    expect(manager.getBootGeneration()).toBe(boot);
    expect(await dispatch(second, "instance")).toMatchObject({ localCalls: 2, held: false });
    expect(await dispatch(first, "instance")).toMatchObject({ localCalls: 1, held: false });
    expect(await dispatch(first, "get")).toMatchObject({ count: 1 });
    expect([...codeFetches.values()].reduce((sum, value) => sum + value, 0)).toBe(1);
  }, 30_000);

  it("prepares the actual unit without constructing an object and reuses it on first demand", async () => {
    const source = "workers/prepared-counter";
    const build = doBuild(source, "ev-1");
    const artifact = runtimeArtifact(source, "main");
    const preparedBuild: BuildResult = {
      ...build,
      buildKey: artifact.buildKey,
      metadata: {
        ...build.metadata,
        buildKey: artifact.buildKey,
        execution: artifact,
        ev: artifact.sourceState.effectiveVersion,
        sourceState: artifact.sourceState.state,
      },
    };
    active = await createHarness({ [source]: preparedBuild });
    const { manager, dispatch, codeFetches, admissionFetches } = active;
    await manager.prepareWorkerExecutable(storedBuildFixture(preparedBuild), ["CounterDO"]);
    expect(manager.getDoAdmission(source, "CounterDO", "first")).toBeNull();
    const fetchedBeforeDemand = [...codeFetches.values()].reduce((sum, value) => sum + value, 0);
    const instructions = "Native instructions: λ 日本語 🧭\n".repeat(6000);
    expect(Buffer.byteLength(instructions)).toBeGreaterThanOrEqual(128 * 1024);
    const stateArgs = { prepared: true, instructions };
    const prepared = await manager.ensureDurableObjectEntity({
      source,
      className: "CounterDO",
      key: "first",
      ref: "main",
      contextId: "prepared-context",
      stateArgs,
    });
    await manager.restoreDurableObjectEntity({
      id: prepared.targetId,
      kind: "do",
      className: "CounterDO",
      key: "first",
      source: { repoPath: source, effectiveVersion: prepared.effectiveVersion },
      activeBuildKey: prepared.buildKey,
      activeExecutionDigest: prepared.executionDigest,
      activeAuthority: prepared.authority,
      stateArgs,
      contextId: "prepared-context",
      createdAt: 1,
      status: "active",
      cleanupComplete: false,
    });
    const configured = (await dispatch(
      { source, className: "CounterDO", objectKey: "first" },
      "instance"
    )) as {
      unitConstructors: number;
      localCalls: number;
      stateArgs: { prepared: boolean; instructions: string };
      hasStateArgsEnv: boolean;
    };
    expect(configured.unitConstructors).toBe(1);
    expect(configured.localCalls).toBe(1);
    expect(configured.hasStateArgsEnv).toBe(false);
    expect(configured.stateArgs.prepared).toBe(true);
    expect(configured.stateArgs.instructions.length).toBe(instructions.length);
    expect(sha256(configured.stateArgs.instructions)).toBe(sha256(instructions));
    expect(admissionFetches.get("first")).toBe(1);
    const ref = { source, className: "CounterDO", objectKey: "first" };
    expect(
      Object.keys(
        doExecutableHeaders(ref, (key) =>
          manager.getDoAdmission(key.source, key.className, key.objectKey)
        )
      ).sort()
    ).toEqual(["X-Vibestudio-Executable-Version", "X-Vibestudio-Incarnation-Version"]);
    await dispatch(ref, "get");
    expect(admissionFetches.get("first")).toBe(1);
    expect([...codeFetches.values()].reduce((sum, value) => sum + value, 0)).toBe(
      fetchedBeforeDemand
    );
    const inspector = manager.getInspectorUrl();
    expect(inspector).not.toBeNull();
    const targets = (await fetch(`${inspector}/json/list`).then((response) =>
      response.json()
    )) as Array<{ title: string }>;
    // The prepared unit is a dynamic worker's isolate (celld names it `__loader:<n>`).
    expect(targets.some((target) => target.title.includes("celld dynamic worker isolate"))).toBe(
      true
    );
  });

  it("keeps shared executable network egress alive after the first loading object retires", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch, codeFetches } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");
    const first = { source: "workers/counter", className: "CounterDO", objectKey: "network-first" };
    const second = { ...first, objectKey: "network-second" };
    const before = await dispatch(first, "network");
    expect(before).toMatchObject({
      caller: expect.stringMatching(/^do-code:workers\/counter:CounterDO:/),
    });
    expect(await dispatch(second, "network")).toEqual(before);
    await manager.retireDOEntity(first);
    expect(await dispatch(second, "network")).toEqual(before);
    expect([...codeFetches.values()].reduce((sum, value) => sum + value, 0)).toBe(1);
  }, 30_000);

  it("coalesces concurrent cold requests into one exact configured facet", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    active = await createHarness(
      { "workers/counter": doBuild("workers/counter", "ev-1") },
      {
        onAdmission: async (ref) => {
          if (ref.objectKey === "cold-concurrent") {
            entered.resolve();
            await release.promise;
          }
        },
      }
    );
    const { manager, dispatch, admissionFetches } = active;
    const ref = { source: "workers/counter", className: "CounterDO", objectKey: "cold-concurrent" };
    await bindConfiguredObject(manager, ref, { configuration: "shared" });
    const first = dispatch(ref, "instance");
    await entered.promise;
    const second = dispatch(ref, "instance");
    try {
      release.resolve();
      const responses = (await Promise.all([first, second])) as Array<{
        unitConstructors: number;
        localCalls: number;
        stateArgs: { configuration: string };
      }>;
      expect(responses.map((value) => value.localCalls).sort((a, b) => a - b)).toEqual([1, 2]);
      expect(
        responses.every(
          (value) => value.unitConstructors === 1 && value.stateArgs.configuration === "shared"
        )
      ).toBe(true);
      expect(admissionFetches.get(ref.objectKey)).toBe(1);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
  }, 30_000);

  it("joins a pending cold admission before retiring its object", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    active = await createHarness(
      { "workers/counter": doBuild("workers/counter", "ev-1") },
      {
        onAdmission: async (ref) => {
          if (ref.objectKey === "admission-retirement") {
            entered.resolve();
            await release.promise;
          }
        },
      }
    );
    const { manager, dispatch, codeFetches } = active;
    const ref = {
      source: "workers/counter",
      className: "CounterDO",
      objectKey: "admission-retirement",
    };
    await bindConfiguredObject(manager, ref, { configuration: "retiring" });
    const preparedCodeFetches = [...codeFetches.values()].reduce((sum, count) => sum + count, 0);
    const pending = dispatch(ref, "instance").then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    await entered.promise;
    try {
      await manager.retireDOEntity(ref);
      expect(await pending).toHaveProperty("error");
      expect([...codeFetches.values()].reduce((sum, count) => sum + count, 0)).toBe(
        preparedCodeFetches
      );
      release.resolve();
      const sibling = (await dispatch({ ...ref, objectKey: "retirement-sibling" }, "instance")) as {
        unitConstructors: number;
      };
      expect(sibling.unitConstructors).toBe(1);
    } finally {
      release.resolve();
      await pending;
    }
  }, 30_000);

  it("does not let a late old admission overwrite a newer configured facet", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    active = await createHarness(
      { "workers/counter": doBuild("workers/counter", "ev-1") },
      {
        onAdmission: async (ref, admission) => {
          if (
            ref.objectKey === "admission-advance" &&
            admission.props.stateArgs?.["configuration"] === "old"
          ) {
            entered.resolve();
            await release.promise;
          }
        },
      }
    );
    const { manager, dispatch } = active;
    const ref = {
      source: "workers/counter",
      className: "CounterDO",
      objectKey: "admission-advance",
    };
    await bindConfiguredObject(manager, ref, { configuration: "old" });
    const old = dispatch(ref, "instance").then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    await entered.promise;
    try {
      await bindConfiguredObject(manager, ref, { configuration: "new" });
      const current = (await dispatch(ref, "instance")) as {
        unitConstructors: number;
        localCalls: number;
        stateArgs: { configuration: string };
      };
      expect(current.unitConstructors).toBe(1);
      expect(current.localCalls).toBe(1);
      expect(current.stateArgs.configuration).toBe("new");
      release.resolve();
      expect(await old).toHaveProperty("error");
      const retained = (await dispatch(ref, "instance")) as {
        unitConstructors: number;
        localCalls: number;
        stateArgs: { configuration: string };
      };
      expect(retained.unitConstructors).toBe(1);
      expect(retained.localCalls).toBe(2);
      expect(retained.stateArgs.configuration).toBe("new");
    } finally {
      release.resolve();
      await old;
    }
  }, 30_000);

  it("shares code across exact per-object configuration and replaces only the changed incarnation", async () => {
    const builds: Record<string, BuildResult> = {
      "workers/counter": doBuild("workers/counter", "ev-1"),
    };
    active = await createHarness(builds);
    const { manager, dispatch, codeFetches } = active;
    const base = { source: "workers/counter", className: "CounterDO" };
    const activate = async (objectKey: string, ref: string, stateArgs: Record<string, unknown>) => {
      const prepared = await manager.ensureDurableObjectEntity({
        ...base,
        key: objectKey,
        ref,
        contextId: "unit-context",
        stateArgs,
      });
      await manager.restoreDurableObjectEntity({
        id: prepared.targetId,
        kind: "do",
        className: base.className,
        key: objectKey,
        source: { repoPath: base.source, effectiveVersion: prepared.effectiveVersion },
        activeBuildKey: prepared.buildKey,
        activeExecutionDigest: prepared.executionDigest,
        activeAuthority: prepared.authority,
        stateArgs,
        contextId: "unit-context",
        createdAt: 1,
        status: "active",
        cleanupComplete: false,
      });
    };
    const first = { ...base, objectKey: "first-config" };
    const sibling = { ...base, objectKey: "sibling-config" };
    await activate(first.objectKey, "ctx:shared", { configuration: "first" });
    await activate(sibling.objectKey, "ctx:shared", { configuration: "sibling" });
    const boot = manager.getBootGeneration();
    const firstAdmission = manager.getDoAdmission(first.source, first.className, first.objectKey)!;
    const siblingAdmission = manager.getDoAdmission(
      sibling.source,
      sibling.className,
      sibling.objectKey
    )!;
    expect(firstAdmission.executableVersion).toBe(siblingAdmission.executableVersion);
    expect(await dispatch(first, "instance")).toMatchObject({
      localCalls: 1,
      unitConstructors: 1,
      stateArgs: { configuration: "first" },
      hasStateArgsEnv: false,
    });
    expect(await dispatch(sibling, "instance")).toMatchObject({
      localCalls: 1,
      unitConstructors: 2,
      stateArgs: { configuration: "sibling" },
      hasStateArgsEnv: false,
    });
    expect(await dispatch(first, "incr")).toMatchObject({ count: 1 });
    expect(await dispatch(sibling, "get")).toMatchObject({ count: 0 });
    const codeLoads = () =>
      [...codeFetches]
        .filter(([key]) => !key.startsWith("__vibestudio_schema_probe:"))
        .reduce((sum, [, count]) => sum + count, 0);
    expect(codeLoads()).toBe(1);
    const held = dispatch(first, "hold").then(
      () => ({ completed: true }),
      (error) => ({ error })
    );
    expect(await dispatch(first, "instance")).toMatchObject({ held: true, localCalls: 2 });
    await activate(first.objectKey, "ctx:shared", { configuration: "reconfigured" });
    const updatedAdmission = manager.getDoAdmission(
      first.source,
      first.className,
      first.objectKey
    )!;
    expect(updatedAdmission.executableVersion).toBe(firstAdmission.executableVersion);
    expect(updatedAdmission.incarnationVersion).not.toBe(firstAdmission.incarnationVersion);
    expect(await dispatch(first, "instance")).toMatchObject({
      localCalls: 1,
      held: false,
      unitConstructors: 3,
      stateArgs: { configuration: "reconfigured" },
    });
    expect(await held).toHaveProperty("error");
    expect(await dispatch(first, "get")).toMatchObject({ count: 1 });
    expect(await dispatch(sibling, "instance")).toMatchObject({
      localCalls: 2,
      held: false,
      stateArgs: { configuration: "sibling" },
    });
    expect(codeLoads()).toBe(1);
    const changed = { ...base, objectKey: "changed-code" };
    builds[base.source] = doBuild(
      base.source,
      "ev-2",
      COUNTER_DO.replace('result:"v1"', 'result:"v2"')
    );
    await activate(changed.objectKey, "ctx:changed", { configuration: "changed" });
    expect(
      manager.getDoAdmission(changed.source, changed.className, changed.objectKey)!
        .executableVersion
    ).not.toBe(firstAdmission.executableVersion);
    expect(await dispatch(changed, "instance")).toMatchObject({
      localCalls: 1,
      unitConstructors: 1,
      stateArgs: { configuration: "changed" },
    });
    expect(await dispatch(changed, "generation")).toBe("v2");
    expect(await dispatch(first, "generation")).toBe("v1");
    expect(await dispatch(sibling, "network")).toMatchObject({
      caller: expect.stringMatching(/^do-code:/),
    });
    expect(codeLoads()).toBe(2);
    expect(manager.getBootGeneration()).toBe(boot);
  }, 30_000);

  it("requires the admitted executable identity before loading code and rejects a different code identity", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, codeFetches, dispatch } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");
    const ref = { source: "workers/counter", className: "CounterDO", objectKey: "identity-test" };
    const url = `http://127.0.0.1:${manager.getPort()}/_u/${encodeURIComponent(encodeUniversalKey(ref))}/incr`;
    const headers = {
      Authorization: "Bearer udo-gateway-token",
      "X-Vibestudio-Dispatch-Secret": manager.getDispatchSecret(),
      "Content-Type": "application/json",
    };
    const before = [...codeFetches];
    const missing = await fetch(url, { method: "POST", headers, body: "[]" });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("missing executable identity");
    expect([...codeFetches]).toEqual(before);
    const stale = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        ...doExecutableHeaders(ref, (key) =>
          manager.getDoAdmission(key.source, key.className, key.objectKey)
        ),
        "X-Vibestudio-Executable-Version": "another-incarnation",
      },
      body: "[]",
    });
    expect(stale.status).toBe(500);
    const failure = (await stale.json()) as { error: RpcFailure };
    expect(failure.error).toMatchObject({
      name: "Error",
      message: "universal-do: Admission changed (409)",
      errorKind: "application",
    });
    expect(failure.error.stack).toContain("Admission changed (409)");
    expect(await dispatch(ref, "incr")).toMatchObject({ count: 1 });
  });
  it("admits a fresh entity's exact schema before activation without a publication", async () => {
    const source = "workers/schema-admission";
    active = await createHarness({ [source]: doBuild(source, "fresh", SCHEMA_PROBE_DO) });
    const { manager, codeFetches, dispatch } = active;
    const prepared = await manager.ensureDurableObjectEntity({
      source,
      className: "SchemaProbeDO",
      key: "fresh",
      contextId: "fresh-context",
    });
    await manager.restoreDurableObjectEntity({
      id: prepared.targetId,
      kind: "do",
      className: "SchemaProbeDO",
      key: "fresh",
      source: { repoPath: source, effectiveVersion: prepared.effectiveVersion },
      activeBuildKey: prepared.buildKey,
      activeExecutionDigest: prepared.executionDigest,
      activeAuthority: prepared.authority,
      contextId: "fresh-context",
      createdAt: 1,
      status: "active",
      cleanupComplete: false,
    });
    expect(
      await dispatch({ source, className: "SchemaProbeDO", objectKey: "fresh" }, "get")
    ).toMatchObject({
      className: "SchemaProbeDO",
      version: 1,
      freshSchemaFingerprint: expect.stringContaining("cards_title"),
    });
    expect(
      [...codeFetches.keys()].filter((key) => key.startsWith("__vibestudio_schema_probe:"))
    ).toHaveLength(1);
  });
  it("probes a candidate schema in workerd and destroys its reserved scratch storage", async () => {
    const source = "workers/schema-probe";
    const candidate = doBuild(source, "ev-probe", SCHEMA_PROBE_DO);
    const artifact = runtimeArtifact(source, "candidate");
    const build: BuildResult = {
      ...candidate,
      buildKey: artifact.buildKey,
      metadata: {
        ...candidate.metadata,
        buildKey: artifact.buildKey,
        execution: artifact,
        ev: artifact.sourceState.effectiveVersion,
        sourceState: artifact.sourceState.state,
      },
    };
    active = await createHarness({ [source]: build });

    const descriptor = await active.manager.probeDurableObjectSchema(
      source,
      "SchemaProbeDO",
      storedBuildFixture(build)
    );

    expect(descriptor).toMatchObject({
      className: "SchemaProbeDO",
      version: 1,
    });
    expect(descriptor.freshSchemaFingerprint).toContain("cards_title");
  });

  ledgerTest(
    "execution.ensure-durable-object",
    async () => {
      active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
      const { manager, codeFetches, dispatch } = active;

      // Registering the first userland DO class brings workerd up once.
      await manager.ensureDOClass("workers/counter", "CounterDO");
      const boot = manager.getBootGeneration();

      const ref1 = { source: "workers/counter", className: "CounterDO", objectKey: "k1" };
      expect(await dispatch(ref1, "incr")).toEqual({
        count: 1,
        source: "workers/counter",
        cls: "CounterDO",
        key: "k1",
      });
      expect(await dispatch(ref1, "incr")).toMatchObject({ count: 2 });
      expect(codeFetches.get("k1")).toBe(1);

      // A different object key is an isolated facet (its own storage).
      const ref2 = { source: "workers/counter", className: "CounterDO", objectKey: "k2" };
      expect(await dispatch(ref2, "incr")).toMatchObject({ count: 1, key: "k2" });
      expect(await dispatch(ref1, "get")).toMatchObject({ count: 2 });

      // Runtime retirement aborts the live facet without disrupting unrelated
      // work. WorkerLoader has no per-isolate unload primitive, so a later
      // pressure-triggered process compaction reclaims its loaded module graph.
      // Durable storage remains intact across both boundaries.
      await manager.retireDOEntity(ref1);
      expect(manager.getBootGeneration()).toBe(boot);
      const internals = manager as unknown as {
        maybeCompactRetiredDynamicIsolates(rssBytes: number): void;
        dynamicIsolateCompactionFlight: Promise<void> | null;
        doObjectBuilds: Map<string, unknown>;
      };
      // The class-level fixture dispatch path above intentionally skips the
      // production object-image registry. Model the live object binding at the
      // manager boundary whose presence must veto a process restart.
      internals.doObjectBuilds.set("workers/counter:CounterDO/k2", {});
      internals.maybeCompactRetiredDynamicIsolates(768 * 1024 * 1024);
      expect(internals.dynamicIsolateCompactionFlight).toBeNull();
      expect(manager.getBootGeneration()).toBe(boot);

      // Object retirement does not retire the executable still owned by the
      // class binding, so it cannot manufacture isolate pressure or restart.
      await manager.retireDOEntity(ref2);
      internals.doObjectBuilds.delete("workers/counter:CounterDO/k2");
      internals.maybeCompactRetiredDynamicIsolates(768 * 1024 * 1024);
      await internals.dynamicIsolateCompactionFlight;
      expect(manager.getBootGeneration()).toBe(boot);
      expect(await dispatch(ref1, "get")).toMatchObject({ count: 2, key: "k1" });
      expect(codeFetches.get("k1")).toBe(1);
    },
    30_000
  );

  it("keeps one shared executable warm across many independent object retirements", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");
    const refs = Array.from({ length: 16 }, (_, index) => ({
      source: "workers/counter",
      className: "CounterDO",
      objectKey: `bounded-${index}`,
    }));
    await dispatch(refs[0]!, "incr");
    const boot = manager.getBootGeneration();

    for (let index = 0; index < 15; index++) {
      await dispatch(refs[index]!, "get");
      await manager.retireDOEntity(refs[index]!);
      expect(manager.getBootGeneration()).toBe(boot);
    }
    await dispatch(refs[15]!, "get");
    await manager.retireDOEntity(refs[15]!);
    const internals = manager as unknown as {
      dynamicIsolateCompactionFlight: Promise<void> | null;
    };
    await internals.dynamicIsolateCompactionFlight;

    expect(manager.getBootGeneration()).toBe(boot);
    expect(await dispatch(refs[0]!, "get")).toMatchObject({ count: 1, key: "bounded-0" });
  });

  it("clones facet storage to a new key (channel fork), independent, no restart", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch } = active;

    await manager.ensureDOClass("workers/counter", "CounterDO");
    const src = { source: "workers/counter", className: "CounterDO", objectKey: "orig" };
    const prepared = await manager.ensureDurableObjectEntity({
      source: src.source,
      className: src.className,
      key: src.objectKey,
      contextId: "source-context",
    });
    const reservation = cloneReservation(src, "fork", manager);
    await manager.restoreDurableObjectEntity({
      ...sourceOwner(reservation),
      source: { repoPath: src.source, effectiveVersion: prepared.effectiveVersion },
      activeAuthority: prepared.authority,
    });
    await dispatch(src, "incr");
    await dispatch(src, "incr");
    expect(await dispatch(src, "get")).toMatchObject({ count: 2 });

    const boot = manager.getBootGeneration();
    const cloned = await manager.forkObjectStorage(src, "fork", {
      reservation,
      resolveSource: async () => sourceOwner(reservation),
    });
    expect(cloned.objectKey).toBe("fork");
    expect(manager.getBootGeneration()).toBe(boot); // clone never restarts

    // The fork starts with the parent's state…
    expect(await dispatch(cloned, "get")).toMatchObject({ count: 2, key: "fork" });
    // …and is independent: mutating the fork does not affect the original.
    await dispatch(cloned, "incr");
    expect(await dispatch(cloned, "get")).toMatchObject({ count: 3 });
    expect(await dispatch(src, "get")).toMatchObject({ count: 2 });

    // destroyDO removes the fork's facet storage.
    await manager.destroyDO(cloned);
  }, 30_000);

  it("forks to a target id once: repeating the fork, or retrying it after a lost receipt, leaves the one object", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");
    const src = { source: "workers/counter", className: "CounterDO", objectKey: "once-source" };
    const prepared = await manager.ensureDurableObjectEntity({
      source: src.source,
      className: src.className,
      key: src.objectKey,
      contextId: "source-context",
    });
    const reservation = cloneReservation(src, "once", manager);
    await manager.restoreDurableObjectEntity({
      ...sourceOwner(reservation),
      source: { repoPath: src.source, effectiveVersion: prepared.effectiveVersion },
      activeAuthority: prepared.authority,
    });
    await dispatch(src, "incr");
    const fork = () =>
      manager.forkObjectStorage(src, "once", {
        reservation,
        resolveSource: async () => sourceOwner(reservation),
      });
    const first = await fork();
    // The target takes its own writes after the fork.
    await dispatch(first, "incr");
    await dispatch(first, "incr");
    expect(await dispatch(first, "get")).toMatchObject({ count: 3 });

    // The same fork again: the receipt says it finished, and nothing is copied over the target.
    await expect(fork()).resolves.toEqual(first);
    expect(await dispatch(first, "get")).toMatchObject({ count: 3 });

    // A retry after the node finished the fork and the host did not hear (the
    // receipt still says it began): the node answers ERR_OBJECT_EXISTS, which
    // the host takes as done. The one object keeps its state; the source is untouched.
    const receipts = (
      manager as unknown as {
        doStorageDb: { prepare(sql: string): { run(...values: unknown[]): unknown } };
      }
    ).doStorageDb;
    receipts.prepare(`UPDATE do_storage_clones SET phase = 'cloning'`).run();
    await expect(fork()).resolves.toEqual(first);
    expect(await dispatch(first, "get")).toMatchObject({ count: 3 });
    expect(await dispatch(src, "get")).toMatchObject({ count: 1 });
    await manager.destroyDO(first);
  }, 30_000);

  it("refuses a snapshot whose source image differs from its reserved provenance", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");
    const src = { source: "workers/counter", className: "CounterDO", objectKey: "drift-source" };
    const prepared = await manager.ensureDurableObjectEntity({
      source: src.source,
      className: src.className,
      key: src.objectKey,
      contextId: "source-context",
    });
    const reservation = cloneReservation(src, "drift-child", manager);
    await manager.restoreDurableObjectEntity({
      ...sourceOwner(reservation),
      source: { repoPath: src.source, effectiveVersion: prepared.effectiveVersion },
      activeAuthority: prepared.authority,
    });
    await dispatch(src, "incr");
    reservation.cloneProvenance = {
      ...reservation.cloneProvenance!,
      sourceExecutionDigest: "f".repeat(64),
    };
    await expect(
      manager.forkObjectStorage(src, "drift-child", {
        reservation,
        resolveSource: async () => sourceOwner(reservation),
      })
    ).rejects.toThrow(/changed its snapshot execution/);
    expect(await dispatch(src, "get")).toMatchObject({ count: 1 });
    await manager.destroyDO({ ...src, objectKey: "drift-child" });
  });

  it("online-clones a cooperatively paused source without draining its active relay", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch } = active;

    await manager.ensureDOClass("workers/counter", "CounterDO");
    const src = { source: "workers/counter", className: "CounterDO", objectKey: "self" };
    const prepared = await manager.ensureDurableObjectEntity({
      source: src.source,
      className: src.className,
      key: src.objectKey,
      contextId: "source-context",
    });
    const reservation = cloneReservation(src, "self-fork", manager);
    await manager.restoreDurableObjectEntity({
      ...sourceOwner(reservation),
      source: { repoPath: src.source, effectiveVersion: prepared.effectiveVersion },
      activeAuthority: prepared.authority,
    });
    await dispatch(src, "incr");
    await dispatch(src, "incr");

    const finishSourceCall = beginDurableObjectRelay(
      `do:${src.source}:${src.className}:${src.objectKey}`
    );
    let cloned: typeof src | null = null;
    try {
      cloned = await manager.forkObjectStorage(src, "self-fork", {
        reservation,
        resolveSource: async () => sourceOwner(reservation),
        cooperativelyPaused: true,
      });
    } finally {
      finishSourceCall();
    }
    if (!cloned) throw new Error("cooperative clone did not return a target");

    expect(await dispatch(cloned, "get")).toMatchObject({ count: 2, key: "self-fork" });
    await dispatch(cloned, "incr");
    expect(await dispatch(cloned, "get")).toMatchObject({ count: 3 });
    expect(await dispatch(src, "get")).toMatchObject({ count: 2 });
    await manager.destroyDO(cloned);
  }, 30_000);

  it("backs up, resets, lists, and restores one exact facet storage target", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");
    const ref = { source: "workers/counter", className: "CounterDO", objectKey: "resettable" };
    await dispatch(ref, "incr");
    await dispatch(ref, "incr");

    const finishInFlight = beginDurableObjectRelay(
      `do:${ref.source}:${ref.className}:${ref.objectKey}`
    );
    let resetSettled = false;
    const resetPromise = manager
      .resetDOStorage(ref, "exercise disposable schema recovery")
      .then((result) => {
        resetSettled = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resetSettled).toBe(false);
    expect(() =>
      beginDurableObjectRelay(`do:${ref.source}:${ref.className}:${ref.objectKey}`)
    ).toThrow(/storage maintenance/u);
    finishInFlight();
    const reset = await resetPromise;
    expect(await dispatch(ref, "get")).toMatchObject({ count: 0 });
    expect(await manager.listDOStorageBackups(ref)).toEqual([
      expect.objectContaining({
        operationId: reset.operationId,
        intent: "exercise disposable schema recovery",
      }),
    ]);

    await manager.restoreDOStorageBackup(
      ref,
      reset.operationId,
      "restore the pre-reset representative rows"
    );
    expect(await dispatch(ref, "get")).toMatchObject({ count: 2 });
  }, 30_000);

  it("forwards a WebSocket upgrade through the facet host (hibernation)", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch, admissionFetches } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");

    const ref = { source: "workers/counter", className: "CounterDO", objectKey: "ws-1" };
    const instructions = "WebSocket native instructions: λ 日本語 🧭\n".repeat(6000);
    expect(Buffer.byteLength(instructions)).toBeGreaterThanOrEqual(128 * 1024);
    const stateArgs = { instructions };
    const prepared = await manager.ensureDurableObjectEntity({
      ...ref,
      key: ref.objectKey,
      ref: "main",
      contextId: "ws-context",
      stateArgs,
    });
    await manager.restoreDurableObjectEntity({
      id: prepared.targetId,
      kind: "do",
      className: ref.className,
      key: ref.objectKey,
      source: { repoPath: ref.source, effectiveVersion: prepared.effectiveVersion },
      activeBuildKey: prepared.buildKey,
      activeExecutionDigest: prepared.executionDigest,
      activeAuthority: prepared.authority,
      stateArgs,
      contextId: "ws-context",
      createdAt: 1,
      status: "active",
      cleanupComplete: false,
    });
    expect(admissionFetches.get(ref.objectKey)).toBeUndefined();
    const port = manager.getPort()!;
    const { default: WebSocket } = await import("ws");
    const key = encodeUniversalKey(ref);

    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/_u/${encodeURIComponent(key)}`, {
        headers: {
          Authorization: "Bearer udo-gateway-token",
          "X-Vibestudio-Dispatch-Secret": manager.getDispatchSecret(),
          ...doExecutableHeaders(ref, (key) =>
            manager.getDoAdmission(key.source, key.className, key.objectKey)
          ),
        },
      });
      let received: string | null = null;
      const timer = setTimeout(() => reject(new Error("WS timeout")), 8_000);
      ws.on("open", () => ws.send("ping"));
      ws.on("message", (d: Buffer) => {
        received = d.toString();
        // Supply a protocol-valid status so the pre-auto-reply compatibility
        // path can echo it from webSocketClose and complete the handshake.
        ws.close(1000, "test complete");
      });
      ws.on("close", () => {
        clearTimeout(timer);
        if (received === null) {
          reject(new Error("WebSocket closed before the facet replied"));
          return;
        }
        resolve(received);
      });
      ws.on("error", (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    // The hibernation handler fired inside the facet and echoed.
    expect(reply).toBe("echo:ping:CounterDO");
    expect(admissionFetches.get(ref.objectKey)).toBe(1);
    const instance = (await dispatch(ref, "instance")) as { stateArgs: { instructions: string } };
    expect(instance.stateArgs.instructions.length).toBe(instructions.length);
    expect(sha256(instance.stateArgs.instructions)).toBe(sha256(instructions));
    expect(admissionFetches.get(ref.objectKey)).toBe(1);
  }, 30_000);

  it("loads JavaScript chunks from a userland DO module map", async () => {
    const source = "workers/chunked-do";
    const primary = `import { DurableObject } from "cloudflare:workers";
export class ChunkedDO extends DurableObject {
  async fetch() {
    const { value } = await import("./chunks/lazy.js");
    return Response.json({ result: value });
  }
}
export default { fetch() { return new Response("chunked host"); } };`;
    const build = doBuild(source, "v1", primary, [
      {
        path: "chunks/lazy.js",
        role: "asset",
        contentType: "text/javascript; charset=utf-8",
        encoding: "utf8",
        content: 'export const value = "loaded lazily";',
      },
    ]);
    active = await createHarness({ [source]: build });
    const { manager, dispatch } = active;
    await manager.ensureDOClass(source, "ChunkedDO");
    await expect(
      dispatch({ source, className: "ChunkedDO", objectKey: "one" }, "fetch")
    ).resolves.toBe("loaded lazily");
  }, 30_000);

  it("registers a brand-new DO class with no restart", async () => {
    active = await createHarness({
      "workers/counter": doBuild("workers/counter", "ev-1"),
      "workers/other": doBuild("workers/other", "ev-1"),
    });
    const { manager, dispatch } = active;

    await manager.ensureDOClass("workers/counter", "CounterDO");
    const boot = manager.getBootGeneration();
    await dispatch({ source: "workers/counter", className: "CounterDO", objectKey: "a" }, "incr");

    // A genuinely new userland DO class (different source) — no restart.
    await manager.ensureDOClass("workers/other", "CounterDO");
    expect(manager.getBootGeneration()).toBe(boot);

    expect(
      await dispatch({ source: "workers/other", className: "CounterDO", objectKey: "a" }, "incr")
    ).toMatchObject({ count: 1, source: "workers/other" });
  }, 30_000);

  describe("hosting code in an entity (docs/dolt-redesign.md section 7.2)", () => {
    const HOST = "workers/host";
    const KERNEL = "workers/kernel";
    const manifests = {
      [HOST]: [{ className: "HostDO", hosts: [{ source: KERNEL, className: "KernelDO" }] }],
      [KERNEL]: [
        {
          className: "KernelDO",
          hosted: { storage: "dolt" as const, codegen: true, residency: true },
        },
      ],
      "workers/plain": [{ className: "HostDO" }],
    };
    const builds = {
      [HOST]: doBuild(HOST, "ev-1", HOST_DO),
      "workers/plain": doBuild("workers/plain", "ev-1", HOST_DO),
      [KERNEL]: doBuild(KERNEL, "ev-1", KERNEL_DO),
    };
    const hostRef = (key: string, source = HOST) => ({
      source,
      className: "HostDO",
      objectKey: key,
    });
    const code = (
      dispatch: Harness["dispatch"],
      ref: ReturnType<typeof hostRef>,
      request: Record<string, unknown>,
      method = "code"
    ) =>
      dispatch(ref, method, JSON.stringify({ request })) as Promise<{
        status: number;
        body: string;
      }>;
    const hostKernel = {
      op: "host",
      name: "repl:default",
      executable: { source: KERNEL, className: "KernelDO" },
    };
    const callKernel = (method: string, ...args: unknown[]) => ({
      op: "call",
      name: "repl:default",
      executable: { source: KERNEL, className: "KernelDO" },
      method,
      args,
    });

    it("an entity hosts a Dolt class that compiles; it cannot compile or grant itself anything", async () => {
      active = await createHarness(builds, { manifests });
      const { manager, dispatch } = active;
      await manager.ensureDOClass(HOST, "HostDO");
      const a = hostRef("entity-a");
      const b = hostRef("entity-b");
      await bindConfiguredObject(manager, a, {});
      await bindConfiguredObject(manager, b, {});

      // The entity's own code has the binding and a proof, and no codegen.
      expect(await dispatch(a, "props")).toMatchObject({
        hasCodeHost: true,
        codeHost: ["name", "proof"],
      });
      expect(await dispatch(a, "compile")).toMatchObject({
        error: expect.stringMatching(/code generation|eval|Function/i),
      });

      expect((await code(dispatch, a, hostKernel)).status).toBe(200);
      const run = await code(dispatch, a, callKernel("run", "40 + 2"));
      expect(run.status).toBe(200);
      expect(JSON.parse(run.body)).toEqual({ result: { result: 42, runs: 1 } });
      // The hosted class acts as its entity: its identity and token are the entity's.
      const who = JSON.parse((await code(dispatch, a, callKernel("who"))).body).result;
      expect(who).toMatchObject({
        host: "do:workers/host:HostDO:entity-a",
        hasToken: true,
        hasCodeHostBinding: false,
      });
      // A commit per finished run, in the facet's own Dolt store.
      const info = JSON.parse((await code(dispatch, a, callKernel("info"))).body).result;
      expect(info.log.slice(0, 2)).toEqual(["eval: run 1", "kernel schema"]);
      expect(info.hasHold).toBe("object");

      // Another entity's kernel is its own: a separate counter and identity.
      await code(dispatch, b, hostKernel);
      expect(JSON.parse((await code(dispatch, b, callKernel("run", "1"))).body).result).toEqual({
        result: 1,
        runs: 1,
      });
      expect(JSON.parse((await code(dispatch, b, callKernel("who"))).body).result.host).toBe(
        "do:workers/host:HostDO:entity-b"
      );
      expect(JSON.parse((await code(dispatch, a, callKernel("run", "2"))).body).result).toEqual({
        result: 2,
        runs: 2,
      });
    }, 60_000);

    it("refuses what the manifests do not permit and what the proof does not cover", async () => {
      active = await createHarness(builds, { manifests });
      const { manager, dispatch } = active;
      await manager.ensureDOClass(HOST, "HostDO");
      await manager.ensureDOClass("workers/plain", "HostDO");
      const a = hostRef("entity-a");
      const plain = hostRef("entity-p", "workers/plain");
      await bindConfiguredObject(manager, a, {});
      await bindConfiguredObject(manager, plain, {});
      // The host class declares no `hosts` entry for the kernel.
      const undeclared = await code(dispatch, plain, hostKernel);
      expect(undeclared.status).toBe(500);
      expect(undeclared.body).toMatch(/does not declare that it hosts/);
      // A class that is not marked `hosted` is not hostable.
      const notHostable = await code(dispatch, a, {
        ...hostKernel,
        executable: { source: HOST, className: "HostDO" },
      });
      expect(notHostable.body).toMatch(/not a hostable class|does not declare/);
      // A proof for another name is refused before anything runs.
      const forged = await code(dispatch, a, hostKernel, "forged");
      expect(forged.status).toBe(403);
      const otherName = (await dispatch(
        a,
        "code",
        JSON.stringify({ name: "do:workers/host:HostDO:entity-x", request: hostKernel })
      )) as { status: number };
      expect(otherName.status).toBe(403);
    }, 60_000);

    it("a drain tells the hosted class before the node takes it, through its root's revocation handler", async () => {
      active = await createHarness(builds, { manifests });
      const { manager, dispatch } = active;
      await manager.ensureDOClass(HOST, "HostDO");
      const a = hostRef("entity-a");
      await bindConfiguredObject(manager, a, {});
      await code(dispatch, a, hostKernel);
      await code(dispatch, a, callKernel("run", "1"));
      const restarted = Date.now();
      await (manager as unknown as { restartWorkerd(): Promise<void> }).restartWorkerd();
      // The kernel's Dolt store holds the commit its root asked it to make.
      // A swap revokes the hold at once (celld ec0d6f5), so this takes about two seconds, not the
      // 60 s of CELLD_DEPLOY_MAX_AGE_S that the cell waited out before.
      await code(dispatch, a, hostKernel);
      const info = JSON.parse((await code(dispatch, a, callKernel("info"))).body).result;
      // The restart did not wait out CELLD_DEPLOY_MAX_AGE_S (60 s; it took 63 s before celld ec0d6f5).
      expect(Date.now() - restarted).toBeLessThan(20_000);
      expect(info.log.some((message: string) => /^revoked: (drain|swap)/.test(message))).toBe(true);
      // The code is hosted again, and the committed history is intact.
      expect(JSON.parse((await code(dispatch, a, callKernel("run", "5"))).body).result.result).toBe(
        5
      );
    }, 180_000);

    it("a CPU limit ends a spinning call and leaves the hosted instance, with its heap, answerable", async () => {
      active = await createHarness(builds, {
        manifests: {
          ...manifests,
          [KERNEL]: [
            {
              className: "KernelDO",
              hosted: {
                storage: "dolt" as const,
                codegen: true,
                residency: true,
                limits: { cpuMs: 1000 },
              },
            },
          ],
        },
      });
      const { manager, dispatch } = active;
      await manager.ensureDOClass(HOST, "HostDO");
      const a = hostRef("entity-a");
      await bindConfiguredObject(manager, a, {});
      await code(dispatch, a, hostKernel);
      await code(dispatch, a, callKernel("run", "1"));
      const spun = await code(dispatch, a, callKernel("spin"));
      expect(spun.body).toMatch(/CPU limit/);
      expect(JSON.parse((await code(dispatch, a, callKernel("run", "3"))).body).result).toEqual({
        result: 3,
        runs: 2,
      });
    }, 60_000);

    it("a restart ends the hosted instance's heap and keeps its storage; the next call starts the class again", async () => {
      active = await createHarness(builds, { manifests });
      const { manager, dispatch } = active;
      await manager.ensureDOClass(HOST, "HostDO");
      const a = hostRef("entity-a");
      await bindConfiguredObject(manager, a, {});
      await code(dispatch, a, hostKernel);
      await code(dispatch, a, callKernel("run", "1"));
      await code(dispatch, a, callKernel("run", "2"));
      const restarted = JSON.parse(
        (
          await code(dispatch, a, {
            op: "restart",
            name: "repl:default",
            executable: hostKernel.executable,
          })
        ).body
      );
      expect(restarted).toEqual({ restarted: true });
      // The heap is new (the run counter starts over) and the committed history is intact.
      const info = JSON.parse((await code(dispatch, a, callKernel("info"))).body).result;
      expect(info.runs).toBe(0);
      expect(info.log.filter((message: string) => message.startsWith("eval: run"))).toHaveLength(2);
      // Restarting what is not hosted is not an error.
      expect(
        JSON.parse(
          (
            await code(dispatch, a, {
              op: "restart",
              name: "repl:other",
              executable: hostKernel.executable,
            })
          ).body
        )
      ).toEqual({ restarted: false });
    }, 60_000);

    it("a limit on one call (a run's timeoutMs) ends that call when the class has none of its own, and a bad limit is refused", async () => {
      active = await createHarness(builds, { manifests });
      const { manager, dispatch } = active;
      await manager.ensureDOClass(HOST, "HostDO");
      const a = hostRef("entity-a");
      await bindConfiguredObject(manager, a, {});
      await code(dispatch, a, hostKernel);
      await code(dispatch, a, callKernel("run", "1"));
      const started = Date.now();
      const spun = await code(dispatch, a, { ...callKernel("spin"), limits: { cpuMs: 1500 } });
      expect(spun.body).toMatch(/CPU limit of 1500/);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(JSON.parse((await code(dispatch, a, callKernel("run", "3"))).body).result).toEqual({
        result: 3,
        runs: 2,
      });
      const refused = await code(dispatch, a, { ...callKernel("run", "1"), limits: { cpuMs: -5 } });
      expect(refused.body).toMatch(/limits.cpuMs must be a positive integer/);
    }, 90_000);
  });

  describe("a class that declares storage: dolt (docs/dolt-redesign.md §9)", () => {
    const NOTES = "workers/notes";
    const manifests: Record<string, Array<Record<string, unknown>>> = {
      [NOTES]: [{ className: "NotesDO", storage: "dolt", doltLocal: ["local_%"] }],
    };
    const builds = { [NOTES]: doBuild(NOTES, "ev-1", NOTES_DO) };
    const ref = (key: string) => ({ source: NOTES, className: "NotesDO", objectKey: key });
    const bind = async (manager: RuntimeManager, key: string) =>
      bindConfiguredObject(manager, ref(key), {});
    /** A source object as the existing fork test prepares one: ensured, with its image, its owner restored. */
    const prepareSource = async (manager: RuntimeManager, key: string, forkKey: string) => {
      const prepared = await manager.ensureDurableObjectEntity({
        source: NOTES,
        className: "NotesDO",
        key,
        contextId: "source-context",
      });
      const reservation = cloneReservation(ref(key), forkKey, manager);
      await manager.restoreDurableObjectEntity({
        ...sourceOwner(reservation),
        source: { repoPath: NOTES, effectiveVersion: prepared.effectiveVersion },
        activeAuthority: prepared.authority,
      });
      return reservation;
    };
    type Notes = {
      engine: string;
      notes: string[];
      hits: number;
      log: string[] | null;
      head: string | null;
      commits: Array<[string, string]> | null;
    };

    it("the SQL the channel and Pi stores use runs on a Dolt facet (dialect probe)", async () => {
      const DIALECT = "workers/dialect";
      active = await createHarness(
        { [DIALECT]: doBuild(DIALECT, "ev-1", DIALECT_DO) },
        { manifests: { [DIALECT]: [{ className: "DialectDO", storage: "dolt" }] } as never }
      );
      const { manager, dispatch } = active;
      await manager.ensureDOClass(DIALECT, "DialectDO");
      const ref = { source: DIALECT, className: "DialectDO", objectKey: "probe" };
      await bindConfiguredObject(manager, ref, {});
      const results = (await dispatch(ref, "run")) as Record<
        string,
        { ok?: unknown; error?: string }
      >;
      // eslint-disable-next-line no-console
      console.info("DIALECT", JSON.stringify(results));
      const failures = Object.entries(results).filter(([, value]) => value.error !== undefined);
      expect(failures).toEqual([]);
      expect(results["partial unique index"]!.ok).toBe("enforced");
      expect(results["check constraint"]!.ok).toBe("enforced");
    }, 60_000);

    it("measures the commit volume of a channel's write shape on a Dolt facet (R1)", async () => {
      const LOAD = "workers/load";
      const events = Number(process.env["VIBESTUDIO_R1_EVENTS"] ?? 300);
      const bytes = Number(process.env["VIBESTUDIO_R1_BYTES"] ?? 1024);
      active = await createHarness(
        { [LOAD]: doBuild(LOAD, "ev-1", LOAD_DO) },
        {
          manifests: {
            [LOAD]: [{ className: "LoadDO", storage: "dolt", doltLocal: ["local_%"] }],
          } as never,
        }
      );
      const { manager, dispatch, ownedPaths } = active;
      await manager.ensureDOClass(LOAD, "LoadDO");
      const ref = { source: LOAD, className: "LoadDO", objectKey: "load" };
      await bindConfiguredObject(manager, ref, {});
      const dbFiles = (): Array<{ file: string; bytes: number }> => {
        const found: Array<{ file: string; bytes: number }> = [];
        const walk = (dir: string): void => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name === "db.sqlite")
              found.push({ file: path, bytes: statSync(path).size });
          }
        };
        for (const root of ownedPaths) if (existsSync(root)) walk(root);
        return found;
      };
      const largest = () => Math.max(0, ...dbFiles().map((f) => f.bytes));
      const before = largest();
      // The cell's clock is coarse by design (a frozen timer), so time batches from outside.
      const batch = 50;
      const perEventMs: number[] = [];
      let commits = 0;
      for (let done = 0; done < events; done += batch) {
        const started = performance.now();
        const result = (await dispatch(
          ref,
          "load",
          JSON.stringify({ events: Math.min(batch, events - done), bytes })
        )) as { commits: number };
        perEventMs.push((performance.now() - started) / Math.min(batch, events - done));
        commits = result.commits;
      }
      const sorted = [...perEventMs].sort((x, y) => x - y);
      const quantile = (q: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
      const loaded = {
        commits,
        both: {
          batches: sorted.length,
          meanMs: Number((perEventMs.reduce((x, y) => x + y, 0) / perEventMs.length).toFixed(2)),
          p50Ms: Number(quantile(0.5).toFixed(2)),
          p95Ms: Number(quantile(0.95).toFixed(2)),
        },
      };
      const afterLoad = largest();
      const readsStarted = performance.now();
      const reads = (await dispatch(ref, "reads", "{}")) as Record<string, number>;
      reads["callMs"] = Number((performance.now() - readsStarted).toFixed(1));
      const gcStarted = performance.now();
      await dispatch(ref, "gc", "{}");
      const gc = { ms: performance.now() - gcStarted };
      const afterGc = largest();
      const report = {
        events,
        bytesPerEvent: bytes,
        commits: loaded.commits,
        perEventMsByBatchOf50: loaded.both,
        fileBytes: { empty: before, afterLoad, afterGc },
        bytesPerEventOnDisk: Math.round((afterLoad - before) / events),
        gcMs: Math.round(gc.ms),
        reads,
      };
      // eslint-disable-next-line no-console
      console.info("R1", JSON.stringify(report));
      expect(loaded.commits).toBeGreaterThanOrEqual(events);
      expect(reads["at"]).toBe(Math.floor(reads["head"]! / 2));
    }, 900_000);

    it("an object is a Dolt facet: its writes are commits, a local table is not versioned, and a fork starts the local table empty", async () => {
      active = await createHarness(builds, { manifests: manifests as never });
      const { manager, dispatch } = active;
      await manager.ensureDOClass(NOTES, "NotesDO");
      expect(manager.getDoAdmission(NOTES, "NotesDO", undefined)?.engine).toMatchObject({
        storage: "dolt",
        doltLocal: expect.arrayContaining(["local_%", "vsl_%", "state"]),
      });
      const reservation = await prepareSource(manager, "orig", "fork");
      await dispatch(ref("orig"), "add", JSON.stringify("a"));
      await dispatch(ref("orig"), "add", JSON.stringify("b"));
      const state = (await dispatch(ref("orig"), "add", JSON.stringify("c"))) as Notes;
      expect(state.engine).toBe("dolt");
      expect(state.notes).toEqual(["a", "b", "c"]);
      expect(state.log!.slice(0, 3)).toEqual(["note: c", "note: b", "note: a"]);
      expect(state.hits).toBe(3);

      // A hard reset to the first note rewinds the notes and not the local table.
      const firstNote = state.commits![2]![0];
      const rewound = (await dispatch(ref("orig"), "reset-to", JSON.stringify(firstNote))) as Notes;
      expect(rewound.notes).toEqual(["a"]);
      expect(rewound.hits).toBe(4);
      await dispatch(ref("orig"), "add", JSON.stringify("b"));
      await dispatch(ref("orig"), "add", JSON.stringify("c"));

      // A fork of the whole object, as the product's clone is: versioned rows copied, the local table empty.
      await manager.forkObjectStorage(ref("orig"), "fork", {
        reservation,
        resolveSource: async () => sourceOwner(reservation),
      });
      await bind(manager, "fork");
      const forked = (await dispatch(ref("fork"), "get")) as Notes;
      expect(forked.engine).toBe("dolt");
      expect(forked.notes).toEqual(["a", "b", "c"]);
      expect(forked.hits).toBe(1);
      expect(forked.log!.slice(0, 3)).toEqual(["note: c", "note: b", "note: a"]);
    }, 90_000);

    it("a fork at a commit of the Dolt facet holds the parent as of that commit, and a repeat of the fork leaves the one object", async () => {
      active = await createHarness(builds, { manifests: manifests as never });
      const { manager, dispatch } = active;
      await manager.ensureDOClass(NOTES, "NotesDO");
      const reservation = await prepareSource(manager, "parent", "at-two");
      await dispatch(ref("parent"), "add", JSON.stringify("one"));
      await dispatch(ref("parent"), "add", JSON.stringify("two"));
      const withThree = (await dispatch(ref("parent"), "add", JSON.stringify("three"))) as Notes;
      const atTwo = withThree.commits![1]![0];
      const options = {
        reservation,
        resolveSource: async () => sourceOwner(reservation),
        at: atTwo,
      };
      await manager.forkObjectStorage(ref("parent"), "at-two", options);
      await manager.forkObjectStorage(ref("parent"), "at-two", options);
      await bind(manager, "at-two");
      const child = (await dispatch(ref("at-two"), "get")) as Notes;
      expect(child.notes).toEqual(["one", "two"]);
      expect(child.log!.slice(0, 2)).toEqual(["note: two", "note: one"]);
      // The parent is untouched and the child diverges on its own.
      await dispatch(ref("at-two"), "add", JSON.stringify("child-three"));
      expect(((await dispatch(ref("parent"), "get")) as Notes).notes).toEqual([
        "one",
        "two",
        "three",
      ]);
    }, 90_000);

    it.each([
      { stage: "copying", failOnCommit: 1, expectedFailures: 1 },
      { stage: "swapping", failOnCommit: 2, expectedFailures: 1 },
    ])(
      "an import interrupted while $stage resumes where it stopped and loses nothing",
      async ({ failOnCommit, expectedFailures }) => {
        const sqliteManifests = { [NOTES]: [{ className: "NotesDO" }] };
        active = await createHarness(builds, { manifests: sqliteManifests as never });
        const { manager, dispatch } = active;
        await manager.ensureDOClass(NOTES, "NotesDO");
        await bind(manager, "legacy");
        await dispatch(ref("legacy"), "add", JSON.stringify("old-1"));
        await dispatch(ref("legacy"), "add", JSON.stringify("old-2"));
        sqliteManifests[NOTES] = manifests[NOTES] as never;
        await bindConfiguredObject(manager, ref("legacy"), { failOnCommit });
        let failures = 0;
        let after: Notes | null = null;
        for (let attempt = 0; attempt < 3 && after === null; attempt++) {
          try {
            after = (await dispatch(
              ref("legacy"),
              "add",
              JSON.stringify(`new-${attempt}`)
            )) as Notes;
          } catch (error) {
            expect(String(error)).toMatch(/injected commit failure/);
            failures++;
          }
        }
        expect(failures).toBe(expectedFailures);
        expect(after!.engine).toBe("dolt");
        expect(after!.notes.slice(0, 2)).toEqual(["old-1", "old-2"]);
        expect(after!.log!.some((message) => /^import: .* from sqlite$/.test(message))).toBe(true);
        // Once finished it stays finished: another request imports nothing.
        const again = (await dispatch(ref("legacy"), "get")) as Notes;
        expect(again.notes).toEqual(after!.notes);
      },
      120_000
    );

    it("an object whose class was SQLite is copied into the Dolt facet once, committed, and its legacy facet is deleted", async () => {
      const sqliteManifests = { [NOTES]: [{ className: "NotesDO" }] };
      active = await createHarness(builds, { manifests: sqliteManifests as never });
      const { manager, dispatch } = active;
      await manager.ensureDOClass(NOTES, "NotesDO");
      await bind(manager, "legacy");
      await dispatch(ref("legacy"), "add", JSON.stringify("old-1"));
      const before = (await dispatch(ref("legacy"), "add", JSON.stringify("old-2"))) as Notes;
      expect(before).toMatchObject({ engine: "sqlite", notes: ["old-1", "old-2"], hits: 2 });
      // The release that flips the class to Dolt.
      sqliteManifests[NOTES] = manifests[NOTES] as never;
      await bind(manager, "legacy");
      const after = (await dispatch(ref("legacy"), "add", JSON.stringify("new-3"))) as Notes;
      expect(after.engine).toBe("dolt");
      expect(after.notes).toEqual(["old-1", "old-2", "new-3"]);
      // Operational rows are copied as well (the local table survives the move).
      expect(after.hits).toBe(3);
      expect(after.log!.slice(0, 2)).toEqual([
        "note: new-3",
        expect.stringMatching(/^import: .* from sqlite$/),
      ]);
      // An object created under the Dolt declaration has no import commit.
      await bind(manager, "fresh");
      const fresh = (await dispatch(ref("fresh"), "add", JSON.stringify("x"))) as Notes;
      expect(fresh.log!.some((message) => message.startsWith("import:"))).toBe(false);
    }, 120_000);
  });
});
