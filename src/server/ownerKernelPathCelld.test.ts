/**
 * Owner-to-kernel paths for the eval kernel facet (docs/dolt-redesign.md §7.2),
 * checked on the real fork. The kernel is a Dolt facet that only its root can
 * name, so the question is how the owner's own code (the `do` facet of a
 * UniversalDO root: a loaded worker without codegen) reaches it:
 *
 * - through a service binding the root creates for it (`ctx.exports.Gateway({
 *   props: { name } })`: a loaded worker's env supports only service bindings,
 *   not a namespace), which calls back into the root cell; the props name the
 *   owner's own root, so no other owner is addressable;
 * - by loading the kernel itself with the codegen grant (it cannot: a loaded
 *   worker's env carries only service bindings, so it has no loader).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { celldTestBinary, startCelldProbe } from "../../tests/helpers/celldNodeHarness.js";

const KERNEL = `
export class Kernel {
  constructor(ctx) { this.ctx = ctx; this.runs = 0; }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      this.runs++;
      return Response.json({ result: new Function('return ' + url.searchParams.get('code'))(), runs: this.runs });
    }
    return Response.json({ ok: true });
  }
}`;

const OWNER = `
export class Owner {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/via-root': {
        // The owner reaches its kernel through the gateway its root bound for it.
        const response = await this.env.KERNEL_GATEWAY.fetch('http://root/kernel/run?code=' + encodeURIComponent(url.searchParams.get('code')));
        return Response.json({ status: response.status, body: await response.json().catch(() => null) });
      }
      case '/load-kernel': {
        // The owner loads a kernel with the codegen grant, which it does not hold.
        try {
          const worker = this.env.LOADER.load({
            compatibilityDate: '2025-12-01', mainModule: 'k.js', modules: { 'k.js': ${JSON.stringify(KERNEL)} },
            celld: { codegen: true },
          });
          const facet = this.ctx.facets.get('nested', () => ({ class: worker.getDurableObjectClass('Kernel') }));
          const response = await facet.fetch('http://k/run?code=1');
          return Response.json({ loaded: true, body: await response.json() });
        } catch (error) {
          return Response.json({ loaded: false, error: String(error && error.message || error) });
        }
      }
      default:
        return Response.json({ owner: true });
    }
  }
}`;

function rootSource(): string {
  return `
    const KERNEL = ${JSON.stringify(KERNEL)};
    const OWNER = ${JSON.stringify(OWNER)};
    import { WorkerEntrypoint } from 'cloudflare:workers';
    // A service binding is the only capability a loaded worker's env can carry.
    // The root binds one per owner, and the owner's name is in its props.
    export class KernelGateway extends WorkerEntrypoint {
      fetch(request) {
        const name = this.ctx.props.name;
        return this.env.ROOT.get(this.env.ROOT.idFromName(name)).fetch(request);
      }
    }
    export class Root {
      constructor(ctx, env) { this.ctx = ctx; this.env = env; }
      kernel(name) {
        const worker = this.env.LOADER.get('kernel-v1', () => ({
          compatibilityDate: '2025-12-01', mainModule: 'k.js', modules: { 'k.js': KERNEL },
          celld: { codegen: true, residency: true },
        }));
        return this.ctx.facets.get('eval:' + name, () => ({
          class: worker.getDurableObjectClass('Kernel'),
          celld: { storage: 'dolt' },
        }));
      }
      owner() {
        const name = this.ctx.id.name;
        const worker = this.env.LOADER.get('owner-v1', () => ({
          compatibilityDate: '2025-12-01', mainModule: 'o.js', modules: { 'o.js': OWNER },
          env: { KERNEL_GATEWAY: this.ctx.exports.KernelGateway({ props: { name } }) },
        }));
        return this.ctx.facets.get('do', () => ({ class: worker.getDurableObjectClass('Owner') }));
      }
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/kernel/')) {
          return this.kernel('default').fetch(new Request('http://k' + url.pathname.slice('/kernel'.length) + url.search));
        }
        if (url.pathname.startsWith('/owner')) {
          return this.owner().fetch(new Request('http://o' + url.pathname.slice('/owner'.length) + url.search));
        }
        return Response.json({ path: url.pathname });
      }
    }
    export default {
      fetch(request, env) {
        const name = new URL(request.url).searchParams.get('object') || 'owner-a';
        return env.ROOT.get(env.ROOT.idFromName(name)).fetch(request);
      },
    };`;
}

it.skipIf(!celldTestBinary())(
  "the owner facet reaches its kernel through a gateway its root binds; it cannot load one; owners are isolated",
  async () => {
    const root = await mkdtemp(join(homedir(), ".owner-kernel-path-probe-"));
    const probe = await startCelldProbe({
      root,
      bundle: rootSource(),
      classes: ["Root"],
      loader: true,
      onOutput: (_stream, line) => {
        if (process.env["PROBE_LOG"]) console.log("[celld]", line);
      },
      celld: { durable_objects: { Root: { codegen: true, residency: true } } },
    });
    onTestFinished(async () => {
      await probe.kill();
      await rm(root, { recursive: true, force: true });
    });
    await probe.start();
    const call = async (path: string, object = "owner-a") => {
      const separator = path.includes("?") ? "&" : "?";
      const response = await fetch(`${probe.endpoint}${path}${separator}object=${object}`);
      const text = await response.text();
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { text };
      }
      return { status: response.status, body };
    };

    // The owner's own code reaches its kernel through a stub of its root.
    const viaRoot = await call("/owner/via-root?code=40%2B2");
    console.log("owner -> root -> kernel:", JSON.stringify(viaRoot));
    expect(viaRoot.status).toBe(200);
    expect(viaRoot.body).toMatchObject({ status: 200, body: { result: 42 } });

    // The owner's loaded worker has no LOADER (its env carries only service
    // bindings), so it can neither load a kernel nor grant codegen itself.
    const load = await call("/owner/load-kernel");
    console.log("owner loads a codegen kernel:", JSON.stringify(load));
    expect(load.body).toMatchObject({ loaded: false });

    // Another owner's root has its own kernel: its run counter starts again,
    // and no path reaches owner A's kernel from owner B's facet.
    const own = await call("/kernel/run?code=2", "owner-b");
    expect(own.body).toMatchObject({ result: 2, runs: 1 });
    const again = await call("/kernel/run?code=3", "owner-a");
    expect(again.body).toMatchObject({ result: 3, runs: 2 });
  },
  120_000
);
