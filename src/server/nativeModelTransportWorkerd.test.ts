import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { WebSocketServer } from "ws";
import { expect, it, onTestFinished } from "vitest";

import { requireDevelopmentTemplateCheckout } from "../dev/developmentTemplateConfig.js";

const require = createRequire(import.meta.url);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

it.each(["complete", "cancel"] as const)(
  "joins actual protected model WebSocket in native SQLite DO: %s",
  async (mode) => {
    const root = await mkdtemp(join(homedir(), ".native-model-ws-"));
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    const sent = deferred<void>();
    const peerClosed = deferred<void>();
    let requestType: unknown;
    let child: ReturnType<typeof spawn> | undefined;
    let exited: Promise<void> | undefined;
    let stderr = "";
    let stdout = "";
    const observations: unknown[] = [];
    const ownedFetches: Promise<unknown>[] = [];
    const requests = new AbortController();
    let cleaning: Promise<void> | undefined;
    let endpoint: string | undefined;
    const cleanupStages: string[] = [];
    const cleanup = () =>
      (cleaning ??= (async () => {
        if (endpoint && child?.exitCode === null && child.signalCode === null) {
          const inspection = fetch(`http://${endpoint}/inspect`).then((response) =>
            response.json()
          );
          ownedFetches.push(inspection);
          console.log("Native Workerd retained phase", mode, await inspection);
          const cancel = fetch(`http://${endpoint}/cancel`).then((response) => response.json());
          ownedFetches.push(cancel);
          console.log("Native Workerd close joined", mode, await cancel);
        }
        cleanupStages.push("native_close_joined");
        requests.abort(new Error("Native WebSocket fixture retired"));
        for (const socket of sockets.clients) socket.terminate();
        server.closeAllConnections();
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await exited;
        cleanupStages.push("workerd_exited");
        await Promise.allSettled(ownedFetches);
        cleanupStages.push("http_joined");
        await new Promise<void>((yes) => sockets.close(() => yes()));
        cleanupStages.push("provider_sockets_joined");
        await new Promise<void>((yes) => {
          server.close(() => yes());
          server.closeAllConnections();
        });
        cleanupStages.push("provider_listener_joined");
        console.log("Native Workerd probe cleanup", mode, {
          observations,
          stderr,
          stdout,
          cleanupStages,
        });
        await rm(root, { recursive: true, force: true });
      })());
    onTestFinished(cleanup);
    try {
      await new Promise<void>((yes, no) => {
        server.once("error", no);
        server.listen(0, "127.0.0.1", yes);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing provider address");
      sockets.on("connection", (socket) => {
        socket.once("close", () => peerClosed.resolve());
        socket.once("message", (data) => {
          requestType = (JSON.parse(data.toString()) as { type: unknown }).type;
          console.log("Native Workerd provider received", mode, { requestType });
          sent.resolve();
          if (mode === "complete") {
            const item = {
              type: "message",
              id: "fixture-message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Fixture answer.", annotations: [] }],
            };
            for (const event of [
              {
                type: "response.created",
                response: { id: "fixture-response", status: "in_progress" },
              },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...item, status: "in_progress", content: [] },
              },
              {
                type: "response.output_text.delta",
                output_index: 0,
                content_index: 0,
                delta: "Fixture answer.",
              },
              { type: "response.output_item.done", output_index: 0, item },
              {
                type: "response.completed",
                response: {
                  id: "fixture-response",
                  status: "completed",
                  output: [item],
                  usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
                },
              },
            ])
              socket.send(JSON.stringify(event));
            console.log("Native Workerd provider completion sent", { events: 5 });
          }
        });
      });
      server.on("request", (_req, res) => {
        res.statusCode = 404;
        res.end("not a websocket upgrade");
      });
      const templateBase = requireDevelopmentTemplateCheckout(process.cwd(), "base");
      const transportPath = join(templateBase, "packages/agentic-do/src/native-model-transport.ts");
      const source = `
      import { Harness, createRegistry } from '@panticonic/pi-durable';
      import { NativeDatabase, SqliteStorage } from '@panticonic/pi-durable/storage/sqlite';
      import { BACKGROUND_CONTEXT } from '@panticonic/pi-chord/context';
      import { createModels } from '@panticonic/pi-ai';
      import { openaiCodexProvider } from '@panticonic/pi-ai/providers/openai-codex';
      import { createCredentialedModelConnection } from ${JSON.stringify(transportPath)};
      const providerRoot = 'http://127.0.0.1:${address.port}';
      export class Probe {
        constructor(ctx) { this.ctx = ctx; this.opening = null; this.diagnostics = []; this.submission = null; }
        async harness() {
          return this.opening ??= (async () => {
            const models = createModels();
            const provider = openaiCodexProvider();
            // Only the host protected credential boundary differs; retain the installed native API/model descriptors.
            models.setProvider({ ...provider, auth: { apiKey: { name: 'fixture host auth', resolve: async ({credential}) => ({auth:{apiKey:credential.key}, source:'fixture host auth'}) } } });
            const storage = await SqliteStorage.open(new NativeDatabase(this.ctx.storage));
            return Harness.open(storage, { models, registry: createRegistry(), publishWake: async () => {}, modelRequests: async (request, api, context) => {
              return createCredentialedModelConnection({ model: request.model, credential: { id: 'fixture-credential', label: 'fixture', accountIdentity: {providerUserId:'fixture-account'}, audience:[{url:request.model.baseUrl,match:'path-prefix'}], injection:{type:'header',name:'authorization',valueTemplate:'Bearer {token}'}, scopes:[], lifecycle:{state:'active',canRefresh:false} }, rpc:{call:async()=>{throw new Error('No unary transport');}, stream:async()=>{throw new Error('No SSE fallback expected');}}, egressFetch: (url, init) => fetch(providerRoot + '/upgrade', init), onDiagnostic: (event) => { this.diagnostics.push(event); console.info("[NativeProbeTransport] " + JSON.stringify(event)); } }, context);
            } }, BACKGROUND_CONTEXT);
          })();
        }
        async fetch(request) {
          if (new URL(request.url).pathname === '/inspect') {
            if (!this.opening) return Response.json({admitted:false});
            const harness = await this.opening;
            if (this.closed) return Response.json({closed:true,diagnostics:this.diagnostics});
            const current = await harness.inspect(BACKGROUND_CONTEXT);
            return Response.json({scheduling:current.scheduling, tasks:current.tasks.map(({record,state})=>({id:record.id,name:record.name,status:record.status,phase:record.checkpoint?.phase,state:state.kind})), submissions:current.submissions.map((s)=>({id:s.id,status:s.status})), diagnostics:this.diagnostics});
          }
          const harness = await this.harness();
          if (new URL(request.url).pathname === '/cancel') { await harness.close(BACKGROUND_CONTEXT); this.closed=true; return Response.json({closed:true}); }
          const conversation = await harness.root(BACKGROUND_CONTEXT, { agent:{model:{provider:'openai-codex',modelId:'gpt-6.1-sol'},stream:{transport:'websocket',cacheRetention:'none'}} });
          const submission = await conversation.submit({type:'input',content:'fixture'}, BACKGROUND_CONTEXT);
          try {
            const result = await submission.wait(BACKGROUND_CONTEXT);
            await harness.close(BACKGROUND_CONTEXT); this.closed=true;
            return Response.json({status:result.status,result,diagnostics:this.diagnostics});
          } catch (error) { return Response.json({error:error.message}); }
        }
      }
      export default { fetch(request, env) { return new URL(request.url).pathname === '/ready' ? new Response('ready') : env.PROBE.get(env.PROBE.idFromName('one')).fetch(request); } };
    `;
      const bundled = await build({
        stdin: { contents: source, resolveDir: process.cwd(), sourcefile: "native-model-probe.ts" },
        bundle: true,
        platform: "browser",
        target: "es2022",
        format: "esm",
        write: false,
        conditions: ["worker", "browser"],
        external: ["node:*"],
        alias: {
          "@workspace/runtime/credentials": join(
            templateBase,
            "packages/runtime/src/shared/credentials.ts"
          ),
        },
        nodePaths: [resolve("node_modules")],
      });
      const module = bundled.outputFiles[0]?.text;
      if (!module) throw new Error("No native transport fixture bundle");
      await mkdir(join(root, "storage"));
      // Workerd advertises the selected listener address; no readiness polling or guessed port.
      await writeFile(join(root, "worker.js"), module);
      await writeFile(
        join(root, "config.capnp"),
        `using Workerd = import "/workerd/workerd.capnp";
      const config :Workerd.Config = (
        services = [(name="main",worker=(compatibilityDate="2025-12-01",compatibilityFlags=["nodejs_compat"],globalOutbound="network",bindings=[(name="PROBE",durableObjectNamespace="Probe")],durableObjectNamespaces=[(className="Probe",uniqueKey="native-model-probe",enableSql=true)],durableObjectStorage=(localDisk="storage"),modules=[(name="worker.js",esModule=embed "worker.js")])),(name="network",network=(allow=["private"])),(name="storage",disk=(path=${JSON.stringify(join(root, "storage"))},writable=true))],
        sockets=[(name="http",address="127.0.0.1",http=(),service="main")]);`
      );
      const listening = deferred<string>();
      child = spawn(
        require.resolve("@cloudflare/workerd-linux-64/bin/workerd"),
        [
          "serve",
          "--socket-addr=http=127.0.0.1:0",
          "--experimental",
          "--verbose",
          "--control-fd=3",
          join(root, "config.capnp"),
        ],
        { stdio: ["ignore", "pipe", "pipe", "pipe"] }
      );
      exited = new Promise<void>((yes) => child!.once("close", yes));
      child.stdout!.on("data", (chunk) => {
        stdout = (stdout + String(chunk)).slice(-32768);
      });
      child.stderr!.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-32768);
        for (const line of String(chunk).split("\n")) {
          const at = line.indexOf("[NativeProbeTransport] ");
          if (at !== -1) {
            const event = JSON.parse(line.slice(at + "[NativeProbeTransport] ".length));
            observations.push(event);
            console.log("Native Workerd probe", mode, event);
          }
        }
      });
      let control = "";
      child.stdio[3]!.on("data", (chunk: Buffer) => {
        control += String(chunk);
        let newline: number;
        while ((newline = control.indexOf("\n")) !== -1) {
          const line = control.slice(0, newline);
          control = control.slice(newline + 1);
          const event = JSON.parse(line) as { event?: string; socket?: string; port?: number };
          if (event.event === "listen" && event.socket === "http" && typeof event.port === "number")
            listening.resolve(`127.0.0.1:${event.port}`);
        }
      });
      endpoint = await Promise.race([
        listening.promise,
        exited.then(() => {
          throw new Error(`Workerd exited before readiness: ${stderr}\n${stdout}`);
        }),
      ]);
      const original = fetch(`http://${endpoint}/run`, { signal: requests.signal }).then(
        (response) => response.json()
      );
      ownedFetches.push(original);
      await sent.promise;
      expect(requestType).toBe("response.create");
      if (mode === "cancel") {
        const cancelling = fetch(`http://${endpoint}/cancel`, { signal: requests.signal }).then(
          (response) => response.json()
        );
        ownedFetches.push(cancelling);
        expect(await cancelling).toEqual({ closed: true });
        expect(await original).toHaveProperty("error");
      } else {
        const result = await original;
        console.log("Native Workerd original submission", result);
        expect(result).toHaveProperty("status", "done");
      }
      const retained = await (
        await fetch(`http://${endpoint}/inspect`, { signal: requests.signal })
      ).json();
      observations.push(...retained.diagnostics);
      await peerClosed.promise;
      if (mode === "complete") {
        expect(observations).toContainEqual({
          milestone: "provider_terminal",
          providerEvent: "response.completed",
          providerEvents: 5,
        });
        expect(
          observations.some(
            (event) =>
              typeof event === "object" &&
              event !== null &&
              Reflect.get(event, "milestone") === "socket_error"
          )
        ).toBe(false);
      }
      // Durable close cannot return while the actual accepted socket is retained.
      expect(observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ milestone: "upgrade_accepted" }),
          expect.objectContaining({ milestone: "send_completed" }),
          expect.objectContaining({ milestone: "close_observed" }),
        ])
      );
    } finally {
      await cleanup();
    }
  },
  30_000
);
