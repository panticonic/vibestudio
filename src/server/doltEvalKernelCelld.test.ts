/**
 * P2 prerequisites of the Dolt redesign (§7), checked on the real fork before
 * the eval kernel moves: a kernel is a Dolt facet of its owner's root cell,
 * loaded through a Worker Loader with `celld: { codegen, residency }`.
 *
 * What it settles:
 * - the loaded kernel compiles with `new Function`; a sibling facet loaded
 *   without the grant cannot (confinement per isolate);
 * - the kernel commits once per finished run in its own Dolt facet store, and
 *   that history survives a kill;
 * - a residency hold keeps the heap past `CELLD_IDLE_EVICT_S` (no timer), and a
 *   release makes the object evictable again (Q3);
 * - which isolate's `onrevoked` runs on a drain (the design persists the scope
 *   snapshot there).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { celldTestBinary, startCelldProbe } from "../../tests/helpers/celldNodeHarness.js";

const KERNEL = `
export class Kernel {
  constructor(ctx) {
    this.ctx = ctx;
    this.runs = 0;
    this.hold = null;
    // A Dolt facet: the table and its commit are one durable step.
    const sql = ctx.storage.sql;
    if (sql.exec("SELECT name FROM sqlite_master WHERE name = 'runs'").toArray().length === 0) {
      ctx.storage.transactionSync(
        () => sql.exec('CREATE TABLE runs (id INTEGER PRIMARY KEY, status TEXT NOT NULL)'),
        { commit: 'kernel schema' });
    }
  }
  commit(message, write) {
    this.ctx.storage.transactionSync(write, { commit: message });
  }
  async fetch(request) {
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;
    switch (url.pathname) {
      case '/run': {
        const result = new Function('return ' + url.searchParams.get('code'))();
        this.runs++;
        this.commit('eval: run ' + this.runs + ' ok', () => sql.exec("INSERT INTO runs(status) VALUES ('ok')"));
        return Response.json({ result, runs: this.runs });
      }
      case '/hold': {
        this.hold ??= await this.ctx.residency.hold();
        if (url.searchParams.get('own') === '1') {
          // The facet registers its own revocation handler.
          this.hold.onrevoked = async ({ reason }) => {
            this.commit('facet onrevoked: ' + reason, () => sql.exec("INSERT INTO runs(status) VALUES ('facet-revoked')"));
          };
        }
        return Response.json({ held: true });
      }
      case '/release': this.hold?.release(); this.hold = null; return Response.json({ released: true });
      case '/persist': {
        const reason = url.searchParams.get('reason');
        this.commit('root onrevoked: ' + reason, () => sql.exec("INSERT INTO runs(status) VALUES ('root-revoked')"));
        return Response.json({ persisted: true });
      }
      default:
        return Response.json({
          log: this.ctx.storage.dolt.log({ limit: 20 }).map((entry) => entry.message),
          rows: sql.exec('SELECT status FROM runs ORDER BY id').toArray().map((row) => row.status),
          runs: this.runs,
          hasDolt: typeof this.ctx.storage.dolt,
        });
    }
  }
}`;

const AGENT = `
export class Agent {
  constructor(ctx) { this.ctx = ctx; }
  fetch() {
    try { return Response.json({ result: new Function('return 1')() }); }
    catch (error) { return Response.json({ error: String(error && error.message || error) }); }
  }
}`;

function rootSource(): string {
  return `
    const KERNEL = ${JSON.stringify(KERNEL)};
    const AGENT = ${JSON.stringify(AGENT)};
    export class Root {
      constructor(ctx, env) { this.ctx = ctx; this.env = env; this.born = Date.now() + ':' + Math.random(); }
      kernel() {
        const worker = this.env.LOADER.load({
          compatibilityDate: '2025-12-01', mainModule: 'k.js', modules: { 'k.js': KERNEL },
          celld: { codegen: true, residency: true },
        });
        return this.ctx.facets.get('eval:s1', () => ({
          class: worker.getDurableObjectClass('Kernel'),
          celld: { storage: 'dolt', doltLocal: ['local_%'] },
        }));
      }
      agent() {
        const worker = this.env.LOADER.load({ compatibilityDate: '2025-12-01', mainModule: 'a.js', modules: { 'a.js': AGENT } });
        return this.ctx.facets.get('agent', () => ({ class: worker.getDurableObjectClass('Agent') }));
      }
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/born') return Response.json({ born: this.born });
        if (url.pathname.startsWith('/agent')) return this.agent().fetch(new Request('http://f/' + url.search));
        if (url.pathname === '/root-hold') {
          // The root takes the hold and relays revocation to the kernel facet.
          this.hold ??= await this.ctx.residency.hold();
          this.hold.onrevoked = async ({ reason }) => {
            await this.kernel().fetch(new Request('http://k/persist?reason=' + reason));
          };
          return Response.json({ held: true });
        }
        if (url.pathname === '/root-release') { this.hold?.release(); this.hold = null; return Response.json({ released: true }); }
        if (url.pathname.startsWith('/kernel')) {
          return this.kernel().fetch(new Request('http://k' + url.pathname.slice('/kernel'.length) + url.search));
        }
        return Response.json({ path: url.pathname });
      }
    }
    export default {
      fetch(request, env) {
        const name = new URL(request.url).searchParams.get('object') || 'owner';
        return env.ROOT.get(env.ROOT.idFromName(name)).fetch(request);
      },
    };`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it.skipIf(!celldTestBinary())(
  "an eval kernel as a Dolt facet: codegen grant, per-run commits, residency without a timer, and revocation",
  async () => {
    const previous = process.env["CELLD_IDLE_EVICT_S"];
    process.env["CELLD_IDLE_EVICT_S"] = "1";
    const root = await mkdtemp(join(homedir(), ".dolt-eval-kernel-probe-"));
    const probe = await startCelldProbe({
      root,
      bundle: rootSource(),
      classes: ["Root"],
      loader: true,
      celld: { durable_objects: { Root: { codegen: true, residency: true } } },
    });
    onTestFinished(async () => {
      if (previous === undefined) delete process.env["CELLD_IDLE_EVICT_S"];
      else process.env["CELLD_IDLE_EVICT_S"] = previous;
      await probe.kill();
      await rm(root, { recursive: true, force: true });
    });
    await probe.start();
    const call = async (path: string, object = "owner") => {
      const separator = path.includes("?") ? "&" : "?";
      const response = await fetch(`${probe.endpoint}${path}${separator}object=${object}`);
      if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`);
      return (await response.json()) as Record<string, unknown>;
    };

    // 1. Codegen is a per-isolate grant: the kernel compiles, a sibling facet loaded without it cannot.
    expect(await call("/kernel/run?code=40%2B2")).toMatchObject({ result: 42, runs: 1 });
    const confined = await call("/agent/x");
    expect(confined["result"]).toBeUndefined();
    expect(String(confined["error"])).toMatch(/code generation|eval|Function/i);

    // 2. One commit per finished run, in the facet's own Dolt store, surviving a kill.
    await call("/kernel/run?code=1%2B1");
    const info = await call("/kernel/info");
    expect(info["hasDolt"]).toBe("object");
    expect((info["log"] as string[]).slice(0, 2)).toEqual(["eval: run 2 ok", "eval: run 1 ok"]);
    await probe.kill();
    await probe.start();
    const afterKill = await call("/kernel/info");
    expect((afterKill["log"] as string[]).slice(0, 2)).toEqual([
      "eval: run 2 ok",
      "eval: run 1 ok",
    ]);
    expect(afterKill["rows"]).toEqual(["ok", "ok"]);

    // 3. A residency hold keeps the object (and so its heap) past the idle
    //    eviction time, with no timer; an unheld object is evicted; a release
    //    makes the held one evictable again.
    const heldBorn = (await call("/born"))["born"];
    const plainBorn = (await call("/born", "plain"))["born"];
    await call("/root-hold");
    await sleep(5000);
    expect((await call("/born"))["born"]).toBe(heldBorn);
    expect((await call("/born", "plain"))["born"]).not.toBe(plainBorn);
    await call("/root-release");
    await sleep(5000);
    expect((await call("/born"))["born"]).not.toBe(heldBorn);

    // 4. A drain revokes holds. The design (§7.4) persists the scope snapshot
    //    in `onrevoked`. The residency doc says a handler registered inside a
    //    facet's separate loaded isolate does not run, so the root registers
    //    it and relays to the kernel facet. Both are asserted as observed.
    await call("/root-hold");
    await call("/kernel/hold?own=1");
    await probe.stop();
    await probe.start();
    const afterDrain = await call("/kernel/info");
    const log = afterDrain["log"] as string[];
    console.log("revocation log after a drain:", JSON.stringify(log.slice(0, 4)));
    expect(log.some((message) => message.startsWith("root onrevoked: "))).toBe(true);
    // Observed on fcc7268, recorded in the design: the facet's own handler does not run.
    expect(log.some((message) => message.startsWith("facet onrevoked: "))).toBe(false);
  },
  180_000
);
