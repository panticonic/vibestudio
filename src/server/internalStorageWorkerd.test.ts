import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { serializeRpcFailure, type RpcFailure } from "@vibestudio/rpc";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TokenManager } from "@vibestudio/shared/tokenManager";
import { SingletonRegistry } from "@vibestudio/workspace/singletonRegistry";
import { DODispatch } from "./doDispatch.js";
import { INTERNAL_DO_SOURCE } from "./internalDOs/internalDoLoader.js";
import { celldTestBinary, nodeProxy } from "../../tests/helpers/celldNodeHarness.js";
import { postToDurableObject, type DORef } from "./workerdRpcRelay.js";
import {
  schemaProbeEnvironmentForFixture,
  useSchemaProbeFixtureCache,
} from "../../tests/fixtures/schemaProbeEnvironment.js";
useSchemaProbeFixtureCache();
import {
  RuntimeManager,
  type RuntimeManagerDeps,
  type WorkerdWorkspaceProvider,
} from "./runtimeManager.js";
import { LifecycleDriver } from "./services/lifecycleDriver.js";
import { prepareDurableWorkOwnerRelease } from "./services/durableWorkRelease.js";
import { AlarmDriver } from "./services/alarmDriver.js";
import { createRuntimeService, type RuntimeEntityHooks } from "./services/runtimeService.js";
import { TaskAuthorityRegistry } from "./services/taskAuthorityRegistry.js";
import { UnitSupervisor } from "./services/unitSupervisor.js";
import { createEntityRetirementCleanup } from "./services/entityRetirementCleanup.js";
import { cleanupRuntimeEntity } from "./runtimeEntityCleanup.js";
import { WorkspaceEntityStore } from "./workspaceEntityStore.js";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { createHostCaller } from "@vibestudio/shared/serviceDispatcher";
import { authoritySessionIdForCaller } from "./services/callerAuthoritySession.js";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  sealAndDrainDurableObjectRelays,
  releaseDurableObjectRelaySeal,
} from "./workerdRpcRelay.js";
import type {
  EntityActivationCommand,
  RuntimeEntityHandle,
} from "@vibestudio/shared/runtime/entitySpec";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  verifyExecutionArtifactRef,
  type ExecutionArtifactRefV1,
} from "@vibestudio/shared/execution/retention";
import { sha256 } from "@vibestudio/shared/execution/identity";
import { parseUnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import type { BuildResult, StoredBuildResult } from "./buildV2/buildStore.js";
import {
  collectWorkspaceRpcCatalog,
  type WorkspaceRpcMethodDoc,
} from "./buildV2/workspaceRpcCatalog.js";
import { workspaceRpcSchema, workspaceRpcSchemaMetadata } from "./buildV2/workspaceRpcSchemas.js";
import { createHostDoAuthorityAttester } from "./bootstrap/runtime.js";
import {
  cleanupStoredBuildFixtures,
  storedBuildFixture,
} from "../../tests/helpers/storedBuildFixture.js";

const EGRESS_SECRET = "internal-storage-egress-secret";
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
      workspaceId: "workspace:internal-workerd-test",
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

// Loader gateway servers started by harnesses; closed in afterEach. Userland
// DOs route through the UniversalDO facet host, which fetches `/_docode` from
// `getServerUrl`, so the harness must serve those loader endpoints.
const activeLoaderServers: Server[] = [];
const activeFixtureRoots: string[] = [];

async function createWorkerdHarness(
  overrides: Partial<RuntimeManagerDeps> & {
    getBuild?: (source: string, ref?: string) => Promise<BuildResult>;
    mainRpc?: (method: string, args: unknown[], target: string) => Promise<unknown>;
    bindWorkspaceProvider?: boolean;
  } = {}
) {
  const tokenManager = new TokenManager();
  const { getBuild, mainRpc, bindWorkspaceProvider = true, ...managerOverrides } = overrides;
  const builds = new Map<string, StoredBuildResult>();
  // Construct the manager first (getServerUrl reads the port lazily via the
  // holder) so the loader-server closure can reference a `const` manager.
  const portHolder = { value: 0 };
  const workspacePath = mkdtempSync(join(tmpdir(), "vibestudio-workerd-workspace-"));
  const statePath = mkdtempSync(join(tmpdir(), "vibestudio-workerd-state-"));
  activeFixtureRoots.push(workspacePath, statePath);
  const manager = new RuntimeManager({
    schemaProbeEnvironment: schemaProbeEnvironmentForFixture("internal-storage-test"),
    schemaProbeReleaseRoot: join(statePath, "installed-resources"),
    tokenManager,
    fsService: {
      closeHandlesForCaller: () => {},
    } as unknown as RuntimeManagerDeps["fsService"],
    getServerUrl: () => `http://127.0.0.1:${portHolder.value}`,
    workspaceId: "workspace:internal-workerd-test",
    getInternalDoEnv: () => ({}),
    workspacePath,
    statePath,
    // Internal DO outbound RPCs route through the same loopback harness. The
    // port is resolved only when a DO class is registered, after the server
    // below has bound and populated the holder.
    // The node sends all egress, product classes' RPC callbacks included, and
    // reaches the gateway, through the one proxy listener below.
    getSharedEgressPort: () => Promise.resolve(portHolder.value),
    registerEgressCaller: () => {},
    unregisterEgressCaller: () => {},
    egressSecret: EGRESS_SECRET,
    getWorkerdGatewayToken: () => "internal-test-workerd-gateway-token",
    ...managerOverrides,
  } satisfies RuntimeManagerDeps);
  const provider: WorkerdWorkspaceProvider = {
    bindRuntimeImage: async (source: string, ref?: string) => {
      if (!getBuild) throw new Error("workspace builds are not used by internal DO tests");
      const build = await getBuild(source, ref);
      if (!build.metadata.execution || !build.metadata.authority) {
        throw new Error(`fixture build ${build.buildKey} has no sealed execution identity`);
      }
      const artifact = build.metadata.execution;
      const storedBuild = storedBuildFixture(build);
      builds.set(storedBuild.buildKey, storedBuild);
      return {
        source,
        unitName: source,
        artifact,
        authority: build.metadata.authority,
      };
    },
    getBuildByKey: async (key: string) => builds.get(key) ?? null,
    readBuildArtifactContent: async (build, artifact) =>
      readFile(join(build.dir, artifact.path), "utf8"),
    getBuildByExecution: async (key: string, executionDigest: string) => {
      const build = builds.get(key) ?? null;
      return build?.metadata.execution?.executionDigest === executionDigest ? build : null;
    },
    getManifestRoutes: () => [],
    getManifestDoClasses: () => [],
    singletonRegistry: new SingletonRegistry([]),
  };
  if (bindWorkspaceProvider) manager.bindWorkspaceProvider(provider);
  const attestHostDoCall = createHostDoAuthorityAttester({
    manager,
    workspaceId: "workspace:internal-workerd-test",
    services: [],
    callerId: "internal-workerd-test",
    callerSubject: {
      userId: "internal-workerd-test-user",
      handle: "internal-workerd-test-user",
    },
  });

  const gatewayHandler = async (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ): Promise<void> => {
    const u = req.url ?? "";
    if (u === "/rpc" && req.method === "POST" && mainRpc) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        from: string;
        target: string;
        message: { requestId: string; method: string; args: unknown[] };
      };
      let result: unknown;
      let error: RpcFailure | undefined;
      try {
        result = await mainRpc(envelope.message.method, envelope.message.args, envelope.target);
      } catch (cause) {
        error = serializeRpcFailure(cause);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          from: envelope.target,
          target: envelope.from,
          delivery: { caller: { callerId: "main", callerKind: "server" } },
          provenance: [],
          message: {
            type: "response",
            requestId: envelope.message.requestId,
            ...(error === undefined ? { result } : { error }),
          },
        })
      );
      return;
    }
    if (u.startsWith("/_doadmission/")) {
      if (req.headers["x-vibestudio-loader-secret"] !== manager.getDoLoaderSecret()) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      const requested = new URL(u, "http://gateway");
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
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(admission));
      return;
    }
    if (u.startsWith("/_docode/")) {
      if (req.headers["x-vibestudio-loader-secret"] !== manager.getDoLoaderSecret()) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      const segs = (u.slice("/_docode/".length).split("?")[0] ?? "").split("/");
      const source = decodeURIComponent(segs[0] ?? "");
      const className = decodeURIComponent(segs[1] ?? "");
      const objectKey = new URL(u, "http://fixture").searchParams.get("objectKey") ?? undefined;

      void manager
        .getDoCode(
          source,
          className,
          new URL(u, "http://fixture").searchParams.get("version") ?? "",
          objectKey
        )
        .then((code) => {
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
  };
  // A product class's callback to `/rpc` arrives through the proxy under its
  // service identity; the runtime application's own programs arrive as host
  // programs. Both are served by the one gateway fixture.
  const proxy = nodeProxy({
    secret: EGRESS_SECRET,
    gateway: (req, res) => void gatewayHandler(req, res),
    other: ({ request }, res) => {
      const target = new URL(request.url ?? "", "http://gateway");
      request.url = `${target.pathname}${target.search}`;
      void gatewayHandler(request, res);
    },
  });
  const loaderServer = createServer(proxy.listener);
  portHolder.value = await new Promise<number>((r) =>
    loaderServer.listen(0, "127.0.0.1", () => {
      const a = loaderServer.address();
      r(typeof a === "object" && a ? a.port : 0);
    })
  );
  activeLoaderServers.push(loaderServer);

  const sealedEntities = new Map<
    string,
    Parameters<RuntimeManager["restoreDurableObjectEntity"]>[0]
  >();
  const attachDurableObject = async (ref: DORef): Promise<void> => {
    const targetId = `do:${ref.source}:${ref.className}:${ref.objectKey}`;
    let record = sealedEntities.get(targetId);
    if (!record) {
      const prepared = await manager.ensureDurableObjectEntity({
        source: ref.source,
        className: ref.className,
        key: ref.objectKey,
        contextId: `ctx:test:${sha256(targetId)}`,
      });
      record = {
        id: prepared.targetId,
        kind: "do",
        source: {
          repoPath: ref.source,
          effectiveVersion: prepared.effectiveVersion,
        },
        activeBuildKey: prepared.buildKey,
        activeExecutionDigest: prepared.executionDigest,
        activeAuthority: prepared.authority,
        contextId: `ctx:test:${sha256(targetId)}`,
        className: ref.className,
        key: ref.objectKey,
        createdAt: 1,
        status: "active",
        cleanupComplete: false,
      };
      sealedEntities.set(targetId, record);
    }
    await manager.restoreDurableObjectEntity(record);
  };

  const callDurableObject = async (
    ref: DORef,
    method: string,
    ...args: unknown[]
  ): Promise<unknown> => {
    await attachDurableObject(ref);
    const port = manager.getPort();
    if (!port) throw new Error("workerd port is not available");
    return postToDurableObject(ref, method, args, {
      workerdUrl: `http://127.0.0.1:${port}`,
      workerdGatewayToken: manager.getWorkerdGatewayToken(),
      workerdDispatchSecret: manager.getDispatchSecret(),
      resolveExecutableAdmission: (ref) =>
        manager.getDoAdmission(ref.source, ref.className, ref.objectKey),
      callerId: "internal-workerd-test",
      callerKind: "server",
      userId: "internal-workerd-test-user",
      authorization: await attestHostDoCall(ref, method, args),
    });
  };

  return { manager, tokenManager, callDurableObject, attachDurableObject };
}

function createDODispatch(
  manager: RuntimeManager,
  tokenManager: TokenManager,
  ensureUserlandDoReady: (ref: DORef) => Promise<void>
): DODispatch {
  const dispatch = new DODispatch(ensureUserlandDoReady);
  dispatch.setTokenManager(tokenManager);
  dispatch.setGetWorkerdGatewayToken(() => manager.getWorkerdGatewayToken());
  dispatch.setGetDispatchSecret(() => manager.getDispatchSecret());
  dispatch.setExecutableAdmissionResolver((ref) =>
    manager.getDoAdmission(ref.source, ref.className, ref.objectKey)
  );
  dispatch.setGetWorkerdUrl(() => {
    const port = manager.getPort();
    if (!port) throw new Error("workerd port is not available");
    return `http://127.0.0.1:${port}`;
  });
  dispatch.setAuthorityAttester(
    createHostDoAuthorityAttester({
      manager,
      workspaceId: "workspace:internal-workerd-test",
      services: [],
      callerId: "internal-workerd-test",
    })
  );
  // These transport integration tests do not instantiate RpcServer. Production
  // wires this callback to RpcServer.withAuthorityParent so nested RPC remains
  // authorized for exactly the awaited durable-object invocation.
  dispatch.setAuthorityParentRunner(async (_receiverRuntimeId, _authorization, invoke) => invoke());
  return dispatch;
}

async function bundleWorker(
  source: string,
  entryPoint: string,
  ev: string,
  unitRoot = dirname(entryPoint)
): Promise<BuildResult> {
  const packageJsonPath = join(unitRoot, "package.json");
  const manifest = existsSync(packageJsonPath)
    ? (
        JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          vibestudio?: {
            authority?: unknown;
            durable?: { classes?: Array<{ className: string; rpcSchema?: string }> };
          };
        }
      ).vibestudio
    : undefined;
  const authority =
    manifest?.authority === undefined
      ? { requests: [], provides: [], serviceRequests: [] }
      : parseUnitAuthorityManifest(manifest.authority);
  const rpcSchemas = Object.fromEntries(
    (manifest?.durable?.classes ?? [])
      .filter(
        (entry): entry is { className: string; rpcSchema: string } =>
          typeof entry.rpcSchema === "string"
      )
      .map((entry) => {
        const schema = workspaceRpcSchema(entry.rpcSchema);
        if (!schema) throw new Error(`Unknown workspace RPC schema ${entry.rpcSchema}`);
        return [entry.className, workspaceRpcSchemaMetadata(schema)];
      })
  );
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "esm",
    write: false,
    conditions: ["worker", "browser"],
    // Keep this direct fixture bundle aligned with the workerd worker builder:
    // bare fs/path are resolved by the sandbox runtime, while node:* remains
    // external for nodejs_compat.
    external: ["node:*", "fs", "path", "electron"],
    logLevel: "silent",
  });
  return buildResult(
    source,
    ev,
    result.outputFiles[0]!.text,
    await collectWorkspaceRpcCatalog(unitRoot, {
      provider: source,
      authority,
      rpcSchemas,
    })
  );
}

function buildResult(
  source: string,
  ev: string,
  bundle: string,
  workspaceRpcCatalog: WorkspaceRpcMethodDoc[] = []
): BuildResult {
  const execution = runtimeArtifact(source, ev);
  const buildKey = execution.buildKey;
  return {
    dir: `/tmp/vibestudio-${ev}-build`,
    buildKey,
    sourceStateHash: execution.sourceState.contentRoots[0]!.stateHash,
    metadata: {
      kind: "worker",
      name: source,
      buildKey,
      sourcePath: source,
      ev,
      sourceStateHash: execution.sourceState.contentRoots[0]!.stateHash,
      sourceState: execution.sourceState.state,
      sourcemap: false,
      authority: { requests: [], provides: [], serviceRequests: [] },
      workspaceRpcCatalog,
      execution,
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

describe.skipIf(!celldBinary)("internal storage DOs on celld", () => {
  let manager: RuntimeManager | null = null;

  beforeEach(() => {
    vi.stubEnv("VIBESTUDIO_CELLD_BIN", celldBinary!);
  });

  afterEach(async () => {
    if (manager) {
      await manager.shutdown();
      manager = null;
    }
    while (activeLoaderServers.length) {
      const server = activeLoaderServers.pop()!;
      await new Promise<void>((r) => server.close(() => r()));
    }
    while (activeFixtureRoots.length) rmSync(activeFixtureRoots.pop()!, { recursive: true });
    cleanupStoredBuildFixtures();
  });

  it("keeps internal DO storage across a node replacement and leaves its maintenance to the class", async () => {
    // BrowserVaultDO writes are host-capability attested, which requires the
    // installed product identity; synthesize one for this process the same way
    // a packaged build ships it.
    if (!process.env["VIBESTUDIO_APP_ROOT"]) {
      const appRoot = mkdtempSync(join(tmpdir(), "vibestudio-host-root-"));
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(appRoot, "dist"), { recursive: true });
      writeFileSync(
        join(appRoot, "dist", "host-build-fingerprint.json"),
        JSON.stringify({
          version: 1,
          mode: "development",
          fingerprint: "ab".repeat(32),
          inputCount: 1,
        })
      );
      process.env["VIBESTUDIO_APP_ROOT"] = appRoot;
    }
    const harness = await createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO" },
    ]);
    const doDispatch = createDODispatch(manager, harness.tokenManager, harness.attachDurableObject);
    const ref = {
      source: INTERNAL_DO_SOURCE,
      className: "BrowserVaultDO",
      objectKey: "durable-browser-environment",
    };

    await doDispatch.dispatch(ref, "addPassword", {
      url: "https://example.com/login",
      username: "ada",
      password: "keep me",
      actionUrl: "https://example.com/session",
      realm: "",
    });
    expect((await doDispatch.dispatch(ref, "listPasswordSummaries")) as unknown[]).toHaveLength(1);

    // Replacing the node (as crash recovery does) keeps the object's storage:
    // it lives in the bucket, not in the process.
    const generation = manager.getBootGeneration();
    await manager.recoverUnresponsiveSandbox("test: replace the node");
    expect(manager.getBootGeneration()).toBe(generation + 1);
    expect((await doDispatch.dispatch(ref, "listPasswordSummaries")) as unknown[]).toHaveLength(1);

    // Maintenance (reset, backup, restore) is the userland surface; a product
    // class owns its own storage and refuses it.
    await expect(manager.resetDOStorage(ref, "not for product objects")).rejects.toThrow(
      "not supported for internal DO source"
    );
  }, 60_000);

  // Manual empirical probe (~37s; opt-in via `.only` or removing `.skip`) behind
  // the unbounded eval design: real workerd does NOT cap a DO `fetch` handler
  // the way it caps a regular Worker (~30s). Held 35s here and returned cleanly,
  // proving workerd itself is not the short cap in this path. The relay's bare
  // `fetch` adds undici's ~300s `headersTimeout`, defeatable with a custom
  // dispatcher for held calls.
  it.skip("real workerd holds a DO fetch handler open past the ~30s regular-Worker wall limit", async () => {
    // Probe at 35s; a workerd-level cap would instead error around 30s. A
    // separate manual probe confirmed a HELD request runs 150s+ cleanly —
    // workerd does not cap long-held requests; only no-connection waitUntil is capped.
    const probeBuild = await bundleWorker(
      "workers/lifecycle-probe",
      "src/server/testFixtures/lifecycleProbeWorker.ts",
      "lifecycle-probe-sleep"
    );
    const harness = await createWorkerdHarness({
      getBuild: async (source: string) => {
        if (source === "workers/lifecycle-probe") return probeBuild;
        throw new Error(`unexpected build source ${source}`);
      },
    });
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: "workers/lifecycle-probe", className: "LifecycleProbeDO" },
    ]);
    const ref = {
      source: "workers/lifecycle-probe",
      className: "LifecycleProbeDO",
      objectKey: "sleep-probe",
    };

    // Sanity: a short hold returns its value through the full relay path.
    const shortStart = Date.now();
    const short = await harness.callDurableObject(ref, "sleepProbe", 2_000);
    expect(short).toEqual({ requestedMs: 2_000, ok: true });
    expect(Date.now() - shortStart).toBeGreaterThanOrEqual(1_800);

    // The real question: a hold LONGER than a regular Worker's ~30s wall limit.
    const longStart = Date.now();
    const long = await harness.callDurableObject(ref, "sleepProbe", 35_000);
    const elapsed = Date.now() - longStart;
    expect(long).toEqual({ requestedMs: 35_000, ok: true });
    expect(elapsed).toBeGreaterThanOrEqual(34_000);
  }, 90_000);

  it("measures whether a DO runs waitUntil work and I/O after its request returns", async () => {
    const probeBuild = await bundleWorker(
      "workers/lifecycle-probe",
      "src/server/testFixtures/lifecycleProbeWorker.ts",
      "lifecycle-probe-bg"
    );
    const harness = await createWorkerdHarness({
      getBuild: async (source: string) => {
        if (source === "workers/lifecycle-probe") return probeBuild;
        throw new Error(`unexpected build source ${source}`);
      },
      mainRpc: async () => [],
    });
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: "workers/lifecycle-probe", className: "LifecycleProbeDO" },
    ]);
    const ref = {
      source: "workers/lifecycle-probe",
      className: "LifecycleProbeDO",
      objectKey: "bg-probe",
    };

    const probeRet = await harness.callDurableObject(ref, "bgRunProbe");
    // Wait well past the 3s background timer, WITHOUT touching the DO, so the
    // background task only runs if the isolate keeps itself alive on its own.
    await new Promise((resolve) => setTimeout(resolve, 9000));
    const result = (await harness.callDurableObject(ref, "bgRunResult")) as Record<string, string>;

    const startedAt = Number(result["started_at"]);
    const ranAt = result["ran_at"] ? Number(result["ran_at"]) : null;
    const deltaMs = ranAt != null && !Number.isNaN(startedAt) ? ranAt - startedAt : null;
    console.log("BG-PROBE RESULT:", JSON.stringify({ probeRet, result, deltaMs }));
    expect(probeRet).toEqual({ hasWaitUntil: true });
    expect(deltaMs).toBeGreaterThanOrEqual(2_800);
    expect(deltaMs).toBeLessThan(6_000);
    expect(result["bg_io"]).toBe("ok");
  }, 40_000);

  it("admits ordinary, alarm, lifecycle, and a second held call during a held DO call", async () => {
    const probeBuild = await bundleWorker(
      "workers/lifecycle-probe",
      "src/server/testFixtures/lifecycleProbeWorker.ts",
      "lifecycle-probe-held-admission"
    );
    const harness = await createWorkerdHarness({
      getBuild: async (source: string) => {
        if (source === "workers/lifecycle-probe") return probeBuild;
        throw new Error(`unexpected build source ${source}`);
      },
    });
    manager = harness.manager;
    const doDispatch = createDODispatch(manager, harness.tokenManager, harness.attachDurableObject);
    await manager.registerAllDOClasses([
      { source: "workers/lifecycle-probe", className: "LifecycleProbeDO" },
    ]);
    const ref = {
      source: "workers/lifecycle-probe",
      className: "LifecycleProbeDO",
      objectKey: "held-admission-probe",
    };
    await harness.callDurableObject(ref, "currentBootGeneration");

    const first = doDispatch.dispatchHeld(ref, "heldSqlProbe", "first", 2_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await doDispatch.dispatchLifecycle(ref, "prepare", {
      epoch: "held-admission",
      phase: "quiesce",
      mode: "suspend",
      reason: "probe",
      deadlineMs: 0,
    });
    const admissionStartedAt = Date.now();
    const [ordinary, alarm, prepare, second] = await Promise.all([
      doDispatch.dispatch(ref, "currentBootGeneration"),
      doDispatch.dispatchAlarm(ref),
      doDispatch.dispatchLifecycle(ref, "prepare", {
        epoch: "held-admission",
        phase: "release",
        mode: "suspend",
        reason: "probe",
        deadlineMs: 1_000,
      }),
      doDispatch.dispatchHeld(ref, "heldSqlProbe", "second", 250),
    ]);
    const admissionMs = Date.now() - admissionStartedAt;

    expect(ordinary).toBe("1");
    expect(alarm).toEqual({ nextAlarm: null });
    expect(prepare).toEqual({ status: "ready" });
    expect(second).toEqual({ label: "second", ok: true });
    expect(admissionMs).toBeLessThan(1_000);
    await expect(first).resolves.toEqual({ label: "first", ok: true });
  }, 30_000);

  it.skip("PROBE: how long does ctx.waitUntil keep a DO alive in the background?", async () => {
    const probeBuild = await bundleWorker(
      "workers/lifecycle-probe",
      "src/server/testFixtures/lifecycleProbeWorker.ts",
      "lifecycle-probe-bgdur"
    );
    const harness = await createWorkerdHarness({
      getBuild: async (source: string) => {
        if (source === "workers/lifecycle-probe") return probeBuild;
        throw new Error(`unexpected build source ${source}`);
      },
    });
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: "workers/lifecycle-probe", className: "LifecycleProbeDO" },
    ]);
    const ref = {
      source: "workers/lifecycle-probe",
      className: "LifecycleProbeDO",
      objectKey: "bg-dur-probe",
    };

    // 150s background task. Don't touch the DO meanwhile.
    await harness.callDurableObject(ref, "bgRunProbe", 150_000);
    await new Promise((resolve) => setTimeout(resolve, 155_000));
    const result = (await harness.callDurableObject(ref, "bgRunResult")) as Record<string, string>;
    const startedAt = Number(result["started_at"]);
    const ranAt = result["ran_at"] ? Number(result["ran_at"]) : null;
    const deltaMs = ranAt != null && !Number.isNaN(startedAt) ? ranAt - startedAt : null;
    console.log("BG-DURATION RESULT:", JSON.stringify({ result, deltaMs }));
    expect(result["started_at"]).toBeDefined();
  }, 240_000);

  it("starts internal workerd before a workspace provider is attached", async () => {
    // Regression: the whole runtime failed to boot once a product class was registered
    // with a malformed binding. Other tests register only WorkspaceDO/BrowserVaultDO,
    // so they never exercised the other classes' registration.
    const harness = await createWorkerdHarness({ bindWorkspaceProvider: false });
    manager = harness.manager;
    // registerAllDOClasses writes the capnp config and (re)starts workerd; a
    // malformed config makes workerd exit before accepting HTTP and this rejects.
    await expect(
      manager.registerAllDOClasses([{ source: INTERNAL_DO_SOURCE, className: "WebhookStoreDO" }])
    ).resolves.not.toThrow();
    expect(manager.getBootGeneration()).toBeGreaterThanOrEqual(1);
  });

  it("round-trips entity activate / resolve / retire / gc through WorkspaceDO under workerd", async () => {
    const harness = await createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "WorkspaceStateDO" },
    ]);
    const ref = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceStateDO",
      objectKey: "workspace-test",
    };

    const activateInput = {
      kind: "panel",
      source: { repoPath: "panels/example", effectiveVersion: "v1" },
      contextId: "ctx-1",
      key: "entry-1",
      nativeOwner: null,
      durableWorkQueues: [],
    } satisfies EntityActivationCommand;
    const record = (await harness.callDurableObject(ref, "entityActivate", activateInput)) as {
      id: string;
      kind: string;
      status: string;
      authoritySessionId: string;
    };
    expect(record.kind).toBe("panel");
    expect(record.status).toBe("active");
    expect(record.authoritySessionId).toBeTypeOf("string");
    expect(await harness.callDurableObject(ref, "entityActivate", activateInput)).toEqual(record);

    const resolved = (await harness.callDurableObject(ref, "entityResolveActive", record.id)) as {
      id: string;
      status: string;
    };
    expect(resolved.id).toBe(record.id);
    expect(resolved.status).toBe("active");

    const retired = (await harness.callDurableObject(ref, "entityRetire", record.id)) as {
      id: string;
      status: string;
    };
    expect(retired.status).toBe("retired");
    await expect(harness.callDurableObject(ref, "entityActivate", activateInput)).rejects.toThrow(
      /retirement cleanup/
    );
    await harness.callDurableObject(
      ref,
      "entityCleanupComplete",
      record.id,
      record.authoritySessionId
    );
    const reattached = (await harness.callDurableObject(ref, "entityActivate", activateInput)) as {
      authoritySessionId: string;
    };
    expect(reattached.authoritySessionId).not.toBe(record.authoritySessionId);
    await harness.callDurableObject(ref, "entityRetire", record.id);
    await harness.callDurableObject(
      ref,
      "entityCleanupComplete",
      record.id,
      record.authoritySessionId
    );
    expect(await harness.callDurableObject(ref, "entityResolve", record.id)).toMatchObject({
      authoritySessionId: reattached.authoritySessionId,
      cleanupComplete: false,
    });
    await harness.callDurableObject(
      ref,
      "entityCleanupComplete",
      record.id,
      reattached.authoritySessionId
    );

    const deleted = (await harness.callDurableObject(ref, "entityGc", {
      all: true,
      graceMs: 0,
    })) as string[];
    expect(deleted).toEqual([record.id]);
    await expect(
      harness.callDurableObject(ref, "entityResolveActive", record.id)
    ).resolves.toBeNull();
  }, 30_000);

  it("joins native-style domain receipts through real workerd before retiring authority, egress and the facet", async () => {
    const probeRef = {
      source: "workers/retirement-probe",
      className: "RetirementProbeDO",
      objectKey: "owner",
    };
    const probeId = `do:${probeRef.source}:${probeRef.className}:${probeRef.objectKey}`;
    const build = await bundleWorker(
      probeRef.source,
      "src/server/testFixtures/retirementProbeWorker.ts",
      "retirement-probe"
    );
    const order: string[] = [];
    const egress = new Set<string>();
    let originEgressRetired = false;
    const codeEgressAlive = () =>
      [...egress].some((id) => id.startsWith(`do-code:${probeRef.source}:${probeRef.className}:`));
    let store!: WorkspaceEntityStore;
    let dispatch!: DODispatch;
    let domainEntered!: () => void;
    let domainFailed!: (error: unknown) => void;
    const entered = new Promise<void>((resolve, reject) => {
      domainEntered = resolve;
      domainFailed = reject;
    });
    let completeDomain!: () => void;
    const allowed = new Promise<void>((resolve) => {
      completeDomain = resolve;
    });
    const harness = await createWorkerdHarness({
      getBuild: async (source) => {
        if (source !== probeRef.source) throw new Error(`Unexpected retirement source ${source}`);
        return build;
      },
      registerEgressCaller: (id) => {
        egress.add(id);
      },
      unregisterEgressCaller: (id) => {
        egress.delete(id);
      },
      mainRpc: async (method) => {
        try {
          if (method !== "docs.listServices") throw new Error(`Unexpected domain method ${method}`);
          expect(await store.resolveRecord(probeId)).toMatchObject({ status: "active" });
          expect(codeEgressAlive()).toBe(true);
          expect(originEgressRetired).toBe(false);
          const current = store.cache.resolve(probeId)!;
          expect(
            authoritySessionIdForCaller(createVerifiedCaller(probeId, "do"), store.cache)
          ).toBe(current.authoritySessionId);
          order.push("domain-cancellation");
          domainEntered();
          await allowed;
          // A terminal receipt enters the sealed logical receiver while its
          // prepare call awaits domain cleanup. Relay sealing happens afterwards.
          await dispatch.dispatch(probeRef, "completeDomainReceipt");
          order.push("domain-receipt-joined");
          return [];
        } catch (error) {
          domainFailed(error);
          throw error;
        }
      },
    });
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "WorkspaceStateDO" },
      { source: probeRef.source, className: probeRef.className },
    ]);
    dispatch = createDODispatch(manager, harness.tokenManager, harness.attachDurableObject);
    store = new WorkspaceEntityStore({
      doDispatch: dispatch,
      workspaceId: "workspace-retirement",
      entityCache: new EntityCache(),
      resolveNativeOwner: () => null,
      resolveDurableWorkQueues: () => [],
      materializeExecution: async () => undefined,
    });
    const cleanup = createEntityRetirementCleanup({
      resolveRecord: (id) => store.resolveRecord(id),
      complete: async (id, lifetime) => {
        await store.cleanupComplete(id, lifetime);
        order.push("cleanup-complete");
      },
      cleanup: async (record) =>
        cleanupRuntimeEntity(record, {
          retireAuthorityOwner: async () => {
            order.push("authority-retired");
          },
          egressProxy: {
            dropCaller: async (id) => {
              expect(id).toBe(probeId);
              originEgressRetired = true;
              order.push("egress-withdrawn");
            },
          },
          approvalQueue: { cancelForCaller: () => {} },
          credentialSessionGrantStore: { dropForCaller: () => 0 },
          tokenManager: harness.tokenManager,
          releaseBlobRetentions: async () => {},
          getRuntimeManager: () => manager,
          getFsService: () => null,
          getWebhookIngress: () => null,
        }),
    });
    const runtime = createRuntimeService({
      entityStore: store,
      taskAuthorities: new TaskAuthorityRegistry(),
      testPolicyForContext: () => null,
      unitSupervisor: new UnitSupervisor(),
      contextBoundary: { contextExists: () => true, resolveContextOwnerLabel: () => undefined },
      contextFolders: {
        ensureContextFolder: async () => "/unused-retirement-context",
        removeContext: async () => {},
      },
      semanticContexts: {
        ensureContext: async () => {},
        dropContext: async () => {},
        forkContext: async () => {},
        resolveWorkingState: async () => ({ kind: "event", eventId: "event:retirement" }),
        listContexts: async () => [],
      },
      hooks: {
        initializeDurableClone: async () => {
          throw new Error("Retirement fixture does not clone");
        },
        prepare: (async ({ spec, key, contextId }) => {
          if (spec.kind !== "do" || spec.execution.surface !== "code")
            throw new Error("Retirement proof only creates its DO");
          const selected = await manager!.ensureDurableObjectEntity({
            source: spec.execution.source,
            className: spec.className,
            key,
            contextId,
          });
          return {
            surface: "code",
            target: { id: selected.targetId },
            effectiveVersion: selected.effectiveVersion,
            buildKey: selected.buildKey,
            executionDigest: selected.executionDigest,
            authority: selected.authority,
          };
        }) as RuntimeEntityHooks["prepare"],
        recoverExactExecution: async (record) => manager!.restoreDurableObjectEntity(record),
        restartDurableObjectIncarnation: async () => manager!.restartUserlandDOFacet(probeRef),
        releaseEntity: async (_record, input) => {
          const released = await dispatch.dispatchLifecycle(probeRef, "prepare", input);
          if (released.status === "ready" && input.phase === "release") {
            expect(await dispatch.dispatch(probeRef, "domainState")).toBe("released");
            order.push("logical-release-joined");
          }
          return released;
        },
        drainDurableWorkDeliveries: async () => {},
        prepareDurableWorkRelease: async () => {},
        sealAndDrainEntityRelays: async (id) => {
          order.push("relay-sealed");
          await sealAndDrainDurableObjectRelays(id, "retirement-proof");
        },
        releaseEntityRelaySeal: (id) => releaseDurableObjectRelaySeal(id, "retirement-proof"),
        onRetire: cleanup.retire,
      },
    });
    const spec = {
      kind: "do",
      execution: { surface: "code", source: probeRef.source },
      className: probeRef.className,
      key: probeRef.objectKey,
      contextId: "ctx-retirement",
    } as const;
    const created = (await runtime.definition.handler(
      { caller: createHostCaller("server") },
      "createEntity",
      [spec]
    )) as RuntimeEntityHandle;
    const original = await store.resolveRecord(created.id);
    const retiring = runtime.internal.retireEntity(created.id);
    let returned = false;
    const observed = retiring.then(() => {
      returned = true;
    });
    try {
      await entered;
      expect(returned).toBe(false);
      expect(await store.resolveRecord(created.id)).toMatchObject({
        status: "active",
        authoritySessionId: original!.authoritySessionId,
      });
      expect(codeEgressAlive()).toBe(true);
      expect(originEgressRetired).toBe(false);
      completeDomain();
      await observed;
      const record = await store.resolveRecord(created.id);
      expect(record).toMatchObject({
        status: "retired",
        cleanupComplete: true,
        authoritySessionId: original!.authoritySessionId,
      });
      expect(originEgressRetired).toBe(true);
      expect(codeEgressAlive()).toBe(true);
      expect(() =>
        authoritySessionIdForCaller(createVerifiedCaller(probeId, "do"), store.cache)
      ).toThrow("no active authority lifetime");
      expect(order.slice(0, 5)).toEqual([
        "domain-cancellation",
        "domain-receipt-joined",
        "logical-release-joined",
        "relay-sealed",
        "authority-retired",
      ]);
      expect(order.at(-1)).toBe("cleanup-complete");
      expect(order.indexOf("egress-withdrawn")).toBeGreaterThan(
        order.indexOf("domain-receipt-joined")
      );
      // Reattach through the actual runtime transition with a fresh authority
      // lifetime. The aborted facet's durable release receipt survives.
      await runtime.definition.handler({ caller: createHostCaller("server") }, "createEntity", [
        spec,
      ]);
      expect((await store.resolveRecord(created.id))?.authoritySessionId).not.toBe(
        original!.authoritySessionId
      );
      expect(await dispatch.dispatch(probeRef, "domainState")).toBe("released");
    } finally {
      completeDomain();
      await Promise.allSettled([observed]);
      await cleanup.quiesce();
    }
  }, 30_000);

  it("drives lifecycle prepare and resume through real workerd restart hooks", async () => {
    const probeBuild = await bundleWorker(
      "workers/lifecycle-probe",
      "src/server/testFixtures/lifecycleProbeWorker.ts",
      "lifecycle-probe-test"
    );
    const triggerBuild = buildResult(
      "workers/restart-trigger",
      "restart-trigger-test",
      `export default { fetch() { return new Response("trigger"); } };`
    );
    const harness = await createWorkerdHarness({
      getBuild: async (source: string) => {
        if (source === "workers/lifecycle-probe") return probeBuild;
        if (source === "workers/restart-trigger") return triggerBuild;
        throw new Error(`unexpected build source ${source}`);
      },
    });
    manager = harness.manager;
    const doDispatch = createDODispatch(manager, harness.tokenManager, harness.attachDurableObject);
    const lifecycleDriver = new LifecycleDriver({
      runtimeManager: manager,
      doDispatch,
      workspaceId: "workspace-lifecycle",
      concurrency: 2,
      drainDurableWorkDeliveries: async () => {},
      prepareDurableWorkRelease: async (owner, stage, signal) => {
        await prepareDurableWorkOwnerRelease(
          owner,
          doDispatch,
          (hint) => {
            expect(hint.queues).toEqual([]);
          },
          stage,
          signal
        );
      },
    });
    const workspaceRef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceStateDO",
      objectKey: "workspace-lifecycle",
    };
    const probeRef = {
      source: "workers/lifecycle-probe",
      className: "LifecycleProbeDO",
      objectKey: "probe-1",
    };

    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "WorkspaceStateDO" },
      { source: "workers/lifecycle-probe", className: "LifecycleProbeDO" },
    ]);
    lifecycleDriver.start();
    try {
      // A raw caller cannot drive lifecycle. `harness.callDurableObject` reaches
      // the DO via the converged envelope relay, where `__lifecycle/prepare` is
      // not an exposed method (the reserved server-gated path is only reachable
      // through the server's instance-token DODispatch channel) — so it is
      // rejected. Either rejection ("not exposed" / 403) proves the gate holds.
      await expect(
        harness.callDurableObject(probeRef, "__lifecycle/prepare", {
          epoch: "raw",
          phase: "release",
          mode: "suspend",
          reason: "raw",
          deadlineMs: 1_000,
        })
      ).rejects.toThrow(/no direct authority declaration|403/);

      await doDispatch.dispatch(workspaceRef, "lifecycleLeaseUpsert", {
        source: probeRef.source,
        className: probeRef.className,
        objectKey: probeRef.objectKey,
        detail: { test: "planned-restart" },
      });

      // A planned workerd restart drives the prepare/resume lifecycle hooks on
      // registered DOs. (Worker create no longer restarts — the worker host is
      // static — so trigger a real restart explicitly via the internal entry.)
      const previousGeneration = manager.getBootGeneration();
      await (manager as unknown as { restartWorkerd(): Promise<void> }).restartWorkerd();
      const currentGeneration = previousGeneration + 1;

      expect(manager.getBootGeneration()).toBe(currentGeneration);
      await expect(doDispatch.dispatch(probeRef, "currentBootGeneration")).resolves.toBe(
        String(currentGeneration)
      );
      await expect(doDispatch.dispatch(probeRef, "lifecycleEvents")).resolves.toMatchObject([
        ...["quiesce", "peer-obligations", "release"].map((phase) => ({
          kind: "prepare",
          input: expect.objectContaining({ reason: "planned", phase }),
          bootGeneration: String(previousGeneration),
        })),
        {
          kind: "resume",
          input: expect.objectContaining({
            reason: "planned",
            previousGeneration,
            currentGeneration,
          }),
          bootGeneration: String(currentGeneration),
        },
      ]);

      const leases = await doDispatch.dispatch(workspaceRef, "lifecycleListLeases");
      expect(leases).toEqual([
        expect.objectContaining({
          source: probeRef.source,
          className: probeRef.className,
          objectKey: probeRef.objectKey,
        }),
      ]);
    } finally {
      lifecycleDriver.stop();
    }
  }, 30_000);

  it("fires server-driven alarms on a real DO via the AlarmDriver", async () => {
    const probeBuild = await bundleWorker(
      "workers/lifecycle-probe",
      "src/server/testFixtures/lifecycleProbeWorker.ts",
      "alarm-probe-test"
    );
    const harness = await createWorkerdHarness({
      getBuild: async (source: string) => {
        if (source === "workers/lifecycle-probe") return probeBuild;
        throw new Error(`unexpected build source ${source}`);
      },
    });
    manager = harness.manager;
    const doDispatch = createDODispatch(manager, harness.tokenManager, harness.attachDurableObject);
    const alarmDriver = new AlarmDriver({ doDispatch, workspaceId: "workspace-alarm" });
    const workspaceRef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceStateDO",
      objectKey: "workspace-alarm",
    };
    const probeRef = {
      source: "workers/lifecycle-probe",
      className: "LifecycleProbeDO",
      objectKey: "alarm-probe-1",
    };

    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "WorkspaceStateDO" },
      { source: "workers/lifecycle-probe", className: "LifecycleProbeDO" },
    ]);

    try {
      await doDispatch.dispatch(workspaceRef, "entityActivate", {
        kind: "do",
        source: { repoPath: probeRef.source, effectiveVersion: probeBuild.metadata.ev },
        contextId: "ctx-alarm-probe",
        className: probeRef.className,
        key: probeRef.objectKey,
        nativeOwner: null,
        durableWorkQueues: [],
      } satisfies EntityActivationCommand);
      // Register an already-due alarm directly in WorkspaceDO, then start the
      // driver: it should drain the due alarm and fire `__alarm` → probe.alarm().
      await doDispatch.dispatch(workspaceRef, "alarmSet", {
        source: probeRef.source,
        className: probeRef.className,
        objectKey: probeRef.objectKey,
        wakeAt: Date.now() - 1,
      });
      alarmDriver.start();

      // Poll until the probe records the alarm fire (driver fires ~immediately).
      let events: Array<{ kind: string }> = [];
      for (let i = 0; i < 40; i++) {
        events = (await doDispatch.dispatch(probeRef, "lifecycleEvents")) as Array<{
          kind: string;
        }>;
        if (events.some((e) => e.kind === "alarm")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(events.some((e) => e.kind === "alarm")).toBe(true);

      // The alarm fired once and was drained — no longer pending.
      await expect(
        doDispatch.dispatch(workspaceRef, "alarmNextWakeAt", Date.now())
      ).resolves.toBeNull();
    } finally {
      alarmDriver.stop();
    }
  }, 30_000);

  it("returns affected counts for BrowserVaultDO cookie clears", async () => {
    const harness = await createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO", objectKey: "global" };
    await harness.callDurableObject(ref, "addCookiesBatch", {
      jobId: "cookie-clear-job",
      batchIndex: 0,
      cookies: [
        {
          name: "sid",
          value: "one",
          domain: ".example.com",
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          sourceScheme: "secure",
          sourcePort: 443,
        },
        {
          name: "sid",
          value: "two",
          domain: ".other.test",
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          sourceScheme: "secure",
          sourcePort: 443,
        },
      ],
    });

    await expect(
      harness.callDurableObject(ref, "clearCookiesForOrigin", "https://example.com")
    ).resolves.toBe(1);
    await expect(harness.callDurableObject(ref, "clearAllCookies")).resolves.toBe(1);
  }, 30_000);

  it("round-trips BrowserVaultDO encrypted passwords in real workerd storage", async () => {
    const harness = await createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO", objectKey: "global" };
    const id = await harness.callDurableObject(ref, "addPassword", {
      url: "https://example.com/login",
      username: "ada",
      password: "correct horse battery staple",
      actionUrl: "https://example.com/session",
      realm: "",
    });

    expect(typeof id).toBe("number");
    await expect(harness.callDurableObject(ref, "listPasswordSummaries")).resolves.toEqual([
      expect.not.objectContaining({ password: expect.anything() }),
    ]);
    await expect(
      harness.callDurableObject(ref, "getPasswordForSite", "https://example.com/login")
    ).resolves.toMatchObject([
      {
        origin_url: "https://example.com",
        username: "ada",
        password: "correct horse battery staple",
        action_url: "https://example.com/session",
      },
    ]);

    await harness.callDurableObject(ref, "updatePassword", id, { password: "updated secret" });
    await expect(
      harness.callDurableObject(ref, "getPasswordForSite", "https://example.com")
    ).resolves.toMatchObject([{ id, username: "ada", password: "updated secret" }]);
  }, 30_000);

  it("supports BrowserVaultDO autofill password lookup semantics in real workerd storage", async () => {
    const harness = await createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO", objectKey: "global" };
    const id = (await harness.callDurableObject(ref, "addPassword", {
      url: "https://example.com/login",
      username: "ada",
      password: "first secret",
      actionUrl: "https://example.com/session",
      realm: "",
      timesUsed: 0,
    })) as number;

    await expect(
      harness.callDurableObject(ref, "getPasswordForSite", "https://example.com")
    ).resolves.toMatchObject([
      {
        id,
        origin_url: "https://example.com",
        username: "ada",
        password: "first secret",
      },
    ]);

    await expect(
      harness.callDurableObject(ref, "isNeverSave", "https://never.example")
    ).resolves.toBe(false);
    await harness.callDurableObject(ref, "addNeverSave", "https://never.example");
    await expect(
      harness.callDurableObject(ref, "isNeverSave", "https://never.example")
    ).resolves.toBe(true);

    await harness.callDurableObject(ref, "updateLastUsed", id);
    await expect(harness.callDurableObject(ref, "listPasswordSummaries")).resolves.toMatchObject([
      { id, times_used: 1 },
    ]);
  }, 30_000);

  it("upserts duplicate BrowserVaultDO password batch imports in real workerd storage", async () => {
    const harness = await createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserVaultDO", objectKey: "global" };
    const password = {
      url: "https://example.com/login",
      username: "ada",
      password: "first secret",
      actionUrl: "https://example.com/session",
      realm: "",
      timesUsed: 1,
    };
    await expect(
      harness.callDurableObject(ref, "addPasswordsBatch", [password], {
        sourceId: "chrome:test-source",
      })
    ).resolves.toBe(1);
    await expect(
      harness.callDurableObject(
        ref,
        "addPasswordsBatch",
        [{ ...password, password: "second secret", timesUsed: 7 }],
        { sourceId: "chrome:test-source" }
      )
    ).resolves.toBe(1);
    await expect(
      harness.callDurableObject(ref, "getPasswordForSite", "https://example.com")
    ).resolves.toMatchObject([
      {
        origin_url: "https://example.com",
        username: "ada",
        password: "second secret",
        times_used: 7,
      },
    ]);
  }, 30_000);
});
