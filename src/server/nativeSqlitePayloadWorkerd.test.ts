import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, it, onTestFinished } from "vitest";

const require = createRequire(import.meta.url);

it("retains large native transcript and document payloads across process replacement", async () => {
  const root = await mkdtemp(join(homedir(), ".native-sqlite-payload-"));
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<void> | undefined;
  let stderr = "";
  const requests = new AbortController();
  const ownedFetches: Promise<unknown>[] = [];
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      requests.abort(new Error("Native SQLite payload fixture retired"));
      if (child?.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
      await Promise.allSettled(ownedFetches);
      await rm(root, { recursive: true, force: true });
    })());
  onTestFinished(cleanup);
  try {
    const source = `
      import {NativeDatabase,SqliteStorage} from '@panticonic/pi-durable/storage/sqlite';
      const large = '🙂漢\\ud800'.repeat(500000);
      export class Probe {
        constructor(ctx) { this.ctx = ctx; }
        async fetch(request) {
          const storage = await SqliteStorage.open(new NativeDatabase(this.ctx.storage));
          try {
            if (new URL(request.url).pathname === '/write') {
              const value = {id:2,conversationId:1,kind:'image',model:[{role:'user',content:[{type:'image',mimeType:'image/png',data:large}],timestamp:1}],data:{large}};
              const seq = await storage.commit([
                {type:'conversation',value:{id:1}}, {type:'entry',value},
                {type:'task',value:{id:3,conversationId:1,kind:'large',version:1,input:large,state:{status:'pending',checkpoint:null},abortRequested:false,background:false}},
                {type:'document.create',record:{id:4,kind:'large',scope:{kind:'conversation',conversationId:1},history:'rewindable',fork:'asOf'},content:{kind:'base',version:1,value:{large}}}
              ], {});
              await storage.commit([{type:'document.change',id:4,content:{kind:'delta',version:1,ops:[['s',['large'],large+'changed']]}}], {});
              return Response.json({written:true,seq,recordBytes:new TextEncoder().encode(JSON.stringify(value)).length});
            }
            const entry = await storage.entry(2,{});
            const scan = await storage.scanEntries({conversationId:1},1,undefined,{});
            const task = await storage.task(3,{});
            const old = await storage.document(4,1,{});
            const current = await storage.document(4,'current',{});
            if (entry?.entry.data.large !== large || entry.entry.model[0].content[0].data !== large || scan.items[0].data.large !== large || task.input !== large || old.value.large !== large || current.value.large !== large+'changed') throw new Error('Reopened payload mismatch');
            await storage.commit([{type:'task',value:{...task,input:'small'}}],{});
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
    await mkdir(join(root, "storage"));
    await writeFile(join(root, "worker.js"), module);
    await writeFile(
      join(root, "config.capnp"),
      `using Workerd = import "/workerd/workerd.capnp";
      const config :Workerd.Config = (services=[(name="main",worker=(compatibilityDate="2026-10-02",bindings=[(name="PROBE",durableObjectNamespace="Probe")],durableObjectNamespaces=[(className="Probe",uniqueKey="large-payload-probe",enableSql=true)],durableObjectStorage=(localDisk="storage"),modules=[(name="worker.js",esModule=embed "worker.js")])),(name="storage",disk=(path=${JSON.stringify(join(root, "storage"))},writable=true))],sockets=[(name="http",address="127.0.0.1",http=(),service="main")]);`
    );
    const start = async () => {
      let resolveListening!: (value: string) => void;
      let rejectListening!: (error: unknown) => void;
      const listening = new Promise<string>((resolve, reject) => {
        resolveListening = resolve;
        rejectListening = reject;
      });
      child = spawn(
        require.resolve("@cloudflare/workerd-linux-64/bin/workerd"),
        [
          "serve",
          "--socket-addr=http=127.0.0.1:0",
          "--experimental",
          "--control-fd=3",
          join(root, "config.capnp"),
        ],
        { stdio: ["ignore", "ignore", "pipe", "pipe"] }
      );
      exited = new Promise<void>((yes) => child!.once("close", yes));
      child.once("error", rejectListening);
      child.stderr!.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-20000);
      });
      let control = "";
      child.stdio[3]!.on("data", (chunk: Buffer) => {
        control += String(chunk);
        let newline: number;
        while ((newline = control.indexOf("\n")) !== -1) {
          const line = control.slice(0, newline);
          control = control.slice(newline + 1);
          try {
            const event = JSON.parse(line) as { event?: string; socket?: string; port?: number };
            if (
              event.event === "listen" &&
              event.socket === "http" &&
              typeof event.port === "number"
            )
              resolveListening(`http://127.0.0.1:${event.port}`);
          } catch (error) {
            rejectListening(error);
          }
        }
      });
      return Promise.race([
        listening,
        exited.then(() => {
          throw new Error(`Workerd exited before readiness: ${stderr}`);
        }),
      ]);
    };
    const read = (endpoint: string, path: string) => {
      const operation = fetch(`${endpoint}/${path}`, { signal: requests.signal }).then(
        async (response) => {
          if (!response.ok)
            throw new Error(`Native payload ${path} failed: ${await response.text()}\n${stderr}`);
          return response.json();
        }
      );
      ownedFetches.push(operation);
      return operation;
    };
    const initial = await start();
    const written = await read(initial, "write");
    expect(written).toMatchObject({ written: true, seq: 1 });
    expect(written.recordBytes).toBeGreaterThan(10_000_000);
    child!.kill("SIGTERM");
    await exited;
    const replacement = await start();
    expect(await read(replacement, "read")).toEqual({ reopened: true, continued: true });
  } finally {
    await cleanup();
  }
}, 30_000);
