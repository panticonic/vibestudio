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
    if (url.pathname === '/spin-detached') {
      // What a kernel's start does: answer at once and run the cell under waitUntil.
      this.spins++;
      this.ctx.waitUntil((async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        for (let i = 0; i < 4e12; i++) { if (i % 1e6 === 0 && Date.now() > Date.now() + 1e9) break; }
      })());
      return Response.json({ started: true });
    }
    return Response.json({ ok: true, spins: this.spins, born: this.born ??= String(Math.random()) });
  }
}`;

function rootSource(cpuMs: number | null): string {
  return `
    const KERNEL = ${JSON.stringify(KERNEL)};
    export class Root {
      constructor(ctx, env) { this.ctx = ctx; this.env = env; }
      kernel(cpuMs) {
        const worker = this.env.LOADER.load({
          compatibilityDate: '2025-12-01', mainModule: 'k.js', modules: { 'k.js': KERNEL },
          ${cpuMs === null ? "" : `limits: { cpuMs: ${cpuMs} },`}
        });
        const startup = () => ({ class: worker.getDurableObjectClass('Kernel') });
        // A per-call limit rides on the stub get returns (celld ec0d6f5), lower-wins with the unit's.
        return cpuMs ? this.ctx.facets.get('kernel', startup, { limits: { cpuMs } }) : this.ctx.facets.get('kernel', startup);
      }
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/kernel')) {
          const cpu = Number(url.searchParams.get('cpu')) || 0;
          return this.kernel(cpu).fetch(new Request('http://k' + url.pathname.slice('/kernel'.length) + url.search));
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
  "with no unit limit a spin is not ended by the node, and a limit on one call (the run's timeoutMs) ends exactly that call",
  async () => {
    const probe = await probeWith(null);
    const base = probe.endpoint;
    expect((await timed(`${base}/kernel/info?object=owner`, 20_000)).status).toBe(200);
    const born = (
      (await (await fetch(`${base}/kernel/info?object=owner`)).json()) as { born: string }
    ).born;
    // No limit anywhere: the call is not ended in the window (the case the host supervisor covered).
    const unlimited = await timed(`${base}/kernel/spin?object=owner`, 6_000);
    console.log("spin with no limit:", JSON.stringify(unlimited));
    expect(unlimited.status === 200 && unlimited.ms < 6_000).toBe(false);
    // The same call with a limit of its own (celld ec0d6f5: ctx.facets.get(name, startup, { limits })).
    const limited = await timed(`${base}/kernel/spin?object=other&cpu=1500`, 30_000);
    console.log("spin with a per-call limit of 1500 ms:", JSON.stringify(limited));
    expect(limited.status).not.toBe(200);
    expect(limited.body).toContain("CPU limit of 1500");
    expect(limited.ms).toBeGreaterThan(1200);
    expect(limited.ms).toBeLessThan(5_000);
    // The kernel keeps its heap and answers the next call.
    const afterLimited = (await (await fetch(`${base}/kernel/info?object=other`)).json()) as {
      spins: number;
    };
    expect(afterLimited.spins).toBe(1);
    // A run's work happens after start has answered (waitUntil). The limit of the start call
    // still bounds it: the kernel answers again at about the limit, with its heap.
    const detached = await timed(`${base}/kernel/spin-detached?object=third&cpu=1500`, 30_000);
    expect(detached.status).toBe(200);
    const detachedStarted = Date.now();
    const after = await timed(`${base}/kernel/info?object=third`, 30_000);
    console.log(
      "after a detached spin with a per-call limit of 1500 ms: start",
      JSON.stringify(detached),
      "next call answered after",
      Date.now() - detachedStarted,
      "ms",
      JSON.stringify(after)
    );
    expect(after.status).toBe(200);
    expect(Date.now() - detachedStarted).toBeLessThan(6_000);
    // The same heap: an ended run is not a lost kernel.
    expect(born).toBeTruthy();
  },
  120_000
);
