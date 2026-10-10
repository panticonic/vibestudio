import type { RpcFailure } from "@vibestudio/rpc";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ledgerTest } from "../../tests/helpers/ledgerTest.js";

import { TokenManager } from "@vibestudio/shared/tokenManager";
import {
  WorkerdManager,
  type WorkerdManagerDeps,
  type WorkerdWorkspaceProvider,
} from "./workerdManager.js";
import { SingletonRegistry } from "@vibestudio/workspace/singletonRegistry";
import { encodeUniversalKey } from "./doDispatch.js";
import { doExecutableHeaders, type DoExecutableAdmission } from "./doExecutableDispatch.js";
import type { BuildResult } from "./buildV2/buildStore.js";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  verifyExecutionArtifactRef,
  type ExecutionArtifactRefV1,
} from "@vibestudio/shared/execution/retention";
import { sha256 } from "@vibestudio/shared/execution/identity";
import {
  buildWorkerdPrograms,
  type WorkerdProgramSources,
} from "../../scripts/build-workerd-programs.mjs";
import { beginDurableObjectRelay } from "./workerdRpcRelay.js";

let compiledWorkerdPrograms: WorkerdProgramSources;

function runtimeArtifact(source: string, ref = "main"): ExecutionArtifactRefV1 {
  const contentRoots = [
    { repoPath: source, stateHash: `state:${sha256(`state:${source}:${ref}`)}` },
  ];
  const unsigned = {
    version: 1 as const,
    sourceState: {
      kind: "workspace" as const,
      workspaceId: "workspace:universal-do-host-test",
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

beforeAll(async () => {
  compiledWorkerdPrograms = await buildWorkerdPrograms({ write: false });
});

const COUNTER_DO = `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
let unitConstructors = 0;
export class VibestudioExecutable extends WorkerEntrypoint {
  fetch() { return new Response(null, {status:204}); }
}
export class CounterDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    unitConstructors++;
    this.ctx = ctx; this.env = env;
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS c (n INTEGER)");
  }
  async fetch(request) {
    if (this.env.VIBESTUDIO_SCHEMA_PROBE === true) {
      return Response.json({
        className: "CounterDO", version: 1, durableWorkQueues: [],
        freshSchemaFingerprint: JSON.stringify([...this.ctx.storage.sql.exec(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name = 'c' ORDER BY type, name"
        )]),
      });
    }
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const userKey = parts[0] ? decodeURIComponent(parts[0]) : "";
    const method = parts.slice(1).join("/") || "get";
    if (method === "network") {
      const response = await fetch("http://shared-unit-egress.invalid/probe");
      return Response.json({ result: await response.json() });
    }
    if (method === "generation") return Response.json({result:"v1"});
    if (method === "failure") throw new Error("Original provider failure (503)");
    if (method === "instance") {
      this.localCalls = (this.localCalls || 0) + 1;
      return Response.json({result:{unitConstructors,localCalls:this.localCalls,held:this.held === true,stateArgs:this.ctx.props.stateArgs,hasStateArgsEnv:Object.hasOwn(this.env,"STATE_ARGS"),key:userKey}});
    }
    if (method === "hold") {
      this.held = true;
      await new Promise(() => {});
    }
    if (request.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (method === "incr") {
      this.ctx.storage.sql.exec("INSERT INTO c (n) VALUES (1)");
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
  async webSocketClose(ws, code, reason) {
    ws.close(code, reason);
  }
}
export default { fetch() { return new Response("counter host"); } };`;

const SCHEMA_PROBE_DO = `import { DurableObject } from "cloudflare:workers";
export class SchemaProbeDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.ctx = ctx; this.env = env;
    this.ctx.storage.sql.exec("CREATE TABLE cards (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
    this.ctx.storage.sql.exec("CREATE INDEX cards_title ON cards(title)");
  }
  async fetch() {
    const shape = JSON.stringify([...this.ctx.storage.sql.exec(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name IN ('cards', 'cards_title') ORDER BY type, name"
    )]);
    const descriptor = {
      className: "SchemaProbeDO", version: 1, freshSchemaFingerprint: shape, durableWorkQueues: [],
    };
    if (this.env.VIBESTUDIO_SCHEMA_PROBE === true) {
      let outboundSucceeded = false;
      try { await fetch("http://schema-probe.invalid/forbidden"); outboundSucceeded = true; } catch {}
      if (outboundSucceeded) throw new Error("schema probe acquired outbound access");
      return Response.json(descriptor);
    }
    const trusted = this.env.VIBESTUDIO_SCHEMA_DESCRIPTOR;
    if (!trusted || trusted.className !== descriptor.className || trusted.version !== descriptor.version ||
      trusted.freshSchemaFingerprint !== descriptor.freshSchemaFingerprint) {
      return new Response("missing trusted schema descriptor", { status: 500 });
    }
    return Response.json({ result: descriptor });
  }
}
export default { fetch() { return new Response("probe host"); } };`;

function doBuild(
  source: string,
  ev: string,
  bundle = COUNTER_DO,
  extraArtifacts: BuildResult["artifacts"] = []
): BuildResult {
  const buildKey = `build:${source}:${ev}`;
  return {
    dir: "/tmp/test-build",
    buildKey,
    sourceStateHash: "state:test",
    metadata: {
      kind: "worker",
      name: source,
      buildKey,
      sourcePath: source,
      ev,
      sourceStateHash: "state:test",
      sourcemap: false,
      authority: { requests: [], provides: [], serviceRequests: [] },
      executableModules: [
        {
          moduleId: source + "/index.ts",
          package: { kind: "workspace", name: source, effectiveVersion: ev },
          format: "ts",
          source: bundle,
          contentDigest: sha256(bundle),
        },
      ],
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
      ...extraArtifacts,
    ],
  };
}

interface Harness {
  ownedPaths: string[];
  manager: WorkerdManager;
  gateway: Server;
  codeFetches: Map<string, number>;
  admissionFetches: Map<string, number>;
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

async function createHarness(
  builds: Record<string, BuildResult>,
  hooks: {
    onAdmission?: (
      ref: { source: string; className: string; objectKey: string },
      admission: DoExecutableAdmission
    ) => Promise<void>;
  } = {}
): Promise<Harness> {
  const tokenManager = new TokenManager();
  const boundBuilds = new Map<string, BuildResult>(
    Object.values(builds)
      .filter((build) => build.metadata.execution)
      .map((build) => [build.buildKey, build])
  );
  // Construct the manager first (its getServerUrl reads the port lazily via the
  // holder) so the gateway closure below can reference a `const` manager.
  const portHolder = { value: 0 };

  const deps: WorkerdManagerDeps = {
    tokenManager,
    fsService: { closeHandlesForCaller: () => {} } as unknown as WorkerdManagerDeps["fsService"],
    getServerUrl: () => `http://127.0.0.1:${portHolder.value}`,
    workspaceId: "workspace:universal-do-host-test",
    workerdPrograms: compiledWorkerdPrograms,
    getInternalDoEnv: () => ({}),
    workspacePath: mkdtempSync(join(tmpdir(), "vibestudio-udo-ws-")),
    statePath: mkdtempSync(join(tmpdir(), "vibestudio-udo-state-")),
    getProxyPort: () => 1,
    getSharedEgressPort: () => Promise.resolve(portHolder.value),
    registerEgressCaller: () => {},
    unregisterEgressCaller: () => {},
    egressSecret: "universal-do-host-egress-secret",
    getWorkerdGatewayToken: () => "udo-gateway-token",
  };
  const provider: WorkerdWorkspaceProvider = {
    bindRuntimeImage: async (source: string, ref?: string) => {
      const b = builds[source];
      if (!b) throw new Error(`no build for ${source}`);
      const artifact = runtimeArtifact(source, ref ?? "main");
      boundBuilds.set(artifact.buildKey, {
        ...b,
        buildKey: artifact.buildKey,
        metadata: {
          ...b.metadata,
          buildKey: artifact.buildKey,
          execution: artifact,
          ev: artifact.sourceState.effectiveVersion,
          sourceState: artifact.sourceState.state,
        },
      });
      return {
        source,
        unitName: source,
        artifact,
        authority: { requests: [], provides: [], serviceRequests: [] },
      };
    },
    getBuildByKey: (key: string) => boundBuilds.get(key) ?? null,
    getBuildByExecution: (key: string, executionDigest: string) => {
      const build = boundBuilds.get(key) ?? null;
      return build?.metadata.execution?.executionDigest === executionDigest ? build : null;
    },
    getManifestRoutes: () => [],
    getManifestDoClasses: () => [],
    singletonRegistry: new SingletonRegistry([]),
  };
  const manager = new WorkerdManager(deps);
  manager.bindWorkspaceProvider(provider);
  const codeFetches = new Map<string, number>();
  const admissionFetches = new Map<string, number>();

  const gateway = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.headers["x-vibestudio-egress-secret"] === "universal-do-host-egress-secret") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ caller: req.headers["x-vibestudio-egress-caller"] }));
      return;
    }
    const secret = req.headers["x-vibestudio-loader-secret"];
    if (url.startsWith("/_doadmission/")) {
      if (secret !== manager.getLoaderSecret()) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      const requested = new URL(url, "http://gateway");
      const [source, className] = requested.pathname
        .slice("/_doadmission/".length)
        .split("/")
        .map(decodeURIComponent);
      const objectKey = requested.searchParams.get("objectKey");
      const executableVersion = requested.searchParams.get("executableVersion");
      const incarnationVersion = requested.searchParams.get("incarnationVersion");
      if (!source || !className || !objectKey || !executableVersion || !incarnationVersion) {
        res.writeHead(400);
        res.end("Incomplete admission");
        return;
      }
      admissionFetches.set(objectKey, (admissionFetches.get(objectKey) ?? 0) + 1);
      const admission = manager.getDoAdmission(source, className, objectKey);
      if (
        !admission ||
        admission.executableVersion !== executableVersion ||
        admission.incarnationVersion !== incarnationVersion
      ) {
        res.writeHead(409);
        res.end("Admission changed");
        return;
      }
      void Promise.resolve(hooks.onAdmission?.({ source, className, objectKey }, admission)).then(
        () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(admission));
        },
        (error) => {
          res.writeHead(500);
          res.end(error instanceof Error ? error.message : String(error));
        }
      );
      return;
    }
    if (url.startsWith("/_docode/")) {
      if (secret !== manager.getLoaderSecret()) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      const segs = (url.slice("/_docode/".length).split("?")[0] ?? "").split("/");
      const source = decodeURIComponent(segs[0] ?? "");
      const className = decodeURIComponent(segs[1] ?? "");
      const objectKey = new URL(url, "http://gateway").searchParams.get("objectKey") ?? "";

      codeFetches.set(objectKey, (codeFetches.get(objectKey) ?? 0) + 1);
      void Promise.resolve()
        .then(() =>
          manager.getDoCode(
            source,
            className,
            new URL(url, "http://gateway").searchParams.get("version") ?? "",
            objectKey
          )
        )
        .then((code) => {
          if (!code) {
            res.writeHead(404);
            res.end("nf");
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(code));
        })
        .catch((error: unknown) => {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(error instanceof Error ? error.message : String(error));
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
        ...doExecutableHeaders(ref, (key) =>
          manager.getDoAdmission(key.source, key.className, key.objectKey)
        ),
        "Content-Type": "application/json",
      },
      body: "[]",
    });
    if (!res.ok) throw new Error(`dispatch failed ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { result: unknown }).result;
  };

  return {
    manager,
    gateway,
    codeFetches,
    admissionFetches,
    dispatch,
    ownedPaths: [deps.workspacePath, deps.statePath],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bindConfiguredObject(
  manager: WorkerdManager,
  ref: { source: string; className: string; objectKey: string },
  stateArgs: Record<string, unknown>
) {
  const prepared = await manager.ensureDurableObjectEntity({
    source: ref.source,
    className: ref.className,
    key: ref.objectKey,
    ref: "main",
    contextId: "configured-context",
    stateArgs,
  });
  await manager.restoreDurableObjectEntity({
    id: prepared.targetId,
    kind: "do",
    className: ref.className,
    key: ref.objectKey,
    source: { repoPath: ref.source, effectiveVersion: prepared.effectiveVersion },
    activeBuildKey: prepared.buildKey,
    activeExecutionDigest: prepared.executionDigest,
    activeAuthority: prepared.authority,
    stateArgs,
    contextId: "configured-context",
    createdAt: 1,
    status: "active",
    cleanupComplete: false,
  });
  return manager.getDoAdmission(ref.source, ref.className, ref.objectKey)!;
}

let active: Harness | null = null;
afterEach(async () => {
  if (active) {
    const owned = active;
    active = null;
    try {
      await owned.manager.shutdown();
    } finally {
      await new Promise<void>((r) => owned.gateway.close(() => r()));
      for (const ownedPath of owned.ownedPaths) rmSync(ownedPath, { recursive: true, force: true });
    }
  }
});

function cloneReservation(
  source: { source: string; className: string; objectKey: string },
  key: string,
  manager: WorkerdManager
): EntityRecord {
  const sourceId = `do:${source.source}:${source.className}:${source.objectKey}`;
  const image = manager.listRuntimeImages().find((entry) => entry.id === sourceId);
  if (!image) throw new Error(`Missing exact source fixture image ${sourceId}`);
  return {
    id: `do:${source.source}:${source.className}:${key}`,
    kind: "do",
    source: { repoPath: source.source, effectiveVersion: "" },
    className: source.className,
    key,
    contextId: `clone:${key}`,
    authoritySessionId: `clone-session:${key}`,
    status: "preparing",
    createdAt: 1,
    cleanupComplete: true,
    cloneProvenance: {
      storage: "snapshot",
      operationContextId: `clone:${key}`,
      sourceEntityId: sourceId,
      sourceContextId: "source-context",
      sourceAuthoritySessionId: "source-session",
      sourceBuildKey: image.artifact.buildKey,
      sourceExecutionDigest: image.artifact.executionDigest,
    },
  };
}

function sourceOwner(reservation: EntityRecord): EntityRecord {
  const source = reservation.cloneProvenance!;
  return {
    ...reservation,
    id: source.sourceEntityId,
    key: source.sourceEntityId.slice(
      `do:${reservation.source.repoPath}:${reservation.className}:`.length
    ),
    contextId: source.sourceContextId,
    authoritySessionId: source.sourceAuthoritySessionId,
    activeBuildKey: source.sourceBuildKey,
    activeExecutionDigest: source.sourceExecutionDigest,
    activeAuthority: { provides: [], requests: [] },
    status: "active",
    cloneProvenance: undefined,
  };
}

describe("UniversalDO facet host (real workerd)", () => {
  it("preserves application failures containing HTTP status text", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");
    const ref = { source: "workers/counter", className: "CounterDO", objectKey: "failure" };
    await expect(dispatch(ref, "failure")).rejects.toThrow("dispatch failed 500");
    await expect(dispatch(ref, "failure")).rejects.toThrow("Original provider failure (503)");
    expect(await dispatch(ref, "get")).toMatchObject({ count: 0 });
  });
  it("shares executable code while isolating SQLite, fields and retirement cancellation", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch, codeFetches } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");
    const first = { source: "workers/counter", className: "CounterDO", objectKey: "shared-first" };
    const second = { ...first, objectKey: "shared-second" };
    expect(await dispatch(first, "incr")).toMatchObject({ count: 1 });
    expect(await dispatch(second, "get")).toMatchObject({ count: 0 });
    expect(await dispatch(first, "instance")).toMatchObject({
      localCalls: 1,
      key: first.objectKey,
    });
    expect(await dispatch(second, "instance")).toMatchObject({
      localCalls: 1,
      key: second.objectKey,
    });
    expect([...codeFetches.values()].reduce((sum, value) => sum + value, 0)).toBe(1);
    const boot = manager.getBootGeneration();
    const held = dispatch(first, "hold").then(
      () => ({ ok: true }),
      (error) => ({ error })
    );
    // A second request to this exact facet proves the first request entered its
    // owning instance before retirement; no time-based readiness surrogate.
    expect(await dispatch(first, "instance")).toMatchObject({ localCalls: 2, held: true });
    await manager.retireDOEntity(first);
    expect(await held).toHaveProperty("error");
    expect(manager.getBootGeneration()).toBe(boot);
    expect(await dispatch(second, "instance")).toMatchObject({ localCalls: 2, held: false });
    expect(await dispatch(first, "instance")).toMatchObject({ localCalls: 1, held: false });
    expect(await dispatch(first, "get")).toMatchObject({ count: 1 });
    expect([...codeFetches.values()].reduce((sum, value) => sum + value, 0)).toBe(1);
  }, 30_000);

  it("prepares the actual unit without constructing an object and reuses it on first demand", async () => {
    const source = "workers/prepared-counter";
    const build = doBuild(source, "ev-1");
    const artifact = runtimeArtifact(source, "main");
    const preparedBuild: BuildResult = {
      ...build,
      buildKey: artifact.buildKey,
      metadata: {
        ...build.metadata,
        buildKey: artifact.buildKey,
        execution: artifact,
        ev: artifact.sourceState.effectiveVersion,
        sourceState: artifact.sourceState.state,
      },
    };
    active = await createHarness({ [source]: preparedBuild });
    const { manager, dispatch, codeFetches, admissionFetches } = active;
    await manager.prepareWorkerExecutable(preparedBuild, ["CounterDO"]);
    expect(manager.getDoAdmission(source, "CounterDO", "first")).toBeNull();
    const fetchedBeforeDemand = [...codeFetches.values()].reduce((sum, value) => sum + value, 0);
    const instructions = "Native instructions: λ 日本語 🧭\n".repeat(6000);
    expect(Buffer.byteLength(instructions)).toBeGreaterThanOrEqual(128 * 1024);
    const stateArgs = { prepared: true, instructions };
    const prepared = await manager.ensureDurableObjectEntity({
      source,
      className: "CounterDO",
      key: "first",
      ref: "main",
      contextId: "prepared-context",
      stateArgs,
    });
    await manager.restoreDurableObjectEntity({
      id: prepared.targetId,
      kind: "do",
      className: "CounterDO",
      key: "first",
      source: { repoPath: source, effectiveVersion: prepared.effectiveVersion },
      activeBuildKey: prepared.buildKey,
      activeExecutionDigest: prepared.executionDigest,
      activeAuthority: prepared.authority,
      stateArgs,
      contextId: "prepared-context",
      createdAt: 1,
      status: "active",
      cleanupComplete: false,
    });
    const configured = (await dispatch(
      { source, className: "CounterDO", objectKey: "first" },
      "instance"
    )) as {
      unitConstructors: number;
      localCalls: number;
      stateArgs: { prepared: boolean; instructions: string };
      hasStateArgsEnv: boolean;
    };
    expect(configured.unitConstructors).toBe(1);
    expect(configured.localCalls).toBe(1);
    expect(configured.hasStateArgsEnv).toBe(false);
    expect(configured.stateArgs.prepared).toBe(true);
    expect(configured.stateArgs.instructions.length).toBe(instructions.length);
    expect(sha256(configured.stateArgs.instructions)).toBe(sha256(instructions));
    expect(admissionFetches.get("first")).toBe(1);
    const ref = { source, className: "CounterDO", objectKey: "first" };
    expect(
      Object.keys(
        doExecutableHeaders(ref, (key) =>
          manager.getDoAdmission(key.source, key.className, key.objectKey)
        )
      ).sort()
    ).toEqual(["X-Vibestudio-Executable-Version", "X-Vibestudio-Incarnation-Version"]);
    await dispatch(ref, "get");
    expect(admissionFetches.get("first")).toBe(1);
    expect([...codeFetches.values()].reduce((sum, value) => sum + value, 0)).toBe(
      fetchedBeforeDemand
    );
    const inspector = manager.getInspectorUrl();
    expect(inspector).not.toBeNull();
    const targets = (await fetch(`${inspector}/json/list`).then((response) =>
      response.json()
    )) as Array<{ title: string }>;
    expect(targets.some((target) => target.title.includes("do-code:"))).toBe(true);
  });

  it("keeps shared executable network egress alive after the first loading object retires", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch, codeFetches } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");
    const first = { source: "workers/counter", className: "CounterDO", objectKey: "network-first" };
    const second = { ...first, objectKey: "network-second" };
    const before = await dispatch(first, "network");
    expect(before).toMatchObject({
      caller: expect.stringMatching(/^do-code:workers\/counter:CounterDO:/),
    });
    expect(await dispatch(second, "network")).toEqual(before);
    await manager.retireDOEntity(first);
    expect(await dispatch(second, "network")).toEqual(before);
    expect([...codeFetches.values()].reduce((sum, value) => sum + value, 0)).toBe(1);
  }, 30_000);

  it("coalesces concurrent cold requests into one exact configured facet", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    active = await createHarness(
      { "workers/counter": doBuild("workers/counter", "ev-1") },
      {
        onAdmission: async (ref) => {
          if (ref.objectKey === "cold-concurrent") {
            entered.resolve();
            await release.promise;
          }
        },
      }
    );
    const { manager, dispatch, admissionFetches } = active;
    const ref = { source: "workers/counter", className: "CounterDO", objectKey: "cold-concurrent" };
    await bindConfiguredObject(manager, ref, { configuration: "shared" });
    const first = dispatch(ref, "instance");
    await entered.promise;
    const second = dispatch(ref, "instance");
    try {
      release.resolve();
      const responses = (await Promise.all([first, second])) as Array<{
        unitConstructors: number;
        localCalls: number;
        stateArgs: { configuration: string };
      }>;
      expect(responses.map((value) => value.localCalls).sort((a, b) => a - b)).toEqual([1, 2]);
      expect(
        responses.every(
          (value) => value.unitConstructors === 1 && value.stateArgs.configuration === "shared"
        )
      ).toBe(true);
      expect(admissionFetches.get(ref.objectKey)).toBe(1);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
  }, 30_000);

  it("joins a pending cold admission before retiring its object", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    active = await createHarness(
      { "workers/counter": doBuild("workers/counter", "ev-1") },
      {
        onAdmission: async (ref) => {
          if (ref.objectKey === "admission-retirement") {
            entered.resolve();
            await release.promise;
          }
        },
      }
    );
    const { manager, dispatch, codeFetches } = active;
    const ref = {
      source: "workers/counter",
      className: "CounterDO",
      objectKey: "admission-retirement",
    };
    await bindConfiguredObject(manager, ref, { configuration: "retiring" });
    const preparedCodeFetches = [...codeFetches.values()].reduce((sum, count) => sum + count, 0);
    const pending = dispatch(ref, "instance").then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    await entered.promise;
    try {
      await manager.retireDOEntity(ref);
      expect(await pending).toHaveProperty("error");
      expect([...codeFetches.values()].reduce((sum, count) => sum + count, 0)).toBe(
        preparedCodeFetches
      );
      release.resolve();
      const sibling = (await dispatch({ ...ref, objectKey: "retirement-sibling" }, "instance")) as {
        unitConstructors: number;
      };
      expect(sibling.unitConstructors).toBe(1);
    } finally {
      release.resolve();
      await pending;
    }
  }, 30_000);

  it("does not let a late old admission overwrite a newer configured facet", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    active = await createHarness(
      { "workers/counter": doBuild("workers/counter", "ev-1") },
      {
        onAdmission: async (ref, admission) => {
          if (
            ref.objectKey === "admission-advance" &&
            admission.props.stateArgs?.["configuration"] === "old"
          ) {
            entered.resolve();
            await release.promise;
          }
        },
      }
    );
    const { manager, dispatch } = active;
    const ref = {
      source: "workers/counter",
      className: "CounterDO",
      objectKey: "admission-advance",
    };
    await bindConfiguredObject(manager, ref, { configuration: "old" });
    const old = dispatch(ref, "instance").then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    await entered.promise;
    try {
      await bindConfiguredObject(manager, ref, { configuration: "new" });
      const current = (await dispatch(ref, "instance")) as {
        unitConstructors: number;
        localCalls: number;
        stateArgs: { configuration: string };
      };
      expect(current.unitConstructors).toBe(1);
      expect(current.localCalls).toBe(1);
      expect(current.stateArgs.configuration).toBe("new");
      release.resolve();
      expect(await old).toHaveProperty("error");
      const retained = (await dispatch(ref, "instance")) as {
        unitConstructors: number;
        localCalls: number;
        stateArgs: { configuration: string };
      };
      expect(retained.unitConstructors).toBe(1);
      expect(retained.localCalls).toBe(2);
      expect(retained.stateArgs.configuration).toBe("new");
    } finally {
      release.resolve();
      await old;
    }
  }, 30_000);

  it("shares code across exact per-object configuration and replaces only the changed incarnation", async () => {
    const builds: Record<string, BuildResult> = {
      "workers/counter": doBuild("workers/counter", "ev-1"),
    };
    active = await createHarness(builds);
    const { manager, dispatch, codeFetches } = active;
    const base = { source: "workers/counter", className: "CounterDO" };
    const activate = async (objectKey: string, ref: string, stateArgs: Record<string, unknown>) => {
      const prepared = await manager.ensureDurableObjectEntity({
        ...base,
        key: objectKey,
        ref,
        contextId: "unit-context",
        stateArgs,
      });
      await manager.restoreDurableObjectEntity({
        id: prepared.targetId,
        kind: "do",
        className: base.className,
        key: objectKey,
        source: { repoPath: base.source, effectiveVersion: prepared.effectiveVersion },
        activeBuildKey: prepared.buildKey,
        activeExecutionDigest: prepared.executionDigest,
        activeAuthority: prepared.authority,
        stateArgs,
        contextId: "unit-context",
        createdAt: 1,
        status: "active",
        cleanupComplete: false,
      });
    };
    const first = { ...base, objectKey: "first-config" };
    const sibling = { ...base, objectKey: "sibling-config" };
    await activate(first.objectKey, "ctx:shared", { configuration: "first" });
    await activate(sibling.objectKey, "ctx:shared", { configuration: "sibling" });
    const boot = manager.getBootGeneration();
    const firstAdmission = manager.getDoAdmission(first.source, first.className, first.objectKey)!;
    const siblingAdmission = manager.getDoAdmission(
      sibling.source,
      sibling.className,
      sibling.objectKey
    )!;
    expect(firstAdmission.executableVersion).toBe(siblingAdmission.executableVersion);
    expect(await dispatch(first, "instance")).toMatchObject({
      localCalls: 1,
      unitConstructors: 1,
      stateArgs: { configuration: "first" },
      hasStateArgsEnv: false,
    });
    expect(await dispatch(sibling, "instance")).toMatchObject({
      localCalls: 1,
      unitConstructors: 2,
      stateArgs: { configuration: "sibling" },
      hasStateArgsEnv: false,
    });
    expect(await dispatch(first, "incr")).toMatchObject({ count: 1 });
    expect(await dispatch(sibling, "get")).toMatchObject({ count: 0 });
    const codeLoads = () =>
      [...codeFetches]
        .filter(([key]) => !key.startsWith("__vibestudio_schema_probe:"))
        .reduce((sum, [, count]) => sum + count, 0);
    expect(codeLoads()).toBe(1);
    const held = dispatch(first, "hold").then(
      () => ({ completed: true }),
      (error) => ({ error })
    );
    expect(await dispatch(first, "instance")).toMatchObject({ held: true, localCalls: 2 });
    await activate(first.objectKey, "ctx:shared", { configuration: "reconfigured" });
    const updatedAdmission = manager.getDoAdmission(
      first.source,
      first.className,
      first.objectKey
    )!;
    expect(updatedAdmission.executableVersion).toBe(firstAdmission.executableVersion);
    expect(updatedAdmission.incarnationVersion).not.toBe(firstAdmission.incarnationVersion);
    expect(await dispatch(first, "instance")).toMatchObject({
      localCalls: 1,
      held: false,
      unitConstructors: 3,
      stateArgs: { configuration: "reconfigured" },
    });
    expect(await held).toHaveProperty("error");
    expect(await dispatch(first, "get")).toMatchObject({ count: 1 });
    expect(await dispatch(sibling, "instance")).toMatchObject({
      localCalls: 2,
      held: false,
      stateArgs: { configuration: "sibling" },
    });
    expect(codeLoads()).toBe(1);
    const changed = { ...base, objectKey: "changed-code" };
    builds[base.source] = doBuild(
      base.source,
      "ev-2",
      COUNTER_DO.replace('result:"v1"', 'result:"v2"')
    );
    await activate(changed.objectKey, "ctx:changed", { configuration: "changed" });
    expect(
      manager.getDoAdmission(changed.source, changed.className, changed.objectKey)!
        .executableVersion
    ).not.toBe(firstAdmission.executableVersion);
    expect(await dispatch(changed, "instance")).toMatchObject({
      localCalls: 1,
      unitConstructors: 1,
      stateArgs: { configuration: "changed" },
    });
    expect(await dispatch(changed, "generation")).toBe("v2");
    expect(await dispatch(first, "generation")).toBe("v1");
    expect(await dispatch(sibling, "network")).toMatchObject({
      caller: expect.stringMatching(/^do-code:/),
    });
    expect(codeLoads()).toBe(2);
    expect(manager.getBootGeneration()).toBe(boot);
  }, 30_000);

  it("requires the admitted executable identity before loading code and rejects a different code identity", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, codeFetches, dispatch } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");
    const ref = { source: "workers/counter", className: "CounterDO", objectKey: "identity-test" };
    const url = `http://127.0.0.1:${manager.getPort()}/_u/${encodeURIComponent(encodeUniversalKey(ref))}/incr`;
    const headers = {
      Authorization: "Bearer udo-gateway-token",
      "X-Vibestudio-Dispatch-Secret": manager.getDispatchSecret(),
      "Content-Type": "application/json",
    };
    const before = [...codeFetches];
    const missing = await fetch(url, { method: "POST", headers, body: "[]" });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("missing executable identity");
    expect([...codeFetches]).toEqual(before);
    const stale = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        ...doExecutableHeaders(ref, (key) =>
          manager.getDoAdmission(key.source, key.className, key.objectKey)
        ),
        "X-Vibestudio-Executable-Version": "another-incarnation",
      },
      body: "[]",
    });
    expect(stale.status).toBe(500);
    const failure = (await stale.json()) as { error: RpcFailure };
    expect(failure.error).toMatchObject({
      name: "Error",
      message: "universal-do: Admission changed (409)",
      errorKind: "application",
    });
    expect(failure.error.stack).toContain("Admission changed (409)");
    expect(await dispatch(ref, "incr")).toMatchObject({ count: 1 });
  });
  it("admits a fresh entity's exact schema before activation without a publication", async () => {
    const source = "workers/schema-admission";
    active = await createHarness({ [source]: doBuild(source, "fresh", SCHEMA_PROBE_DO) });
    const { manager, codeFetches, dispatch } = active;
    const prepared = await manager.ensureDurableObjectEntity({
      source,
      className: "SchemaProbeDO",
      key: "fresh",
      contextId: "fresh-context",
    });
    await manager.restoreDurableObjectEntity({
      id: prepared.targetId,
      kind: "do",
      className: "SchemaProbeDO",
      key: "fresh",
      source: { repoPath: source, effectiveVersion: prepared.effectiveVersion },
      activeBuildKey: prepared.buildKey,
      activeExecutionDigest: prepared.executionDigest,
      activeAuthority: prepared.authority,
      contextId: "fresh-context",
      createdAt: 1,
      status: "active",
      cleanupComplete: false,
    });
    expect(
      await dispatch({ source, className: "SchemaProbeDO", objectKey: "fresh" }, "get")
    ).toMatchObject({
      className: "SchemaProbeDO",
      version: 1,
      freshSchemaFingerprint: expect.stringContaining("cards_title"),
    });
    expect(
      [...codeFetches.keys()].filter((key) => key.startsWith("__vibestudio_schema_probe:"))
    ).toHaveLength(1);
  });
  it("probes a candidate schema in workerd and destroys its reserved scratch storage", async () => {
    const source = "workers/schema-probe";
    const build = doBuild(source, "ev-probe", SCHEMA_PROBE_DO);
    active = await createHarness({ [source]: build });

    const descriptor = await active.manager.probeDurableObjectSchema(
      source,
      "SchemaProbeDO",
      build
    );

    expect(descriptor).toMatchObject({
      className: "SchemaProbeDO",
      version: 1,
    });
    expect(descriptor.freshSchemaFingerprint).toContain("cards_title");
  });

  ledgerTest(
    "execution.ensure-durable-object",
    async () => {
      active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
      const { manager, codeFetches, dispatch } = active;

      // Registering the first userland DO class brings workerd up once.
      await manager.ensureDOClass("workers/counter", "CounterDO");
      const boot = manager.getBootGeneration();

      const ref1 = { source: "workers/counter", className: "CounterDO", objectKey: "k1" };
      expect(await dispatch(ref1, "incr")).toEqual({
        count: 1,
        source: "workers/counter",
        cls: "CounterDO",
        key: "k1",
      });
      expect(await dispatch(ref1, "incr")).toMatchObject({ count: 2 });
      expect(codeFetches.get("k1")).toBe(1);

      // A different object key is an isolated facet (its own storage).
      const ref2 = { source: "workers/counter", className: "CounterDO", objectKey: "k2" };
      expect(await dispatch(ref2, "incr")).toMatchObject({ count: 1, key: "k2" });
      expect(await dispatch(ref1, "get")).toMatchObject({ count: 2 });

      // Runtime retirement aborts the live facet without disrupting unrelated
      // work. WorkerLoader has no per-isolate unload primitive, so a later
      // pressure-triggered process compaction reclaims its loaded module graph.
      // Durable storage remains intact across both boundaries.
      await manager.retireDOEntity(ref1);
      expect(manager.getBootGeneration()).toBe(boot);
      const internals = manager as unknown as {
        maybeCompactRetiredDynamicIsolates(rssBytes: number): void;
        dynamicIsolateCompactionFlight: Promise<void> | null;
        doObjectBuilds: Map<string, unknown>;
      };
      // The class-level fixture dispatch path above intentionally skips the
      // production object-image registry. Model the live object binding at the
      // manager boundary whose presence must veto a process restart.
      internals.doObjectBuilds.set("workers/counter:CounterDO/k2", {});
      internals.maybeCompactRetiredDynamicIsolates(768 * 1024 * 1024);
      expect(internals.dynamicIsolateCompactionFlight).toBeNull();
      expect(manager.getBootGeneration()).toBe(boot);

      // Object retirement does not retire the executable still owned by the
      // class binding, so it cannot manufacture isolate pressure or restart.
      await manager.retireDOEntity(ref2);
      internals.doObjectBuilds.delete("workers/counter:CounterDO/k2");
      internals.maybeCompactRetiredDynamicIsolates(768 * 1024 * 1024);
      await internals.dynamicIsolateCompactionFlight;
      expect(manager.getBootGeneration()).toBe(boot);
      expect(await dispatch(ref1, "get")).toMatchObject({ count: 2, key: "k1" });
      expect(codeFetches.get("k1")).toBe(1);
    },
    30_000
  );

  it("keeps one shared executable warm across many independent object retirements", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");
    const refs = Array.from({ length: 16 }, (_, index) => ({
      source: "workers/counter",
      className: "CounterDO",
      objectKey: `bounded-${index}`,
    }));
    await dispatch(refs[0]!, "incr");
    const boot = manager.getBootGeneration();

    for (let index = 0; index < 15; index++) {
      await dispatch(refs[index]!, "get");
      await manager.retireDOEntity(refs[index]!);
      expect(manager.getBootGeneration()).toBe(boot);
    }
    await dispatch(refs[15]!, "get");
    await manager.retireDOEntity(refs[15]!);
    const internals = manager as unknown as {
      dynamicIsolateCompactionFlight: Promise<void> | null;
    };
    await internals.dynamicIsolateCompactionFlight;

    expect(manager.getBootGeneration()).toBe(boot);
    expect(await dispatch(refs[0]!, "get")).toMatchObject({ count: 1, key: "bounded-0" });
  });

  it("clones facet storage to a new key (channel fork), independent, no restart", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch } = active;

    await manager.ensureDOClass("workers/counter", "CounterDO");
    const src = { source: "workers/counter", className: "CounterDO", objectKey: "orig" };
    const prepared = await manager.ensureDurableObjectEntity({
      source: src.source,
      className: src.className,
      key: src.objectKey,
      contextId: "source-context",
    });
    const reservation = cloneReservation(src, "fork", manager);
    await manager.restoreDurableObjectEntity({
      ...sourceOwner(reservation),
      source: { repoPath: src.source, effectiveVersion: prepared.effectiveVersion },
      activeAuthority: prepared.authority,
    });
    await dispatch(src, "incr");
    await dispatch(src, "incr");
    expect(await dispatch(src, "get")).toMatchObject({ count: 2 });

    const boot = manager.getBootGeneration();
    const cloned = await manager.cloneDO(src, "fork", {
      reservation,
      resolveSource: async () => sourceOwner(reservation),
    });
    expect(cloned.objectKey).toBe("fork");
    expect(manager.getBootGeneration()).toBe(boot); // clone never restarts

    // The fork starts with the parent's state…
    expect(await dispatch(cloned, "get")).toMatchObject({ count: 2, key: "fork" });
    // …and is independent: mutating the fork does not affect the original.
    await dispatch(cloned, "incr");
    expect(await dispatch(cloned, "get")).toMatchObject({ count: 3 });
    expect(await dispatch(src, "get")).toMatchObject({ count: 2 });

    // destroyDO removes the fork's facet storage.
    await manager.destroyDO(cloned);
  }, 30_000);

  it("refuses a snapshot whose source image differs from its reserved provenance", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");
    const src = { source: "workers/counter", className: "CounterDO", objectKey: "drift-source" };
    const prepared = await manager.ensureDurableObjectEntity({
      source: src.source,
      className: src.className,
      key: src.objectKey,
      contextId: "source-context",
    });
    const reservation = cloneReservation(src, "drift-child", manager);
    await manager.restoreDurableObjectEntity({
      ...sourceOwner(reservation),
      source: { repoPath: src.source, effectiveVersion: prepared.effectiveVersion },
      activeAuthority: prepared.authority,
    });
    await dispatch(src, "incr");
    reservation.cloneProvenance = {
      ...reservation.cloneProvenance!,
      sourceExecutionDigest: "f".repeat(64),
    };
    await expect(
      manager.cloneDO(src, "drift-child", {
        reservation,
        resolveSource: async () => sourceOwner(reservation),
      })
    ).rejects.toThrow(/changed its snapshot execution/);
    expect(await dispatch(src, "get")).toMatchObject({ count: 1 });
    await manager.destroyDO({ ...src, objectKey: "drift-child" });
  });

  it("online-clones a cooperatively paused source without draining its active relay", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch } = active;

    await manager.ensureDOClass("workers/counter", "CounterDO");
    const src = { source: "workers/counter", className: "CounterDO", objectKey: "self" };
    const prepared = await manager.ensureDurableObjectEntity({
      source: src.source,
      className: src.className,
      key: src.objectKey,
      contextId: "source-context",
    });
    const reservation = cloneReservation(src, "self-fork", manager);
    await manager.restoreDurableObjectEntity({
      ...sourceOwner(reservation),
      source: { repoPath: src.source, effectiveVersion: prepared.effectiveVersion },
      activeAuthority: prepared.authority,
    });
    await dispatch(src, "incr");
    await dispatch(src, "incr");

    const finishSourceCall = beginDurableObjectRelay(
      `do:${src.source}:${src.className}:${src.objectKey}`
    );
    let cloned: typeof src | null = null;
    try {
      cloned = await manager.cloneDO(src, "self-fork", {
        reservation,
        resolveSource: async () => sourceOwner(reservation),
        cooperativelyPaused: true,
      });
    } finally {
      finishSourceCall();
    }
    if (!cloned) throw new Error("cooperative clone did not return a target");

    expect(await dispatch(cloned, "get")).toMatchObject({ count: 2, key: "self-fork" });
    await dispatch(cloned, "incr");
    expect(await dispatch(cloned, "get")).toMatchObject({ count: 3 });
    expect(await dispatch(src, "get")).toMatchObject({ count: 2 });
    await manager.destroyDO(cloned);
  }, 30_000);

  it("backs up, resets, lists, and restores one exact facet storage target", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");
    const ref = { source: "workers/counter", className: "CounterDO", objectKey: "resettable" };
    await dispatch(ref, "incr");
    await dispatch(ref, "incr");

    const finishInFlight = beginDurableObjectRelay(
      `do:${ref.source}:${ref.className}:${ref.objectKey}`
    );
    let resetSettled = false;
    const resetPromise = manager
      .resetDOStorage(ref, "exercise disposable schema recovery")
      .then((result) => {
        resetSettled = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resetSettled).toBe(false);
    expect(() =>
      beginDurableObjectRelay(`do:${ref.source}:${ref.className}:${ref.objectKey}`)
    ).toThrow(/storage maintenance/u);
    finishInFlight();
    const reset = await resetPromise;
    expect(await dispatch(ref, "get")).toMatchObject({ count: 0 });
    expect(await manager.listDOStorageBackups(ref)).toEqual([
      expect.objectContaining({
        operationId: reset.operationId,
        intent: "exercise disposable schema recovery",
      }),
    ]);

    await manager.restoreDOStorageBackup(
      ref,
      reset.operationId,
      "restore the pre-reset representative rows"
    );
    expect(await dispatch(ref, "get")).toMatchObject({ count: 2 });
  }, 30_000);

  it("forwards a WebSocket upgrade through the facet host (hibernation)", async () => {
    active = await createHarness({ "workers/counter": doBuild("workers/counter", "ev-1") });
    const { manager, dispatch, admissionFetches } = active;
    await manager.ensureDOClass("workers/counter", "CounterDO");

    const ref = { source: "workers/counter", className: "CounterDO", objectKey: "ws-1" };
    const instructions = "WebSocket native instructions: λ 日本語 🧭\n".repeat(6000);
    expect(Buffer.byteLength(instructions)).toBeGreaterThanOrEqual(128 * 1024);
    const stateArgs = { instructions };
    const prepared = await manager.ensureDurableObjectEntity({
      ...ref,
      key: ref.objectKey,
      ref: "main",
      contextId: "ws-context",
      stateArgs,
    });
    await manager.restoreDurableObjectEntity({
      id: prepared.targetId,
      kind: "do",
      className: ref.className,
      key: ref.objectKey,
      source: { repoPath: ref.source, effectiveVersion: prepared.effectiveVersion },
      activeBuildKey: prepared.buildKey,
      activeExecutionDigest: prepared.executionDigest,
      activeAuthority: prepared.authority,
      stateArgs,
      contextId: "ws-context",
      createdAt: 1,
      status: "active",
      cleanupComplete: false,
    });
    expect(admissionFetches.get(ref.objectKey)).toBeUndefined();
    const port = manager.getPort()!;
    const { default: WebSocket } = await import("ws");
    const key = encodeUniversalKey(ref);

    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/_u/${encodeURIComponent(key)}`, {
        headers: {
          Authorization: "Bearer udo-gateway-token",
          "X-Vibestudio-Dispatch-Secret": manager.getDispatchSecret(),
          ...doExecutableHeaders(ref, (key) =>
            manager.getDoAdmission(key.source, key.className, key.objectKey)
          ),
        },
      });
      let received: string | null = null;
      const timer = setTimeout(() => reject(new Error("WS timeout")), 8_000);
      ws.on("open", () => ws.send("ping"));
      ws.on("message", (d: Buffer) => {
        received = d.toString();
        // Supply a protocol-valid status so the pre-auto-reply compatibility
        // path can echo it from webSocketClose and complete the handshake.
        ws.close(1000, "test complete");
      });
      ws.on("close", () => {
        clearTimeout(timer);
        if (received === null) {
          reject(new Error("WebSocket closed before the facet replied"));
          return;
        }
        resolve(received);
      });
      ws.on("error", (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    // The hibernation handler fired inside the facet and echoed.
    expect(reply).toBe("echo:ping:CounterDO");
    expect(admissionFetches.get(ref.objectKey)).toBe(1);
    const instance = (await dispatch(ref, "instance")) as { stateArgs: { instructions: string } };
    expect(instance.stateArgs.instructions.length).toBe(instructions.length);
    expect(sha256(instance.stateArgs.instructions)).toBe(sha256(instructions));
    expect(admissionFetches.get(ref.objectKey)).toBe(1);
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
    await manager.ensureDOClass("workers/wasm", "WasmDO");

    const res = await dispatch(
      { source: "workers/wasm", className: "WasmDO", objectKey: "w1" },
      "get"
    );
    expect(res).toEqual({ wasmLoaded: true, cls: "WasmDO" });
  }, 30_000);

  it("loads JavaScript chunks from a userland DO module map", async () => {
    const source = "workers/chunked-do";
    const primary = `import { DurableObject } from "cloudflare:workers";
export class ChunkedDO extends DurableObject {
  async fetch() {
    const { value } = await import("./chunks/lazy.js");
    return Response.json({ result: value });
  }
}
export default { fetch() { return new Response("chunked host"); } };`;
    const build = doBuild(source, "v1", primary, [
      {
        path: "chunks/lazy.js",
        role: "asset",
        contentType: "text/javascript; charset=utf-8",
        encoding: "utf8",
        content: 'export const value = "loaded lazily";',
      },
    ]);
    active = await createHarness({ [source]: build });
    const { manager, dispatch } = active;
    await manager.ensureDOClass(source, "ChunkedDO");
    await expect(
      dispatch({ source, className: "ChunkedDO", objectKey: "one" }, "fetch")
    ).resolves.toBe("loaded lazily");
  }, 30_000);

  it("registers a brand-new DO class with no restart", async () => {
    active = await createHarness({
      "workers/counter": doBuild("workers/counter", "ev-1"),
      "workers/other": doBuild("workers/other", "ev-1"),
    });
    const { manager, dispatch } = active;

    await manager.ensureDOClass("workers/counter", "CounterDO");
    const boot = manager.getBootGeneration();
    await dispatch({ source: "workers/counter", className: "CounterDO", objectKey: "a" }, "incr");

    // A genuinely new userland DO class (different source) — no restart.
    await manager.ensureDOClass("workers/other", "CounterDO");
    expect(manager.getBootGeneration()).toBe(boot);

    expect(
      await dispatch({ source: "workers/other", className: "CounterDO", objectKey: "a" }, "incr")
    ).toMatchObject({ count: 1, source: "workers/other" });
  }, 30_000);
});
