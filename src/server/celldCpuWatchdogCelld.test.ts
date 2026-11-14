/**
 * D4 of the Dolt redesign (§7.8): does celld's own per-isolate limit cover a
 * CPU-starved dynamic-code kernel, so the host's per-run liveness supervisor
 * can go? A kernel facet is a Dolt facet of its owner's root, loaded through a
 * Worker Loader. Guest code in it can spin forever. The probe runs that on the
 * real fork with `limits: { cpuMs }` on the loaded worker and records what the
 * node does to the call, to the root and to a sibling object.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { celldTestBinary, startCelldProbe } from "../../tests/helpers/celldNodeHarness.js";

const KERNEL = `
export class Kernel {
  constructor(ctx) { this.ctx = ctx; this.spins = 0; }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/spin') {
      this.spins++;
      const until = Date.now() + 1e9;
      // A synchronous spin: nothing else can run in this isolate meanwhile.
      for (let i = 0; i < 4e12; i++) { if (i % 1e6 === 0 && Date.now() > until) break; }
      return Response.json({ spun: true });
    }
    if (url.pathname === '/work') {
      // Fixed CPU work (workerd's clock does not advance without I/O, so count iterations).
      let x = 0; const n = Number(url.searchParams.get('n'));
      for (let i = 0; i < n; i++) x += Math.sqrt(i);
      return Response.json({ worked: n, x });
    }
    return Response.json({ ok: true, spins: this.spins, born: this.born ??= String(Math.random()) });
  }
}`;

function rootSource(cpuMs: number | null): string {
  return `
    const KERNEL = ${JSON.stringify(KERNEL)};
    export class Root {
      constructor(ctx, env) { this.ctx = ctx; this.env = env; }
      kernel() {
        const worker = this.env.LOADER.load({
          compatibilityDate: '2025-12-01', mainModule: 'k.js', modules: { 'k.js': KERNEL },
          ${cpuMs === null ? "" : `limits: { cpuMs: ${cpuMs} },`}
        });
        return this.ctx.facets.get('kernel', () => ({ class: worker.getDurableObjectClass('Kernel') }));
      }
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/kernel')) {
          return this.kernel().fetch(new Request('http://k' + url.pathname.slice('/kernel'.length) + url.search));
        }
        return Response.json({ rootAlive: true });
      }
    }
    export default {
      fetch(request, env) {
        const name = new URL(request.url).searchParams.get('object') || 'owner';
        return env.ROOT.get(env.ROOT.idFromName(name)).fetch(request);
      },
    };`;
}

async function probeWith(cpuMs: number | null) {
  const root = await mkdtemp(join(homedir(), ".cpu-watchdog-probe-"));
  const probe = await startCelldProbe({
    root,
    bundle: rootSource(cpuMs),
    classes: ["Root"],
    loader: true,
    celld: { durable_objects: { Root: { codegen: true, residency: true } } },
  });
  onTestFinished(async () => {
    await probe.kill();
    await rm(root, { recursive: true, force: true });
  });
  await probe.start();
  return probe;
}

async function timed(url: string, ms: number) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return {
      status: response.status,
      body: (await response.text()).slice(0, 300),
      ms: Date.now() - started,
    };
  } catch (error) {
    return { status: 0, body: String(error), ms: Date.now() - started };
  }
}

it.skipIf(!celldTestBinary())(
  "a loaded worker's cpuMs limit ends a spinning kernel call, and the root and a sibling object stay answerable",
  async () => {
    const probe = await probeWith(1000);
    const base = probe.endpoint;
    expect((await timed(`${base}/kernel/info?object=owner`, 20_000)).status).toBe(200);
    const spin = await timed(`${base}/kernel/spin?object=owner`, 30_000);
    console.log("spin with cpuMs=1000:", JSON.stringify(spin));
    const root = await timed(`${base}/anything?object=owner`, 20_000);
    const sibling = await timed(`${base}/kernel/info?object=other`, 20_000);
    console.log(
      "after the spin: root",
      JSON.stringify(root),
      "sibling kernel",
      JSON.stringify(sibling)
    );
    // The limit is per invocation: fixed CPU work, three times over, each under the limit.
    const born = (
      (await (await fetch(`${base}/kernel/info?object=owner`)).json()) as { born: string }
    ).born;
    const again: unknown[] = [];
    for (let i = 0; i < 3; i++)
      again.push(await timed(`${base}/kernel/work?object=owner&n=150000000`, 20_000));
    console.log("same kernel after the ended call:", JSON.stringify(again));
    const afterWork = (
      (await (await fetch(`${base}/kernel/info?object=owner`)).json()) as { born: string }
    ).born;
    console.log("heap kept across within-limit calls:", born === afterWork);
    const afterSpin = (
      (await (await fetch(`${base}/kernel/info?object=owner`)).json()) as { born: string }
    ).born;
    console.log("heap kept across the ended call:", afterWork === afterSpin);
    expect(spin.status).not.toBe(200);
    expect(spin.ms).toBeLessThan(25_000);
    expect(root.status).toBe(200);
    expect(sibling.status).toBe(200);
  },
  120_000
);

it.skipIf(!celldTestBinary())(
  "with no limit a spinning kernel call is not ended by the node (the case the host supervisor covers)",
  async () => {
    const probe = await probeWith(null);
    const base = probe.endpoint;
    expect((await timed(`${base}/kernel/info?object=owner`, 20_000)).status).toBe(200);
    const spin = await timed(`${base}/kernel/spin?object=owner`, 8_000);
    console.log("spin with no limit:", JSON.stringify(spin));
    const sibling = await timed(`${base}/kernel/info?object=other`, 8_000);
    console.log("sibling kernel while owner spins:", JSON.stringify(sibling));
    // Recorded, not asserted either way beyond: the call did not finish normally within the window.
    expect(spin.status === 200 && spin.ms < 8_000).toBe(false);
  },
  120_000
);
