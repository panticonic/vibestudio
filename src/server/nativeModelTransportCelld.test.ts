import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { WebSocketServer } from "ws";
import { expect, it, onTestFinished } from "vitest";

import {
  celldTestBinary,
  startCelldProbe,
  type CelldProbe,
} from "../../tests/helpers/celldNodeHarness.js";
import { requireDevelopmentTemplateCheckout } from "../dev/developmentTemplateConfig.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

it.skipIf(!celldTestBinary()).each(["complete", "cancel"] as const)(
  "joins actual protected model WebSocket in native SQLite DO on celld: %s",
  async (mode) => {
    const root = await mkdtemp(join(homedir(), ".native-model-ws-"));
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    const sent = deferred<void>();
    const peerClosed = deferred<void>();
    let requestType: unknown;
    let probe: CelldProbe | undefined;
    let output = "";
    const observations: unknown[] = [];
    const ownedFetches: Promise<unknown>[] = [];
    const requests = new AbortController();
    let cleaning: Promise<void> | undefined;
    let endpoint: string | undefined;
    const cleanupStages: string[] = [];
    const cleanup = () =>
      (cleaning ??= (async () => {
        try {
          requests.abort(new Error("Native WebSocket fixture retired"));
          for (const socket of sockets.clients) socket.terminate();
          server.closeAllConnections();
          await probe?.kill();
          cleanupStages.push("node_exited");
          await Promise.allSettled(ownedFetches);
          cleanupStages.push("http_joined");
          await new Promise<void>((yes) => sockets.close(() => yes()));
          cleanupStages.push("provider_sockets_joined");
          await new Promise<void>((yes) => {
            server.close(() => yes());
            server.closeAllConnections();
          });
          cleanupStages.push("provider_listener_joined");
          if (process.env["VIBESTUDIO_TEST_VERBOSE"])
            console.log("Native celld probe cleanup", mode, {
              observations,
              output,
              cleanupStages,
            });
        } finally {
          await rm(root, { recursive: true, force: true });
        }
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
          sent.resolve();
          if (mode === "complete") {
            const item = {
              type: "message",
              id: "fixture-message",
              role: "assistant",
              phase: "final_answer",
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
      import { createNativeModelScopeRpc } from ${JSON.stringify(resolve("tests/helpers/nativeModelScopeRpc.ts"))};
      import { Harness, createRegistry } from '@panticonic/pi-durable';
      import { applySqliteMigrations, NativeDatabase, SqliteStorage } from '@panticonic/pi-durable/storage/sqlite';
      import { BACKGROUND_CONTEXT } from '@panticonic/pi-chord/context';
      import { createModels } from '@panticonic/pi-ai';
      import { openaiCodexProvider } from '@panticonic/pi-ai/providers/openai-codex';
      import { createCredentialedModelConnection } from ${JSON.stringify(transportPath)};
      const providerRoot = 'http://127.0.0.1:${address.port}';
      export class Probe {
        constructor(ctx) { this.scopeHost = createNativeModelScopeRpc(); this.ctx = ctx; this.opening = null; this.diagnostics = []; this.submission = null; }
        async harness() {
          return this.opening ??= (async () => {
            const models = createModels();
            const provider = openaiCodexProvider();
            // Only the host protected credential boundary differs; retain the installed native API/model descriptors.
            models.setProvider({ ...provider, auth: { apiKey: { name: 'fixture host auth', resolve: async ({credential}) => ({auth:{apiKey:credential.key}, source:'fixture host auth'}) } } });
            const database = new NativeDatabase(this.ctx.storage); await applySqliteMigrations(database); const storage = await SqliteStorage.open(database);
            return Harness.open(storage, { models, registry: createRegistry(), publishWake: async () => {}, modelRequests: async (request, api, context) => {
              return createCredentialedModelConnection({ model: request.model, credential: { id: 'fixture-credential', label: 'fixture', accountIdentity: {providerUserId:'fixture-account'}, audience:[{url:request.model.baseUrl,match:'path-prefix'}], injection:{type:'header',name:'authorization',valueTemplate:'Bearer {token}'}, scopes:[], lifecycle:{state:'active',canRefresh:false} }, rpc:{call:async()=>{throw new Error('No unary transport');}, stream:async()=>{throw new Error('No SSE fallback expected');}}, cleanupRpc:this.scopeHost.rpc, egressFetch: (url, init) => fetch(providerRoot + '/upgrade', init), onDiagnostic: (event) => { this.diagnostics.push(event); } }, context);
            } }, BACKGROUND_CONTEXT);
          })();
        }
        async fetch(request) {
          if (new URL(request.url).pathname === '/inspect') {
            if (!this.opening) return Response.json({admitted:false});
            const harness = await this.opening;
            if (this.closed) return Response.json({closed:true,diagnostics:this.diagnostics,scopes:this.scopeHost.inspect()});
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
      probe = await startCelldProbe({
        root,
        bundle: module,
        classes: ["Probe"],
        onOutput: (_stream, line) => {
          output = (output + line + "\n").slice(-32768);
        },
      });
      await probe.start();
      endpoint = probe.endpoint.replace("http://", "");
      const original = fetch(`http://${endpoint}/run`, { signal: requests.signal }).then(
        (response) => response.json()
      );
      ownedFetches.push(original);
      await Promise.race([
        sent.promise,
        original.then((result) => {
          throw new Error("Native model submission settled before provider admission", {
            cause: result,
          });
        }),
      ]);
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
        expect(result).toHaveProperty("status", "done");
      }
      const retained = await (
        await fetch(`http://${endpoint}/inspect`, { signal: requests.signal })
      ).json();
      expect(retained.scopes.open).toEqual([]);
      expect(retained.scopes.closed).toHaveLength(1);
      observations.push(...retained.diagnostics);
      await peerClosed.promise;
      if (mode === "complete") {
        expect(observations).toContainEqual(
          expect.objectContaining({
            milestone: "provider_terminal",
            providerEvent: "response.completed",
            providerEvents: 5,
            providerOutput: expect.objectContaining({
              messages: 1,
              textCharacters: 15,
              toolCalls: 0,
            }),
            providerText: expect.objectContaining({ characters: 15, deltas: 1 }),
          })
        );
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
