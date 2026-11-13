/**
 * The runtime's native features on the real fork binary, with nothing of the
 * product around them: a one-module probe on its own node. What Vibestudio
 * relies on from the runtime itself, in the smallest program that shows it
 * (set `VIBESTUDIO_CELLD_BIN`, or stage `native/celld`).
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  celldTestBinary,
  startCelldProbe,
  type CelldProbe,
} from "../../tests/helpers/celldNodeHarness.js";

const COUNTER = `export class Counter {
  constructor(ctx) { this.sql = ctx.storage.sql; this.sql.exec('CREATE TABLE IF NOT EXISTS count (value INTEGER)'); }
  fetch() { this.sql.exec('INSERT INTO count VALUES (1)'); return new Response(String(this.sql.exec('SELECT count(*) AS n FROM count').one().n)); }
}`;

const FACET_COUNTER = JSON.stringify(COUNTER);

describe.skipIf(!celldTestBinary())("runtime native features (real celld)", () => {
  let probe: CelldProbe | undefined;
  let root: string | undefined;

  afterEach(async () => {
    await probe?.kill();
    probe = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function start(options: Omit<Parameters<typeof startCelldProbe>[0], "root">) {
    root = await mkdtemp(path.join(os.tmpdir(), "vibestudio-celld-native-"));
    probe = await startCelldProbe({ root, ...options });
    await probe.start();
    return probe;
  }

  it("serves HTTP", async () => {
    const p = await start({
      bundle: 'export default { fetch() { return new Response("http-ok"); } };',
      classes: [],
    });
    expect(await (await fetch(p.endpoint)).text()).toBe("http-ok");
  }, 30_000);

  it("provides the Node.js compatibility surface the product imports", async () => {
    const p = await start({
      bundle: `import { createHash } from 'node:crypto';
        export default { fetch() { return new Response(createHash('sha256').update('native').digest('hex')); } };`,
      classes: [],
    });
    expect(await (await fetch(p.endpoint)).text()).toBe(
      createHash("sha256").update("native").digest("hex")
    );
  }, 30_000);

  it("serves the V8 inspector, one target per isolate", async () => {
    const p = await start({
      bundle: 'export default { fetch() { return new Response("ok"); } };',
      classes: [],
      inspector: true,
    });
    await (await fetch(p.endpoint)).text();
    const targets = await fetch(`http://127.0.0.1:${p.inspectorPort}/json/list`);
    expect(targets.status).toBe(200);
    expect(((await targets.json()) as unknown[]).length).toBeGreaterThan(0);
  }, 30_000);

  it("keeps a Durable Object's SQLite across a durable stop and a new node", async () => {
    const p = await start({
      bundle: `${COUNTER}
        export default { fetch(req, env) { return env.COUNTER.get(env.COUNTER.idFromName('test')).fetch(req); } };`,
      classes: ["Counter"],
    });
    expect(await (await fetch(p.endpoint)).text()).toBe("1");
    expect(await (await fetch(p.endpoint)).text()).toBe("2");
    await p.stop();
    await p.start();
    expect(await (await fetch(p.endpoint)).text()).toBe("3");
  }, 60_000);

  it("runs a facet loaded through a Worker Loader, with its own SQLite", async () => {
    const p = await start({
      bundle: `export class UniversalDO {
          constructor(ctx, env) { this.ctx = ctx; this.env = env; }
          fetch(req) {
            const worker = this.env.LOADER.load({ compatibilityDate: '2025-12-01', mainModule: 'facet.js', modules: { 'facet.js': ${FACET_COUNTER} } });
            const facet = this.ctx.facets.get('do', () => ({ class: worker.getDurableObjectClass('Counter') }));
            return facet.fetch(req);
          }
        }
        export default { fetch(req, env) { return env.COUNTER.get(env.COUNTER.idFromName('test')).fetch(req); } };`,
      classes: ["UniversalDO"],
      bindings: [{ name: "COUNTER", class_name: "UniversalDO" }],
      loader: true,
    });
    expect(await (await fetch(p.endpoint)).text()).toBe("1");
    expect(await (await fetch(p.endpoint)).text()).toBe("2");
    await p.stop();
    await p.start();
    expect(await (await fetch(p.endpoint)).text()).toBe("3");
  }, 60_000);

  it("loads a dynamic Worker", async () => {
    const p = await start({
      bundle: `export default { async fetch(req, env) {
        const worker = env.LOADER.get('test', async () => ({ compatibilityDate: '2025-12-01', mainModule: 'worker.js', modules: { 'worker.js': 'export default { fetch() { return new Response("dynamic-ok") } }' } }));
        return worker.getEntrypoint().fetch(req);
      } };`,
      classes: [],
      loader: true,
    });
    expect(await (await fetch(p.endpoint)).text()).toBe("dynamic-ok");
  }, 30_000);
});
