/**
 * The migration on the real fork: databases laid out as the retired workerd
 * runtime left them are imported by `celld cell import` and then served by the
 * node, through the same importer the product uses.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CelldNode } from "./celldNode.js";
import { encodeUniversalKey } from "./doDispatch.js";
import { legacyWorkerdObjectHash, migrateLegacyWorkerdStorage } from "./celldMigration.js";
import { celldTestBinary, startCelldProbe } from "../../tests/helpers/celldNodeHarness.js";

const UNIVERSAL_KEY = "vibestudio-universal-do";
const INTERNAL = "vibestudio/internal";

/** workerd's schema for a Durable Object's root database and a facet's. */
function writeRoot(file: string, kv: Record<string, string>) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE _cf_KV ( key TEXT PRIMARY KEY, value BLOB ) WITHOUT ROWID");
  const insert = db.prepare("INSERT INTO _cf_KV (key, value) VALUES (?, ?)");
  // A V8-serialized string, as workerd stores a put() value.
  for (const [key, value] of Object.entries(kv))
    insert.run(key, Buffer.concat([Buffer.from([0xff, 0x0f, 0x22, value.length]), Buffer.from(value)]));
  db.close();
}
function writeCounter(file: string, rows: number) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE count (value INTEGER)");
  for (let index = 0; index < rows; index++) db.exec("INSERT INTO count VALUES (1)");
  db.close();
}

const COUNTER = `export class Counter {
  constructor(ctx) { this.sql = ctx.storage.sql; this.sql.exec('CREATE TABLE IF NOT EXISTS count (value INTEGER)'); }
  fetch() { this.sql.exec('INSERT INTO count VALUES (1)'); return new Response(String(this.sql.exec('SELECT count(*) AS n FROM count').one().n)); }
}`;

describe.skipIf(!celldTestBinary())("legacy storage migration (real celld)", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("imports a userland object with its facet, converts its KV, and the node serves it", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-migration-"));
    const ref = { source: "workers/counter", className: "CounterDO", objectKey: "legacy-1" };
    const legacy = {
      legacyWorkerdDoDir: path.join(root, "state", "workerd-do"),
      legacyWorkerdUniversalDoDir: path.join(root, "state", "workerd-universal-do"),
    };
    // The workspace's own database names the object; the object has 2 rows and a KV value.
    const wsKey = createHash("sha256").update(JSON.stringify([INTERNAL, "WorkspaceDO"])).digest("hex");
    fs.mkdirSync(path.join(legacy.legacyWorkerdDoDir, wsKey), { recursive: true });
    const workspace = new DatabaseSync(
      path.join(legacy.legacyWorkerdDoDir, wsKey, `${legacyWorkerdObjectHash(wsKey, "ws-1")}.sqlite`)
    );
    workspace.exec(
      "CREATE TABLE entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_repo_path TEXT NOT NULL, class_name TEXT, key TEXT NOT NULL)"
    );
    workspace
      .prepare("INSERT INTO entities VALUES ('e1', 'do', ?, ?, ?)")
      .run(ref.source, ref.className, ref.objectKey);
    workspace.exec("CREATE TABLE count (value INTEGER)");
    workspace.exec("INSERT INTO count VALUES (1), (1), (1)");
    workspace.close();
    const universalDir = path.join(legacy.legacyWorkerdUniversalDoDir, UNIVERSAL_KEY);
    fs.mkdirSync(universalDir, { recursive: true });
    const hash = legacyWorkerdObjectHash(UNIVERSAL_KEY, encodeUniversalKey(ref));
    writeRoot(path.join(universalDir, `${hash}.sqlite`), { "root-key": "root-value" });
    writeCounter(path.join(universalDir, `${hash}.1.sqlite`), 2);

    // A node of a probe application with the same class shapes: UniversalDO
    // hosting the facet `do`, and a product-style class `Counter`.
    const probe = await startCelldProbe({
      root: path.join(root, "probe"),
      bundle: `${COUNTER}
        export class UniversalDO {
          constructor(ctx, env) { this.ctx = ctx; this.env = env; }
          async fetch(req) {
            const worker = this.env.LOADER.load({ compatibilityDate: '2025-12-01', mainModule: 'facet.js', modules: { 'facet.js': ${JSON.stringify(COUNTER)} } });
            const facet = this.ctx.facets.get('do', () => ({ class: worker.getDurableObjectClass('Counter') }));
            const kv = await this.ctx.storage.get('root-key');
            const response = await facet.fetch(req);
            return Response.json({ count: Number(await response.text()), kv });
          }
        }
        export default { fetch(req, env) {
          const [kind, name] = new URL(req.url).pathname.slice(1).split('/');
          const binding = kind === 'universal' ? env.UNIVERSAL : env.COUNTER;
          return binding.get(binding.idFromName(decodeURIComponent(name))).fetch(req);
        } };`,
      classes: ["UniversalDO", "Counter"],
      bindings: [
        { name: "UNIVERSAL", class_name: "UniversalDO" },
        { name: "COUNTER", class_name: "Counter" },
      ],
      loader: true,
    });
    // The same supervisor the product uses, over the probe's bucket and state.
    const node = new CelldNode({
      binary: celldTestBinary()!,
      stateDir: path.join(root, "probe", "celld"),
      blobRoot: path.join(root, "probe", "blobs"),
      nodeId: "probe-node",
      onOutput: () => undefined,
    });
    const report = await migrateLegacyWorkerdStorage({
      layout: legacy,
      stateDir: path.join(root, "probe", "celld"),
      workspaceId: "ws-1",
      internalClasses: ["Counter"],
      importer: node,
      script: "probe",
    });
    // Only what a record names is imported: the "WorkspaceDO" database is not
    // one of this probe's classes, so the userland object alone is.
    expect(report.imported.map((entry) => entry.cell)).toEqual(["UniversalDO"]);
    await probe.start();
    try {
      const served = await fetch(
        `${probe.endpoint}/universal/${encodeURIComponent(encodeUniversalKey(ref))}`
      );
      // The facet's two imported rows plus this request's, and the root's KV
      // value converted from workerd's table.
      expect(await served.json()).toEqual({ count: 3, kv: "root-value" });
    } finally {
      await probe.stop();
    }
    // A second run, after the marker, changes nothing.
    expect(
      (
        await migrateLegacyWorkerdStorage({
          layout: legacy,
          stateDir: path.join(root, "probe", "celld"),
          workspaceId: "ws-1",
          internalClasses: ["Counter"],
          importer: node,
          script: "probe",
        })
      ).state
    ).toBe("already-complete");
  }, 120_000);

  it("imports a product object under its class and key (the workspace's own database)", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-migration-"));
    const legacy = {
      legacyWorkerdDoDir: path.join(root, "state", "workerd-do"),
      legacyWorkerdUniversalDoDir: path.join(root, "state", "workerd-universal-do"),
    };
    const key = createHash("sha256").update(JSON.stringify([INTERNAL, "WorkspaceDO"])).digest("hex");
    fs.mkdirSync(path.join(legacy.legacyWorkerdDoDir, key), { recursive: true });
    // Four rows; a database with no entity table simply names no other objects.
    writeCounter(
      path.join(legacy.legacyWorkerdDoDir, key, `${legacyWorkerdObjectHash(key, "ws-1")}.sqlite`),
      4
    );
    const probe = await startCelldProbe({
      root: path.join(root, "probe"),
      bundle: `${COUNTER.replace("class Counter", "class WorkspaceDO")}
        export default { fetch(req, env) { const name = new URL(req.url).pathname.slice(1); return env.WORKSPACEDO.get(env.WORKSPACEDO.idFromName(name)).fetch(req); } };`,
      classes: ["WorkspaceDO"],
    });
    const node = new CelldNode({
      binary: celldTestBinary()!,
      stateDir: path.join(root, "probe", "celld"),
      blobRoot: path.join(root, "probe", "blobs"),
      nodeId: "probe-node",
      onOutput: () => undefined,
    });
    const report = await migrateLegacyWorkerdStorage({
      layout: legacy,
      stateDir: path.join(root, "probe", "celld"),
      workspaceId: "ws-1",
      internalClasses: ["WorkspaceDO"],
      importer: node,
      script: "probe",
    });
    expect(report.imported).toEqual([{ cell: "WorkspaceDO", name: "ws-1" }]);
    expect(report.unmapped).toEqual([]);
    await probe.start();
    try {
      expect(await (await fetch(`${probe.endpoint}/ws-1`)).text()).toBe("5");
    } finally {
      await probe.stop();
    }
  }, 120_000);
});
