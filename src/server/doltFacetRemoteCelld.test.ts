import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { celldTestBinary, startCelldProbe } from "../../tests/helpers/celldNodeHarness.js";

const canonicalModule = `
  export class Canonical {
    constructor(ctx) { this.ctx = ctx; }

    async ondoltpush(event) {
      await this.ctx.storage.put('accepted', {
        ...event,
        head: this.ctx.storage.dolt.hashOf(event.branch),
        rows: this.rows(),
      });
    }

    rows() {
      return this.ctx.storage.sql.exec('SELECT value FROM facts ORDER BY value').toArray();
    }

    async fetch(request) {
      const { storage } = this.ctx;
      const { dolt } = storage;
      switch (new URL(request.url).pathname) {
        case '/grant':
          storage.transactionSync(() => {
            storage.sql.exec('CREATE TABLE facts (value TEXT PRIMARY KEY)');
            storage.sql.exec("INSERT INTO facts VALUES ('base')");
          }, { commit: 'canonical base' });
          return Response.json(dolt.remote.grant({ fetch: true, branches: ['main'], push: ['main'] }));
        case '/serve':
          return new Response(await dolt.remote.serve(new Uint8Array(await request.arrayBuffer())));
        case '/state':
          return Response.json({ head: dolt.hashOf('main'), rows: this.rows(), accepted: await storage.get('accepted') });
        default:
          return new Response('unknown canonical operation', { status: 404 });
      }
    }
  }
`;

const bundle = `
  const canonicalModule = ${JSON.stringify(canonicalModule)};
  export class Root {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }

    fetch(request) {
      const worker = this.env.LOADER.load({
        compatibilityDate: '2025-12-01', mainModule: 'canonical.js',
        modules: { 'canonical.js': canonicalModule },
      });
      const canonical = this.ctx.facets.get('canonical', () => ({
        class: worker.getDurableObjectClass('Canonical'), celld: { storage: 'dolt' },
      }));
      return canonical.fetch(request);
    }
  }

  export class Holder {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }

    async fetch(request) {
      const rootId = this.env.ROOT.idFromName('canonical-owner');
      const root = this.env.ROOT.get(rootId);
      const grantResponse = await root.fetch('https://canonical/grant');
      if (!grantResponse.ok) return grantResponse;
      const grant = await grantResponse.json();
      const { storage } = this.ctx;
      const { dolt } = storage;
      dolt.remote.add('origin', { ref: 'Root:' + rootId.toString(), token: grant.token });
      const transport = async (body) => {
        const reply = await root.fetch('https://canonical/serve', { method: 'POST', body });
        if (!reply.ok) throw new Error(await reply.text());
        return reply.arrayBuffer();
      };
      const fetched = await dolt.fetch('origin', { branches: ['main'], transport });
      dolt.branch.create('work', { from: 'origin/main' });
      dolt.checkout('work');
      storage.transactionSync(() => storage.sql.exec("INSERT INTO facts VALUES ('published')"),
        { commit: 'participant change' });
      const push = await dolt.push('origin', 'work', { to: 'main', transport });
      return Response.json({ base: fetched.branches.main, push, grantId: grant.id });
    }
  }

  export default {
    fetch(request, env) {
      if (new URL(request.url).pathname === '/state') {
        return env.ROOT.get(env.ROOT.idFromName('canonical-owner')).fetch(request);
      }
      return env.HOLDER.get(env.HOLDER.idFromName('participant')).fetch(request);
    },
  };
`;

it.skipIf(!celldTestBinary())(
  "relays a push to a loaded Dolt facet and delivers its notification",
  async () => {
    const root = await mkdtemp(join(homedir(), ".dolt-facet-remote-probe-"));
    const probe = await startCelldProbe({
      root,
      bundle,
      classes: ["Root"],
      doltClasses: ["Holder"],
      loader: true,
      celld: { durable_objects: { Root: { doltRemotes: true }, Holder: { doltRemotes: true } } },
    });
    onTestFinished(async () => {
      await probe.kill();
      await rm(root, { recursive: true, force: true });
    });
    await probe.start();
    const call = async (path: string) => {
      const response = await fetch(`${probe.endpoint}${path}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`);
      return response.json();
    };

    const { push, base, grantId } = await call("/publish");
    expect(push).toMatchObject({ branch: "main", created: false, unchanged: false });
    expect(push.hash).not.toBe(base);
    const rows = [{ value: "base" }, { value: "published" }];
    expect(await call("/state")).toMatchObject({
      head: push.hash,
      rows,
      accepted: {
        grant: grantId,
        branch: "main",
        from: base,
        to: push.hash,
        head: push.hash,
        rows,
      },
    });
  },
  45_000
);
