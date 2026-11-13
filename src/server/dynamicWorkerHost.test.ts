import { serializeRpcFailure } from "@vibestudio/rpc";
import { workerExecutableHeaders } from "./workerExecutableDispatch.js";
/**
 * Integration test for the dynamic worker host — exercises the REAL celld
 * node end-to-end (set `VIBESTUDIO_CELLD_BIN`, or stage `native/celld`):
 *   - the runtime application's worker host loads a regular worker dynamically
 *     via `env.LOADER` (no per-worker deployment, no restart),
 *   - RPC dispatch reaches the loaded worker through the router → host → loader,
 *   - outbound `fetch()` is attributed non-forgeably: the node stamps the
 *     identity and its MAC, and a header the worker sets itself is not read,
 *   - worker create/destroy/update never restart the node (boot generation
 *     stays put across the lifecycle).
 *
 * Unlike workerdManager.test.ts, this does NOT mock the node supervisor or
 * ports — it runs the actual binary.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ledgerTest } from "../../tests/helpers/ledgerTest.js";
import {
  schemaProbeEnvironmentForFixture,
  useSchemaProbeFixtureCache,
} from "../../tests/fixtures/schemaProbeEnvironment.js";
useSchemaProbeFixtureCache();
import {
  cleanupStoredBuildFixtures,
  storedBuildFixture,
} from "../../tests/helpers/storedBuildFixture.js";

import { TokenManager } from "@vibestudio/shared/tokenManager";
import {
  WorkerdManager,
  type WorkerdManagerDeps,
  type WorkerdWorkspaceProvider,
} from "./workerdManager.js";
import { SingletonRegistry } from "@vibestudio/workspace/singletonRegistry";
import type { BuildResult } from "./buildV2/buildStore.js";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  verifyExecutionArtifactRef,
  type ExecutionArtifactRefV1,
} from "@vibestudio/shared/execution/retention";
import { sha256 } from "@vibestudio/shared/execution/identity";
import { celldTestBinary, nodeProxy, type NodeTraffic } from "../../tests/helpers/celldNodeHarness.js";

const EGRESS_SECRET = "dynamic-worker-host-egress-secret";
// The product's runtime application (dist/runtime-app.json) on the fork's node.
const celldBinary = celldTestBinary();

function runtimeArtifact(source: string, ref = "main"): ExecutionArtifactRefV1 {
  const contentRoots = [
    { repoPath: source, stateHash: `state:${sha256(`state:${source}:${ref}`)}` },
  ];
  const unsigned = {
    version: 1 as const,
    sourceState: {
      kind: "workspace" as const,
      workspaceId: "workspace:test",
      effectiveVersion: sha256(`ev:${source}:${ref}`),
      state: { kind: "event" as const, eventId: `event:${source}:${ref}` },
      contentRoots,
      sourceClosureDigest: executionSourceClosureDigest(contentRoots),
    },
    recipeDigest: sha256(`recipe:${source}`),
    buildKey: sha256(`build:${source}:${ref}`),
    artifactDigest: sha256(`artifact:${source}:${ref}`),
  };
  return verifyExecutionArtifactRef({
    ...unsigned,
    executionDigest: executionArtifactDigest(unsigned),
  });
}

const WORKER_BUNDLE = `let snapshotCalls = 0; export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/snapshot")) {
      return Response.json({feature:env.FEATURE ?? null,args:env.STATE_ARGS ?? null,calls:++snapshotCalls});
    }
    if (url.pathname.endsWith("/__rpc")) {
      const body = await request.json();
      return new Response(JSON.stringify({ result: { echo: body.method, workerId: env.WORKER_ID } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/egress")) {
      // Try to forge identity — the egress gateway must override it.
      const res = await fetch("https://example.com/probe", { headers: { "X-Vibestudio-Egress-Caller": "FORGED", "X-Celld-Egress-Identity": "FORGED" } });
      const seen = await res.json();
      return new Response(JSON.stringify({ result: seen }), { headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }
};`;

function workerBuild(bundle = WORKER_BUNDLE, ev = "ev-1"): BuildResult {
  const buildKey = `build:workers/echo:${ev}`;
  return {
    dir: "/tmp/test-build",
    buildKey,
    sourceStateHash: "state:test",
    metadata: {
      kind: "worker",
      name: "workers/echo",
      buildKey,
      sourcePath: "workers/echo",
      ev,
      sourceStateHash: "state:test",
      sourcemap: false,
      authority: { requests: [], provides: [] },
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
  codeFetches: string[];
  gateway: Server;
  egressHits: NodeTraffic[];
  workerdCall: (path: string, init?: RequestInit) => Promise<Response>;
}

async function listen(server: Server): Promise<number> {
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

async function createHarness(
  buildRef?: { value: BuildResult },
  onCode?: (name: string, version: string) => Promise<void>
): Promise<Harness> {
  const codeFetches: string[] = [];
  const tokenManager = new TokenManager();
  const currentBuild = buildRef ?? { value: workerBuild() };

  // Construct the manager first (getServerUrl reads the port lazily via the
  // holder) so the gateway closure can reference a `const` manager.
  const portHolder = { value: 0 };
  const statePath = mkdtempSync(join(tmpdir(), "vibestudio-dwh-state-"));
  const deps: WorkerdManagerDeps = {
    schemaProbeEnvironment: schemaProbeEnvironmentForFixture("dynamic-worker-host-test"),
    schemaProbeReleaseRoot: join(statePath, "installed-resources"),
    tokenManager,
    fsService: { closeHandlesForCaller: () => {} } as unknown as WorkerdManagerDeps["fsService"],
    getServerUrl: () => `http://127.0.0.1:${portHolder.value}`,
    workspaceId: "workspace:dynamic-worker-host-test",
    getInternalDoEnv: () => ({}),
    workspacePath: mkdtempSync(join(tmpdir(), "vibestudio-dwh-ws-")),
    statePath,
    // The node reaches the gateway, and sends all egress, through one proxy
    // listener (below); its origin is the gateway URL.
    getSharedEgressPort: () => Promise.resolve(portHolder.value),
    registerEgressCaller: () => {},
    unregisterEgressCaller: () => {},
    egressSecret: EGRESS_SECRET,
    getWorkerdGatewayToken: () => "test-gateway-token",
  };
  const provider: WorkerdWorkspaceProvider = {
    bindRuntimeImage: async (unitPath: string, ref?: string) => ({
      source: unitPath,
      unitName: unitPath,
      artifact: runtimeArtifact(unitPath, ref ?? "main"),
      authority: { requests: [], provides: [] },
    }),
    getBuildByKey: async () => storedBuildFixture(currentBuild.value),
    readBuildArtifactContent: async (build, artifact) =>
      readFile(join(build.dir, artifact.path), "utf8"),
    getBuildByExecution: async (_key, executionDigest) =>
      currentBuild.value.metadata.execution?.executionDigest === executionDigest
        ? storedBuildFixture(currentBuild.value)
        : null,
    getManifestRoutes: () => [],
    getManifestDoClasses: () => [],
    singletonRegistry: new SingletonRegistry([]),
  };
  const manager = new WorkerdManager(deps);
  manager.bindWorkspaceProvider(provider);

  // Minimal gateway serving the loader endpoints (mirrors gateway.ts).
  const gatewayHandler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? "";
    const secret = req.headers["x-vibestudio-loader-secret"];
    if (url.startsWith("/_workercode/")) {
      if (secret !== manager.getLoaderSecret()) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: serializeRpcFailure(new Error("Forbidden")) }));
        return;
      }
      const selection = new URL(url, "http://gateway");
      const name = decodeURIComponent(selection.pathname.slice("/_workercode/".length));
      const version = selection.searchParams.get("version");
      if (!name || !version) {
        res.writeHead(400);
        res.end(
          JSON.stringify({ error: serializeRpcFailure(new Error("Missing worker admission")) })
        );
        return;
      }
      codeFetches.push(version);
      void (async () => {
        await onCode?.(name, version);
        const code = await manager.getWorkerCode(name, version);
        if (!code) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: serializeRpcFailure(new Error("Worker not found")) }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(code));
      })().catch((error: unknown) => {
        res.writeHead(
          (error as { code?: string }).code === "WORKER_ADMISSION_CHANGED" ? 409 : 500,
          { "content-type": "application/json" }
        );
        res.end(JSON.stringify({ error: serializeRpcFailure(error) }));
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  };
  const proxy = nodeProxy({ secret: EGRESS_SECRET, gateway: gatewayHandler });
  const gateway = createServer(proxy.listener);
  portHolder.value = await listen(gateway);

  const workerdCall = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const port = manager.getPort();
    if (!port) throw new Error("workerd not running");
    const admission = await manager.getWorkerAdmission(
      decodeURIComponent(path.split("/")[1] ?? "")
    );
    if (!admission) return new Response("Worker not found", { status: 404 });
    try {
      return await fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: {
          Authorization: "Bearer test-gateway-token",
          ...workerExecutableHeaders(admission),
          ...(init.headers ?? {}),
        },
      });
    } finally {
      admission.release?.();
    }
  };

  return { manager, gateway, egressHits: proxy.traffic, workerdCall, codeFetches };
}

let active: Harness | null = null;

afterEach(async () => {
  if (active) {
    await active.manager.shutdown();
    await new Promise<void>((r) => active!.gateway.close(() => r()));
    active = null;
  }
  cleanupStoredBuildFixtures();
});

describe.skipIf(!celldBinary)("dynamic worker host (real celld)", () => {
  beforeEach(() => {
    vi.stubEnv("VIBESTUDIO_CELLD_BIN", celldBinary!);
  });

  it("selects once per admission while preserving env updates and same-name recreation", async () => {
    active = await createHarness();
    const { manager, workerdCall, codeFetches } = active;
    await manager.startWorker({
      source: "workers/echo",
      contextId: "ctx-1",
      key: "echo",
      env: { FEATURE: "first" },
      stateArgs: { value: 1 },
    });
    await manager.startWorker({ source: "workers/echo", contextId: "ctx-2", key: "keep" });
    const original = (await manager.getWorkerAdmission("echo"))!;
    expect(await (await workerdCall("/echo/snapshot")).json()).toEqual({
      feature: "first",
      args: { value: 1 },
      calls: 1,
    });
    expect(await (await workerdCall("/echo/snapshot")).json()).toEqual({
      feature: "first",
      args: { value: 1 },
      calls: 2,
    });
    expect(codeFetches).toEqual([original.version]);
    await manager.updateInstance("echo", { env: { FEATURE: "updated" } });
    const updated = (await manager.getWorkerAdmission("echo"))!;
    expect(updated.version).not.toBe(original.version);
    expect(await (await workerdCall("/echo/snapshot")).json()).toEqual({
      feature: "updated",
      args: { value: 1 },
      calls: 1,
    });
    await manager.stopWorker("worker:workers/echo:echo");
    await manager.startWorker({
      source: "workers/echo",
      contextId: "ctx-1",
      key: "echo",
      env: { FEATURE: "recreated" },
    });
    const recreated = (await manager.getWorkerAdmission("echo"))!;
    expect(recreated.version).not.toBe(original.version);
    expect(recreated.version).not.toBe(updated.version);
    expect(await (await workerdCall("/echo/snapshot")).json()).toEqual({
      feature: "recreated",
      args: null,
      calls: 1,
    });
    expect(codeFetches).toEqual([original.version, updated.version, recreated.version]);
  }, 30_000);

  it("serves the exact cold admission across isolates while a newer selection is published", async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = true;
    active = await createHarness(undefined, async (name) => {
      if (name === "echo" && held) {
        enter();
        await gate;
      }
    });
    const { manager, workerdCall } = active;
    await manager.startWorker({
      source: "workers/echo",
      contextId: "ctx-1",
      key: "echo",
      env: { FEATURE: "old" },
    });
    const pending = workerdCall("/echo/snapshot");
    await entered;
    let sibling: Promise<Response> | undefined;
    let releaseOldAdmission: (() => void) | undefined;
    try {
      const oldAdmission = await manager.getWorkerAdmission("echo");
      if (!oldAdmission) throw new Error("Worker admission disappeared before the update");
      releaseOldAdmission = oldAdmission.release;
      const port = manager.getPort();
      if (!port) throw new Error("workerd did not start");
      sibling = fetch(`http://127.0.0.1:${port}/echo/snapshot`, {
        headers: {
          Authorization: "Bearer test-gateway-token",
          ...workerExecutableHeaders(oldAdmission),
        },
      });
      await manager.updateInstance("echo", { env: { FEATURE: "new" } });
      held = false;
      release();
      for (const response of await Promise.all([pending, sibling])) {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ feature: "old" });
      }
      expect(await (await workerdCall("/echo/snapshot")).json()).toEqual({
        feature: "new",
        args: null,
        calls: 1,
      });
    } finally {
      releaseOldAdmission?.();
      release();
      await Promise.allSettled(sibling ? [pending, sibling] : [pending]);
    }
  }, 30_000);

  it("loads a worker dynamically and dispatches RPC with no restart", async () => {
    active = await createHarness();
    const { manager, workerdCall } = active;

    await manager.startWorker({
      source: "workers/echo",
      contextId: "ctx-1",
      key: "echo",
    });
    const bootAfterCreate = manager.getBootGeneration();

    const res = await workerdCall("/echo/__rpc", {
      method: "POST",
      body: JSON.stringify({ type: "call", method: "ping", args: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { echo: "ping", workerId: "echo" } });

    // A second worker created while the first runs — still no restart.
    await manager.startWorker({ source: "workers/echo", contextId: "ctx-2", key: "echo2" });
    expect(manager.getBootGeneration()).toBe(bootAfterCreate);

    const res2 = await workerdCall("/echo2/__rpc", {
      method: "POST",
      body: JSON.stringify({ type: "call", method: "pong", args: [] }),
    });
    expect(await res2.json()).toEqual({ result: { echo: "pong", workerId: "echo2" } });
  }, 30_000);

  it("attributes egress non-forgeably through the shared listener", async () => {
    active = await createHarness();
    const { manager, workerdCall, egressHits } = active;

    await manager.startWorker({ source: "workers/echo", contextId: "ctx-1", key: "echo" });

    const res = await workerdCall("/echo/egress");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { seenCaller: string | null } };
    // The worker tried to forge "FORGED"; the node stamped the real id (the
    // worker entity's canonical caller id: worker:<source>:<key>), and the
    // proxy verified its MAC before it believed it.
    expect(body.result.seenCaller).toBe("worker:workers/echo:echo");
    const lastHit = egressHits[egressHits.length - 1];
    expect(lastHit?.identity).toMatchObject({
      loaded: true,
      egressIdentity: ["worker:workers/echo:echo"],
    });
    expect(lastHit?.url).toBe("https://example.com/probe");
  }, 30_000);

  it("destroys a worker with no restart and stops addressing it", async () => {
    active = await createHarness();
    const { manager, workerdCall } = active;

    await manager.startWorker({ source: "workers/echo", contextId: "ctx-1", key: "echo" });
    // Keep a second instance so workerd stays up after the destroy.
    await manager.startWorker({ source: "workers/echo", contextId: "ctx-2", key: "keep" });
    const boot = manager.getBootGeneration();

    await manager.stopWorker("worker:workers/echo:echo");
    expect(manager.getBootGeneration()).toBe(boot);
    await expect(manager.getWorkerAdmission("echo")).resolves.toBeNull();

    const res = await workerdCall("/echo/__rpc", {
      method: "POST",
      body: JSON.stringify({ type: "call", method: "ping", args: [] }),
    });
    expect(res.status).toBe(404);

    // The surviving worker still serves.
    const keep = await workerdCall("/keep/__rpc", {
      method: "POST",
      body: JSON.stringify({ type: "call", method: "ping", args: [] }),
    });
    expect(await keep.json()).toEqual({ result: { echo: "ping", workerId: "keep" } });
  }, 30_000);

  ledgerTest(
    "execution.durable-object-push-rebuild",
    async () => {
      const buildRef = { value: workerBuild(WORKER_BUNDLE, "ev-1") };
      active = await createHarness(buildRef);
      const { manager, workerdCall } = active;

      await manager.startWorker({ source: "workers/echo", contextId: "ctx-1", key: "echo" });
      const boot = manager.getBootGeneration();

      const before = await workerdCall("/echo/__rpc", {
        method: "POST",
        body: JSON.stringify({ type: "call", method: "ping", args: [] }),
      });
      expect((await before.json()).result.echo).toBe("ping");

      // Swap the build for one that tags responses, then bump the version.
      buildRef.value = workerBuild(
        WORKER_BUNDLE.replace("echo: body.method", 'echo: "v2:" + body.method'),
        "ev-2"
      );
      await manager.updateInstance("echo", { env: { ROLLED: "1" } });
      expect(manager.getBootGeneration()).toBe(boot);

      const after = await workerdCall("/echo/__rpc", {
        method: "POST",
        body: JSON.stringify({ type: "call", method: "ping", args: [] }),
      });
      expect((await after.json()).result.echo).toBe("v2:ping");
    },
    30_000
  );
});
