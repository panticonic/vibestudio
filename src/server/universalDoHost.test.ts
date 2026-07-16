/**
 * Integration test for the Phase 2b UniversalDO facet host — exercises the REAL
 * workerd binary end-to-end:
 *   - a userland DO class loads dynamically into the static `universal-do`
 *     service as a durable facet (no per-class service, no workerd restart),
 *   - dispatch reaches it via `/_u/{packedKey}/{method}`,
 *   - per-facet SQLite storage persists across calls,
 *   - a NEW userland DO class needs no restart (boot generation unchanged),
 *   - distinct object keys get isolated facet storage.
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { TokenManager } from "../../packages/shared/src/tokenManager.js";
import { WorkerdManager, type WorkerdManagerDeps } from "./workerdManager.js";
import { encodeUniversalKey } from "./doDispatch.js";
import type { BuildResult } from "./buildV2/buildStore.js";
import { executionArtifactFixture } from "./testing/executionArtifactFixture.js";
import {
  buildWorkerdPrograms,
  type WorkerdProgramSources,
} from "../../scripts/build-workerd-programs.mjs";

let compiledWorkerdPrograms: WorkerdProgramSources;

beforeAll(async () => {
  compiledWorkerdPrograms = await buildWorkerdPrograms({ write: false });
});

const COUNTER_DO = `import { DurableObject } from "cloudflare:workers";
export class CounterDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx; this.env = env;
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS c (n INTEGER)");
  }
  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const userKey = parts[0] ? decodeURIComponent(parts[0]) : "";
    const method = parts.slice(1).join("/") || "get";
    if (request.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (method === "incr") {
      this.ctx.storage.sql.exec("INSERT INTO c (n) VALUES (1)");
    }
    if (method === "egress") {
      const response = await fetch("https://example.com/probe", {
        headers: { "X-Vibestudio-Egress-Caller": "FORGED" },
      });
      return new Response(JSON.stringify({ result: await response.json() }), {
        headers: { "content-type": "application/json" },
      });
    }
    const total = [...this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM c").raw()][0][0];
    return new Response(JSON.stringify({ result: {
      count: total, source: this.env.WORKER_SOURCE, cls: this.env.WORKER_CLASS_NAME, key: userKey,
    }}), { headers: { "content-type": "application/json" } });
  }
  async webSocketMessage(ws, msg) {
    this.ctx.storage.sql.exec("INSERT INTO c (n) VALUES (1)");
    ws.send("echo:" + msg + ":" + this.env.WORKER_CLASS_NAME);
  }
}
export default { fetch() { return new Response("counter host"); } };`;

function doBuild(source: string, ev: string, bundle = COUNTER_DO): BuildResult {
  return {
    dir: "/tmp/test-build",
    sourceStateHash: "state:test",
    metadata: {
      kind: "worker",
      name: source,
      sourceDigest: ev,
      sourceStateHash: "state:test",
      sourcemap: false,
      details: { kind: "generic" },
      builtAt: "2026-01-01T00:00:00.000Z",
    },
    artifacts: [
      {
        path: "worker.js",
        role: "primary",
        contentType: "text/javascript; charset=utf-8",
        encoding: "utf8",
        content: bundle,
      },
    ],
  };
}

interface Harness {
  manager: WorkerdManager;
  gateway: Server;
  egress: Server;
  egressCallers: string[];
  statePath: string;
  dispatch: (
    ref: { source: string; className: string; objectKey: string },
    method: string
  ) => Promise<unknown>;
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
}

async function createHarness(builds: Record<string, BuildResult>): Promise<Harness> {
  const tokenManager = new TokenManager();
  // Construct the manager first (its getServerUrl reads the port lazily via the
  // holder) so the gateway closure below can reference a `const` manager.
  const portHolder = { value: 0 };
  const executionBundles = new Map<string, ReturnType<typeof executionArtifactFixture>["bundle"]>();
  const egressCallers: string[] = [];
  const egress = createServer((req, res) => {
    const caller = String(req.headers["x-vibestudio-egress-caller"] ?? "");
    egressCallers.push(caller);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ caller }));
  });
  const egressPort = await listen(egress);

  const statePath = mkdtempSync(join(tmpdir(), "vibestudio-udo-state-"));
  const deps: WorkerdManagerDeps = {
    hostPrincipal: "host:test-product-build",
    tokenManager,
    fsService: { closeHandlesForCaller: () => {} } as unknown as WorkerdManagerDeps["fsService"],
    getServerUrl: () => `http://127.0.0.1:${portHolder.value}`,
    resolveExecutionArtifact: async (source: string, ref?: string) => {
      const b = builds[source];
      if (!b) throw new Error(`no build for ${source}`);
      const fixture = executionArtifactFixture(source, b, ref);
      executionBundles.set(fixture.binding.artifact.executionDigest, fixture.bundle);
      return fixture.binding;
    },
    getExecutionArtifact: (executionDigest) => executionBundles.get(executionDigest) ?? null,
    workerdPrograms: compiledWorkerdPrograms,
    workspacePath: mkdtempSync(join(tmpdir(), "vibestudio-udo-ws-")),
    statePath,
    getProxyPort: () => 1,
    getSharedEgressPort: () => Promise.resolve(egressPort),
    registerEgressCaller: () => {},
    unregisterEgressCaller: () => {},
    egressSecret: "universal-do-host-egress-secret",
    getWorkerdGatewayToken: () => "udo-gateway-token",
    workerdStartupReadyTimeoutMs: 15_000,
  };
  const manager = new WorkerdManager(deps);

  const gateway = createServer((req, res) => {
    const url = req.url ?? "";
    const secret = req.headers["x-vibestudio-loader-secret"];
    if (url.startsWith("/_doversion/") || url.startsWith("/_docode/")) {
      if (secret !== manager.getLoaderSecret()) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      const isVersion = url.startsWith("/_doversion/");
      const objectKey = new URL(url, "http://gateway").searchParams.get("objectKey") ?? undefined;
      const segs = (
        url.slice((isVersion ? "/_doversion/" : "/_docode/").length).split("?")[0] ?? ""
      ).split("/");
      const source = decodeURIComponent(segs[0] ?? "");
      const className = decodeURIComponent(segs[1] ?? "");
      if (isVersion) {
        const v = manager.getDoVersion(source, className, objectKey);
        if (v === null) {
          res.writeHead(404);
          res.end("nf");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ version: v }));
        return;
      }
      void manager.getDoCode(source, className, objectKey).then((code) => {
        if (!code) {
          res.writeHead(404);
          res.end("nf");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(code));
      });
      return;
    }
    res.writeHead(404);
    res.end("nf");
  });
  portHolder.value = await listen(gateway);

  const dispatch = async (
    ref: { source: string; className: string; objectKey: string },
    method: string
  ): Promise<unknown> => {
    const port = manager.getPort();
    if (!port) throw new Error("workerd not running");
    const key = encodeUniversalKey(ref);
    const res = await fetch(`http://127.0.0.1:${port}/_u/${encodeURIComponent(key)}/${method}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer udo-gateway-token",
        "X-Vibestudio-Dispatch-Secret": manager.getDispatchSecret(),
        "Content-Type": "application/json",
      },
      body: "[]",
    });
    if (!res.ok) throw new Error(`dispatch failed ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { result: unknown }).result;
  };

  return { manager, gateway, egress, egressCallers, statePath, dispatch };
}

let active: Harness | null = null;
afterEach(async () => {
  if (active) {
    await active.manager.shutdown();
    await new Promise<void>((r) => active!.gateway.close(() => r()));
    await new Promise<void>((r) => active!.egress.close(() => r()));
    active = null;
  }
});

async function launchDurableObject(
  manager: WorkerdManager,
  input: { source: string; className: string; key: string; contextId: string }
): Promise<void> {
  const execution = await manager.resolveExecution(input.source);
  await manager.ensureDurableObjectEntity({ ...input, execution });
}

describe("UniversalDO facet host (real workerd)", () => {
  it("stamps outbound requests with the exact logical DO identity", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch, egressCallers } = active;
    const ref = { source: "workers/counter", className: "CounterDO", objectKey: "agent-1" };
    await launchDurableObject(manager, {
      source: ref.source,
      className: ref.className,
      key: ref.objectKey,
      contextId: "ctx-agent",
    });

    await expect(dispatch(ref, "egress")).resolves.toEqual({
      caller: "do:workers/counter:CounterDO:agent-1",
    });
    expect(egressCallers).toEqual(["do:workers/counter:CounterDO:agent-1"]);
  });

  it("loads a userland DO as a facet and persists per-key storage with no restart", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch } = active;

    // Registering the first exact runtime object brings workerd up once.
    await launchDurableObject(manager, {
      source: "workers/counter",
      className: "CounterDO",
      key: "k1",
      contextId: "ctx-1",
    });
    const boot = manager.getBootGeneration();

    const ref1 = { source: "workers/counter", className: "CounterDO", objectKey: "k1" };
    expect(await dispatch(ref1, "incr")).toEqual({
      count: 1,
      source: "workers/counter",
      cls: "CounterDO",
      key: "k1",
    });
    expect(await dispatch(ref1, "incr")).toMatchObject({ count: 2 });

    // A different object key is an isolated facet (its own storage).
    const ref2 = { source: "workers/counter", className: "CounterDO", objectKey: "k2" };
    await launchDurableObject(manager, {
      source: ref2.source,
      className: ref2.className,
      key: ref2.objectKey,
      contextId: "ctx-2",
    });
    expect(await dispatch(ref2, "incr")).toMatchObject({ count: 1, key: "k2" });
    expect(await dispatch(ref1, "get")).toMatchObject({ count: 2 });

    // Registering the class never restarted workerd.
    expect(manager.getBootGeneration()).toBe(boot);
  }, 30_000);

  it("clones facet storage to a new key (channel fork), independent, no restart", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, statePath, dispatch } = active;

    const src = { source: "workers/counter", className: "CounterDO", objectKey: "orig" };
    await launchDurableObject(manager, {
      source: src.source,
      className: src.className,
      key: src.objectKey,
      contextId: "ctx-source",
    });
    await dispatch(src, "incr");
    await dispatch(src, "incr");
    expect(await dispatch(src, "get")).toMatchObject({ count: 2 });

    const boot = manager.getBootGeneration();
    const cloned = await manager.cloneDO(src, "fork");
    await launchDurableObject(manager, {
      source: cloned.source,
      className: cloned.className,
      key: cloned.objectKey,
      contextId: "ctx-fork",
    });
    expect(cloned.objectKey).toBe("fork");
    expect(manager.getBootGeneration()).toBe(boot); // clone never restarts

    // The fork starts with the parent's state…
    expect(await dispatch(cloned, "get")).toMatchObject({ count: 2, key: "fork" });
    // …and is independent: mutating the fork does not affect the original.
    await dispatch(cloned, "incr");
    expect(await dispatch(cloned, "get")).toMatchObject({ count: 3 });
    expect(await dispatch(src, "get")).toMatchObject({ count: 2 });

    // Destruction is logical immediately, but physical storage stays intact
    // until workerd releases its SQLite handles at a process boundary.
    await manager.destroyDO(cloned);
    expect(await dispatch(cloned, "get")).toMatchObject({ count: 3 });
    const pendingDeletes = join(statePath, "pending-do-storage-deletes.json");
    expect(existsSync(pendingDeletes)).toBe(true);
    await manager.shutdown();
    expect(existsSync(pendingDeletes)).toBe(false);
  }, 30_000);

  it("forwards a WebSocket upgrade through the facet host (hibernation)", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager } = active;

    const ref = { source: "workers/counter", className: "CounterDO", objectKey: "ws-1" };
    await launchDurableObject(manager, {
      source: ref.source,
      className: ref.className,
      key: ref.objectKey,
      contextId: "ctx-ws",
    });
    const port = manager.getPort()!;
    const { default: WebSocket } = await import("ws");
    const key = encodeUniversalKey(ref);

    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/_u/${encodeURIComponent(key)}`, {
        headers: {
          Authorization: "Bearer udo-gateway-token",
          "X-Vibestudio-Dispatch-Secret": manager.getDispatchSecret(),
        },
      });
      const timer = setTimeout(() => reject(new Error("WS timeout")), 8_000);
      ws.on("open", () => ws.send("ping"));
      ws.on("message", (d: Buffer) => {
        clearTimeout(timer);
        ws.close();
        resolve(d.toString());
      });
      ws.on("error", (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    // The hibernation handler fired inside the facet and echoed.
    expect(reply).toBe("echo:ping:CounterDO");
  }, 30_000);

  it("loads a userland DO that imports a wasm module (e.g. terminal yoga.wasm)", async () => {
    // Minimal valid wasm module (8-byte header) — instantiates to an empty module.
    const WASM_B64 = "AGFzbQEAAAA=";
    const WASM_DO = `import wasmMod from "extra.wasm";
import { DurableObject } from "cloudflare:workers";
export class WasmDO extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.env = env; }
  async fetch() {
    return new Response(JSON.stringify({ result: {
      wasmLoaded: wasmMod instanceof WebAssembly.Module, cls: this.env.WORKER_CLASS_NAME,
    }}), { headers: { "content-type": "application/json" } });
  }
}
export default { fetch() { return new Response("h"); } };`;
    const build = doBuild("workers/wasm", "ev-1", WASM_DO);
    build.artifacts.push({
      path: "extra.wasm",
      role: "wasm",
      contentType: "application/wasm",
      encoding: "base64",
      content: WASM_B64,
    });

    active = await createHarness({ "workers/wasm": build });
    const { manager, dispatch } = active;
    await launchDurableObject(manager, {
      source: "workers/wasm",
      className: "WasmDO",
      key: "w1",
      contextId: "ctx-wasm",
    });

    const res = await dispatch(
      { source: "workers/wasm", className: "WasmDO", objectKey: "w1" },
      "get"
    );
    expect(res).toEqual({ wasmLoaded: true, cls: "WasmDO" });
  }, 30_000);

  it("registers a brand-new DO class with no restart", async () => {
    active = await createHarness({
      "workers/counter": doBuild("workers/counter", "ev-1"),
      "workers/other": doBuild("workers/other", "ev-1"),
    });
    const { manager, dispatch } = active;

    await launchDurableObject(manager, {
      source: "workers/counter",
      className: "CounterDO",
      key: "a",
      contextId: "ctx-counter",
    });
    const boot = manager.getBootGeneration();
    await dispatch({ source: "workers/counter", className: "CounterDO", objectKey: "a" }, "incr");

    // A genuinely new userland DO class (different source) — no restart.
    await launchDurableObject(manager, {
      source: "workers/other",
      className: "CounterDO",
      key: "a",
      contextId: "ctx-other",
    });
    expect(manager.getBootGeneration()).toBe(boot);

    expect(
      await dispatch({ source: "workers/other", className: "CounterDO", objectKey: "a" }, "incr")
    ).toMatchObject({ count: 1, source: "workers/other" });
  }, 30_000);

  it("cannot reload or dispatch a retired exact object through its class image", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch } = active;
    const ref = { source: "workers/counter", className: "CounterDO", objectKey: "retired" };
    await launchDurableObject(manager, {
      source: ref.source,
      className: ref.className,
      key: ref.objectKey,
      contextId: "ctx-retired",
    });
    await expect(dispatch(ref, "incr")).resolves.toMatchObject({ count: 1 });

    await manager.destroyDOEntity("do:workers/counter:CounterDO:retired");

    await expect(dispatch(ref, "get")).rejects.toThrow(
      "dispatch failed 404: DO class not found: workers/counter:CounterDO"
    );
  }, 30_000);
});
