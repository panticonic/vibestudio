import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, it, onTestFinished } from "vitest";
import { celldTestBinary, startCelldProbe, type CelldProbe } from "../../tests/helpers/celldNodeHarness.js";

it.skipIf(!celldTestBinary())("retains large native transcript and document payloads across process replacement on celld", async () => {
  const root = await mkdtemp(join(homedir(), ".native-sqlite-payload-"));
  let cleanupProbe: CelldProbe | undefined;
  const requests = new AbortController();
  const ownedFetches: Promise<unknown>[] = [];
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      requests.abort(new Error("Native SQLite payload fixture retired"));
      await cleanupProbe?.kill();
      await Promise.allSettled(ownedFetches);
      await rm(root, { recursive: true, force: true });
    })());
  onTestFinished(cleanup);
  try {
    const source = `
      import { applySqliteMigrations, NativeDatabase, SqliteStorage } from '@panticonic/pi-durable/storage/sqlite';
      const large = '🙂漢\\ud800'.repeat(500000);
      export class Probe {
        constructor(ctx) { this.ctx = ctx; }
        async fetch(request) {
          const database = new NativeDatabase(this.ctx.storage); await applySqliteMigrations(database); const storage = await SqliteStorage.open(database);
          try {
            if (new URL(request.url).pathname === '/write') {
              const value = {id:2,conversationId:1,kind:'image',model:[{role:'user',content:[{type:'image',mimeType:'image/png',data:large}],timestamp:1}],data:{large}};
              const seq = await storage.commit([
                {type:'conversation',value:{id:1}}, {type:'entry',value},
                {type:'task',value:{id:3,conversationId:1,kind:'large',version:1,input:large,state:{status:'pending',checkpoint:null},abortRequested:false,background:false}},
                {type:'document.create',record:{id:4,kind:'large',scope:{kind:'conversation',conversationId:1},history:'rewindable',fork:'asOf'},content:{kind:'base',version:1,value:{large}}}
              ], () => {}, {});
              await storage.commit([{type:'document.change',id:4,content:{kind:'delta',version:1,ops:[['s',['large'],large+'changed']]}}], () => {}, {});
              return Response.json({written:true,seq,recordBytes:new TextEncoder().encode(JSON.stringify(value)).length});
            }
            const entry = await storage.entry(2,{});
            const scan = await storage.scanEntries({conversationId:1},1,undefined,{});
            const task = await storage.task(3,{});
            const old = await storage.document(4,1,{});
            const current = await storage.document(4,'current',{});
            if (entry?.entry.data.large !== large || entry.entry.model[0].content[0].data !== large || scan.items[0].data.large !== large || task.input !== large || old.value.large !== large || current.value.large !== large+'changed') throw new Error('Reopened payload mismatch');
            await storage.commit([{type:'task',value:{...task,input:'small'}}],() => {},{});
            if ((await storage.task(3,{})).input !== 'small') throw new Error('Owner cannot continue');
            return Response.json({reopened:true,continued:true});
          } finally { await storage.close({}); }
        }
      }
      export default {fetch(request,env){return env.PROBE.get(env.PROBE.idFromName('one')).fetch(request)}};
    `;
    const bundle = await build({
      stdin: {
        contents: source,
        resolveDir: process.cwd(),
        sourcefile: "native-sqlite-payload.ts",
      },
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      conditions: ["worker", "browser"],
      write: false,
    });
    const module = bundle.outputFiles[0]?.text;
    if (!module) throw new Error("Missing native SQLite payload bundle");
    // The probe is one node; replacing the process (a durable stop, then a new
    // node over the same bucket) must reopen what the first one wrote.
    const probe = await startCelldProbe({ root, bundle: module, classes: ["Probe"] });
    cleanupProbe = probe;
    const read = (path: string) => {
      const operation = fetch(`${probe.endpoint}/${path}`, { signal: requests.signal }).then(
        async (response) => {
          if (!response.ok) throw new Error(`Native payload ${path} failed: ${await response.text()}`);
          return response.json();
        }
      );
      ownedFetches.push(operation);
      return operation;
    };
    await probe.start();
    const written = await read("write");
    expect(written).toMatchObject({ written: true, seq: 1 });
    expect(written.recordBytes).toBeGreaterThan(10_000_000);
    await probe.stop();
    await probe.start();
    expect(await read("read")).toEqual({ reopened: true, continued: true });
    await probe.stop();
  } finally {
    await cleanup();
  }
}, 60_000);
