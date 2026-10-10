import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { build } from "esbuild";
import { WebSocket, WebSocketServer } from "ws";
import { expect, it, onTestFinished } from "vitest";
import { decodeRpcJson, encodeRpcJson, type RpcEnvelope } from "@vibestudio/rpc";
import { createTestDirectAuthority } from "@vibestudio/durable/test-utils";

import { requireDevelopmentTemplateCheckout } from "../dev/developmentTemplateConfig.js";

const require = createRequire(import.meta.url);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

it("cancels and joins native alarm work through its correlated RPC owner", async () => {
  const root = await mkdtemp(join(homedir(), ".native-alarm-retirement-"));
  const provider = createServer();
  const sockets = new WebSocketServer({ server: provider });
  const accepted = deferred<void>();
  const peerClosed = deferred<void>();
  const inspectors: WebSocket[] = [];
  const exceptions: unknown[] = [];
  const contexts: unknown[] = [];
  const requests = new AbortController();
  const fetches: Promise<unknown>[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  let childClosed: Promise<void> | undefined;
  let endpoint: string | undefined;
  let stdout = "";
  let stderr = "";
  let lifecycleJoined = false;
  let cleanupFlight: Promise<void> | undefined;
  const observations: unknown[] = [];
  const stages: string[] = [];
  let stage = "setup";
  let originalAlarmSettled = true;
  let alarmCancellationAttempted = false;
  const evidenceDirectory = join(
    homedir(),
    ".cache",
    "vibestudio",
    "test-evidence",
    "native-alarm-retirement",
    basename(root)
  );
  const evidencePath = join(evidenceDirectory, "stage.json");
  let evidencePathLogged = false;

  function persistEvidence(): void {
    mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
    chmodSync(evidenceDirectory, 0o700);
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          root,
          stage,
          stages,
          lifecycleJoined,
          originalAlarmSettled,
          alarmCancellationAttempted,
          observations: observations.slice(-100),
          exceptions: exceptions.slice(-100),
          contexts: contexts.slice(-100),
          stdout,
          stderr,
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
  }

  function markStage(next: string): void {
    stage = next;
    stages.push(next);
    persistEvidence();
    if (!evidencePathLogged) {
      evidencePathLogged = true;
      console.log("Native alarm retirement evidence", evidencePath);
    }
  }

  function hostRequest(method: string, args: unknown[] = [], signal = requests.signal) {
    const promise = fetch(`http://${endpoint}/one/${method}`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        args,
        __instanceToken: "fixture",
        __instanceId: "do:fixture:Probe:one",
        __caller: {
          callerId: "main",
          callerKind: "server",
          authorization: createTestDirectAuthority({
            callerKind: "server",
            source: "fixture",
            className: "Probe",
            objectKey: "one",
            method,
          }),
        },
      }),
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    fetches.push(promise);
    return promise;
  }

  function alarmEnvelope(type: "request" | "request-cancel", requestId = crypto.randomUUID()) {
    const caller = {
      callerId: "main",
      callerKind: "server" as const,
      authorization: createTestDirectAuthority({
        callerKind: "server",
        source: "fixture",
        className: "Probe",
        objectKey: "one",
        method: "__alarm",
      }),
    };
    return {
      requestId,
      envelope: {
        from: "main",
        target: "do:fixture:Probe:one",
        delivery: { caller },
        provenance: [caller],
        message:
          type === "request"
            ? { type, requestId, fromId: "main", method: "__alarm", args: [] }
            : { type, requestId, fromId: "main" },
      } satisfies RpcEnvelope,
    };
  }

  function hostAlarmRequest(
    envelope: RpcEnvelope,
    onTerminal?: (result: { status: number; body: RpcEnvelope }) => void
  ) {
    const promise = fetch(`http://${endpoint}/one/__rpc`, {
      method: "POST",
      signal: requests.signal,
      headers: { "Content-Type": "application/json" },
      body: encodeRpcJson(envelope),
    }).then(async (response) => {
      const result = {
        status: response.status,
        body: decodeRpcJson(await response.text()) as RpcEnvelope,
      };
      onTerminal?.(result);
      return result;
    });
    fetches.push(promise);
    return promise;
  }

  const cleanup = () =>
    (cleanupFlight ??= (async () => {
      const errors: unknown[] = [];
      if (endpoint && child?.exitCode === null && child.signalCode === null && !lifecycleJoined) {
        // A failed assertion may mean the receiver is still stranded. Destroy
        // this owned target directly; teardown must not repeat a possibly stuck
        // lifecycle exchange while the primary failure is being reported.
        markStage("cleanup: destroy failed native target");
        if (!child.kill("SIGKILL")) errors.push(new Error("Workerd termination was refused"));
        await childClosed;
        requests.abort(new Error("Native alarm fixture failed and was retired"));
      }
      requests.abort(new Error("Native alarm fixture retired"));
      for (const inspector of inspectors) {
        if (inspector.readyState === WebSocket.CLOSED) continue;
        const closed = new Promise<void>((yes) => inspector.once("close", () => yes()));
        inspector.close();
        await closed;
      }
      // Explicit failed-test destruction is distinct from a successful native release.
      if (child && child.exitCode === null && child.signalCode === null && !child.kill("SIGKILL"))
        errors.push(new Error("Workerd termination was refused"));
      await childClosed;
      await Promise.allSettled(fetches);
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((yes, no) => sockets.close((error) => (error ? no(error) : yes())));
      await new Promise<void>((yes, no) => {
        provider.close((error) =>
          error && Reflect.get(error, "code") !== "ERR_SERVER_NOT_RUNNING" ? no(error) : yes()
        );
        provider.closeAllConnections();
      });
      persistEvidence();
      if (errors.length)
        throw new AggregateError(errors, "Native alarm fixture cleanup failed; scratch retained");
      await rm(root, { recursive: true, force: true });
    })());
  onTestFinished(cleanup);
  try {
    markStage("start provider");
    await new Promise<void>((yes, no) => {
      provider.once("error", no);
      provider.listen(0, "127.0.0.1", yes);
    });
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Missing provider listener");
    sockets.on("connection", (socket) => {
      socket.once("close", () => peerClosed.resolve());
      socket.once("message", (data) => {
        observations.push({ providerRequest: JSON.parse(data.toString()).type });
        accepted.resolve();
      });
    });
    provider.on("request", (_request, response) => {
      response.writeHead(404);
      response.end();
    });
    const reservation = createServer();
    await new Promise<void>((yes, no) => {
      reservation.once("error", no);
      reservation.listen(0, "127.0.0.1", yes);
    });
    const inspectorAddress = reservation.address();
    if (!inspectorAddress || typeof inspectorAddress === "string")
      throw new Error("Missing inspector listener reservation");
    const inspectorPort = inspectorAddress.port;
    await new Promise<void>((yes, no) => reservation.close((error) => (error ? no(error) : yes())));
    const base = requireDevelopmentTemplateCheckout(process.cwd(), "base");
    const source = `
      import { DurableObjectBase } from ${JSON.stringify(join(base, "packages/runtime/src/worker/durable-base.ts"))};
      import { Harness, createRegistry } from '@panticonic/pi-durable';
      import { NativeDatabase, SqliteStorage } from '@panticonic/pi-durable/storage/sqlite';
      import { BACKGROUND_CONTEXT } from '@panticonic/pi-chord/context';
      import { createModels } from '@panticonic/pi-ai';
      import { openaiCodexProvider } from '@panticonic/pi-ai/providers/openai-codex';
      import { createCredentialedModelConnection } from ${JSON.stringify(join(base, "packages/agentic-do/src/native-model-transport.ts"))};
      export class Probe extends DurableObjectBase {
        constructor(ctx,env) { super(ctx,env); this.observations=[]; this.opening=null; this.flight=null; this.terminalFlight=null; this.closed=false; this.alarmEntered=new Promise(resolve=>{this.admitAlarm=resolve;}); }
        createTables() {}
        async open() { return this.opening ??= (async()=>{
          await this.initializeSchema();
          const models=createModels(); const provider=openaiCodexProvider();
          models.setProvider({...provider,auth:{apiKey:{name:'fixture host auth',resolve:async({credential})=>({auth:{apiKey:credential.key},source:'fixture host auth'})}}});
          const storage=await SqliteStorage.open(new NativeDatabase(this.ctx.storage));
          const harness=await Harness.open(storage,{registry:createRegistry(),models,publishWake:async()=>{},modelRequests:async(request,api,context)=>createCredentialedModelConnection({model:request.model,credential:{id:'fixture',label:'fixture',accountIdentity:{providerUserId:'fixture'},audience:[{url:request.model.baseUrl,match:'path-prefix'}],injection:{type:'header',name:'authorization',valueTemplate:'Bearer {token}'},scopes:[],lifecycle:{state:'active',canRefresh:false}},rpc:{call:async()=>{throw Error('No unary transport');},stream:async()=>{throw Error('No SSE fallback');}},egressFetch:(url,init)=>fetch('http://127.0.0.1:${address.port}/upgrade',init),onDiagnostic:event=>this.observations.push(event)},context)},BACKGROUND_CONTEXT);
          const conversation=await harness.root(BACKGROUND_CONTEXT,{agent:{model:{provider:'openai-codex',modelId:'gpt-6.1-sol'},stream:{transport:'websocket',cacheRetention:'none'}}});
          await conversation.submit({type:'input',content:'fixture'},BACKGROUND_CONTEXT); return harness;
        })(); }
        async alarm() { this.alarmSignal=this.rpcAbortSignal; const harness=await this.open(); try { const pass=harness.runPass(BACKGROUND_CONTEXT); this.admitAlarm(); const schedule=await pass; return schedule.wakeAt===null?null:{wakeAt:schedule.wakeAt}; } catch(error) { this.passFailure={name:error.name,message:error.message,stack:error.stack}; throw error; } }
        async releaseForLifecycle(input) { await (await this.open()).close(BACKGROUND_CONTEXT); this.closed=true; return {status:'ready'}; }
        async fetch(request) {
          const path=new URL(request.url).pathname;
          if(path.startsWith('/one/fixture-')) await request.text();
          if(path==='/one/fixture-init') { await this.open(); return Response.json({opened:true}); }
          if(path==='/one/fixture-alarm-entered') { await this.alarmEntered; return Response.json({entered:true}); }
          if(path==='/one/fixture-alarm-aborted') { return Response.json({aborted:this.alarmSignal?.aborted===true}); }
          if(path==='/one/fixture-join') { if(this.flight) await this.flight; if(this.terminalFlight) await this.terminalFlight; return Response.json({closed:this.closed,passFailure:this.passFailure,response:this.response,observations:this.observations}); }
          if(path==='/one/__rpc') {
            const envelope=JSON.parse(await request.clone().text());
            if(envelope.message?.type==='request' && envelope.message.method==='__alarm') {
              this.flight=(async()=>{ const response=await super.fetch(request); this.terminalFlight=response.clone().text().then(body=>{this.response={status:response.status,body:JSON.parse(body)};}); return response; })();
              return await this.flight;
            }
          }
          return await super.fetch(request);
        }
      }
      export default {fetch(request,env) { return new URL(request.url).pathname==='/ready'?new Response('ready'):env.PROBE.get(env.PROBE.idFromName('one')).fetch(request); }};
    `;
    const bundled = await build({
      stdin: {
        contents: source,
        resolveDir: process.cwd(),
        sourcefile: "native-alarm-retirement-guest.ts",
      },
      bundle: true,
      platform: "browser",
      target: "es2022",
      format: "esm",
      write: false,
      conditions: ["worker", "browser"],
      external: ["node:*"],
      nodePaths: [resolve("node_modules")],
      alias: {
        "@workspace/runtime/credentials": join(base, "packages/runtime/src/shared/credentials.ts"),
      },
    });
    const module = bundled.outputFiles[0]?.text;
    if (!module) throw new Error("Missing native alarm guest bundle");
    await mkdir(join(root, "storage"));
    await writeFile(join(root, "worker.js"), module);
    await writeFile(
      join(root, "config.capnp"),
      `using Workerd = import "/workerd/workerd.capnp";
      const config :Workerd.Config = (services=[(name="main",worker=(compatibilityDate="2025-12-01",compatibilityFlags=["nodejs_compat"],globalOutbound="network",bindings=[(name="WORKER_SOURCE",text="fixture"),(name="WORKER_CLASS_NAME",text="Probe"),(name="RPC_AUTH_TOKEN",text="fixture-rpc-token"),(name="GATEWAY_URL",text=${JSON.stringify(`http://127.0.0.1:${address.port}`)}),(name="WORKSPACE_ID",text="fixture-workspace"),(name="PROBE",durableObjectNamespace="Probe")],durableObjectNamespaces=[(className="Probe",uniqueKey="native-alarm-probe",enableSql=true)],durableObjectStorage=(localDisk="storage"),modules=[(name="worker.js",esModule=embed "worker.js")])),(name="network",network=(allow=["private"])),(name="storage",disk=(path=${JSON.stringify(join(root, "storage"))},writable=true))],sockets=[(name="http",address="127.0.0.1",http=(),service="main")]);`
    );
    const listening = deferred<string>();
    child = spawn(
      require.resolve("@cloudflare/workerd-linux-64/bin/workerd"),
      [
        "serve",
        "--socket-addr=http=127.0.0.1:0",
        `--inspector-addr=127.0.0.1:${inspectorPort}`,
        "--experimental",
        "--control-fd=3",
        join(root, "config.capnp"),
      ],
      { stdio: ["ignore", "pipe", "pipe", "pipe"] }
    );
    childClosed = new Promise<void>((yes, no) => {
      child!.once("error", no);
      child!.once("close", () => yes());
    });
    child.stdout!.on("data", (chunk) => {
      stdout = (stdout + String(chunk)).slice(-32768);
    });
    child.stderr!.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-32768);
    });
    let control = "";
    child.stdio[3]!.on("data", (chunk: Buffer) => {
      control += String(chunk);
      let at: number;
      while ((at = control.indexOf("\n")) !== -1) {
        const event = JSON.parse(control.slice(0, at));
        control = control.slice(at + 1);
        if (event.event === "listen" && event.socket === "http")
          listening.resolve(`127.0.0.1:${event.port}`);
      }
    });
    endpoint = await Promise.race([
      listening.promise,
      childClosed.then(() => {
        throw Error(`Workerd exited before readiness: ${stderr}`);
      }),
    ]);
    markStage("initialize fixture");
    expect(await hostRequest("fixture-init")).toEqual({ status: 200, body: { opened: true } });
    const targets = (await (
      await fetch(`http://127.0.0.1:${inspectorPort}/json/list`, { signal: requests.signal })
    ).json()) as { webSocketDebuggerUrl: string }[];
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      inspectors.push(socket);
      const enabled = deferred<void>();
      socket.on("message", (raw) => {
        const event = JSON.parse(raw.toString());
        if (
          event.method === "Runtime.exceptionThrown" ||
          event.method === "Runtime.exceptionRevoked"
        )
          exceptions.push(event);
        if (event.method === "Runtime.executionContextCreated") contexts.push(event.params);
        if (event.id === 1) enabled.resolve();
      });
      await new Promise<void>((yes, no) => {
        socket.once("open", yes);
        socket.once("error", no);
      });
      socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
      await enabled.promise;
    }
    const alarm = alarmEnvelope("request");
    if (alarm.envelope.message.type !== "request")
      throw new Error("Fixture alarm envelope is not a request");
    originalAlarmSettled = false;
    markStage("send canonical alarm request");
    const original = hostAlarmRequest(alarm.envelope, (terminal) => {
      originalAlarmSettled = true;
      observations.push({ originalTerminal: terminal });
      persistEvidence();
    }).catch((error) => {
      originalAlarmSettled = true;
      observations.push({ originalFailure: String(error) });
      persistEvidence();
      throw error;
    });
    const observedOriginal = original.then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    async function beforeOriginalTerminal<T>(label: string, pending: Promise<T>): Promise<T> {
      const outcome = await Promise.race([
        pending.then((value) => ({ kind: "value" as const, value })),
        observedOriginal.then((terminal) => ({ kind: "terminal" as const, terminal })),
      ]);
      if (outcome.kind === "terminal") {
        throw new Error(`Original alarm request completed before ${label}`, {
          cause: outcome.terminal,
        });
      }
      return outcome.value;
    }
    expect(
      await beforeOriginalTerminal("alarm entry", hostRequest("fixture-alarm-entered"))
    ).toEqual({
      status: 200,
      body: { entered: true },
    });
    markStage("wait for provider request acceptance");
    await beforeOriginalTerminal(
      "provider request acceptance",
      Promise.race([
        accepted.promise,
        childClosed.then(() => {
          throw Error(`Workerd exited before native request: ${stderr}`);
        }),
      ])
    );
    markStage("deliver canonical alarm cancellation");
    const cancellation = alarmEnvelope("request-cancel", alarm.requestId);
    alarmCancellationAttempted = true;
    expect(await hostAlarmRequest(cancellation.envelope)).toMatchObject({ status: 200 });
    expect(originalAlarmSettled).toBe(false);
    markStage("observe alarm signal");
    expect(await hostRequest("fixture-alarm-aborted")).toEqual({
      status: 200,
      body: { aborted: true },
    });
    markStage("prepare lifecycle while original alarm remains owned");
    const release = await hostRequest("__lifecycle/prepare", [
      {
        epoch: "retirement-test",
        phase: "quiesce",
        mode: "suspend",
        reason: "shutdown",
        deadlineMs: 0,
      },
    ]);
    expect(release).toMatchObject({
      status: 200,
      body: {
        value: { status: "ready" },
        metadata: { durableWorkReady: [] },
      },
    });
    lifecycleJoined = true;
    markStage("join original terminal response");
    const terminal = await observedOriginal;
    expect(terminal).toHaveProperty("value.status", 200);
    expect(terminal).toHaveProperty("value.body.message.type", "response");
    expect(terminal).toHaveProperty("value.body.message.error", "Harness is closed");
    markStage("join native peer close");
    await peerClosed.promise;
    const joined = await hostRequest("fixture-join");
    observations.push(joined);
    expect(joined).toMatchObject({ status: 200, body: { closed: true } });
    // The provider barrier, correlated cancellation, and lifecycle release
    // prove shutdown joined live work rather than detaching the alarm request.
    expect(joined.body.response).toBeDefined();
    expect(joined.body.response.status).toBe(200);
    expect(joined.body.response.body.message.type).toBe("response");
    expect(joined.body.passFailure).toMatchObject({
      message: "Harness is closed",
    });
    expect(joined.body.response.body.message).toMatchObject({
      error: "Harness is closed",
    });
    // Later host-control calls use the same canonical response envelope and
    // preserve the Harness's terminal failure.
    const afterClose = alarmEnvelope("request");
    expect(await hostAlarmRequest(afterClose.envelope)).toMatchObject({
      status: 200,
      body: {
        message: { type: "response", error: "Harness is closed" },
      },
    });
    expect(joined.body.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ milestone: "upgrade_accepted" }),
        expect.objectContaining({ milestone: "send_completed" }),
        expect.objectContaining({ milestone: "close_observed" }),
      ])
    );
    expect(
      exceptions.filter((event) => JSON.stringify(event).includes("Harness is closed"))
    ).toEqual([]);
    expect(exceptions).toEqual([]);
    expect(stderr).not.toMatch(/Uncaught exception:/);
    markStage("completed successfully");
  } finally {
    await cleanup();
  }
}, 30_000);
